"""Aplicação web (FastAPI): API autenticada + servidor do app PWA.

Execução: uvicorn app.main:create_app --factory --host 0.0.0.0 --port $PORT
"""
from __future__ import annotations

import asyncio
import logging
import os
from contextlib import asynccontextmanager
from typing import Any, AsyncIterator

from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .ai.advisor import ClaudeAdvisor
from .binance.market_data import BinanceMarketData, MarketData
from .binance.rest import BinanceRest
from .config import Settings
from .db import Repository
from .engine.bot import TradingEngine
from .security import SECURITY_HEADERS
from .service import ApiError, ApiService

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("app")


class LoginBody(BaseModel):
    password: str = Field(min_length=1, max_length=200)


class ConfirmBody(BaseModel):
    confirm: str = Field(default="", max_length=50)


class ModeBody(BaseModel):
    mode: str = Field(max_length=20)
    phrase: str = Field(default="", max_length=100)
    password: str = Field(default="", max_length=200)


class AskBody(BaseModel):
    question: str = Field(default="", max_length=500)


def build_market(settings: Settings) -> MarketData:
    if settings.market_data_source == "synthetic":
        from .testing.synthetic import SyntheticMarket, generate_1m
        n = 14_000
        series = {s: generate_1m(n, 100.0 * (i + 1), seed=11 + i, regimes=[(n, 0.00002, 0.0025)])
                  for i, s in enumerate(settings.symbols)}
        market = SyntheticMarket(series, settings.quote_asset, settings.brl_rate_symbol)
        market.advance(12_800)
        return market
    rest = BinanceRest(settings.market_rest_url)
    return BinanceMarketData(settings.symbols, settings.quote_asset, settings.brl_rate_symbol, rest,
                             settings.market_ws_url, bootstrap_limit=500)


