// compose-perception.js and the four trailing aiCtx fields (sightMul, hidden, loseTrackMul, noiseMul) through the REAL hunt.js /
// variants.js / entities.js, with hand-set values on a 15-key ctx. W2's per-origin numbers are W2's tests (origins-rules /
// origins-blocks); two wiring cases below go through rulesFor to prove perceptionFor copies the block's object.
import { describe, it, expect } from 'vitest'
import { perceptionFor, AI_CTX_KEYS, AI_CTX_DEFAULTS } from '../src/renderer/compose-perception.js'
import { createNoiseField, floodNoise, stepAI, createThreat, sees } from '../src/renderer/hunt.js'
import { createEntitySystem } from '../src/renderer/entities.js'
import { specFor, stepVariant } from '../src/renderer/variants.js'
import { createChunkCache, createGridReader, CHUNK_SIZE } from '../src/renderer/world.js'
import { creatureRadius } from '../src/renderer/collide.js'
import { HF } from '../src/renderer/gfx-frame.js'
import { rulesFor } from '../src/renderer/origin-rules.js'

const DT = 1 / 60
const N = CHUNK_SIZE
const config = { chunkEvictRadius: 3, entities: { enabled: false } }
const open = () => true
const mkGrid = (floor) => ({ floor, setPlayerChunk() {} })
const wallOf = (floor) => (wx, wy) => !floor(Math.floor(wx), Math.floor(wy))
// the 11-key ctx every existing fixture builds, plus the four trailing fields (defaults unless overridden)
function mkCtx(player, over = {}) {
  return { flashlight: false, sprinting: false, dark: false, fog: 16, radioOn: false, lures: [], t: 0, hf: HF, playerAngle: player.angle ?? 0, player, damage: 16, ...AI_CTX_DEFAULTS, ...over }
}
function ent(x, y, variant = 'shade', over = {}) {
  return { id: over.id ?? 1, x, y, type: 'stalker', variant, state: 'idle', dir: 0, dirTimer: 99, stagger: 0, wardHits: 0, chunkCx: Math.floor(x / N), chunkCy: Math.floor(y / N), ...over }
}
function mkEnv(floor, over = {}) {
  return { dt: DT, now: 0, pcx: 0, pcy: 0, player: { x: 5.5, y: 45.5, angle: 0 }, ctx: null, floor, isWall: (ix, iy) => !floor(ix, iy), obstacles: null, fields: null, losBudget: 6, damage: 16, helpers: null, threat: createThreat(), ...over }
}
function drive(sys, player, ctx, seconds, each = null) {
  const n = Math.round(seconds / DT)
  for (let i = 0; i < n; i++) {
    const th = sys.update(DT, player, Math.floor(player.x / N), Math.floor(player.y / N), ctx)
    if (each) each(i, th)
  }
}

