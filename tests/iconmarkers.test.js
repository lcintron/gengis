'use strict';
// Markers drawn as an icon (js/util.js): the icon by name only, in the marker's color, outlined, sized and turned.
// Placing one (js/icons.js, js/tools.js), changing it in Properties (js/ui.js), turning and scaling it
// (js/features.js, js/scaletool.js), and an imported layer's icon points copied as icon markers (js/fileimports.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = process.env.GENGIS_ROOT || path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

// js/util.js alone, with Leaflet's divIcon stubbed (as tests/markers.test.js) and a set of two icons.
function loadUtil(withIcons) {
  const L = { divIcon: o => ({ options: o }) };
  const ctx = { window: {}, L, console, Math, Date };
  vm.createContext(ctx);
  vm.runInContext(read('js/util.js'), ctx, { filename: 'util.js' });
  const MB = ctx.window.MB;
  if (withIcons) MB.iconData = { icons: [['plane', 'jet flight', '<path d="M2 12h20"/>'], ['tree', 'wood', '<circle cx="12" cy="12" r="6"/>']] };
  return MB;
}
const MB = loadUtil(true);
const icon = st => MB.markerIcon(Object.assign({ markerShape: 'icon', markerIcon: 'plane' }, st));

// js/util.js and js/scaletool.js together, with the map's pixel work stubbed: enough to scale a snapshot by hand
// (container pixels in, container pixels out; a style patch lands on the layer).
function loadScaler() {
  const L = {
    divIcon: o => ({ options: o }), point: (x, y) => ({ x, y }),
    Circle: class {}, Marker: class {}, latLng: v => v, latLngBounds: () => ({}),
    DomEvent: { disableClickPropagation() {}, disableScrollPropagation() {} }, DomUtil: {}
  };
  const ctx = { window: {}, L, console, Math, Date, setTimeout, document: { createElement: () => ({ style: {}, classList: { add() {}, toggle() {} }, querySelectorAll: () => [], querySelector: () => null, appendChild() {} }) } };
  vm.createContext(ctx);
  for (const f of ['js/util.js', 'js/scaletool.js']) vm.runInContext(read(f), ctx, { filename: f });
  const M = ctx.window.MB;
  M.map = { containerPointToLatLng: p => ({ lat: p.y, lng: p.x }), hasLayer: () => false }; // nothing drawn: the box measures nothing
  M.applyStyle = (layer, patch) => { Object.assign(layer.mb.style, patch); };
  M.updateTooltip = () => {};
  M.hasRotation = () => false;
  M.isFeatureLocked = () => false;
  M.canRotate = () => true; // (js/features.js; the box only uses it for the knob's class, which nothing is drawn of here)
  M.iconData = { icons: [['plane', 'jet', '<path d="M2 12h20"/>']] };
  M.toasts = [];
  M.toast = t => M.toasts.push(t);
  M.scaler.box = { style: {}, classList: { add() {}, remove() {}, toggle() {} } }; // the box itself is only shown or hidden
  return M;
}
// js/icons.js over a fake dialog: the picker's own state, without a page (the icon set itself is not needed).
function loadIcons() {
  const el = () => ({ value: '', checked: false, innerHTML: '', textContent: '', style: {}, focus() {} });
  const els = {};
  for (const id of ['#iconColor', '#iconSwatches', '#iconGrid', '#iconTitle', '#iconHalo', '#iconCount', '#iconSearch']) els[id] = el();
  const ctx = { window: {}, L: { divIcon: o => ({ options: o }) }, console, Math, Date, setTimeout, matchMedia: () => ({ matches: true }) };
  vm.createContext(ctx);
  for (const f of ['js/util.js', 'js/icons.js']) vm.runInContext(read(f), ctx, { filename: f });
  const M = ctx.window.MB;
  M.ui = { openDialog() {}, closeDialog() {} };
  M.icons.dlg = { style: {}, classList: { contains: () => false, toggle() {} }, querySelector: s => els[s] || null };
  M.icons.load = () => Promise.resolve(); // the set is fetched by the real one; nothing here draws an icon
  M.iconPlace = { icon: null, arm(i) { this.icon = i; } };
  M.tools = { current: 'select', set(n) { this.current = n; } };
  M.emit = () => {};
  return M;
}

// A marker as the Scale tool holds it mid-drag: its place and size when the handle was grabbed.
function markerSnap(S, style, at) {
  const layer = { mb: { type: 'marker', style: Object.assign({}, style) }, _ll: { lat: at.y, lng: at.x },
    getLatLng() { return this._ll; }, setLatLng(v) { this._ll = v; } };
  const sn = { layer, pos: { x: at.x, y: at.y }, orig: { style: Object.assign({}, style), ll: { lat: at.y, lng: at.x } } };
  if (S.markerShape(layer.mb.style) === 'icon') sn.size = S.markerSize(layer.mb.style); // as js/scaletool.js snapshots one
  return sn;
}

// A marker's Size row in Properties, driven by the real sizeSync out of js/ui.js and the real stepper around it, over
// a fake row (as tests/textsize.test.js does for a text's): the slider, its px readout, the number box beside it, and
// the real MB.markerSize the row is built from.
const uiSrc = read('js/ui.js');
const SIZE_SYNC = uiSrc.match(/const sizeInp = \$\('\[data-k="markerSize"\]', form\)[\s\S]*?\n      \};/)[0];
const STEPPER = uiSrc.slice(uiSrc.indexOf('function stepper(range)'), uiSrc.indexOf('function enhanceSliders(root)'));
// The row as styleForm writes it (js/ui.js), for a shape and the size that marker is now: its own template, run here.
const SIZE_ROW = uiSrc.match(/<div class="row" data-row="markerSize"[\s\S]*?<\/div>/)[0];
const rowHtml = (shape, size) => vm.runInNewContext('`' + SIZE_ROW + '`', { shape, size, Math });
const rowEnds = html => { const a = {}; html.replace(/(min|max|value)="([^"]*)"/g, (_, k, v) => { if (!(k in a)) a[k] = +v; return ''; }); return a; };

