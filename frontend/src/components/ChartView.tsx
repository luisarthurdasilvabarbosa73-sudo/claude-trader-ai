import { useEffect, useState } from "react";
import { api } from "../api";
import type { CandlesResponse, Dashboard } from "../types";
import { num, priceShort, trendIcon } from "../format";
import { CandleChart } from "./CandleChart";
import { Card, Empty, SectionTitle } from "./ui";

type TFData = Record<string, number | string | null | string[]>;
const TFS = ["1m", "5m", "15m", "1h"];

const ROWS: { key: string; label: string; fmt: (v: unknown) => string }[] = [
  { key: "trend", label: "Tendência", fmt: (v) => `${trendIcon(v as string)} ${String(v ?? "").toLowerCase()}` },
  { key: "rsi", label: "RSI", fmt: (v) => num(v, 1) },
  { key: "macd_hist", label: "MACD hist", fmt: (v) => num(v, Math.abs(Number(v)) >= 100 ? 1 : Math.abs(Number(v)) >= 1 ? 3 : 5) },
  { key: "ema9", label: "EMA 9", fmt: priceShort },
  { key: "ema21", label: "EMA 21", fmt: priceShort },
  { key: "ema50", label: "EMA 50", fmt: priceShort },
  { key: "ema200", label: "EMA 200", fmt: priceShort },
  { key: "vwap", label: "VWAP", fmt: priceShort },
  { key: "pb", label: "Bollinger %B", fmt: (v) => num(v, 2) },
  { key: "atr_pct", label: "ATR %", fmt: (v) => num(v, 3) },
  { key: "rvol", label: "Volume rel.", fmt: (v) => (v === null || v === undefined ? "—" : `${num(v, 2)}x`) },
];

export function ChartView({ d }: { d: Dashboard }) {
  const [sym, setSym] = useState(d.symbols[0]);
  const [tf, setTf] = useState("5m");
  const [data, setData] = useState<CandlesResponse | null>(null);
  const [tfs, setTfs] = useState<Record<string, TFData> | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const c = await api<CandlesResponse>(`/api/candles?symbol=${sym}&tf=${tf}&limit=90`);
        if (alive) { setData(c); setError(""); }
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : "Erro");
      }
      try {
        const a = await api<{ timeframes: Record<string, TFData> }>(`/api/analysis/${sym}`);
        if (alive) setTfs(a.timeframes);
      } catch {
        if (alive) setTfs(null);
      }
    };
    load();
    const id = window.setInterval(load, 10_000);
    return () => { alive = false; window.clearInterval(id); };
  }, [sym, tf]);

  return (
    <>
      <div className="chips">
        {d.symbols.map((s) => <button key={s} className={`chip ${s === sym ? "on" : ""}`} onClick={() => setSym(s)}>{s}</button>)}
      </div>
      <div className="spacer" />
      <Card title={`${sym} · ${tf}`} right={
        <div className="chips">{TFS.map((t) => <button key={t} className={`chip ${t === tf ? "on" : ""}`} onClick={() => setTf(t)}>{t}</button>)}</div>
      }>
        {error ? <Empty>{error}</Empty> : data ? <CandleChart data={data} /> : <Empty>Carregando…</Empty>}
        {data?.synthetic && <div className="banner danger">Gráfico com dados SINTÉTICOS de teste — não é o mercado real.</div>}
      </Card>

      <SectionTitle>Indicadores técnicos</SectionTitle>
      <Card>
        {!tfs || Object.keys(tfs).length === 0 ? <Empty>Indicadores aparecem após histórico suficiente (EMA200 do 1h exige ~9 dias de candles).</Empty> : (
          <div style={{ overflowX: "auto" }}>
            <table className="mono small" style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <th style={{ textAlign: "left" }} className="muted">{sym}</th>
                  {TFS.map((t) => <th key={t} className="muted" style={{ textAlign: "right", padding: "4px 2px" }}>{t}</th>)}
                </tr>
              </thead>
              <tbody>
                {ROWS.map((r) => (
                  <tr key={r.key} style={{ borderTop: "1px solid var(--line)" }}>
                    <td style={{ padding: "6px 2px" }} className="muted">{r.label}</td>
                    {TFS.map((t) => {
                      const v = tfs[t]?.[r.key];
                      const cls = r.key === "trend" ? (v === "ALTA" ? "pos" : v === "BAIXA" ? "neg" : "") : "";
                      return <td key={t} className={cls} style={{ textAlign: "right", padding: "6px 2px" }}>{r.fmt(v)}</td>;
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
