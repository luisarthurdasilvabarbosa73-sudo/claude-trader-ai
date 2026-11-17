from decimal import Decimal as D

from app.binance.filters import SymbolFilters
from app.risk.capital import brl_to_quote, loss_per_unit, size_position
from app.risk.settings import RiskSettings
from app.testing.synthetic import make_filters

EXCHANGE_INFO_BTC = {
    "symbol": "BTCUSDT", "status": "TRADING", "baseAsset": "BTC", "quoteAsset": "USDT",
    "orderTypes": ["LIMIT", "LIMIT_MAKER", "MARKET", "STOP_LOSS_LIMIT", "TAKE_PROFIT_LIMIT"],
    "isSpotTradingAllowed": True,
    "filters": [
        {"filterType": "PRICE_FILTER", "minPrice": "0.01000000", "maxPrice": "1000000.00000000", "tickSize": "0.01000000"},
        {"filterType": "LOT_SIZE", "minQty": "0.00001000", "maxQty": "9000.00000000", "stepSize": "0.00001000"},
        {"filterType": "MARKET_LOT_SIZE", "minQty": "0.00000000", "maxQty": "76.0", "stepSize": "0.00000000"},
        {"filterType": "NOTIONAL", "minNotional": "5.00000000", "applyMinToMarket": True,
         "maxNotional": "9000000.00000000", "applyMaxToMarket": False, "avgPriceMins": 5},
    ],
}


def test_parse_exchange_info():
    f = SymbolFilters.from_exchange_info(EXCHANGE_INFO_BTC)
    assert f.tick_size == D("0.01")
    assert f.step_size == D("0.00001")
    assert f.min_notional == D("5")
    assert f.market_step_size is None  # stepSize 0 => usa LOT_SIZE
    assert f.qty_step(True) == D("0.00001")


def test_round_qty_always_down_and_price_tick():
    f = SymbolFilters.from_exchange_info(EXCHANGE_INFO_BTC)
    assert f.round_qty(D("0.000129999")) == D("0.00012")
    assert f.round_price(D("100.019")) == D("100.01")
    assert f.round_price(D("100.011"), up=True) == D("100.02")


def test_validate_order_rejections():
    f = SymbolFilters.from_exchange_info(EXCHANGE_INFO_BTC)
    errs = f.validate_order("BUY", D("0.00004"), D("100000"))  # 4 USDT
    assert any("NOTIONAL" in e for e in errs)
    errs = f.validate_order("BUY", D("0.000055"), D("100000"))
    assert any("passo" in e for e in errs)
    assert f.validate_order("BUY", D("0.00006"), D("100000")) == []


def test_legacy_min_notional_and_market_flag():
    info = dict(EXCHANGE_INFO_BTC)
    info["filters"] = [x for x in info["filters"] if x["filterType"] != "NOTIONAL"] + [
        {"filterType": "MIN_NOTIONAL", "minNotional": "10", "applyToMarket": False, "avgPriceMins": 5}]
    f = SymbolFilters.from_exchange_info(info)
    assert f.min_notional == D("10")
    assert f.validate_order("BUY", D("0.00006"), D("100000"), market=True) == []  # não aplica a mercado
    assert any("NOTIONAL" in e for e in f.validate_order("BUY", D("0.00006"), D("100000"), market=False))


def _f():
    return make_filters("XUSDT", "X", "USDT", tick="0.01", step="0.0001", min_qty="0.0001", min_notional="5")


def test_sizing_r30_valid_trade_is_capped_by_balance():
    s = RiskSettings()  # risco 2%
    equity = brl_to_quote(D("30"), 5.40, 0.001)  # ~5.55 USDT
    r = size_position("XUSDT", equity, equity, D(0), 100.0, 99.0, _f(), s)
    assert r.ok, r.reason
    assert r.risk_quote <= r.max_risk_quote
    assert r.notional >= D("5")
    assert r.details["limitador"] in {"saldo livre", "exposição máxima"}  # não pelo risco: saldo é pequeno
    # nunca usa 100% do saldo: reserva de taxas preservada
    assert r.notional <= equity * (1 - D(s.fee_reserve_pct) / 100) * D("1.0001")


