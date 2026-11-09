'use strict';
// An imported layer's look (js/importstyle.js), the attribute values typed in (js/attrtable.js), the layer written
// back out (js/fileimports.js), and attributes on the project's own objects.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = process.env.GENGIS_ROOT || path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

function load() {
  const MB = { escapeHtml: s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]) };
  const ctx = { window: { MB }, TextDecoder, Blob, console, Date, Math, setTimeout, clearTimeout };
  vm.createContext(ctx);
  for (const f of ['js/importstyle.js', 'js/attrtable.js', 'js/fileimports.js']) vm.runInContext(read(f), ctx, { filename: f });
  return MB;
}
const MB = load(), S = MB.importStyle;
const plain = x => JSON.parse(JSON.stringify(x));
const pt = (props, xy) => ({ type: 'Feature', properties: props, geometry: { type: 'Point', coordinates: xy || [0, 0] } });
const FEATS = [
  pt({ name: 'A', kind: 'park', h: 3, code: '007' }), pt({ NAME: 'B', kind: 'pier', h: 12 }), pt({ name: 'C', kind: 'park', h: 25 }),
  pt({ name: 'D', kind: '', h: 'n/a' }), pt({ name: 'E', kind: 'bridge', h: 84 })
];

test('defaults: every field, in the order first met; the file\'s own styles when it has them', () => {
  const look = S.defaults(FEATS, '#123456');
  assert.deepEqual(plain(look.fields.map(f => f.key)), ['name', 'kind', 'h', 'code', 'NAME']);
  assert.equal(look.symbol.mode, 'single');
  assert.equal(look.symbol.color, '#123456');
  assert.equal(look.label.show, false, 'labels off until asked for');
  assert.equal(S.defaults([Object.assign(pt({}), { mbStyle: { marker: '#ff0000' } })]).symbol.mode, 'file');
});

test('fields kept in their place after a change; new ones last, gone ones dropped', () => {
  const look = { fields: [{ key: 'b', alias: 'Bee', show: false }, { key: 'a', alias: '', show: true }] };
  S.syncFields(look, ['a', 'c', 'b']);
  assert.deepEqual(plain(look.fields), [{ key: 'b', alias: 'Bee', show: false }, { key: 'a', alias: '', show: true }, { key: 'c', alias: '', show: true }]);
  S.syncFields(look, ['c']);
  assert.deepEqual(plain(look.fields.map(f => f.key)), ['c']);
});

test('popup, title and labels follow the layer\'s settings', () => {
  const look = S.defaults(FEATS);
  look.fields = [{ key: 'h', alias: 'Height (m)', show: true }, { key: 'name', alias: '', show: true }, { key: 'kind', alias: '', show: false }];
  const p = FEATS[0].properties;
  assert.deepEqual(plain(S.popupRows(look, p)), [['Height (m)', '3'], ['name', 'A']], 'shown fields, in order, under their display names');
  assert.equal(S.titleOf(look, FEATS[1].properties), 'B', 'automatic: a name field, whatever its case');
  look.title = 'kind';
  assert.equal(S.titleOf(look, p), 'park');
  assert.equal(S.labelText(look, p), 'park', 'a label without a field of its own: the title');
  look.label.field = 'name';
  assert.equal(S.labelText(look, p), 'A');
  look.label.text = '{name} ({h} m) {missing}';
  assert.equal(S.labelText(look, p), 'A (3 m)', 'fields in braces; a missing one is empty, the spaces tidied');
});

test('by category: the commonest values first, each its color (kept through a refresh), the rest Other', () => {
  assert.deepEqual(plain(S.categories(FEATS, 'kind')), [{ value: 'park', count: 2 }, { value: '', count: 1 }, { value: 'bridge', count: 1 }, { value: 'pier', count: 1 }]);
  const look = S.defaults(FEATS);
  Object.assign(look.symbol, { mode: 'category', field: 'kind' });
  S.fillCats(look, FEATS);
  look.symbol.cats[0].color = '#00ff00';
  look.symbol.cats[0].icon = 'tree-deciduous';
  S.fillCats(look, FEATS);
  assert.deepEqual(plain(S.symbolOf(look, FEATS[2])), { color: '#00ff00', icon: 'tree-deciduous' });
  assert.equal(S.symbolOf(look, pt({ kind: 'castle' })).color, look.symbol.other, 'a value not listed');
  assert.deepEqual(plain(S.legend(look).map(i => i.text)), ['park', '(empty)', 'bridge', 'pier']);
});

