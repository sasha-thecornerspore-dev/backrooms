// gfx-post.js — the screen-space atmosphere pass. Everything here is the pure math (grade, bloom bright pass and blur, grain clock,
// vignette falloff, the flicker-overlay rule, the light of the air) plus the legacy path pinned through a recording context. The
// canvas-heavy stages (bloom composite, veil, tape) are exercised by the harness scenes (tools/gfx/scenes-c.js), not here.
import { describe, it, expect } from 'vitest'
import {
  LEVEL_ATMOS, GAIN_FLOOR, resolveAtmos, resolveGrade, brightWeight, emitterLuma, blur5x3, bloomField, grainStep, grainOffset,
  legacyGrainPhase, lightModelLive, flickerOverlayAlpha, modernPost, vignetteAlpha, veilColors, buildVeil, VEIL_A, buildGrainTile,
  airLight, createPostState, seedParticles, drawParticles, drawGrain, composeFrame, drawFlickerOverlay, uiScaleOf, drawCrosshair, drawNameplates,
} from '../src/renderer/gfx-post.js'
import { TIERS } from '../src/renderer/gfx-quality.js'
import { hexToRgb } from '../src/renderer/gfx-util.js'

// a recording 2D context: every method call is logged; property writes are accepted
function mockCtx() {
  const calls = []
  const target = { calls }
  const grad = () => ({ addColorStop() {} })
  return new Proxy(target, {
    get(t, k) {
      if (k in t) return t[k]
      if (k === 'createLinearGradient' || k === 'createRadialGradient') return () => grad()
      if (k === 'createPattern') return () => ({})
      if (k === 'measureText') return () => ({ width: 10 })
      return (...a) => { calls.push([k, ...a]); }
    },
    set(t, k, v) { t[k] = v; return true },
  })
}
const names = (ctx) => ctx.calls.map((c) => c[0])

const PALETTES = {
  '0': { wall: '#C8B870', ceiling: '#E8E0C0', floor: '#4A3820', fog: '#D4C87A' },
  '1': { wall: '#8C8674', ceiling: '#9E9A88', floor: '#39372F', fog: '#A29C86' },
  '2': { wall: '#705C46', ceiling: '#4C4238', floor: '#2B2520', fog: '#5C503E' },
  '3': { wall: '#4C505A', ceiling: '#3A3E46', floor: '#22252B', fog: '#363B44' },
  '∅': { wall: '#B8A888', ceiling: '#B9B7AE', floor: '#5A5048', fog: '#9A968C' },
}

function baseFs(over = {}) {
  return {
    W: 100, H: 60, HH: 30, OW: 160, OH: 100, flicker: 1, rawFlicker: 1, t: 0, dt: 1 / 60, frame: 0, fov: 1.309, hf: 0.6545,
    player: { x: 1, y: 1, angle: 0 }, lights: {}, opts: { grain: true, particles: true, crosshair: true }, quality: TIERS.legacy,
    levelKey: '0', handled: { flashlight: false, glow: false }, light: { enabled: false }, ...over,
  }
}

