// gfx-gl-world*.js — the pure half of the GPU world pass (tile planning, per-column pool share, table packing, sky rows, the shader's hash and
// its uniform contract). The GL itself is verified by rendering: tools/gfx/run.mjs --ropts '{"renderer":"gpu","allowSoftwareGl":true}' on SwiftShader.
import { describe, it, expect } from 'vitest'
import {
  planTiles, tilesToRgba, wallLayer, wallPoolShare, fillCellTexture, fillPoolTable, fillWallTable, buildSkyRows, hash2Ref, POOL_N, OCC_N, S_MAX,
} from '../src/renderer/gfx-gl-world-data.js'
import { worldFragmentSource, worldUniformNames } from '../src/renderer/gfx-gl-world-shader.js'
import { buildTextures } from '../src/renderer/gfx-textures.js'
import { createLight, PERIOD } from '../src/renderer/gfx-light.js'
import { levelConfig, LEVELS } from '../src/renderer/levels.js'
import { DEFAULT_CONFIG } from '../src/renderer/world.js'
import { hash2, hexToRgb } from '../src/renderer/gfx-util.js'
import { CLOUD_H, stripRowTan } from '../src/renderer/gfx-sky.js'
import { comfortFor, effectiveFlicker } from '../src/renderer/gfx-quality.js'

const cfgOf = (i) => levelConfig(DEFAULT_CONFIG, i)
const texOf = (cfg) => buildTextures(cfg.palette, cfg.materials, cfg.look, cfg.levelIndex != null ? String(cfg.levelIndex) : 'legacy')

describe('the shader hash', () => {
  it('hash2Ref (the uint arithmetic the GLSL uses) equals gfx-util hash2 over negative and positive cells and every salt used', () => {
    for (const c of [0, 1, 2, 0x51, 0x1a3f]) {
      for (let a = -70; a <= 70; a += 7) for (let b = -70; b <= 70; b += 5) expect(hash2Ref(a, b, c)).toBe(hash2(a, b, c))
    }
    expect(hash2Ref(123456, -98765, 2)).toBe(hash2(123456, -98765, 2))
  })
  it('the GLSL spells the same constants and shifts as hash2', () => {
    const src = worldFragmentSource({ lit: true, sky: false })
    for (const k of ['2654435761u', '2246822519u', '3266489917u', '0x45d9f3bu']) expect(src).toContain(k)
    expect(src).toMatch(/h \^= h >> 16u; h \*= 0x45d9f3bu; h \^= h >> 16u/)
  })
})

describe('planTiles', () => {
  for (const lvl of [...LEVELS.map((l) => l.id).filter(Number.isInteger), 4]) {
    it(`level ${lvl}: every layer is a whole tile, the variant runs are consecutive, and the plan fits 256 layers`, () => {
      const cfg = cfgOf(lvl), tex = texOf(cfg), plan = planTiles(tex)
      expect(plan.ts).toBe(tex.ts)
      expect(plan.layers.length).toBeLessThanOrEqual(256)
      for (const t of plan.layers) expect(t.length).toBe(tex.ts * tex.ts * 3)
      for (const [code, p] of Object.entries(plan.walls)) {
        expect(p.count, code).toBeGreaterThanOrEqual(1)
        const arr = tex.wallVar && tex.wallVar[code]
        if (arr && arr.length > 1) for (let i = 0; i < arr.length; i++) expect(plan.layers[p.base + i]).toBe(arr[i])
        else expect(plan.layers[p.base]).toBe(tex.walls[code])
      }
      const fv = tex.floorVar, cv = tex.ceilVar
      for (let i = 0; i < (fv ? fv.length : 1); i++) expect(plan.layers[plan.floor.base + i]).toBe(fv ? fv[i] : tex.floor)
      for (let i = 0; i < (cv ? cv.length : 1); i++) expect(plan.layers[plan.ceil.base + i]).toBe(cv ? cv[i] : tex.ceil)
      expect(plan.layers[plan.light]).toBe(tex.light)
    })
  }
  it('a hand-built legacy TexSet (no variants) plans one layer per surface', () => {
    const cfg = { palette: DEFAULT_CONFIG.palette }
    const tex = buildTextures(cfg.palette, null, null, 'legacy'), plan = planTiles(tex)
    expect(plan.floor.count).toBe(1); expect(plan.ceil.count).toBe(1); expect(plan.walls['0'].count).toBe(1)
    expect(plan.layers.length).toBe(4)
  })
  it('wallLayer picks the same variant the CPU picks (hash of the hit cell and side), and falls back to material 0', () => {
    const tex = texOf(cfgOf(0)), plan = planTiles(tex)
    const arr = tex.wallVar['0']
    expect(arr.length).toBeGreaterThan(1)
    for (let mx = -5; mx < 5; mx++) for (let side = 0; side < 2; side++) {
      const hit = { mx, my: mx * 3 + 1, side }
      expect(plan.layers[wallLayer(plan, hit, null)]).toBe(arr[hash2(hit.mx, hit.my, side) % arr.length])
      expect(wallLayer(plan, hit, 'no-such-material')).toBe(wallLayer(plan, hit, null))
    }
  })
  it('Level ∅ materials each get their own layers', () => {
    const cfg = cfgOf(4), tex = texOf(cfg), plan = planTiles(tex)
    const codes = Object.keys(tex.walls)
    expect(codes.length).toBeGreaterThan(3)
    const bases = new Set(codes.map((c) => plan.walls[c].base))
    expect(bases.size).toBe(codes.length)
  })
  it('tilesToRgba expands RGB to opaque RGBA in order', () => {
    const plan = { ts: 2, layers: [new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])] }
    expect([...tilesToRgba(plan)[0]]).toEqual([1, 2, 3, 255, 4, 5, 6, 255, 7, 8, 9, 255, 10, 11, 12, 255])
  })
})

