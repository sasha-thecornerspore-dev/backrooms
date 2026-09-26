// Track HC: the ?gfxbench=1 device benchmark (gfx-bench.js). Its pure parts — the configuration list, the views and their camera paths in the
// REAL seed-0 world, the statistics, the verdict / GPU_AUTO checks and the text report — are tested here; the page itself is exercised in the
// real game page by tools/gfx/page.cjs (--query '?gfxbench=quick'). Also: it must never write the player's save or prefs.
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import {
  BENCH_CONFIGS, BENCH_SCENES, benchMode, benchPlan, benchSeconds, benchTiming, summarize, pct, displayPeriod, freeRun, cameraPath, PATH,
  benchVerdict, formatReport, buildView,
} from '../src/renderer/gfx-bench.js'
import { DEFAULT_CONFIG, CHUNK_SIZE } from '../src/renderer/world.js'

const root = path.resolve(import.meta.dirname, '..')
const src = (f) => fs.readFileSync(path.join(root, f), 'utf8')

describe('what it runs', () => {
  it('?gfxbench=1 is the full run, quick is the harness run, anything off is no bench', () => {
    expect(benchMode('?gfxbench=1')).toBe('full')
    expect(benchMode('?x=1&gfxbench=yes')).toBe('full')
    expect(benchMode('?gfxbench=quick')).toBe('quick')
    for (const q of ['', '?gfxbench=0', '?gfxbench=off', '?gfxstats=1']) expect(benchMode(q), q).toBe(null)
  })
  it('CPU low / medium / high, then GPU medium / high; the five views; CPU configs run first', () => {
    expect(BENCH_CONFIGS.map((c) => `${c.backend}-${c.tier}`)).toEqual(['cpu-low', 'cpu-medium', 'cpu-high', 'gpu-medium', 'gpu-high'])
    expect(BENCH_SCENES.map((s) => s.level)).toEqual([0, 0, 2, 3, 4])
    const plan = benchPlan()
    expect(plan.length).toBe(25)
    const firstGpu = plan.findIndex((p) => p.config.backend === 'gpu')
    expect(plan.slice(0, firstGpu).every((p) => p.config.backend === 'cpu')).toBe(true)
  })
  it('the full run takes about a minute; every view is measured well past its warm-up', () => {
    expect(benchSeconds('full')).toBeGreaterThan(45); expect(benchSeconds('full')).toBeLessThan(75)
    expect(benchSeconds('quick')).toBeLessThan(30)
    const t = benchTiming('full')
    expect(t.measureMs).toBeGreaterThanOrEqual(3 * t.warmMs)
  })
})

describe('statistics', () => {
  it('percentiles, the share of frames over 33 ms, and render cost', () => {
    const iv = [...Array(95).fill(16.7), 20, 25, 40, 50, 60]
    const s = summarize(iv, iv.map((v) => v / 4))
    expect(s.frames).toBe(100)
    expect(s.p50).toBe(16.7); expect(s.p95).toBe(16.7); expect(s.p99).toBe(50)
    expect(s.over33).toBe(0.03)
    expect(s.costP50).toBeCloseTo(4.18, 2)
    expect(summarize([], []).frames).toBe(0)
    expect(pct([1, 2, 3], 0)).toBe(1)
  })
  it('the display period is the median idle interval (a stray long frame does not move it)', () => {
    expect(displayPeriod([16.6, 16.7, 16.8, 16.7, 250, 33.3, 16.7])).toBe(16.7)
    expect(displayPeriod([8.3, 8.4, 8.3, 8.3])).toBe(8.3)
    expect(Number.isNaN(displayPeriod([]))).toBe(true)
  })
})

describe('the camera path', () => {
  const box = (x0, y0, x1, y1) => (cx, cy) => !(cx >= x0 && cx <= x1 && cy >= y0 && cy <= y1)       // open cells inside the box
  it('freeRun stops before the first wall cell', () => {
    expect(freeRun(box(0, 0, 9, 0), 0.5, 0.5, 0)).toBe(4)                      // capped at max (4 cells by default)
    expect(freeRun(box(0, 0, 3, 0), 0.5, 0.5, 0, 10)).toBeCloseTo(3.45, 1)
    expect(freeRun(box(0, 0, 3, 0), 0.5, 0.5, Math.PI / 2)).toBeLessThan(0.5)
  })
  it('smooth (no step bigger than a slow walk per frame), starts at the pose, keeps its distance from the wall ahead, gentler when reduced', () => {
    const scene = { x: 5.5, y: 5.5, angle: 0 }
    for (const reduced of [false, true]) {
      const p = cameraPath(scene, 3, 2.15, reduced)
      const a = p(0)
      expect(a.x).toBe(5.5); expect(a.y).toBe(5.5); expect(a.angle).toBeCloseTo(0)
      let prev = a, maxStep = 0, maxTurn = 0, maxX = 0
      for (let t = 1 / 60; t <= 2.2; t += 1 / 60) {
        const q = p(t)
        maxStep = Math.max(maxStep, Math.hypot(q.x - prev.x, q.y - prev.y)); maxTurn = Math.max(maxTurn, Math.abs(q.angle - prev.angle)); maxX = Math.max(maxX, q.x)
        prev = q
      }
      expect(maxStep).toBeLessThan(reduced ? 0.01 : 0.03)                      // < 1.8 cells/s: a walk, not the sprint
      expect(maxTurn * 60).toBeLessThan(reduced ? 0.15 : 0.7)                 // rad/s: a slow look around
      expect(maxX - 5.5).toBeLessThanOrEqual(3 - PATH.clearance + 1e-9)
    }
    expect(cameraPath(scene, 0.2, 2)(2).x).toBe(5.5)                           // no room ahead: it only looks around
  })
})

