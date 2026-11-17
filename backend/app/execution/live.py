"""Execução em conta Binance (TESTNET ou REAL) — BLOQUEADA nesta etapa.

Este arquivo é separado da simulação de propósito. A classe só pode ser
instanciada quando a trava correspondente em config.py for liberada:
- TESTNET_RELEASED: ETAPA 9 (após validação na Testnet oficial)
- REAL_RELEASED:    ETAPA 10 (somente com autorização explícita do proprietário)

Estado atual: implementação inicial NÃO validada contra a Binance. Antes de
liberar, a ETAPA 9 precisa testar: ordens, consulta após erro 5xx,
cancelamento, conciliação de saldo e ordens de proteção (stop) na corretora.
"""
from __future__ import annotations

from decimal import Decimal

from .. import config
from ..binance.filters import SymbolFilters
from ..binance.rest import BinanceRest, UnknownOrderStatusError
from ..domain import Book, D, Fill, Mode
from .base import Broker, ModeLockedError, OrderRejected


def assert_mode_released(mode: Mode) -> None:
    if mode == Mode.TESTNET and not config.TESTNET_RELEASED:
        raise ModeLockedError("Modo TESTNET bloqueado: será liberado na ETAPA 9, após os testes na Testnet.")
    if mode == Mode.REAL and not config.REAL_RELEASED:
        raise ModeLockedError("Modo REAL bloqueado: exige a ETAPA 10 e sua autorização explícita.")


class LiveBroker(Broker):
    is_real = True

    def __init__(self, mode: Mode, rest: BinanceRest):
        assert_mode_released(mode)
        if mode == Mode.SIMULACAO:
            raise ValueError("LiveBroker não executa simulação")
        self.mode = mode.value
        self.rest = rest
        self._balances: dict[str, Decimal] = {}

    def verify_key_permissions(self) -> None:
        """Recusa chaves com saque/transferência/margem/futuros habilitados (só conta real)."""
        if self.mode != Mode.REAL.value:
            return
        r = self.rest.api_restrictions()
        forbidden = [k for k in ("enableWithdrawals", "enableInternalTransfer", "permitsUniversalTransfer",
                                 "enableMargin", "enableFutures", "enableVanillaOptions") if r.get(k)]
        if forbidden:
            raise ModeLockedError("Chave da Binance com permissões proibidas: " + ", ".join(forbidden)
                                  + ". Crie uma chave apenas com 'Spot Trading'.")
        if not r.get("enableSpotAndMarginTrading"):
            raise ModeLockedError("Chave da Binance sem permissão de Spot Trading.")

    def refresh_balances(self) -> dict[str, Decimal]:
        acc = self.rest.account()
        self._balances = {b["asset"]: D(b["free"]) for b in acc.get("balances", []) if D(b["free"]) > 0}
        return dict(self._balances)

    def balances(self) -> dict[str, Decimal]:
        return dict(self._balances)

    def _parse(self, resp: dict, symbol: str, side: str, cid: str, now: float, ref: Decimal) -> Fill:
        qty = D(resp.get("executedQty", "0"))
        quote = D(resp.get("cummulativeQuoteQty", "0"))
        if qty <= 0:
            raise OrderRejected(f"Ordem {cid} não executada (status {resp.get('status')})")
        price = quote / qty
        fee = sum((D(f["commission"]) for f in resp.get("fills", [])), D(0))
        fee_asset = resp["fills"][0]["commissionAsset"] if resp.get("fills") else ""
        fee_quote = fee * price if fee_asset and not symbol.endswith(fee_asset) else fee
        return Fill(cid, symbol, side, qty, price, quote, fee, fee_asset, fee_quote, now, self.mode, ref)

    def _execute(self, symbol: str, side: str, qty: Decimal, cid: str, now: float, ref: Decimal) -> Fill:
        try:
            resp = self.rest.new_market_order(symbol, side, cid, quantity=str(qty))
        except UnknownOrderStatusError:
            resp = self.rest.query_order(symbol, cid)  # nunca reenviar sem consultar
        return self._parse(resp, symbol, side, cid, now, ref)

    def market_buy(self, symbol: str, qty: Decimal, book: Book, filters: SymbolFilters,
                   client_order_id: str, now: float) -> Fill:
        errors = filters.validate_order("BUY", qty, D(book.ask), market=True)
        if errors:
            raise OrderRejected("; ".join(errors))
        return self._execute(symbol, "BUY", qty, client_order_id, now, D(book.ask))

    def market_sell(self, symbol: str, qty: Decimal, book: Book, filters: SymbolFilters,
                    client_order_id: str, now: float) -> Fill:
        qty = filters.round_qty(qty)
        errors = filters.validate_order("SELL", qty, D(book.bid), market=True)
        if errors:
            raise OrderRejected("; ".join(errors))
        return self._execute(symbol, "SELL", qty, client_order_id, now, D(book.bid))
