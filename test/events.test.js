import { describe, it, expect } from 'vitest'
import { createEventScheduler, eventInterval, EVENTS } from '../src/renderer/events.js'

const ctx = (o = {}) => ({ level: 1, sanity: 100, canFire: true, ...o })

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
    // deterministic weighted picks reach the deep-only events at level 1
    expect(createEventScheduler({ rng: () => 0.99 })._pick(1)).toBe('crosser')
    expect(createEventScheduler({ rng: () => 0 })._pick(1)).toBe('lights-cascade')
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
