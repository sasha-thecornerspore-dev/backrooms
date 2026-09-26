// First-frame validation (gfx-gl-g4-validate.js) and the GPU health policy (gfx-quality.js), against synthetic frames and frame-time feeds.
import { describe, it, expect } from 'vitest'
import {
  blockMeans, compareFrames, runFirstFrameValidation, validationCacheKey, readValidationCache, writeValidationCache, validationWanted,
  VALIDATION_STORAGE_KEY, GPU_BUILD_ID, VALIDATION_GRID,
} from '../src/renderer/gfx-gl-g4-validate.js'
import { createGpuHealth, isSlowWindow, shouldDowngradeGpu, GPU_HEALTH } from '../src/renderer/gfx-quality.js'
import { GlError } from '../src/renderer/gfx-gl-util.js'

// a W x H RGBA image from f(x, y) -> [r, g, b] (0..255), rows top-down; `bottomUp` stores it the way gl.readPixels returns it
function image(w, h, f, bottomUp = false) {
  const d = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const [r, g, b] = f(x, y), o = ((bottomUp ? h - 1 - y : y) * w + x) * 4
    d[o] = r; d[o + 1] = g; d[o + 2] = b; d[o + 3] = 255
  }
  return d
}
// a corridor-like frame: bright ceiling strip, dark floor, mid walls with a bright door in the middle
const scene = (w, h) => (x, y) => (y < h * 0.3 ? [190, 180, 120] : y > h * 0.7 ? [70, 55, 30] : (x > w * 0.42 && x < w * 0.58 ? [230, 220, 170] : [150, 130, 70]))
const W = 96, H = 54

describe('blockMeans', () => {
  it('averages into the grid, top-down, and flips a bottom-up readback', () => {
    const top = image(4, 4, (x, y) => (y < 2 ? [255, 0, 0] : [0, 0, 255]))
    const m = blockMeans(top, 4, 4, 1, 2, false)
    expect([...m].map((v) => Math.round(v))).toEqual([1, 0, 0, 0, 0, 1])
    const up = image(4, 4, (x, y) => (y < 2 ? [255, 0, 0] : [0, 0, 255]), true)
    expect([...blockMeans(up, 4, 4, 1, 2, true)].map((v) => Math.round(v))).toEqual([1, 0, 0, 0, 0, 1])
  })
})

describe('compareFrames', () => {
  const g = (f, flip = false) => blockMeans(image(W, H, f, flip), W, H, VALIDATION_GRID.w, VALIDATION_GRID.h, flip)
  const ref = g(scene(W, H))
  it('accepts the same picture, and a smoother / slightly different render of it', () => {
    expect(compareFrames(g(scene(W, H)), ref).ok).toBe(true)
    const soft = g((x, y) => scene(W, H)(x, y).map((v) => v * 0.93 + 6))                // a hair darker, lower contrast
    expect(compareFrames(soft, ref).ok).toBe(true)
  })
  it('rejects a black frame', () => { expect(compareFrames(g(() => [0, 0, 0]), ref).reasons).toEqual(expect.arrayContaining(['mean-colour'])) })
  it('rejects garbage', () => {
    let s = 7; const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647
    const r = compareFrames(g(() => [rnd() * 255, rnd() * 255, rnd() * 255]), ref)
    expect(r.ok).toBe(false)
  })
  it('rejects a vertically flipped picture (the classic orientation bug)', () => {
    const r = compareFrames(g((x, y) => scene(W, H)(x, H - 1 - y)), ref)
    expect(r.ok).toBe(false); expect(r.reasons).toContain('structure')
  })
  it('rejects a flat frame where the CPU has structure, a wrong palette, and NaN', () => {
    expect(compareFrames(g(() => [120, 105, 60]), ref).ok).toBe(false)
    expect(compareFrames(g((x, y) => scene(W, H)(x, y).slice().reverse()), ref).ok).toBe(false)        // channels swapped
    const bad = new Float32Array(ref); bad[5] = NaN
    expect(compareFrames(bad, ref).reasons).toEqual(['nan'])
    expect(compareFrames(new Float32Array(3), ref).reasons).toEqual(['size'])
  })
  it('does not demand structure from a fade-to-black reference', () => {
    const dark = g(() => [4, 3, 2]); expect(compareFrames(g(() => [6, 4, 3]), dark).ok).toBe(true)
  })
})

