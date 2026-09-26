// compare.mjs — pixel-exact comparison of two directories of harness PNGs.
//
//   node tools/gfx/compare.mjs <dirA> <dirB> [--diff-out <dir>] [--amplify 16] [--max-slowdown 1.10]
//
// Prints a per-scene table (mismatching pixels, max channel delta, PASS/FAIL) and exits 1 if any scene
// differs, is missing from either side, or has a different size. `--diff-out` writes an amplified
// |A-B| image per differing scene (identical pixels black; any differing pixel is lifted so it shows).
// If both directories hold a bench.json, a B/A frame-time table is printed too; it only affects the exit
// code when --max-slowdown is given (then B/A median above that ratio on any pose fails).
//
// PNG decoding is done here with zlib + a hand-written unfilter (no dependencies): 8-bit, non-interlaced,
// colour type 2 (RGB) or 6 (RGBA) — what Chromium's toDataURL emits. Anything else throws.
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { pathToFileURL } from 'node:url'

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

// ── decode ──────────────────────────────────────────────────────────────────────────────────────
export function decodePng(buf) {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(SIG)) throw new Error('not a PNG')
  let off = 8, width = 0, height = 0, depth = 0, ctype = -1, interlace = 0
  const idat = []
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off)
    const type = buf.toString('latin1', off + 4, off + 8)
    const data = buf.subarray(off + 8, off + 8 + len)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4)
      depth = data[8]; ctype = data[9]; interlace = data[12]
    } else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    off += 12 + len
  }
  if (depth !== 8 || interlace !== 0 || (ctype !== 2 && ctype !== 6)) {
    throw new Error(`unsupported PNG (bit depth ${depth}, colour type ${ctype}, interlace ${interlace}); need 8-bit RGB/RGBA, non-interlaced`)
  }
  const bpp = ctype === 6 ? 4 : 3
  const stride = width * bpp
  const raw = zlib.inflateSync(Buffer.concat(idat))
  if (raw.length !== (stride + 1) * height) throw new Error('PNG data length mismatch')
  const out = Buffer.alloc(width * height * 4)
  const prev = Buffer.alloc(stride)
  const cur = Buffer.alloc(stride)
  for (let y = 0; y < height; y++) {
    const ft = raw[y * (stride + 1)]
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0
      const b = prev[i]
      const c = i >= bpp ? prev[i - bpp] : 0
      let v = line[i]
      switch (ft) {
        case 0: break
        case 1: v += a; break
        case 2: v += b; break
        case 3: v += (a + b) >> 1; break
        case 4: {
          const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
          v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c)
          break
        }
        default: throw new Error('bad PNG filter type ' + ft)
      }
      cur[i] = v & 255
    }
    for (let x = 0; x < width; x++) {
      const s = x * bpp, d = (y * width + x) * 4
      out[d] = cur[s]; out[d + 1] = cur[s + 1]; out[d + 2] = cur[s + 2]
      out[d + 3] = bpp === 4 ? cur[s + 3] : 255
    }
    cur.copy(prev)
  }
  return { width, height, data: out }   // data: RGBA, 4 bytes/pixel
}

