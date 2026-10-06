// entities.js on the hunt path — the ward that leaves a dispel behind, the flash, the noise ring, injected followers,
// the threat record, the legacy gate, and the frame budget on a real chunk cache.
import { describe, it, expect } from 'vitest'
import { createEntitySystem, moveEntity } from '../src/renderer/entities.js'
import { DISPEL_S, createThreat } from '../src/renderer/hunt.js'
import { createChunkCache, createGridReader, CHUNK_SIZE } from '../src/renderer/world.js'
import { creatureRadius } from '../src/renderer/collide.js'
import { HF } from '../src/renderer/gfx-frame.js'

const DT = 1 / 60
const N = CHUNK_SIZE
const quiet = { chunkEvictRadius: 3, entities: { enabled: false } }
const noSpawn = { chunkEvictRadius: 3, entities: { enabled: true, spawnDenom: 1e9 } }   // followers allowed, nothing of its own
const open = () => true
const mkGrid = (floor) => ({ floor, setPlayerChunk() {} })
const wallOf = (floor) => (wx, wy) => !floor(Math.floor(wx), Math.floor(wy))
const noObst = { blocked: () => false, radiusFor: creatureRadius }
const obst = (fn) => ({ blocked: fn, radiusFor: creatureRadius })
function mkCtx(player, over = {}) {
  return { flashlight: false, sprinting: false, dark: false, fog: 16, radioOn: false, lures: [], t: 0, hf: HF, playerAngle: player.angle ?? 0, player, damage: 16, ...over }
}
function ent(x, y, variant = 'shade', over = {}) {
  return { id: over.id ?? 1, x, y, type: 'stalker', variant, state: 'idle', dir: 0, dirTimer: 99, stagger: 0, wardHits: 0, chunkCx: Math.floor(x / N), chunkCy: Math.floor(y / N), ...over }
}
const inFront = (over = {}) => ent(11.5, 10, 'shade', { ai: 'hunt', lastSeenX: 10, lastSeenY: 10, ...over })

describe('createEntitySystem shape', () => {
  it('exposes the hunt-path API and returns the one threat record from update', () => {
    const sys = createEntitySystem(quiet, () => false)
    for (const k of ['update', 'getEntities', 'ward', 'flash', 'noise', 'snapshotChasers', 'inject', 'takeWakeEvent', 'drainEvents', 'getThreat', 'getDispelled', 'restoreDispelled']) expect(typeof sys[k], k).toBe('function')
    const th = sys.getThreat()
    const player = { x: 10, y: 10, angle: 0 }
    expect(sys.update(DT, player, 0, 0, mkCtx(player))).toBe(th)
    expect(sys.update(DT, player, 0, 0)).toBe(th)
    expect(sys.update(DT, player, 0, 0, 1.5)).toBe(th)
    expect(th).toMatchObject({ hunted: false, nearest: Infinity, nearestEntity: null, gaze: false, gazeRate: 0, dmg: 0, dmgKind: null, arcPending: false })
    expect(Array.isArray(th.events)).toBe(true)
    expect(typeof th.reset).toBe('function')
  })
  it('moveEntity returns blocked and refuses an axis a body is on, but lets a creature already inside one leave', () => {
    const e = { x: 5.5, y: 5.5, dir: 0 }
    expect(moveEntity(e, 1, 0.1, () => false, 0, 0)).toBe(false)
    expect(e.x).toBeCloseTo(5.6, 9)
    e.x = 5.95
    expect(moveEntity(e, 1, 0.1, (ix) => ix === 5 ? false : true, 0, 0)).toBe(true)   // x axis refused by a wall
    expect(e.x).toBe(5.95)
    const f = { x: 5.5, y: 5.5, dir: 0 }
    expect(moveEntity(f, 1, 0.1, () => false, 0, 0, obst((x) => x > 5.55), 0.1)).toBe(true)
    expect(f.x).toBe(5.5)
    const g = { x: 5.5, y: 5.5, dir: 0 }
    expect(moveEntity(g, 1, 0.1, () => false, 0, 0, obst(() => true), 0.1)).toBe(false)    // inside: may leave
    expect(g.x).toBeCloseTo(5.6, 9)
  })
})

