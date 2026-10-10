/* GenGIS - magnetic declination (Data tab)
 * - the World Magnetic Model (WMM2025, NOAA NCEI / BGS, public domain), computed on the device: no service, works
 *   offline, valid 2025.0 to 2030.0
 * - isogonic lines (equal declination) for the map view: east red, west blue, the agonic line (zero) green, closer
 *   together as the map zooms in
 * - a click on the map adds the declination there, and the heading correction, to the click popup
 * On or off is saved with the project; nothing else is stored.
 */
window.MB = window.MB || {};
(function (MB) {
  'use strict';

  const esc = MB.escapeHtml;
  const EPOCH = 2025.0, VALID_TO = 2030.0;
  const NOAA = 'https://www.ngdc.noaa.gov/geomag/calculators/magcalc.shtml?useFullSite=true#declination';
  const CELL = 32;          // px between grid points the lines are traced through
  const EAST = '#ff6b6b', WEST = '#5aa9ff', AGONIC = '#3ddc84';
  // WMM2025 Gauss coefficients [g, h, dg/dt, dh/dt] (nT, nT/yr), n = 1..12, m = 0..n, from NOAA's WMM.COF
  const COEFFS = [
    [-29351.8, 0, 12, 0], [-1410.8, 4545.4, 9.7, -21.5],
    [-2556.6, 0, -11.6, 0], [2951.1, -3133.6, -5.2, -27.7], [1649.3, -815.1, -8, -12.1],
    [1361, 0, -1.3, 0], [-2404.1, -56.6, -4.2, 4], [1243.8, 237.5, 0.4, -0.3], [453.6, -549.5, -15.6, -4.1],
    [895, 0, -1.6, 0], [799.5, 278.6, -2.4, -1.1], [55.7, -133.9, -6, 4.1], [-281.1, 212, 5.6, 1.6], [12.1, -375.6, -7, -4.4],
    [-233.2, 0, 0.6, 0], [368.9, 45.4, 1.4, -0.5], [187.2, 220.2, 0, 2.2], [-138.7, -122.9, 0.6, 0.4], [-142, 43, 2.2, 1.7], [20.9, 106.1, 0.9, 1.9],
    [64.4, 0, -0.2, 0], [63.8, -18.4, -0.4, 0.3], [76.9, 16.8, 0.9, -1.6], [-115.7, 48.8, 1.2, -0.4], [-40.9, -59.8, -0.9, 0.9], [14.9, 10.9, 0.3, 0.7], [-60.7, 72.7, 0.9, 0.9],
    [79.5, 0, 0, 0], [-77, -48.9, -0.1, 0.6], [-8.8, -14.4, -0.1, 0.5], [59.3, -1, 0.5, -0.8], [15.8, 23.4, -0.1, 0], [2.5, -7.4, -0.8, -1], [-11.1, -25.1, -0.8, 0.6], [14.2, -2.3, 0.8, -0.2],
    [23.2, 0, -0.1, 0], [10.8, 7.1, 0.2, -0.2], [-17.5, -12.6, 0, 0.5], [2, 11.4, 0.5, -0.4], [-21.7, -9.7, -0.1, 0.4], [16.9, 12.7, 0.3, -0.5], [15, 0.7, 0.2, -0.6], [-16.8, -5.2, 0, 0.3], [0.9, 3.9, 0.2, 0.2],
    [4.6, 0, 0, 0], [7.8, -24.8, -0.1, -0.3], [3, 12.2, 0.1, 0.3], [-0.2, 8.3, 0.3, -0.3], [-2.5, -3.3, -0.3, 0.3], [-13.1, -5.2, 0, 0.2], [2.4, 7.2, 0.3, -0.1], [8.6, -0.6, -0.1, -0.2], [-8.7, 0.8, 0.1, 0.4], [-12.9, 10, -0.1, 0.1],
    [-1.3, 0, 0.1, 0], [-6.4, 3.3, 0, 0], [0.2, 0, 0.1, 0], [2, 2.4, 0.1, -0.2], [-1, 5.3, 0, 0.1], [-0.6, -9.1, -0.3, -0.1], [-0.9, 0.4, 0, 0.1], [1.5, -4.2, -0.1, 0], [0.9, -3.8, -0.1, -0.1], [-2.7, 0.9, 0, 0.2], [-3.9, -9.1, 0, 0],
    [2.9, 0, 0, 0], [-1.5, 0, 0, 0], [-2.5, 2.9, 0, 0.1], [2.4, -0.6, 0, 0], [-0.6, 0.2, 0, 0.1], [-0.1, 0.5, -0.1, 0], [-0.6, -0.3, 0, 0], [-0.1, -1.2, 0, 0.1], [1.1, -1.7, -0.1, 0], [-1, -2.9, -0.1, 0], [-0.2, -1.8, -0.1, 0], [2.6, -2.3, -0.1, 0],
    [-2, 0, 0, 0], [-0.2, -1.3, 0, 0], [0.3, 0.7, 0, 0], [1.2, 1, 0, -0.1], [-1.3, -1.4, 0, 0.1], [0.6, 0, 0, 0], [0.6, 0.6, 0.1, 0], [0.5, -0.1, 0, 0], [-0.1, 0.8, 0, 0], [-0.4, 0.1, 0, 0], [-0.2, -1, -0.1, 0], [-1.3, 0.1, 0, 0], [-0.7, 0.2, -0.1, -0.1]
  ];

  /* ---------- the model (after NOAA's GeoMag reference code) ---------- */
  const MAXORD = 12, A = 6378.137, B = 6356.7523142, RE = 6371.2;
  const A2 = A * A, B2 = B * B, C2 = A2 - B2, A4 = A2 * A2, B4 = B2 * B2, C4 = A4 - B4;
  const grid = () => Array.from({ length: MAXORD + 1 }, () => new Float64Array(MAXORD + 1));
  const c = grid(), cd = grid(), k = grid(), snorm = grid();
  const fn = new Float64Array(MAXORD + 1), fm = new Float64Array(MAXORD + 1);
  (function setup() {
    let i = 0;
    for (let n = 1; n <= MAXORD; n++) for (let m = 0; m <= n; m++) {
      const [g, h, dg, dh] = COEFFS[i++];
      c[m][n] = g; cd[m][n] = dg;
      if (m) { c[n][m - 1] = h; cd[n][m - 1] = dh; }
    }
    // Schmidt semi-normalized to unnormalized
    snorm[0][0] = 1;
    for (let n = 1; n <= MAXORD; n++) {
      snorm[0][n] = snorm[0][n - 1] * (2 * n - 1) / n;
      let j = 2;
      for (let m = 0; m <= n; m++) {
        k[m][n] = ((n - 1) * (n - 1) - m * m) / ((2 * n - 1) * (2 * n - 3));
        if (m > 0) {
          snorm[m][n] = snorm[m - 1][n] * Math.sqrt((n - m + 1) * j / (n + m));
          j = 1;
          c[n][m - 1] *= snorm[m][n]; cd[n][m - 1] *= snorm[m][n];
        }
        c[m][n] *= snorm[m][n]; cd[m][n] *= snorm[m][n];
      }
      fn[n] = n + 1; fm[n] = n;
    }
    k[1][1] = 0;
  })();

  const tc = grid(), p = grid(), dp = grid();
  const sp = new Float64Array(MAXORD + 1), cp = new Float64Array(MAXORD + 1), pp = new Float64Array(MAXORD + 1);
  // The field at a place: declination and inclination (degrees), horizontal and total intensity (nT).
  // lat, lon in degrees (geodetic), alt in km above the WGS 84 ellipsoid, year as a decimal year.
  function field(lat, lon, alt, year) {
    const dt = year - EPOCH, rlat = lat * Math.PI / 180, rlon = lon * Math.PI / 180;
    const srlat = Math.sin(rlat), crlat = Math.cos(rlat), srlat2 = srlat * srlat, crlat2 = crlat * crlat;
    sp[0] = 0; cp[0] = 1; pp[0] = 1; p[0][0] = 1; dp[0][0] = 0;
    sp[1] = Math.sin(rlon); cp[1] = Math.cos(rlon);
    // geodetic to spherical
    const q = Math.sqrt(A2 - C2 * srlat2), q1 = alt * q, q2 = ((q1 + A2) / (q1 + B2)) ** 2;
    const ct = srlat / Math.sqrt(q2 * crlat2 + srlat2), st = Math.sqrt(1 - ct * ct);
    const r = Math.sqrt(alt * alt + 2 * q1 + (A4 - C4 * srlat2) / (q * q));
    const d = Math.sqrt(A2 * crlat2 + B2 * srlat2), ca = (alt + d) / r, sa = C2 * crlat * srlat / (r * d);
    for (let m = 2; m <= MAXORD; m++) { sp[m] = sp[1] * cp[m - 1] + cp[1] * sp[m - 1]; cp[m] = cp[1] * cp[m - 1] - sp[1] * sp[m - 1]; }
    const aor = RE / r;
    let ar = aor * aor, br = 0, bt = 0, bp = 0, bpp = 0;
    for (let n = 1; n <= MAXORD; n++) {
      ar *= aor;
      for (let m = 0; m <= n; m++) {
        // associated Legendre functions and their derivatives
        if (n === m) { p[m][n] = st * p[m - 1][n - 1]; dp[m][n] = st * dp[m - 1][n - 1] + ct * p[m - 1][n - 1]; }
        else if (n === 1 && m === 0) { p[m][n] = ct * p[m][n - 1]; dp[m][n] = ct * dp[m][n - 1] - st * p[m][n - 1]; }
        else if (n > 1 && n !== m) {
          if (m > n - 2) { p[m][n - 2] = 0; dp[m][n - 2] = 0; }
          p[m][n] = ct * p[m][n - 1] - k[m][n] * p[m][n - 2];
          dp[m][n] = ct * dp[m][n - 1] - st * p[m][n - 1] - k[m][n] * dp[m][n - 2];
        }
        // the coefficients at this date
        tc[m][n] = c[m][n] + dt * cd[m][n];
        if (m) tc[n][m - 1] = c[n][m - 1] + dt * cd[n][m - 1];
        const par = ar * p[m][n];
        let t1, t2;
        if (m === 0) { t1 = tc[m][n] * cp[m]; t2 = tc[m][n] * sp[m]; }
        else { t1 = tc[m][n] * cp[m] + tc[n][m - 1] * sp[m]; t2 = tc[m][n] * sp[m] - tc[n][m - 1] * cp[m]; }
        bt -= ar * t1 * dp[m][n];
        bp += fm[m] * t2 * par;
        br += fn[n] * t1 * par;
        if (st === 0 && m === 1) { // at a geographic pole
          pp[n] = n === 1 ? pp[n - 1] : ct * pp[n - 1] - k[m][n] * pp[n - 2];
          bpp += fm[m] * t2 * ar * pp[n];
        }
      }
    }
    bp = st === 0 ? bpp : bp / st;
    // spherical to geodetic components: north, east, down
    const bx = -bt * ca - br * sa, by = bp, bz = bt * sa - br * ca;
    const bh = Math.sqrt(bx * bx + by * by);
    return { dec: Math.atan2(by, bx) * 180 / Math.PI, inc: Math.atan2(bz, bh) * 180 / Math.PI, h: bh, f: Math.sqrt(bh * bh + bz * bz) };
  }

  function decimalYear(date) {
    const y = date.getUTCFullYear(), start = Date.UTC(y, 0, 1), end = Date.UTC(y + 1, 0, 1);
    return y + (date.getTime() - start) / (end - start);
  }
  // The model's date: today, within the years it covers.
  const modelYear = () => Math.min(VALID_TO, Math.max(EPOCH, decimalYear(new Date())));
  const declination = (lat, lon, year) => field(lat, lon, 0, year == null ? modelYear() : year).dec;

  const fmt = (deg, dp) => `${Math.abs(deg).toFixed(dp)}° ${deg >= 0 ? 'E' : 'W'}`;
  const signed = (deg, dp) => (deg >= 0 ? '+' : '−') + Math.abs(deg).toFixed(dp) + '°';

  // The spacing of the lines at a zoom (degrees).
  const interval = z => (z < 3 ? 10 : z < 5 ? 5 : z < 7 ? 2 : z < 9 ? 1 : z < 11 ? 0.5 : z < 13 ? 0.25 : 0.1);
  const trim = s => (s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s); // 7.50 -> 7.5, 10 stays 10
  const levelText = (v, iv) => (Math.abs(v) < 1e-9 ? '0°' : trim(Math.abs(v).toFixed(iv < 1 ? (iv < 0.25 ? 1 : 2) : 0)) + '°' + (v > 0 ? 'E' : 'W'));

  /* ---------- the module ---------- */
  MB.declination = {
    field, declination, decimalYear,
    group: null, labels: null, renderer: null,
    get on() { return !!(MB.state.declination && MB.state.declination.on); },

    init() {
      const pane = MB.map.createPane('mb-decl'); // above the data layers, under place names and live traffic
      pane.style.zIndex = 362;
      pane.style.pointerEvents = 'none';
      this.renderer = L.canvas({ pane: 'mb-decl', padding: 0.1 });
      this.group = L.layerGroup();
      MB.map.on('moveend', () => { if (this.on) this.render(); this.tickStatus(); });
      MB.on('project', () => { this.apply(); if (MB.data.renderPanelSoon) MB.data.renderPanelSoon(); }); // its checkbox too
      this.apply();
    },

    enabledCount() { return this.on ? 1 : 0; },

    set(on) {
      MB.state.declination = { on: !!on };
      if (MB.autosave) MB.autosave();
      this.apply();
      MB.emit('data');
    },
    toggle() { this.set(!this.on); },

    apply() {
      if (!this.group) return;
      if (this.on) { if (!MB.map.hasLayer(this.group)) this.group.addTo(MB.map); this.render(); }
      else { this.group.clearLayers(); MB.map.removeLayer(this.group); }
      this.tickStatus();
    },

    // Isogonic lines for the view: the declination on a grid of screen points, traced by marching squares.
    render() {
      const map = MB.map, size = map.getSize(), year = modelYear(), iv = interval(map.getZoom());
      const padX = Math.round(size.x * 0.1), padY = Math.round(size.y * 0.1);
      const cols = Math.ceil((size.x + 2 * padX) / CELL) + 1, rows = Math.ceil((size.y + 2 * padY) / CELL) + 1;
      const px = i => i * CELL - padX, py = j => j * CELL - padY;
      const v = new Float64Array(cols * rows);
      let lo = Infinity, hi = -Infinity;
      for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
        const ll = map.containerPointToLatLng([px(i), py(j)]);
        const lat = Math.max(-89.99, Math.min(89.99, ll.lat));
        const d = v[j * cols + i] = declination(lat, ll.lng, year);
        if (d < lo) lo = d; if (d > hi) hi = d;
      }
      const lines = new Map(); // level -> [[[x, y], [x, y]], ...] in screen px
      const at = (a, b, va, vb, L) => { const t = (L - va) / (vb - va); return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]; };
      for (let L = Math.ceil(lo / iv) * iv; L <= hi + 1e-9; L += iv) {
        const level = Math.round(L / iv) * iv, segs = [];
        for (let j = 0; j < rows - 1; j++) for (let i = 0; i < cols - 1; i++) {
          const v0 = v[j * cols + i], v1 = v[j * cols + i + 1], v2 = v[(j + 1) * cols + i + 1], v3 = v[(j + 1) * cols + i];
          // near a magnetic pole the declination swings through ±180°: no line across that seam
          if (Math.max(v0, v1, v2, v3) - Math.min(v0, v1, v2, v3) > 90) continue;
          const p0 = [px(i), py(j)], p1 = [px(i + 1), py(j)], p2 = [px(i + 1), py(j + 1)], p3 = [px(i), py(j + 1)];
          const edges = [];
          if ((v0 < level) !== (v1 < level)) edges.push(at(p0, p1, v0, v1, level));
          if ((v1 < level) !== (v2 < level)) edges.push(at(p1, p2, v1, v2, level));
          if ((v2 < level) !== (v3 < level)) edges.push(at(p2, p3, v2, v3, level));
          if ((v3 < level) !== (v0 < level)) edges.push(at(p3, p0, v3, v0, level));
          if (edges.length === 2) segs.push(edges);
          else if (edges.length === 4) { segs.push([edges[0], edges[1]], [edges[2], edges[3]]); } // a saddle: either pairing reads the same at this size
        }
        if (segs.length) lines.set(level, segs);
      }
      this.group.clearLayers();
      const toLL = pt => map.containerPointToLatLng(pt);
      const placed = [];
      lines.forEach((segs, level) => {
        const color = Math.abs(level) < 1e-9 ? AGONIC : (level > 0 ? EAST : WEST);
        L.polyline(segs.map(s => s.map(toLL)), { renderer: this.renderer, pane: 'mb-decl', color, weight: Math.abs(level) < 1e-9 ? 2.5 : 1.6, opacity: .9, interactive: false, pmIgnore: true }).addTo(this.group);
        // labels along the line, apart from each other and from the other lines' labels
        segs.forEach(s => {
          const m = [(s[0][0] + s[1][0]) / 2, (s[0][1] + s[1][1]) / 2];
          if (m[0] < 30 || m[1] < 20 || m[0] > size.x - 30 || m[1] > size.y - 20) return;
          if (placed.some(q => (q[2] === level ? 260 : 60) > Math.hypot(q[0] - m[0], q[1] - m[1]))) return;
          placed.push([m[0], m[1], level]);
          L.marker(toLL(m), { pane: 'mb-decl', interactive: false, keyboard: false, pmIgnore: true,
            icon: L.divIcon({ className: 'mb-decl-label', iconSize: null, html: `<span style="color:${color}">${levelText(level, iv)}</span>` }) }).addTo(this.group);
        });
      });
    },

    // The declination at a point, for the click popup: a section like a dataset's.
    identifyHtml(latlng) {
      if (!this.on) return '';
      const year = modelYear(), lat = Math.max(-90, Math.min(90, latlng.lat)), lon = latlng.lng;
      const f = field(lat, lon, 0, year), dec = f.dec;
      // per year: the shortest way round (near a pole the declination can cross ±180° within the year)
      const rate = ((field(lat, lon, 0, year + 0.5).dec - field(lat, lon, 0, year - 0.5).dec) % 360 + 540) % 360 - 180;
      const date = new Date().toISOString().slice(0, 10), stale = decimalYear(new Date()) > VALID_TO;
      const rows = [
        ['Declination', `<b>${fmt(dec, 2)}</b> <span class="dim">(${signed(dec, 2)})</span>`],
        ['Heading correction', `${signed(dec, 1)}: true = magnetic ${dec >= 0 ? '+' : '−'} ${Math.abs(dec).toFixed(1)}°`],
        ['', `<span class="dim">magnetic = true ${dec >= 0 ? '−' : '+'} ${Math.abs(dec).toFixed(1)}°</span>`],
        ['Annual change', `${Math.abs(rate).toFixed(2)}° ${rate >= 0 ? 'E' : 'W'} per year`],
        ['Inclination', `${f.inc.toFixed(1)}°`],
        ['Model', `WMM2025 · ${date}${stale ? ' <span class="warn">(beyond 2030: out of date)</span>' : ''} · sea level`]
      ].map(([k, val]) => `<tr><td>${esc(k)}</td><td>${val}</td></tr>`).join('');
      return `<details class="mb-ident mb-ident-pt" name="mb-ident"><summary><span class="mb-ident-ds">Magnetic declination</span><span class="mb-ident-label">${fmt(dec, 1)}</span></summary><table class="mb-datatable">${rows}</table><div class="mb-ident-note dim">East declination is added to a magnetic heading to get the true heading; west is subtracted. <a href="${NOAA}" target="_blank" rel="noopener">NOAA calculator</a></div></details>`;
    },

    statusText() {
      if (!this.on) return 'Off';
      const ll = MB.map.getCenter(), dec = declination(Math.max(-90, Math.min(90, ll.lat)), ll.lng);
      return `At the map center: ${fmt(dec, 1)} · lines every ${levelText(interval(MB.map.getZoom()), interval(MB.map.getZoom())).replace(/[EW]$/, '')}`;
    },
    tickStatus() {
      const el = document.getElementById('declStatus');
      if (el) { const t = this.statusText(); if (el.textContent !== t) el.textContent = t; }
      const b = document.getElementById('declCount');
      if (b) { const t = this.on ? '1/1 on' : '0/1 on'; if (b.textContent !== t) b.textContent = t; }
    },

    matches(q, filter) {
      if (filter === 'on' && !this.on) return false;
      if (filter === 'off' && this.on) return false;
      return !q || 'magnetic declination variation compass heading isogonic wmm noaa'.includes(q);
    },

    panelHtml(q, filter) {
      if (!this.matches(q, filter)) return '';
      const on = this.on;
      return `<details class="ds-source" id="declSource" data-src="declination"${MB.data.sourceOpen('declination') ? ' open' : ''}><summary class="ds-source-head"><h3>Magnetic declination</h3><span class="badge" id="declCount">${on ? '1/1 on' : '0/1 on'}</span></summary>
        <p class="note">The World Magnetic Model (WMM2025, NOAA), computed on this device.</p>
        <div class="data-item${on ? ' on' : ''}" data-decl="wmm">
          <div class="ds-head"><label class="check"><input type="checkbox" data-act="decl-toggle"${on ? ' checked' : ''}> <span class="dname">Isogonic lines</span></label>${MB.data.infoIcon('Lines of equal magnetic declination, closer together as you zoom in. Click the map for the declination and heading correction at that point.')}</div>
          <div class="legend"><span><i style="background:${EAST}"></i>East</span><span><i style="background:${WEST}"></i>West</span><span><i style="background:${AGONIC}"></i>Zero (agonic)</span></div>
          <div class="dstatus" id="declStatus">${esc(this.statusText())}</div>
        </div></details>`;
    },

    bindPanel(panel) {
      const cb = panel.querySelector('[data-act="decl-toggle"]');
      if (cb) cb.addEventListener('change', () => this.set(cb.checked));
    }
  };
})(window.MB);
