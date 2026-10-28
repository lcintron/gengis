/* GenGIS - project files on the computer (desktop app only).
 *
 * In the desktop app every named project is also kept as a real file: Documents/GenGIS/<name>.gengis.json unless
 * the user picks another folder (Settings -> Project), or the file it was opened from or saved as. The file is
 * written a couple of seconds after each background save and once more when the window closes. Untitled drafts get
 * no file until they are named or saved, so files do not pile up either. All paths are decided and checked by the
 * desktop app (electron/files.js); the page only asks. In a browser this module does nothing. */
window.MB = window.MB || {};
(function (MB) {
  'use strict';

  const D = window.gengisDesktop;
  const F = MB.desktopFiles = { available: !!D, folder: null, isDefault: true, file: null, error: '' };
  if (!D) return;

  const DELAY = 2000;
  let timer = null, failed = false, lastText = null, lastId = null; // what the file holds (to skip writes that change nothing)
  const P = () => MB.projects;
  const isDraft = () => /^\s*untitled( map)?\s*$/i.test(MB.state.projectName || '') && !P().fileBacked;
  const emit = () => MB.emit('desktopfiles', F);
  // The desktop app's own words for a failure, without Electron's wrapping ("Error invoking remote method …").
  const why = e => String((e && e.message) || e).replace(/^Error invoking remote method '[^']*': (\w*Error: )?/, '');

  F.schedule = function () { clearTimeout(timer); timer = setTimeout(() => F.write(), DELAY); };
  // Before another project replaces the open one: its file gets the last changes first.
  F.writePending = () => (timer ? F.write() : Promise.resolve(null));

  // Write the open project to its file now. Resolves the file, or null when there is nothing to write.
  // The project as it would be written, and whether that is what its file already holds.
  function current() {
    const p = MB.serializeProject(), stamp = p.savedAt;
    delete p.savedAt;
    const text = JSON.stringify(p);
    p.savedAt = stamp;
    return { p, text, unchanged: p.id === lastId && text === lastText };
  }

  F.write = async function () {
    clearTimeout(timer);
    timer = null;
    if (P().readOnly || isDraft()) return null;
    const { p, text, unchanged } = current();
    if (unchanged && F.file) return F.file;
    try {
      const r = await D.write(p.id, p.name, JSON.stringify(p, null, 1));
      lastId = p.id; lastText = text;
      if (MB.state.projectId === p.id) { F.file = r.file; P().markFileBacked(); }
      F.error = ''; failed = false;
      emit();
      return r.file;
    } catch (e) {
      F.error = why(e);
      if (!failed) MB.toast('Could not save the project file (' + F.error + '). It is still saved in the app.', 6000);
      failed = true;
      emit();
      return null;
    }
  };

  // Project -> Save project: write it now (an untitled draft is named first, through Save as).
  F.save = async function () {
    if (isDraft()) return F.saveAs();
    await P().flush();
    const file = await F.write();
    if (file) MB.toast('Saved to ' + file, 3500);
  };

  F.saveAs = async function () {
    await P().flush();
    const p = MB.serializeProject();
    try {
      const r = await D.saveAs(p.id, p.name, JSON.stringify(p, null, 1));
      if (!r) return;
      F.file = r.file; F.error = '';
      P().markFileBacked();
      emit();
      MB.toast('Saved to ' + r.file, 3500);
    } catch (e) { MB.toast('Could not save: ' + why(e), 5000); }
  };

  // Opening a file: the open project is saved first (database and file), then the file is read, so reopening the
  // project's own file shows its latest version. The file becomes this project's only once it has opened, under
  // the id it ended up with (an older file gets a new one).
  async function openFrom(read) {
    try {
      if (!(await P().confirmReplace('Open the file'))) return;
      const r = await read();
      if (!r) return;
      if ((await MB.openText(r.text, r.name)) !== 'project') return;
      await D.adopt(MB.state.projectId, r.file);
      F.file = r.file;
      emit();
    } catch (e) { MB.toast('Could not open the file: ' + why(e), 5000); }
  }
  F.open = () => openFrom(() => D.open());
  F.openRecent = file => openFrom(() => D.read(file));

  // A project file the system handed over (double-clicked, "Open with": opened at once), or that a gengis:// link
  // named (asked first: any web page can open a link).
  F.openPath = async function (file, fromLink) {
    const name = String(file).split(/[\\/]/).pop();
    if (fromLink && !(await MB.ask('A link asks GenGIS to open the project "' + name + '":\n\n' + file, 'Open', 'Cancel'))) return;
    return openFrom(() => D.openPath(file));
  };

  // A project on the web, from a gengis:// link (asked first). It opens as a project of its own here, tied to no file
  // (Save as keeps it on this computer).
  F.openUrl = async function (url) {
    let host = url;
    try { host = new URL(url).host; } catch (e) { /* shown whole */ }
    if (!(await MB.ask('A link asks GenGIS to open a project from ' + host + ':\n\n' + url, 'Open', 'Cancel'))) return;
    try {
      if (!(await P().confirmReplace('Open the project'))) return;
      MB.toast('Opening the project from ' + host + '…', 3000);
      const r = await D.fetchUrl(url);
      await MB.openText(r.text, r.name);
    } catch (e) { MB.toast('Could not open the project from ' + host + ': ' + why(e), 6000); }
  };

  F.recent = () => D.recent().catch(() => []);
  F.reveal = file => D.reveal(file || F.file || null);

  F.chooseFolder = async function () {
    const r = await D.chooseFolder();
    if (!r) return;
    F.folder = r.folder; F.isDefault = r.isDefault;
    emit();
    MB.toast('New projects are saved in ' + r.folder, 3500);
  };

  async function refresh() {
    const f = await D.folder().catch(() => null);
    if (f) { F.folder = f.folder; F.isDefault = f.isDefault; }
    F.file = await D.fileOf(MB.state.projectId).catch(() => null);
    emit();
  }

  MB.on('saved', () => F.schedule());   // after each background save
  MB.on('project', () => { clearTimeout(timer); timer = null; refresh(); });
  D.onFlush(async () => { await P().flush(); await F.write(); }); // the window is closing
  // The page is unloading however it happens (window closed, reloaded, the app quitting): the last changes go to
  // the file synchronously, since nothing asynchronous is waited for any more.
  window.addEventListener('pagehide', () => {
    if (P().readOnly || isDraft()) return;
    const { p, unchanged } = current();
    if (unchanged) return;
    try { D.writeSync(p.id, p.name, JSON.stringify(p, null, 1)); } catch (e) { /* the database copy remains */ }
  });
  refresh();
})(window.MB);
