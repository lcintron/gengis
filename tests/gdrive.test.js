'use strict';
// Google Drive: the adapter (js/cloud-gdrive.js) against a fake Drive, and the sync engine with it, in the web app
// (Google's pop-up, an hour's access) and in the desktop app (its main process keeps the sign-in).
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeServer, makeApp, project } = require('./harness');
const { makeGoogle, CHUNK_UNIT, FOLDER } = require('./fake-google');

const fileOf = (g, name) => g.byName(name);
const content = (g, name) => { const f = fileOf(g, name); return f && JSON.parse(f.content.toString()); };

function adapter(o) {
  const google = makeGoogle(o), app = makeApp({ server: makeServer(), google });
  const token = google.issue();
  const ctx = (account) => ({ fetch: google.fetch, token: async () => token, account: account || 'acc-1' });
  return { google, GD: app.MB.cloudProviders.gdrive, ctx, app };
}

async function connected(o) {
  o = o || {};
  const google = makeGoogle(o.google), server = makeServer();
  const app = makeApp(Object.assign({ server, google }, o.app));
  (o.projects || [project('p1', 'Alpha', 3)]).forEach(p => app.device.projects.put(p, p.name !== 'Untitled map'));
  await app.connectDirect('gdrive');
  await app.settle();
  return { google, server, app };
}

/* ---------------------------------------------------------------- the adapter */

test('Drive: one GenGIS folder, found by its mark, made once', async () => {
  const { google, GD, ctx } = adapter();
  google.add('GenGIS', '', { mimeType: FOLDER }); // the user's own folder of that name: not GenGIS's
  const a = await GD.root(ctx());
  const b = await GD.root(ctx());
  assert.equal(a.fileId, b.fileId);
  assert.equal(google.folders().length, 1);
  assert.equal(google.calls.filter(c => c.method === 'POST' && /\/drive\/v3\/files\?/.test(c.url)).length, 1, 'made once');
  // a later session finds it rather than making another
  const { GD: GD2 } = { GD };
  assert.equal((await GD2.root(ctx('acc-2'))).fileId, a.fileId);
  assert.equal(google.folders().length, 1);
});

test('Drive: two devices making the folder at the same moment keep one (the older)', async () => {
  const { google, GD, ctx } = adapter({ latency: 3 });
  google.lagFolders = 0;
  const [a, b] = await Promise.all([GD.root(ctx('dev-a')), GD.root(ctx('dev-b'))]);
  assert.equal(google.folders().length, 1, 'only one GenGIS folder left');
  assert.equal(a.fileId, b.fileId);
  assert.equal(a.fileId, google.folders()[0].id);
});

test('Drive: a folder made at the same moment never loses its files: they move to the folder kept', async () => {
  const { google, GD, ctx } = adapter();
  const older = google.add('GenGIS', '', { mimeType: FOLDER, appProperties: { gengis: 'root' } });
  const newer = google.add('GenGIS', '', { mimeType: FOLDER, appProperties: { gengis: 'root' } });
  const x = google.add('x.gengis.json', '{}', { parents: [newer.id] });
  google.lagFolders = 1; // the first lookup misses both: a folder is made, then the extras are looked at
  const root = await GD.root(ctx());
  assert.equal(root.fileId, older.id);
  assert.deepEqual(google.files.get(x.id).parents, [older.id], 'its file is in the folder kept');
  assert.equal(google.folders().length, 1);
});

