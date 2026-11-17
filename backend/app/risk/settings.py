"""Configurações de risco com LIMITES RÍGIDOS.

O proprietário pode ajustar os valores pelo app, mas NUNCA fora das faixas
em HARD_LIMITS. Essas faixas estão no código: nem a API, nem a IA, nem
variáveis de ambiente conseguem ampliá-las.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass, fields
from typing import Any

HARD_LIMITS: dict[str, tuple[float, float]] = {
    "risk_per_trade_pct": (0.1, 3.0),        # perda máxima por operação (% do patrimônio)
    "max_daily_loss_pct": (0.5, 10.0),       # bloqueio de novas entradas no dia
    "max_open_positions": (1, 3),
    "max_total_exposure_pct": (10.0, 95.0),  # nunca 100%: reserva para taxas/arredondamento
    "max_spread_pct": (0.01, 0.5),
    "min_score": (60.0, 95.0),
    "min_reward_risk": (1.2, 5.0),
    "max_consecutive_losses": (1, 10),
    "loss_streak_pause_minutes": (15, 1440),
    "cooldown_minutes_after_exit": (0, 240),
    "max_trade_minutes": (15, 720),
    "stale_data_seconds": (3, 60),
    "fee_rate_pct": (0.0, 0.5),
    "slippage_pct": (0.0, 1.0),
    "fee_reserve_pct": (0.5, 10.0),
    "circuit_move_1m_pct": (1.0, 10.0),
    "circuit_pause_minutes": (5, 240),
    "max_step_value_pct": (1.0, 25.0),       # valor de 1 passo de lote vs. patrimônio (poeira)
}

INT_FIELDS = {"max_open_positions", "max_consecutive_losses", "loss_streak_pause_minutes",
              "cooldown_minutes_after_exit", "max_trade_minutes", "stale_data_seconds", "circuit_pause_minutes"}


@dataclass
class RiskSettings:
    risk_per_trade_pct: float = 2.0
    max_daily_loss_pct: float = 6.0
    max_open_positions: int = 1
    max_total_exposure_pct: float = 95.0
    max_spread_pct: float = 0.15
    min_score: float = 70.0
    min_reward_risk: float = 1.5
    max_consecutive_losses: int = 3
    loss_streak_pause_minutes: int = 120
    cooldown_minutes_after_exit: int = 15
    max_trade_minutes: int = 240
    stale_data_seconds: int = 15
    fee_rate_pct: float = 0.1       # taxa padrão Binance Spot (sem desconto BNB)
    slippage_pct: float = 0.02
    fee_reserve_pct: float = 2.0     # parte do saldo que nunca é usada (taxas/arredondamento)
    circuit_move_1m_pct: float = 3.0  # movimento em 1 candle de 1m que dispara pausa
    circuit_pause_minutes: int = 30
    max_step_value_pct: float = 5.0   # ativo cujo lote mínimo vale mais que isso gera poeira demais

    @property
    def fee_rate(self) -> float:
        return self.fee_rate_pct / 100

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @staticmethod
    def limits() -> dict[str, dict[str, float]]:
        return {k: {"min": v[0], "max": v[1]} for k, v in HARD_LIMITS.items()}


class RiskSettingsError(ValueError):
    pass


def validate(data: dict[str, Any], base: RiskSettings | None = None) -> RiskSettings:
    """Valida e retorna novas configurações. Rejeita (não corrige) valores fora da faixa."""
    current = asdict(base or RiskSettings())
    valid_keys = {f.name for f in fields(RiskSettings)}
    errors = []
    for key, raw in data.items():
        if key not in valid_keys:
            errors.append(f"Campo desconhecido: {key}")
            continue
        try:
            value: float = float(raw)
        except (TypeError, ValueError):
            errors.append(f"{key}: valor inválido")
            continue
        lo, hi = HARD_LIMITS[key]
        if not lo <= value <= hi:
            errors.append(f"{key}: {value} fora do limite permitido [{lo}, {hi}]")
            continue
        current[key] = int(value) if key in INT_FIELDS else value
    if errors:
        raise RiskSettingsError("; ".join(errors))
    return RiskSettings(**current)
