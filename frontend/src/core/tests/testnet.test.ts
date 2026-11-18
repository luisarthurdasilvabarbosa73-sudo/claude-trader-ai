// Testnet: assinatura, ordens, stop na corretora, status desconhecido e conciliação,
// contra uma CORRETORA SIMULADA que segue o protocolo da API WebSocket oficial.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { DEFAULT_CONFIG, TradingEngine } from "../engine.ts";
import { MemoryKV, Repo } from "../repo.ts";
import { ReplayMarket, replayCandle, syntheticFilters, syntheticSeries } from "../replay.ts";
import { hmacSha256Hex, signaturePayload, SignedWsApi } from "../signed.ts";
import type { WsLike } from "../signed.ts";
import { Strategy } from "../strategy.ts";
import type { Analysis } from "../strategy.ts";
import { TestnetBroker } from "../testnet.ts";
import type { Book } from "../types.ts";

const KEY = "chave-de-teste";
const SECRET = "segredo-de-teste";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Order = Record<string, any>;

class FakeExchange {
  bal: Record<string, { free: number; locked: number }> = { USDT: { free: 10_000, locked: 0 }, BTC: { free: 1, locked: 0 } };
  orders = new Map<string, Order>();
  placed: Order[] = [];
  dropNextReply = false;
  canTrade = true;
  badSignatures = 0;
  book: () => Book;
  constructor(book: () => Book) { this.book = book; }

  factory = (_url: string): WsLike => {
    const ws: WsLike = {
      readyState: 0, onopen: null, onmessage: null, onclose: null, onerror: null,
      send: (data: string) => { void this.handle(ws, JSON.parse(data)); },
      close: () => { ws.readyState = 3; ws.onclose?.({}); },
    };
    setTimeout(() => { ws.readyState = 1; ws.onopen?.({}); }, 0);
    return ws;
  };

  private reply(ws: WsLike, id: string, status: number, body: unknown) {
    const msg = status === 200 ? { id, status, result: body } : { id, status, error: body };
    setTimeout(() => ws.onmessage?.({ data: JSON.stringify(msg) }), 0);
  }

  private b(asset: string) { return (this.bal[asset] ??= { free: 0, locked: 0 }); }

  async handle(ws: WsLike, req: { id: string; method: string; params: Record<string, string> }) {
    const p = req.params;
    if (p.signature) {
      const expected = await hmacSha256Hex(SECRET, signaturePayload(p));
      if (expected !== p.signature || p.apiKey !== KEY) { this.badSignatures++; return this.reply(ws, req.id, 400, { code: -1022, msg: "Signature for this request is not valid." }); }
    }
    const [base, quote] = ["BTC", "USDT"];
    switch (req.method) {
      case "time": return this.reply(ws, req.id, 200, { serverTime: Date.now() });
      case "account.status":
        return this.reply(ws, req.id, 200, { canTrade: this.canTrade,
          balances: Object.entries(this.bal).map(([asset, v]) => ({ asset, free: String(v.free), locked: String(v.locked) })) });
      case "order.place": {
        const cid = p.newClientOrderId;
        if (this.orders.get(cid)?.status === "NEW") return this.reply(ws, req.id, 400, { code: -2010, msg: "Duplicate order sent." });
        const qty = Number(p.quantity);
        let o: Order;
        if (p.type === "MARKET") {
          const bk = this.book();
          const px = p.side === "BUY" ? bk.ask : bk.bid;
          if (p.side === "BUY") {
            if (this.b(quote).free < qty * px) return this.reply(ws, req.id, 400, { code: -2010, msg: "Account has insufficient balance" });
            this.b(quote).free -= qty * px;
            this.b(base).free += qty * 0.999;
            o = { clientOrderId: cid, symbol: p.symbol, side: "BUY", type: "MARKET", status: "FILLED", executedQty: String(qty),
              cummulativeQuoteQty: String(qty * px), fills: [{ price: String(px), qty: String(qty), commission: String(qty * 0.001), commissionAsset: base }] };
          } else {
            if (this.b(base).free < qty - 1e-12) return this.reply(ws, req.id, 400, { code: -2010, msg: "Account has insufficient balance" });
            this.b(base).free -= qty;
            this.b(quote).free += qty * px * 0.999;
            o = { clientOrderId: cid, symbol: p.symbol, side: "SELL", type: "MARKET", status: "FILLED", executedQty: String(qty),
              cummulativeQuoteQty: String(qty * px), fills: [{ price: String(px), qty: String(qty), commission: String(qty * px * 0.001), commissionAsset: quote }] };
          }
        } else if (p.type === "STOP_LOSS_LIMIT") {
          if (this.b(base).free < qty - 1e-12) return this.reply(ws, req.id, 400, { code: -2010, msg: "Account has insufficient balance" });
          this.b(base).free -= qty;
          this.b(base).locked += qty;
          o = { clientOrderId: cid, symbol: p.symbol, side: "SELL", type: p.type, status: "NEW", origQty: String(qty), executedQty: "0",
            cummulativeQuoteQty: "0", stopPrice: p.stopPrice, price: p.price };
        } else return this.reply(ws, req.id, 400, { code: -1116, msg: "Invalid orderType." });
        this.orders.set(cid, o);
        this.placed.push({ ...o });
        if (this.dropNextReply) { this.dropNextReply = false; return; } // executa, mas a resposta "se perde"
        return this.reply(ws, req.id, 200, o);
      }
      case "order.status": {
        const o = this.orders.get(p.origClientOrderId);
        return o ? this.reply(ws, req.id, 200, o) : this.reply(ws, req.id, 400, { code: -2013, msg: "Order does not exist." });
      }
      case "order.cancel": {
        const o = this.orders.get(p.origClientOrderId);
        if (!o || o.status !== "NEW") return this.reply(ws, req.id, 400, { code: -2011, msg: "Unknown order sent." });
        o.status = "CANCELED";
        this.b(base).locked -= Number(o.origQty);
        this.b(base).free += Number(o.origQty);
        return this.reply(ws, req.id, 200, o);
      }
    }
    return this.reply(ws, req.id, 400, { code: -1, msg: "método desconhecido" });
  }