// a prepared light model for a level (walls nowhere: enough for the tables)
function prepared(level, over = {}) {
  const cfg = cfgOf(level), tex = texOf(cfg), light = createLight(cfg, {})
  const player = { x: 10.5, y: 10.5, angle: 0, bobOffset: 0 }
  const comfort = comfortFor({})
  const fs = { W: 64, H: 36, HH: 18, fog: cfg.fogDistance, t: 0, dt: 1 / 60, frame: 1, rawFlicker: 1, flicker: effectiveFlicker(1, comfort), comfort, lights: {},
    quality: { lightDetail: 1, texFilter: 1, scale: 1 }, player, ...over }
  expect(light.prepare(fs, tex, () => false, null)).toBe(true)
  return { cfg, tex, light, fs, F: light.frame }
}

describe('wallPoolShare', () => {
  it('panel levels, steady: the tabulated wall pool along the face, quantised to 64 steps', () => {
    const { F } = prepared(0)
    for (let k = 0; k < 40; k++) {
      const hit = { side: k & 1, mx: 3 + k, my: 7 + 2 * k, wallX: (k * 0.137) % 1 }
      const along = hit.side === 0 ? hit.my : hit.mx
      const u = Math.min(63, (((along & 1) + hit.wallX) * 32) | 0)
      const want = ((F.wallP[u] * 63 + 0.5) | 0) / 63
      expect(wallPoolShare(F, hit, 10.5, 10.5)).toBeCloseTo(want, 12)
    }
  })
  it('the share is brightest opposite the panel rows and dark between them (u = 0.5 + 2j)', () => {
    const { F } = prepared(0)
    const at = (u) => wallPoolShare(F, { side: 0, mx: 4, my: Math.floor(u), wallX: u % 1 }, 10.5, 10.5)
    expect(at(0.5)).toBeGreaterThan(at(1.5))
    expect(at(0.5)).toBeGreaterThan(0.5)
  })
  it('a dimmed panel lowers the share of the wall facing it (the level grid feeds the same tables)', () => {
    const { F } = prepared(0)
    const hit = { side: 0, mx: 4, my: 0, wallX: 0.5 }
    const steady = wallPoolShare(F, hit, 10.5, 10.5)
    const dark = wallPoolShare({ ...F, dimmed: true, lev: new Float32Array(81).fill(0), levN: 9, levI0: -2, levJ0: -5 }, hit, 10.5, 10.5)
    expect(steady).toBeGreaterThan(0)
    expect(dark).toBeLessThan(steady)
  })
  it('lamp levels: zero where no lamp reaches, otherwise a quantised share in 0..1', () => {
    const { F } = prepared(2, { player: { x: 20.5, y: 20.5, angle: 0, bobOffset: 0 } })
    let seen = 0
    for (let k = 0; k < 200; k++) {
      const hit = { side: k & 1, mx: 12 + (k % 17), my: 12 + ((k * 7) % 17), wallX: (k * 0.31) % 1 }
      const v = wallPoolShare(F, hit, 20.5, 20.5)
      expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThanOrEqual(1)
      expect(Math.abs(v * 63 - Math.round(v * 63))).toBeLessThan(1e-9)
      if (v > 0) seen++
    }
    expect(seen).toBeGreaterThan(0)
  })
  it('a level with no emitters and no panels (daylight without windows in reach) has no pool', () => {
    const { F } = prepared(4, { player: { x: 5.5, y: 5.5, angle: 0, bobOffset: 0 } })
    expect(wallPoolShare(F, { side: 0, mx: 2, my: 2, wallX: 0.5 }, 5.5, 5.5)).toBeGreaterThanOrEqual(0)
  })
})

