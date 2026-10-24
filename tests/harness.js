// Test harness for cloud sync: a fake Microsoft (sign-in + Graph, in memory, with fault injection) and a way to load
// the real browser modules (js/oauth.js, js/cloud-onedrive.js, js/cloudsync.js) into a sandbox that talks to it.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const ROOT = process.env.GENGIS_ROOT || path.join(__dirname, '..'); // (GENGIS_ROOT: run the tests against another copy of the code)
const GRAPH = 'https://graph.microsoft.com/v1.0';
const LOGIN = 'https://login.microsoftonline.com/common/oauth2/v2.0';
const UPLOAD = 'https://upload.test/session/';
const CHUNK_UNIT = 320 * 1024;

const b64url = buf => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const sha256url = s => b64url(crypto.createHash('sha256').update(s).digest());

class Res {
  constructor(status, body, headers) { this.status = status; this.ok = status >= 200 && status < 300; this._body = body; this.headers = new Map(Object.entries(headers || {})); this.headers.get = k => Map.prototype.get.call(this.headers, k); }
  async json() { if (typeof this._body === 'string') return JSON.parse(this._body); if (Buffer.isBuffer(this._body)) return JSON.parse(this._body.toString('utf8')); return this._body; }
  async text() { if (Buffer.isBuffer(this._body)) return this._body.toString('utf8'); return typeof this._body === 'string' ? this._body : JSON.stringify(this._body); }
}
const json = (status, body, headers) => new Res(status, body, headers);
const gerr = (status, code, message, headers) => json(status, { error: { code, message: message || code } }, headers);

