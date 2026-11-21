/* GenGIS - project files on the computer from the browser (Chrome and Edge on desktop: the File System Access API).
 *
 * Opt-in: Project -> Save project / Save as… pick a file with the system's dialog, and Open project picks one to
 * open; from then on that project is also kept in its file, written a couple of seconds after each background save
 * (the browser's own copy, Recent projects, stays the main one). The file handles are kept in this browser's
 * IndexedDB, so the link survives a reload. The browser asks again for leave to write once per visit: until then a
 * "Resume saving to file" button sits beside the save status. A file changed by something else since GenGIS last
 * wrote it is never overwritten without asking. Elsewhere (other browsers, phones, the desktop app, which has its own
 * files: desktopfiles.js) this module does nothing. */
window.MB = window.MB || {};
(function (MB) {
  'use strict';

  const available = !window.gengisDesktop && typeof window.showSaveFilePicker === 'function' && typeof window.showOpenFilePicker === 'function';
  // state: 'none' (no file), 'saving' (granted, autosaving), 'paused' (needs a click to allow writing),
  // 'conflict' (the file changed elsewhere), 'denied' (writing was refused)
  const F = MB.browserFiles = { available, name: null, state: 'none', error: '' };
  if (!available) return;

  const DELAY = 2000;
  const WRITE_TIMEOUT = 8000; // ms: a file operation that takes longer has stalled (a file in a cloud-synced folder can)
  const RW = { mode: 'readwrite' };
  const TYPES = [{ description: 'GenGIS project', accept: { 'application/json': ['.gengis', '.json'] } }]; // (.json: older .gengis.json files)
  let entry = null;          // { id, handle, name, lastWritten } of the open project
  let timer = null, lastText = null, lastId = null, failed = false;
  let gen = 0;               // bumped when the open project's link changes: an older lookup then gives way
  // How many times each project was linked to a file or unlinked from one in this page (not: opened). A write under
  // way knows by it whether its project's link is still the one it began with, whatever happened to other projects'.
  const links = new Map();   // project id -> count (a Map: an id may be any text, "__proto__" too)
  const linkCount = id => links.get(id) || 0;
  const relinked = id => { links.set(id, linkCount(id) + 1); };
  const P = () => MB.projects;
  const isDraft = () => /^\s*untitled( map)?\s*$/i.test(MB.state.projectName || '') && !P().fileBacked;
  const emit = () => MB.emit('browserfiles', F);

  /* ---------- the handles, by project id ---------- */
  let dbp = null;
  function db() {
    if (!dbp) dbp = new Promise((res, rej) => {
      const r = indexedDB.open('gengis-files', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('handles', { keyPath: 'id' });
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    return dbp;
  }
  async function run(mode, fn) {
    const d = await db();
    return new Promise((res, rej) => {
      const tx = d.transaction('handles', mode), req = fn(tx.objectStore('handles'));
      tx.oncomplete = () => res(req && req.result);
      tx.onerror = tx.onabort = () => rej(tx.error);
    });
  }
  const getEntry = id => run('readonly', s => s.get(id)).catch(() => null);
  const putEntry = e => run('readwrite', s => s.put(e)).catch(() => null);
  const delEntry = id => run('readwrite', s => s.delete(id)).catch(() => null);
  F.recent = () => run('readonly', s => s.getAll()).then(all => (all || []).sort((a, b) => (b.lastWritten || 0) - (a.lastWritten || 0))).catch(() => []);

  /* ---------- writing ---------- */

  // The project as it would be written, and whether that is what the file already holds.
  function current() {
    const p = MB.serializeProject(), stamp = p.savedAt;
    delete p.savedAt;
    const text = JSON.stringify(p);
    p.savedAt = stamp;
    return { p, text, unchanged: p.id === lastId && text === lastText };
  }
  function show(state, error) { F.state = state; F.error = error || ''; emit(); }

  // The promise, or a rejection once it has taken longer than ms: the browser's file calls have no time limit of
  // their own, and one that never answers must not hold up everything queued behind it.
  function withTimeout(promise, ms, label) {
    let t;
    return Promise.race([promise, new Promise((res, rej) => { t = setTimeout(() => rej(new Error((label || 'file operation') + ' timed out')), ms); })])
      .finally(() => clearTimeout(t));
  }

  // May the file be written? The question is bounded (no answer, or a failure: not allowed); asking the user for
  // leave is not, it waits for them.
  async function allowed(ask) {
    const e = entry;
    if (!e) return false;
    let s = await withTimeout(e.handle.queryPermission(RW), WRITE_TIMEOUT, 'checking the file').catch(() => 'prompt');
    if (s !== 'granted' && ask) s = await e.handle.requestPermission(RW);
    return s === 'granted';
  }

  // Write the open project to its file. force: overwrite even if the file changed elsewhere. Writes run one at a
  // time; `writing` is the last one (for whoever must wait until the file holds the latest). Every wait in write()
  // is bounded, so `writing` always settles: a stalled file never blocks the writes (or the project switch) after it.
  let writing = Promise.resolve(false);
  function writeNow(force) {
    clearTimeout(timer); timer = null;
    const run = writing.then(() => write(force));
    writing = run.catch(() => false);
    return run;
  }
  async function write(force) {
    if (!entry || P().readOnly || isDraft()) return false;
    const e = entry;
    // The file is e's project's and takes nothing else. Another project may open while this waits (a switch does not
    // wait forever for a stalled file), and the link follows it only a moment later (refresh reads the database):
    // so it is the open project's id that is checked, before it is serialized and on what was serialized.
    const mine = () => entry === e && MB.state.projectId === e.id;
    // Once the write is under way, what it finds out is for the open project when that is still e's project with
    // the same file. Not "entry === e": an undo or a redo opens the project again, and the link is then read from
    // the database again, a copy of it. open(): that link as it is now, or null (another project, another file).
    const linked = linkCount(e.id), same = () => linkCount(e.id) === linked; // (its own project's link, no other's)
    const open = () => (entry && entry.id === e.id && same() ? entry : null);
    // The file was written, last modified as e says: noted in the database on the project's link as it is NOW, never
    // by putting e back. Since this write began the project may have been saved as another file, or unlinked from
    // this one: e is then no longer its link, and stored again it would silently bring the old file back at the
    // next undo or reload. (Another project open, and this one's link not changed meanwhile: e is still its row, and
    // takes the time, so that this is not taken for a change made elsewhere when the project is opened again.)
    const note = () => {
      const row = open() || (same() ? e : null);
      if (!row) return null;
      row.lastWritten = e.lastWritten;
      return putEntry(row);
    };
    // The file now holds this write (text, of project p): what the open project's file holds, if it is still that.
    // late: by a close that had been given up on. The status is then only cleared of that, never of a conflict;
    // and the failure stays "said": a file that is always this slow says so once, not at every edit.
    const landed = late => {
      const now = open();
      if (!now) return;
      // (the link in memory too, as it is by now: an undo meanwhile read it again, maybe from before the time was
      // noted in the database, and the file would then look changed elsewhere at the next write)
      now.lastWritten = e.lastWritten;
      lastId = p.id; lastText = text;
      if (!late) failed = false;
      if (!late || F.state === 'saving') show('saving');
    };
    if (!mine()) return false;
    const ok = await allowed(false);
    if (!mine()) return false; // another project opened meanwhile: its own write follows
    if (!ok) { if (F.state !== 'conflict') show('paused'); return false; }
    const { p, text, unchanged } = current();
    if (p.id !== e.id) return false;
    if (unchanged && !force) return true;
    const bound = (promise, label) => withTimeout(promise, WRITE_TIMEOUT, label);
    let opening = null, closing = null;
    try {
      const before = await bound(e.handle.getFile(), 'reading the file');
      if (!force && e.lastWritten && before.lastModified > e.lastWritten + 1000) {
        // (said either way, it names the file; the status beside "Saved" is the open project's, and only its own
        // file's write changes it: by now another project may be open)
        if (!open() || F.state !== 'conflict') MB.toast('"' + e.name + '" was changed outside GenGIS, so it is no longer saved automatically. Use the button beside "Saved" to choose.', 7000);
        if (open()) show('conflict');
        return false;
      }
      opening = e.handle.createWritable(); // written beside the file, swapped in on close
      const w = await bound(opening, 'opening the file for writing');
      await bound(w.write(JSON.stringify(p, null, 1)), 'writing the file');
      closing = w.close();
      await bound(closing, 'saving the file');
      e.lastWritten = (await bound(e.handle.getFile(), 'reading the file')).lastModified;
      await bound(note(), 'noting the save');
      landed();
      return true;
    } catch (err) {
      // nothing half-written is left beside the file: the copy being written is dropped (one that only opens after
      // the wait gave up, too). A close still under way may yet complete: the file is then GenGIS's own writing,
      // not a change made elsewhere, and what it holds is this write: noted as such, like a write that answered in
      // time (a close that is only slow is a save, and nothing is written again for it). It may also have landed
      // over a later write: the write scheduled here finds the project as it is now differs, and writes it again.
      if (closing) closing.then(async () => {
        e.lastWritten = (await e.handle.getFile()).lastModified;
        await note();
        if (!open()) return;
        landed(true);
        F.schedule();
      }).catch(() => {});
      else if (opening) opening.then(x => x && x.abort && x.abort()).catch(() => {});
      const msg = err && err.message ? err.message : String(err);
      // (the status and the "said once" are the open project's: an earlier project's write leaves them alone)
      if (!open() || !failed) MB.toast('Could not save to "' + e.name + '" (' + msg + '). The project is still saved in this browser.', 6000);
      if (open()) { failed = true; show(F.state === 'saving' ? 'saving' : F.state, msg); }
      return false;
    }
  }
  F.schedule = function () { if (!entry) return; clearTimeout(timer); timer = setTimeout(() => writeNow(false), DELAY); };
  // Before another project replaces the open one: its file gets the last changes first.
  F.writePending = () => (timer ? writeNow(false) : writing); // a timer still to fire, or a write under way

  // Does the file hold the open project as it is now (whatever its formatting, key order and save time)?
  const sorted = v => Array.isArray(v) ? v.map(sorted)
    : (v && typeof v === 'object' ? Object.keys(v).sort().reduce((o, k) => { o[k] = sorted(v[k]); return o; }, Object.create(null)) : v); // no prototype: a "__proto__" key stays a key
  const canon = p => { const c = sorted(p); delete c.savedAt; return JSON.stringify(c); };
  async function holdsCurrent(handle) {
    try { return canon(JSON.parse(await (await handle.getFile()).text())) === canon(current().p); } catch (e) { return false; }
  }

  // Link the open project to a file handle (after Save as or Open).
  async function adopt(handle) {
    gen++;
    entry = { id: MB.state.projectId, handle, name: handle.name, lastWritten: 0 };
    relinked(entry.id);
    F.name = handle.name;
    lastText = null; lastId = null;
    await putEntry(entry);
  }

  /* ---------- the menu ---------- */

  // Save as…: a file chosen with the system dialog becomes this project's file from now on.
  F.saveAs = async function () {
    let handle;
    try {
      handle = await window.showSaveFilePicker({ id: 'gengis-projects', suggestedName: fileName(MB.state.projectName), types: TYPES });
    } catch (e) { if (e && e.name !== 'AbortError') MB.toast('Could not save: ' + (e.message || e), 5000); return; }
    await P().flush();
    await adopt(handle);
    P().markFileBacked();
    if (await writeNow(true)) MB.toast('Saved to "' + handle.name + '". Changes are saved to it automatically.', 4000);
  };

  // Save project: write the project's file now (picking one first when it has none).
  F.save = async function () {
    if (!entry || isDraft()) return F.saveAs();
    if (!(await allowed(true))) { show('denied'); MB.toast('The browser did not allow saving to "' + entry.name + '".', 5000); return; }
    await P().flush();
    if (F.state === 'conflict') return F.resolve();
    if (await writeNow(true)) MB.toast('Saved to "' + entry.name + '"', 3000);
  };

  // Open project: the chosen file opens, and (once the browser allows writing to it) changes go back to it.
  F.open = async function (handle) {
    try {
      if (!handle) [handle] = await window.showOpenFilePicker({ id: 'gengis-projects', types: TYPES.concat([{ description: 'GeoJSON', accept: { 'application/geo+json': ['.geojson'], 'application/json': ['.json'] } }]) });
    } catch (e) { if (e && e.name !== 'AbortError') MB.toast('Could not open: ' + (e.message || e), 5000); return; }
    try {
      let file = await handle.getFile();
      const text = await file.text();
      let project = false;
      try { project = MB.isProject(JSON.parse(text)); } catch (e) { /* openText reports it */ }
      // ask for leave to write while the click that chose the file still counts as one (this first read only says
      // whether it is a project)
      const canWrite = project && (await handle.requestPermission(RW).catch(() => 'denied')) === 'granted';
      if (!(await P().confirmReplace('Open the file', 'open'))) return;
      // the open project's own file, without its latest changes (writing them failed or is paused): opening it would
      // go back to what the file holds
      if (entry && (await entry.handle.isSameEntry(handle).catch(() => false)) && !(await holdsCurrent(handle)) &&
          !(await MB.ask('The latest changes to "' + entry.name + '" are not in the file yet, so opening it shows the file without them. Open it anyway?', 'Open the file', 'Cancel', { yesIcon: 'open' }))) return;
      // read it again: replacing the open project first saved it, maybe to this very file
      file = await handle.getFile();
      if ((await MB.openText(await file.text(), file.name)) !== 'project') return;
      await adopt(handle);
      file = await handle.getFile();
      entry.lastWritten = file.lastModified; // what it holds now is what was opened
      await putEntry(entry);
      lastId = MB.state.projectId; lastText = current().text; // the file holds what was just opened
      show(canWrite ? 'saving' : 'paused');
      if (canWrite) MB.toast('Changes are saved to "' + handle.name + '" automatically.', 3500);
    } catch (e) { MB.toast('Could not open the file: ' + (e.message || e), 5000); }
  };
  // Recent projects -> a file linked before. Asks for leave to edit it again; refused, it still opens if it may be
  // read (and is not saved to until allowed).
  F.openRecent = async function (id) {
    const e = await getEntry(id);
    if (!e) return;
    try {
      if ((await e.handle.requestPermission(RW)) !== 'granted' && (await e.handle.requestPermission({ mode: 'read' })) !== 'granted') {
        MB.toast('The browser did not allow opening "' + e.name + '".', 5000);
        return;
      }
    } catch (err) { /* F.open reports what fails */ }
    return F.open(e.handle);
  };

  // Stop keeping this project in its file (the file itself stays as it is).
  F.unlink = async function () {
    if (!entry) return;
    clearTimeout(timer); timer = null;
    const name = entry.name;
    await delEntry(entry.id);
    relinked(entry.id);
    entry = null; F.name = null;
    show('none');
    MB.toast('No longer saving to "' + name + '"', 3000);
  };

  // The button beside the save status: allow writing again, or settle a file changed elsewhere.
  F.resume = async function () {
    if (!entry) return;
    if (F.state === 'conflict') return F.resolve();
    if (!(await allowed(true))) {
      show('denied');
      // the browser said no (or showed nothing to say yes to): said so, and an end to asking offered
      const synced = MB.cloud && MB.cloud.ready && MB.cloud.status(MB.state.projectId);
      if (await MB.ask('The browser did not allow saving to "' + entry.name + '". This map is still saved in this browser' + (synced ? ' and in the cloud' : '') + '.\n\nStop saving it to that file? The file stays as it is.', 'Stop saving to the file', 'Keep the file', { yesIcon: 'unlink', noIcon: 'check' })) await F.unlink();
      return;
    }
    show('saving');
    await P().flush();
    await writeNow(false);
  };
  F.resolve = async function () {
    const keep = await MB.ask('"' + entry.name + '" was changed outside GenGIS since it was last saved here. Replace it with the map open here, or stop saving to it (the file stays as it is)?', 'Replace the file', 'Stop saving to it', { yesIcon: 'save', noIcon: 'unlink' });
    if (keep) { if (await allowed(true)) { await P().flush(); if (await writeNow(true)) MB.toast('Saved to "' + entry.name + '"', 3000); } }
    else await F.unlink();
  };

  function fileName(name) {
    return ((name || 'map').replace(/[\\/:*?"<>|]+/g, '_').trim() || 'map') + MB.PROJECT_EXT;
  }

  /* ---------- the open project's file ---------- */

  async function refresh() {
    clearTimeout(timer); timer = null;
    lastText = null; lastId = null; failed = false;
    const id = MB.state.projectId, g = ++gen;
    const e = await getEntry(id);
    if (g !== gen) return; // another project opened, or this one was linked to a file, meanwhile
    entry = e || null;
    F.name = e ? e.name : null;
    if (!e) { show('none'); return; }
    const ok = await allowed(false).catch(() => false);
    if (g !== gen) return;
    show(ok ? 'saving' : 'paused');
    if (ok) F.schedule(); // catch the file up with what this browser saved last time
  }

  MB.on('saved', () => F.schedule()); // after each background save
  MB.on('project', refresh);
  // A page being hidden: write now if possible (an unload cannot wait; the browser's copy remains either way).
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden' && timer) writeNow(false); });
  refresh();
})(window.MB);
