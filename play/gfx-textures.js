// gfx-textures.js — procedural tile art. Everything is generated at load from seeded PRNGs (no image assets).
// buildTextures() is pure and Node-safe (no DOM): it returns a TexSet that both the CPU world pass and, later,
// the GL texture uploader consume. Only buildGrain() touches the DOM, and only when called.
//
// TexSet (v2): { ts, tmask, walls, ceil, floor, light, look, wallVar, ceilVar, floorVar }
//   walls      { '0': Uint8Array(ts*ts*3), F: …, … }   the base wall tile per material code ('0' = the wallpaper)
//   ceil/floor/light   the base ceiling tile, floor tile and the emissive ceiling-panel tile (ts*ts*3 each)
//   wallVar    null | { [materialCode]: Uint8Array[] }   optional per-cell variants (stains, outlets, vents, wear). The world
//              pass picks arr[hash2(hitCellX, hitCellY, side) % arr.length] when arr.length > 1. Include the base tile
//              in the array if it should also occur (repeat it to make it more likely).
//   ceilVar / floorVar   null | Uint8Array[]   optional variants, picked per cell: arr[hash2(cellX, cellY, 2 (ceil) | 1 (floor)) % len]
//   look       the level's config.look (per-level style data) or undefined ⇒ today's look
// `ts` is the tile edge in texels (64 today, 128 allowed); ALL tiles of one TexSet share it. The world pass reads
// tex.ts / tex.tmask — never a constant. Variant choice comes from the cell address, never from a PRNG stream.
//
// buildTextures(palette, materials = null, look = null, levelKey = 'legacy')
//   levelKey  '0'..'3' | '∅' for the real levels, 'legacy' for hand-built configs (gfx-util.js levelKey()).
//   levelKey === 'legacy' with no `look` reproduces the original single-tile art BYTE FOR BYTE (pinned by test/gfx-textures.test.js).
//   A real level gets its own surfaces from LEVEL_SURFACES below (walls, floor, ceiling, light panel, and for ∅ the material
//   tiles + ground), each with per-cell variants. `look.wall|floor|ceil` (names in the *_STYLES tables) override the choice.
//
// How the art is built (so it is edited safely):
//   * Every tile is 64x64 texels: nearest-neighbour texels at distance alias badly, so a bigger tile would look worse.
//   * A surface = one *substrate* (Float32 RGB: the shared pattern, dirt, film noise) + per-variant *decorations* painted over a
//     copy of it. After painting, the outer EDGE texels of every variant are restored from the substrate, so a variant's
//     left/right edge (walls) or all four edges (floors, ceilings) are byte-identical to the base tile's and neighbouring cells
//     can pick any variants without a visible seam. Decorations are still designed to fade out by ~6px so the restore never cuts.
//   * The substrate itself is periodic (x for walls; x and y for floors / ceilings): the pattern phase matches across cells.
//   * All colour is derived from the palette / materials hexes by multiplication, so a wish-drifted palette still works.
//     Only small semantic accents (rust, warning yellow, indicator lights, weed green) are absolute, and each is tempered
//     with the palette colour.
//   * Seeded per tile (mulberry32 + hash-free fixed seeds): identical for every player, no Math.random anywhere.
import { hexToRgb, clamp255, mulberry32 } from './gfx-util.js'


const TS = 64            // texture tile size (px per world cell)
const TMASK = TS - 1

// A single wall material tile (TS*TS RGB). `kind` is the material code from the
// authored map (see level-null-map.js): F formstone, C CMU-sealed, P plywood,
// B brick, W black window, O occupied (lit), M marble. Used only by fixed-map
// levels (Level ∅); procedural levels use material '0' = the wallpaper below.
export function buildWallTile(base, kind, rnd) {
  const [br, bg, bb] = base
  const out = new Uint8Array(TS * TS * 3)
  for (let y = 0; y < TS; y++) {
    for (let x = 0; x < TS; x++) {
      const i = (y * TS + x) * 3
      const n = (rnd() - 0.5) * 10
      let r = br, g = bg, b = bb, m = 1
      switch (kind) {
        case 'F': {                                   // formstone: irregular fake-stone blocks + mortar
          const bx = (x / 13) | 0, by = (y / 11) | 0
          m = 0.86 + ((bx * 7 + by * 13) % 5) * 0.055
          if (x % 13 === 0 || y % 11 === 0) m *= 0.68  // mortar lines (same material — that's the lie)
          break
        }
        case 'C':                                     // CMU: cold flat grey, cinderblock courses
          m = 0.96
          if (y % 8 === 0) m *= 0.8                     // course line
          if (x % (TS >> 1) === 0) m *= 0.85           // stacked vertical joint
          break
        case 'P':                                     // plywood + a sprayed house number
          m = 0.9 + Math.sin(y * 0.55) * 0.045          // horizontal grain
          if (x >= TS * 0.32 && x <= TS * 0.68 && y >= TS * 0.26 && y <= TS * 0.5 &&
              (Math.floor((x - TS * 0.32) / 6) + Math.floor((y - TS * 0.26) / 8)) % 2 === 0) {
            r = 250; g = 150; b = 40; m = 1             // the number, hand-sprayed
          }
          break
        case 'B': {                                   // brick: offset courses + mortar
          const row = (y / 8) | 0, off = (row % 2) * 8
          m = 0.92
          if (y % 8 === 0) m *= 0.7
          if ((x + off) % 16 === 0) m *= 0.7
          break
        }
        case 'W':                                     // open upper window: a black hole in the brick
          r = 13; g = 13; b = 17; m = 1
          if (x < 3 || y < 3 || x > TS - 4 || y > TS - 4) { r = 66; g = 60; b = 50 } // frame remnant
          break
        case 'O':                                     // occupied: a warm lit window — nobody comes out
          m = 0.9
          if (x >= TS * 0.55 && x <= TS * 0.86 && y >= TS * 0.28 && y <= TS * 0.62) { r = 255; g = 216; b = 138; m = 1 }
          else if (x < 3 || y < 3) m *= 0.8
          break
        case 'M':                                     // marble stoop: pale, veined, cracked
          r = 212; g = 210; b = 202; m = 1
          if (Math.abs(Math.sin(x * 0.31 + y * 0.12)) > 0.9) { r *= 0.84; g *= 0.84; b *= 0.84 }
          break
        default:
          m = 0.94
      }
      out[i]     = clamp255(r * m + n)
      out[i + 1] = clamp255(g * m + n)
      out[i + 2] = clamp255(b * m + n)
    }
  }
  return out
}

// Build the three procedural tiles (wall / ceiling / floor) + the light panel,
// each as a flat Uint8 RGB array of length TS*TS*3. `materials` (optional) adds
// one extra wall tile per authored-map material code, keyed by that code.
function buildLegacyTextures(palette, materials = null, look = null) {
  const wallRgb  = hexToRgb(palette.wall)
  const ceilRgb  = hexToRgb(palette.ceiling)
  const floorRgb = hexToRgb(palette.floor)
  const rnd = mulberry32(0x0BACC000)

  const wall  = new Uint8Array(TS * TS * 3)
  const ceil  = new Uint8Array(TS * TS * 3)
  const floor = new Uint8Array(TS * TS * 3)
  const light = new Uint8Array(TS * TS * 3)
  const LIGHT = [250, 247, 224]

  // per-column damp streak profile for the wallpaper
  const streak = new Float32Array(TS)
  for (let x = 0; x < TS; x++) streak[x] = 0.94 + 0.10 * rnd()
  // a few darker vertical stains
  for (let s = 0; s < 5; s++) {
    const cx = (rnd() * TS) | 0
    for (let x = cx - 1; x <= cx + 1; x++) if (x >= 0 && x < TS) streak[x] *= 0.9
  }

  for (let y = 0; y < TS; y++) {
    for (let x = 0; x < TS; x++) {
      const i = (y * TS + x) * 3
      const n = (rnd() - 0.5) * 10   // fine film noise

      // ── wall: wallpaper + baseboard ──
      if (y >= TS - 9) {
        // dark skirting board with a highlight lip at the top edge
        const lip = y === TS - 9 ? 1.7 : 1.0
        wall[i]     = clamp255(wallRgb[0] * 0.34 * lip + n)
        wall[i + 1] = clamp255(wallRgb[1] * 0.34 * lip + n)
        wall[i + 2] = clamp255(wallRgb[2] * 0.32 * lip + n)
      } else {
        let m = streak[x]
        if (y % 16 === 0) m *= 0.93          // faint horizontal pattern band
        if ((x + y) % 23 === 0) m *= 1.03    // subtle weave highlight
        wall[i]     = clamp255(wallRgb[0] * m + n)
        wall[i + 1] = clamp255(wallRgb[1] * m + n)
        wall[i + 2] = clamp255(wallRgb[2] * m + n * 0.6)
      }

      // ── ceiling tile: grid seams + noise ──
      const seam = (x < 2 || y < 2 || x > TS - 3 || y > TS - 3) ? 0.7 : 1.0
      ceil[i]     = clamp255(ceilRgb[0] * seam + n * 0.6)
      ceil[i + 1] = clamp255(ceilRgb[1] * seam + n * 0.6)
      ceil[i + 2] = clamp255(ceilRgb[2] * seam + n * 0.6)

      // ── light panel: bright emissive centre, darker aluminium frame ──
      const frame = (x < 4 || y < 4 || x > TS - 5 || y > TS - 5)
      const lb = frame ? 0.78 : 1.0
      light[i]     = clamp255(LIGHT[0] * lb + n * 0.4)
      light[i + 1] = clamp255(LIGHT[1] * lb + n * 0.4)
      light[i + 2] = clamp255(LIGHT[2] * lb + n * 0.4)

      // ── floor: damp mottled carpet ──
      const mot = 0.82 + 0.30 * rnd()
      const seamF = (x < 1 || y < 1) ? 0.8 : 1.0
      floor[i]     = clamp255(floorRgb[0] * mot * seamF + n * 0.5)
      floor[i + 1] = clamp255(floorRgb[1] * mot * seamF + n * 0.5)
      floor[i + 2] = clamp255(floorRgb[2] * mot * seamF + n * 0.4)
    }
  }
  // Default wall = material '0' (the wallpaper the loop above produced, byte for
  // byte). Extra materials get their own tiles from a fresh PRNG, so building
  // them cannot perturb the default's texture. Procedural levels never sample them.
  const walls = { '0': wall }
  if (materials) {
    for (const ch of Object.keys(materials)) {
      const base = hexToRgb(materials[ch] || palette.wall)
      walls[ch] = buildWallTile(base, ch, mulberry32(0x5EED0000 ^ ch.charCodeAt(0)))
    }
  }
  // ts/tmask travel with the tiles so the sampler never assumes 64. `look` (per-level style data) is reserved:
  // absent => today's look. The *Var fields are null today (single base tile everywhere).
  return { ts: TS, tmask: TMASK, walls, ceil, floor, light, look, wallVar: null, ceilVar: null, floorVar: null }
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════════
//  Toolkit — periodic noise, shapes, tile painting. Build-time only (never in the per-pixel render loop).
// ═════════════════════════════════════════════════════════════════════════════════════════════════════
const EDGE = 3           // outer texels of every variant that are restored from the substrate (seam guarantee)
const NT = TS * TS

const c01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v)
const sstep = (a, b, v) => { const t = c01((v - a) / (b - a)); return t * t * (3 - 2 * t) }
const lerpf = (a, b, t) => a + (b - a) * t
const hyp = (a, b) => Math.sqrt(a * a + b * b)          // (Math.hypot is slow and not correctly rounded; sqrt is both fast and exact)
const to8 = (v) => (v <= 0 ? 0 : v >= 255 ? 255 : (v + 0.5) | 0)
const at = (x, y) => (y * TS + x) * 3
const mul3 = (c, m) => [c[0] * m[0], c[1] * m[1], c[2] * m[2]]
const scale3 = (c, k) => [c[0] * k, c[1] * k, c[2] * k]
const mix3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
const lum = (c) => c[0] * 0.299 + c[1] * 0.587 + c[2] * 0.114
// pull a colour toward its own grey (semantic accents stay tempered by the palette, never garish)
const desat = (c, k) => { const l = lum(c); return [lerpf(c[0], l, k), lerpf(c[1], l, k), lerpf(c[2], l, k)] }
// an absolute accent (rust, warning yellow, LED green) blended with the palette colour so a drifted palette still tints it
const accent = (abs, pal, k = 0.25) => mix3(abs, scale3(pal, lum(abs) / Math.max(1, lum(pal))), k)

// Periodic value noise on a cx*cy lattice (cx, cy divide TS): 0..1, tiles seamlessly in both axes. Cached: fields are
// pure functions of (seed, cx, cy), so sharing them between builds cannot change any output.
const NOISE = new Map()
function vnoise(seed, cx, cy = cx) {
  const key = seed + ':' + cx + ':' + cy
  let f = NOISE.get(key)
  if (f) return f
  const gx = TS / cx, gy = TS / cy
  const lat = new Float32Array(gx * gy)
  const r = mulberry32((seed ^ Math.imul(cx, 0x9E3779B1) ^ Math.imul(cy, 0x85EBCA77)) >>> 0)
  for (let i = 0; i < lat.length; i++) lat[i] = r()
  f = new Float32Array(NT)
  const X0 = new Uint8Array(TS), X1 = new Uint8Array(TS), SX = new Float32Array(TS)
  for (let x = 0; x < TS; x++) {
    const fx = x / cx, ix = Math.floor(fx), tx = fx - ix
    X0[x] = ix % gx; X1[x] = (ix + 1) % gx; SX[x] = tx * tx * (3 - 2 * tx)
  }
  for (let y = 0; y < TS; y++) {
    const fy = y / cy, iy = Math.floor(fy), ty = fy - iy, sy = ty * ty * (3 - 2 * ty)
    const r0 = (iy % gy) * gx, r1 = ((iy + 1) % gy) * gx, o = y * TS
    for (let x = 0; x < TS; x++) {
      const x0 = X0[x], x1 = X1[x], sx = SX[x]
      const a = lat[r0 + x0] + (lat[r0 + x1] - lat[r0 + x0]) * sx
      const b = lat[r1 + x0] + (lat[r1 + x1] - lat[r1 + x0]) * sx
      f[o + x] = a + (b - a) * sy
    }
  }
  NOISE.set(key, f)
  return f
}
// Zero-mean fractal noise, roughly in [-1, 1]. octs = [[cx, cy, amp], ...]
function fbm(seed, octs) {
  const key = 'f' + seed + JSON.stringify(octs)
  let f = NOISE.get(key)
  if (f) return f
  f = new Float32Array(NT)
  let tot = 0
  for (let o = 0; o < octs.length; o++) {
    const [cx, cy, a] = octs[o]
    const n = vnoise(seed + o * 977, cx, cy)
    for (let j = 0; j < NT; j++) f[j] += (n[j] - 0.5) * 2 * a
    tot += a
  }
  const k = 1.7 / tot
  for (let j = 0; j < NT; j++) f[j] *= k
  NOISE.set(key, f)
  return f
}
// 1-D periodic noise along x (0..1), for per-column streak profiles
function noise1(seed, cx) { const f = vnoise(seed, cx, TS), o = new Float32Array(TS); for (let x = 0; x < TS; x++) o[x] = f[x]; return o }

// soft-edged ellipse: 1 inside, feathering to 0 by (1 + soft) of the radius
const ellip = (dx, dy, rx, ry, soft = 0.35) => 1 - sstep(1, 1 + soft, Math.sqrt((dx * dx) / (rx * rx) + (dy * dy) / (ry * ry)))
// 0..1 fade for a coordinate measured from the nearest tile edge: 0 within m0 px of the edge, 1 beyond m1
const edgeFade = (v, m0 = 4, m1 = 10) => sstep(m0, m1, Math.min(v, TS - 1 - v))

// ── painting on a Float32 RGB tile ──
function mulPx(T, x, y, mr, mg = mr, mb = mr) {
  if (x < 0 || y < 0 || x >= TS || y >= TS) return
  const i = at(x, y); T[i] *= mr; T[i + 1] *= mg; T[i + 2] *= mb
}
function mixPx(T, x, y, c, a) {
  if (x < 0 || y < 0 || x >= TS || y >= TS || a <= 0) return
  const i = at(x, y); T[i] += (c[0] - T[i]) * a; T[i + 1] += (c[1] - T[i + 1]) * a; T[i + 2] += (c[2] - T[i + 2]) * a
}
function setPx(T, x, y, c, k = 1) {
  if (x < 0 || y < 0 || x >= TS || y >= TS) return
  const i = at(x, y); T[i] = c[0] * k; T[i + 1] = c[1] * k; T[i + 2] = c[2] * k
}
// multiplicative stain: tintv is the colour multiplier at full strength k=1
function stainPx(T, x, y, k, tintv) {
  if (x < 0 || y < 0 || x >= TS || y >= TS || k <= 0) return
  const i = at(x, y)
  T[i] *= 1 - (1 - tintv[0]) * k; T[i + 1] *= 1 - (1 - tintv[1]) * k; T[i + 2] *= 1 - (1 - tintv[2]) * k
}
function fillRect(T, x0, y0, x1, y1, c, k = 1, a = 1) {   // inclusive, solid colour c*k blended at alpha a
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    if (a >= 1) setPx(T, x, y, c, k); else mixPx(T, x, y, scale3(c, k), a)
  }
}
function mulRect(T, x0, y0, x1, y1, m) { for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) mulPx(T, x, y, m) }
// walk a line, calling cb(x, y, t) at every texel (t = 0..1 along it)
function walkLine(x0, y0, x1, y1, cb) {
  const n = Math.max(1, Math.round(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0))))
  for (let s = 0; s <= n; s++) { const t = s / n; cb(Math.round(x0 + (x1 - x0) * t), Math.round(y0 + (y1 - y0) * t), t) }
}
// a jittery line (crack, scratch, streak): a random walk from (x, y) heading `ang`, calling cb(x, y, t)
function walkCrack(rnd, x, y, ang, len, wobble, cb) {
  let a = ang
  for (let s = 0; s < len; s++) {
    cb(Math.round(x), Math.round(y), s / len)
    a += (rnd() - 0.5) * wobble
    x += Math.cos(a); y += Math.sin(a)
  }
}
// Shared build buffers: one for the substrate being painted, one for the variant under construction. A variant is finished (copied out
// as a Uint8Array) before the next one starts, so nothing else holds them and the build makes no per-variant Float32 garbage.
const SCRATCH_S = new Float32Array(NT * 3), SCRATCH_V = new Float32Array(NT * 3)
function newSub() { SCRATCH_S.fill(0); return SCRATCH_S }
// A worn strip of floor paint (walkway edge, safety line): a run of paint along the tile that breaks up into a few long pieces with ragged,
// chipped ends. orient 'h' runs along x, 'v' along y; c0 = the strip's centre row/column; thick = full thickness in texels.
function wornStripe(T, orient, c0, thick, colour, seed, alpha = 0.8) {
  const wob = noise1(seed, 8), fine = vnoise(seed + 1, 2, 2), ph = (seed & 255) / 255 * 6.2832
  for (let a = 4; a < TS - 4; a++) {
    const seg = sstep(0.34, 0.46, 0.5 + 0.5 * Math.sin(6.2832 * a / TS + ph) + 0.5 * (wob[a] - 0.5)) * edgeFade(a, 4, 9)
    if (seg <= 0) continue
    for (let d = -Math.ceil(thick / 2) - 1; d <= Math.ceil(thick / 2) + 1; d++) {
      const b = Math.round(c0 + d), x = orient === 'h' ? a : b, y = orient === 'h' ? b : a
      if (x < 0 || y < 0 || x >= TS || y >= TS) continue
      const chip = fine[y * TS + x]
      const across = 1 - sstep(thick / 2 - 0.4, thick / 2 + 0.6, Math.abs(d))
      const k = seg * across * (0.55 + 0.6 * chip > 0.72 ? 1 : 0.35)
      if (k > 0) mixPx(T, x, y, scale3(colour, 0.78 + 0.3 * chip), alpha * k)
    }
  }
}
// the substrate -> a finished variant tile: copy, paint, restore the outer margin so every variant seams with the base
function makeVariant(S, mx, my, paint) {
  const T = SCRATCH_V
  T.set(S)
  paint(T)
  restoreEdges(T, S, mx, my)
  return finish(T)
}
function restoreEdges(T, S, mx, my) {
  const row = TS * 3
  for (let y = 0; y < TS; y++) {
    const a = y * row
    if (y < my || y >= TS - my) { T.set(S.subarray(a, a + row), a); continue }
    if (mx > 0) { T.set(S.subarray(a, a + mx * 3), a); const q = a + (TS - mx) * 3; T.set(S.subarray(q, a + row), q) }
  }
}
// Float32 -> Uint8: round to nearest, clamp to 0..255 (plain arithmetic, so every engine produces the same bytes)
function finish(T) {
  const o = new Uint8Array(T.length)
  for (let i = 0; i < o.length; i++) { const v = T[i] + 0.5; o[i] = v < 0 ? 0 : v > 255 ? 255 : v }
  return o
}
// repeat entries to weight the per-cell pick: [[tile, weight], ...] -> a flat array the world pass indexes with hash % length
function weighted(list) { const out = []; for (const [t, w] of list) for (let k = 0; k < w; k++) out.push(t); return out }

