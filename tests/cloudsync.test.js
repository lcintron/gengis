'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeServer, makeApp, project } = require('./harness');

const fileOf = (server, name) => server.live().find(f => f.name === name);
const content = (server, name) => { const f = fileOf(server, name); return f && JSON.parse(f.content.toString()); };
const links = app => Object.values(app.C.links);
const linkOf = (app, id) => app.C.links[id];

async function connected(o) {
  o = o || {};
  const server = makeServer(o.server), app = makeApp(Object.assign({ server }, o.app));
  (o.projects || [project('p1', 'Alpha', 3)]).forEach(p => app.device.projects.put(p, p.name !== 'Untitled map'));
  await app.connect();
  await app.settle();
  return { server, app };
}

test('connecting uploads every named project, never drafts', async () => {
  const { server, app } = await connected({ projects: [project('p1', 'Alpha', 3), project('p2', 'Beta', 1), project('d1', 'Untitled map', 2)] });
  assert.equal(app.C.accounts.length, 1);
  assert.equal(app.C.accounts[0].email, 'test@example.com');
  assert.deepEqual(server.live().map(f => f.name).sort(), ['Alpha.gengis.json', 'Beta.gengis.json']);
  assert.equal(content(server, 'Alpha.gengis.json').features.length, 3);
  assert.equal(linkOf(app, 'p1').state, 'synced');
  assert.equal(linkOf(app, 'd1'), undefined);
  assert.ok(app.toasts.some(t => /Connected to OneDrive/.test(t)));
  // the token never reaches projects, settings or the address
  assert.ok(!JSON.stringify([...app.device.projects.recs.values()]).includes('at-'));
});

test('no upload when nothing changed, and none for panning; a content change uploads once, guarded by its eTag', async () => {
  const { server, app } = await connected();
  const base = project('p1', 'Alpha', 3);
  server.calls.length = 0;
  app.save(base);
  app.save(Object.assign({}, base, { view: { lat: 10, lng: 10, zoom: 9 } }));
  await app.settle();
  assert.equal(server.calls.filter(c => c.method === 'PUT').length, 0, 'unchanged and view-only saves do not upload');
  app.save(project('p1', 'Alpha', 4));
  await app.settle();
  const puts = server.calls.filter(c => c.method === 'PUT');
  assert.equal(puts.length, 1);
  assert.equal(content(server, 'Alpha.gengis.json').features.length, 4);
});

test('a burst of saves is one upload (debounce)', async () => {
  const server = makeServer(), app = makeApp({ server, pushDelay: 150 });
  app.device.projects.put(project('p1', 'Alpha', 1));
  await app.connect(); await app.settle();
  server.calls.length = 0;
  for (let i = 0; i < 200; i++) app.save(project('p1', 'Alpha', 2 + (i % 7)));
  app.save(project('p1', 'Alpha', 50));
  await app.settle();
  assert.equal(server.calls.filter(c => c.method === 'PUT').length, 1);
  assert.equal(content(server, 'Alpha.gengis.json').features.length, 50);
});

test('renaming a project renames its file; a name taken in the folder gets a number', async () => {
  const { server, app } = await connected({ projects: [project('p1', 'Alpha'), project('p2', 'Beta')] });
  app.save(project('p1', 'Gamma'));
  await app.settle();
  assert.ok(fileOf(server, 'Gamma.gengis.json'));
  assert.ok(!fileOf(server, 'Alpha.gengis.json'));
  app.save(project('p2', 'Gamma'));
  await app.settle();
  assert.ok(fileOf(server, 'Gamma (2).gengis.json'));
  assert.equal(linkOf(app, 'p2').state, 'synced');
});

test('two projects with the same name get two files', async () => {
  const { server } = await connected({ projects: [project('p1', 'Same'), project('p2', 'Same')] });
  assert.deepEqual(server.live().map(f => f.name).sort(), ['Same (2).gengis.json', 'Same.gengis.json']);
});

test('a change made in the cloud is taken here when this device has none (a recovery copy is kept)', async () => {
  const { server, app } = await connected();
  const f = fileOf(server, 'Alpha.gengis.json');
  server.writeRemote(f.id, JSON.stringify(project('p1', 'Alpha', 9)));
  await app.C.pull(true); await app.settle();
  assert.equal(app.device.projects.recs.get('p1').data.features.length, 9);
  assert.equal(app.device.projects.copies.length, 1);
  assert.match(app.device.projects.copies[0].reason, /cloud copy/);
  assert.ok(app.toasts.some(t => /updated from OneDrive/.test(t)));
  assert.equal(linkOf(app, 'p1').state, 'synced');
});

