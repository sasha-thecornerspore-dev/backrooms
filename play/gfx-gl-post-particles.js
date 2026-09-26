// gfx-gl-post-particles.js — the particle SIMULATION of the GPU post pass, in plain JS (no GL, no DOM: unit-tested in Node against the CPU stage). It
// steps the SAME seeded field gfx-post.js draws (createPostState / seedParticles: dust motes, rising steam, electrical sparks; the legacy tier's
// plain dots) with the CPU stage's own motion rules, and instead of drawing writes INSTANCE RECORDS the GPU draws as quads.
//
// Instance record (INST floats): three vec4 attributes
//   A = (cx, cy, halfL, halfW)      centre in TARGET pixels from the top-left, half extent along the direction and across it
//   B = (dx, dy, kind, mainKind)    unit direction (a spark streak's heading; (1, 0) for everything else), the shape, and for a glow the kind it rides on
//   C = (a0, lb, g, 0)              alpha before the light term, the light term (airLight without the frame's brightness), the glowstick share
// The shader finishes the alpha exactly as gfx-post.js does: L = lb * (0.55 + 0.9 * frameLuma) when the bloom pass measured the frame (else lb),
// alpha = a0 * min(cap, L * k) for dust / steam, and min(1, alpha) * flicker. `sc` scales everything from visible-canvas pixels to the target
// (W / OW for the steam the CPU draws into the low-res frame, 1 for everything else).
import { airLight, uiScaleOf } from './gfx-post.js'
import { hexToRgb, mulberry32 } from './gfx-util.js'

export const K_DUST = 0, K_STEAM = 1, K_SPARK = 2, K_DISC = 3, K_STREAK = 4, K_GLOW = 5
export const INST = 12
export const LUMA_LO = 0.55, LUMA_HI = 0.55 + 0.9      // the frame-luma factor on the light term: 0.55 + 0.9 * luma  (0.55 .. 1.45)

const smooth = (a, b, x) => { const t = x <= a ? 0 : x >= b ? 1 : (x - a) / (b - a); return t * t * (3 - 2 * t) }
const mix = (a, b, t) => a + (b - a) * t
const wrapPi = (a) => { a = (a + Math.PI) % (2 * Math.PI); if (a < 0) a += 2 * Math.PI; return a - Math.PI }
const LIT = { L: 0, g: 0 }

// Two growable Float32Arrays (normal source-over instances, additive instances) and how many records each holds. Reused every frame.
export function createSink(count) {
  const n = Math.max(1, count | 0)
  return { N: new Float32Array(n * INST), A: new Float32Array(n * 2 * INST), nN: 0, nA: 0, cap: n, kind: 'dust', rgb: [1, 1, 1], glow: null, glowRgb: [1, 1, 1] }
}

function put(buf, n, cx, cy, hL, hW, dx, dy, kind, mk, a0, lb, g) {
  const o = n * INST
  buf[o] = cx; buf[o + 1] = cy; buf[o + 2] = hL; buf[o + 3] = hW
  buf[o + 4] = dx; buf[o + 5] = dy; buf[o + 6] = kind; buf[o + 7] = mk
  buf[o + 8] = a0; buf[o + 9] = lb; buf[o + 10] = g; buf[o + 11] = 0
}

// the sprite colour: the field's colour pulled toward the fog by the level's `temper` (ensureSprites), truncated to bytes, as 0..1
export function particleColor(post, out = [1, 1, 1]) {
  const P = post.pcfg, A = post.atmos.part
  const fog = post.fogHex ? hexToRgb(post.fogHex) : [200, 200, 190]
  const base = P.color || [225, 220, 200]
  for (let i = 0; i < 3; i++) out[i] = (mix(base[i], fog[i], A.temper) | 0) / 255
  return out
}
export function particleKind(post) { const P = post.pcfg; return P.spark ? 'spark' : P.rise ? 'steam' : 'dust' }

function grow(sink, n) {
  if (sink.cap >= n) return
  sink.N = new Float32Array(n * INST); sink.A = new Float32Array(n * 2 * INST); sink.cap = n
}

