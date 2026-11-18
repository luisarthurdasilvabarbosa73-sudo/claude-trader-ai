// Armazenamento no próprio celular (localStorage), espelhando backend/app/db.py.
// Coleções com limite de tamanho; tudo gravado a cada mudança.
import type { Fill, Mode, Position } from "./types.ts";

export interface KV {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

export class MemoryKV implements KV {
  data = new Map<string, string>();
  get(k: string) { return this.data.get(k) ?? null; }
  set(k: string, v: string) { this.data.set(k, v); }
  remove(k: string) { this.data.delete(k); }
}

/** localStorage com fallback em memória (navegadores que bloqueiam armazenamento). */
export class BrowserKV implements KV {
  private mem = new MemoryKV();
  private prefix: string;
  constructor(prefix = "cta:") { this.prefix = prefix; }
  get(k: string) {
    try { return localStorage.getItem(this.prefix + k); } catch { return this.mem.get(k); }
  }
  set(k: string, v: string) {
    try { localStorage.setItem(this.prefix + k, v); } catch { this.mem.set(k, v); }
  }
  remove(k: string) {
    try { localStorage.removeItem(this.prefix + k); } catch { this.mem.remove(k); }
  }
}

export interface Decision { id: number; ts: number; symbol: string; action: string; accepted: boolean; score: number; summary: string; details: Record<string, unknown> }
export interface LogEvent { id: number; ts: number; level: string; category: string; message: string; data: unknown }

const DEFAULT_LIMITS = { decisions: 2000, events: 800, equity: 3000, orders: 3000, ai: 20 };

export class Repo {
  kv: KV;
  private cache = new Map<string, unknown>();
  private limits: typeof DEFAULT_LIMITS;
  constructor(kv: KV, limits: Partial<typeof DEFAULT_LIMITS> = {}) {
    this.kv = kv;
    this.limits = { ...DEFAULT_LIMITS, ...limits };
  }

  private load<T>(key: string, def: T): T {
    if (this.cache.has(key)) return this.cache.get(key) as T;
    let v: T = def;
    const raw = this.kv.get(key);
    if (raw) { try { v = JSON.parse(raw) as T; } catch { v = def; } }
    this.cache.set(key, v);
    return v;
  }

  private save(key: string, value: unknown) {
    this.cache.set(key, value);
    try { this.kv.set(key, JSON.stringify(value)); } catch { /* armazenamento cheio: mantém em memória */ }
  }

  private nextId(name: string): number {
    const ids = this.load<Record<string, number>>("ids", {});
    ids[name] = (ids[name] ?? 0) + 1;
    this.save("ids", ids);
    return ids[name];
  }

  // ---------------------------------------------------------------- kv
  kvGet<T>(key: string, def: T): T { return this.load<T>(`kv:${key}`, def); }
  kvSet(key: string, value: unknown) { this.save(`kv:${key}`, value); }

  // ------------------------------------------------------------ ordens
  private orders(): Fill[] { return this.load<Fill[]>("orders", []); }
  getOrder(cid: string): Fill | null { return this.orders().find((o) => o.client_order_id === cid) ?? null; }
  insertOrder(fill: Fill) {
    const list = [...this.orders(), fill];
    this.save("orders", list.slice(-this.limits.orders));
  }
  linkOrder(cid: string, positionId: number) {
    const list = this.orders().map((o) => (o.client_order_id === cid ? { ...o, position_id: positionId } : o));
    this.save("orders", list);
  }
  feesSince(ts: number, mode: Mode): number {
    return this.orders().filter((o) => o.ts >= ts && o.mode === mode).reduce((s, o) => s + o.fee_quote, 0);
  }
  countOrders(): number { return this.orders().length; }

