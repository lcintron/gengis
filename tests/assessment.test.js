'use strict';
// One test per finding of the independent assessment of cloud sync: each fails on the code before its fix.
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeServer, makeApp, project } = require('./harness');

const fileOf = (server, name) => server.live().find(f => f.name === name);
const content = (server, name) => { const f = fileOf(server, name); return f && JSON.parse(f.content.toString()); };
const puts = server => server.calls.filter(c => c.method === 'PUT').length;

async function connected(o) {
  o = o || {};
  const server = o.server || makeServer(), app = makeApp(Object.assign({ server }, o.app));
  (o.projects || [project('p1', 'Alpha', 3)]).forEach(p => app.device.projects.put(p));
  await app.connect(); await app.settle();
  return { server, app };
}

test('P1-1: a change saved just before the page closed (inside the upload delay) is uploaded at the next start', async () => {
  const server = makeServer(), a = makeApp({ server, pushDelay: 60000 });
  a.device.projects.put(project('p1', 'Alpha', 3));
  a.C.env.pushDelay = 0;
  await a.connect(); await a.settle();
  a.C.env.pushDelay = 60000;            // the edit's upload is a minute away...
  a.save(project('p1', 'Alpha', 9));    // ...and the page is closed before it
  const b = makeApp({ server, device: a.device, pushDelay: 0 }); // the next start
  await b.C.init(); await new Promise(r => setTimeout(r, 1700)); await b.settle();
  assert.equal(content(server, 'Alpha.gengis.json').features.length, 9);
  assert.equal(b.C.links.p1.state, 'synced');
});

test('P1-1: hiding the app sends waiting uploads at once', async () => {
  const { server, app } = await connected();
  app.C.env.pushDelay = 60000;
  app.save(project('p1', 'Alpha', 7));
  app.C.flushNow(); await app.settle();
  assert.equal(content(server, 'Alpha.gengis.json').features.length, 7);
});

test('P1-2: disconnect and reconnect does not duplicate any project', async () => {
  const { server, app } = await connected({ projects: [project('p1', 'Alpha'), project('p2', 'Beta')] });
  await app.C.disconnect(app.C.accounts[0].id);
  await app.connect(); await app.settle();
  assert.deepEqual(server.live().map(f => f.name).sort(), ['Alpha.gengis.json', 'Beta.gengis.json']);
  assert.equal(app.C.links.p1.state, 'synced');
});

test('P1-2: the same project already on two devices links to one file (same content: synced)', async () => {
  const server = makeServer();
  const { app: a } = await connected({ server, projects: [project('shared', 'Survey', 4)] });
  const { app: b } = await connected({ server, projects: [project('shared', 'Survey', 4)] });
  assert.equal(server.live().length, 1);
  assert.equal(b.C.links.shared.state, 'synced');
  assert.equal(a.C.links.shared.fileId, b.C.links.shared.fileId);
});

test('P1-2: ...and with different content it is a conflict, never a silent overwrite or a fork', async () => {
  const server = makeServer();
  await connected({ server, projects: [project('shared', 'Survey', 4)] });
  const { app: b } = await connected({ server, projects: [project('shared', 'Survey', 6)] });
  assert.equal(server.live().length, 1);
  assert.equal(content(server, 'Survey.gengis.json').features.length, 4);
  assert.equal(b.C.links.shared.state, 'conflict');
  await b.C.resolve('shared', 'both'); await b.settle();
  assert.equal(content(server, 'Survey.gengis.json').features.length, 6);
  assert.equal(server.live().length, 2, 'the other version kept as its own file');
});

test('P1-3: resolving in a tab that does not edit the project is refused (the editing tab would undo it)', async () => {
  const { server, app } = await connected();
  server.writeRemote(fileOf(server, 'Alpha.gengis.json').id, JSON.stringify(project('p1', 'Alpha', 7)));
  app.save(project('p1', 'Alpha', 5)); await app.settle();
  assert.equal(app.C.links.p1.state, 'conflict');
  app.device.locksHeld.set('p1', 'the-editing-tab');
  await app.C.resolve('p1', 'cloud'); await app.settle();
  assert.equal(app.C.links.p1.state, 'conflict');
  assert.equal(app.device.projects.recs.get('p1').data.features.length, 5);
  assert.ok(app.toasts.some(t => /open in another tab/i.test(t)));
});

