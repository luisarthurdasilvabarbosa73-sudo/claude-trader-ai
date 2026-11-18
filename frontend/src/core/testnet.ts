// EXECUTOR TESTNET — ordens de verdade no ambiente de TESTES da Binance (dinheiro fictício).
// Arquivo separado do simulador. O app não contém nenhum endereço de negociação da conta real.
//
// - Capital do robô separado (ex.: R$30) mesmo que a conta de testes tenha muito mais saldo.
// - Ordem a mercado com ID próprio (newClientOrderId): se a resposta não chegar, o robô CONSULTA
//   a ordem antes de qualquer nova tentativa (nunca duplica).
// - Stop-loss registrado NA CORRETORA (STOP_LOSS_LIMIT): protege mesmo com o app fechado.
// - Conciliação periódica com o saldo real da conta.
import type { Broker } from "./broker.ts";
import { roundPrice, roundQty, stepDecimals, qtyStep, validateMarketOrder } from "./filters.ts";
import type { SymbolFilters } from "./filters.ts";
import { OrderRejected } from "./paper.ts";
import type { Repo } from "./repo.ts";
import { ExchangeError, UnknownStatus } from "./signed.ts";
import type { SignedWsApi } from "./signed.ts";
import type { Book, Fill, Position } from "./types.ts";

const STATE_KEY = "testnet_account";
const clean = (v: number) => Math.round(v * 1e12) / 1e12;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const FINAL_FAIL = new Set(["CANCELED", "EXPIRED", "REJECTED", "EXPIRED_IN_MATCH"]);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type OrderResult = any;

export class TestnetBroker implements Broker {
  readonly mode = "TESTNET" as const;
  readonly sendsOrders = true;
  repo: Repo;
  api: SignedWsApi;
  feeRate: number;
  meta: Record<string, unknown>;
  private bal: Record<string, number>;
  private pendingStopFill = new Map<number, Fill>();

  constructor(repo: Repo, api: SignedWsApi, feeRate: number) {
    this.repo = repo;
    this.api = api;
    this.feeRate = feeRate;
    const st = repo.kvGet<{ balances?: Record<string, number>; meta?: Record<string, unknown> }>(STATE_KEY, {});
    this.bal = { ...(st.balances ?? {}) };
    this.meta = { ...(st.meta ?? {}) };
  }

  get initialized(): boolean { return !!this.meta.initialized; }
  balances() { return { ...this.bal }; }
  updateCosts(feeRate: number) { this.feeRate = feeRate; }
  reload() {
    const st = this.repo.kvGet<{ balances?: Record<string, number>; meta?: Record<string, unknown> }>(STATE_KEY, {});
    this.bal = { ...(st.balances ?? {}) };
    this.meta = { ...(st.meta ?? {}) };
  }
  reset() { this.bal = {}; this.meta = {}; this.persist(); }
  private persist(bal = this.bal) {
    const b: Record<string, number> = {};
    for (const [k, v] of Object.entries(bal)) if (Math.abs(v) > 1e-15) b[k] = v;
    this.repo.kvSet(STATE_KEY, { balances: b, meta: this.meta });
  }

  /** Separa o capital do robô, conferindo que a conta de testes tem esse saldo livre. */
  async initialize(quote: string, amount: number, meta: Record<string, unknown>) {
    const acc = await this.api.call("account.status", { omitZeroBalances: true }, true);
    if (acc.canTrade === false) throw new Error("a chave da Testnet não tem permissão para negociar");
    const free = Number((acc.balances ?? []).find((b: { asset: string }) => b.asset === quote)?.free ?? 0);
    if (free < amount) throw new Error(`saldo de teste insuficiente: ${free.toFixed(2)} ${quote} livres, robô precisa de ${amount.toFixed(2)}`);
    const tag = Math.random().toString(36).slice(2, 6).toUpperCase();
    this.bal = { [quote]: amount };
    this.meta = { initialized: true, tag, ...meta, testnet_free_quote_at_start: free };
    this.persist();
  }

  // ------------------------------------------------------------- ordens
  private fmtQty(f: SymbolFilters, q: number) { return q.toFixed(stepDecimals(qtyStep(f))); }
  private fmtPrice(f: SymbolFilters, p: number) { return p.toFixed(stepDecimals(f.tickSize)); }

