"""Conexão Binance: assinatura, erros HTTP, WebSocket com reconexão e serviço de dados.

Sem rede: as respostas da Binance são simuladas com o formato oficial da API.
"""
import asyncio
import json

import pytest
import requests

from app.binance.market_data import BinanceMarketData, CandleStore
from app.binance.rest import (BinanceRest, GeoBlockedError, RateLimitError, UnknownOrderStatusError, parse_kline,
                              sign)
from app.binance.websocket import StreamClient
from app.domain import Candle

from .test_filters_capital import EXCHANGE_INFO_BTC


class FakeResp:
    def __init__(self, status=200, data=None, headers=None):
        self.status_code = status
        self._data = data
        self.headers = headers or {}

    def json(self):
        if self._data is None:
            raise ValueError("sem json")
        return self._data


class FakeSession:
    def __init__(self, routes):
        self.routes = routes
        self.calls = []

    def request(self, method, url, headers=None, timeout=None):
        self.calls.append((method, url, headers or {}))
        for prefix, resp in self.routes.items():
            if prefix in url:
                if isinstance(resp, Exception):
                    raise resp
                return resp(url) if callable(resp) else resp
        return FakeResp(404, {"code": -1, "msg": "not found"})


def kline_row(t, o=100, h=101, l=99, c=100.5, v=10):
    return [t, str(o), str(h), str(l), str(c), str(v), t + 59_999, str(v * c), 5, "1", "1", "0"]


def test_hmac_signature_matches_official_binance_example():
    # Exemplo da documentação oficial da Binance (SIGNED endpoint, HMAC SHA256)
    secret = "NhqPtmdSJYdKjVHjA7PZj4Mge3R5YNiP1e3UZjInClVN65XAbvqqM6A7H5fATj0j"
    query = ("symbol=LTCBTC&side=BUY&type=LIMIT&timeInForce=GTC&quantity=1&price=0.1"
             "&recvWindow=5000&timestamp=1499827319559")
    assert sign(query, secret) == "c8db56825ae71d6d79447849e617115f4a920fa2acdcab2b053c4b2838bd6b71"


def test_signed_request_has_key_header_and_signature():
    sess = FakeSession({"/api/v3/account": FakeResp(200, {"balances": []})})
    rest = BinanceRest("https://testnet.binance.vision", "KEY123", "SECRET", session=sess, clock=lambda: 1000.0)
    rest.account()
    method, url, headers = sess.calls[0]
    assert headers["X-MBX-APIKEY"] == "KEY123"
    assert "timestamp=1000000" in url and "signature=" in url
    assert "SECRET" not in url and "SECRET" not in repr(rest) and "KEY123" not in repr(rest)


def test_public_endpoints_parse():
    now_ms = 1_700_000_100_000
    rows = [kline_row(1_700_000_000_000), kline_row(1_700_000_060_000)]
    sess = FakeSession({
        "/api/v3/klines": FakeResp(200, rows, {"X-MBX-USED-WEIGHT-1M": "12"}),
        "/api/v3/exchangeInfo": FakeResp(200, {"symbols": [EXCHANGE_INFO_BTC]}),
        "/api/v3/ticker/bookTicker": FakeResp(200, [{"symbol": "BTCUSDT", "bidPrice": "100.0", "askPrice": "100.1"}]),
    })
    rest = BinanceRest("https://data-api.binance.vision", session=sess, clock=lambda: now_ms / 1000)
    ks = rest.klines("BTCUSDT", "1m", 2)
    assert len(ks) == 2 and ks[0].closed and not ks[1].closed  # último ainda aberto
    assert rest.used_weight_1m == 12
    assert rest.exchange_info(["BTCUSDT"])["symbols"][0]["symbol"] == "BTCUSDT"
    assert rest.book_tickers(["BTCUSDT"]) == {"BTCUSDT": (100.0, 100.1)}


def test_geo_block_rate_limit_and_unknown_order_status():
    rest = BinanceRest("https://api", "k", "s", session=FakeSession({"/ping": FakeResp(451, {})}))
    with pytest.raises(GeoBlockedError, match="localização"):
        rest.ping()
    rest = BinanceRest("https://api", "k", "s", session=FakeSession({"/ping": FakeResp(429, {}, {"Retry-After": "30"})}),
                       clock=lambda: 100.0)
    with pytest.raises(RateLimitError):
        rest.ping()
    assert rest.banned_until == 130.0
    with pytest.raises(RateLimitError):
        rest.ping()  # bloqueado localmente, nem chega a chamar a Binance
    rest = BinanceRest("https://api", "k", "s", session=FakeSession({"/api/v3/order": FakeResp(503, None)}))
    with pytest.raises(UnknownOrderStatusError):
        rest.new_market_order("BTCUSDT", "BUY", "cid", quantity="0.001")
    rest = BinanceRest("https://api", "k", "s",
                       session=FakeSession({"/api/v3/order": requests.ConnectionError("queda")}))
    with pytest.raises(UnknownOrderStatusError):
        rest.new_market_order("BTCUSDT", "BUY", "cid", quantity="0.001")


