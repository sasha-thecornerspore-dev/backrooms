// Track HS (sprites): one plan for both backends, and a faster CPU blitter that draws exactly the same bytes.
//   * planSprites() is the only place sprite decisions are made; the CPU blitter (blitPlan / drawSprites) and the GPU instance builder
//     (gfx-gl-sprites-plan.js) consume the same records — pinned here record by record.
//   * The blitter's shortcuts (the texel-column walk done once per blit, the texel rows' opaque spans, the per-column lit-face table, int32
//     texel reads) must not change a byte: every plan of a randomised sweep is blitted by the shipped blitter and by REFERENCE, a verbatim copy
//     of the per-pixel walk the pass had before them, and the buffers must be identical.
//   * The level's background warm list comes from its config (prewarmSprites), with the built-in list only as a fallback.
import { describe, it, expect, vi, beforeAll } from 'vitest'
import { mulberry32 } from '../src/renderer/gfx-util.js'
import {
  planSprites, blitPlan, drawSprites, visibleRuns, rowSpans, getFrame, prewarmSprites, resetAtlas, atlasStats, shadowAlpha, packLayer, createPaint,
  PROP_SPEC, FIG, ITEM_COLORS, SIGHT_SPEC,
} from '../src/renderer/gfx-sprites.js'
import { createSpritePlanner, IF, F_MIRROR, F_RIM, F_SHADOW, MODE_SCREEN } from '../src/renderer/gfx-gl-sprites-plan.js'
import { readFileSync } from 'node:fs'

const FOV = Math.PI / 2.4
const frozen = (fn) => { const spy = vi.spyOn(performance, 'now').mockReturnValue(0); try { return fn() } finally { spy.mockRestore() } }

