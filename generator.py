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
    return {"width": width, "height": height, "max_len": max_len, "min_len": min_len, "big": big}


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


def _random_walk(rng, start, occupied, width, height, max_len):
    path = [start]
    seen = {start}
    straight_bias = rng.random() * 0.6
    last = None
    while len(path) < max_len:
        x, y = path[-1]
        options = []
        for s in STEPS:
            nx, ny = x + s[0], y + s[1]
            if 0 <= nx < width and 0 <= ny < height and (nx, ny) not in occupied and (nx, ny) not in seen:
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

    occupied: set = set()
    order: list[list] = []
    rays: list[set] = []

    for rnd in range(6 if p["big"] else 4):
        # grosse Felder: erst nur lange Pfeile, danach Luecken mit kurzen fuellen
        need = max(2, min_len - rnd * (min_len // 3)) if p["big"] else 2
        free = [(x, y) for y in range(height) for x in range(width) if (x, y) not in occupied]
        rng.shuffle(free)
        for start in free:
            if start in occupied:
                continue
            for _ in range(5):
                walk = _random_walk(rng, start, occupied, width, height, rng.randint(need, max_len))
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
