"""Levelgenerator fuer Arrows.

Jedes Level ist deterministisch aus seiner Nummer erzeugt (gleiche Nummer =
gleiches Level) und garantiert loesbar.

Regeln: Ein Pfeil ist eine Kette benachbarter Zellen. Die letzte Zelle ist der
Kopf, seine Richtung ergibt sich aus dem letzten Schritt. Tippt man einen Pfeil
an, gleitet er in Kopfrichtung aus dem Feld. Liegt auf dem Weg vom Kopf bis zum
Rand eine Zelle eines anderen Pfeils, ist er blockiert.

Loesbarkeit: Der Generator fuehrt eine gueltige Entfernungs-Reihenfolge mit.
Ein neuer Pfeil wird nur eingefuegt, wenn es in dieser Reihenfolge einen Platz
gibt, an dem alles weiter aufgeht. Entfernen macht nie etwas schwerer, daher
loest auch "immer irgendeinen freien Pfeil nehmen" jedes Level.
"""

from __future__ import annotations

import random

DIRS = {"up": (0, -1), "down": (0, 1), "left": (-1, 0), "right": (1, 0)}
STEPS = list(DIRS.values())


def _heart(u, v):
    x, y = u * 1.25, -v * 1.3 + 0.15
    return (x * x + y * y - 1) ** 3 - x * x * y ** 3 <= 0


# Formen in Koordinaten -1..1 (u nach rechts, v nach unten)
SHAPES = {
    "Herz": _heart,
    "Kreis": lambda u, v: u * u + v * v <= 1.0,
    "Ring": lambda u, v: 0.28 <= u * u + v * v <= 1.0,
    "Raute": lambda u, v: abs(u) + abs(v) <= 1.05,
    "Kreuz": lambda u, v: abs(u) <= 0.4 or abs(v) <= 0.4,
    "Dreieck": lambda u, v: abs(u) <= (v + 1) / 2 + 0.05,
    "Sanduhr": lambda u, v: abs(u) <= abs(v) + 0.2,
}
SHAPE_NAMES = list(SHAPES)


def shape_of(level: int) -> str | None:
    """Zwischendurch ein Level in Form (Herz, Kreis ...): ab Level 8, etwa jedes 4.-5. Level, nie zugleich grosses Feld."""
    if level < 8 or is_big(level):
        return None
    rng = random.Random(f"arrows-shape-{level}")
    if rng.random() >= 0.22:
        return None
    return rng.choice(SHAPE_NAMES)


def shape_cells(name: str, width: int, height: int) -> set:
    f = SHAPES[name]
    return {
        (x, y)
        for y in range(height)
        for x in range(width)
        if f((x + 0.5) / width * 2 - 1, (y + 0.5) / height * 2 - 1)
    }


def is_big(level: int) -> bool:
    """Ab und zu ein grosses Feld mit langen Pfeilen: ab Level 6 grob jedes 5.-9. Level."""
    if level < 6:
        return False
    return random.Random(f"arrows-big-{level // 7}").randrange(7) == level % 7


