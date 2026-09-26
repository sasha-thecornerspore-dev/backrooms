// gfx-gl-sprites-plan.js — the GPU sprite pass's CPU half: the plan -> instances step. WHAT is drawn is decided in exactly one place,
// gfx-sprites.js planSprites() (cull, MAXS cap and priority, far-to-near order, per-kind poses / warps / pulses, light, fog, rim, dissolve,
// motion records, nameplates, frame generation and the level warm queue) — the same records the CPU blitter draws. This file only packs each
// record into one INSTANCE of a reused Float32Array, which the GL pass (gfx-gl-sprites.js) draws as instanced quads, and maps each record's
// mip to its rectangle in the GPU atlas (gfx-gl-sprites-atlas.js).
//
// INSTANCE LAYOUT (IF = 36 floats, nine vec4 attributes):
//   a0  X0 X1 Yt Yb          screen rect in the internal W x H frame, rows from the top
//   a1  depth flags dith dph flags: 1 mirror, 2 rim on (the mip has a rim plane), 4 analytic ground shadow; dith = dissolve level 0..255+
//   a2  rx ry rw rh          the mip's interior rectangle in the atlas, in texels
//   a3  lean swayA swayP rippleA           (swayP / rippleP are wrapped to 0..1 cycles on the CPU so float32 keeps its precision)
//   a4  rippleP cm0 cmK cmX  the sideways lit-face gradient: cm = max(0.15, cm0 + cmK * (x - cmX))
//   a5  mr mg mb A           reflected-colour multipliers (already carry alpha, light, fog, tints) and the layer alpha
//   a6  fr fg fb ddy         fog colour term (0..1, already weighted by fog fraction and alpha) and the dissolve field's row offset
//   a7  rimS rimB rimR rimG  a8: rimBl 0 0 0
//
// A sprite is drawn whole or not at all: when the atlas cannot take one of its layers, the instances of that sprite are rolled back (never
// floating eyes with no body), `atlasFull` is reported, and the pass flushes / grows the atlas and calls rebuild() — which packs the SAME
// plan again (the frame's decisions, motion records and warm queue are not re-run).
//
// Import-safe in Node (no DOM, no GL): the atlas is behind the `atlas` object handed in.
import { planSprites, queueLevelSprites } from './gfx-sprites.js'

export const IF = 36                 // floats per instance
export const F_MIRROR = 1, F_RIM = 2, F_SHADOW = 4
export const MODE_OVER = 0, MODE_SCREEN = 1

const wrap1 = (x) => x - Math.floor(x)

// atlas: { rectFor(mip) -> {x,y,w,h,rim} | null }
// opts.config: a level config whose sprite list is queued for the background (the GL pass itself calls prewarmSprites(config), which does it)
export function createSpritePlanner(atlas, opts = {}) {
  if (opts.config) queueLevelSprites(opts.config)

  // ── instances ──
  let inst = new Float32Array(768 * IF)
  let nInst = 0
  let runs = new Int32Array(3 * 64)          // [first instance, count, mode] triples, in draw order
  let nRuns = 0
  const out = { inst, count: 0, runs, runCount: 0, plates: null, atlasFull: false }
  function growInst() { const n = new Float32Array(inst.length * 2); n.set(inst); inst = n; out.inst = n }
  function pushRun(mode) {
    if (nRuns > 0 && runs[(nRuns - 1) * 3 + 2] === mode) { runs[(nRuns - 1) * 3 + 1]++; return }
    if ((nRuns + 1) * 3 > runs.length) { const n = new Int32Array(runs.length * 2); n.set(runs); runs = n; out.runs = n }
    const o = nRuns * 3; runs[o] = nInst - 1; runs[o + 1] = 1; runs[o + 2] = mode; nRuns++
  }

  // one record -> one instance; false when the atlas has no room for its mip
  function emit(r) {
    let rx = 0, ry = 0, rw = 1, rh = 1, flags = r.mirror ? F_MIRROR : 0, rim = false
    if (r.shadow) {
      flags |= F_SHADOW                                   // the shader evaluates gfx-sprites.js shadowAlpha() (no atlas texels)
    } else {
      const q = atlas.rectFor(r.mip)
      if (q === null) return false
      rx = q.x; ry = q.y; rw = q.w; rh = q.h
      rim = r.rim && q.rim && !r.screen                   // the CPU blitter: rim only on an 'over' layer whose mip has a rim plane
    }
    if (rim) flags |= F_RIM
    if (nInst * IF + IF > inst.length) growInst()
    const o = nInst * IF, b = inst
    b[o] = r.X0; b[o + 1] = r.X1; b[o + 2] = r.Yt; b[o + 3] = r.Yb
    b[o + 4] = r.depth; b[o + 5] = flags; b[o + 6] = r.screen ? 0 : r.dith; b[o + 7] = wrap1(r.dph)
    b[o + 8] = rx; b[o + 9] = ry; b[o + 10] = rw; b[o + 11] = rh
    b[o + 12] = r.lean; b[o + 13] = r.swayA; b[o + 14] = wrap1(r.swayP); b[o + 15] = r.rippleA
    b[o + 16] = wrap1(r.rippleP); b[o + 17] = r.cm0; b[o + 18] = r.cmK; b[o + 19] = r.cmX
    b[o + 20] = r.mr; b[o + 21] = r.mg; b[o + 22] = r.mb; b[o + 23] = r.A
    b[o + 24] = r.fr; b[o + 25] = r.fg; b[o + 26] = r.fb; b[o + 27] = r.dy
    if (rim) { b[o + 28] = r.rimS; b[o + 29] = r.rimB; b[o + 30] = r.rimR / 255; b[o + 31] = r.rimG / 255; b[o + 32] = r.rimBl / 255 }
    else { b[o + 28] = 0; b[o + 29] = 0; b[o + 30] = 0; b[o + 31] = 0; b[o + 32] = 0 }
    b[o + 33] = 0; b[o + 34] = 0; b[o + 35] = 0
    nInst++
    pushRun(r.screen ? MODE_SCREEN : MODE_OVER)
    return true
  }

  // pack a plan (planSprites' result) into instances -> out
  let last = null
  function build(P) {
    nInst = 0; nRuns = 0
    let atlasFull = false
    const recs = P.recs, n = P.count
    let si = -1, mark = 0, markRuns = 0, markLast = 0, dropped = false
    for (let i = 0; i < n; i++) {
      const r = recs[i]
      if (r.si !== si) { si = r.si; mark = nInst; markRuns = nRuns; markLast = nRuns > 0 ? runs[(nRuns - 1) * 3 + 1] : 0; dropped = false }
      if (dropped) continue
      if (!emit(r)) {
        atlasFull = true; dropped = true
        nInst = mark; nRuns = markRuns; if (nRuns > 0) runs[(nRuns - 1) * 3 + 1] = markLast
      }
    }
    out.count = nInst; out.runCount = nRuns; out.inst = inst; out.runs = runs; out.atlasFull = atlasFull; out.plates = P.plates
    return out
  }

  // plan(fs, entities) -> out { inst, count, runs, runCount, plates, atlasFull }   (out is reused: read it before the next call)
  function plan(fs, entities) { last = planSprites(fs, entities); return build(last) }
  // the same plan packed again (after the atlas was flushed or grown); valid until the next planSprites / drawSprites call
  function rebuild() { return last === null ? out : build(last) }

  return { plan, rebuild, out, get last() { return last } }
}
