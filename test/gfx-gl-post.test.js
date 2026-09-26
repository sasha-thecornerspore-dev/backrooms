// The GPU post pass (gfx-gl-post*.js): the pure parts, checked against the CPU stage they mirror (gfx-post.js). The GL itself is exercised by
// tools/gfx/post-parity.cjs (the CPU renderer's own world buffer shaded by both pipelines) and the harness on SwiftShader.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  createPostState, seedParticles, resolveAtmos, buildGrainTile, buildVeil, drawLights, drawParticles, drawParticlesModern, vignetteAlpha, legacyGrainPhase,
  flickerOverlayAlpha,
} from '../src/renderer/gfx-post.js'
import { buildGrain } from '../src/renderer/gfx-textures.js'
import { mulberry32 } from '../src/renderer/gfx-util.js'
import { qualityFor } from '../src/renderer/gfx-quality.js'
import {
  postPlan, bloomSizes, grainTilePixels, legacyGrainPixels, grainOffsetModern, grainOffsetLegacy, gainFor, veilAt, flashGradient, glowGradient, glowPulse,
  GRAIN_TILE, LEGACY_TILE,
} from '../src/renderer/gfx-gl-post-math.js'
import { createSink, stepModern, stepLegacy, INST, K_DUST, K_STEAM, K_SPARK, K_STREAK, K_GLOW, K_DISC } from '../src/renderer/gfx-gl-post-particles.js'
import * as SH from '../src/renderer/gfx-gl-post-shaders.js'

// ── fakes ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// a 2D context that records what a stage draws (state read at call time, as canvas does)
function recorder() {
  const calls = []
  const ctx = {
    globalAlpha: 1, globalCompositeOperation: 'source-over', fillStyle: '', strokeStyle: '', lineWidth: 1, imageSmoothingEnabled: true, font: '', textAlign: '',
    save() {}, restore() {}, beginPath() {}, closePath() {}, fill() { calls.push({ op: 'fill', a: this.globalAlpha }) }, fillRect() {}, scale() {}, translate() {},
    arc(x, y, r) { calls.push({ op: 'arc', x, y, r, a: this.globalAlpha }); this._arc = { x, y, r } },
    moveTo(x, y) { this._m = [x, y] }, lineTo(x, y) { this._l = [x, y] },
    stroke() { calls.push({ op: 'stroke', m: this._m, l: this._l, w: this.lineWidth, a: this.globalAlpha, comp: this.globalCompositeOperation }) },
    drawImage(img, ...r) { calls.push({ op: 'img', r, a: this.globalAlpha, comp: this.globalCompositeOperation }) },
    createRadialGradient() { return { addColorStop() {} } },
  }
  return { ctx, calls }
}
const noop2d = () => new Proxy({}, { get: (t, k) => (k === 'createRadialGradient' ? () => ({ addColorStop() {} }) : k === 'createImageData' ? (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }) : () => {}), set: () => true })
const fakeCanvas = () => ({ width: 0, height: 0, getContext: noop2d })

let realDoc, realRandom
beforeEach(() => { realDoc = globalThis.document; realRandom = Math.random; globalThis.document = { createElement: fakeCanvas } })
afterEach(() => { globalThis.document = realDoc; Math.random = realRandom })

const cfgFor = (levelIndex, particles) => ({ levelIndex, palette: { fog: '#c9c98f' }, particles })
const tierFs = (tier, extra = {}) => ({
  W: 576, H: 324, OW: 960, OH: 540, t: 1.234, dt: 1 / 60, frame: 5, flicker: 1, rawFlicker: 1, comfort: { reduceFlicker: false, maxGlobalDip: 1 },
  quality: qualityFor(tier), opts: {}, lights: {}, handled: { flashlight: false, glow: false }, light: null, player: { x: 5, y: 5, angle: 0.3 }, fov: Math.PI / 2.4, ...extra,
})

