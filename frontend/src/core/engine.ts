// Motor autônomo do robô — tradução fiel de backend/app/engine/bot.py (+ brain.py e stats.py).
// Roda dentro do app: a cada segundo protege posições e, a cada candle de 1m fechado, analisa.
import { roundPrice } from "./filters.ts";
import type { Broker } from "./broker.ts";
import type { MarketData } from "./market.ts";
import { OrderRejected, PaperBroker } from "./paper.ts";
import type { Repo } from "./repo.ts";
import { brlToQuote, DEFAULT_RISK, feeRate, newRiskState, RiskManager, sizePosition, validateRisk } from "./risk.ts";
import type { RiskSettings, RiskState } from "./risk.ts";
import { Strategy, STRATEGY_NAME, STRATEGY_VERSION } from "./strategy.ts";
import type { Analysis } from "./strategy.ts";
import { TIMEFRAMES } from "./types.ts";
import type { BotStatus, Book, Candle, Fill, Mode, Position, TF } from "./types.ts";

export interface EngineConfig {
  symbols: string[];
  quoteAsset: string;
  initialCapitalBrl: number;
  brlRateSymbol: string;
  tzOffsetHours: number; // Brasil/Fortaleza: -3
  autoResume: boolean;
}

export const DEFAULT_CONFIG: EngineConfig = {
  symbols: ["BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT", "ADAUSDT"],
  quoteAsset: "USDT",
  initialCapitalBrl: 30,
  brlRateSymbol: "USDTBRL",
  tzOffsetHours: -3,
  autoResume: false,
};

// ------------------------------------------------------------------ cérebro
export interface Thought { ts: number; kind: string; symbol: string | null; text: string }

export class Brain {
  thoughts: Thought[] = [];
  latest: Record<string, Record<string, unknown>> = {};
  activity = "Inicializando…";
  private lastSummary: Record<string, string> = {};

  think(ts: number, kind: string, text: string, symbol: string | null = null) {
    this.thoughts.unshift({ ts, kind, symbol, text });
    if (this.thoughts.length > 200) this.thoughts.length = 200;
  }

  record(a: Analysis, blockers: string[], decision: string, sizing: string | null) {
    const failed = a.gates.filter((g) => !g.passed);
    const trends: Record<string, string> = {};
    for (const [tf, v] of Object.entries(a.timeframes)) trends[tf] = v.trend;
    this.latest[a.symbol] = {
      ts: a.ts, symbol: a.symbol, signal: a.action, decision, score: a.score, min_score: a.min_score, regime: a.regime,
      volatility: a.volatility, spread_pct: a.spread_pct, entry: a.entry, stop: a.stop, take_profit: a.take_profit,
      rr_net: a.rr_net, resistance: a.resistance, support: a.support,
      gates: a.gates.map((g) => ({ label: g.label, passed: g.passed, detail: g.detail })),
      components: a.components.map((c) => ({ label: c.label, points: c.points, max: c.max_points, detail: c.detail })),
      reasons: a.reasons, blockers, sizing, failed_gate: failed.length ? failed[0].label : null, trends,
    };
    if (a.action === "COMPRAR") return;
    if (this.lastSummary[a.symbol] !== a.summary) {
      this.lastSummary[a.symbol] = a.summary;
      this.think(a.ts, "sem_operacao", a.summary + (a.reasons.length ? ` — ${a.reasons[0]}` : ""), a.symbol);
    }
  }

  risks(): string[] {
    const out: string[] = [];
    for (const [sym, d] of Object.entries(this.latest)) {
      if (d.volatility === "EXTREMA" || d.volatility === "ALTA") out.push(`${sym}: volatilidade ${String(d.volatility).toLowerCase()}`);
      if (d.regime === "BAIXA") out.push(`${sym}: regime de baixa no 1h (robô fica de fora)`);
      if (typeof d.spread_pct === "number" && d.spread_pct > 0.1) out.push(`${sym}: spread elevado (${d.spread_pct.toFixed(3)}%)`);
    }
    return out;
  }

  snapshot(limit = 60) {
    return { activity: this.activity, latest: this.latest, thoughts: this.thoughts.slice(0, limit), risks: this.risks() };
  }
}

// ------------------------------------------------------------- estatísticas
export function dayStart(now: number, tzOffsetHours: number): number {
  const local = now + tzOffsetHours * 3600;
  return Math.floor(local / 86400) * 86400 - tzOffsetHours * 3600;
}

export function dayKey(now: number, tzOffsetHours: number): string {
  return new Date((now + tzOffsetHours * 3600) * 1000).toISOString().slice(0, 10);
}

