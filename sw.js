// Offline: die App-Hülle aus dem Speicher, die Daten immer frisch versuchen (die letzten liegen ohnehin auf dem Gerät).
const V = "studium-v4";
const SHELL = ["./", "index.html", "app.css", "app.js", "eye.js", "manifest.webmanifest", "icon-192.png", "icon-512.png"];
self.addEventListener("install", (e) => e.waitUntil(caches.open(V).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())));
self.addEventListener("activate", (e) => e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== V).map((k) => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener("fetch", (e) => {
  const u = new URL(e.request.url);
  if (u.origin !== location.origin) return;
  if (u.pathname.endsWith("data.enc")) return; // nie aus dem Speicher
  // Immer beim Server nachfragen (GitHub hält sonst bis zu 10 Min. alte Dateien), ohne Netz aus dem Speicher
  e.respondWith(
    fetch(e.request, { cache: "no-cache" })
      .then((r) => (r.ok && caches.open(V).then((c) => c.put(e.request, r.clone())), r))
      .catch(() => caches.match(e.request).then((r) => r || caches.match("index.html"))),
  );
});
