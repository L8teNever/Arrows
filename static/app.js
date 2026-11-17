"use strict";

const C = 40;               // Zellgroesse in SVG-Einheiten
const LIVES = 3;
const SPEED = 22;           // Zellen pro Sekunde beim Rausfliegen
const DIRS = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
const SVGNS = "http://www.w3.org/2000/svg";
const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;
const GEN = document.documentElement.dataset.gen || "0"; // Generator-Version vom Server, umgeht alte Level
let updateReady = false; // neue Version da, wird beim naechsten Levelwechsel eingespielt
const levelUrl = (n) => `/api/level/${n}?g=${GEN}`;

const $ = (id) => document.getElementById(id);
const board = $("board");

/* ---------- Konto ---------- */
// /Simon = Simons Konto (wird beim ersten Mal angelegt). Ohne Namen: als Gast, nur auf diesem Geraet.
// Konto kommt nur aus dem Zero-Trust-Login (Mail), siehe accessLogin()
["arrows.player", "arrows.guest"].forEach((k) => localStorage.removeItem(k)); // Reste vom alten /Name-Login
document.cookie = "arrows_player=; path=/; max-age=0";
let player = null;
const key = (k) => (player ? `arrows.u.${player.toLowerCase()}.${k}` : `arrows.${k}`);

const store = {
  get level() { return +localStorage.getItem(key("level")) || 1; },
  set level(v) { localStorage.setItem(key("level"), v); },
  get max() { return +localStorage.getItem(key("max")) || 1; },
  set max(v) { localStorage.setItem(key("max"), Math.max(v, this.max)); },
  get theme() { return localStorage.getItem("arrows.theme"); },
  set theme(v) { v === "system" ? localStorage.removeItem("arrows.theme") : localStorage.setItem("arrows.theme", v); },
  get vibrate() { return localStorage.getItem("arrows.vibrate") !== "0"; },
  set vibrate(v) { localStorage.setItem("arrows.vibrate", v ? "1" : "0"); },
};

let state = null;

/* ---------- Theme ---------- */
function applyTheme() {
  const t = store.theme || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  document.documentElement.classList.toggle("dark", t === "dark");
  const sel = store.theme || "system";
  for (const b of $("set-theme").children) b.setAttribute("aria-checked", b.dataset.v === sel);
  document.querySelector('meta[name="theme-color"]:not([media])')?.remove();
  const m = document.createElement("meta");
  m.name = "theme-color";
  m.content = t === "dark" ? "#141218" : "#fef7ff";
  document.head.appendChild(m);
}
$("set-theme").onclick = (e) => {
  const v = e.target.closest("button")?.dataset.v;
  if (!v) return;
  store.theme = v;
  applyTheme();
};
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", applyTheme);

/* ---------- Hilfen ---------- */
function snackbar(text) {
  const s = $("snackbar");
  s.textContent = text;
  s.classList.add("show");
  clearTimeout(s._t);
  s._t = setTimeout(() => s.classList.remove("show"), 2200);
}
function vibrate(ms) { if (store.vibrate) navigator.vibrate?.(ms); }
const center = ([x, y]) => [(x + 0.5) * C, (y + 0.5) * C];

/* ---------- Server-Abgleich (sparsam) ----------
   Gesendet wird nur: ein Ergebnis beim Schaffen eines Levels, das Level beim Wechseln und die
   Spielzeit beim Verlassen der App. Ohne Netz bleiben Ergebnisse im Postausgang und gehen spaeter raus. */
const api = (path) => `/api/me${path}`;
let serverLevel = null;  // Level, das der Server kennt (spart doppelte Meldungen)
let playUnsent = +localStorage.getItem(key("playUnsent")) || 0; // Spielzeit seit der letzten Meldung (ms)