export function summarize(trades: Position[]) {
  const pnls = trades.map((t) => t.pnl_quote ?? 0);
  const wins = pnls.filter((p) => p > 0);
  const losses = pnls.filter((p) => p <= 0);
  const gw = wins.reduce((s, x) => s + x, 0);
  const gl = losses.reduce((s, x) => s + x, 0);
  const rs = trades.map((t) => t.r_multiple).filter((r): r is number => r !== null);
  const n = trades.length;
  return {
    trades: n, wins: wins.length, losses: losses.length, win_rate: n ? (wins.length / n) * 100 : null,
    gross_profit: gw, gross_loss: gl, net_pnl: gw + gl, fees: trades.reduce((s, t) => s + t.fees_quote, 0),
    profit_factor: gl < 0 ? gw / -gl : null, avg_r: rs.length ? rs.reduce((s, r) => s + r, 0) / rs.length : null,
  };
}

const MODE_LABEL: Record<string, string> = {
  SIMULACAO: "SIMULAÇÃO (paper trading — sem dinheiro real)",
  TESTNET: "TESTNET (ambiente de testes da Binance)",
  REAL: "REAL (dinheiro verdadeiro)",
};

// -------------------------------------------------------------------- motor
export class TradingEngine {
  cfg: EngineConfig;
  repo: Repo;
  market: MarketData;
  clock: () => number;
  persistDecisions: boolean;
  fastEval = false;
  riskSettings: RiskSettings;
  risk: RiskManager;
  broker: Broker;
  mode: Mode;
  strategy: Strategy;
  brain = new Brain();
  quote: string;
  positions = new Map<string, Position>();
  lastEval = new Map<string, number>();
  inFlight = new Set<string>();
  lastAnalysis = new Map<string, Analysis>();
  lastEquityTs = 0;
  private lastWarn = new Map<string, number>();
  private riskJson = "";
  startedAt: number;
  stepCount = 0;
  lastStepTs = 0;
  lastError: string | null = null;
  status: BotStatus;
  statusReason: string;

  constructor(cfg: EngineConfig, repo: Repo, market: MarketData,
    opts: { strategy?: Strategy; clock?: () => number; persistDecisions?: boolean; broker?: Broker } = {}) {
    this.cfg = cfg;
    this.repo = repo;
    this.market = market;
    this.clock = opts.clock ?? (() => Date.now() / 1000);
    this.persistDecisions = opts.persistDecisions ?? true;
    try { this.riskSettings = validateRisk(repo.kvGet<Record<string, number>>("risk_settings", {}) ?? {}); }
    catch { this.riskSettings = { ...DEFAULT_RISK }; }
    this.risk = new RiskManager(this.riskSettings, { ...newRiskState(), ...repo.kvGet<Partial<RiskState>>("risk_state", {}) });
    this.broker = opts.broker ?? new PaperBroker(repo, feeRate(this.riskSettings), this.riskSettings.slippage_pct);
    this.mode = this.broker.mode;
    this.strategy = opts.strategy ?? new Strategy();
    this.quote = cfg.quoteAsset;
    for (const p of repo.openPositions(this.mode)) this.positions.set(p.symbol, p);
    const saved = repo.kvGet<{ status?: BotStatus; reason?: string }>("bot_state", {});
    let status: BotStatus = saved.status ?? "PARADO";
    this.statusReason = saved.reason ?? "";
    if (status === "RODANDO" && !cfg.autoResume) { status = "PARADO"; this.statusReason = "App reaberto: toque em Iniciar para operar"; }
    this.status = status;
    const now = this.clock();
    this.startedAt = now;
    const msg = `Robô iniciado no aparelho em modo ${this.mode}. Estado: ${this.status}. ${this.positions.size} posição(ões) aberta(s) restaurada(s).`;
    repo.log("INFO", "sistema", msg, null, now);
    this.brain.think(now, "info", msg);
    if (market.isSynthetic) this.brain.think(now, "alerta", "ATENÇÃO: fonte de dados SINTÉTICA (somente teste). Nada aqui é mercado real.");
  }

  // --------------------------------------------------------------- util
  private log(level: string, category: string, message: string, data: unknown = null, now?: number) {
    this.repo.log(level, category, message, data, now ?? this.clock());
  }
  private throttled(key: string, now: number, every = 60): boolean {
    if (now - (this.lastWarn.get(key) ?? 0) >= every) { this.lastWarn.set(key, now); return true; }
    return false;
  }
  private persistState() { this.repo.kvSet("bot_state", { status: this.status, reason: this.statusReason }); }
  private persistRisk() {
    const js = JSON.stringify(this.risk.state);
    if (js !== this.riskJson) { this.repo.kvSet("risk_state", this.risk.state); this.riskJson = js; }
  }

  // --------------------------------------------------------- conta/saldo
  accountReady(): boolean { return this.broker.initialized; }