test('Drive: create, name clash (409), stale version (412), update at the right version', async () => {
  const { google, GD, ctx } = adapter();
  const made = await GD.put(ctx(), { name: 'Alpha.gengis.json', text: JSON.stringify(project('p1', 'Alpha', 1)) });
  assert.ok(made.fileId && made.etag);
  await assert.rejects(GD.put(ctx(), { name: 'Alpha.gengis.json', text: '{}' }), e => e.status === 409);
  google.writeRemote(made.fileId, JSON.stringify(project('p1', 'Alpha', 9)));
  await assert.rejects(GD.put(ctx(), { fileId: made.fileId, ifMatch: made.etag, text: '{}' }), e => e.status === 412);
  const meta = await GD.meta(ctx(), made.fileId);
  const out = await GD.put(ctx(), { fileId: made.fileId, ifMatch: meta.etag, text: JSON.stringify(project('p1', 'Alpha', 2)) });
  assert.notEqual(out.etag, meta.etag);
  assert.equal(content(google, 'Alpha.gengis.json').features.length, 2);
  // a file in the trash is gone
  google.trash(made.fileId);
  await assert.rejects(GD.meta(ctx(), made.fileId), e => e.status === 404);
});

test('Drive: a large project goes up resumably in 256 KiB multiples, intact', async () => {
  const { google, GD, ctx } = adapter();
  const big = project('p1', 'Big', 1, { pad: 'x'.repeat(12 * 1024 * 1024) });
  const progress = [];
  const out = await GD.put(ctx(), { name: 'Big.gengis.json', text: JSON.stringify(big), onProgress: (d, t) => progress.push([d, t]) });
  assert.ok(google.chunkSizes.length >= 3);
  google.chunkSizes.slice(0, -1).forEach(n => assert.equal(n % CHUNK_UNIT, 0));
  assert.equal(JSON.parse(google.files.get(out.fileId).content.toString()).pad.length, big.pad.length);
  assert.equal(progress[progress.length - 1][0], progress[progress.length - 1][1]);
  // and an update of it, resumably too
  const again = await GD.put(ctx(), { fileId: out.fileId, ifMatch: out.etag, text: JSON.stringify(Object.assign(big, { name: 'Big 2' })) });
  assert.equal(again.fileId, out.fileId);
  assert.equal(JSON.parse(google.files.get(out.fileId).content.toString()).name, 'Big 2');
});

test('Drive: names with quotes and backslashes are found exactly', async () => {
  const { GD, ctx } = adapter();
  const name = "Bob's \\ map.gengis.json";
  const made = await GD.put(ctx(), { name, text: '{}' });
  assert.equal((await GD.byName(ctx(), name)).fileId, made.fileId);
  assert.equal(await GD.byName(ctx(), "Bob's map.gengis.json"), null);
});

test('Drive: the change feed reports changes and removals in the folder only', async () => {
  const { google, GD, ctx } = adapter({ pageSize: 2 });
  const a = await GD.put(ctx(), { name: 'A.gengis.json', text: '{}' });
  const b = await GD.put(ctx(), { name: 'B.gengis.json', text: '{}' });
  const first = await GD.changes(ctx(), null);
  assert.equal(first.full, true);
  assert.deepEqual(Array.from(first.items, i => i.name).sort(), ['A.gengis.json', 'B.gengis.json']);
  google.writeRemote(a.fileId, '{"x":1}');
  google.add('elsewhere.json', '{}');           // not in GenGIS's folder
  for (let i = 0; i < 5; i++) google.writeRemote(a.fileId, '{"x":' + i + '}');
  google.trash(b.fileId);
  const next = await GD.changes(ctx(), first.cursor);
  assert.ok(next.items.some(i => i.fileId === a.fileId && !i.deleted));
  assert.ok(next.items.some(i => i.fileId === b.fileId && i.deleted));
  assert.ok(!next.items.some(i => i.name === 'elsewhere.json'));
  const quiet = await GD.changes(ctx(), next.cursor);
  assert.equal(quiet.items.length, 0);
  // a cursor Drive no longer knows: start again
  assert.equal((await GD.changes(ctx(), '999999')).reset, true);
});

test('Drive: throttling is a wait-and-retry, a full Drive says so', async () => {
  const { google, GD, ctx } = adapter();
  google.fail = () => ({ status: 403, ok: false, headers: { get: () => null }, json: async () => ({ error: { code: 403, message: 'Rate', errors: [{ reason: 'userRateLimitExceeded' }] } }) });
  await assert.rejects(GD.list(ctx()), e => e.status === 429);
  google.fail = () => ({ status: 403, ok: false, headers: { get: () => null }, json: async () => ({ error: { code: 403, message: 'Full', errors: [{ reason: 'storageQuotaExceeded' }] } }) });
  await assert.rejects(GD.list(ctx()), e => e.code === 'quotaLimitReached');
  google.fail = () => 'network';
  await assert.rejects(GD.list(ctx()), e => e.code === 'network');
});

