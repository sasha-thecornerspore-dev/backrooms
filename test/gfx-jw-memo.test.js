// Fixer JW / WO-1: the per-frame isWall memo of the rays (gfx-world.js wallMemo) is exact only while no chunk a ray touches can be evicted during
// the frame, which holds when the chunk the caller's closure hands the cache (pcx, pcy) is near the rendered pose. That precondition is now
// CHECKED (memoSafe): the caller declares isWallFn.pcx / .pcy (and .evictRadius when the level overrides it), and the memo runs only when every
// chunk the rays can reach is within the eviction radius of the declared chunk. A closure built for another pose (a stale pcx), an undeclared
// one, or a declared radius the rays outreach: every ask reaches the world, in the straightforward loop's order, so the render never generates or
// regenerates a chunk the straightforward loop would not have (a regenerated chunk of a procedural level is a DIFFERENT maze: gameplay state).
import { describe, it, expect } from 'vitest'
import { renderWorld, rayAsk, rayAskDone } from '../src/renderer/gfx-world.js'
import { createLight } from '../src/renderer/gfx-light.js'
import { renderWorld as refRenderWorld } from './gfx-hw-ref/gfx-world.js'
import { createLight as refCreateLight } from './gfx-hw-ref/gfx-light.js'
import { buildTexturesMemo } from '../src/renderer/gfx-textures.js'
import { levelConfig } from '../src/renderer/levels.js'
import { DEFAULT_CONFIG, createChunkCache, CHUNK_SIZE } from '../src/renderer/world.js'
import { hexToRgb, levelKey } from '../src/renderer/gfx-util.js'
import { qualityFor } from '../src/renderer/gfx-quality.js'
import { buildFrameState } from '../src/renderer/gfx-frame.js'

// o: { level, tier, pose, frames, stale: [pcx, pcy] | null (the closure's chunk; null = the pose's own), tag: 'none' | 'true' (declare what
// the closure passes) | { pcx, pcy } (declare this), evictRadius (the level's), seed (undefined: procedural epochs, as in solo play) }
function run(ref, o) {
  const cfg = { ...levelConfig(DEFAULT_CONFIG, o.level), ...(o.evictRadius !== undefined ? { chunkEvictRadius: o.evictRadius } : {}) }
  const cache = createChunkCache(cfg, o.seed === undefined ? null : o.seed)
  // 49 chunks around the origin: the cache is full, so every chunk generated from now on evicts relative to the pcx it is handed
  for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) cache.getChunk(dx, dy, 0, 0)
  const tex = buildTexturesMemo(cfg.palette, cfg.materials, cfg.look, levelKey(cfg))
  const light = (ref ? refCreateLight : createLight)(cfg, {})
  const q = qualityFor(o.tier)
  const W = Math.round(240 * q.scale), H = Math.round(135 * q.scale)
  const buf = new Uint32Array(W * H), z = new Float32Array(W)
  const logs = [], bufs = []
  let pcx = 0, pcy = 0
  for (let i = 0; i < o.frames; i++) {
    const player = { x: o.pose.x + i * 0.37, y: o.pose.y + i * 0.11, angle: o.pose.a + i * 0.3, bobOffset: 0 }
    if (o.stale) { pcx = o.stale[0]; pcy = o.stale[1] } else { pcx = Math.floor(player.x / CHUNK_SIZE); pcy = Math.floor(player.y / CHUNK_SIZE) }
    const log = []
    const isWall = (wx, wy) => { log.push(Math.floor(wx) + ',' + Math.floor(wy)); return cache.isWall(wx, wy, pcx, pcy) }
    if (o.tag === 'true') { isWall.pcx = pcx; isWall.pcy = pcy; if (o.evictRadius !== undefined) isWall.evictRadius = o.evictRadius }
    else if (o.tag && typeof o.tag === 'object') Object.assign(isWall, o.tag)
    const fs = buildFrameState({ W, H, OW: 240, OH: 135, fog: cfg.fogDistance, fogRgb: hexToRgb(cfg.palette.fog), fogMul: 1, flicker: 1, frame: i + 1,
      timing: { t: i / 30, dt: 1 / 30 }, player, lights: {}, lightsOn: cfg.lights !== false, hasSky: false, skyRgb: null, light, quality: q,
      opts: { qualityTier: o.tier }, levelKey: levelKey(cfg), look: cfg.look })
    ;(ref ? refRenderWorld : renderWorld)(fs, tex, light, isWall, null, buf, z)
    logs.push(log); bufs.push(Buffer.from(buf.buffer).toString('base64') + Buffer.from(z.buffer).toString('base64'))
  }
  // the world after the frames: a probe of the cells around the pose (the same asks on both sides, so an equal state gives an equal probe)
  let probe = ''
  const px = Math.floor(o.pose.x), py = Math.floor(o.pose.y)
  for (let y = py - 30; y <= py + 30; y += 3) for (let x = px - 30; x <= px + 30; x += 3) probe += cache.isWall(x, y, pcx, pcy) ? '1' : '0'
  return { logs, bufs, probe }
}
const asks = (r) => r.logs.reduce((n, l) => n + l.length, 0)