describe('postPlan: which stages run (the CPU stage\'s own gates)', () => {
  const post = (levelIndex, particles = { count: 30 }) => createPostState(cfgFor(levelIndex, particles))
  it('legacy is grain + upscale + vignette only; every other tier is the atmosphere pass', () => {
    const p = postPlan(tierFs('legacy'), post(0), {})
    expect(p).toMatchObject({ modern: false, bloom: false, grade: false, grain: true, tape: false, compose: true })
    expect(postPlan(tierFs('medium'), post(0), {})).toMatchObject({ modern: true, grade: true, compose: true })
  })
  it('legacy with grain off needs no compose pass at all (a pure upscale of the scene)', () => {
    expect(postPlan(tierFs('legacy', { opts: { grain: false } }), post(0), {}).compose).toBe(false)
  })
  it('bloom follows the tier, opts.bloom and the level\'s own switch', () => {
    const t = qualityFor('high')
    expect(t.bloom).toBeTruthy()
    expect(postPlan(tierFs('high'), post(0), {}).bloom).toBe(true)
    expect(postPlan(tierFs('high', { opts: { bloom: false } }), post(0), {}).bloom).toBe(false)
    expect(postPlan(tierFs('low'), post(0), {}).bloom).toBe(!!qualityFor('low').bloom)
    const off = createPostState({ ...cfgFor(0, { count: 3 }), look: { post: { bloom: 0 } } })
    expect(postPlan(tierFs('high'), off, {}).bloom).toBe(false)
  })
  it('steam is the modern rising kind only; particles obey opts and the tier', () => {
    expect(postPlan(tierFs('medium'), post(2, { count: 20, rise: true }), {}).steam).toBe(true)
    expect(postPlan(tierFs('legacy'), post(2, { count: 20, rise: true }), {}).steam).toBe(false)
    expect(postPlan(tierFs('medium'), post(0), {}).steam).toBe(false)
    expect(postPlan(tierFs('medium', { opts: { particles: false } }), post(0), {}).parts).toBe(false)
    expect(postPlan(tierFs('medium'), post(0, { count: 0 }), {}).parts).toBe(false)
  })
  it('tape only on a modern tier and only when opted in', () => {
    expect(postPlan(tierFs('medium', { opts: { tape: true } }), post(0), {}).tape).toBe(true)
    expect(postPlan(tierFs('legacy', { opts: { tape: true } }), post(0), {}).tape).toBe(false)
    expect(postPlan(tierFs('medium'), post(0), {}).tape).toBe(false)
  })
})

describe('bloomSizes: the chain gfx-post.js ensureBloom builds', () => {
  it('halves three times, then a 1/32 grid', () => {
    expect(bloomSizes(576, 324)).toMatchObject({ w1: 288, h1: 162, w2: 144, h2: 81, BW: 72, BH: 40, wW: 18, wH: 10 })
    expect(bloomSizes(576, 324).sx).toBeCloseTo(4)
    expect(bloomSizes(576, 324).sy).toBeCloseTo(4)
  })
  it('never collapses below 2 texels', () => {
    const s = bloomSizes(8, 8)
    for (const k of ['w1', 'h1', 'w2', 'h2', 'BW', 'BH', 'wW', 'wH']) expect(s[k]).toBeGreaterThanOrEqual(2)
  })
})

describe('grain', () => {
  it('the modern tile is byte for byte the CPU tile', () => {
    const cap = {}
    const mk = () => ({ getContext: () => ({ createImageData: (w, h) => (cap.img = { data: new Uint8ClampedArray(w * h * 4) }), putImageData: () => {} }) })
    buildGrainTile(mk, 0.05, 0.03)
    const mine = grainTilePixels(0.05, 0.03)
    expect(mine.length).toBe(GRAIN_TILE * GRAIN_TILE * 4)
    expect(Buffer.from(mine).equals(Buffer.from(cap.img.data.buffer))).toBe(true)
  })
  it('the legacy tile is byte for byte buildGrain()', () => {
    let img
    globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => ({ createImageData: (w, h) => (img = { data: new Uint8ClampedArray(w * h * 4) }), putImageData: () => {} }) }) }
    buildGrain()
    expect(Buffer.from(legacyGrainPixels()).equals(Buffer.from(img.data.buffer))).toBe(true)
    expect(legacyGrainPixels().length).toBe(LEGACY_TILE * LEGACY_TILE * 4)
  })
  it('modern grain hops at 24 Hz, not with the frame rate', () => {
    const a = grainOffsetModern(1.0), b = grainOffsetModern(1.0 + 1 / 240), c = grainOffsetModern(1.0 + 1 / 20)
    expect(b).toEqual(a)
    expect(c).not.toEqual(a)
    for (const v of [a, b, c]) for (const n of v) expect(n >= 0 && n < GRAIN_TILE).toBe(true)
  })
  it('legacy grain: screen (x, y) shows pattern ((x + p) mod 128, (y - q) mod 128), p = the CPU phase', () => {
    for (const t of [0, 1, 2.5, 7.77]) {
      const p = legacyGrainPhase(t), q = (p * 2) & 127, o = grainOffsetLegacy(t)
      expect(o[0]).toBe(p)
      expect((o[1] + q) & 127).toBe(0)                 // oy is -q modulo the tile
    }
  })
})

