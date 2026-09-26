// gfx-gl-post-math.js — the PURE half of the GPU post pass (no GL, no DOM): the decisions and numbers the shaders are fed, mirrored from the CPU post
// stage (gfx-post.js) so they can be unit-tested in Node and compared against it. gfx-gl-post.js owns the GL objects; this file owns the arithmetic.
//
//   postPlan(fs, post, out)         which stages run this frame (the same gates composeFrame / drawBloom / drawGrainModern use)
//   bloomSizes(W, H)                the sizes of the bloom chain: 1/2, 1/4, 1/8 of the frame, and the 1/32 "wide veil" grid (ensureBloom's arithmetic)
//   grainTilePixels(mul, add)       the modern luma-grain tile, byte for byte what buildGrainTile draws (RGBA, straight alpha)
//   legacyGrainPixels()             the legacy 128 px grain tile, byte for byte what gfx-textures.js buildGrain draws (RGBA, opaque grey)
//   grainOffsetModern / grainOffsetLegacy   where the grain sits this frame
//   gainFor(grade)                  the highlight-gain multiplier (or 1,1,1 when the CPU skips the multiply)
//   veilAt(r, A)                    the veil colour/alpha at a normalised radius — the analytic form the shader evaluates (buildVeil bakes it as 13 gradient stops)
//   flashGradient(t) / glowGradient(t, glow, pulse)   the flashlight / glowstick screen gradients as {rgb 0..1, a} (drawLights' colour stops)
import { mulberry32 } from './gfx-util.js'
import {
  modernPost, vignetteAlpha, veilColors, VEIL_A, grainStep, grainOffset, legacyGrainPhase, lightModelLive,
} from './gfx-post.js'

export const GRAIN_TILE = 256          // gfx-post.js GRAIN_TILE (private there)
export const GRAIN_RATE = 24           // gfx-post.js GRAIN_RATE (private there): the grain re-rolls 24 times a second on any display
export const LEGACY_TILE = 128         // gfx-textures.js buildGrain
export const LEGACY_GRAIN_ALPHA = 0.045   // gfx-post.js drawGrain globalAlpha
export const LEGACY_VIGNETTE = { depth: 0.58, r0: 0.12, r1: 0.85 }   // buildVignette: black, alpha 0 -> 0.58, radius 0.12 H -> 0.85 H
export const BLOOM_CONTRAST_LO = 0.1   // (gfx-post.js private) an emitter must out-shine its neighbourhood by this much to glow at all ...
export const BLOOM_CONTRAST_HI = 0.2   // ... and by this much to glow fully

// Which stages run this frame. `out` is reused (no allocation per frame); returns it.
//   modern   the atmosphere pass (every tier above legacy)
//   bloom    the bright-pass bloom runs (tier gate, opts.bloom, the level's own switch, a positive gain)
//   grade    highlight gain + veil (vignette / shadow lift)
//   grain    film grain
//   tape     the optional tape layer
//   parts    particles are on (opts.particles / tier gate / a non-empty field)
//   steam    ... and they are the rising kind, which the CPU draws INTO the low-res frame (before the grade) instead of onto the visible canvas
//   compose  a low-res compose pass is needed at all (legacy without grain is a pure upscale of the scene)
//   flick    the legacy whole-frame blackout overlay's alpha (0 = none)
export function postPlan(fs, post, out = {}) {
  const modern = modernPost(fs), opts = fs.opts || {}, A = post.atmos
  out.modern = modern
  out.bloom = modern && !A.bloom.off && opts.bloom !== false && !!fs.quality.bloom && A.bloom.gain > 0
  out.grade = modern
  out.grain = opts.grain !== false && (modern ? (A.grain.mul > 0 || A.grain.add > 0) : true)
  out.tape = modern && !!opts.tape
  out.parts = !!post.count && opts.particles !== false && (!fs.quality || fs.quality.particles !== false)
  out.steam = out.parts && modern && !!(post.pcfg && post.pcfg.rise)
  out.compose = modern || out.grain
  return out
}

// ── bloom chain sizes (gfx-post.js ensureBloom) ─────────────────────────────────────────────────────────────────────────────
export function bloomSizes(W, H, out = {}) {
  const w1 = Math.max(2, W >> 1), h1 = Math.max(2, H >> 1)
  const w2 = Math.max(2, w1 >> 1), h2 = Math.max(2, h1 >> 1)
  const BW = Math.max(2, w2 >> 1), BH = Math.max(2, h2 >> 1)
  out.w1 = w1; out.h1 = h1; out.w2 = w2; out.h2 = h2; out.BW = BW; out.BH = BH
  out.wW = Math.max(2, BW >> 2); out.wH = Math.max(2, BH >> 2)
  out.sx = BW / out.wW; out.sy = BH / out.wH
  return out
}

// ── grain ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Same PRNG order as gfx-post.js buildGrainTile: per texel one draw for dark/light, then two for the triangular amplitude.
export function grainTilePixels(mul, add, size = GRAIN_TILE) {
  const px = new Uint8Array(size * size * 4)
  const rnd = mulberry32(0x6a41)
  for (let i = 0; i < size * size; i++) {
    const dark = rnd() < 0.5, v = (rnd() + rnd()) * 0.5
    const a = (dark ? mul : add) * v
    const o = i * 4
    px[o] = px[o + 1] = px[o + 2] = dark ? 0 : 255
    px[o + 3] = Math.min(255, Math.round(a * 255))
  }
  return px
}