  async ensureAccount(now: number): Promise<boolean> {
    if (this.accountReady()) return true;
    const brl = this.cfg.initialCapitalBrl;
    let amount: number;
    let rate: number | null = null;
    if (this.quote === "BRL") amount = brl;
    else {
      const book = this.market.brlBook();
      if (!book || now - book.ts > this.riskSettings.stale_data_seconds) {
        this.brain.activity = `Aguardando cotação REAL de ${this.cfg.brlRateSymbol} para converter R$${brl} em ${this.quote} (nenhum valor é inventado)`;
        return false;
      }
      rate = book.ask;
      amount = brlToQuote(brl, rate, feeRate(this.riskSettings));
    }
    amount = Math.round(amount * 1e8) / 1e8;
    const meta = { initial_brl: brl, initial_quote: amount, brl_rate: rate, ts: now,
      conversion: rate ? `R$${brl} / ${rate} (${this.cfg.brlRateSymbol} ask) - taxa ${this.riskSettings.fee_rate_pct}%` : "moeda de cotação já é BRL" };
    try {
      await this.broker.initialize(this.quote, amount, meta);
    } catch (e) {
      this.brain.activity = `Não foi possível preparar a conta: ${e instanceof Error ? e.message : e}`;
      if (this.throttled("account-init", now, 60)) this.log("AVISO", "conta", this.brain.activity, null, now);
      return false;
    }
    this.risk.newDay(dayKey(now, this.cfg.tzOffsetHours), this.equity()[0]);
    const msg = `${this.broker.sendsOrders ? "Capital do robô na Testnet separado" : "Conta simulada criada"}: R$${brl} -> ${amount.toFixed(4)} ${this.quote}` + (rate ? ` (cotação real ${this.cfg.brlRateSymbol} ${rate})` : "");
    this.log("INFO", "conta", msg, meta, now);
    this.brain.think(now, "info", msg);
    return true;
  }

  resetPaperAccount(now: number) {
    if (this.positions.size) throw new Error("Feche as posições abertas antes de zerar a conta simulada");
    this.broker.reset();
    this.risk.state = newRiskState();
    this.log("AVISO", "conta", "Conta simulada zerada pelo proprietário (será recriada com R$30)", null, now);
  }

  priceOf(asset: string): number | null {
    const sym = `${asset}${this.quote}`;
    const b = this.market.getBook(sym);
    if (b) return b.bid;
    const p = this.positions.get(sym);
    return p ? p.entry_price : null;
  }

  /** [patrimônio, saldo livre, exposição] — marcado no BID. */
  equity(): [number, number, number] {
    const bal = this.broker.balances();
    const free = bal[this.quote] ?? 0;
    let expo = 0;
    for (const [asset, qty] of Object.entries(bal)) {
      if (asset === this.quote || qty <= 0) continue;
      const px = this.priceOf(asset);
      if (px !== null) expo += qty * px;
    }
    return [free + expo, free, expo];
  }

  toBrl(amount: number): number | null {
    if (this.quote === "BRL") return amount;
    const b = this.market.brlBook();
    return b ? amount * b.bid : null;
  }

  // ----------------------------------------------------------- controles
  start(now = this.clock()) {
    const prev = this.status;
    this.status = "RODANDO";
    this.statusReason = "Iniciado pelo proprietário";
    this.persistState();
    this.log("INFO", "controle", `Robô INICIADO (antes: ${prev})`, null, now);
    this.brain.think(now, "info", "Robô iniciado: operação autônoma liberada dentro dos limites de risco.");
  }

  pause(now = this.clock(), reason = "Pausado pelo proprietário") {
    if (this.status === "EMERGENCIA") return;
    this.status = "PARADO";
    this.statusReason = reason;
    this.persistState();
    this.log("INFO", "controle", `Robô PAUSADO: ${reason}`, null, now);
    this.brain.think(now, "info", "Robô pausado: sem novas entradas. Stops das posições abertas continuam ativos.");
  }

  async emergencyStop(now = this.clock(), reason = "Botão de emergência") {
    this.status = "EMERGENCIA";
    this.statusReason = reason;
    this.persistState();
    this.log("CRITICO", "controle", `EMERGÊNCIA acionada: ${reason}`, null, now);
    const closed: string[] = [], failed: string[] = [];
    for (const pos of [...this.positions.values()]) {
      const b = this.market.getBook(pos.symbol);
      if (b && (await this.close(pos, b, now, "EMERGENCIA", reason))) closed.push(pos.symbol); else failed.push(pos.symbol);
    }
    this.brain.think(now, "alerta", `EMERGÊNCIA: robô travado. Posições encerradas: ${closed.length ? closed.join(", ") : "nenhuma"}` +
      (failed.length ? `; FALHA ao encerrar: ${failed.join(", ")}` : ""));
    return { closed, failed };
  }

