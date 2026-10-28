/* GenGIS desktop app - signing in to OneDrive and Google Drive for cloud sync (js/cloudsync.js).
 * A page in this app (file://) cannot complete a browser sign-in itself, and should not hold long-lived tokens. So:
 * - the sign-in runs in the user's own browser (their password manager, passkeys and work-account policies apply),
 *   and comes back to a one-shot listener on this computer's loopback address (RFC 8252): authorization code with
 *   PKCE, the state checked, nothing else answered, closed after one answer or 5 minutes
 * - the refresh token stays here, encrypted by the operating system (safeStorage: DPAPI, Keychain, libsecret) in
 *   cloud-accounts.json; where encryption is not available it is kept in memory only (sign in again next time)
 * - the page only ever receives short-lived access tokens, and only the app's own page may ask (files.trusted)
 * Microsoft: GenGIS's one Entra registration (the web app's), with the "Mobile and desktop applications" platform and
 * the redirect URI http://localhost. Google: a "Desktop app" OAuth client (its id and secret are not confidential
 * for installed apps; Google's guidance). A provider without its client id is not offered. */
const { app, ipcMain, shell, safeStorage } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const files = require('./files');

function localSecret(key) {
  if (process.env.GENGIS_GOOGLE_DESKTOP_SECRET && key === 'googleDesktopSecret') return process.env.GENGIS_GOOGLE_DESKTOP_SECRET;
  try { return String(JSON.parse(fs.readFileSync(path.join(__dirname, 'cloud-secrets.json'), 'utf8'))[key] || ''); } catch (e) { return ''; }
}

const PROVIDERS = {
  onedrive: {
    clientId: '7beaabe0-cfb2-406e-b687-7eace44b2edb',
    authorize: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    token: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    scopes: ['openid', 'profile', 'email', 'offline_access', 'Files.ReadWrite.AppFolder'],
    redirect: port => 'http://localhost:' + port,
    extra: hint => Object.assign({ prompt: 'select_account' }, hint ? { login_hint: hint } : {})
  },
  gdrive: {
    clientId: '383588245973-25u5uje4bbu37dbt4nsndovk26eq6ro5.apps.googleusercontent.com', // OAuth client "Desktop app"
    // Not confidential in an installed app (Google's guidance), but kept out of the public repository: the release
    // build writes it into electron/cloud-secrets.json from a GitHub secret (a local copy of that file for development)
    clientSecret: localSecret('googleDesktopSecret'),
    authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
    token: 'https://oauth2.googleapis.com/token',
    revoke: 'https://oauth2.googleapis.com/revoke',
    scopes: ['openid', 'email', 'profile', 'https://www.googleapis.com/auth/drive.file'],
    redirect: port => 'http://127.0.0.1:' + port,
    extra: hint => Object.assign({ access_type: 'offline', prompt: 'select_account consent' }, hint ? { login_hint: hint } : {})
  }
};
const SIGN_IN_TIMEOUT = 5 * 60 * 1000;
const PERSONAL_TENANT = '9188040d-6c67-4c5b-b112-36a304b66dad';

const b64url = buf => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const claims = idToken => { try { return JSON.parse(Buffer.from(String(idToken).split('.')[1], 'base64url').toString('utf8')); } catch (e) { return {}; } };
// (Google's token endpoint refuses a desktop client without its secret: not offered in a build that lacks it)
const offered = () => Object.keys(PROVIDERS).filter(k => PROVIDERS[k].clientId && (k !== 'gdrive' || PROVIDERS[k].clientSecret));

/* ---------- the refresh tokens, encrypted on disk ---------- */
const memory = new Map(); // accountId -> { provider, refresh } where the OS offers no encryption
let env = { fetch: (u, o) => fetch(u, o), open: url => shell.openExternal(url), file: null, encryption: null };
const storeFile = () => env.file || path.join(app.getPath('userData'), 'cloud-accounts.json');
const canEncrypt = () => (env.encryption ? env.encryption.isEncryptionAvailable() : safeStorage.isEncryptionAvailable());
const enc = s => (env.encryption || safeStorage).encryptString(s).toString('base64');
const dec = s => (env.encryption || safeStorage).decryptString(Buffer.from(s, 'base64'));
function readAll() { try { return JSON.parse(fs.readFileSync(storeFile(), 'utf8')) || {}; } catch (e) { return {}; } }
function saveRefresh(accountId, provider, refresh) {
  if (!canEncrypt()) { memory.set(accountId, { provider, refresh }); return false; }
  const all = readAll();
  all[accountId] = { provider, refresh: enc(refresh), at: Date.now() };
  files.writeAtomic(storeFile(), JSON.stringify(all, null, 1));
  return true;
}
function loadRefresh(accountId) {
  if (memory.has(accountId)) return memory.get(accountId);
  const rec = readAll()[accountId];
  if (!rec) return null;
  try { return { provider: rec.provider, refresh: dec(rec.refresh) }; } catch (e) { return null; }
}
function forget(accountId) {
  memory.delete(accountId);
  const all = readAll();
  if (accountId in all) { delete all[accountId]; files.writeAtomic(storeFile(), JSON.stringify(all, null, 1)); }
}

