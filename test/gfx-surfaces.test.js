// gfx-surfaces.test.js — the per-level surface art (Track A1): the LEVEL_SURFACES styles in gfx-textures.js.
//   * seam guarantee: every variant of a wall / floor / ceiling agrees with its base tile at the edges, so any two variants can
//     sit next to each other; measured as the actual junction discontinuity between every ordered pair of variants
//   * determinism (no Math.random, order independent), palette-driven colour, variant budget, build time
//   * new goldens pin the looks; content checks keep the Level ∅ materials meaning what they meant (a lit window is bright, the
//     black window is dark, the plywood keeps its sprayed-number glyph, …)
// Palettes and materials are copied from levels.js (not imported) so a palette tweak cannot silently move the goldens.
import { describe, it, expect, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { buildTextures } from '../src/renderer/gfx-textures.js'
import { renderWorld } from '../src/renderer/gfx-world.js'
import { levelConfig } from '../src/renderer/levels.js'
import { DEFAULT_CONFIG } from '../src/renderer/world.js'

// several tests build every level (cold JIT): give them room on a loaded CI machine or a laptop
vi.setConfig({ testTimeout: 30000 })

const TS = 64
const PAL = {
  '0': { wall: '#C8B870', ceiling: '#E8E0C0', floor: '#4A3820', fog: '#D4C87A' },
  '1': { wall: '#8C8674', ceiling: '#9E9A88', floor: '#39372F', fog: '#A29C86' },
  '2': { wall: '#705C46', ceiling: '#4C4238', floor: '#2B2520', fog: '#5C503E' },
  '3': { wall: '#4C505A', ceiling: '#3A3E46', floor: '#22252B', fog: '#363B44' },
  '∅': { wall: '#B8A888', ceiling: '#B9B7AE', floor: '#5A5048', fog: '#9A968C' },
}
const MATS = { F: '#B8A888', C: '#8F8F8F', P: '#7A6A52', B: '#8A4A3A', W: '#141414', O: '#7A5A48', M: '#D2D0C8' }
const KEYS = ['0', '1', '2', '3', '∅']
const CACHE = new Map()   // the default build of each level (the tests only read TexSets, never mutate them)
const build = (k, over = null) => {
  if (over) return buildTextures(over.palette || PAL[k], k === '∅' ? MATS : null, over.look ?? null, k)
  if (!CACHE.has(k)) CACHE.set(k, buildTextures(PAL[k], k === '∅' ? MATS : null, null, k))
  return CACHE.get(k)
}

const sha16 = (u8) => createHash('sha256').update(u8).digest('hex').slice(0, 16)
const shaAll = (arr) => { const h = createHash('sha256'); for (const t of arr) h.update(t); return h.digest('hex').slice(0, 16) }
const uniq = (arr) => [...new Set(arr)]

// every surface of a TexSet as { name, base, tiles (base + its unique variants), both: whether it must also seam vertically, margin }
function surfaces(tex) {
  const out = []
  for (const code of Object.keys(tex.walls)) {
    const vars = tex.wallVar && tex.wallVar[code] ? tex.wallVar[code] : []
    out.push({ name: 'wall ' + code, base: tex.walls[code], tiles: uniq([tex.walls[code], ...vars]), both: false, margin: 3 })
  }
  out.push({ name: 'floor', base: tex.floor, tiles: uniq([tex.floor, ...(tex.floorVar || [])]), both: true, margin: 2 })
  out.push({ name: 'ceil', base: tex.ceil, tiles: uniq([tex.ceil, ...(tex.ceilVar || [])]), both: true, margin: 2 })
  return out
}

// mean absolute difference (0..255) between a's right-most column and b's left-most column: the seam when a sits left of b
function seamX(a, b) { let s = 0; for (let y = 0; y < TS; y++) for (let c = 0; c < 3; c++) s += Math.abs(a[(y * TS + TS - 1) * 3 + c] - b[(y * TS) * 3 + c]); return s / (TS * 3) }
// same for a's bottom row against b's top row (a above b)
function seamY(a, b) { let s = 0; for (let x = 0; x < TS; x++) for (let c = 0; c < 3; c++) s += Math.abs(a[((TS - 1) * TS + x) * 3 + c] - b[x * 3 + c]); return s / (TS * 3) }
const colDiff = (t, x0, x1) => { let s = 0; for (let y = 0; y < TS; y++) for (let c = 0; c < 3; c++) s += Math.abs(t[(y * TS + x0) * 3 + c] - t[(y * TS + x1) * 3 + c]); return s / (TS * 3) }
const rowDiff = (t, y0, y1) => { let s = 0; for (let x = 0; x < TS; x++) for (let c = 0; c < 3; c++) s += Math.abs(t[(y0 * TS + x) * 3 + c] - t[(y1 * TS + x) * 3 + c]); return s / (TS * 3) }
const lum = (t, i) => t[i] * 0.299 + t[i + 1] * 0.587 + t[i + 2] * 0.114
function meanLum(t, x0, y0, x1, y1) { let s = 0, n = 0; for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { s += lum(t, (y * TS + x) * 3); n++ } return s / n }
function meanRgb(t, x0, y0, x1, y1) { const s = [0, 0, 0]; let n = 0; for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { for (let c = 0; c < 3; c++) s[c] += t[(y * TS + x) * 3 + c]; n++ } return s.map((v) => v / n) }
function changedTexels(a, b) { let n = 0; for (let i = 0; i < a.length; i += 3) if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) n++; return n }

