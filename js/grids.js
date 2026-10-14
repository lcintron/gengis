/* GenGIS - grid systems (Settings → Grid systems)
 * - a latitude/longitude grid: lines at round values of the coordinate format chosen in Settings → Units (decimal
 *   degrees, degrees and minutes, or degrees, minutes and seconds), closer together as the map zooms in; labels
 *   always name the hemisphere
 * - one grid at a time: none, this one or the MGRS grid (js/mgrs.js)
 * - grid labels along the bottom and left edges of the map's clear area (not under the toolbar, a side panel over
 *   the map or the map's corner controls), or along its center lines
 * Off by default; saved with the project.
 */
window.MB = window.MB || {};
(function (MB) {
  'use strict';

  const MINUTES = [30, 20, 15, 10, 5, 2, 1];
  // Line spacings (degrees) for each format: round numbers in the way the coordinates are read.
  const STEPS = {
    dd: [30, 10, 5, 2, 1, 0.5, 0.2, 0.1, 0.05, 0.02, 0.01, 0.005, 0.002, 0.001, 0.0005, 0.0002, 0.0001],
    dm: [30, 10, 5, 2, 1, ...MINUTES.map(m => m / 60), ...[0.5, 0.2, 0.1, 0.05, 0.02, 0.01].map(m => m / 60)],
    dms: [30, 10, 5, 2, 1, ...MINUTES.map(m => m / 60), ...[30, 20, 15, 10, 5, 2, 1, 0.5, 0.2, 0.1].map(s => s / 3600)]
  };
  const MIN_PX = 90;   // px between latitude/longitude lines at the least (their labels are wider than MGRS figures)
  const CHAR_PX = 6.6; // the width of a label character, for keeping labels inside the clear area
  const COLOR = '#8fd3ff';

  const format = () => (MB.state.coordFormat === 'dm' || MB.state.coordFormat === 'dms' ? MB.state.coordFormat : 'dd');
  const pad2 = n => String(n).padStart(2, '0');
  // A line's value as its label: as precise as the spacing needs, with the hemisphere (none for 0° and 180°).
  function lineLabel(v, axis, step, f) {
    if (axis === 'lng') v = ((v + 180) % 360 + 360) % 360 - 180;
    const a = Math.abs(v), edge = a < 1e-9 || (axis === 'lng' && Math.abs(a - 180) < 1e-9);
    const hem = edge ? '' : axis === 'lat' ? (v < 0 ? 'S' : 'N') : (v < 0 ? 'W' : 'E');
    if (f === 'dd' || step >= 1 - 1e-9) {
      const d = step >= 1 - 1e-9 ? 0 : Math.ceil(-Math.log10(step) - 1e-9);
      return a.toFixed(d) + '°' + hem;
    }
    if (f === 'dm') {
      const sm = step * 60, d = sm >= 1 - 1e-9 ? 0 : Math.ceil(-Math.log10(sm) - 1e-9);
      const tm = Math.round(a * 60 * 1e6) / 1e6, deg = Math.floor(tm / 60 + 1e-9), m = tm - deg * 60;
      return `${deg}°${m.toFixed(d).padStart(d ? d + 3 : 2, '0')}′${hem}`;
    }
    const ts = Math.round(a * 3600 * 100) / 100, deg = Math.floor(ts / 3600 + 1e-9), m = Math.floor((ts - deg * 3600) / 60 + 1e-9), s = ts - deg * 3600 - m * 60;
    if (step >= 1 / 60 - 1e-9) return `${deg}°${pad2(m)}′${hem}`;
    const sd = step * 3600 >= 1 - 1e-9 ? 0 : 1;
    return `${deg}°${pad2(m)}′${s.toFixed(sd).padStart(sd ? 4 : 2, '0')}″${hem}`;
  }

  MB.grids = {
    STEPS, lineLabel,
    group: null, renderer: null,
    get latlonOn() { return !!(MB.state.latlonGrid && MB.state.latlonGrid.on); },
    get labelMode() { return MB.state.gridLabels === 'center' ? 'center' : 'edges'; },

    init() {
      const pane = MB.map.createPane('mb-grid'); // with the MGRS grid: above the data layers, under the place names
      pane.style.zIndex = 364;
      pane.style.pointerEvents = 'none';
      this.renderer = L.canvas({ pane: 'mb-grid', padding: 0.1 });
      this.group = L.layerGroup();
      // the clear area changes with the side panel, a docked toolbar or the window
      MB.map.on('moveend resize', () => { if (this.latlonOn) this.render(); });
      MB.on('units', () => { if (this.latlonOn) this.render(); }); // the coordinate format: new values and label widths
      // A phone's side panel opening over the map, or the tool hint showing, changes the clear area without resizing
      // the map: the grid is laid out again once the panel has settled.
      const relayout = MB.debounce(() => { if (this.latlonOn) this.render(); if (MB.mgrs && MB.mgrs.on) MB.mgrs.render(); }, 250);
      const watch = new MutationObserver(relayout);
      ['sidebar', 'toolHint', 'mapwrap'].forEach(id => { const el = document.getElementById(id); if (el) watch.observe(el, { attributes: true, attributeFilter: ['class'] }); });
      MB.on('project', () => { this.normalize(); this.apply(); if (MB.mgrs) MB.mgrs.apply(); this.renderSection(); });
      this.normalize();
      this.apply();
    },

    // One grid at a time: 'none', 'latlon' or 'mgrs'.
    get system() { return this.latlonOn ? 'latlon' : (MB.state.mgrsGrid && MB.state.mgrsGrid.on ? 'mgrs' : 'none'); },
    normalize() { if (this.latlonOn && MB.state.mgrsGrid && MB.state.mgrsGrid.on) MB.state.mgrsGrid = { on: false }; },
    setSystem(sys) {
      MB.state.latlonGrid = { on: sys === 'latlon' };
      MB.state.mgrsGrid = { on: sys === 'mgrs' };
      if (MB.autosave) MB.autosave();
      this.apply();
      if (MB.mgrs) MB.mgrs.apply();
      MB.emit('mgrs'); // the coordinates readout adds or drops the MGRS reference
      this.renderSection();
    },
    setLabels(mode) {
      MB.state.gridLabels = mode === 'center' ? 'center' : 'edges';
      if (MB.autosave) MB.autosave();
      this.apply();
      if (MB.mgrs && MB.mgrs.on) MB.mgrs.render();
      this.renderSection();
    },
    apply() {
      if (!this.group) return;
      if (this.latlonOn) { if (!MB.map.hasLayer(this.group)) this.group.addTo(MB.map); this.render(); }
      else { this.group.clearLayers(); MB.map.removeLayer(this.group); }
    },

    /* ----- where labels can go ----- */
    // The part of the map nothing covers (container px): left of the map's right-hand controls, right of the
    // toolbar, above the bottom corners' controls (and a side panel lying over the map, as on phones).
    safeArea() {
      const map = MB.map, size = map.getSize(), mr = map.getContainer().getBoundingClientRect();
      const cover = el => {
        if (!el || !el.offsetParent) return null;
        const r = el.getBoundingClientRect();
        const x0 = Math.max(r.left, mr.left) - mr.left, x1 = Math.min(r.right, mr.right) - mr.left;
        const y0 = Math.max(r.top, mr.top) - mr.top, y1 = Math.min(r.bottom, mr.bottom) - mr.top;
        return x1 > x0 && y1 > y0 ? { x0, x1, y0, y1 } : null;
      };
      let l = 0, r = size.x, t = 0, b = size.y;
      const tb = cover(document.getElementById('toolbar'));
      if (tb) { if (tb.x0 > size.x / 2) r = Math.min(r, tb.x0); else l = Math.max(l, tb.x1); } // on the left, or the right
      const sb = document.getElementById('sidebar'), side = sb && !sb.classList.contains('collapsed') ? cover(sb) : null;
      if (side) { if (side.x0 > size.x / 2) r = Math.min(r, side.x0); else b = Math.min(b, side.y0); } // beside the map, or a bottom sheet
      const c = map.getContainer();
      const tr = cover(c.querySelector('.leaflet-top.leaflet-right')); // the map's buttons: right, or left with the toolbar right
      if (tr && tr.x1 - tr.x0 < size.x / 3) { if (tr.x0 > size.x / 2) r = Math.min(r, tr.x0); else l = Math.max(l, tr.x1); }
      ['.leaflet-bottom.leaflet-left', '.leaflet-bottom.leaflet-right'].forEach(sel => { const k = cover(c.querySelector(sel)); if (k && k.y1 - k.y0 < size.y / 2) b = Math.min(b, k.y0); });
      // things over part of the map only (the tool hint, at the top while a tool is in use): no label on them
      const hint = cover(document.getElementById('toolHint'));
      return { l: l + 6, r: r - 6, t: t + 6, b: b - 6, avoid: hint ? [hint] : [] };
    },
    // The box a label takes (container px), from its anchor point, as the CSS places it.
    labelBox(p, text, kind, s) {
      const w = text.length * CHAR_PX + 6;
      if (kind === 'v') return { x0: p.x - w / 2, x1: p.x + w / 2, y0: p.y - 14, y1: p.y }; // above its point
      const x0 = p.x + (s.center ? 4 : 0); // right of it
      return { x0, x1: x0 + w, y0: p.y - 14, y1: p.y };
    },
    // Where labels sit: along the bottom and left edges of the clear area, or along its center lines. x: where the
    // labels of horizontal lines go; y: where those of vertical lines go.
    spots() {
      const a = this.safeArea(), center = this.labelMode === 'center';
      return { a, center, x: center ? (a.l + a.r) / 2 : a.l, y: center ? (a.t + a.b) / 2 : a.b };
    },
    // The point where a polyline (container points) crosses x = value (axis 'x') or y = value (axis 'y'), or null.
    crossing(pts, axis, value) {
      for (let i = 1; i < pts.length; i++) {
        const p = pts[i - 1], q = pts[i], vp = axis === 'x' ? p.x : p.y, vq = axis === 'x' ? q.x : q.y;
        if (vp === vq || (vp - value) * (vq - value) > 0) continue;
        const t = (value - vp) / (vq - vp);
        return L.point(p.x + (q.x - p.x) * t, p.y + (q.y - p.y) * t);
      }
      return null;
    },
    // Does a label at p for a vertical ('v') or horizontal ('h') line stay inside the clear area?
    // ...and clear of anything over part of the map (the tool hint)?
    fits(p, text, kind, s) {
      const b = this.labelBox(p, text, kind, s), a = s.a, e = 0.5;
      if (b.x0 < a.l - e || b.x1 > a.r + e || b.y0 < a.t - e || b.y1 > a.b + e) return false;
      return !a.avoid.some(k => b.x0 < k.x1 && b.x1 > k.x0 && b.y0 < k.y1 && b.y1 > k.y0);
    },
    // Labels as markers (dropping any that would overlap one already placed). cls: 'v' / 'h' (a line's), or another
    // kind of label placed where it is (inside the clear area). extra: a class of the grid's own.
    placeLabels(group, pane, labels, extra) {
      const map = MB.map, s = this.spots(), placed = [];
      const hit = (a, b) => a.x0 < b.x1 + 2 && a.x1 > b.x0 - 2 && a.y0 < b.y1 + 2 && a.y1 > b.y0 - 2;
      labels.forEach(l => {
        const p = map.latLngToContainerPoint(l.at);
        let box;
        if (l.cls === 'v' || l.cls === 'h') box = this.labelBox(p, l.text, l.cls, s);
        else { // centered on its point, in its larger type
          const w = l.text.length * CHAR_PX * (l.cls === 'gzd' ? 1.25 : 1.15) + 6;
          box = { x0: p.x - w / 2, x1: p.x + w / 2, y0: p.y - 9, y1: p.y + 9 };
          if (box.x0 < s.a.l || box.x1 > s.a.r || box.y0 < s.a.t || box.y1 > s.a.b || s.a.avoid.some(k => hit(box, k))) return;
        }
        if (placed.some(q => hit(q, box))) return;
        placed.push(box);
        const mid = s.center && (l.cls === 'v' || l.cls === 'h') ? ' mb-grid-mid' : '';
        L.marker(l.at, { pane, interactive: false, keyboard: false, pmIgnore: true,
          icon: L.divIcon({ className: `mb-grid-label mb-grid-${l.cls}${mid}${extra ? ' ' + extra : ''}`, iconSize: null, html: `<span>${MB.escapeHtml(l.text)}</span>` }) }).addTo(group);
      });
    },

    /* ----- the latitude/longitude grid ----- */
    render() {
      const map = MB.map, size = map.getSize();
      this.group.clearLayers();
      if (!size.x || !size.y) return;
      const f = format(), pxPerDeg = 256 * 2 ** map.getZoom() / 360;
      const step = STEPS[f].slice().reverse().find(s => s * pxPerDeg >= MIN_PX) || STEPS[f][0];
      const b = map.getBounds().pad(0.1), W = b.getWest(), E = b.getEast(), S = Math.max(-85, b.getSouth()), N = Math.min(85, b.getNorth());
      const k0 = Math.ceil(W / step - 1e-9), k1 = Math.floor(E / step + 1e-9), j0 = Math.ceil(S / step - 1e-9), j1 = Math.floor(N / step + 1e-9);
      if (k1 - k0 > 400 || j1 - j0 > 400) return;
      const lines = [], major = [], labels = [], s = this.spots();
      for (let k = k0; k <= k1; k++) {
        const x = k * step;
        (Math.abs(((x % 360) + 360) % 360) < 1e-9 ? major : lines).push([[S, x], [N, x]]); // the prime meridian heavier
        const p = this.crossing([map.latLngToContainerPoint([S, x]), map.latLngToContainerPoint([N, x])], 'y', s.y), text = lineLabel(x, 'lng', step, f);
        if (p && this.fits(p, text, 'v', s)) labels.push({ at: map.containerPointToLatLng(p), text, cls: 'v' });
      }
      for (let j = j0; j <= j1; j++) {
        const y = j * step;
        (Math.abs(y) < 1e-9 ? major : lines).push([[y, W], [y, E]]); // the equator heavier
        const p = this.crossing([map.latLngToContainerPoint([y, W]), map.latLngToContainerPoint([y, E])], 'x', s.x), text = lineLabel(y, 'lat', step, f);
        if (p && this.fits(p, text, 'h', s)) labels.push({ at: map.containerPointToLatLng(p), text, cls: 'h' });
      }
      const add = (list, weight, opacity) => { if (list.length) L.polyline(list, { renderer: this.renderer, pane: 'mb-grid', color: COLOR, weight, opacity, interactive: false, pmIgnore: true }).addTo(this.group); };
      add(lines, 1, 0.6);
      add(major, 2, 0.85);
      this.placeLabels(this.group, 'mb-grid', labels, 'mb-grid-ll');
    },

    /* ----- Settings → Grid systems ----- */
    renderSection() {
      const box = document.getElementById('gridSection');
      if (!box) return;
      const sys = this.system, mode = this.labelMode, esc = MB.escapeHtml, off = sys === 'none' ? ' disabled' : '';
      const refocus = MB.ui && MB.ui.focusedRadioGroup ? MB.ui.focusedRadioGroup(box) : null; // a keyboard choice keeps the focus
      const opt = (v, title, desc) => `<button type="button" role="radio" aria-checked="${sys === v}" data-grid="${v}"${sys === v ? ' class="active"' : ''}><span class="opt-title">${esc(title)}</span>${desc ? `<span class="opt-desc">${esc(desc)}</span>` : ''}</button>`;
      box.innerHTML = `<div class="field"><div class="seg stack" role="radiogroup" aria-label="Grid">
          ${opt('none', 'Off', 'No grid on the map')}
          ${opt('latlon', 'Lat/Long Grid', 'Round values of the coordinate format')}
          ${opt('mgrs', 'MGRS Grid', 'Grid zones, then 100 km down to 100 m squares')}
        </div></div>
        <div class="field${sys === 'none' ? ' disabled' : ''}"><span class="field-label">Labels</span>
          <div class="seg" role="radiogroup" aria-label="Grid labels"><button type="button" role="radio" aria-checked="${mode === 'edges'}" data-labels="edges"${off}${mode === 'edges' ? ' class="active"' : ''}>Along the edges</button><button type="button" role="radio" aria-checked="${mode === 'center'}" data-labels="center"${off}${mode === 'center' ? ' class="active"' : ''}>Center lines</button></div></div>
        <p class="field-hint">MGRS references can be searched with any grid.</p>`;
      box.querySelectorAll('[data-grid]').forEach(b => b.addEventListener('click', () => this.setSystem(b.dataset.grid)));
      box.querySelectorAll('[data-labels]').forEach(b => b.addEventListener('click', () => this.setLabels(b.dataset.labels)));
      if (MB.ui && MB.ui.radios) MB.ui.radios(box, refocus);
    }
  };
})(window.MB);
