/**
 * service-worker.js — オフライン完全対応 Service Worker
 */

'use strict';

const CACHE    = 'travel-area-map-v1';
const PRECACHE = [
  '/',
  '/index.html',
  '/styles.css',
  '/js/map.js',
  '/js/storage.js',
  '/js/photo.js',
  '/js/ui.js',
  '/js/utils.js',
  '/data/japan.topojson',
  '/data/regions.json',
  '/manifest.json',
  'https://unpkg.com/maplibre-gl@4.0.0/dist/maplibre-gl.css',
  'https://unpkg.com/maplibre-gl@4.0.0/dist/maplibre-gl.js',
  'https://unpkg.com/topojson-client@3/dist/topojson-client.min.js',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(k => k !== CACHE).map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;

  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;

      return fetch(e.request).then(res => {
        if (!res || res.status !== 200 || res.type === 'error') return res;

        const url = e.request.url;
        const shouldCache =
          url.includes('cyberjapandata.gsi.go.jp') ||
          url.includes('unpkg.com') ||
          url.startsWith(self.location.origin);

        if (shouldCache) {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }

        return res;
      }).catch(() => {
        if (e.request.destination === 'document') {
          return caches.match('/index.html');
        }
        return new Response('', { status: 503, statusText: 'Service Unavailable' });
      });
    })
  );
});