const outbox = {
  get() { try { return JSON.parse(localStorage.getItem("arrows.outbox")) || []; } catch { return []; } },
  set(v) { localStorage.setItem("arrows.outbox", JSON.stringify(v)); },
};
let flushing = false;
async function flushOutbox() {
  if (flushing || !navigator.onLine) return;
  flushing = true;
  try {
    let box = outbox.get();
    while (box.length) {
      const job = box[0];
      let res;
      try {
        res = await fetch(job.url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(job.body), keepalive: true });
      } catch { break; } // kein Netz: spaeter nochmal
      if (res.status >= 500 || res.status === 401 || res.status === 403) break; // Server weg oder Login abgelaufen: spaeter nochmal
      box = outbox.get().slice(1); // 2xx oder 4xx (ungueltig): raus aus dem Postausgang
      outbox.set(box);
    }
  } finally { flushing = false; }
}
addEventListener("online", flushOutbox);

function reportProgress(beacon) {
  if (!player || !state) return;
  const sent = Math.round(playUnsent);
  const body = JSON.stringify({ level: state.level, playMs: sent });
  if (beacon) {
    if (navigator.sendBeacon?.(api("/progress"), new Blob([body], { type: "application/json" }))) playUnsent -= sent;
  } else {
    fetch(api("/progress"), { method: "POST", headers: { "Content-Type": "application/json" }, body })
      .then((r) => { if (r.ok) { playUnsent -= sent; serverLevel = state.level; } })
      .catch(() => {});
  }
  localStorage.setItem(key("playUnsent"), Math.round(playUnsent));
}

/* ---------- Spielzeit: laeuft nur, solange die App sichtbar ist ---------- */
let segStart = null;
// Nach 10 s ohne Eingabe geht das Spiel in die Pause. Ein einziger Timer, der bei jeder Eingabe neu startet.
const IDLE_MS = 10000;
let idleTimer = 0;
function idleArm() {
  clearTimeout(idleTimer);
  if (segStart !== null) idleTimer = setTimeout(() => {
    if (segStart !== null && !document.querySelector("dialog[open]")) openPause(true);
  }, IDLE_MS);
}
addEventListener("pointerdown", idleArm, { passive: true });
addEventListener("keydown", idleArm);
function clockStart() {
  if (state && !state.over && segStart === null && document.visibilityState === "visible" && !$("dlg-pause").open) {
    segStart = performance.now();
    idleArm();
  }
}
function clockStop() {
  clearTimeout(idleTimer);
  if (segStart === null || !state) return;
  const d = performance.now() - segStart;
  segStart = null;
  state.activeMs += d;
  playUnsent += d;
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") { clockStop(); reportProgress(true); }
  else { clockStart(); flushOutbox(); }
});

/* ---------- Ausrichtung ---------- */
// Level kommen hochkant vom Server. Quer (Tablet, Handy gedreht) wird gespiegelt:
// x und y tauschen, Richtungen mit. Bleibt genauso loesbar.
const FLIP = { up: "left", left: "up", down: "right", right: "down" };
const wantWide = () => {
  const wrap = document.querySelector(".board-wrap");
  return wrap.clientWidth > wrap.clientHeight * 1.05;
};

function transpose() {
  [state.w, state.h] = [state.h, state.w];
  state.wide = !state.wide;
  state.grid = new Int32Array(state.w * state.h).fill(-1);
  for (const a of state.arrows.values()) {
    a.cells = a.cells.map(([x, y]) => [y, x]);
    a.dir = FLIP[a.dir];
    if (!a.removed) for (const [x, y] of a.cells) state.grid[y * state.w + x] = a.id;
  }
}

