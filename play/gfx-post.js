// gfx-post.js — screen-space stages that run after the world + sprite passes: film grain (on the low-res
// buffer), the bilinear upscale, vignette, flicker blackout, atmospheric particles, the player's flashlight /
// glowstick wash, remote-player nameplates and the crosshair (all at full resolution on the visible canvas).
// No DOM at module scope: import-safe in Node (canvases are only created inside the functions that draw).
//
// `fs` is the frame state built by gfx-cpu.js. `post` is the mutable per-renderer state that gfx-cpu.js
// owns and hands back every frame: { pcfg, count, particles, vignette, grainPattern, grainPhase } — everything else this
// module needs (atmosphere, bloom buffers, particle sprites, tape scratch, …) is allocated lazily inside it.
//
// ── two looks, one pipeline ──────────────────────────────────────────────────────────────────────────────────────
// `legacy` (fs.quality.lightDetail === 0 — the tier `legacy`, the default until Track D flips it) is EXACTLY the
// pre-overhaul output: same grain, same vignette, same flicker overlay, same particles. Only the *clock* changed: grain and
// particles now advance from fs.t / fs.dt (a 144 Hz display no longer runs them 2.4x fast), which at 60 Hz reproduces the
// old frame-counted motion pixel for pixel.
// Every other tier is the atmosphere pass (`modernPost`): a bright-pass bloom (gate: fs.quality.bloom), a per-level
// split-toned grade, a smoother tinted vignette, luma-dependent film grain, depth-reading particles that catch light,
// and — only when fs.opts.tape is set — a very low-contrast "tape" layer. All of it is spatial and low-amplitude: nothing
// here strobes, and nothing brightens the frame by more than a few percent.
//
// Order (modern), everything up to the upscale at LOW resolution (a blend costs ~pixels, and the bilinear upscale is what softens it):
//   bloom (reads the finished frame, blends light back) → highlight gain (multiply) → veil (vignette + shadow lift, source-over) →
//   luma-dependent grain (tile blits) → [tape: chroma fringe] → upscale → [tape: soft focus] → [legacy flicker overlay, unless a
//   light model expresses flicker spatially] → particles → flashlight/glow → nameplates → crosshair.
// Cost (software raster, 1280x720, noisy machine): the modern medium post is ~2 ms CHEAPER than legacy (grain as tile blits instead of a
// pattern fill saves more than the grade costs); bloom (tier high) adds ~2 ms. See the report for the measured numbers.
import { hexToRgb, levelKey, mulberry32, hash2 } from './gfx-util.js'
import { cloudStrip } from './gfx-sky.js'

// The grain phase wraps on this mask. It used to be the wall-tile mask (TS-1) by coincidence; it is pinned
// to 63 here so the grain animation is independent of the texture tile size.
const GRAIN_MASK = 63

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v)
function smoothstep(a, b, x) { const t = x <= a ? 0 : x >= b ? 1 : (x - a) / (b - a); return t * t * (3 - 2 * t) }
const mix = (a, b, t) => a + (b - a) * t

// ══ per-level atmosphere ═════════════════════════════════════════════════════════════════════════════════════════
// Keyed by fs.levelKey ('0'..'3', '∅', 'legacy'); config.look.grade / config.look.post override on top (resolveAtmos).
//   tint     highlight gain BIAS (multiplies the frame; <= 1 per channel, so it can only remove light — a cheap low-res 'multiply')
//   split    shadow-lift direction (normalised)
//   lift     shadow-lift amount, in 0..255 levels at pure black (a few levels: a veil, not a colour cast). Applied as a source-over veil
//            (see buildVeil), so it lifts the darks toward the hue and can never brighten a highlight
//   fogFollow  how far the highlight gain (and the lift hue) follows the CURRENT palette.fog, so a wish-drifted palette is
//            graded toward its own hue instead of being pulled back to the level's stock colour — the grade is palette-relative
//   vig      vignette: depth = darkening at the corners (fraction), from = normalised radius where it starts
//   bloom    bright pass: thr/knee (0..1 luma), gain, wide (share of the wide veil), tint + tintMix (pull toward a lamp colour)
//   grain    mul = peak alpha of the DARK grains (they darken in proportion to the pixel: the lights carry the grain), add = peak alpha of the
//            LIGHT grains (they lift in proportion to how dark the pixel is: the shadows keep crawling)
//   part     particles: temper (pull toward the fog colour), alpha/size scales, ambient/top (how lit the air is on its own),
//            flash (how strongly a flashlight beam lights the dust it passes through)
//   tape     the optional tape layer's strengths: drift (px), fringe (low-res px), soft (blend), used only when opts.tape is on
const NEUTRAL = {
  tint: [1, 1, 1], split: [1, 1, 1], lift: 3, fogFollow: 0.12,
  vig: { depth: 0.5, from: 0.3 },
  bloom: { thr: 0.66, knee: 0.3, gain: 0.5, wide: 0.3, tint: [1, 1, 1], tintMix: 0 },
  grain: { mul: 0.055, add: 0.03 },
  part: { temper: 0.3, alpha: 1, size: 1, ambient: 0.5, top: 0.3, flash: 1.3 },
  tape: { drift: 1.4, fringe: 0.5, soft: 0.16 },
}
export const LEVEL_ATMOS = {
  legacy: NEUTRAL,
  // L0 lobby: warm green-yellow fluorescent light, mono-yellow; the ceiling panels are the emitters worth blooming
  '0': {
    ...NEUTRAL, tint: [0.99, 1.0, 0.97], split: [0.85, 1.0, 0.25], lift: 4, fogFollow: 0.12,
    vig: { depth: 0.55, from: 0.26 },
    bloom: { thr: 0.86, knee: 0.08, gain: 0.42, wide: 0.4, tint: [1, 0.96, 0.66], tintMix: 0.25 },
    grain: { mul: 0.05, add: 0.03 },
    part: { temper: 0.35, alpha: 1, size: 1, ambient: 0.5, top: 0.55, flash: 1.3 },
  },
  // L1 habitable zone: cold sodium-green service light on grey concrete
  '1': {
    ...NEUTRAL, tint: [0.95, 1.0, 0.96], split: [0.35, 1.0, 0.6], lift: 4, fogFollow: 0.1,
    vig: { depth: 0.58, from: 0.25 },
    bloom: { thr: 0.86, knee: 0.08, gain: 0.38, wide: 0.4, tint: [0.86, 1, 0.84], tintMix: 0.22 },
    grain: { mul: 0.055, add: 0.03 },
    part: { temper: 0.3, alpha: 1, size: 1, ambient: 0.4, top: 0.4, flash: 1.5 },
  },
  // L2 pipe dreams: amber emergency lamps in a dark brown tunnel; steam catches the little light there is.
  // (blue is barely trimmed: the exit's cold beam must still read as cold)
  '2': {
    ...NEUTRAL, tint: [1.0, 0.985, 0.965], split: [1.0, 0.5, 0.12], lift: 4, fogFollow: 0.1,
    vig: { depth: 0.62, from: 0.24 },
    bloom: { thr: 0.72, knee: 0.14, gain: 0.42, wide: 0.42, tint: [1, 0.72, 0.36], tintMix: 0.18 },
    grain: { mul: 0.06, add: 0.03 },
    part: { temper: 0.4, alpha: 1.15, size: 1.1, ambient: 0.32, top: 0.18, flash: 1.9 },
  },
  // L3 electrical station: blue-black metal, cold lamps, blue-white arcs
  '3': {
    ...NEUTRAL, tint: [0.92, 0.97, 1.0], split: [0.12, 0.42, 1.0], lift: 4, fogFollow: 0.12,
    vig: { depth: 0.64, from: 0.24 },
    bloom: { thr: 0.7, knee: 0.16, gain: 0.44, wide: 0.42, tint: [0.7, 0.86, 1], tintMix: 0.3 },
    grain: { mul: 0.065, add: 0.028 },
    part: { temper: 0.15, alpha: 1.1, size: 1, ambient: 0.28, top: 0.12, flash: 1.9 },
  },
  // L∅ the block: cool flat overcast daylight, photographic — barely any grade, a light vignette, fine grain, nothing glowing
  '∅': {
    ...NEUTRAL, tint: [0.98, 0.99, 1.0], split: [0.45, 0.7, 1.0], lift: 3, fogFollow: 0.08,
    vig: { depth: 0.46, from: 0.3 },
    bloom: { thr: 0.9, knee: 0.06, gain: 0.24, wide: 0.5, tint: [1, 1, 1], tintMix: 0 },
    grain: { mul: 0.04, add: 0.025 },
    part: { temper: 0.5, alpha: 0.9, size: 1, ambient: 0.62, top: 0.1, flash: 1 },
  },
}

