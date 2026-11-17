/* Service Worker: App laeuft offline, Netz wird nur genutzt wenn noetig.
   Die Versionen setzt der Server automatisch aus dem Inhalt der Dateien (app.py: BUILD, GEN).
   Aendert sich etwas, ist diese Datei anders, der Browser installiert sie und alte Caches fliegen raus. */
const BUILD = "__BUILD__";
const VERSION = `arrows-${BUILD}`;
const LEVELS = "arrows-levels-__GEN__"; // neue Level-Logik = neuer Cache
const MAX_LEVELS = 60; // so viele Level bleiben auf dem Geraet
const SHELL = [
  "/", `/static/app.js?v=${BUILD}`, `/static/style.css?v=${BUILD}`,
  "/static/icon.svg", "/manifest.webmanifest", "/icon-192.png",
];
const NAV_TIMEOUT = 3500; // so lange wartet die App beim Start aufs Netz, dann nimmt sie die gespeicherte

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(VERSION)
      .then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: "no-cache" }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION && k !== LEVELS).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

async function trimLevels(cache) {
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - MAX_LEVELS; i++) await cache.delete(keys[i]);
}

function timeout(ms) {
  return new Promise((_, reject) => setTimeout(reject, ms));
}

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;

  // Level sind fest (gleiche Nummer = gleiches Level): einmal holen, fuer diese Generator-Version behalten
  if (url.pathname.startsWith("/api/level/")) {
    const key = url.origin + url.pathname; // ohne ?g=, die Version steckt im Cache-Namen
    e.respondWith(
      caches.open(LEVELS).then(async (cache) => {
        const hit = await cache.match(key);
        if (hit) return hit;
        const res = await fetch(key, { cache: "no-cache" }); // nie ein altes Level aus dem Browser-Cache
        if (res.ok) {
          await cache.put(key, res.clone());
          trimLevels(cache);
        }
        return res;
      })
    );
    return;
  }

  // Konten und Statistik immer frisch vom Server
  if (url.pathname.startsWith("/api/") || url.pathname === "/dashboard" || url.pathname.endsWith("/dashboard")) return;

  // Seite (/, /Simon usw.): erst kurz beim Server fragen (meist nur ein winziges 304), offline die gespeicherte.
  // So kommt eine neue Version sofort an, und ist der Zero-Trust-Login abgelaufen, leitet Cloudflare
  // ganz normal zur Anmeldung weiter statt eine alte Seite aus dem Cache zu zeigen.
  if (e.request.mode === "navigate") {
    e.respondWith((async () => {
      try {
        const res = await Promise.race([fetch(e.request), timeout(NAV_TIMEOUT)]);
        if (res.ok && res.type === "basic" && (res.headers.get("Content-Type") || "").includes("text/html")) {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put("/", copy));
        }
        return res;
      } catch {
        return (await caches.match("/")) || Response.error();
      }
    })());
    return;
  }

  // App-Dateien: aus dem Cache (die Adresse enthaelt die Version), Netz nur als Rueckfall
  e.respondWith(
    caches.match(e.request).then((hit) => hit || fetch(e.request).then((res) => {
      if (res.ok && url.searchParams.get("v") === BUILD) {
        const copy = res.clone();
        caches.open(VERSION).then((c) => c.put(e.request, copy));
      }
      return res;
    }))
  );
});
