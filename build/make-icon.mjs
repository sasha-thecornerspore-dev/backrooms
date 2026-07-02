// Generates build/icon.ico (256x256, PNG-compressed) — an endless yellow corridor.
// Run: node build/make-icon.mjs
import { deflateSync } from 'node:zlib'
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const S = 256

function mulberry32(seed) {
  let s = seed >>> 0
  return () => {
    s += 0x6D2B79F5
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = t + Math.imul(t ^ (t >>> 7), 61 | t) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const rnd = mulberry32(0xBACC)

const lerp = (a, b, t) => a + (b - a) * t
const WALL  = [0xC9, 0xBA, 0x72]
const DARK  = [0x16, 0x11, 0x08]
const LIGHT = [0xF7, 0xF2, 0xCC]

const px = new Uint8Array(S * S * 4)
const c = (S - 1) / 2

for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    const dx = Math.abs(x - c) / c
    const dy = Math.abs(y - c) / c
    const t = Math.max(dx, dy)              // rectangular corridor rings, 0 center → 1 edge
    const shaped = Math.pow(t, 0.72)
    let r = lerp(DARK[0], WALL[0], shaped)
    let g = lerp(DARK[1], WALL[1], shaped)
    let b = lerp(DARK[2], WALL[2], shaped)

    const ceiling = (y < c) && (dy >= dx)
    const wallSide = dx > dy

    // fluorescent tube: bright band on the ceiling at a fixed ring depth
    if (ceiling && Math.abs(t - 0.52) < 0.035) {
      const glow = 1 - Math.abs(t - 0.52) / 0.035
      r = lerp(r, LIGHT[0], glow * 0.95)
      g = lerp(g, LIGHT[1], glow * 0.95)
      b = lerp(b, LIGHT[2], glow * 0.95)
    }
    // soft spill below the tube
    if (ceiling && t > 0.40 && t < 0.52) {
      const spill = (t - 0.40) / 0.12
      r = lerp(r, LIGHT[0], spill * 0.18)
      g = lerp(g, LIGHT[1], spill * 0.18)
      b = lerp(b, LIGHT[2], spill * 0.18)
    }
    // faint wallpaper stripes on the side walls, converging with depth
    if (wallSide) {
      const stripe = Math.floor((y - c) / Math.max(6, 26 * (1 - t))) & 1
      if (stripe) { r *= 0.94; g *= 0.94; b *= 0.94 }
    }
    // film grain
    const n = (rnd() - 0.5) * 12
    r += n; g += n; b += n
    // vignette
    const vr = Math.sqrt((x - c) ** 2 + (y - c) ** 2) / (c * Math.SQRT2)
    const v = 1 - 0.30 * vr * vr
    r *= v; g *= v; b *= v

    const i = (y * S + x) * 4
    px[i]     = Math.max(0, Math.min(255, r | 0))
    px[i + 1] = Math.max(0, Math.min(255, g | 0))
    px[i + 2] = Math.max(0, Math.min(255, b | 0))
    px[i + 3] = 255
  }
}

// ── PNG encode ──
const CRC_TABLE = new Int32Array(256)
for (let n = 0; n < 256; n++) {
  let cc = n
  for (let k = 0; k < 8; k++) cc = cc & 1 ? 0xEDB88320 ^ (cc >>> 1) : cc >>> 1
  CRC_TABLE[n] = cc
}
function crc32(buf) {
  let cc = -1
  for (const b of buf) cc = CRC_TABLE[(cc ^ b) & 0xFF] ^ (cc >>> 8)
  return (cc ^ -1) >>> 0
}
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, 'ascii')
  data.copy(out, 8)
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length)
  return out
}
const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4)
ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0
const raw = Buffer.alloc(S * (S * 4 + 1))
for (let y = 0; y < S; y++) {
  raw[y * (S * 4 + 1)] = 0
  Buffer.from(px.buffer, y * S * 4, S * 4).copy(raw, y * (S * 4 + 1) + 1)
}
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
])

// ── ICO wrap (single 256x256 PNG entry) ──
const ico = Buffer.alloc(22 + png.length)
ico.writeUInt16LE(0, 0)            // reserved
ico.writeUInt16LE(1, 2)            // type: icon
ico.writeUInt16LE(1, 4)            // count
ico[6] = 0                         // width 256
ico[7] = 0                         // height 256
ico[8] = 0; ico[9] = 0             // colors, reserved
ico.writeUInt16LE(1, 10)           // planes
ico.writeUInt16LE(32, 12)          // bpp
ico.writeUInt32LE(png.length, 14)  // bytes
ico.writeUInt32LE(22, 18)          // offset
png.copy(ico, 22)

writeFileSync(join(__dirname, 'icon.ico'), ico)
writeFileSync(join(__dirname, 'icon-256.png'), png)
console.log(`icon.ico ${ico.length} bytes, icon-256.png ${png.length} bytes`)
