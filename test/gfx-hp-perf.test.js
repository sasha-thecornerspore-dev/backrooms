// Track HP / task 3: CPU post optimisations that must not change a single output byte. The pure parts are pinned here against straight
// reference implementations (the pre-optimisation code, inlined); the Canvas2D parts (clip rectangles) are pinned by their geometry, and the
// harness (tools/gfx, byte-identical over every scene at every tier) is the end-to-end check.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { blur5x3, bloomField, haloRect, lightBox, drawLights, resolveAtmos } from '../src/renderer/gfx-post.js'
import { fakeDoc2d } from './gfx-hp-fakes.js'

afterEach(() => { vi.unstubAllGlobals() })

// the blur exactly as it was before the interior fast path
function blurRef(P, tmp, w, h) {
  const s3 = w * 3
  for (let y = 0; y < h; y++) {
    const row = y * s3
    for (let x = 0; x < w; x++) {
      const i = row + x * 3
      const a = row + (x < 2 ? 0 : x - 2) * 3, b = row + (x < 1 ? 0 : x - 1) * 3, d = row + (x > w - 2 ? w - 1 : x + 1) * 3, e = row + (x > w - 3 ? w - 1 : x + 2) * 3
      tmp[i] = (P[a] + P[e] + 4 * (P[b] + P[d]) + 6 * P[i]) * 0.0625
      tmp[i + 1] = (P[a + 1] + P[e + 1] + 4 * (P[b + 1] + P[d + 1]) + 6 * P[i + 1]) * 0.0625
      tmp[i + 2] = (P[a + 2] + P[e + 2] + 4 * (P[b + 2] + P[d + 2]) + 6 * P[i + 2]) * 0.0625
    }
  }
  for (let y = 0; y < h; y++) {
    const ra = (y < 2 ? 0 : y - 2) * s3, rb = (y < 1 ? 0 : y - 1) * s3, ri = y * s3, rd = (y > h - 2 ? h - 1 : y + 1) * s3, re = (y > h - 3 ? h - 1 : y + 2) * s3
    for (let x = 0; x < s3; x++) P[ri + x] = (tmp[ra + x] + tmp[re + x] + 4 * (tmp[rb + x] + tmp[rd + x]) + 6 * tmp[ri + x]) * 0.0625
  }
}
function rng(seed) { let s = seed >>> 0; return () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 4294967296) }

describe('blur5x3: the interior fast path is bit-identical to the clamped loop', () => {
  it('every width and height from 1 to 9 and a few big ones, random planes', () => {
    const r = rng(7)
    for (const [w, h] of [...Array.from({ length: 81 }, (_, k) => [1 + (k % 9), 1 + ((k / 9) | 0)]), [120, 67], [30, 16], [241, 3]]) {
      const n = w * h * 3
      const A = new Float32Array(n), B = new Float32Array(n)
      for (let i = 0; i < n; i++) A[i] = B[i] = r() < 0.3 ? 0 : r() * 2
      blur5x3(A, new Float32Array(n), w, h); blurRef(B, new Float32Array(n), w, h)
      expect(Buffer.from(A.buffer).equals(Buffer.from(B.buffer)), `${w}x${h}`).toBe(true)
    }
  })
})