// No channel of the highlight gain may fall below this: a multiply can only remove light, and the game's cold cues (the exit's
// blue beam, another player) live in the very channel a warm grade would remove — 0.95 keeps them cold and readable.
export const GAIN_FLOOR = 0.95
const norm1 = (v) => { const m = Math.max(v[0], v[1], v[2], 1e-6); return [v[0] / m, v[1] / m, v[2] / m] }
const tri = (v, d = [1, 1, 1]) => (Array.isArray(v) && v.length >= 3 ? [+v[0], +v[1], +v[2]] : d)

// The grade for a palette: highlight gain (per channel, <= 1) and shadow lift (per channel, 0..255). Pure. Everything is
// RELATIVE to the palette: the gain leans toward the current fog hue by `fogFollow`, and the lift is the level's split colour
// mixed with the fog hue — so a wish that drifts the palette to another hue is graded toward that hue, not dragged back to
// the stock colour. `strength` (config.look.grade.strength) scales the deviation from neutral; 0 = no grade.
export function resolveGrade(atmos, palette) {
  const fogHex = palette && palette.fog
  const fog = norm1(fogHex ? hexToRgb(fogHex) : [200, 200, 200])
  const s = atmos.gradeStrength == null ? 1 : atmos.gradeStrength
  const ff = atmos.fogFollow
  const gain = [0, 0, 0], lift = [0, 0, 0]
  const dir = norm1([mix(atmos.split[0], fog[0], ff * 1.5), mix(atmos.split[1], fog[1], ff * 1.5), mix(atmos.split[2], fog[2], ff * 1.5)])
  for (let i = 0; i < 3; i++) {
    const g = (1 - ff * (1 - fog[i])) * atmos.tint[i]              // toward the fog hue, then the level's bias
    gain[i] = Math.min(1, Math.max(GAIN_FLOOR, 1 - s * (1 - g)))
    lift[i] = Math.max(0, atmos.lift * s * dir[i])
  }
  return { gain, lift }
}

// Merge the level's atmosphere with config.look.grade / config.look.post and the palette. Pure and cheap: done once.
//   look.grade = { tint:[r,g,b] (replaces the gain bias), split:[r,g,b] (replaces the lift direction), lift, strength, contrast (scales vignette depth) }
//   look.post  = { bloom: 0|scale, grain: scale, vignette: scale, particles: scale, tape: true|{drift,fringe,soft} }
export function resolveAtmos(config) {
  const key = levelKey(config)
  const base = LEVEL_ATMOS[key] || NEUTRAL
  const look = (config && config.look) || {}
  const g = look.grade || {}, p = look.post || {}
  const a = {
    key,
    tint: tri(g.tint, base.tint), split: tri(g.split, base.split),
    lift: typeof g.lift === 'number' ? g.lift : base.lift,
    fogFollow: base.fogFollow,
    gradeStrength: typeof g.strength === 'number' ? g.strength : 1,
    vig: { ...base.vig, depth: clamp01(base.vig.depth * (typeof g.contrast === 'number' ? g.contrast : 1) * (typeof p.vignette === 'number' ? p.vignette : 1)) },
    bloom: { ...base.bloom, gain: base.bloom.gain * (typeof p.bloom === 'number' ? p.bloom : 1), off: p.bloom === 0 || p.bloom === false },
    grain: { mul: base.grain.mul * (typeof p.grain === 'number' ? p.grain : 1), add: base.grain.add * (typeof p.grain === 'number' ? p.grain : 1) },
    part: { ...base.part, alpha: base.part.alpha * (typeof p.particles === 'number' ? p.particles : 1) },
    tape: { ...base.tape, ...(p.tape && typeof p.tape === 'object' ? p.tape : null) },
  }
  a.grade = resolveGrade(a, config && config.palette)
  const gn = a.grade.gain
  a.gainCss = `rgb(${Math.round(gn[0] * 255)},${Math.round(gn[1] * 255)},${Math.round(gn[2] * 255)})`   // the multiply colour, built once
  return a
}

// ══ pure helpers (unit-tested) ═══════════════════════════════════════════════════════════════════════════════════
// Bloom bright-pass weight for a 0..1 luma: 0 below `thr`, a smooth knee up to 1 at thr+knee.
export function brightWeight(luma, thr, knee) { return smoothstep(thr, thr + Math.max(1e-6, knee), luma) }

// The luma used to decide what glows: half Rec.601 luma, half the peak channel (so a saturated cold beam or a lamp colour
// that is bright in one channel still counts). 0..1 in, 0..1 out.
export function emitterLuma(r, g, b) {
  const l = 0.299 * r + 0.587 * g + 0.114 * b
  const m = r > g ? (r > b ? r : b) : (g > b ? g : b)
  return 0.5 * l + 0.5 * m
}

// Separable [1 4 6 4 1]/16 blur of an interleaved 3-channel float plane (w x h x 3), edges clamped. Reads P, uses `tmp` (same size) for the
// horizontal pass and writes the result back into P. Pure; the loops are flat (no per-tap function calls) because this runs every bloom frame.
export function blur5x3(P, tmp, w, h) {
  const s3 = w * 3
  for (let y = 0; y < h; y++) {
    const row = y * s3
    for (let x = 0; x < w; x++) {
      const i = row + x * 3
      const a = row + (x < 2 ? 0 : x - 2) * 3, b = row + (x < 1 ? 0 : x - 1) * 3, d = row + (x > w - 2 ? w - 1 : x + 1) * 3, e = row + (x > w - 3 ? w - 1 : x + 2) * 3
      tmp[i] = (P[a] + P[e] + 4 * (P[b] + P[d]) + 6 * P[i]) * 0.0625
      tmp[i + 1] = (P[a + 1] + P[e + 1] + 4 * (P[b + 1] + P[d + 1]) + 6 * P[i + 1]) * 0.0625
      tmp[i + 2] = (P[a + 2] + P[e + 2] + 4 * (P[b + 2] + P[d + 2]) + 6 * P[i + 2]) * 0.0625
    }
  }
  for (let y = 0; y < h; y++) {
    const ra = (y < 2 ? 0 : y - 2) * s3, rb = (y < 1 ? 0 : y - 1) * s3, ri = y * s3, rd = (y > h - 2 ? h - 1 : y + 1) * s3, re = (y > h - 3 ? h - 1 : y + 2) * s3
    for (let x = 0; x < s3; x++) P[ri + x] = (tmp[ra + x] + tmp[re + x] + 4 * (tmp[rb + x] + tmp[rd + x]) + 6 * tmp[ri + x]) * 0.0625
  }
}

// Film-rate step for the animated grain: the grain pattern hops at `rate` steps per second regardless of the display rate.
export function grainStep(t, rate) { return Math.floor(t * rate + 1e-9) }
// The offset (into a `size`-square tile) the grain sits at for a step: hashed, so it is unrelated step to step.
export function grainOffset(step, size) { const h = hash2(step, 0x9e37, 0x51ed); return [h % size, (h >>> 12) % size] }

// The legacy grain phase, as a pure function of time: the old code added 37 per frame at (an assumed) 60 fps and masked with 63.
export function legacyGrainPhase(t) { return (37 * Math.round(t * 60)) & GRAIN_MASK }

// Is a light model expressing flicker spatially? Then the whole-frame blackout overlay must not be drawn on top of it
// (flicker would be applied twice, and unboundedly).
// show that path before the real light model lands; the game never sets it.
export function lightModelLive(fs) { return !!(fs.light && fs.light.enabled) }

