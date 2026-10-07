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
  const RW = { mode: 'readwrite' };
  const TYPES = [{ description: 'GenGIS project', accept: { 'application/json': ['.json'] } }];
  let entry = null;          // { id, handle, name, lastWritten } of the open project
  let timer = null, lastText = null, lastId = null, failed = false;
  let gen = 0;               // bumped when the open project's link changes: an older lookup then gives way
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

  async function allowed(ask) {
    if (!entry) return false;
    let s = await entry.handle.queryPermission(RW);
    if (s !== 'granted' && ask) s = await entry.handle.requestPermission(RW);
    return s === 'granted';
  }

  // Write the open project to its file. force: overwrite even if the file changed elsewhere. Writes run one at a
  // time; `writing` is the last one (for whoever must wait until the file holds the latest).
  let writing = Promise.resolve(false);
  function writeNow(force) {
    clearTimeout(timer); timer = null;
    const run = writing.then(() => write(force));
    writing = run.catch(() => false);
    return run;
  }
  async function write(force) {
    if (!entry || P().readOnly || isDraft()) return false;
    if (!(await allowed(false))) { if (F.state !== 'conflict') show('paused'); return false; }
    const { p, text, unchanged } = current();
    if (unchanged && !force) return true;
    const e = entry;
    try {
      const before = await e.handle.getFile();
      if (!force && e.lastWritten && before.lastModified > e.lastWritten + 1000) {
        if (F.state !== 'conflict') MB.toast('"' + e.name + '" was changed outside GenGIS, so it is no longer saved automatically. Use the button beside "Saved" to choose.', 7000);
        show('conflict');
        return false;
      }
      const w = await e.handle.createWritable(); // written beside the file, swapped in on close
      await w.write(JSON.stringify(p, null, 1));
      await w.close();
      e.lastWritten = (await e.handle.getFile()).lastModified;
      await putEntry(e);
      if (entry === e) { lastId = p.id; lastText = text; failed = false; show('saving'); }
      return true;
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      if (!failed) MB.toast('Could not save to "' + e.name + '" (' + msg + '). The project is still saved in this browser.', 6000);
      failed = true;
      show(F.state === 'saving' ? 'saving' : F.state, msg);
      return false;
    }
  }
  F.schedule = function () { if (!entry) return; clearTimeout(timer); timer = setTimeout(() => writeNow(false), DELAY); };
  // Before another project replaces the open one: its file gets the last changes first.
  F.writePending = () => (timer ? writeNow(false) : writing); // a timer still to fire, or a write under way

  // Does the file hold the open project as it is now (whatever its formatting and save time)?
  async function holdsCurrent(handle) {
    try {
      const p = JSON.parse(await (await handle.getFile()).text());
      delete p.savedAt;
      return JSON.stringify(p) === current().text;
    } catch (e) { return false; }
  }

  // Link the open project to a file handle (after Save as or Open).
  async function adopt(handle) {
    gen++;
    entry = { id: MB.state.projectId, handle, name: handle.name, lastWritten: 0 };
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
      if (!(await P().confirmReplace('Open the file'))) return;
      // the open project's own file, without its latest changes (writing them failed or is paused): opening it would
      // go back to what the file holds
      if (entry && (await entry.handle.isSameEntry(handle).catch(() => false)) && !(await holdsCurrent(handle)) &&
          !(await MB.ask('The latest changes to "' + entry.name + '" are not in the file yet, so opening it shows the file without them. Open it anyway?', 'Open the file', 'Cancel'))) return;
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
    entry = null; F.name = null;
    show('none');
    MB.toast('No longer saving to "' + name + '"', 3000);
  };

  // The button beside the save status: allow writing again, or settle a file changed elsewhere.
  F.resume = async function () {
    if (!entry) return;
    if (F.state === 'conflict') return F.resolve();
    if (!(await allowed(true))) { show('denied'); return; }
    show('saving');
    await P().flush();
    await writeNow(false);
  };
  F.resolve = async function () {
    const keep = await MB.ask('"' + entry.name + '" was changed outside GenGIS since it was last saved here. Replace it with the map open here, or stop saving to it (the file stays as it is)?', 'Replace the file', 'Stop saving to it');
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
