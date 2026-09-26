// W2-07: gfx-util.js hash2 multiplies with Math.imul, so it is exact for every 32-bit input and equals the GPU's wrapping uint hash
// (gfx-gl-world-shader.js hash2u, spelled out in JS as gfx-gl-world-data.js hash2Ref). It used to multiply a and b in doubles; that is the
// same 32-bit product exactly while the product fits a double's 53-bit mantissa, so the change must not move a single value in that range
// (every per-cell variant, lamp, cloud and grain position the game has ever drawn). hash2Legacy keeps the old construction for the callers
// whose keys are full-range hashes (panel flicker noise, sprite seeds).
import { describe, it, expect } from 'vitest'
import { hash2, hash2Legacy, mulberry32 } from '../src/renderer/gfx-util.js'
import { hash2Ref } from '../src/renderer/gfx-gl-world-data.js'

// the old hash2, verbatim (what hash2 was before W2-07)
const oldHash2 = (a, b, c = 0) => {
  let h = (a * 2654435761 ^ b * 2246822519 ^ Math.imul(c, 3266489917)) >>> 0
  h ^= h >>> 16; h = Math.imul(h, 0x45d9f3b) >>> 0
  h ^= h >>> 16
  return h >>> 0
}
// every third channel the renderer passes today: floor 1 / ceiling 2 / wall side 0|1, sprite salts 3 4 5 7 91, the panel and lamp salts,
// the cloud seed, the grain salts, the attract seed, the panel-noise salt
const CHANNELS = [0, 1, 2, 3, 4, 5, 7, 91, 0x51, 0x1a3f, 0x2c10d5, 0x51ed, 0x9e37, 0x0A77AC7]
// the largest |a| whose double product a * 2654435761 is still exact (2^53 / 2654435761); b's constant is smaller, so a's bound is the binding one
const EXACT = Math.floor(2 ** 53 / 2654435761)

describe('W2-07 hash2 is exact and unchanged where it was exact', () => {
  it('equals the old double-multiply hash densely around the origin, for every channel in use', () => {
    let bad = 0
    for (const c of CHANNELS) for (let a = -200; a <= 200; a++) for (let b = -200; b <= 200; b++) if (hash2(a, b, c) !== oldHash2(a, b, c)) bad++
    expect(bad).toBe(0)
  }, 30000)

  it('equals the old hash for random cells across [-3e6, 3e6] and at the very edge of the exact range', () => {
    const r = mulberry32(0x5eed2077)
    const cell = () => Math.floor((r() * 2 - 1) * 3e6)
    let bad = 0
    for (let i = 0; i < 200000; i++) {
      const a = cell(), b = cell(), c = CHANNELS[i % CHANNELS.length]
      if (hash2(a, b, c) !== oldHash2(a, b, c)) bad++
    }
    for (const a of [3e6, -3e6, EXACT, -EXACT, EXACT - 1, -(EXACT - 1)]) for (const b of [0, 1, -1, 3e6, -3e6, EXACT, -EXACT]) for (const c of CHANNELS) {
      if (hash2(a, b, c) !== oldHash2(a, b, c)) bad++
    }
    expect(bad).toBe(0)
  }, 30000)

  it('equals the GPU hash (hash2Ref, uint arithmetic) for every 32-bit input, including where the old hash was not exact', () => {
    const r = mulberry32(0x61bc)
    const i32 = () => ((r() * 4294967296) | 0)
    let bad = 0
    for (let i = 0; i < 200000; i++) {
      const a = i32(), b = i32(), c = i % 3 === 0 ? CHANNELS[i % CHANNELS.length] : (r() * 4294967296) >>> 0
      if (hash2(a, b, c) !== hash2Ref(a, b, c)) bad++
    }
    expect(bad).toBe(0)
    for (const a of [2147483647, -2147483648, 4294967295, 1e9, -1e9, EXACT + 1]) for (const b of [0, 2147483647, -2147483648, 7e6]) expect(hash2(a, b, 2)).toBe(hash2Ref(a, b, 2))
    // uint32 keys above 2^31 hash like their int32 alias (ToInt32 wraps), exactly as the shader's uint(int) does
    expect(hash2(4294967295, 5)).toBe(hash2(-1, 5))
  }, 30000)

  it('the old construction really was inexact out there (so the new one is a real change beyond the range, and hash2Legacy is needed)', () => {
    let differ = 0
    for (let a = 1e9; a < 1e9 + 100; a++) if (oldHash2(a, 3, 1) !== hash2Ref(a, 3, 1)) differ++
    expect(differ).toBeGreaterThan(90)
  }, 30000)

  it('hash2Legacy is the old construction, bit for bit, at any input (the frozen callers keep their output)', () => {
    const r = mulberry32(0x1e6ac7)
    let bad = 0
    for (let i = 0; i < 100000; i++) {
      const a = (r() * 4294967296) >>> 0, b = Math.floor((r() * 2 - 1) * 1e5), c = CHANNELS[i % CHANNELS.length]
      if (hash2Legacy(a, b, c) !== oldHash2(a, b, c)) bad++
    }
    expect(bad).toBe(0)
  }, 30000)

  it('always returns an unsigned 32-bit integer', () => {
    for (const [a, b, c] of [[0, 0, 0], [-1, -1, -1], [2147483647, -2147483648, 4294967295], [123456789, -987654321, 0x9e37]]) {
      for (const h of [hash2(a, b, c), hash2Legacy(a, b, c)]) { expect(Number.isInteger(h)).toBe(true); expect(h).toBeGreaterThanOrEqual(0); expect(h).toBeLessThanOrEqual(0xFFFFFFFF) }
    }
  }, 30000)
})
