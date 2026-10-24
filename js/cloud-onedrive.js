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

  // The Application (client) ID of GenGIS's Entra app registration. Empty: OneDrive is not offered. On a development
  // host (localhost) a test registration's id may be set instead: localStorage 'gengis.dev.onedriveClientId'.
  const DEV = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  let devId = '';
  try { devId = DEV ? localStorage.getItem('gengis.dev.onedriveClientId') || '' : ''; } catch (e) { /* none */ }
  const CLIENT_ID = '' || devId;
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

  // A large file in an upload session: chunks to the session's own address (which carries its own authorization).
  async function uploadSession(ctx, path, bytes, headers, conflict, onProgress) {
    const s = await graph(ctx, 'POST', path, { headers: Object.assign({ 'Content-Type': 'application/json' }, headers), body: JSON.stringify({ item: { '@microsoft.graph.conflictBehavior': conflict } }) });
    let res, at = 0;
    while (at < bytes.length) {
      const end = Math.min(at + CHUNK, bytes.length);
      try { res = await ctx.fetch(s.uploadUrl, { method: 'PUT', headers: { 'Content-Range': `bytes ${at}-${end - 1}/${bytes.length}` }, body: bytes.subarray(at, end) }); }
      catch (e) { const err = new Error('offline'); err.code = 'network'; throw err; }
      if (!res.ok && res.status !== 202) throw await httpError(res, 'upload');
      at = end;
      if (onProgress) onProgress(at, bytes.length);
    }
    return res.json();
  }

  // Microsoft's sign-in errors, in words (AADSTS codes in the error description).
  function explain(code, description) {
    const d = String(description || ''), has = n => d.indexOf('AADSTS' + n) >= 0;
    if (has(65001) || has(90094) || has(65004) || code === 'consent_required') return 'Your organization requires an administrator to approve GenGIS before you can connect OneDrive. Ask your IT administrator to approve the app "GenGIS".';
    if (has(53000) || has(53001) || has(53003) || has(530003)) return 'Your organization\'s sign-in policy does not allow GenGIS on this device or browser. GenGIS cannot change that; ask your IT administrator.';
    if (has(700016) || has(7000112) || has(500011)) return 'Your organization has blocked GenGIS, or it is not available in your organization.';
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

    // Offered in the web app once the app is registered (the desktop app signs in its own way: not yet).
    available() { return !!OD.clientId && /^https?:$/.test(location.protocol) && !window.gengisDesktop; },

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

    root: ctx => graph(ctx, 'GET', ROOT + '?$select=id,name').then(it => it.id),

    // The project files in GenGIS's folder.
    async list(ctx) {
      const out = [];
      let next = ROOT + '/children?$select=' + SELECT + '&$top=200';
      while (next) {
        const page = await graph(ctx, 'GET', next);
        (page.value || []).forEach(it => { if (it.file && /\.json$/i.test(it.name)) out.push(item(it)); });
        next = page['@odata.nextLink'] || null;
      }
      return out;
    },

    meta: (ctx, fileId) => graph(ctx, 'GET', '/me/drive/items/' + enc(fileId) + '?$select=' + SELECT).then(item),
    // A file in GenGIS's folder by its name, or null.
    byName: (ctx, name) => graph(ctx, 'GET', ROOT + ':/' + enc(name) + ':?$select=' + SELECT).then(item, e => { if (e.status === 404) return null; throw e; }),

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
      let it;
      if (bytes.length <= SIMPLE_MAX) {
        const path = o.fileId ? '/me/drive/items/' + enc(o.fileId) + '/content'
          : ROOT + ':/' + enc(o.name) + ':/content?@microsoft.graph.conflictBehavior=fail';
        it = await graph(ctx, 'PUT', path, { headers: Object.assign({ 'Content-Type': 'application/json' }, headers), body: bytes });
      } else {
        const path = o.fileId ? '/me/drive/items/' + enc(o.fileId) + '/createUploadSession' : ROOT + ':/' + enc(o.name) + ':/createUploadSession';
        it = await uploadSession(ctx, path, bytes, headers, o.fileId ? 'replace' : 'fail', o.onProgress);
      }
      return item(it);
    },

    rename: (ctx, fileId, name) => graph(ctx, 'PATCH', '/me/drive/items/' + enc(fileId), { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) }).then(item),

    remove: (ctx, fileId) => graph(ctx, 'DELETE', '/me/drive/items/' + enc(fileId)),

    // What changed in GenGIS's folder since cursor (none: everything there now). Resolves { items, cursor, reset }:
    // reset when the cursor is too old (the caller starts again without one).
    // Where an account's drive does not offer the folder's change feed, the whole folder is listed each time instead
    // (one request per 200 files): { items, cursor: 'list', full: true }.
    async changes(ctx, cursor) {
      if (cursor === 'list') return { items: await OD.list(ctx), cursor: 'list', full: true, reset: false };
      const items = [];
      let next = cursor || ROOT + '/delta?$select=' + SELECT, last = null;
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
        if (!cursor && [400, 403, 404, 405, 501].includes(e.status)) return { items: await OD.list(ctx), cursor: 'list', full: true, reset: false }; // no feed for this folder
        throw e;
      }
      return { items, cursor: last, reset: false };
    }
  };

  MB.cloudProviders = MB.cloudProviders || {};
  MB.cloudProviders.onedrive = OD;
})(window.MB);
