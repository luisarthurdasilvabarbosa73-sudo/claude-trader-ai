// Interface comum dos executores. Simulação (paper.ts) e Testnet (testnet.ts) são arquivos separados.
import type { SymbolFilters } from "./filters.ts";
import type { Book, Fill, Mode, Position } from "./types.ts";

export interface Broker {
  readonly mode: Mode;
  /** Envia ordens a uma corretora (Testnet). A simulação não envia nada. */
  readonly sendsOrders: boolean;
  readonly initialized: boolean;
  meta: Record<string, unknown>;
  balances(): Record<string, number>;
  initialize(quote: string, amount: number, meta: Record<string, unknown>): void | Promise<void>;
  reset(): void;
  reload(): void;
  updateCosts(feeRate: number, slippagePct: number): void;
  marketBuy(symbol: string, qty: number, book: Book, f: SymbolFilters, cid: string, now: number): Fill | Promise<Fill>;
  marketSell(symbol: string, qty: number, book: Book, f: SymbolFilters, cid: string, now: number): Fill | Promise<Fill>;
  /** Registra/atualiza o stop-loss NA CORRETORA (protege mesmo com o app fechado). */
  protect?(pos: Position, f: SymbolFilters, now: number): Promise<void>;
  /** Cancela o stop da corretora antes de sair; devolve a execução se ele já tinha sido executado. */
  unprotect?(pos: Position, f: SymbolFilters, now: number): Promise<Fill | null>;
  /** Confere se o stop da corretora foi executado (ex.: enquanto o app estava fechado). */
  checkProtection?(pos: Position, f: SymbolFilters, now: number): Promise<Fill | null>;
  /** Confere a carteira do robô com o saldo real da conta. Devolve problemas encontrados. */
  reconcile?(positions: Position[], now: number): Promise<string[]>;
}
