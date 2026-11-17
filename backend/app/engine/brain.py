"""CÉREBRO DO ROBÔ: registro legível do que o robô está pensando e por quê."""
from __future__ import annotations

from collections import deque
from typing import Any

from ..analysis.strategy import Analysis


class Brain:
    def __init__(self, max_thoughts: int = 200):
        self.thoughts: deque[dict[str, Any]] = deque(maxlen=max_thoughts)
        self.latest: dict[str, dict[str, Any]] = {}
        self.activity = "Inicializando…"
        self._last_summary: dict[str, str] = {}

    def think(self, ts: float, kind: str, text: str, symbol: str | None = None) -> None:
        """kind: info | aceita | rejeitada | sem_operacao | risco | alerta | saida"""
        self.thoughts.appendleft({"ts": ts, "kind": kind, "symbol": symbol, "text": text})

    def record(self, a: Analysis, blockers: list[str], decision: str, sizing_reason: str | None) -> None:
        failed = [g for g in a.gates if not g.passed]
        self.latest[a.symbol] = {
            "ts": a.ts,
            "symbol": a.symbol,
            "signal": a.action,
            "decision": decision,
            "score": a.score,
            "min_score": a.min_score,
            "regime": a.regime,
            "volatility": a.volatility,
            "spread_pct": a.spread_pct,
            "entry": a.entry,
            "stop": a.stop,
            "take_profit": a.take_profit,
            "rr_net": a.rr_net,
            "resistance": a.resistance,
            "support": a.support,
            "gates": [{"label": g.label, "passed": g.passed, "detail": g.detail} for g in a.gates],
            "components": [{"label": c.label, "points": c.points, "max": c.max_points, "detail": c.detail}
                           for c in a.components],
            "reasons": a.reasons,
            "blockers": blockers,
            "sizing": sizing_reason,
            "failed_gate": failed[0].label if failed else None,
            "trends": {tf: v.get("trend") for tf, v in a.timeframes.items()},
        }
        # Pensamento só quando algo relevante muda (evita poluir a tela)
        if a.action == "COMPRAR":
            return  # o motor registra aceitação/rejeição explicitamente
        summary = a.summary
        if self._last_summary.get(a.symbol) != summary:
            self._last_summary[a.symbol] = summary
            self.think(a.ts, "sem_operacao", summary + (f" — {a.reasons[0]}" if a.reasons else ""), a.symbol)

    def risks(self) -> list[str]:
        out: list[str] = []
        for sym, d in self.latest.items():
            if d.get("volatility") in {"EXTREMA", "ALTA"}:
                out.append(f"{sym}: volatilidade {d['volatility'].lower()}")
            if d.get("regime") == "BAIXA":
                out.append(f"{sym}: regime de baixa no 1h (robô fica de fora)")
            if d.get("spread_pct") and d.get("spread_pct") > 0.1:
                out.append(f"{sym}: spread elevado ({d['spread_pct']:.3f}%)")
        return out

    def snapshot(self, limit: int = 60) -> dict[str, Any]:
        return {
            "activity": self.activity,
            "latest": self.latest,
            "thoughts": list(self.thoughts)[:limit],
            "risks": self.risks(),
        }
