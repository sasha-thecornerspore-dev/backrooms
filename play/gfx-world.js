// gfx-world.js — the world pass: textured floor/ceiling (or open sky) per row, then textured walls per column.
// Writes packed ABGR pixels into buf32 (the low-res world buffer) and per-column corrected wall distance into
// zbuffer (which the sprite pass depth-tests against). No DOM: import-safe in Node.
//
// renderWorld(fs, tex, light, isWallFn, materialAt, buf32, zbuffer)
//   fs         frame state (see gfx-cpu.js): W/H/HH are the low-res buffer dims and horizon row
//   tex        TexSet from gfx-textures.js — the tile size is read from tex.ts / tex.tmask
//   light      the light model (gfx-light.js) or null. With fs.quality.lightDetail >= 1 and a light that has a recipe for the
//              level, the LIT path below shades the frame (light pools, contact shading, spatial flicker, the player's own
//              lights); otherwise (null, lightDetail 0, no recipe) the legacy shading — distance fog × flicker — runs, and its
//              output is byte-identical to what it was before the light model existed.
//              texFilter >= 1 adds mip-mapped texel sampling (a level per row / column, free); the top tier (lightDetail 2) also blends
//              magnified texels with their neighbour (a 2-tap near-field filter). Both leave the z-buffer and the geometry untouched.
//   isWallFn   (wx, wy) -> bool, closed over the player's chunk by the caller
//   materialAt (wx, wy) -> material code, or null (procedural levels: every wall is '0')
import { castRay } from './raycaster.js'
import { clamp255, hash2 } from './gfx-util.js'
import { renderSky } from './gfx-sky.js'
import { flashAtt, glowAtt, FLASH_PITCH, FLASH_SX, FLASH_SY, LM_FADE_CELLS } from './gfx-light.js'

const OFF = 1 << 24      // large positive offset so `(v+OFF)|0`-OFF == Math.floor(v)

export function renderWorld(fs, tex, light, isWallFn, materialAt, buf32, zbuffer) {
  if (light && light.prepare && fs.quality && fs.quality.lightDetail >= 1 && tex.ts >= 32 && tex.ts <= 128 && fs.fog <= 120 &&
      light.prepare(fs, tex, isWallFn, materialAt)) {
    renderLit(fs, tex, light, isWallFn, materialAt, buf32, zbuffer)
    return
  }
  if (light && light.enabled === true) light.enabled = false      // a legacy frame: consumers of the light see "off"
  renderLegacy(fs, tex, light, isWallFn, materialAt, buf32, zbuffer)
}

