const brlFmt = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });

export function toNum(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

export function brl(v: unknown): string {
  const n = toNum(v);
  return n === null ? "—" : brlFmt.format(n);
}

export function num(v: unknown, digits = 2): string {
  const n = toNum(v);
  if (n === null) return "—";
  return n.toLocaleString("pt-BR", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function price(v: unknown): string {
  const n = toNum(v);
  if (n === null) return "—";
  const digits = n >= 1000 ? 2 : n >= 1 ? 4 : 6;
  return num(n, digits);
}

/** Preço compacto para eixos e tabelas estreitas. */
export function priceShort(v: unknown): string {
  const n = toNum(v);
  if (n === null) return "—";
  const digits = n >= 10000 ? 0 : n >= 100 ? 2 : n >= 1 ? 3 : 5;
  return num(n, digits);
}

export function trendIcon(t: string | null | undefined): string {
  return t === "ALTA" ? "▲" : t === "BAIXA" ? "▼" : t ? "◆" : "—";
}

export function signed(v: unknown, digits = 4): string {
  const n = toNum(v);
  if (n === null) return "—";
  return (n > 0 ? "+" : "") + num(n, digits);
}

export function pct(v: unknown, digits = 2, withSign = false): string {
  const n = toNum(v);
  if (n === null) return "—";
  return (withSign && n > 0 ? "+" : "") + num(n, digits) + "%";
}

export function time(ts: number | null | undefined): string {
  if (!ts) return "—";
  return new Date(ts * 1000).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function dateTime(ts: number | null | undefined): string {
  if (!ts) return "—";
  return new Date(ts * 1000).toLocaleString("pt-BR", {
    day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
  });
}

export function duration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h > 0 ? `${h}h ${m}min` : `${m}min`;
}

export function tone(v: unknown): "pos" | "neg" | "neu" {
  const n = toNum(v);
  if (n === null || n === 0) return "neu";
  return n > 0 ? "pos" : "neg";
}

export const EXIT_LABEL: Record<string, string> = {
  TAKE_PROFIT: "Alvo atingido",
  STOP_LOSS: "Stop loss",
  STOP_MOVEL: "Stop móvel",
  BREAK_EVEN: "Break-even",
  TEMPO_MAXIMO: "Tempo máximo",
  TENDENCIA_INVALIDADA: "Tendência invalidada",
  EMERGENCIA: "Emergência",
};