/* ---------------------------------------------------------------- the engine, web app (pop-up) */

test('web: connecting Google Drive in a pop-up uploads every named project into the GenGIS folder', async () => {
  const { google, app } = await connected({ projects: [project('p1', 'Alpha', 3), project('p2', 'Beta', 1), project('d1', 'Untitled map', 1)] });
  assert.equal(app.C.accounts.length, 1);
  const acc = app.C.accounts[0];
  assert.equal(acc.id, 'gdrive:g-user-1');
  assert.equal(acc.email, 'test@gmail.com');
  assert.equal(acc.auto, true);
  assert.equal(app.popups.length, 1);
  assert.match(app.popups[0].cfg.scope, /drive\.file/);
  assert.ok(!/auth\/drive( |$)/.test(app.popups[0].cfg.scope), 'never all of Drive');
  const folder = google.folders()[0];
  assert.deepEqual(google.inFolder(folder.id).map(f => f.name).sort(), ['Alpha.gengis.json', 'Beta.gengis.json']);
  assert.equal(app.C.links.p1.state, 'synced');
  assert.ok(app.toasts.some(t => /Connected to Google Drive/.test(t)));
});

test('web: a change made elsewhere arrives; a change here goes up at the version last synced', async () => {
  const { google, app } = await connected();
  const f = fileOf(google, 'Alpha.gengis.json');
  google.writeRemote(f.id, JSON.stringify(project('p1', 'Alpha', 7)));
  await app.C.pull(true); await app.settle();
  assert.equal(app.device.projects.recs.get('p1').data.features.length, 7);
  app.save(project('p1', 'Alpha', 8)); await app.settle();
  assert.equal(content(google, 'Alpha.gengis.json').features.length, 8);
  assert.equal(app.C.links.p1.state, 'synced');
});

test('web: edited in both places is a conflict, and "keep both" keeps both', async () => {
  const { google, app } = await connected();
  const f = fileOf(google, 'Alpha.gengis.json');
  app.open('p1');
  google.writeRemote(f.id, JSON.stringify(project('p1', 'Alpha', 5)));
  app.save(project('p1', 'Alpha', 6)); await app.settle();
  assert.equal(app.C.links.p1.state, 'conflict');
  await app.C.resolve('p1', 'both'); await app.settle();
  assert.equal(content(google, 'Alpha.gengis.json').features.length, 6);
  const names = google.inFolder(google.folders()[0].id).map(x => x.name);
  assert.equal(names.length, 2, 'the cloud version became a project and file of its own: ' + names);
});

test('web: after Google\'s hour the account asks to sign in again (nothing lost); a tap reconnects without a new account', async () => {
  const { google, app } = await connected();
  const acc0 = await app.device.store.get('accounts', 'gdrive:g-user-1');
  assert.ok(acc0.accessToken && !acc0.refreshToken, 'a web app gets an access token only');
  // the hour passes
  const t0 = Date.now();
  app.C.env.now = () => t0 + 2 * 3600 * 1000;
  google.now = app.C.env.now;
  app.save(project('p1', 'Alpha', 4)); await app.settle();
  assert.equal(app.C.accounts[0].state, 'signin');
  assert.match(app.C.accounts[0].error, /hour/);
  assert.equal(app.C.status('p1'), 'signin');
  assert.equal(app.device.projects.recs.get('p1').data.features.length, 4, 'kept here');
  // "Sign in": the pop-up, with the account as a hint; the waiting change goes up
  await app.connectDirect('gdrive', app.C.accounts[0]); await app.settle();
  assert.equal(app.popups[1].cfg.login_hint, 'test@gmail.com');
  assert.equal(app.C.accounts.length, 1);
  assert.equal(app.C.accounts[0].state, 'ok');
  assert.equal(content(google, 'Alpha.gengis.json').features.length, 4);
});

