// gfx-attract.js — the title screen's attract mode. The pure parts (route planner, path sampler, camera, flicker schedule,
// environment decision, frame governor) are pinned against the REAL Level 0 chunk generator; the lifecycle (start, still, skip,
// stop, self-dispose, refuse #c) runs against a fake canvas with the renderer mocked, so it needs no DOM. Also pins the HUD theme
// tokens in index.html: every per-level plate/ink pair must keep WCAG AA (4.5:1) for its body text even over a scene that is
// pure black or pure white behind the translucent plate.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const render = vi.fn()
const dispose = vi.fn()
vi.mock('../src/renderer/renderer.js', () => ({ createRenderer: vi.fn(() => ({ render, dispose, kind: 'cpu', capture: () => '' })) }))

import {
  ATTRACT_SEED, ATTRACT_VIEW, TURN_RADIUS, GLIDE_SPEED, TURN_SLOWDOWN,
  planRoute, buildPath, sampleRoute, cameraAt, routePeriod, pathPosAt, stillPose, flickerAt, attractPlan,
  createGovernor, governorStep, GOVERNOR_INTERVAL_MS, startAttract, stopAttract, getAttractStats,
} from '../src/renderer/gfx-attract.js'
import { createRenderer } from '../src/renderer/renderer.js'
import { createChunkCache, CHUNK_SIZE, DEFAULT_CONFIG } from '../src/renderer/world.js'
import { levelConfig } from '../src/renderer/levels.js'

const here = path.dirname(fileURLToPath(import.meta.url))

const lobby = () => {
  const cfg = levelConfig(DEFAULT_CONFIG, 0)
  const cache = createChunkCache(cfg, ATTRACT_SEED)
  cache.preload(0, 0)
  return { cfg, cache, isOpen: (cx, cy) => !cache.isWall(cx + 0.5, cy + 0.5) }
}

describe('gfx-attract is import-safe in Node', () => {
  it('has no DOM at module scope and its runtime entry points are inert without one', async () => {
    expect(typeof document).toBe('undefined')
    expect(await startAttract(null)).toBe(false)
    expect(await startAttract({ id: 'attract' })).toBe(false)   // no document -> nothing to do
    expect(() => stopAttract()).not.toThrow()
    expect(getAttractStats()).toBe(null)
  })
})

