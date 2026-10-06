/* GenGIS - Electron wrapper.
 * Usage: npm start
 *        npm start -- --q="Eiffel Tower"
 *        npm start -- --lat=48.858 --lon=2.294 --zoom=16
 *        npm start -- --center=48.858,2.294 --poi=cafe
 */
const { app, BrowserWindow, ipcMain, session, shell } = require('electron');
const path = require('path');
const files = require('./files');

function parseArgs() {
  const q = {};
  process.argv.slice(1).forEach(a => {
    const m = a.match(/^--?([a-zA-Z]+)=(.*)$/);
    if (m) q[m[1]] = m[2];
  });
  return q;
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1400, height: 900, minWidth: 800, minHeight: 500,
    title: 'GenGIS', backgroundColor: '#0b1118', autoHideMenuBar: true,
    icon: path.join(__dirname, '..', 'icons', process.platform === 'win32' ? 'icon.ico' : 'icon-512.png'),
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, preload: path.join(__dirname, 'preload.js') }
  });
  win.loadFile(path.join(__dirname, '..', 'index.html'), { query: parseArgs() });
  // Closing: the page first saves what is pending (its database and the project file), then the window closes.
  // A page that does not answer within 4 s does not hold the window.
  let saved = false;
  win.on('close', e => {
    if (saved || win.webContents.isDestroyed()) return;
    e.preventDefault();
    const done = () => { if (saved) return; saved = true; ipcMain.removeListener('app:flushed', onFlushed); if (!win.isDestroyed()) win.close(); };
    const onFlushed = ev => { if (ev.sender === win.webContents) done(); };
    ipcMain.on('app:flushed', onFlushed);
    win.webContents.send('app:flush');
    setTimeout(done, 4000);
  });
  // Open external links (attribution, about) in the system browser.
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
}

app.whenReady().then(() => {
  files.register(); // project files on disk: electron/files.js
  // Nominatim and Overpass ask clients to identify themselves.
  session.defaultSession.webRequest.onBeforeSendHeaders(
    { urls: ['https://nominatim.openstreetmap.org/*', 'https://overpass-api.de/*'] },
    (details, callback) => {
      details.requestHeaders['User-Agent'] = 'GenGIS/0.0.1-Beta (Electron; standalone map editor)';
      callback({ requestHeaders: details.requestHeaders });
    }
  );
  // Live air traffic: the open ADS-B networks, and receivers set up without it, send no CORS header, and the
  // page needs one to read their JSON. Add it to those responses only (aircraft.json feeds and the two APIs).
  session.defaultSession.webRequest.onHeadersReceived(
    { urls: ['https://api.adsb.lol/*', 'https://opendata.adsb.fi/*', '*://*/*aircraft.json*'] },
    (details, callback) => {
      const headers = details.responseHeaders || {};
      if (!Object.keys(headers).some(h => h.toLowerCase() === 'access-control-allow-origin')) headers['Access-Control-Allow-Origin'] = ['*'];
      callback({ responseHeaders: headers });
    }
  );
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
