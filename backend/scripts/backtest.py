"""Backtest com dados históricos REAIS da Binance.

Uso (exemplo):
    python scripts/backtest.py --symbols BTCUSDT,ETHUSDT --start 2026-08-01 --end 2026-10-31

- Candles de 1m: arquivos oficiais de data.binance.vision (com checksum).
- Filtros de negociação: /api/v3/exchangeInfo (valores ATUAIS — premissa registrada no relatório).
- Cotação USDT/BRL: primeiro candle de USDTBRL do período (para converter R$30).
Gera reports/backtest-<data>.md e .json.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import date, datetime, timedelta
from decimal import Decimal

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.backtest.data import download_range  # noqa: E402
from app.backtest.engine import MIN_WARMUP, report_markdown, run_backtest  # noqa: E402
from app.binance.filters import SymbolFilters  # noqa: E402
from app.binance.rest import BinanceRest  # noqa: E402
from app.risk.settings import RiskSettings  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--symbols", default="BTCUSDT,ETHUSDT")
    ap.add_argument("--start", required=True, help="AAAA-MM-DD (início das operações)")
    ap.add_argument("--end", required=True, help="AAAA-MM-DD (fim, inclusive)")
    ap.add_argument("--capital-brl", default="30")
    ap.add_argument("--spread-pct", type=float, default=0.02)
    ap.add_argument("--cache", default="data/historico")
    ap.add_argument("--out", default="reports")
    args = ap.parse_args()

    symbols = [s.strip().upper() for s in args.symbols.split(",") if s.strip()]
    start = date.fromisoformat(args.start)
    end = date.fromisoformat(args.end)
    warm_days = MIN_WARMUP // 1440 + 1
    dl_start = start - timedelta(days=warm_days)

    print(f"Baixando dados reais de {dl_start} a {end} para {symbols}…")
    series = {s: download_range(s, dl_start, end, args.cache) for s in symbols}
    for s, ser in series.items():
        print(f"  {s}: {len(ser)} candles de 1m")
        if not ser:
            print(f"ERRO: sem dados para {s}")
            return 1

    brl = download_range("USDTBRL", start, start, args.cache)
    if not brl:
        print("ERRO: não foi possível obter a cotação real USDTBRL do início do período")
        return 1
    brl_rate = brl[0].close
    print(f"Cotação USDT/BRL real em {start}: {brl_rate}")

    rest = BinanceRest("https://data-api.binance.vision")
    info = rest.exchange_info(symbols)
    filters = {x["symbol"]: SymbolFilters.from_exchange_info(x) for x in info["symbols"]}

    warmup = sum(1 for c in next(iter(series.values()))
                 if c.open_time < datetime(start.year, start.month, start.day).timestamp() * 1000)
    warmup = max(warmup, MIN_WARMUP)
    res = run_backtest(series, filters, initial_brl=Decimal(args.capital_brl), brl_rate=brl_rate,
                       risk=RiskSettings(), spread_pct=args.spread_pct, warmup=warmup, progress=True)
    res.assumptions["filtros"] = "exchangeInfo atual da Binance (podem ter mudado no período)"
    os.makedirs(args.out, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M")
    title = f"Backtest {', '.join(symbols)} — {start} a {end}"
    md = report_markdown(res, title)
    with open(os.path.join(args.out, f"backtest-{stamp}.md"), "w") as fh:
        fh.write(md)
    with open(os.path.join(args.out, f"backtest-{stamp}.json"), "w") as fh:
        json.dump({"metrics": res.metrics, "significance": res.significance, "exit_reasons": res.exit_reasons,
                   "assumptions": res.assumptions, "trades": res.trades}, fh, indent=2, default=str)
    print(md)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