describe('the ward on the hunt path', () => {
  const player = { x: 10, y: 10, angle: 0 }
  it('knockback stops at a blocked target, per axis', () => {
    const sys = createEntitySystem(quiet, wallOf(open), { grid: mkGrid(open), obstacles: obst((x) => x > 12) })
    const e = inFront()
    sys.getEntities().push(e)
    const res = sys.ward(player)
    expect(res.hit).toBe(1)
    expect(e.x).toBe(11.5)
    expect(e.stagger).toBeCloseTo(2.6, 9)                               // the shade spec
    expect(e.ai).toBe('stagger')
    const free = createEntitySystem(quiet, wallOf(open), { grid: mkGrid(open), obstacles: noObst })
    const f = inFront()
    free.getEntities().push(f)
    free.ward(player)
    expect(f.x).toBeCloseTo(13.2, 9)
  })
  it('a turning creature takes +2 wardHits from a tap, +3 from a charged ward, and the result counts the opening', () => {
    const sys = createEntitySystem(quiet, wallOf(open), { grid: mkGrid(open), obstacles: noObst })
    const e = inFront({ ai: 'turning', variant: 'hound' })              // dispelAt 2 would end it: use a shade
    e.variant = 'shade'
    sys.getEntities().push(e)
    let res = sys.ward(player)
    expect(res).toMatchObject({ hit: 1, dispelled: 0, opening: 1 })
    expect(e.wardHits).toBe(2)
    e.ai = 'turning'; e.stagger = 0; e.x = 11.5; e.wardHits = 0
    res = sys.ward(player, { hits: 2, dispelAt: 9 })
    expect(e.wardHits).toBe(3)
    expect(res.opening).toBe(1)
    e.ai = 'hunt'; e.x = 11.5; e.wardHits = 0
    res = sys.ward(player, { hits: 2, dispelAt: 9 })
    expect(e.wardHits).toBe(2); expect(res.opening).toBe(0)
  })
  it('per-entity staggerT / dispelAt come from the variant spec unless opts override; wardMul in windup / lunge', () => {
    const sys = createEntitySystem(quiet, wallOf(open), { grid: mkGrid(open), obstacles: noObst })
    const h = inFront({ variant: 'hound', ai: 'windup' })
    sys.getEntities().push(h)
    sys.ward(player)
    expect(h.stagger).toBeCloseTo(2.0, 9)                               // hound staggerT
    expect(h.x).toBeCloseTo(11.5 + 1.7 * 2, 9)                          // wardMul 2
    expect(h.wardHits).toBe(1)
    const t = inFront({ variant: 'tesla', ai: 'hunt' })
    sys.getEntities().length = 0
    sys.getEntities().push(t)
    sys.ward(player, { staggerTime: 0.9 })
    expect(t.stagger).toBeCloseTo(0.9, 9)
  })
  it('the result object identity is stable', () => {
    const sys = createEntitySystem(quiet, wallOf(open), { grid: mkGrid(open), obstacles: noObst })
    const a = sys.ward(player), b = sys.ward(player)
    expect(a).toBe(b)
  })
  it('a dispel sticks: 10 further updates spawn nothing in that chunk; restoreDispelled with 0 remaining lets it spawn', () => {
    // find a chunk that spawns, with the default rules
    const cfg = { chunkEvictRadius: 3 }
    const sys = createEntitySystem(cfg, () => false)
    const p = { x: 11, y: 11, angle: 0 }
    sys.update(0, p, 0, 0, mkCtx(p))
    const first = sys.getEntities()[0]
    expect(first).toBeDefined()
    const cx = first.chunkCx, cy = first.chunkCy
    const inChunk = () => sys.getEntities().filter((e) => e.chunkCx === cx && e.chunkCy === cy).length
    expect(inChunk()).toBe(1)
    // stand 1.5 west of it facing east and ward it to pieces (re-placed before each strike)
    const player = { x: first.x - 1.5, y: first.y, angle: 0 }
    let last
    for (let i = 0; i < 3; i++) { first.stagger = 0; first.ai = 'hunt'; first.x = player.x + 1.5; first.y = player.y; last = sys.ward(player) }
    expect(last.dispelled).toBe(1)
    expect(inChunk()).toBe(0)
    const dis = sys.getDispelled()
    expect(dis.length).toBe(1)
    expect(dis[0][0]).toBe(cx); expect(dis[0][1]).toBe(cy); expect(dis[0][2]).toBeCloseTo(DISPEL_S, 6)
    for (let i = 0; i < 10; i++) sys.update(0.1, p, 0, 0, mkCtx(p))
    expect(inChunk()).toBe(0)
    expect(sys.getDispelled()[0][2]).toBeCloseTo(DISPEL_S - 1.0, 6)     // the internal clock is the sum of dt
    sys.restoreDispelled([[cx, cy, 0]], 1.0)
    sys.update(0.1, p, 0, 0, mkCtx(p))
    expect(inChunk()).toBe(1)
    expect(sys.getDispelled()).toEqual([])
  })
  it('dispelledUntil is bounded at 64 entries, oldest dropped; eviction leaves it alone', () => {
    const sys = createEntitySystem(quiet, () => false)
    const list = []
    for (let i = 0; i < 70; i++) list.push([i, 0, 100])
    sys.restoreDispelled(list, 0)
    const d = sys.getDispelled()
    expect(d.length).toBe(64)
    expect(d[0][0]).toBe(6)
    sys.update(DT, { x: 5000, y: 5000, angle: 0 }, 227, 227)
    expect(sys.getDispelled().length).toBe(64)
  })
  it('dispelling a watcher pushes watcher-dispelled; ward events survive until the next drain', () => {
    const sys = createEntitySystem(quiet, wallOf(open), { grid: mkGrid(open), obstacles: noObst })
    const w = inFront({ variant: 'watcher', ai: 'shadow' })
    sys.getEntities().push(w)
    const res = sys.ward(player)                                        // dispelAt 1
    expect(res.dispelled).toBe(1)
    sys.update(DT, player, 0, 0, mkCtx(player))                       // the frame after: the event is still there
    const out = []
    expect(sys.drainEvents(out)).toBe(1)
    expect(out[0].kind).toBe('watcher-dispelled')
    expect(out[0].id).toBe(w.id)
    expect(sys.drainEvents(out)).toBe(0)
  })
})

