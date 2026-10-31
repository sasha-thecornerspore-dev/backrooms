import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { createEventScheduler, eventInterval, EVENTS, createBag, eventFx, ARRIVAL } from '../src/renderer/events.js'

const ctx = (o = {}) => ({ level: 1, sanity: 100, canFire: true, ...o })
// a seeded LCG, so a 10,000-draw property reads the same on every run
const lcg = (s = 7) => () => ((s = (s * 1103515245 + 12345) >>> 0) / 4294967296)

describe('eventInterval', () => {
  it('tightens under tension — a deep, frayed floor fires more often than a calm one', () => {
    const [calmMin, calmMax] = eventInterval(0, 100)
    const [tenseMin, tenseMax] = eventInterval(3, 5)
    expect(tenseMin).toBeLessThan(calmMin)   // both bounds pull in under tension
    expect(tenseMax).toBeLessThan(calmMax)
  })
})

describe('createEventScheduler', () => {
  it('does not fire before the interval elapses', () => {
    const s = createEventScheduler({ rng: () => 0.999 })   // long interval
    expect(s.tick(40, ctx())).toBeNull()
    expect(s.tick(40, ctx())).toBeNull()
  })

  it('fires once enough time passes, and re-arms for the next one', () => {
    const s = createEventScheduler({ rng: () => 0.3 })
    expect(s.tick(200, ctx())).not.toBeNull()   // plenty of time → fires
    expect(s.tick(1, ctx())).toBeNull()          // timer reset → not immediately again
    expect(s.tick(200, ctx())).not.toBeNull()    // after another interval → fires again
  })

  it('never fires while canFire is false, and does not bank the elapsed time', () => {
    const s = createEventScheduler({ rng: () => 0.999 })
    expect(s.tick(100000, ctx({ canFire: false }))).toBeNull()
    expect(s.tick(1, ctx())).toBeNull()          // timer was not advanced while paused
  })

  it('gates events by depth — never footsteps/crosser on level 0', () => {
    const s = createEventScheduler()
    for (let i = 0; i < 100; i++) expect(['footsteps', 'crosser']).not.toContain(s._pick(0))
    // one bag's worth of deterministic picks reaches the deep-only events at level 1
    for (const r of [0, 0.5, 0.99]) {
      const d = createEventScheduler({ rng: () => r })
      const got = new Set([...Array(22)].map(() => d._pick(1)))
      expect(got.has('crosser'), String(r)).toBe(true); expect(got.has('footsteps'), String(r)).toBe(true)
    }
  })

  it('only ever returns a known event id', () => {
    const ids = new Set(EVENTS.map((e) => e.id))
    const s = createEventScheduler({ rng: () => 0.42 })
    let fired = null
    for (let i = 0; i < 30 && !fired; i++) fired = s.tick(200, ctx())
    expect(ids.has(fired)).toBe(true)
  })
})

