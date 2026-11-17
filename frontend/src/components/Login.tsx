import { useState, type FormEvent } from "react";
import { api, setToken } from "../api";

export function Login({ onLogged }: { onLogged: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const r = await api<{ token: string }>("/api/auth/login", { method: "POST", body: { password } });
      setToken(r.token);
      onLogged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha no login");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login">
      <form className="card hero" onSubmit={submit}>
        <div className="brand-mark" />
        <h1>CLAUDE TRADER AI</h1>
        <p className="muted small">Robô autônomo de day trade · Binance Spot</p>
        <div className="spacer" />
        <div className="field">
          <label htmlFor="pw">Senha do proprietário</label>
          <input id="pw" className="input" type="password" autoComplete="current-password" value={password}
            onChange={(e) => setPassword(e.target.value)} />
        </div>
        {error && <div className="banner danger">{error}</div>}
        <div className="spacer" />
        <button className="btn primary block" disabled={busy || !password}>{busy ? "Entrando…" : "Entrar"}</button>
        <p className="dim tiny" style={{ marginTop: 14 }}>
          Acesso protegido. Suas chaves da Binance nunca chegam a este aplicativo.
        </p>
      </form>
    </div>
  );
}
