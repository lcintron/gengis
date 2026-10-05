/* GenGIS - project store: saving in the background.
 *
 * Every change is saved, a moment after it, into IndexedDB (database "gengis-projects"): one record per project,
 * keyed by the project's id, plus rolling recovery copies. Recent projects can be reopened and an earlier copy
 * restored. A small copy also goes to localStorage while it fits: the app starts from it at once (the database is
 * asynchronous) and it is the save that still lands when the page is closing. Whichever copy is newer wins.
 *
 * A project is edited in one tab at a time: a second tab on the same project only shows it until "Edit here" moves
 * the editing to it (Web Locks). */
window.MB = window.MB || {};
(function (MB) {
  'use strict';

  const DB_NAME = 'gengis-projects';
  const MIRROR = 'gengis.project', OLD_MIRROR = 'map-builder.project.v1', CURRENT = 'gengis.currentProject';
  const MIRROR_MAX = 2 * 1024 * 1024;   // characters: larger projects live in the database only (localStorage is ~5 MB in all)
  const DELAY = 800;                    // ms after the last change
  const SNAP_EVERY = 10 * 60 * 1000;    // a recovery copy at most every 10 minutes of editing...
  const SNAP_KEEP = 10;                 // ...and the last 10 of them per project
  const esc = s => MB.escapeHtml(String(s == null ? '' : s));

  /* ---------- IndexedDB ---------- */
  let dbp = null;
  function db() {
    if (!dbp) dbp = new Promise(res => {
      let r;
      try { r = window.indexedDB && indexedDB.open(DB_NAME, 1); } catch (e) { r = null; }
      if (!r) { res(null); return; }
      r.onupgradeneeded = () => {
        const d = r.result;
        if (!d.objectStoreNames.contains('projects')) d.createObjectStore('projects', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('snapshots')) d.createObjectStore('snapshots', { keyPath: 'key' }).createIndex('byProject', 'id');
      };
      r.onsuccess = () => res(r.result);
      r.onerror = r.onblocked = () => res(null);
    });
    return dbp;
  }
  const done = q => new Promise((res, rej) => { q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
  // Run fn(stores...) in one transaction; resolves with fn's result once the transaction has committed.
  async function run(names, mode, fn) {
    const d = await db();
    if (!d) throw new Error('this browser keeps no database for the app');
    return new Promise((res, rej) => {
      const t = d.transaction(names, mode);
      let out;
      Promise.resolve(fn.apply(null, [].concat(names).map(n => t.objectStore(n)))).then(v => { out = v; }, e => { try { t.abort(); } catch (x) { /* ignore */ } rej(e); });
      t.oncomplete = () => res(out);
      t.onerror = t.onabort = () => rej(t.error || new Error('save aborted'));
    });
  }
  const snapsOf = (store, id) => done(store.index('byProject').getAll(IDBKeyRange.only(id)));

  /* ---------- state ---------- */
  const P = MB.projects = {
    status: 'idle',     // idle | saving | saved | error | readonly
    savedAt: 0,         // when the open project was last saved (ms)
    error: '',
    ready: false,       // false until start-up has settled which project is open: nothing is saved before
    readOnly: false,    // open in another tab: shown here, saved there
    persisted: null,    // whether the browser has promised not to clear the app's storage
    where: 'database',  // or 'browser storage' when IndexedDB is unavailable
    archived: false     // the open project, as it is now, is in the database (so Recent projects has it)
  };
  let timer = null, pending = false, lastSnap = {}, warned = false, lastFits = true;
  let heldId = null, release = null, owned = false, claiming = false;

  // Only the tab that holds the open project's lock writes it, and never while that is being settled.
  const canWrite = () => P.ready && !P.readOnly && owned && !claiming && MB.state.projectId === heldId;

  function setStatus(status, error) {
    P.status = status;
    P.error = error || '';
    MB.emit('savestate', P);
  }

  const summary = p => ({ id: p.id, name: p.name || 'Untitled map', objects: (p.features || []).length });

  /* ---------- saving ---------- */

  // A change happened: save it a moment later.
  P.schedule = function () {
    pending = true;
    P.archived = false;
    if (!canWrite()) return;
    clearTimeout(timer);
    if (P.status !== 'saving') setStatus('saving');
    timer = setTimeout(() => P.save(), DELAY);
  };

  // A project small enough goes to localStorage in full, at once (the pointer first: a full localStorage must not
  // leave start-up pointing at another project). A larger one replaces it there by a note only once the database
  // holds it, so the last full copy is never given up for a save that may fail.
  const noteOf = p => JSON.stringify({ id: p.id, savedAt: p.savedAt, inDatabase: true });
  function writeMirror(p, json) {
    try { localStorage.setItem(CURRENT, p.id); } catch (e) { /* ignore */ }
    try { localStorage.setItem(MIRROR, json); return true; } catch (e) { return false; }
  }

  // Keep the last SNAP_KEEP recovery copies of a project.
  async function prune(snaps, id) {
    const all = (await snapsOf(snaps, id)).sort((a, b) => b.savedAt - a.savedAt);
    all.slice(SNAP_KEEP).forEach(x => snaps.delete(x.key));
  }

  // Save the open project now. Resolves true once it is in the database.
  P.save = async function () {
    clearTimeout(timer);
    if (!canWrite()) return false;
    pending = false;
    const now = Date.now(), p = MB.serializeProject();
    p.savedAt = new Date(now).toISOString(); // one stamp for both copies: start-up compares them exactly
    const json = JSON.stringify(p);
    lastFits = json.length <= MIRROR_MAX;
    const mirrored = lastFits && writeMirror(p, json);
    let archived = false;
    try {
      const rec = Object.assign(summary(p), { savedAt: now, data: p });
      await run(['projects', 'snapshots'], 'readwrite', async (projects, snaps) => {
        projects.put(rec);
        // a recovery copy now and then, the oldest ones dropped
        if (!(p.id in lastSnap)) lastSnap[p.id] = Math.max(0, ...(await snapsOf(snaps, p.id)).map(x => x.savedAt));
        if (now - lastSnap[p.id] >= SNAP_EVERY) {
          snaps.put(Object.assign(summary(p), { key: p.id + '|' + now, savedAt: now, reason: 'autosave', data: p }));
          lastSnap[p.id] = now;
          await prune(snaps, p.id);
        }
      });
      archived = true;
      P.where = 'database';
      if (!lastFits) { try { localStorage.setItem(CURRENT, p.id); localStorage.setItem(MIRROR, noteOf(p)); } catch (e) { /* ignore */ } }
    } catch (e) {
      if (!mirrored) { pending = true; fail(e); return false; } // still to be saved: kept dirty, tried again
      P.where = 'browser storage'; // no database: the localStorage copy is the save, but not a Recent project
    }
    P.savedAt = now;
    P.archived = archived && !pending;
    setStatus(pending ? 'saving' : 'saved');
    if (pending) P.schedule();
    if (!warned) { warned = true; P.persist(false); }
    return archived;
  };

  function fail(e) {
    console.warn('Autosave failed', e);
    const first = P.status !== 'error';
    setStatus('error', e && e.message ? e.message : String(e));
    if (first) MB.toast('Autosave failed (' + P.error + '). Save your project to a file.', 6000);
  }

  // The page is being hidden or closed: save at once. A project that fits localStorage is written there before the
  // page goes; the database write is started and normally completes.
  P.saveNow = function () { if (canWrite() && pending) P.save(); };

  // Before another project replaces this one: save what is pending. Resolves true when the project is safely in
  // the database (or this tab does not own it: the tab that does saves it).
  P.flush = async function () {
    if (!canWrite()) return P.readOnly || !P.ready;
    if (pending || P.status === 'saving') await P.save();
    return P.archived;
  };

  // Ask before replacing a project that is not in the database (it would not be in Recent projects).
  P.confirmReplace = async function (what) {
    if (await P.flush()) return true;
    return confirm('"' + MB.state.projectName + '" could not be saved in this browser\'s project storage' + (P.error ? ' (' + P.error + ')' : '') +
      ', so it will not be in Recent projects. ' + what + ' anyway?\n\nChoose Cancel, then Project \u2192 Save project to keep it as a file.');
  };

  /* ---------- start-up ---------- */

  // Synchronous: open the project kept in localStorage, if it is there in full. Returns whether one was opened.
  let mirrorAt = 0, mirrorOpened = false;
  P.loadMirror = function () {
    try {
      const raw = MB.storedItem(MIRROR, OLD_MIRROR);
      if (!raw) return false;
      const p = JSON.parse(raw);
      if (p.inDatabase || !MB.isProject(p)) return false;
      MB.loadProject(p);
      mirrorAt = Date.parse(p.savedAt) || 0;
      mirrorOpened = p.id === MB.state.projectId; // an id-less 0.4 copy got a new id: nothing in the database to compare
      return true;
    } catch (e) { console.warn('Could not load the autosave', e); return false; }
  };

  // Asynchronous: the database copy of the open project replaces the localStorage one when it is newer (or the
  // only one). Saving starts afterwards, so start-up never overwrites a saved project with an empty one.
  P.start = function () {
    if (!P.started) P.started = startUp();
    return P.started;
  };
  async function startUp() {
    // edits made while the database is being read are the user's latest: they are kept, not replaced
    const shown = () => JSON.stringify(MB.serializeProject({ noView: true }));
    const before = shown();
    try {
      const want = MB.storedItem(CURRENT) || MB.state.projectId;
      let rec = want ? await run('projects', 'readonly', st => done(st.get(want))) : null;
      if (!rec && !mirrorOpened) { const last = (await P.list())[0]; if (last) rec = await run('projects', 'readonly', st => done(st.get(last.id))); } // no pointer: the most recent
      // the database copy when localStorage held none (a large project) or an older one
      if (rec && (!mirrorOpened || rec.savedAt > mirrorAt) && shown() === before) MB.loadProject(rec.data);
    } catch (e) { /* no database: the localStorage copy stands */ }
    P.ready = true;
    MB.on('project', () => { if (MB.state.projectId !== heldId) claim(MB.state.projectId); });
    await claim(MB.state.projectId);
    if (canWrite()) P.save();
    // A large project's last changes cannot be written while the page closes: let the browser ask first.
    window.addEventListener('beforeunload', e => {
      if (!canWrite() || !pending || lastFits) return;
      P.save();
      e.preventDefault();
      e.returnValue = '';
    });
  }

  /* ---------- recent projects and recovery copies ---------- */

  P.list = () => run('projects', 'readonly', s => done(s.getAll())).then(all => all.map(r => ({ id: r.id, name: r.name, objects: r.objects, savedAt: r.savedAt })).sort((a, b) => b.savedAt - a.savedAt)).catch(() => []);
  P.snapshots = id => run('snapshots', 'readonly', s => snapsOf(s, id)).then(all => all.map(s => ({ key: s.key, name: s.name, objects: s.objects, savedAt: s.savedAt, reason: s.reason })).sort((a, b) => b.savedAt - a.savedAt)).catch(() => []);

  // A recovery copy of what is saved for a project, before something replaces it.
  async function keepCopy(id, reason) {
    const now = Date.now();
    await run(['projects', 'snapshots'], 'readwrite', async (projects, snaps) => {
      const rec = await done(projects.get(id));
      if (!rec) return;
      snaps.put(Object.assign(summary(rec.data), { key: id + '|' + now, savedAt: now, reason, data: rec.data }));
      await prune(snaps, id);
    }).catch(() => {});
  }

  // A project file is being opened: if it is a project saved here, what is saved here is kept as a recovery copy.
  // Resolves false when the user would rather not replace the open project.
  P.beforeOpen = async function (p) {
    if (!(await P.confirmReplace('Open the file'))) return false;
    if (p && p.id) await keepCopy(p.id, 'before opening a file');
    return true;
  };

  P.open = async function (id) {
    if (!(await P.confirmReplace('Open the other project'))) return;
    const rec = await run('projects', 'readonly', s => done(s.get(id)));
    if (!rec) { MB.toast('That project is no longer saved here.'); return; }
    MB.loadProject(rec.data);
  };

  P.restore = async function (key) {
    const snap = await run('snapshots', 'readonly', s => done(s.get(key)));
    if (!snap) return;
    await P.flush();
    await keepCopy(snap.id, 'before restoring an earlier copy');
    MB.loadProject(snap.data);
    MB.toast('Restored the copy from ' + new Date(snap.savedAt).toLocaleString());
  };

  P.remove = function (id) {
    return run(['projects', 'snapshots'], 'readwrite', async (projects, snaps) => {
      projects.delete(id);
      (await snapsOf(snaps, id)).forEach(s => snaps.delete(s.key));
    }).then(() => { delete lastSnap[id]; }).catch(() => {});
  };

  // "Reset everything": the open project's saved copies go; other projects stay.
  P.removeCurrent = function () {
    try { localStorage.removeItem(MIRROR); } catch (e) { /* ignore */ }
    return P.remove(MB.state.projectId);
  };

  /* ---------- storage that the browser does not clear ---------- */

  const installed = () => (window.matchMedia && matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;
  const desktopApp = /Electron/.test(navigator.userAgent);
  // Without asking, only where the browser decides silently (installed app); asked, it may show a prompt (Firefox).
  P.persist = async function (asked) {
    const st = navigator.storage;
    if (desktopApp) { P.persisted = true; MB.emit('savestate', P); return true; } // the desktop app's storage is its own
    if (!st || !st.persisted) { P.persisted = null; MB.emit('savestate', P); return null; }
    try {
      P.persisted = await st.persisted();
      if (!P.persisted && st.persist && (asked || installed())) P.persisted = await st.persist();
    } catch (e) { /* ignore */ }
    MB.emit('savestate', P);
    return P.persisted;
  };

  /* ---------- one tab edits a project ---------- */
  // Nothing is written from the moment a claim starts until it is settled, and only for the project claimed.
  async function claim(id) {
    claiming = true; owned = false; clearTimeout(timer);
    if (release) { release(); release = null; }
    heldId = id;
    let granted = true;
    if (id && navigator.locks) {
      let resolveClaim;
      const claimed = new Promise(r => { resolveClaim = r; });
      navigator.locks.request('gengis.project.' + id, { ifAvailable: true }, lock => {
        if (!lock || heldId !== id) { resolveClaim(false); return null; } // not available, or no longer wanted
        resolveClaim(true);
        return new Promise(r => { release = r; }); // held until this tab opens another project
      }).catch(() => { if (heldId === id) { owned = false; setReadOnly(true, 'taken'); } }); // another tab took it over
      granted = await claimed;
    }
    if (heldId !== id) return; // a later claim took over from this one
    owned = granted;
    claiming = false;
    setReadOnly(!granted);
  }

  // What was last saved for a project: the newer of the database record and the localStorage copy.
  async function latestSaved(id) {
    const rec = await run('projects', 'readonly', st => done(st.get(id))).catch(() => null);
    let m = null;
    try { const x = JSON.parse(localStorage.getItem(MIRROR) || 'null'); if (x && x.id === id && !x.inDatabase && MB.isProject(x)) m = x; } catch (e) { /* ignore */ }
    if (m && (!rec || (Date.parse(m.savedAt) || 0) > rec.savedAt)) return m;
    return rec ? rec.data : m;
  }

  // Edit the project in this tab: take it over from the other one, starting from what it last saved.
  P.takeOver = async function () {
    const id = MB.state.projectId;
    claiming = true; owned = false;
    if (release) { release(); release = null; }
    heldId = id;
    let resolveClaim;
    const claimed = new Promise(r => { resolveClaim = r; });
    navigator.locks.request('gengis.project.' + id, { steal: true }, () => { resolveClaim(); return new Promise(r => { release = r; }); })
      .catch(() => { if (heldId === id) { owned = false; setReadOnly(true, 'taken'); } });
    await claimed;
    const data = await latestSaved(id);
    owned = true; claiming = false; P.readOnly = false;
    if (data) MB.loadProject(data);
    setReadOnly(false);
    P.save();
  };

  function setReadOnly(on, why) {
    const was = P.readOnly;
    P.readOnly = !!on;
    if (on) { clearTimeout(timer); setStatus('readonly'); }
    else if (was || P.status === 'readonly') setStatus(pending ? 'saving' : 'saved');
    banner(on, why);
    if (!on && pending && P.ready) P.schedule();
  }

  function banner(on, why) {
    let el = document.getElementById('mb-readonly');
    if (!on) { if (el) el.remove(); return; }
    if (!el) {
      el = document.createElement('div');
      el.id = 'mb-readonly';
      el.setAttribute('role', 'alert');
      document.body.appendChild(el);
    }
    el.innerHTML = `<span>${why === 'taken' ? 'This map is now being edited in another tab or window.' : 'This map is open in another tab or window.'} Changes made here are not saved.</span>
      <button type="button" class="btn small primary" data-act="here">Edit here</button><button type="button" class="btn small" data-act="new">New map</button>`;
    el.querySelector('[data-act="here"]').addEventListener('click', () => P.takeOver());
    el.querySelector('[data-act="new"]').addEventListener('click', () => { MB.newProject(); MB.toast('New map'); });
  }

  /* ---------- the Recent projects dialog ---------- */
  const when = ts => {
    const m = Math.round((Date.now() - ts) / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return m + ' min ago';
    const h = Math.round(m / 60);
    if (h < 24) return h + ' h ago';
    return new Date(ts).toLocaleDateString();
  };
  const objects = n => n + ' object' + (n === 1 ? '' : 's');

  P.openDialog = async function () {
    let dlg = document.getElementById('recentDialog');
    if (!dlg) {
      dlg = document.createElement('div');
      dlg.id = 'recentDialog';
      dlg.className = 'modal';
      dlg.innerHTML = '<div class="modal-box recent-box" role="dialog" aria-modal="true" aria-labelledby="recentTitle"></div>';
      dlg.addEventListener('click', e => { if (e.target === dlg) dlg.classList.add('hidden'); });
      document.addEventListener('keydown', e => { if (e.key === 'Escape') dlg.classList.add('hidden'); });
      document.body.appendChild(dlg);
    }
    dlg.classList.remove('hidden');
    await P.flush();
    const cur = MB.state.projectId;
    const [list, snaps] = await Promise.all([P.list(), P.snapshots(cur)]);
    const box = dlg.querySelector('.modal-box');
    const reason = r => ({ 'before opening a file': 'before a file replaced it', 'before restoring an earlier copy': 'before a restore' })[r] || '';
    box.innerHTML = `<h2 id="recentTitle">Recent projects</h2>
      <p class="dim">Saved automatically on this device as you work.</p>
      <div class="recent-list">${list.length ? list.map(r => `<div class="recent-item${r.id === cur ? ' current' : ''}">
          <div class="recent-main"><b>${esc(r.name)}</b><span class="dim">${esc(when(r.savedAt))} · ${objects(r.objects)}</span></div>
          ${r.id === cur ? '<span class="badge">open</span>' : `<button class="btn small" data-open="${esc(r.id)}">Open</button><button class="icon-btn mini danger" data-del="${esc(r.id)}" title="Delete from this device" aria-label="Delete ${esc(r.name)} from this device"><svg viewBox="0 0 24 24" width="14" height="14"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg></button>`}
        </div>`).join('') : '<p class="note">Nothing saved yet.</p>'}</div>
      <h3>Earlier copies of “${esc(MB.state.projectName)}”</h3>
      <div class="recent-list">${snaps.length ? snaps.map(s => `<div class="recent-item">
          <div class="recent-main"><span>${esc(new Date(s.savedAt).toLocaleString())}</span><span class="dim">${objects(s.objects)}${reason(s.reason) ? ' · ' + reason(s.reason) : ''}</span></div>
          <button class="btn small" data-restore="${esc(s.key)}"${P.readOnly ? ' disabled' : ''}>Restore</button>
        </div>`).join('') : '<p class="note">A copy is kept every 10 minutes while you edit (the last 10), and before a file or a restore replaces the project.</p>'}</div>
      <div class="row right"><button class="btn" data-close>Close</button></div>`;
    box.querySelector('[data-close]').addEventListener('click', () => dlg.classList.add('hidden'));
    box.querySelectorAll('[data-open]').forEach(b => b.addEventListener('click', async () => { dlg.classList.add('hidden'); await P.open(b.dataset.open); }));
    box.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', async () => {
      const r = list.find(x => x.id === b.dataset.del);
      if (!confirm(`Delete "${r ? r.name : 'this project'}" and its earlier copies from this device?`)) return;
      await P.remove(b.dataset.del);
      P.openDialog();
    }));
    box.querySelectorAll('[data-restore]').forEach(b => b.addEventListener('click', async () => {
      if (!confirm('Replace the open project with this earlier copy? What is open now is kept as a copy too.')) return;
      dlg.classList.add('hidden');
      await P.restore(b.dataset.restore);
    }));
  };
})(window.MB);
