// Liga o motor às telas. Substitui o servidor: as telas pedem "/api/..." e este módulo
// responde direto do motor que roda no celular.
import * as ind from "./indicators.ts";
import { DEFAULT_CONFIG, TradingEngine } from "./engine.ts";
import { BinanceMarket, DataClient, mainnetData, TESTNET } from "./market.ts";
import type { MarketData } from "./market.ts";
import { BrowserKV, Repo } from "./repo.ts";
import { SignedWsApi } from "./signed.ts";
import { TestnetBroker } from "./testnet.ts";
import type { Mode } from "./types.ts";
import { ReplayMarket, replayCandle, syntheticFilters, syntheticSeries } from "./replay.ts";
import { feeRate, HARD_LIMITS, RiskSettingsError } from "./risk.ts";
import { TIMEFRAMES } from "./types.ts";
import type { TF } from "./types.ts";

export class LocalApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const AI_MODEL = "claude-sonnet-5-5";
const AI_MIN_INTERVAL = 10 * 60;
const AI_MAX_PER_DAY = 24;
const AI_SYSTEM = "Você é o analista estratégico do CLAUDE TRADER AI, um robô de day trade em Binance Spot (somente compra, sem " +
  "alavancagem). Responda em português do Brasil, de forma objetiva. Você recebe um relatório técnico gerado pelo robô. Tarefas: " +
  "interpretar o contexto de mercado, identificar mudanças de regime, avaliar o desempenho com honestidade estatística (amostras " +
  "pequenas não provam nada), explicar as decisões do robô e sugerir melhorias TESTÁVEIS. Você NÃO pode alterar configurações, " +
  "limites de risco, credenciais ou executar ordens; o proprietário decide. Nunca prometa lucro. Se os dados forem insuficientes, diga isso.";

export interface Runtime {
  engine: TradingEngine;
  market: MarketData;
  repo: Repo;
  demo: boolean;
  mode: Mode;
  stop(): void;
}

let current: Runtime | null = null;
const settingsKV = new BrowserKV("cta-config:");

export function savedMode(): Mode {
  const m = settingsKV.get("mode");
  return m === "TESTNET" ? "TESTNET" : "SIMULACAO";
}

export function testnetKeys(): { apiKey: string; secret: string } | null {
  const apiKey = settingsKV.get("testnet_api_key") ?? "";
  const secret = settingsKV.get("testnet_secret") ?? "";
  return apiKey && secret ? { apiKey, secret } : null;
}

/** Laço do robô: um ciclo por segundo, nunca dois ao mesmo tempo. */
function loop(engine: TradingEngine, tick: () => Promise<void>, everyMs: number): () => void {
  let busy = false;
  const id = window.setInterval(async () => {
    if (busy) return;
    busy = true;
    try { await tick(); } catch (e) { engine.lastError = String(e); engine.risk.recordError(engine.clock()); }
    finally { busy = false; }
  }, everyMs);
  return () => clearInterval(id);
}