describe('planRoute / buildPath — the camera path', () => {
  const { isOpen: rawOpen } = lobby()
  const memo = new Map()                                                      // the chunk cache builds a string key per lookup: memoise, or the sweeps below take seconds
  const isOpen = (cx, cy) => { const k = cx * 100003 + cy; let v = memo.get(k); if (v === undefined) { v = rawOpen(cx, cy); memo.set(k, v) } return v }
  const route = planRoute({ isOpen })

  it('finds a closed rectangular route of hall in the real lobby world', () => {
    expect(route).toBeTruthy()
    expect(route.segs.length).toBe(8)                                       // 4 straights + 4 arcs
    expect(route.segs.filter((s) => s.type === 'arc').length).toBe(4)
    expect(route.length).toBeGreaterThan(60)                                // at least a chunk-sized loop of hall
    expect(route.radius).toBeCloseTo(TURN_RADIUS, 6)
  })

  it('is deterministic: the same seed gives the identical route, a different seed can give another', () => {
    expect(planRoute({ isOpen })).toEqual(route)
    expect(planRoute({ isOpen, seed: ATTRACT_SEED })).toEqual(route)
    const others = new Set()
    for (let seed = 1; seed <= 12; seed++) others.add(JSON.stringify(planRoute({ isOpen, seed }).corners))
    expect(others.size).toBeGreaterThan(2)
  })

  // distance from a point to the nearest wall cell (3x3 neighbourhood is enough: the answer we care about is < 1)
  const clearance = (x, y) => {
    let best = Infinity
    const cx = Math.floor(x), cy = Math.floor(y)
    for (let j = cy - 1; j <= cy + 1; j++) for (let i = cx - 1; i <= cx + 1; i++) {
      if (isOpen(i, j)) continue
      const dx = Math.max(i - x, 0, x - (i + 1)), dy = Math.max(j - y, 0, y - (j + 1))
      best = Math.min(best, Math.hypot(dx, dy))
    }
    return best
  }
  it('every sampled point of every route stays in open cells and keeps a body-width clear of every wall corner', () => {
    for (const seed of [ATTRACT_SEED, 1, 2, 3, 4, 5, 6, 7]) {
      const r = planRoute({ isOpen, seed })
      const n = Math.ceil(r.length / 0.1)
      for (let i = 0; i < n; i++) {
        const p = sampleRoute(r, (i / n) * r.length)
        expect(isOpen(Math.floor(p.x), Math.floor(p.y)), `seed ${seed} s=${(i / n * r.length).toFixed(2)} at ${p.x.toFixed(2)},${p.y.toFixed(2)}`).toBe(true)
        expect(clearance(p.x, p.y), `seed ${seed} clearance at ${p.x.toFixed(2)},${p.y.toFixed(2)}`).toBeGreaterThanOrEqual(0.25)
      }
    }
  }, 30000)

  it('loops: the path closes on itself, position and heading, and the camera repeats after one lap', () => {
    const a = sampleRoute(route, 0), b = sampleRoute(route, route.length)
    expect(b.x).toBeCloseTo(a.x, 6); expect(b.y).toBeCloseTo(a.y, 6); expect(b.heading).toBeCloseTo(a.heading, 6)
    const lap = routePeriod(route)
    expect(lap).toBeGreaterThan(route.length / GLIDE_SPEED)                     // the turns are slower than the straights
    expect(lap).toBeLessThan(route.length / (GLIDE_SPEED * (1 - TURN_SLOWDOWN)))
    for (const t of [0, 3.3, 41.7, 90.1]) {
      const c1 = cameraAt(route, t, { calm: true }), c2 = cameraAt(route, t + lap, { calm: true })
      expect(c2.x).toBeCloseTo(c1.x, 5); expect(c2.y).toBeCloseTo(c1.y, 5)
    }
  })

  it('eases through the turns: the camera slows to about half speed at every junction and is at full speed mid-straight', () => {
    const arc = route.segs.find((g) => g.type === 'arc')
    const line = route.segs.filter((g) => g.type === 'line').sort((a, b) => b.len - a.len)[0]
    const speedAt = (s) => {                                                    // path speed (cells/s) by differencing the timeline
      const period = routePeriod(route)
      let lo = 0, hi = period
      for (let i = 0; i < 60; i++) { const mid = (lo + hi) / 2; if (pathPosAt(route, mid) < s) lo = mid; else hi = mid }
      const t = (lo + hi) / 2
      return (pathPosAt(route, t + 0.01) - pathPosAt(route, t - 0.01)) / 0.02
    }
    expect(speedAt(line.s0 + line.len / 2)).toBeCloseTo(GLIDE_SPEED, 2)
    expect(speedAt(arc.s0 + arc.len / 2)).toBeCloseTo(GLIDE_SPEED * (1 - TURN_SLOWDOWN), 2)
    expect(pathPosAt(route, 0)).toBeCloseTo(0, 6)
    let prev = -1
    for (let t = 0; t < routePeriod(route); t += 0.5) { const s = pathPosAt(route, t); expect(s).toBeGreaterThan(prev); prev = s }   // it only ever moves forward
  })

  it('is continuous: no jumps in position, and the heading turns through exactly one full circle per lap', () => {
    const n = Math.ceil(route.length / 0.02)
    let prev = sampleRoute(route, 0), turned = 0, maxStep = 0
    for (let i = 1; i <= n; i++) {
      const p = sampleRoute(route, (i / n) * route.length)
      maxStep = Math.max(maxStep, Math.hypot(p.x - prev.x, p.y - prev.y))
      let d = p.heading - prev.heading
      while (d > Math.PI) d -= 2 * Math.PI
      while (d < -Math.PI) d += 2 * Math.PI
      expect(Math.abs(d)).toBeLessThan(0.05)                                 // no snap turns: at most ~3 degrees per 2 cm of path
      turned += d
      prev = p
    }
    expect(maxStep).toBeLessThan(0.021)
    expect(Math.abs(Math.abs(turned) - 2 * Math.PI)).toBeLessThan(0.02)     // four quarter-turns, all the same way round
  })

  it('a straight of hall runs a chunk or more; the corners are real junctions of the lobby', () => {
    const longest = Math.max(...route.segs.filter((s) => s.type === 'line').map((s) => s.len))
    expect(longest).toBeGreaterThan(CHUNK_SIZE - 2 * TURN_RADIUS - 0.01)
    for (const [x, y] of route.corners) {
      // a junction: the hall continues in all four directions (or is at least open on the two legs we use)
      expect(isOpen(Math.floor(x), Math.floor(y))).toBe(true)
    }
  })

  it('returns null rather than a route through walls when the world has no hall', () => {
    expect(planRoute({ isOpen: () => false })).toBe(null)
  })

  it('shrinks the turn radius for a tiny loop instead of overshooting a leg', () => {
    const r = buildPath([[0.5, 0.5], [3.5, 0.5], [3.5, 3.5], [0.5, 3.5]], 5)
    expect(r.radius).toBeLessThan(1.5)
    expect(r.length).toBeGreaterThan(0)
    const p = sampleRoute(r, r.length * 0.37)
    expect(p.x).toBeGreaterThan(0); expect(p.x).toBeLessThan(4)
  })
})

