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
//   isWallFn   (wx, wy) -> bool, closed over the player's chunk by the caller. To let the rays use the per-frame memo (wallMemo, a speed-up;
//              the frame is the same without it) the caller DECLARES what the closure passes to the chunk cache: isWallFn.pcx / isWallFn.pcy (the
//              chunk the cache evicts relative to) and, when the level sets one, isWallFn.evictRadius (world.js chunkEvictRadius, default 3).
//              An undeclared closure, or one whose declared chunk is too far from the rendered pose, gets every ask passed straight through.
//   materialAt (wx, wy) -> material code, or null (procedural levels: every wall is '0')
//
// SPEED (a speed change must leave every output byte as it was: test/gfx-hw-perf.test.js draws against a frozen copy of the pass). The
// rays are cast first (the world asked about each cell once a frame: wallMemo), so the floor and ceiling skip what the walls will cover. The
// lit path draws a row (litRow) and a wall column (litColumn) at a time, each a function of its own; a row walks in fixed point, jumps over
// covered pixels (16 columns at a time where it can) and from cell to cell by each cell's exact run of pixels, shades the light once per
// group of pixels and reuses a packed pixel while the texel (or mip block) and the light stay the same; a near wall column is filled run by
// run. Clamps are skipped only where a bound computed with the same monotonic arithmetic proves the value stays inside a byte.
import { castRay } from './raycaster.js'
import { CHUNK_SIZE } from './world.js'
import { clamp255, hash2 } from './gfx-util.js'
import { renderSky } from './gfx-sky.js'
import { flashAtt, glowAtt, FLASH_PITCH, FLASH_SX, FLASH_SY, LM_FADE_CELLS } from './gfx-light.js'

const OFF = 1 << 24      // large positive offset so `(v+OFF)|0`-OFF == Math.floor(v)
// Tests only: { clampAlways: true } makes the lit floor / ceiling clamp every pixel (the reference a skipped clamp must equal to the byte).
export const WORLD_TEST = { clampAlways: false }

// ── the rays, cast FIRST ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// Both shadings cast one ray per column before the floor / ceiling pass and keep each column's hit here, so the floor pass can skip
// every pixel a wall will cover (in a corridor that is most of the screen) and the wall pass then shades from the stored hit. The
// floor pass calls neither isWallFn nor materialAt (and the rays ask the world about each cell once a frame, in the same order: see
// wallMemo); a skipped pixel is one the wall pass overwrites, so the frame is the same to the byte. Allocated once per buffer width.
// The floor pass tests "does a wall cover (x, y)" with ONE load per pixel: coverRow(y) hands it a threshold row `thr` and a key `k`, and
// the pixel is covered when k < thr[x]. A wall column covers rows y0 .. y1-1, and y0 <= HH <= y1 (the slice is centred on the horizon), so
// below the horizon only y < y1 matters (thr = hi, k = y) and above it only y >= y0 (thr = nlo = 1 - y0, k = -y); the horizon row itself,
// and any frame whose columns break that rule, get an exact per-row table (gen, k = 0).
// The one-sided thresholds also come as minima over blocks of 16 columns (bm, null for an exact table): k < bm[x >> 4] means the whole block
// is covered, so the lit floor pass steps over a wall's columns 16 at a time.
const COL = { W: 0, dist: null, wallX: null, corr: null, whF: null, wtF: null, side: null, mx: null, my: null, y0: null, len: null,
              hi: null, nlo: null, gen: null, hiB: null, nloB: null, oneSided: false, HH: 0, thr: null, bm: null, k: 0 }
function coverRow(y) {
  const C = COL
  if (C.oneSided && y !== C.HH) { if (y > C.HH) { C.thr = C.hi; C.bm = C.hiB; C.k = y } else { C.thr = C.nlo; C.bm = C.nloB; C.k = -y } return }
  const W = C.W, y0 = C.y0, len = C.len, gen = C.gen
  for (let x = 0; x < W; x++) gen[x] = (y - y0[x]) >>> 0 < len[x] ? 1 : 0
  C.thr = gen; C.bm = null; C.k = 0
}
// The rays of one frame ask isWallFn about the same few cells again and again (about 2% of the calls are for a cell not asked about yet this
// frame: the rays fan out from one point). wallMemo answers a cell's second and later asks from a small window keyed by the cell, reset
// every frame, and passes the first one through. isWallFn is the world's chunk cache: its only side effect is generating (and then evicting)
// chunks, which happens on the first ask for a cell of a missing chunk, and that ask still reaches it in the same order. A later ask for
// the same cell could only differ if its chunk were evicted and regenerated in between (a regenerated chunk of a procedural level gets a new
// epoch, so a different maze: that would be a change to the WORLD, not just to the picture).
// THE CONTRACT, CHECKED EVERY FRAME (memoSafe): the cache evicts only chunks more than evictRadius chunks from the chunk the closure passes it
// (pcx, pcy), and the rays only ask about cells within rayMax + 2 units of the rendered pose on each axis. So the memo is used only when the
// caller has declared that chunk (isWallFn.pcx / .pcy, integers; isWallFn.evictRadius if the level overrides the default 3) and every chunk the
// rays can reach lies within evictRadius of it; then no chunk a ray touches can be evicted during the frame, and the rays, the z-buffer and the
// frame are the same to the byte. Anything else (no declaration, a closure built for another pose: a spectator or map view, a render after an
// in-frame teleport; rays past MEMO_RAY units) passes every ask through, exactly as the straightforward loop would.
const MEMO_RAY = 40, WM_N = 1 << 14, DEFAULT_EVICT_RADIUS = 3
function memoSafe(fn, rayMax, px, py) {
  const pcx = fn.pcx, pcy = fn.pcy, er = fn.evictRadius === undefined ? DEFAULT_EVICT_RADIUS : fn.evictRadius
  if (!Number.isInteger(pcx) || !Number.isInteger(pcy) || !Number.isInteger(er) || er < 0) return false
  const r = rayMax + 2
  const x0 = Math.floor((px - r) / CHUNK_SIZE), x1 = Math.floor((px + r) / CHUNK_SIZE)
  const y0 = Math.floor((py - r) / CHUNK_SIZE), y1 = Math.floor((py + r) / CHUNK_SIZE)
  return x0 >= pcx - er && x1 <= pcx + er && y0 >= pcy - er && y1 <= pcy + er      // (NaN poses fail every comparison: no memo)
}
const WM = { gen: 0, fn: null, st: new Int32Array(WM_N), tx: new Int32Array(WM_N), ty: new Int32Array(WM_N), v: new Uint8Array(WM_N) }
function wallMemo(mx, my) {
  const s = ((my & 127) << 7) | (mx & 127)
  if (WM.st[s] === WM.gen && WM.tx[s] === mx && WM.ty[s] === my) return WM.v[s] === 1
  const w = WM.fn(mx, my)
  WM.st[s] = WM.gen; WM.tx[s] = mx; WM.ty[s] = my; WM.v[s] = w ? 1 : 0
  return w
}
// The function a frame's rays should ask from (px, py) (the memo for this frame, or isWallFn itself when memoSafe cannot prove the memo exact),
// and the call that ends the frame's asking. The GPU world pass casts its rays with the same pair.
export function rayAsk(isWallFn, rayMax, px, py) {
  if (rayMax > MEMO_RAY || !memoSafe(isWallFn, rayMax, px, py)) return isWallFn
  WM.gen = (WM.gen + 1) | 0 || 1; WM.fn = isWallFn
  return wallMemo
}
export function rayAskDone() { WM.fn = null }                // (do not keep the caller's world alive)
function castColumns(fs, isWallFn, zbuffer) {
  const { W, H, HH, fog, player, fov: FOV, hf: HF } = fs
  if (COL.W !== W) {
    COL.W = W
    COL.dist = new Float64Array(W); COL.wallX = new Float64Array(W); COL.corr = new Float64Array(W); COL.whF = new Float64Array(W); COL.wtF = new Float64Array(W)
    COL.side = new Int32Array(W); COL.mx = new Int32Array(W); COL.my = new Int32Array(W); COL.y0 = new Int32Array(W); COL.len = new Int32Array(W)
    COL.hi = new Int32Array(W); COL.nlo = new Int32Array(W); COL.gen = new Int32Array(W)
    COL.hiB = new Int32Array((W + 15) >> 4); COL.nloB = new Int32Array((W + 15) >> 4)
  }
  const { hi, nlo } = COL
  let oneSided = true
  const { dist, wallX, corr: corrA, whF: whA, wtF: wtA, side, mx, my, y0: y0A, len } = COL
  // Anything past the fog is drawn as solid fog anyway, so there is no point marching rays (and generating chunks) beyond it. This
  // bounds the per-frame isWall calls to the visible radius instead of the old 96-unit default.
  const rayMax = Math.min(96, Math.ceil(fog) + 3)
  const px = player.x, py = player.y, pa = player.angle
  const ask = rayAsk(isWallFn, rayMax, px, py)
  for (let col = 0; col < W; col++) {
    const angle = pa - HF + (col / W) * FOV
    const hit = castRay(px, py, angle, ask, rayMax)
    const corr = hit.dist * Math.cos(angle - pa)
    zbuffer[col] = corr
    const whF = H / Math.max(0.001, corr)   // unclamped slice height
    const wtF = HH - whF / 2
    const y0 = Math.max(0, Math.ceil(wtF))
    const y1 = Math.min(H, Math.floor(wtF + whF))
    dist[col] = hit.dist; wallX[col] = hit.wallX; side[col] = hit.side; mx[col] = hit.mx; my[col] = hit.my
    corrA[col] = corr; whA[col] = whF; wtA[col] = wtF
    y0A[col] = y0; len[col] = y1 > y0 ? y1 - y0 : 0      // the wall covers rows y0 .. y0+len-1: (y - y0) >>> 0 < len
    if (y1 > y0) { hi[col] = y1; nlo[col] = 1 - y0; if (y0 > HH || y1 < HH) oneSided = false }
    else { hi[col] = -1; nlo[col] = -(H + 2) }            // no wall pixels: never covered
  }
  COL.HH = HH; COL.oneSided = oneSided
  if (oneSided) {
    const hiB = COL.hiB, nloB = COL.nloB
    for (let b = 0, x = 0; x < W; b++) {
      let mh = hi[x], mn = nlo[x]
      const e = x + 16 < W ? x + 16 : W
      for (x++; x < e; x++) { if (hi[x] < mh) mh = hi[x]; if (nlo[x] < mn) mn = nlo[x] }
      hiB[b] = mh; nloB[b] = mn
    }
  }
  rayAskDone()
  return COL
}

