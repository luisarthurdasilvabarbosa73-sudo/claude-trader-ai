"""Interface de execução. Simulação e execução real são classes separadas."""
from __future__ import annotations

from abc import ABC, abstractmethod
from decimal import Decimal

from ..binance.filters import SymbolFilters
from ..domain import Book, Fill


class OrderRejected(Exception):
    """A ordem foi recusada (pelos filtros, saldo ou pela corretora)."""


class ModeLockedError(Exception):
    """Tentativa de usar um modo ainda bloqueado."""


class Broker(ABC):
    mode: str = ""
    is_real: bool = False

    @abstractmethod
    def balances(self) -> dict[str, Decimal]: ...

    @abstractmethod
    def market_buy(self, symbol: str, qty: Decimal, book: Book, filters: SymbolFilters,
                   client_order_id: str, now: float) -> Fill: ...

    @abstractmethod
    def market_sell(self, symbol: str, qty: Decimal, book: Book, filters: SymbolFilters,
                    client_order_id: str, now: float) -> Fill: ...
