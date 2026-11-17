import gzip
import hashlib
import os
from functools import lru_cache
from urllib.parse import quote

from flask import Flask, Response, abort, jsonify, redirect, render_template, request, send_from_directory

import db
import stats
from generator import generate_level, level_params

MAX_LEVEL = 1_000_000

app = Flask(__name__, static_folder="static", static_url_path="/static")
app.jinja_env.filters["dauer"] = stats.fmt_ms
app.jinja_env.filters["tempo"] = stats.fmt_speed
db.init()


# ---------- Login ueber Cloudflare Zero Trust ----------
# Liegt die Seite hinter Cloudflare Access, setzt Cloudflare die Mail des Angemeldeten in einen Header.
# Daraus wird automatisch das Konto. Mit ARROWS_ACCESS_TEAM (z. B. "kulbarts") und ARROWS_ACCESS_AUD
# (Application Audience Tag) wird zusaetzlich das signierte Token geprueft, damit niemand den Header faelschen kann.
ACCESS_TEAM = os.environ.get("ARROWS_ACCESS_TEAM", "").strip()
ACCESS_AUD = os.environ.get("ARROWS_ACCESS_AUD", "").strip()
_jwks = None


def access_email() -> str | None:
    if ACCESS_TEAM and ACCESS_AUD:
        token = request.headers.get("Cf-Access-Jwt-Assertion") or request.cookies.get("CF_Authorization")
        if not token:
            return None
        global _jwks
        import jwt  # nur noetig, wenn die Pruefung eingeschaltet ist

        if _jwks is None:
            _jwks = jwt.PyJWKClient(f"https://{ACCESS_TEAM}.cloudflareaccess.com/cdn-cgi/access/certs", cache_keys=True)
        try:
            key = _jwks.get_signing_key_from_jwt(token).key
            claims = jwt.decode(token, key, algorithms=["RS256"], audience=ACCESS_AUD)
        except Exception:
            return None
        email = claims.get("email")
    else:
        # ARROWS_DEV_EMAIL nur lokal zum Testen ohne Cloudflare
        email = request.headers.get("Cf-Access-Authenticated-User-Email") or os.environ.get("ARROWS_DEV_EMAIL")
    return email.strip().lower() if email and "@" in email else None


def access_user(con):
    email = access_email()
    return db.get_or_create_by_email(con, email) if email else None


# ---------- Versionen automatisch aus dem Inhalt ----------
# Aendert sich eine Datei, aendert sich die Version: der Service Worker im Browser merkt das von selbst,
# laedt die neue App und alte Caches fliegen raus. Niemand muss Cache oder Cookies loeschen.
_ROOT = os.path.dirname(os.path.abspath(__file__))


def _hash(*paths: str) -> str:
    h = hashlib.sha1()
    for p in paths:
        with open(os.path.join(_ROOT, p), "rb") as f:
            h.update(f.read())
    return h.hexdigest()[:10]


GEN = _hash("generator.py")  # neue Level-Logik = neuer Level-Cache
BUILD = _hash(*(f"static/{f}" for f in ("index.html", "app.js", "style.css", "sw.js", "icon.svg", "manifest.webmanifest")), "generator.py")


def _load_text(name: str) -> str:
    with open(os.path.join(_ROOT, "static", name), encoding="utf-8") as f:
        return f.read()


INDEX_HTML = (
    _load_text("index.html")
    .replace("<html lang=\"de\">", f"<html lang=\"de\" data-gen=\"{GEN}\">")
    .replace("/static/style.css\"", f"/static/style.css?v={BUILD}\"")
    .replace("/static/app.js\"", f"/static/app.js?v={BUILD}\"")
)
SW_JS = _load_text("sw.js").replace("__BUILD__", BUILD).replace("__GEN__", GEN)


def _cached_text(body: str, mimetype: str, etag: str) -> Response:
    """Immer beim Server nachfragen, unveraendert kommt nur ein kurzes 304 zurueck."""
    resp = Response(body, mimetype=mimetype)
    resp.set_etag(etag)
    resp.headers["Cache-Control"] = "no-cache"
    return resp.make_conditional(request)


@lru_cache(maxsize=512)
def cached_level(n: int) -> dict:
    return generate_level(n)


@app.get("/")
def index():
    return _cached_text(INDEX_HTML, "text/html", BUILD)


@app.get("/<name>")
def old_name_link(name: str):
    """Fruehere Links wie /Simon: das Konto kommt jetzt aus dem Zero-Trust-Login."""
    if not db.valid_name(name):
        abort(404)
    return redirect("/")


