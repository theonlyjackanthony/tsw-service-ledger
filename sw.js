"use strict";

// The build fingerprints all offline assets so a new timetable installs as one set.
const prefix = "tsw-ledger:" + self.registration.scope + ":";
const cacheName = prefix + "ddc5f8c8dd7339ce297b";
const files = ["index.html","data/ledger.enc","ledger-core.js","app.js","ledger.css","boot.js","manifest.webmanifest","icons/apple-touch-icon.png","icons/ledger-192.png","icons/ledger-512.png"];
const urls = new Set(files.map(file => new URL(file, self.registration.scope).href));
const entry = new URL("index.html", self.registration.scope).href;

self.addEventListener("install", event => {
  event.waitUntil((async () => {
    const cache = await caches.open(cacheName);
    await cache.addAll([...urls].map(url => new Request(url, {cache: "reload"})));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    const old = (await caches.keys()).filter(key => key.startsWith(prefix) && key !== cacheName);
    await Promise.all(old.map(key => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", event => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  // Navigation events can carry an unlock fragment. Cache keys use only the asset URL.
  url.hash = "";
  if (url.origin !== self.location.origin) return;
  const base = self.registration.scope;
  const key = request.mode === "navigate" && url.href === base ? entry : url.href;
  if (!urls.has(key)) return;
  event.respondWith((async () => {
    const cache = await caches.open(cacheName);
    return (await cache.match(key)) || fetch(request);
  })());
});