describe('the flash', () => {
  const player = { x: 10, y: 10, angle: 0 }
  it('staggers an entity in the cone with line of sight, not one behind a wall, and adds no wardHits', () => {
    const floor = (ix) => ix !== 13
    const sys = createEntitySystem(quiet, wallOf(floor), { grid: mkGrid(floor), obstacles: noObst })
    const a = inFront({ id: 1 }), b = inFront({ id: 2, x: 14.5 }), c = inFront({ id: 3, x: 8.5 })
    sys.getEntities().push(a, b, c)
    const res = sys.flash(player, { range: 6, cone: Math.PI / 2.4, stagger: 1.8 })
    expect(res.hit).toBe(1)
    expect(a.stagger).toBeCloseTo(1.8, 9); expect(a.x).toBe(11.5); expect(a.wardHits).toBe(0)
    expect(b.stagger).toBe(0); expect(c.stagger).toBe(0)
    expect(sys.flash(player, { range: 6, cone: Math.PI / 2.4, stagger: 1.8 })).toBe(res)
  })
  it('a smiler or lurker in the flash retreats for 3 s instead of turning', () => {
    const sys = createEntitySystem(quiet, wallOf(open), { grid: mkGrid(open), obstacles: noObst })
    const s = inFront({ id: 1, variant: 'smiler' })
    sys.getEntities().push(s)
    sys.flash(player, { range: 6, cone: Math.PI / 2.4, stagger: 1.8 })
    expect(s.ai).toBe('retreat')
    const ctx = mkCtx(player)
    for (let i = 0; i < 120; i++) sys.update(DT, player, 0, 0, ctx)   // 2 s
    expect(s.ai).toBe('retreat')
    expect(s.x).toBeGreaterThan(14)
    let after = null
    for (let i = 0; i < 70; i++) { sys.update(DT, player, 0, 0, ctx); if (after === null && s.ai !== 'retreat') after = s.ai }
    expect(after).toBe('search')
  })
})

