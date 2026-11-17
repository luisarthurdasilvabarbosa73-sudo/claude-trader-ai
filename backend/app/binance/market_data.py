"""Serviço de dados de mercado em tempo real.

Fluxo: REST (histórico inicial + filtros) -> WebSocket (tempo real) ->
ressincronização periódica via REST (cura lacunas) -> fallback por REST
quando o WebSocket cai.
"""
from __future__ import annotations

import asyncio
import logging
import time
from abc import ABC, abstractmethod
from typing import Any, Callable

from ..domain import TF_MS, TIMEFRAMES, Book, Candle
from .filters import SymbolFilters
from .rest import BinanceError, BinanceRest, GeoBlockedError
from .websocket import ConnectFn, StreamClient

log = logging.getLogger("market")

MAX_CANDLES = 600


class CandleStore:
    """Mantém séries de candles por (símbolo, timeframe), sem duplicatas."""

    def __init__(self, max_len: int = MAX_CANDLES):
        self.max_len = max_len
        self._data: dict[tuple[str, str], list[Candle]] = {}

    def get(self, symbol: str, tf: str) -> list[Candle]:
        return self._data.get((symbol, tf), [])

    def upsert(self, symbol: str, tf: str, candle: Candle) -> bool:
        """Insere/atualiza. Retorna True se um candle foi FECHADO por este evento."""
        series = self._data.setdefault((symbol, tf), [])
        closed_event = False
        if not series or candle.open_time > series[-1].open_time:
            if series and not series[-1].closed:
                series[-1].closed = True  # o período anterior terminou
                closed_event = True
            series.append(candle)
        elif candle.open_time == series[-1].open_time:
            was_closed = series[-1].closed
            series[-1] = candle
            closed_event = candle.closed and not was_closed
        else:
            # candle antigo (ressincronização): substitui se existir
            for i in range(len(series) - 1, -1, -1):
                if series[i].open_time == candle.open_time:
                    series[i] = candle
                    break
                if series[i].open_time < candle.open_time:
                    series.insert(i + 1, candle)
                    break
        if len(series) > self.max_len:
            del series[: len(series) - self.max_len]
        return closed_event or candle.closed and series[-1] is candle

    def merge(self, symbol: str, tf: str, candles: list[Candle]) -> None:
        for c in sorted(candles, key=lambda x: x.open_time):
            self.upsert(symbol, tf, c)


class MarketData(ABC):
    """Interface comum: dados reais (Binance), sintéticos (testes) e históricos (backtest)."""

    source_name: str = "abstract"
    is_synthetic: bool = False

    def __init__(self, symbols: tuple[str, ...], quote_asset: str, brl_rate_symbol: str | None):
        self.symbols = symbols
        self.quote_asset = quote_asset
        self.brl_rate_symbol = brl_rate_symbol if quote_asset != "BRL" else None
        self.store = CandleStore()
        self.books: dict[str, Book] = {}
        self.filters: dict[str, SymbolFilters] = {}
        self.fatal_error: str | None = None
        self.listeners: list[Callable[[str, str, Candle], None]] = []

    def get_candles(self, symbol: str, tf: str) -> list[Candle]:
        return self.store.get(symbol, tf)

    def get_book(self, symbol: str) -> Book | None:
        return self.books.get(symbol)

    def get_filters(self, symbol: str) -> SymbolFilters | None:
        return self.filters.get(symbol)

    def brl_book(self) -> Book | None:
        return self.books.get(self.brl_rate_symbol) if self.brl_rate_symbol else None

    @abstractmethod
    async def start(self) -> None: ...

    @abstractmethod
    async def stop(self) -> None: ...

    def health(self, now: float) -> dict[str, Any]:
        ages = {s: round(now - b.ts, 1) for s, b in self.books.items()}
        return {"source": self.source_name, "synthetic": self.is_synthetic,
                "fatal_error": self.fatal_error, "book_age_s": ages}


