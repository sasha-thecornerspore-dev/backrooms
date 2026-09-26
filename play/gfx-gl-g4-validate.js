// gfx-gl-g4-validate.js — FIRST-FRAME VALIDATION of the GPU path. A driver bug on a device we cannot test shows up as a black frame, garbage, a
// flipped or wildly different picture, a mis-exposed one, or a missing pass (no sprites, no bloom). gfx-gl.js renders ONE synthetic frame (a pose
// with a prop, a note and an npc a few cells ahead, flashlight on: syntheticFrame() below, independent of whatever is on screen) with the GPU passes
// AND with a throwaway CPU renderer (its own offscreen canvas) at the same small size, reads both back and asks compareFrames() whether they are the same picture. A mismatch THROWS GlError('validate') so renderer.js falls back to the CPU renderer
// and remembers it. A pass is remembered per (UNMASKED_RENDERER string + GPU_BUILD_ID) in localStorage AND in memory for the page session, so it
// costs one CPU frame once per device + build — and once per session even when localStorage is blocked, not at every level start.
//
// Everything here is pure or takes its dependencies as arguments (the readbacks, the storage), so it is unit-tested in Node with fakes.
import { GlError } from './gfx-gl-util.js'

// Bump when the GL passes / the validator change enough that a cached "this device renders correctly" no longer speaks for the new code.
export const GPU_BUILD_ID = 'm2-3'
export const VALIDATION_STORAGE_KEY = 'backrooms:gpu-validated'
export const VALIDATION_GRID = Object.freeze({ w: 64, h: 36 })      // the frame is compared as this many colour blocks

// Tolerances, chosen from measurements of THIS frame (tools/gfx: run.mjs --ropts '{"renderer":"gpu","gpuValidate":"measure"}' records the metrics per scene):
// 9 scenes over levels 0-3 and null at all four tiers, on SwiftShader and on the real Intel Iris Plus GPU (ANGLE D3D11): healthy worst block <= 0.057
// (mean block diff <= 0.0052, mean diff <= 0.005, corr >= 0.998); the same frame with the sprite pass drawing nothing: worst block 0.158-0.255.
// They exist to catch BROKEN frames (a missing pass, a flip, an R/B swap, a dark or over-exposed frame), not to grade the art.
export const VALIDATION_LIMITS = Object.freeze({
  meanDiff: 0.03,       // |mean GPU - mean CPU| per channel, of a 0..1 range (healthy: <= 0.005)
  blockDiff: 0.04,      // mean absolute per-block, per-channel difference (healthy: <= 0.005)
  maxBlock: 0.09,       // the WORST single block's mean absolute channel difference: a sprite-sized hole shows here and nowhere else (healthy <= 0.057, sprite-less >= 0.158)
  corr: 0.9,            // Pearson correlation of the block luminance (the picture's structure); checked when the CPU frame has structure
  relDiff: 0.25,        // the mean block difference relative to the CPU frame's own contrast (healthy: <= 0.06): the absolute limits are blind on a dim frame
  cpuStructure: 0.01,   // the CPU luminance std-dev below which a frame has no structure to correlate (a black-out, a fade)
  flatGpu: 0.004,       // a GPU frame flatter than this while the CPU frame has structure is a dead frame
  flatFrac: 0.5,        // ... or flatter than this fraction of the CPU frame's contrast
  cpuLumMin: 0.012,     // below this mean luminance AND no structure the CPU frame says nothing (black): the check is deferred to a later frame
  lumRel: 0.25,         // the GPU mean luminance may differ from the CPU's by lumRel x CPU + lumAbs (catches a dark / over-exposed frame on dim levels)
  lumAbs: 0.01,
  halfDiff: 0.03,       // a top/bottom (or left/right) luminance difference bigger than this must have the same sign on the GPU (a flip / mirror)
  chanRel: 0.15,        // the R/G and B/G mean ratios may differ by this fraction (an R/B swap on a dim frame)
  chanGMin: 0.03,       // ... when the CPU green mean is at least this
})

// Average a W x H RGBA8 image into a gw x gh grid of mean colours (0..1, r,g,b per block). `flipY` reads a bottom-up image (gl.readPixels) top-down.
// -> Float32Array(gw*gh*3). Pure; blocks may be uneven when W/H are not multiples of the grid.
export function blockMeans(rgba, w, h, gw = VALIDATION_GRID.w, gh = VALIDATION_GRID.h, flipY = false) {
  const out = new Float32Array(gw * gh * 3), cnt = new Float32Array(gw * gh)
  for (let y = 0; y < h; y++) {
    const sy = flipY ? h - 1 - y : y
    const by = Math.min(gh - 1, Math.floor(y * gh / h))
    for (let x = 0; x < w; x++) {
      const bx = Math.min(gw - 1, Math.floor(x * gw / w)), o = (sy * w + x) * 4, b = by * gw + bx
      out[b * 3] += rgba[o]; out[b * 3 + 1] += rgba[o + 1]; out[b * 3 + 2] += rgba[o + 2]; cnt[b]++
    }
  }
  for (let b = 0; b < gw * gh; b++) { const k = cnt[b] ? 1 / (cnt[b] * 255) : 0; out[b * 3] *= k; out[b * 3 + 1] *= k; out[b * 3 + 2] *= k }
  return out
}

