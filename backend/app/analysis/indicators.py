"""Indicadores técnicos implementados do zero (Python puro, sem dependências).

Convenções:
- Entradas: listas em ordem cronológica (mais antigo primeiro).
- Saídas: listas do mesmo tamanho; posições sem dados suficientes = None.
- RSI e ATR usam a suavização de Wilder (RMA), padrão do mercado/TradingView.
- Bandas de Bollinger usam desvio-padrão populacional (ddof=0), como TradingView.
"""
from __future__ import annotations

import math
from datetime import datetime, timezone
from typing import Optional, Sequence

from ..domain import Candle

Series = list[Optional[float]]


def sma(values: Sequence[float], period: int) -> Series:
    out: Series = [None] * len(values)
    if period <= 0 or len(values) < period:
        return out
    window = sum(values[:period])
    out[period - 1] = window / period
    for i in range(period, len(values)):
        window += values[i] - values[i - period]
        out[i] = window / period
    return out


def ema(values: Sequence[float], period: int) -> Series:
    """EMA semeada com a média simples dos primeiros `period` valores."""
    out: Series = [None] * len(values)
    if period <= 0 or len(values) < period:
        return out
    k = 2 / (period + 1)
    prev = sum(values[:period]) / period
    out[period - 1] = prev
    for i in range(period, len(values)):
        prev = values[i] * k + prev * (1 - k)
        out[i] = prev
    return out


def rma(values: Sequence[float], period: int) -> Series:
    """Média móvel de Wilder."""
    out: Series = [None] * len(values)
    if period <= 0 or len(values) < period:
        return out
    prev = sum(values[:period]) / period
    out[period - 1] = prev
    for i in range(period, len(values)):
        prev = (prev * (period - 1) + values[i]) / period
        out[i] = prev
    return out


def rsi(closes: Sequence[float], period: int = 14) -> Series:
    out: Series = [None] * len(closes)
    if len(closes) <= period:
        return out
    gains = [0.0]
    losses = [0.0]
    for i in range(1, len(closes)):
        ch = closes[i] - closes[i - 1]
        gains.append(max(ch, 0.0))
        losses.append(max(-ch, 0.0))
    avg_g = sum(gains[1: period + 1]) / period
    avg_l = sum(losses[1: period + 1]) / period

    def value(g: float, l: float) -> float:
        if l == 0 and g == 0:
            return 50.0
        if l == 0:
            return 100.0
        rs = g / l
        return 100 - 100 / (1 + rs)

    out[period] = value(avg_g, avg_l)
    for i in range(period + 1, len(closes)):
        avg_g = (avg_g * (period - 1) + gains[i]) / period
        avg_l = (avg_l * (period - 1) + losses[i]) / period
        out[i] = value(avg_g, avg_l)
    return out


def macd(closes: Sequence[float], fast: int = 12, slow: int = 26, signal: int = 9) -> tuple[Series, Series, Series]:
    ef, es = ema(closes, fast), ema(closes, slow)
    line: Series = [None if a is None or b is None else a - b for a, b in zip(ef, es)]
    start = next((i for i, v in enumerate(line) if v is not None), None)
    sig: Series = [None] * len(closes)
    if start is not None:
        sub = ema([v for v in line[start:] if v is not None], signal)
        for j, v in enumerate(sub):
            sig[start + j] = v
    hist: Series = [None if a is None or b is None else a - b for a, b in zip(line, sig)]
    return line, sig, hist


def bollinger(closes: Sequence[float], period: int = 20, mult: float = 2.0) -> tuple[Series, Series, Series, Series]:
    """Retorna (meio, superior, inferior, %B)."""
    n = len(closes)
    mid: Series = [None] * n
    up: Series = [None] * n
    low: Series = [None] * n
    pb: Series = [None] * n
    for i in range(period - 1, n):
        window = closes[i - period + 1: i + 1]
        m = sum(window) / period
        sd = math.sqrt(sum((x - m) ** 2 for x in window) / period)
        mid[i], up[i], low[i] = m, m + mult * sd, m - mult * sd
        width = up[i] - low[i]  # type: ignore[operator]
        pb[i] = 0.5 if width == 0 else (closes[i] - low[i]) / width  # type: ignore[operator]
    return mid, up, low, pb


def true_range(candles: Sequence[Candle]) -> list[float]:
    out = []
    for i, c in enumerate(candles):
        if i == 0:
            out.append(c.high - c.low)
        else:
            pc = candles[i - 1].close
            out.append(max(c.high - c.low, abs(c.high - pc), abs(c.low - pc)))
    return out


def atr(candles: Sequence[Candle], period: int = 14) -> Series:
    return rma(true_range(candles), period)


def vwap(candles: Sequence[Candle]) -> Series:
    """VWAP de sessão, reiniciado a cada dia UTC (padrão das exchanges cripto)."""
    out: Series = []
    cum_pv = cum_v = 0.0
    day = None
    for c in candles:
        d = datetime.fromtimestamp(c.open_time / 1000, tz=timezone.utc).date()
        if d != day:
            day, cum_pv, cum_v = d, 0.0, 0.0
        tp = (c.high + c.low + c.close) / 3
        cum_pv += tp * c.volume
        cum_v += c.volume
        out.append(cum_pv / cum_v if cum_v > 0 else tp)
    return out


def relative_volume(volumes: Sequence[float], period: int = 20) -> Series:
    """Volume atual dividido pela média dos `period` candles ANTERIORES."""
    out: Series = [None] * len(volumes)
    for i in range(period, len(volumes)):
        avg = sum(volumes[i - period: i]) / period
        out[i] = volumes[i] / avg if avg > 0 else None
    return out


def slope_pct(series: Series, lookback: int = 5) -> Optional[float]:
    """Variação percentual da série nos últimos `lookback` pontos."""
    vals = [v for v in series if v is not None]
    if len(vals) <= lookback or vals[-1 - lookback] == 0:
        return None
    return (vals[-1] - vals[-1 - lookback]) / vals[-1 - lookback] * 100


def last(series: Series, offset: int = 0) -> Optional[float]:
    idx = len(series) - 1 - offset
    return series[idx] if 0 <= idx < len(series) else None
