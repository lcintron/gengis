'use strict';
// The desktop app's cloud sign-in (electron/cloudauth.js), in Node with a stand-in Electron: the real loopback listener,
// PKCE and state, the refresh tokens encrypted on disk, renewal with rotation, sign-out, the IPC gate, and the cloud
// requests it makes for the page (to the cloud's hosts only).
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');
const crypto = require('crypto');
const http = require('http');
const fs = require('fs');
const path = require('path');

const TMP = path.join(__dirname, '.tmp-cloudauth'); // (inside the project; removed afterwards)
const handlers = {}, syncs = {};
let encryption = true;
const electron = {
  app: { getPath: () => TMP },
  ipcMain: { handle: (ch, fn) => { handlers[ch] = fn; }, on: (ch, fn) => { syncs[ch] = fn; } },
  shell: { openExternal: async () => {} },
  safeStorage: { isEncryptionAvailable: () => encryption, encryptString: s => Buffer.from('ENC(' + Buffer.from(s).toString('hex') + ')'), decryptString: b => Buffer.from(/^ENC\((.*)\)$/.exec(b.toString())[1], 'hex').toString() },
  dialog: {}, BrowserWindow: {}
};
const load = Module._load;
Module._load = function (req) { if (req === 'electron') return electron; return load.apply(this, arguments); };
const cloudauth = require('../electron/cloudauth');
const files = require('../electron/files');
Module._load = load;
const T = cloudauth._test;

const b64url = buf => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const idToken = c => 'x.' + b64url(JSON.stringify(c)) + '.y';
const STORE = path.join(TMP, 'cloud-accounts.json');

// A stand-in identity provider: the token endpoint (PKCE checked), and the browser that answers the loopback address.
function provider(o) {
  o = o || {};
  const P = { codes: new Map(), refresh: new Map(), opened: [], tokenCalls: [], revoked: [], rotate: o.rotate !== false };
  P.fetch = async (url, opts) => {
    if (/revoke/.test(url)) { P.revoked.push(new URL(url).searchParams.get('token')); return { ok: true, status: 200, json: async () => ({}) }; }
    const body = new URLSearchParams(opts.body);
    P.tokenCalls.push(Object.fromEntries(body));
    if (o.down) throw new TypeError('fetch failed');
    if (o.fiveHundred) return { ok: false, status: 503, json: async () => ({}) };
    const answer = (status, j) => ({ ok: status === 200, status, json: async () => j });
    if (body.get('grant_type') === 'authorization_code') {
      const c = P.codes.get(body.get('code'));
      if (!c || c.challenge !== b64url(crypto.createHash('sha256').update(body.get('code_verifier')).digest()) || c.redirect !== body.get('redirect_uri')) return answer(400, { error: 'invalid_grant', error_description: 'bad code' });
      P.codes.delete(body.get('code'));
      const rt = 'rt-' + crypto.randomBytes(4).toString('hex');
      P.refresh.set(rt, true);
      return answer(200, { access_token: 'at-1', expires_in: 3600, refresh_token: rt, id_token: idToken(o.claims || { oid: 'u1', tid: '9188040d-6c67-4c5b-b112-36a304b66dad', name: 'Pat', preferred_username: 'pat@example.com' }) });
    }
    if (body.get('grant_type') === 'refresh_token') {
      if (!P.refresh.get(body.get('refresh_token'))) return answer(400, { error: 'invalid_grant', error_description: 'AADSTS70043: expired' });
      let rt = body.get('refresh_token');
      if (P.rotate) { P.refresh.delete(rt); rt = 'rt-' + crypto.randomBytes(4).toString('hex'); P.refresh.set(rt, true); }
      return answer(200, { access_token: 'at-' + crypto.randomBytes(3).toString('hex'), expires_in: 3599, refresh_token: rt });
    }
    return answer(400, { error: 'unsupported_grant_type' });
  };
  // the user's browser: signs in, then is sent to the loopback address (or does what o.browser says)
  P.open = async url => {
    const u = new URL(url), q = u.searchParams;
    P.opened.push(u);
    if (o.browser) return o.browser(q, P);
    const code = 'code-' + crypto.randomBytes(3).toString('hex');
    P.codes.set(code, { challenge: q.get('code_challenge'), redirect: q.get('redirect_uri') });
    setTimeout(() => get(q.get('redirect_uri') + '/?code=' + code + '&state=' + q.get('state')), 5);
  };
  return P;
}
const get = url => new Promise(res => {
  http.get(url.replace('://localhost:', '://127.0.0.1:'), r => { let b = ''; r.on('data', d => { b += d; }); r.on('end', () => res({ status: r.statusCode, body: b })); }).on('error', e => res({ error: e.code }));
});
function use(P, extra) { T.set(Object.assign({ fetch: P.fetch, open: P.open, file: STORE, encryption: null, timeout: 0 }, extra || {})); }

