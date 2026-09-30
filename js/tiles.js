/* GenGIS - base-map tile helpers: preload the neighbouring zoom levels of the current view.
 * Zooming in or out then finds the tiles already in the browser / service-worker cache instead of
 * starting from a blank grid. Off by default on volunteer-run servers (OpenStreetMap and friends)
 * to respect their usage policies; on for keyed and custom providers.
 */
window.MB = window.MB || {};
(function (MB) {
  'use strict';

  const COMMUNITY = ['osm', 'hot', 'topo', 'cyclosm'];
  const MAX_TILES = 96;   // per preload round (one zoom level in is 4x the visible tiles)
  const CONCURRENCY = 4;

  MB.tilePrefetch = {
    timer: null, running: false, inflight: new Set(), lastKey: '',

    init() {
      MB.map.on('moveend zoomend', () => this.schedule());
      MB.on('basemap', () => { this.lastKey = ''; this.schedule(); });
      this.schedule();
    },

    // 'auto' (default): everything except the community tile servers; 'on' / 'off' force it.
    enabled() {
      const mode = (MB.settings && MB.settings.prefetchTiles) || 'auto';
      if (mode === 'off') return false;
      if (mode === 'on') return true;
      return !COMMUNITY.includes(MB.state.basemap);
    },

    schedule() {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.run(), 600);
    },

    async run() {
      if (!this.enabled() || this.running || !navigator.onLine) return;
      const layer = MB.baseLayer;
      if (!layer || !layer._url || !MB.offline || !MB.offline.tileUrls) return;
      const z = Math.round(MB.map.getZoom());
      const maxZ = layer.options.maxZoom || 19;
      const b = MB.map.getBounds();
      const key = MB.state.basemap + '|' + z + '|' + b.toBBoxString();
      if (key === this.lastKey) return;
      this.lastKey = key;
      const urls = [];
      try {
        if (z + 1 <= maxZ) for (const u of MB.offline.tileUrls(layer, b, z + 1, z + 1)) { urls.push(u); if (urls.length >= MAX_TILES) break; }
        if (z - 1 >= (layer.options.minZoom || 0) && urls.length < MAX_TILES) for (const u of MB.offline.tileUrls(layer, b, z - 1, z - 1)) { urls.push(u); if (urls.length >= MAX_TILES) break; }
      } catch (e) { return; }
      this.running = true;
      let i = 0;
      const worker = async () => {
        while (i < urls.length) {
          const url = urls[i++];
          if (this.inflight.has(url)) continue;
          this.inflight.add(url);
          try {
            // Low priority; the response goes into the HTTP cache and the service worker's tile cache.
            const res = await fetch(url, { mode: 'cors', priority: 'low', signal: AbortSignal.timeout(20000) });
            if (res && res.body) await res.arrayBuffer();
          } catch (e) { /* ignore */ }
          this.inflight.delete(url);
        }
      };
      await Promise.all(Array.from({ length: CONCURRENCY }, worker));
      this.running = false;
    }
  };
})(window.MB);