describe('the views in the real seed-0 world', () => {
  const base = { ...DEFAULT_CONFIG, ...JSON.parse(src('src/renderer/world.json')) }
  for (const scene of BENCH_SCENES) {
    it(`${scene.id}: open floor at the pose, room to walk, things to draw, and the whole path stays off the walls`, () => {
      const v = buildView(base, scene)
      const pcx = Math.floor(scene.x / CHUNK_SIZE), pcy = Math.floor(scene.y / CHUNK_SIZE)
      const wall = (x, y) => v.cache.isWall(Math.floor(x), Math.floor(y), pcx, pcy)
      expect(wall(scene.x, scene.y)).toBe(false)
      expect(v.free).toBeGreaterThan(0.8)
      expect(v.entities.length).toBeGreaterThan(0)
      const t = benchTiming('full'), p = cameraPath(scene, v.free, (t.warmMs + t.measureMs) / 1000, false)
      for (let s = 0; s <= 2.2; s += 0.05) { const q = p(s); expect(wall(q.x, q.y), `t=${s}`).toBe(false) }
      if (scene.extra) expect(v.entities.some((e) => e.variant === scene.extra.variant && e.x === scene.extra.x)).toBe(true)
    })
  }
})

// a result, as the page builds it
const cfg = (id, o) => { const c = BENCH_CONFIGS.find((x) => x.id === id); return { id, label: c.label, backend: c.backend, tier: c.tier, status: 'ok', why: '', frames: 100, p50: 16.7, p95: 17, p99: 18, over33: 0, costP50: 5, costP95: 7, internal: '640x360', validation: c.backend === 'gpu' ? 'passed' : undefined, ...o } }
const report = (over = {}, cfgOver = {}) => ({
  version: 1, build: 'm2-3', date: '2026-09-24T00:00:00Z', mode: 'full',
  device: { ua: 'UA', cores: 4, memory: 4, dpr: 2, screen: '1366x768', window: '1366x768', touch: false, reducedMotion: false },
  display: { periodMs: 16.7 }, gpu: { renderer: 'ANGLE (Intel, Mesa Intel(R) UHD Graphics 600)', webgl2: true, software: false, reason: 'ok' }, fallbacks: 0,
  configs: BENCH_CONFIGS.map((c) => cfg(c.id, cfgOver[c.id])),
  ...over,
})

describe('the verdict and the GPU_AUTO checks', () => {
  it('GPU clearly faster: says how much, all checks pass', () => {
    const v = benchVerdict(report({}, { 'cpu-medium': { p95: 40, p50: 33, over33: 0.4 }, 'gpu-medium': { p95: 18 }, 'gpu-high': { p95: 17.4 } }))
    expect(v.kind).toBe('gpu-faster')
    expect(v.line).toBe('GPU high is 2.3x faster than CPU medium here (p95 frame 17.4 ms vs 40.0 ms)')
    expect(v.gpuAutoOk).toBe(true)
  })
  it('both at the display rate: the same-rate verdict, still eligible', () => {
    const v = benchVerdict(report())
    expect(v.kind).toBe('same-rate')
    expect(v.line).toMatch(/both keep the display rate/)
    expect(v.gpuAutoOk).toBe(true)
    expect(v.cpuAdvice).toBe('the CPU renderer keeps the display rate up to high')
  })
  it('GPU slower: keep the CPU, and the not-slower check fails', () => {
    const v = benchVerdict(report({}, { 'cpu-medium': { p95: 25 }, 'gpu-medium': { p95: 40, over33: 0.3 }, 'gpu-high': { p95: 45, over33: 0.4 } }))
    expect(v.kind).toBe('gpu-slower'); expect(v.line).toMatch(/keep the CPU renderer/)
    expect(v.gpuAutoOk).toBe(false)
    expect(v.checks.find((c) => c.name.startsWith('GPU medium not slower')).ok).toBe(false)
  })
  it('no GPU: says why (software GL), CPU advice still given', () => {
    const v = benchVerdict(report({ gpu: { renderer: 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device))', webgl2: true, software: true, reason: 'software-gl' } },
      { 'gpu-medium': { status: 'unavailable', why: 'software-gl', frames: 0, p95: NaN }, 'gpu-high': { status: 'unavailable', why: 'software-gl', frames: 0, p95: NaN }, 'cpu-high': { p95: 30 } }))
    expect(v.kind).toBe('no-gpu')
    expect(v.line).toBe('GPU not available: software-gl')
    expect(v.cpuAdvice).toBe('the CPU renderer keeps the display rate up to medium')
    expect(v.gpuAutoOk).toBe(false)
    expect(v.checks[0]).toMatchObject({ name: 'hardware GPU', ok: false })
  })
  it('a fallback during the run fails the checks even if the numbers look fine', () => {
    const v = benchVerdict(report({ fallbacks: 1 }, { 'gpu-high': { status: 'fell-back', why: 'gpu-failed-validate', validation: 'failed' } }))
    expect(v.gpuAutoOk).toBe(false)
    expect(v.checks.find((c) => c.name === 'no GPU fallbacks').ok).toBe(false)
    expect(v.checks.find((c) => c.name === 'GPU path came up').ok).toBe(false)
  })
  it('validation must have PASSED (skipped or off is not enough)', () => {
    const v = benchVerdict(report({}, { 'gpu-medium': { validation: 'skipped' }, 'gpu-high': { validation: 'skipped' } }))
    expect(v.checks.find((c) => c.name === 'first-frame validation passed').ok).toBe(false)
  })
})