def create_app(settings: Settings | None = None, market: MarketData | None = None,
               start_background: bool = True) -> FastAPI:
    settings = settings or Settings.from_env()
    repo = Repository(settings.database_path)
    market = market or build_market(settings)
    clock: Any = None
    if market.is_synthetic:
        from .testing.synthetic import VirtualClock
        clock = VirtualClock(market)  # type: ignore[arg-type]
    engine = TradingEngine(settings, repo, market, **({"clock": clock} if clock else {}))
    advisor = ClaudeAdvisor(settings.anthropic_api_key, settings.anthropic_model, repo,
                            settings.ai_min_interval_minutes, settings.ai_max_calls_per_day)
    service = ApiService(settings, repo, market, engine, advisor, **({"clock": clock} if clock else {}))

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        tasks: list[asyncio.Task[Any]] = []
        if start_background:
            tasks.append(asyncio.create_task(market.start(), name="market-start"))
            tasks.append(asyncio.create_task(engine.run(), name="engine"))
            if market.is_synthetic:
                from .testing.synthetic import run_accelerated
                tasks.append(asyncio.create_task(run_accelerated(market, 2.0), name="synthetic"))  # type: ignore[arg-type]
        log.info("CLAUDE TRADER AI iniciado (modo %s, fonte %s)", engine.mode, market.source_name)
        yield
        for t in tasks:
            t.cancel()
        await market.stop()
        repo.log("INFO", "sistema", "Servidor encerrado de forma segura")

    app = FastAPI(title="CLAUDE TRADER AI", version="0.1.0", lifespan=lifespan,
                  docs_url=None if settings.is_production else "/api/docs", redoc_url=None)
    app.state.service = service
    app.state.engine = engine

    @app.middleware("http")
    async def security_headers(request: Request, call_next: Any) -> Any:
        response = await call_next(request)
        for k, v in SECURITY_HEADERS.items():
            response.headers.setdefault(k, v)
        if request.url.path.startswith("/api/"):
            response.headers["Cache-Control"] = "no-store"
        return response

    @app.exception_handler(ApiError)
    async def api_error(_: Request, exc: ApiError) -> JSONResponse:
        return JSONResponse({"detail": exc.message}, status_code=exc.status)

    async def auth(authorization: str | None = Header(default=None)) -> None:
        if not service.authorized(authorization):
            raise HTTPException(status_code=401, detail="Não autenticado")

    A = [Depends(auth)]

    # ------------------------------------------------------------ rotas
    @app.get("/api/health")
    async def health() -> dict[str, Any]:
        return service.health()

    @app.post("/api/auth/login")
    async def login(body: LoginBody, request: Request) -> dict[str, Any]:
        # o último IP é o adicionado pelo proxy da plataforma (o primeiro pode ser forjado pelo cliente)
        ip = request.headers.get("x-forwarded-for", request.client.host if request.client else "?").split(",")[-1]
        return service.login(body.password, ip.strip())

    @app.get("/api/dashboard", dependencies=A)
    async def dashboard() -> dict[str, Any]:
        return service.dashboard()

    @app.get("/api/candles", dependencies=A)
    async def candles(symbol: str, tf: str = "5m", limit: int = Query(120, ge=20, le=300)) -> dict[str, Any]:
        return service.candles(symbol, tf, limit)

    @app.get("/api/analysis/{symbol}", dependencies=A)
    async def analysis(symbol: str) -> dict[str, Any]:
        return service.analysis(symbol)

    @app.get("/api/trades", dependencies=A)
    async def trades(limit: int = Query(50, ge=1, le=500)) -> list[dict[str, Any]]:
        return service.trades(limit)

    @app.get("/api/decisions", dependencies=A)
    async def decisions(limit: int = Query(50, ge=1, le=500), only_rejected: bool = False) -> list[dict[str, Any]]:
        return service.decisions(limit, only_rejected)

    @app.get("/api/logs", dependencies=A)
    async def logs(limit: int = Query(100, ge=1, le=500), level: str | None = None) -> list[dict[str, Any]]:
        return service.logs(limit, level)

    @app.get("/api/equity", dependencies=A)
    async def equity(hours: int = Query(24, ge=1, le=720)) -> list[dict[str, Any]]:
        return service.equity(hours)

    @app.post("/api/bot/start", dependencies=A)
    async def bot_start() -> dict[str, Any]:
        return service.start()

    @app.post("/api/bot/pause", dependencies=A)
    async def bot_pause() -> dict[str, Any]:
        return service.pause()

    @app.post("/api/bot/emergency", dependencies=A)
    async def bot_emergency(body: ConfirmBody) -> dict[str, Any]:
        return service.emergency(body.confirm)

    @app.get("/api/settings/risk", dependencies=A)
    async def get_risk() -> dict[str, Any]:
        return service.get_risk()

    @app.put("/api/settings/risk", dependencies=A)
    async def put_risk(body: dict[str, float]) -> dict[str, Any]:
        return service.put_risk(body)

    @app.post("/api/paper/reset", dependencies=A)
    async def paper_reset(body: ConfirmBody) -> dict[str, Any]:
        return service.paper_reset(body.confirm)

    @app.get("/api/mode", dependencies=A)
    async def mode_info() -> dict[str, Any]:
        return service.mode_info()

    @app.post("/api/mode", dependencies=A)
    async def change_mode(body: ModeBody) -> dict[str, Any]:
        return service.change_mode(body.mode, body.phrase, body.password)

    @app.post("/api/ai/analyze", dependencies=A)
    async def ai_analyze(body: AskBody) -> dict[str, Any]:
        report, question = service.ai_prepare(body.question)  # lê o estado no mesmo thread do motor
        return await asyncio.to_thread(service.ai_run, report, question)  # chamada lenta fora do loop

    @app.get("/api/ai/reports", dependencies=A)
    async def ai_reports() -> dict[str, Any]:
        return service.ai_reports()

    # ------------------------------------------------- app PWA (frontend)
    dist = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", settings.frontend_dist))
    if os.path.isdir(dist):
        index = os.path.join(dist, "index.html")

        @app.get("/sw.js", include_in_schema=False)
        def sw() -> FileResponse:
            return FileResponse(os.path.join(dist, "sw.js"), media_type="application/javascript",
                                headers={"Cache-Control": "no-cache", "Service-Worker-Allowed": "/"})

        app.mount("/assets", StaticFiles(directory=os.path.join(dist, "assets"), check_dir=False), name="assets")
        app.mount("/icons", StaticFiles(directory=os.path.join(dist, "icons"), check_dir=False), name="icons")

        @app.get("/{path:path}", include_in_schema=False)
        def spa(path: str) -> FileResponse:
            if path.startswith("api/"):
                raise HTTPException(404)
            candidate = os.path.abspath(os.path.join(dist, path))
            inside = os.path.commonpath([candidate, dist]) == dist
            if path and inside and os.path.isfile(candidate):
                return FileResponse(candidate)
            return FileResponse(index, headers={"Cache-Control": "no-cache"})
    else:
        @app.get("/", include_in_schema=False)
        def no_frontend() -> dict[str, str]:
            return {"detail": "Frontend não compilado. Rode o build do app (frontend/) ou use a imagem Docker."}

    return app