describe('real levels: TexSet shape', () => {
  for (const k of KEYS) {
    it(`level ${k}: 64px tiles, all tiles ts*ts*3 bytes, variants on every styled surface`, () => {
      const tex = build(k)
      expect(tex.ts).toBe(64); expect(tex.tmask).toBe(63)
      const tiles = [tex.walls['0'], tex.ceil, tex.floor, tex.light, ...(tex.wallVar ? Object.values(tex.wallVar).flat() : []), ...(tex.floorVar || []), ...(tex.ceilVar || [])]
      for (const t of tiles) { expect(t).toBeInstanceOf(Uint8Array); expect(t.length).toBe(TS * TS * 3) }
      expect(tex.wallVar['0'].length).toBeGreaterThan(1)
      expect(tex.floorVar.length).toBeGreaterThan(1)
      if (k !== '∅') expect(tex.ceilVar.length).toBeGreaterThan(1)      // ∅ has open sky: its ceiling tile is never drawn
      for (const code of Object.keys(tex.wallVar)) expect(Object.keys(tex.walls)).toContain(code)
    })
  }
  it('Level ∅ keeps every material code and gives each its own variants', () => {
    const tex = build('∅')
    expect(Object.keys(tex.walls).sort()).toEqual(['0', 'B', 'C', 'F', 'M', 'O', 'P', 'W'])
    for (const ch of Object.keys(MATS)) expect(tex.wallVar[ch].length, ch).toBeGreaterThan(1)
  })
  it('works from the real level configs (levels.js) exactly as gfx-cpu.js calls it', () => {
    for (let i = 0; i < 5; i++) {
      const cfg = levelConfig(DEFAULT_CONFIG, i)
      const tex = buildTextures(cfg.palette, cfg.materials, cfg.look, String(cfg.levelIndex))
      expect(tex.wallVar, `level ${i}`).not.toBeNull()
      expect(tex.floorVar, `level ${i}`).not.toBeNull()
    }
  })
})

