import { useEffect, useState } from "react";
import { api } from "../api";
import type { AiReports, Dashboard, ModeInfo, RiskResponse } from "../types";
import { dateTime } from "../format";
import { Card, ConfirmDialog, Empty, SectionTitle } from "./ui";

const FIELDS: { key: string; label: string; unit: string; help: string }[] = [
  { key: "risk_per_trade_pct", label: "Risco máximo por operação", unit: "%", help: "Perda máxima planejada no stop, já com taxas." },
  { key: "max_daily_loss_pct", label: "Limite de perda diária", unit: "%", help: "Atingiu: novas entradas bloqueadas até amanhã." },
  { key: "max_open_positions", label: "Operações simultâneas", unit: "", help: "Com R$30, apenas 1 é viável." },
  { key: "max_total_exposure_pct", label: "Exposição total máxima", unit: "%", help: "Parte do patrimônio que pode ficar em ativos." },
  { key: "min_score", label: "Pontuação mínima", unit: "", help: "Confirmações necessárias (0–100)." },
  { key: "min_reward_risk", label: "Risco/retorno líquido mínimo", unit: "x", help: "Após taxas e slippage." },
  { key: "max_spread_pct", label: "Spread máximo", unit: "%", help: "Acima disso o ativo é ignorado." },
  { key: "max_consecutive_losses", label: "Perdas seguidas até pausar", unit: "", help: "Sem tentativa de recuperar prejuízo." },
  { key: "max_trade_minutes", label: "Duração máxima da operação", unit: "min", help: "Day trade: sai por tempo." },
  { key: "fee_rate_pct", label: "Taxa da corretora (simulação)", unit: "%", help: "Padrão Binance Spot: 0,1%." },
  { key: "slippage_pct", label: "Slippage simulado", unit: "%", help: "Além do spread real." },
];