describe('the grade', () => {
  it('gainFor hands 1 exactly where the CPU skips the multiply', () => {
    expect(gainFor({ gain: [1, 0.999, 0.996] })).toEqual([1, 1, 1])
    expect(gainFor({ gain: [0.99, 1, 1] })).toEqual([252 / 255, 1, 1])      // the CPU multiplies by rgb(round(g * 255))
  })
  it('veilAt reproduces buildVeil\'s gradient stops (colour and alpha at every 1/12)', () => {
    for (const lvl of [0, 1, 2, 3, 4]) {
      const A = resolveAtmos(cfgFor(lvl, null))
      const stops = []
      const mk = () => ({ getContext: () => ({ createRadialGradient: () => ({ addColorStop: (r, c) => stops.push([r, c]) }), fillRect() {}, set fillStyle(v) {} }) })
      buildVeil(mk, 100, 60, A.grade, A.vig)
      expect(stops.length).toBe(13)
      const out = { c: [0, 0, 0], a: 0 }
      for (const [r, css] of stops) {
        const m = /rgba\((\d+),(\d+),(\d+),([\d.]+)\)/.exec(css)
        veilAt(r, A, out)
        for (let i = 0; i < 3; i++) expect(Math.abs(out.c[i] * 255 - +m[i + 1])).toBeLessThanOrEqual(0.51)
        expect(Math.abs(out.a - +m[4])).toBeLessThan(6e-5)
      }
    }
  })
  it('the shader\'s vignette curve is vignetteAlpha (depth * smoothstep(from, 1.02, r) ^ 1.3)', () => {
    expect(SH.COMPOSE_FS).toContain('pow(smoothstep(uVeil.y, 1.02, r), 1.3)')
    expect(vignetteAlpha(0, 0.5, 0.3)).toBe(0)
    expect(vignetteAlpha(1.02, 0.5, 0.3)).toBeCloseTo(0.5)
  })
})

describe('flashlight / glowstick gradients equal drawLights\' colour stops', () => {
  function stopsOf(fs) {
    const grads = []
    const ctx = { save() {}, restore() {}, fillRect() {}, set fillStyle(v) {}, set globalCompositeOperation(v) {}, createRadialGradient: (...a) => { const g = { a, stops: [], addColorStop: (t, c) => g.stops.push([t, c]) }; grads.push(g); return g } }
    drawLights(ctx, fs)
    return grads
  }
  const parse = (css) => { const m = /rgba\((\d+),(\d+),(\d+),([\d.]+)\)/.exec(css); return { rgb: [+m[1], +m[2], +m[3]], a: +m[4] } }
  it('flashlight', () => {
    const [g] = stopsOf({ OW: 960, OH: 540, t: 0, lights: { flashlight: true }, handled: { flashlight: false, glow: false } })
    for (const [t, css] of g.stops) {
      const c = parse(css), m = flashGradient(t)
      for (let i = 0; i < 3; i++) expect(m.rgb[i] * 255).toBeCloseTo(c.rgb[i], 5)
      expect(m.a).toBeCloseTo(c.a, 5)
    }
    expect(g.a[2]).toBeCloseTo(540 * 0.04); expect(g.a[5]).toBeCloseTo(540 * 0.72)
  })
  it('glowstick (pulsed on the clock)', () => {
    const t = 0.37
    const [g] = stopsOf({ OW: 960, OH: 540, t, lights: { glow: [90, 255, 120] }, handled: { flashlight: false, glow: false } })
    const c0 = parse(g.stops[0][1]), m = glowGradient(0, [90, 255, 120], glowPulse(t))
    expect(c0.a).toBeCloseTo(m.a, 3)
    for (let i = 0; i < 3; i++) expect(m.rgb[i] * 255).toBeCloseTo(c0.rgb[i], 5)
    expect(glowGradient(1, [90, 255, 120], 1).a).toBe(0)
  })
  it('the world pass\'s handled flags switch them off', () => {
    expect(stopsOf({ OW: 960, OH: 540, t: 0, lights: { flashlight: true, glow: [1, 2, 3] }, handled: { flashlight: true, glow: true } }).length).toBe(0)
  })
})

