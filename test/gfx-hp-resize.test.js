// Track HP / PQ-7: a canvas resize or a tier switch must not re-seed the particle field (a visible pop of every mote), must not rebuild the
// legacy tier's full-resolution vignette unless the legacy path draws and the size really changed, and must reuse the offscreen canvases.
// The CPU renderer runs here against a recording fake document (no browser); the GPU post pass against a fake WebGL2 context.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { createCpuRenderer } from '../src/renderer/gfx-cpu.js'
import { createPostState, seedParticles, fitParticles, ensureLegacyVignette } from '../src/renderer/gfx-post.js'
import { createPostPass } from '../src/renderer/gfx-gl-post.js'
import { DEFAULT_CONFIG } from '../src/renderer/world.js'
import { levelConfig } from '../src/renderer/levels.js'
import { fakeGl, fakeDoc2d } from './gfx-hp-fakes.js'

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

const player = { x: 5.5, y: 5.5, angle: 0.3, bobOffset: 0 }
const box = (wx, wy) => wx <= 1 || wy <= 1 || wx >= 10 || wy >= 10
const snap = (ps) => ps.map((p) => ({ x: p.x, y: p.y, z: p.z, ph: p.ph, s: p.s, a: p.a, w: p.w }))

describe('fitParticles: seeded once, then only rescaled', () => {
  const cfg = { levelIndex: 0, palette: { fog: '#D4C87A' }, particles: { count: 12 } }
  it('the first call is exactly seedParticles (same Math.random draws, same field)', () => {
    let s = 1; const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647)
    vi.spyOn(Math, 'random').mockImplementation(rnd)
    const a = createPostState(cfg); expect(fitParticles(a, 960, 540)).toBe(true)
    s = 1
    const b = createPostState(cfg); seedParticles(b, 960, 540)
    expect(snap(a.particles)).toEqual(snap(b.particles))
    expect([a.fieldW, a.fieldH]).toEqual([960, 540])
  })
  it('a resize scales every mote by the size ratio, keeps depth / phase / jitter / object identity and never calls Math.random', () => {
    const post = createPostState(cfg); fitParticles(post, 960, 540)
    const before = snap(post.particles), objs = post.particles.slice(), rng = post.rng
    const spy = vi.spyOn(Math, 'random').mockImplementation(() => { throw new Error('re-seeded') })
    expect(fitParticles(post, 1920, 1080)).toBe(false)
    expect(fitParticles(post, 1920, 1080)).toBe(false)                   // same size again: nothing
    expect(spy).not.toHaveBeenCalled()
    post.particles.forEach((p, i) => {
      expect(p).toBe(objs[i])
      expect(p.x).toBe(before[i].x * 2); expect(p.y).toBe(before[i].y * 2)
      expect([p.z, p.ph, p.s, p.a, p.w]).toEqual([before[i].z, before[i].ph, before[i].s, before[i].a, before[i].w])
    })
    expect(post.rng).toBe(rng)                                            // the respawn stream carries on
    fitParticles(post, 480, 270)
    post.particles.forEach((p, i) => { expect(p.x).toBeCloseTo(before[i].x / 2, 9); expect(p.y).toBeCloseTo(before[i].y / 2, 9) })
  })
  it('an empty field is fine', () => {
    const post = createPostState({ palette: { fog: '#000000' } })
    expect(fitParticles(post, 10, 10)).toBe(true); expect(fitParticles(post, 20, 10)).toBe(false); expect(post.particles).toEqual([])
  })
})

describe('ensureLegacyVignette: lazy, sized, and reused', () => {
  it('builds on first use, keeps the canvas while the size holds, and redraws the SAME canvas at a new size', () => {
    const doc = fakeDoc2d(); vi.stubGlobal('document', doc)
    const post = createPostState({ palette: { fog: '#000000' } })
    expect(post.vignette).toBeNull()
    const v = ensureLegacyVignette(post, 160, 90)
    expect([v.width, v.height]).toEqual([160, 90]); expect(doc.created).toBe(1)
    expect(ensureLegacyVignette(post, 160, 90)).toBe(v); expect(doc.created).toBe(1)
    const grads = doc.gradients
    expect(ensureLegacyVignette(post, 320, 180)).toBe(v)
    expect([v.width, v.height]).toEqual([320, 180]); expect(doc.created).toBe(1); expect(doc.gradients).toBe(grads + 1)
  })
})

