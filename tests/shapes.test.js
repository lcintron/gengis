'use strict';
// The drawing tools' shapes: a typed length (MB.parseDistance), the rectangle math behind the tool's three modes and
// the menu that chooses them (js/shapes.js), the circle's radius label (js/tools.js), the line tool's close-the-shape
// magnet (js/geometry.js) and the checks that tell a turned rectangle from an upright one (features.js, scaletool.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = process.env.GENGIS_ROOT || path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

function loadUtil() {
  const L = { divIcon: o => ({ options: o }) };
  const ctx = { window: {}, L, console, Math, Date };
  vm.createContext(ctx);
  vm.runInContext(read('js/util.js'), ctx, { filename: 'util.js' });
  return ctx.window.MB;
}
const MB = loadUtil();

// The few DOM pieces js/shapes.js touches: a node that remembers its classes, attributes and handlers.
function fakeEl(tag) {
  return {
    tagName: (tag || 'DIV').toUpperCase(), id: '', className: '', title: '', innerHTML: '', dataset: {}, style: {},
    children: [], handlers: {}, attrs: {}, classes: new Set(),
    classList: {
      add(c) { this.el.classes.add(c); }, remove(c) { this.el.classes.delete(c); },
      contains(c) { return this.el.classes.has(c); },
      toggle(c, on) { const want = on === undefined ? !this.el.classes.has(c) : !!on; if (want) this.el.classes.add(c); else this.el.classes.delete(c); return want; }
    },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return this.attrs[k] == null ? null : this.attrs[k]; },
    addEventListener(t, fn) { (this.handlers[t] = this.handlers[t] || []).push(fn); },
    fire(t, e) { (this.handlers[t] || []).forEach(fn => fn(Object.assign({ stopPropagation() {}, preventDefault() {}, target: { closest: () => null } }, e))); },
    appendChild(c) { this.children.push(c); return c; },
    querySelector: () => null, querySelectorAll: () => [],
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }),
    focus() {}, closest: () => null
  };
}
const el = tag => { const e = fakeEl(tag); e.classList.el = e; return e; };

// js/shapes.js over a fake page: the toolbar's two menu buttons and a stand-in for the settings, the tools and the
// map, so what the keys and the menus do can be followed without a browser.
function loadShapes() {
  const els = { mapwrap: el(), toolbar: el(), shapeBtn: el('button'), rectBtn: el('button') };
  const ctx = {
    window: { addEventListener() {} }, L: {}, console, Math, Date, setTimeout,
    document: { addEventListener() {}, getElementById: id => els[id] || null, createElement: tag => el(tag) }
  };
  vm.createContext(ctx);
  vm.runInContext(read('js/shapes.js'), ctx, { filename: 'js/shapes.js' });
  const M = ctx.window.MB, out = { MB: M, tools: [], saves: 0, events: [], shapeBtn: els.shapeBtn, rectBtn: els.rectBtn };
  M.settings = {};
  M.saveSettings = () => { out.saves++; };
  M.tools = { current: 'select', set(n) { this.current = n; out.tools.push(n); }, startDraw() {} };
  M.emit = (...a) => out.events.push(a);
  M.on = () => {};
  M.map = { getContainer: () => els.mapwrap, on() {}, pm: { disableDraw() {} } };
  M.shapes.init();
  return out;
}

// MB.circleRadius.layout, as it stands in js/tools.js: where the radius label goes, in container pixels.
const layout = vm.runInNewContext('({ ' + read('js/tools.js').match(/\n    layout\(o\) \{[\s\S]*?\n    \},/)[0].trim().replace(/,$/, '') + ' }).layout', { Math });

// js/geometry.js's snap ring and its drawing listeners, over a fake map: enough to follow what the first vertex of a
// line or a polygon does as the shape is drawn.
function loadGeometry() {
  const src = read('js/geometry.js');
  const snap = /\n  MB\.snap = \{[\s\S]*?\n  \};/.exec(src)[0], geo = /\n  MB\.geometry = \{[\s\S]*?\n  \};/.exec(src)[0];
  const M = { SNAP_PX: 15, tools: {}, pxDist: (a, b) => Math.hypot(a.lat - b.lat, a.lng - b.lng) };
  const L = {
    Polyline: class {}, Polygon: class {},
    circleMarker: (ll, o) => ({ o, text: null, setLatLng() {}, setStyle(s) { Object.assign(this.o, s); }, setRadius(r) { this.o.radius = r; },
      bindTooltip(t) { this.text = t; }, setTooltipContent(t) { this.text = t; }, addTo() { return this; } })
  };
  const on = {};
  M.map = {
    createPane: () => ({ style: {} }), hasLayer: () => true, removeLayer() {},
    on(ev, fn) { ev.split(' ').forEach(t => (on[t] = on[t] || []).push(fn)); },
    pm: { Draw: {} }
  };
  const ctx = { MB: M, L, console, Math, setTimeout, flattenAll: ll => (Array.isArray(ll) ? ll : [ll]) };
  vm.runInNewContext(snap + '\n' + geo, ctx, { filename: 'js/geometry.js (snap, geometry)' });
  M.geometry.init();
  return { MB: M, fire: (t, e) => (on[t] || []).forEach(f => f(e)) };
}

// A shape being drawn, as Geoman's working layer: vertices pushed on, each one fired as pm:vertexadded.
function drawing(g, shape) {
  const wl = { lls: [], h: {}, on(t, fn) { (this.h[t] = this.h[t] || []).push(fn); }, getLatLngs() { return this.lls; } };
  g.fire('pm:drawstart', { shape, workingLayer: wl });
  return {
    wl, markers: [],
    add(lat, lng) {
      wl.lls.push({ lat, lng });
      const marker = { nth: wl.lls.length, on() {} };
      this.markers.push(marker);
      (wl.h['pm:vertexadded'] || []).forEach(fn => fn({ marker }));
      return marker;
    }
  };
}

const D2R = Math.PI / 180;
// Mercator x, y back to a point on the map (MB.mercXY the other way round).
const toLL = p => ({ lat: (2 * Math.atan(Math.exp(p.y)) - Math.PI / 2) / D2R, lng: p.x / D2R });
// A rectangle turned `deg` from north: one side from a, `len` long, `depth` deep, as lat/lngs.
function turnedRect(lat, lng, deg, len, depth) {
  const a = MB.mercXY(lat, lng), r = deg * D2R;
  const b = { x: a.x + len * Math.cos(r), y: a.y + len * Math.sin(r) };
  const ring = MB.rectFrom3(a, b, { x: a.x - depth * Math.sin(r), y: a.y + depth * Math.cos(r) });
  return ring.map(toLL);
}
// A ring as a project file keeps it (features.js rounds every coordinate to 7 decimals on the way out).
const lat = p => (p.lat != null ? p.lat : p[0]), lng = p => (p.lng != null ? p.lng : p[1]);
const round7 = ring => ring.map(p => [+lat(p).toFixed(7), +lng(p).toFixed(7)]);
// A ring as a GeoJSON file holds it: Leaflet writes 6 decimals unless told otherwise.
const round6 = ring => ring.map(p => [+lat(p).toFixed(6), +lng(p).toFixed(6)]);
// A drag, as Geoman does it: the same degrees added to every corner (which is not the same distance in the
// projection, so the shape comes out slightly skewed).
const dragNorth = (ring, deg) => ring.map(p => [lat(p) + deg, lng(p)]);