test('the open project is reloaded with the cloud change (this tab edits it, nothing unsaved)', async () => {
  const { server, app } = await connected();
  app.open('p1');
  server.writeRemote(fileOf(server, 'Alpha.gengis.json').id, JSON.stringify(project('p1', 'Alpha', 6)));
  await app.C.pull(true); await app.settle();
  assert.equal(app.loaded.length, 1);
  assert.equal(app.loaded[0].features.length, 6);
});

test('unsaved changes in the open project are never replaced: it is a conflict instead', async () => {
  const { server, app } = await connected();
  app.open('p1'); app.P.dirtyFlag = true;
  server.writeRemote(fileOf(server, 'Alpha.gengis.json').id, JSON.stringify(project('p1', 'Alpha', 6)));
  await app.C.pull(true); await app.settle();
  assert.equal(app.loaded.length, 0);
  assert.equal(linkOf(app, 'p1').state, 'conflict');
});

test('changed in both places: conflict, and nothing is overwritten on either side', async () => {
  const { server, app } = await connected();
  const f = fileOf(server, 'Alpha.gengis.json');
  server.writeRemote(f.id, JSON.stringify(project('p1', 'Alpha', 7)));
  app.save(project('p1', 'Alpha', 5));
  await app.settle();
  await app.C.pull(true); await app.settle();
  assert.equal(linkOf(app, 'p1').state, 'conflict');
  assert.equal(content(server, 'Alpha.gengis.json').features.length, 7, 'the cloud copy is untouched');
  assert.equal(app.device.projects.recs.get('p1').data.features.length, 5, 'the local copy is untouched');
  app.save(project('p1', 'Alpha', 8)); // further edits while in conflict do not upload
  await app.settle();
  assert.equal(content(server, 'Alpha.gengis.json').features.length, 7);
  assert.ok(app.toasts.some(t => /edited in two places/.test(t)));
});

async function inConflict() {
  const r = await connected();
  const f = fileOf(r.server, 'Alpha.gengis.json');
  r.server.writeRemote(f.id, JSON.stringify(project('p1', 'Alpha', 7)));
  r.app.save(project('p1', 'Alpha', 5));
  await r.app.settle();
  await r.app.C.pull(true); await r.app.settle();
  assert.equal(linkOf(r.app, 'p1').state, 'conflict');
  return r;
}

test('conflict → use this one: the cloud file gets this version', async () => {
  const { server, app } = await inConflict();
  await app.C.resolve('p1', 'mine'); await app.settle();
  assert.equal(content(server, 'Alpha.gengis.json').features.length, 5);
  assert.equal(linkOf(app, 'p1').state, 'synced');
});

test('conflict → use the cloud copy: this version is kept as a recovery copy', async () => {
  const { app } = await inConflict();
  await app.C.resolve('p1', 'cloud'); await app.settle();
  assert.equal(app.device.projects.recs.get('p1').data.features.length, 7);
  assert.ok(app.device.projects.copies.some(c => c.data.features.length === 5));
  assert.equal(linkOf(app, 'p1').state, 'synced');
});