// ── the legacy shading (lightDetail 0): distance fog × the global flicker scalar ─────────────────────────────────────────────
// The drop-ceiling light grid — a panel every other cell on both axes — is
// inlined into the ceiling pass below (gated on `lightsOn`) for speed.
function renderLegacy(fs, tex, light, isWallFn, materialAt, buf32, zbuffer) {
  const { W, H, HH, fog, fogRgb, flicker, player, hasSky, lightsOn, fov: FOV, hf: HF } = fs
  const TS = tex.ts, TMASK = tex.tmask

  // fog colour, pre-flickered, packed once
  const fr = fogRgb[0] * flicker, fg = fogRgb[1] * flicker, fb = fogRgb[2] * flicker
  const fogPacked = (255 << 24) | (clamp255(fb) << 16) | (clamp255(fg) << 8) | clamp255(fr)

  const ca0 = Math.cos(player.angle - HF), sa0 = Math.sin(player.angle - HF)
  const ca1 = Math.cos(player.angle + HF), sa1 = Math.sin(player.angle + HF)

  // ── floor & ceiling (per row, textured, with fluorescent panels) ──
  // The fog blend is constant along a row, so it collapses to `tex*a + f` per
  // channel (precomputed here) instead of a lerp() call per pixel. Math.floor
  // is replaced with a positive-offset bit truncation. ~2x cheaper per pixel.
  const F0 = fogRgb[0], F1 = fogRgb[1], F2 = fogRgb[2]
  // Optional per-cell tile variants (TexSet v2). null ⇒ the single base tile, exactly as before. A variant is picked
  // by hashing the cell address, so every client and every frame sees the same wear on the same cell.
  const wallVar = tex.wallVar || null, floorVar = tex.floorVar || null, ceilVar = tex.ceilVar || null
  // open sky (outdoor levels): rows 0..HH are filled by gfx-sky.js and skipped below
  if (hasSky) renderSky(fs, buf32)
  for (let y = 0; y < H; y++) {
    const isFloor = y > HH
    if (!isFloor && hasSky) continue
    const rowDist = isFloor
      ? (H - HH) / Math.max(1, y - HH)
      : HH       / Math.max(1, HH - y)
    const rowOff = y * W

    if (rowDist > fog) {
      buf32.fill(fogPacked, rowOff, rowOff + W)
      continue
    }

    const df   = Math.min(1, rowDist / fog)
    const a    = (1 - df) * flicker              // texel weight
    const gR = F0 * df * flicker, gG = F1 * df * flicker, gB = F2 * df * flicker
    const dfL  = df * 0.45                        // light panels glow through fog
    const aL   = (1 - dfL) * flicker
    const gLR = F0 * dfL * flicker, gLG = F1 * dfL * flicker, gLB = F2 * dfL * flicker
    const ceiling = !isFloor
    const tbl  = isFloor ? tex.floor : tex.ceil
    const vars = isFloor ? floorVar : ceilVar
    let tblCur = tbl, lcx = 0x7fffffff, lcy = 0     // the variant chosen for the last cell (re-hashed only when the cell changes)
    const lt   = tex.light
    const stepX = rowDist * (ca1 - ca0) / W
    const stepY = rowDist * (sa1 - sa0) / W
    let fx = player.x + rowDist * ca0
    let fy = player.y + rowDist * sa0

    for (let x = 0; x < W; x++, fx += stepX, fy += stepY) {
      const cellX = ((fx + OFF) | 0) - OFF
      const cellY = ((fy + OFF) | 0) - OFF
      const tx = ((fx - cellX) * TS) & TMASK
      const ty = ((fy - cellY) * TS) & TMASK
      const ti = (ty * TS + tx) * 3

      let T = tbl
      if (vars !== null) {
        if (cellX !== lcx || cellY !== lcy) { lcx = cellX; lcy = cellY; tblCur = vars[hash2(cellX, cellY, isFloor ? 1 : 2) % vars.length] }
        T = tblCur
      }
      let r, g, b
      if (ceiling && lightsOn && (cellX & 1) === 0 && (cellY & 1) === 0) {
        r = lt[ti] * aL + gLR; g = lt[ti + 1] * aL + gLG; b = lt[ti + 2] * aL + gLB
      } else {
        r = T[ti] * a + gR;  g = T[ti + 1] * a + gG;  b = T[ti + 2] * a + gB
      }
      buf32[rowOff + x] = (255 << 24)
        | ((b > 255 ? 255 : b) | 0) << 16
        | ((g > 255 ? 255 : g) | 0) << 8
        | ((r > 255 ? 255 : r) | 0)
    }
  }

  // ── walls (per column, textured) ──
  // Anything past the fog is drawn as solid fog anyway, so there is no point
  // marching rays (and generating chunks) beyond it. This bounds the per-frame
  // isWall calls to the visible radius instead of the old 96-unit default.
  const rayMax = Math.min(96, Math.ceil(fog) + 3)
  for (let col = 0; col < W; col++) {
    const angle = player.angle - HF + (col / W) * FOV
    const hit   = castRay(player.x, player.y, angle, isWallFn, rayMax)
    const corr  = hit.dist * Math.cos(angle - player.angle)
    zbuffer[col] = corr

    const whF = H / Math.max(0.001, corr)   // unclamped slice height
    const wtF = HH - whF / 2
    const y0  = Math.max(0, Math.ceil(wtF))
    const y1  = Math.min(H, Math.floor(wtF + whF))
    if (y1 <= y0) continue

    const distF   = Math.min(1, corr / fog)
    const sideMul = hit.side === 1 ? 0.72 : 1.0
    const texX = Math.min(TMASK, (hit.wallX * TS) | 0)
    const invWh = TS / whF
    // fog blend is constant down the column → precompute texel weight + fog add
    const a  = sideMul * (1 - distF) * flicker
    const wR = fogRgb[0] * distF * flicker, wG = fogRgb[1] * distF * flicker, wB = fogRgb[2] * distF * flicker
    // per-cell material (fixed-map levels); procedural walls are always '0'
    const mat = materialAt ? materialAt(hit.mx + 0.5, hit.my + 0.5) : null
    const wkey = (mat && tex.walls[mat]) ? mat : '0'
    let wt = tex.walls[wkey]
    if (wallVar !== null) {                          // per-cell wear / decals: a variant chosen by the hit cell + face
      const arr = wallVar[wkey]
      if (arr && arr.length > 1) wt = arr[hash2(hit.mx, hit.my, hit.side) % arr.length]
    }
    const base = texX * 3

    for (let y = y0; y < y1; y++) {
      const texY = (((y - wtF) * invWh) | 0) & TMASK
      const ti = texY * TS * 3 + base
      const r = wt[ti]     * a + wR
      const g = wt[ti + 1] * a + wG
      const b = wt[ti + 2] * a + wB
      buf32[y * W + col] = (255 << 24)
        | ((b > 255 ? 255 : b) | 0) << 16
        | ((g > 255 ? 255 : g) | 0) << 8
        | ((r > 255 ? 255 : r) | 0)
    }
  }
}

// ══ the LIT path (lightDetail >= 1) ═══════════════════════════════════════════════════════════════════════════════════════════
// Same geometry as the legacy path (same rays, same z-buffer), different shading: every surface pixel is
//     texel × weight × light + fog          light = ambient colour × amb + pool colour × pool + the player's own lights,
// times a contact factor, where `pool` comes from a precomputed periodic tile (panel levels) or the lightmap (lamps, lit windows)
// for floor/ceiling, and from a per-column factor for walls; see gfx-light.js. The fog is lit too: it glows where the light is.
// Coordinates are kept in fixed point relative to the player's even-cell origin so the pool tile, the panel parity and the
// tile lookups are all integer masks and shifts — no floor(), no division, no trig per pixel.
const OFFL = 128         // even, and larger than any view radius, so relative coordinates stay positive (and panel parity survives)