test('graduated: number fields only; equal intervals or quantiles on a ramp', () => {
  const look = S.defaults(FEATS);
  assert.deepEqual(plain(S.numericFields(look, FEATS)), ['code'], 'h has text in it ("n/a"): not numbers enough; "007" reads as one');
  const nums = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(h => pt({ h }));
  const l2 = S.defaults(nums);
  assert.deepEqual(plain(S.numericFields(l2, nums)), ['h']);
  assert.deepEqual(plain(S.breaksOf([0, 10, 5], 5, 'equal')), [0, 2, 4, 6, 8, 10]);
  assert.deepEqual(plain(S.breaksOf([1, 1, 1, 1, 2, 3, 100], 2, 'quantile')), [1, 1, 100].filter((x, i, a) => i === 0 || x > a[i - 1]));
  Object.assign(l2.symbol, { mode: 'graduated', field: 'h', classes: 3, method: 'equal', ramp: 'blues' });
  S.fillBreaks(l2, nums);
  const colors = S.rampColors('blues', 3);
  assert.equal(S.symbolOf(l2, nums[0]).color, colors[0]);
  assert.equal(S.symbolOf(l2, nums[9]).color, colors[2]);
  assert.equal(S.symbolOf(l2, pt({ h: 'x' })).color, l2.symbol.other, 'no number: Other');
  assert.equal(S.rampColors('blues', 5)[0], '#d6ecff');
  assert.equal(S.rampColors('blues', 5)[4], '#0b2d6b');
});

test('typed values: numbers stay numbers, "007" stays text, true/false in a field of those, empty is none', () => {
  const t = MB.attrs.typed;
  assert.equal(t('42', null), 42);
  assert.equal(t(' -3.5 ', 7), -3.5);
  assert.equal(t('007', null), '007');
  assert.equal(t('12', 'twelve'), '12', 'a text field stays text');
  assert.equal(t('false', true), false);
  assert.equal(t('', 5), null);
  assert.equal(t('1e5', null), '1e5');
});

test('an imported layer written out: KML read back gives the same names, values and colors; GeoJSON adds simplestyle', () => {
  const look = S.defaults(FEATS, '#ff8a3d');
  Object.assign(look.symbol, { mode: 'category', field: 'kind' });
  S.fillCats(look, FEATS);
  look.title = 'name';
  const rec = { meta: { name: 'Sites & <things>', look }, fc: { type: 'FeatureCollection', features: FEATS.concat([
    { type: 'Feature', properties: { name: 'Lot' }, geometry: { type: 'MultiPolygon', coordinates: [[[[0, 0], [1, 0], [1, 1], [0, 0]], [[0.2, 0.2], [0.4, 0.2], [0.4, 0.4], [0.2, 0.2]]], [[[2, 2], [3, 2], [3, 3], [2, 2]]]] } }]) } };
  const kml = MB.imports.read.toKml(rec);
  assert.match(kml, /<name>Sites &amp; &lt;things&gt;<\/name>/);
  const back = MB.imports.read.kml(kml);
  assert.deepEqual(plain(back.features.map(f => f.properties.name || '')), ['A', '', 'C', 'D', 'E', 'Lot']);
  assert.equal(back.features[0].properties.code, '007');
  assert.equal(back.features[0].mbStyle.marker, look.symbol.cats.find(c => c.value === 'park').color, 'its category color');
  assert.equal(back.features[5].geometry.type, 'MultiPolygon');
  assert.equal(back.features[5].geometry.coordinates[0].length, 2, 'its hole');
  const gj = MB.imports.read.toGeoJson(rec);
  assert.equal(gj.features[0].properties['marker-color'], back.features[0].mbStyle.marker);
  assert.equal(gj.features[0].properties.code, '007');
  assert.equal(gj.features[5].properties['fill-opacity'], 0.25);
});