// ---------------------------------------------------------------- fake Microsoft
function makeServer(opts) {
  opts = opts || {};
  const S = {
    files: new Map(),          // id -> { id, name, content: Buffer, version, modified, deleted }
    log: [],                   // change log: { seq, id }
    seq: 0, ids: 0,
    tokens: new Map(),         // access token -> expires (ms)
    refresh: new Map(),        // refresh token -> { valid }
    codes: new Map(),          // code -> challenge
    sessions: new Map(),       // upload session id -> { fileId|null, name, total, parts: [], conflict, ifMatch }
    calls: [],                 // every request: { method, url }
    fail: null,                // (req) => Res | 'network' | null : fault injection
    refreshFails: false,       // the refresh token is refused (expired sign-in)
    pageSize: opts.pageSize || 50,
    latency: opts.latency || 0,
    now: () => Date.now(),
    tooOld: new Set(),         // delta tokens answered with 410
    noDelta: false,            // this drive offers no change feed for the folder (403)
    omitEtag: false,           // write answers come without an eTag
    hidden: new Set(),         // file ids a listing does not show yet (it lags behind a write)
    sizeOf: new Map(),         // file id -> size reported in its metadata (a huge file without sending one)
    chunkSizes: []
  };
  const etag = f => `"{${f.id}},${f.version}"`;
  const item = f => ({ id: f.id, name: f.name, eTag: etag(f), size: S.sizeOf.get(f.id) || f.content.length, lastModifiedDateTime: new Date(f.modified).toISOString(), file: { mimeType: 'application/json' } });
  const touch = f => { f.version++; f.modified = S.now(); S.log.push({ seq: ++S.seq, id: f.id }); };
  const byName = name => [...S.files.values()].find(f => !f.deleted && f.name.toLowerCase() === name.toLowerCase());
  S.create = (name, content) => {
    const f = { id: 'F' + (++S.ids), name, content: Buffer.from(content), version: 0, modified: S.now(), deleted: false };
    S.files.set(f.id, f); touch(f); return f;
  };
  // another device (or the user in OneDrive) changes a file
  S.writeRemote = (id, content) => { const f = S.files.get(id); f.content = Buffer.from(content); touch(f); return f; };
  S.deleteRemote = id => { const f = S.files.get(id); f.deleted = true; touch(f); };
  S.renameRemote = (id, name) => { const f = S.files.get(id); f.name = name; touch(f); };
  S.live = () => [...S.files.values()].filter(f => !f.deleted);
  S.issueCode = verifier => { const code = 'code-' + crypto.randomBytes(6).toString('hex'); S.codes.set(code, sha256url(verifier)); return code; };
  S.idToken = claims => 'eyJhbGciOiJub25lIn0.' + b64url(JSON.stringify(claims)) + '.sig';
  S.claims = { oid: 'user-1', tid: '9188040d-6c67-4c5b-b112-36a304b66dad', name: 'Test User', preferred_username: 'test@example.com' };
  function issue() {
    const access = 'at-' + crypto.randomBytes(8).toString('hex'), refresh = 'rt-' + crypto.randomBytes(8).toString('hex');
    S.tokens.set(access, S.now() + 3600 * 1000);
    S.refresh.set(refresh, { valid: true });
    return { token_type: 'Bearer', access_token: access, refresh_token: refresh, expires_in: 3600, id_token: S.idToken(S.claims), scope: 'Files.ReadWrite.AppFolder' };
  }
  S.expireAccessTokens = () => { for (const k of S.tokens.keys()) S.tokens.set(k, 0); };

  async function handle(url, o) {
    o = o || {};
    const method = (o.method || 'GET').toUpperCase(), h = o.headers || {};
    S.calls.push({ method, url });
    if (S.latency) await new Promise(r => setTimeout(r, S.latency));
    if (S.fail) { const f = S.fail({ method, url, headers: h }); if (f === 'network') throw new TypeError('Failed to fetch'); if (f) return f; }
    // ---- sign-in
    if (url === LOGIN + '/token') {
      const p = new URLSearchParams(o.body);
      if (p.get('grant_type') === 'authorization_code') {
        const ch = S.codes.get(p.get('code'));
        if (!ch || ch !== sha256url(p.get('code_verifier'))) return json(400, { error: 'invalid_grant', error_description: 'AADSTS70008: bad code' });
        S.codes.delete(p.get('code'));
        return json(200, issue());
      }
      if (p.get('grant_type') === 'refresh_token') {
        const r = S.refresh.get(p.get('refresh_token'));
        if (S.refreshFails || !r || !r.valid) return json(400, { error: 'invalid_grant', error_description: 'AADSTS700084: The refresh token was issued to a single page app (SPA), and therefore has a fixed, limited lifetime of 1.00:00:00' });
        return json(200, issue());
      }
      return json(400, { error: 'unsupported_grant_type' });
    }
    // ---- upload session chunks (their URL is their authorization)
    if (url.startsWith(UPLOAD)) {
      const s = S.sessions.get(url.slice(UPLOAD.length));
      if (!s) return gerr(404, 'itemNotFound');
      const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(h['Content-Range'] || '');
      if (!m) return gerr(400, 'invalidRange');
      const [a, b, total] = [+m[1], +m[2], +m[3]], body = Buffer.from(o.body);
      if (body.length !== b - a + 1 || a !== s.received) return gerr(416, 'invalidRange', 'expected ' + s.received);
      if (b + 1 < total && body.length % CHUNK_UNIT) return gerr(400, 'invalidRange', 'chunk not a multiple of 320 KiB');
      S.chunkSizes.push(body.length);
      s.parts.push(body); s.received = b + 1;
      if (s.received < total) return json(202, { nextExpectedRanges: [s.received + '-'] });
      const content = Buffer.concat(s.parts);
      S.sessions.delete(url.slice(UPLOAD.length));
      let f;
      if (s.fileId) { f = S.files.get(s.fileId); if (!f || f.deleted) return gerr(404, 'itemNotFound'); f.content = content; touch(f); }
      else { if (byName(s.name)) return gerr(409, 'nameAlreadyExists'); f = S.create(s.name, content); }
      return json(s.fileId ? 200 : 201, item(f));
    }
    if (!url.startsWith(GRAPH)) return json(404, 'not here');
    // ---- Graph: authorization
    const auth = (h.Authorization || '').replace(/^Bearer /, '');
    if (!S.tokens.has(auth) || S.tokens.get(auth) < S.now()) return gerr(401, 'InvalidAuthenticationToken', 'Access token has expired');
    const u = new URL(url), p = decodeURIComponent(u.pathname.replace('/v1.0', ''));
    const ifMatch = h['If-Match'];
    const live = id => { const f = S.files.get(id); return f && !f.deleted ? f : null; };
    let m;
    if (p === '/me/drive/special/approot' && method === 'GET') return json(200, { id: 'root', name: 'GenGIS' });
    if (p === '/me/drive/special/approot/children' && method === 'GET') {
      const page = +(u.searchParams.get('page') || 0), all = S.live().filter(f => !S.hidden.has(f.id)).sort((a, b) => a.id.localeCompare(b.id));
      const slice = all.slice(page * S.pageSize, (page + 1) * S.pageSize);
      const out = { value: slice.map(item) };
      if ((page + 1) * S.pageSize < all.length) out['@odata.nextLink'] = GRAPH + '/me/drive/special/approot/children?page=' + (page + 1);
      return json(200, out);
    }
    if (p === '/me/drive/special/approot/delta' && method === 'GET') {
      const token = u.searchParams.get('token'), from = token == null ? 0 : +token, page = +(u.searchParams.get('page') || 0);
      if (S.noDelta) return gerr(403, 'accessDenied', 'delta is not supported on this folder');
      if (token != null && S.tooOld.has(token)) return gerr(410, 'resyncRequired');
      const upTo = u.searchParams.has('upto') ? +u.searchParams.get('upto') : S.seq;
      const ids = [...new Set(S.log.filter(e => e.seq > from && e.seq <= upTo).map(e => e.id))];
      const items = ids.map(id => S.files.get(id)).filter(f => !S.hidden.has(f.id) && (token != null || !f.deleted))
        .map(f => f.deleted ? { id: f.id, deleted: { state: 'deleted' } } : item(f));
      const slice = items.slice(page * S.pageSize, (page + 1) * S.pageSize), out = { value: slice };
      if ((page + 1) * S.pageSize < items.length) out['@odata.nextLink'] = GRAPH + '/me/drive/special/approot/delta?' + (token != null ? 'token=' + token + '&' : '') + 'upto=' + upTo + '&page=' + (page + 1);
      else out['@odata.deltaLink'] = GRAPH + '/me/drive/special/approot/delta?token=' + upTo;
      return json(200, out);
    }
    if ((m = /^\/me\/drive\/special\/approot:\/(.+):$/.exec(p)) && method === 'GET') {
      const f = byName(m[1]);
      return f ? json(200, item(f)) : gerr(404, 'itemNotFound');
    }
    if ((m = /^\/me\/drive\/special\/approot:\/(.+):\/content$/.exec(p)) && method === 'PUT') {
      if (byName(m[1])) return gerr(409, 'nameAlreadyExists');
      const made = item(S.create(m[1], Buffer.from(o.body)));
      if (S.omitEtag) delete made.eTag;
      return json(201, made);
    }
    if ((m = /^\/me\/drive\/special\/approot:\/(.+):\/createUploadSession$/.exec(p)) && method === 'POST') {
      if (byName(m[1])) return gerr(409, 'nameAlreadyExists');
      const sid = 'S' + (++S.ids); S.sessions.set(sid, { fileId: null, name: m[1], parts: [], received: 0 });
      return json(200, { uploadUrl: UPLOAD + sid });
    }
    if ((m = /^\/me\/drive\/items\/([^/]+)$/.exec(p))) {
      const f = live(m[1]);
      if (!f) return gerr(404, 'itemNotFound');
      if (method === 'GET') return json(200, item(f));
      if (method === 'PATCH') {
        const body = JSON.parse(o.body);
        if (ifMatch && ifMatch !== etag(f)) return gerr(412, 'resourceModified');
        const other = byName(body.name);
        if (other && other.id !== f.id) return gerr(409, 'nameAlreadyExists');
        f.name = body.name; touch(f);
        return json(200, item(f));
      }
      if (method === 'DELETE') { f.deleted = true; touch(f); return json(204, null); }
    }
    if ((m = /^\/me\/drive\/items\/([^/]+)\/content$/.exec(p))) {
      const f = live(m[1]);
      if (!f) return gerr(404, 'itemNotFound');
      if (method === 'GET') return new Res(200, Buffer.from(f.content));
      if (method === 'PUT') {
        if (ifMatch && ifMatch !== etag(f)) return gerr(412, 'resourceModified');
        f.content = Buffer.from(o.body); touch(f);
        const out = item(f);
        if (S.omitEtag) delete out.eTag;
        return json(200, out);
      }
    }
    if ((m = /^\/me\/drive\/items\/([^/]+)\/createUploadSession$/.exec(p)) && method === 'POST') {
      const f = live(m[1]);
      if (!f) return gerr(404, 'itemNotFound');
      if (ifMatch && ifMatch !== etag(f)) return gerr(412, 'resourceModified');
      const sid = 'S' + (++S.ids); S.sessions.set(sid, { fileId: f.id, parts: [], received: 0 });
      return json(200, { uploadUrl: UPLOAD + sid });
    }
    return gerr(400, 'invalidRequest', method + ' ' + p);
  }
  S.fetch = (url, o) => handle(String(url), o);
  return S;
}