/** Cria (uma única vez) o robô dentro do app. `demo` usa dados SINTÉTICOS acelerados, só para testar a tela. */
export function getRuntime(demo = false): Runtime {
  if (current) return current;
  if (demo) {
    const repo = new Repo(new BrowserKV("cta-demo:"));
    const n = 14_400;
    const series = {
      BTCUSDT: syntheticSeries(n, 97_000, 3), ETHUSDT: syntheticSeries(n, 3_400, 5), SOLUSDT: syntheticSeries(n, 180, 9),
    };
    const filters = {
      BTCUSDT: syntheticFilters("BTCUSDT", "BTC", "USDT"),
      ETHUSDT: syntheticFilters("ETHUSDT", "ETH", "USDT", "0.01", "0.0001", "0.0001"),
      SOLUSDT: syntheticFilters("SOLUSDT", "SOL", "USDT", "0.01", "0.001", "0.001"),
    };
    const m = new ReplayMarket(series, filters, "USDT", 5.4, 0.02, true);
    let i = 12_800;
    for (let k = 0; k < i; k++) m.pushClosed(k);
    m.setPrices(i - 1, "close", series.BTCUSDT[i - 1].closeTime / 1000);
    const engine = new TradingEngine({ ...DEFAULT_CONFIG, symbols: Object.keys(series), initialCapitalBrl: 100 }, repo, m,
      { clock: () => m.now });
    const stop = loop(engine, async () => { if (i < n) await replayCandle(m, engine, i++); }, 400);
    current = { engine, market: m, repo, demo, mode: "SIMULACAO", stop };
    return current;
  }
  const mode = savedMode();
  const keys = testnetKeys();
  if (mode === "TESTNET" && keys) {
    const repo = new Repo(new BrowserKV("cta-testnet:"));
    const symbols = repo.kvGet<string[]>("symbols", DEFAULT_CONFIG.symbols);
    const market = new BinanceMarket(symbols, DEFAULT_CONFIG.quoteAsset, DEFAULT_CONFIG.brlRateSymbol,
      { client: new DataClient(TESTNET), brlClient: mainnetData, dropMissing: true });
    const api = new SignedWsApi(TESTNET.wsApiUrl, keys.apiKey, keys.secret);
    const broker = new TestnetBroker(repo, api, 0.001);
    const engine = new TradingEngine({ ...DEFAULT_CONFIG, symbols }, repo, market, { broker });
    broker.updateCosts(feeRate(engine.riskSettings));
    market.start().then(() => {
      engine.cfg.symbols = [...market.symbols];
      if (market.removed.length) {
        const msg = `Pares fora da Testnet retirados da análise: ${market.removed.join(", ")}`;
        repo.log("AVISO", "mercado", msg, null, Date.now() / 1000);
        engine.brain.think(Date.now() / 1000, "info", msg);
      }
    });
    const stopLoop = loop(engine, () => engine.step(), 1000);
    current = { engine, market, repo, demo, mode, stop: () => { stopLoop(); market.stop(); api.close(); } };
    return current;
  }
  const repo = new Repo(new BrowserKV("cta:"));
  const symbols = repo.kvGet<string[]>("symbols", DEFAULT_CONFIG.symbols);
  const market = new BinanceMarket(symbols, DEFAULT_CONFIG.quoteAsset, DEFAULT_CONFIG.brlRateSymbol);
  const engine = new TradingEngine({ ...DEFAULT_CONFIG, symbols }, repo, market);
  market.start();
  const stopLoop = loop(engine, () => engine.step(), 1000);
  current = { engine, market, repo, demo, mode: "SIMULACAO", stop: () => { stopLoop(); market.stop(); } };
  return current;
}

/** Troca de modo: só sem posições abertas (nenhuma operação fica sem acompanhamento). */
function switchMode(rt: Runtime, mode: Mode) {
  if (rt.engine.positions.size) throw new LocalApiError(409, "Há posições abertas. Espere fechar (ou use Emergência) antes de trocar de modo.");
  rt.engine.pause(undefined, `Modo alterado para ${mode}`);
  rt.stop();
  settingsKV.set("mode", mode);
  current = null;
}

function candlesPayload(rt: Runtime, symbol: string, tf: TF, limit: number) {
  if (!rt.engine.cfg.symbols.includes(symbol)) throw new LocalApiError(404, "Ativo não monitorado");
  if (!TIMEFRAMES.includes(tf)) throw new LocalApiError(400, "Timeframe inválido");
  const series = rt.market.getCandles(symbol, tf);
  const closes = series.map((c) => c.close);
  const [mid, up, low] = ind.bollinger(closes, 20, 2);
  const [, , hist] = ind.macd(closes);
  const n = Math.max(20, Math.min(limit, 300));
  const tail = <T,>(a: T[]) => a.slice(-n);
  const pos = rt.engine.positions.get(symbol);
  return {
    symbol, tf, synthetic: rt.market.isSynthetic,
    candles: tail(series).map((c) => ({ t: c.openTime, o: c.open, h: c.high, l: c.low, c: c.close, v: c.volume, closed: c.closed })),
    overlays: {
      ema9: tail(ind.ema(closes, 9)), ema21: tail(ind.ema(closes, 21)), ema50: tail(ind.ema(closes, 50)),
      ema200: tail(ind.ema(closes, 200)), vwap: tail(ind.vwap(series)), bb_up: tail(up), bb_mid: tail(mid), bb_low: tail(low),
    },
    rsi: tail(ind.rsi(closes, 14)), macd_hist: tail(hist), position: pos ?? null,
  };
}

