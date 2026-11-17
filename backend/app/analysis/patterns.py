"""Price action: padrões de candle simples e objetivos (sem subjetividade)."""
from __future__ import annotations

from typing import Sequence

from ..domain import Candle


def body(c: Candle) -> float:
    return abs(c.close - c.open)


def rng(c: Candle) -> float:
    return max(c.high - c.low, 1e-12)


def is_bull(c: Candle) -> bool:
    return c.close > c.open


def is_bear(c: Candle) -> bool:
    return c.close < c.open


def strong_close(c: Candle) -> bool:
    """Candle de alta fechando no terço superior da amplitude."""
    return is_bull(c) and (c.close - c.low) / rng(c) >= 0.7


def bullish_engulfing(prev: Candle, cur: Candle) -> bool:
    return is_bear(prev) and is_bull(cur) and cur.close >= prev.open and cur.open <= prev.close


def bearish_engulfing(prev: Candle, cur: Candle) -> bool:
    return is_bull(prev) and is_bear(cur) and cur.open >= prev.close and cur.close <= prev.open


def hammer(c: Candle) -> bool:
    lower = min(c.open, c.close) - c.low
    upper = c.high - max(c.open, c.close)
    b = max(body(c), rng(c) * 0.05)
    return lower >= 2 * b and upper <= b and (c.close - c.low) / rng(c) >= 0.6


def shooting_star(c: Candle) -> bool:
    lower = min(c.open, c.close) - c.low
    upper = c.high - max(c.open, c.close)
    b = max(body(c), rng(c) * 0.05)
    return upper >= 2 * b and lower <= b and (c.high - c.close) / rng(c) >= 0.6


def detect(candles: Sequence[Candle]) -> list[str]:
    closed = [c for c in candles if c.closed]
    if len(closed) < 2:
        return []
    prev, cur = closed[-2], closed[-1]
    found = []
    if bullish_engulfing(prev, cur):
        found.append("engolfo de alta")
    if hammer(cur):
        found.append("martelo")
    if strong_close(cur):
        found.append("fechamento forte")
    if bearish_engulfing(prev, cur):
        found.append("engolfo de baixa")
    if shooting_star(cur):
        found.append("estrela cadente")
    return found


BULLISH = {"engolfo de alta", "martelo", "fechamento forte"}
BEARISH = {"engolfo de baixa", "estrela cadente"}
