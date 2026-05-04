// VEX Scout Service Worker — v3
// Uses NETWORK-FIRST strategy for HTML so updates appear immediately.
// Falls back to cache only when offline.

const CACHE_NAME = 'vex-scout-v3';
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
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Don't cache API/proxy requests — always go to network
  if (url.pathname.startsWith('/api/')) {
    return; // let browser handle normally
  }

  // For HTML / navigation requests: NETWORK-FIRST (always try fresh)
  // This means updates show up immediately, no stale UI
  if (event.request.mode === 'navigate' ||
      event.request.destination === 'document' ||
      url.pathname === '/' ||
      url.pathname === '/index.html') {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          // Cache for offline fallback
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) =>
              cache.put(event.request, copy)
            );
          }
          return response;
        })
        .catch(() => caches.match(event.request).then((cached) =>
          cached || caches.match('/index.html')
        ))
    );
    return;
  }

  // For static assets (icons, manifest): cache-first is fine
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((response) => {
        if (response.ok && event.request.method === 'GET') {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) =>
            cache.put(event.request, copy)
          );
        }
        return response;
      });
    })
  );
});

// Listen for messages from the page (e.g. force update)
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