test.before(() => { fs.mkdirSync(TMP, { recursive: true }); T.PROVIDERS.gdrive.clientId = 'g-client'; T.PROVIDERS.gdrive.clientSecret = 'g-secret'; });
test.after(() => { fs.rmSync(TMP, { recursive: true, force: true }); });
test.beforeEach(() => { try { fs.unlinkSync(STORE); } catch (e) { /* none */ } encryption = true; });

test('OneDrive: the browser sign-in comes back to the loopback address; PKCE and state; the refresh token kept encrypted', async () => {
  const P = provider();
  use(P);
  const r = await T.signIn('onedrive', 'pat@example.com');
  const u = P.opened[0], q = u.searchParams;
  assert.equal(u.origin + u.pathname, 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize');
  assert.equal(q.get('client_id'), '7beaabe0-cfb2-406e-b687-7eace44b2edb', 'the one registration');
  assert.equal(q.get('code_challenge_method'), 'S256');
  assert.ok(q.get('state').length >= 24);
  assert.match(q.get('redirect_uri'), /^http:\/\/localhost:\d+$/);
  assert.equal(q.get('login_hint'), 'pat@example.com');
  assert.match(q.get('scope'), /offline_access/);
  assert.match(q.get('scope'), /Files\.ReadWrite\.AppFolder/);
  assert.equal(r.account.id, 'onedrive:u1@9188040d-6c67-4c5b-b112-36a304b66dad');
  assert.equal(r.account.kind, 'personal');
  assert.equal(r.accessToken, 'at-1');
  assert.equal(r.kept, true);
  const disk = fs.readFileSync(STORE, 'utf8');
  const rt = [...P.refresh.keys()][0];
  assert.ok(!disk.includes(rt), 'never in plain text on disk');
  assert.ok(JSON.parse(disk)[r.account.id].refresh.length > 10);
  // the listener is gone afterwards
  const port = new URL(q.get('redirect_uri')).port;
  assert.ok((await get('http://127.0.0.1:' + port + '/?x=1')).error, 'closed');
});

test('Google: 127.0.0.1, offline access, the client secret of an installed app sent to the token endpoint', async () => {
  const P = provider({ claims: { sub: 'g1', email: 'pat@gmail.com', name: 'Pat' } });
  use(P);
  const r = await T.signIn('gdrive', '');
  const q = P.opened[0].searchParams;
  assert.match(q.get('redirect_uri'), /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(q.get('access_type'), 'offline');
  assert.match(q.get('scope'), /drive\.file/);
  assert.equal(P.tokenCalls[0].client_secret, 'g-secret');
  assert.equal(r.account.id, 'gdrive:g1');
  assert.equal(r.account.email, 'pat@gmail.com');
});

test('a request to the loopback address without the right state is ignored, and the real answer still counts', async () => {
  const P = provider({
    browser: async (q, p) => {
      const base = q.get('redirect_uri');
      const bad = await get(base + '/?code=evil&state=wrong');
      p.badStatus = bad.status;
      const other = await get(base + '/favicon.ico');
      p.otherStatus = other.status;
      const code = 'code-ok';
      p.codes.set(code, { challenge: q.get('code_challenge'), redirect: base });
      p.good = await get(base + '/?code=' + code + '&state=' + q.get('state'));
    }
  });
  use(P);
  const r = await T.signIn('onedrive');
  assert.equal(P.badStatus, 404);
  assert.equal(P.otherStatus, 404);
  assert.equal(P.good.status, 200);
  assert.match(P.good.body, /Signed in/);
  assert.equal(r.accessToken, 'at-1');
});

test('a sign-in refused in the browser is an error with its code; a second sign-in while one runs is refused', async () => {
  const P = provider({ browser: async q => { setTimeout(() => get(q.get('redirect_uri') + '/?error=access_denied&error_description=User+cancelled&state=' + q.get('state')), 30); } });
  use(P);
  const first = T.signIn('onedrive');
  await assert.rejects(T.signIn('gdrive'), e => e.code === 'busy');
  await assert.rejects(first, e => e.code === 'access_denied' && /cancelled/.test(e.message));
});

test('a sign-in nobody finishes times out and closes its listener', async () => {
  let port;
  const P = provider({ browser: async q => { port = new URL(q.get('redirect_uri')).port; } });
  use(P, { timeout: 80 });
  await assert.rejects(T.signIn('onedrive'), e => e.code === 'timeout');
  assert.ok((await get('http://127.0.0.1:' + port + '/')).error);
  // and the next one can start
  use(provider());
  assert.ok((await T.signIn('onedrive')).accessToken);
});

test('renewal: a fresh access token, the rotated refresh token saved; refused means sign in; offline or a server error means wait', async () => {
  const P = provider();
  use(P);
  const { account } = await T.signIn('onedrive');
  const before = JSON.parse(fs.readFileSync(STORE, 'utf8'))[account.id].refresh;
  const t = await T.token(account.id);
  assert.ok(t.accessToken && t.expiresIn === 3599);
  const after = JSON.parse(fs.readFileSync(STORE, 'utf8'))[account.id].refresh;
  assert.notEqual(after, before, 'the rotated refresh token replaced the old one');
  assert.ok((await T.token(account.id)).accessToken, 'and it works');
  P.refresh.clear();
  const refused = await T.token(account.id);
  assert.equal(refused.error, 'signin');
  use(provider({ down: true }));
  assert.equal((await T.token(account.id)).error, 'network');
  use(provider({ fiveHundred: true }));
  assert.equal((await T.token(account.id)).error, 'server');
  assert.equal((await T.token('onedrive:nobody@x')).error, 'signin');
});

test('without the operating system\'s encryption the sign-in is kept in memory only', async () => {
  encryption = false;
  const P = provider();
  use(P, { encryption: electron.safeStorage });
  const r = await T.signIn('onedrive');
  assert.equal(r.kept, false);
  assert.ok(!fs.existsSync(STORE), 'nothing written');
  assert.ok((await T.token(r.account.id)).accessToken, 'it still works until the app closes');
  await T.signOut(r.account.id);
});

test('sign-out forgets the account here and revokes Google\'s refresh token', async () => {
  const P = provider({ claims: { sub: 'g2', email: 'x@gmail.com' } });
  use(P);
  const { account } = await T.signIn('gdrive');
  const rt = [...P.refresh.keys()][0];
  await T.signOut(account.id);
  assert.deepEqual(P.revoked, [rt]);
  assert.ok(!(account.id in JSON.parse(fs.readFileSync(STORE, 'utf8'))));
  assert.equal((await T.token(account.id)).error, 'signin');
});

test('IPC: only the app\'s own page in the main frame; inputs checked', async () => {
  cloudauth.register();
  const frame = { url: files.APP_PAGE };
  const ok = { senderFrame: frame, sender: { mainFrame: frame } };
  const sub = { url: files.APP_PAGE }, framed = { senderFrame: sub, sender: { mainFrame: frame } };
  const evil = { senderFrame: { url: 'https://evil.example/' }, sender: { mainFrame: { url: 'https://evil.example/' } } };
  const e = {}; syncs['cloud:providers'](Object.assign(e, evil)); assert.deepEqual(e.returnValue, []);
  const e2 = {}; syncs['cloud:providers'](Object.assign(e2, ok)); assert.ok(e2.returnValue.includes('onedrive'));
  for (const ch of ['cloud:signin', 'cloud:token', 'cloud:signout', 'cloud:fetch']) {
    await assert.rejects(handlers[ch](evil, {}), /not allowed/);
    await assert.rejects(handlers[ch](framed, {}), /not allowed/);
  }
  assert.equal((await handlers['cloud:token'](ok, { accountId: '../../etc' })).error, 'bad_request');
  assert.equal((await handlers['cloud:signin'](ok, { provider: 'dropbox' })).error, 'bad_request');
  assert.equal((await handlers['cloud:signin'](ok, { provider: 'onedrive', hint: 'a\r\nb' })).error, 'bad_request');
});

test('the cloud requests it makes for the page: the cloud\'s hosts over HTTPS only, headers checked, answers trimmed', async () => {
  const seen = [];
  T.set({ fetch: async (url, o) => { seen.push({ url, o }); return { status: 201, headers: { get: k => ({ 'content-type': 'application/json', etag: '"1"', 'set-cookie': 'x=1', location: 'https://upload' }[k] || null) }, arrayBuffer: async () => new TextEncoder().encode('{"id":"1"}').buffer }; } });
  const r = await T.cloudFetch({ url: 'https://graph.microsoft.com/v1.0/me/drive/special/approot', method: 'put', headers: { Authorization: 'Bearer x', 'X-Bad': 'a\r\nInjected: 1', 'bad header': 'x' }, body: new Uint8Array([1, 2, 3]) });
  assert.equal(r.status, 201);
  assert.equal(Buffer.from(r.body).toString(), '{"id":"1"}');
  assert.deepEqual(Object.keys(r.headers).sort(), ['content-type', 'etag', 'location']);
  assert.equal(seen[0].o.method, 'PUT');
  assert.deepEqual(Object.keys(seen[0].o.headers), ['Authorization']);
  for (const url of ['https://www.googleapis.com/drive/v3/files', 'https://contoso-my.sharepoint.com/x', 'https://api.onedrive.com/rup/1', 'https://my.microsoftpersonalcontent.com/x', 'https://oauth2.googleapis.com/revoke']) {
    assert.ok(T.cloudUrl(url), url);
  }
  for (const url of ['http://graph.microsoft.com/v1.0/me', 'https://evil.example/', 'https://graph.microsoft.com.evil.example/', 'https://user:pw@graph.microsoft.com/', 'https://graph.microsoft.com:8443/', 'file:///etc/passwd', 'https://localhost/', 'https://127.0.0.1/', 'not a url']) {
    assert.equal((await T.cloudFetch({ url })).error, 'bad_request', url);
  }
  assert.equal((await T.cloudFetch({ url: 'https://graph.microsoft.com/', method: 'TRACE' })).error, 'bad_request');
  T.set({ fetch: async () => { throw new TypeError('fetch failed'); } });
  assert.equal((await T.cloudFetch({ url: 'https://graph.microsoft.com/' })).error, 'network');
});

test('the cloud requests it makes for the page never follow a redirect themselves', async () => {
  let opts;
  T.set({ fetch: async (url, o) => { opts = o; return { status: 302, headers: { get: k => (k === 'location' ? 'https://evil.example/' : null) }, arrayBuffer: async () => new ArrayBuffer(0) }; } });
  const r = await T.cloudFetch({ url: 'https://graph.microsoft.com/v1.0/x' });
  assert.equal(opts.redirect, 'manual');
  assert.equal(r.status, 302);
  assert.equal(r.headers.location, 'https://evil.example/', 'handed back to the page, whose next request is checked');
});

test('Google Drive is offered only in a build that has the desktop client secret', () => {
  const saved = T.PROVIDERS.gdrive.clientSecret;
  T.PROVIDERS.gdrive.clientSecret = '';
  assert.deepEqual(cloudauth.offered(), ['onedrive']);
  T.PROVIDERS.gdrive.clientSecret = saved;
  assert.deepEqual(cloudauth.offered(), ['onedrive', 'gdrive']);
  assert.ok(!fs.readFileSync(path.join(__dirname, '..', 'electron', 'cloudauth.js'), 'utf8').includes('GOCSPX'), 'no secret in the source');
});