describe('per-level atmosphere', () => {
  it('has an entry for every level and a neutral fallback for unknown or missing keys', () => {
    for (const k of ['0', '1', '2', '3', '∅', 'legacy']) expect(LEVEL_ATMOS[k], k).toBeTruthy()
    expect(resolveAtmos({ palette: PALETTES['0'] }).key).toBe('legacy')
    expect(resolveAtmos({ levelIndex: 7, palette: PALETTES['0'] }).tint).toEqual(LEVEL_ATMOS.legacy.tint)
    expect(() => resolveAtmos({})).not.toThrow()
    expect(() => resolveAtmos({ levelIndex: 2 })).not.toThrow()
  })
  it('every level grades within the floor: the highlight gain only removes light, never more than the floor, and the lift stays a veil', () => {
    for (const k of ['0', '1', '2', '3', '∅']) {
      const a = resolveAtmos({ levelIndex: k === '∅' ? '∅' : +k, palette: PALETTES[k] })
      for (let i = 0; i < 3; i++) {
        expect(a.grade.gain[i], `${k} gain ${i}`).toBeLessThanOrEqual(1)
        expect(a.grade.gain[i], `${k} gain ${i}`).toBeGreaterThanOrEqual(GAIN_FLOOR)
        expect(a.grade.lift[i], `${k} lift ${i}`).toBeGreaterThanOrEqual(0)
        expect(a.grade.lift[i], `${k} lift ${i}`).toBeLessThanOrEqual(8)
      }
      expect(a.vig.depth).toBeGreaterThan(0.3); expect(a.vig.depth).toBeLessThan(0.7)
    }
  })
  it('the cold cue survives: no level takes more than 5% of the blue channel relative to red', () => {
    for (const k of ['0', '1', '2', '3', '∅']) {
      const g = resolveAtmos({ levelIndex: k === '∅' ? '∅' : +k, palette: PALETTES[k] }).grade.gain
      expect(g[2] / g[0], k).toBeGreaterThanOrEqual(GAIN_FLOOR - 1e-9)
    }
  })
  it('levels are graded in their own hue: warm lobby, cold-green L1, amber L2, blue-white L3, cool L∅', () => {
    const G = (k) => resolveAtmos({ levelIndex: k === '∅' ? '∅' : +k, palette: PALETTES[k] }).grade
    expect(G('0').gain[2]).toBeLessThan(G('0').gain[0])          // warm: blue trimmed
    expect(G('1').gain[0]).toBeLessThan(G('1').gain[1])          // green: red trimmed
    expect(G('2').gain[2]).toBeLessThan(G('2').gain[0])          // amber
    expect(G('2').lift[0]).toBeGreaterThan(G('2').lift[2])       // amber shadows
    expect(G('3').gain[0]).toBeLessThan(G('3').gain[2])          // blue-white
    expect(G('3').lift[2]).toBeGreaterThan(G('3').lift[0])       // deep-blue shadows
    expect(G('∅').gain[0]).toBeLessThanOrEqual(G('∅').gain[2])   // cool overcast
  })
  it('is palette-relative: drifting the fog colour drags the grade toward the new hue', () => {
    const at = (fog) => resolveGrade(resolveAtmos({ levelIndex: 1, palette: { ...PALETTES['1'], fog } }), { fog })
    const red = at('#B04030'), blue = at('#3040B0')
    expect(red.gain[0] - red.gain[2]).toBeGreaterThan(blue.gain[0] - blue.gain[2])   // a red fog keeps its red, a blue fog keeps its blue
    expect(red.lift[0] / Math.max(1e-6, red.lift[2])).toBeGreaterThan(blue.lift[0] / Math.max(1e-6, blue.lift[2]))
    // and a palette with no fog entry still resolves
    expect(() => resolveGrade(resolveAtmos({ levelIndex: 1 }), {})).not.toThrow()
  })
  it('config.look.grade / .post override the level: tint, split, lift, strength, contrast, and the post scales', () => {
    const base = resolveAtmos({ levelIndex: 0, palette: PALETTES['0'] })
    expect(resolveAtmos({ levelIndex: 0, palette: PALETTES['0'], look: { grade: { strength: 0 } } }).grade).toEqual({ gain: [1, 1, 1], lift: [0, 0, 0] })
    const tinted = resolveAtmos({ levelIndex: 0, palette: PALETTES['0'], look: { grade: { tint: [0.96, 0.96, 1], split: [0, 0, 1] } } })
    expect(tinted.grade.gain[0]).toBeLessThan(base.grade.gain[0])
    expect(tinted.grade.lift[2]).toBeGreaterThan(tinted.grade.lift[0])
    expect(resolveAtmos({ levelIndex: 0, palette: PALETTES['0'], look: { grade: { contrast: 0.5 } } }).vig.depth).toBeCloseTo(base.vig.depth * 0.5, 10)
    expect(resolveAtmos({ levelIndex: 0, palette: PALETTES['0'], look: { post: { bloom: 0 } } }).bloom.off).toBe(true)
    expect(resolveAtmos({ levelIndex: 0, palette: PALETTES['0'], look: { post: { bloom: 2 } } }).bloom.gain).toBeCloseTo(base.bloom.gain * 2, 10)
    expect(resolveAtmos({ levelIndex: 0, palette: PALETTES['0'], look: { post: { grain: 0 } } }).grain).toEqual({ mul: 0, add: 0 })
    expect(resolveAtmos({ levelIndex: 0, palette: PALETTES['0'], look: { post: { tape: { drift: 3 } } } }).tape.drift).toBe(3)
  })
})