const luma = (m, b) => 0.2126 * m[b * 3] + 0.7152 * m[b * 3 + 1] + 0.0722 * m[b * 3 + 2]

// Compare two block-mean grids (same length; `gw` = the grid's width, needed for the top/bottom and left/right halves).
// -> { ok, informative, reasons: [...], meanDiff: [r,g,b], meanAbs, maxBlock, corr, gpuStd, cpuStd, gpuMean, cpuMean, gpuLum, cpuLum }
// `informative` is false when the CPU reference is (nearly) black and flat: then nothing can be said about the GPU beyond "not bright garbage", and
// the caller should look again at a later frame instead of caching a pass.
export function compareFrames(gpu, cpu, limits = VALIDATION_LIMITS, gw = VALIDATION_GRID.w) {
  const n = Math.floor(cpu.length / 3), reasons = []
  const res = {
    ok: false, informative: true, reasons, meanDiff: [0, 0, 0], meanAbs: 0, maxBlock: 0, corr: 1, gpuStd: 0, cpuStd: 0,
    gpuMean: [0, 0, 0], cpuMean: [0, 0, 0], gpuLum: 0, cpuLum: 0,
  }
  if (!gpu || !cpu || gpu.length !== cpu.length || n === 0) { reasons.push('size'); return res }
  const gm = [0, 0, 0], cm = [0, 0, 0]
  let abs = 0, gl = 0, cl = 0, worst = 0
  for (let b = 0; b < n; b++) {
    let ba = 0
    for (let c = 0; c < 3; c++) {
      const g = gpu[b * 3 + c], q = cpu[b * 3 + c]
      if (!(g === g) || !(q === q)) { reasons.push('nan'); return res }
      gm[c] += g; cm[c] += q; ba += Math.abs(g - q)
    }
    abs += ba; ba /= 3; if (ba > worst) worst = ba
    gl += luma(gpu, b); cl += luma(cpu, b)
  }
  gl /= n; cl /= n
  let gv = 0, cv = 0, cov = 0
  for (let b = 0; b < n; b++) { const a = luma(gpu, b) - gl, c = luma(cpu, b) - cl; gv += a * a; cv += c * c; cov += a * c }
  res.gpuMean = gm.map((v) => v / n); res.cpuMean = cm.map((v) => v / n)
  res.meanDiff = res.gpuMean.map((v, i) => v - res.cpuMean[i])
  res.meanAbs = abs / (n * 3); res.maxBlock = worst
  res.gpuLum = gl; res.cpuLum = cl
  res.gpuStd = Math.sqrt(gv / n); res.cpuStd = Math.sqrt(cv / n)
  res.corr = res.gpuStd > 1e-9 && res.cpuStd > 1e-9 ? cov / n / (res.gpuStd * res.cpuStd) : 0
  res.informative = cl >= limits.cpuLumMin || res.cpuStd >= limits.cpuStructure
  if (res.meanDiff.some((d) => Math.abs(d) > limits.meanDiff)) reasons.push('mean-colour')
  if (res.meanAbs > limits.blockDiff) reasons.push('block-diff')
  if (res.maxBlock > limits.maxBlock) reasons.push('max-block')
  if (res.informative) {
    if (Math.abs(gl - cl) > limits.lumRel * cl + limits.lumAbs) reasons.push(gl < cl ? 'dark' : 'bright')
    if (res.cpuStd >= limits.cpuStructure) {
      if (res.meanAbs > limits.relDiff * res.cpuStd) reasons.push('shape')
      if (res.gpuStd < limits.flatGpu || res.gpuStd < limits.flatFrac * res.cpuStd) reasons.push('flat')
      else if (res.corr < limits.corr) reasons.push('structure')
    }
    if (gw > 0 && n % gw === 0 && n / gw >= 2) {
      const gh = n / gw, half = (m, left) => {                // mean luminance of the top / left half minus the bottom / right half
        let s = 0, k = 0
        for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
          const a = left ? x < gw / 2 : y < gh / 2, b = left ? x >= gw / 2 : y >= gh / 2
          if (a) { s += luma(m, y * gw + x); k++ } else if (b) { s -= luma(m, y * gw + x); k++ }
        }
        return k ? (s / k) * 2 : 0
      }
      const ct = half(cpu, false), gt = half(gpu, false), cl2 = half(cpu, true), gl2 = half(gpu, true)
      if (Math.abs(ct) > limits.halfDiff && ct * gt < 0) reasons.push('flip')
      else if (Math.abs(cl2) > limits.halfDiff && cl2 * gl2 < 0) reasons.push('mirror')
    }
    if (res.cpuMean[1] >= limits.chanGMin && res.gpuMean[1] > 1e-6) {
      const cr = res.cpuMean[0] / res.cpuMean[1], cb = res.cpuMean[2] / res.cpuMean[1], gr = res.gpuMean[0] / res.gpuMean[1], gb = res.gpuMean[2] / res.gpuMean[1]
      if (Math.abs(gr - cr) > limits.chanRel * cr + 0.02 || Math.abs(gb - cb) > limits.chanRel * cb + 0.02) reasons.push('channels')
    }
  }
  res.ok = reasons.length === 0
  return res
}

