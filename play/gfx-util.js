// gfx-util.js — tiny pure helpers shared by every renderer stage (CPU today, the WebGL path later).
// No DOM, no state: import-safe in Node so vitest can pin them.

export function hexToRgb(hex) {
  const n = parseInt(hex.replace('#', ''), 16)
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
// whose draw order would then have to be kept in sync. Math.imul is an exact 32-bit multiply, so this is
// identical on every engine. Not used by the pixel-identical refactor itself.
export function hash2(a, b, c = 0) {
  let h = (a * 2654435761 ^ b * 2246822519 ^ Math.imul(c, 3266489917)) >>> 0
  h ^= h >>> 16; h = Math.imul(h, 0x45d9f3b) >>> 0
  h ^= h >>> 16
  return h >>> 0
}
