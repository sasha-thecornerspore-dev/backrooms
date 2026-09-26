// gfx-light.js — the light model. This file is the CONTRACT between the world pass (which shades floor, ceiling and
// walls with it), the sprite pass (which lights sprites with it) and the post pass (which blooms it). Pure data + math:
// import-safe in Node, unit-testable.
//
//   createLight(config, worldHooks) -> light      (worldHooks.materialAt lets fixed maps declare emitters, e.g. Level ∅ lit windows)
//
//   light.enabled                    false ⇒ stages must use the legacy shading; true ⇒ the model is live THIS FRAME. It is a per-frame
//                                    flag: renderWorld() calls light.prepare(fs, …) which sets it from fs.quality.lightDetail
//                                    (0 = legacy tier ⇒ false, so a legacy-tier frame is untouched) and from whether the level has a
//                                    lighting recipe at all (a hand-built config with no level identity has none ⇒ always false).
//   light.at(wx, wy)                 illumination multiplier at a world point on the floor plane; 1 = neutral, ~0.35 in the dark
//                                    between fixtures, ~1.25 under one. Includes the live panel flicker and the player's own lights
//                                    (flashlight / glowstick) of the current frame. Sprites use this to light themselves.
//   light.tint(wx, wy)               [r, g, b] colour multiplier (1,1,1 = none); warm/cold fixture colour, pulled toward the glowstick
//                                    colour near the player while one burns.
//   light.nearest(wx, wy)            { x, y, dist, r, g, b } of the nearest emitter (r,g,b = its colour, 0..255), or null — for
//                                    rim-light direction. Panels: the nearest lattice panel; lamps: the nearest lamp; Level ∅: the nearest
//                                    lit window.
//   light.panelLevel(cx, cy, fs)     0..1 brightness of the ceiling panel in even cell (cx, cy) right now (1 = steady). Spatial
//                                    flicker: only nearby panels gutter, driven by fs.rawFlicker (the game's event intensity), each panel
//                                    independently (hash noise × fs.t); the "lights-cascade" event reads as panels going out AHEAD of the
//                                    player first. Pure in (cx, cy, fs): the same inputs give the same level. For a lamp level it is the
//                                    lamp's level when a lamp stands in that cell, else 1. For the fs last handed to prepare() it returns
//                                    the level the world pass drew this frame (gated and smoothed); for any other fs, the raw scalar's.
//   light.prepare(fs, tex, isWallFn, materialAt)   (the world pass's per-frame setup; sets `enabled`; returns it)
//   light.frame                      the per-frame parameter block the world pass reads (tables, tint, dip, windows) — private to
//                                    gfx-world.js; other stages use the four query functions above.
//
// Fixtures follow config.look.lighting ({ mode: 'panels' | 'lamps' | 'daylight', every, color, warmth, pool, ambient, … }, all
// optional, merged over LEVEL_LIGHTING[levelKey]); the drop-ceiling panel grid (a panel on every cell whose x and y are both even,
// period 2) is what levels with lights:true have. Emitters derive from the cell address (hash2), never Math.random, so every
// client sees the same light.
//
// TIERS (fs.quality.lightDetail): 0 = legacy shading, the light stays disabled. 1 = pools + contact shading + lit fog, lamps and lit
// windows with real shadows, and spatial flicker on the ceiling panels and the walls (the floors take the bounded global dip).
// 2 = also the flashlight and glowstick per pixel (fs.handled.flashlight / .glow are set so the post pass does not draw its gradient
// on top), and the flicker reaches the floor pools and the lamps' light.
//
// FLICKER (photosensitivity): with the model on the world buffer is NOT multiplied by the game's flicker scalar (the world pass
// sets fs.handled.flicker so the post pass need not black the frame out either). The scalar's dips (e = 1 - rawFlicker, less the
// game's steady 0.92..1 wander) are re-expressed spatially — each panel / lamp dims on its own — and shaped so that nothing can
// flash faster than WCAG 2.3.1 allows however the game's state machine behaves: a dwell gate lets the event level change at most
// ~1.3 times a second, a low-pass (fast attack, slower release) shapes the edges, each dimmed emitter flutters at ~1 Hz, and the
// whole-frame ambient dip is bounded at AMBIENT_DIP_MAX (< 0.5) and shrinks with the comfort preference (reduceFlicker).
import { hash2, hash2Legacy, levelKey } from './gfx-util.js'

const NO_TINT = Object.freeze([1, 1, 1])

export const PERIOD = 2                      // the panel lattice period, in world units (a panel on every cell with x and y both even)
export const TILE_N = 64                     // samples per period along each axis  (=> 32 samples per world unit)
export const TILE_PER_UNIT = TILE_N / PERIOD
export const AMBIENT_DIP_MAX = 0.34          // the largest whole-frame dip the model itself ever applies (fraction of the ambient)

// ── per-level lighting recipes ───────────────────────────────────────────────────────────────────────────────────────────────
// mode      'panels' the drop-ceiling lattice · 'lamps' sparse emergency fixtures · 'daylight' soft even ambient (+ warm window spill)
// color     the fixture colour [r,g,b] 0..255 (what pools are tinted with, what the panel/lamp texels glow)
// ambientColor  the colour of the dark between fixtures (defaults to the fixture colour, desaturated)
// ambient   illumination in the dark between fixtures (1 = as lit as the legacy shading)
// peak      illumination directly under a fixture; pool = how much of (peak - ambient) is used (0 = no pools at all)
// radius    pool radius in world units (panels: < 2 so pools never merge into a flat wash; lamps: the reach of one lamp)
// contact   strength of the contact shading where a surface meets another (0..1)
// every     lamps: about one lamp per `every` open cells
// fogGain   multiplier on the fog colour in the lit path (the legacy fog is the light; a darker room fogs darker)
// fogBase   the share of the fog colour present in the dark between fixtures; the rest glows only where the light is (lit fog)
// fogGlow   how strongly a pool of light brightens the fog over it (in-scattering; >1 for small hot lamps)
// ceilAmbient  illumination of the ceiling in the dark between fixtures
// warmth    -1 cold .. +1 warm: shifts both colours along the orange/blue axis
// windows   (daylight) { color, radius, strength }: lit 'O' windows spill light onto the ground in front of them
export const LEVEL_LIGHTING = Object.freeze({
  '0': Object.freeze({ mode: 'panels', color: [248, 255, 208], ambientColor: [236, 246, 198], ambient: 0.5, peak: 1.32, pool: 1, radius: 1.35, contact: 0.5, fogGain: 0.95, fogBase: 0.5, fogGlow: 1, ceilAmbient: 0.3, warmth: 0 }),
  '1': Object.freeze({ mode: 'panels', color: [212, 255, 204], ambientColor: [206, 240, 200], ambient: 0.42, peak: 1.25, pool: 1, radius: 1.3, contact: 0.55, fogGain: 0.95, fogBase: 0.5, fogGlow: 1, ceilAmbient: 0.26, warmth: 0 }),
  // Levels 2 and 3 keep 'real dark between the lamps', but not black: the ambient is a visibility FLOOR (roughly 40-65% of the legacy
  // shading), enough that walls, floor and ceiling still read their shapes with the flashlight off (p95 luma ~26-31/255 in a lamp-free
  // stretch; the whole frame stays a little under the legacy look). The pools' peak was lowered with it so a lit place is never brighter
  // than the original renderer's.
  '2': Object.freeze({ mode: 'lamps', color: [255, 150, 62], ambientColor: [134, 118, 100], ambient: 0.38, peak: 1.6, pool: 1, radius: 4.4, every: 8, contact: 0.6, fogGain: 1, fogBase: 0.34, fogGlow: 2.2, ceilAmbient: 0.18, warmth: 0.2 }),
  '3': Object.freeze({ mode: 'lamps', color: [166, 202, 255], ambientColor: [104, 118, 148], ambient: 0.66, peak: 1.62, pool: 1, radius: 4.8, every: 9, contact: 0.6, fogGain: 1, fogBase: 0.34, fogGlow: 2.2, ceilAmbient: 0.3, warmth: -0.2 }),
  '∅': Object.freeze({ mode: 'daylight', color: [255, 196, 120], ambientColor: [250, 250, 246], ambient: 0.94, peak: 0.94, pool: 0, radius: 1, contact: 0.5, fogGain: 1, fogBase: 1, fogGlow: 0, ceilAmbient: 0.94, warmth: 0,
                       windows: Object.freeze({ color: [255, 190, 110], radius: 3.4, strength: 0.75 }) }),
})

