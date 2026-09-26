// Tests for tools/gfx/compare.mjs — the PNG decode / pixel-compare logic that the render-harness
// pass/fail verdict rests on. Pure Node (zlib + fs), no browser.
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { decodePng, encodePng, comparePixels, compareDirs } from '../tools/gfx/compare.mjs'

function image(w, h, fn) {
  const data = Buffer.alloc(w * h * 4)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const [r, g, b] = fn(x, y)
    const o = (y * w + x) * 4
    data[o] = r; data[o + 1] = g; data[o + 2] = b; data[o + 3] = 255
  }
  return { width: w, height: h, data }
}
const gradient = (x, y) => [(x * 37 + y * 11) & 255, (x * 5 + y * 91) & 255, (x * y + 13) & 255]

// A PNG whose scanlines use all five filter types (0-4), the way an encoder mixes them — this is
// what exercises the unfilter code (encodePng itself only writes filter 0).
function pngWithFilters(img, bpp) {
  const w = img.width, h = img.height, stride = w * bpp
  const px = (x, y, c) => img.data[(y * w + x) * 4 + c]
  const rows = []
  for (let y = 0; y < h; y++) rows.push(Buffer.from(Array.from({ length: stride }, (_, i) => px((i / bpp) | 0, y, i % bpp))))
  const out = []
  for (let y = 0; y < h; y++) {
    const ft = y % 5, cur = rows[y], prev = y ? rows[y - 1] : Buffer.alloc(stride)
    const line = Buffer.alloc(stride + 1); line[0] = ft
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0
      let pred = 0
      if (ft === 1) pred = a
      else if (ft === 2) pred = b
      else if (ft === 3) pred = (a + b) >> 1
      else if (ft === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); pred = (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c) }
      line[1 + i] = (cur[i] - pred) & 255
    }
    out.push(line)
  }
  // borrow encodePng's chunk framing by encoding a dummy image, then swap in our IDAT
  const dummy = encodePng(w, h, Buffer.alloc(w * h * 4))
  const sig = dummy.subarray(0, 8)
  const chunks = []
  let off = 8
  while (off < dummy.length) {
    const len = dummy.readUInt32BE(off), type = dummy.toString('latin1', off + 4, off + 8)
    chunks.push({ type, data: dummy.subarray(off + 8, off + 8 + len) })
    off += 12 + len
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 })
  const crc = (buf) => { let c = 0xffffffff; for (const v of buf) c = crcTable[(c ^ v) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
  const frame = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td))
    return Buffer.concat([len, td, c])
  }
  const ihdr = Buffer.from(chunks[0].data); ihdr[9] = bpp === 4 ? 6 : 2
  return Buffer.concat([sig, frame('IHDR', ihdr), frame('IDAT', zlib.deflateSync(Buffer.concat(out))), frame('IEND', Buffer.alloc(0))])
}

describe('tools/gfx/compare', () => {
  it('encodePng -> decodePng round-trips RGB pixels exactly', () => {
    const img = image(23, 17, gradient)
    const back = decodePng(encodePng(img.width, img.height, img.data))
    expect(back.width).toBe(23); expect(back.height).toBe(17)
    expect(Buffer.compare(back.data, img.data)).toBe(0)
  })

  it('unfilters scanlines using every PNG filter type, RGB and RGBA', () => {
    const img = image(19, 12, gradient)
    for (const bpp of [3, 4]) {
      const back = decodePng(pngWithFilters(img, bpp))
      expect(Buffer.compare(back.data, img.data)).toBe(0)
    }
  })

  it('counts mismatching pixels and the max channel delta', () => {
    const a = image(10, 10, () => [10, 20, 30])
    const b = image(10, 10, () => [10, 20, 30])
    expect(comparePixels(a, b)).toMatchObject({ same: true, mismatched: 0, maxDelta: 0 })
    b.data[0] = 13                      // pixel 0: R off by 3
    b.data[4 * 5 + 2] = 30 + 9          // pixel 5: B off by 9
    b.data[4 * 6 + 1] = 20 + 1          // pixel 6: G off by 1
    expect(comparePixels(a, b)).toMatchObject({ same: false, mismatched: 3, maxDelta: 9 })
  })

  it('reports a size mismatch instead of comparing', () => {
    expect(comparePixels(image(4, 4, gradient), image(4, 5, gradient))).toMatchObject({ same: false, sizeMismatch: true })
  })

  it('compareDirs: PASS for identical, FAIL for a changed or missing scene', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gfx-cmp-'))
    const A = path.join(root, 'a'), B = path.join(root, 'b'), D = path.join(root, 'diff')
    fs.mkdirSync(A); fs.mkdirSync(B)
    const one = image(8, 8, gradient), two = image(8, 8, gradient); two.data[8] ^= 0x40
    const put = (dir, name, img) => fs.writeFileSync(path.join(dir, name + '.png'), encodePng(img.width, img.height, img.data))
    put(A, 'same', one); put(B, 'same', one)
    put(A, 'changed', one); put(B, 'changed', two)
    put(A, 'onlyA', one)
    const rows = Object.fromEntries(compareDirs(A, B, { diffOut: D }).map((r) => [r.name, r]))
    expect(rows.same.status).toBe('PASS')
    expect(rows.changed).toMatchObject({ status: 'FAIL', mismatched: 1, maxDelta: 0x40 })
    expect(rows.onlyA.status).toBe('FAIL')
    expect(fs.existsSync(path.join(D, 'changed.diff.png'))).toBe(true)
    expect(fs.existsSync(path.join(D, 'same.diff.png'))).toBe(false)
    fs.rmSync(root, { recursive: true, force: true })
  })
})
