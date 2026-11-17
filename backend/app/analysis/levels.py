"""Suporte e resistência por pivôs (topos e fundos) agrupados em zonas."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Sequence

from ..domain import Candle


@dataclass
class Level:
    price: float
    touches: int
    kind: str  # "topo" | "fundo" | "misto"


def pivots(candles: Sequence[Candle], left: int = 3, right: int = 3) -> tuple[list[float], list[float]]:
    highs, lows = [], []
    for i in range(left, len(candles) - right):
        h, l = candles[i].high, candles[i].low
        if all(h >= candles[j].high for j in range(i - left, i + right + 1) if j != i):
            highs.append(h)
        if all(l <= candles[j].low for j in range(i - left, i + right + 1) if j != i):
            lows.append(l)
    return highs, lows


def cluster_levels(highs: list[float], lows: list[float], tolerance_pct: float = 0.25) -> list[Level]:
    points = [(p, "topo") for p in highs] + [(p, "fundo") for p in lows]
    points.sort()
    levels: list[Level] = []
    group: list[tuple[float, str]] = []

    def flush() -> None:
        if not group:
            return
        kinds = {k for _, k in group}
        price = sum(p for p, _ in group) / len(group)
        levels.append(Level(price=price, touches=len(group), kind=kinds.pop() if len(kinds) == 1 else "misto"))

    for p, k in points:
        if group and (p - group[0][0]) / group[0][0] * 100 > tolerance_pct:
            flush()
            group = []
        group.append((p, k))
    flush()
    return levels


def find_levels(candles: Sequence[Candle], tolerance_pct: float = 0.25) -> list[Level]:
    closed = [c for c in candles if c.closed]
    h, l = pivots(closed)
    return cluster_levels(h, l, tolerance_pct)


def nearest_resistance(levels: list[Level], price: float, min_gap_pct: float = 0.05) -> Level | None:
    above = [lv for lv in levels if lv.price > price * (1 + min_gap_pct / 100)]
    return min(above, key=lambda lv: lv.price) if above else None


def nearest_support(levels: list[Level], price: float, min_gap_pct: float = 0.05) -> Level | None:
    below = [lv for lv in levels if lv.price < price * (1 - min_gap_pct / 100)]
    return max(below, key=lambda lv: lv.price) if below else None


def swing_low(candles: Sequence[Candle], lookback: int = 6) -> float | None:
    closed = [c for c in candles if c.closed][-lookback:]
    return min(c.low for c in closed) if closed else None