/* ---------- Level laden ---------- */
async function loadLevel(n) {
  n = Math.max(1, Math.floor(n) || 1);
  if (updateReady) { store.level = n; location.reload(); return; } // Update wartet: zwischen zwei Leveln einspielen
  let data;
  try {
    const res = await fetch(levelUrl(n));
    if (!res.ok) throw 0;
    data = await res.json();
  } catch {
    snackbar("Level konnte nicht geladen werden");
    return;
  }
  clockStop(); // Zeit des alten Versuchs verbuchen
  store.level = n;
  state = {
    level: n,
    w: data.width,
    h: data.height,
    arrows: new Map(data.arrows.map((a) => [a.id, { ...a, removed: false, busy: false }])),
    grid: new Int32Array(data.width * data.height).fill(-1), // Zelle -> Pfeil-ID
    left: data.arrows.length,
    lives: LIVES,
    mistakes: 0,
    activeMs: 0,
    over: false,
    wide: false,
    big: !!data.big,
    shape: data.shape || null,
    mask: data.mask || null, // Zeilen aus # (Feld) und . (leer), nur bei Formen
  };
  $("level-no").textContent = n;
  for (const a of state.arrows.values()) for (const [x, y] of a.cells) state.grid[y * data.width + x] = a.id;
  // Formen nicht drehen, ein Herz soll aufrecht bleiben
  if (!state.shape && wantWide()) transpose();
  setInfo();
  const special = state.big ? "Großes Feld" : state.shape;
  $("big-chip").hidden = !special;
  $("big-text").textContent = special || "";
  if (state.big) snackbar("Großes Feld – lange Pfeile!");
  else if (state.shape) snackbar(`Sonderform: ${state.shape}`);
  render();
  clockStart();
  if (player && serverLevel !== null && serverLevel !== n) reportProgress(false);
  prefetch(n + 1);
}

function setInfo() {
  $("level-info").textContent = `${player ? player + " · " : ""}${state.w} × ${state.h} · ${state.arrows.size} Pfeile`;
}

/** Naechstes Level einmalig im Leerlauf holen, landet im Service-Worker-Cache (offline spielbar). */
function prefetch(n) {
  const go = () => fetch(levelUrl(n)).catch(() => {});
  (window.requestIdleCallback || setTimeout)(go, { timeout: 3000 });
}

/* ---------- Zeichnen ---------- */
function render() {
  const { w, h } = state;
  board.setAttribute("viewBox", `${-C * 0.1} ${-C * 0.1} ${w * C + C * 0.2} ${h * C + C * 0.2}`);

  if (state.mask) {
    // Form: alle Punkte als ein einziger Pfad (runde Linienenden der Laenge 0 = Punkte)
    let d = "";
    state.mask.forEach((row, y) => {
      for (let x = 0; x < row.length; x++) if (row[x] === "#") d += `M${(x + 0.5) * C} ${(y + 0.5) * C}h0`;
    });
    board.innerHTML = `<path class="dots" d="${d}" stroke-width="${C * 0.12}"/>`;
  } else {
    // Rechteck: ein Muster statt hunderter Kreise, weniger DOM, weniger Zeichenarbeit
    board.innerHTML =
      `<defs><pattern id="dots" width="${C}" height="${C}" patternUnits="userSpaceOnUse">` +
      `<circle class="dot" cx="${C / 2}" cy="${C / 2}" r="${C * 0.06}"/></pattern></defs>` +
      `<rect width="${w * C}" height="${h * C}" fill="url(#dots)"/>`;
  }
  const frag = document.createDocumentFragment();

  for (const a of state.arrows.values()) {
    if (a.removed) continue;
    const g = document.createElementNS(SVGNS, "g");
    g.setAttribute("class", "arrow");
    g.dataset.id = a.id;
    const body = document.createElementNS(SVGNS, "polyline");
    body.setAttribute("class", "body");
    body.setAttribute("stroke-width", C * 0.26);
    g.appendChild(body);
    const head = document.createElementNS(SVGNS, "polygon");
    head.setAttribute("class", "head");
    g.appendChild(head);
    a.el = g;
    frag.appendChild(g);
    drawArrow(a, a.cells.map(center), DIRS[a.dir]);
  }
  board.appendChild(frag);
  updateHud();
  fitBoard();
}

function drawArrow(a, pts, [dx, dy]) {
  const [hx, hy] = pts[pts.length - 1];
  const tip = [hx + dx * C * 0.38, hy + dy * C * 0.38];
  const base = [hx - dx * C * 0.02, hy - dy * C * 0.02];
  const px = -dy, py = dx; // senkrecht
  const s = C * 0.3;
  const body = pts.map((p) => p.join(",")).join(" ");
  a.el.firstChild.setAttribute("points", body);
  a.el.lastChild.setAttribute(
    "points",
    `${tip.join(",")} ${base[0] + px * s},${base[1] + py * s} ${base[0] - px * s},${base[1] - py * s}`
  );
}