// ── (a) hidden ──────────────────────────────────────────────────────────────────────────────────────────────────────
describe('hidden: the things cannot see you, the line is still read, contact still lands', () => {
  it('a shade at 5 u with a clear line never sees a hidden player over 600 frames; its los is true from the first tick', () => {
    const player = { x: 15.5, y: 5.5, angle: Math.PI }
    const ctx = mkCtx(player, { hidden: true })
    const sys = createEntitySystem(config, wallOf(open), { grid: mkGrid(open), obstacles: null })
    const e = ent(10.5, 5.5)
    sys.getEntities().push(e)
    let seen = 0, losFrames = 0
    drive(sys, player, ctx, 600 * DT, (i) => { if (e.seen) seen++; if (e.los) losFrames++; if (i === 0) expect(e.los).toBe(true) })
    expect(seen).toBe(0)
    expect(losFrames).toBeGreaterThan(0)
    expect(e.ai).toBe('roam')
    // the same frame with hidden false: seen at once
    const ctx2 = mkCtx(player)
    const sys2 = createEntitySystem(config, wallOf(open), { grid: mkGrid(open), obstacles: null })
    const e2 = ent(10.5, 5.5)
    sys2.getEntities().push(e2)
    drive(sys2, player, ctx2, DT)
    expect(e2.seen).toBe(true)
    expect(e2.ai).toBe('hunt')
  })

  it('sees() is false for a hidden player whatever the range', () => {
    const player = { x: 3.5, y: 0.5, angle: Math.PI }
    expect(sees(ent(0.5, 0.5), player, mkCtx(player), specFor('shade'), open)).toBe(true)
    expect(sees(ent(0.5, 0.5), player, mkCtx(player, { hidden: true }), specFor('shade'), open)).toBe(false)
    expect(sees(ent(2.5, 0.5), player, mkCtx(player, { hidden: true }), specFor('shade'), open)).toBe(false)   // within 2 u too
    expect(sees(ent(0.5, 0.5), player, mkCtx(player, { hidden: 1 }), specFor('shade'), open)).toBe(true)      // only `true` hides
  })

  function huntThenHide(loseTrackMul) {
    const player = { x: 15.5, y: 5.5, angle: Math.PI }
    const ctx = mkCtx(player, { loseTrackMul })
    const sys = createEntitySystem(config, wallOf(open), { grid: mkGrid(open), obstacles: null })
    const e = ent(5.5, 5.5)
    sys.getEntities().push(e)
    drive(sys, player, ctx, DT)
    expect(e.ai).toBe('hunt')
    ctx.hidden = true
    return { sys, player, ctx, e }
  }

  // seconds from the first perception tick that loses you (e.seen false) to the search
  function memory(loseTrackMul) {
    const { sys, player, ctx, e } = huntThenHide(loseTrackMul)
    let lostAt = -1, searchAt = -1
    drive(sys, player, ctx, 8, (i) => {
      if (lostAt < 0 && !e.seen) lostAt = i
      if (searchAt < 0 && e.ai === 'search') searchAt = i
      if (searchAt < 0) expect(e.ai).toBe('hunt')
    })
    expect(lostAt).toBeGreaterThanOrEqual(0)
    return (searchAt - lostAt) * DT
  }

  it('a hunting shade keeps coming for spec.loseTrack (3.5 s) after it loses you, then searches', () => {
    expect(Math.abs(memory(1) - 3.5)).toBeLessThanOrEqual(2 * DT)
  })

  it('loseTrackMul 1.5/3.5 cuts the memory to 1.5 s', () => {
    expect(Math.abs(memory(1.5 / 3.5) - 1.5)).toBeLessThanOrEqual(2 * DT)
  })

  it('a hound keeps its 6 s at loseTrackMul 1 (out of its lunge range, walking away from you)', () => {
    const player = { x: 5.5, y: 5.5, angle: 0 }
    const ctx = mkCtx(player, { hidden: true })
    const sys = createEntitySystem(config, wallOf(open), { grid: mkGrid(open), obstacles: null })
    const e = ent(20.5, 5.5, 'hound', { ai: 'hunt', lastSeenX: 60.5, lastSeenY: 5.5 })
    sys.getEntities().push(e)
    drive(sys, player, ctx, 5.8)
    expect(e.ai).toBe('hunt')
    drive(sys, player, ctx, 0.4)
    expect(e.ai).toBe('search')
  })

  it('a hidden player still takes contact damage from a hunting shade that reaches them (contact is distance-based)', () => {
    const player = { x: 10.5, y: 5.5, angle: Math.PI }
    const ctx = mkCtx(player, { hidden: true })
    const sys = createEntitySystem(config, wallOf(open), { grid: mkGrid(open), obstacles: null })
    const e = ent(8.9, 5.5, 'shade', { ai: 'hunt', lastSeenX: 10.5, lastSeenY: 5.5 })
    sys.getEntities().push(e)
    let dmg = 0
    drive(sys, player, ctx, 1.0, (i, th) => { if (th.dmg > dmg) dmg = th.dmg })
    expect(dmg).toBe(16)
    expect(e.seen).toBe(false)
  })
})

