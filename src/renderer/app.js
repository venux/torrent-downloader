'use strict'

const api = window.torrentdock
const $ = (sel) => document.querySelector(sel)

const state = {
  torrents: [],
  stats: { count: 0, downloading: 0, done: 0, paused: 0, downloadSpeed: 0, uploadSpeed: 0 },
  settings: null,
  bridgePort: 0,
  filter: 'all',
  clip: null,
}

/* ------------------------------- 工具函数 -------------------------------- */

function formatBytes(bytes) {
  const n = Number(bytes)
  if (!Number.isFinite(n) || n <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let v = n
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`
}

function formatSpeed(bytes) {
  return `${formatBytes(bytes)}/s`
}

function formatEta(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return null
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s} 秒`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} 分 ${s % 60} 秒`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} 小时 ${m % 60} 分`
  return `${Math.floor(h / 24)} 天 ${h % 24} 小时`
}

function toast(text, type = 'info') {
  const el = document.createElement('div')
  el.className = `toast${type === 'error' ? ' is-error' : type === 'success' ? ' is-success' : ''}`
  el.textContent = text
  $('#toasts').appendChild(el)
  setTimeout(() => {
    el.classList.add('is-out')
    setTimeout(() => el.remove(), 220)
  }, 3400)
}

/* --------------------------------- 主题 ---------------------------------- */

const media = window.matchMedia('(prefers-color-scheme: dark)')

function applyTheme(theme) {
  const dark = theme === 'dark' || (theme !== 'light' && media.matches)
  document.documentElement.dataset.theme = dark ? 'dark' : 'light'
  const icon = $('#theme-icon')
  if (icon) icon.innerHTML = `<use href="${dark ? '#i-moon' : '#i-sun'}"/>`
  $('#btn-theme').title = dark ? '切换到浅色' : '切换到深色'
}

media.addEventListener('change', () => {
  if (!state.settings || state.settings.theme === 'system') applyTheme('system')
})

$('#btn-theme').addEventListener('click', async () => {
  const dark = document.documentElement.dataset.theme === 'dark'
  const next = dark ? 'light' : 'dark'
  applyTheme(next)
  await api.setSettings({ theme: next })
  syncModalFromSettings()
})

/* -------------------------------- 渲染列表 -------------------------------- */

const listEl = $('#torrent-list')
const emptyEl = $('#empty')

function visibleTorrents() {
  const list = state.torrents
  if (state.filter === 'done') return list.filter((t) => t.done)
  if (state.filter === 'paused') return list.filter((t) => t.paused && !t.done)
  if (state.filter === 'downloading') return list.filter((t) => !t.done && !t.paused)
  return list
}

function createCard(t) {
  const el = document.createElement('div')
  el.className = 'torrent'
  el.dataset.hash = t.infoHash
  el.innerHTML = `
    <div class="t-head">
      <div class="t-badge"><svg viewBox="0 0 24 24"><use href="#i-file"/></svg></div>
      <div class="t-main"><div class="t-name"></div></div>
      <div class="t-side">
        <button class="t-btn" data-act="toggle" title="暂停 / 继续"><svg viewBox="0 0 24 24"><use href="#i-pause"/></svg></button>
        <button class="t-btn" data-act="folder" title="打开所在文件夹"><svg viewBox="0 0 24 24"><use href="#i-folder"/></svg></button>
        <button class="t-btn" data-act="copy" title="复制磁力链接"><svg viewBox="0 0 24 24"><use href="#i-copy"/></svg></button>
        <button class="t-btn danger" data-act="remove" title="移除任务（按住 Alt 同时删除文件）"><svg viewBox="0 0 24 24"><use href="#i-trash"/></svg></button>
      </div>
    </div>
    <div class="t-progress"><div class="t-progress-fill"></div></div>
    <div class="t-meta"></div>
  `
  return el
}

