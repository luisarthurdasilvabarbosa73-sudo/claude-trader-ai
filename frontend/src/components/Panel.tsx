import { useState } from "react";
import type { Dashboard } from "../types";
import { brl, num, pct, price, signed, tone, toNum, duration } from "../format";
import { Card, ConfirmDialog, ScoreBar, SectionTitle, Stat, StatusPill } from "./ui";

export function toBrl(d: Dashboard, quoteValue: unknown): number | null {
  const v = toNum(quoteValue);
  if (v === null) return null;
  if (d.account.quote_asset === "BRL") return v;
  return d.account.brl_rate ? v * d.account.brl_rate : null;
}

export function Panel({ d, onAction }: {
  d: Dashboard; onAction: (path: string, body?: unknown) => Promise<void>;
}) {
  const [confirm, setConfirm] = useState<null | "emergency">(null);
  const q = d.account.quote_asset;
  const t = d.today;
  const running = d.status === "RODANDO" || d.status === "PAUSADO";
  const lossUsed = d.risk.daily_limit_pct ? Math.max(0, d.risk.daily_loss_pct) / d.risk.daily_limit_pct * 100 : 0;

  return (
    <>
      <div className="banner info">
        O robô roda dentro deste app: ele analisa e opera enquanto o app estiver aberto na tela
        (a tela fica ligada automaticamente). Fechou o app, ele para — o histórico fica salvo no celular.
      </div>
      {!d.account.initialized && (
        <div className="banner warn">Conta simulada aguardando a cotação real USDT/BRL para converter R$30. Nenhum valor é inventado.</div>
      )}

      <Card className="hero" title="Saldo total" right={<span className="pill mode">{d.mode === "SIMULACAO" ? "Simulação" : d.mode}</span>}>
        <div className="hero-value">{brl(d.account.equity_brl)}</div>
        <div className="hero-sub">{num(d.account.equity, 4)} {q}{d.account.brl_rate ? ` · USDT/BRL ${num(d.account.brl_rate, 3)}` : ""}</div>
        <div className="hero-row">
          <div>
            <div className="hero-label">Saldo disponível</div>
            <div className="mono" style={{ fontSize: 17, fontWeight: 650 }}>{brl(d.account.available_brl)}</div>
            <div className="hero-sub">{num(d.account.available, 4)} {q}</div>
          </div>
          <div>
            <div className="hero-label">Em ativos</div>
            <div className="mono" style={{ fontSize: 17, fontWeight: 650 }}>{brl(toBrl(d, d.account.exposure))}</div>
            <div className="hero-sub">{num(d.account.exposure, 4)} {q}{d.positions.length === 0 && Number(d.account.exposure) > 0 ? " · poeira" : ""}</div>
          </div>
        </div>
      </Card>

      <SectionTitle>Controle do robô</SectionTitle>
      <div className="controls">
        <button className="btn go" disabled={d.status === "RODANDO" || !d.account.initialized}
          onClick={() => onAction("/api/bot/start")}>▶ Iniciar</button>
        <button className="btn" disabled={!running} onClick={() => onAction("/api/bot/pause")}>❚❚ Pausar</button>
        <button className="btn danger" onClick={() => setConfirm("emergency")}>■ Emergência — parar tudo</button>
      </div>
      <p className="dim small" style={{ margin: "8px 2px 0" }}>
        Pausar impede novas entradas; os stops das posições abertas continuam ativos.
      </p>

      <SectionTitle>Hoje</SectionTitle>
      <div className="grid">
        <Stat label="Lucro do dia" toneClass="pos" value={brl(toBrl(d, t.gross_profit))} hint={`${signed(t.gross_profit)} ${q}`} />
        <Stat label="Prejuízo do dia" toneClass={t.gross_loss < 0 ? "neg" : "neu"} value={brl(toBrl(d, t.gross_loss))} hint={`${signed(t.gross_loss)} ${q}`} />
        <Stat label="Taxas pagas" value={brl(toBrl(d, t.fees_paid ?? 0))} hint={`total ${num(d.totals.fees, 4)} ${q}`} />
        <Stat label="Total de operações" value={d.totals.trades} hint={`${t.trades} hoje`} />
        <Stat label="Vencedoras" toneClass="pos" value={d.totals.wins} hint={`${t.wins} hoje`} />
        <Stat label="Perdedoras" toneClass={d.totals.losses ? "neg" : "neu"} value={d.totals.losses} hint={`${t.losses} hoje`} />
        <Stat label="Taxa de acerto" value={d.totals.win_rate === null ? "—" : pct(d.totals.win_rate, 1)}
          hint={d.totals.trades < 30 ? "amostra pequena" : `PF ${num(d.totals.profit_factor)}`} />
        <Stat label="Estado do robô" value={<StatusPill status={d.status} />} hint={`app aberto há ${duration(d.uptime_s)}`} />
        <Stat label="Modo de operação" value={<span className="accent" style={{ fontSize: 15 }}>{d.mode === "SIMULACAO" ? "SIMULAÇÃO" : d.mode}</span>} hint="sem dinheiro real" />
      </div>

      <SectionTitle>Proteção de capital</SectionTitle>
      <Card>
        <div className="flex between small"><span className="muted">Perda do dia vs. limite</span>
          <span className="mono">{pct(Math.max(0, d.risk.daily_loss_pct))} / {pct(d.risk.daily_limit_pct, 1)}</span></div>
        <div className="spacer" />
        <div className="bar neg"><span style={{ width: `${Math.min(100, lossUsed)}%` }} /></div>
        <div className="spacer" />
        <dl className="kv">
          <dt>Risco por operação</dt><dd>{pct(d.risk_settings.risk_per_trade_pct, 1)}</dd>
          <dt>Operações simultâneas</dt><dd>{d.positions.length} / {d.risk_settings.max_open_positions}</dd>
          <dt>Perdas seguidas</dt><dd>{d.risk.consecutive_losses} / {d.risk_settings.max_consecutive_losses}</dd>
        </dl>
        {(d.risk.daily_locked || d.risk.paused) && (
          <div className="banner warn">{d.risk.daily_lock_reason || d.risk.pause_reason}</div>
        )}
        {Object.entries(d.risk.blocked_symbols).map(([s, r]) => <div key={s} className="banner warn">{r}</div>)}
      </Card>

      <SectionTitle>Posições abertas</SectionTitle>
      <Card>
        {d.positions.length === 0 ? <div className="empty">Nenhuma posição aberta. O robô só entra com múltiplas confirmações.</div> :
          d.positions.map((p) => (
            <div className="row" key={p.id}>
              <div className="row-main">
                <div className="row-title">{p.symbol}</div>
                <div className="row-sub mono">entrada {price(p.entry_price)} · stop {price(p.stop_price)} · alvo {price(p.take_profit)}</div>
                <div className="row-sub">{p.breakeven_done ? "stop no break-even ✓" : `risco planejado ${num(p.risk_quote, 4)} ${q}`}</div>
              </div>
              <div className="right">
                <div className={`mono ${tone(p.unrealized_pnl)}`}>{signed(p.unrealized_pnl)}</div>
                <div className="row-sub mono">{price(p.current_bid)}</div>
              </div>
            </div>
          ))}
      </Card>

      <SectionTitle>Mercado monitorado</SectionTitle>
      <Card>
        {d.symbols.map((s) => {
          const m = d.market[s];
          const a = d.brain.latest[s];
          return (
            <div className="row" key={s}>
              <div className="row-main" style={{ flex: 1 }}>
                <div className="flex between">
                  <span className="row-title">{s}</span>
                  <span className={`mono small ${tone(m?.change_24h_pct)}`}>{pct(m?.change_24h_pct, 2, true)}</span>
                </div>
                <div className="flex between row-sub">
                  <span className="mono">{price(m?.last)}</span>
                  <span>{a ? `${a.regime === "ALTA" ? "▲" : a.regime === "BAIXA" ? "▼" : "◆"} regime ${a.regime.toLowerCase()} · vol. ${a.volatility.toLowerCase()}` : "aguardando análise"}</span>
                </div>
                <div className="spacer" style={{ height: 6 }} />
                <ScoreBar score={a?.score ?? 0} min={a?.min_score} />
                <div className="row-sub mono" style={{ marginTop: 4 }}>pontuação {num(a?.score ?? 0, 0)}/100 · {a?.decision ?? "—"}</div>
              </div>
            </div>
          );
        })}
      </Card>

      {confirm === "emergency" && (
        <ConfirmDialog title="Parar tudo agora?" danger word="PARAR" confirmLabel="Acionar emergência"
          message="Todas as posições serão vendidas a mercado e o robô ficará travado até você iniciá-lo de novo."
          onClose={() => setConfirm(null)}
          onConfirm={async (typed) => { setConfirm(null); await onAction("/api/bot/emergency", { confirm: typed }); }} />
      )}
    </>
  );
}
