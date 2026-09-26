// Track HW, stage 2 (the speed of the CPU world pass). Every speed-up of renderWorld / light.prepare / renderSky is meant to change NOT ONE
// output byte, so this draws the same frames through the live modules and through frozen copies of them from before the speed work
// (test/gfx-hw-ref/, see their header) and requires the world buffer, the z-buffer, the handled flags and the light model's per-frame state
// (the tables and scalars the sprite pass and the GPU path read, and the query functions) to be identical, frame after frame: standing,
// walking and turning (new cells for the occupancy window and the lightmap), flicker events (per-panel and per-lamp dimming, the flicker
// budget), the flashlight and the glowstick, a fog push, the comfort settings, odd buffer widths and a horizon pushed off the frame.
import { describe, it, expect } from 'vitest'
import { renderWorld } from '../src/renderer/gfx-world.js'
import { createLight } from '../src/renderer/gfx-light.js'
import { renderSky } from '../src/renderer/gfx-sky.js'
import { renderWorld as refRenderWorld } from './gfx-hw-ref/gfx-world.js'
import { createLight as refCreateLight } from './gfx-hw-ref/gfx-light.js'
import { renderSky as refRenderSky } from './gfx-hw-ref/gfx-sky.js'
import { buildTexturesMemo } from '../src/renderer/gfx-textures.js'
import { levelConfig } from '../src/renderer/levels.js'
import { DEFAULT_CONFIG, createChunkCache, CHUNK_SIZE } from '../src/renderer/world.js'
import { createFixedMap } from '../src/renderer/fixedmap.js'
import { hexToRgb, levelKey } from '../src/renderer/gfx-util.js'
import { qualityFor } from '../src/renderer/gfx-quality.js'
import { buildFrameState } from '../src/renderer/gfx-frame.js'

const rad = (d) => (d * Math.PI) / 180
// the harness poses (tools/gfx/scenes.js) of the five levels, a Level ∅ view across the yard, and two faces pressed to a wall (the near
// wall's long texel runs; the walk then carries the player into the wall cell itself)
const POSES = [
  { level: 0, x: 11.5, y: 19.5, a: 90 }, { level: 1, x: 11.5, y: 19.5, a: 90 }, { level: 2, x: 33.5, y: -3.5, a: 270 },
  { level: 3, x: -4.5, y: -10.5, a: 180 }, { level: 4, x: 12.5, y: 13.0, a: 90 }, { level: 4, x: 4.5, y: 15.0, a: -20 },
  { level: 0, x: 11.5, y: 19.5, a: 180 }, { level: 2, x: 33.5, y: -3.5, a: 0 },
]

// one side (live or reference) of a comparison: its own world (so the chunk cache sees its own calls), light, frame state
function side(pose, tier, size, comfort, ref) {
  const cfg = levelConfig(DEFAULT_CONFIG, pose.level)
  const cache = cfg.map ? createFixedMap(cfg.map) : createChunkCache(cfg, 0)
  cache.preload(0, 0)
  const hooks = cfg.map ? { materialAt: (wx, wy) => cache.materialAt(wx, wy) } : {}
  const key = levelKey(cfg)
  const tex = buildTexturesMemo(cfg.palette, cfg.materials, cfg.look, key)
  const light = (ref ? refCreateLight : createLight)(cfg, hooks)
  const q = qualityFor(tier)
  const W = Math.max(1, Math.round(size.w * q.scale)), H = Math.max(1, Math.round(size.h * q.scale))
  const buf = new Uint32Array(W * H), z = new Float32Array(W)
  const fogRgb = hexToRgb(cfg.palette.fog)
  const opts = { qualityTier: tier, ...comfort }
  let frame = 0
  return {
    W, H, buf, z, light,
    step(ov) {
      frame++
      const player = ov.player
      const pcx = Math.floor(player.x / CHUNK_SIZE), pcy = Math.floor(player.y / CHUNK_SIZE)
      const isWall = (wx, wy) => cache.isWall(wx, wy, pcx, pcy)
      const fs = buildFrameState({
        W, H, OW: size.w, OH: size.h, fog: cfg.fogDistance * (ov.fogMul || 1), fogRgb, fogMul: ov.fogMul || 1, flicker: ov.flicker ?? 1, frame,
        timing: ov.timing, player, lights: ov.lights || {}, lightsOn: cfg.lights !== false, hasSky: !!cfg.sky, skyRgb: cfg.sky ? hexToRgb(cfg.sky) : null,
        light, quality: q, opts, levelKey: key, look: cfg.look,
      })
      ;(ref ? refRenderWorld : renderWorld)(fs, tex, light, isWall, hooks.materialAt || null, buf, z)
      return fs
    },
  }
}

