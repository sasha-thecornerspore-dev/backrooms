// hunt.js — perception that travels the maze (a noise flood over the floor, line of sight on a budget), the shared
// roam / alert / investigate / hunt / search machine, the one stagger spec, the obstacle layer (moveToward / moveAway)
// and creature separation. Pure modules, exercised directly and through createEntitySystem on the hunt path.
import { describe, it, expect } from 'vitest'
import {
  DISPEL_S, TURNING_S, deriveState, hostile, solidCreature, lineOfSight, createNoiseField, floodNoise, loudnessAt, sees,
  stepAI, createThreat, moveToward, moveAway, separate,
} from '../src/renderer/hunt.js'
import { createEntitySystem } from '../src/renderer/entities.js'
import { specFor, VARIANT_PHASES } from '../src/renderer/variants.js'
import { creatureRadius } from '../src/renderer/collide.js'
import { STATES } from '../src/renderer/gfx-sprites.js'
import { generateChunk, CHUNK_SIZE } from '../src/renderer/world.js'
import { HF } from '../src/renderer/gfx-frame.js'

const DT = 1 / 60
const N = CHUNK_SIZE
const config = { chunkEvictRadius: 3, entities: { enabled: false } }   // no spawns: only what a test places

// ── fixtures ────────────────────────────────────────────────────────────────────────────────────────────────────────
// a single generated chunk as a grid: everything outside it is wall
function chunkFloor(cx, cy) {
  const g = generateChunk(cx, cy, 0, { corridor: 1 })
  return (ix, iy) => ix >= 0 && iy >= 0 && ix < N && iy < N && g[iy * N + ix] === 0
}
// the test's own unbounded BFS: path length in open cells from (sx, sy)
function pathLengths(floor, sx, sy, W = 64) {
  const d = new Map(); const q = [[sx, sy]]; d.set(`${sx},${sy}`, 0)
  while (q.length) {
    const [x, y] = q.shift(); const p = d.get(`${x},${y}`)
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy, k = `${nx},${ny}`
      if (Math.abs(nx) > W || Math.abs(ny) > W || !floor(nx, ny) || d.has(k)) continue
      d.set(k, p + 1); q.push([nx, ny])
    }
  }
  return (x, y) => d.get(`${x},${y}`) ?? -1
}
const open = () => true
const mkGrid = (floor) => ({ floor, setPlayerChunk() {} })
const wallOf = (floor) => (wx, wy) => !floor(Math.floor(wx), Math.floor(wy))
function mkCtx(player, over = {}) {
  return { flashlight: false, sprinting: false, dark: false, fog: 16, radioOn: false, lures: [], t: 0, hf: HF, playerAngle: player.angle ?? 0, player, damage: 16, ...over }
}
// an entity the way makeEntity would shape it, minus the lazily-initialised hunt fields
function ent(x, y, variant = 'shade', over = {}) {
  return { id: over.id ?? 1, x, y, type: 'stalker', variant, state: 'idle', dir: 0, dirTimer: 99, stagger: 0, wardHits: 0, chunkCx: Math.floor(x / N), chunkCy: Math.floor(y / N), ...over }
}
function mkEnv(floor, obstacles = null, over = {}) {
  return { dt: DT, now: 0, pcx: 0, pcy: 0, player: { x: 1e6, y: 1e6, angle: 0 }, ctx: null, floor, isWall: (ix, iy) => !floor(ix, iy), obstacles, fields: null, losBudget: 6, damage: 16, helpers: null, threat: createThreat(), ...over }
}
const noObst = { blocked: () => false, radiusFor: creatureRadius }
const obst = (fn) => ({ blocked: fn, radiusFor: creatureRadius })
// drive a system on the hunt path; collects event kinds across frames
function drive(sys, player, ctx, seconds, dt = DT, each = null) {
  const kinds = [], out = []
  const n = Math.round(seconds / dt)
  for (let i = 0; i < n; i++) {
    sys.update(dt, player, Math.floor(player.x / N), Math.floor(player.y / N), ctx)
    const m = sys.drainEvents(out)
    for (let k = 0; k < m; k++) kinds.push(out[k].kind)
    if (each) each(i, (i + 1) * dt)
  }
  return kinds
}

// ── constants ───────────────────────────────────────────────────────────────────────────────────────────────────────
describe('constants', () => {
  it('DISPEL_S is 240 and TURNING_S is 0.8; lineOfSight is re-exported', () => {
    expect(DISPEL_S).toBe(240)
    expect(TURNING_S).toBe(0.8)
    expect(typeof lineOfSight).toBe('function')
    expect(lineOfSight(0.5, 0.5, 5.5, 0.5, open)).toBe(true)
  })
})