// ── REFERENCE: the pass's blitter before the HS optimisations, verbatim, reading a plan record instead of the old job object ──
const SIN_N = 1024
const SINT = new Float32Array(SIN_N)
for (let i = 0; i < SIN_N; i++) SINT[i] = Math.sin((i / SIN_N) * Math.PI * 2)
const sinc = (cycles) => SINT[(cycles * SIN_N) & (SIN_N - 1)]
const DITH = new Uint8Array(4096)
{ const r = mulberry32(0xd17e7); for (let i = 0; i < 4096; i++) DITH[i] = (r() * 255) | 0 }
function referenceBlit(J, BUF, ZB, CW, CH) {
  const mip = J.mip, X0 = J.X0, X1 = J.X1, Yt = J.Yt, Yb = J.Yb, depth = J.depth, mirror = J.mirror
  const sw = X1 - X0, sh = Yb - Yt
  if (sw < 0.6 || sh < 0.6) return
  const warp = J.lean !== 0 || J.swayA !== 0 || J.rippleA !== 0
  const pad = warp ? Math.ceil(Math.abs(J.lean) + Math.abs(J.swayA) + Math.abs(J.rippleA)) + 1 : 0
  let xa = Math.floor(X0 - pad), xb = Math.ceil(X1 + pad)
  if (xa < 0) xa = 0
  if (xb > CW) xb = CW
  let ya = Math.floor(Yt), yb = Math.ceil(Yb)
  if (ya < 0) ya = 0
  if (yb > CH) yb = CH
  if (xb <= xa || yb <= ya) return
  const RUNS = new Int32Array((xb - xa) + 8)
  const nr = visibleRuns(ZB, xa, xb, depth, RUNS)
  if (nr === 0) return

  const tw = mip.w, th = mip.h, tpx = mip.px
  const rimP = J.rim ? mip.rim : null
  const sxF = tw / sw, syF = th / sh
  const buf = BUF, W = CW
  const mr = J.mr, mg = J.mg, mb = J.mb, fr = J.fr, fg = J.fg, fb = J.fb, A255 = J.A / 255
  const opaqueA = J.A >= 0.9999
  const fr255 = 255 * fr, fg255 = 255 * fg, fb255 = 255 * fb
  const screen = J.screen
  const cm0 = J.cm0, cmK = J.cmK, cmX = J.cmX
  const useCm = cmK !== 0 || cm0 !== 1
  const dith0 = J.dith, ddx = J.dx, ddy = J.dy, dph = J.dph
  const rimS = J.rimS, rimB = J.rimB, rimR = J.rimR, rimG = J.rimG, rimBl = J.rimBl
  const plain = rimP === null && dith0 === 0
  const txMax = tw - 1
  const A256 = (J.A * 256) | 0
  const mri = (mr * 256) | 0, mgi = (mg * 256) | 0, mbi = (mb * 256) | 0
  const fri = (fr * 256) | 0, fgi = (fg * 256) | 0, fbi = (fb * 256) | 0
  const fr255i = (fr255 * 256) | 0, fg255i = (fg255 * 256) | 0, fb255i = (fb255 * 256) | 0
  const dtf = mirror ? -sxF : sxF

  for (let y = ya; y < yb; y++) {
    let ty = ((y + 0.5 - Yt) * syF) | 0
    if (ty >= th) ty = th - 1
    const rowT = ty * tw
    let rx0 = X0
    if (warp) {
      const v = (Yb - (y + 0.5)) / sh
      rx0 += J.lean * v * v + J.swayA * sinc(J.swayP + v * 0.55) * v + J.rippleA * sinc(J.rippleP + v * 2.4) * (1 - v * 0.55)
    }
    const xl = Math.ceil(rx0 - 0.5), xr = Math.ceil(rx0 + sw - 0.5)
    const dith = dith0 > 0 ? dith0 * (0.25 + 1.5 * (0.5 + 0.5 * sinc(y * 0.021 + dph))) : 0
    const rowB = y * W
    for (let r = 0; r < nr; r++) {
      let xs = RUNS[r * 2], xe = RUNS[r * 2 + 1]
      if (xs < xl) xs = xl
      if (xe > xr) xe = xr
      if (xs >= xe) continue
      let tf = mirror ? tw - (xs + 0.5 - rx0) * sxF : (xs + 0.5 - rx0) * sxF
      if (screen) {
        for (let x = xs; x < xe; x++) {
          let tx = tf | 0
          tf += dtf
          if (tx > txMax) tx = txMax
          else if (tx < 0) tx = 0
          const p = tpx[rowT + tx]
          if ((p >>> 24) === 0) continue
          let s0 = mri
          if (useCm) { let cm = cm0 + cmK * (x - cmX); if (cm < 0.15) cm = 0.15; s0 = (mri * cm) | 0 }
          const bi = rowB + x, d = buf[bi]
          const dr = d & 255, dg = (d >> 8) & 255, db = (d >> 16) & 255
          let r2 = dr + ((((p & 255) * s0) >> 8) * (255 - dr) * 257 >> 16), g2 = dg + (((((p >> 8) & 255) * s0) >> 8) * (255 - dg) * 257 >> 16), b2 = db + (((((p >> 16) & 255) * s0) >> 8) * (255 - db) * 257 >> 16)
          if (r2 > 255) r2 = 255
          if (g2 > 255) g2 = 255
          if (b2 > 255) b2 = 255
          buf[bi] = (255 << 24) | (b2 << 16) | (g2 << 8) | r2
        }
      } else if (plain) {
        for (let x = xs; x < xe; x++) {
          let tx = tf | 0
          tf += dtf
          if (tx > txMax) tx = txMax
          else if (tx < 0) tx = 0
          const p = tpx[rowT + tx]
          const a = p >>> 24
          if (a === 0) continue
          let mrc = mri, mgc = mgi, mbc = mbi
          if (useCm) { let cm = cm0 + cmK * (x - cmX); if (cm < 0.15) cm = 0.15; const ci = (cm * 256) | 0; mrc = (mri * ci) >> 8; mgc = (mgi * ci) >> 8; mbc = (mbi * ci) >> 8 }
          const bi = rowB + x
          let r2, g2, b2
          if (a === 255 && opaqueA) {
            r2 = ((p & 255) * mrc + fr255i + 128) >> 8; g2 = (((p >> 8) & 255) * mgc + fg255i + 128) >> 8; b2 = (((p >> 16) & 255) * mbc + fb255i + 128) >> 8
          } else {
            const d = buf[bi], ki = 256 - ((a * A256) >> 8)
            r2 = ((d & 255) * ki + (p & 255) * mrc + a * fri + 128) >> 8
            g2 = (((d >> 8) & 255) * ki + ((p >> 8) & 255) * mgc + a * fgi + 128) >> 8
            b2 = (((d >> 16) & 255) * ki + ((p >> 16) & 255) * mbc + a * fbi + 128) >> 8
          }
          if (r2 > 255) r2 = 255
          if (g2 > 255) g2 = 255
          if (b2 > 255) b2 = 255
          buf[bi] = (255 << 24) | (b2 << 16) | (g2 << 8) | r2
        }
      } else {
        for (let x = xs; x < xe; x++) {
          let tx = tf | 0
          tf += dtf
          if (tx > txMax) tx = txMax
          else if (tx < 0) tx = 0
          const ti = rowT + tx
          const p = tpx[ti]
          const a = p >>> 24
          if (a === 0) continue
          let cm = 1
          if (useCm) { cm = cm0 + cmK * (x - cmX); if (cm < 0.15) cm = 0.15 }
          const bi = rowB + x
          const d = buf[bi]
          let ak = a * A255, dk = 1
          if (dith > 0 && DITH[(((x >> 1) + ddx) & 63) | ((((y >> 1) + ddy) & 63) << 6)] < (rimP !== null ? dith * (0.15 + 2.7 * (rimP[ti] > 128 ? rimP[ti] - 128 : 128 - rimP[ti]) * (1 / 127)) : dith)) { dk = 0.55; ak *= 0.55 }
          const k = 1 - ak
          const m0 = cm * dk
          let r2 = (d & 255) * k + (p & 255) * mr * m0 + a * fr * dk
          let g2 = ((d >> 8) & 255) * k + ((p >> 8) & 255) * mg * m0 + a * fg * dk
          let b2 = ((d >> 16) & 255) * k + ((p >> 16) & 255) * mb * m0 + a * fb * dk
          if (rimP !== null) {
            const rv = rimP[ti] - 128
            const e = (mirror ? -rv : rv) * rimS + (rv < 0 ? -rv : rv) * rimB
            if (e > 0) { r2 += rimR * e; g2 += rimG * e; b2 += rimBl * e }
          }
          if (r2 > 255) r2 = 255
          if (g2 > 255) g2 = 255
          if (b2 > 255) b2 = 255
          buf[bi] = (255 << 24) | (b2 << 16) | (g2 << 8) | r2
        }
      }
    }
  }
}

