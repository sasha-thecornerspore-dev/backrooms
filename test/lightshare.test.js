import { describe, it, expect } from 'vitest'
import { existsSync } from 'node:fs'
import { LIT_RANGE, LIT_RANGE_NO_LOS, litFriendNear, inCone, wardOutcome, wardLine, litOffLine } from '../src/renderer/lightshare.js'
import { WARD_TAP } from '../src/renderer/ward.js'
import { createEntitySystem } from '../src/renderer/entities.js'

// the bus gates run against W1's evbus.js as built; skipped where wi/W1 is not merged yet (contract: test-only imports are baseline)
const HAS_BUS = existsSync(new URL('../src/net/evbus.js', import.meta.url))
const evbus = HAS_BUS ? await import('../src/net/evbus.js') : null

const PI = Math.PI
const at = (wx, wy, a, d) => ({ x: wx + Math.cos(a) * d, y: wy + Math.sin(a) * d })

// a peer record as bus.freshPeersOnFloor() hands it out (evbus.js seat(): no position on it)
const rec = (id, over = {}) => ({ id, name: id, lvl: 1, lit: true, st: 'ok', seen: false, o: null, thin: false, status: 'notice-mailed', aseed: null, seenAt: 0, legacy: false, ...over })
const posMap = (m) => (id) => m[id] ?? null

describe('inCone — the receiver-side mirror of entities.js ward()', () => {
  const W = { x: 10, y: 10, a: 0 }

  it('a self 2.0 u straight ahead is in', () => {
    expect(inCone(W, { x: 12, y: 10 })).toBe(true)
  })

  it('2.0 u at +0.3π and −0.3π are in', () => {
    expect(inCone(W, at(10, 10, 0.3 * PI, 2))).toBe(true)
    expect(inCone(W, at(10, 10, -0.3 * PI, 2))).toBe(true)
  })

  it('exactly 0.35π is in (entities.js `if (Math.abs(a) > halfCone) continue`: equality is IN)', () => {
    // self on the ward's +x axis, the ward turned so the offset is exactly half the arc on either side
    expect(inCone({ x: 10, y: 10, a: -0.35 * PI }, { x: 12, y: 10 })).toBe(true)
    expect(inCone({ x: 10, y: 10, a: 0.35 * PI }, { x: 12, y: 10 })).toBe(true)
  })

  it('0.36π is out', () => {
    expect(inCone(W, at(10, 10, 0.36 * PI, 2))).toBe(false)
    expect(inCone(W, at(10, 10, -0.36 * PI, 2))).toBe(false)
  })

  it('2.8 u ahead is out of range; 2.0 u behind is out of the arc', () => {
    expect(inCone(W, { x: 12.8, y: 10 })).toBe(false)
    expect(inCone(W, { x: 8, y: 10 })).toBe(false)
  })

  it('the defaults are WARD_TAP.range / WARD_TAP.cone', () => {
    const grid = []
    for (const d of [1, 2, 2.59, 2.61, 3.4]) for (let k = 0; k < 24; k++) grid.push(at(10, 10, -PI + k * PI / 12, d))
    for (const s of grid) expect(inCone(W, s)).toBe(inCone(W, s, { range: WARD_TAP.range, arc: WARD_TAP.cone }))
    expect(inCone(W, { x: 13, y: 10 }, { range: 4 })).toBe(true)        // the options are honoured
    expect(inCone(W, at(10, 10, 0.3 * PI, 2), { arc: 0.4 * PI })).toBe(false)
  })

  it('cross-check: for every cell of the grid the core ward hits exactly where inCone says', () => {
    for (const a0 of [0, 0.123456, 1.9, -2.7]) {
      for (const d of [1.0, 2.0, 2.59, 2.61, 3.4]) {
        for (let k = 0; k <= 24; k++) {
          const off = -PI + k * (2 * PI / 24)
          const ex = 10 + Math.cos(a0 + off) * d, ey = 10 + Math.sin(a0 + off) * d
          const sys = createEntitySystem({ chunkEvictRadius: 3 }, () => false)
          sys.getEntities().push({ x: ex, y: ey, type: 'stalker', state: 'chase', dir: 0, dirTimer: 99, stagger: 0, wardHits: 0, chunkCx: 0, chunkCy: 0 })
          const hit = sys.ward({ x: 10, y: 10, angle: a0 }, WARD_TAP).hit > 0
          expect(inCone({ x: 10, y: 10, a: a0 }, { x: ex, y: ey })).toBe(hit)
          // the wire rounds the angle (+a.toFixed(2)); the verdict does not move on this grid
          expect(inCone({ x: 10, y: 10, a: +a0.toFixed(2) }, { x: ex, y: ey })).toBe(hit)
        }
      }
    }
  })
})

