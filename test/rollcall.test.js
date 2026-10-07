// rollcall.js (W5): the roll call the whistle takes, the company pool, and the pure helpers the integrator wires the whistle with —
// pitch per player, the chat bearing, the gain and the pan, the count line, and the three 'ev' registration specs as data.
import { describe, it, expect } from 'vitest'
import { existsSync } from 'node:fs'
import {
  createRollCall, createCompany, whistlePitch, bearingLabel, whistleGain, whistlePan, countLine, evKinds,
  SEMIS, FAR_CELLS, WORDS, WHISTLE_COOLDOWN_MS, WHISTLE_NOISE, QUIET_SANITY, SOLO_SANITY, FAR_BONUS, ECHO, COMPANY,
  NO_ANSWER_LINE, ECHO_LINE, UNANSWERED_LINE,
} from '../src/renderer/rollcall.js'
import { exitArrow } from '../src/renderer/compass.js'

const moss = { id: 'p1', name: 'moss' }
const mk = (o = {}) => createRollCall({ now: () => 0, ...o })

describe('createRollCall: the quiet', () => {
  it("a peer last touched 91 s ago yields one 'quiet' effect with the exact line; 89 s yields none", () => {
    const rc = mk()
    rc.tick(-5000, [moss])                       // seated silently
    rc.touch('p1', -1000)
    expect(rc.tick(88000, [moss])).toHaveLength(0)           // 89 s
    const fx = rc.tick(90000, [moss])                          // 91 s
    expect(fx).toHaveLength(1)
    expect(fx[0]).toEqual({ type: 'quiet', id: 'p1', name: 'moss', line: 'it has been a while since moss. the hall is quiet.' })
  })
  it('the effect re-arms: not again half a second later, again a quiet span after the last one (180 s)', () => {
    const rc = mk()
    rc.tick(-5000, [moss]); rc.touch('p1', -1000)
    expect(rc.tick(90000, [moss])).toHaveLength(1)
    expect(rc.tick(90500, [moss])).toHaveLength(0)
    expect(rc.tick(180000, [moss])).toHaveLength(0)            // exactly 90 s since the re-arm: not yet
    expect(rc.tick(180001, [moss])).toHaveLength(1)
  })
  it('a peer seen by tick for the first time is seated and says nothing', () => {
    const rc = mk()
    expect(rc.tick(500000, [moss])).toHaveLength(0)
    expect(rc.tick(589000, [moss])).toHaveLength(0)
    expect(rc.tick(590001, [moss])).toHaveLength(1)
  })
  it('a peer absent from the list is exempt: no effect, no re-seat, and fires when it returns if its clock ran out', () => {
    const rc = mk()
    rc.tick(0, [moss])
    expect(rc.tick(100000, [])).toHaveLength(0)                // another floor / stale: exempt
    expect(rc.tick(200000, [])).toHaveLength(0)
    const fx = rc.tick(200500, [moss])                         // back: its clock ran out while away, no re-seat
    expect(fx).toHaveLength(1); expect(fx[0].id).toBe('p1')
  })
  it('the returned array is the same reference every call and empty with an empty list', () => {
    const rc = mk()
    const a = rc.tick(0, [moss]), b = rc.tick(1, [])
    expect(a).toBe(b); expect(b).toHaveLength(0)
    rc.tick(100000, [moss])
    expect(rc.tick(100001, [])).toHaveLength(0)
  })
  it('a record unseen in a list for 10 min is dropped (it seats afresh when it returns)', () => {
    const rc = mk()
    rc.tick(0, [moss])
    rc.tick(600001, [])                                        // dropped
    expect(rc.tick(600002, [moss])).toHaveLength(0)            // seated again, silently
    const rc2 = mk()
    rc2.tick(0, [moss])
    rc2.tick(599000, [])                                       // kept
    expect(rc2.tick(599001, [moss])).toHaveLength(1)
  })
  it('tick defaults its clock to now()', () => {
    let t = 0
    const rc = createRollCall({ now: () => t })
    rc.tick(undefined, [moss]); t = 90001
    expect(rc.tick(undefined, [moss])).toHaveLength(1)
  })
})