describe('the noise ring', () => {
  it('keeps eight noises and floods the newest', () => {
    const player = { x: 60.5, y: 60.5, angle: 0 }
    const sys = createEntitySystem(quiet, wallOf(open), { grid: mkGrid(open), obstacles: null })
    const e = ent(5.5, 5.5)
    sys.getEntities().push(e)
    sys.update(0, player, 2, 2, mkCtx(player))
    for (let i = 0; i < 9; i++) sys.noise(100 + i, 100, 3)              // far away: nothing hears these
    sys.noise(5.5, 9.5, 3)
    sys.update(DT, player, 2, 2, mkCtx(player))
    expect(e.ai).toBe('alert')
  })
})

describe('inject: followers that arrive a beat later', () => {
  const near = { x: 50.5, y: 50.5, angle: 0 }
  it('places N entities 7-10 cells away on open cells blockedFn allows, pending until the delay elapses, then hunting', () => {
    const floor = (ix, iy) => !(ix === 44 && iy > 40 && iy < 60)        // a wall column west of the point
    const sys = createEntitySystem(noSpawn, wallOf(floor), { grid: mkGrid(floor), obstacles: null })
    const n = sys.inject([{ type: 'stalker', variant: 'hound', wardHits: 1 }, { type: 'stalker', variant: 'shade' }], near.x, near.y, 7, 10, 2.0, (x, y) => y < 50)
    expect(n).toBe(2)
    expect(sys.getEntities().length).toBe(0)
    const ctx = mkCtx(near)
    sys.update(1.0, near, 2, 2, ctx)
    expect(sys.getEntities().length).toBe(0)
    expect(sys.takeWakeEvent()).toBe(0)
    sys.update(1.0, near, 2, 2, ctx)
    const ents = sys.getEntities()
    expect(ents.length).toBe(2)
    expect(sys.takeWakeEvent()).toBe(2)
    expect(sys.takeWakeEvent()).toBe(0)
    for (const e of ents) {
      const d = Math.hypot(e.x - near.x, e.y - near.y)
      expect(d).toBeGreaterThanOrEqual(7 - 0.71); expect(d).toBeLessThanOrEqual(10 + 0.71)
      expect(e.y).toBeGreaterThanOrEqual(50)
      expect(floor(Math.floor(e.x), Math.floor(e.y))).toBe(true)
      expect(e.ai).toBe('hunt'); expect(e.pending).toBe(0)
      expect(e.lastSeenX).toBe(near.x); expect(e.lastSeenY).toBe(near.y)
      expect(e.chunkCx).toBe(Math.floor(e.x / N)); expect(e.chunkCy).toBe(Math.floor(e.y / N))
      expect(typeof e.id).toBe('number')
      // facing the player
      const want = Math.atan2(near.y - e.y, near.x - e.x)
      expect(Math.abs(Math.atan2(Math.sin(e.dir - want), Math.cos(e.dir - want)))).toBeLessThan(0.6)
    }
    expect(ents.map((e) => e.variant).sort()).toEqual(['hound', 'shade'])
    expect(ents.find((e) => e.variant === 'hound').wardHits).toBe(1)
    expect(ents[0].id).not.toBe(ents[1].id)
  })
  it('respects MAX_ENTITIES and enabled: false; never closer than 4 u; ignores dispelledUntil', () => {
    const sys = createEntitySystem(noSpawn, wallOf(open), { grid: mkGrid(open), obstacles: null })
    for (let i = 0; i < 20; i++) sys.getEntities().push(ent(100 + i, 100, 'shade', { id: 500 + i }))
    expect(sys.inject([{ type: 'stalker', variant: 'shade' }], near.x, near.y, 7, 10, 0, null)).toBe(0)
    const off = createEntitySystem({ chunkEvictRadius: 3, entities: { enabled: false } }, wallOf(open), { grid: mkGrid(open), obstacles: null })
    // enabled false is also what `quiet` says: inject honours it
    expect(off.inject([{ type: 'stalker', variant: 'shade' }], near.x, near.y, 7, 10, 0, null)).toBe(0)
    const on = createEntitySystem({ chunkEvictRadius: 3, entities: { enabled: true, spawnDenom: 1e9 } }, wallOf(open), { grid: mkGrid(open), obstacles: null })
    // everything within 9.5 of the point refused: only the 10 ring is left
    expect(on.inject([{ type: 'stalker', variant: 'shade' }], near.x, near.y, 7, 10, 0, (x, y) => Math.hypot(x - near.x, y - near.y) < 9.5)).toBe(1)
    // everything beyond 3.5 refused: nothing lands closer than 4, so it is dropped
    expect(on.inject([{ type: 'stalker', variant: 'shade' }], near.x, near.y, 7, 10, 0, (x, y) => Math.hypot(x - near.x, y - near.y) > 3.5)).toBe(0)
    const list = []
    for (let cx = 0; cx <= 4; cx++) for (let cy = 0; cy <= 4; cy++) list.push([cx, cy, 240])
    on.restoreDispelled(list, 0)
    expect(on.inject([{ type: 'stalker', variant: 'shade' }], near.x, near.y, 7, 10, 0, null)).toBe(1)
  })
  it('an inject with a zero delay joins on the next update', () => {
    const sys = createEntitySystem(noSpawn, wallOf(open), { grid: mkGrid(open), obstacles: null })
    expect(sys.inject([{ type: 'stalker', variant: 'shade' }], near.x, near.y, 7, 10, 0, null)).toBe(1)
    expect(sys.getEntities().length).toBe(0)
    sys.update(DT, near, 2, 2, mkCtx(near))
    expect(sys.getEntities().length).toBe(1)
    expect(sys.takeWakeEvent()).toBe(1)
  })
})

