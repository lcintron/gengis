'use strict';
// Rotating objects: the angle helpers (js/util.js), a turned text and image (js/features.js), the knob on the Scale
// box and the turn it applies (js/scaletool.js), the angle field in Properties (js/ui.js) and the knob's styling.
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

test('an angle comes out in [0, 360), whatever it was given', () => {
  assert.equal(MB.normAngle(0), 0);
  assert.equal(MB.normAngle(45), 45);
  assert.equal(MB.normAngle(-90), 270);
  assert.equal(MB.normAngle(725), 5);
  assert.equal(MB.normAngle(360), 0);
  assert.equal(MB.normAngle('30'), 30, 'a project file holds strings too');
  for (const bad of ['x', NaN, Infinity, -Infinity, null, undefined, {}, [], '12deg']) {
    assert.equal(MB.normAngle(bad), 0, 'no angle at all: no turn (nothing but a number reaches a CSS transform)');
  }
});

test('Shift snaps an angle to whole steps', () => {
  assert.equal(MB.snapAngle(37, 15), 30);
  assert.equal(MB.snapAngle(38, 15), 45);
  assert.ok(MB.snapAngle(-7, 15) === 0);
  assert.equal(MB.snapAngle(-8, 15), -15);
  assert.equal(MB.snapAngle(352, 15), 345);
  assert.equal(MB.snapAngle(42, 0), 42, 'no step: as it is');
  assert.equal(MB.snapAngle('bad', 15), 0);
});

test('a point turns clockwise about a pivot, in screen pixels (y downwards)', () => {
  const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, msg + ' (' + a + ' vs ' + b + ')');
  let [x, y] = MB.rotateXY(1, 0, 0, 0, 90);
  near(x, 0, 'a quarter turn clockwise takes (1, 0) to (0, 1)'); near(y, 1, 'down the screen');
  [x, y] = MB.rotateXY(1, 0, 0, 0, 180);
  near(x, -1, 'half a turn'); near(y, 0, 'half a turn');
  [x, y] = MB.rotateXY(5, 7, 5, 7, 123);
  near(x, 5, 'the pivot itself stays put'); near(y, 7, 'the pivot itself stays put');
  // four quarter turns come back exactly where they started (a drag turns the snapshot, never the turned shape again)
  let p = [3, -4];
  for (let i = 0; i < 4; i++) p = MB.rotateXY(p[0], p[1], 1, 2, 90);
  near(p[0], 3, 'four quarter turns'); near(p[1], -4, 'four quarter turns');
  const q = MB.rotateXY(10, 0, 0, 0, -90); // a negative angle is the same turn the other way
  near(q[0], 0, 'a turn the other way'); near(q[1], -10, 'a turn the other way');
});

test('an edge\'s angle on screen is 0 upwards, 90 to the right (MB.ringAngle\'s convention)', () => {
  assert.equal(MB.edgeAngleXY({ x: 0, y: 0 }, { x: 0, y: -10 }), 0, 'up the screen: upright');
  assert.equal(MB.edgeAngleXY({ x: 0, y: 0 }, { x: 10, y: 0 }), 90, 'to the right: a quarter turn');
  assert.equal(MB.edgeAngleXY({ x: 0, y: 0 }, { x: 0, y: 10 }), 180);
  assert.equal(MB.edgeAngleXY({ x: 0, y: 0 }, { x: -10, y: 0 }), 270);
  assert.ok(Math.abs(MB.edgeAngleXY({ x: 0, y: 0 }, { x: 10, y: -10 }) - 45) < 1e-9);
  assert.equal(MB.edgeAngleXY({ x: 2, y: 3 }, { x: 2, y: 3 }), 90, 'no edge at all: a number, never NaN');
});

test('a rectangle turned in screen pixels stays a rectangle, at the angle it was turned by', () => {
  // What the knob does to a rectangle's four corners (js/scaletool.js turns them in container pixels, which are a
  // scaled copy of the projection: a rectangle there is a rectangle on the map).
  const ring = [[100, 300], [100, 200], [260, 200], [260, 300]]; // upright, 160 × 100 px
  const [cx, cy] = [180, 250];
  assert.equal(MB.edgeAngleXY({ x: ring[0][0], y: ring[0][1] }, { x: ring[1][0], y: ring[1][1] }), 0, 'upright to begin with');
  const turned = ring.map(p => MB.rotateXY(p[0], p[1], cx, cy, 37));
  const at = MB.edgeAngleXY({ x: turned[0][0], y: turned[0][1] }, { x: turned[1][0], y: turned[1][1] });
  assert.ok(Math.abs(at - 37) < 1e-9, 'its first edge is at the angle it was turned by: ' + at);
  const d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  assert.ok(Math.abs(d(turned[0], turned[1]) - 100) < 1e-9 && Math.abs(d(turned[1], turned[2]) - 160) < 1e-9, 'the same size');
  assert.ok(Math.abs(d(turned[0], turned[2]) - d(turned[1], turned[3])) < 1e-9, 'diagonals still the same length: a rectangle, never skewed');
});

