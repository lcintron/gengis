/* GenGIS - flight log tracks (shared by the MAVLink and Betaflight log readers)
 * - each log a reader opens becomes a track layer: one line per vehicle in the log, colored by a property
 *   (speed, altitude, flight mode or vertical speed) or in its own color; several logs overlay
 * - a shared time bar on the map: dragging or playing it moves a marker along every visible track to the same moment
 *   (logs with UTC time align on it; logs without align at their start, at the start of the earliest UTC log, or
 *   of the time line); its legend shows the colors in use
 * - click a track for the values logged at that point
 * Logs live in memory for the session only: nothing is stored or saved with a project (a log can be hundreds of MB;
 * opening the file again is quicker than keeping a copy in the browser's storage).
 *
 * API (the readers call it; nothing here reads files):
 *   MB.trackLogs.add(log) -> id (a string), or null when the log has no point with a position (nothing is added).
 *     log = { source: 'mavlink' | 'betaflight', name, timeBase: 'utc' | 'relative',
 *             fields: { key: { label, unit } }   (optional: how to show extra point fields; common keys are known)
 *             vehicles: [{ key, label, points: [{ t, lat, lon, alt, altRef: 'msl' | 'rel', speed, mode, ...numbers }] }] }
 *     t: ms (UTC epoch for 'utc', from the log's start for 'relative'); lat, lon: degrees; alt: m; speed: m/s over
 *     the ground (worked out from the positions when missing); mode: string or null.
 *     Points without a real position (missing, out of range, or 0,0) are dropped here too, and points are put in time
 *     order; a vehicle left with no point is dropped, and a log left with no vehicle is not added.
 *     Extra numeric fields known by key (unit): climb (m/s up; worked out from alt when missing), amsl (m, when alt is
 *     relative), heading (deg), airspeed (m/s), volt (V), curr (A), batt (%), mah, sats, hdop, throttle (%),
 *     rssi (%), roll, pitch (deg). Any other key shows as given, with its fields entry when there is one.
 *     Altitude colors are by height above the vehicle's start: a relative altitude as given, an MSL altitude less
 *     the vehicle's first one.
 *   MB.trackLogs.remove(id)
 *   MB.trackLogs.list(source?) -> [{ id, source, name, timeBase, start, end, colorBy, visible, color,
 *     vehicles: [{ key, label, color, count }] }]   (start, end: ms on the log's own time base)
 *   MB.trackLogs.COLOR_BY: [{ id, name }]: 'track' (the log's own color; the default), 'speed', 'alt', 'mode', 'climb'
 *   MB.trackLogs.setColorBy(id, prop), MB.trackLogs.setVisible(id, on), MB.trackLogs.zoomTo(id)
 *   MB.trackLogs.renderList(container, { source }): that source's logs and their controls (visibility, color by,
 *     legend, zoom to, remove) in the container; it stays current as logs come and go. listHtml(source) is the same
 *     list as HTML, for a panel built from a string (renderList then binds it).
 *   MB.trackLogs.timeline() -> { start, end, utc } on the shared time line (ms), or null with no visible log
 *   MB.trackLogs.offset(id) -> ms added to that log's times to place it on the shared time line
 *   MB.trackLogs.seek(t), play(), pause(), time() -> the shared time line's current moment
 *   MB.trackLogs.positionAt(id, vehicleKey, t) -> { lat, lon, alt, heading, point } at shared time t (between two
 *     points: in proportion), or null outside the vehicle's time
 *   MB.on('tracklogs', fn): logs were added, removed or changed
 *   MB.trackLogs.modeColor(mode) -> a flight mode's color (by what the mode does: the same in every log)
 */