function aiReport(rt: Runtime): string {
  const s = rt.engine.snapshot();
  const latest = s.brain.latest as Record<string, Record<string, unknown>>;
  return JSON.stringify({
    modo: s.mode, estado: s.status, motivo_estado: s.status_reason, estrategia: s.strategy, dados_sinteticos: s.synthetic_data,
    conta: { equity: s.account.equity, equity_brl: s.account.equity_brl, free: s.account.free, exposure: s.account.exposure },
    hoje: s.today, total: s.totals, risco: s.risk, limites_risco: s.risk_settings, mercado: s.market,
    analises: Object.fromEntries(Object.entries(latest).map(([k, d]) => [k, { signal: d.signal, decision: d.decision, score: d.score,
      regime: d.regime, volatility: d.volatility, failed_gate: d.failed_gate, reasons: d.reasons, blockers: d.blockers, trends: d.trends }])),
    riscos_identificados: s.brain.risks,
    ultimas_decisoes: rt.repo.recentDecisions(30).map((d) => ({ ts: d.ts, symbol: d.symbol, action: d.action, accepted: d.accepted, score: d.score, summary: d.summary })),
    ultimas_operacoes: rt.repo.closedPositions({ limit: 20 }).map((t) => ({ symbol: t.symbol, entry_price: t.entry_price, exit_price: t.exit_price,
      exit_reason: t.exit_reason, pnl_quote: t.pnl_quote, pnl_pct: t.pnl_pct, r_multiple: t.r_multiple, score: t.score })),
  });
}

async function aiAnalyze(rt: Runtime, question: string) {
  const key = rt.repo.kvGet<string>("ai_key", "");
  if (!key) throw new LocalApiError(409, "IA desativada: cole sua chave da API do Claude em Ajustes para usar este recurso.");
  const now = Date.now() / 1000;
  const lastCall = rt.repo.kvGet<number>("ai_last_call", 0);
  if (now - lastCall < AI_MIN_INTERVAL) throw new LocalApiError(409, `Aguarde ${Math.floor((AI_MIN_INTERVAL - (now - lastCall)) / 60) + 1} min para nova análise (controle de custo).`);
  if (rt.repo.aiCallsSince(now - 86400) >= AI_MAX_PER_DAY) throw new LocalApiError(409, "Limite diário de análises da IA atingido (controle de custo).");
  rt.repo.kvSet("ai_last_call", now);
  const q = (question || "Analise o contexto atual e explique as decisões do robô.").slice(0, 500);
  let res: Response;
  try {
    res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json",
        "anthropic-dangerous-direct-browser-access": "true" },
      body: JSON.stringify({ model: AI_MODEL, max_tokens: 1500, system: AI_SYSTEM,
        messages: [{ role: "user", content: `Pergunta do proprietário: ${q}\n\nRelatório do robô (JSON):\n${aiReport(rt)}` }] }),
    });
  } catch (e) {
    throw new LocalApiError(409, `Falha de conexão com a API do Claude: ${e}`);
  }
  if (!res.ok) throw new LocalApiError(409, `API do Claude respondeu HTTP ${res.status}`);
  const data = await res.json();
  const text = (data.content ?? []).filter((p: { type: string }) => p.type === "text").map((p: { text: string }) => p.text).join("");
  rt.repo.insertAiReport(Date.now() / 1000, AI_MODEL, q, text); // a resposta é só exibida: nada é aplicado automaticamente
  return { response: text, model: AI_MODEL };
}