test('a typed length is read in the unit beside the box, or the one typed after the number', () => {
  assert.equal(MB.parseDistance('500', 'm').meters, 500);
  assert.equal(MB.parseDistance('500', 'ft').meters, 500 * 0.3048);
  assert.equal(MB.parseDistance('500', 'NM').meters, 500 * 1852);
  assert.equal(MB.parseDistance('500').meters, 500, 'no unit given: meters');
  assert.equal(MB.parseDistance('500', 'nonsense').meters, 500);

  assert.equal(MB.parseDistance('1.5km', 'm').meters, 1500);
  assert.equal(MB.parseDistance('1.5km', 'm').unit, 'km', 'the unit typed is reported back (the selector follows)');
  assert.equal(MB.parseDistance('2 mi', 'm').meters, 2 * 1609.344);
  assert.equal(MB.parseDistance('0.5 nm', 'm').meters, 0.5 * 1852);
  assert.equal(MB.parseDistance('6 FEET', 'm').meters, 6 * 0.3048);
  assert.equal(MB.parseDistance("6'", 'm').meters, 6 * 0.3048);
  assert.equal(MB.parseDistance('250 meters', 'ft').meters, 250);

  assert.equal(MB.parseDistance('1,5', 'm').meters, 1.5, 'a lone comma is the decimal point');
  assert.equal(MB.parseDistance('1,500', 'm').meters, 1500, 'unless it groups thousands');
  assert.equal(MB.parseDistance('1,234.5', 'm').meters, 1234.5, 'both: the comma groups thousands');
  assert.equal(MB.parseDistance('12,345,678', 'm').meters, 12345678);
  assert.equal(MB.parseDistance('.5', 'm').meters, 0.5, 'a leading dot: typing "." opens the box with it');
  assert.equal(MB.parseDistance('.5km', 'm').meters, 500);

  for (const bad of ['', '   ', 'abc', '0', '-3', '1e99', '1.2.3', '5 furlongs', '500m2', '20001 km', '0.001', '.', ',', '1,2.5']) {
    assert.equal(MB.parseDistance(bad, 'm'), null, JSON.stringify(bad) + ' is not a length');
  }
  assert.equal(MB.parseDistance('1.234,5', 'm'), null, 'the other way round is refused, never read as 1.2345');
  assert.equal(MB.parseDistance(null, 'm'), null);
  assert.deepEqual({ ...MB.distanceUnits }, { m: 1, km: 1000, ft: 0.3048, mi: 1609.344, NM: 1852 });

  // what is pasted into the box can be anything: reading it must not take time over the length of it
  const t0 = Date.now();
  assert.equal(MB.parseDistance('1' + ' '.repeat(100000) + 'm', 'm'), null, 'far too long to be a length');
  assert.equal(MB.parseDistance('1' + '0'.repeat(100000), 'm'), null);
  assert.ok(Date.now() - t0 < 500, 'read in no time at all (it took ' + (Date.now() - t0) + ' ms)');
});

