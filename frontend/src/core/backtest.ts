// BACKTEST NO CELULAR com dados históricos REAIS da Binance.
// Usa exatamente o mesmo motor do robô ao vivo (TradingEngine) sobre um replay do passado.
// Premissas conservadoras (iguais às do backtest Python):
// - sinal no fechamento do candle de 1m; execução na abertura do minuto seguinte, pagando o ASK;
// - dentro do minuto o preço percorre abertura → mínima → máxima → fechamento (stop antes do alvo);
// - spread fixo configurável (klines não trazem o livro de ofertas); taxas e filtros reais.
import { DEFAULT_CONFIG, summarize, TradingEngine } from "./engine.ts";
import { filtersFromExchangeInfo } from "./filters.ts";
import type { SymbolFilters } from "./filters.ts";
import { binanceGet, parseKline } from "./market.ts";
import { MemoryKV, Repo } from "./repo.ts";
import { ReplayMarket, replayCandle } from "./replay.ts";
import { DEFAULT_RISK } from "./risk.ts";
import type { RiskSettings } from "./risk.ts";
import type { Candle } from "./types.ts";

export const WARMUP = 12_700; // ~211 h de 1m: necessário para a EMA200 do gráfico de 1h

export interface BacktestOptions {
  symbols: string[];
  days: number;
  capitalBrl: number;
  spreadPct?: number;
  risk?: RiskSettings;
  endMs?: number; // fim do período (padrão: último minuto fechado)
}

export interface Progress { phase: "baixando" | "simulando"; done: number; total: number; text: string }

export interface Significance { n: number; mean: number | null; sd?: number; t_stat: number | null; ci95: [number, number] | null; evidence: boolean; verdict: string }

export interface BacktestResult {
  ran_at: number;
  period: { start: number; end: number; days: number };
  symbols: string[];
  capital_brl: number;
  brl_rate: number;
  metrics: ReturnType<typeof summarize> & { start_equity: number; end_equity: number; return_pct: number | null;
    max_drawdown_pct: number; open_positions_at_end: number; trades_per_day: number | null };
  significance: Significance;
  exit_reasons: Record<string, number>;
  signals: number;
  rejected_capital: number;
  rejected_risk: number;
  trades: { symbol: string; entry_time: number; exit_time: number | null; exit_reason: string | null; pnl_quote: number | null; r_multiple: number | null }[];
  equity_curve: [number, number][];
  assumptions: Record<string, string | number>;
}

export class Cancelled extends Error {}

const tick = () => new Promise((r) => setTimeout(r, 0));

/** Baixa candles de 1m em páginas de 1000 (limite oficial da Binance). */
export async function downloadKlines(symbol: string, startMs: number, endMs: number, onPage?: (got: number) => void,
  isCancelled?: () => boolean): Promise<Candle[]> {
  const out: Candle[] = [];
  let from = startMs;
  while (from < endMs) {
    if (isCancelled?.()) throw new Cancelled("Backtest cancelado");
    const rows = await binanceGet("/api/v3/klines", { symbol, interval: "1m", startTime: from, endTime: endMs - 1, limit: 1000 });
    if (!rows.length) break;
    const now = Date.now();
    for (const r of rows) {
      const c = parseKline(r, now);
      if (c.closed && (!out.length || c.openTime > out[out.length - 1].openTime)) out.push(c);
    }
    from = Number(rows[rows.length - 1][0]) + 60_000;
    onPage?.(out.length);
    if (rows.length < 1000) break;
  }
  return out;
}

