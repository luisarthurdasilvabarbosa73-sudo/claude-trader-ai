"""Banco de dados SQLite (arquivo único, modo WAL).

Escolha: SQLite é suficiente para um único robô, não exige serviço extra e
persiste em um volume do provedor de nuvem. Todas as decisões, ordens,
operações e eventos ficam registrados para auditoria.
"""
from __future__ import annotations

import json
import os
import sqlite3
import threading
import time
from contextlib import contextmanager
from decimal import Decimal
from typing import Any, Iterable, Iterator

from .domain import D, Fill, Position

SCHEMA = """
CREATE TABLE IF NOT EXISTS kv (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_order_id TEXT NOT NULL UNIQUE,
    symbol TEXT NOT NULL,
    side TEXT NOT NULL,
    qty TEXT NOT NULL,
    price TEXT NOT NULL,
    quote_qty TEXT NOT NULL,
    fee TEXT NOT NULL,
    fee_asset TEXT NOT NULL,
    fee_quote TEXT NOT NULL,
    reference_price TEXT NOT NULL,
    mode TEXT NOT NULL,
    position_id INTEGER,
    ts REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS positions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol TEXT NOT NULL,
    mode TEXT NOT NULL,
    status TEXT NOT NULL,
    data TEXT NOT NULL,
    entry_time REAL NOT NULL,
    exit_time REAL
);
CREATE INDEX IF NOT EXISTS idx_positions_status ON positions(status);
CREATE INDEX IF NOT EXISTS idx_positions_exit ON positions(exit_time);
CREATE TABLE IF NOT EXISTS decisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts REAL NOT NULL,
    symbol TEXT NOT NULL,
    action TEXT NOT NULL,
    accepted INTEGER NOT NULL,
    score REAL NOT NULL,
    summary TEXT NOT NULL,
    details TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_decisions_ts ON decisions(ts);
CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts REAL NOT NULL,
    level TEXT NOT NULL,
    category TEXT NOT NULL,
    message TEXT NOT NULL,
    data TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
CREATE TABLE IF NOT EXISTS equity (
    ts REAL PRIMARY KEY,
    equity_quote TEXT NOT NULL,
    equity_brl TEXT
);
CREATE TABLE IF NOT EXISTS ai_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts REAL NOT NULL,
    model TEXT NOT NULL,
    question TEXT NOT NULL,
    response TEXT NOT NULL
);
"""


class _DecimalEncoder(json.JSONEncoder):
    def default(self, o: Any) -> Any:
        if isinstance(o, Decimal):
            return str(o)
        return super().default(o)


def dumps(obj: Any) -> str:
    return json.dumps(obj, cls=_DecimalEncoder, ensure_ascii=False)


_POS_DECIMALS = {
    "entry_price", "qty", "cost_quote", "stop_price", "initial_stop", "take_profit",
    "risk_quote", "fees_quote", "highest_price", "exit_price", "proceeds_quote", "pnl_quote",
}


def position_from_row(row_id: int, data: str) -> Position:
    raw = json.loads(data)
    for key in _POS_DECIMALS:
        if raw.get(key) is not None:
            raw[key] = D(raw[key])
    raw["id"] = row_id
    return Position(**raw)


