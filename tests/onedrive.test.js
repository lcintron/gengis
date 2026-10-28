'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeServer, makeApp, CHUNK_UNIT } = require('./harness');

// An adapter context with a valid token straight from the fake server.
async function setup(opts) {
  const server = makeServer(opts), app = makeApp({ server });
  const od = app.MB.cloudProviders.onedrive;
  const code = server.issueCode('v');
  const tok = await app.MB.oauth.exchange(od.auth(), code, { verifier: 'v', redirectUri: 'https://g2.test/' }, server.fetch);
  let access = tok.access_token;
  const ctx = { fetch: server.fetch, token: async () => access, setToken: t => { access = t; } };
  return { server, app, od, ctx };
}

test('create, read back, and a second create with the same name is refused (409)', async () => {
  const { od, ctx, server } = await setup();
  const a = await od.put(ctx, { name: 'Map.gengis.json', text: '{"a":1}' });
  assert.ok(a.fileId && a.etag);
  assert.equal((await od.get(ctx, a.fileId)).text, '{"a":1}');
  await assert.rejects(od.put(ctx, { name: 'map.GENGIS.json', text: '{}' }), e => e.status === 409);
  assert.equal(server.live().length, 1);
});

test('update with the eTag last seen; a stale eTag is refused (412) and nothing is overwritten', async () => {
  const { od, ctx, server } = await setup();
  const a = await od.put(ctx, { name: 'M.gengis.json', text: 'v1' });
  const b = await od.put(ctx, { fileId: a.fileId, text: 'v2', ifMatch: a.etag });
  assert.notEqual(b.etag, a.etag);
  await assert.rejects(od.put(ctx, { fileId: a.fileId, text: 'v3', ifMatch: a.etag }), e => e.status === 412);
  assert.equal(server.files.get(a.fileId).content.toString(), 'v2');
});

test('a deleted file answers 404', async () => {
  const { od, ctx, server } = await setup();
  const a = await od.put(ctx, { name: 'D.gengis.json', text: 'x' });
  server.deleteRemote(a.fileId);
  await assert.rejects(od.put(ctx, { fileId: a.fileId, text: 'y', ifMatch: a.etag }), e => e.status === 404);
});

test('large files go up in an upload session: 320 KiB-multiple chunks, byte-exact', async () => {
  const { od, ctx, server } = await setup();
  const big = JSON.stringify({ blob: 'x'.repeat(21 * 1024 * 1024 + 12345), u: 'ñ地' });
  const progress = [];
  const a = await od.put(ctx, { name: 'Big.gengis.json', text: big, onProgress: (d, t) => progress.push([d, t]) });
  assert.equal(server.files.get(a.fileId).content.toString(), big);
  assert.ok(server.chunkSizes.length >= 5, 'several chunks');
  server.chunkSizes.slice(0, -1).forEach(n => assert.equal(n % CHUNK_UNIT, 0));
  assert.equal(progress[progress.length - 1][0], Buffer.byteLength(big));
  // and an update of the large file is guarded by its eTag too
  await assert.rejects(od.put(ctx, { fileId: a.fileId, text: big + ' ', ifMatch: '"stale"' }), e => e.status === 412);
  const b = await od.put(ctx, { fileId: a.fileId, text: big + ' ', ifMatch: a.etag });
  assert.equal(server.files.get(b.fileId).content.length, Buffer.byteLength(big) + 1);
});

// A context whose chunk uploads fail on the nth one: 'network' before it is sent, 'lost' after it arrived (its answer lost).
function flaky(ctx, server, n, how) {
  let count = 0;
  return Object.assign({}, ctx, { fetch: async (url, o) => {
    const chunk = /^https:\/\/upload\.test\//.test(url) && o && o.method === 'PUT';
    if (chunk && ++count === n) {
      if (how === 'lost') await server.fetch(url, o);
      throw new TypeError('Failed to fetch');
    }
    return server.fetch(url, o);
  } });
}
const sessionsMade = server => server.calls.filter(c => /createUploadSession/.test(c.url)).length;