// W8: the docket and the closings lean the window through ONE mutable config the scheduler
// reads at every tick; at tension 0 nothing moves.
describe('tension (the docket and the closings)', () => {
  it('eventInterval(l, s) is eventInterval(l, s, 0) everywhere', () => {
    for (let l = 0; l <= 4; l++) for (const s of [0, 5, 50, 100]) expect(eventInterval(l, s, 0)).toEqual(eventInterval(l, s))
  })

  it('a positive tension pulls both bounds in', () => {
    const [a, b] = eventInterval(1, 100)
    const [c, d] = eventInterval(1, 100, 0.15)
    expect(c).toBeLessThan(a)
    expect(d).toBeLessThan(b)
  })

  it('the term is clamped inside 0..1', () => {
    expect(eventInterval(0, 100, -0.3)).toEqual(eventInterval(0, 100))
    expect(eventInterval(3, 0, 1)).toEqual(eventInterval(3, 0))
    expect(eventInterval(1, 100, NaN)).toEqual(eventInterval(1, 100))
  })

  const seq = () => { let s = 99; return () => ((s = (s * 1103515245 + 12345) >>> 0) / 4294967296) }

  it('a scheduler with no config and one with { events: EVENTS, tension: 0 } tick identically', () => {
    const a = createEventScheduler({ rng: seq() })
    const b = createEventScheduler({ rng: seq(), config: { events: EVENTS, tension: 0 } })
    for (let i = 0; i < 400; i++) {
      const c = ctx({ level: i % 4, sanity: (i * 7) % 101 })
      expect(b.tick(7, c)).toBe(a.tick(7, c))
    }
  })

  it('raising config.tension between ticks makes it fire sooner than its twin', () => {
    const calm = createEventScheduler({ rng: () => 0.5 })
    const tense = createEventScheduler({ rng: () => 0.5 })
    const c = ctx({ level: 0, sanity: 100 })
    // fire once so both re-arm through pickWindow at the current tension
    let i = 0
    while (!calm.tick(1, c) && i++ < 1000) {}
    i = 0
    while (!tense.tick(1, c) && i++ < 1000) {}
    tense.config.tension = 0.15
    // re-arm tense at the new tension
    i = 0
    while (!tense.tick(1, c) && i++ < 1000) {}
    i = 0
    while (!calm.tick(1, c) && i++ < 1000) {}
    let tCalm = 0, tTense = 0
    while (!calm.tick(1, c)) tCalm++
    while (!tense.tick(1, c)) tTense++
    expect(tTense).toBeLessThan(tCalm)
  })

  it('swapping config.events changes the catalogue at once', () => {
    const s = createEventScheduler({ rng: () => 0.42 })
    s.config.events = [{ id: 'door-slam', weight: 1, minLevel: 0 }]
    for (let i = 0; i < 20; i++) expect(s._pick(i % 4)).toBe('door-slam')
  })

  it('exposes the config it was handed, and builds one from events otherwise', () => {
    const cfg = { events: EVENTS, tension: 0 }
    expect(createEventScheduler({ config: cfg }).config).toBe(cfg)
    const own = createEventScheduler({ events: [EVENTS[1]] })
    expect(own.config).toEqual({ events: [EVENTS[1]], tension: 0 })
    expect(own._pick(0)).toBe(EVENTS[1].id)
  })
})

// T1-5: four new events that carry their effect as data, a depth ceiling, and a guard so no id can land silent
const CALLS = ['ring', 'offhook', 'hiss', 'creak', 'buzz', 'click', 'pant', 'drip', 'rasp', 'hush', 'thump', 'scrape']
const NEW_IDS = ['phone-rings', 'chair-scrape', 'pipe-knock', 'breaker-trip']
const poolAt = (level) => EVENTS.filter((e) => level >= (e.minLevel ?? 0) && level <= (e.maxLevel ?? Infinity)).map((e) => e.id)