// The largest channel value in a tile (or in any of a set of variants), cached: the floor / ceiling loops skip their per-channel clamp
// when texel × light + fog provably stays inside a byte (a product and a sum of non-negative values are monotonic in each operand
// under IEEE rounding, so the bound computed the same way bounds every pixel).
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
// the legacy pass's frame context: renderLegacy sets the frame up, then draws one row (legacyRow) and one wall column (legacyColumn) at a
// time, each a function of its own for the same reason as the lit path's (see LC)
const LGC = {
  W: 0, H: 0, HH: 0, fog: 0, flicker: 0, fogPacked: 0, ca0: 0, sa0: 0, ca1: 0, sa1: 0, px0: 0, py0: 0, TS: 0, TMASK: 0, F0: 0, F1: 0, F2: 0,
  hasSky: false, lightsOn: false, fogRgb: null, floorVar: null, ceilVar: null, wallVar: null, lt: null, tex: null, buf32: null, materialAt: null,
}

function renderLegacy(fs, tex, light, isWallFn, materialAt, buf32, zbuffer) {
  const { W, H, HH, fog, fogRgb, flicker, player, hasSky, lightsOn, hf: HF } = fs
  const TS = tex.ts, TMASK = tex.tmask

  // fog colour, pre-flickered, packed once
  const fr = fogRgb[0] * flicker, fg = fogRgb[1] * flicker, fb = fogRgb[2] * flicker
  const fogPacked = (255 << 24) | (clamp255(fb) << 16) | (clamp255(fg) << 8) | clamp255(fr)

  const ca0 = Math.cos(player.angle - HF), sa0 = Math.sin(player.angle - HF)
  const ca1 = Math.cos(player.angle + HF), sa1 = Math.sin(player.angle + HF)

  // the rays first: the sky and floor passes below skip what the walls will cover
  const C = castColumns(fs, isWallFn, zbuffer)

  // ── floor & ceiling (per row, textured, with fluorescent panels), a row at a time ──
  // The fog blend is constant along a row, so it collapses to `tex*a + f` per
  // channel (precomputed here) instead of a lerp() call per pixel. Math.floor
  // is replaced with a positive-offset bit truncation. ~2x cheaper per pixel.
  const F0 = fogRgb[0], F1 = fogRgb[1], F2 = fogRgb[2]
  // Optional per-cell tile variants (TexSet v2). null ⇒ the single base tile, exactly as before. A variant is picked
  // by hashing the cell address, so every client and every frame sees the same wear on the same cell.
  const wallVar = tex.wallVar || null, floorVar = tex.floorVar || null, ceilVar = tex.ceilVar || null
  const lt = tex.light
  // open sky (outdoor levels): rows 0..HH are filled by gfx-sky.js and skipped below
  if (hasSky) renderSky(fs, buf32, C.oneSided ? C.nlo : null)
  const L = LGC
  L.W = W; L.H = H; L.HH = HH; L.fog = fog; L.flicker = flicker; L.fogPacked = fogPacked; L.ca0 = ca0; L.sa0 = sa0; L.ca1 = ca1; L.sa1 = sa1
  L.px0 = player.x; L.py0 = player.y; L.TS = TS; L.TMASK = TMASK; L.F0 = F0; L.F1 = F1; L.F2 = F2; L.hasSky = hasSky; L.lightsOn = lightsOn
  L.fogRgb = fogRgb; L.floorVar = floorVar; L.ceilVar = ceilVar; L.wallVar = wallVar; L.lt = lt; L.tex = tex; L.buf32 = buf32; L.materialAt = materialAt
  for (let y = 0; y < H; y++) legacyRow(y)

  // ── walls (per column, textured, from the rays cast above), a column at a time ──
  for (let col = 0; col < W; col++) legacyColumn(col)
  releaseContext(LGC)
}
// drop a frame context's references once the frame is drawn (the buffer, the tiles, the world's material hook), so a renderer that is gone
// is not kept alive by the module
function releaseContext(ctx) { for (const k in ctx) { const v = ctx[k]; if (v !== null && (typeof v === 'object' || typeof v === 'function')) ctx[k] = null } }