// ═════════════════════════════════════════════════════════════════════════════════════════════════════
//  Level 0 — the lobby: mono-yellow damask wallpaper, matted carpet, acoustic ceiling tile, fluorescent panel
// ═════════════════════════════════════════════════════════════════════════════════════════════════════
const STAIN_PAPER = [0.80, 0.67, 0.42]     // water on yellow paper: browner, darker, less blue
const STAIN_TILE  = [0.90, 0.80, 0.60]     // water on acoustic tile

// one 16x32 repeat (half-drop between neighbouring columns): a lozenge with a darker core, and a dot where the lozenges meet
const MOTIF = (() => {
  const m = new Float32Array(16 * 32)
  for (let yy = 0; yy < 32; yy++) for (let u = 0; u < 16; u++) {
    const dx = u - 7.5, dy = yy - 15.5
    const d = Math.abs(dx) / 4.6 + Math.abs(dy) / 8.6                    // diamond distance
    let v = 1 - sstep(0.86, 1.02, d)                                      // the lozenge
    v -= 0.55 * (1 - sstep(0.28, 0.42, d))                                // a darker heart
    v += 0.5 * (1 - sstep(0.62, 0.74, d)) * sstep(0.5, 0.6, d)          // a thin lit ring inside the edge
    const dd = hyp(dx, Math.abs(dy) - 15.5)                       // a dot between vertically neighbouring lozenges
    v = Math.max(v, 1 - sstep(1.0, 1.9, dd))
    m[yy * 16 + u] = Math.max(-0.4, v)
  }
  return m
})()

// A stain that hangs from the ceiling: an irregular lower boundary with fingers, darker toward the top, and a dark tide line.
function wallStain(T, o) {
  const jag = fbm(o.seed, [[8, 8, 1], [4, 4, 0.6], [2, 2, 0.4]])
  const fin = fbm(o.seed + 5, [[16, 64, 1]])
  for (let y = 0; y < 54; y++) for (let x = 5; x < 59; x++) {
    const dxn = (x - o.cx) / o.halfW
    if (Math.abs(dxn) > 1.25) continue
    const side = 1 - sstep(0.62, 1.12, Math.abs(dxn))
    const bound = o.depth * (0.32 + 0.68 * (1 - dxn * dxn * 0.7)) + 7 * fin[x]
    const sd = y - bound
    if (sd > 1.5) continue
    const j = y * TS + x
    let k = 0
    if (sd < 0) k = o.strength * (0.34 + 0.42 * (1 - y / Math.max(4, bound))) * (0.85 + 0.28 * jag[j])
    const tide = Math.exp(-((sd + 0.7) * (sd + 0.7)) / 1.5)
    k = Math.max(k, o.strength * 0.9 * tide)
    stainPx(T, x, y, k * side, o.tint)
  }
}
// rising damp: the wall wet from the floor up, a wandering tide line and darker below it
function risingDamp(T, o) {
  const jag = fbm(o.seed, [[8, 8, 1], [4, 4, 0.7], [2, 4, 0.4]])
  for (let y = 20; y < 55; y++) for (let x = 5; x < 59; x++) {
    const j = y * TS + x
    const side = edgeFade(x, 4, 12)
    const bound = o.top + 5 * jag[j]
    const sd = y - bound
    if (sd < -1.5) continue
    let k = sd > 0 ? o.strength * (0.30 + 0.55 * c01(sd / (54 - bound))) * (0.85 + 0.3 * jag[(y * TS + ((x + 21) & 63))]) : 0
    k = Math.max(k, o.strength * 0.7 * Math.exp(-((sd - 0.5) * (sd - 0.5)) / 1.6))
    stainPx(T, x, y, k * side, o.tint)
  }
}

function lobbyWall(pal) {
  const w = hexToRgb(pal.wall)
  const S = newSub()
  const rnd = mulberry32(0xA1000001)
  const mott = fbm(0xA1101, [[16, 16, 1], [8, 8, 0.5], [4, 4, 0.25]])
  const grn = fbm(0xA1102, [[8, 4, 1], [4, 2, 0.6]])
  const baseN = fbm(0xA1103, [[4, 2, 1], [2, 1, 0.8]])
  const str1 = noise1(0xA1104, 4), str2 = noise1(0xA1105, 16)
  const plaster = mul3(w, [0.72, 0.68, 0.60])
  for (let y = 0; y < TS; y++) for (let x = 0; x < TS; x++) {
    const j = y * TS + x, i = j * 3
    const n = (rnd() - 0.5) * 7
    if (y >= 55) {                                   // scuffed baseboard: dark, with a lit lip and a groove
      const by = y - 55
      let m = 0.36
      if (by === 0) m = 0.68; else if (by === 1) m = 0.44; else if (by === 4) m = 0.29; else if (by === 8) m = 0.21
      m *= 1 + 0.12 * baseN[j]
      S[i] = w[0] * m * 1.08 + n; S[i + 1] = w[1] * m * 0.98 + n; S[i + 2] = w[2] * m * 0.78 + n * 0.6
      continue
    }
    const col = x >> 4, u = x & 15, yy = (y + ((col & 1) ? 16 : 0)) & 31
    let m = 1.03 + 0.095 * MOTIF[yy * 16 + u]
    if (u === 0) m *= 0.925; else if (u === 1) m *= 1.03
    m *= 1 + 0.045 * (str1[x] - 0.5) * 2 + 0.03 * (str2[x] - 0.5) * 2
    m *= 1 + 0.03 * mott[j]
    const grime = sstep(28, 54, y) * (0.09 + 0.05 * grn[j])
    m *= 1 - grime
    if (y < 3) m *= 0.83 + y * 0.06
    if (y === 54) m *= 0.84
    S[i] = w[0] * m + n; S[i + 1] = w[1] * m + n; S[i + 2] = w[2] * m * (1 - grime * 0.55) + n * 0.6
  }
  // damp running down from the ceiling: a few long, faint, darker streaks
  for (let k = 0; k < 5; k++) {
    const x0 = 6 + Math.floor(rnd() * 52), len = 16 + rnd() * 30, wd = 1 + Math.floor(rnd() * 2), kk = 0.04 + rnd() * 0.05
    for (let y = 0; y < len; y++) {
      const f = Math.pow(1 - y / len, 1.3)
      for (let dx = -wd; dx <= wd; dx++) { const s = 1 - kk * f * (1 - Math.abs(dx) / (wd + 1)); mulPx(S, (x0 + dx) & 63, y, s, s, s * 0.97) }
    }
  }
  // scuffs on the baseboard
  for (let k = 0; k < 9; k++) {
    const x0 = Math.floor(rnd() * 58), y0 = 56 + Math.floor(rnd() * 4), len = 2 + Math.floor(rnd() * 5), lit = rnd() < 0.5
    for (let d = 0; d < len; d++) mulPx(S, (x0 + d) & 63, y0, lit ? 1.28 : 0.72)
  }

  const plateC = w.map((c) => c + (255 - c) * 0.55)               // switch plate: a lightened wallpaper colour
  const grille = mix3(w, [150, 150, 146], 0.55)
  const V = {}
  V.stainA = makeVariant(S, EDGE, 0, (T) => wallStain(T, { seed: 0xA1B101, cx: 31, halfW: 22, depth: 27, strength: 0.95, tint: STAIN_PAPER }))
  V.stainB = makeVariant(S, EDGE, 0, (T) => {
    // a narrow leak from the ceiling, with a long finger, plus a little rising damp low on the wall
    wallStain(T, { seed: 0xA1B102, cx: 38, halfW: 8, depth: 40, strength: 1.0, tint: STAIN_PAPER })
    risingDamp(T, { seed: 0xA1B103, top: 43, strength: 0.75, tint: [0.84, 0.84, 0.72] })
  })
  V.seam = makeVariant(S, EDGE, 0, (T) => {
    const r = mulberry32(0xA1B104), x0 = 28
    for (let y = 3; y < 37; y++) {
      const t = (y - 3) / 34
      const wd = Math.max(1, Math.round(lerpf(4, 1, t) + (r() - 0.5) * 0.9))
      for (let dx = 0; dx < wd; dx++) setPx(T, x0 + dx, y, plaster, (0.86 + 0.2 * r()) * (dx === 0 ? 0.7 : 1))
      mulPx(T, x0 - 1, y, 0.88); mulPx(T, x0 - 2, y, 0.96)
      mulPx(T, x0 + wd, y, 1.17); mulPx(T, x0 + wd + 1, y, 1.05)
    }
    // the lifted flap curling away at the top
    for (let y = 3; y < 13; y++) for (let x = x0 + 1; x < x0 + 8; x++) {
      const d = (x - x0 - 1) - (y - 3) * 0.55
      if (d > 0 && d < 5.2) mulPx(T, x, y, 1.12); else if (d >= 5.2 && d < 6.4) mulPx(T, x, y, 0.78)
    }
    // a hairline crack in the plaster below the end of the seam
    walkCrack(r, x0, 37, 1.6, 8, 0.9, (x, y) => mulPx(T, x, y, 0.72))
  })
  V.outlet = makeVariant(S, EDGE, 0, (T) => {
    // grime fanned up from the plate, then the plate: 8x12, two sockets, a screw
    for (let y = 20; y < 42; y++) for (let x = 22; x < 46; x++) mulPx(T, x, y, 1 - 0.11 * sstep(20, 41, y) * ellip(x - 34, 0, 7, 1, 1.4))
    fillRect(T, 31, 42, 38, 53, plateC, 0.78)
    fillRect(T, 32, 43, 37, 52, plateC, 1.0)
    for (const oy of [45, 49]) { fillRect(T, 33, oy, 36, oy + 2, [46, 40, 30]); setPx(T, 34, oy + 1, plateC, 0.5); setPx(T, 35, oy + 1, plateC, 0.5) }
    setPx(T, 34, 43, plateC, 0.55); setPx(T, 35, 52, plateC, 0.6)
    for (let x = 32; x < 40; x++) mulPx(T, x, 54, 0.78)
    for (let y = 44; y < 54; y++) mulPx(T, 39, y, 0.8)
  })
  V.vent = makeVariant(S, EDGE, 0, (T) => {
    const r = mulberry32(0xA1B105)
    // dust streaks below the grille, then the grille: dark frame, alternating slat / slot
    for (let x = 23; x < 41; x++) { const L = 4 + r() * 10, kk = 0.06 + r() * 0.06; for (let y = 21; y < 21 + L; y++) mulPx(T, x, y, 1 - kk * (1 - (y - 21) / L)) }
    fillRect(T, 23, 8, 40, 20, grille, 0.62)
    fillRect(T, 24, 9, 39, 19, grille, 0.96)
    for (let y = 10; y < 19; y += 2) { for (let x = 25; x < 39; x++) setPx(T, x, y, grille, 0.26); for (let x = 25; x < 39; x++) mulPx(T, x, y + 1, 1.05) }
    for (let x = 24; x < 40; x++) mulPx(T, x, 8, 1.2)
  })
  V.scuff = makeVariant(S, EDGE, 0, (T) => {
    const r = mulberry32(0xA1B106)
    // a rubbed dirty zone, long chair / cart scrapes, and heel marks on the baseboard
    const sm = fbm(0xA1B107, [[8, 4, 1], [4, 4, 0.5]])
    for (let y = 30; y < 55; y++) for (let x = 6; x < 58; x++) {
      const e = ellip(x - 34, (y - 46) * 1.6, 22, 12, 0.6) * edgeFade(x, 4, 12)
      stainPx(T, x, y, e * (0.25 + 0.22 * sm[y * TS + x]), [0.80, 0.78, 0.66])
    }
    for (let k = 0; k < 10; k++) {
      const x0 = 9 + r() * 42, y0 = 34 + r() * 18, ang = (r() - 0.5) * 0.7 + (r() < 0.3 ? 1.4 : 0), len = 7 + r() * 16, dark = r() < 0.7
      walkCrack(r, x0, y0, ang, len, 0.25, (x, y, t) => { if (x > 5 && x < 58) { const f = Math.sin(t * Math.PI); mulPx(T, x, y, dark ? 1 - 0.20 * f : 1 + 0.16 * f) } })
    }
    for (let k = 0; k < 4; k++) { const x0 = 8 + Math.floor(r() * 46), y0 = 44 + Math.floor(r() * 9); for (let d = 0; d < 3; d++) for (let e2 = 0; e2 < 2; e2++) setPx(T, x0 + d, y0 + e2, plaster, 0.95) }
    for (let k = 0; k < 6; k++) { const x0 = 6 + Math.floor(r() * 50), y0 = 56 + Math.floor(r() * 3), len = 3 + Math.floor(r() * 5); for (let d = 0; d < len; d++) mulPx(T, x0 + d, y0, 0.55) }
  })
  V.prints = makeVariant(S, EDGE, 0, (T) => {
    // a trail of dusty palm prints along the wall at hand height: someone steadied themselves here, walking one way, and kept walking
    const dust = fbm(0xA1B10A, [[4, 4, 1], [2, 2, 0.8]])
    const grime = [0.80, 0.77, 0.66]
    const prints = [[12, 39, -0.22], [27, 43, 0.1], [43, 37, 0.24]]
    prints.forEach(([cx, cy, ang], n) => {
      const ca = Math.cos(ang), sa = Math.sin(ang)
      for (let y = cy - 12; y <= cy + 6; y++) for (let x = cx - 7; x <= cx + 8; x++) {
        const px = x - cx, py = y - cy
        const dx = px * ca + py * sa, dy = -px * sa + py * ca
        let k = ellip(dx, dy, 3.1, 3.7, 0.5)                                            // the palm
        for (const [fx, fy] of [[-3.7, -6.2], [-1.3, -8.6], [1.3, -9.0], [3.7, -7.0]]) k = Math.max(k, ellip(dx - fx, dy - fy, 0.85, 2.6, 0.5))   // four fingers
        k = Math.max(k, ellip(dx - 5.4, dy - 0.6, 1.0, 2.2, 0.5))                       // the thumb
        if (k <= 0) continue
        stainPx(T, x, y, k * (0.30 + 0.30 * (dust[y * TS + x] * 0.5 + 0.5)) * (1 - n * 0.16), grime)
      }
    })
  })
  const base = finish(S)
  const slots = weighted([[base, 6], [V.prints, 1], [V.stainA, 1], [V.stainB, 1], [V.seam, 1],
                          [V.outlet, 1], [V.vent, 1], [V.scuff, 1]])
  return { base, slots }
}

function lobbyFloor(pal) {
  const f = hexToRgb(pal.floor)
  const S = newSub()
  const rnd = mulberry32(0xA1000002)
  const tone = fbm(0xA1201, [[16, 16, 1], [8, 8, 0.5]])
  const nap = fbm(0xA1202, [[32, 2, 1], [16, 4, 0.6]])
  const tB = [f[0] * 1.16, f[1] * 1.02, f[2] * 0.80]                // the second tone of the two-tone weave
  for (let y = 0; y < TS; y++) for (let x = 0; x < TS; x++) {
    const j = y * TS + x, i = j * 3
    const t = sstep(-0.16, 0.16, tone[j])
    let m = 0.80 + 0.30 * rnd() + 0.05 * nap[j]
    if (((x + y) & 3) === 0) m *= 0.965                              // a faint loop-pile lattice
    if (x === 0 || y === 0) m *= 0.88                                // tile seam
    const n = (rnd() - 0.5) * 5
    S[i] = lerpf(f[0], tB[0], t) * m + n; S[i + 1] = lerpf(f[1], tB[1], t) * m + n; S[i + 2] = lerpf(f[2], tB[2], t) * m + n * 0.8
  }
  const wear = (orient, c, wid, seed) => (T) => {
    const st = fbm(seed, [[32, 2, 1], [16, 2, 0.7]])
    for (let y = 0; y < TS; y++) for (let x = 0; x < TS; x++) {
      const along = orient === 'h' ? x : y, across = orient === 'h' ? y : x
      const k = ellip(across - c, 0, wid, 1, 0.9) * edgeFade(along, 5, 15)
      if (k <= 0) continue
      const line = st[orient === 'h' ? y * TS + x : x * TS + y]
      // flattened pile: lighter and a touch greyer, hue kept
      const i = at(x, y), a = k * 0.5
      const tr = T[i] * 1.22, tg = T[i + 1] * 1.2, tb = T[i + 2] * 1.16, l = tr * 0.299 + tg * 0.587 + tb * 0.114
      T[i] += (tr + (l - tr) * 0.25 - T[i]) * a; T[i + 1] += (tg + (l - tg) * 0.25 - T[i + 1]) * a; T[i + 2] += (tb + (l - tb) * 0.25 - T[i + 2]) * a
      const g = 1 + 0.07 * line * k
      T[i] *= g; T[i + 1] *= g; T[i + 2] *= g
    }
  }
  const blotch = (seed, cx, cy, r, tintv, ring) => (T) => {
    const jag = fbm(seed, [[8, 8, 1], [4, 4, 0.7], [2, 2, 0.4]])
    for (let y = 4; y < 60; y++) for (let x = 4; x < 60; x++) {
      const j = y * TS + x
      const d = hyp(x - cx, y - cy), rad = r * (1 + 0.22 * jag[j]), sd = d - rad
      if (sd > 1.5) continue
      let k = sd < 0 ? 0.62 + 0.25 * jag[(y * TS + ((x + 17) & 63))] : 0
      k = Math.max(k, ring * Math.exp(-((sd + 0.8) * (sd + 0.8)) / 1.4))
      stainPx(T, x, y, k * edgeFade(x, 3, 8) * edgeFade(y, 3, 8), tintv)
    }
  }
  const V = {
    wearH: makeVariant(S, EDGE, EDGE, wear('h', 31, 11, 0xA1C101)),
    wearV: makeVariant(S, EDGE, EDGE, wear('v', 29, 10, 0xA1C102)),
    stainA: makeVariant(S, EDGE, EDGE, blotch(0xA1C103, 30, 34, 12, [0.62, 0.58, 0.52], 0.95)),
    stainB: makeVariant(S, EDGE, EDGE, (T) => { blotch(0xA1C104, 22, 24, 9, [0.70, 0.72, 0.60], 0.9)(T); blotch(0xA1C105, 40, 42, 7, [0.68, 0.72, 0.60], 0.9)(T) }),
    matted: makeVariant(S, EDGE, EDGE, (T) => {
      const r = mulberry32(0xA1C106)
      for (let y = 6; y < 58; y++) for (let x = 6; x < 58; x++) {
        const k = ellip(x - 30, y - 32, 22, 17, 0.6); if (k <= 0) continue
        const g = 1 + k * (0.07 + (r() - 0.5) * 0.30)
        mulPx(T, x, y, g, g * 0.99, g * 0.96)
      }
    }),
  }
  const base = finish(S)
  return { base, slots: weighted([[base, 5], [V.wearH, 1], [V.wearV, 1], [V.stainA, 1], [V.stainB, 1], [V.matted, 1]]) }
}