test('web: an access token Google refuses (401) is not retried forever: sign in again', async () => {
  const { google, app } = await connected();
  google.expireAccessTokens();
  app.save(project('p1', 'Alpha', 4)); await app.settle();
  assert.equal(app.C.accounts[0].state, 'signin');
  const acc = await app.device.store.get('accounts', 'gdrive:g-user-1');
  assert.equal(acc.accessToken, undefined, 'the refused token is dropped');
});

test('web: a closed or blocked pop-up says why and connects nothing', async () => {
  const google = makeGoogle(), app = makeApp({ server: makeServer(), google, googlePopup: () => ({ type: 'popup_failed_to_open' }) });
  await app.connectDirect('gdrive');
  assert.equal(app.C.accounts.length, 0);
  assert.match(app.C.lastError, /blocked/);
  const app2 = makeApp({ server: makeServer(), google, googlePopup: () => ({ error: 'access_denied' }) });
  await app2.connectDirect('gdrive');
  assert.equal(app2.C.accounts.length, 0);
  assert.match(app2.C.lastError, /closed|not allowed/);
});

test('web: disconnecting revokes Google\'s access and leaves the files', async () => {
  const { google, app } = await connected();
  const token = (await app.device.store.get('accounts', 'gdrive:g-user-1')).accessToken;
  await app.C.disconnect('gdrive:g-user-1');
  await new Promise(r => setTimeout(r, 20));
  assert.deepEqual(google.revoked, [token]);
  assert.equal(app.C.accounts.length, 0);
  assert.ok(fileOf(google, 'Alpha.gengis.json'));
});

test('web: the GenGIS folder deleted in Drive: a new one, and every project uploaded to it', async () => {
  const { google, app } = await connected({ projects: [project('p1', 'Alpha', 2), project('p2', 'Beta', 1)] });
  const old = google.folders()[0].id;
  google.trashFolder();
  // a new session: the folder is looked up again
  const app2 = makeApp({ server: app.server, google, device: app.device });
  await app2.C.init(); await app2.settle();
  await app2.C.pull(true); await app2.settle();
  const now = google.folders();
  assert.equal(now.length, 1);
  assert.notEqual(now[0].id, old);
  assert.deepEqual(google.inFolder(now[0].id).map(f => f.name).sort(), ['Alpha.gengis.json', 'Beta.gengis.json']);
  assert.ok(app2.toasts.some(t => /new folder/.test(t)));
});

test('web: OneDrive and Google Drive side by side; "sync all" stays with the first account', async () => {
  const google = makeGoogle(), server = makeServer(), app = makeApp({ server, google });
  app.device.projects.put(project('p1', 'Alpha', 1));
  await app.connect(); await app.settle();               // OneDrive first
  await app.connectDirect('gdrive'); await app.settle();  // then Google Drive
  const od = app.C.accounts.find(a => a.provider === 'onedrive'), gd = app.C.accounts.find(a => a.provider === 'gdrive');
  assert.equal(od.auto, true);
  assert.equal(gd.auto, false);
  assert.ok(server.live().some(f => f.name === 'Alpha.gengis.json'));
  assert.equal(google.folders().length ? google.inFolder(google.folders()[0].id).length : 0, 0, 'nothing in Drive unless chosen');
  // one project moved to Drive
  await app.C.setSync('p1', gd.id); await app.settle();
  assert.ok(fileOf(google, 'Alpha.gengis.json'));
});

/* ---------------------------------------------------------------- the engine, desktop app */