// The alpha of the legacy whole-frame black overlay for this frame (0 = none). 1 - flicker, times 0.75, only in a dip.
// The world is ALREADY multiplied by fs.flicker (the comfort-clamped scalar), so under a comfort clamp the overlay only gets what
// is left of the budget: flicker * (1 - a) >= 1 - maxGlobalDip, i.e. the combined factor never falls below the documented floor
// (>= 0.75 with reduceFlicker). Unclamped (maxGlobalDip 1: the harness baseline) it is the old formula, unchanged.
export function flickerOverlayAlpha(fs) {
  if (lightModelLive(fs)) return 0
  if (!(fs.flicker < 0.9)) return 0
  const a = (1 - fs.flicker) * 0.75
  const dip = fs.comfort && fs.comfort.maxGlobalDip
  if (!(dip < 1)) return a
  return Math.max(0, Math.min(a, 1 - (1 - dip) / Math.max(fs.flicker, 0.01)))
}

// Which look? Every tier above `legacy` (lightDetail > 0) gets the atmosphere pass. One line to change if the tiers grow a
// dedicated post field.
export function modernPost(fs) { return !!(fs.quality && fs.quality.lightDetail > 0) }

// ══ state ════════════════════════════════════════════════════════════════════════════════════════════════════════
export function createPostState(config) {
  // ── atmospheric particles: dust motes, rising steam, or electrical sparks ──
  const pcfg = config.particles || {}
  const count = Math.max(0, pcfg.count ?? 0)
  if (config.sky) cloudStrip()      // an outdoor level: bake the cloud strip now (~0.1 s) rather than on the first frame of play
  return { pcfg, count, particles: [], vignette: null, grainPattern: null, grainPhase: 0, atmos: resolveAtmos(config), fogHex: config.palette && config.palette.fog }
}

export function seedParticles(post, winW, winH) {
  const particles = post.particles
  particles.length = 0
  // the extra per-particle fields come from their own PRNG so the legacy positions (Math.random, drawn in the old order)
  // are unchanged
  const rnd = mulberry32(0x5eed + winW * 31 + winH)
  for (let i = 0; i < post.count; i++) {
    const p = { x: Math.random() * winW, y: Math.random() * winH, z: 0.35 + Math.random() * 0.65, ph: Math.random() * 6.283 }
    p.s = 0.8 + rnd() * 0.5          // size jitter
    p.a = 0.75 + rnd() * 0.5         // brightness jitter
    p.w = rnd()                      // a stable random number (spark timing, drift variety)
    particles.push(p)
  }
  post.rng = mulberry32(0xd057 + winW * 17 + winH * 3)   // respawn positions for the modern particles
}

const canvasFactory = () => (typeof document !== 'undefined' ? (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c } : null)

// precompute the vignette once (full-res, drawn over the upscaled world) — the legacy one
export function buildVignette(W, H) {
  const vignette = document.createElement('canvas')
  vignette.width = W; vignette.height = H
  const vg = vignette.getContext('2d')
  const grad = vg.createRadialGradient(W / 2, H / 2, H * 0.12, W / 2, H / 2, H * 0.85)
  grad.addColorStop(0, 'rgba(0,0,0,0)')
  grad.addColorStop(1, 'rgba(0,0,0,0.58)')
  vg.fillStyle = grad
  vg.fillRect(0, 0, W, H)
  return vignette
}

// The vignette falloff: 0 in the middle of the frame, 1 at the corners (r = distance from the centre over the half-diagonal).
// A smooth S from `from`, so the middle of the frame is clean and the darkening gathers toward the corners.
export function vignetteAlpha(r, depth, from) { return depth * Math.pow(smoothstep(from, 1.02, r), 1.3) }

// The modern vignette AND shadow lift, as ONE low-res source-over veil (cheap: a plain alpha blit; the 'multiply' overlay this
// replaced cost 4x as much in software raster). Toward the corners it falls to a tinted near-black; everywhere else it blends a few
// percent toward the level's veil colour, which lifts the blacks toward that hue — and, being a blend, can never brighten a highlight.
export const VEIL_A = 0.05
export function veilColors(grade) { return { V: grade.lift.map((v) => Math.min(255, v / VEIL_A)), D: grade.lift.map((v) => v * 0.4) } }
export function buildVeil(mk, W, H, grade, vig) {
  const c = mk(W, H)
  const g = c.getContext('2d')
  const { V, D } = veilColors(grade)
  const R = 0.5 * Math.hypot(W, H)
  const grad = g.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, R)
  for (let i = 0; i <= 12; i++) {
    const r = i / 12, w = vignetteAlpha(r, 1, vig.from)
    grad.addColorStop(r, `rgba(${Math.round(mix(V[0], D[0], w))},${Math.round(mix(V[1], D[1], w))},${Math.round(mix(V[2], D[2], w))},${mix(VEIL_A, vig.depth, w).toFixed(4)})`)
  }
  g.fillStyle = grad
  g.fillRect(0, 0, W, H)
  return c
}

// ══ film grain ═══════════════════════════════════════════════════════════════════════════════════════════════════
// legacy: plain source-over noise (no 'overlay' blend, which is a heavy per-frame full-screen composite that can stress the
// GPU/driver over time. The tile textures already carry baked static grain; this just adds motion.)
export function drawGrain(wctx, fs, post) {
  const { W, H, opts } = fs
  const grainPattern = post.grainPattern
  if (grainPattern && opts.grain !== false) {
    // the phase follows the CLOCK, not the frame count: 37 per 1/60 s, exactly as before at 60 fps
    post.grainPhase = legacyGrainPhase(fs.t)
    const grainPhase = post.grainPhase
    wctx.save()
    wctx.globalAlpha = 0.045
    wctx.fillStyle = grainPattern
    wctx.translate(-grainPhase, (grainPhase * 2) & 127)
    wctx.fillRect(grainPhase, -((grainPhase * 2) & 127), W + 128, H + 128)
    wctx.restore()
  }
}

const GRAIN_TILE = 256
const GRAIN_RATE = 24              // film-rate: the grain re-rolls 24 times a second on any display
// One RGBA tile of two kinds of grain, drawn with plain source-over: DARK grains (black, alpha up to mul) darken in proportion to the pixel
// they land on — so the lights carry the grain — and LIGHT grains (white, alpha up to add) lift a pixel in proportion to how dark it is —
// so the shadows keep crawling. Together that is luma-dependent grain, in ONE blit set (a pattern fill of the same size cost 8x more).
export function buildGrainTile(mk, mul, add) {
  const c = mk(GRAIN_TILE, GRAIN_TILE)
  const g = c.getContext('2d')
  const img = g.createImageData(GRAIN_TILE, GRAIN_TILE)
  const rnd = mulberry32(0x6a41)
  for (let i = 0; i < GRAIN_TILE * GRAIN_TILE; i++) {
    const dark = rnd() < 0.5, v = (rnd() + rnd()) * 0.5                    // triangular: soft, no salt-and-pepper outliers
    const a = (dark ? mul : add) * v
    const o = i * 4
    img.data[o] = img.data[o + 1] = img.data[o + 2] = dark ? 0 : 255
    img.data[o + 3] = Math.min(255, Math.round(a * 255))
  }
  g.putImageData(img, 0, 0)
  return c
}

export function drawGrainModern(wctx, fs, post) {
  const { W, H, opts, t } = fs
  if (opts.grain === false) return
  const A = post.atmos.grain
  if (!(A.mul > 0 || A.add > 0)) return
  const mk = canvasFactory()
  if (!mk) return
  if (!post.grainTile) post.grainTile = buildGrainTile(mk, A.mul, A.add)
  const [ox, oy] = grainOffset(grainStep(t, GRAIN_RATE), GRAIN_TILE)
  const tile = post.grainTile
  for (let y = -oy; y < H; y += GRAIN_TILE) for (let x = -ox; x < W; x += GRAIN_TILE) wctx.drawImage(tile, x, y)
}

// the grade, at low res: the highlight gain ('multiply' — the one op that tints in proportion to brightness; skipped when it is
// neutral) then the veil (vignette + shadow lift). Both are cheaper here than at full res by the pixel ratio.
export function drawGrade(wctx, fs, post) {
  const A = post.atmos, gn = A.grade.gain, W = fs.W, H = fs.H
  if (gn[0] < 0.995 || gn[1] < 0.995 || gn[2] < 0.995) {
    wctx.save()
    wctx.globalCompositeOperation = 'multiply'
    wctx.fillStyle = A.gainCss
    wctx.fillRect(0, 0, W, H)
    wctx.restore()
  }
  const mk = canvasFactory()
  if (!mk) return
  if (post.veilW !== W || post.veilH !== H) { post.veilW = W; post.veilH = H; post.veil = buildVeil(mk, W, H, A.grade, A.vig) }   // (the atmosphere is fixed per renderer: only the size can change)
  wctx.drawImage(post.veil, 0, 0)
}

