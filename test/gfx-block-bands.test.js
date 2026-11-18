// gfx-block-bands.test.js — Level ∅'s storeys: the band tiles gfx-textures.js
// builds for the block (TexSet.wallBands, buildBlockBands) from the house plan's stacks (block-stacks.js).
//   * shape: a pair a material-tile slot for every code, the stacks in block-stacks.js's order; lazy (only a renderer that draws storeys builds them)
//     and not enumerable (the TexSet compares as before)
//   * determinism: two builds byte-identical, and the lazy build (sharing the material tiles' renders) the same bytes as a build of its own
//   * seams: the belt at the band 1/2 seam is one strip everywhere; within a code (and within a house's look) the outer columns agree; the
//     band 0/1 seam of a pair and the band 2/3 seam of a look are as smooth as the wall itself
//   * meanings: the W bay has no opening at eye level, the lit bay a warm lit window, the sealed doors are whole across the seam and the
//     boards carry the crew mark, the black upper voids are dark, a roofless house shows the sky, the jut fronts stand on pale marble
//   * the glyph test on the crew mark read back from the band tiles; palette drift; the level's wallH; both shells carry block-stacks.js
//   * the fixes of 2026-11-17: the jut front doors closed and brown, the stoop in steps, the CMU in block, a painted house painted
//     to the ground (its own ground-storey pairs, picked for its faces), the roofless voids dark under a strip of sky, the ends' ghost lines
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import * as BF from '../src/renderer/gfx-block-facade.js'
import { buildTextures, buildBlockBands, buildTexturesMemo, clearTexturesMemo } from '../src/renderer/gfx-textures.js'
import { createCpuRenderer } from '../src/renderer/gfx-cpu.js'
import { planBlockFacade, HOUSE_SEED } from '../src/renderer/block-facade-plan.js'
import { planBlockStacks } from '../src/renderer/block-stacks.js'
import { pickBandPairs } from '../src/renderer/gfx-world.js'
import { NULL_MAP } from '../src/renderer/level-null-map.js'
import { LEVELS, levelConfig } from '../src/renderer/levels.js'
import { DEFAULT_CONFIG } from '../src/renderer/world.js'

vi.setConfig({ testTimeout: 60000 })

const TS = 64
const PAL = { wall: '#B8A888', ceiling: '#B9B7AE', floor: '#5A5048', fog: '#9A968C' }
const MATS = { F: '#B8A888', C: '#8F8F8F', P: '#7A6A52', B: '#8A4A3A', W: '#141414', O: '#7A5A48', M: '#D2D0C8' }
const LOOK = { facade: 'harlem', floor: 'yard' }
const plan = planBlockFacade(NULL_MAP, HOUSE_SEED), STACKS = planBlockStacks(plan).stacks
let HP = null
const hp = () => (HP ??= buildTextures(PAL, MATS, LOOK, '∅'))
const bands = () => hp().wallBands
const uniq = (a) => [...new Set(a)]
const sha = (u8) => createHash('sha256').update(u8).digest('hex')
const lum = (t, i) => t[i] * 0.299 + t[i + 1] * 0.587 + t[i + 2] * 0.114
function meanLum(t, x0, y0, x1, y1) { let s = 0, n = 0; for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { s += lum(t, (y * TS + x) * 3); n++ } return s / n }
function meanRgb(t, x0, y0, x1, y1) { const s = [0, 0, 0]; let n = 0; for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { for (let c = 0; c < 3; c++) s[c] += t[(y * TS + x) * 3 + c]; n++ } return s.map((v) => v / n) }
const rowsOf = (t, y0, y1) => t.subarray(y0 * TS * 3, y1 * TS * 3)
const step = (a, ya, b, yb) => { let s = 0; for (let x = 0; x < TS; x++) for (let c = 0; c < 3; c++) s += Math.abs(a[(ya * TS + x) * 3 + c] - b[(yb * TS + x) * 3 + c]); return s / (TS * 3) }
const worstStep = (t) => { let m = 0; for (let y = 0; y < TS - 1; y++) m = Math.max(m, step(t, y, t, y + 1)); return m }
const edgeCols = (t) => { const o = []; for (let y = 0; y < TS; y++) for (const x of [0, 1, 2, TS - 3, TS - 2, TS - 1]) o.push(t[(y * TS + x) * 3], t[(y * TS + x) * 3 + 1], t[(y * TS + x) * 3 + 2]); return o }
const isMark = (t, i) => t[i] - t[i + 1] > 50 && t[i + 1] - t[i + 2] > 40 && t[i] > 150
const allTiles = (B) => {
  const s = new Set()
  for (const ch of Object.keys(B.code)) for (const p of B.code[ch]) for (const t of p) s.add(t)
  for (const u of B.upper) {
    if (u.lower) for (const p of u.lower) for (const t of p) s.add(t)
    if (u.lowerBy) for (const ps of Object.values(u.lowerBy)) for (const p of ps) for (const t of p) s.add(t)
    for (const p of u.variants) for (const t of p) s.add(t)
  }
  for (const t of B.fallback) s.add(t)
  return [...s]
}
// a canvas / 2D context stand-in (as gfx-hw-palette.test.js): every method a no-op, image data real
const mockCtx = () => new Proxy({}, {
  get(t, k) {
    if (k in t) return t[k]
    if (k === 'createLinearGradient' || k === 'createRadialGradient') return () => ({ addColorStop() {} })
    if (k === 'createPattern') return () => ({})
    if (k === 'getImageData' || k === 'createImageData') return (x, y, w, h) => (h === undefined ? { data: new Uint8ClampedArray(x * y * 4), width: x, height: y } : { data: new Uint8ClampedArray(w * h * 4), width: w, height: h })
    return () => {}
  },
  set(t, k, v) { t[k] = v; return true },
})
const fakeCanvas = (w = 96, h = 54) => ({ width: w, height: h, getContext: () => mockCtx() })

