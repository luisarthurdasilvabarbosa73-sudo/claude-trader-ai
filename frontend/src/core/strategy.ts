// Estratégia: Pullback de Tendência Multi-Timeframe — tradução fiel de strategy.py.
// Regras completas em docs/ESTRATEGIA.md.
import * as ind from "./indicators.ts";
import * as ta from "./ta.ts";
import { spreadPct } from "./types.ts";
import type { Book, Candle, TF } from "./types.ts";

export const STRATEGY_NAME = "Pullback de Tendência Multi-Timeframe";
export const STRATEGY_VERSION = "1.0";

export const PARAMS = {
  minCandles: { "1m": 60, "5m": 60, "15m": 60, "1h": 210 } as Record<TF, number>,
  window: 500,
  minAtrPct5m: 0.15,
  maxAtrPct5m: 2.5,
  extremeRangeAtrMult: 4.0,
  maxRsi5m: 72.0,
  maxPb5m: 1.0,
  stopAtrMin: 1.0,
  stopAtrMax: 2.0,
  targetR: 2.5,
  pullbackLookback: 6,
};

export interface TFAnalysis {
  tf: string; close: number;
  ema9: number | null; ema21: number | null; ema50: number | null; ema200: number | null;
  rsi: number | null; rsi_prev: number | null;
  macd: number | null; macd_signal: number | null; macd_hist: number | null; macd_hist_prev: number | null; macd_hist_prev2: number | null;
  bb_mid: number | null; bb_up: number | null; bb_low: number | null; pb: number | null;
  atr: number | null; atr_pct: number | null; vwap: number | null; rvol: number | null;
  ema21_slope: number | null; ema50_slope: number | null;
  trend: string; regime: string; patterns: string[]; last_open_time: number;
}

export interface Gate { key: string; label: string; passed: boolean; detail: string }
export interface Component { key: string; label: string; points: number; max_points: number; detail: string }

export interface Analysis {
  symbol: string; ts: number; action: "COMPRAR" | "AGUARDAR"; score: number; min_score: number;
  gates: Gate[]; components: Component[]; reasons: string[]; summary: string; strategy: string;
  timeframes: Record<string, TFAnalysis>;
  entry: number | null; stop: number | null; take_profit: number | null; rr_net: number | null; atr_5m: number | null;
  resistance: number | null; support: number | null; regime: string; volatility: string; spread_pct: number | null;
  last_1m_open_time: number;
}

const fmt = (v: number | null | undefined, nd = 2) => (v === null || v === undefined ? "—" : v.toFixed(nd));
const g6 = (v: number) => Number(v.toPrecision(6)).toString();

export function computeTf(tf: string, cs: Candle[]): TFAnalysis {
  const closes = cs.map((c) => c.close);
  const e9 = ind.ema(closes, 9), e21 = ind.ema(closes, 21), e50 = ind.ema(closes, 50), e200 = ind.ema(closes, 200);
  const r = ind.rsi(closes, 14);
  const [m, s, h] = ind.macd(closes);
  const [mid, up, low, pb] = ind.bollinger(closes, 20, 2);
  const a = ind.atr(cs, 14);
  const vw = ind.vwap(cs);
  const rv = ind.relativeVolume(cs.map((c) => c.volume), 20);
  const close = closes[closes.length - 1];
  const atrV = ind.last(a);
  const E21 = ind.last(e21), E50 = ind.last(e50), E200 = ind.last(e200);
  const s50 = ind.slopePct(e50, 5);
  let trend = "LATERAL";
  if (E21 !== null && E50 !== null) {
    if (E21 > E50 && close > E50 && (s50 === null || s50 >= 0)) trend = "ALTA";
    else if (E21 < E50 && close < E50) trend = "BAIXA";
  }
  let regime = "LATERAL";
  if (E50 !== null && E200 !== null) {
    if (close > E200 && E50 > E200) regime = "ALTA";
    else if (close < E200 && E50 < E200) regime = "BAIXA";
  } else if (E200 === null) regime = "INDEFINIDO";
  return {
    tf, close, ema9: ind.last(e9), ema21: E21, ema50: E50, ema200: E200,
    rsi: ind.last(r), rsi_prev: ind.last(r, 1), macd: ind.last(m), macd_signal: ind.last(s),
    macd_hist: ind.last(h), macd_hist_prev: ind.last(h, 1), macd_hist_prev2: ind.last(h, 2),
    bb_mid: ind.last(mid), bb_up: ind.last(up), bb_low: ind.last(low), pb: ind.last(pb),
    atr: atrV, atr_pct: atrV && close ? (atrV / close) * 100 : null, vwap: ind.last(vw), rvol: ind.last(rv),
    ema21_slope: ind.slopePct(e21, 5), ema50_slope: s50, trend, regime,
    patterns: ta.detectPatterns(cs), last_open_time: cs[cs.length - 1].openTime,
  };
}