// ── encode (for diff images) ────────────────────────────────────────────────────────────────────
let CRC_TABLE = null
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      CRC_TABLE[n] = c >>> 0
    }
  }
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 255] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}
// rgba: width*height*4 bytes -> an RGB (colour type 2) PNG, filter 0
export function encodePng(width, height, rgba) {
  const raw = Buffer.alloc((width * 3 + 1) * height)
  for (let y = 0; y < height; y++) {
    const o = y * (width * 3 + 1)
    raw[o] = 0
    for (let x = 0; x < width; x++) {
      const s = (y * width + x) * 4, d = o + 1 + x * 3
      raw[d] = rgba[s]; raw[d + 1] = rgba[s + 1]; raw[d + 2] = rgba[s + 2]
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0
  return Buffer.concat([SIG, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

// ── compare ─────────────────────────────────────────────────────────────────────────────────────
// Returns { same, sizeMismatch, mismatched, maxDelta, diff? }. A pixel mismatches if ANY of R,G,B,A differs.
export function comparePixels(a, b, { wantDiff = false, amplify = 16 } = {}) {
  if (a.width !== b.width || a.height !== b.height) return { same: false, sizeMismatch: true, mismatched: -1, maxDelta: -1 }
  const n = a.width * a.height
  let mismatched = 0, maxDelta = 0
  const diff = wantDiff ? Buffer.alloc(n * 4) : null
  for (let i = 0; i < n; i++) {
    const o = i * 4
    const d0 = Math.abs(a.data[o] - b.data[o]), d1 = Math.abs(a.data[o + 1] - b.data[o + 1])
    const d2 = Math.abs(a.data[o + 2] - b.data[o + 2]), d3 = Math.abs(a.data[o + 3] - b.data[o + 3])
    const m = Math.max(d0, d1, d2, d3)
    if (m) {
      mismatched++
      if (m > maxDelta) maxDelta = m
      if (diff) {
        diff[o] = Math.min(255, 64 + d0 * amplify); diff[o + 1] = Math.min(255, 64 + d1 * amplify)
        diff[o + 2] = Math.min(255, 64 + d2 * amplify); diff[o + 3] = 255
      }
    } else if (diff) diff[o + 3] = 255
  }
  return { same: mismatched === 0, sizeMismatch: false, mismatched, maxDelta, diff }
}

export function listScenes(dir) {
  return fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.png')).map((f) => f.slice(0, -4)).sort()
}

export function compareDirs(dirA, dirB, { diffOut = null, amplify = 16 } = {}) {
  const A = new Set(listScenes(dirA)), B = new Set(listScenes(dirB))
  const names = [...new Set([...A, ...B])].sort()
  const rows = []
  if (diffOut) fs.mkdirSync(diffOut, { recursive: true })
  for (const name of names) {
    if (!A.has(name) || !B.has(name)) { rows.push({ name, status: 'FAIL', note: `missing in ${A.has(name) ? 'B' : 'A'}` }); continue }
    let r
    try {
      const pa = decodePng(fs.readFileSync(path.join(dirA, name + '.png')))
      const pb = decodePng(fs.readFileSync(path.join(dirB, name + '.png')))
      r = comparePixels(pa, pb, { wantDiff: !!diffOut, amplify })
      if (r.sizeMismatch) { rows.push({ name, status: 'FAIL', note: `size ${pa.width}x${pa.height} vs ${pb.width}x${pb.height}` }); continue }
      if (!r.same && diffOut) fs.writeFileSync(path.join(diffOut, name + '.diff.png'), encodePng(pa.width, pa.height, r.diff))
      rows.push({ name, status: r.same ? 'PASS' : 'FAIL', mismatched: r.mismatched, maxDelta: r.maxDelta, total: pa.width * pa.height })
    } catch (e) {
      rows.push({ name, status: 'FAIL', note: 'decode error: ' + e.message })
    }
  }
  return rows
}

export function formatTable(rows) {
  const w = Math.max(5, ...rows.map((r) => r.name.length))
  const lines = [`${'scene'.padEnd(w)}  ${'mismatch px'.padStart(12)}  ${'max delta'.padStart(9)}  result`]
  for (const r of rows) {
    if (r.note) lines.push(`${r.name.padEnd(w)}  ${'-'.padStart(12)}  ${'-'.padStart(9)}  ${r.status}  (${r.note})`)
    else lines.push(`${r.name.padEnd(w)}  ${String(r.mismatched).padStart(12)}  ${String(r.maxDelta).padStart(9)}  ${r.status}`)
  }
  const failed = rows.filter((r) => r.status !== 'PASS').length
  lines.push(`\n${rows.length - failed}/${rows.length} scenes identical${failed ? `, ${failed} differ` : ''}`)
  return lines.join('\n')
}

export function compareBench(dirA, dirB) {
  const rd = (d) => { try { return JSON.parse(fs.readFileSync(path.join(d, 'bench.json'), 'utf8')) } catch { return null } }
  const a = rd(dirA), b = rd(dirB)
  if (!a || !b) return null
  const rows = []
  for (const name of Object.keys(a.scenes)) {
    if (!b.scenes[name]) continue
    const x = a.scenes[name], y = b.scenes[name]
    rows.push({ name, aMed: x.medianMs, bMed: y.medianMs, ratio: y.medianMs / x.medianMs, aP95: x.p95Ms, bP95: y.p95Ms, ratioP95: y.p95Ms / x.p95Ms })
  }
  return { rows, note: `A: ${a.size.w}x${a.size.h} gpu=${a.gpu} rounds=${a.rounds}   B: ${b.size.w}x${b.size.h} gpu=${b.gpu} rounds=${b.rounds}` }
}

export function formatBench(bc) {
  const f = (v, n) => v.toFixed(2).padStart(n)
  const lines = [
    `bench (render() call, ms) - ${bc.note}`,
    `${'pose'.padEnd(14)}  ${'A median'.padStart(9)}  ${'B median'.padStart(9)}  ${'B/A'.padStart(6)}   ${'A p95'.padStart(7)}  ${'B p95'.padStart(7)}  ${'B/A'.padStart(6)}`,
  ]
  for (const r of bc.rows) lines.push(`${r.name.padEnd(14)}  ${f(r.aMed, 9)}  ${f(r.bMed, 9)}  ${f(r.ratio, 6)}   ${f(r.aP95, 7)}  ${f(r.bP95, 7)}  ${f(r.ratioP95, 6)}`)
  return lines.join('\n')
}

// ── CLI ─────────────────────────────────────────────────────────────────────────────────────────
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const argv = process.argv.slice(2)
  const pos = []
  let diffOut = null, amplify = 16, maxSlow = null
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--diff-out') diffOut = argv[++i]
    else if (argv[i] === '--amplify') amplify = Number(argv[++i]) || 16
    else if (argv[i] === '--max-slowdown') maxSlow = Number(argv[++i])
    else pos.push(argv[i])
  }
  if (pos.length !== 2) {
    console.error('usage: node tools/gfx/compare.mjs <dirA> <dirB> [--diff-out <dir>] [--amplify 16] [--max-slowdown 1.10]')
    process.exit(2)
  }
  for (const d of pos) if (!fs.existsSync(d) || !fs.statSync(d).isDirectory()) { console.error(`not a directory: ${d}`); process.exit(2) }
  const rows = compareDirs(pos[0], pos[1], { diffOut, amplify })
  if (!rows.length) { console.error('no PNGs found in either directory'); process.exit(2) }
  console.log(formatTable(rows))
  let slow = false
  const bc = compareBench(pos[0], pos[1])
  if (bc) {
    console.log('\n' + formatBench(bc))
    if (maxSlow) {
      const bad = bc.rows.filter((r) => r.ratio > maxSlow)
      if (bad.length) { slow = true; console.log(`SLOW: ${bad.map((r) => r.name).join(', ')} exceed ${maxSlow}x`) }
    }
  }
  process.exit(rows.some((r) => r.status !== 'PASS') || slow ? 1 : 0)
}