// ── (b) sightMul ────────────────────────────────────────────────────────────────────────────────────────────────────
describe('sightMul multiplies the effective sight range, after the dark halving and the beam', () => {
  const e = ent(0, 0.5)
  const at = (x) => ({ x, y: 0.5, angle: Math.PI })
  it('1.3 on a 12-sight shade on a lit floor: sees at 15.6, not at 15.7', () => {
    expect(sees(e, at(15.6), mkCtx(at(15.6), { sightMul: 1.3 }), specFor('shade'), open)).toBe(true)
    expect(sees(e, at(15.7), mkCtx(at(15.7), { sightMul: 1.3 }), specFor('shade'), open)).toBe(false)
    expect(sees(e, at(12.5), mkCtx(at(12.5)), specFor('shade'), open)).toBe(false)                        // 1: 12
  })
  it('0.45: sees at 5.4, not at 5.5', () => {
    expect(sees(e, at(5.4), mkCtx(at(5.4), { sightMul: 0.45 }), specFor('shade'), open)).toBe(true)
    expect(sees(e, at(5.5), mkCtx(at(5.5), { sightMul: 0.45 }), specFor('shade'), open)).toBe(false)
  })
  it('in the dark with the flashlight (12 x 0.5 + 3 = 9) x 1.3 = 11.7', () => {
    const c = (x) => mkCtx(at(x), { dark: true, flashlight: true, sightMul: 1.3 })
    expect(sees(e, at(11.7), c(11.7), specFor('shade'), open)).toBe(true)
    expect(sees(e, at(11.8), c(11.8), specFor('shade'), open)).toBe(false)
  })
  it('the hound ignores the dark but not sightMul (10 x 1.3 = 13)', () => {
    const h = ent(0, 0.5, 'hound')
    expect(sees(h, at(13), mkCtx(at(13), { dark: true, sightMul: 1.3 }), specFor('hound'), open)).toBe(true)
    expect(sees(h, at(13.1), mkCtx(at(13.1), { dark: true, sightMul: 1.3 }), specFor('hound'), open)).toBe(false)
    expect(sees(h, at(10.5), mkCtx(at(10.5), { dark: true }), specFor('hound'), open)).toBe(false)
  })
  it('perceive picks it up too: a shade at 14 u enters hunt at sightMul 1.3 and not at 1', () => {
    for (const [mul, want] of [[1.3, 'hunt'], [1, 'roam']]) {
      const player = { x: 15.5, y: 5.5, angle: Math.PI }
      const sys = createEntitySystem(config, wallOf(open), { grid: mkGrid(open), obstacles: null })
      const s = ent(1.5, 5.5)
      sys.getEntities().push(s)
      drive(sys, player, mkCtx(player, { sightMul: mul }), DT)
      expect(s.ai, `sightMul ${mul}`).toBe(want)
    }
  })
})

// ── (c) noiseMul ────────────────────────────────────────────────────────────────────────────────────────────────────
describe('noiseMul scales what a creature hears of YOUR noises only', () => {
  // a straight hall along y = 5: path length is the x distance
  const hall = (ix, iy) => iy === 5 && ix >= 0 && ix < 48
  function heard(L, path, noiseMul, who) {
    const f = createNoiseField()
    const noise = { x: 5.5, y: 5.5, L, t: 0 }
    if (who !== undefined) noise.who = who
    floodNoise(f, noise, hall); f.id = 1
    const e = ent(5.5 + path, 5.5)
    const env = mkEnv(hall, { fields: [f] })
    stepAI(e, DT, mkCtx(env.player, { noiseMul }), specFor('shade'), env, env.threat)
    return e.ai === 'alert'
  }
  it('floodNoise copies who (default player)', () => {
    const f = createNoiseField()
    expect(f.who).toBe('player')
    floodNoise(f, { x: 5.5, y: 5.5, L: 3, t: 0, who: 'lure' }, hall)
    expect(f.who).toBe('lure')
    floodNoise(f, { x: 5.5, y: 5.5, L: 3, t: 0 }, hall)
    expect(f.who).toBe('player')
  })
  it('a walk (3) at noiseMul 0.5 is heard at path 2 and not at path 3; at 1 it carries to path 8 and not 9', () => {
    expect(heard(3, 2, 0.5)).toBe(true)
    expect(heard(3, 3, 0.5)).toBe(false)
    expect(heard(3, 8, 1)).toBe(true)
    expect(heard(3, 9, 1)).toBe(false)
    expect(heard(3, 8)).toBe(true)                                       // absent field: the default 1
  })
  it("a lure (8, who 'lure') and a friend's ward (10, who 'friend') are heard at the same path whatever noiseMul is", () => {
    // lure 8: 8 / (1 + p/4) >= 1 -> p <= 28, past the window; at path 14 it is 2.67 either way
    for (const nm of [0.5, 1]) {
      expect(heard(8, 14, nm, 'lure')).toBe(true)
      expect(heard(10, 14, nm, 'friend')).toBe(true)
    }
    // a 3 tagged 'lure' at path 3 is heard at 0.5 where the player's own 3 is not
    expect(heard(3, 3, 0.5, 'lure')).toBe(true)
    expect(heard(3, 3, 0.5, 'player')).toBe(false)
  })
  it("the ward's 12 at noiseMul 0.5 still carries past path 12", () => {
    expect(heard(12, 13, 0.5)).toBe(true)
  })
  it("entities.noise(x, y, L) with three arguments floods who 'player'; a fourth argument tags it", () => {
    const player = { x: 5.5, y: 45.5, angle: 0 }
    const run = (args, noiseMul) => {
      const sys = createEntitySystem(config, wallOf(hall), { grid: mkGrid(hall), obstacles: null })
      const e = ent(8.5, 5.5)
      sys.getEntities().push(e)
      const ctx = mkCtx(player, { noiseMul })
      sys.update(0, player, 0, 0, ctx)
      sys.noise(...args)
      sys.update(DT, player, 0, 0, ctx)
      return e.ai
    }
    expect(run([5.5, 5.5, 3], 0.5)).toBe('roam')
    expect(run([5.5, 5.5, 3], 1)).toBe('alert')
    expect(run([5.5, 5.5, 3, 'player'], 0.5)).toBe('roam')
    expect(run([5.5, 5.5, 3, 'lure'], 0.5)).toBe('alert')
    expect(run([5.5, 5.5, 3, 'friend'], 0.5)).toBe('alert')
  })
})