// ══ bloom ════════════════════════════════════════════════════════════════════════════════════════════════════════
function ensureBloom(post, RW, RH, mk) {
  let bl = post.bloom
  if (bl && bl.RW === RW && bl.RH === RH) return bl
  const w1 = Math.max(2, RW >> 1), h1 = Math.max(2, RH >> 1)
  const w2 = Math.max(2, w1 >> 1), h2 = Math.max(2, h1 >> 1)
  const BW = Math.max(2, w2 >> 1), BH = Math.max(2, h2 >> 1)
  const n = BW * BH
  const cOut = mk(BW, BH)
  const gOut = cOut.getContext('2d')
  const wW = Math.max(2, BW >> 2), wH = Math.max(2, BH >> 2)
  bl = post.bloom = {
    RW, RH, BW, BH, wW, wH, have: false, t: 0, ang: 0,
    c1: mk(w1, h1), c2: mk(w2, h2), c3: mk(BW, BH), cOut, gOut, imgOut: gOut.createImageData(BW, BH),
    up1: mk(BW * 2, BH * 2), up2: mk(BW * 4, BH * 4),
    P: new Float32Array(n * 3), tmp: new Float32Array(n * 3), luma: new Uint8Array(n),
    W: new Float32Array(wW * wH * 3), wtmp: new Float32Array(wW * wH * 3),
  }
  // g3 is the one context we getImageData from every recompute: tell the browser so it keeps that tiny canvas in CPU memory (a GPU-backed
  // one would flush the pipeline 25x a second). Nothing else about it changes.
  bl.g1 = bl.c1.getContext('2d'); bl.g2 = bl.c2.getContext('2d'); bl.g3 = bl.c3.getContext('2d', { willReadFrequently: true })
  bl.gu1 = bl.up1.getContext('2d'); bl.gu2 = bl.up2.getContext('2d')
  bl.g1.imageSmoothingEnabled = bl.g2.imageSmoothingEnabled = bl.g3.imageSmoothingEnabled = bl.gu1.imageSmoothingEnabled = bl.gu2.imageSmoothingEnabled = true
  return bl
}

const BLOOM_IDLE = 3                // frames skipped after an empty pass
const BLOOM_CONTRAST_LO = 0.1       // an emitter must out-shine its neighbourhood's average by this much to glow at all ...
const BLOOM_CONTRAST_HI = 0.2       // ... and by this much to glow fully (luma, 0..1)
const BLOOM_PERIOD = 0.04           // seconds between recomputes (25 Hz on any display); frames in between reuse the halo
// The bright pass + blurs on the tiny (1/8) frame -> a halo image in `bl.imgOut` (RGBA, alpha = light intensity, rgb = its colour).
// Returns false if nothing was bright. Pure CPU; everything it reads is `px` (RGBA bytes of the tiny frame).
export function bloomField(bl, px, A) {
  const { BW, BH, wW, wH, P, tmp, luma, W: WP, wtmp } = bl
  const L = bl.L || (bl.L = new Float32Array(BW * BH)), M = bl.M || (bl.M = new Float32Array(wW * wH * 3)), Mt = bl.Mt || (bl.Mt = new Float32Array(wW * wH * 3))
  const thr = A.thr, knee = A.knee, tm = A.tintMix, T = A.tint
  const inv255 = 1 / 255
  const sx = BW / wW, sy = BH / wH
  // pass 1: each tiny pixel's emitter luma, and the frame's LOCAL AVERAGE brightness (a coarse box grid, blurred wide)
  for (let i = 0, n = BW * BH; i < n; i++) {
    const l = emitterLuma(px[i * 4] * inv255, px[i * 4 + 1] * inv255, px[i * 4 + 2] * inv255)
    L[i] = l; luma[i] = (l * 255 + 0.5) | 0
  }
  for (let y = 0; y < wH; y++) {
    for (let x = 0; x < wW; x++) {
      let a = 0, c = 0
      const x0 = (x * sx) | 0, x1 = Math.min(BW, Math.ceil((x + 1) * sx)), y0 = (y * sy) | 0, y1 = Math.min(BH, Math.ceil((y + 1) * sy))
      for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) { a += L[yy * BW + xx]; c++ }
      const o = (y * wW + x) * 3, v = c ? a / c : 0
      M[o] = M[o + 1] = M[o + 2] = v
    }
  }
  blur5x3(M, Mt, wW, wH)
  // pass 2: the bright pass. A pixel is an EMITTER only if it is bright AND clearly brighter than its neighbourhood. Brightness alone
  // cannot tell a ceiling panel from the lit wall beside it (both are ~0.9 in a low-dynamic-range frame), and a big close panel filling the
  // corner of the view has no neighbourhood contrast at all: gating on contrast blooms the small/distant emitters and the panel edges, and
  // leaves broad bright surfaces alone (they used to be washed out to a flat pale 'blob').
  let any = 0
  for (let y = 0; y < BH; y++) {
    const fy = Math.min(wH - 1, Math.max(0, (y + 0.5) / sy - 0.5)), y0 = fy | 0, y1 = Math.min(wH - 1, y0 + 1), ty = fy - y0
    for (let x = 0; x < BW; x++) {
      const i = y * BW + x, o = i * 3, l = L[i]
      let w = brightWeight(l, thr, knee)
      if (w > 0) {
        const fx = Math.min(wW - 1, Math.max(0, (x + 0.5) / sx - 0.5)), x0 = fx | 0, x1 = Math.min(wW - 1, x0 + 1), tx = fx - x0
        const m = (M[(y0 * wW + x0) * 3] * (1 - tx) + M[(y0 * wW + x1) * 3] * tx) * (1 - ty) + (M[(y1 * wW + x0) * 3] * (1 - tx) + M[(y1 * wW + x1) * 3] * tx) * ty
        w *= smoothstep(BLOOM_CONTRAST_LO, BLOOM_CONTRAST_HI, l - m)
      }
      if (w > 0) {
        const r = px[i * 4] * inv255, g = px[i * 4 + 1] * inv255, b = px[i * 4 + 2] * inv255
        // the emitted light keeps the pixel's hue, pulled toward the lamp colour by tintMix (still scaled by its own brightness)
        const s = w * l
        P[o] = mix(r * w, T[0] * s, tm); P[o + 1] = mix(g * w, T[1] * s, tm); P[o + 2] = mix(b * w, T[2] * s, tm)
        any = 1
      } else { P[o] = 0; P[o + 1] = 0; P[o + 2] = 0 }
    }
  }
  if (!any) return false
  // the wide veil: 4x4 box down, blurred (its own blur hides the blockiness), read back bilinearly below
  for (let y = 0; y < wH; y++) {
    for (let x = 0; x < wW; x++) {
      let r = 0, g = 0, b = 0, c = 0
      const x0 = (x * sx) | 0, x1 = Math.min(BW, Math.ceil((x + 1) * sx)), y0 = (y * sy) | 0, y1 = Math.min(BH, Math.ceil((y + 1) * sy))
      for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) { const i = (yy * BW + xx) * 3; r += P[i]; g += P[i + 1]; b += P[i + 2]; c++ }
      const k = c ? 1 / c : 0, o = (y * wW + x) * 3
      WP[o] = r * k; WP[o + 1] = g * k; WP[o + 2] = b * k
    }
  }
  blur5x3(WP, wtmp, wW, wH)
  blur5x3(P, tmp, BW, BH)
  const out = bl.imgOut.data
  const gA = A.gain, gW = A.gain * A.wide
  for (let y = 0; y < BH; y++) {
    const fy = Math.min(wH - 1, Math.max(0, (y + 0.5) / sy - 0.5)), y0 = fy | 0, y1 = Math.min(wH - 1, y0 + 1), ty = fy - y0
    for (let x = 0; x < BW; x++) {
      const fx = Math.min(wW - 1, Math.max(0, (x + 0.5) / sx - 0.5)), x0 = fx | 0, x1 = Math.min(wW - 1, x0 + 1), tx = fx - x0
      const a = (y0 * wW + x0) * 3, b = (y0 * wW + x1) * 3, c = (y1 * wW + x0) * 3, d = (y1 * wW + x1) * 3
      const w00 = (1 - tx) * (1 - ty), w10 = tx * (1 - ty), w01 = (1 - tx) * ty, w11 = tx * ty
      const o = (y * BW + x) * 3, q = (y * BW + x) * 4
      const lr = P[o] * gA + (WP[a] * w00 + WP[b] * w10 + WP[c] * w01 + WP[d] * w11) * gW
      const lg = P[o + 1] * gA + (WP[a + 1] * w00 + WP[b + 1] * w10 + WP[c + 1] * w01 + WP[d + 1] * w11) * gW
      const lb = P[o + 2] * gA + (WP[a + 2] * w00 + WP[b + 2] * w10 + WP[c + 2] * w01 + WP[d + 2] * w11) * gW
      // light -> (colour, alpha): source-over of this over the frame ~ screen(frame, light), at a fraction of the blend cost
      const I = lr > lg ? (lr > lb ? lr : lb) : (lg > lb ? lg : lb)
      if (I < 0.002) { out[q] = out[q + 1] = out[q + 2] = out[q + 3] = 0; continue }
      const k = 255 / I
      out[q] = lr * k > 255 ? 255 : lr * k; out[q + 1] = lg * k > 255 ? 255 : lg * k; out[q + 2] = lb * k > 255 ? 255 : lb * k
      out[q + 3] = I >= 1 ? 255 : I * 255
    }
  }
  return true
}

