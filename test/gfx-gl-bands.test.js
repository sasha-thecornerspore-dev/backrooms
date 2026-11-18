// The storeys on the GPU: the pure half of the world pass's band canvas. The GL itself
// is verified by rendering (tools/gfx/run.mjs --ropts '{"renderer":"gpu","allowSoftwareGl":true}' on SwiftShader, compared with the CPU by
// tools/gfx/compare.mjs); here, as for the rest of gfx-gl-world, what the CPU hands the shader and the shader's own arithmetic, mirrored in fp32:
//   - planTiles(tex, { bands }) lays every ground-storey pair on consecutive layers and every upper tile on one, inside the layer budget
//   - bandLayers picks, for every face of the block, the very tiles the CPU's band column picks (pickBands)
//   - the shader's bandAt (the row's band and its layer) agrees with the CPU's canvas row, but for rows within a hair of a band seam
//   - wallRows packs the taller wall's rows exactly as castColumns casts them; the wall table carries the band canvas's light
import { describe, it, expect } from 'vitest'
import { planTiles, bandLayers, fillWallTable, POOL_N } from '../src/renderer/gfx-gl-world-data.js'
import { wallRows } from '../src/renderer/gfx-gl-world.js'
import { worldFragmentSource, worldUniformNames } from '../src/renderer/gfx-gl-world-shader.js'
import { COL_ROWS } from '../src/renderer/gfx-gl-util.js'
import { pickBands } from '../src/renderer/gfx-world.js'
import { buildTexturesMemo } from '../src/renderer/gfx-textures.js'
import { createLight } from '../src/renderer/gfx-light.js'
import { buildFrameState } from '../src/renderer/gfx-frame.js'
import { levelConfig, LEVELS } from '../src/renderer/levels.js'
import { DEFAULT_CONFIG } from '../src/renderer/world.js'
import { createFixedMap, fixedMapHooks } from '../src/renderer/fixedmap.js'
import { facadeFor } from '../src/renderer/block-stacks.js'
import { hash2, hexToRgb, levelKey, mulberry32 } from '../src/renderer/gfx-util.js'
import { qualityFor } from '../src/renderer/gfx-quality.js'

const BLOCK = LEVELS.findIndex((l) => l.id === '∅')
const cfg = levelConfig(DEFAULT_CONFIG, BLOCK)
const map = createFixedMap(cfg.map)
const hooks = fixedMapHooks(map, facadeFor(cfg))
const tex = buildTexturesMemo(cfg.palette, cfg.materials, cfg.look, levelKey(cfg))
const W = cfg.map[0].length, H = cfg.map.length
const open = (x, y) => !map.isWall(x + 0.5, y + 0.5)
const faces = []
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  if (open(x, y)) continue
  if ((x > 0 && open(x - 1, y)) || (x < W - 1 && open(x + 1, y))) faces.push({ mx: x, my: y, side: 0 })
  if ((y > 0 && open(x, y - 1)) || (y < H - 1 && open(x, y + 1))) faces.push({ mx: x, my: y, side: 1 })
}

