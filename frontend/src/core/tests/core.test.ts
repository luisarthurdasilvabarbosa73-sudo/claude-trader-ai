// Testes do motor que roda no celular (Node: node --test). Dados SINTÉTICOS.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { DEFAULT_CONFIG, TradingEngine } from "../engine.ts";
import { floorStep, validateMarketOrder } from "../filters.ts";
import * as ind from "../indicators.ts";
import { OrderRejected, PaperBroker } from "../paper.ts";
import { MemoryKV, Repo } from "../repo.ts";
import { ReplayMarket, replayCandle, syntheticFilters, syntheticSeries } from "../replay.ts";
import { brlToQuote, DEFAULT_RISK, sizePosition, validateRisk } from "../risk.ts";
import type { Analysis } from "../strategy.ts";
import { Strategy } from "../strategy.ts";

test("RSI idêntico à referência clássica de Wilder", () => {
  const c = [44.3389, 44.0902, 44.1497, 43.6124, 44.3278, 44.8264, 45.0955, 45.4245, 45.8433, 46.0826, 45.8931, 46.0328, 45.614,
    46.282, 46.282, 46.0028, 46.0328, 46.4116, 46.2222, 45.6439];
  assert.deepEqual(ind.rsi(c, 14).slice(14).map((x) => Math.round((x as number) * 100) / 100), [70.53, 66.32, 66.55, 69.41, 66.36, 57.97]);
  assert.equal(ind.ema([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 3)[9], 9);
});

test("arredondamento de lote sempre para baixo, sem erro de ponto flutuante", () => {
  assert.equal(floorStep(0.000129999, "0.00001"), 0.00012);
  assert.equal(floorStep(0.3, "0.1"), 0.3);
  assert.equal(floorStep(2.0979, "0.1"), 2.0);
  assert.equal(floorStep(1.0000000001, "0.001"), 1.0);
  const f = syntheticFilters("BTCUSDT", "BTC", "USDT");
  assert.ok(validateMarketOrder(f, 0.00004, 100000).some((e) => e.includes("NOTIONAL")));
  assert.deepEqual(validateMarketOrder(f, 0.00006, 100000), []);
});

test("limites rígidos de risco não podem ser ultrapassados", () => {
  assert.throws(() => validateRisk({ risk_per_trade_pct: 50 }));
  assert.throws(() => validateRisk({ max_total_exposure_pct: 100 }));
  assert.throws(() => validateRisk({ campo: 1 }));
  assert.equal(validateRisk({ risk_per_trade_pct: 1 }).risk_per_trade_pct, 1);
});

test("R$30: recusa BTC (poeira) e recusa quando o mínimo exigiria mais risco", () => {
  const eq = brlToQuote(30, 5.4, 0.001);
  const btc = syntheticFilters("BTCUSDT", "BTC", "USDT");
  const r = sizePosition("BTCUSDT", eq, eq, 0, 97000, 95500, btc, DEFAULT_RISK);
  assert.ok(!r.ok && r.reason.includes("poeira"));
  const x = syntheticFilters("XUSDT", "X", "USDT", "0.01", "0.0001", "0.0001");
  const wide = sizePosition("XUSDT", eq, eq, 0, 100, 94, x, DEFAULT_RISK);
  assert.ok(!wide.ok && wide.reason.includes("não aumenta o risco"));
  const ok = sizePosition("XUSDT", eq, eq, 0, 100, 99, x, DEFAULT_RISK);
  assert.ok(ok.ok, ok.reason);
  assert.ok(ok.risk_quote <= ok.max_risk_quote);
});

test("simulador: spread, slippage, taxas, poeira e idempotência", () => {
  const repo = new Repo(new MemoryKV());
  const b = new PaperBroker(repo, 0.001, 0.02);
  b.initialize("USDT", 10, {});
  const f = syntheticFilters("BTCUSDT", "BTC", "USDT");
  const book = { bid: 100000, ask: 100010, ts: 0 };
  const buy = b.marketBuy("BTCUSDT", 0.00007, book, f, "c1", 0);
  assert.ok(Math.abs(buy.price - 100010 * 1.0002) < 1e-6);
  assert.equal(buy.fee_asset, "BTC");
  const again = b.marketBuy("BTCUSDT", 0.00007, book, f, "c1", 0);
  assert.equal(repo.countOrders(), 1);
  assert.equal(again.price, buy.price);
  const sell = b.marketSell("BTCUSDT", b.balances().BTC, book, f, "c2", 1);
  assert.equal(sell.qty, 0.00006);
  assert.ok(b.balances().BTC > 0); // poeira
  assert.ok(b.balances().USDT < 10);
  const b2 = new PaperBroker(repo, 0.001, 0);
  b2.initialize("USDT", 10, {});
  b2.marketBuy("BTCUSDT", 0.00006, { bid: 100000, ask: 100000, ts: 0 }, f, "t1", 0);
  assert.throws(() => b2.marketSell("BTCUSDT", b2.balances().BTC, { bid: 99900, ask: 99910, ts: 1 }, f, "t2", 1), OrderRejected);
});

// ------------------------------------------------------------- motor + stub
class Stub extends Strategy {
  signal = false;
  stopPct = 1;
  tpPct = 3;
  override evaluate(symbol: string, candles: Parameters<Strategy["evaluate"]>[1], book: Parameters<Strategy["evaluate"]>[2], now: number, a: Parameters<Strategy["evaluate"]>[4]): Analysis {
    const base = super.evaluate(symbol, candles, book, now, { ...a, fast: true });
    const entry = book ? book.ask : 100;
    return { ...base, action: this.signal ? "COMPRAR" : "AGUARDAR", score: this.signal ? 80 : 0,
      gates: [{ key: "t", label: "teste", passed: this.signal, detail: "stub" }], entry,
      stop: entry * (1 - this.stopPct / 100), take_profit: entry * (1 + this.tpPct / 100), atr_5m: entry * 0.004 };
  }
}

function setup(kv = new MemoryKV()) {
  const n = 13_200;
  const s = { BTCUSDT: syntheticSeries(n, 100, 7) };
  const m = new ReplayMarket(s, { BTCUSDT: syntheticFilters("BTCUSDT", "BTC", "USDT") }, "USDT", 5.4, 0.02, true);
  for (let i = 0; i < 12_800; i++) m.pushClosed(i);
  const stub = new Stub();
  const repo = new Repo(kv);
  const eng = new TradingEngine({ ...DEFAULT_CONFIG, symbols: ["BTCUSDT"] }, repo, m, { strategy: stub, clock: () => m.now });
  let i = 12_800;
  const next = async (k = 1) => { for (let j = 0; j < k; j++) await replayCandle(m, eng, i++); };
  return { m, eng, stub, repo, next, kv };
}

test("parado: analisa mas nunca entra", async () => {
  const { eng, stub, next } = setup();
  stub.signal = true;
  await next(3);
  assert.equal(eng.positions.size, 0);
  assert.equal(eng.brain.latest.BTCUSDT.decision, "BLOQUEADA PELO RISCO");
});

test("ciclo completo, sem duplicidade e emergência", async () => {
  const { eng, stub, next, repo, m } = setup();
  await next(1);
  eng.start(m.now);
  stub.signal = true;
  await next(1);
  assert.equal(eng.positions.size, 1);
  await next(3);
  assert.equal(repo.countOrders(), 1); // sinal repetido não duplica
  const res = await eng.emergencyStop(m.now);
  assert.deepEqual(res.closed, ["BTCUSDT"]);
  assert.equal(eng.status, "EMERGENCIA");
  await next(2);
  assert.equal(eng.positions.size, 0);
  assert.equal(repo.closedPositions()[0].exit_reason, "EMERGENCIA");
});

test("dados desatualizados bloqueiam entradas", async () => {
  const { eng, stub, next, m } = setup();
  await next(1);
  eng.start(m.now);
  stub.signal = true;
  m.setPrices(12_801, "close", m.now);
  m.pushClosed(12_801);
  await eng.step(m.now + 60);
  assert.equal(eng.positions.size, 0);
  assert.ok((eng.brain.latest.BTCUSDT.blockers as string[]).some((b) => b.includes("desatualizada")));
});

test("reabrir o app restaura posições e conta (histórico salvo no aparelho)", async () => {
  const kv = new MemoryKV();
  const a = setup(kv);
  await a.next(1);
  a.eng.start(a.m.now);
  a.stub.signal = true;
  await a.next(1);
  const eq = a.eng.equity()[0];
  const eng2 = new TradingEngine({ ...DEFAULT_CONFIG, symbols: ["BTCUSDT"] }, new Repo(kv), a.m, { clock: () => a.m.now });
  assert.equal(eng2.positions.size, 1);
  assert.equal(eng2.status, "PARADO"); // ao reabrir, só volta a operar quando você toca em Iniciar
  assert.ok(Math.abs(eng2.equity()[0] - eq) < 1e-9);
});