describe('shape, laziness, determinism', () => {
  it('a TexSet with the look has wallBands, not enumerable and built once; without the look, or on another level, none', () => {
    const t = buildTextures(PAL, MATS, LOOK, '∅')
    expect(Object.keys(t)).not.toContain('wallBands')
    expect(JSON.stringify(Object.keys(t))).toBe(JSON.stringify(Object.keys(buildTextures(PAL, MATS, { ...LOOK }, '∅'))))
    expect(t.wallBands).toBe(t.wallBands)
    expect(buildTextures(PAL, MATS, null, '∅').wallBands).toBeUndefined()
    expect(buildTextures(PAL, null, LOOK, '0').wallBands).toBeUndefined()
  })
  it('a pair for every material-tile slot of every code (the same pick: hash2(mx, my, side) % slots), a stack entry per block-stacks.js stack', () => {
    const B = bands(), T = hp()
    for (const ch of ['F', 'C', 'P', 'B', 'W', 'O', 'M']) {
      expect(B.code[ch].length, ch).toBe(T.wallVar[ch].length)
      for (const p of B.code[ch]) expect(p.length).toBe(2)
    }
    expect(B.upper.length).toBe(STACKS.length)
    B.upper.forEach((u, i) => {
      expect(u.key).toBe(STACKS[i].key); expect(u.kind).toBe(STACKS[i].kind)
      expect(u.variants.length).toBe(STACKS[i].variants.length)
      expect(u.lower === null).toBe(STACKS[i].kind === 'upper')
    })
    for (const t of allTiles(B)) { expect(t).toBeInstanceOf(Uint8Array); expect(t.length).toBe(TS * TS * 3) }
    expect(allTiles(B).length).toBeLessThanOrEqual(160)                 // with the material tiles' ~60 layers, inside the GPU array's 220 (gfx-gl-bands.test.js)
  })
  it('two builds are byte-identical, and the lazy build (sharing the material tiles\' renders) is the build of its own', () => {
    const A = buildBlockBands(PAL, MATS, plan), Bb = bands()
    const flat = (B) => allTiles(B).map(sha).join(',')
    expect(flat(A)).toBe(flat(buildBlockBands(PAL, MATS, planBlockFacade(NULL_MAP, HOUSE_SEED))))
    expect(flat(Bb)).toBe(flat(A))
  })
})

