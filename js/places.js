/* GenGIS - place names (Settings → Map overlays)
 * - country, city and ocean / sea names from Natural Earth (data/places.js, built by scripts/build-places.js)
 * - each kind is a toggle, on by default; the choice is saved with the project, like the border overlays
 * - drawn as text on the map, in their own pane under live traffic: the most important name wins where two would
 *   overlap, and more names appear as the map zooms in
 */
window.MB = window.MB || {};
(function (MB) {
  'use strict';

  const KINDS = [
    { key: 'countries', name: 'Country names', desc: 'Natural Earth. Larger countries from the world view, smaller ones as you zoom in.' },
    { key: 'cities', name: 'City names', desc: 'Capitals and major cities; more towns appear as you zoom in.' },
    { key: 'marine', name: 'Ocean and sea names', desc: 'Oceans, seas, gulfs, bays and straits.' }
  ];
  const DEFAULTS = { countries: true, cities: true, marine: true };
  const PAD = 3;            // px kept clear around each name
  const COUNTRY_EXTRA = 2;  // zoom levels a country name stays past Natural Earth's suggested maximum
  // label styles: class, font (for measuring, the same as the CSS), and placement order (the most important first)
  const STYLE = {
    ocean: { font: 'italic 500 14px system-ui, sans-serif', track: 2.2, order: 0 },
    country: { font: '700 12.5px system-ui, sans-serif', track: 0.6, order: 1 },
    sea: { font: 'italic 500 12px system-ui, sans-serif', track: 0.8, order: 2 },
    capital: { font: '700 12px system-ui, sans-serif', track: 0, order: 3, dot: true },
    city: { font: '600 11.5px system-ui, sans-serif', track: 0, order: 4, dot: true },
    bay: { font: 'italic 500 11px system-ui, sans-serif', track: 0.3, order: 5 }
  };
  const MARINE_STYLE = ['ocean', 'sea', 'bay', 'bay'];

  let ctx = null;
  const widths = new Map(); // "style|name" -> px
  function textWidth(style, text) {
    const k = style + '|' + text;
    let w = widths.get(k);
    if (w === undefined) {
      if (!ctx) ctx = document.createElement('canvas').getContext('2d');
      const st = STYLE[style];
      ctx.font = st.font;
      w = Math.ceil(ctx.measureText(text).width + st.track * text.length);
      widths.set(k, w);
    }
    return w;
  }

  MB.places = {
    kinds: KINDS,
    markers: new Map(), // label id -> L.marker
    list: null,         // every name: { id, name, lat, lon, min, max, style }

    conf() {
      const s = MB.state.placeLabels = Object.assign({}, DEFAULTS, MB.state.placeLabels);
      return s;
    },
    set(key, on) {
      this.conf()[key] = !!on;
      if (MB.autosave) MB.autosave();
      this.render();
    },

    init() {
      const pane = MB.map.createPane('mb-places'); // above the data layers and borders, under live traffic
      pane.style.zIndex = 365;
      pane.style.pointerEvents = 'none';
      MB.map.on('moveend', () => this.render());
      MB.on('project', () => this.render());
      // ~250 KB of names: read after start-up, not in its way
      const s = document.createElement('script');
      s.src = 'data/places.js';
      s.async = true;
      s.onload = () => { this.build(MB.placeData); this.render(); };
      s.onerror = () => console.warn('Place names not available');
      document.head.appendChild(s);
    },

    build(d) {
      if (!d) return;
      const list = [];
      (d.countries || []).forEach((c, i) => list.push({ id: 'c' + i, kind: 'countries', name: c[0], lon: c[1], lat: c[2], min: c[3], max: c[4] + COUNTRY_EXTRA, style: 'country' }));
      (d.marine || []).forEach((m, i) => list.push({ id: 'm' + i, kind: 'marine', name: m[0], lon: m[1], lat: m[2], min: m[3], max: 99, style: MARINE_STYLE[m[4]] || 'bay' }));
      (d.cities || []).forEach((c, i) => list.push({ id: 't' + i, kind: 'cities', name: c[0], lon: c[1], lat: c[2], min: c[3], max: 99, style: c[4] ? 'capital' : 'city' }));
      // stable: within a style the data's own order (most important first) is kept
      list.forEach((p, i) => { p.rank = STYLE[p.style].order * 1e5 + i; });
      list.sort((a, b) => a.rank - b.rank);
      this.list = list;
    },

    // Place the names that belong at this zoom, most important first, skipping any that would overlap one placed.
    render() {
      if (!this.list || !MB.map) return;
      const map = MB.map, cf = this.conf(), zoom = map.getZoom();
      const size = map.getSize(), bounds = map.getBounds().pad(0.15);
      const cLng = map.getCenter().lng;
      const placed = [], keep = new Set();
      const CELL = 128, grid = new Map(); // placed boxes by screen cell, for the overlap test
      const cells = (b, fn) => { for (let x = Math.floor(b[0] / CELL); x <= Math.floor(b[2] / CELL); x++) for (let y = Math.floor(b[1] / CELL); y <= Math.floor(b[3] / CELL); y++) if (fn(x + ',' + y) === false) return false; return true; };
      const free = b => cells(b, k => !(grid.get(k) || []).some(o => b[0] < o[2] && b[2] > o[0] && b[1] < o[3] && b[3] > o[1]));
      const take = b => cells(b, k => { (grid.get(k) || grid.set(k, []).get(k)).push(b); });
      const limit = size.x * size.y / 900; // at most one name per ~30 x 30 px on average
      for (const p of this.list) {
        if (!cf[p.kind] || zoom < p.min || zoom > p.max) continue;
        const lon = p.lon + 360 * Math.round((cLng - p.lon) / 360); // the copy of the world in view
        if (!bounds.contains([p.lat, lon])) continue;
        const pt = map.latLngToContainerPoint([p.lat, lon]), st = STYLE[p.style];
        const w = textWidth(p.style, p.name), h = parseFloat(st.font.match(/([\d.]+)px/)[1]) + 3;
        // a city name sits right of its dot; other names are centered on their point
        const b = st.dot ? [pt.x - 4 - PAD, pt.y - h / 2 - PAD, pt.x + 6 + w + PAD, pt.y + h / 2 + PAD] : [pt.x - w / 2 - PAD, pt.y - h / 2 - PAD, pt.x + w / 2 + PAD, pt.y + h / 2 + PAD];
        if (!free(b)) continue;
        take(b);
        keep.add(p.id);
        placed.push([p, lon]);
        if (placed.length >= limit) break;
      }
      this.markers.forEach((m, id) => { if (!keep.has(id)) { map.removeLayer(m); this.markers.delete(id); } });
      placed.forEach(([p, lon]) => {
        let m = this.markers.get(p.id);
        if (m) { if (m._lon !== lon) { m.setLatLng([p.lat, lon]); m._lon = lon; } return; }
        m = L.marker([p.lat, lon], {
          pane: 'mb-places', interactive: false, keyboard: false, pmIgnore: true,
          icon: L.divIcon({ className: 'mb-place mb-place-' + p.style, iconSize: null, html: `<span>${MB.escapeHtml(p.name)}</span>` })
        });
        m.options.pmIgnore = true;
        m._lon = lon;
        m.addTo(map);
        this.markers.set(p.id, m);
      });
    },

    // The toggles, under the border overlays in Settings → Map overlays (MB.data.renderOverlays).
    overlayHtml() {
      const cf = this.conf(), esc = MB.escapeHtml;
      return KINDS.map(k => `<div class="overlay-item"><label class="check" style="margin:0"><input type="checkbox" data-place="${k.key}"${cf[k.key] ? ' checked' : ''}> <span>${esc(k.name)}</span></label>
        <div class="note" style="margin-left:23px">${esc(k.desc)}</div></div>`).join('');
    },
    bindOverlays(box) {
      box.querySelectorAll('input[data-place]').forEach(cb => cb.addEventListener('change', () => this.set(cb.dataset.place, cb.checked)));
    }
  };
})(window.MB);