function lobbyCeil(pal) {
  const c = hexToRgb(pal.ceiling)
  const S = newSub()
  const rnd = mulberry32(0xA1000003)
  const mott = fbm(0xA1301, [[16, 16, 1], [8, 8, 0.6]])
  for (let y = 0; y < TS; y++) for (let x = 0; x < TS; x++) {
    const j = y * TS + x, i = j * 3
    let m = 0.985 + 0.028 * mott[j]
    const e = Math.min(x, y, TS - 1 - x, TS - 1 - y)                 // T-bar grid: a dark gap, then a bevelled lip
    if (e < 2) m *= 0.66; else if (e === 2) m *= 0.90; else if (e < 6) m *= 0.985 + 0.005 * e
    const n = (rnd() - 0.5) * 6
    S[i] = c[0] * m + n; S[i + 1] = c[1] * m + n; S[i + 2] = c[2] * m + n * 0.9
  }
  // acoustic pinholes and short fissures
  for (let k = 0; k < 120; k++) {
    const x = 5 + Math.floor(rnd() * 54), y = 5 + Math.floor(rnd() * 54)
    if (rnd() < 0.55) mulPx(S, x, y, 0.85)
    else { const len = 2 + Math.floor(rnd() * 3), a = rnd() * Math.PI; for (let s = 0; s < len; s++) mulPx(S, Math.round(x + Math.cos(a) * s), Math.round(y + Math.sin(a) * s), 0.93) }
  }
  const ringStain = (seed, cx, cy, r) => (T) => {
    const jag = fbm(seed, [[8, 8, 1], [4, 4, 0.7], [2, 2, 0.4]])
    for (let y = 5; y < 59; y++) for (let x = 5; x < 59; x++) {
      const j = y * TS + x
      const d = hyp(x - cx, y - cy), rad = r * (1 + 0.20 * jag[j]), sd = d - rad
      if (sd > 1.6) continue
      let k = sd < 0 ? (0.30 + 0.16 * (1 - d / rad)) * (0.88 + 0.24 * jag[(y * TS + ((x + 23) & 63))]) : 0
      k = Math.max(k, 0.6 * Math.exp(-((sd + 0.7) * (sd + 0.7)) / 1.8))
      stainPx(T, x, y, k * edgeFade(x, 4, 9) * edgeFade(y, 4, 9), STAIN_TILE)
    }
  }
  const V = {
    stainA: makeVariant(S, EDGE, EDGE, ringStain(0xA1D101, 33, 30, 17)),
    stainB: makeVariant(S, EDGE, EDGE, (T) => { ringStain(0xA1D102, 20, 40, 11)(T); ringStain(0xA1D103, 43, 20, 8)(T) }),
    missing: makeVariant(S, 2, 2, (T) => {
      const r = mulberry32(0xA1D104)
      const dark = scale3(c, 0.15)
      for (let y = 2; y < 62; y++) for (let x = 2; x < 62; x++) {
        const e = Math.min(x - 2, y - 2, 61 - x, 61 - y)
        if (e === 0) { setPx(T, x, y, c, 0.70); continue }             // the cut edge of the neighbouring tiles
        const m = 0.55 + 0.27 * sstep(0, 14, Math.min(x - 2, y - 2)) + 0.2 * sstep(0, 22, Math.min(61 - x, 61 - y))
        setPx(T, x, y, [dark[0], dark[1] * 0.96, dark[2] * 0.85], m * (0.85 + 0.3 * r()))
      }
      for (let x = 3; x < 61; x++) for (let y = 30; y < 43; y++) { const s = y < 32 ? 2.0 : y > 41 ? 0.7 : 1.5; mulPx(T, x, y, s) }   // a duct run across the plenum
      for (let x = 3; x < 61; x++) for (const jy of [12, 50]) { mulPx(T, x, jy, 1.9); mulPx(T, x, jy + 1, 0.6) }                // joists
      walkLine(3, 22, 60, 26, (x, y) => mulPx(T, x, y, 1.9))                                                                         // a cable
    }),
  }
  const base = finish(S)
  return { base, slots: weighted([[base, 15], [V.stainA, 1], [V.stainB, 1], [V.missing, 1]]) }
}

