"""Dados históricos REAIS da Binance (arquivos públicos oficiais em data.binance.vision).

Os arquivos .zip mensais/diários de klines são baixados e conferidos pelo
checksum SHA-256 publicado pela própria Binance.
Observação: a partir de 2025 os arquivos Spot usam timestamps em
MICROssegundos; a leitura normaliza para milissegundos.
"""
from __future__ import annotations

import csv
import hashlib
import io
import os
import zipfile
from datetime import date, timedelta
from typing import Iterable

from ..domain import Candle

BASE = "https://data.binance.vision/data/spot"


def _norm_ts(v: int) -> int:
    return v // 1000 if v > 10**14 else v


def parse_rows(rows: Iterable[list[str]]) -> list[Candle]:
    out: list[Candle] = []
    for r in rows:
        if not r or not r[0].strip().lstrip("-").isdigit():
            continue  # cabeçalho ou linha vazia
        out.append(Candle(
            open_time=_norm_ts(int(r[0])), open=float(r[1]), high=float(r[2]), low=float(r[3]),
            close=float(r[4]), volume=float(r[5]), close_time=_norm_ts(int(r[6])),
            quote_volume=float(r[7]), trades=int(float(r[8])), closed=True,
        ))
    return out


def load_csv(path: str) -> list[Candle]:
    with open(path, newline="") as fh:
        return parse_rows(csv.reader(fh))


def load_zip_bytes(data: bytes) -> list[Candle]:
    with zipfile.ZipFile(io.BytesIO(data)) as zf:
        name = zf.namelist()[0]
        with zf.open(name) as fh:
            return parse_rows(csv.reader(io.TextIOWrapper(fh, "utf-8")))


def _get(url: str) -> bytes | None:
    import requests
    r = requests.get(url, timeout=60)
    if r.status_code == 404:
        return None
    r.raise_for_status()
    return r.content


def download(symbol: str, period: str, cache_dir: str, interval: str = "1m") -> list[Candle]:
    """period: 'YYYY-MM' (mensal) ou 'YYYY-MM-DD' (diário)."""
    kind = "monthly" if len(period) == 7 else "daily"
    fname = f"{symbol}-{interval}-{period}.zip"
    url = f"{BASE}/{kind}/klines/{symbol}/{interval}/{fname}"
    os.makedirs(cache_dir, exist_ok=True)
    path = os.path.join(cache_dir, fname)
    if not os.path.exists(path):
        content = _get(url)
        if content is None:
            return []
        checksum = _get(url + ".CHECKSUM")
        if checksum:
            expected = checksum.decode().split()[0].strip().lower()
            got = hashlib.sha256(content).hexdigest()
            if expected != got:
                raise ValueError(f"Checksum inválido para {fname}: esperado {expected}, obtido {got}")
        with open(path, "wb") as fh:
            fh.write(content)
    with open(path, "rb") as fh:
        return load_zip_bytes(fh.read())


def download_range(symbol: str, start: date, end: date, cache_dir: str) -> list[Candle]:
    """Baixa meses completos quando possível e dias avulsos no restante."""
    candles: list[Candle] = []
    d = start
    while d <= end:
        month_end = (d.replace(day=28) + timedelta(days=4)).replace(day=1) - timedelta(days=1)
        if d.day == 1 and month_end <= end:
            got = download(symbol, d.strftime("%Y-%m"), cache_dir)
            if got:
                candles += got
                d = month_end + timedelta(days=1)
                continue
        candles += download(symbol, d.strftime("%Y-%m-%d"), cache_dir)
        d += timedelta(days=1)
    candles.sort(key=lambda c: c.open_time)
    dedup: list[Candle] = []
    for c in candles:
        if not dedup or c.open_time > dedup[-1].open_time:
            dedup.append(c)
    return dedup