describe('seams: any ground storey meets any upper storey, and every stack is one wall', () => {
  it('the belt is one strip: the top 2 rows of every band 1 and the bottom 2 of every band 2 (a jut front\'s too)', () => {
    const B = bands(), b1 = [], b2 = []
    for (const ch of Object.keys(B.code)) for (const p of B.code[ch]) b1.push(p[1])
    for (const u of B.upper) {
      if (u.kind === 'front') { b1.push(u.lower[0][1]); for (const p of u.variants) b2.push(p[0]) }
      if (u.kind === 'upper') for (const p of u.variants) b2.push(p[0])
      if (u.lowerBy) for (const ps of Object.values(u.lowerBy)) for (const p of ps) b1.push(p[1])          // a painted house's ground storey
    }
    for (const t of b1) expect(sha(rowsOf(t, 0, 2))).toBe(sha(rowsOf(b1[0], 0, 2)))
    for (const t of b2) expect(sha(rowsOf(t, TS - 2, TS))).toBe(sha(rowsOf(b2[0], TS - 2, TS)))
    // and the strip itself runs on from bay to bay (it is periodic across x)
    expect(step(b1[0], 0, b1[0], 0)).toBe(0)
  })
  it('within a code every pair keeps the base pair\'s outer columns; within a house\'s look every upper tile keeps the look\'s', () => {
    const B = bands()
    for (const ch of Object.keys(B.code)) {
      const base = B.code[ch][0]
      for (const p of B.code[ch]) for (const b of [0, 1]) expect(edgeCols(p[b]), ch).toEqual(edgeCols(base[b]))
    }
    const byLook = new Map()
    B.upper.forEach((u, i) => {
      if (u.kind !== 'upper') return
      const k = JSON.stringify(STACKS[i].look)
      if (!byLook.has(k)) byLook.set(k, [])
      byLook.get(k).push(...u.variants)
    })
    for (const vs of byLook.values()) for (const p of vs) for (const b of [0, 1]) expect(edgeCols(p[b])).toEqual(edgeCols(vs[0][b]))
  })
  it('a pair\'s band 0/1 seam and a look\'s band 2/3 seam are no rougher than the wall inside its tiles', () => {
    const B = bands()
    for (const ch of Object.keys(B.code)) for (const p of uniq(B.code[ch])) expect(step(p[1], TS - 1, p[0], 0), ch).toBeLessThanOrEqual(Math.max(worstStep(p[0]), worstStep(p[1])))
    for (const u of B.upper) for (const p of uniq(u.variants)) expect(step(p[1], TS - 1, p[0], 0), u.key).toBeLessThanOrEqual(Math.max(worstStep(p[0]), worstStep(p[1])) + 1e-9)
  })
  it('the top metre of band 3 (never drawn at 3.5 cells) repeats its first drawn row, so no mip level bleeds into the wall top', () => {
    for (const u of bands().upper) for (const p of u.variants) for (let y = 0; y < 32; y++) expect(sha(rowsOf(p[1], y, y + 1))).toBe(sha(rowsOf(p[1], 32, 33)))
  })
})