/* Tippen und langes Druecken. Getroffen wird ueber das Raster statt ueber Trefferflaechen im DOM,
   knapp daneben nimmt den naechsten Pfeil. Kurz tippen = Pfeil fliegt (beim Loslassen, egal ob der Finger
   etwas verrutscht). Lange druecken = Vorschau: Weg und Richtung, der Pfeil bleibt liegen. */
const LONG_PRESS = 350; // ms
const pt = board.createSVGPoint();
let press = null; // { id, pointerId, timer, preview }
const boardCard = document.querySelector(".board-card");
boardCard.addEventListener("pointerdown", (e) => {
  if (!state || state.over || !e.isPrimary || e.button > 0 || press) return;
  pt.x = e.clientX; pt.y = e.clientY;
  const p = pt.matrixTransform(board.getScreenCTM().inverse());
  const id = arrowAt(p.x / C, p.y / C);
  if (id < 0) return;
  e.preventDefault();
  try { boardCard.setPointerCapture(e.pointerId); } catch {}
  press = { id, pointerId: e.pointerId, preview: false };
  press.timer = setTimeout(() => {
    if (!press || press.id !== id) return;
    press.preview = true;
    showPreview(id);
  }, LONG_PRESS);
});
function pressEnd(e) {
  if (!press || e.pointerId !== press.pointerId) return;
  const { id, preview, timer } = press;
  clearTimeout(timer);
  press = null;
  if (preview) hidePreview();
  else tap(id);
}
boardCard.addEventListener("pointerup", pressEnd);
boardCard.addEventListener("pointercancel", pressEnd); // Browser hat die Geste uebernommen: kurzer Tipp zaehlt trotzdem
boardCard.addEventListener("contextmenu", (e) => e.preventDefault()); // kein Kontextmenue beim langen Druecken

/** Vorschau: Spur von der Pfeilspitze bis zum Rand bzw. bis zum Pfeil, der im Weg ist. */
function showPreview(id) {
  const a = state.arrows.get(id);
  if (!a || a.removed || a.busy) return;
  hidePreview();
  const [dx, dy] = DIRS[a.dir];
  const [hx, hy] = a.cells[a.cells.length - 1];
  const block = blockDistance(a);
  // freie Strecke in Zellen: bis vor das Hindernis, sonst bis knapp hinter den Rand
  let steps;
  if (block) steps = block.d - 1;
  else {
    steps = dx > 0 ? state.w - 1 - hx : dx < 0 ? hx : dy > 0 ? state.h - 1 - hy : hy;
    steps += 1;
  }
  const g = document.createElementNS(SVGNS, "g");
  g.setAttribute("class", "preview" + (block ? " blocked" : ""));
  // Band ueber die ganze Reihe bzw. Spalte, in die der Pfeil fliegt
  const lane = document.createElementNS(SVGNS, "rect");
  lane.setAttribute("class", "lane");
  const bw = C * 0.84, r = bw / 2;
  if (dx !== 0) {
    lane.setAttribute("x", 0); lane.setAttribute("width", state.w * C);
    lane.setAttribute("y", (hy + 0.5) * C - r); lane.setAttribute("height", bw);
  } else {
    lane.setAttribute("y", 0); lane.setAttribute("height", state.h * C);
    lane.setAttribute("x", (hx + 0.5) * C - r); lane.setAttribute("width", bw);
  }
  lane.setAttribute("rx", r);
  g.appendChild(lane);
  // gestrichelte Bahn ab der Spitze
  const [sx, sy] = center([hx, hy]);
  const reach = block ? steps + 0.45 : steps + 0.1;
  const ex = sx + dx * reach * C, ey = sy + dy * reach * C;
  const path = document.createElementNS(SVGNS, "line");
  path.setAttribute("class", "path");
  path.setAttribute("x1", sx + dx * C * 0.45); path.setAttribute("y1", sy + dy * C * 0.45);
  path.setAttribute("x2", ex); path.setAttribute("y2", ey);
  path.setAttribute("stroke-width", C * 0.12);
  path.setAttribute("stroke-dasharray", `${C * 0.22} ${C * 0.18}`);
  g.appendChild(path);
  const end = document.createElementNS(SVGNS, block ? "path" : "polygon");
  if (block) {
    // X am Hindernis
    const k = C * 0.18;
    end.setAttribute("d", `M${ex - k},${ey - k}L${ex + k},${ey + k}M${ex + k},${ey - k}L${ex - k},${ey + k}`);
    end.setAttribute("class", "end x");
    end.setAttribute("stroke-width", C * 0.12);
  } else {
    // Pfeilspitze draussen: hier fliegt er raus
    const px = -dy, py = dx, s = C * 0.26;
    const tip = [ex + dx * C * 0.34, ey + dy * C * 0.34];
    end.setAttribute("points", `${tip.join(",")} ${ex + px * s},${ey + py * s} ${ex - px * s},${ey - py * s}`);
    end.setAttribute("class", "end");
  }
  g.appendChild(end);
  board.insertBefore(g, board.querySelector(".arrow"));
  a.el.classList.add("focus");
  if (block) state.arrows.get(block.hit)?.el?.classList.add("in-way");
  vibrate(12);
}
function hidePreview() {
  board.querySelector(".preview")?.remove();
  board.querySelectorAll(".arrow.focus, .arrow.in-way").forEach((e) => e.classList.remove("focus", "in-way"));
}