// A low-resolution bright-pass composite. The finished low-res frame (world + sprites) is box-downsampled 8x by three GPU-friendly
// halving blits, ONE tiny read-back (~8k pixels) feeds a CPU bright pass + blurs (a tight halo and a wide veil), and the halo is
// blended back over the low-res frame — before the bilinear upscale, so it is as soft as the upscale makes it and costs a low-res blend,
// not a full-res one. Because it works from the pixels it needs no geometry: it blooms ceiling panels, lit windows, the exit beam and a
// lamp-lit prop alike, and is occluded by walls for free. It is recomputed at 25 Hz (a halo is soft and slow) and the frames in
// between reuse it, shifted by the camera's turn since, so it never trails a fast look.
export function drawBloom(wctx, world, fs, post) {
  const A = post.atmos.bloom
  if (A.off || fs.opts.bloom === false || !fs.quality.bloom || A.gain <= 0) return
  const mk = canvasFactory()
  if (!mk) return
  // a dark level has nothing to bloom: after an empty pass, skip the (cheap but not free) downsample + read-back for a few frames
  if (post.bloomIdle > 0) { post.bloomIdle--; return }
  const RW = fs.W, RH = fs.H
  const bl = ensureBloom(post, RW, RH, mk)
  const ang = fs.player ? fs.player.angle : 0
  if (!bl.have || fs.t - bl.t >= BLOOM_PERIOD || fs.t < bl.t) {
    const { BW, BH, g1, g2, g3 } = bl
    g1.drawImage(world, 0, 0, RW, RH, 0, 0, bl.c1.width, bl.c1.height)
    g2.drawImage(bl.c1, 0, 0, bl.c1.width, bl.c1.height, 0, 0, bl.c2.width, bl.c2.height)
    g3.drawImage(bl.c2, 0, 0, bl.c2.width, bl.c2.height, 0, 0, BW, BH)
    const ok = bloomField(bl, g3.getImageData(0, 0, BW, BH).data, A)
    post.bloomLive = true                                          // the frame's brightness map (bl.luma) is valid
    if (!ok) { bl.have = false; post.bloomIdle = BLOOM_IDLE; return }
    bl.gOut.putImageData(bl.imgOut, 0, 0)
    // back up: two cheap smoothed doublings (small destinations); a smoothed scale onto the full low-res frame costs ~4x a nearest one
    // 'copy', not the default source-over: the halo canvases are reused every recompute, and source-over left the previous halo behind wherever
    // the new one is faint - it accumulated to opaque, drifting to pure yellow (blue quantises out of a faint premultiplied colour first): the
    // flat 'blobs' with chunky yellow rims. (Invisible in the harness until it advanced fs.t, because a fixed t only ever computes one halo.)
    bl.gu1.globalCompositeOperation = 'copy'; bl.gu2.globalCompositeOperation = 'copy'
    bl.gu1.drawImage(bl.cOut, 0, 0, BW, BH, 0, 0, bl.up1.width, bl.up1.height)
    bl.gu2.drawImage(bl.up1, 0, 0, bl.up1.width, bl.up1.height, 0, 0, bl.up2.width, bl.up2.height)
    bl.have = true; bl.t = fs.t; bl.ang = ang
  } else post.bloomLive = true
  const dx = -wrapPi(ang - bl.ang) * (RW / (fs.fov || 1.3))
  wctx.save()
  wctx.imageSmoothingEnabled = true
  // SCREEN: the halo is light, but light on an already-bright pixel must not clip it flat. Plain add saturated a lit panel / wall to white
  // and lost its texture; screen (1-(1-frame)(1-halo)) brightens the dark surroundings almost like an add and leaves a bright pixel's
  // detail alone. (It was source-over first, which replaced the frame with the halo colour: an opaque pale-yellow cloud.)
  wctx.globalCompositeOperation = 'screen'
  wctx.drawImage(bl.up2, 0, 0, bl.up2.width, bl.up2.height, dx, 0, RW, RH)
  wctx.restore()
}

// ══ the tape layer (opt-in, fs.opts.tape) ═══════════════════════════════════════════════════════════════════════
// A very low-contrast nod to a security-tape / camcorder look: a slow gate drift (the whole picture wanders a pixel or two,
// on a ~15 s sine — never a roll), a faint red/blue fringe that separates by half a low-res pixel, and a touch of soft focus.
// No bars, no tracking noise, no flashing. Off unless the pref is set; the cost is only paid when it is on.
function tapeOn(fs) { return !!(fs.opts && fs.opts.tape) }
function tapeDrift(t, amp) { return Math.sin(t * 0.42 + Math.sin(t * 0.13) * 1.7) * amp }

function drawTapeFringe(wctx, world, fs, post) {
  const mk = canvasFactory()
  if (!mk) return
  const RW = fs.W, RH = fs.H, d = post.atmos.tape.fringe
  if (d <= 0) return
  let tp = post.tape
  if (!tp || tp.w !== RW || tp.h !== RH) {
    tp = post.tape = { w: RW, h: RH, cr: mk(RW, RH), cb: mk(RW, RH), half: mk(Math.max(2, RW >> 1), Math.max(2, RH >> 1)) }
    tp.gr = tp.cr.getContext('2d'); tp.gb = tp.cb.getContext('2d'); tp.gh = tp.half.getContext('2d')
  }
  // red-only and blue-only copies of the frame
  tp.gr.globalCompositeOperation = 'source-over'; tp.gr.drawImage(world, 0, 0)
  tp.gr.globalCompositeOperation = 'multiply'; tp.gr.fillStyle = '#f00'; tp.gr.fillRect(0, 0, RW, RH)
  tp.gb.globalCompositeOperation = 'source-over'; tp.gb.drawImage(world, 0, 0)
  tp.gb.globalCompositeOperation = 'multiply'; tp.gb.fillStyle = '#00f'; tp.gb.fillRect(0, 0, RW, RH)
  // keep only green in the frame, then add red back nudged right and blue back nudged left
  wctx.save()
  wctx.globalCompositeOperation = 'multiply'; wctx.fillStyle = '#0f0'; wctx.fillRect(0, 0, RW, RH)
  wctx.globalCompositeOperation = 'lighter'
  wctx.drawImage(tp.cr, d, 0)
  wctx.drawImage(tp.cb, -d, 0)
  wctx.restore()
}

