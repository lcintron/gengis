'use strict';
// gengis:// links in the desktop app (electron/links.js): what a link may ask for, and finding one on a command line.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = process.env.GENGIS_ROOT || path.join(__dirname, '..');
const links = require(path.join(ROOT, 'electron', 'links.js'));

test('a link gives the same parameters as the web app\'s address', () => {
  assert.deepEqual(links.params('gengis://open?q=Eiffel%20Tower'), { q: 'Eiffel Tower' });
  assert.deepEqual(links.params('gengis://open?center=48.858,2.294&zoom=16'), { center: '48.858,2.294', zoom: '16' });
  assert.deepEqual(links.params('gengis://open?lat=48.858&lon=2.294&z=12&poi=cafe'), { lat: '48.858', lon: '2.294', z: '12', poi: 'cafe' });
  assert.deepEqual(links.params('GENGIS://open/?q=x'), { q: 'x' }, 'the scheme in any case, a trailing slash');
  assert.deepEqual(links.params('gengis:open?q=x'), { q: 'x' });
});

test('a project file path survives the link (Windows and POSIX, spaces and non-ASCII)', () => {
  assert.equal(links.params('gengis://open?file=C:\\Maps\\Trip.gengis.json').file, 'C:\\Maps\\Trip.gengis.json');
  assert.equal(links.params('gengis://open?file=' + encodeURIComponent('C:\\Mis mapas\\Viaje ñ 地图.gengis.json')).file, 'C:\\Mis mapas\\Viaje ñ 地图.gengis.json');
  assert.equal(links.params('gengis://open?file=%2Fhome%2Fu%2FTrip.gengis.json').file, '/home/u/Trip.gengis.json');
});

test('anything else in a link is ignored; other schemes and junk are not links', () => {
  assert.deepEqual(links.params('gengis://open?q=x&code=abc&state=s&__proto__=1&constructor=2'), { q: 'x' });
  assert.deepEqual(links.params('gengis://open?q=' + 'a'.repeat(5000)), {}, 'an overlong value is dropped');
  assert.deepEqual(links.params('gengis://open?q='), {}, 'empty values are dropped');
  assert.equal(links.params('https://g2.luiscintron.com/?q=x'), null);
  assert.equal(links.params('file:///C:/x?q=x'), null);
  assert.equal(links.params('not a url'), null);
  assert.equal(links.params(null), null);
});

test('the link among command-line arguments (Windows and Linux hand it over that way)', () => {
  assert.equal(links.inArgs(['--allow-file-access-from-files', 'gengis://open?q=x']), 'gengis://open?q=x');
  assert.equal(links.inArgs(['C:\\GenGIS\\GenGIS.exe', '--original-process-start-time=1', 'GenGIS://open?q=y']), 'GenGIS://open?q=y');
  assert.equal(links.inArgs(['--q=Paris']), null);
  assert.equal(links.inArgs(undefined), null);
});

test('the scheme is registered by every installer, and the app handles it', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.ok(pkg.build.protocols.some(p => p.schemes.includes(links.SCHEME)), 'macOS and Linux (electron-builder)');
  const nsh = fs.readFileSync(path.join(ROOT, pkg.build.nsis.include), 'utf8');
  assert.match(nsh, /customInstall[\s\S]*Software\\Classes\\gengis\\shell\\open\\command/, 'Windows installer writes the handler');
  assert.match(nsh, /customUnInstall[\s\S]*DeleteRegKey SHELL_CONTEXT "Software\\Classes\\gengis"/, '...and removes it');
  const main = fs.readFileSync(path.join(ROOT, 'electron', 'main.js'), 'utf8');
  assert.match(main, /requestSingleInstanceLock/);
  assert.match(main, /'second-instance'/);
  assert.match(main, /'open-url'/);
  assert.match(fs.readFileSync(path.join(ROOT, 'electron', 'preload.js'), 'utf8'), /onLink:.*'app:link'/);
  assert.match(fs.readFileSync(path.join(ROOT, 'js', 'app.js'), 'utf8'), /gengisDesktop\.onLink\(q => MB\.applyUrlParams\(q\)\)/);
});
