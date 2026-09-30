/* GenGIS service worker: offline app shell + cached map tiles */
const VERSION = 'map-builder-v10'; // app 0.0.1-Beta, airport frequencies
const OFFLINE_CACHE = 'map-builder-offline'; // filled by the app's "Download area" feature; never trimmed or versioned
const SHELL_CACHE = VERSION + '-shell';
const TILE_CACHE = VERSION + '-tiles';
const MAX_TILES = 4000;

const SHELL = [
  './', './index.html', './manifest.webmanifest',
  './css/app.css',
  './js/util.js', './js/tooltipdelay.js', './js/store.js', './js/features.js', './js/tools.js', './js/geometry.js', './js/search.js', './js/storage.js',
  './js/scale.js', './js/settings.js', './js/contextmenu.js', './js/presenter.js', './js/datalayers.js', './js/frequencies.js', './js/offline.js', './js/ui.js', './js/app.js',
  './vendor/leaflet/leaflet.js', './vendor/leaflet/leaflet.css',
  './vendor/leaflet/images/marker-icon.png', './vendor/leaflet/images/marker-icon-2x.png', './vendor/leaflet/images/marker-shadow.png',
  './vendor/leaflet/images/layers.png', './vendor/leaflet/images/layers-2x.png',
  './vendor/geoman/leaflet-geoman.min.js', './vendor/geoman/leaflet-geoman.css',
  './icons/icon.svg', './icons/logo.svg', './icons/logo-on-dark.svg', './icons/favicon.ico', './icons/favicon-32.png',
  './icons/icon-192.png', './icons/icon-512.png', './icons/icon-192-maskable.png', './icons/icon-512-maskable.png',
  './icons/apple-touch-icon.png', './icons/splash-wordmark.png'
];

const TILE_HOSTS = /(^|\.)(tile\.openstreetmap\.org|tile\.openstreetmap\.fr|opentopomap\.org|basemaps\.cartocdn\.com|arcgisonline\.com|tile-cyclosm\.openstreetmap\.fr)$/;

self.addEventListener('install', e => {
  e.waitUntil(caches.open(SHELL_CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== SHELL_CACHE && k !== TILE_CACHE && k !== OFFLINE_CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

let putCount = 0;
async function trimTiles() {
  const cache = await caches.open(TILE_CACHE);
  const keys = await cache.keys();
  if (keys.length > MAX_TILES) {
    const remove = keys.slice(0, keys.length - MAX_TILES);
    await Promise.all(remove.map(k => cache.delete(k)));
  }
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.origin === location.origin) {
    // App shell: network first (so updates show up immediately), cache as offline fallback.
    e.respondWith(
      fetch(req).then(res => {
        if (res && res.ok) caches.open(SHELL_CACHE).then(c => c.put(req, res.clone()));
        return res;
      }).catch(() => caches.match(req).then(c => c || caches.match('./index.html')))
    );
    return;
  }

  if (url.origin !== location.origin && /\.(png|jpe?g|webp|pbf)(\?|$)/i.test(url.pathname + url.search) || TILE_HOSTS.test(url.hostname) || /\/tile\/|\/tiles\/|\/wms/i.test(url.pathname)) {
    // Tiles: offline areas first (deliberately downloaded), then network first, then the rolling tile cache.
    e.respondWith(
      caches.open(OFFLINE_CACHE).then(c => c.match(req.url)).then(hit => hit || fetch(req).then(res => {
        if (res && (res.ok || res.type === 'opaque')) {
          caches.open(TILE_CACHE).then(c => c.put(req, res.clone()));
          if (++putCount % 100 === 0) trimTiles();
        }
        return res;
      }).catch(() => caches.match(req, { cacheName: TILE_CACHE }).then(c => c || new Response('', { status: 504, statusText: 'offline' }))))
    );
    return;
  }
  // Everything else (geocoder, Overpass): network only.
});