describe('litFriendNear — a friend whose light reaches you', () => {
  const self = { x: 10, y: 10 }
  const yes = () => true, no = () => false

  it('no peers -> null', () => {
    expect(litFriendNear(self, [], { pos: posMap({}), los: yes })).toBe(null)
  })

  it('an unlit, a legacy and a position-less record never count', () => {
    const pos = posMap({ a: { x: 12, y: 10 }, b: { x: 12, y: 10 } })
    expect(litFriendNear(self, [rec('a', { lit: false })], { pos, los: yes })).toBe(null)
    expect(litFriendNear(self, [rec('a', { legacy: true })], { pos, los: yes })).toBe(null)
    expect(litFriendNear(self, [rec('c')], { pos, los: yes })).toBe(null)
  })

  it('a lit fresh record at 5 u with a clear line -> that record (identity); 6.5 u -> null; a wall between -> null', () => {
    const r = rec('a')
    expect(litFriendNear(self, [r], { pos: posMap({ a: { x: 15, y: 10 } }), los: yes })).toBe(r)
    expect(litFriendNear(self, [r], { pos: posMap({ a: { x: 16.5, y: 10 } }), los: yes })).toBe(null)
    expect(litFriendNear(self, [r], { pos: posMap({ a: { x: 15, y: 10 } }), los: no })).toBe(null)
  })

  it('exactly LIT_RANGE is in; the defaults are LIT_RANGE 6 and LIT_RANGE_NO_LOS 4', () => {
    expect(LIT_RANGE).toBe(6)
    expect(LIT_RANGE_NO_LOS).toBe(4)
    const r = rec('a')
    expect(litFriendNear(self, [r], { pos: posMap({ a: { x: 16, y: 10 } }), los: yes })).toBe(r)
    expect(litFriendNear(self, [r], { cells: 3, pos: posMap({ a: { x: 14, y: 10 } }), los: yes })).toBe(null)
  })

  it('without the line-of-sight primitive the light reaches only 4 cells', () => {
    const r = rec('a')
    expect(litFriendNear(self, [r], { pos: posMap({ a: { x: 15, y: 10 } }) })).toBe(null)
    expect(litFriendNear(self, [r], { pos: posMap({ a: { x: 13.5, y: 10 } }) })).toBe(r)
    expect(litFriendNear(self, [r], { pos: posMap({ a: { x: 13.5, y: 10 } }), los: null })).toBe(r)
  })

  it('the los primitive is asked with (self, friend) coordinates', () => {
    const calls = []
    const los = (ax, ay, bx, by) => { calls.push([ax, ay, bx, by]); return true }
    litFriendNear(self, [rec('a')], { pos: posMap({ a: { x: 13, y: 11 } }), los })
    expect(calls).toEqual([[10, 10, 13, 11]])
  })

  it('the nearer of two lit peers wins; equal distance keeps the first', () => {
    const a = rec('a'), b = rec('b')
    const pos = posMap({ a: { x: 14, y: 10 }, b: { x: 12, y: 10 } })
    expect(litFriendNear(self, [a, b], { pos, los: yes })).toBe(b)
    const pos2 = posMap({ a: { x: 12, y: 10 }, b: { x: 8, y: 10 } })
    expect(litFriendNear(self, [a, b], { pos: pos2, los: yes })).toBe(a)
  })

  it('a thousand calls allocate no new result: the return is always one of the input records', () => {
    const peers = [rec('a'), rec('b'), rec('c', { lit: false })]
    const pos = posMap({ a: { x: 13, y: 10 }, b: { x: 11, y: 10 }, c: { x: 10.5, y: 10 } })
    for (let i = 0; i < 1000; i++) {
      const r = litFriendNear(self, peers, { pos, los: yes })
      expect(r).toBe(peers[1])
    }
  })

  it('peers is read by index (an array-like with .length works)', () => {
    const a = rec('a')
    const like = { length: 1, 0: a }
    expect(litFriendNear(self, like, { pos: posMap({ a: { x: 12, y: 10 } }), los: yes })).toBe(a)
  })

  it('legacy identity: the frozen EMPTY list (game.js `const EMPTY = []`) -> null for any player', () => {
    const EMPTY = []
    const LIT_OPTS = { cells: LIT_RANGE, los: yes, pos: () => ({ x: 0, y: 0 }) }
    for (const p of [{ x: 0, y: 0 }, { x: 10, y: -3 }, { x: 1e6, y: 2.5 }]) expect(litFriendNear(p, EMPTY, LIT_OPTS)).toBe(null)
    expect(litFriendNear(self, EMPTY)).toBe(null)
  })
})