describe('createRollCall: the count, the far bonus, the echo', () => {
  it('count is 1 with no hears, 3 after two ids heard within 90 s, back to 1 after 90 s; touches never raise it', () => {
    const rc = mk()
    expect(rc.count(0)).toBe(1)
    rc.touch('a', 0); rc.touch('b', 0)
    expect(rc.count(0)).toBe(1)
    rc.hear('a', 'ash', 3, 4, 1000); rc.hear('b', 'moss', 5, 6, 2000); rc.hear('a', 'ash', 3, 4, 3000)
    expect(rc.count(3000)).toBe(3)
    expect(rc.count(92000)).toBe(3)                            // a's last hear 89 s ago, b's 90 s: both still in
    expect(rc.count(92001)).toBe(2)                            // b's ran out
    expect(rc.count(93001)).toBe(1)
  })
  it('farBonusOk is true once per sender per 60 s, independent per id', () => {
    const rc = mk()
    expect(rc.farBonusOk('a', 0)).toBe(true)
    expect(rc.farBonusOk('a', 59000)).toBe(false)
    expect(rc.farBonusOk('b', 59000)).toBe(true)
    expect(rc.farBonusOk('a', 60000)).toBe(true)
    expect(rc.farBonusOk('a', 60001)).toBe(false)
  })
  it('echoRoll with rng 0.1 fires and 0.9 does not', () => {
    expect(mk({ rng: () => 0.1 }).echoRoll()).toBe(true)
    expect(mk({ rng: () => 0.9 }).echoRoll()).toBe(false)
  })
  it('forget drops the record and the far clock', () => {
    const rc = mk()
    rc.hear('a', 'ash', 0, 0, 0); rc.farBonusOk('a', 0)
    rc.forget('a')
    expect(rc.count(1)).toBe(1)
    expect(rc.farBonusOk('a', 1)).toBe(true)
  })
})

describe('whistlePitch', () => {
  it('is deterministic, always one of SEMIS, and two wanderers with different ids differ', () => {
    expect(SEMIS).toEqual([0, 2, 4, 7, 9, 12, 14]); expect(Object.isFrozen(SEMIS)).toBe(true)
    for (const id of ['id1', 'id4', 'solo', 42, null]) {
      const p = whistlePitch(id, 'wanderer')
      expect(SEMIS).toContain(p)
      expect(whistlePitch(id, 'wanderer')).toBe(p)
    }
    expect(whistlePitch('id1', 'wanderer')).not.toBe(whistlePitch('id4', 'wanderer'))
    expect(whistlePitch('id1', 'wanderer')).toBe(7)            // FNV-1a pinned: a pitch never changes between releases
  })
})

describe('bearingLabel, whistleGain, whistlePan', () => {
  it("a friend 5 cells dead ahead reads 'near ↑'; 20 cells 'far', 41 'very far'; the arrow is compass.exitArrow", () => {
    expect(FAR_CELLS).toBe(12)
    expect(bearingLabel(0, -5, -Math.PI / 2)).toBe('near ↑')
    expect(bearingLabel(20, 0, 0)).toBe('far ↑')
    expect(bearingLabel(41, 0, 0)).toBe('very far ↑')
    expect(bearingLabel(11.9, 0, 0).startsWith('near ')).toBe(true)
    expect(bearingLabel(12, 0, 0).startsWith('far ')).toBe(true)
    expect(bearingLabel(39.9, 0, 0).startsWith('far ')).toBe(true)
    for (const [dx, dy, a] of [[3, 4, 0.3], [-2, 7, 2], [-5, -1, -1], [0, 6, 0]]) {
      expect(bearingLabel(dx, dy, a).split(' ').pop()).toBe(exitArrow(Math.atan2(dy, dx) - a))
    }
    expect(bearingLabel(0, 5, 0)).toBe('near →')            // clockwise from straight ahead
  })
  it('whistleGain falls with distance, floors at 0.08 and halves under the radio', () => {
    expect(whistleGain(0, false)).toBe(1)
    expect(whistleGain(40, false)).toBe(0.08)
    expect(whistleGain(400, false)).toBe(0.08)
    expect(whistleGain(20, true)).toBe(0.25)
    expect(whistleGain(-5, false)).toBe(1)
  })
  it('whistlePan is +1 for a friend hard right, -1 hard left, 0 ahead', () => {
    expect(whistlePan(0, 5, 0)).toBeCloseTo(1, 12)
    expect(whistlePan(0, -5, 0)).toBeCloseTo(-1, 12)
    expect(whistlePan(5, 0, 0)).toBe(0)
    expect(whistlePan(5, 0, Math.PI / 2)).toBeCloseTo(-1, 12)   // facing +y, a friend at +x is on your left
  })
})