// ── hearing on a real chunk ─────────────────────────────────────────────────────────────────────────────────────────
describe('hearing: one bounded flood over the real floor of generateChunk(0,0,0,{corridor:1})', () => {
  const floor = chunkFloor(0, 0)
  const path = pathLengths(floor, 5, 11)        // a noise in the mid-row hall

  it('a sprint (L=7) in the mid-row hall is heard 10 path cells away round a corner', () => {
    expect(path(3, 5)).toBe(10)
    expect(lineOfSight(5.5, 11.5, 3.5, 5.5, floor)).toBe(false)        // round a corner: no straight line
    const f = createNoiseField()
    const popped = floodNoise(f, { x: 5.5, y: 11.5, L: 7, t: 0 }, floor)
    expect(popped).toBeLessThanOrEqual(160)
    expect(loudnessAt(f, 3, 5)).toBeCloseTo(7 / (1 + 10 / 4), 6)
    expect(loudnessAt(f, 3, 5) * specFor('shade').hearK).toBeGreaterThanOrEqual(1)
  })

  it('a creature 3 cells away in a line but 30+ cells away on foot does not hear a sprint (never through walls)', () => {
    // chunk (0,0) has no such pair: its braid loops every corridor back. (4,-1) does, at its west wall.
    const fl = chunkFloor(4, -1)
    const p2 = pathLengths(fl, 1, 12)
    expect(Math.hypot(1 - 1, 15 - 12)).toBe(3)
    expect(p2(1, 15)).toBeGreaterThanOrEqual(30)
    const f = createNoiseField()
    floodNoise(f, { x: 1.5, y: 12.5, L: 7, t: 0 }, fl)
    expect(loudnessAt(f, 1, 15) * specFor('shade').hearK).toBeLessThan(1)
  })

  it('a walk (L=3) carries to path 6 and not to path 12', () => {
    expect(path(3, 7)).toBe(6)
    expect(path(7, 1)).toBe(12)
    const f = createNoiseField()
    floodNoise(f, { x: 5.5, y: 11.5, L: 3, t: 0 }, floor)
    expect(loudnessAt(f, 3, 7)).toBeGreaterThanOrEqual(1)
    expect(loudnessAt(f, 7, 1)).toBeLessThan(1)
    expect(loudnessAt(f, 3, 5)).toBeCloseTo(3 / (1 + 10 / 4), 6)         // path 10: reached, too faint for a walk
    expect(loudnessAt(f, 3, 5)).toBeLessThan(1)
  })

  it('a noise at t is still heard by a perception tick 0.3 s later, and not 0.5 s later', () => {
    const player = { x: 60.5, y: 60.5, angle: 0 }                      // far: never seen
    const ctx = mkCtx(player)
    let sys = createEntitySystem(config, wallOf(floor), { grid: mkGrid(floor), obstacles: null })
    sys.getEntities().push(ent(3.5, 7.5))
    sys.update(0, player, 2, 2, ctx)
    sys.noise(5.5, 11.5, 3)                                            // walk, 6 path cells away
    sys.update(0.3, player, 2, 2, ctx)
    expect(sys.getEntities()[0].ai).toBe('alert')

    sys = createEntitySystem(config, wallOf(floor), { grid: mkGrid(floor), obstacles: null })
    sys.getEntities().push(ent(3.5, 7.5))
    sys.update(0, player, 2, 2, ctx)
    sys.noise(5.5, 11.5, 3)
    sys.update(0.5, player, 2, 2, ctx)
    expect(sys.getEntities()[0].ai).toBe('roam')
  })

  it('floodNoise pops <= 160 cells, touches nothing outside the 31x31 window and allocates nothing across calls', () => {
    const asked = []
    const spy = (ix, iy) => { asked.push([ix, iy]); return floor(ix, iy) }
    const f = createNoiseField()
    const ids = [f.lo, f.gen, f.q, f.pl]
    const popped = floodNoise(f, { x: 5.5, y: 11.5, L: 12, t: 0 }, spy)
    expect(popped).toBeLessThanOrEqual(160)
    for (const [ix, iy] of asked) { expect(Math.abs(ix - 5)).toBeLessThanOrEqual(15); expect(Math.abs(iy - 11)).toBeLessThanOrEqual(15) }
    floodNoise(f, { x: 11.5, y: 3.5, L: 7, t: 1 }, spy)
    floodNoise(f, { x: 16.5, y: 11.5, L: 3, t: 2 }, spy)
    expect([f.lo, f.gen, f.q, f.pl]).toEqual(ids)
    expect(f.lo).toBe(ids[0]); expect(f.gen).toBe(ids[1]); expect(f.q).toBe(ids[2]); expect(f.pl).toBe(ids[3])
    expect(f.lo).toBeInstanceOf(Float32Array); expect(f.lo.length).toBe(961)
    expect(f.gen).toBeInstanceOf(Uint16Array); expect(f.q).toBeInstanceOf(Int16Array)
    // the old flood is gone: a cell loud under the first noise is silent now unless the third reached it
    expect(loudnessAt(f, 3, 5)).toBe(0)
  })

  it('stepAI reads every live field: an earlier noise is heard though a later one sits in another slot (SD-noise-overwrite)', () => {
    const near = createNoiseField(), far = createNoiseField(), old = createNoiseField()
    floodNoise(near, { x: 5.5, y: 7.5, L: 8, t: 0 }, open); near.id = 1
    floodNoise(far, { x: 30.5, y: 5.5, L: 3, t: 0 }, open); far.id = 2
    floodNoise(old, { x: 5.5, y: 6.5, L: 12, t: -1 }, open); old.id = 3           // loud but no longer live
    const e = ent(5.5, 5.5)
    const env = mkEnv(open, null, { fields: [near, far, old] })
    stepAI(e, DT, mkCtx(env.player), specFor('shade'), env, env.threat)
    expect(e.ai).toBe('alert'); expect([e.tx, e.ty]).toEqual([5.5, 7.5]); expect(e.heardId).toBe(1)
    e.ai = 'roam'
    stepAI(e, DT, mkCtx(env.player), specFor('shade'), env, env.threat)
    expect(e.ai).toBe('roam')                                                        // heard once, not again
  })
})

