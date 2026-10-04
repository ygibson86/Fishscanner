const CACHE_NAME = 'fishscanner-shell-v4';

const SHELL_FILES = [
  '/',
  '/style.css',
  '/app.js',
  '/manifest.json?v=2',
  '/favicon.ico',
  '/icons/icon-192.png?v=2',
  '/icons/icon-512.png?v=2',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Never intercept API calls, websocket upgrades, or uploaded fish/background
  // images - those must always hit the live server.
  if (
    url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/ws/') ||
    url.pathname.startsWith('/fish_storage/')
  ) {
    return;
  }

  // App shell: cache-first, falling back to network, and refreshing the cache
  // in the background so the next load picks up server-side updates.
  event.respondWith(
    caches.match(event.request).then((cached) => {
      const networkFetch = fetch(event.request)
        .then((response) => {
          if (response && response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => cached);
      return cached || networkFetch;
    })
  );
});
