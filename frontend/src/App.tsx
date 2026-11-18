import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { api } from "./api";
import type { Dashboard, Thought } from "./types";
import { Brain } from "./components/Brain";
import { ChartView } from "./components/ChartView";
import { History } from "./components/History";
import { Panel } from "./components/Panel";
import { Settings } from "./components/Settings";
import { Icons, StatusPill } from "./components/ui";

type Tab = "painel" | "cerebro" | "grafico" | "historico" | "ajustes";
const TABS: { id: Tab; label: string; icon: ReactNode }[] = [
  { id: "painel", label: "Painel", icon: Icons.panel },
  { id: "cerebro", label: "Cérebro", icon: Icons.brain },
  { id: "grafico", label: "Gráfico", icon: Icons.chart },
  { id: "historico", label: "Histórico", icon: Icons.list },
  { id: "ajustes", label: "Ajustes", icon: Icons.gear },
];

function useNotifications(thoughts: Thought[] | undefined) {
  const supported = typeof window !== "undefined" && "Notification" in window;
  const [permission, setPermission] = useState<string>(supported ? Notification.permission : "unsupported");
  const lastSeen = useRef<number | null>(null);

  useEffect(() => {
    if (!thoughts || thoughts.length === 0) return;
    const newest = thoughts[0].ts;
    if (lastSeen.current === null) { lastSeen.current = newest; return; }
    const fresh = thoughts.filter((t) => t.ts > (lastSeen.current ?? 0) && ["aceita", "saida", "risco", "alerta"].includes(t.kind));
    lastSeen.current = Math.max(lastSeen.current, newest);
    if (permission !== "granted" || fresh.length === 0) return;
    navigator.serviceWorker?.ready.then((reg) => {
      for (const t of fresh.slice(0, 3)) {
        const title = t.kind === "aceita" ? "Compra (simulada)" : t.kind === "saida" ? "Operação encerrada" : "Alerta de risco";
        reg.showNotification(`CLAUDE TRADER AI · ${title}`, { body: t.text.slice(0, 180), icon: "./icons/icon-192.png", tag: `${t.ts}` });
      }
    }).catch(() => undefined);
  }, [thoughts, permission]);

  const enable = useCallback(async () => {
    if (!supported) return;
    setPermission(await Notification.requestPermission());
  }, [supported]);

  return { permission, enable };
}

/** Mantém a tela ligada enquanto o robô opera (o robô só funciona com o app aberto). */
function useWakeLock(active: boolean) {
  useEffect(() => {
    if (!active || !("wakeLock" in navigator)) return;
    let lock: WakeLockSentinel | null = null;
    let cancelled = false;
    const acquire = async () => {
      try {
        if (document.visibilityState === "visible") lock = await navigator.wakeLock.request("screen");
        if (cancelled) lock?.release();
      } catch { /* sem permissão: segue sem trava de tela */ }
    };
    acquire();
    const onVis = () => { if (document.visibilityState === "visible") acquire(); };
    document.addEventListener("visibilitychange", onVis);
    return () => { cancelled = true; document.removeEventListener("visibilitychange", onVis); lock?.release().catch(() => undefined); };
  }, [active]);
}

export function App() {
  const [tab, setTab] = useState<Tab>("painel");
  const [d, setD] = useState<Dashboard | null>(null);
  const [error, setError] = useState("");
  const [toast, setToast] = useState<{ msg: string; err: boolean } | null>(null);

  const showToast = useCallback((msg: string, err = false) => {
    setToast({ msg, err });
    window.setTimeout(() => setToast(null), 3500);
  }, []);

  const refresh = useCallback(async () => {
    try {
      setD(await api<Dashboard>("/api/dashboard"));
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    refresh();
    const id = window.setInterval(() => { if (document.visibilityState === "visible") refresh(); }, 2000);
    const onVis = () => { if (document.visibilityState === "visible") refresh(); };
    document.addEventListener("visibilitychange", onVis);
    return () => { window.clearInterval(id); document.removeEventListener("visibilitychange", onVis); };
  }, [refresh]);

  useWakeLock(d?.status === "RODANDO" || d?.status === "PAUSADO");

  const notify = useNotifications(d?.brain.thoughts);

  const action = useCallback(async (path: string, body?: unknown) => {
    try {
      await api(path, { method: "POST", body: body ?? {} });
      showToast("Comando executado");
      await refresh();
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Erro", true);
    }
  }, [refresh, showToast]);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark" />
          <div>
            <div className="brand-name">CLAUDE TRADER AI</div>
            <div className="brand-sub">BINANCE SPOT · NO SEU CELULAR</div>
          </div>
        </div>
        <div className="top-right">
          {d && <StatusPill status={d.status} />}
          {d && <span className="pill mode">{d.mode === "SIMULACAO" ? "Simulação" : d.mode}</span>}
        </div>
      </header>

      {d?.synthetic_data && (
        <div className="banner danger">⚠ MODO DEMONSTRAÇÃO com dados SINTÉTICOS. Nada nesta tela é mercado real. Para usar o mercado real, abra o app sem "?demo=1".</div>
      )}
      {error && <div className="banner warn">{error}</div>}
      {d?.health.fatal_error && <div className="banner danger">{d.health.fatal_error}</div>}
      {d && d.status_reason && d.status !== "RODANDO" && <div className="banner info">{d.status_reason}</div>}

      <main style={{ marginTop: 12 }}>
        {!d ? <div className="empty">Ligando o robô e conectando à Binance…</div> : (
          <>
            {tab === "painel" && <Panel d={d} onAction={action} />}
            {tab === "cerebro" && <Brain d={d} />}
            {tab === "grafico" && <ChartView d={d} />}
            {tab === "historico" && <History symbols={d.symbols} />}
            {tab === "ajustes" && <Settings d={d} notify={notify} onToast={showToast} />}
          </>
        )}
      </main>

      <nav className="nav">
        <div className="nav-inner">
          {TABS.map((t) => (
            <button key={t.id} className={tab === t.id ? "on" : ""} onClick={() => setTab(t.id)} aria-label={t.label}>
              {t.icon}
              <span>{t.label}</span>
            </button>
          ))}
        </div>
      </nav>

      {toast && <div className={`toast ${toast.err ? "err" : ""}`}>{toast.msg}</div>}
    </div>
  );
}