class BinanceMarketData(MarketData):
    source_name = "binance"

    def __init__(
        self,
        symbols: tuple[str, ...],
        quote_asset: str,
        brl_rate_symbol: str | None,
        rest: BinanceRest,
        ws_base_url: str,
        connect: ConnectFn | None = None,
        clock: Callable[[], float] = time.time,
        bootstrap_limit: int = 300,
        resync_every_s: float = 600,
    ):
        super().__init__(symbols, quote_asset, brl_rate_symbol)
        self.rest = rest
        self.ws_base_url = ws_base_url.rstrip("/")
        self.clock = clock
        self.bootstrap_limit = bootstrap_limit
        self.resync_every_s = resync_every_s
        self._connect = connect
        self._tasks: list[asyncio.Task[Any]] = []
        self.stream: StreamClient | None = None
        self.ready = False
        self.last_resync = 0.0
        self.resync_count = 0

    # ------------------------------------------------------------------
    def stream_url(self) -> str:
        names = []
        for s in self.symbols:
            low = s.lower()
            names += [f"{low}@kline_{tf}" for tf in TIMEFRAMES]
            names.append(f"{low}@bookTicker")
        if self.brl_rate_symbol:
            names.append(f"{self.brl_rate_symbol.lower()}@bookTicker")
        return f"{self.ws_base_url}/stream?streams={'/'.join(names)}"

    async def _call(self, fn: Callable[..., Any], *args: Any, **kwargs: Any) -> Any:
        return await asyncio.to_thread(fn, *args, **kwargs)

    async def load_filters(self) -> None:
        wanted = list(self.symbols) + ([self.brl_rate_symbol] if self.brl_rate_symbol else [])
        info = await self._call(self.rest.exchange_info, wanted)
        for sym in info.get("symbols", []):
            self.filters[sym["symbol"]] = SymbolFilters.from_exchange_info(sym)
        missing = [s for s in wanted if s not in self.filters]
        if missing:
            raise BinanceError(f"Pares não encontrados na Binance: {', '.join(missing)}")

    async def bootstrap(self, limit: int | None = None) -> None:
        limit = limit or self.bootstrap_limit
        for symbol in self.symbols:
            for tf in TIMEFRAMES:
                candles = await self._call(self.rest.klines, symbol, tf, limit)
                self.store.merge(symbol, tf, candles)
        await self.refresh_books()
        self.last_resync = self.clock()
        self.resync_count += 1

    async def refresh_books(self) -> None:
        wanted = list(self.symbols) + ([self.brl_rate_symbol] if self.brl_rate_symbol else [])
        tickers = await self._call(self.rest.book_tickers, wanted)
        now = self.clock()
        for sym, (bid, ask) in tickers.items():
            if bid > 0 and ask > 0:
                self.books[sym] = Book(bid=bid, ask=ask, ts=now)

    async def resync(self) -> None:
        """Busca os candles mais recentes via REST (após reconexão ou periodicamente)."""
        try:
            await self.bootstrap(limit=60)
            log.info("Ressincronização REST concluída")
        except BinanceError as exc:
            log.warning("Falha na ressincronização: %s", exc)

    # ------------------------------------------------------------------
    def handle_message(self, payload: dict[str, Any]) -> None:
        data = payload.get("data", payload)
        if not isinstance(data, dict):
            return
        now = self.clock()
        if data.get("e") == "kline":
            k = data["k"]
            candle = Candle(
                open_time=int(k["t"]), open=float(k["o"]), high=float(k["h"]), low=float(k["l"]),
                close=float(k["c"]), volume=float(k["v"]), close_time=int(k["T"]),
                quote_volume=float(k.get("q", 0)), trades=int(k.get("n", 0)), closed=bool(k["x"]),
            )
            symbol, tf = data["s"], k["i"]
            if tf in TF_MS and symbol in self.symbols:
                self.store.upsert(symbol, tf, candle)
        elif "b" in data and "a" in data and "s" in data:  # bookTicker
            bid, ask = float(data["b"]), float(data["a"])
            if bid > 0 and ask > 0:
                self.books[data["s"]] = Book(bid=bid, ask=ask, ts=now)

    async def _maintenance_loop(self) -> None:
        """Ressincroniza periodicamente e assume via REST se o WebSocket cair."""
        while True:
            await asyncio.sleep(3)
            now = self.clock()
            try:
                ws_down = self.stream is None or not self.stream.connected
                if ws_down:
                    await self.refresh_books()  # fallback de preço via REST
                    for symbol in self.symbols:
                        self.store.merge(symbol, "1m", await self._call(self.rest.klines, symbol, "1m", 3))
                if now - self.last_resync >= self.resync_every_s:
                    await self.resync()
            except GeoBlockedError as exc:
                self.fatal_error = str(exc)
            except BinanceError as exc:
                log.warning("Manutenção de dados: %s", exc)

    async def start(self) -> None:
        while True:
            try:
                await self.load_filters()
                await self.bootstrap()
                self.fatal_error = None
                break
            except GeoBlockedError as exc:
                self.fatal_error = str(exc)
                log.error(self.fatal_error)
                await asyncio.sleep(300)
            except BinanceError as exc:
                self.fatal_error = f"Não foi possível carregar dados da Binance: {exc}"
                log.error(self.fatal_error)
                await asyncio.sleep(30)
        self.ready = True
        self.stream = StreamClient(self.stream_url(), self.handle_message, on_reconnect=self.resync,
                                   connect=self._connect, clock=self.clock)
        self._tasks = [asyncio.create_task(self.stream.run(), name="ws"),
                       asyncio.create_task(self._maintenance_loop(), name="market-maint")]

    async def stop(self) -> None:
        if self.stream:
            self.stream.stop()
        for t in self._tasks:
            t.cancel()
        for t in self._tasks:
            try:
                await t
            except (asyncio.CancelledError, Exception):
                pass
        self._tasks = []

    def health(self, now: float) -> dict[str, Any]:
        h = super().health(now)
        h["ready"] = self.ready
        h["websocket"] = self.stream.health(now) if self.stream else {"connected": False}
        h["rest_weight_1m"] = self.rest.used_weight_1m
        h["resyncs"] = self.resync_count
        return h