const DEFAULT_RECIPE = Object.freeze({ mode: 'panels', color: [255, 247, 196], ambientColor: null, ambient: 0.44, peak: 1.3, pool: 1, radius: 1.5, every: 8, contact: 0.5, fogGain: 1, fogBase: 0.5, fogGlow: 1, ceilAmbient: null, warmth: 0 })

function parseColor(c, fallback) {
  if (Array.isArray(c) && c.length >= 3) return [c[0] | 0, c[1] | 0, c[2] | 0]
  if (typeof c === 'string') {
    const n = parseInt(c.replace('#', ''), 16)
    if (Number.isFinite(n)) return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
  }
  return fallback
}
// a finite number from a number or a numeric string, else the fallback (NaN / garbage in a config must never reach the shading maths)
const num = (v, fb) => { const n = typeof v === 'number' ? v : (typeof v === 'string' && v.trim() !== '' ? +v : NaN); return Number.isFinite(n) ? n : fb }
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v)
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v)
const smoothstep = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t) }

// Shift a colour along the warm/cold axis and return it as a 0..1 multiplier normalised so its brightest channel is 1.
function tintOf(rgb, warmth) {
  const w = clamp(warmth || 0, -1, 1)
  const r = rgb[0] * (1 + 0.16 * w), g = rgb[1] * (1 + 0.02 * w), b = rgb[2] * (1 - 0.22 * w)
  const m = Math.max(r, g, b, 1)
  return [r / m, g / m, b / m]
}

// The recipe for a level config: LEVEL_LIGHTING[levelKey] merged under config.look.lighting; null = no recipe (legacy shading).
export function resolveLighting(config) {
  const key = levelKey(config)
  const base = LEVEL_LIGHTING[key] || null
  const over = config && config.look && config.look.lighting
  if (!base && !over) return null
  const s = { ...DEFAULT_RECIPE, ...(base || {}), ...(over || {}) }
  const dflt = (k) => (base && base[k] != null ? base[k] : DEFAULT_RECIPE[k])       // the level's own default, for a value that is not a number
  s.key = key
  if (s.mode !== 'lamps' && s.mode !== 'daylight') s.mode = 'panels'
  // a level whose ceiling has no panels (config.lights === false) cannot host the panel lattice
  if (s.mode === 'panels' && config && config.lights === false) s.mode = 'lamps'
  s.color = parseColor(s.color, DEFAULT_RECIPE.color)
  s.ambientColor = parseColor(s.ambientColor, null) || s.color.map((v) => Math.round(v * 0.86 + 255 * 0.14 * 0.6))
  s.ambient = clamp(num(s.ambient, dflt('ambient')), 0, 1.5)
  s.peak = clamp(num(s.peak, dflt('peak')), s.ambient, 3)
  s.pool = clamp(s.mode === 'daylight' && !(over && over.pool != null) ? 0 : num(s.pool, dflt('pool')), 0, 2)
  s.radius = clamp(num(s.radius, dflt('radius')), 0.3, 8)
  s.contact = clamp(num(s.contact, dflt('contact')), 0, 1)
  s.fogGain = clamp(num(s.fogGain, dflt('fogGain')), 0.3, 1.5)
  s.fogBase = clamp(num(s.fogBase, dflt('fogBase')), 0, 1)
  s.fogGlow = clamp(num(s.fogGlow, dflt('fogGlow')), 0, 4)
  s.ceilAmbient = clamp(num(s.ceilAmbient, num(dflt('ceilAmbient'), s.ambient * 0.6)), 0, 1.5)
  s.every = clamp(Math.round(num(s.every, dflt('every'))) || 8, 3, 64)
  s.warmth = num(s.warmth, dflt('warmth'))
  if (s.mode === 'daylight') {
    const w = { color: s.color, radius: 3.4, strength: 0.75, ...(s.windows || {}) }
    s.windows = { color: parseColor(w.color, s.color), radius: clamp(num(w.radius, 3.4), 0.5, 6), strength: clamp(num(w.strength, 0.75), 0, 2) }
  } else s.windows = null
  s.tint = tintOf(s.mode === 'daylight' ? s.windows.color : s.color, s.warmth)   // multiplier the pooled light applies to surfaces
  s.ambTint = tintOf(s.ambientColor, s.warmth)
  return s
}

// ── the periodic pool tiles ──────────────────────────────────────────────────────────────────────────────────────────────────
// A panel sits at (0.5, 0.5) + PERIOD * (i, j). Pools have compact support (radius < PERIOD) so a point is touched by at most four
// panels and the tile is exactly periodic. Each tile also comes split as  S = A + B  where B is the contribution of the NEAREST
// panel only (tapered to 0 at the edge of that panel's Voronoi square, so dimming one panel never leaves a seam): S is the steady
// look, and `A + level * B` is the look with that one panel dimmed (the modulated path of the world pass, used while a
// flicker event is in flight).
export function kernel(r, R) { if (r >= R) return 0; const q = 1 - (r * r) / (R * R); return q * q }
const TAPER_IN = 0.42, TAPER_OUT = 0.98

export function buildPanelTile(range, R) {
  const N = TILE_N
  const S = new Float32Array(N * N), A = new Float32Array(N * N), B = new Float32Array(N * N)
  for (let v = 0; v < N; v++) {
    for (let u = 0; u < N; u++) {
      const x = (u + 0.5) / TILE_PER_UNIT, y = (v + 0.5) / TILE_PER_UNIT
      let sum = 0, nearD = 1e9
      for (let pj = -1; pj <= 1; pj++) {
        for (let pi = -1; pi <= 1; pi++) {
          const dx = x - (0.5 + PERIOD * pi), dy = y - (0.5 + PERIOD * pj)
          const r = Math.sqrt(dx * dx + dy * dy)
          sum += kernel(r, R)
          if (r < nearD) nearD = r
        }
      }
      const i = v * N + u
      S[i] = range * sum
      B[i] = range * kernel(nearD, R) * (1 - smoothstep(TAPER_IN, TAPER_OUT, nearD))
      A[i] = S[i] - B[i]
    }
  }
  return { S, A, B }
}

