// @ts-nocheck
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('humkt', {
  getInitialData: () => ipcRenderer.invoke('app:get-initial-data'),
  saveToken: (token) => ipcRenderer.invoke('token:save', token),
  testApi: () => ipcRenderer.invoke('api:test'),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
  startMonitor: () => ipcRenderer.invoke('monitor:start'),
  stopMonitor: () => ipcRenderer.invoke('monitor:stop'),
  unlockUnknownOrder: () => ipcRenderer.invoke('order:unlock-unknown'),
  onEvent: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('app:event', handler);
    return () => ipcRenderer.removeListener('app:event', handler);
  }
});
