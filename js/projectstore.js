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
    archived: false,    // the open project, as it is now, is in the database (so Recent projects has it)
    fileBacked: false   // the open project was saved to a file or opened from one (so it is not a draft)
  };
  // A draft: a map still called "Untitled map" that was never saved to a file nor opened from one. Drafts do not
  // pile up in Recent projects: a new map takes the place of an earlier one (asked first when it has objects).
  const isUntitled = name => /^\s*untitled( map)?\s*$/i.test(name || '');
  const isDraft = r => isUntitled(r.name) && !r.fileBacked;
  let timer = null, pending = false, lastSnap = {}, warned = false;
  // Every change bumps the revision; a save records which revision it wrote where. "Archived" means the database
  // holds the latest revision. Saves run one at a time.
  let rev = 0, dbRev = -1, mirrorRev = -1, inflight = null;
  let heldId = null, release = null, owned = false, claiming = false, claimToken = 0, claimWait = Promise.resolve();
  let startEdits = -1; // while start-up reads the database: changes made meanwhile (-1: not counting)

  // Only the tab that holds the open project's lock writes it, and never while that is being settled.
  const canWrite = () => P.ready && !P.readOnly && owned && !claiming && MB.state.projectId === heldId;

  function setStatus(status, error) {
    P.status = status;
    P.error = error || '';
    MB.emit('savestate', P);
  }

  const summary = p => ({ id: p.id, name: p.name || 'Untitled map', objects: (p.features || []).length });

  /* ---------- saving ---------- */

  // A change happened: save it a moment later. kind 'view': the map was only panned or zoomed.
  P.schedule = function (kind) {
    if (startEdits >= 0 && kind !== 'view') startEdits++;
    rev++;
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

  // Save the open project now. Resolves true once the database holds its latest revision. The localStorage copy
  // is written before the first wait, so a call made while the page closes still leaves it there.
  P.save = async function () {
    clearTimeout(timer);
    while (inflight) await inflight; // one save at a time: a later one never races an earlier one
    if (!canWrite()) return false;
    if (dbRev === rev) { pending = false; return true; }
    const savingRev = rev, now = Date.now(), p = MB.serializeProject();
    pending = false;
    p.savedAt = new Date(now).toISOString(); // one stamp for both copies: start-up compares them exactly
    const json = JSON.stringify(p), fits = json.length <= MIRROR_MAX;
    const mirrored = fits && writeMirror(p, json);
    if (mirrored) mirrorRev = savingRev;
    const rec = Object.assign(summary(p), { savedAt: now, fileBacked: !!P.fileBacked, data: p });
    inflight = run(['projects', 'snapshots'], 'readwrite', async (projects, snaps) => {
      projects.put(rec);
      // a recovery copy now and then, the oldest ones dropped
      if (!(p.id in lastSnap)) lastSnap[p.id] = Math.max(0, ...(await snapsOf(snaps, p.id)).map(x => x.savedAt));
      if (now - lastSnap[p.id] >= SNAP_EVERY) {
        snaps.put(Object.assign(summary(p), { key: p.id + '|' + now, savedAt: now, reason: 'autosave', data: p }));
        lastSnap[p.id] = now;
        await prune(snaps, p.id);
      }
    }).then(() => null, e => e || new Error('save failed'));
    const err = await inflight;
    inflight = null;
    if (!err) {
      dbRev = savingRev;
      P.where = 'database';
      MB.emit('saved', p.id); // the desktop app keeps the project file in step
      // a large project: the database now holds it, so the note may replace an older full copy in localStorage
      if (!fits) { try { localStorage.setItem(CURRENT, p.id); localStorage.setItem(MIRROR, noteOf(p)); } catch (e) { /* ignore */ } }
    } else if (mirrored) {
      P.where = 'browser storage'; // no database: the localStorage copy is the save, but not a Recent project
      MB.emit('saved', p.id); // the desktop app's file is still kept in step
    } else {
      pending = true; // still to be saved: kept dirty, tried again
      P.archived = false;
      fail(err);
      return false;
    }
    P.savedAt = now;
    P.archived = dbRev === rev;
    setStatus(rev === savingRev ? 'saved' : 'saving');
    if (!warned) { warned = true; P.persist(false); }
    return !err && dbRev === rev;
  };

  function fail(e) {
    console.warn('Autosave failed', e);
    const first = P.status !== 'error';
    setStatus('error', e && e.message ? e.message : String(e));
    if (first) MB.toast('Autosave failed (' + P.error + '). Save your project to a file.', 6000);
  }

  // The page is being hidden or closed: save at once. A project that fits localStorage is written there before the
  // page goes; the database write is started and normally completes.
  P.saveNow = function () { if (canWrite() && dbRev !== rev && !inflight) P.save(); };

  // Before another project replaces this one: save what is pending. Resolves true when the project is safely in
  // the database (or this tab does not own it: the tab that does saves it).
  P.flush = async function () {
    // a project just opened: its lock is still being settled (bounded, so nothing can hang on it)
    for (const until = Date.now() + 5000; claiming && Date.now() < until;) await Promise.race([claimWait, new Promise(r => setTimeout(r, 50))]);
    if (!canWrite()) return P.readOnly || !P.ready;
    if (dbRev !== rev || inflight) await P.save();
    return dbRev === rev;
  };

  // Ask before replacing a project that is not in the database (it would not be in Recent projects).
  P.confirmReplace = async function (what) {
    const safe = await P.flush();
    if (MB.desktopFiles && MB.desktopFiles.available) await MB.desktopFiles.writePending(); // its file too
    if (safe) return true;
    return MB.ask('"' + MB.state.projectName + '" could not be saved in this browser\'s project storage' + (P.error ? ' (' + P.error + ')' : '') +
      ', so it will not be in Recent projects. ' + what + ' anyway?\n\nTo keep it, cancel and use Project \u2192 Save project.', what, 'Cancel');
  };

  // Which projects other tabs have open (their lock is held).
  async function openElsewhere() {
    try {
      const held = (await navigator.locks.query()).held;
      const mine = held.find(l => l.name === lockName(heldId)); // this tab's own locks are not "elsewhere"
      return new Set(held.filter(l => !mine || l.clientId !== mine.clientId).map(l => l.name));
    } catch (e) { return new Set(); }
  }
  const lockName = id => 'gengis.project.' + id;

  // A fresh map, not a draft.
  P.startFresh = function () { MB.newProject(); P.fileBacked = false; };

  // Project -> New project. A draft is not kept twice: an empty one is replaced quietly; one with objects is
  // shown, and the user is asked whether a new map should take its place.
  P.newMap = async function () {
    if (!(await P.confirmReplace('Start a new project'))) return;
    // a map this tab only shows (another tab edits it) is that tab's: leave it, and start a map of our own
    if (P.readOnly) { P.startFresh(); MB.toast('New map'); return; }
    const cur = MB.state.projectId;
    const question = 'This untitled map has not been saved or named. Start a new map in its place?';
    if (isUntitled(MB.state.projectName) && !P.fileBacked) {
      if (!Object.keys(MB.featureLayers).length) { MB.toast('This map is already new.'); return; }
      if (!(await MB.ask(question, 'Start new', 'Keep it'))) return;
      P.startFresh();
      await P.remove(cur);
      MB.toast('New map');
      return;
    }
    // an earlier draft, not open in another tab
    const busy = await openElsewhere();
    const drafts = (await P.list()).filter(r => r.id !== cur && isDraft(r) && !busy.has(lockName(r.id)));
    for (const r of drafts.filter(x => !x.objects)) await P.remove(r.id);
    const kept = drafts.find(x => x.objects);
    if (kept) {
      await P.open(kept.id); // show it first
      if (MB.state.projectId !== kept.id) return;
      if (!(await MB.ask(question, 'Start new', 'Keep it'))) return;
      P.startFresh();
      await P.remove(kept.id);
      MB.toast('New map');
      return;
    }
    P.startFresh();
    MB.toast('New project. The previous one is in Recent projects.', 3500);
  };

  // The open project was saved to a file (or opened from one): it is no longer a draft.
  P.markFileBacked = function () { if (!P.fileBacked) { P.fileBacked = true; P.schedule(); } };

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
    // Changes made while the database is being read are the user's latest (objects, names, units, options...):
    // they are kept, not replaced. Counting starts once start-up's own synchronous work is over (data overlays
    // switching on are not edits); panning and zooming are not edits either.
    setTimeout(() => { if (!P.ready) startEdits = 0; }, 0);
    try {
      const want = MB.storedItem(CURRENT) || MB.state.projectId;
      let rec = want ? await run('projects', 'readonly', st => done(st.get(want))) : null;
      if (!rec && !mirrorOpened) { const last = (await P.list())[0]; if (last) rec = await run('projects', 'readonly', st => done(st.get(last.id))); } // no pointer: the most recent
      // the database copy when localStorage held none (a large project) or an older one
      const edited = startEdits > 0;
      startEdits = -1;
      if (rec && (!mirrorOpened || rec.savedAt > mirrorAt) && !edited) MB.loadProject(rec.data);
      if (rec && rec.id === MB.state.projectId) P.fileBacked = !!rec.fileBacked;
    } catch (e) { /* no database: the localStorage copy stands */ }
    startEdits = -1;
    P.ready = true;
    MB.on('project', () => { if (MB.state.projectId !== heldId) claim(MB.state.projectId); });
    await claim(MB.state.projectId);
    if (canWrite()) P.save();
    // Closing with changes the database does not hold yet: a project that fits is written to localStorage at once;
    // otherwise (too large, or a save still running) the browser is asked to hold the page while it completes.
    window.addEventListener('beforeunload', e => {
      if (!canWrite() || dbRev === rev) return;
      if (!inflight) P.save();
      if (mirrorRev === rev) return;
      e.preventDefault();
      e.returnValue = '';
    });
  }

  /* ---------- recent projects and recovery copies ---------- */

  P.list = () => run('projects', 'readonly', s => done(s.getAll())).then(all => all.map(r => ({ id: r.id, name: r.name, objects: r.objects, savedAt: r.savedAt, fileBacked: !!r.fileBacked })).sort((a, b) => b.savedAt - a.savedAt)).catch(() => []);
  P.snapshots = id => run('snapshots', 'readonly', s => snapsOf(s, id)).then(all => all.map(s => ({ key: s.key, name: s.name, objects: s.objects, savedAt: s.savedAt, reason: s.reason })).sort((a, b) => b.savedAt - a.savedAt)).catch(() => []);

  // A recovery copy of what is saved for a project, before something replaces it.
  // Resolves true when kept, null when nothing is saved for that project, false when the copy could not be made.
  function keepCopy(id, reason) {
    const now = Date.now();
    return run(['projects', 'snapshots'], 'readwrite', async (projects, snaps) => {
      const rec = await done(projects.get(id));
      if (!rec) return null;
      snaps.put(Object.assign(summary(rec.data), { key: id + '|' + now, savedAt: now, reason, data: rec.data }));
      await prune(snaps, id);
      return true;
    }).catch(() => false);
  }

  // A project file is being opened: if it is a project saved here, what is saved here is kept as a recovery copy.
  // Resolves false when the user would rather not replace the open project.
  P.beforeOpen = async function (p) {
    if (!(await P.confirmReplace('Open the file'))) return false;
    if (p && p.id && (await keepCopy(p.id, 'before opening a file')) === false &&
      !(await MB.ask('The copy of this project saved here could not be kept before the file replaces it. Open the file anyway?', 'Open the file', 'Cancel'))) return false;
    return true;
  };

  P.open = async function (id) {
    if (!(await P.confirmReplace('Open the other project'))) return;
    const rec = await run('projects', 'readonly', s => done(s.get(id)));
    if (!rec) { MB.toast('That project is no longer saved here.'); return; }
    MB.loadProject(rec.data);
    P.fileBacked = !!rec.fileBacked;
  };

  P.restore = async function (key) {
    const snap = await run('snapshots', 'readonly', s => done(s.get(key)));
    if (!snap) return;
    // the open project must be safely kept before an earlier copy replaces it
    if (!(await P.confirmReplace('Restore the earlier copy'))) return;
    if ((await keepCopy(snap.id, 'before restoring an earlier copy')) !== true &&
      !(await MB.ask('What is open now could not be kept as a copy. Restore the earlier copy anyway?', 'Restore', 'Cancel'))) return;
    const own = await run('projects', 'readonly', st => done(st.get(snap.id))).catch(() => null);
    MB.loadProject(snap.data);
    P.fileBacked = !!(own && own.fileBacked); // the restored project's, not the one being left
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
  function claim(id) {
    claimWait = claimNow(id);
    return claimWait;
  }
  async function claimNow(id) {
    const token = ++claimToken;
    claiming = true; owned = false; clearTimeout(timer);
    if (release) { release(); release = null; }
    heldId = id;
    let granted = true;
    if (id && navigator.locks) {
      let resolveClaim;
      const claimed = new Promise(r => { resolveClaim = r; });
      navigator.locks.request('gengis.project.' + id, { ifAvailable: true }, lock => {
        if (!lock || token !== claimToken) { resolveClaim(false); return null; } // not available, or no longer wanted
        resolveClaim(true);
        return new Promise(r => { release = r; }); // held until this tab opens another project
      }).catch(() => { if (heldId === id) { owned = false; setReadOnly(true, 'taken'); } }); // another tab took it over
      granted = await claimed;
    }
    if (token !== claimToken) return; // a later claim took over from this one
    owned = granted;
    claiming = false;
    setReadOnly(!granted);
  }

  // What was last saved for a project: the newer of the database record and the localStorage copy.
  // Resolves { data, fileBacked } (the record's flag either way).
  async function latestSaved(id) {
    const rec = await run('projects', 'readonly', st => done(st.get(id))).catch(() => null);
    let m = null;
    try { const x = JSON.parse(localStorage.getItem(MIRROR) || 'null'); if (x && x.id === id && !x.inDatabase && MB.isProject(x)) m = x; } catch (e) { /* ignore */ }
    const fileBacked = !!(rec && rec.fileBacked);
    if (m && (!rec || (Date.parse(m.savedAt) || 0) > rec.savedAt)) return { data: m, fileBacked };
    return { data: rec ? rec.data : m, fileBacked };
  }

  // Edit the project in this tab: take it over from the other one, starting from what it last saved.
  P.takeOver = function () {
    claimWait = takeOverNow();
    return claimWait;
  };
  async function takeOverNow() {
    const id = MB.state.projectId, token = ++claimToken;
    claiming = true; owned = false;
    if (release) { release(); release = null; }
    heldId = id;
    let resolveClaim, lost = false;
    const claimed = new Promise(r => { resolveClaim = r; });
    navigator.locks.request('gengis.project.' + id, { steal: true }, () => {
      resolveClaim();
      if (token !== claimToken) return null; // another project was opened meanwhile: let this lock go at once
      return new Promise(r => { release = r; });
    })
      .catch(() => { lost = true; if (heldId === id) { owned = false; setReadOnly(true, 'taken'); } });
    await claimed;
    const saved = await latestSaved(id); // the last wait: ownership is checked after it, and nothing waits after that
    if (token !== claimToken) return; // another claim started while reading: it decides
    if (lost) { claiming = false; return; } // taken back while reading: read-only, as the steal left it
    owned = true; claiming = false; P.readOnly = false;
    if (saved.data) MB.loadProject(saved.data);
    P.fileBacked = saved.fileBacked;
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
    el.querySelector('[data-act="new"]').addEventListener('click', () => P.newMap());
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
      dlg.innerHTML = '<div class="modal-box recent-box" role="dialog" aria-modal="true" aria-labelledby="recentTitle">' + MB.modalCloseHtml + '</div>';
      dlg.addEventListener('click', e => { if (e.target === dlg || e.target.closest('[data-act="close"]')) dlg.classList.add('hidden'); });
      document.addEventListener('keydown', e => { if (e.key === 'Escape') dlg.classList.add('hidden'); });
      document.body.appendChild(dlg);
    }
    dlg.classList.remove('hidden');
    await P.flush();
    const cur = MB.state.projectId;
    const DF = MB.desktopFiles || {};
    const [list, snaps, files] = await Promise.all([P.list(), P.snapshots(cur), DF.available ? DF.recent() : []]);
    const box = dlg.querySelector('.modal-box');
    const reason = r => ({ 'before opening a file': 'before a file replaced it', 'before restoring an earlier copy': 'before a restore' })[r] || '';
    box.innerHTML = `${MB.modalCloseHtml}<h2 id="recentTitle">Recent projects</h2>
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
      ${DF.available ? `<h3>Files on this computer</h3>
      <div class="recent-list">${files.length ? files.map(f => `<div class="recent-item">
          <div class="recent-main"><b>${esc(f.name)}</b><span class="dim" title="${esc(f.file)}">${esc(f.folder)} · ${esc(when(f.modified))}</span></div>
          <button class="btn small" data-file="${esc(f.file)}">Open</button>
        </div>`).join('') : '<p class="note">Project files you open or save appear here.</p>'}</div>` : ''}`;
    box.querySelectorAll('[data-file]').forEach(b => b.addEventListener('click', async () => { dlg.classList.add('hidden'); await DF.openRecent(b.dataset.file); }));
    box.querySelectorAll('[data-open]').forEach(b => b.addEventListener('click', async () => { dlg.classList.add('hidden'); await P.open(b.dataset.open); }));
    // Confirm inside the row: some embedded browsers (and in-app previews) suppress confirm() and read it as Cancel,
    // which made these buttons look dead.
    const ask = (btn, question, yes, act) => {
      const row = btn.closest('.recent-item');
      const actions = Array.from(row.children).filter(el => !el.classList.contains('recent-main'));
      actions.forEach(el => { el.style.display = 'none'; });
      const q = document.createElement('div');
      q.className = 'recent-ask';
      q.innerHTML = `<span>${esc(question)}</span><button class="btn small danger" data-yes>${esc(yes)}</button><button class="btn small" data-no>Cancel</button>`;
      row.appendChild(q);
      q.querySelector('[data-no]').addEventListener('click', () => { q.remove(); actions.forEach(el => { el.style.display = ''; }); btn.focus(); });
      q.querySelector('[data-yes]').addEventListener('click', act);
      q.querySelector('[data-yes]').focus();
    };
    box.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', () => ask(b, 'Delete it and its earlier copies?', 'Delete', async () => {
      await P.remove(b.dataset.del);
      P.openDialog();
    })));
    box.querySelectorAll('[data-restore]').forEach(b => b.addEventListener('click', () => ask(b, 'Replace the open project with this copy?', 'Restore', async () => {
      dlg.classList.add('hidden');
      await P.restore(b.dataset.restore);
    })));
  };
})(window.MB);
