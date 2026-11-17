"""Cliente REST da API oficial da Binance Spot.

- Endpoints públicos (dados de mercado) usam https://data-api.binance.vision,
  domínio oficial da Binance só para dados públicos.
- Endpoints assinados (saldo/ordens) só são usados nas etapas TESTNET/REAL e
  exigem chave com permissão "Spot Trading" — NUNCA saque/transferência.
"""
from __future__ import annotations

import hashlib
import hmac
import logging
import time
from typing import Any, Callable
from urllib.parse import urlencode

import requests

from ..domain import Candle

log = logging.getLogger("binance.rest")


class BinanceError(Exception):
    def __init__(self, message: str, status: int = 0, code: int | None = None):
        super().__init__(message)
        self.status = status
        self.code = code


class GeoBlockedError(BinanceError):
    """HTTP 451: a Binance bloqueia o IP do servidor (ex.: servidores nos EUA)."""


class RateLimitError(BinanceError):
    def __init__(self, message: str, status: int, retry_after: float):
        super().__init__(message, status)
        self.retry_after = retry_after


class UnknownOrderStatusError(BinanceError):
    """HTTP 5xx em ordem: a execução pode ter acontecido. Consultar antes de repetir."""


def sign(query: str, secret: str) -> str:
    return hmac.new(secret.encode(), query.encode(), hashlib.sha256).hexdigest()


def parse_kline(row: list[Any], now_ms: int | None = None) -> Candle:
    close_time = int(row[6])
    closed = True if now_ms is None else close_time < now_ms
    return Candle(
        open_time=int(row[0]), open=float(row[1]), high=float(row[2]), low=float(row[3]),
        close=float(row[4]), volume=float(row[5]), close_time=close_time,
        quote_volume=float(row[7]), trades=int(row[8]), closed=closed,
    )


