"""Estatísticas calculadas SOMENTE a partir das operações registradas no banco."""
from __future__ import annotations

import math
from datetime import datetime, timedelta, timezone, tzinfo
from decimal import Decimal
from typing import Any

from ..db import Repository
from ..domain import Position


def get_tz(name: str) -> tzinfo:
    try:
        from zoneinfo import ZoneInfo
        return ZoneInfo(name)
    except Exception:  # sem base de fusos no sistema: Brasília (UTC-3, sem horário de verão)
        return timezone(timedelta(hours=-3))


def day_start(now: float, tz: tzinfo) -> float:
    local = datetime.fromtimestamp(now, tz)
    return local.replace(hour=0, minute=0, second=0, microsecond=0).timestamp()


def day_key(now: float, tz: tzinfo) -> str:
    return datetime.fromtimestamp(now, tz).strftime("%Y-%m-%d")


def summarize(trades: list[Position]) -> dict[str, Any]:
    pnls = [t.pnl_quote or Decimal(0) for t in trades]
    wins = [p for p in pnls if p > 0]
    losses = [p for p in pnls if p <= 0]
    gross_win = sum(wins, Decimal(0))
    gross_loss = sum(losses, Decimal(0))
    fees = sum((t.fees_quote for t in trades), Decimal(0))
    n = len(trades)
    rs = [t.r_multiple for t in trades if t.r_multiple is not None]
    return {
        "trades": n,
        "wins": len(wins),
        "losses": len(losses),
        "win_rate": (len(wins) / n * 100) if n else None,
        "gross_profit": float(gross_win),
        "gross_loss": float(gross_loss),
        "net_pnl": float(gross_win + gross_loss),
        "fees": float(fees),
        "profit_factor": float(gross_win / -gross_loss) if gross_loss < 0 else None,
        "avg_r": (sum(rs) / len(rs)) if rs else None,
    }


def daily(repo: Repository, now: float, tz: tzinfo, mode: str) -> dict[str, Any]:
    start = day_start(now, tz)
    trades = repo.closed_positions(since=start, mode=mode, limit=10_000)
    out = summarize(trades)
    out["fees_paid"] = float(repo.fees_since(start, mode))  # inclui taxa de posições ainda abertas
    out["day_start_ts"] = start
    return out


def overall(repo: Repository, mode: str) -> dict[str, Any]:
    return summarize(repo.closed_positions(mode=mode, limit=100_000))


def significance(returns: list[float], n_boot: int = 2000, seed: int = 7) -> dict[str, Any]:
    """Teste estatístico simples do retorno médio por operação (em R ou %).

    Retorna média, desvio, estatística t e intervalo de confiança 95% por
    bootstrap. Só existe evidência de vantagem se n >= 100 E o limite
    inferior do intervalo for > 0.
    """
    import random

    n = len(returns)
    if n < 2:
        return {"n": n, "mean": returns[0] if returns else None, "t_stat": None, "ci95": None,
                "evidence": False, "verdict": "Amostra insuficiente: nenhuma conclusão possível."}
    mean = sum(returns) / n
    sd = math.sqrt(sum((r - mean) ** 2 for r in returns) / (n - 1))
    t = mean / (sd / math.sqrt(n)) if sd > 0 else None
    rnd = random.Random(seed)
    boots = sorted(sum(rnd.choice(returns) for _ in range(n)) / n for _ in range(n_boot))
    lo, hi = boots[int(0.025 * n_boot)], boots[int(0.975 * n_boot) - 1]
    evidence = n >= 100 and lo > 0
    if n < 100:
        verdict = f"Apenas {n} operações: amostra pequena demais para concluir qualquer coisa (mínimo 100)."
    elif evidence:
        verdict = "Há evidência estatística (95%) de retorno médio positivo NESTE período histórico. Isso não garante resultados futuros."
    else:
        verdict = "Sem evidência estatística de lucratividade: o intervalo de confiança inclui zero ou valores negativos."
    return {"n": n, "mean": mean, "sd": sd, "t_stat": t, "ci95": [lo, hi], "evidence": evidence, "verdict": verdict}
