// gfx-gl-world-data.js — the pure (no GL, no DOM) half of the GPU world pass (gfx-gl-world.js): everything that decides WHAT the shader is
// handed, so it can be unit-tested in Node. Nothing here invents a look: each function is a port of the CPU world pass's per-column or per-frame
// arithmetic (gfx-world.js / gfx-light.js / gfx-sky.js), kept in the same order and with the same constants.
//
//   planTiles(tex)                  the TexSet's tiles -> the layers of ONE texture array, and where each surface's variants start
//   tilesToRgba(plan)               the layers as RGBA8 (the array texture's upload data)
//   wallLayer(plan, hit, mat)       the array layer a wall column samples (material + per-cell variant, as gfx-world.js picks the tile)
//   bandLayers(plan, hit, mat, st)  the storeys' band layers of a wall column (gfx-world.js pickBandPairs picks the tiles)
//   wallPoolShare(F, hit, px, py)   the fraction of pool light a wall column receives (gfx-world.js renderLit, per column)
//   fillCellTexture(F, out)         the toroidal cell window (contact bits, lamp flags, lamp levels) as an RGBA8 image
//   fillPoolTable / fillWallTable   the periodic pool tiles and the wall's vertical tables as float images
//   buildSkyRows(fs, out, W)        the per-row terms of the overcast sky (gfx-sky.js renderSky, the part that does not depend on the column)
//   hash2Ref                        JS reference of the GLSL hash the shader uses to pick floor / ceiling variants (see the test)
import { hash2 } from './gfx-util.js'
import { LM_FADE_CELLS } from './gfx-light.js'
import { pickBandPairs } from './gfx-world.js'
import { noise2, skyBase, skyConfigFor, CLOUD_W, CLOUD_H, stripRowTan } from './gfx-sky.js'

export const POOL_N = 64                 // the periodic pool tile is 64 x 64 samples (gfx-light.js TILE_N)
export const OCC_N = 64                  // the cell window is 64 x 64 (toroidal)
export const LM_N = 128                  // the lamp lightmap is 128 x 128 samples (toroidal)
export const LMC_N = 32                  // ... and 32 x 32 light cells
export const LEV_MAX = 33                // the panel level grid is at most 33 x 33 (gfx-light.js: G <= 16)
export const S_MAX = stripRowTan(CLOUD_H - 0.5)     // tan(elevation) covered by the top strip row (gfx-sky.js keeps the constant private)

// ── tiles ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// plan = { ts, layers: [rgb tile ...], walls: { code: { base, count } }, floor: { base, count }, ceil: { base, count }, light }
// A wall code's `count` is its number of per-cell variants (1 = the plain tile, exactly the CPU's `arr.length > 1` rule); floor / ceiling `count` is the
// length of the variant list the CPU hashes into (1 when the level has none). Identical tiles share a layer.
// opts.bands (the level draws storeys): the TexSet's band tiles (TexSet.wallBands) are added after the rest, every ground-storey pair
// [b0, b1] as two CONSECUTIVE layers (the shader adds the band to the pair's base) and every upper tile once; plan.bands = { set (the
// wallBands), pair (Map pair -> its base layer), layer (Map tile -> its layer) }. Without it (or with no band tiles) plan.bands is null and
// the plan is what it always was.
export function planTiles(tex, opts = {}) {
  const layers = [], seen = new Map()
  const add = (t) => { let i = seen.get(t); if (i === undefined) { i = layers.length; layers.push(t); seen.set(t, i) } return i }
  // a run of variants must be CONSECUTIVE layers (the shader adds hash % count to the base), so it is pushed as a block, never deduplicated into
  const block = (arr) => { const base = layers.length; for (const t of arr) { layers.push(t); if (!seen.has(t)) seen.set(t, layers.length - 1) } return base }
  const walls = {}
  for (const code of Object.keys(tex.walls)) {
    const arr = tex.wallVar && tex.wallVar[code]
    if (arr && arr.length > 1) walls[code] = { base: block(arr), count: arr.length }
    else walls[code] = { base: add(tex.walls[code]), count: 1 }
  }
  if (!walls['0']) throw new Error('planTiles: the TexSet has no wall material "0"')
  const surf = (single, vars) => (vars && vars.length > 1 ? { base: block(vars), count: vars.length } : { base: add(vars && vars.length === 1 ? vars[0] : single), count: 1 })
  const floor = surf(tex.floor, tex.floorVar), ceil = surf(tex.ceil, tex.ceilVar)
  const light = add(tex.light)
  let bands = null
  const B = opts.bands ? tex.wallBands || null : null
  if (B) {
    const pair = new Map()
    const addPair = (p) => { if (!pair.has(p)) pair.set(p, block(p)) }
    for (const code of Object.keys(B.code)) for (const p of B.code[code]) addPair(p)
    for (const s of B.upper) {
      if (s.lower) for (const p of s.lower) addPair(p)
      if (s.lowerBy) for (const code of Object.keys(s.lowerBy)) for (const p of s.lowerBy[code]) addPair(p)       // a painted house's ground storey
      for (const p of s.variants) { add(p[0]); add(p[1]) }
    }
    add(B.fallback[0]); add(B.fallback[1])
    bands = { set: B, pair, layer: seen }
  }
  return { ts: tex.ts, layers, walls, floor, ceil, light, bands }
}