describe('wardOutcome / wardLine / litOffLine', () => {
  const R = (hit, dispelled) => ({ hit, dispelled, opening: 0 })

  it('the outcome table', () => {
    expect(wardOutcome(true, R(1, 0))).toBe('steadied')
    expect(wardOutcome(true, R(0, 1))).toBe('steadied')
    expect(wardOutcome(true, R(0, 0))).toBe('nothing')
    expect(wardOutcome(false, R(1, 0))).toBe('elsewhere')
    expect(wardOutcome(false, R(0, 1))).toBe('elsewhere')
    expect(wardOutcome(false, R(0, 0))).toBe('silent')
  })

  it('the lines, exact', () => {
    expect(wardLine('steadied', 'moss', R(1, 0))).toBe('moss pushes the dark off you.')
    expect(wardLine('nothing', 'moss', R(0, 0))).toBe('moss pushes at the dark near you. it gives nothing back.')
    expect(wardLine('elsewhere', 'moss', R(1, 0))).toBe('it recoils from moss.')
    expect(wardLine('elsewhere', 'moss', R(2, 0))).toBe('they recoil from moss.')
    expect(wardLine('elsewhere', 'moss', R(1, 1))).toBe("it comes apart in moss's light.")
    expect(wardLine('elsewhere', 'moss', R(2, 2))).toBe("they come apart in moss's light.")
    expect(wardLine('silent', 'moss', R(0, 0))).toBe(null)
  })

  it('litOffLine: null is game.js\'s L line byte for byte; a name stands you in their light', () => {
    expect(litOffLine(null)).toBe('flashlight off — the dark leans in.')
    expect(litOffLine('moss')).toBe("flashlight off — you stand in moss's light.")
  })
})

describe.skipIf(!HAS_BUS)('the bus gates for ward (evbus.js as built)', () => {
  function mk() {
    let t = 0
    const where = { a: { x: 10, y: 10 }, b: { x: 10, y: 10 }, c: { x: 10, y: 10 } }
    const bus = evbus.createEvBus({
      send: () => {}, now: () => t, self: () => ({ x: 10, y: 10, lvl: 1 }),
      peerPos: (id) => where[id] ?? null, peerIds: () => new Set(Object.keys(where)), selfId: 'me',
    })
    bus.register('ward', { check: (p) => Number.isInteger(p.lvl) && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.a), posKeys: ['x', 'y'], minGapMs: 600 })
    const got = []
    bus.on('ward', (ev) => got.push(ev))
    let n = 0
    const send = (id, payload, extra = {}) => bus.receive({ kind: 'ward', id, name: id, payload: { n: n++, ...payload }, ...extra })
    return { bus, got, send, setT: (v) => { t = v } }
  }
  const P = { x: 10, y: 10, a: 0.5, lvl: 1 }

  it('one per 600 ms per sender: 400 ms after -> dropped and the handler silent; 700 ms -> delivered', () => {
    const { got, send, setT } = mk()
    setT(1000); expect(send('a', P)).toBe(true)
    setT(1400); expect(send('a', P)).toBe(false)
    expect(got.length).toBe(1)
    setT(1700); expect(send('a', P)).toBe(true)
    expect(got.length).toBe(2)
    expect(got[1].payload.a).toBe(0.5)
  })

  it('you cannot ward from where you are not: 3 cells off the list position -> dropped, 1.5 -> delivered', () => {
    expect(evbus.POS_SLACK).toBe(2.0)
    const { got, send } = mk()
    expect(send('a', { ...P, x: 13 })).toBe(false)
    expect(send('b', { ...P, x: 11.5 })).toBe(true)
    expect(got.map((e) => e.id)).toEqual(['b'])
  })

  it('a self-addressed ward and a replayed ward are dropped', () => {
    const { got, send } = mk()
    expect(send('me', P)).toBe(false)
    expect(send('a', P, { replay: true })).toBe(false)
    expect(got.length).toBe(0)
  })

  it('a payload whose lvl is 2.5 or whose a is NaN fails check', () => {
    const { got, send } = mk()
    expect(send('a', { ...P, lvl: 2.5 })).toBe(false)
    expect(send('b', { ...P, a: NaN })).toBe(false)
    expect(got.length).toBe(0)
  })
})