// ── a randomised sweep of frames: every entity kind, near (magnified, clamped texel walks) to far, mirrored, warped, rimmed, dissolving,
// behind walls and in the open, legacy and lit, flashlight, reduced motion ──
function sweepFrames(n, seed) {
  const rnd = mulberry32(seed)
  const pick = (a) => a[(rnd() * a.length) | 0]
  const props = Object.keys(PROP_SPEC), figs = Object.keys(FIG), items = Object.keys(ITEM_COLORS), sights = Object.keys(SIGHT_SPEC)
  const frames = []
  for (let f = 0; f < n; f++) {
    const W = 120 + ((rnd() * 80) | 0), H = 72 + ((rnd() * 40) | 0)
    const ents = []
    const at = () => { const d = 0.4 + rnd() * rnd() * 13, b = (rnd() - 0.5) * 1.4; return [d * Math.cos(b), d * Math.sin(b)] }
    for (let i = 0; i < 9; i++) {
      const [x, y] = at(), k = (rnd() * 9) | 0
      if (k <= 2) ents.push({ kind: 'prop', type: pick(props), x, y, rot: rnd() * 20, key: 'p' + i })
      else if (k === 3) ents.push({ x, y, type: 'stalker', variant: pick(figs), state: pick(['idle', 'chase', 'flee', 'stagger']), dir: rnd() * 6.3, stagger: rnd() < 0.2 ? 1.5 : 0, chunkCx: i, chunkCy: f })
      else if (k === 4) ents.push({ x, y, variant: pick(figs), vx: rnd() * 2.6, vy: rnd() * 1.5 })
      else if (k === 5) ents.push({ kind: 'item', itemType: pick(items), x, y, key: 'i' + i })
      else if (k === 6) ents.push(rnd() < 0.5 ? { kind: 'note', read: rnd() < 0.5, x, y, frag: i, key: 'n' + i } : { kind: 'exit', x, y, key: 'e' + i })
      else if (k === 7) ents.push(rnd() < 0.5 ? { kind: 'machine', vended: rnd() < 0.5, x, y, key: 'm' + i } : { kind: 'sight', sightType: pick(sights), x, y, key: 's' + i })
      else ents.push(rnd() < 0.5 ? { kind: 'npc', name: 'a lost soul', x, y, key: 'l' + i } : { kind: 'player', name: 'p' + i, x, y, angle: rnd() * 6.3, key: 'q' + i })
    }
    const ex = 2 + rnd() * 6, ey = (rnd() - 0.5) * 6
    // a stand-in light model: a deterministic function of the position (the same entity is lit the same way by every plan of the frame)
    const lr = rnd() * 1000, h = (x, y, k) => { const v = Math.sin(x * 12.9898 + y * 78.233 + lr + k) * 43758.5453; return v - Math.floor(v) }
    const light = rnd() < 0.5 ? null : { enabled: true, at: (x, y) => 0.3 + h(x, y, 1) * 1.2, tint: (x, y) => [0.8 + h(x, y, 2) * 0.4, 0.8 + h(x, y, 3) * 0.4, 0.8 + h(x, y, 4) * 0.4], nearest: (x, y) => (h(x, y, 5) < 0.8 ? { x: ex, y: ey, dist: Math.hypot(ex - x, ey - y), r: 255, g: 230, b: 180 } : null) }
    const zb = new Float32Array(W)
    for (let x = 0; x < W; x++) zb[x] = 1e9
    for (let w = 0; w < 3; w++) { const a = (rnd() * W) | 0, b = Math.min(W, a + ((rnd() * W * 0.4) | 0)), z = 0.5 + rnd() * 10; for (let x = a; x < b; x++) zb[x] = z }
    const bg = new Uint32Array(W * H)
    for (let i = 0; i < bg.length; i++) bg[i] = ((255 << 24) | (((rnd() * 256) | 0) << 16) | (((rnd() * 256) | 0) << 8) | ((rnd() * 256) | 0)) >>> 0
    const fs = {
      W, H, HH: (H >> 1) + ((rnd() * 8) | 0) - 4, fog: 8 + rnd() * 14, fogRgb: [(rnd() * 255) | 0, (rnd() * 255) | 0, (rnd() * 255) | 0], flicker: rnd() < 0.3 ? 0.4 + rnd() * 0.6 : 1,
      t: rnd() * 40, dt: 1 / 60, hf: FOV / 2, fov: FOV, player: { x: 0, y: 0, angle: 0 }, opts: {}, lights: { flashlight: rnd() < 0.3 },
      comfort: { reduceFlicker: rnd() < 0.3 }, levelKey: 'test', light, handled: {},
    }
    frames.push({ fs, ents, zb, bg })
  }
  return frames
}
const snapshot = (P) => P.recs.slice(0, P.count).map((r) => ({ ...r }))