describe('countLine, WORDS', () => {
  it('WORDS is exported, one..twelve', () => {
    expect(WORDS[1]).toBe('one'); expect(WORDS[2]).toBe('two'); expect(WORDS[7]).toBe('seven'); expect(WORDS[12]).toBe('twelve')
    expect(WORDS.slice(1)).toEqual(['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'])
  })
  it('never a digit', () => {
    expect(countLine(1)).toBe('one. just you.')
    expect(countLine(0)).toBe('one. just you.')
    expect(countLine(2)).toBe('two of you, counting yourself.')
    expect(countLine(7)).toBe('seven of you.')
    expect(countLine(12)).toBe('twelve of you.')
    expect(countLine(13)).toBe('more of you than you can count.')
    for (let n = 0; n <= 40; n++) expect(countLine(n)).not.toMatch(/\d/)
  })
})

describe('constants', () => {
  it('the numbers the pacing pass owns', () => {
    expect(WHISTLE_COOLDOWN_MS).toBe(10000)
    expect(WHISTLE_NOISE).toBe(14)
    expect(QUIET_SANITY).toBe(4)
    expect(SOLO_SANITY).toBe(2)
    expect(FAR_BONUS).toEqual({ cells: 12, sanity: 4, company: 20 }); expect(Object.isFrozen(FAR_BONUS)).toBe(true)
    expect(ECHO).toEqual({ chance: 1 / 6, delayMs: 1200, sanity: 3, footfalls: 2 }); expect(Object.isFrozen(ECHO)).toBe(true)
    expect(COMPANY).toEqual({ max: 60, drain: 3, refill: 0.75, rate: 3 }); expect(Object.isFrozen(COMPANY)).toBe(true)
  })
  it('the lines are lowercase, understated, no exclamation marks', () => {
    expect(NO_ANSWER_LINE).toBe('the hall takes it and gives nothing back.')
    expect(ECHO_LINE).toBe('something whistles back. the pitch is wrong.')
    expect(UNANSWERED_LINE).toBe('nobody has answered yet.')
    for (const l of [NO_ANSWER_LINE, ECHO_LINE, UNANSWERED_LINE, countLine(1), countLine(2), countLine(5), countLine(20)]) {
      expect(l).toBe(l.toLowerCase()); expect(l).not.toContain('!')
    }
  })
})