// ── sight ───────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('sees()', () => {
  const player = { x: 8.5, y: 0.5, angle: Math.PI }
  const e = ent(0.5, 0.5)
  it('requires line of sight', () => {
    expect(sees(e, player, mkCtx(player), specFor('shade'), open)).toBe(true)
    expect(sees(e, player, mkCtx(player), specFor('shade'), (ix) => ix !== 4)).toBe(false)
  })
  it('the dark halves sight (12 -> 6); a flashlight in the dark adds 3 (-> 9)', () => {
    expect(sees(e, player, mkCtx(player, { dark: true }), specFor('shade'), open)).toBe(false)              // 8 > 6
    expect(sees(e, player, mkCtx(player, { dark: true, flashlight: true }), specFor('shade'), open)).toBe(true)   // 8 <= 9
    expect(sees(e, { x: 9.6, y: 0.5 }, mkCtx(player, { dark: true, flashlight: true }), specFor('shade'), open)).toBe(false) // 9.1 > 9
    expect(sees(e, player, mkCtx(player, { flashlight: true }), specFor('shade'), open)).toBe(true)         // lit floor: 12
  })
  it('the hound ignores the dark', () => {
    expect(sees(ent(0.5, 0.5, 'hound'), player, mkCtx(player, { dark: true }), specFor('hound'), open)).toBe(true)   // 8 <= 10
    expect(sees(ent(0.5, 0.5, 'crawler'), { x: 3.4, y: 0.5 }, mkCtx(player, { dark: true }), specFor('crawler'), open)).toBe(true)
  })
  it('within 2 u no line is needed', () => {
    expect(sees(e, { x: 2.3, y: 0.5 }, mkCtx(player), specFor('shade'), (ix) => ix !== 1)).toBe(true)
  })
  it('at most 6 LOS walks per update over 20 creatures; the skipped ones keep their verdict and go next frame', () => {
    const player = { x: 50.5, y: 50.5, angle: 0 }
    const ctx = mkCtx(player)
    const R = 10
    const ents = []
    for (let i = 0; i < 20; i++) {
      const a = (i / 20) * Math.PI * 2
      ents.push(ent(player.x + R * Math.cos(a), player.y + R * Math.sin(a), 'shade', { id: i + 1, percT: 0 }))
    }
    const own = new Set(ents.map((e) => `${Math.floor(e.x)},${Math.floor(e.y)}`))
    // which creature's line a far cell lies on: the nearest angle from the player (lines are > 1.9 cells apart past r 6)
    let touched = new Set()
    const floor = (ix, iy) => {
      const dx = ix + 0.5 - player.x, dy = iy + 0.5 - player.y
      if (Math.hypot(dx, dy) >= 6 && !own.has(`${ix},${iy}`)) {
        const a = Math.atan2(dy, dx)
        let best = 0, bd = Infinity
        for (let i = 0; i < 20; i++) { const r = a - (i / 20) * Math.PI * 2; const da = Math.abs(Math.atan2(Math.sin(r), Math.cos(r))); if (da < bd) { bd = da; best = i } }
        touched.add(best)
      }
      return true
    }
    const sys = createEntitySystem(config, wallOf(floor), { grid: mkGrid(floor), obstacles: null })
    for (const e of ents) sys.getEntities().push(e)
    const all = new Set()
    for (let f = 0; f < 4; f++) {
      touched = new Set()
      sys.update(0, player, 2, 2, ctx)
      expect(touched.size).toBeLessThanOrEqual(6)
      expect(touched.size).toBeGreaterThan(0)
      for (const i of touched) all.add(i)
    }
    expect(all.size).toBe(20)
    for (const e of ents) expect(e.ai).toBe('hunt')                    // everyone saw you by the fourth frame
  })
})

