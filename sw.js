// SIGNAL service worker — caches the app shell so the player works offline.
// User audio files are NEVER cached; they're read fresh from the local drive each time.

const CACHE = 'signal-shell-v5';
const SHELL = [
  './',
  './index.html',
  './style.css',
  './manifest.webmanifest',
  './js/main.js',
  './js/db.js',
  './js/engine.js',
  './js/metadata-core.js',
  './js/metadata-worker.js',
  './js/worker-pool.js',
  './js/virtual-list.js',
  './js/visualizers.js',
  './js/analysis.js',
  './js/wasm-bridge.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(SHELL).catch(() => {}))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.protocol === 'blob:' || url.protocol === 'file:') return;

  // Same-origin only
  if (url.origin !== self.location.origin) return;

  e.respondWith(
    caches.match(req).then(cached => {
      if (cached) return cached;
      return fetch(req).then(r => {
        if (r.ok) {
          const copy = r.clone();
          caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
        }
        return r;
      }).catch(() => caches.match('./index.html'));
    })
  );
});