describe('snapshotChasers', () => {
  it('returns only hunting stalkers within range, capped at 3, on both paths', () => {
    const player = { x: 50.5, y: 50.5, angle: 0 }
    const checker = (ix, iy) => (ix + iy) % 2 === 0                      // no line of sight anywhere past a cell
    const sys = createEntitySystem(quiet, wallOf(checker), { grid: mkGrid(checker), obstacles: null })
    const list = sys.getEntities()
    list.push(ent(55.5, 50.5, 'shade', { id: 1, ai: 'hunt', wardHits: 2 }))        // 5: yes
    list.push(ent(53.5, 50.5, 'shade', { id: 2, ai: 'roam' }))                      // roaming: no
    list.push(ent(54.5, 50.5, 'watcher', { id: 3, ai: 'hunt', type: 'wanderer' }))  // wanderer: no
    list.push(ent(62.5, 50.5, 'shade', { id: 4, ai: 'hunt' }))                      // 12: no
    for (let i = 0; i < 4; i++) list.push(ent(50.5 + 6, 50.5 + i * 0.3, 'hound', { id: 10 + i, ai: 'hunt' }))
    sys.update(0, player, 2, 2, mkCtx(player))
    const snap = sys.snapshotChasers(player, 10, 3)
    expect(snap.length).toBe(3)
    for (const s of snap) { expect(s.type).toBe('stalker'); expect(['shade', 'hound']).toContain(s.variant); expect(typeof s.wardHits).toBe('number') }
    expect(snap[0]).toEqual({ type: 'stalker', variant: 'shade', wardHits: 2 })
    expect(sys.snapshotChasers(player, 10).length).toBe(3)
    expect(sys.snapshotChasers(player, 5.5, 3).length).toBe(1)
    // the legacy path: state 'chase'
    const old = createEntitySystem(quiet, () => false)
    old.getEntities().push({ ...ent(55.5, 50.5), state: 'chase' }, { ...ent(56.5, 50.5), state: 'idle' })
    expect(old.snapshotChasers(player, 10, 3).length).toBe(1)
  })
})

