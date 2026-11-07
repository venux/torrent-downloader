'use strict'

// 开发期视觉验收：一次产出三张截图（浅色列表 / 设置面板 / 深色列表）
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')

const { app, BrowserWindow } = require('electron')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tdock-qa-'))
app.setPath('userData', tmp)
app.setPath('downloads', path.join(tmp, 'Downloads'))

require('../src/main/main.js')

const OUT = process.argv[2] || path.join(process.cwd(), 'qa')
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

const MAGNETS = [
  'magnet:?xt=urn:btih:dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c&dn=Big+Buck+Bunny&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337',
  'magnet:?xt=urn:btih:08ada5a7a6183aae1e09d831df6748d566095a10&dn=Sintel+%282010%29+4K+Remaster&tr=udp%3A%2F%2Fexplodie.org%3A6969',
]

async function shot(win, name) {
  const img = await win.webContents.capturePage()
  const file = `${OUT}-${name}.png`
  fs.writeFileSync(file, img.toPNG())
  console.log('saved', file)
}

app.whenReady().then(async () => {
  await wait(1500)
  const win0 = BrowserWindow.getAllWindows()[0]
  await shot(win0, 'empty')

  await wait(300)
  for (const m of MAGNETS) {
    await fetch('http://127.0.0.1:33221/api/add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: m }),
    }).catch(() => {})
  }
  await wait(3000)

  const win = BrowserWindow.getAllWindows()[0]
  await shot(win, 'list')

  await win.webContents.executeJavaScript("document.getElementById('btn-settings').click()")
  await wait(400)
  await shot(win, 'settings')

  await win.webContents.executeJavaScript("document.getElementById('modal-close').click()")
  await win.webContents.executeJavaScript("window.torrentdock.setSettings({ theme: 'dark' })")
  await wait(600)
  await shot(win, 'dark')

  app.exit(0)
})
