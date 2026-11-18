// Gestão de risco e capital — espelha risk/settings.py, risk/capital.py e risk/manager.py.
import { effectiveMinNotional, minQtyMarket, qtyStep, roundQty, validateMarketOrder } from "./filters.ts";
import type { SymbolFilters } from "./filters.ts";
import type { BotStatus, Candle } from "./types.ts";

// ------------------------------------------------------------ limites rígidos
export const HARD_LIMITS: Record<string, [number, number]> = {
  risk_per_trade_pct: [0.1, 3.0],
  max_daily_loss_pct: [0.5, 10.0],
  max_open_positions: [1, 3],
  max_total_exposure_pct: [10.0, 95.0],
  max_spread_pct: [0.01, 0.5],
  min_score: [60.0, 95.0],
  min_reward_risk: [1.2, 5.0],
  max_consecutive_losses: [1, 10],
  loss_streak_pause_minutes: [15, 1440],
  cooldown_minutes_after_exit: [0, 240],
  max_trade_minutes: [15, 720],
  stale_data_seconds: [3, 60],
  fee_rate_pct: [0.0, 0.5],
  slippage_pct: [0.0, 1.0],
  fee_reserve_pct: [0.5, 10.0],
  circuit_move_1m_pct: [1.0, 10.0],
  circuit_pause_minutes: [5, 240],
  max_step_value_pct: [1.0, 25.0],
};
const INT_FIELDS = new Set(["max_open_positions", "max_consecutive_losses", "loss_streak_pause_minutes",
  "cooldown_minutes_after_exit", "max_trade_minutes", "stale_data_seconds", "circuit_pause_minutes"]);

export interface RiskSettings {
  risk_per_trade_pct: number; max_daily_loss_pct: number; max_open_positions: number; max_total_exposure_pct: number;
  max_spread_pct: number; min_score: number; min_reward_risk: number; max_consecutive_losses: number;
  loss_streak_pause_minutes: number; cooldown_minutes_after_exit: number; max_trade_minutes: number;
  stale_data_seconds: number; fee_rate_pct: number; slippage_pct: number; fee_reserve_pct: number;
  circuit_move_1m_pct: number; circuit_pause_minutes: number; max_step_value_pct: number;
}

export const DEFAULT_RISK: RiskSettings = {
  risk_per_trade_pct: 2.0, max_daily_loss_pct: 6.0, max_open_positions: 1, max_total_exposure_pct: 95.0,
  max_spread_pct: 0.15, min_score: 70.0, min_reward_risk: 1.5, max_consecutive_losses: 3,
  loss_streak_pause_minutes: 120, cooldown_minutes_after_exit: 15, max_trade_minutes: 240, stale_data_seconds: 15,
  fee_rate_pct: 0.1, slippage_pct: 0.02, fee_reserve_pct: 2.0, circuit_move_1m_pct: 3.0, circuit_pause_minutes: 30,
  max_step_value_pct: 5.0,
};

export const feeRate = (s: RiskSettings) => s.fee_rate_pct / 100;

export class RiskSettingsError extends Error {}

/** Valida e devolve novas configurações. Rejeita (não corrige) valores fora da faixa rígida. */
export function validateRisk(data: Record<string, unknown>, base: RiskSettings = DEFAULT_RISK): RiskSettings {
  const cur: Record<string, number> = { ...base };
  const errors: string[] = [];
  for (const [key, raw] of Object.entries(data)) {
    if (!(key in HARD_LIMITS)) { errors.push(`Campo desconhecido: ${key}`); continue; }
    const v = Number(raw);
    if (!Number.isFinite(v)) { errors.push(`${key}: valor inválido`); continue; }
    const [lo, hi] = HARD_LIMITS[key];
    if (v < lo || v > hi) { errors.push(`${key}: ${v} fora do limite permitido [${lo}, ${hi}]`); continue; }
    cur[key] = INT_FIELDS.has(key) ? Math.trunc(v) : v;
  }
  if (errors.length) throw new RiskSettingsError(errors.join("; "));
  return cur as unknown as RiskSettings;
}