// soft focus: a half-res copy blended back over the upscaled frame at low alpha
function drawTapeSoft(ctx, world, fs, post) {
  const tp = post.tape, s = post.atmos.tape.soft
  if (!tp || s <= 0) return
  tp.gh.imageSmoothingEnabled = true
  tp.gh.drawImage(world, 0, 0, fs.W, fs.H, 0, 0, tp.half.width, tp.half.height)
  ctx.save()
  ctx.globalAlpha = s
  ctx.imageSmoothingEnabled = true
  ctx.drawImage(tp.half, 0, 0, tp.half.width, tp.half.height, 0, 0, fs.OW, fs.OH)
  ctx.restore()
}

// ══ upscale ══════════════════════════════════════════════════════════════════════════════════════════════════════
// upscale the world buffer to the window (bilinear softens it into fog). With the tape layer on, the picture drifts a couple of
// pixels on a slow sine (drawn 3 px over-size on each side so the edges never show).
export function upscale(ctx, world, fs, post) {
  const { W: RW, H: RH, OW, OH } = fs
  ctx.imageSmoothingEnabled = true
  if (post && modernPost(fs) && tapeOn(fs)) {
    const dx = tapeDrift(fs.t, post.atmos.tape.drift)
    ctx.drawImage(world, 0, 0, RW, RH, dx - 3, 0, OW + 6, OH)
    return
  }
  ctx.drawImage(world, 0, 0, RW, RH, 0, 0, OW, OH)
}

// ══ vignette + flicker blackout ══════════════════════════════════════════════════════════════════════════════════
// The legacy vignette (precomputed) + the flicker blackout, at full resolution. The blackout is the legacy way of expressing a flicker
// dip: a full-window black overlay on top of a world that is ALREADY dimmed by the same scalar — i.e. flicker applied twice. When a
// light model is live it expresses flicker spatially (per panel), so the overlay is skipped entirely.
export function drawVignette(ctx, fs, post) {
  if (post.vignette) ctx.drawImage(post.vignette, 0, 0)
  drawFlickerOverlay(ctx, fs)
}
// (the modern tiers draw their vignette inside the low-res veil — see drawGrade — and only need this half)
export function drawFlickerOverlay(ctx, fs) {
  const a = flickerOverlayAlpha(fs)
  if (a > 0) {
    ctx.fillStyle = `rgba(0,0,0,${a})`
    ctx.fillRect(0, 0, fs.OW, fs.OH)
  }
}

// ══ particles ════════════════════════════════════════════════════════════════════════════════════════════════════
// legacy: 45 dots that fall/rise on a per-frame step. Now scaled by dt (60 steps/s), so a fast display no longer runs them fast.
function drawParticlesLegacy(ctx, fs, post) {
  const { OW, OH, flicker } = fs
  const { pcfg, particles } = post
  const k = Math.min(0.1, fs.dt) * 60                              // 1 at 60 fps
  const col = pcfg.color || [225, 220, 200]
  const cs = `${col[0]},${col[1]},${col[2]}`
  const rise = !!pcfg.rise, spark = !!pcfg.spark
  const sway = pcfg.sway ?? 0.3, speed = pcfg.speed ?? 0.3, baseSize = pcfg.size ?? 1.4
  ctx.save()
  ctx.fillStyle = `rgb(${cs})`
  for (const p of particles) {
    p.ph += 0.02 * k
    p.x += Math.sin(p.ph) * sway * p.z * k
    p.y += (rise ? -1 : 1) * speed * (0.5 + p.z) * k
    if (p.y < -8)      { p.y = OH + 8; p.x = Math.random() * OW }
    else if (p.y > OH + 8) { p.y = -8; p.x = Math.random() * OW }
    if (p.x < -8) p.x = OW + 8; else if (p.x > OW + 8) p.x = -8
    const flick = spark ? (0.25 + 0.75 * Math.abs(Math.sin(p.ph * 4))) : 1
    ctx.globalAlpha = (spark ? 0.7 : 0.28) * (0.4 + 0.6 * p.z) * flick * flicker
    ctx.beginPath(); ctx.arc(p.x, p.y, baseSize * (0.6 + p.z), 0, 6.283); ctx.fill()
  }
  ctx.restore()
}

// soft radial sprites, pre-rendered once per colour (a `drawImage` of a 32 px canvas replaces a path fill per particle)
const SPR = 32
function buildSprite(mk, kind, rgb) {
  const c = mk(SPR, SPR)
  const g = c.getContext('2d')
  const cx = SPR / 2, col = `${rgb[0] | 0},${rgb[1] | 0},${rgb[2] | 0}`
  const blob = (x, y, r, a) => {
    const gr = g.createRadialGradient(x, y, 0, x, y, r)
    gr.addColorStop(0, `rgba(${col},${a})`); gr.addColorStop(0.3, `rgba(${col},${a * 0.7})`)
    gr.addColorStop(0.65, `rgba(${col},${a * 0.2})`); gr.addColorStop(1, `rgba(${col},0)`)
    g.fillStyle = gr; g.fillRect(0, 0, SPR, SPR)
  }
  if (kind === 'steam') {           // an irregular wisp: three offset lobes
    blob(cx, cx, SPR * 0.5, 0.55); blob(cx - 4, cx + 3, SPR * 0.32, 0.4); blob(cx + 5, cx - 4, SPR * 0.28, 0.35)
  } else if (kind === 'spark') {    // a hot core with a tight halo
    blob(cx, cx, SPR * 0.5, 0.45)
    const gr = g.createRadialGradient(cx, cx, 0, cx, cx, SPR * 0.16)
    gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(1, `rgba(${col},0)`)
    g.fillStyle = gr; g.fillRect(0, 0, SPR, SPR)
  } else blob(cx, cx, SPR * 0.5, 1)  // dust: a soft disc
  return c
}

function ensureSprites(post, fs, mk) {
  const P = post.pcfg, A = post.atmos.part
  const fogHex = post.fogHex
  const fog = fogHex ? hexToRgb(fogHex) : [200, 200, 190]
  const base = P.color || [225, 220, 200]
  const rgb = [mix(base[0], fog[0], A.temper), mix(base[1], fog[1], A.temper), mix(base[2], fog[2], A.temper)]
  const kind = P.spark ? 'spark' : P.rise ? 'steam' : 'dust'
  const key = `${kind}|${rgb.map((v) => v | 0)}`
  if (post.spr && post.spr.key === key) return post.spr
  post.spr = { key, kind, rgb, tex: buildSprite(mk, kind, rgb), css: `rgb(${rgb[0] | 0},${rgb[1] | 0},${rgb[2] | 0})`, glowKey: '', glowTex: null }
  return post.spr
}

const wrapPi = (a) => { a = (a + Math.PI) % (2 * Math.PI); if (a < 0) a += 2 * Math.PI; return a - Math.PI }

// How lit the air is at a screen point: an ambient term, the ceiling fixtures overhead, the player's flashlight cone, a glowstick
// radius — and, when the bloom pass has measured the frame, the frame's own brightness there (dust glows where the scene does).
// Writes { L, g } into `out`: light amount and how much of it is the glowstick's (for tinting). Pure given its inputs.
export function airLight(x, y, OW, OH, A, lights, frameLuma, out) {
  let L = A.ambient + A.top * (1 - y / OH)
  if (lights && lights.flashlight) {
    const dx = (x - OW * 0.5) / (OW * 0.24), dy = (y - OH * 0.52) / (OH * 0.32)
    L += A.flash * Math.exp(-(dx * dx + dy * dy) * 0.5)
  }
  let g = 0
  if (lights && lights.glow) {
    const dx = (x - OW * 0.5) / (OH * 0.4), dy = (y - OH * 0.6) / (OH * 0.4)
    g = Math.exp(-(dx * dx + dy * dy) * 0.5)
    L += 1.1 * g
  }
  if (frameLuma != null) L *= 0.55 + 0.9 * frameLuma
  out.L = L; out.g = g
  return out
}

