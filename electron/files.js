/* GenGIS desktop app - project files on disk (main process).
 *
 * The page saves projects in its own database (IndexedDB); the desktop app also keeps each named project as a real
 * file: <projects folder>/<name>.gengis.json by default, or the file it was opened from or saved as. The folder is
 * Documents/GenGIS unless the user picks another one; the choice and which file belongs to which project are kept in
 * desktop-files.json in the app's user-data folder.
 *
 * The page reaches the disk only through the handlers below, and only from the app's own page (not from anything
 * the window might have been navigated to). Every path is decided or checked here, by its real location (symbolic
 * links resolved): a project file is written inside the projects folder, or to a file the user picked in a dialog
 * (Save as, Open) or that a project already had. Writes go to a temporary file that then replaces the real one, so
 * a crash never leaves half a project. */
const { app, dialog, ipcMain, shell, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const EXT = '.gengis.json';
const RECENT_MAX = 12;
const APP_PAGE = pathToFileURL(path.join(__dirname, '..', 'index.html')).href;
let state = null; // { folder, projects: { id: file }, approved: [real path], recent: [file] }

const stateFile = () => path.join(app.getPath('userData'), 'desktop-files.json');
const defaultFolder = () => path.join(app.getPath('documents'), 'GenGIS');

function load() {
  if (state) return state;
  let s = null;
  try { s = JSON.parse(fs.readFileSync(stateFile(), 'utf8')); } catch (e) { /* none yet, or unreadable */ }
  state = s && typeof s === 'object' && !Array.isArray(s) ? s : {};
  state.folder = typeof state.folder === 'string' && state.folder ? state.folder : defaultFolder();
  state.projects = state.projects && typeof state.projects === 'object' && !Array.isArray(state.projects) ? state.projects : {};
  state.approved = Array.isArray(state.approved) ? state.approved.filter(f => typeof f === 'string') : [];
  state.recent = Array.isArray(state.recent) ? state.recent.filter(f => typeof f === 'string') : [];
  return state;
}
function persist() {
  try { writeAtomic(stateFile(), JSON.stringify(state, null, 1)); } catch (e) { console.warn('desktop-files.json not saved', e); }
}

// Write a file so that it is either the old one or the new one, never half of either.
function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + process.pid + '.' + Date.now().toString(36) + '.tmp';
  fs.writeFileSync(tmp, text, 'utf8');
  try { fs.renameSync(tmp, file); } catch (e) { try { fs.unlinkSync(tmp); } catch (x) { /* ignore */ } throw e; }
}

/* ----- where a path really is ----- */
// The real location of a path: symbolic links resolved, through its nearest existing ancestor for a path that does
// not exist (yet), so a link anywhere above it counts. Never throws.
function real(file) {
  let abs = path.resolve(file);
  const rest = [];
  for (;;) {
    try { return path.join(fs.realpathSync.native(abs), ...rest); } catch (e) { /* not there: one level up */ }
    const up = path.dirname(abs);
    if (up === abs) return path.join(abs, ...rest);
    rest.unshift(path.basename(abs));
    abs = up;
  }
}
// Windows file names ignore case; elsewhere two names that differ in case are two files.
const same = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
// Checks have no side effects and never throw: a projects folder that is missing or unreachable only means no
// file is inside it.
function insideFolder(realFile) {
  const rel = path.relative(real(load().folder), realFile);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}
const isApproved = realFile => load().approved.some(f => same(f, realFile));
const isLink = file => { try { return fs.lstatSync(file).isSymbolicLink(); } catch (e) { return false; } };
// May the page have this file read or written? A project file inside the projects folder, or a file the user picked
// (or that a project already had). Judged by its real location; a symbolic link itself is never written through.
function allowed(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) return false;
  const r = real(file);
  if (isApproved(r)) return true; // picked by the user: whatever became of the projects folder
  try { return insideFolder(r) && r.toLowerCase().endsWith(EXT); } catch (e) { return false; }
}

function approve(file) {
  const st = load(), r = real(file);
  if (!st.approved.some(f => same(f, r))) st.approved.push(r);
  if (st.approved.length > 500) st.approved.splice(0, st.approved.length - 500);
}
function remember(file) {
  const st = load(), r = path.resolve(file);
  st.recent = [r].concat(st.recent.filter(f => !same(f, r))).slice(0, RECENT_MAX);
}

