'use strict';

const CACHE_NAME = 'sentinel-v3';

// Core assets to attempt precaching
const PRECACHE_ASSETS = [
  './',
  'index.html',
  'style.css',
  'script.js',
  'manifest.json',
  'offline.html',
  'favicon.ico',
  'icon-192.png',
  'icon-512.png',
  'assets/og-image.png',
  'assets/alarm.mp3',
  'database/offline-tips.json',
  'config/sources.json'
];

// Non-atomic precache: failure of one missing file does not break the service worker
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return Promise.allSettled(
        PRECACHE_ASSETS.map((url) =>
          fetch(url, { cache: 'no-cache' }).then((res) => {
            if (res.ok) return cache.put(url, res);
            throw new Error(`Failed to load ${url} (status ${res.status})`);
          })
        )
      );
    }).then(() => self.skipWaiting())
  );
});

// Purge old versions immediately and claim all open clients
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      );
    }).then(() => self.clients.claim())
  );
});

// Safe byte-range slicing for iOS Safari audio playback
async function createRangedResponse(request, cachedResponse) {
  const rangeHeader = request.headers.get('range');
  if (!rangeHeader) return cachedResponse;

  const match = /bytes=(\d+)-(\d*)/.exec(rangeHeader);
  if (!match) return cachedResponse;

  const buffer = await cachedResponse.arrayBuffer();
  const totalLength = buffer.byteLength;
  const start = parseInt(match[1], 10);
  const end = match[2] ? parseInt(match[2], 10) : totalLength - 1;

  if (start >= totalLength || end >= totalLength) {
    return new Response(null, {
      status: 416,
      headers: { 'Content-Range': `bytes */${totalLength}` }
    });
  }

  const sliced = buffer.slice(start, end + 1);
  return new Response(sliced, {
    status: 206,
    headers: {
      'Content-Type': cachedResponse.headers.get('Content-Type') || 'audio/mpeg',
      'Content-Range': `bytes ${start}-${end}/${totalLength}`,
      'Content-Length': String(end - start + 1),
      'Accept-Ranges': 'bytes'
    }
  });
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Only handle HTTP/HTTPS GET requests from our origin
  if (req.method !== 'GET' || url.origin !== location.origin) {
    return;
  }

  // Network-First for HTML navigation so you always see code updates
  if (req.mode === 'navigate' || req.headers.get('accept')?.includes('text/html')) {
    event.respondWith(
      fetch(req)
        .then((networkRes) => {
          if (networkRes.ok) {
            const clone = networkRes.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
          }
          return networkRes;
        })
        .catch(async () => {
          const cachedHtml = await caches.match(req, { ignoreSearch: true });
          if (cachedHtml) return cachedHtml;
          return caches.match('offline.html');
        })
    );
    return;
  }

  // Cache-First with fallback to network for static files and media
  event.respondWith(
    caches.match(req, { ignoreSearch: true }).then(async (cachedRes) => {
      if (cachedRes) {
        return req.headers.get('range')
          ? createRangedResponse(req, cachedRes)
          : cachedRes;
      }

      try {
        const netRes = await fetch(req);
        if (netRes.ok && !req.headers.get('range')) {
          const clone = netRes.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
        }
        return netRes;
      } catch (err) {
        return new Response('', { status: 504, statusText: 'Gateway Timeout' });
      }
    })
  );
});