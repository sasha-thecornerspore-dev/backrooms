// gfx-sky.js — the open-sky rows of outdoor levels (Level ∅). renderSky(fs, buf32) fills rows 0..HH of the
// low-res world buffer; the world pass (gfx-world.js) skips those rows afterwards. Kept in its own module so the
// sky (clouds, haze, horizon) can grow without touching the floor/wall passes. No DOM: import-safe in Node.
//
// Two looks, chosen by the quality tier (fs.quality.lightDetail):
//   legacy  (tier `legacy`, or a bare fs with no quality field): the steady vertical gradient from the sky colour at the
//           top to the fog colour at the horizon, times the flicker scalar. Pixel-identical to the pre-overhaul renderer.
//   overcast (every other tier): a flat, photographic overcast — a soft procedural cloud layer mapped by VIEW ANGLE (so it
//           pans as the player turns, like a real sky, and drifts slowly with fs.t), tonal stratification, and a pale haze
//           that melts into the fog colour at the horizon so distant walls never cut a hard line against it. NO sun, NO
//           skyline, nothing bright and nothing that reads as a shape: Level ∅ is a photograph of a real place.
//
// How it stays cheap (the sky is ~a third of every Level ∅ frame): the cloud field is baked ONCE into a small polar strip
// (CLOUD_W azimuth texels × CLOUD_H depth rows: the noise sampled on a flat cloud deck seen from below — the deck's
// perspective is baked into the rows, so a screen row is a single strip row). Per frame the work is table lookups: one
// azimuth index per column (a linear ramp, no trig), one strip row per screen row, a fixed-point lerp in azimuth, and
// three multiply-adds. Colours are computed per 2x2 block (clouds are soft and the buffer is bilinear-upscaled after).
// The strip depends on constants only (a fixed seed): every player sees the same sky.
import { hash2 } from './gfx-util.js'

export const CLOUD_W = 1024                // azimuth texels around the full circle (power of two: masked, not modded)
export const CLOUD_H = 96                  // depth rows, horizon → top of the visible sky
const CMASK = CLOUD_W - 1
const CLOUD_SEED = 0x2c10d5
const S_MAX = 0.62                         // tan(elevation) covered by the top strip row (the view reaches ~0.45)
const S0 = 0.10                            // haze offset: the deck never quite reaches infinity at the horizon
const FREQ = 1.15                          // cloud size: noise units per cloud-deck unit
const ANISO = 0.62                         // the deck's noise is stretched along one axis: stratus streets, not popcorn

// ── seeded value noise on an integer lattice (no PRNG stream: same everywhere, order-independent) ──
function lat(ix, iy) { return hash2(ix, iy, CLOUD_SEED) * (1 / 4294967296) }
export function noise2(x, y) {
  const ix = Math.floor(x), iy = Math.floor(y)
  const fx = x - ix, fy = y - iy
  const u = fx * fx * fx * (fx * (fx * 6 - 15) + 10)             // quintic fade: no grid creases in the soft clouds
  const v = fy * fy * fy * (fy * (fy * 6 - 15) + 10)
  const a = lat(ix, iy), b = lat(ix + 1, iy), c = lat(ix, iy + 1), d = lat(ix + 1, iy + 1)
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v
}

// Fractal cloud density in ~[0,1] at a point of the cloud deck. `octaveMask` (0..1 per octave) lets the strip builder
// fade octaves that would alias at that depth (the deck compresses toward the horizon).
const OCTAVES = 5
export function cloudDensity(x, y, octaveFade) {
  let amp = 0.5, f = 1, sum = 0, norm = 0
  for (let o = 0; o < OCTAVES; o++) {
    const w = octaveFade ? octaveFade[o] : 1
    sum += amp * w * noise2(x * f + o * 17.31, y * f + o * 9.17)
    norm += amp * w
    amp *= 0.5; f *= 2.03
  }
  return norm > 0 ? sum / norm : 0.5
}

function smoothstep(a, b, x) { const t = x <= a ? 0 : x >= b ? 1 : (x - a) / (b - a); return t * t * (3 - 2 * t) }

// The tan(elevation) a strip row stands for, and the deck distance there (deck height = 1).
export function stripRowTan(j) { return ((j + 0.5) / CLOUD_H) * S_MAX }
export function stripRowDepth(j) { return 1 / (stripRowTan(j) + S0) }