  // ---------------------------------------------------------- posições
  private positions(): Position[] { return this.load<Position[]>("positions", []); }
  savePosition(p: Position): Position {
    const list = [...this.positions()];
    if (p.id === null) {
      p.id = this.nextId("position");
      list.push({ ...p, notes: [...p.notes] });
    } else {
      const i = list.findIndex((x) => x.id === p.id);
      if (i >= 0) list[i] = { ...p, notes: [...p.notes] };
      else list.push({ ...p, notes: [...p.notes] });
    }
    this.save("positions", list);
    return p;
  }
  openPositions(mode?: Mode): Position[] {
    return this.positions().filter((p) => p.status === "ABERTA" && (!mode || p.mode === mode)).map((p) => ({ ...p, notes: [...p.notes] }));
  }
  closedPositions(o: { since?: number; limit?: number; mode?: Mode } = {}): Position[] {
    return this.positions()
      .filter((p) => p.status === "FECHADA" && (o.since === undefined || (p.exit_time ?? 0) >= o.since) && (!o.mode || p.mode === o.mode))
      .sort((a, b) => (b.exit_time ?? 0) - (a.exit_time ?? 0))
      .slice(0, o.limit ?? 500);
  }
  allPositions(limit = 100, mode?: Mode): Position[] {
    return this.positions().filter((p) => !mode || p.mode === mode).sort((a, b) => (b.id ?? 0) - (a.id ?? 0)).slice(0, limit);
  }

  // ---------------------------------------------------------- decisões
  insertDecision(ts: number, symbol: string, action: string, accepted: boolean, score: number, summary: string, details: Record<string, unknown>) {
    const list = this.load<Decision[]>("decisions", []);
    const next = [...list, { id: this.nextId("decision"), ts, symbol, action, accepted, score, summary, details }];
    this.save("decisions", next.slice(-this.limits.decisions));
  }
  recentDecisions(limit = 50, onlyRejected = false): Decision[] {
    const list = this.load<Decision[]>("decisions", []);
    return list.filter((d) => !onlyRejected || !d.accepted).slice(-limit).reverse();
  }

  // ----------------------------------------------------------- eventos
  log(level: string, category: string, message: string, data: unknown = null, ts = Date.now() / 1000) {
    const list = this.load<LogEvent[]>("events", []);
    const next = [...list, { id: this.nextId("event"), ts, level, category, message, data }];
    this.save("events", next.slice(-this.limits.events));
  }
  recentEvents(limit = 100, level?: string): LogEvent[] {
    return this.load<LogEvent[]>("events", []).filter((e) => !level || e.level === level).slice(-limit).reverse();
  }

  // -------------------------------------------------------- patrimônio
  insertEquity(ts: number, equityQuote: number, equityBrl: number | null) {
    const list = this.load<{ ts: number; equity_quote: number; equity_brl: number | null }[]>("equity", []);
    this.save("equity", [...list, { ts, equity_quote: equityQuote, equity_brl: equityBrl }].slice(-this.limits.equity));
  }
  equitySeries(since: number) {
    return this.load<{ ts: number; equity_quote: number; equity_brl: number | null }[]>("equity", []).filter((e) => e.ts >= since);
  }

  // ---------------------------------------------------------------- IA
  insertAiReport(ts: number, model: string, question: string, response: string) {
    const list = this.load<{ id: number; ts: number; model: string; question: string; response: string }[]>("ai", []);
    this.save("ai", [...list, { id: this.nextId("ai"), ts, model, question, response }].slice(-this.limits.ai));
  }
  recentAiReports(limit = 10) {
    return this.load<{ id: number; ts: number; model: string; question: string; response: string }[]>("ai", []).slice(-limit).reverse();
  }
  aiCallsSince(ts: number): number {
    return this.load<{ ts: number }[]>("ai", []).filter((r) => r.ts >= ts).length;
  }

  /** Apaga TODO o histórico salvo neste aparelho. */
  wipe() {
    for (const k of ["orders", "positions", "decisions", "events", "equity", "ai", "ids"]) { this.kv.remove(k); this.cache.delete(k); }
    for (const k of [...this.cache.keys()]) if (k.startsWith("kv:")) { this.kv.remove(k); this.cache.delete(k); }
    for (const k of ["kv:paper_account", "kv:risk_state", "kv:bot_state"]) this.kv.remove(k);
  }
}