describe('planTiles with the band tiles', () => {
  const plain = planTiles(tex), plan = planTiles(tex, { bands: true })
  it('without opts.bands the plan is what it always was (and never builds the bands of a level that draws none)', () => {
    expect(plain.bands).toBe(null)
    expect(plan.layers.slice(0, plain.layers.length)).toEqual(plain.layers)
    expect(plan.walls).toEqual(plain.walls); expect(plan.floor).toEqual(plain.floor); expect(plan.ceil).toEqual(plain.ceil); expect(plan.light).toBe(plain.light)
  })
  it('every ground-storey pair on two consecutive layers, every upper tile on a layer, within the 220-layer budget', () => {
    const B = tex.wallBands
    for (const code of Object.keys(B.code)) for (const p of B.code[code]) {
      const i = plan.bands.pair.get(p)
      expect(plan.layers[i]).toBe(p[0]); expect(plan.layers[i + 1]).toBe(p[1])
    }
    for (const s of B.upper) {
      if (s.lower) for (const p of s.lower) { const i = plan.bands.pair.get(p); expect(plan.layers[i]).toBe(p[0]); expect(plan.layers[i + 1]).toBe(p[1]) }
      // a painted house's own ground storey, per code
      if (s.lowerBy) for (const ps of Object.values(s.lowerBy)) for (const p of ps) { const i = plan.bands.pair.get(p); expect(plan.layers[i]).toBe(p[0]); expect(plan.layers[i + 1]).toBe(p[1]) }
      for (const p of s.variants) { expect(plan.layers[plan.bands.layer.get(p[0])]).toBe(p[0]); expect(plan.layers[plan.bands.layer.get(p[1])]).toBe(p[1]) }
    }
    expect(plan.layers.length).toBeLessThanOrEqual(220)
    for (const t of plan.layers) expect(t.length).toBe(64 * 64 * 3)
  })
  it('bandLayers: every face of the block samples the tiles the CPU picks, in every band', () => {
    const out = [0, 0, 0, 0], BT = [null, null, null, null]
    for (const hit of faces) {
      const mat = map.materialAt(hit.mx + 0.5, hit.my + 0.5), st = hooks.stackAt(hit.mx, hit.my, hit.side)
      expect(st).toBeGreaterThanOrEqual(0)
      bandLayers(plan, hit, mat, st, out)
      const wkey = tex.walls[mat] ? mat : '0'
      const arr = tex.wallVar[wkey], one = arr && arr.length > 1 ? arr[hash2(hit.mx, hit.my, hit.side) % arr.length] : tex.walls[wkey]
      pickBands(tex.wallBands, wkey, st, hit.mx, hit.my, hit.side, one, BT)
      expect(plan.layers[out[0]]).toBe(BT[0]); expect(plan.layers[out[0] + out[3]]).toBe(BT[1])
      expect(plan.layers[out[1]]).toBe(BT[2]); expect(plan.layers[out[2]]).toBe(BT[3])
      expect(out[3]).toBe(1)
    }
  })
  it('a face with no stack takes its code\'s pair and the plain storey; a plan without bands repeats the 1-cell layer', () => {
    const hit = faces[0], mat = map.materialAt(hit.mx + 0.5, hit.my + 0.5)
    const out = bandLayers(plan, hit, mat, -1)
    expect(plan.layers[out[1]]).toBe(tex.wallBands.fallback[0]); expect(plan.layers[out[2]]).toBe(tex.wallBands.fallback[1])
    const none = bandLayers(plain, hit, mat, 3)
    expect(none[1]).toBe(-1); expect(none[2]).toBe(-1); expect(none[3]).toBe(0)
  })
})

describe('the shader\'s band canvas (bandAt, mirrored in fp32) agrees with the CPU\'s', () => {
  const f = Math.fround
  // GLSL: v = (y - wtF) / whF; vc = v + (uBands - 1); bt = clamp(floor(vc), 0, uBands - 1); band = uBands - 1 - bt
  const gpuBand = (y, corr, Hh, HH, NB) => {
    const whF = f(f(Hh) / f(Math.max(0.001, corr))), wtF = f(f(HH) - f(whF * 0.5))
    const v = f(f(y - wtF) / whF), vc = f(v + (NB - 1))
    const bt = Math.min(NB - 1, Math.max(0, Math.floor(vc)))
    return { band: NB - 1 - bt, row: Math.floor(Math.min(f(vc * 64), NB * 64 - 1)), vc }
  }
  // the CPU: V = ((y - wtC) * TS / whF) | 0 with wtC = wtF - whF (NB - 1), band NB - 1 - (V >> 6)
  const cpuBand = (y, corr, Hh, HH, NB) => {
    const whF = Hh / Math.max(0.001, corr), wtF = HH - whF / 2, wtC = wtF - whF * (NB - 1)
    let V = ((y - wtC) * 64 / whF) | 0
    if (V > NB * 64 - 1) V = NB * 64 - 1
    return { band: NB - 1 - (V >> 6), row: V }
  }
  it('the band of every wall row, near and far, level and pitched, over 4000 random walls', () => {
    const r = mulberry32(0x5eb2)
    let rows = 0, seam = 0
    for (let n = 0; n < 4000; n++) {
      const Hh = 2 * (60 + ((r() * 300) | 0)), HH = Hh / 2 + Math.round((r() * 2 - 1) * 0.3 * Hh), corr = 0.4 + r() * 22
      const rw = wallRows(corr, Hh, HH, 3.5), y0 = Math.floor(rw / 4096), y1 = rw - y0 * 4096
      for (let y = y0; y < y1; y += 1 + ((r() * 5) | 0)) {
        const g = gpuBand(y, corr, Hh, HH, 4), c = cpuBand(y, corr, Hh, HH, 4)
        rows++
        if (Math.abs(g.vc - Math.round(g.vc)) < 2e-4) { seam++; continue }      // within a hair of a band seam: either band is a rounding
        expect(g.band).toBe(c.band)
        expect(Math.abs(g.row - c.row)).toBeLessThanOrEqual(1)                  // the light table's row: the same, or its neighbour at a texel edge
      }
    }
    expect(rows).toBeGreaterThan(10000); expect(seam / rows).toBeLessThan(0.01)
  })
  it('the layer each band samples: band 0 the column\'s, band 1 the next (a pair), bands 2 and 3 row 2\'s; -1 falls back', () => {
    const layerOf = (band, c0z, c2) => (band < 0.5 ? c0z : band < 1.5 ? c0z + c2[2] : band < 2.5 ? (c2[0] >= 0 ? c2[0] : c0z) : (c2[1] >= 0 ? c2[1] : c0z))
    expect([0, 1, 2, 3].map((b) => layerOf(b, 40, [70, 71, 1]))).toEqual([40, 41, 70, 71])
    expect([0, 1, 2, 3].map((b) => layerOf(b, 12, [-1, -1, 0]))).toEqual([12, 12, 12, 12])
    // the same expression in the source
    const src = worldFragmentSource({ lit: true, sky: true })
    expect(src).toContain('float layer = band < 0.5 ? c0.z : band < 1.5 ? c0.z + c2.z : band < 2.5 ? (c2.x >= 0.0 ? c2.x : c0.z) : (c2.y >= 0.0 ? c2.y : c0.z);')
  })
})

