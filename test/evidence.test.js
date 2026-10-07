import { describe, it, expect } from 'vitest'
import { existsSync } from 'node:fs'
import {
  SUBJECT_RANGE, SOUL_RANGE, SUBJECT_RANGE_NO_LOS, FACING_ME, EVIDENCE_WINDOW_S, EVIDENCE_FLOOR, EVIDENCE_LINE, COUNTED_LINE,
  inFrame, subjectInFrame, createEvidence, photoOutcome,
} from '../src/renderer/evidence.js'
import { inViewCone } from '../src/renderer/raycaster.js'
import { HF } from '../src/renderer/gfx-frame.js'
import { createItemSystem } from '../src/renderer/items.js'

// the bus gates run against W1's evbus.js as built; skipped where wi/W1 is not merged yet (contract: test-only imports are baseline)
const HAS_BUS = existsSync(new URL('../src/net/evbus.js', import.meta.url))
const evbus = HAS_BUS ? await import('../src/net/evbus.js') : null

const SELF = { x: 10, y: 10, angle: 0 }
const off = (a, d) => [SELF.x + Math.cos(a) * d, SELF.y + Math.sin(a) * d]
const yes = () => true, no = () => false
const rec = (id, over = {}) => ({ id, name: id, lvl: 1, lit: false, st: 'ok', seen: false, o: null, thin: false, status: 'notice-mailed', aseed: null, seenAt: 0, legacy: false, ...over })
const posMap = (m) => (id) => m[id] ?? null

describe('the constants', () => {
  it('ranges, window, floor and lines', () => {
    expect([SUBJECT_RANGE, SOUL_RANGE, SUBJECT_RANGE_NO_LOS, FACING_ME]).toEqual([10, 10, 6, 0.6])
    expect([EVIDENCE_WINDOW_S, EVIDENCE_FLOOR]).toEqual([90, 25])
    expect(EVIDENCE_LINE).toBe('someone has evidence of you. you are harder to erase.')
    expect(COUNTED_LINE).toBe('someone has evidence of you. you are counted.')
  })
})

describe('inFrame — the sprite cull is the camera frame', () => {
  it('uses the real inViewCone with HF by default (HF 0.6545)', () => {
    expect(HF).toBeCloseTo(0.6545, 4)
    expect(inFrame(SELF, ...off(0, 5), { los: yes })).toBe(true)
    expect(inFrame(SELF, ...off(0.5, 5), { los: yes })).toBe(true)
    expect(inFrame(SELF, ...off(0.7, 5), { los: yes })).toBe(true)     // lat 3.22 <= 4.39: not an angular cone
    expect(inFrame(SELF, ...off(-0.7, 5), { los: yes })).toBe(true)
    expect(inFrame(SELF, ...off(1.0, 5), { los: yes })).toBe(false)    // lat 4.21 > 3.34
    expect(inFrame(SELF, ...off(0, 0.2), { los: yes })).toBe(false)    // fwd < 0.35
    expect(inFrame(SELF, ...off(0, 12), { los: yes })).toBe(false)     // reach 10
  })

  it('agrees with inViewCone at reach 10 over a grid', () => {
    for (let d = 0.5; d < 12; d += 0.75) for (let a = -1.5; a <= 1.5; a += 0.1) {
      const [x, y] = off(a, d)
      expect(inFrame(SELF, x, y, { los: yes })).toBe(inViewCone(SELF.x, SELF.y, SELF.angle, x, y, HF, SUBJECT_RANGE))
    }
  })

  it('a wall between -> false; without the los primitive the reach is 6', () => {
    expect(inFrame(SELF, ...off(0, 5), { los: no })).toBe(false)
    expect(inFrame(SELF, ...off(0, 8))).toBe(false)
    expect(inFrame(SELF, ...off(0, 5))).toBe(true)
    expect(inFrame(SELF, ...off(0, 8), { los: null })).toBe(false)
  })

  it('the cone and the los are injectable; los sees (self, target)', () => {
    const calls = []
    expect(inFrame(SELF, 99, 99, { cone: yes, los: (...a) => { calls.push(a); return true } })).toBe(true)
    expect(calls).toEqual([[10, 10, 99, 99]])
    expect(inFrame(SELF, ...off(0, 5), { cone: no, los: yes })).toBe(false)
    expect(inFrame(SELF, ...off(0, 9), { maxCells: 8, los: yes })).toBe(false)
  })
})

