// parity.mjs — CPU-vs-GPU parity tool for the M2 WebGL2 backend.
//
//   node tools/gfx/parity.mjs --src <src/renderer dir> --out <dir> [--scenes a,b,c] [--quality medium | low,medium,high] [--size 960x540]
//        [--max-mean 0.08] [--max-p99 0.40] [--max-over 0.30] [--thresh 48] [--panel-scale 0.5] [--reuse] [--no-fail] [--verbose]
//
// Renders every scene twice through the same harness (tools/gfx/run.mjs) — once on the CPU path, once on the GPU path
// (--ropts '{"renderer":"gpu","allowSoftwareGl":true}': WebGL2 on SwiftShader) — at the same tier and size, then compares the two frames and writes
//   <out>/<tier>/cpu/*.png, <out>/<tier>/gpu/*.png   the raw harness output (manifest.json says which backend actually drew each frame)
//   <out>/<tier>/<scene>.side.png                     CPU | GPU | amplified difference, side by side (--panel-scale shrinks each panel; default 0.5)
//   <out>/parity.json                                 the report: per scene and tier
//
// Per-scene metrics (all channel values are 0..1):
//   mean      mean absolute per-channel difference over all pixels
//   p99       the 99th percentile of the per-pixel mean absolute channel difference (the worst 1% of the picture)
//   over      the fraction of pixels whose largest channel difference exceeds --thresh/255
//   block     the coarse metric the first-frame validation in the game uses (gfx-gl-g4-validate.js compareFrames on a 64x36 grid): per-channel
//             mean difference, mean absolute block difference, the WORST single block, luminance correlation — so the validation tolerances can be calibrated here
//   cpuMean / gpuMean   the mean colour of each frame (a systematically darker / brighter / tinted GPU frame shows up here first)
// Hardware filtering (mipmaps, anisotropy, bilinear) makes the GPU path smoother than the CPU raycaster's nearest sampling; that shows as small
// mean differences and a few high-difference edge pixels, and is fine. What must not happen is a systematic brightness / colour shift (see
// cpuMean / gpuMean) or a wrong picture (the block correlation drops).
//
// Exit code: 0 when every scene rendered on the GPU path (no silent CPU fallback) and mean/p99/over are within the limits (or --no-fail);
// 1 otherwise. The defaults are calibrated for the finished passes: run with --no-fail while the passes are still being built.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { decodePng, encodePng } from './compare.mjs'
import { blockMeans, compareFrames, VALIDATION_GRID } from '../../src/renderer/gfx-gl-g4-validate.js'

const here = path.dirname(fileURLToPath(import.meta.url))

export const DEFAULT_LIMITS = Object.freeze({ mean: 0.08, p99: 0.40, over: 0.30, thresh: 48 })

// ── pure comparison (unit-tested in test/gfx-gl-core-parity.test.js) ──
// a, b: { width, height, data: RGBA bytes }. -> { mean, p99, over, block, cpuMean, gpuMean }
export function comparePair(a, b, { thresh = DEFAULT_LIMITS.thresh } = {}) {
  if (a.width !== b.width || a.height !== b.height) throw new Error(`size mismatch ${a.width}x${a.height} vs ${b.width}x${b.height}`)
  const n = a.width * a.height, hist = new Uint32Array(256)
  let sum = 0, over = 0
  const am = [0, 0, 0], bm = [0, 0, 0]
  for (let i = 0; i < n; i++) {
    const o = i * 4
    const d0 = Math.abs(a.data[o] - b.data[o]), d1 = Math.abs(a.data[o + 1] - b.data[o + 1]), d2 = Math.abs(a.data[o + 2] - b.data[o + 2])
    sum += d0 + d1 + d2
    hist[Math.min(255, Math.round((d0 + d1 + d2) / 3))]++
    if (Math.max(d0, d1, d2) > thresh) over++
    am[0] += a.data[o]; am[1] += a.data[o + 1]; am[2] += a.data[o + 2]; bm[0] += b.data[o]; bm[1] += b.data[o + 1]; bm[2] += b.data[o + 2]
  }
  let acc = 0, p99 = 255; const target = n * 0.99
  for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= target) { p99 = v; break } }
  const gw = VALIDATION_GRID.w, gh = VALIDATION_GRID.h
  const blk = compareFrames(blockMeans(b.data, b.width, b.height, gw, gh, false), blockMeans(a.data, a.width, a.height, gw, gh, false))
  const r = (v) => Math.round(v * 10000) / 10000
  return {
    mean: r(sum / (n * 3 * 255)), p99: r(p99 / 255), over: r(over / n),
    block: { ok: blk.ok, reasons: blk.reasons, meanDiff: blk.meanDiff.map(r), meanAbs: r(blk.meanAbs), maxBlock: r(blk.maxBlock), corr: r(blk.corr) },
    cpuMean: am.map((v) => r(v / (n * 255))), gpuMean: bm.map((v) => r(v / (n * 255))),
  }
}