describe('bloom maths', () => {
  it('the bright pass is zero below the threshold, one above thr+knee, and monotone in between', () => {
    expect(brightWeight(0.5, 0.7, 0.2)).toBe(0)
    expect(brightWeight(0.7, 0.7, 0.2)).toBe(0)
    expect(brightWeight(0.9, 0.7, 0.2)).toBe(1)
    expect(brightWeight(1.0, 0.7, 0.2)).toBe(1)
    let prev = 0
    for (let l = 0.7; l <= 0.9; l += 0.01) { const w = brightWeight(l, 0.7, 0.2); expect(w).toBeGreaterThanOrEqual(prev); prev = w }
    expect(brightWeight(0.8, 0.7, 0)).toBeGreaterThanOrEqual(0)   // a zero knee must not divide by zero
  })
  it('the emitter luma counts a saturated cold beam (bright in one channel) but not a mid-grey wall', () => {
    expect(emitterLuma(1, 1, 1)).toBeCloseTo(1, 10)
    expect(emitterLuma(0, 0, 0)).toBe(0)
    expect(emitterLuma(0.7, 0.8, 0.95)).toBeGreaterThan(emitterLuma(0.5, 0.5, 0.5))
    expect(emitterLuma(0.2, 0.2, 1)).toBeGreaterThan(0.5)
    expect(emitterLuma(0.5, 0.5, 0.5)).toBeCloseTo(0.5, 10)
  })
  it('blur5x3 keeps a flat field flat, conserves the energy of an interior spike, and spreads it symmetrically', () => {
    const w = 15, h = 11, n = w * h * 3
    const flat = new Float32Array(n).fill(0.6), tmp = new Float32Array(n)
    blur5x3(flat, tmp, w, h)
    for (const v of flat) expect(v).toBeCloseTo(0.6, 5)
    const P = new Float32Array(n)
    P[(5 * w + 7) * 3] = 1
    blur5x3(P, tmp, w, h)
    let sum = 0
    for (let i = 0; i < n; i += 3) sum += P[i]
    expect(sum).toBeCloseTo(1, 4)
    const at = (x, y) => P[(y * w + x) * 3]
    expect(at(7, 5)).toBeGreaterThan(at(8, 5)); expect(at(8, 5)).toBeGreaterThan(at(9, 5))
    expect(at(6, 5)).toBeCloseTo(at(8, 5), 6); expect(at(7, 4)).toBeCloseTo(at(7, 6), 6)
    expect(at(7, 5)).toBeCloseTo((6 / 16) * (6 / 16), 5)
    expect(P[1]).toBe(0)                                            // channels do not bleed into each other
  })
  function fakeBloom(BW, BH) {
    const wW = Math.max(2, BW >> 2), wH = Math.max(2, BH >> 2), n = BW * BH
    return { BW, BH, wW, wH, P: new Float32Array(n * 3), tmp: new Float32Array(n * 3), luma: new Uint8Array(n), W: new Float32Array(wW * wH * 3), wtmp: new Float32Array(wW * wH * 3), imgOut: { data: new Uint8ClampedArray(n * 4) } }
  }
  const A = { thr: 0.8, knee: 0.15, gain: 0.6, wide: 0.4, tint: [1, 1, 1], tintMix: 0 }
  it('a dark frame produces no halo (and reports it, so the caller can skip the composite)', () => {
    const bl = fakeBloom(24, 14), px = new Uint8ClampedArray(24 * 14 * 4).fill(60)
    expect(bloomField(bl, px, A)).toBe(false)
  })
  it('a bright block on a dark frame glows: alpha is highest at the block, falls off, and never comes from the dark far corner', () => {
    const BW = 32, BH = 20, bl = fakeBloom(BW, BH), px = new Uint8ClampedArray(BW * BH * 4)
    for (let i = 0; i < BW * BH; i++) { px[i * 4] = px[i * 4 + 1] = px[i * 4 + 2] = 30; px[i * 4 + 3] = 255 }
    for (let y = 8; y < 12; y++) for (let x = 14; x < 18; x++) { const o = (y * BW + x) * 4; px[o] = 255; px[o + 1] = 240; px[o + 2] = 190 }
    expect(bloomField(bl, px, A)).toBe(true)
    const a = (x, y) => bl.imgOut.data[(y * BW + x) * 4 + 3]
    expect(a(15, 9)).toBeGreaterThan(a(15, 13)); expect(a(15, 13)).toBeGreaterThan(a(15, 17))
    expect(a(15, 9)).toBeGreaterThan(a(2, 2))
    expect(a(15, 9)).toBeLessThanOrEqual(255)
    // the halo keeps the emitter's hue (warm): red >= green >= blue at the core
    const o = (9 * BW + 15) * 4
    expect(bl.imgOut.data[o]).toBeGreaterThanOrEqual(bl.imgOut.data[o + 1]); expect(bl.imgOut.data[o + 1]).toBeGreaterThanOrEqual(bl.imgOut.data[o + 2])
    // the frame brightness map (used by the particles) was filled either way
    expect(bl.luma[9 * BW + 15]).toBeGreaterThan(200); expect(bl.luma[0]).toBeLessThan(60)
  })
  it('tintMix pulls the halo toward the lamp colour, and a cold emitter stays cold with no tint', () => {
    const BW = 24, BH = 16, px = new Uint8ClampedArray(BW * BH * 4)
    for (let i = 0; i < BW * BH; i++) { px[i * 4 + 3] = 255; px[i * 4] = 20; px[i * 4 + 1] = 20; px[i * 4 + 2] = 20 }
    for (let y = 6; y < 10; y++) for (let x = 10; x < 14; x++) { const o = (y * BW + x) * 4; px[o] = 170; px[o + 1] = 210; px[o + 2] = 250 }   // the exit beam
    const cold = fakeBloom(BW, BH); bloomField(cold, px, { ...A, tint: [1, 0.7, 0.3], tintMix: 0 })
    const warm = fakeBloom(BW, BH); bloomField(warm, px, { ...A, tint: [1, 0.7, 0.3], tintMix: 0.9 })
    const o = (8 * BW + 12) * 4
    expect(cold.imgOut.data[o + 2]).toBeGreaterThan(cold.imgOut.data[o])       // blue > red: still a cold halo
    expect(warm.imgOut.data[o]).toBeGreaterThan(warm.imgOut.data[o + 2])       // a strong tint does pull it warm
  })
})

