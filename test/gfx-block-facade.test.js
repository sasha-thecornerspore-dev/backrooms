// gfx-block-facade.test.js — Level ∅ (the block), the Harlem Park look, its material tiles:
// the recipe module (src/renderer/gfx-block-facade.js) and the tiles gfx-textures.js builds from it with look.facade 'harlem' and
// look.floor 'yard' (MATERIAL_STYLES_HP, FLOOR_STYLES.yard).
//   * the module's contract, purity and determinism
//   * seams: every variant keeps its base's outer columns (and rows, for the ground), and the brick runs on from bay to bay
//   * meanings: a lit window is bright and warm, the black window dark, the marble pale, the sealed door's frame reads against the
//     brick, the boards carry the crew mark
//   * the glyph test: no mark, placard or stroke decal reads as a digit or a letter
//   * palette drift: each piece follows its own material hex, and at the stock hexes a tile is the recipe exactly
//   * the legacy and look-less paths are untouched; the level carries the look; both offline shells carry the new modules
// Palettes and materials are copied from levels.js (not imported), as gfx-surfaces.test.js does.
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import * as BF from '../src/renderer/gfx-block-facade.js'
import { buildTextures } from '../src/renderer/gfx-textures.js'
import { planTiles } from '../src/renderer/gfx-gl-world-data.js'
import { LEVELS, levelConfig } from '../src/renderer/levels.js'
import { DEFAULT_CONFIG } from '../src/renderer/world.js'

vi.setConfig({ testTimeout: 60000 })

const TS = 64
const PAL = { wall: '#B8A888', ceiling: '#B9B7AE', floor: '#5A5048', fog: '#9A968C' }
const MATS = { F: '#B8A888', C: '#8F8F8F', P: '#7A6A52', B: '#8A4A3A', W: '#141414', O: '#7A5A48', M: '#D2D0C8' }
const LOOK = { facade: 'harlem', floor: 'yard' }
const CODES = ['F', 'C', 'P', 'B', 'W', 'O', 'M']
let HP = null
const hp = () => (HP ??= buildTextures(PAL, MATS, LOOK, '∅'))
const legacy = (() => { let L = null; return () => (L ??= buildTextures(PAL, MATS, null, '∅')) })()
const hpSeed = (key) => BF.subSeed(0x4C4E4601, key)                   // the tiles' seed rule (gfx-textures.js HP_SEED)

const uniq = (a) => [...new Set(a)]
const tilesOf = (tex, ch) => uniq([tex.walls[ch], ...tex.wallVar[ch]])
const sha16 = (u8) => createHash('sha256').update(u8).digest('hex').slice(0, 16)
const lum = (t, i) => t[i] * 0.299 + t[i + 1] * 0.587 + t[i + 2] * 0.114
function meanLum(t, x0, y0, x1, y1) { let s = 0, n = 0; for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { s += lum(t, (y * TS + x) * 3); n++ } return s / n }
function meanRgb(t, x0, y0, x1, y1) { const s = [0, 0, 0]; let n = 0; for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { for (let c = 0; c < 3; c++) s[c] += t[(y * TS + x) * 3 + c]; n++ } return s.map((v) => v / n) }
const colDiff = (t, x0, x1) => { let s = 0; for (let y = 0; y < TS; y++) for (let c = 0; c < 3; c++) s += Math.abs(t[(y * TS + x0) * 3 + c] - t[(y * TS + x1) * 3 + c]); return s / (TS * 3) }
const rowDiff = (t, y0, y1) => { let s = 0; for (let x = 0; x < TS; x++) for (let c = 0; c < 3; c++) s += Math.abs(t[(y0 * TS + x) * 3 + c] - t[(y1 * TS + x) * 3 + c]); return s / (TS * 3) }
function marginDiff(t, base, cols, rows) {
  let n = 0
  for (let y = 0; y < TS; y++) for (let x = 0; x < TS; x++) {
    if (!(x < cols || x >= TS - cols || y < rows || y >= TS - rows)) continue
    const i = (y * TS + x) * 3
    if (t[i] !== base[i] || t[i + 1] !== base[i + 1] || t[i + 2] !== base[i + 2]) n++
  }
  return n
}
const cellSpread = (t) => { const m = []; for (let cy = 0; cy < 8; cy++) for (let cx = 0; cx < 8; cx++) m.push(meanLum(t, cx * 8, cy * 8, cx * 8 + 7, cy * 8 + 7)); const mu = m.reduce((a, b) => a + b) / m.length; return Math.sqrt(m.reduce((a, b) => a + (b - mu) ** 2, 0) / m.length) }
// the sprayed orange of the crew mark, weathered toward the wood, against every plywood tone (fresh tan to silver-grey) and its rust
const isMark = (t, i) => t[i] - t[i + 1] > 50 && t[i + 1] - t[i + 2] > 40 && t[i] > 150

