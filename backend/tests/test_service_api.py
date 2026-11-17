"""Camada de serviço (sempre roda) e rotas FastAPI (rodam quando o FastAPI está instalado)."""
import pytest

from app.ai.advisor import ClaudeAdvisor
from app.config import Settings
from app.engine.bot import TradingEngine
from app.service import ApiError, ApiService

from .conftest import make_market, next_candle

PASSWORD = "senha-de-teste-123"


@pytest.fixture
def svc(repo, stub):
    m = make_market()
    s = Settings(app_env="test", symbols=("BTCUSDT",), database_path=":memory:", market_data_source="synthetic",
                 admin_password=PASSWORD, secret_key="k" * 40)
    eng = TradingEngine(s, repo, m, strategy=stub, clock=lambda: m.virtual_now)
    next_candle(m, eng)
    service = ApiService(s, repo, m, eng, ClaudeAdvisor(None, "claude-sonnet-5-5", repo), clock=lambda: m.virtual_now)
    service._m = m
    return service


def test_login_and_token(svc):
    with pytest.raises(ApiError) as e:
        svc.login("errada", "1.1.1.1")
    assert e.value.status == 401
    tok = svc.login(PASSWORD, "1.1.1.1")["token"]
    assert svc.authorized(f"Bearer {tok}")
    assert not svc.authorized("Bearer lixo") and not svc.authorized(None)


def test_bruteforce_lock(svc):
    for _ in range(5):
        with pytest.raises(ApiError):
            svc.login("x", "9.9.9.9")
    with pytest.raises(ApiError) as e:
        svc.login(PASSWORD, "9.9.9.9")
    assert e.value.status == 429


def test_global_lock_even_when_ip_changes(svc):
    for i in range(20):
        with pytest.raises(ApiError):
            svc.login("x", f"10.0.0.{i}")
    with pytest.raises(ApiError) as e:
        svc.login(PASSWORD, "10.9.9.9")
    assert e.value.status == 429


def test_dashboard_candles_and_controls(svc):
    d = svc.dashboard()
    assert d["status"] == "PARADO" and d["mode"] == "SIMULACAO"
    assert d["release"] == {"testnet": False, "real": False}
    c = svc.candles("BTCUSDT", "5m", 60)
    assert len(c["candles"]) == 60 and len(c["overlays"]["ema21"]) == 60
    with pytest.raises(ApiError):
        svc.candles("DOGEUSDT", "5m")
    assert svc.start()["status"] == "RODANDO"
    assert svc.pause()["status"] == "PARADO"
    with pytest.raises(ApiError):
        svc.emergency("sim")
    assert svc.emergency("PARAR") == {"closed": [], "failed": []}
    assert svc.dashboard()["status"] == "EMERGENCIA"


def test_risk_settings_api_enforces_hard_limits(svc):
    with pytest.raises(ApiError) as e:
        svc.put_risk({"risk_per_trade_pct": 25})
    assert e.value.status == 400 and "fora do limite" in e.value.message
    out = svc.put_risk({"risk_per_trade_pct": 1.5})
    assert out["settings"]["risk_per_trade_pct"] == 1.5
    assert out["limits"]["risk_per_trade_pct"]["max"] == 3.0


def test_mode_change_real_is_refused(svc):
    info = svc.mode_info()
    assert [m["available"] for m in info["modes"]] == [True, False, False]
    with pytest.raises(ApiError) as e:
        svc.change_mode("REAL", "EU AUTORIZO OPERAR COM DINHEIRO REAL", PASSWORD)
    assert e.value.status == 403
    with pytest.raises(ApiError) as e:
        svc.change_mode("TESTNET", "", "senha-errada")
    assert e.value.status == 401


def test_paper_reset_requires_confirmation(svc):
    with pytest.raises(ApiError):
        svc.paper_reset("nao")
    assert svc.paper_reset("ZERAR") == {"ok": True}
    assert not svc.engine.account_ready()


def test_ai_disabled_message(svc):
    with pytest.raises(ApiError) as e:
        svc.ai_analyze("oi")
    assert e.value.status == 409


# ---------------------------------------------------------- FastAPI real
def test_fastapi_routes(tmp_path, monkeypatch):
    pytest.importorskip("fastapi")
    pytest.importorskip("httpx")
    from fastapi.testclient import TestClient

    from app.main import create_app

    m = make_market()
    s = Settings(app_env="test", symbols=("BTCUSDT",), database_path=str(tmp_path / "api.db"),
                 market_data_source="synthetic", admin_password=PASSWORD, secret_key="k" * 40,
                 frontend_dist=str(tmp_path / "nao-existe"))
    app = create_app(s, market=m, start_background=False)
    with TestClient(app) as client:
        assert client.get("/api/health").json()["status"] == "ok"
        assert client.get("/api/dashboard").status_code == 401
        r = client.post("/api/auth/login", json={"password": "errada"})
        assert r.status_code == 401
        tok = client.post("/api/auth/login", json={"password": PASSWORD}).json()["token"]
        h = {"Authorization": f"Bearer {tok}"}
        app.state.engine.step(m.advance())
        d = client.get("/api/dashboard", headers=h)
        assert d.status_code == 200 and d.headers["X-Frame-Options"] == "DENY"
        assert d.headers["Cache-Control"] == "no-store"
        assert client.get("/api/candles?symbol=BTCUSDT&tf=1m&limit=30", headers=h).status_code == 200
        assert client.put("/api/settings/risk", json={"risk_per_trade_pct": 99}, headers=h).status_code == 400
        assert client.post("/api/mode", json={"mode": "REAL", "phrase": "x", "password": PASSWORD},
                           headers=h).status_code == 403
        assert client.post("/api/bot/start", headers=h).json()["status"] == "RODANDO"
        assert client.post("/api/bot/emergency", json={"confirm": "PARAR"}, headers=h).status_code == 200
