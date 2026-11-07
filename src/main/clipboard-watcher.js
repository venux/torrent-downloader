'use strict'

/**
 * 剪切板监听：轮询取文本，识别磁力链接 / .torrent 直链。
 * Electron 的 clipboard 不提供变更事件（macOS/Linux 也没有可靠的），
 * 所以用 900ms 轮询，开销极小。
 */
const EventEmitter = require('node:events')

const MAGNET_RE = /magnet:\?[^\s"'<>`]+/i
const TORRENT_URL_RE = /https?:\/\/[^\s"'<>`]+?\.torrent(?:\?[^\s"'<>`]*)?/i

function detect(text) {
  if (!text || typeof text !== 'string') return null
  const magnet = text.match(MAGNET_RE)
  if (magnet) return { kind: 'magnet', text: magnet[0] }
  const url = text.match(TORRENT_URL_RE)
  if (url) return { kind: 'url', text: url[0] }
  return null
}

class ClipboardWatcher extends EventEmitter {
  constructor({ getText, interval = 900 }) {
    super()
    this.getText = getText
    this.interval = interval
    this.timer = null
    this.lastText = ''
    this.paused = false
  }

  start() {
    if (this.timer) return
    this.timer = setInterval(() => this.check(), this.interval)
    this.timer.unref?.()
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** 主动检查一次（用于面板上的“从剪切板粘贴”按钮） */
  check() {
    if (this.paused) return null
    let text = ''
    try {
      text = this.getText() || ''
    } catch {
      return null
    }
    if (!text || text === this.lastText) return null
    this.lastText = text
    const found = detect(text)
    if (found) this.emit('detected', found)
    return found
  }

  /** 让已知文本不再触发提示 */
  markSeen(text) {
    this.lastText = text || ''
  }
}

module.exports = { ClipboardWatcher, detect, MAGNET_RE, TORRENT_URL_RE }