function sizeRow(opts) {
  const L = { divIcon: o => ({ options: o }) };
  const ctx = { window: {}, L, console, Math, Date, setTimeout, clearTimeout, setInterval, clearInterval };
  vm.createContext(ctx);
  vm.runInContext(read('js/util.js'), ctx, { filename: 'util.js' });
  const M = ctx.window.MB, calls = [], dispatched = [];
  ctx.MB = M;
  M.ui = {};
  M.applyStyle = () => calls.push('applyStyle');
  M.commit = () => calls.push('commit');
  M.commitDebounced = () => calls.push('commitDebounced');
  // the few DOM pieces a size row and the stepper around it use
  const el = (tag, attrs) => Object.assign({
    tagName: tag.toUpperCase(), dataset: {}, style: {}, title: '', hidden: false, disabled: false, children: [], handlers: {},
    classList: { toggle() {}, contains: () => false },
    addEventListener(t, fn) { (this.handlers[t] = this.handlers[t] || []).push(fn); },
    dispatchEvent(ev) { dispatched.push(ev.type); (this.handlers[ev.type] || []).forEach(fn => fn(ev)); return true; },
    fire(t) { this.dispatchEvent({ type: t }); },
    after() {}, closest: () => null, select() {}, focus() {}, blur() {},
    querySelector(sel) { return this.children.find(c => c.tagName === sel.toUpperCase()) || null; },
    querySelectorAll(sel) { return this.children.filter(c => c.tagName === sel.toUpperCase()); }
  }, attrs || {});
  const out = el('span', { textContent: opts.value + 'px', classList: { toggle() {}, contains: c => c === 'val' } });
  const inp = el('input', { type: 'range', min: String(opts.min), max: String(opts.max), step: '1',
    nextElementSibling: out }); // as styleForm builds it (no soft end: a marker's size stops at the slider's own)
  // a range input as a browser keeps it: a value outside min..max is clamped, at build time and whenever it is set,
  // so the order the ends and the value are set in matters
  let val = Math.min(+inp.max, Math.max(+inp.min, opts.value));
  Object.defineProperty(inp, 'value', {
    get: () => String(val), set(v) { val = Math.min(+inp.max, Math.max(+inp.min, +v)); }, enumerable: true, configurable: true
  });
  const num = el('input'), up = el('button', { dataset: { d: '1' } }), down = el('button', { dataset: { d: '-1' } });
  const box = el('span', { children: [num, up, down] });
  Object.assign(ctx, { document: { createElement: () => box }, MutationObserver: class { observe() {} },
    Event: class { constructor(t) { this.type = t; } }, esc: s => String(s) });
  vm.runInContext(STEPPER, ctx, { filename: 'stepper' });
  if (opts.stepper) vm.runInContext('stepper(range);', Object.assign(ctx, { range: inp }), { filename: 'stepper-run' });
  ctx.m = { style: opts.style };
  ctx.form = {};
  ctx.$ = sel => (sel === '[data-k="markerSize"]' ? inp : sel === '[data-val="markerSize"]' ? out : null);
  const sync = vm.runInContext('(() => { let sizeSync = null;\n' + SIZE_SYNC + '\nreturn sizeSync; })()', ctx, { filename: 'sizeSync' });
  return { MB: M, inp, out, num, up, down, calls, dispatched, sync, shown: () => M.markerSize(opts.style) };
}
// The same row, with its ends and value as styleForm's own template builds them for this marker: Properties drawn anew
// (a reselect, a shape switch, undo) instead of the sync.
function builtSizeRow(style, opts) {
  const size = MB.markerSize(style), a = rowEnds(rowHtml(MB.markerShape(style), size));
  return Object.assign(sizeRow(Object.assign({ style }, a, opts)), { built: a });
}

test('a marker is drawn as an icon only when it has one: its name, never markup from a file', () => {
  assert.equal(MB.markerShape({ markerShape: 'icon', markerIcon: 'plane' }), 'icon');
  assert.equal(MB.markerShape({ markerShape: 'icon' }), 'pin', 'an icon shape with no icon: the pin, as an unknown shape');
  assert.equal(MB.markerShape({ markerShape: 'icon', markerIcon: '' }), 'pin');
  assert.equal(MB.markerShape({ markerShape: 'icon', markerIcon: { name: 'plane' } }), 'pin', 'only a name, never an object');
  assert.equal(MB.markerShape({ markerShape: 'icon', markerIcon: 7 }), 'pin');
  assert.equal(MB.markerShapes.icon, 'Icon', 'the shape Properties offers');
  // a name with markup in it is a lookup key and nothing else: it never reaches the marker's HTML
  const made = icon({ markerIcon: '"><img src=x onerror=alert(1)>' });
  assert.doesNotMatch(made.options.html, /img|onerror|alert/, 'the unknown name is nowhere in the drawing');
  assert.match(made.options.html, /circle/, 'and it falls back to the placeholder dot');
});

test('an icon marker: its class and box as the other centered shapes, 28 px unless sized, the icon in its color', () => {
  const ic = icon({ color: '#2f80ed' });
  assert.equal(ic.options.className, 'mb-pin mb-pin-icon', 'its class: the selection glow and the hit test as for the pin');
  assert.deepEqual([...ic.options.iconSize], [28, 28], '28 px unless sized');
  assert.deepEqual([...ic.options.iconAnchor], [14, 14], 'centered on its point');
  assert.deepEqual([...ic.options.tooltipAnchor], [0, -14]);
  assert.match(ic.options.html, /<g stroke="#2f80ed" stroke-width="2">/, 'the icon in the marker\'s color');
  assert.match(ic.options.html, /width="28" height="28"/);
  assert.match(ic.options.html, /viewBox="-1 -1 26 26"/, 'the same geometry as the picker\'s preview');
  assert.deepEqual({ ...MB.markerBox({ markerShape: 'icon', markerIcon: 'plane', markerSize: 40 }) }, { l: -20, r: 20, t: -20, b: 20 },
    'its name label and measurements sit around it');
  assert.equal(MB.markerSize({ markerShape: 'icon', markerIcon: 'plane' }), 28);
  assert.equal(MB.markerSize({ markerShape: 'icon', markerIcon: 'plane', markerSize: 400 }), 96, 'an icon grows to 96 px');
  assert.equal(MB.markerSize({ markerShape: 'icon', markerIcon: 'plane', markerSize: 1 }), 6);
  assert.equal(MB.markerSize({ markerShape: 'dot', markerSize: 400 }), 48, 'the small shapes keep their own limit');
  assert.equal(MB.markerSize({}), 16, 'and their own default');
});

