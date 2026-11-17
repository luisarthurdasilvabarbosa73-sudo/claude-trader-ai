export type Num = number | null;

export interface Gate { label: string; passed: boolean; detail: string }
export interface Component { label: string; points: number; max: number; detail: string }

export interface SymbolAnalysis {
  ts: number;
  symbol: string;
  signal: "COMPRAR" | "AGUARDAR";
  decision: string;
  score: number;
  min_score: number;
  regime: string;
  volatility: string;
  spread_pct: Num;
  entry: Num;
  stop: Num;
  take_profit: Num;
  rr_net: Num;
  resistance: Num;
  support: Num;
  gates: Gate[];
  components: Component[];
  reasons: string[];
  blockers: string[];
  sizing: string | null;
  failed_gate: string | null;
  trends: Record<string, string>;
}

export interface Thought { ts: number; kind: string; symbol: string | null; text: string }

export interface Position {
  id: number;
  symbol: string;
  status: string;
  entry_time: number;
  entry_price: string;
  qty: string;
  cost_quote: string;
  stop_price: string;
  initial_stop: string;
  take_profit: string;
  risk_quote: string;
  score: number;
  fees_quote: string;
  exit_time: number | null;
  exit_price: string | null;
  exit_reason: string | null;
  pnl_quote: string | null;
  pnl_pct: number | null;
  r_multiple: number | null;
  breakeven_done: boolean;
  current_bid?: number;
  unrealized_pnl?: string;
}

export interface DayStats {
  trades: number;
  wins: number;
  losses: number;
  win_rate: Num;
  gross_profit: number;
  gross_loss: number;
  net_pnl: number;
  fees: number;
  fees_paid?: number;
  profit_factor: Num;
  avg_r: Num;
}

export interface MarketRow {
  bid: Num;
  ask: Num;
  spread_pct: Num;
  last: Num;
  change_24h_pct: Num;
  score: Num;
  signal: string | null;
  decision: string | null;
  regime: string | null;
  volatility: string | null;
  trends: Record<string, string>;
}

export interface RiskSettings { [key: string]: number }

export interface Dashboard {
  server_time: number;
  uptime_s: number;
  mode: string;
  mode_label: string;
  is_real_money: boolean;
  data_source: string;
  synthetic_data: boolean;
  status: "PARADO" | "RODANDO" | "PAUSADO" | "EMERGENCIA";
  status_reason: string;
  strategy: string;
  symbols: string[];
  account: {
    initialized: boolean;
    quote_asset: string;
    equity: string;
    equity_brl: string | null;
    free: string;
    available: string;
    available_brl: string | null;
    exposure: string;
    brl_rate: Num;
    initial: { initial_brl?: string; initial_quote?: string; brl_rate?: number; conversion?: string };
    balances: Record<string, string>;
  };
  today: DayStats;
  totals: DayStats;
  risk: {
    daily_loss_pct: number;
    daily_limit_pct: number;
    daily_locked: boolean;
    daily_lock_reason: string;
    consecutive_losses: number;
    paused: boolean;
    pause_reason: string;
    blocked_symbols: Record<string, string>;
  };
  risk_settings: RiskSettings;
  positions: Position[];
  recent_trades: Position[];
  brain: { activity: string; latest: Record<string, SymbolAnalysis>; thoughts: Thought[]; risks: string[] };
  market: Record<string, MarketRow>;
  health: {
    source: string;
    fatal_error: string | null;
    ready?: boolean;
    websocket?: { connected: boolean; reconnects: number; last_message_age_s: Num; last_error: string | null };
    book_age_s: Record<string, number>;
    engine_last_step_age_s: number;
    engine_last_error: string | null;
  };
  ai_enabled: boolean;
  release: { testnet: boolean; real: boolean };
}

export interface CandleDTO { t: number; o: number; h: number; l: number; c: number; v: number; closed: boolean }

export interface CandlesResponse {
  symbol: string;
  tf: string;
  synthetic: boolean;
  candles: CandleDTO[];
  overlays: Record<string, (number | null)[]>;
  rsi: (number | null)[];
  macd_hist: (number | null)[];
  position: Position | null;
}

export interface Decision {
  id: number;
  ts: number;
  symbol: string;
  action: string;
  accepted: boolean;
  score: number;
  summary: string;
  details: { failed_gates?: string[]; blockers?: string[]; decision?: string };
}

export interface LogEvent { id: number; ts: number; level: string; category: string; message: string }

export interface RiskResponse { settings: RiskSettings; limits: Record<string, { min: number; max: number }> }

export interface ModeInfo {
  current: string;
  modes: { mode: string; available: boolean; label: string; detail: string }[];
  confirmation_phrase: string;
}

export interface AiReports {
  enabled: boolean;
  model: string;
  reports: { id: number; ts: number; model: string; question: string; response: string }[];
}
