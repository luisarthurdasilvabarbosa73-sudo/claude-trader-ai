"""Gestor de risco: decide se uma NOVA entrada é permitida.

Ele não decide comprar — só pode BLOQUEAR. Todas as proteções obrigatórias:
risco por operação (via capital.py), perda diária, operações simultâneas,
exposição total, ordens duplicadas, dados desatualizados, falhas de conexão,
volatilidade anormal (circuit breaker) e sequência de perdas.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass, field
from decimal import Decimal
from typing import Any, Sequence

from ..domain import ZERO, BotStatus, Candle, D
from .settings import RiskSettings


@dataclass
class RiskState:
    day_key: str = ""
    day_start_equity: Decimal = ZERO
    daily_locked: bool = False
    daily_lock_reason: str = ""
    consecutive_losses: int = 0
    pause_until: float = 0.0
    pause_reason: str = ""
    symbol_block_until: dict[str, float] = field(default_factory=dict)
    symbol_block_reason: dict[str, str] = field(default_factory=dict)
    last_exit_ts: dict[str, float] = field(default_factory=dict)
    error_times: list[float] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        d["day_start_equity"] = str(self.day_start_equity)
        return d

    @staticmethod
    def from_dict(d: dict[str, Any] | None) -> "RiskState":
        if not d:
            return RiskState()
        d = dict(d)
        d["day_start_equity"] = D(d.get("day_start_equity", "0"))
        return RiskState(**{k: v for k, v in d.items() if k in RiskState.__dataclass_fields__})


class RiskManager:
    def __init__(self, settings: RiskSettings, state: RiskState | None = None):
        self.settings = settings
        self.state = state or RiskState()

    # ----------------------------------------------------------- dia/perda
    def new_day(self, day_key: str, equity: Decimal) -> None:
        self.state.day_key = day_key
        self.state.day_start_equity = equity
        self.state.daily_locked = False
        self.state.daily_lock_reason = ""
        self.state.consecutive_losses = 0

    def daily_loss_pct(self, equity: Decimal) -> Decimal:
        start = self.state.day_start_equity
        if start <= 0:
            return ZERO
        return (start - equity) / start * 100

    def check_daily_loss(self, equity: Decimal) -> bool:
        """Bloqueia novas entradas se a perda do dia (realizada + aberta) atingir o limite."""
        loss = self.daily_loss_pct(equity)
        if not self.state.daily_locked and loss >= D(self.settings.max_daily_loss_pct):
            self.state.daily_locked = True
            self.state.daily_lock_reason = (
                f"Limite de perda diária atingido ({loss:.2f}% >= {self.settings.max_daily_loss_pct}%). "
                "Novas entradas bloqueadas até o próximo dia."
            )
            return True
        return False

    # ------------------------------------------------------ eventos/trades
    def on_trade_closed(self, symbol: str, pnl: Decimal, now: float) -> str | None:
        self.state.last_exit_ts[symbol] = now
        if pnl < 0:
            self.state.consecutive_losses += 1
            if self.state.consecutive_losses >= self.settings.max_consecutive_losses:
                mins = self.settings.loss_streak_pause_minutes
                self.state.pause_until = now + mins * 60
                self.state.pause_reason = (
                    f"{self.state.consecutive_losses} perdas seguidas: pausa de {mins} min para evitar "
                    "operar em condição desfavorável (sem tentar recuperar prejuízo)."
                )
                self.state.consecutive_losses = 0
                return self.state.pause_reason
        else:
            self.state.consecutive_losses = 0
        return None

    def record_error(self, now: float, window_s: float = 300, max_errors: int = 3) -> str | None:
        self.state.error_times = [t for t in self.state.error_times if now - t <= window_s] + [now]
        if len(self.state.error_times) >= max_errors:
            self.state.pause_until = now + 15 * 60
            self.state.pause_reason = f"{len(self.state.error_times)} falhas de execução em 5 min: pausa de 15 min."
            self.state.error_times = []
            return self.state.pause_reason
        return None

    def check_circuit(self, symbol: str, candles_1m: Sequence[Candle], now: float) -> str | None:
        """Circuit breaker: movimento anormal em um candle de 1m bloqueia o ativo."""
        recent = [c for c in candles_1m if c.closed][-3:]
        limit = self.settings.circuit_move_1m_pct
        for c in recent:
            if c.open <= 0:
                continue
            move = (c.high - c.low) / c.open * 100
            if move >= limit:
                until = now + self.settings.circuit_pause_minutes * 60
                if self.state.symbol_block_until.get(symbol, 0) < until - 60:
                    self.state.symbol_block_until[symbol] = until
                    self.state.symbol_block_reason[symbol] = (
                        f"Movimento anormal de {move:.2f}% em 1 minuto (limite {limit}%): "
                        f"{symbol} bloqueado por {self.settings.circuit_pause_minutes} min."
                    )
                    return self.state.symbol_block_reason[symbol]
        return None

    # -------------------------------------------------------------- check
    def entry_blockers(
        self,
        symbol: str,
        now: float,
        *,
        bot_status: BotStatus,
        open_symbols: list[str],
        in_flight: set[str],
        data_fresh: bool,
        data_reason: str = "",
    ) -> list[str]:
        s, st = self.settings, self.state
        out: list[str] = []
        if bot_status != BotStatus.RODANDO:
            out.append(f"Robô em estado {bot_status.value}: novas entradas desativadas")
        if st.daily_locked:
            out.append(st.daily_lock_reason)
        if now < st.pause_until:
            out.append(f"Pausa automática ativa ({int((st.pause_until - now) / 60) + 1} min restantes): {st.pause_reason}")
        if now < st.symbol_block_until.get(symbol, 0):
            out.append(st.symbol_block_reason.get(symbol, f"{symbol} bloqueado temporariamente"))
        if symbol in open_symbols:
            out.append(f"Já existe posição aberta em {symbol} (proteção contra duplicidade)")
        if symbol in in_flight:
            out.append(f"Ordem em andamento para {symbol} (proteção contra duplicidade)")
        if len(open_symbols) >= s.max_open_positions:
            out.append(f"Limite de {s.max_open_positions} operação(ões) simultânea(s) atingido")
        last_exit = st.last_exit_ts.get(symbol)
        if last_exit and now - last_exit < s.cooldown_minutes_after_exit * 60:
            mins = int((s.cooldown_minutes_after_exit * 60 - (now - last_exit)) / 60) + 1
            out.append(f"Intervalo de segurança após saída em {symbol} ({mins} min restantes)")
        if not data_fresh:
            out.append(data_reason or "Dados de mercado desatualizados")
        return out

    def status(self, now: float, equity: Decimal) -> dict[str, Any]:
        st = self.state
        return {
            "daily_loss_pct": float(self.daily_loss_pct(equity)),
            "daily_limit_pct": self.settings.max_daily_loss_pct,
            "daily_locked": st.daily_locked,
            "daily_lock_reason": st.daily_lock_reason,
            "consecutive_losses": st.consecutive_losses,
            "paused": now < st.pause_until,
            "pause_reason": st.pause_reason if now < st.pause_until else "",
            "pause_until": st.pause_until if now < st.pause_until else None,
            "blocked_symbols": {k: st.symbol_block_reason.get(k, "") for k, v in st.symbol_block_until.items() if v > now},
        }