// ── the machine ─────────────────────────────────────────────────────────────────────────────────────────────────────
describe('the shared machine on a fake grid', () => {
  // a wall column at x = 10 that can be raised
  function scene() {
    const s = { wall: false }
    const floor = (ix) => !(s.wall && ix === 10)
    const player = { x: 15.5, y: 5.5, angle: Math.PI }
    const ctx = mkCtx(player)
    const sys = createEntitySystem(config, wallOf(floor), { grid: mkGrid(floor), obstacles: null })
    const e = ent(5.5, 5.5)
    sys.getEntities().push(e)
    return { s, player, ctx, sys, e }
  }

  it('roam -> hunt on sight, with one seen event carrying the distance', () => {
    const { player, ctx, sys, e } = scene()
    const kinds = drive(sys, player, ctx, DT)
    expect(e.ai).toBe('hunt')
    expect(e.state).toBe('chase')
    expect(kinds).toEqual(['seen'])
    const out = []
    sys.update(DT, player, 0, 0, ctx)
    expect(sys.drainEvents(out)).toBe(0)                                 // not again while it stays in hunt
  })

  it('hunt -> search after 3.5 s without line of sight; a short hunt pushes no lost', () => {
    const { s, player, ctx, sys, e } = scene()
    drive(sys, player, ctx, DT)
    expect(e.ai).toBe('hunt')
    s.wall = true
    let kinds = drive(sys, player, ctx, 3.3)
    expect(e.ai).toBe('hunt')
    kinds = kinds.concat(drive(sys, player, ctx, 0.7))
    expect(e.ai).toBe('search')
    expect(kinds).not.toContain('lost')                                 // huntT < 4
    expect(e.x).toBeLessThan(10)                                        // never through the wall
  })

  it('a hunt of 4 s or more pushes lost when it goes to search', () => {
    const { s, player, ctx, sys, e } = scene()
    let kinds = drive(sys, player, ctx, 1.0)
    expect(e.ai).toBe('hunt')
    s.wall = true
    kinds = kinds.concat(drive(sys, player, ctx, 4.0))
    expect(e.ai).toBe('search')
    expect(kinds.filter((k) => k === 'lost')).toEqual(['lost'])
  })

  it('search visits where it last saw you first, then ends in roam within 14 s', () => {
    const { player, ctx, sys, e } = scene()
    drive(sys, player, ctx, DT)
    const lx = e.lastSeenX, ly = e.lastSeenY
    expect(lx).toBeCloseTo(15.5, 6); expect(ly).toBeCloseTo(5.5, 6)
    player.x = 60.5; player.y = 60.5                                    // beyond 34: skipped, unseen
    let searchStart = -1, closest = Infinity, roamAt = -1
    drive(sys, player, ctx, 20, DT, (i, t) => {
      if (e.ai === 'search') { if (searchStart < 0) searchStart = t; closest = Math.min(closest, Math.hypot(e.x - lx, e.y - ly)) }
      if (searchStart > 0 && roamAt < 0 && e.ai === 'roam') roamAt = t
    })
    expect(searchStart).toBeGreaterThan(3.4)
    expect(closest).toBeLessThan(0.8)
    expect(roamAt).toBeGreaterThan(searchStart)
    expect(roamAt - searchStart).toBeLessThanOrEqual(14)
    expect(e.searchN).toBe(1)
  })

  it('a noise during roam -> alert facing it (a flinch, then still) -> investigate reaches the noise cell', () => {
    const player = { x: 60.5, y: 60.5, angle: 0 }
    const ctx = mkCtx(player)
    const sys = createEntitySystem(config, wallOf(open), { grid: mkGrid(open), obstacles: null })
    const e = ent(5.5, 5.5)
    sys.getEntities().push(e)
    sys.update(0, player, 2, 2, ctx)
    sys.noise(5.5, 12.5, 12)                                            // a ward, 7 cells south
    let kinds = drive(sys, player, ctx, 0.1, 0.1)
    expect(e.ai).toBe('alert')
    expect(kinds).toEqual(['alert'])
    expect(Math.abs(e.dir - Math.PI / 2)).toBeLessThan(1e-6)           // facing the noise
    expect(deriveState(e)).toBe('stagger')                              // t = 0.1: the flinch
    expect(Math.hypot(e.x - 5.5, e.y - 5.5)).toBeLessThan(1e-9)         // stopped
    drive(sys, player, ctx, 0.4, 0.1)
    expect(e.ai).toBe('alert')
    expect(deriveState(e)).toBe('idle')                                 // t = 0.5: still, listening
    let reached = -1
    drive(sys, player, ctx, 6, DT, (i, t) => { if (reached < 0 && Math.hypot(e.x - 5.5, e.y - 12.5) < 0.8) reached = t })
    expect(reached).toBeGreaterThan(0)
    expect(reached).toBeLessThan(5.5)
    expect(['search', 'roam']).toContain(e.ai)
  })

  it('a louder noise retargets an investigating creature; a quieter one does not', () => {
    const player = { x: 60.5, y: 60.5, angle: 0 }
    const ctx = mkCtx(player)
    const sys = createEntitySystem(config, wallOf(open), { grid: mkGrid(open), obstacles: null })
    const e = ent(5.5, 5.5)
    sys.getEntities().push(e)
    sys.update(0, player, 2, 2, ctx)
    sys.noise(5.5, 12.5, 5)
    drive(sys, player, ctx, 1.0, 0.1)
    expect(e.ai).toBe('investigate')
    expect(e.ty).toBeCloseTo(12.5, 6)
    sys.noise(10.5, 5.5, 3)
    drive(sys, player, ctx, 0.1, 0.1)
    expect(e.ty).toBeCloseTo(12.5, 6)
    sys.noise(10.5, 5.5, 12)
    drive(sys, player, ctx, 0.1, 0.1)
    expect(e.tx).toBeCloseTo(10.5, 6); expect(e.ty).toBeCloseTo(5.5, 6)
  })

  it('an entity far from the player (more than 3 chunks) roams on the legacy step and is never perceived', () => {
    const player = { x: 5.5, y: 5.5, angle: 0 }
    const ctx = mkCtx(player)
    const sys = createEntitySystem(config, wallOf(open), { grid: mkGrid(open), obstacles: null })
    const e = ent(5.5 + 4 * N, 5.5, 'shade', { ai: 'hunt', lastSeenX: 5.5, lastSeenY: 5.5 })
    sys.getEntities().push(e)
    drive(sys, player, ctx, 0.5)
    expect(e.ai).toBe('roam')
    expect(e.state).toBe('idle')
  })
})