describe('the text report (the Copy button)', () => {
  it('device facts, one row per config (with why when unavailable), the verdict and every check', () => {
    const rep = report({}, { 'gpu-high': { status: 'unavailable', why: 'session-gpu-failed-validate', frames: 0, p95: NaN } })
    const t = formatReport(rep)
    expect(t).toMatch(/^BACKROOMS GFX BENCH v1 · build m2-3/)
    expect(t).toMatch(/cores 4 · memory 4 GB · dpr 2 · screen 1366x768/)
    expect(t).toMatch(/gpu: ANGLE \(Intel, Mesa Intel\(R\) UHD Graphics 600\) · webgl2 yes · probe says hardware/)
    expect(t).toMatch(/^CPU medium\s+ok\s+100\s+16\.7\s+17\.0\s+18\.0\s+0%/m)
    expect(t).toMatch(/^GPU high\s+unavailable \(session-gpu-failed-validate\)$/m)
    expect(t).toMatch(/^verdict: /m)
    expect(t.match(/^ {2}\[[x ]\] /gm).length).toBe(5)
    expect(t).not.toMatch(/NaN|undefined/)
  })
})

describe('safety (source guards)', () => {
  const bench = src('src/renderer/gfx-bench.js'), html = src('src/renderer/index.html')
  it('imports nothing that reads or writes the save, the prefs or the audio, and writes no storage directly (only the marker guard may put the marker back)', () => {
    for (const m of ['save.js', 'prefs.js', 'game.js', 'audio.js']) expect(bench).not.toMatch(new RegExp(`from '\\./${m.replace('.', '\\.')}'`))
    expect(bench).not.toMatch(/localStorage\.setItem|sessionStorage/)
    expect(bench.match(/localStorage\.\w+\(/g)).toEqual(['localStorage.getItem('])           // the Reduce flicker pref, read only
    expect(bench).not.toMatch(/removeItem\(GPU_MARKER_KEY\)/)                    // it never clears the crash marker (test/gfx-jc-bench.test.js)
    expect(bench).toMatch(/storage: vstore/)                                   // the validation result stays in memory
    expect(bench).toMatch(/search: \(\) => ''/)                                // a ?renderer= in the URL cannot steer a config
    expect(bench).toMatch(/reduceFlicker: true/)
  })
  it('index.html enters the bench before anything reads the save or starts the attract, and the page never continues into the game', () => {
    const a = html.indexOf("has('gfxbench')"), b = html.indexOf('readSave()'), c = html.indexOf("import('./gfx-attract.js')")
    expect(a).toBeGreaterThan(0); expect(a).toBeLessThan(b); expect(a).toBeLessThan(c)
    expect(html).toMatch(/await bench\.startBench\(document, window, \{ mode, canvas \}\)\s*\n\s*await new Promise\(\(\) => \{\}\)/)
  })
  it('both offline shell lists carry the new modules and the cache names moved past this build (pwa v9, play 19)', () => {
    const sw = src('src/sw.js'), build = src('tools/build-play.sh')
    for (const f of ['gfx-bench.js', 'gfx-stats.js']) { expect(sw).toContain(`'/renderer/${f}'`); expect(build).toContain(`'${f}'`) }
    expect(Number(/backrooms-pwa-v(\d+)/.exec(sw)[1])).toBeGreaterThanOrEqual(9)
    expect(Number(/PLAY_SW_VERSION:-(\d+)/.exec(build)[1])).toBeGreaterThanOrEqual(19)
  })
})
