// Dados de mercado em tempo real direto do celular para a Binance (endpoints oficiais
// só de dados públicos). REST para histórico/filtros + WebSocket com reconexão automática,
// watchdog contra conexão "zumbi", ressincronização após reconectar e fallback por REST.
import { filtersFromExchangeInfo } from "./filters.ts";
import type { SymbolFilters } from "./filters.ts";
import { TF_MS, TIMEFRAMES } from "./types.ts";
import type { Book, Candle, TF } from "./types.ts";

export interface MarketData {
  sourceName: string;
  isSynthetic: boolean;
  symbols: string[];
  brlSymbol: string | null;
  fatalError: string | null;
  getCandles(symbol: string, tf: TF): Candle[];
  getBook(symbol: string): Book | null;
  getFilters(symbol: string): SymbolFilters | null;
  brlBook(): Book | null;
  health(now: number): Record<string, unknown>;
}

const MAX_CANDLES = 600;

export class CandleStore {
  data = new Map<string, Candle[]>();
  get(symbol: string, tf: string): Candle[] { return this.data.get(`${symbol}|${tf}`) ?? []; }
  set(symbol: string, tf: string, list: Candle[]) { this.data.set(`${symbol}|${tf}`, list); }

  upsert(symbol: string, tf: string, c: Candle) {
    const key = `${symbol}|${tf}`;
    const s = this.data.get(key) ?? [];
    const lastC = s[s.length - 1];
    if (!lastC || c.openTime > lastC.openTime) {
      if (lastC && !lastC.closed) lastC.closed = true; // o período anterior terminou
      s.push(c);
    } else if (c.openTime === lastC.openTime) {
      s[s.length - 1] = c;
    } else {
      for (let i = s.length - 1; i >= 0; i--) {
        if (s[i].openTime === c.openTime) { s[i] = c; break; }
        if (s[i].openTime < c.openTime) { s.splice(i + 1, 0, c); break; }
      }
    }
    if (s.length > MAX_CANDLES) s.splice(0, s.length - MAX_CANDLES);
    this.data.set(key, s);
  }