// Wall pool along a wall face. A wall face sits at an integer coordinate and a panel column at 0.5 + 2i, so one column is always
// half a unit from a face (on one side of it or the other): every face pools the same way, brightest opposite the panel rows
// (u = 0.5 + 2j) and dark between them, so the wall pools line up with the floor pools. `Rw` is the reach of a panel along the wall.
// K[0..2] are the contributions of the three panels that can touch sample k (rows J-1, J, J+1, centred at -1.5, 0.5, 2.5 in the
// period), P = clamp(K0 + K1 + K2) is the steady pool factor; a dimmed panel scales its own K.
export function buildWallPool(Rw) {
  const N = TILE_N
  const K = [new Float32Array(N), new Float32Array(N), new Float32Array(N)], P = new Float32Array(N)
  for (let k = 0; k < N; k++) {
    const u = (k + 0.5) / TILE_PER_UNIT
    let sum = 0
    for (let m = 0; m < 3; m++) {
      const du = u - (0.5 + PERIOD * (m - 1))
      K[m][k] = kernel(Math.sqrt(0.25 + du * du), Rw)
      sum += K[m][k]
    }
    P[k] = clamp01(sum)
  }
  return { P, K }
}

// tables that depend on the texture tile size (the wall's vertical gradient is indexed by the wall texel row)
export function buildSurfaceTables(s, ts) {
  const range = Math.max(0, (s.peak - s.ambient) * s.pool)
  // wall: light in the pool = range * p * Vp(z); ambient = ambient * Va(z); both times the contact darkening C(z). z: 0 floor .. 1 ceiling
  const wallPool = new Float32Array(64 * ts)      // [pq * ts + texY]
  const wallAmb = new Float32Array(ts)
  const cw = s.contact
  for (let t = 0; t < ts; t++) {
    const z = 1 - (t + 0.5) / ts                    // texel row 0 is the top of the wall
    const Vp = 0.32 + 0.68 * smoothstep(0.04, 0.72, z) * (1 - 0.18 * smoothstep(0.86, 1, z))
    const Va = 0.80 + 0.30 * z
    const C = (1 - cw * 0.3 * Math.exp(-z / 0.09)) * (1 - cw * 0.5 * Math.exp(-(1 - z) / 0.05))
    wallAmb[t] = s.ambient * Va * C
    for (let q = 0; q < 64; q++) wallPool[q * ts + t] = range * (q / 63) * Vp * C
  }
  // contact shading on the floor / ceiling next to a wall: rows 0 none, 1 wall on the low side, 2 on the high side, 3 both
  const mk = (strength, reach) => {
    const T = new Float32Array(4 * ts)
    for (let t = 0; t < ts; t++) {
      const d = (t + 0.5) / ts                         // distance from the low edge, in world units
      const lo = 1 - strength * Math.pow(Math.max(0, 1 - d / reach), 2)
      const hi = 1 - strength * Math.pow(Math.max(0, 1 - (1 - d) / reach), 2)
      T[t] = 1; T[ts + t] = lo; T[2 * ts + t] = hi; T[3 * ts + t] = lo * hi
    }
    return T
  }
  // ambient + pool in one table (pq*ts + texY) for levels whose two colours agree (see `single`): one read per wall pixel instead of two
  const wallLit = new Float32Array(64 * ts)
  for (let q = 0; q < 64; q++) for (let t = 0; t < ts; t++) wallLit[q * ts + t] = wallAmb[t] + wallPool[q * ts + t]
  return { wallPool, wallAmb, wallLit, aoFloor: mk(s.contact * 0.62, 0.62), aoCeil: mk(s.contact * 0.5, 0.5) }
}

// ── flicker ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const STEADY_BAND = 0.1        // the game's steady state wanders in rawFlicker 0.92..1; below this much dip there is no event
const HOLD_HIGH = 0.45, HOLD_LOW = 0.3   // dwell times of the event gate (seconds): a rise-and-fall cycle takes at least 0.75 s
export function eventIntensity(rawFlicker) { return clamp01(((1 - rawFlicker) - STEADY_BAND) / (1 - STEADY_BAND)) }

// smooth per-panel value noise in 0..1, evaluated at time t (seconds); the lattice hash gives every panel its own phase.
// h is itself a full-range hash, beyond the range where the old double-multiply hash2 was exact, so this keeps that frozen
// construction (hash2Legacy): the flutter of every panel stays exactly what it was. Only the CPU evaluates it (the GPU gets the levels).
function panelNoise(h, t, hz) {
  const x = t * hz + ((h >>> 12) & 1023) * 0.0977
  const k = Math.floor(x), f = x - k
  const a = hash2Legacy(h, k, 0x9e37) / 4294967296, b = hash2Legacy(h, k + 1, 0x9e37) / 4294967296
  const s = f * f * (3 - 2 * f)
  return a + (b - a) * s
}

// The level (0..1) of the emitter whose cell is (cx, cy), for a smoothed event intensity `e`. `ahead` (0 behind the player .. 1 at
// the edge of view) makes emitters far in front of the player go out first: their threshold is lower, so a rising event reaches
// them earlier. `depth` (0..1) is the deepest dip one may take; `hz` the nominal flutter rate of a dimmed one.
export function panelDim(cx, cy, e, ahead, t, depth = 0.95, hz = 1.1) {
  if (e <= 0.002) return 1
  const h = hash2(cx, cy, 0x51)
  const vuln = (h & 1023) / 1023                         // how easily this emitter gutters, 0 = first to go
  const thr = vuln * (0.78 - 0.5 * ahead)                // one far ahead goes with a smaller event
  let d = clamp01((e - thr) / 0.42)
  if (d <= 0) return 1
  d = d * d * (3 - 2 * d)
  const n = panelNoise(h, t, hz)                          // 0..1
  return clamp01(1 - d * depth * (0.62 + 0.38 * n))
}

// ── sparse emitters (lamps) ────────────────────────────────────────────────────────────────────────────────────────────────────
const LAMP_SALT = 0x1a3f
// Is (cx, cy) a lamp CANDIDATE: about one cell in `every`, chosen by the cell address alone (so every client agrees).
export function lampCandidate(cx, cy, every) { return hash2(cx, cy, LAMP_SALT) % every === 0 }
// The lamp kernel: intensity (0..1, 1 right under it) at plan distance r from a lamp of reach R: a bright core and a long soft tail
// that reaches exactly 0 at R.
export function lampKernel(r, R) {
  if (r >= R) return 0
  const q = 1 - (r * r) / (R * R)
  return (q * q) / (1 + (r * r) / 0.7)
}

