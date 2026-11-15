'use strict';
// js/native.js in the Android app, with a stand-in Capacitor: the cloud sign-in bridge it makes of GenGIS's own plugin
// (android-src/CloudPlugin.java), the same calls as the desktop app's (window.gengisDesktop.cloud), saving a file
// through the share sheet, and the file pickers (Android's hides what its accept list does not name).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = process.env.GENGIS_ROOT || path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'js', 'native.js'), 'utf8');

// A stand-in page: elements enough for an <input type=file>, a label, and clicks that reach the document. Its own
// classes each time, so one load never patches another's HTMLInputElement.
function makeDom() {
  class El {
    constructor(tag) { this.tagName = tag; this.attrs = {}; this.kids = []; this.parent = null; this.clicks = []; }
    click() { this.clicks.push(this.getAttribute('accept') || ''); } // (as in a page: click comes from HTMLElement, not from the input)
    setAttribute(n, v) { this.attrs[n] = String(v); }
    getAttribute(n) { return Object.hasOwn(this.attrs, n) ? this.attrs[n] : null; }
    hasAttribute(n) { return Object.hasOwn(this.attrs, n); }
    removeAttribute(n) { delete this.attrs[n]; }
    append(kid) { kid.parent = this; this.kids.push(kid); return kid; }
    matches(sel) { return sel.split(',').map(s => s.trim()).some(s => s === 'label' ? this.tagName === 'LABEL' : this.tagName === 'INPUT' && this.type === 'file'); }
    closest(sel) { for (let n = this; n; n = n.parent) if (n.matches(sel)) return n; return null; }
    querySelector(sel) { for (const k of this.kids) { if (k.matches(sel)) return k; const f = k.querySelector(sel); if (f) return f; } return null; }
  }
  class HTMLInputElement extends El {
    constructor(type, accept) { super('INPUT'); this.type = type; if (accept != null) this.accept = accept; }
    get accept() { return this.getAttribute('accept') || ''; }
    set accept(v) { this.setAttribute('accept', v); }
  }
  const ids = new Map(), listeners = [];
  const document = {
    documentElement: { classList: { add() {} } }, querySelectorAll: () => [], getElementById: id => ids.get(id) || null,
    addEventListener: (type, fn, capture) => listeners.push({ type, fn, capture })
  };
  return { El, HTMLInputElement, document, ids,
    input: (type, accept) => new HTMLInputElement(type, accept),
    label: (htmlFor) => { const l = new El('LABEL'); if (htmlFor) l.htmlFor = htmlFor; return l; },
    click: target => listeners.filter(l => l.type === 'click' && l.capture).forEach(l => l.fn({ target })) };
}

function env(plugins, isApp) {
  const MB = {};
  const dom = makeDom();
  const ctx = {
    window: { MB, HTMLInputElement: dom.HTMLInputElement, Capacitor: { isNativePlatform: () => isApp !== false, getPlatform: () => 'android', Plugins: plugins } },
    document: dom.document,
    fetch: async () => ({ ok: true, status: 200, text: async () => '' }), AbortController, setTimeout, clearTimeout, Blob, console,
    FileReader: class { readAsDataURL() { this.result = 'data:application/json;base64,e30='; Promise.resolve().then(() => this.onload()); } }
  };
  ctx.window.window = ctx.window;
  vm.createContext(ctx);
  vm.runInContext('var window = this.window; var MB = window.MB;' + SRC, ctx, { filename: 'js/native.js' });
  return { MB, dom };
}
const load = (plugins, isApp) => env(plugins, isApp).MB;

test('the Android app\'s cloud bridge passes the page\'s calls to its plugin', async () => {
  const seen = [];
  const GenGISCloud = {
    signIn: async o => { seen.push(['signIn', o]); return { account: { id: 'onedrive:x@t' }, accessToken: 'at', expiresIn: 3600, kept: true }; },
    token: async o => { seen.push(['token', o]); return { accessToken: 'at2', expiresIn: 3600 }; },
    signOut: async o => { seen.push(['signOut', o]); return { ok: true }; }
  };
  const MB = load({ GenGISCloud });
  const c = MB.native.cloud;
  assert.deepEqual(Array.from(c.providers), ['onedrive', 'gdrive']);
  assert.equal((await c.signIn('onedrive')).accessToken, 'at');
  await c.signIn('gdrive', 'me@example.com');
  assert.equal((await c.token('onedrive:x@t')).accessToken, 'at2');
  assert.equal((await c.signOut('onedrive:x@t')).ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(seen)), [
    ['signIn', { provider: 'onedrive', hint: '' }], ['signIn', { provider: 'gdrive', hint: 'me@example.com' }],
    ['token', { accountId: 'onedrive:x@t' }], ['signOut', { accountId: 'onedrive:x@t' }]
  ]);
});

