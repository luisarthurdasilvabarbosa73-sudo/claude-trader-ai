// Indicadores técnicos — tradução fiel de backend/app/analysis/indicators.py.
// Saídas do mesmo tamanho da entrada; posições sem dados suficientes = null.
import type { Candle } from "./types.ts";

export type Series = (number | null)[];

export function sma(values: number[], period: number): Series {
  const out: Series = new Array(values.length).fill(null);
  if (period <= 0 || values.length < period) return out;
  let w = 0;
  for (let i = 0; i < period; i++) w += values[i];
  out[period - 1] = w / period;
  for (let i = period; i < values.length; i++) {
    w += values[i] - values[i - period];
    out[i] = w / period;
  }
  return out;
}

export function ema(values: number[], period: number): Series {
  const out: Series = new Array(values.length).fill(null);
  if (period <= 0 || values.length < period) return out;
  const k = 2 / (period + 1);
  let prev = 0;
  for (let i = 0; i < period; i++) prev += values[i];
  prev /= period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

export function rma(values: number[], period: number): Series {
  const out: Series = new Array(values.length).fill(null);
  if (period <= 0 || values.length < period) return out;
  let prev = 0;
  for (let i = 0; i < period; i++) prev += values[i];
  prev /= period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = (prev * (period - 1) + values[i]) / period;
    out[i] = prev;
  }
  return out;
}

export function rsi(closes: number[], period = 14): Series {
  const out: Series = new Array(closes.length).fill(null);
  if (closes.length <= period) return out;
  const gains = [0];
  const losses = [0];
  for (let i = 1; i < closes.length; i++) {
    const ch = closes[i] - closes[i - 1];
    gains.push(Math.max(ch, 0));
    losses.push(Math.max(-ch, 0));
  }
  let g = 0;
  let l = 0;
  for (let i = 1; i <= period; i++) { g += gains[i]; l += losses[i]; }
  g /= period;
  l /= period;
  const value = (ag: number, al: number) => (al === 0 && ag === 0 ? 50 : al === 0 ? 100 : 100 - 100 / (1 + ag / al));
  out[period] = value(g, l);
  for (let i = period + 1; i < closes.length; i++) {
    g = (g * (period - 1) + gains[i]) / period;
    l = (l * (period - 1) + losses[i]) / period;
    out[i] = value(g, l);
  }
  return out;
}

export function macd(closes: number[], fast = 12, slow = 26, signal = 9): [Series, Series, Series] {
  const ef = ema(closes, fast);
  const es = ema(closes, slow);
  const line: Series = ef.map((a, i) => (a === null || es[i] === null ? null : a - (es[i] as number)));
  const sig: Series = new Array(closes.length).fill(null);
  const start = line.findIndex((v) => v !== null);
  if (start >= 0) {
    const sub = ema(line.slice(start).filter((v): v is number => v !== null), signal);
    sub.forEach((v, j) => { sig[start + j] = v; });
  }
  const hist: Series = line.map((a, i) => (a === null || sig[i] === null ? null : a - (sig[i] as number)));
  return [line, sig, hist];
}

export function bollinger(closes: number[], period = 20, mult = 2): [Series, Series, Series, Series] {
  const n = closes.length;
  const mid: Series = new Array(n).fill(null);
  const up: Series = new Array(n).fill(null);
  const low: Series = new Array(n).fill(null);
  const pb: Series = new Array(n).fill(null);
  for (let i = period - 1; i < n; i++) {
    let m = 0;
    for (let j = i - period + 1; j <= i; j++) m += closes[j];
    m /= period;
    let v = 0;
    for (let j = i - period + 1; j <= i; j++) v += (closes[j] - m) ** 2;
    const sd = Math.sqrt(v / period);
    mid[i] = m;
    up[i] = m + mult * sd;
    low[i] = m - mult * sd;
    const width = (up[i] as number) - (low[i] as number);
    pb[i] = width === 0 ? 0.5 : (closes[i] - (low[i] as number)) / width;
  }
  return [mid, up, low, pb];
}

export function trueRange(cs: Candle[]): number[] {
  return cs.map((c, i) => {
    if (i === 0) return c.high - c.low;
    const pc = cs[i - 1].close;
    return Math.max(c.high - c.low, Math.abs(c.high - pc), Math.abs(c.low - pc));
  });
}

export function atr(cs: Candle[], period = 14): Series {
  return rma(trueRange(cs), period);
}

/** VWAP de sessão, reiniciado a cada dia UTC. */
export function vwap(cs: Candle[]): Series {
  const out: Series = [];
  let pv = 0;
  let vol = 0;
  let day = -1;
  for (const c of cs) {
    const d = Math.floor(c.openTime / 86_400_000);
    if (d !== day) { day = d; pv = 0; vol = 0; }
    const tp = (c.high + c.low + c.close) / 3;
    pv += tp * c.volume;
    vol += c.volume;
    out.push(vol > 0 ? pv / vol : tp);
  }
  return out;
}

export function relativeVolume(volumes: number[], period = 20): Series {
  const out: Series = new Array(volumes.length).fill(null);
  for (let i = period; i < volumes.length; i++) {
    let s = 0;
    for (let j = i - period; j < i; j++) s += volumes[j];
    const avg = s / period;
    out[i] = avg > 0 ? volumes[i] / avg : null;
  }
  return out;
}

export function slopePct(series: Series, lookback = 5): number | null {
  const vals = series.filter((v): v is number => v !== null);
  if (vals.length <= lookback || vals[vals.length - 1 - lookback] === 0) return null;
  const a = vals[vals.length - 1 - lookback];
  return ((vals[vals.length - 1] - a) / a) * 100;
}

export function last(series: Series, offset = 0): number | null {
  const i = series.length - 1 - offset;
  return i >= 0 && i < series.length ? series[i] : null;
}