/** Pfeil an Position (in Zellen); ist die Zelle leer, der naechste Pfeil im Umkreis von ~0.8 Zellen. */
function arrowAt(fx, fy) {
  const { grid, w, h } = state;
  const cx = Math.floor(fx), cy = Math.floor(fy);
  if (cx >= 0 && cy >= 0 && cx < w && cy < h && grid[cy * w + cx] >= 0) return grid[cy * w + cx];
  let best = -1, bestD = 0.8 * 0.8;
  for (let y = cy - 1; y <= cy + 1; y++)
    for (let x = cx - 1; x <= cx + 1; x++) {
      if (x < 0 || y < 0 || x >= w || y >= h || grid[y * w + x] < 0) continue;
      const dx = Math.max(x - fx, 0, fx - (x + 1)), dy = Math.max(y - fy, 0, fy - (y + 1)); // Abstand zum Kaestchen
      const d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = grid[y * w + x]; }
    }
  return best;
}

function fitBoard() {
  if (!state) return;
  const wrap = document.querySelector(".board-wrap");
  const card = wrap.firstElementChild;
  const ws = getComputedStyle(wrap), cs = getComputedStyle(card);
  const padW = parseFloat(ws.paddingLeft) * 2 + parseFloat(cs.paddingLeft) * 2;
  const padH = parseFloat(cs.paddingTop) * 2;
  const availW = wrap.clientWidth - padW;
  const availH = wrap.clientHeight - padH;
  const ratio = (state.w + 0.2) / (state.h + 0.2);
  let width = availW, height = availW / ratio;
  if (height > availH) { height = availH; width = availH * ratio; }
  board.style.width = `${Math.max(width, 100)}px`;
  board.style.height = `${Math.max(height, 100)}px`;
}
let fitQueued = false;
addEventListener("resize", () => {
  if (fitQueued) return;
  fitQueued = true;
  requestAnimationFrame(() => {
    fitQueued = false;
    if (!state) return;
    const busy = [...state.arrows.values()].some((a) => a.busy || (a.removed && a.el?.isConnected));
    if (!busy && !state.shape && wantWide() !== state.wide) {
      transpose();
      setInfo();
      render();
    } else fitBoard();
  });
});

function updateHud() {
  const hearts = $("hearts");
  if (!hearts.children.length)
    hearts.innerHTML = '<svg class="ic"><use href="#i-heart"/></svg>'.repeat(LIVES);
  [...hearts.children].forEach((s, i) => s.classList.toggle("lost", i >= state.lives));
  $("left").textContent = state.left;
}