describe('variant budget', () => {
  it('each surface has about 4-8 distinct variants (plus the weighting repeats of the plain tile)', () => {
    for (const k of KEYS) {
      const tex = build(k)
      for (const s of surfaces(tex)) {
        if (s.name === 'ceil' && k === '∅') continue
        const n = s.tiles.length
        expect(n, `${k} ${s.name}`).toBeGreaterThanOrEqual(3)
        expect(n, `${k} ${s.name}`).toBeLessThanOrEqual(8)
      }
      for (const arr of [...Object.values(tex.wallVar || {}), tex.floorVar, tex.ceilVar]) if (arr) expect(arr.length).toBeLessThanOrEqual(24)
    }
  })
  it('every non-plain variant really differs from its base tile', () => {
    for (const k of KEYS) for (const s of surfaces(build(k))) {
      if (s.name === 'ceil' && k === '∅') continue
      for (const t of s.tiles) if (t !== s.base) expect(changedTexels(t, s.base), `${k} ${s.name}`).toBeGreaterThan(20)
    }
  })
})

describe('seams: variants tile against each other', () => {
  it('every variant is byte-identical to the base tile in its outer margin (columns; and rows for floors / ceilings)', () => {
    const bad = []
    for (const k of KEYS) for (const s of surfaces(build(k))) {
      s.tiles.forEach((t, n) => {
        let diff = 0
        for (let y = 0; y < TS; y++) for (let x = 0; x < TS; x++) {
          const inCols = x < s.margin || x >= TS - s.margin, inRows = s.both && (y < s.margin || y >= TS - s.margin)
          if (!inCols && !inRows) continue
          const i = (y * TS + x) * 3
          if (t[i] !== s.base[i] || t[i + 1] !== s.base[i + 1] || t[i + 2] !== s.base[i + 2]) diff++
        }
        if (diff) bad.push(`${k} ${s.name} tile #${n}: ${diff} texels`)
      })
    }
    expect(bad).toEqual([])
  })
  it('measured junction discontinuity: no pair of variants seams worse than the base tile seams with itself', () => {
    const bad = []
    for (const k of KEYS) for (const s of surfaces(build(k))) {
      const baseX = seamX(s.base, s.base), baseY = seamY(s.base, s.base)
      for (const a of s.tiles) for (const b of s.tiles) {
        if (seamX(a, b) > baseX + 1e-9) bad.push(`${k} ${s.name} horizontal`)
        if (s.both && seamY(a, b) > baseY + 1e-9) bad.push(`${k} ${s.name} vertical`)
      }
    }
    expect(bad).toEqual([])
  })
  it('the base pattern itself wraps: its own seam is no worse than a 1px joint plus the tile\'s worst interior column / row step', () => {
    for (const k of KEYS) for (const s of surfaces(build(k))) {
      if (s.name === 'ceil' && k === '∅') continue
      let maxX = 0; for (let x = 4; x < 59; x++) maxX = Math.max(maxX, colDiff(s.base, x, x + 1))
      expect(colDiff(s.base, TS - 1, 0), `${k} ${s.name} x`).toBeLessThanOrEqual(1.5 * maxX + 30)
      if (s.both) {
        let maxY = 0; for (let y = 4; y < 59; y++) maxY = Math.max(maxY, rowDiff(s.base, y, y + 1))
        expect(rowDiff(s.base, TS - 1, 0), `${k} ${s.name} y`).toBeLessThanOrEqual(1.5 * maxY + 30)
      }
    }
  })
})

describe('determinism', () => {
  const fingerprint = (tex) => surfaces(tex).map((s) => `${s.name}:${sha16(s.base)}:${shaAll(s.tiles)}`).join('|') + '|' + sha16(tex.light)
  it('two builds are byte-identical, whatever was built in between (no state leaks between levels or palettes)', () => {
    const first = KEYS.map((k) => fingerprint(build(k)))
    build('∅'); build('2', { palette: { ...PAL['2'], wall: '#204060', floor: '#102030' } }); build('0')
    const again = KEYS.slice().reverse().map((k) => fingerprint(build(k))).reverse()
    expect(again).toEqual(first)
  })
  it('never touches Math.random (every player sees the same walls)', () => {
    const spy = vi.spyOn(Math, 'random').mockImplementation(() => { throw new Error('Math.random used') })
    try { for (const k of KEYS) build(k) } finally { spy.mockRestore() }
  })
  it('the surfaces of different levels are different art', () => {
    const walls = KEYS.map((k) => sha16(build(k).walls['0']))
    expect(uniq(walls).length).toBe(KEYS.length)
    const floors = KEYS.map((k) => sha16(build(k).floor))
    expect(uniq(floors).length).toBe(KEYS.length)
  })
})