test('the outline behind an icon is on unless it is turned off, and contrasts with the icon\'s color', () => {
  assert.match(icon({ color: '#2f80ed' }).options.html, /<g stroke="#0b1118" stroke-opacity="\.6" stroke-width="4\.5">/, 'outlined by default');
  assert.doesNotMatch(icon({ color: '#2f80ed', markerHalo: false }).options.html, /stroke-opacity="\.6"/, 'turned off: the icon alone');
  assert.match(icon({ color: '#2f80ed', markerHalo: true }).options.html, /stroke-opacity="\.6"/);
  assert.equal(MB.haloColor('#0b1118'), '#ffffff', 'a dark icon gets a light outline');
  assert.equal(MB.haloColor('#000'), '#ffffff');
  assert.equal(MB.haloColor('#ffffff'), '#0b1118', 'and a light one a dark outline');
  assert.equal(MB.haloColor('#f2c94c'), '#0b1118');
  assert.equal(MB.haloColor('red'), '#0b1118', 'a named color: the dark one');
  assert.equal(MB.haloColor(''), '#0b1118');
  assert.match(icon({ color: '#0b1118' }).options.html, /<g stroke="#ffffff" stroke-opacity="\.6"/);
});

test('an icon marker is turned in CSS, and only a normalized angle gets there', () => {
  assert.match(icon({ markerRotation: 45 }).options.html, /style="transform:rotate\(45deg\)"/);
  assert.match(icon({ markerRotation: -90 }).options.html, /style="transform:rotate\(270deg\)"/);
  assert.match(icon({ markerRotation: 400 }).options.html, /style="transform:rotate\(40deg\)"/);
  for (const bad of [0, undefined, 'x', Infinity, -Infinity, NaN, '90deg);x', { a: 1 }]) {
    assert.doesNotMatch(icon({ markerRotation: bad }).options.html, /transform|style=/, 'no transform for ' + JSON.stringify(bad));
  }
});

test('before the icon set is loaded, or with an unknown icon, the marker is a dot of the same size and color', () => {
  const bare = loadUtil(false);
  const dot = bare.markerIcon({ color: '#27ae60', markerShape: 'icon', markerIcon: 'plane', markerSize: 36 });
  assert.equal(dot.options.className, 'mb-pin mb-pin-icon', 'the same class: it is drawn again in place once the set is there');
  assert.deepEqual([...dot.options.iconSize], [36, 36]);
  assert.match(dot.options.html, /<circle cx="10" cy="10" r="8"\/>/, 'the placeholder dot');
  assert.match(dot.options.html, /fill="#27ae60"/);
  assert.equal(bare.iconInner('plane'), '', 'nothing to draw with yet');
  assert.equal(MB.iconInner('no-such-icon'), '');
  assert.equal(MB.iconInner(''), '');
  assert.equal(MB.iconInner({}), '');
  assert.equal(MB.iconInner('plane'), '<path d="M2 12h20"/>');
  assert.match(MB.markerIcon({ markerShape: 'icon', markerIcon: 'no-such-icon' }).options.html, /circle/, 'an unknown name: the dot, no throw');
});

