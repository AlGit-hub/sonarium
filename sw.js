/* Sonarium · service worker
   - La página (index.html) se pide primero a la red (así siempre ves la versión nueva)
     y, si no hay internet, se abre la última copia guardada.
   - Los archivos del código (app.js, styles.css) también van red primero, para que nunca se mezclen versiones.
   - Iconos, manifest y tipografías se guardan para abrir rápido y sin conexión.
   - Firebase/Firestore y cualquier otra petición no se tocan. */
const VERSION = "sonarium-v5";
const FONT_HOSTS = ["fonts.googleapis.com", "fonts.gstatic.com"];

self.addEventListener("install", (e) => {
  // se guarda cada archivo por separado: si alguno falta, los demás igual quedan
  const files = ["./", "index.html", "styles.css?v=5", "app.js?v=5", "terminos.html", "manifest.webmanifest", "favicon-192.png", "apple-touch-icon.png"];
  e.waitUntil(
    caches.open(VERSION)
      .then((c) => Promise.allSettled(files.map((u) => fetch(new Request(u, { cache: "reload" })).then((r) => { if (r.ok) return c.put(u, r); }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // La página: red primero, copia guardada si no hay conexión
  if (req.mode === "navigate") {
    e.respondWith(
      fetch(req)
        .then((res) => { const copy = res.clone(); caches.open(VERSION).then((c) => c.put("./", copy)); return res; })
        .catch(() => caches.match("./").then((r) => r || caches.match(req)))
    );
    return;
  }

  // Código propio (js, css, html): red primero y, sin conexión, la última copia guardada
  const sameOrigin = url.origin === self.location.origin;
  if (sameOrigin && /\.(js|css|html)$/.test(url.pathname)) {
    e.respondWith(
      fetch(req)
        .then((res) => { if (res && res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); } return res; })
        .catch(() => caches.match(req))
    );
    return;
  }

  // Imágenes y tipografías: copia guardada al instante y se actualiza por detrás
  if (sameOrigin || FONT_HOSTS.includes(url.hostname)) {
    e.respondWith(
      caches.open(VERSION).then((cache) =>
        cache.match(req).then((hit) => {
          const net = fetch(req).then((res) => { if (res && (res.ok || res.type === "opaque")) cache.put(req, res.clone()); return res; }).catch(() => hit);
          return hit || net;
        })
      )
    );
  }
});