// The band layers of a wall column on a level that draws storeys, picked exactly as the CPU picks the tiles (gfx-world.js pickBandPairs):
// out = [lower, upper2, upper3, pair] with lower the layer of band 0 (band 1 is lower + pair: 1 for a ground-storey pair, 0 when the face
// repeats its 1-cell tile) and upper2 / upper3 the layers of bands 2 and 3 (-1: the 1-cell tile again). st = the face's stack (stackAt), -1
// for none. A plan without bands gives the 1-cell layer and no upper.
export function bandLayers(plan, hit, mat, st, out = [0, -1, -1, 0]) {
  const one = wallLayer(plan, hit, mat)
  const pb = plan.bands
  if (!pb) { out[0] = one; out[1] = -1; out[2] = -1; out[3] = 0; return out }
  const wkey = (mat && plan.walls[mat]) ? mat : '0'
  const { lo, hi } = pickBandPairs(pb.set, wkey, st, hit.mx, hit.my, hit.side)
  out[0] = lo !== null ? pb.pair.get(lo) : one; out[3] = lo !== null ? 1 : 0
  out[1] = hi !== null ? pb.layer.get(hi[0]) : -1; out[2] = hi !== null ? pb.layer.get(hi[1]) : -1
  return out
}

// RGB (3 bytes a texel) -> RGBA8 layers, alpha 255
export function tilesToRgba(plan) {
  const ts = plan.ts, n = ts * ts
  return plan.layers.map((t) => {
    const o = new Uint8Array(n * 4)
    for (let i = 0, j = 0, k = 0; i < n; i++, j += 3, k += 4) { o[k] = t[j]; o[k + 1] = t[j + 1]; o[k + 2] = t[j + 2]; o[k + 3] = 255 }
    return o
  })
}

// The layer a wall column samples: the material's tile (a code the TexSet has no tile for falls back to '0', as the CPU does) and, when the material
// has variants, the one chosen by hashing the hit cell and side.
export function wallLayer(plan, hit, mat) {
  const p = (mat && plan.walls[mat]) ? plan.walls[mat] : plan.walls['0']
  return p.count > 1 ? p.base + hash2(hit.mx, hit.my, hit.side) % p.count : p.base
}

// The GLSL hash2 (uint arithmetic), spelled out in JS with Math.imul so a test can pin it against gfx-util.js hash2: the shader uses this to pick a
// floor / ceiling variant per cell. gfx-util.js hash2 multiplies with Math.imul too, so the two are equal for every 32-bit input (the CPU and the GPU
// pick the same variant on every cell, however far the player walks).
export function hash2Ref(a, b, c = 0) {
  let h = (Math.imul(a, 2654435761 | 0) ^ Math.imul(b, 2246822519 | 0) ^ Math.imul(c, 3266489917 | 0)) >>> 0
  h ^= h >>> 16; h = Math.imul(h, 0x45d9f3b) >>> 0
  h ^= h >>> 16
  return h >>> 0
}