export function Settings({ d, notify, onLogout, onToast }: {
  d: Dashboard; notify: { permission: string; enable: () => void }; onLogout: () => void; onToast: (m: string, err?: boolean) => void;
}) {
  const [risk, setRisk] = useState<RiskResponse | null>(null);
  const [form, setForm] = useState<Record<string, string>>({});
  const [modes, setModes] = useState<ModeInfo | null>(null);
  const [ai, setAi] = useState<AiReports | null>(null);
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);

  useEffect(() => {
    api<RiskResponse>("/api/settings/risk").then((r) => {
      setRisk(r);
      setForm(Object.fromEntries(Object.entries(r.settings).map(([k, v]) => [k, String(v)])));
    }).catch(() => undefined);
    api<ModeInfo>("/api/mode").then(setModes).catch(() => undefined);
    api<AiReports>("/api/ai/reports").then(setAi).catch(() => undefined);
  }, []);

  async function saveRisk() {
    if (!risk) return;
    const changed: Record<string, number> = {};
    for (const f of FIELDS) {
      const v = Number(String(form[f.key]).replace(",", "."));
      if (Number.isFinite(v) && v !== risk.settings[f.key]) changed[f.key] = v;
    }
    if (Object.keys(changed).length === 0) { onToast("Nada alterado"); return; }
    try {
      const r = await api<RiskResponse>("/api/settings/risk", { method: "PUT", body: changed });
      setRisk(r);
      onToast("Configurações de risco salvas");
    } catch (e) {
      onToast(e instanceof Error ? e.message : "Erro ao salvar", true);
    }
  }

  async function askAi() {
    setBusy(true);
    try {
      await api("/api/ai/analyze", { method: "POST", body: { question } });
      setAi(await api<AiReports>("/api/ai/reports"));
      setQuestion("");
    } catch (e) {
      onToast(e instanceof Error ? e.message : "Erro", true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <SectionTitle>Modo de operação</SectionTitle>
      <Card>
        {(modes?.modes ?? []).map((m) => (
          <div className="row" key={m.mode}>
            <div className="row-main">
              <div className="row-title">{m.label}</div>
              <div className="row-sub">{m.detail}</div>
            </div>
            {m.mode === d.mode ? <span className="pill mode">Ativo</span>
              : <span className="pill lock">{m.available ? "Disponível" : "🔒 Bloqueado"}</span>}
          </div>
        ))}
        <p className="dim small">O modo REAL só pode ser liberado com sua autorização explícita em uma etapa futura.</p>
      </Card>

      <SectionTitle>Gestão de risco</SectionTitle>
      <Card>
        {!risk ? <Empty>Carregando…</Empty> : FIELDS.map((f) => {
          const lim = risk.limits[f.key];
          return (
            <div className="field" key={f.key}>
              <label htmlFor={f.key}><span>{f.label}{f.unit ? ` (${f.unit})` : ""}</span>
                <span className="mono dim">{lim ? `${lim.min} – ${lim.max}` : ""}</span></label>
              <input id={f.key} className="input" inputMode="decimal" value={form[f.key] ?? ""}
                onChange={(e) => setForm({ ...form, [f.key]: e.target.value })} />
              <span className="dim tiny">{f.help}</span>
            </div>
          );
        })}
        <button className="btn primary block" onClick={saveRisk}>Salvar configurações</button>
        <p className="dim small">Os limites mínimo/máximo são travas do sistema: nem o app nem a IA conseguem ultrapassá-los.</p>
      </Card>

      <SectionTitle>Notificações</SectionTitle>
      <Card>
        <div className="flex between">
          <span className="small">{notify.permission === "granted" ? "Ativadas neste aparelho" : notify.permission === "denied" ? "Bloqueadas no navegador" : "Desativadas"}</span>
          <button className="btn sm" disabled={notify.permission === "granted" || notify.permission === "unsupported"} onClick={notify.enable}>Ativar</button>
        </div>
        <p className="dim small">Avisos de compra, venda e alertas de risco enquanto o app estiver aberto ou em segundo plano recente.</p>
      </Card>

      <SectionTitle>Análise estratégica (Claude)</SectionTitle>
      <Card>
        {!ai?.enabled ? (
          <p className="small muted">Desativado. Para ativar, cadastre a variável <span className="mono">ANTHROPIC_API_KEY</span> no servidor. O robô opera normalmente sem a IA.</p>
        ) : (
          <>
            <textarea className="input" placeholder="Ex.: O mercado mudou de regime? Por que o robô não operou hoje?" value={question}
              onChange={(e) => setQuestion(e.target.value)} maxLength={500} />
            <div className="spacer" />
            <button className="btn primary block" disabled={busy} onClick={askAi}>{busy ? "Analisando…" : "Pedir análise"}</button>
            <p className="dim tiny">A IA apenas analisa e sugere. Ela não altera limites, credenciais nem executa ordens.</p>
          </>
        )}
        {(ai?.reports ?? []).map((r) => (
          <div className="row" key={r.id} style={{ display: "block" }}>
            <div className="row-sub mono">{dateTime(r.ts)} · {r.model}</div>
            <div className="small accent" style={{ margin: "4px 0" }}>{r.question}</div>
            <pre className="ai">{r.response}</pre>
          </div>
        ))}
      </Card>

      <SectionTitle>Conta simulada</SectionTitle>
      <Card>
        <p className="small muted">{d.account.initial?.conversion ?? "Aguardando criação."}</p>
        <button className="btn block" onClick={() => setResetOpen(true)}>Zerar simulação (volta a R$30)</button>
      </Card>

      <div className="spacer" />
      <button className="btn ghost block" onClick={onLogout}>Sair</button>

      {resetOpen && (
        <ConfirmDialog title="Zerar a conta simulada?" word="ZERAR" confirmLabel="Zerar"
          message="O histórico permanece registrado. A conta volta a R$30 na cotação real atual. Feche posições antes."
          onClose={() => setResetOpen(false)}
          onConfirm={async (typed) => {
            setResetOpen(false);
            try { await api("/api/paper/reset", { method: "POST", body: { confirm: typed } }); onToast("Simulação zerada"); }
            catch (e) { onToast(e instanceof Error ? e.message : "Erro", true); }
          }} />
      )}
    </>
  );
}