// ---------------------------------------------------------------- shared device storage and locks
function memStore() {
  const t = { accounts: new Map(), links: new Map() }, key = { accounts: 'id', links: 'projectId' };
  const clone = v => v == null ? null : JSON.parse(JSON.stringify(v));
  return {
    tables: t,
    get: async (n, k) => clone(t[n].get(k)),
    all: async n => [...t[n].values()].map(clone),
    put: async (n, v) => { t[n].set(v[key[n]], clone(v)); },
    del: async (n, k) => { t[n].delete(k); }
  };
}
function mutex() {
  let tail = Promise.resolve();
  return fn => { const run = tail.then(() => fn()); tail = run.catch(() => {}); return run; };
}

// The project store of one device (shared by its tabs), in memory.
function memProjects() {
  const recs = new Map(), copies = [];
  return {
    recs, copies,
    put(data, fileBacked) { recs.set(data.id, { id: data.id, name: data.name, savedAt: Date.now(), fileBacked: fileBacked !== false, objects: (data.features || []).length, data: JSON.parse(JSON.stringify(data)) }); }
  };
}

// ---------------------------------------------------------------- one tab: the real modules in a sandbox
function makeApp(o) {
  o = o || {};
  const server = o.server, device = o.device || { store: memStore(), lock: mutex(), projects: memProjects(), ls: new Map(), locksHeld: new Map() };
  const events = {}, toasts = [], listeners = {}, loaded = [];
  const tabId = o.tabId || 'tab-' + crypto.randomBytes(3).toString('hex');
  const localStorage = {
    getItem: k => (device.ls.has(k) ? device.ls.get(k) : null), setItem: (k, v) => device.ls.set(k, String(v)), removeItem: k => device.ls.delete(k)
  };
  let search = '';
  const state = { projectId: o.open || null, projectName: '', current: null };
  const projects = device.projects;
  const P = {
    dirtyFlag: false,
    get: async id => { const r = projects.recs.get(id); return r ? JSON.parse(JSON.stringify(r)) : null; },
    list: async () => [...projects.recs.values()].map(r => ({ id: r.id, name: r.name, objects: r.objects, savedAt: r.savedAt, fileBacked: r.fileBacked })).sort((a, b) => b.savedAt - a.savedAt),
    putSaved: async (data, reason) => { if (reason && projects.recs.has(data.id)) projects.copies.push({ id: data.id, reason, data: projects.recs.get(data.id).data }); projects.put(data, true); return true; },
    isDraft: r => /^\s*untitled( map)?\s*$/i.test(r.name || '') && !r.fileBacked,
    dirty: () => P.dirtyFlag,
    owns: () => device.locksHeld.get(state.projectId) === tabId,
    openElsewhere: async id => device.locksHeld.has(id) && device.locksHeld.get(id) !== tabId,
    flush: async () => true,
    beforeOpen: async () => true,
    markFileBacked: () => { const r = projects.recs.get(state.projectId); if (r) r.fileBacked = true; },
    remove: async id => { projects.recs.delete(id); MB.emit('project-removed', id); },
    list_: null
  };
  const MB = {
    PROJECT_EXT: '.gengis.json',
    state, projects: P,
    uid: () => 'p' + crypto.randomBytes(5).toString('hex'),
    isProject: p => !!p && typeof p === 'object' && p.format === 'gengis' && Array.isArray(p.features),
    on: (e, fn) => { (events[e] = events[e] || []).push(fn); },
    emit: (e, d) => (events[e] || []).forEach(fn => fn(d)),
    toast: m => toasts.push(m),
    escapeHtml: s => String(s),
    loadProject: (data) => { loaded.push(data); state.projectId = data.id; state.projectName = data.name; state.current = JSON.parse(JSON.stringify(data)); },
    // what the real app saves of the open project: with its own version, and this device's own live-traffic server
    serializeProject: () => Object.assign(JSON.parse(JSON.stringify(state.current || {})), { generator: { name: 'GenGIS', version: o.version || '1.0' }, liveTraffic: { sources: [{ kind: 'receiver', uri: 'http://' + tabId + '.local:8080' }] } })
  };
  const win = { MB, gengisDesktop: undefined };
  const ctx = {
    window: win, MB, console: { warn: () => {}, log: console.log, error: console.error },
    localStorage, crypto: globalThis.crypto, TextEncoder, TextDecoder, URLSearchParams, URL, btoa, atob, Promise, Date, JSON, Math,
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval: () => {},
    location: { protocol: 'https:', origin: 'https://g2.test', pathname: '/', hash: '', get search() { return search; }, assign: () => {} },
    history: { state: null, replaceState: (s, t, url) => { search = url.includes('?') ? url.slice(url.indexOf('?')) : ''; } },
    navigator: { onLine: true, userAgent: o.userAgent || 'Mozilla/5.0 (Windows NT 10.0) Chrome/130', platform: 'Win32', maxTouchPoints: 0 },
    document: { visibilityState: 'visible', addEventListener: (e, fn) => { (listeners[e] = listeners[e] || []).push(fn); } },
    fetch: server.fetch
  };
  ctx.window.addEventListener = (e, fn) => { (listeners[e] = listeners[e] || []).push(fn); };
  ctx.addEventListener = ctx.window.addEventListener;
  vm.createContext(ctx);
  ['js/oauth.js', 'js/cloud-onedrive.js', 'js/cloudsync.js'].forEach(f => vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f }));
  MB.cloudProviders.onedrive.clientId = 'test-client';
  const C = MB.cloud;
  let online = true;
  Object.assign(C.env, { store: device.store, lock: device.lock, fetch: server.fetch, online: () => online, visible: () => true, go: url => { app.wentTo = url; }, pushDelay: o.pushDelay == null ? 0 : o.pushDelay });
  const app = {
    MB, C, P, device, server, toasts, loaded, tabId, events, listeners, wentTo: null,
    setSearch: s => { search = s; },
    setOnline: v => { online = v; ctx.navigator.onLine = v; if (v) (listeners.online || []).forEach(fn => fn()); },
    open: id => { state.projectId = id; const r = projects.recs.get(id); state.projectName = r ? r.name : ''; state.current = r ? JSON.parse(JSON.stringify(r.data)) : null; device.locksHeld.set(id, tabId); },
    // the autosave the real app makes after a project is loaded or edited
    autosave: () => { const p = MB.serializeProject(); projects.put(p); MB.emit('saved', p.id); },
    // a background save of a project of this device (what projectstore emits as 'saved')
    save: (data, opts) => { if (state.projectId === data.id) state.current = JSON.parse(JSON.stringify(data)); projects.put(data, !(opts && opts.draft)); MB.emit('saved', data.id); },
    getSearch: () => search,
    // the whole sign-in round trip: to the provider (stubbed) and back with a code
    async connect() {
      await C.connect('onedrive');
      const pending = JSON.parse(device.ls.get('gengis.oauth.pending'));
      const code = server.issueCode(pending.verifier);
      search = '?code=' + code + '&state=' + pending.state;
      C.takeRedirect();
      await C.init();
    },
    // until nothing is queued, pumping or pulling
    async settle(ms) {
      const until = Date.now() + (ms || 20000);
      for (;;) {
        await new Promise(r => setTimeout(r, 15));
        const busy = await C._busy();
        if (!busy) { await new Promise(r => setTimeout(r, 30)); if (!(await C._busy())) return; }
        if (Date.now() > until) throw new Error('did not settle');
      }
    }
  };
  return app;
}

// A project file's content.
function project(id, name, n, extra) {
  const features = [];
  for (let i = 0; i < (n || 1); i++) features.push({ id: id + '-f' + i, type: 'marker', latlng: [i * 0.001, i * 0.002], style: { color: '#e53935' }, name: 'F' + i });
  return Object.assign({ format: 'gengis', schema: 3, id, name, layers: [{ id: 'L1', name: 'Layer 1' }], features, view: { lat: 0, lng: 0, zoom: 3 } }, extra || {});
}

module.exports = { makeServer, makeApp, memStore, mutex, memProjects, project, sha256url, GRAPH, LOGIN, CHUNK_UNIT };