describe('evKinds', () => {
  const k = evKinds(() => 'me')
  it('whistle: lvl int 0..4, finite x / y, c <= 32 (the boolean the emit sends)', () => {
    expect(k.whistle.check({ x: 1, y: 2, lvl: 3, c: true })).toBe(true)
    expect(k.whistle.check({ x: 1, y: 2, lvl: 0, c: false })).toBe(true)
    expect(k.whistle.check({ x: 1, y: 2, lvl: 5, c: true })).toBe(false)
    expect(k.whistle.check({ x: 1, y: 2, lvl: -1, c: true })).toBe(false)
    expect(k.whistle.check({ x: 1, y: 2, lvl: '3', c: true })).toBe(false)
    expect(k.whistle.check({ x: 1, y: 2, lvl: 2.5, c: true })).toBe(false)
    expect(k.whistle.check({ x: 1, y: 2, lvl: 3 })).toBe(false)
    expect(k.whistle.check({ x: 1, y: 2, lvl: 3, c: 40 })).toBe(false)
    expect(k.whistle.check({ x: NaN, y: 2, lvl: 3, c: true })).toBe(false)
    expect(k.whistle.check({ x: 1, y: Infinity, lvl: 3, c: true })).toBe(false)
    expect(k.whistle.minGapMs).toBe(8000)
    expect(k.whistle.posKeys).toEqual(['x', 'y'])
    expect(k.whistle.maxDist).toBeUndefined()
  })
  it('kneel: addressed to me, within 2 cells, one per 350 ms', () => {
    expect(k.kneel.check({ to: 'me' })).toBe(true)
    expect(k.kneel.check({ to: 'you' })).toBe(false)
    expect(k.kneel.check({ to: 42 })).toBe(false)
    expect(k.kneel.check({})).toBe(false)
    expect(k.kneel.maxDist).toBe(2.0); expect(k.kneel.minGapMs).toBe(350)
  })
  it('woke: names me as the one who counted, within 3 cells', () => {
    expect(k.woke.check({ by: 'me' })).toBe(true)
    expect(k.woke.check({ by: 'you' })).toBe(false)
    expect(k.woke.check({ by: 42 })).toBe(false)
    expect(k.woke.maxDist).toBe(3.0)
  })
  it('reads my id live (the id is known only after welcome)', () => {
    let id = null
    const kk = evKinds(() => id)
    expect(kk.kneel.check({ to: 'me' })).toBe(false)
    id = 'me'
    expect(kk.kneel.check({ to: 'me' })).toBe(true)
    expect(Object.isFrozen(kk)).toBe(true)
    expect(Object.keys(kk)).toEqual(['whistle', 'kneel', 'woke'])
  })
})

// the live wire: W1's evbus.js (merged onto feat/richness by integration step I1, so it may not be here yet)
const EVBUS = new URL('../src/net/evbus.js', import.meta.url)
const HAS_BUS = existsSync(EVBUS)
describe('evKinds through the live bus (W1 evbus.js)', () => {
  it.skipIf(!HAS_BUS)('whistle gap and spot, kneel distance and address, woke address', async () => {
    const { createEvBus } = await import(/* @vite-ignore */ EVBUS.href)
    let t = 0
    const pos = { w: { x: 10, y: 0 }, w2: { x: 10, y: 0 }, near: { x: 1.5, y: 0 }, far: { x: 3, y: 0 }, n2: { x: 0, y: 1.5 }, n3: { x: 1, y: 1 } }
    const bus = createEvBus({ send() {}, now: () => t, self: () => ({ x: 0, y: 0, lvl: 1 }), peerPos: (id) => pos[id] ?? null, peerIds: () => new Set(Object.keys(pos)), selfId: 'me' })
    const kinds = evKinds(() => 'me')
    for (const k of ['whistle', 'kneel', 'woke']) bus.register(k, kinds[k])
    let n = 0
    const msg = (id, kind, payload) => ({ id, name: id, kind, payload: { ...payload, n: n++ }, t })
    // whistle: same id 5 s after the last is dropped, 9 s delivered
    expect(bus.receive(msg('w', 'whistle', { x: 10, y: 0, lvl: 1, c: true }))).toBe(true)
    t = 5000; expect(bus.receive(msg('w', 'whistle', { x: 10, y: 0, lvl: 1, c: true }))).toBe(false)
    t = 9000; expect(bus.receive(msg('w', 'whistle', { x: 10, y: 0, lvl: 1, c: true }))).toBe(true)
    // whistle: the claimed spot 3 cells from the sender's list position is dropped, 1.5 delivered
    expect(bus.receive(msg('w2', 'whistle', { x: 13, y: 0, lvl: 1, c: true }))).toBe(false)
    t = 20000; expect(bus.receive(msg('w2', 'whistle', { x: 11.5, y: 0, lvl: 1, c: true }))).toBe(true)
    // kneel: a sender 3 cells away is dropped, 1.5 delivered, to someone else dropped
    expect(bus.receive(msg('far', 'kneel', { to: 'me' }))).toBe(false)
    expect(bus.receive(msg('near', 'kneel', { to: 'me' }))).toBe(true)
    expect(bus.receive(msg('n2', 'kneel', { to: 'you' }))).toBe(false)
    // woke: by someone else dropped; by me from 1.4 cells delivered
    expect(bus.receive(msg('n3', 'woke', { by: 'you' }))).toBe(false)
    expect(bus.receive(msg('n3', 'woke', { by: 'me' }))).toBe(true)
  })
})