describe('film grain', () => {
  it('the legacy phase is the old per-frame 37 at 60 fps, exactly', () => {
    for (let n = 0; n < 500; n++) expect(legacyGrainPhase(n / 60)).toBe((37 * n) & 63)
  })
  it('the film-rate step is a clock, not a frame count: same steps per second at any display rate', () => {
    for (const hz of [30, 60, 144, 240]) {
      const steps = new Set()
      for (let f = 0; f < hz * 2; f++) steps.add(grainStep(f / hz, 24))
      expect(steps.size).toBeGreaterThanOrEqual(47); expect(steps.size).toBeLessThanOrEqual(49)   // ~24 per second over 2 s
    }
    expect(grainStep(1, 24)).toBe(24)
  })
  it('the grain offset is a pure hash of the step, inside the tile, and uncorrelated between neighbouring steps', () => {
    expect(grainOffset(5, 256)).toEqual(grainOffset(5, 256))
    const seen = new Set()
    for (let s = 0; s < 200; s++) { const [x, y] = grainOffset(s, 256); expect(x).toBeGreaterThanOrEqual(0); expect(x).toBeLessThan(256); expect(y).toBeLessThan(256); seen.add(x + ',' + y) }
    expect(seen.size).toBeGreaterThan(190)
    let adjacentSame = 0
    for (let s = 0; s < 200; s++) if (grainOffset(s, 256)[0] === grainOffset(s + 1, 256)[0]) adjacentSame++
    expect(adjacentSame).toBeLessThan(5)
  })
  it('the tile holds dark grains (black) and light grains (white), all within the configured peak alpha, deterministically', () => {
    let captured = null
    const mk = (w, h) => ({ width: w, height: h, getContext: () => ({ createImageData: (a, b) => ({ data: new Uint8ClampedArray(a * b * 4) }), putImageData: (img) => { captured = img } }) })
    buildGrainTile(mk, 0.06, 0.03)
    const first = Buffer.from(captured.data)
    let dark = 0, light = 0, maxDarkA = 0, maxLightA = 0
    for (let i = 0; i < captured.data.length; i += 4) {
      const a = captured.data[i + 3]
      if (captured.data[i] === 0) { dark++; maxDarkA = Math.max(maxDarkA, a) } else { light++; maxLightA = Math.max(maxLightA, a) }
    }
    expect(dark).toBeGreaterThan(30000); expect(light).toBeGreaterThan(30000)
    expect(maxDarkA).toBeLessThanOrEqual(Math.round(0.06 * 255)); expect(maxLightA).toBeLessThanOrEqual(Math.round(0.03 * 255))
    expect(maxDarkA).toBeGreaterThan(8)
    buildGrainTile(mk, 0.06, 0.03)
    expect(first.equals(Buffer.from(captured.data))).toBe(true)
  })
})