// ── (d) watcher, (e) crawler (variants.js through stubbed helpers, the way variants.test.js drives them) ──────────────
function mkHelpers() {
  const H = {
    dt: DT, losOk: true, events: [],
    moveToward(e, x, y, speed) { const dx = x - e.x, dy = y - e.y, d = Math.hypot(dx, dy); e.dir = Math.atan2(dy, dx); if (d > 1e-9) { const s = Math.min(d, speed * H.dt) / d; e.x += dx * s; e.y += dy * s } return false },
    moveAway(e, x, y, speed) { const dx = e.x - x, dy = e.y - y, d = Math.hypot(dx, dy); e.dir = Math.atan2(dy, dx); if (d > 1e-9) { e.x += dx / d * speed * H.dt; e.y += dy / d * speed * H.dt } return false },
    los: () => H.losOk,
    dist: (e, x, y) => Math.hypot(e.x - x, e.y - y),
    hashT: () => 0.5,
    event: (kind, e) => { H.events.push(kind) },
  }
  return H
}
function mkThreat() { return { gaze: false, gazeRate: 0, dmg: 0, dmgKind: null, arcPending: false } }
function resetThreat(t) { t.gaze = false; t.gazeRate = 0; t.dmg = 0; t.dmgKind = null; t.arcPending = false }
function mkEnt(variant, x, y, ai) {
  return { id: 1, x, y, type: 'stalker', variant, ai, state: 'idle', dir: 0, dirTimer: 2, stagger: 0, wardHits: 0, pending: 0, chunkCx: 0, chunkCy: 0 }
}
function run(e, ctx, H, th, seconds, each) {
  const n = Math.round(seconds / DT)
  for (let i = 0; i < n; i++) { resetThreat(th); stepVariant(e, DT, ctx, H, th); if (each) each(i) }
}