let STRIP = null
// The cloud strip: CLOUD_H rows (row 0 nearest the horizon) × CLOUD_W azimuth texels, 0..255 density (255 = thick cloud).
// Deterministic. Built lazily on first use and shared by every renderer (it is immutable).
export function buildCloudStrip() {
  const strip = new Uint8Array(CLOUD_W * CLOUD_H)
  const fade = new Float64Array(OCTAVES)
  const TAU = Math.PI * 2
  for (let j = 0; j < CLOUD_H; j++) {
    const d = stripRowDepth(j)
    // octave anti-aliasing: skip detail finer than ~3 azimuth texels or ~3 strip rows at this depth
    const circ = TAU * d * FREQ                                   // deck units around the circle at this depth
    const rowStep = FREQ * d * d * (S_MAX / CLOUD_H)              // deck units between adjacent strip rows
    let f = 1
    for (let o = 0; o < OCTAVES; o++, f *= 2.03) {
      const texPer = Math.min(CLOUD_W / (circ * f), 1 / (f * rowStep))
      fade[o] = smoothstep(2.2, 6, texPer)
    }
    for (let i = 0; i < CLOUD_W; i++) {
      const th = (i / CLOUD_W) * TAU
      const X = d * Math.cos(th) * FREQ * ANISO, Y = d * Math.sin(th) * FREQ
      const n = cloudDensity(X + 3.7, Y + 1.9, fade)
      // soft cover shaping: mostly mid-grey mottling with broad thick and thin regions, no hard edges
      const dn = smoothstep(0.24, 0.78, n)
      strip[j * CLOUD_W + i] = (dn * 255 + 0.5) | 0
    }
  }
  return strip
}
export function cloudStrip() { return STRIP || (STRIP = buildCloudStrip()) }

// ── per-level sky settings (Level ∅ is the only outdoor level today; `default` covers any future one) ──
// amp     peak brightness swing of the cloud layer (fraction; 0.10 = ±10% of the base sky at the strongest)
// ampB    the second, finer, opposite-drifting layer as a fraction of amp
// drift   rad/s the cloud layer turns about the player (slow: a screen width in a few minutes)
// haze    how far up from the horizon the fog-colour haze reaches (fraction of the sky height)
// glow    peak extra brightness of the pale band above the horizon (fraction)
// band    faint horizontal stratification (fraction)
export const LEVEL_SKY = {
  '∅': { amp: 0.1, ampB: 0.42, drift: 0.0042, haze: 0.62, glow: 0.055, band: 0.028 },
  default: { amp: 0.09, ampB: 0.4, drift: 0.004, haze: 0.6, glow: 0.04, band: 0.02 },
}
export function skyConfigFor(fs) {
  const base = LEVEL_SKY[fs.levelKey] || LEVEL_SKY.default
  const o = fs.look && fs.look.sky
  return o && typeof o === 'object' ? { ...base, ...o } : base
}

// The clear-sky colour at a row: sky at the top, blended into the fog colour toward the horizon (`q` = 0 at the horizon,
// 1 at the top of the sky), with a pale glow band above the horizon. Pure: returns [r, g, b] floats (before the flicker
// multiplier). Exposed for tests.
export function skyBase(q, sky, fog, cfg, out = [0, 0, 0]) {
  const t = 1 - q                                                    // 0 top → 1 horizon
  const m = Math.pow(t, 1.35)                                        // stay sky-coloured longer, then haze into the fog
  const hazeK = smoothstep(1 - cfg.haze, 1, t) * 0.5                 // extra pull toward fog inside the haze zone
  const w = Math.min(1, m + hazeK * (1 - m))
  const bump = Math.exp(-(((t - 0.8) / 0.11) ** 2)) * (1 - smoothstep(0.9, 1, t))   // the pale band, gone at t=1 so the horizon IS the fog
  const g = 1 + cfg.glow * bump
  out[0] = (sky[0] * (1 - w) + fog[0] * w) * g
  out[1] = (sky[1] * (1 - w) + fog[1] * w) * g
  out[2] = (sky[2] * (1 - w) + fog[2] * w) * g
  return out
}

// ── scratch (grow-only): the sky is filled every frame, these just avoid allocating ──
let S = { W: 0, HH: 0, col0: null, col1: null, colF: null, cb0: null, cb1: null, cbF: null, rowJ: null, rowJ2: null, rowR: null, rowG: null, rowB: null, rowA: null }
function scratch(W, HH) {
  if (S.W >= W && S.HH >= HH) return S
  const cw = Math.max(S.W, W) + 2, rh = Math.max(S.HH, HH) + 2
  S = {
    W: cw, HH: rh,
    col0: new Int32Array(cw), col1: new Int32Array(cw), colF: new Int32Array(cw),
    cb0: new Int32Array(cw), cb1: new Int32Array(cw), cbF: new Int32Array(cw),
    rowJ: new Int32Array(rh), rowJ2: new Int32Array(rh),
    rowR: new Float32Array(rh), rowG: new Float32Array(rh), rowB: new Float32Array(rh), rowA: new Float32Array(rh),
  }
  return S
}