describe('vignette and veil', () => {
  it('falls off smoothly from `from` to the corners: zero inside, depth at the edge, monotone between', () => {
    expect(vignetteAlpha(0, 0.5, 0.3)).toBe(0); expect(vignetteAlpha(0.3, 0.5, 0.3)).toBe(0)
    expect(vignetteAlpha(1.02, 0.5, 0.3)).toBeCloseTo(0.5, 10); expect(vignetteAlpha(2, 0.5, 0.3)).toBeCloseTo(0.5, 10)
    let prev = 0
    for (let r = 0.3; r <= 1.02; r += 0.02) { const v = vignetteAlpha(r, 0.5, 0.3); expect(v).toBeGreaterThanOrEqual(prev); prev = v }
  })
  it('the veil colours are the lift over VEIL_A (so blending the veil at VEIL_A lifts black by exactly `lift`), capped at 255', () => {
    const { V, D } = veilColors({ lift: [4, 8, 12] })
    for (let i = 0; i < 3; i++) expect(V[i] * VEIL_A).toBeCloseTo([4, 8, 12][i], 6)
    expect(D[0]).toBeLessThan(V[0])
    expect(veilColors({ lift: [200, 0, 0] }).V[0]).toBe(255)
  })
  it('buildVeil paints a centre of (veil colour, VEIL_A) and a corner of (dark, depth)', () => {
    const stops = []
    const g = { createRadialGradient: () => ({ addColorStop: (o, c) => stops.push([o, c]) }), fillRect() {}, set fillStyle(v) {} }
    buildVeil((w, h) => ({ width: w, height: h, getContext: () => g }), 100, 60, { lift: [4, 4, 4], gain: [1, 1, 1] }, { depth: 0.5, from: 0.3 })
    expect(stops.length).toBe(13)
    expect(stops[0][0]).toBe(0); expect(stops[12][0]).toBe(1)
    expect(stops[0][1]).toBe(`rgba(80,80,80,${VEIL_A.toFixed(4)})`)
    expect(+stops[12][1].match(/,([\d.]+)\)$/)[1]).toBeCloseTo(0.5, 2)             // the corner is (almost exactly) the full depth
  })
})