describe('gfx-block-facade.js: the module', () => {
  it('exports the recipes, the layouts, the crew mark, the glyph test and the compositor', () => {
    for (const f of ['layoutBrick', 'layoutFormstone', 'layoutCmu', 'layoutPlywood', 'paintPressedBrick', 'paintCommonBrick', 'paintPaintedBrick', 'paintFormstone',
      'paintMarble', 'paintCmu', 'paintPlywood', 'paintPaintedWood', 'paintVentPanel', 'paintAsphalt', 'paintConcrete', 'paintGranite', 'paintYard', 'paintShade',
      'paintWindowInterior', 'paintPlacard', 'crewMark', 'glyphTest', 'decalGlyphTest', 'paintBayElevation']) expect(typeof BF[f], f).toBe('function')
    expect(BF.VERSION).toBe('gfx-block-facade 1')
    expect(Object.keys(BF.VERSIONS)).toEqual(['core', 'masonry', 'surface'])
    for (const k of Object.keys(BF.RECIPES)) expect(typeof BF.RECIPES[k], k).toBe('function')
  })
  it('a layout is in metres: the same seed lays the same bricks at 32 and 128 texels a metre (only the raster differs)', () => {
    const a = BF.paintCommonBrick(2, 2, 32, 7, null, { ss: 1 }), b = BF.paintCommonBrick(2, 2, 128, 7, null, { ss: 1 })
    expect([a.w, a.h, b.w, b.h]).toEqual([64, 64, 256, 256])
    expect(JSON.stringify(a.meta)).toBe(JSON.stringify(b.meta))
    expect(JSON.stringify(BF.layoutFormstone(2, 2, 9))).toBe(JSON.stringify(BF.layoutFormstone(2, 2, 9)))
  })
  it('paintBayElevation lays a piece at its texel rect over the field, and refuses one outside the elevation', () => {
    const field = { recipe: 'paintCommonBrick', seed: 3, hex: null, opts: { ss: 1 } }
    const room = { recipe: 'paintWindowInterior', seed: 4, hex: null, opts: { mode: 'void', ss: 1 } }
    const R = BF.paintBayElevation({ w: 2, h: 2, field, pieces: [{ ...room, rect: [10 / 32, 9 / 32, 54 / 32, 53 / 32] }] }, 32)
    const F = BF.paintCommonBrick(2, 2, 32, 3, null, { ss: 1 }), W = BF.paintWindowInterior(44 / 32, 44 / 32, 32, 4, null, { mode: 'void', ss: 1 })
    expect(R.rgb[(20 * 64 + 20) * 3]).toBe(W.rgb[(11 * 44 + 10) * 3])          // inside the opening: the room
    expect(R.rgb[(20 * 64 + 2) * 3]).toBe(F.rgb[(20 * 64 + 2) * 3])            // outside it: the brick
    expect(R.meta.pieces).toEqual([{ recipe: 'paintWindowInterior', rect: [10, 9, 54, 53], meta: W.meta }])
    expect(() => BF.paintBayElevation({ w: 2, h: 2, field, pieces: [{ ...room, rect: [1.5, 0, 2.5, 1] }] }, 32)).toThrow()
    expect(() => BF.paintBayElevation({ w: 2, h: 2, field: { ...field, recipe: 'paintNothing' } }, 32)).toThrow()
  })
})