  /** Envia a ordem; se a resposta não chegar, consulta pelo ID antes de qualquer nova tentativa. */
  private async placeSafely(symbol: string, params: Record<string, string | number | boolean>, cid: string): Promise<OrderResult> {
    try {
      return await this.api.call("order.place", { ...params, newClientOrderId: cid, newOrderRespType: "FULL" }, true);
    } catch (e) {
      if (e instanceof ExchangeError) throw new OrderRejected(`Binance Testnet recusou: ${e.message}`);
      if (!(e instanceof UnknownStatus)) throw e;
      for (let attempt = 0; attempt < 3; attempt++) {
        await sleep(800 * (attempt + 1));
        try {
          return await this.api.call("order.status", { symbol, origClientOrderId: cid }, true); // a ordem existe: usa ela
        } catch (e2) {
          if (e2 instanceof ExchangeError && e2.code === -2013) {
            // a ordem comprovadamente não existe: é seguro enviar de novo (mesmo ID)
            return await this.api.call("order.place", { ...params, newClientOrderId: cid, newOrderRespType: "FULL" }, true);
          }
        }
      }
      throw new UnknownStatus(`status da ordem ${cid} desconhecido após 3 consultas`);
    }
  }

  private toFill(res: OrderResult, symbol: string, side: "BUY" | "SELL", cid: string, now: number, ref: number, f: SymbolFilters): Fill {
    const qty = Number(res.executedQty ?? 0);
    const quoteQty = Number(res.cummulativeQuoteQty ?? 0);
    if (!(qty > 0)) throw new OrderRejected(`Ordem ${cid} não executada (status ${res.status ?? "?"})`);
    const price = quoteQty / qty;
    let fee = 0;
    let feeAsset = "";
    if (Array.isArray(res.fills) && res.fills.length) {
      for (const x of res.fills) fee += Number(x.commission ?? 0);
      feeAsset = String(res.fills[0].commissionAsset ?? "");
    } else {
      // consulta de ordem não traz as taxas: estimativa conservadora pela taxa padrão
      fee = side === "BUY" ? qty * this.feeRate : quoteQty * this.feeRate;
      feeAsset = side === "BUY" ? f.baseAsset : f.quoteAsset;
    }
    const feeQuote = feeAsset === f.baseAsset ? fee * price : feeAsset === f.quoteAsset ? fee : 0;
    return { client_order_id: cid, symbol, side, qty, price, quote_qty: quoteQty, fee, fee_asset: feeAsset, fee_quote: feeQuote,
      ts: now, mode: this.mode, reference_price: ref };
  }

  private applyFill(fill: Fill, f: SymbolFilters) {
    const next = { ...this.bal };
    if (fill.side === "BUY") {
      next[f.quoteAsset] = clean((next[f.quoteAsset] ?? 0) - fill.quote_qty - (fill.fee_asset === f.quoteAsset ? fill.fee : 0));
      next[f.baseAsset] = clean((next[f.baseAsset] ?? 0) + fill.qty - (fill.fee_asset === f.baseAsset ? fill.fee : 0));
    } else {
      next[f.baseAsset] = clean((next[f.baseAsset] ?? 0) - fill.qty - (fill.fee_asset === f.baseAsset ? fill.fee : 0));
      next[f.quoteAsset] = clean((next[f.quoteAsset] ?? 0) + fill.quote_qty - (fill.fee_asset === f.quoteAsset ? fill.fee : 0));
    }
    this.repo.insertOrder(fill);
    this.persist(next);
    this.bal = next;
  }

  async marketBuy(symbol: string, qty: number, book: Book, f: SymbolFilters, cid: string, now: number): Promise<Fill> {
    const existing = this.repo.getOrder(cid);
    if (existing) return existing;
    const errors = validateMarketOrder(f, qty, book.ask);
    if (errors.length) throw new OrderRejected(errors.join("; "));
    const need = qty * book.ask * 1.003;
    const have = this.bal[f.quoteAsset] ?? 0;
    if (need > have) throw new OrderRejected(`Capital do robô insuficiente: necessário ~${need.toFixed(4)} ${f.quoteAsset}, disponível ${have.toFixed(4)}`);
    const res = await this.placeSafely(symbol, { symbol, side: "BUY", type: "MARKET", quantity: this.fmtQty(f, qty) }, cid);
    const fill = this.toFill(res, symbol, "BUY", cid, now, book.ask, f);
    this.applyFill(fill, f);
    return fill;
  }

  async marketSell(symbol: string, qty: number, book: Book, f: SymbolFilters, cid: string, now: number): Promise<Fill> {
    const existing = this.repo.getOrder(cid);
    if (existing) return existing;
    const q = roundQty(f, Math.min(qty, this.bal[f.baseAsset] ?? 0));
    const errors = validateMarketOrder(f, q, book.bid);
    if (errors.length) throw new OrderRejected(errors.join("; "));
    const res = await this.placeSafely(symbol, { symbol, side: "SELL", type: "MARKET", quantity: this.fmtQty(f, q) }, cid);
    const fill = this.toFill(res, symbol, "SELL", cid, now, book.bid, f);
    this.applyFill(fill, f);
    return fill;
  }

