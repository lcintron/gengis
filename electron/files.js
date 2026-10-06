/* GenGIS desktop app - project files on disk (main process).
 *
 * The page saves projects in its own database (IndexedDB); the desktop app also keeps each named project as a real
 * file: <projects folder>/<name>.gengis.json by default, or the file it was opened from or saved as. The folder is
 * Documents/GenGIS unless the user picks another one; the choice and which file belongs to which project are kept in
 * desktop-files.json in the app's user-data folder.
 *
 * The page reaches the disk only through the handlers below, and every path is decided or checked here: a project
 * file is written inside the projects folder, or to a file the user picked in a dialog (Save as, Open). Writes go to
 * a temporary file that then replaces the real one, so a crash never leaves half a project. */
const { app, dialog, ipcMain, shell, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const EXT = '.gengis.json';
const RECENT_MAX = 12;
let state = null; // { folder, projects: { id: file }, approved: [file], recent: [file] }

const stateFile = () => path.join(app.getPath('userData'), 'desktop-files.json');
const defaultFolder = () => path.join(app.getPath('documents'), 'GenGIS');

function load() {
  if (state) return state;
  try { state = JSON.parse(fs.readFileSync(stateFile(), 'utf8')); } catch (e) { state = {}; }
  state.folder = typeof state.folder === 'string' && state.folder ? state.folder : defaultFolder();
  state.projects = state.projects && typeof state.projects === 'object' ? state.projects : {};
  state.approved = Array.isArray(state.approved) ? state.approved : [];
  state.recent = Array.isArray(state.recent) ? state.recent : [];
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

const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase(); // Windows and macOS: case-insensitive
const insideFolder = file => { const rel = path.relative(load().folder, path.resolve(file)); return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel); };
const isApproved = file => load().approved.some(f => same(f, file));
// May the page have this file written or read? Inside the projects folder (a project file), or picked by the user.
const allowed = file => typeof file === 'string' && path.isAbsolute(file) && ((insideFolder(file) && file.toLowerCase().endsWith(EXT)) || isApproved(file));

function approve(file) {
  const st = load();
  if (!st.approved.some(f => same(f, file))) st.approved.push(path.resolve(file));
  if (st.approved.length > 200) st.approved.splice(0, st.approved.length - 200);
}
function remember(file) {
  const st = load();
  st.recent = [path.resolve(file)].concat(st.recent.filter(f => !same(f, file))).slice(0, RECENT_MAX);
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
    if (!fs.existsSync(file) || idIn(file) === id) return file;
  }
  throw new Error('no free file name');
}

const projectJson = text => { const p = JSON.parse(text); if (!p || p.format !== 'gengis-project' || typeof p.id !== 'string') throw new Error('not a GenGIS project'); return p; };

function register() {
  // The projects folder.
  ipcMain.handle('files:folder', () => ({ folder: load().folder, isDefault: same(load().folder, defaultFolder()) }));

  ipcMain.handle('files:choose-folder', async e => {
    const st = load();
    const r = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender), { title: 'Folder for GenGIS projects', defaultPath: st.folder, properties: ['openDirectory', 'createDirectory', 'promptToCreate'] });
    if (r.canceled || !r.filePaths[0]) return null;
    st.folder = r.filePaths[0];
    fs.mkdirSync(st.folder, { recursive: true });
    persist();
    return { folder: st.folder, isDefault: same(st.folder, defaultFolder()) };
  });

  // Save a project to its file: the one it already has, else a new one in the projects folder.
  ipcMain.handle('files:write', (e, req) => ({ file: writeProject(req) }));
  // The same, synchronously: the page is unloading (closing, reloading) and cannot wait for an answer.
  ipcMain.on('files:write-sync', (e, req) => {
    try { e.returnValue = { file: writeProject(req) }; } catch (err) { e.returnValue = { error: err.message }; }
  });

  // Save as: the user picks the file; the project is kept there from now on.
  ipcMain.handle('files:save-as', async (e, { id, name, json }) => {
    projectJson(json);
    const st = load();
    const win = BrowserWindow.fromWebContents(e.sender);
    const r = await dialog.showSaveDialog(win, { title: 'Save project as', defaultPath: path.join(st.folder, fileNameFor(name)), filters: [{ name: 'GenGIS project', extensions: ['gengis.json', 'json'] }] });
    if (r.canceled || !r.filePath) return null;
    writeAtomic(r.filePath, json);
    approve(r.filePath);
    st.projects[id] = path.resolve(r.filePath);
    remember(r.filePath);
    persist();
    return { file: r.filePath };
  });

  // Open: the user picks a project or GeoJSON file; a project keeps being saved there.
  ipcMain.handle('files:open', async e => {
    const st = load();
    const r = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender), { title: 'Open project or GeoJSON', defaultPath: st.folder, properties: ['openFile'], filters: [{ name: 'Projects and GeoJSON', extensions: ['json', 'geojson'] }] });
    if (r.canceled || !r.filePaths[0]) return null;
    return readAndTrack(r.filePaths[0], true);
  });

  // Open recent: a file opened or saved before.
  ipcMain.handle('files:read', (e, file) => {
    if (!allowed(file)) throw new Error('that file is not one GenGIS opened or saved');
    return readAndTrack(file, false);
  });

  ipcMain.handle('files:recent', () => load().recent.filter(f => fs.existsSync(f)).map(f => {
    const st = fs.statSync(f);
    return { file: f, name: path.basename(f), folder: path.dirname(f), modified: st.mtimeMs };
  }));

  ipcMain.handle('files:file-of', (e, id) => { const f = load().projects[id]; return f && fs.existsSync(f) ? f : null; });

  ipcMain.handle('files:reveal', (e, file) => {
    if (file && allowed(file) && fs.existsSync(file)) shell.showItemInFolder(file);
    else { fs.mkdirSync(load().folder, { recursive: true }); shell.openPath(load().folder); }
  });
}

function writeProject({ id, name, json } = {}) {
  if (typeof id !== 'string' || !id || typeof json !== 'string') throw new Error('bad request');
  const p = projectJson(json);
  if (p.id !== id) throw new Error('project id mismatch');
  const st = load();
  let file = st.projects[id];
  if (!file || !allowed(file)) file = newFileFor(id, name);
  writeAtomic(file, json);
  st.projects[id] = file;
  remember(file);
  persist();
  return file;
}

function readAndTrack(file, picked) {
  const text = fs.readFileSync(file, 'utf8');
  const st = load();
  if (picked) approve(file);
  remember(file);
  try { const p = JSON.parse(text); if (p && p.format === 'gengis-project' && typeof p.id === 'string') st.projects[p.id] = path.resolve(file); } catch (e) { /* GeoJSON or not JSON: the page says */ }
  persist();
  return { file, name: path.basename(file), text };
}

module.exports = { register };
