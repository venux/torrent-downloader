'use strict'

/**
 * BT 下载内核：对 WebTorrent 的一层薄封装。
 * 这一层完全不依赖 Electron，方便单独用 node 跑测试（tools/test-core.js）。
 */
const EventEmitter = require('node:events')
const fs = require('node:fs')
const path = require('node:path')
const WebTorrent = require('webtorrent')

const BTIH_RE = /xt=urn:btih:([a-z0-9]{32,40})/i

/** 从磁力链接里取出 infoHash，用于去重 */
function extractInfoHash(text) {
  if (typeof text !== 'string') return null
  const m = text.match(BTIH_RE)
  return m ? m[1].toLowerCase() : null
}

function humanError(err) {
  const msg = String((err && err.message) || err)
  if (/duplicate/i.test(msg)) return '这个任务已经在下载列表里了'
  if (/invalid torrent/i.test(msg)) return '不是有效的磁力链接或种子文件'
  if (/ENOENT/i.test(msg)) return '种子文件不存在或无法读取'
  if (/ENOTFOUND|EAI_AGAIN|ETIMEDOUT/i.test(msg)) return '网络连接失败，请检查网络或代理设置'
  if (/ENOSPC/i.test(msg)) return '磁盘空间不足'
  return msg
}

class TorrentManager extends EventEmitter {
  constructor(options = {}) {
    super()
    this.downloadPath = options.downloadPath
    this.maxConns = options.maxConns || 80
    this.seedAfterDone = options.seedAfterDone !== false
    this.client = null
    /** @type {Map<string, {torrent: any, addedAt: number, source: string, paused: boolean}>} */
    this.records = new Map()
    this._lastEmit = 0
  }

  start() {
    if (this.client) return this
    this.client = new WebTorrent({
      maxConns: this.maxConns,
      dht: true,
      utp: true,
      downloadLimit: -1,
      uploadLimit: -1,
    })

    this.client.on('error', (err) => {
      this.emit('error', humanError(err))
    })

    // WebTorrent 在下载目录不可写时会抛在这个事件上
    this.client.on('warning', () => {})
    return this
  }

  get started() {
    return !!this.client
  }

  setDownloadPath(dir) {
    this.downloadPath = dir
  }

  /** 添加磁力链接 / .torrent 文件路径 / .torrent 内容 Buffer */
  add(input, opts = {}) {
    if (!this.client) throw new Error('下载内核尚未启动')
    const paused = !!opts.paused
    const savePath = opts.savePath || this.downloadPath

    if (input == null) throw new Error('内容为空')
    if (typeof input === 'string') {
      input = input.trim()
      if (!input) throw new Error('内容为空')
      // 先做本地校验，避免把明显不是种子的文字丢给内核
      const looksValid =
        /^magnet:\?.*xt=urn:bt/i.test(input) ||
        /^https?:\/\/\S+$/i.test(input) ||
        /\.torrent$/i.test(input)
      if (!looksValid) throw new Error('不是有效的磁力链接或种子文件')
    }

    // 磁力链接可以立刻拿到 infoHash，先做一次去重
    const hash = extractInfoHash(typeof input === 'string' ? input : '')
    if (hash && this.records.has(hash)) {
      return { infoHash: hash, duplicate: true, name: this.records.get(hash).torrent.name }
    }

    let torrent
    try {
      torrent = this.client.add(input, { path: savePath })
    } catch (err) {
      throw new Error(humanError(err))
    }
    if (!torrent) throw new Error('添加失败')

    // 必须立刻挂上错误监听：WebTorrent 清理重复种子时会把错误发到 torrent 上，
    // 没有监听器就会冒泡成 client 的 error。
    torrent.on('error', (err) => {
      const msg = String((err && err.message) || err)
      if (torrent.destroyed || /duplicate/i.test(msg)) return
      this.emit('error', humanError(err))
    })
    torrent.on('warning', () => {})

    const infoHash = torrent.infoHash || hash || `pending-${Date.now()}`

    // 同一个种子（比如重复拖入同一个 .torrent 文件）自己清理掉新对象
    if (this.records.has(infoHash)) {
      try {
        torrent._destroy(null)
      } catch {}
      return { infoHash, duplicate: true, name: this.records.get(infoHash).torrent.name }
    }

    const rec = {
      torrent,
      addedAt: Date.now(),
      source: typeof input === 'string' ? input : (torrent.magnetURI || ''),
      paused: false,
    }
    this.records.set(infoHash, rec)

    torrent.on('done', () => {
      if (!this.seedAfterDone) {
        try { torrent.deselect(0, torrent.pieces.length - 1, false) } catch {}
      }
      this.notify(true)
    })
    torrent.on('metadata', () => {
      // 拿到元数据后 infoHash 才有意义，磁力场景下把临时 id 换成真实 id
      if (torrent.infoHash && torrent.infoHash !== infoHash && !this.records.has(torrent.infoHash)) {
        this.records.delete(infoHash)
        this.records.set(torrent.infoHash, rec)
      }
      this.notify(true)
    })

    if (paused) this.pause(torrent.infoHash || infoHash)

    this.notify(true)
    return { infoHash: torrent.infoHash || infoHash, name: torrent.name, duplicate: false }
  }