  /** Simula o gatilho do stop na corretora (ex.: enquanto o app estava fechado). */
  triggerStop(cid: string, price: number) {
    const o = this.orders.get(cid)!;
    const qty = Number(o.origQty);
    this.b("BTC").locked -= qty;
    this.b("USDT").free += qty * price * 0.999;
    Object.assign(o, { status: "FILLED", executedQty: String(qty), cummulativeQuoteQty: String(qty * price) });
  }

  open() { return [...this.orders.values()].filter((o) => o.status === "NEW"); }
}

class Stub extends Strategy {
  signal = false;
  override evaluate(symbol: string, c: Parameters<Strategy["evaluate"]>[1], book: Parameters<Strategy["evaluate"]>[2], now: number, a: Parameters<Strategy["evaluate"]>[4]): Analysis {
    const base = super.evaluate(symbol, c, book, now, { ...a, fast: true });
    const e = book ? book.ask : 100;
    return { ...base, action: this.signal ? "COMPRAR" : "AGUARDAR", score: this.signal ? 80 : 0,
      gates: [{ key: "t", label: "teste", passed: this.signal, detail: "stub" }], entry: e, stop: e * 0.99, take_profit: e * 1.05, atr_5m: e * 0.004 };
  }
}

function setup(kv = new MemoryKV(), ex?: FakeExchange) {
  const n = 13_200;
  const m = new ReplayMarket({ BTCUSDT: syntheticSeries(n, 100, 7) }, {
    BTCUSDT: { ...syntheticFilters("BTCUSDT", "BTC", "USDT"), orderTypes: ["LIMIT", "MARKET", "STOP_LOSS_LIMIT"] } }, "USDT", 5.4, 0.02, true);
  for (let i = 0; i < 12_800; i++) m.pushClosed(i);
  const exchange = ex ?? new FakeExchange(() => m.getBook("BTCUSDT")!);
  exchange.book = () => m.getBook("BTCUSDT")!;
  const api = new SignedWsApi("wss://ws-api.testnet.binance.vision/ws-api/v3", KEY, SECRET, { wsFactory: exchange.factory, timeoutMs: 80 });
  const repo = new Repo(kv);
  const broker = new TestnetBroker(repo, api, 0.001);
  const stub = new Stub();
  const eng = new TradingEngine({ ...DEFAULT_CONFIG, symbols: ["BTCUSDT"] }, repo, m, { strategy: stub, clock: () => m.now, broker });
  let i = 12_800;
  const next = async (k = 1) => { for (let j = 0; j < k; j++) await replayCandle(m, eng, i++); };
  const setBid = async (bid: number) => { m.now += 1; m.books.set("BTCUSDT", { bid, ask: bid * 1.0002, ts: m.now }); await eng.step(m.now); };
  return { m, eng, stub, repo, next, exchange, setBid, kv };
}