describe('HS: the shipped blitter draws exactly what the reference per-pixel walk draws', () => {
  it('a randomised sweep of plans (every kind, magnified to far, mirror, warp, rim, dissolve, occlusion, lit and legacy)', { timeout: 180000 }, () => {
    frozen(() => {
      let recs = 0, warped = 0, mirrored = 0, rimmed = 0, dissolving = 0, screens = 0
      for (const F of sweepFrames(60, 0xb117)) {
        planSprites(F.fs, F.ents)                          // build what the frame needs
        const P = planSprites(F.fs, F.ents)
        const snap = snapshot(P)
        const a = F.bg.slice(), b = F.bg.slice()
        blitPlan(a, F.zb, P)
        for (const r of snap) referenceBlit(r, b, F.zb, F.fs.W, F.fs.H)
        let diff = 0
        for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff++
        expect(diff).toBe(0)
        for (const r of snap) {
          recs++
          if (r.lean !== 0 || r.swayA !== 0 || r.rippleA !== 0) warped++
          if (r.mirror) mirrored++
          if (r.rim && r.mip.rim) rimmed++
          if (r.dith > 0) dissolving++
          if (r.screen) screens++
        }
      }
      // the sweep really exercised every path
      expect(recs).toBeGreaterThan(400)
      for (const n of [warped, mirrored, rimmed, dissolving, screens]) expect(n).toBeGreaterThan(5)
    })
  })
  it('drawSprites is exactly planSprites + blitPlan', { timeout: 60000 }, () => {
    frozen(() => {
      for (const F of sweepFrames(8, 0x5eed)) {
        const ents = F.ents.filter((e) => e.kind !== 'player')        // (a player's motion record advances with every plan)
        planSprites(F.fs, ents)
        const a = F.bg.slice(), b = F.bg.slice()
        drawSprites(a, F.zb, F.fs, ents)
        blitPlan(b, F.zb, planSprites(F.fs, ents))
        expect(Buffer.compare(Buffer.from(a.buffer), Buffer.from(b.buffer))).toBe(0)
      }
    })
  })
})

