import math

import pytest

from app.analysis import indicators as ind
from app.analysis import levels, patterns
from app.domain import Candle


def candle(t, o, h, l, c, v=1.0):
    return Candle(t, o, h, l, c, v, t + 59_999)


def test_sma_and_ema_known_values():
    vals = [float(i) for i in range(1, 11)]
    assert ind.sma(vals, 3)[2] == pytest.approx(2.0)
    assert ind.sma(vals, 3)[9] == pytest.approx(9.0)
    e = ind.ema(vals, 3)
    assert e[:2] == [None, None]
    assert e[2] == pytest.approx(2.0)  # semente = média simples
    assert e[3] == pytest.approx(3.0)  # 4*0.5 + 2*0.5
    assert e[9] == pytest.approx(9.0)


def test_ema_constant_series():
    assert ind.ema([5.0] * 50, 21)[-1] == pytest.approx(5.0)


def test_rsi_wilder_reference_example():
    # Exemplo clássico de RSI(14) de Wilder (StockCharts): primeiro valor ≈ 70,53
    closes = [44.3389, 44.0902, 44.1497, 43.6124, 44.3278, 44.8264, 45.0955, 45.4245, 45.8433, 46.0826, 45.8931,
              46.0328, 45.6140, 46.2820, 46.2820, 46.0028, 46.0328, 46.4116, 46.2222, 45.6439]
    r = ind.rsi(closes, 14)
    assert r[13] is None
    expected = [70.53, 66.32, 66.55, 69.41, 66.36, 57.97]
    assert [round(x, 2) for x in r[14:]] == expected


def test_rsi_extremes():
    assert ind.rsi([float(i) for i in range(30)], 14)[-1] == 100.0
    assert ind.rsi([float(30 - i) for i in range(30)], 14)[-1] == pytest.approx(0.0)
    assert ind.rsi([10.0] * 30, 14)[-1] == 50.0


def test_macd_constant_is_zero():
    line, sig, hist = ind.macd([100.0] * 60)
    assert line[-1] == pytest.approx(0.0)
    assert sig[-1] == pytest.approx(0.0)
    assert hist[-1] == pytest.approx(0.0)
    assert line[24] is None and line[25] is not None


def test_macd_rising_series_positive():
    line, sig, hist = ind.macd([100 + i * 0.5 for i in range(80)])
    assert line[-1] > 0


def test_bollinger():
    mid, up, low, pb = ind.bollinger([10.0] * 25, 20, 2)
    assert mid[-1] == up[-1] == low[-1] == 10.0
    assert pb[-1] == 0.5
    vals = [float(i % 2) for i in range(20)]  # 0,1,0,1... média 0,5 desvio 0,5
    mid, up, low, _ = ind.bollinger(vals, 20, 2)
    assert mid[-1] == pytest.approx(0.5)
    assert up[-1] == pytest.approx(1.5)
    assert low[-1] == pytest.approx(-0.5)


def test_atr_constant_range():
    cs = [candle(i * 60_000, 100, 101, 99, 100) for i in range(30)]
    assert ind.atr(cs, 14)[-1] == pytest.approx(2.0)


def test_atr_includes_gaps():
    cs = [candle(0, 100, 101, 99, 100), candle(60_000, 110, 111, 109, 110)]
    tr = ind.true_range(cs)
    assert tr[1] == pytest.approx(11.0)  # |111 - 100|


def test_vwap_resets_each_utc_day():
    day = 86_400_000
    cs = [candle(day - 120_000, 10, 10, 10, 10, 1), candle(day - 60_000, 20, 20, 20, 20, 1),
          candle(day, 30, 30, 30, 30, 1)]
    v = ind.vwap(cs)
    assert v[1] == pytest.approx(15.0)
    assert v[2] == pytest.approx(30.0)  # novo dia


def test_relative_volume():
    vols = [10.0] * 20 + [20.0]
    assert ind.relative_volume(vols, 20)[-1] == pytest.approx(2.0)


def test_support_resistance_levels():
    prices = [100, 101, 102, 103, 102, 101, 100, 101, 102, 103.1, 102, 101, 100, 99, 100, 101]
    cs = [candle(i * 60_000, p, p + 0.2, p - 0.2, p) for i, p in enumerate(prices)]
    lv = levels.find_levels(cs, tolerance_pct=0.3)
    res = levels.nearest_resistance(lv, 101.0)
    assert res is not None and res.price == pytest.approx(103.25, abs=0.1)
    assert res.touches == 2  # dois topos agrupados na mesma zona
    assert levels.swing_low(cs, 6) == pytest.approx(98.8)


def test_patterns():
    prev = candle(0, 10, 10.1, 9.4, 9.5)
    cur = candle(60_000, 9.4, 10.3, 9.3, 10.2)
    assert patterns.bullish_engulfing(prev, cur)
    assert "engolfo de alta" in patterns.detect([prev, cur])
    ham = candle(0, 10, 10.05, 9.0, 10.02)
    assert patterns.hammer(ham)
    assert not math.isnan(patterns.rng(ham))