describe('the Harlem Park tiles (look.facade \'harlem\', look.floor \'yard\'): shape and determinism', () => {
  it('every code keeps its tile and gets 3–8 distinct variants; the ground 6; all 64 × 64 RGB', () => {
    const t = hp()
    expect(Object.keys(t.walls).sort()).toEqual(['0', 'B', 'C', 'F', 'M', 'O', 'P', 'W'])
    for (const ch of CODES) {
      const n = tilesOf(t, ch).length
      expect(n, ch).toBeGreaterThanOrEqual(3); expect(n, ch).toBeLessThanOrEqual(8)
      expect(t.wallVar[ch][0], ch).toBe(t.walls[ch])
      for (const x of tilesOf(t, ch)) { expect(x).toBeInstanceOf(Uint8Array); expect(x.length).toBe(TS * TS * 3) }
    }
    expect(uniq([t.floor, ...t.floorVar]).length).toBe(6)
    expect(t.floorVar).toHaveLength(9)
  })
  it('two builds are byte-identical, whatever was built in between, and Math.random is never touched', () => {
    const fp = (t) => CODES.map((ch) => tilesOf(t, ch).map(sha16).join(',')).join('|') + '|' + uniq([t.floor, ...t.floorVar]).map(sha16).join(',')
    const first = fp(hp())
    buildTextures({ wall: '#C8B870', ceiling: '#E8E0C0', floor: '#4A3820', fog: '#D4C87A' }, null, null, '0')
    buildTextures(PAL, { ...MATS, B: '#5A4A8A' }, LOOK, '∅')
    const spy = vi.spyOn(Math, 'random').mockImplementation(() => { throw new Error('Math.random used') })
    let again
    try { again = buildTextures(PAL, MATS, LOOK, '∅') } finally { spy.mockRestore() }
    expect(fp(again)).toBe(first)
  })
  it('builds within the sanity bound and fits the GPU texture array (≤ 220 layers)', () => {
    const t0 = performance.now()
    const t = buildTextures(PAL, MATS, LOOK, '∅')
    expect(performance.now() - t0).toBeLessThan(10000)
    expect(planTiles(t).layers.length).toBeLessThanOrEqual(220)
  })
})

describe('seams: the variants tile against each other, and the brick runs on from bay to bay', () => {
  it('every wall variant equals its base in the outer 3 columns; every ground variant in the outer 3 columns and rows', () => {
    const t = hp(), bad = []
    for (const ch of CODES) for (const x of tilesOf(t, ch)) { const n = marginDiff(x, t.walls[ch], 3, 0); if (n) bad.push(`${ch}: ${n}`) }
    for (const x of uniq(t.floorVar)) { const n = marginDiff(x, t.floor, 3, 3); if (n) bad.push(`ground: ${n}`) }
    expect(bad).toEqual([])
  })
  it('the bays that stand in common brick (B, C, P, W, O) share their outer columns at the stock hexes: no seam between neighbours', () => {
    const t = hp()
    for (const ch of ['C', 'P', 'W', 'O']) expect(marginDiff(t.walls[ch], t.walls.B, 3, 0), ch).toBe(0)
  })
  it('each base wraps across x (the ground across y too): its own seam no worse than its worst interior step', () => {
    const t = hp()
    for (const [name, base, both] of [...CODES.map((ch) => [ch, t.walls[ch], false]), ['ground', t.floor, true]]) {
      let maxX = 0; for (let x = 4; x < 59; x++) maxX = Math.max(maxX, colDiff(base, x, x + 1))
      expect(colDiff(base, TS - 1, 0), name).toBeLessThanOrEqual(1.5 * maxX + 30)
      if (both) { let maxY = 0; for (let y = 4; y < 59; y++) maxY = Math.max(maxY, rowDiff(base, y, y + 1)); expect(rowDiff(base, TS - 1, 0), name).toBeLessThanOrEqual(1.5 * maxY + 30) }
    }
  })
})

