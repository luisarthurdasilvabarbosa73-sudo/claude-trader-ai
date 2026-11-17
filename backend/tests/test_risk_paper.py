from decimal import Decimal as D

import pytest

from app.domain import BotStatus, Book, Candle
from app.execution.base import OrderRejected
from app.execution.paper import PaperBroker
from app.risk.manager import RiskManager, RiskState
from app.risk.settings import HARD_LIMITS, RiskSettings, RiskSettingsError, validate


# ------------------------------------------------------------ configurações
def test_hard_limits_reject_out_of_range():
    with pytest.raises(RiskSettingsError):
        validate({"risk_per_trade_pct": 50})
    with pytest.raises(RiskSettingsError):
        validate({"max_total_exposure_pct": 100})
    with pytest.raises(RiskSettingsError):
        validate({"campo_inventado": 1})
    ok = validate({"risk_per_trade_pct": 1.0, "max_open_positions": 2})
    assert ok.risk_per_trade_pct == 1.0 and ok.max_open_positions == 2
    assert HARD_LIMITS["risk_per_trade_pct"][1] <= 3.0


# ------------------------------------------------------------- gestor
def blockers(rm, now=1000.0, **kw):
    args = dict(bot_status=BotStatus.RODANDO, open_symbols=[], in_flight=set(), data_fresh=True)
    args.update(kw)
    return rm.entry_blockers("BTCUSDT", now, **args)


def test_entry_allowed_when_everything_ok():
    assert blockers(RiskManager(RiskSettings())) == []


def test_blocks_when_not_running_stale_duplicate_and_limits():
    rm = RiskManager(RiskSettings(max_open_positions=1))
    assert any("PARADO" in b for b in blockers(rm, bot_status=BotStatus.PARADO))
    assert any("desatualiz" in b for b in blockers(rm, data_fresh=False, data_reason="Cotação desatualizada"))
    assert any("duplicidade" in b for b in blockers(rm, open_symbols=["BTCUSDT"]))
    assert any("Ordem em andamento" in b for b in blockers(rm, in_flight={"BTCUSDT"}))
    assert any("simultânea" in b for b in blockers(rm, open_symbols=["ETHUSDT"]))


def test_daily_loss_lock():
    rm = RiskManager(RiskSettings(max_daily_loss_pct=5))
    rm.new_day("2026-11-17", D("100"))
    assert not rm.check_daily_loss(D("96"))
    assert rm.check_daily_loss(D("95"))
    assert any("perda diária" in b for b in blockers(rm))
    rm.new_day("2026-11-18", D("95"))
    assert blockers(rm) == []


def test_consecutive_losses_pause_and_cooldown():
    rm = RiskManager(RiskSettings(max_consecutive_losses=2, loss_streak_pause_minutes=60, cooldown_minutes_after_exit=15))
    assert rm.on_trade_closed("ETHUSDT", D("-1"), 1000) is None
    msg = rm.on_trade_closed("ETHUSDT", D("-1"), 1000)
    assert msg and "perdas seguidas" in msg
    assert any("Pausa automática" in b for b in blockers(rm, now=1100))
    assert blockers(rm, now=1000 + 3601) == []
    rm.on_trade_closed("BTCUSDT", D("1"), 5000)
    assert any("Intervalo de segurança" in b for b in blockers(rm, now=5100))


def test_circuit_breaker_extreme_volatility():
    rm = RiskManager(RiskSettings(circuit_move_1m_pct=3))
    crash = [Candle(0, 100, 100, 95, 96, 1, 59_999)]
    msg = rm.check_circuit("BTCUSDT", crash, 1000)
    assert msg and "anormal" in msg
    assert any("anormal" in b for b in blockers(rm, now=1010))


def test_repeated_errors_trigger_pause():
    rm = RiskManager(RiskSettings())
    assert rm.record_error(1) is None
    assert rm.record_error(2) is None
    assert rm.record_error(3) is not None
    assert any("falhas" in b for b in blockers(rm, now=10))