/** R:R por unidade, já descontando taxas (compra e venda) e slippage. */
export function netRewardRisk(entry: number, stop: number, tp: number, fee: number, slip: number): number | null {
  const cost = entry * (1 + slip);
  const keep = 1 - fee;
  const reward = keep * tp * (1 - slip) * (1 - fee) - cost;
  const risk = cost - keep * stop * (1 - slip) * (1 - fee);
  return risk <= 0 ? null : reward / risk;
}

export interface EvalArgs {
  feeRate: number; slippagePct: number; maxSpreadPct: number; minRr: number; minScore: number; fast?: boolean;
}

export class Strategy {
  private cache = new Map<string, { key: string; res: TFAnalysis }>();
  private levelsCache = new Map<string, { key: string; levels: ta.Level[] }>();

  private tf(symbol: string, tf: string, closed: Candle[]): TFAnalysis {
    const lastC = closed[closed.length - 1];
    const key = `${lastC.openTime}|${lastC.close}|${closed.length}`;
    const hit = this.cache.get(`${symbol}|${tf}`);
    if (hit && hit.key === key) return hit.res;
    const res = computeTf(tf, closed.slice(-PARAMS.window));
    this.cache.set(`${symbol}|${tf}`, { key, res });
    return res;
  }

  private levels(symbol: string, c15: Candle[], c1h: Candle[]): ta.Level[] {
    const key = `${c15[c15.length - 1].openTime}|${c1h[c1h.length - 1].openTime}`;
    const hit = this.levelsCache.get(symbol);
    if (hit && hit.key === key) return hit.levels;
    const levels = [...ta.findLevels(c15.slice(-200)), ...ta.findLevels(c1h.slice(-200))];
    this.levelsCache.set(symbol, { key, levels });
    return levels;
  }

