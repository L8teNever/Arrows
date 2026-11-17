"""Auswertung fuer die Statistik-Seite."""

from __future__ import annotations

import math
from statistics import median


def fmt_ms(ms: float | None) -> str:
    if ms is None:
        return "–"
    s = int(round(ms / 1000))
    if s < 60:
        return f"{s} s"
    m, s = divmod(s, 60)
    if m < 60:
        return f"{m}:{s:02d} min"
    h, m = divmod(m, 60)
    return f"{h} h {m:02d} min"


def fmt_speed(f: float | None) -> str:
    """f = eigene Zeit / Schnitt der anderen. <1 = schneller."""
    if f is None:
        return "–"
    # bezogen auf die Zeit: 0.5 = braucht halb so lange = 50 % schneller, 2.0 = 100 % langsamer
    pct = round((1 - f) * 100)
    if abs(pct) < 3:
        return "wie der Schnitt"
    return f"{abs(pct)} % {'schneller' if pct > 0 else 'langsamer'}"


def collect(con) -> dict:
    users = [dict(r) for r in con.execute("SELECT * FROM users ORDER BY max_level DESC, play_ms ASC")]
    # Bestzeit, Versuche und Fehler (beim besten Lauf) je Spieler und Level
    best: dict[int, dict[int, dict]] = {}
    for r in con.execute(
        "SELECT user_id, level, MIN(ms) AS ms, COUNT(*) AS wins, "
        "(SELECT mistakes FROM results r2 WHERE r2.user_id = r.user_id AND r2.level = r.level ORDER BY ms LIMIT 1) AS mistakes "
        "FROM results r GROUP BY user_id, level"
    ):
        best.setdefault(r["level"], {})[r["user_id"]] = dict(r)

    for u in users:
        mine = [(lvl, d[u["id"]]) for lvl, d in best.items() if u["id"] in d]
        u["solved"] = len(mine)
        u["avg_ms"] = sum(m["ms"] for _, m in mine) / len(mine) if mine else None
        u["avg_mistakes"] = sum(m["mistakes"] for _, m in mine) / len(mine) if mine else None
        # Tempo: je Level eigene Bestzeit / Median der anderen, geometrisches Mittel
        ratios = []
        for lvl, m in mine:
            others = [o["ms"] for uid, o in best[lvl].items() if uid != u["id"]]
            if others:
                ratios.append(m["ms"] / median(others))
        u["speed"] = math.exp(sum(map(math.log, ratios)) / len(ratios)) if ratios else None
        u["compared"] = len(ratios)

    levels = sorted(best, reverse=True)
    return {"users": users, "best": best, "levels": levels}


def user_detail(con, data: dict, uid: int) -> list[dict]:
    rows = []
    for lvl in data["levels"]:
        entry = data["best"][lvl].get(uid)
        if not entry:
            continue
        times = sorted(o["ms"] for o in data["best"][lvl].values())
        others = [o["ms"] for u, o in data["best"][lvl].items() if u != uid]
        rows.append({
            "level": lvl,
            "ms": entry["ms"],
            "wins": entry["wins"],
            "mistakes": entry["mistakes"],
            "rank": times.index(entry["ms"]) + 1,
            "players": len(times),
            "vs": fmt_speed(entry["ms"] / median(others)) if others else "–",
        })
    return rows


def fmt_ago(ts: int | None, now: int | None = None) -> str:
    """Wann zuletzt aktiv, kurz: 'gerade', 'vor 5 min', 'vor 3 h', 'vor 2 Tagen'."""
    import time

    if not ts:
        return "–"
    d = max(0, int((now or time.time()) - ts))
    if d < 120:
        return "gerade aktiv"
    if d < 3600:
        return f"vor {d // 60} min"
    if d < 86400:
        return f"vor {d // 3600} h"
    days = d // 86400
    return "gestern" if days == 1 else f"vor {days} Tagen"


def speed_class(f: float | None) -> str:
    if f is None:
        return ""
    pct = round((1 - f) * 100)
    return "" if abs(pct) < 3 else ("fast" if pct > 0 else "slow")