const LIT = { L: 0, g: 0 }
// `sc` scales the drawing (positions and sprite sizes; the simulation stays in visible-canvas pixels): 1 draws onto the visible canvas, W/OW
// onto the low-res world buffer — which is where steam is drawn, because a big soft wisp is expensive fill-rate at full resolution and
// looks better a little graded and grained into the scene anyway.
export function drawParticlesModern(ctx, fs, post, sc = 1) {
  const { OW, OH, t, flicker, lights } = fs
  const { pcfg, particles } = post
  const A = post.atmos.part
  const mk = canvasFactory()
  if (!mk) return
  const spr = ensureSprites(post, fs, mk)
  const dt = Math.min(0.1, fs.dt || 1 / 60)
  const rng = post.rng || (post.rng = mulberry32(0xd057))
  const rise = !!pcfg.rise, spark = !!pcfg.spark
  const sway = (pcfg.sway ?? 0.3) * 60, speed = (pcfg.speed ?? 0.3) * 60, baseSize = (pcfg.size ?? 1.4) * A.size * uiScaleOf(fs)   // canvas px: a hiDpi backing store must not shrink the motes
  const uiS = uiScaleOf(fs)

  // camera motion since the last frame: turning slides the whole dust field across the screen (everything at the same rate:
  // it is a pure rotation), walking forward makes the near motes stream past faster than the far ones (parallax = depth)
  let dAng = 0, fwd = 0
  const pl = fs.player
  if (pl) {
    if (post.camA != null) {
      dAng = wrapPi(pl.angle - post.camA)
      const vx = (pl.x - post.camX) / Math.max(dt, 1e-3), vy = (pl.y - post.camY) / Math.max(dt, 1e-3)
      fwd = Math.max(-6, Math.min(6, vx * Math.cos(pl.angle) + vy * Math.sin(pl.angle)))
    }
    post.camA = pl.angle; post.camX = pl.x; post.camY = pl.y
  }
  const turnPx = -dAng * (OW / (fs.fov || 1.3))
  const cx = OW * 0.5, cy = OH * 0.5
  const frame = post.bloom && post.bloomLive ? post.bloom : null
  const lightGlow = lights && lights.glow
  const glowCol = lightGlow ? lights.glow : null
  let glowTex = null
  if (glowCol) {
    const gk = `${glowCol[0]},${glowCol[1]},${glowCol[2]}`
    if (spr.glowKey !== gk) { spr.glowKey = gk; spr.glowTex = buildSprite(mk, spr.kind === 'spark' ? 'spark' : 'dust', glowCol) }
    glowTex = spr.glowTex
  }

  ctx.save()
  const additive = spark
  if (additive) ctx.globalCompositeOperation = 'lighter'
  ctx.imageSmoothingEnabled = true
  for (const p of particles) {
    const z = p.z, z2 = z * z
    // motion
    p.ph += 1.2 * dt
    const mvx = Math.sin(p.ph * (0.8 + 0.4 * p.w)) * sway * z, mvy = (rise ? -1 : 1) * speed * (0.5 + z) * (0.85 + 0.3 * p.w)   // px/s
    p.x += mvx * dt + turnPx
    p.y += mvy * dt
    if (fwd !== 0) { p.x += (p.x - cx) * 0.22 * fwd * z2 * dt; p.y += (p.y - cy) * 0.22 * fwd * z2 * dt }
    if (p.y < -12 || p.y > OH + 12 || p.x < -12 || p.x > OW + 12) {
      // recycle. Walking forward, motes stream out past the edges: they re-form in the middle distance. Otherwise a mote that
      // turns off one side re-enters on the other, and one that falls/rises off the top/bottom restarts at the far end.
      if (fwd > 0.5) { p.x = cx + (rng() - 0.5) * OW * 0.6; p.y = cy + (rng() - 0.5) * OH * 0.6 }
      else if (p.y < -12 || p.y > OH + 12) { p.y = p.y < 0 ? OH + 10 : -10; p.x = rng() * OW }
      else if (p.x < -12) p.x += OW + 24
      else p.x -= OW + 24
    }
    const fl = frame ? frame.luma[Math.max(0, Math.min(frame.BH - 1, (p.y / OH * frame.BH) | 0)) * frame.BW + Math.max(0, Math.min(frame.BW - 1, (p.x / OW * frame.BW) | 0))] / 255 : null
    const lit = airLight(p.x, p.y, OW, OH, A, lights, fl, LIT)
    let alpha, r
    if (spark) {
      // sparks: a hot dot that swells and fades on its own slow clock (never a strobe: the envelope is smooth, ~1 Hz)
      const env = Math.pow(Math.max(0, Math.sin(t * (0.9 + p.w * 0.9) + p.w * 40)), 3)
      alpha = 0.85 * (0.3 + 0.7 * env) * (0.5 + 0.5 * z) * A.alpha * p.a
      r = baseSize * (2.4 + 3.6 * z) * (0.7 + 0.5 * env)
      if (alpha > 0.05) {                                  // a short streak along its own motion: it is moving, not twinkling
        const k = 0.07
        ctx.globalAlpha = Math.min(1, alpha * 0.8) * flicker
        ctx.strokeStyle = spr.css; ctx.lineWidth = (0.8 + z * 0.9) * sc * uiS
        ctx.beginPath(); ctx.moveTo((p.x - mvx * k) * sc, (p.y - mvy * k) * sc); ctx.lineTo(p.x * sc, p.y * sc); ctx.stroke()
      }
    } else if (rise) {
      // steam: large soft wisps that swell and thin out as they climb
      const u = 1 - p.y / OH
      const fade = smoothstep(-0.02, 0.12, u) * Math.pow(Math.max(0, 1 - u), 0.7)
      alpha = 0.27 * (0.5 + 0.5 * z) * fade * Math.min(1.6, lit.L * 1.1) * A.alpha * p.a
      r = baseSize * (3.4 + 4.4 * z) * (1 + 0.9 * u) * p.s
    } else {
      // dust: motes that are only there where the air is lit; the very near ones go out of focus (big, faint)
      const bokeh = z > 0.92
      alpha = 0.8 * (0.35 + 0.65 * z) * Math.min(1.7, lit.L) * A.alpha * p.a * (bokeh ? 0.45 : 1) * (0.85 + 0.15 * Math.sin(p.ph * 2.3))
      r = baseSize * (1.05 + 1.7 * z2) * p.s * (bokeh ? 2.6 : 1)
    }
    if (alpha < 0.004) continue
    ctx.globalAlpha = Math.min(1, alpha) * flicker
    if (rise) ctx.drawImage(spr.tex, (p.x - r * 0.75) * sc, (p.y - r * 1.4) * sc, r * 1.5 * sc, r * 2.8 * sc)     // a wisp is taller than it is wide
    else ctx.drawImage(spr.tex, (p.x - r) * sc, (p.y - r) * sc, r * 2 * sc, r * 2 * sc)
    if (glowTex && lit.g > 0.08 && !additive) {          // catch the glowstick's colour
      ctx.globalCompositeOperation = 'lighter'
      ctx.globalAlpha = Math.min(1, alpha * lit.g * 0.9) * flicker
      ctx.drawImage(glowTex, (p.x - r) * sc, (p.y - r) * sc, r * 2 * sc, r * 2 * sc)
      ctx.globalCompositeOperation = 'source-over'
    }
  }
  ctx.restore()
}

export function drawParticles(ctx, fs, post, sc = 1) {
  const { opts } = fs
  if (post.count && opts.particles !== false && (!fs.quality || fs.quality.particles !== false)) {
    if (modernPost(fs)) drawParticlesModern(ctx, fs, post, sc)
    else drawParticlesLegacy(ctx, fs, post)
  }
}

const NOT_HANDLED = Object.freeze({ flashlight: false, glow: false })

// ── the player's own light: flashlight cone + a glowstick's colored wash ──
// (fs.handled.flashlight / .glow are set by the world pass when it already lit the surfaces with that light
// per pixel — then the screen-space gradient must not be drawn on top of it a second time.)
export function drawLights(ctx, fs) {
  const { OW, OH, lights } = fs
  const handled = fs.handled || NOT_HANDLED
  if (lights.flashlight && !handled.flashlight) {
    const g = ctx.createRadialGradient(OW / 2, OH * 0.52, OH * 0.04, OW / 2, OH * 0.52, OH * 0.72)
    g.addColorStop(0, 'rgba(255,244,212,0.24)')
    g.addColorStop(0.5, 'rgba(255,238,196,0.09)')
    g.addColorStop(1, 'rgba(0,0,0,0)')
    ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.fillStyle = g; ctx.fillRect(0, 0, OW, OH); ctx.restore()
  }
  if (lights.glow && !handled.glow) {
    const [gr, gg, gb] = lights.glow
    // the glowstick breathes on the clock (~1.1 rad/s per 60 fps frame at the old 0.11 rad/frame → 6.6 rad/s)
    const pulse = 0.72 + 0.28 * Math.sin(fs.t * 6.6)
    const g = ctx.createRadialGradient(OW / 2, OH * 0.6, OH * 0.03, OW / 2, OH * 0.6, OH * 0.62)
    g.addColorStop(0, `rgba(${gr},${gg},${gb},${(0.20 * pulse).toFixed(3)})`)
    g.addColorStop(1, 'rgba(0,0,0,0)')
    ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.fillStyle = g; ctx.fillRect(0, 0, OW, OH); ctx.restore()
  }
}