/* ---------- the token endpoint ---------- */
async function tokenRequest(p, body) {
  if (p.clientSecret) body.client_secret = p.clientSecret;
  let res;
  try { res = await env.fetch(p.token, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body).toString() }); }
  catch (e) { const err = new Error('offline'); err.code = 'network'; throw err; }
  let json = {};
  try { json = await res.json(); } catch (e) { /* not JSON */ }
  if (!res.ok || !json.access_token) {
    const err = new Error(json.error_description || json.error || 'HTTP ' + res.status);
    err.code = json.error || (res.status >= 500 ? 'server' : 'http_' + res.status);
    throw err;
  }
  return json;
}

function accountOf(provider, tok) {
  const c = claims(tok.id_token);
  if (provider === 'onedrive') {
    const tid = c.tid || '';
    return { id: 'onedrive:' + (c.oid || c.sub) + '@' + tid, provider, name: c.name || '', email: c.preferred_username || c.email || '', kind: tid === PERSONAL_TENANT ? 'personal' : 'work' };
  }
  return { id: 'gdrive:' + c.sub, provider, name: c.name || '', email: c.email || '', kind: c.hd ? 'work' : 'personal' };
}

/* ---------- signing in: the browser and a one-shot loopback listener ---------- */
let signingIn = null; // the sign-in under way: { cancel } (one at a time; a new one replaces it)
function listen(server, host) {
  return new Promise((res, rej) => { server.once('error', rej); server.listen(0, host, () => res(server.address().port)); });
}
async function signIn(provider, hint) {
  const p = PROVIDERS[provider];
  if (!p || !p.clientId) throw Object.assign(new Error('This provider is not set up in this app'), { code: 'unavailable' });
  // A sign-in left behind (its browser tab closed, the wrong account picked) would hold the next one off until it
  // timed out: the new one replaces it, and the old one ends as 'superseded' (the page shows nothing for that).
  if (signingIn) signingIn.cancel();
  const run = {};
  signingIn = run;
  try { return await browserSignIn(p, provider, hint, run); } finally { if (signingIn === run) signingIn = null; }
}
async function browserSignIn(p, provider, hint, run) {
  const verifier = b64url(crypto.randomBytes(48)), state = b64url(crypto.randomBytes(24));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const server = http.createServer();
  let finish;
  const answered = new Promise((res, rej) => { finish = { res, rej }; });
  answered.catch(() => {}); // (awaited below; a timeout may come first)
  const superseded = () => Object.assign(new Error('Replaced by a new sign-in'), { code: 'superseded' });
  run.cancel = () => { run.dead = true; finish.rej(superseded()); }; // (once its code is in, the token call ends it below)
  server.on('request', (req, resp) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    if (u.pathname !== '/' || u.searchParams.get('state') !== state) { resp.writeHead(404); resp.end(); return; } // not the answer: ignored
    const err = u.searchParams.get('error'), code = u.searchParams.get('code');
    resp.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    resp.end(`<!doctype html><meta charset="utf-8"><title>GenGIS</title><body style="font:16px system-ui;background:#0b1118;color:#e6ebf2;display:grid;place-items:center;height:90vh"><p>${err ? 'Sign-in was not completed. You can close this tab.' : 'Signed in. You can close this tab and return to GenGIS.'}</p>`);
    if (err) finish.rej(Object.assign(new Error(u.searchParams.get('error_description') || err), { code: err }));
    else finish.res(code);
  });
  const port = await listen(server, '127.0.0.1');
  const v6 = http.createServer((req, resp) => server.emit('request', req, resp)); // "localhost" may be ::1 in the browser
  v6.on('error', () => {});
  try { v6.listen(port, '::1'); } catch (e) { /* no IPv6 */ }
  const redirect = p.redirect(port);
  const q = new URLSearchParams(Object.assign({
    client_id: p.clientId, response_type: 'code', redirect_uri: redirect, scope: p.scopes.join(' '),
    state, code_challenge: challenge, code_challenge_method: 'S256'
  }, p.extra(hint)));
  const timer = setTimeout(() => finish.rej(Object.assign(new Error('The sign-in took too long'), { code: 'timeout' })), env.timeout || SIGN_IN_TIMEOUT);
  try {
    await env.open(p.authorize + '?' + q.toString());
    const code = await answered;
    const tok = await tokenRequest(p, { grant_type: 'authorization_code', code, redirect_uri: redirect, code_verifier: verifier, client_id: p.clientId, scope: p.scopes.join(' ') });
    if (run.dead) throw superseded(); // the last sign-in started is the one that counts
    const account = accountOf(provider, tok);
    const kept = tok.refresh_token ? saveRefresh(account.id, provider, tok.refresh_token) : false;
    return { account, accessToken: tok.access_token, expiresIn: +tok.expires_in || 3600, kept };
  } finally {
    clearTimeout(timer);
    server.close(); try { v6.close(); } catch (e) { /* closed */ }
  }
}

