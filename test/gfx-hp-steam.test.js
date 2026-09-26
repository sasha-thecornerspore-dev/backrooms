// Track HP / V9: rising steam near the camera (Level 2) must not become large, fairly opaque grey ovals that read as smudges on the lens —
// at the tiers without a frame-brightness measurement (low / medium) a flashlight used to light them up to ~0.6 alpha and ~50 px tall.
// The CPU stage and the GPU particle simulation share the same ceilings (gfx-post.js steamLimits).
import { describe, it, expect, afterEach, vi } from 'vitest'
import { STEAM_NEAR, steamLimits, createPostState, seedParticles, drawParticles } from '../src/renderer/gfx-post.js'
import { createSink, stepModern, INST, K_STEAM, K_GLOW } from '../src/renderer/gfx-gl-post-particles.js'
import { PARTICLE_VS } from '../src/renderer/gfx-gl-post-shaders.js'
import { TIERS } from '../src/renderer/gfx-quality.js'
import { DEFAULT_CONFIG } from '../src/renderer/world.js'
import { levelConfig } from '../src/renderer/levels.js'
import { fakeDoc2d } from './gfx-hp-fakes.js'

afterEach(() => { vi.unstubAllGlobals() })

const L2 = levelConfig(DEFAULT_CONFIG, 2)
const fsFor = (tier, over = {}) => ({
  W: 576, H: 324, OW: 960, OH: 540, t: 1, dt: 1 / 60, frame: 1, flicker: 1, rawFlicker: 1, fov: 1.309, player: null,
  lights: { flashlight: true }, opts: { particles: true }, quality: TIERS[tier], levelKey: '2', handled: { flashlight: true, glow: false }, light: { enabled: true }, ...over,
})
// one mote, placed where the flashlight is brightest and the steam fade is full, near the camera
function nearField(z = 0.98) {
  const post = createPostState(L2); seedParticles(post, 960, 540)
  post.particles.length = 1
  Object.assign(post.particles[0], { x: 480, y: 330, z, ph: 0, s: 1.3, a: 1.25, w: 0.5 })
  return post
}

describe('steamLimits', () => {
  it('the alpha ceiling falls with depth (near = out of focus = faint) and the radius cap scales with the canvas', () => {
    const o = { r: 0, a: 0 }
    expect(steamLimits(0.35, 540, o).a).toBeCloseTo(STEAM_NEAR.aFar, 9)
    expect(steamLimits(1, 540, o).a).toBeCloseTo(STEAM_NEAR.aNear, 9)
    let prev = 1
    for (let z = 0.35; z <= 1; z += 0.05) { const a = steamLimits(z, 540, o).a; expect(a).toBeLessThanOrEqual(prev + 1e-12); prev = a }
    expect(steamLimits(0.5, 540, o).r).toBeCloseTo(STEAM_NEAR.rMax * 540, 9)
    expect(steamLimits(0.5, 1080, o).r).toBeCloseTo(STEAM_NEAR.rMax * 1080, 9)
  })
})

describe('the CPU stage draws near steam capped at every modern tier', () => {
  for (const tier of ['low', 'medium', 'high']) {
    it(`${tier}: a near, flashlight-lit wisp is faint and bounded`, () => {
      const doc = fakeDoc2d(); vi.stubGlobal('document', doc)
      const ctx = doc.createElement('canvas').getContext('2d')
      const alphas = []
      const set = ctx.calls
      // record globalAlpha at each drawImage
      const proxy = new Proxy(ctx, { get(o, k) { if (k === 'drawImage') return (...a) => { alphas.push(o.globalAlpha); set.push(['drawImage', ...a]) }; return o[k] }, set(o, k, v) { o[k] = v; return true } })
      drawParticles(proxy, fsFor(tier), nearField(), 1)
      const draws = set.filter((c) => c[0] === 'drawImage')
      expect(draws.length).toBe(1)
      const [, , , , w, h] = draws[0]
      expect(h).toBeLessThanOrEqual(STEAM_NEAR.rMax * 540 * 2.8 + 1e-9)          // height = 2.8 r
      expect(w).toBeLessThanOrEqual(STEAM_NEAR.rMax * 540 * 1.5 + 1e-9)
      expect(alphas[0]).toBeLessThanOrEqual(steamLimits(0.98, 540, {}).a + 1e-12)
      expect(alphas[0]).toBeGreaterThan(0.02)                                      // still there: steam, not nothing
    })
  }
  it('far wisps keep their look (the ceiling does not bind)', () => {
    const doc = fakeDoc2d(); vi.stubGlobal('document', doc)
    const post = nearField(0.36)
    post.particles[0].y = 480; post.particles[0].x = 100                         // a far wisp low on the screen, no flashlight
    const ctx = doc.createElement('canvas').getContext('2d')
    drawParticles(ctx, fsFor('medium', { lights: {} }), post, 1)
    const d = ctx.calls.find((c) => c[0] === 'drawImage')
    const u = 1 - post.particles[0].y / 540
    const baseSize = L2.particles.size * 1.1
    const rFree = baseSize * (3.4 + 4.4 * 0.36) * (1 + 0.9 * u) * 1.3
    expect(rFree).toBeLessThan(STEAM_NEAR.rMax * 540)
    expect(d[5]).toBeCloseTo(rFree * 2.8, 6)                                     // (drawImage(img, x, y, w, h): h = 2.8 r)
  })
})

describe('the GPU particle simulation mirrors the ceilings', () => {
  it('halves the CPU wisp extents and carries the alpha ceiling in C.w (steam and its glowstick tint)', () => {
    const post = nearField()
    const sink = createSink(4)
    stepModern(post, fsFor('medium', { lights: { flashlight: true, glow: [90, 255, 120] } }), 1, sink)
    expect(sink.nN).toBe(1)
    const N = sink.N
    expect(N[6]).toBe(K_STEAM)
    const r = STEAM_NEAR.rMax * 540
    expect(N[2]).toBeCloseTo(r * 0.75, 4); expect(N[3]).toBeCloseTo(r * 1.4, 4)       // halfL = 0.75 r, halfW = 1.4 r (the CPU draws 1.5 r x 2.8 r; float32 storage)
    expect(N[11]).toBeCloseTo(steamLimits(post.particles[0].z, 540, {}).a, 6)
    if (sink.nA) { const o = 0; expect(sink.A[o + 6]).toBe(K_GLOW); expect(sink.A[o + 11]).toBeCloseTo(N[11], 6) }
    expect(INST).toBe(12)
  })
  it('the particle shader applies the ceiling before the glow multiply and the cull', () => {
    const i = PARTICLE_VS.indexOf('if (aC.w > 0.0) alpha0 = min(alpha0, aC.w)')
    expect(i).toBeGreaterThan(0)
    expect(PARTICLE_VS.indexOf('float alpha = kind > 4.5')).toBeGreaterThan(i)
    expect(PARTICLE_VS.indexOf('if (alpha0 < 0.004)')).toBeGreaterThan(i)
  })
})
