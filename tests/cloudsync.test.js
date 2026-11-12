'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeServer, makeApp, project } = require('./harness');
const { makeGoogle } = require('./fake-google');

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

test('a cloud change taken into the open project says when it cleared undo history (and only then)', async () => {
  const { server, app } = await connected();
  app.open('p1');
  let steps = false;
  app.MB.canUndo = () => steps; app.MB.canRedo = () => false;
  const change = n => server.writeRemote(fileOf(server, 'Alpha.gengis.json').id, JSON.stringify(project('p1', 'Alpha', n)));
  change(6); await app.C.pull(true); await app.settle();
  assert.equal(app.loaded.length, 1);
  assert.ok(app.toasts.some(t => /updated from OneDrive$/.test(t)), 'no history: no word about it');
  steps = true;
  change(7); await app.C.pull(true); await app.settle();
  assert.equal(app.loaded.length, 2);
  assert.ok(app.toasts.some(t => /updated from OneDrive\. Undo history was cleared\.$/.test(t)));
  // a project not open here keeps no history to clear
  app.toasts.length = 0;
  app.device.projects.put(project('p2', 'Beta', 1));
  await app.C.syncNow(); app.C.schedule('p2', 0); await app.settle();
  server.writeRemote(fileOf(server, 'Beta.gengis.json').id, JSON.stringify(project('p2', 'Beta', 4)));
  await app.C.pull(true); await app.settle();
  assert.ok(app.toasts.some(t => /^"Beta" updated from OneDrive$/.test(t)));
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
  assert.ok(app.toasts.some(t => /^Using the OneDrive version\. Yours is in earlier copies\.$/.test(t)));
});

