/* GenGIS service worker: offline app shell + cached map tiles */
const VERSION = 'gengis-0.4.1'; // app version; bump via scripts/release.js
const OFFLINE_CACHE = 'map-builder-offline'; // filled by the app's "Download area" feature; never trimmed or versioned
const SHELL_CACHE = VERSION + '-shell';
const TILE_CACHE = 'map-builder-tiles'; // not versioned: cached tiles survive app updates
const STAMP_CACHE = 'map-builder-tile-stamps'; // when each tile was fetched (opaque responses expose no Date header)
const TILE_MAX_AGE = 7 * 24 * 3600 * 1000; // re-fetch a cached tile only after this long
const MAX_TILES = 6000;

const SHELL = [
  './', './index.html', './manifest.webmanifest',
  './css/app.css',
  './js/util.js', './js/tooltipdelay.js', './js/store.js', './js/features.js', './js/tools.js', './js/geometry.js', './js/search.js', './js/storage.js', './js/projectstore.js', './js/desktopfiles.js',
  './js/scale.js', './js/settings.js', './js/contextmenu.js', './js/presenter.js', './js/datalayers.js', './js/frequencies.js', './js/adsb.js', './js/locate.js', './js/project.js', './js/offline.js', './js/busy.js', './js/tiles.js', './js/ui.js', './js/app.js',
  './vendor/leaflet/leaflet.js', './vendor/leaflet/leaflet.css',
  './vendor/leaflet/images/marker-icon.png', './vendor/leaflet/images/marker-icon-2x.png', './vendor/leaflet/images/marker-shadow.png',
  './vendor/leaflet/images/layers.png', './vendor/leaflet/images/layers-2x.png',
  './vendor/geoman/leaflet-geoman.min.js', './vendor/geoman/leaflet-geoman.css',
  './icons/icon.svg', './icons/logo.svg', './icons/logo-on-dark.svg', './icons/favicon.ico', './icons/favicon-32.png',
  './icons/icon-192.png', './icons/icon-512.png', './icons/icon-192-maskable.png', './icons/icon-512-maskable.png',
  './icons/apple-touch-icon.png', './icons/splash-wordmark.png'
];

const TILE_HOSTS = /(^|\.)(tile\.openstreetmap\.org|tile\.openstreetmap\.fr|opentopomap\.org|basemaps\.cartocdn\.com|arcgisonline\.com|tile-cyclosm\.openstreetmap\.fr)$/;

// On a development host the shell is fetched from the network first so edits show up at once. Anywhere else the
// installed version's files come straight from its cache: start-up then never waits for the network, and a new
// release replaces them as a set when its service worker (a changed VERSION) installs.
const DEV = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(self.location.hostname);

self.addEventListener('install', e => {
  // 'reload' bypasses the HTTP cache: a new version must not be built from files the browser cached for the old one
  e.waitUntil(caches.open(SHELL_CACHE).then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

async function migrateOldTileCaches(keys) {
  // Earlier versions kept tiles in "<version>-tiles"; carry them over so an update never empties the cache.
  const dest = await caches.open(TILE_CACHE);
  const stamps = await caches.open(STAMP_CACHE);
  for (const k of keys.filter(k => /-tiles$/.test(k) && k !== TILE_CACHE)) {
    try {
      const old = await caches.open(k);
      const reqs = await old.keys();
      for (const req of reqs) {
        if (await dest.match(req.url)) continue;
        const res = await old.match(req);
        if (res) { await dest.put(req.url, res); await stamps.put(req.url, new Response(String(Date.now()))); }
      }
    } catch (err) { /* best effort */ }
    await caches.delete(k);
  }
}

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(async keys => {
      await migrateOldTileCaches(keys);
      const keep = [SHELL_CACHE, TILE_CACHE, OFFLINE_CACHE, STAMP_CACHE];
      await Promise.all(keys.filter(k => !keep.includes(k) && !/-tiles$/.test(k)).map(k => caches.delete(k)));
    }).then(() => self.clients.claim())
  );
});

let putCount = 0;
async function trimTiles() {
  const cache = await caches.open(TILE_CACHE);
  const keys = await cache.keys();
  if (keys.length > MAX_TILES) {
    const remove = keys.slice(0, keys.length - MAX_TILES);
    const stamps = await caches.open(STAMP_CACHE);
    await Promise.all(remove.map(k => Promise.all([cache.delete(k), stamps.delete(k.url)])));
  }
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.origin === location.origin) {
    const fromNetwork = () => fetch(req).then(res => {
      if (res && res.ok) caches.open(SHELL_CACHE).then(c => c.put(req, res.clone()));
      return res;
    });
    if (DEV) {
      // App shell, development: network first, cache as offline fallback.
      e.respondWith(fromNetwork().catch(() => caches.match(req).then(c => c || caches.match('./index.html'))));
    } else {
      // App shell, installed: this version's cache first; the network only for a file that is not part of the shell.
      // A page address may carry parameters (?q=, ?lat=...), which are not part of the cached entry.
      e.respondWith(caches.open(SHELL_CACHE)
        .then(c => c.match(req, { ignoreSearch: req.mode === 'navigate' }))
        .then(hit => hit || fromNetwork().catch(() => caches.match('./index.html'))));
    }
    return;
  }

  if (url.origin !== location.origin && /\.(png|jpe?g|webp|pbf)(\?|$)/i.test(url.pathname + url.search) || TILE_HOSTS.test(url.hostname) || /\/tile\/|\/tiles\/|\/wms/i.test(url.pathname)) {
    // Tiles: offline areas first (deliberately downloaded, never refetched), then the rolling tile cache served
    // immediately while a background fetch refreshes it (stale-while-revalidate), then the network.
    e.respondWith((async () => {
      const offline = await caches.open(OFFLINE_CACHE);
      const pinned = await offline.match(req.url);
      if (pinned) return pinned;
      const cache = await caches.open(TILE_CACHE);
      const cached = await cache.match(req);
      const refresh = () => fetch(req).then(res => {
        if (res && (res.ok || res.type === 'opaque')) {
          cache.put(req, res.clone());
          caches.open(STAMP_CACHE).then(c => c.put(req.url, new Response(String(Date.now()))));
          if (++putCount % 100 === 0) trimTiles();
        }
        return res;
      });
      if (cached) {
        // Serve from cache; go to the network only when the stored copy is older than TILE_MAX_AGE.
        const stamps = await caches.open(STAMP_CACHE);
        const st = await stamps.match(req.url);
        let fetchedAt = st ? +(await st.text()) : 0;
        if (!fetchedAt) { fetchedAt = Date.now(); e.waitUntil(stamps.put(req.url, new Response(String(fetchedAt)))); } // legacy entry: stamp it now
        if (Date.now() - fetchedAt > TILE_MAX_AGE) e.waitUntil(refresh().catch(() => {}));
        return cached;
      }
      try { return await refresh(); } catch (err) { return new Response('', { status: 504, statusText: 'offline' }); }
    })());
    return;
  }
  // Everything else (geocoder, Overpass): network only.
});
