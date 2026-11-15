'use strict';
// Saving and exporting a file (js/util.js, js/storage.js): the page only says "saved" once the file is really out.
// In the Android app MB.download is the share sheet (js/native.js) and answers late - false when it was cancelled.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = process.env.GENGIS_ROOT || path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

function load() {
  const MB = {};
  const links = [];
  const body = { appendChild(el) { el.inPage = true; }, removeChild(el) { el.inPage = false; } };
  const ctx = {
    window: { MB }, console, Blob, setTimeout, clearTimeout, Math, Date, DOMParser: class {},
    URL: { createObjectURL: () => 'blob:1', revokeObjectURL() {} },
    document: { body, createElement: () => { const a = { clicks: 0, click() { this.clicks++; } }; links.push(a); return a; } },
    navigator: { language: 'en' }
  };
  ctx.window.window = ctx.window;
  vm.createContext(ctx);
  for (const f of ['js/util.js', 'js/storage.js']) vm.runInContext(read(f), ctx, { filename: f });
  MB.PROJECT_EXT = '.gengis';
  return { MB, links };
}

// A project with nothing in it, and what saving it touches.
function project(MB) {
  const seen = { toasts: [], marked: 0 };
  MB.toast = t => seen.toasts.push(t);
  MB.projects = { markFileBacked: () => { seen.marked++; } };
  MB.serializeProject = () => ({ name: 'My map', features: [] });
  MB.featureLayers = {};
  MB.state = { projectName: 'My map' };
  return seen;
}

test('in the browser and the desktop app a download is handed to the page, and counts as done', () => {
  const { MB, links } = load();
  assert.equal(MB.download('map.gengis', '{}'), true);
  assert.equal(links.length, 1);
  assert.equal(links[0].download, 'map.gengis');
  assert.equal(links[0].clicks, 1);
});

test('"Project saved" waits for the file: nothing is said and no file is backed when the share sheet is cancelled', async () => {
  const { MB } = load();
  const seen = project(MB);
  const names = [];
  MB.download = async name => { names.push(name); return false; };
  await MB.saveToFile();
  assert.deepEqual(names, ['My map.gengis']);
  assert.equal(seen.marked, 0, 'still a draft');
  assert.deepEqual(seen.toasts, []);
});

test('once the file is out the project is file-backed and "Project saved" is shown', async () => {
  const { MB } = load();
  const seen = project(MB);
  let done = null;
  MB.download = () => new Promise(res => { done = res; });
  const p = MB.saveToFile();
  await Promise.resolve();
  assert.equal(seen.marked, 0, 'not before the share sheet answers');
  assert.deepEqual(seen.toasts, []);
  done(true);
  await p;
  assert.equal(seen.marked, 1);
  assert.deepEqual(seen.toasts, ['Project saved']);
});

test('the desktop app and Chrome write the file themselves: saveToFile leaves it to them', async () => {
  const { MB } = load();
  const seen = project(MB);
  MB.download = async () => { throw new Error('not used here'); };
  MB.desktopFiles = { available: true, save: async () => 'desktop' };
  assert.equal(await MB.saveToFile(), 'desktop');
  MB.desktopFiles = { available: false };
  MB.browserFiles = { available: true, save: async () => 'browser' };
  assert.equal(await MB.saveToFile(), 'browser');
  assert.deepEqual(seen.toasts, [], 'each says its own');
});

test('the GeoJSON export says nothing when the share sheet was cancelled', async () => {
  const { MB } = load();
  const seen = project(MB);
  const calls = [];
  MB.download = async (name, text, mime) => { calls.push({ name, mime, text }); return false; };
  await MB.exportGeoJSON();
  assert.deepEqual(calls.map(c => [c.name, c.mime]), [['My map.geojson', 'application/geo+json']]);
  assert.deepEqual(JSON.parse(calls[0].text), { type: 'FeatureCollection', features: [] });
  assert.deepEqual(seen.toasts, []);
  MB.download = async () => true;
  await MB.exportGeoJSON();
  assert.deepEqual(seen.toasts, ['GeoJSON exported (0 features)']);
});