describe('what the world pass hands the shader', () => {
  it('wallRows(corr, H, HH, wallH): the rows castColumns casts (the foot unchanged, the top wallH - 0.5 cells over the eye); wallH 1 as before', () => {
    const r = mulberry32(77)
    for (let n = 0; n < 3000; n++) {
      const Hh = 100 + ((r() * 900) | 0), HH = (Hh / 2 + (r() - 0.5) * 200) | 0, corr = 0.3 + r() * 25
      const whF = Hh / Math.max(0.001, corr), wtF = HH - whF / 2
      const y0 = Math.max(0, Math.ceil(wtF - whF * 2.5)), y1 = Math.min(Hh, Math.floor(wtF + whF))
      expect(wallRows(corr, Hh, HH, 3.5)).toBe(y1 <= y0 ? 0 : y0 * 4096 + y1)
      expect(wallRows(corr, Hh, HH, 1)).toBe(wallRows(corr, Hh, HH))
    }
  })
  it('the column texture has a third row (the band layers) and the shader reads it; uWallH and uBands are required uniforms', () => {
    expect(COL_ROWS).toBe(3)
    for (const v of [{ lit: false, sky: false }, { lit: true, sky: true }, { lit: false, sky: true }, { lit: true, sky: false }]) {
      const src = worldFragmentSource(v)
      expect(src).toContain('vec4 c2 = texelFetch(uCols, ivec2(int(x), 2), 0);')
      expect(src).toContain('vec3 bd = bandAt(y, c0, c2, whF, wtF);')
      expect(src).toMatch(/uniform float uWallH;/); expect(src).toMatch(/uniform float uBands;/)
      expect(worldUniformNames(v)).toEqual(expect.arrayContaining(['uWallH', 'uBands']))
      expect(src).toContain('float y0 = ceil(uWallH > 1.0 ? wtF - whF * (uWallH - 1.0) : wtF)')
    }
    // the lit wall reads the light of its canvas row on a taller wall, the old texel row on a 1-cell one
    expect(worldFragmentSource({ lit: true, sky: true })).toContain('int texY = uBands < 1.5 ? int(v * uTSf) & (int(uTSf) - 1) : int(bd.z);')
  })
  it('fillWallTable with bands: row 1 is the taller wall\'s light over its whole canvas', () => {
    const light = createLight(cfg, hooks)
    const fs = buildFrameState({ W: 64, H: 36, OW: 64, OH: 36, fog: 22, fogRgb: hexToRgb(cfg.palette.fog), fogMul: 1, flicker: 1, frame: 1,
      timing: { t: 0, dt: 1 / 60 }, player: { x: 12.5, y: 13, angle: 1, bobOffset: 0 }, lights: {}, lightsOn: false, hasSky: true,
      skyRgb: hexToRgb(cfg.sky), light, quality: qualityFor('high'), opts: {}, levelKey: '∅', look: cfg.look, wallH: 3.5, stackAt: hooks.stackAt })
    expect(light.prepare(fs, tex, () => false, null)).toBe(true)
    const F = light.frame, width = Math.max(POOL_N, 64 * 4), out = new Float32Array(width * 2 * 4)
    fillWallTable(F, 64, width, out, true)
    for (let t = 0; t < F.bandRows; t++) { expect(out[(width + t) * 4]).toBe(F.bandAmb[t]); expect(out[(width + t) * 4 + 1]).toBe(F.bandPool[63 * F.bandRows + t]) }
    const one = new Float32Array(Math.max(POOL_N, 64) * 2 * 4)
    fillWallTable(F, 64, Math.max(POOL_N, 64), one)
    for (let t = 0; t < 64; t++) expect(one[(64 + t) * 4]).toBe(F.wallAmb[t])
  })
})