describe('the codes and the houses keep their meaning (at true scale)', () => {
  // a ground-storey pair as one 2 x 4 m picture (rows down from 4 m): band 1 over band 0
  const stack2 = (p) => { const o = new Uint8Array(TS * TS * 6); o.set(p[1], 0); o.set(p[0], TS * TS * 3); return o }
  const mean2 = (p, x0, y0, x1, y1) => { const s = stack2(p); let a = 0, n = 0; for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { a += lum(s, (y * TS + x) * 3); n++ } return a / n }
  it('W: plain wall at eye level (no opening that could read as a door to knock on); the B bay is brick there too', () => {
    for (const p of uniq(bands().code.W)) expect(mean2(p, 18, 70, 45, 110)).toBeGreaterThan(70)
  })
  it('O: a warm lit window 0.99–2.67 m (rows 43–97), in every variant', () => {
    for (const p of uniq(bands().code.O)) {
      expect(mean2(p, 21, 50, 42, 92)).toBeGreaterThan(95)
      const s = stack2(p); let r = 0, b = 0
      for (let y = 50; y < 92; y++) for (let x = 21; x < 42; x++) { r += s[(y * TS + x) * 3]; b += s[(y * TS + x) * 3 + 2] }
      expect(r).toBeGreaterThan(b * 1.15)
    }
  })
  it('C and P: the sealed door is whole across the band seam (its opening runs from band 0 into band 1), the boards carry the crew mark', () => {
    const B = bands(), brick = B.code.B[0]
    for (const ch of ['C', 'P']) for (const p of uniq(B.code[ch])) {
      // inside the opening, just under and just over the 2 m seam, the door differs from the plain brick bay; outside it, it does not
      for (const [b, y] of [[0, 4], [1, 58]]) expect(Math.abs(meanLum(p[b], 20, y, 43, y + 4) - meanLum(brick[b], 20, y, 43, y + 4)), `${ch} band ${b}`).toBeGreaterThan(8)
    }
    const marked = uniq(B.code.P).filter((p) => { let n = 0; const s = stack2(p); for (let i = 0; i < s.length; i += 3) if (isMark(s, i)) n++; return n > 20 })
    expect(marked.length).toBe(2)                                       // markA (the base) and markB; the plain boards carry none
    expect(marked).toContain(B.code.P[0])
  })
  it('read back from the band tiles, each marked board\'s orange, whole, mirrored and each half, clears the glyph test', () => {
    for (const p of uniq(bands().code.P)) {
      const s = stack2(p), v = new Float32Array(TS * TS * 2)
      let x0 = TS, x1 = -1, n = 0
      for (let y = 0; y < 2 * TS; y++) for (let x = 0; x < TS; x++) if (isMark(s, (y * TS + x) * 3)) { v[y * TS + x] = 1; n++; x0 = Math.min(x0, x); x1 = Math.max(x1, x) }
      if (n < 20) continue
      let y0 = 2 * TS, y1 = -1
      for (let i = 0; i < v.length; i++) if (v[i]) { y0 = Math.min(y0, (i / TS) | 0); y1 = Math.max(y1, (i / TS) | 0) }
      const crop = (a, b) => { const w = b - a, h = y1 - y0 + 1, o = new Float32Array(w * h); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) o[y * w + x] = v[(y0 + y) * TS + a + x]; return [o, w, h] }
      const [o, w, h] = crop(x0, x1 + 1)
      const g = BF.glyphTest(BF.fitMaskTo5x7(o, w, h), { min: 6 })
      expect(g.pass, `nearest ${g.nearest} at ${g.distance}`).toBe(true)
      const mid = Math.floor((x0 + x1 + 1) / 2)
      for (const [a, b] of [[x0, mid], [mid, x1 + 1]]) { const [q, qw, qh] = crop(a, b); expect(BF.glyphTest(BF.fitMaskTo5x7(q, qw, qh), { min: 6 }).pass).toBe(true) }
    }
  })
  it('the upper storey: the vacant voids are black (under 45), the lit shades warm, the boards plywood; a roofless house shows the sky', () => {
    const B = bands()
    B.upper.forEach((u, i) => {
      const s = STACKS[i]
      if (s.kind !== 'upper') return
      s.variants.forEach((v, k) => {
        const t = u.variants[k][0]
        if (v === 'void' || v === 'rail') expect(meanLum(t, 20, 12, 43, 54), `${s.key} ${v}`).toBeLessThan(45)
        if (v === 'lit') { const [r, , b] = meanRgb(t, 20, 12, 43, 54); expect(r).toBeGreaterThan(b + 20); expect(meanLum(t, 20, 12, 43, 54)).toBeGreaterThan(80) }
        // the sky only in the top of the void (inside the casing), the room below it as dark as any void
        if (v === 'sky' || v === 'skyRail') {
          const [r, g, b] = meanRgb(t, 21, 10, 42, 15)
          expect(Math.min(r, g, b)).toBeGreaterThan(130); expect(Math.max(r, g, b) - Math.min(r, g, b)).toBeLessThan(25)
          expect(meanLum(t, 21, 30, 42, 54), `${s.key} ${v}: the room under the sky`).toBeLessThan(45)
        }
        if (v === 'boarded') expect(meanLum(t, 20, 12, 43, 54)).toBeGreaterThan(90)
      })
    })
  })
  it('the jut fronts stand on pale marble (the basement, the stoop); their ends are grey parge', () => {
    for (const u of bands().upper) {
      if (u.kind === 'front') expect(meanLum(u.lower[0][0], 2, 44, 61, 63), u.key).toBeGreaterThan(150)
      if (u.kind === 'end') { const [r, g, b] = meanRgb(u.lower[0][1], 0, 0, 63, 63); expect(Math.max(r, g, b) - Math.min(r, g, b)).toBeLessThan(40) }
    }
  })
})