  // ------------------------------------------------- stop na corretora
  private stopFillFrom(st: OrderResult, pos: Position, f: SymbolFilters, now: number): Fill {
    const cid = String(st.clientOrderId ?? pos.protect_order_id);
    const existing = this.repo.getOrder(cid);
    if (existing) return existing;
    const fill = this.toFill(st, pos.symbol, "SELL", cid, now, Number(st.price ?? pos.stop_price), f);
    this.applyFill(fill, f);
    return fill;
  }

  async protect(pos: Position, f: SymbolFilters, now: number) {
    if (!f.orderTypes.includes("STOP_LOSS_LIMIT")) throw new Error(`${pos.symbol} não aceita ordens STOP_LOSS_LIMIT`);
    if (pos.protect_order_id) {
      const done = await this.unprotect(pos, f, now);
      pos.protect_order_id = null;
      if (done) { this.pendingStopFill.set(pos.id ?? 0, done); return; }
    }
    const qty = roundQty(f, Math.min(pos.qty, this.bal[f.baseAsset] ?? 0));
    const stop = roundPrice(f, pos.stop_price);
    const limit = roundPrice(f, pos.stop_price * 0.995); // limite abaixo do gatilho para garantir a execução
    const seq = (Number(this.meta[`seq_${pos.id}`] ?? 0) || 0) + 1;
    this.meta[`seq_${pos.id}`] = seq;
    this.persist();
    const cid = `CTA${this.meta.tag ?? ""}-${pos.id}-P${seq}`;
    try {
      await this.api.call("order.place", { symbol: pos.symbol, side: "SELL", type: "STOP_LOSS_LIMIT", timeInForce: "GTC",
        quantity: this.fmtQty(f, qty), price: this.fmtPrice(f, limit), stopPrice: this.fmtPrice(f, stop), newClientOrderId: cid }, true);
    } catch (e) {
      if (e instanceof UnknownStatus) {
        const st = await this.api.call("order.status", { symbol: pos.symbol, origClientOrderId: cid }, true);
        if (FINAL_FAIL.has(st.status)) throw new Error(`stop recusado (${st.status})`);
      } else throw e;
    }
    pos.protect_order_id = cid;
  }

  async unprotect(pos: Position, f: SymbolFilters, now: number): Promise<Fill | null> {
    const pending = this.pendingStopFill.get(pos.id ?? 0);
    if (pending) { this.pendingStopFill.delete(pos.id ?? 0); return pending; }
    const cid = pos.protect_order_id;
    if (!cid) return null;
    try {
      await this.api.call("order.cancel", { symbol: pos.symbol, origClientOrderId: cid }, true);
      return null;
    } catch (e) {
      const st = await this.api.call("order.status", { symbol: pos.symbol, origClientOrderId: cid }, true);
      if (st.status === "FILLED") return this.stopFillFrom(st, pos, f, now);
      if (FINAL_FAIL.has(st.status)) return null;
      throw e;
    }
  }

  async checkProtection(pos: Position, f: SymbolFilters, now: number): Promise<Fill | null> {
    const pending = this.pendingStopFill.get(pos.id ?? 0);
    if (pending) { this.pendingStopFill.delete(pos.id ?? 0); return pending; }
    if (!pos.protect_order_id) return null;
    const st = await this.api.call("order.status", { symbol: pos.symbol, origClientOrderId: pos.protect_order_id }, true);
    if (st.status === "FILLED") return this.stopFillFrom(st, pos, f, now);
    if (FINAL_FAIL.has(st.status)) pos.protect_order_id = null; // o robô registra um novo stop
    return null;
  }

  /** O saldo real da conta precisa cobrir tudo o que o robô acha que tem. */
  async reconcile(): Promise<string[]> {
    const acc = await this.api.call("account.status", { omitZeroBalances: true }, true);
    const real = new Map<string, number>();
    for (const b of acc.balances ?? []) real.set(b.asset, Number(b.free) + Number(b.locked));
    const issues: string[] = [];
    for (const [asset, qty] of Object.entries(this.bal)) {
      if (qty <= 1e-12) continue;
      const have = real.get(asset) ?? 0;
      if (have + 1e-9 < qty * 0.999) issues.push(`Conciliação: robô registra ${qty} ${asset}, mas a conta de testes tem ${have}. Alguém movimentou a conta?`);
    }
    return issues;
  }
}