test("assinatura confere com os exemplos oficiais da Binance (REST e API WebSocket)", async () => {
  const secret = "NhqPtmdSJYdKjVHjA7PZj4Mge3R5YNiP1e3UZjInClVN65XAbvqqM6A7H5fATj0j";
  assert.equal(await hmacSha256Hex(secret, "symbol=LTCBTC&side=BUY&type=LIMIT&timeInForce=GTC&quantity=1&price=0.1&recvWindow=5000&timestamp=1499827319559"),
    "c8db56825ae71d6d79447849e617115f4a920fa2acdcab2b053c4b2838bd6b71");
  const p = { symbol: "BTCUSDT", side: "SELL", type: "LIMIT", timeInForce: "GTC", quantity: "0.01000000", price: "52000.00",
    newOrderRespType: "ACK", recvWindow: 100, timestamp: 1645423376532, apiKey: "vmPUZE6mv9SD5VNHk4HlWFsOr6aKE2zvsw0MuIgwCIPy6utIco14y7Ju91duEh8A" };
  assert.equal(await hmacSha256Hex(secret, signaturePayload(p)), "cc15477742bd704c29492d96c7ead9414dfd8e0ec4a00f947bb5bb454ddbd08a");
});

test("Testnet: capital separado, compra, stop NA CORRETORA, break-even move o stop, alvo cancela o stop e vende", async () => {
  const { eng, stub, next, exchange, setBid, repo, m } = setup();
  await next(1);
  assert.ok(eng.accountReady());
  assert.ok(Math.abs(eng.equity()[0] - (30 / 5.4) * 0.999) < 1e-6, "robô usa só o capital separado, não os 10.000 USDT de teste");
  eng.start(m.now);
  stub.signal = true;
  await next(1);
  stub.signal = false;
  const pos = eng.positions.get("BTCUSDT")!;
  assert.ok(pos && pos.protect_order_id, "posição aberta com stop registrado na corretora");
  const stop1 = exchange.open()[0];
  assert.equal(stop1.type, "STOP_LOSS_LIMIT");
  assert.ok(Math.abs(Number(stop1.stopPrice) - pos.stop_price) < 0.011);
  const r = pos.entry_price - pos.initial_stop;
  await setBid(pos.entry_price + r * 1.05); // 1R: break-even
  const opens = exchange.open();
  assert.equal(opens.length, 1, "stop antigo cancelado e substituído");
  assert.ok(Number(opens[0].stopPrice) > pos.entry_price, "stop novo acima da entrada");
  await setBid(pos.take_profit * 1.001);
  assert.equal(eng.positions.size, 0);
  assert.equal(exchange.open().length, 0, "nenhuma ordem esquecida na corretora");
  const t = repo.closedPositions()[0];
  assert.equal(t.exit_reason, "TAKE_PROFIT");
  assert.ok((t.pnl_quote ?? 0) > 0);
  assert.equal(exchange.badSignatures, 0);
});

test("stop executado pela corretora com o app FECHADO é reconhecido ao reabrir", async () => {
  const kv = new MemoryKV();
  const a = setup(kv);
  await a.next(1);
  a.eng.start(a.m.now);
  a.stub.signal = true;
  await a.next(1);
  const pos = a.eng.positions.get("BTCUSDT")!;
  // app fechado: a corretora executa o stop
  a.exchange.triggerStop(pos.protect_order_id!, pos.stop_price * 0.999);
  const b = setup(kv, a.exchange); // app reaberto (mesmo armazenamento, mesma conta)
  assert.equal(b.eng.positions.size, 1);
  await b.next(1);
  assert.equal(b.eng.positions.size, 0);
  const t = b.repo.closedPositions()[0];
  assert.equal(t.exit_reason, "STOP_CORRETORA");
  assert.ok((t.pnl_quote ?? 0) < 0);
});

test("resposta perdida: o robô consulta a ordem e NÃO compra duas vezes", async () => {
  const { eng, stub, next, exchange, m } = setup();
  await next(1);
  eng.start(m.now);
  exchange.dropNextReply = true;
  stub.signal = true;
  await next(1);
  const buys = exchange.placed.filter((o) => o.type === "MARKET" && o.side === "BUY");
  assert.equal(buys.length, 1, "uma única compra na corretora");
  assert.equal(eng.positions.size, 1);
});

test("conciliação: saldo diferente na conta pausa novas entradas", async () => {
  const { eng, stub, next, exchange, m } = setup();
  await next(1);
  eng.start(m.now);
  stub.signal = true;
  await next(1);
  stub.signal = false;
  exchange.bal.BTC = { free: 0, locked: 0 }; // alguém mexeu na conta
  await next(2);
  assert.ok(eng.risk.state.pause_until > m.now);
  assert.ok(eng.repo.recentEvents(20, "CRITICO").some((e) => e.message.includes("Conciliação")));
});

test("sem saldo de teste ou sem permissão: o robô não cria o capital", async () => {
  const ex = new FakeExchange(() => ({ bid: 100, ask: 100, ts: 0 }));
  ex.bal.USDT.free = 1;
  const { eng, next } = setup(new MemoryKV(), ex);
  await next(1);
  assert.equal(eng.accountReady(), false);
  assert.ok(eng.brain.activity.includes("saldo de teste insuficiente"));
});