describe('HS: one plan, two backends', () => {
  const unlimited = () => { const m = new Map(); return { rectFor(mip) { let r = m.get(mip); if (!r) { r = { x: 1 + m.size * 3, y: 2, w: mip.w, h: mip.h, rim: !!mip.rim }; m.set(mip, r) } return r } } }
  it('the GPU planner packs the CPU blitter\'s records one to one, number for number', { timeout: 120000 }, () => {
    frozen(() => {
      const pl = createSpritePlanner(unlimited())
      let n = 0
      for (const F of sweepFrames(24, 0x1dea)) {
        pl.plan(F.fs, F.ents)
        const out = pl.plan(F.fs, F.ents), P = pl.last
        expect(out.count).toBe(P.count)
        expect(out.plates).toBe(P.plates)
        const f = Math.fround, w1 = (x) => f(x - Math.floor(x))
        let runTotal = 0
        for (let r = 0; r < out.runCount; r++) runTotal += out.runs[r * 3 + 1]
        expect(runTotal).toBe(out.count)
        for (let i = 0; i < P.count; i++) {
          const r = P.recs[i], a = out.inst.subarray(i * IF, (i + 1) * IF)
          expect([a[0], a[1], a[2], a[3], a[4]]).toEqual([f(r.X0), f(r.X1), f(r.Yt), f(r.Yb), f(r.depth)])
          const rim = r.rim && !!r.mip.rim && !r.screen
          expect(a[5]).toBe((r.mirror ? F_MIRROR : 0) | (rim ? F_RIM : 0) | (r.shadow ? F_SHADOW : 0))
          expect([a[6], a[7]]).toEqual([r.screen ? 0 : f(r.dith), w1(r.dph)])
          expect([a[12], a[13], a[14], a[15], a[16]]).toEqual([f(r.lean), f(r.swayA), w1(r.swayP), f(r.rippleA), w1(r.rippleP)])
          expect([a[17], a[18], a[19]]).toEqual([f(r.cm0), f(r.cmK), f(r.cmX)])
          expect([a[20], a[21], a[22], a[23], a[24], a[25], a[26], a[27]]).toEqual([f(r.mr), f(r.mg), f(r.mb), f(r.A), f(r.fr), f(r.fg), f(r.fb), f(r.dy)])
          if (rim) expect([a[28], a[29], a[30], a[31], a[32]]).toEqual([f(r.rimS), f(r.rimB), f(r.rimR / 255), f(r.rimG / 255), f(r.rimBl / 255)])
          if (!r.shadow) expect([a[10], a[11]]).toEqual([r.mip.w, r.mip.h])
          n++
        }
      }
      expect(n).toBeGreaterThan(150)
    })
  })
  it('an atlas overflow re-packs the same plan (rebuild) instead of planning the frame again', () => {
    frozen(() => {
      let room = 1
      const atlas = { rectFor: (mip) => (room-- > 0 ? { x: 1, y: 1, w: mip.w, h: mip.h, rim: !!mip.rim } : null) }
      const pl = createSpritePlanner(atlas)
      const ents = [{ kind: 'prop', type: 'crate', x: 9, y: 0, rot: 5.6, key: 'a' }, { kind: 'prop', type: 'cabinet', x: 5, y: 0.3, rot: 5.4, key: 'b' }]
      const fs = { W: 200, H: 120, HH: 60, fog: 16, fogRgb: [100, 100, 100], flicker: 1, t: 1, dt: 1 / 60, hf: FOV / 2, player: { x: 0, y: 0, angle: 0 }, opts: {}, lights: {}, comfort: {}, levelKey: 'test' }
      pl.plan(fs, ents)
      room = 1
      const first = pl.plan(fs, ents)
      expect(first.atlasFull).toBe(true)
      const P = pl.last
      room = 100
      const again = pl.rebuild()
      expect(pl.last).toBe(P)
      expect(again.atlasFull).toBe(false)
      expect(again.count).toBe(P.count)
    })
  })
  it('the ground shadow the GPU evaluates analytically is the shadow texture the CPU blits', () => {
    const src = readFileSync(new URL('../src/renderer/gfx-gl-sprites.js', import.meta.url), 'utf8')
    expect(src).toMatch(/d >= 1\.0 \? 0\.0 : pow\(1\.0 - d, 1\.25\) \* 0\.9/)
    expect(shadowAlpha(0)).toBeCloseTo(0.9, 12); expect(shadowAlpha(1)).toBe(0); expect(shadowAlpha(0.5)).toBeCloseTo(Math.pow(0.5, 1.25) * 0.9, 12)
  })
})

