/* GenGIS - offline areas: pre-download base-map tiles (and optionally data layers) for a region.
 * Tiles go into the Cache Storage cache "map-builder-offline" which the service worker checks first and never trims.
 */
window.MB = window.MB || {};
(function (MB) {
  'use strict';

  const esc = MB.escapeHtml;
  const KEY = 'gengis.offline', OLD_KEY = 'map-builder.offline.v1';
  const CACHE = 'map-builder-offline';
  const COMMUNITY = { osm: 3000, hot: 3000, topo: 3000, cyclosm: 3000 }; // per-download caps for volunteer-run tile servers
  const MAX_TILES = 60000;
  const KB_PER_TILE = { esriSat: 40, default: 22 };

  MB.offline = {
    areas: [], job: null,

    init() {
      try { this.areas = JSON.parse(MB.storedItem(KEY, OLD_KEY) || '[]'); } catch (e) { this.areas = []; }
      if (!Array.isArray(this.areas)) this.areas = [];
    },
    save() { localStorage.setItem(KEY, JSON.stringify(this.areas)); MB.emit('offline'); },

    supported() { return !!(window.caches && location.protocol.startsWith('http')); },

    /* ----- tile math ----- */
    tileRange(bounds, z) {
      const n = Math.pow(2, z);
      const lng2x = lng => Math.floor((lng + 180) / 360 * n);
      const lat2y = lat => { const r = lat * Math.PI / 180; return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n); };
      const clamp = v => Math.max(0, Math.min(n - 1, v));
      return { z, x0: clamp(lng2x(bounds.getWest())), x1: clamp(lng2x(bounds.getEast())), y0: clamp(lat2y(bounds.getNorth())), y1: clamp(lat2y(bounds.getSouth())) };
    },
    countTiles(bounds, zMin, zMax) {
      let n = 0;
      for (let z = zMin; z <= zMax; z++) { const r = this.tileRange(bounds, z); n += (r.x1 - r.x0 + 1) * (r.y1 - r.y0 + 1); }
      return n;
    },

    // URL exactly as Leaflet will request it at runtime for the given base layer.
    tileUrl(layer, x, y, z) {
      if (layer instanceof L.TileLayer.WMS) return layer.getTileUrl({ x, y, z });
      const o = layer.options;
      // as Leaflet 1.9.4's _getZoomForUrl: reversed first, then offset
      const zz = (o.zoomReverse ? o.maxZoom - z : z) + (o.zoomOffset || 0);
      const data = {
        // as Leaflet 1.9.4's getTileUrl: "@2x" on any high-density screen, whatever detectRetina says (the map
        // requests those tiles there, so offline areas and prefetching must fetch the same ones)
        r: L.Browser.retina ? '@2x' : '',
        s: layer._getSubdomain({ x, y }), x, y, z: zz
      };
      if (layer._map && !layer._map.options.crs.infinite) { const inv = layer._globalTileRange.max.y - y; if (o.tms) data.y = inv; data['-y'] = inv; }
      return L.Util.template(layer._url, L.extend(data, o));
    },

    *tileUrls(layer, bounds, zMin, zMax) {
      for (let z = zMin; z <= zMax; z++) {
        const r = this.tileRange(bounds, z);
        for (let x = r.x0; x <= r.x1; x++) for (let y = r.y0; y <= r.y1; y++) yield this.tileUrl(layer, x, y, z);
      }
    },

    estimateMB(tiles, basemapKey) { return tiles * (KB_PER_TILE[basemapKey] || KB_PER_TILE.default) / 1024; },

    capFor(basemapKey) { return COMMUNITY[basemapKey] || MAX_TILES; },

    /* ----- download ----- */
    async download(opts, onProgress) {
      if (this.job) throw new Error('A download is already running');
      const layer = MB.baseLayer;
      const bounds = L.latLngBounds(opts.bounds);
      const urls = Array.from(this.tileUrls(layer, bounds, opts.zMin, opts.zMax));
      const job = { cancelled: false, done: 0, failed: 0, bytes: 0, total: urls.length, ctrl: new AbortController() };
      this.job = job;
      const cache = await caches.open(CACHE);
      try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) { /* ignore */ }
      let i = 0;
      const worker = async () => {
        while (i < urls.length && !job.cancelled) {
          const url = urls[i++];
          try {
            const hit = await cache.match(url);
            if (hit) { job.done++; job.bytes += +(hit.headers.get('content-length') || 0); }
            else {
              const res = await fetch(url, { mode: 'cors', signal: job.ctrl.signal });
              if (!res.ok) throw new Error('HTTP ' + res.status);
              const buf = await res.arrayBuffer();
              job.bytes += buf.byteLength;
              const stored = new Response(buf, { headers: { 'Content-Type': res.headers.get('content-type') || 'image/png', 'Content-Length': String(buf.byteLength), 'X-MB-Offline': '1' } });
              await cache.put(url, stored);
              job.done++;
            }
          } catch (e) { if (job.cancelled) break; job.failed++; }
          if (onProgress) onProgress(job);
        }
      };
      const workers = [];
      for (let w = 0; w < 6; w++) workers.push(worker());
      await Promise.all(workers);
      // data layers
      job.dataCells = 0;
      if (opts.includeData && !job.cancelled) {
        for (const ds of MB.data.catalog()) {
          if (!ds.enabled || job.cancelled) continue;
          const seen = new Set();
          for (let z = opts.zMin; z <= opts.zMax; z++) {
            if (z < ds.def.minZoom) continue;
            const level = MB.data.levelFor(ds.def, z);
            if (seen.has(level.idx)) continue;
            seen.add(level.idx);
            if (level.whole) { await MB.data.loadCell(ds, { key: 'all', bounds: L.latLngBounds([-90, -180], [90, 180]) }, level); job.dataCells++; continue; }
            const cells = MB.data.cellsFor(bounds, level.cellSize).slice(0, 200);
            for (const cell of cells) { if (job.cancelled) break; await MB.data.loadCell(ds, cell, level); job.dataCells++; if (onProgress) onProgress(job); }
          }
        }
      }
      this.job = null;
      if (job.cancelled) { return job; }
      const area = {
        id: opts.id || MB.uid(), name: opts.name || 'Area ' + (this.areas.length + 1), bounds: [[bounds.getSouth(), bounds.getWest()], [bounds.getNorth(), bounds.getEast()]],
        zMin: opts.zMin, zMax: opts.zMax, basemap: MB.state.basemap, basemapName: currentBasemapName(), tiles: job.done, failed: job.failed, bytes: job.bytes,
        dataCells: job.dataCells, created: Date.now()
      };
      this.areas = this.areas.filter(a => a.id !== area.id).concat([area]);
      this.save();
      return job;
    },

    cancel() { if (this.job) { this.job.cancelled = true; this.job.ctrl.abort(); } },

    async remove(id) {
      const area = this.areas.find(a => a.id === id);
      if (!area) return;
      this.areas = this.areas.filter(a => a.id !== id);
      this.save();
      // Delete its tiles unless another area with the same base map still covers them.
      const cache = await caches.open(CACHE);
      const layer = MB.buildBaseLayer(area.basemap);
      if (!layer) return;
      layer._map = MB.map; layer._globalTileRange = MB.baseLayer._globalTileRange; // enough for URL templating
      const others = this.areas.filter(a => a.basemap === area.basemap);
      const bounds = L.latLngBounds(area.bounds);
      for (let z = area.zMin; z <= area.zMax; z++) {
        const r = this.tileRange(bounds, z);
        for (let x = r.x0; x <= r.x1; x++) for (let y = r.y0; y <= r.y1; y++) {
          const covered = others.some(o => z >= o.zMin && z <= o.zMax && (() => { const rr = this.tileRange(L.latLngBounds(o.bounds), z); return x >= rr.x0 && x <= rr.x1 && y >= rr.y0 && y <= rr.y1; })());
          if (!covered) { try { await cache.delete(this.tileUrl(layer, x, y, z)); } catch (e) { /* provider needs a live map for URL templating; leave the tile */ } }
        }
      }
      MB.emit('offline');
    },

    async stats() {
      const out = { tiles: 0, bytes: null };
      try { const c = await caches.open(CACHE); out.tiles = (await c.keys()).length; } catch (e) { /* ignore */ }
      try { if (navigator.storage && navigator.storage.estimate) { const e = await navigator.storage.estimate(); out.bytes = e.usage; out.quota = e.quota; } } catch (e) { /* ignore */ }
      return out;
    },

    /* ----- UI ----- */
    renderSection() {
      const box = document.getElementById('offlineSection');
      if (!box) return;
      if (!this.supported()) { box.innerHTML = '<p class="note">Offline areas need the app to be served over http(s) (not opened as a file).</p>'; return; }
      const list = this.areas.slice().sort((a, b) => b.created - a.created);
      box.innerHTML = `<div class="btn-row" style="margin:0 0 8px"><button class="btn small primary" data-act="new">Download current view…</button></div>
        ${list.length ? list.map(a => `<div class="area-item" data-id="${a.id}">
          <div class="area-head"><span class="aname">${esc(a.name)}</span><span class="badge">${esc(a.basemapName || a.basemap)}</span></div>
          <div class="note">zoom ${a.zMin}–${a.zMax} · ${a.tiles.toLocaleString()} tiles · ${(a.bytes / 1048576).toFixed(1)} MB${a.dataCells ? ' · ' + a.dataCells + ' data cells' : ''}${a.failed ? ' · <span class="warn">' + a.failed + ' failed</span>' : ''} · ${new Date(a.created).toLocaleDateString()}</div>
          <div class="btn-row" style="margin-top:6px"><button class="btn small" data-act="goto">Go to</button><button class="btn small" data-act="refresh">Re-download</button><button class="btn small danger" data-act="delete">Delete</button></div>
        </div>`).join('') : '<p class="note">Map tiles for a region, usable offline.</p>'}
        <div id="offlineStats" class="note" style="margin-top:6px"></div>`;
      box.querySelector('[data-act="new"]').addEventListener('click', () => this.openDialog());
      box.querySelectorAll('.area-item').forEach(item => {
        const a = this.areas.find(x => x.id === item.dataset.id);
        item.addEventListener('click', async e => {
          const act = e.target.dataset && e.target.dataset.act;
          if (act === 'goto') MB.map.fitBounds(a.bounds);
          else if (act === 'delete') { if (confirm('Delete offline area "' + a.name + '" and its cached tiles?')) { await this.remove(a.id); MB.toast('Offline area deleted'); } }
          else if (act === 'refresh') { if (MB.state.basemap !== a.basemap) MB.setBasemap(a.basemap); MB.map.fitBounds(a.bounds); setTimeout(() => this.openDialog(a), 400); }
        });
      });
      this.stats().then(st => { const el = document.getElementById('offlineStats'); if (el) el.textContent = `Offline tile cache: ${st.tiles.toLocaleString()} tiles` + (st.bytes ? ` · app storage ${(st.bytes / 1048576).toFixed(0)} MB` + (st.quota ? ` of ~${(st.quota / 1073741824).toFixed(1)} GB available` : '') : ''); });
    },

    openDialog(existing) {
      const bounds = MB.map.getBounds();
      const bm = MB.state.basemap, cap = this.capFor(bm);
      const community = !!COMMUNITY[bm];
      const zNow = Math.round(MB.map.getZoom());
      const maxZ = (MB.baseLayer && MB.baseLayer.options.maxZoom) || 19;
      const anyData = MB.data.catalog().some(ds => ds.enabled);
      const el = document.createElement('div');
      el.className = 'modal';
      el.innerHTML = `<div class="modal-box">
        <div class="panel-head"><h2 style="margin:0">Download area for offline use</h2><button class="icon-btn" data-act="close" title="Close">✕</button></div>
        <p class="note">Current view, <b>${esc(currentBasemapName())}</b>.${community ? ' Volunteer-run server: capped at ' + cap.toLocaleString() + ' tiles; use a keyed provider for large areas.' : ''}</p>
        <div class="row"><label>Name</label><input type="text" id="oaName" value="${esc(existing ? existing.name : 'Area ' + (this.areas.length + 1))}"></div>
        <div class="row"><label>Min zoom</label><input type="range" id="oaMin" min="${Math.max(2, zNow - 6)}" max="${maxZ}" value="${existing ? existing.zMin : Math.max(2, zNow - 2)}"><span class="val" id="oaMinVal"></span></div>
        <div class="row"><label>Max zoom</label><input type="range" id="oaMax" min="${Math.max(2, zNow - 6)}" max="${maxZ}" value="${existing ? existing.zMax : Math.min(maxZ, zNow + 3)}"><span class="val" id="oaMaxVal"></span></div>
        ${anyData ? '<label class="check"><input type="checkbox" id="oaData" checked> Include enabled data layers</label>' : ''}
        <div class="measure-box" id="oaEstimate"></div>
        <div id="oaProgress" class="hidden"><div class="progress"><div class="bar" id="oaBar"></div></div><div class="note" id="oaStatus"></div></div>
        <div class="row right"><button class="btn ghost" data-act="close">Cancel</button><button class="btn primary" id="oaStart">Download</button></div>
      </div>`;
      document.body.appendChild(el);
      const $ = s => el.querySelector(s);
      const update = () => {
        let zMin = +$('#oaMin').value, zMax = +$('#oaMax').value;
        if (zMin > zMax) { zMax = zMin; $('#oaMax').value = zMax; }
        $('#oaMinVal').textContent = zMin; $('#oaMaxVal').textContent = zMax;
        const tiles = this.countTiles(bounds, zMin, zMax);
        const over = tiles > cap;
        $('#oaEstimate').innerHTML = `<div><span>Tiles</span><span>${tiles.toLocaleString()}${over ? ' (over the ' + cap.toLocaleString() + ' cap)' : ''}</span></div><div><span>Estimated size</span><span>~${this.estimateMB(tiles, bm).toFixed(1)} MB</span></div><div><span>Area</span><span>${MB.formatDistance(bounds.getSouthWest().distanceTo(L.latLng(bounds.getSouth(), bounds.getEast())))} × ${MB.formatDistance(bounds.getSouthWest().distanceTo(L.latLng(bounds.getNorth(), bounds.getWest())))}</span></div>`;
        $('#oaStart').disabled = over || tiles === 0;
        return { zMin, zMax, tiles };
      };
      $('#oaMin').addEventListener('input', update); $('#oaMax').addEventListener('input', update);
      update();
      const close = () => { if (this.job) this.cancel(); el.remove(); };
      el.addEventListener('click', e => { if (e.target === el || (e.target.dataset && e.target.dataset.act === 'close')) close(); });
      $('#oaStart').addEventListener('click', async () => {
        const { zMin, zMax, tiles } = update();
        $('#oaStart').disabled = true; $('#oaMin').disabled = true; $('#oaMax').disabled = true;
        $('#oaProgress').classList.remove('hidden');
        const t0 = Date.now();
        const includeData = anyData && $('#oaData').checked;
        try {
          const job = await this.download({ id: existing && existing.id, name: $('#oaName').value.trim(), bounds, zMin, zMax, includeData }, j => {
            const pct = Math.round((j.done + j.failed) / j.total * 100);
            $('#oaBar').style.width = pct + '%';
            $('#oaStatus').textContent = `${(j.done + j.failed).toLocaleString()} / ${j.total.toLocaleString()} tiles · ${(j.bytes / 1048576).toFixed(1)} MB` + (j.failed ? ` · ${j.failed} failed` : '') + (j.dataCells ? ` · data cells ${j.dataCells}` : '');
          });
          if (job.cancelled) { MB.toast('Download cancelled'); }
          else { MB.toast(`Offline area saved: ${job.done.toLocaleString()} tiles in ${Math.round((Date.now() - t0) / 1000)} s`); el.remove(); }
        } catch (e) { MB.toast('Download failed: ' + e.message); $('#oaStart').disabled = false; }
        this.renderSection();
      });
    }
  };

  function currentBasemapName() {
    const k = MB.state.basemap;
    if (MB.basemaps[k]) return MB.basemaps[k].name;
    const p = k.startsWith('custom:') && MB.getProvider(k.slice(7));
    return p ? p.name : k;
  }
})(window.MB);
