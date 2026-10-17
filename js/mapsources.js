/* GenGIS - map sources in the MOBAC format, as ATAK takes them: one .xml, or a .zip of many
 * (e.g. https://github.com/joshuafuller/ATAK-Maps). Each becomes a map provider in the base map list.
 * - <customMapSource>: tiles at an address with {$z} {$x} {$y} (or Bing's quadkey {$q}), {$serverpart} taking its turn
 *   through <serverParts>, <invertYCoordinate> for TMS, <minZoom>/<maxZoom>
 * - <customWmsMapSource>: a WMS layer (<layers>, <version>, <styles>, <coordinatesystem> EPSG:3857 or EPSG:4326, and
 *   <aditionalparameters>, MOBAC's own spelling, or <additionalparameters>)
 * - <customMultiLayerMapSource>: tile layers drawn over one another, each at its <layersAlpha>, blended per tile
 * A placeholder key in an address (API_KEY_HERE and the like) becomes {key}: the provider then asks for one.
 * Sources already here (the same address) are updated, not added twice. A .zip is read by the browser's own
 * decompression (no library): stored and deflated entries, as any zip tool writes them.
 */
window.MB = window.MB || {};
(function (MB) {
  'use strict';

  const esc = MB.escapeHtml;
  const MAX_XML = 1024 * 1024;     // a map source is a few hundred bytes: anything this big is not one
  const MAX_ENTRIES = 2000;
  const KEY_RE = /API_KEY_HERE|YOUR_API_KEY|YOUR_KEY_HERE|INSERT_YOUR_KEY|YOUR_KEY|\{\$key\}/gi;
  // Credits for the well-known hosts (MOBAC files carry none; the image and PDF export prints them)
  const CREDITS = [
    [/arcgisonline\.com|arcgis\.com/, 'Tiles &copy; Esri and its data providers'], [/virtualearth\.net|bing\.com/, '&copy; Microsoft'],
    [/google\.com|googleapis\.com/, '&copy; Google'], [/openstreetmap|opentopomap|cyclosm|openseamap/, '&copy; OpenStreetMap contributors'],
    [/os\.uk/, '&copy; Crown copyright and database rights, Ordnance Survey'], [/usgs\.gov/, 'USGS The National Map'],
    [/geodatenzentrum\.de/, '&copy; GeoBasis-DE / BKG'], [/geoportal\.gov\.pl/, 'Geoportal.gov.pl'],
    [/geogratis\.gc\.ca|nrcan/, '&copy; Natural Resources Canada'], [/blm\.gov/, 'Bureau of Land Management'],
    [/fema\.gov/, 'FEMA'], [/viamichelin/, '&copy; Michelin'], [/waymarkedtrails/, '&copy; Waymarked Trails, OpenStreetMap contributors'],
    [/mtbmap\.cz/, '&copy; mtbmap.cz, OpenStreetMap contributors'], [/gov\.bc\.ca/, 'Province of British Columbia']
  ];
  const creditFor = url => { const m = CREDITS.find(([re]) => re.test(url)); return m ? m[1] : ''; };
  const mimeOf = t => (/^jpe?g$/i.test(t) ? 'image/jpeg' : /^gif$/i.test(t) ? 'image/gif' : 'image/png');

  // Bing's tile address: the tile's quadkey (one digit per level)
  function quadkey(x, y, z) {
    let q = '';
    for (let i = z; i > 0; i--) { const m = 1 << (i - 1); q += ((x & m) ? 1 : 0) + ((y & m) ? 2 : 0); }
    return q;
  }

  /* ---------- reading a map source ---------- */
  const child = (el, tag) => Array.from(el.children).find(c => c.localName.toLowerCase() === tag.toLowerCase()) || null;
  const val = (el, tag) => { const c = child(el, tag); return c ? c.textContent.trim() : ''; };
  const zooms = el => {
    const lo = parseInt(val(el, 'minZoom'), 10), hi = parseInt(val(el, 'maxZoom'), 10);
    return { minZoom: isFinite(lo) ? Math.max(0, Math.min(24, lo)) : 0, maxZoom: isFinite(hi) ? Math.max(1, Math.min(24, hi)) : 19 };
  };
  function httpUrl(el) {
    const url = val(el, 'url');
    if (!/^https?:\/\//i.test(url)) throw new Error('its address is not an http(s) address');
    KEY_RE.lastIndex = 0;
    const keyed = KEY_RE.test(url); KEY_RE.lastIndex = 0;
    return { url: url.replace(KEY_RE, '{key}'), keyed };
  }
  function params(s) {
    const out = {};
    String(s || '').replace(/^[?&]+/, '').split('&').forEach(kv => {
      if (!kv) return;
      const i = kv.indexOf('='), k = decodeURIComponent((i < 0 ? kv : kv.slice(0, i)).trim()), v = i < 0 ? '' : decodeURIComponent(kv.slice(i + 1).trim());
      if (k) out[k] = v;
    });
    return out;
  }

  function fromTiles(el) {
    const { url: raw, keyed } = httpUrl(el);
    const url = raw.replace(/\{\$z\}/gi, '{z}').replace(/\{\$x\}/gi, '{x}').replace(/\{\$y\}/gi, '{y}').replace(/\{\$serverpart\}/gi, '{s}').replace(/\{\$q\}/gi, '{q}');
    if (!/\{q\}/.test(url) && !(/\{z\}/.test(url) && /\{x\}/.test(url) && /\{y\}/.test(url))) throw new Error('its address has no {$z}/{$x}/{$y} or {$q}');
    const parts = val(el, 'serverParts').split(/[\s,]+/).filter(Boolean);
    const p = Object.assign({ type: 'xyz', url, tileSize: 256, format: mimeOf(val(el, 'tileType')), subdomains: parts.length ? parts.join(' ') : 'abc' }, zooms(el));
    if (/^true$/i.test(val(el, 'invertYCoordinate'))) p.tms = true;
    return { p, keyed };
  }

  const WMS_OWN = ['SERVICE', 'REQUEST', 'LAYERS', 'VERSION', 'FORMAT', 'STYLES', 'TRANSPARENT', 'SRS', 'CRS', 'BBOX', 'WIDTH', 'HEIGHT'];
  let optionNames = null; // Leaflet's tile layer options (attribution, crs, tileSize, crossOrigin…), lower-cased
  const isOption = k => { if (!optionNames) { optionNames = new Set(); for (const o in L.TileLayer.WMS.prototype.options) optionNames.add(o.toLowerCase()); } return optionNames.has(k.toLowerCase()); };
  // Extra WMS parameters as they may be sent: a name that is a request parameter of WMS itself or an option of the
  // layer (which would change the layer, or its credits shown as HTML) is dropped, wherever the parameters came from.
  function safeWmsParams(obj) {
    if (!obj || typeof obj !== 'object') return null;
    const out = {};
    Object.keys(obj).forEach(k => { if (/^[A-Za-z0-9_.:-]{1,64}$/.test(k) && !WMS_OWN.includes(k.toUpperCase()) && !isOption(k)) out[k] = String(obj[k]).slice(0, 500); });
    return Object.keys(out).length ? out : null;
  }
  // A WMS address without the request parameters Leaflet adds itself (SERVICE=WMS&…), nor a trailing ? or &.
  function wmsBase(url) {
    const q = url.indexOf('?');
    if (q < 0) return url;
    const kept = url.slice(q + 1).split('&').filter(kv => kv && !WMS_OWN.includes(decodeURIComponent(kv.split('=')[0]).toUpperCase()));
    return url.slice(0, q) + (kept.length ? '?' + kept.join('&') : '');
  }
  function fromWms(el) {
    const { url: raw, keyed } = httpUrl(el);
    const url = wmsBase(raw);
    const layers = val(el, 'layers');
    if (!layers) throw new Error('it names no <layers>');
    const crs = (val(el, 'coordinatesystem') || 'EPSG:3857').toUpperCase();
    if (!/^EPSG:(3857|900913|4326)$/.test(crs)) throw new Error('its projection ' + crs + ' is not supported (EPSG:3857 or EPSG:4326)');
    const extra = params(val(el, 'aditionalparameters') || val(el, 'additionalparameters'));
    const up = {}; Object.keys(extra).forEach(k => { up[k.toUpperCase()] = extra[k]; });
    const p = Object.assign({
      type: 'wms', url, layers, version: val(el, 'version') || '1.1.1', format: up.FORMAT || mimeOf(val(el, 'tileType')),
      styles: val(el, 'styles') || up.STYLES || '', transparent: /^true$/i.test(up.TRANSPARENT || ''), tileSize: 256
    }, zooms(el));
    if (crs === 'EPSG:4326') p.crs = 'EPSG:4326';
    const rest = safeWmsParams(extra);
    if (rest) p.wmsParams = rest;
    return { p, keyed };
  }

  function fromMulti(el) {
    const box = child(el, 'layers');
    const subs = box ? Array.from(box.children) : [];
    if (!subs.length) throw new Error('it has no <layers>');
    let keyed = false;
    const sublayers = subs.map(s => {
      if (s.localName !== 'customMapSource') throw new Error('a blended layer must be tiles (<customMapSource>), not ' + s.localName);
      const r = fromTiles(s); keyed = keyed || r.keyed;
      return r.p;
    });
    const a = val(el, 'layersAlpha').split(/[\s,]+/).map(Number);
    const alphas = sublayers.map((_, i) => (isFinite(a[i]) ? Math.max(0, Math.min(1, a[i])) : 1));
    const p = {
      type: 'multi', url: sublayers[0].url, sublayers, alphas, tileSize: 256, format: 'image/png',
      minZoom: Math.max(...sublayers.map(s => s.minZoom)), maxZoom: Math.min(...sublayers.map(s => s.maxZoom))
    };
    return { p, keyed };
  }

  // One XML document: the map source in it (with its name), or an error saying why not.
  function parseSource(xml) {
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    if (doc.querySelector('parsererror')) throw new Error('it is not well-formed XML');
    const root = doc.documentElement, kind = root && root.localName;
    const read = { customMapSource: fromTiles, customWmsMapSource: fromWms, customMultiLayerMapSource: fromMulti }[kind];
    if (!read) throw new Error('it is not a MOBAC map source (<' + (kind || '?') + '>)');
    const { p, keyed } = read(root);
    p.name = (val(root, 'name') || 'Imported map').slice(0, 120);
    const credit = creditFor(p.type === 'multi' ? p.sublayers.map(s => s.url).join(' ') : p.url);
    if (credit) p.attribution = credit;
    const [n, s, e, w] = ['north', 'south', 'east', 'west'].map(t => parseFloat(val(root, t)));
    if ([n, s, e, w].every(isFinite) && n > s && n <= 90 && s >= -90 && e > w && e <= 180 && w >= -180) p.bounds = [[s, w], [n, e]];
    return { p, keyed };
  }

  /* ---------- reading a .zip ---------- */
  // Deflated bytes inflated up to MAX_XML: null past it (the inflating stops there, whatever the zip claims).
  async function inflateCapped(data) {
    const reader = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
    const parts = []; let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_XML) { reader.cancel().catch(() => {}); return null; }
      parts.push(value);
    }
    const out = new Uint8Array(total); let at = 0;
    parts.forEach(v => { out.set(v, at); at += v.byteLength; });
    return out;
  }
  async function unzip(buf, onEntry) {
    const dv = new DataView(buf), u8 = new Uint8Array(buf), dec = new TextDecoder();
    let eocd = -1;
    for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 22 - 65535); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error('not a zip file');
    const count = Math.min(dv.getUint16(eocd + 10, true), MAX_ENTRIES);
    let p = dv.getUint32(eocd + 16, true);
    for (let n = 0; n < count && p + 46 <= buf.byteLength && dv.getUint32(p, true) === 0x02014b50; n++) {
      const flags = dv.getUint16(p + 8, true), method = dv.getUint16(p + 10, true);
      const csize = dv.getUint32(p + 20, true), usize = dv.getUint32(p + 24, true);
      const nlen = dv.getUint16(p + 28, true), xlen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
      const local = dv.getUint32(p + 42, true);
      const name = dec.decode(u8.subarray(p + 46, p + 46 + nlen));
      p += 46 + nlen + xlen + clen;
      if (name.endsWith('/') || /(^|\/)(__MACOSX|\.)/.test(name)) continue; // folders, macOS metadata, hidden files
      if (!/\.xml$/i.test(name)) { onEntry(name, null, 'not an .xml file'); continue; }
      if (flags & 1) { onEntry(name, null, 'it is encrypted'); continue; }
      if (usize > MAX_XML || csize > MAX_XML) { onEntry(name, null, 'it is too large for a map source'); continue; }
      if (local + 30 > buf.byteLength || dv.getUint32(local, true) !== 0x04034b50) { onEntry(name, null, 'the zip entry is damaged'); continue; }
      const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
      const data = u8.subarray(start, start + csize);
      try {
        let bytes;
        if (method === 0) bytes = data;
        else if (method === 8) bytes = await inflateCapped(data);
        else { onEntry(name, null, 'its compression is not supported'); continue; }
        if (!bytes || bytes.byteLength > MAX_XML) { onEntry(name, null, 'it is too large for a map source'); continue; }
        onEntry(name, dec.decode(bytes), null);
      } catch (e) { onEntry(name, null, 'it could not be decompressed'); }
    }
  }

  /* ---------- tile layers for the new kinds ---------- */
  // A tile layer whose address has Bing's {q} (the quadkey) besides the usual placeholders.
  MB.QuadKeyTileLayer = L.TileLayer.extend({
    getTileUrl(coords) {
      const z = this._getZoomForUrl();
      const data = { r: L.Browser.retina ? '@2x' : '', s: this._getSubdomain(coords), x: coords.x, y: coords.y, z, q: quadkey(coords.x, coords.y, z) };
      return L.Util.template(this._url, L.extend(data, this.options));
    }
  });
  // Layers drawn over one another in every tile, each at its own opacity (as ATAK blends a multi-layer source).
  MB.BlendedTileLayer = L.TileLayer.extend({
    initialize(subs, alphas, options) {
      this._subs = subs; this._alphas = alphas;
      L.TileLayer.prototype.initialize.call(this, subs[0].url, options); // the first layer's address: offline areas take it
    },
    subUrl(s, x, y, z) {
      const parts = Array.isArray(s.subdomains) ? s.subdomains : String(s.subdomains || 'abc').split(/\s+/).length > 1 ? String(s.subdomains).split(/\s+/) : String(s.subdomains || 'abc').split('');
      const yy = s.tms ? (1 << z) - 1 - y : y;
      return L.Util.template(s.url, { x, y: yy, z, s: parts[Math.abs(x + y) % parts.length], q: quadkey(x, y, z), r: '', key: this.options.key || '' });
    },
    createTile(coords, done) {
      const size = this.getTileSize(), c = document.createElement('canvas');
      c.width = size.x; c.height = size.y;
      const z = this._getZoomForUrl(), subs = this._subs;
      const imgs = subs.map(() => null);
      let left = subs.length, ok = 0;
      const finish = () => {
        if (--left) return;
        const ctx = c.getContext('2d');
        imgs.forEach((img, i) => { if (img) { ctx.globalAlpha = this._alphas[i]; ctx.drawImage(img, 0, 0, size.x, size.y); } }); // in order, bottom first
        done(ok ? null : new Error('no layer of this tile loaded'), c);
      };
      subs.forEach((s, i) => {
        if (z < s.minZoom || z > s.maxZoom) { finish(); return; }
        const img = new Image();
        img.crossOrigin = 'anonymous'; // a server without CORS leaves its layer out rather than taint the export
        img.onload = () => { imgs[i] = img; ok++; finish(); };
        img.onerror = () => finish();
        img.src = this.subUrl(s, coords.x, coords.y, z);
      });
      return c;
    }
  });

  /* ---------- importing ---------- */
  const sameSource = (a, b) => a.type === b.type && String(a.url).replace(/[?&]+$/, '') === String(b.url).replace(/[?&]+$/, '') && String(a.layers || '') === String(b.layers || '');

  MB.mapSources = {
    quadkey, parseSource, unzip, safeWmsParams,

    pick() {
      let input = document.getElementById('mapSourceFile');
      if (!input) {
        input = document.createElement('input');
        input.type = 'file'; input.id = 'mapSourceFile'; input.hidden = true; input.multiple = true;
        input.accept = '.xml,.zip,application/xml,text/xml,application/zip';
        input.addEventListener('change', () => { const f = Array.from(input.files || []); input.value = ''; if (f.length) this.importFiles(f); });
        document.body.appendChild(input);
      }
      input.click();
    },

    isMapSourceFile: f => /\.(xml|zip)$/i.test(f.name || ''),

    // Files (.xml or .zip): their map sources added to the providers (or updated), and a summary.
    async importFiles(files) {
      const found = [], skipped = [];
      const take = (name, xml, why, group) => {
        if (why) { skipped.push({ name, why }); return; }
        try { const r = parseSource(xml); r.p.group = group; found.push(r); } catch (e) { skipped.push({ name, why: e.message }); }
      };
      for (const f of files) {
        try {
          if (/\.zip$/i.test(f.name)) {
            const zipGroup = f.name.replace(/\.zip$/i, '');
            await unzip(await f.arrayBuffer(), (name, xml, why) => {
              const dirs = name.split('/'); const group = dirs.length > 1 ? dirs[dirs.length - 2] : zipGroup; // the folder it was in
              take(name, xml, why, group);
            });
          } else if (/\.xml$/i.test(f.name)) {
            if (f.size > MAX_XML) skipped.push({ name: f.name, why: 'it is too large for a map source' });
            else take(f.name, await f.text(), null, 'Imported');
          } else skipped.push({ name: f.name, why: 'not an .xml or .zip file' });
        } catch (e) { skipped.push({ name: f.name, why: e.message }); }
      }
      const st = MB.settings, list = st.providers = st.providers || [];
      let added = 0, updated = 0;
      const needKey = [];
      found.forEach(({ p, keyed }) => {
        const was = list.find(x => sameSource(x, p));
        if (was) { const id = was.id, key = was.key; Object.assign(was, p, { id, key }); updated++; }
        else { list.push(Object.assign({ id: MB.uid(), key: '' }, p)); added++; }
        if (keyed) needKey.push(p.name);
      });
      if (added || updated) {
        MB.saveSettings(); // (the base map list follows: 'providers')
        const sd = MB.settingsDialog;
        if (sd && sd.el && !sd.el.classList.contains('hidden')) sd.render(); // imported from its own button: its list too
        const cur = MB.state.basemap;
        if (cur && cur.startsWith('custom:')) MB.setBasemap(cur); // an updated source in use: redrawn
      }
      this.summary({ added, updated, skipped, needKey });
      return { added, updated, skipped, needKey };
    },

    // What was imported, what was not and why, and which sources need a key.
    summary(r) {
      const n = r.added + r.updated, plural = k => (k === 1 ? '' : 's');
      // what changed, said as it was: added, updated (already in the list), or both
      const what = [r.added ? `${r.added} map source${plural(r.added)} added to the base map list` : '', r.updated ? `${r.updated} already there, updated` : ''].filter(Boolean).join('; ');
      if (!r.skipped.length && !r.needKey.length) {
        MB.toast(n ? what + (r.added ? ': pick one in the base map list' : '') : 'No map sources found', 4500);
        return;
      }
      let dlg = document.getElementById('mapImportDialog');
      if (!dlg) {
        dlg = document.createElement('div');
        dlg.id = 'mapImportDialog'; dlg.className = 'modal hidden';
        dlg.innerHTML = `<div class="modal-box map-import-box" role="dialog" aria-modal="true" aria-labelledby="mapImportTitle">${MB.modalCloseHtml}<h2 id="mapImportTitle">Map sources imported</h2><div class="map-import-body"></div>
          <div class="btn-row right"><button type="button" class="btn" data-act="keys">Map &amp; search APIs…</button><button type="button" class="btn primary" data-act="close">Done</button></div></div>`;
        document.body.appendChild(dlg);
        MB.ui.wireDialog(dlg);
        dlg.querySelector('[data-act="keys"]').addEventListener('click', () => { MB.ui.closeDialog(dlg); MB.settingsDialog.open(); });
      }
      dlg.querySelector('.map-import-body').innerHTML =
        `<p>${n ? esc(what) + '.' : 'No map sources were added.'}</p>` +
        (r.needKey.length ? `<h3>Need an API key</h3><p class="note">Add the key in Map &amp; search APIs (Configured providers, Edit).</p><ul>${r.needKey.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : '') +
        (r.skipped.length ? `<h3>Not imported (${r.skipped.length})</h3><ul class="map-import-skipped">${r.skipped.map(s => `<li><b>${esc(s.name)}</b>: ${esc(s.why)}</li>`).join('')}</ul>` : '');
      dlg.querySelector('[data-act="keys"]').hidden = !r.needKey.length;
      MB.ui.openDialog(dlg);
    }
  };
})(window.MB);
