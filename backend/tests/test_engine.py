"""Testes do motor com estratégia controlada (StubStrategy) e mercado sintético."""
from decimal import Decimal as D

import pytest

from app.domain import BotStatus, Book, Candle
from app.engine.bot import TradingEngine

from .conftest import make_market, next_candle, settings_for


def open_trade(engine, market, stub, stop_pct=1.0, tp_pct=3.0):
    engine.start(market.virtual_now)
    stub.signal, stub.stop_pct, stub.tp_pct = True, stop_pct, tp_pct
    next_candle(market, engine)
    stub.signal = False
    assert "BTCUSDT" in engine.positions, engine.brain.latest["BTCUSDT"]
    return engine.positions["BTCUSDT"]


def set_bid(market, engine, bid, step=True):
    now = market.virtual_now + 1
    market.virtual_now = now
    market.set_price("BTCUSDT", bid, bid * 1.0002, now)
    if step:
        engine.step(now)


def test_account_requires_real_brl_rate(repo, stub):
    m = make_market(brl_rate_symbol="USDTBRL")
    m.books.pop("USDTBRL")
    eng = TradingEngine(settings_for(m), repo, m, strategy=stub, clock=lambda: m.virtual_now)
    eng.step(m.virtual_now)
    assert not eng.account_ready()
    assert "Aguardando cotação REAL" in eng.brain.activity


def test_r30_converted_with_rate_and_fee(engine, market):
    next_candle(market, engine)
    eq = engine.equity()[0]
    ask = D(str(market.get_book("USDTBRL").ask))  # paga o ASK real do par USDT/BRL
    assert eq == (D("30") / ask * D("0.999")).quantize(D("0.00000001"))
    assert engine.to_brl(eq) < D("30")  # a taxa de conversão é contabilizada


def test_stopped_bot_analyzes_but_never_enters(engine, market, stub):
    stub.signal = True
    next_candle(market, engine, 3)
    assert engine.positions == {}
    latest = engine.brain.latest["BTCUSDT"]
    assert latest["decision"] == "BLOQUEADA PELO RISCO"
    assert any("PARADO" in b for b in latest["blockers"])


def test_full_trade_take_profit(engine, market, stub, repo):
    pos = open_trade(engine, market, stub)
    assert pos.stop_price < pos.entry_price < pos.take_profit
    assert pos.risk_quote <= engine.equity()[0] * D("0.02")
    set_bid(market, engine, float(pos.take_profit) * 1.001)
    assert engine.positions == {}
    t = repo.closed_positions()[0]
    assert t.exit_reason == "TAKE_PROFIT" and t.pnl_quote > 0
    assert t.fees_quote > 0
    snap = engine.snapshot()
    assert snap["today"]["wins"] == 1 and snap["today"]["fees_paid"] > 0
    assert snap["totals"]["trades"] == 1


def test_stop_loss_fills_at_bid_even_on_gap(engine, market, stub, repo):
    pos = open_trade(engine, market, stub, stop_pct=1.0)
    gap_bid = float(pos.stop_price) * 0.99  # preço "pulou" o stop
    set_bid(market, engine, gap_bid)
    t = repo.closed_positions()[0]
    assert t.exit_reason == "STOP_LOSS"
    assert t.exit_price < pos.stop_price  # executa no preço real disponível, não no stop
    assert t.pnl_quote < 0
    assert engine.risk.state.consecutive_losses == 1


def test_breakeven_and_trailing(engine, market, stub, repo):
    pos = open_trade(engine, market, stub, stop_pct=1.0, tp_pct=5.0)
    r = pos.entry_price - pos.initial_stop
    set_bid(market, engine, float(pos.entry_price + r * D("1.05")))
    assert engine.positions["BTCUSDT"].breakeven_done
    assert engine.positions["BTCUSDT"].stop_price > pos.entry_price
    set_bid(market, engine, float(pos.entry_price + r * D("2.5")))
    trailed = engine.positions["BTCUSDT"].stop_price
    assert trailed > pos.entry_price + r
    set_bid(market, engine, float(trailed) * 0.999)
    t = repo.closed_positions()[0]
    assert t.exit_reason == "STOP_MOVEL" and t.pnl_quote > 0


