// gfx-bench.js — the ?gfxbench=1 device benchmark: about a minute that says how fast THIS device draws the game with each renderer, so the
// GPU_AUTO decision (renderer.js) can be made from real Chromebooks and phones (docs/gfx-device-testing.md). index.html enters it INSTEAD of the
// title and the game when the URL carries the parameter.
//
// What it does: five fixed views of the real world (Level 0 corridor and room, Level 2 pipes, Level 3 station, the Level ∅ yard; the same
// seeded chunks, decor and creatures the harness scenes use — nothing moves, nothing attacks), each drawn full-window for ~2 s along a smooth
// camera path (a slow walk forward while looking left and right; gentler still under prefers-reduced-motion or the game's Reduce flicker
// setting), once per configuration:
//     CPU low · CPU medium · CPU high · GPU medium · GPU high        (the GPU ones only if the GPU path comes up; otherwise it says why)
// It records the REAL display frame interval (requestAnimationFrame timestamps: p50 / p95 / p99, % of frames slower than 33 ms) and what the
// render() call costs on the CPU, then shows a results card — device facts, a table, a plain-language verdict, the GPU_AUTO checks — with a
// Copy button that puts the whole result on the clipboard as text.
//
// SAFETY. It never writes the player's save, prefs or progress (it imports none of save.js / prefs.js / game.js, plays no audio; the in-game
// reduce-flicker setting is only READ, for the camera path). The only renderer state it touches is the GPU crash-loop marker: a GPU start arms
// it exactly as in the game (a device that dies mid-benchmark is protected next time) and each renderer gives it back or clears it itself. When
// the run ends — finished, interrupted or failed — createMarkerGuard puts the marker back EXACTLY as the run found it (a tripped crash loop stays
// tripped, a pre-existing count stays), unless one of the run's own GPU starts failed in a way the game remembers (renderer.js wrote the 24 h
// block): that stays recorded. The benchmark never clears a marker. The GPU's first-frame validation result is kept in memory only, so it always
// runs here and is never cached for the game. Flicker is the level's own, through the rate-limited machine with reduceFlicker on (no flash,
// WCAG 2.3.1); scene changes fade through black; creatures stand still.
//
// Everything above the "browser" banner is pure and unit-tested in Node (test/gfx-hc-bench.test.js): the plan, the statistics, the camera path,
// the verdict and the text report.
import { createRendererWith, GPU_MARKER_KEY } from './renderer.js'
import { createGlRenderer } from './gfx-gl.js'
import { probeGl } from './gfx-gl-util.js'
import { isSoftwareGl, createFlickerState, stepFlicker, DEFAULT_MAX_GLOBAL_DIP, qualityFor } from './gfx-quality.js'
import { GPU_BUILD_ID } from './gfx-gl-g4-validate.js'
import { loadConfig, createChunkCache, CHUNK_SIZE } from './world.js'
import { createFixedMap } from './fixedmap.js'
import { levelConfig } from './levels.js'
import { createDecorSystem } from './decor.js'
import { createItemSystem } from './items.js'
import { createEntitySystem } from './entities.js'
import { mulberry32 } from './gfx-util.js'

// ═══════════════════════════════════════════════════════════ pure ═══════════════════════════════════════════════════════════

export const BENCH_VERSION = 1
export const BENCH_SEED = 0              // the canonical seed-0 world the harness scenes are posed in (tools/gfx/scenes.js WORLD_SEED)

// The views (poses from tools/gfx/scenes.js, angles in degrees: 0 = east, 90 = south). `extra` = a still creature placed like the harness does.
export const BENCH_SCENES = Object.freeze([
  { id: 'l0-corridor', label: 'level 0 corridor', level: 0, x: 11.5, y: 19.5, angle: 90 },
  { id: 'l0-room', label: 'level 0 room', level: 0, x: 18.0, y: 26.0, angle: -45 },
  { id: 'l2-pipes', label: 'level 2 pipes', level: 2, x: 33.5, y: -3.5, angle: 270, extra: { variant: 'lurker', x: 34.5, y: -8.5 } },
  { id: 'l3-station', label: 'level 3 station', level: 3, x: -4.5, y: -10.5, angle: 180, extra: { variant: 'tesla', x: -7.5, y: -11.9 } },
  { id: 'lnull-yard', label: 'level ∅ yard', level: 4, x: 12.5, y: 13.0, angle: 90 },
].map(Object.freeze))

export const BENCH_CONFIGS = Object.freeze([
  { id: 'cpu-low', label: 'CPU low', backend: 'cpu', tier: 'low' },
  { id: 'cpu-medium', label: 'CPU medium', backend: 'cpu', tier: 'medium' },
  { id: 'cpu-high', label: 'CPU high', backend: 'cpu', tier: 'high' },
  { id: 'gpu-medium', label: 'GPU medium', backend: 'gpu', tier: 'medium' },
  { id: 'gpu-high', label: 'GPU high', backend: 'gpu', tier: 'high' },
].map(Object.freeze))

