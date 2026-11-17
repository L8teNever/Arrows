import gzip
from functools import lru_cache

from flask import Flask, Response, abort, jsonify, request, send_from_directory

from generator import generate_level

MAX_LEVEL = 1_000_000

app = Flask(__name__, static_folder="static", static_url_path="/static")


@lru_cache(maxsize=512)
def cached_level(n: int) -> dict:
    return generate_level(n)


@app.get("/")
def index():
    return send_from_directory(app.static_folder, "index.html")


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
