"""Autenticação do proprietário (usuário único) e proteções de acesso."""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode().rstrip("=")


def _unb64(data: str) -> bytes:
    return base64.urlsafe_b64decode(data + "=" * (-len(data) % 4))


def make_token(secret: str, hours: int, now: float | None = None) -> tuple[str, float]:
    now = now if now is not None else time.time()
    exp = now + hours * 3600
    payload = _b64(json.dumps({"sub": "owner", "exp": exp, "iat": now}).encode())
    sig = _b64(hmac.new(secret.encode(), payload.encode(), hashlib.sha256).digest())
    return f"{payload}.{sig}", exp


def verify_token(token: str, secret: str, now: float | None = None) -> bool:
    now = now if now is not None else time.time()
    try:
        payload, sig = token.split(".", 1)
        expected = _b64(hmac.new(secret.encode(), payload.encode(), hashlib.sha256).digest())
        if not hmac.compare_digest(sig, expected):
            return False
        data = json.loads(_unb64(payload))
        return data.get("sub") == "owner" and float(data["exp"]) > now
    except Exception:
        return False


def check_password(provided: str, expected: str | None) -> bool:
    if not expected:
        return False
    a = hashlib.sha256(provided.encode()).digest()
    b = hashlib.sha256(expected.encode()).digest()
    return hmac.compare_digest(a, b)


class LoginLimiter:
    """Bloqueia um IP após várias senhas erradas (proteção contra força bruta)."""

    def __init__(self, max_failures: int = 5, window_s: float = 900, lock_s: float = 900):
        self.max_failures = max_failures
        self.window_s = window_s
        self.lock_s = lock_s
        self._fail: dict[str, list[float]] = {}
        self._locked: dict[str, float] = {}

    def locked_for(self, ip: str, now: float) -> float:
        until = self._locked.get(ip, 0)
        return max(0.0, until - now)

    def failure(self, ip: str, now: float) -> None:
        hist = [t for t in self._fail.get(ip, []) if now - t <= self.window_s] + [now]
        self._fail[ip] = hist
        if len(hist) >= self.max_failures:
            self._locked[ip] = now + self.lock_s
            self._fail[ip] = []

    def success(self, ip: str) -> None:
        self._fail.pop(ip, None)
        self._locked.pop(ip, None)


SECURITY_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "Content-Security-Policy": (
        "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; "
        "script-src 'self'; connect-src 'self'; manifest-src 'self'; worker-src 'self'; "
        "frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
    ),
    "Strict-Transport-Security": "max-age=31536000",
}
