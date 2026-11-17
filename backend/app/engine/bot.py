"""Motor autônomo do robô.

Ciclo (a cada 1 segundo):
1. Virada de dia -> reinicia contadores diários de risco.
2. Garante a conta simulada (R$30 convertidos pela cotação REAL USDT/BRL).
3. Para cada ativo: protege posições abertas (stop, alvo, break-even,
   stop móvel, tempo máximo) e, a cada candle de 1m FECHADO, roda a análise.
4. Uma entrada só acontece se: estratégia = COMPRAR, gestor de risco não
   bloqueou e o dimensionamento de capital é válido.

O motor é independente da IA: nenhuma chamada ao Claude é necessária para operar.
"""
from __future__ import annotations

import asyncio
import logging
import time
from decimal import Decimal
from typing import Any, Callable

from ..analysis.strategy import STRATEGY_NAME, STRATEGY_VERSION, Analysis, Strategy
from ..config import Settings
from ..db import Repository
from ..binance.market_data import MarketData
from ..domain import TIMEFRAMES, BotStatus, Book, D, Mode, Position
from ..execution.base import Broker, OrderRejected
from ..execution.factory import create_broker
from ..execution.paper import PaperBroker
from ..risk import settings as risk_cfg
from ..risk.capital import brl_to_quote, size_position
from ..risk.manager import RiskManager, RiskState
from . import stats
from .brain import Brain

log = logging.getLogger("engine")

MODE_LABEL = {
    "SIMULACAO": "SIMULAÇÃO (paper trading — sem dinheiro real)",
    "TESTNET": "TESTNET (ambiente de testes da Binance)",
    "REAL": "REAL (dinheiro verdadeiro)",
}