// ── deriveState / hostile / solidCreature ───────────────────────────────────────────────────────────────────────────
describe('deriveState maps every phase into the sprite STATES', () => {
  it('covers VARIANT_PHASES, the hold and the alert flinch', () => {
    for (const p of VARIANT_PHASES) {
      const e = { ai: p, stagger: 0, holdT: 0 }
      expect(STATES, p).toContain(deriveState(e))
      expect(e.state).toBe(deriveState(e))
    }
    expect(deriveState({ ai: 'hunt', stagger: 0 })).toBe('chase')
    expect(deriveState({ ai: 'lunge', stagger: 0 })).toBe('chase')
    expect(deriveState({ ai: 'retreat', stagger: 0 })).toBe('flee')
    expect(deriveState({ ai: 'stagger', stagger: 0 })).toBe('stagger')
    expect(deriveState({ ai: 'hunt', stagger: 0.5 })).toBe('stagger')
    for (const p of ['roam', 'investigate', 'search', 'turning', 'freeze', 'shadow', 'still', 'recover', 'windup', 'arcCharge']) expect(deriveState({ ai: p, stagger: 0 }), p).toBe('idle')
    expect(deriveState({ ai: 'alert', stagger: 0, holdT: 0.8 })).toBe('stagger')    // 0.1 s in
    expect(deriveState({ ai: 'alert', stagger: 0, holdT: 0.4 })).toBe('idle')       // 0.5 s in
    expect(deriveState({ ai: 'hunt', stagger: 0, holdT: 0.5 })).toBe('idle')        // the lost-you beat
    expect(deriveState({ ai: 'nonsense', stagger: 0 })).toBe('idle')
  })
  it('hostile needs a hostile phase, no stagger and no pending', () => {
    expect(hostile({ variant: 'shade', ai: 'hunt', stagger: 0, pending: 0 })).toBe(true)
    expect(hostile({ variant: 'shade', ai: 'roam', stagger: 0, pending: 0 })).toBe(false)
    expect(hostile({ variant: 'shade', ai: 'hunt', stagger: 0.1, pending: 0 })).toBe(false)
    expect(hostile({ variant: 'shade', ai: 'hunt', stagger: 0, pending: 1 })).toBe(false)
    expect(hostile({ variant: 'smiler', ai: 'freeze', stagger: 0, pending: 0 })).toBe(true)
    expect(hostile({ variant: 'watcher', ai: 'shadow', stagger: 0, pending: 0 })).toBe(false)
    expect(hostile({ variant: 'crawler', ai: 'still', stagger: 0, pending: 0 })).toBe(false)
    expect(hostile({ variant: 'crawler', ai: 'lunge', stagger: 0, pending: 0 })).toBe(true)
  })
  it('solidCreature is false for turning, staggered, pending, the watcher and a still crawler', () => {
    expect(solidCreature({ variant: 'shade', ai: 'hunt', stagger: 0, pending: 0 })).toBe(true)
    expect(solidCreature({ variant: 'shade', ai: 'roam', stagger: 0, pending: 0 })).toBe(true)
    expect(solidCreature({ variant: 'smiler', ai: 'freeze', stagger: 0, pending: 0 })).toBe(true)
    expect(solidCreature({ variant: 'shade', ai: 'turning', stagger: 0, pending: 0 })).toBe(false)
    expect(solidCreature({ variant: 'shade', ai: 'hunt', stagger: 1, pending: 0 })).toBe(false)
    expect(solidCreature({ variant: 'shade', ai: 'hunt', stagger: 0, pending: 1 })).toBe(false)
    expect(solidCreature({ variant: 'watcher', ai: 'shadow', stagger: 0, pending: 0 })).toBe(false)
    expect(solidCreature({ variant: 'crawler', ai: 'still', stagger: 0, pending: 0 })).toBe(false)
    expect(solidCreature({ variant: 'crawler', ai: 'lunge', stagger: 0, pending: 0 })).toBe(true)
    expect(solidCreature({ variant: 'shade', type: 'stalker', state: 'chase' })).toBe(true)      // a legacy-shaped entity
  })
})