// A fresh access token for an account signed in here.
async function token(accountId) {
  const rec = loadRefresh(accountId);
  if (!rec) return { error: 'signin', message: 'Sign in again' };
  const p = PROVIDERS[rec.provider];
  try {
    const tok = await tokenRequest(p, { grant_type: 'refresh_token', refresh_token: rec.refresh, client_id: p.clientId, scope: p.scopes.join(' ') });
    if (tok.refresh_token && tok.refresh_token !== rec.refresh) saveRefresh(accountId, rec.provider, tok.refresh_token);
    return { accessToken: tok.access_token, expiresIn: +tok.expires_in || 3600 };
  } catch (e) {
    if (e.code === 'network' || e.code === 'server') return { error: e.code, message: e.message };
    return { error: 'signin', message: e.message };
  }
}

async function signOut(accountId) {
  const rec = loadRefresh(accountId);
  forget(accountId);
  const p = rec && PROVIDERS[rec.provider];
  if (p && p.revoke) { try { await env.fetch(p.revoke + '?token=' + encodeURIComponent(rec.refresh), { method: 'POST' }); } catch (e) { /* forgotten here either way */ } }
  return { ok: true };
}

/* ---------- the cloud's HTTP, for the page ----------
 * The page (file://) has no web origin, so the cloud APIs' CORS answers do not fit it. Its cloud requests come here
 * instead: HTTPS to these hosts only (the APIs, and the upload and download addresses they hand out), any other
 * address refused. The page's own access token goes with each, as on the web. */
const CLOUD_HOSTS = /^(graph\.microsoft\.com|api\.onedrive\.com|[\w-]+\.sharepoint\.com|[\w.-]+\.1drv\.com|[\w.-]+\.microsoftpersonalcontent\.com|[\w.-]+\.storage\.live\.com|www\.googleapis\.com|oauth2\.googleapis\.com)$/i;
const METHODS = ['GET', 'PUT', 'POST', 'PATCH', 'DELETE'];
const KEEP_HEADERS = ['content-type', 'location', 'retry-after', 'etag', 'range'];
const MAX_BODY = 210 * 1024 * 1024;
function cloudUrl(v) {
  try { const u = new URL(v); return u.protocol === 'https:' && !u.username && !u.password && !u.port && CLOUD_HOSTS.test(u.hostname) ? u : null; } catch (e) { return null; }
}
async function cloudFetch(o) {
  const u = o && cloudUrl(o.url), method = String((o && o.method) || 'GET').toUpperCase();
  if (!u || !METHODS.includes(method)) return { error: 'bad_request' };
  const headers = {};
  Object.entries(o.headers && typeof o.headers === 'object' ? o.headers : {}).forEach(([k, v]) => { if (/^[\w-]{1,64}$/.test(k) && typeof v === 'string' && !/[\r\n]/.test(v)) headers[k] = v; });
  const body = o.body == null ? undefined : (typeof o.body === 'string' ? o.body : Buffer.from(o.body));
  if (body && body.length > MAX_BODY) return { error: 'too_large' };
  let res;
  // (a redirect is not followed here: it goes back to the page, whose next request is checked like this one)
  try { res = await env.fetch(u.toString(), { method, headers, body, redirect: 'manual' }); }
  catch (e) { return { error: 'network', message: e.message }; }
  const out = {};
  KEEP_HEADERS.forEach(h => { const v = res.headers.get(h); if (v != null) out[h] = v; });
  return { status: res.status, headers: out, body: Buffer.from(await res.arrayBuffer()) };
}

const okId = v => typeof v === 'string' && /^(onedrive|gdrive):[\w.@!-]{1,300}$/.test(v);
const okHint = v => v == null || (typeof v === 'string' && v.length < 320 && !/[\r\n]/.test(v));

function register() {
  ipcMain.on('cloud:providers', e => { e.returnValue = files.trusted(e) ? offered() : []; });
  ipcMain.handle('cloud:signin', async (e, o) => {
    if (!files.trusted(e)) throw new Error('not allowed from this page');
    if (!o || !PROVIDERS[o.provider] || !okHint(o.hint)) return { error: 'bad_request' };
    try { return await signIn(o.provider, o.hint || ''); } catch (err) { return { error: err.code || 'failed', message: err.message }; }
  });
  ipcMain.handle('cloud:token', async (e, o) => {
    if (!files.trusted(e)) throw new Error('not allowed from this page');
    if (!o || !okId(o.accountId)) return { error: 'bad_request' };
    return token(o.accountId);
  });
  ipcMain.handle('cloud:signout', async (e, o) => {
    if (!files.trusted(e)) throw new Error('not allowed from this page');
    if (!o || !okId(o.accountId)) return { error: 'bad_request' };
    return signOut(o.accountId);
  });
  ipcMain.handle('cloud:fetch', async (e, o) => {
    if (!files.trusted(e)) throw new Error('not allowed from this page');
    return cloudFetch(o);
  });
}

// (tests: a stand-in fetch, browser, file and encryption)
const _test = { set: o => { env = Object.assign({}, env, o); }, PROVIDERS, signIn, token, signOut, accountOf, cloudFetch, cloudUrl };
module.exports = { register, offered, _test };
