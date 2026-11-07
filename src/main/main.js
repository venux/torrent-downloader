'use strict'

const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, Menu, nativeTheme } = require('electron')
const path = require('node:path')
const fs = require('node:fs')

const pkg = require('../../package.json')
const { Store } = require('./store')
const { TorrentManager, extractInfoHash } = require('./torrent-manager')
const { startBridge } = require('./bridge-server')
const { ClipboardWatcher } = require('./clipboard-watcher')

const APP_ID = 'com.torrentdock.app'
const isDev = process.argv.includes('--dev')

let win = null
let store = null
let manager = null
let bridge = null
let watcher = null
let bridgePort = 0
let tickTimer = null
let quitting = false

// 单实例：再次点击图标时聚焦已有窗口
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    }
  })
}

app.setAppUserModelId(APP_ID)
app.setName('TorrentDock')

/* ---------------------------------- 配置 ---------------------------------- */

function defaultSettings() {
  return {
    downloadPath: path.join(app.getPath('downloads'), 'TorrentDock'),
    bridgePort: 33221,
    watchClipboard: true,
    autoAddClipboard: false,
    theme: 'system',
    maxConns: 80,
    seedAfterDone: true,
  }
}

function ensureDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true })
    return true
  } catch {
    return false
  }
}

/* --------------------------------- 窗口 ---------------------------------- */

function createWindow() {
  const isMac = process.platform === 'darwin'

  win = new BrowserWindow({
    width: 1080,
    height: 720,
    minWidth: 860,
    minHeight: 560,
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#16171c' : '#f4f5f9',
    titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
    trafficLightPosition: isMac ? { x: 16, y: 16 } : undefined,
    titleBarOverlay: isMac
      ? undefined
      : {
          color: nativeTheme.shouldUseDarkColors ? '#16171c' : '#f4f5f9',
          symbolColor: nativeTheme.shouldUseDarkColors ? '#c9cddb' : '#3b3f4c',
          height: 48,
        },
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  })

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'))

  win.once('ready-to-show', () => {
    win.show()
    if (isDev) win.webContents.openDevTools({ mode: 'detach' })
  })

  win.on('closed', () => {
    win = null
  })

  // 外链一律用系统浏览器打开，不在应用内导航
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e) => e.preventDefault())

  // 右键菜单：复制 / 粘贴
  win.webContents.on('context-menu', (_e, params) => {
    const menu = []
    if (params.selectionText) {
      menu.push({ label: '复制', role: 'copy' })
    }
    if (params.isEditable) {
      menu.push({ label: '粘贴', role: 'paste' }, { label: '全选', role: 'selectAll' })
    }
    if (menu.length) Menu.buildFromTemplate(menu).popup({ window: win })
  })

  return win
}

function push(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}

function pushState() {
  if (!manager) return
  push('torrents:update', { ...manager.snapshot(), bridgePort })
}

/* ------------------------------- IPC 注册 --------------------------------- */

function registerIpc() {
  ipcMain.handle('app:info', () => ({
    version: pkg.version,
    platform: process.platform,
    bridgePort,
    appData: app.getPath('userData'),
  }))

  ipcMain.handle('settings:get', () => store.get())

  ipcMain.handle('settings:set', (_e, patch) => {
    const before = store.get()
    const next = store.set(patch || {})

    if (patch && patch.downloadPath && patch.downloadPath !== before.downloadPath) {
      ensureDir(next.downloadPath)
      manager.setDownloadPath(next.downloadPath)
    }
    if (typeof next.watchClipboard === 'boolean') {
      if (next.watchClipboard) watcher.start()
      else watcher.stop()
    }
    if (patch && typeof patch.theme === 'string') {
      nativeTheme.themeSource = ['light', 'dark'].includes(patch.theme) ? patch.theme : 'system'
      if (!win?.isDestroyed() && process.platform !== 'darwin') {
        try {
          win.setTitleBarOverlay({
            color: nativeTheme.shouldUseDarkColors ? '#16171c' : '#f4f5f9',
            symbolColor: nativeTheme.shouldUseDarkColors ? '#c9cddb' : '#3b3f4c',
            height: 48,
          })
        } catch {}
      }
    }
    push('settings:changed', next)
    return next
  })

  ipcMain.handle('dialog:choose-folder', async () => {
    const result = await dialog.showOpenDialog(win, {
      title: '选择下载目录',
      defaultPath: store.get('downloadPath'),
      properties: ['openDirectory', 'createDirectory'],
    })
    if (result.canceled || !result.filePaths.length) return null
    return result.filePaths[0]
  })

  ipcMain.handle('dialog:open-torrent', async () => {
    const result = await dialog.showOpenDialog(win, {
      title: '选择种子文件',
      filters: [{ name: 'BitTorrent 种子', extensions: ['torrent'] }],
      properties: ['openFile', 'multiSelections'],
    })
    if (result.canceled || !result.filePaths.length) return { added: 0, errors: [] }
    return addMany(result.filePaths)
  })

  ipcMain.handle('torrent:add', async (_e, text) => addOne(text))

  ipcMain.handle('torrent:add-buffer', async (_e, data) => {
    const buf = Buffer.from(data)
    return addOne(buf)
  })

  ipcMain.handle('torrent:pause', (_e, id) => manager.pause(id))
  ipcMain.handle('torrent:resume', (_e, id) => manager.resume(id))
  ipcMain.handle('torrent:remove', (_e, { id, deleteFiles }) => manager.remove(id, { deleteFiles }))
  ipcMain.handle('torrent:files', (_e, id) => manager.files(id))

  ipcMain.handle('torrent:open-folder', async (_e, id) => {
    const dir = manager.torrentPath(id)
    ensureDir(dir)
    const err = await shell.openPath(dir)
    if (err) return { ok: false, error: err }
    return { ok: true, path: dir }
  })

  ipcMain.handle('clipboard:read', () => {
    const text = clipboard.readText() || ''
    return text.trim()
  })

  ipcMain.handle('clipboard:write', (_e, text) => {
    try {
      clipboard.writeText(String(text || ''))
      return true
    } catch {
      return false
    }
  })

  ipcMain.handle('clipboard:ignore', (_e, text) => {
    watcher.markSeen(text)
    return true
  })

  ipcMain.handle('shell:open-external', (_e, url) => {
    if (/^https?:/.test(url)) shell.openExternal(url)
  })
}