// ── the particle field ────────────────────────────────────────────────────────────────────────────────────────────────────
function twinPosts(levelIndex, pcfg, seed = 7) {
  const cfg = cfgFor(levelIndex, pcfg)
  const rnd = mulberry32(seed); Math.random = () => rnd()
  const a = createPostState(cfg); seedParticles(a, 960, 540)
  const b = createPostState(cfg); seedParticles(b, 960, 540)
  b.particles = a.particles.map((p) => ({ ...p }))
  return { a, b }
}
const modernFs = (tier, i, extra = {}) => tierFs(tier, {
  t: i / 60, dt: 1 / 60, frame: i, flicker: 0.93,
  player: { x: 5 + i * 0.05, y: 5, angle: 0.3 + i * 0.01 }, ...extra,
})

describe('stepModern reproduces drawParticlesModern (positions, sizes, alpha)', () => {
  const kinds = [
    ['dust', 0, { count: 30, color: [235, 228, 190], size: 1.4, sway: 0.35, speed: 0.25 }],
    ['steam', 2, { count: 25, color: [190, 182, 170], size: 2.6, sway: 0.55, speed: 0.5, rise: true }],
  ]
  for (const [name, lvl, pcfg] of kinds) {
    it(name, () => {
      const { a, b } = twinPosts(lvl, pcfg)
      const sink = createSink(pcfg.count)
      for (let i = 1; i <= 40; i++) {
        const fs = modernFs('medium', i)
        const sc = name === 'steam' ? fs.W / fs.OW : 1
        const { ctx, calls } = recorder()
        drawParticlesModern(ctx, fs, a, sc)
        stepModern(b, fs, sc, sink)
        const cpu = calls.filter((c) => c.op === 'img' && c.comp === 'source-over')
        // the shader: alpha = min(1, a0 * min(cap, lb * k)) * flicker  (no frame brightness here: no bloom measured it)
        const cap = name === 'steam' ? 1.6 : 1.7, k = name === 'steam' ? 1.1 : 1
        // the JS side culls only what cannot reach 0.004 whatever the frame's brightness does; the shader culls the rest, so cull the same way here
        const keep = []
        for (let n = 0; n < sink.nN; n++) if (sink.N[n * INST + 8] * Math.min(cap, sink.N[n * INST + 9] * k) >= 0.004) keep.push(n)
        expect(sink.nN).toBeGreaterThanOrEqual(cpu.length)
        expect(keep.length).toBe(cpu.length)
        for (let m = 0; m < cpu.length; m++) {
          const n = keep[m]
          const o = n * INST, r = cpu[m].r                  // drawImage(tex, x, y, w, h)
          const [x, y, w, h] = name === 'steam' ? [r[0], r[1], r[2], r[3]] : [r[0], r[1], r[2], r[3]]
          expect(sink.N[o]).toBeCloseTo(x + w / 2, 3); expect(sink.N[o + 1]).toBeCloseTo(y + h / 2, 3)
          expect(sink.N[o + 2] * 2).toBeCloseTo(w, 3); expect(sink.N[o + 3] * 2).toBeCloseTo(h, 3)
          const alpha = Math.min(1, sink.N[o + 8] * Math.min(cap, sink.N[o + 9] * k)) * fs.flicker
          expect(alpha).toBeCloseTo(cpu[m].a, 6)
          expect(sink.N[o + 6]).toBe(name === 'steam' ? K_STEAM : K_DUST)
        }
      }
      // the field itself ends where the CPU's does
      for (let i = 0; i < a.particles.length; i++) { expect(b.particles[i].x).toBeCloseTo(a.particles[i].x, 9); expect(b.particles[i].y).toBeCloseTo(a.particles[i].y, 9) }
    })
  }

  it('sparks: additive sprites and streaks', () => {
    const { a, b } = twinPosts(3, { count: 34, color: [170, 215, 255], size: 1.3, sway: 0.25, speed: 0.65, spark: true })
    const sink = createSink(34)
    let sprites = 0, streaks = 0
    for (let i = 1; i <= 60; i++) {
      const fs = modernFs('medium', i)
      const { ctx, calls } = recorder()
      drawParticlesModern(ctx, fs, a, 1)
      stepModern(b, fs, 1, sink)
      const cImg = calls.filter((c) => c.op === 'img'), cStr = calls.filter((c) => c.op === 'stroke')
      const mImg = [], mStr = []
      for (let n = 0; n < sink.nA; n++) (sink.A[n * INST + 6] === K_STREAK ? mStr : mImg).push(n * INST)
      expect(mImg.length).toBe(cImg.length); expect(mStr.length).toBe(cStr.length)
      cImg.forEach((c, n) => {
        const o = mImg[n]
        expect(sink.A[o + 6]).toBe(K_SPARK)
        expect(sink.A[o]).toBeCloseTo(c.r[0] + c.r[2] / 2, 3); expect(sink.A[o + 2] * 2).toBeCloseTo(c.r[2], 3)
        expect(Math.min(1, sink.A[o + 8]) * fs.flicker).toBeCloseTo(c.a, 6)
      })
      cStr.forEach((c, n) => {
        const o = mStr[n], cx = (c.m[0] + c.l[0]) / 2, cy = (c.m[1] + c.l[1]) / 2
        expect(sink.A[o]).toBeCloseTo(cx, 3); expect(sink.A[o + 1]).toBeCloseTo(cy, 3)
        expect(sink.A[o + 2] * 2).toBeCloseTo(Math.hypot(c.l[0] - c.m[0], c.l[1] - c.m[1]), 3)   // stroke length
        expect(sink.A[o + 3] * 2).toBeCloseTo(c.w, 5)                                              // stroke width
        expect(Math.min(1, sink.A[o + 8]) * fs.flicker).toBeCloseTo(c.a, 6)
      })
      sprites += cImg.length; streaks += cStr.length
    }
    expect(sprites).toBeGreaterThan(20); expect(streaks).toBeGreaterThan(10)
  })

  it('a glowstick colours the dust it lights (additive, only near the light)', () => {
    const { a, b } = twinPosts(0, { count: 40, color: [235, 228, 190], size: 1.4, sway: 0.35, speed: 0.25 })
    const sink = createSink(40)
    let glows = 0
    for (let i = 1; i <= 20; i++) {
      const fs = modernFs('medium', i, { lights: { glow: [90, 255, 120] } })
      const { ctx, calls } = recorder()
      drawParticlesModern(ctx, fs, a, 1)
      stepModern(b, fs, 1, sink)
      const cGlow = calls.filter((c) => c.op === 'img' && c.comp === 'lighter')
      expect(sink.nA).toBe(cGlow.length)
      cGlow.forEach((c, n) => {
        const o = n * INST
        expect(sink.A[o + 6]).toBe(K_GLOW)
        expect(sink.A[o + 7]).toBe(K_DUST)                  // rides on a dust sprite
        expect(sink.A[o]).toBeCloseTo(c.r[0] + c.r[2] / 2, 3)
        const mainAlpha0 = sink.A[o + 8] * Math.min(1.7, sink.A[o + 9])
        expect(Math.min(1, mainAlpha0 * sink.A[o + 10] * 0.9) * fs.flicker).toBeCloseTo(c.a, 6)
      })
      glows += cGlow.length
    }
    expect(glows).toBeGreaterThan(5)
    expect([...createSink(1).glowRgb]).toEqual([1, 1, 1])
  })

  it('the uiScale keeps motes the same visible size on a hi-dpi backing store', () => {
    const { a, b } = twinPosts(0, { count: 10, color: [235, 228, 190], size: 1.4, sway: 0.35, speed: 0.25 })
    const s1 = createSink(10), s2 = createSink(10)
    const f1 = modernFs('medium', 1), f2 = modernFs('medium', 1, { opts: { uiScale: 2 } })
    stepModern(a, f1, 1, s1); stepModern(b, f2, 1, s2)
    expect(s1.nN).toBe(s2.nN)
    expect(s2.N[2]).toBeCloseTo(s1.N[2] * 2, 5)
  })
})

