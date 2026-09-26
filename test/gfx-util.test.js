// gfx-util.js — the tiny pure helpers every renderer stage shares. The mulberry32 sequences below were captured
// from the ORIGINAL renderer.js implementation before the module split, so they also pin that the move was exact.
import { describe, it, expect } from 'vitest'
import { hexToRgb, lerp, clamp255, mulberry32, hash2 } from '../src/renderer/gfx-util.js'

describe('mulberry32', () => {
  const take = (seed, n) => { const r = mulberry32(seed); return Array.from({ length: n }, () => r()) }

  it('is deterministic: the same seed yields the same stream', () => {
    expect(take(0x0BACC000, 64)).toEqual(take(0x0BACC000, 64))
    expect(take(0x51CE, 64)).toEqual(take(0x51CE, 64))
  })

  it('matches the streams captured from the original implementation', () => {
    expect(take(0x0BACC000, 5)).toEqual([0.345225824508816, 0.4032386336475611, 0.863488182425499, 0.7345225990284234, 0.9729765956290066])
    expect(take(0x51CE, 5)).toEqual([0.15349651197902858, 0.946511322632432, 0.6712024272419512, 0.6194265512749553, 0.9049263868946582])
    expect(take(0, 5)).toEqual([0.26642920868471265, 0.0003297457005828619, 0.2232720274478197, 0.1462021479383111, 0.46732782293111086])
    expect(take(1, 5)).toEqual([0.6270739405881613, 0.002735721180215478, 0.5274470399599522, 0.9810509674716741, 0.9683778982143849])
  })

  it('different seeds diverge, and every draw is in [0, 1)', () => {
    expect(take(1, 8)).not.toEqual(take(2, 8))
    for (const v of take(12345, 2000)) { expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThan(1) }
  })

  it('streams are independent: drawing from one does not perturb another', () => {
    const a = mulberry32(7), b = mulberry32(7)
    const solo = Array.from({ length: 10 }, () => a())
    const other = mulberry32(99)
    const interleaved = Array.from({ length: 10 }, () => { other(); return b() })
    expect(interleaved).toEqual(solo)
  })
})

describe('hash2', () => {
  it('is stable: pinned values (a change here changes every per-cell variation derived from it)', () => {
    expect(hash2(0, 0)).toBe(0)
    expect(hash2(1, 0)).toBe(1667036862)
    expect(hash2(0, 1)).toBe(1599693741)
    expect(hash2(3, 7)).toBe(3754555947)
    expect(hash2(-5, 12)).toBe(1725196028)
    expect(hash2(100, 200, 0)).toBe(hash2(100, 200))
    expect(hash2(100, 200, 7)).toBe(848121429)
  })

  it('returns an unsigned 32-bit integer', () => {
    for (let a = -20; a < 20; a++) for (let b = -20; b < 20; b++) {
      const h = hash2(a, b, 3)
      expect(Number.isInteger(h)).toBe(true)
      expect(h).toBeGreaterThanOrEqual(0)
      expect(h).toBeLessThanOrEqual(0xFFFFFFFF)
    }
  })

  it('the third channel (seed) changes the result, and neighbouring cells differ', () => {
    expect(hash2(4, 9, 1)).not.toBe(hash2(4, 9, 2))
    const seen = new Set()
    for (let a = 0; a < 32; a++) for (let b = 0; b < 32; b++) seen.add(hash2(a, b))
    expect(seen.size).toBe(32 * 32)   // no collisions across a small lattice
  })

  it('has the same construction as the placement hash in decor.js / items.js (seed 0 = the unseeded world)', () => {
    const ref = (a, b, c = 0) => {
      let h = (a * 2654435761 ^ b * 2246822519 ^ Math.imul(c, 3266489917)) >>> 0
      h ^= h >>> 16; h = Math.imul(h, 0x45d9f3b) >>> 0
      h ^= h >>> 16
      return h >>> 0
    }
    for (const [a, b, c] of [[0, 0, 0], [5, -3, 0], [-40, 77, 9], [1e6, -1e6, 123456]]) expect(hash2(a, b, c)).toBe(ref(a, b, c))
  })
})

describe('colour helpers', () => {
  it('hexToRgb parses #rrggbb with or without the hash', () => {
    expect(hexToRgb('#C8B870')).toEqual([200, 184, 112])
    expect(hexToRgb('4A3820')).toEqual([74, 56, 32])
    expect(hexToRgb('#000000')).toEqual([0, 0, 0])
    expect(hexToRgb('#ffffff')).toEqual([255, 255, 255])
  })

  it('clamp255 clamps and truncates toward zero', () => {
    expect(clamp255(-3)).toBe(0)
    expect(clamp255(0)).toBe(0)
    expect(clamp255(127.9)).toBe(127)
    expect(clamp255(255)).toBe(255)
    expect(clamp255(300)).toBe(255)
  })

  it('lerp interpolates linearly', () => {
    expect(lerp(10, 20, 0)).toBe(10)
    expect(lerp(10, 20, 1)).toBe(20)
    expect(lerp(10, 20, 0.25)).toBe(12.5)
  })
})

import { levelKey } from '../src/renderer/gfx-util.js'
describe('levelKey', () => {
  it('keys per-level defaults by the config\'s levelIndex, and falls back to legacy for hand-built configs', () => {
    expect(levelKey({ levelIndex: 0 })).toBe('0')
    expect(levelKey({ levelIndex: 3 })).toBe('3')
    expect(levelKey({ levelIndex: '∅' })).toBe('∅')
    expect(levelKey({})).toBe('legacy')
    expect(levelKey(null)).toBe('legacy')
    expect(levelKey(undefined)).toBe('legacy')
  })
})