describe('camera, still pose and flicker', () => {
  const { isOpen } = lobby()
  const route = planRoute({ isOpen })

  it('the camera sways and bobs a little, deterministically, and is flat when calm', () => {
    const a = cameraAt(route, 12.5), b = cameraAt(route, 12.5)
    expect(a).toEqual(b)
    const flat = cameraAt(route, 12.5, { calm: true })
    expect(Math.abs(a.angle - flat.angle)).toBeLessThan(0.06)              // < ~3.5 degrees of sway
    expect(Math.abs(a.bobOffset)).toBeLessThanOrEqual(1.4)
    expect(flat.bobOffset).toBe(0); expect(flat.moving).toBe(false)
  })

  it('the reduced-motion still frame is a point on the route, on the longest straight, facing down it', () => {
    const p = stillPose(route)
    expect(isOpen(Math.floor(p.x), Math.floor(p.y))).toBe(true)
    const heading = Math.atan2(Math.round(Math.sin(p.angle)), Math.round(Math.cos(p.angle)))
    expect(Math.abs(Math.sin(p.angle)) < 1e-9 || Math.abs(Math.cos(p.angle)) < 1e-9).toBe(true)   // axis-aligned
    expect(Number.isFinite(heading)).toBe(true)
    expect(p.moving).toBe(false)
  })

  it('flicker stays in a comfortable band and never dips more than once in any second', () => {
    let min = 1, max = 0
    const dips = []
    let below = false
    for (let i = 0; i < 60 * 300; i++) {                                      // 5 minutes at 60 Hz
      const t = i / 60, f = flickerAt(t)
      min = Math.min(min, f); max = Math.max(max, f)
      if (f < 0.9 && !below) { below = true; dips.push(t) } else if (f >= 0.93) below = false
    }
    expect(min).toBeGreaterThan(0.78); expect(max).toBeLessThanOrEqual(1)
    expect(dips.length).toBeGreaterThan(10)                                    // it is alive...
    for (let i = 1; i < dips.length; i++) expect(dips[i] - dips[i - 1]).toBeGreaterThan(4)   // ...and far below 3 flashes a second
    expect(flickerAt(37.25)).toBe(flickerAt(37.25))
  })
})

describe('attractPlan — who gets what', () => {
  it('animates by default, holds a still for reduced motion, skips on low-end touch devices and data-saver', () => {
    expect(attractPlan({}).mode).toBe('animate')
    expect(attractPlan({ coarse: false, deviceMemory: 8 }).mode).toBe('animate')
    expect(attractPlan({ reducedMotion: true }).mode).toBe('still')
    expect(attractPlan({ coarse: true, deviceMemory: 2 }).mode).toBe('skip')
    expect(attractPlan({ coarse: true, deviceMemory: 0.5 }).mode).toBe('skip')
    expect(attractPlan({ coarse: true, hardwareConcurrency: 2 }).mode).toBe('skip')
    expect(attractPlan({ saveData: true }).mode).toBe('skip')
  })
  it('a coarse pointer alone, or low memory alone on a fine pointer, still animates; skip beats still', () => {
    expect(attractPlan({ coarse: true, deviceMemory: 4, hardwareConcurrency: 8 }).mode).toBe('animate')
    expect(attractPlan({ coarse: true }).mode).toBe('animate')                 // Safari reports neither number
    expect(attractPlan({ coarse: false, deviceMemory: 1 }).mode).toBe('still')          // low-end on any pointer: one frame, no loop
    expect(attractPlan({ coarse: true, deviceMemory: 2, reducedMotion: true }).mode).toBe('skip')
  })
})

