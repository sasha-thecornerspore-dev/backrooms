// Track HW, stage 2: castColumns answers a cell's second and later isWall asks of a frame from a per-frame memo. The world must see the
// same FIRST ask of every cell, in the same order, as without the memo (that is where the chunk cache generates chunks), the frame must be
// the same to the byte, and with a fog so deep that the rays could reach an evictable chunk the memo must stay off (every ask passes). The closure
// declares the chunk it hands the cache (isWall.pcx / .pcy), as the memo requires since WO-1 (test/gfx-jw-memo.test.js: the undeclared and stale cases).
import { describe, it, expect } from 'vitest'
import { renderWorld } from '../src/renderer/gfx-world.js'
import { createLight } from '../src/renderer/gfx-light.js'
import { renderWorld as refRenderWorld } from './gfx-hw-ref/gfx-world.js'
import { createLight as refCreateLight } from './gfx-hw-ref/gfx-light.js'
import { buildTexturesMemo } from '../src/renderer/gfx-textures.js'
import { levelConfig } from '../src/renderer/levels.js'
import { DEFAULT_CONFIG, createChunkCache, CHUNK_SIZE } from '../src/renderer/world.js'
import { hexToRgb, levelKey } from '../src/renderer/gfx-util.js'
import { qualityFor } from '../src/renderer/gfx-quality.js'
import { buildFrameState } from '../src/renderer/gfx-frame.js'

function run(ref, level, tier, pose, fogMul, frames) {
  const cfg = levelConfig(DEFAULT_CONFIG, level)
  const cache = createChunkCache(cfg, 0)
  cache.preload(0, 0)
  const tex = buildTexturesMemo(cfg.palette, cfg.materials, cfg.look, levelKey(cfg))
  const light = (ref ? refCreateLight : createLight)(cfg, {})
  const q = qualityFor(tier)
  const W = Math.round(320 * q.scale), H = Math.round(180 * q.scale)
  const buf = new Uint32Array(W * H), z = new Float32Array(W)
  const logs = [], bufs = []
  for (let i = 0; i < frames; i++) {
    const player = { x: pose.x + i * 0.37, y: pose.y + i * 0.11, angle: pose.a + i * 0.3, bobOffset: 0 }
    const pcx = Math.floor(player.x / CHUNK_SIZE), pcy = Math.floor(player.y / CHUNK_SIZE)
    const log = []
    const isWall = (wx, wy) => { log.push(Math.floor(wx) + ',' + Math.floor(wy)); return cache.isWall(wx, wy, pcx, pcy) }
    isWall.pcx = pcx; isWall.pcy = pcy
    const fs = buildFrameState({ W, H, OW: 320, OH: 180, fog: cfg.fogDistance * fogMul, fogRgb: hexToRgb(cfg.palette.fog), fogMul, flicker: 1, frame: i + 1,
      timing: { t: i / 30, dt: 1 / 30 }, player, lights: {}, lightsOn: cfg.lights !== false, hasSky: false, skyRgb: null, light, quality: q,
      opts: { qualityTier: tier }, levelKey: levelKey(cfg), look: cfg.look })
    ;(ref ? refRenderWorld : renderWorld)(fs, tex, light, isWall, null, buf, z)
    logs.push(log); bufs.push(Buffer.from(buf.buffer).toString('base64') + Buffer.from(z.buffer).toString('base64'))
  }
  return { logs, bufs }
}
const firstAsks = (log) => { const seen = new Set(), out = []; for (const c of log) if (!seen.has(c)) { seen.add(c); out.push(c) } return out }

describe('the per-frame isWall memo of castColumns', () => {
  for (const [level, tier, pose] of [[0, 'legacy', { x: 11.5, y: 19.5, a: 1.57 }], [0, 'medium', { x: 11.5, y: 19.5, a: 0.4 }], [2, 'high', { x: 33.5, y: -3.5, a: 4.7 }], [3, 'low', { x: -4.5, y: -10.5, a: 3.1 }]]) {
    it(`level ${level} ${tier}: the same frames, the same first asks in the same order, far fewer asks`, () => {
      const a = run(false, level, tier, pose, 1, 6), b = run(true, level, tier, pose, 1, 6)
      expect(a.bufs).toEqual(b.bufs)
      let live = 0, refN = 0
      for (let i = 0; i < a.logs.length; i++) {
        expect(firstAsks(a.logs[i]), `frame ${i}`).toEqual(firstAsks(b.logs[i]))
        live += a.logs[i].length; refN += b.logs[i].length
      }
      expect(live).toBeLessThan(refN * 0.5)
    })
  }
  it('a fog deep enough for the rays to pass 40 units: no memo, every ask reaches the world', () => {
    const a = run(false, 0, 'medium', { x: 11.5, y: 19.5, a: 1.57 }, 3, 3), b = run(true, 0, 'medium', { x: 11.5, y: 19.5, a: 1.57 }, 3, 3)
    expect(a.bufs).toEqual(b.bufs)
    expect(a.logs).toEqual(b.logs)
  })
})