const OCC = 64, OCC_M = 63           // toroidal cell window (slots per axis); cells within OCC_R of the player are valid
const OCC_R_MAX = 21
const LMC = 32                        // lightmap cells per axis (toroidal)
const LM_N = 4                        // lightmap samples per world unit
const LMS = LMC * LM_N                // samples per axis (128)
const LM_R_MAX = 15                   // the lightmap covers the cells within this radius of the player
const LM_MAXL = 8                     // lamps kept per lightmap cell (the nearest ones)
const LM_FADE = 3                     // the lightmap fades out over the last LM_FADE cells before its radius (no visible edge as the window moves)
const PANEL_SHARE_K = 2, LAMP_SHARE_K = 2, LAMP_SHARE_VIS = 0.6   // emitter-share estimate: fixtures glow too, and open floor is ~60% of the cells
const LUM_GAMMA = 2.2                // byte value -> relative luminance (the flicker budget is in relative luminance, as WCAG measures it)
const POW_LUM = new Float32Array(256)     // level (0..1, in 1/255 steps) -> level ** LUM_GAMMA
for (let i = 0; i < 256; i++) POW_LUM[i] = Math.pow(i / 255, LUM_GAMMA)
const BIG = 0x7fffffff
// the factor (1 .. 0) the lightmap value gets at Chebyshev distance dc (world units) from the player when the window radius is RL cells.
// The world pass evaluates the same curve in fixed point; keep the two in step (test/gfx-fix-l.test.js checks they agree).
export function lmEdgeFade(dc, RL) {
  const a = RL - LM_FADE
  if (dc <= a) return 1
  if (dc >= RL) return 0
  const u = (dc - a) / LM_FADE
  return 1 - u * u * (3 - 2 * u)
}
export const LM_FADE_CELLS = LM_FADE

// createLight's periodic pool tiles depend on two numbers only, and nothing writes them once built (the world pass and the GPU upload
// read them): a light created again for the same recipe (a level re-entered, the GPU path's first-frame CPU reference, a swap to the CPU
// renderer) takes the same arrays instead of re-running ~37k kernel evaluations per tile.
const TILE_MEMO = new Map()
function memoTile(key, build) {
  let v = TILE_MEMO.get(key)
  if (v === undefined) { if (TILE_MEMO.size >= 32) TILE_MEMO.clear(); v = build(); TILE_MEMO.set(key, v) }
  return v
}

