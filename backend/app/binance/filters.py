"""Filtros reais de negociação da Binance (vindos de /api/v3/exchangeInfo).

A Binance rejeita ordens que violam estes filtros. O robô valida ANTES de
enviar (e o simulador rejeita exatamente como a corretora rejeitaria).
"""
from __future__ import annotations

from dataclasses import dataclass, field
from decimal import ROUND_CEILING, ROUND_DOWN, Decimal
from typing import Any

from ..domain import D, floor_to_step


@dataclass
class SymbolFilters:
    symbol: str
    base_asset: str
    quote_asset: str
    status: str = "TRADING"
    spot_allowed: bool = True
    order_types: tuple[str, ...] = ("LIMIT", "MARKET")
    tick_size: Decimal = Decimal("0.00000001")
    min_price: Decimal = Decimal("0")
    max_price: Decimal = Decimal("0")
    step_size: Decimal = Decimal("0.00000001")
    min_qty: Decimal = Decimal("0")
    max_qty: Decimal = Decimal("0")
    market_step_size: Decimal | None = None
    market_min_qty: Decimal | None = None
    market_max_qty: Decimal | None = None
    min_notional: Decimal = Decimal("0")
    apply_min_to_market: bool = True
    max_notional: Decimal | None = None
    apply_max_to_market: bool = False
    raw: dict[str, Any] = field(default_factory=dict, repr=False)

    # ------------------------------------------------------------------
    @classmethod
    def from_exchange_info(cls, info: dict[str, Any]) -> "SymbolFilters":
        f = cls(
            symbol=info["symbol"],
            base_asset=info["baseAsset"],
            quote_asset=info["quoteAsset"],
            status=info.get("status", "TRADING"),
            spot_allowed=bool(info.get("isSpotTradingAllowed", True)),
            order_types=tuple(info.get("orderTypes", ("LIMIT", "MARKET"))),
            raw=info,
        )
        for flt in info.get("filters", []):
            t = flt.get("filterType")
            if t == "PRICE_FILTER":
                f.tick_size = D(flt["tickSize"])
                f.min_price = D(flt["minPrice"])
                f.max_price = D(flt["maxPrice"])
            elif t == "LOT_SIZE":
                f.step_size = D(flt["stepSize"])
                f.min_qty = D(flt["minQty"])
                f.max_qty = D(flt["maxQty"])
            elif t == "MARKET_LOT_SIZE":
                step = D(flt["stepSize"])
                # stepSize 0 em MARKET_LOT_SIZE significa "use o LOT_SIZE"
                f.market_step_size = step if step > 0 else None
                f.market_min_qty = D(flt["minQty"])
                f.market_max_qty = D(flt["maxQty"]) if D(flt["maxQty"]) > 0 else None
            elif t == "NOTIONAL":
                f.min_notional = D(flt.get("minNotional", "0"))
                f.apply_min_to_market = bool(flt.get("applyMinToMarket", True))
                if flt.get("maxNotional") is not None:
                    f.max_notional = D(flt["maxNotional"])
                f.apply_max_to_market = bool(flt.get("applyMaxToMarket", False))
            elif t == "MIN_NOTIONAL":  # filtro legado
                f.min_notional = D(flt.get("minNotional", "0"))
                f.apply_min_to_market = bool(flt.get("applyToMarket", True))
        return f

    # ------------------------------------------------------------------
    def qty_step(self, market: bool = True) -> Decimal:
        if market and self.market_step_size:
            return max(self.market_step_size, self.step_size)
        return self.step_size

    def round_qty(self, qty: Decimal, market: bool = True) -> Decimal:
        """Arredonda SEMPRE para baixo (nunca gasta mais do que o calculado)."""
        return floor_to_step(D(qty), self.qty_step(market)).normalize() if qty > 0 else Decimal(0)

    def round_price(self, price: Decimal, up: bool = False) -> Decimal:
        price = D(price)
        if self.tick_size <= 0:
            return price
        rounding = ROUND_CEILING if up else ROUND_DOWN
        return ((price / self.tick_size).to_integral_value(rounding=rounding) * self.tick_size).normalize()

    def effective_min_notional(self, market: bool = True) -> Decimal:
        if market and not self.apply_min_to_market:
            return Decimal(0)
        return self.min_notional

    def validate_order(self, side: str, qty: Decimal, price: Decimal, market: bool = True) -> list[str]:
        """Retorna a lista de violações (vazia = ordem válida)."""
        errors: list[str] = []
        qty, price = D(qty), D(price)
        if self.status != "TRADING":
            errors.append(f"{self.symbol}: par não está em negociação (status {self.status})")
        if not self.spot_allowed:
            errors.append(f"{self.symbol}: negociação Spot não permitida")
        if market and "MARKET" not in self.order_types:
            errors.append(f"{self.symbol}: ordens a mercado não suportadas")
        if qty <= 0:
            errors.append("quantidade deve ser maior que zero")
            return errors
        min_qty = self.market_min_qty if (market and self.market_min_qty) else self.min_qty
        max_qty = self.market_max_qty if (market and self.market_max_qty) else self.max_qty
        if qty < min_qty:
            errors.append(f"LOT_SIZE: quantidade {qty} abaixo do mínimo {min_qty}")
        if max_qty and qty > max_qty:
            errors.append(f"LOT_SIZE: quantidade {qty} acima do máximo {max_qty}")
        step = self.qty_step(market)
        if step > 0 and (qty / step) % 1 != 0:
            errors.append(f"LOT_SIZE: quantidade {qty} não respeita o passo {step}")
        notional = qty * price
        min_n = self.effective_min_notional(market)
        if min_n and notional < min_n:
            errors.append(
                f"NOTIONAL: valor da ordem {notional:.4f} {self.quote_asset} abaixo do mínimo "
                f"{min_n} {self.quote_asset}"
            )
        if self.max_notional and (not market or self.apply_max_to_market) and notional > self.max_notional:
            errors.append(f"NOTIONAL: valor {notional} acima do máximo {self.max_notional}")
        if not market:
            if self.min_price and price < self.min_price:
                errors.append(f"PRICE_FILTER: preço {price} abaixo do mínimo {self.min_price}")
            if self.max_price and price > self.max_price:
                errors.append(f"PRICE_FILTER: preço {price} acima do máximo {self.max_price}")
            if self.tick_size > 0 and (price / self.tick_size) % 1 != 0:
                errors.append(f"PRICE_FILTER: preço {price} não respeita o tick {self.tick_size}")
        return errors

    def to_public(self) -> dict[str, Any]:
        return {
            "symbol": self.symbol,
            "base_asset": self.base_asset,
            "quote_asset": self.quote_asset,
            "status": self.status,
            "tick_size": str(self.tick_size),
            "step_size": str(self.qty_step(True)),
            "min_qty": str(self.market_min_qty or self.min_qty),
            "min_notional": str(self.effective_min_notional(True)),
        }