test('a text carries how far it is turned: normalised when it is made, saved only when turned, rotated in CSS', () => {
  const features = read('js/features.js');
  assert.match(features, /if \(layer\.mb\.type === 'text'\) layer\.mb\.rotation = MB\.normAngle\(meta\.rotation\)/,
    'a project file\'s own value is normalised on the way in');
  assert.match(features, /if \(m\.rotation\) d\.rotation = m\.rotation;/, 'and written out again (an untouched text keeps its file as it was)');
  const tt = features.match(/MB\.textTransform = function[\s\S]*?\n  \};/)[0];
  assert.match(tt, /MB\.normAngle\(layer\.mb\.rotation\)/, 'only a normalised angle reaches the transform');
  assert.match(tt, /translate\(\$\{hx\}, \$\{vy\}\)` \+ \(a \? ` rotate\(\$\{a\}deg\)` : ''\) \+ \(s !== 1 \? ` scale\(\$\{s\}\)`/,
    'turned between the anchoring and the scaling, about its anchor (the transform origin)');
  // the angle an object has of its own, and what can be turned at all
  assert.match(features, /MB\.getRotation = function/);
  assert.match(features, /MB\.setRotation = function/);
  assert.match(features, /MB\.canRotate = layer => [^\n]*type !== 'circle' && layer\.mb\.type !== 'marker'/,
    'a circle is round already and a pin stands upright');
  assert.match(features, /transform:rotate\(\$\{MB\.normAngle\(svg\.rotation\)\}deg\)/,
    'a pinned image: its angle through normAngle too (a crafted Infinity never reaches the CSS)');
});

test('a ground image can be turned: the rotation is appended to the transform Leaflet sets, and it is hit-tested as drawn', () => {
  const features = read('js/features.js');
  const gi = features.match(/MB\.GroundImage = L\.ImageOverlay\.extend\(\{[\s\S]*?\n  \}\);/)[0];
  assert.match(gi, /_reset\(\) \{ L\.ImageOverlay\.prototype\._reset\.call\(this\); this\._turn\(\); \}/, 'every pan, zoom and resize');
  assert.match(gi, /_animateZoom\(e\) \{ L\.ImageOverlay\.prototype\._animateZoom\.call\(this, e\); this\._turn\(\); \}/, 'during a zoom animation too');
  assert.match(gi, /MB\.normAngle\(this\.mb && this\.mb\.svg && this\.mb\.svg\.rotation\)/);
  assert.match(gi, /transformOrigin = '0 0'/);
  assert.match(gi, /translate\(\$\{w \/ 2\}px, \$\{h \/ 2\}px\) rotate\(\$\{a\}deg\) translate\(\$\{-w \/ 2\}px, \$\{-h \/ 2\}px\)/,
    'about the middle of the box Leaflet just sized: the image keeps its place and only turns');
  assert.match(features, /return new MB\.GroundImage\(lib\.dataUrl, b, \{/, 'that is what a ground image is built as');
  // a click on a turned image: its bounds are still upright, so what it covers on screen decides
  assert.match(read('js/datalayers.js'), /const el = MB\.normAngle\(f\.mb\.svg && f\.mb\.svg\.rotation\) && f\.getElement && f\.getElement\(\);\s*\n\s*if \(el \? covers\(el\) : f\.getBounds\(\)\.contains\(latlng\)\) shapes\.push\(f\);/);
});

test('the Scale box has a rotation knob: one drag, one undo step, Esc puts it back', () => {
  const scale = read('js/scaletool.js');
  assert.match(scale, /<span class="mb-rot-h" data-h="rot" title="Rotate \(Shift: 15° steps\)" aria-label="Rotate"><\/span>/);
  assert.match(scale, /box\.querySelector\('\.mb-rot-h'\)\.addEventListener\('pointerdown', e => this\.startRotate\(e\)\)/);
  assert.match(scale, /box\.querySelectorAll\('\.mb-scale-h'\)/, 'the eight scale handles keep their own selector');
  // the knob is hidden where there is nothing to turn, and hangs below the box when it would be off the top
  assert.match(scale, /classList\.toggle\('no-rotate', frame \|\| \(layers\.length === 1 && !MB\.canRotate\(layers\[0\]\)\)\)/);
  assert.match(scale, /classList\.toggle\('below', r\.y0 < 48\)/);
  // the same guards as a resize: something selected, the left button, not the Move tool's frame, nothing locked
  const sr = scale.match(/startRotate\(e\) \{[\s\S]*?\n    \},/)[0];
  assert.match(sr, /if \(!targets\.length \|\| e\.button !== 0 \|\| this\.frame\) return;/);
  assert.match(sr, /MB\.isFeatureLocked/);
  assert.match(sr, /pivot = L\.point\(\(r\.x0 \+ r\.x1\) \/ 2, \(r\.y0 \+ r\.y1\) \/ 2\)/, 'the turn is about the middle of the box');
  assert.match(sr, /base: targets\.length === 1 \? startAngle\(targets\[0\]\) : null/);
  assert.match(sr, /this\.listen\(e\)/, 'the pointer capture, the map handlers and the window listeners a drag shares');
  // Shift: whole 15° of the angle the one object ends up at, or of the turn itself for a group
  const ar = scale.match(/applyRotate\(e\) \{[\s\S]*?\n    \},/)[0];
  assert.match(ar, /if \(!d\.moved && Math\.abs\(p\.x - d\.grab\.x\) \+ Math\.abs\(p\.y - d\.grab\.y\) < 3\) return;/, 'a press on the knob is not a turn');
  assert.match(ar, /d\.base == null \? MB\.snapAngle\(delta, SNAP_DEG\) : MB\.normAngle\(MB\.snapAngle\(d\.base \+ delta, SNAP_DEG\) - d\.base\)/);
  assert.match(scale, /const SNAP_DEG = 15;/);
  // every object's points go through the same screen-pixel mapping; a text and an image turn about their own middle too
  const rot = scale.match(/\n    rotate\(deg\) \{[\s\S]*?\n    \},/)[0];
  assert.match(rot, /MB\.rotateXY\(p\.x, p\.y, pivot\.x, pivot\.y, deg\)/);
  assert.match(rot, /transform\(sn, to, 1\)/);
  assert.match(rot, /if \(sn\.rot != null\) MB\.setRotation\(sn\.layer, sn\.rot \+ deg\)/);
  assert.match(scale, /if \(t === 'text' \|\| t === 'svg'\) sn\.rot = MB\.getRotation\(layer\);/, 'snapshotted, for Esc to put back');
  assert.match(scale, /if \(sn\.rot != null\) MB\.setRotation\(layer, sn\.rot\);/, 'and put back');
  // one commit per drag, labelled as a turn; a turned rectangle has Geoman work its angle out again
  assert.match(scale, /MB\.commit\(\(d\.rot \? 'rotate' : 'scale'\) \+ \(this\.targets\.length > 1 \? ' group' : ''\)\)/);
  assert.match(scale, /function reangle\(layer\) \{\s*\n\s*if \(layer\.mb && layer\.mb\.type === 'rectangle' && layer\.pm\) delete layer\.pm\._angle;/);
  assert.match(scale.match(/\n    end\(\) \{[\s\S]*?\n    \},/)[0], /if \(d\.rot\) this\.targets\.forEach\(reangle\);/);
  assert.match(scale.match(/\n    cancel\(\) \{[\s\S]*?\n    \},/)[0], /if \(rot\) this\.targets\.forEach\(reangle\);/);
  // a rectangle snaps to its own edge, a line or a polygon has no angle to snap to
  const sa = scale.match(/function startAngle\(layer\) \{[\s\S]*?\n  \}/)[0];
  assert.match(sa, /if \(t === 'text' \|\| t === 'svg'\) return MB\.getRotation\(layer\);/);
  assert.match(sa, /MB\.ringAngle\(\(layer\.getLatLngs\(\) \|\| \[\]\)\[0\] \|\| \[\]\)/);
  assert.match(sa, /return null;/);
  // a turned ground image: its box on screen, not its (upright) bounds
  assert.match(scale, /const turned = layer\.mb\.type === 'svg' && layer\.setBounds && MB\.normAngle\(layer\.mb\.svg && layer\.mb\.svg\.rotation\);/);
  // the angle beside the pointer, and gone when the drag ends
  assert.match(scale, /this\.tip\.className = 'mb-measure-tip';/);
  assert.match(scale, /if \(this\.tip\) this\.tip\.style\.display = 'none';/);
});

test('Properties has an angle field for a text, an image and a rectangle', () => {
  const ui = read('js/ui.js');
  assert.match(ui, /function rotationRow\(value, title, set\) \{/);
  assert.match(ui, /<input type="range" id="propRot" min="0" max="360" step="1" value="\$\{v\}"><span class="val" data-val="rot">\$\{v\}°<\/span>/);
  assert.match(ui, /rotationRow\(MB\.getRotation\(f\), 'How far the text is turned, clockwise', deg => \{\s*\n\s*MB\.setRotation\(f, deg\);\s*\n\s*MB\.scaler\.follow\(f\);\s*\n\s*MB\.commitDebounced\('rotate'\);/);
  // a rectangle keeps no angle: its corners are turned by the difference
  assert.match(ui, /let at = MB\.normAngle\(MB\.ringAngle\(\(f\.getLatLngs\(\) \|\| \[\]\)\[0\] \|\| \[\]\)\) % 90;/);
  assert.match(ui, /MB\.scaler\.rotateBy\(f, deg - at\);\s*\n\s*at = deg;\s*\n\s*MB\.emit\('featurechange', f\);\s*\n\s*MB\.commitDebounced\('rotate'\);/);
  assert.match(ui, /if \(f\.pm && f\.pm\.enabled && f\.pm\.enabled\(\)\) \{ MB\.deselect\(\); MB\.selectFeature\(f\); \}/, 'its corner handles follow');
  // an image: the row was for pinned ones only, and is for a ground one too now
  assert.doesNotMatch(ui, /isGround \? '' : `<div class="row"><label>Rotation<\/label>/);
  assert.match(ui, /<input type="range" data-k="rotation" min="0" max="360" step="1" value="\$\{MB\.normAngle\(svg\.rotation\)\}"/);
  assert.match(ui, /svg\[k\] = k === 'rotation' \? MB\.normAngle\(inp\.value\) : \+inp\.value;/);
  // one object turned from the field: the geometry only, the caller saves it
  assert.match(read('js/scaletool.js'), /rotateBy\(layer, deg\) \{[\s\S]*?reangle\(layer\);/);
  // and the tool's hint says what the knob does
  assert.match(ui, /toolHints = \{[\s\S]*?scale: '[^']*drag the round handle to rotate \(Shift: 15° steps\)/);
});

