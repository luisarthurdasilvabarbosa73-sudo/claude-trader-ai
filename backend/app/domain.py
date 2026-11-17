"""Modelos de domínio compartilhados por todo o sistema.

Regra de projeto: preços de análise usam float; quantidades, saldos e
valores financeiros usam Decimal (evita erros de arredondamento em ordens).
"""
from __future__ import annotations

from dataclasses import asdict, dataclass, field
from decimal import ROUND_DOWN, Decimal
from enum import Enum
from typing import Any


def D(value: Any) -> Decimal:
    """Converte para Decimal sem herdar imprecisão de float."""
    if isinstance(value, Decimal):
        return value
    return Decimal(str(value))


ZERO = Decimal("0")


class Mode(str, Enum):
    SIMULACAO = "SIMULACAO"
    TESTNET = "TESTNET"
    REAL = "REAL"


class BotStatus(str, Enum):
    PARADO = "PARADO"          # análise roda, nenhuma entrada nova; posições protegidas
    RODANDO = "RODANDO"        # autônomo: pode abrir operações se tudo permitir
    PAUSADO = "PAUSADO"        # pausa automática do sistema de risco (com motivo)
    EMERGENCIA = "EMERGENCIA"  # tudo zerado, nada opera até liberação manual


TIMEFRAMES: tuple[str, ...] = ("1m", "5m", "15m", "1h")
TF_MS: dict[str, int] = {"1m": 60_000, "5m": 300_000, "15m": 900_000, "1h": 3_600_000}


@dataclass(slots=True)
class Candle:
    open_time: int  # ms epoch
    open: float
    high: float
    low: float
    close: float
    volume: float
    close_time: int
    quote_volume: float = 0.0
    trades: int = 0
    closed: bool = True

    def to_dict(self) -> dict[str, Any]:
        return {
            "t": self.open_time,
            "o": self.open,
            "h": self.high,
            "l": self.low,
            "c": self.close,
            "v": self.volume,
            "closed": self.closed,
        }


@dataclass(slots=True)
class Book:
    """Melhor oferta de compra (bid) e venda (ask) — o spread real."""

    bid: float
    ask: float
    ts: float  # epoch em segundos de quando o dado foi recebido

    @property
    def mid(self) -> float:
        return (self.bid + self.ask) / 2

    @property
    def spread_pct(self) -> float:
        if self.mid <= 0:
            return 999.0
        return (self.ask - self.bid) / self.mid * 100


@dataclass
class Fill:
    """Resultado de uma execução (simulada ou real)."""

    client_order_id: str
    symbol: str
    side: str  # BUY | SELL
    qty: Decimal  # quantidade executada (base)
    price: Decimal  # preço médio
    quote_qty: Decimal  # qty * price
    fee: Decimal
    fee_asset: str
    fee_quote: Decimal  # taxa convertida para a moeda de cotação
    ts: float
    mode: str
    reference_price: Decimal = ZERO  # bid/ask no momento (para medir slippage)

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        for k, v in d.items():
            if isinstance(v, Decimal):
                d[k] = str(v)
        return d


@dataclass
class Position:
    id: int | None
    symbol: str
    mode: str
    status: str  # ABERTA | FECHADA
    entry_time: float
    entry_price: Decimal
    qty: Decimal  # quantidade em carteira (já descontada a taxa da compra)
    cost_quote: Decimal  # total gasto na compra (moeda de cotação)
    stop_price: Decimal
    initial_stop: Decimal
    take_profit: Decimal
    risk_quote: Decimal  # perda máxima planejada (inclui taxas)
    atr_at_entry: float
    score: float
    strategy: str
    entry_order_id: str
    fees_quote: Decimal = ZERO
    highest_price: Decimal = ZERO
    breakeven_done: bool = False
    exit_time: float | None = None
    exit_price: Decimal | None = None
    exit_reason: str | None = None
    exit_order_id: str | None = None
    proceeds_quote: Decimal | None = None
    pnl_quote: Decimal | None = None
    pnl_pct: float | None = None
    r_multiple: float | None = None
    notes: list[str] = field(default_factory=list)

    @property
    def is_open(self) -> bool:
        return self.status == "ABERTA"

    def unrealized_pnl(self, bid: float, fee_rate: Decimal) -> Decimal:
        value = self.qty * D(bid) * (Decimal(1) - fee_rate)
        return value - self.cost_quote

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        for k, v in list(d.items()):
            if isinstance(v, Decimal):
                d[k] = str(v)
        return d


def floor_to_step(value: Decimal, step: Decimal) -> Decimal:
    if step <= 0:
        return value
    return (value / step).to_integral_value(rounding=ROUND_DOWN) * step
