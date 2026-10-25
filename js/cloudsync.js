/* GenGIS - cloud sync: projects kept in step with the user's OneDrive or Google Drive.
 *
 * Local first: the project store (projectstore.js) stays the main copy and keeps working offline; the cloud copy is
 * one more, like a project file. Each named project is one .gengis.json file in GenGIS's folder of the account.
 * - push: a few seconds after a background save, when the project's content changed (panning and zooming alone do
 *   not upload); offline, or while signed out, it waits and goes when it can
 * - pull: at start-up, when the app comes back into view, every few minutes, and when the network returns, through
 *   the provider's change feed; a project changed in the cloud and not here is updated here (a recovery copy is kept)
 * - never lose work: a file is only replaced when it is still the version last synced (its eTag); otherwise the
 *   project is in conflict and the user chooses (keep both, the cloud copy, or this one)
 * - one tab at a time does the work (Web Locks), re-reading the shared records inside the lock
 * Accounts and tokens live in this module's own database ("gengis-cloud"), never in settings, projects or the
 * address; in the desktop app the sign-in itself stays in its main process (electron/cloudauth.js), encrypted, and
 * this page only ever holds short-lived access tokens. State per project: synced | pending | syncing | offline |
 * conflict | error | signin.
 */
window.MB = window.MB || {};
(function (MB) {
  'use strict';

  const PUSH_DELAY = 3000;            // ms after a background save (a burst of saves is one upload)
  // Checking the cloud for changes while the app is in view: often while someone is working (a change made here or
  // arriving from elsewhere in the last couple of minutes), less when all is quiet; never while hidden. Fast enough
  // for two devices on one map, slow enough to stay far below OneDrive's request limits and spare a phone's battery
  // (instant updates would need a server for the provider's notifications; GenGIS has none).
  const PULL_ACTIVE = 10 * 1000, PULL_IDLE = 30 * 1000, ACTIVE_FOR = 2 * 60 * 1000;
  const PULL_MIN = 10 * 1000;         // at least this long between checks when the app comes into view or focus
  const TOKEN_MARGIN = 5 * 60 * 1000; // an access token is renewed when it has less left than this
  const SILENT_EVERY = 12 * 3600 * 1000; // a silent sign-in at start-up at most this often
  const BACKOFF_MAX = 5 * 60 * 1000;
  const LOCK = 'gengis.cloud.sync';

  /* ---------- the module's database (replaceable: tests use a memory store) ---------- */
  function idbStore() {
    let dbp = null;
    const db = () => dbp || (dbp = new Promise((res, rej) => {
      let r;
      try { r = indexedDB.open('gengis-cloud', 1); } catch (e) { rej(e); return; }
      r.onupgradeneeded = () => {
        const d = r.result;
        if (!d.objectStoreNames.contains('accounts')) d.createObjectStore('accounts', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('links')) d.createObjectStore('links', { keyPath: 'projectId' });
      };
      r.onsuccess = () => res(r.result);
      r.onerror = r.onblocked = () => rej(r.error || new Error('no database'));
    }));
    const tx = (table, mode, fn) => db().then(d => new Promise((res, rej) => {
      const t = d.transaction(table, mode), q = fn(t.objectStore(table));
      t.oncomplete = () => res(q && q.result);
      t.onerror = t.onabort = () => rej(t.error);
    }));
    return {
      get: (t, k) => tx(t, 'readonly', s => s.get(k)).then(v => v || null),
      all: t => tx(t, 'readonly', s => s.getAll()).then(v => v || []),
      put: (t, v) => tx(t, 'readwrite', s => s.put(v)),
      del: (t, k) => tx(t, 'readwrite', s => s.delete(k))
    };
  }

  const C = MB.cloud = {
    ready: false,
    accounts: [],         // as last read: { id, provider, name, email, kind, state, error, auto }
    links: {},            // projectId -> link, as last read (the store is the truth: re-read inside the lock)
    progress: {},         // projectId -> { done, total } while a large file uploads
    lastError: '',        // the last sign-in failure, for the dialog
    env: {                // what the engine runs on (tests replace these)
      store: null, fetch: (u, o) => (desktop() && desktop().fetch ? desktopFetch(u, o) : fetch(u, o)), now: () => Date.now(),
      online: () => navigator.onLine !== false, visible: () => document.visibilityState !== 'hidden',
      lock: fn => (navigator.locks ? navigator.locks.request(LOCK, () => fn()) : fn()),
      go: null,           // where a sign-in navigates (location.assign)
      pushDelay: PUSH_DELAY,
      backoffBase: 2000   // ms: the first retry after a passing failure (doubling, to BACKOFF_MAX)
    }
  };
  const env = C.env;
  const providers = () => MB.cloudProviders || {};
  const providerOf = acc => providers()[acc && acc.provider];
  const desktop = () => window.gengisDesktop && window.gengisDesktop.cloud;
  // Where an account's sign-in is kept: 'refresh' (a refresh token here: OneDrive on the web), 'web' (an access token
  // only, for its hour: Google Drive on the web), 'desktop' (in the desktop app's main process).
  const sourceOf = acc => acc.source || 'refresh';
  // In the desktop app the cloud's requests go through its main process (a file:// page has no origin for the APIs'
  // CORS): what comes back is made to look like fetch's answer. An address it refuses is an error, not a network blip.
  async function desktopFetch(url, o) {
    o = o || {};
    const body = o.body == null ? null : (ArrayBuffer.isView(o.body) ? o.body.slice() : o.body); // (a chunk alone, not its whole buffer)
    const r = await desktop().fetch(String(url), o.method || 'GET', o.headers || {}, body);
    if (r && r.error === 'network') throw new TypeError(r.message || 'Failed to fetch');
    const status = r && r.error ? 400 : r.status, h = (r && r.headers) || {};
    const bytes = r && r.body ? new Uint8Array(r.body) : new Uint8Array(0);
    const text = () => (r && r.error ? JSON.stringify({ error: { message: 'Not allowed: ' + r.error } }) : new TextDecoder().decode(bytes));
    return { status, ok: status >= 200 && status < 300, headers: { get: k => (h[String(k).toLowerCase()] != null ? h[String(k).toLowerCase()] : null) },
      text: async () => text(), json: async () => JSON.parse(text()), arrayBuffer: async () => bytes.slice().buffer };
  }
  C.offered = () => Object.keys(providers()).filter(k => providers()[k].available());
  const emit = () => MB.emit('cloudsync', C);
  const store = () => env.store || (env.store = idbStore());

  /* ---------- project content: what counts as a change ---------- */
  // The project without what changes on its own (the save time, the view: a pan is not worth an upload) and without
  // what each device keeps its own (the app's version; live traffic and drone servers set on a device stay there):
  // two devices must not upload back and forth over those.
  const LOCAL_ONLY = ['savedAt', 'view', 'generator', 'liveTraffic', 'vesselTraffic', 'drones'];
  const sorted = v => Array.isArray(v) ? v.map(sorted)
    : (v && typeof v === 'object' ? Object.keys(v).sort().reduce((o, k) => { o[k] = sorted(v[k]); return o; }, Object.create(null)) : v);
  function canon(p) { const c = sorted(p || {}); LOCAL_ONLY.forEach(k => { delete c[k]; }); return JSON.stringify(c); }
  async function hashOf(p) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canon(p)));
    return Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('');
  }
  C.canon = canon; C.hashOf = hashOf;

  // The cloud file's name for a project (characters OneDrive and Drive refuse, replaced).
  function fileName(name, n) {
    let base = String(name || 'map').replace(/[\\/:*?"<>|#%\u0000-\u001f]+/g, '_').replace(/[. ]+$/, '').trim() || 'map';
    if (base.length > 120) base = base.slice(0, 120).trim();
    if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(base)) base = '_' + base; // names Windows (and so OneDrive) reserve
    return base + (n > 1 ? ' (' + n + ')' : '') + MB.PROJECT_EXT;
  }
  C.fileName = fileName;
  const isDraftRec = rec => /^\s*untitled( map)?\s*$/i.test(rec.name || (rec.data && rec.data.name) || '') && !rec.fileBacked;

  /* ---------- accounts and tokens ---------- */
  const tokens = new Map();     // accountId -> { access, exp }
  const renewing = new Map();   // accountId -> Promise of an access token

  async function readAccounts() {
    const all = await store().all('accounts');
    C.accounts = all.map(a => ({ id: a.id, provider: a.provider, name: a.name, email: a.email, kind: a.kind, state: a.state || 'ok', error: a.error || '', auto: a.auto !== false, pullError: a.pullError || '' }));
    return all;
  }
  async function readLinks() {
    const all = await store().all('links');
    C.links = {};
    all.forEach(l => { C.links[l.projectId] = l; });
    return all;
  }
  const signinError = msg => Object.assign(new Error(msg || 'Sign in again'), { code: 'signin' });

  // An access token for an account: the one in memory while it lasts, else a new one from where its sign-in is kept.
  function accessToken(accId) {
    const t = tokens.get(accId);
    if (t && t.exp - env.now() > TOKEN_MARGIN) return Promise.resolve(t.access);
    if (renewing.has(accId)) return renewing.get(accId);
    const p = (async () => {
      const acc = await store().get('accounts', accId);
      if (!acc) throw signinError('The account is no longer connected');
      if (acc.state === 'signin') throw signinError(acc.error);
      const prov = providerOf(acc);
      let r;
      try { r = await renew(acc, prov); }
      catch (e) {
        if (e.code === 'network' || (e.status >= 500)) throw e; // try again later; the sign-in may still be good
        acc.state = 'signin'; acc.error = prov.explain(e.code, e.description || e.message);
        delete acc.accessToken; delete acc.accessExp;
        await store().put('accounts', acc);
        await readAccounts(); emit();
        throw signinError(acc.error);
      }
      tokens.set(accId, { access: r.access, exp: env.now() + r.expiresIn * 1000 });
      return r.access;
    })();
    renewing.set(accId, p);
    const clear = () => renewing.delete(accId);
    p.then(clear, clear);
    return p;
  }

  // A new access token ({ access, expiresIn } s) from where the account's sign-in is kept.
  async function renew(acc, prov) {
    const src = sourceOf(acc);
    if (src === 'desktop') {
      const r = desktop() ? await desktop().token(acc.id) : { error: 'signin' };
      if (r && r.accessToken) return { access: r.accessToken, expiresIn: +r.expiresIn || 3600 };
      const code = (r && r.error) || 'signin';
      if (code === 'network' || code === 'server') throw Object.assign(new Error((r && r.message) || 'offline'), { code: 'network' });
      throw Object.assign(new Error((r && r.message) || 'Sign in again'), { code });
    }
    if (src === 'web') return prov.renew(acc, env.now());
    if (!acc.refreshToken) throw Object.assign(new Error(acc.error || 'Sign in again'), { code: 'signin' });
    const r = await MB.oauth.refresh(prov.auth(), acc.refreshToken, env.fetch);
    if (r.refresh_token && r.refresh_token !== acc.refreshToken) { acc.refreshToken = r.refresh_token; acc.refreshedAt = env.now(); await store().put('accounts', acc); }
    return { access: r.access_token, expiresIn: +r.expires_in || 3600 };
  }

  // An access token refused (401): forgotten, and one kept for its hour (a web app's Google sign-in) no longer trusted.
  async function dropToken(accId) {
    tokens.delete(accId);
    const acc = await store().get('accounts', accId);
    if (acc && acc.accessToken) { delete acc.accessToken; delete acc.accessExp; await store().put('accounts', acc); }
  }

  // A provider call for an account; an expired token (401) is renewed and the call made once more.
  async function call(acc, fn) {
    const prov = providerOf(acc);
    const ctx = { fetch: env.fetch, token: () => accessToken(acc.id), account: acc.id };
    try { return await fn(prov, ctx); }
    catch (e) {
      if (e.status !== 401) throw e;
      await dropToken(acc.id);
      return fn(prov, ctx);
    }
  }

  /* ---------- links ---------- */
  async function saveLink(l) { await store().put('links', l); C.links[l.projectId] = l; }
  function setState(l, state, error) {
    l.state = state; l.error = error || '';
    C.links[l.projectId] = l;
    emit();
  }
  // The account a project syncs to: its link's, or (named projects, not excluded) the first account syncing all.
  async function accountFor(projectId) {
    const l = await store().get('links', projectId);
    if (l && l.excluded) return null;
    const accs = await store().all('accounts');
    if (l && l.accountId) return accs.find(a => a.id === l.accountId) || null;
    return accs.find(a => a.auto !== false) || null;
  }

  /* ---------- the queue ---------- */
  const queue = new Set(), timers = new Map(), retries = new Map();
  let pumping = null;

  // A project to upload soon (after a background save, or when something it waited for comes back).
  C.schedule = function (projectId, delay) {
    if (!C.ready || !projectId) return;
    clearTimeout(timers.get(projectId));
    timers.set(projectId, setTimeout(() => { timers.delete(projectId); queue.add(projectId); pump(); }, delay == null ? env.pushDelay : delay));
  };
  function pump() {
    if (pumping) { pumping.then(() => { if (queue.size) pump(); }); return pumping; }
    pumping = (async () => {
      while (queue.size) {
        const id = queue.values().next().value;
        queue.delete(id);
        try { await env.lock(() => push(id)); } catch (e) { console.warn('Cloud sync', e); }
      }
    })().finally(() => { pumping = null; });
    return pumping;
  }
  function retryLater(l, e) {
    const n = (retries.get(l.projectId) || 0) + 1;
    retries.set(l.projectId, n);
    const wait = e && e.retryAfter ? e.retryAfter * 1000 : Math.min(BACKOFF_MAX, env.backoffBase * Math.pow(2, n - 1)) * (0.75 + Math.random() * 0.5);
    C.schedule(l.projectId, wait);
  }

  // Upload a project if its content differs from what was last synced. Inside the lock.
  async function push(projectId, force) {
    const acc = await accountFor(projectId);
    if (!acc) return;
    const rec = await MB.projects.get(projectId);
    if (!rec || isDraftRec(rec)) return;
    let l = await store().get('links', projectId) || { projectId, accountId: acc.id, state: 'pending' };
    if (l.excluded) return;
    l.accountId = acc.id;
    if (l.state === 'conflict' && !force) { C.links[projectId] = l; emit(); return; } // the user decides
    const hash = await hashOf(rec.data);
    const renamed = l.fileId && l.nameFor !== rec.name;
    if (!force && l.fileId && hash === l.hash && !renamed) { retries.delete(projectId); if (l.state !== 'synced') { setState(l, 'synced'); await saveLink(l); } return; }
    if (!env.online()) { setState(l, 'offline'); await saveLink(l); return; }
    if (acc.state === 'signin') { setState(l, 'signin', acc.error); await saveLink(l); return; }
    setState(l, 'syncing');
    const text = JSON.stringify(rec.data, null, 1);
    try {
      let out;
      await call(acc, async (prov, ctx) => {
        const onProgress = (d, t) => { C.progress[projectId] = { done: d, total: t }; emit(); };
        if (l.fileId && (force || hash !== l.hash)) {
          try { out = await prov.put(ctx, { fileId: l.fileId, text, ifMatch: force ? force.ifMatch : l.etag, onProgress }); }
          catch (e) {
            if (e.status !== 404) throw e;
            l.fileId = null; // deleted in the cloud while edited here: written again as a new file
          }
        }
        if (!l.fileId) out = await create(prov, ctx, rec, text, onProgress);
        else if (!out) out = { fileId: l.fileId, name: l.name, etag: l.etag };
        // the project was renamed here: its file follows (a name taken in the folder gets a number)
        if (renamed && l.fileId && !out.adopted) out = await renameTo(prov, ctx, out, rec.name);
        if (!out.etag) out = Object.assign(out, await prov.meta(ctx, out.fileId)); // never left without the version to guard the next write
      });
      delete C.progress[projectId];
      if (out.adopted) { // this project's own file was already there (another device, or before a reconnect)
        Object.assign(l, { fileId: out.fileId, name: out.name, nameFor: rec.name, etag: out.etag, remoteEtag: null });
        if (out.hash === hash) { Object.assign(l, { hash, syncedAt: env.now() }); retries.delete(projectId); setState(l, 'synced'); await saveLink(l); return; }
        l.hash = null; l.state = 'conflict'; l.error = ''; await saveLink(l); notify(l, 'conflict'); emit(); return;
      }
      Object.assign(l, { fileId: out.fileId, name: out.name, nameFor: rec.name, etag: out.etag, hash, syncedAt: env.now(), remoteEtag: null });
      retries.delete(projectId);
      setState(l, 'synced');
      await saveLink(l);
    } catch (e) {
      delete C.progress[projectId];
      await failed(l, e);
    }
  }
  C._push = push;

  // A new file for a project. A name already taken in the folder may be this very project's file (opened on another
  // device, or synced before a disconnect): then that file is adopted, not duplicated. Otherwise the next number.
  async function create(prov, ctx, rec, text, onProgress) {
    for (let n = 1; n < 50; n++) {
      const name = fileName(rec.name, n);
      try { return await prov.put(ctx, { name, text, onProgress }); }
      catch (e) {
        if (e.status !== 409) throw e;
        const mine = await sameProject(prov, ctx, name, rec.id);
        if (mine) return mine;
      }
    }
    throw new Error('Could not find a free file name');
  }
  async function sameProject(prov, ctx, name, projectId) {
    const meta = await prov.byName(ctx, name).catch(() => null);
    if (!meta) return null;
    let data;
    try { const f = await prov.get(ctx, meta.fileId); data = JSON.parse(f.text); Object.assign(meta, { etag: f.etag }); } catch (e) { return null; }
    if (!data || !MB.isProject(data) || data.id !== projectId) return null;
    return Object.assign(meta, { adopted: true, hash: await hashOf(data) });
  }
  async function renameTo(prov, ctx, out, name) {
    for (let n = 1; n < 50; n++) {
      const want = fileName(name, n);
      if (out.name === want) return out;
      try { return await prov.rename(ctx, out.fileId, want); }
      catch (e) { if (e.status !== 409) return out; } // keep the old name if it cannot be renamed
    }
    return out;
  }

  async function failed(l, e) {
    if (e.status === 412) { l.state = 'conflict'; l.error = ''; await saveLink(l); notify(l, 'conflict'); emit(); return; }
    if (e.code === 'signin') { setState(l, 'signin', e.message); await saveLink(l); return; }
    if (!env.online()) { setState(l, 'offline'); await saveLink(l); return; } // resumes when the network returns
    const transient = e.status === 429 || e.status >= 500 || e.status === 423 || e.code === 'network';
    if (e.status === 507 || e.code === 'quotaLimitReached' || e.code === 'insufficientStorage') { setState(l, 'error', 'The cloud storage is full'); await saveLink(l); notify(l, 'error'); return; }
    setState(l, transient ? 'pending' : 'error', e.message);
    await saveLink(l);
    if (!transient) { notify(l, 'error'); return; }
    retryLater(l, e);
    if ((retries.get(l.projectId) || 0) >= 6) notify(l, 'retrying'); // still trying, a few minutes apart: said once
  }

  // One message per project and state change (no toast storms).
  const told = {};
  function notify(l, what) {
    if (told[l.projectId] === what) return;
    told[l.projectId] = what;
    const name = (l.nameFor || (l.name || '').replace(/\.gengis\.json$/i, '')) || 'A project';
    if (what === 'conflict') MB.toast('"' + name + '" was edited in two places. Tap Resolve.', 6000);
    else if (what === 'error') MB.toast('Could not sync "' + name + '": ' + (l.error || 'error') + '. Still saved here.', 6000);
    else if (what === 'retrying') MB.toast('Can\'t reach the cloud for "' + name + '". Still saved here; trying again.', 6000);
  }

  /* ---------- pulling ---------- */
  let lastPull = 0, pulling = null, lastActivity = 0;
  // How long until the next check is due (ms): sooner while there is activity.
  C.pullInterval = () => (env.now() - lastActivity < ACTIVE_FOR ? PULL_ACTIVE : PULL_IDLE);
  C.activity = () => { lastActivity = env.now(); };
  C.pull = function (force) {
    if (!C.ready || pulling) return pulling || Promise.resolve();
    if (!force && env.now() - lastPull < PULL_MIN) return Promise.resolve();
    lastPull = env.now();
    pulling = env.lock(async () => {
      for (const acc of await store().all('accounts')) {
        if (acc.state === 'signin' || !env.online()) continue;
        let problem = '';
        try { await pullAccount(acc); }
        catch (e) { if (e.code !== 'signin' && e.code !== 'network') { problem = e.message || String(e); console.warn('Cloud sync: checking for changes', e); } }
        // a check that keeps failing shows on the account (changes from other devices are not arriving)
        const fresh = await store().get('accounts', acc.id);
        if (fresh && (fresh.pullError || '') !== problem) { fresh.pullError = problem; await store().put('accounts', fresh); }
      }
      await settleRemote();
      await readAccounts(); await readLinks(); // what other tabs changed shows here too
    }).finally(() => { pulling = null; emit(); });
    return pulling;
  };

  // GenGIS's folder, checked once a session and on every full re-check: when Microsoft has given GenGIS a new one
  // (the old one was renamed, moved or deleted), every project is uploaded to it again rather than taken for deleted.
  const rootSeen = new Set();
  async function checkRoot(acc) {
    const root = await call(acc, (prov, ctx) => prov.root(ctx));
    rootSeen.add(acc.id);
    if (acc.rootId === root.fileId) return;
    const changed = !!acc.rootId;
    const fresh = await store().get('accounts', acc.id);
    if (fresh) { fresh.rootId = root.fileId; if (changed) fresh.cursor = null; await store().put('accounts', fresh); }
    acc.rootId = root.fileId;
    if (!changed) return;
    acc.cursor = null;
    for (const l of await store().all('links')) {
      if (l.accountId !== acc.id || !l.fileId) continue;
      Object.assign(l, { fileId: null, etag: null, hash: null, remoteEtag: null, name: null, state: 'pending', error: '' });
      await saveLink(l);
      C.schedule(l.projectId, 500);
    }
    MB.toast(providerOf(acc).name + ' has a new folder for GenGIS (' + root.name + '): the old one was renamed, moved or deleted. Your projects are being uploaded to it.', 9000);
  }

  async function pullAccount(acc) {
    if (!rootSeen.has(acc.id) || !acc.cursor) await checkRoot(acc);
    let res = await call(acc, (prov, ctx) => prov.changes(ctx, acc.cursor || null));
    let full = !acc.cursor || res.reset || res.full; // everything in the folder, not just what changed
    if (res.reset) { acc.cursor = null; res = await call(acc, (prov, ctx) => prov.changes(ctx, null)); full = true; }
    const links = (await store().all('links')).filter(l => l.accountId === acc.id && l.fileId);
    if (full) { // a linked file missing from the whole folder may have been deleted while no feed reported it:
      const live = new Set(res.items.filter(it => !it.deleted).map(it => it.fileId));
      for (const l of links) {
        if (live.has(l.fileId)) continue;
        // ...only when the file itself says so (a listing can lag a moment behind a write)
        try { await call(acc, (prov, ctx) => prov.meta(ctx, l.fileId)); } catch (e) { if (e.status === 404) await removedRemotely(l); }
      }
    }
    for (const it of res.items) {
      const l = links.find(x => x.fileId === it.fileId);
      if (!l) continue;
      if (it.deleted) { await removedRemotely(l); continue; }
      if (it.etag !== l.etag) { l.remoteEtag = it.etag; await saveLink(l); }
    }
    const fresh = await store().get('accounts', acc.id); // (its token may have been renewed meanwhile)
    if (fresh) { fresh.cursor = res.cursor; await store().put('accounts', fresh); }
  }

  // Deleted in the cloud: the project stays here and stops syncing (not uploaded again unless the user chooses to).
  async function removedRemotely(l) {
    await saveLink({ projectId: l.projectId, excluded: true, state: '' });
    MB.toast('"' + (l.nameFor || l.name) + '" was deleted from the cloud. Kept here, sync off.', 6000);
  }

  // Links whose cloud file changed: taken here when this tab may (the project is not open in another tab).
  async function settleRemote() {
    for (const l of await store().all('links')) {
      if (!l.remoteEtag || l.remoteEtag === l.etag || l.state === 'conflict') continue;
      const mine = MB.state.projectId === l.projectId && MB.projects.owns();
      if (!mine && await MB.projects.openElsewhere(l.projectId)) continue; // another tab edits it: that tab takes it
      const acc = await store().get('accounts', l.accountId);
      if (!acc || acc.state === 'signin') continue;
      try { await remoteChanged(acc, l); } catch (e) { if (e.code !== 'network') console.warn('Cloud sync: taking a cloud change', e); }
    }
  }

  // A project's cloud file changed: take it if this device has no changes of its own since the last sync; otherwise
  // the user chooses.
  async function remoteChanged(acc, l) {
    const remote = await call(acc, (prov, ctx) => prov.get(ctx, l.fileId));
    let data;
    try { data = JSON.parse(remote.text); } catch (e) { data = null; }
    if (!data || !MB.isProject(data)) { l.remoteEtag = null; l.etag = remote.etag; setState(l, 'error', 'The cloud file is not a GenGIS project'); await saveLink(l); return; }
    const remoteHash = await hashOf(data);
    if (remoteHash === l.hash) { l.etag = remote.etag; l.remoteEtag = null; await saveLink(l); return; } // the same content
    const rec = await MB.projects.get(l.projectId);
    if (!rec) { await store().del('links', l.projectId); delete C.links[l.projectId]; emit(); return; } // deleted here: nothing to sync to
    const open = MB.state.projectId === l.projectId;
    const localChanged = !rec || (await hashOf(rec.data)) !== l.hash || (open && MB.projects.dirty());
    if (localChanged) { l.state = 'conflict'; l.remoteEtag = remote.etag; await saveLink(l); notify(l, 'conflict'); emit(); return; }
    C.activity(); // someone is working on it elsewhere: check more often for a while
    await takeRemote(l, data, remote, remoteHash);
    MB.toast('"' + (data.name || l.nameFor) + '" updated from ' + providerOf(acc).name, 3500);
  }

  async function takeRemote(l, data, remote, remoteHash) {
    data = Object.assign({}, data, { id: l.projectId }); // the file belongs to this project, whatever id it carries
    if (!(await MB.projects.putSaved(data, 'before a cloud copy replaced it'))) throw new Error('Could not save the cloud copy on this device');
    let hash = remoteHash || await hashOf(data);
    if (MB.state.projectId === l.projectId && MB.projects.owns()) {
      MB.loadProject(data, { keepView: true, keepHistory: false });
      // what this device will save of it from now on (its own normalization included): not a change to upload
      if (MB.serializeProject) hash = await hashOf(MB.serializeProject());
    }
    Object.assign(l, { etag: remote.etag, name: remote.name, nameFor: data.name, hash, remoteEtag: null, syncedAt: env.now() });
    told[l.projectId] = null;
    setState(l, 'synced');
    await saveLink(l);
  }

  /* ---------- conflicts ---------- */
  // choice: 'both' (the cloud copy becomes a project of its own, this one replaces the file), 'cloud' (the cloud
  // copy replaces this one; this one is kept as a recovery copy), 'mine' (this one replaces the file; the cloud
  // keeps the old version in its history).
  C.resolve = async function (projectId, choice) {
    // another tab edits it: there, or that tab would save its own copy over the choice made here
    if (!(MB.state.projectId === projectId && MB.projects.owns()) && await MB.projects.openElsewhere(projectId)) {
      MB.toast('This map is open in another tab. Resolve it there.', 5000);
      emit();
      return;
    }
    if (MB.state.projectId === projectId) await MB.projects.flush(); // the last moments' edits are in what is kept
    return env.lock(async () => {
      const l = await store().get('links', projectId), acc = l && await store().get('accounts', l.accountId);
      if (!l || !acc) return;
      const prov = providerOf(acc);
      try {
        if (choice === 'cloud') {
          const remote = await call(acc, (p, ctx) => p.get(ctx, l.fileId));
          const data = JSON.parse(remote.text);
          if (!MB.isProject(data)) throw new Error('The cloud file is not a GenGIS project');
          await takeRemote(l, data, remote);
          MB.toast('Using the ' + prov.name + ' version. Yours is in earlier copies.', 5000);
          return;
        }
        const meta = await call(acc, (p, ctx) => p.meta(ctx, l.fileId));
        if (choice === 'both') {
          const remote = await call(acc, (p, ctx) => p.get(ctx, l.fileId));
          const data = JSON.parse(remote.text);
          if (MB.isProject(data)) {
            const stamp = new Date(remote.modified || env.now()).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
            const copy = Object.assign({}, data, { id: MB.uid(), name: (data.name || 'Untitled map') + ' (' + prov.name + ', ' + stamp + ')' });
            await MB.projects.putSaved(copy);
            C.schedule(copy.id, 0); // it gets a file of its own
          }
        }
        told[projectId] = null;
        l.state = 'pending'; await saveLink(l);
        await push(projectId, { ifMatch: meta.etag });
        if (choice === 'both') MB.toast('Kept both. The cloud version is a separate project now.', 5000);
      } catch (e) { await failed(l, e); }
    });
  };

  /* ---------- connecting ---------- */
  let returned = null; // a sign-in coming back (taken from the address before anything else reads it)
  C.takeRedirect = function () { returned = MB.oauth.take(); return returned; };

  // Connect an account (or sign in to one again): in the desktop app through the user's browser; in the web app in a
  // pop-up (Google), or on the provider's sign-in page and back (OneDrive: what is pending is saved first).
  C.connect = async function (providerId, acc, silent) {
    const prov = providers()[providerId];
    if (!prov || !prov.available()) return;
    if (desktop() || prov.popup) {
      if (silent) return; // (the desktop app renews by itself; a pop-up needs a tap)
      let who, t, kept = true;
      try {
        if (desktop()) {
          MB.toast('Continue in your browser to sign in to ' + prov.name + '.', 6000);
          const r = await desktop().signIn(providerId, (acc && acc.email) || '');
          if (!r || r.error) throw Object.assign(new Error((r && r.message) || ''), { code: (r && r.error) || 'failed' });
          who = r.account; kept = r.kept !== false;
          t = { source: 'desktop', access: r.accessToken, expiresIn: +r.expiresIn || 3600 };
        } else {
          const r = await prov.signIn(acc);
          who = await prov.whoami(r.access, env.fetch);
          t = { source: 'web', access: r.access, expiresIn: +r.expiresIn || 3600 };
        }
      } catch (e) {
        C.lastError = prov.explain(e.code, e.message);
        MB.toast(C.lastError, 9000);
        MB.emit('cloud-return', C);
        return;
      }
      await finishAccount(prov, who, t);
      C.pull(true); // (its folder and change feed noted now, as after a sign-in that comes back to the page)
      if (!kept) MB.toast('This computer cannot keep the sign-in encrypted: you will sign in again when GenGIS restarts.', 8000);
      MB.emit('cloud-return', C);
      return;
    }
    await MB.projects.flush();
    if (!silent) MB.toast(prov.name + ' sign-in…', 3000);
    await MB.oauth.begin(prov.auth(prov.signInExtra(acc, silent)), { silent: !!silent, reopen: !silent }, env.go);
  };

  // A sign-in came back: finished here, and the user taken back to the dialog it started from (with any error).
  async function finishSignIn(r) {
    await finishSignInNow(r);
    if (!r.pending || r.pending.reopen) MB.emit('cloud-return', C);
  }
  async function finishSignInNow(r) {
    const prov = r.pending && providers()[r.pending.provider];
    if (!prov) { if (r.error) C.lastError = r.description; return; }
    if (r.error) {
      // a silent renewal that needs the user: no message, the "Sign in again" button is shown
      if (r.pending.silent && /login_required|interaction_required|consent_required|account_selection_required/.test(r.error)) return;
      C.lastError = prov.explain(r.error, r.description);
      MB.toast(C.lastError, 9000);
      return;
    }
    let tok;
    try { tok = await MB.oauth.exchange(prov.auth(), r.code, r.pending, env.fetch); }
    catch (e) { C.lastError = prov.explain(e.code, e.description || e.message); MB.toast(C.lastError, 9000); return; }
    await finishAccount(prov, prov.account(tok), { source: 'refresh', access: tok.access_token, expiresIn: +tok.expires_in || 3600, refresh: tok.refresh_token || '' }, r.pending.silent);
  }

  // A signed-in account, kept. The first one connected syncs all projects (one account at a time does).
  async function finishAccount(prov, who, t, quiet) {
    const old = await store().get('accounts', who.id);
    const auto = old ? old.auto !== false : !(await store().all('accounts')).some(a => a.auto !== false);
    const acc = Object.assign(old || {}, who, { auto, source: t.source, refreshToken: t.refresh || '', signedInAt: env.now(), state: 'ok', error: '' });
    delete acc.accessToken; delete acc.accessExp;
    if (t.source === 'web') { acc.accessToken = t.access; acc.accessExp = env.now() + t.expiresIn * 1000; } // (Google gives a web app nothing longer)
    if (t.source === 'refresh' && !t.refresh) acc.state = 'signin';
    await store().put('accounts', acc);
    tokens.set(acc.id, { access: t.access, exp: env.now() + t.expiresIn * 1000 });
    C.lastError = '';
    await readAccounts();
    if (!quiet) MB.toast('Connected to ' + prov.name, 3500);
    // what waited for the sign-in, and (syncing all) every named project
    const ids = new Set(Object.keys(C.links).filter(id => C.links[id].accountId === acc.id && !C.links[id].excluded));
    if (acc.auto) (await MB.projects.list()).forEach(r2 => { if (!isDraftRec(r2)) ids.add(r2.id); });
    ids.forEach(id => C.schedule(id, 500)); // (the queue takes them one at a time)
    emit();
  }

  C.disconnect = async function (accId) {
    const acc = await store().get('accounts', accId);
    if (!acc) return;
    const prov = providerOf(acc);
    await env.lock(async () => {
      for (const l of await store().all('links')) if (l.accountId === accId) await store().del('links', l.projectId);
      await store().del('accounts', accId);
    });
    tokens.delete(accId);
    // the sign-in given up where it is kept (the desktop app's forgotten; Google's revoked)
    if (sourceOf(acc) === 'desktop' && desktop()) desktop().signOut(accId).catch(() => {});
    else if (prov && prov.signOut) prov.signOut(acc, env.fetch).catch(() => {});
    await readAccounts(); await readLinks(); emit();
    MB.toast('Disconnected. Files stay in ' + prov.folder + '.', 5000);
  };

  // Sync one project to an account, or not at all (null): an explicit choice the "sync all" default respects.
  C.setSync = async function (projectId, accId) {
    await env.lock(async () => {
      const l = await store().get('links', projectId);
      if (!accId) await saveLink(Object.assign(l || { projectId }, { excluded: true, state: '' }));
      else await saveLink(Object.assign(l && !l.excluded && l.accountId === accId ? l : { projectId, state: 'pending' }, { accountId: accId, excluded: false }));
    });
    emit();
    if (accId) C.schedule(projectId, 0);
  };
  // "Sync all projects": one account at a time (new projects go there).
  C.setAuto = async function (accId, on) {
    const acc = await store().get('accounts', accId);
    if (!acc) return;
    if (on) for (const other of await store().all('accounts')) if (other.id !== accId && other.auto !== false) { other.auto = false; await store().put('accounts', other); }
    acc.auto = !!on; await store().put('accounts', acc); await readAccounts(); emit();
    if (on) (await MB.projects.list()).forEach(r => { if (!isDraftRec(r)) C.schedule(r.id, 300); });
  };

  // The cloud's project files that are not linked to a project here (for "Open from the cloud").
  C.listRemote = async function (accId) {
    const acc = await store().get('accounts', accId);
    if (!acc) return [];
    const files = await call(acc, (p, ctx) => p.list(ctx));
    const linked = new Set((await store().all('links')).filter(l => l.accountId === accId).map(l => l.fileId));
    return files.filter(f => !linked.has(f.fileId)).sort((a, b) => b.modified - a.modified);
  };

  // Open a project from the cloud: it becomes the open project, linked to its file.
  C.openRemote = async function (accId, fileId) {
    const acc = await store().get('accounts', accId);
    if (!acc) return;
    let remote, data;
    try { remote = await call(acc, (p, ctx) => p.get(ctx, fileId)); data = JSON.parse(remote.text); }
    catch (e) { MB.toast('Could not open it: ' + (e.message || e), 6000); return; }
    if (!MB.isProject(data)) { MB.toast('That file is not a GenGIS project.', 5000); return; }
    if (!(await MB.projects.beforeOpen(data))) return;
    const id = data.id;
    MB.loadProject(data);
    MB.projects.markFileBacked();
    const l = { projectId: MB.state.projectId, accountId: accId, fileId, name: remote.name, nameFor: MB.state.projectName, etag: remote.etag, hash: await hashOf(data), syncedAt: env.now(), state: 'synced' };
    if (id && id !== l.projectId) l.hash = null; // an id-less (older) file got a new id: synced again as is
    await env.lock(() => saveLink(l));
    emit();
  };

  // A project's state; its account being signed out shows (a conflict still comes first: it is the user's to settle).
  C.status = id => {
    const l = C.links[id];
    if (!l || l.excluded) return null;
    const acc = C.accounts.find(x => x.id === l.accountId);
    if (acc && acc.state === 'signin' && l.state !== 'conflict') return 'signin';
    return l.state || 'pending';
  };
  C.accountOf = id => { const l = C.links[id]; return l && C.accounts.find(a => a.id === l.accountId); };
  C._desktopFetch = desktopFetch; // (tests)
  C._busy = async () => !!(queue.size || timers.size || pumping || pulling || renewing.size);
  C.syncNow = async function () { await C.pull(true); queue.add(MB.state.projectId); return pump(); };

  /* ---------- start ---------- */
  C.init = async function () {
    if (!C.offered().length && !returned) return;
    if (C.ready) { if (returned) { const r = returned; returned = null; await finishSignIn(r); C.pull(true); } return; }
    try { await readAccounts(); await readLinks(); } catch (e) { console.warn('Cloud sync unavailable', e); return; }
    C.ready = true;
    if (returned) { const r = returned; returned = null; await finishSignIn(r); }
    emit();
    MB.on('saved', id => C.schedule(id));
    MB.on('project', emit);
    MB.on('project-removed', id => env.lock(() => store().del('links', id)).then(() => { delete C.links[id]; emit(); }));
    window.addEventListener('online', () => { C.pull(true); Object.keys(C.links).forEach(id => { if (['offline', 'pending'].includes(C.links[id].state)) C.schedule(id, 500); }); });
    // hidden (on a phone, often the last moment before the page is stopped): what waits to upload goes now
    document.addEventListener('visibilitychange', () => { if (env.visible()) C.pull(false); else C.flushNow(); });
    MB.on('saved', C.activity);
    window.addEventListener('focus', () => C.pull(false)); // clicking into this window (another one beside it may have changed the map)
    setInterval(() => { if (env.visible() && env.now() - lastPull >= C.pullInterval()) C.pull(true); }, 2000);
    await scanAll();
    await silentSignIn();
    C.pull(true);
  };

  // Uploads waiting for their delay: now.
  C.flushNow = function () {
    timers.forEach((t, id) => { clearTimeout(t); queue.add(id); });
    timers.clear();
    if (queue.size) pump();
  };

  // At start-up, every project whose content differs from what was last synced (the page was closed before its
  // upload, or the device was offline), and (syncing all) every named project not synced yet.
  async function scanAll() {
    const accs = await store().all('accounts');
    if (!accs.length) return;
    const auto = accs.some(a => a.auto !== false);
    for (const r of await MB.projects.list()) {
      if (isDraftRec(r)) continue;
      const l = C.links[r.id];
      if (l && l.excluded) continue;
      if (!l) { if (auto) C.schedule(r.id, 1500); continue; }
      if (l.state === 'conflict') continue;
      if (l.state !== 'synced') { C.schedule(r.id, 1500); continue; }
      const rec = await MB.projects.get(r.id);
      if (rec && (await hashOf(rec.data)) !== l.hash) C.schedule(r.id, 1500);
    }
  }

  // At start-up, an account whose sign-in ran out: renewed with a quick trip to the provider that shows nothing
  // while the user's session there is alive (at most twice a day; otherwise the "Sign in again" button).
  async function silentSignIn() {
    if (!env.online() || !env.visible()) return;
    for (const acc of await store().all('accounts')) {
      const prov = providerOf(acc);
      if (!prov || !prov.available() || sourceOf(acc) !== 'refresh') continue; // (only a redirect sign-in renews unseen)
      const expired = acc.state === 'signin' || (prov.signInDays && env.now() - (acc.signedInAt || 0) > prov.signInDays * 86400000 - 3600000);
      if (!expired || env.now() - (acc.silentAt || 0) < SILENT_EVERY) continue;
      const needed = acc.auto || Object.values(C.links).some(l => l.accountId === acc.id);
      if (!needed) continue;
      acc.silentAt = env.now(); await store().put('accounts', acc);
      await C.connect(acc.provider, acc, true);
      return; // the page goes to the provider and comes back
    }
  }
})(window.MB);