// Canvas px per CSS px (the quality director's hiDpi backing store makes the canvas bigger than its box): the overlays below are
// designed in CSS px, so they are scaled by it and stay the same visible size on a sharper canvas. 1 when unset (the plain path).
export function uiScaleOf(fs) { const u = fs.opts && fs.opts.uiScale; return u > 0 && isFinite(u) ? u : 1 }

// ── remote-player nameplates — full-res so names stay crisp ──
// Plates of players standing near each other in the view overlap and hide one another. `boxes` = [{ x0, x1, y0, y1 }] in NEAREST-first
// order (sprites are sorted far-to-near, so that is the reverse of the plate list); returns how far up (px, >= 0) each must move so that
// no two overlap: the nearest keeps its place, a farther one stacks above the ones it would cover. Pure, and stable frame to frame (it
// depends only on the boxes, in order, with no state), so plates never swap places while the players stand still.
export function stackNameplates(boxes, gap = 2) {
  const out = new Array(boxes.length).fill(0)
  for (let i = 0; i < boxes.length; i++) {
    const b = boxes[i]
    let up = 0
    for (let tries = 0; tries < 8; tries++) {
      let hit = false
      for (let j = 0; j < i; j++) {
        const o = boxes[j], oy0 = o.y0 - out[j], oy1 = o.y1 - out[j]
        if (b.x0 < o.x1 && b.x1 > o.x0 && b.y0 - up < oy1 + gap && b.y1 - up > oy0 - gap) { up = Math.max(up, b.y1 - oy0 + gap); hit = true }
      }
      if (!hit) break
    }
    out[i] = up
  }
  return out
}

export function drawNameplates(ctx, fs, namePlates) {
  const RW = fs.W
  if (namePlates.length) {
    const u = uiScaleOf(fs), inv = 1 / (fs.quality.scale * u)      // (drawn under scale(u): positions are in CSS px)
    ctx.save()
    if (u !== 1) ctx.scale(u, u)
    ctx.textAlign = 'center'
    // layout pass (nearest first), then draw in the given far-to-near order so a nearer plate stays on top
    ctx.font = 'bold 13px "Courier New", monospace'
    const lay = []
    for (let i = namePlates.length - 1; i >= 0; i--) {
      const np = namePlates[i]
      if (np.sx < 0 || np.sx >= RW) continue
      const fx = np.sx * inv, fy = Math.max(16, np.y * inv), w = ctx.measureText(np.name).width + 14
      lay.push({ np, fx, fy, w, x0: fx - w / 2, x1: fx + w / 2, y0: fy - (np.speech ? 38 : 15), y1: fy + (np.hp != null ? 8 : 3) })
    }
    const up = stackNameplates(lay)
    lay.forEach((l, i) => { l.fy = Math.max(l.np.speech ? 40 : 16, l.fy - up[i]) })
    lay.reverse()
    for (const { np, fx, fy, w } of lay) {
      // nameplate
      ctx.font = 'bold 13px "Courier New", monospace'
      ctx.globalAlpha = Math.min(1, np.alpha + 0.25)
      ctx.fillStyle = 'rgba(8,10,14,0.72)'
      ctx.fillRect(fx - w / 2, fy - 15, w, 18)
      ctx.fillStyle = 'rgba(226,233,246,0.96)'
      ctx.fillText(np.name, fx, fy - 2)
      // floating speech bubble above the name — you SEE them talk in the fog
      if (np.speech) {
        ctx.font = '13px "Courier New", monospace'
        const msg = np.speech.length > 44 ? np.speech.slice(0, 43) + '…' : np.speech
        const bw = ctx.measureText(msg).width + 16
        const by = fy - 22
        ctx.globalAlpha = 1
        ctx.fillStyle = 'rgba(14,17,24,0.92)'
        ctx.fillRect(fx - bw / 2, by - 16, bw, 20)
        ctx.beginPath(); ctx.moveTo(fx - 4, by + 4); ctx.lineTo(fx + 4, by + 4); ctx.lineTo(fx, by + 9); ctx.closePath(); ctx.fill()
        ctx.fillStyle = 'rgba(150,210,255,0.98)'
        ctx.fillText(msg, fx, by - 2)
      }
      // teammate HP bar under the name (co-op awareness)
      if (np.hp != null) {
        const bw = 42, bx = fx - bw / 2, hy = fy + 3
        ctx.globalAlpha = Math.min(1, np.alpha + 0.25)
        ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.fillRect(bx - 1, hy - 1, bw + 2, 5)
        const hpf = Math.max(0, Math.min(1, np.hp / 100))
        ctx.fillStyle = hpf > 0.5 ? 'rgba(90,190,100,0.95)' : hpf > 0.25 ? 'rgba(210,180,60,0.95)' : 'rgba(210,70,60,0.95)'
        ctx.fillRect(bx, hy, bw * hpf, 3)
      }
    }
    ctx.restore()
  }
}

// ── crosshair — a small dark dot with a faint light outline, centred ──
export function drawCrosshair(ctx, fs) {
  const { OW, OH, opts } = fs
  if (opts.crosshair !== false) {
    const u = uiScaleOf(fs), ccx = OW / 2 / u, ccy = OH / 2 / u
    ctx.save()
    if (u !== 1) ctx.scale(u, u)
    ctx.globalAlpha = 0.5
    ctx.fillStyle = 'rgba(255,255,255,0.7)'
    ctx.fillRect(ccx - 2, ccy - 2, 4, 4)
    ctx.fillStyle = 'rgba(0,0,0,0.9)'
    ctx.fillRect(ccx - 1, ccy - 1, 2, 2)
    ctx.restore()
  }
}

// Everything after the sprite pass. Legacy tier: grain (into the low-res buffer `wctx`), upscale to the visible canvas `ctx`,
// vignette + blackout, particles, flashlight/glow, nameplates, crosshair — exactly the old order. Other tiers: see the header.
export function composeFrame(ctx, wctx, world, fs, post, namePlates) {
  if (!modernPost(fs)) {
    drawGrain(wctx, fs, post)
    upscale(ctx, world, fs, post)
    drawVignette(ctx, fs, post)
    drawParticles(ctx, fs, post)
    drawLights(ctx, fs)
    drawNameplates(ctx, fs, namePlates)
    drawCrosshair(ctx, fs)
    return
  }
  post.bloomLive = false
  drawBloom(wctx, world, fs, post)                 // reads the finished frame, adds light back (fs.quality.bloom)
  const steam = !!(post.pcfg && post.pcfg.rise)    // rising steam is drawn INTO the low-res frame (soft, cheap there, and graded with the scene)
  if (steam) drawParticles(wctx, fs, post, fs.W / fs.OW)
  drawGrade(wctx, fs, post)                        // highlight gain (multiply) + veil: vignette and shadow lift (source-over), low-res
  drawGrainModern(wctx, fs, post)                  // luma-dependent grain, film-rate, tile blits
  const tape = tapeOn(fs)
  if (tape) drawTapeFringe(wctx, world, fs, post)
  upscale(ctx, world, fs, post)
  if (tape) drawTapeSoft(ctx, world, fs, post)
  drawFlickerOverlay(ctx, fs)                      // the legacy blackout — skipped when a light model expresses flicker spatially
  if (!steam) drawParticles(ctx, fs, post, 1)      // dust and sparks stay full-res, crisp, and un-graded (sparks are light sources)
  drawLights(ctx, fs)
  drawNameplates(ctx, fs, namePlates)
  drawCrosshair(ctx, fs)
}
