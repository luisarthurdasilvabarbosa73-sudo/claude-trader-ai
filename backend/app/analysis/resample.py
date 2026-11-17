"""Agregação de candles de 1m em timeframes maiores (usado no backtest)."""
from __future__ import annotations

from typing import Sequence

from ..domain import TF_MS, Candle


def aggregate(candles_1m: Sequence[Candle], tf: str, until_index: int | None = None) -> list[Candle]:
    """Agrega candles de 1m. O último candle fica `closed=False` se o período não terminou."""
    size = TF_MS[tf]
    src = candles_1m if until_index is None else candles_1m[: until_index + 1]
    out: list[Candle] = []
    cur: Candle | None = None
    for c in src:
        bucket = c.open_time // size * size
        if cur is None or bucket != cur.open_time:
            if cur is not None:
                out.append(cur)
            cur = Candle(open_time=bucket, open=c.open, high=c.high, low=c.low, close=c.close,
                         volume=c.volume, close_time=bucket + size - 1, quote_volume=c.quote_volume,
                         trades=c.trades, closed=False)
        else:
            cur.high = max(cur.high, c.high)
            cur.low = min(cur.low, c.low)
            cur.close = c.close
            cur.volume += c.volume
            cur.quote_volume += c.quote_volume
            cur.trades += c.trades
        cur.closed = c.closed and (c.open_time + 60_000 >= bucket + size)
    if cur is not None:
        out.append(cur)
    for c in out[:-1]:
        c.closed = True
    return out


class IncrementalAggregator:
    """Mantém séries agregadas atualizadas candle a candle (O(1) por candle)."""

    def __init__(self, tf: str, max_len: int = 600):
        self.tf = tf
        self.size = TF_MS[tf]
        self.max_len = max_len
        self.series: list[Candle] = []

    def add(self, c: Candle) -> None:
        bucket = c.open_time // self.size * self.size
        if not self.series or self.series[-1].open_time != bucket:
            if self.series:
                self.series[-1].closed = True
            self.series.append(Candle(open_time=bucket, open=c.open, high=c.high, low=c.low, close=c.close,
                                      volume=c.volume, close_time=bucket + self.size - 1,
                                      quote_volume=c.quote_volume, trades=c.trades, closed=False))
            if len(self.series) > self.max_len:
                del self.series[0]
        else:
            last = self.series[-1]
            last.high = max(last.high, c.high)
            last.low = min(last.low, c.low)
            last.close = c.close
            last.volume += c.volume
            last.quote_volume += c.quote_volume
            last.trades += c.trades
        if c.open_time + 60_000 >= bucket + self.size:
            self.series[-1].closed = True