test('a plugin call that fails comes back as an error answer, as the desktop app\'s do (never a rejection)', async () => {
  const MB = load({ GenGISCloud: { signIn: async () => { throw new Error('plugin not implemented'); }, token: async () => { throw 'boom'; }, signOut: async () => ({ ok: true }) } });
  assert.deepEqual(JSON.parse(JSON.stringify(await MB.native.cloud.signIn('onedrive'))), { error: 'failed', message: 'plugin not implemented' });
  assert.deepEqual(JSON.parse(JSON.stringify(await MB.native.cloud.token('a'))), { error: 'failed', message: 'boom' });
});

test('no bridge without the plugin, and none outside the app', () => {
  assert.equal(load({}).native.cloud, undefined, 'an app built without it');
  assert.equal(load({ GenGISCloud: {} }, false).native.cloud, undefined, 'the web and desktop apps');
});

/* ---------- saving a file: the share sheet ---------- */
const files = () => {
  const written = [], shared = [];
  const Filesystem = { writeFile: async o => { written.push(o); return { uri: 'file:///cache/' + o.path }; } };
  const Share = { share: async o => { shared.push(o); } };
  return { written, shared, Filesystem, Share };
};

test('a file saved in the app is written and shared, and says so once the share sheet has answered', async () => {
  const f = files(), MB = load({ Filesystem: f.Filesystem, Share: f.Share }), toasts = [];
  MB.toast = t => toasts.push(t);
  assert.equal(await MB.download('My map.gengis', '{"a":1}'), true);
  assert.equal(f.written[0].path, 'My map.gengis');
  assert.equal(f.written[0].directory, 'CACHE');
  assert.equal(f.shared[0].url, 'file:///cache/My map.gengis');
  assert.deepEqual(toasts, [], 'the page says "saved", not this');
});

test('a share sheet that was cancelled answers false and says nothing; one that failed says why', async () => {
  const f = files(), toasts = [];
  const MB = load({ Filesystem: f.Filesystem, Share: f.Share });
  MB.toast = t => toasts.push(t);
  f.Share.share = async () => { throw new Error('Share canceled'); };
  assert.equal(await MB.download('map.gengis', '{}'), false);
  assert.deepEqual(toasts, [], 'a cancel is not a failure');
  f.Share.share = async () => { throw new Error('no app can take it'); };
  assert.equal(await MB.download('map.gengis', '{}'), false);
  assert.equal(toasts.length, 1);
  assert.match(toasts[0], /Could not save "map\.gengis": no app can take it/);
});

/* ---------- picking files ---------- */
test('in the app a file picker is opened without its accept list, so Android shows .gengis, .shp and .bbl files', () => {
  const { dom } = env({});
  const open = dom.input('file', '.gengis,.json,.geojson,application/json,application/geo+json');
  open.click();
  assert.equal(open.accept, '', 'the accept attribute is gone before the picker opens');
  assert.deepEqual(open.clicks, [''], 'and the input is still clicked (the picker opens)');
  const imports = dom.input('file', '.kml,.kmz,.shp,.dbf,.prj,.cpg,.shx,.zip');
  imports.setAttribute('capture', 'environment');
  imports.click();
  assert.equal(imports.accept, '');
  assert.equal(imports.getAttribute('capture'), 'environment', 'asking for the camera is left alone');
});

test('a picker opened by its label loses its accept too, and nothing else is touched', () => {
  const { dom } = env({});
  const inp = dom.input('file', '.bbl,.bfl');
  dom.ids.set('bfOpen', inp);
  dom.click(dom.label('bfOpen'));
  assert.equal(inp.accept, '', 'a label with for=');
  const wrapping = dom.label(), inside = dom.input('file', '.svg,image/svg+xml');
  wrapping.append(inside);
  dom.click(inside); // the click starts at the input inside the label
  assert.equal(inside.accept, '');
  const text = dom.input('text', 'nonsense');
  text.click();
  dom.click(text);
  assert.equal(text.accept, 'nonsense', 'only file inputs');
});

test('outside the app every picker keeps its accept list (the browser and the desktop app honour it)', () => {
  const { dom } = env({}, false);
  const inp = dom.input('file', '.gengis,.json');
  inp.click();
  assert.equal(inp.accept, '.gengis,.json');
  assert.deepEqual(inp.clicks, ['.gengis,.json']);
});
