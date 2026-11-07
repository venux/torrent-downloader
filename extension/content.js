/**
 * TorrentDock 内容脚本
 * 1) 给页面里的磁力链接 / .torrent 链接加一个「↓」按钮
 * 2) 支持右键菜单「发送页面内的种子链接」
 */
(() => {
  if (window.__torrentDockLoaded) return
  window.__torrentDockLoaded = true

  const MAX_LINKS = 400
  const MARK = 'data-tdock'

  function isTorrentLink(href) {
    if (!href) return false
    if (/^magnet:\?/i.test(href)) return true
    return /\.torrent(\?|#|$)/i.test(href) && /^https?:/i.test(href)
  }

  function collectLinks() {
    const out = []
    const seen = new Set()
    const anchors = document.querySelectorAll('a[href]')
    for (const a of anchors) {
      const href = a.getAttribute('href') || ''
      if (!isTorrentLink(href)) continue
      if (seen.has(href)) continue
      seen.add(href)
      out.push(href)
      if (out.length >= MAX_LINKS) break
    }
    return out
  }

  /* ------------------------------- 页面提示 ------------------------------- */

  let toastTimer = null

  function pageToast(text, type) {
    let el = document.querySelector('.tdock-toast')
    if (!el) {
      el = document.createElement('div')
      el.className = 'tdock-toast'
      document.body.appendChild(el)
    }
    el.dataset.type = type || 'ok'
    el.textContent = text
    el.classList.add('is-show')
    clearTimeout(toastTimer)
    toastTimer = setTimeout(() => el.classList.remove('is-show'), 2400)
  }

  function send(text) {
    chrome.runtime.sendMessage({ type: 'send', text }, (res) => {
      if (chrome.runtime.lastError) {
        pageToast('扩展通信失败', 'err')
        return
      }
      if (res && res.ok) pageToast(res.duplicate ? '已经在下载列表里了' : '已发送到 TorrentDock', 'ok')
      else pageToast((res && res.error) || '发送失败，TorrentDock 是否已打开？', 'err')
    })
  }

  /* ------------------------------- 注入按钮 ------------------------------- */

  function inject(anchor) {
    const href = anchor.getAttribute('href') || ''
    if (!isTorrentLink(href)) return
    anchor.setAttribute(MARK, '1')

    const btn = document.createElement('button')
    btn.className = 'tdock-btn'
    btn.type = 'button'
    btn.title = '发送到 TorrentDock'
    btn.textContent = '↓'
    btn.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      send(href)
    })

    if (anchor.parentNode) anchor.parentNode.insertBefore(btn, anchor.nextSibling)
  }

  function scan() {
    if (!document.body) return
    let list = document.querySelectorAll(`a[href]:not([${MARK}])`)
    let count = 0
    for (const a of list) {
      if (count >= MAX_LINKS) break
      const href = a.getAttribute('href') || ''
      if (!isTorrentLink(href)) {
        a.setAttribute(MARK, 'skip')
        continue
      }
      inject(a)
      count++
    }
  }

  /* --------------------------- 动态页面：节流重扫 --------------------------- */

  let scheduled = false
  const observer = new MutationObserver(() => {
    if (scheduled) return
    scheduled = true
    setTimeout(() => {
      scheduled = false
      scan()
    }, 600)
  })

  function boot() {
    scan()
    try {
      observer.observe(document.body, { childList: true, subtree: true })
    } catch {}
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true })
  } else {
    boot()
  }

  /* ------------------------------ 消息响应 -------------------------------- */

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.type === 'collect') {
      sendResponse({ items: collectLinks() })
    }
    return false
  })
})()
