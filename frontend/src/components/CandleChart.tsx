import type { CandlesResponse } from "../types";
import { priceShort } from "../format";

const W = 360;
const PAD_R = 50;
const MAIN_H = 200;
const RSI_H = 54;
const MACD_H = 46;
const GAP = 12;

const OVERLAY_STYLE: Record<string, { color: string; width: number; dash?: string; label: string }> = {
  ema9: { color: "#ffd166", width: 1, label: "EMA9" },
  ema21: { color: "#3ee6ff", width: 1.2, label: "EMA21" },
  ema50: { color: "#8b6dff", width: 1.2, label: "EMA50" },
  ema200: { color: "#ff7ab6", width: 1.2, label: "EMA200" },
  vwap: { color: "#e7eef8", width: 1, dash: "3 3", label: "VWAP" },
  bb_up: { color: "#56647b", width: 0.8, dash: "2 3", label: "Bollinger" },
  bb_low: { color: "#56647b", width: 0.8, dash: "2 3", label: "" },
};

function path(values: (number | null)[], x: (i: number) => number, y: (v: number) => number): string {
  let d = "";
  let pen = false;
  values.forEach((v, i) => {
    if (v === null || v === undefined) { pen = false; return; }
    d += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
    pen = true;
  });
  return d;
}

