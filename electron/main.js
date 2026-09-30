/* GenGIS - Electron wrapper.
 * Usage: npm start
 *        npm start -- --q="Eiffel Tower"
 *        npm start -- --lat=48.858 --lon=2.294 --zoom=16
 *        npm start -- --center=48.858,2.294 --poi=cafe
 */
const { app, BrowserWindow, session, shell } = require('electron');
const path = require('path');

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
    title: 'GenGIS', backgroundColor: '#1b1f27', autoHideMenuBar: true,
    icon: path.join(__dirname, '..', 'icons', 'icon-512.png'),
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false }
  });
  win.loadFile(path.join(__dirname, '..', 'index.html'), { query: parseArgs() });
  // Open external links (attribution, about) in the system browser.
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
}

app.whenReady().then(() => {
  // Nominatim and Overpass ask clients to identify themselves.
  session.defaultSession.webRequest.onBeforeSendHeaders(
    { urls: ['https://nominatim.openstreetmap.org/*', 'https://overpass-api.de/*'] },
    (details, callback) => {
      details.requestHeaders['User-Agent'] = 'GenGIS/0.0.1-Beta (Electron; standalone map editor)';
      callback({ requestHeaders: details.requestHeaders });
    }
  );
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