describe('the watcher reads hidden, sightMul and loseTrackMul', () => {
  const player = { x: 0, y: 0, angle: 0 }
  it('hidden: never enters shadow from roam over 10 s with a clear line at 8 u', () => {
    const e = mkEnt('watcher', 8, 0, 'roam'), H = mkHelpers(), th = mkThreat()
    let shadow = false
    run(e, mkCtx(player, { hidden: true }), H, th, 10, () => { if (e.ai === 'shadow') shadow = true })
    expect(shadow).toBe(false)
    run(e, mkCtx(player), H, th, DT)
    expect(e.ai).toBe('shadow')
  })
  it('sightMul 1.3 shadows at 20 u (16 x 1.3 = 20.8); 1 does not', () => {
    const a = mkEnt('watcher', 20, 0, 'roam')
    run(a, mkCtx(player, { sightMul: 1.3 }), mkHelpers(), mkThreat(), DT)
    expect(a.ai).toBe('shadow')
    const b = mkEnt('watcher', 20, 0, 'roam')
    run(b, mkCtx(player), mkHelpers(), mkThreat(), DT)
    expect(b.ai).toBe('roam')
  })
  it('loseTrackMul 1.5/3.5 drops it back to roam 1.5 s after the line is cut (3.5 s at 1)', () => {
    for (const [mul, s] of [[1.5 / 3.5, 1.5], [1, 3.5]]) {
      const e = mkEnt('watcher', 7.5, 0, 'roam'), H = mkHelpers(), th = mkThreat()
      const ctx = mkCtx(player, { loseTrackMul: mul })
      run(e, ctx, H, th, DT)
      expect(e.ai).toBe('shadow')
      H.losOk = false
      run(e, ctx, H, th, s - 0.1)
      expect(e.ai, `mul ${mul}`).toBe('shadow')
      run(e, ctx, H, th, 0.2)
      expect(e.ai, `mul ${mul}`).toBe('roam')
    }
  })
  it('watching a hidden watcher back still raises the gaze (its los is raw)', () => {
    const e = mkEnt('watcher', 8, 0, 'roam'), H = mkHelpers(), th = mkThreat()
    run(e, mkCtx(player, { hidden: true }), H, th, DT)
    expect(th.gaze).toBe(true)
    expect(th.gazeRate).toBe(3)
    expect(e.ai).toBe('roam')
    // and with sightMul 0.45 (sight 7.2) a watcher at 10 u is still watched back
    const f = mkEnt('watcher', 10, 0, 'roam'), th2 = mkThreat()
    run(f, mkCtx(player, { sightMul: 0.45 }), mkHelpers(), th2, DT)
    expect(th2.gaze).toBe(true)
    expect(f.ai).toBe('roam')
  })
})

describe('the crawler does not lunge at a hidden player', () => {
  const player = { x: 0, y: 0, angle: 0 }
  it('hidden and still at 2 u in the dark: no lunge over 5 s; hidden false: a lunge within 0.2 s', () => {
    const e = mkEnt('crawler', 2, 0, 'still'), H = mkHelpers(), th = mkThreat()
    let lunged = false
    run(e, mkCtx(player, { dark: true, hidden: true }), H, th, 5, () => { if (e.ai === 'lunge') lunged = true })
    expect(lunged).toBe(false)
    let at = -1
    run(e, mkCtx(player, { dark: true }), H, th, 0.2, (i) => { if (at < 0 && e.ai === 'lunge') at = i })
    expect(at).toBeGreaterThanOrEqual(0)
  })
})

// ── (f) perceptionFor ───────────────────────────────────────────────────────────────────────────────────────────────
describe('perceptionFor: one reused copy of the block’s perception', () => {
  const base = { depth: 2, stillFor: 0, noiseFor: 0, flashlight: true, radioOn: false, litNear: false }
  it("copies tenant's deep numbers into its own object", () => {
    const rules = rulesFor('tenant', false)
    const p = perceptionFor({ rules, ...base })
    expect(p).toEqual({ sightMul: 1.3, hidden: false, loseTrackMul: 1, noiseMul: 1.5 })
    expect(p).not.toBe(rules.perception({ ...base }))
    expect(perceptionFor({ rules, ...base, depth: 0 })).toBe(p)          // the same object every call
    expect(p).toEqual({ sightMul: 1, hidden: false, loseTrackMul: 1, noiseMul: 1 })
  })
  it('thin wins over the column: hidden after 0.6 s still and silent whatever the light', () => {
    const p = perceptionFor({ rules: rulesFor('tenant', true), depth: 2, stillFor: 1, noiseFor: 1, flashlight: true, radioOn: false, litNear: false })
    expect(p.hidden).toBe(true)
    expect(p.loseTrackMul).toBe(1.5 / 3.5)
    expect(p.noiseMul).toBe(0.5)
    expect(p.sightMul).toBe(1)
  })
  it('hidden is always a boolean (only a block’s `true` hides)', () => {
    const fake = (hidden) => ({ perception: () => ({ sightMul: 2, hidden, loseTrackMul: 3, noiseMul: 4 }) })
    for (const h of [1, 'yes', {}, undefined, null, 0]) {
      const p = perceptionFor({ rules: fake(h), ...base })
      expect(typeof p.hidden).toBe('boolean')
      expect(p.hidden).toBe(false)
    }
    expect(perceptionFor({ rules: fake(true), ...base }).hidden).toBe(true)
    expect(perceptionFor({ rules: fake(true), ...base })).toEqual({ sightMul: 2, hidden: true, loseTrackMul: 3, noiseMul: 4 })
  })
  it('passes the ctx through to the block', () => {
    const seen = []
    const rules = { perception: (c) => { seen.push({ ...c }); return { sightMul: 1, hidden: false, loseTrackMul: 1, noiseMul: 1 } } }
    const ctx = { rules, depth: 3, stillFor: 2.5, noiseFor: Infinity, flashlight: false, radioOn: true, litNear: true }
    perceptionFor(ctx)
    expect(seen[0]).toEqual(ctx)
  })
})

