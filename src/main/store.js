'use strict'

/**
 * 极简 JSON 配置存储：读写都同步、量小，足够用。
 * 不做原子写会更容易，但为了避免崩溃写坏文件，这里用 tmp + rename。
 */
const fs = require('node:fs')
const path = require('node:path')

class Store {
  constructor(file, defaults = {}) {
    this.file = file
    this.defaults = defaults
    this.data = { ...defaults, ...this._read() }
  }

  _read() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8')
      const parsed = JSON.parse(raw)
      return parsed && typeof parsed === 'object' ? parsed : {}
    } catch {
      return {}
    }
  }

  _write() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      const tmp = this.file + '.tmp'
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8')
      fs.renameSync(tmp, this.file)
    } catch (err) {
      console.error('[store] 写入失败:', err.message)
    }
  }

  get(key) {
    return key === undefined ? this.data : this.data[key]
  }

  set(patch) {
    if (!patch || typeof patch !== 'object') return this.data
    this.data = { ...this.data, ...patch }
    this._write()
    return this.data
  }

  merge(patch) {
    return this.set(patch)
  }
}

module.exports = { Store }