def test_candle_store_dedupes_and_closes_previous():
    st = CandleStore()
    st.upsert("X", "1m", Candle(0, 1, 1, 1, 1, 1, 59_999, closed=False))
    st.upsert("X", "1m", Candle(0, 1, 2, 1, 2, 2, 59_999, closed=False))  # atualização do mesmo candle
    st.upsert("X", "1m", Candle(60_000, 2, 2, 2, 2, 1, 119_999, closed=False))
    s = st.get("X", "1m")
    assert len(s) == 2 and s[0].close == 2 and s[0].closed and not s[1].closed
    st.merge("X", "1m", [Candle(0, 1, 2, 1, 2, 2, 59_999), Candle(60_000, 2, 3, 2, 3, 1, 119_999)])
    assert len(st.get("X", "1m")) == 2


def test_market_data_handles_ws_messages():
    md = BinanceMarketData(("BTCUSDT",), "USDT", "USDTBRL", BinanceRest("https://x"), "wss://x", clock=lambda: 5.0)
    md.handle_message({"stream": "btcusdt@kline_1m", "data": {"e": "kline", "s": "BTCUSDT", "k": {
        "t": 0, "T": 59_999, "i": "1m", "o": "1", "h": "2", "l": "0.5", "c": "1.5", "v": "3", "q": "4", "n": 2,
        "x": True}}})
    md.handle_message({"stream": "btcusdt@bookTicker",
                       "data": {"u": 1, "s": "BTCUSDT", "b": "1.49", "B": "1", "a": "1.51", "A": "1"}})
    assert md.get_candles("BTCUSDT", "1m")[0].close == 1.5
    assert md.get_book("BTCUSDT").bid == 1.49 and md.get_book("BTCUSDT").ts == 5.0
    url = md.stream_url()
    assert "btcusdt@kline_1h" in url and "usdtbrl@bookTicker" in url


class FakeWS:
    def __init__(self, script):
        self.script = list(script)

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False

    async def recv(self):
        if not self.script:
            await asyncio.sleep(10)  # silêncio: deve disparar o watchdog
        item = self.script.pop(0)
        if isinstance(item, Exception):
            raise item
        return json.dumps(item)


def test_websocket_reconnects_with_backoff_and_resyncs():
    received, sleeps, resyncs = [], [], []
    connections = [
        FakeWS([{"n": 1}, {"n": 2}, ConnectionError("queda de rede")]),
        FakeWS([]),  # conexão zumbi: nenhuma mensagem
        FakeWS([{"n": 3}]),
    ]
    client = None

    def connect(url):
        if not connections:
            client.stop()
            return FakeWS([ConnectionError("fim")])
        return connections.pop(0)

    async def fake_sleep(d):
        sleeps.append(d)

    async def on_reconnect():
        resyncs.append(True)

    client = StreamClient("wss://test", lambda m: received.append(m["n"]), on_reconnect, connect=connect,
                          idle_timeout=0.05, sleep=fake_sleep)

    async def main():
        await asyncio.wait_for(client.run(), timeout=5)

    asyncio.run(main())
    assert received == [1, 2, 3]
    assert client.reconnects >= 3
    assert len(resyncs) >= 2  # ressincroniza via REST após cada reconexão
    assert sleeps[0] < sleeps[1] * 1.5 + 1  # backoff crescente (com jitter)
    assert client.health()["connected"] is False


def test_market_data_start_bootstraps_and_reports_geoblock(monkeypatch):
    now_ms = 1_700_000_100_000
    calls = {"n": 0}

    def exchange_info(url):
        calls["n"] += 1
        if calls["n"] == 1:
            return FakeResp(451, {})
        usdtbrl = dict(EXCHANGE_INFO_BTC, symbol="USDTBRL", baseAsset="USDT", quoteAsset="BRL")
        return FakeResp(200, {"symbols": [EXCHANGE_INFO_BTC, usdtbrl]})

    sess = FakeSession({
        "/api/v3/exchangeInfo": exchange_info,
        "/api/v3/klines": FakeResp(200, [kline_row(1_700_000_000_000)]),
        "/api/v3/ticker/bookTicker": FakeResp(200, [{"symbol": "BTCUSDT", "bidPrice": "100", "askPrice": "100.1"},
                                                    {"symbol": "USDTBRL", "bidPrice": "5.4", "askPrice": "5.41"}]),
    })
    rest = BinanceRest("https://data-api.binance.vision", session=sess, clock=lambda: now_ms / 1000)
    md = BinanceMarketData(("BTCUSDT",), "USDT", "USDTBRL", rest, "wss://x", connect=lambda u: FakeWS([]),
                           clock=lambda: now_ms / 1000)
    errors = []
    real_sleep = asyncio.sleep

    async def fast_sleep(d):
        if md.fatal_error:
            errors.append(md.fatal_error)
        await real_sleep(0)

    monkeypatch.setattr("app.binance.market_data.asyncio.sleep", fast_sleep)

    async def main():
        await md.start()
        await md.stop()

    asyncio.run(main())
    assert errors and "451" in errors[0]
    assert md.ready and md.fatal_error is None
    assert "BTCUSDT" in md.filters and md.get_book("USDTBRL").ask == 5.41
    assert md.get_candles("BTCUSDT", "1h")


def test_parse_kline_closed_flag():
    c = parse_kline(kline_row(0), now_ms=30_000)
    assert not c.closed
    assert parse_kline(kline_row(0), now_ms=60_000).closed