// ── texel filtering (texFilter 1): mip chains, chosen per row / per column from the pixel footprint ──────────────────────────────
// A pixel that spans several texels samples a pre-averaged (half, quarter, eighth size) copy of the tile instead of one texel of the
// full-size one: that removes the shimmer of distant carpet and the dashed, stair-stepped look of far ceiling seams for free (one
// table lookup per row or column, nothing per pixel). Chains are built lazily, once per tile, and cached by tile identity.
const MIP_MAX = 3
let wallScratchTile = null, wallScratchTS = 0
function wallScratch(ts) { if (wallScratchTS !== ts) { wallScratchTile = new Uint8Array(ts * ts * 3); wallScratchTS = ts } return wallScratchTile }
const NEAR_TEXEL_WALL = 0.17                     // the same, for a wall column (texels per column)
const NEAR_TEXEL = 0.13                          // below this many texels per pixel (a texel wider than ~4 px) the near-field 2-tap filter is on
const FLOOR_MIP_BIAS = 1.8, WALL_MIP_BIAS = 1.4   // >1 picks a coarser level sooner: stability over sharpness (floors are seen at a grazing angle)
const mipCache = new WeakMap()
// Level l is the tile box-filtered over 2^l x 2^l texel blocks and stored at FULL size (each block's average replicated over the
// block), so sampling it costs exactly what sampling the base tile costs: the same texel index arithmetic, only another array.
function mipChain(tile, ts) {
  let chain = mipCache.get(tile)
  if (chain) return chain
  chain = [tile]
  for (let l = 1; l <= MIP_MAX && (ts >> l) >= 8; l++) {
    const b = 1 << l, n = b * b, dst = new Uint8Array(ts * ts * 3)
    for (let by = 0; by < ts; by += b) {
      for (let bx = 0; bx < ts; bx += b) {
        let r = 0, g = 0, bl = 0
        for (let y = 0; y < b; y++) for (let x = 0; x < b; x++) { const i = ((by + y) * ts + bx + x) * 3; r += tile[i]; g += tile[i + 1]; bl += tile[i + 2] }
        r = (r + (n >> 1)) / n | 0; g = (g + (n >> 1)) / n | 0; bl = (bl + (n >> 1)) / n | 0
        for (let y = 0; y < b; y++) for (let x = 0; x < b; x++) { const i = ((by + y) * ts + bx + x) * 3; dst[i] = r; dst[i + 1] = g; dst[i + 2] = bl }
      }
    }
    chain.push(dst)
  }
  mipCache.set(tile, chain)
  return chain
}
const varChains = new WeakMap()      // a variant array -> its array of chains
function chainsOf(arr, ts) {
  let c = varChains.get(arr)
  if (!c) { c = arr.map((t) => mipChain(t, ts)); varChains.set(arr, c) }
  return c
}
const log2 = Math.log2
// which mip level a footprint of `fp` texels per pixel wants (0 = the full-size tile)
function mipFor(fp, maxLevel, bias) {
  if (!(fp * bias > 1)) return 0
  const m = Math.floor(log2(fp * bias))
  return m < 0 ? 0 : m > maxLevel ? maxLevel : m
}

// The per-cell work of the floor/ceiling loop (variant tile, contact bits, panel / lamp / lightmap flags). It runs once per cell a row
// crosses, not per pixel, and lives in its own function so the hot pixel loop keeps only what it needs in registers. FR is the
// per-frame context, RW the per-row one, CS the result.
const FR = { sx: 0, sy: 0, TS: 64, cellBits: null, cellLamp: null, occR: 0, occCx: 0, occCy: 0, lmR: 0, lmAny: null, lev: null, levN: 0, levI0: 0, levJ0: 0,
             useLamps: false, useEmit: false, usePanels: false, lightsOn: false, lampLev: null }
const RW = { vars: null, varCh: null, m: 0, isFloor: false, ceiling: false }
const CS = { tbl: null, oX: 0, oY: 0, panel: false, pv: 1, lampC: false, lampL: 1, lmOn: false }
function enterCell(cx, cy) {
  const ctx = cx - OFFL + FR.sx, cty = cy - OFFL + FR.sy      // the true cell
  const vars = RW.vars
  if (vars !== null) { const vi = hash2(ctx, cty, RW.isFloor ? 1 : 2) % vars.length; CS.tbl = RW.varCh !== null ? RW.varCh[vi][RW.m] : vars[vi] }
  let bits = 0
  const dcx = ctx - FR.occCx, dcy = cty - FR.occCy, R = FR.occR
  CS.lampC = false
  if (dcx >= -R && dcx <= R && dcy >= -R && dcy <= R) {
    const so = ((cty & 63) << 6) | (ctx & 63)
    bits = FR.cellBits[so]
    if (FR.useLamps && RW.ceiling && FR.cellLamp[so] === 1) { CS.lampC = true; CS.lampL = FR.lampLev !== null ? FR.lampLev[so] : 1 }
  }
  const lr = FR.lmR
  CS.lmOn = FR.useEmit && dcx >= -lr && dcx <= lr && dcy >= -lr && dcy <= lr && FR.lmAny[((cty & 31) << 5) | (ctx & 31)] === 1
  CS.oX = (bits & 3) * FR.TS; CS.oY = ((bits >> 2) & 3) * FR.TS
  CS.panel = RW.ceiling && FR.lightsOn && FR.usePanels && (cx & 1) === 0 && (cy & 1) === 0
  CS.pv = 1
  if (CS.panel && FR.lev !== null) {
    const gi = (ctx >> 1) - FR.levI0, gj = (cty >> 1) - FR.levJ0
    if (gi >= 0 && gi < FR.levN && gj >= 0 && gj < FR.levN) CS.pv = FR.lev[gj * FR.levN + gi]
  }
}

// The largest channel value in a tile (or in any of a set of variants), cached: the floor/ceiling loop skips its per-channel clamp
// when texel × light + fog provably stays inside a byte.
const maxCache = new WeakMap()
function tileMax(tile) {
  let m = maxCache.get(tile)
  if (m === undefined) { m = 0; for (let i = 0; i < tile.length; i++) if (tile[i] > m) m = tile[i]; maxCache.set(tile, m) }
  return m
}
function setMax(tiles) {
  let m = maxCache.get(tiles)
  if (m === undefined) { m = 0; for (const t of tiles) m = Math.max(m, tileMax(t)); maxCache.set(tiles, m) }
  return m
}

// per-size scratch for the player's lights (rebuilt each frame they are on, allocated once per buffer size)
const dyn = { W: 0, H: 0, sx: null, sy: null, u2: null }
const GLOW_LUT = new Float32Array(256)                     // glowAtt over d² in [0, GLOW_D2)
const GLOW_D2 = 40
for (let i = 0; i < 256; i++) GLOW_LUT[i] = glowAtt((i + 0.5) * GLOW_D2 / 256)
const GLOW_K = 256 / GLOW_D2