// the emissive ceiling panel: aluminium frame, a prismatic lens and three lit tubes (mean brightness stays that of the legacy panel)
function fluorescentPanel(col = [250, 247, 224], dirt = 0) {
  const T = new Float32Array(NT * 3)
  const rnd = mulberry32(0xA1000004)
  for (let y = 0; y < TS; y++) for (let x = 0; x < TS; x++) {
    const i = at(x, y)
    const e = Math.min(x, y, TS - 1 - x, TS - 1 - y)
    let b
    if (e < 4) b = e === 3 ? 0.9 : 0.76 - dirt * 0.1                // frame with a lit inner lip
    else {
      const ty = ((y - 8) % 16 + 16) % 16
      b = ty < 6 ? 1.0 : 0.925                                        // tubes vs. the gaps between them
      if (x < 8 || x > TS - 9) b *= 0.86                              // lamp holders
      if (((x >> 1) + (y >> 1)) & 1) b *= 0.985                       // prismatic lens
    }
    const n = (rnd() - 0.5) * 3
    T[i] = col[0] * b + n; T[i + 1] = col[1] * b + n; T[i + 2] = col[2] * b + n
  }
  return finish(T)
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════════
//  Level 1 — the habitable zone: painted cinder block, stained concrete slab, dirty suspended ceiling
// ═════════════════════════════════════════════════════════════════════════════════════════════════════
const RUST_ABS = [150, 82, 40]              // rust orange (tempered by the palette wherever it is used)

// Re-roll the tone of whole blocks (bricks, CMU, stone) in a variant, skipping any block that reaches the tile's outer margin so
// the seam guarantee holds. blocks = [{x0, y0, x1, y1}] (x1, y1 exclusive).
function retoneBlocks(T, blocks, seed, amp, warm = 0) {
  const r = mulberry32(seed)
  for (const b of blocks) {
    const f = 1 + (r() - 0.5) * 2 * amp, wr = 1 + warm * (r() - 0.5)
    if (b.x0 < EDGE + 1 || b.x1 > TS - EDGE - 1) continue
    for (let y = b.y0; y < b.y1; y++) for (let x = b.x0; x < b.x1; x++) mulPx(T, x, y, f * wr, f, f / wr)
  }
}
// a bare / exposed patch (chipped paint, spalled stone): irregular blob, lighter rim, calls paintFn(x, y, k) for the interior
function chipBlob(T, seed, cx, cy, rx, ry, fn) {
  const jag = fbm(seed, [[8, 8, 1], [4, 4, 0.4]])
  for (let y = Math.max(0, cy - ry - 3); y < Math.min(TS, cy + ry + 4); y++) for (let x = Math.max(0, cx - rx - 3); x < Math.min(TS, cx + rx + 4); x++) {
    const d = Math.sqrt(((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2)
    const e = d - (1 + 0.30 * jag[y * TS + x])
    if (e < 0) fn(x, y, e < -0.22 ? 1 : 0.5, 0)
    else if (e < 0.22) fn(x, y, 0, 1)                                // the lip of the paint that is still there
  }
}

function cinderWall(pal) {
  const w = hexToRgb(pal.wall)
  const S = newSub()
  const rnd = mulberry32(0xA1100001)
  const mott = fbm(0xA1111, [[16, 16, 1], [8, 8, 0.6], [4, 4, 0.3]])
  const drip = fbm(0xA1112, [[8, 64, 1]])
  const jl = fbm(0xA1113, [[16, 16, 1], [4, 4, 0.6]])
  const paintLine = 35
  const dado = [0.80, 0.86, 0.82]                                   // the lower band: a darker, greener industrial grey
  const blocks = []
  const tones = new Float32Array(8 * 8)
  for (let c = 0; c < 8; c++) for (let b = 0; b < 8; b++) tones[c * 8 + b] = 1 + (rnd() - 0.5) * 0.11
  for (let c = 0; c < 8; c++) { const off = (c & 1) ? 8 : 0; for (let k = 0; k < 4 + (off ? 1 : 0); k++) { const x0 = off ? k * 16 - 8 : k * 16; blocks.push({ x0: Math.max(0, x0 + 1), x1: Math.min(TS, x0 + 16), y0: c * 8 + 1, y1: c * 8 + 8 }) } }
  for (let y = 0; y < TS; y++) for (let x = 0; x < TS; x++) {
    const j = y * TS + x, i = j * 3
    const c = y >> 3, off = (c & 1) ? 8 : 0
    const xr = (x - off + 64) & 15, yr = y & 7
    const bi = ((x - off + 64) & 63) >> 4
    let m = tones[c * 8 + bi] * (1 + 0.035 * mott[j])

    const pl = paintLine + 1.6 * jl[(x & 63)]
    const inDado = y > pl
    let cr = 1, cg = 1, cb = 1
    if (inDado) { cr = dado[0]; cg = dado[1]; cb = dado[2] }
    if (Math.abs(y - pl) < 1.2) m *= 1.09                             // a crisp, slightly thick paint edge
    // block relief: recessed mortar joints, a lit top edge, a shaded bottom edge
    if (yr === 0) m *= 0.72; else if (yr === 1) m *= 1.06; else if (yr === 7) m *= 0.94
    if (xr === 0) m *= 0.74; else if (xr === 1) m *= 1.04; else if (xr === 15) m *= 0.95
    // orange-peel paint: a fine pit texture
    const n = (rnd() - 0.5) * 8
    if (rnd() < 0.035) m *= 0.84
    // damp rising from the floor: darker, greener, with efflorescence blooms on the lower courses
    const rise = sstep(44, 63, y)
    m *= 1 - 0.14 * rise * (0.6 + 0.4 * mott[j])
    let salt = 0
    if (y > 46 && rnd() < 0.05 * rise) salt = 0.10
    // dark grime under the ceiling and long drip streaks from it
    m *= 1 - 0.10 * (1 - sstep(0, 12, y)) * (0.7 + 0.3 * mott[(j + 900) & 4095])
    m *= 1 - 0.07 * (0.5 + drip[x]) * Math.pow(1 - y / 64, 1.6) * (drip[x] > 0.1 ? 1 : 0)
    const rr = w[0] * cr * m, gg = w[1] * cg * m, bb = w[2] * cb * m * (1 - rise * 0.05)
    S[i] = rr + n + salt * 255 * 0.5; S[i + 1] = gg + n + salt * 255 * 0.5; S[i + 2] = bb + n * 0.9 + salt * 255 * 0.5
  }
  const bare = mul3(w, [1.08, 1.03, 0.93])                            // bare block under the paint: warmer, lighter, grainy
  const bareFn = (T, seed) => { const g = fbm(seed, [[2, 2, 1], [1, 1, 0.8]]); return (x, y, k, lip) => {
    if (lip) { mulPx(T, x, y, 1.13); return }
    const gg = 0.86 + 0.16 * g[y * TS + x] + (((x * 7 + y * 13) & 7) === 0 ? -0.12 : 0)
    mixPx(T, x, y, scale3(bare, gg), 0.92 * k)
  } }
  const V = {}
  V.chips = makeVariant(S, EDGE, 0, (T) => {
    const r = mulberry32(0xA1E101), f = bareFn(T, 0xA1E102)
    for (let k = 0; k < 9; k++) chipBlob(T, 0xA1E110 + k, 8 + Math.floor(r() * 48), 20 + Math.floor(r() * 32), 1 + Math.floor(r() * 3), 1 + Math.floor(r() * 2), f)
  })
  V.peel = makeVariant(S, EDGE, 0, (T) => {
    const f = bareFn(T, 0xA1E103)
    chipBlob(T, 0xA1E120, 30, 20, 15, 9, f)
    chipBlob(T, 0xA1E121, 40, 32, 7, 5, f)
    const r = mulberry32(0xA1E122)
    for (let k = 0; k < 6; k++) chipBlob(T, 0xA1E130 + k, 12 + Math.floor(r() * 40), 8 + Math.floor(r() * 30), 1, 1, f)
  })
  V.rust = makeVariant(S, EDGE, 0, (T) => {
    const r = mulberry32(0xA1E104), rc = accent(RUST_ABS, w, 0.3)
    // a rusting bolt / drain-pipe stub with long streaks running down
    for (let k = 0; k < 3; k++) {
      const x0 = 14 + Math.floor(r() * 36), y0 = 6 + Math.floor(r() * 10), len = 20 + r() * 34, a = 0.35 + r() * 0.3
      for (let y = y0; y < Math.min(63, y0 + len); y++) {
        const f = Math.pow(1 - (y - y0) / len, 0.8), wob = Math.round(Math.sin(y * 0.3 + k) * 0.7)
        mixPx(T, x0 + wob, y, mul3(rc, [0.9, 0.85, 0.8]), a * f)
        mixPx(T, x0 + wob + 1, y, rc, a * f * 0.35)
      }
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) mixPx(T, x0 + dx, y0 + dy, scale3(rc, 0.85), 0.9)
    }
  })
  V.box = makeVariant(S, EDGE, 0, (T) => {
    const grey = mul3(w, [0.86, 0.9, 0.92])
    fillRect(T, 25, 20, 37, 33, grey, 0.55)                          // an electrical junction box with a conduit stub up to the ceiling
    fillRect(T, 26, 21, 36, 32, grey, 0.98)
    fillRect(T, 26, 21, 36, 22, grey, 1.1)
    for (const [sx, sy] of [[27, 22], [35, 22], [27, 31], [35, 31]]) setPx(T, sx, sy, grey, 0.5)
    fillRect(T, 30, 26, 32, 27, grey, 0.45)
    for (let y = 0; y < 20; y++) { setPx(T, 30, y, grey, 1.12); setPx(T, 31, y, grey, 1.0); setPx(T, 32, y, grey, 0.72); mulPx(T, 33, y, 0.85) }
    for (let x = 26; x < 39; x++) mulPx(T, x, 34, 0.8)
    for (let y = 22; y < 34; y++) mulPx(T, 38, y, 0.82)
  })
  V.tally = makeVariant(S, EDGE, 0, (T) => {
    // groups of scratched tally marks (four strokes and a slash), the paint scored away to the block beneath
    const r = mulberry32(0xA1E105)
    const scratch = (x, y0, y1, k) => { for (let y = y0; y <= y1; y++) mixPx(T, x, y, bare, 0.7 * k) }
    for (let g = 0; g < 3; g++) {
      const bx = 14 + g * 14, by = 22 + Math.floor(r() * 4)
      for (let s = 0; s < 4; s++) scratch(bx + s * 2, by + Math.floor(r() * 2), by + 8 + Math.floor(r() * 2), 1)
      walkLine(bx - 1, by + 7, bx + 8, by + 1, (x, y) => mixPx(T, x, y, bare, 0.6))
    }
  })
  V.toneA = makeVariant(S, EDGE, 0, (T) => retoneBlocks(T, blocks, 0xA1E106, 0.07, 0.04))
  V.toneB = makeVariant(S, EDGE, 0, (T) => { retoneBlocks(T, blocks, 0xA1E107, 0.07, 0.04); wallStain(T, { seed: 0xA1E108, cx: 24, halfW: 14, depth: 20, strength: 0.55, tint: [0.80, 0.78, 0.66] }) })
  const base = finish(S)
  return { base, slots: weighted([[base, 5], [V.toneA, 1], [V.toneB, 1], [V.chips, 1], [V.peel, 1], [V.rust, 1], [V.box, 1], [V.tally, 1]]) }
}

function slabFloor(pal) {
  const f = hexToRgb(pal.floor)
  const S = newSub()
  const rnd = mulberry32(0xA1100002)
  const blot = fbm(0xA1121, [[16, 16, 1], [8, 8, 0.8], [4, 4, 0.4]])
  const swirl = fbm(0xA1122, [[8, 32, 1], [16, 16, 0.6]])
  for (let y = 0; y < TS; y++) for (let x = 0; x < TS; x++) {
    const j = y * TS + x, i = j * 3
    let m = 1 + 0.14 * blot[j] + 0.04 * swirl[j]
    m *= 0.9 + 0.2 * rnd()
    if (rnd() < 0.05) m *= 1.25                                       // pale aggregate
    else if (rnd() < 0.03) m *= 0.72
    const e = Math.min(x, y)
    if (e === 0) m *= 0.45; else if (e === 1) m *= 0.8               // the expansion joint, spalled a little at the lip
    const n = (rnd() - 0.5) * 4
    S[i] = f[0] * m * 1.0 + n; S[i + 1] = f[1] * m * 1.0 + n; S[i + 2] = f[2] * m * 0.97 + n
  }
  const crack = (seed, x0, y0, ang) => (T) => {
    const r = mulberry32(seed)
    const branch = (x, y, a, len, depth) => {
      walkCrack(r, x, y, a, len, 0.7, (px, py, t) => {
        if (px < EDGE + 1 || px > TS - EDGE - 2 || py < EDGE + 1 || py > TS - EDGE - 2) return
        mulPx(T, px, py, 0.70 + 0.16 * t)
        mulPx(T, px + 1, py + 1, 0.95)
      })
      if (depth < 2) for (let k = 0; k < 2; k++) branch(x + Math.cos(a) * len * (0.3 + 0.4 * r()), y + Math.sin(a) * len * (0.3 + 0.4 * r()), a + (r() < 0.5 ? -1 : 1) * (0.5 + r() * 0.7), len * 0.55, depth + 1)
    }
    branch(x0, y0, ang, 30, 0)
  }
  const V = {
    crackA: makeVariant(S, EDGE, EDGE, crack(0xA1F101, 8, 12, 0.5)),
    crackB: makeVariant(S, EDGE, EDGE, crack(0xA1F102, 12, 52, -0.7)),
    oil: makeVariant(S, EDGE, EDGE, (T) => {
      const jag = fbm(0xA1F103, [[8, 8, 1], [4, 4, 0.8], [2, 2, 0.5]])
      for (let y = 6; y < 58; y++) for (let x = 6; x < 58; x++) {
        const d = hyp((x - 32) * 0.9, y - 34), rad = 12 * (1 + 0.32 * jag[y * TS + x]), sd = d - rad
        if (sd > 2) continue
        const fade = edgeFade(x, 3, 9) * edgeFade(y, 3, 9)
        if (sd < 0) { const dk = 0.42 + 0.3 * c01(-sd / 6); stainPx(T, x, y, (1 - dk) * fade * 1.4, [0.35, 0.36, 0.40]); if (sd > -2.2) mulPx(T, x, y, 1.09) }   // a slick dark centre with a paler rainbow-less rim
        else mulPx(T, x, y, 1 - 0.16 * fade)
      }
    }),
    patch: makeVariant(S, EDGE, EDGE, (T) => {
      for (let y = 12; y < 50; y++) for (let x = 10; x < 54; x++) {
        let m = 1.11
        if (x === 10 || y === 12 || x === 53 || y === 49) m = 0.55
        mulPx(T, x, y, m, m, m * 1.02)
      }
      for (let x = 10; x < 54; x++) mulPx(T, x, 50, 0.8)
    }),
    wet: makeVariant(S, EDGE, EDGE, (T) => {
      const jag = fbm(0xA1F104, [[16, 16, 1], [8, 8, 0.8], [4, 4, 0.4]])
      for (let y = 4; y < 60; y++) for (let x = 4; x < 60; x++) {
        const k = sstep(-0.05, 0.28, 0.32 - hyp((x - 28) / 26, (y - 30) / 22) + 0.45 * jag[y * TS + x]) * edgeFade(x, 3, 9) * edgeFade(y, 3, 9)
        stainPx(T, x, y, k * 0.55, [0.62, 0.66, 0.66])
      }
    }),
    line: makeVariant(S, EDGE, EDGE, (T) => wornStripe(T, 'h', 30, 4, accent([176, 150, 40], f, 0.35), 0xA1F105, 0.75)),
  }
  const base = finish(S)
  return { base, slots: weighted([[base, 6], [V.crackA, 1], [V.crackB, 1], [V.oil, 1], [V.patch, 1], [V.wet, 1], [V.line, 1]]) }
}

// suspended acoustic tile that has had decades of neglect: grimy T-bars, square perforations, rust weeps, big stains
function dirtyCeil(pal) {
  const c = hexToRgb(pal.ceiling)
  const S = newSub()
  const rnd = mulberry32(0xA1100003)
  const mott = fbm(0xA1131, [[16, 16, 1], [8, 8, 0.7], [4, 4, 0.4]])
  for (let y = 0; y < TS; y++) for (let x = 0; x < TS; x++) {
    const j = y * TS + x, i = j * 3
    const e = Math.min(x, y, TS - 1 - x, TS - 1 - y)
    let m = 0.96 + 0.07 * mott[j]
    m *= 1 - 0.20 * (1 - sstep(2, 14, e)) * (0.6 + 0.4 * mott[(j + 700) & 4095])   // soot gathers along the grid
    if (e < 2) m *= 0.6; else if (e === 2) m *= 0.88
    else if ((x & 3) === 2 && (y & 3) === 2 && e > 4) m *= 0.80          // a perforation grid
    const n = (rnd() - 0.5) * 7
    S[i] = c[0] * m + n; S[i + 1] = c[1] * m + n; S[i + 2] = c[2] * m * (1 - 0.03 * (1 - sstep(2, 14, e))) + n * 0.9
  }
  const rc = accent(RUST_ABS, c, 0.4)
  const r0 = mulberry32(0xA1131F)
  for (let k = 0; k < 3; k++) {                                        // rust weeping from the T-bar corners
    const x0 = 3 + Math.floor(r0() * 3), y0 = 3, len = 4 + r0() * 8
    for (let d = 0; d < len; d++) { mixPx(S, x0 + (k & 1 ? 0 : d), y0 + (k & 1 ? d : 0), rc, 0.28 * (1 - d / len)) }
  }
  const stain = (seed, cx, cy, r, k0) => (T) => {
    const jag = fbm(seed, [[8, 8, 1], [4, 4, 0.7], [2, 2, 0.4]])
    for (let y = 5; y < 59; y++) for (let x = 5; x < 59; x++) {
      const j = y * TS + x, d = hyp(x - cx, y - cy), rad = r * (1 + 0.24 * jag[j]), sd = d - rad
      if (sd > 1.6) continue
      let k = sd < 0 ? k0 * (0.8 + 0.3 * jag[(y * TS + ((x + 11) & 63))]) : 0
      k = Math.max(k, 0.9 * Math.exp(-((sd + 0.7) * (sd + 0.7)) / 1.5))
      stainPx(T, x, y, k * edgeFade(x, 4, 9) * edgeFade(y, 4, 9), [0.66, 0.55, 0.36])
    }
  }
  const V = {
    stainA: makeVariant(S, EDGE, EDGE, stain(0xA1F200, 30, 32, 20, 0.5)),
    stainB: makeVariant(S, EDGE, EDGE, (T) => { stain(0xA1F201, 18, 22, 10, 0.55)(T); stain(0xA1F202, 44, 42, 13, 0.5)(T) }),
    sag: makeVariant(S, EDGE, EDGE, (T) => {
      // a tile that has slumped: a dark belly and a bright lifted edge on one side
      for (let y = 3; y < 61; y++) for (let x = 3; x < 61; x++) {
        const k = ellip(x - 34, y - 30, 24, 22, 0.7)
        mulPx(T, x, y, 1 - 0.30 * k)
        if (x > 48) mulPx(T, x, y, 1 + 0.05 * (x - 48) / 12)
      }
    }),
    plenum: makeVariant(S, 2, 2, (T) => {
      const r = mulberry32(0xA1F203)
      const dark = scale3(c, 0.15)
      for (let y = 2; y < 62; y++) for (let x = 2; x < 62; x++) {
        const e = Math.min(x - 2, y - 2, 61 - x, 61 - y)
        if (e === 0) { setPx(T, x, y, c, 0.62); continue }
        const m = 0.55 + 0.27 * sstep(0, 14, Math.min(x - 2, y - 2)) + 0.2 * sstep(0, 22, Math.min(61 - x, 61 - y))
        setPx(T, x, y, [dark[0], dark[1] * 0.97, dark[2] * 0.88], m * (0.85 + 0.3 * r()))
      }
      for (let y = 28; y < 40; y++) for (let x = 3; x < 61; x++) { const d = Math.abs(y - 33.5) / 5.5; mulPx(T, x, y, 1.5 + 1.8 * Math.sqrt(Math.max(0, 1 - d * d))) }   // a pipe run behind
    }),
  }
  const base = finish(S)
  return { base, slots: weighted([[base, 11], [V.stainA, 1], [V.stainB, 1], [V.sag, 1], [V.plenum, 1]]) }
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════════
//  Level 2 — pipe dreams: riveted rust-brown steel, wet concrete / tread plate, a ceiling of pipe and duct runs
// ═════════════════════════════════════════════════════════════════════════════════════════════════════
// a rounded rivet / bolt head 2x2 (lit top-left, shaded bottom-right)
function rivet(T, x, y, base = 1) {
  mulPx(T, x, y, 1.38 * base); mulPx(T, x + 1, y, 1.0 * base); mulPx(T, x, y + 1, 0.9 * base); mulPx(T, x + 1, y + 1, 0.55 * base)
}
// the shading of a horizontal cylinder seen from below, t = -1..1 across its diameter (light from one side)
function cyl(t) {
  const n = Math.sqrt(Math.max(0, 1 - t * t))
  return 0.26 + 0.95 * Math.exp(-((t + 0.42) * (t + 0.42)) / 0.32) * (0.55 + 0.45 * n) + 0.08 * n
}

function rustWall(pal) {
  const w = hexToRgb(pal.wall)
  const S = newSub()
  const rnd = mulberry32(0xA1200001)
  const blot = fbm(0xA1211, [[16, 16, 1], [8, 8, 0.7], [4, 4, 0.4]])
  const rustN = fbm(0xA1212, [[8, 8, 1], [4, 4, 0.8], [2, 2, 0.5]])
  const brush = fbm(0xA1213, [[32, 2, 1], [16, 1, 0.5]])
  const rc = accent(RUST_ABS, w, 0.25)
  const stripX = (x) => (x < 4 ? 0 : x >= 32 && x < 36 ? 32 : -1)
  const rusts = []                                                   // rivet positions: rust streaks run down from them
  for (let y = 4; y < 64; y += 8) for (const sx of [1, 33]) { rusts.push([sx, y]) }
  for (let x = 6; x < 64; x += 8) if (stripX(x) < 0) rusts.push([x, 31])
  for (let y = 0; y < TS; y++) for (let x = 0; x < TS; x++) {
    const j = y * TS + x, i = j * 3
    let m = 1 + 0.07 * blot[j] + 0.035 * brush[j]
    const sx = stripX(x)
    let seamNear = 0
    if (sx >= 0) {                                                   // a riveted joint strip
      const u = x - sx
      m *= u === 0 ? 1.16 : u === 3 ? 0.62 : 1.04
      seamNear = 1
    } else if (Math.abs(x - 3.5) < 3.5 || Math.abs(x - 35.5) < 3.5) seamNear = 0.5
    if (y >= 31 && y <= 33) {                                        // the horizontal weld bead: a fish-scale ridge
      m *= y === 32 ? 1.16 + 0.16 * Math.sin(x * 1.25) : y === 31 ? 1.08 : 0.66
      seamNear = 1
    } else if (y === 30) m *= 0.85
    if (y < 2) m *= 0.8; if (y > 59) m *= 0.78 - 0.04 * (y - 60)
    if (rnd() < 0.03) m *= 0.8                                       // paint blisters
    const bottom = sstep(28, 64, y)
    const rk = c01(sstep(0.10, 0.62, rustN[j] * 0.9 + bottom * 0.38 - 0.06 + seamNear * 0.16))
    const n = (rnd() - 0.5) * 8
    const rk2 = rk * 0.68, rt = 0.66 + 0.36 * (blot[j] * 0.5 + 0.5)
    const rr = lerpf(w[0], rc[0] * rt, rk2)
    const gg = lerpf(w[1], rc[1] * rt, rk2)
    const bb = lerpf(w[2], rc[2] * rt, rk2)
    S[i] = rr * m + n; S[i + 1] = gg * m + n; S[i + 2] = bb * m + n * 0.8
  }
  for (let y = 4; y < 64; y += 8) for (const sx of [1, 33]) rivet(S, sx, y)
  for (let x = 6; x < 64; x += 8) if (stripX(x) < 0 && stripX(x + 1) < 0) rivet(S, x, 34)
  for (const [rx, ry] of rusts) {                                    // streaks running down from every rivet
    const len = 5 + Math.floor(rnd() * 14)
    for (let d = 2; d < len; d++) mixPx(S, rx, ry + d, mul3(rc, [0.85, 0.8, 0.75]), 0.32 * (1 - d / len))
  }
  const V = {}
  V.bloom = makeVariant(S, EDGE, 0, (T) => {
    const jag = fbm(0xA1E201, [[8, 8, 1], [4, 4, 0.8], [2, 2, 0.5]])
    for (let y = 22; y < 64; y++) for (let x = 6; x < 58; x++) {
      const k = sstep(0.0, 0.5, 0.55 - hyp((x - 28) / 22, (y - 46) / 18) + 0.5 * jag[y * TS + x]) * edgeFade(x, 3, 9)
      if (k <= 0) continue
      const flake = (jag[y * TS + ((x + 13) & 63)] > 0.35) ? 0.72 : 1        // blistered, flaking paint
      const g = (0.62 + 0.5 * (jag[y * TS + ((x + 5) & 63)] * 0.5 + 0.5)) * flake
      mixPx(T, x, y, [rc[0] * g, rc[1] * g, rc[2] * g], k * 0.78)
    }
  })
  V.streaks = makeVariant(S, EDGE, 0, (T) => {
    const r = mulberry32(0xA1E202)
    for (let k = 0; k < 5; k++) {
      const x0 = 8 + Math.floor(r() * 48), y0 = Math.floor(r() * 12), len = 22 + r() * 34
      for (let y = y0; y < Math.min(63, y0 + len); y++) {
        const f = Math.pow(1 - (y - y0) / len, 0.6), x = x0 + Math.round(Math.sin(y * 0.25 + k) * 0.8)
        mixPx(T, x, y, mul3(rc, [0.9, 0.82, 0.7]), 0.5 * f); mixPx(T, x + 1, y, rc, 0.2 * f)
      }
    }
  })
  V.patch = makeVariant(S, EDGE, 0, (T) => {
    // a bolted repair plate over a rusted-through spot: newer, greyer metal, a fillet weld around it
    const pc = mix3(w, [110, 108, 104], 0.4)
    for (let y = 16; y < 30; y++) for (let x = 22; x < 44; x++) {
      const edge = x === 22 || x === 43 || y === 16 || y === 29
      setPx(T, x, y, pc, edge ? 1.12 : 0.92 + 0.06 * Math.sin(x * 0.5 + y * 0.8))
    }
    for (let x = 22; x < 44; x++) { mulPx(T, x, 30, 0.6); mulPx(T, x, 31, 0.8) }
    for (let y = 16; y < 30; y++) mulPx(T, 44, y, 0.7)
    for (const [bx, by] of [[24, 18], [40, 18], [24, 26], [40, 26]]) rivet(T, bx, by)
  })
  V.hatch = makeVariant(S, EDGE, 0, (T) => {
    const dc = mul3(w, [0.92, 0.92, 0.96])
    for (let y = 8; y < 38; y++) for (let x = 22; x < 42; x++) {
      const edge = x === 22 || x === 41 || y === 8 || y === 37
      const inner = x === 23 || x === 40 || y === 9 || y === 36
      setPx(T, x, y, dc, edge ? 0.5 : inner ? 1.14 : 0.98)
    }
    for (const hy of [12, 20, 30]) { fillRect(T, 20, hy, 22, hy + 3, dc, 0.7); mulPx(T, 20, hy, 1.25) }   // hinge knuckles
    fillRect(T, 35, 21, 39, 23, dc, 1.25); fillRect(T, 35, 24, 39, 24, dc, 0.5)                              // a T handle
    rivet(T, 26, 12); rivet(T, 36, 12); rivet(T, 26, 32); rivet(T, 36, 32)
    for (let x = 22; x < 42; x++) mulPx(T, x, 38, 0.72)
  })
  V.leak = makeVariant(S, EDGE, 0, (T) => {
    const r = mulberry32(0xA1E203)
    for (let y = 10; y < 64; y++) {
      const wd = 2 + Math.floor((y - 10) / 14), x0 = 40 + Math.round(Math.sin(y * 0.2) * 1.2)
      for (let dx = -wd; dx <= wd; dx++) {
        const a = 1 - Math.abs(dx) / (wd + 1.5)
        mulPx(T, x0 + dx, y, 1 - 0.36 * a * (0.8 + 0.2 * r()))
      }
      mulPx(T, x0 - 1, y, 1.16); mulPx(T, x0, y, 1.10)             // the wet sheen down the middle
    }
    for (let dy = 0; dy < 3; dy++) for (let dx = -2; dx <= 2; dx++) mulPx(T, 40 + dx, 9 + dy, 0.7)
  })
  V.plateTone = makeVariant(S, EDGE, 0, (T) => {
    const r = mulberry32(0xA1E204)
    for (const [x0, y0, x1, y1] of [[4, 0, 31, 30], [4, 34, 31, 63]]) { const f = 1 + (r() - 0.5) * 0.16, g = 1 + (r() - 0.5) * 0.07; for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) mulPx(T, x, y, f * g, f, f / g) }
  })
  const base = finish(S)
  return { base, slots: weighted([[base, 5], [V.plateTone, 1], [V.bloom, 1], [V.streaks, 1], [V.patch, 1], [V.hatch, 1], [V.leak, 1]]) }
}

// a floor that is always damp: dark concrete with cool sheens, tread-plate patches and drains
function wetFloor(pal) {
  const f = hexToRgb(pal.floor)
  const S = newSub()
  const rnd = mulberry32(0xA1200002)
  const blot = fbm(0xA1221, [[16, 16, 1], [8, 8, 0.7], [4, 4, 0.4]])
  const puddle = fbm(0xA1222, [[16, 16, 1], [8, 8, 0.6]])
  const sheen = accent([74, 82, 90], f, 0.2)
  for (let y = 0; y < TS; y++) for (let x = 0; x < TS; x++) {
    const j = y * TS + x, i = j * 3
    let m = 1 + 0.16 * blot[j]
    m *= 0.88 + 0.24 * rnd()
    if (rnd() < 0.04) m *= 1.3
    const e = Math.min(x, y)
    if (e === 0) m *= 0.5; else if (e === 1) m *= 0.85
    const wet = sstep(0.25, 0.75, puddle[j]) * 0.22                   // standing damp: a cool, lighter sheen with streaky reflections
    const refl = 1 + 0.35 * (((x >> 1) + (y >> 3)) & 1 ? 0.6 : 0.2)
    const n = (rnd() - 0.5) * 4
    S[i] = lerpf(f[0] * m, sheen[0] * (0.55 + 0.35 * blot[j]) * refl, wet) + n
    S[i + 1] = lerpf(f[1] * m, sheen[1] * (0.55 + 0.35 * blot[j]) * refl, wet) + n
    S[i + 2] = lerpf(f[2] * m, sheen[2] * (0.55 + 0.35 * blot[j]) * refl, wet) + n
  }
  const V = {
    puddle: makeVariant(S, EDGE, EDGE, (T) => {
      const jag = fbm(0xA1F301, [[8, 8, 1], [4, 4, 0.8], [2, 2, 0.5]])
      for (let y = 5; y < 59; y++) for (let x = 5; x < 59; x++) {
        const d = hyp((x - 31) / 1.25, y - 31), rad = 18 * (1 + 0.28 * jag[y * TS + x]), sd = d - rad
        if (sd > 1.5) continue
        const fade = edgeFade(x, 3, 9) * edgeFade(y, 3, 9)
        if (sd < 0) {
          const a = 0.55 * fade, g = 0.62 + 0.4 * (1 - d / rad) + 0.12 * jag[y * TS + ((x + 7) & 63)]
          mixPx(T, x, y, [sheen[0] * g, sheen[1] * g, sheen[2] * g], a)
        }
        if (sd > -1.6 && sd < 1.2) mulPx(T, x, y, 0.72 + 0.15 * fade)                // a dark rim where the water stops
      }
      for (const rr of [4, 9]) for (let a = 0; a < 40; a++) { const an = a / 40 * 6.283; mulPx(T, Math.round(31 + Math.cos(an) * rr * 1.25), Math.round(31 + Math.sin(an) * rr), 1.12) }   // ripples
    }),
    plate: makeVariant(S, EDGE, EDGE, (T) => {
      // a tread-plate (diamond plate) patch: alternating diagonal lugs, steel-grey, with bolt heads at the corners
      const pc = accent([120, 124, 128], f, 0.25)
      for (let y = 8; y < 56; y++) for (let x = 8; x < 56; x++) {
        const cx = (x - 8) & 7, cy = (y - 8) & 7, alt = (((x - 8) >> 3) + ((y - 8) >> 3)) & 1
        const u = alt ? cx - cy : cx + cy - 7, v = alt ? cx + cy - 7 : cx - cy
        let g = 0.42
        if (Math.abs(u) <= 1 && Math.abs(v) <= 3) g = Math.abs(u) === 0 ? 0.98 : 0.74
        else if (cx === 0 || cy === 0) g = 0.34
        if (x === 8 || y === 8) g = 0.75; if (x === 55 || y === 55) g = 0.3
        setPx(T, x, y, pc, g * (0.85 + 0.25 * rnd()))
      }
      for (const [bx, by] of [[10, 10], [52, 10], [10, 52], [52, 52]]) rivet(T, bx, by)
    }),
    drain: makeVariant(S, EDGE, EDGE, (T) => {
      const gc = accent([96, 96, 98], f, 0.3)
      for (let y = 20; y < 44; y++) for (let x = 20; x < 44; x++) {
        const e = Math.min(x - 20, y - 20, 43 - x, 43 - y)
        if (e === 0) { setPx(T, x, y, gc, 0.4); continue }
        if (e === 1) { setPx(T, x, y, gc, 1.0); continue }
        const bar = ((x - 20) % 4) < 2
        setPx(T, x, y, gc, bar ? 0.8 : 0.16)
      }
      for (let x = 20; x < 44; x++) mulPx(T, x, 44, 0.7)
      const rc = accent(RUST_ABS, f, 0.3); for (let y = 44; y < 58; y++) for (let x = 24; x < 40; x++) mixPx(T, x, y, rc, 0.12 * (1 - (y - 44) / 14) * (0.6 + 0.4 * Math.sin(x * 1.3)))
    }),
    rust: makeVariant(S, EDGE, EDGE, (T) => {
      const rc = accent(RUST_ABS, f, 0.3), jag = fbm(0xA1F302, [[8, 8, 1], [4, 4, 0.8]])
      for (let y = 6; y < 58; y++) for (let x = 6; x < 58; x++) {
        const k = sstep(0, 0.4, 0.45 - hyp((x - 30) / 20, (y - 30) / 16) + 0.5 * jag[y * TS + x]) * edgeFade(x, 3, 9) * edgeFade(y, 3, 9)
        mixPx(T, x, y, scale3(rc, 0.55 + 0.25 * jag[y * TS + ((x + 9) & 63)]), k * 0.5)
      }
    }),
    crack: makeVariant(S, EDGE, EDGE, (T) => {
      const r = mulberry32(0xA1F303)
      walkCrack(r, 8, 40, -0.3, 46, 0.8, (x, y, t) => { if (x > EDGE + 1 && x < TS - EDGE - 2) { mulPx(T, x, y, 0.4 + 0.2 * t); mulPx(T, x, y + 1, 0.85) } })
    }),
  }
  const base = finish(S)
  return { base, slots: weighted([[base, 5], [V.puddle, 1], [V.plate, 1], [V.drain, 1], [V.rust, 1], [V.crack, 1]]) }
}

// pipe and duct runs seen from below. The three runs (a big pipe, a lagged pipe, a sheet-metal duct) all run along x, so every
// variant agrees with the base tile at the left / right edges by construction; variants add fittings between them in the interior.
function pipeCeil(pal) {
  const c = hexToRgb(pal.ceiling)
  const S = newSub()
  const rnd = mulberry32(0xA1200003)
  const dust = fbm(0xA1231, [[16, 16, 1], [8, 8, 0.7], [4, 4, 0.4]])
  const rustN = fbm(0xA1232, [[16, 8, 1], [8, 4, 0.8], [4, 2, 0.6]])
  const rc = accent(RUST_ABS, c, 0.3)
  const A = { c: 13.5, r: 9.2, col: mul3(c, [1.5, 1.36, 1.24]) }        // the big pipe: rust-brown paint
  const B = { c: 34.5, r: 5.2, col: mul3(c, [1.35, 1.4, 1.32]) }         // the lagged pipe
  const D = { y0: 46, y1: 59, col: mul3(c, [1.4, 1.44, 1.48]) }         // the duct
  const flangeA = (x) => (x >= 10 && x < 13) || (x >= 42 && x < 45)
  for (let y = 0; y < TS; y++) for (let x = 0; x < TS; x++) {
    const j = y * TS + x, i = j * 3
    const n = (rnd() - 0.5) * 6
    let col = null, m = 1
    const ta = (y - A.c) / (A.r + (flangeA(x) ? 1.3 : 0))
    const tb = (y - B.c) / B.r
    if (Math.abs(ta) <= 1) {
      col = A.col; m = cyl(ta)
      if (flangeA(x)) { const u = x - (x >= 42 ? 42 : 10); m *= u === 1 ? 1.25 : 0.6; if (Math.abs(ta) > 0.75 && u === 1) m *= 0.9 }
      if ((x === 22 || x === 23 || x === 54 || x === 55)) m *= 0.55        // pipe hanger straps
      const rk = sstep(0.05, 0.5, rustN[j] * 0.8 + 0.12 * Math.abs(ta))
      col = mix3(col, scale3(rc, 0.7 + 0.5 * (dust[j] * 0.5 + 0.5)), rk * 0.55)
    } else if (Math.abs(tb) <= 1) {
      col = B.col; m = cyl(tb)
      if (((x + y) % 6) === 0) m *= 0.8; else if (((x + y) % 6) === 1) m *= 1.06        // spiral insulation wrap
      if (x === 26 || x === 27) m *= 0.65; if (x === 58 || x === 59) m *= 0.65        // band clamps
    } else if (y >= D.y0 && y <= D.y1) {
      col = D.col
      const u = (y - D.y0) / (D.y1 - D.y0)
      m = u < 0.08 ? 1.28 : u > 0.92 ? 0.55 : 0.92 + 0.10 * Math.sin(u * 3.14)
      if (x < 2 || (x >= 32 && x < 34)) m *= 0.6                            // flanged duct joints
      if ((x === 1 || x === 33) && (y === 49 || y === 53 || y === 57)) m *= 1.4
      const ddx = (x + y) & 31; if (ddx === 0) m *= 0.9                         // stiffening crease
    } else {
      // the concrete slab above, in shadow: darkest hard against a pipe, with a rod for each hanger
      const dpipe = Math.min(Math.abs(y - A.c) - A.r, Math.abs(y - B.c) - B.r, Math.abs(y - (D.y0 + D.y1) / 2) - 6.5)
      col = c; m = 0.34 + 0.16 * sstep(0, 4, dpipe) + 0.08 * dust[j]
      if (x === 22 || x === 23 || x === 54 || x === 55) { col = A.col; m = 0.7 }
    }
    m *= 1 + 0.05 * dust[j]
    S[i] = col[0] * m + n; S[i + 1] = col[1] * m + n; S[i + 2] = col[2] * m + n * 0.9
  }
  const V = {}
  V.link = makeVariant(S, EDGE, EDGE, (T) => {
    // a vertical branch between the big and the lagged pipe, with a collar at each end
    for (let y = 22; y <= 30; y++) for (let x = 16; x <= 22; x++) {
      const t = (x - 19) / 3.5, s = cyl(t) * 0.95
      setPx(T, x, y, A.col, s * (0.9 + 0.15 * Math.sin(y * 2)))
    }
    for (const yy of [22, 29]) for (let x = 15; x <= 23; x++) { mulPx(T, x, yy, 0.7); mulPx(T, x, yy + (yy === 22 ? 1 : -1), 1.2) }
  })
  V.valve = makeVariant(S, EDGE, EDGE, (T) => {
    // a flanged valve on the lagged pipe: a fat body with two collars and bolt heads
    for (let y = 26; y <= 43; y++) for (let x = 30; x <= 46; x++) {
      const t = (y - 34.5) / 8.6, k = sstep(29.5, 32, x) * (1 - sstep(44, 46.5, x))
      if (Math.abs(t) > 1 || k <= 0) continue
      setPx(T, x, y, B.col, cyl(t) * 0.95)
    }
    for (const fx of [30, 45]) for (let y = 25; y <= 44; y++) { mulPx(T, fx, y, 0.62); mulPx(T, fx + 1, y, 1.2) }
    for (const by of [27, 41]) for (const bx of [32, 38, 43]) rivet(T, bx, by)
    for (let x = 36; x < 41; x++) for (let y = 21; y < 27; y++) setPx(T, x, y, B.col, 0.75 + 0.15 * (x & 1))   // the stem
  })
  V.leak = makeVariant(S, EDGE, EDGE, (T) => {
    for (let y = 22; y < 31; y++) { const x0 = 32 + Math.round(Math.sin(y * 0.6)); for (let dx = -1; dx <= 1; dx++) mulPx(T, x0 + dx, y, 0.6 + 0.2 * Math.abs(dx)) }
    for (let y = 5; y < 23; y++) for (let x = 26; x < 40; x++) { const a = Math.exp(-((x - 32) * (x - 32)) / 18) * (y / 23); mixPx(T, x, y, scale3(rc, 0.5), 0.35 * a) }
    for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) mulPx(T, 31 + dx, 30 + dy, 1.5)               // the drop, catching light
    for (let y = 30; y < 40; y++) for (let x = 24; x < 42; x++) mulPx(T, x, y, 1 - 0.18 * Math.exp(-((x - 32) * (x - 32)) / 20))
  })
  V.rust = makeVariant(S, EDGE, EDGE, (T) => {
    const jag = fbm(0xA1E302, [[8, 8, 1], [4, 4, 0.8], [2, 2, 0.5]])
    for (let y = 4; y < 60; y++) for (let x = 6; x < 58; x++) {
      const onA = Math.abs((y - A.c) / A.r) <= 1, onD = y >= D.y0 && y <= D.y1
      if (!onA && !onD) continue
      const k = sstep(0.1, 0.5, jag[y * TS + x] + 0.15) * edgeFade(x, 3, 9)
      mixPx(T, x, y, scale3(rc, 0.5 + 0.4 * jag[y * TS + ((x + 9) & 63)] * 0.5 + 0.3), k * 0.7)
    }
  })
  const base = finish(S)
  return { base, slots: weighted([[base, 4], [V.link, 1], [V.valve, 1], [V.leak, 1], [V.rust, 1]]) }
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════════
//  Level 3 — the electrical station: blue-black steel panels with a conduit run, cabinet fronts, painted deck, cable trays
// ═════════════════════════════════════════════════════════════════════════════════════════════════════
const LED_GREEN = [96, 232, 130], LED_AMBER = [240, 176, 56], LED_RED = [232, 64, 52]   // semantic indicator accents (tiny, emissive)
function led(T, x, y, col, k = 1) {
  setPx(T, x, y, [Math.min(255, col[0] * 1.05), Math.min(255, col[1] * 1.05), Math.min(255, col[2] * 1.05)], k)
  setPx(T, x + 1, y, col, 0.95 * k); setPx(T, x, y + 1, col, 0.95 * k); setPx(T, x + 1, y + 1, col, 0.8 * k)
  for (const [dx, dy] of [[-1, 0], [-1, 1], [2, 0], [2, 1], [0, -1], [1, -1], [0, 2], [1, 2]]) mixPx(T, x + dx, y + dy, col, 0.22 * k)   // a faint halo
}

function metalWall(pal) {
  const w = hexToRgb(pal.wall)
  const steel = mul3(w, [0.92, 0.96, 1.06])                            // blue-black: the palette, leaning cold
  const S = newSub()
  const rnd = mulberry32(0xA1300001)
  const brush = fbm(0xA1311, [[32, 2, 1], [16, 1, 0.6]])
  const blot = fbm(0xA1312, [[16, 16, 1], [8, 8, 0.6]])
  const grime = fbm(0xA1313, [[8, 4, 1], [4, 4, 0.6]])
  const warn = accent([196, 162, 30], steel, 0.35)
  const CY = 10, CR = 3.6
  for (let y = 0; y < TS; y++) for (let x = 0; x < TS; x++) {
    const j = y * TS + x, i = j * 3
    let m = 1 + 0.05 * brush[j] + 0.035 * blot[j], col = steel
    const n = (rnd() - 0.5) * 6
    if (y >= 56) {                                                   // kick plate, with a single worn line of warning yellow along its top
      m = 0.62 + 0.06 * brush[j]
      if (y === 56) m = 1.25
      else if (y === 57 || y === 58) { col = warn; m = 0.5 * (0.7 + 0.5 * (grime[j] * 0.5 + 0.5)) * (((x * 5 + y) & 7) < 6 ? 1 : 0.5) }
      else if (y === 63) m *= 0.6
    } else {
      // panel joints: a dark seam with a lit lip, bolts down each joint
      const jx = x < 2 ? x : x >= 32 && x < 34 ? x - 32 : -1
      if (jx === 0) m *= 0.55; else if (jx === 1) m *= 1.14
      if ((x === 3 || x === 35) && (y === 22 || y === 42)) m *= 1.4
      if (y < 3) m *= 0.7 + y * 0.1
      // the conduit run: a horizontal tube with a lit edge, clamped to the wall at two points
      const t = (y - CY) / CR
      if (Math.abs(t) <= 1) {
        m = cyl(t) * 0.95
        if (((x + 4) & 31) < 3) m *= 0.55 + 0.2 * Math.abs(t)
        if (((x + 4) & 31) === 1) m *= 1.3
      } else if (Math.abs(t) < 1.5 && t > 0) m *= 0.7                     // its shadow on the wall
      m *= 1 - 0.09 * sstep(38, 56, y) * (0.7 + 0.3 * grime[j])
    }
    S[i] = col[0] * m + n; S[i + 1] = col[1] * m + n; S[i + 2] = col[2] * m + n * 0.9
  }
  // scratches
  for (let k = 0; k < 8; k++) { const x0 = Math.floor(rnd() * 56), y0 = 18 + Math.floor(rnd() * 34), len = 3 + Math.floor(rnd() * 9), ang = (rnd() - 0.5) * 0.4; walkLine(x0, y0, x0 + len, Math.round(y0 + Math.sin(ang) * len), (x, y) => mulPx(S, x, y, 1.12)) }
  const grey = mul3(steel, [1.04, 1.04, 1.06])
  const V = {}
  const cabinet = (o) => (T) => {
    const { x0, y0, x1, y1 } = o
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const e = x === x0 || x === x1 || y === y0 || y === y1, i2 = x === x0 + 1 || y === y0 + 1
      setPx(T, x, y, grey, e ? 0.38 : i2 ? 1.22 : 1.0 + 0.04 * Math.sin(y * 1.1))
    }
    for (let x = x0; x <= x1; x++) mulPx(T, x, y1 + 1, 0.55)
    for (let y = y0; y <= y1; y++) mulPx(T, x1 + 1, y, 0.7)
    for (const hy of [y0 + 4, (y0 + y1) >> 1, y1 - 8]) fillRect(T, x0 - 2, hy, x0, hy + 3, grey, 0.72)         // hinges
    fillRect(T, x1 - 5, (y0 + y1) / 2 | 0, x1 - 3, ((y0 + y1) / 2 | 0) + 4, grey, 0.5)                          // a lever handle
    fillRect(T, x1 - 4, ((y0 + y1) / 2 | 0) + 1, x1 - 4, ((y0 + y1) / 2 | 0) + 3, grey, 1.4)
    for (let s = 0; s < o.slots; s++) { for (let x = x0 + 6; x < x1 - 5; x++) setPx(T, x, y0 + 4 + s * 2, grey, 0.22) }     // ventilation slots
    o.leds.forEach(([lx, ly, col]) => led(T, lx, ly, col))
    if (o.label) { fillRect(T, o.label[0], o.label[1], o.label[2], o.label[3], [206, 204, 190], 0.75); for (let x = o.label[0] + 1; x < o.label[2]; x += 3) for (let y = o.label[1] + 1; y < o.label[3]; y += 2) mulPx(T, x, y, 0.55) }
    if (o.display) { fillRect(T, o.display[0], o.display[1], o.display[2], o.display[3], [10, 16, 20]); for (let x = o.display[0] + 2; x < o.display[2] - 1; x += 3) setPx(T, x, o.display[1] + 2, [70, 190, 210], 0.6) }
  }
  V.cabA = makeVariant(S, EDGE, 0, cabinet({ x0: 16, y0: 18, x1: 47, y1: 52, slots: 3, leds: [[21, 29, LED_GREEN], [26, 29, LED_GREEN], [31, 29, LED_AMBER]], label: [22, 43, 41, 48] }))
  V.cabB = makeVariant(S, EDGE, 0, cabinet({ x0: 20, y0: 16, x1: 43, y1: 49, slots: 2, leds: [[25, 40, LED_RED], [30, 40, LED_GREEN]], display: [24, 26, 39, 32], label: null }))
  V.louvre = makeVariant(S, EDGE, 0, (T) => {
    for (let y = 16; y <= 39; y++) for (let x = 20; x <= 43; x++) {
      const e = x === 20 || x === 43 || y === 16 || y === 39
      const slot = ((y - 18) & 3) < 2 && y > 17 && y < 38 && x > 21 && x < 42
      setPx(T, x, y, grey, e ? 0.4 : slot ? 0.14 : 1.05)
    }
    for (let y = 18; y < 38; y++) if (((y - 18) & 3) === 2) for (let x = 22; x < 42; x++) mulPx(T, x, y, 1.1)
    for (const [bx, by] of [[22, 17], [40, 17], [22, 38], [40, 38]]) rivet(T, bx, by)
    for (let x = 20; x <= 43; x++) mulPx(T, x, 40, 0.6)
  })
  V.sign = makeVariant(S, EDGE, 0, (T) => {
    const y0 = 20, ya = accent([224, 186, 34], steel, 0.3)
    for (let y = y0; y <= y0 + 12; y++) {
      const half = (y - y0) * 0.62 + 0.5
      for (let x = Math.round(32 - half); x <= Math.round(32 + half); x++) {
        const edge = Math.abs(x - 32) > half - 1 || y === y0 + 12
        setPx(T, x, y, ya, edge ? 0.35 : 0.92)
      }
    }
    for (const [x, y] of [[33, 24], [32, 25], [31, 26], [32, 27], [33, 28], [32, 29], [31, 30]]) setPx(T, x, y, [14, 14, 12])   // the lightning bolt
    setPx(T, 32, 26, [14, 14, 12]); setPx(T, 32, 28, [14, 14, 12])
    rivet(T, 28, 31); rivet(T, 35, 31)
    for (let x = 24; x < 40; x++) mulPx(T, x, 33, 0.72)
  })
  V.scorch = makeVariant(S, EDGE, 0, (T) => {
    const r = mulberry32(0xA1E401), soot = fbm(0xA1E402, [[4, 4, 1], [2, 2, 0.8]])
    for (let y = 8; y < 56; y++) for (let x = 6; x < 58; x++) {
      const d = hyp((x - 34) * 1.0, (y - 34) * 0.8)
      const k = (1 - sstep(4, 22 + 6 * soot[y * TS + x], d)) * (0.5 + 0.15 * soot[y * TS + x]) * edgeFade(x, 3, 9)
      mulPx(T, x, y, 1 - k * 0.7)
    }
    walkCrack(r, 34, 34, -2.2, 16, 1.6, (x, y, t) => mixPx(T, x, y, [150, 190, 255], 0.30 * (1 - t)))
    walkCrack(r, 34, 34, 0.6, 12, 1.6, (x, y, t) => mixPx(T, x, y, [150, 190, 255], 0.26 * (1 - t)))
  })
  V.junction = makeVariant(S, EDGE, 0, (T) => {
    for (let y = 13; y < 26; y++) { setPx(T, 34, y, grey, 0.6); setPx(T, 35, y, grey, 1.05); setPx(T, 36, y, grey, 1.1); setPx(T, 37, y, grey, 0.7) }   // a drop from the conduit
    for (let y = 26; y <= 40; y++) for (let x = 28; x <= 43; x++) {
      const e = x === 28 || x === 43 || y === 26 || y === 40
      setPx(T, x, y, grey, e ? 0.42 : 1.0 + (x === 29 || y === 27 ? 0.2 : 0))
    }
    for (const [bx, by] of [[30, 28], [40, 28], [30, 37], [40, 37]]) rivet(T, bx, by)
    led(T, 34, 32, LED_GREEN)
    for (let x = 28; x <= 43; x++) mulPx(T, x, 41, 0.6)
  })
  V.hazard = makeVariant(S, EDGE, 0, (T) => {
    const er = fbm(0xA1E403, [[4, 4, 1], [2, 2, 1]])
    for (let y = 44; y < 55; y++) for (let x = 6; x < 58; x++) {
      const stripe = ((x + y) & 15) < 8
      const keep = sstep(-0.5, 0.15, er[y * TS + x] + 0.2) * edgeFade(x, 4, 10)
      const g = 0.5 * (0.7 + 0.5 * (er[y * TS + ((x + 5) & 63)] * 0.5 + 0.5))
      if (keep > 0) mixPx(T, x, y, stripe ? scale3(warn, g) : [12, 12, 14], keep * 0.9)
    }
    for (let x = 6; x < 58; x++) { mulPx(T, x, 43, 0.6); mulPx(T, x, 55, 0.7) }
  })
  const base = finish(S)
  return { base, slots: weighted([[base, 5], [V.cabA, 1], [V.cabB, 1], [V.louvre, 1], [V.sign, 1], [V.scorch, 1], [V.junction, 1], [V.hazard, 1]]) }
}

// painted concrete deck: dark, cold, scuffed; variants add a bar-grate inset, a trench plate, worn safety-line fragments
function deckFloor(pal) {
  const f = hexToRgb(pal.floor)
  const S = newSub()
  const rnd = mulberry32(0xA1300002)
  const blot = fbm(0xA1321, [[16, 16, 1], [8, 8, 0.7], [4, 4, 0.4]])
  const scuff = fbm(0xA1322, [[32, 4, 1], [16, 2, 0.6]])
  for (let y = 0; y < TS; y++) for (let x = 0; x < TS; x++) {
    const j = y * TS + x, i = j * 3
    let m = 1 + 0.12 * blot[j] + 0.06 * scuff[j]
    m *= 0.9 + 0.2 * rnd()
    if (rnd() < 0.03) m *= 1.3
    const e = Math.min(x, y)
    if (e === 0) m *= 0.48; else if (e === 1) m *= 0.85
    const n = (rnd() - 0.5) * 4
    S[i] = f[0] * m * 0.98 + n; S[i + 1] = f[1] * m * 1.0 + n; S[i + 2] = f[2] * m * 1.06 + n
  }
  const line = (orient, c0, seed) => (T) => wornStripe(T, orient, c0, 5, accent([190, 160, 30], f, 0.35), seed, 0.8)
  const V = {
    grate: makeVariant(S, EDGE, EDGE, (T) => {
      const gc = mul3(f, [1.7, 1.75, 1.9])
      for (let y = 8; y < 56; y++) for (let x = 8; x < 56; x++) {
        const e = Math.min(x - 8, y - 8, 55 - x, 55 - y)
        if (e === 0) { setPx(T, x, y, gc, 0.35); continue }
        if (e === 1) { setPx(T, x, y, gc, 1.35); continue }
        const bar = ((y - 8) & 7) < 5, cross = ((x - 8) & 31) < 2
        setPx(T, x, y, gc, cross ? 0.95 : bar ? (((y - 8) & 7) === 0 ? 1.25 : 0.95) : 0.16)
      }
      for (let x = 8; x < 56; x++) mulPx(T, x, 56, 0.62)
    }),
    trench: makeVariant(S, EDGE, EDGE, (T) => {
      const pc = mul3(f, [1.5, 1.55, 1.7])
      for (let y = 24; y < 40; y++) for (let x = 5; x < 59; x++) {
        const e = y === 24 || y === 39, cx = ((x >> 2) + (y >> 2)) & 1
        setPx(T, x, y, pc, (e ? 0.4 : cx ? 1.05 : 0.86) * edgeFade(x, 3, 6) + (1 - edgeFade(x, 3, 6)) * 0.7)
      }
      for (const bx of [8, 30, 54]) for (const by of [26, 37]) rivet(T, bx, by)
    }),
    lineH: makeVariant(S, EDGE, EDGE, line('h', 31, 0xA1F401)),
    lineV: makeVariant(S, EDGE, EDGE, line('v', 23, 0xA1F402)),
    scorch: makeVariant(S, EDGE, EDGE, (T) => {
      const soot = fbm(0xA1F403, [[4, 4, 1], [2, 2, 1]])
      for (let y = 6; y < 58; y++) for (let x = 6; x < 58; x++) {
        const d = hyp(x - 30, y - 34), k = (1 - sstep(3, 16 + 6 * soot[y * TS + x], d)) * edgeFade(x, 3, 9) * edgeFade(y, 3, 9)
        mulPx(T, x, y, 1 - 0.55 * k)
      }
      const r = mulberry32(0xA1F404); walkCrack(r, 30, 34, 0.4, 14, 1.4, (x, y, t) => mixPx(T, x, y, [140, 180, 250], 0.25 * (1 - t)))
    }),
  }
  const base = finish(S)
  return { base, slots: weighted([[base, 5], [V.grate, 1], [V.trench, 1], [V.lineH, 1], [V.lineV, 1], [V.scorch, 1]]) }
}

// cable trays seen from below: a ladder of rungs over a lane of cables, hangers, a conduit; all run along x
function trayCeil(pal) {
  const c = hexToRgb(pal.ceiling)
  const S = newSub()
  const rnd = mulberry32(0xA1300003)
  const dust = fbm(0xA1331, [[16, 16, 1], [8, 8, 0.7], [4, 4, 0.4]])
  const steel = mul3(c, [1.45, 1.52, 1.66])
  const cables = [
    { y: 25, a: 2.6, k: 1, ph: 0.0, r: 2.6, col: [26, 30, 42] },
    { y: 31, a: 2.2, k: 2, ph: 1.7, r: 2.3, col: [60, 22, 24] },
    { y: 36, a: 2.8, k: 1, ph: 3.1, r: 2.6, col: [40, 44, 46] },
    { y: 28, a: 2.0, k: 3, ph: 0.6, r: 2.0, col: [28, 46, 38] },
  ]
  const TC = 30, HW = 14                                              // tray centre row and half width
  const cableAt = (x, y) => {                                         // the topmost cable covering (x, y): [colour, shade] or null
    for (let k = cables.length - 1; k >= 0; k--) {
      const cb = cables[k], yc = cb.y + cb.a * Math.sin((x / TS) * Math.PI * 2 * cb.k + cb.ph), t = (y - yc) / cb.r
      if (Math.abs(t) <= 1) return [cb.col, cyl(t) * 1.15]
    }
    return null
  }
  for (let y = 0; y < TS; y++) for (let x = 0; x < TS; x++) {
    const j = y * TS + x, i = j * 3
    const n = (rnd() - 0.5) * 6
    let col = c, m
    const dy = y - TC
    if (Math.abs(dy) <= HW) {
      const rail = Math.abs(dy) >= HW - 2
      if (rail) { col = steel; m = dy < 0 ? (y === TC - HW ? 1.3 : y === TC - HW + 1 ? 0.95 : 0.55) : (y === TC + HW ? 0.5 : y === TC + HW - 1 ? 0.7 : 1.2) }
      else {
        const cb = cableAt(x, y), rung = (x & 7) < 2
        if (rung) { col = steel; m = (x & 7) === 0 ? 1.25 : 0.8 }
        else if (cb) { col = cb[0]; m = cb[1] }
        else { col = c; m = 0.22 }
      }
    } else {
      // above the tray: the slab in shadow, with hanger rods and a small conduit
      col = c; m = 0.30 + 0.10 * dust[j]
      const t = (y - 57) / 3.2
      if (Math.abs(t) <= 1) { col = steel; m = cyl(t) * 0.9; if (((x + 6) & 31) < 3) m *= 0.55 }
      else if (Math.abs(t) < 1.6) m *= 0.7
      if ((x === 12 || x === 13 || x === 44 || x === 45)) { col = steel; m = x & 1 ? 0.8 : 1.1 }
    }
    m *= 1 + 0.04 * dust[j]
    S[i] = col[0] * m + n; S[i + 1] = col[1] * m + n; S[i + 2] = col[2] * m + n * 0.9
  }
  const V = {}
  V.droop = makeVariant(S, EDGE, EDGE, (T) => {
    // a cable that has left the tray and hangs in a loop
    for (let s = 0; s <= 90; s++) {
      const u = s / 90, x = 16 + u * 30, y = 44 + Math.sin(u * Math.PI) * 13
      for (let d = -2; d <= 2; d++) { const t = d / 2.2; setPx(T, Math.round(x), Math.round(y) + d, [30, 34, 44], cyl(t) * 1.05) }
    }
    for (let x = 16; x < 46; x++) mulPx(T, x, 45, 0.6)
  })
  V.box = makeVariant(S, EDGE, EDGE, (T) => {
    const bc = mul3(c, [1.9, 1.95, 2.0])
    for (let y = 21; y <= 40; y++) for (let x = 20; x <= 43; x++) {
      const e = x === 20 || x === 43 || y === 21 || y === 40
      setPx(T, x, y, bc, e ? 0.4 : (x === 21 || y === 22) ? 1.2 : 0.98)
    }
    for (const [bx, by] of [[22, 23], [40, 23], [22, 37], [40, 37]]) rivet(T, bx, by)
    led(T, 30, 29, LED_GREEN); led(T, 34, 29, LED_AMBER)
    fillRect(T, 26, 34, 37, 36, [206, 204, 190], 0.5)
    for (let x = 20; x <= 43; x++) mulPx(T, x, 41, 0.55)
  })
  V.splice = makeVariant(S, EDGE, EDGE, (T) => {
    for (let y = TC - HW - 1; y <= TC + HW + 1; y++) for (let x = 26; x <= 37; x++) {
      const e = x === 26 || x === 37
      setPx(T, x, y, steel, e ? 0.5 : (x === 27) ? 1.3 : 1.05)
    }
    for (const [bx, by] of [[28, 18], [34, 18], [28, 41], [34, 41]]) rivet(T, bx, by)
  })
  V.scorch = makeVariant(S, EDGE, EDGE, (T) => {
    const soot = fbm(0xA1E501, [[4, 4, 1], [2, 2, 1]]), r = mulberry32(0xA1E502)
    for (let y = 6; y < 58; y++) for (let x = 6; x < 58; x++) {
      const d = hyp((x - 32) * 0.8, y - 30), k = (1 - sstep(3, 15 + 6 * soot[y * TS + x], d)) * edgeFade(x, 3, 9)
      mulPx(T, x, y, 1 - 0.6 * k)
    }
    walkCrack(r, 32, 30, 0.5, 14, 1.5, (x, y, t) => mixPx(T, x, y, [150, 190, 255], 0.3 * (1 - t)))
  })
  const base = finish(S)
  return { base, slots: weighted([[base, 4], [V.droop, 1], [V.box, 1], [V.splice, 1], [V.scorch, 1]]) }
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════════
//  Level ∅ — the block: formstone, sealed CMU, plywood, brick, black and lit windows, marble; gravel-and-weed ground.
//  Material codes keep their meaning (see level-null-map.js). Flat, photographic, unheroic: overcast, nothing glossy.
// ═════════════════════════════════════════════════════════════════════════════════════════════════════

// ── masonry layouts: a list of blocks {x0, x1, y0, y1} (x1 may pass 64: the block wraps across the tile edge) ──
function regularBlocks(h, w, running) {
  const bl = []
  for (let c = 0; c * h < TS; c++) {
    const off = running && (c & 1) ? w / 2 : 0
    for (let k = 0; k * w < TS; k++) bl.push({ x0: k * w + off, x1: (k + 1) * w + off, y0: c * h, y1: (c + 1) * h })
  }
  return bl
}
// irregular courses (formstone / ashlar): random block widths that sum to 64, each course wrapped at its own offset
function ashlarBlocks(seed, heights, wMin, wMax, alignChance) {
  const r = mulberry32(seed), bl = []
  let y = 0
  for (const h of heights) {
    const widths = []
    let sum = 0
    while (sum < TS) { let w = wMin + Math.floor(r() * (wMax - wMin + 1)); if (TS - (sum + w) < wMin) w = TS - sum; widths.push(w); sum += w }
    let x = r() < alignChance ? 0 : Math.floor(r() * TS)
    for (const w of widths) { bl.push({ x0: x, x1: x + w, y0: y, y1: y + h }); x += w }
    y += h
  }
  return bl
}
function masonryMaps(blocks) {
  const bid = new Int16Array(NT).fill(-1), lu = new Int8Array(NT), lv = new Int8Array(NT)
  blocks.forEach((b, k) => {
    for (let y = b.y0; y < b.y1; y++) for (let xx = b.x0; xx < b.x1; xx++) { const j = y * TS + (xx & TMASK); bid[j] = k; lu[j] = xx - b.x0; lv[j] = y - b.y0 }
  })
  return { bid, lu, lv }
}
// A block wall substrate. o = { base, blocks, seed, tone, warm, mortar, chip, bevel, grain, pit }.
function blockWall(o) {
  const S = newSub()
  const rnd = mulberry32(o.seed)
  const grn = fbm(o.seed + 1, [[8, 8, 1], [4, 4, 0.7], [2, 2, 0.6]])
  const low = fbm(o.seed + 2, [[16, 16, 1], [8, 8, 0.6]])
  const { bid, lu, lv } = masonryMaps(o.blocks)
  const bt = o.blocks.map(() => ({ f: 1 + (rnd() - 0.5) * 2 * o.tone, w: (rnd() - 0.5) * 2 * o.warm, s: rnd() }))
  const base = o.base
  for (let y = 0; y < TS; y++) for (let x = 0; x < TS; x++) {
    const j = y * TS + x, i = j * 3, k = bid[j]
    const n = (rnd() - 0.5) * 6
    if (k < 0) { S[i] = base[0]; S[i + 1] = base[1]; S[i + 2] = base[2]; continue }
    const b = o.blocks[k], u = lu[j], v = lv[j], W = b.x1 - b.x0, H = b.y1 - b.y0
    let r, g, bl
    if (u === 0 || v === 0) {                                          // the joint
      let mm = 0.82 + 0.3 * rnd() + 0.12 * low[j]
      if (rnd() < o.chip) mm *= 0.5                                       // chipped-out mortar: a dark gap
      r = o.mortar[0] * mm; g = o.mortar[1] * mm; bl = o.mortar[2] * mm
    } else {
      let m = bt[k].f * (1 + o.grain * grn[j]) * (1 + 0.03 * low[j])
      if (v === 1) m *= 1 + 0.16 * o.bevel; else if (v === H - 1) m *= 1 - 0.17 * o.bevel
      if (u === 1) m *= 1 + 0.09 * o.bevel; else if (u === W - 1) m *= 1 - 0.11 * o.bevel
      if (rnd() < o.pit) m *= 0.76
      const wk = bt[k].w
      r = base[0] * m * (1 + wk * 0.6); g = base[1] * m; bl = base[2] * m * (1 - wk * 0.7)
    }
    // grime gathers toward the ground, and the top few rows are shaded by the eaves
    const gr = 1 - 0.16 * sstep(40, 63, y) * (0.6 + 0.4 * low[(j + 1500) & 4095]) - 0.08 * (1 - sstep(0, 8, y))
    S[i] = r * gr + n; S[i + 1] = g * gr + n; S[i + 2] = bl * gr + n * 0.9
  }
  return { S, blocks: o.blocks }
}
// vertical soot / grime streaks from the top edge
function sootStreaks(T, seed, count, strength, tintv = [0.62, 0.6, 0.58]) {
  const r = mulberry32(seed)
  for (let k = 0; k < count; k++) {
    const x0 = 7 + Math.floor(r() * 50), len = 14 + r() * 34, wd = 1 + Math.floor(r() * 3), a = strength * (0.5 + 0.5 * r())
    for (let y = 0; y < len; y++) {
      const f = Math.pow(1 - y / len, 1.2)
      for (let dx = -wd; dx <= wd; dx++) stainPx(T, x0 + dx + Math.round(Math.sin(y * 0.2 + k) * 0.6), y, a * f * (1 - Math.abs(dx) / (wd + 1)), tintv)
    }
  }
}
function whiteBloom(T, seed, x0, y0, rx, ry, k) {                        // efflorescence: pale salt crust
  const r = mulberry32(seed), j = fbm(seed + 3, [[4, 4, 1], [2, 2, 0.8]])
  for (let y = y0 - ry; y <= y0 + ry; y++) for (let x = x0 - rx; x <= x0 + rx; x++) {
    if (x < 6 || x > 57 || y < 0 || y >= TS) continue
    const d = hyp((x - x0) / rx, (y - y0) / ry) - 0.25 * j[y * TS + x]
    if (d < 1 && r() < (1 - d) * k) mixPx(T, x, y, [222, 220, 210], 0.45)
  }
}

// ── F: formstone — cement veneer scored and coloured to fake fieldstone; block-to-block tone, chipped grout, soot ──
const FORM_MEMO = new Map()
function formstoneSet(base, seed = 0xA1400001) {
  const key = base.join(',') + ':' + seed
  let hit = FORM_MEMO.get(key)
  if (!hit) { if (FORM_MEMO.size >= 6) FORM_MEMO.clear(); hit = formstoneBuild(base, seed); FORM_MEMO.set(key, hit) }   // (wish-drifted palettes must not grow this without bound)
  return hit
}
function formstoneBuild(base, seed) {
  const blocks = ashlarBlocks(seed, [11, 12, 10, 13, 9, 9], 13, 25, 0.6)
  const { S } = blockWall({ base: desat(base, 0.12), blocks, seed, tone: 0.06, warm: 0.07, mortar: scale3(desat(base, 0.3), 0.62), chip: 0.05, bevel: 1.0, grain: 0.05, pit: 0.05 })
  const brick = [138, 74, 58]
  const V = {}
  V.soot = makeVariant(S, EDGE, 0, (T) => sootStreaks(T, 0xA1410001, 6, 0.38))
  V.spall = makeVariant(S, EDGE, 0, (T) => {
    // the veneer has let go and the brick behind shows through: a ragged patch of old brickwork
    const f = fbm(0xA1410002, [[8, 8, 1], [4, 4, 0.7]])
    const bc = accent(brick, base, 0.4), mc = scale3(desat(bc, 0.6), 1.15)
    for (let y = 8; y < 56; y++) for (let x = 8; x < 54; x++) {
      const d = hyp((x - 30) / 13, (y - 30) / 10) - 0.32 * f[y * TS + x]
      if (d >= 1.12) continue
      if (d >= 1) { mulPx(T, x, y, 1.12); continue }
      const row = y >> 3, u = (x + ((row & 1) ? 8 : 0)) & 15, v = y & 7, tone = ((row * 7 + ((x + ((row & 1) ? 8 : 0)) >> 4) * 13) & 3) * 0.05
      const joint = u === 0 || v === 0
      const g = joint ? 0.7 : 0.82 + tone + (v === 1 ? 0.1 : v === 7 ? -0.12 : 0)
      setPx(T, x, y, joint ? mc : bc, g * (d > 0.86 ? 0.75 : 1))
    }
  })
  V.toneA = makeVariant(S, EDGE, 0, (T) => retoneBlocks(T, blocks, 0xA1410003, 0.09, 0.12))
  V.toneB = makeVariant(S, EDGE, 0, (T) => { retoneBlocks(T, blocks, 0xA1410004, 0.09, 0.12); wallStain(T, { seed: 0xA1410005, cx: 30, halfW: 18, depth: 24, strength: 0.5, tint: [0.78, 0.76, 0.7] }) })
  V.patch = makeVariant(S, EDGE, 0, (T) => {
    // a ragged patch of smooth grey cement parge trowelled over a repair
    const jag = fbm(0xA1410008, [[8, 8, 1], [4, 4, 0.6]])
    const pc = mul3(desat(base, 0.3), [0.96, 0.97, 0.98])
    for (let y = 14; y < 52; y++) for (let x = 8; x < 54; x++) {
      const d = Math.max(Math.abs(x - 30) / 17, Math.abs(y - 33) / 14) - 0.34 * jag[y * TS + x]
      if (d >= 1) continue
      setPx(T, x, y, pc, (d > 0.9 ? 0.8 : 0.97) * (0.95 + ((x * 7 + y * 3) & 3) * 0.02 + 0.03 * jag[y * TS + ((x + 5) & 63)]))
    }
  })
  const b0 = finish(S)
  return { base: b0, slots: weighted([[b0, 3], [V.toneA, 1], [V.toneB, 1], [V.soot, 1], [V.spall, 1], [V.patch, 1]]) }
}

// ── B: brick — running bond, per-brick colour (clinker, soft-fired, over-burnt), pale weathered mortar ──
function brickSubstrate(base, seed, opts = {}) {
  const blocks = regularBlocks(8, 16, true)
  const mortar = mix3(desat(base, 0.7), [190, 186, 174], 0.62)
  const { S } = blockWall({ base, blocks, seed, tone: opts.tone || 0.12, warm: opts.warm || 0.15, mortar, chip: 0.03, bevel: 0.7, grain: 0.07, pit: 0.05 })
  return { S, blocks }
}
function brickSet(base, seed = 0xA1400002) {
  const { S, blocks } = brickSubstrate(base, seed)
  const V = {}
  V.soot = makeVariant(S, EDGE, 0, (T) => sootStreaks(T, 0xA1420001, 7, 0.4))
  V.spall = makeVariant(S, EDGE, 0, (T) => {
    // a few bricks whose fired face has come away: a paler, softer brick underneath, a shadowed lip at the top of the pit
    const r = mulberry32(0xA1420002)
    const inner = mul3(desat(base, 0.35), [1.18, 1.14, 1.12])
    for (let k = 0; k < 3; k++) {
      const row = 1 + Math.floor(r() * 5), col = 1 + Math.floor(r() * 2), x0 = col * 16 + (row & 1 ? 8 : 0) + 1, y0 = row * 8 + 1
      if (x0 < 6 || x0 + 14 > 58) continue
      const f = fbm(0xA1420010 + k, [[4, 4, 1], [2, 2, 0.6]])
      const pit = (x, y) => x >= x0 && x < x0 + 14 && y >= y0 && y < y0 + 7 && f[y * TS + x] > -0.55
      for (let y = y0; y < y0 + 7; y++) for (let x = x0; x < x0 + 14; x++) {
        if (!pit(x, y)) continue
        const g = 0.9 + 0.14 * (((x * 7 + y * 13) & 3) / 3) + 0.05 * f[y * TS + ((x + 3) & 63)]
        setPx(T, x, y, inner, pit(x, y - 1) ? g : g * 0.66)
      }
    }
  })
  V.toneA = makeVariant(S, EDGE, 0, (T) => retoneBlocks(T, blocks, 0xA1420003, 0.14, 0.16))
  V.toneB = makeVariant(S, EDGE, 0, (T) => retoneBlocks(T, blocks, 0xA1420004, 0.14, 0.16))
  V.stain = makeVariant(S, EDGE, 0, (T) => { wallStain(T, { seed: 0xA1420005, cx: 28, halfW: 16, depth: 30, strength: 0.6, tint: [0.72, 0.7, 0.66] }) })
  const b0 = finish(S)
  return { base: b0, slots: weighted([[b0, 3], [V.toneA, 1], [V.toneB, 1], [V.soot, 1], [V.spall, 1], [V.stain, 1]]) }
}

// ── C: CMU, a doorway sealed with block behind its old frame ──
function cmuSet(base, seed = 0xA1400003) {
  const blocks = regularBlocks(8, 16, true)
  const mortar = scale3(desat(base, 0.2), 0.66)
  const { S } = blockWall({ base, blocks, seed, tone: 0.05, warm: 0.015, mortar, chip: 0.02, bevel: 0.8, grain: 0.05, pit: 0.06 })
  // the doorway: a rectangle x 12..51, y 6..63; older blocks outside, newer (paler, cleaner) infill inside, a frame between
  const frame = mul3(desat(base, 0.5), [0.5, 0.48, 0.44])
  const infill = new Float32Array(NT)
  for (let y = 9; y < TS; y++) for (let x = 15; x < 49; x++) infill[y * TS + x] = 1
  for (let y = 0; y < TS; y++) for (let x = 0; x < TS; x++) {
    const j = y * TS + x, i = j * 3
    if (infill[j]) { S[i] *= 1.07; S[i + 1] *= 1.07; S[i + 2] *= 1.05 }
    const onFrame = (y >= 6 && y < 9 && x >= 12 && x < 52) || (y >= 6 && x >= 12 && x < 15) || (y >= 6 && x >= 49 && x < 52)
    if (onFrame) {
      const lit = x === 12 || y === 6 ? 1.25 : x === 51 || (y === 8 && x > 14 && x < 49) ? 0.62 : 1
      const g = lit * (0.9 + 0.12 * (((x * 3 + y * 7) & 3) / 3))
      S[i] = frame[0] * g; S[i + 1] = frame[1] * g; S[i + 2] = frame[2] * g
    }
  }
  // mortar squeeze-out along the inside of the frame, and the concrete threshold
  for (let y = 9; y < TS; y++) { mulPx(S, 15, y, 0.7); mulPx(S, 16, y, 1.1); mulPx(S, 48, y, 0.75) }
  for (let x = 15; x < 49; x++) { mulPx(S, x, 9, 0.7); mulPx(S, x, 10, 1.08) }
  for (let y = 60; y < TS; y++) for (let x = 10; x < 54; x++) {
    const e = y === 60 ? 1.2 : y === 61 ? 0.7 : 1
    const i = at(x, y); const c = mul3(desat(base, 0.4), [1.08, 1.06, 1.02]); S[i] = c[0] * e * 0.92; S[i + 1] = c[1] * e * 0.92; S[i + 2] = c[2] * e * 0.92
  }
  const V = {}
  V.soot = makeVariant(S, EDGE, 0, (T) => sootStreaks(T, 0xA1430001, 5, 0.3))
  V.stain = makeVariant(S, EDGE, 0, (T) => { wallStain(T, { seed: 0xA1430002, cx: 32, halfW: 20, depth: 28, strength: 0.55, tint: [0.78, 0.78, 0.74] }); whiteBloom(T, 0xA1430003, 32, 56, 20, 6, 0.4) })
  V.tone = makeVariant(S, EDGE, 0, (T) => retoneBlocks(T, blocks.filter((b) => b.x0 >= 16 && b.x1 <= 48 && b.y0 >= 10), 0xA1430004, 0.06, 0.02))
  const b0 = finish(S)
  return { base: b0, slots: weighted([[b0, 3], [V.soot, 1], [V.stain, 1], [V.tone, 1]]) }
}

// ── P: plywood board with a sprayed house number. The digit mask, its colour and its position are the legacy ones (legible
//    from the same distances); only the paint quality changes: soft overspray, thickness variation, a few runs. ──
const PLY_NUM = (x, y) => x >= TS * 0.32 && x <= TS * 0.68 && y >= TS * 0.26 && y <= TS * 0.5 &&
  (Math.floor((x - TS * 0.32) / 6) + Math.floor((y - TS * 0.26) / 8)) % 2 === 0
const inNumBox = (x, y) => x >= TS * 0.32 - 4 && x <= TS * 0.68 + 4 && y >= TS * 0.26 - 4 && y <= TS * 0.5 + 12
function plywoodSet(base, seed = 0xA1400004) {
  const S = newSub()
  const rnd = mulberry32(seed)
  const warp = fbm(seed + 1, [[16, 8, 1], [8, 4, 0.6]])
  const cloud = fbm(seed + 2, [[32, 8, 1], [16, 4, 0.8]])
  const blot = fbm(seed + 3, [[16, 16, 1], [8, 8, 0.6]])
  const paint = accent([250, 150, 40], base, 0.08)
  for (let y = 0; y < TS; y++) for (let x = 0; x < TS; x++) {
    const j = y * TS + x, i = j * 3
    // rotary-cut veneer: wandering grain lines with cathedral swirls, weathered toward grey
    const gy = y + 4.2 * warp[j] + 2.0 * cloud[j]
    let m = 0.90 + 0.05 * Math.sin(gy * 0.95) + 0.045 * Math.sin(gy * 0.31 + 1.2) + 0.05 * cloud[j] + 0.03 * blot[j]
    if (Math.abs(Math.sin(gy * 0.95)) > 0.94) m *= 0.9
    if (y === 47) m *= 0.55; else if (y === 48) m *= 1.1                 // the joint between two sheets
    if (x === 0 || x === 63) m *= 0.86
    const grey = 0.22 * sstep(-0.2, 0.6, blot[(j + 700) & 4095])
    let r = base[0] * m, g = base[1] * m, b = base[2] * m
    const l = lum([r, g, b]); r = lerpf(r, l * 1.02, grey); g = lerpf(g, l * 1.0, grey); b = lerpf(b, l * 0.98, grey)
    const n = (rnd() - 0.5) * 6
    S[i] = r + n; S[i + 1] = g + n; S[i + 2] = b + n * 0.8
  }
  // screws / nails in two rows, each with a little rust run
  const rc = accent(RUST_ABS, base, 0.3)
  for (const y of [4, 59]) for (const x of [7, 19, 31, 43, 55]) {
    rivet(S, x, y, 0.95)
    for (let d = 2; d < 2 + 5 + ((x * 3) & 3); d++) mixPx(S, x, y + (y < 32 ? d : -d + 1), rc, 0.26 * (1 - d / 9))
  }
  const stampNumber = (T, r2) => {
    for (let y = 0; y < TS; y++) for (let x = 0; x < TS; x++) {
      if (PLY_NUM(x, y)) {
        const i = at(x, y), thick = 0.93 + 0.1 * ((x * 5 + y * 11) % 5) / 4
        const gr = 0.94 + 0.06 * Math.sin((y + 4.2 * warp[y * TS + x]) * 0.95)   // the grain shows through the paint
        T[i] = paint[0] * thick * gr; T[i + 1] = paint[1] * thick * gr; T[i + 2] = paint[2] * thick * gr
      } else if (inNumBox(x, y)) {
        // overspray: a fine orange mist just outside the strokes
        let near = 0
        for (let dy = -2; dy <= 2 && !near; dy++) for (let dx = -2; dx <= 2; dx++) if (PLY_NUM(x + dx, y + dy)) { near = 1 - hyp(dx, dy) / 3; break }
        if (near > 0 && r2() < near * 0.55) mixPx(T, x, y, paint, 0.28 * near)
      }
    }
    // runs: a bead of paint sliding down from the bottom of some strokes
    for (let k = 0; k < 4; k++) {
      const cx = Math.floor(TS * 0.32 + 6 * Math.floor(r2() * 4) + 1 + r2() * 4)
      const bottomY = Math.floor(TS * 0.26 + 8 * (r2() < 0.5 ? 1 : 2))
      if (!PLY_NUM(cx, bottomY - 1) || PLY_NUM(cx, bottomY)) continue
      const len = 3 + Math.floor(r2() * 6)
      for (let d = 0; d < len; d++) mixPx(T, cx, bottomY + d, paint, 0.85 - d * 0.06)
      mixPx(T, cx, bottomY + len, paint, 0.9); mixPx(T, cx + 1, bottomY + len, paint, 0.4)
    }
  }
  stampNumber(S, mulberry32(seed + 9))
  const V = {}
  V.stain = makeVariant(S, EDGE, 0, (T) => {
    const f = fbm(0xA1440001, [[8, 8, 1], [4, 4, 0.8]])
    for (let y = 0; y < TS; y++) for (let x = 6; x < 58; x++) {
      if (inNumBox(x, y)) continue
      const k = sstep(0.05, 0.4, 0.5 - hyp((x - 20) / 24, (y - 8) / 26) + 0.4 * f[y * TS + x]) * (1 - y / 90)
      stainPx(T, x, y, k * 0.6, [0.66, 0.62, 0.56])
    }
  })
  V.weather = makeVariant(S, EDGE, 0, (T) => {
    for (let y = 0; y < TS; y++) for (let x = 4; x < 60; x++) {
      if (inNumBox(x, y)) continue
      const i = at(x, y), l = lum([T[i], T[i + 1], T[i + 2]]) * 0.9
      const a = 0.35 * edgeFade(x, 3, 8)
      T[i] += (l - T[i]) * a; T[i + 1] += (l - T[i + 1]) * a; T[i + 2] += (l * 1.03 - T[i + 2]) * a
    }
  })
  V.split = makeVariant(S, EDGE, 0, (T) => {
    const r = mulberry32(0xA1440002)
    walkCrack(r, 49, 2, 1.55, 44, 0.35, (x, y) => { if (!inNumBox(x, y)) { mulPx(T, x, y, 0.4); mulPx(T, x + 1, y, 1.16) } })
  })
  const b0 = finish(S)
  return { base: b0, slots: weighted([[b0, 3], [V.stain, 1], [V.weather, 1], [V.split, 1]]) }
}

// ── the rowhouse window openings (W: black, open; O: lit, curtained) ──
const WX0 = 10, WX1 = 53, WY0 = 9, WY1 = 52                         // the opening
function windowSurround(brickBase, seed) {
  const bs = brickSubstrate(brickBase, seed, { tone: 0.09, warm: 0.16 })
  const S = bs.S
  const stone = mix3(desat(brickBase, 0.85), [180, 176, 166], 0.7)
  // a stone lintel over the opening and a projecting sill below it, each with a lit top edge and a shadow beneath
  for (let y = 4; y < 8; y++) for (let x = 6; x < 58; x++) setPx(S, x, y, stone, (y === 4 ? 1.18 : y === 7 ? 0.7 : 0.98) * (0.94 + 0.08 * (((x * 5 + y) & 3) / 3)))
  for (let x = 6; x < 58; x++) { mulPx(S, x, 8, 0.6) }
  for (let y = 54; y < 59; y++) for (let x = 5; x < 59; x++) setPx(S, x, y, stone, (y === 54 ? 1.2 : y === 58 ? 0.62 : 1.0) * (0.94 + 0.08 * (((x * 3 + y) & 3) / 3)))
  for (let y = 59; y < 63; y++) for (let x = 6; x < 58; x++) mulPx(S, x, y, 0.6 + 0.1 * (y - 59))
  return { S, blocks: bs.blocks, stone }
}

function blackWindowSet(base, brickBase, seed = 0xA1400005) {
  const { S, blocks, stone } = windowSurround(brickBase, seed)
  const rnd = mulberry32(seed + 1)
  const wood = mix3(desat(brickBase, 0.7), [150, 142, 128], 0.5)         // weathered, flaking painted frame
  for (let y = WY0; y <= WY1; y++) for (let x = WX0; x <= WX1; x++) {
    const i = at(x, y), e = Math.min(x - WX0, y - WY0, WX1 - x, WY1 - y)
    if (e < 2) {                                                        // the frame: two texels of pale, peeling wood
      const g = (x === WX0 || y === WY0 ? 0.42 : 0.6) * (0.75 + 0.5 * rnd())
      S[i] = wood[0] * g; S[i + 1] = wood[1] * g; S[i + 2] = wood[2] * g
      continue
    }
    // the dark inside: nearly black, coldest and darkest at the top-left where the reveal shades it, a whisper lighter low down
    const v = (y - WY0) / (WY1 - WY0), u = (x - WX0) / (WX1 - WX0)
    let d = 7 + 12 * v * v + 6 * (1 - u) * v - 4 * (1 - v) * (1 - u)
    if (e === 2) d *= 0.6
    if (Math.abs(x - 41) < 1 && y > WY0 + 6) d += 3.5                 // the corner of a room, barely there
    if (y === WY0 + 8 && x > 30) d += 3                                 // a ceiling line
    const n = (rnd() - 0.5) * 2.2
    S[i] = d + n; S[i + 1] = d + n + 0.4; S[i + 2] = d * 1.16 + n + 1.4
  }
  // a sash rail that survived: a short vertical bar hanging from the top of the frame
  for (let y = WY0 + 2; y < WY0 + 16; y++) for (let x = 30; x < 33; x++) { const g = x === 30 ? 0.5 : x === 32 ? 0.3 : 0.42; setPx(S, x, y, wood, g * (0.8 + 0.4 * rnd())) }
  const V = {}
  V.soot = makeVariant(S, EDGE, 0, (T) => {
    // black scorch fanning up from the top of the opening
    const r = mulberry32(0xA1450001)
    for (let k = 0; k < 8; k++) { const x0 = 12 + Math.floor(r() * 40), len = 4 + r() * 7; for (let y = 3; y < 9; y++) for (let dx = -1; dx <= 1; dx++) stainPx(T, x0 + dx, y - Math.floor(r() * len * 0.2), 0.32 * (1 - Math.abs(dx) / 3), [0.5, 0.5, 0.5]) }
  })
  V.rag = makeVariant(S, EDGE, 0, (T) => {
    // a strip of old curtain still hanging from the top of the frame, pale against the black, its bottom edge torn
    const r = mulberry32(0xA1450002)
    const cloth = mix3(desat(brickBase, 0.9), [170, 164, 150], 0.65)
    for (let y = WY0 + 2; y < WY0 + 30; y++) {
      const t = (y - WY0 - 2) / 28, x0 = 16 + Math.round(Math.sin(y * 0.21) * 1.3), wd = 7 - Math.round(t * 3)
      if (t > 0.78 && r() < (t - 0.78) * 3.2) continue
      for (let dx = 0; dx < wd; dx++) setPx(T, x0 + dx, y, cloth, (0.55 + 0.30 * Math.sin(((dx + 0.5) / wd) * 6.28 + 0.6)) * (1 - 0.35 * t))
    }
    for (let x = 14; x < 26; x++) setPx(T, x, WY0 + 2, cloth, 0.16)                   // the rod's shadow
  })
  V.stain = makeVariant(S, EDGE, 0, (T) => {
    for (let y = 58; y < TS; y++) for (let x = 8; x < 56; x++) { const k = 0.25 * Math.exp(-((x - 30) * (x - 30)) / 300); stainPx(T, x, y, k * (0.6 + 0.4 * Math.sin(x * 0.9)), [0.6, 0.6, 0.58]) }
    for (let x = 16; x < 46; x += 6) for (let y = 59; y < 63; y++) mulPx(T, x, y, 0.85)
  })
  const b0 = finish(S)
  return { base: b0, slots: weighted([[b0, 3], [V.soot, 1], [V.rag, 1], [V.stain, 1]]) }
}

function litWindowSet(base, brickBase, seed = 0xA1400006) {
  const { S, blocks, stone } = windowSurround(brickBase, seed)
  const rnd = mulberry32(seed + 1)
  const frameC = [214, 208, 194]
  const glowTop = [255, 226, 150], glowBot = [244, 176, 96]
  const cloth = mix3(desat(brickBase, 0.4), [160, 122, 96], 0.6)           // curtain fabric
  // per-column and per-row tables: the window is painted up to four times per build
  const foldTab = new Float32Array(TS + 4), sideVig = new Float32Array(TS)
  for (let x = 0; x < TS + 4; x++) foldTab[x] = 0.78 + 0.22 * Math.sin(x * 1.55)
  for (let x = WX0; x <= WX1; x++) sideVig[x] = 0.32 * Math.pow(Math.abs((x - WX0) / (WX1 - WX0) - 0.5) * 2, 2.2)
  const rowCol = []
  for (let y = WY0; y <= WY1; y++) rowCol[y] = mix3(glowTop, glowBot, sstep(0.1, 0.95, (y - WY0) / (WY1 - WY0)))
  const paintWindow = (T, curtainL, curtainR, blinds, cl = cloth) => {
    for (let y = WY0; y <= WY1; y++) for (let x = WX0; x <= WX1; x++) {
      const i = at(x, y), e = Math.min(x - WX0, y - WY0, WX1 - x, WY1 - y)
      const v = (y - WY0) / (WY1 - WY0), u = (x - WX0) / (WX1 - WX0)
      // warm interior: brightest just below the top, a little dimmer toward the bottom and the reveal
      let c = rowCol[y], m = 1 - sideVig[x] - 0.18 * v
      // a soft lamp glow behind the sheer
      if (x > 19 && x < 53 && y > 8 && y < 40) m += 0.10 * Math.exp(-(((x - 36) * (x - 36)) / 40 + ((y - 24) * (y - 24)) / 50))
      if (blinds) { const by = (y - WY0 - 2) % 4; if (y > WY0 + 1 && y < WY0 + 24) { if (by === 0) m *= 0.55; else if (by === 1) m *= 1.06 } }
      if (curtainL && u < 0.27 + 0.02 * Math.sin(v * 4)) { const f = foldTab[x] * (0.55 + 0.4 * (1 - v)); c = cl; m = f * 0.72 + 0.22 }
      if (curtainR && u > 0.73 - 0.02 * Math.sin(v * 3 + 1)) { const f = foldTab[x + 3] * (0.55 + 0.4 * (1 - v)); c = cl; m = f * 0.72 + 0.22 }
      if ((curtainL || curtainR) && y < WY0 + 5) { c = cl; m = 0.55 + 0.1 * Math.sin(x * 1.2) }
      const n = (rnd() - 0.5) * 3
      T[i] = c[0] * m + n; T[i + 1] = c[1] * m + n; T[i + 2] = c[2] * m + n
      if (e < 2) { const g = (x === WX0 || y === WY0 ? 0.62 : 0.9) * (0.92 + 0.12 * rnd()); T[i] = frameC[0] * g; T[i + 1] = frameC[1] * g; T[i + 2] = frameC[2] * g * 0.96 }
    }
    // glazing bars: one horizontal transom and a centre mullion, and a faint diagonal sheen on the panes
    for (let x = WX0; x <= WX1; x++) for (let y = 29; y < 31; y++) { const i = at(x, y); T[i] = frameC[0] * 0.8; T[i + 1] = frameC[1] * 0.8; T[i + 2] = frameC[2] * 0.76 }
    for (let y = WY0; y <= WY1; y++) for (let x = 31; x < 33; x++) { const i = at(x, y); T[i] = frameC[0] * 0.8; T[i + 1] = frameC[1] * 0.8; T[i + 2] = frameC[2] * 0.76 }
    for (let y = WY0 + 2; y < WY1 - 1; y++) for (let x = WX0 + 2; x < WX1 - 1; x++) if (((x + y * 2) % 23) < 2) mulPx(T, x, y, 1.05)
  }
  paintWindow(S, true, true, false)
  const V = {}
  V.blinds = makeVariant(S, EDGE, 0, (T) => paintWindow(T, false, true, true))
  V.sheer = makeVariant(S, EDGE, 0, (T) => paintWindow(T, false, false, false))
  V.sage = makeVariant(S, EDGE, 0, (T) => paintWindow(T, true, true, false, mix3(cloth, [118, 130, 100], 0.65)))
  const b0 = finish(S)
  return { base: b0, slots: weighted([[b0, 3], [V.blinds, 1], [V.sheer, 1], [V.sage, 1]]) }
}

// ── M: marble stoop — pale, veined, cracked and worn ──
function marbleSet(base, seed = 0xA1400007) {
  const S = newSub()
  const rnd = mulberry32(seed)
  const cloud = fbm(seed + 1, [[16, 16, 1], [8, 8, 0.7], [4, 4, 0.4]])
  const v1 = fbm(seed + 2, [[32, 32, 1], [16, 16, 0.5]]), v2 = fbm(seed + 3, [[32, 32, 1], [16, 16, 0.4]])
  const grime = fbm(seed + 4, [[8, 4, 1], [4, 2, 0.6]])
  const vein = mul3(base, [0.70, 0.72, 0.78])
  for (let y = 0; y < TS; y++) for (let x = 0; x < TS; x++) {
    const j = y * TS + x, i = j * 3
    let m = 1 + 0.022 * cloud[j]
    // veins: thin ridges where a noise field crosses zero, plus a fainter second set
    const a = Math.abs(Math.sin(6.2832 * (x + y) / 64 + 1.7 * v1[j])), b = Math.abs(Math.sin(6.2832 * (2 * x - y) / 64 + 2.1 * v2[j] + 1.3))
    const vk = Math.max(1 - sstep(0.02, 0.13, a), 0.5 * (1 - sstep(0.02, 0.10, b)))
    // slab joints (the risers of the steps) with a lit nosing above each
    if (y === 21 || y === 42) m *= 0.62; else if (y === 20 || y === 41) m *= 1.05; else if (y === 22 || y === 43) m *= 0.9
    // wear: a darker, dirtier tread near the bottom of each slab and along the base
    const w = ((y % 21) > 15 ? 0.05 : 0) + sstep(44, 63, y) * (0.10 + 0.06 * grime[j])
    m *= 1 - w
    const n = (rnd() - 0.5) * 4
    let r = base[0] * m, g = base[1] * m, bl = base[2] * m * (1 - w * 0.4)
    r = lerpf(r, vein[0] * m, vk * 0.85); g = lerpf(g, vein[1] * m, vk * 0.85); bl = lerpf(bl, vein[2] * m, vk * 0.85)
    S[i] = r + n; S[i + 1] = g + n; S[i + 2] = bl + n
  }
  const V = {}
  const crack = (seed2, x0, y0, ang, len) => (T) => {
    const r = mulberry32(seed2)
    walkCrack(r, x0, y0, ang, len, 0.5, (x, y, t) => { if (x > EDGE + 1 && x < TS - EDGE - 2) { mulPx(T, x, y, 0.42 + 0.25 * t); mulPx(T, x + 1, y, 1.06) } })
  }
  V.crackA = makeVariant(S, EDGE, 0, crack(0xA1470001, 14, 4, 1.2, 34))
  V.crackB = makeVariant(S, EDGE, 0, (T) => { crack(0xA1470002, 46, 22, 2.0, 26)(T); crack(0xA1470003, 22, 44, 0.3, 22)(T) })
  V.stain = makeVariant(S, EDGE, 0, (T) => {
    const rc = accent(RUST_ABS, base, 0.3)
    for (let y = 8; y < 63; y++) { const x0 = 38 + Math.round(Math.sin(y * 0.15) * 1.3), a = 0.22 * (1 - y / 70); for (let dx = -2; dx <= 2; dx++) mixPx(T, x0 + dx, y, rc, a * (1 - Math.abs(dx) / 3)) }
  })
  V.tone = makeVariant(S, EDGE, 0, (T) => {
    const r = mulberry32(0xA1470004)
    for (const [y0, y1] of [[0, 20], [22, 41], [43, 63]]) { const f = 1 + (r() - 0.5) * 0.08; for (let y = y0; y <= y1; y++) for (let x = 4; x < 60; x++) mulPx(T, x, y, f, f, f * (1 + (r() - 0.5) * 0.004)) }
  })
  const b0 = finish(S)
  return { base: b0, slots: weighted([[b0, 3], [V.crackA, 1], [V.crackB, 1], [V.stain, 1], [V.tone, 1]]) }
}

// ── the ground: gravel, cracked asphalt, bare dirt, weeds ──
function gravelFloor(pal) {
  const f = hexToRgb(pal.floor)
  const S = newSub()
  const rnd = mulberry32(0xA1400008)
  const low = fbm(0xA1481, [[16, 16, 1], [8, 8, 0.7], [4, 4, 0.4]])
  const dust = fbm(0xA1482, [[8, 8, 1], [4, 4, 0.7]])
  // stones: one jittered point per ~3px cell (22x22 grid, periodic); each pixel takes the nearest stone's tone
  const G = 22, cs = TS / G
  const px = new Float32Array(G * G), py = new Float32Array(G * G), tn = new Float32Array(G * G), wm = new Float32Array(G * G)
  for (let k = 0; k < G * G; k++) {
    px[k] = ((k % G) + 0.1 + 0.8 * rnd()) * cs; py[k] = (((k / G) | 0) + 0.1 + 0.8 * rnd()) * cs
    tn[k] = 0.85 + 0.28 * rnd() + (rnd() < 0.05 ? 0.25 : 0); wm[k] = rnd()
  }
  for (let y = 0; y < TS; y++) for (let x = 0; x < TS; x++) {
    const j = y * TS + x, i = j * 3
    const gx = Math.floor(x / cs), gy = Math.floor(y / cs)
    let d1 = 1e9, d2 = 1e9, k1 = 0, bdx = 0, bdy = 0
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const cx = (gx + dx + G) % G, cy = (gy + dy + G) % G, k = cy * G + cx
      const ddx = x - (px[k] + Math.floor((gx + dx) / G) * TS), ddy = y - (py[k] + Math.floor((gy + dy) / G) * TS)
      const d = ddx * ddx + ddy * ddy
      if (d < d1) { d2 = d1; d1 = d; k1 = k; bdx = ddx; bdy = ddy } else if (d < d2) d2 = d
    }
    const edge = Math.sqrt(d2) - Math.sqrt(d1)
    let m = tn[k1] * (1 + 0.10 * low[j])
    m *= 0.66 + 0.34 * sstep(0, 1.3, edge)                              // shadowed gaps between stones
    m *= 1 + 0.07 * (-bdx - bdy) / 2.4                                  // round stones, lit from the upper left
    const dt = 0.16 * sstep(0.0, 0.6, dust[j])                          // windblown fines fill some gaps
    const w = wm[k1], n = (rnd() - 0.5) * 11
    let r = f[0] * m * (1 + 0.10 * (w - 0.5)), g = f[1] * m, b = f[2] * m * (1 - 0.12 * (w - 0.5))
    r = lerpf(r, f[0] * 1.12, dt); g = lerpf(g, f[1] * 1.1, dt); b = lerpf(b, f[2] * 1.03, dt)
    S[i] = r + n; S[i + 1] = g + n; S[i + 2] = b + n
  }
  const asphalt = mul3(f, [0.62, 0.62, 0.66])
  const V = {}
  V.asphalt = makeVariant(S, EDGE, EDGE, (T) => {
    // a raft of old asphalt: dark, fine-grained, with a crumbled edge and a crack through it
    const jag = fbm(0xA1490001, [[8, 8, 1], [4, 4, 0.8], [2, 2, 0.6]])
    const r = mulberry32(0xA1490002)
    for (let y = 4; y < 60; y++) for (let x = 4; x < 60; x++) {
      const d = hyp((x - 32) / 26, (y - 32) / 22) - 0.28 * jag[y * TS + x]
      if (d > 1.06) continue
      const fade = edgeFade(x, 3, 8) * edgeFade(y, 3, 8)
      if (d < 1) { const g = 0.86 + 0.28 * r() + 0.08 * jag[y * TS + ((x + 9) & 63)]; mixPx(T, x, y, scale3(asphalt, g), fade * (d > 0.9 ? 0.7 : 0.96)) }
      else mulPx(T, x, y, 1 - 0.3 * fade)
    }
    walkCrack(r, 12, 20, 0.5, 46, 0.7, (x, y) => { if (x > 5 && x < 58 && y > 5 && y < 58) { mulPx(T, x, y, 0.5); mulPx(T, x, y + 1, 0.82) } })
  })
  V.dirt = makeVariant(S, EDGE, EDGE, (T) => {
    const jag = fbm(0xA1490003, [[8, 8, 1], [4, 4, 0.8]]), dirt = mul3(f, [1.10, 1.03, 0.90]), rr = mulberry32(0xA1490009)
    for (let y = 5; y < 59; y++) for (let x = 5; x < 59; x++) {
      const d = hyp((x - 30) / 24, (y - 34) / 18) - 0.34 * jag[y * TS + x]
      const k = (1 - sstep(0.7, 1.0, d)) * edgeFade(x, 3, 9) * edgeFade(y, 3, 9)
      if (k > 0) mixPx(T, x, y, scale3(dirt, 0.84 + 0.10 * jag[y * TS + ((x + 4) & 63)] + 0.18 * rr()), k * 0.85)
    }
  })
  const weeds = (seed2, spots) => (T) => {
    const r = mulberry32(seed2), gc = accent([86, 98, 50], f, 0.3)
    for (const [cx, cy, n] of spots) {
      for (let k = 0; k < n; k++) {
        const a = -1.57 + (r() - 0.5) * 1.5, len = 3 + r() * 6
        walkCrack(r, cx + (r() - 0.5) * 4, cy, a, len, 0.35, (x, y, t) => mixPx(T, x, y, scale3(gc, 0.65 + 0.5 * t * r() + 0.2), 0.95 - 0.2 * t))
      }
      mixPx(T, cx, cy, [40, 34, 28], 0.6)
    }
  }
  V.weedsA = makeVariant(S, EDGE, EDGE, weeds(0xA1490004, [[22, 40, 9], [40, 26, 7]]))
  V.weedsB = makeVariant(S, EDGE, EDGE, (T) => {
    const r = mulberry32(0xA1490005)
    walkCrack(r, 8, 44, -0.3, 44, 0.7, (x, y) => { if (x > 5 && x < 58) { mulPx(T, x, y, 0.5); mulPx(T, x, y + 1, 0.85) } })
    weeds(0xA1490006, [[20, 42, 6], [34, 39, 8], [46, 34, 5]])(T)
  })
  V.curb = makeVariant(S, EDGE, EDGE, (T) => {
    // a broken slab of concrete lying in the gravel
    const cc = mul3(desat(f, 0.45), [1.22, 1.22, 1.2]), jag = fbm(0xA1490007, [[8, 8, 1], [2, 2, 0.2]])
    for (let y = 10; y < 54; y++) for (let x = 10; x < 54; x++) {
      const d = Math.max(Math.abs(x - 32) / 20, Math.abs(y - 32) / 15) - 0.07 * jag[y * TS + x]
      if (d > 1.05) continue
      const fade = edgeFade(x, 3, 8) * edgeFade(y, 3, 8)
      const e = d > 0.92 ? 0.62 : d > 0.86 ? 1.14 : 1
      if (d <= 1.0) mixPx(T, x, y, scale3(cc, e * (0.9 + 0.12 * jag[y * TS + ((x + 3) & 63)] * 0.5 + 0.06 * (((x * 7 + y) & 3) / 3))), fade * 0.95)
      else mulPx(T, x, y, 1 - 0.3 * fade)
    }
  })
  const b0 = finish(S)
  return { base: b0, slots: weighted([[b0, 4], [V.asphalt, 1], [V.dirt, 1], [V.weedsA, 1], [V.weedsB, 1], [V.curb, 1]]) }
}

// Material tiles for Level ∅, keyed by the authored code. Unknown codes fall back to the original flat tile.
const MATERIAL_STYLES = {
  F: (base) => formstoneSet(base),
  C: (base) => cmuSet(base),
  P: (base) => plywoodSet(base),
  B: (base) => brickSet(base),
  W: (base, all) => blackWindowSet(base, all.brick),
  O: (base, all) => litWindowSet(base, all.lit),
  M: (base) => marbleSet(base),
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════════
//  Registry: which surfaces each level uses, and buildTextures()
// ═════════════════════════════════════════════════════════════════════════════════════════════════════
// Each style function takes the palette and returns { base: Uint8Array, slots: Uint8Array[] }: the base tile and the weighted
// per-cell pick list (repeats of `base` make plain cells more likely). The tables are the vocabulary of `config.look`.
// a flat, faintly noisy tile (surfaces that are never seen, e.g. the ceiling under an open sky)
function flatTile(rgb, seed) {
  const T = new Float32Array(NT * 3), rnd = mulberry32(seed)
  for (let j = 0; j < NT; j++) { const n = (rnd() - 0.5) * 4; T[j * 3] = rgb[0] + n; T[j * 3 + 1] = rgb[1] + n; T[j * 3 + 2] = rgb[2] + n }
  const b = finish(T)
  return { base: b, slots: null }
}
const WALL_STYLES = {
  wallpaper: lobbyWall,
  concrete: cinderWall,
  cinder: cinderWall,
  rust: rustWall,
  metal: metalWall,
  formstone: (pal) => formstoneSet(hexToRgb(pal.wall)),
}
const FLOOR_STYLES = {
  carpet: lobbyFloor,
  concrete: slabFloor,
  plate: wetFloor,
  wet: wetFloor,
  grate: deckFloor,
  deck: deckFloor,
  gravel: gravelFloor,
}
const CEIL_STYLES = {
  tiles: lobbyCeil,
  dirty: dirtyCeil,
  pipes: pipeCeil,
  trays: trayCeil,
  ducts: pipeCeil,
  open: (pal) => flatTile(hexToRgb(pal.ceiling), 0xA1500001),      // open sky: the ceiling is never drawn
}
const LIGHT_STYLES = {
  fluorescent: () => fluorescentPanel(),
  grimy: () => fluorescentPanel([244, 246, 222], 1),
}
// Per-level defaults. `look.wall|floor|ceil|light` (config.look) override any entry; an entry that is absent or unknown leaves
// that surface on the original single-tile art. Level ∅ additionally builds its authored material tiles and ground.
const LEVEL_SURFACES = {
  '0': { wall: 'wallpaper', floor: 'carpet', ceil: 'tiles', light: 'fluorescent' },
  '1': { wall: 'concrete', floor: 'concrete', ceil: 'dirty', light: 'grimy' },
  '2': { wall: 'rust', floor: 'plate', ceil: 'pipes', light: 'grimy' },
  '3': { wall: 'metal', floor: 'grate', ceil: 'trays', light: 'grimy' },
  '∅': { wall: 'formstone', floor: 'gravel', ceil: 'open', light: 'grimy', materials: true },
}

function resolveSurfaces(levelKey, look) {
  const base = LEVEL_SURFACES[levelKey] || null
  const pick = (table, want, dflt) => (want && table[want] ? want : (dflt && table[dflt] ? dflt : null))
  const s = {
    wall:  pick(WALL_STYLES,  look && look.wall,  base && base.wall),
    floor: pick(FLOOR_STYLES, look && look.floor, base && base.floor),
    ceil:  pick(CEIL_STYLES,  look && look.ceil,  base && base.ceil),
    light: pick(LIGHT_STYLES, look && look.light, base && base.light),
    materials: !!(base && base.materials),
  }
  return s.wall || s.floor || s.ceil || s.light || s.materials ? s : null
}

// Build the surfaces of a TexSet: wall (material '0') + optional per-material tiles, ceiling, floor and the light panel, each as
// a flat Uint8 RGB array of length ts*ts*3, plus the variant lists.
export function buildTextures(palette, materials = null, look = null, levelKey = 'legacy') {
  const surf = resolveSurfaces(levelKey, look)
  if (!surf) return buildLegacyTextures(palette, materials, look)      // legacy / hand-built configs: byte-identical to before
  // the original tiles, only for a surface that has no style (a partial `look` on a hand-built config)
  const legacy = surf.wall && surf.floor && surf.ceil && surf.light ? null : buildLegacyTextures(palette, null, look)
  const tex = { ts: TS, tmask: TMASK, walls: {}, ceil: null, floor: null, light: null, look, wallVar: null, ceilVar: null, floorVar: null }
  if (surf.wall) { const s = WALL_STYLES[surf.wall](palette); tex.walls['0'] = s.base; tex.wallVar = { '0': s.slots } } else tex.walls['0'] = legacy.walls['0']
  if (surf.floor) { const s = FLOOR_STYLES[surf.floor](palette); tex.floor = s.base; tex.floorVar = s.slots } else tex.floor = legacy.floor
  if (surf.ceil) { const s = CEIL_STYLES[surf.ceil](palette); tex.ceil = s.base; tex.ceilVar = s.slots } else tex.ceil = legacy.ceil
  if (!surf.light) tex.light = legacy.light
  if (surf.light) tex.light = LIGHT_STYLES[surf.light](palette)
  if (materials) for (const ch of Object.keys(materials)) if (!surf.materials || !MATERIAL_STYLES[ch]) {
    tex.walls[ch] = buildWallTile(hexToRgb(materials[ch] || palette.wall), ch, mulberry32(0x5EED0000 ^ ch.charCodeAt(0)))   // no style for this code: the original flat tile
  }
  if (surf.materials && materials) {                                    // Level ∅: the authored material codes
    const all = { brick: hexToRgb(materials.B || palette.wall), lit: hexToRgb(materials.O || palette.wall) }
    for (const ch of Object.keys(materials)) {
      const style = MATERIAL_STYLES[ch]
      if (!style) continue
      const s = style(hexToRgb(materials[ch] || palette.wall), all)
      tex.walls[ch] = s.base
      tex.wallVar = tex.wallVar || {}
      tex.wallVar[ch] = s.slots
    }
  }
  return tex
}

// buildTextures, memoised by (levelKey, palette, materials, look) in a small bounded map: a TexSet is read-only (the stages
// only sample it; mip chains are cached per tile identity), so the title attract, the game and a revisited level share one
// build instead of paying 30-110 ms (several hundred on a Chromebook) each. The key is the inputs' content, so a
// wish-drifted palette gets its own entry; the map is cleared when it fills (wishes must not grow it without bound).
const TEX_MEMO = new Map()
const TEX_MEMO_CAP = 6
export function buildTexturesMemo(palette, materials = null, look = null, levelKey = 'legacy') {
  let key = null
  try { key = levelKey + '|' + JSON.stringify([palette, materials, look]) } catch (e) { key = null }
  if (key === null) return buildTextures(palette, materials, look, levelKey)
  let hit = TEX_MEMO.get(key)
  if (hit === undefined) {
    hit = buildTextures(palette, materials, look, levelKey)
    if (TEX_MEMO.size >= TEX_MEMO_CAP) TEX_MEMO.clear()
    TEX_MEMO.set(key, hit)
  }
  return hit
}
export function texturesMemoSize() { return TEX_MEMO.size }
export function clearTexturesMemo() { TEX_MEMO.clear() }

// A tileable grayscale noise canvas for animated film grain.
export function buildGrain() {
  const N = 128
  const c = document.createElement('canvas')
  c.width = N; c.height = N
  const g = c.getContext('2d')
  const img = g.createImageData(N, N)
  const rnd = mulberry32(0x51CE)
  for (let i = 0; i < N * N; i++) {
    const v = (rnd() * 255) | 0
    img.data[i * 4] = v; img.data[i * 4 + 1] = v; img.data[i * 4 + 2] = v
    img.data[i * 4 + 3] = 255
  }
  g.putImageData(img, 0, 0)
  return c
}