describe('the codes keep their meaning (today\'s composition: the doorway x 12–51 / y 6–63, the window x 10–53 / y 9–52)', () => {
  it('O: a warm lit window (bright, red over blue) in every variant; W: the black open window (dark) in every variant', () => {
    for (const x of tilesOf(hp(), 'O')) {
      expect(meanLum(x, 14, 14, 49, 48)).toBeGreaterThan(100)
      const [r, , b] = meanRgb(x, 14, 14, 49, 48)
      expect(r).toBeGreaterThan(b * 1.35)
    }
    for (const x of tilesOf(hp(), 'W')) expect(meanLum(x, 14, 14, 49, 48)).toBeLessThan(45)
  })
  it('M: pale marble; C: the door\'s frame reads against the brick round it; B and F: tone between bricks and stones', () => {
    for (const x of tilesOf(hp(), 'M')) expect(meanLum(x, 4, 4, 59, 59)).toBeGreaterThan(150)
    for (const x of tilesOf(hp(), 'C')) {
      const frame = meanLum(x, 13, 14, 13, 56), brick = meanLum(x, 4, 22, 8, 56)
      expect(Math.abs(frame - brick) / Math.max(frame, brick)).toBeGreaterThan(0.15)
    }
    expect(cellSpread(hp().walls.B)).toBeGreaterThan(4)
    expect(cellSpread(hp().walls.F)).toBeGreaterThan(3)
  })
  it('P: the board covers the door; the crew mark is on the marked boards (the base among them) and on no plain one', () => {
    const [markA, markB, plainA, plainB] = tilesOf(hp(), 'P')
    const count = (t) => { let n = 0; for (let y = 0; y < TS; y++) for (let x = 0; x < TS; x++) if (isMark(t, (y * TS + x) * 3)) n++; return n }
    expect(markA).toBe(hp().walls.P)
    expect(count(markA)).toBeGreaterThan(40); expect(count(markB)).toBeGreaterThan(40)
    expect(count(plainA)).toBeLessThan(3); expect(count(plainB)).toBeLessThan(3)
    for (const x of [markA, plainA]) {                                               // the board, not the brick, at the door's middle
      const [r, g, b] = meanRgb(x, 20, 40, 44, 52), [br, bg, bb] = meanRgb(hp().walls.B, 20, 40, 44, 52)
      expect(Math.abs(r - br) + Math.abs(g - bg) + Math.abs(b - bb)).toBeGreaterThan(30)
    }
  })
  it('the sealed doors stay where the knock finds them: C and P differ from B inside the doorway and match it outside', () => {
    const B = hp().walls.B
    for (const ch of ['C', 'P']) {
      expect(meanRgb(hp().walls[ch], 0, 0, 3, 63)).toEqual(meanRgb(B, 0, 0, 3, 63))
      const d = meanRgb(hp().walls[ch], 16, 12, 47, 56).map((v, k) => Math.abs(v - meanRgb(B, 16, 12, 47, 56)[k])).reduce((a, b) => a + b)
      expect(d, ch).toBeGreaterThan(20)
    }
  })
})

