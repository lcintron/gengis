'use strict';
// A marker's shape (js/util.js), a marker kept on the map on a right-click while it is edited (js/features.js), an
// object's attributes in a popup on a click (js/datalayers.js), and imported points copied as they are drawn.
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

test('a marker is a pin unless it has a shape: a dot, diamond, square or triangle centred on its point', () => {
  const pin = MB.markerIcon({ color: '#123456' });
  assert.equal(pin.options.className, 'mb-pin');
  assert.deepEqual([...pin.options.iconAnchor], [13, 37], 'the pin stands on its point');
  assert.equal(MB.markerIcon({ color: '#123456', markerShape: 'nonsense' }).options.className, 'mb-pin', 'an unknown shape: the pin');

  for (const shape of ['dot', 'diamond', 'square', 'triangle']) {
    const ic = MB.markerIcon({ color: '#123456', markerShape: shape, markerSize: 12 });
    assert.equal(ic.options.className, 'mb-pin mb-pin-' + shape, 'its class: the selection glow and the hit test as for the pin');
    assert.deepEqual([...ic.options.iconSize], [12, 12]);
    assert.deepEqual([...ic.options.iconAnchor], [6, 6], 'centred on the point');
    assert.match(ic.options.html, /fill="#123456"/);
    assert.match(ic.options.html, /width="12" height="12"/);
  }
  assert.equal(MB.markerSize({}), 16, 'a shape is 16 px unless sized');
  assert.equal(MB.markerSize({ markerSize: 2 }), 6);
  assert.equal(MB.markerSize({ markerSize: 400 }), 48);
  assert.deepEqual({ ...MB.markerBox({}) }, { l: -13, r: 13, t: -38, b: 0 }, 'the pin\'s box: above its point');
  assert.deepEqual({ ...MB.markerBox({ markerShape: 'dot', markerSize: 10 }) }, { l: -5, r: 5, t: -5, b: 5 }, 'a shape\'s box: around it');
});

test('a marker is drawn, restyled and labelled by its shape; Properties offers the shapes and a size', () => {
  const features = read('js/features.js'), ui = read('js/ui.js');
  assert.match(features, /case 'marker': layer = L\.marker\(fromArr\(d\.latlng\), \{ icon: MB\.markerIcon\(d\.style\) \}\)/);
  assert.match(features, /layer\.setIcon\(MB\.markerIcon\(st\)\)/);
  assert.match(features, /let box = MB\.markerBox\(m\.style\);/, 'the name label sits around the shape');
  assert.match(features, /'markerShape' in patch \|\| 'markerSize' in patch/, 'a new shape moves its labels');
  assert.match(ui, /data-set="markerShape"/);
  assert.match(ui, /data-k="markerSize"/);
  assert.match(ui, /'markerSize'\];/, 'its size read in px');
  assert.doesNotMatch(read('js/features.js').match(/MB\.defaultStyle = \{[\s\S]*?\};/)[0], /markerShape/,
    'no shape in the default style: pasting a shape\'s style onto a marker keeps the marker\'s shape');
});

test('a right-click on an edited marker, text or circle opens its menu: Geoman never takes it off the map', () => {
  // Geoman's edit mode removes a marker (and a circle, and a text) on contextmenu unless preventMarkerRemoval: it is
  // gone from the map but still in the project, unseen and saved. Lines and shapes keep a vertex's right-click.
  assert.match(read('js/features.js'), /layer\.pm\.enable\(\{[^}]*preventMarkerRemoval: !layer\.getLatLngs \}\)/);
});

test('a click on an object with attributes shows them, with no data under it too', () => {
  const features = read('js/features.js'), dl = read('js/datalayers.js');
  assert.match(features, /MB\.data\.identify\(latlng, cp, null, \{ own, open: layer \}\)/);
  assert.match(features, /if \(!own\.includes\(layer\)\) own\.unshift\(layer\);/);
  assert.match(dl, /if \(!hits\.length && !point && !\(opts\.own \|\| \[\]\)\.some\(hasAttrs\)\) return false;/);
  assert.match(dl, /const open = h\.layer === opts\.open && attrs\.length \? ' open' : '';/, 'the clicked one\'s entry open');
  assert.match(read('css/app.css'), /\.mb-datatable td \+ td \{ white-space: pre-line; \}/, 'a value on several lines keeps them');
});

test('imported points drawn as dots are copied into the project as dot markers their size', () => {
  assert.match(read('js/fileimports.js'), /markerShape: 'dot', markerSize: Math\.max\(8, Math\.round\(\(\+st\.radius \|\| 5\) \* 2 \+ 3\)\)/);
});

test('a KML description: a <br> and the new line after it in the file are one line break', () => {
  const M = { escapeHtml: s => String(s) };
  const ctx = { window: { MB: M }, TextDecoder, Blob, console, Date, Math, setTimeout, clearTimeout };
  vm.createContext(ctx);
  for (const f of ['js/importstyle.js', 'js/fileimports.js']) vm.runInContext(read(f), ctx, { filename: f });
  const kml = `<?xml version="1.0"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document><Placemark><name>N0LO</name>
<description><![CDATA[\r\nAndytown<br>\r\n442.825000+ 110.9<br>\r\nOn-air:   Yes<br>\r\n<a href='https://example.com/?a=1&b=2'>Click for Details</a>\r\n]]></description>
<Point><coordinates>-80.45,26.15,0</coordinates></Point></Placemark></Document></kml>`;
  const { features } = M.imports.read.kml(kml);
  assert.equal(features[0].properties.description, 'Andytown\n442.825000+ 110.9\nOn-air: Yes\nClick for Details');
});

test('review fixes: a description with no line break tags keeps its lines; a file\'s shape only from the list; the move cursor kept', () => {
  const M = { escapeHtml: s => String(s) };
  const ctx = { window: { MB: M }, TextDecoder, Blob, console, Date, Math, setTimeout, clearTimeout };
  vm.createContext(ctx);
  for (const f of ['js/importstyle.js', 'js/fileimports.js']) vm.runInContext(read(f), ctx, { filename: f });
  const desc = d => M.imports.read.kml(`<?xml version="1.0"?><kml><Document><Placemark><name>x</name><description>${d}</description><Point><coordinates>1,2</coordinates></Point></Placemark></Document></kml>`).features[0].properties.description;
  assert.equal(desc('Owner: Smith &amp; Sons\nPhone: 555\nNote'), 'Owner: Smith & Sons\nPhone: 555\nNote', 'an entity: the lines kept');
  assert.equal(desc('Owner: Smith and Sons\nPhone: 555'), 'Owner: Smith and Sons\nPhone: 555');
  assert.equal(desc('Line one\n<![CDATA[Line <b>two</b>]]>'), 'Line one\nLine two', 'a bold word: the lines kept');

  for (const bad of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    assert.equal(MB.markerShape({ markerShape: bad }), 'pin', bad);
    assert.equal(MB.markerIcon({ markerShape: bad }).options.className, 'mb-pin');
  }
  assert.match(read('js/features.js'), /layer\.pm\.layerDragEnabled\(\)\) L\.DomUtil\.addClass\(el, 'leaflet-pm-draggable'\)/);
});

test('the click that ends a drag of an object opens no popup', () => {
  assert.match(read('js/features.js'), /if \(layer\.pm && layer\.pm\.dragging && layer\.pm\.dragging\(\)\) return;/);
});