// ------------------------------------------------------------------ capital
export interface SizingResult { ok: boolean; qty: number; notional: number; risk_quote: number; max_risk_quote: number; reason: string; details: Record<string, string> }

const SAFETY = 1.02;

export function lossPerUnit(entry: number, stop: number, fee: number, slip: number): number {
  return entry * (1 + slip) - (1 - fee) * stop * (1 - slip) * (1 - fee);
}

export function brlToQuote(brl: number, askQuoteInBrl: number, fee: number): number {
  return (brl / askQuoteInBrl) * (1 - fee);
}

export function sizePosition(symbol: string, equity: number, freeQuote: number, currentExposure: number, entry: number,
  stop: number, f: SymbolFilters, s: RiskSettings, existingBase = 0): SizingResult {
  const fee = feeRate(s);
  const slip = s.slippage_pct / 100;
  const q = f.quoteAsset;
  const maxRisk = (equity * s.risk_per_trade_pct) / 100;
  const refuseBase = (reason: string, details: Record<string, string> = {}): SizingResult =>
    ({ ok: false, qty: 0, notional: 0, risk_quote: 0, max_risk_quote: maxRisk, reason, details });
  if (stop >= entry || stop <= 0) return refuseBase("Stop inválido (precisa ficar abaixo da entrada)");
  const lpu = lossPerUnit(entry, stop, fee, slip);
  const entryFill = entry * (1 + slip);
  const reserve = (equity * s.fee_reserve_pct) / 100;
  const spendable = Math.max(freeQuote - reserve, 0);
  const expoRoom = Math.max((equity * s.max_total_exposure_pct) / 100 - currentExposure, 0);
  const qRisk = maxRisk / lpu, qCash = spendable / entryFill, qExpo = expoRoom / entryFill;
  const raw = Math.min(qRisk, qCash, qExpo);
  const limiter = raw === qRisk ? "risco" : raw === qCash ? "saldo livre" : "exposição máxima";
  const qty = roundQty(f, raw);

  const minN = effectiveMinNotional(f);
  const minQ = minQtyMarket(f);
  const stepStr = qtyStep(f);
  const step = Number(stepStr);
  const existing = Math.max(existingBase, 0);
  const exitPx = stop * (1 - slip);
  const sellable = (qb: number) => roundQty(f, existing + qb * (1 - fee));
  const viable = (qb: number) => {
    const sq = sellable(qb);
    return qb * entryFill >= minN * SAFETY && qb >= minQ && sq >= minQ && sq * exitPx >= minN * SAFETY;
  };
  let qNeeded = roundQty(f, Math.max(minQ, entryFill > 0 ? (minN * SAFETY) / entryFill : 0));
  for (let i = 0; i < 200 && !viable(qNeeded); i++) qNeeded = roundQty(f, qNeeded + step * 1.0000001);
  const riskNeeded = qNeeded * lpu;
  const cashNeeded = qNeeded * entryFill;
  const stepValue = step * entry;
  const stepPct = equity > 0 ? (stepValue / equity) * 100 : 100;
  const details: Record<string, string> = {
    max_risk_quote: maxRisk.toFixed(4), loss_per_unit: lpu.toFixed(8), limitador: limiter,
    reserva_taxas: reserve.toFixed(4), saldo_utilizavel: spendable.toFixed(4), min_notional: String(minN),
    posicao_minima_viavel: cashNeeded.toFixed(4), risco_da_posicao_minima: riskNeeded.toFixed(4),
    valor_do_passo_de_lote: stepValue.toFixed(4),
  };
  const refuse = (reason: string) => refuseBase(reason, details);

  if (stepPct > s.max_step_value_pct)
    return refuse(`${symbol} inviável para este capital: cada passo de lote (${stepStr} ${f.baseAsset}) vale ~${stepValue.toFixed(2)} ${q} ` +
      `(${stepPct.toFixed(1)}% do patrimônio). Como a taxa da compra é cobrada no próprio ativo, quase 1 passo vira poeira não vendável — ` +
      `imobilizaria capital demais (limite ${s.max_step_value_pct}%).`);
  if (qty < qNeeded - 1e-12) {
    if (riskNeeded > maxRisk) {
      const pct = equity > 0 ? (riskNeeded / equity) * 100 : 0;
      return refuse(`Capital insuficiente para ${symbol}: a menor posição viável (~${cashNeeded.toFixed(2)} ${q}, para respeitar o mínimo de ` +
        `${minN} ${q} da Binance inclusive na venda pelo stop) arriscaria ${riskNeeded.toFixed(4)} ${q} (${pct.toFixed(2)}% do patrimônio), ` +
        `acima do limite de ${s.risk_per_trade_pct}% por operação. O robô não aumenta o risco para operar.`);
    }
    if (cashNeeded > spendable)
      return refuse(`Saldo insuficiente para ${symbol}: a menor posição viável exige ~${cashNeeded.toFixed(2)} ${q} e há ` +
        `${spendable.toFixed(2)} ${q} utilizáveis (após reservar ${reserve.toFixed(2)} ${q} para taxas).`);
    return refuse(`Limite de exposição total atingido para abrir ${symbol}.`);
  }
  const errors = validateMarketOrder(f, qty, entryFill);
  if (errors.length) return refuse("Ordem violaria filtros da Binance: " + errors.join("; "));
  if (!viable(qty)) return refuse(`Posição de ${qty} ${f.baseAsset} não poderia ser vendida no stop (valor mínimo da Binance).`);
  const risk = qty * lpu;
  const notional = qty * entryFill;
  return { ok: true, qty, notional, risk_quote: risk, max_risk_quote: maxRisk, details,
    reason: `Posição de ${qty} (${notional.toFixed(4)} ${q}); perda máxima planejada ${risk.toFixed(4)} ${q} ` +
      `(limite ${maxRisk.toFixed(4)}); tamanho limitado por: ${limiter}` };
}