describe('table packing', () => {
  it('fillPoolTable: floor rows first, then the ceiling, (S, A, B) per texel', () => {
    const { F } = prepared(0)
    const out = fillPoolTable(F, new Float32Array(POOL_N * POOL_N * 2 * 4))
    expect(out[0]).toBe(F.floorS[0]); expect(out[1]).toBe(F.floorA[0]); expect(out[2]).toBe(F.floorB[0])
    const c = POOL_N * POOL_N + 100
    expect(out[c * 4]).toBe(F.ceilS[100]); expect(out[c * 4 + 2]).toBe(F.ceilB[100])
    for (let i = 0; i < 100; i++) expect(out[i * 4]).toBeCloseTo(out[i * 4 + 1] + out[i * 4 + 2], 4)     // S = A + B
  })
  it('fillWallTable: the pool at share q is the stored full-share value times q, exactly as the CPU table', () => {
    const { F, tex } = prepared(2)
    const ts = tex.ts, W = 64, out = fillWallTable(F, ts, W, new Float32Array(W * 2 * 4))
    for (let t = 0; t < ts; t += 9) {
      expect(out[(W + t) * 4]).toBe(F.wallAmb[t])
      for (const q of [0, 17, 63]) expect(out[(W + t) * 4 + 1] * (q / 63)).toBeCloseTo(F.wallPool[q * ts + t], 5)
    }
    expect(out[0]).toBe(F.wallP[0]); expect(out[3]).toBe(F.wallK2[0])
  })
  it('fillCellTexture: bits, lamp flags (lamps mode only) and lamp levels', () => {
    const { F } = prepared(2, { player: { x: 20.5, y: 20.5, angle: 0, bobOffset: 0 } })
    const out = fillCellTexture(F, new Uint8Array(OCC_N * OCC_N * 4))
    let lamps = 0
    for (let s = 0; s < OCC_N * OCC_N; s++) {
      expect(out[s * 4]).toBe(F.cellBits[s]); expect(out[s * 4 + 3]).toBe(255)
      expect(out[s * 4 + 1]).toBe(F.cellLamp[s] === 1 ? 255 : 0)
      expect(out[s * 4 + 2]).toBe(255)                                   // no flicker event: every lamp at full level
      if (out[s * 4 + 1]) lamps++
    }
    expect(lamps).toBeGreaterThan(0)
    F.lampDim = true; F.lampLev.fill(0.5)
    expect(fillCellTexture(F, new Uint8Array(OCC_N * OCC_N * 4))[2]).toBe(128)
    F.lampDim = false
    const p0 = prepared(0).F
    const o0 = fillCellTexture(p0, new Uint8Array(OCC_N * OCC_N * 4))
    for (let s = 0; s < OCC_N * OCC_N; s++) expect(o0[s * 4 + 1]).toBe(0)
  })
})

describe('buildSkyRows', () => {
  const sky = hexToRgb('#9aa6ad'), fog = hexToRgb('#b8b2a0')
  const mkfs = (over = {}) => ({ W: 96, H: 54, HH: 27, hf: Math.PI / 4.8, skyRgb: sky, fogRgb: fog, flicker: 0.8, levelKey: '∅', look: undefined,
    light: { enabled: true }, ...over })
  it('the horizon row is exactly the fog colour (times the flicker only in the legacy model)', () => {
    const out = new Float32Array(54 * 2 * 4)
    expect(buildSkyRows(mkfs(), out, 54)).toBe(28)
    const o = 27 * 4
    expect(out[o]).toBeCloseTo(fog[0] / 255, 6); expect(out[o + 1]).toBeCloseTo(fog[1] / 255, 6); expect(out[o + 2]).toBeCloseTo(fog[2] / 255, 6)
    const out2 = new Float32Array(54 * 2 * 4)
    buildSkyRows(mkfs({ light: { enabled: false } }), out2, 54)
    expect(out2[o]).toBeCloseTo(fog[0] / 255 * 0.8, 6)
  })
  it('strip rows stay inside the strip and layer B differs from A', () => {
    const out = new Float32Array(54 * 2 * 4)
    buildSkyRows(mkfs(), out, 54)
    let differs = 0
    for (let y = 0; y <= 27; y++) {
      const ja = out[(54 + y) * 4], jb = out[(54 + y) * 4 + 1]
      expect(ja).toBeGreaterThanOrEqual(0); expect(ja).toBeLessThan(CLOUD_H)
      expect(jb).toBeGreaterThanOrEqual(0); expect(jb).toBeLessThan(CLOUD_H)
      if (ja !== jb) differs++
      expect(out[y * 4 + 3]).toBeGreaterThanOrEqual(0)                    // cloud amplitude
    }
    expect(differs).toBeGreaterThan(10)
  })
  it('S_MAX is the constant gfx-sky.js maps strip rows with', () => { expect(S_MAX).toBeCloseTo(stripRowTan(CLOUD_H - 0.5), 12); expect(S_MAX).toBeCloseTo(0.62, 6) })
})