test('the project\'s objects carry attributes: kept and saved, edited in Properties and the layer\'s table, in GeoJSON', () => {
  const features = read('js/features.js'), ui = read('js/ui.js'), storage = read('js/storage.js');
  assert.match(features, /if \(meta\.attrs && typeof meta\.attrs === 'object' && Object\.keys\(meta\.attrs\)\.length\) layer\.mb\.attrs = MB\.deepClone\(meta\.attrs\);/);
  assert.match(features, /if \(m\.attrs && Object\.keys\(m\.attrs\)\.length\) d\.attrs = MB\.deepClone\(m\.attrs\);/, 'saved (and undone, duplicated) with the object');
  assert.match(features, /createLayer\(src\.name \+ ' copy', \{ visible: src\.visible, grouped: src\.grouped, fields: src\.fields \}\)/);
  assert.match(read('js/store.js'), /if \(Array\.isArray\(opts\.fields\) && opts\.fields\.length\) layer\.fields = opts\.fields\.map\(String\);/);
  assert.match(read('js/project.js'), /fields: l\.fields, activate: false/, 'a layer\'s empty fields reopen with it');
  assert.match(ui, /panel\.appendChild\(attrForm\(f\)\);/);
  assert.match(ui, /\{ label: 'Attribute table', [^}]*MB\.attrTable\.open\(MB\.attrs\.tableFor\(id\)\)/);
  assert.match(ui, /if \(MB\.data\.picked\.ds\.imp && MB\.imports\) MB\.imports\.bindPicked\(panel, MB\.data\.picked\);/);
  assert.match(storage, /Object\.keys\(m\.attrs \|\| \{\}\)\.forEach\(k => \{ if \(k in props \|\| GJ_OWN\.has\(k\)\) \(props\.attributes = props\.attributes \|\| \{\}\)\[k\] = m\.attrs\[k\]; else props\[k\] = m\.attrs\[k\]; \}\);/);
  assert.match(storage, /const base = \{ layerId: targetId, name: p\.name != null \? String\(p\.name\) : \(p\.title != null \? String\(p\.title\) : ''\), style, attrs: attrsOf\(p\) \};/);
  assert.match(storage, /!\(k === 'title' && p\.name == null\)/, 'a title attribute of an unnamed object survives export and import');
  const dl = read('js/datalayers.js');
  assert.match(dl, /if \(ds\.def\.popupRows\) \{/, 'an imported layer\'s popup: its settings');
  assert.match(dl, /\$\{def\.attrsHtml \? def\.attrsHtml\(p\) :/, 'its attributes editable in Properties');
  const html = read('index.html'), sw = read('sw.js');
  for (const f of ['importstyle', 'attrtable']) {
    assert.match(html, new RegExp(`<script src="js/${f}\\.js"></script>[\\s\\S]*<script src="js/fileimports\\.js">`));
    assert.match(sw, new RegExp(`'\\./js/${f}\\.js'`));
  }
});

test('a field renamed or deleted in the attribute table: every feature, and every rule that used it', () => {
  const feats = [pt({ kind: 'park', h: 3 }), pt({ kind: 'pier', h: 12 })];
  const look = S.defaults(feats);
  Object.assign(look, { title: 'kind' });
  Object.assign(look.label, { show: true, field: 'kind', text: '{kind} ({h} m)' });
  Object.assign(look.symbol, { mode: 'category', field: 'kind' });
  S.fillCats(look, feats);
  const rec = { meta: { id: 'x', name: 'x', look }, fc: { type: 'FeatureCollection', features: feats } };
  const ad = MB.imports.tableAdapter(rec);
  assert.equal(ad.renameField('kind', 'h'), 'There is a field of that name already');
  assert.equal(ad.renameField('kind', 'type'), '');
  assert.deepEqual(plain(feats.map(f => f.properties.type)), ['park', 'pier']);
  assert.equal(feats[0].properties.kind, undefined);
  assert.deepEqual([look.title, look.label.field, look.label.text, look.symbol.field], ['type', 'type', '{type} ({h} m)', 'type']);
  assert.equal(S.labelText(look, feats[1].properties), 'pier (12 m)');
  ad.deleteField('type');
  assert.deepEqual([look.title, look.label.field, look.symbol.field, look.symbol.mode], ['', '', '', 'single'], 'nothing left pointing at it');
  assert.deepEqual(plain(look.fields.map(f => f.key)), ['h']);
  assert.equal(ad.addField('h'), 'There is a field of that name already');
  assert.equal(ad.addField('  note '), '');
  assert.deepEqual(plain(look.fields.map(f => f.key)), ['h', 'note']);
});

test('the attribute table names its columns by their index: no field name goes into the page and back', () => {
  const src = read('js/attrtable.js');
  assert.ok(!/data-(k|sort|col|rename)="\$\{esc\(f\.key\)\}"/.test(src), 'a field name (the Object name column\'s key has a NUL in it) would not survive an attribute');
  assert.match(src, /data-sort data-c="\$\{c\}"/);
  assert.match(src, /const at = `data-c="\$\{c\}" title=/, 'a cell names its column by its index');
  assert.match(src, /<textarea class="attr-cell attr-multi" rows="1" \$\{at\}>/, 'a value on several lines in a box that keeps them');
  assert.match(src, /const keyAt = el => \{ const f = T\.fields\[\+el\.dataset\.c\]; return f \? f\.key : null; \};/);
});