def _require_user(con):
    """Nur mit Zero-Trust-Login: das Konto gehoert zur Mail."""
    u = access_user(con)
    if not u:
        abort(401, "Nicht angemeldet")
    return u


@app.get("/api/me")
def me():
    """Wer ist ueber Zero Trust angemeldet? Ohne Login: access=false, das Spiel nutzt dann /Name."""
    with db.connect() as con:
        u = access_user(con)
        resp = jsonify({**db.user_json(u), "access": True} if u else {"access": False})
    resp.headers["Cache-Control"] = "no-store"
    return resp


def _int(body: dict, key: str, default=None, lo=0, hi=10**9):
    try:
        v = int(body.get(key, default))
    except (TypeError, ValueError):
        if default is None:
            abort(400, f"{key} fehlt")
        return default
    return max(lo, min(v, hi))


@app.post("/api/me/progress")
def user_progress():
    """Aktuelles Level + Spielzeit seit der letzten Meldung (auch per sendBeacon)."""
    body = request.get_json(force=True, silent=True) or {}
    level = body.get("level")
    with db.connect() as con:
        name = _require_user(con)["name"]
        u = db.progress(con, name, _int(body, "level", 1, 1, MAX_LEVEL) if level is not None else None, _int(body, "playMs", 0))
        return jsonify(db.user_json(u))


@app.post("/api/me/result")
def user_result():
    body = request.get_json(force=True, silent=True) or {}
    level = _int(body, "level", None, 1, MAX_LEVEL)
    ms = _int(body, "ms", None, 0, 24 * 3600_000)
    if ms < 300:
        abort(400, "Zu schnell")
    with db.connect() as con:
        name = _require_user(con)["name"]
        try:
            u = db.add_result(con, name, level, ms, _int(body, "mistakes", 0, 0, 99), _int(body, "playMs", 0))
        except ValueError as e:
            abort(409, str(e))
        return jsonify(db.user_json(u))


@app.get("/dashboard")
def dashboard_root():
    """Angemeldet: direkt zur eigenen Statistik, mit ?alle die Uebersicht."""
    me = _me_name()
    if me and "alle" not in request.args:
        return redirect(f"/{quote(me)}/dashboard" + (f"?{request.query_string.decode()}" if request.query_string else ""))
    return _dashboard(None)


@app.get("/<name>/dashboard")
def dashboard_user(name: str):
    if not db.valid_name(name):
        abort(404)
    return _dashboard(name)


def _me_name() -> str:
    """Eigenes Konto aus dem Zero-Trust-Login."""
    with db.connect() as con:
        u = access_user(con)
    return u["name"] if u else ""


def _dashboard(name: str | None):
    me = _me_name()
    with db.connect() as con:
        data = stats.collect(con)
        detail = None
        if name:
            user = next((u for u in data["users"] if u["name"].lower() == name.lower()), None)
            detail = {"user": user, "rows": stats.user_detail(con, data, user["id"]) if user else [], "name": name}
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
    base = f"/{quote(detail['user']['name'] if detail and detail['user'] else name)}/dashboard" if name else "/dashboard"
    resp = Response(render_template(
        "dashboard.html", data=data, detail=detail, ranking=ranking, recent=data["levels"][:30],
        base=base, me=me,
    ))
    resp.headers["Cache-Control"] = "no-store"
    return resp


@app.get("/manifest.webmanifest")
def manifest():
    return send_from_directory(app.static_folder, "manifest.webmanifest", mimetype="application/manifest+json")


@app.get("/sw.js")
def service_worker():
    return _cached_text(SW_JS, "text/javascript", BUILD)  # Browser sieht Updates des Workers sofort


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
    # Dauerhaft gespeichert wird im Service Worker (pro Generator-Version). Der Browser fragt hier nur
    # kurz nach (304), damit eine neue Level-Logik nie an einem alten Browser-Cache haengen bleibt.
    resp = jsonify(cached_level(n))
    resp.set_etag(f"{GEN}-{n}")
    resp.headers["Cache-Control"] = "no-cache"
    return resp.make_conditional(request)


@app.get("/healthz")
def health():
    return {"ok": True}


@app.after_request
def static_versions(resp: Response):
    """Dateien mit ?v=<Version> aendern sich nie: fuer immer cachen, neue Version = neue Adresse."""
    if request.path.startswith("/static/") and request.args.get("v") == BUILD and resp.status_code == 200:
        resp.headers["Cache-Control"] = "public, max-age=31536000, immutable"
    return resp


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