test('a radius keeps its length when the units change, however small it is', () => {
  // tools.js writes the locked radius into the box in the new unit, then reads it back: the digits it writes must
  // be enough that the same length comes back (1 m in NM, rounded short, would be 0: no radius at all)
  const rewrite = (meters, unit) => { // what tools.js writes, with its fallback to meters
    let v = String(+(meters / MB.distanceUnits[unit]).toPrecision(6));
    if (!MB.parseDistance(v, unit)) return { text: String(+meters.toPrecision(6)), unit: 'm' };
    return { text: v, unit };
  };
  for (const meters of [0.01, 0.05, 1, 5, 500, 12345.6]) {
    for (const unit of ['m', 'km', 'ft', 'mi', 'NM']) {
      const w = rewrite(meters, unit);
      assert.doesNotMatch(w.text, /e/i, meters + ' m in ' + w.unit + ' is written out in full');
      const back = MB.parseDistance(w.text, w.unit);
      assert.ok(back, meters + ' m in ' + unit + ' ("' + w.text + ' ' + w.unit + '") is still a radius');
      assert.ok(Math.abs(back.meters - meters) < Math.max(meters * 1e-5, 1e-9), meters + ' m in ' + unit + ': the same length back');
    }
  }
  assert.match(read('js/tools.js'), /if \(!MB\.parseDistance\(v, sel\.value\)\) \{ sel\.value = 'm';/, 'tools.js falls back to meters');
});

test('three points make a rectangle: the side as clicked, the depth square to it', () => {
  const a = { x: 10, y: 20 }, b = { x: 16, y: 28 }; // the side (6, 8): 10 long
  const ring = MB.rectFrom3(a, b, { x: 10 + 4 * 0.8, y: 20 - 4 * 0.6 }); // 4 deep, to the right of a → b
  assert.equal(ring.length, 4);
  assert.deepEqual({ ...ring[0] }, { x: 10, y: 20 }, 'the first point clicked is a corner, exactly');
  assert.deepEqual({ ...ring[3] }, { x: 16, y: 28 }, 'and so is the second');
  const edge = (i, j) => ({ x: ring[j].x - ring[i].x, y: ring[j].y - ring[i].y });
  const len = e => Math.sqrt(e.x * e.x + e.y * e.y);
  for (let i = 0; i < 4; i++) {
    const u = edge(i, (i + 1) % 4), v = edge((i + 1) % 4, (i + 2) % 4);
    assert.ok(Math.abs(u.x * v.x + u.y * v.y) < 1e-9, 'corner ' + i + ' is a right angle');
  }
  assert.ok(Math.abs(len(edge(0, 3)) - 10) < 1e-9, 'the side keeps the length clicked');
  assert.ok(Math.abs(len(edge(0, 1)) - 4) < 1e-9, 'the depth is how far the third point lies off the side');

  // the third point on the other side: the rectangle is on that side too
  const other = MB.rectFrom3(a, b, { x: 10 - 4 * 0.8, y: 20 + 4 * 0.6 });
  assert.ok(other[1].x < ring[1].x && other[1].y > ring[1].y, 'the depth takes the sign of the third point');

  assert.equal(MB.rectFrom3(a, { x: 10, y: 20 }, { x: 1, y: 2 }), null, 'no side: nothing to draw');
  assert.equal(MB.rectFrom3(a, b, { x: 13, y: 24 }), null, 'the third point on the side itself: no depth');
});

test('from the center, the corner clicked and its opposite are the same distance away', () => {
  const ring = MB.rectFromCenter({ x: 5, y: 7 }, { x: 9, y: 10 });
  assert.equal(ring.length, 4);
  const xs = ring.map(p => p.x), ys = ring.map(p => p.y);
  assert.deepEqual([Math.min(...xs), Math.max(...xs)], [1, 9]);
  assert.deepEqual([Math.min(...ys), Math.max(...ys)], [4, 10]);
  assert.deepEqual({ x: (ring[0].x + ring[2].x) / 2, y: (ring[0].y + ring[2].y) / 2 }, { x: 5, y: 7 }, '0 and 2 are opposite corners (what Geoman is handed)');
  ring.forEach(p => { assert.ok(p.x === 1 || p.x === 9); assert.ok(p.y === 4 || p.y === 10); });
});

test('a rectangle is told from any other four-cornered shape, however it is turned or written', () => {
  const axis = [[10, 20], [11, 20], [11, 21], [10, 21]];
  assert.equal(MB.isRectRing(axis), true, 'upright, as [lat, lng] pairs');
  assert.equal(MB.isRectRing(axis.map(p => ({ lat: p[0], lng: p[1] }))), true, 'and as LatLngs');
  assert.equal(MB.isRectRing(axis.concat([axis[0]])), true, 'a closed ring (an imported one) is the same four corners');

  const turned = turnedRect(32.08, -81.09, 30, 0.002, 0.0008);
  assert.equal(MB.isRectRing(turned), true, 'turned 30°');
  assert.equal(MB.isRectRing(round7(turned)), true, 'and after a project file rounds it to 7 decimals');
  const tiny = turnedRect(32.08, -81.09, 30, 2e-5, 8e-6); // a few meters across
  assert.equal(MB.isRectRing(round7(tiny)), true, 'a tiny turned one survives the rounding too');

  const parallelogram = [[10, 20], [10.5, 20.5], [10.5, 21.5], [10, 21]];
  assert.equal(MB.isRectRing(parallelogram), false, 'the diagonals halve each other but are not the same length');
  assert.equal(MB.isRectRing([[10, 20], [11, 20], [11, 21]]), false, 'a triangle');
  assert.equal(MB.isRectRing([[10, 20], [11, 20], [11, 21], [10, 21], [10.5, 21.5]]), false, 'five corners');
  assert.equal(MB.isRectRing([]), false);
  assert.equal(MB.isRectRing(null), false);
});

test('an upright rectangle is the one a bounding box can rebuild; a turned one carries its angle', () => {
  const axis = [[10, 20], [10, 21], [11, 21], [11, 20]];
  assert.equal(MB.isAxisRect(axis), true);
  assert.equal(MB.isAxisRect(axis.concat([axis[0]])), true, 'closed: the same');
  assert.equal(MB.isAxisRect(turnedRect(32.08, -81.09, 30, 0.002, 0.0008)), false);
  assert.equal(MB.isAxisRect([[10, 20], [11, 21], [11, 20]]), false);

  // Geoman counts the angle from the first edge, clockwise from north (its pixels count y downwards)
  assert.equal(MB.ringAngle([[10, 20], [11, 20], [11, 21], [10, 21]]), 0, 'south-west to north-west: upright');
  assert.ok(Math.abs(MB.ringAngle([[10, 20], [10, 21], [11, 21], [11, 20]]) - 90) < 1e-6, 'first edge due east: 90');
  const ang = MB.ringAngle(turnedRect(32.08, -81.09, 30, 0.002, 0.0008));
  assert.ok(Math.abs(ang - 330) < 1e-6, 'a side 30° north of east: its depth edge runs 330 (got ' + ang + ')');
  assert.ok(MB.ringAngle([[10, 20]]) === 0, 'too few points: nothing is turned');
});

// What restoreFeature does with a rectangle: MB.rectRing(ring) decides, so a save-and-reload (serialize rounds to
// 7 decimals) can be followed end to end here, the bounding box standing for what would be lost.
const boxOf = ring => {
  const lats = ring.map(p => p.lat != null ? p.lat : p[0]), lngs = ring.map(p => p.lng != null ? p.lng : p[1]);
  return [[Math.min(...lats), Math.min(...lngs)], [Math.min(...lats), Math.max(...lngs)], [Math.max(...lats), Math.max(...lngs)], [Math.max(...lats), Math.min(...lngs)]];
};
const restore = ring => MB.rectRing(ring) || boxOf(ring); // the corners kept, or the box as before
const far = (a, b) => Math.max(...a.map((p, i) => Math.max(Math.abs(lat(p) - lat(b[i])), Math.abs(lng(p) - lng(b[i])))));

test('a turned rectangle keeps its corners through a save, an undo, a copy and an import', () => {
  const ring = round7(turnedRect(32.08, -81.09, 30, 0.002, 0.0008));
  assert.ok(far(restore(ring), ring) < 1e-9, 'saved and restored, corner for corner');
  assert.ok(far(boxOf(ring), ring) > 1e-4, 'and its bounding box is nowhere near them (what a straightening would give)');
  // dragged north: Geoman moves every corner by the same degrees, which skews it in the projection. Past 20 km or
  // so it is no longer a perfect rectangle, and it must still be kept as it is (its box would snap it upright).
  const dragged = round7(dragNorth(ring, 0.5));
  assert.equal(MB.isRectRing(dragged), false, 'the drag left it off square');
  assert.ok(far(restore(dragged), dragged) < 1e-9, 'restored corner for corner all the same');
  assert.ok(far(restore(round7(restore(dragged))), dragged) < 1e-6, 'and again on the next save and reload');
  // an upright one still comes from its bounds, as it always has (and a ring that is no rectangle is left alone)
  assert.equal(MB.rectRing([[10, 20], [10, 21], [11, 21], [11, 20]]), null, 'upright: the box says it all');
  assert.equal(MB.rectRing([[10, 20], [11, 21], [11, 20]]), null, 'three corners');
  assert.equal(MB.rectRing([[10, 20], [10, 20], [11, 21], [11, 20]]), null, 'a corner on a corner');
  assert.equal(MB.rectRing([[10, 20], [11, 20], [11, 21], [10, 21], [10, 20]]), null, 'closed and upright');
  assert.ok(MB.rectRing(ring.concat([ring[0]])), 'closed and turned: kept (an imported ring comes closed)');

  const features = read('js/features.js');
  const rect = /case 'rectangle': \{([\s\S]*?)\n      \}/.exec(features);
  assert.ok(rect, 'js/features.js restores a rectangle in a case of its own');
  assert.match(rect[1], /const ring = MB\.rectRing\(all\)/, 'the corners to keep, or null for the box');
  assert.match(rect[1], /layer\.setLatLngs\(ring\.map\(p => L\.latLng\(p\.lat, p\.lng\)\)\)/);
  assert.match(rect[1], /layer\.pm\._setAngle\(MB\.ringAngle\(ring\)\)/, 'and its angle, so dragging a corner keeps it rectangular');
  assert.match(rect[1], /L\.rectangle\(L\.latLngBounds\(all\), st\)/, 'an upright one is still built from its bounds');
  // the strict test is for an import only: a polygon tagged "rectangle" that is not one keeps its shape
  assert.match(read('js/storage.js'), /const rect = p\.type === 'rectangle' && MB\.isRectRing\(rings\[0\], true\);/);
});

test('a drag does not skew a turned rectangle: it is squared up again when the drag ends', () => {
  const ring = turnedRect(32.08, -81.09, 30, 0.002, 0.0008);
  const same = MB.squareRect(ring);
  assert.ok(far(same, ring) < 1e-9, 'one that is already square comes back unchanged');

  const dragged = dragNorth(ring, 0.5); // as Geoman drags it: the same degrees onto every corner
  const sq = MB.squareRect(dragged);
  assert.equal(MB.isRectRing(sq), true, 'squared up: a rectangle again');
  assert.equal(MB.isAxisRect(sq), false, 'and still turned');
  assert.ok(Math.abs(MB.ringAngle(sq) - MB.ringAngle(dragged)) < 0.5, 'its turn is kept');
  assert.ok(far(sq, dragged) < 1e-3, 'and it hardly moves: the skew is all that goes (the shape is 0.07 deg across)');
  // the center stays put
  const mid = r => [r.reduce((s, p) => s + lat(p), 0) / 4, r.reduce((s, p) => s + lng(p), 0) / 4];
  const [a, b] = [mid(sq), mid(dragged)];
  assert.ok(Math.abs(a[0] - b[0]) < 1e-7 && Math.abs(a[1] - b[1]) < 1e-7, 'about the same center');
  // squaring again changes nothing: a hundred drags cannot pile up
  assert.ok(far(MB.squareRect(sq), sq) < 1e-9, 'squaring a squared one is a no-op');
  assert.equal(MB.squareRect([[10, 20], [11, 21], [11, 20]]), null, 'three corners: nothing to square');

  assert.equal(MB.squareRect([[0, 0], [1, 1], [1, 0], [0, 1]]), null, 'a ring that crosses itself has no width: left as it is, not flattened to a line');
  assert.match(read('js/features.js'), /layer\.on\('pm:dragend', \(\) => \{ resquare\(layer\); changed\('move'\); \}\)/, 'squared when a drag ends (the Move tool: Geoman drags a whole layer there)');
  assert.match(read('js/features.js'), /function resquare\(layer\) \{[\s\S]*?MB\.squareRect\(ring\)/);
});

test('the Scale tool resizes a turned rectangle alike both ways (one axis would skew it)', () => {
  const scale = read('js/scaletool.js');
  assert.match(scale, /const turnedRect = layer => layer\.mb\.type === 'rectangle' && layer\.getLatLngs && !MB\.isAxisRect\(/);
  assert.match(scale, /const uniform = layer => \['circle', 'text', 'svg'\]\.includes\(layer\.mb\.type\) \|\| turnedRect\(layer\)/);
});

test('the rectangle button opens a menu of its three modes, and the one chosen is remembered', () => {
  const shapes = read('js/shapes.js'), ui = read('js/ui.js'), css = read('css/app.css'), html = read('index.html');
  // the ids are what a saved rectMode holds: they stay as they were, whatever the modes are called or ordered
  const modes = /const RECT_MODES = \[([\s\S]*?)\n  \];/.exec(shapes);
  assert.ok(modes, 'js/shapes.js lists the rectangle modes');
  assert.deepEqual([...modes[1].matchAll(/id: '(\w+)', name: '([^']+)'/g)].map(m => [m[1], m[2]]),
    [['center', 'Center'], ['corner', 'Diagonal'], ['three', '3 Points']], "the menu's order, the saved ids kept");
  assert.match(shapes, /return RECT_MODES\.some\(x => x\.id === m\) \? m : 'corner';/, 'anything else saved falls back to the diagonal');
  assert.match(shapes, /MB\.settings\.rectMode = m;\s*\n\s*MB\.saveSettings\(\);/, 'the mode is kept on this device');
  assert.match(shapes, /role="menuitemradio" data-rect-mode="\$\{m\.id\}"/, 'a menu of radio choices');
  assert.match(shapes, /pal\.setAttribute\('aria-label', 'Rectangle mode'\)/);
  assert.match(shapes, /if \(MB\.tools\.current === 'rectangle'\) \{ MB\.map\.pm\.disableDraw\(\); MB\.tools\.startDraw\('rectangle'\); \}/, 'a half-drawn rectangle goes when the mode changes');
  // the button itself: its own id, the mode's icon and name on it, and the menu it opens
  assert.match(html, /<button data-tool="rectangle" id="rectBtn" class="has-menu" title="Rectangle: Diagonal \(R\)" aria-haspopup="menu" aria-expanded="false" aria-controls="rectPalette">/);
  assert.match(html, /<button data-tool="polygon" id="shapeBtn" class="has-menu"[^>]*aria-controls="shapePalette">/, 'and the presets moved under the Polygon button');
  assert.match(shapes, /btn\.title = `Rectangle: \$\{m\.name\} \(R\)`;/);
  assert.match(shapes, /btn\.addEventListener\('click', e => \{ e\.stopPropagation\(\); this\.menu\.toggle\(\); \}\)/, 'the button is the menu: it never puts the tool away');
  assert.match(ui, /\$\$\('#toolbar button\[data-tool\]:not\(#shapeBtn\):not\(#rectBtn\)'\)/, 'so neither menu button sets its tool on a plain click');
  // the modes are gone from the tool hint; the hint still says what to click in each
  assert.doesNotMatch(ui, /MB\.(rectDraw|circleRadius)\.controls/, 'no controls in the hint any more');
  assert.doesNotMatch(shapes, /controls\(\)/);
  assert.doesNotMatch(ui, /has-controls/);
  assert.doesNotMatch(css, /has-controls|\.rect-modes/);
  assert.match(ui, /center: 'Click the center, then a corner\.'/);
  assert.match(ui, /three: 'Click two points for one side, then a third for the depth\.'/);
  assert.match(ui, /if \(name === 'rectangle'\) text = rectHints\[MB\.rectDraw\.mode\] \|\| text;/);
  // the three-point rectangle reaches the new object with its own corners
  assert.match(read('js/tools.js'), /if \(type === 'rectangle' && MB\.rectDraw\.pending\)/);
  assert.match(read('js/tools.js'), /layer\.pm\._setAngle\(MB\.ringAngle\(ring\)\)/);
  // the menu: a row of icon and name each, the one in use lighter, finger-sized on a phone and a touch screen
  assert.match(css, /\.mode-flyout \{ display: flex; flex-direction: column;/);
  assert.match(css, /\.mode-flyout svg \{ width: 20px; height: 20px;/);
  assert.match(css, /\.mode-flyout button\.active \{ background: var\(--bg-3\); color: var\(--text\);/);
  const phone = css.match(/@media \(max-width: 640px\) \{\n  #topbar[\s\S]*?\n\}/)[0];
  assert.match(phone, /\.mode-flyout button \{ min-height: 40px; \}/, 'a phone: finger-sized rows');
  const coarse = css.match(/@media \(hover: none\) and \(pointer: coarse\) \{\n  \/\* touch[\s\S]*?\n\}/)[0];
  assert.match(coarse, /\.mode-flyout button \{ min-height: 40px; \}/, 'and a touch screen of any size');
  assert.match(css, /\.mb-rect-center \.rect-start-marker\.visible::before/, 'the center mode marks its center with an X');
});

test('R draws a rectangle, and pressed again cycles to the next mode without leaving the tool', () => {
  const s = loadShapes();
  assert.equal(s.MB.rectDraw.mode, 'corner', 'nothing saved yet: the diagonal');
  // from another tool: the mode last used, no change
  s.MB.rectDraw.key();
  assert.deepEqual(s.tools, ['rectangle']);
  assert.equal(s.MB.rectDraw.mode, 'corner', 'the tool is turned on in the mode it was left in');
  // in the tool: each press is the next mode, the menu's order round again, and the tool stays put
  const seen = [];
  for (let i = 0; i < 4; i++) { s.MB.rectDraw.key(); seen.push(s.MB.rectDraw.mode); }
  assert.deepEqual(seen, ['three', 'center', 'corner', 'three'], 'center → corner → three → round again');
  assert.deepEqual(s.tools, ['rectangle'], 'R never puts the tool away');
  assert.equal(s.MB.settings.rectMode, 'three', 'and the mode is saved');
  assert.ok(s.saves > 0);
  assert.match(s.rectBtn.title, /^Rectangle: 3 Points \(R\)$/, 'the button shows the mode it draws in');
  assert.equal(s.rectBtn.getAttribute('aria-label'), 'Rectangle: 3 Points');
  // a mode chosen on the menu: the tool goes on in it (already drawing: it carries on in the new mode)
  s.tools.length = 0;
  s.MB.tools.current = 'select';
  s.MB.rectDraw.choose('center');
  assert.equal(s.MB.rectDraw.mode, 'center');
  assert.deepEqual(s.tools, ['rectangle']);
  s.tools.length = 0;
  s.MB.rectDraw.choose('center'); // the same one again: nothing changes, the tool is still the rectangle's
  assert.equal(s.MB.rectDraw.mode, 'center');
  assert.deepEqual(s.tools, [], 'already drawing: the tool is not set again (which would put it away)');
});

test('the preset shapes sit under the Polygon button; P draws a plain polygon', () => {
  const s = loadShapes();
  assert.deepEqual([...s.MB.shapes.presets].map(p => p.id), ['polygon', 'triangle', 'pentagon', 'hexagon', 'octagon', 'star', 'lightning'],
    'the plain polygon first, no rectangle among them');
  assert.equal(s.MB.shapes.current, 'polygon', 'nothing saved: the plain polygon');
  s.MB.settings.shapePreset = 'rectangle'; // what a device that chose the rectangle before holds
  assert.equal(s.MB.shapes.current, 'polygon', 'an id that is no preset any more falls back to the polygon');
  assert.equal(s.MB.shapes.toolOf('polygon'), 'polygon');
  assert.equal(s.MB.shapes.toolOf('star'), 'shape');
  assert.equal(s.shapeBtn.title, 'Polygon (P)');
  // a preset chosen: the button draws it with the preset tool
  s.MB.shapes.choose('star');
  assert.equal(s.MB.settings.shapePreset, 'star');
  assert.equal(s.shapeBtn.dataset.tool, 'shape');
  assert.equal(s.shapeBtn.title, 'Polygon: Star (P)');
  assert.deepEqual(s.tools, ['shape']);
  // P: back to the plain polygon, whatever the button held
  s.tools.length = 0;
  s.MB.tools.current = 'shape';
  s.MB.shapes.polygonKey();
  assert.equal(s.MB.settings.shapePreset, 'polygon');
  assert.equal(s.shapeBtn.dataset.tool, 'polygon');
  assert.deepEqual(s.tools, ['polygon']);
  const ui = read('js/ui.js');
  assert.match(ui, /if \(tool === 'rectangle' && MB\.rectDraw\) \{ e\.preventDefault\(\); MB\.rectDraw\.key\(\); return; \}/);
  assert.match(ui, /if \(tool === 'polygon' && MB\.shapes\) \{ e\.preventDefault\(\); MB\.shapes\.polygonKey\(\); return; \}/);
  assert.doesNotMatch(read('js/shapes.js'), /activate\(\)/, 'the old R-draws-the-preset entry point is gone');
  assert.match(read('index.html'), /<kbd>R<\/kbd> rectangle \(again: next mode\)/);
  assert.match(read('README.md'), /Rectangle \(again: its next mode\)/);
});

test('the circle takes a typed radius, in a label on the map at the end of a dimension line', () => {
  const tools = read('js/tools.js'), ui = read('js/ui.js'), css = read('css/app.css');
  assert.match(tools, /id="radiusInput"/);
  assert.match(tools, /id="radiusUnit"/);
  assert.match(tools, /<label for="radiusInput">R<\/label>/, 'the label says what the value is');
  assert.match(tools, /aria-label="Radius" placeholder="type a value"/);
  assert.match(tools, /aria-label="Radius unit"/);
  assert.match(tools, /aria-label="Clear radius"/);
  assert.match(tools, /MB\.parseDistance\(text, sel\.value\)/);
  assert.match(tools, /draw\.options\.minRadiusCircle = meters \|\| 0;/, 'Geoman keeps the radius while it is drawn');
  assert.match(tools, /draw\.options\.maxRadiusCircle = meters \|\| 0;/);
  assert.match(tools, /draw\._hintMarker\.fire\('move'\)/, 'the preview follows the moment it is typed');
  assert.match(tools, /if \(MB\.circleRadius\.locked\) this\._finishShape\(\);/, 'with a radius typed, one click is the whole circle');
  assert.match(tools, /setOptions\(\{ minRadiusCircle: 0, maxRadiusCircle: 0 \}\)/, 'and the circle made can still be resized');
  assert.match(tools, /opts\.minRadiusCircle = r; opts\.maxRadiusCircle = r;/, 'the draw starts with it');
  assert.match(tools, /if \(this\.current === 'circle' && name !== 'circle'\) MB\.circleRadius\.reset\(\)/, 'leaving the tool clears it');
  assert.match(tools, /e\.stopPropagation\(\); \/\/ the app's single-key shortcuts stay out of a typed value/);
  // the label lives in the map's container and is only ever moved (never re-parented: that would drop the caret and
  // a phone's keyboard), and a tap on it is not a click on the map
  const mount = /mount\(\) \{[\s\S]*?\n    \},/.exec(tools);
  assert.ok(mount, 'js/tools.js builds the label in mount()');
  assert.match(mount[0], /el\.className = 'mb-dim radius-row';/);
  assert.match(mount[0], /MB\.map\.getContainer\(\)\.appendChild\(el\)/);
  assert.match(mount[0], /line\.className = 'mb-dim-line';/, 'with the dimension line');
  assert.match(mount[0], /L\.DomEvent\.disableClickPropagation\(el\)/);
  assert.match(mount[0], /L\.DomEvent\.disableScrollPropagation\(el\)/);
  assert.match(read('js/ink.js'), /#toolbar, \.mb-scale-box, \.mb-dim'\)/, 'a finger on the label draws nothing on the map either');
  // docked under the instructions until there is a circle, attached to it after; never taken off the page while
  // it is being typed in
  assert.match(tools, /if \(name === 'circle'\) \{ this\.el\.style\.display = 'inline-flex'; this\.update\(\); return; \}/);
  assert.match(tools, /if \(document\.activeElement === this\.box\(\)\) \{ this\.dock\(\); return; \}/);
  assert.match(tools, /MB\.map\.on\('move zoomend viewreset resize', \(\) => this\.update\(\)\)/, 'it follows the map');
  assert.match(tools, /MB\.map\.on\('zoomstart', \(\) => this\.hide\(\)\)/);
  assert.match(tools, /MB\.circleRadius\.place\(center\.getLatLng\(\), MB\.circleRadius\.locked \|\| r\);\s*\n\s*MB\.circleRadius\.showLive\(r\);/,
    'a radius dragged out is shown on the line and read out in the label');
  assert.match(tools, /if \(!box \|\| this\.locked \|\| \(box\.value && !this\.live\)\) return;/, 'a value typed by hand is never written over');
  assert.match(tools, /box\.addEventListener\('input', \(\) => \{ this\.live = false; this\.read\(\); \}\)/);
  assert.match(tools, /if \(document\.activeElement === box\) box\.select\(\)/, 'the first digit typed replaces the readout');
  // Enter with the center placed is the second click, even on a radius only read out (and never for no radius)
  const finish = /finish\(\) \{[\s\S]*?\n    \},/.exec(tools);
  assert.match(finish[0], /if \(!\(r > 0\)\) return false;/);
  assert.match(finish[0], /draw\._finishShape\(\);\s*\n\s*return true;/);
  assert.match(tools, /if \(e\.key === 'Enter'\) \{ e\.preventDefault\(\); if \(!this\.finish\(\)\) box\.blur\(\); \}/);
  // a digit typed with the circle tool on starts a radius (the key itself must reach the box)
  const keys = /if \(MB\.tools\.current === 'circle'[\s\S]*?\n      \}/.exec(ui);
  assert.ok(keys, 'js/ui.js sends a digit to the radius box');
  assert.doesNotMatch(keys[0], /preventDefault/, 'the digit lands in the box, so the press is not taken');
  assert.match(ui, /Radius \$\{MB\.formatDistance\(MB\.circleRadius\.locked\)\}: click the map to place the circle\./);
  // the hint no longer holds any control, and the box docks under it: it is re-placed whenever the hint is redrawn
  const render = /function renderToolHint\(\) \{[\s\S]*?\n  \}/.exec(ui);
  assert.ok(render, 'js/ui.js has renderToolHint');
  assert.doesNotMatch(render[0], /hint\.innerHTML =/, 'the hint is not rebuilt whole');
  assert.match(render[0], /if \(MB\.circleRadius\) MB\.circleRadius\.update\(\);/);
  assert.match(render[0], /txt\.textContent = text;/);
  assert.match(css, /\.mb-dim \{[^}]*position: absolute;[^}]*cursor: auto;/, 'the label is placed by hand, and is not the map\'s crosshair');
  assert.match(css, /\.mb-dim \{[^}]*tabular-nums/);
  assert.match(css, /\.mb-dim-line \{[^}]*border-top: 1px solid var\(--accent\);/);
  assert.match(css, /\.mb-dim-line::before, \.mb-dim-line::after \{/, 'an arrowhead at each end');
  assert.match(css, /body\.presenting \.mb-dim, body\.presenting \.mb-dim-line \{ display: none !important; \}/);
  assert.match(css, /#radiusInput \{[^}]*tabular-nums/);
  assert.match(css, /#radiusInput, #radiusUnit \{ height: 36px; font-size: 16px; \}/, 'finger-sized, and no zoom on focus');
});

test('the radius label sits on the dimension line, under the circle when it does not fit, always inside the map', () => {
  const box = { w: 90, h: 28, mapW: 800, mapH: 600 };
  // a wide circle: the label on the line, 14 px clear of the center (never under the pointer, which sets the radius)
  let o = layout(Object.assign({ cx: 300, cy: 300, rPx: 200 }, box));
  assert.deepEqual([o.x, o.y], [314, 286], 'beside the center, centered on the line');
  assert.equal(o.lineLen, 200, 'the line runs from the center out to the edge');
  assert.equal(o.below, false);
  // too short a line to hold the label: under the circle instead, centered on it
  o = layout(Object.assign({ cx: 300, cy: 300, rPx: 40 }, box));
  assert.equal(o.below, true);
  assert.deepEqual([o.x, o.y], [255, 350], 'below the circle, out of the way of the line');
  assert.equal(o.lineLen, 40, 'the line is still drawn');
  // clamped into the map by 8 px, on every side
  o = layout(Object.assign({ cx: 795, cy: 598, rPx: 300 }, box));
  assert.deepEqual([o.x, o.y], [702, 564], 'the far corner: still wholly on screen');
  o = layout(Object.assign({ cx: 2, cy: 1, rPx: 10 }, box));
  assert.deepEqual([o.x, o.y], [8, 21], 'and the near one (where it would hang off the left edge)');
  assert.equal(layout(Object.assign({ cx: 300, cy: 300, rPx: 0 }, box)).lineLen, 0, 'no radius yet: no line');
});

test('the live radius written into the label reads back as the radius it shows', () => {
  // tools.js writes the radius of the circle being dragged out into the box as plain digits: short enough to read,
  // and still a length parseDistance brings back (an empty box for anything too small to be a radius at all)
  const liveText = (meters, unit) => {
    const txt = String(+(meters / MB.distanceUnits[unit]).toPrecision(4));
    return MB.parseDistance(txt, unit) ? txt : '';
  };
  for (const unit of ['m', 'km', 'ft', 'mi', 'NM']) {
    for (const meters of [0.5, 12, 480, 1234.5, 98765]) {
      const txt = liveText(meters, unit);
      assert.doesNotMatch(txt, /e/i, meters + ' m in ' + unit + ' is written out in full ("' + txt + '")');
      const back = MB.parseDistance(txt, unit);
      assert.ok(back, meters + ' m in ' + unit + ' ("' + txt + '") is still a radius');
      assert.ok(Math.abs(back.meters - meters) < Math.max(meters * 1e-3, 1e-9), 'and within a thousandth of it (4 digits of it are shown)');
    }
    assert.equal(liveText(0.0001, unit), '', 'the drag has barely started: nothing to show yet');
  }
  assert.match(read('js/tools.js'), /const text = MB\.parseDistance\(txt, sel\.value\) \? txt : '';/);
});

test('a finger or stylus can drag a rectangle or a circle out, while the mouse works as before', () => {
  const tools = read('js/tools.js');
  const drag = /MB\.drawDrag = \{[\s\S]*?\n  \};/.exec(tools);
  assert.ok(drag, 'js/tools.js has MB.drawDrag');
  const d = drag[0];
  assert.match(d, /addEventListener\('pointerdown', e => this\.down\(e\), true\)/, 'the capture phase: Leaflet never pans');
  assert.match(d, /if \(e\.pointerType === 'mouse' \|\| !e\.isPrimary \|\| e\.button !== 0 \|\| !MB\.ink\.onMap\(e\)\) return;/);
  assert.match(d, /this\.fire\('click', g\.p0, e\)/, 'the first point where the finger went down');
  assert.match(d, /this\.fire\('mousemove', p, e\)/, 'then the moves Geoman previews from');
  assert.match(d, /if \(!g\.placed\) \{ this\.fire\('mousemove', p, e\); return; \}/, "a tap is left alone (Geoman snaps the point, then takes the browser's own click)");
  assert.match(d, /second: this\.started\(\)/, 'a drag with a point already down sets the next one at the lift');
  assert.match(d, /if \(this\.ended != null && this\.ended === e\.pointerId\)/, "a gesture that made its shape at once still swallows its lift's click");
  assert.match(d, /this\.swallow = Date\.now\(\) \+ 400/, "the gesture's own click is swallowed");
  assert.match(d, /\['dragging', 'touchZoom'\]/, 'the map stays put while a shape is dragged out');
  assert.match(d, /MB\.map\.on\('zoomstart', \(\) => this\.cancel\(\)\)/);
  assert.match(d, /MB\.map\.on\('pm:create', \(\) => \{ if \(this\.g\) this\.g\.created = true; \}\)/, 'a shape made mid-gesture (a typed radius) ends it');
  assert.match(d, /classList\.add\('mb-shape-draw'\)/);
  assert.match(tools, /if \(name === 'rectangle' \|\| name === 'circle'\) MB\.drawDrag\.start\(\)/);
  assert.match(tools, /MB\.drawDrag\.stop\(\);/);
  assert.match(read('css/app.css'), /\.leaflet-container\.mb-shape-draw \{ touch-action: none; \}/);
});

test('the vendored Geoman still has every private name the rectangle and circle tools build on', () => {
  const geoman = read('vendor/geoman/leaflet-geoman.min.js');
  for (const name of ['_syncRectangleSize', '_finishShape', '_placeStartingMarkers', '_placeCenterMarker', '_styleMarkers',
    '_centerMarker', '_hintMarker', '_startMarker', '_layerGroup', '_snapped', 'minRadiusCircle', 'maxRadiusCircle', '_setAngle',
    '_otherSnapLayers', '_cleanupSnapping']) {
    assert.ok(geoman.includes(name), 'vendor/geoman: ' + name + ' (used by js/shapes.js, js/tools.js and js/geometry.js)');
  }
  // the line's magnet is the polygon's own: its first vertex marker goes into the snap list, and the list is rebuilt
  assert.match(geoman, /this\._otherSnapLayers\.push\(t\)-1,this\.options\.snappable&&this\._cleanupSnapping\(\)/,
    'vendor/geoman: that is what the polygon does with its first vertex (js/geometry.js does it for the line)');
  assert.match(geoman, /else if\(this\._otherSnapLayers&&this\._otherSnapLayers\.length>0\)/,
    'vendor/geoman: and they pull the pointer in even with snapping off');
  // the names are wrapped where they are, so an update that renames one is caught here too
  assert.match(read('js/shapes.js'), /L\.PM\.Draw\.Rectangle && L\.PM\.Draw\.Rectangle\.prototype/);
  assert.match(read('js/shapes.js'), /!P\.enable \|\| !P\._syncRectangleSize \|\| !P\._finishShape/, 'a Geoman without them is left alone');
  assert.match(read('js/tools.js'), /L\.PM\.Draw\.Circle && L\.PM\.Draw\.Circle\.prototype/);
  assert.match(read('js/tools.js'), /if \(Circle && Circle\._placeCenterMarker && !Circle\._mbRadiusBox\)/);
});

test('the arrow keys move along a group of radio buttons that is itself the root given', () => {
  // MB.ui.radios, as it stands in js/ui.js, run against a stand-in for the buttons: before, it looked for groups
  // INSIDE what it was given, so a group handed in whole got no handler at all and its unchosen buttons were left
  // out of the keyboard's reach.
  const src = read('js/ui.js');
  const fn = /MB\.ui\.radios = function[\s\S]*?\n  \};/.exec(src);
  assert.ok(fn, 'js/ui.js has MB.ui.radios');
  const doc = { activeElement: null };
  const ctx = { MB: { ui: {} }, Array, Object, document: doc, console };
  vm.runInNewContext(fn[0], ctx, { filename: 'ui.js (MB.ui.radios)' });

  const names = ['corner', 'center', 'three'];
  const buttons = names.map((id, i) => ({
    id, checked: i === 0, tabIndex: null, clicks: 0,
    getAttribute(k) { return k === 'role' ? 'radio' : k === 'aria-checked' ? String(this.checked) : null; },
    focus() { doc.activeElement = this; },
    click() { this.clicks++; buttons.forEach(b => { b.checked = b === this; }); }
  }));
  const on = {};
  const group = {
    getAttribute: k => (k === 'role' ? 'radiogroup' : k === 'aria-label' ? 'Rectangle mode' : null),
    querySelectorAll: sel => (sel.includes('radiogroup') ? [] : buttons.slice()), // no group inside it: it IS the group
    addEventListener: (t, f) => { on[t] = f; }
  };
  ctx.MB.ui.radios(group);
  assert.ok(on.keydown, 'the group listens for the arrow keys');
  assert.deepEqual(buttons.map(b => b.tabIndex), [0, -1, -1], 'the chosen mode is the one Tab lands on');

  const press = key => { let taken = false; on.keydown({ key, preventDefault: () => { taken = true; } }); return taken; };
  doc.activeElement = buttons[0];
  assert.equal(press('ArrowRight'), true, 'the press is answered here');
  assert.equal(doc.activeElement, buttons[1], 'focus moves to the next mode');
  assert.equal(buttons[1].clicks, 1, 'and chooses it (the mode changes as the keyboard moves)');
  press('ArrowRight');
  assert.equal(doc.activeElement, buttons[2]);
  press('ArrowRight');
  assert.equal(doc.activeElement, buttons[0], 'round again');
  press('ArrowLeft');
  assert.equal(doc.activeElement, buttons[2], 'and the other way');
  assert.equal(press('Enter'), false, 'other keys are left alone');
});

// What the GeoJSON importer makes of a ring tagged "rectangle" (js/storage.js): kept as a rectangle when it is near
// enough to be one, a turned one squared up exact; null stands for "comes in as a polygon".
const importRect = ring => {
  if (!MB.isRectRing(ring, true)) return null;
  const sq = MB.rectRing(ring) && MB.squareRect(ring);
  return sq ? sq.map(q => [q.lat, q.lng]) : ring;
};

test("the app's own GeoJSON brings a small turned rectangle back as a rectangle, not a polygon", () => {
  // About 20 x 8 m, turned: the 6 decimals Leaflet writes by default are 0.11 m, which leaves a shape this small a
  // hair off square, and the strict test called it a polygon. Rectangles now go out with 7 decimals, and whatever
  // decimals a file holds, a near-rectangle is snapped back to exact on the way in.
  const small = [10, 30, 45, 70, 115, 200, 300].map(deg => turnedRect(32.08, -81.09, deg, 3.7e-6, 1.5e-6));
  let strictLost = 0;
  for (const ring of small) {
    const at6 = round6(ring), at7 = round7(ring);
    assert.equal(MB.isRectRing(at7), true, '7 decimals (what a rectangle is exported with now): still a rectangle');
    if (!MB.isRectRing(at6)) strictLost++;
    assert.equal(MB.isRectRing(at6, true), true, '6 decimals: near enough to be one');
    const back = importRect(at6);
    assert.ok(back, 'imported as a rectangle, not a free polygon');
    assert.equal(MB.isRectRing(back), true, 'and square again, so the next save keeps it');
    assert.equal(MB.isAxisRect(back), false, 'still turned');
    assert.ok(MB.rectRing(back), 'restored corner for corner, never as its box');
    assert.ok(far(back, at6) < 2e-6, 'and within a quarter of a meter of what the file held');
  }
  assert.ok(strictLost > 0, 'the strict test really does lose some of them at 6 decimals (what this guards against)');
  // a ring that is no rectangle still comes in as a polygon, with its own shape
  assert.equal(importRect([[10, 20], [10.5, 20.5], [10.5, 21.5], [10, 21]]), null, 'a parallelogram stays a polygon');
  assert.equal(importRect([[10, 20], [11, 20], [11, 21]]), null, 'and a triangle');

  const storage = read('js/storage.js');
  assert.match(storage, /l\.toGeoJSON\(m\.type === 'rectangle' \? 7 : undefined\)\.geometry/, 'rectangles are written with 7 decimals');
  assert.match(storage, /const rect = p\.type === 'rectangle' && MB\.isRectRing\(rings\[0\], true\);/, 'and read with the generous test');
  assert.match(storage, /const sq = MB\.squareRect\(rings\[0\]\);/, 'a turned one squared up exact');
  // the ghost's color is cached (it is redrawn on every move): cleared wherever the next object's color can change,
  // which is refreshDraw (the New shapes panel changes it from there without any features event)
  const refresh = /refreshDraw\(\) \{[\s\S]*?\n    \},/.exec(read('js/tools.js'));
  assert.ok(refresh, 'js/tools.js has refreshDraw');
  assert.match(refresh[0], /MB\.circleRadius\.color = null;/, 'the radius ghost takes the new color too');
});

test("the line tool's first vertex pulls the pointer in from the third vertex on, like the polygon's", () => {
  const g = loadGeometry();
  const line = { options: { snappable: true }, _otherSnapLayers: [], cleanups: 0, _cleanupSnapping() { this.cleanups++; }, _finishShape() {} };
  g.MB.map.pm.Draw.Line = line;
  const d = drawing(g, 'Line');
  d.add(0, 0);
  assert.equal(g.MB.snap.first, d.markers[0], 'the first vertex is kept: the snap ring names it');
  assert.deepEqual(line._otherSnapLayers, [], 'one point: there is nothing to close yet');
  d.add(0, 100);
  assert.deepEqual(line._otherSnapLayers, [], 'two: closing them would make no shape');
  d.add(100, 100);
  assert.deepEqual(line._otherSnapLayers, [d.markers[0]], 'three: the first vertex goes to the magnet');
  assert.equal(line.cleanups, 1, 'and the snap list is rebuilt with it');
  d.add(100, 0);
  assert.equal(line._otherSnapLayers.length, 1, 'handed over once only, however long the line gets');
  assert.equal(line.cleanups, 1);
  // the polygon's magnet is the drawing library's own: nothing is added for it here
  line._otherSnapLayers = []; line.cleanups = 0;
  const p = drawing(g, 'Polygon');
  p.add(0, 0); p.add(0, 100); p.add(100, 100);
  assert.deepEqual(line._otherSnapLayers, [], 'the polygon looks after itself');
  assert.equal(line.cleanups, 0);
  assert.equal(g.MB.snap.first, p.markers[0], 'but its first vertex is known all the same');
  g.fire('pm:drawend', {});
  assert.equal(g.MB.snap.first, null, 'and forgotten when the drawing ends');
  // closing by a click on the first vertex: either the marker's own press or the pointer pulled onto it
  const tools = read('js/tools.js');
  assert.match(tools, /const atFirst = !!hintLL && MB\.isLatLng\(lls\[0\]\) && MB\.pxDist\(lls\[0\], hintLL\) <= 1\.5;/);
  assert.match(tools, /const byClick = \(this\._closeLine \|\| atFirst\) && lls\.length >= 3 && MB\.isLatLng\(lls\[0\]\);/);
  assert.match(tools, /const pts = \(byProximity \? lls\.slice\(0, -1\) : lls\)/, 'a vertex dropped on the first one is not kept twice');
  assert.match(tools, /MB\.restoreFeature\(\{ type: 'polygon', latlngs: \[pts\], layerId: MB\.activeLayer\(\)\.id, style: MB\.newShapeStyle\(true\) \}\)/);
  assert.match(tools, /MB\.toast\('Closed outline: saved as a polygon \(/);
});

test('the snap ring on the first vertex of the shape being drawn says "close"', () => {
  const g = loadGeometry();
  const marker = { getLatLng: () => ({ lat: 1, lng: 2 }) }; // a vertex marker: no latlngs of its own
  const ev = { snapLatLng: { lat: 1, lng: 2 }, layerInteractedWith: marker };
  g.MB.snap.first = marker;
  g.MB.snap.show(ev);
  assert.equal(g.MB.snap.marker.text, 'close', 'back on the first vertex: the click closes the shape');
  assert.equal(g.MB.snap.marker.o.radius, 11, 'and the ring is the bigger one');
  g.MB.snap.first = { getLatLng: () => ({ lat: 9, lng: 9 }) }; // another shape's first vertex
  g.MB.snap.show(ev);
  assert.equal(g.MB.snap.marker.text, 'point', 'any other point is a point');
  assert.equal(g.MB.snap.marker.o.radius, 8);
});