// ── (g) the key list ────────────────────────────────────────────────────────────────────────────────────────────────
describe('AI_CTX_KEYS / AI_CTX_DEFAULTS', () => {
  it('15 keys in the pinned order; the defaults are frozen { 1, false, 1, 1 }', () => {
    expect(AI_CTX_KEYS).toEqual(['flashlight', 'sprinting', 'dark', 'fog', 'radioOn', 'lures', 't', 'hf', 'playerAngle', 'player', 'damage', 'sightMul', 'hidden', 'loseTrackMul', 'noiseMul'])
    expect(AI_CTX_KEYS.length).toBe(15)
    expect(AI_CTX_DEFAULTS).toEqual({ sightMul: 1, hidden: false, loseTrackMul: 1, noiseMul: 1 })
    expect(Object.isFrozen(AI_CTX_DEFAULTS)).toBe(true)
    expect(Object.keys(mkCtx({ x: 0, y: 0 }))).toEqual([...AI_CTX_KEYS])
  })
})

// ── (h) perf guard ──────────────────────────────────────────────────────────────────────────────────────────────────
// the 20-creature 600-update fixture of test/entities-hunt.test.js, with the four fields present (and non-default, so every
// new read runs): no allocation was added, the budget holds
describe('perf: 20 creatures x 600 updates with a 15-key ctx', () => {
  it('runs under 150 ms (the better of two runs)', () => {
    const cfg = { chunkEvictRadius: 3, maze: { corridor: 1 }, entities: { enabled: false, damage: 16 } }
    const cache = createChunkCache(cfg, 0)
    const isWall = (wx, wy, pcx, pcy) => cache.isWall(wx, wy, pcx, pcy)
    const grid = createGridReader(cache, isWall)
    const obstacles = { blocked: (x, y) => !grid.floor(Math.floor(x), Math.floor(y)), radiusFor: creatureRadius }
    const sys = createEntitySystem(cfg, isWall, { grid, obstacles, now: () => 0 })
    const g = cache.getChunk(0, 0, 0, 0)
    const list = sys.getEntities()
    const variants = ['shade', 'smiler', 'hound', 'lurker', 'watcher', 'crawler', 'tesla']
    let placed = 0
    for (let iy = 3; iy < 19 && placed < 20; iy += 2) for (let ix = 3; ix < 19 && placed < 20; ix += 3) {
      if (g[iy * N + ix] !== 0) continue
      list.push(ent(ix + 0.5, iy + 0.5, variants[placed % 7], { id: placed + 1, dirTimer: 1 + placed * 0.3 }))
      placed++
    }
    expect(placed).toBe(20)
    const player = { x: 11.5, y: 11.5, angle: 0 }
    const ctx = mkCtx(player, { dark: true, flashlight: true, sightMul: 1.3, loseTrackMul: 0.8, noiseMul: 0.7 })
    expect(Object.keys(ctx).length).toBe(15)
    const th = sys.getThreat()
    let same = true
    function go() {
      const t0 = performance.now()
      for (let i = 0; i < 600; i++) {
        player.angle += 0.01
        ctx.hidden = (i % 120) < 30
        if (i % 27 === 0) sys.noise(player.x, player.y, 7)
        if (i % 41 === 0) sys.noise(player.x + 2, player.y, 8, 'lure')
        if (i % 200 === 199) sys.ward(player)
        if (sys.update(DT, player, 0, 0, ctx) !== th) same = false
      }
      return performance.now() - t0
    }
    const ms1 = go(), ms2 = go()
    expect(same).toBe(true)
    expect(Math.min(ms1, ms2), `600 updates took ${ms1.toFixed(1)} / ${ms2.toFixed(1)} ms`).toBeLessThan(150)
  })
})
