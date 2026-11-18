// Backtest no celular: download paginado (Binance simulada com dados SINTÉTICOS) + simulação.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { runBacktest, significance, simulate, WARMUP } from "../backtest.ts";
import { filtersFromExchangeInfo } from "../filters.ts";
import { syntheticInfo, syntheticSeries } from "../replay.ts";
import type { Candle } from "../types.ts";

const START = Date.UTC(2026, 9, 1);
const N = WARMUP + 1440 * 2;
const SERIES: Record<string, Candle[]> = {
  SOLUSDT: syntheticSeries(N, 100, 4, 0.00002, 0.0025, START),
  XRPUSDT: syntheticSeries(N, 100, 8, 0.00002, 0.0025, START),
};
const INFO = { SOLUSDT: syntheticInfo("SOLUSDT", "SOL", "USDT"), XRPUSDT: syntheticInfo("XRPUSDT", "XRP", "USDT") };

function fakeBinance() {
  const calls: string[] = [];
  const fetchMock = async (input: string | URL) => {
    const url = new URL(String(input));
    calls.push(url.pathname);
    const q = url.searchParams;
    let body: unknown;
    if (url.pathname === "/api/v3/exchangeInfo") {
      const wanted: string[] = JSON.parse(q.get("symbols") ?? "[]");
      body = { symbols: wanted.map((s) => (INFO as Record<string, unknown>)[s]).filter(Boolean) };
    } else if (url.pathname === "/api/v3/klines") {
      const sym = q.get("symbol")!;
      const start = Number(q.get("startTime") ?? 0), end = Number(q.get("endTime") ?? Infinity), limit = Number(q.get("limit") ?? 500);
      const src = sym === "USDTBRL" ? SERIES.SOLUSDT.map((c) => ({ ...c, open: 5.4, high: 5.4, low: 5.4, close: 5.4 })) : SERIES[sym];
      body = src.filter((c) => c.openTime >= start && c.openTime <= end).slice(0, limit)
        .map((c) => [c.openTime, String(c.open), String(c.high), String(c.low), String(c.close), String(c.volume), c.closeTime, String(c.quoteVolume), c.trades, "0", "0", "0"]);
    } else return new Response("{}", { status: 404 });
    return new Response(JSON.stringify(body), { status: 200 });
  };
  return { calls, fetchMock };
}

test("backtest baixa o histórico em páginas e usa o mesmo motor da simulação direta", async () => {
  const { calls, fetchMock } = fakeBinance();
  const original = globalThis.fetch;
  globalThis.fetch = fetchMock as typeof fetch;
  try {
    const end = SERIES.SOLUSDT[N - 1].closeTime + 1;
    const progress: string[] = [];
    const res = await runBacktest({ symbols: ["SOLUSDT", "XRPUSDT"], days: 2, capitalBrl: 100, endMs: end }, (p) => progress.push(p.phase));
    assert.ok(calls.filter((c) => c === "/api/v3/klines").length > 20, "download paginado (1000 por página)");
    assert.ok(progress.includes("baixando") && progress.includes("simulando"));
    assert.equal(res.brl_rate, 5.4);
    const m = res.metrics;
    assert.equal(m.trades, m.wins + m.losses);
    if (m.trades) assert.ok(m.fees > 0);
    assert.ok(Math.abs(m.net_pnl - res.trades.reduce((s, t) => s + (t.pnl_quote ?? 0), 0)) < 1e-9);
    const filters = Object.fromEntries(Object.entries(INFO).map(([k, v]) => [k, filtersFromExchangeInfo(v)]));
    const direct = await simulate(SERIES, filters, 5.4, 100);
    assert.equal(res.metrics.trades, direct.metrics.trades);
    assert.ok(Math.abs(res.metrics.end_equity - direct.metrics.end_equity) < 1e-9);
    console.log(`backtest: ${m.trades} operações, sinais ${res.signals}, retorno ${m.return_pct?.toFixed(2)}%, veredito: ${res.significance.verdict}`);
  } finally {
    globalThis.fetch = original;
  }
});

test("estatística honesta: amostra pequena nunca prova lucro", () => {
  assert.equal(significance([1, 2, 3]).evidence, false);
  assert.ok(significance([1, 2, 3]).verdict.includes("Apenas 3"));
  const good = Array.from({ length: 150 }, (_, i) => (i % 3 === 0 ? -1 : 1.2));
  assert.equal(significance(good).evidence, true);
  const noisy = Array.from({ length: 150 }, (_, i) => (i % 2 === 0 ? -1 : 1.01));
  assert.equal(significance(noisy).evidence, false);
});
