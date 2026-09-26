// gfx-gl-sprites-plan.js — the GPU sprite pass's CPU half: the entity -> drawable logic. It mirrors gfx-sprites.js drawSprites() decision for
// decision (cull, MAXS cap and priority, far-to-near order, per-kind poses / warps / pulses, light, fog, rim, dissolve, nameplates) but instead of
// blitting texels it writes one INSTANCE per layer into a reused Float32Array, which the GL pass draws as instanced quads.
//
// The art is NOT reimplemented: frames come from gfx-sprites.js getFrame(); this file only re-derives, per sprite, the numbers the CPU blitter
// derives (screen rect, warp, colour terms, rim terms). The shading of those numbers is in the shader (gfx-gl-sprites.js) and follows blitRect.
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
// Import-safe in Node (no DOM, no GL): the atlas is behind the `atlas` object handed in.
import { hash2 } from './gfx-util.js'
import {
  getFrame, motionProbe, pickMip, PROP_SPEC, FIG, PERSON, SIGHT_SPEC, MACHINE_SPEC, EXIT_SPEC, ITEM_COLORS, STATES, ANIM_FRAMES,
  FACING_FRONT, FACING_SIDE, FACING_BACK, stateIndex, creatureState, apparitionState, animFrame, entityPhase, wrapAngle, creatureFacing,
  headsRight, frameIndex, variantHash, unitJitter,
} from './gfx-sprites.js'

export const IF = 36                 // floats per instance
export const F_MIRROR = 1, F_RIM = 2, F_SHADOW = 4
export const MODE_OVER = 0, MODE_SCREEN = 1
const TAU = Math.PI * 2
const MAXS = 384                    // the CPU pass's cap on drawn sprites (same priority rule)
const GEN_BUDGET_MS = 9             // frame generation time per plan() before further misses wait for a later frame
const VARIANTS = 3
const PROP_SWAY = { plant: 0.010, weeds: 0.020 }

const nowMs = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : 0)
const sinc = (cycles) => Math.sin(cycles * TAU)
const wrap1 = (x) => x - Math.floor(x)
const hyp = (a, b) => Math.sqrt(a * a + b * b)
const posPhase = (e) => hash2(Math.round(e.x * 8), Math.round(e.y * 8), 5) / 4294967296

// the ground shadow: an analytic pseudo-layer (no atlas texels — the shader evaluates the same radial falloff as gfx-sprites.js shadowLayer())
const SHADOW_LAYER = { x0: -1, x1: 1, y0: -0.85, y1: 0.85, mips: null, mode: 0, emit: 0, fogK: 1, floor: true, rimK: 0, alpha: 1, shadow: true }

// what a level shows that the config does not name (gfx-sprites.js LEVEL_SPRITES: sights on levels 0-3)
const SIGHT_LEVELS = { '0': 1, '1': 1, '2': 1, '3': 1 }

