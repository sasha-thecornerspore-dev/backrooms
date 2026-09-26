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