describe('the catalogue', () => {
  it('keeps the six old entries as they were and appends the four new ones', () => {
    expect(EVENTS.map((e) => e.id)).toEqual(['lights-cascade', 'door-slam', 'hum-stops', 'cold-spot', 'footsteps', 'crosser', ...NEW_IDS])
    expect(EVENTS.slice(0, 6)).toEqual([
      { id: 'lights-cascade', weight: 3, minLevel: 0 }, { id: 'door-slam', weight: 4, minLevel: 0 }, { id: 'hum-stops', weight: 2, minLevel: 0 },
      { id: 'cold-spot', weight: 3, minLevel: 0 }, { id: 'footsteps', weight: 3, minLevel: 1 }, { id: 'crosser', weight: 3, minLevel: 1 },
    ])
  })

  it('maxLevel bounds the pool: the phone and the chair on L0-1, the knock on L2, the breaker on L3', () => {
    expect(poolAt(0)).toEqual(['lights-cascade', 'door-slam', 'hum-stops', 'cold-spot', 'phone-rings', 'chair-scrape'])   // four kinds become six
    expect(poolAt(1)).toEqual(['lights-cascade', 'door-slam', 'hum-stops', 'cold-spot', 'footsteps', 'crosser', 'phone-rings', 'chair-scrape'])
    expect(poolAt(2)).toEqual(['lights-cascade', 'door-slam', 'hum-stops', 'cold-spot', 'footsteps', 'crosser', 'pipe-knock'])
    expect(poolAt(3)).toEqual(['lights-cascade', 'door-slam', 'hum-stops', 'cold-spot', 'footsteps', 'crosser', 'breaker-trip'])
    for (let level = 0; level <= 3; level++) {
      const s = createEventScheduler({ rng: lcg(level + 1) })
      const got = new Set([...Array(400)].map(() => s._pick(level)))
      expect([...got].sort(), `L${level}`).toEqual([...poolAt(level)].sort())
    }
  })

  it('the new entries carry their effect as data: a line, a call() sound, count, gap, pan, flick', () => {
    const fx = Object.fromEntries(NEW_IDS.map((id) => [id, eventFx(id)]))
    expect(fx['phone-rings']).toEqual({ line: 'a phone is ringing a few rooms over. it stops before you find it.', sound: 'ring', count: 2, gap: 4, pan: 0.8, flick: 0 })
    expect(fx['chair-scrape']).toEqual({ line: 'in the next room, someone pushes a chair back from a desk.', sound: 'scrape', count: 1, gap: 0, pan: 0.6, flick: 0 })
    expect(fx['pipe-knock']).toEqual({ line: 'something knocks along the pipe toward you. then away.', sound: 'thump', count: 4, gap: 0.5, pan: 0.7, flick: 0 })
    expect(fx['breaker-trip']).toEqual({ line: 'a breaker trips somewhere. the dark leans closer, then settles.', sound: 'thump', count: 1, gap: 0, pan: 0, flick: 0.3 })
    for (const id of NEW_IDS) {
      const f = fx[id]
      expect(CALLS).toContain(f.sound)
      expect(f.line).toBe(f.line.toLowerCase()); expect(f.line).not.toMatch(/[!0-9]/); expect(f.line.at(-1)).toBe('.')
      expect(f.count).toBeGreaterThanOrEqual(1); expect(f.gap).toBeGreaterThanOrEqual(0)
      expect(f.pan).toBeGreaterThanOrEqual(0); expect(f.pan).toBeLessThanOrEqual(1)
      expect(f.flick).toBeGreaterThanOrEqual(0); expect(f.flick).toBeLessThan(1)
    }
    expect(EVENTS.find((e) => e.id === 'phone-rings')).toMatchObject({ minLevel: 0, maxLevel: 1 })
    expect(EVENTS.find((e) => e.id === 'chair-scrape')).toMatchObject({ minLevel: 0, maxLevel: 1 })
    expect(EVENTS.find((e) => e.id === 'pipe-knock')).toMatchObject({ minLevel: 2, maxLevel: 2 })
    expect(EVENTS.find((e) => e.id === 'breaker-trip')).toMatchObject({ minLevel: 3, maxLevel: 3 })
    // the hand-wired six have no data effect; an unknown id has none; a swapped catalogue is read when passed
    for (const id of ['lights-cascade', 'door-slam', 'hum-stops', 'cold-spot', 'footsteps', 'crosser', 'what']) expect(eventFx(id)).toBeNull()
    expect(eventFx('x', [{ id: 'x', weight: 1, fx: { sound: 'hiss' } }])).toEqual({ sound: 'hiss' })
  })

  it('every EVENTS id has an effect: a branch in game.js fireEvent, or data carrying a call() sound', () => {
    const game = readFileSync(new URL('../src/renderer/game.js', import.meta.url), 'utf8')
    const from = game.indexOf('function fireEvent(')
    expect(from).toBeGreaterThan(0)
    const body = game.slice(from, game.indexOf('\n  }\n', from))
    for (const e of EVENTS) {
      const wired = body.includes(`id === '${e.id}'`)
      const data = typeof eventFx(e.id)?.sound === 'string' && CALLS.includes(eventFx(e.id).sound)
      expect(wired || data, e.id).toBe(true)
    }
  })
})