test('P1-4: two devices on different app versions do not upload back and forth', async () => {
  const server = makeServer();
  const A = makeApp({ server, version: '0.17.0' }), B = makeApp({ server, version: '0.18.0' });
  A.device.projects.put(project('p1', 'Alpha', 3));
  await A.connect(); await A.settle();
  await B.connect(); await B.settle();
  const f = (await B.C.listRemote(B.C.accounts[0].id))[0];
  B.device.locksHeld.set('p1', B.tabId);
  await B.C.openRemote(B.C.accounts[0].id, f.fileId);
  const before = puts(server);
  B.autosave(); await B.settle();                 // B saves the project its own way (version, its traffic server)
  assert.equal(puts(server), before, 'opening it on another app version uploads nothing');
  A.open('p1');
  A.save(project('p1', 'Alpha', 4)); await A.settle(); // a real edit on A
  await B.C.pull(true); await B.settle();         // B takes it...
  B.autosave(); await B.settle();                 // ...and its autosave after the load must not upload it back
  server.calls.length = 0;
  for (let i = 0; i < 3; i++) { await A.C.pull(true); await A.settle(); A.autosave(); await A.settle(); await B.C.pull(true); await B.settle(); B.autosave(); await B.settle(); }
  assert.equal(puts(server), 0, 'no ping-pong');
  assert.ok(B.device.projects.copies.length <= 1, 'recovery copies are not churned');
});