function buildMeta(t) {
  const parts = []
  parts.push(`<span class="pct">${(t.progress * 100).toFixed(1)}%</span>`)
  parts.push(`<span>${formatBytes(t.downloaded)} / ${formatBytes(t.length)}</span>`)

  if (t.done) {
    parts.push(`<span class="done-tag">已完成</span>`)
    if (t.uploadSpeed > 0) parts.push(`<span class="up">↑ ${formatSpeed(t.uploadSpeed)}</span>`)
  } else if (t.paused) {
    parts.push('<span>已暂停</span>')
    if (t.numPeers) parts.push(`<span>${t.numPeers} 个连接</span>`)
  } else {
    if (t.downloadSpeed > 0) parts.push(`<span class="down">↓ ${formatSpeed(t.downloadSpeed)}</span>`)
    if (t.uploadSpeed > 0) parts.push(`<span class="up">↑ ${formatSpeed(t.uploadSpeed)}</span>`)
    parts.push(`<span>${t.numPeers} 个连接</span>`)
    const eta = formatEta(t.timeRemaining)
    if (eta) parts.push(`<span>剩余 ${eta}</span>`)
  }
  return parts.join('<span class="sep"></span>')
}

function updateCard(el, t) {
  el.classList.toggle('is-paused', !!t.paused && !t.done)
  el.classList.toggle('is-done', !!t.done)
  el.classList.toggle('is-active', !t.paused && !t.done)
  el.classList.toggle('is-loading', !t.ready)

  const nameEl = el.querySelector('.t-name')
  if (nameEl.textContent !== t.name) nameEl.textContent = t.name
  nameEl.classList.toggle('is-placeholder', t.name === '正在获取元数据…')

  const fill = el.querySelector('.t-progress-fill')
  fill.style.width = `${Math.max(t.progress * 100, t.progress > 0 ? 1.5 : 0)}%`

  const meta = buildMeta(t)
  const metaEl = el.querySelector('.t-meta')
  if (metaEl.dataset.v !== meta) {
    metaEl.innerHTML = meta
    metaEl.dataset.v = meta
  }

  const useEl = el.querySelector('[data-act="toggle"] use')
  const icon = t.paused ? '#i-play' : '#i-pause'
  if (useEl.getAttribute('href') !== icon) useEl.setAttribute('href', icon)

  el.querySelector('[data-act="toggle"]').title = t.paused ? '继续下载' : '暂停'
}

function render() {
  const list = visibleTorrents()
  const pool = new Map()
  for (const child of [...listEl.children]) pool.set(child.dataset.hash, child)

  let prev = null
  for (const t of list) {
    let el = pool.get(t.infoHash)
    if (!el) el = createCard(t)
    updateCard(el, t)
    const expected = prev ? prev.nextElementSibling : listEl.firstElementChild
    if (expected !== el) listEl.insertBefore(el, expected)
    prev = el
  }

  const keep = new Set(list.map((t) => t.infoHash))
  for (const [hash, el] of pool) if (!keep.has(hash)) el.remove()

  emptyEl.hidden = list.length > 0

  const s = state.stats
  $('[data-count="all"]').textContent = s.count
  $('[data-count="downloading"]').textContent = s.downloading
  $('[data-count="done"]').textContent = s.done
  $('[data-count="paused"]').textContent = s.paused
  $('#speed-down').textContent = formatSpeed(s.downloadSpeed)
  $('#speed-up').textContent = formatSpeed(s.uploadSpeed)

  const titles = { all: '全部任务', downloading: '下载中', done: '已完成', paused: '已暂停' }
  $('#list-title').textContent = titles[state.filter]
  const etaTotal = list.filter((t) => !t.done && !t.paused && t.timeRemaining).length
  $('#list-hint').textContent =
    list.length === 0 ? '' : `${list.length} 个任务${etaTotal ? ' · 正在传输' : ''}`
}

/* --------------------------------- 事件 ---------------------------------- */