function fakeDesktop(google, server, o) {
  o = o || {};
  const d = {
    calls: [], signedOut: [], tokenAnswer: null,
    providers: o.providers || ['onedrive', 'gdrive'],
    async signIn(provider, hint) {
      d.calls.push(['signIn', provider, hint]);
      if (o.signInError) return { error: o.signInError, message: 'nope' };
      if (provider === 'gdrive') return { account: { id: 'gdrive:g-user-1', provider, name: 'Test G', email: 'test@gmail.com', kind: 'personal' }, accessToken: google.issue(), expiresIn: 3599, kept: o.kept !== false };
      return { account: { id: 'onedrive:user-1@9188040d-6c67-4c5b-b112-36a304b66dad', provider, name: 'Test User', email: 'test@example.com', kind: 'personal' }, accessToken: server.issueAccess(), expiresIn: 3599, kept: true };
    },
    async token(accountId) {
      d.calls.push(['token', accountId]);
      if (d.tokenAnswer) return d.tokenAnswer;
      return { accessToken: accountId.startsWith('gdrive') ? google.issue() : server.issueAccess(), expiresIn: 3599 };
    },
    async signOut(accountId) { d.signedOut.push(accountId); return { ok: true }; }
  };
  return d;
}

test('desktop: signs in through its main process, keeps no token in the page\'s database, renews through it', async () => {
  const google = makeGoogle(), server = makeServer(), desktop = { cloud: null };
  desktop.cloud = fakeDesktop(google, server);
  const app = makeApp({ server, google, desktop });
  app.device.projects.put(project('p1', 'Alpha', 2));
  await app.connectDirect('gdrive'); await app.settle();
  assert.deepEqual(desktop.cloud.calls[0], ['signIn', 'gdrive', '']);
  assert.equal(app.popups.length, 0, 'no pop-up in the desktop app');
  const acc = await app.device.store.get('accounts', 'gdrive:g-user-1');
  assert.equal(acc.source, 'desktop');
  assert.ok(!acc.refreshToken && !acc.accessToken, 'nothing long-lived here');
  assert.ok(fileOf(google, 'Alpha.gengis.json'));
  // the access token runs out: a new one from the main process, no sign-in
  google.expireAccessTokens();
  app.save(project('p1', 'Alpha', 3)); await app.settle();
  assert.ok(desktop.cloud.calls.some(c => c[0] === 'token'));
  assert.equal(app.C.accounts[0].state, 'ok');
  assert.equal(content(google, 'Alpha.gengis.json').features.length, 3);
  // no silent page trip for a desktop account
  assert.equal(app.wentTo, null);
});

test('desktop: OneDrive is offered and signs in the same way', async () => {
  const google = makeGoogle(), server = makeServer(), desktop = {};
  desktop.cloud = fakeDesktop(google, server);
  const app = makeApp({ server, google, desktop });
  assert.deepEqual([...app.C.offered()].sort(), ['gdrive', 'onedrive']);
  app.device.projects.put(project('p1', 'Alpha', 2));
  await app.connectDirect('onedrive'); await app.settle();
  assert.equal(app.wentTo, null, 'no redirect');
  assert.ok(server.live().some(f => f.name === 'Alpha.gengis.json'));
});

test('desktop: a provider its main process does not offer is not offered', async () => {
  const google = makeGoogle(), server = makeServer(), desktop = {};
  desktop.cloud = fakeDesktop(google, server, { providers: ['onedrive'] });
  const app = makeApp({ server, google, desktop });
  assert.deepEqual([...app.C.offered()], ['onedrive']);
});

test('desktop: a sign-in its main process no longer has asks to sign in again; a network failure only waits', async () => {
  const google = makeGoogle(), server = makeServer(), desktop = {};
  desktop.cloud = fakeDesktop(google, server);
  const app = makeApp({ server, google, desktop });
  app.device.projects.put(project('p1', 'Alpha', 2));
  app.C.env.backoffBase = 5;
  await app.connectDirect('gdrive'); await app.settle();
  google.expireAccessTokens();
  desktop.cloud.tokenAnswer = { error: 'network', message: 'offline' };
  app.save(project('p1', 'Alpha', 3));
  await new Promise(r => setTimeout(r, 200));
  assert.equal(app.C.accounts[0].state, 'ok', 'a passing failure is not a sign-out');
  desktop.cloud.tokenAnswer = { error: 'signin', message: 'Token has been expired or revoked.' };
  await app.settle();
  assert.equal(app.C.accounts[0].state, 'signin');
  assert.equal(app.C.status('p1'), 'signin');
});