class Repository:
    def __init__(self, path: str):
        self.path = path
        if path != ":memory:":
            os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
        self._lock = threading.RLock()
        self._conn = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
        self._conn.row_factory = sqlite3.Row
        with self._lock:
            if path != ":memory:":
                self._conn.execute("PRAGMA journal_mode=WAL")
            self._conn.execute("PRAGMA synchronous=NORMAL")
            self._conn.executescript(SCHEMA)

    def close(self) -> None:
        with self._lock:
            self._conn.close()

    @contextmanager
    def transaction(self) -> Iterator[None]:
        """Agrupa várias gravações (ordem + saldo + posição) de forma atômica."""
        with self._lock:
            if self._conn.in_transaction:
                yield
                return
            self._conn.execute("BEGIN IMMEDIATE")
            try:
                yield
            except BaseException:
                self._conn.execute("ROLLBACK")
                raise
            self._conn.execute("COMMIT")

    def _exec(self, sql: str, params: Iterable[Any] = ()) -> sqlite3.Cursor:
        with self._lock:
            return self._conn.execute(sql, tuple(params))

    # ------------------------------------------------------------------ kv
    def kv_get(self, key: str, default: Any = None) -> Any:
        row = self._exec("SELECT value FROM kv WHERE key=?", (key,)).fetchone()
        return json.loads(row["value"]) if row else default

    def kv_set(self, key: str, value: Any) -> None:
        self._exec(
            "INSERT INTO kv(key, value, updated_at) VALUES(?,?,?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
            (key, dumps(value), time.time()),
        )

    # -------------------------------------------------------------- orders
    def get_order(self, client_order_id: str) -> Fill | None:
        row = self._exec("SELECT * FROM orders WHERE client_order_id=?", (client_order_id,)).fetchone()
        if not row:
            return None
        return Fill(
            client_order_id=row["client_order_id"], symbol=row["symbol"], side=row["side"],
            qty=D(row["qty"]), price=D(row["price"]), quote_qty=D(row["quote_qty"]),
            fee=D(row["fee"]), fee_asset=row["fee_asset"], fee_quote=D(row["fee_quote"]),
            ts=row["ts"], mode=row["mode"], reference_price=D(row["reference_price"]),
        )

    def insert_order(self, fill: Fill, position_id: int | None = None) -> None:
        self._exec(
            "INSERT INTO orders(client_order_id, symbol, side, qty, price, quote_qty, fee, fee_asset,"
            " fee_quote, reference_price, mode, position_id, ts) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (fill.client_order_id, fill.symbol, fill.side, str(fill.qty), str(fill.price),
             str(fill.quote_qty), str(fill.fee), fill.fee_asset, str(fill.fee_quote),
             str(fill.reference_price), fill.mode, position_id, fill.ts),
        )

    def link_order(self, client_order_id: str, position_id: int) -> None:
        self._exec("UPDATE orders SET position_id=? WHERE client_order_id=?", (position_id, client_order_id))

    def fees_since(self, ts: float, mode: str) -> Decimal:
        rows = self._exec("SELECT fee_quote FROM orders WHERE ts>=? AND mode=?", (ts, mode)).fetchall()
        return sum((D(r["fee_quote"]) for r in rows), Decimal(0))

    def count_orders(self) -> int:
        return int(self._exec("SELECT COUNT(*) AS n FROM orders").fetchone()["n"])

    # ----------------------------------------------------------- positions
    def save_position(self, pos: Position) -> Position:
        data = pos.to_dict()
        data.pop("id", None)
        payload = dumps(data)
        if pos.id is None:
            cur = self._exec(
                "INSERT INTO positions(symbol, mode, status, data, entry_time, exit_time) VALUES(?,?,?,?,?,?)",
                (pos.symbol, pos.mode, pos.status, payload, pos.entry_time, pos.exit_time),
            )
            pos.id = int(cur.lastrowid)
        else:
            self._exec(
                "UPDATE positions SET status=?, data=?, exit_time=? WHERE id=?",
                (pos.status, payload, pos.exit_time, pos.id),
            )
        return pos

    def open_positions(self, mode: str | None = None) -> list[Position]:
        sql = "SELECT id, data FROM positions WHERE status='ABERTA'"
        params: tuple[Any, ...] = ()
        if mode:
            sql += " AND mode=?"
            params = (mode,)
        return [position_from_row(r["id"], r["data"]) for r in self._exec(sql + " ORDER BY id", params)]

    def closed_positions(self, since: float | None = None, limit: int = 500, mode: str | None = None) -> list[Position]:
        sql = "SELECT id, data FROM positions WHERE status='FECHADA'"
        params: list[Any] = []
        if since is not None:
            sql += " AND exit_time>=?"
            params.append(since)
        if mode:
            sql += " AND mode=?"
            params.append(mode)
        sql += " ORDER BY exit_time DESC LIMIT ?"
        params.append(limit)
        return [position_from_row(r["id"], r["data"]) for r in self._exec(sql, params)]

    def all_positions(self, limit: int = 100, mode: str | None = None) -> list[Position]:
        sql = "SELECT id, data FROM positions"
        params: list[Any] = []
        if mode:
            sql += " WHERE mode=?"
            params.append(mode)
        sql += " ORDER BY id DESC LIMIT ?"
        params.append(limit)
        return [position_from_row(r["id"], r["data"]) for r in self._exec(sql, params)]

    # ----------------------------------------------------------- decisions
    def insert_decision(self, ts: float, symbol: str, action: str, accepted: bool, score: float,
                        summary: str, details: dict[str, Any]) -> None:
        self._exec(
            "INSERT INTO decisions(ts, symbol, action, accepted, score, summary, details) VALUES(?,?,?,?,?,?,?)",
            (ts, symbol, action, 1 if accepted else 0, score, summary, dumps(details)),
        )

    def recent_decisions(self, limit: int = 50, only_rejected: bool = False) -> list[dict[str, Any]]:
        sql = "SELECT * FROM decisions"
        if only_rejected:
            sql += " WHERE accepted=0"
        sql += " ORDER BY id DESC LIMIT ?"
        out = []
        for r in self._exec(sql, (limit,)):
            out.append({
                "id": r["id"], "ts": r["ts"], "symbol": r["symbol"], "action": r["action"],
                "accepted": bool(r["accepted"]), "score": r["score"], "summary": r["summary"],
                "details": json.loads(r["details"]),
            })
        return out

    # -------------------------------------------------------------- events
    def log(self, level: str, category: str, message: str, data: dict[str, Any] | None = None,
            ts: float | None = None) -> None:
        self._exec(
            "INSERT INTO events(ts, level, category, message, data) VALUES(?,?,?,?,?)",
            (ts if ts is not None else time.time(), level, category, message, dumps(data) if data else None),
        )

    def recent_events(self, limit: int = 100, level: str | None = None) -> list[dict[str, Any]]:
        sql = "SELECT * FROM events"
        params: list[Any] = []
        if level:
            sql += " WHERE level=?"
            params.append(level)
        sql += " ORDER BY id DESC LIMIT ?"
        params.append(limit)
        return [
            {"id": r["id"], "ts": r["ts"], "level": r["level"], "category": r["category"],
             "message": r["message"], "data": json.loads(r["data"]) if r["data"] else None}
            for r in self._exec(sql, params)
        ]

    # -------------------------------------------------------------- equity
    def insert_equity(self, ts: float, equity_quote: Decimal, equity_brl: Decimal | None) -> None:
        self._exec(
            "INSERT OR REPLACE INTO equity(ts, equity_quote, equity_brl) VALUES(?,?,?)",
            (ts, str(equity_quote), str(equity_brl) if equity_brl is not None else None),
        )

    def equity_series(self, since: float) -> list[dict[str, Any]]:
        return [
            {"ts": r["ts"], "equity_quote": r["equity_quote"], "equity_brl": r["equity_brl"]}
            for r in self._exec("SELECT * FROM equity WHERE ts>=? ORDER BY ts", (since,))
        ]

    # ----------------------------------------------------------------- IA
    def insert_ai_report(self, ts: float, model: str, question: str, response: str) -> None:
        self._exec(
            "INSERT INTO ai_reports(ts, model, question, response) VALUES(?,?,?,?)",
            (ts, model, question, response),
        )

    def recent_ai_reports(self, limit: int = 10) -> list[dict[str, Any]]:
        return [dict(r) for r in self._exec("SELECT * FROM ai_reports ORDER BY id DESC LIMIT ?", (limit,))]

    def ai_calls_since(self, ts: float) -> int:
        return int(self._exec("SELECT COUNT(*) AS n FROM ai_reports WHERE ts>=?", (ts,)).fetchone()["n"])

    # ---------------------------------------------------------- manutenção
    def prune(self, older_than_days: int = 30, now: float | None = None) -> None:
        cutoff = (now if now is not None else time.time()) - older_than_days * 86400
        self._exec("DELETE FROM decisions WHERE ts<?", (cutoff,))
        self._exec("DELETE FROM events WHERE ts<? AND level IN ('INFO','DEBUG')", (cutoff,))