// Per view: frames drawn but not counted until BOTH warmMs have passed and warmFrames were drawn (the renderer's first frames, shader
// compiles, the GPU's validation on its 4th render, the fade in) — their worst cost is reported separately as the start cost — then measureMs
// that are counted; fadeMs of fade to black between views. capMs bounds a view that never gets going. 'quick' is for the harness only.
export function benchTiming(mode) {
  return mode === 'quick' ? { warmMs: 250, warmFrames: 6, measureMs: 500, fadeMs: 120, idleFrames: 20, capMs: 6000 }
    : { warmMs: 450, warmFrames: 6, measureMs: 1700, fadeMs: 260, idleFrames: 60, capMs: 10000 }
}
// ?gfxbench=1 -> 'full', ?gfxbench=quick -> 'quick', absent -> null
export function benchMode(search) {
  try {
    const p = typeof search === 'string' ? new URLSearchParams(search) : search
    const v = p && p.get ? p.get('gfxbench') : null
    if (v === null || v === undefined || /^(0|false|off|no)$/i.test(v)) return null
    return v === 'quick' ? 'quick' : 'full'
  } catch { return null }
}
// the configurations x views, in the order they run (every CPU config first: they always exist; then the GPU ones)
export function benchPlan(configs = BENCH_CONFIGS, scenes = BENCH_SCENES) {
  const out = []
  for (const c of configs) for (const s of scenes) out.push({ config: c, scene: s })
  return out
}
// seconds the whole run takes (not counting renderer creation and world building)
export function benchSeconds(mode, plan = benchPlan()) {
  const t = benchTiming(mode)
  return (plan.length * (t.warmMs + t.measureMs + t.fadeMs)) / 1000 + t.idleFrames / 60
}

// nearest-rank percentile of an ascending array
export function pct(sorted, p) {
  const n = sorted.length
  if (n === 0) return NaN
  return sorted[Math.min(n - 1, Math.max(0, Math.ceil(p * n) - 1))]
}
const r2 = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : NaN)
// intervals: display frame intervals (ms); costs: render() CPU ms of the same frames
export function summarize(intervals, costs) {
  const a = Array.from(intervals).filter((v) => v >= 0).sort((x, y) => x - y)
  const b = Array.from(costs).filter((v) => v >= 0).sort((x, y) => x - y)
  const slow = a.reduce((k, v) => k + (v > 33.4 ? 1 : 0), 0)
  const mean = a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN
  return {
    frames: a.length, mean: r2(mean), p50: r2(pct(a, 0.5)), p95: r2(pct(a, 0.95)), p99: r2(pct(a, 0.99)), over33: a.length ? r2(slow / a.length) : 0,
    costP50: r2(pct(b, 0.5)), costP95: r2(pct(b, 0.95)),
  }
}
// the display's frame period from idle requestAnimationFrame intervals (the median ignores the odd late frame)
export function displayPeriod(intervals) {
  const a = Array.from(intervals).filter((v) => v > 2 && v < 200).sort((x, y) => x - y)
  return a.length ? r2(pct(a, 0.5)) : NaN
}

// How far one can walk from (x, y) along `angle` (radians) before a wall cell, up to `max` cells.
export function freeRun(isWall, x, y, angle, max = 4, step = 0.05) {
  const dx = Math.cos(angle), dy = Math.sin(angle)
  for (let d = step; d <= max; d += step) if (isWall(Math.floor(x + dx * d), Math.floor(y + dy * d))) return Math.max(0, d - step)
  return max
}
// The camera path of one view: a slow walk along the view's facing (eased in and out over the whole segment, stopping well short of any wall)
// while the view pans left and right on a sine. Reduced motion: a third of the walk, a smaller, slower pan. Smooth everywhere (no cuts, no
// jumps). scene.angle in degrees; free = freeRun along it (cells); durS = the segment length (s). -> (tSeconds) -> { x, y, angle (radians) }
export const PATH = Object.freeze({ walkMax: 1.8, walkMaxReduced: 0.6, clearance: 0.6, pan: 28, panReduced: 10, panPeriod: 4.5, panPeriodReduced: 9 })
export function cameraPath(scene, free, durS, reduced = false) {
  const a0 = (scene.angle * Math.PI) / 180
  const walk = Math.max(0, Math.min(reduced ? PATH.walkMaxReduced : PATH.walkMax, (free || 0) - PATH.clearance))
  const pan = ((reduced ? PATH.panReduced : PATH.pan) * Math.PI) / 180, per = reduced ? PATH.panPeriodReduced : PATH.panPeriod
  const dx = Math.cos(a0), dy = Math.sin(a0), T = durS > 0 ? durS : 1
  return (t) => {
    const u = Math.min(1, Math.max(0, t / T)), e = u * u * (3 - 2 * u)            // smoothstep: starts and ends at rest
    const d = walk * e
    return { x: scene.x + dx * d, y: scene.y + dy * d, angle: a0 + pan * Math.sin((2 * Math.PI * Math.max(0, t)) / per) }
  }
}

// Reduced motion for the camera path: the OS query OR the game's own Reduce flicker setting (the game treats it as reduced motion too, as does the
// title's attract mode). The setting is READ from the stored prefs JSON (prefs.js is not imported: nothing here may write it); a player who never
// chose it has no stored value, and the game's default for it IS the OS query.
export const PREFS_KEY = 'backrooms:prefs'           // prefs.js KEY (a test checks they match)
export function benchReducedMotion(osReduced, storedPrefsJson) {
  if (osReduced) return true
  try { const p = JSON.parse(storedPrefsJson); return !!p && typeof p === 'object' && p.reduceFlicker === true } catch { return false }
}

const f1 = (v) => (Number.isFinite(v) ? v.toFixed(1) : '-')
const pctStr = (v) => (Number.isFinite(v) ? `${Math.round(v * 100)}%` : '-')