  /** 启动时恢复上次的任务 */
  restore(items = []) {
    let added = 0
    for (const item of items) {
      const source = typeof item === 'string' ? item : item && item.source
      if (!source) continue
      try {
        // 恢复的任务默认暂停，避免开机偷偷跑流量
        this.add(source, { paused: true })
        added++
      } catch {
        /* 忽略坏的条目 */
      }
    }
    return added
  }

  _find(id) {
    if (!id) return null
    const key = String(id).toLowerCase()
    if (this.records.has(key)) return this.records.get(key)
    for (const [k, rec] of this.records) {
      if (k.toLowerCase() === key) return rec
    }
    return null
  }

  has(infoHash) {
    return !!infoHash && this.records.has(String(infoHash).toLowerCase())
  }

  pause(id) {
    const rec = this._find(id)
    if (!rec) return false
    const t = rec.torrent
    try {
      if (typeof t.pause === 'function') t.pause()
      else t.deselect(0, t.pieces.length - 1, false)
    } catch {}
    rec.paused = true
    this.notify(true)
    return true
  }

  resume(id) {
    const rec = this._find(id)
    if (!rec) return false
    const t = rec.torrent
    try {
      if (typeof t.resume === 'function') t.resume()
      else t.select(0, t.pieces.length - 1, false)
    } catch {}
    rec.paused = false
    this.notify(true)
    return true
  }

  remove(id, { deleteFiles = false } = {}) {
    const rec = this._find(id)
    if (!rec) return false
    const key = [...this.records.keys()].find((k) => this.records.get(k) === rec)
    if (key) this.records.delete(key)
    try {
      this.client.remove(rec.torrent.infoHash || rec.torrent, { destroyStore: !!deleteFiles }, () => {})
    } catch {}
    this.notify(true)
    return true
  }

  /** 该任务的实际落地目录 */
  torrentPath(id) {
    const rec = this._find(id)
    if (!rec) return this.downloadPath
    const t = rec.torrent
    const base = t.path || this.downloadPath
    if (t.name && t.name !== t.infoHash) {
      const full = path.join(base, t.name)
      try {
        if (fs.statSync(full).isDirectory()) return full
      } catch {}
    }
    return base
  }

  files(id) {
    const rec = this._find(id)
    if (!rec) return []
    return rec.torrent.files.map((f) => ({
      name: f.name,
      path: f.path,
      length: f.length,
      progress: Number.isFinite(f.progress) ? f.progress : 0,
    }))
  }

  notify(force = false) {
    const now = Date.now()
    if (!force && now - this._lastEmit < 400) return
    this._lastEmit = now
    this.emit('change', this.snapshot())
  }

  snapshot() {
    const torrents = []
    let totalDown = 0
    let totalUp = 0

    for (const [infoHash, rec] of this.records) {
      const t = rec.torrent
      const length = t.length || 0
      const downloaded = t.downloaded || 0
      const downSpeed = t.downloadSpeed || 0
      const upSpeed = t.uploadSpeed || 0
      totalDown += downSpeed
      totalUp += upSpeed

      const hasName = t.name && t.name !== t.infoHash
      torrents.push({
        infoHash,
        name: hasName ? t.name : '正在获取元数据…',
        ready: !!t.ready,
        progress: Number.isFinite(t.progress) ? Math.max(0, Math.min(1, t.progress)) : 0,
        length,
        downloaded,
        uploaded: t.uploaded || 0,
        downloadSpeed: downSpeed,
        uploadSpeed: upSpeed,
        numPeers: t.numPeers || 0,
        timeRemaining: Number.isFinite(t.timeRemaining) ? t.timeRemaining : null,
        ratio: Number.isFinite(t.ratio) ? t.ratio : 0,
        done: !!t.done,
        paused: !!rec.paused,
        path: t.path || this.downloadPath,
        magnetURI: t.magnetURI || rec.source,
        addedAt: rec.addedAt,
      })
    }

    torrents.sort((a, b) => b.addedAt - a.addedAt)

    return {
      torrents,
      stats: {
        count: torrents.length,
        downloading: torrents.filter((t) => !t.done && !t.paused).length,
        done: torrents.filter((t) => t.done).length,
        paused: torrents.filter((t) => t.paused && !t.done).length,
        downloadSpeed: totalDown,
        uploadSpeed: totalUp,
      },
    }
  }

  /** 供持久化用：只存磁力链接即可 */
  persistable() {
    return [...this.records.values()]
      .filter((r) => r.source || r.torrent.magnetURI)
      .map((r) => ({
        source: r.torrent.magnetURI || r.source,
        addedAt: r.addedAt,
        done: !!r.torrent.done,
      }))
  }

  destroy() {
    return new Promise((resolve) => {
      if (!this.client) return resolve()
      try {
        this.client.destroy(() => resolve())
      } catch {
        resolve()
      }
    })
  }
}

module.exports = { TorrentManager, extractInfoHash, humanError }
