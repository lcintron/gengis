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

function loadAll() {
  const M = { escapeHtml: s => String(s) };
  const ctx = { window: { MB: M }, TextDecoder, Blob, console, Date, Math, setTimeout, clearTimeout };
  vm.createContext(ctx);
  for (const f of ['js/util.js', 'js/importstyle.js', 'js/fileimports.js']) vm.runInContext(read(f), ctx, { filename: f });
  return M;
}
const ALL = loadAll();
const kmlDesc = d => ALL.imports.read.kml('<?xml version="1.0"?><kml><Document><Placemark><name>x</name><description>' + d + '</description><Point><coordinates>1,2</coordinates></Point></Placemark></Document></kml>').features[0].properties.description;

test('a KML description with formatting is kept as written; as text, a <br> and the new line after it are one break', () => {
  const raw = "\r\nAndytown<br>\r\n442.825000+ 110.9<br>\r\nOn-air:   Yes<br>\r\n<a href='https://example.com/?a=1&b=2'>Click for Details</a>\r\n";
  assert.equal(kmlDesc('<![CDATA[' + raw + ']]>'), raw.trim(), 'the file\'s HTML, kept');
  assert.equal(ALL.htmlText(raw), 'Andytown\n442.825000+ 110.9\nOn-air: Yes\nClick for Details');
  assert.equal(ALL.htmlText('one<br class="x">\r\ntwo'), 'one\ntwo', 'a <br> with attributes is a break too');
});

test('review fixes: a description with no line break tags keeps its lines; a file\'s shape only from the list; the move cursor kept', () => {
  assert.equal(kmlDesc('Owner: Smith &amp; Sons\nPhone: 555\nNote'), 'Owner: Smith & Sons\nPhone: 555\nNote', 'an entity: the lines kept');
  assert.equal(kmlDesc('Owner: Smith and Sons\nPhone: 555'), 'Owner: Smith and Sons\nPhone: 555');
  assert.equal(ALL.htmlText('Line one\nLine <b>two</b>'), 'Line one\nLine two', 'a bold word: the lines kept');
  assert.equal(ALL.htmlText('Smith &amp; Sons\r\nPhone'), 'Smith & Sons\nPhone', 'no carriage return left');

  for (const bad of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    assert.equal(MB.markerShape({ markerShape: bad }), 'pin', bad);
    assert.equal(MB.markerIcon({ markerShape: bad }).options.className, 'mb-pin');
  }
  assert.match(read('js/features.js'), /layer\.pm\.layerDragEnabled\(\)\) L\.DomUtil\.addClass\(el, 'leaflet-pm-draggable'\)/);
});

test('the click that ends a drag of an object opens no popup', () => {
  assert.match(read('js/features.js'), /if \(layer\.pm && layer\.pm\.dragging && layer\.pm\.dragging\(\)\) return;/);
});

test('formatted values: only what is safe is kept, rebuilt from scratch', () => {
  const S = ALL.safeHtml;
  assert.equal(S('Andytown<br>\n<b>On-air</b>: Yes<br><a href="https://example.com/d.php?a=1&amp;b=2">Click for Details</a>'),
    'Andytown<br>\n<b>On-air</b>: Yes<br><a href="https://example.com/d.php?a=1&amp;b=2" target="_blank" rel="noopener noreferrer">Click for Details</a>');
  // scripts, handlers, frames, styles: gone
  assert.equal(S('<p onclick="alert(1)" style="x">hi</p><script>alert(1)</script><style>p{}</style><iframe src="https://x"></iframe>'), '<p>hi</p>');
  assert.equal(S('<img src=x onerror=alert(1)>ok'), 'ok', 'a picture from nowhere: dropped');
  assert.equal(S('<svg onload=alert(1)><circle/></svg>ok'), 'ok');
  assert.equal(S('<a href="javascript:alert(1)">x</a>'), '<a>x</a>');
  assert.equal(S('<a href="java&#115;cript:alert(1)">x</a>'), '<a>x</a>', 'an entity does not hide javascript:');
  assert.equal(S('<a href=" JAVASCRIPT:alert(1)">x</a>'), '<a>x</a>');
  assert.equal(S('<a href="data:text/html,x">x</a>'), '<a>x</a>');
  assert.equal(S('<img src="https://e.com/p.png" width="80" height="x" onload="y">'), '<img src="https://e.com/p.png" loading="lazy" referrerpolicy="no-referrer" width="80">');
  assert.equal(S('<font color="red" face="x">r</font><font color="red;background:url(x)">s</font>'), '<font style="color:red">r</font><font>s</font>');
  assert.equal(S('<table><tr><td colspan="2" align="center">c</td></tr></table>'), '<table><tr><td colspan="2" style="text-align:center">c</td></tr></table>');
  // text stays text; tags left open are closed; stray closes dropped
  assert.equal(S('a < b & c > d'), 'a &lt; b &amp; c &gt; d');
  assert.equal(S('fish &amp; chips &eacute;'), 'fish &amp; chips &eacute;', 'entities kept');
  assert.equal(S('<b>bold <i>both</b> after</i>'), '<b>bold <i>both</i></b> after');
  assert.equal(S('<table><tr><td>x'), '<table><tr><td>x</td></tr></table>');
  assert.equal(S('</div>x<!-- <script>alert(1)</script> -->'), 'x');
  assert.equal(S('<unknown>x</unknown> <SCRIPT>a</SCRIPT>'), 'x ');
  assert.equal(S('<b title="a&quot; onmouseover=&quot;x">t</b>'), '<b title="a&quot; onmouseover=&quot;x">t</b>', 'an attribute value: escaped');
  assert.equal(S('<a href="https://e.com/"onclick="x">t</a>'), '&lt;a href="https://e.com/"onclick="x"&gt;t', 'attributes run together: not a tag, its text shown');
  assert.equal(S('<scr<script>ipt>alert(1)</script>'), '&lt;scr', 'a split tag: what is left is text');

  // a value is formatted only when it has real tags; ordinary text with < and & is text
  assert.equal(ALL.isHtml('a <b>b</b>'), true);
  assert.equal(ALL.isHtml('<5 km & >3 m'), false);
  assert.equal(ALL.isHtml('Name <none>'), false);
  assert.equal(ALL.isHtml(42), false);
  assert.equal(ALL.richValue('<b>x</b>'), '<div class="mb-rich"><b>x</b></div>');
  assert.equal(ALL.richValue('a <none> & b'), 'a &lt;none&gt; &amp; b');
});