def test_no_duplicate_orders(engine, market, stub, repo):
    open_trade(engine, market, stub)
    stub.signal = True
    next_candle(market, engine, 3)
    assert repo.count_orders() == 1
    assert any("duplicidade" in b for b in engine.brain.latest["BTCUSDT"]["blockers"])


def test_same_candle_evaluated_once(engine, market, stub, repo):
    engine.start(market.virtual_now)
    stub.signal = True
    now = market.advance()
    engine.step(now)
    engine.step(now + 0.5)
    engine.step(now + 0.9)
    assert repo.count_orders() == 1


def test_stale_data_blocks_entries(engine, market, stub):
    engine.start(market.virtual_now)
    next_candle(market, engine)  # cria a conta com cotação válida
    stub.signal = True
    now = market.advance()
    engine.step(now + 60)  # cotação com 60s de atraso (limite 15s)
    assert engine.positions == {}
    assert any("desatualizada" in b for b in engine.brain.latest["BTCUSDT"]["blockers"])


def test_emergency_closes_everything_and_locks(engine, market, stub, repo):
    open_trade(engine, market, stub)
    res = engine.emergency_stop(market.virtual_now)
    assert res["closed"] == ["BTCUSDT"] and engine.positions == {}
    assert engine.status == BotStatus.EMERGENCIA
    stub.signal = True
    next_candle(market, engine, 2)
    assert engine.positions == {}
    assert repo.closed_positions()[0].exit_reason == "EMERGENCIA"


def test_daily_loss_limit_blocks_new_entries(engine, market, stub):
    pos = open_trade(engine, market, stub, stop_pct=1.0)
    engine.risk.state.day_start_equity = engine.equity()[0] * D("1.2")  # simula dia já perdedor
    set_bid(market, engine, float(pos.entry_price))
    assert engine.risk.state.daily_locked
    st, reason = engine.effective_status(market.virtual_now)
    assert st == "PAUSADO" and "perda diária" in reason


def test_restart_restores_positions_and_state(tmp_path, stub):
    path = str(tmp_path / "persist.db")
    from app.db import Repository
    m = make_market()
    r1 = Repository(path)
    e1 = TradingEngine(settings_for(m, path), r1, m, strategy=stub, clock=lambda: m.virtual_now)
    open_trade(e1, m, stub)
    eq1 = e1.equity()[0]
    r1.close()
    r2 = Repository(path)
    e2 = TradingEngine(settings_for(m, path), r2, m, strategy=stub, clock=lambda: m.virtual_now)
    assert "BTCUSDT" in e2.positions
    assert e2.status == BotStatus.RODANDO  # retomada automática segura
    assert e2.equity()[0] == eq1
    assert e2.account_ready()


def test_restart_without_auto_resume_stays_stopped(tmp_path, stub):
    from app.db import Repository
    path = str(tmp_path / "p2.db")
    m = make_market()
    e1 = TradingEngine(settings_for(m, path), Repository(path), m, strategy=stub, clock=lambda: m.virtual_now)
    e1.start(m.virtual_now)
    e2 = TradingEngine(settings_for(m, path, auto_resume=False), Repository(path), m, strategy=stub,
                       clock=lambda: m.virtual_now)
    assert e2.status == BotStatus.PARADO


def test_circuit_breaker_blocks_symbol(engine, market, stub):
    engine.start(market.virtual_now)
    c = market.store.get("BTCUSDT", "1m")[-1]
    c.high, c.low = c.open * 1.05, c.open * 0.99  # candle anormal de 6%
    market.cursor  # noqa: B018
    engine.last_eval["BTCUSDT"] = 0
    stub.signal = True
    engine.step(market.virtual_now)
    assert engine.positions == {}
    assert "BTCUSDT" in engine.risk.status(market.virtual_now, D(1))["blocked_symbols"]


