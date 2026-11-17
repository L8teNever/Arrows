"""PNG-Icons fuer die PWA, in reinem Python gezeichnet (keine Bild-Bibliothek noetig).

Motiv wie static/icon.svg: weisser abgeknickter Pfeil auf Lila.
"""

from __future__ import annotations

import math
import struct
import zlib

BG = (0x65, 0x55, 0x8F)
FG = (0xFF, 0xFF, 0xFF)


def _seg_dist(px, py, ax, ay, bx, by):
    dx, dy = bx - ax, by - ay
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))


def _tri_sdf(px, py, pts):
    """Vorzeichenbehafteter Abstand zum Dreieck (negativ = innen)."""
    d = min(_seg_dist(px, py, *pts[i], *pts[(i + 1) % 3]) for i in range(3))
    inside = True
    for i in range(3):
        (ax, ay), (bx, by) = pts[i], pts[(i + 1) % 3]
        if (bx - ax) * (py - ay) - (by - ay) * (px - ax) < 0:
            inside = False
    return -d if inside else d


def _png(size: int, pixels: bytes) -> bytes:
    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    raw = b"".join(b"\x00" + pixels[y * size * 4:(y + 1) * size * 4] for y in range(size))
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))


def render_icon(size: int, maskable: bool = False) -> bytes:
    s = size / 100.0
    # Maskable: Vollflaeche, Motiv in die sichere Mitte (80 %) schrumpfen
    k = 0.72 if maskable else 1.0
    tr = lambda x, y: ((50 + (x - 50) * k) * s, (50 + (y - 50) * k) * s)  # noqa: E731
    line = [tr(28, 72), tr(28, 44), tr(58, 44)]
    tri = [tr(56, 30), tr(76, 44), tr(56, 58)]
    half = 5 * s * k
    radius = 0 if maskable else 24 * s
    out = bytearray(size * size * 4)
    for y in range(size):
        py = y + 0.5
        for x in range(size):
            px = x + 0.5
            # Hintergrund: abgerundetes Quadrat
            if radius:
                qx = max(abs(px - size / 2) - (size / 2 - radius), 0)
                qy = max(abs(py - size / 2) - (size / 2 - radius), 0)
                bg_a = max(0.0, min(1.0, radius - math.hypot(qx, qy) + 0.5))
            else:
                bg_a = 1.0
            d_line = min(_seg_dist(px, py, *line[0], *line[1]), _seg_dist(px, py, *line[1], *line[2])) - half
            d_tri = _tri_sdf(px, py, tri) - 2 * s * k
            fg = max(0.0, min(1.0, 0.5 - min(d_line, d_tri)))
            i = (y * size + x) * 4
            for c in range(3):
                out[i + c] = round(BG[c] * (1 - fg) + FG[c] * fg)
            out[i + 3] = round(255 * max(bg_a, fg * bg_a))
    return _png(size, bytes(out))


if __name__ == "__main__":
    # Einmalig ausfuehren: python icons.py  -> schreibt die PNGs nach static/
    for size, mask, name in [(192, False, "icon-192.png"), (512, False, "icon-512.png"), (512, True, "icon-512-maskable.png")]:
        with open(f"static/{name}", "wb") as f:
            f.write(render_icon(size, mask))