// one row of the legacy floor / ceiling pass (renderLegacy set LGC up for this frame)
function legacyRow(y) {
  const { W, H, HH, fog, flicker, fogPacked, ca0, sa0, ca1, sa1, px0, py0, TS, TMASK, F0, F1, F2, hasSky, lightsOn, floorVar, ceilVar, lt, tex, buf32 } = LGC
  const C = COL
  const isFloor = y > HH
  if (!isFloor && hasSky) return
  const rowDist = isFloor
    ? (H - HH) / Math.max(1, y - HH)
    : HH       / Math.max(1, HH - y)
  const rowOff = y * W

  if (rowDist > fog) {
    buf32.fill(fogPacked, rowOff, rowOff + W)
    return
  }

  const df   = Math.min(1, rowDist / fog)
  const a    = (1 - df) * flicker              // texel weight
  const gR = F0 * df * flicker, gG = F1 * df * flicker, gB = F2 * df * flicker
  const dfL  = df * 0.45                        // light panels glow through fog
  const aL   = (1 - dfL) * flicker
  const gLR = F0 * dfL * flicker, gLG = F1 * dfL * flicker, gLB = F2 * dfL * flicker
  const panels = !isFloor && lightsOn          // the ceiling's even cells are light panels
  const tbl  = isFloor ? tex.floor : tex.ceil
  const vars = isFloor ? floorVar : ceilVar
  const salt = isFloor ? 1 : 2
  // no clamp needed when the brightest texel (of any variant, and of the panel) times the weight plus the fog stays under a byte
  const noClamp = flicker >= 0 && (vars !== null ? setMax(vars) : tileMax(tbl)) * a + Math.max(gR, gG, gB) < 256 &&
    (!panels || tileMax(lt) * aL + Math.max(gLR, gLG, gLB) < 256)
  const stepX = rowDist * (ca1 - ca0) / W
  const stepY = rowDist * (sa1 - sa0) / W
  let fx = px0 + rowDist * ca0
  let fy = py0 + rowDist * sa0
  // per cell: the tile (a variant, or the panel) and its weight / fog add; per texel: the packed pixel, reused while a run of pixels
  // samples the same texel of the same cell (near rows magnify the texture several pixels per texel)
  let lcx = 0x7fffffff, lcy = 0, T = tbl, k = a, oR = gR, oG = gG, oB = gB, lti = -1, px = 0
  coverRow(y)
  const thr = C.thr, ky = C.k

  for (let x = 0; x < W; x++, fx += stepX, fy += stepY) {
    if (ky < thr[x]) continue                      // a wall covers this pixel (the wall pass draws it)
    const cellX = ((fx + OFF) | 0) - OFF
    const cellY = ((fy + OFF) | 0) - OFF
    const tx = ((fx - cellX) * TS) & TMASK
    const ty = ((fy - cellY) * TS) & TMASK
    const ti = (ty * TS + tx) * 3

    if (cellX !== lcx || cellY !== lcy) {
      lcx = cellX; lcy = cellY; lti = -1
      if (panels && (cellX & 1) === 0 && (cellY & 1) === 0) { T = lt; k = aL; oR = gLR; oG = gLG; oB = gLB }
      else { T = vars !== null ? vars[hash2(cellX, cellY, salt) % vars.length] : tbl; k = a; oR = gR; oG = gG; oB = gB }
    }
    if (ti !== lti) {
      lti = ti
      const r = T[ti] * k + oR, g = T[ti + 1] * k + oG, b = T[ti + 2] * k + oB
      px = noClamp
        ? (255 << 24) | (b | 0) << 16 | (g | 0) << 8 | (r | 0)
        : (255 << 24) | ((b > 255 ? 255 : b) | 0) << 16 | ((g > 255 ? 255 : g) | 0) << 8 | ((r > 255 ? 255 : r) | 0)
    }
    buf32[rowOff + x] = px
  }

}

