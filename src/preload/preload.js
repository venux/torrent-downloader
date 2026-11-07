'use strict'

const { contextBridge, ipcRenderer } = require('electron')

/**
 * 渲染进程能用的全部能力都收在这里，渲染层拿不到 Node。
 */
const api = {
  platform: process.platform,

  info: () => ipcRenderer.invoke('app:info'),

  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  chooseFolder: () => ipcRenderer.invoke('dialog:choose-folder'),
  openTorrentDialog: () => ipcRenderer.invoke('dialog:open-torrent'),

  addTorrent: (text) => ipcRenderer.invoke('torrent:add', text),
  addTorrentBuffer: (arrayBuffer) => ipcRenderer.invoke('torrent:add-buffer', arrayBuffer),
  pause: (id) => ipcRenderer.invoke('torrent:pause', id),
  resume: (id) => ipcRenderer.invoke('torrent:resume', id),
  remove: (id, deleteFiles) => ipcRenderer.invoke('torrent:remove', { id, deleteFiles }),
  files: (id) => ipcRenderer.invoke('torrent:files', id),
  openFolder: (id) => ipcRenderer.invoke('torrent:open-folder', id),

  readClipboard: () => ipcRenderer.invoke('clipboard:read'),
  copyText: (text) => ipcRenderer.invoke('clipboard:write', text),
  ignoreClipboard: (text) => ipcRenderer.invoke('clipboard:ignore', text),

  openExternal: (url) => ipcRenderer.invoke('shell:open-external', url),

  onState: (cb) => {
    const handler = (_e, payload) => cb(payload)
    ipcRenderer.on('torrents:update', handler)
    return () => ipcRenderer.removeListener('torrents:update', handler)
  },
  onClipboard: (cb) => {
    const handler = (_e, payload) => cb(payload)
    ipcRenderer.on('clipboard:detected', handler)
    return () => ipcRenderer.removeListener('clipboard:detected', handler)
  },
  onToast: (cb) => {
    const handler = (_e, payload) => cb(payload)
    ipcRenderer.on('toast', handler)
    return () => ipcRenderer.removeListener('toast', handler)
  },
  onSettings: (cb) => {
    const handler = (_e, payload) => cb(payload)
    ipcRenderer.on('settings:changed', handler)
    return () => ipcRenderer.removeListener('settings:changed', handler)
  },
}

contextBridge.exposeInMainWorld('torrentdock', api)
