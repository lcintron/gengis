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

test('a link to a project file: Windows and POSIX paths, encoded or not; .gengis and the older .gengis.json', () => {
  assert.deepEqual(links.target('gengis://C:/Maps/Trip.gengis'), { file: 'C:/Maps/Trip.gengis' });
  assert.deepEqual(links.target('gengis://C:\\Maps\\Trip.gengis.json'), { file: 'C:\\Maps\\Trip.gengis.json' });
  assert.deepEqual(links.target('gengis:///C:/Maps/Trip.gengis'), { file: 'C:/Maps/Trip.gengis' });
  assert.deepEqual(links.target('gengis:///home/me/Trip.gengis'), { file: '/home/me/Trip.gengis' });
  assert.deepEqual(links.target('gengis://' + encodeURIComponent('C:\\Mis mapas\\Viaje ñ.gengis')), { file: 'C:\\Mis mapas\\Viaje ñ.gengis' });
  assert.equal(links.target('gengis://\\\\server\\share\\Trip.gengis').refused, 'a network path', 'Windows would sign in to that server');
  assert.equal(links.target('gengis:////server/share/Trip.gengis').refused, 'a network path');
  assert.equal(links.target('gengis://' + encodeURIComponent('\\\\evil.example\\x\\Trip.gengis')).refused, 'a network path');
  assert.deepEqual(links.target('GENGIS://C:/Maps/Trip.GENGIS'), { file: 'C:/Maps/Trip.GENGIS' });
});

test('a link to a project on the web', () => {
  assert.deepEqual(links.target('gengis://https://example.com/maps/Trip.gengis'), { url: 'https://example.com/maps/Trip.gengis' });
  assert.deepEqual(links.target('gengis://' + encodeURIComponent('https://example.com/a b.gengis?x=1')), { url: 'https://example.com/a b.gengis?x=1' });
  assert.deepEqual(links.target('gengis://http://192.168.1.5:8080/Trip.gengis'), { url: 'http://192.168.1.5:8080/Trip.gengis' });
});

test('place links stay place links; anything else is refused, never read', () => {
  assert.deepEqual(links.target('gengis://open?q=Paris'), { params: { q: 'Paris' } });
  assert.deepEqual(links.target('gengis:?center=1,2'), { params: { center: '1,2' } });
  assert.deepEqual(links.target('gengis://open?file=C:\\Maps\\Trip.gengis'), { params: { file: 'C:\\Maps\\Trip.gengis' } }, 'the earlier form still works');
  assert.equal(links.target('gengis://C:/Windows/win.ini').refused, 'not a project file');
  assert.equal(links.target('gengis://C:/Users/me/.ssh/id_rsa').refused, 'not a project file');
  assert.equal(links.target('gengis://Trip.gengis').refused, 'not a path', 'a relative path');
  assert.equal(links.target('gengis://file:///C:/x.gengis').refused, 'not a path', 'no other schemes');
  assert.equal(links.target('gengis://javascript:alert(1)').refused, 'not a path');
  assert.equal(links.target('https://example.com/Trip.gengis'), null);
  assert.equal(links.target(''), null);
});

test('a project file on the command line (double-clicked, or "Open with" GenGIS)', () => {
  assert.equal(links.fileInArgs(['.', 'C:\\Maps\\Trip.gengis']), 'C:\\Maps\\Trip.gengis');
  assert.equal(links.fileInArgs(['--allow-file-access-from-files', '/home/me/Old.gengis.json']), '/home/me/Old.gengis.json');
  assert.equal(links.fileInArgs(['gengis://C:/Maps/Trip.gengis']), null, 'a link is not a file argument');
  assert.equal(links.fileInArgs(['--file=C:\\x.gengis', 'notes.txt', 'data.json']), null);
  assert.equal(links.fileInArgs(['gengis:C:/Maps/Trip.gengis']), null, 'nor one without slashes');
  assert.equal(links.fileInArgs(['\\\\server\\share\\Trip.gengis']), '\\\\server\\share\\Trip.gengis', 'a share the user double-clicked is theirs to open');
});

test('where a redirect from a project\'s web address may not lead: this computer or its network', () => {
  ['localhost', 'app.localhost', 'printer.local', '127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.5', '169.254.169.254', '100.64.0.1', '0.0.0.0', '[::1]', '::1', 'fe80::1', 'fd12:3456::1', '::ffff:127.0.0.1']
    .forEach(h => assert.equal(links.isLocalHost(h), true, h));
  ['example.com', 'fdroid.org', 'fcc.gov', 'raw.githubusercontent.com', '8.8.8.8', '172.32.0.1', '192.169.0.1', '2606:4700::1111']
    .forEach(h => assert.equal(links.isLocalHost(h), false, h));
});

test('.gengis is registered as GenGIS\'s file type, and project files open from the system and from links', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.ok(pkg.build.fileAssociations.some(a => a.ext === 'gengis' && a.mimeType), 'every installer (electron-builder)');
  const main = fs.readFileSync(path.join(ROOT, 'electron', 'main.js'), 'utf8');
  assert.match(main, /'open-file'/, 'macOS hands a file over by event');
  assert.match(main, /fileInArgs/, 'Windows and Linux on the command line');
  const files = fs.readFileSync(path.join(ROOT, 'electron', 'files.js'), 'utf8');
  assert.match(files, /handle\('files:open-path'/);
  assert.match(files, /handle\('files:fetch-url'/);
  assert.match(fs.readFileSync(path.join(ROOT, 'js', 'desktopfiles.js'), 'utf8'), /fromLink && !\(await MB\.ask\(/, 'a file from a link is opened only once the user agrees');
});