// one wall column of the legacy pass, from the ray castColumns stored for it (renderLegacy set LGC up for this frame)
function legacyColumn(col) {
  const { W, fog, flicker, TS, TMASK, fogRgb, wallVar, tex, buf32, materialAt } = LGC
  const C = COL, clen = C.len, cy0 = C.y0
  const n = clen[col]
  if (n === 0) return
  const y0 = cy0[col], y1 = y0 + n
  const corr = C.corr[col], whF = C.whF[col], wtF = C.wtF[col]
  const side = C.side[col], hmx = C.mx[col], hmy = C.my[col]

  const distF   = Math.min(1, corr / fog)
  const sideMul = side === 1 ? 0.72 : 1.0
  const texX = Math.min(TMASK, (C.wallX[col] * TS) | 0)
  const invWh = TS / whF
  // fog blend is constant down the column → precompute texel weight + fog add
  const a  = sideMul * (1 - distF) * flicker
  const wR = fogRgb[0] * distF * flicker, wG = fogRgb[1] * distF * flicker, wB = fogRgb[2] * distF * flicker
  // per-cell material (fixed-map levels); procedural walls are always '0'
  const mat = materialAt ? materialAt(hmx + 0.5, hmy + 0.5) : null
  const wkey = (mat && tex.walls[mat]) ? mat : '0'
  let wt = tex.walls[wkey]
  if (wallVar !== null) {                          // per-cell wear / decals: a variant chosen by the hit cell + face
    const arr = wallVar[wkey]
    if (arr && arr.length > 1) wt = arr[hash2(hmx, hmy, side) % arr.length]
  }
  const base = texX * 3
  // no clamp when the brightest texel times the weight plus the fog stays under 256 (a product and a sum are monotonic; the clamp only
  // ever touches values above 255, so it is the upper bound alone that matters)
  const tmax = tileMax(wt)
  const free = a >= 0 && tmax * a + wR < 256 && tmax * a + wG < 256 && tmax * a + wB < 256

  // a texel row spans several pixels on a near wall: the packed pixel is reused down the run, and a column whose texel rows are at least
  // RUN_PX pixels tall is filled run by run (as the lit pass's litColumn does)
  let lastY = -1, px = 0
  if (whF / TS < RUN_PX) {
    for (let y = y0, o = y0 * W + col; y < y1; y++, o += W) {
      const texY = (((y - wtF) * invWh) | 0) & TMASK
      if (texY !== lastY) {
        lastY = texY
        const ti = texY * TS * 3 + base
        const r = wt[ti]     * a + wR
        const g = wt[ti + 1] * a + wG
        const b = wt[ti + 2] * a + wB
        px = free
          ? (255 << 24) | (b | 0) << 16 | (g | 0) << 8 | (r | 0)
          : (255 << 24) | ((b > 255 ? 255 : b) | 0) << 16 | ((g > 255 ? 255 : g) | 0) << 8 | ((r > 255 ? 255 : r) | 0)
      }
      buf32[o] = px
    }
    return
  }
  const pxT = whF / TS
  let y = y0, o = y0 * W + col, v = ((y0 - wtF) * invWh) | 0
  while (y < y1) {
    let e = Math.ceil(wtF + (v + 1) * pxT), vn = 0
    if (e > y1) e = y1; else if (e <= y) e = y + 1
    while (e > y + 1 && (((e - 1 - wtF) * invWh) | 0) > v) e--
    while (e < y1 && (vn = ((e - wtF) * invWh) | 0) <= v) e++
    const texY = v & TMASK
    if (texY !== lastY) {
      lastY = texY
      const ti = texY * TS * 3 + base
      const r = wt[ti]     * a + wR
      const g = wt[ti + 1] * a + wG
      const b = wt[ti + 2] * a + wB
      px = free
        ? (255 << 24) | (b | 0) << 16 | (g | 0) << 8 | (r | 0)
        : (255 << 24) | ((b > 255 ? 255 : b) | 0) << 16 | ((g > 255 ? 255 : g) | 0) << 8 | ((r > 255 ? 255 : r) | 0)
    }
    for (; y < e; y++, o += W) buf32[o] = px
    v = vn
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
const NEAR_TEXEL_WALL = 0.17                     // the same, for a wall column (texels per column)
const RUN_PX = 3                                 // a wall column whose texel rows are at least this many pixels tall jumps from run to run
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

// A row of the lit floor pass walks the fixed-point coordinate p(x) = p0 + x*d (an integer, exactly: see renderLit), and a cell spans
// [c*CU, (c+1)*CU) of it. cellRun(p0, d, c, CU, W) gives the pixels of the row whose coordinate lies in that span, clipped to [0, W), as
// RUN.lo .. RUN.hi - 1 (lo >= hi: none). Every operand is an integer below 2^32 in magnitude and the divisor is at least 1, so the quotient's
// rounding is far smaller than its distance to the next integer and floor / ceil land exactly where stepping pixel by pixel would.
export const RUN = { lo: 0, hi: 0 }
export function cellRun(p0, d, c, CU, W) {
  let lo = 0, hi = W
  if (d > 0) {
    const a = Math.ceil((c * CU - p0) / d), b = Math.ceil(((c + 1) * CU - p0) / d)
    if (a > lo) lo = a
    if (b < hi) hi = b
  } else if (d < 0) {
    const a = Math.floor((p0 - (c + 1) * CU) / -d) + 1, b = Math.floor((p0 - c * CU) / -d) + 1
    if (a > lo) lo = a
    if (b < hi) hi = b
  }
  RUN.lo = lo; RUN.hi = hi
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

// ── the lit path's frame context ─────────────────────────────────────────────────────────────────────────────────────────────────────
// renderLit sets the frame up and then draws one row (litRow) and one wall column (litColumn) at a time, each reading the frame's values from
// LC. A row and a column are functions of their own so the engine optimises them from their many calls per frame, instead of entering a
// frame-long function's hot inner loops on the stack (which it left again at a cost on every row, and fell back to whenever a rarely taken
// path ran for the first time, for the first dozens of frames of a level and after every new situation). Same code, same order: same bytes.
const LC = {
  W: 0, H: 0, HH: 0, fog: 0, TS: 0, TMASK: 0, LG: 0, FB: 0, SH: 0, CU: 0, XS: 0, PS: 0, LSH: 0, gdip: 0, F0: 0, F1: 0, F2: 0,
  fogPacked: 0, ca0: 0, sa0: 0, ca1: 0, sa1: 0, sx: 0, sy: 0, ppx: 0, ppy: 0, tR: 0, tG: 0, tB: 0, fBase: 0, fGlow: 0, lmR: 0,
  levN: 0, levI0: 0, levJ0: 0, HT: 0, LG1: 0, panelInv: 0, lampInv: 0, subMask: 0, subInv: 0, lightBaseX: 0, lightBaseY: 0,
  ppxT: 0, ppyT: 0, fadeA: 0, fadeInv: 0, maxMip: 0, stepLen0: 0, boundFloor: 0, boundCeil: 0, fogMax: 0, fcR: 0, fcG: 0, fcB: 0,
  gcR: 0, gcG: 0, gcB: 0, glowK: 0, sinH2: 0, cosH2: 0, px: 0, py: 0, stepCol: 0, emitInv: 0, occCx: 0, occCy: 0,
  litMax: 0, ambMax: 0, poolMax: 0,
  hasSky: false, usePanels: false, useEmit: false, single: false, modulated: false, filt: false, filtNear: false, flash: false,
  glow: false, anyDyn: false,
  floorVar: null, ceilVar: null, wallVar: null, floorS: null, ceilS: null, aoF: null, aoC: null, lm: null, lev: null, lt: null,
  ltChain: null, floorCh: null, ceilCh: null, lampCol: null, sxa: null, sya: null, u2a: null, F: null, tex: null, buf32: null,
  materialAt: null, wallLit: null, wallAmb: null, wallPool: null, wallP: null, wallK0: null, wallK1: null, wallK2: null,
}

function renderLit(fs, tex, light, isWallFn, materialAt, buf32, zbuffer) {
  const { W, H, HH, fog, fogRgb, player, hasSky, lightsOn, fov: FOV, hf: HF } = fs
  const F = light.frame
  const TS = tex.ts, TMASK = tex.tmask
  const LG = 31 - Math.clz32(TS)                       // log2(TS)
  const FB = LG > 7 ? 16 - (LG - 7) : 16               // fixed-point fraction bits (keeps the accumulators inside int32)
  const SH = FB + LG, CU = 2 ** SH                      // fixed-point coordinate -> cell (a shift), and the size of a cell in those units
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
  // the rays first: the sky and floor passes below skip what the walls will cover
  const C = castColumns(fs, isWallFn, zbuffer)
  if (hasSky) renderSky(fs, buf32, C.oneSided ? C.nlo : null)

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
  const subMask = (TS << FB) - 1, subInv = 1 / (1 << FB)   // fixed-point position inside the tile -> texels, with the sub-texel fraction
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

  const L = LC
  L.W = W; L.H = H; L.HH = HH; L.fog = fog; L.TS = TS; L.TMASK = TMASK; L.LG = LG; L.FB = FB; L.SH = SH; L.CU = CU; L.XS = XS
  L.PS = PS; L.LSH = LSH; L.gdip = gdip; L.F0 = F0; L.F1 = F1; L.F2 = F2; L.fogPacked = fogPacked; L.ca0 = ca0; L.sa0 = sa0
  L.ca1 = ca1; L.sa1 = sa1; L.sx = sx; L.sy = sy; L.ppx = ppx; L.ppy = ppy; L.tR = tR; L.tG = tG; L.tB = tB; L.fBase = fBase
  L.fGlow = fGlow; L.lmR = lmR; L.levN = levN; L.levI0 = levI0; L.levJ0 = levJ0; L.HT = HT; L.LG1 = LG1; L.panelInv = panelInv
  L.lampInv = lampInv; L.subMask = subMask; L.subInv = subInv; L.lightBaseX = lightBaseX; L.lightBaseY = lightBaseY; L.ppxT = ppxT
  L.ppyT = ppyT; L.fadeA = fadeA; L.fadeInv = fadeInv; L.maxMip = maxMip; L.stepLen0 = stepLen0; L.boundFloor = boundFloor
  L.boundCeil = boundCeil; L.fogMax = fogMax; L.fcR = fcR; L.fcG = fcG; L.fcB = fcB; L.gcR = gcR; L.gcG = gcG; L.gcB = gcB
  L.glowK = glowK; L.sinH2 = sinH2; L.cosH2 = cosH2; L.hasSky = hasSky; L.usePanels = usePanels; L.useEmit = useEmit
  L.single = single; L.modulated = modulated; L.filt = filt; L.filtNear = filtNear; L.flash = flash; L.glow = glow
  L.anyDyn = anyDyn; L.floorVar = floorVar; L.ceilVar = ceilVar; L.wallVar = wallVar; L.floorS = floorS; L.ceilS = ceilS
  L.aoF = aoF; L.aoC = aoC; L.lm = lm; L.lev = lev; L.lt = lt; L.ltChain = ltChain; L.floorCh = floorCh; L.ceilCh = ceilCh
  L.lampCol = lampCol; L.sxa = sxa; L.sya = sya; L.u2a = u2a; L.F = F; L.tex = tex; L.buf32 = buf32; L.materialAt = materialAt

  // ── floor & ceiling, a row at a time ──
  for (let y = 0; y < H; y++) litRow(y)

  // ── walls (shaded from the rays cast above), a column at a time ──
  const wallLit = F.wallLit, wallAmb = F.wallAmb, wallPool = F.wallPool, wallP = F.wallP, wallK0 = F.wallK0, wallK1 = F.wallK1, wallK2 = F.wallK2
  const emitInv = F.poolRange > 0 ? 1 / F.poolRange : 0
  const px = player.x, py = player.y
  const stepCol = FOV / W * TS                            // texels a wall column spans per unit of distance
  L.px = px; L.py = py; L.stepCol = stepCol; L.emitInv = emitInv; L.occCx = occCx; L.occCy = occCy; L.wallLit = wallLit
  L.wallAmb = wallAmb; L.wallPool = wallPool; L.wallP = wallP; L.wallK0 = wallK0; L.wallK1 = wallK1; L.wallK2 = wallK2
  L.litMax = tileMax(wallLit); L.ambMax = tileMax(wallAmb); L.poolMax = tileMax(wallPool)     // (the tables' maxima, cached per table)

  for (let col = 0; col < W; col++) litColumn(col)
  releaseContext(LC)
}

// one row of the lit floor / ceiling pass (renderLit set LC up for this frame)
function litRow(y) {
  const {
    W, H, HH, fog, TS, TMASK, LG, FB, SH, CU, XS, PS, LSH, gdip, F0, F1, F2, fogPacked, ca0, sa0, ca1, sa1, sx, sy, ppx, ppy, tR,
    tG, tB, fBase, fGlow, levN, levI0, levJ0, HT, LG1, panelInv, lampInv, subMask, subInv, lightBaseX, lightBaseY, ppxT, ppyT,
    fadeA, fadeInv, maxMip, stepLen0, boundFloor, boundCeil, fogMax, fcR, fcG, fcB, gcR, gcG, gcB, glowK, sinH2, cosH2, hasSky,
    usePanels, single, modulated, filt, filtNear, flash, glow, anyDyn, floorVar, ceilVar, floorS, ceilS, aoF, aoC, lm, lev, lt,
    ltChain, floorCh, ceilCh, lampCol, sxa, sya, u2a, F, tex, buf32,
  } = LC
  const C = COL
  const isFloor = y > HH
  if (!isFloor && hasSky) return
  const rowDist = isFloor ? (H - HH) / Math.max(1, y - HH) : HH / Math.max(1, HH - y)
  const rowOff = y * W
  if (rowDist > fog) { buf32.fill(fogPacked, rowOff, rowOff + W); return }

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
  // a level-m tile holds one value per 2^m x 2^m block of texels, so the plain loop below keys its packed-pixel reuse on the block
  // (every texel of it has the very same bytes): a far row reuses a pixel across the texels of a block, not just within one texel
  const bmask = TMASK & ~((1 << m) - 1)
  // No clamp is needed when no channel of any pixel of the row can pass 255 (256 or more would spill a bit into the next channel). A pixel is
  // texel × light + lit fog, so the bound is the brightest texel (of any variant) times the brightest light PLUS the brightest lit fog of this
  // row: gXb + gXk × psM, psM the largest pool value a pixel can receive (the pool tile's or the lightmap's maximum; contact shading only
  // lowers it). The fog term is the pixel's own arithmetic (fR = gRb + gRk × ps with ps <= psM), and the sum keeps a margin of 2 below 256
  // for the few ulps a blended texel or the differently associated light bound can round by. Every loop below that reads noClamp is
  // covered, the plain area of a lamp cell (t >= 1) included; the lamp's own disc (t < 1) always clamps.
  const texB = (vars !== null ? setMax(vars) : tileMax(tbl)) * (isFloor ? boundFloor : boundCeil)
  const psM = isFloor ? F.floorTileMax + F.lmMax : F.ceilTileMax + 0.55 * F.lmMax
  const fogB = Math.max(gRb + gRk * psM, gGb + gGk * psM, gBb + gBk * psM)
  const noClamp = texB < 254 && fogMax < 254 && texB + fogB < 254 && !WORLD_TEST.clampAlways
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
  // The light is smooth on the scale of a pixel, so it is evaluated once per LIGHT GROUP and shared by the group's pixels: lr/lg/lb =
  // light colour, fR/fG/fB = the lit fog to add. The first pixel of every new cell starts a group, and a group lasts `shareN` pixels of
  // its cell (4 up to 5 units away, where four pixels span less than one pool-tile sample, 2 beyond; always 4 over the smooth lamp
  // lightmap). The light is evaluated at the group's first pixel, but only once one of its pixels turns out to be visible: a group the
  // walls cover entirely costs nothing, and every visible pixel gets exactly the light it always had.
  const shareN = usePanels && rowDist > 5 ? 2 : 4, shM = shareN - 1
  let lr = 0, lg = 0, lb = 0, fR = 0, fG = 0, fB = 0
  // the packed pixel of the last texel shaded (lti), reused while the next pixels sample the same texel of the same cell under the
  // same light (a near row magnifies the texture); never with the 2-tap filter or inside a lamp fixture, whose value moves in a texel
  let lti = -1, tpx = 0
  // the contact factor of the last evaluation if it found no pool (ambient-only light, none of the player's lights), else -1.5 (a double,
  // like the factor): the next ambient-only evaluation with the same factor yields the very same light, so the cached pixel stays good and
  // the unlit ground of Level ∅ (and every stretch beyond the lamps' reach) keeps its texel runs across light groups
  let ambAo = -1.5
  const reuseOk = !bil

  const dX = Math.round(rowDist * (ca1 - ca0) / W * XS) | 0, dY = Math.round(rowDist * (sa1 - sa0) / W * XS) | 0
  const X16r = ((ppx + rowDist * ca0) * XS) | 0
  const Y16r = ((ppy + rowDist * sa0) * XS) | 0
  coverRow(y)
  const thr = C.thr, ky = C.k, bm = C.bm

  // Pixel x of the row samples the fixed-point point (X16r + x*dX, Y16r + x*dY). Both ends of the row lie within the fog of the player,
  // fewer than OFFL + 2 + 120 units from the relative origin, so every running sum stays inside int32 (< 2^31 at the finest 2^23 units
  // per unit) and a product lands exactly where x additions would. So the walk can JUMP: to the next pixel no wall covers, and from a
  // cell's first pixel to its last by the exact run cellRun computes once per cell (no per-pixel cell test). A light group is the next
  // `shareN` pixels of its cell counted from the cell's first pixel on the row, so the group of any pixel is known without walking to
  // it: a covered pixel costs one test, a group none of whose pixels is visible costs nothing, a cell none of whose pixels is visible is
  // not entered, and the per-cell state, the caches and the light of every group a pixel is drawn in are exactly what the walk would find.
  let cs = 0, ce = 0, x = 0
  for (;;) {
    // (a wall covers the pixel: the wall pass draws it; a block of 16 columns a wall covers entirely is stepped over at once)
    while (x < W && ky < thr[x]) { x++; if ((x & 15) === 0 && bm !== null) while (x < W && ky < bm[x >> 4]) x += 16 }
    if (x >= W) break
    if (x >= ce) {
      // a new cell, and its run of pixels [cs, ce) on this row
      const cx = (X16r + x * dX) >> SH, cy = (Y16r + x * dY) >> SH
      if (cx !== lcx || cy !== lcy) {
        lcx = cx; lcy = cy; lti = -1
        CS.tbl = tblCur
        enterCell(cx, cy)
        tblCur = CS.tbl; oX = CS.oX; oY = CS.oY; panel = CS.panel; pv = CS.pv; lampC = CS.lampC; lampL = CS.lampL; lmOn = CS.lmOn
      }
      cellRun(X16r, dX, cx, CU, W); cs = RUN.lo; ce = RUN.hi
      cellRun(Y16r, dY, cy, CU, W); if (RUN.lo > cs) cs = RUN.lo; if (RUN.hi < ce) ce = RUN.hi
    }
    if (panel) {
      // a light panel: every visible pixel of the cell's run is the panel's own texel, lit by nothing but itself
      for (let X16 = X16r + x * dX, Y16 = Y16r + x * dY; x < ce; x++, X16 = (X16 + dX) | 0, Y16 = (Y16 + dY) | 0) {
        if (ky < thr[x]) continue
        const tx = (X16 >> FB) & TMASK, ty = (Y16 >> FB) & TMASK
        const ti = ((ty << LG) | tx) * 3
        if (ti !== lti) {
          lti = ti
          const pdx = tx - HT, pdy = ty - HT                     // a diffuser is brightest in the middle and burns out a little there
          const em = (0.1 + 0.9 * pv) * (1.08 - 0.22 * (pdx * pdx + pdy * pdy) * panelInv)
          const r = lt0[ti]     * (aL * tR * em) + gLR
          const g = lt0[ti + 1] * (aL * tG * em) + gLG
          const b = lt0[ti + 2] * (aL * tB * em) + gLB
          tpx = 0xff000000 | ((b > 255 ? 255 : b) | 0) << 16 | ((g > 255 ? 255 : g) | 0) << 8 | ((r > 255 ? 255 : r) | 0)
        }
        buf32[rowOff + x] = tpx
      }
      continue
    }
    // the light group of pixel x (its first visible pixel): pixels gs .. ge-1 of the cell, lit as at gs
    const gs = x - ((x - cs) & shM)
    let ge = gs + shareN
    if (ge > ce) ge = ce
    {
      const eX16 = X16r + gs * dX, eY16 = Y16r + gs * dY, ex = gs
      const eX = eX16 >> FB, eY = eY16 >> FB
      const etx = eX & TMASK, ety = eY & TMASK
      let ps = 0
      if (usePanels) {
        const idx = (((eY >> PS) & 63) << 6) | ((eX >> PS) & 63)
        if (modulated) {
          const ni = (eX + HT) >> LG1, nj = (eY + HT) >> LG1
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
        const SXf = (eX16 >> LSH) - 8, SYf = (eY16 >> LSH) - 8
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
        const ddx = eX - ppxT, ddy = eY - ppyT
        const dcT = (ddx < 0 ? -ddx : ddx) > (ddy < 0 ? -ddy : ddy) ? (ddx < 0 ? -ddx : ddx) : (ddy < 0 ? -ddy : ddy)
        if (dcT > fadeA) { const u = (dcT - fadeA) * fadeInv; ps = u >= 1 ? 0 : ps * (1 - u * u * (3 - 2 * u)) }
      }
      const ao = AO[oX + etx] * AO[oY + ety]
      if (ps === 0 && !anyDyn) {                         // no pool here (daylight, or beyond every lamp's reach): ambient only
        if (ao !== ambAo) {
          ambAo = ao; lti = -1
          lr = aaR * ao; lg = aaG * ao; lb = aaB * ao
          fR = gRb + gRk * ps; fG = gGb + gGk * ps; fB = gBb + gBk * ps
        }
      } else {
        ambAo = -1.5; lti = -1
        if (ps === 0) {
          lr = aaR * ao; lg = aaG * ao; lb = aaB * ao
        } else if (single) {
          const sc = ao * (ambLevel + ps)                // one scalar light, one tint
          ps *= ao
          lr = atR * sc; lg = atG * sc; lb = atB * sc
        } else {
          ps *= ao
          lr = aaR * ao + atR * ps; lg = aaG * ao + atG * ps; lb = aaB * ao + atB * ps
        }
        if (anyDyn) {
          if (flash) { const fl = fRow * sxa[ex]; lr += akR * fl; lg += akG * fl; lb += akB * fl }
          if (glow) {
            const gi = ((g2c + g2s * u2a[ex]) * GLOW_K) | 0
            if (gi < 256) { const gl = GLOW_LUT[gi]; lr += agR * gl; lg += agG * gl; lb += agB * gl }
          }
        }
        fR = gRb + gRk * ps; fG = gGb + gGk * ps; fB = gBb + gBk * ps
      }
    }
    // the group's visible pixels, in one of three loops: a lamp cell (the fixture's disc is measured per pixel), the near-field 2-tap
    // filter (every pixel is its own blend), or a plain texel (the packed pixel is reused while the texel stays the same)
    let X16 = X16r + x * dX, Y16 = Y16r + x * dY
    if (lampC) {
      for (; x < ge; x++, X16 = (X16 + dX) | 0, Y16 = (Y16 + dY) | 0) {
        if (ky < thr[x]) continue
        const tx = (X16 >> FB) & TMASK, ty = (Y16 >> FB) & TMASK
        const ti = ((ty << LG) | tx) * 3
        // a lamp fixture: a bright bulb inside a dark cage ring, soft-edged, on a disc of its cell (t < 1). The disc is measured from the
        // SUB-texel position (not the texel's integer corner), so a close lamp's ring is a smooth circle instead of a stair-stepped block
        // outline, at every tier (texel filtering or not: the fixture is not sampled from a tile). Outside the disc a lamp cell is plain ceiling.
        const dx = (X16 & subMask) * subInv - HT, dy = (Y16 & subMask) * subInv - HT
        const t = (dx * dx + dy * dy) * lampInv
        if (t >= 1 && ti === lti) { buf32[rowOff + x] = tpx; continue }     // the same texel under the same light: the same pixel
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
        if (t < 1) {
          const cov = t < 0.8 ? 1 : (1 - t) * 5
          const em = (t < 0.2 ? 1 : t < 0.32 ? 1 - (t - 0.2) * 5.67 : 0.32) * (0.1 + 0.9 * lampL)
          rr += (lampCol[0] * aL * em + gLR - rr) * cov
          gg += (lampCol[1] * aL * em + gLG - gg) * cov
          bb += (lampCol[2] * aL * em + gLB - bb) * cov
          lti = -1
          buf32[rowOff + x] = 0xff000000 | ((bb > 255 ? 255 : bb) | 0) << 16 | ((gg > 255 ? 255 : gg) | 0) << 8 | ((rr > 255 ? 255 : rr) | 0)
        } else {
          tpx = noClamp
            ? 0xff000000 | (bb | 0) << 16 | (gg | 0) << 8 | (rr | 0)
            : 0xff000000 | ((bb > 255 ? 255 : bb) | 0) << 16 | ((gg > 255 ? 255 : gg) | 0) << 8 | ((rr > 255 ? 255 : rr) | 0)
          lti = reuseOk ? ti : -1
          buf32[rowOff + x] = tpx
        }
      }
    } else if (bil) {
      // (a filtered row never reuses a packed pixel: lti stays -1 in its plain cells)
      for (; x < ge; x++, X16 = (X16 + dX) | 0, Y16 = (Y16 + dY) | 0) {
        if (ky < thr[x]) continue
        const tx = (X16 >> FB) & TMASK, ty = (Y16 >> FB) & TMASK
        const ti = ((ty << LG) | tx) * 3
        const fr = ((X16 >> (FB - 4)) & 15) - 8
        const sg = fr >> 31
        const tj = ((ty << LG) | ((tx + (sg | 1)) & TMASK)) * 3
        const w = ((fr ^ sg) - sg) * 0.0625
        const c0 = tblCur[ti], c1 = tblCur[ti + 1], c2 = tblCur[ti + 2]
        const rr = (c0 + (tblCur[tj] - c0) * w) * lr + fR
        const gg = (c1 + (tblCur[tj + 1] - c1) * w) * lg + fG
        const bb = (c2 + (tblCur[tj + 2] - c2) * w) * lb + fB
        tpx = noClamp
          ? 0xff000000 | (bb | 0) << 16 | (gg | 0) << 8 | (rr | 0)
          : 0xff000000 | ((bb > 255 ? 255 : bb) | 0) << 16 | ((gg > 255 ? 255 : gg) | 0) << 8 | ((rr > 255 ? 255 : rr) | 0)
        lti = -1
        buf32[rowOff + x] = tpx
      }
    } else {
      for (; x < ge; x++, X16 = (X16 + dX) | 0, Y16 = (Y16 + dY) | 0) {
        if (ky < thr[x]) continue
        const ti = ((((Y16 >> FB) & bmask) << LG) | ((X16 >> FB) & bmask)) * 3
        if (ti !== lti) {
          const rr = tblCur[ti] * lr + fR, gg = tblCur[ti + 1] * lg + fG, bb = tblCur[ti + 2] * lb + fB
          tpx = noClamp
            ? 0xff000000 | (bb | 0) << 16 | (gg | 0) << 8 | (rr | 0)
            : 0xff000000 | ((bb > 255 ? 255 : bb) | 0) << 16 | ((gg > 255 ? 255 : gg) | 0) << 8 | ((rr > 255 ? 255 : rr) | 0)
          lti = ti
        }
        buf32[rowOff + x] = tpx
      }
    }
  }

}

// one wall column of the lit pass, shaded from the ray castColumns stored for it (renderLit set LC up for this frame)
function litColumn(col) {
  const {
    W, fog, TS, TMASK, gdip, F0, F1, F2, tR, tG, tB, fBase, fGlow, lmR, levN, levI0, levJ0, maxMip, fcR, fcG, fcB, gcR, gcG, gcB,
    glowK, px, py, stepCol, emitInv, occCx, occCy, usePanels, useEmit, single, filt, filtNear, flash, glow, anyDyn, wallVar, lm,
    lev, sxa, sya, F, tex, buf32, materialAt, wallLit, wallAmb, wallPool, wallP, wallK0, wallK1, wallK2, litMax, ambMax, poolMax,
  } = LC
  const C = COL, clen = C.len, cy0 = C.y0
  const n = clen[col]
  if (n === 0) return
  const y0 = cy0[col], y1 = y0 + n
  const corr = C.corr[col], whF = C.whF[col], wtF = C.wtF[col]
  const side = C.side[col], hmx = C.mx[col], hmy = C.my[col], hWallX = C.wallX[col]

  const distF = Math.min(1, corr / fog)
  const sideMul = side === 1 ? 0.72 : 1.0
  const invWh = TS / whF
  const w0 = sideMul * (1 - distF)
  const a = w0 * gdip

  // the wall's share of pool light
  const along = side === 0 ? hmy : hmx
  let pw = 0
  if (usePanels) {
    // panel rows stand at u = 0.5 + 2j along the wall, the panel column half a unit from the face (see gfx-light.js buildWallPool)
    const uIdx = Math.min(63, (((along & 1) + hWallX) * 32) | 0)
    pw = wallP[uIdx]
    if (lev !== null) {
      const posDir = side === 0 ? (hmx + 0.5 > px) : (hmy + 0.5 > py)
      const face = side === 0 ? (posDir ? hmx : hmx + 1) : (posDir ? hmy : hmy + 1)
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
    const fx = side === 0 ? (hmx + 0.5 > px ? hmx - 0.18 : hmx + 1.18) : hmx + hWallX
    const fy = side === 1 ? (hmy + 0.5 > py ? hmy - 0.18 : hmy + 1.18) : hmy + hWallX
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

  const mat = materialAt ? materialAt(hmx + 0.5, hmy + 0.5) : null
  const wkey = (mat && tex.walls[mat]) ? mat : '0'
  let wt = tex.walls[wkey]
  if (wallVar !== null) {
    const arr = wallVar[wkey]
    if (arr && arr.length > 1) wt = arr[hash2(hmx, hmy, side) % arr.length]
  }
  // texel filtering: distant walls sample a pre-averaged copy of the tile (one pixel spans several texels there)
  let m = 0
  if (filt) { const f1 = TS / whF, f2 = corr * stepCol; m = mipFor(f1 > f2 ? f1 : f2, maxMip, WALL_MIP_BIAS) }
  let wtm = filt ? mipChain(wt, TS)[m] : wt
  const tcol = Math.min(TMASK, (hWallX * TS) | 0)
  const base = tcol * 3
  // a near wall magnifies the wallpaper (a texel is several pixels wide): each texel is blended with its neighbour in the row by the
  // position inside the texel (the near-field 2-tap filter), rounded to a byte exactly as a tile of blended texels would hold it; only
  // the texel rows the column shows are blended
  let nearW = false, nbase = base, nw = 0
  if (filtNear && m === 0 && corr * stepCol < NEAR_TEXEL_WALL) {
    const fr = hWallX * TS - tcol - 0.5
    const nb = fr < 0 ? (tcol > 0 ? tcol - 1 : tcol) : (tcol < TMASK ? tcol + 1 : tcol)
    nearW = true; nbase = nb * 3; nw = fr < 0 ? -fr : fr
  }
  const kaR = a * F.atR, kaG = a * F.atG, kaB = a * F.atB       // ambient tint (the ambient level is inside wallAmb)
  const kpR = a * tR, kpG = a * tG, kpB = a * tB
  // the player's lights on this column: flashlight = column factor × row factor, glowstick = a falloff of the distance to the wall
  let dkR = 0, dkG = 0, dkB = 0, dgR = 0, dgG = 0, dgB = 0
  if (anyDyn) {
    const fCol = flash ? F.flashK * sxa[col] * flashAtt(corr) : 0
    const wk = sideMul * (1 - distF)
    dkR = wk * fcR * fCol; dkG = wk * fcG * fCol; dkB = wk * fcB * fCol
    let glc = 0
    if (glow) {
      const hd = C.dist[col]
      const gd = hd * hd + 0.25
      const gi = (gd * GLOW_K) | 0
      glc = gi < 256 ? GLOW_LUT[gi] * glowK : 0
    }
    dgR = wk * gcR * glc; dgG = wk * gcG * glc; dgB = wk * gcB * glc
  }

  // the column's light: 4 the flashlight (a per-row factor), 0 one tint (ambient + pool in one table), 3 two tints with no pool on this
  // wall (its pool term is exactly 0), 1 two tints, 2 the glowstick (a constant down the column)
  const mode = flash ? 4 : !anyDyn ? (single ? 0 : pq === 0 ? 3 : 1) : 2
  // No clamp when the brightest texel of the column under its brightest light, plus its fog, stays under 256 in every channel: every product
  // and sum below is monotonic in each operand (all are non-negative), so the same arithmetic on the maxima bounds every pixel of the column.
  // (The 2-tap blend never exceeds the brighter of its texels; the flashlight's row factor is at most 1.)
  const tmax = tileMax(wtm)
  let lR, lG, lB
  if (mode === 0) { lR = kpR * litMax; lG = kpG * litMax; lB = kpB * litMax }
  else if (mode === 3) { lR = kaR * ambMax; lG = kaG * ambMax; lB = kaB * ambMax }
  else if (mode === 1) { lR = kaR * ambMax + kpR * poolMax; lG = kaG * ambMax + kpG * poolMax; lB = kaB * ambMax + kpB * poolMax }
  else {
    const fl = mode === 4 ? 1 : 0
    lR = kaR * ambMax + kpR * poolMax + dkR * fl + dgR; lG = kaG * ambMax + kpG * poolMax + dkG * fl + dgG; lB = kaB * ambMax + kpB * poolMax + dkB * fl + dgB
  }
  const free = tmax * lR + wR < 256 && tmax * lG + wG < 256 && tmax * lB + wB < 256

  let lastY = -1, cpx = 0
  if (mode === 4) {
    // the beam's row factor changes every pixel, but a texel row's texel and its ambient + pool light (the first two terms of the
    // sum, added in the same order as always) are kept down the run
    let c0 = 0, c1 = 0, c2 = 0, sR = 0, sG = 0, sB = 0
    for (let y = y0, o = y0 * W + col; y < y1; y++, o += W) {
      const texY = (((y - wtF) * invWh) | 0) & TMASK
      if (texY !== lastY) {
        lastY = texY
        const ti = texY * TS * 3 + base
        c0 = wtm[ti]; c1 = wtm[ti + 1]; c2 = wtm[ti + 2]
        if (nearW) { const tj = ti - base + nbase; c0 = (c0 + (wtm[tj] - c0) * nw + 0.5) | 0; c1 = (c1 + (wtm[tj + 1] - c1) * nw + 0.5) | 0; c2 = (c2 + (wtm[tj + 2] - c2) * nw + 0.5) | 0 }
        const wa = wallAmb[texY], wp = wallPool[poolOff + texY]
        sR = kaR * wa + kpR * wp; sG = kaG * wa + kpG * wp; sB = kaB * wa + kpB * wp
      }
      const fl = sya[y]
      const r = c0 * (sR + dkR * fl + dgR) + wR
      const g = c1 * (sG + dkG * fl + dgG) + wG
      const b = c2 * (sB + dkB * fl + dgB) + wB
      buf32[o] = free
        ? 0xff000000 | (b | 0) << 16 | (g | 0) << 8 | (r | 0)
        : 0xff000000 | ((b > 255 ? 255 : b) | 0) << 16 | ((g > 255 ? 255 : g) | 0) << 8 | ((r > 255 ? 255 : r) | 0)
    }
    return
  }
  // Everything else depends on the texel row alone: the packed pixel is reused down the texel row's run of pixels. A near wall (texel
  // rows at least RUN_PX pixels tall) is drawn run by run: the run of row v = ((y - wtF) * invWh) | 0 (never decreasing down the column)
  // ends where that expression first exceeds v, found from the row's height and confirmed with the same expression at e - 1 and e, and
  // the run is filled without evaluating it per pixel. A farther wall evaluates it per pixel.
  const pxT = whF / TS
  if (pxT < RUN_PX) {
    for (let y = y0, o = y0 * W + col; y < y1; y++, o += W) {
      const texY = (((y - wtF) * invWh) | 0) & TMASK
      if (texY !== lastY) {
        lastY = texY
        const ti = texY * TS * 3 + base
        let c0 = wtm[ti], c1 = wtm[ti + 1], c2 = wtm[ti + 2]
        if (nearW) { const tj = ti - base + nbase; c0 = (c0 + (wtm[tj] - c0) * nw + 0.5) | 0; c1 = (c1 + (wtm[tj + 1] - c1) * nw + 0.5) | 0; c2 = (c2 + (wtm[tj + 2] - c2) * nw + 0.5) | 0 }
        let r, g, b
        if (mode === 0) {                                         // one tint: ambient + pool are one table
          const L = wallLit[poolOff + texY]
          r = c0 * (kpR * L) + wR; g = c1 * (kpG * L) + wG; b = c2 * (kpB * L) + wB
        } else if (mode === 3) {
          const wa = wallAmb[texY]
          r = c0 * (kaR * wa) + wR; g = c1 * (kaG * wa) + wG; b = c2 * (kaB * wa) + wB
        } else if (mode === 1) {
          const wa = wallAmb[texY], wp = wallPool[poolOff + texY]
          r = c0 * (kaR * wa + kpR * wp) + wR; g = c1 * (kaG * wa + kpG * wp) + wG; b = c2 * (kaB * wa + kpB * wp) + wB
        } else {                                                  // the glowstick (a constant down the column)
          const wa = wallAmb[texY], wp = wallPool[poolOff + texY]
          const fl = 0
          r = c0 * (kaR * wa + kpR * wp + dkR * fl + dgR) + wR
          g = c1 * (kaG * wa + kpG * wp + dkG * fl + dgG) + wG
          b = c2 * (kaB * wa + kpB * wp + dkB * fl + dgB) + wB
        }
        cpx = free
          ? 0xff000000 | (b | 0) << 16 | (g | 0) << 8 | (r | 0)
          : 0xff000000 | ((b > 255 ? 255 : b) | 0) << 16 | ((g > 255 ? 255 : g) | 0) << 8 | ((r > 255 ? 255 : r) | 0)
      }
      buf32[o] = cpx
    }
    return
  }
  let y = y0, o = y0 * W + col, v = ((y0 - wtF) * invWh) | 0
  while (y < y1) {
    let e = Math.ceil(wtF + (v + 1) * pxT), vn = 0
    if (e > y1) e = y1; else if (e <= y) e = y + 1
    while (e > y + 1 && (((e - 1 - wtF) * invWh) | 0) > v) e--
    while (e < y1 && (vn = ((e - wtF) * invWh) | 0) <= v) e++
    const texY = v & TMASK
    if (texY !== lastY) {
      lastY = texY
      const ti = texY * TS * 3 + base
      let c0 = wtm[ti], c1 = wtm[ti + 1], c2 = wtm[ti + 2]
      if (nearW) { const tj = ti - base + nbase; c0 = (c0 + (wtm[tj] - c0) * nw + 0.5) | 0; c1 = (c1 + (wtm[tj + 1] - c1) * nw + 0.5) | 0; c2 = (c2 + (wtm[tj + 2] - c2) * nw + 0.5) | 0 }
      let r, g, b
      if (mode === 0) {
        const L = wallLit[poolOff + texY]
        r = c0 * (kpR * L) + wR; g = c1 * (kpG * L) + wG; b = c2 * (kpB * L) + wB
      } else if (mode === 3) {
        const wa = wallAmb[texY]
        r = c0 * (kaR * wa) + wR; g = c1 * (kaG * wa) + wG; b = c2 * (kaB * wa) + wB
      } else if (mode === 1) {
        const wa = wallAmb[texY], wp = wallPool[poolOff + texY]
        r = c0 * (kaR * wa + kpR * wp) + wR; g = c1 * (kaG * wa + kpG * wp) + wG; b = c2 * (kaB * wa + kpB * wp) + wB
      } else {
        const wa = wallAmb[texY], wp = wallPool[poolOff + texY]
        const fl = 0
        r = c0 * (kaR * wa + kpR * wp + dkR * fl + dgR) + wR
        g = c1 * (kaG * wa + kpG * wp + dkG * fl + dgG) + wG
        b = c2 * (kaB * wa + kpB * wp + dkB * fl + dgB) + wB
      }
      cpx = free
        ? 0xff000000 | (b | 0) << 16 | (g | 0) << 8 | (r | 0)
        : 0xff000000 | ((b > 255 ? 255 : b) | 0) << 16 | ((g > 255 ? 255 : g) | 0) << 8 | ((r > 255 ? 255 : r) | 0)
    }
    for (; y < e; y++, o += W) buf32[o] = cpx
    v = vn
  }

}