// ── the synthetic validation frame ──
// A pose that is known to show something: the camera is put on the best open spot within two cells of the player's own (and turned to the most open
// direction), and a prop, a note and an unnamed npc are placed 1.5-6 cells ahead of it, flashlight on: the sprite pass, its depth test against the
// column texture, the light and the post pass all show, whatever the player happened to be looking at. It is drawn in the REAL world with the REAL wall
// test, never a fake one: the light model keeps a per-cell occupancy cache, so a made-up room would poison the lighting the real frames read next. Only
// the camera and the entities are made up (a nameplate is a 2D-overlay item on the GPU and not part of the read-back, so the npc is unnamed).
// -> { player, isWall, entities, lights, flicker, fogMul }  (the arguments of render()); pure and deterministic for a given wall test.
export function syntheticFrame(px = 0, py = 0, isWallReal = null) {
  const isWall = typeof isWallReal === 'function' ? isWallReal : () => false
  const clear = (x, y, ca, sa, max) => { let d = 0; while (d < max && !isWall(x + ca * (d + 0.25), y + sa * (d + 0.25))) d += 0.25; return d }
  const cx = Math.floor(px), cy = Math.floor(py)
  let best = null
  for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
    const x = cx + dx + 0.5, y = cy + dy + 0.5
    if (isWall(x, y)) continue
    for (let k = 0; k < 16; k++) {
      const a = k * Math.PI / 8, ca = Math.cos(a), sa = Math.sin(a)
      const run = clear(x, y, ca, sa, 8)
      const score = Math.min(run, 7) + Math.min(clear(x, y, -sa, ca, 2), 1.5) + Math.min(clear(x, y, sa, -ca, 2), 1.5) - 0.05 * (Math.abs(dx) + Math.abs(dy))
      if (!best || score > best.score + 1e-9) best = { x, y, a, ca, sa, run, score }
    }
  }
  if (!best) { const a = 0; best = { x: px, y: py, a, ca: 1, sa: 0, run: 1 } }
  const player = { x: best.x, y: best.y, angle: best.a, bob: 0, bobOffset: 0, moving: false, hp: 100, maxHp: 100 }
  const entities = []
  const spots = [[0.38, -0.45, { kind: 'prop', type: 'cabinet', rot: 5.6, key: 'validate-prop' }], [0.6, 0.4, { kind: 'note', read: false, frag: 0, key: 'validate-note' }], [0.8, -0.1, { kind: 'npc', key: 'validate-npc' }]]
  spots.forEach(([f, lat, e], i) => {
    const d = Math.max(1.5 + 0.5 * i, Math.min(f * best.run, best.run - 0.9))
    for (const l of [lat, 0]) {
      const x = best.x + best.ca * d - best.sa * l, y = best.y + best.sa * d + best.ca * l
      if (!isWall(x, y)) { entities.push({ x, y, ...e }); break }
    }
  })
  return { player, isWall, entities, lights: { flashlight: true }, flicker: 1, fogMul: 1 }
}

