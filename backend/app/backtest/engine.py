"""Backtest que reutiliza EXATAMENTE o mesmo motor, estratégia, risco e simulador
usados ao vivo (sem lógica paralela que possa divergir).

Premissas (conservadoras e documentadas):
- Sinal avaliado no fechamento do candle de 1m; execução no tick seguinte
  (abertura do próximo candle) pagando o ASK + slippage.
- Dentro de cada candle de 1m o preço percorre ABERTURA -> MÍNIMA -> MÁXIMA ->
  FECHAMENTO. Para compras isso é pessimista: se o stop e o alvo foram tocados
  no mesmo minuto, considera-se que o stop veio primeiro.
- Spread fixo configurável (os arquivos de klines não trazem o livro de ofertas).
- Taxas e filtros iguais aos da simulação ao vivo.
"""
from __future__ import annotations

import time
from dataclasses import dataclass, field
from decimal import Decimal
from typing import Any

from ..analysis.resample import IncrementalAggregator
from ..binance.filters import SymbolFilters
from ..binance.market_data import MarketData
from ..config import Settings
from ..db import Repository
from ..domain import TIMEFRAMES, Book, Candle, D
from ..engine import stats
from ..engine.bot import TradingEngine
from ..risk.settings import RiskSettings

MIN_WARMUP = 12_700  # ~211 horas de 1m: necessário para a EMA200 do gráfico de 1h


class ReplayMarket(MarketData):
    source_name = "historical"

    def __init__(self, series: dict[str, list[Candle]], filters: dict[str, SymbolFilters], quote_asset: str,
                 brl_rate: float | None, spread_pct: float = 0.02, synthetic: bool = False):
        super().__init__(tuple(series), quote_asset, "USDTBRL" if quote_asset != "BRL" else None)
        self.is_synthetic = synthetic
        self.series = series
        self.filters.update(filters)
        self.brl_rate = brl_rate
        self.half = spread_pct / 200
        self.aggs = {s: {tf: IncrementalAggregator(tf) for tf in TIMEFRAMES} for s in series}
        self.now = 0.0

    def push_closed(self, i: int) -> None:
        for s, ser in self.series.items():
            c = ser[i]
            for tf in TIMEFRAMES:
                self.aggs[s][tf].add(c)
                self.store._data[(s, tf)] = self.aggs[s][tf].series

    def set_prices(self, i: int, which: str, now: float) -> None:
        self.now = now
        for s, ser in self.series.items():
            px = getattr(ser[i], which)
            self.books[s] = Book(bid=px * (1 - self.half), ask=px * (1 + self.half), ts=now)
        if self.brl_rate_symbol and self.brl_rate:
            self.books[self.brl_rate_symbol] = Book(bid=self.brl_rate, ask=self.brl_rate, ts=now)

    async def start(self) -> None:  # pragma: no cover
        pass

    async def stop(self) -> None:  # pragma: no cover
        pass


@dataclass
class BacktestResult:
    metrics: dict[str, Any]
    significance: dict[str, Any]
    trades: list[dict[str, Any]]
    equity_curve: list[tuple[float, float]]
    exit_reasons: dict[str, int]
    assumptions: dict[str, Any] = field(default_factory=dict)
    signals: int = 0
    rejected_capital: int = 0
    rejected_risk: int = 0


def align(series: dict[str, list[Candle]]) -> dict[str, list[Candle]]:
    common = None
    for ser in series.values():
        ts = {c.open_time for c in ser}
        common = ts if common is None else common & ts
    assert common is not None
    return {s: [c for c in ser if c.open_time in common] for s, ser in series.items()}