describe('the bag (no repeats)', () => {
  it('never draws the same id twice running, in 10,000 draws on every floor', () => {
    for (let level = 0; level <= 3; level++) {
      const s = createEventScheduler({ rng: lcg(11 + level) })
      let prev = null
      for (let i = 0; i < 10000; i++) { const id = s._pick(level); expect(id).not.toBe(prev); prev = id }
    }
  })

  it('keeps the weights: each id lands near its share of the pool', () => {
    const s = createEventScheduler({ rng: lcg(3) })
    const pool = EVENTS.filter((e) => poolAt(1).includes(e.id))
    const total = pool.reduce((a, e) => a + e.weight, 0)
    const n = {}
    for (let i = 0; i < 22000; i++) { const id = s._pick(1); n[id] = (n[id] ?? 0) + 1 }
    for (const e of pool) expect(Math.abs(n[e.id] / 22000 - e.weight / total), e.id).toBeLessThan(0.02)
  })

  it('is rebuilt only when the eligible pool changes: a same-pool floor change keeps the bag', () => {
    const s = createEventScheduler({ rng: lcg(5) })
    s.config.events = [{ id: 'a', weight: 1, minLevel: 0 }, { id: 'b', weight: 1, minLevel: 0 }, { id: 'c', weight: 1, minLevel: 0 }]
    // every level sees the same three, so every block of three is one bag: a permutation, however the floors interleave
    for (let block = 0; block < 200; block++) {
      const got = [s._pick(block % 4), s._pick((block + 1) % 4), s._pick(2)]
      expect(got.sort()).toEqual(['a', 'b', 'c'])
    }
    // a pool change rebuilds at once (the L1-only id never leaks back to L0)
    s.config.events = [...s.config.events, { id: 'deep', weight: 1, minLevel: 1 }]
    for (let i = 0; i < 50; i++) { s._pick(1); expect(s._pick(0)).not.toBe('deep') }
  })

  it('one eligible id is drawn every time; none is null', () => {
    const s = createEventScheduler({ rng: lcg(2) })
    s.config.events = [{ id: 'only', weight: 2, minLevel: 0 }]
    for (let i = 0; i < 5; i++) expect(s._pick(0)).toBe('only')
    s.config.events = [{ id: 'deep', weight: 1, minLevel: 3 }, { id: 'none', weight: 0, minLevel: 0 }]
    expect(s._pick(0)).toBeNull()
  })
})

describe('createBag (the murmurs)', () => {
  it('hands out every index once per refill, never the same one twice running across refills', () => {
    for (const n of [2, 5, 12, 13]) {
      const b = createBag(n, lcg(n))
      let prev = -1
      for (let r = 0; r < 800; r++) {
        const block = []
        for (let i = 0; i < n; i++) { const k = b.next(); expect(k).not.toBe(prev); prev = k; block.push(k) }
        expect(block.sort((x, y) => x - y)).toEqual([...Array(n).keys()])
      }
    }
  })

  it('one line is always line 0; no lines is -1; a constant rng still terminates and stays in range', () => {
    const one = createBag(1, lcg())
    for (let i = 0; i < 4; i++) expect(one.next()).toBe(0)
    expect(createBag(0, lcg()).next()).toBe(-1)
    for (const r of [0, 0.999999, 1]) {
      const b = createBag(12, () => r)
      let prev = -1
      for (let i = 0; i < 100; i++) { const k = b.next(); expect(k).toBeGreaterThanOrEqual(0); expect(k).toBeLessThan(12); expect(k).not.toBe(prev); prev = k }
    }
  })
})