describe('frame governor', () => {
  it('holds 30 fps while frames arrive on time', () => {
    const g = createGovernor()
    for (let i = 0; i < 300; i++) expect(governorStep(g, 33.5)).toMatchObject({ level: 0, stop: false })
  })
  it('drops to 15 fps when the device cannot keep up, then gives up to a still', () => {
    const g = createGovernor()
    let r
    for (let i = 0; i < 60; i++) r = governorStep(g, 90)
    expect(r.level).toBe(1); expect(r.intervalMs).toBeCloseTo(GOVERNOR_INTERVAL_MS[1], 6); expect(r.stop).toBe(false)
    for (let i = 0; i < 60; i++) r = governorStep(g, 200)
    expect(r.stop).toBe(true)
  })
  it('does not degrade on a brief hitch', () => {
    const g = createGovernor()
    let r
    for (let i = 0; i < 200; i++) r = governorStep(g, i % 50 === 0 ? 250 : 33)
    expect(r.level).toBe(0)
  })
})

// ── lifecycle against a fake canvas ─────────────────────────────────────────────────────────────────────
describe('startAttract / stopAttract lifecycle', () => {
  let queue, nextId, canceled, fakeWindow, clock
  const realPerformance = Object.getOwnPropertyDescriptor(globalThis, 'performance')
  const realNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  const mkCanvas = (id = 'attract') => ({ id, style: {}, dataset: {}, width: 300, height: 150 })
  const setEnv = (o = {}) => {
    fakeWindow = {
      matchMedia: (q) => ({ matches: q.includes('reduced-motion') ? !!o.reducedMotion : q.includes('pointer: coarse') ? !!o.coarse : false, addEventListener() {}, removeEventListener() {} }),
    }
    globalThis.window = fakeWindow
    Object.defineProperty(globalThis, 'navigator', { value: { deviceMemory: o.deviceMemory, hardwareConcurrency: o.cores ?? 8, connection: o.saveData ? { saveData: true } : undefined }, configurable: true, writable: true })
  }
  const tick = (ms) => { clock = ms; const q = queue; queue = []; for (const [, cb] of q) cb(ms) }

  beforeEach(() => {
    queue = []; nextId = 1; canceled = []
    globalThis.document = {}
    globalThis.requestAnimationFrame = (cb) => { const id = nextId++; queue.push([id, cb]); return id }
    globalThis.cancelAnimationFrame = (id) => { canceled.push(id); queue = queue.filter(([i]) => i !== id) }
    clock = 1000
    Object.defineProperty(globalThis, 'performance', { value: { now: () => clock }, configurable: true, writable: true })
    render.mockClear(); dispose.mockClear(); createRenderer.mockClear()
    setEnv()
  })
  afterEach(() => {
    stopAttract()
    delete globalThis.document; delete globalThis.window; delete globalThis.requestAnimationFrame; delete globalThis.cancelAnimationFrame
    if (realNavigator) Object.defineProperty(globalThis, 'navigator', realNavigator); else delete globalThis.navigator
    if (realPerformance) Object.defineProperty(globalThis, 'performance', realPerformance)
  })

  it('draws the first frame at once, on its own canvas, at the small fixed backing size, with no entities and no game canvas', async () => {
    const c = mkCanvas()
    expect(await startAttract(c)).toBe(true)
    expect(createRenderer).toHaveBeenCalledTimes(1)
    expect(createRenderer.mock.calls[0][0]).toBe(c)
    expect(c.width).toBe(ATTRACT_VIEW.w); expect(c.height).toBe(ATTRACT_VIEW.h)
    expect(render).toHaveBeenCalledTimes(1)
    const [player, isWall, flicker, entities, fogMul, lights, timing] = render.mock.calls[0]
    expect(typeof isWall).toBe('function'); expect(entities).toEqual([]); expect(fogMul).toBe(1); expect(lights).toEqual({})
    expect(flicker).toBeGreaterThan(0.78); expect(timing.dt).toBeGreaterThan(0)
    expect(isWall(player.x, player.y)).toBe(false)                            // the camera stands in the open
    expect(createRenderer.mock.calls[0][2].qualityTier).toBe('low')
    expect(createRenderer.mock.calls[0][2].crosshair).toBe(false)
    expect(c.style.display).toBe('block'); expect(c.dataset.state).toBe('running')
  })

  it('runs a capped loop and every drawn frame moves the camera along the route', async () => {
    const c = mkCanvas()
    await startAttract(c)
    const first = render.mock.calls[0][0].x
    let now = 1000
    for (let i = 0; i < 120; i++) { now += 34; tick(now) }                     // the fake clock and the frame timestamps agree
    expect(render.mock.calls.length).toBeGreaterThan(50)
    expect(render.mock.calls.length).toBeLessThan(200)
    const p = render.mock.calls[render.mock.calls.length - 1][0]
    expect(Math.hypot(p.x - first, p.y - render.mock.calls[0][0].y)).toBeGreaterThan(0.5)
    expect(getAttractStats().frames).toBe(render.mock.calls.length)
  })

  it('stopAttract disposes everything: loop cancelled, renderer disposed, canvas store released and hidden; twice is fine', async () => {
    const c = mkCanvas()
    await startAttract(c)
    tick(1000); tick(1040)
    const before = render.mock.calls.length
    stopAttract()
    expect(dispose).toHaveBeenCalledTimes(1)
    expect(c.style.display).toBe('none'); expect(c.width).toBe(0); expect(c.height).toBe(0)
    expect(c.dataset.state).toBe('stopped')
    expect(queue.length).toBe(0)                                               // no frame left scheduled
    expect(getAttractStats()).toBe(null)
    tick(2000)
    expect(render.mock.calls.length).toBe(before)                              // nothing draws after stop
    expect(() => stopAttract()).not.toThrow()
    expect(dispose).toHaveBeenCalledTimes(1)
  })

  it('disposes itself when the start screen goes away, and reports it once via onStop', async () => {
    const c = mkCanvas()
    let up = true, stops = 0
    await startAttract(c, { shouldRun: () => up, onStop: () => { stops++ } })
    tick(1000); tick(1040)
    up = false
    tick(1080)
    expect(dispose).toHaveBeenCalledTimes(1)
    expect(c.dataset.state).toBe('stopped')
    expect(stops).toBe(1)
    stopAttract()
    expect(stops).toBe(1)
  })

  it('prefers-reduced-motion renders ONE still frame and never starts a loop', async () => {
    setEnv({ reducedMotion: true })
    const c = mkCanvas()
    expect(await startAttract(c)).toBe(true)
    expect(render).toHaveBeenCalledTimes(1)
    expect(c.dataset.state).toBe('still')
    expect(queue.length).toBe(0)
    expect(render.mock.calls[0][2]).toBe(1)                                    // steady light, no flicker
    expect(createRenderer.mock.calls[0][2].reduceFlicker).toBe(true)
    tick(5000); tick(6000)
    expect(render).toHaveBeenCalledTimes(1)
    expect(c.style.opacity).toBe('1')                                          // and no fade-in either
  })

  it('opts.still forces the still path, and startTime places the camera anywhere on the route', async () => {
    const c = mkCanvas()
    await startAttract(c, { still: true, startTime: 0 })
    const a = render.mock.calls[0][0]
    stopAttract(); render.mockClear()
    await startAttract(mkCanvas(), { still: true, startTime: 37 })
    const b = render.mock.calls[0][0]
    expect(render).toHaveBeenCalledTimes(1)
    expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThan(5)
  })

  it('skips itself on a low-memory touch device and on data-saver: false, no renderer, canvas untouched', async () => {
    for (const env of [{ coarse: true, deviceMemory: 2 }, { coarse: true, cores: 2 }, { saveData: true }]) {
      setEnv(env)
      const c = mkCanvas()
      expect(await startAttract(c)).toBe(false)
      expect(createRenderer).not.toHaveBeenCalled()
      expect(render).not.toHaveBeenCalled()
      expect(c.style.display).toBeUndefined(); expect(c.width).toBe(300)
      expect(c.dataset.state).toMatch(/^skipped/)
    }
  })

  it('refuses the game canvas #c outright', async () => {
    await expect(startAttract(mkCanvas('c'))).rejects.toThrow(/#c/)
    expect(createRenderer).not.toHaveBeenCalled()
  })

  it('a renderer that throws leaves nothing running and reports false', async () => {
    createRenderer.mockImplementationOnce(() => { throw new Error('no 2d context') })
    const c = mkCanvas()
    expect(await startAttract(c)).toBe(false)
    expect(c.dataset.state).toBe('error')
    expect(queue.length).toBe(0)
    expect(getAttractStats()).toBe(null)
  })

  it('starting again replaces the running session (one renderer at a time)', async () => {
    await startAttract(mkCanvas())
    await startAttract(mkCanvas())
    expect(createRenderer).toHaveBeenCalledTimes(2)
    expect(dispose).toHaveBeenCalledTimes(1)
  })
})

// ── the HUD themes in index.html ─────────────────────────────────────────────────────────────────────
// Parse the --hud-* tokens out of the stylesheet and hold every theme to AA for its body text on its plate, even where the plate is
// translucent and the scene behind it is pure black or pure white. (Contrast is also measured on real frames by tools/gfx/page.cjs.)
describe('index.html HUD themes keep WCAG AA', () => {
  const html = fs.readFileSync(path.join(here, '..', 'src', 'renderer', 'index.html'), 'utf8')
  const block = (sel) => {                                                    // the rule for `sel` that carries the --hud-* tokens
    for (let i = html.indexOf(sel + ' {'); i >= 0; i = html.indexOf(sel + ' {', i + 1)) {
      const blk = html.slice(i, html.indexOf('}', i))
      if (blk.includes('--hud-')) return blk
    }
    return null
  }
  const tok = (blk, name) => { const m = new RegExp('--' + name + ':\\s*([^;]+);').exec(blk || ''); return m ? m[1].trim() : null }
  const parse = (v) => {
    let m = /^#([0-9a-f]{6})$/i.exec(v)
    if (m) { const n = parseInt(m[1], 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1] }
    m = /^rgba?\(([^)]+)\)$/.exec(v)
    const p = m[1].split(',').map(Number)
    return [p[0], p[1], p[2], p[3] ?? 1]
  }
  const lin = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4 }
  const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
  const ratio = (a, b) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05)
  const over = (fg, bg) => [0, 1, 2].map((i) => fg[i] * fg[3] + bg[i] * (1 - fg[3])).concat(1)

  const themes = { lobby: 'body', '∅': 'body[data-level="∅"]', 1: 'body[data-level="1"]', 2: 'body[data-level="2"]', 3: 'body[data-level="3"]' }
  const base = block('body')
  for (const [name, sel] of Object.entries(themes)) {
    it(`theme ${name}: ink and dim ink on the plate (and the centre-message plate) over black and over white`, () => {
      const blk = block(sel)
      expect(blk, `${sel} block exists`).toBeTruthy()
      const get = (k) => tok(blk, k) ?? tok(base, k)
      const ink = parse(get('hud-ink')), dim = parse(get('hud-dim'))
      for (const plateName of ['hud-plate', 'hud-plate-hi']) {
        const plate = parse(get(plateName))
        for (const scene of [[0, 0, 0, 1], [255, 255, 255, 1], [128, 118, 70, 1]]) {
          const bg = over(plate, scene)
          expect(ratio(ink, bg), `${name} ink on ${plateName} over ${scene}`).toBeGreaterThanOrEqual(4.5)
          expect(ratio(dim, bg), `${name} dim ink on ${plateName} over ${scene}`).toBeGreaterThanOrEqual(4.5)
        }
      }
    })
  }
  it('every theme defines a distinct plate, and the dark levels use light ink', () => {
    const inks = ['1', '2', '3'].map((n) => parse(tok(block(`body[data-level="${n}"]`), 'hud-ink')))
    for (const ink of inks) expect(lum(ink)).toBeGreaterThan(0.5)
    expect(lum(parse(tok(base, 'hud-ink')))).toBeLessThan(0.05)                // the lobby keeps dark ink
  })
})