export function checkLimits(m, limits = DEFAULT_LIMITS) {
  const bad = []
  if (m.mean > limits.mean) bad.push(`mean ${m.mean} > ${limits.mean}`)
  if (m.p99 > limits.p99) bad.push(`p99 ${m.p99} > ${limits.p99}`)
  if (m.over > limits.over) bad.push(`over ${m.over} > ${limits.over}`)
  return bad
}

// CPU | GPU | amplified |CPU-GPU| in one image (each panel shrunk by an integer-ish box step `scale` <= 1)
export function sideBySide(a, b, { scale = 0.5, amplify = 4 } = {}) {
  const w = Math.max(1, Math.round(a.width * scale)), h = Math.max(1, Math.round(a.height * scale))
  const out = Buffer.alloc(w * 3 * h * 4)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const sx = Math.min(a.width - 1, Math.floor(x / scale)), sy = Math.min(a.height - 1, Math.floor(y / scale)), s = (sy * a.width + sx) * 4
    for (let p = 0; p < 3; p++) {
      const d = (y * w * 3 + p * w + x) * 4
      if (p === 0) { out[d] = a.data[s]; out[d + 1] = a.data[s + 1]; out[d + 2] = a.data[s + 2] }
      else if (p === 1) { out[d] = b.data[s]; out[d + 1] = b.data[s + 1]; out[d + 2] = b.data[s + 2] }
      else { out[d] = Math.min(255, Math.abs(a.data[s] - b.data[s]) * amplify); out[d + 1] = Math.min(255, Math.abs(a.data[s + 1] - b.data[s + 1]) * amplify); out[d + 2] = Math.min(255, Math.abs(a.data[s + 2] - b.data[s + 2]) * amplify) }
      out[d + 3] = 255
    }
  }
  return { width: w * 3, height: h, data: out }
}

function parseArgs(argv) {
  const val = {}, flags = new Set()
  const valued = new Set(['src', 'out', 'scenes', 'quality', 'size', 'max-mean', 'max-p99', 'max-over', 'thresh', 'panel-scale', 'timeout'])
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i]
    if (!t.startsWith('--')) { console.error(`unexpected argument: ${t}`); process.exit(2) }
    const k = t.slice(2)
    if (valued.has(k)) val[k] = argv[++i]; else flags.add(k)
  }
  return { val, flags }
}