class BinanceRest:
    def __init__(
        self,
        base_url: str,
        api_key: str | None = None,
        api_secret: str | None = None,
        session: Any | None = None,
        timeout: float = 10.0,
        clock: Callable[[], float] = time.time,
    ):
        self.base_url = base_url.rstrip("/")
        self._api_key = api_key
        self._api_secret = api_secret
        self.session = session or requests.Session()
        self.timeout = timeout
        self.clock = clock
        self.time_offset_ms = 0
        self.used_weight_1m = 0
        self.banned_until = 0.0

    def __repr__(self) -> str:  # nunca mostrar credenciais
        return f"BinanceRest(base_url={self.base_url!r}, signed={'sim' if self._api_key else 'não'})"

    # ------------------------------------------------------------------
    def _request(self, method: str, path: str, params: dict[str, Any] | None = None,
                 signed: bool = False, is_order: bool = False) -> Any:
        now = self.clock()
        if now < self.banned_until:
            raise RateLimitError("Aguardando fim do limite de requisições da Binance", 429,
                                 self.banned_until - now)
        params = {k: v for k, v in (params or {}).items() if v is not None}
        headers = {}
        if signed:
            if not self._api_key or not self._api_secret:
                raise BinanceError("Credenciais da Binance não configuradas no servidor")
            params["timestamp"] = int(now * 1000) + self.time_offset_ms
            params.setdefault("recvWindow", 5000)
            query = urlencode(params)
            params_str = f"{query}&signature={sign(query, self._api_secret)}"
            headers["X-MBX-APIKEY"] = self._api_key
        else:
            params_str = urlencode(params)
        url = f"{self.base_url}{path}"
        if params_str:
            url = f"{url}?{params_str}"
        try:
            resp = self.session.request(method, url, headers=headers, timeout=self.timeout)
        except requests.RequestException as exc:  # falha de rede
            if is_order:
                raise UnknownOrderStatusError(f"Falha de rede ao enviar ordem: {exc}") from exc
            raise BinanceError(f"Falha de conexão com a Binance: {exc}") from exc

        weight = resp.headers.get("X-MBX-USED-WEIGHT-1M") or resp.headers.get("x-mbx-used-weight-1m")
        if weight:
            try:
                self.used_weight_1m = int(weight)
            except ValueError:
                pass

        status = resp.status_code
        if status == 451:
            raise GeoBlockedError(
                "A Binance bloqueou o acesso a partir da localização deste servidor (HTTP 451). "
                "Use uma região de hospedagem permitida (ex.: Europa ou Singapura).", status)
        if status in (418, 429):
            retry = float(resp.headers.get("Retry-After", "60"))
            self.banned_until = self.clock() + retry
            raise RateLimitError(f"Limite de requisições da Binance atingido (HTTP {status})", status, retry)
        if status >= 500:
            if is_order:
                raise UnknownOrderStatusError(
                    f"Binance respondeu HTTP {status}; status da ordem DESCONHECIDO", status)
            raise BinanceError(f"Erro interno da Binance (HTTP {status})", status)
        try:
            data = resp.json()
        except ValueError as exc:
            raise BinanceError(f"Resposta inválida da Binance (HTTP {status})", status) from exc
        if status >= 400:
            code = data.get("code") if isinstance(data, dict) else None
            msg = data.get("msg") if isinstance(data, dict) else str(data)
            raise BinanceError(f"Binance recusou a requisição: {msg} (código {code})", status, code)
        return data

    # ------------------------------------------------------------ públicos
    def ping(self) -> bool:
        self._request("GET", "/api/v3/ping")
        return True

    def server_time(self) -> int:
        return int(self._request("GET", "/api/v3/time")["serverTime"])

    def sync_time(self) -> int:
        server = self.server_time()
        self.time_offset_ms = server - int(self.clock() * 1000)
        return self.time_offset_ms

    def exchange_info(self, symbols: list[str]) -> dict[str, Any]:
        import json
        return self._request("GET", "/api/v3/exchangeInfo",
                             {"symbols": json.dumps(symbols, separators=(",", ":"))})

    def klines(self, symbol: str, interval: str, limit: int = 300,
               start_time: int | None = None, end_time: int | None = None) -> list[Candle]:
        rows = self._request("GET", "/api/v3/klines", {
            "symbol": symbol, "interval": interval, "limit": limit,
            "startTime": start_time, "endTime": end_time,
        })
        now_ms = int(self.clock() * 1000)
        return [parse_kline(r, now_ms) for r in rows]

    def book_tickers(self, symbols: list[str]) -> dict[str, tuple[float, float]]:
        import json
        rows = self._request("GET", "/api/v3/ticker/bookTicker",
                             {"symbols": json.dumps(symbols, separators=(",", ":"))})
        return {r["symbol"]: (float(r["bidPrice"]), float(r["askPrice"])) for r in rows}

    # ----------------------------------------------- assinados (Etapa 9+)
    def account(self) -> dict[str, Any]:
        return self._request("GET", "/api/v3/account", {"omitZeroBalances": "true"}, signed=True)

    def api_restrictions(self) -> dict[str, Any]:
        """Somente conta real: confirma que a chave NÃO permite saque/transferência."""
        return self._request("GET", "/sapi/v1/account/apiRestrictions", signed=True)

    def new_market_order(self, symbol: str, side: str, client_order_id: str,
                         quantity: str | None = None, quote_order_qty: str | None = None) -> dict[str, Any]:
        if (quantity is None) == (quote_order_qty is None):
            raise ValueError("Informe quantity OU quote_order_qty")
        return self._request("POST", "/api/v3/order", {
            "symbol": symbol, "side": side, "type": "MARKET", "quantity": quantity,
            "quoteOrderQty": quote_order_qty, "newClientOrderId": client_order_id,
            "newOrderRespType": "FULL",
        }, signed=True, is_order=True)

    def query_order(self, symbol: str, client_order_id: str) -> dict[str, Any]:
        return self._request("GET", "/api/v3/order",
                             {"symbol": symbol, "origClientOrderId": client_order_id}, signed=True)

    def cancel_order(self, symbol: str, client_order_id: str) -> dict[str, Any]:
        return self._request("DELETE", "/api/v3/order",
                             {"symbol": symbol, "origClientOrderId": client_order_id}, signed=True)

    def open_orders(self, symbol: str | None = None) -> list[dict[str, Any]]:
        return self._request("GET", "/api/v3/openOrders", {"symbol": symbol}, signed=True)
