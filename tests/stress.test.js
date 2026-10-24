'use strict';
// Load, stress, chaos and performance tests for cloud sync.
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeServer, makeApp, project } = require('./harness');

const rng = seed => () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
const fault = (status, retryAfter) => ({ status, ok: false, headers: { get: k => (k === 'Retry-After' && retryAfter != null ? String(retryAfter) : null) }, json: async () => ({ error: { code: 'injected' } }) });
const report = (name, v) => console.log('  [perf] ' + name + ': ' + v);

test('load: 300 projects sync on connect, one file each, byte-for-byte', { timeout: 120000 }, async () => {
  const server = makeServer({ pageSize: 100 }), app = makeApp({ server });
  for (let i = 0; i < 300; i++) app.device.projects.put(project('p' + i, 'Project ' + i, 1 + (i % 20)));
  const t0 = Date.now();
  await app.connect(); await app.settle(60000);
  const ms = Date.now() - t0;
  report('300 projects connected and uploaded', ms + ' ms, ' + server.calls.length + ' requests');
  assert.equal(server.live().length, 300);
  for (let i = 0; i < 300; i++) {
    const f = server.live().find(x => x.name === 'Project ' + i + '.gengis.json');
    assert.equal(JSON.parse(f.content.toString()).features.length, 1 + (i % 20));
  }
  assert.ok(Object.values(app.C.links).every(l => l.state === 'synced'));
  assert.ok(server.calls.filter(c => c.method === 'PUT').length <= 300, 'one upload per project');
});

test('load with faults: 200 projects, 20% of requests fail (429, 503, network): all end synced and correct', { timeout: 180000 }, async () => {
  const server = makeServer(), app = makeApp({ server });
  for (let i = 0; i < 200; i++) app.device.projects.put(project('p' + i, 'P' + i, 2 + (i % 5)));
  app.C.env.backoffBase = 5;
  await app.connect();
  const r = rng(42);
  let injected = 0;
  server.fail = req => {
    if (req.url.includes('/token')) return null;
    if (r() >= 0.2) return null;
    injected++;
    const k = r();
    return k < 0.4 ? fault(429, 0) : (k < 0.8 ? fault(503) : 'network');
  };
  // a dropped request while the device is online is retried like any passing failure
  for (let round = 0; round < 40 && !(Object.values(app.C.links).length === 200 && Object.values(app.C.links).every(l => l.state === 'synced')); round++) {
    await new Promise(res => setTimeout(res, 300));
    await app.settle(60000);
  }
  report('faults injected', injected);
  server.fail = null;
  assert.equal(server.live().length, 200, 'no duplicate or missing files');
  const states = Object.values(app.C.links).map(l => l.state);
  assert.deepEqual([...new Set(states)], ['synced']);
  for (let i = 0; i < 200; i++) assert.equal(JSON.parse(server.live().find(f => f.name === 'P' + i + '.gengis.json').content.toString()).features.length, 2 + (i % 5));
});

test('stress: 5,000 saves across 50 projects in bursts: few uploads, the cloud ends with every latest version', { timeout: 120000 }, async () => {
  const server = makeServer(), app = makeApp({ server, pushDelay: 80 });
  for (let i = 0; i < 50; i++) app.device.projects.put(project('p' + i, 'S' + i, 1));
  await app.connect(); await app.settle(60000);
  server.calls.length = 0;
  const last = {};
  const r = rng(7);
  for (let n = 0; n < 5000; n++) {
    const i = Math.floor(r() * 50), count = 2 + Math.floor(r() * 300);
    last[i] = count;
    app.save(project('p' + i, 'S' + i, count));
    if (n % 500 === 0) await new Promise(res => setTimeout(res, 120)); // a pause between bursts
  }
  await app.settle(60000);
  const puts = server.calls.filter(c => c.method === 'PUT').length;
  report('uploads for 5,000 saves', puts);
  assert.ok(puts <= 50 * 11, 'debounced: at most one upload per project per burst');
  Object.keys(last).forEach(i => assert.equal(JSON.parse(server.live().find(f => f.name === 'S' + i + '.gengis.json').content.toString()).features.length, last[i]));
});

