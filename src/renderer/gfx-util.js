// gfx-util.js — tiny pure helpers shared by every renderer stage (CPU today, the WebGL path later).
// No DOM, no state: import-safe in Node so vitest can pin them.

// '#rrggbb' (the hash optional) -> [r, g, b]. A missing or unparsable hex (a config whose palette lacks a key, a wish that wrote
// garbage) never throws: it returns a copy of `fallback`, a neutral grey by default (the grey the post stages already use for a
// missing palette.fog). A valid hex parses exactly as it always did.
export const NEUTRAL_RGB = Object.freeze([200, 200, 200])
export function hexToRgb(hex, fallback = NEUTRAL_RGB) {
  const n = typeof hex === 'string' ? parseInt(hex.replace('#', ''), 16) : NaN
  if (n !== n) return [fallback[0], fallback[1], fallback[2]]
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}
export function lerp(a, b, t) { return a + (b - a) * t }
export function clamp255(v) { return v < 0 ? 0 : v > 255 ? 255 : v | 0 }

// small deterministic PRNG so the wallpaper is the same every launch
export function mulberry32(seed) {
  let s = seed >>> 0
  return () => {
    s += 0x6D2B79F5
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = t + Math.imul(t ^ (t >>> 7), 61 | t) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// The key a stage uses to look up its per-level defaults (surface styles, lighting, atmosphere): '0'..'3' and '∅', from the
// level config's `levelIndex`. A config with no level identity (tests, hand-built scenes) gets 'legacy' = today's look.
// Per-level data lives in each stage's OWN module, keyed by this; `config.look` is an optional override on top.
export function levelKey(config) {
  return config && config.levelIndex != null ? String(config.levelIndex) : 'legacy'
}

// Stateless integer hash of two lattice coordinates (+ an optional third channel, e.g. a seed) -> uint32.
// Same construction as the hash() in decor.js / items.js / scraps.js, so the renderer's per-cell variation
// (wall variants, decals, per-instance sprite jitter) can be derived from a cell address without a PRNG stream
// whose draw order would then have to be kept in sync. Every multiply is Math.imul (an exact 32-bit wrapping multiply), so
// this is exact for EVERY 32-bit input and equals the GPU's uint hash (gfx-gl-world-shader.js hash2u) everywhere. It used to
// multiply a and b in doubles (`a * 2654435761`), which is the same 32-bit product only while the product is exact
// (|a|, |b| below ~3.39e6); test/gfx-hw-hash.test.js proves the two agree over that whole range, so no cell the game can
// reach changed its variant. Integer inputs only (a fraction is truncated toward zero first, as ToInt32 does).
export function hash2(a, b, c = 0) {
  let h = (Math.imul(a, 2654435761) ^ Math.imul(b, 2246822519) ^ Math.imul(c, 3266489917)) >>> 0
  h ^= h >>> 16; h = Math.imul(h, 0x45d9f3b) >>> 0
  h ^= h >>> 16
  return h >>> 0
}

// The OLD construction, frozen: a and b multiplied in doubles, so beyond |a|, |b| ~ 3.39e6 the product is rounded and the
// result is no longer the 32-bit hash (but it is still deterministic on every engine: IEEE doubles). Only for callers
// whose keys are already full-range uint32 values (a hash of a hash, a string hash) and whose baked output must not move:
// the per-panel flicker noise (gfx-light.js panelNoise) and the sprite seeds (gfx-sprites.js seedOf). New code uses hash2.
export function hash2Legacy(a, b, c = 0) {
  let h = (a * 2654435761 ^ b * 2246822519 ^ Math.imul(c, 3266489917)) >>> 0
  h ^= h >>> 16; h = Math.imul(h, 0x45d9f3b) >>> 0
  h ^= h >>> 16
  return h >>> 0
}