def level_params(level: int) -> dict:
    """Groesse und Schwierigkeit steigen mit dem Level, bis zu einer Obergrenze.

    Felder sind immer hochkant (hoeher als breit); quer drehen macht der Client.
    """
    n = max(1, level) - 1
    width = min(5 + n // 4, 14)
    height = min(6 + n // 3, 20)
    max_len = min(3 + n // 6, 12)
    min_len = 2
    big = is_big(level)
    if big:
        width = min(width + 5, 18)
        height = min(height + 8, 28)
        max_len = min(max(max_len * 3, 16), 36)
        min_len = max_len // 3
    shape = shape_of(level)
    if shape:
        # quadratisch und etwas groesser, weil die Ecken frei bleiben
        side = min(max(width, height) + 4, 22)
        width = height = side
        max_len = max(max_len, 6)
    return {"width": width, "height": height, "max_len": max_len, "min_len": min_len, "big": big, "shape": shape}


def _direction(a, b) -> str:
    dx, dy = b[0] - a[0], b[1] - a[1]
    for name, d in DIRS.items():
        if d == (dx, dy):
            return name
    raise ValueError("Zellen nicht benachbart")


def _ray(head, step, width, height):
    x, y = head
    dx, dy = step
    x, y = x + dx, y + dy
    while 0 <= x < width and 0 <= y < height:
        yield (x, y)
        x, y = x + dx, y + dy


def _ray_clear(path, occupied, width, height) -> bool:
    head = path[-1]
    step = (head[0] - path[-2][0], head[1] - path[-2][1])
    own = set(path)
    return all(c not in occupied and c not in own for c in _ray(head, step, width, height))


def _random_walk(rng, start, occupied, width, height, max_len, allowed):
    path = [start]
    seen = {start}
    straight_bias = rng.random() * 0.6
    last = None
    while len(path) < max_len:
        x, y = path[-1]
        options = []
        for s in STEPS:
            nx, ny = x + s[0], y + s[1]
            if (nx, ny) in allowed and (nx, ny) not in occupied and (nx, ny) not in seen:
                options.append(s)
        if not options:
            break
        if last in options and rng.random() < straight_bias:
            s = last
        else:
            s = rng.choice(options)
        cell = (x + s[0], y + s[1])
        path.append(cell)
        seen.add(cell)
        last = s
    return path


def _head_ray(path, width, height) -> set:
    head = path[-1]
    step = (head[0] - path[-2][0], head[1] - path[-2][1])
    return set(_ray(head, step, width, height))


def _try_insert(walk, order, rays, width, height, min_k=2):
    """Versucht den laengsten Anfang von walk in die Entfernungs-Reihenfolge einzufuegen.

    order: Pfade in Entfernungs-Reihenfolge, rays: deren Bahn zum Rand.
    Ein neuer Pfeil muss nach allen Pfeilen entfernt werden, deren Bahn er
    kreuzt, und vor allen Pfeilen, die auf seiner eigenen Bahn liegen.
    """
    for k in range(len(walk), min_k - 1, -1):
        path = walk[:k]
        cells = set(path)
        ray = _head_ray(path, width, height)
        if ray & cells:
            continue  # wuerde sich selbst blockieren
        last_before = -1  # muss nach diesen Pfeilen raus
        first_after = len(order)  # muss vor diesen Pfeilen raus
        for i, other in enumerate(order):
            if rays[i] & cells:
                last_before = i
            if first_after == len(order) and ray & set(other):
                first_after = i
        if last_before < first_after:
            pos = last_before + 1
            order.insert(pos, path)
            rays.insert(pos, ray)
            return path
    return None


def generate_level(level: int) -> dict:
    p = level_params(level)
    width, height, max_len, min_len = p["width"], p["height"], p["max_len"], p["min_len"]
    rng = random.Random(f"arrows-{level}")

    shape = p["shape"]
    if shape:
        allowed = shape_cells(shape, width, height)
        # leere Raender abschneiden
        x0, y0 = min(x for x, _ in allowed), min(y for _, y in allowed)
        allowed = {(x - x0, y - y0) for x, y in allowed}
        width, height = max(x for x, _ in allowed) + 1, max(y for _, y in allowed) + 1
    else:
        allowed = {(x, y) for y in range(height) for x in range(width)}
    occupied: set = set()
    order: list[list] = []
    rays: list[set] = []

    for rnd in range(6 if p["big"] else 4):
        # grosse Felder: erst nur lange Pfeile, danach Luecken mit kurzen fuellen
        need = max(2, min_len - rnd * (min_len // 3)) if p["big"] else 2
        free = sorted(allowed - occupied)
        rng.shuffle(free)
        for start in free:
            if start in occupied:
                continue
            for _ in range(5):
                walk = _random_walk(rng, start, occupied, width, height, rng.randint(need, max_len), allowed)
                placed = _try_insert(walk, order, rays, width, height, need) if len(walk) >= need else None
                if placed:
                    occupied.update(placed)
                    break

    arrows = list(order)
    # Reihenfolge mischen, damit die Loesung nicht aus der Liste ablesbar ist
    rng.shuffle(arrows)
    return {
        "level": level,
        "width": width,
        "height": height,
        "big": p["big"],
        "shape": shape,
        # Form als Zeilen: # = Feld, . = leer (nur bei Formen)
        "mask": ["".join("#" if (x, y) in allowed else "." for x in range(width)) for y in range(height)] if shape else None,
        "arrows": [
            {
                "id": i,
                "cells": [list(c) for c in path],
                "dir": _direction(path[-2], path[-1]),
            }
            for i, path in enumerate(arrows)
        ],
    }


def is_blocked(arrow_cells, others: set, width: int, height: int) -> bool:
    head = tuple(arrow_cells[-1])
    prev = tuple(arrow_cells[-2])
    step = (head[0] - prev[0], head[1] - prev[1])
    return any(c in others for c in _ray(head, step, width, height))


def solve(level_data: dict) -> list[int] | None:
    """Gierige Loesung: Entfernen macht nie etwas schwerer, also immer einen freien Pfeil nehmen."""
    w, h = level_data["width"], level_data["height"]
    remaining = {a["id"]: [tuple(c) for c in a["cells"]] for a in level_data["arrows"]}
    order = []
    while remaining:
        occ = {c for cells in remaining.values() for c in cells}
        for aid, cells in remaining.items():
            if not is_blocked(cells, occ - set(cells), w, h):
                order.append(aid)
                del remaining[aid]
                break
        else:
            return None
    return order