function addOne(input) {
  try {
    const result = manager.add(input)
    pushState()
    return { ok: true, ...result }
  } catch (err) {
    return { ok: false, error: String(err.message || err) }
  }
}

/** 种子文件名要等元数据解析完才有，扩展那边等一小会儿再回包 */
function waitForName(infoHash, timeout = 700) {
  return new Promise((resolve) => {
    const started = Date.now()
    const tick = () => {
      const t = manager.snapshot().torrents.find((x) => x.infoHash === infoHash)
      if (!t) return resolve(null)
      if (t.name !== '正在获取元数据…') return resolve(t.name)
      if (Date.now() - started > timeout) return resolve(null)
      setTimeout(tick, 80)
    }
    tick()
  })
}

function addMany(list) {
  let added = 0
  const errors = []
  for (const item of list) {
    const r = addOne(item)
    if (r.ok) added++
    else errors.push(r.error)
  }
  if (added) pushState()
  return { added, errors }
}

/* ------------------------------- 启动流程 --------------------------------- */

async function bootstrap() {
  store = new Store(path.join(app.getPath('userData'), 'settings.json'), defaultSettings())

  const settings = store.get()
  nativeTheme.themeSource = ['light', 'dark'].includes(settings.theme) ? settings.theme : 'system'
  if (!ensureDir(settings.downloadPath)) {
    store.set({ downloadPath: app.getPath('downloads') })
  }

  // 下载内核
  manager = new TorrentManager({
    downloadPath: store.get('downloadPath'),
    maxConns: store.get('maxConns'),
    seedAfterDone: store.get('seedAfterDone'),
  })
  manager.start()
  manager.on('change', () => pushState())
  manager.on('error', (msg) => push('toast', { type: 'error', text: msg }))

  // 恢复历史任务（暂停态）
  const historyStore = new Store(path.join(app.getPath('userData'), 'history.json'), { items: [] })
  const restored = manager.restore(historyStore.get('items') || [])
  if (restored) console.log(`[history] 恢复了 ${restored} 个任务`)

  // 桥接服务
  const res = await startBridge({
    port: store.get('bridgePort') || 33221,
    handlers: {
      version: () => pkg.version,
      list: () => manager.snapshot(),
      add: async (text) => {
        const r = addOne(text)
        if (!r.ok) throw new Error(r.error)
        // 扩展发来的链接顺手标记一下，避免应用内再弹一次剪切板提示
        watcher.markSeen(text)
        const name = r.name || (await waitForName(r.infoHash))
        return { infoHash: r.infoHash, name, duplicate: r.duplicate }
      },
      action: (action, infoHash) => {
        if (!infoHash) return false
        if (action === 'pause') return manager.pause(infoHash)
        if (action === 'resume') return manager.resume(infoHash)
        if (action === 'remove') return manager.remove(infoHash)
        return false
      },
    },
  })

  if (res.ok) {
    bridge = res.server
    bridgePort = res.port
    if (res.port !== (store.get('bridgePort') || 33221)) {
      // 端口被占用，记下实际端口
      store.set({ bridgePort: res.port })
    }
    console.log(`[bridge] http://127.0.0.1:${bridgePort}`)
  } else {
    console.error('[bridge] 启动失败:', res.error)
  }

  // 剪切板监听
  watcher = new ClipboardWatcher({ getText: () => clipboard.readText() })
  watcher.on('detected', (found) => {
    if (!store.get('watchClipboard')) return
    const exists = found.kind === 'magnet' && manager.has(extractInfoHash(found.text))
    if (exists) return
    if (store.get('autoAddClipboard')) {
      const r = addOne(found.text)
      if (r.ok) push('toast', { type: 'success', text: r.duplicate ? '这个种子已经在列表里了' : '已自动添加剪切板中的链接' })
      return
    }
    push('clipboard:detected', found)
  })
  if (store.get('watchClipboard')) watcher.start()

  // 定时推送 + 定时落盘
  tickTimer = setInterval(() => {
    if (!manager) return
    pushState()
  }, 1000)

  setInterval(() => {
    if (!manager) return
    const items = manager.persistable()
    if (items.length) historyStore.set({ items })
  }, 15000)

  registerIpc()
}

app.whenReady().then(async () => {
  await bootstrap()
  createWindow()
  pushState()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', async (e) => {
  if (quitting) return
  quitting = true
  try {
    if (manager) {
      const items = manager.persistable()
      if (items.length) new Store(path.join(app.getPath('userData'), 'history.json'), { items: [] }).set({ items })
    }
    if (tickTimer) clearInterval(tickTimer)
    if (watcher) watcher.stop()
    if (bridge) bridge.close()
    if (manager) await manager.destroy()
  } catch {}
})