const FAR = { x: 500.5, y: 500.5, a: 0.7 }          // chunk (22, 22), far from the stale (0, 0)
describe('WO-1: the isWall memo runs only under its (checked) contract', { timeout: 120000 }, () => {
  for (const [level, tier] of [[0, 'legacy'], [0, 'medium'], [2, 'high'], [3, 'low']]) {
    for (const tag of ['none', 'true']) {
      it(`level ${level} ${tier}, a closure over a STALE chunk (0, 0), ${tag === 'none' ? 'undeclared' : 'declared truthfully'}: every ask reaches the world, the world ends the same`, () => {
        const o = { level, tier, pose: FAR, frames: 3, stale: [0, 0], tag }
        const a = run(false, o), b = run(true, o)
        expect(a.bufs).toEqual(b.bufs)
        expect(a.logs).toEqual(b.logs)             // the same asks in the same order: the cache generated and evicted exactly the same chunks
        expect(a.probe).toBe(b.probe)
      })
    }
  }
  it('an undeclared closure over the right chunk: no memo either (the contract cannot be checked), the same frames and asks', () => {
    const o = { level: 0, tier: 'medium', pose: { x: 11.5, y: 19.5, a: 1.57 }, frames: 3, tag: 'none' }
    const a = run(false, o), b = run(true, o)
    expect(a.bufs).toEqual(b.bufs); expect(a.logs).toEqual(b.logs); expect(a.probe).toBe(b.probe)
  })
  it('a declared chunk the rays can outreach (a level with chunkEvictRadius 0): no memo', () => {
    const o = { level: 0, tier: 'medium', pose: { x: 11.5, y: 19.5, a: 1.57 }, frames: 3, tag: 'true', evictRadius: 0 }
    const a = run(false, o), b = run(true, o)
    expect(a.bufs).toEqual(b.bufs); expect(a.logs).toEqual(b.logs); expect(a.probe).toBe(b.probe)
  })
  it('a declared chunk far from the pose (whatever the closure really does): no memo', () => {
    const o = { level: 2, tier: 'high', pose: FAR, frames: 3, stale: [0, 0], tag: { pcx: 5, pcy: 5 } }
    const a = run(false, o), b = run(true, o)
    expect(a.logs).toEqual(b.logs); expect(a.probe).toBe(b.probe)
  })
  for (const [level, tier, pose] of [[0, 'medium', { x: 11.5, y: 19.5, a: 0.4 }], [2, 'high', FAR], [3, 'low', { x: -4.5, y: -10.5, a: 3.1 }]]) {
    it(`level ${level} ${tier}, declared and current (as the game, the benchmark and the title attract render): the memo runs, the frames and the world are the same`, () => {
      const o = { level, tier, pose, frames: 4, tag: 'true' }
      const a = run(false, o), b = run(true, o)
      expect(a.bufs).toEqual(b.bufs)
      expect(a.probe).toBe(b.probe)
      const first = (l) => [...new Set(l)]
      for (let i = 0; i < a.logs.length; i++) expect(first(a.logs[i]), `frame ${i}`).toEqual(first(b.logs[i]))
      expect(asks(a)).toBeLessThan(asks(b) * 0.8)      // (the light model's own asks are in the logs too)
    })
  }
})

describe('rayAsk (the pair the CPU and the GPU world passes cast with)', () => {
  const tagged = (pcx, pcy, er) => { const f = (wx, wy) => false; f.pcx = pcx; f.pcy = pcy; if (er !== undefined) f.evictRadius = er; return f }
  const at = (c) => c * CHUNK_SIZE + CHUNK_SIZE / 2
  it('undeclared: the closure itself', () => {
    const fn = (wx, wy) => false
    expect(rayAsk(fn, 32, 11.5, 11.5)).toBe(fn); rayAskDone()
  })
  it('declared over the pose\'s chunk, rays within MEMO_RAY: the memo', () => {
    const f = tagged(22, -3)
    expect(rayAsk(f, 32, at(22), at(-3))).not.toBe(f); rayAskDone()
  })
  it('declared one chunk off: the memo only while every reachable chunk stays within the radius of the declared one', () => {
    // from the middle of chunk 22 the rays (32 + 2 units) reach chunks 20..24: all within 3 of chunk 21, not all of chunk 25
    const g = tagged(21, 22); expect(rayAsk(g, 32, at(22), at(22))).not.toBe(g); rayAskDone()
    const f = tagged(25, 22); expect(rayAsk(f, 32, at(22), at(22))).toBe(f); rayAskDone()
  })
  it('a stale chunk, a non-integer chunk, a NaN pose, rays past MEMO_RAY, a radius the rays outreach: the closure itself', () => {
    let f = tagged(0, 0); expect(rayAsk(f, 32, 500.5, 500.5)).toBe(f)
    f = tagged(0.5, 0); expect(rayAsk(f, 32, 11, 11)).toBe(f)
    f = tagged(0, 0); expect(rayAsk(f, 32, NaN, 11)).toBe(f)
    f = tagged(0, 0); expect(rayAsk(f, 41, 11, 11)).toBe(f)
    f = tagged(0, 0, 1); expect(rayAsk(f, 32, 11, 11)).toBe(f)
    f = tagged(0, 0, -1); expect(rayAsk(f, 32, 11, 11)).toBe(f)
    rayAskDone()
  })
})
