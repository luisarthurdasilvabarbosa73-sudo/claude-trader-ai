import { useState } from "react";
import type { Dashboard } from "../types";
import { num, price, time, trendIcon } from "../format";
import { Card, Empty, ScoreBar, SectionTitle } from "./ui";

const KIND_LABEL: Record<string, string> = {
  aceita: "OPORTUNIDADE ACEITA", rejeitada: "OPORTUNIDADE REJEITADA", sem_operacao: "SEM OPERAÇÃO",
  saida: "SAÍDA", risco: "RISCO", alerta: "ALERTA", info: "INFO",
};

export function Brain({ d }: { d: Dashboard }) {
  const [sym, setSym] = useState(d.symbols[0]);
  const [filter, setFilter] = useState<"todos" | "decisoes" | "riscos">("todos");
  const a = d.brain.latest[sym];
  const thoughts = d.brain.thoughts.filter((t) =>
    filter === "todos" ? true : filter === "decisoes" ? ["aceita", "rejeitada", "saida"].includes(t.kind)
      : ["risco", "alerta"].includes(t.kind));

  return (
    <>
      <Card className="hero" title="Cérebro do robô">
        <div style={{ fontSize: 15, fontWeight: 600 }}>{d.brain.activity}</div>
        <div className="spacer" />
        <dl className="kv">
          <dt>Estratégia ativa</dt><dd>{d.strategy}</dd>
          <dt>Ativos monitorados</dt><dd>{d.symbols.join(", ")}</dd>
          <dt>Timeframes</dt><dd>1m · 5m · 15m · 1h</dd>
          <dt>Fonte de dados</dt><dd>{d.synthetic_data ? "SINTÉTICA (teste)" : "Binance (tempo real)"}</dd>
        </dl>
      </Card>

      <SectionTitle>Riscos identificados</SectionTitle>
      <Card>
        {d.brain.risks.length === 0 ? <Empty>Nenhum risco relevante identificado agora.</Empty> :
          d.brain.risks.map((r) => <div key={r} className="row"><span className="warn small">⚠ {r}</span></div>)}
      </Card>

      <SectionTitle>Análise por ativo</SectionTitle>
      <div className="chips">
        {d.symbols.map((s) => <button key={s} className={`chip ${s === sym ? "on" : ""}`} onClick={() => setSym(s)}>{s}</button>)}
      </div>
      <div className="spacer" />
      {!a ? <Card><Empty>Aguardando o primeiro candle fechado para analisar {sym}.</Empty></Card> : (
        <>
          <Card title={`O que está sendo analisado · ${time(a.ts)}`} right={<span className={`pill ${a.signal === "COMPRAR" ? "run" : "stop"}`}>{a.decision}</span>}>
            <div className="flex between"><span className="muted small">Pontuação de confirmação</span>
              <span className="mono">{num(a.score, 0)} / 100 (mín. {num(a.min_score, 0)})</span></div>
            <div className="spacer" style={{ height: 6 }} />
            <ScoreBar score={a.score} min={a.min_score} />
            <div className="spacer" />
            <dl className="kv">
              <dt>Regime (1h)</dt><dd>{a.regime}</dd>
              <dt>Tendência</dt><dd>{["1m", "5m", "15m", "1h"].map((tf) => `${tf} ${trendIcon(a.trends[tf])}`).join("  ")}</dd>
              <dt>Volatilidade</dt><dd>{a.volatility}</dd>
              <dt>Spread</dt><dd>{a.spread_pct === null ? "—" : `${num(a.spread_pct, 4)}%`}</dd>
              {a.entry !== null && <><dt>Entrada / stop / alvo</dt><dd>{price(a.entry)} / {price(a.stop)} / {price(a.take_profit)}</dd></>}
              {a.rr_net !== null && <><dt>Risco/retorno líquido</dt><dd>{num(a.rr_net)}</dd></>}
              {a.resistance !== null && <><dt>Resistência</dt><dd>{price(a.resistance)}</dd></>}
              {a.support !== null && <><dt>Suporte</dt><dd>{price(a.support)}</dd></>}
            </dl>
          </Card>

          <Card title={a.signal === "COMPRAR" ? "Por que a oportunidade surgiu" : "Por que o robô decidiu não operar"}>
            {a.reasons.map((r) => <div key={r} className="small" style={{ padding: "4px 0" }}>{r}</div>)}
            {a.blockers.length > 0 && <>
              <div className="spacer" />
              <div className="card-title">Bloqueios do gestor de risco</div>
              {a.blockers.map((b) => <div key={b} className="small warn" style={{ padding: "4px 0" }}>⛔ {b}</div>)}
            </>}
            {a.sizing && <div className="small muted" style={{ paddingTop: 6 }}>Capital: {a.sizing}</div>}
          </Card>

          <Card title="Filtros obrigatórios">
            {a.gates.map((g) => (
              <div key={g.label} className={`gate ${g.passed ? "ok" : "no"}`}>
                <span className="ic">{g.passed ? "✓" : "✗"}</span>
                <div><div>{g.label}</div><div className="gate-detail">{g.detail}</div></div>
              </div>
            ))}
          </Card>

          {a.components.length > 0 && (
            <Card title="Confirmações (pontuação)">
              {a.components.map((c) => (
                <div className="comp" key={c.label}>
                  <div className="comp-head"><span>{c.label}</span><span className="mono">{num(c.points, 0)}/{num(c.max, 0)}</span></div>
                  <ScoreBar score={(c.points / c.max) * 100} />
                  <div className="gate-detail" style={{ marginTop: 3 }}>{c.detail}</div>
                </div>
              ))}
            </Card>
          )}
        </>
      )}

      <SectionTitle>Linha de raciocínio</SectionTitle>
      <div className="chips">
        {(["todos", "decisoes", "riscos"] as const).map((f) => (
          <button key={f} className={`chip ${filter === f ? "on" : ""}`} onClick={() => setFilter(f)}>
            {f === "todos" ? "Tudo" : f === "decisoes" ? "Aceitas/rejeitadas" : "Riscos"}
          </button>
        ))}
      </div>
      <div className="spacer" />
      <Card>
        {thoughts.length === 0 ? <Empty>Nada por aqui ainda.</Empty> : thoughts.slice(0, 30).map((t, i) => (
          <div key={`${t.ts}-${i}`} className={`thought ${t.kind}`}>
            <div className="thought-meta">{time(t.ts)} · {KIND_LABEL[t.kind] ?? t.kind}{t.symbol ? ` · ${t.symbol}` : ""}</div>
            <div>{t.text}</div>
          </div>
        ))}
      </Card>
    </>
  );
}