// The plain-language verdict and the GPU_AUTO checks for ONE device.
// rep = { configs: [{ id, tier, backend, status, why, validation, frames, p95, over33, costP50, ... }], display: { periodMs }, gpu: { webgl2,
//         software, reason, renderer }, fallbacks }
// -> { line, kind ('gpu-faster'|'same-rate'|'same'|'gpu-slower'|'no-gpu'|'incomplete'), cpuAdvice, checks: [{ name, ok, note }], gpuAutoOk }
export const VERDICT = Object.freeze({ faster: 0.85, slower: 1.15, holdSlack: 1.25, notSlower: 1.05, over33Slack: 0.01 })
export function benchVerdict(rep) {
  const configs = (rep && rep.configs) || []
  const C = (id) => configs.find((c) => c.id === id) || null
  const ok = (c) => !!c && c.status === 'ok' && c.frames > 0 && Number.isFinite(c.p95)
  const period = rep && rep.display && rep.display.periodMs > 0 ? rep.display.periodMs : 1000 / 60
  const holds = (c) => ok(c) && c.p95 <= period * VERDICT.holdSlack + 1 && c.over33 <= 0.02
  const holds30 = (c) => ok(c) && c.p95 <= 34 && c.over33 <= 0.05

  const cpuTiers = ['high', 'medium', 'low'].map((t) => C(`cpu-${t}`))
  const cHold = cpuTiers.find(holds), c30 = cpuTiers.find(holds30)
  const cpuAdvice = cHold ? `the CPU renderer keeps the display rate up to ${cHold.tier}`
    : c30 ? `the CPU renderer holds 30 fps up to ${c30.tier}` : 'the CPU renderer does not hold 30 fps at any tier here'

  const cm = C('cpu-medium'), gm = C('gpu-medium'), gh = C('gpu-high')
  const gpuCfgs = [gm, gh].filter(Boolean)
  const gpuOk = gpuCfgs.filter(ok)
  const gpuInfo = (rep && rep.gpu) || {}
  const fellBack = gpuCfgs.some((c) => c.status === 'fell-back')
  const fallbacks = (rep && rep.fallbacks) | 0
  const validation = gpuCfgs.map((c) => c.validation).find((v) => v === 'passed' || v === 'failed') || gpuCfgs.map((c) => c.validation).find(Boolean) || '-'

  let line, kind
  if (gpuOk.length === 0) {
    const why = (gpuCfgs.find((c) => c.why) || {}).why || gpuInfo.reason || 'not tried'
    kind = 'no-gpu'
    line = fellBack ? `GPU not usable: it fell back to the CPU (${why})` : `GPU not available: ${why}`
  } else if (!ok(cm)) {
    kind = 'incomplete'; line = 'CPU medium could not be measured, so there is nothing to compare the GPU with'
  } else {
    // the better GPU tier by p95 (high wins a near tie: it is the one worth having)
    const best = gpuOk.length === 2 ? (gh.p95 <= gm.p95 * 1.05 ? gh : gm) : gpuOk[0]
    const ratio = cm.p95 / best.p95
    const vs = `p95 frame ${f1(best.p95)} ms vs ${f1(cm.p95)} ms`
    if (best.p95 <= cm.p95 * VERDICT.faster) { kind = 'gpu-faster'; line = `GPU ${best.tier} is ${ratio.toFixed(1)}x faster than CPU medium here (${vs})` }
    else if (holds(cm) && holds(best)) { kind = 'same-rate'; line = `CPU medium and GPU ${best.tier} both keep the display rate here (~${f1(period)} ms); render() costs the CPU ${f1(best.costP50)} ms on the GPU path vs ${f1(cm.costP50)} ms` }
    else if (best.p95 >= cm.p95 * VERDICT.slower) { kind = 'gpu-slower'; line = `GPU ${best.tier} is slower than CPU medium here (${vs}): keep the CPU renderer` }
    else { kind = 'same'; line = `GPU ${best.tier} and CPU medium are about the same here (${vs})` }
  }

  const checks = [
    { name: 'hardware GPU', ok: !!gpuInfo.webgl2 && !gpuInfo.software, note: gpuInfo.software ? `software (${gpuInfo.renderer || '?'})` : gpuInfo.webgl2 ? (gpuInfo.renderer || '?') : (gpuInfo.reason || 'no WebGL2') },
    { name: 'GPU path came up', ok: gpuCfgs.length > 0 && gpuCfgs.every(ok), note: gpuCfgs.map((c) => `${c.label || c.id} ${c.status}${c.why ? ` (${c.why})` : ''}`).join(', ') || 'not tried' },
    { name: 'first-frame validation passed', ok: validation === 'passed', note: validation },
    { name: 'no GPU fallbacks', ok: fallbacks === 0 && !fellBack, note: String(fallbacks) },
    {
      name: 'GPU medium not slower than CPU medium',
      ok: ok(gm) && ok(cm) && gm.p95 <= cm.p95 * VERDICT.notSlower + 0.5 && gm.over33 <= cm.over33 + VERDICT.over33Slack,
      note: ok(gm) && ok(cm) ? `p95 ${f1(gm.p95)} vs ${f1(cm.p95)} ms, >33ms ${pctStr(gm.over33)} vs ${pctStr(cm.over33)}` : 'not measured',
    },
  ]
  return { line, kind, cpuAdvice, checks, gpuAutoOk: checks.every((c) => c.ok) }
}

