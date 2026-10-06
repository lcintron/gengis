/* GenGIS desktop app - the page's only door to the disk: a few project-file operations (electron/files.js decides
 * and checks every path). Runs sandboxed: only contextBridge and ipcRenderer are used. */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('gengisDesktop', {
  folder: () => ipcRenderer.invoke('files:folder'),
  chooseFolder: () => ipcRenderer.invoke('files:choose-folder'),
  write: (id, name, json) => ipcRenderer.invoke('files:write', { id, name, json }),
  writeSync: (id, name, json) => ipcRenderer.sendSync('files:write-sync', { id, name, json }),
  saveAs: (id, name, json) => ipcRenderer.invoke('files:save-as', { id, name, json }),
  open: () => ipcRenderer.invoke('files:open'),
  read: file => ipcRenderer.invoke('files:read', file),
  recent: () => ipcRenderer.invoke('files:recent'),
  fileOf: id => ipcRenderer.invoke('files:file-of', id),
  reveal: file => ipcRenderer.invoke('files:reveal', file),
  // closing the window: the page saves what is pending, then says so
  onFlush: fn => ipcRenderer.on('app:flush', () => Promise.resolve().then(fn).catch(() => {}).then(() => ipcRenderer.send('app:flushed')))
});