/* ---------- Spiellogik ---------- */
/** Abstand (in Zellen) bis zum ersten Hindernis, oder null wenn frei. */
function blockDistance(a) {
  const { grid, w, h } = state;
  const [dx, dy] = DIRS[a.dir];
  let [x, y] = a.cells[a.cells.length - 1];
  for (let d = 1; ; d++) {
    x += dx; y += dy;
    if (x < 0 || y < 0 || x >= w || y >= h) return null;
    const hit = grid[y * w + x];
    if (hit >= 0 && hit !== a.id) return { d, hit };
  }
}

/** Weg des Pfeils: Koerper + Verlaengerung in Kopfrichtung (in Zellkoordinaten). */
function trackFor(a, extra) {
  const [dx, dy] = DIRS[a.dir];
  const track = a.cells.map((c) => [...c]);
  const [hx, hy] = a.cells[a.cells.length - 1];
  for (let i = 1; i <= extra; i++) track.push([hx + dx * i, hy + dy * i]);
  return track;
}

function slice(track, t, len) {
  const at = (s) => {
    const i = Math.min(Math.floor(s), track.length - 2);
    const f = s - i;
    const [ax, ay] = track[i], [bx, by] = track[i + 1];
    return [ax + (bx - ax) * f, ay + (by - ay) * f];
  };
  const pts = [at(t)];
  for (let i = Math.floor(t) + 1; i < t + len - 1; i++) pts.push(track[i]);
  pts.push(at(t + len - 1));
  return pts.map(center);
}

function animate(duration, step) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const frame = (now) => {
      const p = Math.min((now - t0) / duration, 1);
      step(p);
      if (p < 1) requestAnimationFrame(frame); else resolve();
    };
    requestAnimationFrame(frame);
  });
}

const easeIn = (p) => p * p;
const easeOutIn = (p) => (p < 0.5 ? 1 - (1 - 2 * p) ** 2 : 1 - (2 * p - 1) ** 2);

async function tap(id) {
  const a = state.arrows.get(id);
  if (!a || a.removed || a.busy || state.over) return;
  document.querySelectorAll(".arrow.hint").forEach((e) => e.classList.remove("hint"));
  const len = a.cells.length;
  const block = blockDistance(a);

  if (!block) {
    // raus damit
    a.removed = true;
    state.left--;
    for (const [x, y] of a.cells) state.grid[y * state.w + x] = -1;
    a.el.classList.add("moving");
    updateHud();
    const [hx, hy] = a.cells[len - 1];
    const toEdge = { up: hy + 1, down: state.h - hy, left: hx + 1, right: state.w - hx }[a.dir];
    const dist = toEdge + len + 1;
    const track = trackFor(a, dist);
    vibrate(10);
    await animate(REDUCED ? 120 : (dist / SPEED) * 1000, (p) => {
      drawArrow(a, slice(track, easeIn(p) * dist, len), DIRS[a.dir]);
      a.el.style.opacity = p > 0.7 ? 1 - (p - 0.7) / 0.3 : 1;
    });
    a.el.remove();
    checkWin();
    return;
  }

  // blockiert: anstossen und zurueck
  a.busy = true;
  a.el.classList.add("blocked");
  const other = state.arrows.get(block.hit);
  other?.el.classList.add("blocked");
  const travel = block.d - 1 + 0.35;
  const track = trackFor(a, block.d + 1);
  state.lives--;
  state.mistakes++;
  updateHud();
  vibrate([30, 40, 30]);
  await animate(180 + travel * 60, (p) => {
    drawArrow(a, slice(track, easeOutIn(p) * travel, len), DIRS[a.dir]);
  });
  drawArrow(a, a.cells.map(center), DIRS[a.dir]);
  setTimeout(() => {
    a.el.classList.remove("blocked");
    other?.el.classList.remove("blocked");
  }, 350);
  a.busy = false;

  if (state.lives <= 0) {
    clockStop();
    state.over = true;
    $("dlg-lose").showModal();
  } else {
    document.querySelector(".board-card").classList.add("shake");
    setTimeout(() => document.querySelector(".board-card").classList.remove("shake"), 400);
  }
}

