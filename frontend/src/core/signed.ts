// Requisições ASSINADAS à API WebSocket oficial da Binance (usado só na Testnet).
// Assinatura HMAC-SHA256 com a Web Crypto do navegador: a chave secreta nunca sai do aparelho
// e nunca é enviada — só a assinatura.

export async function hmacSha256Hex(secret: string, payload: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(payload));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Conteúdo assinado na API WebSocket: todos os parâmetros (menos a assinatura) em ordem alfabética. */
export function signaturePayload(params: Record<string, string | number | boolean>): string {
  return Object.keys(params).filter((k) => k !== "signature").sort().map((k) => `${k}=${params[k]}`).join("&");
}

/** A corretora recusou a requisição (resposta clara). */
export class ExchangeError extends Error {
  code: number | undefined;
  status: number | undefined;
  constructor(message: string, code?: number, status?: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/** Sem resposta (tempo esgotado ou conexão caiu): a ordem PODE ter sido executada. Consultar antes de repetir. */
export class UnknownStatus extends Error {}

export interface WsLike {
  readyState: number;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  send(data: string): void;
  close(): void;
}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };

export class SignedWsApi {
  url: string;
  private apiKey: string;
  private secret: string;
  private factory: (url: string) => WsLike;
  private timeoutMs: number;
  private ws: WsLike | null = null;
  private opening: Promise<void> | null = null;
  private pending = new Map<string, Pending>();
  private seq = 0;
  timeOffsetMs = 0;
  lastError: string | null = null;

  constructor(url: string, apiKey: string, secret: string,
    opts: { wsFactory?: (url: string) => WsLike; timeoutMs?: number } = {}) {
    this.url = url;
    this.apiKey = apiKey;
    this.secret = secret;
    this.factory = opts.wsFactory ?? ((u) => new WebSocket(u) as unknown as WsLike);
    this.timeoutMs = opts.timeoutMs ?? 10_000;
  }

  toString() { return `SignedWsApi(${this.url})`; } // nunca mostra chaves

  private open(): Promise<void> {
    if (this.ws && this.ws.readyState === 1) return Promise.resolve();
    if (this.opening) return this.opening;
    this.opening = new Promise<void>((resolve, reject) => {
      const ws = this.factory(this.url);
      const timer = setTimeout(() => { reject(new Error("tempo esgotado ao conectar na Binance")); ws.close(); }, this.timeoutMs);
      ws.onopen = () => {
        clearTimeout(timer);
        this.ws = ws;
        resolve();
      };
      ws.onmessage = (ev) => this.onMessage(ev.data);
      ws.onerror = () => { this.lastError = "erro na conexão com a Binance"; };
      ws.onclose = () => {
        clearTimeout(timer);
        if (this.ws === ws) this.ws = null;
        for (const [id, p] of this.pending) {
          clearTimeout(p.timer);
          p.reject(new UnknownStatus("conexão com a Binance caiu antes da resposta"));
          this.pending.delete(id);
        }
        reject(new Error("conexão recusada pela Binance"));
      };
    }).finally(() => { this.opening = null; });
    return this.opening;
  }

  private onMessage(raw: unknown) {
    let msg: { id?: string; status?: number; result?: unknown; error?: { code?: number; msg?: string } };
    try { msg = JSON.parse(String(raw)); } catch { return; }
    const p = msg.id ? this.pending.get(msg.id) : undefined;
    if (!p || !msg.id) return;
    clearTimeout(p.timer);
    this.pending.delete(msg.id);
    if (msg.status === 200) p.resolve(msg.result);
    else p.reject(new ExchangeError(msg.error?.msg ?? `Binance respondeu ${msg.status}`, msg.error?.code, msg.status));
  }

  private async send(method: string, params: Record<string, unknown>): Promise<unknown> {
    await this.open();
    const id = `cta${Date.now().toString(36)}${(this.seq++).toString(36)}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new UnknownStatus(`sem resposta da Binance em ${this.timeoutMs / 1000}s (${method})`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws!.send(JSON.stringify({ id, method, params }));
    });
  }

  /** Sincroniza o relógio com o da Binance (requisições assinadas exigem horário correto). */
  async syncTime() {
    const t0 = Date.now();
    const r = (await this.send("time", {})) as { serverTime: number };
    const t1 = Date.now();
    this.timeOffsetMs = r.serverTime - Math.round((t0 + t1) / 2);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async call(method: string, params: Record<string, string | number | boolean> = {}, signed = false): Promise<any> {
    if (!signed) return this.send(method, params);
    if (!this.apiKey || !this.secret) throw new ExchangeError("Chave da Testnet não configurada");
    if (this.timeOffsetMs === 0) await this.syncTime().catch(() => undefined);
    const p: Record<string, string | number | boolean> = { ...params, apiKey: this.apiKey, timestamp: Date.now() + this.timeOffsetMs, recvWindow: 5000 };
    p.signature = await hmacSha256Hex(this.secret, signaturePayload(p));
    try {
      return await this.send(method, p);
    } catch (e) {
      // relógio fora de sincronia (-1021): sincroniza e tenta uma vez
      if (e instanceof ExchangeError && e.code === -1021) {
        await this.syncTime();
        return this.call(method, params, true);
      }
      throw e;
    }
  }

  close() { this.ws?.close(); this.ws = null; }
}