// ── walls: the pool share of a column ───────────────────────────────────────────────────────────────────────────────────────────
// A port of the per-column block of renderLit (gfx-world.js): panel levels use the wall tables and the level grid, lamps / windows sample the lightmap
// just in front of the wall face. Returns the share quantised the way the CPU's table index is (pq / 63, 64 steps).
export function wallPoolShare(F, hit, px, py) {
  const side = hit.side
  const along = side === 0 ? hit.my : hit.mx
  const lev = F.dimmed ? F.lev : null
  const levN = F.levN, levI0 = F.levI0, levJ0 = F.levJ0
  let pw = 0
  if (F.panels) {
    const uIdx = Math.min(63, (((along & 1) + hit.wallX) * 32) | 0)
    pw = F.wallP[uIdx]
    if (lev !== null) {
      const posDir = side === 0 ? (hit.mx + 0.5 > px) : (hit.my + 0.5 > py)
      const face = side === 0 ? (posDir ? hit.mx : hit.mx + 1) : (posDir ? hit.my : hit.my + 1)
      const pl = face >> 1
      const a0 = (along >> 1) - 1
      let s = 0
      for (let m = 0; m < 3; m++) {
        const gi = side === 0 ? pl - levI0 : a0 + m - levI0, gj = side === 0 ? a0 + m - levJ0 : pl - levJ0
        const lv = (gi >= 0 && gi < levN && gj >= 0 && gj < levN) ? lev[gj * levN + gi] : 1
        s += lv * (m === 0 ? F.wallK0[uIdx] : m === 1 ? F.wallK1[uIdx] : F.wallK2[uIdx])
      }
      pw = s > 1 ? 1 : s
    }
  } else if (F.emitters) {
    const lm = F.lm, lmR = F.lmR, occCx = F.occCx, occCy = F.occCy
    const fx = side === 0 ? (hit.mx + 0.5 > px ? hit.mx - 0.18 : hit.mx + 1.18) : hit.mx + hit.wallX
    const fy = side === 1 ? (hit.my + 0.5 > py ? hit.my - 0.18 : hit.my + 1.18) : hit.my + hit.wallX
    const cx0 = Math.floor(fx), cy0 = Math.floor(fy)
    const ddx = cx0 - occCx, ddy = cy0 - occCy
    if (ddx >= -lmR && ddx <= lmR && ddy >= -lmR && ddy <= lmR) {
      const sxs = fx * 4 - 0.5, sys = fy * 4 - 0.5
      const i0 = Math.floor(sxs), j0 = Math.floor(sys), fxx = sxs - i0, fyy = sys - j0
      const r0 = (j0 & 127) << 7, r1 = ((j0 + 1) & 127) << 7, ia = i0 & 127, ib = (i0 + 1) & 127
      const top = lm[r0 | ia] + (lm[r0 | ib] - lm[r0 | ia]) * fxx
      const bot = lm[r1 | ia] + (lm[r1 | ib] - lm[r1 | ia]) * fxx
      let v = top + (bot - top) * fyy
      const dcW = Math.max(Math.abs(fx - px), Math.abs(fy - py))
      if (dcW > lmR - LM_FADE_CELLS) { const u = (dcW - (lmR - LM_FADE_CELLS)) / LM_FADE_CELLS; v = u >= 1 ? 0 : v * (1 - u * u * (3 - 2 * u)) }
      pw = F.poolRange > 0 ? v / F.poolRange : 0
      if (pw > 1) pw = 1
    }
  }
  return ((pw * 63 + 0.5) | 0) / 63
}

// ── the cell window ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
// 64 x 64 RGBA8, texel (x, y) = slot (y << 6) | x of the toroidal window: R = contact bits (bit0 wall on the low-x side, bit1 high-x, bit2 low-y, bit3
// high-y), G = 255 where a ceiling lamp stands (lamps mode only), B = that lamp's level 0..255 (255 unless a flicker event is dimming the lamps).
export function fillCellTexture(F, out) {
  const bits = F.cellBits, lamp = F.cellLamp, lev = F.lampDim ? F.lampLev : null, useLamps = F.lamps
  for (let s = 0, o = 0; s < OCC_N * OCC_N; s++, o += 4) {
    out[o] = bits[s]
    out[o + 1] = useLamps && lamp[s] === 1 ? 255 : 0
    const l = lev !== null ? lev[s] : 1
    out[o + 2] = (l <= 0 ? 0 : l >= 1 ? 255 : l * 255 + 0.5) | 0
    out[o + 3] = 255
  }
  return out
}