// ── the one stagger spec ────────────────────────────────────────────────────────────────────────────────────────────
describe('stagger: flee, then the turning opening', () => {
  const player = { x: 10, y: 10, angle: 0 }
  function staggered(blocked) {
    const ctx = mkCtx(player)
    const sys = createEntitySystem(config, wallOf(open), { grid: mkGrid(open), obstacles: obst(blocked) })
    const e = ent(11.5, 10, 'shade', { ai: 'hunt', lastSeenX: 10, lastSeenY: 10 })
    sys.getEntities().push(e)
    sys.update(0, player, 0, 0, ctx)
    const res = sys.ward(player)
    expect(res.hit).toBe(1)
    return { sys, ctx, e }
  }

  it('a staggered creature (staggerT 2.6) reels until t = 1.8, turns until 2.6, then searches with a turning event', () => {
    const { sys, ctx, e } = staggered(() => false)
    expect(e.stagger).toBeCloseTo(2.6, 9)
    expect(e.x).toBeCloseTo(13.2, 9)                                    // knocked back 1.7
    let kinds = drive(sys, player, ctx, 1.7)
    expect(e.ai).toBe('stagger'); expect(e.stagger).toBeGreaterThan(0); expect(e.state).toBe('stagger')
    expect(kinds).toEqual([])
    expect(e.x).toBeGreaterThan(13.2)                                   // fleeing
    kinds = drive(sys, player, ctx, 0.2)
    expect(e.ai).toBe('turning'); expect(e.stagger).toBe(0); expect(deriveState(e)).toBe('idle')
    expect(kinds).toEqual(['turning'])                                 // the opening is announced as it starts
    expect(solidCreature(e)).toBe(false); expect(hostile(e)).toBe(false)
    const xTurning = e.x
    drive(sys, player, ctx, 0.6)
    expect(e.ai).toBe('turning')
    expect(e.x).toBe(xTurning)                                         // speed 0 while turning
    let after = null
    kinds = drive(sys, player, ctx, 0.2, DT, () => { if (after === null && e.ai !== 'turning') after = e.ai })
    expect(after).toBe('search')                                       // it leaves the opening into search (and, seeing you, hunts)
    expect(['search', 'hunt']).toContain(e.ai)
    expect(kinds).not.toContain('turn')
  })

  it('with the way behind it blocked, the flee is blocked and it turns early (by 0.4-0.5 s) then bursts into hunt', () => {
    const { sys, ctx, e } = staggered((x) => x > 11.6)
    expect(e.x).toBe(11.5)                                              // the knockback stopped at the blocked target
    drive(sys, player, ctx, 0.35)
    expect(e.ai).toBe('stagger')
    let kinds = drive(sys, player, ctx, 0.15)
    expect(e.ai).toBe('turning')
    expect(e.stagger).toBe(0)
    expect(kinds).not.toContain('turning')
    kinds = kinds.concat(drive(sys, player, ctx, 0.8))
    expect(e.ai).toBe('hunt')
    expect(e.burstT).toBeGreaterThan(0.9); expect(e.burstT).toBeLessThanOrEqual(1.0)
    expect(kinds).toContain('turn')
    expect(kinds).not.toContain('turning')
  })

  it('on open ground the legacy path (ctx undefined) flees for the whole second', () => {
    const sys = createEntitySystem({ chunkEvictRadius: 3 }, () => false)
    sys.getEntities().push({ ...ent(11.5, 10), state: 'chase', stagger: 1.0 })
    const e = sys.getEntities()[0]
    let last = e.x
    for (let i = 0; i < 5; i++) {
      sys.update(0.19, player, 0, 0)
      expect(e.state).toBe('stagger'); expect(e.x).toBeGreaterThan(last); last = e.x
    }
    expect(e.stagger).toBeGreaterThan(0)
    expect(e.ai).toBeUndefined()                                        // untouched by the hunt path
  })
})

