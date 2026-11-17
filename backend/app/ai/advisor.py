"""Módulo de análise estratégica com a API do Claude (OPCIONAL).

Garantias de segurança (estruturais, não apenas "pedidas" ao modelo):
- O consultor recebe um RELATÓRIO em texto e devolve TEXTO. Ele não recebe
  o motor, o gestor de risco, o banco com permissão de escrita de
  configurações, nem credenciais.
- Nenhum código lê a resposta para alterar parâmetros. Sugestões são exibidas
  ao proprietário, que decide manualmente.
- Chamadas limitadas (intervalo mínimo e teto diário) para controlar custo.
- O motor de execução funciona 100% sem este módulo.
"""
from __future__ import annotations

import time
from typing import Any, Callable

import requests

from ..db import dumps

API_URL = "https://api.anthropic.com/v1/messages"

SYSTEM_PROMPT = (
    "Você é o analista estratégico do CLAUDE TRADER AI, um robô de day trade em Binance Spot "
    "(somente compra, sem alavancagem). Responda em português do Brasil, de forma objetiva. "
    "Você recebe um relatório técnico gerado pelo robô. Tarefas: interpretar o contexto de mercado, "
    "identificar mudanças de regime, avaliar o desempenho com honestidade estatística (amostras pequenas "
    "não provam nada), explicar as decisões do robô e sugerir melhorias TESTÁVEIS. Você NÃO pode alterar "
    "configurações, limites de risco, credenciais ou executar ordens; o proprietário decide. Nunca "
    "prometa lucro. Se os dados forem insuficientes, diga isso."
)


class AdvisorUnavailable(Exception):
    pass


class ClaudeAdvisor:
    def __init__(self, api_key: str | None, model: str, repo: Any, min_interval_minutes: int = 10,
                 max_calls_per_day: int = 24, post: Callable[..., Any] | None = None,
                 clock: Callable[[], float] = time.time):
        self._api_key = api_key
        self.model = model
        self.repo = repo
        self.min_interval = min_interval_minutes * 60
        self.max_per_day = max_calls_per_day
        self._post = post or requests.post
        self.clock = clock
        self.last_call = 0.0

    @property
    def enabled(self) -> bool:
        return bool(self._api_key)

    def __repr__(self) -> str:
        return f"ClaudeAdvisor(model={self.model!r}, enabled={self.enabled})"

    @staticmethod
    def build_report(snapshot: dict[str, Any], recent_decisions: list[dict[str, Any]],
                     recent_trades: list[dict[str, Any]]) -> str:
        """Monta um relatório SEM dados sensíveis (sem chaves, sem senha)."""
        safe = {
            "modo": snapshot.get("mode"),
            "estado": snapshot.get("status"),
            "motivo_estado": snapshot.get("status_reason"),
            "estrategia": snapshot.get("strategy"),
            "dados_sinteticos": snapshot.get("synthetic_data"),
            "conta": {k: snapshot.get("account", {}).get(k) for k in ("equity", "equity_brl", "free", "exposure")},
            "hoje": snapshot.get("today"),
            "total": snapshot.get("totals"),
            "risco": snapshot.get("risk"),
            "limites_risco": snapshot.get("risk_settings"),
            "mercado": snapshot.get("market"),
            "analises": {
                s: {k: d.get(k) for k in ("signal", "decision", "score", "regime", "volatility", "failed_gate",
                                          "reasons", "blockers", "trends")}
                for s, d in snapshot.get("brain", {}).get("latest", {}).items()
            },
            "riscos_identificados": snapshot.get("brain", {}).get("risks"),
            "ultimas_decisoes": [{k: d.get(k) for k in ("ts", "symbol", "action", "accepted", "score", "summary")}
                                 for d in recent_decisions[:30]],
            "ultimas_operacoes": [{k: t.get(k) for k in ("symbol", "entry_price", "exit_price", "exit_reason",
                                                           "pnl_quote", "pnl_pct", "r_multiple", "score")}
                                  for t in recent_trades[:20]],
        }
        return dumps(safe)

    def check_limits(self) -> None:
        if not self.enabled:
            raise AdvisorUnavailable("IA desativada: configure ANTHROPIC_API_KEY no servidor para usar este recurso.")
        now = self.clock()
        if now - self.last_call < self.min_interval:
            wait = int((self.min_interval - (now - self.last_call)) / 60) + 1
            raise AdvisorUnavailable(f"Aguarde {wait} min para nova análise (controle de custo).")
        if self.repo.ai_calls_since(now - 86400) >= self.max_per_day:
            raise AdvisorUnavailable("Limite diário de análises da IA atingido (controle de custo).")

    def analyze(self, report: str, question: str) -> str:
        self.check_limits()
        self.last_call = self.clock()
        body = {
            "model": self.model,
            "max_tokens": 1500,
            "system": SYSTEM_PROMPT,
            "messages": [{"role": "user", "content": f"Pergunta do proprietário: {question}\n\nRelatório do robô (JSON):\n{report}"}],
        }
        headers = {"x-api-key": self._api_key or "", "anthropic-version": "2023-06-01", "content-type": "application/json"}
        try:
            resp = self._post(API_URL, json=body, headers=headers, timeout=60)
        except requests.RequestException as exc:
            raise AdvisorUnavailable(f"Falha de conexão com a API do Claude: {exc}") from exc
        if resp.status_code != 200:
            raise AdvisorUnavailable(f"API do Claude respondeu HTTP {resp.status_code}")
        data = resp.json()
        text = "".join(part.get("text", "") for part in data.get("content", []) if part.get("type") == "text")
        self.repo.insert_ai_report(self.clock(), self.model, question, text)
        return text
