// Preload runs in Electron's sandboxed context — CommonJS only.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('backrooms', {
  submitWish: (text) => ipcRenderer.invoke('submit-wish', text),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (s) => ipcRenderer.invoke('save-settings', s),
  startLocalServer: () => ipcRenderer.invoke('start-local-server'),
  restartNow: () => ipcRenderer.send('restart-now'),
  onUpdateReady: (cb) => ipcRenderer.on('update-ready', cb),
  getVersion: () => ipcRenderer.invoke('get-version'),
  savePhoto: (dataUrl) => ipcRenderer.invoke('save-photo', dataUrl),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  fireBeacon: (payload) => ipcRenderer.invoke('fire-beacon', payload),
  logError: (msg) => ipcRenderer.send('renderer-log', msg),
})