describe('arrive() (the arrival event: sound-only)', () => {
  it('pins its numbers: p 0.55 in [16, 60] s', () => {
    expect(ARRIVAL).toEqual({ p: 0.55, min: 16, max: 60 })
    expect(Object.isFrozen(ARRIVAL)).toBe(true)
  })

  it('with p = 0.55 the next event comes in [16, 60] s, flagged sound-only; otherwise from the normal window, unflagged', () => {
    const s = createEventScheduler({ rng: lcg(9) })
    let soon = 0
    const [a, b] = eventInterval(2, 80)
    for (let i = 0; i < 10000; i++) {
      s.arrive(2, 80)
      const n = s._next()
      if (s._arrival()) { soon++; expect(n).toBeGreaterThanOrEqual(16); expect(n).toBeLessThanOrEqual(60) }
      else { expect(n).toBeGreaterThanOrEqual(a); expect(n).toBeLessThanOrEqual(b) }
    }
    expect(soon / 10000).toBeGreaterThan(0.53); expect(soon / 10000).toBeLessThan(0.57)
  })

  it('the arrival event fires on its own clock, says soundOnly, and the one after it does not', () => {
    const seq = [0.5, 0.1, 0]                                   // the first window, then under p, then the bottom of [16, 60]
    const s = createEventScheduler({ rng: () => (seq.length ? seq.shift() : 0.5) })
    s.tick(30, ctx())                                           // time already on the clock is dropped
    s.arrive(1, 100)
    expect(s.tick(15.9, ctx())).toBeNull()
    expect(s.soundOnly).toBe(false)
    expect(s.tick(0.2, ctx())).not.toBeNull()
    expect(s.soundOnly).toBe(true)
    let id = null
    for (let i = 0; i < 300 && !id; i++) id = s.tick(1, ctx())
    expect(id).not.toBeNull()
    expect(s.soundOnly).toBe(false)
  })

  it('arrive() over a canFire pause still waits for the clock (it does not bank time)', () => {
    const seq = [0.5, 0.1, 0]
    const s = createEventScheduler({ rng: () => (seq.length ? seq.shift() : 0.5) })
    s.arrive(0, 100)
    expect(s.tick(1000, ctx({ canFire: false }))).toBeNull()
    expect(s.tick(15, ctx())).toBeNull()
    expect(s.tick(2, ctx())).not.toBeNull()
  })
})

describe('fireNow(level, sanity) (for the beats)', () => {
  it('returns an eligible id at once and resets the timer to a fresh normal window', () => {
    const s = createEventScheduler({ rng: lcg(4) })
    s.tick(20, ctx({ level: 3 }))
    const id = s.fireNow(3, 50)
    expect(poolAt(3)).toContain(id)
    const [a, b] = eventInterval(3, 50)
    expect(s._next()).toBeGreaterThanOrEqual(a); expect(s._next()).toBeLessThanOrEqual(b)
    expect(s.tick(a - 0.01, ctx({ level: 3 }))).toBeNull()      // the clock started again at the beat
    expect(s.soundOnly).toBe(false)
  })

  it('clears a pending arrival and its flag', () => {
    const seq = [0.5, 0.1, 0]
    const s = createEventScheduler({ rng: () => (seq.length ? seq.shift() : 0.5) })
    s.arrive(1, 100)
    expect(s._arrival()).toBe(true)
    s.fireNow(1, 100)
    expect(s._arrival()).toBe(false)
    expect(s.soundOnly).toBe(false)
    expect(s.tick(16.5, ctx())).toBeNull()                      // the normal window, not the arrival's
  })

  it('null when nothing is eligible', () => {
    const s = createEventScheduler({ events: [{ id: 'deep', weight: 1, minLevel: 3 }] })
    expect(s.fireNow(0, 100)).toBeNull()
  })
})
