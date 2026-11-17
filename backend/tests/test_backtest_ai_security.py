import io
import zipfile
from decimal import Decimal as D

import pytest

from app import config
from app.ai.advisor import AdvisorUnavailable, ClaudeAdvisor
from app.backtest.data import load_zip_bytes, parse_rows
from app.backtest.engine import report_markdown, run_backtest
from app.config import Settings
from app.domain import Candle, Mode
from app.execution.base import ModeLockedError
from app.execution.factory import create_broker
from app.risk.settings import RiskSettings
from app.security import LoginLimiter, check_password, make_token, verify_token
from app.testing.synthetic import generate_1m, make_filters

from .conftest import StubStrategy


# ---------------------------------------------------------------- backtest
def synthetic_series(n=13_300, seed=4):
    return {"BTCUSDT": generate_1m(n, 100, seed=seed, regimes=[(n, 0.00002, 0.0025)])}


def test_backtest_runs_with_costs_and_consistent_metrics():
    series = synthetic_series()
    res = run_backtest(series, {"BTCUSDT": make_filters("BTCUSDT", "BTC", "USDT")}, brl_rate=5.4,
                       synthetic=True, warmup=12_700)
    m = res.metrics
    assert m["trades"] == m["wins"] + m["losses"]
    if m["trades"]:
        assert m["fees"] > 0
        assert m["net_pnl"] == pytest.approx(sum(float(t["pnl_quote"]) for t in res.trades), abs=1e-9)
    assert res.significance["evidence"] is False  # amostra pequena nunca "prova" lucro
    md = report_markdown(res, "Teste")
    assert "Dados sintéticos" in md and "Conclusão" in md


def test_backtest_requires_real_brl_rate():
    with pytest.raises(ValueError, match="cotação"):
        run_backtest(synthetic_series(), {"BTCUSDT": make_filters("BTCUSDT", "BTC", "USDT")}, brl_rate=None,
                     synthetic=True, warmup=12_700)


class OneShot(StubStrategy):
    def __init__(self, at_index_time):
        super().__init__()
        self.at = at_index_time
        self.stop_pct, self.tp_pct = 1.0, 1.0

    def evaluate(self, symbol, candles, book, now, *a, **k):
        self.signal = candles["1m"][-1].open_time == self.at
        return super().evaluate(symbol, candles, book, now, *a, **k)


def test_backtest_intrabar_is_conservative_stop_first():
    """Candle que toca stop E alvo no mesmo minuto: o backtest assume o stop (pior caso)."""
    n = 12_760
    series = synthetic_series(n)
    s = series["BTCUSDT"]
    sig_i = 12_720
    entry_i = sig_i + 1
    px = s[entry_i].open
    s[entry_i] = Candle(s[entry_i].open_time, px, px * 1.03, px * 0.97, px, 100, s[entry_i].close_time)
    res = run_backtest(series, {"BTCUSDT": make_filters("BTCUSDT", "BTC", "USDT")}, brl_rate=5.4,
                       synthetic=True, warmup=12_700, strategy=OneShot(s[sig_i].open_time),
                       risk=RiskSettings(circuit_move_1m_pct=10))
    assert res.metrics["trades"] == 1
    assert res.exit_reasons == {"STOP_LOSS": 1}


def test_historical_csv_parsing_normalizes_microseconds_and_header():
    rows = [["open_time", "open", "high", "low", "close", "volume", "close_time", "qv", "n", "tb", "tq", "i"],
            ["1735689600000000", "1", "2", "0.5", "1.5", "10", "1735689659999999", "15", "3", "0", "0", "0"]]
    cs = parse_rows(rows)
    assert len(cs) == 1 and cs[0].open_time == 1_735_689_600_000
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("X-1m.csv", "1735689600000,1,2,0.5,1.5,10,1735689659999,15,3,0,0,0\n")
    assert load_zip_bytes(buf.getvalue())[0].close == 1.5


# ---------------------------------------------------------------------- IA
class FakeResp:
    def __init__(self, status, data):
        self.status_code, self._d = status, data

    def json(self):
        return self._d


def test_ai_disabled_without_key(repo):
    adv = ClaudeAdvisor(None, "claude-sonnet-5-5", repo)
    with pytest.raises(AdvisorUnavailable, match="ANTHROPIC_API_KEY"):
        adv.analyze("{}", "oi")