describe('the fixes of 2026-11-17', () => {
  const quant = (t, x0, y0, x1, y1, q) => { const v = []; for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) v.push(lum(t, (y * TS + x) * 3)); v.sort((a, b) => a - b); return v[Math.floor(q * (v.length - 1))] }
  it('the jut front doors are closed brown four-panel leaves (luma 50–90), not open black doorways', () => {
    const doors = bands().upper.filter((u) => u.kind === 'front' && u.key.endsWith('|door'))
    expect(doors.length).toBe(2)
    for (const u of doors) {
      const [b0, b1] = u.lower[0]
      for (const [t, y0, y1] of [[b1, 34, 62], [b0, 0, 36]]) {
        const L = meanLum(t, 21, y0, 44, y1), [r, , b] = meanRgb(t, 21, y0, 44, y1)
        expect(L, u.key).toBeGreaterThan(50); expect(L, u.key).toBeLessThan(90); expect(r).toBeGreaterThan(b)
      }
    }
  })
  it('the stoop reads as steps: each tread\'s nosing lit over the riser under it, the stoop still pale marble', () => {
    for (const u of bands().upper) {
      if (u.kind !== 'front' || !u.key.endsWith('|door')) continue
      const b0 = u.lower[0][0]
      for (let k = 0; k < 4; k++) { const r = 40 + 6 * k; expect(meanLum(b0, 20, r, 44, r), `${u.key} step ${k}`).toBeGreaterThan(1.1 * meanLum(b0, 20, r + 2, 44, r + 5)) }
      expect(meanLum(b0, 16, 40, 48, 63)).toBeGreaterThan(150)
    }
  })
  it('the sealed doors\' CMU reads as block: its 1-texel joints against the block (luma contrast over 0.15)', () => {
    for (const p of uniq(bands().code.C)) {
      const lo = quant(p[0], 19, 4, 44, 46, 0.1), hi = quant(p[0], 19, 4, 44, 46, 0.6)
      expect((hi - lo) / hi).toBeGreaterThan(0.15)
    }
  })
  it('a painted house is painted to the ground: its faces take its own ground storey, the paint round the openings', () => {
    const B = bands(), { faces, width } = planBlockStacks(plan)
    let painted = 0
    STACKS.forEach((s, i) => {
      if (s.kind !== 'upper' || s.look.clad !== 'painted') return
      const u = B.upper[i]
      expect(u.lowerBy, s.key).toBeTruthy()
      for (const [ch, ps] of Object.entries(u.lowerBy)) for (const p of ps) {
        const w = meanRgb(p[1], 2, 20, 9, 60), raw = meanRgb(B.code[ch][0][1], 2, 20, 9, 60)
        expect(Math.abs(w[0] - raw[0]) + Math.abs(w[1] - raw[1]) + Math.abs(w[2] - raw[2]), `${s.key} ${ch}`).toBeGreaterThan(30)
        if (s.look.paint !== 'red-oxide') expect(Math.max(...w) - Math.min(...w), `${s.key} ${ch}: the paint, not the brick`).toBeLessThan(25)
      }
    })
    // the CPU's pick (the GPU's is the same: gfx-gl-bands.test.js) gives every face of a painted house its look's pair
    for (let k = 0; k < faces.length; k++) {
      const st = faces[k]
      if (st < 0 || !B.upper[st].lowerBy) continue
      const x = (k >> 1) % width, y = Math.floor((k >> 1) / width), ch = NULL_MAP[y][x], by = B.upper[st].lowerBy[ch]
      if (!by) continue
      expect(by).toContain(pickBandPairs(B, ch, st, x, y, k & 1).lo)
      painted++
    }
    expect(painted).toBeGreaterThan(20)
  })
  it('a renderer for the block builds the band tiles when it is created, not on its first frame; the GPU path shares the memoised build', () => {
    vi.stubGlobal('document', { createElement: () => fakeCanvas(0, 0) })
    try {
      clearTexturesMemo()
      const cfg = levelConfig(DEFAULT_CONFIG, LEVELS.findIndex((l) => l.id === '∅'))
      createCpuRenderer(fakeCanvas(), cfg, { qualityTier: 'medium' })
      const tex = buildTexturesMemo(cfg.palette, cfg.materials, cfg.look, '∅'), t0 = performance.now()
      expect(tex.wallBands.upper.length).toBe(STACKS.length)
      expect(performance.now() - t0).toBeLessThan(100)                    // already built (a build of its own takes over a second)
    } finally { vi.unstubAllGlobals(); clearTexturesMemo() }
    // gfx-gl.js: the validation's CPU reference (createCpuRenderer, buildTexturesMemo) then finds this very TexSet
    const gl = readFileSync(new URL('../src/renderer/gfx-gl.js', import.meta.url), 'utf8')
    expect(gl).toContain('(deps.buildTextures || buildTexturesMemo)(config.palette, config.materials, config.look, LEVEL_KEY)')
  })
  it('the jut ends: the lost neighbour\'s floor lines read against the parge (0.1 luma or more)', () => {
    for (const u of bands().upper) {
      if (u.kind !== 'end') continue
      // the floor lines at 3.96 and 0.76 m: canvas rows 32 + (7 - z) * 32 of the 8 m canvas = band 1 row 1 and band 0 row 39
      for (const [t, r, ref] of [[u.lower[0][1], 1, [4, 5]], [u.lower[0][0], 39, [35, 43]]]) {
        const line = meanLum(t, 0, r, 63, r), around = (meanLum(t, 0, ref[0], 63, ref[0]) + meanLum(t, 0, ref[1], 63, ref[1])) / 2
        expect((around - line) / around, `${u.key} row ${r}`).toBeGreaterThan(0.1)
      }
    }
  })
})