// The whole result as plain text (the Copy button; the owner pastes it back).
export function formatReport(rep) {
  const d = rep.device || {}, g = rep.gpu || {}, v = rep.verdict || benchVerdict(rep)
  const L = []
  L.push(`BACKROOMS GFX BENCH v${BENCH_VERSION} · build ${rep.build || '?'} · ${rep.date || ''}${rep.mode === 'quick' ? ' · QUICK (harness)' : ''}${rep.interrupted ? ' · INTERRUPTED' : ''}`)
  L.push(`device: ${d.ua || '?'}`)
  L.push(`cores ${d.cores ?? '?'} · memory ${d.memory ?? '?'} GB · dpr ${d.dpr ?? '?'} · screen ${d.screen || '?'} · window ${d.window || '?'} · touch ${d.touch ? 'yes' : 'no'} · reduced motion ${d.reducedMotion ? 'yes' : 'no'}`)
  L.push(`display: ~${f1(rep.display && rep.display.periodMs)} ms per frame (${rep.display && rep.display.periodMs > 0 ? Math.round(1000 / rep.display.periodMs) : '?'} Hz)`)
  L.push(`gpu: ${g.renderer || '(no renderer string)'} · webgl2 ${g.webgl2 ? 'yes' : 'no'} · probe says ${g.software ? 'SOFTWARE' : g.webgl2 ? 'hardware' : '-'} (${g.reason || '-'})`)
  L.push('')
  L.push('config       status        frames   p50    p95    p99   >33ms   render p50 / p95   internal')
  for (const c of rep.configs || []) {
    const st = c.status + (c.status !== 'ok' && c.why ? ` (${c.why})` : '')
    if (c.status !== 'ok' && !(c.frames > 0)) { L.push(`${(c.label || c.id).padEnd(12)} ${st}`); continue }
    L.push(`${(c.label || c.id).padEnd(12)} ${st.padEnd(13)} ${String(c.frames).padStart(6)} ${f1(c.p50).padStart(6)} ${f1(c.p95).padStart(6)} ${f1(c.p99).padStart(6)} ${pctStr(c.over33).padStart(6)}   ${f1(c.costP50).padStart(6)} / ${f1(c.costP95).padEnd(6)} ms  ${c.internal || '-'} · start ${Number.isFinite(c.startMs) ? c.startMs : '-'} ms${c.backend === 'gpu' ? ` · validation ${c.validation || '-'}` : ''}`)
  }
  L.push('')
  L.push(`verdict: ${v.line}`)
  L.push(`cpu: ${v.cpuAdvice}`)
  L.push(`GPU_AUTO checks: ${v.gpuAutoOk ? 'ALL PASS' : 'not all pass'}`)
  for (const c of v.checks) L.push(`  [${c.ok ? 'x' : ' '}] ${c.name}: ${c.note}`)
  return L.join('\n')
}

// The GPU crash-loop marker around one benchmark run. storage() -> a localStorage-like (or null / throws: private mode, nothing to guard).
//   const g = createMarkerGuard(storage)       BEFORE the first GPU start: remembers the stored value as it is (the raw string, or null)
//   g.note(renderer)                           every renderer the run built (before it is disposed): a persisted failure (renderer.failure) counts
//   g.finish()                                 -> 'kept-failure' (a failure of THIS run is recorded: left alone), 'unchanged' or 'restored'
// So a tripped crash loop (the GPU never starts) or a pre-existing count stays exactly as it was, whatever the run's own healthy GPU frames did.
export function createMarkerGuard(storage, key = GPU_MARKER_KEY) {
  const store = () => { try { return storage() || null } catch { return null } }
  const read = () => { try { const s = store(); return s ? s.getItem(key) : null } catch { return null } }
  const before = read()
  let failed = null, done = null
  return {
    get before() { return before },
    get failed() { return failed },
    note(r) { const f = r && r.failure; if (f && f.persisted && !failed) failed = f },
    finish() {
      if (done) return done
      if (failed) return (done = 'kept-failure')
      if (read() === before) return (done = 'unchanged')
      try { const s = store(); if (s) { if (before === null) s.removeItem(key); else s.setItem(key, before) } } catch { /* private mode */ }
      return (done = 'restored')
    },
  }
}

// ═══════════════════════════════════════════════════════════ browser ═══════════════════════════════════════════════════════════
// Nothing below runs at import time.

