// Fixer JW / WO-2: the lit floor / ceiling skip their per-channel clamp only where a bound proves no channel can pass 255. The bound used to
// leave out the lit fog (gXb + gXk × pool), so a bright fog palette on the lamp levels (fogGlow 2.2) could push a channel to 256+ and `| 0`
// spilled it into the next channel (red 261 -> 5, green + 1). Each frame here is drawn twice, once as shipped and once with every pixel clamped
// (WORLD_TEST.clampAlways): the two must be the same to the byte, for a bright fog and for the shipped palettes alike.
import { describe, it, expect, afterEach } from 'vitest'
import { renderWorld, WORLD_TEST } from '../src/renderer/gfx-world.js'
import { createLight } from '../src/renderer/gfx-light.js'
import { buildTexturesMemo } from '../src/renderer/gfx-textures.js'
import { levelConfig } from '../src/renderer/levels.js'
import { DEFAULT_CONFIG, createChunkCache, CHUNK_SIZE } from '../src/renderer/world.js'
import { hexToRgb, levelKey, mulberry32 } from '../src/renderer/gfx-util.js'
import { qualityFor } from '../src/renderer/gfx-quality.js'
import { buildFrameState } from '../src/renderer/gfx-frame.js'

afterEach(() => { WORLD_TEST.clampAlways = false })

function rig(level, fogHex) {
  const base = levelConfig(DEFAULT_CONFIG, level)
  const cfg = fogHex ? { ...base, palette: { ...base.palette, fog: fogHex } } : base
  const key = levelKey(cfg)
  return { cfg, key, cache: createChunkCache(cfg, 0), tex: buildTexturesMemo(cfg.palette, cfg.materials, cfg.look, key), light: createLight(cfg, {}) }
}
// one frame -> the packed pixels (a copy)
function frame(r, tier, W, H, pose, flicker, lights, n) {
  const q = qualityFor(tier)
  const player = { x: pose.x, y: pose.y, angle: pose.a, bobOffset: 0 }
  const pcx = Math.floor(player.x / CHUNK_SIZE), pcy = Math.floor(player.y / CHUNK_SIZE)
  const fs = buildFrameState({ W, H, OW: W * 2, OH: H * 2, fog: r.cfg.fogDistance, fogRgb: hexToRgb(r.cfg.palette.fog), fogMul: 1, flicker, frame: n,
    timing: { t: n / 30, dt: 1 / 30 }, player, lights, lightsOn: r.cfg.lights !== false, hasSky: false, skyRgb: null, light: r.light, quality: q,
    opts: { qualityTier: tier }, levelKey: r.key, look: r.cfg.look })
  const buf = new Uint32Array(W * H), z = new Float32Array(W)
  renderWorld(fs, r.tex, r.light, (wx, wy) => r.cache.isWall(wx, wy, pcx, pcy), null, buf, z)
  return buf
}
// draw `count` random frames both ways (shipped, then clamp-always on a fresh rig so the light model's state is the same) -> [frames, differing]
function sweep(level, fogHex, count, seed) {
  const rand = mulberry32(seed)
  const a = rig(level, fogHex), b = rig(level, fogHex)
  let diff = 0, first = null
  for (let i = 0; i < count; i++) {
    const tier = ['low', 'medium', 'high'][i % 3]
    const W = 120 + ((rand() * 120) | 0), H = 68 + ((rand() * 68) | 0)
    // along the main halls (every chunk's middle row / column is open), where the lamps and their pools are
    const along = rand() < 0.5, c = (Math.floor(rand() * 5) - 2) * CHUNK_SIZE + 11.5, s = (rand() - 0.5) * 60
    const pose = { x: along ? s : c, y: along ? c : s, a: rand() * Math.PI * 2 }
    const flicker = 0.85 + rand() * 0.15
    const lights = rand() < 0.3 ? { flashlight: true } : {}
    WORLD_TEST.clampAlways = false
    const p = frame(a, tier, W, H, pose, flicker, lights, i + 1)
    WORLD_TEST.clampAlways = true
    const q = frame(b, tier, W, H, pose, flicker, lights, i + 1)
    WORLD_TEST.clampAlways = false
    for (let k = 0; k < p.length; k++) {
      if (p[k] !== q[k]) { diff++; if (!first) first = { i, tier, W, H, pose, k, got: p[k].toString(16), want: q[k].toString(16) }; break }
    }
  }
  return { diff, first }
}

describe('WO-2: the lit floor / ceiling never wrap a channel', { timeout: 120000 }, () => {
  for (const level of [2, 3]) {
    it(`level ${level} with a bright fog (#F0F0F0): every frame equals its fully clamped twin`, () => {
      const r = sweep(level, '#F0F0F0', 90, 0x5eed + level)
      expect(r.first).toBe(null)
      expect(r.diff).toBe(0)
    })
    it(`level ${level} with a white fog (#FFFFFF): the same`, () => {
      expect(sweep(level, '#FFFFFF', 45, 0xf0f + level).first).toBe(null)
    })
  }
  for (const level of [0, 1, 2, 3]) {
    it(`level ${level} with its shipped palette: the same (the skipped clamp never mattered there)`, () => {
      expect(sweep(level, null, 30, 0xabc + level).first).toBe(null)
    })
  }
})
