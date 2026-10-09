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

// No system frame: the app's top bar is the window's title bar (css: html[data-titlebar]). On Windows and Linux the
// system's own window buttons are drawn over the bar's right end, in the bar's colors (as VS Code does); macOS keeps
// its traffic lights, at the bar's left. The overlay is the bar's height less its bottom border.
const TITLE_BAR = process.platform === 'darwin'
  ? { titleBarStyle: 'hidden', trafficLightPosition: { x: 16, y: 18 } }
  : { titleBarStyle: 'hidden', titleBarOverlay: { color: '#10171f', symbolColor: '#e6ebf2', height: 51 } };

function createWindow() {
  const win = new BrowserWindow(Object.assign({
    width: 1400, height: 900, minWidth: 1200, minHeight: 500,
    title: 'GenGIS', backgroundColor: '#0b1118', autoHideMenuBar: true,
    icon: path.join(__dirname, '..', 'icons', process.platform === 'win32' ? 'icon.ico' : 'icon-512.png'),
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, preload: path.join(__dirname, 'preload.js') }
  }, TITLE_BAR));
  win.loadFile(path.join(__dirname, '..', 'index.html'), { query: parseArgs() });
  // The window's own full screen (F11, the View menu) is not the page's (no :fullscreen, no fullscreenchange): the
  // page is told, so presenter mode follows it, and may ask to leave it.
  // (by the event, not isFullScreen(): on Windows that still says the old state while these fire)
  const sendFullScreen = on => () => { if (!win.webContents.isDestroyed()) win.webContents.send('app:fullscreen', on); };
  win.on('enter-full-screen', sendFullScreen(true));
  win.on('leave-full-screen', sendFullScreen(false));
  win.webContents.on('did-finish-load', () => sendFullScreen(win.isFullScreen())()); // a reload starts not knowing (settled by then)
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
  // The window shows the app and nothing else: links (attribution, about, a provider's own) open in the system
  // browser, never in this window, so no other page ever runs where the project-file bridge is.
  const external = url => { if (/^https?:\/\//i.test(url)) shell.openExternal(url); };
  win.webContents.setWindowOpenHandler(({ url }) => { external(url); return { action: 'deny' }; });
  const stayHome = (e, url) => { if (String(url).split(/[?#]/)[0] !== files.APP_PAGE) { e.preventDefault(); external(url); } };
  win.webContents.on('will-navigate', stayHome);
  win.webContents.on('will-redirect', stayHome);
}

app.whenReady().then(() => {
  files.register(); // project files on disk: electron/files.js
  ipcMain.on('app:leave-fullscreen', e => {
    const win = files.trusted(e) && BrowserWindow.fromWebContents(e.sender);
    if (win) win.setFullScreen(false);
  });
  // One listener per session (a second call replaces the first):
  // - Nominatim and Overpass ask clients to identify themselves.
  // - aisstream.io refuses connections from web pages, which it tells by the Origin header a page sends. The
  //   desktop app connects as an application does: without it, on that stream only.
  session.defaultSession.webRequest.onBeforeSendHeaders(
    { urls: ['https://nominatim.openstreetmap.org/*', 'https://overpass-api.de/*', 'wss://stream.aisstream.io/*'] },
    (details, callback) => {
      const headers = details.requestHeaders;
      if (/^wss:\/\/stream\.aisstream\.io\//.test(details.url)) Object.keys(headers).forEach(h => { if (h.toLowerCase() === 'origin') delete headers[h]; });
      else headers['User-Agent'] = 'GenGIS/0.0.1-Beta (Electron; standalone map editor)';
      callback({ requestHeaders: headers });
    }
  );
  // Live air and vessel traffic: the open ADS-B networks, and receivers set up without it, send no CORS header, and
  // the page needs one to read their JSON. Add it to those responses only (aircraft.json and ships.json feeds and
  // the two ADS-B APIs).
  session.defaultSession.webRequest.onHeadersReceived(
    { urls: ['https://api.adsb.lol/*', 'https://opendata.adsb.fi/*', '*://*/*aircraft.json*', '*://*/*ships.json*'] },
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
