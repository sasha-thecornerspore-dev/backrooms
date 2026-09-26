// Fixer JP / H4-1: the particle field at degenerate canvas sizes. A 0 x 0 or 1 x 1 canvas (a window shrunk to its title bar) must neither turn the
// motes into NaN / Infinity (x * 0 / 0) nor squash the field into one band at an edge that is still there after the canvas grows back. The field
// keeps its last real size while the canvas is degenerate, the particle steps (CPU draw and GPU step) skip such frames, and a field that was SEEDED
// tiny is re-laid over the frame at the first real size. The first call is still exactly seedParticles (the harness renders stay byte-identical).
import { describe, it, expect, afterEach, vi } from 'vitest'
import { createPostState, seedParticles, fitParticles, drawParticles, particleFieldLive, FIELD_MIN } from '../src/renderer/gfx-post.js'
import { createSink, stepModern, stepLegacy } from '../src/renderer/gfx-gl-post-particles.js'
import { createCpuRenderer } from '../src/renderer/gfx-cpu.js'
import { createPostPass } from '../src/renderer/gfx-gl-post.js'
import { TIERS } from '../src/renderer/gfx-quality.js'
import { DEFAULT_CONFIG } from '../src/renderer/world.js'
import { levelConfig } from '../src/renderer/levels.js'
import { fakeGl, fakeDoc2d } from './gfx-hp-fakes.js'

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

const player = { x: 5.5, y: 5.5, angle: 0.3, bobOffset: 0 }
const box = (wx, wy) => wx <= 1 || wy <= 1 || wx >= 10 || wy >= 10
const snap = (ps) => ps.map((p) => ({ x: p.x, y: p.y, z: p.z, ph: p.ph, s: p.s, a: p.a, w: p.w }))
const finite = (ps) => ps.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.ph))
// every mote inside the frame (plus the steps' recycle margin)
const inside = (ps, W, H, m = 12) => ps.every((p) => p.x >= -m && p.x <= W + m && p.y >= -m && p.y <= H + m)
const meanFrac = (ps, H) => ps.reduce((s, p) => s + p.y / H, 0) / ps.length
const cfgFor = (kind) => ({ levelIndex: 0, palette: { fog: '#D4C87A' }, particles: { count: 45, ...(kind === 'steam' ? { rise: true } : kind === 'spark' ? { spark: true } : {}) } })
const fsFor = (tier, OW, OH, frame) => ({
  W: OW >> 1, H: OH >> 1, OW, OH, t: frame / 60, dt: 1 / 60, frame, flicker: 1, rawFlicker: 1, fov: 1.309, player, lights: { flashlight: true },
  opts: { particles: true }, quality: TIERS[tier], levelKey: '0', handled: { flashlight: false, glow: false }, light: { enabled: tier !== 'legacy' },
})

