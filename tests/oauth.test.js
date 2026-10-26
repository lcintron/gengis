'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeServer, makeApp } = require('./harness');

const appOf = () => makeApp({ server: makeServer() });

test('PKCE challenge matches RFC 7636 appendix B', async () => {
  const { MB } = appOf();
  // the RFC's own published example verifier and challenge: a public test vector, not a credential
  assert.equal(await MB.oauth.challenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'); // ggignore
});

test('random values are URL-safe and differ', () => {
  const { MB } = appOf();
  const a = MB.oauth.random(48), b = MB.oauth.random(48);
  assert.match(a, /^[A-Za-z0-9_-]{64}$/);
  assert.notEqual(a, b);
});

test('prepare builds the authorize URL with PKCE, state and scopes', async () => {
  const { MB } = appOf();
  const cfg = MB.cloudProviders.onedrive.auth({ prompt: 'select_account' });
  const { url, pending } = await MB.oauth.prepare(cfg);
  const u = new URL(url);
  assert.equal(u.origin + u.pathname, 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize');
  const q = u.searchParams;
  assert.equal(q.get('client_id'), 'test-client');
  assert.equal(q.get('response_type'), 'code');
  assert.equal(q.get('redirect_uri'), 'https://g2.test/');
  assert.equal(q.get('code_challenge_method'), 'S256');
  assert.equal(q.get('code_challenge'), await MB.oauth.challenge(pending.verifier));
  assert.equal(q.get('state'), pending.state);
  assert.equal(q.get('prompt'), 'select_account');
  assert.deepEqual(q.get('scope').split(' ').sort(), ['Files.ReadWrite.AppFolder', 'email', 'offline_access', 'openid', 'profile']);
  assert.ok(!/client_secret/.test(url), 'no secret in a public client');
});

test('take: nothing to take without code and state', () => {
  const { MB } = appOf();
  assert.equal(MB.oauth.take('?q=Paris'), null);
  assert.equal(MB.oauth.take('?state=x'), null);
  assert.equal(MB.oauth.take(''), null);
});

test('take: a sign-in this browser did not start is refused', () => {
  const { MB } = appOf();
  const r = MB.oauth.take('?code=abc&state=zzz');
  assert.equal(r.error, 'no_pending');
});

test('take: a state that does not match is refused (and the pending sign-in forgotten)', async () => {
  const app = appOf(), { MB } = app;
  await MB.oauth.begin(MB.cloudProviders.onedrive.auth(), {}, () => {});
  const r = MB.oauth.take('?code=abc&state=forged');
  assert.equal(r.error, 'state_mismatch');
  assert.equal(r.pending, null);
  assert.equal(app.device.ls.has('gengis.oauth.pending'), false);
});

test('take: an expired pending sign-in (over 10 minutes) is refused', async () => {
  const app = appOf(), { MB } = app;
  await MB.oauth.begin(MB.cloudProviders.onedrive.auth(), {}, () => {});
  const p = JSON.parse(app.device.ls.get('gengis.oauth.pending'));
  p.at -= 11 * 60 * 1000;
  app.device.ls.set('gengis.oauth.pending', JSON.stringify(p));
  assert.equal(MB.oauth.take('?code=abc&state=' + p.state).error, 'no_pending');
});

test('take: a good answer gives the code, and the address loses the sign-in parameters but keeps the others', async () => {
  const app = appOf(), { MB } = app;
  let went = null;
  await MB.oauth.begin(MB.cloudProviders.onedrive.auth(), { silent: true }, u => { went = u; });
  assert.ok(went && went.startsWith('https://login.microsoftonline.com/'));
  const p = JSON.parse(app.device.ls.get('gengis.oauth.pending'));
  app.setSearch('?lat=1&code=CODE&state=' + p.state + '&session_state=s');
  const r = MB.oauth.take();
  assert.equal(r.code, 'CODE');
  assert.equal(r.pending.silent, true);
  assert.equal(MB.oauth.take(), null, 'the address no longer carries the code');
  assert.equal(app.device.ls.has('gengis.oauth.pending'), false, 'used once');
});

test('take: a provider error is passed on with its description', async () => {
  const app = appOf(), { MB } = app;
  await MB.oauth.begin(MB.cloudProviders.onedrive.auth(), {}, () => {});
  const p = JSON.parse(app.device.ls.get('gengis.oauth.pending'));
  const r = MB.oauth.take('?error=consent_required&error_description=AADSTS65001%3A+consent&state=' + p.state);
  assert.equal(r.error, 'consent_required');
  assert.match(MB.cloudProviders.onedrive.explain(r.error, r.description), /administrator/);
});

test('exchange: the code is only good with its own verifier', async () => {
  const server = makeServer(), app = makeApp({ server }), { MB } = app;
  const cfg = MB.cloudProviders.onedrive.auth();
  const code = server.issueCode('the-right-verifier');
  await assert.rejects(MB.oauth.exchange(cfg, code, { verifier: 'wrong', redirectUri: 'https://g2.test/' }, server.fetch), e => e.code === 'invalid_grant');
  const code2 = server.issueCode('the-right-verifier');
  const tok = await MB.oauth.exchange(cfg, code2, { verifier: 'the-right-verifier', redirectUri: 'https://g2.test/' }, server.fetch);
  assert.ok(tok.access_token && tok.refresh_token && tok.id_token);
});

test('exchange: the network failing is reported as such', async () => {
  const { MB } = appOf();
  await assert.rejects(MB.oauth.exchange(MB.cloudProviders.onedrive.auth(), 'c', { verifier: 'v', redirectUri: 'x' }, () => Promise.reject(new TypeError('Failed to fetch'))), e => e.code === 'network');
});

test('id token claims decode, including non-ASCII names', () => {
  const server = makeServer(), { MB } = makeApp({ server });
  const c = MB.oauth.idClaims(server.idToken({ name: 'José Ñúñez 地图', tid: 't' }));
  assert.equal(c.name, 'José Ñúñez 地图');
  assert.equal(Object.keys(MB.oauth.idClaims('garbage')).length, 0);
});

test('accounts: personal and work or school are told apart', () => {
  const server = makeServer(), { MB } = makeApp({ server });
  const od = MB.cloudProviders.onedrive;
  assert.equal(od.account({ id_token: server.idToken({ oid: 'a', tid: '9188040d-6c67-4c5b-b112-36a304b66dad', preferred_username: 'me@outlook.com' }) }).kind, 'personal');
  const w = od.account({ id_token: server.idToken({ oid: 'b', tid: 'contoso-tenant', preferred_username: 'me@contoso.com', name: 'Me' }) });
  assert.equal(w.kind, 'work');
  assert.equal(w.id, 'onedrive:b@contoso-tenant');
});

test('Microsoft errors are explained in words', () => {
  const { MB } = appOf(), x = MB.cloudProviders.onedrive.explain;
  assert.match(x('invalid_request', 'AADSTS53003: Access has been blocked by Conditional Access policies.'), /sign-in policy/);
  assert.match(x('unauthorized_client', 'AADSTS700016: Application not found in the directory'), /blocked GenGIS/);
  assert.match(x('invalid_grant', 'AADSTS700084: refresh token expired'), /expired/);
  assert.match(x('access_denied', ''), /cancelled/);
});