describe('the fixes of 2026-11-17', () => {
  const quant = (t, x0, y0, x1, y1, q) => { const v = []; for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) v.push(lum(t, (y * TS + x) * 3)); v.sort((a, b) => a - b); return v[Math.floor(q * (v.length - 1))] }
  it('the ground is packed dirt with sparse, soft grass: red over green over blue, grass on at most a quarter, little texel-to-texel contrast', () => {
    for (const t of uniq([hp().floor, ...hp().floorVar])) {
      const [r, g, b] = meanRgb(t, 0, 0, 63, 63)
      expect(r).toBeGreaterThan(g); expect(g).toBeGreaterThan(b)
      // packed dirt, near the palette floor #5A5048 (about (90, 84, 72) on the yard pose's ground)
      expect(Math.abs(r - 88) + Math.abs(g - 82) + Math.abs(b - 70)).toBeLessThan(15)
      let green = 0, step = 0
      for (let i = 0; i < TS * TS; i++) if (t[i * 3 + 1] >= t[i * 3]) green++
      for (let y = 0; y < TS; y++) for (let x = 0; x < TS - 1; x++) step += Math.abs(lum(t, (y * TS + x) * 3) - lum(t, (y * TS + x + 1) * 3))
      expect(green / (TS * TS)).toBeLessThanOrEqual(0.25)
      expect(step / (TS * (TS - 1))).toBeLessThan(4)
    }
  })
  it('the sealed door\'s CMU reads as block at 32 texels a metre: 1-texel joints at about 0.72 of the block (contrast over 0.15)', () => {
    for (const x of tilesOf(hp(), 'C')) {
      const lo = quant(x, 18, 12, 45, 55, 0.1), hi = quant(x, 18, 12, 45, 55, 0.6)
      expect((hi - lo) / hi).toBeGreaterThan(0.15)
    }
    const S = BF.paintCmu(29 / 32, 68 / 32, 32, hpSeed('Cmu'), null, { infill: true, age: 'aged', snap: true, ss: 1 })
    expect(S.meta.snap).toBe(true)
    expect(S.meta.courses).toBeGreaterThanOrEqual(10)
  })
  it('the formstone reads as hand-formed stones: joints at least a texel, darker than the stones; a few stones run through two courses', () => {
    for (const x of tilesOf(hp(), 'F')) expect(quant(x, 0, 0, 63, 63, 0.1) / quant(x, 0, 0, 63, 63, 0.5)).toBeLessThan(0.85)
    const R = BF.paintFormstone(2, 2, 32, hpSeed('Formstone-grey'), null, { palette: 'grey', variant: 'base', snap: true, ss: 1 })
    expect(R.meta.snap.merged).toBeGreaterThan(0)
    // without opts.snap the recipe is what it was
    const a = BF.paintFormstone(2, 2, 32, 9, null, { palette: 'grey', ss: 1 }), b = BF.paintFormstone(2, 2, 32, 9, null, { palette: 'grey', ss: 1 })
    expect(sha16(BF.toRGB8(a))).toBe(sha16(BF.toRGB8(b))); expect(a.meta.snap).toBeUndefined()
  })
})

describe('the glyph test: no mark, placard or decal reads as a digit or a letter', () => {
  const boards = ['Plywood-DoorMarkA', 'Plywood-DoorMarkB']
  it('every crew mark on a board clears the test, whole, mirrored and each half alone (the mark\'s own blocks)', () => {
    for (const key of boards) {
      const m = BF.crewMark(BF.subSeed(hpSeed(key), 'crew'))
      expect(m.glyph.pass, key).toBe(true)
      expect(m.glyph.distance).toBeGreaterThanOrEqual(6)
      for (const h of m.halves) expect(h.pass, key).toBe(true)
    }
  })
  it('read back from the painted tiles: the orange of each marked board, whole, mirrored and each half, is 6 or more cells from every glyph', () => {
    const [markA, markB] = tilesOf(hp(), 'P')
    for (const t of [markA, markB]) {
      const v = new Float32Array(TS * TS)
      let x0 = TS, x1 = -1
      for (let y = 0; y < TS; y++) for (let x = 0; x < TS; x++) if (isMark(t, (y * TS + x) * 3)) { v[y * TS + x] = 1; x0 = Math.min(x0, x); x1 = Math.max(x1, x) }
      const whole = BF.glyphTest(BF.fitMaskTo5x7(v, TS, TS), { min: 6 })
      expect(whole.pass, `nearest ${whole.nearest} at ${whole.distance}`).toBe(true)
      const mid = Math.floor((x0 + x1 + 1) / 2)
      for (const [a, b] of [[0, mid], [mid, TS]]) {
        const h = v.map((q, i) => (i % TS >= a && i % TS < b ? q : 0))
        expect(BF.glyphTest(BF.fitMaskTo5x7(h, TS, TS), { min: 6 }).pass).toBe(true)
      }
    }
  })
  it('a few hundred more crew marks clear it too (the boards the storeys add)', () => {
    for (let s = 0; s < 300; s++) expect(BF.crewMark(BF.subSeed(0x4C4E4601, 'extra-' + s)).glyph.pass).toBe(true)
  })
  it('the invented placard: off-white, never red, one dark band; its 5 × 7 reading is no glyph', () => {
    const C = tilesOf(hp(), 'C'), withPlacard = C.filter((t) => meanLum(t, 4, 10, 9, 18) > 120)
    expect(withPlacard.length).toBeGreaterThan(0)
    for (const t of withPlacard) {
      const [r, g, b] = meanRgb(t, 4, 10, 9, 18)
      expect(r - b).toBeLessThan(40); expect(r - g).toBeLessThan(25)                 // never red
      const dark = (x, y) => (lum(t, (Math.min(18, Math.floor(y)) * TS + Math.min(9, Math.floor(x))) * 3) < 90 ? 1 : 0)
      const g5 = BF.glyphTest(BF.maskTo5x7(dark, 4, 10, 10, 19), { min: 6 })
      expect(g5.pass, `nearest ${g5.nearest} at ${g5.distance}`).toBe(true)
    }
  })
  it('the stroke decals the material tiles carry (marble cracks and rust, brick and formstone soot and rust): none reads as a letter', () => {
    const jobs = [
      ...[0, 1, 2].map((k) => ['paintMarble', 2, [21, 21, 22][k] / 32, 'Marble:tread' + k, { variant: ['rustRun', 'crackA', 'crackB'][k], tread: true, foot: k === 2, ss: 1 }]),
      ['paintCommonBrick', 2, 2, 'CommonBrick', { variant: 'soot', foot: true, ss: 1 }], ['paintCommonBrick', 2, 2, 'CommonBrick', { variant: 'rust', foot: true, ss: 1 }],
      ['paintFormstone', 2, 2, 'Formstone-grey', { palette: 'grey', variant: 'soot', foot: true, ss: 1 }],
    ]
    let decals = 0
    for (const [name, w, h, key, opts] of jobs) {
      const R = BF[name](w, h, 32, hpSeed(key), null, opts)
      if (!R.decal) continue
      decals++
      const g = BF.decalGlyphTest(R.decal, R.w, R.h)
      expect(g.pass, `${name} ${opts.variant}: nearest ${g.nearest} at ${g.distance}`).toBe(true)
    }
    expect(decals).toBeGreaterThan(0)
  })
})