function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Teste estatístico do resultado médio por operação (em R). Igual ao backend/app/engine/stats.py. */
export function significance(returns: number[], nBoot = 2000, seed = 7): Significance {
  const n = returns.length;
  if (n < 2) return { n, mean: n ? returns[0] : null, t_stat: null, ci95: null, evidence: false, verdict: "Amostra insuficiente: nenhuma conclusão possível." };
  const mean = returns.reduce((s, r) => s + r, 0) / n;
  const sd = Math.sqrt(returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (n - 1));
  const t = sd > 0 ? mean / (sd / Math.sqrt(n)) : null;
  const rnd = mulberry32(seed);
  const boots: number[] = [];
  for (let b = 0; b < nBoot; b++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += returns[Math.floor(rnd() * n)];
    boots.push(s / n);
  }
  boots.sort((a, b) => a - b);
  const ci: [number, number] = [boots[Math.floor(0.025 * nBoot)], boots[Math.floor(0.975 * nBoot) - 1]];
  const evidence = n >= 100 && ci[0] > 0;
  const verdict = n < 100 ? `Apenas ${n} operações: amostra pequena demais para concluir qualquer coisa (mínimo 100).`
    : evidence ? "Há evidência estatística (95%) de resultado médio positivo NESTE período. Isso não garante resultados futuros."
      : "Sem evidência estatística de lucratividade: o intervalo de confiança inclui zero ou valores negativos.";
  return { n, mean, sd, t_stat: t, ci95: ci, evidence, verdict };
}

/** Roda o motor sobre séries já carregadas (usado pelo app e pelos testes). */
export async function simulate(series: Record<string, Candle[]>, filters: Record<string, SymbolFilters>, brlRate: number,
  capitalBrl: number, opts: { spreadPct?: number; risk?: RiskSettings; warmup?: number; synthetic?: boolean;
    onProgress?: (p: Progress) => void; isCancelled?: () => boolean } = {}): Promise<Omit<BacktestResult, "ran_at" | "period" | "symbols" | "capital_brl" | "brl_rate">> {
  // alinha os ativos pelos mesmos minutos
  const syms = Object.keys(series);
  let common = new Set(series[syms[0]].map((c) => c.openTime));
  for (const s of syms.slice(1)) { const ts = new Set(series[s].map((c) => c.openTime)); common = new Set([...common].filter((t) => ts.has(t))); }
  const aligned: Record<string, Candle[]> = {};
  for (const s of syms) aligned[s] = series[s].filter((c) => common.has(c.openTime));
  const warmup = opts.warmup ?? WARMUP;
  const n = aligned[syms[0]].length;
  if (n <= warmup + 10) throw new Error(`Histórico insuficiente: ${n} minutos (mínimo ${warmup + 10}).`);

  const risk = opts.risk ?? DEFAULT_RISK;
  const spread = opts.spreadPct ?? 0.02;
  const m = new ReplayMarket(aligned, filters, "USDT", brlRate, spread, !!opts.synthetic);
  for (let i = 0; i < warmup; i++) m.pushClosed(i);
  const repo = new Repo(new MemoryKV(), { orders: 1_000_000, events: 100 });
  repo.kvSet("risk_settings", risk);
  const engine = new TradingEngine({ ...DEFAULT_CONFIG, symbols: syms, initialCapitalBrl: capitalBrl }, repo, m,
    { clock: () => m.now, persistDecisions: false });
  engine.fastEval = true;
  const first = aligned[syms[0]];
  engine.start(first[warmup].openTime / 1000);
  const equity: [number, number][] = [];
  let signals = 0, rejCap = 0, rejRisk = 0;
  for (let i = warmup; i < n; i++) {
    if ((i - warmup) % 400 === 0) {
      if (opts.isCancelled?.()) throw new Cancelled("Backtest cancelado");
      opts.onProgress?.({ phase: "simulando", done: i - warmup, total: n - warmup, text: `Simulando minuto ${i - warmup} de ${n - warmup}` });
      await tick();
    }
    const t = first[i].openTime / 1000;
    await replayCandle(m, engine, i);
    for (const d of Object.values(engine.brain.latest)) {
      if (d.ts === t + 1 && d.signal === "COMPRAR") {
        signals += 1;
        if (d.decision === "RECUSADA (CAPITAL)") rejCap += 1;
        if (d.decision === "BLOQUEADA PELO RISCO") rejRisk += 1;
      }
    }
    if (i % 15 === 0) equity.push([t, engine.equity()[0]]);
  }
  equity.push([first[n - 1].closeTime / 1000, engine.equity()[0]]);

  const trades = repo.closedPositions({ limit: 1_000_000 }).reverse();
  const summary = summarize(trades);
  let peak = 0, mdd = 0;
  for (const [, e] of equity) { peak = Math.max(peak, e); if (peak > 0) mdd = Math.max(mdd, ((peak - e) / peak) * 100); }
  const startEq = Number(engine.broker.meta.initial_quote ?? equity[0]?.[1] ?? 0);
  const endEq = equity[equity.length - 1][1];
  const days = (first[n - 1].openTime - first[warmup].openTime) / 86_400_000;
  const reasons: Record<string, number> = {};
  for (const t of trades) reasons[t.exit_reason ?? "?"] = (reasons[t.exit_reason ?? "?"] ?? 0) + 1;
  return {
    metrics: { ...summary, start_equity: startEq, end_equity: endEq, return_pct: startEq ? (endEq / startEq - 1) * 100 : null,
      max_drawdown_pct: mdd, open_positions_at_end: engine.positions.size, trades_per_day: days > 0 ? summary.trades / days : null },
    significance: significance(trades.map((t) => t.r_multiple).filter((r): r is number => r !== null)),
    exit_reasons: reasons, signals, rejected_capital: rejCap, rejected_risk: rejRisk,
    trades: trades.map((t) => ({ symbol: t.symbol, entry_time: t.entry_time, exit_time: t.exit_time, exit_reason: t.exit_reason,
      pnl_quote: t.pnl_quote, r_multiple: t.r_multiple })),
    equity_curve: equity.filter((_, k) => k % 8 === 0 || k === equity.length - 1),
    assumptions: {
      spread_pct: spread, taxa_pct: risk.fee_rate_pct, slippage_pct: risk.slippage_pct,
      caminho_intrabar: "abertura → mínima → máxima → fechamento (stop antes do alvo)",
      execucao: "sinal no fechamento do 1m, execução na abertura seguinte",
      filtros: "filtros ATUAIS da Binance (podem ter mudado no período)",
    },
  };
}