listEl.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-act]')
  if (!btn) return
  const card = btn.closest('.torrent')
  const hash = card.dataset.hash
  const t = state.torrents.find((x) => x.infoHash === hash)
  if (!t) return

  const act = btn.dataset.act

  if (act === 'toggle') {
    if (t.paused) await api.resume(hash)
    else await api.pause(hash)
  } else if (act === 'folder') {
    const r = await api.openFolder(hash)
    if (r && !r.ok) toast(r.error, 'error')
  } else if (act === 'copy') {
    const ok = await api.copyText(t.magnetURI)
    toast(ok ? '磁力链接已复制' : '复制失败', ok ? 'success' : 'error')
  } else if (act === 'remove') {
    const deleteFiles = e.altKey
    await api.remove(hash, deleteFiles)
    toast(deleteFiles ? '任务与文件已删除' : '任务已移除，文件保留在下载目录')
  }
})

/* 侧栏筛选 */
$('#nav').addEventListener('click', (e) => {
  const item = e.target.closest('.nav-item')
  if (!item) return
  for (const el of document.querySelectorAll('.nav-item')) el.classList.remove('is-active')
  item.classList.add('is-active')
  state.filter = item.dataset.filter
  render()
})

/* 添加 */
async function addText(text) {
  const value = String(text || '').trim()
  if (!value) return false
  const res = await api.addTorrent(value)
  if (!res.ok) {
    toast(res.error || '添加失败', 'error')
    return false
  }
  if (res.duplicate) toast('这个任务已经在列表里了')
  else toast('已开始下载', 'success')
  return true
}

const addInput = $('#add-input')

async function addFromInput() {
  const text = addInput.value.trim()
  if (!text) {
    addInput.focus()
    return
  }
  if (await addText(text)) addInput.value = ''
}

$('#btn-add').addEventListener('click', addFromInput)
addInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') addFromInput()
  if (e.key === 'Escape') addInput.blur()
})

$('#btn-file').addEventListener('click', async () => {
  const r = await api.openTorrentDialog()
  if (r.added) toast(`已添加 ${r.added} 个种子`, 'success')
  if (r.errors && r.errors.length) toast(r.errors[0], 'error')
})

$('#btn-paste').addEventListener('click', async () => {
  const text = await api.readClipboard()
  if (!text) return toast('剪切板是空的', 'error')
  addInput.value = text
  if (await addText(text)) addInput.value = ''
})

/* 剪切板提示条 */
function showClipTip(found) {
  state.clip = found
  $('#clip-text').textContent = found.text.length > 96 ? `${found.text.slice(0, 96)}…` : found.text
  $('#clip-tip').hidden = false
}

function hideClipTip() {
  state.clip = null
  $('#clip-tip').hidden = true
}

$('#clip-add').addEventListener('click', async () => {
  if (!state.clip) return
  if (await addText(state.clip.text)) hideClipTip()
})

$('#clip-ignore').addEventListener('click', async () => {
  if (state.clip) await api.ignoreClipboard(state.clip.text)
  hideClipTip()
})

/* 拖拽种子文件 */
const overlay = $('#drop-overlay')
let dragDepth = 0

window.addEventListener('dragenter', (e) => {
  if (!e.dataTransfer || ![...e.dataTransfer.types].includes('Files')) return
  dragDepth++
  overlay.hidden = false
})
window.addEventListener('dragleave', (e) => {
  if (!e.dataTransfer || ![...e.dataTransfer.types].includes('Files')) return
  dragDepth = Math.max(0, dragDepth - 1)
  if (dragDepth === 0) overlay.hidden = true
})
window.addEventListener('dragover', (e) => e.preventDefault())

window.addEventListener('drop', async (e) => {
  e.preventDefault()
  dragDepth = 0
  overlay.hidden = true
  const files = [...(e.dataTransfer?.files || [])]
  if (!files.length) return

  let added = 0
  for (const file of files) {
    if (!file.name.toLowerCase().endsWith('.torrent')) {
      toast(`${file.name} 不是种子文件`, 'error')
      continue
    }
    const buffer = await file.arrayBuffer()
    const res = await api.addTorrentBuffer(buffer)
    if (res.ok) added++
    else toast(res.error, 'error')
  }
  if (added) toast(`已添加 ${added} 个种子`, 'success')
})

/* 全局粘贴：不在输入框里时直接加入 */
document.addEventListener('paste', async (e) => {
  if (e.target === addInput || e.target.tagName === 'INPUT') return
  e.preventDefault()
  const text = await api.readClipboard()
  if (text) await addText(text)
})

