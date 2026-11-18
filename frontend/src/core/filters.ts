// Filtros reais de negociação da Binance (de /api/v3/exchangeInfo) — espelha filters.py.
// Quantidades são arredondadas com aritmética inteira para evitar erros de ponto flutuante.

export interface SymbolFilters {
  symbol: string; baseAsset: string; quoteAsset: string; status: string; spotAllowed: boolean; orderTypes: string[];
  tickSize: string; minPrice: number; maxPrice: number;
  stepSize: string; minQty: number; maxQty: number;
  marketStepSize: string | null; marketMinQty: number | null; marketMaxQty: number | null;
  minNotional: number; applyMinToMarket: boolean; maxNotional: number | null; applyMaxToMarket: boolean;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function filtersFromExchangeInfo(info: any): SymbolFilters {
  const f: SymbolFilters = {
    symbol: info.symbol, baseAsset: info.baseAsset, quoteAsset: info.quoteAsset, status: info.status ?? "TRADING",
    spotAllowed: info.isSpotTradingAllowed ?? true, orderTypes: info.orderTypes ?? ["LIMIT", "MARKET"],
    tickSize: "0.00000001", minPrice: 0, maxPrice: 0, stepSize: "0.00000001", minQty: 0, maxQty: 0,
    marketStepSize: null, marketMinQty: null, marketMaxQty: null,
    minNotional: 0, applyMinToMarket: true, maxNotional: null, applyMaxToMarket: false,
  };
  for (const flt of info.filters ?? []) {
    switch (flt.filterType) {
      case "PRICE_FILTER":
        f.tickSize = flt.tickSize; f.minPrice = Number(flt.minPrice); f.maxPrice = Number(flt.maxPrice); break;
      case "LOT_SIZE":
        f.stepSize = flt.stepSize; f.minQty = Number(flt.minQty); f.maxQty = Number(flt.maxQty); break;
      case "MARKET_LOT_SIZE":
        f.marketStepSize = Number(flt.stepSize) > 0 ? flt.stepSize : null;
        f.marketMinQty = Number(flt.minQty);
        f.marketMaxQty = Number(flt.maxQty) > 0 ? Number(flt.maxQty) : null; break;
      case "NOTIONAL":
        f.minNotional = Number(flt.minNotional ?? 0); f.applyMinToMarket = flt.applyMinToMarket ?? true;
        f.maxNotional = flt.maxNotional !== undefined ? Number(flt.maxNotional) : null;
        f.applyMaxToMarket = flt.applyMaxToMarket ?? false; break;
      case "MIN_NOTIONAL":
        f.minNotional = Number(flt.minNotional ?? 0); f.applyMinToMarket = flt.applyToMarket ?? true; break;
    }
  }
  return f;
}

export function stepDecimals(step: string): number {
  const s = step.includes("e-") ? Number(step).toFixed(20) : step;
  const i = s.indexOf(".");
  if (i < 0) return 0;
  return s.slice(i + 1).replace(/0+$/, "").length;
}

/** Arredonda para BAIXO no múltiplo de `step` (nunca gasta mais do que o calculado). */
export function floorStep(value: number, step: string): number {
  const st = Number(step);
  if (!(st > 0) || !(value > 0)) return value > 0 ? value : 0;
  const d = stepDecimals(step);
  const factor = 10 ** d;
  const stepInt = Math.round(st * factor);
  const units = Math.floor(value * factor * (1 + 1e-12) + 1e-7);
  return (Math.floor(units / stepInt) * stepInt) / factor;
}

export function ceilStep(value: number, step: string): number {
  const st = Number(step);
  if (!(st > 0)) return value;
  const d = stepDecimals(step);
  const factor = 10 ** d;
  const stepInt = Math.round(st * factor);
  const units = Math.ceil(value * factor * (1 - 1e-12) - 1e-7);
  return (Math.ceil(units / stepInt) * stepInt) / factor;
}

export function qtyStep(f: SymbolFilters): string {
  if (f.marketStepSize && Number(f.marketStepSize) > Number(f.stepSize)) return f.marketStepSize;
  return f.stepSize;
}

export const roundQty = (f: SymbolFilters, qty: number) => floorStep(qty, qtyStep(f));
export const roundPrice = (f: SymbolFilters, price: number, up = false) => (up ? ceilStep(price, f.tickSize) : floorStep(price, f.tickSize));
export const effectiveMinNotional = (f: SymbolFilters) => (f.applyMinToMarket ? f.minNotional : 0);
export const minQtyMarket = (f: SymbolFilters) => f.marketMinQty || f.minQty;

export function validateMarketOrder(f: SymbolFilters, qty: number, price: number): string[] {
  const e: string[] = [];
  if (f.status !== "TRADING") e.push(`${f.symbol}: par não está em negociação (status ${f.status})`);
  if (!f.spotAllowed) e.push(`${f.symbol}: negociação Spot não permitida`);
  if (!f.orderTypes.includes("MARKET")) e.push(`${f.symbol}: ordens a mercado não suportadas`);
  if (!(qty > 0)) { e.push("quantidade deve ser maior que zero"); return e; }
  const minQ = minQtyMarket(f);
  const maxQ = f.marketMaxQty || f.maxQty;
  if (qty < minQ - 1e-15) e.push(`LOT_SIZE: quantidade ${qty} abaixo do mínimo ${minQ}`);
  if (maxQ && qty > maxQ) e.push(`LOT_SIZE: quantidade ${qty} acima do máximo ${maxQ}`);
  const step = Number(qtyStep(f));
  if (step > 0) {
    const r = qty / step;
    if (Math.abs(r - Math.round(r)) > 1e-6) e.push(`LOT_SIZE: quantidade ${qty} não respeita o passo ${step}`);
  }
  const notional = qty * price;
  const minN = effectiveMinNotional(f);
  if (minN && notional < minN) e.push(`NOTIONAL: valor da ordem ${notional.toFixed(4)} ${f.quoteAsset} abaixo do mínimo ${minN} ${f.quoteAsset}`);
  if (f.maxNotional && f.applyMaxToMarket && notional > f.maxNotional) e.push(`NOTIONAL: valor ${notional} acima do máximo ${f.maxNotional}`);
  return e;
}