describe('palette drift and the colour rule', () => {
  it('at the stock hexes a tile is its recipe exactly (the B bay: the common brick standing on the yard)', () => {
    const R = BF.paintCommonBrick(2, 2, 32, hpSeed('CommonBrick'), MATS.B, { variant: 'base', foot: true, ss: 1 })
    expect(sha16(hp().walls.B)).toBe(sha16(BF.toRGB8(R)))
  })
  it('a drifted B hex drifts the brick of every brick bay; the formstone does not move', () => {
    const d = buildTextures(PAL, { ...MATS, B: '#5A4A8A' }, LOOK, '∅')
    const ratio = (t) => { const [r, , b] = meanRgb(t, 0, 0, 3, 63); return b / r }
    for (const ch of ['B', 'C', 'P', 'W', 'O']) expect(ratio(d.walls[ch]), ch).toBeGreaterThan(ratio(hp().walls[ch]) * 1.5)
    expect(sha16(d.walls.F)).toBe(sha16(hp().walls.F))
  })
  it('a drifted C hex drifts the CMU in the sealed door, and nothing else', () => {
    const d = buildTextures(PAL, { ...MATS, C: '#6F8FAF' }, LOOK, '∅')
    const [r, , b] = meanRgb(d.walls.C, 20, 15, 44, 50), [r0, , b0] = meanRgb(hp().walls.C, 20, 15, 44, 50)
    expect(b / r).toBeGreaterThan((b0 / r0) * 1.2)
    for (const ch of ['B', 'F', 'P', 'W', 'O', 'M']) expect(sha16(d.walls[ch]), ch).toBe(sha16(hp().walls[ch]))
  })
  it('the ground follows palette.floor; F, M, P, W and O follow their own hexes', () => {
    const d = buildTextures({ ...PAL, floor: '#3A5068' }, { ...MATS, F: '#C8A878', M: '#C2D0D8', P: '#8A6A42', W: '#202838', O: '#8A5A38' }, LOOK, '∅')
    expect(sha16(d.floor)).not.toBe(sha16(hp().floor))
    for (const ch of ['F', 'M', 'P', 'W', 'O']) expect(sha16(d.walls[ch]), ch).not.toBe(sha16(hp().walls[ch]))
    expect(sha16(d.walls.B)).toBe(sha16(hp().walls.B))
  })
})

