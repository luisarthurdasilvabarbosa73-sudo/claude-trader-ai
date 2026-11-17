import { useEffect, useState } from "react";
import { api } from "../api";
import type { Decision, LogEvent, Position } from "../types";
import { dateTime, EXIT_LABEL, num, pct, price, signed, tone } from "../format";
import { Card, Empty } from "./ui";

type Tab = "operacoes" | "decisoes" | "eventos";

export function History() {
  const [tab, setTab] = useState<Tab>("operacoes");
  const [trades, setTrades] = useState<Position[]>([]);
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [events, setEvents] = useState<LogEvent[]>([]);
  const [onlyRejected, setOnlyRejected] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        if (tab === "operacoes") { const r = await api<Position[]>("/api/trades?limit=100"); if (alive) setTrades(r); }
        if (tab === "decisoes") {
          const r = await api<Decision[]>(`/api/decisions?limit=80&only_rejected=${onlyRejected}`);
          if (alive) setDecisions(r);
        }
        if (tab === "eventos") { const r = await api<LogEvent[]>("/api/logs?limit=120"); if (alive) setEvents(r); }
      } catch { /* mantém a última lista */ }
    };
    load();
    const id = window.setInterval(load, 8000);
    return () => { alive = false; window.clearInterval(id); };
  }, [tab, onlyRejected]);

  return (
    <>
      <div className="chips">
        <button className={`chip ${tab === "operacoes" ? "on" : ""}`} onClick={() => setTab("operacoes")}>Operações</button>
        <button className={`chip ${tab === "decisoes" ? "on" : ""}`} onClick={() => setTab("decisoes")}>Decisões</button>
        <button className={`chip ${tab === "eventos" ? "on" : ""}`} onClick={() => setTab("eventos")}>Eventos</button>
      </div>
      <div className="spacer" />

      {tab === "operacoes" && (
        <Card title="Histórico de operações">
          {trades.length === 0 ? <Empty>Nenhuma operação ainda. O robô não inventa operações: elas só aparecem quando acontecem.</Empty> :
            trades.map((t) => (
              <div className="row" key={t.id}>
                <div className="row-main">
                  <div className="row-title">{t.symbol} <span className={`pill ${t.status === "ABERTA" ? "run" : "stop"}`}>{t.status}</span></div>
                  <div className="row-sub mono">{dateTime(t.entry_time)} · {price(t.entry_price)} → {t.exit_price ? price(t.exit_price) : "…"}</div>
                  <div className="row-sub">{t.exit_reason ? EXIT_LABEL[t.exit_reason] ?? t.exit_reason : `stop ${price(t.stop_price)} · alvo ${price(t.take_profit)}`} · pontuação {num(t.score, 0)}</div>
                </div>
                <div className="right">
                  <div className={`mono ${tone(t.pnl_quote)}`}>{t.pnl_quote ? signed(t.pnl_quote) : "—"}</div>
                  <div className="row-sub mono">{t.pnl_pct !== null ? pct(t.pnl_pct, 2, true) : ""} {t.r_multiple !== null ? `${num(t.r_multiple)}R` : ""}</div>
                  <div className="row-sub mono">taxa {num(t.fees_quote, 4)}</div>
                </div>
              </div>
            ))}
        </Card>
      )}

      {tab === "decisoes" && (
        <Card title="Decisões registradas" right={
          <button className={`chip ${onlyRejected ? "on" : ""}`} onClick={() => setOnlyRejected(!onlyRejected)}>só rejeitadas</button>
        }>
          {decisions.length === 0 ? <Empty>Sem decisões ainda.</Empty> : decisions.map((x) => (
            <div className="row" key={x.id}>
              <div className="row-main">
                <div className="row-title">{x.symbol} <span className={x.accepted ? "pos" : x.action === "COMPRAR" ? "warn" : "dim"}>{x.details.decision ?? x.action}</span></div>
                <div className="row-sub">{x.summary.replace(/^[^:]+: /, "")}</div>
                {x.details.blockers && x.details.blockers.length > 0 && <div className="row-sub warn">⛔ {x.details.blockers[0]}</div>}
              </div>
              <div className="right"><div className="mono">{num(x.score, 0)}</div><div className="row-sub mono">{dateTime(x.ts)}</div></div>
            </div>
          ))}
        </Card>
      )}

      {tab === "eventos" && (
        <Card title="Eventos do sistema">
          {events.length === 0 ? <Empty>Sem eventos.</Empty> : events.map((e) => (
            <div className="row" key={e.id}>
              <div className="row-main">
                <div className={`small ${e.level === "CRITICO" ? "neg" : e.level === "AVISO" ? "warn" : ""}`}>{e.message}</div>
                <div className="row-sub mono">{dateTime(e.ts)} · {e.category} · {e.level}</div>
              </div>
            </div>
          ))}
        </Card>
      )}
    </>
  );
}