test('the knob is styled round, hidden with no object to turn, and finger-sized on a touch screen', () => {
  const css = read('css/app.css');
  const knob = css.match(/\.mb-rot-h \{[\s\S]*?\}/)[0];
  assert.match(knob, /border-radius: 50%/);
  assert.match(knob, /pointer-events: auto/, 'the box itself takes no pointer events');
  assert.match(knob, /touch-action: none/, 'a finger drags the knob, it does not pan the map');
  assert.match(knob, /cursor: grab/);
  assert.match(css, /\.mb-rot-h::before \{[^}]*height: 22px/, 'the stem down to the box');
  assert.match(css, /\.mb-scale-box\.below \.mb-rot-h \{ top: calc\(100% \+ 28px\); \}/);
  assert.match(css, /\.mb-scale-box\.frame \.mb-rot-h, \.mb-scale-box\.no-rotate \.mb-rot-h \{ display: none; \}/);
  const coarse = css.match(/@media \(pointer: coarse\) \{\n  \.mb-scale-h[\s\S]*?\n\}/)[0];
  assert.match(coarse, /\.mb-rot-h \{ width: 22px; height: 22px;[^}]*top: -36px; \}/, 'clear of the 18 px top handle');
  assert.match(coarse, /\.mb-scale-box\.below \.mb-rot-h \{ top: calc\(100% \+ 36px\); \}/);
  assert.match(css, /body\.presenting \.mb-scale-box \{ display: none !important; \}/, 'the whole box, knob and all, is gone while presenting');
});

test('the Scale tool says it rotates too', () => {
  assert.match(read('index.html'), /title="Scale and rotate objects \(K\)"/);
  assert.match(read('js/contextmenu.js'), /label: 'Resize or rotate \(Scale tool\)'/);
  assert.match(read('README.md'), /\| V \/ G \/ K \| Select \/ Move \/ Scale and rotate/);
});
