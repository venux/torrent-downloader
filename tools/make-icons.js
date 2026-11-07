'use strict'

/**
 * 图标生成器：不依赖任何图形库，直接手写 PNG。
 * 运行：node tools/make-icons.js
 * 产出：build/icon.png(512) + extension/icons/icon{16,48,128}.png
 */
const fs = require('node:fs')
const path = require('node:path')
const zlib = require('node:zlib')

/* ------------------------------- PNG 编码 -------------------------------- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const typeBuf = Buffer.from(type, 'ascii')
  const crcBuf = Buffer.alloc(4)
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
  return Buffer.concat([len, typeBuf, data, crcBuf])
}

function encodePNG(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/* -------------------------------- 形状判定 -------------------------------- */

function roundedRect(x, y, x0, y0, x1, y1, r) {
  const cx = (x0 + x1) / 2
  const cy = (y0 + y1) / 2
  const hw = (x1 - x0) / 2
  const hh = (y1 - y0) / 2
  const dx = Math.abs(x - cx) - (hw - r)
  const dy = Math.abs(y - cy) - (hh - r)
  const ax = Math.max(dx, 0)
  const ay = Math.max(dy, 0)
  const dist = Math.sqrt(ax * ax + ay * ay) + Math.min(Math.max(dx, dy), 0) - r
  return dist <= 0
}

function inTriangle(px, py, ax, ay, bx, by, cx, cy) {
  const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by)
  const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy)
  const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay)
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0
  return !(hasNeg && hasPos)
}

/* -------------------------------- 绘制逻辑 -------------------------------- */

const TOP = [99, 102, 241] // #6366f1
const BOTTOM = [139, 92, 246] // #8b5cf6

function render(size) {
  const SS = 4
  const rgba = Buffer.alloc(size * size * 4)

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let bgHits = 0
      let glyphHits = 0

      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const u = (x + (sx + 0.5) / SS) / size
          const v = (y + (sy + 0.5) / SS) / size

          if (roundedRect(u, v, 0.045, 0.045, 0.955, 0.955, 0.2)) bgHits++

          const stem = roundedRect(u, v, 0.437, 0.225, 0.563, 0.505, 0.06)
          const head = inTriangle(u, v, 0.305, 0.472, 0.695, 0.472, 0.5, 0.742)
          const bar = roundedRect(u, v, 0.305, 0.8, 0.695, 0.874, 0.037)
          if (stem || head || bar) glyphHits++
        }
      }

      const total = SS * SS
      const bgA = bgHits / total
      const fgA = glyphHits / total

      const t = y / Math.max(1, size - 1)
      const base = [
        Math.round(TOP[0] + (BOTTOM[0] - TOP[0]) * t),
        Math.round(TOP[1] + (BOTTOM[1] - TOP[1]) * t),
        Math.round(TOP[2] + (BOTTOM[2] - TOP[2]) * t),
      ]

      // 白色字形覆盖在渐变底上
      const r = Math.round(base[0] * (1 - fgA) + 255 * fgA)
      const g = Math.round(base[1] * (1 - fgA) + 255 * fgA)
      const b = Math.round(base[2] * (1 - fgA) + 255 * fgA)

      const i = (y * size + x) * 4
      rgba[i] = r
      rgba[i + 1] = g
      rgba[i + 2] = b
      rgba[i + 3] = Math.round(bgA * 255)
    }
  }

  return encodePNG(size, size, rgba)
}

/* --------------------------------- 输出 ---------------------------------- */

const root = path.resolve(__dirname, '..')
const targets = [
  { file: path.join(root, 'build', 'icon.png'), size: 512 },
  { file: path.join(root, 'build', 'icon-256.png'), size: 256 },
  { file: path.join(root, 'extension', 'icons', 'icon16.png'), size: 16 },
  { file: path.join(root, 'extension', 'icons', 'icon48.png'), size: 48 },
  { file: path.join(root, 'extension', 'icons', 'icon128.png'), size: 128 },
]

for (const { file, size } of targets) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, render(size))
  console.log(`✓ ${path.relative(root, file)} (${size}×${size})`)
}