test('a marker\'s color is a color or the default: a file\'s own value never writes markup', () => {
  const bad = '"><img src=x onerror=alert(1)>';
  assert.equal(MB.markerColor({ color: bad }), '#e4572e');
  assert.equal(MB.markerColor({ color: 'rgb(1,2,3)' }), 'rgb(1,2,3)', 'an rgb() color is kept (simplestyle marker-color)');
  assert.equal(MB.markerColor({ color: 'rgba(1, 2, 3, .5)' }), 'rgba(1, 2, 3, .5)');
  assert.equal(MB.markerColor({ color: 'cornflowerblue' }), 'cornflowerblue', 'a named color too');
  assert.equal(MB.markerColor({ color: '#abc' }), '#abc');
  assert.equal(MB.markerColor({}), '#e4572e');
  assert.equal(MB.markerColor({ color: 123 }), '#e4572e');
  // every shape draws the checked color, the icon, the pin and the small shapes alike
  for (const st of [{ markerShape: 'icon', markerIcon: 'plane' }, {}, { markerShape: 'dot' }]) {
    const html = MB.markerIcon(Object.assign({ color: bad }, st)).options.html;
    assert.doesNotMatch(html, /img|onerror/, 'no markup from the color in ' + MB.markerShape(st));
    assert.match(html, /#e4572e/);
  }
});

test('a placed icon marker takes the automatic palette color, as every new object does: never the picker\'s', () => {
  const tools = read('js/tools.js'), icons = read('js/icons.js');
  const place = tools.match(/MB\.iconPlace = \{[\s\S]*?\n  \};/)[0];
  // the marker tool's color, from Geoman's pm:create, and the icon tool's: the same call
  assert.match(tools, /MB\.addFeature\(layer, \{ type, layerId: MB\.activeLayer\(\)\.id, style: MB\.newShapeStyle\(true\) \}\)/);
  assert.match(place, /const style = Object\.assign\(MB\.newShapeStyle\(true\), \{ markerShape: 'icon', markerIcon: icon\.name, markerHalo: icon\.halo !== false \}\)/);
  assert.doesNotMatch(place, /color:|MB\.icons/, 'no color of the picker\'s is put on the marker');
  assert.match(place, /MB\.tools\.refreshDraw\(\); \/\/ the next object gets the next color/, 'and the palette moves on, as after a drawn object');
  // so the picker arms the tool with the icon and its outline only
  assert.match(icons, /MB\.iconPlace\.arm\(\{ name, halo \}\)/);
  assert.doesNotMatch(icons.match(/choose\(name\) \{[\s\S]*?\n    \},/)[0], /svgPlace|svgLibrary|libraryId|MB\.commit/,
    'nothing goes into the image library and nothing is added until the map is clicked');
  // the icons preview in the color the marker will really take; the color control is out of the way while placing
  assert.match(icons, /tint\(\) \{\s*\n\s*if \(this\.picking \|\| !MB\.newShapeStyle\) return this\.color;\s*\n\s*return MB\.markerColor\(MB\.newShapeStyle\(\)\);/);
  assert.match(icons, /classList\.toggle\('icon-placing', !this\.picking\)/);
  assert.match(read('css/app.css'), /#iconDialog\.icon-placing #iconSwatches, #iconDialog\.icon-placing \.icon-custom \{ display: none; \}/);
});

test('the Icon tool places the chosen icon as a marker named after it: one click, one undo step', () => {
  const tools = read('js/tools.js');
  const place = tools.match(/MB\.iconPlace = \{[\s\S]*?\n  \};/)[0];
  assert.match(place, /arm\(icon\) \{ this\.icon = icon && icon\.name \? \{ name: String\(icon\.name\), halo: icon\.halo !== false \} : null; \}/);
  assert.match(place, /if \(!this\.icon\) \{[\s\S]*?setTimeout\(\(\) => MB\.tools\.set\('select'\), 0\);/, 'nothing armed: back to Select');
  assert.match(place, /MB\.restoreFeature\(\{ type: 'marker', latlng: \[e\.latlng\.lat, e\.latlng\.lng\], layerId: MB\.activeLayer\(\)\.id, name: icon\.name, style \}\)/);
  assert.match(place, /MB\.commit\('place icon'\);/);
  assert.match(place, /MB\.noteAdded\(layer\);/, 'added to a hidden layer: it says so');
  assert.match(place, /if \(!MB\.state\.continueDrawing\) \{ MB\.tools\.set\('select'\); MB\.selectFeature\(layer\); \}/);
  assert.match(place, /MB\.map\.off\('click', this\._click, this\);/, 'the click handler goes with the tool');
  // the tool is switched to and away from like the others
  assert.match(tools, /MB\.iconPlace\.stop\(\);/);
  assert.match(tools, /else if \(name === 'icon'\) \{ MB\.deselect\(\); MB\.iconPlace\.start\(\); \}/);
  assert.match(read('js/icons.js'), /if \(MB\.tools\.current !== 'icon'\) MB\.tools\.set\('icon'\); else MB\.emit\('tool', 'icon'\);/,
    'the tool it is already on would toggle back to Select');
});

test('a project opened with icon markers in it loads the icon set and draws them again', () => {
  const features = read('js/features.js'), icons = read('js/icons.js');
  assert.match(features, /layer\.setIcon\(MB\.markerIcon\(st\)\)/);
  assert.match(features, /if \(MB\.markerShape\(st\) === 'icon' && !MB\.iconData && MB\.icons\) MB\.icons\.need\(\);/);
  assert.match(features, /MB\.refreshIconMarkers = function \(\) \{[\s\S]*?MB\.applyStyle\(l, \{\}, \{ noCommit: true \}\);[\s\S]*?MB\.scaler\.place\(\);/);
  const need = icons.match(/need\(\) \{[\s\S]*?\n    \},/)[0];
  assert.match(need, /if \(MB\.iconData \|\| this\.needing\) return;/, 'the set is fetched once');
  assert.match(need, /if \(MB\.refreshIconMarkers\) MB\.refreshIconMarkers\(\)/);
  assert.match(need, /catch\(\(\) => \{ this\.needing = false; \}\)/, 'a failed load is tried again by the next draw');
  assert.doesNotMatch(need, /this\.dlg/, 'it runs before the picker exists (an autosaved project is restored first)');
  assert.match(icons, /this\.settle\(\{ name, color, halo, colorChosen \}\)/, 'what the picker resolves with');
});

test('an icon marker can be turned and scaled; a plain marker still cannot', () => {
  const features = read('js/features.js'), scale = read('js/scaletool.js');
  assert.match(features, /MB\.hasRotation = function \(layer\) \{[\s\S]*?m\.type === 'text' \|\| m\.type === 'svg' \|\| \(m\.type === 'marker' && MB\.markerShape\(m\.style\) === 'icon'\)/);
  assert.match(features, /if \(m\.type === 'marker'\) return MB\.markerShape\(m\.style\) === 'icon' \? MB\.normAngle\(m\.style\.markerRotation\) : 0;/);
  assert.match(features, /else if \(m\.type === 'marker' && MB\.markerShape\(m\.style\) === 'icon'\) \{\s*\n\s*MB\.applyStyle\(layer, \{ markerRotation: a \}, \{ noCommit: true \}\);\s*\n\s*if \(!a\) delete m\.style\.markerRotation;/,
    'square again: the key goes, so files and undo steps stay clean');
  assert.match(scale, /const iconMarker = layer => layer\.mb\.type === 'marker' && MB\.markerShape\(layer\.mb\.style\) === 'icon';/);
  assert.match(scale, /MB\.canScale = layer => !!layer && !!layer\.mb && \(layer\.mb\.type !== 'marker' \|\| iconMarker\(layer\)\);/);
  assert.match(scale, /\|\| turnedRect\(layer\) \|\| iconMarker\(layer\)/, 'it keeps its proportions whichever handle is dragged');
  assert.match(scale, /if \(iconMarker\(layer\)\) sn\.size = MB\.markerSize\(layer\.mb\.style\);/, 'its size is snapshotted');
  assert.match(scale, /const size = sn\.size && s !== 1 \? Math\.max\(6, Math\.min\(96, Math\.round\(sn\.size \* s\)\)\) : 0;/);
  assert.match(scale, /if \(size\) MB\.applyStyle\(layer, \{ markerSize: size \}, \{ noCommit: true \}\);/);
  assert.match(scale, /if \('markerSize' in o\.style\) layer\.mb\.style\.markerSize = o\.style\.markerSize; else delete layer\.mb\.style\.markerSize;/,
    'Esc puts the size back, gone again when it had none of its own');
  assert.match(scale, /pick a line, shape, text, image or icon marker to scale/, 'the toast for a plain marker says what can be');
});

test('Properties switches a marker to an icon and back: the icon, its outline and its angle', () => {
  const ui = read('js/ui.js');
  assert.match(ui, /icon: 'Click the map to place the icon as a marker\. Press I to choose another\.'/);
  assert.match(ui, /const ADDING_TOOLS = \[[^\]]*'icon'/, 'a hidden active layer is warned about for it too');
  assert.match(ui, /text = 'Click the map to place "' \+ MB\.iconPlace\.icon\.name \+ '" as a marker/);
  assert.match(ui, /\$\('#iconBtn'\)\.classList\.toggle\('active', name === 'icon'\)/, 'the toolbar button lights up with the tool');
  // the shape row: six shapes, the icon's own rows only when it is one
  assert.match(ui, /data-set="markerShape"/);
  assert.match(ui, /class="seg small marker-shapes shape-row"/);
  assert.match(ui, /max="\$\{Math\.max\(shape === 'icon' \? 96 : 40, size\)\}" step="1" value="\$\{size\}"/, 'an icon reaches 96 px, a shape 40 - and either, the size it is now');
  assert.match(ui, /data-k="markerSize"/);
  assert.match(ui, /data-act="pick-icon"[^\n]*aria-label="Icon: \$\{esc\(name\)\}\. Choose another"/, 'the name is escaped into the label');
  assert.match(ui, /<span class="icon-name">\$\{esc\(name\)\}<\/span>/);
  assert.match(ui, /data-k="markerHalo"\$\{st\.markerHalo !== false \? ' checked' : ''\}> Outline/);
  assert.match(ui, /function iconGlyph\(name, px\) \{\s*\n\s*const inner = MB\.iconInner\(name\);/, 'the glyph comes from the set by name');
  // switching to the icon shape with none chosen opens the picker; the panel is drawn anew either way
  assert.match(ui, /if \(patch\.markerShape === 'icon' && MB\.markerShape\(Object\.assign\(\{\}, m\.style, patch\)\) !== 'icon'\) \{ pickMarkerIcon\(f\); return; \}/);
  assert.match(ui, /MB\.ui\.renderProps\(\); focusShape\(\); \/\/ the icon's own rows and its Rotation row come and go/);
  const pick = ui.match(/function pickMarkerIcon\(f\) \{[\s\S]*?\n  \}/)[0];
  assert.match(pick, /MB\.icons\.pick\(\{ color: m\.style\.color, halo: m\.style\.markerHalo !== false \}\)/, 'seeded with the marker\'s own look');
  assert.match(pick, /if \(res && res\.name && MB\.selected === f && MB\.featureLayers\[m\.id\] === f && !MB\.isFeatureLocked\(f\)\)/,
    'deselected, deleted or locked while the picker was up: nothing is applied');
  assert.match(pick, /const patch = \{ markerShape: 'icon', markerIcon: res\.name, markerHalo: res\.halo !== false \};/);
  assert.match(pick, /if \(res\.colorChosen\) patch\.color = res\.color;/, 'the color only when it was picked there');
  assert.match(pick, /if \(MB\.selected === f\) \{ MB\.ui\.renderProps\(\); focusShape\(\); \}/, 'and the keyboard is given back');
  assert.match(ui, /function focusShape\(\) \{\s*\n\s*const b = \$\('#propsBody \.marker-shapes button\.active'\);/);
  // the angle row, like a text's
  assert.match(ui, /if \(MB\.markerShape\(m\.style\) === 'icon'\) panel\.appendChild\(rotationRow\(\(\) => MB\.getRotation\(f\), 'How far the icon is turned, clockwise', deg => \{\s*\n\s*if \(MB\.getRotation\(f\) === deg\) return;[^\n]*\n\s*MB\.setRotation\(f, deg\);\s*\n\s*MB\.scaler\.follow\(f\);\s*\n\s*MB\.commitDebounced\('rotate'\);/);
});

test('an imported layer\'s icon points are copied into the project as icon markers', () => {
  const imp = read('js/fileimports.js');
  assert.match(imp, /markerShape: 'icon', markerIcon: icon, markerHalo: true, markerSize: size/);
  assert.match(imp, /color: \(p\.sym\.own && p\.sym\.own\.marker\) \|\| p\.sym\.color/, 'the symbol\'s own color');
  assert.match(imp, /const point = q => MB\.restoreFeature\(Object\.assign\(\{\}, base, \{ type: 'marker', latlng: ll\(q\) \}, iconStyle \? \{ style: iconStyle \} : \{\}\)\);/);
  assert.doesNotMatch(imp, /type: 'svg', latlng: ll\(q\)/, 'no image in the library for it any more');
  assert.doesNotMatch(imp, /MB\.icons\.libraryId/);
  assert.match(imp, /if \(usesIcons\(look\) && MB\.icons\) await MB\.icons\.load\(\)\.catch\(\(\) => \{\}\);/, 'the set is loaded first, so they draw at once');
  assert.match(imp, /markerShape: 'dot', markerSize: Math\.max\(8, Math\.round\(\(\+st\.radius \|\| 5\) \* 2 \+ 3\)\)/, 'a point drawn as a dot is still a dot marker');
});

test('an icon marker is drawn as a block that turns about its middle, and the shape row wraps on a phone', () => {
  const css = read('css/app.css'), html = read('index.html');
  assert.match(css, /\.mb-pin-icon svg \{ display: block; transform-origin: 50% 50%; \}/);
  assert.match(css, /\.mb-pin\.mb-selected svg/, 'the selection glow already covers it');
  assert.match(css, /\.shape-row \{ flex-wrap: wrap; \}/, 'six shapes, a 92 px label and a narrow panel');
  assert.match(css, /\.marker-icon-btn \.icon-name \{ min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; \}/);
  assert.match(css, /@media \(pointer: coarse\) \{ \.marker-icon-btn \{ min-height: 40px; \} \}/, 'a finger\'s size');
  assert.match(html, /id="iconBtn" title="Add an icon marker \(I\)"/);
  assert.match(html, /<input type="checkbox" id="iconHalo" checked> Outline<\/label>/);
  assert.match(html, /Click the map to place the icon as a marker/);
  assert.match(read('README.md'), /icons as a marker you can color, size, outline and turn/, 'the README says what an icon becomes');
});

/* ---------- review fixes ---------- */

test('the picker only recolors a marker when a color was really picked there; the placing outline stays its own', async () => {
  const I = loadIcons();
  // an object's own color, as the picker can show it
  assert.equal(I.iconSeedColor('#f00'), '#ff0000', 'a 3-digit hex is expanded');
  assert.equal(I.iconSeedColor('#1E88E5'), '#1e88e5');
  assert.equal(I.iconSeedColor('#1e88e5cc'), '#1e88e5', 'an 8-digit one, without its alpha');
  assert.equal(I.iconSeedColor('red'), '', 'a named color is none the picker can show');
  assert.equal(I.iconSeedColor('rgb(10, 20, 30)'), '');
  assert.equal(I.iconSeedColor(null), '');

  I.icons.color = '#ffffff'; I.icons.halo = true;
  // a marker the picker cannot show the color of: the picker keeps its own, and nothing comes back to put on it
  const p1 = I.icons.pick({ color: 'rgb(10, 20, 30)', halo: false });
  assert.equal(I.icons.color, '#ffffff', 'the picker keeps the color it had');
  assert.equal(I.icons.haloNow(), false, 'the marker\'s own outline is what is shown and offered');
  assert.equal(I.icons.halo, true, 'the placing default is left alone');
  I.icons.choose('plane');
  const r1 = await p1;
  assert.deepEqual([r1.name, r1.color, r1.colorChosen, r1.halo], ['plane', '#ffffff', false, false]);
  assert.equal(I.icons.halo, true, 'still left alone after the pick');
  assert.equal(I.iconPlace.icon, null, 'picking for an object arms no placement');

  // the outline toggled while picking is the object's too
  const p2 = I.icons.pick({ color: '#f00', halo: true });
  assert.equal(I.icons.color, '#ff0000', 'a 3-digit hex seeds it');
  I.icons.setHalo(false);
  I.icons.choose('plane');
  assert.equal((await p2).halo, false);
  assert.equal(I.icons.halo, true, 'and the placing default is untouched by that too');

  // a color picked in the picker is the user's choice: it does go on the object
  const p3 = I.icons.pick({ color: '#f00' });
  I.icons.setColor('#1e88e5', true);
  I.icons.choose('plane');
  const r3 = await p3;
  assert.deepEqual([r3.color, r3.colorChosen], ['#1e88e5', true]);
  // a color the picker refuses is no choice at all
  const p4 = I.icons.pick({ color: '#f00' });
  I.icons.setColor('nonsense', true);
  I.icons.choose('plane');
  assert.deepEqual([(await p4).color, (await p4).colorChosen], ['#ff0000', false]);

  // placing: the outline is the default, which the picks never changed, and the tool is armed with it
  I.icons.setHalo(false);
  assert.equal(I.icons.halo, false, 'off the picking path the checkbox sets the default itself');
  I.icons.choose('plane');
  assert.deepEqual([I.iconPlace.icon.name, I.iconPlace.icon.halo], ['plane', false]);
  assert.equal(I.tools.current, 'icon');
});

test('a lone icon marker scaled past its size limit stays put; in a group it still moves with the group', () => {
  const S = loadScaler();
  const run = (s, snaps) => { S.scaler.drag = { snaps }; S.scaler.scale(s, s, 0, 0); };
  const at = sn => [sn.layer.getLatLng().lng, sn.layer.getLatLng().lat];
  const a = markerSnap(S, { markerShape: 'icon', markerIcon: 'plane', markerSize: 28 }, { x: 100, y: 50 });
  // within the limits: its size and its place scale together
  run(2, [a]);
  assert.equal(a.layer.mb.style.markerSize, 56);
  assert.deepEqual(at(a), [200, 100]);
  // past the limit: the size stops at 96 and its place follows the size it really took, so the anchored corner
  // stays put (by the raw factor it would slide on across the map, and the slide would be committed)
  run(10, [a]);
  assert.equal(a.layer.mb.style.markerSize, 96);
  const f = 96 / 28;
  assert.ok(Math.abs(at(a)[0] - 100 * f) < 1e-9, 'scaled by the size it took, not by 10');
  assert.ok(Math.abs(at(a)[1] - 50 * f) < 1e-9);
  assert.ok(at(a)[0] < 1000, 'nowhere near where the raw factor would put it');
  // and the same at the smallest size
  run(0.05, [a]);
  assert.equal(a.layer.mb.style.markerSize, 6);
  assert.ok(Math.abs(at(a)[0] - 100 * (6 / 28)) < 1e-9);
  // a group: every object moves by the group's own factor (the others scale by it), the icon's size still stops
  const b = markerSnap(S, { markerShape: 'icon', markerIcon: 'plane', markerSize: 28 }, { x: 100, y: 50 });
  const plain = markerSnap(S, { markerShape: 'dot', markerSize: 16 }, { x: 200, y: 50 });
  run(10, [b, plain]);
  assert.equal(b.layer.mb.style.markerSize, 96);
  assert.deepEqual(at(b), [1000, 500], 'its place moves with the group');
  assert.equal(plain.layer.mb.style.markerSize, 16, 'a plain marker is only moved, never resized');
  assert.deepEqual(at(plain), [2000, 500]);
});

test('review fixes: the Size row follows a handle resize, the Scale box follows a shape switch, a file\'s color is escaped', () => {
  const ui = read('js/ui.js');
  // the Size row is kept in step like the Rotation row, so the panel need not be drawn anew (the keyboard stays)
  assert.match(ui, /let sizeSync = null;/);
  assert.match(ui, /sizeSync = null;\s+\/\/ \(and the marker form its size row\)/, 'and let go with the panel');
  assert.match(ui, /if \(rotSync\) rotSync\(\); if \(sizeSync\) sizeSync\(\);/, 'both follow a change to the object shown');
  assert.match(ui, /if \(sizeInp\) sizeSync = \(\) => \{\s*\n\s*const px = MB\.markerSize\(m\.style\);/);
  assert.match(ui, /if \(\+sizeInp\.value === px\) return;/, 'nothing to do when it agrees already');
  assert.match(ui, /sizeOut\.textContent = px \+ 'px';/, 'the readout too');
  // the Scale box fits what the marker is now (worked out from the selection: see rescaleBox below)
  assert.match(ui, /function rescaleBox\(f\) \{/);
  assert.match(ui, /if \(reshaped\) \{\s*\n\s*rescaleBox\(f\);/);
  // a file's own color into the color box: escaped
  assert.match(ui, /<input type="color" data-k="color" value="\$\{esc\(st\.color\)\}">/);
  // the picker's color only when it was picked there
  assert.match(ui, /if \(res\.colorChosen\) patch\.color = res\.color;/);
  assert.doesNotMatch(ui, /markerIcon: res\.name, color: res\.color/, 'never applied unasked');
  assert.match(read('js/scaletool.js'), /const lone = this\.drag\.snaps\.length === 1;/);
  // US spelling in what this feature touched
  assert.match(read('js/util.js'), /only a normalized angle reaches the CSS/);
  assert.match(read('js/icons.js'), /ISC license/);
  assert.match(read('index.html'), /\(ISC license\)/);
  assert.doesNotMatch(read('js/icons.js'), /licence|normalised|colour/);
});

test('the number box beside the marker\'s Size slider follows the sync too, with nothing dispatched and nothing saved', () => {
  // the Scale tool's handles grew the icon from 28 px to 72 (js/scaletool.js applies the style, with no commit)
  const r = sizeRow({ value: 28, min: 8, max: 96, stepper: true, style: { markerShape: 'icon', markerIcon: 'plane', markerSize: 72 } });
  assert.equal(r.shown(), 72);
  assert.equal(+r.num.value, 28, 'the box as the row was built');
  assert.equal(r.out.hidden, true, 'the plain readout is hidden: the box is what is on screen');
  r.sync();
  assert.equal(r.inp.value, '72', 'the slider is where the icon is now');
  assert.equal(r.out.textContent, '72px', 'and so is its readout');
  assert.equal(+r.num.value, 72, 'the number on screen is the size the icon is now');
  assert.equal(+r.num.max, 96, 'the box keeps the end an icon has');
  assert.deepEqual(r.dispatched, [], 'the slider fired nothing: nothing behind it re-applied or saved the size');
  assert.deepEqual(r.calls, [], 'nothing applied, nothing saved');
  assert.equal(r.inp.min, '8', 'the slider keeps the ends it had');
  assert.equal(r.inp.max, '96');
  assert.match(SIZE_SYNC, /MB\.ui\.showSlider\(sizeInp\);/, 'the box is what showSlider is there for');
  assert.doesNotMatch(SIZE_SYNC, /applyStyle|commit|dispatchEvent/, 'the sync applies nothing and saves nothing');
});

test('an icon shrunk below its slider\'s low end lowers it, so the slider and the box show the size it really is', () => {
  // the handles take an icon marker down to 6 px (js/scaletool.js), below the min="8" the row is built with
  const r = sizeRow({ value: 28, min: 8, max: 96, stepper: true, style: { markerShape: 'icon', markerIcon: 'plane', markerSize: 6 } });
  assert.equal(r.shown(), 6);
  r.sync();
  assert.equal(r.inp.min, '6', 'the low end follows it down, so the browser clamps nothing');
  assert.equal(r.inp.value, '6');
  assert.equal(r.out.textContent, '6px');
  assert.equal(+r.num.value, 6, 'the number box shows 6, not the 8 the slider started at');
  assert.equal(+r.num.min, 6, 'and takes the end the slider has now');
  assert.deepEqual(r.dispatched, []);
  assert.deepEqual(r.calls, []);
  // the box steps on from there: down stays at the smallest size an icon has, up goes on from it
  r.down.dispatchEvent({ type: 'pointerdown', button: 0, preventDefault() {} });
  r.down.fire('pointerup'); // (held down it would repeat)
  assert.equal(r.inp.value, '6', 'a nudge down from the smallest size stays there');
  assert.equal(+r.num.value, 6);
  r.up.dispatchEvent({ type: 'pointerdown', button: 0, preventDefault() {} });
  r.up.fire('pointerup');
  assert.equal(r.inp.value, '7');
  assert.equal(+r.num.value, 7);
  // the low end never goes under 1, whatever size is read (MB.markerSize stops at 6, so this is the guard alone)
  assert.match(SIZE_SYNC, /if \(px < \+sizeInp\.min\) sizeInp\.min = String\(Math\.max\(1, px\)\);/);
  assert.ok(+r.inp.min >= 1);
});

test('the size the marker\'s row shows already is no change at all, and a size past the slider\'s end widens it', () => {
  const r = sizeRow({ value: 32, min: 8, max: 96, stepper: true, style: { markerShape: 'icon', markerIcon: 'plane', markerSize: 32 } });
  r.out.textContent = 'untouched';
  r.sync();
  assert.equal(r.inp.value, '32');
  assert.equal(r.out.textContent, 'untouched', 'no readout rewritten');
  assert.equal(+r.num.value, 32);
  assert.deepEqual(r.dispatched, []);
  assert.deepEqual(r.calls, []);
  // a dot marker's row ends at 40: switched to an icon and grown, the slider reaches the size it is now
  const d = sizeRow({ value: 28, min: 8, max: 40, stepper: true, style: { markerShape: 'icon', markerIcon: 'plane', markerSize: 80 } });
  d.sync();
  assert.equal(d.inp.max, '80');
  assert.equal(d.inp.value, '80');
  assert.equal(+d.num.value, 80);
  // and a row just built, with no box beside it yet: set all the same, nothing throws
  const bare = sizeRow({ value: 28, min: 8, max: 96, style: { markerShape: 'icon', markerIcon: 'plane', markerSize: 48 } });
  assert.doesNotThrow(() => bare.sync());
  assert.equal(bare.inp.value, '48');
  assert.equal(bare.out.textContent, '48px');
});

test('the Size row is built around the size the marker is now, so a reselect keeps it: 6 px shows 6, not the slider\'s 8', () => {
  // an icon the handles took down to 6 px, then Properties drawn anew (a reselect, an undo, a shape switch)
  const style = { markerShape: 'icon', markerIcon: 'plane', markerSize: 6 };
  const r = builtSizeRow(style, { stepper: true });
  assert.deepEqual(r.built, { min: 6, max: 96, value: 6 }, 'the row\'s own ends take the size in');
  assert.equal(r.inp.value, '6', 'nothing for the browser to clamp');
  assert.equal(+r.num.value, 6, 'and the number box shows the size it really is');
  assert.equal(r.out.textContent, '6px');
  // (built with a low end of 8, as it was, the browser clamps the 6 away: the fake slider clamps the same)
  const old = sizeRow({ value: 6, min: 8, max: 96, stepper: true, style });
  assert.equal(old.inp.value, '8');
  assert.equal(+old.num.value, 8);
  // so the box's down arrow cannot grow it: the smallest size stays the smallest
  r.down.dispatchEvent({ type: 'pointerdown', button: 0, preventDefault() {} });
  r.down.fire('pointerup');
  assert.equal(r.inp.value, '6', 'a "decrease" never nudges it up to 8');
  assert.equal(+r.num.value, 6);
  // a size within the slider's own ends leaves them as they were
  assert.deepEqual(rowEnds(rowHtml('icon', 28)), { min: 8, max: 96, value: 28 });
  assert.deepEqual(rowEnds(rowHtml('dot', 16)), { min: 8, max: 40, value: 16 });
  assert.match(rowHtml('pin', 32), /data-row="markerSize" hidden/, 'a pin has one size: its row stays hidden');
});

test('a plain shape\'s Size row reaches the 48 px MB.markerSize allows it, whatever size an icon was switched from', () => {
  // an icon at 80 px switched to Dot: markerSize keeps 48 of it, and the row (max 40 for a shape) must reach that
  const style = { markerShape: 'dot', markerSize: 80 };
  assert.equal(MB.markerSize(style), 48);
  const r = builtSizeRow(style, { stepper: true });
  assert.ok(r.built.max >= 48, 'the row reaches the size the marker is now');
  assert.deepEqual(r.built, { min: 8, max: 48, value: 48 });
  assert.equal(r.inp.value, '48', 'the slider shows 48, never the 40 it would be clamped to');
  assert.equal(+r.num.value, 48);
  assert.equal(r.out.textContent, '48px');
  // and a shape switch to or from an icon draws Properties anew, so the row is rebuilt with those ends
  const marker = uiSrc.slice(uiSrc.indexOf("} else if (m.type === 'marker') {"), uiSrc.indexOf("} else if (m.type === 'ink') {"));
  assert.match(marker, /const reshaped = 'markerShape' in patch && \(patch\.markerShape === 'icon'\) !== \(MB\.markerShape\(m\.style\) === 'icon'\);/);
  assert.match(marker, /if \(reshaped\) \{\s*\n\s*rescaleBox\(f\); [^\n]*\n\s*MB\.ui\.renderProps\(\);/, 'the icon\'s rows come and go with a redraw');
  // between two plain shapes the row is only kept as it is: they share one limit, so its ends still fit
  assert.match(uiSrc, /if \(group\.dataset\.set === 'markerShape'\) \{ const row = \$\('\[data-row="markerSize"\]', wrap\); if \(row\) row\.hidden = b\.dataset\.v === 'pin'; \}/);
  assert.equal(rowEnds(rowHtml('square', 48)).max, 48);
});

test('the Scale tool holds an icon marker but never a plain one, so a shape switch works the box out from the selection', () => {
  const S = loadScaler();
  const mk = style => ({ mb: { type: 'marker', style }, getLatLng: () => ({ lat: 0, lng: 0 }) });
  const plain = mk({ markerShape: 'dot' }), ic = mk({ markerShape: 'icon', markerIcon: 'plane' });
  // a plain marker is never attached: it is told markers have a fixed size and the box stays off
  S.scaler.attach(plain);
  assert.equal(S.scaler.targets.length, 0);
  assert.match(S.toasts[0], /^Markers have a fixed size/);
  // an icon marker is held, and let go again
  S.scaler.attach(ic);
  assert.equal(S.scaler.targets.length, 1);
  assert.equal(S.scaler.targets[0], ic);
  S.scaler.detach();
  assert.equal(S.scaler.targets.length, 0, 'Icon → Dot leaves nothing held: the other way round cannot look at that');

  // so Properties decides from the selection, both ways, and does the same after the picker hands one back
  const ui = read('js/ui.js');
  const re = ui.match(/function rescaleBox\(f\) \{[\s\S]*?\n  \}/)[0];
  assert.match(re, /if \(!MB\.scaler \|\| MB\.tools\.current !== 'scale' \|\| MB\.selected !== f \|\| MB\.scaler\.frame\) return;/,
    'the object selected under the Scale tool, not what the scaler holds');
  assert.match(re, /if \(held\.length && !\(held\.length === 1 && held\[0\] === f\)\) return;/, 'a group\'s box is left alone');
  assert.match(re, /if \(MB\.canScale\(f\)\) MB\.scaler\.attach\(f\); else MB\.scaler\.detach\(\);/);
  assert.match(ui, /rescaleBox\(f\); \/\/ under the Scale tool, the box fits what the marker is now/, 'on a shape switch');
  assert.match(ui, /rescaleBox\(f\); \/\/ an icon now: under the Scale tool it gets the box and the knob/, 'and when the picker hands an icon back');
  assert.doesNotMatch(ui, /MB\.scaler\.targets\.length === 1 && MB\.scaler\.targets\[0\] === f && !MB\.scaler\.frame/, 'never gated on what it holds');
});
