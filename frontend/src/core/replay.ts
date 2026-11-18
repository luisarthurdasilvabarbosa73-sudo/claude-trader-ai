// Mercado de REPLAY (testes, comparação com a versão Python e modo de demonstração).
// Espelha backend/app/backtest/engine.py::ReplayMarket. Dados sintéticos são sempre identificados.
import { filtersFromExchangeInfo } from "./filters.ts";
import type { SymbolFilters } from "./filters.ts";
import { IncrementalAggregator } from "./market.ts";
import type { MarketData } from "./market.ts";
import { TIMEFRAMES } from "./types.ts";
import type { Book, Candle, TF } from "./types.ts";

export class ReplayMarket implements MarketData {
  sourceName = "historical";
  isSynthetic: boolean;
  symbols: string[];
  brlSymbol: string | null;
  fatalError: string | null = null;
  series: Record<string, Candle[]>;
  filters = new Map<string, SymbolFilters>();
  books = new Map<string, Book>();
  aggs: Record<string, Record<TF, IncrementalAggregator>> = {};
  brlRate: number | null;
  half: number;
  now = 0;

  constructor(series: Record<string, Candle[]>, filters: Record<string, SymbolFilters>, quote: string, brlRate: number | null,
    spreadPct = 0.02, synthetic = false) {
    this.series = series;
    this.symbols = Object.keys(series);
    this.brlSymbol = quote === "BRL" ? null : "USDTBRL";
    this.isSynthetic = synthetic;
    if (synthetic) this.sourceName = "synthetic";
    for (const [k, v] of Object.entries(filters)) this.filters.set(k, v);
    this.brlRate = brlRate;
    this.half = spreadPct / 200;
    for (const s of this.symbols) {
      this.aggs[s] = {} as Record<TF, IncrementalAggregator>;
      for (const tf of TIMEFRAMES) this.aggs[s][tf] = new IncrementalAggregator(tf);
    }
  }

  get length() { return this.series[this.symbols[0]].length; }

  pushClosed(i: number) {
    for (const s of this.symbols) {
      const c = this.series[s][i];
      for (const tf of TIMEFRAMES) this.aggs[s][tf].add({ ...c });
    }
  }

  setPrices(i: number, which: "open" | "low" | "high" | "close", now: number) {
    this.now = now;
    for (const s of this.symbols) {
      const px = this.series[s][i][which];
      this.books.set(s, { bid: px * (1 - this.half), ask: px * (1 + this.half), ts: now });
    }
    if (this.brlSymbol && this.brlRate) this.books.set(this.brlSymbol, { bid: this.brlRate, ask: this.brlRate, ts: now });
  }

  getCandles(symbol: string, tf: TF) { return this.aggs[symbol]?.[tf]?.series ?? []; }
  getBook(symbol: string) { return this.books.get(symbol) ?? null; }
  getFilters(symbol: string) { return this.filters.get(symbol) ?? null; }
  brlBook() { return this.brlSymbol ? this.getBook(this.brlSymbol) : null; }
  health(now: number) {
    const ages: Record<string, number> = {};
    for (const [s, b] of this.books) ages[s] = Math.round((now - b.ts) * 10) / 10;
    return { source: this.sourceName, synthetic: this.isSynthetic, fatal_error: this.fatalError, book_age_s: ages };
  }
}

/** Ciclo idêntico ao do backtest Python: abertura -> mínima -> máxima -> fechamento. */
export function replayCandle(m: ReplayMarket, engine: { step(now: number): void }, i: number) {
  const t = m.series[m.symbols[0]][i].openTime / 1000;
  for (const [which, off] of [["open", 1], ["low", 20], ["high", 40], ["close", 59]] as const) {
    m.setPrices(i, which, t + off);
    engine.step(t + off);
  }
  m.pushClosed(i);
}

// --------------------------------------------- dados SINTÉTICOS (só testes/demo)
function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function syntheticSeries(n: number, startPrice: number, seed: number, drift = 0.00002, vol = 0.0025,
  startMs = Math.floor(Date.now() / 60_000) * 60_000 - n * 60_000): Candle[] {
  const rnd = mulberry32(seed);
  const gauss = () => Math.sqrt(-2 * Math.log(rnd() || 1e-12)) * Math.cos(2 * Math.PI * rnd());
  const out: Candle[] = [];
  let price = startPrice;
  for (let i = 0; i < n; i++) {
    const o = price;
    const c = o * Math.exp(drift + vol * gauss());
    const h = Math.max(o, c) * (1 + Math.abs(gauss()) * vol * 0.6);
    const l = Math.min(o, c) * (1 - Math.abs(gauss()) * vol * 0.6);
    const v = 50 * Math.exp(gauss() * 0.5);
    const t = startMs + i * 60_000;
    out.push({ openTime: t, open: o, high: h, low: l, close: c, volume: v, closeTime: t + 59_999, quoteVolume: v * c, trades: Math.trunc(v), closed: true });
    price = c;
  }
  return out;
}

export function syntheticFilters(symbol: string, base: string, quote: string, tick = "0.01", step = "0.00001", minQty = "0.00001", minNotional = "5"): SymbolFilters {
  return filtersFromExchangeInfo({
    symbol, baseAsset: base, quoteAsset: quote, status: "TRADING", isSpotTradingAllowed: true, orderTypes: ["LIMIT", "MARKET"],
    filters: [
      { filterType: "PRICE_FILTER", minPrice: tick, maxPrice: "1000000", tickSize: tick },
      { filterType: "LOT_SIZE", minQty, maxQty: "9000", stepSize: step },
      { filterType: "MARKET_LOT_SIZE", minQty: "0", maxQty: "100", stepSize: "0" },
      { filterType: "NOTIONAL", minNotional, applyMinToMarket: true, maxNotional: "9000000", applyMaxToMarket: false, avgPriceMins: 5 },
    ],
  });
}