function checkWin() {
  if (state.left > 0 || state.over) return;
  clockStop();
  state.over = true;
  store.max = state.level + 1;
  if (player) {
    // Ergebnis + bisher ungemeldete Spielzeit in einem Rutsch
    const sent = Math.round(playUnsent);
    outbox.set([...outbox.get(), { url: api("/result"), body: { level: state.level, ms: Math.round(state.activeMs), mistakes: state.mistakes, playMs: sent } }]);
    playUnsent -= sent;
    localStorage.setItem(key("playUnsent"), Math.round(playUnsent));
    serverLevel = state.level + 1;
    flushOutbox();
  }
  const secs = Math.round(state.activeMs / 1000);
  const time = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
  const err = state.mistakes === 0 ? "ohne Fehler" : `${state.mistakes} Fehler`;
  $("win-text").textContent = `Zeit ${time} · ${err}`;
  setTimeout(() => $("dlg-win").showModal(), 250);
}

function hint() {
  if (!state || state.over) return;
  const free = [...state.arrows.values()].find((a) => !a.removed && !a.busy && !blockDistance(a));
  if (!free) return;
  document.querySelectorAll(".arrow.hint").forEach((e) => e.classList.remove("hint"));
  free.el.classList.add("hint");
  setTimeout(() => free.el.classList.remove("hint"), 3000);
}

/* ---------- UI ---------- */
$("btn-hint").onclick = hint;
$("btn-restart").onclick = () => loadLevel(state.level);
$("win-next").onclick = () => { $("dlg-win").close(); loadLevel(state.level + 1); };
$("win-replay").onclick = () => { $("dlg-win").close(); loadLevel(state.level); };
$("lose-retry").onclick = () => { $("dlg-lose").close(); loadLevel(state.level); };