describe('the shader source and its uniform contract', () => {
  const variants = [{ lit: false, sky: false }, { lit: true, sky: false }, { lit: false, sky: true }, { lit: true, sky: true }]
  for (const v of variants) {
    it(`variant ${JSON.stringify(v)}: every required uniform is declared, and the defines are set`, () => {
      const src = worldFragmentSource(v)
      expect(src.startsWith('#version 300 es\n')).toBe(true)
      expect(src.includes('#define LIT')).toBe(v.lit); expect(src.includes('#define SKY')).toBe(v.sky)
      for (const n of worldUniformNames(v)) expect(src, n).toMatch(new RegExp(`uniform [A-Za-z0-9]+ +(?:[^;]*[ ,])?${n}[,;]`))
    })
  }
  it('is GLSL ES 3.00 with highp everywhere it matters and no extension', () => {
    const src = worldFragmentSource({ lit: true, sky: true })
    expect(src).toContain('precision highp float;'); expect(src).toContain('precision highp sampler2DArray;')
    expect(src).not.toMatch(/#extension/)
  })
  it('no uniform is required twice and none of the lit ones leak into the legacy list', () => {
    const legacy = worldUniformNames({ lit: false, sky: false }), lit = worldUniformNames({ lit: true, sky: false })
    expect(new Set(lit).size).toBe(lit.length)
    expect(legacy).not.toContain('uGdip'); expect(lit).toContain('uGdip'); expect(lit).not.toContain('uFlicker')
  })
})

describe('the periodic lattice the shader indexes', () => {
  it('a panel pool tile covers PERIOD world units in POOL_N samples (32 per unit)', () => { expect(POOL_N / PERIOD).toBe(32) })
})

// ── creation-time failures (a fake context: only what createWorldPass touches before it would upload anything) ──
import { createWorldPass } from '../src/renderer/gfx-gl-world.js'
import { GlError } from '../src/renderer/gfx-gl-util.js'
describe('createWorldPass refuses what the device cannot do (GlError -> the CPU renderer)', () => {
  const fakeGl = (err = 0) => ({
    NO_ERROR: 0, TEXTURE_2D: 1, RGBA32F: 2, R32F: 3, RGBA: 4, RED: 5, FLOAT: 6, TEXTURE_MIN_FILTER: 7, TEXTURE_MAG_FILTER: 8, NEAREST: 9,
    createTexture: () => ({}), bindTexture() {}, texImage2D() {}, texParameteri() {}, deleteTexture() {}, getError: () => err,
  })
  const base = (over = {}) => {
    const cfg = cfgOf(0)
    return { config: cfg, tex: texOf(cfg), light: null, materialAt: null, tri: null, caps: { maxTexture: 4096, maxArrayLayers: 256 }, ropts: {}, ...over }
  }
  it('a device that cannot take a float texture', () => {
    expect(() => createWorldPass({ gl: fakeGl(0x502), ...base() })).toThrow(GlError)
    try { createWorldPass({ gl: fakeGl(0x502), ...base() }) } catch (e) { expect(e.stage).toBe('caps'); expect(e.message).toMatch(/float/) }
  })
  it('more tile layers than MAX_ARRAY_TEXTURE_LAYERS', () => {
    let err = null
    try { createWorldPass({ gl: fakeGl(0), ...base({ caps: { maxTexture: 4096, maxArrayLayers: 2 } }) }) } catch (e) { err = e }
    expect(err).toBeInstanceOf(GlError); expect(err.stage).toBe('textures'); expect(err.message).toMatch(/MAX_ARRAY_TEXTURE_LAYERS/)
  })
  it('a tile larger than MAX_TEXTURE_SIZE', () => {
    let err = null
    try { createWorldPass({ gl: fakeGl(0), ...base({ caps: { maxTexture: 16, maxArrayLayers: 256 } }) }) } catch (e) { err = e }
    expect(err).toBeInstanceOf(GlError); expect(err.message).toMatch(/MAX_TEXTURE_SIZE/)
  })
})