/** Backtest completo: baixa dados reais da Binance e roda o motor. */
export async function runBacktest(opts: BacktestOptions, onProgress?: (p: Progress) => void,
  isCancelled?: () => boolean): Promise<BacktestResult> {
  const endMs = opts.endMs ?? Math.floor(Date.now() / 60_000) * 60_000;
  const startMs = endMs - opts.days * 86_400_000;
  const fromMs = startMs - WARMUP * 60_000;
  const totalPer = Math.ceil((endMs - fromMs) / 60_000);
  onProgress?.({ phase: "baixando", done: 0, total: 1, text: "Lendo regras de negociação da Binance…" });
  const info = await binanceGet("/api/v3/exchangeInfo", { symbols: JSON.stringify(opts.symbols) });
  const filters: Record<string, SymbolFilters> = {};
  for (const s of info.symbols ?? []) filters[s.symbol] = filtersFromExchangeInfo(s);
  const missing = opts.symbols.filter((s) => !filters[s]);
  if (missing.length) throw new Error(`Pares não encontrados na Binance: ${missing.join(", ")}`);
  const brl = await binanceGet("/api/v3/klines", { symbol: "USDTBRL", interval: "1m", startTime: startMs, limit: 1 });
  if (!brl.length) throw new Error("Não foi possível obter a cotação real USDT/BRL do início do período.");
  const brlRate = Number(brl[0][4]);
  const series: Record<string, Candle[]> = {};
  for (const [k, s] of opts.symbols.entries()) {
    series[s] = await downloadKlines(s, fromMs, endMs, (got) =>
      onProgress?.({ phase: "baixando", done: k * totalPer + got, total: opts.symbols.length * totalPer,
        text: `Baixando ${s}: ${got.toLocaleString("pt-BR")} de ~${totalPer.toLocaleString("pt-BR")} minutos` }), isCancelled);
  }
  const res = await simulate(series, filters, brlRate, opts.capitalBrl, { spreadPct: opts.spreadPct, risk: opts.risk, onProgress, isCancelled });
  return { ...res, ran_at: Date.now() / 1000, period: { start: startMs / 1000, end: endMs / 1000, days: opts.days },
    symbols: opts.symbols, capital_brl: opts.capitalBrl, brl_rate: brlRate };
}