// the frame sequence: stand, walk and turn, a flicker event (deep, then shallow, then deep), the flashlight, the glowstick, both, a fog
// push, and two frames whose horizon is pushed off the top and the bottom of the frame (the floor pass's exact per-row fallback)
function frameAt(pose, i) {
  const a0 = rad(pose.a)
  const ov = { timing: { t: i / 30, dt: 1 / 30 }, player: { x: pose.x, y: pose.y, angle: a0, bob: 0, bobOffset: 0 } }
  if (i >= 3) {
    const k = i - 3
    ov.player = { ...ov.player, x: pose.x + Math.cos(a0) * 0.19 * k, y: pose.y + Math.sin(a0) * 0.19 * k, angle: a0 + 0.05 * k * (k % 5 < 3 ? 1 : -0.7), bobOffset: (k % 5) - 2 }
  }
  if (i >= 4 && i < 15) ov.flicker = i < 8 ? 0.2 : i < 11 ? 0.6 : 0.05
  if (i >= 2 && i < 7) ov.lights = { flashlight: true }
  else if (i >= 7 && i < 11) ov.lights = { glow: [80, 235, 110] }
  else if (i >= 11 && i < 14) ov.lights = { flashlight: true, glow: [200, 120, 255] }
  if (i === 15 || i === 16) ov.fogMul = 1.6
  if (i === 17) ov.player = { ...ov.player, bobOffset: -400 }
  if (i === 18) ov.player = { ...ov.player, bobOffset: 400 }
  return ov
}
const FRAMES = 19

function lightState(L, fs) {
  const F = L.frame
  const out = { enabled: L.enabled }
  if (F) {
    for (const k of ['lm', 'lev', 'lampLev', 'cellBits', 'cellLamp', 'lmAny']) out[k] = F[k] ? Buffer.from(F[k].buffer, F[k].byteOffset, F[k].byteLength).toString('base64') : null
    for (const k of ['gdip', 'dimS', 'eS', 'lmMax', 'dimmed', 'lampDim', 'flash', 'glow', 'occR', 'occCx', 'occCy', 'lmR', 'levN', 'levI0', 'levJ0', 'glowK', 'ts']) out[k] = F[k]
  }
  if (L.enabled) {
    const p = fs.player, q = []
    for (let k = 0; k < 10; k++) {
      const wx = p.x + Math.cos(k) * k * 0.7, wy = p.y + Math.sin(k * 1.3) * k * 0.6
      q.push(L.at(wx, wy), ...L.tint(wx, wy), L.panelLevel(Math.floor(wx), Math.floor(wy), fs), JSON.stringify(L.nearest(wx, wy)))
    }
    out.queries = q
  }
  return out
}