test('an interrupted large upload goes on from what OneDrive has when the same content is written again', async () => {
  const { od, ctx, server } = await setup();
  const big = JSON.stringify({ blob: 'r'.repeat(18 * 1024 * 1024) });
  await assert.rejects(od.put(flaky(ctx, server, 3), { name: 'R.gengis.json', text: big }), e => e.code === 'network');
  const sent = server.chunkSizes.reduce((a, b) => a + b, 0);
  assert.ok(sent > 0 && sent < Buffer.byteLength(big));
  server.chunkSizes.length = 0;
  const progress = [];
  const a = await od.put(ctx, { name: 'R.gengis.json', text: big, onProgress: d => progress.push(d) });
  assert.equal(sessionsMade(server), 1, 'the same session');
  assert.equal(server.chunkSizes.reduce((x, y) => x + y, 0), Buffer.byteLength(big) - sent, 'only the rest was sent');
  assert.equal(progress[0], sent, 'progress starts where it left off');
  assert.equal(server.files.get(a.fileId).content.toString(), big);
  assert.equal(od._sessions.size, 0);
});

test('a chunk that arrived though its answer was lost is not sent again', async () => {
  const { od, ctx, server } = await setup();
  const big = JSON.stringify({ blob: 'l'.repeat(13 * 1024 * 1024) });
  await assert.rejects(od.put(flaky(ctx, server, 2, 'lost'), { name: 'L.gengis.json', text: big }), e => e.code === 'network');
  const a = await od.put(ctx, { name: 'L.gengis.json', text: big });
  assert.equal(sessionsMade(server), 1);
  assert.equal(server.chunkSizes.reduce((x, y) => x + y, 0), Buffer.byteLength(big), 'every byte sent once');
  assert.equal(server.files.get(a.fileId).content.toString(), big);
});

test('different content after an interruption starts a new session (the old one is cancelled)', async () => {
  const { od, ctx, server } = await setup();
  const big = JSON.stringify({ blob: 'd'.repeat(13 * 1024 * 1024) });
  await assert.rejects(od.put(flaky(ctx, server, 2), { name: 'N.gengis.json', text: big }), e => e.code === 'network');
  const a = await od.put(ctx, { name: 'N.gengis.json', text: big + ' ' });
  assert.equal(sessionsMade(server), 2);
  await new Promise(r => setTimeout(r, 0));
  assert.equal(server.sessions.size, 0, 'the cut-short session was cancelled');
  assert.equal(server.files.get(a.fileId).content.toString(), big + ' ');
});