def test_risk_state_roundtrip():
    st = RiskState(day_key="x", day_start_equity=D("5.5"), consecutive_losses=2)
    back = RiskState.from_dict(st.to_dict())
    assert back.day_start_equity == D("5.5") and back.consecutive_losses == 2


# --------------------------------------------------------------- paper
def test_paper_buy_sell_fees_spread_slippage_and_dust(repo, filters):
    b = PaperBroker(repo, fee_rate=0.001, slippage_pct=0.02)
    b.initialize("USDT", D("10"), {})
    book = Book(bid=100000.0, ask=100010.0, ts=0)
    fill = b.market_buy("BTCUSDT", D("0.00007"), book, filters, "c1", 0)
    assert fill.price == D("100010") * D("1.0002")  # paga o ask + slippage
    assert fill.fee_asset == "BTC" and fill.fee == D("0.00007") * D("0.001")
    bal = b.balances()
    assert bal["BTC"] == D("0.00007") - fill.fee
    assert bal["USDT"] == D("10") - fill.quote_qty
    sell = b.market_sell("BTCUSDT", bal["BTC"], book, filters, "c2", 1)
    assert sell.qty == D("0.00006")  # arredondado para baixo no stepSize
    assert sell.price == D("100000") * D("0.9998")  # recebe o bid - slippage
    assert sell.fee_asset == "USDT"
    dust = b.balances()["BTC"]
    assert dust > 0  # poeira fica na carteira, como na Binance
    assert b.balances()["USDT"] < D("10")  # ida e volta sempre custa spread + taxas


def test_paper_small_position_can_get_stuck_below_min_notional(repo, filters):
    """Armadilha real de contas pequenas: comprar ~6 USDT e não conseguir vender (taxa + arredondamento)."""
    b = PaperBroker(repo, 0.001, 0.0)
    b.initialize("USDT", D("10"), {})
    book = Book(bid=100000.0, ask=100000.0, ts=0)
    b.market_buy("BTCUSDT", D("0.00006"), book, filters, "t1", 0)  # 6 USDT: aceita
    lower = Book(bid=99_900.0, ask=99_910.0, ts=1)  # preço cai só 0,1%
    with pytest.raises(OrderRejected, match="NOTIONAL"):
        b.market_sell("BTCUSDT", b.balances()["BTC"], lower, filters, "t2", 1)


def test_paper_rejects_below_min_notional_and_insufficient_balance(repo, filters):
    b = PaperBroker(repo, 0.001, 0.0)
    b.initialize("USDT", D("4"), {})
    book = Book(bid=100000.0, ask=100000.0, ts=0)
    with pytest.raises(OrderRejected, match="NOTIONAL"):
        b.market_buy("BTCUSDT", D("0.00004"), book, filters, "x1", 0)
    with pytest.raises(OrderRejected, match="Saldo insuficiente"):
        b.market_buy("BTCUSDT", D("0.00006"), book, filters, "x2", 0)
    assert b.balances() == {"USDT": D("4")}


def test_paper_idempotent_client_order_id(repo, filters):
    b = PaperBroker(repo, 0.001, 0.0)
    b.initialize("USDT", D("20"), {})
    book = Book(bid=100000.0, ask=100000.0, ts=0)
    f1 = b.market_buy("BTCUSDT", D("0.00006"), book, filters, "dup", 0)
    f2 = b.market_buy("BTCUSDT", D("0.00006"), book, filters, "dup", 0)
    assert f1.price == f2.price
    assert repo.count_orders() == 1
    assert b.balances()["USDT"] == D("20") - f1.quote_qty


def test_paper_state_persists(repo, filters):
    b = PaperBroker(repo, 0.001, 0.0)
    b.initialize("USDT", D("7.5"), {"initial_brl": "30"})
    b2 = PaperBroker(repo, 0.001, 0.0)
    assert b2.initialized and b2.balances() == {"USDT": D("7.5")}


def test_paper_module_has_no_credentials_or_signed_client():
    import inspect

    import app.execution.paper as paper
    src = inspect.getsource(paper)
    assert "BinanceRest" not in src and "api_key" not in src and "secret" not in src