// ------------------------------------------------------------ gestor de risco
export interface RiskState {
  day_key: string; day_start_equity: number; daily_locked: boolean; daily_lock_reason: string; consecutive_losses: number;
  pause_until: number; pause_reason: string; symbol_block_until: Record<string, number>; symbol_block_reason: Record<string, string>;
  last_exit_ts: Record<string, number>; error_times: number[];
}

export const newRiskState = (): RiskState => ({
  day_key: "", day_start_equity: 0, daily_locked: false, daily_lock_reason: "", consecutive_losses: 0, pause_until: 0,
  pause_reason: "", symbol_block_until: {}, symbol_block_reason: {}, last_exit_ts: {}, error_times: [],
});

export class RiskManager {
  settings: RiskSettings;
  state: RiskState;
  constructor(settings: RiskSettings, state?: RiskState) {
    this.settings = settings;
    this.state = state ?? newRiskState();
  }

  newDay(key: string, equity: number) {
    Object.assign(this.state, { day_key: key, day_start_equity: equity, daily_locked: false, daily_lock_reason: "", consecutive_losses: 0 });
  }

  dailyLossPct(equity: number): number {
    const s = this.state.day_start_equity;
    return s > 0 ? ((s - equity) / s) * 100 : 0;
  }

  checkDailyLoss(equity: number): boolean {
    const loss = this.dailyLossPct(equity);
    if (!this.state.daily_locked && loss >= this.settings.max_daily_loss_pct) {
      this.state.daily_locked = true;
      this.state.daily_lock_reason = `Limite de perda diária atingido (${loss.toFixed(2)}% >= ${this.settings.max_daily_loss_pct}%). ` +
        "Novas entradas bloqueadas até o próximo dia.";
      return true;
    }
    return false;
  }

  onTradeClosed(symbol: string, pnl: number, now: number): string | null {
    this.state.last_exit_ts[symbol] = now;
    if (pnl < 0) {
      this.state.consecutive_losses += 1;
      if (this.state.consecutive_losses >= this.settings.max_consecutive_losses) {
        const mins = this.settings.loss_streak_pause_minutes;
        this.state.pause_until = now + mins * 60;
        this.state.pause_reason = `${this.state.consecutive_losses} perdas seguidas: pausa de ${mins} min para evitar ` +
          "operar em condição desfavorável (sem tentar recuperar prejuízo).";
        this.state.consecutive_losses = 0;
        return this.state.pause_reason;
      }
    } else this.state.consecutive_losses = 0;
    return null;
  }

