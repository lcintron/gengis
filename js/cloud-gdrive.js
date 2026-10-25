/* GenGIS - Google Drive for cloud sync (cloudsync.js), through the Drive API v3.
 * - least access: drive.file, the files GenGIS itself created; they sit in one "GenGIS" folder in My Drive, ordinary
 *   files the user can see, open and share
 * - one folder only: GenGIS's folder is found by its own mark (appProperties gengis=root) before one is ever made;
 *   two devices making it at the same moment keep the older one (the newer, empty one is removed)
 * - a file is replaced only at the version last synced (Drive has no If-Match on uploads: the version is checked just
 *   before), as with OneDrive's eTags; large files go up resumably
 * - sign-in: the web app uses Google's own library (a pop-up; Google gives a web app an hour, then a tap reconnects);
 *   the desktop app signs in through its main process (electron/cloudauth.js) and stays signed in
 * Only HTTP here: when to sync, conflicts and the queue are cloudsync.js's. */
window.MB = window.MB || {};
(function (MB) {
  'use strict';

  // The OAuth client id of GenGIS's Google Cloud project ("Web application"). Empty: Google Drive is not offered in the
  // web app (the desktop app has its own client: electron/cloudauth.js).
  const WEB_CLIENT_ID = '';
  const API = 'https://www.googleapis.com/drive/v3', UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
  const USERINFO = 'https://www.googleapis.com/oauth2/v3/userinfo';
  const GIS = 'https://accounts.google.com/gsi/client';
  const SCOPES = ['openid', 'email', 'profile', 'https://www.googleapis.com/auth/drive.file'];
  const FOLDER = 'application/vnd.google-apps.folder';
  const FIELDS = 'id,name,mimeType,version,modifiedTime,size,trashed,parents,createdTime';
  const SIMPLE_MAX = 5 * 1024 * 1024;   // bytes: larger files go up resumably
  const CHUNK = 20 * 256 * 1024;        // 5 MiB: resumable chunks are multiples of 256 KiB
  const MAX_READ = 200 * 1024 * 1024;

  const q = s => "'" + String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'"; // a value in a Drive query
  const item = f => ({ fileId: f.id, name: f.name, etag: String(f.version), size: +f.size || 0, modified: Date.parse(f.modifiedTime) || 0 });

  async function httpError(res, what) {
    let body = {};
    try { body = await res.json(); } catch (e) { /* not JSON */ }
    const g = body.error || {}, reason = ((g.errors || [])[0] || {}).reason || g.status || '';
    const err = new Error((g.message || ('HTTP ' + res.status)) + (what ? ' (' + what + ')' : ''));
    err.status = res.status; err.code = reason;
    if (res.status === 403 && /rateLimitExceeded|userRateLimitExceeded/.test(reason)) err.status = 429; // throttled: wait and retry
    if (/storageQuotaExceeded/.test(reason)) err.code = 'quotaLimitReached';
    const ra = res.headers && res.headers.get && res.headers.get('Retry-After');
    if (ra) err.retryAfter = +ra || 0;
    return err;
  }
  async function api(ctx, method, url, opts) {
    opts = opts || {};
    const headers = Object.assign({ Authorization: 'Bearer ' + await ctx.token() }, opts.headers || {});
    let res;
    try { res = await ctx.fetch(url, { method, headers, body: opts.body }); }
    catch (e) { const err = new Error('offline'); err.code = 'network'; throw err; }
    if (!res.ok) throw await httpError(res, method + ' ' + url.replace(/\?.*$/, '').replace(/^https:\/\/www\.googleapis\.com/, ''));
    if (opts.raw) return res;
    return res.status === 204 ? null : res.json();
  }
  const list = async (ctx, query, fields) => {
    const out = [];
    let token = '';
    do {
      const page = await api(ctx, 'GET', API + '/files?pageSize=200&spaces=drive&q=' + encodeURIComponent(query) + '&fields=' + encodeURIComponent('nextPageToken,files(' + (fields || FIELDS) + ')') + (token ? '&pageToken=' + encodeURIComponent(token) : ''));
      out.push(...(page.files || []));
      token = page.nextPageToken || '';
    } while (token);
    return out;
  };

  /* ---------- GenGIS's folder: one only ---------- */
  const folders = new Map(); // account id -> its folder ({ fileId, name }), found once a session
  async function findFolders(ctx) {
    return (await list(ctx, "mimeType='" + FOLDER + "' and appProperties has { key='gengis' and value='root' } and trashed=false", 'id,name,createdTime'))
      .sort((a, b) => (Date.parse(a.createdTime) || 0) - (Date.parse(b.createdTime) || 0) || a.id.localeCompare(b.id));
  }
  function folder(ctx, fresh) {
    const key = ctx.account || '';
    if (fresh || !folders.has(key)) {
      const p = findOrMake(ctx);
      folders.set(key, p);
      p.catch(() => { if (folders.get(key) === p) folders.delete(key); });
    }
    return folders.get(key);
  }
  async function findOrMake(ctx) {
    let found = await findFolders(ctx);
    if (!found.length) {
      await api(ctx, 'POST', API + '/files?fields=id,name,createdTime', { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'GenGIS', mimeType: FOLDER, appProperties: { gengis: 'root' } }) });
      found = await findFolders(ctx); // another device may have made one at the same moment: the older one stays
    }
    // more than one (made at the same moment): what is in the newer ones moves into the older one, then they go
    for (const extra of found.slice(1)) {
      const inside = await list(ctx, q(extra.id) + ' in parents and trashed=false', 'id');
      let moved = true;
      for (const f of inside) {
        try { await api(ctx, 'PATCH', API + '/files/' + encodeURIComponent(f.id) + '?addParents=' + encodeURIComponent(found[0].id) + '&removeParents=' + encodeURIComponent(extra.id) + '&fields=id', { headers: { 'Content-Type': 'application/json' }, body: '{}' }); }
        catch (e) { moved = false; }
      }
      if (moved) await api(ctx, 'DELETE', API + '/files/' + encodeURIComponent(extra.id)).catch(() => {});
    }
    if (!found.length) throw new Error('Could not make the GenGIS folder in Google Drive');
    return { fileId: found[0].id, name: found[0].name };
  }

  /* ---------- the web app's sign-in: Google's library ---------- */
  let gisLoad = null;
  function loadGis() {
    if (window.google && google.accounts && google.accounts.oauth2) return Promise.resolve();
    if (!gisLoad) gisLoad = new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = GIS; s.async = true;
      s.onload = () => res();
      s.onerror = () => { gisLoad = null; rej(Object.assign(new Error('Could not load Google sign-in'), { code: 'network' })); };
      document.head.appendChild(s);
    });
    return gisLoad;
  }

  function explain(code, description) {
    if (code === 'popup_closed' || code === 'access_denied') return 'The Google sign-in was closed or GenGIS was not allowed access.';
    if (code === 'popup_failed_to_open') return 'The browser blocked Google\'s sign-in window. Allow pop-ups for GenGIS and try again.';
    if (code === 'reconnect' || code === 'invalid_grant') return 'Google keeps a web app signed in for an hour. Tap Sign in to reconnect.';
    if (code === 'admin_policy_enforced' || code === 'org_internal') return 'Your organization does not allow GenGIS to use Google Drive. Ask your Google Workspace administrator.';
    if (code === 'network') return 'Could not reach Google. Check the connection.';
    return String(description || code || 'Could not sign in to Google Drive.');
  }

  const desktop = () => window.gengisDesktop && window.gengisDesktop.cloud;

  const GD = {
    id: 'gdrive',
    name: 'Google Drive',
    folder: 'Google Drive → GenGIS',
    clientId: WEB_CLIENT_ID,
    explain,
    // In the web app with a client id; in the desktop app when its main process has a Google client.
    available() {
      const d = desktop();
      if (window.gengisDesktop) return !!d && (d.providers || []).includes('gdrive');
      return !!GD.clientId && /^https?:$/.test(location.protocol);
    },
    // The web app signs in with a pop-up (Google's library loaded beforehand, so the click still counts as one).
    popup: true,
    preload() { if (!desktop() && GD.clientId) loadGis().catch(() => {}); },
    async signIn(acc) {
      await loadGis();
      return new Promise((res, rej) => {
        const client = google.accounts.oauth2.initTokenClient({
          client_id: GD.clientId, scope: SCOPES.join(' '), include_granted_scopes: true,
          login_hint: (acc && acc.email) || undefined,
          callback: r => (r && r.access_token ? res({ access: r.access_token, expiresIn: +r.expires_in || 3600 }) : rej(Object.assign(new Error((r && r.error_description) || 'No access'), { code: (r && r.error) || 'access_denied' }))),
          error_callback: e => rej(Object.assign(new Error((e && e.message) || 'Sign-in failed'), { code: (e && e.type) || 'failed' }))
        });
        client.requestAccessToken({ prompt: acc ? '' : 'select_account' });
      });
    },
    // Who signed in (the web app's sign-in gives an access token only).
    async whoami(access, fetchFn) {
      const res = await (fetchFn || fetch)(USERINFO, { headers: { Authorization: 'Bearer ' + access } });
      if (!res.ok) throw Object.assign(new Error('Could not read the Google account'), { code: 'http_' + res.status });
      const u = await res.json();
      return { id: 'gdrive:' + u.sub, provider: 'gdrive', name: u.name || '', email: u.email || '', kind: u.hd ? 'work' : 'personal' };
    },
    // A web app keeps its access token for its hour, then needs a tap (Google gives web apps no refresh token).
    renew(acc, now) {
      if (acc.accessToken && acc.accessExp - now > 60000) return Promise.resolve({ access: acc.accessToken, expiresIn: Math.round((acc.accessExp - now) / 1000) });
      return Promise.reject(Object.assign(new Error('Google sign-in expired'), { code: 'reconnect' }));
    },

    // Revokes a web app's access when the account is disconnected (the desktop app's main process does its own).
    async signOut(acc, fetchFn) {
      if (acc && acc.accessToken) await (fetchFn || fetch)('https://oauth2.googleapis.com/revoke?token=' + encodeURIComponent(acc.accessToken), { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    },

    // GenGIS's folder, looked up again (cloudsync checks it once a session and on every full re-check)
    root: ctx => folder(ctx, true),

    async list(ctx) {
      const f = await folder(ctx);
      return (await list(ctx, q(f.fileId) + ' in parents and trashed=false and mimeType!=' + q(FOLDER))).filter(x => /\.json$/i.test(x.name)).map(item);
    },
    async byName(ctx, name) {
      const f = await folder(ctx);
      const hit = (await list(ctx, 'name=' + q(name) + ' and ' + q(f.fileId) + ' in parents and trashed=false'))[0];
      return hit ? item(hit) : null;
    },
    async meta(ctx, fileId) {
      const f = await api(ctx, 'GET', API + '/files/' + encodeURIComponent(fileId) + '?fields=' + FIELDS);
      if (f.trashed) throw Object.assign(new Error('In the trash'), { status: 404 });
      return item(f);
    },
    async get(ctx, fileId) {
      const meta = await GD.meta(ctx, fileId);
      if (meta.size > MAX_READ) throw Object.assign(new Error('The cloud file is too large to open (' + Math.round(meta.size / 1048576) + ' MB)'), { code: 'tooLarge' });
      const res = await api(ctx, 'GET', API + '/files/' + encodeURIComponent(fileId) + '?alt=media', { raw: true });
      return Object.assign(meta, { text: await res.text() });
    },

    // A new file by name (a name taken in the folder fails with 409, as on OneDrive), or an existing one by id, only
    // while it is still the version last synced (else 412).
    async put(ctx, o) {
      try { return await write(ctx, o); }
      catch (e) {
        if (o.fileId || e.status !== 404) throw e;
        await folder(ctx, true); // GenGIS's folder was deleted meanwhile: into the one there now (or a new one)
        return write(ctx, o);
      }
    },

    async rename(ctx, fileId, name) {
      const other = await GD.byName(ctx, name);
      if (other && other.fileId !== fileId) throw Object.assign(new Error('A file of that name is there'), { status: 409 });
      return item(await api(ctx, 'PATCH', API + '/files/' + encodeURIComponent(fileId) + '?fields=' + FIELDS, { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) }));
    },
    remove: (ctx, fileId) => api(ctx, 'DELETE', API + '/files/' + encodeURIComponent(fileId)),

    // What changed since cursor (none: the whole folder, and a cursor to continue from).
    async changes(ctx, cursor) {
      const f = await folder(ctx);
      if (!cursor) {
        const start = await api(ctx, 'GET', API + '/changes/startPageToken');
        return { items: await GD.list(ctx), cursor: start.startPageToken, full: true, reset: false };
      }
      const items = [], outside = [];
      let token = cursor, next = null;
      try {
        while (token) {
          const page = await api(ctx, 'GET', API + '/changes?pageSize=1000&spaces=drive&includeRemoved=true&pageToken=' + encodeURIComponent(token) +
            '&fields=' + encodeURIComponent('nextPageToken,newStartPageToken,changes(fileId,removed,file(' + FIELDS + '))'));
          (page.changes || []).forEach(c => {
            if (c.removed || (c.file && c.file.trashed)) items.push({ fileId: c.fileId, deleted: true });
            else if (c.file && (c.file.parents || []).includes(f.fileId) && /\.json$/i.test(c.file.name)) items.push(item(c.file));
            else if (c.file && c.file.mimeType !== FOLDER) outside.push(c.file);
          });
          token = page.nextPageToken || null;
          next = page.newStartPageToken || next;
        }
      } catch (e) {
        if (e.status === 400 || e.status === 404 || e.status === 410) return { items: [], cursor: null, reset: true };
        throw e;
      }
      if (outside.length) {
        // a file not (or no longer) in GenGIS's folder: moved away by the user, unless GenGIS's folder itself changed
        // (two folders merged): then everything is looked at again
        const now = await folder(ctx, true);
        if (now.fileId !== f.fileId) return { items: [], cursor: null, reset: true };
        outside.forEach(x => items.push({ fileId: x.id, deleted: true }));
      }
      return { items, cursor: next || cursor, reset: false };
    }
  };

  // Writes a file (GD.put).
  async function write(ctx, o) {
    const f = await folder(ctx), bytes = new TextEncoder().encode(o.text);
    if (o.fileId && o.ifMatch) {
      const now = await GD.meta(ctx, o.fileId); // (404 when gone or in the trash)
      if (now.etag !== String(o.ifMatch)) throw Object.assign(new Error('Changed in the cloud'), { status: 412 });
    }
    if (!o.fileId && await GD.byName(ctx, o.name)) throw Object.assign(new Error('A file of that name is there'), { status: 409 });
    const meta = o.fileId ? null : { name: o.name, parents: [f.fileId], mimeType: 'application/json' };
    if (bytes.length <= SIMPLE_MAX) {
      if (o.fileId) return item(await api(ctx, 'PATCH', UPLOAD + '/files/' + encodeURIComponent(o.fileId) + '?uploadType=media&fields=' + FIELDS, { headers: { 'Content-Type': 'application/json' }, body: bytes }));
      const boundary = 'gengis' + Math.random().toString(36).slice(2);
      const head = new TextEncoder().encode('--' + boundary + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' + JSON.stringify(meta) + '\r\n--' + boundary + '\r\nContent-Type: application/json\r\n\r\n');
      const tail = new TextEncoder().encode('\r\n--' + boundary + '--');
      const body = new Uint8Array(head.length + bytes.length + tail.length);
      body.set(head); body.set(bytes, head.length); body.set(tail, head.length + bytes.length);
      return item(await api(ctx, 'POST', UPLOAD + '/files?uploadType=multipart&fields=' + FIELDS, { headers: { 'Content-Type': 'multipart/related; boundary=' + boundary }, body }));
    }
    // resumable: a session, then chunks to its address
    const start = await api(ctx, o.fileId ? 'PATCH' : 'POST', UPLOAD + '/files' + (o.fileId ? '/' + encodeURIComponent(o.fileId) : '') + '?uploadType=resumable&fields=' + FIELDS,
      { raw: true, headers: { 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': 'application/json', 'X-Upload-Content-Length': String(bytes.length) }, body: JSON.stringify(meta || {}) });
    const session = start.headers.get('Location');
    if (!session) throw new Error('No upload session');
    // Drive says how much it has (308 + Range): the next chunk starts there, which may be short of what was sent
    let at = 0, stalls = 0;
    for (;;) {
      const end = Math.min(at + CHUNK, bytes.length);
      let res;
      try { res = await ctx.fetch(session, { method: 'PUT', headers: { Authorization: 'Bearer ' + await ctx.token(), 'Content-Range': `bytes ${at}-${end - 1}/${bytes.length}` }, body: bytes.subarray(at, end) }); }
      catch (e) { const err = new Error('offline'); err.code = 'network'; throw err; }
      if (res.ok) { if (o.onProgress) o.onProgress(bytes.length, bytes.length); return item(await res.json()); }
      if (res.status !== 308) throw await httpError(res, 'upload');
      const m = /bytes=0-(\d+)/.exec(res.headers.get('Range') || '');
      const got = m ? +m[1] + 1 : 0;
      stalls = got > at ? 0 : stalls + 1;
      if (stalls > 3 || got >= bytes.length) throw Object.assign(new Error('The upload did not go through'), { status: 503 }); // (tried again later, from the start)
      at = got;
      if (o.onProgress) o.onProgress(at, bytes.length);
    }
  }

  MB.cloudProviders = MB.cloudProviders || {};
  MB.cloudProviders.gdrive = GD;
})(window.MB);