// A file name from a project name: no path characters, no reserved names, a sensible length.
function fileNameFor(name) {
  let base = String(name || 'Map').replace(/[\\/:*?"<>|\x00-\x1f]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '');
  if (!base || /^(con|prn|aux|nul|com\d|lpt\d)$/i.test(base)) base = 'Map';
  return base.slice(0, 80) + EXT;
}
// The id written in a project file, or null.
function idIn(file) {
  try { const p = JSON.parse(fs.readFileSync(file, 'utf8')); return p && typeof p.id === 'string' ? p.id : null; } catch (e) { return null; }
}
// A new file in the projects folder for a project: its name, or "name (2)" when another project has that file.
function newFileFor(id, name) {
  const base = fileNameFor(name), stem = base.slice(0, -EXT.length);
  for (let i = 1; i < 1000; i++) {
    const file = path.join(load().folder, i === 1 ? base : `${stem} (${i})${EXT}`);
    if (isLink(file)) continue;
    if (!fs.existsSync(file) || idIn(file) === id) return file;
  }
  throw new Error('no free file name');
}

const projectJson = text => { const p = JSON.parse(text); if (!p || p.format !== 'gengis-project' || typeof p.id !== 'string') throw new Error('not a GenGIS project'); return p; };

function writeProject({ id, name, json } = {}) {
  if (typeof id !== 'string' || !id || typeof json !== 'string') throw new Error('bad request');
  const p = projectJson(json);
  if (p.id !== id) throw new Error('project id mismatch');
  const st = load();
  let file = st.projects[id];
  if (!file || !allowed(file) || isLink(file)) file = newFileFor(id, name);
  writeAtomic(file, json);
  st.projects[id] = path.resolve(file);
  remember(file);
  persist();
  return file;
}

// Read a file the page may read (picked just now in Open, or allowed already). Nothing is tied to a project yet:
// the page says which project it became once it has accepted opening it (files:adopt).
function readFile(file) {
  if (!allowed(file)) throw new Error('that file is not one GenGIS opened or saved');
  const text = fs.readFileSync(real(file), 'utf8');
  remember(file);
  persist();
  return { file: path.resolve(file), name: path.basename(file), text };
}

/* ----- only the app's own page ----- */
// Privileged requests are answered only for the app's own page in the window's main frame: never for a frame or a
// page the window was navigated to.
function trusted(e) {
  const f = e.senderFrame;
  return !!f && f === e.sender.mainFrame && typeof f.url === 'string' && f.url.split(/[?#]/)[0] === APP_PAGE;
}
const handle = (channel, fn) => ipcMain.handle(channel, (e, ...args) => {
  if (!trusted(e)) throw new Error('not allowed from this page');
  return fn(e, ...args);
});

function register() {
  // The projects folder.
  handle('files:folder', () => ({ folder: load().folder, isDefault: same(path.resolve(load().folder), path.resolve(defaultFolder())) }));

  handle('files:choose-folder', async e => {
    const st = load();
    const r = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender), { title: 'Folder for GenGIS projects', defaultPath: st.folder, properties: ['openDirectory', 'createDirectory', 'promptToCreate'] });
    if (r.canceled || !r.filePaths[0]) return null;
    // projects that already have a file keep it (in the old folder): only new files go to the new one
    Object.values(st.projects).concat(st.recent).forEach(f => { if (allowed(f)) approve(f); });
    st.folder = r.filePaths[0];
    fs.mkdirSync(st.folder, { recursive: true });
    persist();
    return { folder: st.folder, isDefault: same(path.resolve(st.folder), path.resolve(defaultFolder())) };
  });

  // Save a project to its file: the one it already has, else a new one in the projects folder.
  handle('files:write', (e, req) => ({ file: writeProject(req) }));
  // The same, synchronously: the page is unloading (closing, reloading) and cannot wait for an answer.
  ipcMain.on('files:write-sync', (e, req) => {
    if (!trusted(e)) { e.returnValue = { error: 'not allowed from this page' }; return; }
    try { e.returnValue = { file: writeProject(req) }; } catch (err) { e.returnValue = { error: err.message }; }
  });

  // Save as: the user picks the file; the project is kept there from now on.
  handle('files:save-as', async (e, { id, name, json } = {}) => {
    const p = projectJson(json);
    if (p.id !== id) throw new Error('project id mismatch');
    const st = load();
    const r = await dialog.showSaveDialog(BrowserWindow.fromWebContents(e.sender), { title: 'Save project as', defaultPath: path.join(st.folder, fileNameFor(name)), filters: [{ name: 'GenGIS project', extensions: ['gengis.json', 'json'] }] });
    if (r.canceled || !r.filePath) return null;
    writeAtomic(r.filePath, json);
    approve(r.filePath);
    st.projects[id] = path.resolve(r.filePath);
    remember(r.filePath);
    persist();
    return { file: r.filePath };
  });

  // Open: the user picks a project or GeoJSON file (which makes it one the page may read and, once adopted, write).
  handle('files:open', async e => {
    const r = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender), { title: 'Open project or GeoJSON', defaultPath: load().folder, properties: ['openFile'], filters: [{ name: 'Projects and GeoJSON', extensions: ['json', 'geojson'] }] });
    if (r.canceled || !r.filePaths[0]) return null;
    approve(r.filePaths[0]);
    return readFile(r.filePaths[0]);
  });

  // Open recent: a file opened or saved before.
  handle('files:read', (e, file) => readFile(file));

  // The page opened a project from this file (as project `id`, after any migration): keep it there from now on.
  handle('files:adopt', (e, { id, file } = {}) => {
    // only a file that was just read: it exists, and may be read and written
    if (typeof id !== 'string' || !id || !allowed(file) || !fs.existsSync(file) || isLink(file)) throw new Error('not allowed');
    load().projects[id] = path.resolve(file);
    persist();
    return true;
  });

  handle('files:recent', () => load().recent.filter(f => fs.existsSync(f) && allowed(f)).map(f => {
    const st = fs.statSync(f);
    return { file: f, name: path.basename(f), folder: path.dirname(f), modified: st.mtimeMs };
  }));

  handle('files:file-of', (e, id) => { const f = load().projects[id]; return f && fs.existsSync(f) && allowed(f) ? f : null; });

  handle('files:reveal', (e, file) => {
    if (file && allowed(file) && fs.existsSync(file)) shell.showItemInFolder(path.resolve(file));
    else { fs.mkdirSync(load().folder, { recursive: true }); shell.openPath(load().folder); }
  });
}

module.exports = { register, APP_PAGE, trusted };