describe('fitParticles at degenerate sizes', () => {
  it('the guard size is small and every real size is live', () => {
    expect(FIELD_MIN).toBeLessThanOrEqual(16)
    for (const [w, h, live] of [[0, 0, false], [1, 1, false], [15, 540, false], [960, 15, false], [16, 16, true], [160, 90, true], [NaN, 90, false]]) expect(particleFieldLive(w, h)).toBe(live)
  })
  for (const [tw, th] of [[0, 0], [1, 1], [8, 600], [800, 3]]) {
    it(`800x600 -> ${tw}x${th} -> 800x600 leaves the field exactly where it was (no NaN, no Math.random)`, () => {
      const post = createPostState(cfgFor('dust')); fitParticles(post, 800, 600)
      const before = snap(post.particles)
      const spy = vi.spyOn(Math, 'random')
      expect(fitParticles(post, tw, th)).toBe(false)
      expect([post.fieldW, post.fieldH]).toEqual([800, 600])                // kept at its last real size
      expect(snap(post.particles)).toEqual(before)
      fitParticles(post, 800, 600)
      expect(snap(post.particles)).toEqual(before)
      fitParticles(post, tw, th); fitParticles(post, 1600, 1200)             // tiny, then a new real size: rescaled from the last real one
      post.particles.forEach((p, i) => { expect(p.x).toBe(before[i].x * 2); expect(p.y).toBe(before[i].y * 2) })
      expect(spy).not.toHaveBeenCalled()
    })
  }
  it('the first call at a normal size is still exactly seedParticles', () => {
    let s = 7; const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647)
    vi.spyOn(Math, 'random').mockImplementation(rnd)
    const a = createPostState(cfgFor('dust')); expect(fitParticles(a, 960, 540)).toBe(true)
    s = 7
    const b = createPostState(cfgFor('dust')); seedParticles(b, 960, 540)
    expect(snap(a.particles)).toEqual(snap(b.particles)); expect(a.rng()).toBe(b.rng())
  })
  for (const [w, h] of [[0, 0], [1, 1], [10, 10]]) {
    it(`a field seeded at ${w}x${h} is re-laid over the frame at the first real size (depth / phase / jitter kept, finite, spread)`, () => {
      const post = createPostState(cfgFor('dust'))
      expect(fitParticles(post, w, h)).toBe(true)
      const seeded = snap(post.particles)
      fitParticles(post, 3, 2)                                               // still degenerate: nothing moves
      expect(snap(post.particles)).toEqual(seeded)
      fitParticles(post, 960, 540)
      expect([post.fieldW, post.fieldH]).toEqual([960, 540])
      expect(finite(post.particles)).toBe(true)
      expect(inside(post.particles, 960, 540, 0)).toBe(true)
      expect(meanFrac(post.particles, 540)).toBeGreaterThan(0.3); expect(meanFrac(post.particles, 540)).toBeLessThan(0.7)
      const xs = post.particles.map((p) => p.x)
      expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(960 * 0.6)  // spread over the width, not a band
      post.particles.forEach((p, i) => expect([p.z, p.ph, p.s, p.a, p.w]).toEqual([seeded[i].z, seeded[i].ph, seeded[i].s, seeded[i].a, seeded[i].w]))
      const laid = snap(post.particles)
      fitParticles(post, 1920, 1080)                                         // from now on: plain rescales
      post.particles.forEach((p, i) => { expect(p.x).toBe(laid[i].x * 2); expect(p.y).toBe(laid[i].y * 2) })
    })
  }
})

// Drive a post state the way a backend does: fit to the canvas, then step (CPU: drawParticles into a recording context; GPU: stepModern /
// stepLegacy into a sink). Returns how much was drawn.
function cpuFrame(ctx, post, tier, OW, OH, frame) {
  fitParticles(post, OW, OH)
  const n = ctx.calls.length
  drawParticles(ctx, fsFor(tier, OW, OH, frame), post, 1)
  return ctx.calls.slice(n).filter((c) => c[0] === 'drawImage' || c[0] === 'arc').length
}
function gpuFrame(sink, post, tier, OW, OH, frame) {
  fitParticles(post, OW, OH)
  const fs = fsFor(tier, OW, OH, frame)
  if (tier === 'legacy') stepLegacy(post, fs, sink); else stepModern(post, fs, 1, sink)
  return sink.nN + sink.nA
}

