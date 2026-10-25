/* GenGIS desktop app - the page's only door to the disk: a few project-file operations (electron/files.js decides
 * and checks every path), and receive-only MAVLink links for live drones (electron/mavlink.js). Runs sandboxed: only
 * contextBridge and ipcRenderer are used. */
const { contextBridge, ipcRenderer } = require('electron');

// Only the app's own page gets it (the main process also refuses requests from anything else).
if (location.protocol === 'file:' && /\/index\.html$/i.test(location.pathname)) contextBridge.exposeInMainWorld('gengisDesktop', {
  titleBar: process.platform === 'darwin' ? 'mac' : 'overlay', // where the window buttons are (electron/main.js)
  folder: () => ipcRenderer.invoke('files:folder'),
  chooseFolder: () => ipcRenderer.invoke('files:choose-folder'),
  write: (id, name, json) => ipcRenderer.invoke('files:write', { id, name, json }),
  writeSync: (id, name, json) => ipcRenderer.sendSync('files:write-sync', { id, name, json }),
  saveAs: (id, name, json) => ipcRenderer.invoke('files:save-as', { id, name, json }),
  open: () => ipcRenderer.invoke('files:open'),
  read: file => ipcRenderer.invoke('files:read', file),
  adopt: (id, file) => ipcRenderer.invoke('files:adopt', { id, file }),
  recent: () => ipcRenderer.invoke('files:recent'),
  fileOf: id => ipcRenderer.invoke('files:file-of', id),
  reveal: file => ipcRenderer.invoke('files:reveal', file),
  // the window's own full screen (F11, the View menu), which the page cannot see otherwise
  onFullScreen: fn => ipcRenderer.on('app:fullscreen', (e, on) => fn(!!on)),
  leaveFullScreen: () => ipcRenderer.send('app:leave-fullscreen'),
  // cloud sync: sign-in runs in the user's browser and the refresh tokens stay in the main process (cloudauth.js),
  // which also makes the cloud requests (to the cloud's own hosts only)
  cloud: {
    providers: ipcRenderer.sendSync('cloud:providers'),
    signIn: (provider, hint) => ipcRenderer.invoke('cloud:signin', { provider, hint }),
    token: accountId => ipcRenderer.invoke('cloud:token', { accountId }),
    signOut: accountId => ipcRenderer.invoke('cloud:signout', { accountId }),
    fetch: (url, method, headers, body) => ipcRenderer.invoke('cloud:fetch', { url, method, headers, body })
  },
  // live drones: a TCP or UDP link the page cannot open itself; bytes only come in
  mavlink: {
    open: (token, kind, host, port) => ipcRenderer.invoke('mavlink:open', { token, kind, host, port }),
    close: token => ipcRenderer.send('mavlink:close', token),
    onData: fn => ipcRenderer.on('mavlink:data', (e, token, bytes) => fn(token, bytes)),
    onStatus: fn => ipcRenderer.on('mavlink:status', (e, token, st) => fn(token, st))
  },
  // closing the window: the page saves what is pending, then says so
  onFlush: fn => ipcRenderer.on('app:flush', () => Promise.resolve().then(fn).catch(() => {}).then(() => ipcRenderer.send('app:flushed')))
});