  updateRiskSettings(data: Record<string, unknown>, now = this.clock()): RiskSettings {
    const next = validateRisk(data, this.riskSettings);
    this.riskSettings = next;
    this.risk.settings = next;
    this.broker.updateCosts(feeRate(next), next.slippage_pct);
    this.repo.kvSet("risk_settings", next);
    this.log("AVISO", "risco", "Configurações de risco alteradas pelo proprietário", { novas: data }, now);
    return next;
  }

  effectiveStatus(now: number): [string, string] {
    if (this.status !== "RODANDO") return [this.status, this.statusReason];
    if (this.risk.state.daily_locked) return ["PAUSADO", this.risk.state.daily_lock_reason];
    if (now < this.risk.state.pause_until) return ["PAUSADO", this.risk.state.pause_reason];
    if (this.market.fatalError) return ["PAUSADO", this.market.fatalError];
    return [this.status, this.statusReason];
  }

  // ---------------------------------------------------------------- ciclo
  dataFresh(symbol: string, now: number): [boolean, string] {
    if (this.market.fatalError) return [false, this.market.fatalError];
    const b = this.market.getBook(symbol);
    if (!b) return [false, `Sem cotação de ${symbol} ainda`];
    const age = now - b.ts;
    const limit = this.riskSettings.stale_data_seconds;
    if (age > limit) return [false, `Cotação de ${symbol} desatualizada há ${age.toFixed(0)}s (limite ${limit}s)`];
    const c1 = this.market.getCandles(symbol, "1m");
    if (!c1.length || now * 1000 - c1[c1.length - 1].openTime > 180_000) return [false, `Candles de 1m de ${symbol} atrasados (possível falha de conexão)`];
    if (!this.market.getFilters(symbol)) return [false, `Filtros de negociação de ${symbol} ainda não carregados`];
    return [true, ""];
  }

  async step(now = this.clock()) {
    this.stepCount += 1;
    this.lastStepTs = now;
    this.rolloverDay(now);
    if (!(await this.ensureAccount(now))) return;
    if (this.risk.checkDailyLoss(this.equity()[0])) {
      this.log("AVISO", "risco", this.risk.state.daily_lock_reason, null, now);
      this.brain.think(now, "risco", this.risk.state.daily_lock_reason);
    }
    for (const s of this.cfg.symbols) await this.stepSymbol(s, now);
    await this.reconcile(now);
    if (now - this.lastEquityTs >= 300) {
      this.lastEquityTs = now;
      const eq = this.equity()[0];
      this.repo.insertEquity(now, eq, this.toBrl(eq));
    }
    this.persistRisk();
    const [st, reason] = this.effectiveStatus(now);
    this.brain.activity = st === "RODANDO"
      ? `Monitorando ${this.cfg.symbols.length} ativos em 1m/5m/15m/1h — ${this.positions.size} posição(ões) aberta(s)`
      : `${st === "EMERGENCIA" ? "EMERGÊNCIA" : st}: ${reason || "sem novas entradas"} (análise continua ativa)`;
  }

  private rolloverDay(now: number) {
    const key = dayKey(now, this.cfg.tzOffsetHours);
    if (key !== this.risk.state.day_key && this.accountReady()) {
      const first = !this.risk.state.day_key;
      const eq = this.equity()[0];
      this.risk.newDay(key, eq);
      if (!first) this.log("INFO", "risco", `Novo dia ${key}: contadores diários reiniciados (patrimônio ${eq.toFixed(4)})`, null, now);
    }
  }

  private async stepSymbol(symbol: string, now: number) {
    const [fresh, reason] = this.dataFresh(symbol, now);
    const book = this.market.getBook(symbol);
    const pos = this.positions.get(symbol);
    if (pos) await this.guardExchange(pos, now);
    const still = this.positions.get(symbol);
    if (still) {
      if (fresh && book) await this.manage(still, book, now);
      else if (this.throttled(`stale-pos-${symbol}`, now)) {
        const msg = `Posição aberta em ${symbol} sem dados atualizados (${reason}). Saídas aguardando dados válidos.`;
        this.log("AVISO", "dados", msg, null, now);
        this.brain.think(now, "alerta", msg, symbol);
      }
    }
    const c1 = this.market.getCandles(symbol, "1m");
    const closed = c1.slice(-3).filter((c) => c.closed);
    if (!closed.length) return;
    const lastClosed = closed[closed.length - 1].openTime;
    if (lastClosed > (this.lastEval.get(symbol) ?? 0)) {
      this.lastEval.set(symbol, lastClosed);
      await this.evaluate(symbol, now, book, fresh, reason, lastClosed);
    }
  }