function prepDynamic(fs, F) {
  const { W, H, HH, fov: FOV } = fs
  if (dyn.W !== W || dyn.H !== H) {
    dyn.W = W; dyn.H = H
    dyn.sx = new Float32Array(W); dyn.sy = new Float32Array(H); dyn.u2 = new Float32Array(W)
    for (let x = 0; x < W; x++) { const u = (2 * (x + 0.5) / W - 1); dyn.u2[x] = u * u }
  }
  if (F.flash) {
    for (let x = 0; x < W; x++) { const a = ((x + 0.5) / W - 0.5) * FOV; dyn.sx[x] = Math.exp(-(a * a) / (FLASH_SX * FLASH_SX)) }
    for (let y = 0; y < H; y++) { const dv = (y - HH) / H - FLASH_PITCH; dyn.sy[y] = Math.exp(-(dv * dv) / (FLASH_SY * FLASH_SY)) }
  }
}

function renderLit(fs, tex, light, isWallFn, materialAt, buf32, zbuffer) {
  const { W, H, HH, fog, fogRgb, player, hasSky, lightsOn, fov: FOV, hf: HF } = fs
  const F = light.frame
  const TS = tex.ts, TMASK = tex.tmask
  const LG = 31 - Math.clz32(TS)                       // log2(TS)
  const FB = LG > 7 ? 16 - (LG - 7) : 16               // fixed-point fraction bits (keeps the accumulators inside int32)
  const XS = TS * (1 << FB)
  const PS = LG - 5                                     // texel coordinate -> pool-tile sample (32 samples per world unit)
  const LSH = LG + FB - 6                               // fixed-point texel coordinate -> lightmap sample coordinate (4 fraction bits)
  const gdip = F.gdip

  // fog colour: the legacy fog is the light of the place, so it follows the light (a darker room fogs darker) and the bounded dip
  const fk = F.fogGain * gdip
  const F0 = fogRgb[0] * fk, F1 = fogRgb[1] * fk, F2 = fogRgb[2] * fk
  const fogPacked = (255 << 24) | (clamp255(F2) << 16) | (clamp255(F1) << 8) | clamp255(F0)

  const ca0 = Math.cos(player.angle - HF), sa0 = Math.sin(player.angle - HF)
  const ca1 = Math.cos(player.angle + HF), sa1 = Math.sin(player.angle + HF)
  const sx = 2 * Math.floor(player.x * 0.5), sy = 2 * Math.floor(player.y * 0.5)   // even shift: relative coords = true - shift
  const ppx = player.x - sx + OFFL, ppy = player.y - sy + OFFL

  const wallVar = tex.wallVar || null, floorVar = tex.floorVar || null, ceilVar = tex.ceilVar || null
  if (hasSky) renderSky(fs, buf32)

  const tR = F.tR, tG = F.tG, tB = F.tB
  const fBase = F.fogBase, fGlow = F.fogGlow
  const usePanels = F.panels, useLamps = F.lamps, useEmit = F.emitters, single = F.single
  const floorS = F.floorS, ceilS = F.ceilS
  const aoF = F.aoFloor, aoC = F.aoCeil
  const cellBits = F.cellBits, cellLamp = F.cellLamp, occR = F.occR, occCx = F.occCx, occCy = F.occCy
  const lm = F.lm, lmAny = F.lmAny, lmR = F.lmR
  const lev = F.dimmed ? F.lev : null, levN = F.levN, levI0 = F.levI0, levJ0 = F.levJ0
  const modulated = lev !== null && F.ld >= 2          // the floor/ceiling pools follow the panels' levels (walls and panels do at every tier)
  const HT = TS >> 1, LG1 = LG + 1
  const panelInv = 1 / (2 * HT * HT)                    // 0 at the centre of a panel cell, 1 at its corner
  const lampInv = 1 / (0.0169 * TS * TS)         // the lamp fixture spans 0.13 of a cell
  const lightBaseX = 4 * (sx - OFFL), lightBaseY = 4 * (sy - OFFL)
  // the lightmap fades out over its last LM_FADE_CELLS cells (same curve as lmEdgeFade in gfx-light.js, in texel units, distances from the player)
  const ppxT = ppx * TS, ppyT = ppy * TS, fadeA = (lmR - LM_FADE_CELLS) * TS, fadeInv = 1 / (LM_FADE_CELLS * TS)
  const lt = tex.light
  const filt = fs.quality.texFilter >= 1                    // mip levels: free (one table lookup per row / column)
  // The near-field 2-tap texel filter costs a few percent of a frame, so it rides on the top tier (lightDetail 2) — or on any tier that
  // asks for texFilter 2 — and the middle tier keeps to the free mips.
  const filtNear = filt && (fs.quality.texFilter >= 2 || fs.quality.lightDetail >= 2)
  const maxMip = Math.min(MIP_MAX, LG - 3)
  const ltChain = filt ? mipChain(lt, TS) : null
  const floorCh = filt && floorVar !== null ? chainsOf(floorVar, TS) : null
  const ceilCh = filt && ceilVar !== null ? chainsOf(ceilVar, TS) : null
  const stepLen0 = 2 * Math.sin(HF) / W * TS               // texels a pixel spans along a row, per unit of row distance
  const lampCol = F.lampCol, lampLev = F.lampDim ? F.lampLev : null
  // the brightest a lit surface can be made this frame, per channel (ambient + pool + the player's lights; contact only darkens)
  const dynMax = (F.flash ? F.flashK : 0) + (F.glow ? 1.3 : 0), tMax = Math.max(tR, tG, tB)
  const ambMax = Math.max(F.aR, F.aG, F.aB, F.cR, F.cG, F.cB)
  const boundFloor = ambMax + (F.floorTileMax + F.lmMax) * tMax + dynMax
  const boundCeil = ambMax + (F.ceilTileMax + 0.55 * F.lmMax) * tMax + dynMax
  const fogMax = Math.max(F0, F1, F2)

  // the player's own lights (lightDetail 2)
  const flash = F.flash, glow = F.glow
  const anyDyn = flash || glow
  if (anyDyn) prepDynamic(fs, F)
  // tell the screen-space stage what the world pass has already done: the player's lights are on the surfaces now (no gradient on
  // top), and the flicker is spatial now (the whole frame must not be blacked out by the game's scalar as well)
  if (fs.handled) { if (flash) fs.handled.flashlight = true; if (glow) fs.handled.glow = true; fs.handled.flicker = true }
  const fcR = 1.0, fcG = 0.93, fcB = 0.76                 // the flashlight's colour: warm white
  let gcR = 0, gcG = 0, gcB = 0
  if (glow) { const g = F.lights.glow, m = Math.max(g[0], g[1], g[2], 1); gcR = 0.8 * g[0] / m + 0.2; gcG = 0.8 * g[1] / m + 0.2; gcB = 0.8 * g[2] / m + 0.2 }   // a glowstick's chartreuse, not a pure primary
  const glowK = F.glowK
  const sxa = dyn.sx, sya = dyn.sy, u2a = dyn.u2
  const sinH2 = Math.sin(HF) * Math.sin(HF), cosH2 = Math.cos(HF) * Math.cos(HF)

  FR.sx = sx; FR.sy = sy; FR.TS = TS; FR.cellBits = cellBits; FR.cellLamp = cellLamp; FR.occR = occR; FR.occCx = occCx; FR.occCy = occCy
  FR.lmR = lmR; FR.lmAny = lmAny; FR.lev = lev; FR.levN = levN; FR.levI0 = levI0; FR.levJ0 = levJ0
  FR.useLamps = useLamps; FR.useEmit = useEmit; FR.usePanels = usePanels; FR.lightsOn = lightsOn; FR.lampLev = lampLev

  // ── floor & ceiling ──
  for (let y = 0; y < H; y++) {
    const isFloor = y > HH
    if (!isFloor && hasSky) continue
    const rowDist = isFloor ? (H - HH) / Math.max(1, y - HH) : HH / Math.max(1, HH - y)
    const rowOff = y * W
    if (rowDist > fog) { buf32.fill(fogPacked, rowOff, rowOff + W); continue }

    const df = Math.min(1, rowDist / fog)
    const w0 = 1 - df
    const a = w0 * gdip                                  // texel weight
    const ceiling = !isFloor
    const aR = ceiling ? F.cR : F.aR, aG = ceiling ? F.cG : F.aG, aB = ceiling ? F.cB : F.aB      // ambient colour × ambient level
    const aaR = a * aR, aaG = a * aG, aaB = a * aB       // weight × ambient colour
    const ambLevel = ceiling ? F.ceilAmbient : F.ambient
    const atR = a * tR, atG = a * tG, atB = a * tB       // weight × pool colour
    // lit fog: a share `fBase` of the fog is always there, the rest glows only over the pools of light (gRk per unit of pool)
    const gk = df * (1 - fBase) * fGlow * (ceiling ? F.ceilInv : F.floorInv)
    const gRb = F0 * df * fBase, gGb = F1 * df * fBase, gBb = F2 * df * fBase
    const gRk = F0 * gk * tR, gGk = F1 * gk * tG, gBk = F2 * gk * tB
    const dfL = df * 0.45                                // panels glow through fog
    const aL = 1 - dfL
    const gLR = F0 * dfL, gLG = F1 * dfL, gLB = F2 * dfL
    const tbl = isFloor ? tex.floor : tex.ceil
    const vars = isFloor ? floorVar : ceilVar
    // texel filtering: the mip level whose texels are about as big as this row's pixels (the geometric mean of the footprint across
    // the row and along the view direction, so distant rows average instead of shimmering, without smearing the whole picture)
    let m = 0
    if (filt) m = mipFor(Math.sqrt(rowDist * stepLen0 * TS * rowDist * rowDist / (isFloor ? H - HH : HH)), maxMip, FLOOR_MIP_BIAS)
    const varCh = isFloor ? floorCh : ceilCh
    const tbl0 = filt ? mipChain(tbl, TS)[m] : tbl
    // no clamp needed when the brightest texel (of any variant) times the brightest light stays under 255 and so does the fog
    const noClamp = (vars !== null ? setMax(vars) : tileMax(tbl)) * (isFloor ? boundFloor : boundCeil) < 254 && fogMax < 254
    const lt0 = filt ? ltChain[m] : lt
    // near rows magnify the texture (a texel is several pixels wide): blend each texel with its horizontal neighbour by the position
    // inside the texel (a 2-tap horizontal bilinear), which removes the stair-steps along seams and the chunky carpet blocks
    const bil = filtNear && m === 0 && rowDist * stepLen0 < NEAR_TEXEL
    const poolT = isFloor ? floorS : ceilS
    const modA = isFloor ? F.floorA : F.ceilA, modB = isFloor ? F.floorB : F.ceilB
    const AO = isFloor ? aoF : aoC
    const lmScale = ceiling ? 0.55 : 1
    // the player's lights on this row: the flashlight is a screen-space Gaussian (row factor × column factor), the glowstick a radial falloff
    let akR = 0, akG = 0, akB = 0, fRow = 0, agR = 0, agG = 0, agB = 0, g2c = 0, g2s = 0
    if (flash) {
      fRow = F.flashK * sya[y] * flashAtt(rowDist) * (ceiling ? 0.55 : 0.85)
      akR = w0 * fcR; akG = w0 * fcG; akB = w0 * fcB
    }
    if (glow) {
      const rd2 = rowDist * rowDist
      g2c = rd2 * cosH2 + 0.25; g2s = rd2 * sinH2
      agR = w0 * gcR * glowK; agG = w0 * gcG * glowK; agB = w0 * gcB * glowK
    }
    RW.vars = vars; RW.varCh = varCh; RW.m = m; RW.isFloor = isFloor; RW.ceiling = ceiling
    let tblCur = tbl0
    let lcx = 0x7fffffff, lcy = 0, oX = 0, oY = 0, panel = false, pv = 1, lampC = false, lmOn = false, lampL = 1
    let lni = 0x7fffffff, lnj = 0, plv = 1
    let bI = 0x7fffffff, bJ = 0, bA = 0, bB = 0, bC = 0, bD = 0                 // the cached lightmap corner coefficients
    // The light is smooth on the scale of a pixel, so it is evaluated on every other pixel of a row (every fourth for the smooth lamp
    // lightmap) and on the first pixel of every new cell, and shared with its right-hand neighbours: lr/lg/lb = light colour, fR/fG/fB = the lit fog to add.
    // (pixels per light evaluation: 4 up to 5 units away, where four pixels span less than one pool-tile sample, 2 beyond)
    const shareN = usePanels && rowDist > 5 ? 2 : 4
    let lightLeft = 0, lr = 0, lg = 0, lb = 0, fR = 0, fG = 0, fB = 0

    const dX = Math.round(rowDist * (ca1 - ca0) / W * XS), dY = Math.round(rowDist * (sa1 - sa0) / W * XS)
    let X16 = ((ppx + rowDist * ca0) * XS) | 0
    let Y16 = ((ppy + rowDist * sa0) * XS) | 0

    for (let x = 0; x < W; x++, X16 = (X16 + dX) | 0, Y16 = (Y16 + dY) | 0) {
      const X = X16 >> FB, Y = Y16 >> FB
      const cx = X >> LG, cy = Y >> LG
      if (cx !== lcx || cy !== lcy) {
        lcx = cx; lcy = cy; lightLeft = 0
        CS.tbl = tblCur
        enterCell(cx, cy)
        tblCur = CS.tbl; oX = CS.oX; oY = CS.oY; panel = CS.panel; pv = CS.pv; lampC = CS.lampC; lampL = CS.lampL; lmOn = CS.lmOn
      }
      const tx = X & TMASK, ty = Y & TMASK
      const ti = ((ty << LG) | tx) * 3
      if (panel) {
        const pdx = tx - HT, pdy = ty - HT                       // a diffuser is brightest in the middle and burns out a little there
        const em = (0.1 + 0.9 * pv) * (1.08 - 0.22 * (pdx * pdx + pdy * pdy) * panelInv)
        const r = lt0[ti]     * (aL * tR * em) + gLR
        const g = lt0[ti + 1] * (aL * tG * em) + gLG
        const b = lt0[ti + 2] * (aL * tB * em) + gLB
        buf32[rowOff + x] = 0xff000000 | ((b > 255 ? 255 : b) | 0) << 16 | ((g > 255 ? 255 : g) | 0) << 8 | ((r > 255 ? 255 : r) | 0)
        lightLeft = 0
        continue
      }
      if (lightLeft === 0) {
        lightLeft = shareN - 1
        let ps = 0
        if (usePanels) {
          const idx = (((Y >> PS) & 63) << 6) | ((X >> PS) & 63)
          if (modulated) {
            const ni = (X + HT) >> LG1, nj = (Y + HT) >> LG1
            if (ni !== lni || nj !== lnj) {
              lni = ni; lnj = nj
              const gi = ni - (OFFL >> 1) + (sx >> 1) - levI0, gj = nj - (OFFL >> 1) + (sy >> 1) - levJ0
              plv = (gi >= 0 && gi < levN && gj >= 0 && gj < levN) ? lev[gj * levN + gi] : 1
            }
            ps = modA[idx] + plv * modB[idx]
          } else ps = poolT[idx]
        } else if (lmOn) {
          // bilinear over the lightmap; the four corner samples (as coefficients of 1, fx, fy, fx*fy) are reloaded only when the pixel
          // moves into another sample cell, which along a row is every few pixels
          const SXf = (X16 >> LSH) - 8, SYf = (Y16 >> LSH) - 8
          const ii = SXf >> 4, jj = SYf >> 4
          if (ii !== bI || jj !== bJ) {
            bI = ii; bJ = jj
            const i0 = (ii + lightBaseX) & 127, j0 = (jj + lightBaseY) & 127
            const i1 = (i0 + 1) & 127, r0 = j0 << 7, r1 = ((j0 + 1) & 127) << 7
            const p00 = lm[r0 | i0], p10 = lm[r0 | i1], p01 = lm[r1 | i0], p11 = lm[r1 | i1]
            bA = p00; bB = p10 - p00; bC = p01 - p00; bD = p00 - p10 - p01 + p11
          }
          const fx = (SXf & 15) * 0.0625, fy = (SYf & 15) * 0.0625
          ps = (bA + bB * fx + fy * (bC + bD * fx)) * lmScale
          const ddx = X - ppxT, ddy = Y - ppyT
          const dcT = (ddx < 0 ? -ddx : ddx) > (ddy < 0 ? -ddy : ddy) ? (ddx < 0 ? -ddx : ddx) : (ddy < 0 ? -ddy : ddy)
          if (dcT > fadeA) { const u = (dcT - fadeA) * fadeInv; ps = u >= 1 ? 0 : ps * (1 - u * u * (3 - 2 * u)) }
        }
        const ao = AO[oX + tx] * AO[oY + ty]
        if (ps === 0) {                                    // no pool here (daylight, or beyond every lamp's reach): ambient only
          lr = aaR * ao; lg = aaG * ao; lb = aaB * ao
        } else if (single) {
          const sc = ao * (ambLevel + ps)                  // one scalar light, one tint
          ps *= ao
          lr = atR * sc; lg = atG * sc; lb = atB * sc
        } else {
          ps *= ao
          lr = aaR * ao + atR * ps; lg = aaG * ao + atG * ps; lb = aaB * ao + atB * ps
        }
        if (anyDyn) {
          if (flash) { const fl = fRow * sxa[x]; lr += akR * fl; lg += akG * fl; lb += akB * fl }
          if (glow) {
            const gi = ((g2c + g2s * u2a[x]) * GLOW_K) | 0
            if (gi < 256) { const gl = GLOW_LUT[gi]; lr += agR * gl; lg += agG * gl; lb += agB * gl }
          }
        }
        fR = gRb + gRk * ps; fG = gGb + gGk * ps; fB = gBb + gBk * ps
      } else lightLeft--
      let rr, gg, bb
      if (bil) {
        const fr = ((X16 >> (FB - 4)) & 15) - 8                  // position inside the texel, -8..7 sixteenths from its centre
        const sg = fr >> 31                                      // -1 on the left half (blend with the left neighbour), 0 on the right
        const tj = ((ty << LG) | ((tx + (sg | 1)) & TMASK)) * 3
        const w = ((fr ^ sg) - sg) * 0.0625
        const c0 = tblCur[ti], c1 = tblCur[ti + 1], c2 = tblCur[ti + 2]
        rr = (c0 + (tblCur[tj] - c0) * w) * lr + fR
        gg = (c1 + (tblCur[tj + 1] - c1) * w) * lg + fG
        bb = (c2 + (tblCur[tj + 2] - c2) * w) * lb + fB
      } else {
        rr = tblCur[ti]     * lr + fR
        gg = tblCur[ti + 1] * lg + fG
        bb = tblCur[ti + 2] * lb + fB
      }
      if (lampC) {                                         // a lamp fixture: a bright bulb inside a dark cage ring, soft-edged
        const dx = tx - HT, dy = ty - HT
        const t = (dx * dx + dy * dy) * lampInv
        if (t < 1) {
          const cov = t < 0.8 ? 1 : (1 - t) * 5
          const em = (t < 0.2 ? 1 : t < 0.32 ? 1 - (t - 0.2) * 5.67 : 0.32) * (0.1 + 0.9 * lampL)
          rr += (lampCol[0] * aL * em + gLR - rr) * cov
          gg += (lampCol[1] * aL * em + gLG - gg) * cov
          bb += (lampCol[2] * aL * em + gLB - bb) * cov
        }
      }
      if (noClamp && !lampC) buf32[rowOff + x] = 0xff000000 | (bb | 0) << 16 | (gg | 0) << 8 | (rr | 0)
      else buf32[rowOff + x] = 0xff000000 | ((bb > 255 ? 255 : bb) | 0) << 16 | ((gg > 255 ? 255 : gg) | 0) << 8 | ((rr > 255 ? 255 : rr) | 0)
    }
  }

  // ── walls ──
  const rayMax = Math.min(96, Math.ceil(fog) + 3)
  const wallLit = F.wallLit, wallAmb = F.wallAmb, wallPool = F.wallPool, wallP = F.wallP, wallK0 = F.wallK0, wallK1 = F.wallK1, wallK2 = F.wallK2
  const emitInv = F.poolRange > 0 ? 1 / F.poolRange : 0
  const px = player.x, py = player.y
  const stepCol = FOV / W * TS                            // texels a wall column spans per unit of distance
  for (let col = 0; col < W; col++) {
    const angle = player.angle - HF + (col / W) * FOV
    const hit = castRay(px, py, angle, isWallFn, rayMax)
    const corr = hit.dist * Math.cos(angle - player.angle)
    zbuffer[col] = corr

    const whF = H / Math.max(0.001, corr)
    const wtF = HH - whF / 2
    const y0 = Math.max(0, Math.ceil(wtF))
    const y1 = Math.min(H, Math.floor(wtF + whF))
    if (y1 <= y0) continue

    const distF = Math.min(1, corr / fog)
    const side = hit.side
    const sideMul = side === 1 ? 0.72 : 1.0
    const invWh = TS / whF
    const w0 = sideMul * (1 - distF)
    const a = w0 * gdip

    // the wall's share of pool light
    const along = side === 0 ? hit.my : hit.mx
    let pw = 0
    if (usePanels) {
      // panel rows stand at u = 0.5 + 2j along the wall, the panel column half a unit from the face (see gfx-light.js buildWallPool)
      const uIdx = Math.min(63, (((along & 1) + hit.wallX) * 32) | 0)
      pw = wallP[uIdx]
      if (lev !== null) {
        const posDir = side === 0 ? (hit.mx + 0.5 > px) : (hit.my + 0.5 > py)
        const face = side === 0 ? (posDir ? hit.mx : hit.mx + 1) : (posDir ? hit.my : hit.my + 1)
        const pl = face >> 1                                    // the panel column / row next to the face
        const a0 = (along >> 1) - 1                             // the three panels along the wall that can touch this sample
        let s = 0
        for (let m = 0; m < 3; m++) {
          const gi = side === 0 ? pl - levI0 : a0 + m - levI0, gj = side === 0 ? a0 + m - levJ0 : pl - levJ0
          const lv = (gi >= 0 && gi < levN && gj >= 0 && gj < levN) ? lev[gj * levN + gi] : 1
          s += lv * (m === 0 ? wallK0[uIdx] : m === 1 ? wallK1[uIdx] : wallK2[uIdx])
        }
        pw = s > 1 ? 1 : s
      }
    } else if (useEmit) {
      // the light on the floor just in front of the wall face
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
        const dcW = Math.max(Math.abs(fx - px), Math.abs(fy - py))            // the same edge fade as the floor (lmEdgeFade in gfx-light.js)
        if (dcW > lmR - LM_FADE_CELLS) { const u = (dcW - (lmR - LM_FADE_CELLS)) / LM_FADE_CELLS; v = u >= 1 ? 0 : v * (1 - u * u * (3 - 2 * u)) }
        pw = v * emitInv
        if (pw > 1) pw = 1
      }
    }
    const pq = (pw * 63 + 0.5) | 0
    const poolOff = pq * TS
    const fw = distF * (fBase + (1 - fBase) * fGlow * pw)     // lit fog over the wall
    const wR = F0 * fw * (1 - pw + pw * tR), wG = F1 * fw * (1 - pw + pw * tG), wB = F2 * fw * (1 - pw + pw * tB)

    const mat = materialAt ? materialAt(hit.mx + 0.5, hit.my + 0.5) : null
    const wkey = (mat && tex.walls[mat]) ? mat : '0'
    let wt = tex.walls[wkey]
    if (wallVar !== null) {
      const arr = wallVar[wkey]
      if (arr && arr.length > 1) wt = arr[hash2(hit.mx, hit.my, side) % arr.length]
    }
    // texel filtering: distant walls sample a pre-averaged copy of the tile (one pixel spans several texels there)
    let m = 0
    if (filt) { const f1 = TS / whF, f2 = corr * stepCol; m = mipFor(f1 > f2 ? f1 : f2, maxMip, WALL_MIP_BIAS) }
    let wtm = filt ? mipChain(wt, TS)[m] : wt
    const tcol = Math.min(TMASK, (hit.wallX * TS) | 0)
    const base = tcol * 3
    if (filtNear && m === 0 && corr * stepCol < NEAR_TEXEL_WALL) {
      // a near wall magnifies the wallpaper (a texel is several pixels wide): blend this texel column with its neighbour by the position
      // inside the texel, once per column, into a scratch tile the pixel loops read exactly like the real one
      const fr = hit.wallX * TS - tcol - 0.5
      const nb = fr < 0 ? (tcol > 0 ? tcol - 1 : tcol) : (tcol < TMASK ? tcol + 1 : tcol)
      const w = fr < 0 ? -fr : fr
      const sc = wallScratch(TS)
      for (let r = 0; r < TS; r++) {
        const i0 = (r * TS + tcol) * 3, i1 = (r * TS + nb) * 3
        sc[i0]     = wtm[i0]     + (wtm[i1]     - wtm[i0])     * w + 0.5
        sc[i0 + 1] = wtm[i0 + 1] + (wtm[i1 + 1] - wtm[i0 + 1]) * w + 0.5
        sc[i0 + 2] = wtm[i0 + 2] + (wtm[i1 + 2] - wtm[i0 + 2]) * w + 0.5
      }
      wtm = sc
    }
    const kaR = a * F.atR, kaG = a * F.atG, kaB = a * F.atB       // ambient tint (the ambient level is inside wallAmb)
    const kpR = a * tR, kpG = a * tG, kpB = a * tB

    if (!anyDyn && single) {                                      // one tint: ambient + pool are one table
      const kR = a * tR, kG = a * tG, kB = a * tB
      const lo = poolOff
      for (let y = y0; y < y1; y++) {
        const texY = (((y - wtF) * invWh) | 0) & TMASK
        const ti = texY * TS * 3 + base
        const L = wallLit[lo + texY]
        const r = wtm[ti]     * (kR * L) + wR
        const g = wtm[ti + 1] * (kG * L) + wG
        const b = wtm[ti + 2] * (kB * L) + wB
        buf32[y * W + col] = 0xff000000 | ((b > 255 ? 255 : b) | 0) << 16 | ((g > 255 ? 255 : g) | 0) << 8 | ((r > 255 ? 255 : r) | 0)
      }
    } else if (!anyDyn) {
      for (let y = y0; y < y1; y++) {
        const texY = (((y - wtF) * invWh) | 0) & TMASK
        const ti = texY * TS * 3 + base
        const wa = wallAmb[texY], wp = wallPool[poolOff + texY]
        const r = wtm[ti]     * (kaR * wa + kpR * wp) + wR
        const g = wtm[ti + 1] * (kaG * wa + kpG * wp) + wG
        const b = wtm[ti + 2] * (kaB * wa + kpB * wp) + wB
        buf32[y * W + col] = 0xff000000 | ((b > 255 ? 255 : b) | 0) << 16 | ((g > 255 ? 255 : g) | 0) << 8 | ((r > 255 ? 255 : r) | 0)
      }
    } else {
      // the player's lights on this column: flashlight = column factor × row factor, glowstick = a falloff of the distance to the wall
      const fCol = flash ? F.flashK * sxa[col] * flashAtt(corr) : 0
      const wk = sideMul * (1 - distF)
      const dkR = wk * fcR * fCol, dkG = wk * fcG * fCol, dkB = wk * fcB * fCol
      let glc = 0
      if (glow) {
        const gd = hit.dist * hit.dist + 0.25
        const gi = (gd * GLOW_K) | 0
        glc = gi < 256 ? GLOW_LUT[gi] * glowK : 0
      }
      const dgR = wk * gcR * glc, dgG = wk * gcG * glc, dgB = wk * gcB * glc
      for (let y = y0; y < y1; y++) {
        const texY = (((y - wtF) * invWh) | 0) & TMASK
        const ti = texY * TS * 3 + base
        const wa = wallAmb[texY], wp = wallPool[poolOff + texY]
        const fl = flash ? sya[y] : 0
        const r = wtm[ti]     * (kaR * wa + kpR * wp + dkR * fl + dgR) + wR
        const g = wtm[ti + 1] * (kaG * wa + kpG * wp + dkG * fl + dgG) + wG
        const b = wtm[ti + 2] * (kaB * wa + kpB * wp + dkB * fl + dgB) + wB
        buf32[y * W + col] = 0xff000000 | ((b > 255 ? 255 : b) | 0) << 16 | ((g > 255 ? 255 : g) | 0) << 8 | ((r > 255 ? 255 : r) | 0)
      }
    }
  }
}