// gfx-textures.js buildGrain: 128x128 opaque grey noise.
export function legacyGrainPixels() {
  const N = LEGACY_TILE
  const px = new Uint8Array(N * N * 4)
  const rnd = mulberry32(0x51CE)
  for (let i = 0; i < N * N; i++) {
    const v = (rnd() * 255) | 0
    px[i * 4] = v; px[i * 4 + 1] = v; px[i * 4 + 2] = v; px[i * 4 + 3] = 255
  }
  return px
}

// Modern grain: the tile is drawn starting at (-ox, -oy), so screen pixel (x, y) shows tile texel ((x + ox) mod 256, (y + oy) mod 256).
export function grainOffsetModern(t, out = [0, 0]) {
  const o = grainOffset(grainStep(t, GRAIN_RATE), GRAIN_TILE)
  out[0] = o[0]; out[1] = o[1]
  return out
}
// Legacy grain: the pattern is filled after translate(-p, q), so screen pixel (x, y) shows pattern texel ((x + p) mod 128, (y - q) mod 128).
export function grainOffsetLegacy(t, out = [0, 0]) {
  const p = legacyGrainPhase(t), q = (p * 2) & 127
  out[0] = p; out[1] = (LEGACY_TILE - q) & (LEGACY_TILE - 1)
  return out
}

// ── grade ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// drawGrade skips the multiply when every channel is >= 0.995; the shader multiplies always, so hand it exactly 1 then. Otherwise the CPU multiplies by
// a CSS colour (gainCss), i.e. by the gain rounded to a byte: do the same, so the two grades agree to the last level.
export function gainFor(grade, out = [1, 1, 1]) {
  const g = grade.gain
  const skip = !(g[0] < 0.995 || g[1] < 0.995 || g[2] < 0.995)
  for (let i = 0; i < 3; i++) out[i] = skip ? 1 : Math.round(g[i] * 255) / 255
  return out
}

// The veil colour and alpha at normalised radius r (distance from the centre over the half-diagonal): buildVeil's gradient, evaluated exactly
// instead of at 13 stops. colour in 0..1.
export function veilAt(r, A, out = { c: [0, 0, 0], a: 0 }) {
  const { V, D } = veilColors(A.grade)
  const w = vignetteAlpha(r, 1, A.vig.from)
  for (let i = 0; i < 3; i++) out.c[i] = (V[i] + (D[i] - V[i]) * w) / 255
  out.a = VEIL_A + (A.vig.depth - VEIL_A) * w
  return out
}

// ── the player's own light, when the world pass did not do it (drawLights) ──────────────────────────────────────────────────
// t = 0 at the gradient's inner radius, 1 at its outer radius. Canvas gradients interpolate colour and alpha separately (not premultiplied);
// the additive draw then adds colour * alpha.
export const FLASH = { cx: 0.5, cy: 0.52, r0: 0.04, r1: 0.72 }     // centre as a fraction of OW / OH, radii as a fraction of OH
export const GLOW = { cx: 0.5, cy: 0.6, r0: 0.03, r1: 0.62 }
export function flashGradient(t, out = { rgb: [0, 0, 0], a: 0 }) {
  const c0 = [255, 244, 212], c1 = [255, 238, 196]
  if (t < 0.5) { const s = t / 0.5; for (let i = 0; i < 3; i++) out.rgb[i] = (c0[i] + (c1[i] - c0[i]) * s) / 255; out.a = 0.24 + (0.09 - 0.24) * s }
  else { const s = (t - 0.5) / 0.5; for (let i = 0; i < 3; i++) out.rgb[i] = c1[i] * (1 - s) / 255; out.a = 0.09 * (1 - s) }
  return out
}
export function glowPulse(t) { return 0.72 + 0.28 * Math.sin(t * 6.6) }
export function glowGradient(t, glow, pulse, out = { rgb: [0, 0, 0], a: 0 }) {
  for (let i = 0; i < 3; i++) out.rgb[i] = glow[i] * (1 - t) / 255
  out.a = 0.20 * pulse * (1 - t)
  return out
}

// Is the legacy whole-frame blackout drawn? (kept here so the plan and the shader agree on one rule)
export { lightModelLive }

// ── the 2D overlay's redraw gate ──
// The overlay (crosshair, nameplates) is a full-viewport canvas over the GL canvas; touching it makes the browser re-rasterise and re-composite it.
// The crosshair never moves, so with no plates (now or in the last drawn frame) and the same crosshair pref / ui scale / canvas size the picture
// already on it is right: skip. Plates move and change every frame, so any frame with plates redraws (and the frame after the last plate does).
export const newOverlayMemo = () => ({ drawn: false, plates: false, cross: false, u: 1, ow: 0, oh: 0 })
export function overlayUnchanged(m, resized, nPlates, cross, u, ow, oh) {
  return !resized && m.drawn && nPlates === 0 && !m.plates && cross === m.cross && u === m.u && ow === m.ow && oh === m.oh
}
export function overlayRemember(m, nPlates, cross, u, ow, oh) { m.drawn = true; m.plates = nPlates > 0; m.cross = cross; m.u = u; m.ow = ow; m.oh = oh }
