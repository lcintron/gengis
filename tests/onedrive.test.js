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