test('conflict → use the cloud copy in the open project with undo steps: says the history was cleared', async () => {
  const { app } = await inConflict();
  app.device.locksHeld.set('p1', app.tabId); app.open('p1');
  app.MB.canUndo = () => true;
  await app.C.resolve('p1', 'cloud'); await app.settle();
  assert.equal(app.loaded[app.loaded.length - 1].features.length, 7);
  assert.ok(app.toasts.some(t => /^Using the OneDrive version\. Yours is in earlier copies\. Undo history was cleared\.$/.test(t)));
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

test('a large upload cut off part way goes on from there when the engine tries again', async () => {
  const pic = 'data:image/png;base64,' + 'B'.repeat(14 * 1024 * 1024);
  const { server, app } = await connected({ projects: [project('p9', 'Pictures', 3)] });
  let n = 0;
  server.fail = r => (/^https:\/\/upload\.test\//.test(r.url) && r.method === 'PUT' && ++n === 2 ? { status: 503, ok: false, headers: { get: () => null }, json: async () => ({ error: { code: 'serviceNotAvailable' } }) } : null);
  server.chunkSizes.length = 0;
  app.save(project('p9', 'Pictures', 3, { svgLibrary: { img1: { dataUrl: pic } } }));
  await new Promise(r => setTimeout(r, 1500)); await app.settle();
  assert.equal(server.calls.filter(c => /createUploadSession/.test(c.url)).length, 1, 'one session, resumed');
  assert.equal(server.chunkSizes.reduce((a, b) => a + b, 0), Buffer.byteLength(JSON.stringify(app.device.projects.recs.get('p9').data, null, 1)), 'no chunk sent twice');
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

/* ---------- the cloud's projects: all of them listed, opened, deleted from the cloud ---------- */
const failWith = (status, code) => ({ status, ok: false, headers: { get: () => null }, json: async () => ({ error: { code, message: code } }) });

test('every project in the cloud folder is listed, linked or not, the newest first, with its size', async () => {
  const { server, app } = await connected();
  const x = server.create('From laptop.gengis.json', JSON.stringify(project('px', 'From laptop', 4)));
  x.modified = Date.now() + 60000;
  const accId = app.C.accounts[0].id;
  const all = await app.C.listCloud(accId);
  assert.deepEqual(Array.from(all, f => f.name), ['From laptop.gengis.json', 'Alpha.gengis.json']);
  assert.ok(all.every(f => f.size > 0 && f.modified > 0));
  assert.deepEqual(Array.from(await app.C.listRemote(accId), f => f.name), ['From laptop.gengis.json'], 'the files not on this device, as before');
});

test('deleting a synced project from the cloud: the file goes, this device keeps its copy with sync off', async () => {
  const { server, app } = await connected();
  const accId = app.C.accounts[0].id, f = fileOf(server, 'Alpha.gengis.json');
  server.calls.length = 0;
  const kept = await app.C.deleteRemote(accId, f.id);
  assert.deepEqual(Array.from(kept), ['p1']);
  assert.ok(server.calls.some(c => c.method === 'DELETE' && c.url.endsWith('/me/drive/items/' + f.id)));
  assert.ok(!server.live().some(x => x.id === f.id), 'gone from the cloud');
  assert.ok(app.device.projects.recs.get('p1'), 'kept here');
  assert.equal(linkOf(app, 'p1').excluded, true);
  assert.equal(linkOf(app, 'p1').fileId, undefined);
  assert.equal(app.C.status('p1'), null);
  server.calls.length = 0;
  app.save(project('p1', 'Alpha', 5)); await app.settle();
  assert.equal(server.calls.filter(c => c.method === 'PUT').length, 0, 'not uploaded again by itself');
  await app.C.pull(true); await app.settle();
  assert.ok(!app.toasts.some(t => /deleted from the cloud/.test(t)), 'its own deletion is no news');
  await app.C.setSync('p1', accId); await app.settle();
  assert.equal(content(server, 'Alpha.gengis.json').features.length, 5, 'uploaded again when the user chooses');
});

test('deleting a cloud-only project from the cloud leaves this device as it was', async () => {
  const { server, app } = await connected();
  const accId = app.C.accounts[0].id, x = server.create('Other.gengis.json', JSON.stringify(project('px', 'Other', 2)));
  const before = JSON.stringify(app.C.links);
  assert.deepEqual(Array.from(await app.C.deleteRemote(accId, x.id)), []);
  assert.ok(!server.live().some(f => f.id === x.id));
  assert.ok(!(await app.C.listCloud(accId)).some(f => f.fileId === x.id));
  assert.equal(JSON.stringify(app.C.links), before);
  assert.deepEqual([...app.device.projects.recs.keys()], ['p1']);
  assert.equal(linkOf(app, 'p1').state, 'synced');
});

test('an upload waiting to go when its file is deleted from the cloud never writes it again', async () => {
  const server = makeServer(), app = makeApp({ server, pushDelay: 150 });
  app.device.projects.put(project('p1', 'Alpha', 1));
  await app.connect(); await app.settle();
  const f = fileOf(server, 'Alpha.gengis.json');
  app.save(project('p1', 'Alpha', 6));
  await app.C.deleteRemote(app.C.accounts[0].id, f.id);
  await new Promise(r => setTimeout(r, 300)); await app.settle();
  assert.equal(server.live().length, 0, 'nothing written again');
  assert.equal(linkOf(app, 'p1').excluded, true);
  assert.equal(app.device.projects.recs.get('p1').data.features.length, 6);
});

test('a delete the cloud refuses, or made offline, changes nothing on either side', async () => {
  const { server, app } = await connected();
  const accId = app.C.accounts[0].id, f = fileOf(server, 'Alpha.gengis.json');
  server.fail = r => (r.method === 'DELETE' ? failWith(500, 'generalException') : null);
  await assert.rejects(app.C.deleteRemote(accId, f.id), e => e.status === 500);
  server.fail = null;
  app.setOnline(false);
  await assert.rejects(app.C.deleteRemote(accId, f.id), e => e.code === 'network');
  app.setOnline(true); await app.settle();
  assert.ok(fileOf(server, 'Alpha.gengis.json'), 'the file is still there');
  assert.equal(linkOf(app, 'p1').fileId, f.id);
  assert.equal(linkOf(app, 'p1').state, 'synced');
  assert.notEqual(linkOf(app, 'p1').excluded, true);
});

test('deleting a file already gone from the cloud is the same outcome', async () => {
  const { server, app } = await connected();
  const f = fileOf(server, 'Alpha.gengis.json');
  server.deleteRemote(f.id);
  assert.deepEqual(Array.from(await app.C.deleteRemote(app.C.accounts[0].id, f.id)), ['p1']);
  assert.equal(linkOf(app, 'p1').excluded, true);
  assert.ok(app.device.projects.recs.get('p1'));
});

test('deleted from the cloud on one device: another device that has it keeps its copy, sync off', async () => {
  const { server, app: a } = await connected();
  const b = makeApp({ server });
  b.device.projects.put(project('p1', 'Alpha', 3));
  await b.connect(); await b.settle();
  const f = fileOf(server, 'Alpha.gengis.json');
  assert.equal(linkOf(b, 'p1').fileId, f.id, 'both devices sync the one file');
  await a.C.deleteRemote(a.C.accounts[0].id, f.id);
  await b.C.pull(true); await b.settle();
  assert.ok(b.toasts.some(t => /"Alpha" was deleted from the cloud\. Kept here, sync off\./.test(t)));
  assert.ok(b.device.projects.recs.get('p1'));
  assert.equal(linkOf(b, 'p1').excluded, true);
  assert.equal(server.live().length, 0, 'and it does not upload it again');
});

test('opening from the cloud resolves whether it opened; a project already here opens without a download', async () => {
  const { server, app } = await connected();
  const accId = app.C.accounts[0].id;
  const x = server.create('From laptop.gengis.json', JSON.stringify(project('px', 'From laptop', 4)));
  app.device.locksHeld.set('px', app.tabId);
  assert.equal(await app.C.openRemote(accId, x.id), true);
  assert.equal(linkOf(app, 'px').fileId, x.id);
  // already on this device (synced): opened from here
  server.calls.length = 0;
  assert.equal(await app.C.openRemote(accId, fileOf(server, 'Alpha.gengis.json').id), true);
  assert.equal(app.MB.state.projectId, 'p1');
  assert.ok(!server.calls.some(c => /\/content$/.test(c.url.split('?')[0])), 'no download');
  // sync off, its file still there: the copy here too
  await app.C.setSync('p1', null);
  app.MB.state.projectId = 'px';
  assert.equal(await app.C.openRemote(accId, fileOf(server, 'Alpha.gengis.json').id), true);
  assert.equal(app.MB.state.projectId, 'p1');
  // offline: says so, and resolves false
  const y = server.create('Elsewhere.gengis.json', JSON.stringify(project('py', 'Elsewhere', 1)));
  server.fail = () => 'network';
  assert.equal(await app.C.openRemote(accId, y.id), false);
  assert.ok(app.toasts.some(t => t === 'You are offline. Connect to open it from OneDrive.'));
  assert.equal(app.MB.state.projectId, 'p1');
});

test('a deleted file back in the cloud (restored, or written again elsewhere) never replaces the copy kept here without asking', async () => {
  const { server, app } = await connected();
  const accId = app.C.accounts[0].id;
  await app.C.deleteRemote(accId, fileOf(server, 'Alpha.gengis.json').id);
  // the same content: the copy here opens, and syncs to that file again (nothing asked)
  const same = server.create('Alpha.gengis.json', JSON.stringify(project('p1', 'Alpha', 3)));
  assert.equal(await app.C.openRemote(accId, same.id), true);
  assert.equal(app.asked.length, 0);
  assert.equal(app.MB.state.projectId, 'p1');
  assert.equal(linkOf(app, 'p1').fileId, same.id);
  assert.equal(linkOf(app, 'p1').state, 'synced');
  // different content: asked; keeping this device's copy opens it, its sync left off
  await app.C.deleteRemote(accId, same.id);
  const other = server.create('Alpha.gengis.json', JSON.stringify(project('p1', 'Alpha', 7)));
  app.answer = false;
  app.MB.state.projectId = null;
  assert.equal(await app.C.openRemote(accId, other.id), true);
  assert.match(app.asked[0].message, /^"Alpha" is also on this device, with sync off\. Open the version from OneDrive instead\? The copy on this device is kept in its earlier copies\.$/);
  assert.equal(app.asked[0].yes, 'Open the cloud version');
  assert.equal(app.MB.state.projectId, 'p1');
  assert.equal(app.loaded[app.loaded.length - 1].features.length, 3, 'the copy here');
  assert.equal(linkOf(app, 'p1').excluded, true);
  assert.equal(linkOf(app, 'p1').fileId, undefined);
  // choosing the cloud version: the copy here goes to its earlier copies first, then the cloud version opens, linked
  app.answer = true;
  assert.equal(await app.C.openRemote(accId, other.id), true);
  assert.equal(app.loaded[app.loaded.length - 1].features.length, 7);
  assert.ok(app.device.projects.copies.some(c => c.id === 'p1' && c.data.features.length === 3));
  assert.equal(linkOf(app, 'p1').fileId, other.id);
  assert.notEqual(linkOf(app, 'p1').excluded, true);
});

/* ---------- the Android app: the same list, open and delete, signed in through the app ---------- */
// GenGIS's own Android plugin (android-src/CloudPlugin.java, through js/native.js): it signs in and hands out the
// access tokens, the page makes every request itself (an account whose source is 'desktop', no fetch of its own).
function androidCloud(server, google) {
  const b = {
    calls: [], providers: ['onedrive', 'gdrive'],
    async signIn(provider, hint) {
      b.calls.push(['signIn', provider, hint]);
      return provider === 'gdrive'
        ? { account: { id: 'gdrive:g-user-1', provider, name: 'Test G', email: 'test@gmail.com', kind: 'personal' }, accessToken: google.issue(), expiresIn: 3599, kept: true }
        : { account: { id: 'onedrive:user-1@9188040d-6c67-4c5b-b112-36a304b66dad', provider, name: 'Test User', email: 'test@example.com', kind: 'personal' }, accessToken: server.issueAccess(), expiresIn: 3599, kept: true };
    },
    async token(accountId) {
      b.calls.push(['token', accountId]);
      return { accessToken: accountId.startsWith('gdrive') ? google.issue() : server.issueAccess(), expiresIn: 3599 };
    },
    async signOut(accountId) { b.calls.push(['signOut', accountId]); return { ok: true }; }
  };
  return b;
}

test('Android: the cloud\'s projects are listed, one opens and one is deleted, all through the app\'s sign-in', async () => {
  const google = makeGoogle(), server = makeServer();
  const native = androidCloud(server, google);
  const app = makeApp({ server, google, native });
  app.device.projects.put(project('p1', 'Alpha', 3));
  await app.connectDirect('onedrive'); await app.settle();
  const accId = app.C.accounts[0].id;
  const acc = await app.device.store.get('accounts', accId);
  assert.equal(acc.source, 'desktop');
  assert.ok(!acc.refreshToken && !acc.accessToken, 'nothing long-lived on this device');
  server.create('From phone.gengis.json', JSON.stringify(project('px', 'From phone', 4)));
  // the app's hour is up: a new token comes from the bridge, no sign-in and no refresh token of the page's own
  server.expireAccessTokens();
  native.calls.length = 0; server.calls.length = 0;
  const all = await app.C.listCloud(accId);
  assert.deepEqual(Array.from(all, f => f.name).sort(), ['Alpha.gengis.json', 'From phone.gengis.json']);
  assert.deepEqual(native.calls, [['token', accId]], 'renewed through the app');
  assert.ok(!server.calls.some(c => /oauth2/.test(c.url)), 'the page asks Microsoft for no token');
  assert.ok(server.calls.some(c => c.url.includes('/children')), 'the listing is the page\'s own request');
  // the one only in the cloud opens, linked to its file
  const remote = all.find(f => f.name === 'From phone.gengis.json');
  assert.equal(await app.C.openRemote(accId, remote.fileId), true);
  assert.equal(app.MB.state.projectId, 'px');
  assert.equal(linkOf(app, 'px').fileId, remote.fileId);
  assert.equal(linkOf(app, 'px').state, 'synced');
  // and the synced one is deleted from the cloud: the file goes, the copy here stays with sync off
  const f = fileOf(server, 'Alpha.gengis.json');
  server.calls.length = 0;
  assert.deepEqual(Array.from(await app.C.deleteRemote(accId, f.id)), ['p1']);
  assert.ok(server.calls.some(c => c.method === 'DELETE' && c.url.endsWith('/me/drive/items/' + f.id)));
  assert.ok(!server.live().some(x => x.id === f.id), 'gone from the cloud');
  assert.ok(app.device.projects.recs.get('p1'), 'kept here');
  assert.equal(linkOf(app, 'p1').excluded, true);
  assert.ok(!(await app.C.listCloud(accId)).some(x => x.fileId === f.id));
});

test('Android: deleting from Google Drive sends the file to its trash, with a token from the app', async () => {
  const google = makeGoogle(), server = makeServer();
  const native = androidCloud(server, google);
  const app = makeApp({ server, google, native });
  app.device.projects.put(project('p1', 'Alpha', 3));
  await app.connectDirect('gdrive'); await app.settle();
  assert.equal(app.popups.length, 0, 'no Google pop-up: the app signs in itself');
  const accId = app.C.accounts[0].id, f = google.byName('Alpha.gengis.json');
  google.expireAccessTokens();
  native.calls.length = 0; google.calls.length = 0;
  assert.deepEqual(Array.from(await app.C.deleteRemote(accId, f.id)), ['p1']);
  assert.deepEqual(native.calls, [['token', accId]], 'renewed through the app');
  assert.ok(google.calls.some(c => c.method === 'PATCH' && c.url.includes('/files/' + f.id)), 'a PATCH to the trash');
  assert.ok(!google.calls.some(c => c.method === 'DELETE'), 'never deleted for good');
  assert.ok(!google.calls.some(c => /oauth2\.googleapis\.com/.test(c.url)), 'the page asks Google for no token');
  assert.equal(google.files.get(f.id).trashed, true);
  assert.ok(!(await app.C.listCloud(accId)).some(x => x.fileId === f.id));
  assert.ok(app.device.projects.recs.get('p1'), 'kept here');
  assert.equal(linkOf(app, 'p1').excluded, true);
});

test('Recent projects learns what a delete there takes with it: the account, the file, and cloud changes not here', async () => {
  const { server, app } = await inConflict();
  const l = await app.C.linkOf('p1');
  assert.deepEqual(JSON.parse(JSON.stringify(l)), { accountId: app.C.accounts[0].id, provider: 'onedrive', fileId: fileOf(server, 'Alpha.gengis.json').id, changed: true });
  await app.C.setSync('p1', null);
  assert.equal(await app.C.linkOf('p1'), null, 'sync off: this device only');
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

// The folder OneDrive makes for GenGIS: made by the first request that names it, and once only.
test('a first sign-in with the cloud dialog open (its listing beside the first check): one folder, every file in it', async () => {
  const server = makeServer({ fresh: true }), app = makeApp({ server });
  [project('p1', 'Alpha', 3), project('p2', 'Beta', 1)].forEach(p => app.device.projects.put(p, true));
  // what the dialog does when a sign-in comes back: a check for changes, and the account's cloud files listed beside it
  app.MB.on('cloud-return', () => { app.C.pull(false); app.C.accounts.filter(a => a.state !== 'signin').forEach(a => app.C.listRemote(a.id).catch(() => {})); });
  await app.connect(); await app.settle();
  assert.equal(server.folders.length, 1, 'one folder: ' + server.folders.map(f => f.name).join(', '));
  assert.equal(server.root.name, 'GenGIS');
  assert.deepEqual(server.inFolder(server.root).map(f => f.name).sort(), ['Alpha.gengis.json', 'Beta.gengis.json']);
  assert.equal(server.calls.filter(c => /special\/approot/.test(c.url)).length, 1, 'the folder is asked for by its path once, before anything else');
  assert.equal(app.C.accounts[0].state, 'ok');
  assert.equal(linkOf(app, 'p1').state, 'synced');
  assert.equal((await app.C.listRemote(app.C.accounts[0].id)).length, 0);
});

test('the folder deleted while GenGIS runs: the next upload finds the new one, and every project goes to it', async () => {
  const { server, app } = await connected({ projects: [project('p1', 'Alpha', 2), project('p2', 'Beta', 3)] });
  app.C.env.backoffBase = 50;
  server.deleteRoot();
  app.save(project('p1', 'Alpha', 5)); await app.settle();
  assert.equal(server.folders.length, 2);
  assert.deepEqual(server.inFolder(server.root).map(f => f.name).sort(), ['Alpha.gengis.json', 'Beta.gengis.json']);
  assert.equal(content(server, 'Alpha.gengis.json').features.length, 5);
  assert.equal(linkOf(app, 'p1').state, 'synced');
  assert.equal(linkOf(app, 'p2').state, 'synced');
  assert.ok(app.toasts.some(t => /new folder/.test(t)));
  assert.ok(!app.toasts.some(t => /deleted from the cloud|Could not sync/.test(t)));
});

test('the folder deleted while GenGIS runs: the next check finds the new one, and nothing is taken for deleted', async () => {
  const { server, app } = await connected({ projects: [project('p1', 'Alpha', 2), project('p2', 'Beta', 3)] });
  server.deleteRoot();
  await app.C.pull(true); await app.settle();
  assert.deepEqual(server.inFolder(server.root).map(f => f.name).sort(), ['Alpha.gengis.json', 'Beta.gengis.json']);
  assert.equal(content(server, 'Beta.gengis.json').features.length, 3);
  assert.equal(linkOf(app, 'p1').state, 'synced');
  assert.notEqual(linkOf(app, 'p2').excluded, true);
  assert.ok(app.toasts.some(t => /new folder/.test(t)));
  assert.ok(!app.toasts.some(t => /deleted from the cloud/.test(t)));
  assert.equal(app.C.accounts[0].pullError, '');
});

test('a new file the folder keeps refusing (an organization\'s policy, not a gone folder) becomes an error, not a retry forever', async () => {
  const { server, app } = await connected({ projects: [project('p1', 'Alpha', 2)] });
  app.C.env.backoffBase = 50;
  let refusals = 0;
  server.fail = r => (r.method === 'PUT' && /\/content/.test(r.url) && /Gamma/.test(decodeURIComponent(r.url)) ? (refusals++, { status: 403, ok: false, headers: { get: () => null }, json: async () => ({ error: { code: 'accessDenied', message: 'Blocked by policy' } }) }) : null);
  app.device.projects.put(project('p3', 'Gamma', 1));
  app.C.schedule('p3', 0);
  await new Promise(r => setTimeout(r, 600)); await app.settle();
  assert.equal(linkOf(app, 'p3').state, 'error');
  assert.match(linkOf(app, 'p3').error, /Blocked by policy/);
  assert.equal(refusals, 2, 'tried once more after looking for the folder, then stopped');
  assert.equal(server.folders.length, 1, 'the folder was found the same: no new one');
  assert.ok(app.toasts.some(t => /Could not sync "Gamma"/.test(t)));
  // a later upload that goes through clears it
  server.fail = null;
  app.save(project('p3', 'Gamma', 2)); await app.settle();
  assert.equal(linkOf(app, 'p3').state, 'synced');
});