/* ---------- Pause: Uhr steht, solange das Menue offen ist ---------- */
function fmtTime(ms) {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
function openPause(auto = false) {
  clockStop();
  $("dlg-pause").showModal(); // erst oeffnen, dann zaehlt clockStart() nicht weiter
  const parts = auto === true ? ["Pausiert, weil 10 Sekunden nichts passiert ist."] : [];
  if (player) parts.push(`Konto: ${player}`);
  if (state) parts.push(`Level ${state.level} · ${fmtTime(state.activeMs)} gespielt`);
  $("pause-info").textContent = parts.join(" · ");
  $("pause-stats").href = player ? `/${encodeURIComponent(player)}/dashboard` : "/dashboard";
  $("set-vibrate").checked = store.vibrate;
}
$("btn-pause").onclick = openPause;
$("dlg-pause").addEventListener("close", () => clockStart());
$("pause-resume").onclick = () => $("dlg-pause").close();
$("pause-restart").onclick = () => { $("dlg-pause").close(); loadLevel(state.level); };
$("pause-levels").onclick = () => { $("dlg-pause").close(); openLevels(); };
$("set-vibrate").onchange = (e) => { store.vibrate = e.target.checked; if (store.vibrate) vibrate(15); };

/* ---------- Levelauswahl: Raster zum Antippen ---------- */
const LOCKED_PREVIEW = 3; // so viele gesperrte Level als Ausblick
let bestTimes = {};       // Bestzeit je Level (vom Server), fuer die kleinen Zeiten unter der Nummer

function fmtShort(ms) {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
function renderLevelGrid() {
  const grid = $("level-grid"), cur = state?.level || store.level, max = store.max;
  const frag = document.createDocumentFragment();
  for (let n = 1; n <= max + LOCKED_PREVIEW; n++) {
    const b = document.createElement("button");
    b.className = "lvl" + (n === cur ? " cur" : "") + (n > max ? " locked" : n === max ? " new" : " done");
    b.dataset.n = n;
    b.setAttribute("role", "listitem");
    const t = bestTimes[n];
    b.innerHTML = `<b>${n}</b><span>${n > max ? "🔒" : t ? fmtShort(t) : n === max ? "neu" : "✓"}</span>`;
    if (n > max) b.disabled = true;
    frag.appendChild(b);
  }
  grid.replaceChildren(frag);
}
function openLevels() {
  $("stats-link").href = player ? `/${encodeURIComponent(player)}/dashboard` : "/dashboard";
  $("player-line").textContent = `${player ? `Konto: ${player} · ` : "Nicht angemeldet · "}freigeschaltet bis Level ${store.max}`;
  renderLevelGrid();
  $("dlg-levels").showModal();
  $("level-grid").querySelector(".cur")?.scrollIntoView({ block: "center" });
  if (player && navigator.onLine) {
    fetch("/api/me/levels", { cache: "no-store" }).then((r) => r.ok && r.json()).then((d) => {
      if (!d || !$("dlg-levels").open) return;
      bestTimes = d.best;
      const y = $("level-grid").scrollTop;
      renderLevelGrid();
      $("level-grid").scrollTop = y;
    }).catch(() => {});
  }
}
$("level-grid").onclick = (e) => {
  const b = e.target.closest(".lvl");
  if (!b || b.disabled) return;
  $("dlg-levels").close();
  loadLevel(+b.dataset.n);
};
$("btn-levels").onclick = openLevels;
$("btn-levels2").onclick = openLevels;
$("levels-cancel").onclick = () => $("dlg-levels").close();

// Zero Trust: Cloudflare kennt die Mail, der Server macht daraus das Konto. Offline gilt das letzte bekannte.
async function accessLogin() {
  try {
    const res = await fetch("/api/me", { cache: "no-store" });
    const ct = res.headers.get("Content-Type") || "";
    if (res.ok && ct.includes("json")) {
      const u = await res.json();
      if (!u.access) { localStorage.removeItem("arrows.access"); return null; }
      localStorage.setItem("arrows.access", u.name);
      sessionStorage.removeItem("arrows.relogin");
      return u;
    }
  } catch {}
  // Online, aber keine Antwort: meist ist der Cloudflare-Login abgelaufen. Einmal neu laden,
  // dann leitet Cloudflare zur Anmeldung weiter (kein Cache- oder Cookie-Loeschen noetig).
  if (navigator.onLine && localStorage.getItem("arrows.access") && !sessionStorage.getItem("arrows.relogin")) {
    sessionStorage.setItem("arrows.relogin", "1");
    location.reload();
    return new Promise(() => {});
  }
  const last = localStorage.getItem("arrows.access");
  return last ? { name: last, offline: true } : null;
}

async function start() {
  applyTheme();
  if (location.pathname !== "/") history.replaceState(null, "", "/");
  const acc = await accessLogin();
  if (!acc) { loadLevel(store.level); return; } // ohne Login (nur lokal): Fortschritt bleibt auf dem Geraet
  player = acc.name;
  playUnsent = +localStorage.getItem(key("playUnsent")) || 0;
  document.title = `Arrows – ${player}`;
  let level = store.level;
  if (!acc.offline) {
    serverLevel = acc.level;
    // Server gilt, ausser dieses Geraet ist weiter (Ergebnisse noch im Postausgang)
    if (store.max <= acc.max) level = acc.level;
    store.max = acc.max;
  }
  loadLevel(level);
  flushOutbox();
}
start();

if ("serviceWorker" in navigator)
{
  // Neue Version aktiv: einmal neu laden, damit sie sofort gilt. Direkt nach dem Start sofort,
  // mitten im Spiel erst beim naechsten Level, damit kein Versuch verloren geht.
  const hadController = !!navigator.serviceWorker.controller;
  let reloaded = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!hadController || reloaded) return;
    if (performance.now() < 15000 || document.hidden) { reloaded = true; location.reload(); }
    else updateReady = true;
  });
  addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" }).then((reg) => {
      // Kommt die App aus dem Hintergrund zurueck, kurz nach Updates schauen (hoechstens alle 30 Min, ein 304)
      let checked = Date.now();
      document.addEventListener("visibilitychange", () => {
        if (document.hidden || Date.now() - checked < 30 * 60000) return;
        checked = Date.now();
        reg.update().catch(() => {});
      });
    }).catch(() => {});
  });
}