describe('createCompany', () => {
  it('starts at 60; 20 s of company drains it to 0 at +3 sanity a second, exhausted exactly once', () => {
    const c = createCompany()
    expect(c.value).toBe(60)
    const dt = 1 / 60
    let exhausted = 0, steps = 0, r
    const first = c.step(dt, true)
    for (let i = 0; i < 1300; i++) {
      const before = c.value
      r = c.step(dt, true); steps++
      expect(r).toBe(first)                                        // one reused result
      expect(r.sanityDelta).toBe(before > 0 ? 3 : 0)
      if (r.exhaustedNow) exhausted++
    }
    expect(c.value).toBe(0)
    expect(exhausted).toBe(1)
    expect(c.step(dt, true).sanityDelta).toBe(0)
  })
  it('reaches 0 at 20 s (within a step)', () => {
    const c = createCompany()
    let i = 0
    while (c.value > 0 && i < 2000) { c.step(1 / 60, true); i++ }
    expect(Math.abs(i - 1200)).toBeLessThanOrEqual(1)
  })
  it('80 s apart refills to 60, capped, at no sanity', () => {
    const c = createCompany()
    c.add(-60)
    for (let i = 0; i < 80 * 60; i++) expect(c.step(1 / 60, false).sanityDelta).toBe(0)
    expect(c.value).toBe(60)
    for (let i = 0; i < 600; i++) c.step(1 / 60, false)
    expect(c.value).toBe(60)
  })
  it('exhaustedNow fires again only after the pool rose above 0 and fell back', () => {
    const c = createCompany()
    c.add(-59.9)
    expect(c.step(1, true).exhaustedNow).toBe(true)
    expect(c.step(1, true).exhaustedNow).toBe(false)
    c.add(-5)
    expect(c.step(1, true).exhaustedNow).toBe(false)
    c.step(1, false)                                               // 0.75
    expect(c.step(1, true).exhaustedNow).toBe(true)
  })
  it('add clamps 0..max and ignores NaN; reset refills', () => {
    const c = createCompany()
    expect(c.add(20)).toBe(60)
    expect(c.add(-70)).toBe(0)
    expect(c.add(NaN)).toBe(0)
    expect(c.add(12.5)).toBe(12.5)
    c.reset(); expect(c.value).toBe(60)
  })
  it('takes its numbers as options', () => {
    const c = createCompany({ max: 10, drain: 1, refill: 2, rate: 5 })
    expect(c.value).toBe(10)
    expect(c.step(1, true).sanityDelta).toBe(5); expect(c.value).toBe(9)
    c.step(1, false); expect(c.value).toBe(10)
  })
})

describe('legacy identity (the values the gated game.js lines read at rest)', () => {
  it('nobody listed: tick is empty; the count is you; the pool is full', () => {
    const rc = createRollCall({ now: () => 1234 })
    expect(rc.tick(1234, [])).toHaveLength(0)
    expect(rc.tick(undefined, undefined)).toHaveLength(0)
    expect(rc.count()).toBe(1)
    const c = createCompany()
    expect(c.value).toBe(60); expect(c.add(0)).toBe(60)
  })
})