window.MB = window.MB || {};
(function (MB) {
  'use strict';

  const esc = s => (MB.escapeHtml ? MB.escapeHtml(s) : String(s));
  const PALETTE = ['#ff8a3d', '#3fd0f0', '#c792ff', '#8fd14f', '#ff5c8a', '#f7c12b', '#4f8cff', '#2fd6a0', '#ff6b4a', '#a8b4ff'];
  const RAMP = ['#3b4cc0', '#2fb5d6', '#7bd13f', '#f7c12b', '#e8443a'];       // low to high
  const DIVERGE = ['#2c7bb6', '#7fc4e6', '#e2e6ea', '#fdae61', '#d7191c'];   // descending, level, climbing
  const NO_VALUE = '#8d9aad';
  const STEPS = 12;           // colors along a ramp
  const MAX_DRAWN = 8000;     // points drawn per vehicle (every point is kept for the time bar and a click)
  const RATES = [1, 2, 5, 10, 30, 60, 120];
  const COLOR_BY = [
    { id: 'track', name: 'Log color' },
    { id: 'speed', name: 'Speed' },
    { id: 'alt', name: 'Altitude' },
    { id: 'mode', name: 'Flight mode' },
    { id: 'climb', name: 'Vertical speed' }
  ];
  // flight modes by what they do, the same color in every log; others take the next free color
  const MODE_KIND = [
    [/rtl|return|rth|home|rescue/i, '#e8443a'], [/land|failsafe/i, '#ff8a3d'], [/auto|mission|takeoff|waypoint/i, '#8fd14f'],
    [/alt|depth|cruise|fbwb/i, '#2fd6a0'], // (before hold: AltHold and "Altitude hold" hold height, not position)
    [/loiter|hold|poshold|position|circle|orbit|brake/i, '#4f8cff'], [/guided|offboard|follow/i, '#c792ff'],
    [/stabil|manual|acro|horizon|angle|fbwa|training|sport/i, '#d9dee5']
  ];
  const MODE_SPARE = ['#f7c12b', '#ff5c8a', '#3fd0f0', '#c9a26b', '#a8b4ff', '#9be15d', '#ff9ecf'];
  const KNOWN = {
    climb: ['Vertical speed', 'vs'], amsl: ['Altitude MSL', 'alt'], heading: ['Heading', '°'], airspeed: ['Airspeed', 'speed'],
    volt: ['Battery', 'V'], curr: ['Current', 'A'], batt: ['Battery left', '%'], mah: ['Used', 'mAh'], sats: ['Satellites', ''],
    hdop: ['HDOP', ''], throttle: ['Throttle', '%'], rssi: ['RSSI', '%'], roll: ['Roll', '°'], pitch: ['Pitch', '°']
  };
  const BASE_KEYS = new Set(['t', 'lat', 'lon', 'alt', 'altRef', 'speed', 'mode', 'h']);

  const logs = new Map(); // id -> log
  let seq = 0, modeColors = new Map(), spareUsed = 0;
  const lists = new Set(); // containers renderList keeps current

  /* ---------- numbers ---------- */
  const num = x => (typeof x === 'number' && isFinite(x) ? x : null);
  const validLL = (lat, lon) => num(lat) != null && num(lon) != null && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && !(lat === 0 && lon === 0);
  function dist(a, b) { // m (haversine)
    const R = 6371008.8, rad = Math.PI / 180;
    const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }
  function bearing(a, b) {
    const rad = Math.PI / 180, y = Math.sin((b.lon - a.lon) * rad) * Math.cos(b.lat * rad);
    const x = Math.cos(a.lat * rad) * Math.sin(b.lat * rad) - Math.sin(a.lat * rad) * Math.cos(b.lat * rad) * Math.cos((b.lon - a.lon) * rad);
    return (Math.atan2(y, x) / rad + 360) % 360;
  }
  function quantile(sorted, q) { if (!sorted.length) return null; return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))]; }
  function sample(vals, max) { if (vals.length <= max) return vals; const step = vals.length / max, out = []; for (let i = 0; i < max; i++) out.push(vals[Math.floor(i * step)]); return out; }

  // The points of one vehicle, cleaned: a real position, in time order, speed and climb filled in where missing, and
  // h (the height above the start) for the altitude colors.
  function clean(points) {
    const pts = [];
    (points || []).forEach(p => {
      if (!p || num(p.t) == null || !validLL(p.lat, p.lon)) return;
      const q = Object.assign({}, p);
      q.alt = num(p.alt); q.speed = num(p.speed); q.mode = p.mode == null || p.mode === '' ? null : String(p.mode);
      q.altRef = p.altRef === 'rel' ? 'rel' : 'msl';
      pts.push(q);
    });
    let sorted = true;
    for (let i = 1; i < pts.length; i++) if (pts[i].t < pts[i - 1].t) { sorted = false; break; }
    if (!sorted) pts.sort((a, b) => a.t - b.t);
    const first = pts.find(p => p.alt != null && p.altRef === 'msl');
    const ref = first ? first.alt : 0;
    let j = 0;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      p.h = p.alt == null ? null : (p.altRef === 'rel' ? p.alt : p.alt - ref);
      // speed and climb over about a second around the point, from the neighbours
      if (p.speed == null || num(p.climb) == null) {
        while (j < i && p.t - pts[j].t > 1000) j++;
        let k = i; while (k < pts.length - 1 && pts[k + 1].t - p.t <= 1000) k++;
        const a = pts[j === i && i > 0 ? i - 1 : j], b = pts[k === i && i < pts.length - 1 ? i + 1 : k], dt = (b.t - a.t) / 1000;
        if (dt > 0) {
          if (p.speed == null) p.speed = dist(a, b) / dt;
          if (num(p.climb) == null && a.alt != null && b.alt != null) p.climb = (b.alt - a.alt) / dt;
        }
      }
    }
    return pts;
  }

  /* ---------- colors ---------- */
  function mix(c1, c2, f) {
    const a = parseInt(c1.slice(1), 16), b = parseInt(c2.slice(1), 16);
    const ch = s => Math.round(((a >> s) & 255) * (1 - f) + ((b >> s) & 255) * f);
    return '#' + ((1 << 24) | (ch(16) << 16) | (ch(8) << 8) | ch(0)).toString(16).slice(1);
  }
  function rampColor(stops, f) {
    f = Math.max(0, Math.min(1, f)) * (stops.length - 1);
    const i = Math.min(stops.length - 2, Math.floor(f));
    return mix(stops[i], stops[i + 1], f - i);
  }
  function modeColor(mode) {
    if (mode == null) return NO_VALUE;
    let c = modeColors.get(mode);
    if (!c) {
      const k = MODE_KIND.find(([re]) => re.test(mode));
      c = k ? k[1] : MODE_SPARE[spareUsed++ % MODE_SPARE.length];
      modeColors.set(mode, c);
    }
    return c;
  }
  const valueOf = (p, prop) => (prop === 'speed' ? p.speed : prop === 'alt' ? p.h : prop === 'climb' ? num(p.climb) : null);

  // The scale of each property: shared by every visible log colored by it, so the same color means the same value.
  function ranges() {
    const out = {};
    ['speed', 'alt', 'climb'].forEach(prop => {
      let vals = [];
      logs.forEach(l => {
        if (!l.visible || l.colorBy !== prop) return;
        l.vehicles.forEach(v => { const s = []; v.pts.forEach(p => { const x = valueOf(p, prop); if (x != null) s.push(x); }); vals = vals.concat(sample(s, 4000)); });
      });
      if (!vals.length) return;
      vals.sort((a, b) => a - b);
      if (prop === 'speed') out.speed = { lo: 0, hi: Math.max(1, quantile(vals, 0.98)) };
      else if (prop === 'alt') { const lo = quantile(vals, 0.02), hi = quantile(vals, 0.98); out.alt = { lo, hi: Math.max(hi, lo + 5) }; }
      else { const m = Math.max(0.5, Math.abs(quantile(vals, 0.02)), Math.abs(quantile(vals, 0.98))); out.climb = { lo: -m, hi: m }; }
    });
    return out;
  }
  // The color of a point: by step along the ramp, so a track is drawn as a few runs of one color each.
  function pointColor(p, prop, rg, base) {
    if (prop === 'track') return base;
    if (prop === 'mode') return modeColor(p.mode);
    const x = valueOf(p, prop), r = rg[prop];
    if (x == null || !r) return NO_VALUE;
    const f = Math.round((x - r.lo) / (r.hi - r.lo) * (STEPS - 1)) / (STEPS - 1);
    return rampColor(prop === 'climb' ? DIVERGE : RAMP, f);
  }

  /* ---------- formatting ---------- */
  const units = () => (MB.state && MB.state.units) || 'metric';
  function fmtAlt(m) { return units() === 'metric' ? `${Math.round(m)} m` : `${Math.round(m * 3.28084)} ft`; }
  function fmtSpeed(ms) { const u = units(); return u === 'metric' ? `${ms.toFixed(1)} m/s` : (u === 'imperial' ? `${(ms * 2.23694).toFixed(1)} mph` : `${(ms * 1.94384).toFixed(1)} kn`); }
  function fmtVs(ms) { return Math.abs(ms) < 0.1 ? 'level' : `${ms > 0 ? '▲' : '▼'} ${units() === 'metric' ? Math.abs(ms).toFixed(1) + ' m/s' : Math.round(Math.abs(ms) * 196.85) + ' ft/min'}`; }
  function fmtUnit(x, unit) {
    if (unit === 'alt') return fmtAlt(x);
    if (unit === 'speed') return fmtSpeed(x);
    if (unit === 'vs') return fmtVs(x);
    const r = Math.abs(x) >= 100 || Number.isInteger(x) ? Math.round(x) : +x.toFixed(unit === 'V' || unit === 'A' ? 2 : 1);
    return unit === '°' || unit === '%' ? r + unit : r.toLocaleString() + (unit ? ' ' + unit : '');
  }
  function fmtDur(ms) {
    const s = Math.max(0, Math.round(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), ss = String(s % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
  }
  function fmtClock(t) { const d = new Date(t); return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }); }
  function rangeText(prop, r) {
    if (prop === 'speed') return [fmtSpeed(r.lo), fmtSpeed(r.hi)];
    if (prop === 'alt') return [fmtAlt(r.lo), fmtAlt(r.hi)];
    return [fmtVs(r.lo), fmtVs(r.hi)];
  }

  /* ---------- the module ---------- */
  MB.trackLogs = {
    COLOR_BY, RATES,
    cur: null, playing: false, rate: 10, legendOpen: true,
    _clean: clean, _ranges: ranges, modeColor,

    add(log) {
      if (!log || !Array.isArray(log.vehicles)) return null;
      const vehicles = [];
      log.vehicles.forEach((v, i) => {
        const pts = clean(v && v.points);
        if (pts.length) vehicles.push({ key: v.key != null ? String(v.key) : String(i), label: String((v && v.label) || 'Vehicle ' + (i + 1)), pts });
      });
      if (!vehicles.length) return null;
      const id = 'trk' + (++seq);
      const used = new Set(); logs.forEach(l => l.vehicles.forEach(v => used.add(v.color)));
      vehicles.forEach(v => { v.color = PALETTE.find(c => !used.has(c)) || PALETTE[(seq + used.size) % PALETTE.length]; used.add(v.color); });
      const l = {
        id, source: String(log.source || 'other'), name: String(log.name || 'Flight log'), timeBase: log.timeBase === 'utc' ? 'utc' : 'relative',
        fields: log.fields && typeof log.fields === 'object' ? log.fields : {}, colorBy: 'track', visible: true, vehicles,
        start: Math.min(...vehicles.map(v => v.pts[0].t)), end: Math.max(...vehicles.map(v => v.pts[v.pts.length - 1].t))
      };
      l.color = vehicles[0].color;
      l.has = {
        speed: vehicles.some(v => v.pts.some(p => p.speed != null)), alt: vehicles.some(v => v.pts.some(p => p.h != null)),
        mode: vehicles.some(v => v.pts.some(p => p.mode != null)), climb: vehicles.some(v => v.pts.some(p => num(p.climb) != null))
      };
      l.has.track = true;
      vehicles.forEach(v => v.pts.forEach(p => { if (p.mode != null) modeColor(p.mode); }));
      logs.set(id, l);
      const tl = this.timeline();
      if (this.cur == null || !tl || this.cur < tl.start || this.cur > tl.end) this.cur = tl ? tl.start : null;
      this.changed(true);
      return id;
    },

    remove(id) {
      const l = logs.get(id);
      if (!l) return;
      this.undraw(l);
      logs.delete(id);
      if (!logs.size) { this.pause(); this.cur = null; }
      this.changed(true);
    },

    list(source) {
      return [...logs.values()].filter(l => !source || l.source === source).map(l => ({
        id: l.id, source: l.source, name: l.name, timeBase: l.timeBase, start: l.start, end: l.end, colorBy: l.colorBy, visible: l.visible, color: l.color,
        vehicles: l.vehicles.map(v => ({ key: v.key, label: v.label, color: v.color, count: v.pts.length }))
      }));
    },
    get(id) { return logs.get(id) || null; },

    setColorBy(id, prop) {
      const l = logs.get(id);
      if (!l || !COLOR_BY.some(c => c.id === prop) || !l.has[prop]) return false;
      if (l.colorBy === prop) return true;
      l.colorBy = prop;
      this.changed(true);
      return true;
    },

    setVisible(id, on) {
      const l = logs.get(id);
      if (!l || l.visible === !!on) return;
      l.visible = !!on;
      this.changed(true);
    },

    zoomTo(id) {
      const l = logs.get(id);
      if (!l || !MB.map) return;
      let s = 90, w = 180, n = -90, e = -180;
      l.vehicles.forEach(v => v.pts.forEach(p => { if (p.lat < s) s = p.lat; if (p.lat > n) n = p.lat; if (p.lon < w) w = p.lon; if (p.lon > e) e = p.lon; }));
      MB.map.fitBounds([[s, w], [n, e]], { padding: [40, 40], maxZoom: 18 });
    },

    /* ----- the shared time line ----- */
    // Relative logs start where the earliest UTC log starts (or at 0 with none), so every log is on one line.
    offset(id) {
      const l = logs.get(id);
      if (!l || l.timeBase === 'utc') return 0;
      let min = Infinity;
      logs.forEach(x => { if (x.timeBase === 'utc' && x.start < min) min = x.start; });
      return (isFinite(min) ? min : 0) - l.start;
    },
    timeline() {
      let start = Infinity, end = -Infinity, utc = false;
      logs.forEach(l => {
        if (!l.visible) return;
        const o = this.offset(l.id);
        start = Math.min(start, l.start + o); end = Math.max(end, l.end + o);
        if (l.timeBase === 'utc') utc = true;
      });
      return isFinite(start) ? { start, end, utc } : null;
    },
    time() { return this.cur; },

    positionAt(id, key, t) {
      const l = logs.get(id);
      if (!l) return null;
      const v = l.vehicles.find(x => x.key === String(key));
      if (!v) return null;
      const lt = t - this.offset(id), pts = v.pts;
      if (lt < pts[0].t || lt > pts[pts.length - 1].t) return null;
      let lo = 0, hi = pts.length - 1;
      while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (pts[mid].t <= lt) lo = mid; else hi = mid; }
      const a = pts[lo], b = pts[hi], f = b.t > a.t ? (lt - a.t) / (b.t - a.t) : 0;
      const heading = num(a.heading) != null ? a.heading : (lo + 1 < pts.length && dist(a, pts[lo + 1]) > 0.3 ? bearing(a, pts[lo + 1]) : (lo > 0 ? bearing(pts[lo - 1], a) : 0));
      return {
        lat: a.lat + (b.lat - a.lat) * f, lon: a.lon + (b.lon - a.lon) * f,
        alt: a.alt != null && b.alt != null ? a.alt + (b.alt - a.alt) * f : a.alt, heading, point: f < 0.5 ? a : b
      };
    },

    seek(t) {
      const tl = this.timeline();
      if (!tl) return;
      this.cur = Math.max(tl.start, Math.min(tl.end, +t || 0));
      this.drawCrafts();
      this.updateBar();
    },
    play() {
      const tl = this.timeline();
      if (!tl || this.playing) return;
      if (this.cur == null || this.cur >= tl.end) this.cur = tl.start;
      this.playing = true;
      let last = null;
      const step = now => {
        if (!this.playing) return;
        if (last != null) {
          const tl2 = this.timeline();
          if (!tl2) { this.pause(); return; }
          this.cur = Math.min(tl2.end, this.cur + (now - last) * this.rate);
          if (this.cur >= tl2.end) { this.playing = false; }
          this.drawCrafts(); this.updateBar();
        }
        last = now;
        if (this.playing) this._raf = requestAnimationFrame(step);
      };
      this._raf = requestAnimationFrame(step);
      this.updateBar();
    },
    pause() {
      this.playing = false;
      if (this._raf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(this._raf);
      this._raf = null;
      this.updateBar();
    },

    // Something changed: the tracks redrawn (restyle: their colors too), the bar and the lists brought up to date.
    changed(restyle) {
      if (restyle) { this.rg = ranges(); this._legend = null; this.redraw(); }
      this.drawCrafts();
      this.updateBar();
      this.refreshLists();
      if (MB.emit) { MB.emit('tracklogs'); MB.emit('data'); }
    },

    /* ----- drawing (only with a map) ----- */
    ensureMap() {
      if (!MB.map || typeof L === 'undefined') return false;
      if (this.ready) return true;
      const pane = MB.map.createPane('mb-trk');
      pane.style.zIndex = 620; // under live drones and their trails (mavlink.js), over the user's objects
      const crafts = MB.map.createPane('mb-trk-craft');
      crafts.style.zIndex = 626;
      this.renderer = L.canvas({ pane: 'mb-trk', tolerance: 6 });
      MB.on('units', () => { this._legend = null; this.updateBar(); this.refreshLists(); });
      this.ready = true;
      return true;
    },

    undraw(l) {
      l.vehicles.forEach(v => {
        if (v.layer) { MB.map.removeLayer(v.layer); v.layer = null; }
        if (v.craft) { MB.map.removeLayer(v.craft); v.craft = null; }
      });
    },

    redraw() {
      if (!this.ensureMap()) return;
      const rg = this.rg || ranges();
      logs.forEach(l => {
        this.undraw(l);
        if (!l.visible) return;
        l.vehicles.forEach(v => { v.layer = this.trackLayer(l, v, rg); v.layer.addTo(MB.map); });
      });
    },

    // A vehicle's track: a dark casing (it takes the clicks) under runs of one color each.
    trackLayer(l, v, rg) {
      const pts = v.pts, n = pts.length, step = Math.max(1, Math.ceil(n / MAX_DRAWN));
      const drawn = [];
      for (let i = 0; i < n; i++) if (i % step === 0 || i === n - 1 || (i > 0 && pts[i].mode !== pts[i - 1].mode)) drawn.push(pts[i]);
      const group = L.layerGroup();
      const lls = drawn.map(p => [p.lat, p.lon]);
      const casing = L.polyline(lls, { renderer: this.renderer, pane: 'mb-trk', color: '#0b1118', weight: 6, opacity: 0.55, interactive: true, bubblingMouseEvents: false, pmIgnore: true });
      casing.on('click', e => { L.DomEvent.stopPropagation(e); this.openPoint(l, v, e.latlng); });
      group.addLayer(casing);
      let run = [lls[0]], col = pointColor(drawn[0], l.colorBy, rg, v.color);
      const flush = () => { if (run.length > 1) group.addLayer(L.polyline(run, { renderer: this.renderer, pane: 'mb-trk', color: col, weight: 3, opacity: 0.95, interactive: false, pmIgnore: true })); };
      for (let i = 1; i < drawn.length; i++) {
        run.push(lls[i]);
        const c = pointColor(drawn[i], l.colorBy, rg, v.color);
        if (c !== col || i === drawn.length - 1) { flush(); run = [lls[i]]; col = c; }
      }
      return group;
    },

    // The marker of each visible vehicle at the time line's moment (faded at its first or last point outside its time).
    drawCrafts() {
      if (!this.ready) return;
      const t = this.cur;
      logs.forEach(l => l.vehicles.forEach(v => {
        if (!l.visible || t == null) { if (v.craft) { MB.map.removeLayer(v.craft); v.craft = null; } return; }
        let at = this.positionAt(l.id, v.key, t), out = false;
        if (!at) { const lt = t - this.offset(l.id), p = lt < v.pts[0].t ? v.pts[0] : v.pts[v.pts.length - 1]; at = { lat: p.lat, lon: p.lon, heading: num(p.heading) || 0, point: p }; out = true; }
        if (!v.craft) {
          v.craft = L.marker([at.lat, at.lon], { pane: 'mb-trk-craft', keyboard: false, pmIgnore: true, bubblingMouseEvents: false,
            icon: L.divIcon({ className: 'trk-craft', iconSize: [22, 22], iconAnchor: [11, 11],
              html: `<div class="trk-craft-rot" style="color:${v.color}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.500l7 17-7-4-7 4z"/></svg></div>` }) });
          v.craft.on('click', e => { L.DomEvent.stopPropagation(e); const p = this.positionAt(l.id, v.key, this.cur); this.openPoint(l, v, p ? L.latLng(p.lat, p.lon) : e.latlng, p && p.point); });
          v.craft.addTo(MB.map);
          v._dir = v._out = null;
        } else v.craft.setLatLng([at.lat, at.lon]);
        const el = v.craft.getElement();
        if (!el) return;
        const dir = Math.round(at.heading || 0);
        if (v._dir !== dir) { el.firstChild.style.transform = `rotate(${dir}deg)`; v._dir = dir; }
        if (v._out !== out) { el.classList.toggle('out', out); v._out = out; }
        const title = l.vehicles.length > 1 ? `${l.name} · ${v.label}` : l.name;
        if (el.title !== title) el.title = title;
      }));
    },

    /* ----- a point's values ----- */
    nearest(v, latlng) {
      const c = MB.map.latLngToContainerPoint(latlng);
      let best = null, bd = Infinity;
      v.pts.forEach(p => { const q = MB.map.latLngToContainerPoint([p.lat, p.lon]), d = (q.x - c.x) ** 2 + (q.y - c.y) ** 2; if (d < bd) { bd = d; best = p; } });
      return best;
    },
    pointRows(l, p) {
      const rows = [];
      const row = (k, v) => { if (v !== '' && v != null) rows.push(`<tr><td>${esc(k)}</td><td>${v}</td></tr>`); };
      row('Time', l.timeBase === 'utc' ? esc(fmtClock(p.t)) + ` <span class="dim">· +${fmtDur(p.t - l.start)}</span>` : '+' + fmtDur(p.t - l.start));
      row('Mode', p.mode ? esc(p.mode) : '');
      row('Altitude', p.alt == null ? '' : esc(fmtAlt(p.alt)) + (p.altRef === 'rel' ? ' above home' : ' MSL') + (num(p.amsl) != null && p.altRef === 'rel' ? ` <span class="dim">· ${esc(fmtAlt(p.amsl))} MSL</span>` : ''));
      row('Speed', p.speed == null ? '' : esc(fmtSpeed(p.speed)));
      row('Vertical speed', num(p.climb) == null ? '' : esc(fmtVs(p.climb)));
      Object.keys(p).forEach(k => {
        if (BASE_KEYS.has(k) || k === 'climb' || k === 'amsl' || num(p[k]) == null) return;
        const f = l.fields[k] || {}, kn = KNOWN[k];
        row(f.label || (kn ? kn[0] : k), esc(fmtUnit(p[k], f.unit != null ? f.unit : (kn ? kn[1] : ''))));
      });
      row('Position', esc(MB.formatLatLng ? MB.formatLatLng({ lat: p.lat, lng: p.lon }) : p.lat.toFixed(6) + ', ' + p.lon.toFixed(6)));
      return rows.join('');
    },
    openPoint(l, v, latlng, p) {
      p = p || this.nearest(v, latlng);
      if (!p) return;
      const node = document.createElement('div');
      node.className = 'mb-popup trk-info';
      node.innerHTML = `<div class="mb-popup-title"><i class="trk-sw" style="background:${v.color}"></i>${esc(l.name)}${l.vehicles.length > 1 ? ` <span class="dim">· ${esc(v.label)}</span>` : ''}</div>
        <table class="mb-datatable">${this.pointRows(l, p)}</table>
        <div class="mb-popup-actions"><button type="button" class="btn small" data-trk="seek">${TIME_ICON}Move the time bar here</button></div>`;
      node.querySelector('[data-trk="seek"]').addEventListener('click', () => this.seek(p.t + this.offset(l.id)));
      L.popup({ className: 'mb-data-popup', maxWidth: 320, offset: [0, -4], autoPanPadding: [20, 20] }).setLatLng([p.lat, p.lon]).setContent(node).openOn(MB.map);
    },

    /* ----- the time bar and its legend ----- */
    bar() {
      if (this._bar) return this._bar;
      if (!this.ready) return null;
      const host = document.getElementById('mapwrap') || MB.map.getContainer();
      const el = document.createElement('div');
      el.className = 'trk-bar';
      el.hidden = true;
      // (data-stepper: no number box beside this slider, ui.js; the clock is its readout)
      el.innerHTML = `<div class="trk-legend-map"></div>
        <div class="trk-ctl">
          <button type="button" class="trk-btn" data-trk="play" title="Play" aria-label="Play">${PLAY_ICON}</button>
          <div class="trk-clock"><span class="trk-now"></span><span class="trk-el dim"></span></div>
          <input type="range" class="trk-seek" min="0" max="1" step="any" value="0" aria-label="Time" data-stepper="off">
          <select class="trk-rate" title="Playback speed" aria-label="Playback speed">${RATES.map(r => `<option value="${r}"${r === this.rate ? ' selected' : ''}>${r}×</option>`).join('')}</select>
          <button type="button" class="trk-btn" data-trk="legend" title="Legend" aria-label="Legend" aria-pressed="true">${LEGEND_ICON}</button>
        </div>`;
      L.DomEvent.disableClickPropagation(el);
      L.DomEvent.disableScrollPropagation(el);
      const seek = el.querySelector('.trk-seek');
      seek.addEventListener('input', () => { const tl = this.timeline(); if (tl) this.seek(tl.start + +seek.value); });
      el.querySelector('.trk-rate').addEventListener('change', e => { this.rate = +e.target.value || 1; });
      el.querySelector('[data-trk="play"]').addEventListener('click', () => { if (this.playing) this.pause(); else this.play(); });
      el.querySelector('[data-trk="legend"]').addEventListener('click', () => { this.legendOpen = !this.legendOpen; this.updateBar(); });
      host.appendChild(el);
      this._bar = el;
      return el;
    },

    updateBar() {
      const el = this.bar();
      if (!el) return;
      const tl = this.timeline();
      el.hidden = !tl;
      if (!tl) return;
      const t = this.cur == null ? tl.start : this.cur;
      const seek = el.querySelector('.trk-seek');
      const span = Math.max(1, tl.end - tl.start);
      if (seek.max !== String(span)) seek.max = String(span);
      if (document.activeElement !== seek || this.playing) seek.value = String(t - tl.start);
      el.querySelector('.trk-now').textContent = tl.utc ? fmtClock(t) : '+' + fmtDur(t - tl.start);
      el.querySelector('.trk-el').textContent = tl.utc ? '+' + fmtDur(t - tl.start) : '/ ' + fmtDur(span);
      const play = el.querySelector('[data-trk="play"]');
      const want = this.playing ? 'pause' : 'play';
      if (play.dataset.state !== want) { play.dataset.state = want; play.innerHTML = this.playing ? PAUSE_ICON : PLAY_ICON; play.title = this.playing ? 'Pause' : 'Play'; play.setAttribute('aria-label', play.title); }
      const lg = el.querySelector('.trk-legend-map'), html = this.legendHtml();
      lg.hidden = !this.legendOpen || !html;
      if (lg._h !== html) { lg.innerHTML = html; lg._h = html; }
      el.querySelector('[data-trk="legend"]').setAttribute('aria-pressed', String(this.legendOpen));
      el.querySelector('[data-trk="legend"]').hidden = !html;
    },

    // The colors in use on the map: a ramp per property, the flight modes, and the logs drawn in their own colors.
    legendHtml() {
      if (this._legend != null) return this._legend;
      const rg = this.rg || ranges(), used = new Set(), parts = [];
      logs.forEach(l => { if (l.visible) used.add(l.colorBy); });
      ['speed', 'alt', 'climb'].forEach(prop => {
        if (!used.has(prop) || !rg[prop]) return;
        const [lo, hi] = rangeText(prop, rg[prop]);
        parts.push(`<div class="trk-lg"><span class="nm">${esc(COLOR_BY.find(c => c.id === prop).name)}</span><span class="lo">${esc(lo)}</span><span class="trk-ramp" style="background:linear-gradient(90deg,${(prop === 'climb' ? DIVERGE : RAMP).join(',')})"></span><span class="hi">${esc(hi)}</span></div>`);
      });
      if (used.has('mode')) {
        const modes = new Set();
        logs.forEach(l => { if (l.visible && l.colorBy === 'mode') l.vehicles.forEach(v => v.pts.forEach(p => { if (p.mode != null) modes.add(p.mode); })); });
        const list = [...modes];
        parts.push(`<div class="trk-lg chips">${list.slice(0, 10).map(m => `<span><i style="background:${modeColor(m)}"></i>${esc(m)}</span>`).join('')}${list.length > 10 ? `<span class="dim">+${list.length - 10}</span>` : ''}</div>`);
      }
      if (used.has('track')) {
        const chips = [];
        logs.forEach(l => { if (l.visible && l.colorBy === 'track') l.vehicles.forEach(v => chips.push(`<span title="${esc(l.name)}"><i style="background:${v.color}"></i>${esc(l.vehicles.length > 1 ? v.label : l.name)}</span>`)); });
        parts.push(`<div class="trk-lg chips">${chips.slice(0, 8).join('')}${chips.length > 8 ? `<span class="dim">+${chips.length - 8}</span>` : ''}</div>`);
      }
      return (this._legend = parts.join(''));
    },

    /* ----- a section's list of logs ----- */
    // One log's legend in the list: the ramp with its range, or its flight modes.
    itemLegend(l) {
      if (l.colorBy === 'mode') {
        const modes = []; l.vehicles.forEach(v => v.pts.forEach(p => { if (p.mode != null && !modes.includes(p.mode)) modes.push(p.mode); }));
        return `<div class="legend trk-legend">${modes.slice(0, 12).map(m => `<span><i style="background:${modeColor(m)}"></i>${esc(m)}</span>`).join('')}</div>`;
      }
      if (l.colorBy === 'track') return l.vehicles.length > 1 ? `<div class="legend trk-legend">${l.vehicles.map(v => `<span><i style="background:${v.color}"></i>${esc(v.label)}</span>`).join('')}</div>` : '';
      const r = (this.rg || ranges())[l.colorBy];
      if (!r || !l.visible) return '';
      const [lo, hi] = rangeText(l.colorBy, r);
      return `<div class="legend trk-legend"><span class="trk-range"><span>${esc(lo)}</span><i class="trk-ramp" style="background:linear-gradient(90deg,${(l.colorBy === 'climb' ? DIVERGE : RAMP).join(',')})"></i><span>${esc(hi)}</span></span></div>`;
    },

    listHtml(source) {
      const list = [...logs.values()].filter(l => !source || l.source === source);
      return list.map(l => {
        const pts = l.vehicles.reduce((n, v) => n + v.pts.length, 0);
        const when = l.timeBase === 'utc' ? `${new Date(l.start).toLocaleDateString()} ${fmtClock(l.start)}` : 'no clock time';
        const meta = [when, fmtDur(l.end - l.start), l.vehicles.length > 1 ? l.vehicles.length + ' vehicles' : '', pts.toLocaleString() + ' points'].filter(Boolean).join(' · ');
        return `<div class="data-item trk-item${l.visible ? ' on' : ''}" data-log="${l.id}">
          <div class="trk-head"><label class="check"><input type="checkbox" data-trk="vis"${l.visible ? ' checked' : ''}> <i class="trk-sw" style="background:${l.color}"></i><span class="dname" title="${esc(l.name)}">${esc(l.name)}</span></label>
            <span class="trk-acts">${MB.iconBtn ? MB.iconBtn('goto', 'Zoom to the track', 'data-trk="zoom"', '', 'Zoom to ' + l.name) + MB.iconBtn('trash', 'Remove', 'data-trk="remove"', 'danger', 'Remove ' + l.name) : ''}</span></div>
          <div class="dstatus">${esc(meta)}</div>
          <div class="row trk-color"><label>Color</label><select data-trk="color" aria-label="Color the track by">${COLOR_BY.map(c => `<option value="${c.id}"${l.colorBy === c.id ? ' selected' : ''}${l.has[c.id] ? '' : ' disabled'}>${esc(c.name)}</option>`).join('')}</select></div>
          ${this.itemLegend(l)}
        </div>`;
      }).join('');
    },

    renderList(container, opts) {
      if (!container) return;
      container._trkSource = (opts && opts.source) || '';
      lists.add(container);
      this.paintList(container);
      if (container._trkBound) return;
      container._trkBound = true;
      container.addEventListener('change', e => {
        const item = e.target.closest('[data-log]'), act = e.target.dataset.trk;
        if (!item) return;
        if (act === 'vis') this.setVisible(item.dataset.log, e.target.checked);
        else if (act === 'color') this.setColorBy(item.dataset.log, e.target.value);
      });
      container.addEventListener('click', e => {
        const b = e.target.closest('button[data-trk]'), item = e.target.closest('[data-log]');
        if (!b || !item) return;
        if (b.dataset.trk === 'zoom') this.zoomTo(item.dataset.log);
        else if (b.dataset.trk === 'remove') this.remove(item.dataset.log);
      });
    },
    paintList(container) {
      const html = this.listHtml(container._trkSource);
      if (container._trkHtml !== html) { container.innerHTML = html; container._trkHtml = html; }
    },
    refreshLists() {
      lists.forEach(c => { if (!c.isConnected) { lists.delete(c); return; } this.paintList(c); });
    }
  };

  const ic = d => `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
  const PLAY_ICON = ic('<path d="M7 4.500v15l12-7.500z" fill="currentColor"/>');
  const PAUSE_ICON = ic('<path d="M8 5v14M16 5v14"/>');
  const LEGEND_ICON = ic('<path d="M4 6h3M4 12h3M4 18h3M10 6h10M10 12h10M10 18h10"/>');
  const TIME_ICON = ic('<circle cx="12" cy="12" r="8.500"/><path d="M12 7.500V12l3 2"/>');

})(window.MB);