describe('the flicker overlay rule (the photosensitivity fix)', () => {
  it('without a light model: the legacy blackout, 0.75 * (1 - flicker) below 0.9 and nothing above', () => {
    expect(flickerOverlayAlpha(baseFs({ flicker: 0.35 }))).toBeCloseTo(0.4875, 10)
    expect(flickerOverlayAlpha(baseFs({ flicker: 0.9 }))).toBe(0)
    expect(flickerOverlayAlpha(baseFs({ flicker: 1 }))).toBe(0)
    expect(flickerOverlayAlpha(baseFs({ flicker: 0.14 }))).toBeCloseTo(0.645, 10)
  })
  it('with a live light model the overlay is skipped entirely, however deep the dip', () => {
    for (const f of [0.9, 0.5, 0.14, 0]) expect(flickerOverlayAlpha(baseFs({ flicker: f, light: { enabled: true } }))).toBe(0)
    expect(lightModelLive(baseFs({ light: { enabled: true } }))).toBe(true)
    expect(lightModelLive(baseFs({ light: { enabled: false } }))).toBe(false)
    expect(lightModelLive(baseFs({ light: undefined }))).toBe(false)
  })
  it('draws the black overlay only when the rule says so', () => {
    const a = mockCtx(); drawFlickerOverlay(a, baseFs({ flicker: 0.35 }))
    expect(names(a)).toEqual(['fillRect']); expect(+a.fillStyle.match(/,([\d.]+)\)$/)[1]).toBeCloseTo(0.4875, 10)
    const b = mockCtx(); drawFlickerOverlay(b, baseFs({ flicker: 0.35, light: { enabled: true } }))
    expect(names(b)).toEqual([])
    const c = mockCtx(); drawFlickerOverlay(c, baseFs({ flicker: 1 }))
    expect(names(c)).toEqual([])
  })
})

describe('tier gating', () => {
  it('only tiers above legacy (and never a bare fs) get the atmosphere pass', () => {
    expect(modernPost({})).toBe(false)
    expect(modernPost({ quality: TIERS.legacy })).toBe(false)
    for (const t of ['low', 'medium', 'high']) expect(modernPost({ quality: TIERS[t] })).toBe(true)
  })
})

describe('the light of the air (what particles catch)', () => {
  const A = LEVEL_ATMOS['2'].part, out = { L: 0, g: 0 }, OW = 960, OH = 540
  it('no lights: an ambient floor plus a term that grows toward the ceiling fixtures', () => {
    const top = airLight(480, 20, OW, OH, A, {}, null, { L: 0, g: 0 }).L, low = airLight(480, 520, OW, OH, A, {}, null, { L: 0, g: 0 }).L
    expect(top).toBeGreaterThan(low); expect(low).toBeCloseTo(A.ambient + A.top * (1 - 520 / OH), 10)
  })
  it('a flashlight lights the dust in its cone and not the dust at the edge of the frame', () => {
    const inCone = airLight(480, 280, OW, OH, A, { flashlight: true }, null, { L: 0, g: 0 }).L
    const outside = airLight(30, 500, OW, OH, A, { flashlight: true }, null, { L: 0, g: 0 }).L
    expect(inCone).toBeGreaterThan(outside + A.flash * 0.8)
  })
  it('a glowstick reports how much of the light is its own (for tinting) near it and ~0 far away', () => {
    expect(airLight(480, 320, OW, OH, A, { glow: [80, 235, 110] }, null, { L: 0, g: 0 }).g).toBeGreaterThan(0.8)
    expect(airLight(20, 20, OW, OH, A, { glow: [80, 235, 110] }, null, { L: 0, g: 0 }).g).toBeLessThan(0.05)
  })
  it('the measured frame brightness scales it: dust is lit where the scene is lit', () => {
    const dim = airLight(480, 280, OW, OH, A, {}, 0.1, { L: 0, g: 0 }).L, bright = airLight(480, 280, OW, OH, A, {}, 0.9, { L: 0, g: 0 }).L
    expect(bright).toBeGreaterThan(dim * 1.5)
    expect(airLight(1, 1, OW, OH, A, {}, 0.5, out)).toBe(out)     // writes into the caller's object: no allocation per particle
  })
})

