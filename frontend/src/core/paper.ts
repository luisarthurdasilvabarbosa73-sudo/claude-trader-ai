// PAPER TRADING — espelha backend/app/execution/paper.py.
// Compra no ASK + slippage, venda no BID - slippage, taxa da compra no ativo recebido,
// taxa da venda na moeda de cotação, arredondamento para baixo no stepSize (sobra poeira),
// rejeição por filtros como a Binance faria e idempotência por client_order_id.
import { roundQty, validateMarketOrder } from "./filters.ts";
import type { SymbolFilters } from "./filters.ts";
import type { Broker } from "./broker.ts";
import type { Repo } from "./repo.ts";
import type { Book, Fill } from "./types.ts";

export class OrderRejected extends Error {}

const STATE_KEY = "paper_account";
const clean = (v: number) => Math.round(v * 1e12) / 1e12;

export class PaperBroker implements Broker {
  readonly mode = "SIMULACAO" as const;
  readonly sendsOrders = false;
  repo: Repo;
  feeRate: number;
  slippage: number;
  private bal: Record<string, number>;
  meta: Record<string, unknown>;

  constructor(repo: Repo, feeRate: number, slippagePct: number) {
    this.repo = repo;
    this.feeRate = feeRate;
    this.slippage = slippagePct / 100;
    const st = repo.kvGet<{ balances?: Record<string, number>; meta?: Record<string, unknown> }>(STATE_KEY, {});
    this.bal = { ...(st.balances ?? {}) };
    this.meta = { ...(st.meta ?? {}) };
  }

  get initialized(): boolean { return !!this.meta.initialized; }

  initialize(quote: string, amount: number, meta: Record<string, unknown>) {
    this.bal = { [quote]: amount };
    this.meta = { initialized: true, ...meta };
    this.persist();
  }

  reset() { this.bal = {}; this.meta = {}; this.persist(); }

  reload() {
    const st = this.repo.kvGet<{ balances?: Record<string, number>; meta?: Record<string, unknown> }>(STATE_KEY, {});
    this.bal = { ...(st.balances ?? {}) };
    this.meta = { ...(st.meta ?? {}) };
  }

  updateCosts(feeRate: number, slippagePct: number) { this.feeRate = feeRate; this.slippage = slippagePct / 100; }

  private persist(bal = this.bal) {
    const b: Record<string, number> = {};
    for (const [k, v] of Object.entries(bal)) if (v !== 0) b[k] = v;
    this.repo.kvSet(STATE_KEY, { balances: b, meta: this.meta });
  }

  balances(): Record<string, number> { return { ...this.bal }; }

  marketBuy(symbol: string, qty: number, book: Book, f: SymbolFilters, cid: string, now: number): Fill {
    const existing = this.repo.getOrder(cid);
    if (existing) return existing;
    const ref = book.ask;
    const price = ref * (1 + this.slippage);
    const errors = validateMarketOrder(f, qty, price);
    if (errors.length) throw new OrderRejected(errors.join("; "));
    const cost = qty * price;
    const have = this.bal[f.quoteAsset] ?? 0;
    if (cost > have + 1e-12) throw new OrderRejected(`Saldo insuficiente: necessário ${cost.toFixed(6)} ${f.quoteAsset}, disponível ${have.toFixed(6)}`);
    const fee = qty * this.feeRate;
    const next = { ...this.bal };
    next[f.quoteAsset] = clean(have - cost);
    next[f.baseAsset] = clean((next[f.baseAsset] ?? 0) + qty - fee);
    const fill: Fill = { client_order_id: cid, symbol, side: "BUY", qty, price, quote_qty: cost, fee, fee_asset: f.baseAsset,
      fee_quote: fee * price, ts: now, mode: this.mode, reference_price: ref };
    this.repo.insertOrder(fill);
    this.persist(next);
    this.bal = next;
    return fill;
  }

  marketSell(symbol: string, qty: number, book: Book, f: SymbolFilters, cid: string, now: number): Fill {
    const existing = this.repo.getOrder(cid);
    if (existing) return existing;
    const held = this.bal[f.baseAsset] ?? 0;
    const q = roundQty(f, Math.min(qty, held));
    const ref = book.bid;
    const price = ref * (1 - this.slippage);
    const errors = validateMarketOrder(f, q, price);
    if (errors.length) throw new OrderRejected(errors.join("; "));
    const proceeds = q * price;
    const fee = proceeds * this.feeRate;
    const next = { ...this.bal };
    next[f.baseAsset] = clean(held - q);
    next[f.quoteAsset] = clean((next[f.quoteAsset] ?? 0) + proceeds - fee);
    const fill: Fill = { client_order_id: cid, symbol, side: "SELL", qty: q, price, quote_qty: proceeds, fee, fee_asset: f.quoteAsset,
      fee_quote: fee, ts: now, mode: this.mode, reference_price: ref };
    this.repo.insertOrder(fill);
    this.persist(next);
    this.bal = next;
    return fill;
  }
}
