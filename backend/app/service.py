"""Camada de serviço da API: toda a lógica das rotas, independente do framework web.

As rotas FastAPI (main.py) apenas validam a entrada, conferem a autenticação
e chamam estes métodos.
"""
from __future__ import annotations

import time
from typing import Any

from . import config
from .ai.advisor import AdvisorUnavailable, ClaudeAdvisor
from .analysis import indicators as ind
from .binance.market_data import MarketData
from .config import Settings
from .db import Repository
from .domain import TIMEFRAMES, Mode
from .engine.bot import TradingEngine
from .risk.settings import RiskSettings, RiskSettingsError
from .security import LoginLimiter, check_password, make_token, verify_token


class ApiError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


class ApiService:
    def __init__(self, settings: Settings, repo: Repository, market: MarketData, engine: TradingEngine,
                 advisor: ClaudeAdvisor, clock: Any = time.time):
        self.settings = settings
        self.repo = repo
        self.market = market
        self.engine = engine
        self.advisor = advisor
        self.clock = clock
        self.limiter = LoginLimiter()
        self.global_limiter = LoginLimiter(max_failures=20)  # protege mesmo se o IP for trocado

    # ------------------------------------------------------------ auth
    def login(self, password: str, ip: str) -> dict[str, Any]:
        now = time.time()
        wait = max(self.limiter.locked_for(ip, now), self.global_limiter.locked_for("*", now))
        if wait > 0:
            raise ApiError(429, f"Muitas tentativas. Aguarde {int(wait / 60) + 1} min.")
        if not self.settings.admin_password:
            raise ApiError(503, "Senha de administrador não configurada no servidor (ADMIN_PASSWORD).")
        if not check_password(password, self.settings.admin_password):
            self.limiter.failure(ip, now)
            self.global_limiter.failure("*", now)
            self.repo.log("AVISO", "seguranca", f"Tentativa de login com senha incorreta (IP {ip})")
            raise ApiError(401, "Senha incorreta")
        self.limiter.success(ip)
        token, exp = make_token(self.settings.secret_key, self.settings.token_hours, now)
        self.repo.log("INFO", "seguranca", f"Login do proprietário (IP {ip})")
        return {"token": token, "expires_at": exp}

    def authorized(self, header: str | None) -> bool:
        if not header or not header.lower().startswith("bearer "):
            return False
        return verify_token(header[7:].strip(), self.settings.secret_key)

    # ---------------------------------------------------------- leitura
    def health(self) -> dict[str, Any]:
        now = self.clock()
        return {
            "status": "ok",
            "engine_alive": now - self.engine.last_step_ts < 30 if self.engine.last_step_ts else False,
            "mode": self.engine.mode,
            "data_source": self.market.source_name,
            "synthetic_data": self.market.is_synthetic,
            "market_error": self.market.fatal_error,
        }

    def dashboard(self) -> dict[str, Any]:
        snap = self.engine.snapshot(self.clock())
        snap["recent_trades"] = [p.to_dict() for p in self.repo.closed_positions(limit=10, mode=self.engine.mode)]
        snap["ai_enabled"] = self.advisor.enabled
        snap["release"] = {"testnet": config.TESTNET_RELEASED, "real": config.REAL_RELEASED}
        return snap

    def candles(self, symbol: str, tf: str, limit: int = 120) -> dict[str, Any]:
        symbol = symbol.upper()
        if symbol not in self.settings.symbols:
            raise ApiError(404, "Ativo não monitorado")
        if tf not in TIMEFRAMES:
            raise ApiError(400, "Timeframe inválido")
        limit = max(20, min(limit, 300))
        series = self.market.get_candles(symbol, tf)
        closes = [c.close for c in series]
        overlays = {
            "ema9": ind.ema(closes, 9), "ema21": ind.ema(closes, 21), "ema50": ind.ema(closes, 50),
            "ema200": ind.ema(closes, 200), "vwap": ind.vwap(series),
        }
        mid, up, low, _ = ind.bollinger(closes, 20, 2.0)
        overlays.update({"bb_up": up, "bb_mid": mid, "bb_low": low})
        rsi = ind.rsi(closes, 14)
        _, _, hist = ind.macd(closes)
        sl = slice(-limit, None)
        pos = self.engine.positions.get(symbol)
        return {
            "symbol": symbol, "tf": tf, "synthetic": self.market.is_synthetic,
            "candles": [c.to_dict() for c in series[sl]],
            "overlays": {k: v[sl] for k, v in overlays.items()},
            "rsi": rsi[sl], "macd_hist": hist[sl],
            "position": pos.to_dict() if pos else None,
        }

    def analysis(self, symbol: str) -> dict[str, Any]:
        a = self.engine.last_analysis.get(symbol.upper())
        if not a:
            raise ApiError(404, "Ainda não há análise para este ativo")
        return a.to_dict()

    def trades(self, limit: int = 50) -> list[dict[str, Any]]:
        return [p.to_dict() for p in self.repo.all_positions(limit=min(limit, 500), mode=self.engine.mode)]

    def decisions(self, limit: int = 50, only_rejected: bool = False) -> list[dict[str, Any]]:
        return self.repo.recent_decisions(min(limit, 500), only_rejected)

    def logs(self, limit: int = 100, level: str | None = None) -> list[dict[str, Any]]:
        return self.repo.recent_events(min(limit, 500), level)

    def equity(self, hours: int = 24) -> list[dict[str, Any]]:
        return self.repo.equity_series(self.clock() - hours * 3600)

    # -------------------------------------------------------- controles
    def start(self) -> dict[str, Any]:
        if not self.engine.account_ready():
            raise ApiError(409, "Conta simulada ainda não criada: aguardando cotação real USDT/BRL.")
        self.engine.start(self.clock())
        return {"status": self.engine.status.value}

    def pause(self) -> dict[str, Any]:
        self.engine.pause(self.clock())
        return {"status": self.engine.status.value}

    def emergency(self, confirm: str) -> dict[str, Any]:
        if confirm.strip().upper() != "PARAR":
            raise ApiError(400, "Confirme digitando PARAR")
        return self.engine.emergency_stop(self.clock())

    def get_risk(self) -> dict[str, Any]:
        return {"settings": self.engine.risk_settings.to_dict(), "limits": RiskSettings.limits()}

    def put_risk(self, data: dict[str, Any]) -> dict[str, Any]:
        try:
            new = self.engine.update_risk_settings(data, self.clock())
        except RiskSettingsError as exc:
            raise ApiError(400, str(exc)) from exc
        return {"settings": new.to_dict(), "limits": RiskSettings.limits()}

    def paper_reset(self, confirm: str) -> dict[str, Any]:
        if confirm.strip().upper() != "ZERAR":
            raise ApiError(400, "Confirme digitando ZERAR")
        try:
            self.engine.reset_paper_account(self.clock())
        except RuntimeError as exc:
            raise ApiError(409, str(exc)) from exc
        return {"ok": True}

    def mode_info(self) -> dict[str, Any]:
        return {
            "current": self.engine.mode,
            "modes": [
                {"mode": "SIMULACAO", "available": True, "label": "Simulação (paper trading)",
                 "detail": "Dados reais de mercado, dinheiro fictício. Modo atual desta etapa."},
                {"mode": "TESTNET", "available": config.TESTNET_RELEASED, "label": "Testnet Binance",
                 "detail": "Bloqueado: liberação prevista na ETAPA 9 após os testes."},
                {"mode": "REAL", "available": config.REAL_RELEASED and self.settings.real_trading_env_unlock,
                 "label": "Real (dinheiro verdadeiro)",
                 "detail": "Bloqueado por padrão. Exige ETAPA 10, autorização explícita e frase de confirmação."},
            ],
            "confirmation_phrase": config.REAL_CONFIRMATION_PHRASE,
        }

    def change_mode(self, mode: str, phrase: str, password: str) -> dict[str, Any]:
        try:
            target = Mode(mode.upper())
        except ValueError as exc:
            raise ApiError(400, "Modo inválido") from exc
        if target == Mode.SIMULACAO:
            return {"current": self.engine.mode}
        if not check_password(password, self.settings.admin_password):
            raise ApiError(401, "Senha incorreta")
        self.repo.log("AVISO", "seguranca", f"Tentativa de ativar modo {target.value} recusada (bloqueado nesta etapa)")
        if target == Mode.TESTNET and not config.TESTNET_RELEASED:
            raise ApiError(403, "Modo TESTNET bloqueado nesta etapa (liberação na ETAPA 9).")
        if target == Mode.REAL:
            if not config.REAL_RELEASED or not self.settings.real_trading_env_unlock:
                raise ApiError(403, "Modo REAL bloqueado. Exige a ETAPA 10 e sua autorização explícita.")
            if phrase.strip() != config.REAL_CONFIRMATION_PHRASE:
                raise ApiError(400, "Frase de confirmação incorreta")
        raise ApiError(501, "Troca de modo em tempo real não implementada; altere TRADING_MODE e reinicie.")

    # --------------------------------------------------------------- IA
    def ai_prepare(self, question: str) -> tuple[str, str]:
        question = (question or "Analise o contexto atual e explique as decisões do robô.").strip()[:500]
        try:
            self.advisor.check_limits()
        except AdvisorUnavailable as exc:
            raise ApiError(409, str(exc)) from exc
        report = ClaudeAdvisor.build_report(self.engine.snapshot(self.clock()), self.repo.recent_decisions(30),
                                            [p.to_dict() for p in self.repo.closed_positions(limit=20)])
        return report, question

    def ai_run(self, report: str, question: str) -> dict[str, Any]:
        try:
            text = self.advisor.analyze(report, question)
        except AdvisorUnavailable as exc:
            raise ApiError(409, str(exc)) from exc
        return {"response": text, "model": self.advisor.model}

    def ai_analyze(self, question: str) -> dict[str, Any]:
        return self.ai_run(*self.ai_prepare(question))

    def ai_reports(self) -> dict[str, Any]:
        return {"enabled": self.advisor.enabled, "model": self.advisor.model,
                "reports": self.repo.recent_ai_reports(10)}
