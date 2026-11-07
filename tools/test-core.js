'use strict'

/**
 * 端到端冒烟测试：不启动 Electron，直接验证下载内核 + 桥接服务 + 剪切板识别。
 * 运行：npm run test:core
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const createTorrent = require('create-torrent')
const { TorrentManager } = require('../src/main/torrent-manager')
const { startBridge } = require('../src/main/bridge-server')
const { detect } = require('../src/main/clipboard-watcher')

const MAGNET =
  'magnet:?xt=urn:btih:dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c&dn=Big+Buck+Bunny' +
  '&tr=udp%3A%2F%2Fexplodie.org%3A6969%2Fannounce&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337'

let pass = 0
let fail = 0

function check(name, cond, extra = '') {
  if (cond) {
    pass++
    console.log(`  ✓ ${name}`)
  } else {
    fail++
    console.log(`  ✗ ${name} ${extra}`)
  }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tdock-'))
  console.log(`\n[1] 下载内核 (目录 ${tmp})`)

  const manager = new TorrentManager({ downloadPath: tmp })
  manager.start()
  check('WebTorrent 内核启动', manager.started)

  const r1 = manager.add(MAGNET)
  check('添加磁力链接', r1 && r1.duplicate === false, JSON.stringify(r1))
  check('infoHash 正确', r1.infoHash === 'dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c', r1.infoHash)

  const r2 = manager.add(MAGNET)
  check('重复添加被拦截', r2.duplicate === true)

  let snap = manager.snapshot()
  check('列表里有 1 个任务', snap.torrents.length === 1, `实际 ${snap.torrents.length}`)
  check('统计字段完整', typeof snap.stats.downloadSpeed === 'number' && snap.stats.count === 1)

  manager.pause(r1.infoHash)
  snap = manager.snapshot()
  check('暂停生效', snap.torrents[0].paused === true)

  manager.resume(r1.infoHash)
  snap = manager.snapshot()
  check('继续生效', snap.torrents[0].paused === false)

  console.log('\n[2] 桥接服务')
  const bridge = await startBridge({
    port: 33580,
    handlers: {
      version: () => '1.0.0-test',
      list: () => manager.snapshot(),
      add: async (text) => {
        const r = manager.add(text)
        if (!r.ok && r.error) throw new Error(r.error)
        return { infoHash: r.infoHash, name: r.name, duplicate: r.duplicate }
      },
      action: (action, infoHash) => (action === 'pause' ? manager.pause(infoHash) : manager.resume(infoHash)),
    },
  })
  check('服务监听成功', bridge.ok, bridge.error)

  const base = `http://127.0.0.1:${bridge.port}`

  const ping = await (await fetch(`${base}/api/ping`)).json()
  check('GET /api/ping', ping.ok === true && ping.app === 'TorrentDock')

  const list = await (await fetch(`${base}/api/torrents`)).json()
  check('GET /api/torrents', list.ok && list.torrents.length === 1)

  const addRes = await fetch(`${base}/api/add`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'chrome-extension://abcdefghijklmnop' },
    body: JSON.stringify({ text: MAGNET }),
  })
  const addJson = await addRes.json()
  check('POST /api/add 去重返回', addJson.ok === true && addJson.duplicate === true)
  check('CORS 回显扩展来源', addRes.headers.get('access-control-allow-origin') === 'chrome-extension://abcdefghijklmnop',
    addRes.headers.get('access-control-allow-origin'))

  const bad = await fetch(`${base}/api/add`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: '这不是种子' }),
  })
  const badJson = await bad.json()
  check('非法内容返回错误', badJson.ok === false && !!badJson.error, JSON.stringify(badJson))

  const pre = await fetch(`${base}/api/add`, { method: 'OPTIONS' })
  check('OPTIONS 预检返回 204', pre.status === 204)

  console.log('\n[3] 种子文件（.torrent 缓冲区）')
  const payload = path.join(tmp, 'payload.bin')
  fs.writeFileSync(payload, Buffer.alloc(256 * 1024, 7))
  const torrentBuf = await new Promise((resolve, reject) => {
    createTorrent(payload, { name: 'tdock-test-payload.bin' }, (err, buf) => (err ? reject(err) : resolve(buf)))
  })
  const r3 = manager.add(torrentBuf)
  check('添加 .torrent 缓冲区', r3 && r3.duplicate === false, JSON.stringify(r3))
  await wait(300)
  const parsed = manager.snapshot().torrents.find((t) => t.infoHash === r3.infoHash)
  check('种子文件名解析正确', !!parsed && parsed.name.includes('tdock-test-payload'), parsed && parsed.name)

  const r4 = manager.add(torrentBuf)
  check('重复种子不会重复入列', r4.duplicate === true && manager.snapshot().torrents.length === 2,
    `count=${manager.snapshot().torrents.length}`)

  console.log('\n[4] 剪切板识别')
  const cases = [
    ['magnet:?xt=urn:btih:abc123&dn=test', 'magnet'],
    ['  复制的东西 magnet:?xt=urn:btih:def456 后面还有字', 'magnet'],
    ['https://example.com/a/b.torrent', 'url'],
    ['https://example.com/page.html', null],
    ['随便一段文字', null],
  ]
  for (const [input, expect] of cases) {
    const got = detect(input)
    check(`识别 "${input.slice(0, 32)}…" → ${expect}`, (got && got.kind) === (expect || null),
      JSON.stringify(got))
  }

  console.log('\n[5] 清理')
  manager.remove(r1.infoHash)
  manager.remove(r3.infoHash)
  check('移除任务', manager.snapshot().torrents.length === 0)

  await manager.destroy()
  bridge.server.close()
  await wait(200)
  try {
    fs.rmSync(tmp, { recursive: true, force: true })
  } catch {}

  console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`)
  process.exit(fail ? 1 : 0)
}

main().catch((err) => {
  console.error('测试异常:', err)
  process.exit(1)
})