describe('the faster CPU world pass draws exactly what it drew before (frozen reference in test/gfx-hw-ref/)', () => {
  const cases = []
  for (const tier of ['legacy', 'low', 'medium', 'high']) {
    for (const [pi, pose] of POSES.entries()) {
      const size = pi % 2 ? { w: 333, h: 187 } : { w: 320, h: 180 }                // odd internal widths too
      const comfort = pi % 3 === 0 ? {} : pi % 3 === 1 ? { maxGlobalDip: 0.5 } : { maxGlobalDip: 0.5, reduceFlicker: true }
      cases.push({ tier, pose, size, comfort })
    }
  }
  for (const c of cases) {
    it(`${c.tier} level ${c.pose.level} (${c.pose.x}, ${c.pose.y}) ${c.size.w}x${c.size.h} ${JSON.stringify(c.comfort)}: ${FRAMES} frames`, () => {
      const live = side(c.pose, c.tier, c.size, c.comfort, false), ref = side(c.pose, c.tier, c.size, c.comfort, true)
      for (let i = 0; i < FRAMES; i++) {
        const ov = frameAt(c.pose, i)
        const fl = live.step(ov), fr = ref.step(ov)
        let first = -1
        for (let k = 0; k < live.buf.length; k++) if (live.buf[k] !== ref.buf[k]) { first = k; break }
        expect(first, `frame ${i}: first differing pixel`).toBe(-1)
        expect(Buffer.from(live.z.buffer).equals(Buffer.from(ref.z.buffer)), `frame ${i}: z-buffer`).toBe(true)
        expect(fl.handled, `frame ${i}: handled`).toEqual(fr.handled)
        expect(lightState(live.light, fl), `frame ${i}: light state`).toEqual(lightState(ref.light, fr))
      }
    }, 60000)
  }

  it('a hand-built frame with no light model and a 4-texel tile set (the legacy path, as gfx-world.test.js draws it)', () => {
    const isWall = (wx, wy) => wx <= 0 || wy <= 0 || wx >= 11 || wy >= 11
    const tile = (base) => { const t = new Uint8Array(48); for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) { const i = (y * 4 + x) * 3; t[i] = base + x; t[i + 1] = base + y; t[i + 2] = base } return t }
    const tex = { ts: 4, tmask: 3, walls: { 0: tile(100) }, ceil: tile(60), floor: tile(40), light: tile(200) }
    for (const [W, H, angle, flicker, lightsOn] of [[48, 32, 0, 1, false], [61, 37, 0.7, 0.6, true], [97, 55, 2.9, 1.3, true]]) {
      const bufs = [new Uint32Array(W * H), new Uint32Array(W * H)], zs = [new Float32Array(W), new Float32Array(W)]
      const fov = Math.PI / 2.4
      const fs = () => ({ W, H, HH: H >> 1, OW: W, OH: H, fog: 1e9, fogRgb: [212, 200, 122], fogMul: 1, flicker, frame: 1, t: 0, player: { x: 5.5, y: 5.5, angle, bobOffset: 0 },
        lights: {}, lightsOn, hasSky: false, skyRgb: null, quality: { scale: 0.6 }, opts: {}, fov, hf: fov / 2 })
      renderWorld(fs(), tex, null, isWall, null, bufs[0], zs[0])
      refRenderWorld(fs(), tex, null, isWall, null, bufs[1], zs[1])
      expect(Buffer.from(bufs[0].buffer).equals(Buffer.from(bufs[1].buffer))).toBe(true)
      expect(Buffer.from(zs[0].buffer).equals(Buffer.from(zs[1].buffer))).toBe(true)
    }
  })

  it('renderSky alone (no cover argument) is unchanged, and a cover row whose every column is open changes nothing', () => {
    const W = 101, H = 60
    const base = { W, H, HH: 31, skyRgb: [185, 183, 174], fogRgb: [150, 150, 146], flicker: 1, t: 12.5, hf: Math.PI / 4.8, player: { angle: 1.1 }, levelKey: '∅', quality: { lightDetail: 1 }, light: null }
    const a = new Uint32Array(W * H), b = new Uint32Array(W * H), c = new Uint32Array(W * H)
    renderSky({ ...base }, a)
    refRenderSky({ ...base }, b)
    renderSky({ ...base }, c, new Int32Array(W).fill(-(H + 2)))       // (castColumns' value for a column without a wall)
    expect(Buffer.from(a.buffer).equals(Buffer.from(b.buffer))).toBe(true)
    expect(Buffer.from(c.buffer).equals(Buffer.from(b.buffer))).toBe(true)
  })
})