describe('subjectInFrame — the friend the polaroid is pointed at', () => {
  it('the nearest of two fresh peers ahead, flattened', () => {
    const near = rec('a', { name: 'moss' }), far = rec('b')
    const pos = posMap({ a: { x: 14, y: 10, angle: 0 }, b: { x: 17, y: 10, angle: 0 } })
    const s = subjectInFrame(SELF, [far, near], { pos, los: yes })
    expect(s).not.toBe(null)
    expect(s.id).toBe('a')
    expect(s.name).toBe('moss')
    expect(s.dist).toBe(4)
    expect(s.x).toBe(14)
    expect(s.y).toBe(10)
  })

  it('carries st / thin / seen / status / aseed from the record and origin from rec.o', () => {
    const r = rec('a', { st: 'down', thin: true, seen: true, status: 'extension', aseed: 77, o: 'tenant' })
    const s = subjectInFrame(SELF, [r], { pos: posMap({ a: { x: 13, y: 10 } }), los: yes })
    expect(s.st).toBe('down')
    expect(s.thin).toBe(true)
    expect(s.seen).toBe(true)
    expect(s.status).toBe('extension')
    expect(s.aseed).toBe(77)
    expect(s.origin).toBe('tenant')
  })

  it('facingMe: looking back within 0.6 rad -> true; facing away or no angle -> false', () => {
    const r = rec('a')
    const at = (angle) => subjectInFrame(SELF, [r], { pos: posMap({ a: { x: 14, y: 10, angle } }), los: yes }).facingMe
    expect(at(Math.PI)).toBe(true)
    expect(at(Math.PI - 0.5)).toBe(true)
    expect(at(-Math.PI + 0.5)).toBe(true)
    expect(at(Math.PI - 0.7)).toBe(false)
    expect(at(0)).toBe(false)
    expect(subjectInFrame(SELF, [r], { pos: posMap({ a: { x: 14, y: 10 } }), los: yes }).facingMe).toBe(false)
  })

  it('a legacy record and a position-less record are skipped; out of frame -> null', () => {
    const pos = posMap({ a: { x: 13, y: 10 }, c: { x: 10, y: 15 } })
    expect(subjectInFrame(SELF, [rec('a', { legacy: true })], { pos, los: yes })).toBe(null)
    expect(subjectInFrame(SELF, [rec('b')], { pos, los: yes })).toBe(null)
    expect(subjectInFrame(SELF, [rec('c')], { pos, los: yes })).toBe(null)        // at 90 degrees: not in frame
    expect(subjectInFrame(SELF, [rec('a')], { pos, los: no })).toBe(null)
    const s = subjectInFrame(SELF, [rec('a', { legacy: true }), rec('b'), rec('c'), rec('a')], { pos, los: yes })
    expect(s.id).toBe('a')
  })

  it('two consecutive finds return the SAME object (callers copy what they keep)', () => {
    const pos = posMap({ a: { x: 13, y: 10 }, b: { x: 15, y: 10 } })
    const s1 = subjectInFrame(SELF, [rec('a')], { pos, los: yes })
    const s2 = subjectInFrame(SELF, [rec('b')], { pos, los: yes })
    expect(s2).toBe(s1)
    expect(s2.id).toBe('b')
    expect(s2.dist).toBe(5)
  })

  it('W4 reads only this shape: the frozen key list', () => {
    const s = subjectInFrame(SELF, [rec('a')], { pos: posMap({ a: { x: 13, y: 10 } }), los: yes })
    expect(Object.keys(s)).toEqual(['id', 'name', 'x', 'y', 'dist', 'facingMe', 'st', 'thin', 'seen', 'origin', 'status', 'aseed'])
  })

  it('peers is read by index; pos() is not retained', () => {
    const q = { x: 13, y: 10, angle: Math.PI }
    const s = subjectInFrame(SELF, { length: 1, 0: rec('a') }, { pos: () => q, los: yes })
    q.x = 99
    expect(s.x).toBe(13)
    expect(s.facingMe).toBe(true)
  })
})

