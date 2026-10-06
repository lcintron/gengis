/* GenGIS - utilities: ids, units, geodesic math, coordinate parsing */
window.MB = window.MB || {};
(function (MB) {
  'use strict';

  // App identity. Bump `version` here for each release (also in package.json and the service worker cache name).
  MB.APP = { name: 'GenGIS', aka: 'G²', version: '0.5.1' };

  const EARTH_R = 6378137;
  const D2R = Math.PI / 180;

  MB.uid = function () {
    return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  };

  MB.debounce = function (fn, ms) {
    let t;
    return function () {
      const args = arguments, ctx = this;
      clearTimeout(t);
      t = setTimeout(() => fn.apply(ctx, args), ms);
    };
  };

  MB.clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  MB.escapeHtml = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));

  MB.deepClone = o => JSON.parse(JSON.stringify(o));

  MB.isLatLng = v => v && typeof v === 'object' && 'lat' in v && 'lng' in v;

  /* ---------- geodesic math ---------- */

  // Spherical area of a ring (array of LatLng), in m^2.
  MB.ringArea = function (ring) {
    const n = ring.length;
    if (n < 3) return 0;
    let area = 0;
    for (let i = 0; i < n; i++) {
      const p1 = ring[i], p2 = ring[(i + 1) % n];
      area += ((p2.lng - p1.lng) * D2R) * (2 + Math.sin(p1.lat * D2R) + Math.sin(p2.lat * D2R));
    }
    return Math.abs(area * EARTH_R * EARTH_R / 2);
  };

  // Area of Leaflet polygon latlngs (ring, polygon-with-holes, or multipolygon).
  MB.polygonArea = function (latlngs) {
    if (!latlngs || !latlngs.length) return 0;
    if (MB.isLatLng(latlngs[0])) return MB.ringArea(latlngs);
    if (latlngs[0].length && MB.isLatLng(latlngs[0][0])) {
      let a = MB.ringArea(latlngs[0]);
      for (let i = 1; i < latlngs.length; i++) a -= MB.ringArea(latlngs[i]);
      return Math.max(0, a);
    }
    return latlngs.reduce((s, p) => s + MB.polygonArea(p), 0);
  };

  // Length of a path, in meters. `closed` adds the closing segment (perimeter).
  MB.pathLength = function (latlngs, closed) {
    if (!latlngs || !latlngs.length) return 0;
    if (!MB.isLatLng(latlngs[0])) return latlngs.reduce((s, p) => s + MB.pathLength(p, closed), 0);
    let d = 0;
    for (let i = 1; i < latlngs.length; i++) d += latlngs[i - 1].distanceTo(latlngs[i]);
    if (closed && latlngs.length > 2) d += latlngs[latlngs.length - 1].distanceTo(latlngs[0]);
    return d;
  };

  // Destination point given start, bearing (deg) and distance (m).
  MB.destination = function (latlng, bearingDeg, dist) {
    const lat1 = latlng.lat * D2R, lng1 = latlng.lng * D2R, br = bearingDeg * D2R, dr = dist / EARTH_R;
    const lat2 = Math.asin(Math.sin(lat1) * Math.cos(dr) + Math.cos(lat1) * Math.sin(dr) * Math.cos(br));
    const lng2 = lng1 + Math.atan2(Math.sin(br) * Math.sin(dr) * Math.cos(lat1), Math.cos(dr) - Math.sin(lat1) * Math.sin(lat2));
    return L.latLng(lat2 / D2R, ((lng2 / D2R) + 540) % 360 - 180);
  };

  // Bounds for a rectangle of w x h meters centered on `center`.
  MB.boundsAround = function (center, wMeters, hMeters) {
    const dLat = (hMeters / 2) / 111320;
    const dLng = (wMeters / 2) / (111320 * Math.max(0.01, Math.cos(center.lat * D2R)));
    return L.latLngBounds([center.lat - dLat, center.lng - dLng], [center.lat + dLat, center.lng + dLng]);
  };

  /* ---------- units ---------- */

  function fmt(n, d) {
    return n.toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: 0 });
  }
  MB.fmtNum = fmt;

  /* Unit systems:
   *   metric   - m / km, m² / km²
   *   imperial - ft / mi, ft² / mi²
   *   nautical - ft (or m) for short distances, nautical miles beyond 0.1 NM, ft² / mi² for areas
   */
  MB.unitSystems = { metric: 'Metric', imperial: 'Imperial', nautical: 'Nautical' };
  const FT = 3.2808399, MI = 1609.344, NM = 1852, MI2 = 2589988.11, FT2 = 10.7639104;
  const shortUnit = () => (MB.state.shortUnit === 'm' ? 'm' : 'ft');

  MB.formatDistance = function (m, units) {
    units = units || MB.state.units;
    if (units === 'imperial') {
      const ft = m * FT;
      if (ft < 1000) return fmt(ft, 1) + ' ft';
      const mi = m / MI;
      return fmt(mi, mi < 10 ? 2 : 1) + ' mi';
    }
    if (units === 'nautical') {
      const nm = m / NM;
      if (nm >= 0.1) return fmt(nm, nm < 10 ? 2 : 1) + ' NM';
      return shortUnit() === 'm' ? fmt(m, 1) + ' m' : fmt(m * FT, 1) + ' ft';
    }
    if (m < 1000) return fmt(m, 1) + ' m';
    const km = m / 1000;
    return fmt(km, km < 10 ? 2 : 1) + ' km';
  };

  MB.formatArea = function (m2, units) {
    units = units || MB.state.units;
    if (units === 'imperial' || units === 'nautical') {
      const mi2 = m2 / MI2;
      if (mi2 >= 0.1) return fmt(mi2, mi2 < 10 ? 2 : 1) + ' mi²';
      return fmt(m2 * FT2, 0) + ' ft²';
    }
    if (m2 < 1e6) return fmt(m2, m2 < 100 ? 1 : 0) + ' m²';
    return fmt(m2 / 1e6, 2) + ' km²';
  };

  // The same value in the other unit systems (for the secondary line in the measurement box).
  MB.formatDistanceAlt = function (m, units) {
    units = units || MB.state.units;
    return Object.keys(MB.unitSystems).filter(u => u !== units).map(u => MB.formatDistance(m, u)).join(' · ');
  };
  MB.formatAreaAlt = function (m2, units) {
    units = units || MB.state.units;
    return units === 'metric' ? MB.formatArea(m2, 'imperial') : MB.formatArea(m2, 'metric');
  };

  // Unit used for typed-in lengths. kind: 'radius' (nautical → NM) or 'size' (nautical → short unit).
  MB.inputUnit = function (kind, units) {
    units = units || MB.state.units;
    if (units === 'imperial') return { label: 'ft', toMeters: v => v / FT, fromMeters: m => m * FT };
    if (units === 'nautical') {
      if (kind === 'radius') return { label: 'NM', toMeters: v => v * NM, fromMeters: m => m / NM };
      return shortUnit() === 'm' ? { label: 'm', toMeters: v => v, fromMeters: m => m } : { label: 'ft', toMeters: v => v / FT, fromMeters: m => m * FT };
    }
    return { label: 'm', toMeters: v => v, fromMeters: m => m };
  };
  // Backwards-compatible helpers (size semantics).
  MB.toMeters = (v, units) => MB.inputUnit('size', units).toMeters(v);
  MB.fromMeters = (m, units) => MB.inputUnit('size', units).fromMeters(m);
  MB.lengthUnitLabel = units => MB.inputUnit('size', units).label;

  // Scale-bar unit for a bar whose half length is `halfMeters`.
  MB.scaleUnit = function (halfMeters, units) {
    units = units || MB.state.units;
    if (units === 'imperial') return halfMeters >= MI ? { perMeter: 1 / MI, unit: 'mi' } : { perMeter: FT, unit: 'ft' };
    if (units === 'nautical') {
      if (halfMeters >= NM * 0.1) return { perMeter: 1 / NM, unit: 'NM' };
      return shortUnit() === 'm' ? { perMeter: 1, unit: 'm' } : { perMeter: FT, unit: 'ft' };
    }
    return halfMeters >= 1000 ? { perMeter: 0.001, unit: 'km' } : { perMeter: 1, unit: 'm' };
  };

  MB.formatLatLng = function (ll, digits) {
    digits = digits == null ? 5 : digits;
    return ll.lat.toFixed(digits) + ', ' + ll.lng.toFixed(digits);
  };

  /* ---------- coordinate parsing ---------- */

  // Accepts "lat, lng", "lat lng", DMS ("40°26'46"N 79°58'56"W"), "N40.44 W79.99", etc.
  MB.parseCoords = function (input) {
    if (!input) return null;
    const s = input.trim();
    let m = s.match(/^([+-]?\d+(?:\.\d+)?)\s*[,;\s]\s*([+-]?\d+(?:\.\d+)?)$/);
    if (m) {
      const lat = +m[1], lng = +m[2];
      if (Math.abs(lat) <= 90 && Math.abs(lng) <= 180) return L.latLng(lat, lng);
      return null;
    }
    const re = /([NSEW])?\s*([+-]?\d+(?:\.\d+)?)(?:\s*[°D:]\s*|\s+)?(?:(\d+(?:\.\d+)?)(?:\s*['′M:]\s*|\s+)?)?(?:(\d+(?:\.\d+)?)\s*["″S]?)?\s*([NSEW])?/g;
    const up = s.toUpperCase();
    if (!/[NSEW°'"′″]/.test(up)) return null;
    const parts = [];
    let r;
    while ((r = re.exec(up)) && parts.length < 2) {
      if (r[2] === undefined) { if (re.lastIndex === r.index) re.lastIndex++; continue; }
      const h = (r[1] || r[5] || '');
      let v = Math.abs(+r[2]) + (r[3] ? +r[3] / 60 : 0) + (r[4] ? +r[4] / 3600 : 0);
      if (r[2].startsWith('-')) v = -v;
      if (h === 'S' || h === 'W') v = -Math.abs(v);
      parts.push({ v, h });
    }
    if (parts.length !== 2) return null;
    let a = parts[0], b = parts[1];
    if ((a.h === 'E' || a.h === 'W') || (b.h === 'N' || b.h === 'S')) { const t = a; a = b; b = t; }
    if (Math.abs(a.v) <= 90 && Math.abs(b.v) <= 180) return L.latLng(a.v, b.v);
    return null;
  };

  /* ---------- SVG helpers ---------- */

  MB.svgInfo = function (svgText) {
    let w = 0, h = 0;
    try {
      const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
      const svg = doc.documentElement;
      const vb = (svg.getAttribute('viewBox') || '').split(/[\s,]+/).map(Number);
      if (vb.length === 4 && vb[2] > 0 && vb[3] > 0) { w = vb[2]; h = vb[3]; }
      if (!w || !h) {
        w = parseFloat(svg.getAttribute('width')) || 0;
        h = parseFloat(svg.getAttribute('height')) || 0;
      }
    } catch (e) { /* ignore */ }
    if (!w || !h) { w = 1; h = 1; }
    return { width: w, height: h, aspect: w / h };
  };

  MB.svgDataUrl = function (svgText) {
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgText);
  };

  MB.pinIconSvg = function (color) {
    return '<svg xmlns="http://www.w3.org/2000/svg" width="26" height="38" viewBox="0 0 26 38">' +
      '<path d="M13 1C6.4 1 1 6.3 1 12.9c0 8.6 10.2 22.2 11.2 23.5a1 1 0 0 0 1.6 0C14.8 35.1 25 21.5 25 12.9 25 6.3 19.6 1 13 1z" fill="' + color + '" stroke="#1c1c1c" stroke-opacity=".55" stroke-width="1.5"/>' +
      '<circle cx="13" cy="13" r="4.5" fill="#fff" fill-opacity=".9"/></svg>';
  };

  MB.pinIcon = function (color) {
    return L.divIcon({
      className: 'mb-pin',
      html: MB.pinIconSvg(color || '#e4572e'),
      iconSize: [26, 38],
      iconAnchor: [13, 37],
      popupAnchor: [0, -32],
      tooltipAnchor: [0, -30]
    });
  };

  MB.download = function (filename, text, mime) {
    const blob = new Blob([text], { type: mime || 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 100);
  };

  // A stored item, carrying over what an earlier version saved under its old key.
  // A yes/no question in the app's own dialog; resolves true for yes. (confirm() is suppressed by some embedded
  // browsers and in-app previews, which read it as "no" without showing anything.)
  MB.ask = function (message, yes, no) {
    return new Promise(resolve => {
      const dlg = document.createElement('div');
      dlg.className = 'modal mb-ask';
      dlg.innerHTML = '<div class="modal-box" role="alertdialog" aria-modal="true"><p class="ask-text"></p><div class="row right"><button type="button" class="btn" data-no></button><button type="button" class="btn primary" data-yes></button></div></div>';
      dlg.querySelector('.ask-text').textContent = message;
      dlg.querySelector('[data-yes]').textContent = yes || 'OK';
      dlg.querySelector('[data-no]').textContent = no || 'Cancel';
      const yesBtn = dlg.querySelector('[data-yes]'), noBtn = dlg.querySelector('[data-no]');
      const finish = v => { window.removeEventListener('keydown', onKey, true); dlg.remove(); resolve(v); };
      // While it is open no key reaches the app (Delete must not delete the selection behind it). Enter and Space
      // still press the focused button; Tab stays on the two buttons; Escape answers no.
      const onKey = e => {
        e.stopPropagation();
        if (e.key === 'Escape') { e.preventDefault(); finish(false); }
        else if (e.key === 'Tab') { e.preventDefault(); (document.activeElement === yesBtn ? noBtn : yesBtn).focus(); }
        else if (!dlg.contains(e.target)) e.preventDefault();
      };
      yesBtn.addEventListener('click', () => finish(true));
      noBtn.addEventListener('click', () => finish(false));
      window.addEventListener('keydown', onKey, true);
      document.body.appendChild(dlg);
      dlg.querySelector('[data-yes]').focus();
    });
  };

  MB.storedItem = function (key, oldKey) {
    let v = null;
    try {
      v = localStorage.getItem(key);
      if (v == null && oldKey) { v = localStorage.getItem(oldKey); if (v != null) { localStorage.setItem(key, v); localStorage.removeItem(oldKey); } }
    } catch (e) { /* storage unavailable */ }
    return v;
  };

  MB.toast = function (msg, ms) {
    let el = document.getElementById('mb-toast');
    if (!el) {
      el = document.createElement('div'); el.id = 'mb-toast'; document.body.appendChild(el);
    }
    el.textContent = msg; el.classList.add('show');
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.remove('show'), ms || 2600);
  };
})(window.MB);