describe('bloomField: the halo support box', () => {
  const A = resolveAtmos({ levelIndex: 0, palette: { fog: '#D4C87A' } }).bloom
  const mkBl = (BW, BH) => {
    const wW = Math.max(2, BW >> 2), wH = Math.max(2, BH >> 2), n = BW * BH
    return { BW, BH, wW, wH, P: new Float32Array(n * 3), tmp: new Float32Array(n * 3), luma: new Uint8Array(n), W: new Float32Array(wW * wH * 3), wtmp: new Float32Array(wW * wH * 3), imgOut: { data: new Uint8ClampedArray(n * 4) } }
  }
  it('is exactly the bounding box of the non-transparent halo pixels, and follows a new frame', () => {
    const BW = 60, BH = 34, bl = mkBl(BW, BH)
    for (const spots of [[[40, 8]], [[5, 30], [50, 3]], [[30, 17]]]) {
      const px = new Uint8ClampedArray(BW * BH * 4)
      for (let i = 0; i < BW * BH; i++) { px[i * 4] = 40; px[i * 4 + 1] = 38; px[i * 4 + 2] = 30; px[i * 4 + 3] = 255 }
      for (const [x, y] of spots) for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) { const o = ((y + dy) * BW + x + dx) * 4; px[o] = px[o + 1] = 255; px[o + 2] = 230 }
      expect(bloomField(bl, px, A)).toBe(true)
      let x0 = BW, y0 = BH, x1 = -1, y1 = -1
      for (let y = 0; y < BH; y++) for (let x = 0; x < BW; x++) if (bl.imgOut.data[(y * BW + x) * 4 + 3] > 0) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y) }
      expect(bl.boxOn).toBe(true)
      expect(bl.box).toEqual([x0, y0, x1, y1])
      for (const [x, y] of spots) { expect(x0).toBeLessThanOrEqual(x); expect(x1).toBeGreaterThanOrEqual(x + 1); expect(y0).toBeLessThanOrEqual(y); expect(y1).toBeGreaterThanOrEqual(y + 1) }
    }
  })
})

describe('haloRect: where the upscaled, shifted halo can land', () => {
  it('covers the support plus the spread of the two smoothed doublings and the final smoothed scale, clamped to the frame', () => {
    const r = haloRect([10, 5, 12, 6], 120, 67, 960, 540, 0)
    const kx = 960 / 120, ky = 540 / 67
    expect(r[0]).toBeLessThanOrEqual(Math.floor(9 * kx) - 1); expect(r[0] + r[2]).toBeGreaterThanOrEqual(Math.ceil(14 * kx) + 1)
    expect(r[1]).toBeLessThanOrEqual(Math.floor(4 * ky) - 1); expect(r[1] + r[3]).toBeGreaterThanOrEqual(Math.ceil(8 * ky) + 1)
    const s = haloRect([10, 5, 12, 6], 120, 67, 960, 540, 37.5)                    // a turn shifts it with the halo
    expect(s[0]).toBeGreaterThan(r[0] + 30); expect(s[0]).toBeLessThanOrEqual(r[0] + 38); expect(s[2]).toBeGreaterThanOrEqual(r[2] - 1)
    expect(haloRect([0, 0, 119, 66], 120, 67, 960, 540, 0)).toEqual([0, 0, 960, 540])
    expect(haloRect([0, 0, 3, 3], 120, 67, 960, 540, -200)[2]).toBe(0)            // turned entirely off the left edge: nothing to draw
  })
})

describe('drawLights: the gradients fill only their bounding box', () => {
  const fs = (lights, OW = 1280, OH = 720) => ({ OW, OH, t: 0.3, lights, handled: { flashlight: false, glow: false } })
  it('flashlight and glowstick rectangles are the clamped circle boxes (the rest of the frame gets transparent black: untouched)', () => {
    vi.stubGlobal('document', fakeDoc2d())
    const ctx = document.createElement('canvas').getContext('2d')
    drawLights(ctx, fs({ flashlight: true, glow: [90, 255, 120] }))
    const rects = ctx.calls.filter((c) => c[0] === 'fillRect').map((c) => c.slice(1))
    expect(rects).toEqual([lightBox(640, 720 * 0.52, 720 * 0.72, 1280, 720), lightBox(640, 720 * 0.6, 720 * 0.62, 1280, 720)])
    expect(rects[0]).toEqual([Math.floor(640 - 518.4), 0, Math.ceil(640 + 518.4) - Math.floor(640 - 518.4), 720])
  })
  it('a portrait phone: the circle is wider than the canvas, the box is the whole canvas', () => {
    expect(lightBox(195, 844 * 0.52, 844 * 0.72, 390, 844)).toEqual([0, 0, 390, 844])
  })
})
