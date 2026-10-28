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
  assert.match(js['adsb.js'], /if \(src\.kind !== 'receiver' && this\.zoomedOut\(\)\) \{ this\.wait\(src\); return; \}/, 'no request below it');
  assert.match(js['ais.js'], /if \(!rt\.on \|\| s\.kind !== 'stream'\) return;/, 'only the stream waits');
  assert.match(js['ais.js'], /if \(this\.zoomedOut\(\)\) this\.wait\(src\); else this\.connect\(src\);/, 'the stream does not connect below it');
  assert.match(css, /\.mb-zoom-hint \{/, 'the map says to zoom in');
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