describe('golden bytes of the new looks (sha256 prefixes)', () => {
  // light: re-pinned by track HW (V6) — the panel's diffuser bands are softened (half the contrast, smooth shoulders);
  // level 0 floor / floorVar: re-pinned by track HW (V7) — the carpet's second tone and damp stain keep the floor's own yellow-brown hue
  const GOLD = {
    '0': { wall: '98235064cfd3c54e', floor: 'a686bf5cf2c6b5f9', ceil: 'd0571a081e89b01b', light: '6d5604b4c50cb7c6', wallVar: 'ee2abc7b854eb853', floorVar: '8c1f6345680db818', ceilVar: 'a16e48594ffd0aa1' },
    '1': { wall: 'c28b5e79d5c28fdf', floor: '9d0e99ca564a8f72', ceil: '1f2dc1af45d2c186', light: '9652a5711e029cd3', wallVar: '08f79b549ddff906', floorVar: '7d3d0725eaefbc3a', ceilVar: '5dcaae8a7dc40ce2' },
    '2': { wall: '8f04a5ee0cc11fc3', floor: '1669f844308d8eec', ceil: '09d418a1f4edc404', light: '9652a5711e029cd3', wallVar: 'b8267566aa0513ac', floorVar: '51e261d64d38515f', ceilVar: 'a9becfd60f679228' },
    '3': { wall: '4e4b7e7aba5e0097', floor: '2469343ec9471447', ceil: 'b6ff82a67a0f8b48', light: '9652a5711e029cd3', wallVar: '01a2e2f6721f2580', floorVar: 'e53b717229df7281', ceilVar: '0aa64c71eb78904b' },
    '∅': { wall: 'a8d6562acaed1c63', floor: '8b5da795d325916d', ceil: '3d1cb2a3f04b78fe', light: '9652a5711e029cd3', wallVar: '0fa2e9d6f959a2f7', floorVar: '75bd92545fe95091' },
  }
  const GOLD_MAT = {
    F: ['a8d6562acaed1c63', '0fa2e9d6f959a2f7'], C: ['b72974b6b9ec6f5a', '3e82ede79b69015d'], P: ['c49e3417be12062a', 'efaa50e17fa3be74'],
    B: ['86095ccf34c74c57', '9087e31d3588df2e'], W: ['24b95e2e332eee03', 'b4ad94e6a57b7352'], O: ['297569aa37882be2', '2fa2bd4d82f7f5f2'], M: ['e27f9e75a9c33a47', '153faa7161bc4869'],
  }
  for (const k of KEYS) {
    it(`level ${k}: base tiles and the whole variant sets`, () => {
      const t = build(k), g = GOLD[k]
      expect(sha16(t.walls['0'])).toBe(g.wall)
      expect(sha16(t.floor)).toBe(g.floor)
      expect(sha16(t.ceil)).toBe(g.ceil)
      expect(sha16(t.light)).toBe(g.light)
      expect(shaAll(t.wallVar['0'])).toBe(g.wallVar)
      expect(shaAll(t.floorVar)).toBe(g.floorVar)
      if (g.ceilVar) expect(shaAll(t.ceilVar)).toBe(g.ceilVar)
    })
  }
  it('level ∅: every authored material tile and its variants', () => {
    const t = build('∅')
    for (const [ch, [base, vars]] of Object.entries(GOLD_MAT)) {
      expect(sha16(t.walls[ch]), ch).toBe(base)
      expect(shaAll(t.wallVar[ch]), ch + ' variants').toBe(vars)
    }
  })
})