function renderSkyLegacy(fs, buf32) {
  const { W, H, HH, skyRgb, fogRgb, flicker } = fs
  const F0 = fogRgb[0], F1 = fogRgb[1], F2 = fogRgb[2]
  const last = Math.min(HH, H - 1)
  for (let y = 0; y <= last; y++) {
    const t = HH > 0 ? y / HH : 1                 // 0 top → 1 horizon
    const sr = (skyRgb[0] * (1 - t) + F0 * t) * flicker
    const sg = (skyRgb[1] * (1 - t) + F1 * t) * flicker
    const sb = (skyRgb[2] * (1 - t) + F2 * t) * flicker
    const packed = (255 << 24)
      | ((sb > 255 ? 255 : sb) | 0) << 16
      | ((sg > 255 ? 255 : sg) | 0) << 8
      | ((sr > 255 ? 255 : sr) | 0)
    const rowOff = y * W
    buf32.fill(packed, rowOff, rowOff + W)
  }
}

// does c * e stay inside (-1, 256) for every e in [e0, e1]? (a product is monotonic in each operand, so the ends decide)
function inByte(c, e0, e1) { const lo = c * e0, hi = c * e1; return (lo < hi ? lo : hi) > -1 && (lo < hi ? hi : lo) < 256 }

const TAU = Math.PI * 2
const FIX = 256                                   // azimuth lerp fraction bits (8)

