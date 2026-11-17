"""Escolhe o executor conforme o modo. SIMULACAO nunca toca em credenciais."""
from __future__ import annotations

from ..config import Settings
from ..db import Repository
from ..domain import Mode
from ..risk.settings import RiskSettings
from .base import Broker
from .live import assert_mode_released
from .paper import PaperBroker


def create_broker(settings: Settings, repo: Repository, risk: RiskSettings, mode: Mode | None = None) -> Broker:
    mode = mode or settings.mode
    if mode == Mode.SIMULACAO:
        return PaperBroker(repo, risk.fee_rate, risk.slippage_pct)
    assert_mode_released(mode)  # levanta ModeLockedError nesta etapa
    raise NotImplementedError("Execução TESTNET/REAL será conectada nas etapas 9/10")  # pragma: no cover
