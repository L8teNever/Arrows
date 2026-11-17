import gzip
from functools import lru_cache

from flask import Flask, Response, abort, jsonify, render_template, request, send_from_directory

import db
import stats
from generator import generate_level, level_params

MAX_LEVEL = 1_000_000

app = Flask(__name__, static_folder="static", static_url_path="/static")
app.jinja_env.filters["dauer"] = stats.fmt_ms
app.jinja_env.filters["tempo"] = stats.fmt_speed
db.init()


@lru_cache(maxsize=512)
def cached_level(n: int) -> dict:
    return generate_level(n)


@app.get("/")
def index():
    return send_from_directory(app.static_folder, "index.html")


@app.get("/<name>")
def player(name: str):
    """/Simon spielt mit Simons Konto, ein neuer Name legt beim ersten Laden ein Konto an."""
    if not db.valid_name(name):
        abort(404)
    return send_from_directory(app.static_folder, "index.html")


def _need_name(name: str):
    if not db.valid_name(name):
        abort(400, "Ungueltiger Name")


def _int(body: dict, key: str, default=None, lo=0, hi=10**9):
    try:
        v = int(body.get(key, default))
    except (TypeError, ValueError):
        if default is None:
            abort(400, f"{key} fehlt")
        return default
    return max(lo, min(v, hi))


@app.get("/api/u/<name>")
def user_get(name: str):
    _need_name(name)
    with db.connect() as con:
        return jsonify(db.user_json(db.get_or_create(con, name)))


@app.post("/api/u/<name>/progress")
def user_progress(name: str):
    """Aktuelles Level + Spielzeit seit der letzten Meldung (auch per sendBeacon)."""
    _need_name(name)
    body = request.get_json(force=True, silent=True) or {}
    level = body.get("level")
    with db.connect() as con:
        u = db.progress(con, name, _int(body, "level", 1, 1, MAX_LEVEL) if level is not None else None, _int(body, "playMs", 0))
        return jsonify(db.user_json(u))


@app.post("/api/u/<name>/result")
def user_result(name: str):
    _need_name(name)
    body = request.get_json(force=True, silent=True) or {}
    level = _int(body, "level", None, 1, MAX_LEVEL)
    ms = _int(body, "ms", None, 0, 24 * 3600_000)
    if ms < 300:
        abort(400, "Zu schnell")
    with db.connect() as con:
        try:
            u = db.add_result(con, name, level, ms, _int(body, "mistakes", 0, 0, 99), _int(body, "playMs", 0))
        except ValueError as e:
            abort(409, str(e))
        return jsonify(db.user_json(u))


@app.get("/dashboard")
def dashboard():
    with db.connect() as con:
        data = stats.collect(con)
        sel = request.args.get("u", "")
        detail = None
        if sel:
            user = next((u for u in data["users"] if u["name"].lower() == sel.lower()), None)
            if user:
                detail = {"user": user, "rows": stats.user_detail(con, data, user["id"])}
        lvl = request.args.get("level", type=int)
        ranking = None
        if lvl and lvl in data["best"]:
            names = {u["id"]: u["name"] for u in data["users"]}
            ranking = {
                "level": lvl,
                "params": level_params(lvl),
                "rows": sorted(
                    ({"name": names[uid], **e} for uid, e in data["best"][lvl].items()), key=lambda e: e["ms"]
                ),
            }
    resp = Response(render_template(
        "dashboard.html", data=data, detail=detail, ranking=ranking, recent=data["levels"][:30]
    ))
    resp.headers["Cache-Control"] = "no-store"
    return resp


@app.get("/manifest.webmanifest")
def manifest():
    return send_from_directory(app.static_folder, "manifest.webmanifest", mimetype="application/manifest+json")


@app.get("/sw.js")
def service_worker():
    resp = send_from_directory(app.static_folder, "sw.js", mimetype="text/javascript")
    resp.headers["Cache-Control"] = "no-cache"  # Browser soll Updates des Workers sofort sehen
    return resp


@app.get("/<any('icon-192.png', 'icon-512.png', 'icon-512-maskable.png'):name>")
def icon(name: str):
    # PNGs werden mit "python icons.py" erzeugt
    resp = send_from_directory(app.static_folder, name, mimetype="image/png")
    resp.headers["Cache-Control"] = "public, max-age=604800"
    return resp


@app.get("/api/level/<int:n>")
def level(n: int):
    if n < 1 or n > MAX_LEVEL:
        abort(404)
    resp = jsonify(cached_level(n))
    resp.headers["Cache-Control"] = "public, max-age=31536000, immutable"
    return resp


@app.get("/healthz")
def health():
    return {"ok": True}


@app.after_request
def compress(resp: Response):
    """Text gzippen: weniger Daten = Funkmodul am Handy kuerzer wach."""
    if (
        resp.status_code == 200
        and not resp.direct_passthrough
        and "gzip" in request.headers.get("Accept-Encoding", "")
        and (resp.mimetype or "").split("/")[0] in ("text", "application")
        and resp.mimetype != "application/octet-stream"
        and "Content-Encoding" not in resp.headers
    ):
        data = resp.get_data()
        if len(data) > 512:
            resp.set_data(gzip.compress(data, 6))
            resp.headers["Content-Encoding"] = "gzip"
            resp.headers.add("Vary", "Accept-Encoding")
    return resp


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8080, debug=True)
