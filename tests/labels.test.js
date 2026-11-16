'use strict';
// Name labels that scale with the map: the sizing math (js/util.js), and where the app uses it (js/features.js,
// js/ui.js) - as a text's own "Fixed pixels / Scale with map" does.
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

test('a map-scaled size doubles with each zoom step in; fixed pixels and a missing reference zoom do not scale', () => {
  assert.equal(MB.zoomScale('screen', 10, 12), 1, 'fixed pixels: the same size at every zoom');
  assert.equal(MB.zoomScale('map', 10, 12), 4);
  assert.equal(MB.zoomScale('map', 10, 10), 1, 'as set at its reference zoom');
  assert.equal(MB.zoomScale('map', 12, 10), 0.25);
  assert.equal(MB.zoomScale('map', 10.5, 11.5), 2, 'a fractional zoom too');
  // a project file's own value: anything but a real number is no reference zoom
  for (const ref of [NaN, null, undefined, 'ten', '10', Infinity, {}]) assert.equal(MB.zoomScale('map', ref, 12), 1, String(ref));
  for (const mode of [null, undefined, 'MAP', 'nonsense', true]) assert.equal(MB.zoomScale(mode, 10, 12), 1, String(mode));
});

test('the size a label shows at: scaled with the map, never beyond 200 px, 12 px unless set', () => {
  assert.equal(MB.LABEL_MAX_PX, 200);
  assert.equal(MB.labelShownPx({}, 12), 12, 'no size: the default 12 px');
  assert.equal(MB.labelShownPx({ size: 16 }, 12), 16, 'fixed pixels: the size it is set to');
  assert.equal(MB.labelShownPx({ size: 16, scale: 'map', refZoom: 10 }, 11), 32);
  assert.equal(MB.labelShownPx({ size: 16, scale: 'map', refZoom: 10 }, 9), 8);
  assert.equal(MB.labelShownPx({ size: 12, scale: 'map', refZoom: 10 }, 20), 200, 'clamped: an endless label would swallow the clicks around it');
  assert.equal(MB.labelShownPx({ size: 400, scale: 'map', refZoom: 10 }, 20), 400, 'a label already larger than that keeps its size');
  assert.equal(MB.labelShownPx({ size: 12, scale: 'map', refZoom: 10 }, 0), 12 / 1024, 'tiny (hidden by the render below 3 px)');
});

test('a label with no sizing of its own is drawn exactly as before: scale 1', () => {
  const lb = { show: true, size: 12, color: '#ffffff', bg: true }; // a label saved by an older version
  assert.equal(MB.labelShownPx(lb, 17) / (+lb.size || 12), 1);
  assert.equal(MB.labelShownPx(lb, 3) / (+lb.size || 12), 1);
});

test('a sizing change keeps the size the label shows at, and re-bases a new size on this zoom', () => {
  // to 'map': the size stays, from this zoom on
  let p = MB.labelSizing({ size: 14, scale: 'screen' }, { scale: 'map' }, 11);
  assert.deepEqual(p, { scale: 'map', refZoom: 11 });
  // back to fixed pixels: the size it shows at now becomes its size, and the reference zoom goes
  p = MB.labelSizing({ size: 14, scale: 'map', refZoom: 10 }, { scale: 'screen' }, 12);
  assert.deepEqual(p, { scale: 'screen', size: 56, refZoom: null });
  // a size set by hand while switching back is kept
  p = MB.labelSizing({ size: 14, scale: 'map', refZoom: 10 }, { scale: 'screen', size: 20 }, 12);
  assert.deepEqual(p, { scale: 'screen', size: 20, refZoom: null });
  // a new size while it scales with the map is the size at this zoom
  p = MB.labelSizing({ size: 14, scale: 'map', refZoom: 10 }, { size: 30 }, 13);
  assert.deepEqual(p, { size: 30, refZoom: 13 });
  // nothing to re-base for a fixed-pixel label, or when the sizing does not change
  assert.deepEqual(MB.labelSizing({ size: 14, scale: 'screen' }, { size: 30 }, 13), { size: 30 });
  assert.deepEqual(MB.labelSizing({ size: 14, scale: 'map', refZoom: 10 }, { scale: 'map' }, 13), { scale: 'map' });
  assert.deepEqual(MB.labelSizing({ size: 14 }, { h: 'left' }, 13), { h: 'left' }, 'another setting is left alone');
  // a file's own value: only the two sizings, and a label with none is a fixed-pixel one
  assert.deepEqual(MB.labelSizing({ size: 14 }, { scale: 'nonsense' }, 13), { scale: 'screen' });
  assert.deepEqual(MB.labelSizing({ size: 14, scale: 'map' }, { scale: '__proto__' }, 13), { scale: 'screen', size: 14, refZoom: null },
    'switching away from a map-scaled label with no reference zoom keeps the size it shows');
  assert.deepEqual({ ...MB.labelSizing(null, null, 5) }, {}, 'nothing to change');
});