test('a session that ended over there (expired) starts again from the start, never answering 404', async () => {
  const { od, ctx, server } = await setup();
  const big = JSON.stringify({ blob: 'e'.repeat(13 * 1024 * 1024) });
  await assert.rejects(od.put(flaky(ctx, server, 2), { name: 'E.gengis.json', text: big }), e => e.code === 'network');
  server.sessions.clear(); // expired
  const a = await od.put(ctx, { name: 'E.gengis.json', text: big });
  assert.equal(sessionsMade(server), 2);
  assert.equal(server.files.get(a.fileId).content.toString(), big);
  // ...and one that ends between chunks: a new session at once
  let n = 0;
  const cut = Object.assign({}, ctx, { fetch: async (url, o) => {
    if (/^https:\/\/upload\.test\//.test(url) && o.method === 'PUT' && ++n === 2) server.sessions.clear();
    return server.fetch(url, o);
  } });
  const b = await od.put(cut, { fileId: a.fileId, text: big + '!', ifMatch: a.etag });
  assert.equal(server.files.get(b.fileId).content.toString(), big + '!');
});

test('a guarded update cut short is not resumed over a change made elsewhere meanwhile (412)', async () => {
  const { od, ctx, server } = await setup();
  const big = JSON.stringify({ blob: 'g'.repeat(13 * 1024 * 1024) });
  const a = await od.put(ctx, { name: 'G.gengis.json', text: 'small' });
  await assert.rejects(od.put(flaky(ctx, server, 2), { fileId: a.fileId, text: big, ifMatch: a.etag }), e => e.code === 'network');
  server.writeRemote(a.fileId, 'changed elsewhere');
  await assert.rejects(od.put(ctx, { fileId: a.fileId, text: big, ifMatch: a.etag }), e => e.status === 412);
  assert.equal(server.files.get(a.fileId).content.toString(), 'changed elsewhere');
});

test('a guarded update that finished though its last answer was lost is no conflict when tried again', async () => {
  const { od, ctx, server } = await setup();
  const big = JSON.stringify({ blob: 'f'.repeat(13 * 1024 * 1024) });
  const a = await od.put(ctx, { name: 'F.gengis.json', text: 'small' });
  const chunksIn = Math.ceil(Buffer.byteLength(big) / (16 * CHUNK_UNIT));
  await assert.rejects(od.put(flaky(ctx, server, chunksIn, 'lost'), { fileId: a.fileId, text: big, ifMatch: a.etag }), e => e.code === 'network');
  assert.equal(server.files.get(a.fileId).content.toString(), big, 'it did finish over there');
  const b = await od.put(ctx, { fileId: a.fileId, text: big, ifMatch: a.etag });
  assert.equal(b.fileId, a.fileId);
  assert.notEqual(b.etag, a.etag, 'the version it now has');
  assert.equal(sessionsMade(server), 1, 'nothing uploaded again');
  // ...but a different change made elsewhere is still a conflict
  await assert.rejects(od.put(flaky(ctx, server, 1), { fileId: a.fileId, text: big + 'x', ifMatch: b.etag }), e => e.code === 'network');
  server.writeRemote(a.fileId, 'elsewhere');
  await assert.rejects(od.put(ctx, { fileId: a.fileId, text: big + 'x', ifMatch: b.etag }), e => e.status === 412);
});

test('few cut-short sessions are kept, the oldest given up first (each holds a project\'s text)', async () => {
  const { od, ctx, server } = await setup();
  const big = JSON.stringify({ blob: 'k'.repeat(6 * 1024 * 1024) });
  for (let i = 0; i < 7; i++) await assert.rejects(od.put(flaky(ctx, server, 2), { name: 'K' + i + '.gengis.json', text: big }), e => e.code === 'network');
  assert.equal(od._sessions.size, 4);
  assert.ok([...od._sessions.keys()].every(k => /K[3-6]\.gengis\.json/.test(k)), 'the newest kept');
  await new Promise(r => setTimeout(r, 0));
  assert.equal(server.sessions.size, 4, 'the others cancelled over there');
});

test('the 4 MiB boundary: just under goes in one request, just over in a session', async () => {
  const { od, ctx, server } = await setup();
  const under = 'a'.repeat(4 * 1024 * 1024), over = under + 'b';
  server.calls.length = 0;
  await od.put(ctx, { name: 'U.gengis.json', text: under });
  assert.ok(!server.calls.some(c => /createUploadSession/.test(c.url)));
  await od.put(ctx, { name: 'O.gengis.json', text: over });
  assert.ok(server.calls.some(c => /createUploadSession/.test(c.url)));
});

test('names with special and non-ASCII characters round-trip', async () => {
  const { od, ctx, server } = await setup();
  for (const name of ["Mapa de José ñ 地图.gengis.json", "it's #1 & 100%.gengis.json", 'emoji 🗺️ map.gengis.json', 'a+b=c;d,e.gengis.json']) {
    const a = await od.put(ctx, { name, text: name });
    assert.equal(server.files.get(a.fileId).name, name);
    assert.equal(a.name, name);
  }
});

test('rename, and a rename onto a taken name is refused (409)', async () => {
  const { od, ctx } = await setup();
  const a = await od.put(ctx, { name: 'A.gengis.json', text: 'a' });
  await od.put(ctx, { name: 'B.gengis.json', text: 'b' });
  const r = await od.rename(ctx, a.fileId, 'C.gengis.json');
  assert.equal(r.name, 'C.gengis.json');
  await assert.rejects(od.rename(ctx, a.fileId, 'B.gengis.json'), e => e.status === 409);
});

test('list follows the pages and returns only project files', async () => {
  const { od, ctx, server } = await setup({ pageSize: 7 });
  for (let i = 0; i < 40; i++) server.create('P' + i + '.gengis.json', '{}');
  server.create('notes.txt', 'x');
  const files = await od.list(ctx);
  assert.equal(files.length, 40);
  assert.equal(new Set(files.map(f => f.fileId)).size, 40);
});

test('changes: everything first, then only what changed, across pages; deletions included', async () => {
  const { od, ctx, server } = await setup({ pageSize: 5 });
  const ids = [];
  for (let i = 0; i < 12; i++) ids.push(server.create('P' + i + '.gengis.json', '{}').id);
  const first = await od.changes(ctx, null);
  assert.equal(first.items.length, 12);
  assert.ok(first.cursor);
  server.writeRemote(ids[3], 'new');
  server.deleteRemote(ids[4]);
  const next = await od.changes(ctx, first.cursor);
  assert.deepEqual(Array.from(next.items, i => i.fileId).sort(), [ids[3], ids[4]].sort());
  assert.ok(next.items.find(i => i.fileId === ids[4]).deleted);
  const none = await od.changes(ctx, next.cursor);
  assert.equal(none.items.length, 0);
});

test('changes: a cursor that is too old asks for a full resync', async () => {
  const { od, ctx, server } = await setup();
  server.create('P.gengis.json', '{}');
  const first = await od.changes(ctx, null);
  server.tooOld.add(new URL(first.cursor).searchParams.get('token'));
  const r = await od.changes(ctx, first.cursor);
  assert.equal(r.reset, true);
});

test('an expired access token is a 401, and Retry-After is passed on', async () => {
  const { od, ctx, server } = await setup();
  server.expireAccessTokens();
  await assert.rejects(od.list(ctx), e => e.status === 401);
  ctx.setToken('nope');
  server.fail = () => ({ status: 429, ok: false, headers: { get: k => (k === 'Retry-After' ? '7' : null) }, json: async () => ({ error: { code: 'activityLimitReached' } }) });
  await assert.rejects(od.list(ctx), e => e.status === 429 && e.retryAfter === 7);
});

test('a network failure is reported as code network', async () => {
  const { od, ctx, server } = await setup();
  server.fail = () => 'network';
  await assert.rejects(od.put(ctx, { name: 'X.gengis.json', text: 'x' }), e => e.code === 'network');
});

test('the folder is named by its path once: requests made together before it exists share that one request, and go by its id', async () => {
  const { od, ctx, server } = await setup({ fresh: true });
  const [files, a, ch] = await Promise.all([od.list(ctx), od.put(ctx, { name: 'First.gengis.json', text: '{"a":1}' }), od.changes(ctx, null)]);
  assert.equal(server.folders.length, 1, 'one folder');
  assert.equal(server.root.name, 'GenGIS');
  assert.equal(server.calls.filter(c => /special\/approot/.test(c.url)).length, 1, 'approot named once');
  server.calls.filter(c => /special\/approot/.test(c.url)).forEach(c => assert.match(c.url, /special\/approot\?/, 'by path only to ask which folder it is'));
  assert.equal(server.files.get(a.fileId).root, server.root.id);
  assert.ok(Array.isArray(files) && ch.items.length <= 1);
  assert.deepEqual(Array.from(await od.list(ctx), f => f.name), ['First.gengis.json']);
});

test('a guarded update cut short, the file grown too large to read meanwhile: a conflict (412), not an error', async () => {
  const { od, ctx, server } = await setup();
  const big = JSON.stringify({ blob: 'h'.repeat(13 * 1024 * 1024) });
  const a = await od.put(ctx, { name: 'H.gengis.json', text: 'small' });
  await assert.rejects(od.put(flaky(ctx, server, 2), { fileId: a.fileId, text: big, ifMatch: a.etag }), e => e.code === 'network');
  server.writeRemote(a.fileId, 'changed elsewhere');
  server.sizeOf.set(a.fileId, 900 * 1024 * 1024);
  await assert.rejects(od.put(ctx, { fileId: a.fileId, text: big, ifMatch: a.etag }), e => e.status === 412 && e.code !== 'tooLarge');
  assert.equal(server.files.get(a.fileId).content.toString(), 'changed elsewhere');
});
