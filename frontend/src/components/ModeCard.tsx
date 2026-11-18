import { useEffect, useState } from "react";
import { api } from "../api";
import type { ModeInfo } from "../types";
import { num } from "../format";
import { Card, ConfirmDialog } from "./ui";

interface TestResult { ok: boolean; can_trade: boolean; usdt_free: number; balances: { asset: string; free: number }[] }

export function ModeCard({ current, onToast, onChanged }: {
  current: string; onToast: (m: string, err?: boolean) => void; onChanged: () => void;
}) {
  const [info, setInfo] = useState<ModeInfo | null>(null);
  const [keys, setKeys] = useState<{ configured: boolean; api_key: string | null } | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [secret, setSecret] = useState("");
  const [test, setTest] = useState<TestResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<null | "TESTNET" | "SIMULACAO">(null);

  const load = async () => {
    setInfo(await api<ModeInfo>("/api/mode"));
    setKeys(await api<{ configured: boolean; api_key: string | null }>("/api/testnet/keys"));
  };
  useEffect(() => { load().catch(() => undefined); }, [current]);

  async function saveKeys(remove = false) {
    try {
      await api("/api/testnet/keys", { method: "PUT", body: remove ? {} : { api_key: apiKey, secret } });
      setApiKey(""); setSecret(""); setTest(null);
      await load();
      onToast(remove ? "Chave removida deste aparelho" : "Chave salva só neste aparelho");
    } catch (e) { onToast(e instanceof Error ? e.message : "Erro", true); }
  }

  async function testConn() {
    setBusy(true);
    try { setTest(await api<TestResult>("/api/testnet/test", { method: "POST" })); onToast("Conexão com a Testnet OK"); }
    catch (e) { setTest(null); onToast(e instanceof Error ? e.message : "Erro", true); }
    finally { setBusy(false); }
  }

  async function switchTo(mode: string, typed = "") {
    setBusy(true);
    try {
      await api("/api/mode", { method: "POST", body: { mode, confirm: typed } });
      onToast(mode === "TESTNET" ? "Modo TESTNET ativado" : "Modo SIMULAÇÃO ativado");
      onChanged();
    } catch (e) { onToast(e instanceof Error ? e.message : "Erro", true); }
    finally { setBusy(false); }
  }

  return (
    <Card>
      {(info?.modes ?? []).map((m) => (
        <div className="row" key={m.mode}>
          <div className="row-main">
            <div className="row-title">{m.label}</div>
            <div className="row-sub">{m.detail}</div>
          </div>
          {m.mode === current ? <span className="pill mode">Ativo</span>
            : m.mode === "REAL" ? <span className="pill lock">🔒 Bloqueado</span>
              : <button className="btn sm" disabled={!m.available || busy}
                onClick={() => setConfirm(m.mode as "TESTNET" | "SIMULACAO")}>Ativar</button>}
        </div>
      ))}

      <div className="spacer" />
      <div className="card-title">Chave da Testnet (dinheiro fictício)</div>
      {keys?.configured ? (
        <>
          <p className="small muted">Chave cadastrada: <span className="mono">{keys.api_key}</span> — guardada só neste aparelho.</p>
          <div className="controls">
            <button className="btn" disabled={busy} onClick={testConn}>{busy ? "Testando…" : "Testar conexão"}</button>
            <button className="btn ghost" disabled={busy || current === "TESTNET"} onClick={() => saveKeys(true)}>Remover chave</button>
          </div>
          {test && (
            <div className="banner info">
              {test.can_trade ? "✓ Conectado e com permissão de negociar." : "✗ Conectado, mas a chave NÃO pode negociar."}
              {" "}USDT de teste livres: <b className="mono">{num(test.usdt_free, 2)}</b>
            </div>
          )}
        </>
      ) : (
        <>
          <p className="small muted">
            Gere em <span className="mono">testnet.binance.vision</span> (entrar com GitHub → gerar chave HMAC). Use SOMENTE chave da
            Testnet: este app não tem nenhum endereço de negociação da conta real.
          </p>
          <div className="field">
            <label htmlFor="tk">API Key</label>
            <input id="tk" className="input" autoComplete="off" value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="ts">Secret Key</label>
            <input id="ts" className="input" type="password" autoComplete="off" value={secret} onChange={(e) => setSecret(e.target.value)} />
          </div>
          <button className="btn primary block" disabled={!apiKey || !secret} onClick={() => saveKeys()}>Salvar chave</button>
        </>
      )}
      <p className="dim small">O modo REAL continua bloqueado e só pode ser liberado com sua autorização explícita (ETAPA 10).</p>

      {confirm === "TESTNET" && (
        <ConfirmDialog title="Ativar a Testnet?" word="TESTNET" confirmLabel="Ativar Testnet"
          message="O robô vai enviar ORDENS DE VERDADE ao ambiente de testes da Binance (dinheiro fictício), usando só R$30 do saldo de teste. O histórico da simulação fica guardado separado."
          onClose={() => setConfirm(null)} onConfirm={(typed) => { setConfirm(null); switchTo("TESTNET", typed); }} />
      )}
      {confirm === "SIMULACAO" && (
        <ConfirmDialog title="Voltar para a Simulação?" confirmLabel="Voltar"
          message="O robô para de enviar ordens à Testnet. O histórico da Testnet fica guardado separado."
          onClose={() => setConfirm(null)} onConfirm={() => { setConfirm(null); switchTo("SIMULACAO"); }} />
      )}
    </Card>
  );
}
