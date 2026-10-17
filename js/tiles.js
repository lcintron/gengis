/* GenGIS - base-map tile helpers: preload the next zoom level of the current view, so zooming in finds its tiles
 * in the browser's cache instead of starting from a blank grid.
 * Off unless switched on (Settings > Interface): preloading competes with the tiles on screen for the connection,
 * which made the map slower to fill than it saves. When on it is gentle: it starts only after the map has been
 * still for a while, stops as soon as it moves again, takes the centre of the view one level in, and a few at a
 * time. Never on volunteer-run servers (OpenStreetMap and friends), whose usage policies ask for no bulk loading.
 */
window.MB = window.MB || {};
(function (MB) {
  'use strict';

  const COMMUNITY = ['osm', 'hot', 'topo', 'cyclosm'];
  const MAX_TILES = 24;   // per preload round
  const CONCURRENCY = 2;
  const SETTLE = 1500;    // ms of stillness before a round starts

  MB.tilePrefetch = {
    timer: null, running: false, inflight: new Set(), lastKey: '', ctrl: null,

    init() {
      MB.map.on('moveend zoomend', () => this.schedule());
      MB.map.on('movestart zoomstart', () => this.cancel()); // the map moves again: the tiles it needs come first
      MB.on('basemap', () => { this.lastKey = ''; this.schedule(); });
      this.schedule();
    },

    // Only when switched on (an older 'auto' counts as off), and never on the community tile servers.
    enabled() {
      return !!(MB.settings && MB.settings.prefetchTiles === 'on') && !COMMUNITY.includes(MB.state.basemap);
    },

    schedule() {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.run(), SETTLE);
    },
    cancel() {
      clearTimeout(this.timer);
      if (this.ctrl) { this.ctrl.abort(); this.ctrl = null; }
      this.lastKey = ''; // the same view, once still again, is preloaded again (what was cut short)
    },

    async run() {
      if (!this.enabled() || this.running || !navigator.onLine) return;
      const layer = MB.baseLayer;
      if (!layer || !layer._url || !MB.offline || !MB.offline.tileUrls) return;
      const z = Math.round(MB.map.getZoom());
      const maxZ = layer.options.maxZoom || 19;
      const b = MB.map.getBounds().pad(-0.25); // the centre half of the view: where a zoom in lands
      const key = MB.state.basemap + '|' + z + '|' + b.toBBoxString();
      if (key === this.lastKey) return;
      this.lastKey = key;
      const urls = [];
      try {
        if (z + 1 <= maxZ) for (const u of MB.offline.tileUrls(layer, b, z + 1, z + 1)) { urls.push(u); if (urls.length >= MAX_TILES) break; }
      } catch (e) { return; }
      this.running = true;
      const ctrl = this.ctrl = new AbortController();
      let i = 0;
      const worker = async () => {
        while (i < urls.length && !ctrl.signal.aborted) {
          const url = urls[i++];
          if (this.inflight.has(url)) continue;
          this.inflight.add(url);
          try {
            // Low priority, into the browser's HTTP cache (the service worker keeps only tiles shown on the map).
            const res = await fetch(url, { mode: 'cors', priority: 'low', signal: AbortSignal.any ? AbortSignal.any([ctrl.signal, AbortSignal.timeout(20000)]) : ctrl.signal });
            if (res && res.body) await res.arrayBuffer();
          } catch (e) { /* ignore */ }
          this.inflight.delete(url);
        }
      };
      await Promise.all(Array.from({ length: CONCURRENCY }, worker));
      if (this.ctrl === ctrl) this.ctrl = null;
      this.running = false;
    }
  };
})(window.MB);
