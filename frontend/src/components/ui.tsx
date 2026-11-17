import { useState, type ReactNode } from "react";

export function Card({ title, right, children, className = "" }: {
  title?: ReactNode; right?: ReactNode; children: ReactNode; className?: string;
}) {
  return (
    <section className={`card ${className}`}>
      {(title || right) && (
        <div className="card-head">
          <div className="card-title">{title}</div>
          {right}
        </div>
      )}
      {children}
    </section>
  );
}

export function Stat({ label, value, hint, toneClass = "neu" }: {
  label: string; value: ReactNode; hint?: ReactNode; toneClass?: string;
}) {
  return (
    <div className="card stat">
      <div className="stat-label">{label}</div>
      <div className={`stat-value ${toneClass}`}>{value}</div>
      {hint && <div className="stat-hint">{hint}</div>}
    </div>
  );
}

const STATUS_CLASS: Record<string, string> = { RODANDO: "run", PAUSADO: "pause", PARADO: "stop", EMERGENCIA: "emerg" };
const STATUS_LABEL: Record<string, string> = { RODANDO: "Rodando", PAUSADO: "Pausado", PARADO: "Parado", EMERGENCIA: "Emergência" };

export function StatusPill({ status }: { status: string }) {
  return (
    <span className={`pill ${STATUS_CLASS[status] ?? "stop"}`}>
      <span className="dot" />
      {STATUS_LABEL[status] ?? status}
    </span>
  );
}

export function ScoreBar({ score, min }: { score: number | null; min?: number }) {
  const s = Math.max(0, Math.min(100, score ?? 0));
  return (
    <div className="bar" aria-label={`pontuação ${s}`}>
      <span style={{ width: `${s}%` }} />
      {min !== undefined && <i className="mark" style={{ left: `${min}%` }} />}
    </div>
  );
}

export function SectionTitle({ children }: { children: ReactNode }) {
  return <div className="section-title">{children}</div>;
}

export function ConfirmDialog({ title, message, word, confirmLabel, danger, onConfirm, onClose }: {
  title: string; message: string; word?: string; confirmLabel: string; danger?: boolean;
  onConfirm: (typed: string) => void; onClose: () => void;
}) {
  const [typed, setTyped] = useState("");
  const ok = !word || typed.trim().toUpperCase() === word;
  return (
    <div className="modal-bg" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>{title}</h3>
        <p>{message}</p>
        {word && (
          <div className="field">
            <label>Digite <b className="mono">{word}</b> para confirmar</label>
            <input className="input" value={typed} autoFocus onChange={(e) => setTyped(e.target.value)} />
          </div>
        )}
        <div className="modal-actions">
          <button className="btn ghost" onClick={onClose}>Cancelar</button>
          <button className={`btn ${danger ? "danger" : "primary"}`} disabled={!ok} onClick={() => onConfirm(typed)}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export const Icons = {
  panel: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="3" y="3" width="7" height="9" rx="2" /><rect x="14" y="3" width="7" height="5" rx="2" /><rect x="14" y="12" width="7" height="9" rx="2" /><rect x="3" y="16" width="7" height="5" rx="2" /></svg>
  ),
  brain: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="12" cy="12" r="3" /><path d="M12 2v4M12 18v4M2 12h4M18 12h4M4.9 4.9l2.8 2.8M16.3 16.3l2.8 2.8M4.9 19.1l2.8-2.8M16.3 7.7l2.8-2.8" /></svg>
  ),
  chart: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M6 4v16M6 8h-2v6h4V8zM12 3v18M10 7h4v8h-4zM18 6v12M16 10h4v4h-4z" /></svg>
  ),
  list: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M8 6h13M8 12h13M8 18h13" /><circle cx="3.5" cy="6" r="1" /><circle cx="3.5" cy="12" r="1" /><circle cx="3.5" cy="18" r="1" /></svg>
  ),
  gear: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0" /><circle cx="16" cy="6" r="2" /><circle cx="10" cy="12" r="2" /><circle cx="18" cy="18" r="2" /></svg>
  ),
};
