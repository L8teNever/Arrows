"""Spieler-Konten und Ergebnisse in SQLite (Pfad ueber ARROWS_DB, Standard ./data/arrows.db)."""

from __future__ import annotations

import os
import re
import sqlite3
import time

DB_PATH = os.environ.get("ARROWS_DB", os.path.join(os.path.dirname(__file__), "data", "arrows.db"))
NAME_RE = re.compile(r"^[A-Za-z0-9ÄÖÜäöüß_-]{1,24}$")
RESERVED = {"api", "static", "dashboard", "healthz", "sw", "manifest", "icon"}

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    created INTEGER NOT NULL,
    last_seen INTEGER NOT NULL,
    level INTEGER NOT NULL DEFAULT 1,      -- wo er gerade ist
    max_level INTEGER NOT NULL DEFAULT 1,  -- freigeschaltet bis
    play_ms INTEGER NOT NULL DEFAULT 0     -- gesamte aktive Spielzeit
);
CREATE TABLE IF NOT EXISTS results (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    level INTEGER NOT NULL,
    ms INTEGER NOT NULL,
    mistakes INTEGER NOT NULL,
    ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS results_user_level ON results(user_id, level);
CREATE INDEX IF NOT EXISTS results_level ON results(level);
"""


def valid_name(name: str) -> bool:
    return bool(NAME_RE.match(name)) and name.lower() not in RESERVED


def connect() -> sqlite3.Connection:
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    con = sqlite3.connect(DB_PATH, timeout=10)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA journal_mode=WAL")
    con.execute("PRAGMA foreign_keys=ON")
    return con


def init() -> None:
    with connect() as con:
        con.executescript(SCHEMA)
        cols = {r["name"] for r in con.execute("PRAGMA table_info(users)")}
        if "email" not in cols:  # Login ueber Cloudflare Zero Trust
            con.execute("ALTER TABLE users ADD COLUMN email TEXT")
        con.execute("CREATE UNIQUE INDEX IF NOT EXISTS users_email ON users(email COLLATE NOCASE)")


def name_from_email(email: str) -> str:
    """simon.k@gmail.com -> simon.k ist kein gueltiger Name, daher: simon-k (max. 24 Zeichen)."""
    local = email.split("@", 1)[0]
    name = re.sub(r"[^A-Za-z0-9ÄÖÜäöüß_-]+", "-", local).strip("-_")[:24] or "Spieler"
    return name if valid_name(name) else f"{name[:20]}-1"


def get_or_create_by_email(con, email: str) -> sqlite3.Row:
    """Konto zur Zero-Trust-Mail; beim ersten Login wird der Teil vor dem @ zum Namen."""
    email = email.strip().lower()
    row = con.execute("SELECT * FROM users WHERE email = ?", (email,)).fetchone()
    if row:
        return row
    base = name_from_email(email)
    name, i = base, 2
    while con.execute("SELECT 1 FROM users WHERE name = ?", (name,)).fetchone():
        suffix = f"-{i}"
        name, i = base[: 24 - len(suffix)] + suffix, i + 1
    t = now()
    con.execute("INSERT INTO users (name, email, created, last_seen) VALUES (?, ?, ?, ?)", (name, email, t, t))
    return con.execute("SELECT * FROM users WHERE email = ?", (email,)).fetchone()


def now() -> int:
    return int(time.time())


def get_user(con, name: str) -> sqlite3.Row:
    return con.execute("SELECT * FROM users WHERE name = ?", (name,)).fetchone()


def user_json(row) -> dict:
    return {"name": row["name"], "level": row["level"], "max": row["max_level"], "playMs": row["play_ms"]}


def progress(con, name: str, level: int | None, play_ms: int) -> sqlite3.Row:
    u = get_user(con, name)
    lvl = u["level"] if level is None else max(1, min(level, u["max_level"]))
    con.execute(
        "UPDATE users SET level = ?, play_ms = play_ms + ?, last_seen = ? WHERE id = ?",
        (lvl, max(0, min(play_ms, 6 * 3600_000)), now(), u["id"]),
    )
    return con.execute("SELECT * FROM users WHERE id = ?", (u["id"],)).fetchone()


def add_result(con, name: str, level: int, ms: int, mistakes: int, play_ms: int) -> sqlite3.Row:
    u = get_user(con, name)
    if level > u["max_level"]:
        raise ValueError("Level noch nicht freigeschaltet")
    con.execute(
        "INSERT INTO results (user_id, level, ms, mistakes, ts) VALUES (?, ?, ?, ?, ?)",
        (u["id"], level, ms, mistakes, now()),
    )
    nxt = level + 1
    con.execute(
        "UPDATE users SET max_level = MAX(max_level, ?), level = ?, play_ms = play_ms + ?, last_seen = ? WHERE id = ?",
        (nxt, nxt, max(0, min(play_ms, 6 * 3600_000)), now(), u["id"]),
    )
    return con.execute("SELECT * FROM users WHERE id = ?", (u["id"],)).fetchone()


def stats_version(con) -> str:
    """Aendert sich bei jedem neuen Ergebnis, Fortschritt oder Konto (fuer die Live-Statistik)."""
    r = con.execute("SELECT COALESCE(MAX(id), 0), COUNT(*) FROM results").fetchone()
    u = con.execute("SELECT COUNT(*), COALESCE(SUM(play_ms), 0), COALESCE(SUM(level), 0), COALESCE(MAX(last_seen), 0) FROM users").fetchone()
    return "-".join(str(x) for x in (*r, *u))


def best_times(con, user_id: int) -> dict[int, int]:
    return {r[0]: r[1] for r in con.execute("SELECT level, MIN(ms) FROM results WHERE user_id = ? GROUP BY level", (user_id,))}
