"use strict";

const C = 40;               // Zellgroesse in SVG-Einheiten
const LIVES = 3;
const SPEED = 22;           // Zellen pro Sekunde beim Rausfliegen
const DIRS = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
const SVGNS = "http://www.w3.org/2000/svg";
const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;
const GEN = 4; // Generator-Version, umgeht alte Level im Browser-Cache
const levelUrl = (n) => `/api/level/${n}?g=${GEN}`;

const $ = (id) => document.getElementById(id);
const board = $("board");

const store = {
  get level() { return +localStorage.getItem("arrows.level") || 1; },
  set level(v) { localStorage.setItem("arrows.level", v); },
  get max() { return +localStorage.getItem("arrows.max") || 1; },
  set max(v) { localStorage.setItem("arrows.max", Math.max(v, this.max)); },
  get theme() { return localStorage.getItem("arrows.theme"); },
  set theme(v) { localStorage.setItem("arrows.theme", v); },
};

let state = null;

/* ---------- Theme ---------- */
function applyTheme() {
  const t = store.theme || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  document.documentElement.classList.toggle("dark", t === "dark");
  $("btn-theme").querySelector("use").setAttribute("href", t === "dark" ? "#i-light" : "#i-dark");
  document.querySelector('meta[name="theme-color"]:not([media])')?.remove();
  const m = document.createElement("meta");
  m.name = "theme-color";
  m.content = t === "dark" ? "#141218" : "#fef7ff";
  document.head.appendChild(m);
}
$("btn-theme").onclick = () => {
  store.theme = document.documentElement.classList.contains("dark") ? "light" : "dark";
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
function vibrate(ms) { navigator.vibrate?.(ms); }
const center = ([x, y]) => [(x + 0.5) * C, (y + 0.5) * C];

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
  let data;
  try {
    const res = await fetch(levelUrl(n));
    if (!res.ok) throw 0;
    data = await res.json();
  } catch {
    snackbar("Level konnte nicht geladen werden");
    return;
  }
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
    started: performance.now(),
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
  $("level-info").textContent = `${state.w} × ${state.h} · ${data.arrows.length} Pfeile`;
  const special = state.big ? "Großes Feld" : state.shape;
  $("big-chip").hidden = !special;
  $("big-text").textContent = special || "";
  if (state.big) snackbar("Großes Feld – lange Pfeile!");
  else if (state.shape) snackbar(`Sonderform: ${state.shape}`);
  render();
  prefetch(n + 1);
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
    for (const cls of ["hit", "body"]) {
      const p = document.createElementNS(SVGNS, "polyline");
      p.setAttribute("class", cls);
      p.setAttribute("stroke-width", cls === "hit" ? C * 0.9 : C * 0.26);
      g.appendChild(p);
    }
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
  a.el.children[0].setAttribute("points", body);
  a.el.children[1].setAttribute("points", body);
  a.el.children[2].setAttribute(
    "points",
    `${tip.join(",")} ${base[0] + px * s},${base[1] + py * s} ${base[0] - px * s},${base[1] - py * s}`
  );
}

board.addEventListener("click", (e) => {
  const g = e.target.closest(".arrow");
  if (g) tap(+g.dataset.id);
});

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
      $("level-info").textContent = `${state.w} × ${state.h} · ${state.arrows.size} Pfeile`;
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
    state.over = true;
    $("dlg-lose").showModal();
  } else {
    document.querySelector(".board-card").classList.add("shake");
    setTimeout(() => document.querySelector(".board-card").classList.remove("shake"), 400);
  }
}

function checkWin() {
  if (state.left > 0 || state.over) return;
  state.over = true;
  store.max = state.level + 1;
  const secs = Math.round((performance.now() - state.started) / 1000);
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

function openLevels() {
  $("max-level").textContent = store.max;
  $("level-input").max = store.max;
  $("level-input").value = state?.level || 1;
  $("dlg-levels").showModal();
}
$("btn-levels").onclick = openLevels;
$("btn-levels2").onclick = openLevels;
$("levels-cancel").onclick = () => $("dlg-levels").close();
$("levels-go").onclick = () => {
  const n = +$("level-input").value;
  if (!n || n < 1 || n > store.max) { snackbar(`Wähle ein Level von 1 bis ${store.max}`); return; }
  $("dlg-levels").close();
  loadLevel(n);
};
$("level-input").addEventListener("keydown", (e) => { if (e.key === "Enter") $("levels-go").click(); });

applyTheme();
loadLevel(store.level);

if ("serviceWorker" in navigator)
{
  // Neue Version aktiv: einmal neu laden, damit sie sofort gilt (nicht erst beim uebernaechsten Start)
  const hadController = !!navigator.serviceWorker.controller;
  let reloaded = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!hadController || reloaded) return;
    reloaded = true;
    location.reload();
  });
  addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));
}
