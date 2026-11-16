'use strict';
// The drawing tools' shapes: a typed length (MB.parseDistance), the rectangle math behind the tool's three modes
// (js/shapes.js) and the checks that tell a turned rectangle from an upright one (js/features.js, js/scaletool.js).
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
const round7 = ring => ring.map(p => [+p.lat.toFixed(7), +p.lng.toFixed(7)]);

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

  for (const bad of ['', '   ', 'abc', '0', '-3', '1e99', '1.2.3', '5 furlongs', '500m2', '20001 km', '0.001']) {
    assert.equal(MB.parseDistance(bad, 'm'), null, JSON.stringify(bad) + ' is not a length');
  }
  assert.equal(MB.parseDistance(null, 'm'), null);
  assert.deepEqual({ ...MB.distanceUnits }, { m: 1, km: 1000, ft: 0.3048, mi: 1609.344, NM: 1852 });
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

test('a turned rectangle keeps its corners through a save, an undo, a copy and an import', () => {
  const features = read('js/features.js');
  const rect = /case 'rectangle': \{([\s\S]*?)\n      \}/.exec(features);
  assert.ok(rect, "js/features.js restores a rectangle in a case of its own");
  assert.match(rect[1], /MB\.isRectRing\(ring\) && !MB\.isAxisRect\(ring\)/, 'a real rectangle that is not upright keeps its corners');
  assert.match(rect[1], /layer\.setLatLngs\(ring\)/);
  assert.match(rect[1], /layer\.pm\._setAngle\(MB\.ringAngle\(ring\)\)/, 'and its angle, so dragging a corner keeps it rectangular');
  assert.match(rect[1], /L\.rectangle\(L\.latLngBounds\(ring\), st\)/, 'an upright one is still built from its bounds');
  assert.match(rect[1], /ring\[0\]\.equals\(ring\[ring\.length - 1\]\)/, 'an imported ring comes closed');
});