test('desktop: a failed or cancelled browser sign-in says so; disconnecting forgets the sign-in in the main process', async () => {
  const google = makeGoogle(), server = makeServer(), desktop = {};
  desktop.cloud = fakeDesktop(google, server, { signInError: 'timeout' });
  const app = makeApp({ server, google, desktop });
  await app.connectDirect('gdrive');
  assert.equal(app.C.accounts.length, 0);
  assert.ok(app.C.lastError);
  desktop.cloud = fakeDesktop(google, server);
  await app.connectDirect('gdrive'); await app.settle();
  await app.C.disconnect('gdrive:g-user-1');
  assert.deepEqual(desktop.cloud.signedOut, ['gdrive:g-user-1']);
  assert.equal(google.revoked.length, 0, 'the main process revokes, not the page');
});

test('desktop: a computer that cannot encrypt the sign-in says it will ask again after a restart', async () => {
  const google = makeGoogle(), server = makeServer(), desktop = {};
  desktop.cloud = fakeDesktop(google, server, { kept: false });
  const app = makeApp({ server, google, desktop });
  await app.connectDirect('gdrive');
  assert.ok(app.toasts.some(t => /encrypted/.test(t)));
});

test('desktop: the cloud requests through the main process look like fetch to the adapters', async () => {
  const google = makeGoogle(), server = makeServer(), desktop = {}, sent = [];
  desktop.cloud = fakeDesktop(google, server);
  desktop.cloud.fetch = async (url, method, headers, body) => {
    sent.push({ url, method, body });
    if (/evil/.test(url)) return { error: 'bad_request' };
    if (/down/.test(url)) return { error: 'network', message: 'getaddrinfo ENOTFOUND' };
    const r = await google.fetch(url, { method, headers, body });
    const h = {}; ['content-type', 'location', 'etag'].forEach(k => { const v = r.headers.get(k); if (v != null) h[k] = v; });
    return { status: r.status, headers: h, body: Buffer.from(await r.text()) };
  };
  const app = makeApp({ server, google, desktop });
  const f = app.C._desktopFetch;
  const tok = google.issue();
  const res = await f('https://www.googleapis.com/drive/v3/changes/startPageToken', { headers: { Authorization: 'Bearer ' + tok } });
  assert.equal(res.ok, true);
  assert.ok((await res.json()).startPageToken);
  const big = new Uint8Array(1024 * 1024), part = big.subarray(10, 20);
  await f('https://www.googleapis.com/x', { method: 'PUT', body: part });
  assert.equal(sent[1].body.byteLength, 10);
  assert.equal(sent[1].body.buffer.byteLength, 10, 'only the chunk crosses to the main process');
  const refused = await f('https://evil.example/');
  assert.equal(refused.status, 400);
  assert.match((await refused.json()).error.message, /Not allowed/);
  await assert.rejects(f('https://down.example/'), e => e.name === 'TypeError'); // (what the adapters take for offline)
  const r401 = await f('https://www.googleapis.com/drive/v3/files');
  assert.equal(r401.status, 401);
  assert.equal(r401.headers.get('Retry-After'), null);
});

/* ---------------------------------------------------------------- review fixes */

test('Drive: a chunk Drive takes only part of is sent again from where Drive says it stopped', async () => {
  const { google, GD, ctx } = adapter();
  google.shortWrites = 2;
  const big = project('p1', 'Big', 1, { pad: 'y'.repeat(11 * 1024 * 1024) });
  const out = await GD.put(ctx(), { name: 'Big.gengis.json', text: JSON.stringify(big) });
  assert.equal(google.shortWrites, 0, 'Drive did take less');
  assert.equal(google.files.get(out.fileId).content.toString(), JSON.stringify(big), 'intact');
});

