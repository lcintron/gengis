/* GenGIS - utilities: ids, units, geodesic math, coordinate parsing */
window.MB = window.MB || {};
(function (MB) {
  'use strict';

  // App identity. Bump `version` here for each release (also in package.json and the service worker cache name).
  MB.APP = { name: 'GenGIS', aka: 'G²', version: '0.17.0' };

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

  // A map's credits as HTML that can do no harm: its text, and links to http(s) addresses (opening a new tab);
  // anything else (scripts, handlers, other elements) is left out, its text kept.
  MB.safeAttribution = function (html) {
    const s = String(html || '');
    if (!/[<&]/.test(s)) return s;
    const doc = new DOMParser().parseFromString('<body>' + s + '</body>', 'text/html');
    const walk = n => Array.from(n.childNodes).map(c => {
      if (c.nodeType === 3) return MB.escapeHtml(c.textContent);
      if (c.nodeType !== 1 || /^(script|style|noscript|template)$/.test(c.localName)) return ''; // (not even their text)
      const inner = walk(c), href = c.localName === 'a' ? (c.getAttribute('href') || '').trim() : '';
      return /^https?:\/\//i.test(href) ? `<a href="${MB.escapeHtml(href)}" target="_blank" rel="noopener">${inner}</a>` : inner;
    }).join('');
    return walk(doc.body);
  };

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

  // A zoom level as shown: 6, 6.25, 6.5 (two decimals at most, no trailing zeros).
  MB.formatZoom = z => String(+(+z).toFixed(2));

  // Coordinates in the project's format (Settings → Units → Coordinates): decimal degrees ("32.08000, -81.09000"),
  // degrees and decimal minutes ("32°04.800′N 81°05.400′W") or degrees, minutes and seconds ("32°04′48.0″N 81°05′24.0″W").
  // digits: the decimal places of decimal degrees; the other forms keep about the same precision. MB.parseCoords
  // reads all three back.
  MB.formatLatLng = function (ll, digits) {
    digits = digits == null ? 5 : digits;
    const f = MB.state && MB.state.coordFormat;
    if (f !== 'dm' && f !== 'dms') return ll.lat.toFixed(digits) + ', ' + ll.lng.toFixed(digits);
    return MB.formatAngle(ll.lat, 'lat', f, digits) + ' ' + MB.formatAngle(ll.lng, 'lng', f, digits);
  };
  MB.formatAngle = function (v, axis, f, digits) {
    if (axis === 'lng') v = ((v + 180) % 360 + 360) % 360 - 180; // the copy of the world in view
    const hem = axis === 'lat' ? (v < 0 ? 'S' : 'N') : (v < 0 ? 'W' : 'E'), a = Math.abs(v);
    if (f === 'dm') {
      const md = Math.max(0, digits - 2), tm = +(a * 60).toFixed(md), d = Math.floor(tm / 60 + 1e-9), m = tm - d * 60;
      return `${d}°${m.toFixed(md).padStart(md ? md + 3 : 2, '0')}′${hem}`;
    }
    const sd = Math.max(0, digits - 4), ts = +(a * 3600).toFixed(sd), d = Math.floor(ts / 3600 + 1e-9), m = Math.floor((ts - d * 3600) / 60 + 1e-9), s = ts - d * 3600 - m * 60;
    return `${d}°${String(m).padStart(2, '0')}′${s.toFixed(sd).padStart(sd ? sd + 3 : 2, '0')}″${hem}`;
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
    const d = 'M13 1C6.4 1 1 6.3 1 12.9c0 8.6 10.2 22.2 11.2 23.5a1 1 0 0 0 1.6 0C14.8 35.1 25 21.5 25 12.9 25 6.3 19.6 1 13 1z';
    return '<svg xmlns="http://www.w3.org/2000/svg" width="26" height="40" viewBox="0 0 26 40">' +
      '<path d="' + d + '" transform="translate(0 2.2)" fill="#000" fill-opacity=".35" stroke="#000" stroke-opacity=".35" stroke-width="2"/>' + // the shadow, baked in (no CSS filter)
      '<path d="' + d + '" fill="' + color + '" stroke="#1c1c1c" stroke-opacity=".55" stroke-width="1.5"/>' +
      '<circle cx="13" cy="13" r="4.5" fill="#fff" fill-opacity=".9"/></svg>';
  };

  MB.pinIcon = function (color) {
    return L.divIcon({
      className: 'mb-pin',
      html: MB.pinIconSvg(color || '#e4572e'),
      iconSize: [26, 40],
      iconAnchor: [13, 37],
      popupAnchor: [0, -32],
      tooltipAnchor: [0, -30]
    });
  };

  // text, or a Blob as it is (an exported picture)
  MB.download = function (filename, text, mime) {
    const blob = text instanceof Blob ? text : new Blob([text], { type: mime || 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 4000); // a phone's save sheet reads it after the click
  };

  // A stored item, carrying over what an earlier version saved under its old key.
  // A yes/no question in the app's own dialog; resolves true for yes. (confirm() is suppressed by some embedded
  // browsers and in-app previews, which read it as "no" without showing anything.)
  // Every dialog's close button: an ✕ in the box's top-right corner (css .modal-x). It is the box's first child and
  // carries data-act="close", so a dialog that closes on [data-act="close"] clicks needs nothing more.
  MB.modalCloseHtml = '<button type="button" class="modal-x" data-act="close" aria-label="Close" title="Close">✕</button>';

  // The everyday actions as icons, one drawing each everywhere in the app (open is Project → Open's folder, edit a
  // pencil, delete a bin...). An icon button carries its words as its tooltip and its accessible name.
  const ic = d => `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
  MB.ICON = {
    open: ic('<path d="M6 14l1.5-2.9A2 2 0 0 1 9.2 10H20a2 2 0 0 1 1.9 2.5l-1.5 6a2 2 0 0 1-2 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.7.9l.8 1.2a2 2 0 0 0 1.7.9H18a2 2 0 0 1 2 2v2"/>'),
    edit: ic('<path d="M4 20l4-1 11-11-3-3L5 16z"/><path d="M14 7l3 3"/>'),
    trash: ic('<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/><path d="M10 11v6M14 11v6"/>'),
    goto: ic('<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2.5"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>'),
    refresh: ic('<path d="M20 12a8 8 0 1 1-2.3-5.6L20 9"/><path d="M20 4v5h-5"/>'), // sync, check again
    download: ic('<path d="M12 4v11M7.5 10.5L12 15l4.5-4.5"/><path d="M4 17v2a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-2"/>'), // fetch again to this device
    copy: ic('<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/>'),
    close: ic('<path d="M6 6l12 12M18 6L6 18"/>'),
    search: ic('<circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5L21 21"/>'),
    pinAdd: ic('<path d="M12 21s-6-5.3-6-11a6 6 0 0 1 12 0c0 1.3-.3 2.5-.8 3.6"/><circle cx="12" cy="10" r="2"/><path d="M18 16v6M15 19h6"/>')
  };
  // An icon-only button. attrs: its other attributes as HTML (data-…, disabled); cls: more classes; label: what a
  // screen reader says when the short tooltip is not enough (in a list: which row, as 'Delete Alpha').
  MB.iconBtn = (icon, title, attrs, cls, label) => `<button type="button" class="icon-btn mini${cls ? ' ' + cls : ''}" title="${MB.escapeHtml(title)}" aria-label="${MB.escapeHtml(label || title)}"${attrs ? ' ' + attrs : ''}>${MB.ICON[icon]}</button>`;

  MB.ask = function (message, yes, no) {
    return new Promise(resolve => {
      const dlg = document.createElement('div');
      dlg.className = 'modal mb-ask';
      dlg.innerHTML = '<div class="modal-box" role="alertdialog" aria-modal="true">' + MB.modalCloseHtml + '<p class="ask-text"></p><div class="row right"><button type="button" class="btn" data-no></button><button type="button" class="btn primary" data-yes></button></div></div>';
      dlg.querySelector('.ask-text').textContent = message;
      dlg.querySelector('[data-yes]').textContent = yes || 'OK';
      dlg.querySelector('[data-no]').textContent = no || 'Cancel';
      const yesBtn = dlg.querySelector('[data-yes]'), noBtn = dlg.querySelector('[data-no]'), xBtn = dlg.querySelector('.modal-x');
      const finish = v => { window.removeEventListener('keydown', onKey, true); dlg.remove(); resolve(v); };
      // While it is open no key reaches the app (Delete must not delete the selection behind it). Enter and Space
      // still press the focused button; Tab stays on the dialog's buttons; Escape, like the ✕, answers no.
      const order = [xBtn, noBtn, yesBtn];
      const onKey = e => {
        e.stopPropagation();
        if (e.key === 'Escape') { e.preventDefault(); finish(false); }
        else if (e.key === 'Tab') {
          e.preventDefault();
          const i = order.indexOf(document.activeElement);
          order[(i < 0 ? order.length - 1 : i + (e.shiftKey ? order.length - 1 : 1)) % order.length].focus();
        }
        else if (!dlg.contains(e.target)) e.preventDefault();
      };
      yesBtn.addEventListener('click', () => finish(true));
      noBtn.addEventListener('click', () => finish(false));
      xBtn.addEventListener('click', () => finish(false));
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