/** Atende as rotas que antes iam para o servidor. */
export async function localApi(path: string, method = "GET", body: Record<string, unknown> = {}): Promise<unknown> {
  const rt = getRuntime(isDemo());
  const e = rt.engine;
  const url = new URL(path, "http://local");
  const p = url.pathname;
  const q = (k: string, d = "") => url.searchParams.get(k) ?? d;
  const route = `${method} ${p}`;
  switch (route) {
    case "GET /api/dashboard":
      return { ...e.snapshot(), recent_trades: rt.repo.closedPositions({ limit: 10, mode: e.mode }),
        ai_enabled: !!rt.repo.kvGet<string>("ai_key", ""), release: { testnet: true, real: false }, demo: rt.demo };
    case "GET /api/candles": return candlesPayload(rt, q("symbol").toUpperCase(), q("tf", "5m") as TF, Number(q("limit", "120")));
    case "GET /api/trades": return rt.repo.allPositions(Number(q("limit", "50")), e.mode);
    case "GET /api/decisions": return rt.repo.recentDecisions(Number(q("limit", "50")), q("only_rejected") === "true");
    case "GET /api/logs": return rt.repo.recentEvents(Number(q("limit", "100")));
    case "GET /api/equity": return rt.repo.equitySeries(Date.now() / 1000 - Number(q("hours", "24")) * 3600);
    case "POST /api/bot/start":
      if (!e.accountReady()) throw new LocalApiError(409, "Conta simulada ainda não criada: aguardando cotação real USDT/BRL.");
      e.start();
      return { status: e.status };
    case "POST /api/bot/pause": e.pause(); return { status: e.status };
    case "POST /api/bot/emergency":
      if (String(body.confirm ?? "").trim().toUpperCase() !== "PARAR") throw new LocalApiError(400, "Confirme digitando PARAR");
      return await e.emergencyStop();
    case "GET /api/settings/risk": return { settings: e.riskSettings, limits: riskLimits() };
    case "PUT /api/settings/risk":
      try { return { settings: e.updateRiskSettings(body), limits: riskLimits() }; }
      catch (err) { throw new LocalApiError(400, err instanceof RiskSettingsError ? err.message : String(err)); }
    case "POST /api/paper/reset":
      if (String(body.confirm ?? "").trim().toUpperCase() !== "ZERAR") throw new LocalApiError(400, "Confirme digitando ZERAR");
      try { e.resetPaperAccount(Date.now() / 1000); } catch (err) { throw new LocalApiError(409, String(err instanceof Error ? err.message : err)); }
      return { ok: true };
    case "GET /api/mode":
      return {
        current: rt.mode, confirmation_phrase: "EU AUTORIZO OPERAR COM DINHEIRO REAL", testnet_keys: !!testnetKeys(),
        modes: [
          { mode: "SIMULACAO", available: true, label: "Simulação (paper trading)", detail: "Dados reais de mercado, dinheiro fictício, nada é enviado à corretora." },
          { mode: "TESTNET", available: !!testnetKeys(), label: "Testnet Binance",
            detail: testnetKeys() ? "Ordens de verdade no ambiente de TESTES da Binance (dinheiro fictício). Stop registrado na corretora."
              : "Cadastre a chave da Testnet abaixo para liberar." },
          { mode: "REAL", available: false, label: "Real (dinheiro verdadeiro)", detail: "Bloqueado. Exige a ETAPA 10 e sua autorização explícita." },
        ],
      };
    case "POST /api/mode": {
      const target = String(body.mode ?? "").toUpperCase();
      if (rt.demo) throw new LocalApiError(409, "No modo demonstração não é possível trocar de modo.");
      if (target === "REAL") throw new LocalApiError(403, "Modo REAL bloqueado. Exige a ETAPA 10 e sua autorização explícita.");
      if (target === rt.mode) return { current: rt.mode };
      if (target === "TESTNET") {
        if (!testnetKeys()) throw new LocalApiError(409, "Cadastre e teste a chave da Testnet primeiro.");
        if (String(body.confirm ?? "").trim().toUpperCase() !== "TESTNET") throw new LocalApiError(400, "Confirme digitando TESTNET");
        switchMode(rt, "TESTNET");
      } else if (target === "SIMULACAO") switchMode(rt, "SIMULACAO");
      else throw new LocalApiError(400, "Modo inválido");
      getRuntime(false);
      return { current: savedMode() };
    }
    case "GET /api/testnet/keys": {
      const k = testnetKeys();
      return { configured: !!k, api_key: k ? `${k.apiKey.slice(0, 6)}…${k.apiKey.slice(-4)}` : null };
    }
    case "PUT /api/testnet/keys": {
      const apiKey = String(body.api_key ?? "").trim();
      const secret = String(body.secret ?? "").trim();
      if (!apiKey && !secret) {
        if (rt.mode === "TESTNET") throw new LocalApiError(409, "Volte para a Simulação antes de remover a chave.");
        settingsKV.remove("testnet_api_key"); settingsKV.remove("testnet_secret");
        return { configured: false };
      }
      if (!/^[A-Za-z0-9]{20,128}$/.test(apiKey) || !/^[A-Za-z0-9]{20,128}$/.test(secret))
        throw new LocalApiError(400, "Chave ou segredo em formato inválido (copie exatamente o que a Testnet mostrou).");
      settingsKV.set("testnet_api_key", apiKey);
      settingsKV.set("testnet_secret", secret);
      return { configured: true };
    }
    case "POST /api/testnet/test": {
      const k = testnetKeys();
      if (!k) throw new LocalApiError(409, "Cadastre a chave da Testnet primeiro.");
      const api = new SignedWsApi(TESTNET.wsApiUrl, k.apiKey, k.secret);
      try {
        const acc = await api.call("account.status", { omitZeroBalances: true }, true);
        const bal = (acc.balances ?? []) as { asset: string; free: string }[];
        const usdt = Number(bal.find((b) => b.asset === "USDT")?.free ?? 0);
        return { ok: true, can_trade: acc.canTrade !== false, usdt_free: usdt,
          balances: bal.slice(0, 8).map((b) => ({ asset: b.asset, free: Number(b.free) })) };
      } catch (err) {
        throw new LocalApiError(400, `Falha ao conectar na Testnet: ${err instanceof Error ? err.message : err}`);
      } finally {
        api.close();
      }
    }
    case "GET /api/ai/reports": return { enabled: !!rt.repo.kvGet<string>("ai_key", ""), model: AI_MODEL, reports: rt.repo.recentAiReports(10) };
    case "PUT /api/ai/key": {
      const key = String(body.key ?? "").trim();
      if (key && !key.startsWith("sk-ant-")) throw new LocalApiError(400, "Chave inválida (deve começar com sk-ant-)");
      rt.repo.kvSet("ai_key", key);
      return { enabled: !!key };
    }
    case "POST /api/ai/analyze": return aiAnalyze(rt, String(body.question ?? ""));
  }
  if (method === "GET" && p.startsWith("/api/analysis/")) {
    const a = e.lastAnalysis.get(p.split("/").pop()!.toUpperCase());
    if (!a) throw new LocalApiError(404, "Ainda não há análise para este ativo");
    return a;
  }
  throw new LocalApiError(404, `Rota desconhecida: ${route}`);
}

function riskLimits() {
  return Object.fromEntries(Object.entries(HARD_LIMITS).map(([k, [min, max]]) => [k, { min, max }]));
}

export function isDemo(): boolean {
  try { return new URLSearchParams(window.location.search).get("demo") === "1"; } catch { return false; }
}