def test_sizing_r30_refuses_when_min_order_needs_more_risk():
    s = RiskSettings()
    equity = brl_to_quote(D("30"), 5.40, 0.001)
    r = size_position("XUSDT", equity, equity, D(0), 100.0, 94.0, _f(), s)  # stop de 6%
    assert not r.ok
    assert "Capital insuficiente" in r.reason
    assert "não aumenta o risco" in r.reason


def test_sizing_checks_exit_viability_at_stop():
    """Comprar 5,19 USDT passaria no filtro, mas no stop a posição valeria < 5 USDT (impossível vender)."""
    s = RiskSettings(risk_per_trade_pct=2.0)
    equity = D("5.30")
    f = _f()
    assert f.validate_order("BUY", D("0.0518"), D("100.02")) == []  # a compra sozinha seria aceita
    r = size_position("XUSDT", equity, equity, D(0), 100.0, 95.0, f, s)
    assert not r.ok
    assert "inclusive na venda pelo stop" in r.reason


def test_sizing_never_increases_after_losses_no_martingale():
    s = RiskSettings()
    f = make_filters("XUSDT", "X", "USDT", tick="0.01", step="0.0001", min_qty="0.0001", min_notional="1")
    big = size_position("XUSDT", D("100"), D("100"), D(0), 100.0, 99.0, f, s)
    after_loss = size_position("XUSDT", D("90"), D("90"), D(0), 100.0, 99.0, f, s)
    assert big.ok and after_loss.ok
    assert after_loss.qty < big.qty  # patrimônio menor => posição menor
    assert after_loss.risk_quote <= D("90") * D("0.02")


def test_sizing_respects_exposure_limit():
    s = RiskSettings(max_total_exposure_pct=50)
    f = make_filters("XUSDT", "X", "USDT", tick="0.01", step="0.0001", min_qty="0.0001", min_notional="1")
    r = size_position("XUSDT", D("100"), D("100"), D("45"), 100.0, 99.5, f, s)
    assert r.ok
    assert r.notional <= D("5.01")
    blocked = size_position("XUSDT", D("100"), D("100"), D("50"), 100.0, 99.5, f, s)
    assert not blocked.ok


def test_loss_per_unit_includes_fees_and_slippage():
    lpu = loss_per_unit(D(100), D(99), D("0.001"), D("0.0002"))
    assert lpu > D(1)  # mais que a distância bruta do stop
    assert lpu < D("1.3")


def test_brl_conversion_charges_fee():
    assert brl_to_quote(D("30"), 5.0, 0.001) == D("5.994")


def test_lot_granularity_refuses_assets_that_create_too_much_dust():
    """BTC a ~97 mil: 1 passo (0,00001 BTC) ≈ 0,97 USDT ≈ 17% de R$30 — vira poeira não vendável."""
    s = RiskSettings()
    btc = make_filters("BTCUSDT", "BTC", "USDT", tick="0.01", step="0.00001", min_qty="0.00001", min_notional="5")
    equity = brl_to_quote(D("30"), 5.40, 0.001)
    r = size_position("BTCUSDT", equity, equity, D(0), 97_000.0, 95_500.0, btc, s)
    assert not r.ok and "poeira" in r.reason
    sol = make_filters("SOLUSDT", "SOL", "USDT", tick="0.01", step="0.001", min_qty="0.001", min_notional="5")
    # Com R$30 até a SOL fica no limite: a menor posição vendável no stop (~5,40) passa de 95% do patrimônio
    tight = size_position("SOLUSDT", equity, equity, D(0), 180.0, 178.0, sol, s)
    assert not tight.ok and "exposição" in tight.reason
    equity40 = brl_to_quote(D("40"), 5.40, 0.001)
    ok = size_position("SOLUSDT", equity40, equity40, D(0), 180.0, 178.0, sol, s)
    assert ok.ok, ok.reason


def test_existing_dust_counts_toward_sellable_quantity():
    s = RiskSettings(max_step_value_pct=25)
    f = make_filters("XUSDT", "X", "USDT", tick="0.01", step="0.01", min_qty="0.01", min_notional="5")
    equity = D("5.6")
    without = size_position("XUSDT", equity, equity, D(0), 100.0, 98.5, f, s)
    with_dust = size_position("XUSDT", equity, equity - D("0.9"), D("0.9"), 100.0, 98.5, f, s, existing_base=D("0.009"))
    assert without.details["posicao_minima_viavel"] >= with_dust.details["posicao_minima_viavel"]