test('formatted values: shown made safe in popups; titles, labels and hover names as text', () => {
  const S = ALL.importStyle, p = { name: 'N0LO', description: '<b>Andytown</b><br>442.825' };
  const look = S.defaults([{ type: 'Feature', properties: p, geometry: { type: 'Point', coordinates: [0, 0] } }]);
  look.title = 'description';
  assert.equal(S.titleOf(look, p), 'Andytown\n442.825');
  look.label.field = 'description';
  assert.equal(S.labelText(look, p), 'Andytown\n442.825');
  look.label.field = ''; look.label.text = '{name}: {description}';
  assert.equal(S.labelText(look, p), 'N0LO: Andytown 442.825');
  const dl = read('js/datalayers.js');
  assert.equal(dl.split('MB.richValue(v)}</td></tr>').length - 1, 2, 'an imported layer\'s popup and an object\'s');
});

test('review fixes: names on hover are text; a stray row or cell stays out of the popup\'s table; no slow reading of crafted text', () => {
  // a title that reads as markup once its entities are read (hover names are set as HTML by Leaflet)
  const tips = [];
  const layer = { feature: { properties: { name: 'x', description: '<b>t</b>&lt;img src=x onerror=alert(1)&gt;' } },
    getTooltip: () => null, bindTooltip: t => tips.push(t), setTooltipContent: t => tips.push(t), unbindTooltip() {} };
  const look = ALL.importStyle.defaults([{ type: 'Feature', properties: layer.feature.properties, geometry: { type: 'Point', coordinates: [0, 0] } }]);
  look.title = 'description';
  ALL.imports.tip({ meta: { look } }, layer);
  assert.equal(tips[0], 't&lt;img src=x onerror=alert(1)&gt;');
  for (const [f, re] of [['js/ui.js', /bindTooltip\(esc\(f\.mb\.name\)/], ['js/ui.js', /cm\.bindTooltip\(esc\(p\.name\)/],
    ['js/datalayers.js', /layer\.bindTooltip\(esc\(String\(lbl\)\)/], ['js/datalayers.js', /line\.bindTooltip\(esc\(names\.join\(' \/ '\)\)/]]) assert.match(read(f), re, f);

  const S = ALL.safeHtml;
  assert.equal(S('<td>x</td><tr><td>y</td></tr><thead>z</thead><caption>c</caption>'), 'xyzc', 'no table of its own: its rows and cells are text');
  assert.equal(S('<table><tr><td colspan="2">x</td></tr></table>'), '<table><tr><td colspan="2">x</td></tr></table>');
  assert.equal(ALL.htmlText('caf&eacute; &copy; 2026 &ndash; 5&deg;'), 'café © 2026 – 5°');

  for (const big of ['&lt;'.repeat(100000), '<'.repeat(100000), '<b>x</b>' + ' '.repeat(200000) + 'y', ('<br>' + ' '.repeat(50)).repeat(5000)]) {
    const t0 = Date.now();
    ALL.htmlText(big); ALL.safeHtml(big);
    ALL.imports.read.kml('<?xml version="1.0"?><kml><Document><Placemark><name>x</name><description>' + big.replace(/</g, '&lt;') + '</description><Point><coordinates>1,2</coordinates></Point></Placemark></Document></kml>');
    assert.ok(Date.now() - t0 < 1500, 'read in ' + (Date.now() - t0) + ' ms');
  }
  assert.ok(read('electron/main.js').includes('const external = url => { if (/^(https?:\\/\\/|mailto:)/i.test(url)) shell.openExternal(url); };'), 'the desktop app opens an email link');
});
