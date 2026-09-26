// Fixer JW / HS-2: the GPU world pass fogs its walls, floor and ceiling toward the SAME colour as the CPU renderer (gfx-cpu.js), the GPU core
// (gfx-gl.js, fs.fogRgb) and so the sprite and post stages: hexToRgb(resolvePalette(config.palette, levelKey(config)).fog). A palette whose fog hex
// is missing or garbled (a wish-drifted one) therefore fogs toward the LEVEL's stock fog, not a neutral grey. Fake WebGL2 (no GPU): the uFogL uniform
// the pass sets is recorded and compared.
import { describe, it, expect } from 'vitest'
import { createWorldPass } from '../src/renderer/gfx-gl-world.js'
import { buildTextures, resolvePalette } from '../src/renderer/gfx-textures.js'
import { createLight } from '../src/renderer/gfx-light.js'
import { levelConfig } from '../src/renderer/levels.js'
import { DEFAULT_CONFIG, createChunkCache, CHUNK_SIZE } from '../src/renderer/world.js'
import { hexToRgb, levelKey } from '../src/renderer/gfx-util.js'
import { qualityFor } from '../src/renderer/gfx-quality.js'
import { buildFrameState } from '../src/renderer/gfx-frame.js'
import { fakeGl } from './gfx-hp-fakes.js'

// a fake context that also records every uniform3f by name
function recordingGl() {
  const gl = fakeGl()
  const u3 = []
  const g = new Proxy(gl, { get(o, k) { if (k === 'uniform3f') return (loc, a, b, c) => { u3.push([loc && loc.n, a, b, c]) }; return o[k] } })
  return { gl: g, u3 }
}

// one GPU world frame of level `lvl` with `palette`, at `tier`; fsFog: the fs.fogRgb the core would hand over (undefined: none). -> the uFogL set
function fogUniform(lvl, palette, tier, fsFog) {
  const base = levelConfig(DEFAULT_CONFIG, lvl)
  const cfg = { ...base, palette }
  const key = levelKey(cfg)
  const tex = buildTextures(resolvePalette(palette, key), cfg.materials, cfg.look, key)
  const light = createLight(cfg, {})
  const { gl, u3 } = recordingGl()
  const pass = createWorldPass({ gl, config: cfg, tex, light, materialAt: null, tri: { draw() {}, dispose() {} }, caps: { maxTexture: 4096, maxArrayLayers: 256 }, ropts: { qualityTier: tier } })
  const cache = createChunkCache(cfg, 0)
  const player = { x: 11.5, y: 19.5, angle: 1.2, bobOffset: 0 }
  const pcx = Math.floor(player.x / CHUNK_SIZE), pcy = Math.floor(player.y / CHUNK_SIZE)
  const q = qualityFor(tier)
  const fs = buildFrameState({ W: 64, H: 36, OW: 128, OH: 72, fog: cfg.fogDistance, fogRgb: fsFog, fogMul: 1, flicker: 1, frame: 1,
    timing: { t: 0, dt: 1 / 60 }, player, lights: {}, lightsOn: cfg.lights !== false, hasSky: false, skyRgb: null, light, quality: q,
    opts: { qualityTier: tier }, levelKey: key, look: cfg.look })
  u3.length = 0
  pass.render(fs, (wx, wy) => cache.isWall(wx, wy, pcx, pcy))
  pass.dispose()
  const f = u3.filter((c) => c[0] === 'uFogL')
  expect(f.length).toBe(1)
  // undo the per-frame scale (legacy: flicker = 1; lit: fogGain × gdip) to recover the colour
  const k = tier === 'legacy' ? 1 : light.frame.fogGain * light.frame.gdip
  return f[0].slice(1).map((v) => Math.round(v * 255 / k))
}

describe('HS-2: the GPU world fog resolves like the CPU', () => {
  for (const lvl of [0, 2, 3]) {
    const stock = levelConfig(DEFAULT_CONFIG, lvl).palette
    const stockFog = hexToRgb(resolvePalette(stock, String(lvl)).fog)
    for (const [label, pal] of [['missing', (() => { const p = { ...stock }; delete p.fog; return p })()], ['garbled', { ...stock, fog: '#zz12' }], ['not a string', { ...stock, fog: 42 }]]) {
      for (const tier of ['legacy', 'medium']) {
        it(`level ${lvl}, fog hex ${label}, ${tier}: fogs toward the level's stock fog (what the CPU uses), not neutral grey`, () => {
          const cpu = hexToRgb(resolvePalette(pal, String(lvl)).fog)       // gfx-cpu.js / gfx-gl.js
          expect(cpu).toEqual(stockFog)
          expect(fogUniform(lvl, pal, tier, undefined)).toEqual(cpu)
        })
      }
    }
    it(`level ${lvl}: a valid palette is unchanged`, () => {
      expect(fogUniform(lvl, stock, 'medium', undefined)).toEqual(hexToRgb(stock.fog))
      expect(fogUniform(lvl, stock, 'legacy', undefined)).toEqual(hexToRgb(stock.fog))
    })
  }
  it('the frame\'s own fs.fogRgb (the colour the sprites and the post pass fog toward) is the one the world pass uses', () => {
    expect(fogUniform(2, levelConfig(DEFAULT_CONFIG, 2).palette, 'medium', [10, 200, 30])).toEqual([10, 200, 30])
    expect(fogUniform(0, levelConfig(DEFAULT_CONFIG, 0).palette, 'legacy', [90, 80, 70])).toEqual([90, 80, 70])
  })
  it('the stock fog of level 2 is not the neutral grey (the old fallback), so the test above can tell them apart', () => {
    expect(hexToRgb(resolvePalette({}, '2').fog)).not.toEqual([200, 200, 200])
  })
})
