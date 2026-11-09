// Offline: die App-Hülle aus dem Speicher, die Daten immer frisch versuchen (die letzten liegen ohnehin auf dem Gerät).
const V = "studium-v8";
const SHELL = ["./", "index.html", "app.css", "app.js", "eye.js", "verstehen.js", "manifest.webmanifest", "icon-192.png", "icon-512.png"];
self.addEventListener("install", (e) => e.waitUntil(caches.open(V).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())));
self.addEventListener("activate", (e) => e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== V).map((k) => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener("fetch", (e) => {
  const u = new URL(e.request.url);
  if (u.origin !== location.origin) return;
  if (u.pathname.endsWith("data.enc")) return; // nie aus dem Speicher
  // Immer beim Server nachfragen (GitHub hält sonst bis zu 10 Min. alte Dateien), ohne Netz aus dem Speicher
  e.respondWith(
    fetch(e.request, { cache: "no-cache" })
      .then((r) => {
        // Die Kopie sofort ziehen: später ist der Körper schon an die Seite gegangen und lässt sich nicht mehr kopieren
        if (r.ok) { const copy = r.clone(); e.waitUntil(caches.open(V).then((c) => c.put(e.request, copy)).catch(() => {})); }
        return r;
      })
      // Ohne Netz: aus dem Speicher. Die Startseite als Ersatz nur für Seitenaufrufe, nie für Daten (sonst käme HTML
      // statt eines Codes oder Stands an und die Meldung wäre unverständlich)
      .catch(() => caches.match(e.request).then((r) => r || (e.request.mode === "navigate" ? caches.match("index.html") : Response.error()))),
  );
});
