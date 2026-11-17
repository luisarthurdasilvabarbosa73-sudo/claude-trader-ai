"""DADOS SINTÉTICOS — exclusivamente para testes automatizados e desenvolvimento.

Nunca são apresentados como mercado real: a fonte se identifica como
`synthetic`, o app exibe um aviso vermelho e config.py proíbe esta fonte
quando APP_ENV=production.
"""
from __future__ import annotations

import asyncio
import math
import random
import time
from decimal import Decimal
from typing import Any, Sequence

from ..analysis.resample import IncrementalAggregator
from ..binance.filters import SymbolFilters
from ..binance.market_data import MarketData
from ..domain import TIMEFRAMES, Book, Candle


def make_filters(symbol: str, base: str, quote: str, tick: str = "0.01", step: str = "0.00001",
                 min_qty: str = "0.00001", min_notional: str = "5") -> SymbolFilters:
    return SymbolFilters.from_exchange_info({
        "symbol": symbol, "baseAsset": base, "quoteAsset": quote, "status": "TRADING",
        "isSpotTradingAllowed": True, "orderTypes": ["LIMIT", "MARKET"],
        "filters": [
            {"filterType": "PRICE_FILTER", "minPrice": tick, "maxPrice": "1000000", "tickSize": tick},
            {"filterType": "LOT_SIZE", "minQty": min_qty, "maxQty": "9000", "stepSize": step},
            {"filterType": "MARKET_LOT_SIZE", "minQty": "0", "maxQty": "100", "stepSize": "0"},
            {"filterType": "NOTIONAL", "minNotional": min_notional, "applyMinToMarket": True,
             "maxNotional": "9000000", "applyMaxToMarket": False, "avgPriceMins": 5},
        ],
    })


def generate_1m(n: int, start_price: float = 100.0, seed: int = 1, start_ms: int = 1_700_000_000_000,
                regimes: Sequence[tuple[int, float, float]] | None = None, base_volume: float = 50.0) -> list[Candle]:
    """Passeio aleatório geométrico com regimes (barras, deriva por barra, volatilidade por barra)."""
    rnd = random.Random(seed)
    regimes = regimes or [(n, 0.0, 0.0012)]
    plan: list[tuple[float, float]] = []
    for bars, drift, vol in regimes:
        plan += [(drift, vol)] * bars
    while len(plan) < n:
        plan.append(plan[-1])
    start_ms = start_ms // 60_000 * 60_000
    out: list[Candle] = []
    price = start_price
    for i in range(n):
        drift, vol = plan[i]
        o = price
        c = o * math.exp(drift + vol * rnd.gauss(0, 1))
        h = max(o, c) * (1 + abs(rnd.gauss(0, 1)) * vol * 0.6)
        l = min(o, c) * (1 - abs(rnd.gauss(0, 1)) * vol * 0.6)
        v = base_volume * math.exp(rnd.gauss(0, 0.5))
        t = start_ms + i * 60_000
        out.append(Candle(t, o, h, l, c, v, t + 59_999, v * c, int(v), True))
        price = c
    return out


class SyntheticMarket(MarketData):
    source_name = "synthetic"
    is_synthetic = True

    def __init__(self, series: dict[str, list[Candle]], quote_asset: str = "USDT",
                 brl_rate_symbol: str | None = "USDTBRL", brl_rate: float = 5.40,
                 spread_pct: float = 0.02, filters: dict[str, SymbolFilters] | None = None):
        super().__init__(tuple(series), quote_asset, brl_rate_symbol)
        self.series = series
        self.spread_pct = spread_pct
        self.brl_rate = brl_rate
        self.cursor = -1
        self.aggs = {s: {tf: IncrementalAggregator(tf) for tf in TIMEFRAMES} for s in series}
        for s in series:
            base = s[: -len(quote_asset)]
            self.filters[s] = (filters or {}).get(s) or make_filters(s, base, quote_asset)
        if self.brl_rate_symbol:
            self.filters[self.brl_rate_symbol] = make_filters(self.brl_rate_symbol, quote_asset, "BRL",
                                                              tick="0.001", step="0.1", min_notional="10")
        self._task: asyncio.Task[Any] | None = None
        self.virtual_now = 0.0

    def _set_book(self, symbol: str, price: float, now: float) -> None:
        half = self.spread_pct / 200
        self.books[symbol] = Book(bid=price * (1 - half), ask=price * (1 + half), ts=now)

    def advance(self, steps: int = 1) -> float:
        """Avança candles de 1m e retorna o 'agora' virtual (fim do candle)."""
        for _ in range(steps):
            self.cursor += 1
            for s, series in self.series.items():
                c = series[self.cursor]
                for tf in TIMEFRAMES:
                    self.aggs[s][tf].add(Candle(c.open_time, c.open, c.high, c.low, c.close, c.volume,
                                                c.close_time, c.quote_volume, c.trades, True))
                    self.store._data[(s, tf)] = self.aggs[s][tf].series
        first = next(iter(self.series.values()))
        now = first[self.cursor].close_time / 1000 + 0.5
        self.virtual_now = now
        for s, series in self.series.items():
            self._set_book(s, series[self.cursor].close, now)
        if self.brl_rate_symbol:
            self._set_book(self.brl_rate_symbol, self.brl_rate, now)
        return now

    def set_price(self, symbol: str, bid: float, ask: float, now: float) -> None:
        self.books[symbol] = Book(bid=bid, ask=ask, ts=now)

    async def start(self) -> None:  # modo dev: avanço acelerado
        pass

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()


class VirtualClock:
    def __init__(self, market: SyntheticMarket):
        self.market = market

    def __call__(self) -> float:
        return self.market.virtual_now or time.time()


async def run_accelerated(market: SyntheticMarket, seconds_per_candle: float = 2.0) -> None:
    total = len(next(iter(market.series.values())))
    while market.cursor < total - 1:
        await asyncio.sleep(seconds_per_candle)
        market.advance()
