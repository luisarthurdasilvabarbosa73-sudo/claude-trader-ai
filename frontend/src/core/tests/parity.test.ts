// PARIDADE: o motor do app (TypeScript) precisa tomar EXATAMENTE as mesmas decisões que o
// motor Python de referência sobre os mesmos dados. Fixture gerada por backend/scripts/gerar_paridade.py.
import { strict as assert } from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { simulate } from "../backtest.ts";
import { DEFAULT_CONFIG, TradingEngine } from "../engine.ts";
import { filtersFromExchangeInfo } from "../filters.ts";
import { MemoryKV, Repo } from "../repo.ts";
import { ReplayMarket, replayCandle } from "../replay.ts";
import type { Candle } from "../types.ts";

const FIXTURE = process.env.PARIDADE ?? "/tmp/paridade.json";

test("backtest do app reproduz as operações do motor Python", { skip: !existsSync(FIXTURE) && "fixture ausente" }, async () => {
  const fx = JSON.parse(readFileSync(FIXTURE, "utf8"));
  const series: Record<string, Candle[]> = {};
  for (const [s, rows] of Object.entries(fx.candles as Record<string, number[][]>)) {
    series[s] = rows.map(([t, o, h, l, c, v]) => ({ openTime: t, open: o, high: h, low: l, close: c, volume: v,
      closeTime: t + 59_999, quoteVolume: v * c, trades: Math.trunc(v), closed: true }));
  }
  const filters = Object.fromEntries(Object.entries(fx.exchange_info).map(([k, v]) => [k, filtersFromExchangeInfo(v)]));
  const res = await simulate(series, filters, fx.brl_rate, fx.initial_brl, { warmup: fx.warmup, synthetic: true });
  assert.equal(res.trades.length, fx.trades.length);
  res.trades.forEach((t, i) => {
    assert.equal(t.exit_reason, fx.trades[i].exit_reason);
    assert.ok(Math.abs((t.pnl_quote ?? 0) - fx.trades[i].pnl_quote) < 1e-6);
  });
});

test("motor do app decide igual ao motor Python de referência", { skip: !existsSync(FIXTURE) && "fixture ausente" }, async () => {
  const fx = JSON.parse(readFileSync(FIXTURE, "utf8"));
  const series: Record<string, Candle[]> = {};
  for (const [s, rows] of Object.entries(fx.candles as Record<string, number[][]>)) {
    series[s] = rows.map(([t, o, h, l, c, v]) => ({ openTime: t, open: o, high: h, low: l, close: c, volume: v,
      closeTime: t + 59_999, quoteVolume: v * c, trades: Math.trunc(v), closed: true }));
  }
  const filters = Object.fromEntries(Object.entries(fx.exchange_info).map(([k, v]) => [k, filtersFromExchangeInfo(v)]));
  const m = new ReplayMarket(series, filters, "USDT", fx.brl_rate, 0.02, true);
  for (let i = 0; i < fx.warmup; i++) m.pushClosed(i);
  const repo = new Repo(new MemoryKV(), { decisions: 1_000_000, orders: 1_000_000 });
  const eng = new TradingEngine({ ...DEFAULT_CONFIG, symbols: Object.keys(series), initialCapitalBrl: fx.initial_brl }, repo, m,
    { clock: () => m.now });
  eng.start(series[m.symbols[0]][fx.warmup].openTime / 1000);
  for (let i = fx.warmup; i < m.length; i++) await replayCandle(m, eng, i);

  const ours = repo.recentDecisions(100_000).reverse();
  assert.equal(ours.length, fx.decisions.length, "quantidade de decisões");
  let diffs = 0;
  for (let i = 0; i < ours.length; i++) {
    const a = ours[i], b = fx.decisions[i];
    const same = a.ts === b.ts && a.symbol === b.symbol && a.action === b.action && Math.abs(a.score - b.score) < 1e-9 &&
      a.details.decision === b.decision && JSON.stringify(a.details.failed_gates) === JSON.stringify(b.failed_gates);
    if (!same && diffs++ < 5) console.log("DIFERENÇA", i, JSON.stringify({ ts: a.ts, sym: a.symbol, act: a.action, score: a.score, dec: a.details.decision, fg: a.details.failed_gates }), JSON.stringify(b));
  }
  assert.equal(diffs, 0, `${diffs} decisões diferentes`);

  const trades = repo.closedPositions({ limit: 100_000 }).reverse();
  assert.equal(trades.length, fx.trades.length, "quantidade de operações");
  trades.forEach((t, i) => {
    const r = fx.trades[i];
    assert.equal(t.symbol, r.symbol);
    assert.equal(t.entry_time, r.entry_time);
    assert.equal(t.exit_time, r.exit_time);
    assert.equal(t.exit_reason, r.exit_reason);
    assert.ok(Math.abs(t.entry_price / r.entry_price - 1) < 1e-9, "preço de entrada");
    assert.ok(Math.abs((t.pnl_quote ?? 0) - r.pnl_quote) < 1e-6, `resultado da operação ${i}: ${t.pnl_quote} vs ${r.pnl_quote}`);
  });
  assert.ok(Math.abs(eng.equity()[0] - fx.final_equity) < 1e-6, `patrimônio ${eng.equity()[0]} vs ${fx.final_equity}`);
  console.log(`paridade OK: ${ours.length} decisões e ${trades.length} operações idênticas; patrimônio ${eng.equity()[0].toFixed(6)}`);
});