// ── the obstacle layer ──────────────────────────────────────────────────────────────────────────────────────────────
describe('moveToward / moveAway', () => {
  it('a body on the direct line but not on dir + 0.6: displaced to that side, and the side is kept 0.8 s', () => {
    const env = mkEnv(open, obst((x, y, r) => Math.hypot(x - 6.5, y - 5) < 0.5 + r))
    const e = ent(5, 5)
    let minY = Infinity, steers = new Set()
    for (let i = 0; i < 48; i++) { moveToward(e, 15, 5, 2.0, env); minY = Math.min(minY, e.y); steers.add(e.steer) }
    expect(e.y).toBeGreaterThan(5)
    expect(minY).toBeGreaterThanOrEqual(5 - 1e-9)
    expect([...steers]).toEqual([1])
    for (let i = 0; i < 90; i++) moveToward(e, 15, 5, 2.0, env)
    expect(e.x).toBeGreaterThan(6.5)                                    // round it
    expect(Math.hypot(e.x - 6.5, e.y - 5)).toBeGreaterThanOrEqual(0.5 + creatureRadius('shade') - 1e-9)
  })

  it('blocked on all six side probes but clear behind: it steps backward', () => {
    const env = mkEnv(open, obst((x, y) => !(x <= 5.0 && Math.abs(y - 5) < 0.15)))
    const e = ent(5, 5)
    const blocked = moveToward(e, 15, 5, 2.0, env)
    expect(blocked).toBe(false)
    expect(e.x).toBeLessThan(5)
    expect(e.y).toBeCloseTo(5, 9)
  })

  it('boxed in for 1.6 s -> the hold (idle speed, no re-aim) for 1.0 s, then it hunts again', () => {
    const env = mkEnv(open, obst((x, y) => Math.hypot(x - 5, y - 5) > 0.001))
    const player = { x: 70, y: 5, angle: 0 }
    env.player = player
    const ctx = mkCtx(player)
    const e = ent(5, 5, 'shade', { ai: 'hunt', lastSeenX: 15, lastSeenY: 5, huntT: 0, lostT: 0 })
    const th = env.threat
    const run = (s) => { for (let i = 0; i < Math.round(s / DT); i++) { th.begin(); stepAI(e, DT, ctx, specFor('shade'), env, th) } }
    run(1.4)
    expect(e.holdT).toBe(0); expect(e.ai).toBe('hunt'); expect(e.blockedT).toBeGreaterThan(1.3)
    run(0.2)
    expect(e.holdT).toBeGreaterThan(0.8); expect(e.ai).toBe('hunt')
    expect(deriveState(e)).toBe('idle')
    const dir = e.dir
    run(0.5)
    expect(e.holdT).toBeGreaterThan(0.3)
    expect(e.dir).not.toBeCloseTo(0, 3)                                 // not re-aimed at the target (which is due east)
    run(0.6)
    expect(e.holdT).toBeLessThanOrEqual(0); expect(e.ai).toBe('hunt')
    expect(Math.hypot(e.x - 5, e.y - 5)).toBeLessThan(1e-9)             // boxed: never moved
    void dir
  })

  it('x / y never enter a wall, with and without obstacles', () => {
    let s = 12345
    const rnd = () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 0xffffffff }
    const h = (ix, iy) => { let v = (ix * 374761393 + iy * 668265263) | 0; v = Math.imul(v ^ (v >>> 13), 1274126177); return ((v ^ (v >>> 16)) >>> 0) / 4294967296 }
    const floor = (ix, iy) => (ix === 0 && iy === 0) || h(ix, iy) > 0.3
    for (const ob of [null, obst((x, y) => Math.hypot(x - 2.5, y - 2.5) < 0.6)]) {
      const env = mkEnv(floor, ob)
      const e = ent(0.5, 0.5)
      let tx = 6, ty = 6
      for (let i = 0; i < 3000; i++) {
        if (i % 120 === 0) { tx = (rnd() - 0.5) * 16; ty = (rnd() - 0.5) * 16 }
        if (i % 2) moveToward(e, tx, ty, 3.3, env); else moveAway(e, -tx, -ty, 2.0, env)
        expect(floor(Math.floor(e.x), Math.floor(e.y))).toBe(true)
        expect(Number.isFinite(e.x) && Number.isFinite(e.y)).toBe(true)
      }
    }
  })

  it('an L-bend on the real chunk grid is passed within 3 s', () => {
    const floor = chunkFloor(0, 0)
    expect(floor(1, 4) && floor(1, 1) && floor(5, 1)).toBe(true)
    expect(lineOfSight(1.5, 4.5, 5.5, 1.5, floor)).toBe(false)         // a wall between the legs
    const env = mkEnv(floor, noObst)
    const e = ent(1.5, 4.5)
    let t = -1
    for (let i = 0; i < 180; i++) {
      moveToward(e, 5.5, 1.5, 3.3, env)
      expect(floor(Math.floor(e.x), Math.floor(e.y))).toBe(true)
      if (Math.hypot(e.x - 5.5, e.y - 1.5) < 0.8) { t = (i + 1) * DT; break }
    }
    expect(t).toBeGreaterThan(0)
    expect(t).toBeLessThanOrEqual(3)
  })

  it('moveAway mirrors moveToward and both report blocked only when every heading is shut', () => {
    const env = mkEnv(open, noObst)
    const e = ent(5, 5)
    expect(moveAway(e, 0, 5, 2.0, env)).toBe(false)
    expect(e.x).toBeGreaterThan(5)
    const boxed = mkEnv(open, obst((x, y) => Math.hypot(x - 5, y - 5) > 0.001))
    const b = ent(5, 5)
    expect(moveToward(b, 15, 5, 2.0, boxed)).toBe(true)
    expect(b.x).toBe(5); expect(b.y).toBe(5)
  })
})

