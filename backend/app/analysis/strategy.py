"""Estratégia: Pullback de Tendência Multi-Timeframe (somente compra — Spot).

Regras completas documentadas em docs/ESTRATEGIA.md. Resumo:
1. FILTROS OBRIGATÓRIOS (todos precisam passar; um único falha = não opera):
   dados suficientes, regime de alta no 1h, tendência de alta no 15m,
   volatilidade operável, spread aceitável, sem sobrecompra, R:R líquido mínimo.
2. PONTUAÇÃO 0–100 por confirmações independentes (tendência, pullback,
   momentum, gatilho 1m, volume, espaço até a resistência).
3. Só entra se filtros OK **e** pontuação >= mínimo configurado.

Na Binance Spot não existe venda a descoberto: movimentos de baixa são
detectados para FICAR DE FORA e para SAIR de posições, nunca para vender
o que não se tem.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any, Optional

from ..domain import Book, Candle
from . import indicators as ind
from . import levels as lv
from . import patterns as pa

STRATEGY_NAME = "Pullback de Tendência Multi-Timeframe"
STRATEGY_VERSION = "1.0"


@dataclass
class StrategyParams:
    min_candles: dict[str, int] = field(default_factory=lambda: {"1m": 60, "5m": 60, "15m": 60, "1h": 210})
    window: int = 500  # candles usados no cálculo dos indicadores
    min_atr_pct_5m: float = 0.15  # abaixo disso as taxas (~0,2% ida+volta) engolem o alvo
    max_atr_pct_5m: float = 2.5
    extreme_range_atr_mult: float = 4.0  # candle 1m > 4x ATR(1m) = volatilidade extrema
    max_rsi_5m: float = 72.0
    max_pb_5m: float = 1.0  # não comprar acima da banda superior
    stop_atr_min: float = 1.0
    stop_atr_max: float = 2.0
    target_r: float = 2.5
    pullback_lookback: int = 6


@dataclass
class TFAnalysis:
    tf: str
    close: float
    ema9: Optional[float]
    ema21: Optional[float]
    ema50: Optional[float]
    ema200: Optional[float]
    rsi: Optional[float]
    rsi_prev: Optional[float]
    macd: Optional[float]
    macd_signal: Optional[float]
    macd_hist: Optional[float]
    macd_hist_prev: Optional[float]
    macd_hist_prev2: Optional[float]
    bb_mid: Optional[float]
    bb_up: Optional[float]
    bb_low: Optional[float]
    pb: Optional[float]
    atr: Optional[float]
    atr_pct: Optional[float]
    vwap: Optional[float]
    rvol: Optional[float]
    ema21_slope: Optional[float]
    ema50_slope: Optional[float]
    trend: str
    regime: str
    patterns: list[str]
    last_open_time: int


@dataclass
class Gate:
    key: str
    label: str
    passed: bool
    detail: str


@dataclass
class Component:
    key: str
    label: str
    points: float
    max_points: float
    detail: str


@dataclass
class Analysis:
    symbol: str
    ts: float
    action: str  # COMPRAR | AGUARDAR
    score: float
    min_score: float
    gates: list[Gate]
    components: list[Component]
    reasons: list[str]
    summary: str
    strategy: str = f"{STRATEGY_NAME} v{STRATEGY_VERSION}"
    timeframes: dict[str, dict[str, Any]] = field(default_factory=dict)
    entry: Optional[float] = None
    stop: Optional[float] = None
    take_profit: Optional[float] = None
    rr_net: Optional[float] = None
    atr_5m: Optional[float] = None
    resistance: Optional[float] = None
    support: Optional[float] = None
    regime: str = "DESCONHECIDO"
    volatility: str = "DESCONHECIDA"
    spread_pct: Optional[float] = None
    last_1m_open_time: int = 0

    @property
    def gates_passed(self) -> bool:
        return all(g.passed for g in self.gates)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def _fmt(v: Optional[float], nd: int = 2) -> str:
    return "—" if v is None else f"{v:.{nd}f}"


def compute_tf(tf: str, candles: list[Candle]) -> TFAnalysis:
    closes = [c.close for c in candles]
    e9, e21, e50, e200 = ind.ema(closes, 9), ind.ema(closes, 21), ind.ema(closes, 50), ind.ema(closes, 200)
    r = ind.rsi(closes, 14)
    m, s, h = ind.macd(closes)
    mid, up, low, pb = ind.bollinger(closes, 20, 2.0)
    a = ind.atr(candles, 14)
    vw = ind.vwap(candles)
    rv = ind.relative_volume([c.volume for c in candles], 20)
    close = closes[-1]
    atr_v = ind.last(a)
    E21, E50, E200 = ind.last(e21), ind.last(e50), ind.last(e200)
    s50 = ind.slope_pct(e50, 5)

    trend = "LATERAL"
    if E21 is not None and E50 is not None:
        if E21 > E50 and close > E50 and (s50 is None or s50 >= 0):
            trend = "ALTA"
        elif E21 < E50 and close < E50:
            trend = "BAIXA"
    regime = "LATERAL"
    if E50 is not None and E200 is not None:
        if close > E200 and E50 > E200:
            regime = "ALTA"
        elif close < E200 and E50 < E200:
            regime = "BAIXA"
    elif E200 is None:
        regime = "INDEFINIDO"

    return TFAnalysis(
        tf=tf, close=close, ema9=ind.last(e9), ema21=E21, ema50=E50, ema200=E200,
        rsi=ind.last(r), rsi_prev=ind.last(r, 1), macd=ind.last(m), macd_signal=ind.last(s),
        macd_hist=ind.last(h), macd_hist_prev=ind.last(h, 1), macd_hist_prev2=ind.last(h, 2),
        bb_mid=ind.last(mid), bb_up=ind.last(up), bb_low=ind.last(low), pb=ind.last(pb),
        atr=atr_v, atr_pct=(atr_v / close * 100) if atr_v and close else None,
        vwap=ind.last(vw), rvol=ind.last(rv), ema21_slope=ind.slope_pct(e21, 5), ema50_slope=s50,
        trend=trend, regime=regime, patterns=pa.detect(candles), last_open_time=candles[-1].open_time,
    )


def net_reward_risk(entry: float, stop: float, tp: float, fee: float, slip: float) -> Optional[float]:
    """R:R por unidade, já descontando taxas (compra e venda) e slippage."""
    cost = entry * (1 + slip)
    keep = (1 - fee)  # taxa da compra é cobrada no ativo recebido
    reward = keep * tp * (1 - slip) * (1 - fee) - cost
    risk = cost - keep * stop * (1 - slip) * (1 - fee)
    if risk <= 0:
        return None
    return reward / risk


class Strategy:
    def __init__(self, params: StrategyParams | None = None):
        self.p = params or StrategyParams()
        self._cache: dict[tuple[str, str], tuple[tuple[int, float, int], TFAnalysis]] = {}
        self._levels_cache: dict[str, tuple[tuple[int, int], list[lv.Level]]] = {}

    # ------------------------------------------------------------------
    def _tf(self, symbol: str, tf: str, closed: list[Candle]) -> TFAnalysis:
        key = (closed[-1].open_time, closed[-1].close, len(closed))
        hit = self._cache.get((symbol, tf))
        if hit and hit[0] == key:
            return hit[1]
        res = compute_tf(tf, closed[-self.p.window:])
        self._cache[(symbol, tf)] = (key, res)
        return res

    def _levels(self, symbol: str, c15: list[Candle], c1h: list[Candle]) -> list[lv.Level]:
        key = (c15[-1].open_time, c1h[-1].open_time)
        hit = self._levels_cache.get(symbol)
        if hit and hit[0] == key:
            return hit[1]
        levels = lv.find_levels(c15[-200:]) + lv.find_levels(c1h[-200:])
        self._levels_cache[symbol] = (key, levels)
        return levels

    # ------------------------------------------------------------------
    def evaluate(
        self,
        symbol: str,
        candles: dict[str, list[Candle]],
        book: Book | None,
        now: float,
        fee_rate: float,
        slippage_pct: float,
        max_spread_pct: float,
        min_rr: float,
        min_score: float,
        fast: bool = False,
    ) -> Analysis:
        p = self.p
        gates: list[Gate] = []
        comps: list[Component] = []
        closed = {tf: [c for c in candles.get(tf, []) if c.closed] for tf in p.min_candles}

        missing = [f"{tf}: {len(closed[tf])}/{need}" for tf, need in p.min_candles.items() if len(closed[tf]) < need]
        gates.append(Gate("dados", "Histórico suficiente", not missing,
                          "OK" if not missing else "Aguardando histórico — " + ", ".join(missing)))
        if missing:
            return self._finish(symbol, now, gates, comps, min_score, book, max_spread_pct)

        t1, t5, t15, t60 = (self._tf(symbol, tf, closed[tf]) for tf in ("1m", "5m", "15m", "1h"))
        ctx: dict[str, Any] = {"tf": {t.tf: asdict(t) for t in (t1, t5, t15, t60)}}

        # --- Filtros obrigatórios ---------------------------------------
        gates.append(Gate("regime_1h", "Regime de alta no 1h (preço e EMA50 acima da EMA200)",
                          t60.regime == "ALTA",
                          f"Regime 1h: {t60.regime} (preço {_fmt(t60.close, 4)}, EMA50 {_fmt(t60.ema50, 4)}, "
                          f"EMA200 {_fmt(t60.ema200, 4)})"))
        if fast and not gates[-1].passed:
            return self._finish(symbol, now, gates, comps, min_score, book, max_spread_pct, t5, t60, ctx)

        gates.append(Gate("tendencia_15m", "Tendência de alta no 15m (EMA21 > EMA50, preço > EMA50)",
                          t15.trend == "ALTA", f"Tendência 15m: {t15.trend}"))

        atr_pct = t5.atr_pct or 0.0
        last1 = closed["1m"][-1]
        extreme = bool(t1.atr) and (last1.high - last1.low) > p.extreme_range_atr_mult * (t1.atr or 0)
        vol_ok = p.min_atr_pct_5m <= atr_pct <= p.max_atr_pct_5m and not extreme
        if extreme:
            vdetail = "Volatilidade EXTREMA: último candle de 1m maior que 4x o ATR"
        elif atr_pct < p.min_atr_pct_5m:
            vdetail = f"ATR 5m {atr_pct:.3f}% < {p.min_atr_pct_5m}%: movimento pequeno demais frente às taxas"
        elif atr_pct > p.max_atr_pct_5m:
            vdetail = f"ATR 5m {atr_pct:.2f}% > {p.max_atr_pct_5m}%: volátil demais"
        else:
            vdetail = f"ATR 5m {atr_pct:.3f}% dentro da faixa operável"
        gates.append(Gate("volatilidade", "Volatilidade operável", vol_ok, vdetail))

        spread = book.spread_pct if book else None
        gates.append(Gate("spread", f"Spread <= {max_spread_pct}%", spread is not None and spread <= max_spread_pct,
                          "Sem livro de ofertas" if spread is None else f"Spread atual {spread:.4f}%"))

        not_ob = (t5.rsi or 0) <= p.max_rsi_5m and (t5.pb or 0) <= p.max_pb_5m
        gates.append(Gate("sobrecompra", "Sem sobrecompra no 5m", not_ob,
                          f"RSI 5m {_fmt(t5.rsi, 1)} (máx {p.max_rsi_5m}), %B {_fmt(t5.pb)} (máx {p.max_pb_5m})"))

        # --- Stop, alvo e R:R -------------------------------------------
        entry = book.ask if book else t1.close
        atr5 = t5.atr or 0.0
        swing = lv.swing_low(closed["5m"], p.pullback_lookback)
        raw_dist = entry - (swing - 0.1 * atr5) if swing is not None else p.stop_atr_min * atr5
        dist = min(max(raw_dist, p.stop_atr_min * atr5), p.stop_atr_max * atr5)
        stop = entry - dist
        tp = entry + p.target_r * dist
        levels = self._levels(symbol, closed["15m"], closed["1h"])
        res = lv.nearest_resistance(levels, entry)
        sup = lv.nearest_support(levels, entry)
        if res and res.price < tp:
            tp = res.price * (1 - 0.0005)
        rr = net_reward_risk(entry, stop, tp, fee_rate, slippage_pct / 100) if dist > 0 else None
        gates.append(Gate("risco_retorno", f"Risco/retorno líquido >= {min_rr}",
                          rr is not None and rr >= min_rr,
                          f"R:R líquido (após taxas e slippage) = {_fmt(rr)}"
                          + (f"; resistência em {res.price:.6g}" if res else "; sem resistência próxima")))

        # --- Pontuação ----------------------------------------------------
        pts = 0.0
        if t5.ema9 and t5.ema21 and t5.ema50 and t5.ema9 > t5.ema21 > t5.ema50:
            pts, d = 10, "EMA9 > EMA21 > EMA50 no 5m"
        elif t5.ema21 and t5.ema50 and t5.ema21 > t5.ema50:
            pts, d = 5, "EMA21 > EMA50 no 5m (EMA9 ainda abaixo)"
        else:
            d = "EMAs do 5m desalinhadas"
        if (t60.ema50_slope or 0) > 0:
            pts += 5
            d += "; EMA50 do 1h subindo"
        if (t15.ema21_slope or 0) > 0:
            pts += 5
            d += "; EMA21 do 15m subindo"
        comps.append(Component("tendencia", "Alinhamento de tendência", pts, 20, d))

        pts, notes = 0.0, []
        recent5 = closed["5m"][-p.pullback_lookback:]
        touched = any(
            (t5.ema21 and c.low <= t5.ema21 * 1.002) or (t5.vwap and c.low <= t5.vwap * 1.002) for c in recent5
        )
        if touched:
            pts += 10
            notes.append("recuou até a EMA21/VWAP")
        if t5.vwap and t5.close > t5.vwap:
            pts += 5
            notes.append("preço acima do VWAP")
        if t5.pb is not None and 0.2 <= t5.pb <= 0.8:
            pts += 5
            notes.append(f"%B {t5.pb:.2f} no meio das bandas")
        comps.append(Component("pullback", "Pullback e localização", pts, 20,
                               ", ".join(notes) or "sem pullback recente — entrada esticada"))

        pts, notes = 0.0, []
        h0, h1, h2 = t5.macd_hist, t5.macd_hist_prev, t5.macd_hist_prev2
        if h0 is not None and h1 is not None and h2 is not None and h0 > h1 > h2:
            pts += 8
            notes.append("histograma MACD subindo 2 candles")
        elif h0 is not None and h1 is not None and h0 > h1:
            pts += 4
            notes.append("histograma MACD subindo")
        if h0 is not None and h0 > 0:
            pts += 4
            notes.append("MACD acima do sinal")
        if t5.rsi is not None and t5.rsi_prev is not None:
            if 45 <= t5.rsi <= 65 and t5.rsi > t5.rsi_prev:
                pts += 8
                notes.append(f"RSI {t5.rsi:.1f} subindo em zona saudável")
            elif 40 <= t5.rsi <= 70:
                pts += 4
                notes.append(f"RSI {t5.rsi:.1f} neutro")
        comps.append(Component("momentum", "Momentum (MACD + RSI 5m)", pts, 20, ", ".join(notes) or "momentum fraco"))

        pts, notes = 0.0, []
        if t1.ema9 and t1.close > t1.ema9:
            pts += 5
            notes.append("1m acima da EMA9")
        if set(t1.patterns) & pa.BULLISH:
            pts += 5
            notes.append("padrão de alta: " + ", ".join(sorted(set(t1.patterns) & pa.BULLISH)))
        if len(closed["1m"]) >= 2 and closed["1m"][-1].close > closed["1m"][-2].high:
            pts += 5
            notes.append("rompeu a máxima do candle anterior")
        comps.append(Component("gatilho", "Gatilho no 1m", pts, 15, ", ".join(notes) or "sem gatilho"))

        rv = t5.rvol or 0.0
        pts = 10.0 if rv >= 1.5 else 5.0 if rv >= 1.0 else 0.0
        comps.append(Component("volume", "Volume relativo (5m)", pts, 10, f"volume {rv:.2f}x a média de 20 candles"))

        if res is None:
            pts, d = 15.0, "nenhuma resistência mapeada acima"
        else:
            room = (res.price - entry) / dist if dist > 0 else 0
            pts = 15.0 if room >= 2 else 8.0 if room >= 1.5 else 0.0
            d = f"resistência a {room:.2f}R de distância"
        comps.append(Component("espaco", "Espaço até a resistência", pts, 15, d))

        a = self._finish(symbol, now, gates, comps, min_score, book, max_spread_pct, t5, t60, ctx)
        a.entry, a.stop, a.take_profit, a.rr_net, a.atr_5m = entry, stop, tp, rr, atr5
        a.resistance = res.price if res else None
        a.support = sup.price if sup else None
        a.volatility = (
            "EXTREMA" if extreme or atr_pct > p.max_atr_pct_5m else
            "BAIXA" if atr_pct < p.min_atr_pct_5m else
            "ALTA" if atr_pct > 1.0 else "NORMAL"
        )
        return a

    # ------------------------------------------------------------------
    def _finish(self, symbol: str, now: float, gates: list[Gate], comps: list[Component], min_score: float,
                book: Book | None, max_spread_pct: float, t5: TFAnalysis | None = None,
                t60: TFAnalysis | None = None, ctx: dict[str, Any] | None = None) -> Analysis:
        score = round(sum(c.points for c in comps), 1)
        failed = [g for g in gates if not g.passed]
        reasons: list[str] = []
        if failed:
            reasons += [f"✗ {g.label}: {g.detail}" for g in failed]
        if comps and score < min_score:
            reasons.append(f"✗ Pontuação {score:.0f} abaixo do mínimo {min_score:.0f}")
        action = "COMPRAR" if not failed and comps and score >= min_score else "AGUARDAR"
        if action == "COMPRAR":
            reasons.append(f"✓ Todos os filtros obrigatórios aprovados e pontuação {score:.0f} >= {min_score:.0f}")
            summary = f"Oportunidade de compra em {symbol} (pontuação {score:.0f})"
        elif failed:
            summary = f"Sem entrada em {symbol}: {failed[0].label.lower()} não atendido"
        else:
            summary = f"Sem entrada em {symbol}: confirmações insuficientes ({score:.0f}/{min_score:.0f})"
        a = Analysis(symbol=symbol, ts=now, action=action, score=score, min_score=min_score, gates=gates,
                     components=comps, reasons=reasons, summary=summary,
                     timeframes=(ctx or {}).get("tf", {}), spread_pct=book.spread_pct if book else None)
        if t60:
            a.regime = t60.regime
        return a

    def trend_invalidated(self, symbol: str, candles_15m: list[Candle], entry_time: float) -> Optional[str]:
        """Saída antecipada: candle de 15m fechou abaixo da EMA50 após a entrada."""
        closed = [c for c in candles_15m if c.closed]
        if len(closed) < self.p.min_candles["15m"]:
            return None
        t15 = self._tf(symbol, "15m", closed)
        last_c = closed[-1]
        if last_c.open_time >= entry_time * 1000 and t15.ema50 and last_c.close < t15.ema50:
            return f"Candle de 15m fechou abaixo da EMA50 ({last_c.close:.6g} < {t15.ema50:.6g})"
        return None
