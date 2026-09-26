// tools/gfx/parity.mjs — the pure comparison (comparePair / checkLimits / sideBySide) on synthetic images.
import { describe, it, expect } from 'vitest'
import { comparePair, checkLimits, sideBySide, DEFAULT_LIMITS } from '../tools/gfx/parity.mjs'

const img = (w, h, f) => { const data = Buffer.alloc(w * h * 4); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const [r, g, b] = f(x, y), o = (y * w + x) * 4; data[o] = r; data[o + 1] = g; data[o + 2] = b; data[o + 3] = 255 } return { width: w, height: h, data } }
const grad = (x, y) => [40 + x * 2, 60 + y * 2, 90]

describe('comparePair', () => {
  it('identical frames: zero everywhere, within limits', () => {
    const a = img(64, 36, grad), m = comparePair(a, img(64, 36, grad))
    expect(m.mean).toBe(0); expect(m.p99).toBe(0); expect(m.over).toBe(0); expect(m.block.ok).toBe(true)
    expect(checkLimits(m)).toEqual([])
  })
  it('a uniform brightness shift shows in mean and the mean colours', () => {
    const m = comparePair(img(64, 36, grad), img(64, 36, (x, y) => grad(x, y).map((v) => v + 20)))
    expect(m.mean).toBeCloseTo(20 / 255, 3); expect(m.gpuMean[0] - m.cpuMean[0]).toBeCloseTo(20 / 255, 3); expect(m.over).toBe(0)
  })
  it('a wrong picture trips every limit', () => {
    const m = comparePair(img(64, 36, grad), img(64, 36, () => [0, 0, 0]))
    expect(checkLimits(m, DEFAULT_LIMITS).length).toBeGreaterThanOrEqual(2); expect(m.block.ok).toBe(false)
  })
  it('a few bad pixels move p99/over only slightly', () => {
    const b = img(64, 36, grad); for (let i = 0; i < 20; i++) { b.data[i * 4] = 255 - b.data[i * 4] }
    const m = comparePair(img(64, 36, grad), b); expect(m.over).toBeLessThan(0.02); expect(m.mean).toBeLessThan(0.02)
  })
  it('rejects a size mismatch', () => { expect(() => comparePair(img(4, 4, grad), img(8, 4, grad))).toThrow(/size mismatch/) })
})

describe('sideBySide', () => {
  it('lays CPU | GPU | difference out at the panel scale', () => {
    const s = sideBySide(img(40, 20, () => [10, 20, 30]), img(40, 20, () => [15, 20, 30]), { scale: 0.5, amplify: 4 })
    expect([s.width, s.height]).toEqual([60, 10])
    expect([...s.data.slice(0, 3)]).toEqual([10, 20, 30])                     // panel 0 = CPU
    expect([...s.data.slice(20 * 4, 20 * 4 + 3)]).toEqual([15, 20, 30])       // panel 1 = GPU
    expect([...s.data.slice(40 * 4, 40 * 4 + 3)]).toEqual([20, 0, 0])         // panel 2 = 4 x |dr|
  })
})