describe('runFirstFrameValidation and its cache', () => {
  const mem = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, v) } }
  const good = () => ({ readGpu: () => ({ data: image(W, H, scene(W, H), true), w: W, h: H, flipY: true }), renderCpu: () => ({ data: image(W, H, scene(W, H)), w: W, h: H }) })
  it('passes a matching frame and records the pass per device + build', () => {
    const st = mem(), key = validationCacheKey('ANGLE (Intel)', GPU_BUILD_ID)
    expect(runFirstFrameValidation({ ...good(), storage: st, key }).ok).toBe(true)
    expect(readValidationCache(st, key)).toBe(true)
    expect(readValidationCache(st, validationCacheKey('ANGLE (NVIDIA)', GPU_BUILD_ID))).toBe(false)     // another device
    expect(readValidationCache(st, validationCacheKey('ANGLE (Intel)', 'm2-999'))).toBe(false)           // another build
  })
  it('throws GlError("validate") on a mismatch and caches nothing', () => {
    const st = mem(), key = 'k'
    const bad = { readGpu: () => ({ data: new Uint8ClampedArray(W * H * 4), w: W, h: H, flipY: true }), renderCpu: good().renderCpu }
    let err = null
    try { runFirstFrameValidation({ ...bad, storage: st, key }) } catch (e) { err = e }
    expect(err).toBeInstanceOf(GlError); expect(err.stage).toBe('validate'); expect(err.message).toMatch(/does not match/)
    expect(st.getItem(VALIDATION_STORAGE_KEY)).toBeNull()
  })
  it('validationWanted: on real hardware once per device+build, never on the harness software GL unless forced', () => {
    const st = mem(), key = 'k'
    expect(validationWanted({ ropts: {}, allowSoftware: false, storage: st, key })).toBe(true)
    writeValidationCache(st, key)
    expect(validationWanted({ ropts: {}, allowSoftware: false, storage: st, key })).toBe(false)
    expect(validationWanted({ ropts: { gpuValidate: true }, allowSoftware: false, storage: st, key })).toBe(true)
    expect(validationWanted({ ropts: {}, allowSoftware: true, storage: null, key })).toBe(false)
    expect(validationWanted({ ropts: { gpuValidate: true }, allowSoftware: true, storage: null, key })).toBe(true)
    expect(validationWanted({ ropts: { gpuValidate: false }, allowSoftware: false, storage: null, key })).toBe(false)
  })
  it('survives a broken storage', () => {
    const boom = { getItem() { throw new Error('denied') }, setItem() { throw new Error('denied') } }
    expect(readValidationCache(boom, 'k')).toBe(false); expect(() => writeValidationCache(boom, 'k')).not.toThrow()
  })
})

describe('GPU health policy', () => {
  const feed = (h, secs, ms, budget = 16.7, floor = true) => { for (let t = 0; t < secs * 1000; t += ms) h.update(ms, budget, floor); return h.verdict }
  it('stays healthy at the budget', () => { expect(feed(createGpuHealth(), 30, 16.7)).toBe('healthy') })
  it('goes slow only after sustained frames above 2x the budget at the floor', () => {
    const h = createGpuHealth()
    expect(feed(h, GPU_HEALTH.warmupMs / 1000 + 4, 50)).toBe('healthy')          // one slow window is not enough
    expect(feed(h, 4, 50)).toBe('slow')
  })
  it('a frame time under 2x never trips it; not at the floor never trips it', () => {
    expect(feed(createGpuHealth(), 30, 30)).toBe('healthy')
    expect(feed(createGpuHealth(), 30, 60, 16.7, false)).toBe('healthy')
  })
  it('ignores the warm-up and stalls, and a good window resets the strikes', () => {
    const h = createGpuHealth()
    feed(h, 3, 200)                                    // warm-up: ignored
    h.update(5000, 16.7, true)                         // a stall (hidden tab)
    expect(feed(h, 4, 50)).toBe('healthy')            // strike 1
    feed(h, 4, 16.7)                                   // a healthy window resets
    expect(feed(h, 4, 50)).toBe('healthy')            // strike 1 again, not 2
  })
  it('isSlowWindow and shouldDowngradeGpu', () => {
    expect(isSlowWindow(40, 16.7, true)).toBe(true); expect(isSlowWindow(40, 16.7, false)).toBe(false); expect(isSlowWindow(30, 16.7, true)).toBe(false)
    expect(shouldDowngradeGpu({ verdict: 'slow', kind: 'gpu', pref: 'gpu' })).toBe(true)
    expect(shouldDowngradeGpu({ verdict: 'slow', kind: 'gpu', pref: 'auto' })).toBe(true)
    expect(shouldDowngradeGpu({ verdict: 'slow', kind: 'gpu', pref: null })).toBe(false)
    expect(shouldDowngradeGpu({ verdict: 'slow', kind: 'cpu', pref: 'gpu' })).toBe(false)
    expect(shouldDowngradeGpu({ verdict: 'healthy', kind: 'gpu', pref: 'gpu' })).toBe(false)
  })
})
