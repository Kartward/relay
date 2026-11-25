'use strict';
// Caches exactly two resources: the app and its manifest.
// Everything else (ntfy, OpenAI, other origins) passes straight through untouched.
const CACHE = 'voice-relay-v1';
const SCOPE = self.registration.scope;
const INDEX = new URL('./', SCOPE).href;
const MANIFEST = new URL('manifest.webmanifest', SCOPE).href;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => Promise.all([INDEX, MANIFEST].map((u) => fetchClean(u).then((r) => cache.put(u, r)))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  const bare = url.origin + url.pathname;
  const isNav = req.mode === 'navigate' || bare === INDEX || bare === INDEX.replace(/\/$/, '/index.html');
  if (isNav) { event.respondWith(networkFirst(INDEX, event)); return; }
  if (bare === MANIFEST) event.respondWith(cacheFirst(MANIFEST, event));
});

// Some static hosts redirect /index.html → /. A redirected response cannot answer
// a navigation, so store a fresh, non-redirected copy of the body.
async function fetchClean(url) {
  const r = await fetch(url, { cache: 'no-cache' });
  if (!r.ok) throw new Error('HTTP ' + r.status + ' for ' + url);
  if (!r.redirected) return r;
  return new Response(await r.blob(), { status: r.status, statusText: r.statusText, headers: r.headers });
}

// Navigations go to the network first, so a new deploy is visible on the next load
// rather than the one after. Cache is only the offline fallback.
async function networkFirst(key, event) {
  const cache = await caches.open(CACHE);
  try {
    const fresh = await fetchClean(key);
    await cache.put(key, fresh.clone());
    return fresh;
  } catch {
    const cached = await cache.match(key);
    if (cached) return cached;
    return new Response('Offline and not cached yet.', {
      status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' }
    });
  }
}

async function cacheFirst(key, event) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(key);
  if (cached) return cached;
  try {
    const fresh = await fetchClean(key);
    await cache.put(key, fresh.clone());
    return fresh;
  } catch {
    return new Response('', { status: 504 });
  }
}