describe('colour is driven by the palette', () => {
  it('the lobby stays mono-yellow; drifting the palette drifts the wall with it', () => {
    const [r, g, b] = meanRgb(build('0').walls['0'], 0, 8, 63, 48)
    expect(r).toBeGreaterThan(b * 1.4); expect(g).toBeGreaterThan(b * 1.4)
    const drift = build('0', { palette: { ...PAL['0'], wall: '#3050B0', floor: '#203060', ceiling: '#C0D0F0' } })
    const [r2, , b2] = meanRgb(drift.walls['0'], 0, 8, 63, 48)
    expect(b2).toBeGreaterThan(r2 * 1.3)
    const [fr, , fb] = meanRgb(drift.floor, 0, 0, 63, 63)
    expect(fb).toBeGreaterThan(fr)
  })
  it('each level tracks its own palette (mean wall / floor luminance orders like the palette)', () => {
    const wl = ['0', '1', '2', '3'].map((k) => meanLum(build(k).walls['0'], 0, 8, 63, 48))
    expect(wl[0]).toBeGreaterThan(wl[1]); expect(wl[1]).toBeGreaterThan(wl[2]); expect(wl[2]).toBeGreaterThan(wl[3])
  })
  it('degenerate palettes (all black, all white) build without throwing and stay in range', () => {
    for (const k of KEYS) for (const hex of ['#000000', '#FFFFFF']) {
      const tex = build(k, { palette: { wall: hex, ceiling: hex, floor: hex, fog: hex } })
      expect(tex.walls['0'].length).toBe(TS * TS * 3)
    }
  })
})

describe('config.look overrides', () => {
  it('a known style name replaces the level default; an unknown one is ignored', () => {
    const def = build('1')
    const rust = buildTextures(PAL['1'], null, { wall: 'rust' }, '1')
    expect(sha16(rust.walls['0'])).not.toBe(sha16(def.walls['0']))
    expect(sha16(rust.floor)).toBe(sha16(def.floor))                       // only the wall changed
    const junk = buildTextures(PAL['1'], null, { wall: 'nonsense', floor: 42 }, '1')
    expect(sha16(junk.walls['0'])).toBe(sha16(def.walls['0']))
    expect(sha16(junk.floor)).toBe(sha16(def.floor))
  })
  it('a look on a hand-built (legacy) config styles only what it names and leaves the rest as the original tiles', () => {
    const legacy = buildTextures(PAL['0'])
    const part = buildTextures(PAL['0'], null, { floor: 'gravel' })
    expect(sha16(part.floor)).not.toBe(sha16(legacy.floor))
    expect(sha16(part.walls['0'])).toBe(sha16(legacy.walls['0']))
    expect(sha16(part.ceil)).toBe(sha16(legacy.ceil))
    expect(part.wallVar).toBeNull(); expect(part.ceilVar).toBeNull(); expect(part.floorVar.length).toBeGreaterThan(1)
  })
  it('the legacy call (no look, no level key) has no variants at all, and an empty look changes nothing', () => {
    const a = buildTextures(PAL['0']), b = buildTextures(PAL['0'], null, {}, 'legacy')
    expect(a.wallVar).toBeNull(); expect(a.floorVar).toBeNull(); expect(a.ceilVar).toBeNull()
    expect(sha16(b.walls['0'])).toBe(sha16(a.walls['0'])); expect(sha16(b.floor)).toBe(sha16(a.floor)); expect(b.wallVar).toBeNull()
  })
})