describe('the threat record and contact', () => {
  it('a hostile creature within 0.62 raises dmg (contact); hunted and nearest follow the hunt', () => {
    const player = { x: 10, y: 10, angle: 0 }
    const ctx = mkCtx(player)
    const sys = createEntitySystem({ chunkEvictRadius: 3, entities: { enabled: false, damage: 14 } }, wallOf(open), { grid: mkGrid(open), obstacles: noObst })
    const e = inFront({ x: 10.5 })
    sys.getEntities().push(e)
    const th = sys.update(0, player, 0, 0, ctx)
    expect(th.hunted).toBe(true)
    expect(th.nearest).toBeCloseTo(0.5, 9); expect(th.nearestEntity).toBe(e)
    expect(th.dmg).toBe(14); expect(th.dmgKind).toBe('contact')
    e.stagger = 1
    sys.update(0, player, 0, 0, ctx)
    expect(th.dmg).toBe(0); expect(th.hunted).toBe(false); expect(th.nearest).toBe(Infinity)
    const c = inFront({ x: 10.5, variant: 'crawler', ai: 'lunge', stagger: 0, id: 2 })
    sys.getEntities().length = 0; sys.getEntities().push(c)
    sys.update(0, player, 0, 0, ctx)
    expect(th.dmg).toBe(10)
  })
  it('the legacy path also fills the record from stalkers in reach, and reset() zeroes it', () => {
    const player = { x: 10, y: 10, angle: 0 }
    const sys = createEntitySystem({ chunkEvictRadius: 3, entities: { enabled: false, damage: 18 } }, () => false)
    sys.getEntities().push({ ...ent(10.4, 10), state: 'chase' })
    const th = sys.update(0, player, 0, 0, 1.5)
    expect(th.dmg).toBe(18); expect(th.nearest).toBeCloseTo(0.4, 9); expect(th.hunted).toBe(true)
    th.reset()
    expect(th.dmg).toBe(0); expect(th.nearest).toBe(Infinity); expect(th.hunted).toBe(false); expect(th.events.length).toBe(0)
  })
  it('createThreat events are pooled and cleared each frame; drainEvents writes into the caller array', () => {
    const th = createThreat()
    const e = { id: 7, x: 1, y: 2 }
    th.emit('seen', e, 3)
    expect(th.events[0]).toMatchObject({ kind: 'seen', id: 7, x: 1, y: 2, d: 3 })
    th.end(); th.begin()
    expect(th.events.length).toBe(0)
    th.emit('alert', e, 1); th.end()
    th.emit('turn', e, 2)                                              // between frames
    th.begin()
    expect(th.events.map((ev) => ev.kind)).toEqual(['turn'])
    for (let i = 0; i < 40; i++) th.emit('lost', e, 0)
    expect(th.events.length).toBeLessThanOrEqual(32)
  })
})

describe('the legacy gate', () => {
  it('a number or undefined fifth argument runs the old step; hunt fields stay untouched', () => {
    const sys = createEntitySystem({ chunkEvictRadius: 3 }, () => false)
    const s = { x: 10, y: 10, type: 'stalker', state: 'idle', dir: 0, dirTimer: 99, chunkCx: 0, chunkCy: 0 }
    sys.getEntities().push(s)
    sys.update(0.016, { x: 10, y: 40 }, 0, 0, 1.5)                      // 30 < 24 * 1.5
    expect(s.state).toBe('chase')
    expect(s.ai).toBeUndefined(); expect(s.lostT).toBeUndefined()
    sys.update(0.016, { x: 10, y: 40 }, 0, 0)
    expect(s.state).toBe('idle')
  })
  it('an injected entity with no ai fields steps on the hunt path without throwing and gets its shape', () => {
    const player = { x: 10, y: 10, angle: 0 }
    const sys = createEntitySystem(quiet, wallOf(open), { grid: mkGrid(open), obstacles: noObst })
    const bare = { x: 14, y: 10, type: 'stalker', variant: 'shade', state: 'idle', dir: 0, dirTimer: 1, chunkCx: 0, chunkCy: 0 }
    sys.getEntities().push(bare)
    expect(() => sys.update(DT, player, 0, 0, mkCtx(player))).not.toThrow()
    expect(['roam', 'hunt']).toContain(bare.ai)
    for (const k of ['percT', 'lostT', 'huntT', 'searchT', 'blockedT', 'holdT', 'burstT', 'steer', 'steerT', 'staggerBlockedT', 'searchN', 'pending', 'stagger']) expect(typeof bare[k], k).toBe('number')
  })
  it('spawned entities carry the hunt shape (id monotonic, ai roam, timers zero)', () => {
    const sys = createEntitySystem({ chunkEvictRadius: 3 }, () => false)
    for (let cx = -3; cx <= 3; cx++) for (let cy = -3; cy <= 3; cy++) sys.update(0, { x: cx * N + 11, y: cy * N + 11 }, cx, cy)
    const ents = sys.getEntities()
    expect(ents.length).toBeGreaterThan(1)
    const ids = ents.map((e) => e.id)
    for (let i = 1; i < ids.length; i++) expect(ids[i]).toBeGreaterThan(ids[i - 1])
    for (const e of ents) {
      expect(e).toMatchObject({ ai: 'roam', percT: 0, lostT: 0, huntT: 0, searchT: 0, blockedT: 0, holdT: 0, burstT: 0, steer: 1, steerT: 0, staggerBlockedT: 0, lastSeenX: null, lastSeenY: null, tx: null, ty: null, searchN: 0, pending: 0 })
    }
  })
})