// ── settling a frame before it is compared ──
// Both renderers build sprite frames lazily under a per-call time budget (gfx-sprites.js / gfx-gl-sprites-plan.js: ~9 ms, then a missing frame
// waits for a later call). On a cold start or a busy device the FIRST synthetic frame of either side can therefore lack a sprite the other side has,
// and that reads exactly like a broken sprite pass (a sprite-sized worst block) — a false failure that would ban a healthy GPU for a day. So each
// side is drawn until two consecutive pictures are byte-identical (every frame it needs is built; nothing in the synthetic frame animates between
// calls: fixed clock, no grain, no particles), at most `tries` times. drawAndRead() -> { data (bytes), ... }; its data may be a reused buffer.
// -> { frame (the last result), draws, stable }
export const SETTLE_TRIES = 6
export function settleFrame(drawAndRead, tries = SETTLE_TRIES) {
  let prev = null, fr = null, n = 0
  while (n < tries) {
    fr = drawAndRead(); n++
    const d = fr && fr.data
    if (prev && d && d.length === prev.length) {
      let same = true
      for (let i = 0; i < d.length; i++) if (d[i] !== prev[i]) { same = false; break }
      if (same) return { frame: fr, draws: n, stable: true }
    }
    prev = d ? d.slice() : null
  }
  return { frame: fr, draws: n, stable: false }
}

// ── the per-device cache ──
const SESSION_OK = new Set()      // keys validated in THIS page session: a blocked / full localStorage must not re-run the check at every level start
export function markSessionValidated(key) { if (key) SESSION_OK.add(key) }
export function sessionValidated(key) { return !!key && SESSION_OK.has(key) }
export function resetSessionValidation() { SESSION_OK.clear() }        // tests only

export function validationCacheKey(unmaskedRenderer, buildId = GPU_BUILD_ID) { return `${String(unmaskedRenderer || 'unknown')}|${buildId}` }
// The device cache keeps the last few validated (device, build) keys, not one: a laptop that alternates its iGPU and dGPU must not re-validate at every switch.
export const VALIDATION_KEYS_KEPT = 4
export function readValidationCache(storage, key) {
  try {
    const v = JSON.parse(storage.getItem(VALIDATION_STORAGE_KEY) || 'null')
    return !!v && v.ok === true && (v.key === key || (Array.isArray(v.keys) && v.keys.includes(key)))
  } catch { return false }
}
export function writeValidationCache(storage, key) {
  try {
    let prev = []
    try { const v = JSON.parse(storage.getItem(VALIDATION_STORAGE_KEY) || 'null'); if (v && v.ok === true) prev = [v.key, ...(Array.isArray(v.keys) ? v.keys : [])].filter((k) => typeof k === 'string') } catch { /* start fresh */ }
    const keys = [key, ...prev.filter((k) => k !== key)].slice(0, VALIDATION_KEYS_KEPT)
    storage.setItem(VALIDATION_STORAGE_KEY, JSON.stringify({ key, ok: true, keys }))
  } catch { /* private mode: the in-memory flag still holds for this session */ }
}

// Should the check run at all? ropts.gpuValidate (only ever passed on by gfx-gl.js in a test run): true = always (harness/tests), false = never;
// unset = yes on real hardware unless this session or the device cache already passed, no on the harness's software GL (which is the CPU's own
// pixels' worst case and never a production path).
export function validationWanted({ ropts, allowSoftware, storage, key }) {
  if (ropts && ropts.gpuValidate === false) return false
  if (ropts && ropts.gpuValidate === true) return true
  if (allowSoftware) return false
  if (sessionValidated(key)) return false
  return !(storage && readValidationCache(storage, key))
}

// Run the check. readGpu() -> { data, w, h, flipY } (the GL frame's RGBA8 readback); renderCpu() -> { data, w, h } (the reference frame).
// Both are supplied by gfx-gl.js (or fakes). Returns { ok, deferred, metrics }; throws GlError('validate') on a mismatch. A pass is recorded (device
// cache + session) on success unless the reference was uninformative (`deferred`: nothing recorded, the caller tries a later frame).
export function runFirstFrameValidation({ readGpu, renderCpu, storage = null, key = null, limits = VALIDATION_LIMITS, grid = VALIDATION_GRID }) {
  const g = readGpu(), c = renderCpu()
  const metrics = compareFrames(blockMeans(g.data, g.w, g.h, grid.w, grid.h, !!g.flipY), blockMeans(c.data, c.w, c.h, grid.w, grid.h, false), limits, grid.w)
  if (!metrics.ok) {
    const f = (v) => (Math.round(v * 1000) / 1000)
    const err = new GlError('validate', `the GPU frame does not match the CPU reference (${metrics.reasons.join(', ')}; mean gpu=${metrics.gpuMean.map(f)} cpu=${metrics.cpuMean.map(f)}, block diff ${f(metrics.meanAbs)}, worst block ${f(metrics.maxBlock)}, corr ${f(metrics.corr)})`)
    err.metrics = metrics
    throw err
  }
  if (!metrics.informative) return { ok: true, deferred: true, metrics }
  markSessionValidated(key)
  if (storage && key) writeValidationCache(storage, key)
  return { ok: true, deferred: false, metrics }
}