describe('Level ∅ materials keep their meaning', () => {
  const tiles = (ch) => uniq([build('∅').walls[ch], ...build('∅').wallVar[ch]])
  // the legacy mask of the sprayed number: a checker of 6x8 cells inside (0.32..0.68, 0.26..0.5) of the tile
  const onMask = (x, y) => x >= TS * 0.32 && x <= TS * 0.68 && y >= TS * 0.26 && y <= TS * 0.5 && (Math.floor((x - TS * 0.32) / 6) + Math.floor((y - TS * 0.26) / 8)) % 2 === 0
  const inBox = (x, y) => x >= TS * 0.32 && x <= TS * 0.68 && y >= TS * 0.26 && y <= TS * 0.5

  it('P: the sprayed number keeps its position, its orange, and its contrast against the board — in every variant', () => {
    for (const t of tiles('P')) {
      let on = 0, onOrange = 0, off = 0, offOrange = 0
      for (let y = 0; y < TS; y++) for (let x = 0; x < TS; x++) {
        if (!inBox(x, y)) continue
        const i = (y * TS + x) * 3, orange = t[i] > 190 && t[i + 1] > 100 && t[i + 1] < 200 && t[i + 2] < 110
        if (onMask(x, y)) { on++; if (orange) onOrange++ } else { off++; if (orange) offOrange++ }
      }
      expect(onOrange / on).toBeGreaterThan(0.95)
      expect(offOrange / off).toBeLessThan(0.08)
    }
  })
  it('W: a black open window (dark hole, in every variant); O: a warm lit window (bright hole)', () => {
    for (const t of tiles('W')) expect(meanLum(t, 14, 14, 49, 48)).toBeLessThan(45)
    for (const t of tiles('O')) {
      expect(meanLum(t, 14, 14, 49, 48)).toBeGreaterThan(100)
      const [r, , b] = meanRgb(t, 14, 14, 49, 48)
      expect(r).toBeGreaterThan(b * 1.35)                                   // warm, not white
    }
  })
  it('M: pale marble; C: a doorway outline is visible in the blockwork; B / F: real tone variation between blocks', () => {
    for (const t of tiles('M')) expect(meanLum(t, 4, 4, 59, 59)).toBeGreaterThan(150)
    for (const t of tiles('C')) {
      const frame = meanLum(t, 13, 14, 13, 56), block = meanLum(t, 4, 14, 8, 56)
      expect(Math.abs(frame - block) / Math.max(frame, block)).toBeGreaterThan(0.15)
    }
    const cellSpread = (t) => { const m = []; for (let cy = 0; cy < 8; cy++) for (let cx = 0; cx < 8; cx++) m.push(meanLum(t, cx * 8, cy * 8, cx * 8 + 7, cy * 8 + 7)); const mu = m.reduce((a, b) => a + b) / m.length; return Math.sqrt(m.reduce((a, b) => a + (b - mu) ** 2, 0) / m.length) }
    expect(cellSpread(build('∅').walls.B)).toBeGreaterThan(4)
    expect(cellSpread(build('∅').walls.F)).toBeGreaterThan(3)
  })
})

describe('build cost and the world pass', () => {
  it('builds every level at a sane cost (a generous sanity bound only; the real numbers are in the track report)', () => {
    for (const k of KEYS) { const t0 = performance.now(); buildTextures(PAL[k], k === '∅' ? MATS : null, null, k); expect(performance.now() - t0, `level ${k}`).toBeLessThan(10000) }
  })
  it('the world pass renders a real level-0 TexSet (variants active) deterministically, with real colour variation', () => {
    const W = 160, H = 90, fov = Math.PI / 2.4
    const tex = build('0')
    const isWall = (wx, wy) => wx <= 0 || wy <= 0 || wx >= 15 || wy >= 15
    const fs = { W, H, HH: H >> 1, OW: W, OH: H, fog: 1e9, fogRgb: [212, 200, 122], fogMul: 1, flicker: 1, rawFlicker: 1, frame: 1, t: 0, dt: 1 / 60,
      player: { x: 7.5, y: 7.5, angle: 0.4, bobOffset: 0 }, lights: {}, lightsOn: true, hasSky: false, skyRgb: null, light: null,
      comfort: { reduceFlicker: false, maxGlobalDip: 1 }, quality: { scale: 0.6 }, opts: {}, fov, hf: fov / 2 }
    const buf = new Uint32Array(W * H)
    renderWorld(fs, tex, null, isWall, null, buf, new Float32Array(W))
    expect(new Set(buf).size).toBeGreaterThan(400)
    const again = new Uint32Array(W * H)
    renderWorld(fs, tex, null, isWall, null, again, new Float32Array(W))
    expect(Array.from(again)).toEqual(Array.from(buf))
  })
})