test('P1-5: an iPhone sign-in that lost its start says to connect from Safari', () => {
  const app = makeApp({ server: makeServer(), userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)' });
  const r = app.MB.oauth.take('?code=x&state=y');
  assert.match(r.description, /Safari/);
});

test('P1-7: a change feed that keeps failing shows on the account; it clears when it works again', async () => {
  const { server, app } = await connected();
  server.fail = req => (/\/delta/.test(req.url) ? { status: 400, ok: false, headers: { get: () => null }, json: async () => ({ error: { code: 'invalidRequest', message: 'nope' } }) } : null);
  await app.C.pull(true); await app.settle();
  assert.ok(app.C.accounts[0].pullError);
  server.fail = null;
  await app.C.pull(true); await app.settle();
  assert.equal(app.C.accounts[0].pullError, '');
});

test('realism A: a drive without the folder change feed falls back to listing, and cloud changes still arrive', async () => {
  const server = makeServer(); server.noDelta = true;
  const { app } = await connected({ server });
  server.writeRemote(fileOf(server, 'Alpha.gengis.json').id, JSON.stringify(project('p1', 'Alpha', 8)));
  await app.C.pull(true); await app.settle();
  assert.equal(app.device.projects.recs.get('p1').data.features.length, 8);
  assert.equal(app.C.accounts[0].pullError, '');
});

test('P2-8: a file missing from a lagging full listing is not taken for deleted', async () => {
  const { server, app } = await connected({ projects: [project('p1', 'Alpha'), project('p2', 'Beta')] });
  const acc = [...app.device.store.tables.accounts.values()][0];
  server.tooOld.add(new URL(acc.cursor).searchParams.get('token'));
  server.hidden.add(fileOf(server, 'Beta.gengis.json').id);
  await app.C.pull(true); await app.settle();
  assert.notEqual(app.C.links.p2.excluded, true);
  assert.ok(!app.toasts.some(t => /deleted/.test(t)));
});

test('P2-9: deleting a project here drops its link (no unresolvable conflict later)', async () => {
  const { server, app } = await connected();
  await app.P.remove('p1');
  await new Promise(r => setTimeout(r, 30));
  assert.equal(app.C.links.p1, undefined);
  server.writeRemote(fileOf(server, 'Alpha.gengis.json').id, JSON.stringify(project('p1', 'Alpha', 9)));
  await app.C.pull(true); await app.settle();
  assert.ok(!app.toasts.some(t => /edited in two places/.test(t)));
});

test('P2-10: a write answered without an eTag still guards the next write', async () => {
  const server = makeServer(); server.omitEtag = true;
  const { app } = await connected({ server });
  assert.ok(app.C.links.p1.etag, 'the eTag was fetched');
  server.writeRemote(fileOf(server, 'Alpha.gengis.json').id, JSON.stringify(project('p1', 'Alpha', 11)));
  app.save(project('p1', 'Alpha', 5)); await app.settle();
  assert.equal(content(server, 'Alpha.gengis.json').features.length, 11, 'the laptop\'s edit is not overwritten');
  assert.equal(app.C.links.p1.state, 'conflict');
});

test('P2-15: a huge cloud file is not read', async () => {
  const { server, app } = await connected();
  const f = fileOf(server, 'Alpha.gengis.json');
  server.sizeOf.set(f.id, 900 * 1024 * 1024);
  server.writeRemote(f.id, JSON.stringify(project('p1', 'Alpha', 2)));
  server.calls.length = 0;
  await app.C.pull(true); await app.settle();
  assert.ok(!server.calls.some(c => /\/content$/.test(c.url) && c.method === 'GET'), 'never downloaded');
  assert.equal(app.device.projects.recs.get('p1').data.features.length, 3);
});

test('P2-18: "sync all" is on for one account at a time', async () => {
  const server = makeServer(), { app } = await connected({ server });
  server.claims = Object.assign({}, server.claims, { oid: 'user-2', preferred_username: 'two@example.com' });
  await app.connect(); await app.settle();
  const [a1, a2] = app.C.accounts;
  await app.C.setAuto(a2.id, true);
  const accs = app.C.accounts;
  assert.equal(accs.filter(a => a.auto).length, 1);
  assert.equal(accs.find(a => a.auto).id, a2.id);
  assert.ok(a1);
});

test('P3-19: a failure that keeps retrying says so once', async () => {
  const { server, app } = await connected();
  app.C.env.backoffBase = 1;
  server.fail = r => (r.method === 'PUT' ? { status: 503, ok: false, headers: { get: () => null }, json: async () => ({ error: { code: 'serviceNotAvailable' } }) } : null);
  app.save(project('p1', 'Alpha', 4));
  await new Promise(r => setTimeout(r, 900));
  server.fail = null;
  await app.settle();
  assert.equal(app.toasts.filter(t => /trying again/.test(t)).length, 1);
  assert.equal(content(server, 'Alpha.gengis.json').features.length, 4);
});

test('P3-25: reserved names get a file name OneDrive accepts', () => {
  const app = makeApp({ server: makeServer() });
  assert.equal(app.C.fileName('CON'), '_CON.gengis.json');
  assert.equal(app.C.fileName('lpt1'), '_lpt1.gengis.json');
  assert.equal(app.C.fileName('Console'), 'Console.gengis.json');
});

test('P2-14: the redirect address is the same for /index.html; the page\'s own parameters survive the sign-in', async () => {
  const app = makeApp({ server: makeServer() }), { MB } = app;
  assert.equal(MB.oauth.redirectUri(), 'https://g2.test/');
  app.setSearch('?lat=40.7&lon=-74&zoom=12');
  await MB.oauth.begin(MB.cloudProviders.onedrive.auth(), {}, () => {});
  const p = JSON.parse(app.device.ls.get('gengis.oauth.pending'));
  app.setSearch('?code=C&state=' + p.state);
  const r = MB.oauth.take();
  assert.equal(r.code, 'C');
  assert.equal(app.getSearch(), '?lat=40.7&lon=-74&zoom=12');
});

test('one folder only: every request stays in the app folder or targets a file by id, and nothing creates a folder', async () => {
  const server = makeServer();
  const big = project('pb', 'Big one', 1, { svgLibrary: { i: { dataUrl: 'x'.repeat(5 * 1024 * 1024) } } });
  const { app } = await connected({ server, projects: [project('p1', 'Alpha'), project('p2', 'a/b\\c'), big] });
  app.save(project('p1', 'Renamed/with slash', 2)); await app.settle();          // rename
  server.writeRemote(fileOf(server, 'Big one.gengis.json').id, JSON.stringify(Object.assign({}, big, { name: 'Big one' })));
  app.save(Object.assign({}, big, { features: [] })); await app.settle();         // a conflict
  await app.C.resolve('pb', 'both'); await app.settle();
  await app.C.pull(true); await app.settle();
  await app.C.disconnect(app.C.accounts[0].id); await app.connect(); await app.settle(); // a reconnect
  const graph = server.calls.filter(c => c.url.startsWith('https://graph.microsoft.com/'));
  assert.ok(graph.length > 10);
  const allowed = /^https:\/\/graph\.microsoft\.com\/v1\.0\/me\/drive\/(special\/approot\?|items\/[^/?:]+(\?|\/content$|\/createUploadSession$|\/children\?|\/delta\?|:\/[^/]+:(\?|\/content|\/createUploadSession)|$))/;
  graph.forEach(c => assert.match(c.url, allowed, c.method + ' ' + c.url));
  // the folder is named by its path (which has Microsoft make it when there is none) only to ask which it is; all else goes by its id
  graph.filter(c => /special\/approot/.test(c.url)).forEach(c => assert.match(c.method + ' ' + c.url, /^GET https:\/\/graph\.microsoft\.com\/v1\.0\/me\/drive\/special\/approot\?/));
  assert.ok(!graph.some(c => c.method === 'POST' && /\/children/.test(c.url)), 'never creates an item under a folder');
  server.live().forEach(f => assert.ok(!/[\\/]/.test(f.name), 'no file name makes a subfolder: ' + f.name));
});

test('a new app folder from Microsoft (old one renamed, moved or deleted): projects are uploaded to it, not turned off', async () => {
  const { server, app } = await connected({ projects: [project('p1', 'Alpha', 2), project('p2', 'Beta', 3)] });
  const oldIds = server.inRoot().map(f => f.id).sort();
  server.newRoot('GenGIS 1');
  const b = makeApp({ server, device: app.device });      // the next start
  await b.C.init(); await new Promise(r => setTimeout(r, 1200)); await b.settle();
  const now = server.inRoot();
  assert.deepEqual(now.map(f => f.name).sort(), ['Alpha.gengis.json', 'Beta.gengis.json']);
  assert.ok(now.every(f => !oldIds.includes(f.id)), 'new files in the new folder');
  assert.equal(JSON.parse(now.find(f => f.name === 'Beta.gengis.json').content.toString()).features.length, 3);
  assert.equal(b.C.links.p1.state, 'synced');
  assert.notEqual(b.C.links.p1.excluded, true);
  assert.ok(b.toasts.some(t => /new folder/.test(t)));
  assert.ok(!b.toasts.some(t => /deleted from the cloud/.test(t)));
  assert.equal(server.live().length, 4, 'the old files are left where they were');
});

test('checking cadence: every 10 s for two minutes after activity, then every 30 s', async () => {
  const app = makeApp({ server: makeServer() });
  let now = 1e12;
  app.C.env.now = () => now;
  assert.equal(app.C.pullInterval(), 30000, 'quiet');
  app.C.activity();
  assert.equal(app.C.pullInterval(), 10000, 'just after a change');
  now += 119000;
  assert.equal(app.C.pullInterval(), 10000, 'still within two minutes');
  now += 2000;
  assert.equal(app.C.pullInterval(), 30000, 'quiet again');
  assert.equal(app.C.env.pushDelay, 0, '(tests upload at once)');
  assert.equal(makeApp({ server: makeServer(), pushDelay: 'default' }).C.env.pushDelay, 3000, 'the app uploads 3 s after a save');
});

test('a focus check runs at most every 10 s; a forced one always', async () => {
  const { server, app } = await connected();
  let now = Date.now();
  app.C.env.now = () => now;
  await app.C.pull(true); await app.settle();
  server.calls.length = 0;
  await app.C.pull(false); await app.settle();
  assert.equal(server.calls.length, 0, 'too soon after the last check');
  now += 11000;
  await app.C.pull(false); await app.settle();
  assert.equal(server.calls.length, 1, 'due');
  await app.C.pull(true); await app.settle();
  assert.equal(server.calls.length, 2, 'forced');
});

test('start-up: a named project never synced (sync all) is uploaded, without waiting for an edit', async () => {
  const { server, app } = await connected();
  app.device.projects.put(project('p7', 'Later'));
  const b = makeApp({ server, device: app.device });
  await b.C.init(); await new Promise(r => setTimeout(r, 1700)); await b.settle();
  assert.ok(fileOf(server, 'Later.gengis.json'));
});