describe('stepLegacy reproduces the legacy dots', () => {
  it('positions, radii and alpha (dust and sparks)', () => {
    for (const [lvl, pcfg] of [[0, { count: 45, color: [235, 228, 190], size: 1.4, sway: 0.35, speed: 0.25 }], [3, { count: 34, color: [170, 215, 255], size: 1.3, sway: 0.25, speed: 0.65, spark: true }]]) {
      const { a, b } = twinPosts(lvl, pcfg)
      const sink = createSink(pcfg.count)
      const r1 = mulberry32(99), r2 = mulberry32(99)
      for (let i = 1; i <= 50; i++) {
        const fs = tierFs('legacy', { t: i / 60, dt: 1 / 60, flicker: 0.8 })
        const { ctx, calls } = recorder()
        Math.random = () => r1(); drawParticles(ctx, fs, a)
        Math.random = () => r2(); stepLegacy(b, fs, sink)
        const arcs = calls.filter((c) => c.op === 'arc'), fills = calls.filter((c) => c.op === 'fill')
        expect(sink.nN).toBe(arcs.length)
        arcs.forEach((c, n) => {
          const o = n * INST
          expect(sink.N[o]).toBeCloseTo(c.x, 3); expect(sink.N[o + 1]).toBeCloseTo(c.y, 3); expect(sink.N[o + 2]).toBeCloseTo(c.r, 4)
          expect(sink.N[o + 6]).toBe(K_DISC)
          expect(Math.min(1, sink.N[o + 8]) * fs.flicker).toBeCloseTo(fills[n].a, 6)
        })
      }
    }
  })
})