export function CandleChart({ data }: { data: CandlesResponse }) {
  const cs = data.candles;
  if (cs.length < 2) return <div className="empty">Sem candles suficientes.</div>;
  const n = cs.length;
  const step = (W - PAD_R) / n;
  const x = (i: number) => i * step + step / 2;
  const ranged = ["ema9", "ema21", "ema50", "vwap", "bb_up", "bb_low"];
  let lo = Math.min(...cs.map((c) => c.l));
  let hi = Math.max(...cs.map((c) => c.h));
  for (const k of ranged) for (const v of data.overlays[k] ?? []) if (v !== null) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  const pos = data.position;
  if (pos) for (const v of [pos.stop_price, pos.take_profit]) { const nv = Number(v); lo = Math.min(lo, nv); hi = Math.max(hi, nv); }
  const pad = (hi - lo) * 0.06 || hi * 0.001;
  lo -= pad; hi += pad;
  const y = (v: number) => MAIN_H - ((v - lo) / (hi - lo)) * MAIN_H;
  const maxVol = Math.max(...cs.map((c) => c.v)) || 1;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => lo + (hi - lo) * f);
  const last = cs[n - 1];

  const rsiTop = MAIN_H + GAP;
  const yr = (v: number) => rsiTop + RSI_H - (v / 100) * RSI_H;
  const macdTop = rsiTop + RSI_H + GAP;
  const hist = data.macd_hist.map((v) => v ?? 0);
  const hmax = Math.max(...hist.map(Math.abs)) || 1;
  const ym = (v: number) => macdTop + MACD_H / 2 - (v / hmax) * (MACD_H / 2);
  const totalH = macdTop + MACD_H + 4;

  return (
    <div className="chart-wrap">
      <svg viewBox={`0 0 ${W} ${totalH}`} role="img" aria-label={`Gráfico ${data.symbol} ${data.tf}`}>
        <defs><clipPath id="main"><rect x="0" y="0" width={W - PAD_R} height={MAIN_H} /></clipPath></defs>
        {ticks.map((t) => (
          <g key={t}>
            <line x1="0" x2={W - PAD_R} y1={y(t)} y2={y(t)} stroke="#182132" strokeWidth="0.6" />
            <text x={W - PAD_R + 4} y={y(t) + 3} fill="#56647b" fontSize="7.5" fontFamily="monospace">{priceShort(t)}</text>
          </g>
        ))}
        <g clipPath="url(#main)">
          {cs.map((c, i) => (
            <rect key={`v${c.t}`} x={x(i) - step * 0.35} width={step * 0.7} y={MAIN_H - (c.v / maxVol) * MAIN_H * 0.18}
              height={(c.v / maxVol) * MAIN_H * 0.18} fill={c.c >= c.o ? "rgba(47,227,158,0.16)" : "rgba(255,79,109,0.16)"} />
          ))}
          {Object.entries(OVERLAY_STYLE).map(([k, s]) => (
            <path key={k} d={path(data.overlays[k] ?? [], x, y)} fill="none" stroke={s.color} strokeWidth={s.width}
              strokeDasharray={s.dash} opacity="0.9" />
          ))}
          {cs.map((c, i) => {
            const up = c.c >= c.o;
            const col = up ? "#2fe39e" : "#ff4f6d";
            const top = y(Math.max(c.o, c.c));
            const h = Math.max(0.8, Math.abs(y(c.o) - y(c.c)));
            return (
              <g key={c.t} opacity={c.closed ? 1 : 0.7}>
                <line x1={x(i)} x2={x(i)} y1={y(c.h)} y2={y(c.l)} stroke={col} strokeWidth="0.8" />
                <rect x={x(i) - step * 0.32} width={Math.max(1, step * 0.64)} y={top} height={h} fill={col} rx="0.4" />
              </g>
            );
          })}
          {pos && [
            { v: Number(pos.entry_price), c: "#3ee6ff", l: "entrada" },
            { v: Number(pos.stop_price), c: "#ff4f6d", l: "stop" },
            { v: Number(pos.take_profit), c: "#2fe39e", l: "alvo" },
          ].map((ln) => (
            <g key={ln.l}>
              <line x1="0" x2={W - PAD_R} y1={y(ln.v)} y2={y(ln.v)} stroke={ln.c} strokeWidth="0.9" strokeDasharray="4 3" />
              <text x="3" y={y(ln.v) - 3} fill={ln.c} fontSize="7.5" fontFamily="monospace">{ln.l}</text>
            </g>
          ))}
        </g>
        <rect x={W - PAD_R + 1} y={y(last.c) - 6} width={PAD_R - 2} height="12" rx="2" fill={last.c >= last.o ? "#2fe39e" : "#ff4f6d"} />
        <text x={W - PAD_R + 4} y={y(last.c) + 3} fill="#03110b" fontSize="7.5" fontWeight="700" fontFamily="monospace">{priceShort(last.c)}</text>

        <text x="2" y={rsiTop + 8} fill="#8a99ae" fontSize="7.5" fontFamily="monospace">RSI 14</text>
        <rect x="0" y={yr(70)} width={W - PAD_R} height={yr(30) - yr(70)} fill="rgba(139,109,255,0.07)" />
        <line x1="0" x2={W - PAD_R} y1={yr(70)} y2={yr(70)} stroke="#22304a" strokeWidth="0.6" />
        <line x1="0" x2={W - PAD_R} y1={yr(30)} y2={yr(30)} stroke="#22304a" strokeWidth="0.6" />
        <path d={path(data.rsi, x, yr)} fill="none" stroke="#8b6dff" strokeWidth="1.1" />
        <text x={W - PAD_R + 4} y={yr(70) + 3} fill="#56647b" fontSize="7" fontFamily="monospace">70</text>
        <text x={W - PAD_R + 4} y={yr(30) + 3} fill="#56647b" fontSize="7" fontFamily="monospace">30</text>

        <text x="2" y={macdTop + 8} fill="#8a99ae" fontSize="7.5" fontFamily="monospace">MACD hist.</text>
        <line x1="0" x2={W - PAD_R} y1={ym(0)} y2={ym(0)} stroke="#22304a" strokeWidth="0.6" />
        {hist.map((v, i) => (
          <rect key={`m${i}`} x={x(i) - step * 0.3} width={Math.max(0.8, step * 0.6)} y={Math.min(ym(v), ym(0))}
            height={Math.abs(ym(v) - ym(0))} fill={v >= 0 ? "rgba(47,227,158,0.7)" : "rgba(255,79,109,0.7)"} />
        ))}
      </svg>
      <div className="legend">
        {Object.entries(OVERLAY_STYLE).filter(([, s]) => s.label).map(([k, s]) => (
          <span key={k}><i style={{ background: s.color }} />{s.label}</span>
        ))}
      </div>
    </div>
  );
}