describe('the legacy paths are untouched, and the level carries the look', () => {
  it('without the look, or with an unknown facade, Level ∅ builds today\'s tiles; the look changes only the material tiles and the ground', () => {
    const L = legacy(), junk = buildTextures(PAL, MATS, { facade: 'nowhere' }, '∅'), H = hp()
    for (const ch of CODES) { expect(sha16(junk.walls[ch]), ch).toBe(sha16(L.walls[ch])); expect(sha16(H.walls[ch]), ch).not.toBe(sha16(L.walls[ch])) }
    for (const k of ['ceil', 'light']) expect(sha16(H[k]), k).toBe(sha16(L[k]))
    expect(sha16(H.walls['0'])).toBe(sha16(L.walls['0']))
    expect(sha16(H.floor)).not.toBe(sha16(L.floor))
    const facadeOnly = buildTextures(PAL, MATS, { facade: 'harlem' }, '∅'), yardOnly = buildTextures(PAL, MATS, { floor: 'yard' }, '∅')
    expect(sha16(facadeOnly.floor)).toBe(sha16(L.floor)); expect(sha16(facadeOnly.walls.C)).toBe(sha16(H.walls.C))
    expect(sha16(yardOnly.floor)).toBe(sha16(H.floor)); expect(sha16(yardOnly.walls.C)).toBe(sha16(L.walls.C))
  })
  it('the facade look only dresses Level ∅\'s authored codes: on another level it changes nothing', () => {
    const P1 = { wall: '#8C8674', ceiling: '#9E9A88', floor: '#39372F', fog: '#A29C86' }
    const a = buildTextures(P1, null, null, '1'), b = buildTextures(P1, null, { facade: 'harlem' }, '1')
    expect(sha16(b.walls['0'])).toBe(sha16(a.walls['0'])); expect(sha16(b.floor)).toBe(sha16(a.floor))
  })
  it('levels.js: Level ∅ carries look { facade: \'harlem\', floor: \'yard\' }; no other level has a facade', () => {
    const i = LEVELS.findIndex((l) => l.id === '∅')
    expect(LEVELS[i].config.look).toEqual({ facade: 'harlem', floor: 'yard' })
    expect(levelConfig(DEFAULT_CONFIG, i).look).toEqual({ facade: 'harlem', floor: 'yard' })
    for (let k = 0; k < LEVELS.length; k++) if (k !== i) expect(levelConfig(DEFAULT_CONFIG, k).look?.facade).toBeUndefined()
  })
  it('both offline shells carry the two new modules', () => {
    const sw = readFileSync(new URL('../src/sw.js', import.meta.url), 'utf8'), build = readFileSync(new URL('../tools/build-play.sh', import.meta.url), 'utf8')
    for (const f of ['gfx-block-facade.js', 'block-facade-plan.js']) { expect(sw).toContain(`'/renderer/${f}'`); expect(build).toContain(`'${f}'`) }
  })
  it('policy: the new modules hold none of the game text\'s digit runs', () => {
    // every run of three or more digits inside a string of the game's own text modules, read from them here rather than written down
    const text = ['origin-tenant.js', 'status.js'].map((f) => readFileSync(new URL('../src/renderer/' + f, import.meta.url), 'utf8')).join('\n')
    const runs = [...new Set((text.match(/(['"`])(?:\\.|(?!\1)[^\\\n])*\1/g) || []).flatMap((s) => s.match(/\d{3,}/g) || []))]
    expect(runs.length).toBeGreaterThan(0)
    for (const f of ['gfx-block-facade.js', 'block-facade-plan.js']) {
      const src = readFileSync(new URL('../src/renderer/' + f, import.meta.url), 'utf8')
      expect(runs.filter((r) => src.includes(r)).length, f).toBe(0)
    }
  })
})