test('Drive: an upload Drive stops taking fails (to be tried again), never loops', async () => {
  const { google, GD, ctx } = adapter();
  google.stall = true;
  await assert.rejects(GD.put(ctx(), { name: 'Big.gengis.json', text: JSON.stringify(project('p1', 'Big', 1, { pad: 'z'.repeat(7 * 1024 * 1024) })) }), e => e.status === 503);
  assert.ok(google.chunkSizes.length <= 5);
});

test('Drive: a second GenGIS folder with files in it is merged into the older one', async () => {
  const { google, GD, ctx } = adapter();
  const older = google.add('GenGIS', '', { mimeType: FOLDER, appProperties: { gengis: 'root' } });
  const newer = google.add('GenGIS', '', { mimeType: FOLDER, appProperties: { gengis: 'root' } });
  const f = google.add('Beta.gengis.json', '{}', { parents: [newer.id] });
  const root = await GD.root(ctx());
  assert.equal(root.fileId, older.id);
  assert.deepEqual(google.files.get(f.id).parents, [older.id], 'its file moved in');
  assert.ok(!google.files.has(newer.id), 'the extra folder is gone');
  assert.equal(google.folders().length, 1);
});

test('Drive: a file moved out of the folder, or renamed away from .json, reads as removed', async () => {
  const { google, GD, ctx } = adapter();
  const a = await GD.put(ctx(), { name: 'A.gengis.json', text: '{}' });
  const b = await GD.put(ctx(), { name: 'B.gengis.json', text: '{}' });
  const first = await GD.changes(ctx(), null);
  google.files.get(a.fileId).parents = ['myDrive']; google.writeRemote(a.fileId, '{"moved":1}');
  google.files.get(b.fileId).name = 'B.txt'; google.writeRemote(b.fileId, '{}');
  const next = await GD.changes(ctx(), first.cursor);
  assert.ok(next.items.some(i => i.fileId === a.fileId && i.deleted));
  assert.ok(next.items.some(i => i.fileId === b.fileId && i.deleted));
});

test('Drive: files arriving from a merged folder start a fresh look, not removals', async () => {
  const { google, GD, ctx } = adapter();
  const mine = await GD.root(ctx('dev-b'));               // this device uses a folder...
  const first = await GD.changes(ctx('dev-b'), null);
  const older = google.add('GenGIS', '', { mimeType: FOLDER, appProperties: { gengis: 'root' } });
  google.files.get(older.id).created = 0;                  // ...and an older one turns up (another device's)
  const f = await GD.put(ctx('dev-b'), { name: 'C.gengis.json', text: '{}' });
  google.files.get(f.fileId).parents = [older.id]; google.writeRemote(f.fileId, '{}'); // merged there by that device
  const next = await GD.changes(ctx('dev-b'), first.cursor);
  assert.equal(next.reset, true);
  assert.notEqual((await GD.root(ctx('dev-b'))).fileId, mine.fileId);
});

test('desktop: a redirect is followed by the page, without the access token, each hop checked by the main process', async () => {
  const google = makeGoogle(), server = makeServer(), desktop = {}, sent = [];
  desktop.cloud = fakeDesktop(google, server);
  desktop.cloud.fetch = async (url, method, headers) => {
    sent.push({ url, method, headers });
    if (url.startsWith('https://graph.microsoft.com/')) return { status: 302, headers: { location: 'https://public.dm.files.1drv.com/y4m?x' }, body: Buffer.alloc(0) };
    return { status: 200, headers: { 'content-type': 'application/json' }, body: Buffer.from('{"ok":true}') };
  };
  const app = makeApp({ server, google, desktop });
  const res = await app.C._desktopFetch('https://graph.microsoft.com/v1.0/me/drive/items/1/content', { headers: { Authorization: 'Bearer secret' } });
  assert.deepEqual(await res.json(), { ok: true });
  assert.equal(sent.length, 2);
  assert.equal(sent[1].url, 'https://public.dm.files.1drv.com/y4m?x');
  assert.equal(sent[1].headers.Authorization, undefined, 'the token does not follow a redirect');
});
