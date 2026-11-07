'use strict'

/**
 * 本地桥接服务：给 Chrome 扩展用的 HTTP API。
 * 只监听 127.0.0.1（外网访问不到），并且只对扩展来源开放跨域。
 *
 *   GET  /api/ping                    健康检查
 *   GET  /api/torrents                任务列表
 *   POST /api/add      {text}         添加磁力 / 种子链接
 *   POST /api/action   {infoHash,action}  pause | resume | remove
 */
const http = require('node:http')

const MAX_BODY = 512 * 1024

function isAllowedOrigin(origin) {
  if (!origin) return false
  return (
    origin.startsWith('chrome-extension://') ||
    origin.startsWith('moz-extension://') ||
    origin.startsWith('http://127.0.0.1') ||
    origin.startsWith('http://localhost') ||
    origin === 'null'
  )
}

function applyCors(req, res) {
  const origin = req.headers.origin
  if (isAllowedOrigin(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Vary', 'Origin')
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  res.setHeader('Access-Control-Max-Age', '86400')
}

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  })
  res.end(body)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (!raw) return resolve({})
      try {
        resolve(JSON.parse(raw))
      } catch {
        reject(new Error('请求体不是合法 JSON'))
      }
    })
    req.on('error', reject)
  })
}

const STATUS_PAGE = (port) => `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>TorrentDock 桥接服务</title>
<style>
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f4f5f9;
       font-family:-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;color:#1b1d23}
  .card{background:#fff;padding:36px 40px;border-radius:18px;box-shadow:0 12px 40px rgba(20,20,40,.08);
        border:1px solid #e6e8ef;max-width:520px}
  h1{margin:0 0 6px;font-size:20px}
  .dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:#16a34a;margin-right:8px}
  code{background:#f0f1f7;padding:2px 6px;border-radius:6px;font-size:13px}
  p{color:#5b6272;font-size:14px;line-height:1.7}
</style></head>
<body><div class="card">
  <h1><span class="dot"></span>TorrentDock 正在运行</h1>
  <p>桥接端口 <code>${port}</code>。把 Chrome 扩展的端口设置成这个数字即可连接。</p>
  <p>接口：<code>GET /api/ping</code> · <code>POST /api/add</code> · <code>GET /api/torrents</code></p>
</div></body></html>`

/**
 * @param {object} opts
 * @param {number} opts.port 首选端口，占用时自动 +1 尝试
 * @param {object} opts.handlers { ping, list, add, action }
 */
function startBridge({ port = 33221, handlers }) {
  return new Promise((resolve) => {
    let attempts = 0

    const onRequest = async (req, res) => {
      applyCors(req, res)

      if (req.method === 'OPTIONS') {
        res.writeHead(204)
        return res.end()
      }

      let pathname = '/'
      try {
        pathname = new URL(req.url, 'http://127.0.0.1').pathname.replace(/\/+$/, '') || '/'
      } catch {
        return sendJSON(res, 400, { ok: false, error: '请求地址不合法' })
      }

      try {
        if (pathname === '/') {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
          return res.end(STATUS_PAGE(server.address().port))
        }

        if (pathname === '/api/ping' && req.method === 'GET') {
          return sendJSON(res, 200, { ok: true, app: 'TorrentDock', version: handlers.version(), port: server.address().port })
        }

        if (pathname === '/api/torrents' && req.method === 'GET') {
          return sendJSON(res, 200, { ok: true, ...handlers.list() })
        }

        if (pathname === '/api/add' && req.method === 'POST') {
          const body = await readBody(req)
          const text = (body.text || body.url || '').trim()
          if (!text) return sendJSON(res, 400, { ok: false, error: '没有收到链接' })
          const result = await handlers.add(text)
          return sendJSON(res, 200, { ok: true, ...result })
        }

        if (pathname === '/api/action' && req.method === 'POST') {
          const body = await readBody(req)
          const result = handlers.action(body.action, body.infoHash)
          return sendJSON(res, 200, { ok: !!result, ...(typeof result === 'object' ? result : {}) })
        }

        return sendJSON(res, 404, { ok: false, error: '接口不存在' })
      } catch (err) {
        return sendJSON(res, 500, { ok: false, error: String(err && err.message ? err.message : err) })
      }
    }

    const server = http.createServer((req, res) => {
      onRequest(req, res).catch(() => {
        try { res.destroy() } catch {}
      })
    })

    const tryListen = (p) => {
      server.once('error', (err) => {
        if (err && err.code === 'EADDRINUSE' && attempts < 12) {
          attempts++
          setTimeout(() => tryListen(p + 1), 0)
          return
        }
        resolve({ ok: false, error: err.message })
      })
      server.listen(p, '127.0.0.1', () => {
        resolve({ ok: true, server, port: server.address().port })
      })
    }

    tryListen(port)
  })
}

module.exports = { startBridge }
