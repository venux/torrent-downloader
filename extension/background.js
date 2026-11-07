/**
 * TorrentDock 发送器 — 背景服务（MV3 Service Worker）
 * 负责：右键菜单、调用本地桥接 API、发送结果通知
 */

const DEFAULTS = { port: 33221 }

/* ------------------------------- 基础工具 -------------------------------- */

function getSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get(DEFAULTS, (s) => resolve({ ...DEFAULTS, ...s }))
  })
}

function baseUrl(port) {
  return `http://127.0.0.1:${port}`
}

async function request(port, path, options = {}, timeout = 4000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  try {
    const res = await fetch(baseUrl(port) + path, {
      ...options,
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    })
    const data = await res.json().catch(() => ({}))
    return { ok: res.ok && data.ok !== false, status: res.status, data }
  } catch (err) {
    return { ok: false, error: err.name === 'AbortError' ? '连接超时' : '无法连接 TorrentDock', data: {} }
  } finally {
    clearTimeout(timer)
  }
}

function ping(port) {
  return request(port, '/api/ping', { method: 'GET' }, 1500)
}

/** 发送一条链接到桌面端 */
async function sendToApp(text) {
  const trimmed = String(text || '').trim()
  if (!trimmed) return { ok: false, error: '内容是空的' }

  const { port } = await getSettings()
  const res = await request(port, '/api/add', {
    method: 'POST',
    body: JSON.stringify({ text: trimmed }),
  })

  if (!res.ok) {
    return {
      ok: false,
      error: res.data.error || res.error || '发送失败',
      hint: res.error ? `请确认 TorrentDock 已打开，端口 ${port} 一致` : null,
    }
  }
  return { ok: true, ...res.data }
}

/* -------------------------------- 通知 ---------------------------------- */

function notify(title, message) {
  try {
    chrome.notifications.create({
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title,
      message: message || '',
      silent: true,
    })
  } catch {
    /* 通知失败不影响主流程 */
  }
}

function flashBadge(ok) {
  try {
    chrome.action.setBadgeBackgroundColor({ color: ok ? '#10a15a' : '#e5484d' })
    chrome.action.setBadgeText({ text: ok ? 'OK' : '!' })
    setTimeout(() => chrome.action.setBadgeText({ text: '' }), 2600)
  } catch {}
}

/* ------------------------------ 右键菜单 -------------------------------- */

function buildMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'send-link',
      title: '发送此链接到 TorrentDock',
      contexts: ['link'],
    })
    chrome.contextMenus.create({
      id: 'send-selection',
      title: '发送选中内容到 TorrentDock',
      contexts: ['selection'],
    })
    chrome.contextMenus.create({
      id: 'send-page',
      title: '发送页面内的种子链接',
      contexts: ['page'],
    })
  })
}

chrome.runtime.onInstalled.addListener(buildMenus)
chrome.runtime.onStartup.addListener(buildMenus)

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  try {
    if (info.menuItemId === 'send-link') {
      const res = await sendToApp(info.linkUrl)
      notify(res.ok ? '已发送到 TorrentDock' : '发送失败', res.ok ? (res.name || '') : res.error)
      flashBadge(res.ok)
      return
    }

    if (info.menuItemId === 'send-selection') {
      const res = await sendToApp(info.selectionText)
      notify(res.ok ? '已发送到 TorrentDock' : '发送失败', res.ok ? (res.name || '') : res.error)
      flashBadge(res.ok)
      return
    }

    if (info.menuItemId === 'send-page' && tab && tab.id) {
      const links = await chrome.tabs.sendMessage(tab.id, { type: 'collect' }).catch(() => null)
      const list = (links && links.items) || []
      if (!list.length) {
        notify('这个页面没有找到磁力链接', '可以试试选中文字后右键发送')
        return
      }
      let ok = 0
      for (const item of list.slice(0, 20)) {
        const res = await sendToApp(item)
        if (res.ok) ok++
      }
      notify(ok ? `已发送 ${ok} 个任务` : '发送失败', ok ? '' : '请确认 TorrentDock 正在运行')
      flashBadge(ok > 0)
    }
  } catch (err) {
    notify('操作失败', String(err && err.message ? err.message : err))
  }
})

/* --------------------------- 与 popup / 页面通信 --------------------------- */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return

  if (msg.type === 'send') {
    sendToApp(msg.text).then((res) => {
      flashBadge(res.ok)
      sendResponse(res)
    })
    return true
  }

  if (msg.type === 'ping') {
    getSettings().then(async ({ port }) => {
      const res = await ping(port)
      sendResponse({ ok: res.ok, port, data: res.data })
    })
    return true
  }

  if (msg.type === 'page-toast') {
    sendResponse({ ok: true })
  }
})