  evaluate(symbol: string, candles: Record<TF, Candle[]>, book: Book | null, now: number, a: EvalArgs): Analysis {
    const P = PARAMS;
    const gates: Gate[] = [];
    const comps: Component[] = [];
    const closed = {} as Record<TF, Candle[]>;
    for (const tf of Object.keys(P.minCandles) as TF[]) closed[tf] = (candles[tf] ?? []).filter((c) => c.closed);
    const missing = (Object.entries(P.minCandles) as [TF, number][])
      .filter(([tf, need]) => closed[tf].length < need).map(([tf, need]) => `${tf}: ${closed[tf].length}/${need}`);
    gates.push({ key: "dados", label: "Histórico suficiente", passed: !missing.length,
      detail: missing.length ? "Aguardando histórico — " + missing.join(", ") : "OK" });
    if (missing.length) return this.finish(symbol, now, gates, comps, a.minScore, book);

    const t1 = this.tf(symbol, "1m", closed["1m"]);
    const t5 = this.tf(symbol, "5m", closed["5m"]);
    const t15 = this.tf(symbol, "15m", closed["15m"]);
    const t60 = this.tf(symbol, "1h", closed["1h"]);
    const tfs = { "1m": t1, "5m": t5, "15m": t15, "1h": t60 };

    gates.push({ key: "regime_1h", label: "Regime de alta no 1h (preço e EMA50 acima da EMA200)", passed: t60.regime === "ALTA",
      detail: `Regime 1h: ${t60.regime} (preço ${fmt(t60.close, 4)}, EMA50 ${fmt(t60.ema50, 4)}, EMA200 ${fmt(t60.ema200, 4)})` });
    if (a.fast && !gates[gates.length - 1].passed) return this.finish(symbol, now, gates, comps, a.minScore, book, t60, tfs);

    gates.push({ key: "tendencia_15m", label: "Tendência de alta no 15m (EMA21 > EMA50, preço > EMA50)",
      passed: t15.trend === "ALTA", detail: `Tendência 15m: ${t15.trend}` });

    const atrPct = t5.atr_pct ?? 0;
    const last1 = closed["1m"][closed["1m"].length - 1];
    const extreme = !!t1.atr && last1.high - last1.low > P.extremeRangeAtrMult * (t1.atr ?? 0);
    const volOk = P.minAtrPct5m <= atrPct && atrPct <= P.maxAtrPct5m && !extreme;
    const vdetail = extreme ? "Volatilidade EXTREMA: último candle de 1m maior que 4x o ATR"
      : atrPct < P.minAtrPct5m ? `ATR 5m ${atrPct.toFixed(3)}% < ${P.minAtrPct5m}%: movimento pequeno demais frente às taxas`
        : atrPct > P.maxAtrPct5m ? `ATR 5m ${atrPct.toFixed(2)}% > ${P.maxAtrPct5m}%: volátil demais`
          : `ATR 5m ${atrPct.toFixed(3)}% dentro da faixa operável`;
    gates.push({ key: "volatilidade", label: "Volatilidade operável", passed: volOk, detail: vdetail });

    const spread = book ? spreadPct(book) : null;
    gates.push({ key: "spread", label: `Spread <= ${a.maxSpreadPct}%`, passed: spread !== null && spread <= a.maxSpreadPct,
      detail: spread === null ? "Sem livro de ofertas" : `Spread atual ${spread.toFixed(4)}%` });

    const notOb = (t5.rsi ?? 0) <= P.maxRsi5m && (t5.pb ?? 0) <= P.maxPb5m;
    gates.push({ key: "sobrecompra", label: "Sem sobrecompra no 5m", passed: notOb,
      detail: `RSI 5m ${fmt(t5.rsi, 1)} (máx ${P.maxRsi5m}), %B ${fmt(t5.pb)} (máx ${P.maxPb5m})` });

    const entry = book ? book.ask : t1.close;
    const atr5 = t5.atr ?? 0;
    const swing = ta.swingLow(closed["5m"], P.pullbackLookback);
    const rawDist = swing !== null ? entry - (swing - 0.1 * atr5) : P.stopAtrMin * atr5;
    const dist = Math.min(Math.max(rawDist, P.stopAtrMin * atr5), P.stopAtrMax * atr5);
    const stop = entry - dist;
    let tp = entry + P.targetR * dist;
    const levels = this.levels(symbol, closed["15m"], closed["1h"]);
    const res = ta.nearestResistance(levels, entry);
    const sup = ta.nearestSupport(levels, entry);
    if (res && res.price < tp) tp = res.price * (1 - 0.0005);
    const rr = dist > 0 ? netRewardRisk(entry, stop, tp, a.feeRate, a.slippagePct / 100) : null;
    gates.push({ key: "risco_retorno", label: `Risco/retorno líquido >= ${a.minRr}`, passed: rr !== null && rr >= a.minRr,
      detail: `R:R líquido (após taxas e slippage) = ${fmt(rr)}` + (res ? `; resistência em ${g6(res.price)}` : "; sem resistência próxima") });

    // ---- pontuação
    let pts = 0;
    let d = "EMAs do 5m desalinhadas";
    if (t5.ema9 && t5.ema21 && t5.ema50 && t5.ema9 > t5.ema21 && t5.ema21 > t5.ema50) { pts = 10; d = "EMA9 > EMA21 > EMA50 no 5m"; }
    else if (t5.ema21 && t5.ema50 && t5.ema21 > t5.ema50) { pts = 5; d = "EMA21 > EMA50 no 5m (EMA9 ainda abaixo)"; }
    if ((t60.ema50_slope ?? 0) > 0) { pts += 5; d += "; EMA50 do 1h subindo"; }
    if ((t15.ema21_slope ?? 0) > 0) { pts += 5; d += "; EMA21 do 15m subindo"; }
    comps.push({ key: "tendencia", label: "Alinhamento de tendência", points: pts, max_points: 20, detail: d });

    pts = 0;
    let notes: string[] = [];
    const recent5 = closed["5m"].slice(-P.pullbackLookback);
    const touched = recent5.some((c) => (t5.ema21 && c.low <= t5.ema21 * 1.002) || (t5.vwap && c.low <= t5.vwap * 1.002));
    if (touched) { pts += 10; notes.push("recuou até a EMA21/VWAP"); }
    if (t5.vwap && t5.close > t5.vwap) { pts += 5; notes.push("preço acima do VWAP"); }
    if (t5.pb !== null && t5.pb >= 0.2 && t5.pb <= 0.8) { pts += 5; notes.push(`%B ${t5.pb.toFixed(2)} no meio das bandas`); }
    comps.push({ key: "pullback", label: "Pullback e localização", points: pts, max_points: 20,
      detail: notes.join(", ") || "sem pullback recente — entrada esticada" });

    pts = 0;
    notes = [];
    const h0 = t5.macd_hist, h1 = t5.macd_hist_prev, h2 = t5.macd_hist_prev2;
    if (h0 !== null && h1 !== null && h2 !== null && h0 > h1 && h1 > h2) { pts += 8; notes.push("histograma MACD subindo 2 candles"); }
    else if (h0 !== null && h1 !== null && h0 > h1) { pts += 4; notes.push("histograma MACD subindo"); }
    if (h0 !== null && h0 > 0) { pts += 4; notes.push("MACD acima do sinal"); }
    if (t5.rsi !== null && t5.rsi_prev !== null) {
      if (t5.rsi >= 45 && t5.rsi <= 65 && t5.rsi > t5.rsi_prev) { pts += 8; notes.push(`RSI ${t5.rsi.toFixed(1)} subindo em zona saudável`); }
      else if (t5.rsi >= 40 && t5.rsi <= 70) { pts += 4; notes.push(`RSI ${t5.rsi.toFixed(1)} neutro`); }
    }
    comps.push({ key: "momentum", label: "Momentum (MACD + RSI 5m)", points: pts, max_points: 20, detail: notes.join(", ") || "momentum fraco" });

    pts = 0;
    notes = [];
    if (t1.ema9 && t1.close > t1.ema9) { pts += 5; notes.push("1m acima da EMA9"); }
    const bull = t1.patterns.filter((p) => ta.BULLISH.has(p)).sort();
    if (bull.length) { pts += 5; notes.push("padrão de alta: " + bull.join(", ")); }
    const c1 = closed["1m"];
    if (c1.length >= 2 && c1[c1.length - 1].close > c1[c1.length - 2].high) { pts += 5; notes.push("rompeu a máxima do candle anterior"); }
    comps.push({ key: "gatilho", label: "Gatilho no 1m", points: pts, max_points: 15, detail: notes.join(", ") || "sem gatilho" });

    const rv = t5.rvol ?? 0;
    comps.push({ key: "volume", label: "Volume relativo (5m)", points: rv >= 1.5 ? 10 : rv >= 1.0 ? 5 : 0, max_points: 10,
      detail: `volume ${rv.toFixed(2)}x a média de 20 candles` });

    if (res === null) comps.push({ key: "espaco", label: "Espaço até a resistência", points: 15, max_points: 15, detail: "nenhuma resistência mapeada acima" });
    else {
      const room = dist > 0 ? (res.price - entry) / dist : 0;
      comps.push({ key: "espaco", label: "Espaço até a resistência", points: room >= 2 ? 15 : room >= 1.5 ? 8 : 0, max_points: 15,
        detail: `resistência a ${room.toFixed(2)}R de distância` });
    }

    const out = this.finish(symbol, now, gates, comps, a.minScore, book, t60, tfs);
    out.entry = entry; out.stop = stop; out.take_profit = tp; out.rr_net = rr; out.atr_5m = atr5;
    out.resistance = res ? res.price : null;
    out.support = sup ? sup.price : null;
    out.volatility = extreme || atrPct > P.maxAtrPct5m ? "EXTREMA" : atrPct < P.minAtrPct5m ? "BAIXA" : atrPct > 1.0 ? "ALTA" : "NORMAL";
    return out;
  }

