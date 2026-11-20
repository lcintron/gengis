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

test("the menu drawer slides in without flicker on Android's WebView, and keeps its scroll to itself", () => {
  const menu = /\.dropdown\.more-menu \{([^}]*)\}/.exec(css);
  assert.ok(menu, 'css/app.css has .dropdown.more-menu');
  assert.match(menu[1], /will-change: transform;/, 'one layer for as long as it shows, not one made and dropped on each opening');
  assert.match(menu[1], /overscroll-behavior: contain;/, 'its scroll does not carry on to the sheet or page');
  assert.doesNotMatch(menu[1], /contain: paint/, 'its shadow is not clipped');
  assert.match(css, /@keyframes mb-drawer-in \{ from \{ transform: translateX\(-100%\); \} to \{ transform: translateX\(0\); \} \}/, 'it ends on a translate, not transform: none');
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

test('every button in a side panel leads with an icon, each action drawn one way', () => {
  // The icon comes before the words, from MB.ICON (or the drawing the object toolbar already has for that action).
  // Banner and dialog buttons are a change of their own: what is left here is listed, so nothing new slips in.
  const LATER = ['Reload to update']; // the update banner (js/ui.js)
  const bare = [];
  for (const f of ['ui.js', 'settings.js', 'importstyle.js', 'adsb.js', 'datalayers.js']) {
    for (const m of js[f].matchAll(/<button[^>]*\bclass="btn[ "][^>]*>([\s\S]*?)<\/button>/g)) {
      const inner = m[1].trim();
      if (/<svg|MB\.ICON|ACT\.|icons\.|iconGlyph|iconPreview/.test(inner) || LATER.includes(inner)) continue;
      bare.push(f + ': ' + inner.replace(/\s+/g, ' ').slice(0, 60));
    }
  }
  assert.deepEqual(bare, [], 'buttons showing words only');
  // the ones this change was about, by name (a label that moves must bring its icon along)
  assert.match(js['ui.js'], /MB\.ICON\.reset\}Reset to defaults/, 'Layers → new-shape defaults');
  assert.match(js['settings.js'], /MB\.ICON\.reset\}Reset to defaults/, 'Settings → search services');
  for (const [f, re] of [
    ['ui.js', /MB\.ICON\.eye\}Show layer/], ['ui.js', /MB\.ICON\.unlock\}Unlock/], ['ui.js', /MB\.ICON\.ungroup\}Ungroup/],
    ['ui.js', /MB\.ICON\.joinLines\}Join lines/], ['ui.js', /MB\.ICON\.polyFromLines\}Polygon from lines/],
    ['ui.js', /MB\.ICON\.joinShapes\}Join shapes/], ['ui.js', /\$\{ACT\.pasteStyle\}Paste style/],
    ['ui.js', /MB\.ICON\.search\}Search in current view/], ['ui.js', /MB\.ICON\.sweep\}Clear/],
    ['ui.js', /MB\.ICON\.pinAdd\}Add all/], ['ui.js', /MB\.iconBtn\('pinAdd', 'Add as marker/],
    ['settings.js', /MB\.ICON\.upload\}Import map sources/], ['settings.js', /MB\.ICON\.check\}Use/],
    ['settings.js', /MB\.ICON\.save\}Save/], ['settings.js', /MB\.ICON\.save \+ 'Save changes'/], ['settings.js', /MB\.ICON\.close\}Cancel/],
    ['importstyle.js', /MB\.ICON\.eye\}Show all/], ['importstyle.js', /MB\.ICON\.eyeOff\}Hide all/],
    ['adsb.js', /MB\.ICON\.search\}Look up aircraft details/], ['datalayers.js', /MB\.ICON\.pointer\}Select/]
  ]) assert.match(js[f], re, f);
  // the list's eye and lock are the same drawings, not copies of them
  for (const k of ['eye', 'eyeOff', 'lock', 'unlock']) assert.match(js['ui.js'], new RegExp('\\n\\s+' + k + ': MB\\.ICON\\.' + k + ','), 'ui.js icons.' + k);
  // one picture per action: a new icon that repeats an older one (Reset as Refresh) would say the wrong thing
  const seen = new Map();
  for (const m of js['util.js'].matchAll(/^\s+(\w+): ic\('(.*?)'\)/gm)) {
    assert.equal(seen.get(m[2]), undefined, `MB.ICON.${m[1]} is MB.ICON.${seen.get(m[2])} drawn again`);
    seen.set(m[2], m[1]);
  }
  const names = [...seen.values()];
  for (const k of ['reset', 'save', 'check', 'eye', 'eyeOff', 'lock', 'unlock', 'pointer', 'ungroup', 'joinLines', 'polyFromLines', 'joinShapes']) assert.ok(names.includes(k), 'MB.ICON.' + k);
  // a long label wraps at a phone's width; its icon keeps its size
  assert.match(css, /\.btn\.with-icon > svg, \.btn\.with-icon > \.mbi \{ flex: none; \}/);
  assert.match(css, /\.btn\.wrap \{ white-space: normal;/);
  for (const [f, re] of [['ui.js', /class="btn small with-icon wrap" type="button">\$\{MB\.ICON\.pinAdd\}Add all/], ['settings.js', /class="btn small with-icon wrap"[^>]*>\$\{MB\.ICON\.upload\}Import/]]) assert.match(js[f], re, f);
});

test('a button whose icon sits inside it is still the click: no handler asks for a BUTTON target', () => {
  // e.target is the svg when the icon is clicked: a tagName test would drop the click
  for (const f of ['ui.js', 'settings.js', 'importstyle.js', 'adsb.js', 'datalayers.js']) {
    assert.doesNotMatch(js[f], /e\.target\.tagName === 'BUTTON'/, f);
  }
  assert.match(js['ui.js'], /if \(e\.target\.closest\('button'\)\) \{ addPoi\(p\); return; \}/, 'a point of interest: its row pans, its button adds');
});

