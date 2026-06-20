// SIGNAL service worker — caches the app shell so the player works offline.
// User audio files are NEVER cached; they're read fresh from the local drive each time.

const CACHE = 'signal-shell-v1';
const SHELL = [
  './',
  './index.html',
  './app.js',
  './metadata.js',
  './wasm-bridge.js',
  './manifest.webmanifest',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Never intercept blob: or filesystem reads
  if (url.protocol === 'blob:' || url.protocol === 'file:') return;

  // App shell — cache-first
  if (SHELL.some(p => url.pathname.endsWith(p.replace('./','/')))) {
    e.respondWith(caches.match(req).then(r => r || fetch(req)));
    return;
  }

  // Everything else — network-first, fall back to cache
  e.respondWith(
    fetch(req).then(r => {
      const copy = r.clone();
      caches.open(CACHE).then(c => c.put(req, copy)).catch(()=>{});
      return r;
    }).catch(() => caches.match(req))
  );
});
