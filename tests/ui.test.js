'use strict';
// Static checks of the page, its scripts and its stylesheets (no browser needed): mistakes that pass every unit test
// and only show on screen.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = process.env.GENGIS_ROOT || path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const html = read('index.html');
const jsFiles = fs.readdirSync(path.join(ROOT, 'js')).filter(f => f.endsWith('.js'));
const js = Object.fromEntries(jsFiles.map(f => [f, read('js/' + f)]));
const css = read('css/app.css');
const allJs = Object.values(js).join('\n');

// Every id the page has: in index.html, or given in a script (element.id = '…', id="…" in a template, { id: '…' }).
const ids = new Set();
for (const m of html.matchAll(/\bid="([^"]+)"/g)) ids.add(m[1]);
for (const m of allJs.matchAll(/\.id\s*=\s*'([\w-]+)'/g)) ids.add(m[1]);
for (const m of allJs.matchAll(/\bid=\\?"([\w-]+)\\?"/g)) ids.add(m[1]);
for (const m of allJs.matchAll(/\bid="([\w-]+)"/g)) ids.add(m[1]);
for (const m of allJs.matchAll(/dotHtml\('([\w-]+)'/g)) ids.add(m[1]); // a section's on/off dot (MB.data.dotHtml)

test('every script compiles (a syntax error stops the whole file, and with it the app, where no other test loads it)', () => {
  const vm = require('vm');
  for (const [f, src] of Object.entries(js)) assert.doesNotThrow(() => new vm.Script(src, { filename: 'js/' + f }), 'js/' + f);
  assert.doesNotThrow(() => new vm.Script(read('sw.js'), { filename: 'sw.js' }), 'sw.js');
});

test('the hidden attribute always hides (no display rule of its own may show a hidden element)', () => {
  assert.match(css, /^\[hidden\]\s*\{\s*display:\s*none\s*!important;\s*\}/m, 'css/app.css keeps [hidden] { display: none !important; }');
});

test('aircraft icons glide only between position reports, never through a zoom', () => {
  // an icon's own transition-duration (transition-property defaults to all) would glide every move, a zoom included
  assert.doesNotMatch(js['adsb.js'], /style\.transition(Duration)?\s*=/, 'js/adsb.js sets no transition on an icon itself');
  assert.match(css, /\.leaflet-mb-adsb-pane\.smooth \.mb-ac\.glide \{ transition: transform var\(--glide/, 'the glide is the pane\'s "smooth" rule, its length the icon\'s --glide');
  assert.match(js['adsb.js'], /'zoomstart', \(\) => \{[^}]*classList\.remove\('smooth'\)/, 'a zoom switches the glide off');
});

test('aircraft icons show where the aircraft is now: carried on from each report, not gliding up to it', () => {
  const place = /place\(now, all\) \{([\s\S]*?)\n    \},/.exec(js['adsb.js']);
  assert.ok(place, 'js/adsb.js has place(now, all)');
  const body = place[1];
  // first where it is now with the glide off, the style applied, then the glide on to where its next report is due
  assert.ok(body.indexOf("remove('glide')") < body.indexOf('this.at(e, now)'), 'placed at now with its glide off');
  assert.ok(body.indexOf('this.at(e, now)') < body.indexOf('offsetWidth') && body.indexOf('offsetWidth') < body.indexOf("add('smooth')"), 'applied before the glide is switched on');
  assert.ok(body.indexOf("add('glide')") < body.indexOf('this.at(e, e.until)'), 'then glides on to its next report');
  assert.match(body, /all \|\| e\.placed !== e\.until/, 'only icons with a new report (all after a zoom): the rest glide on');
  assert.match(js['adsb.js'], /'zoomend', \(\) => \{[^}]*this\.place\(/, 'the glide picks up again after a zoom');
});

test('the community networks and aisstream.io wait for zoom 8; your own receivers show at any zoom', () => {
  assert.match(js['adsb.js'], /const NET_ZOOM = 8;/);
  assert.match(js['adsb.js'], /if \(src\.kind !== 'receiver' && this\.zoomedOut\(src\)\) \{ this\.wait\(src\); return; \}/, 'no request below it');
  assert.match(js['ais.js'], /if \(!rt\.on \|\| s\.kind !== 'stream'\) return;/, 'only the stream waits');
  assert.match(js['ais.js'], /if \(this\.zoomedOut\(src\)\) this\.wait\(src\); else this\.connect\(src\);/, 'the stream does not connect below it');
  assert.match(css, /\.mb-zoom-hint \{/, 'the map says to zoom in');
});

test('my location: a pin button drops a marker at the position, only while it is known, and leaves the map alone', () => {
  const loc = js['locate.js'], css = read('css/app.css');
  assert.match(loc, /const b = self\.back = L\.DomUtil\.create\('a', 'mb-locate-back', bar\)[\s\S]*?const pinBar = self\.pinBar = L\.DomUtil\.create\('div', 'leaflet-bar mb-locate mb-locate-pinbar', ctl\)[\s\S]*?self\.pinBtn = L\.DomUtil\.create\('a', 'mb-locate-pin', pinBar\)/,
    'below the back button, in a bar of its own (not in the location bar)');
  assert.match(loc, /pinBar\.hidden = true;/, 'hidden until there is a position');
  assert.match(loc, /this\.bar\.classList\.toggle\('following'/, 'only the location bar is lit, not the pin');
  assert.match(loc, /canPin\(\) \{ return this\.watchId != null && !!this\.fix && !\(MB\.presenter && MB\.presenter\.active\); \}/, 'shown while the location is on with a position, following or not; never while presenting (nothing is edited then)');
  assert.match(loc, /hidePin = !this\.canPin\(\)[\s\S]*?this\.pinBar\.hidden = hidePin;/);
  assert.match(loc, /MB\.on\('presenter', \(\) => this\.render\(\)\)/, 'presenting starts or ends: the button hides or shows');
  assert.match(loc, /const had = document\.activeElement;[\s\S]*?this\.pinBar\.hidden = hidePin;\s*[^\n]*\n\s*if \(\(hideBack && had === this\.back\) \|\| \(hidePin && had === this\.pinBtn\)\) this\.btn\.focus\(\)/,
    'a focused button that hides hands the focus to the location button (noted before hiding: that drops the focus at once)');
  const drop = loc.slice(loc.indexOf('dropPin() {'), loc.indexOf('pan(latlng)'));
  assert.match(drop, /if \(!this\.canPin\(\)\) return null;/);
  assert.match(drop, /this\.pinTime\(fix\.at\)/, 'named with when the position was taken');
  assert.match(drop, /MB\.toast\(`Pin dropped at your location as of \$\{when\}/, 'the toast says when (after a GPS dropout the last position may be old)');
  assert.match(drop, /MB\.restoreFeature\(\{ type: 'marker', latlng: \[fix\.latlng\.lat, fix\.latlng\.lng\]/);
  assert.match(drop, /MB\.commit\(/, 'one undo step, and saved');
  assert.match(drop, /MB\.noteAdded\(f\)/, 'a hidden layer is pointed out');
  assert.doesNotMatch(drop, /selectFeature|setView|panTo|tools\.set/, 'nothing selected, the view not moved');
  assert.match(css, /\.mb-locate-pinbar \{ margin-top: 10px; \}/, 'a gap above it: a button on its own');
  assert.match(css, /\.mb-locate a svg \{ width: 18px; height: 18px; \}/, 'its icon the size of its neighbours');
});

test('a pin dropped at my location is named with the time, to the second, in the zone the map\'s clock shows', () => {
  const src = js['locate.js'];
  const pinTime = new Function('MB', 'return ' + src.slice(src.indexOf('pinTime(at) {') + 'pinTime'.length, src.indexOf('// A marker at the position')).trim().replace(/,$/, '').replace(/^\(at\)/, 'function (at)'));
  const at = Date.UTC(2026, 0, 15, 18, 32, 5);
  const clock = c => ({ clock: { config: () => c } });
  // the app writes the time the user's way; the test reads it in US English, whatever this machine's language
  const orig = Date.prototype.toLocaleTimeString;
  Date.prototype.toLocaleTimeString = function (locales, o) { return orig.call(this, 'en-US', o); };
  try {
    assert.match(pinTime(clock({ show: true, mode: 'utc', zone: '' }))(at), /^6:32:05\sPM UTC$/, 'the clock in UTC: UTC');
    assert.match(pinTime(clock({ show: true, mode: 'local', zone: 'Asia/Tokyo' }))(at), /^3:32:05\sAM GMT\+9$/, 'a chosen zone');
    assert.match(pinTime(clock({ show: false, mode: 'utc', zone: 'Asia/Tokyo' }))(at), /^3:32:05\sAM GMT\+9$/, 'the clock hidden: the chosen local zone still');
    assert.equal(pinTime({})(at), new Date(at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit', timeZoneName: 'short' }), 'no clock: this device\'s zone, named');
  } finally { Date.prototype.toLocaleTimeString = orig; }
});

test('my location lets the map be moved off it, with a button back (no spring back, no tug of war)', () => {
  const loc = js['locate.js'];
  assert.doesNotMatch(loc, /'dragend boxzoomend'/, 'a pan by hand no longer springs back');
  assert.match(loc, /map\.on\('dragstart', \(\) => this\.unfollow\(\)\)/, 'a drag stops the following');
  assert.match(loc, /if \(this\.own\) \{ this\.own = false; return; \}/, 'its own pans do not stop it');
  assert.match(loc, /hideBack = !\(on && this\.fix && !this\.follow\)[\s\S]*?this\.back\.hidden = hideBack;/, 'the button back shows only while off the position');
  // a live popup re-placed with every report would pan the map each time (Leaflet's autoPan on setLatLng)
  for (const f of ['adsb.js', 'ais.js', 'mavlink.js']) assert.match(js[f], /popup\.openOn\(MB\.map\);\r?\n\s*popup\.options\.autoPan = false;/, f + ': its popup pans only as it opens');
});

test("a phone's panel never grows under the top bar (its grip and tabs stay reachable)", () => {
  // vh on a phone counts the address bar as hidden: 88vh could be taller than the map area under the top bar
  assert.match(css, /#sidebar \{ position: absolute;[^}]*max-height: 88%;/, 'the sheet is at most 88% of the area under the top bar');
  assert.match(js['ui.js'], /max: \(\) => under\(0\.88\)/, 'the grip stops there too');
  assert.match(js['ui.js'], /setProperty\('--sheet-user', [^;]*'dvh'\); else bar\.style\.removeProperty\('--sheet-user'\);/, 'its size is a share of the screen as shown; the default clears it');
});

test('LAANC ceilings show from zoom 8, in 1° cells there so a view fits the cell limit', () => {
  assert.match(js['datalayers.js'], /id: 'uasfm', [^\n]*minZoom: 8,\r?\n[^\n]*\r?\n\s*levels: \[\{ maxZoom: 9, cellSize: 1 \}, \{ cellSize: CELL \}\], maxCells: 64,\r?\n\s*rev: 1,/);
});

test('adding an ArcGIS layer is in the ArcGIS section, with the layers added', () => {
  assert.match(js['datalayers.js'], /<details class="ds-source" data-src="custom"[\s\S]*?id="dataCustomForm"[\s\S]*?<\/form>\s*<\/div><\/details>/);
});

test('a zoom level is written with the magnifying glass, not the word', () => {
  assert.match(js['util.js'], /MB\.zoomIcon = MB\.ICON\.search/);
  assert.match(js['datalayers.js'], /on · \$\{MB\.zoomIcon\}\$\{MB\.formatZoom\(zoom\)\}/, 'the Data tab heading');
  // labels and readouts: a "Min/Max zoom" label, or "zoom" and a number, is gone from what a page shows
  for (const f of ['datalayers.js', 'offline.js', 'settings.js', 'ui.js']) assert.doesNotMatch(js[f], /<label[^>]*>(Min|Max|Zoom) (zoom|level)/, f);
  assert.doesNotMatch(js['offline.js'], />zoom \$\{/);
});

test('every source that waits for a zoom level can have it overridden, its default shown', () => {
  assert.match(js['datalayers.js'], /this\.minZoomHtml\(this\.minZoomOf\(d\), d\.minZoom\)/, 'data layers');
  assert.match(js['adsb.js'], /s\.kind === 'receiver' \? '' : MB\.data\.minZoomHtml\(this\.minZoomFor\(s\.id\), NET_ZOOM/, 'the ADS-B networks');
  assert.match(js['ais.js'], /s\.kind === 'stream' \? MB\.data\.minZoomHtml\(this\.minZoomFor\(s\.id\), NET_ZOOM\)/, 'aisstream.io');
  assert.doesNotMatch(js['datalayers.js'], /zoom < ds\.def\.minZoom/, 'what loads follows the override');
  assert.match(js['offline.js'], /MB\.data\.minZoomOf\(ds\.def\)/, 'offline areas too');
});

test('every data source section has its dot, and the buttons their icons', () => {
  for (const f of ['adsb.js', 'ais.js', 'mavlink.js', 'betaflight.js', 'declination.js', 'datalayers.js']) assert.match(js[f], /<summary class="ds-source-head">[^\n]*dotHtml\(/, f);
  for (const f of ['betaflight.js', 'datalayers.js']) assert.doesNotMatch(js[f], /\['', ''\]/, f + ': no section goes without one');
  assert.match(js['cloudui.js'], /MB\.iconBtn\('gear', 'Manage cloud sync'/);
  assert.match(js['offline.js'], /MB\.ICON\.download\}Download view/);
  assert.match(js['ui.js'], /'Left side', 'sideLeft'/);
  assert.match(js['datalayers.js'], /MB\.ICON\.plus\}Add layer/);
  assert.match(html, /id="addLayerBtn" class="btn small with-icon"><svg/);
});

test('a status line changing (empty, plain, with a zoom icon) patches the Data panel, not rebuilds it', () => {
  // a rebuild would throw keyboard focus off a layer's switch as it is toggled
  assert.match(js['datalayers.js'], /const leaf = el => el\.nodeType === 1 && el\.classList\.contains\('dstatus'\);/);
  assert.match(js['datalayers.js'], /return leaf\(a\) \|\| sameKids\(a, b\);/, 'its content is not compared node by node');
  assert.match(js['datalayers.js'], /if \(leaf\(a\)\) \{ if \(a\.innerHTML !== b\.innerHTML\) a\.innerHTML = b\.innerHTML; return; \}/, 'it is taken over whole');
  // the same for a min-zoom box: its Reset is hidden at the default, not left out
  assert.match(js['datalayers.js'], /data-act="minzoom-reset"\$\{now !== dflt && !off \? '' : ' hidden'\}>Reset<\/button>/);
  assert.match(js['datalayers.js'], /reset\.addEventListener\('click', \(\) => \{ const z = set\(null\); if \(box\) \{ box\.value = z; box\.focus\(\); \} \}\)/, 'Reset puts the default back in the kept box, and focus there (it hides itself)');
});

test('every element a script looks up by id exists', () => {
  const missing = [];
  for (const [f, src] of Object.entries(js)) {
    const refs = [
      ...src.matchAll(/\$\(\s*'#([\w-]+)'\s*[,)]/g), // (also $('#x', scope))
      ...src.matchAll(/getElementById\(\s*'([\w-]+)'\s*\)/g),
      ...src.matchAll(/querySelector\(\s*'#([\w-]+)'\s*\)/g)
    ];
    for (const m of refs) if (!ids.has(m[1])) missing.push(f + ': #' + m[1]);
  }
  assert.deepEqual([...new Set(missing)], [], 'ids looked up but never created');
});

test('every #id the stylesheet styles exists (no rules left behind for removed elements)', () => {
  const styled = new Set();
  const noComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const block of noComments.matchAll(/([^{}]+)\{/g)) {
    if (/^\s*@/.test(block[1])) continue;
    for (const m of block[1].matchAll(/#([A-Za-z][\w-]*)/g)) styled.add(m[1]);
  }
  const orphans = [...styled].filter(id => !ids.has(id) && !/^[0-9a-f]{3,8}$/i.test(id));
  assert.deepEqual(orphans, [], 'styled ids that no page or script creates');
});

test('a data-act a menu or button uses has a handler, and a handler has a button', () => {
  const acts = new Set([...html.matchAll(/data-act="([\w-]+)"/g)].map(m => m[1]));
  // the menu's own handler (MB.ui.menuAction's switch), not any switch anywhere
  const body = (js['ui.js'].split('MB.ui.menuAction = function')[1] || '').split(/\n  };\r?\n/)[0];
  assert.ok(body.includes('switch'), 'MB.ui.menuAction found');
  const handled = new Set([...body.matchAll(/case '([\w-]+)':/g)].map(m => m[1]));
  // (close and a few others are handled by their own listeners)
  const own = new Set([...allJs.matchAll(/\[data-act="([\w-]+)"\]/g)].map(m => m[1]));
  const unhandled = [...acts].filter(a => !handled.has(a) && !own.has(a));
  assert.deepEqual(unhandled, [], 'buttons whose action nothing handles');
});

test('the community ADS-B networks are offered in the desktop app only (they answer no web page)', () => {
  assert.match(js['adsb.js'], /const usable = src => src\.kind !== 'area' \|\| !!window\.gengisDesktop;/);
  assert.match(js['adsb.js'], /if \(!usable\(src\)\) \{[^}]*return; \}/, 'a web page does not start one');
  assert.match(js['adsb.js'], /data-act="adsb-toggle"\$\{rt\.on \? ' checked' : ''\}\$\{off\}/, 'its switch is disabled there');
  assert.match(css, /\.data-item\.unavailable /);
});

test('the clock settings show only what applies: its choices while it is on, the zone only with local time', () => {
  const ui = js['ui.js'];
  assert.match(ui, /id="clockModeField"\$\{c\.show \? '' : ' hidden'\}/, 'Local / UTC / Both hidden while off');
  assert.match(ui, /id="clockZoneField"\$\{c\.show && c\.mode !== 'utc' \? '' : ' hidden'\}/, 'the zone hidden while off and with UTC only');
  assert.match(ui, /\$\('#clockModeField', panel\)\.hidden = !c\.show;/, 'kept so as it changes');
  assert.match(ui, /\$\('#clockZoneField', panel\)\.hidden = !c\.show \|\| c\.mode === 'utc';/);
  assert.match(html, /<script src="js\/clock\.js"><\/script>/);
  assert.match(read('sw.js'), /'\.\/js\/clock\.js'/, 'offline too');
});