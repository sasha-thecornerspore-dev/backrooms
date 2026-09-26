// Fixer P: the legacy flicker overlay budget (PS-1), nameplate stacking (V8), particle uiScale (PQ-8), the bloom read-back hint (PQ-9),
// and the attract plan (PQ-5). Pure / mocked: nothing here needs a browser.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { flickerOverlayAlpha, stackNameplates, drawNameplates, drawParticles, createPostState, seedParticles, drawBloom } from '../src/renderer/gfx-post.js'
import { TIERS, comfortFor, effectiveFlicker } from '../src/renderer/gfx-quality.js'
import { attractPlan } from '../src/renderer/gfx-attract.js'

function mockCtx() {
  const calls = []
  const target = { calls }
  return new Proxy(target, {
    get(t, k) {
      if (k in t) return t[k]
      if (k === 'createLinearGradient' || k === 'createRadialGradient') return () => ({ addColorStop() {} })
      if (k === 'measureText') return () => ({ width: 40 })
      if (k === 'getImageData') return (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4) })
      if (k === 'createImageData') return (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h })
      return (...a) => { calls.push([k, ...a]) }
    },
    set(t, k, v) { t[k] = v; return true },
  })
}
function baseFs(over = {}) {
  return {
    W: 100, H: 60, HH: 30, OW: 160, OH: 100, flicker: 1, rawFlicker: 1, t: 0, dt: 1 / 60, frame: 0, fov: 1.309, hf: 0.6545,
    player: { x: 1, y: 1, angle: 0 }, lights: {}, opts: { grain: true, particles: true, crosshair: true }, quality: TIERS.legacy,
    levelKey: '0', handled: { flashlight: false, glow: false }, light: { enabled: false }, ...over,
  }
}

describe('PS-1: the legacy overlay does not dim twice past the comfort floor', () => {
  it('combined factor (world x (1 - overlay)) >= 1 - maxGlobalDip over the whole raw flicker range', () => {
    for (const opts of [{ maxGlobalDip: 0.5 }, { maxGlobalDip: 0.5, reduceFlicker: true }, { maxGlobalDip: 0.7 }, { qualityTier: 'legacy', maxGlobalDip: 0.5 }]) {
      const comfort = comfortFor(opts)
      for (let raw = 0; raw <= 1.0001; raw += 0.01) {
        const flicker = effectiveFlicker(raw, comfort)
        const a = flickerOverlayAlpha(baseFs({ flicker, rawFlicker: raw, comfort }))
        expect(a).toBeGreaterThanOrEqual(0)
        expect(flicker * (1 - a)).toBeGreaterThanOrEqual(1 - comfort.maxGlobalDip - 1e-9)
      }
    }
  })
  it('with reduceFlicker the frame never falls below 0.75', () => {
    const comfort = comfortFor({ maxGlobalDip: 0.5, reduceFlicker: true })
    expect(comfort.maxGlobalDip).toBe(0.25)
    const flicker = effectiveFlicker(0.1, comfort)
    expect(flicker * (1 - flickerOverlayAlpha(baseFs({ flicker, comfort })))).toBeGreaterThanOrEqual(0.75 - 1e-9)
  })
  it('keeps the old formula where no clamp applies (harness baseline)', () => {
    const comfort = comfortFor({})
    expect(flickerOverlayAlpha(baseFs({ flicker: 0.35, comfort }))).toBeCloseTo(0.4875, 10)
    expect(flickerOverlayAlpha(baseFs({ flicker: 0.35 }))).toBeCloseTo(0.4875, 10)
  })
  it('never exceeds what the old formula drew', () => {
    const comfort = comfortFor({ maxGlobalDip: 0.5 })
    for (const f of [0.5, 0.6, 0.75, 0.85]) expect(flickerOverlayAlpha(baseFs({ flicker: f, comfort }))).toBeLessThanOrEqual((1 - f) * 0.75 + 1e-12)
  })
})

