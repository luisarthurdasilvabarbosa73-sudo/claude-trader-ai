"""Configuração lida SOMENTE de variáveis de ambiente.

Nenhuma credencial fica no código. Em produção (nuvem), as variáveis são
cadastradas no painel do provedor como "secrets".
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from decimal import Decimal

from .domain import Mode

# --- Travas de liberação por etapa -------------------------------------------
# Estas constantes só mudam por alteração de código revisada pelo proprietário.
# Nenhuma variável de ambiente, rota da API ou módulo de IA consegue alterá-las.
TESTNET_RELEASED = False  # liberado na ETAPA 9, após testes reais na Testnet
REAL_RELEASED = False     # liberado na ETAPA 10, com autorização explícita

REAL_CONFIRMATION_PHRASE = "EU AUTORIZO OPERAR COM DINHEIRO REAL"


def _bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "sim", "yes", "on"}


def _list(name: str, default: str) -> tuple[str, ...]:
    raw = os.environ.get(name, default)
    items = [s.strip().upper() for s in raw.split(",") if s.strip()]
    return tuple(dict.fromkeys(items))  # remove duplicados mantendo a ordem


@dataclass(frozen=True)
class Settings:
    app_env: str = "production"  # production | dev | test
    mode: Mode = Mode.SIMULACAO
    symbols: tuple[str, ...] = ("BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT", "ADAUSDT")
    quote_asset: str = "USDT"
    initial_capital_brl: Decimal = Decimal("30")
    brl_rate_symbol: str = "USDTBRL"  # cotação real para converter R$ -> USDT
    database_path: str = "data/trader.db"
    timezone: str = "America/Sao_Paulo"
    auto_resume: bool = True
    market_data_source: str = "binance"  # binance | synthetic (apenas dev/test)

    # Endpoints oficiais da Binance só para dados públicos de mercado
    market_rest_url: str = "https://data-api.binance.vision"
    market_ws_url: str = "wss://data-stream.binance.vision"
    # Endpoints de negociação (usados apenas nas etapas TESTNET/REAL)
    testnet_rest_url: str = "https://testnet.binance.vision"
    real_rest_url: str = "https://api.binance.com"

    # Segurança
    admin_password: str | None = field(default=None, repr=False)
    secret_key: str = field(default="", repr=False)
    token_hours: int = 72

    # Credenciais (nunca enviadas ao app; nunca logadas)
    binance_api_key: str | None = field(default=None, repr=False)
    binance_api_secret: str | None = field(default=None, repr=False)
    real_trading_env_unlock: bool = False

    # IA (opcional)
    anthropic_api_key: str | None = field(default=None, repr=False)
    anthropic_model: str = "claude-sonnet-5-5"
    ai_min_interval_minutes: int = 10
    ai_max_calls_per_day: int = 24

    frontend_dist: str = "../frontend/dist"

    @property
    def is_production(self) -> bool:
        return self.app_env == "production"

    @staticmethod
    def from_env() -> "Settings":
        app_env = os.environ.get("APP_ENV", "production").strip().lower()
        source = os.environ.get("MARKET_DATA_SOURCE", "binance").strip().lower()
        if source not in {"binance", "synthetic"}:
            raise ValueError("MARKET_DATA_SOURCE deve ser 'binance' ou 'synthetic'")
        if source == "synthetic" and app_env == "production":
            # Dados sintéticos nunca podem rodar em produção.
            raise ValueError("Dados sintéticos são proibidos em produção (APP_ENV=production)")

        secret = os.environ.get("SECRET_KEY", "")
        password = os.environ.get("ADMIN_PASSWORD") or None
        if app_env == "production":
            if len(secret) < 32:
                raise ValueError("SECRET_KEY precisa ter pelo menos 32 caracteres em produção")
            if not password or len(password) < 10:
                raise ValueError("ADMIN_PASSWORD precisa ter pelo menos 10 caracteres em produção")
        elif not secret:
            secret = "dev-secret-key-nao-use-em-producao-0123456789"

        mode_raw = os.environ.get("TRADING_MODE", "SIMULACAO").strip().upper()
        mode = Mode(mode_raw) if mode_raw in Mode.__members__ else Mode.SIMULACAO

        return Settings(
            app_env=app_env,
            mode=mode,
            symbols=_list("SYMBOLS", "BTCUSDT,ETHUSDT,SOLUSDT,XRPUSDT,ADAUSDT"),
            quote_asset=os.environ.get("QUOTE_ASSET", "USDT").strip().upper(),
            initial_capital_brl=Decimal(os.environ.get("INITIAL_CAPITAL_BRL", "30")),
            brl_rate_symbol=os.environ.get("BRL_RATE_SYMBOL", "USDTBRL").strip().upper(),
            database_path=os.environ.get("DATABASE_PATH", "data/trader.db"),
            timezone=os.environ.get("TIMEZONE", "America/Sao_Paulo"),
            auto_resume=_bool("AUTO_RESUME", True),
            market_data_source=source,
            market_rest_url=os.environ.get("MARKET_REST_URL", "https://data-api.binance.vision"),
            market_ws_url=os.environ.get("MARKET_WS_URL", "wss://data-stream.binance.vision"),
            admin_password=password,
            secret_key=secret,
            token_hours=int(os.environ.get("TOKEN_HOURS", "72")),
            binance_api_key=os.environ.get("BINANCE_API_KEY") or None,
            binance_api_secret=os.environ.get("BINANCE_API_SECRET") or None,
            real_trading_env_unlock=_bool("REAL_TRADING_ENABLED", False),
            anthropic_api_key=os.environ.get("ANTHROPIC_API_KEY") or None,
            anthropic_model=os.environ.get("ANTHROPIC_MODEL", "claude-sonnet-5-5"),
            ai_min_interval_minutes=int(os.environ.get("AI_MIN_INTERVAL_MINUTES", "10")),
            ai_max_calls_per_day=int(os.environ.get("AI_MAX_CALLS_PER_DAY", "24")),
            frontend_dist=os.environ.get("FRONTEND_DIST", "../frontend/dist"),
        )
