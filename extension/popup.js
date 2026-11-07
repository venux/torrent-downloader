'use strict'

const $ = (id) => document.getElementById(id)
const textEl = $('text')
const msgEl = $('msg')
const statusEl = $('status')
const portEl = $('port')

function setStatus(kind, text) {
  statusEl.className = `status is-${kind}`
  statusEl.querySelector('em').textContent = text
}

function showMsg(text, type) {
  msgEl.hidden = false
  msgEl.dataset.type = type
  msgEl.textContent = text
}

function hideMsg() {
  msgEl.hidden = true
}

function loadPort() {
  return new Promise((resolve) => {
    chrome.storage.local.get({ port: 33221 }, (s) => {
      portEl.value = s.port
      resolve(s.port)
    })
  })
}

function checkConnection() {
  setStatus('checking', '正在检测…')
  chrome.runtime.sendMessage({ type: 'ping' }, (res) => {
    if (chrome.runtime.lastError || !res) {
      setStatus('off', '扩展状态异常')
      return
    }
    if (res.ok) setStatus('on', `已连接 127.0.0.1:${res.port}`)
    else setStatus('off', '未连接桌面端')
  })
}

async function readClipboard() {
  try {
    const text = await navigator.clipboard.readText()
    if (!text || !text.trim()) {
      showMsg('剪切板是空的', 'err')
      return ''
    }
    textEl.value = text.trim()
    hideMsg()
    return text.trim()
  } catch (err) {
    showMsg('浏览器没有授予剪切板权限，请手动粘贴 (Ctrl/⌘+V)', 'err')
    return ''
  }
}

function send() {
  const text = textEl.value.trim()
  if (!text) {
    showMsg('先粘贴一个磁力链接或种子地址', 'err')
    return
  }
  const btn = $('btn-send')
  btn.disabled = true
  btn.textContent = '发送中…'

  chrome.runtime.sendMessage({ type: 'send', text }, (res) => {
    btn.disabled = false
    btn.textContent = '发送到下载器'

    if (chrome.runtime.lastError) {
      showMsg('扩展内部错误，请重新加载扩展', 'err')
      return
    }
    if (res && res.ok) {
      showMsg(res.duplicate ? '这个任务已经在下载列表里了' : `已发送：${res.name || '开始下载'}`, 'ok')
      textEl.value = ''
      setStatus('on', `已连接 127.0.0.1:${portEl.value}`)
    } else {
      showMsg((res && res.hint) || (res && res.error) || '发送失败，请确认 TorrentDock 已打开', 'err')
      setStatus('off', '未连接桌面端')
    }
  })
}

/* ------------------------------- 事件绑定 -------------------------------- */

$('btn-send').addEventListener('click', send)

$('btn-paste').addEventListener('click', () => {
  readClipboard()
})

$('btn-save').addEventListener('click', () => {
  const port = Math.min(65535, Math.max(1024, parseInt(portEl.value, 10) || 33221))
  portEl.value = port
  chrome.storage.local.set({ port }, () => {
    showMsg(`端口已保存为 ${port}`, 'ok')
    checkConnection()
  })
})

textEl.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') send()
})

/* 打开弹窗自动尝试读取剪切板（无权限时静默失败） */
;(async () => {
  await loadPort()
  checkConnection()
  try {
    const text = await navigator.clipboard.readText()
    if (text && text.trim() && /^(magnet:|https?:)/i.test(text.trim())) {
      textEl.value = text.trim()
      textEl.select()
    }
  } catch {
    /* 需要用户点击，忽略 */
  }
  textEl.focus()
})()