describe('legacy path is the pre-overhaul pipeline', () => {
  const cfg = { levelIndex: 0, palette: PALETTES['0'], particles: { count: 3, color: [235, 228, 190], size: 1.4, sway: 0.35, speed: 0.25 } }
  it('composeFrame at the legacy tier: grain into the low-res buffer, upscale, vignette, particles, lights, crosshair — in the old order', () => {
    const post = createPostState(cfg); post.grainPattern = {}; post.vignette = { tag: 'vignette' }
    seedParticles(post, 160, 100)
    const ctx = mockCtx(), wctx = mockCtx(), world = { tag: 'world' }
    composeFrame(ctx, wctx, world, baseFs({ lights: { flashlight: true } }), post, [])
    expect(names(wctx)).toEqual(['save', 'translate', 'fillRect', 'restore'])              // legacy grain, source-over, on the low-res buffer
    expect(wctx.globalAlpha).toBe(0.045)
    const c = ctx.calls
    expect(c[0][0]).toBe('drawImage'); expect(c[0][1]).toBe(world)                        // upscale first
    expect(c[1][0]).toBe('drawImage'); expect(c[1][1]).toBe(post.vignette)                // then the legacy vignette
    expect(names(ctx)).toContain('arc')                                                   // particles are the old filled arcs
    expect(ctx.calls.filter((x) => x[0] === 'fillRect').length).toBeGreaterThanOrEqual(2) // flashlight wash + crosshair
    expect(names(ctx).indexOf('arc')).toBeGreaterThan(1)
  })
  it('legacy composeFrame still draws the blackout in a dip, with or without a stub light model... only WITHOUT one', () => {
    const post = createPostState(cfg); post.vignette = {}
    const dark = mockCtx(); composeFrame(dark, mockCtx(), {}, baseFs({ flicker: 0.4 }), post, [])
    expect(dark.calls.some((x) => x[0] === 'fillRect' && x[3] === 160 && x[4] === 100)).toBe(true)
    const lit = mockCtx(); composeFrame(lit, mockCtx(), {}, baseFs({ flicker: 0.4, light: { enabled: true } }), post, [])
    expect(lit.calls.some((x) => x[0] === 'fillRect' && x[3] === 160 && x[4] === 100)).toBe(false)
  })
  it('legacy grain follows the clock: 60 fps and 144 fps land on the same phase at the same time', () => {
    const phases = (hz, t) => { const post = createPostState(cfg); post.grainPattern = {}; drawGrain(mockCtx(), baseFs({ t }), post); return post.grainPhase }
    for (const t of [1, 2.5, 10]) expect(phases(60, t)).toBe(phases(144, t))
    expect(phases(60, 1 / 60)).toBe(37)
  })
  it('legacy particles advance by real time: a 144 Hz frame moves a mote 60/144 of a 60 Hz frame, and 60 Hz is the old step', () => {
    const make = () => { const post = createPostState(cfg); seedParticles(post, 160, 100); post.particles.forEach((p) => { p.x = 80; p.y = 50; p.z = 0.8; p.ph = 0 }); return post }
    const a = make(), b = make()
    drawParticles(mockCtx(), baseFs({ dt: 1 / 60 }), a)
    drawParticles(mockCtx(), baseFs({ dt: 1 / 144 }), b)
    const dy60 = a.particles[0].y - 50, dy144 = b.particles[0].y - 50
    expect(dy60).toBeCloseTo(0.25 * (0.5 + 0.8), 10)                                       // speed * (0.5 + z) per 60 Hz frame: the old step
    expect(dy144).toBeCloseTo(dy60 * 60 / 144, 10)
    expect(a.particles[0].ph).toBeCloseTo(0.02, 10)
  })
  it('particles honour opts.particles and the tier flag', () => {
    const post = createPostState(cfg); seedParticles(post, 160, 100)
    const off = mockCtx(); drawParticles(off, baseFs({ opts: { particles: false } }), post); expect(off.calls.length).toBe(0)
    const off2 = mockCtx(); drawParticles(off2, baseFs({ quality: { ...TIERS.legacy, particles: false } }), post); expect(off2.calls.length).toBe(0)
  })
})