// nlo (optional, from the world pass): when given, a sky pixel (x, y) above the horizon row is covered by a wall exactly when -y < nlo[x]
// (gfx-world.js castColumns, its one-sided form), and a 2x2 block whose four pixels are all covered is not computed at all: the wall pass
// overwrites every one of them, so the frame is the same to the byte.
export function renderSky(fs, buf32, nlo = null) {
  if (!(fs.quality && fs.quality.lightDetail > 0)) { renderSkyLegacy(fs, buf32); return }
  const { W, H, HH, skyRgb, fogRgb } = fs
  const last = Math.min(HH, H - 1)
  if (last < 0) return
  const cfg = skyConfigFor(fs)
  // daylight is not a fluorescent tube: the flicker scalar only dims the sky in the legacy shading model, where the rest of
  // the frame is dimmed by it too (so the horizon still matches the fog fill below it)
  const k = fs.light && fs.light.enabled ? 1 : (fs.flicker == null ? 1 : fs.flicker)
  const t = fs.t || 0
  const hf = fs.hf || 0.6545
  const angle = fs.player ? fs.player.angle : 0
  const strip = cloudStrip()
  const s = scratch(W, HH)
  const { col0, col1, colF, cb0, cb1, cbF, rowJ, rowJ2, rowR, rowG, rowB, rowA } = s

  // ── per-column azimuth indices (fixed point, incl. the slow drift) for both layers ──
  // The raycaster maps column c to angle = player.angle - hf + c/W * fov (linear in c), so the azimuth is a ramp.
  const fov = hf * 2
  const ppr = CLOUD_W / TAU                                       // texels per radian
  // (angles are reduced mod 2π first: an unbounded player angle must not overflow the fixed-point index)
  const wrap = (v) => v - Math.floor(v / TAU) * TAU
  const uA0 = wrap(angle - hf - t * cfg.drift) * ppr * FIX
  const uB0 = wrap(angle - hf + t * cfg.drift * 0.7) * ppr * 3 * FIX + 211 * FIX   // layer B: 3x finer in azimuth, drifting the other way
  const du = (fov / W) * ppr * FIX                                // per column
  const Wh = (W + 1) >> 1
  for (let i = 0; i < Wh; i++) {
    const c = 2 * i + 0.5
    const a = Math.floor(uA0 + du * c), b = Math.floor(uB0 + du * 3 * c)
    col0[i] = (a >> 8) & CMASK; col1[i] = ((a >> 8) + 1) & CMASK; colF[i] = a & 255
    cb0[i] = (b >> 8) & CMASK;  cb1[i] = ((b >> 8) + 1) & CMASK;  cbF[i] = b & 255
  }

  // ── per-row: strip row, base colour, cloud amplitude ──
  const focal = (W * 0.5) / Math.tan(hf)                          // pixels from the eye to the screen plane
  const baseTmp = [0, 0, 0]
  const invHH = HH > 0 ? 1 / HH : 1
  for (let y = 0; y <= last; y++) {
    const e = HH - y                                              // rows above the horizon
    const q = Math.min(1, Math.max(0, e * invHH))
    skyBase(q, skyRgb, fogRgb, cfg, baseTmp)
    let j = ((e / focal) / S_MAX * CLOUD_H) | 0                   // tan(elev) → strip row
    if (j < 0) j = 0; else if (j >= CLOUD_H) j = CLOUD_H - 1
    rowJ[y] = j * CLOUD_W
    let jb = (j * 2 + 37) % (2 * CLOUD_H)                         // layer B reads a different, 2x finer depth so it is not a copy of A;
    if (jb >= CLOUD_H) jb = 2 * CLOUD_H - 1 - jb                  // mirrored at the ends so adjacent rows stay continuous
    rowJ2[y] = jb * CLOUD_W
    // clouds fade into the haze near the horizon; stratification bands are a slow function of the row
    const fade = smoothstep(0.04, 0.5, q)
    const bandV = (noise2(j * 0.31, 7.7) - 0.5) * 2 * cfg.band * fade
    const m = 1 + bandV
    rowR[y] = baseTmp[0] * m * k; rowG[y] = baseTmp[1] * m * k; rowB[y] = baseTmp[2] * m * k
    rowA[y] = cfg.amp * fade
  }

  // ── fill: rows in pairs, columns in pairs (a 2x2 block per evaluation). Walking up from the horizon row, so the horizon row itself is
  // always evaluated (it must equal the fog fill below it exactly) and the row above it is the copy. ──
  const ampB = cfg.ampB
  // the cloud term's range: d0 and d1 are lerps of strip bytes (0..255), and every operation below is monotonic in each operand, so the
  // same arithmetic on the corners bounds every block's value (the per-row test below then knows no channel can leave a byte)
  const tA = 128 + ampB * 128, tB = -127 + ampB * -127, tC = 128 + ampB * -127, tD = -127 + ampB * 128
  const tMax = Math.max(tA, tB, tC, tD), tMin = Math.min(tA, tB, tC, tD)
  const Wp = W >> 1                                                  // blocks whose right pixel is inside the row
  for (let y = last; y >= 0; y -= 2) {
    const rowOff = y * W
    const jA = rowJ[y], jB = rowJ2[y]
    const r0 = rowR[y], g0 = rowG[y], b0 = rowB[y], A = rowA[y]
    const skip = nlo !== null && y >= 1 && y < HH, k1 = 1 - y          // the pair's upper row y-1 covered (so y is too): k1 < nlo[x]
    const K = A * (1 / 128)
    const s0 = tMin * K, s1 = tMax * K, e0 = 1 + (s0 < s1 ? s0 : s1), e1 = 1 + (s0 < s1 ? s1 : s0)
    // no clamp when every channel stays inside (-1, 256): there `v | 0` is already what the clamp would give
    const free = inByte(r0, e0, e1) && inByte(g0, e0, e1) && inByte(b0, e0, e1)
    for (let i = 0; i < Wh; i++) {
      if (skip && k1 < nlo[2 * i] && (2 * i + 1 >= W || k1 < nlo[2 * i + 1])) continue
      const a0 = strip[jA + col0[i]], a1 = strip[jA + col1[i]]
      const d0 = a0 + (((a1 - a0) * colF[i]) >> 8)
      const c0 = strip[jB + cb0[i]], c1 = strip[jB + cb1[i]]
      const d1 = c0 + (((c1 - c0) * cbF[i]) >> 8)
      // thick cloud (dense) darkens the sky, thin cloud lets it through; both layers swing about their mean
      const sh = ((128 - d0) + ampB * (128 - d1)) * K
      const r = r0 * (1 + sh), g = g0 * (1 + sh), b = b0 * (1 + sh)
      const px = free
        ? (255 << 24) | (b | 0) << 16 | (g | 0) << 8 | (r | 0)
        : (255 << 24)
          | ((b > 255 ? 255 : b < 0 ? 0 : b) | 0) << 16
          | ((g > 255 ? 255 : g < 0 ? 0 : g) | 0) << 8
          | ((r > 255 ? 255 : r < 0 ? 0 : r) | 0)
      const x = 2 * i
      buf32[rowOff + x] = px
      if (i < Wp) buf32[rowOff + x + 1] = px
    }
    if (y >= 1) buf32.copyWithin(rowOff - W, rowOff, rowOff + W)
  }
}
