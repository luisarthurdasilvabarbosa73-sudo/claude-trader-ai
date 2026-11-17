"""PAPER TRADING: execução simulada com dados reais de mercado.

Modelo de execução (conservador, igual ao comportamento real da Binance):
- Compra a mercado preenche no ASK (melhor oferta de venda) + slippage.
- Venda a mercado preenche no BID (melhor oferta de compra) - slippage.
  => O spread real é pago em toda operação.
- Taxa da compra é descontada do ativo recebido (como na Binance sem BNB);
  taxa da venda é descontada da moeda de cotação recebida.
- Quantidades arredondadas para BAIXO no stepSize; sobras ("poeira") ficam
  na carteira, exatamente como acontece na conta real.
- Ordens que violariam filtros (ex.: valor mínimo) são REJEITADAS.
- client_order_id repetido devolve a mesma execução (idempotência).

Este módulo não importa nada de credenciais nem do cliente assinado.
"""
from __future__ import annotations

from decimal import Decimal

from ..binance.filters import SymbolFilters
from ..db import Repository
from ..domain import Book, D, Fill, Mode
from .base import Broker, OrderRejected

STATE_KEY = "paper_account"


class PaperBroker(Broker):
    mode = Mode.SIMULACAO.value
    is_real = False

    def __init__(self, repo: Repository, fee_rate: float, slippage_pct: float):
        self.repo = repo
        self.fee_rate = D(fee_rate)
        self.slippage = D(slippage_pct) / 100
        state = repo.kv_get(STATE_KEY) or {}
        self._balances: dict[str, Decimal] = {k: D(v) for k, v in state.get("balances", {}).items()}
        self.meta: dict = state.get("meta", {})

    # ------------------------------------------------------------------
    @property
    def initialized(self) -> bool:
        return bool(self.meta.get("initialized"))

    def initialize(self, quote_asset: str, amount: Decimal, meta: dict) -> None:
        self._balances = {quote_asset: D(amount)}
        self.meta = {"initialized": True, **meta}
        self._persist()

    def reload(self) -> None:
        """Recarrega saldos do banco (usado após rollback de transação)."""
        state = self.repo.kv_get(STATE_KEY) or {}
        self._balances = {k: D(v) for k, v in state.get("balances", {}).items()}
        self.meta = state.get("meta", {})

    def reset(self) -> None:
        self._balances = {}
        self.meta = {}
        self._persist()

    def update_costs(self, fee_rate: float, slippage_pct: float) -> None:
        self.fee_rate = D(fee_rate)
        self.slippage = D(slippage_pct) / 100

    def _persist(self, balances: dict[str, Decimal] | None = None) -> None:
        bal = self._balances if balances is None else balances
        self.repo.kv_set(STATE_KEY, {
            "balances": {k: str(v) for k, v in bal.items() if v != 0},
            "meta": self.meta,
        })

    def balances(self) -> dict[str, Decimal]:
        return dict(self._balances)

    # ------------------------------------------------------------------
    def market_buy(self, symbol: str, qty: Decimal, book: Book, filters: SymbolFilters,
                   client_order_id: str, now: float) -> Fill:
        existing = self.repo.get_order(client_order_id)
        if existing:
            return existing
        qty = D(qty)
        ref = D(book.ask)
        price = ref * (1 + self.slippage)
        errors = filters.validate_order("BUY", qty, price, market=True)
        if errors:
            raise OrderRejected("; ".join(errors))
        cost = qty * price
        quote, base = filters.quote_asset, filters.base_asset
        if cost > self._balances.get(quote, D(0)):
            raise OrderRejected(
                f"Saldo insuficiente: necessário {cost:.6f} {quote}, disponível {self._balances.get(quote, D(0)):.6f}")
        fee = qty * self.fee_rate
        new = dict(self._balances)
        new[quote] = new.get(quote, D(0)) - cost
        new[base] = new.get(base, D(0)) + qty - fee
        fill = Fill(client_order_id=client_order_id, symbol=symbol, side="BUY", qty=qty, price=price,
                    quote_qty=cost, fee=fee, fee_asset=base, fee_quote=fee * price, ts=now,
                    mode=self.mode, reference_price=ref)
        with self.repo.transaction():
            self.repo.insert_order(fill)
            self._persist(new)
        self._balances = new
        return fill

    def market_sell(self, symbol: str, qty: Decimal, book: Book, filters: SymbolFilters,
                    client_order_id: str, now: float) -> Fill:
        existing = self.repo.get_order(client_order_id)
        if existing:
            return existing
        base, quote = filters.base_asset, filters.quote_asset
        held = self._balances.get(base, D(0))
        qty = filters.round_qty(min(D(qty), held))
        ref = D(book.bid)
        price = ref * (1 - self.slippage)
        errors = filters.validate_order("SELL", qty, price, market=True)
        if errors:
            raise OrderRejected("; ".join(errors))
        proceeds = qty * price
        fee = proceeds * self.fee_rate
        new = dict(self._balances)
        new[base] = held - qty
        new[quote] = new.get(quote, D(0)) + proceeds - fee
        fill = Fill(client_order_id=client_order_id, symbol=symbol, side="SELL", qty=qty, price=price,
                    quote_qty=proceeds, fee=fee, fee_asset=quote, fee_quote=fee, ts=now,
                    mode=self.mode, reference_price=ref)
        with self.repo.transaction():
            self.repo.insert_order(fill)
            self._persist(new)
        self._balances = new
        return fill
