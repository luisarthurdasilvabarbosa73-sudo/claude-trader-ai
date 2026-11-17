import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { api, ApiError, getToken, setToken } from "./api";
import type { Dashboard, Thought } from "./types";
import { Brain } from "./components/Brain";
import { ChartView } from "./components/ChartView";
import { History } from "./components/History";
import { Login } from "./components/Login";
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
        reg.showNotification(`CLAUDE TRADER AI · ${title}`, { body: t.text.slice(0, 180), icon: "/icons/icon-192.png", tag: `${t.ts}` });
      }
    }).catch(() => undefined);
  }, [thoughts, permission]);

  const enable = useCallback(async () => {
    if (!supported) return;
    setPermission(await Notification.requestPermission());
  }, [supported]);

  return { permission, enable };
}

export function App() {
  const [logged, setLogged] = useState<boolean>(!!getToken());
  const [tab, setTab] = useState<Tab>("painel");
  const [d, setD] = useState<Dashboard | null>(null);
  const [offline, setOffline] = useState(false);
  const [toast, setToast] = useState<{ msg: string; err: boolean } | null>(null);

  const showToast = useCallback((msg: string, err = false) => {
    setToast({ msg, err });
    window.setTimeout(() => setToast(null), 3500);
  }, []);

  const refresh = useCallback(async () => {
    try {
      setD(await api<Dashboard>("/api/dashboard"));
      setOffline(false);
    } catch (e) {
      if (e instanceof ApiError && e.status === 0) setOffline(true);
    }
  }, []);

  useEffect(() => {
    const out = () => { setLogged(false); setD(null); };
    window.addEventListener("cta-logout", out);
    return () => window.removeEventListener("cta-logout", out);
  }, []);

  useEffect(() => {
    if (!logged) return;
    refresh();
    const id = window.setInterval(() => { if (document.visibilityState === "visible") refresh(); }, 3000);
    const onVis = () => { if (document.visibilityState === "visible") refresh(); };
    document.addEventListener("visibilitychange", onVis);
    return () => { window.clearInterval(id); document.removeEventListener("visibilitychange", onVis); };
  }, [logged, refresh]);

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

  if (!logged) return <Login onLogged={() => setLogged(true)} />;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark" />
          <div>
            <div className="brand-name">CLAUDE TRADER AI</div>
            <div className="brand-sub">BINANCE SPOT · DAY TRADE</div>
          </div>
        </div>
        <div className="top-right">
          {d && <StatusPill status={d.status} />}
          {d && <span className="pill mode">{d.mode === "SIMULACAO" ? "Simulação" : d.mode}</span>}
        </div>
      </header>

      {d?.synthetic_data && (
        <div className="banner danger">⚠ DADOS SINTÉTICOS DE TESTE. Nada nesta tela é mercado real. Este modo é proibido em produção.</div>
      )}
      {offline && <div className="banner warn">Sem conexão com o servidor. Tentando novamente…</div>}
      {d?.health.fatal_error && <div className="banner danger">{d.health.fatal_error}</div>}
      {d && d.status_reason && d.status !== "RODANDO" && <div className="banner info">{d.status_reason}</div>}

      <main style={{ marginTop: 12 }}>
        {!d ? <div className="empty">Conectando ao robô…</div> : (
          <>
            {tab === "painel" && <Panel d={d} onAction={action} />}
            {tab === "cerebro" && <Brain d={d} />}
            {tab === "grafico" && <ChartView d={d} />}
            {tab === "historico" && <History />}
            {tab === "ajustes" && <Settings d={d} notify={notify} onToast={showToast}
              onLogout={() => { setToken(null); setLogged(false); setD(null); }} />}
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