  // ------------------------------------------------------------- análise
  private async evaluate(symbol: string, now: number, book: Book | null, fresh: boolean, reason: string, candleTime: number) {
    const rs = this.riskSettings;
    const candles = {} as Record<TF, Candle[]>;
    for (const tf of TIMEFRAMES) candles[tf] = this.market.getCandles(symbol, tf);
    const circuit = this.risk.checkCircuit(symbol, candles["1m"], now);
    if (circuit) { this.log("AVISO", "risco", circuit, null, now); this.brain.think(now, "risco", circuit, symbol); }

    const pos = this.positions.get(symbol);
    if (pos && fresh && book) {
      const why = this.strategy.trendInvalidated(symbol, candles["15m"], pos.entry_time);
      if (why) await this.close(pos, book, now, "TENDENCIA_INVALIDADA", why);
    }

    const a = this.strategy.evaluate(symbol, candles, book, now, { feeRate: feeRate(rs), slippagePct: rs.slippage_pct,
      maxSpreadPct: rs.max_spread_pct, minRr: rs.min_reward_risk, minScore: rs.min_score, fast: this.fastEval });
    a.last_1m_open_time = candleTime;
    this.lastAnalysis.set(symbol, a);
    const blockers = this.risk.entryBlockers(symbol, now, { botStatus: this.status, openSymbols: [...this.positions.keys()],
      inFlight: this.inFlight, dataFresh: fresh, dataReason: reason });

    let decision = "SEM SINAL";
    let sizing: string | null = null;
    let accepted = false;
    if (a.action === "COMPRAR") {
      if (blockers.length) {
        decision = "BLOQUEADA PELO RISCO";
        this.brain.think(now, "rejeitada", `Sinal de compra em ${symbol} (pontuação ${a.score.toFixed(0)}) REJEITADO: ${blockers[0]}`, symbol);
      } else {
        const [eq, free, expo] = this.equity();
        const f = this.market.getFilters(symbol)!;
        const dust = this.broker.balances()[f.baseAsset] ?? 0;
        const sz = sizePosition(symbol, eq, free, expo, a.entry!, a.stop!, f, rs, dust);
        sizing = sz.reason;
        if (!sz.ok) {
          decision = "RECUSADA (CAPITAL)";
          this.brain.think(now, "rejeitada", `Sinal em ${symbol} recusado: ${sz.reason}`, symbol);
          if (this.throttled(`capital-${symbol}`, now, 900)) this.log("AVISO", "capital", sz.reason, sz.details, now);
        } else if (book) {
          const opened = await this.open(symbol, a, sz.qty, sz.risk_quote, book, now);
          decision = opened ? "ACEITA" : "FALHA NA EXECUÇÃO";
          accepted = !!opened;
        }
      }
    }
    this.brain.record(a, blockers, decision, sizing);
    if (this.persistDecisions) {
      const details: Record<string, unknown> = { failed_gates: a.gates.filter((g) => !g.passed).map((g) => g.label), blockers, decision };
      if (a.action === "COMPRAR") Object.assign(details, { score: a.score, entry: a.entry, stop: a.stop, take_profit: a.take_profit, reasons: a.reasons, sizing });
      this.repo.insertDecision(now, symbol, a.action, accepted, a.score, `${decision}: ${a.summary}`, details);
    }
  }

  // ------------------------------------------------------------- execução
  private async open(symbol: string, a: Analysis, qty: number, riskQuote: number, book: Book, now: number): Promise<Position | null> {
    const f = this.market.getFilters(symbol)!;
    const cid = `${this.cidPrefix()}-${symbol}-${Math.floor(a.last_1m_open_time / 60000)}-B`;
    this.inFlight.add(symbol);
    let pos: Position;
    let fill: Fill;
    try {
      fill = await this.broker.marketBuy(symbol, qty, book, f, cid, now);
      const held = fill.qty - (fill.fee_asset === f.baseAsset ? fill.fee : 0);
      const stop = roundPrice(f, a.stop!);
      const tp = roundPrice(f, a.take_profit!, true);
      pos = {
        id: null, symbol, mode: this.mode, status: "ABERTA", entry_time: now, entry_price: fill.price, qty: held,
        cost_quote: fill.quote_qty, stop_price: stop, initial_stop: stop, take_profit: tp, risk_quote: riskQuote,
        atr_at_entry: a.atr_5m ?? 0, score: a.score, strategy: a.strategy, entry_order_id: cid, fees_quote: fill.fee_quote,
        highest_price: book.bid, breakeven_done: false, exit_time: null, exit_price: null, exit_reason: null,
        exit_order_id: null, proceeds_quote: null, pnl_quote: null, pnl_pct: null, r_multiple: null, notes: [],
        protect_order_id: null, protect_failures: 0,
      };
      this.repo.savePosition(pos);
      this.repo.linkOrder(cid, pos.id!);
    } catch (e) {
      this.broker.reload();
      if (e instanceof OrderRejected) {
        const msg = `Compra em ${symbol} rejeitada: ${e.message}`;
        this.log("AVISO", "ordem", msg, null, now);
        this.brain.think(now, "rejeitada", msg, symbol);
      } else {
        this.lastError = String(e);
        this.log("CRITICO", "ordem", `Falha ao executar compra em ${symbol}: ${e}`, null, now);
        const p = this.risk.recordError(now);
        if (p) this.brain.think(now, "risco", p);
      }
      return null;
    } finally {
      this.inFlight.delete(symbol);
    }
    this.positions.set(symbol, pos);
    const msg = `COMPRA ${this.broker.sendsOrders ? "NA TESTNET" : "SIMULADA"} ${symbol}: ${pos.qty} a ${fill.price.toPrecision(6)} (custo ${fill.quote_qty.toFixed(4)} ${this.quote}, ` +
      `taxa ${fill.fee_quote.toFixed(5)}); stop ${pos.stop_price} / alvo ${pos.take_profit}; pontuação ${a.score.toFixed(0)}; ` +
      `risco planejado ${riskQuote.toFixed(4)} ${this.quote}`;
    this.log("INFO", "operacao", msg, { position_id: pos.id, reasons: a.reasons }, now);
    this.brain.think(now, "aceita", msg + " | Motivos: " + a.reasons.join("; "), symbol);
    await this.protectOnExchange(pos, now);
    return pos;
  }