test('the name typed in the top bar can be taken as the project\'s there and then (MB.ui.commitName)', () => {
  const src = js['ui.js'];
  const body = src.slice(src.indexOf('MB.ui.commitName = function'), src.indexOf('function initTopbar'));
  assert.ok(/MB\.commit\('rename project'\)/.test(body), 'MB.ui.commitName found');
  const make = new Function('MB', '$', 'document', body + '\nreturn MB.ui.commitName;');
  const run = (typed, was) => {
    const input = { value: typed };
    const MBx = { ui: {}, state: { projectName: was }, commits: 0, commit() { this.commits++; } };
    const doc = { title: 'x' };
    make(MBx, () => input, doc)();
    return { name: MBx.state.projectName, value: input.value, title: doc.title, commits: MBx.commits };
  };
  assert.deepEqual(run('  Harbor survey  ', 'Untitled map'), { name: 'Harbor survey', value: 'Harbor survey', title: 'Harbor survey - GenGIS', commits: 1 }, 'trimmed, taken, one undo step');
  assert.deepEqual(run('   ', 'Alpha'), { name: 'Untitled map', value: 'Untitled map', title: 'Untitled map - GenGIS', commits: 1 }, 'an emptied name is Untitled map');
  assert.deepEqual(run('Alpha', 'Alpha'), { name: 'Alpha', value: 'Alpha', title: 'x', commits: 0 }, 'unchanged: nothing committed, no undo step');
  // A project opened keeps the name its file has, untidied, and the box shows it as it is. Opening the cloud
  // dialog then calls this: an untouched box must not rename the project (an undo step, a save, a cloud rename).
  assert.deepEqual(run('  Harbor ', '  Harbor '), { name: '  Harbor ', value: '  Harbor ', title: 'x', commits: 0 }, 'untouched, spaces and all: left alone');
  assert.deepEqual(run('   ', '   '), { name: '   ', value: '   ', title: 'x', commits: 0 }, 'a name of spaces only is not turned into "Untitled map" (that would make it a draft)');
  assert.deepEqual(run('42', 42), { name: 42, value: '42', title: 'x', commits: 0 }, 'a name that is not a text: compared as the box shows it');
  // no box yet (a panel that opens before the top bar is set up): nothing happens
  const MBy = { ui: {}, state: { projectName: 'Alpha' }, commit() { throw new Error('committed'); } };
  assert.doesNotThrow(() => make(MBy, () => null, { title: '' })());
  // the cloud dialog takes it before it reads the projects, so a row never offers to name a named project
  assert.match(js['cloudui.js'], /U\.open = function \(\) \{\r?\n\s*if \(MB\.ui\.commitName\) MB\.ui\.commitName\(\);/);
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

test('the community ADS-B networks are offered in the native apps only, desktop and Android (they answer no web page)', () => {
  assert.match(js['adsb.js'], /const usable = src => src\.kind !== 'area' \|\| !!window\.gengisDesktop \|\| !!\(MB\.native && MB\.native\.app\);/, 'and the Android app');
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
test('dialogs stay between the system bars (Android edge-to-edge: the insets come as env(safe-area-inset-*))', () => {
  // the bodies of the rules whose selector list holds exactly this selector (not .modal-box-x, not .x .modal-box)
  const plain = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = sel => [...plain.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(m => m[1].split(',').some(s => s.trim() === sel)).map(m => m[2]);
  const one = sel => { const r = rules(sel); assert.ok(r.length, sel + ' found'); return r; };
  const inset = side => new RegExp(String.raw`env\(safe-area-inset-${side}\b`);
  // a vh max-height, then the same in dvh, both less the top and bottom insets
  const fits = (body, n, what) => {
    const less = String.raw`\s*-\s*env\(safe-area-inset-top, 0px\)\s*-\s*env\(safe-area-inset-bottom, 0px\)\)`;
    assert.match(body, new RegExp(String.raw`max-height: calc\(${n}vh${less};\s*max-height: calc\(${n}dvh${less};`), what);
  };
  const modal = one('.modal');
  assert.ok(modal.some(b => /(^|;)\s*padding:/.test(b) && ['top', 'right', 'bottom', 'left'].every(s => inset(s).test(b))),
    'the backdrop keeps its box off all four bars');
  const box = one('.modal-box').filter(b => /max-height/.test(b));
  assert.equal(box.length, 2, 'a dialog box\'s height: the base rule and the phone one');
  fits(box[0], 90, 'a dialog box');
  fits(box[1], 92, 'a dialog box on a phone');
  assert.ok(box.every(b => !/max-height: \d+vh;/.test(b)), 'no bare vh height left');
  assert.ok(one('.modal-box').some(b => /overscroll-behavior: contain/.test(b)), 'a dialog\'s scroll stays its own');
  const attr = one('.attr-box');
  assert.ok(attr.some(b => /max-height/.test(b)), 'the attribute table\'s height on a phone');
  attr.filter(b => /max-height/.test(b)).forEach(b => fits(b, 100, 'the attribute table on a phone'));
  assert.ok(attr.every(b => !/max-height: 100vh;/.test(b)), 'no full-screen attribute table under the bars');
  assert.ok(attr.some(b => /width: calc\(100vw - env\(safe-area-inset-left, 0px\) - env\(safe-area-inset-right, 0px\)\)/.test(b)),
    'nor beside them');
  // the phone's width is a full one: the desktop rule's max-width would hold it to 96vw and leave a gap at one side
  assert.ok(attr.filter(b => /width: calc\(100vw/.test(b)).every(b => /max-width: none;/.test(b)), 'the attribute table fills the phone\'s width');
  // Cloud sync's lists: as tall as the screen allows (dvh where known, vh before it, as the box itself), and a drag
  // on them, at their end, scrolls the dialog on
  const scroll = one('.cloud-scroll');
  assert.equal(scroll.length, 2, 'the cloud list\'s height: the base rule and the phone one');
  assert.match(scroll[0], /max-height: min\(330px, 42vh\); max-height: min\(330px, 42dvh\);/);
  assert.match(scroll[1], /max-height: 46vh; max-height: 46dvh;/);
  assert.ok(scroll.every(b => !/overscroll-behavior/.test(b)));
  // and the side menu's last items and the toast stay above the bar too
  // (top, right, bottom, left: a bar or cutout at the left too, in landscape, the drawer wider by it)
  const drawer = one('.dropdown.more-menu');
  assert.ok(drawer.some(b => /padding: 14px 14px calc\(14px \+ env\(safe-area-inset-bottom, 0px\)\) calc\(14px \+ env\(safe-area-inset-left, 0px\)\);/.test(b)));
  assert.ok(drawer.some(b => /width: min\(calc\(320px \+ env\(safe-area-inset-left, 0px\)\), calc\(100vw - 48px\)\);/.test(b)));
  assert.ok(one('#mb-toast').some(b => /bottom: calc\(24px \+ env\(safe-area-inset-bottom, 0px\)\)/.test(b)));
  // the new-version and read-only notices
  for (const sel of ['#mb-update', '#mb-readonly']) {
    const r = one(sel);
    assert.ok(r.some(b => /bottom: calc\(22px \+ env\(safe-area-inset-bottom, 0px\)\)/.test(b)), sel);
    assert.ok(r.every(b => !/bottom: \d+px;/.test(b)), sel + ': no bare bottom left');
  }
  // the three of them centred between the side bars (landscape: a bar or cutout at one side only), never under them
  const centred = String.raw`left: calc\(50% \+ \(env\(safe-area-inset-left, 0px\) - env\(safe-area-inset-right, 0px\)\) / 2\)`;
  const narrower = String.raw`- env\(safe-area-inset-left, 0px\) - env\(safe-area-inset-right, 0px\)\)`;
  for (const sel of ['#mb-toast', '#mb-update', '#mb-readonly']) {
    const r = one(sel);
    assert.ok(r.some(b => new RegExp(centred).test(b)), sel + ': centred between the side bars');
    assert.ok(r.some(b => new RegExp(String.raw`(max-)?width: calc\([^;]*${narrower};`).test(b)), sel + ': no wider than the room between them');
    assert.ok(r.every(b => !/(max-)?width: (calc\(\d+vw - \d+px\)|\d+vw);/.test(b)), sel + ': no full viewport width left');
  }
  assert.equal(one('#mb-update').filter(b => new RegExp(narrower).test(b)).length, 2, 'the new-version notice: the base rule and the phone one');
  // the presenter's logo in the top left corner, and the phone's bottom sheet
  assert.ok(one('.present-logo').some(b => /top: calc\(12px \+ env\(safe-area-inset-top, 0px\)\); left: calc\(12px \+ env\(safe-area-inset-left, 0px\)\);/.test(b)),
    'the presenter logo stays clear of the status bar and of a cutout');
  // the side panel: docked at the right above 640px (a phone in landscape too), a sheet at the bottom below that
  const side = one('#sidebar');
  assert.equal(side.length, 2, 'the side panel: the docked column and the phone\'s sheet');
  assert.ok(side.every(b => inset('right').test(b) && inset('bottom').test(b)),
    'the side panel clears a bar or cutout at its right and the bar below it, docked or as a sheet');
  assert.ok(side.some(b => ['bottom', 'left', 'right'].every(s => inset(s).test(b))),
    'the bottom sheet\'s content clears the bar below it and a bar or cutout beside it');
  // the map's right-hand controls take that room only while the map reaches that edge (no panel docked beside it)
  assert.ok(rules('html.native-app .leaflet-right').some(b => /margin-right: env\(safe-area-inset-right, 0px\);/.test(b)));
  const docked = 'html.native-app body:not(.presenting) #main:has(> #sidebar:not(.collapsed)) .leaflet-right';
  assert.ok(rules(docked).some(b => /margin-right: 0;/.test(b)),
    'with the panel docked beside it the map ends at the panel, which keeps that room itself');
  // presenting hides the panel with display: none, without adding .collapsed, and the map has the window to itself
  // again: every rule that gives up that room must leave presenter mode out, or its controls sit under the bar
  assert.match(css, /body\.presenting [^{]*#sidebar[^{]*\{ display: none !important; \}/, 'presenting hides the panel, .collapsed or not');
  const gaveUp = [...plain.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(m => /html\.native-app/.test(m[1]) && /\.leaflet-right/.test(m[1]) && /margin-right: 0;/.test(m[2])).map(m => m[1].trim());
  assert.ok(gaveUp.length, 'the docked-panel rule found');
  assert.ok(gaveUp.every(s => s.includes('body:not(.presenting)')), 'not while presenting: ' + gaveUp.join(' | '));
  // the tracking bar over the map: in the Android app above the gesture bar, as the coordinates below it are
  // (it sits in #mapwrap, not in a Leaflet corner, so the inset is its own and counted once)
  const trk = one('.trk-bar');
  assert.equal(trk.length, 2, 'the tracking bar: the base rule and the phone one');
  assert.ok(trk.every(b => /bottom: calc\(var\(--dock-h, \d+px\) \+ \d+px \+ var\(--trk-inset, 0px\)\);/.test(b) && !inset('bottom').test(b)));
  assert.ok(rules('html.native-app .trk-bar').some(b => /--trk-inset: env\(safe-area-inset-bottom, 0px\);/.test(b)), 'the inset only in the Android app');
  assert.ok(rules('html.native-app .leaflet-bottom').some(b => /margin-bottom: env\(safe-area-inset-bottom, 0px\);/.test(b)), 'the same room the map\'s corners get');
  // the export buttons' footer: the box ends above the bar, so no inset again
  assert.ok(one('.export-actions').every(b => !inset('bottom').test(b)));
});
test('the Project menu\'s items end without an ellipsis, and so does every label that names one of them', () => {
  const menu = (html.split('<div id="menu"')[1] || '').split('</div>')[0];
  const labels = [...menu.matchAll(/<span>([^<]*)<\/span>/g)].map(m => m[1].trim());
  assert.ok(labels.length >= 10, 'the menu\'s labels found');
  assert.deepEqual(labels.filter(l => /(…|\.\.\.)$/.test(l)), [], 'menu labels ending in an ellipsis');
  // the same actions named elsewhere (a button, a tooltip, an explanation) are the same words: "Save as", not
  // "Save as…" (a line of comment says what it likes; a status, a placeholder and a context menu are not these)
  const rx = l => new RegExp(l.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(…|\\.\\.\\.)');
  const trailing = [];
  for (const [f, src] of [['index.html', html], ...Object.entries(js).map(([n, s]) => ['js/' + n, s])]) {
    src.split('\n').forEach((line, i) => {
      if (/^\s*(\/\/|\/\*|\*|<!--)/.test(line)) return;
      labels.filter(l => rx(l).test(line)).forEach(l => trailing.push(`${f}:${i + 1} ${l}…`));
    });
  }
  assert.deepEqual(trailing, [], 'labels naming a menu item but ending in an ellipsis');
});

test('the cloud dialog deletes a project from the cloud only after a red confirm, with finger-sized buttons', () => {
  const ui = js['cloudui.js'];
  assert.ok(ui.includes("MB.iconBtn('trash', 'Delete from '"), 'a bin per cloud project');
  const del = ui.split('async function deleteRemote(')[1] || '';
  assert.ok(del.indexOf('await MB.ask(') >= 0 && del.indexOf('await MB.ask(') < del.indexOf('C().deleteRemote('), 'asked first');
  assert.match(del, /MB\.ask\([^;]*\{ danger: true \}\)/, 'the confirm is a delete\'s');
  assert.match(js['util.js'], /MB\.ask = function \(message, yes, no, opts\)/);
  assert.match(js['util.js'], /if \(opts && opts\.danger\) yesBtn\.classList\.replace\('primary', 'danger'\);/);
  assert.match(js['util.js'], /\(opts && opts\.danger \? noBtn : yesBtn\)\.focus\(\);/, 'Cancel has the focus');
  assert.match(css, /\.cloud-row \.icon-btn\.mini, \.cloud-h-row \.icon-btn\.mini \{ width: 36px; height: 36px; \}/);
  // one question per click, the focus kept in the list after a delete, no spinner left by a failed open
  assert.ok(del.indexOf("busy[fileId] = 'delete'") < del.indexOf('await MB.ask('), 'busy before the question');
  assert.match(del, /if \(!f \|\| busy\[fileId\]\) return;/);
  assert.match(del, /const el = near \? rowButton\(accId, near\.fileId[^;]*: dlg\.querySelector\(`\[data-reload=/);
  assert.match(ui, /try \{ ok = await C\(\)\.openRemote\(accId, fileId\); \}\s*catch \(e\) \{[^}]*\}\s*finally \{ delete busy\[fileId\]; \}/);
  // and while the delete runs (the row's buttons disabled, so the render cannot give the focus back to them) the
  // focus stays in the dialog rather than falling to the page behind it
  assert.ok(del.indexOf('await U.render();') < del.indexOf('holdFocus();'), 'the row is drawn quiet, then the focus is seen to');
  assert.ok(del.indexOf('holdFocus();') < del.indexOf('C().deleteRemote('), 'before the delete, not after it');
  assert.match(ui, /function holdFocus\(\) \{\s*if \(!isOpen\(\) \|\| dlg\.contains\(document\.activeElement\)\) return;[\s\S]{0,120}?dlg\.querySelector\('\.modal-x'\)/,
    'on the dialog\'s close button, and only once the focus has fallen out of the dialog');
});

test('a cloud project already on this device: the dialog closes once it is open, never before (an open called off leaves it up)', () => {
  const open = js['cloudui.js'].split('async function openRemote(')[1] || '';
  assert.ok(open, 'openRemote found');
  assert.match(open, /if \(await MB\.projects\.open\(l\.projectId\)\) MB\.ui\.closeDialog\(dlg\);/, 'opened first, closed after');
  assert.doesNotMatch(open, /MB\.ui\.closeDialog\(dlg\);\s*await MB\.projects\.open\(/, 'not closed before the open');
  // which means MB.projects.open says whether it opened: the user may keep what is open now instead
  const p = (js['projectstore.js'].split('P.open = async function (id) {')[1] || '').split('};')[0];
  assert.ok(p, 'P.open found');
  assert.match(p, /confirmReplace\('Open the other project'\)\)\) return false;/, 'called off: false');
  assert.match(p, /if \(!rec\) \{ MB\.toast\([^)]*\); return false; \}/, 'no longer saved here: false');
  assert.match(p, /return true;\s*$/, 'true once the project is loaded');
});

test('the cloud dialog\'s search: gone with its box, and a cloud section saying why it is empty stays shown', () => {
  const ui = js['cloudui.js'];
  assert.match(ui, /if \(!searchable\) query = '';/);
  assert.match(ui, /sec\.hidden = none && !sec\.querySelector\('\.note'\);/);
});

test('Recent projects deletes a synced project from the cloud first, and from this device only once that went through', () => {
  const ps = js['projectstore.js'];
  const del = ps.split("box.querySelectorAll('[data-del]')")[1].split("box.querySelectorAll('[data-restore]')")[0];
  assert.match(del, /if \(b\.dataset\.pending \|\| b\.closest\('\.recent-item'\)\.querySelector\('\.recent-ask'\)\) return;[\s\S]*b\.dataset\.pending = '1';[\s\S]*await MB\.cloud\.linkOf\(id\)/, 'a double click asks once');
  assert.match(del, /try \{ await MB\.cloud\.deleteRemote\(link\.accountId, link\.fileId\); \}\s*catch \(err\) \{[\s\S]*?Nothing was deleted\.[\s\S]*?return;\s*\}\s*await P\.remove\(id\);/,
    'a failed cloud delete returns before anything here is deleted');
  // another tab editing it: refused before anything is deleted
  assert.ok(del.indexOf('if (await P.openElsewhere(id)) {') >= 0 && del.indexOf('if (await P.openElsewhere(id)) {') < del.indexOf('MB.cloud.deleteRemote('));
  assert.match(del, /cloud\.changed \? ' The cloud version has changes that are not on this device\.' : ''/);
  assert.match(del, /querySelectorAll\('button'\)\.forEach\(x => \{ x\.disabled = true; \}\)/, 'Cancel too, while it goes');
  assert.match(del, /Sign in to ' \+ p\.name \+ ' \(Cloud sync\), or turn its sync off there, to delete it from this device only\./);
  assert.ok(!/P\.openDialog\(\)/.test(del), 'a closed dialog is not reopened when the delete finishes');
  assert.match(ps, /const refresh = \(\) => \{ if \(!dlg\.classList\.contains\('hidden'\)\) P\.openDialog\(\); \};/);
  assert.match(ps, /MB\.iconBtn\('trash', 'Delete everywhere \(this device and ' \+ syncedTo\(r\) \+ '\)'/, 'its bin says it deletes it everywhere');
  assert.match(del, /'Delete it and its earlier copies\?', 'Delete'/, 'a project that does not sync: this device only, as before');
});

test('the Cast to a screen icon is the standard cast glyph: arcs ending on the screen\'s bottom line, not below it', () => {
  const OLD = 'M2 16a6 6 0 0 1 6 6M2 20a2 2 0 0 1 2 2M2 12a10 10 0 0 1 10 10';
  for (const [f, src] of [['index.html', html], ['css/app.css', css], ...Object.entries(js).map(([f, s]) => ['js/' + f, s])]) {
    assert.ok(!src.includes(OLD), f + ' still draws the old cast glyph');
  }
  const item = (html.match(/<button data-act="cast">([\s\S]*?)<\/button>/) || [])[1] || '';
  assert.ok(item.includes('<path d="M2 8V6a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-6"/><path d="M2 12a9 9 0 0 1 8 8"/>' +
    '<path d="M2 16a5 5 0 0 1 4 4"/><path d="M2 20h.01"/>'), 'the menu\'s cast item uses the new glyph');
});

test('Recent projects reads the link again when the delete is confirmed, and never claims more than it did', () => {
  const ps = js['projectstore.js'];
  const del = ps.split("box.querySelectorAll('[data-del]')")[1].split("box.querySelectorAll('[data-restore]')")[0];
  // the question is asked with the link read on the click; the delete uses the link as it is on the confirm
  // (its sync may have been turned off, or its account changed, in between)
  const reread = del.indexOf('const link = MB.cloud && MB.cloud.linkOf ? await MB.cloud.linkOf(id) : null;');
  assert.ok(reread > 0, 'the link is read again inside the confirm');
  assert.ok(reread < del.indexOf('MB.cloud.deleteRemote('), 'before the cloud delete');
  // no link left: a delete from this device only — and it says so, the button having said "everywhere"
  assert.match(del, /if \(!link\) \{ await P\.remove\(id\); MB\.toast\('Deleted "' \+ name \+ '" from this device\. It no longer syncs, so nothing was deleted in the cloud\.', 6000\); refresh\(\); return; \}/);
  assert.match(del, /const p = \(MB\.cloudProviders \|\| \{\}\)\[link\.provider\] \|\| prov;/, 'and the provider named is that link\'s');
  // P.remove swallows what it cannot delete: checked, rather than saying it is gone from here
  assert.match(del, /await P\.remove\(id\);\s*\/\/[^\n]*\n\s*if \(await P\.get\(id\)\) \{ MB\.toast\('Deleted "' \+ name \+ '" from ' \+ p\.name \+ '; could not delete it from this device\.', 9000\); refresh\(\); return; \}/);
  assert.match(js['projectstore.js'], /P\.get = id =>/, 'P.get is what it checks with');
  // a network failure while this device is online: it may well have been deleted
  assert.match(del, /err\.code === 'network' \? \(navigator\.onLine === false\s*\?[^\n]*Nothing was deleted\. Connect[^\n]*\n\s*: 'the connection failed\. It may not have been deleted: try again\.'\)/);
});

test('a question can be closed without answering it: the ✕, Escape, the backdrop and back then answer neither', () => {
  const u = js['util.js'];
  assert.match(u, /const away = opts && opts\.dismiss \? null : false;/);
  assert.match(u, /if \(e\.key === 'Escape'\) \{ e\.preventDefault\(\); finish\(away\); \}/, 'Escape');
  assert.ok(u.includes("xBtn.addEventListener('click', () => finish(away));"), 'the ✕ (which Android\'s back clicks)');
  assert.ok(u.includes("if (opts && opts.dismiss) dlg.addEventListener('click', e => { if (e.target === dlg) finish(null); });"), 'the backdrop');
  assert.ok(u.includes("noBtn.addEventListener('click', () => finish(false));"), 'Cancel still answers no');
  // the question that needs it: opening a cloud project that is on this device too (either answer opens something)
  const cs = js['cloudsync.js'];
  assert.ok(cs.includes("'Keep this device\\'s copy', { dismiss: true });"));
  assert.match(cs, /if \(cloud === null\) return false;/, 'closed: nothing opens');
  assert.match(cs, /if \(await MB\.projects\.openElsewhere\(mine\.id\)\) \{ MB\.toast\('This map is open in another tab\. Open it there\.', 5000\); return false; \}/,
    'nor over a copy another tab is editing');
});

test('a long name in a question or in a toast wraps instead of running off the screen', () => {
  const plain = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = sel => [...plain.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(m => m[1].split(',').some(s => s.trim() === sel)).map(m => m[2]);
  for (const sel of ['.mb-ask .ask-text', '#mb-toast']) {
    const r = rules(sel);
    assert.ok(r.length, sel + ' found');
    assert.ok(r.some(b => /overflow-wrap: anywhere;/.test(b)), sel + ': overflow-wrap: anywhere');
  }
});

test('a project id or an account id a cloud dialog puts into a selector is escaped (a quote in one must not throw)', () => {
  const bad = [];
  for (const f of ['cloudui.js', 'cloudsync.js', 'projectstore.js']) {
    for (const m of js[f].matchAll(/querySelector(All)?\(`[^`]*="\$\{([^}]*)\}"/g)) if (!/CSS\.escape/.test(m[2])) bad.push('js/' + f + ': ' + m[0]);
  }
  assert.deepEqual(bad, []);
});

test('the privacy policy says what cloud sync deletes, where a deleted file goes, and how a phone keeps a sign-in', () => {
  const privacy = read('privacy.html');
  assert.doesNotMatch(privacy, /never deletes/i, 'GenGIS does delete a file when the user asks it to (Cloud sync, Recent projects)');
  assert.match(privacy, /deletes a project file only when you ask it to/);
  assert.match(privacy, /<b>Cloud sync<\/b>/);
  assert.match(privacy, /Delete everywhere/);
  assert.match(privacy, /OneDrive's recycle bin or Google Drive's trash/, 'where the file goes, and that it can be restored');
  assert.match(privacy, /Disconnecting deletes nothing\./);
  assert.match(privacy, /moves the project files from the second folder into the first/, 'the folder merge is still described');
  assert.match(privacy, /lists that one folder: so it can show the projects from your other devices and let you open any of them/);
  assert.doesNotMatch(privacy, /Your files stay in your cloud storage until you delete them there\./);
  assert.match(privacy, /until you delete them there, or until you have GenGIS delete one for you/);
  // the Android app: the OneDrive token encrypted with a key in the Keystore, Google Drive through the phone's account
  assert.match(privacy, /In the Android app[^.]*Android Keystore, which never leaves the phone/);
  assert.match(privacy, /the phone's own Google account keeps the sign-in/);
});

test('the attribute table keeps the keyboard: focus is given back after it is drawn anew, never dropped on the page body', () => {
  const at = js['attrtable.js'];
  // what had focus is noted before the head and the body are written anew, and given back after
  assert.match(at, /const ad = T\.ad, d = T\.dlg, mark = focusMark\(\);/, 'paint() notes it');
  assert.match(at, /refocus\(mark\);\s*\r?\n\s*\}/, 'and gives it back once the table is drawn');
  // a column's button or box by its index, a cell by its row and column
  assert.match(at, /const c = at\.dataset\.c, a = \['data-sort', 'data-rename', 'data-col'\]\.find\(x => at\.hasAttribute\(x\)\);/);
  assert.match(at, /if \(a\) return `#attrHead \[\$\{a\}\]\[data-c="\$\{c\}"\]`;/);
  assert.match(at, /return tr && tr\.dataset\.i != null \? `#attrBody tr\[data-i="\$\{tr\.dataset\.i\}"\] \[data-c="\$\{c\}"\]` : null;/);
  // gone (a field deleted, a row no longer in the page): the dialog's ✕; and focus still inside is left alone
  assert.match(at, /const el = T\.dlg\.querySelector\(mark\) \|\| T\.dlg\.querySelector\('\.modal-x'\);/);
  assert.match(at, /if \(insideDialog\(\)\) return;/, 'focus still inside is left alone');
  assert.match(at, /return !!\(at && at !== document\.body && T\.dlg && T\.dlg\.contains\(at\)\);/, 'the page body is not inside');
  assert.match(at, /if \(!mark \|\| T\.dlg\.classList\.contains\('hidden'\)\) return;/, 'and nothing is taken while it is closed (it is drawn before it opens)');
  // Enter on the last row: the value is kept and focus stays on the cell (it used to blur, dropping focus to the body)
  assert.doesNotMatch(at, /if \(next\) next\.focus\(\); else inp\.blur\(\);/, 'the cell is no longer blurred');
  assert.match(at, /if \(next\) next\.focus\(\);\s*\r?\n\s*else commitCell\(inp\);/);
  // a rename: its box is gone with the redraw, so that column's sort button takes the focus (unless focus went to
  // another of the dialog's own controls)
  assert.match(at, /const keep = rt && d\.contains\(rt\) && !head\.contains\(rt\) && !body\.contains\(rt\);/);
  assert.match(at, /build\(\);\s*\r?\n\s*if \(!keep\) focusColumn\(why \? from : to\);/);
  assert.match(at, /const el = \(c >= 0 && T\.dlg\.querySelector\(`#attrHead \[data-sort\]\[data-c="\$\{c\}"\]`\)\) \|\| T\.dlg\.querySelector\('\.modal-x'\);/);
  // the page buttons: the one pressed is disabled on the first or last page, so focus goes to the other one (or to
  // the first cell), never to the page body
  assert.match(at, /if \(b\.disabled && \(document\.activeElement === b \|\| !insideDialog\(\)\)\) \{/);
  assert.match(at, /const other = d\.querySelector\(`\.attr-foot \[data-at="\$\{b\.dataset\.at === 'next' \? 'prev' : 'next'\}"\]`\);/);
  assert.match(at, /const el = \(other && !other\.disabled && !other\.hidden && other\) \|\| d\.querySelector\('#attrBody \[data-c\]'\) \|\| d\.querySelector\('\.modal-x'\);/);
  assert.ok(at.indexOf('if (b.disabled && (document.activeElement === b') > at.indexOf("d.querySelector('#attrScroll').scrollTop = 0;"), 'after the page is drawn anew');
  // a box visited and left unchanged is no edit (Enter commits, and the change event that follows must not add a second undo step)
  assert.match(at, /const same = v === was \|\| \(\(v == null \|\| v === ''\) && \(was == null \|\| was === ''\)\);\s*\r?\n\s*if \(!same\) T\.ad\.set\(row, k, v\);/);
});

test('the attribute table counts the fields it shows, sorts with one collator, and keeps the keyboard after a column menu sort', () => {
  const at = js['attrtable.js'];
  // the fixed "Object name" column is no field: "1 field", not "1 fields"
  assert.match(at, /const nFields = fields\.length - fields\.filter\(f => f\.fixed\)\.length;/);
  assert.match(at, /\$\{nFields\} field\$\{nFields === 1 \? '' : 's'\}/, 'the plural follows the count shown');
  // one collator for a whole sort (a new one per comparison took 20 s for 250,000 rows), each value read once
  assert.match(at, /const COLLATOR = new Intl\.Collator\(undefined, \{ numeric: true, sensitivity: 'base' \}\);/);
  assert.doesNotMatch(at, /localeCompare/, 'nothing builds a collator inside the comparator');
  assert.match(at, /const rows = list\.map\(r => \{ const v = ad\.get\(r, key\)/, 'the values are read before the sort, not in it');
  // the menu is gone when its action runs, and focus with it: that column's sort button takes it (the page body
  // behind the dialog must not have it)
  assert.ok(at.includes("T.sort = key; T.dir = 1; build(); if (!insideDialog()) focusColumn(key);"), 'sort ascending');
  assert.ok(at.includes("T.sort = key; T.dir = -1; build(); if (!insideDialog()) focusColumn(key);"), 'sort descending');
});

test('a redraw never swallows the click that follows a press: Properties waits for the pointer to be released', () => {
  // one helper for the page, in util.js (the imported values in Properties used to keep their own), listening from
  // the moment it loads: a press that has already begun when the first redraw is asked for must be seen
  assert.match(js['util.js'], /if \(typeof document !== 'undefined' && document\.addEventListener\) hookPress\(\);/);
  assert.match(js['util.js'], /MB\.whenReleased = function \(fn\) \{\s*\r?\n\s*if \(press\.down\) press\.waiting\.push\(fn\); else setTimeout\(fn\);/);
  assert.doesNotMatch(js['util.js'], /MB\.whenReleased = function \(fn\) \{\s*\r?\n\s*hookPress\(\);/, 'not hooked on first use');
  assert.match(js['fileimports.js'], /const whenReleased = fn => MB\.whenReleased\(fn\);/);
  assert.doesNotMatch(js['fileimports.js'], /const press = \{ down: false/, 'and no press state of its own there');
  // a field renamed in Properties draws it anew (the attribute table's commit): after the release, so a click on
  // another row's trash button is not lost
  const ui = js['ui.js'], af = ui.slice(ui.indexOf('function attrForm(f)'), ui.indexOf('function bindNameTip(f)'));
  assert.match(af, /MB\.whenReleased\(\(\) => \{[\s\S]{0,200}const why = table\(\)\.renameField\(from, to\);/);
  // and the keyboard is only put back in a value box when that click left it in the attributes, or nowhere, and the
  // same object is still the one shown (never stolen from a tool, a Layers control or another object)
  assert.match(af, /const was = document\.activeElement, here = !was \|\| was === document\.body \|\| wrap\.contains\(was\);/);
  assert.match(af, /if \(MB\.selected === f && \(here \|\| !at \|\| at === document\.body\)\) focusRow\('\[data-av\]', to\);/);
  // a rename that waited while its own field was removed is dropped, undo step and all
  assert.match(js['attrtable.js'], /if \(!fields\.includes\(from\)\) return '';/);
});

test('an imported layer\'s last edit is written when the page is hidden or closed, as the project\'s is', () => {
  const imp = js['fileimports.js'];
  assert.match(imp, /win\.addEventListener\('pagehide', \(\) => MB\.imports\.flushSaves\(\)\);/);
  assert.match(imp, /doc\.addEventListener\('visibilitychange', \(\) => \{ if \(doc\.visibilityState === 'hidden'\) MB\.imports\.flushSaves\(\); \}\);/);
  assert.match(imp, /async init\(\) \{\s*\r?\n\s*hookSaves\(\);/, 'hooked as the imports start');
  assert.match(imp, /flushSaves\(\) \{ layers\.forEach\(rec => \{ if \(rec\.saveTimer \|\| rec\.fcDirty\) this\.saveNow\(rec\); \}\); \}/);
  // a write that fails leaves the features to be written again, and says so where the panel shows it - once, not
  // once per hide
  assert.match(imp, /rec\.fcDirty = true;\s*\r?\n\s*if \(rec\.saveFailed\) return;[^\n]*\r?\n\s*rec\.saveFailed = true;\s*\r?\n\s*this\.note\(rec\.meta\.name \+ ': a change could not be kept/);
  assert.match(imp, /\.then\(\(\) => \{ rec\.saveFailed = false; \}/, 'and a write that goes through clears it');
  assert.match(imp, /this\.changed\(\);\s*\r?\n\s*\}\);\s*\r?\n\s*\}\s*\r?\n\s*\},/, 'and the panel is drawn anew, so the note shows');
  // the project does the same (js/app.js)
  assert.match(js['app.js'], /window\.addEventListener\('pagehide', \(\) => MB\.saveNow\(\)\);/);
});

test('a field named "__proto__" is copied as a field of its own, never through Object.assign or a plain set', () => {
  const imp = js['fileimports.js'];
  assert.match(imp, /const copyOwn = o => Object\.fromEntries\(Object\.entries\(o \|\| \{\}\)\);/);
  assert.ok(imp.includes('properties: i ? copyOwn(props) : props'), 'the parts of one record');
  assert.ok(imp.includes('props = copyOwn(f.properties)'), 'and the layer written out as GeoJSON');
  assert.match(js['geometry.js'], /Object\.keys\(attrs\)\.forEach\(k => Object\.defineProperty\(a, k, \{ value: attrs\[k\], writable: true, enumerable: true, configurable: true \}\)\);/, 'objects joined');
  assert.doesNotMatch(js['geometry.js'], /Object\.assign\(\{\}, \.\.\.layers/);
  assert.match(js['storage.js'], /const put = \(o, k, v\) => Object\.defineProperty\(o, k, \{ value: v, writable: true, enumerable: true, configurable: true \}\);/, 'the GeoJSON export and import');
});

test('the attribute table\'s page button rescues the keyboard in Chromium too, where the disabled button is still the active element', () => {
  const cond = (/if \(b\.disabled && (\(.+?\))\) \{/.exec(js['attrtable.js']) || [])[1];
  assert.ok(cond, 'the rescue\'s condition found');
  const rescued = new Function('b', 'document', 'insideDialog', 'return !!(b.disabled && ' + cond + ');'); // the real condition, on fakes
  const btn = { disabled: true }, cell = {}, body = {};
  // Chromium (Electron and the Android WebView too): just after the button is disabled it is still the active
  // element, and the focus is about to fall to the page body — the rescue has to run
  assert.equal(rescued(btn, { activeElement: btn }, () => true), true, 'focus still on the disabled button');
  assert.equal(rescued(btn, { activeElement: body }, () => false), true, 'focus already dropped to the page body');
  assert.equal(rescued(btn, { activeElement: cell }, () => true), false, 'focus moved elsewhere in the dialog: left alone');
  assert.equal(rescued({ disabled: false }, { activeElement: body }, () => false), false, 'another page to go to: nothing to rescue');
});

test('with a dialog up, the app\'s own keys do nothing on the map behind it (Delete, f, Ctrl+Z…)', () => {
  const ui = js['ui.js'];
  const keys = ui.slice(ui.indexOf('function initKeys()'), ui.indexOf('/* ================= init ================= */'));
  assert.ok(keys, 'initKeys found');
  assert.match(keys, /const covered = \(\) => !!\(\(MB\.presenter && MB\.presenter\.active\) \|\| \$\$\('\.modal:not\(\.hidden\)'\)\.some\(m => m\.getClientRects\(\)\.length\)\);/);
  // Escape first (it closes what is up), then nothing else while something covers the map
  const esc = keys.indexOf("if (e.key === 'Escape') {"), gate = keys.indexOf('if (covered()) return;');
  assert.ok(esc > 0 && gate > esc, 'Escape is handled before the gate');
  for (const after of ["=== 'z'", "=== 'y'", "=== 's'", "=== 'd'", "e.key === 'Delete'", "e.key === '/'", 'MB.presenter.enter()', 'MB.icons.open()', 'MB.tools.set(tool)']) {
    assert.ok(keys.indexOf(after) > gate, 'behind the gate: ' + after);
  }
  // Escape with a dialog up and focus outside it (on <body>, a list drawn anew): the top-most dialog closes, as its
  // own ✕ does, and none of the map chain runs (the tool, the selection, the search marker)
  assert.match(keys, /if \(covered\(\)\) \{ e\.preventDefault\(\); const top = \$\$\('\.modal:not\(\.hidden\)'\)\.filter\(m => m\.getClientRects\(\)\.length\)\.pop\(\), x = top && top\.querySelector\('\.modal-x'\); if \(x\) x\.click\(\); return; \}/);
  const close = keys.indexOf('if (covered()) { e.preventDefault();');
  assert.ok(close > esc && close < keys.indexOf('MB.measure.cancel()'), 'in the Escape branch, before the map chain');
  assert.ok(keys.indexOf('MB.presenter.exit()') < close, 'presenter mode still has its own Escape');
  assert.ok(keys.indexOf('if (typing) { t.blur(); return; }') < close, 'a box being typed in is blurred first');
  assert.ok(keys.indexOf('if (typing) return;') < gate, 'typing in a box is still answered first');
  // Recent projects listens for Escape on the document itself: it closes only while it is the one on top and only
  // when nothing answered the press already (the branch above marks it), so one press never closes two dialogs
  const ps = js['projectstore.js'];
  assert.match(ps, /if \(e\.key !== 'Escape' \|\| e\.defaultPrevented \|\| dlg\.classList\.contains\('hidden'\)\) return;/);
  assert.match(ps, /const shown = Array\.from\(document\.querySelectorAll\('\.modal:not\(\.hidden\)'\)\)\.filter\(m => m\.getClientRects\(\)\.length\);\s*\r?\n\s*if \(shown\[shown\.length - 1\] === dlg\) dlg\.classList\.add\('hidden'\);/);
  assert.doesNotMatch(ps, /if \(e\.key === 'Escape'\) dlg\.classList\.add\('hidden'\);/, 'no longer closed from under another dialog');
  assert.ok(!/if \(MB\.presenter && MB\.presenter\.active\) return;/.test(keys.slice(gate)), 'the presenter check is the gate\'s own');
  // the desktop app's Ctrl+F uses the same reading
  assert.match(keys, /if \(!covered\(\)\) MB\.ui\.focusSearch\(\);/);
});

test('the track-log bar sits above whatever the map\'s bottom corners hold, and above the phone\'s gesture bar', () => {
  const plain = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = sel => [...plain.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(m => m[1].split(',').some(s => s.trim() === sel)).map(m => m[2]);
  const bar = rules('.trk-bar');
  assert.equal(bar.length, 2, 'the bar: the base rule and the phone one');
  assert.ok(bar.every(b => /bottom: calc\(var\(--dock-h, \d+px\) \+ \d+px \+ var\(--trk-inset, 0px\)\);/.test(b)),
    'lifted by what the corners cover, with a sensible floor until that is measured, and the Android inset on top');
  assert.equal(rules('#mapwrap.clock-on .trk-bar').length, 0, 'no guess at the clock\'s height any more: the corner itself is measured');
  // measured in ui.js: the taller corner the bar crosses, written only when it changes (an observer watches the corners)
  const ui = js['ui.js'];
  assert.match(ui, /function dockHeight\(\) \{/, 'ui.js measures the corners');
  assert.match(ui, /const bar = \$\('\.trk-bar', wrap\), br = bar && !bar\.hidden \? bar\.getBoundingClientRect\(\) : null;/, 'the bar\'s own span, while it shows');
  assert.match(ui, /if \(wrap\.style\.getPropertyValue\('--dock-h'\) !== px\) wrap\.style\.setProperty\('--dock-h', px\);/, 'only on a change: no observer loop');
  // the toolbar docking moves a corner sideways without resizing it, so the clearance is read again after it fits
  assert.match(ui, /function fitAll\(\) \{ fitDock\(\); fitToolbar\(\); dockHeight\(\); \}/, 'measured last in a fit pass');
  assert.ok(ui.indexOf('function dockHeight()') < ui.indexOf('function fitDock()'), 'a measurement of its own, so the pass can repeat it without the rest');
  // the bar showing or hiding resizes nothing the observer watches: it asks for the room itself
  assert.match(js['tracklogs.js'], /if \(was !== el\.hidden && MB\.ui && MB\.ui\.fitDock\) MB\.ui\.fitDock\(\);/);
  // the clock still says it is showing, and has the room measured again as it comes and goes
  const clock = js['clock.js'];
  assert.match(clock, /const on = !!\(cfg\.show && MB\.map\);/);
  assert.match(clock, /if \(wrap\) wrap\.classList\.toggle\('clock-on', on\);/);
  assert.ok(clock.indexOf("classList.toggle('clock-on'") < clock.indexOf('if (!on) {'), 'set before it returns for a clock that is off');
  assert.equal((clock.match(/if \(MB\.ui && MB\.ui\.fitDock\) MB\.ui\.fitDock\(\);/g) || []).length, 2, 'turned on and turned off alike');
  // the bar lives in #mapwrap, where the variable is
  assert.match(js['tracklogs.js'], /const host = document\.getElementById\('mapwrap'\) \|\| MB\.map\.getContainer\(\);/);
});

test('the map\'s bottom corners stack their readouts in a column, in a set order, each no wider than its column', () => {
  const plain = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = sel => [...plain.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(m => m[1].split(',').some(s => s.trim() === sel)).map(m => m[2]);
  const one = sel => { const r = rules(sel); assert.ok(r.length, sel + ' found'); return r; };
  const left = one('.leaflet-bottom.leaflet-left'), right = one('.leaflet-bottom.leaflet-right');
  assert.ok(left.some(b => /display: flex;/.test(b) && /flex-direction: column;/.test(b) && /align-items: flex-start;/.test(b)), 'the left corner: a column');
  assert.ok(right.some(b => /display: flex;/.test(b) && /flex-direction: column;/.test(b) && /align-items: flex-end;/.test(b)), 'the right corner: a column');
  assert.ok(one('.leaflet-bottom .leaflet-control').some(b => /max-width: 100%;/.test(b) && /box-sizing: border-box;/.test(b)), 'nothing wider than its column');
  // every readout down there has its place, so what shows never depends on the order the controls happened to be added in
  const order = sel => {
    const m = one(sel).map(b => /(?:^|;)\s*order: (\d+);/.exec(b)).filter(Boolean)[0];
    assert.ok(m, sel + ': an order in the column');
    return +m[1];
  };
  const hint = order('.mb-zoom-hint'), legend = order('.mb-alt-legend'), clk = order('.mb-clock');
  const status = order('.mb-status'), attr = order('.leaflet-control-attribution'), scale = order('.mb-scale');
  assert.ok(hint < legend && legend < clk && clk < status && status < attr,
    'top to bottom: the zoom hint, the altitude legend, the clock, the coordinates, the credits at the foot');
  assert.ok(legend < scale, 'the scale bar at the foot of its own column');
  // the credits are cut with an ellipsis at every width (a phone is not the only narrow map), never sized by the window
  const noMedia = plain.replace(/@media[^{]*\{(?:[^{}]*\{[^{}]*\}\s*)*\}/g, '');
  assert.match(noMedia, /\.leaflet-control-attribution \{[^}]*text-overflow: ellipsis;/, 'the ellipsis outside any media query');
  assert.ok(rules('.leaflet-control-attribution').every(b => !/\d+vw/.test(b)), 'the credits are capped by their column, not by the window');
  assert.ok(one('.mb-alt-legend').every(b => !/100vw/.test(b)), 'and so is the altitude legend');
  assert.ok(one('.mb-busy .txt').some(b => /text-overflow: ellipsis;/.test(b)), 'a long list of what is loading is cut, not widening the coordinates');
  // a narrow map: the left column has the width to itself, and what shares the scale bar's row stops short of it
  assert.ok(rules('#mapwrap.narrow .leaflet-bottom.leaflet-left').some(b => /--dock-reserve: 0px;/.test(b)));
  assert.ok(left.some(b => /right: var\(--dock-reserve, \d+px\);/.test(b)), 'otherwise it stops short of the right column');
  // (a :is() list, so read from the stylesheet itself: the helper above splits a selector list on its commas)
  assert.match(plain, /#mapwrap\.narrow :is\(\.leaflet-control-attribution, \.mb-status\) \{[^}]*max-width: calc\(100% - var\(--scale-room, 144px\)\);/,
    'the credits and the coordinates leave the scale bar its room');
  assert.ok(rules('#mapwrap.narrow .leaflet-bottom.leaflet-left').some(b => /--scale-room: 144px;/.test(b)), 'that room is the column\'s own variable');
  // the toolbar docked on the right moves the scale bar in by the strip's width: the cap follows it
  assert.ok(rules('#mapwrap.narrow.tb-right.tb-docked .leaflet-bottom.leaflet-left').some(b => /--scale-room: calc\(144px \+ var\(--tb-w, 52px\)\);/.test(b)),
    'a strip docked on the right: that much more room kept for the scale bar');
  // presenting hides the coordinates, so the legend, the hint and the clock drop into that row: they are capped too
  assert.match(css, /body\.presenting [^{]*\.mb-status[^{]*\{ display: none !important; \}/, 'presenting hides the coordinates');
  assert.match(plain, /body\.presenting #mapwrap\.narrow :is\(\.mb-alt-legend, \.mb-zoom-hint, \.mb-clock\) \{[^}]*max-width: calc\(100% - var\(--scale-room, 144px\)\);/,
    'presenting on a narrow map: the legend, the hint and the clock leave the scale bar its room as well');
  assert.match(plain, /#mapwrap\.narrow :is\(\.mb-alt-legend, \.mb-zoom-hint\) \{[^}]*margin: 0 0 6px 8px !important;/,
    'the legend and the hint move to the left edge with it');
  // in the Android app that full-width column keeps clear of a bar or cutout at the right as well
  assert.ok(rules('html.native-app #mapwrap.narrow .leaflet-bottom.leaflet-left').some(b => /margin-right: env\(safe-area-inset-right, 0px\);/.test(b)));
});

test('a narrow map docks the altitude legend and the zoom hint in its left column, with a shorter scale bar', () => {
  const ui = js['ui.js'];
  assert.match(ui, /const NARROW_MAP = 560;/, 'the map\'s own width, not the window\'s');
  assert.match(ui, /const narrow = wrap\.clientWidth < NARROW_MAP;/);
  const fit = ui.slice(ui.indexOf('function fitDock()'), ui.indexOf('MB.ui.fitDock = fitDock;'));
  assert.match(fit, /if \(narrow !== wrap\.classList\.contains\('narrow'\)\) \{[\s\S]*?wrap\.classList\.toggle\('narrow', narrow\);/, 'the class is written only when it changes');
  assert.match(fit, /if \(MB\.adsb && MB\.adsb\.dock\) MB\.adsb\.dock\(narrow\);/, 'the overlays move corner with it');
  assert.match(fit, /const maxWidth = narrow \? 120 : 200;/, 'a shorter scale bar fits beside the coordinates');
  assert.match(fit, /if \(MB\.scaleControl && MB\.scaleControl\.options\.maxWidth !== maxWidth\) \{ MB\.scaleControl\.options\.maxWidth = maxWidth; MB\.scaleControl\.update\(\); \}/,
    'set whenever it differs: the bar may be built after the width was last read');
  // the controls are kept, so each keeps its element as it moves, and is moved only when the corner differs
  const adsb = js['adsb.js'];
  assert.match(adsb, /MB\.liveZoomHintCtl = new Hint\(\{ position: dockPos\(\) \}\)\.addTo\(MB\.map\)/, 'the hint control is kept');
  assert.match(adsb, /this\.legendCtl = new Legend\(\{ position: dockPos\(\) \}\)\.addTo\(MB\.map\)/, 'and the legend control');
  assert.match(adsb, /dock\(narrow\) \{\s*\r?\n\s*const pos = narrow \? 'bottomleft' : 'bottomright';/);
  assert.match(adsb, /if \(ctl && ctl\.getPosition && ctl\.getPosition\(\) !== pos\) ctl\.setPosition\(pos\);/);
  assert.match(adsb, /return wrap && wrap\.classList\.contains\('narrow'\) \? 'bottomleft' : 'bottomright';/, 'one made later starts in the corner in use');
  // measured with the map's size and with the corners' own, and once the map is built
  assert.match(ui, /const fitSoon = \(\) => \{ if \(pending\) return; pending = requestAnimationFrame\(\(\) => \{ pending = 0; fitAll\(\); \}\); \};\s*\r?\n\s*const ro = new ResizeObserver\(fitSoon\);/,
    'one pass per frame: a fit that resizes a corner cannot set the observer off in the middle of it');
  assert.match(ui, /BOTTOM_CORNERS\.forEach\(sel => \{ const c = \$\(sel, \$\('#mapwrap'\)\); if \(c\) ro\.observe\(c\); \}\);/, 'the corners too: a legend or the clock appearing changes what they cover');
  assert.match(ui, /\} else addEventListener\('resize', fitAll\);/, 'no ResizeObserver: the window\'s size at least');
  assert.match(ui, /MB\.ui\.setupScale\(\);\s*\r?\n\s*fitAll\(\);/, 'and once at startup, after the scale bar is there');
  // the toolbar shrinks to fit above the corner on its own side, whichever side it is on
  assert.match(ui, /const corner = \$\('\.leaflet-bottom\.leaflet-' \+ \(wrap\.classList\.contains\('tb-right'\) \? 'right' : 'left'\), wrap\);/);
  assert.match(ui, /const below = Math\.max\(CORNER_ROOM, corner \? corner\.offsetHeight \+ 12 : 0\);/);
  assert.ok(js['ui.js'].indexOf("classList.remove('docked')") < js['ui.js'].indexOf('const corner = $('), 'measured undocked, so a re-fit settles');
});

test('the README says what a dropped file becomes: a layer for KML, KMZ, shapefiles and zips, project objects for GeoJSON', () => {
  const readme = read('README.md');
  const line = readme.split('\n').find(l => l.startsWith('- **Your own files**'));
  assert.ok(line, 'the "Your own files" bullet');
  assert.match(line, /dropping KML, KMZ, shapefiles and zips on the map/);
  assert.match(line, /a dropped `\.geojson` opens as objects of the project instead/);
  // which is what the page does: only those extensions go to the imports
  assert.match(js['fileimports.js'], /isImportFile: f => \['kml', 'kmz', 'shp', 'dbf', 'prj', 'cpg', 'shx'\]\.includes\(extOf\(f\.name\)\)/);
});