const CSS = `
#gfx-bench-veil { position: fixed; inset: 0; background: #000; opacity: 1; pointer-events: none; z-index: 60; transition: opacity 0.3s; }
#gfx-bench-status { position: fixed; left: 12px; bottom: 12px; z-index: 61; pointer-events: none; font: 12px/1.4 'Courier New', monospace;
  color: #eef0e6; background: rgba(0,0,0,0.74); padding: 4px 8px; border: 1px solid rgba(255,255,255,0.18); white-space: pre; }
#gfx-bench { position: fixed; inset: 0; z-index: 70; display: flex; align-items: center; justify-content: center; padding: 16px;
  background: radial-gradient(120% 90% at 50% 34%, #241d0c 0%, #0e0c07 66%); overflow: auto; }
#gfx-bench .card { width: min(880px, 100%); max-height: 100%; overflow: auto; background: #15110a; color: #e7dcb2; font: 13px/1.6 'Courier New', monospace;
  border: 1px solid #6a5424; outline: 1px solid rgba(200,184,112,0.2); outline-offset: -5px; box-shadow: 0 12px 40px rgba(0,0,0,0.6); padding: 22px 20px; }
#gfx-bench h1 { font-size: 16px; letter-spacing: 0.24em; color: #efe7c4; margin-bottom: 12px; font-weight: 700; }
#gfx-bench p { margin: 8px 0; max-width: 70ch; }
#gfx-bench .verdict { color: #efe7c4; font-weight: 700; border-left: 3px solid #a8d4ec; padding-left: 10px; }
#gfx-bench .table { overflow-x: auto; margin: 12px 0; }
#gfx-bench table { border-collapse: collapse; font-size: 12px; white-space: nowrap; }
#gfx-bench th, #gfx-bench td { padding: 3px 9px 3px 0; text-align: right; border-bottom: 1px solid rgba(200,184,112,0.16); }
#gfx-bench th:first-child, #gfx-bench td:first-child, #gfx-bench td.st { text-align: left; }
#gfx-bench th { color: #b9ad83; font-weight: 400; }
#gfx-bench td.bad { color: #f0b49a; }
#gfx-bench pre { white-space: pre-wrap; word-break: break-word; font-size: 11.5px; color: #cfc4a0; background: rgba(0,0,0,0.3); padding: 8px 10px; margin: 10px 0; }
#gfx-bench .gb-btns { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 14px; }
#gfx-bench button, #gfx-bench a.btn { font: 700 13px 'Courier New', monospace; letter-spacing: 0.18em; padding: 10px 16px; cursor: pointer; text-decoration: none;
  color: #191305; background: linear-gradient(180deg, #c8b870, #94824a); border: 1px solid #3a2c17; }
#gfx-bench a.btn.quiet, #gfx-bench button.quiet { color: #efe7c4; background: rgba(14,12,7,0.74); border-color: #8a7a3a; }
#gfx-bench button:focus-visible, #gfx-bench a.btn:focus-visible { outline: 2px solid #efe7c4; outline-offset: 3px; }
#gfx-bench .ok { color: #9fd49a; } #gfx-bench .no { color: #f0b49a; }
`

// a localStorage-like that lives in memory: the GPU validation result must not be cached for the game by a benchmark run
function memStorage() {
  const m = new Map()
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)) }, removeItem: (k) => { m.delete(k) } }
}
const nowMs = () => performance.now()
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

// the world of one view, built once and shared by every configuration (the same chunks, decor and creatures each time). No DOM: tested in Node.
export function buildView(base, scene) {
  const cfg = levelConfig(base, scene.level)
  const cache = cfg.map ? createFixedMap(cfg.map) : createChunkCache(cfg, BENCH_SEED)
  cache.preload(0, 0)
  const hooks = cfg.map ? { materialAt: (wx, wy) => cache.materialAt(wx, wy) } : {}
  const pcx = Math.floor(scene.x / CHUNK_SIZE), pcy = Math.floor(scene.y / CHUNK_SIZE)
  const isWallAt = (wx, wy) => cache.isWall(wx, wy, pcx, pcy)
  const itemSys = createItemSystem(base, isWallAt, BENCH_SEED)
  const decor = createDecorSystem(cfg, isWallAt, BENCH_SEED)
  itemSys.enterLevel(cfg)
  decor.update(0, 0); itemSys.update(0, 0)
  cache.preload(pcx, pcy); itemSys.update(pcx, pcy); decor.update(pcx, pcy)
  const esys = createEntitySystem(cfg, isWallAt)
  const player0 = { x: scene.x, y: scene.y, angle: (scene.angle * Math.PI) / 180, bob: 0, bobOffset: 0, moving: false, hp: 100, maxHp: 100 }
  if (cfg.entities && cfg.entities.enabled) esys.update(0, player0, pcx, pcy, 1)       // dt = 0: placed by the spawn hash, never walking
  const ex = scene.extra
  // the same flat list (and order) game.js hands the renderer: enemies, npcs, props, exits, items, notes, machines, sights
  const entities = [
    ...esys.getEntities(),
    ...(ex ? [{ x: ex.x, y: ex.y, type: 'stalker', variant: ex.variant, state: 'idle', dir: 0, dirTimer: 4, stagger: 0, wardHits: 0, chunkCx: Math.floor(ex.x / 22), chunkCy: Math.floor(ex.y / 22) }] : []),
    ...decor.getNpcs().map((n) => ({ x: n.x, y: n.y, kind: 'npc', name: 'a lost soul', key: n.key })),
    ...decor.getProps().map((p) => ({ x: p.x, y: p.y, kind: 'prop', type: p.type, rot: p.rot, key: p.key })),
    ...decor.getExits().map((e) => ({ x: e.x, y: e.y, kind: 'exit', target: e.target, key: e.key })),
    ...itemSys.getWorldItems().map((it) => ({ x: it.x, y: it.y, kind: 'item', itemType: it.type, key: it.key })),
    ...decor.getScraps().map((s) => ({ x: s.x, y: s.y, kind: 'note', read: false, frag: s.frag, key: s.key })),
    ...decor.getMachines().map((m) => ({ x: m.x, y: m.y, kind: 'machine', vended: false, key: m.key })),
    ...decor.getSights().map((s) => ({ x: s.x, y: s.y, kind: 'sight', sightType: s.type, key: s.key })),
  ]
  const free = freeRun((cx, cy) => cache.isWall(cx, cy, pcx, pcy), scene.x, scene.y, player0.angle)
  return { scene, cfg, cache, hooks, entities, free }
}

