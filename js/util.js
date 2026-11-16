/* GenGIS - utilities: ids, units, geodesic math, coordinate parsing */
window.MB = window.MB || {};
(function (MB) {
  'use strict';

  // App identity. Bump `version` here for each release (also in package.json and the service worker cache name).
  MB.APP = { name: 'GenGIS', aka: 'G²', version: '0.19.1' };

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

  /* ---------- a pointer being held down ----------
   * Anything that draws a panel anew waits for the press to end with MB.whenReleased(fn): drawn between a button's
   * press and its release, the button would be gone and its click lost (a field renamed in Properties, an imported
   * value edited there). Listened to once, for the page. Only the main button's press counts (a right-click's menu
   * may swallow its release); the window losing focus, or a context menu, ends a press too, and a release that never
   * comes is given up on after 2 s, so nothing waits for good. */
  const press = { down: false, waiting: [], hooked: false, timer: null, giveUp: 2000 }; // (giveUp: ms; the tests shorten it)
  function release() {
    press.down = false;
    clearTimeout(press.timer);
    const w = press.waiting.splice(0);
    if (w.length) setTimeout(() => w.forEach(fn => fn())); // (after the click)
  }
  function hookPress(doc, win) {
    doc = doc || (typeof document !== 'undefined' ? document : null);
    win = win || (typeof window !== 'undefined' ? window : null);
    if (press.hooked || !doc) return;
    press.hooked = true;
    doc.addEventListener('pointerdown', e => {
      if (e.button > 0 || e.isPrimary === false) return;
      press.down = true;
      clearTimeout(press.timer);
      press.timer = setTimeout(release, press.giveUp);
    }, true);
    const end = e => { if (e.isPrimary !== false) release(); }; // (a second finger lifting is not the press ending)
    ['pointerup', 'pointercancel'].forEach(t => doc.addEventListener(t, end, true));
    doc.addEventListener('contextmenu', release, true);
    if (win && typeof win.addEventListener === 'function') win.addEventListener('blur', release);
  }
  // (listened to as the page loads, never on the first whenReleased: a press is seen before anything asks about it -
  //  a change or focusout event fires after the pointerdown that caused it, so the first redraw of a session would
  //  otherwise find nothing held down and eat the click)
  if (typeof document !== 'undefined' && document.addEventListener) hookPress();
  MB.whenReleased = function (fn) {
    if (press.down) press.waiting.push(fn); else setTimeout(fn);
  };
  MB.press = { hook: hookPress, state: press }; // (the tests)

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

  /* ----- formatted text in a value (a KML description, a GeoJSON property written as HTML) -----
   * isHtml(v): a value with formatting. safeHtml(s): that formatting rebuilt from an allow-list: text, a few tags
   * for emphasis, lists, tables, headings, links (http, https, mailto; opened in a new tab) and pictures (http,
   * https, data:image); never a script, a style, an event handler, a frame or a form. Each tag kept is written
   * anew with only its allowed, checked attributes, every bit of text escaped, and tags left open closed.
   * htmlText(s): the same as plain text (a label, a title, a hover name). */
  const RICH = new Set(['a', 'b', 'strong', 'i', 'em', 'u', 's', 'strike', 'del', 'ins', 'small', 'big', 'sub', 'sup', 'br', 'hr', 'p', 'div', 'span',
    'font', 'center', 'blockquote', 'pre', 'code', 'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th',
    'caption', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'img']);
  const VOID_TAGS = new Set(['br', 'hr', 'img']);
  const TABLE_PARTS = new Set(['thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'caption']); // (only inside a table of the value's own)
  const GONE = /<(script|style|iframe|frame|frameset|object|embed|applet|noscript|template|svg|math|head|title|textarea|select|button|form)\b[\s\S]*?(<\/\1\s*>|$)/gi; // with what is in them
  const TAG = /<(\/?)([a-zA-Z][\w-]*)((?:\s+[^\s"'<>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*\/?>/g;
  const IS_RICH = new RegExp(`<\\/?(${Array.from(RICH).join('|')})\\b[^<>]*>`, 'i');
  const ENTS = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0', copy: '\u00a9', reg: '\u00ae', deg: '\u00b0', plusmn: '\u00b1',
    middot: '\u00b7', ndash: '\u2013', mdash: '\u2014', lsquo: '\u2018', rsquo: '\u2019', ldquo: '\u201c', rdquo: '\u201d', hellip: '\u2026', bull: '\u2022',
    euro: '\u20ac', aacute: '\u00e1', eacute: '\u00e9', iacute: '\u00ed', oacute: '\u00f3', uacute: '\u00fa', ntilde: '\u00f1', uuml: '\u00fc', ouml: '\u00f6',
    auml: '\u00e4', ccedil: '\u00e7', egrave: '\u00e8', agrave: '\u00e0', Aacute: '\u00c1', Eacute: '\u00c9', Iacute: '\u00cd', Oacute: '\u00d3', Uacute: '\u00da',
    Ntilde: '\u00d1' };
  const unent = s => String(s).replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (m, e) => {
    if (e[0] !== '#') { const k = Object.hasOwn(ENTS, e) ? e : e.toLowerCase(); return Object.hasOwn(ENTS, k) ? ENTS[k] : m; } // (only its own names: never "constructor")
    const n = /^#x/i.test(e) ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    try { return String.fromCodePoint(n); } catch (x) { return m; }
  });
  // text as it is in the page: its entities kept (they are only text), anything else that could start markup escaped
  const richText = t => t.replace(/&(?!(#\d+|#x[\da-f]+|[a-z][a-z\d]*);)/gi, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  function richAttrs(tag, src) {
    const a = {};
    for (const m of src.matchAll(/([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) a[m[1].toLowerCase()] = unent(m[2] != null ? m[2] : m[3] != null ? m[3] : m[4] || '').trim();
    const esc = MB.escapeHtml, num = v => /^\d{1,4}$/.test(v) ? v : null;
    let out = '';
    if (tag === 'a') {
      if (/^(https?:\/\/|mailto:)/i.test(a.href || '')) out += ` href="${esc(a.href)}" target="_blank" rel="noopener noreferrer"`;
    } else if (tag === 'img') {
      if (!/^https?:\/\//i.test(a.src || '') && !/^data:image\/(png|jpe?g|gif|webp);base64,[\w+/=\s]+$/i.test(a.src || '')) return null; // (a picture inside a KMZ is not kept)
      out += ` src="${esc(a.src)}" loading="lazy" referrerpolicy="no-referrer"`;
      if (a.alt) out += ` alt="${esc(a.alt)}"`;
      if (num(a.width)) out += ` width="${a.width}"`;
      if (num(a.height)) out += ` height="${a.height}"`;
    } else if (tag === 'font') {
      if (/^(#[\da-f]{3,8}|[a-z]{3,20})$/i.test(a.color || '')) out += ` style="color:${a.color}"`;
    } else if (tag === 'td' || tag === 'th') {
      if (num(a.colspan)) out += ` colspan="${a.colspan}"`;
      if (num(a.rowspan)) out += ` rowspan="${a.rowspan}"`;
    }
    if (/^(p|div|td|th|h\d)$/.test(tag) && /^(left|center|right)$/i.test(a.align || '')) out += ` style="text-align:${a.align.toLowerCase()}"`;
    if (a.title && tag !== 'img') out += ` title="${esc(a.title)}"`;
    return out;
  }
  MB.isHtml = v => typeof v === 'string' && IS_RICH.test(v);
  MB.safeHtml = function (s) {
    s = String(s == null ? '' : s).replace(/<!\[CDATA\[|\]\]>/g, '').replace(/<!--[\s\S]*?(-->|$)/g, '').replace(GONE, '');
    let out = '', last = 0, m;
    const open = [];
    let droppedTables = 0;
    TAG.lastIndex = 0;
    while ((m = TAG.exec(s))) {
      out += richText(s.slice(last, m.index));
      last = TAG.lastIndex;
      const tag = m[2].toLowerCase();
      if (!RICH.has(tag)) continue; // an unknown tag: its text stays, the tag goes
      if (TABLE_PARTS.has(tag) && !open.includes('table')) continue; // a row or cell outside a table of its own would land in the popup's
      // One table at a time, never one inside another: where the page closes cells and rows on its own (a <tr> in a
      // cell, a second <caption>), a table opened in what looks like a cell would close the open one, and then the
      // popup's. With a single table of its own, only its real end closes it.
      if (tag === 'table') {
        if (m[1] && droppedTables) { droppedTables--; continue; } // (the end of one dropped: not the end of the one around it)
        if (!m[1] && open.includes('table')) { droppedTables++; continue; }
      }
      if (m[1]) { // a closing tag: what it closes, and what was left open inside it
        const i = open.lastIndexOf(tag);
        if (i >= 0) while (open.length > i) out += `</${open.pop()}>`;
        continue;
      }
      const attrs = richAttrs(tag, m[3] || '');
      if (attrs === null) continue;
      out += `<${tag}${attrs}>`;
      if (!VOID_TAGS.has(tag)) open.push(tag);
    }
    out += richText(s.slice(last));
    while (open.length) out += `</${open.pop()}>`;
    return out;
  };
  MB.htmlText = function (s) {
    s = String(s == null ? '' : s);
    if (!/[<&]/.test(s)) return s.trim();
    // in markup with line break tags the file's own line breaks are spaces, as a browser shows them (a <br> then a
    // new line is one break); text with none (an entity, a bold word) keeps its lines
    if (/<br\b|<\/(p|div|tr|li|h\d)\s*>/i.test(s)) s = s.replace(/\s+/g, ' ');
    // (every tag here is read to the next '<' or '>', so no scan runs past one: linear on any input, crafted or not)
    return unent(s.replace(/<!\[CDATA\[|\]\]>/g, '').replace(/<!--[\s\S]*?(-->|$)/g, '').replace(GONE, '').replace(/<br\b[^<>]*>|<\/(p|div|tr|li|h\d)\s*>/gi, '\n').replace(/<[^<>]*>/g, ''))
      .replace(/\u00a0/g, ' ').split('\n').map(l => l.trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
  };
  // A value in a popup: its formatting kept (made safe) when it has any, else as text.
  MB.richValue = v => MB.isHtml(v) ? `<div class="mb-rich">${MB.safeHtml(v)}</div>` : MB.escapeHtml(v);

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

  /* ---------- rectangles (flat Web-Mercator math) ----------
   * A rectangle is a rectangle on the map, so its corners are worked out in Mercator x/y (the projection the map
   * draws in), never in degrees. The helpers take and return plain points {x, y} in any such frame (Mercator
   * radians with y up, or screen pixels with y down), so the drawing tool can use the map's own projection. */

  // Web-Mercator x, y of a point, in radians, y up.
  MB.mercXY = function (lat, lng) {
    const l = Math.max(-89.9999, Math.min(89.9999, +lat));
    return { x: +lng * D2R, y: Math.log(Math.tan(Math.PI / 4 + l * D2R / 2)) };
  };

  // The rectangle on the side a → b, deep enough to reach p: its corners as a ring [a, d, c, b] (a and c opposite).
  // Null when a and b are the same point, or p lies on the line through them (nothing to draw).
  MB.rectFrom3 = function (a, b, p) {
    const dx = b.x - a.x, dy = b.y - a.y, len = Math.sqrt(dx * dx + dy * dy);
    if (!(len > 1e-9)) return null;
    const nx = -dy / len, ny = dx / len; // the side's normal (unit)
    const h = (p.x - a.x) * nx + (p.y - a.y) * ny; // how deep, with its sign (p's side)
    if (!(Math.abs(h) > 1e-9)) return null;
    return [{ x: a.x, y: a.y }, { x: a.x + nx * h, y: a.y + ny * h }, { x: b.x + nx * h, y: b.y + ny * h }, { x: b.x, y: b.y }];
  };

  // The axis-aligned rectangle centered on c with p as a corner, as a ring (index 0 and 2 opposite).
  MB.rectFromCenter = function (c, p) {
    const qx = 2 * c.x - p.x, qy = 2 * c.y - p.y;
    const x0 = Math.min(qx, p.x), x1 = Math.max(qx, p.x), y0 = Math.min(qy, p.y), y1 = Math.max(qy, p.y);
    return [{ x: x0, y: y0 }, { x: x0, y: y1 }, { x: x1, y: y1 }, { x: x1, y: y0 }];
  };

  // Web-Mercator x, y back to a point on the map.
  MB.mercLatLng = function (x, y) {
    return { lat: (2 * Math.atan(Math.exp(y)) - Math.PI / 2) / D2R, lng: x / D2R };
  };

  const samePt = (a, b) => Math.abs(a.lat - b.lat) < 1e-12 && Math.abs(a.lng - b.lng) < 1e-12;

  // A ring's points as {lat, lng}, in either form ([lat, lng] pairs or LatLngs), without a closing duplicate
  // (a GeoJSON ring comes closed). Empty for anything else.
  function ringPts(latlngs) {
    if (!Array.isArray(latlngs) || !latlngs.length) return [];
    const pts = latlngs.map(p => (Array.isArray(p) ? { lat: +p[0], lng: +p[1] } : (p && typeof p === 'object' ? { lat: +p.lat, lng: +p.lng } : null)));
    if (pts.some(p => !p || !isFinite(p.lat) || !isFinite(p.lng))) return [];
    if (pts.length > 1 && samePt(pts[0], pts[pts.length - 1])) pts.pop();
    return pts;
  }

  // Whether a ring really is a rectangle on the map (four corners whose diagonals halve each other and are the same
  // length): a rotated one that would be lost if it were restored from its bounding box. The tolerance allows for
  // the 7 decimals a project file keeps.
  MB.isRectRing = function (latlngs) {
    const pts = ringPts(latlngs);
    if (pts.length !== 4) return false;
    const q = pts.map(p => MB.mercXY(p.lat, p.lng));
    const d1 = Math.sqrt((q[2].x - q[0].x) ** 2 + (q[2].y - q[0].y) ** 2);
    const d2 = Math.sqrt((q[3].x - q[1].x) ** 2 + (q[3].y - q[1].y) ** 2);
    const mid = Math.sqrt(((q[1].x + q[3].x - q[0].x - q[2].x) / 2) ** 2 + ((q[1].y + q[3].y - q[0].y - q[2].y) / 2) ** 2);
    const tol = Math.max(Math.max(d1, d2) * 1e-3, 1e-8);
    return mid <= tol && Math.abs(d1 - d2) <= tol;
  };

  // Whether a ring is upright (every edge due north-south or east-west): what a rectangle's bounding box gives.
  MB.isAxisRect = function (latlngs) {
    const pts = ringPts(latlngs);
    if (pts.length < 3) return false;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      if (Math.abs(a.lat - b.lat) >= 1e-9 && Math.abs(a.lng - b.lng) >= 1e-9) return false;
    }
    return true;
  };

  // The corners a rectangle must be kept by, or null when its bounding box says it all (an upright one, or a ring
  // that is no rectangle at all): four different corners that are not upright. It does not ask for a perfect
  // rectangle — a turned one dragged across the map comes back slightly skewed, every corner having moved by the
  // same degrees, which is not the same distance in the projection — so a turned rectangle is never straightened
  // into its box behind the user's back. (The skew itself is taken out when the drag ends: js/features.js.)
  MB.rectRing = function (latlngs) {
    const pts = ringPts(latlngs);
    if (pts.length !== 4) return null;
    for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) if (samePt(pts[i], pts[j])) return null; // a corner on a corner: nothing to keep
    return MB.isAxisRect(pts) ? null : pts;
  };

  // The true rectangle nearest a four-cornered ring: the same center, turn and size, its corners in the same order
  // (so the ring's angle is unchanged). Null for anything but four corners.
  MB.squareRect = function (latlngs) {
    const pts = ringPts(latlngs);
    if (pts.length !== 4) return null;
    const q = pts.map(p => MB.mercXY(p.lat, p.lng));
    const cx = (q[0].x + q[1].x + q[2].x + q[3].x) / 4, cy = (q[0].y + q[1].y + q[2].y + q[3].y) / 4;
    // the two pairs of opposite sides, averaged: the way the rectangle lies and how big it is
    const ax = ((q[1].x - q[0].x) + (q[2].x - q[3].x)) / 2, ay = ((q[1].y - q[0].y) + (q[2].y - q[3].y)) / 2;
    const bx = ((q[3].x - q[0].x) + (q[2].x - q[1].x)) / 2, by = ((q[3].y - q[0].y) + (q[2].y - q[1].y)) / 2;
    const h = Math.sqrt(ax * ax + ay * ay);
    if (!(h > 0)) return null;
    const ux = ax / h, uy = ay / h; // along the first edge
    let vx = -uy, vy = ux;          // square to it, on the side the other pair points
    if (bx * vx + by * vy < 0) { vx = -vx; vy = -vy; }
    const w = bx * vx + by * vy;
    const corner = (s, t) => MB.mercLatLng(cx + ux * h * s / 2 + vx * w * t / 2, cy + uy * h * s / 2 + vy * w * t / 2);
    return [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)];
  };

  // How far a ring is turned, in degrees [0, 360): the angle of its first edge, in Geoman's convention (0 for a
  // ring that starts south-west and runs north).
  MB.ringAngle = function (latlngs) {
    const pts = ringPts(latlngs);
    if (pts.length < 2) return 0;
    const a = MB.mercXY(pts[0].lat, pts[0].lng), b = MB.mercXY(pts[1].lat, pts[1].lng);
    const deg = Math.atan2(-(b.y - a.y), b.x - a.x) * 180 / Math.PI + 90; // (screen pixels count y downwards)
    return ((deg % 360) + 360) % 360;
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

  /* ----- a typed length ----- */
  // What a typed length can be in, and how many meters one is.
  MB.distanceUnits = { m: 1, km: 1000, ft: 0.3048, mi: 1609.344, NM: 1852 };
  // The units that may be typed after the number (it wins over the one chosen beside the box).
  const UNIT_WORDS = {
    m: 'm', meter: 'm', meters: 'm', metre: 'm', metres: 'm',
    km: 'km', kilometer: 'km', kilometers: 'km', kilometre: 'km', kilometres: 'km',
    ft: 'ft', foot: 'ft', feet: 'ft', "'": 'ft',
    mi: 'mi', mile: 'mi', miles: 'mi',
    nm: 'NM', nmi: 'NM'
  };
  const MIN_LENGTH = 0.01, MAX_LENGTH = 20000000; // meters: 1 cm to 20 000 km (anything else is a typo)
  const GROUPED = /^\d{1,3}(,\d{3})+(\.\d+)?$/; // 1,500 and 1,234.5: commas by thousands

  // A length as typed ("500", "1.5 km", ".5 mi", "1,5", "1,234.5 ft"), in the unit given unless the text names one:
  // { meters, unit }, or null for anything that is not a usable length.
  MB.parseDistance = function (text, unit) {
    const s = String(text == null ? '' : text).trim();
    if (!s || s.length > 40) return null; // (nothing this long is a length: no point picking it apart)
    // the number, then the unit if one is typed (the classes share no character: no backtracking over a long value)
    const m = /^(\.?\d[\d.,]*)\s*([a-z'′]*)$/i.exec(s);
    if (!m) return null;
    let u = MB.distanceUnits[unit] ? unit : 'm';
    const suffix = m[2].replace(/′/g, "'").toLowerCase();
    if (suffix) {
      if (!UNIT_WORDS[suffix]) return null;
      u = UNIT_WORDS[suffix];
    }
    // a comma groups thousands where it can ("1,500", "1,234.5"); on its own it is the decimal point ("1,5").
    // "1.234,5" is neither: it is not read as 1.2345 (that would be a thousandfold mistake), it is refused.
    let num = m[1];
    if (num.includes(',')) {
      if (num.includes('.') && !GROUPED.test(num)) return null;
      num = GROUPED.test(num) ? num.replace(/,/g, '') : num.replace(',', '.');
    }
    const v = /^\d*\.?\d*$/.test(num) ? Number(num) : NaN;
    const meters = v * MB.distanceUnits[u];
    if (!isFinite(meters) || meters < MIN_LENGTH || meters > MAX_LENGTH) return null;
    return { meters, unit: u };
  };

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

  // A marker's shape (style.markerShape; a pin when unset) and, for the small shapes, its size in px
  // (style.markerSize). The small shapes are centred on their point; the pin stands on it.
  MB.markerShapes = { pin: 'Pin', dot: 'Dot', diamond: 'Diamond', square: 'Square', triangle: 'Triangle' };
  const SHAPE_PATHS = {
    dot: '<circle cx="10" cy="10" r="8"/>',
    diamond: '<path d="M10 1.5 18.5 10 10 18.5 1.5 10z"/>',
    square: '<rect x="3" y="3" width="14" height="14" rx="1.5"/>',
    triangle: '<path d="M10 2.2 18.6 17.4H1.4z"/>'
  };
  MB.markerShape = st => (st && Object.prototype.hasOwnProperty.call(SHAPE_PATHS, st.markerShape)) ? st.markerShape : 'pin'; // (a file's own value: only these)
  MB.markerSize = st => Math.max(6, Math.min(48, Math.round(+(st && st.markerSize) || 16)));
  MB.shapeSvg = function (shape, color, size) {
    const p = SHAPE_PATHS[shape] || SHAPE_PATHS.dot;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 20 20">` +
      `<g fill="none" stroke="#000" stroke-opacity=".45" stroke-width="4" stroke-linejoin="round">${p}</g>` + // a dark edge on any background
      `<g fill="${color}" stroke="#fff" stroke-width="2" stroke-linejoin="round">${p}</g></svg>`;
  };
  MB.markerIcon = function (st) {
    const shape = MB.markerShape(st), color = (st && st.color) || '#e4572e';
    if (shape === 'pin') return MB.pinIcon(color);
    const s = MB.markerSize(st);
    return L.divIcon({ className: 'mb-pin mb-pin-' + shape, html: MB.shapeSvg(shape, color, s), iconSize: [s, s], iconAnchor: [s / 2, s / 2],
      popupAnchor: [0, -s / 2], tooltipAnchor: [0, -s / 2] });
  };
  // The marker's box around its point, in px (where its name label and measurements go).
  MB.markerBox = function (st) {
    if (MB.markerShape(st) === 'pin') return { l: -13, r: 13, t: -38, b: 0 };
    const h = MB.markerSize(st) / 2;
    return { l: -h, r: h, t: -h, b: h };
  };

  /* ---------- sizes that scale with the map ----------
   * A text (style.textScale) and an object's name label (label.scale) are either the same size at every zoom
   * ('screen', the default) or drawn as if printed on the map ('map'): the size they are set to at their reference
   * zoom, doubling with each zoom step in. */
  // The factor a map-scaled size is drawn at: 1 at refZoom. Anything else (fixed pixels, no reference zoom yet, a
  // project file's own nonsense) is drawn as set.
  MB.zoomScale = function (mode, refZoom, zoom) {
    const ref = typeof refZoom === 'number' ? refZoom : NaN;
    return mode === 'map' && isFinite(ref) ? Math.pow(2, (+zoom || 0) - ref) : 1;
  };
  // The size a name label shows at now, in px: never beyond LABEL_MAX_PX, where it stops growing (a label larger
  // than that would swallow the clicks around it).
  MB.LABEL_MAX_PX = 200;
  MB.labelShownPx = function (lb, zoom) {
    const size = +(lb && lb.size) || 12;
    return Math.min(size * MB.zoomScale(lb && lb.scale, lb && lb.refZoom, zoom), Math.max(MB.LABEL_MAX_PX, size));
  };
  // A change to a label's sizing, as a text's (js/features.js textSizing): switching to 'map' keeps the size it
  // shows (from this zoom on); back to fixed pixels, it keeps the size it shows now; a new size while it scales with
  // the map is the size at this zoom. The patch is changed in place and returned.
  MB.labelSizing = function (cur, patch, zoom) {
    cur = cur || {}; patch = patch || {};
    const was = cur.scale === 'map' ? 'map' : 'screen'; // (a project file's own value: one of the two)
    if ('scale' in patch) patch.scale = patch.scale === 'map' ? 'map' : 'screen';
    const mode = 'scale' in patch ? patch.scale : was;
    if (mode !== was) {
      if (mode === 'map') patch.refZoom = +zoom || 0;
      else { if (!('size' in patch)) patch.size = Math.max(1, Math.round(MB.labelShownPx(cur, zoom))); patch.refZoom = null; }
    }
    if ('size' in patch && mode === 'map') patch.refZoom = +zoom || 0;
    return patch;
  };

  // text, or a Blob as it is (an exported picture). True: the file is on its way (the browser and the desktop app
  // save it themselves); in the Android app this is MB.download of js/native.js, which answers false on a cancel.
  MB.download = function (filename, text, mime) {
    const blob = text instanceof Blob ? text : new Blob([text], { type: mime || 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 4000); // a phone's save sheet reads it after the click
    return true;
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
    plus: ic('<path d="M12 5v14M5 12h14"/>'),
    upload: ic('<path d="M12 16V5M7.5 9.5L12 5l4.5 4.5"/><path d="M4 17v2a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-2"/>'),
    gear: ic('<path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915"/><circle cx="12" cy="12" r="3"/>'), // settings
    sideLeft: ic('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/><path d="M4 5h4v14H4z" fill="currentColor" stroke="none"/>'), // on the left side
    sideRight: ic('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/><path d="M16 5h4v14h-4z" fill="currentColor" stroke="none"/>'), // on the right side
    sweep: ic('<path d="m16 22-1-4"/><path d="M19 14a1 1 0 0 0 1-1v-1a2 2 0 0 0-2-2h-3a1 1 0 0 1-1-1V4a2 2 0 0 0-4 0v5a1 1 0 0 1-1 1H6a2 2 0 0 0-2 2v1a1 1 0 0 0 1 1"/><path d="M5 14h14l2 6.8a1 1 0 0 1-1 1.2H4a1 1 0 0 1-1-1.2z"/><path d="m8 22 1-4"/>'), // a broom: clear a cache
    download: ic('<path d="M12 4v11M7.5 10.5L12 15l4.5-4.5"/><path d="M4 17v2a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-2"/>'), // fetch again to this device
    copy: ic('<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/>'),
    close: ic('<path d="M6 6l12 12M18 6L6 18"/>'),
    search: ic('<circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5L21 21"/>'),
    pinAdd: ic('<path d="M12 21s-6-5.3-6-11a6 6 0 0 1 12 0c0 1.3-.3 2.5-.8 3.6"/><circle cx="12" cy="10" r="2"/><path d="M18 16v6M15 19h6"/>'),
    clock: ic('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'), // the time on the map (clock.js)
    table: ic('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M3 15h18M9 4v16"/>'), // an attribute table
    sliders: ic('<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>'), // a layer's settings
    more: ic('<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>'),
    up: ic('<path d="M6 15l6-6 6 6"/>'),
    down: ic('<path d="M6 9l6 6 6-6"/>')
  };
  // An icon-only button. attrs: its other attributes as HTML (data-…, disabled); cls: more classes; label: what a
  // screen reader says when the short tooltip is not enough (in a list: which row, as 'Delete Alpha').
  MB.iconBtn = (icon, title, attrs, cls, label) => `<button type="button" class="icon-btn mini${cls ? ' ' + cls : ''}" title="${MB.escapeHtml(title)}" aria-label="${MB.escapeHtml(label || title)}"${attrs ? ' ' + attrs : ''}>${MB.ICON[icon]}</button>`;
  // A zoom level as the app writes it: the magnifying glass and the number, as in the status bar. zoomText: a text with
  // its "zoom 8" that way, the rest escaped; setZoomText: the same into an element, when it changed.
  MB.zoomIcon = MB.ICON.search.replace('<svg ', '<svg class="zi" ') + '<span class="sr-only">Zoom </span>';
  MB.zoomText = t => MB.escapeHtml(t).replace(/\bzoom (?=\d)/gi, MB.zoomIcon);
  MB.setZoomText = (el, t) => { if (el.textContent.toLowerCase() !== String(t).toLowerCase()) el.innerHTML = MB.zoomText(t); };

  // opts.danger: the yes button is a delete's red one, and Cancel has the focus (Enter does not delete).
  // opts.dismiss: closing the question without answering it (the ✕, Escape, the backdrop, Android's back) resolves
  // null, not false: for questions where "no" is a choice of its own and not the way out.
  MB.ask = function (message, yes, no, opts) {
    return new Promise(resolve => {
      const back = document.activeElement;
      const dlg = document.createElement('div');
      dlg.className = 'modal mb-ask';
      dlg.innerHTML = '<div class="modal-box" role="alertdialog" aria-modal="true">' + MB.modalCloseHtml + '<p class="ask-text"></p><div class="row right"><button type="button" class="btn" data-no></button><button type="button" class="btn primary" data-yes></button></div></div>';
      dlg.querySelector('.ask-text').textContent = message;
      dlg.querySelector('[data-yes]').textContent = yes || 'OK';
      dlg.querySelector('[data-no]').textContent = no || 'Cancel';
      const yesBtn = dlg.querySelector('[data-yes]'), noBtn = dlg.querySelector('[data-no]'), xBtn = dlg.querySelector('.modal-x');
      if (opts && opts.danger) yesBtn.classList.replace('primary', 'danger');
      const finish = v => {
        window.removeEventListener('keydown', onKey, true);
        dlg.remove();
        if (back && back !== document.body && back.isConnected && back.getClientRects().length && back.focus) back.focus(); // (the button that asked; not a menu's item, hidden by now)
        else { const open = Array.from(document.querySelectorAll('.modal:not(.hidden) .modal-x')).pop(); if (open) open.focus(); }
        resolve(v);
      };
      // While it is open no key reaches the app (Delete must not delete the selection behind it). Enter and Space
      // still press the focused button; Tab stays on the dialog's buttons; Escape, like the ✕, answers no (null with
      // opts.dismiss: nothing was answered).
      const away = opts && opts.dismiss ? null : false;
      const order = [xBtn, noBtn, yesBtn];
      const onKey = e => {
        e.stopPropagation();
        if (e.key === 'Escape') { e.preventDefault(); finish(away); }
        else if (e.key === 'Tab') {
          e.preventDefault();
          const i = order.indexOf(document.activeElement);
          order[(i < 0 ? order.length - 1 : i + (e.shiftKey ? order.length - 1 : 1)) % order.length].focus();
        }
        else if (!dlg.contains(e.target)) e.preventDefault();
      };
      yesBtn.addEventListener('click', () => finish(true));
      noBtn.addEventListener('click', () => finish(false));
      xBtn.addEventListener('click', () => finish(away));
      if (opts && opts.dismiss) dlg.addEventListener('click', e => { if (e.target === dlg) finish(null); }); // the backdrop
      window.addEventListener('keydown', onKey, true);
      document.body.appendChild(dlg);
      (opts && opts.danger ? noBtn : yesBtn).focus();
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