def test_position_stuck_below_min_notional_is_reported_honestly(engine, market, stub, repo):
    pos = open_trade(engine, market, stub, stop_pct=1.0)
    set_bid(market, engine, float(pos.entry_price) * 0.5)  # colapso de 50%
    assert "BTCUSDT" in engine.positions  # não foi possível vender
    events = repo.recent_events(20, level="CRITICO")
    assert any("NÃO foi possível vender" in e["message"] for e in events)


def test_time_stop(engine, market, stub, repo):
    pos = open_trade(engine, market, stub, stop_pct=1.0, tp_pct=5.0)
    later = pos.entry_time + engine.risk_settings.max_trade_minutes * 60 + 5
    market.virtual_now = later
    market.set_price("BTCUSDT", float(pos.entry_price), float(pos.entry_price) * 1.0002, later)
    # mantém candles "frescos" para o teste
    last = market.store.get("BTCUSDT", "1m")[-1]
    market.store.get("BTCUSDT", "1m").append(Candle(int(later * 1000) // 60000 * 60000, last.close, last.close,
                                                    last.close, last.close, 1, 0, closed=False))
    engine.step(later)
    assert repo.closed_positions()[0].exit_reason == "TEMPO_MAXIMO"


def test_trend_invalidation_exit(engine, market, stub, repo):
    open_trade(engine, market, stub, stop_pct=1.0, tp_pct=5.0)
    stub.invalidate = "Candle de 15m fechou abaixo da EMA50"
    next_candle(market, engine)
    assert repo.closed_positions()[0].exit_reason == "TENDENCIA_INVALIDADA"


def test_risk_settings_update_validated_and_logged(engine):
    with pytest.raises(ValueError):
        engine.update_risk_settings({"risk_per_trade_pct": 10})
    new = engine.update_risk_settings({"risk_per_trade_pct": 1.0})
    assert new.risk_per_trade_pct == 1.0
    assert engine.repo.kv_get("risk_settings")["risk_per_trade_pct"] == 1.0


def test_decisions_are_recorded(engine, market, stub, repo):
    next_candle(market, engine, 3)
    assert len(repo.recent_decisions(10)) == 3


def test_snapshot_has_dashboard_fields(engine, market):
    next_candle(market, engine)
    s = engine.snapshot()
    for key in ("status", "mode", "account", "today", "totals", "brain", "market", "risk", "health"):
        assert key in s
    assert s["synthetic_data"] is True
    assert s["mode"] == "SIMULACAO" and s["is_real_money"] is False


def test_trade_pnl_matches_equity_change_with_dust(repo, stub):
    """Com lote grosso, a poeira criada/reciclada entra no resultado: P&L da operação = variação do patrimônio."""
    from app.risk.settings import RiskSettings
    from app.testing.synthetic import make_filters
    m = make_market()
    m.filters["BTCUSDT"] = make_filters("BTCUSDT", "BTC", "USDT", tick="0.01", step="0.001", min_qty="0.001",
                                        min_notional="5")
    repo.kv_set("risk_settings", RiskSettings(max_step_value_pct=25).to_dict())
    eng = TradingEngine(settings_for(m, initial_capital_brl=D("60")), repo, m, strategy=stub,
                        clock=lambda: m.virtual_now)
    next_candle(m, eng)
    eq0 = eng.equity()[0]
    for i in range(2):
        pos = open_trade(eng, m, stub, stop_pct=1.0, tp_pct=2.0)
        set_bid(m, eng, float(pos.take_profit) * 1.001)
        assert eng.positions == {}
        eng.risk.state.last_exit_ts.clear()
    trades = repo.closed_positions()
    eq1 = eng.equity()[0]
    total_pnl = sum(t.pnl_quote for t in trades)
    assert abs((eq1 - eq0) - total_pnl) < D("0.002")
    assert eng.broker.balances().get("BTC", D(0)) < D("0.001")  # no máximo 1 passo de poeira
