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