  private finish(symbol: string, now: number, gates: Gate[], comps: Component[], minScore: number, book: Book | null,
    t60?: TFAnalysis, tfs?: Record<string, TFAnalysis>): Analysis {
    const score = Math.round(comps.reduce((s, c) => s + c.points, 0) * 10) / 10;
    const failed = gates.filter((g) => !g.passed);
    const reasons = failed.map((g) => `✗ ${g.label}: ${g.detail}`);
    if (comps.length && score < minScore) reasons.push(`✗ Pontuação ${score.toFixed(0)} abaixo do mínimo ${minScore.toFixed(0)}`);
    const action = !failed.length && comps.length && score >= minScore ? "COMPRAR" : "AGUARDAR";
    let summary: string;
    if (action === "COMPRAR") {
      reasons.push(`✓ Todos os filtros obrigatórios aprovados e pontuação ${score.toFixed(0)} >= ${minScore.toFixed(0)}`);
      summary = `Oportunidade de compra em ${symbol} (pontuação ${score.toFixed(0)})`;
    } else if (failed.length) summary = `Sem entrada em ${symbol}: ${failed[0].label.toLowerCase()} não atendido`;
    else summary = `Sem entrada em ${symbol}: confirmações insuficientes (${score.toFixed(0)}/${minScore.toFixed(0)})`;
    return {
      symbol, ts: now, action, score, min_score: minScore, gates, components: comps, reasons, summary,
      strategy: `${STRATEGY_NAME} v${STRATEGY_VERSION}`, timeframes: tfs ?? {},
      entry: null, stop: null, take_profit: null, rr_net: null, atr_5m: null, resistance: null, support: null,
      regime: t60 ? t60.regime : "DESCONHECIDO", volatility: "DESCONHECIDA", spread_pct: book ? spreadPct(book) : null,
      last_1m_open_time: 0,
    };
  }

  trendInvalidated(symbol: string, c15: Candle[], entryTime: number): string | null {
    const closed = c15.filter((c) => c.closed);
    if (closed.length < PARAMS.minCandles["15m"]) return null;
    const t15 = this.tf(symbol, "15m", closed);
    const lastC = closed[closed.length - 1];
    if (lastC.openTime >= entryTime * 1000 && t15.ema50 && lastC.close < t15.ema50)
      return `Candle de 15m fechou abaixo da EMA50 (${g6(lastC.close)} < ${g6(t15.ema50)})`;
    return null;
  }
}