  private async manage(pos: Position, book: Book, now: number) {
    const bid = book.bid;
    const fee = feeRate(this.riskSettings);
    if (bid > pos.highest_price) pos.highest_price = bid;
    const r = pos.entry_price - pos.initial_stop;
    let changed = false;
    const be = pos.entry_price * (1 + 2 * fee);
    if (r > 0 && !pos.breakeven_done && bid >= pos.entry_price + r) {
      pos.breakeven_done = true;
      if (be > pos.stop_price) {
        pos.stop_price = be;
        changed = true;
        this.brain.think(now, "info", `${pos.symbol}: lucro de 1R atingido — stop movido para o break-even (${be.toPrecision(6)}, cobre as taxas)`, pos.symbol);
      }
    }
    if (r > 0 && bid >= pos.entry_price + r * 1.5 && pos.atr_at_entry > 0) {
      const trail = pos.highest_price - pos.atr_at_entry;
      if (trail > pos.stop_price + r * 0.1) { pos.stop_price = trail; changed = true; }
    }
    if (changed) {
      this.repo.savePosition(pos);
      await this.protectOnExchange(pos, now);
    }
    if (!this.positions.has(pos.symbol)) return;
    if (bid <= pos.stop_price) {
      const reason = !pos.breakeven_done ? "STOP_LOSS" : pos.stop_price > be ? "STOP_MOVEL" : "BREAK_EVEN";
      await this.close(pos, book, now, reason, `bid ${bid} <= stop ${pos.stop_price}`);
    } else if (bid >= pos.take_profit) {
      await this.close(pos, book, now, "TAKE_PROFIT", `bid ${bid} >= alvo ${pos.take_profit}`);
    } else if (now - pos.entry_time >= this.riskSettings.max_trade_minutes * 60) {
      await this.close(pos, book, now, "TEMPO_MAXIMO", `operação aberta há mais de ${this.riskSettings.max_trade_minutes} min`);
    }
  }

  async close(pos: Position, book: Book, now: number, reason: string, detail = ""): Promise<boolean> {
    const f = this.market.getFilters(pos.symbol);
    if (!f) return false;
    const cid = `${this.cidPrefix()}-${pos.id}-S`; // um único ID de saída por posição: impede venda duplicada
    const heldBefore = this.broker.balances()[f.baseAsset] ?? 0;
    const dustBefore = Math.max(heldBefore - pos.qty, 0);
    let fill: Fill;
    try {
      if (this.broker.unprotect && pos.protect_order_id) {
        // tira o stop da corretora antes de vender; se ele já tinha sido executado, usa essa execução
        const done = await this.broker.unprotect(pos, f, now);
        pos.protect_order_id = null;
        this.repo.savePosition(pos);
        if (done) return this.finishClose(pos, f, done, dustBefore, now, "STOP_CORRETORA", "stop executado pela corretora");
      }
      fill = await this.broker.marketSell(pos.symbol, heldBefore, book, f, cid, now); // vende TODO o saldo (recicla a poeira)
    } catch (e) {
      this.broker.reload();
      if (this.broker.protect && this.positions.has(pos.symbol)) await this.protectOnExchange(pos, now); // volta a proteger
      if (e instanceof OrderRejected) {
        if (this.throttled(`close-fail-${pos.symbol}`, now, 300)) {
          const msg = `NÃO foi possível vender ${pos.symbol} (${reason}): ${e.message}. Se o valor da posição ficou abaixo do mínimo da Binance, ela só poderá ser vendida se o preço subir.`;
          this.log("CRITICO", "ordem", msg, null, now);
          this.brain.think(now, "alerta", msg, pos.symbol);
        }
      } else {
        this.lastError = String(e);
        this.log("CRITICO", "ordem", `Falha ao vender ${pos.symbol}: ${e}`, null, now);
        this.risk.recordError(now);
      }
      return false;
    }
    return this.finishClose(pos, f, fill, dustBefore, now, reason, detail);
  }

