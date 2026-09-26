// gfx-quality.js (tiers + flicker comfort), gfx-light.js (the stub contract), gfx-sky.js, and the import safety of
// the modules added in the contract-prep step. All pure: they run in Node with no DOM.
import { describe, it, expect } from 'vitest'
import { TIERS, qualityFor, comfortFor, effectiveFlicker } from '../src/renderer/gfx-quality.js'
import { createLight } from '../src/renderer/gfx-light.js'
import { renderSky } from '../src/renderer/gfx-sky.js'

describe('module import safety', () => {
  for (const m of ['gfx-quality', 'gfx-light', 'gfx-sky']) {
    it(`${m}.js imports without a DOM`, async () => {
      expect(typeof document).toBe('undefined')
      await expect(import(`../src/renderer/${m}.js`)).resolves.toBeDefined()
    })
  }
})

describe('quality tiers', () => {
  it('legacy is exactly today\'s renderer and is the default for unknown or missing names', () => {
    expect(TIERS.legacy).toEqual({ scale: 0.6, texFilter: 0, lightDetail: 0, bloom: 0, particles: true })
    expect(qualityFor(undefined)).toBe(TIERS.legacy)
    expect(qualityFor('no-such-tier')).toBe(TIERS.legacy)
  })
  it('every tier carries the full field set with sane ranges, and the tiers are immutable', () => {
    for (const [name, q] of Object.entries(TIERS)) {
      expect(Object.keys(q).sort(), name).toEqual(['bloom', 'lightDetail', 'particles', 'scale', 'texFilter'])
      expect(q.scale).toBeGreaterThanOrEqual(0.4); expect(q.scale).toBeLessThanOrEqual(0.9)
      expect([0, 1]).toContain(q.texFilter)
      expect([0, 1, 2]).toContain(q.lightDetail)
      expect([0, 1]).toContain(q.bloom)
      expect(Object.isFrozen(q)).toBe(true)
    }
    expect(Object.isFrozen(TIERS)).toBe(true)
  })
  it('the tiers rise monotonically in cost-bearing features', () => {
    const order = ['low', 'medium', 'high']
    for (let i = 1; i < order.length; i++) {
      expect(TIERS[order[i]].scale).toBeGreaterThanOrEqual(TIERS[order[i - 1]].scale)
      expect(TIERS[order[i]].lightDetail).toBeGreaterThanOrEqual(TIERS[order[i - 1]].lightDetail)
      expect(TIERS[order[i]].bloom).toBeGreaterThanOrEqual(TIERS[order[i - 1]].bloom)
    }
  })
})

describe('flicker comfort', () => {
  it('the default comfort leaves the flicker scalar untouched (legacy behaviour)', () => {
    const c = comfortFor({})
    expect(c).toEqual({ reduceFlicker: false, maxGlobalDip: 1 })
    for (const f of [0, 0.14, 0.5, 0.97, 1]) expect(effectiveFlicker(f, c)).toBe(f)
  })
  it('reduceFlicker bounds how far the whole frame may dip', () => {
    const c = comfortFor({ reduceFlicker: true })
    expect(c.reduceFlicker).toBe(true)
    expect(effectiveFlicker(0.14, c)).toBeCloseTo(1 - c.maxGlobalDip, 10)
    expect(effectiveFlicker(0.9, c)).toBe(0.9)          // a dip inside the bound is untouched
    expect(effectiveFlicker(1, c)).toBe(1)
    for (let f = 0; f <= 1; f += 0.05) expect(effectiveFlicker(f, c)).toBeGreaterThanOrEqual(1 - c.maxGlobalDip)
  })
  it('tolerates missing options', () => {
    expect(comfortFor(undefined).maxGlobalDip).toBe(1)
    expect(comfortFor(null).reduceFlicker).toBe(false)
  })
})

describe('gfx-light stub contract', () => {
  it('reports "no light model" and answers neutrally until the real model lands', () => {
    const L = createLight({ palette: {}, lights: true })
    expect(L.enabled).toBe(false)
    expect(L.at(3.2, 4.1)).toBe(1)
    expect(L.tint(3.2, 4.1)).toEqual([1, 1, 1])
    expect(L.nearest(3.2, 4.1)).toBeNull()
    expect(L.panelLevel(2, 4, { rawFlicker: 0.3 })).toBe(1)
  })
})

describe('renderSky', () => {
  it('fills rows 0..HH with the sky→fog gradient times flicker and leaves the rest alone', () => {
    const W = 8, H = 20, HH = 10
    const buf32 = new Uint32Array(W * H).fill(0xdeadbeef)
    renderSky({ W, H, HH, skyRgb: [200, 100, 50], fogRgb: [100, 100, 100], flicker: 1 }, buf32)
    const px = (x, y) => { const v = buf32[y * W + x]; return [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, v >>> 24] }
    expect(px(0, 0)).toEqual([200, 100, 50, 255])            // top row is pure sky
    expect(px(3, HH)).toEqual([100, 100, 100, 255])          // the horizon row is pure fog
    for (let x = 1; x < W; x++) expect(buf32[x]).toBe(buf32[0])
    for (let y = HH + 1; y < H; y++) expect(buf32[y * W]).toBe(0xdeadbeef)   // below the horizon untouched
  })
  it('never writes outside the buffer when the horizon is pushed below the bottom', () => {
    const W = 4, H = 6
    const buf32 = new Uint32Array(W * H)
    renderSky({ W, H, HH: H + 5, skyRgb: [10, 20, 30], fogRgb: [50, 60, 70], flicker: 0.5 }, buf32)
    for (const v of buf32) expect(v >>> 24).toBe(255)
  })
})