describe('createEvidence — harder to erase, for a while', () => {
  it('fresh: never active, no floor (legacy identity: the floor line is a no-op)', () => {
    const ev = createEvidence()
    expect(ev.active(0)).toBe(false)
    expect(ev.floorAt(0)).toBe(0)
    expect(ev.until()).toBe(-Infinity)
    expect(ev.by()).toBe(null)
    for (const t of [-1e9, 0, 1, 90, 1e9]) expect(ev.floorAt(t)).toBe(0)
  })

  it('a photo holds the floor at 25 for 90 s of playT (strict end)', () => {
    const ev = createEvidence()
    ev.seen('a', 0)
    expect(ev.floorAt(30)).toBe(25)
    expect(ev.active(89.9)).toBe(true)
    expect(ev.active(90)).toBe(false)
    expect(ev.active(91)).toBe(false)
    expect(ev.floorAt(90)).toBe(0)
    expect(ev.until()).toBe(90)
    expect(ev.by()).toBe('a')
  })

  it('a second photo refreshes the window and the photographer, never stacks', () => {
    const ev = createEvidence()
    ev.seen('a', 0); ev.seen('b', 60)
    expect(ev.active(149)).toBe(true)
    expect(ev.active(150)).toBe(false)
    expect(ev.by()).toBe('b')
    const ev2 = createEvidence()
    for (let i = 0; i < 10; i++) ev2.seen('x' + i, 5)
    expect(ev2.floorAt(6)).toBe(25)
    expect(ev2.until()).toBe(95)
  })

  it('{ windowS, floor } are honoured', () => {
    const ev = createEvidence({ windowS: 10, floor: 40 })
    ev.seen('a', 100)
    expect(ev.floorAt(105)).toBe(40)
    expect(ev.active(110)).toBe(false)
  })

  it('photoOutcome compares the string: only down is counted', () => {
    expect(photoOutcome('down')).toBe('counted')
    expect(photoOutcome('ok')).toBe('evidence')
    expect(photoOutcome('kneel')).toBe('evidence')
    expect(photoOutcome(undefined)).toBe('evidence')
  })
})

describe('the camera is always consumed (items.js useSelected)', () => {
  it('a selected polaroid leaves the inventory before any caption branch runs', () => {
    const items = createItemSystem({ items: { density: 0, types: [] } }, () => false)
    items.inventory.push({ type: 'polaroid' })
    items.select(0)
    expect(items.useSelected()).toEqual({ type: 'polaroid' })
    expect(items.inventory.length).toBe(0)
  })
})

describe('legacy identity', () => {
  it('the frozen EMPTY list -> no subject for any player', () => {
    const EMPTY = []
    const FRAME_OPTS = { pos: () => ({ x: 0, y: 0 }), cone: inViewCone, hf: HF, maxCells: SUBJECT_RANGE, los: yes }
    for (const p of [SELF, { x: 0, y: 0, angle: 2 }, { x: -40, y: 7, angle: -1 }]) expect(subjectInFrame(p, EMPTY, FRAME_OPTS)).toBe(null)
    expect(subjectInFrame(SELF, EMPTY)).toBe(null)
  })
})

describe.skipIf(!HAS_BUS)('the bus gates for photo (evbus.js as built)', () => {
  function mk() {
    let t = 0
    const where = { near: { x: 19, y: 10 }, far: { x: 22, y: 10 }, a: { x: 12, y: 10 }, b: { x: 12, y: 10 }, c: { x: 12, y: 10 } }
    const bus = evbus.createEvBus({
      send: () => {}, now: () => t, self: () => ({ x: 10, y: 10, lvl: 1 }),
      peerPos: (id) => where[id] ?? null, peerIds: () => new Set(Object.keys(where)), selfId: 'me',
    })
    bus.register('photo', { check: (p) => p.of === 'me' && Number.isInteger(p.lvl), maxDist: 11, minGapMs: 4000 })
    const got = []
    bus.on('photo', (ev) => got.push(ev))
    let n = 0
    const send = (id, payload) => bus.receive({ kind: 'photo', id, name: id, payload: { n: n++, x: 0, y: 0, ...payload } })
    return { got, send, setT: (v) => { t = v } }
  }

  it('a photo of someone else is dropped', () => {
    const { got, send } = mk()
    expect(send('a', { of: 'you', lvl: 1 })).toBe(false)
    expect(got.length).toBe(0)
  })

  it('the sender must be within 11 u by the list: 12 u -> dropped, 9 u -> delivered', () => {
    const { got, send } = mk()
    expect(send('far', { of: 'me', lvl: 1 })).toBe(false)
    expect(send('near', { of: 'me', lvl: 1 })).toBe(true)
    expect(got.map((e) => e.id)).toEqual(['near'])
  })

  it('one photo of me per sender per 4 s (believed from 3 s: the inbound slack, evbus IN_GAP), measured from the last accepted frame', () => {
    const { got, send, setT } = mk()
    setT(0); expect(send('a', { of: 'me', lvl: 1 })).toBe(true)
    setT(2900); expect(send('a', { of: 'me', lvl: 1 })).toBe(false)
    setT(4100); expect(send('a', { of: 'me', lvl: 1 })).toBe(true)
    expect(got.length).toBe(2)
  })

  it('lvl 1.5 and a self-addressed sender are dropped', () => {
    const { got, send } = mk()
    expect(send('b', { of: 'me', lvl: 1.5 })).toBe(false)
    expect(send('me', { of: 'me', lvl: 1 })).toBe(false)
    expect(got.length).toBe(0)
  })
})
