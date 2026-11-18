// Suporte/resistência (pivôs agrupados) e price action — espelha levels.py e patterns.py.
import type { Candle } from "./types.ts";

export interface Level { price: number; touches: number; kind: "topo" | "fundo" | "misto" }

export function pivots(cs: Candle[], left = 3, right = 3): [number[], number[]] {
  const highs: number[] = [];
  const lows: number[] = [];
  for (let i = left; i < cs.length - right; i++) {
    let isH = true;
    let isL = true;
    for (let j = i - left; j <= i + right; j++) {
      if (j === i) continue;
      if (cs[i].high < cs[j].high) isH = false;
      if (cs[i].low > cs[j].low) isL = false;
    }
    if (isH) highs.push(cs[i].high);
    if (isL) lows.push(cs[i].low);
  }
  return [highs, lows];
}

export function clusterLevels(highs: number[], lows: number[], tolPct = 0.25): Level[] {
  const pts: [number, string][] = [...highs.map((p) => [p, "topo"] as [number, string]), ...lows.map((p) => [p, "fundo"] as [number, string])];
  // ordenação igual à do Python (por preço e depois pelo rótulo)
  pts.sort((a, b) => (a[0] - b[0]) || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  const out: Level[] = [];
  let group: [number, string][] = [];
  const flush = () => {
    if (!group.length) return;
    const kinds = new Set(group.map((g) => g[1]));
    const price = group.reduce((s, g) => s + g[0], 0) / group.length;
    out.push({ price, touches: group.length, kind: kinds.size === 1 ? (group[0][1] as "topo" | "fundo") : "misto" });
  };
  for (const p of pts) {
    if (group.length && ((p[0] - group[0][0]) / group[0][0]) * 100 > tolPct) { flush(); group = []; }
    group.push(p);
  }
  flush();
  return out;
}

export function findLevels(cs: Candle[], tolPct = 0.25): Level[] {
  const closed = cs.filter((c) => c.closed);
  const [h, l] = pivots(closed);
  return clusterLevels(h, l, tolPct);
}

export function nearestResistance(levels: Level[], price: number, gapPct = 0.05): Level | null {
  let best: Level | null = null;
  for (const lv of levels) if (lv.price > price * (1 + gapPct / 100) && (!best || lv.price < best.price)) best = lv;
  return best;
}

export function nearestSupport(levels: Level[], price: number, gapPct = 0.05): Level | null {
  let best: Level | null = null;
  for (const lv of levels) if (lv.price < price * (1 - gapPct / 100) && (!best || lv.price > best.price)) best = lv;
  return best;
}

export function swingLow(cs: Candle[], lookback = 6): number | null {
  const closed = cs.filter((c) => c.closed).slice(-lookback);
  return closed.length ? Math.min(...closed.map((c) => c.low)) : null;
}

// ---------------------------------------------------------------- padrões
const body = (c: Candle) => Math.abs(c.close - c.open);
const rng = (c: Candle) => Math.max(c.high - c.low, 1e-12);
const isBull = (c: Candle) => c.close > c.open;
const isBear = (c: Candle) => c.close < c.open;

export const strongClose = (c: Candle) => isBull(c) && (c.close - c.low) / rng(c) >= 0.7;
export const bullishEngulfing = (p: Candle, c: Candle) => isBear(p) && isBull(c) && c.close >= p.open && c.open <= p.close;
export const bearishEngulfing = (p: Candle, c: Candle) => isBull(p) && isBear(c) && c.open >= p.close && c.close <= p.open;

export function hammer(c: Candle): boolean {
  const lower = Math.min(c.open, c.close) - c.low;
  const upper = c.high - Math.max(c.open, c.close);
  const b = Math.max(body(c), rng(c) * 0.05);
  return lower >= 2 * b && upper <= b && (c.close - c.low) / rng(c) >= 0.6;
}

export function shootingStar(c: Candle): boolean {
  const lower = Math.min(c.open, c.close) - c.low;
  const upper = c.high - Math.max(c.open, c.close);
  const b = Math.max(body(c), rng(c) * 0.05);
  return upper >= 2 * b && lower <= b && (c.high - c.close) / rng(c) >= 0.6;
}

export function detectPatterns(cs: Candle[]): string[] {
  const closed = cs.filter((c) => c.closed);
  if (closed.length < 2) return [];
  const p = closed[closed.length - 2];
  const c = closed[closed.length - 1];
  const out: string[] = [];
  if (bullishEngulfing(p, c)) out.push("engolfo de alta");
  if (hammer(c)) out.push("martelo");
  if (strongClose(c)) out.push("fechamento forte");
  if (bearishEngulfing(p, c)) out.push("engolfo de baixa");
  if (shootingStar(c)) out.push("estrela cadente");
  return out;
}

export const BULLISH = new Set(["engolfo de alta", "martelo", "fechamento forte"]);
