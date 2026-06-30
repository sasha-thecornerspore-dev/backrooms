import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('backrooms', {
  submitWish: (text) => ipcRenderer.invoke('submit-wish', text),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (s) => ipcRenderer.invoke('save-settings', s),
  startLocalServer: () => ipcRenderer.invoke('start-local-server'),
  restartNow: () => ipcRenderer.send('restart-now'),
  onUpdateReady: (cb) => ipcRenderer.on('update-ready', cb),
})
