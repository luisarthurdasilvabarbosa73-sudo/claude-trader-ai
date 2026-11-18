import { Fragment, useEffect, useRef, useState } from "react";
import { Cancelled, runBacktest } from "../core/backtest.ts";
import type { BacktestResult, Progress } from "../core/backtest.ts";
import { getRuntime, isDemo } from "../core/runtime.ts";
import { brl, dateTime, EXIT_LABEL, num, pct, signed, tone } from "../format";
import { Card, Empty, SectionTitle, Stat } from "./ui";

const DAYS = [3, 7, 14, 30];
const CAPITALS = [30, 60, 100];

function Sparkline({ points }: { points: [number, number][] }) {
  if (points.length < 2) return null;
  const vals = points.map((p) => p[1]);
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const W = 340, H = 70;
  const d = points.map((p, i) => `${i ? "L" : "M"}${((i / (points.length - 1)) * W).toFixed(1)},${(H - ((p[1] - lo) / (hi - lo || 1)) * H).toFixed(1)}`).join("");
  const up = vals[vals.length - 1] >= vals[0];
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto" }} aria-label="curva de patrimônio">
      <path d={d} fill="none" stroke={up ? "#2fe39e" : "#ff4f6d"} strokeWidth="1.6" />
    </svg>
  );
}