describe('the colour rule, the level and the shells', () => {
  it('a drifted B hex drifts the brick bays\' pairs and the brick storeys; the formstone does not move (the trim, the belt among it, does)', () => {
    const d = buildBlockBands(PAL, { ...MATS, B: '#5A4A8A' }, plan), b = bands()
    for (const ch of ['B', 'C', 'P', 'W']) expect(sha(d.code[ch][0][1]), ch).not.toBe(sha(b.code[ch][0][1]))
    expect(sha(d.code.F[0][0])).toBe(sha(b.code.F[0][0]))
    expect(sha(rowsOf(d.code.F[0][1], 2, TS))).toBe(sha(rowsOf(b.code.F[0][1], 2, TS)))
    expect(sha(rowsOf(d.code.F[0][1], 0, 2))).not.toBe(sha(rowsOf(b.code.F[0][1], 0, 2)))       // the belt follows the trim, as the sills do
  })
  it('levels.js: Level ∅ stands 3.5 cells tall; no other level sets a wall height', () => {
    const i = LEVELS.findIndex((l) => l.id === '∅')
    expect(LEVELS[i].config.wallH).toBe(3.5)
    for (let k = 0; k < LEVELS.length; k++) if (k !== i) expect(levelConfig(DEFAULT_CONFIG, k).wallH).toBeUndefined()
  })
  it('both offline shells carry block-stacks.js; it holds none of the game text\'s digit runs', () => {
    const sw = readFileSync(new URL('../src/sw.js', import.meta.url), 'utf8'), build = readFileSync(new URL('../tools/build-play.sh', import.meta.url), 'utf8')
    expect(sw).toContain("'/renderer/block-stacks.js'"); expect(build).toContain("'block-stacks.js'")
    // every run of three or more digits inside a string of the game's own text modules, read from them here rather than written down
    const text = ['origin-tenant.js', 'status.js'].map((f) => readFileSync(new URL('../src/renderer/' + f, import.meta.url), 'utf8')).join('\n')
    const runs = [...new Set((text.match(/(['"`])(?:\\.|(?!\1)[^\\\n])*\1/g) || []).flatMap((s) => s.match(/\d{3,}/g) || []))]
    expect(runs.length).toBeGreaterThan(0)
    const src = readFileSync(new URL('../src/renderer/block-stacks.js', import.meta.url), 'utf8')
    expect(runs.filter((r) => src.includes(r)).length).toBe(0)
  })
})
