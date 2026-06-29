import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('backrooms', {
  submitWish: (text) => ipcRenderer.invoke('submit-wish', text),
})