export function BacktestPanel({ symbols }: { symbols: string[] }) {
  const repo = getRuntime(isDemo()).repo;
  const preferred = ["SOLUSDT", "XRPUSDT", "ADAUSDT"].filter((s) => symbols.includes(s));
  const [sel, setSel] = useState<string[]>(preferred.length ? preferred : symbols.slice(0, 2));
  const [days, setDays] = useState(7);
  const [capital, setCapital] = useState(30);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [error, setError] = useState("");
  const [res, setRes] = useState<BacktestResult | null>(() => repo.kvGet<BacktestResult | null>("last_backtest", null));
  const cancelRef = useRef(false);

  useEffect(() => () => { cancelRef.current = true; }, []);

  const toggle = (s: string) => setSel(sel.includes(s) ? sel.filter((x) => x !== s) : [...sel, s]);

  async function run() {
    setRunning(true);
    setError("");
    cancelRef.current = false;
    try {
      const r = await runBacktest({ symbols: sel, days, capitalBrl: capital }, setProgress, () => cancelRef.current);
      setRes(r);
      repo.kvSet("last_backtest", r);
    } catch (e) {
      setError(e instanceof Cancelled ? "Backtest cancelado." : e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
      setProgress(null);
    }
  }

  const m = res?.metrics;
  const toBrl = (v: number | null | undefined) => (v === null || v === undefined || !res ? null : v * res.brl_rate);

  return (
    <>
      <Card title="Backtest com dados reais da Binance">
        <p className="small muted" style={{ marginTop: 0 }}>
          Baixa o histórico real de 1 minuto e roda o MESMO robô sobre o passado, com taxas, spread e as regras de risco.
          Mantenha o app aberto enquanto roda.
        </p>
        <div className="card-title">Ativos</div>
        <div className="chips" style={{ flexWrap: "wrap", margin: "8px 0 12px" }}>
          {symbols.map((s) => <button key={s} className={`chip ${sel.includes(s) ? "on" : ""}`} disabled={running} onClick={() => toggle(s)}>{s}</button>)}
        </div>
        <div className="card-title">Período</div>
        <div className="chips" style={{ margin: "8px 0 12px" }}>
          {DAYS.map((d) => <button key={d} className={`chip ${days === d ? "on" : ""}`} disabled={running} onClick={() => setDays(d)}>{d} dias</button>)}
        </div>
        <div className="card-title">Capital inicial</div>
        <div className="chips" style={{ margin: "8px 0 14px" }}>
          {CAPITALS.map((c) => <button key={c} className={`chip ${capital === c ? "on" : ""}`} disabled={running} onClick={() => setCapital(c)}>R$ {c}</button>)}
        </div>
        {!running ? (
          <button className="btn primary block" disabled={!sel.length} onClick={run}>Rodar backtest</button>
        ) : (
          <>
            <div className="small mono" style={{ marginBottom: 6 }}>{progress?.text ?? "Preparando…"}</div>
            <div className="bar"><span style={{ width: `${progress ? Math.min(100, (progress.done / Math.max(progress.total, 1)) * 100) : 2}%` }} /></div>
            <div className="spacer" />
            <button className="btn block" onClick={() => { cancelRef.current = true; }}>Cancelar</button>
          </>
        )}
        {days >= 30 && !running && <p className="dim tiny">30 dias baixa ~60 mil minutos por ativo: pode levar alguns minutos.</p>}
        {error && <div className="banner danger">{error}</div>}
      </Card>

      {!res || !m ? <Card><Empty>Nenhum backtest ainda. Escolha os ativos e toque em "Rodar backtest".</Empty></Card> : (
        <>
          <SectionTitle>Resultado</SectionTitle>
          <div className={`banner ${res.significance.evidence ? "info" : "warn"}`}>{res.significance.verdict}</div>
          {m.trades === 0 && res.rejected_capital > 0 && (
            <div className="banner info">
              A estratégia encontrou {res.signals} oportunidades, mas {res.rejected_capital} foram recusadas por capital insuficiente:
              com R$ {res.capital_brl}, a ordem mínima da Binance (e a sobra de lote) ultrapassa os limites de risco.
              Rode de novo com um capital maior só para ver como a estratégia se comportaria.
            </div>
          )}
          <p className="dim small" style={{ margin: "8px 2px" }}>
            {res.symbols.join(", ")} · {dateTime(res.period.start)} a {dateTime(res.period.end)} · capital R$ {res.capital_brl} · USDT/BRL {num(res.brl_rate, 3)}
          </p>
          <Card>
            <Sparkline points={res.equity_curve} />
          </Card>
          <div className="spacer" />
          <div className="grid">
            <Stat label="Resultado" toneClass={tone(m.net_pnl)} value={brl(toBrl(m.net_pnl))} hint={`${signed(m.net_pnl)} USDT · ${pct(m.return_pct, 2, true)}`} />
            <Stat label="Operações" value={m.trades} hint={`${num(m.trades_per_day ?? 0, 1)} por dia`} />
            <Stat label="Taxa de acerto" value={m.win_rate === null ? "—" : pct(m.win_rate, 1)} hint={`${m.wins} vencedoras / ${m.losses} perdedoras`} />
            <Stat label="Taxas pagas" value={brl(toBrl(m.fees))} hint={`${num(m.fees, 4)} USDT`} />
            <Stat label="Queda máxima" toneClass={m.max_drawdown_pct > 0 ? "neg" : "neu"} value={pct(m.max_drawdown_pct, 2)} hint="do pico ao fundo" />
            <Stat label="Média por operação" value={m.avg_r === null ? "—" : `${num(m.avg_r)}R`} hint={`fator de lucro ${num(m.profit_factor)}`} />
          </div>
          <SectionTitle>Por que operou (ou não)</SectionTitle>
          <Card>
            <dl className="kv">
              <dt>Sinais de compra da estratégia</dt><dd>{res.signals}</dd>
              <dt>Recusados por capital insuficiente</dt><dd>{res.rejected_capital}</dd>
              <dt>Bloqueados pelo gestor de risco</dt><dd>{res.rejected_risk}</dd>
              <dt>Posições abertas no fim</dt><dd>{m.open_positions_at_end}</dd>
              {Object.entries(res.exit_reasons).map(([k, v]) => <Fragment key={k}><dt>Saída: {EXIT_LABEL[k] ?? k}</dt><dd>{v}</dd></Fragment>)}
            </dl>
          </Card>
          {res.trades.length > 0 && (
            <Card title="Operações (mais recentes)">
              {res.trades.slice(-20).reverse().map((t, i) => (
                <div className="row" key={i}>
                  <div className="row-main">
                    <div className="row-title">{t.symbol}</div>
                    <div className="row-sub mono">{dateTime(t.entry_time)} · {EXIT_LABEL[t.exit_reason ?? ""] ?? t.exit_reason}</div>
                  </div>
                  <div className="right">
                    <div className={`mono ${tone(t.pnl_quote)}`}>{signed(t.pnl_quote)}</div>
                    <div className="row-sub mono">{t.r_multiple === null ? "" : `${num(t.r_multiple)}R`}</div>
                  </div>
                </div>
              ))}
            </Card>
          )}
          <Card title="Premissas">
            {Object.entries(res.assumptions).map(([k, v]) => <div key={k} className="small muted" style={{ padding: "3px 0" }}>{k.replace(/_/g, " ")}: {String(v)}</div>)}
            <p className="dim tiny">Desempenho passado não garante resultado futuro.</p>
          </Card>
        </>
      )}
    </>
  );
}