describe('the CPU renderer: resizes and tier switches', () => {
  function rig(tier = 'legacy', level = 0) {
    const doc = fakeDoc2d(); vi.stubGlobal('document', doc)
    const canvas = doc.createElement('canvas'); canvas.width = 160; canvas.height = 90
    const ropts = { qualityTier: tier, grain: true, particles: true, crosshair: true }
    const r = createCpuRenderer(canvas, levelConfig(DEFAULT_CONFIG, level), ropts, {})
    let t = 0
    const frame = () => { t += 1 / 60; r.render(player, box, 1, [], 1, {}, { t, dt: 1 / 60 }) }
    return { doc, canvas, ropts, r, frame }
  }
  it('a modern tier never builds the legacy vignette', () => {
    const k = rig('medium'); k.frame(); k.frame()
    expect(k.r.post.vignette).toBeNull()
    k.canvas.width = 320; k.canvas.height = 180; k.frame()
    expect(k.r.post.vignette).toBeNull()
  })
  it('switching tiers and render scales neither re-seeds the particles nor rebuilds the vignette, and allocates no canvas once warm', () => {
    const k = rig('legacy')
    k.frame()
    const post = k.r.post, vig = post.vignette, objs = post.particles.slice()
    expect(vig).toBeTruthy(); expect([vig.width, vig.height]).toEqual([160, 90]); expect(objs.length).toBe(45)
    const cycle = () => {
      for (const [tier, scale] of [['medium', undefined], ['high', undefined], ['low', 0.4], ['high', 0.9], ['medium', 0.55], ['legacy', 0.8], ['legacy', undefined]]) {
        k.ropts.qualityTier = tier; k.ropts.renderScale = scale; k.frame()
      }
    }
    cycle()                                                                 // first visit of every tier builds its lazy resources
    const created = k.doc.created, vigGrads = vig.getContext().gradients
    const spy = vi.spyOn(Math, 'random')
    k.ropts.particles = false                                               // (the legacy dots respawn with Math.random: keep them still)
    cycle(); cycle()
    expect(spy).not.toHaveBeenCalled()
    expect(k.doc.created).toBe(created)                                     // no canvas allocated by a scale / tier change
    expect(post.vignette).toBe(vig); expect([vig.width, vig.height]).toEqual([160, 90])
    expect(vig.getContext().gradients).toBe(vigGrads)                        // the vignette was not redrawn
    expect(post.particles).toHaveLength(objs.length); post.particles.forEach((p, i) => expect(p).toBe(objs[i]))
  })
  it('a canvas resize rescales the field (no Math.random), rebuilds the vignette in its own canvas, and reuses the bloom / veil canvases', () => {
    const k = rig('high')
    k.frame(); k.ropts.qualityTier = 'legacy'; k.frame()
    const post = k.r.post, vig = post.vignette, bloom = post.bloom, veil = post.veil
    expect(bloom && veil && vig).toBeTruthy()
    const bloomCanvases = [bloom.c1, bloom.c2, bloom.c3, bloom.cOut, bloom.up1, bloom.up2]
    k.ropts.particles = false
    const before = snap(post.particles), objs = post.particles.slice()
    const spy = vi.spyOn(Math, 'random')
    const created = k.doc.created
    k.canvas.width = 320; k.canvas.height = 180; k.frame()                  // legacy frame at the new size
    k.ropts.qualityTier = 'high'; for (let i = 0; i < 5; i++) k.frame()      // and modern ones (past the bloom's idle skip: the fake frame is black)
    expect(spy).not.toHaveBeenCalled()
    post.particles.forEach((p, i) => { expect(p).toBe(objs[i]); expect(p.x).toBe(before[i].x * 2); expect(p.y).toBe(before[i].y * 2); expect(p.z).toBe(before[i].z) })
    expect(post.vignette).toBe(vig); expect([vig.width, vig.height]).toEqual([320, 180])
    expect(post.bloom).toBe(bloom); expect([bloom.c1, bloom.c2, bloom.c3, bloom.cOut, bloom.up1, bloom.up2]).toEqual(bloomCanvases)
    expect(bloom.c1.width).toBe(Math.round(320 * 0.75) >> 1)
    expect(post.veil).toBe(veil); expect([veil.width, veil.height]).toEqual([Math.round(320 * 0.75), Math.round(180 * 0.75)])
    expect(k.doc.created).toBe(created)
  })
})

