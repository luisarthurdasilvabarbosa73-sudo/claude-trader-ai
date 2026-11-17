"""Fixtures compartilhadas. Todos os dados aqui são SINTÉTICOS (testes)."""
from __future__ import annotations

from decimal import Decimal

import pytest

from app.analysis.strategy import Analysis, Gate
from app.config import Settings
from app.db import Repository
from app.engine.bot import TradingEngine
from app.testing.synthetic import SyntheticMarket, generate_1m, make_filters

N_HISTORY = 13_000


@pytest.fixture
def filters():
    return make_filters("BTCUSDT", "BTC", "USDT", tick="0.01", step="0.00001", min_qty="0.00001", min_notional="5")


@pytest.fixture
def repo(tmp_path):
    r = Repository(str(tmp_path / "test.db"))
    yield r
    r.close()


def make_market(n: int = N_HISTORY, warm: int = 12_800, seed: int = 4, symbols=("BTCUSDT",), **kw) -> SyntheticMarket:
    series = {s: generate_1m(n, 100.0, seed=seed + i, regimes=[(n, 0.00002, 0.0025)]) for i, s in enumerate(symbols)}
    m = SyntheticMarket(series, **kw)
    m.advance(warm)
    return m


@pytest.fixture
def market():
    return make_market()


def settings_for(market, path=":memory:", **kw) -> Settings:
    return Settings(app_env="test", symbols=tuple(market.symbols), database_path=path,
                    market_data_source="synthetic", **kw)


class StubStrategy:
    """Estratégia controlada pelo teste (para validar execução e risco isoladamente)."""

    def __init__(self):
        self.signal = False
        self.stop_pct = 1.0
        self.tp_pct = 3.0
        self.invalidate = None

    def evaluate(self, symbol, candles, book, now, fee_rate, slippage_pct, max_spread_pct, min_rr, min_score, fast=False):
        entry = book.ask if book else candles["1m"][-1].close
        gates = [Gate("teste", "Sinal de teste", self.signal, "stub")]
        return Analysis(
            symbol=symbol, ts=now, action="COMPRAR" if self.signal else "AGUARDAR", score=80 if self.signal else 0,
            min_score=min_score, gates=gates, components=[], reasons=["stub"], summary=f"stub {symbol}",
            entry=entry, stop=entry * (1 - self.stop_pct / 100), take_profit=entry * (1 + self.tp_pct / 100),
            rr_net=2.0, atr_5m=entry * 0.004, regime="ALTA", volatility="NORMAL",
        )

    def trend_invalidated(self, symbol, candles_15m, entry_time):
        return self.invalidate


@pytest.fixture
def stub():
    return StubStrategy()


@pytest.fixture
def engine(market, repo, stub):
    eng = TradingEngine(settings_for(market), repo, market, strategy=stub, clock=lambda: market.virtual_now)
    return eng


def next_candle(market, engine, steps: int = 1):
    now = 0.0
    for _ in range(steps):
        now = market.advance()
        engine.step(now)
    return now


D = Decimal