describe('HS: texel-row opaque spans', () => {
  it('rowSpans brackets exactly the texels with alpha > 0, and marks empty rows', () => {
    const rnd = mulberry32(99)
    for (let n = 0; n < 40; n++) {
      const w = 1 + ((rnd() * 30) | 0), h = 1 + ((rnd() * 20) | 0)
      const px = new Uint32Array(w * h)
      for (let i = 0; i < px.length; i++) if (rnd() < 0.3) px[i] = (((1 + ((rnd() * 255) | 0)) << 24) | 0x102030) >>> 0
      const rs = rowSpans(px, w, h)
      for (let y = 0; y < h; y++) {
        let a = -1, b = -1
        for (let x = 0; x < w; x++) if (px[y * w + x] >>> 24) { if (a < 0) a = x; b = x + 1 }
        if (a < 0) expect(rs[y * 2 + 1] <= rs[y * 2]).toBe(true)
        else { expect(rs[y * 2]).toBe(a); expect(rs[y * 2 + 1]).toBe(b) }
      }
    }
  })
  it('every mip of a generated frame carries its spans', () => {
    for (const fr of [getFrame('prop', 'couch', 1), getFrame('creature', 'hound', 0, 1, 1, 2), getFrame('exit', 'portal'), packLayer(createPaint(8, 8), -1, 1, 0, 1)].map((x) => (x.layers ? x : { layers: [x] }))) {
      for (const l of fr.layers) for (const m of l.mips) {
        const rs = rowSpans(m.px, m.w, m.h)
        expect(m.rs).toBeInstanceOf(Int32Array)
        for (let y = 0; y < m.h; y++) if (rs[y * 2 + 1] > rs[y * 2]) expect([m.rs[y * 2], m.rs[y * 2 + 1]]).toEqual([rs[y * 2], rs[y * 2 + 1]])
      }
    }
  })
})

describe('HS: no per-frame garbage in the plan', () => {
  it('the records, the plan object and the nameplates are reused frame after frame', () => {
    frozen(() => {
      const [F] = sweepFrames(1, 7)
      const P1 = planSprites(F.fs, F.ents)
      const recs = P1.recs, first = recs[0], len = recs.length
      for (let i = 0; i < 20; i++) { const P = planSprites({ ...F.fs, t: F.fs.t + i / 60 }, F.ents); expect(P).toBe(P1); expect(P.recs).toBe(recs) }
      expect(recs.length).toBe(len)
      expect(recs[0]).toBe(first)
    })
  })
})

describe('HS: one level warm list, from the config, for both backends', () => {
  beforeAll(() => resetAtlas())
  it('prewarmSprites builds the head and queues the rest; the background finishes the level (sights too) without the built-in list', { timeout: 120000 }, () => {
    resetAtlas()
    const cfg = { levelIndex: 2, exit: {}, props: { types: ['crate'] }, entities: { enabled: true, stalkerVariants: ['lurker'], wandererVariants: [] } }
    expect(prewarmSprites(cfg, 0)).toBeGreaterThanOrEqual(1)             // the exit, at least
    const fs = { W: 120, H: 72, HH: 36, fog: 16, fogRgb: [90, 80, 60], flicker: 1, t: 1, dt: 1 / 60, hf: FOV / 2, player: { x: 0, y: 0, angle: 0 }, opts: {}, lights: {}, comfort: {}, levelKey: '2' }
    const ents = [{ kind: 'prop', type: 'crate', x: 30, y: 0, rot: 5.6, key: 'far' }]     // nothing in view: only the background builds
    frozen(() => { for (let i = 0; i < 200; i++) planSprites({ ...fs, t: 1 + i / 60 }, [...ents, { kind: 'prop', type: 'crate', x: 8, y: 0, rot: 5.6, key: 'c' }]) })
    const n = atlasStats().frames
    getFrame('creature', 'lurker', 0, 1, 0, 0); getFrame('creature', 'lurker', 0, 3, 0, 0); getFrame('prop', 'crate', 2, 0, 0, 0); getFrame('sight', 'mannequin')
    expect(atlasStats().frames).toBe(n)                                    // all queued from the config and built in the background
    const before = atlasStats().frames
    getFrame('prop', 'pipe', 0, 0, 0, 0)                                   // on the built-in level-2 list, not in this config
    expect(atlasStats().frames).toBe(before + 1)
  })
})
