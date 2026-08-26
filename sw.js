// VEX Scout Service Worker — v36
//
// Built on the v3 network-first design (updates always appear immediately),
// with three additions aimed at competition venues:
//
//   1. A TIMEOUT on the network-first fetch. v3 only fell back to cache when a
//      request actually failed — but bad venue wifi usually doesn't fail, it
//      hangs. Without a timeout the page waits indefinitely on a connection
//      that is technically "working". Now it waits a couple of seconds, then
//      shows the cached copy.
//
//   2. API responses cached as an offline fallback. v3 never cached them, so a
//      dropped connection meant errors everywhere. Still network-first, so on
//      any working connection the data is live.
//
//   3. Webfonts cached permanently — they never change, and re-fetching them
//      blocks text from rendering.
//
// Freshness policy is unchanged from v3: the network always wins when it
// answers. The cache is a safety net, never a shortcut.
//
// Bump CACHE_NAME whenever index.html changes.

const CACHE_NAME = 'vex-scout-v36';
const API_CACHE = 'vex-scout-v36-api';

// How long to wait for the network before showing the cached copy.
const HTML_TIMEOUT_MS = 2500;
const API_TIMEOUT_MS = 6000;

const APP_SHELL = [
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
  '/apple-touch-icon.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      cache.addAll(APP_SHELL).catch(() => {})
    )
  );
  // Activate this new SW immediately, replacing the old one
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k !== CACHE_NAME && k !== API_CACHE)
          .map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// Network first, but don't hang forever on a slow connection.
// Whatever the network eventually returns still refreshes the cache.
function networkFirstWithTimeout(request, cacheName, timeoutMs, fallbackKey) {
  let settled = false;

  const network = fetch(request).then((response) => {
    if (response && response.ok) {
      const copy = response.clone();
      caches.open(cacheName).then((cache) => cache.put(request, copy));
    }
    return response;
  });

  const cached = () =>
    caches.match(request)
      .then((hit) => hit || (fallbackKey ? caches.match(fallbackKey) : null))
      .then((hit) => {
        if (!hit) return null;
        // Tag it so the page can tell this didn't come from the network
        const headers = new Headers(hit.headers);
        headers.set('X-From-Cache', '1');
        return hit.blob().then((body) => new Response(body, {
          status: hit.status, statusText: hit.statusText, headers
        }));
      });

  const timeout = new Promise((resolve) => {
    setTimeout(() => {
      if (!settled) resolve(cached().then((hit) => hit || network));
    }, timeoutMs);
  });

  const live = network
    .then((response) => { settled = true; return response; })
    .catch(() => cached().then((hit) => hit || offlineResponse(request)));

  return Promise.race([live, timeout]);
}

function offlineResponse(request) {
  let isApi = false;
  try { isApi = new URL(request.url).pathname.startsWith('/api/'); } catch (e) {}
  if (isApi) {
    return new Response(
      JSON.stringify({ error: 'Offline and no cached copy of this request.' }),
      { status: 503, headers: { 'Content-Type': 'application/json' } }
    );
  }
  return new Response('Offline', { status: 503 });
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  let url;
  try { url = new URL(request.url); } catch (e) { return; }

  // API / proxy: network first, cached copy only if the network is slow or gone
  if (url.pathname.startsWith('/api/')) {
    // ...except the lookups that are legitimately slow. The stream scrape
    // races several relays and can take 20s; the 6s fallback below would hand
    // back a stale copy every time and make a fixed proxy look unchanged.
    // These are on-demand and useless when stale, so: network only.
    const q = url.search || '';
    if (/path=(?:streams|vimeo|diag|siblings|boxcast)/.test(decodeURIComponent(q))) {
      event.respondWith(fetch(request).catch(() => offlineResponse(request)));
      return;
    }
    event.respondWith(networkFirstWithTimeout(request, API_CACHE, API_TIMEOUT_MS));
    return;
  }

  // Webfonts: immutable, so cache first
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    event.respondWith(
      caches.match(request).then((cached) =>
        cached || fetch(request).then((response) => {
          if (response && (response.ok || response.type === 'opaque')) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          }
          return response;
        }).catch(() => cached)
      )
    );
    return;
  }

  // HTML / navigation: network first so updates show up immediately
  if (request.mode === 'navigate' ||
      request.destination === 'document' ||
      url.pathname === '/' ||
      url.pathname === '/index.html') {
    event.respondWith(
      networkFirstWithTimeout(request, CACHE_NAME, HTML_TIMEOUT_MS, '/index.html')
    );
    return;
  }

  // Static assets (icons, manifest): cache-first is fine
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        }
        return response;
      });
    })
  );
});

// Force-update message from the page.
// index.html sends { type: 'SKIP_WAITING' }; the bare string is accepted too.
self.addEventListener('message', (event) => {
  const d = event.data;
  if (d === 'SKIP_WAITING' || (d && d.type === 'SKIP_WAITING')) {
    self.skipWaiting();
  }
  // The debug page asks which cache is live. A page can be controlled by an
  // OLD worker long after a new sw.js is deployed, and that is invisible
  // otherwise — it looks exactly like a fix that didn't work.
  if (d && d.type === 'VERSION' && event.ports && event.ports[0]) {
    event.ports[0].postMessage({ cache: CACHE_NAME });
  }
});
