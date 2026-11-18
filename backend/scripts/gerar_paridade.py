"""Gera o arquivo de PARIDADE: roda o motor Python (referência) sobre dados sintéticos
e grava entradas + resultados em JSON. O teste do app (frontend/src/core/tests/parity.test.ts)
roda o motor TypeScript do celular sobre os MESMOS dados e confere se as decisões são iguais.

Uso: python scripts/gerar_paridade.py /tmp/paridade.json
"""
from __future__ import annotations

import json
import os
import sys
from decimal import Decimal

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.backtest.engine import ReplayMarket  # noqa: E402
from app.config import Settings  # noqa: E402
from app.db import Repository  # noqa: E402
from app.engine.bot import TradingEngine  # noqa: E402
from app.testing.synthetic import generate_1m, make_filters  # noqa: E402

WARMUP = 12_700
MINUTES = 1_200


def main(out: str) -> None:
    n = WARMUP + MINUTES
    series = {
        "BTCUSDT": generate_1m(n, 100.0, seed=4, regimes=[(n, 0.00002, 0.0025)]),
        "ETHUSDT": generate_1m(n, 100.0, seed=5, regimes=[(n, 0.00002, 0.0025)]),
    }
    infos = {}
    filters = {}
    for s in series:
        f = make_filters(s, s[:-4], "USDT")
        filters[s] = f
        infos[s] = f.raw
    brl_rate = 5.4
    market = ReplayMarket(series, filters, "USDT", brl_rate, 0.02, synthetic=True)
    repo = Repository(":memory:")
    settings = Settings(app_env="test", symbols=tuple(series), quote_asset="USDT", initial_capital_brl=Decimal("100"),
                        database_path=":memory:", market_data_source="synthetic")
    for i in range(WARMUP):
        market.push_closed(i)
    engine = TradingEngine(settings, repo, market, clock=lambda: market.now, persist_decisions=True)
    first = series["BTCUSDT"]
    engine.start(first[WARMUP].open_time / 1000)
    for i in range(WARMUP, n):
        t = first[i].open_time / 1000
        for which, off in (("open", 1), ("low", 20), ("high", 40), ("close", 59)):
            market.set_prices(i, which, t + off)
            engine.step(t + off)
        market.push_closed(i)

    decisions = []
    for d in reversed(repo.recent_decisions(100_000)):
        det = d["details"]
        decisions.append({"ts": d["ts"], "symbol": d["symbol"], "action": d["action"], "score": d["score"],
                          "decision": det.get("decision"), "failed_gates": det.get("failed_gates", []),
                          "stop": det.get("stop"), "take_profit": det.get("take_profit")})
    trades = []
    for p in reversed(repo.closed_positions(limit=100_000)):
        trades.append({"symbol": p.symbol, "entry_time": p.entry_time, "exit_time": p.exit_time,
                       "exit_reason": p.exit_reason, "entry_price": float(p.entry_price),
                       "exit_price": float(p.exit_price or 0), "qty": float(p.qty), "pnl_quote": float(p.pnl_quote or 0)})
    payload = {
        "warmup": WARMUP, "brl_rate": brl_rate, "initial_brl": 100,
        "candles": {s: [[c.open_time, c.open, c.high, c.low, c.close, c.volume] for c in ser] for s, ser in series.items()},
        "exchange_info": infos,
        "decisions": decisions,
        "trades": trades,
        "final_equity": float(engine.equity()[0]),
    }
    with open(out, "w") as fh:
        json.dump(payload, fh)
    print(f"{len(decisions)} decisões, {len(trades)} operações, patrimônio final {payload['final_equity']:.6f}")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "/tmp/paridade.json")