test('conflict → keep both: the cloud version becomes its own project and file, this one replaces the file', async () => {
  const { server, app } = await inConflict();
  await app.C.resolve('p1', 'both'); await app.settle();
  assert.equal(content(server, 'Alpha.gengis.json').features.length, 5);
  const copy = [...app.device.projects.recs.values()].find(r => r.id !== 'p1');
  assert.ok(copy && /^Alpha \(OneDrive, /.test(copy.name));
  assert.equal(copy.data.features.length, 7);
  const copyFile = server.live().find(f => f.name.startsWith('Alpha (OneDrive'));
  assert.ok(copyFile, 'the copy is synced as a separate file');
  assert.equal(JSON.parse(copyFile.content.toString()).features.length, 7);
});

test('a change in the cloud between checks makes the upload fail with 412: conflict, nothing overwritten', async () => {
  const { server, app } = await connected();
  server.writeRemote(fileOf(server, 'Alpha.gengis.json').id, JSON.stringify(project('p1', 'Alpha', 11)));
  app.save(project('p1', 'Alpha', 4)); // before any pull saw the cloud change
  await app.settle();
  assert.equal(linkOf(app, 'p1').state, 'conflict');
  assert.equal(content(server, 'Alpha.gengis.json').features.length, 11);
});

test('deleted in the cloud: the project stays here and stops syncing', async () => {
  const { server, app } = await connected();
  server.deleteRemote(fileOf(server, 'Alpha.gengis.json').id);
  await app.C.pull(true); await app.settle();
  assert.ok(app.toasts.some(t => /deleted from the cloud/.test(t)));
  app.save(project('p1', 'Alpha', 4));
  await app.settle();
  assert.equal(server.live().length, 0, 'not uploaded again on its own');
  assert.ok(app.device.projects.recs.get('p1'));
  await app.C.setSync('p1', app.C.accounts[0].id); await app.settle();
  assert.equal(server.live().length, 1, 'uploaded again when the user chooses');
});

test('deleted in the cloud before a check saw it: the next upload writes it again (404 → new file)', async () => {
  const { server, app } = await connected();
  const old = fileOf(server, 'Alpha.gengis.json').id;
  server.deleteRemote(old);
  app.save(project('p1', 'Alpha', 4));
  await app.settle();
  const f = fileOf(server, 'Alpha.gengis.json');
  assert.ok(f && f.id !== old);
  assert.equal(linkOf(app, 'p1').fileId, f.id);
});

test('offline: waits, then uploads when the network returns', async () => {
  const { server, app } = await connected();
  app.setOnline(false);
  server.calls.length = 0;
  app.save(project('p1', 'Alpha', 4));
  await app.settle();
  assert.equal(linkOf(app, 'p1').state, 'offline');
  assert.equal(server.calls.length, 0);
  app.setOnline(true);
  await new Promise(r => setTimeout(r, 900)); await app.settle();
  assert.equal(linkOf(app, 'p1').state, 'synced');
  assert.equal(content(server, 'Alpha.gengis.json').features.length, 4);
});

test('throttled (429 with Retry-After) and server errors (5xx): retried until it goes through', async () => {
  const { server, app } = await connected();
  app.C.env.backoffBase = 20;
  let n = 0;
  server.fail = r => (r.method === 'PUT' && n++ < 4 ? (n === 1
    ? { status: 429, ok: false, headers: { get: k => (k === 'Retry-After' ? '0' : null) }, json: async () => ({ error: { code: 'activityLimitReached' } }) }
    : { status: 503, ok: false, headers: { get: () => null }, json: async () => ({ error: { code: 'serviceNotAvailable' } }) }) : null);
  app.save(project('p1', 'Alpha', 4));
  await new Promise(r => setTimeout(r, 1500)); await app.settle();
  assert.equal(content(server, 'Alpha.gengis.json').features.length, 4);
  assert.equal(linkOf(app, 'p1').state, 'synced');
});

test('an expired access token is renewed with the refresh token and the call made again', async () => {
  const { server, app } = await connected();
  server.expireAccessTokens();
  app.save(project('p1', 'Alpha', 4));
  await app.settle();
  assert.equal(content(server, 'Alpha.gengis.json').features.length, 4);
});

test('an expired sign-in: projects wait ("sign in again"), and resume after signing in', async () => {
  const { server, app } = await connected();
  server.expireAccessTokens(); server.refreshFails = true;
  app.save(project('p1', 'Alpha', 4));
  await app.settle();
  assert.equal(app.C.accounts[0].state, 'signin');
  assert.equal(linkOf(app, 'p1').state, 'signin');
  assert.match(app.C.accounts[0].error, /expired/i);
  server.refreshFails = false;
  await app.connect(); await app.settle();
  assert.equal(app.C.accounts[0].state, 'ok');
  assert.equal(content(server, 'Alpha.gengis.json').features.length, 4);
  assert.equal(linkOf(app, 'p1').state, 'synced');
});

test('a large project (12 MB, pictures) syncs through an upload session', async () => {
  const pic = 'data:image/png;base64,' + 'A'.repeat(12 * 1024 * 1024);
  const big = project('p9', 'Pictures', 3, { svgLibrary: { img1: { dataUrl: pic } } });
  const { server, app } = await connected({ projects: [big] });
  assert.ok(server.calls.some(c => /createUploadSession/.test(c.url)));
  assert.equal(content(server, 'Pictures.gengis.json').svgLibrary.img1.dataUrl.length, pic.length);
  assert.equal(linkOf(app, 'p9').state, 'synced');
});

test('a project set to "not synced" never uploads, even with sync-all on', async () => {
  const { server, app } = await connected({ projects: [project('p1', 'Alpha')] });
  await app.C.setSync('p1', null);
  app.device.projects.put(project('p2', 'Beta'));
  await app.C.setSync('p2', null);
  app.save(project('p1', 'Alpha', 4)); app.save(project('p2', 'Beta', 4));
  await app.settle();
  assert.equal(content(server, 'Alpha.gengis.json').features.length, 1);
  assert.ok(!fileOf(server, 'Beta.gengis.json'));
});

test('sync-all off: only projects chosen one by one upload', async () => {
  const { server, app } = await connected({ projects: [project('p1', 'Alpha')] });
  await app.C.setAuto(app.C.accounts[0].id, false);
  app.save(project('p3', 'New one'));
  await app.settle();
  assert.ok(!fileOf(server, 'New one.gengis.json'));
  await app.C.setSync('p3', app.C.accounts[0].id); await app.settle();
  assert.ok(fileOf(server, 'New one.gengis.json'));
});

test('a cloud file that is not a project (corrupt or edited by hand) is never loaded', async () => {
  const { server, app } = await connected();
  server.writeRemote(fileOf(server, 'Alpha.gengis.json').id, '{ this is not json');
  await app.C.pull(true); await app.settle();
  assert.equal(linkOf(app, 'p1').state, 'error');
  assert.equal(app.device.projects.recs.get('p1').data.features.length, 3);
  server.writeRemote(fileOf(server, 'Alpha.gengis.json').id, JSON.stringify({ hello: 'world' }));
  await app.C.pull(true); await app.settle();
  assert.equal(app.device.projects.recs.get('p1').data.features.length, 3);
});

test('a cloud file holding another project id is taken as this project (ids never collide)', async () => {
  const { server, app } = await connected();
  server.writeRemote(fileOf(server, 'Alpha.gengis.json').id, JSON.stringify(project('someone-else', 'Alpha', 2)));
  await app.C.pull(true); await app.settle();
  assert.equal(app.device.projects.recs.get('p1').data.features.length, 2);
  assert.ok(!app.device.projects.recs.has('someone-else'));
});

test('a change-feed cursor that is too old: starts over without losing changes', async () => {
  const { server, app } = await connected();
  const acc = [...app.device.store.tables.accounts.values()][0];
  server.tooOld.add(new URL(acc.cursor).searchParams.get('token'));
  server.writeRemote(fileOf(server, 'Alpha.gengis.json').id, JSON.stringify(project('p1', 'Alpha', 13)));
  await app.C.pull(true); await app.settle();
  assert.equal(app.device.projects.recs.get('p1').data.features.length, 13);
});

test('a full re-check (old cursor) finds linked files deleted while no feed reported it', async () => {
  const { server, app } = await connected({ projects: [project('p1', 'Alpha'), project('p2', 'Beta')] });
  const acc = [...app.device.store.tables.accounts.values()][0];
  server.tooOld.add(new URL(acc.cursor).searchParams.get('token'));
  const beta = fileOf(server, 'Beta.gengis.json');
  beta.deleted = true; // gone without a change-feed entry
  await app.C.pull(true); await app.settle();
  assert.equal(linkOf(app, 'p2').excluded, true);
  assert.equal(linkOf(app, 'p1').state, 'synced');
  assert.ok(app.toasts.some(t => /Beta.*deleted from the cloud/.test(t)));
});

test('a signed-out account shows on its projects (a conflict still comes first)', async () => {
  const { server, app } = await connected();
  server.expireAccessTokens(); server.refreshFails = true;
  await app.C.pull(true); await app.settle();
  assert.equal(app.C.accounts[0].state, 'signin');
  assert.equal(app.C.status('p1'), 'signin');
});

test('saves during an upload are not lost: the cloud ends with the latest', async () => {
  const { server, app } = await connected();
  server.latency = 40;
  for (let i = 0; i < 6; i++) { app.save(project('p1', 'Alpha', 10 + i)); await new Promise(r => setTimeout(r, 25)); }
  await app.settle();
  assert.equal(content(server, 'Alpha.gengis.json').features.length, 15);
  assert.equal(linkOf(app, 'p1').state, 'synced');
});

test('disconnecting stops syncing and deletes nothing in the cloud', async () => {
  const { server, app } = await connected();
  await app.C.disconnect(app.C.accounts[0].id);
  assert.equal(app.C.accounts.length, 0);
  assert.equal(links(app).length, 0);
  app.save(project('p1', 'Alpha', 9)); await app.settle();
  assert.equal(content(server, 'Alpha.gengis.json').features.length, 3);
  assert.equal(app.device.store.tables.accounts.size, 0, 'the refresh token is gone from this device');
});

test('the cloud projects not on this device are listed, and one opens linked to its file', async () => {
  const { server, app } = await connected();
  server.create('From laptop.gengis.json', JSON.stringify(project('px', 'From laptop', 4)));
  const list = await app.C.listRemote(app.C.accounts[0].id);
  assert.deepEqual(Array.from(list, f => f.name), ['From laptop.gengis.json']);
  app.device.locksHeld.set('px', app.tabId);
  await app.C.openRemote(app.C.accounts[0].id, list[0].fileId);
  assert.equal(app.loaded[0].id, 'px');
  assert.equal(linkOf(app, 'px').fileId, list[0].fileId);
  assert.equal(linkOf(app, 'px').state, 'synced');
});

test('a project another tab is editing: this tab leaves the cloud change to that tab', async () => {
  const { server, app } = await connected();
  app.device.locksHeld.set('p1', 'other-tab');
  server.writeRemote(fileOf(server, 'Alpha.gengis.json').id, JSON.stringify(project('p1', 'Alpha', 6)));
  await app.C.pull(true); await app.settle();
  assert.equal(app.device.projects.recs.get('p1').data.features.length, 3, 'not taken here');
  assert.ok(linkOf(app, 'p1').remoteEtag, 'remembered for the tab that edits it');
  app.device.locksHeld.set('p1', app.tabId); app.open('p1');
  await app.C.pull(true); await app.settle();
  assert.equal(app.device.projects.recs.get('p1').data.features.length, 6);
});

test('two tabs of the same device never upload a project twice', async () => {
  const server = makeServer(), a = makeApp({ server });
  ['p1', 'p2', 'p3'].forEach((id, i) => a.device.projects.put(project(id, 'Shared ' + i)));
  await a.connect(); await a.settle();
  const b = makeApp({ server, device: a.device });
  await b.C.init(); await b.settle();
  a.device.projects.put(project('p4', 'New'));
  a.MB.emit('saved', 'p4'); b.MB.emit('saved', 'p4');
  a.MB.emit('saved', 'p4'); b.MB.emit('saved', 'p4');
  await a.settle(); await b.settle();
  assert.equal(server.live().filter(f => f.name === 'New.gengis.json').length, 1);
  assert.equal(server.live().length, 4);
});

test('a silent sign-in at start-up after a day; a silent failure shows no message', async () => {
  const { server, app } = await connected();
  const acc = [...app.device.store.tables.accounts.values()][0];
  acc.signedInAt = Date.now() - 25 * 3600 * 1000;
  app.device.store.tables.accounts.set(acc.id, acc);
  const b = makeApp({ server, device: app.device });
  await b.C.init();
  assert.ok(b.wentTo && /prompt=none/.test(b.wentTo), 'went to Microsoft without a prompt');
  assert.match(b.wentTo, /login_hint=test%40example\.com/);
  const pending = JSON.parse(app.device.ls.get('gengis.oauth.pending'));
  const c = makeApp({ server, device: app.device });
  c.setSearch('?error=login_required&error_description=AADSTS50058&state=' + pending.state);
  c.C.takeRedirect();
  await c.C.init(); await c.settle();
  assert.ok(!c.toasts.some(t => /sign/i.test(t)), 'no message for a silent failure');
  const d = makeApp({ server, device: app.device });
  await d.C.init();
  assert.equal(d.wentTo, null, 'not tried again within 12 hours');
});

test('a sign-in refused by the organization explains why', async () => {
  const server = makeServer(), app = makeApp({ server });
  await app.C.connect('onedrive');
  const pending = JSON.parse(app.device.ls.get('gengis.oauth.pending'));
  app.setSearch('?error=consent_required&error_description=AADSTS65001%3A+The+user+or+administrator+has+not+consented&state=' + pending.state);
  app.C.takeRedirect();
  await app.C.init();
  assert.match(app.C.lastError, /administrator to approve/);
  assert.equal(app.C.accounts.length, 0);
});

test('a forged sign-in answer (wrong state) never creates an account', async () => {
  const server = makeServer(), app = makeApp({ server });
  await app.C.connect('onedrive');
  const code = server.issueCode('whatever');
  app.setSearch('?code=' + code + '&state=forged');
  app.C.takeRedirect();
  await app.C.init();
  assert.equal(app.C.accounts.length, 0);
});

test('with no client id configured, nothing starts (the app is unchanged)', async () => {
  const server = makeServer(), app = makeApp({ server });
  app.MB.cloudProviders.onedrive.clientId = '';
  await app.C.init();
  assert.equal(app.C.ready, false);
  assert.equal(app.C.offered().length, 0);
  app.save(project('p1', 'Alpha'));
  await new Promise(r => setTimeout(r, 50));
  assert.equal(server.calls.length, 0);
});