class TradingEngine:
    def __init__(
        self,
        settings: Settings,
        repo: Repository,
        market: MarketData,
        broker: Broker | None = None,
        strategy: Strategy | None = None,
        clock: Callable[[], float] = time.time,
        persist_decisions: bool = True,
    ):
        self.settings = settings
        self.repo = repo
        self.market = market
        self.clock = clock
        self.persist_decisions = persist_decisions
        self.fast_eval = False  # backtest: interrompe a análise no primeiro filtro reprovado
        self.tz = stats.get_tz(settings.timezone)
        try:
            self.risk_settings = risk_cfg.validate(repo.kv_get("risk_settings", {}) or {})
        except risk_cfg.RiskSettingsError:
            self.risk_settings = risk_cfg.RiskSettings()
        self.risk = RiskManager(self.risk_settings, RiskState.from_dict(repo.kv_get("risk_state")))
        self.broker = broker or create_broker(settings, repo, self.risk_settings)
        self.mode = self.broker.mode
        self.strategy = strategy or Strategy()
        self.brain = Brain()
        self.quote = settings.quote_asset
        self.positions: dict[str, Position] = {p.symbol: p for p in repo.open_positions(self.mode)}
        self.last_eval: dict[str, int] = {}
        self.in_flight: set[str] = set()
        self.last_analysis: dict[str, Analysis] = {}
        self.last_equity_ts = 0.0
        self._last_warn: dict[str, float] = {}
        self._risk_json = ""
        self.started_at = clock()
        self.step_count = 0
        self.last_step_ts = 0.0
        self.last_error: str | None = None

        saved = repo.kv_get("bot_state") or {}
        status = BotStatus(saved.get("status", BotStatus.PARADO.value))
        self.status_reason = saved.get("reason", "")
        if status == BotStatus.RODANDO and not settings.auto_resume:
            status, self.status_reason = BotStatus.PARADO, "Reinício: retomada automática desativada"
        self.status = status
        now = clock()
        msg = (f"Servidor iniciado em modo {self.mode}. Estado restaurado: {self.status.value}. "
               f"{len(self.positions)} posição(ões) aberta(s) restaurada(s) do banco.")
        repo.log("INFO", "sistema", msg, ts=now)
        self.brain.think(now, "info", msg)
        if market.is_synthetic:
            self.brain.think(now, "alerta", "ATENÇÃO: fonte de dados SINTÉTICA (somente teste). Nada aqui é mercado real.")

    # ================================================================ util
    def _log(self, level: str, category: str, message: str, data: dict[str, Any] | None = None,
             now: float | None = None) -> None:
        self.repo.log(level, category, message, data, ts=now)
        getattr(log, "warning" if level in {"AVISO", "CRITICO"} else "info")(message)

    def _throttled(self, key: str, now: float, every: float = 60) -> bool:
        if now - self._last_warn.get(key, 0) >= every:
            self._last_warn[key] = now
            return True
        return False

    def _persist_state(self) -> None:
        self.repo.kv_set("bot_state", {"status": self.status.value, "reason": self.status_reason})

    def _persist_risk(self) -> None:
        payload = self.risk.state.to_dict()
        import json
        js = json.dumps(payload, sort_keys=True)
        if js != self._risk_json:
            self.repo.kv_set("risk_state", payload)
            self._risk_json = js

    # ========================================================== conta/saldo
    def account_ready(self) -> bool:
        return not isinstance(self.broker, PaperBroker) or self.broker.initialized

    def ensure_account(self, now: float) -> bool:
        if self.account_ready():
            return True
        assert isinstance(self.broker, PaperBroker)
        brl = self.settings.initial_capital_brl
        if self.quote == "BRL":
            amount, rate = brl, None
        else:
            book = self.market.brl_book()
            if not book or now - book.ts > self.risk_settings.stale_data_seconds:
                self.brain.activity = (f"Aguardando cotação REAL de {self.settings.brl_rate_symbol} para converter "
                                       f"R${brl} em {self.quote} (nenhum valor é inventado)")
                return False
            amount, rate = brl_to_quote(brl, book.ask, self.risk_settings.fee_rate), book.ask
        amount = amount.quantize(Decimal("0.00000001"))
        meta = {"initial_brl": str(brl), "initial_quote": str(amount), "brl_rate": rate, "ts": now,
                "conversion": f"R${brl} / {rate} ({self.settings.brl_rate_symbol} ask) - taxa {self.risk_settings.fee_rate_pct}%"
                if rate else "moeda de cotação já é BRL"}
        self.broker.initialize(self.quote, amount, meta)
        eq = self.equity()[0]
        self.risk.new_day(stats.day_key(now, self.tz), eq)
        msg = (f"Conta simulada criada: R${brl} -> {amount:.4f} {self.quote}"
               + (f" (cotação real {self.settings.brl_rate_symbol} {rate})" if rate else ""))
        self._log("INFO", "conta", msg, meta, now)
        self.brain.think(now, "info", msg)
        return True

    def reset_paper_account(self, now: float) -> None:
        if not isinstance(self.broker, PaperBroker):
            raise RuntimeError("Reset permitido apenas na simulação")
        if self.positions:
            raise RuntimeError("Feche as posições abertas antes de zerar a conta simulada")
        self.broker.reset()
        self.risk.state = RiskState()
        self._log("AVISO", "conta", "Conta simulada zerada pelo proprietário (será recriada com R$30)", now=now)

    def price_of(self, asset: str) -> Decimal | None:
        sym = f"{asset}{self.quote}"
        book = self.market.get_book(sym)
        if book:
            return D(book.bid)
        pos = self.positions.get(sym)
        return pos.entry_price if pos else None

    def equity(self) -> tuple[Decimal, Decimal, Decimal]:
        """(patrimônio, saldo livre na moeda de cotação, exposição em ativos) — marcado no BID."""
        bal = self.broker.balances()
        free = bal.get(self.quote, D(0))
        exposure = D(0)
        for asset, qty in bal.items():
            if asset == self.quote or qty <= 0:
                continue
            px = self.price_of(asset)
            if px is not None:
                exposure += qty * px
        return free + exposure, free, exposure

    def to_brl(self, amount: Decimal) -> Decimal | None:
        if self.quote == "BRL":
            return amount
        book = self.market.brl_book()
        return amount * D(book.bid) if book else None

    # ============================================================ controles
    def start(self, now: float | None = None) -> None:
        now = now or self.clock()
        prev = self.status
        self.status, self.status_reason = BotStatus.RODANDO, "Iniciado pelo proprietário"
        self._persist_state()
        self._log("INFO", "controle", f"Robô INICIADO (antes: {prev.value})", now=now)
        self.brain.think(now, "info", "Robô iniciado: operação autônoma liberada dentro dos limites de risco.")

    def pause(self, now: float | None = None, reason: str = "Pausado pelo proprietário") -> None:
        now = now or self.clock()
        if self.status == BotStatus.EMERGENCIA:
            return
        self.status, self.status_reason = BotStatus.PARADO, reason
        self._persist_state()
        self._log("INFO", "controle", f"Robô PAUSADO: {reason}", now=now)
        self.brain.think(now, "info", "Robô pausado: sem novas entradas. Stops das posições abertas continuam ativos.")

    def emergency_stop(self, now: float | None = None, reason: str = "Botão de emergência") -> dict[str, Any]:
        now = now or self.clock()
        self.status, self.status_reason = BotStatus.EMERGENCIA, reason
        self._persist_state()
        self._log("CRITICO", "controle", f"EMERGÊNCIA acionada: {reason}", now=now)
        closed, failed = [], []
        for pos in list(self.positions.values()):
            book = self.market.get_book(pos.symbol)
            if book and self._close(pos, book, now, "EMERGENCIA", reason):
                closed.append(pos.symbol)
            else:
                failed.append(pos.symbol)
        self.brain.think(now, "alerta", f"EMERGÊNCIA: robô travado. Posições encerradas: {closed or 'nenhuma'}"
                         + (f"; FALHA ao encerrar: {failed}" if failed else ""))
        return {"closed": closed, "failed": failed}

    def update_risk_settings(self, data: dict[str, Any], now: float | None = None) -> risk_cfg.RiskSettings:
        """Somente o proprietário autenticado chega aqui (a IA não tem acesso)."""
        now = now or self.clock()
        new = risk_cfg.validate(data, self.risk_settings)
        self.risk_settings = new
        self.risk.settings = new
        if isinstance(self.broker, PaperBroker):
            self.broker.update_costs(new.fee_rate, new.slippage_pct)
        self.repo.kv_set("risk_settings", new.to_dict())
        self._log("AVISO", "risco", "Configurações de risco alteradas pelo proprietário", {"novas": data}, now)
        return new

    def effective_status(self, now: float) -> tuple[str, str]:
        if self.status != BotStatus.RODANDO:
            return self.status.value, self.status_reason
        if self.risk.state.daily_locked:
            return BotStatus.PAUSADO.value, self.risk.state.daily_lock_reason
        if now < self.risk.state.pause_until:
            return BotStatus.PAUSADO.value, self.risk.state.pause_reason
        if self.market.fatal_error:
            return BotStatus.PAUSADO.value, self.market.fatal_error
        return self.status.value, self.status_reason

    # ================================================================ ciclo
    def data_fresh(self, symbol: str, now: float) -> tuple[bool, str]:
        if self.market.fatal_error:
            return False, self.market.fatal_error
        book = self.market.get_book(symbol)
        if not book:
            return False, f"Sem cotação de {symbol} ainda"
        age = now - book.ts
        limit = self.risk_settings.stale_data_seconds
        if age > limit:
            return False, f"Cotação de {symbol} desatualizada há {age:.0f}s (limite {limit}s)"
        c1 = self.market.get_candles(symbol, "1m")
        if not c1 or now * 1000 - c1[-1].open_time > 180_000:
            return False, f"Candles de 1m de {symbol} atrasados (possível falha de conexão)"
        if not self.market.get_filters(symbol):
            return False, f"Filtros de negociação de {symbol} ainda não carregados"
        return True, ""

    def step(self, now: float | None = None) -> None:
        now = now if now is not None else self.clock()
        self.step_count += 1
        self.last_step_ts = now
        self._rollover_day(now)
        if not self.ensure_account(now):
            return
        eq = self.equity()[0]
        if self.risk.check_daily_loss(eq):
            self._log("AVISO", "risco", self.risk.state.daily_lock_reason, now=now)
            self.brain.think(now, "risco", self.risk.state.daily_lock_reason)
        for symbol in self.settings.symbols:
            self._step_symbol(symbol, now)
        if now - self.last_equity_ts >= 300:
            self.last_equity_ts = now
            eq = self.equity()[0]
            self.repo.insert_equity(now, eq, self.to_brl(eq))
        self._persist_risk()
        st, reason = self.effective_status(now)
        if st == "RODANDO":
            self.brain.activity = (f"Monitorando {len(self.settings.symbols)} ativos em 1m/5m/15m/1h — "
                                   f"{len(self.positions)} posição(ões) aberta(s)")
        else:
            label = {"EMERGENCIA": "EMERGÊNCIA"}.get(st, st)
            self.brain.activity = f"{label}: {reason or 'sem novas entradas'} (análise continua ativa)"

    def _rollover_day(self, now: float) -> None:
        key = stats.day_key(now, self.tz)
        if key != self.risk.state.day_key and self.account_ready():
            eq = self.equity()[0]
            first = not self.risk.state.day_key
            self.risk.new_day(key, eq)
            if not first:
                self._log("INFO", "risco", f"Novo dia {key}: contadores diários reiniciados (patrimônio {eq:.4f})", now=now)
                self.repo.prune(30, now)

    def _step_symbol(self, symbol: str, now: float) -> None:
        fresh, reason = self.data_fresh(symbol, now)
        book = self.market.get_book(symbol)
        pos = self.positions.get(symbol)
        if pos:
            if fresh and book:
                self._manage(pos, book, now)
            elif self._throttled(f"stale-pos-{symbol}", now):
                msg = f"Posição aberta em {symbol} sem dados atualizados ({reason}). Saídas aguardando dados válidos."
                self._log("AVISO", "dados", msg, now=now)
                self.brain.think(now, "alerta", msg, symbol)
        c1 = self.market.get_candles(symbol, "1m")
        closed = [c for c in c1[-3:] if c.closed]
        if not closed:
            return
        last_closed = closed[-1].open_time
        if last_closed > self.last_eval.get(symbol, 0):
            self.last_eval[symbol] = last_closed
            self._evaluate(symbol, now, book, fresh, reason, last_closed)

    # ============================================================== análise
    def _evaluate(self, symbol: str, now: float, book: Book | None, fresh: bool, reason: str,
                  candle_time: int) -> None:
        rs = self.risk_settings
        candles = {tf: self.market.get_candles(symbol, tf) for tf in TIMEFRAMES}
        circuit = self.risk.check_circuit(symbol, candles["1m"], now)
        if circuit:
            self._log("AVISO", "risco", circuit, now=now)
            self.brain.think(now, "risco", circuit, symbol)

        pos = self.positions.get(symbol)
        if pos and fresh and book:
            why = self.strategy.trend_invalidated(symbol, candles["15m"], pos.entry_time)
            if why:
                self._close(pos, book, now, "TENDENCIA_INVALIDADA", why)

        a = self.strategy.evaluate(symbol, candles, book, now, rs.fee_rate, rs.slippage_pct, rs.max_spread_pct,
                                   rs.min_reward_risk, rs.min_score, fast=self.fast_eval)
        a.last_1m_open_time = candle_time
        self.last_analysis[symbol] = a
        blockers = self.risk.entry_blockers(
            symbol, now, bot_status=self.status, open_symbols=list(self.positions), in_flight=self.in_flight,
            data_fresh=fresh, data_reason=reason)

        decision, sizing_reason, accepted = "SEM SINAL", None, False
        if a.action == "COMPRAR":
            if blockers:
                decision = "BLOQUEADA PELO RISCO"
                self.brain.think(now, "rejeitada", f"Sinal de compra em {symbol} (pontuação {a.score:.0f}) "
                                 f"REJEITADO: {blockers[0]}", symbol)
            else:
                eq, free, expo = self.equity()
                filters = self.market.get_filters(symbol)
                assert filters and a.entry and a.stop
                dust = self.broker.balances().get(filters.base_asset, D(0))
                sz = size_position(symbol, eq, free, expo, a.entry, a.stop, filters, rs, existing_base=dust)
                sizing_reason = sz.reason
                if not sz.ok:
                    decision = "RECUSADA (CAPITAL)"
                    self.brain.think(now, "rejeitada", f"Sinal em {symbol} recusado: {sz.reason}", symbol)
                    if self._throttled(f"capital-{symbol}", now, 900):
                        self._log("AVISO", "capital", sz.reason, sz.details, now)
                elif book is not None:
                    opened = self._open(symbol, a, sz.qty, sz.risk_quote, book, now)
                    decision = "ACEITA" if opened else "FALHA NA EXECUÇÃO"
                    accepted = opened is not None
        self.brain.record(a, blockers, decision, sizing_reason)

        if self.persist_decisions:
            failed = [g.label for g in a.gates if not g.passed]
            details: dict[str, Any] = {"failed_gates": failed, "blockers": blockers, "decision": decision}
            if a.action == "COMPRAR":
                details.update(a.to_dict())
                details["sizing"] = sizing_reason
            self.repo.insert_decision(now, symbol, a.action, accepted, a.score, f"{decision}: {a.summary}", details)

    # ============================================================ execução
    def _open(self, symbol: str, a: Analysis, qty: Decimal, risk_quote: Decimal, book: Book,
              now: float) -> Position | None:
        filters = self.market.get_filters(symbol)
        assert filters is not None and a.stop is not None and a.take_profit is not None
        cid = f"CTA-{symbol}-{a.last_1m_open_time // 60000}-B"
        self.in_flight.add(symbol)
        try:
            with self.repo.transaction():
                fill = self.broker.market_buy(symbol, qty, book, filters, cid, now)
                held = fill.qty - (fill.fee if fill.fee_asset == filters.base_asset else D(0))
                stop = filters.round_price(D(a.stop))
                tp = filters.round_price(D(a.take_profit), up=True)
                pos = Position(
                    id=None, symbol=symbol, mode=self.mode, status="ABERTA", entry_time=now,
                    entry_price=fill.price, qty=held, cost_quote=fill.quote_qty, stop_price=stop,
                    initial_stop=stop, take_profit=tp, risk_quote=risk_quote, atr_at_entry=a.atr_5m or 0.0,
                    score=a.score, strategy=a.strategy, entry_order_id=cid, fees_quote=fill.fee_quote,
                    highest_price=D(book.bid),
                )
                self.repo.save_position(pos)
                assert pos.id is not None
                self.repo.link_order(cid, pos.id)
        except OrderRejected as exc:
            self._reload_broker()
            msg = f"Compra em {symbol} rejeitada: {exc}"
            self._log("AVISO", "ordem", msg, now=now)
            self.brain.think(now, "rejeitada", msg, symbol)
            return None
        except Exception as exc:  # falha inesperada: registra e conta para pausa automática
            self._reload_broker()
            self.last_error = str(exc)
            self._log("CRITICO", "ordem", f"Falha ao executar compra em {symbol}: {exc}", now=now)
            paused = self.risk.record_error(now)
            if paused:
                self.brain.think(now, "risco", paused)
            return None
        finally:
            self.in_flight.discard(symbol)
        self.positions[symbol] = pos
        msg = (f"COMPRA {'SIMULADA ' if not self.broker.is_real else ''}{symbol}: {held} a {fill.price:.6g} "
               f"(custo {fill.quote_qty:.4f} {self.quote}, taxa {fill.fee_quote:.5f}); stop {stop} / alvo {tp}; "
               f"pontuação {a.score:.0f}; risco planejado {risk_quote:.4f} {self.quote}")
        self._log("INFO", "operacao", msg, {"position_id": pos.id, "reasons": a.reasons}, now)
        self.brain.think(now, "aceita", msg + " | Motivos: " + "; ".join(a.reasons), symbol)
        return pos

    def _reload_broker(self) -> None:
        if isinstance(self.broker, PaperBroker):
            self.broker.reload()

    def _manage(self, pos: Position, book: Book, now: float) -> None:
        bid = D(book.bid)
        fee = D(self.risk_settings.fee_rate)
        if bid > pos.highest_price:
            pos.highest_price = bid
        r = pos.entry_price - pos.initial_stop
        changed = False
        breakeven = pos.entry_price * (1 + 2 * fee)
        if r > 0 and not pos.breakeven_done and bid >= pos.entry_price + r:
            pos.breakeven_done = True
            if breakeven > pos.stop_price:
                pos.stop_price = breakeven
                changed = True
                self.brain.think(now, "info", f"{pos.symbol}: lucro de 1R atingido — stop movido para o "
                                 f"break-even ({breakeven:.6g}, cobre as taxas)", pos.symbol)
        if r > 0 and bid >= pos.entry_price + r * D("1.5") and pos.atr_at_entry > 0:
            trail = pos.highest_price - D(pos.atr_at_entry)
            if trail > pos.stop_price + r * D("0.1"):
                pos.stop_price = trail
                changed = True
        if changed:
            self.repo.save_position(pos)

        if bid <= pos.stop_price:
            if not pos.breakeven_done:
                reason = "STOP_LOSS"
            elif pos.stop_price > breakeven:
                reason = "STOP_MOVEL"
            else:
                reason = "BREAK_EVEN"
            self._close(pos, book, now, reason, f"bid {bid} <= stop {pos.stop_price}")
        elif bid >= pos.take_profit:
            self._close(pos, book, now, "TAKE_PROFIT", f"bid {bid} >= alvo {pos.take_profit}")
        elif now - pos.entry_time >= self.risk_settings.max_trade_minutes * 60:
            self._close(pos, book, now, "TEMPO_MAXIMO",
                        f"operação aberta há mais de {self.risk_settings.max_trade_minutes} min")

    def _close(self, pos: Position, book: Book, now: float, reason: str, detail: str = "") -> bool:
        filters = self.market.get_filters(pos.symbol)
        if filters is None:
            return False
        cid = f"CTA-{pos.id}-S"  # um único ID de saída por posição: impede venda duplicada
        base = filters.base_asset
        held_before = self.broker.balances().get(base, D(0))
        dust_before = max(held_before - pos.qty, D(0))  # poeira de operações anteriores
        try:
            with self.repo.transaction():
                # vende TODO o saldo do ativo (recicla a poeira de operações anteriores)
                fill = self.broker.market_sell(pos.symbol, held_before, book, filters, cid, now)
                net = fill.quote_qty - (fill.fee if fill.fee_asset == filters.quote_asset else D(0))
                dust_after = self.broker.balances().get(base, D(0))
                # variação da poeira entra no resultado, avaliada no preço de saída líquido
                dust_delta_value = (dust_after - dust_before) * fill.price * (1 - D(self.risk_settings.fee_rate))
                pos.status = "FECHADA"
                pos.exit_time = now
                pos.exit_price = fill.price
                pos.exit_reason = reason
                pos.exit_order_id = cid
                pos.proceeds_quote = net
                pos.fees_quote += fill.fee_quote
                pos.pnl_quote = net + dust_delta_value - pos.cost_quote
                pos.pnl_pct = float(pos.pnl_quote / pos.cost_quote * 100) if pos.cost_quote else 0.0
                pos.r_multiple = float(pos.pnl_quote / pos.risk_quote) if pos.risk_quote else None
                if dust_after != dust_before:
                    pos.notes.append(f"poeira {base}: {dust_before} -> {dust_after} (valor incluído no resultado)")
                if detail:
                    pos.notes.append(detail)
                self.repo.save_position(pos)
                self.repo.link_order(cid, pos.id or 0)
        except OrderRejected as exc:
            self._reload_broker()
            if self._throttled(f"close-fail-{pos.symbol}", now, 300):
                msg = (f"NÃO foi possível vender {pos.symbol} ({reason}): {exc}. Se o valor da posição ficou abaixo "
                       "do mínimo da Binance, ela só poderá ser vendida se o preço subir.")
                self._log("CRITICO", "ordem", msg, now=now)
                self.brain.think(now, "alerta", msg, pos.symbol)
            return False
        except Exception as exc:
            self._reload_broker()
            self.last_error = str(exc)
            self._log("CRITICO", "ordem", f"Falha ao vender {pos.symbol}: {exc}", now=now)
            self.risk.record_error(now)
            return False
        self.positions.pop(pos.symbol, None)
        pause = self.risk.on_trade_closed(pos.symbol, pos.pnl_quote, now)
        result = "LUCRO" if pos.pnl_quote > 0 else "PREJUÍZO"
        msg = (f"VENDA {pos.symbol} [{reason}] a {fill.price:.6g}: {result} de {pos.pnl_quote:.4f} {self.quote} "
               f"({pos.pnl_pct:+.2f}%, {pos.r_multiple:+.2f}R), taxas totais {pos.fees_quote:.5f}")
        self._log("INFO", "operacao", msg, {"position_id": pos.id}, now)
        self.brain.think(now, "saida", msg, pos.symbol)
        if pause:
            self._log("AVISO", "risco", pause, now=now)
            self.brain.think(now, "risco", pause)
        return True

    # ============================================================ snapshot
    def snapshot(self, now: float | None = None) -> dict[str, Any]:
        now = now if now is not None else self.clock()
        eq, free, expo = self.equity()
        rs = self.risk_settings
        reserve = eq * D(rs.fee_reserve_pct) / 100
        st, reason = self.effective_status(now)
        today = stats.daily(self.repo, now, self.tz, self.mode)
        total = stats.overall(self.repo, self.mode)
        brl_book = self.market.brl_book()
        positions = []
        for p in self.positions.values():
            book = self.market.get_book(p.symbol)
            d = p.to_dict()
            if book:
                d["current_bid"] = book.bid
                d["unrealized_pnl"] = str(p.unrealized_pnl(book.bid, D(rs.fee_rate)))
            positions.append(d)
        market: dict[str, Any] = {}
        for s in self.settings.symbols:
            b = self.market.get_book(s)
            c1 = self.market.get_candles(s, "1m")
            last_a = self.brain.latest.get(s, {})
            day_open = None
            c1h = self.market.get_candles(s, "1h")
            if len(c1h) >= 24:
                day_open = c1h[-24].open
            market[s] = {
                "bid": b.bid if b else None, "ask": b.ask if b else None,
                "spread_pct": b.spread_pct if b else None,
                "last": c1[-1].close if c1 else None,
                "change_24h_pct": ((c1[-1].close / day_open - 1) * 100) if c1 and day_open else None,
                "score": last_a.get("score"), "signal": last_a.get("signal"), "decision": last_a.get("decision"),
                "regime": last_a.get("regime"), "volatility": last_a.get("volatility"),
                "trends": last_a.get("trends", {}),
            }
        meta = self.broker.meta if isinstance(self.broker, PaperBroker) else {}
        return {
            "server_time": now,
            "uptime_s": now - self.started_at,
            "mode": self.mode,
            "mode_label": MODE_LABEL.get(self.mode, self.mode),
            "is_real_money": self.broker.is_real and self.mode == Mode.REAL.value,
            "data_source": self.market.source_name,
            "synthetic_data": self.market.is_synthetic,
            "status": st,
            "status_reason": reason,
            "strategy": f"{STRATEGY_NAME} v{STRATEGY_VERSION}",
            "symbols": list(self.settings.symbols),
            "account": {
                "initialized": self.account_ready(),
                "quote_asset": self.quote,
                "equity": str(eq), "equity_brl": str(self.to_brl(eq)) if self.to_brl(eq) is not None else None,
                "free": str(free), "available": str(max(free - reserve, D(0))),
                "available_brl": str(self.to_brl(max(free - reserve, D(0)))) if brl_book or self.quote == "BRL" else None,
                "exposure": str(expo),
                "brl_rate": brl_book.bid if brl_book else None,
                "initial": meta,
                "balances": {k: str(v) for k, v in self.broker.balances().items()},
            },
            "today": today,
            "totals": total,
            "risk": self.risk.status(now, eq),
            "risk_settings": rs.to_dict(),
            "positions": positions,
            "brain": self.brain.snapshot(),
            "market": market,
            "health": {**self.market.health(now), "engine_last_step_age_s": round(now - self.last_step_ts, 1),
                       "engine_last_error": self.last_error},
        }

    # ================================================================= loop
    async def run(self, interval: float = 1.0) -> None:
        while True:
            try:
                self.step()
            except Exception as exc:  # o loop nunca morre; erros pausam por segurança
                self.last_error = f"{type(exc).__name__}: {exc}"
                log.exception("Erro no ciclo do motor")
                now = self.clock()
                if self._throttled("engine-error", now, 60):
                    self.repo.log("CRITICO", "motor", f"Erro no ciclo: {self.last_error}", ts=now)
                self.risk.record_error(now)
            await asyncio.sleep(interval)