describe('tiny -> normal -> tiny sequences on both particle paths', () => {
  for (const path of ['cpu', 'gpu']) for (const tier of ['legacy', 'medium']) for (const kind of ['dust', 'steam', 'spark']) {
    it(`${path} ${tier} ${kind}: a degenerate canvas neither steps nor draws the field, and the field is intact after it grows back`, () => {
      const doc = fakeDoc2d(); vi.stubGlobal('document', doc)
      const post = createPostState(cfgFor(kind))
      const ctx = doc.createElement('canvas').getContext('2d'), sink = createSink(post.count)
      const frame = path === 'cpu' ? (W, H, f) => cpuFrame(ctx, post, tier, W, H, f) : (W, H, f) => gpuFrame(sink, post, tier, W, H, f)
      let f = 0
      for (let i = 0; i < 20; i++) frame(960, 540, ++f)
      const before = snap(post.particles)
      for (const [w, h] of [[1, 1], [0, 0], [4, 300]]) for (let i = 0; i < 30; i++) expect(frame(w, h, ++f)).toBe(0)
      expect(snap(post.particles)).toEqual(before)                          // not stepped: no flight off a 1 px frame
      frame(960, 540, ++f)
      expect(finite(post.particles)).toBe(true); expect(inside(post.particles, 960, 540)).toBe(true)
      for (let i = 0; i < 120; i++) frame(960, 540, ++f)                    // 2 s later: still spread, not bunched on an edge row
      expect(finite(post.particles)).toBe(true); expect(inside(post.particles, 960, 540)).toBe(true)
      const m = meanFrac(post.particles, 540)
      expect(m).toBeGreaterThan(0.2); expect(m).toBeLessThan(0.8)
      for (let i = 0; i < 10; i++) frame(1, 1, ++f)                         // and tiny again
      expect(finite(post.particles)).toBe(true)
    })
  }
  for (const path of ['cpu', 'gpu']) {
    it(`${path}: a field first seen at 1x1 comes up spread over the frame`, () => {
      const doc = fakeDoc2d(); vi.stubGlobal('document', doc)
      const post = createPostState(cfgFor('dust'))
      const ctx = doc.createElement('canvas').getContext('2d'), sink = createSink(post.count)
      const frame = path === 'cpu' ? (W, H, f) => cpuFrame(ctx, post, 'medium', W, H, f) : (W, H, f) => gpuFrame(sink, post, 'medium', W, H, f)
      let f = 0
      for (let i = 0; i < 30; i++) expect(frame(1, 1, ++f)).toBe(0)
      frame(960, 540, ++f)
      expect(finite(post.particles)).toBe(true); expect(inside(post.particles, 960, 540)).toBe(true)
      const m = meanFrac(post.particles, 540); expect(m).toBeGreaterThan(0.3); expect(m).toBeLessThan(0.7)
    })
  }
})

describe('the real backends at a 1x1 canvas', () => {
  it('the CPU renderer: 30 frames at 1x1 between normal frames leave every mote finite and in the frame', () => {
    const doc = fakeDoc2d(); vi.stubGlobal('document', doc)
    for (const tier of ['legacy', 'medium']) {
      const canvas = doc.createElement('canvas'); canvas.width = 960; canvas.height = 540
      const r = createCpuRenderer(canvas, levelConfig(DEFAULT_CONFIG, 0), { qualityTier: tier, grain: true, particles: true, crosshair: true }, {})
      let t = 0
      const frame = () => { t += 1 / 60; r.render(player, box, 1, [], 1, {}, { t, dt: 1 / 60 }) }
      for (let i = 0; i < 5; i++) frame()
      const before = snap(r.post.particles)
      expect(before.length).toBeGreaterThan(0)
      canvas.width = 1; canvas.height = 1
      for (let i = 0; i < 30; i++) frame()
      expect(snap(r.post.particles)).toEqual(before)
      canvas.width = 960; canvas.height = 540; frame()
      expect(finite(r.post.particles)).toBe(true); expect(inside(r.post.particles, 960, 540)).toBe(true)
      r.dispose()
    }
  })
  it('the GPU post pass: frames and resize() at 0x0 / 1x1 emit no particle instances and keep the field', () => {
    const doc = fakeDoc2d(); vi.stubGlobal('document', doc)
    const gl = fakeGl()
    const canvas = doc.createElement('canvas'); canvas.width = 960; canvas.height = 540
    const env = { gl, canvas, config: levelConfig(DEFAULT_CONFIG, 0), ropts: {}, caps: {}, tri: { draw() {}, dispose() {} } }
    const pass = createPostPass(env)
    const fs = (OW, OH, frame) => ({ ...fsFor('medium', OW, OH, frame), lights: {} })
    let f = 0
    for (let i = 0; i < 5; i++) pass.render(fs(960, 540, ++f), { W: 480, H: 270, sceneTex: {} }, [])
    const post = pass.state, before = snap(post.particles)
    expect(before.length).toBeGreaterThan(0)
    pass.resize(0, 0)
    for (let i = 0; i < 30; i++) pass.render(fs(1, 1, ++f), { W: 1, H: 1, sceneTex: {} }, [])
    expect(snap(post.particles)).toEqual(before)
    pass.resize(960, 540); pass.render(fs(960, 540, ++f), { W: 480, H: 270, sceneTex: {} }, [])
    expect(finite(post.particles)).toBe(true); expect(inside(post.particles, 960, 540)).toBe(true)
    pass.dispose()
  })
})