// The 600 updates are walked twice back to back (the second run is the warmed, steady state the game lives in); the better run
// carries the 150 ms budget, both carry the identities and the getChunk accounting — a machine busy with the rest of the suite
// must not fail a frame that is fast (frame-perf.test.js does the same for the whole frame).
describe('perf: 20 creatures x 600 updates on a real chunk cache and grid reader', () => {
  it('runs under 150 ms (the better of two runs), returns the same threat object, and asks getChunk at most once per border crossed', () => {
    const cfg = { chunkEvictRadius: 3, maze: { corridor: 1 }, entities: { enabled: false, damage: 16 } }
    const cache = createChunkCache(cfg, 0)
    let gets = 0
    const counting = { getChunk: (cx, cy, pcx, pcy) => { gets++; return cache.getChunk(cx, cy, pcx, pcy) }, isWall: cache.isWall, preload: cache.preload, epochOf: cache.epochOf }
    const isWall = (wx, wy, pcx, pcy) => cache.isWall(wx, wy, pcx, pcy)
    const grid0 = createGridReader(counting, isWall)
    let crossings = 0, lcx = NaN, lcy = NaN
    const grid = {
      floor: (ix, iy) => { const cx = Math.floor(ix / N), cy = Math.floor(iy / N); if (cx !== lcx || cy !== lcy) { crossings++; lcx = cx; lcy = cy } return grid0.floor(ix, iy) },
      setPlayerChunk: grid0.setPlayerChunk,
    }
    const obstacles = { blocked: (x, y) => !grid.floor(Math.floor(x), Math.floor(y)), radiusFor: creatureRadius }
    const sys = createEntitySystem(cfg, isWall, { grid, obstacles, now: () => 0 })
    const g = cache.getChunk(0, 0, 0, 0)
    // 20 creatures on open cells well inside chunk (0,0)
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
    const ctx = mkCtx(player, { dark: true, flashlight: true })
    const th = sys.getThreat()
    let same = true                                           // tracked, not asserted, inside the timed loop
    function run() {
      const t0 = performance.now()
      for (let i = 0; i < 600; i++) {
        player.angle += 0.01
        if (i % 27 === 0) sys.noise(player.x, player.y, 7)
        if (i % 200 === 199) sys.ward(player)
        if (sys.update(DT, player, 0, 0, ctx) !== th) same = false
      }
      return performance.now() - t0
    }
    gets = 0; crossings = 0
    const ms1 = run(), ms2 = run()
    const best = Math.min(ms1, ms2)
    expect(same, 'update() returns the one threat record every frame').toBe(true)
    expect(best, `600 updates took ${ms1.toFixed(1)} / ${ms2.toFixed(1)} ms`).toBeLessThan(150)
    expect(gets).toBeLessThanOrEqual(crossings + 1)
    for (const e of list) expect(g[Math.floor(e.y) * N + Math.floor(e.x)] === 0 || Math.floor(e.x / N) !== 0 || Math.floor(e.y / N) !== 0).toBe(true)
  })
})