  recordError(now: number, windowS = 300, maxErrors = 3): string | null {
    this.state.error_times = [...this.state.error_times.filter((t) => now - t <= windowS), now];
    if (this.state.error_times.length >= maxErrors) {
      this.state.pause_until = now + 15 * 60;
      this.state.pause_reason = `${this.state.error_times.length} falhas de execução em 5 min: pausa de 15 min.`;
      this.state.error_times = [];
      return this.state.pause_reason;
    }
    return null;
  }

  checkCircuit(symbol: string, c1: Candle[], now: number): string | null {
    const recent = c1.filter((c) => c.closed).slice(-3);
    const limit = this.settings.circuit_move_1m_pct;
    for (const c of recent) {
      if (c.open <= 0) continue;
      const move = ((c.high - c.low) / c.open) * 100;
      if (move >= limit) {
        const until = now + this.settings.circuit_pause_minutes * 60;
        if ((this.state.symbol_block_until[symbol] ?? 0) < until - 60) {
          this.state.symbol_block_until[symbol] = until;
          this.state.symbol_block_reason[symbol] = `Movimento anormal de ${move.toFixed(2)}% em 1 minuto (limite ${limit}%): ` +
            `${symbol} bloqueado por ${this.settings.circuit_pause_minutes} min.`;
          return this.state.symbol_block_reason[symbol];
        }
      }
    }
    return null;
  }

  entryBlockers(symbol: string, now: number, o: { botStatus: BotStatus; openSymbols: string[]; inFlight: Set<string>; dataFresh: boolean; dataReason?: string }): string[] {
    const s = this.settings, st = this.state, out: string[] = [];
    if (o.botStatus !== "RODANDO") out.push(`Robô em estado ${o.botStatus}: novas entradas desativadas`);
    if (st.daily_locked) out.push(st.daily_lock_reason);
    if (now < st.pause_until) out.push(`Pausa automática ativa (${Math.floor((st.pause_until - now) / 60) + 1} min restantes): ${st.pause_reason}`);
    if (now < (st.symbol_block_until[symbol] ?? 0)) out.push(st.symbol_block_reason[symbol] ?? `${symbol} bloqueado temporariamente`);
    if (o.openSymbols.includes(symbol)) out.push(`Já existe posição aberta em ${symbol} (proteção contra duplicidade)`);
    if (o.inFlight.has(symbol)) out.push(`Ordem em andamento para ${symbol} (proteção contra duplicidade)`);
    if (o.openSymbols.length >= s.max_open_positions) out.push(`Limite de ${s.max_open_positions} operação(ões) simultânea(s) atingido`);
    const le = st.last_exit_ts[symbol];
    if (le && now - le < s.cooldown_minutes_after_exit * 60) {
      const mins = Math.floor((s.cooldown_minutes_after_exit * 60 - (now - le)) / 60) + 1;
      out.push(`Intervalo de segurança após saída em ${symbol} (${mins} min restantes)`);
    }
    if (!o.dataFresh) out.push(o.dataReason || "Dados de mercado desatualizados");
    return out;
  }

  status(now: number, equity: number) {
    const st = this.state;
    const blocked: Record<string, string> = {};
    for (const [k, v] of Object.entries(st.symbol_block_until)) if (v > now) blocked[k] = st.symbol_block_reason[k] ?? "";
    return {
      daily_loss_pct: this.dailyLossPct(equity), daily_limit_pct: this.settings.max_daily_loss_pct,
      daily_locked: st.daily_locked, daily_lock_reason: st.daily_lock_reason, consecutive_losses: st.consecutive_losses,
      paused: now < st.pause_until, pause_reason: now < st.pause_until ? st.pause_reason : "",
      pause_until: now < st.pause_until ? st.pause_until : null, blocked_symbols: blocked,
    };
  }
}
