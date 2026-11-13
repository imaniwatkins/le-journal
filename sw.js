const VERSION = "wtj-v4";
const SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./manifest.webmanifest",
  "./sw.js",
  "./js/app.js",
  "./js/charts.js",
  "./js/format.js",
  "./js/le_review.js",
  "./js/merge.js",
  "./vendor/lightweight-charts.standalone.production.js",
  "./config/le_criteria.json",
  "./data/index.json",
  "./data/sync_status.json",
  "./data/market_calendar.json",
  "./data/meta.json",
  "./data/overrides/edits.json",
  "./data/derived/book.json",
  "./data/days/2026-11-12.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(VERSION).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== VERSION).map((key) => caches.delete(key)))).then(() => self.clients.claim()),
  );
});

async function networkFirst(request) {
  const cache = await caches.open(VERSION);
  try {
    const fresh = await fetch(request);
    if (fresh && fresh.ok && request.method === "GET") cache.put(request, fresh.clone());
    return fresh;
  } catch (err) {
    const cached = await cache.match(request);
    if (cached) return cached;
    if (request.mode === "navigate") {
      const home = await cache.match("./index.html");
      if (home) return home;
    }
    throw err;
  }
}

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || event.request.method !== "GET") return;
  event.respondWith(networkFirst(event.request));
});