// ── separation ──────────────────────────────────────────────────────────────────────────────────────────────────────
describe('separation', () => {
  const player = { x: 60.5, y: 60.5, angle: 0 }
  it('two entities 0.1 apart are at least ri + rj apart after one update; neither inside a wall', () => {
    const floor = (ix) => ix >= 5                                       // wall to the west of x = 5
    const ctx = mkCtx(player)
    const sys = createEntitySystem(config, wallOf(floor), { grid: mkGrid(floor), obstacles: noObst })
    const a = ent(5.05, 7.5, 'shade', { id: 1 }), b = ent(5.15, 7.5, 'hound', { id: 2 })
    sys.getEntities().push(a, b)
    sys.update(0, player, 2, 2, ctx)
    expect(floor(Math.floor(a.x), Math.floor(a.y))).toBe(true)
    expect(floor(Math.floor(b.x), Math.floor(b.y))).toBe(true)
    expect(a.x).toBeCloseTo(5.05, 9)                                    // its half would have entered the wall: reverted
    expect(b.x).toBeGreaterThan(5.15)
    const c = ent(8.0, 7.5, 'shade', { id: 3 }), d = ent(8.1, 7.5, 'shade', { id: 4 })
    sys.getEntities().push(c, d)
    sys.update(0, player, 2, 2, ctx)
    expect(Math.hypot(c.x - d.x, c.y - d.y)).toBeGreaterThanOrEqual(creatureRadius('shade') * 2 - 1e-9)
  })
  it('a staggered one takes the whole separation', () => {
    const env = mkEnv(open, noObst)
    const a = ent(8.0, 7.5, 'shade', { id: 1, stagger: 1.0 }), b = ent(8.1, 7.5, 'shade', { id: 2 })
    separate([a, b], env)
    expect(b.x).toBe(8.1); expect(b.y).toBe(7.5)
    expect(a.x).toBeLessThan(8.0)
    expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThanOrEqual(creatureRadius('shade') * 2 - 1e-9)
  })
  it('never runs with obstacles null: overlapping creatures stay overlapping on that path', () => {
    const ctx = mkCtx(player)
    const sys = createEntitySystem(config, wallOf(open), { grid: mkGrid(open), obstacles: null })
    const a = ent(8.0, 7.5, 'shade', { id: 1 }), b = ent(8.1, 7.5, 'shade', { id: 2 })
    sys.getEntities().push(a, b)
    sys.update(0, player, 2, 2, ctx)
    expect(a.x).toBe(8.0); expect(b.x).toBe(8.1)
  })
})