// atlas: { rectFor(mip) -> {x,y,w,h,rim} | null }; opts.config: the level config, which seeds the background warm queue (see seedWarm)
export function createSpritePlanner(atlas, opts = {}) {
  const config = opts.config || null
  // ── per-plan module state (the planner is single threaded and non-reentrant, like the CPU pass) ──
  let CW = 0, CH = 0, CHH = 0
  let FOGR = 0, FOGG = 0, FOGB = 0, FLICK = 1, TNOW = 0, REDUCE = false
  let HARM_R = 1, HARM_G = 1, HARM_B = 1
  let LIGHT = null, LIGHT_ON = false
  let CAMX = 0, CAMY = 0, CAMA = 0, CA = 1, SAN = 0, FLASH = false
  let genMs = 0, atlasFull = false, misses = 0

  const S = {
    A: 1, L: 1, tr: 1, tg: 1, tb: 1, fogT: 0, lift: 0,
    lean: 0, swayA: 0, swayP: 0, rippleA: 0, rippleP: 0, dith: 0, dx: 0, dy: 0,
    cm0: 1, cmK: 0, hasRim: false, rimS: 0, rimB: 0, rimR: 0, rimG: 0, rimB2: 0, rimK: 0,
  }
  const LAYA = new Float32Array(12).fill(1)
  const resetLayA = () => LAYA.fill(1)

  // ── instances ──
  let inst = new Float32Array(768 * IF)
  let nInst = 0
  let runs = new Int32Array(3 * 64)          // [first instance, count, mode] triples, in draw order
  let nRuns = 0
  const out = { inst, count: 0, runs, runCount: 0, plates: null, atlasFull: false, frameWaits: 0 }
  function growInst() { const n = new Float32Array(inst.length * 2); n.set(inst); inst = n; out.inst = n }
  function pushRun(mode) {
    if (nRuns > 0 && runs[(nRuns - 1) * 3 + 2] === mode) { runs[(nRuns - 1) * 3 + 1]++; return }
    if ((nRuns + 1) * 3 > runs.length) { const n = new Int32Array(runs.length * 2); n.set(runs); runs = n; out.runs = n }
    const o = nRuns * 3; runs[o] = nInst - 1; runs[o + 1] = 1; runs[o + 2] = mode; nRuns++
  }

  // ── frames: a per-planner index over gfx-sprites.js's atlas (so a hit is allocation free), a generation budget, a small warm queue ──
  const mine = Object.create(null)
  const WARM = [], WARM_SEEN = new Set()
  let warmWait = 0
  const warmKey = (a) => a[0] + '|' + a[1] + '|' + a[2] + '|' + a[3] + '|' + a[4] + '|' + a[5]
  function warmPush(a) { const k = warmKey(a); if (!WARM_SEEN.has(k)) { WARM_SEEN.add(k); WARM.push(a) } }
  function warmFront(a) {
    const k = warmKey(a)
    if (WARM_SEEN.has(k)) { const i = WARM.findIndex((q) => warmKey(q) === k); if (i <= 0) return; WARM.splice(i, 1) } else WARM_SEEN.add(k)
    WARM.unshift(a)
  }
  const listFor = (kind, name) => { const bk = mine[kind] || (mine[kind] = Object.create(null)); return bk[name] || (bk[name] = []) }
  function queueSiblings(kind, name) {           // mirrors gfx-sprites.js queueSiblings: the other poses a thing will need soon
    if (kind === 'creature') {
      const low = !!(FIG[name] && FIG[name].low)
      for (let s = 0; s < STATES.length; s++) for (let a = 0; a < ANIM_FRAMES[s]; a++) {
        warmPush([kind, name, 0, s, a, FACING_FRONT])
        if (low) warmPush([kind, name, 0, s, a, FACING_SIDE])
      }
    } else if (kind === 'prop') {
      for (let v = 0; v < 3; v++) warmPush([kind, name, v, 0, 0, 0])
    } else if (kind === 'exit') {
      warmPush([kind, name, 0, 0, 1, 0])
    } else if (kind === 'sight' && name === 'tvwall') {
      for (let b = 1; b < 4; b++) warmPush([kind, name, 0, 0, b & 1, b >> 1])
    } else if (kind === 'person') {
      warmPush([kind, name, 0, 1, 0, 0]); warmPush([kind, name, 0, 1, 1, 0])
    }
  }
  function frameFor(kind, name, v, s, a, f) {
    const list = listFor(kind, name), idx = frameIndex(v, s, a, f)
    let fr = list[idx]
    if (fr !== undefined) return fr
    if (genMs > GEN_BUDGET_MS) { warmFront([kind, name, v, s, a, f]); out.frameWaits++; return null }
    const t0 = nowMs()
    fr = getFrame(kind, name, v, s, a, f)
    genMs += nowMs() - t0
    list[idx] = fr
    if (!list.warm) { list.warm = true; queueSiblings(kind, name) }
    return fr
  }
  // The level's whole cast, queued once (the CPU path's queueLevel, but from the level CONFIG: the same job list and order as prewarmSprites, whose
  // 40 ms creation-time build only covers the head of it) so a creature / exit / prop built in the background before it is first sighted, one
  // frame per plan() at a few ms each (warmStep), never inside the render call that first needs it.
  let seeded = false
  function seedWarm(levelKey) {
    seeded = true
    const c = config || {}
    if (c.exit || c.exitAt) warmPush(['exit', 'portal', 0, 0, 0, 0])
    if (c.scraps && c.scraps.denom !== 0) { warmPush(['note', 'unread', 0, 0, 0, 0]); warmPush(['note', 'read', 0, 0, 0, 0]) }
    if (c.machines && c.machines.denom !== 0) { warmPush(['machine', 'lit', 0, 0, 0, 0]); warmPush(['machine', 'spent', 0, 0, 0, 0]) }
    const ent = c.entities, cast = []
    if (ent && ent.enabled !== false) for (const v of [...(ent.stalkerVariants || []), ...(ent.wandererVariants || [])]) if (FIG[v] && !cast.includes(v)) cast.push(v)
    const types = (c.props && c.props.types) || [], items = (c.items && c.items.types) || []
    for (const v of cast) warmPush(['creature', v, 0, 0, 0, FACING_FRONT])
    for (const v of cast) warmPush(['creature', v, 0, 1, 0, FACING_FRONT])
    for (const t of types) warmPush(['prop', PROP_SPEC[t] ? t : 'box', 0, 0, 0, 0])
    for (const t of items) warmPush(['item', ITEM_COLORS[t] ? t : 'radio', 0, 0, 0, 0])
    for (const t of types) for (let v = 1; v < 3; v++) warmPush(['prop', PROP_SPEC[t] ? t : 'box', v, 0, 0, 0])
    for (const v of cast) for (const st of [2, 3]) warmPush(['creature', v, 0, st, 0, FACING_FRONT])
    if (SIGHT_LEVELS[levelKey]) for (const t of Object.keys(SIGHT_SPEC)) warmPush(['sight', t, 0, 0, 0, 0])
  }
  // one background frame per plan (the CPU's warmStep); a job whose frame the module already holds (the creation-time prewarm built it) costs
  // next to nothing, so up to FREE_HITS of those are skipped in the same call instead of each eating a whole frame's turn
  const FREE_HITS = 64
  function warmStep(slow) {
    for (let hits = 0; hits < FREE_HITS; hits++) {
      let a = WARM.shift()
      while (a !== undefined) { WARM_SEEN.delete(warmKey(a)); if (listFor(a[0], a[1])[frameIndex(a[2], a[3], a[4], a[5])] === undefined) break; a = WARM.shift() }
      if (a === undefined) return
      const t0 = nowMs()
      const list = listFor(a[0], a[1])
      list[frameIndex(a[2], a[3], a[4], a[5])] = getFrame(a[0], a[1], a[2], a[3], a[4], a[5])
      const dt = nowMs() - t0
      genMs += dt
      if (dt < 0.3) continue                                    // already built: free
      warmWait = dt > 12 ? 14 : dt > 5 ? 5 : slow ? 2 : 0
      return
    }
  }

  // ── light (a copy of gfx-sprites.js sampleLight / setRim) ──
  function normRim(n) {
    const hi = Math.max(n.r || 0, n.g || 0, n.b || 0)
    if (!(hi > 0)) { S.rimR = 255; S.rimG = 238; S.rimB2 = 196; return }
    const sc = hi > 2 ? 1 : 255
    S.rimR = (n.r || 0) * sc; S.rimG = (n.g || 0) * sc; S.rimB2 = (n.b || 0) * sc
  }
  function sampleLight(x, y, fwd, side) {
    let L = 1, tr = 1, tg = 1, tb = 1
    if (LIGHT_ON) {
      const l = typeof LIGHT.at === 'function' ? LIGHT.at(x, y) : 1
      if (l > 0) L = l < 0.12 ? 0.12 : l > 1.6 ? 1.6 : l
      const t = typeof LIGHT.tint === 'function' ? LIGHT.tint(x, y) : null
      if (t) { tr = t[0]; tg = t[1]; tb = t[2] }
    }
    if (FLASH) {
      const off = Math.abs(side) / fwd
      const cone = off < 0.55 ? 1 - off / 0.55 : 0
      const range = fwd < 10 ? 1 - fwd / 10 : 0
      L += 0.4 * cone * range
    }
    S.L = L; S.tr = tr; S.tg = tg; S.tb = tb
  }
  function setRim(e, fwd, rimOn = true) {
    S.hasRim = false
    if (!LIGHT_ON || typeof LIGHT.nearest !== 'function') return
    const n = LIGHT.nearest(e.x, e.y)
    if (!n) return
    const dx = n.x - e.x, dy = n.y - e.y
    const d = Math.sqrt(dx * dx + dy * dy) || 1e-3
    const side = (-dx * SAN + dy * CA) / d
    const back = (dx * CA + dy * SAN) / d
    const k = 1.1 / (1 + d * d * 0.09)
    normRim(n)
    S.rimS = side * k * 1.5 / 127
    S.rimB = (back > 0 ? back : 0) * k * 0.8 / 127
    S.rimK = k
    S.hasRim = rimOn && k > 0.05
    S.cm0 = 1 + 0.06 * k
    S.cmK = side * k * 0.3 / Math.max(6, 0.12 * (CH / fwd))
  }
  function initSprite(e, fwd, side, fogT, alpha) {
    S.A = alpha; S.fogT = fogT; S.lift = 0
    S.lean = 0; S.swayA = 0; S.swayP = 0; S.rippleA = 0; S.rippleP = 0
    S.dith = 0; S.dx = 0; S.dy = 0
    S.hasRim = false; S.cm0 = 1; S.cmK = 0
    sampleLight(e.x, e.y, fwd, side)
  }

  // ── one layer -> one instance (gfx-sprites.js drawLayer + setLayerColour + the blitRect prologue) ──
  function emitLayer(lay, cx, floorY, unit, depth, mirror, sc, lift, aMul) {
    if (aMul <= 0.003) return
    const emit = lay.emit
    const f = S.fogT * lay.fogK
    const A = S.A * lay.alpha * aMul
    if (A < 0.003) return
    const lit = (S.L + (1 - S.L) * emit) * (FLICK + (1 - FLICK) * emit) * (1 - f)
    const screen = lay.mode === 1
    let mr, mg, mb, fr = 0, fg = 0, fb = 0
    if (screen) {
      mr = mg = mb = A * lit
    } else {
      const ke = 1 - emit
      mr = A * lit * (1 + (S.tr - 1) * ke) * (1 + (HARM_R - 1) * ke)
      mg = A * lit * (1 + (S.tg - 1) * ke) * (1 + (HARM_G - 1) * ke)
      mb = A * lit * (1 + (S.tb - 1) * ke) * (1 + (HARM_B - 1) * ke)
      fr = FOGR * f * A / 255; fg = FOGG * f * A / 255; fb = FOGB * f * A / 255
    }
    const flat0 = emit >= 0.99
    const cm0 = flat0 ? 1 : S.cm0, cmK = flat0 ? 0 : S.cmK
    let lean, swayA, swayP, rippleA, rippleP
    let X0, X1, Yt, Yb
    if (lay.floor) {
      lean = 0; swayA = 0; swayP = 0; rippleA = 0; rippleP = 0
      const cxo = ((lay.x0 + lay.x1) * 0.5) * sc * (mirror ? -1 : 1), hw = (lay.x1 - lay.x0) * 0.5 * sc
      X0 = cx + (cxo - hw) * unit; X1 = cx + (cxo + hw) * unit
      const zN = Math.max(0.25, depth + lay.y0 * sc), zF = depth + lay.y1 * sc
      Yb = CHH + CH / (2 * zN); Yt = CHH + CH / (2 * zF)
    } else {
      lean = S.lean; swayA = S.swayA; swayP = S.swayP; rippleA = S.rippleA; rippleP = S.rippleP
      let a0 = lay.x0 * sc, a1 = lay.x1 * sc
      if (mirror) { const t = -a0; a0 = -a1; a1 = t }
      X0 = cx + a0 * unit; X1 = cx + a1 * unit
      Yb = floorY - (lay.y0 * sc + lift) * unit; Yt = floorY - (lay.y1 * sc + lift) * unit
    }
    const sw = X1 - X0, sh = Yb - Yt
    if (sw < 0.6 || sh < 0.6) return
    const warp = lean !== 0 || swayA !== 0 || rippleA !== 0
    const pad = warp ? Math.ceil(Math.abs(lean) + Math.abs(swayA) + Math.abs(rippleA)) + 1 : 0
    if (Math.ceil(X1 + pad) <= 0 || Math.floor(X0 - pad) >= CW || Math.ceil(Yb) <= 0 || Math.floor(Yt) >= CH) return

    let rx = 0, ry = 0, rw = 1, rh = 1, flags = mirror ? F_MIRROR : 0
    let rim = false
    if (lay.shadow) {
      flags |= F_SHADOW
    } else {
      const mip = lay.mips[pickMip(lay.mips, sh)]
      const r = atlas.rectFor(mip)
      if (r === null) { atlasFull = true; misses++; return }
      rx = r.x; ry = r.y; rw = r.w; rh = r.h
      rim = S.hasRim && lay.rimK > 0 && r.rim && !screen
    }
    if (rim) flags |= F_RIM

    if (nInst * IF + IF > inst.length) growInst()
    const o = nInst * IF, b = inst
    b[o] = X0; b[o + 1] = X1; b[o + 2] = Yt; b[o + 3] = Yb
    b[o + 4] = depth; b[o + 5] = flags; b[o + 6] = screen ? 0 : S.dith; b[o + 7] = wrap1(TNOW * 0.35)
    b[o + 8] = rx; b[o + 9] = ry; b[o + 10] = rw; b[o + 11] = rh
    b[o + 12] = lean; b[o + 13] = swayA; b[o + 14] = wrap1(swayP); b[o + 15] = rippleA
    b[o + 16] = wrap1(rippleP); b[o + 17] = cm0; b[o + 18] = cmK; b[o + 19] = cx
    b[o + 20] = mr; b[o + 21] = mg; b[o + 22] = mb; b[o + 23] = A
    b[o + 24] = fr; b[o + 25] = fg; b[o + 26] = fb; b[o + 27] = S.dy
    if (rim) { b[o + 28] = S.rimS * lay.rimK; b[o + 29] = S.rimB * lay.rimK; b[o + 30] = S.rimR / 255; b[o + 31] = S.rimG / 255; b[o + 32] = S.rimB2 / 255 }
    else { b[o + 28] = 0; b[o + 29] = 0; b[o + 30] = 0; b[o + 31] = 0; b[o + 32] = 0 }
    b[o + 33] = 0; b[o + 34] = 0; b[o + 35] = 0
    nInst++
    pushRun(screen ? MODE_SCREEN : MODE_OVER)
  }
  function drawFrame(fr, cx, floorY, unit, depth, mirror, sc, lift) {
    const layers = fr.layers
    for (let i = 0; i < layers.length; i++) emitLayer(layers[i], cx, floorY, unit, depth, mirror, sc, lift, LAYA[i])
  }
  function drawShadow(cx, depth, unit, radius, opacity) {
    if (opacity < 0.02) return
    emitLayer(SHADOW_LAYER, cx, 0, unit, depth, false, radius, 0, opacity)
  }

  // ── the per-kind drawers (verbatim decisions of gfx-sprites.js) ──
  function drawProp(e, sx, fwd, fogT, side) {
    const spec = PROP_SPEC[e.type]
    const name = spec ? e.type : 'box'
    const sp = spec || PROP_SPEC.box
    const rot = e.rot || 0
    const unit = CH / fwd, floorY = CHH + unit / 2
    initSprite(e, fwd, side, fogT, 1)
    const vh = variantHash(rot)
    const tj = 1 + 0.07 * unitJitter(rot, 11), hj = 1 + 0.04 * unitJitter(rot, 12)
    S.tr *= tj * hj; S.tg *= tj; S.tb *= tj / hj
    const sc = 1 + 0.06 * unitJitter(rot, 13)
    if (sp.lean) S.lean = unitJitter(rot, 17) * 0.028 * unit
    const sw = PROP_SWAY[name]
    if (sw) { S.swayA = sw * unit; S.swayP = TNOW * (REDUCE ? 0.25 : 0.5) + (vh & 255) / 255 }
    setRim(e, fwd, false)
    const fr = frameFor('prop', name, vh % VARIANTS, 0, 0, 0)
    if (fr === null) return
    resetLayA()
    if (!sp.decal) drawShadow(sx, fwd, unit, sp.w * 0.56 * sc, 0.5)
    drawFrame(fr, sx, floorY, unit, fwd, (vh & 0x100) !== 0, sc, 0)
  }

  function creatureMotion(sIx, spec, phase, unit) {
    const k = REDUCE ? 0.6 : 1
    const hz = REDUCE ? 0.5 : 1
    let lift = 0, sc = 1
    if (sIx === 0) {
      S.swayA = 0.012 * unit * k; S.swayP = TNOW * 0.30 * hz + phase
      S.rippleA = 0.006 * unit * k; S.rippleP = TNOW * 0.7 * hz + phase * 3
      sc = 1 + 0.008 * sinc(TNOW * 0.27 + phase)
    } else if (sIx === 1) {
      S.swayA = 0.022 * unit * k; S.swayP = TNOW * 1.1 * hz + phase
      S.rippleA = 0.012 * unit * k; S.rippleP = TNOW * 2.2 * hz + phase * 3
      lift = (spec.low ? 0.016 : 0.011) * Math.abs(sinc(TNOW * 1.1 * hz + phase))
      sc = 1.025
    } else if (sIx === 2) {
      S.swayA = 0.026 * unit * k; S.swayP = TNOW * 1.6 * hz + phase
      S.rippleA = 0.016 * unit * k; S.rippleP = TNOW * 3.2 * hz + phase * 3
      lift = 0.010 * Math.abs(sinc(TNOW * 1.6 * hz + phase))
    } else {
      S.swayA = 0.028 * unit * k; S.swayP = TNOW * 3.3 * hz + phase
      S.rippleA = 0.014 * unit * k; S.rippleP = TNOW * 5 * hz + phase * 3
      S.lean = -0.05 * unit * (0.75 + 0.25 * sinc(TNOW * 1.5 + phase))
      S.dith = 70 + 30 * sinc(TNOW * 0.7 + phase)
      S.dx = 0; S.dy = (TNOW * 9) | 0
    }
    S.lift = lift
    return sc
  }

  function drawCreature(e, sx, fwd, fogT, side) {
    const app = e.kind === undefined && e.vx !== undefined
    const name = FIG[e.variant] ? e.variant : 'shade'
    const spec = FIG[name]
    const sIx = stateIndex(app ? apparitionState(e) : creatureState(e))
    const phase = app ? ((hash2(Math.round(e.vx * 100), Math.round(e.vy * 100), 4) / 4294967296)) : entityPhase(e)
    const anim = animFrame(sIx, TNOW, phase)
    let facing = FACING_FRONT, mirror = false, hideFace = false
    if (app) {
      mirror = false
    } else {
      facing = creatureFacing(e, CAMX, CAMY, spec.low)
      if (facing === FACING_BACK) { hideFace = true; facing = FACING_FRONT }
      else if (facing === FACING_SIDE) mirror = headsRight(e, CAMA)
    }
    const unit = CH / fwd, floorY = CHH + unit / 2
    initSprite(e, fwd, side, fogT, spec.thin ? (0.36 + 0.03 * sinc(TNOW * 0.21 + phase)) : 1)
    const sc = creatureMotion(sIx, spec, phase, unit) * 1
    if (spec.thin) { S.swayA = 0.012 * unit; S.swayP = TNOW * 0.4 + phase; S.rippleA = 0.02 * unit; S.rippleP = TNOW * 1.3 + phase * 3; S.lift = 0.004 * sinc(TNOW * 0.35 + phase) + 0.01 }
    setRim(e, fwd)
    if (sIx === 3) { S.hasRim = true; S.rimR = 232; S.rimG = 240; S.rimB2 = 255; S.rimS = 0; S.rimB = 0.5 / 127 }
    const fr = frameFor('creature', name, 0, sIx, anim, facing)
    if (fr === null) return
    resetLayA()
    if (hideFace) for (let i = 1; i < fr.layers.length; i++) LAYA[i] = 0
    else if (sIx === 1) { for (let i = 1; i < fr.layers.length; i++) LAYA[i] = 1.15 }
    else if (sIx === 3) { for (let i = 1; i < fr.layers.length; i++) LAYA[i] = 0.55 }
    else { for (let i = 1; i < fr.layers.length; i++) LAYA[i] = 0.85 }
    if (spec.electric && !hideFace) {
      const bank = (((TNOW * (REDUCE ? 1.5 : 4) + phase * 3) | 0) % 3)
      for (let i = 2; i < fr.layers.length; i++) LAYA[i] = i - 2 === bank ? (sIx === 1 ? 1.2 : 1) : 0
    }
    drawShadow(sx, fwd, unit, spec.w * 0.52, spec.thin ? 0.22 : 0.5)
    drawFrame(fr, sx, floorY, unit, fwd, mirror, sc, S.lift || 0)
    S.lift = 0
  }

  function drawItem(e, sx, fwd, fogT, side) {
    const type = ITEM_COLORS[e.itemType] ? e.itemType : 'radio'
    const unit = CH / fwd, floorY = CHH + unit / 2
    initSprite(e, fwd, side, fogT, 1)
    const ph = posPhase(e)
    const fr = frameFor('item', type, 0, 0, 0, 0)
    if (fr === null) return
    resetLayA()
    LAYA[0] = 0.78 + 0.22 * sinc(TNOW * 0.45 + ph)
    const lift = 0.014 + 0.010 * sinc(TNOW * 0.5 + ph)
    S.swayA = 0.006 * unit; S.swayP = TNOW * 0.4 + ph
    drawShadow(sx, fwd, unit, 0.1, 0.42 - lift * 6)
    drawFrame(fr, sx, floorY, unit, fwd, false, 1, lift)
  }

  function drawNote(e, sx, fwd, fogT, side) {
    const unit = CH / fwd, floorY = CHH + unit / 2
    initSprite(e, fwd, side, fogT, 1)
    const ph = posPhase(e)
    const fr = frameFor('note', e.read ? 'read' : 'unread', 0, 0, 0, 0)
    if (fr === null) return
    resetLayA()
    if (!e.read) LAYA[0] = 0.72 + 0.28 * sinc(TNOW * 0.32 + ph)
    const lift = 0.36 + 0.014 * sinc(TNOW * 0.4 + ph)
    S.swayA = 0.010 * unit; S.swayP = TNOW * 0.33 + ph; S.lean = 0.008 * unit * sinc(TNOW * 0.27 + ph)
    drawShadow(sx, fwd, unit, 0.06, 0.20)
    drawFrame(fr, sx, floorY, unit, fwd, false, 1, lift)
  }

  function drawMachine(e, sx, fwd, fogT, side) {
    const unit = CH / fwd, floorY = CHH + unit / 2
    initSprite(e, fwd, side, fogT, 1)
    setRim(e, fwd, false)
    const fr = frameFor('machine', e.vended ? 'spent' : 'lit', 0, 0, 0, 0)
    if (fr === null) return
    resetLayA()
    if (!e.vended) LAYA[1] = 0.9 + 0.1 * sinc(TNOW * 0.9 + posPhase(e)) * (REDUCE ? 0.3 : 1)
    drawShadow(sx, fwd, unit, MACHINE_SPEC.w * 0.6, 0.5)
    drawFrame(fr, sx, floorY, unit, fwd, false, 1, 0)
  }

  function drawSight(e, sx, fwd, fogT, side) {
    const t = SIGHT_SPEC[e.sightType] ? e.sightType : 'mannequin'
    const unit = CH / fwd, floorY = CHH + unit / 2
    initSprite(e, fwd, side, fogT, 1)
    let anim = 0, facing = 0
    if (t === 'tvwall') { const b = ((TNOW * (REDUCE ? 1.5 : 5)) | 0) % 4; anim = b & 1; facing = b >> 1 }
    setRim(e, fwd, false)
    const fr = frameFor('sight', t, 0, 0, anim, facing)
    if (fr === null) return
    resetLayA()
    const ph = posPhase(e)
    if (t === 'payphone') { S.swayA = 0.004 * unit; S.swayP = TNOW * 0.3 + ph }
    drawShadow(sx, fwd, unit, SIGHT_SPEC[t].w * 0.5, 0.5)
    drawFrame(fr, sx, floorY, unit, fwd, false, 1, 0)
  }

  function drawExit(e, sx, fwd, fogT, side) {
    const unit = CH / fwd, floorY = CHH + unit / 2
    initSprite(e, fwd, side, fogT, 1)
    const ph = posPhase(e)
    const pulse = 0.55 + 0.45 * sinc(TNOW * 0.35 + ph)
    const fr = frameFor('exit', 'portal', 0, 0, ((TNOW * (REDUCE ? 0.8 : 1.4)) | 0) & 1, 0)
    if (fr === null) return
    resetLayA()
    LAYA[0] = 0.55 + 0.45 * pulse
    LAYA[1] = 0.62 + 0.38 * pulse
    LAYA[3] = 0.7 + 0.3 * pulse
    S.swayA = 0.004 * unit; S.swayP = TNOW * 0.5 + ph
    drawShadow(sx, fwd, unit, EXIT_SPEC.w * 0.7, 0.45)
    drawFrame(fr, sx, floorY, unit, fwd, false, 1, 0)
  }

  const POOL = [], PLATES = [], PL = []
  let moving = null, movingI = 0
  function drawPerson(e, sx, fwd, fogT, side, isNpc) {
    const spec = isNpc ? PERSON.npc : PERSON.player
    const unit = CH / fwd, floorY = CHH + unit / 2
    initSprite(e, fwd, side, fogT, isNpc ? 0.94 : 0.97)
    let facing = FACING_FRONT
    if (!isNpc && e.angle !== undefined && Math.abs(wrapAngle(e.angle - Math.atan2(CAMY - e.y, CAMX - e.x))) > (2 * Math.PI) / 3) facing = FACING_BACK
    const mv = !isNpc && moving !== null && moving[movingI++] === true
    const ph = posPhase(e)
    const anim = mv ? ((TNOW * 2.4 + ph) * 2 | 0) & 1 : 0
    if (mv) { S.swayA = 0.014 * unit; S.swayP = TNOW * 1.2 + ph } else { S.swayA = (isNpc ? 0.006 : 0.008) * unit; S.swayP = TNOW * 0.3 + ph }
    setRim(e, fwd)
    const fr = frameFor('person', isNpc ? 'npc' : 'player', 0, mv ? 1 : 0, anim, FACING_FRONT)
    if (fr === null) return
    resetLayA()
    if (facing === FACING_BACK) for (let i = 1; i < fr.layers.length; i++) LAYA[i] = 0.35
    const lift = mv ? 0.008 * Math.abs(sinc(TNOW * 1.2 + ph)) : 0
    drawShadow(sx, fwd, unit, spec.w * 0.55, 0.45)
    drawFrame(fr, sx, floorY, unit, fwd, false, 1, lift)
    if (e.name) {
      let p = POOL[PLATES.length]
      if (!p) { p = POOL[PLATES.length] = { sx: 0, y: 0, name: '', alpha: 1, speech: undefined, hp: undefined } }
      p.sx = sx; p.y = floorY - (spec.h + lift + 0.03) * unit; p.name = e.name; p.alpha = (1 - fogT) * 0.96; p.speech = e.chatText; p.hp = e.hp
      PLATES.push(p)
    }
  }

  // ── the sort / cull (a copy of drawSprites') ──
  const SE = new Array(MAXS), SD = new Float32Array(MAXS), SF = new Float32Array(MAXS), SL = new Float32Array(MAXS), SK = new Float32Array(MAXS)
  let ERR_LOGGED = 0

  // plan(fs, entities) -> out { inst, count, runs, runCount, plates, atlasFull }   (out is reused: read it before the next call)
  function plan(fs, entities) {
    PLATES.length = 0
    nInst = 0; nRuns = 0; genMs = 0; atlasFull = false; moving = null; movingI = 0
    out.plates = PLATES; out.count = 0; out.runCount = 0; out.atlasFull = false
    if (!entities || entities.length === 0) return out
    if (!seeded) seedWarm(fs.levelKey)
    const { W, H, HH, fog, player } = fs
    CW = W; CH = H; CHH = HH
    CAMX = player.x; CAMY = player.y; CAMA = player.angle
    CA = Math.cos(CAMA); SAN = Math.sin(CAMA)
    FLICK = (fs.flicker == null || (fs.light && fs.light.enabled === true) || (fs.handled && fs.handled.flicker)) ? 1 : fs.flicker
    TNOW = fs.t || 0
    REDUCE = !!(fs.comfort && fs.comfort.reduceFlicker)
    const fr = fs.fogRgb || [200, 200, 200]
    FOGR = fr[0] * FLICK; FOGG = fr[1] * FLICK; FOGB = fr[2] * FLICK
    const mean = (fr[0] + fr[1] + fr[2]) / 3 || 1
    HARM_R = 1 + 0.22 * (fr[0] / mean - 1); HARM_G = 1 + 0.22 * (fr[1] / mean - 1); HARM_B = 1 + 0.22 * (fr[2] / mean - 1)
    LIGHT = (fs.opts && fs.opts.spriteLightOverride) || fs.light || null
    LIGHT_ON = !!(LIGHT && LIGHT.enabled === true)
    FLASH = !!(fs.lights && fs.lights.flashlight)
    const HF = fs.hf
    const tanLim = Math.tan(Math.min(1.45, HF + 0.1))

    let n = 0
    for (let i = 0; i < entities.length; i++) {
      const e = entities[i]
      const ex = e.x - CAMX, ey = e.y - CAMY
      const fwd = ex * CA + ey * SAN
      if (!(fwd >= 0.35)) continue
      const reach = e.kind === 'exit' ? fog * 1.35 : fog
      if (fwd > reach) continue
      const lat = -ex * SAN + ey * CA
      const lim = fwd * tanLim + 0.8
      if (lat > lim || lat < -lim) continue
      const d2 = ex * ex + ey * ey, key = e.kind === 'prop' ? d2 : d2 * 0.05
      if (n >= MAXS) {
        let w = 0
        for (let q = 1; q < n; q++) if (SK[q] > SK[w]) w = q
        if (!(key < SK[w])) continue
        for (let q = w; q < n - 1; q++) { SE[q] = SE[q + 1]; SD[q] = SD[q + 1]; SF[q] = SF[q + 1]; SL[q] = SL[q + 1]; SK[q] = SK[q + 1] }
        n--
      }
      SE[n] = e; SD[n] = d2; SF[n] = fwd; SL[n] = lat; SK[n] = key
      let j = n
      while (j > 0 && SD[j - 1] < SD[j]) {
        const td = SD[j]; SD[j] = SD[j - 1]; SD[j - 1] = td
        const tf = SF[j]; SF[j] = SF[j - 1]; SF[j - 1] = tf
        const tl = SL[j]; SL[j] = SL[j - 1]; SL[j - 1] = tl
        const te = SE[j]; SE[j] = SE[j - 1]; SE[j - 1] = te
        const tk = SK[j]; SK[j] = SK[j - 1]; SK[j - 1] = tk
        j--
      }
      n++
    }

    // the remote players' motion verdicts, asked once per frame in draw order (the CPU asks per drawn player, in the same order)
    PL.length = 0
    for (let i = 0; i < n; i++) if (SE[i].kind === 'player') PL.push(SE[i])
    if (PL.length > 0) { moving = motionProbe(PL, TNOW); movingI = 0 }

    const halfW = W / 2
    for (let i = 0; i < n; i++) {
      const e = SE[i], fwd = SF[i], lat = SL[i]
      const fogT = fwd >= fog ? 1 : fwd / fog
      const sx = halfW + (Math.atan2(lat, fwd) / HF) * halfW
      // a sprite is drawn whole or not at all: if the atlas fills while its layers are emitted, they are rolled back (never floating eyes with no body)
      const mark = nInst, markRuns = nRuns, markLast = nRuns > 0 ? runs[(nRuns - 1) * 3 + 1] : 0, missBefore = misses
      try {
        const k = e.kind
        if (k === 'item') drawItem(e, sx, fwd, fogT, lat)
        else if (k === 'prop') drawProp(e, sx, fwd, fogT, lat)
        else if (k === 'exit') drawExit(e, sx, fwd, fogT, lat)
        else if (k === 'note') drawNote(e, sx, fwd, fogT, lat)
        else if (k === 'machine') drawMachine(e, sx, fwd, fogT, lat)
        else if (k === 'sight') drawSight(e, sx, fwd, fogT, lat)
        else if (k === 'player') drawPerson(e, sx, fwd, fogT, lat, false)
        else if (k === 'npc') drawPerson(e, sx, fwd, fogT, lat, true)
        else if (k === undefined && (e.variant !== undefined || e.type !== undefined)) drawCreature(e, sx, fwd, fogT, lat)
      } catch (err) {
        if (ERR_LOGGED++ < 3 && typeof console !== 'undefined') console.error('gfx-gl-sprites: draw failed for ' + (e && (e.kind || e.variant)) + ': ' + (err && err.stack || err))
      }
      if (misses !== missBefore && nInst > mark) { nInst = mark; nRuns = markRuns; if (nRuns > 0) runs[(nRuns - 1) * 3 + 1] = markLast }
      SE[i] = undefined
    }
    if (warmWait > 0) warmWait--
    else if (WARM.length > 0 && genMs < 4) { try { warmStep(fs.dt > 0.024) } catch (err) { WARM.length = 0; WARM_SEEN.clear() } }
    out.count = nInst; out.runCount = nRuns; out.inst = inst; out.runs = runs; out.atlasFull = atlasFull
    return out
  }

  return { plan, out }
}