describe('the legacy path is byte-for-byte the old stepper', () => {
  // the old entities.js stepEntity / moveEntity, copied: the gate must leave these trajectories untouched
  function oldMove(e, speed, dt, isWallFn, playerCx, playerCy) {
    const nx = e.x + Math.cos(e.dir) * speed * dt
    const ny = e.y + Math.sin(e.dir) * speed * dt
    const origX = e.x, origY = e.y
    const canX = !isWallFn(Math.floor(nx), Math.floor(origY), playerCx, playerCy)
    const canY = !isWallFn(Math.floor(origX), Math.floor(ny), playerCx, playerCy)
    if (canX) e.x = nx; else e.dir += Math.PI * 0.5
    if (canY) e.y = ny; else e.dir -= Math.PI * 0.5
  }
  function oldStep(e, dt, player, isWallFn, playerCx, playerCy, aggroMul = 1, chaseRange = 24, fleeRange = 6) {
    const dx = player.x - e.x, dy = player.y - e.y
    const dist = Math.sqrt(dx * dx + dy * dy)
    if (e.stagger > 0) { e.stagger = Math.max(0, e.stagger - dt); e.state = 'stagger'; e.dir = Math.atan2(-dy, -dx); oldMove(e, 1.8, dt, isWallFn, playerCx, playerCy); return }
    if (e.type === 'wanderer') e.state = dist < fleeRange ? 'flee' : 'idle'
    else e.state = dist < chaseRange * aggroMul ? 'chase' : 'idle'
    let speed
    if (e.type === 'stalker' && e.state === 'chase') { speed = 1.2; e.dir = Math.atan2(dy, dx) }
    else if (e.type === 'wanderer' && e.state === 'flee') { speed = 1.0; e.dir = Math.atan2(-dy, -dx); e.dirTimer = 0.5 }
    else {
      speed = e.type === 'stalker' ? 0.4 : 0.8
      e.dirTimer -= dt
      if (e.dirTimer <= 0) { e.dir = ((e.dir + 1.3 + (e.x * 7 + e.y * 13) % 2.0)) % (Math.PI * 2); e.dirTimer = 3 + ((Math.abs(e.x * 17 + e.y * 31) % 4)) }
    }
    oldMove(e, speed, dt, isWallFn, playerCx, playerCy)
  }
  it('500 random frames: identical x / y / dir / state / stagger, with a maze and a ward in the middle', () => {
    let s = 0xC0FFEE
    const rnd = () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 0xffffffff }
    const h = (ix, iy) => { let v = (ix * 374761393 + iy * 668265263) | 0; v = Math.imul(v ^ (v >>> 13), 1274126177); return ((v ^ (v >>> 16)) >>> 0) / 4294967296 }
    const isWall = (ix, iy) => h(ix, iy) < 0.22
    const mk = (i) => ({ x: 10 + i * 3.1, y: 10 + (i % 3) * 2.7, type: i % 2 ? 'stalker' : 'wanderer', state: 'idle', dir: i * 0.9, dirTimer: 1 + i * 0.4, stagger: i === 4 ? 1.3 : 0, wardHits: 0, chunkCx: 0, chunkCy: 0 })
    const sys = createEntitySystem(quiet, isWall)
    const live = [], ref = []
    for (let i = 0; i < 6; i++) { live.push(mk(i)); ref.push(mk(i)) }
    sys.getEntities().push(...live)
    const player = { x: 12, y: 12, angle: 0 }
    for (let f = 0; f < 500; f++) {
      const dt = 0.01 + rnd() * 0.04
      player.x += (rnd() - 0.5) * 0.6; player.y += (rnd() - 0.5) * 0.6; player.angle += (rnd() - 0.5)
      const mul = f % 7 === 0 ? 1.5 : undefined
      if (f === 250) {
        // a ward on both sides: the old knockback and stagger (default opts, shade spec == the old numbers)
        sys.ward(player)
        for (const e of ref) {
          const dx = e.x - player.x, dy = e.y - player.y, d = Math.sqrt(dx * dx + dy * dy)
          if (d > 2.6) continue
          let a = Math.atan2(dy, dx) - player.angle; a = Math.atan2(Math.sin(a), Math.cos(a))
          if (Math.abs(a) > Math.PI * 0.35) continue
          const ux = d > 1e-6 ? dx / d : Math.cos(player.angle), uy = d > 1e-6 ? dy / d : Math.sin(player.angle)
          const kx = e.x + ux * 1.7, ky = e.y + uy * 1.7
          if (!isWall(Math.floor(kx), Math.floor(e.y))) e.x = kx
          if (!isWall(Math.floor(e.x), Math.floor(ky))) e.y = ky
          e.stagger = 2.6; e.wardHits++
        }
      }
      if (mul === undefined) sys.update(dt, player, 0, 0); else sys.update(dt, player, 0, 0, mul)
      for (const e of ref) oldStep(e, dt, player, isWall, 0, 0, mul ?? 1)
      for (let i = 0; i < 6; i++) {
        expect(live[i].x).toBe(ref[i].x); expect(live[i].y).toBe(ref[i].y); expect(live[i].dir).toBe(ref[i].dir)
        expect(live[i].state).toBe(ref[i].state); expect(live[i].stagger).toBe(ref[i].stagger)
      }
    }
  })
})