describe('V8: nameplates stack instead of hiding each other', () => {
  const box = (x, y) => ({ x0: x - 30, x1: x + 30, y0: y - 15, y1: y + 3 })
  it('non-overlapping plates do not move', () => {
    expect(stackNameplates([box(50, 60), box(200, 60)])).toEqual([0, 0])
  })
  it('the nearest (first) keeps its place, the farther is lifted clear of it, and no two overlap afterwards', () => {
    const boxes = [box(100, 60), box(115, 62), box(90, 58)]
    const up = stackNameplates(boxes)
    expect(up[0]).toBe(0)
    expect(up[1]).toBeGreaterThan(0)
    for (let i = 0; i < boxes.length; i++) for (let j = 0; j < i; j++) {
      const a = boxes[i], b = boxes[j]
      const clear = a.y1 - up[i] <= b.y0 - up[j] || a.y0 - up[i] >= b.y1 - up[j]
      expect(clear, `${i} vs ${j}`).toBe(true)
    }
  })
  it('is deterministic: the same boxes give the same offsets', () => {
    const boxes = [box(100, 60), box(110, 60)]
    expect(stackNameplates(boxes)).toEqual(stackNameplates(boxes.map((b) => ({ ...b }))))
  })
  it('drawNameplates draws two overlapping plates at different heights, far one first', () => {
    const near = { sx: 50, y: 80, name: 'near', alpha: 1 }, far = { sx: 55, y: 80, name: 'far', alpha: 1 }
    const c = mockCtx(); drawNameplates(c, baseFs({ quality: { ...TIERS.legacy, scale: 1 } }), [far, near])
    const texts = c.calls.filter((k) => k[0] === 'fillText')
    expect(texts.map((k) => k[1])).toEqual(['far', 'near'])            // draw order kept: the nearer plate is on top
    expect(texts[1][3]).toBe(78)                                        // near keeps max(16, 80) - 2
    expect(texts[0][3]).toBeLessThan(texts[1][3] - 15)                  // far sits above it
  })
})

describe('PQ-8 / PQ-9: particles follow uiScale; the bloom read-back canvas is CPU-backed', () => {
  afterEach(() => { vi.unstubAllGlobals() })
  const fakeDoc = (log) => ({
    createElement: () => { const ctx = mockCtx(); return { width: 0, height: 0, getContext: (kind, attrs) => { log.push(attrs || null); return ctx } } },
  })
  it('a mote is drawn twice as large at uiScale 2', () => {
    vi.stubGlobal('document', fakeDoc([]))
    const cfg = { levelIndex: 0, palette: { fog: '#D4C87A' }, particles: { count: 4, color: [235, 228, 190], size: 1.4 } }
    const sizes = []
    for (const uiScale of [1, 2]) {
      const post = createPostState(cfg); seedParticles(post, 160, 100)
      post.particles.forEach((p) => { p.x = 80; p.y = 50; p.z = 0.5; p.ph = 0; p.w = 0.5; p.s = 1; p.a = 1 })
      const ctx = mockCtx()
      drawParticles(ctx, baseFs({ quality: { ...TIERS.medium }, lights: {}, opts: { particles: true, uiScale } }), post, 1)
      const draws = ctx.calls.filter((k) => k[0] === 'drawImage')
      expect(draws.length).toBeGreaterThan(0)
      sizes.push(draws[0][4])
    }
    expect(sizes[1] / sizes[0]).toBeCloseTo(2, 5)
  })
  it('only the read-back context is created with willReadFrequently', () => {
    const log = []
    vi.stubGlobal('document', fakeDoc(log))
    const post = createPostState({ levelIndex: 0, palette: { fog: '#D4C87A' }, particles: { count: 0 } })
    drawBloom(mockCtx(), { width: 96, height: 54 }, baseFs({ W: 96, H: 54, quality: { ...TIERS.high }, opts: { bloom: true } }), post)
    const flagged = log.filter((a) => a && a.willReadFrequently === true)
    expect(flagged.length).toBe(1)
  })
})

describe('PQ-5: low-end devices get a still, any pointer', () => {
  it('fine pointer + low memory / few cores => still; coarse + low-end stays skip; capable devices animate', () => {
    expect(attractPlan({ coarse: false, deviceMemory: 2 }).mode).toBe('still')
    expect(attractPlan({ coarse: false, hardwareConcurrency: 2 }).mode).toBe('still')
    expect(attractPlan({ coarse: true, deviceMemory: 2 }).mode).toBe('skip')
    expect(attractPlan({ coarse: false, deviceMemory: 8, hardwareConcurrency: 8 }).mode).toBe('animate')
    expect(attractPlan({ coarse: false }).mode).toBe('animate')
  })
})
