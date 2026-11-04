'use strict';
// js/native.js in the Android app, with a stand-in Capacitor: the cloud sign-in bridge it makes of GenGIS's own plugin
// (android-src/CloudPlugin.java), the same calls as the desktop app's (window.gengisDesktop.cloud).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = process.env.GENGIS_ROOT || path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'js', 'native.js'), 'utf8');

function load(plugins, isApp) {
  const MB = {};
  const ctx = {
    window: { MB, Capacitor: { isNativePlatform: () => isApp !== false, getPlatform: () => 'android', Plugins: plugins } },
    document: { documentElement: { classList: { add() {} } }, querySelectorAll: () => [], getElementById: () => null },
    fetch: async () => ({ ok: true, status: 200, text: async () => '' }), AbortController, setTimeout, clearTimeout, Blob, console
  };
  ctx.window.window = ctx.window;
  vm.createContext(ctx);
  vm.runInContext('var window = this.window; var MB = window.MB;' + SRC, ctx, { filename: 'js/native.js' });
  return MB;
}

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
