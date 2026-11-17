"""Cliente WebSocket com reconexão automática.

- Backoff exponencial com jitter (1s, 2s, 4s ... até 60s).
- Watchdog: se nenhuma mensagem chegar em `idle_timeout` segundos, a conexão
  é considerada morta e é refeita (protege contra conexões "zumbis").
- A Binance encerra conexões a cada 24h: isso é tratado como reconexão normal.
- Após reconectar, `on_reconnect` é chamado para ressincronizar candles via REST
  (preenche lacunas do período desconectado).
"""
from __future__ import annotations

import asyncio
import json
import logging
import random
import time
from typing import Any, Awaitable, Callable

log = logging.getLogger("binance.ws")

ConnectFn = Callable[[str], Any]  # retorna um async context manager com .recv()


def default_connect(url: str) -> Any:
    try:
        import websockets  # type: ignore
    except ImportError as exc:  # pragma: no cover - depende do ambiente
        raise RuntimeError("Biblioteca 'websockets' não instalada") from exc
    return websockets.connect(url, ping_interval=20, ping_timeout=20, close_timeout=5,
                              max_size=2**22, open_timeout=15)


class StreamClient:
    def __init__(
        self,
        url: str,
        on_message: Callable[[dict[str, Any]], None],
        on_reconnect: Callable[[], Awaitable[None]] | None = None,
        connect: ConnectFn | None = None,
        idle_timeout: float = 30.0,
        max_backoff: float = 60.0,
        clock: Callable[[], float] = time.time,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
    ):
        self.url = url
        self.on_message = on_message
        self.on_reconnect = on_reconnect
        self._connect = connect or default_connect
        self.idle_timeout = idle_timeout
        self.max_backoff = max_backoff
        self.clock = clock
        self._sleep = sleep
        self._stopped = False
        self.connected = False
        self.connections = 0
        self.reconnects = 0
        self.messages = 0
        self.last_message_ts = 0.0
        self.last_error: str | None = None
        self._backoff = 1.0

    def stop(self) -> None:
        self._stopped = True

    def next_delay(self) -> float:
        delay = min(self._backoff, self.max_backoff)
        self._backoff = min(self._backoff * 2, self.max_backoff)
        return delay * (0.8 + random.random() * 0.4)

    async def run(self) -> None:
        while not self._stopped:
            try:
                async with self._connect(self.url) as ws:
                    self.connected = True
                    self.connections += 1
                    self._backoff = 1.0
                    self.last_error = None
                    if self.connections > 1 and self.on_reconnect:
                        await self.on_reconnect()
                    while not self._stopped:
                        raw = await asyncio.wait_for(ws.recv(), timeout=self.idle_timeout)
                        self.last_message_ts = self.clock()
                        self.messages += 1
                        try:
                            payload = json.loads(raw)
                        except (TypeError, ValueError):
                            continue
                        try:
                            self.on_message(payload)
                        except Exception as exc:  # erro de processamento não derruba a conexão
                            log.exception("Erro ao processar mensagem: %s", exc)
            except asyncio.CancelledError:
                self.connected = False
                raise
            except asyncio.TimeoutError:
                self.last_error = f"Nenhuma mensagem em {self.idle_timeout:.0f}s (conexão reiniciada)"
            except Exception as exc:
                self.last_error = f"{type(exc).__name__}: {exc}"
            finally:
                self.connected = False
            if self._stopped:
                break
            self.reconnects += 1
            delay = self.next_delay()
            log.warning("WebSocket desconectado (%s). Reconectando em %.1fs", self.last_error, delay)
            await self._sleep(delay)

    def health(self, now: float | None = None) -> dict[str, Any]:
        now = now if now is not None else self.clock()
        return {
            "connected": self.connected,
            "reconnects": self.reconnects,
            "messages": self.messages,
            "last_message_age_s": round(now - self.last_message_ts, 1) if self.last_message_ts else None,
            "last_error": self.last_error,
        }