function runHarness({ src, out, scenes, quality, size, gpu, timeout, verbose }) {
  const args = [path.join(here, 'run.mjs'), '--src', src, '--out', out, '--quality', quality, '--size', size, '--timeout', String(timeout)]
  if (scenes) args.push('--scenes', scenes)
  if (gpu) args.push('--ropts', JSON.stringify({ renderer: 'gpu', allowSoftwareGl: true }))
  const r = spawnSync(process.execPath, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (verbose || r.status !== 0) process.stdout.write((r.stdout || '') + (r.stderr || ''))
  return r.status === 0
}

async function main() {
  const { val, flags } = parseArgs(process.argv.slice(2))
  if (!val.src || !val.out) { console.error('usage: node tools/gfx/parity.mjs --src <src/renderer> --out <dir> [--scenes a,b] [--quality medium|low,medium,high] [--size 960x540] [--max-mean N] [--max-p99 N] [--max-over N] [--thresh 48] [--reuse] [--no-fail]'); process.exit(2) }
  const src = path.resolve(val.src), out = path.resolve(val.out)
  const limits = {
    mean: Number(val['max-mean'] ?? DEFAULT_LIMITS.mean), p99: Number(val['max-p99'] ?? DEFAULT_LIMITS.p99),
    over: Number(val['max-over'] ?? DEFAULT_LIMITS.over), thresh: Number(val.thresh ?? DEFAULT_LIMITS.thresh),
  }
  const tiers = (val.quality || 'medium').split(',').map((s) => s.trim()).filter(Boolean)
  const size = val.size || '960x540'
  const panel = Number(val['panel-scale'] || 0.5)
  const report = { tool: 'tools/gfx/parity.mjs', src, size, limits, tiers: {}, pass: true, problems: [] }
  fs.mkdirSync(out, { recursive: true })

  for (const tier of tiers) {
    const tdir = path.join(out, tier), cdir = path.join(tdir, 'cpu'), gdir = path.join(tdir, 'gpu')
    if (!flags.has('reuse')) {
      for (const d of [cdir, gdir]) fs.rmSync(d, { recursive: true, force: true })
      const common = { src, scenes: val.scenes || null, quality: tier, size, timeout: Number(val.timeout) || 900, verbose: flags.has('verbose') }
      console.log(`parity[${tier}]: CPU pass...`)
      if (!runHarness({ ...common, out: cdir, gpu: false })) { report.pass = false; report.problems.push(`${tier}: the CPU harness run failed`) ; continue }
      console.log(`parity[${tier}]: GPU pass (SwiftShader)...`)
      if (!runHarness({ ...common, out: gdir, gpu: true })) { report.pass = false; report.problems.push(`${tier}: the GPU harness run failed (a scene fell back to the CPU or threw)`) ; continue }
    }
    let cm = {}, gm = {}
    try { cm = Object.fromEntries(JSON.parse(fs.readFileSync(path.join(cdir, 'manifest.json'), 'utf8')).scenes.map((s) => [s.id, s])) } catch { /* handled below */ }
    try { gm = Object.fromEntries(JSON.parse(fs.readFileSync(path.join(gdir, 'manifest.json'), 'utf8')).scenes.map((s) => [s.id, s])) } catch { /* handled below */ }
    const rows = []
    for (const id of Object.keys(cm)) {
      if (!gm[id]) { report.pass = false; report.problems.push(`${tier}/${id}: missing on the GPU side`); continue }
      const a = decodePng(fs.readFileSync(path.join(cdir, cm[id].file))), b = decodePng(fs.readFileSync(path.join(gdir, gm[id].file)))
      const m = comparePair(a, b, limits)
      const bad = checkLimits(m, limits)
      if (gm[id].kind !== 'gpu') bad.push(`drawn by '${gm[id].kind}' (${gm[id].why}), not the GPU`)
      fs.writeFileSync(path.join(tdir, `${id}.side.png`), encodePng(...(() => { const s = sideBySide(a, b, { scale: panel }); return [s.width, s.height, s.data] })()))
      rows.push({ id, ...m, backend: gm[id].kind, problems: bad })
      if (bad.length) { report.pass = false; report.problems.push(`${tier}/${id}: ${bad.join('; ')}`) }
    }
    report.tiers[tier] = rows
    console.log(`\nparity[${tier}]  ${size}   limits: mean<=${limits.mean} p99<=${limits.p99} over(>${limits.thresh})<=${limits.over}`)
    console.log('  scene'.padEnd(26) + 'mean    p99     over    blockAbs corr   cpuMean(rgb)          gpuMean(rgb)')
    for (const r of rows) {
      const f = (v, w = 7) => String(v).padEnd(w)
      console.log('  ' + r.id.padEnd(24) + f(r.mean) + f(r.p99) + f(r.over) + f(r.block.meanAbs, 9) + f(r.block.corr, 7) + f(r.cpuMean.join('/'), 22) + r.gpuMean.join('/') + (r.problems.length ? '   FAIL: ' + r.problems.join('; ') : ''))
    }
    if (rows.length) {
      const avg = (k) => Math.round(rows.reduce((s, r) => s + r[k], 0) / rows.length * 10000) / 10000
      console.log(`  average: mean ${avg('mean')}  p99 ${avg('p99')}  over ${avg('over')}`)
    }
  }
  fs.writeFileSync(path.join(out, 'parity.json'), JSON.stringify(report, null, 2))
  console.log(`\nparity: ${report.pass ? 'WITHIN LIMITS' : 'OUT OF LIMITS'} -> ${path.join(out, 'parity.json')}`)
  for (const p of report.problems) console.log('  - ' + p)
  process.exit(report.pass || flags.has('no-fail') ? 0 : 1)
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main()
