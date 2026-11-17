/* Service Worker: App laeuft offline, Netz wird nur genutzt wenn noetig.
   Bei Aenderungen an HTML/CSS/JS die VERSION hochzaehlen. */
const VERSION = "arrows-v4";
const LEVELS = "arrows-levels-g4"; // hochzaehlen, wenn sich der Levelgenerator aendert
const MAX_LEVELS = 60; // so viele Level bleiben auf dem Geraet
const SHELL = ["/", "/static/app.js", "/static/style.css", "/static/icon.svg", "/manifest.webmanifest", "/icon-192.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
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

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;

  // Level sind fest (gleiche Nummer = gleiches Level): einmal holen, fuer immer behalten
  if (url.pathname.startsWith("/api/level/")) {
    e.respondWith(
      caches.open(LEVELS).then(async (cache) => {
        const hit = await cache.match(e.request);
        if (hit) return hit;
        const res = await fetch(e.request);
        if (res.ok) {
          await cache.put(e.request, res.clone());
          trimLevels(cache);
        }
        return res;
      })
    );
    return;
  }

  // App-Huelle: aus dem Cache, Netz nur als Rueckfall
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || fetch(e.request))
  );
});