// startBench(doc, win, { mode }) — takes over the page (index.html has already hidden the title). Resolves when the page is set up; the run
// itself starts from the START button.
export async function startBench(doc, win, opts = {}) {
  const mode = opts.mode === 'quick' ? 'quick' : 'full'
  const timing = benchTiming(mode)
  const canvas = opts.canvas || doc.getElementById('c')
  const style = doc.createElement('style'); style.textContent = CSS; doc.head.appendChild(style)
  for (const id of ['btn-settings', 'hud-cluster', 'hint']) { const el = doc.getElementById(id); if (el) el.style.display = 'none' }
  const root = doc.createElement('div'); root.id = 'gfx-bench'; doc.body.appendChild(root)
  const reduced = benchReducedMotion(
    (() => { try { return !!win.matchMedia('(prefers-reduced-motion: reduce)').matches } catch { return false } })(),
    (() => { try { return win.localStorage.getItem(PREFS_KEY) } catch { return null } })())
  // test-harness hooks (tools/gfx/page.cjs --ropts): only in a marked test run, exactly as game.js reads them; the bench picks `renderer` itself
  let harness = {}
  try { const dbg = globalThis.__backroomsRenderOpts; if (dbg && typeof dbg === 'object' && globalThis.__backroomsTestRun === true) { harness = { ...dbg }; delete harness.renderer } } catch { /* ignore */ }
  const backUrl = (() => { try { const u = new URL(win.location.href); u.searchParams.delete('gfxbench'); return u.href } catch { return './' } })()

  function intro() {
    root.innerHTML = `<div class="card" role="dialog" aria-label="graphics benchmark">
      <h1>GRAPHICS BENCHMARK</h1>
      <p>This measures how fast this device draws the game with each renderer (CPU at low, medium and high; the GPU at medium and high if it can
      start). It takes about ${Math.round(benchSeconds(mode) / 5) * 5 || 1} seconds. It does not touch your saved game or your settings.</p>
      <p>Plug the device in if you can, close other tabs, and do not switch away while it runs: the scene moves slowly and the screen fades to
      black between views. At the end you get a table and a <b>Copy</b> button; paste the result back to whoever asked.</p>
      <div class="gb-btns"><button id="gfx-bench-start">START ▶</button><a class="btn quiet" href="${esc(backUrl)}">BACK TO THE GAME</a></div>
    </div>`
    root.style.display = 'flex'
    doc.getElementById('gfx-bench-start').addEventListener('click', () => { run().catch((e) => fail(e)) })
  }
  function fail(e) {
    root.innerHTML = `<div class="card"><h1>BENCHMARK FAILED</h1><pre>${esc((e && (e.stack || e.message)) || e)}</pre>
      <div class="gb-btns"><button id="gfx-bench-again">RUN AGAIN</button><a class="btn quiet" href="${esc(backUrl)}">BACK TO THE GAME</a></div></div>`
    root.style.display = 'flex'
    doc.getElementById('gfx-bench-again').addEventListener('click', () => { run().catch((err) => fail(err)) })
  }

  const raf = (fn) => win.requestAnimationFrame(fn)
  const sleep = (ms) => new Promise((r) => win.setTimeout(r, ms))
  const nextFrames = (n) => new Promise((res) => { const ts = []; const f = (t) => { ts.push(t); if (ts.length > n) res(ts); else raf(f) }; raf(f) })

  let running = false
  async function run() {
    if (running) return
    running = true
    root.style.display = 'none'; root.innerHTML = ''
    const veil = doc.createElement('div'); veil.id = 'gfx-bench-veil'; doc.body.appendChild(veil)
    const status = doc.createElement('div'); status.id = 'gfx-bench-status'; status.setAttribute('aria-live', 'polite'); doc.body.appendChild(status)
    veil.style.transition = `opacity ${timing.fadeMs / 1000}s`
    let interrupted = false
    const onVis = () => { if (doc.hidden) interrupted = true }
    doc.addEventListener('visibilitychange', onVis)
    const cleanup = () => { doc.removeEventListener('visibilitychange', onVis); veil.remove(); status.remove() }
    // the crash marker as this run found it (read before the first GPU start); settled at the end however the run ends
    const marker = createMarkerGuard(() => win.localStorage)
    let lastR = null
    const settleMarker = () => { if (lastR) { marker.note(lastR); try { lastR.dispose() } catch { /* ignore */ } } return marker.finish() }
    try {
      status.textContent = 'preparing the views…'
      const base = await loadConfig()
      const views = BENCH_SCENES.map((s) => buildView(base, s))
      // device facts and the GPU probe (a throwaway context; the renderer factory below probes again for itself)
      const probe = probeGl(() => doc.createElement('canvas'), { allowSoftware: false })
      const nav = win.navigator || {}, scr = win.screen || {}
      const rep = {
        version: BENCH_VERSION, build: GPU_BUILD_ID, date: new Date().toISOString(), mode, interrupted: false,
        device: {
          ua: nav.userAgent, cores: nav.hardwareConcurrency ?? null, memory: nav.deviceMemory ?? null, dpr: win.devicePixelRatio,
          screen: `${scr.width}x${scr.height}`, window: `${win.innerWidth}x${win.innerHeight}`, touch: (nav.maxTouchPoints | 0) > 0, reducedMotion: reduced,
        },
        gpu: { renderer: probe.unmaskedRenderer, webgl2: !!probe.webgl2, software: !!(probe.majorPerformanceCaveat || isSoftwareGl(probe.unmaskedRenderer)), reason: probe.reason },
        display: { periodMs: NaN }, configs: [], fallbacks: 0,
      }
      status.textContent = 'measuring the display…'
      const idle = await nextFrames(timing.idleFrames)
      rep.display.periodMs = displayPeriod(idle.slice(1).map((t, i) => t - idle[i]))

      // one view under one configuration
      async function runSegment(conf, view) {
        canvas.width = Math.max(1, win.innerWidth | 0); canvas.height = Math.max(1, win.innerHeight | 0)
        canvas.style.width = ''; canvas.style.height = ''
        const ro = {
          grain: true, particles: true, crosshair: true, reduceFlicker: true, maxGlobalDip: DEFAULT_MAX_GLOBAL_DIP,
          ...harness, renderer: conf.backend, qualityTier: conf.tier,
        }
        veil.style.opacity = '1'
        const k0 = nowMs()
        const r = factory(canvas, view.cfg, ro, view.hooks)
        const createMs = nowMs() - k0
        lastR = r
        if (conf.backend === 'gpu' && r.kind !== 'gpu') { const why = r.why; marker.note(r); r.dispose(); return { unavailable: why } }
        const durS = (timing.warmMs + timing.measureMs) / 1000
        const path = cameraPath(view.scene, view.free, durS, reduced)
        const player = { x: view.scene.x, y: view.scene.y, angle: 0, bob: 0, bobOffset: 0, moving: false, hp: 100, maxHp: 100 }
        const cache = view.cache
        let pcx = 0, pcy = 0
        const isWall = (wx, wy) => cache.isWall(wx, wy, pcx, pcy)
        const fk = createFlickerState(), rand = mulberry32(0xB3C4 + view.scene.level)
        const lights = { flashlight: true, glow: null }, tm = { t: 0, dt: 1 / 60 }
        const out = { iv: [], cost: [], internal: '', validation: null, fellBack: null, interrupted: false, startMs: createMs }
        const q = qualityFor(conf.tier)
        out.internal = `${Math.round(canvas.width * q.scale)}x${Math.round(canvas.height * q.scale)}`
        await new Promise((resolve) => {
          let t0 = -1, last = -1, revealed = false, warmEnd = -1, warmN = 0, warmMax = 0
          const frame = (ts) => {
            if (interrupted) { out.interrupted = true; resolve(); return }
            if (t0 < 0) { t0 = ts; last = ts }
            const t = (ts - t0) / 1000, dt = Math.min((ts - last) / 1000, 0.1)
            const p = path(t)
            player.x = p.x; player.y = p.y; player.angle = p.angle
            pcx = Math.floor(p.x / CHUNK_SIZE); pcy = Math.floor(p.y / CHUNK_SIZE)
            isWall.pcx = pcx; isWall.pcy = pcy; isWall.evictRadius = view.cfg ? (view.cfg.chunkEvictRadius ?? 3) : 3   // lets the rays' memo on, as in the game
            stepFlicker(fk, dt, view.cfg.flicker, rand, false, true)
            tm.t = t; tm.dt = dt || 1 / 60
            const c0 = nowMs()
            try { r.render(player, isWall, fk.value, view.entities, 1, lights, tm) } catch (e) { out.fellBack = out.fellBack || `render threw: ${e && e.message ? e.message : e}` }
            const c1 = nowMs()
            if (!revealed) { revealed = true; veil.style.opacity = '0' }
            if (warmEnd < 0) {
              // warm-up: the worst frame (its interval or its render() cost) is the start cost of this view
              warmN++; warmMax = Math.max(warmMax, c1 - c0, ts > last ? ts - last : 0)
              if (ts - t0 >= timing.warmMs && warmN >= timing.warmFrames) warmEnd = ts
            } else if (ts > last) { out.iv.push(ts - last); out.cost.push(c1 - c0) }
            last = ts
            if (conf.backend === 'gpu' && r.kind !== 'gpu' && !out.fellBack) out.fellBack = r.why
            if ((warmEnd >= 0 && ts - warmEnd >= timing.measureMs) || ts - t0 >= timing.capMs || out.fellBack) { out.startMs = createMs + warmMax; resolve() }
            else raf(frame)
          }
          raf(frame)
        })
        const info = r.info
        if (conf.backend === 'gpu' && info && info.validation) out.validation = info.validation
        veil.style.opacity = '1'
        await sleep(timing.fadeMs)
        marker.note(r); r.dispose()
        return out
      }

      const vstore = memStorage()
      const factory = createRendererWith({ search: () => '', createGl: (c, cfg, ro, wh, d) => createGlRenderer(c, cfg, ro, wh, { ...(d || {}), storage: vstore }) })
      const plan = benchPlan()
      let step = 0
      for (const conf of BENCH_CONFIGS) {
        const res = { id: conf.id, label: conf.label, backend: conf.backend, tier: conf.tier, status: 'ok', why: '', validation: conf.backend === 'gpu' ? '-' : undefined, internal: '' }
        const iv = [], cost = []
        let startMs = 0
        res.views = []                   // per view: the raw intervals (ms, 0.1 ms) — not in the text report; for looking at where the slow frames are
        for (const view of views) {
          step++
          if (interrupted) break
          if (res.status !== 'ok') continue
          status.textContent = `benchmark ${step}/${plan.length} · ${conf.label} · ${view.scene.label}`
          const seg = await runSegment(conf, view)
          if (seg.unavailable) { res.status = 'unavailable'; res.why = seg.unavailable; continue }
          for (const v of seg.iv) iv.push(v)
          for (const v of seg.cost) cost.push(v)
          startMs = Math.max(startMs, seg.startMs || 0)
          res.views.push({ id: view.scene.id, iv: seg.iv.map((x) => Math.round(x * 10) / 10), cost: seg.cost.map((x) => Math.round(x * 10) / 10) })
          res.internal = seg.internal
          // 'cached' can only mean "passed earlier in THIS run" (the validation store is the in-memory one above)
          if (seg.validation && res.validation !== 'passed' && res.validation !== 'failed') res.validation = seg.validation === 'cached' ? 'passed' : seg.validation
          if (seg.fellBack) { res.status = 'fell-back'; res.why = seg.fellBack }
          if (seg.interrupted) interrupted = true
        }
        Object.assign(res, summarize(iv, cost))
        res.startMs = Math.round(startMs)
        if (interrupted && res.status === 'ok' && res.frames === 0) res.status = 'not run'
        rep.configs.push(res)
      }
      rep.fallbacks = lastR ? lastR.fallbacks : 0
      rep.interrupted = interrupted
      rep.verdict = benchVerdict(rep)
      // the crash marker goes back to what this run found, unless one of its own GPU starts failed persistently (that stays recorded)
      rep.marker = settleMarker()
      cleanup()
      showReport(rep)
      try { win.__gfxBenchReport = rep; console.info('[bench] ' + formatReport(rep).split('\n').join('\n[bench] ')) } catch { /* ignore */ }
      return rep
    } catch (e) {
      settleMarker()
      cleanup()
      throw e
    } finally {
      running = false
    }
  }

  function showReport(rep) {
    const v = rep.verdict
    const text = formatReport(rep)
    const rows = rep.configs.map((c) => {
      const has = c.frames > 0
      const st = esc(c.status + (c.status !== 'ok' && c.why ? ` (${c.why})` : ''))
      const bad = (x) => (x ? ' class="bad"' : '')
      return `<tr><td>${esc(c.label)}</td><td class="st${c.status !== 'ok' ? ' bad' : ''}">${st}</td>` + (has
        ? `<td>${c.frames}</td><td>${f1(c.p50)}</td><td${bad(c.p95 > 33.4)}>${f1(c.p95)}</td><td>${f1(c.p99)}</td><td${bad(c.over33 > 0.05)}>${pctStr(c.over33)}</td><td>${f1(c.costP50)} / ${f1(c.costP95)}</td><td>${esc(c.internal || '-')}</td><td>${Number.isFinite(c.startMs) ? c.startMs : '-'}</td><td class="st">${c.backend === 'gpu' ? esc(c.validation || '-') : ''}</td>`
        : '<td colspan="9"></td>') + '</tr>'
    }).join('')
    const checks = v.checks.map((c) => `<div><span class="${c.ok ? 'ok' : 'no'}">[${c.ok ? 'x' : ' '}]</span> ${esc(c.name)}: ${esc(c.note)}</div>`).join('')
    root.innerHTML = `<div class="card" id="gfx-bench-report" role="dialog" aria-label="benchmark results">
      <h1>GRAPHICS BENCHMARK · RESULTS${rep.interrupted ? ' (INTERRUPTED)' : ''}</h1>
      <p class="verdict">${esc(v.line)}</p>
      <p>${esc(v.cpuAdvice)}. Display ~${f1(rep.display.periodMs)} ms per frame. GPU: ${esc(rep.gpu.renderer || 'no renderer string')}${rep.gpu.software ? ' (software)' : ''}.</p>
      <div class="gb-btns"><button id="gfx-bench-copy">COPY RESULT</button><button class="quiet" id="gfx-bench-again">RUN AGAIN</button><a class="btn quiet" href="${esc(backUrl)}">BACK TO THE GAME</a></div>
      <div class="table"><table>
        <tr><th>config</th><th>status</th><th>frames</th><th>p50 ms</th><th>p95</th><th>p99</th><th>&gt;33 ms</th><th>render() p50 / p95</th><th>internal</th><th>start ms</th><th>validation</th></tr>
        ${rows}
      </table></div>
      <p>GPU_AUTO checks: <b class="${v.gpuAutoOk ? 'ok' : 'no'}">${v.gpuAutoOk ? 'all pass' : 'not all pass'}</b></p>
      ${checks}
      <pre id="gfx-bench-text">${esc(text)}</pre>
    </div>`
    root.style.display = 'flex'
    const copyBtn = doc.getElementById('gfx-bench-copy')
    copyBtn.addEventListener('click', async () => {
      let done = false
      try { if (win.navigator.clipboard && win.navigator.clipboard.writeText) { await win.navigator.clipboard.writeText(text); done = true } } catch { /* fall back */ }
      if (!done) {
        try {                                          // older engines / no clipboard permission: select a hidden textarea and copy
          const ta = doc.createElement('textarea'); ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0'
          doc.body.appendChild(ta); ta.select(); done = doc.execCommand('copy'); ta.remove()
        } catch { done = false }
      }
      copyBtn.textContent = done ? 'COPIED ✓' : 'SELECT THE TEXT ABOVE AND COPY IT'
    })
    doc.getElementById('gfx-bench-again').addEventListener('click', () => { run().catch((e) => fail(e)) })
  }

  intro()
  return { run }
}
