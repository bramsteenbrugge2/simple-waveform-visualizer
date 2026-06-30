'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getConfig: () => ipcRenderer.invoke('get-config'),
  saveConfig: (cfg) => ipcRenderer.invoke('save-config', cfg),
  saveRecording: (payload) => ipcRenderer.invoke('save-recording', payload),
  chooseDirectory: () => ipcRenderer.invoke('choose-directory'),
  resolveOutputDir: (dir) => ipcRenderer.invoke('resolve-output-dir', dir),
  getConfigPath: () => ipcRenderer.invoke('get-config-path'),
  openPath: (dir) => ipcRenderer.invoke('open-path', dir),
  setFullscreen: (flag) => ipcRenderer.invoke('set-fullscreen', flag),
  quit: () => ipcRenderer.send('quit'),
  reportDevices: (list) => ipcRenderer.send('devices-report', list),
  onLayoutChanged: (cb) => ipcRenderer.on('layout-changed', () => cb()),

  // web remote
  getWebInfo: () => ipcRenderer.invoke('get-web-info'),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  onWebInfo: (cb) => ipcRenderer.on('web:info', (_e, info) => cb(info)),

  // live mirror: web page -> full-screen visualizer
  onShowRecording: (cb) => ipcRenderer.on('viz:show', (_e, d) => cb(d)),
  onSetGain: (cb) => ipcRenderer.on('viz:gain', (_e, v) => cb(v)),
  onSetSmooth: (cb) => ipcRenderer.on('viz:smooth', (_e, v) => cb(v)),
  onSetCompress: (cb) => ipcRenderer.on('viz:compress', (_e, v) => cb(v)),
  onVizConfig: (cb) => ipcRenderer.on('viz:config', (_e, d) => cb(d)),
  onRemoteStart: (cb) => ipcRenderer.on('viz:start', () => cb()),
  onRemoteReset: (cb) => ipcRenderer.on('viz:reset', () => cb()),
  onPlay: (cb) => ipcRenderer.on('viz:play', () => cb()),
  onPause: (cb) => ipcRenderer.on('viz:pause', () => cb()),
  onLoop: (cb) => ipcRenderer.on('viz:loop', (_e, v) => cb(v)),

  // renderer -> main reporting (for the web UI)
  reportState: (s) => ipcRenderer.send('viz:state', s),
  reportPeaks: (p) => ipcRenderer.send('viz:peaks', p),
  reportHostDevices: (labels) => ipcRenderer.send('devices-list', labels),
  onRequestDevices: (cb) => ipcRenderer.on('request-devices', () => cb())
});