test('a new label is a fixed-pixel one, and Properties offers both sizings', () => {
  const features = read('js/features.js'), ui = read('js/ui.js');
  assert.match(features.match(/MB\.defaultLabel = [^;]+;/)[0], /scale: 'screen'/, 'existing projects look exactly as they did');
  assert.match(features, /const LABEL_KEYS = \[[^\]]*'scale'\]/, 'the sizing goes along with a copied style');
  assert.match(features, /label\.size = Math\.max\(1, Math\.round\(MB\.labelShownPx\(lb, zoomNow\(\)\)\)\)/, 'copied at the size it shows at');
  assert.doesNotMatch(features.match(/MB\.copyStyle = function[\s\S]*?\n  \};/)[0], /refZoom/, 'never its reference zoom');
  assert.match(features, /MB\.labelSizing\(MB\.getLabel\(l\), MB\.deepClone\(cb\.label\), zoomNow\(\)\)/, 'a pasted label re-bases at the target\'s zoom');
  assert.match(features, /patch = MB\.labelSizing\(MB\.getLabel\(layer\), Object\.assign\(\{\}, patch \|\| \{\}\), zoomNow\(\)\)/, 'setLabel re-bases too');
  assert.match(features, /MB\.labelShownPx\(lb, zoomNow\(\)\) \* 1\.35 \+ 4/, 'a measurement label stacks under the size it shows');
  const form = ui.slice(ui.indexOf('function labelForm(f)'), ui.indexOf('function attrForm(f)'));
  assert.match(form, /data-ls="scale"/);
  assert.match(form, /\[\['screen', 'Fixed pixels'\], \['map', 'Scale with map'\]\]/, 'a text\'s wording');
  assert.match(form, /Fixed pixels: the same size at every zoom\. Scale with map: grows and shrinks with the map, like a label printed on it/);
  assert.match(form, /aria-pressed="\$\{mode === o\[0\]\}"/);
  assert.match(form, /data-lk="size" data-soft-max="\$\{MB\.LABEL_MAX_PX\}"/, 'typed sizes go past the slider\'s end');
  assert.match(form, /value="\$\{sz\}"><span class="val" data-lv="size">\$\{sz\}px/, 'the size it shows at now');
  assert.match(form, /if \(k !== 'scale' && !MB\.getLabel\(f\)\.show\) patch\.show = true/, 'choosing a sizing switches no hidden label on');
  assert.match(form, /if \(k === 'scale'\) showSize\(\);/);
  assert.match(ui, /if \(labelSizeSync && f && f\.mb && MB\.labelTypes\.includes\(f\.mb\.type\) && MB\.getLabel\(f\)\.scale === 'map'\) labelSizeSync\(\)/, 'the size row follows the zoom');
  const zoomUi = ui.slice(ui.indexOf("MB.map.on('zoomend', () => {\n      const f = MB.selected;"));
  assert.doesNotMatch(zoomUi.slice(0, zoomUi.indexOf('});')), /renderProps/, 'never Properties anew on a zoom: the name and attribute boxes keep the keyboard');
});

test('a zoom moves the scaled labels alone, by their element, and the text formula is shared', () => {
  const features = read('js/features.js');
  const re = features.match(/function rescaleLabels\(\) \{[\s\S]*?\n  \}/)[0];
  assert.match(re, /scaledLabels\.forEach/, 'only the labels that scale with the map (a pinch zooms over and over)');
  assert.match(re, /layer\._mbLabel\.getElement\(\), span = el && el\.firstElementChild/, 're-read each time');
  assert.match(re, /span\.style\.transform = labelTransform\(lb, px \/ \(\+lb\.size \|\| 12\)\)/);
  assert.match(re, /span\.style\.visibility = px < 3 \? 'hidden' : ''/, 'too small to read: not drawn');
  assert.doesNotMatch(re, /setIcon/, 'a new icon per frame would replace the element being pinched');
  assert.match(features, /MB\.map\.on\('zoom zoomend', rescaleLabels\)/);
  assert.match(features, /if \(lb\.scale === 'map'\) scaledLabels\.add\(layer\); else scaledLabels\.delete\(layer\)/);
  assert.match(features.match(/function removeLabel\(layer\) \{[\s\S]*?\n  \}/)[0], /scaledLabels\.delete\(layer\)/, 'a label taken off the map is left alone');
  assert.match(features, /const mapScale = st => MB\.zoomScale\(st\.textScale, st\.textRefZoom, zoomNow\(\)\)/, 'texts and labels share one formula');
  // the label's own look is unchanged: its class, and its clicks are its object's (tests/markers.test.js)
  assert.match(features, /className: labelClass\(layer\)/);
  assert.match(features, /layer\._mbLabel\.on\('click contextmenu', e => layer\.fire\(e\.type, e\)\);/);
});

test('a label color from a project file goes into no style attribute unchecked', () => {
  const features = read('js/features.js');
  assert.match(features, /const color = \/\^#\[0-9a-f\]\{3,8\}\$\/i\.test\(lb\.color\) \? lb\.color : MB\.defaultLabel\(m\.type\)\.color;/);
  const css = features.match(/const css = `left:[\s\S]*?;\n/)[0];
  assert.match(css, /color:\$\{color\}/);
  assert.doesNotMatch(css, /\$\{lb\.color\}/, 'never the file\'s value');
});