test('chaos: two devices editing the same projects with faults and offline spells never lose either device\'s latest work', { timeout: 300000 }, async () => {
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    const r = rng(seed);
    const server = makeServer();
    const A = makeApp({ server, pushDelay: 10 }), B = makeApp({ server, pushDelay: 10 });
    A.C.env.backoffBase = 5; B.C.env.backoffBase = 5;
    const ids = ['c1', 'c2', 'c3'];
    const lastRev = { A: {}, B: {} };
    let rev = 0;
    const saveOn = (dev, name, id) => {
      const tag = name + '-' + (++rev);
      lastRev[name][id] = tag;
      dev.save(project(id, 'Chaos ' + id, 1 + (rev % 9), { rev: tag }));
    };
    ids.forEach(id => { A.device.projects.put(project(id, 'Chaos ' + id, 1, { rev: 'A-0' })); lastRev.A[id] = 'A-0'; });
    await A.connect(); await A.settle();
    // B signs in to the same account and opens the projects from the cloud
    await B.connect(); await B.settle();
    for (const f of await B.C.listRemote(B.C.accounts[0].id)) {
      await B.C.openRemote(B.C.accounts[0].id, f.fileId);
      const data = B.loaded[B.loaded.length - 1];
      B.device.projects.put(data); lastRev.B[data.id] = data.rev;
    }
    await B.settle();
    for (let step = 0; step < 60; step++) {
      const k = r(), dev = r() < 0.5 ? ['A', A] : ['B', B], id = ids[Math.floor(r() * ids.length)];
      server.fail = r() < 0.15 ? (req => (req.url.includes('/token') || r() > 0.5 ? null : (r() < 0.5 ? fault(503) : 'network'))) : null;
      if (k < 0.55) saveOn(dev[1], dev[0], id);
      else if (k < 0.8) await dev[1].C.pull(true);
      else if (k < 0.9) dev[1].setOnline(false);
      else dev[1].setOnline(true);
      await new Promise(res => setTimeout(res, 5));
    }
    // calm: network back, no faults, everything settles; conflicts resolved by keeping both
    server.fail = null;
    for (let round = 0; round < 8; round++) {
      for (const d of [A, B]) {
        d.setOnline(true);
        await d.settle(30000);
        await d.C.pull(true); await d.settle(30000);
        for (const l of Object.values(d.C.links)) if (l.state === 'conflict') { await d.C.resolve(l.projectId, 'both'); await d.settle(30000); }
      }
    }
    // every device's latest version of every project survives somewhere: on a device, in a recovery copy, or in the cloud
    const everywhere = new Set();
    for (const d of [A, B]) {
      d.device.projects.recs.forEach(rec => everywhere.add(rec.data.rev));
      d.device.projects.copies.forEach(c => everywhere.add(c.data.rev));
    }
    server.live().forEach(f => { try { everywhere.add(JSON.parse(f.content.toString()).rev); } catch (e) { /* not a project */ } });
    for (const name of ['A', 'B']) for (const id of ids) assert.ok(everywhere.has(lastRev[name][id]), `seed ${seed}: ${name}'s latest ${id} (${lastRev[name][id]}) was lost`);
    // and the devices agree with the cloud for every project that is synced
    for (const d of [A, B]) for (const l of Object.values(d.C.links)) {
      if (l.excluded || l.state !== 'synced') continue;
      const f = server.files.get(l.fileId);
      assert.ok(f && !f.deleted, `seed ${seed}: a synced project points at a missing file`);
      assert.equal(await d.C.hashOf(JSON.parse(f.content.toString())), await d.C.hashOf(d.device.projects.recs.get(l.projectId).data), `seed ${seed}: ${l.projectId} differs from the cloud while "synced"`);
    }
  }
});

test('performance: change detection on very large projects', { timeout: 120000 }, async () => {
  const server = makeServer(), app = makeApp({ server });
  const C = app.C;
  const many = project('big', 'Big', 20000);   // 20,000 objects
  const pics = project('pic', 'Pics', 50, { svgLibrary: Object.fromEntries(Array.from({ length: 8 }, (_, i) => ['img' + i, { dataUrl: 'data:image/png;base64,' + 'B'.repeat(2.5 * 1024 * 1024) }])) }); // 20 MB of pictures
  for (const [name, p] of [['20,000 objects (' + (JSON.stringify(many).length / 1e6).toFixed(1) + ' MB)', many], ['20 MB of pictures', pics]]) {
    await C.hashOf(p); // warm up
    const t0 = process.hrtime.bigint();
    const runs = 5;
    for (let i = 0; i < runs; i++) await C.hashOf(p);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6 / runs;
    report('change check, ' + name, ms.toFixed(1) + ' ms');
    assert.ok(ms < 1500, 'a change check stays well under the 5 s upload delay even on a slow phone (x4)');
  }
  // the view never changes the hash; any object change does
  const h = await C.hashOf(many);
  assert.equal(await C.hashOf(Object.assign({}, many, { view: { lat: 1, lng: 2, zoom: 3 }, savedAt: 'x' })), h);
  const edited = JSON.parse(JSON.stringify(many)); edited.features[19999].name = 'changed';
  assert.notEqual(await C.hashOf(edited), h);
  // key order does not matter
  const flip = v => Array.isArray(v) ? v.map(flip) : (v && typeof v === 'object' ? Object.keys(v).reverse().reduce((o, k) => { o[k] = flip(v[k]); return o; }, {}) : v);
  const reordered = flip(many);
  assert.equal(await C.hashOf(reordered), h);
});

test('performance: requests per action stay minimal', { timeout: 60000 }, async () => {
  const server = makeServer(), app = makeApp({ server });
  app.device.projects.put(project('p1', 'Alpha'));
  await app.connect(); await app.settle();
  server.calls.length = 0;
  await app.C.pull(true); await app.settle();
  assert.equal(server.calls.length, 1, 'a check with no changes is one request');
  server.calls.length = 0;
  app.save(project('p1', 'Alpha', 2)); await app.settle();
  assert.equal(server.calls.length, 1, 'an edit is one upload');
  server.calls.length = 0;
  app.save(project('p1', 'Alpha', 2)); await app.settle();
  assert.equal(server.calls.length, 0, 'an unchanged save sends nothing');
});

test('performance: memory stays flat over 2,000 sync cycles', { timeout: 180000 }, async () => {
  const server = makeServer(), app = makeApp({ server });
  app.device.projects.put(project('p1', 'Alpha', 50));
  await app.connect(); await app.settle();
  const cycle = async n => { for (let i = 0; i < n; i++) { app.save(project('p1', 'Alpha', 50 + (i % 30))); await app.C._push('p1'); } };
  await cycle(200);
  if (global.gc) global.gc();
  const before = process.memoryUsage().heapUsed;
  await cycle(2000);
  if (global.gc) global.gc();
  const grew = (process.memoryUsage().heapUsed - before) / 1048576;
  report('heap growth over 2,000 cycles', grew.toFixed(1) + ' MB (server keeps every file in memory)');
  assert.ok(grew < 60, 'no leak: ' + grew.toFixed(1) + ' MB');
});
