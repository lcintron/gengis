/* GenGIS - Military Grid Reference System (MGRS)
 * - conversion between latitude/longitude (WGS 84) and MGRS references, through UTM: the grid zones with the Norway
 *   and Svalbard exceptions, 100 km square letters (the AA scheme), 1 to 5 digit precision. Latitudes 80°S to 84°N
 *   (beyond is the polar UPS grid, not handled).
 * - search: a typed reference ("18SUJ2348706483", "18S UJ 234 064", "18SUJ", "18S") centers on its square
 * - an overlay (Settings → Map overlays, off by default): grid zone boundaries, and as the map zooms in the 100 km,
 *   10 km, 1 km and 100 m lines, labelled; saved with the project
 */
window.MB = window.MB || {};
(function (MB) {
  'use strict';

  const DEG = Math.PI / 180;
  const A = 6378137, E2 = 0.00669437999014, K0 = 0.9996, EP2 = E2 / (1 - E2); // WGS 84
  const BANDS = 'CDEFGHJKLMNPQRSTUVWX';        // 8° latitude bands from 80°S; X is 12° (72°N to 84°N)
  const COLS = ['ABCDEFGH', 'JKLMNPQR', 'STUVWXYZ']; // 100 km column letters, by zone (repeat every 3 zones)
  const ROWS = 'ABCDEFGHJKLMNPQRSTUV';         // 100 km row letters (repeat every 2,000 km); even zones start at F

  /* ---------- UTM (Snyder's formulas; northing signed: negative south of the equator) ---------- */
  function toUtm(lat, lon, zone) {
    const phi = lat * DEG, lam0 = ((zone - 1) * 6 - 180 + 3) * DEG;
    let dl = lon * DEG - lam0;
    dl = Math.atan2(Math.sin(dl), Math.cos(dl)); // the copy of the world nearest the zone
    const s = Math.sin(phi), c = Math.cos(phi), t = Math.tan(phi);
    const N = A / Math.sqrt(1 - E2 * s * s), T = t * t, C = EP2 * c * c, Aa = c * dl;
    const e4 = E2 * E2, e6 = e4 * E2;
    const M = A * ((1 - E2 / 4 - 3 * e4 / 64 - 5 * e6 / 256) * phi - (3 * E2 / 8 + 3 * e4 / 32 + 45 * e6 / 1024) * Math.sin(2 * phi)
      + (15 * e4 / 256 + 45 * e6 / 1024) * Math.sin(4 * phi) - (35 * e6 / 3072) * Math.sin(6 * phi));
    const e = K0 * N * (Aa + (1 - T + C) * Aa ** 3 / 6 + (5 - 18 * T + T * T + 72 * C - 58 * EP2) * Aa ** 5 / 120) + 500000;
    const n = K0 * (M + N * t * (Aa * Aa / 2 + (5 - T + 9 * C + 4 * C * C) * Aa ** 4 / 24 + (61 - 58 * T + T * T + 600 * C - 330 * EP2) * Aa ** 6 / 720));
    return { e, n };
  }
  function fromUtm(zone, e, n) {
    const e1 = (1 - Math.sqrt(1 - E2)) / (1 + Math.sqrt(1 - E2)), e4 = E2 * E2, e6 = e4 * E2;
    const x = e - 500000, mu = n / K0 / (A * (1 - E2 / 4 - 3 * e4 / 64 - 5 * e6 / 256));
    const p1 = mu + (3 * e1 / 2 - 27 * e1 ** 3 / 32) * Math.sin(2 * mu) + (21 * e1 * e1 / 16 - 55 * e1 ** 4 / 32) * Math.sin(4 * mu)
      + (151 * e1 ** 3 / 96) * Math.sin(6 * mu) + (1097 * e1 ** 4 / 512) * Math.sin(8 * mu);
    const s = Math.sin(p1), c = Math.cos(p1), t = Math.tan(p1);
    const N1 = A / Math.sqrt(1 - E2 * s * s), T1 = t * t, C1 = EP2 * c * c, R1 = A * (1 - E2) / (1 - E2 * s * s) ** 1.5, D = x / (N1 * K0);
    const lat = p1 - (N1 * t / R1) * (D * D / 2 - (5 + 3 * T1 + 10 * C1 - 4 * C1 * C1 - 9 * EP2) * D ** 4 / 24
      + (61 + 90 * T1 + 298 * C1 + 45 * T1 * T1 - 252 * EP2 - 3 * C1 * C1) * D ** 6 / 720);
    const lon = (D - (1 + 2 * T1 + C1) * D ** 3 / 6 + (5 - 2 * C1 + 28 * T1 - 3 * C1 * C1 + 8 * EP2 + 24 * T1 * T1) * D ** 5 / 120) / c;
    return { lat: lat / DEG, lon: (zone - 1) * 6 - 180 + 3 + lon / DEG };
  }

  /* ---------- grid zones ---------- */
  const bandIndex = lat => (lat < -80 || lat > 84 ? -1 : Math.min(19, Math.floor((lat + 80) / 8)));
  const bandRange = bi => [-80 + bi * 8, bi === 19 ? 84 : -72 + bi * 8];
  // The zones of a band: [zone, west, east] (degrees), with the exceptions around Norway (V) and Svalbard (X).
  const zoneCache = {};
  function zonesOf(bi) {
    if (zoneCache[bi]) return zoneCache[bi];
    let z = [];
    for (let i = 1; i <= 60; i++) z.push([i, -180 + (i - 1) * 6, -180 + i * 6]);
    if (bi === 17) z = z.map(r => (r[0] === 31 ? [31, 0, 3] : r[0] === 32 ? [32, 3, 12] : r));
    if (bi === 19) z = z.filter(r => r[0] < 31 || r[0] > 37).concat([[31, 0, 9], [33, 9, 21], [35, 21, 33], [37, 33, 42]]).sort((a, b) => a[1] - b[1]);
    return (zoneCache[bi] = z);
  }
  function zoneAt(lat, lon) {
    const bi = bandIndex(lat);
    lon = ((lon + 180) % 360 + 360) % 360 - 180;
    const z = zonesOf(Math.max(0, bi)).find(r => lon >= r[1] && lon < r[2]);
    return z ? z[0] : 60;
  }

  const letters100k = (zone, e, n) => {
    const col = COLS[(zone - 1) % 3][Math.floor(e / 100000) - 1];
    const row = ROWS[((Math.floor(n / 100000) + (zone % 2 === 0 ? 5 : 0)) % 20 + 20) % 20];
    return col + row;
  };
  const pad = (v, d) => String(Math.floor(v)).padStart(d, '0');

  // Latitude/longitude to an MGRS reference: { zone, band, square, e, n (metres within the square), text } or null.
  function forward(lat, lon, digits) {
    const bi = bandIndex(lat);
    if (bi < 0) return null;
    digits = digits == null ? 5 : digits;
    const zone = zoneAt(lat, lon), u = toUtm(lat, lon, zone), sq = letters100k(zone, u.e, u.n);
    const ee = ((u.e % 100000) + 100000) % 100000, nn = ((u.n % 100000) + 100000) % 100000, div = 10 ** (5 - digits);
    const de = digits ? pad(ee / div, digits) : '', dn = digits ? pad(nn / div, digits) : '';
    return { zone, band: BANDS[bi], square: sq, e: ee, n: nn, text: `${zone}${BANDS[bi]} ${sq}${digits ? ' ' + de + ' ' + dn : ''}` };
  }

  // The northing at the bottom of a band on the central meridian, rounded down to 100 km: where the band's rows start.
  function bandMinNorthing(bi) { return Math.floor(toUtm(bandRange(bi)[0], -177, 1).n / 100000) * 100000; } // zone 1's central meridian

  // An MGRS reference to its square: { text, zone, band, center (L.LatLng), corners ([sw, se, ne, nw]), size (m) }.
  // Also a 100 km square ("18SUJ") or a grid zone ("18S"). null if it is not a valid reference.
  function parse(input) {
    const s = String(input || '').toUpperCase().replace(/^MGRS[:\s]*/, '').replace(/\s+/g, '');
    let m = /^(\d{1,2})([C-HJ-NP-X])$/.exec(s);
    if (m) { // a grid zone
      const zone = +m[1], bi = BANDS.indexOf(m[2]), z = zone >= 1 && zone <= 60 && zonesOf(bi).find(r => r[0] === zone);
      if (!z) return null;
      const [s0, n0] = bandRange(bi);
      return { text: `${zone}${m[2]}`, zone, band: m[2], size: null,
        center: L.latLng((s0 + n0) / 2, (z[1] + z[2]) / 2), corners: [[s0, z[1]], [s0, z[2]], [n0, z[2]], [n0, z[1]]].map(c => L.latLng(c)) };
    }
    m = /^(\d{1,2})([C-HJ-NP-X])([A-HJ-NP-Z])([A-HJ-NP-V])(\d{0,10})$/.exec(s);
    if (!m || m[5].length % 2) return null;
    const zone = +m[1], bi = BANDS.indexOf(m[2]), digits = m[5].length / 2;
    if (zone < 1 || zone > 60 || !zonesOf(bi).some(r => r[0] === zone)) return null;
    const col = COLS[(zone - 1) % 3].indexOf(m[3]);
    if (col < 0) return null; // that column letter belongs to another zone
    const row = (ROWS.indexOf(m[4]) - (zone % 2 === 0 ? 5 : 0) + 20) % 20;
    const size = 10 ** (5 - digits);
    const e0 = (col + 1) * 100000 + (digits ? +m[5].slice(0, digits) * size : 0);
    let n0 = row * 100000 + (digits ? +m[5].slice(digits) * size : 0);
    const south = bi < 10, min = bandMinNorthing(bi) + (south ? 10000000 : 0); // in false northing: positive
    while (n0 < min) n0 += 2000000;
    if (south) n0 -= 10000000;
    const sq = digits ? size : 100000, half = sq / 2;
    const ll = (e, n) => { const p = fromUtm(zone, e, n); return L.latLng(p.lat, p.lon); };
    const center = ll(e0 + half, n0 + half);
    const [lo, hi] = bandRange(bi);
    if (center.lat < lo - 1 || center.lat > hi + 1) return null; // a row letter that is not in this band
    const de = digits ? m[5].slice(0, digits) : '', dn = digits ? m[5].slice(digits) : '';
    return { text: `${zone}${m[2]} ${m[3]}${m[4]}${digits ? ' ' + de + ' ' + dn : ''}`, zone, band: m[2], size: sq,
      center, corners: [ll(e0, n0), ll(e0 + sq, n0), ll(e0 + sq, n0 + sq), ll(e0, n0 + sq)] };
  }

  /* ---------- the overlay ---------- */
  const GZD = '#ffb000', SQ100 = '#ffd166', FINE = '#ffffff';
  const STEPS = [100000, 10000, 1000, 100];
  const MIN_PX = 48; // px between lines at the least

  MB.mgrs = {
    toUtm, fromUtm, forward, parse, zoneAt,
    group: null, renderer: null,
    get on() { return !!(MB.state.mgrsGrid && MB.state.mgrsGrid.on); },

    init() {
      const pane = MB.map.createPane('mb-mgrs'); // above the data layers and declination, under the place names
      pane.style.zIndex = 363;
      pane.style.pointerEvents = 'none';
      this.renderer = L.canvas({ pane: 'mb-mgrs', padding: 0.1 });
      this.group = L.layerGroup();
      MB.map.on('moveend', () => { if (this.on) this.render(); });
      MB.on('project', () => { this.apply(); if (MB.data && MB.data.renderOverlaysSoon) MB.data.renderOverlaysSoon(); });
      this.apply();
    },

    set(on) {
      MB.state.mgrsGrid = { on: !!on };
      if (MB.autosave) MB.autosave();
      this.apply();
      MB.emit('mgrs'); // the coordinates readout adds or drops the reference
    },
    apply() {
      if (!this.group) return;
      if (this.on) { if (!MB.map.hasLayer(this.group)) this.group.addTo(MB.map); this.render(); }
      else { this.group.clearLayers(); MB.map.removeLayer(this.group); }
    },

    // The lines for the view: the grid zone boundaries always, and the finest UTM grid whose lines stay MIN_PX apart.
    render() {
      const map = MB.map, size = map.getSize();
      this.group.clearLayers();
      if (!size.x || !size.y) return;
      const view = map.getBounds().pad(0.1), z = map.getZoom();
      const S = Math.max(-80, view.getSouth()), N = Math.min(84, view.getNorth());
      if (S >= N) return;
      const mpp = 40075016.686 * Math.cos(map.getCenter().lat * DEG) / (256 * 2 ** z);
      const step = STEPS.slice().reverse().find(s => s / mpp >= MIN_PX) || null;
      const labels = [], lines = { gzd: [], sq: [], fine: [] };
      const W = view.getWest(), E = view.getEast();
      // each copy of the world the view shows: work in -180..180 and draw shifted
      for (let k = Math.floor((W + 180) / 360); k <= Math.floor((E + 180) / 360); k++) {
        const off = k * 360, w = Math.max(-180, W - off), e = Math.min(180, E - off);
        if (w >= e) continue;
        for (let bi = bandIndex(S); bi >= 0 && bi <= bandIndex(N - 1e-9); bi++) {
          const [b0, b1] = bandRange(bi), s = Math.max(S, b0), n = Math.min(N, b1);
          // the band's lower edge
          if (b0 >= S && b0 <= N) lines.gzd.push([[b0, w + off], [b0, e + off]]);
          for (const [zone, z0, z1] of zonesOf(bi)) {
            if (z1 <= w || z0 >= e) continue;
            if (z0 > w || (z0 === -180 && W - off < -180)) lines.gzd.push([[s, z0 + off], [n, z0 + off]]); // the 180° line too, where the view spans it
            const cell = { zone, bi, s, n, w: Math.max(w, z0), e: Math.min(e, z1), off };
            const px = map.latLngToContainerPoint([b1, z1 + off]).x - map.latLngToContainerPoint([b0, z0 + off]).x;
            if (!step && px > 28) labels.push({ at: [(Math.max(b0, S) + Math.min(b1, N)) / 2, (cell.w + cell.e) / 2 + off], text: zone + BANDS[bi], cls: 'gzd' });
            if (step) this.cellLines(cell, step, lines, labels);
          }
        }
        if (N >= 84) lines.gzd.push([[84, w + off], [84, e + off]]);
      }
      const add = (list, color, weight, opacity) => { if (list.length) L.polyline(list, { renderer: this.renderer, pane: 'mb-mgrs', color, weight, opacity, interactive: false, pmIgnore: true }).addTo(this.group); };
      add(lines.fine, FINE, 1, 0.55);
      add(lines.sq, SQ100, 1.4, 0.9);
      add(lines.gzd, GZD, 2.2, 0.95);
      const placed = [];
      labels.forEach(l => {
        const p = map.latLngToContainerPoint(l.at);
        if (p.x < 4 || p.y < 4 || p.x > size.x - 4 || p.y > size.y - 4) return;
        if (placed.some(q => Math.abs(q.x - p.x) < 34 && Math.abs(q.y - p.y) < 16)) return;
        placed.push(p);
        L.marker(l.at, { pane: 'mb-mgrs', interactive: false, keyboard: false, pmIgnore: true,
          icon: L.divIcon({ className: 'mb-mgrs-label mb-mgrs-' + l.cls, iconSize: null, html: `<span>${MB.escapeHtml(l.text)}</span>` }) }).addTo(this.group);
      });
    },

    // The UTM lines of one zone-band cell in view: eastings and northings every `step`, cut at the cell's edges.
    cellLines(cell, step, lines, labels) {
      const map = MB.map, { zone, s, n, w, e, off } = cell;
      const inside = p => p.lat >= s - 1e-9 && p.lat <= n + 1e-9 && p.lon >= w - 1e-9 && p.lon <= e + 1e-9;
      // the cell's extent in UTM, from points around its edge
      let e0 = Infinity, e1 = -Infinity, n0 = Infinity, n1 = -Infinity;
      for (let i = 0; i <= 8; i++) for (const [la, lo] of [[s, w + (e - w) * i / 8], [n, w + (e - w) * i / 8], [s + (n - s) * i / 8, w], [s + (n - s) * i / 8, e]]) {
        const u = toUtm(la, lo, zone);
        e0 = Math.min(e0, u.e); e1 = Math.max(e1, u.e); n0 = Math.min(n0, u.n); n1 = Math.max(n1, u.n);
      }
      if ((e1 - e0) / step > 300 || (n1 - n0) / step > 300) return; // a sliver of a huge view: not worth tracing
      const SAMPLES = 24;
      // A line of constant easting (or northing) from a to b, as the runs inside the cell (edges found by bisection).
      const trace = (fixed, isE, a, b) => {
        const at = t => { const v = a + (b - a) * t; const p = isE ? fromUtm(zone, fixed, v) : fromUtm(zone, v, fixed); return p; };
        const runs = []; let run = null, prevT = 0, prevIn = false;
        const edge = (t0, t1) => { let lo = t0, hi = t1; const in0 = inside(at(lo)); for (let i = 0; i < 18; i++) { const mid = (lo + hi) / 2; if (inside(at(mid)) === in0) lo = mid; else hi = mid; } return at(in0 ? lo : hi); };
        for (let i = 0; i <= SAMPLES; i++) {
          const t = i / SAMPLES, p = at(t), isIn = inside(p);
          if (isIn && !prevIn) { run = []; if (i) run.push(edge(prevT, t)); runs.push(run); }
          if (isIn) run.push(p);
          else if (prevIn) run.push(edge(prevT, t));
          prevT = t; prevIn = isIn;
        }
        return runs.filter(r => r.length > 1).map(r => r.map(p => [p.lat, p.lon + off]));
      };
      const digits = v => (step >= 1000 ? pad((v / 1000) % 100, 2) : pad((v / 100) % 1000, 3)); // the figures a map shows by its lines
      const size = map.getSize();
      for (let v = Math.ceil(e0 / step) * step; v <= e1; v += step) {
        const runs = trace(v, true, n0, n1);
        if (!runs.length) continue;
        (v % 100000 === 0 ? lines.sq : lines.fine).push(...runs);
        if (step < 100000) { // labelled along the bottom of the view
          let best = null;
          runs.forEach(r => r.forEach(ll => { const p = map.latLngToContainerPoint(ll); if (p.y <= size.y - 14 && p.x > 0 && p.x < size.x && (!best || p.y > best.y)) best = { y: p.y, ll }; }));
          if (best) labels.push({ at: best.ll, text: digits(v), cls: 'e' });
        }
      }
      for (let v = Math.ceil(n0 / step) * step; v <= n1; v += step) {
        const runs = trace(v, false, e0, e1);
        if (!runs.length) continue;
        (v % 100000 === 0 ? lines.sq : lines.fine).push(...runs);
        if (step < 100000) { // along the left of the view
          let best = null;
          runs.forEach(r => r.forEach(ll => { const p = map.latLngToContainerPoint(ll); if (p.x >= 40 && p.y > 0 && p.y < size.y && (!best || p.x < best.x)) best = { x: p.x, ll }; }));
          if (best) labels.push({ at: best.ll, text: digits(v + (v < 0 ? 10000000 : 0)), cls: 'n' });
        }
      }
      // the 100 km squares' letters, at their centers
      if (step >= 10000) {
        for (let ve = Math.floor(e0 / 100000) * 100000; ve < e1; ve += 100000) {
          for (let vn = Math.floor(n0 / 100000) * 100000; vn < n1; vn += 100000) {
            const c = fromUtm(zone, ve + 50000, vn + 50000);
            if (ve < 100000 || ve >= 900000 || !inside(c)) continue;
            labels.push({ at: [c.lat, c.lon + off], text: (step === 100000 ? zone + BANDS[cell.bi] + ' ' : '') + letters100k(zone, ve + 1, vn + 1), cls: 'sq' });
          }
        }
      }
    },

    /* ----- Settings → Map overlays ----- */
    overlayHtml() {
      return `<div class="overlay-item"><label class="check" style="margin:0"><input type="checkbox" data-mgrs-grid${this.on ? ' checked' : ''}> <span>MGRS grid</span></label>
        <div class="note" style="margin-left:23px">Military Grid Reference System: grid zones, then 100 km, 10 km, 1 km and 100 m squares as you zoom in. MGRS references can be searched with this off too.</div></div>`;
    },
    bindOverlays(box) {
      const cb = box.querySelector('input[data-mgrs-grid]');
      if (cb) cb.addEventListener('change', () => this.set(cb.checked));
    }
  };
})(window.MB);