// ── the light object ─────────────────────────────────────────────────────────────────────────────────────────────────────────
export function createLight(config, worldHooks) {
  const S = resolveLighting(config)
  const light = {
    enabled: false,
    mode: S ? S.mode : 'off',
    recipe: S,
    frame: null,
    at() { return 1 },
    tint() { return NO_TINT },
    nearest() { return null },
    panelLevel() { return 1 },
    prepare() { light.enabled = false; return false },
  }
  if (!S) return light

  // ── static tables (built once) ──
  const range = Math.max(0, (S.peak - S.ambient) * S.pool)
  const panels = S.mode === 'panels'
  const lamps = S.mode === 'lamps'
  const windows = S.mode === 'daylight' && S.windows && S.windows.strength > 0
  const emitters = lamps || windows
  const floorR = panels ? range : 0, ceilRange = panels ? Math.max(0, (S.peak - S.ambient) * S.pool * 0.7) : 0, ceilRad = Math.min(1.9, S.radius * 1.3)
  const floorT = memoTile('p' + floorR + '|' + S.radius, () => buildPanelTile(floorR, S.radius))
  const ceilT = memoTile('p' + ceilRange + '|' + ceilRad, () => buildPanelTile(ceilRange, ceilRad))
  const wallPanel = memoTile('w' + S.radius * 0.95, () => buildWallPool(S.radius * 0.95))
  const surf = {}                                        // ts → buildSurfaceTables (the tile size is only known at the first frame)
  // the strength of one emitter at its centre, in the units of `pool` (lamps: the level's range; windows: their own strength)
  const emitRange = lamps ? range : windows ? S.windows.strength : 0
  const emitReach = lamps ? S.radius : windows ? S.windows.radius : 0
  const emitColor = windows ? S.windows.color : S.color
  // The share of a frame's light that comes from the emitters (pools + fixtures) as opposed to the ambient: the flicker budget in
  // prepare() needs it to keep the frame mean above the comfort floor however deep the emitters dim (calibrated against the harness).
  let emitShare = 0
  if (panels) {
    let m = 0
    for (let i = 0; i < floorT.S.length; i++) m += floorT.S[i]
    m /= floorT.S.length
    emitShare = clamp01(PANEL_SHARE_K * m / (S.ambient + m))
  } else if (lamps) {
    let integ = 0
    for (let r = 0.025; r < emitReach; r += 0.05) integ += lampKernel(r, emitReach) * 2 * Math.PI * r * 0.05
    const m = range * integ / S.every * LAMP_SHARE_VIS
    emitShare = clamp01(LAMP_SHARE_K * m / (S.ambient + m))
  }

  // per-frame block, reused (no allocation per frame)
  const F = {
    active: false, ld: 0, panels, lamps, windows, emitters, mode: S.mode,
    tR: S.tint[0], tG: S.tint[1], tB: S.tint[2],            // pool tint
    aR: S.ambient * S.ambTint[0], aG: S.ambient * S.ambTint[1], aB: S.ambient * S.ambTint[2],   // ambient colour × level
    atR: S.ambTint[0], atG: S.ambTint[1], atB: S.ambTint[2],  // the ambient tint alone
    cR: S.ceilAmbient * S.ambTint[0], cG: S.ceilAmbient * S.ambTint[1], cB: S.ceilAmbient * S.ambTint[2],   // the ceiling's ambient
    ambient: S.ambient, ceilAmbient: S.ceilAmbient, fogGain: S.fogGain, fogBase: S.fogBase, fogGlow: S.fogGlow,
    // the ambient and the pool tints agree closely: the world pass then shades with one scalar light and one tint (cheaper)
    single: Math.max(Math.abs(S.tint[0] - S.ambTint[0]), Math.abs(S.tint[1] - S.ambTint[1]), Math.abs(S.tint[2] - S.ambTint[2])) < 0.06,
    floorInv: range > 0 && panels ? 1 / range : (emitters && emitRange > 0 ? 1 / emitRange : 0),
    ceilInv: ceilRange > 0 ? 1 / ceilRange : (emitters && emitRange > 0 ? 1 / emitRange : 0),
    poolRange: range, emitRange,
    flashK: FLASH_I * clamp(1.15 - 0.85 * S.ambient, 0.3, 1),      // the torch matters less where the place is already lit
    // the largest pool value a pixel can receive (exact for the lattice tiles, the largest seen so far for the lightmap): the world pass
    // uses them to know when a surface can never overflow a byte
    floorTileMax: floorT.S.reduce((a, b) => (b > a ? b : a), 0), ceilTileMax: ceilT.S.reduce((a, b) => (b > a ? b : a), 0), lmMax: 0,
    lampCol: S.color.map((v) => Math.round(v + (255 - v) * 0.4)),      // the glowing core of a lamp fixture
    gdip: 1, eS: 0, dimS: 1,
    floorS: floorT.S, floorA: floorT.A, floorB: floorT.B,
    ceilS: ceilT.S, ceilA: ceilT.A, ceilB: ceilT.B,
    wallP: wallPanel.P, wallK0: wallPanel.K[0], wallK1: wallPanel.K[1], wallK2: wallPanel.K[2],
    wallPool: null, wallAmb: null, wallLit: null, aoFloor: null, aoCeil: null,
    ts: 0,
    // the toroidal cell window: contact-shading bits and lamp flags of the cells around the player
    cellBits: null, cellLamp: null, occR: 0, occCx: 0, occCy: 0,
    // the lightmap (lamps / windows): 4 samples per unit, toroidal, plus a per-cell "anything in reach" flag
    lm: null, lmAny: null, lmR: 0,
    // panel level grid for the current frame (null = every panel steady)
    dimmed: false, lev: null, levG: 0, levN: 0, levI0: 0, levJ0: 0,
    // the player's own lights of this frame
    flash: false, glow: false,
    px: 0, py: 0, ca: 1, sa: 0, fog: 16, t: 0,
    lights: null,
  }
  light.frame = F

  // ── occupancy window (toroidal) ──
  const cellWall = new Uint8Array(OCC * OCC)
  const cellBits = new Uint8Array(OCC * OCC)
  const cellLamp = new Uint8Array(OCC * OCC)
  const cellValid = new Uint8Array(OCC * OCC)
  const tagX = new Int32Array(OCC * OCC).fill(BIG), tagY = new Int32Array(OCC * OCC).fill(BIG)
  F.cellBits = cellBits; F.cellLamp = cellLamp
  let occR = 0, lastCx = BIG, lastCy = BIG
  const slotOf = (cx, cy) => ((cy & OCC_M) << 6) | (cx & OCC_M)
  const wallAt = (cx, cy) => cellWall[slotOf(cx, cy)] === 1
  let materialHook = worldHooks && worldHooks.materialAt ? worldHooks.materialAt : null

  function lampHere(cx, cy) {
    if (cellWall[slotOf(cx, cy)]) return false
    if (!lampCandidate(cx, cy, S.every)) return false
    const h = hash2(cx, cy, LAMP_SALT)
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue
        const nx = cx + dx, ny = cy + dy
        if (cellWall[slotOf(nx, ny)] || !lampCandidate(nx, ny, S.every)) continue
        const nh = hash2(nx, ny, LAMP_SALT)
        if (nh > h || (nh === h && (dy < 0 || (dy === 0 && dx < 0)))) return false      // a higher-ranked candidate next door wins
      }
    }
    return true
  }

  function refreshOccupancy(fs, isWallFn) {
    if (!isWallFn) return
    const p = fs.player
    const pcx = Math.floor(p.x), pcy = Math.floor(p.y)
    const need = emitters ? OCC_R_MAX : clamp(Math.ceil(fs.fog) + 3, 8, OCC_R_MAX)
    if (need <= occR && pcx === lastCx && pcy === lastCy) return
    if (need > occR) occR = need
    lastCx = pcx; lastCy = pcy
    const R = occR
    // pass 1: walls (and lit windows) of every cell within R + 1
    for (let cy = pcy - R - 1; cy <= pcy + R + 1; cy++) {
      for (let cx = pcx - R - 1; cx <= pcx + R + 1; cx++) {
        const s = slotOf(cx, cy)
        if (tagX[s] === cx && tagY[s] === cy) continue
        tagX[s] = cx; tagY[s] = cy; cellValid[s] = 0
        const w = isWallFn(cx + 0.5, cy + 0.5) ? 1 : 0
        cellWall[s] = w
        cellLamp[s] = windows && w && materialHook && materialHook(cx + 0.5, cy + 0.5) === 'O' ? 1 : 0
        cellBits[s] = 0
      }
    }
    // pass 2: contact-shading bits and lamps of the cells within R (their neighbours are all known now)
    for (let cy = pcy - R; cy <= pcy + R; cy++) {
      for (let cx = pcx - R; cx <= pcx + R; cx++) {
        const s = slotOf(cx, cy)
        if (cellValid[s]) continue
        cellValid[s] = 1
        if (cellWall[s]) { cellBits[s] = 0; continue }
        cellBits[s] = (wallAt(cx - 1, cy) ? 1 : 0) | (wallAt(cx + 1, cy) ? 2 : 0) | (wallAt(cx, cy - 1) ? 4 : 0) | (wallAt(cx, cy + 1) ? 8 : 0)
        if (lamps) cellLamp[s] = lampHere(cx, cy) ? 1 : 0
      }
    }
    F.occR = R; F.occCx = pcx; F.occCy = pcy
  }

  // ── the lightmap: the light of every lamp / window, with hard shadows behind walls ──
  let lm = null, lmAny = null, lmTagX = null, lmTagY = null, lmReachCells = 0
  const ex = new Float32Array(96), ey = new Float32Array(96)
  if (emitters) {
    lm = new Float32Array(LMS * LMS); lmAny = new Uint8Array(LMC * LMC)
    lmTagX = new Int32Array(LMC * LMC).fill(BIG); lmTagY = new Int32Array(LMC * LMC).fill(BIG)
    F.lm = lm; F.lmAny = lmAny
    lmReachCells = Math.ceil(emitReach) + 1
  }
  const R2 = emitReach * emitReach
  const r0k = windows ? 0.5 : 1
  function emitterKernel(r) {
    if (windows) { if (r >= emitReach) return 0; const q = 1 - (r * r) / R2; return q * q / (1 + (r * r) / r0k) }
    return lampKernel(r, emitReach)
  }
  // is the straight segment (x,y) -> (tx,ty) free of walls (ignoring the cell of either end)?
  function visible(x, y, tx, ty) {
    const dx = tx - x, dy = ty - y
    const d = Math.sqrt(dx * dx + dy * dy)
    const steps = Math.ceil(d / 0.3)
    const c0x = Math.floor(x), c0y = Math.floor(y), c1x = Math.floor(tx), c1y = Math.floor(ty)
    for (let s = 1; s < steps; s++) {
      const t = s / steps
      const cx = Math.floor(x + dx * t), cy = Math.floor(y + dy * t)
      if ((cx === c0x && cy === c0y) || (cx === c1x && cy === c1y)) continue
      if (cellWall[slotOf(cx, cy)]) return false
    }
    return true
  }
  // Per light cell: the (up to LM_MAXL nearest) lamps in reach and each one's static weight per sample (kernel × visibility × strength),
  // so a flicker event can re-mix the lightmap with the lamps' current levels without redoing any visibility test.
  // (only a level with emitters has a lightmap: these are ~0.5 MB, so a panel level does not allocate them)
  const cellN = emitters ? new Uint8Array(LMC * LMC) : null
  const cellId = emitters ? new Int16Array(LMC * LMC * LM_MAXL) : null
  const cellW = emitters ? new Float32Array(LMC * LMC * LM_MAXL * 16) : null
  const exd = new Float32Array(96)
  function gatherCell(lcx, lcy, slot) {
    lmTagX[slot] = lcx; lmTagY[slot] = lcy
    lastLv[slot * LM_MAXL] = NaN                    // gathered, not mixed: the next re-mix must write this cell
    const rc = lmReachCells
    const mx = lcx + 0.5, my = lcy + 0.5
    let n = 0
    for (let cy = lcy - rc; cy <= lcy + rc && n < 96; cy++) {
      for (let cx = lcx - rc; cx <= lcx + rc && n < 96; cx++) {
        const so = slotOf(cx, cy)
        if (tagX[so] === cx && tagY[so] === cy && cellLamp[so] === 1) { ex[n] = cx + 0.5; ey[n] = cy + 0.5; exd[n] = (cx + 0.5 - mx) ** 2 + (cy + 0.5 - my) ** 2; cellIdTmp[n] = so; n++ }
      }
    }
    lmAny[slot] = n > 0 ? 1 : 0
    // keep the LM_MAXL nearest
    let keep = n
    if (n > LM_MAXL) {
      for (let i = 0; i < LM_MAXL; i++) {
        let bi = i
        for (let j = i + 1; j < n; j++) if (exd[j] < exd[bi]) bi = j
        if (bi !== i) {
          let t = ex[i]; ex[i] = ex[bi]; ex[bi] = t
          t = ey[i]; ey[i] = ey[bi]; ey[bi] = t
          t = exd[i]; exd[i] = exd[bi]; exd[bi] = t
          const ti = cellIdTmp[i]; cellIdTmp[i] = cellIdTmp[bi]; cellIdTmp[bi] = ti
        }
      }
      keep = LM_MAXL
    }
    cellN[slot] = keep
    for (let k = 0; k < keep; k++) cellId[slot * LM_MAXL + k] = cellIdTmp[k]
    for (let j = 0; j < LM_N; j++) {
      for (let i = 0; i < LM_N; i++) {
        let acc = 0
        const x = lcx + (i + 0.5) / LM_N, y = lcy + (j + 0.5) / LM_N
        const si = j * LM_N + i
        for (let k = 0; k < keep; k++) {
          let w = 0
          const dx = ex[k] - x, dy = ey[k] - y
          const d2 = dx * dx + dy * dy
          if (d2 < R2 && visible(x, y, ex[k], ey[k])) w = emitterKernel(Math.sqrt(d2)) * emitRange
          cellW[(slot * LM_MAXL + k) * 16 + si] = w
          acc += w
        }
        lm[(((lcy * LM_N + j) & (LMS - 1)) << 7) | ((lcx * LM_N + i) & (LMS - 1))] = acc
        if (acc > F.lmMax) F.lmMax = acc
      }
    }
  }
  const cellIdTmp = new Int16Array(96)
  // per light cell, the levels of its lamps its samples were last re-mixed with (NaN: gathered since), and scratch for one cell's levels
  const lastLv = emitters ? new Float32Array(LMC * LMC * LM_MAXL).fill(NaN) : null, lvTmp = new Float64Array(LM_MAXL), accTmp = new Float64Array(16)
  // re-mix the lightmap of every cell in view with the lamps' current levels (F.lampLev, indexed by the lamp's occupancy slot). A cell whose
  // lamps all have the very levels it was last mixed with already holds exactly what the mix would write (most cells, while only a few
  // lamps gutter), so it is skipped; the others sum their lamps in the same order as always.
  function remixLightmap(fs, lampLev) {
    const p = fs.player
    const pcx = Math.floor(p.x), pcy = Math.floor(p.y)
    const RL = F.lmR
    for (let lcy = pcy - RL; lcy <= pcy + RL; lcy++) {
      for (let lcx = pcx - RL; lcx <= pcx + RL; lcx++) {
        const slot = ((lcy & (LMC - 1)) << 5) | (lcx & (LMC - 1))
        const n = cellN[slot]
        if (n === 0) continue
        const base = slot * LM_MAXL
        let same = true
        for (let k = 0; k < n; k++) { const v = lampLev[cellId[base + k]]; lvTmp[k] = v; if (v !== lastLv[base + k]) same = false }
        if (same) continue
        for (let k = 0; k < n; k++) lastLv[base + k] = lvTmp[k]
        // lamp by lamp over the cell's 16 samples (each sample still sums its lamps in order k = 0, 1, ...)
        accTmp.fill(0)
        for (let k = 0; k < n; k++) {
          const l = lvTmp[k], wb = (base + k) * 16
          for (let si = 0; si < 16; si++) accTmp[si] += l * cellW[wb + si]
        }
        for (let j = 0; j < LM_N; j++) {
          const row = ((lcy * LM_N + j) & (LMS - 1)) << 7
          for (let i = 0; i < LM_N; i++) lm[row | ((lcx * LM_N + i) & (LMS - 1))] = accTmp[j * LM_N + i]
        }
      }
    }
  }
  function refreshLightmap(fs) {
    const p = fs.player
    const pcx = Math.floor(p.x), pcy = Math.floor(p.y)
    const RL = clamp(Math.ceil(fs.fog) + 1, 6, LM_R_MAX)
    F.lmR = RL
    for (let lcy = pcy - RL; lcy <= pcy + RL; lcy++) {
      for (let lcx = pcx - RL; lcx <= pcx + RL; lcx++) {
        const slot = ((lcy & (LMC - 1)) << 5) | (lcx & (LMC - 1))
        if (lmTagX[slot] !== lcx || lmTagY[slot] !== lcy) gatherCell(lcx, lcy, slot)
      }
    }
  }
  // the emitter light at a world point (bilinear over the lightmap), 0 outside the covered window
  function lightmapAt(wx, wy) {
    if (!emitters || F.lmR === 0) return 0
    const cx = Math.floor(wx), cy = Math.floor(wy)
    if (Math.abs(cx - F.occCx) > F.lmR || Math.abs(cy - F.occCy) > F.lmR) return 0
    const fade = lmEdgeFade(Math.max(Math.abs(wx - F.px), Math.abs(wy - F.py)), F.lmR)
    if (fade <= 0) return 0
    const sx = wx * LM_N - 0.5, sy = wy * LM_N - 0.5
    const i0 = Math.floor(sx), j0 = Math.floor(sy), fx = sx - i0, fy = sy - j0
    const g = (i, j) => lm[((j & (LMS - 1)) << 7) | (i & (LMS - 1))]
    const a = g(i0, j0), b = g(i0 + 1, j0), c = g(i0, j0 + 1), d = g(i0 + 1, j0 + 1)
    return ((a + (b - a) * fx) * (1 - fy) + (c + (d - c) * fx) * fy) * fade
  }

  // ── flicker state ──
  let eSmooth = 0, lastFs = null, lmDirty = false, clock = 0, held = 0, lastRise = -9, lastFall = -9
  const lampLev = new Float32Array(OCC * OCC).fill(1)
  const bV = new Float32Array(OCC * OCC), bW = new Float32Array(OCC * OCC)     // scratch for the flicker budget
  let levW = null
  F.lampLev = lampLev, F.lampDim = false
  function eventFor(fs) {
    const raw = fs.rawFlicker != null ? fs.rawFlicker : (fs.flicker != null ? fs.flicker : 1)
    let e = eventIntensity(raw)
    if (fs.comfort && fs.comfort.reduceFlicker) e *= 0.55
    return e
  }
  const aheadOf = (cx, cy, px, py, ca, sa, fog) => clamp01(((cx + 0.5 - px) * ca + (cy + 0.5 - py) * sa + 1) / (fog * 0.7 + 1))
  const depthOf = (fs) => (fs.comfort && fs.comfort.reduceFlicker ? 0.55 : 0.95)
  const hzOf = (fs) => (fs.comfort && fs.comfort.reduceFlicker ? 0.55 : 1.1)

  // the level of the emitter at (cx, cy) under the state of the last prepared frame (or `fs` when it is not that one)
  // (the view direction's cosine and sine are memoised by angle: a frame asks for hundreds of emitters under one player angle)
  let memoA = NaN, memoC = 1, memoS = 0
  function levelRaw(cx, cy, fs) {
    const e = fs === lastFs ? eSmooth : eventFor(fs)
    if (e <= 0.002) return 1
    const p = fs.player || { x: cx, y: cy, angle: 0 }
    if (!Object.is(p.angle, memoA)) { memoA = p.angle; memoC = Math.cos(memoA); memoS = Math.sin(memoA) }
    return panelDim(cx, cy, e, aheadOf(cx, cy, p.x, p.y, memoC, memoS, fs.fog || 16), fs.t || 0, depthOf(fs), hzOf(fs))
  }
  // the same, pulled toward 1 by the frame's flicker budget (F.dimS, see prepare) so the frame mean keeps to the comfort floor
  function levelFor(cx, cy, fs) {
    const v = levelRaw(cx, cy, fs)
    return fs === lastFs && F.dimS < 1 ? 1 - F.dimS * (1 - v) : v
  }
  light.panelLevel = (cx, cy, fs) => {
    if (panels) return levelFor(cx, cy, fs)
    if (lamps) { const s = slotOf(cx, cy); return tagX[s] === cx && tagY[s] === cy && cellLamp[s] ? levelFor(cx, cy, fs) : 1 }
    return 1
  }

  // ── queries ──
  const modPos = (v) => { const m = v % PERIOD; return m < 0 ? m + PERIOD : m }
  const tileIdx = (wx, wy) => {
    const u = Math.min(TILE_N - 1, (modPos(wx) * TILE_PER_UNIT) | 0), v = Math.min(TILE_N - 1, (modPos(wy) * TILE_PER_UNIT) | 0)
    return v * TILE_N + u
  }
  const nearestPanelCell = (wx, wy) => ({ i: Math.floor((wx - 0.5) / PERIOD + 0.5), j: Math.floor((wy - 0.5) / PERIOD + 0.5) })

  // the player's flashlight / glowstick light at a floor point, of the last prepared frame (same falloffs as the world pass)
  function dynamicAt(wx, wy) {
    if (!F.active || !F.lights) return 0
    let v = 0
    const dx = wx - F.px, dy = wy - F.py
    const d = Math.sqrt(dx * dx + dy * dy)
    if (F.flash && d > 0.05) {
      const th = Math.atan2(dy, dx) - Math.atan2(F.sa, F.ca)
      const a = Math.atan2(Math.sin(th), Math.cos(th))
      const dv = 0.5 / Math.max(0.5, d) - FLASH_PITCH
      v += F.flashK * 0.85 * Math.exp(-(a * a) / (FLASH_SX * FLASH_SX) - (dv * dv) / (FLASH_SY * FLASH_SY)) * flashAtt(d)
    }
    if (F.glow) v += F.glowK * glowAtt(d * d + 0.25)
    return v
  }
  light.at = (wx, wy) => {
    if (!light.enabled) return 1
    let pool = 0
    if (panels) {
      const idx = tileIdx(wx, wy)
      let lev = 1
      if (F.eS > 0.002 && lastFs) { const n = nearestPanelCell(wx, wy); lev = levelFor(2 * n.i, 2 * n.j, lastFs) }
      pool = F.floorA[idx] + lev * F.floorB[idx]
    } else if (emitters) pool = lightmapAt(wx, wy)
    return clamp((F.ambient + pool + dynamicAt(wx, wy)) * F.gdip, 0.05, 2.2)
  }
  // The colour multiplier at a point: the AMBIENT tint in the dark between fixtures, pulled toward the fixture's tint by the local share
  // of pool light (pool / the emitter's strength). So daylight (no pool but the window spill) and the black between lamps stay
  // near-neutral instead of tinting every prop and creature the fixtures' colour everywhere.
  light.tint = (wx, wy) => {
    if (!light.enabled) return NO_TINT
    let share = 0
    if (panels) {
      const idx = tileIdx(wx, wy)
      share = clamp01((F.floorA[idx] + F.floorB[idx]) * F.floorInv)
    } else if (emitters) share = clamp01(lightmapAt(wx, wy) * F.floorInv)
    const bR = F.atR + (F.tR - F.atR) * share, bG = F.atG + (F.tG - F.atG) * share, bB = F.atB + (F.tB - F.atB) * share
    if (F.glow && F.lights && Array.isArray(F.lights.glow)) {
      const d = Math.hypot(wx - F.px, wy - F.py)
      const w = clamp01(glowAtt(d * d + 0.25) * 1.2)
      const g = F.lights.glow
      const m = Math.max(g[0], g[1], g[2], 1)
      return [bR + (g[0] / m - bR) * w, bG + (g[1] / m - bG) * w, bB + (g[2] / m - bB) * w]
    }
    return [bR, bG, bB]
  }
  light.nearest = (wx, wy) => {
    if (!light.enabled) return null
    if (panels) {
      const n = nearestPanelCell(wx, wy)
      const x = 0.5 + PERIOD * n.i, y = 0.5 + PERIOD * n.j
      return { x, y, dist: Math.hypot(wx - x, wy - y), r: S.color[0], g: S.color[1], b: S.color[2] }
    }
    if (emitters) {
      const cx = Math.floor(wx), cy = Math.floor(wy)
      let best = null, bd = 1e9
      const rr = 7
      for (let y = cy - rr; y <= cy + rr; y++) {
        for (let x = cx - rr; x <= cx + rr; x++) {
          const s = slotOf(x, y)
          if (tagX[s] !== x || tagY[s] !== y || !cellLamp[s]) continue
          const d = Math.hypot(wx - (x + 0.5), wy - (y + 0.5))
          if (d < bd) { bd = d; best = { x: x + 0.5, y: y + 0.5, dist: d, r: emitColor[0], g: emitColor[1], b: emitColor[2] } }
        }
      }
      return best
    }
    return null
  }

  // ── the flicker budget (per frame, while an event is in flight) ──
  // the emitters in front of the player, and near, are the ones that show (and they are the first to go), so they weigh the most
  function viewWeight(cx, cy, fog) {
    const dx = cx + 0.5 - F.px, dy = cy + 0.5 - F.py
    const front = clamp01((dx * F.ca + dy * F.sa) / (Math.sqrt(dx * dx + dy * dy) + 1e-6) * 0.7 + 0.3)     // 1 dead ahead .. 0 behind
    return front * Math.max(0.05, 1 - Math.sqrt(dx * dx + dy * dy) / (fog + 3))
  }
  // the frame's luminance lost when every emitter (level v) is dimmed to 1 - s(1-v): emitShare x (1 - weighted mean of level^gamma)
  function lossAt(s, vals, wts, n, wsum) { let a = 0; for (let i = 0; i < n; i++) a += wts[i] * POW_LUM[((1 - s * (1 - vals[i])) * 255 + 0.5) | 0]; return emitShare * (1 - a / wsum) }
  // The largest s in 0..1 such that dimming every emitter that way costs the frame at most `allowed` of its luminance.
  // vals/wts: the emitters' raw levels and view weights. (Functions of createLight, not of the frame: prepare() allocates nothing.)
  function budget(vals, wts, n, allowed) {
    if (allowed >= 1) return 1
    let wsum = 0
    for (let i = 0; i < n; i++) wsum += wts[i]
    if (!(wsum > 0)) return 1
    if (lossAt(1, vals, wts, n, wsum) <= allowed) return 1
    let lo = 0, hi = 1
    for (let k = 0; k < 8; k++) { const mid = (lo + hi) / 2; if (lossAt(mid, vals, wts, n, wsum) <= allowed) lo = mid; else hi = mid }
    return lo
  }
  const NO_LIGHTS = Object.freeze({})

  // ── per frame ──
  light.prepare = (fs, tex, isWallFn, materialAt) => {
    const ld = (fs.quality && fs.quality.lightDetail) | 0
    light.enabled = F.active = ld >= 1
    F.ld = ld
    if (!F.active) return false
    lastFs = fs
    const ts = tex && tex.ts ? tex.ts : 64
    if (F.ts !== ts) {
      if (!surf[ts]) surf[ts] = buildSurfaceTables(S, ts)
      const st = surf[ts]
      F.ts = ts; F.wallPool = st.wallPool; F.wallAmb = st.wallAmb; F.wallLit = st.wallLit; F.aoFloor = st.aoFloor; F.aoCeil = st.aoCeil
    }
    const p = fs.player
    F.px = p.x; F.py = p.y; F.ca = Math.cos(p.angle); F.sa = Math.sin(p.angle); F.fog = fs.fog; F.t = fs.t || 0
    F.lights = fs.lights || null

    // Event intensity. First a dwell gate: once it has risen it may not fall for HOLD_HIGH seconds, and once it has fallen it may not
    // rise for HOLD_LOW — so however the game's scalar slams about, the light events change at most ~1.3 times a second (a flash is
    // an opposing pair of changes, and WCAG 2.3.1 allows 3 a second). Then a low-pass (fast attack, slower release) shapes the edges.
    const dt = clamp(fs.dt > 0 ? fs.dt : 1 / 60, 0.001, 0.1)
    clock += dt
    const eNow = eventFor(fs)
    if (eNow > held + 0.02) { if (clock - lastFall >= HOLD_LOW) { held = eNow; lastRise = clock } }
    else if (eNow < held - 0.02) { if (clock - lastRise >= HOLD_HIGH) { held = eNow; lastFall = clock } }
    const tau = held > eSmooth ? 0.15 : (fs.comfort && fs.comfort.reduceFlicker ? 0.7 : 0.38)
    eSmooth += (held - eSmooth) * (1 - Math.exp(-dt / tau))
    if (eSmooth < 0.002) eSmooth = 0
    F.eS = eSmooth
    const comfortCap = fs.comfort && fs.comfort.reduceFlicker ? 0.35 : 1
    // The comfort floor: the whole-frame mean RELATIVE LUMINANCE (linear light, ~ byte^2.2) may not fall below T = 1 - maxGlobalDip of
    // steady (0 = no floor: the legacy / harness baseline). The budget is split: the ambient dip may take up to sqrt(T) of it (so it is
    // capped at that, whatever AMBIENT_DIP_MAX says), and the per-emitter dimming below spends what is left (F.dimS).
    const T = fs.comfort && Number.isFinite(fs.comfort.maxGlobalDip) ? 1 - clamp(fs.comfort.maxGlobalDip, 0, 1) : 0
    F.gdip = Math.max(1 - AMBIENT_DIP_MAX * comfortCap * eSmooth, T > 0 ? Math.pow(Math.sqrt(T), 1 / LUM_GAMMA) : 0)
    F.dimS = 1
    const gLin = Math.pow(F.gdip, LUM_GAMMA)
    const allowed = T > 0 ? Math.max(0, 1 - T / gLin) : 1         // the share of the frame's luminance the emitters may lose

    // panel level grid (only while an event is in flight; a steady frame carries no grid)
    F.dimmed = false
    if (panels && eSmooth > 0.002 && p) {
      const G = Math.min(16, Math.ceil((fs.fog + 3) / PERIOD)), N = 2 * G + 1
      if (!F.lev || F.levN !== N) { F.lev = new Float32Array(N * N); F.levN = N }
      F.levG = G
      const bi = Math.floor((p.x - 0.5) / PERIOD + 0.5), bj = Math.floor((p.y - 0.5) / PERIOD + 0.5)
      F.levI0 = bi - G; F.levJ0 = bj - G
      let lo = 1
      if (!levW || levW.length !== N * N) levW = new Float32Array(N * N)
      for (let j = 0; j < N; j++) {
        for (let i = 0; i < N; i++) {
          const cx = 2 * (F.levI0 + i), cy = 2 * (F.levJ0 + j)
          F.lev[j * N + i] = levelRaw(cx, cy, fs)
          levW[j * N + i] = viewWeight(cx, cy, fs.fog)
        }
      }
      const s = budget(F.lev, levW, N * N, allowed)
      F.dimS = s
      for (let i = 0; i < N * N; i++) { if (s < 1) F.lev[i] = 1 - s * (1 - F.lev[i]); if (F.lev[i] < lo) lo = F.lev[i] }
      F.dimmed = lo < 0.97
    }

    // the player's own lights
    const lt = fs.lights || NO_LIGHTS
    F.flash = !!lt.flashlight
    F.glow = Array.isArray(lt.glow) && ld >= 2
    F.flash = F.flash && ld >= 2
    F.glowK = 1.3 * (0.8 + 0.2 * Math.sin((fs.t || 0) * 6.6))

    if (typeof materialAt === 'function') materialHook = materialAt
    refreshOccupancy(fs, isWallFn)
    if (emitters && F.occR) {
      refreshLightmap(fs)
      // lamps flicker one by one at the top tier: while an event is in flight, re-mix the lightmap with each lamp's own level
      F.lampDim = false
      if (lamps && ld >= 2 && eSmooth > 0.002) {
        const R = F.occR, pcx = F.occCx, pcy = F.occCy
        let lo = 1, n = 0
        for (let cy = pcy - R; cy <= pcy + R; cy++) {
          for (let cx = pcx - R; cx <= pcx + R; cx++) {
            const so = slotOf(cx, cy)
            if (cellLamp[so] !== 1) continue
            lampLev[so] = levelRaw(cx, cy, fs)
            bV[n] = lampLev[so]; bW[n] = viewWeight(cx, cy, fs.fog); n++
          }
        }
        const s = budget(bV, bW, n, allowed)
        F.dimS = s
        for (let cy = pcy - R; cy <= pcy + R; cy++) {
          for (let cx = pcx - R; cx <= pcx + R; cx++) {
            const so = slotOf(cx, cy)
            if (cellLamp[so] !== 1) continue
            if (s < 1) lampLev[so] = 1 - s * (1 - lampLev[so])
            if (lampLev[so] < lo) lo = lampLev[so]
          }
        }
        F.lampDim = lo < 0.97
      }
      if (F.lampDim) { remixLightmap(fs, lampLev); lmDirty = true }
      else if (lmDirty) { lampLev.fill(1); remixLightmap(fs, lampLev); lmDirty = false }
    }
    return true
  }

  return light
}

// ── the player's own lights: shared falloffs (the world pass and the sprite-facing queries use the same curves) ────────────────
export const FLASH_I = 3.8             // the flashlight's strength at the centre of the beam, close in (light units: 1 = as lit as the legacy shading)
export const FLASH_PITCH = 0.16       // tangent of the beam's downward pitch
export const FLASH_SX = 0.33, FLASH_SY = 0.30     // beam width (radians, 1/e) across and up/down
export function flashAtt(d) { return 1 / (1 + (d * d) / 9) * (1 - smoothstep(7, 12.5, d)) }
export function glowAtt(d2) { return 1 / (1 + d2 / 2.2) * (1 - smoothstep(9, 38, d2)) }
