/* GenGIS - OneDrive for cloud sync (cloudsync.js): personal Microsoft accounts and Microsoft 365 work or school
 * accounts, through Microsoft Graph.
 * - one app registration in Microsoft Entra ("common": any organization, and personal accounts), a single-page
 *   application platform with this site's address as the redirect URI; no secret
 * - least access: Files.ReadWrite.AppFolder, a folder of GenGIS's own in the user's OneDrive (Apps/GenGIS), where each
 *   synced project is an ordinary .gengis.json file the user can see, open and share
 * - Microsoft gives a web app's sign-in 24 hours; after that the user signs in again (usually without typing anything)
 * Only HTTP here: when to sync, conflicts and the queue are cloudsync.js's.
 */
window.MB = window.MB || {};
(function (MB) {
  'use strict';

  // The Application (client) ID of GenGIS's Entra app registration (multitenant, single-page application). OneDrive
  // gives each registration its own folder (Apps/GenGIS) the first time it is used, so every GenGIS (web, desktop,
  // Android) signs in with this one registration, as a platform added to it, never a registration of its own: a second
  // registration would mean a second folder ("GenGIS 1"). GenGIS itself never creates folders: it writes files in that
  // one folder, by name (slashes in names are replaced) or by id.
  // Microsoft makes the folder the first time a request names approot, and a request that names it while it is still
  // being made gets a folder of its own ("GenGIS 1", which approot then names): so root() is the only request here
  // that names approot, made once by cloudsync under its lock before anything else is asked of the folder, and every
  // other request addresses the folder by the id root() gave (ctx.root).
  const CLIENT_ID = '7beaabe0-cfb2-406e-b687-7eace44b2edb';
  const AUTHORITY = 'https://login.microsoftonline.com/common/oauth2/v2.0';
  const GRAPH = 'https://graph.microsoft.com/v1.0';
  const ROOT = '/me/drive/special/approot';
  const SIMPLE_MAX = 4 * 1024 * 1024;   // bytes: larger files go up in an upload session
  const CHUNK = 16 * 320 * 1024;        // 5 MiB: upload session chunks must be multiples of 320 KiB
  const PERSONAL_TENANT = '9188040d-6c67-4c5b-b112-36a304b66dad'; // personal Microsoft accounts' tenant
  const SELECT = 'id,name,eTag,size,lastModifiedDateTime,file,deleted';
  const MAX_READ = 200 * 1024 * 1024; // bytes: a cloud file larger than this is not read (not a project anyone made here)

  const enc = name => encodeURIComponent(name).replace(/'/g, '%27');

  // An error carrying what the engine decides on: .status, .code, .retryAfter (s).
  async function httpError(res, what) {
    let body = {};
    try { body = await res.json(); } catch (e) { /* not JSON */ }
    const g = body.error || {};
    const err = new Error((g.message || ('HTTP ' + res.status)) + (what ? ' (' + what + ')' : ''));
    err.status = res.status;
    err.code = g.code || '';
    const ra = res.headers && res.headers.get && res.headers.get('Retry-After');
    if (ra) err.retryAfter = +ra || 0;
    return err;
  }

  // One Graph call. ctx: { token: () => Promise<access token>, fetch }.
  async function graph(ctx, method, path, opts) {
    opts = opts || {};
    const headers = Object.assign({ Authorization: 'Bearer ' + await ctx.token() }, opts.headers || {});
    let res;
    try { res = await ctx.fetch(/^https:/.test(path) ? path : GRAPH + path, { method, headers, body: opts.body }); }
    catch (e) { const err = new Error('offline'); err.code = 'network'; throw err; }
    if (!res.ok) throw await httpError(res, method + ' ' + path.split('?')[0]);
    if (opts.raw) return res;
    return res.status === 204 ? null : res.json();
  }

  const item = it => ({ fileId: it.id, name: it.name, etag: it.eTag, size: it.size || 0, modified: Date.parse(it.lastModifiedDateTime) || 0 });

  // GenGIS's folder, by id: the one cloudsync found (ctx.root), or else found here once per account, one request
  // at a time (several callers at once wait for the same answer).
  const roots = new Map(); // account -> Promise of the folder's id
  function rootOf(ctx) {
    if (ctx.root) return Promise.resolve(ctx.root);
    const key = ctx.account || '';
    if (!roots.has(key)) {
      const p = OD.root(ctx).then(r => r.fileId);
      roots.set(key, p);
      p.catch(() => { if (roots.get(key) === p) roots.delete(key); });
    }
    return roots.get(key);
  }
  const at = id => '/me/drive/items/' + enc(id);
  // A request that addresses the folder by its id and is refused: the folder is gone (deleted: 404; renamed or moved,
  // and so no longer GenGIS's: 403). Microsoft makes a new one when approot is next named, and cloudsync looks.
  const gone = e => { if (e.status === 404 || e.status === 403) e.code = 'rootGone'; throw e; };

  // Upload sessions cut short (offline, a timeout, a passing server error), kept so that the same content written
  // again goes on from what OneDrive already has instead of from the start: account + path -> { url, expires, text }.
  // A few at most, and none past its expiry (each holds its project's text).
  const sessions = new Map();
  // Dropping the oldest never reaches an upload in progress: cloudsync uploads one project at a time, and the
  // session in progress is always the last one put in.
  const KEEP_SESSIONS = 4;
  const network = () => Object.assign(new Error('offline'), { code: 'network' });
  function forget(key) {
    const s = sessions.get(key);
    sessions.delete(key);
    if (s) Promise.resolve().then(() => s.fetch(s.url, { method: 'DELETE' })).catch(() => {}); // (OneDrive drops it anyway when it expires)
  }
  function keep(key, s) {
    sessions.forEach((v, k) => { if (v.expires < Date.now()) forget(k); });
    sessions.set(key, s);
    while (sessions.size > KEEP_SESSIONS) forget(sessions.keys().next().value); // (the oldest)
  }

  // How many bytes an upload session has (from the start), or null when it is gone.
  async function received(ctx, url) {
    let res;
    try { res = await ctx.fetch(url, { method: 'GET' }); } catch (e) { throw network(); }
    if (res.status === 404 || res.status === 410) return null;
    if (!res.ok) throw await httpError(res, 'upload status');
    const m = /^(\d+)-/.exec(((await res.json()).nextExpectedRanges || [])[0] || '');
    return m ? +m[1] : null;
  }

  // The chunks from byte at on, to the session's own address (which carries its own authorization). Resolves the
  // file's item, or null when the session is gone on OneDrive's side (expired or cancelled).
  async function chunks(ctx, s, bytes, at, onProgress) {
    for (let resync = 0; ;) {
      if (at >= bytes.length) return null; // (all sent and still not a file: not a session to go on with)
      const end = Math.min(at + CHUNK, bytes.length);
      let res;
      try { res = await ctx.fetch(s.url, { method: 'PUT', headers: { 'Content-Range': `bytes ${at}-${end - 1}/${bytes.length}` }, body: bytes.subarray(at, end) }); }
      catch (e) { throw network(); }
      if (res.status === 404 || res.status === 410) return null;
      // OneDrive has a different part than this one assumed (a chunk that arrived though its answer did not): from what it has
      if (res.status === 416 && resync++ < 3) { at = await received(ctx, s.url); if (at == null) return null; continue; }
      if (!res.ok) throw await httpError(res, 'upload');
      if (res.status !== 202) { if (onProgress) onProgress(bytes.length, bytes.length); return res.json(); }
      const m = /^(\d+)-/.exec(((await res.json().catch(() => ({}))).nextExpectedRanges || [])[0] || '');
      at = m ? +m[1] : end;
      if (onProgress) onProgress(at, bytes.length);
    }
  }

  // A guarded update whose session ended may have finished with its answer lost: the file then already holds this
  // very text, under a new eTag, and that is no change made elsewhere. Resolves the file's item, or null.
  async function landed(ctx, o) {
    if ((await OD.meta(ctx, o.fileId)).etag === o.ifMatch) return null;
    let f;
    try { f = await OD.get(ctx, o.fileId); }
    catch (e) { if (e.code === 'tooLarge') return null; throw e; } // (not read: taken for a change made elsewhere)
    if (f.text !== o.text) return null;
    delete f.text;
    return f;
  }

  // A large file in an upload session (resolves its item). Content an earlier try partly uploaded goes on from where
  // OneDrive got to; a write guarded by an eTag checks the file first (changed elsewhere since: a new session, which
  // is refused with 412, unless the change is this very upload having finished).
  async function uploadSession(ctx, o, path, bytes, headers, conflict) {
    const key = (ctx.account || '') + ' ' + path;
    let s = sessions.get(key), at = 0, ended = false;
    if (s && (s.text !== o.text || s.expires - Date.now() < 60 * 1000)) { forget(key); s = null; }
    if (s && o.ifMatch && (await OD.meta(ctx, o.fileId)).etag !== o.ifMatch) { forget(key); s = null; ended = true; }
    if (s && (at = await received(ctx, s.url)) == null) { sessions.delete(key); s = null; at = 0; ended = true; }
    for (let fresh = 0; ; fresh++) {
      if (!s) {
        if (ended && o.ifMatch) { const mine = await landed(ctx, o); if (mine) return mine; }
        const r = await graph(ctx, 'POST', path, { headers: Object.assign({ 'Content-Type': 'application/json' }, headers), body: JSON.stringify({ item: { '@microsoft.graph.conflictBehavior': conflict } }) });
        s = { url: r.uploadUrl, expires: Date.parse(r.expirationDateTime) || Date.now() + 3600 * 1000, text: o.text, fetch: ctx.fetch };
        keep(key, s); at = 0;
      }
      if (at && o.onProgress) o.onProgress(at, bytes.length);
      const done = await chunks(ctx, s, bytes, at, o.onProgress);
      sessions.delete(key);
      if (done) return item(done);
      s = null; ended = true; // the session ended over there: once more, from the start (a second time: a passing failure, tried again later)
      if (fresh) throw Object.assign(new Error('The upload session ended'), { status: 503 });
    }
  }

  // Microsoft's sign-in errors, in words (AADSTS codes in the error description).
  function explain(code, description) {
    const d = String(description || ''), has = n => d.indexOf('AADSTS' + n) >= 0;
    if (has(65001) || has(90094) || has(65004) || code === 'consent_required') return 'Your organization requires an administrator to approve GenGIS before you can connect OneDrive. Ask your IT administrator to approve the app "GenGIS".';
    if (has(53000) || has(53001) || has(53003) || has(530003)) return 'Your organization\'s sign-in policy does not allow GenGIS on this device or browser. GenGIS cannot change that; ask your IT administrator.';
    if (has(700016) || has(7000112) || has(500011)) return 'Your organization has blocked GenGIS, or it is not available in your organization.';
    const desk = [7000218, 9002327, 50011].find(has);
    if (desk) return 'GenGIS\'s Microsoft sign-in is not set up for the desktop app. Use OneDrive in the web app until this is fixed (AADSTS' + desk + ').';
    if (has(50058) || code === 'login_required' || code === 'interaction_required') return 'Sign in to OneDrive again.';
    if (code === 'access_denied') return 'The sign-in was cancelled or GenGIS was not allowed access.';
    if (code === 'invalid_grant') return 'Your OneDrive sign-in has expired. Sign in again.';
    return d.split(/\r?\n/)[0].replace(/^AADSTS\d+:\s*/, '') || code || 'Could not sign in to OneDrive.';
  }

  const OD = {
    id: 'onedrive',
    name: 'OneDrive',
    folder: 'OneDrive → Apps → GenGIS',
    signInDays: 1, // a web app's Microsoft sign-in lasts 24 hours
    clientId: CLIENT_ID,
    explain,

    // Offered in the web app once the app is registered; in the desktop app when its main process signs in to it
    // (electron/cloudauth.js, the same registration as a desktop platform).
    available() {
      if (MB.native && MB.native.app) return false; // (the Android app: its own sign-in is not set up yet)
      const d = window.gengisDesktop && window.gengisDesktop.cloud;
      if (window.gengisDesktop) return !!d && (d.providers || []).includes('onedrive');
      return !!OD.clientId && /^https?:$/.test(location.protocol);
    },

    auth(extra) {
      return { provider: OD.id, authorize: AUTHORITY + '/authorize', token: AUTHORITY + '/token', clientId: OD.clientId,
        scopes: ['openid', 'profile', 'email', 'offline_access', 'Files.ReadWrite.AppFolder'], extra: extra || {} };
    },
    // A new sign-in: pick the account; a silent renewal for a known account (no page shown when its session is alive).
    signInExtra(acc, silent) {
      const x = silent ? { prompt: 'none' } : { prompt: 'select_account' };
      if (acc && acc.email) x.login_hint = acc.email;
      if (acc && acc.kind) x.domain_hint = acc.kind === 'personal' ? 'consumers' : 'organizations';
      return x;
    },
    // Who signed in, from the token answer.
    account(tokens) {
      const c = MB.oauth.idClaims(tokens.id_token);
      const tid = c.tid || '', oid = c.oid || c.sub || '';
      return { id: 'onedrive:' + oid + '@' + tid, provider: OD.id, name: c.name || '', email: c.preferred_username || c.email || '',
        tid, kind: tid === PERSONAL_TENANT ? 'personal' : 'work' };
    },

    // GenGIS's folder ({ fileId, name }), the one request that names approot: Microsoft makes the folder when there is
    // none (the first time, or after the user deleted it). Once at a time: see rootOf.
    root: ctx => graph(ctx, 'GET', ROOT + '?$select=id,name').then(it => ({ fileId: it.id, name: it.name })),

    // The project files in GenGIS's folder.
    async list(ctx) {
      const out = [];
      let next = at(await rootOf(ctx)) + '/children?$select=' + SELECT + '&$top=200';
      while (next) {
        const page = await graph(ctx, 'GET', next).catch(gone);
        (page.value || []).forEach(it => { if (it.file && /\.json$/i.test(it.name)) out.push(item(it)); });
        next = page['@odata.nextLink'] || null;
      }
      return out;
    },

    meta: (ctx, fileId) => graph(ctx, 'GET', at(fileId) + '?$select=' + SELECT).then(item),
    // A file in GenGIS's folder by its name, or null.
    byName: async (ctx, name) => graph(ctx, 'GET', at(await rootOf(ctx)) + ':/' + enc(name) + ':?$select=' + SELECT).then(item, e => { if (e.status === 404) return null; throw e; }),

    async get(ctx, fileId) {
      const meta = await OD.meta(ctx, fileId);
      if (meta.size > MAX_READ) { const err = new Error('The cloud file is too large to open (' + Math.round(meta.size / 1048576) + ' MB)'); err.code = 'tooLarge'; throw err; }
      const res = await graph(ctx, 'GET', '/me/drive/items/' + enc(fileId) + '/content', { raw: true });
      return Object.assign(meta, { text: await res.text() });
    },

    // Write a file: a new one by name (an existing name fails with 409), or an existing one by id (ifMatch: its eTag
    // as last seen here, so a file changed elsewhere fails with 412 instead of being overwritten).
    async put(ctx, o) {
      const bytes = new TextEncoder().encode(o.text);
      const headers = o.fileId && o.ifMatch ? { 'If-Match': o.ifMatch } : {};
      const where = o.fileId ? at(o.fileId) : at(await rootOf(ctx)) + ':/' + enc(o.name) + ':'; // (a new file: in the folder, by name)
      if (bytes.length <= SIMPLE_MAX) {
        const path = where + '/content' + (o.fileId ? '' : '?@microsoft.graph.conflictBehavior=fail');
        const p = graph(ctx, 'PUT', path, { headers: Object.assign({ 'Content-Type': 'application/json' }, headers), body: bytes });
        return item(await (o.fileId ? p : p.catch(gone)));
      }
      const p = uploadSession(ctx, o, where + '/createUploadSession', bytes, headers, o.fileId ? 'replace' : 'fail');
      return o.fileId ? p : p.catch(gone); // (a new file's upload has no 404 of its own: one is the folder's)
    },

    rename: (ctx, fileId, name) => graph(ctx, 'PATCH', at(fileId), { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) }).then(item),

    remove: (ctx, fileId) => graph(ctx, 'DELETE', at(fileId)),
    _sessions: sessions, // (tests)

    // What changed in GenGIS's folder since cursor (none: everything there now). Resolves { items, cursor, reset }:
    // reset when the cursor is too old (the caller starts again without one).
    // Where an account's drive does not offer the folder's change feed, the whole folder is listed each time instead
    // (one request per 200 files): { items, cursor: 'list', full: true }.
    async changes(ctx, cursor) {
      if (cursor === 'list') return { items: await OD.list(ctx), cursor: 'list', full: true, reset: false };
      const items = [];
      let next = cursor || at(await rootOf(ctx)) + '/delta?$select=' + SELECT, last = null;
      try {
        while (next) {
          const page = await graph(ctx, 'GET', next);
          (page.value || []).forEach(it => {
            if (it.deleted) items.push({ fileId: it.id, deleted: true });
            else if (it.file) items.push(item(it));
          });
          next = page['@odata.nextLink'] || null;
          last = page['@odata.deltaLink'] || last;
        }
      } catch (e) {
        if (e.status === 410 || e.code === 'resyncRequired') return { items: [], cursor: null, reset: true };
        if (!cursor && [400, 403, 404, 405, 501].includes(e.status)) return { items: await OD.list(ctx), cursor: 'list', full: true, reset: false }; // no feed for this folder (or no folder: the listing says so)
        gone(e);
      }
      return { items, cursor: last, reset: false };
    }
  };

  MB.cloudProviders = MB.cloudProviders || {};
  MB.cloudProviders.onedrive = OD;
})(window.MB);