  merge(symbol: string, tf: string, list: Candle[]) {
    for (const c of [...list].sort((a, b) => a.openTime - b.openTime)) this.upsert(symbol, tf, c);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function parseKline(r: any[], nowMs: number): Candle {
  const closeTime = Number(r[6]);
  return { openTime: Number(r[0]), open: +r[1], high: +r[2], low: +r[3], close: +r[4], volume: +r[5], closeTime,
    quoteVolume: +r[7], trades: Number(r[8]), closed: closeTime < nowMs };
}

const REST_HOSTS = ["https://data-api.binance.vision", "https://api.binance.com", "https://api-gcp.binance.com"];
const WS_URL = "wss://data-stream.binance.vision";
const WS_API_URL = "wss://ws-api.binance.com:443/ws-api/v3";
const WS_API_METHOD: Record<string, string> = {
  "/api/v3/exchangeInfo": "exchangeInfo", "/api/v3/klines": "klines", "/api/v3/ticker/bookTicker": "ticker.book",
};

export class GeoBlocked extends Error {}

export class BinanceMarket implements MarketData {
  sourceName = "binance";
  isSynthetic = false;
  symbols: string[];
  quote: string;
  brlSymbol: string | null;
  fatalError: string | null = null;
  store = new CandleStore();
  books = new Map<string, Book>();
  filters = new Map<string, SymbolFilters>();
  ready = false;
  private ws: WebSocket | null = null;
  useWsApi = false; // plano B: API WebSocket oficial quando o navegador bloquear o REST
  private stopped = false;
  private backoff = 1;
  private hostIndex = 0;
  private timers: number[] = [];
  connected = false;
  reconnects = 0;
  connections = 0;
  messages = 0;
  lastMessage = 0;
  lastError: string | null = null;
  lastResync = 0;

  constructor(symbols: string[], quote: string, brlSymbol: string | null) {
    this.symbols = symbols;
    this.quote = quote;
    this.brlSymbol = quote === "BRL" ? null : brlSymbol;
  }

  getCandles(symbol: string, tf: TF) { return this.store.get(symbol, tf); }
  getBook(symbol: string) { return this.books.get(symbol) ?? null; }
  getFilters(symbol: string) { return this.filters.get(symbol) ?? null; }
  brlBook() { return this.brlSymbol ? this.getBook(this.brlSymbol) : null; }

  /** Plano B: mesma consulta pela API WebSocket oficial da Binance (não sofre bloqueio de CORS). */
  private wsApi(path: string, params: Record<string, string | number>): Promise<unknown> {
    const method = WS_API_METHOD[path];
    const p: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(params)) p[k] = k === "symbols" ? JSON.parse(String(v)) : v;
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(WS_API_URL);
      const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const timer = setTimeout(() => { ws.close(); reject(new Error("tempo esgotado na API WebSocket")); }, 15_000);
      ws.onopen = () => ws.send(JSON.stringify({ id, method, params: p }));
      ws.onmessage = (ev) => {
        const msg = JSON.parse(String(ev.data));
        if (msg.id !== id) return;
        clearTimeout(timer);
        ws.close();
        if (msg.status === 451) reject(new GeoBlocked("A Binance bloqueou o acesso a partir da sua localização (HTTP 451)."));
        else if (msg.status === 200) resolve(msg.result);
        else reject(new Error(msg.error?.msg ?? `API WebSocket respondeu ${msg.status}`));
      };
      ws.onerror = () => { clearTimeout(timer); reject(new Error("falha na API WebSocket")); };
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async rest(path: string, params: Record<string, string | number>): Promise<any> {
    if (this.useWsApi) return this.wsApi(path, params);
    try {
      return await this.restHttp(path, params);
    } catch (e) {
      if (e instanceof GeoBlocked) throw e;
      const res = await this.wsApi(path, params); // REST indisponível (ex.: bloqueio do navegador): usa o plano B
      this.useWsApi = true;
      return res;
    }
  }

  private async restHttp(path: string, params: Record<string, string | number>) {
    const qs = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString();
    let lastErr: unknown = null;
    for (let attempt = 0; attempt < REST_HOSTS.length; attempt++) {
      const host = REST_HOSTS[(this.hostIndex + attempt) % REST_HOSTS.length];
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 10_000);
      try {
        const res = await fetch(`${host}${path}?${qs}`, { signal: ctrl.signal, cache: "no-store" });
        if (res.status === 451) throw new GeoBlocked("A Binance bloqueou o acesso a partir da sua localização (HTTP 451).");
        if (res.status === 429 || res.status === 418) throw new Error(`Limite de requisições da Binance (HTTP ${res.status})`);
        if (!res.ok) throw new Error(`Binance respondeu HTTP ${res.status}`);
        this.hostIndex = (this.hostIndex + attempt) % REST_HOSTS.length;
        return await res.json();
      } catch (e) {
        if (e instanceof GeoBlocked) throw e;
        lastErr = e;
      } finally {
        clearTimeout(t);
      }
    }
    throw new Error(`Sem conexão com a Binance: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
  }

  private wanted(): string[] { return [...this.symbols, ...(this.brlSymbol ? [this.brlSymbol] : [])]; }

  async loadFilters() {
    const info = await this.rest("/api/v3/exchangeInfo", { symbols: JSON.stringify(this.wanted()) });
    for (const s of info.symbols ?? []) this.filters.set(s.symbol, filtersFromExchangeInfo(s));
    const missing = this.wanted().filter((s) => !this.filters.has(s));
    if (missing.length) throw new Error(`Pares não encontrados na Binance: ${missing.join(", ")}`);
  }

  async bootstrap(limit = 500) {
    for (const s of this.symbols) {
      for (const tf of TIMEFRAMES) {
        const rows = await this.rest("/api/v3/klines", { symbol: s, interval: tf, limit });
        this.store.merge(s, tf, rows.map((r: unknown[]) => parseKline(r, Date.now())));
      }
    }
    await this.refreshBooks();
    this.lastResync = Date.now() / 1000;
  }

  async refreshBooks() {
    const rows = await this.rest("/api/v3/ticker/bookTicker", { symbols: JSON.stringify(this.wanted()) });
    const now = Date.now() / 1000;
    for (const r of rows) {
      const bid = +r.bidPrice, ask = +r.askPrice;
      if (bid > 0 && ask > 0) this.books.set(r.symbol, { bid, ask, ts: now });
    }
  }

  handle(payload: { data?: unknown } & Record<string, unknown>) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const d: any = payload.data ?? payload;
    if (!d || typeof d !== "object") return;
    if (d.e === "kline") {
      const k = d.k;
      const tf = k.i as TF;
      if (!(tf in TF_MS) || !this.symbols.includes(d.s)) return;
      this.store.upsert(d.s, tf, { openTime: k.t, open: +k.o, high: +k.h, low: +k.l, close: +k.c, volume: +k.v,
        closeTime: k.T, quoteVolume: +(k.q ?? 0), trades: Number(k.n ?? 0), closed: !!k.x });
    } else if (d.s && d.b !== undefined && d.a !== undefined) {
      const bid = +d.b, ask = +d.a;
      if (bid > 0 && ask > 0) this.books.set(d.s, { bid, ask, ts: Date.now() / 1000 });
    }
  }

  streamUrl(): string {
    const names: string[] = [];
    for (const s of this.symbols) {
      const low = s.toLowerCase();
      for (const tf of TIMEFRAMES) names.push(`${low}@kline_${tf}`);
      names.push(`${low}@bookTicker`);
    }
    if (this.brlSymbol) names.push(`${this.brlSymbol.toLowerCase()}@bookTicker`);
    return `${WS_URL}/stream?streams=${names.join("/")}`;
  }

  private connect() {
    if (this.stopped) return;
    let ws: WebSocket;
    try { ws = new WebSocket(this.streamUrl()); } catch (e) { this.scheduleReconnect(String(e)); return; }
    this.ws = ws;
    ws.onopen = () => {
      this.connected = true;
      this.connections += 1;
      this.backoff = 1;
      this.lastError = null;
      this.lastMessage = Date.now() / 1000;
      if (this.connections > 1) this.resync().catch(() => undefined); // preenche a lacuna do período desconectado
    };
    ws.onmessage = (ev) => {
      this.lastMessage = Date.now() / 1000;
      this.messages += 1;
      try { this.handle(JSON.parse(String(ev.data))); } catch { /* mensagem inválida: ignora */ }
    };
    ws.onerror = () => { this.lastError = "Erro na conexão WebSocket"; };
    ws.onclose = () => {
      this.connected = false;
      if (this.ws === ws) this.scheduleReconnect(this.lastError ?? "conexão encerrada");
    };
  }

  private scheduleReconnect(reason: string) {
    if (this.stopped) return;
    this.lastError = reason;
    this.reconnects += 1;
    const delay = Math.min(this.backoff, 60) * (0.8 + Math.random() * 0.4);
    this.backoff = Math.min(this.backoff * 2, 60);
    this.timers.push(window.setTimeout(() => this.connect(), delay * 1000));
  }

  async resync() {
    try { await this.bootstrap(60); } catch (e) { this.lastError = e instanceof Error ? e.message : String(e); }
  }

  private async maintenance() {
    const now = Date.now() / 1000;
    // watchdog: conexão aberta mas sem mensagens = conexão zumbi
    if (this.ws && this.connected && now - this.lastMessage > 30) {
      this.lastError = "Nenhuma mensagem em 30s (conexão reiniciada)";
      this.ws.close();
    }
    try {
      if (!this.connected) {
        await this.refreshBooks();
        for (const s of this.symbols) {
          const rows = await this.rest("/api/v3/klines", { symbol: s, interval: "1m", limit: 3 });
          this.store.merge(s, "1m", rows.map((r: unknown[]) => parseKline(r, Date.now())));
        }
      }
      if (now - this.lastResync >= 600) await this.resync();
    } catch (e) {
      if (e instanceof GeoBlocked) this.fatalError = e.message;
    }
  }

  async start() {
    this.stopped = false;
    for (;;) {
      try {
        await this.loadFilters();
        await this.bootstrap();
        this.fatalError = null;
        break;
      } catch (e) {
        this.fatalError = e instanceof GeoBlocked ? e.message : `Não foi possível carregar dados da Binance (${e instanceof Error ? e.message : e}). Verifique a internet — nova tentativa a cada 15 s.`;
        await new Promise((r) => setTimeout(r, 15_000));
        if (this.stopped) return;
      }
    }
    this.ready = true;
    this.connect();
    this.timers.push(window.setInterval(() => { this.maintenance(); }, 3000));
  }

  stop() {
    this.stopped = true;
    for (const t of this.timers) { clearTimeout(t); clearInterval(t); }
    this.timers = [];
    this.ws?.close();
  }

  health(now: number) {
    const ages: Record<string, number> = {};
    for (const [s, b] of this.books) ages[s] = Math.round((now - b.ts) * 10) / 10;
    return {
      source: this.sourceName, synthetic: this.isSynthetic, fatal_error: this.fatalError, ready: this.ready, book_age_s: ages,
      via: this.useWsApi ? "API WebSocket" : "REST",
      websocket: { connected: this.connected, reconnects: this.reconnects, messages: this.messages,
        last_message_age_s: this.lastMessage ? Math.round((now - this.lastMessage) * 10) / 10 : null, last_error: this.lastError },
    };
  }
}

// --------------------------------------------------------------- agregação
export class IncrementalAggregator {
  size: number;
  series: Candle[] = [];
  constructor(tf: TF) { this.size = TF_MS[tf]; }
  add(c: Candle) {
    const bucket = Math.floor(c.openTime / this.size) * this.size;
    const s = this.series;
    if (!s.length || s[s.length - 1].openTime !== bucket) {
      if (s.length) s[s.length - 1].closed = true;
      s.push({ openTime: bucket, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume,
        closeTime: bucket + this.size - 1, quoteVolume: c.quoteVolume, trades: c.trades, closed: false });
      if (s.length > MAX_CANDLES) s.shift();
    } else {
      const lastC = s[s.length - 1];
      lastC.high = Math.max(lastC.high, c.high);
      lastC.low = Math.min(lastC.low, c.low);
      lastC.close = c.close;
      lastC.volume += c.volume;
      lastC.quoteVolume += c.quoteVolume;
      lastC.trades += c.trades;
    }
    if (c.openTime + 60_000 >= bucket + this.size) s[s.length - 1].closed = true;
  }
}