test('the map export and a layer export wait for the file too', () => {
  const exp = read('js/export.js');
  assert.match(exp, /if \(!\(await MB\.download\(out, blob\)\)\) \{ this\.status\(''\); return; \}/, 'no "Saved: x MB" and no toast on a cancel');
  assert.ok(exp.indexOf('await MB.download(out, blob)') < exp.indexOf('MB.toast(\'Exported \' + out)'), 'the toast comes after');
  const imp = read('js/fileimports.js');
  const at = imp.indexOf('async exportFile(');
  assert.ok(at > 0, 'exportFile found');
  const body = imp.slice(at, imp.indexOf('\n    },', at));
  assert.match(body, /return MB\.download\(name \+ '\.kml'/, 'its answer is the download\'s: it resolves once the file is out');
  assert.match(body, /return MB\.download\(name \+ '\.geojson'/);
});

test('an attribute named "__proto__" survives the GeoJSON export and import as a field of the object\'s own', async () => {
  const { MB } = load();
  const seen = project(MB);
  const attrs = JSON.parse('{"__proto__":"p","note":"n"}'); // a file's own field, named after what every object has
  MB.featureLayers = { f1: { mb: { id: 'f1', name: 'A', layerId: 'L1', type: 'marker', style: {}, attrs } } };
  MB.getLayer = () => ({ name: 'Layer 1' });
  MB.svgCenter = () => ({ lat: 1, lng: 2 });
  let text = '';
  MB.download = async (name, t) => { text = t; return true; };
  await MB.exportGeoJSON();
  const p = JSON.parse(text).features[0].properties;
  // "__proto__" is a name GenGIS reads itself, so it travels in "attributes" - as a field, not as a prototype
  assert.equal(Object.getOwnPropertyDescriptor(p.attributes, '__proto__').value, 'p');
  assert.equal(p.note, 'n');

  // and back in: each one the object's own field again
  const made = [];
  Object.assign(MB, {
    batch: fn => fn(), createLayer: name => ({ id: 'L-' + name }), restoreFeature: d => { made.push(d); return d; },
    applyZOrder() {}, emit() {}, commit() {}, currentStyle: {}, groups: {}, state: { projectName: 'My map', svgLibrary: {} }
  });
  MB.importGeoJSON(JSON.parse(text), 'map.geojson');
  const a = made[0].attrs;
  assert.equal(Object.hasOwn(a, '__proto__'), true, 'the field is kept, not dropped into the prototype');
  assert.equal(Object.getOwnPropertyDescriptor(a, '__proto__').value, 'p');
  assert.equal(Object.getPrototypeOf(a), Object.getPrototypeOf(made[0]), 'a plain object: nothing polluted');
  assert.equal(a.note, 'n');
  assert.equal(seen.toasts.pop(), 'Imported 1 features into "map"');
});

test('a file that cannot even be read says so: never an unanswered failure with nothing on screen', async () => {
  const { MB } = load();
  const seen = project(MB);
  MB.isProject = () => false;
  const bad = { name: 'huge.gengis', text: async () => { throw new Error('The file is too large to read'); } };
  assert.equal(await MB.openFile(bad), null, 'nothing was opened');
  assert.deepEqual(seen.toasts, ['Could not open file: The file is too large to read']);
  // a file that reads but holds something else is still said once, by openText
  seen.toasts.length = 0;
  assert.equal(await MB.openFile({ name: 'notes.txt', text: async () => 'hello' }), null);
  assert.equal(seen.toasts.length, 1, 'said once, not twice');
  assert.match(seen.toasts[0], /^Could not open file: /);
  // and where the page hands the file over (the picker and a drop) nothing else catches it
  const ui = read('js/ui.js');
  assert.match(ui, /if \(f\) MB\.openFile\(f\);/);
  assert.match(read('js/storage.js'), /e => \{ MB\.toast\('Could not open file: ' \+ \(\(e && e\.message\) \|\| e\)\); return null; \}\);/);
});