  private finishClose(pos: Position, f: NonNullable<ReturnType<MarketData["getFilters"]>>, fill: Fill, dustBefore: number,
    now: number, reason: string, detail: string): boolean {
    const net = fill.quote_qty - (fill.fee_asset === f.quoteAsset ? fill.fee : 0);
    const dustAfter = this.broker.balances()[f.baseAsset] ?? 0;
    const dustDelta = (dustAfter - dustBefore) * fill.price * (1 - feeRate(this.riskSettings));
    pos.status = "FECHADA";
    pos.exit_time = now;
    pos.exit_price = fill.price;
    pos.exit_reason = reason;
    pos.exit_order_id = fill.client_order_id;
    pos.proceeds_quote = net;
    pos.fees_quote += fill.fee_quote;
    pos.pnl_quote = net + dustDelta - pos.cost_quote;
    pos.pnl_pct = pos.cost_quote ? (pos.pnl_quote / pos.cost_quote) * 100 : 0;
    pos.r_multiple = pos.risk_quote ? pos.pnl_quote / pos.risk_quote : null;
    if (Math.abs(dustAfter - dustBefore) > 1e-15) pos.notes.push(`poeira ${f.baseAsset}: ${dustBefore} -> ${dustAfter} (valor incluído no resultado)`);
    if (detail) pos.notes.push(detail);
    this.repo.savePosition(pos);
    this.repo.linkOrder(fill.client_order_id, pos.id ?? 0);
    this.positions.delete(pos.symbol);
    const pause = this.risk.onTradeClosed(pos.symbol, pos.pnl_quote, now);
    const msg = `VENDA ${pos.symbol} [${reason}] a ${fill.price.toPrecision(6)}: ${pos.pnl_quote > 0 ? "LUCRO" : "PREJUÍZO"} de ` +
      `${pos.pnl_quote.toFixed(4)} ${this.quote} (${pos.pnl_pct >= 0 ? "+" : ""}${pos.pnl_pct.toFixed(2)}%, ` +
      `${(pos.r_multiple ?? 0) >= 0 ? "+" : ""}${(pos.r_multiple ?? 0).toFixed(2)}R), taxas totais ${pos.fees_quote.toFixed(5)}`;
    this.log("INFO", "operacao", msg, { position_id: pos.id }, now);
    this.brain.think(now, "saida", msg, pos.symbol);
    if (pause) { this.log("AVISO", "risco", pause, null, now); this.brain.think(now, "risco", pause); }
    return true;
  }

  // ------------------------------------------------- proteção na corretora
  private cidPrefix(): string {
    const tag = this.broker.meta.tag;
    return typeof tag === "string" && tag ? `CTA${tag}` : "CTA";
  }

  /** Registra (ou move) o stop-loss na corretora. Sem proteção após 3 tentativas = encerra a posição. */
  private async protectOnExchange(pos: Position, now: number) {
    if (!this.broker.protect) return;
    const f = this.market.getFilters(pos.symbol);
    if (!f) return;
    try {
      await this.broker.protect(pos, f, now);
      pos.protect_failures = 0;
      this.repo.savePosition(pos);
    } catch (e) {
      pos.protect_failures = (pos.protect_failures ?? 0) + 1;
      this.repo.savePosition(pos);
      const msg = `Falha ao registrar o stop de ${pos.symbol} na corretora (${pos.protect_failures}/3): ${e instanceof Error ? e.message : e}`;
      this.log("CRITICO", "ordem", msg, null, now);
      this.brain.think(now, "alerta", msg, pos.symbol);
    }
  }