describe('the CPU renderer: dispose', () => {
  it('releases every canvas it made (zero-size backing stores), is idempotent, and a later render draws nothing', () => {
    const doc = fakeDoc2d(); vi.stubGlobal('document', doc)
    const canvas = doc.createElement('canvas'); canvas.width = 160; canvas.height = 90
    const ropts = { qualityTier: 'high', grain: true, particles: true, crosshair: true, tape: true }
    const r = createCpuRenderer(canvas, levelConfig(DEFAULT_CONFIG, 2), ropts, {})
    const frame = (t) => r.render(player, box, 1, [], 1, { flashlight: true, glow: [90, 255, 120] }, { t, dt: 1 / 60 })
    for (let i = 1; i < 6; i++) frame(i / 60)
    ropts.qualityTier = 'medium'; frame(0.2); ropts.qualityTier = 'legacy'; frame(0.25)
    const mine = doc.canvases.filter((c) => c !== canvas && c.width > 0)
    expect(mine.length).toBeGreaterThan(8)                                  // world, grain, vignette, veil, grain tile, bloom chain, tape, sprites, flash layer
    r.dispose(); r.dispose()
    expect(mine.filter((c) => c.width !== 0 || c.height !== 0)).toEqual([])
    expect(canvas.width).toBe(160)                                          // the visible canvas is the game's, untouched
    const calls = canvas.getContext().calls.length
    expect(() => frame(0.3)).not.toThrow()
    expect(canvas.getContext().calls.length).toBe(calls)
  })
})

describe('the GPU post pass follows the same field semantics', () => {
  it('seeds once, rescales on a canvas resize (render or resize()), never re-seeds', () => {
    const doc = fakeDoc2d(); vi.stubGlobal('document', doc)
    const gl = fakeGl()
    const canvas = doc.createElement('canvas'); canvas.width = 160; canvas.height = 90
    const tri = { draw() {}, dispose() {} }
    const env = { gl, canvas, config: levelConfig(DEFAULT_CONFIG, 2), ropts: {}, caps: {}, tri }
    const pass = createPostPass(env)
    const fs = (OW, OH, frame) => ({
      W: OW >> 1, H: OH >> 1, OW, OH, t: frame / 60, dt: 1 / 60, frame, flicker: 1, rawFlicker: 1, fov: 1.309, player, lights: {},
      opts: { particles: false }, quality: { scale: 0.5, lightDetail: 1, bloom: 0, particles: true }, levelKey: '2', handled: { flashlight: false, glow: false }, light: { enabled: true },
    })
    pass.render(fs(160, 90, 1), { W: 80, H: 45, sceneTex: {} }, [])
    const post = pass.state, objs = post.particles.slice(), before = snap(post.particles)
    expect(objs.length).toBe(40)
    const spy = vi.spyOn(Math, 'random')
    pass.render(fs(320, 180, 2), { W: 160, H: 90, sceneTex: {} }, [])
    post.particles.forEach((p, i) => { expect(p).toBe(objs[i]); expect(p.x).toBe(before[i].x * 2); expect(p.y).toBe(before[i].y * 2) })
    pass.resize(640, 360)
    post.particles.forEach((p, i) => { expect(p).toBe(objs[i]); expect(p.x).toBe(before[i].x * 4) })
    expect(spy).not.toHaveBeenCalled()
    pass.dispose()
  })
})