// ── the modern field: motion + instance records (drawParticlesModern, line for line) ────────────────────────────────────────
export function stepModern(post, fs, sc, sink) {
  const { OW, OH, t, lights } = fs
  const { pcfg, particles } = post
  const A = post.atmos.part
  const dt = Math.min(0.1, fs.dt || 1 / 60)
  const rng = post.rng || (post.rng = mulberry32(0xd057))
  const rise = !!pcfg.rise, spark = !!pcfg.spark
  const uiS = uiScaleOf(fs)
  const sway = (pcfg.sway ?? 0.3) * 60, speed = (pcfg.speed ?? 0.3) * 60, baseSize = (pcfg.size ?? 1.4) * A.size * uiS

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
  const glowCol = lights && lights.glow ? lights.glow : null
  sink.kind = spark ? 'spark' : rise ? 'steam' : 'dust'
  particleColor(post, sink.rgb)
  sink.glow = glowCol
  if (glowCol) for (let i = 0; i < 3; i++) sink.glowRgb[i] = glowCol[i] / 255
  grow(sink, particles.length)
  let nN = 0, nA = 0
  const N = sink.N, Ad = sink.A

  for (let pi = 0; pi < particles.length; pi++) {
    const p = particles[pi]
    const z = p.z, z2 = z * z
    p.ph += 1.2 * dt
    const mvx = Math.sin(p.ph * (0.8 + 0.4 * p.w)) * sway * z, mvy = (rise ? -1 : 1) * speed * (0.5 + z) * (0.85 + 0.3 * p.w)
    p.x += mvx * dt + turnPx
    p.y += mvy * dt
    if (fwd !== 0) { p.x += (p.x - cx) * 0.22 * fwd * z2 * dt; p.y += (p.y - cy) * 0.22 * fwd * z2 * dt }
    if (p.y < -12 || p.y > OH + 12 || p.x < -12 || p.x > OW + 12) {
      if (fwd > 0.5) { p.x = cx + (rng() - 0.5) * OW * 0.6; p.y = cy + (rng() - 0.5) * OH * 0.6 }
      else if (p.y < -12 || p.y > OH + 12) { p.y = p.y < 0 ? OH + 10 : -10; p.x = rng() * OW }
      else if (p.x < -12) p.x += OW + 24
      else p.x -= OW + 24
    }
    const lit = airLight(p.x, p.y, OW, OH, A, lights, null, LIT)
    let a0, r, kind
    const lb = lit.L
    if (spark) {
      const env = Math.pow(Math.max(0, Math.sin(t * (0.9 + p.w * 0.9) + p.w * 40)), 3)
      const alpha = 0.85 * (0.3 + 0.7 * env) * (0.5 + 0.5 * z) * A.alpha * p.a
      r = baseSize * (2.4 + 3.6 * z) * (0.7 + 0.5 * env)
      if (alpha > 0.05) {                                      // the short streak along the mote's own motion
        const k = 0.07, sx = mvx * k, sy = mvy * k, len = Math.hypot(sx, sy)
        const mx = p.x - sx * 0.5, my = p.y - sy * 0.5
        if (len > 1e-6) put(Ad, nA++, mx * sc, my * sc, len * 0.5 * sc, (0.8 + z * 0.9) * sc * uiS * 0.5, sx / len, sy / len, K_STREAK, 0, Math.min(1, alpha * 0.8), 1, 0)
        else put(Ad, nA++, mx * sc, my * sc, 0.001, (0.8 + z * 0.9) * sc * uiS * 0.5, 1, 0, K_STREAK, 0, Math.min(1, alpha * 0.8), 1, 0)
      }
      if (alpha < 0.004) continue
      put(Ad, nA++, p.x * sc, p.y * sc, r * sc, r * sc, 1, 0, K_SPARK, 0, alpha, 1, 0)
      continue
    }
    let cap, k
    if (rise) {
      const u = 1 - p.y / OH
      const fade = smooth(-0.02, 0.12, u) * Math.pow(Math.max(0, 1 - u), 0.7)
      a0 = 0.27 * (0.5 + 0.5 * z) * fade * A.alpha * p.a
      r = baseSize * (3.4 + 4.4 * z) * (1 + 0.9 * u) * p.s
      kind = K_STEAM; cap = 1.6; k = 1.1
    } else {
      const bokeh = z > 0.92
      a0 = 0.8 * (0.35 + 0.65 * z) * A.alpha * p.a * (bokeh ? 0.45 : 1) * (0.85 + 0.15 * Math.sin(p.ph * 2.3))
      r = baseSize * (1.05 + 1.7 * z2) * p.s * (bokeh ? 2.6 : 1)
      kind = K_DUST; cap = 1.7; k = 1
    }
    // cull what cannot reach 0.004 whatever the frame's brightness does to the light term (the shader culls the rest)
    if (a0 * Math.min(cap, lb * k * LUMA_HI) < 0.004) continue
    if (rise) put(N, nN++, p.x * sc, p.y * sc, r * 0.75 * sc, r * 1.4 * sc, 1, 0, kind, 0, a0, lb, lit.g)
    else put(N, nN++, p.x * sc, p.y * sc, r * sc, r * sc, 1, 0, kind, 0, a0, lb, lit.g)
    if (glowCol && lit.g > 0.08) put(Ad, nA++, p.x * sc, p.y * sc, r * sc, r * sc, 1, 0, K_GLOW, kind, a0, lb, lit.g)
  }
  sink.nN = nN; sink.nA = nA
  return sink
}

// ── the legacy field: 45 plain dots (drawParticlesLegacy) ──────────────────────────────────────────────────────────────────
export function stepLegacy(post, fs, sink) {
  const { OW, OH } = fs
  const { pcfg, particles } = post
  const k = Math.min(0.1, fs.dt) * 60
  const col = pcfg.color || [225, 220, 200]
  const rise = !!pcfg.rise, spark = !!pcfg.spark
  const sway = pcfg.sway ?? 0.3, speed = pcfg.speed ?? 0.3, baseSize = pcfg.size ?? 1.4
  sink.kind = 'legacy'
  for (let i = 0; i < 3; i++) sink.rgb[i] = col[i] / 255
  sink.glow = null
  grow(sink, particles.length)
  let nN = 0
  const N = sink.N
  for (let pi = 0; pi < particles.length; pi++) {
    const p = particles[pi]
    p.ph += 0.02 * k
    p.x += Math.sin(p.ph) * sway * p.z * k
    p.y += (rise ? -1 : 1) * speed * (0.5 + p.z) * k
    if (p.y < -8) { p.y = OH + 8; p.x = Math.random() * OW }
    else if (p.y > OH + 8) { p.y = -8; p.x = Math.random() * OW }
    if (p.x < -8) p.x = OW + 8; else if (p.x > OW + 8) p.x = -8
    const flick = spark ? (0.25 + 0.75 * Math.abs(Math.sin(p.ph * 4))) : 1
    const a0 = (spark ? 0.7 : 0.28) * (0.4 + 0.6 * p.z) * flick
    const r = baseSize * (0.6 + p.z)
    put(N, nN++, p.x, p.y, r, r, 1, 0, K_DISC, 0, a0, 1, 0)
  }
  sink.nN = nN; sink.nA = 0
  return sink
}