describe('the shader sources', () => {
  const progs = { down: SH.DOWN_FS, grid: SH.GRID_FS, bright: SH.BRIGHT_FS, blur: SH.BLUR_FS, wide: SH.WIDE_FS, compose: SH.COMPOSE_FS, up: SH.UP_FS, lights: SH.LIGHTS_FS, particles: SH.PARTICLE_VS + SH.PARTICLE_FS }
  it('are GLSL ES 3.00', () => {
    for (const [k, src] of Object.entries(progs)) { expect(src.startsWith('#version 300 es'), k).toBe(true); expect(src, k).toContain('precision highp float') }
    expect(SH.FULLSCREEN_VS.startsWith('#version 300 es')).toBe(true)
  })
  it('declare every uniform the pass checks for (a missing one would be a GlError at creation)', () => {
    for (const [k, names] of Object.entries(SH.UNIFORMS)) {
      expect(names.length, k).toBeGreaterThan(0)
      for (const n of names) expect(new RegExp(`uniform\\s+[\\w\\s]*\\b${n}\\b`).test(progs[k]) || new RegExp(`\\b${n}\\b`).test(progs[k].replace(/uniform[^;]*;/g, '')) || progs[k].includes(n), `${k}.${n}`).toBe(true)
      // and there is no declared uniform the pass forgot to list
      const declared = [...progs[k].matchAll(/uniform\s+[\w]+\s+([^;]+);/g)].flatMap((m) => m[1].split(',').map((s) => s.trim().replace(/\[.*$/, '')))
      for (const d of declared) expect(names, `${k} declares ${d}`).toContain(d)
    }
  })
  it('use only what the CPU colour space allows: no sRGB conversion anywhere', () => {
    for (const [k, src] of Object.entries(progs)) expect(src, k).not.toMatch(/pow\([^)]*2\.2|0\.4545|srgb/i)
  })
})

describe('the legacy blackout is the CPU stage\'s own rule', () => {
  it('flickerOverlayAlpha is what the shader multiplies by (1 - a)', () => {
    expect(flickerOverlayAlpha({ flicker: 1, light: null })).toBe(0)
    expect(flickerOverlayAlpha({ flicker: 0.35, light: null, comfort: { maxGlobalDip: 1 } })).toBeCloseTo(0.4875)
    expect(flickerOverlayAlpha({ flicker: 0.35, light: { enabled: true } })).toBe(0)
  })
})
