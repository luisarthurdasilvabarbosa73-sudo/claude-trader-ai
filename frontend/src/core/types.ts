// Modelos do robô (versão que roda dentro do app, no celular).
// Espelha backend/app/domain.py — a versão Python serve de referência e de backtest.

export type Mode = "SIMULACAO" | "TESTNET" | "REAL";
export type BotStatus = "PARADO" | "RODANDO" | "PAUSADO" | "EMERGENCIA";

export const TIMEFRAMES = ["1m", "5m", "15m", "1h"] as const;
export type TF = (typeof TIMEFRAMES)[number];
export const TF_MS: Record<TF, number> = { "1m": 60_000, "5m": 300_000, "15m": 900_000, "1h": 3_600_000 };

export interface Candle {
  openTime: number; // ms
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTime: number;
  quoteVolume: number;
  trades: number;
  closed: boolean;
}

export interface Book {
  bid: number;
  ask: number;
  ts: number; // segundos (epoch) em que o dado chegou
}

export function spreadPct(b: Book): number {
  const mid = (b.bid + b.ask) / 2;
  return mid > 0 ? ((b.ask - b.bid) / mid) * 100 : 999;
}

export interface Fill {
  client_order_id: string;
  symbol: string;
  side: "BUY" | "SELL";
  qty: number;
  price: number;
  quote_qty: number;
  fee: number;
  fee_asset: string;
  fee_quote: number;
  ts: number;
  mode: Mode;
  reference_price: number;
  position_id?: number | null;
}

export interface Position {
  id: number | null;
  symbol: string;
  mode: Mode;
  status: "ABERTA" | "FECHADA";
  entry_time: number;
  entry_price: number;
  qty: number;
  cost_quote: number;
  stop_price: number;
  initial_stop: number;
  take_profit: number;
  risk_quote: number;
  atr_at_entry: number;
  score: number;
  strategy: string;
  entry_order_id: string;
  fees_quote: number;
  highest_price: number;
  breakeven_done: boolean;
  exit_time: number | null;
  exit_price: number | null;
  exit_reason: string | null;
  exit_order_id: string | null;
  proceeds_quote: number | null;
  pnl_quote: number | null;
  pnl_pct: number | null;
  r_multiple: number | null;
  notes: string[];
}

export function candle(openTime: number, o: number, h: number, l: number, c: number, v = 1, closed = true): Candle {
  return { openTime, open: o, high: h, low: l, close: c, volume: v, closeTime: openTime + 59_999, quoteVolume: v * c, trades: 0, closed };
}