/* -------------------------------- 设置面板 -------------------------------- */

const modal = $('#modal')

function syncModalFromSettings() {
  const s = state.settings
  if (!s) return
  $('#set-path').value = s.downloadPath
  $('#set-port').value = s.bridgePort
  $('#set-conns').value = s.maxConns
  $('#set-watch').checked = !!s.watchClipboard
  $('#set-auto').checked = !!s.autoAddClipboard
  $('#set-seed').checked = !!s.seedAfterDone
  for (const btn of document.querySelectorAll('#set-theme button')) {
    btn.classList.toggle('is-active', btn.dataset.themeValue === s.theme)
  }
}

function openModal() {
  syncModalFromSettings()
  modal.hidden = false
}

function closeModal() {
  modal.hidden = true
}

$('#btn-settings').addEventListener('click', openModal)
$('#modal-close').addEventListener('click', closeModal)
$('#modal-done').addEventListener('click', closeModal)
modal.addEventListener('click', (e) => {
  if (e.target === modal) closeModal()
})
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !modal.hidden) closeModal()
})

$('#btn-browse').addEventListener('click', async () => {
  const dir = await api.chooseFolder()
  if (!dir) return
  $('#set-path').value = dir
  state.settings = await api.setSettings({ downloadPath: dir })
  toast('下载目录已更新', 'success')
})

$('#set-port').addEventListener('change', async (e) => {
  const port = Math.min(65535, Math.max(1024, parseInt(e.target.value, 10) || 33221))
  e.target.value = port
  state.settings = await api.setSettings({ bridgePort: port })
  toast('端口已保存，重启应用后生效')
})

$('#set-conns').addEventListener('change', async (e) => {
  const n = Math.min(500, Math.max(10, parseInt(e.target.value, 10) || 80))
  e.target.value = n
  state.settings = await api.setSettings({ maxConns: n })
})

$('#set-watch').addEventListener('change', async (e) => {
  state.settings = await api.setSettings({ watchClipboard: e.target.checked })
})

$('#set-auto').addEventListener('change', async (e) => {
  state.settings = await api.setSettings({ autoAddClipboard: e.target.checked })
})

$('#set-seed').addEventListener('change', async (e) => {
  state.settings = await api.setSettings({ seedAfterDone: e.target.checked })
})

$('#set-theme').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-theme-value]')
  if (!btn) return
  const theme = btn.dataset.themeValue
  applyTheme(theme)
  state.settings = await api.setSettings({ theme })
  syncModalFromSettings()
})

/* --------------------------------- 初始化 -------------------------------- */

async function init() {
  document.body.dataset.platform = api.platform

  const info = await api.info()
  state.bridgePort = info.bridgePort
  $('#app-version').textContent = info.version
  $('#bridge-port').textContent = info.bridgePort ? `:${info.bridgePort}` : '未启动'
  $('#side-port').textContent = info.bridgePort || '—'
  $('#bridge-badge').classList.toggle('is-off', !info.bridgePort)
  $('#bridge-badge').title = info.bridgePort
    ? `Chrome 扩展请填写端口 ${info.bridgePort}`
    : '本地桥接服务未启动'

  state.settings = await api.getSettings()
  applyTheme(state.settings.theme || 'system')
  syncModalFromSettings()

  api.onState((payload) => {
    state.torrents = payload.torrents || []
    state.stats = payload.stats || state.stats
    if (payload.bridgePort) state.bridgePort = payload.bridgePort
    render()
  })

  api.onClipboard((found) => {
    if (!found || !found.text) return
    if (state.torrents.some((t) => t.magnetURI === found.text)) return
    if (!modal.hidden) return
    showClipTip(found)
    addInput.focus({ preventScroll: true })
  })

  api.onToast((t) => toast(t.text, t.type))
  api.onSettings((s) => {
    state.settings = s
    applyTheme(s.theme || 'system')
    syncModalFromSettings()
  })

  addInput.focus()
}

init()