describe('modern path in Node (no DOM): degrades to the parts that need none', () => {
  it('composeFrame at a modern tier runs without a document: no throw, upscale + crosshair still happen, no legacy vignette', () => {
    const post = createPostState({ levelIndex: 0, palette: PALETTES['0'], particles: { count: 2 } }); post.vignette = { tag: 'legacy-vignette' }
    seedParticles(post, 160, 100)
    const ctx = mockCtx(), wctx = mockCtx(), world = { tag: 'world' }
    expect(typeof document).toBe('undefined')
    composeFrame(ctx, wctx, world, baseFs({ quality: TIERS.high, t: 0.5 }), post, [])
    expect(ctx.calls[0][0]).toBe('drawImage'); expect(ctx.calls[0][1]).toBe(world)
    expect(ctx.calls.some((c) => c[1] === post.vignette)).toBe(false)
    expect(ctx.calls.some((c) => c[0] === 'fillRect')).toBe(true)                          // the crosshair
  })
  it('the tape layer is off by default and never touches the drift without the pref', () => {
    const post = createPostState({ levelIndex: 0, palette: PALETTES['0'] })
    const ctx = mockCtx()
    composeFrame(ctx, mockCtx(), {}, baseFs({ quality: TIERS.medium, t: 3 }), post, [])
    const up = ctx.calls[0]
    expect(up.slice(6)).toEqual([0, 0, 160, 100])                                       // dest = the whole canvas, no drift offset
  })
  it('createPostState resolves the level atmosphere once and copes with any config', () => {
    expect(createPostState({ levelIndex: 3, palette: PALETTES['3'], particles: { count: 5 } }).atmos.key).toBe('3')
    expect(createPostState({ palette: PALETTES['0'] }).atmos.key).toBe('legacy')
    expect(createPostState({}).count).toBe(0)
    expect(hexToRgb(PALETTES['0'].fog)).toEqual([212, 200, 122])
  })
})

describe('overlays follow opts.uiScale (a hiDpi backing store must not shrink them)', () => {
  it('uiScaleOf is 1 unless a positive finite number is set', () => {
    expect(uiScaleOf(baseFs())).toBe(1)
    expect(uiScaleOf(baseFs({ opts: { uiScale: 0 } }))).toBe(1)
    expect(uiScaleOf(baseFs({ opts: { uiScale: NaN } }))).toBe(1)
    expect(uiScaleOf(baseFs({ opts: { uiScale: 2 } }))).toBe(2)
  })
  it('the crosshair is drawn at the same place and size when unscaled, and under scale(u) about the centre when scaled', () => {
    const a = mockCtx(); drawCrosshair(a, baseFs())
    expect(a.calls.some((c) => c[0] === 'scale')).toBe(false)
    expect(a.calls.filter((c) => c[0] === 'fillRect')[0]).toEqual(['fillRect', 78, 48, 4, 4])
    const b = mockCtx(); drawCrosshair(b, baseFs({ opts: { crosshair: true, uiScale: 2 } }))
    expect(b.calls.find((c) => c[0] === 'scale')).toEqual(['scale', 2, 2])
    expect(b.calls.filter((c) => c[0] === 'fillRect')[0]).toEqual(['fillRect', 38, 23, 4, 4])         // (160/2/2 - 2, 100/2/2 - 2): the centre once scaled by 2
  })
  it('nameplates are positioned in CSS px under scale(u)', () => {
    const plate = { sx: 50, y: 40, name: 'ab', alpha: 1, speech: null, hp: null }
    const a = mockCtx(); drawNameplates(a, baseFs({ quality: { ...TIERS.legacy, scale: 1 }, opts: { uiScale: 2 } }), [plate])
    expect(a.calls.find((c) => c[0] === 'scale')).toEqual(['scale', 2, 2])
    expect(a.calls.find((c) => c[0] === 'fillText')).toEqual(['fillText', 'ab', 25, 18])              // x = 50/2, y = max(16, 40/2) - 2
  })
})