  /** Confere o stop da corretora e tenta proteger posições ainda sem stop registrado. */
  private async guardExchange(pos: Position, now: number) {
    if (!this.broker.sendsOrders) return;
    const f = this.market.getFilters(pos.symbol);
    if (!f) return;
    if (pos.protect_order_id && this.broker.checkProtection && this.throttled(`check-${pos.id}`, now, 15)) {
      try {
        const fill = await this.broker.checkProtection(pos, f, now);
        if (fill) {
          const dustBefore = Math.max((this.broker.balances()[f.baseAsset] ?? 0) + fill.qty - pos.qty, 0);
          this.finishClose(pos, f, fill, dustBefore, now, "STOP_CORRETORA", "stop executado pela corretora");
          return;
        }
      } catch (e) {
        if (this.throttled(`check-fail-${pos.id}`, now, 120)) this.log("AVISO", "ordem", `Não foi possível consultar o stop de ${pos.symbol}: ${e}`, null, now);
      }
    }
    if (!pos.protect_order_id && this.broker.protect && this.throttled(`reprotect-${pos.id}`, now, 10)) {
      if ((pos.protect_failures ?? 0) >= 3) {
        const book = this.market.getBook(pos.symbol);
        if (book) await this.close(pos, book, now, "SEM_PROTECAO", "stop não pôde ser registrado na corretora (stop é obrigatório)");
        return;
      }
      await this.protectOnExchange(pos, now);
    }
  }

  private async reconcile(now: number) {
    if (!this.broker.reconcile || !this.throttled("reconcile", now, 60)) return;
    try {
      const issues = await this.broker.reconcile([...this.positions.values()], now);
      for (const msg of issues) {
        this.log("CRITICO", "conciliacao", msg, null, now);
        this.brain.think(now, "alerta", msg);
      }
      if (issues.length) {
        this.risk.state.pause_until = now + 15 * 60;
        this.risk.state.pause_reason = "Saldo da conta diferente do registrado pelo robô: novas entradas pausadas por 15 min.";
      }
    } catch (e) {
      if (this.throttled("reconcile-fail", now, 300)) this.log("AVISO", "conciliacao", `Conciliação indisponível: ${e}`, null, now);
    }
  }

  // ------------------------------------------------------------- snapshot
  snapshot(now = this.clock()) {
    const [eq, free, expo] = this.equity();
    const rs = this.riskSettings;
    const reserve = (eq * rs.fee_reserve_pct) / 100;
    const [st, reason] = this.effectiveStatus(now);
    const start = dayStart(now, this.cfg.tzOffsetHours);
    const today = { ...summarize(this.repo.closedPositions({ since: start, mode: this.mode, limit: 100_000 })),
      fees_paid: this.repo.feesSince(start, this.mode), day_start_ts: start };
    const totals = summarize(this.repo.closedPositions({ mode: this.mode, limit: 1_000_000 }));
    const brlBook = this.market.brlBook();
    const positions = [...this.positions.values()].map((p) => {
      const b = this.market.getBook(p.symbol);
      return { ...p, current_bid: b?.bid, unrealized_pnl: b ? p.qty * b.bid * (1 - feeRate(rs)) - p.cost_quote : undefined };
    });
    const market: Record<string, unknown> = {};
    for (const s of this.cfg.symbols) {
      const b = this.market.getBook(s);
      const c1 = this.market.getCandles(s, "1m");
      const c1h = this.market.getCandles(s, "1h");
      const la = (this.brain.latest[s] ?? {}) as Record<string, unknown>;
      const dayOpen = c1h.length >= 24 ? c1h[c1h.length - 24].open : null;
      const lastPx = c1.length ? c1[c1.length - 1].close : null;
      market[s] = {
        bid: b?.bid ?? null, ask: b?.ask ?? null, spread_pct: b ? ((b.ask - b.bid) / ((b.ask + b.bid) / 2)) * 100 : null,
        last: lastPx, change_24h_pct: lastPx && dayOpen ? (lastPx / dayOpen - 1) * 100 : null,
        score: la.score ?? null, signal: la.signal ?? null, decision: la.decision ?? null, regime: la.regime ?? null,
        volatility: la.volatility ?? null, trends: la.trends ?? {},
      };
    }
    const avail = Math.max(free - reserve, 0);
    return {
      server_time: now, uptime_s: now - this.startedAt, mode: this.mode, mode_label: MODE_LABEL[this.mode], is_real_money: false,
      sends_orders: this.broker.sendsOrders,
      data_source: this.market.sourceName, synthetic_data: this.market.isSynthetic, status: st, status_reason: reason,
      strategy: `${STRATEGY_NAME} v${STRATEGY_VERSION}`, symbols: this.cfg.symbols,
      account: {
        initialized: this.accountReady(), quote_asset: this.quote, equity: eq, equity_brl: this.toBrl(eq), free,
        available: avail, available_brl: this.toBrl(avail), exposure: expo, brl_rate: brlBook ? brlBook.bid : null,
        initial: this.broker.meta, balances: this.broker.balances(),
      },
      today, totals, risk: this.risk.status(now, eq), risk_settings: rs, positions,
      brain: this.brain.snapshot(), market,
      health: { ...this.market.health(now), engine_last_step_age_s: Math.round((now - this.lastStepTs) * 10) / 10, engine_last_error: this.lastError },
    };
  }
}
