import pytest

from app.analysis.strategy import Strategy, net_reward_risk
from app.domain import TIMEFRAMES, Book
from app.testing.synthetic import SyntheticMarket, generate_1m

from .conftest import make_market


def evaluate(st, m, sym="BTCUSDT", spread_book=None, **kw):
    c = {tf: m.get_candles(sym, tf) for tf in TIMEFRAMES}
    book = spread_book or m.get_book(sym)
    args = dict(fee_rate=0.001, slippage_pct=0.02, max_spread_pct=0.15, min_rr=1.5, min_score=70)
    args.update(kw)
    return st.evaluate(sym, c, book, m.virtual_now, **args)


def test_insufficient_history_never_trades():
    n = 400
    m = SyntheticMarket({"BTCUSDT": generate_1m(n, 100, seed=1)})
    m.advance(300)
    a = evaluate(Strategy(), m)
    assert a.action == "AGUARDAR"
    assert not a.gates[0].passed and "Aguardando histórico" in a.gates[0].detail


def test_downtrend_regime_blocks_entries():
    n = 13_400
    m = SyntheticMarket({"BTCUSDT": generate_1m(n, 100, seed=2, regimes=[(n, -0.00004, 0.002)])})
    m.advance(13_000)
    st = Strategy()
    for _ in range(200):
        m.advance()
        a = evaluate(st, m)
        assert a.action == "AGUARDAR"
    regime = next(g for g in a.gates if g.key == "regime_1h")
    assert not regime.passed and "BAIXA" in regime.detail
    assert any("Regime" in r for r in a.reasons)


def test_buy_signals_respect_all_rules():
    m = make_market(n=13_600, seed=4)
    st = Strategy()
    buys = []
    for _ in range(600):
        m.advance()
        a = evaluate(st, m)
        if a.action == "COMPRAR":
            buys.append(a)
    assert buys, "a série sintética de referência deveria gerar ao menos um sinal"
    for a in buys:
        assert a.gates_passed
        assert a.score >= a.min_score
        assert a.stop < a.entry < a.take_profit
        assert a.rr_net >= 1.5
        assert a.regime == "ALTA"
        assert sum(c.max_points for c in a.components) == 100


def test_wide_spread_rejected():
    m = make_market(n=13_600, seed=4)
    m.advance(5)
    px = m.get_book("BTCUSDT").bid
    a = evaluate(Strategy(), m, spread_book=Book(bid=px, ask=px * 1.01, ts=m.virtual_now))
    spread_gate = next(g for g in a.gates if g.key == "spread")
    assert not spread_gate.passed
    assert a.action == "AGUARDAR"


def test_score_threshold_blocks_weak_signals():
    m = make_market(n=13_600, seed=4)
    st = Strategy()
    for _ in range(300):
        m.advance()
        a = evaluate(st, m, min_score=95)
        assert a.action == "AGUARDAR" or a.score >= 95


def test_net_reward_risk_accounts_for_costs():
    gross = net_reward_risk(100, 99, 102, 0.0, 0.0)
    net = net_reward_risk(100, 99, 102, 0.001, 0.0002)
    assert gross == pytest.approx(2.0)
    assert net < gross  # taxas reduzem o R:R
    assert net_reward_risk(100, 99.9, 100.2, 0.001, 0.0) < 1  # alvo pequeno não paga as taxas


def test_fast_mode_short_circuits():
    n = 13_200
    m = SyntheticMarket({"BTCUSDT": generate_1m(n, 100, seed=2, regimes=[(n, -0.00004, 0.002)])})
    m.advance(13_000)
    a = evaluate(Strategy(), m, fast=True)
    assert len(a.gates) == 2 and not a.gates[-1].passed