test('the Scale tool resizes a turned rectangle alike both ways (one axis would skew it)', () => {
  const scale = read('js/scaletool.js');
  assert.match(scale, /const turnedRect = layer => layer\.mb\.type === 'rectangle' && layer\.getLatLngs && !MB\.isAxisRect\(/);
  assert.match(scale, /const uniform = layer => \['circle', 'text', 'svg'\]\.includes\(layer\.mb\.type\) \|\| turnedRect\(layer\)/);
});

test('the rectangle tool offers its three modes in the tool hint, and remembers the one chosen', () => {
  const shapes = read('js/shapes.js'), ui = read('js/ui.js'), css = read('css/app.css');
  for (const id of ['corner', 'center', 'three']) assert.match(shapes, new RegExp("id: '" + id + "'"), 'the ' + id + ' mode');
  assert.match(shapes, /MB\.settings\.rectMode = m;\s*\n\s*MB\.saveSettings\(\);/, 'the mode is kept on this device');
  assert.match(shapes, /data-rect-mode="\$\{m\.id\}"/);
  assert.match(shapes, /\[data-rect-mode\]/, 'its buttons have a handler of their own (not a data-act)');
  assert.doesNotMatch(shapes, /data-act="rect/, 'no action a menu would have to handle');
  assert.match(shapes, /setAttribute\('role', 'radiogroup'\)/);
  assert.match(shapes, /setAttribute\('aria-label', 'Rectangle mode'\)/);
  assert.match(shapes, /if \(MB\.tools\.current === 'rectangle'\) \{ MB\.map\.pm\.disableDraw\(\); MB\.tools\.startDraw\('rectangle'\); \}/, 'a half-drawn rectangle goes when the mode changes');
  // the hint says what to click in each mode, and holds the buttons
  assert.match(ui, /center: 'Click the center, then a corner\.'/);
  assert.match(ui, /three: 'Click two points for one side, then a third for the depth\.'/);
  assert.match(ui, /if \(name === 'rectangle'\) text = rectHints\[MB\.rectDraw\.mode\] \|\| text;/);
  assert.match(ui, /name === 'rectangle' \? MB\.rectDraw\.controls\(\)/);
  assert.match(ui, /hint\.classList\.toggle\('has-controls', !!controls\)/);
  // the three-point rectangle reaches the new object with its own corners
  assert.match(read('js/tools.js'), /if \(type === 'rectangle' && MB\.rectDraw\.pending\)/);
  assert.match(read('js/tools.js'), /layer\.pm\._setAngle\(MB\.ringAngle\(ring\)\)/);
  assert.match(css, /\.tool-hint\.has-controls \{ pointer-events: auto; \}/);
  assert.match(css, /\.rect-modes span \{ display: none; \}/, 'a phone shows the modes by their icons');
  assert.match(css, /\.mb-rect-center \.rect-start-marker\.visible::before/, 'the center mode marks its center with an X');
});

test('the circle takes a typed radius, in the box in its tool hint', () => {
  const tools = read('js/tools.js'), ui = read('js/ui.js'), css = read('css/app.css');
  assert.match(tools, /id="radiusInput"/);
  assert.match(tools, /id="radiusUnit"/);
  assert.match(tools, /<label for="radiusInput">Radius<\/label>/, 'the box is labelled');
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
  // a digit typed with the circle tool on starts a radius (the key itself must reach the box)
  const keys = /if \(MB\.tools\.current === 'circle'[\s\S]*?\n      \}/.exec(ui);
  assert.ok(keys, 'js/ui.js sends a digit to the radius box');
  assert.doesNotMatch(keys[0], /preventDefault/, 'the digit lands in the box, so the press is not taken');
  assert.match(ui, /name === 'circle' \? MB\.circleRadius\.controls\(\)/);
  assert.match(ui, /Radius \$\{MB\.formatDistance\(MB\.circleRadius\.locked\)\}: click the map to place the circle\./);
  // the hint is redrawn as the radius is typed: the box must not be taken off the page (it would lose the keyboard
  // and the caret), so the instructions and the warning are changed in place around it
  const render = /function renderToolHint\(\) \{[\s\S]*?\n  \}/.exec(ui);
  assert.ok(render, 'js/ui.js has renderToolHint');
  assert.doesNotMatch(render[0], /hint\.innerHTML =/, 'the hint is not rebuilt whole');
  assert.match(render[0], /if \(controls && controls\.parentNode !== hint\) hint\.appendChild\(controls\)/, 'the box stays where it is');
  assert.match(render[0], /txt\.textContent = text;/);
  assert.match(css, /#radiusInput \{[^}]*tabular-nums/);
  assert.match(css, /#radiusInput, #radiusUnit \{ height: 36px; font-size: 16px; \}/, 'finger-sized, and no zoom on focus');
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
  assert.match(d, /if \(!g\.placed\) return; \/\/ a tap/, 'a tap is left alone: tap, then tap, draws as it always did');
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
    '_centerMarker', '_hintMarker', '_startMarker', '_layerGroup', '_snapped', 'minRadiusCircle', 'maxRadiusCircle', '_setAngle']) {
    assert.ok(geoman.includes(name), 'vendor/geoman: ' + name + ' (used by js/shapes.js and js/tools.js)');
  }
  // the names are wrapped where they are, so an update that renames one is caught here too
  assert.match(read('js/shapes.js'), /L\.PM\.Draw\.Rectangle && L\.PM\.Draw\.Rectangle\.prototype/);
  assert.match(read('js/shapes.js'), /!P\.enable \|\| !P\._syncRectangleSize \|\| !P\._finishShape/, 'a Geoman without them is left alone');
  assert.match(read('js/tools.js'), /L\.PM\.Draw\.Circle && L\.PM\.Draw\.Circle\.prototype/);
  assert.match(read('js/tools.js'), /if \(Circle && Circle\._placeCenterMarker && !Circle\._mbRadiusBox\)/);
});