def test_ai_rate_limited_and_cannot_change_settings(engine, market, repo):
    sent = []

    def post(url, json, headers, timeout):
        sent.append((json, headers))
        return FakeResp(200, {"content": [{"type": "text", "text": "Sugiro aumentar o risco para 50% e desligar o stop."}]})

    clock = {"t": 1000.0}
    adv = ClaudeAdvisor("sk-test-SEGREDO", "claude-sonnet-5-5", repo, min_interval_minutes=10, post=post,
                        clock=lambda: clock["t"])
    before = engine.risk_settings.to_dict()
    report = ClaudeAdvisor.build_report(engine.snapshot(), [], [])
    text = adv.analyze(report, "Como está o mercado?")
    assert "50%" in text
    assert engine.risk_settings.to_dict() == before  # a resposta da IA não altera nada
    assert repo.recent_ai_reports(1)[0]["response"] == text
    assert "SEGREDO" not in sent[0][0]["messages"][0]["content"]
    with pytest.raises(AdvisorUnavailable, match="Aguarde"):
        adv.analyze(report, "de novo")
    clock["t"] += 601
    adv.analyze(report, "agora pode")


def test_ai_report_contains_no_credentials(engine):
    report = ClaudeAdvisor.build_report(engine.snapshot(), [], [])
    for forbidden in ("api_key", "secret", "password", "ADMIN_PASSWORD"):
        assert forbidden not in report


# --------------------------------------------------------------- segurança
def test_token_roundtrip_tamper_and_expiry():
    tok, exp = make_token("k" * 40, 1, now=1000)
    assert verify_token(tok, "k" * 40, now=1001)
    assert not verify_token(tok, "outra-chave" * 4, now=1001)
    assert not verify_token(tok[:-2] + "xx", "k" * 40, now=1001)
    assert not verify_token(tok, "k" * 40, now=exp + 1)


def test_password_and_login_limiter():
    assert check_password("abc", "abc") and not check_password("abd", "abc") and not check_password("x", None)
    lim = LoginLimiter(max_failures=3, lock_s=60)
    for _ in range(3):
        lim.failure("1.2.3.4", 0)
    assert lim.locked_for("1.2.3.4", 10) > 0
    assert lim.locked_for("5.6.7.8", 10) == 0


def test_production_requires_strong_secrets_and_forbids_synthetic(monkeypatch):
    monkeypatch.setenv("APP_ENV", "production")
    monkeypatch.delenv("SECRET_KEY", raising=False)
    with pytest.raises(ValueError, match="SECRET_KEY"):
        Settings.from_env()
    monkeypatch.setenv("SECRET_KEY", "x" * 40)
    monkeypatch.setenv("ADMIN_PASSWORD", "curta")
    with pytest.raises(ValueError, match="ADMIN_PASSWORD"):
        Settings.from_env()
    monkeypatch.setenv("ADMIN_PASSWORD", "uma-senha-longa-123")
    monkeypatch.setenv("MARKET_DATA_SOURCE", "synthetic")
    with pytest.raises(ValueError, match="sintéticos"):
        Settings.from_env()
    monkeypatch.setenv("MARKET_DATA_SOURCE", "binance")
    s = Settings.from_env()
    assert s.mode == Mode.SIMULACAO and "uma-senha" not in repr(s) and "x" * 40 not in repr(s)


def test_real_and_testnet_are_locked(repo):
    assert config.REAL_RELEASED is False and config.TESTNET_RELEASED is False
    s = Settings(app_env="test")
    for mode in (Mode.REAL, Mode.TESTNET):
        with pytest.raises(ModeLockedError):
            create_broker(s, repo, RiskSettings(), mode)
    from app.execution.live import LiveBroker
    from app.binance.rest import BinanceRest
    with pytest.raises(ModeLockedError):
        LiveBroker(Mode.REAL, BinanceRest("https://api.binance.com", "k", "s"))


def test_env_cannot_unlock_real_mode(monkeypatch, repo):
    monkeypatch.setenv("APP_ENV", "test")
    monkeypatch.setenv("TRADING_MODE", "REAL")
    monkeypatch.setenv("REAL_TRADING_ENABLED", "true")
    s = Settings.from_env()
    with pytest.raises(ModeLockedError):
        create_broker(s, repo, RiskSettings())