def run_backtest(series: dict[str, list[Candle]], filters: dict[str, SymbolFilters], *,
                 initial_brl: Decimal = Decimal("30"), brl_rate: float | None, quote_asset: str = "USDT",
                 risk: RiskSettings | None = None, spread_pct: float = 0.02, warmup: int = MIN_WARMUP,
                 synthetic: bool = False, progress: bool = False, strategy: Any = None) -> BacktestResult:
    if quote_asset != "BRL" and not brl_rate:
        raise ValueError("Informe a cotação real USDT/BRL do início do período (brl_rate)")
    import logging
    logging.getLogger("engine").setLevel(logging.ERROR)  # avisos ficam no relatório, não no terminal
    series = align(series)
    n = len(next(iter(series.values())))
    if n <= warmup + 10:
        raise ValueError(f"Histórico insuficiente: {n} candles de 1m (mínimo {warmup + 10})")
    market = ReplayMarket(series, filters, quote_asset, brl_rate, spread_pct, synthetic)
    repo = Repository(":memory:")
    if risk:
        repo.kv_set("risk_settings", risk.to_dict())
    settings = Settings(app_env="test", symbols=tuple(series), quote_asset=quote_asset,
                        initial_capital_brl=D(initial_brl), database_path=":memory:",
                        market_data_source="synthetic" if synthetic else "binance")
    for i in range(warmup):
        market.push_closed(i)
    first = next(iter(series.values()))
    engine = TradingEngine(settings, repo, market, clock=lambda: market.now, persist_decisions=False,
                           **({"strategy": strategy} if strategy is not None else {}))
    engine.fast_eval = True
    t0_open = first[warmup].open_time / 1000
    engine.start(t0_open)
    equity: list[tuple[float, float]] = []
    signals = rej_cap = rej_risk = 0
    started = time.time()
    for i in range(warmup, n):
        t = first[i].open_time / 1000
        for which, off in (("open", 1), ("low", 20), ("high", 40), ("close", 59)):
            market.set_prices(i, which, t + off)
            engine.step(t + off)
            if off == 1:
                for d in engine.brain.latest.values():
                    if d["ts"] == t + off and d["signal"] == "COMPRAR":
                        signals += 1
                        rej_cap += d["decision"] == "RECUSADA (CAPITAL)"
                        rej_risk += d["decision"] == "BLOQUEADA PELO RISCO"
        market.push_closed(i)
        if i % 15 == 0:
            equity.append((t, float(engine.equity()[0])))
        if progress and i % 10_000 == 0:
            print(f"  candle {i}/{n} ({time.time() - started:.0f}s)")
    equity.append((first[-1].close_time / 1000, float(engine.equity()[0])))

    trades = repo.closed_positions(limit=1_000_000)
    trades.reverse()
    summary = stats.summarize(trades)
    peak, mdd = 0.0, 0.0
    for _, e in equity:
        peak = max(peak, e)
        if peak > 0:
            mdd = max(mdd, (peak - e) / peak * 100)
    initial = getattr(engine.broker, "meta", {}).get("initial_quote")
    start_eq = float(initial) if initial else (equity[0][1] if equity else 0.0)
    end_eq = equity[-1][1] if equity else 0.0
    rs = [t.r_multiple for t in trades if t.r_multiple is not None]
    reasons: dict[str, int] = {}
    for t in trades:
        reasons[t.exit_reason or "?"] = reasons.get(t.exit_reason or "?", 0) + 1
    days = (first[-1].open_time - first[warmup].open_time) / 86_400_000
    metrics = {
        **summary,
        "days": round(days, 2),
        "start_equity": start_eq,
        "end_equity": end_eq,
        "return_pct": ((end_eq / start_eq - 1) * 100) if start_eq else None,
        "max_drawdown_pct": mdd,
        "open_positions_at_end": len(engine.positions),
        "trades_per_day": (summary["trades"] / days) if days > 0 else None,
    }
    return BacktestResult(
        metrics=metrics, significance=stats.significance(rs), exit_reasons=reasons,
        trades=[t.to_dict() for t in trades], equity_curve=equity, signals=signals,
        rejected_capital=rej_cap, rejected_risk=rej_risk,
        assumptions={
            "spread_pct": spread_pct, "fee_pct": engine.risk_settings.fee_rate_pct,
            "slippage_pct": engine.risk_settings.slippage_pct, "intrabar_path": "abertura→mínima→máxima→fechamento",
            "execution": "sinal no fechamento do 1m, execução na abertura seguinte",
            "brl_rate": brl_rate, "initial_brl": str(initial_brl), "synthetic_data": synthetic,
        },
    )


def report_markdown(res: BacktestResult, title: str) -> str:
    m, s = res.metrics, res.significance

    def f(v: Any, nd: int = 2, suf: str = "") -> str:
        return "—" if v is None else f"{v:.{nd}f}{suf}"

    lines = [
        f"# {title}",
        "",
        "> **Dados sintéticos — apenas validação técnica, não é desempenho de mercado.**" if res.assumptions.get("synthetic_data") else
        "> Dados históricos reais da Binance (data.binance.vision). Desempenho passado não garante resultado futuro.",
        "",
        "## Resultado",
        f"- Período: {m['days']} dias",
        f"- Patrimônio: {f(m['start_equity'], 4)} → {f(m['end_equity'], 4)} ({f(m['return_pct'], 2, '%')})",
        f"- Operações: {m['trades']} (vencedoras {m['wins']}, perdedoras {m['losses']}, taxa de acerto {f(m['win_rate'], 1, '%')})",
        f"- Resultado líquido: {f(m['net_pnl'], 4)} | taxas pagas: {f(m['fees'], 4)}",
        f"- Profit factor: {f(m['profit_factor'])} | média por operação: {f(m['avg_r'])}R",
        f"- Drawdown máximo: {f(m['max_drawdown_pct'], 2, '%')}",
        f"- Sinais de compra: {res.signals} (recusados por capital: {res.rejected_capital}; bloqueados pelo risco: {res.rejected_risk})",
        f"- Saídas: {', '.join(f'{k}: {v}' for k, v in res.exit_reasons.items()) or 'nenhuma'}",
        f"- Posições ainda abertas no fim: {m['open_positions_at_end']}",
        "",
        "## Evidência estatística",
        f"- Operações na amostra: {s['n']}",
        f"- Média (R): {f(s.get('mean'), 3)} | estatística t: {f(s.get('t_stat'))}",
        f"- Intervalo de confiança 95%: {('[' + f(s['ci95'][0], 3) + ', ' + f(s['ci95'][1], 3) + ']') if s.get('ci95') else '—'}",
        f"- **Conclusão: {s['verdict']}**",
        "",
        "## Premissas",
    ] + [f"- {k}: {v}" for k, v in res.assumptions.items()]
    return "\n".join(lines) + "\n"