// the pool tiles as RGBA32F: rows 0..63 the floor's (S, A, B), rows 64..127 the ceiling's (S = steady, A + level * B = one panel dimmed)
export function fillPoolTable(F, out) {
  const N = POOL_N
  for (let i = 0; i < N * N; i++) {
    let o = i * 4
    out[o] = F.floorS[i]; out[o + 1] = F.floorA[i]; out[o + 2] = F.floorB[i]; out[o + 3] = 0
    o = (N * N + i) * 4
    out[o] = F.ceilS[i]; out[o + 1] = F.ceilA[i]; out[o + 2] = F.ceilB[i]; out[o + 3] = 0
  }
  return out
}

// the wall tables as RGBA32F, width `width` (>= 64, >= ts): row 0 texel k = (P, K0, K1, K2) of the wall pool along the wall (k < 64);
// row 1 texel t = (wallAmb[t], wallPool at full pool [t]) — the pool at a share q is that times q, exactly (gfx-light.js buildSurfaceTables)
// bands (the storeys): row 1 holds the taller wall's tables instead (F.bandAmb / F.bandPool over F.bandRows rows of the band canvas; width >= bandRows)
export function fillWallTable(F, ts, width, out, bands = false) {
  for (let k = 0; k < POOL_N; k++) {
    const o = k * 4
    out[o] = F.wallP[k]; out[o + 1] = F.wallK0[k]; out[o + 2] = F.wallK1[k]; out[o + 3] = F.wallK2[k]
  }
  const rows = bands ? F.bandRows : ts, amb = bands ? F.bandAmb : F.wallAmb, pool = bands ? F.bandPool : F.wallPool
  for (let t = 0; t < rows; t++) {
    const o = (width + t) * 4
    out[o] = amb[t]; out[o + 1] = pool[63 * rows + t]; out[o + 2] = 0; out[o + 3] = 0
  }
  return out
}

// ── the overcast sky ────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Per screen row (0..HH): row 0 texel = (r, g, b, cloudAmplitude) with the colour in 0..1 (the sky / fog blend, stratification band and the flicker
// multiplier folded in, exactly as renderSky builds rowR/G/B/A), row 1 texel = (strip row of layer A, strip row of layer B, 0, 0). `width` = the
// table's width (H). Returns the number of rows filled. The rows run to the pitched horizon HH and the gradient over the un-pitched sky height
// HC, exactly as renderSky does (vertical look: gfx-frame.js).
const smoothstep = (a, b, x) => { const t = x <= a ? 0 : x >= b ? 1 : (x - a) / (b - a); return t * t * (3 - 2 * t) }
const BASE = [0, 0, 0]
export function buildSkyRows(fs, out, width) {
  const { W, H, HH, skyRgb, fogRgb } = fs
  const last = Math.min(HH, H - 1)
  if (last < 0) return 0
  const cfg = skyConfigFor(fs)
  const k = fs.light && fs.light.enabled ? 1 : (fs.flicker == null ? 1 : fs.flicker)
  const hf = fs.hf || 0.6545
  const focal = (W * 0.5) / Math.tan(hf)
  const HC = fs.HC ?? HH
  const invHC = HC > 0 ? 1 / HC : 1
  for (let y = 0; y <= last; y++) {
    const e = HH - y
    const q = Math.min(1, Math.max(0, e * invHC))
    skyBase(q, skyRgb, fogRgb, cfg, BASE)
    let j = ((e / focal) / S_MAX * CLOUD_H) | 0
    if (j < 0) j = 0; else if (j >= CLOUD_H) j = CLOUD_H - 1
    let jb = (j * 2 + 37) % (2 * CLOUD_H)
    if (jb >= CLOUD_H) jb = 2 * CLOUD_H - 1 - jb
    const fade = smoothstep(0.04, 0.5, q)
    const bandV = (noise2(j * 0.31, 7.7) - 0.5) * 2 * cfg.band * fade
    const m = 1 + bandV
    let o = y * 4
    out[o] = BASE[0] * m * k / 255; out[o + 1] = BASE[1] * m * k / 255; out[o + 2] = BASE[2] * m * k / 255; out[o + 3] = cfg.amp * fade
    o = (width + y) * 4
    out[o] = j; out[o + 1] = jb; out[o + 2] = 0; out[o + 3] = 0
  }
  return last + 1
}
export { CLOUD_W, CLOUD_H }
