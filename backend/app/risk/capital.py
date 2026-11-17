"""Gerenciamento de capital: quanto o robô pode usar e qual o tamanho da posição.

Princípios:
- O tamanho vem SOMENTE do risco: (patrimônio x risco%) / perda por unidade no stop.
- Perdas anteriores NUNCA aumentam o tamanho (sem martingale/recuperação).
- Se a menor ordem válida da Binance exigir mais risco do que o permitido,
  a operação é recusada com explicação — o robô não "arredonda para cima".
- A saída também precisa ser viável: a posição, no preço do stop e já
  descontada a taxa da compra, deve continuar acima do valor mínimo de ordem.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from decimal import Decimal
from typing import Any

from ..binance.filters import SymbolFilters
from ..domain import D
from .settings import RiskSettings

SAFETY = Decimal("1.02")  # margem sobre o mínimo da corretora


@dataclass
class SizingResult:
    ok: bool
    qty: Decimal
    notional: Decimal
    risk_quote: Decimal
    max_risk_quote: Decimal
    reason: str
    details: dict[str, Any] = field(default_factory=dict)


def loss_per_unit(entry: Decimal, stop: Decimal, fee: Decimal, slip: Decimal) -> Decimal:
    entry_fill = entry * (1 + slip)
    exit_fill = stop * (1 - slip)
    return entry_fill - (1 - fee) * exit_fill * (1 - fee)


def size_position(
    symbol: str,
    equity: Decimal,
    free_quote: Decimal,
    current_exposure: Decimal,
    entry: float,
    stop: float,
    filters: SymbolFilters,
    settings: RiskSettings,
    existing_base: Decimal = Decimal(0),
) -> SizingResult:
    fee = D(settings.fee_rate)
    slip = D(settings.slippage_pct) / 100
    e, s = D(entry), D(stop)
    q = filters.quote_asset
    max_risk = equity * D(settings.risk_per_trade_pct) / 100
    if s >= e or s <= 0:
        return SizingResult(False, D(0), D(0), D(0), max_risk, "Stop inválido (precisa ficar abaixo da entrada)")
    lpu = loss_per_unit(e, s, fee, slip)
    entry_fill = e * (1 + slip)

    reserve = equity * D(settings.fee_reserve_pct) / 100
    spendable = max(free_quote - reserve, D(0))
    exposure_room = max(equity * D(settings.max_total_exposure_pct) / 100 - current_exposure, D(0))

    qty_risk = max_risk / lpu
    qty_cash = spendable / entry_fill
    qty_expo = exposure_room / entry_fill
    raw_qty = min(qty_risk, qty_cash, qty_expo)
    limiter = "risco" if raw_qty == qty_risk else "saldo livre" if raw_qty == qty_cash else "exposição máxima"
    qty = filters.round_qty(raw_qty)

    # Menor posição que permite comprar E vender no stop respeitando os filtros.
    # A taxa da compra sai do ativo recebido; ao arredondar para o stepSize sobra
    # "poeira" que não pode ser vendida. Por isso a conta é feita sobre o que
    # REALMENTE poderá ser vendido (saldo existente + compra líquida, arredondado).
    min_n = filters.effective_min_notional(True)
    min_qty = filters.market_min_qty or filters.min_qty
    step = filters.qty_step(True)
    existing = max(D(existing_base), D(0))
    exit_px = s * (1 - slip)

    def sellable(qb: Decimal) -> Decimal:
        return filters.round_qty(existing + qb * (1 - fee))

    def viable(qb: Decimal) -> bool:
        sq = sellable(qb)
        return (qb * entry_fill >= min_n * SAFETY and qb >= min_qty and sq >= min_qty
                and sq * exit_px >= min_n * SAFETY)

    q_needed = filters.round_qty(max(min_qty, (min_n * SAFETY) / entry_fill if entry_fill > 0 else D(0)))
    for _ in range(200):
        if viable(q_needed):
            break
        q_needed += step
    risk_needed = q_needed * lpu
    cash_needed = q_needed * entry_fill
    step_value = step * e
    step_pct = (step_value / equity * 100) if equity > 0 else D(100)

    details = {
        "max_risk_quote": f"{max_risk:.4f}",
        "loss_per_unit": f"{lpu:.8f}",
        "limitador": limiter,
        "reserva_taxas": f"{reserve:.4f}",
        "saldo_utilizavel": f"{spendable:.4f}",
        "min_notional": str(min_n),
        "posicao_minima_viavel": f"{cash_needed:.4f}",
        "risco_da_posicao_minima": f"{risk_needed:.4f}",
        "valor_do_passo_de_lote": f"{step_value:.4f}",
    }

    def refuse(reason: str) -> SizingResult:
        return SizingResult(False, D(0), D(0), D(0), max_risk, reason, details)

    if step_pct > D(settings.max_step_value_pct):
        return refuse(
            f"{symbol} inviável para este capital: cada passo de lote ({step} {filters.base_asset}) vale "
            f"~{step_value:.2f} {q} ({step_pct:.1f}% do patrimônio). Como a taxa da compra é cobrada no próprio "
            f"ativo, quase 1 passo vira poeira não vendável — imobilizaria capital demais "
            f"(limite {settings.max_step_value_pct}%)."
        )

    if qty < q_needed:
        if risk_needed > max_risk:
            pct = (risk_needed / equity * 100) if equity > 0 else D(0)
            return refuse(
                f"Capital insuficiente para {symbol}: a menor posição viável (~{cash_needed:.2f} {q}, para "
                f"respeitar o mínimo de {min_n} {q} da Binance inclusive na venda pelo stop) arriscaria "
                f"{risk_needed:.4f} {q} ({pct:.2f}% do patrimônio), acima do limite de "
                f"{settings.risk_per_trade_pct}% por operação. O robô não aumenta o risco para operar."
            )
        if cash_needed > spendable:
            return refuse(
                f"Saldo insuficiente para {symbol}: a menor posição viável exige ~{cash_needed:.2f} {q} e há "
                f"{spendable:.2f} {q} utilizáveis (após reservar {reserve:.2f} {q} para taxas)."
            )
        return refuse(f"Limite de exposição total atingido para abrir {symbol}.")

    errors = filters.validate_order("BUY", qty, entry_fill, market=True)
    if errors:
        return refuse("Ordem violaria filtros da Binance: " + "; ".join(errors))
    if not viable(qty):
        return refuse(f"Posição de {qty} {filters.base_asset} não poderia ser vendida no stop (valor mínimo da Binance).")

    # Risco em termos de PATRIMÔNIO: a poeira continua sendo sua (marcada a mercado)
    risk = qty * lpu
    notional = qty * entry_fill
    details["limitador"] = limiter
    return SizingResult(
        True, qty, notional, risk, max_risk,
        f"Posição de {qty} ({notional:.4f} {q}); perda máxima planejada {risk:.4f} {q} "
        f"(limite {max_risk:.4f}); tamanho limitado por: {limiter}",
        details,
    )


def brl_to_quote(brl: Decimal, ask_quote_in_brl: float, fee_rate: float) -> Decimal:
    """Converte R$ para a moeda de cotação como se comprasse na Binance (paga a taxa)."""
    return D(brl) / D(ask_quote_in_brl) * (1 - D(fee_rate))
