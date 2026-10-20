// test/evlog.test.js — the keep/drop log: the only server-stateful addition,
// behind the owner's opt-in. Pure; both servers wrap the same module.
import { describe, it, expect } from 'vitest'
import { createEvLog } from '../relay/evlog.js'

const frame = (id, kind, n) => ({ type: 'ev', id, name: id, kind, payload: { n }, t: n })

describe('createEvLog', () => {
  it('starts empty and reports its size', () => {
    const log = createEvLog({ max: 64, perName: 6 })
    expect(log.size()).toBe(0)
    expect(log.replay()).toEqual([])
  })

  it('keeps the 64 newest, FIFO', () => {
    const log = createEvLog({ max: 64, perName: 6 })
    for (let i = 0; i < 70; i++) log.keep('k' + i, 'name' + i, frame('p' + i, 'cache', i))
    expect(log.size()).toBe(64)
    const keys = log.replay().map(f => f.payload.n)
    expect(keys[0]).toBe(6)
    expect(keys[63]).toBe(69)
  })

  it('same key replaces (one entry, the newest frame)', () => {
    const log = createEvLog({ max: 64, perName: 6 })
    log.keep('c:1:3,4', 'ada', frame('a', 'cache', 1))
    log.keep('c:1:5,5', 'ada', frame('a', 'cache', 2))
    log.keep('c:1:3,4', 'ada', frame('a', 'cache', 3))
    expect(log.size()).toBe(2)
    expect(log.replay().map(f => f.payload.n)).toEqual([2, 3])
  })

  it("a 7th from one name evicts that name's oldest only", () => {
    const log = createEvLog({ max: 64, perName: 6 })
    log.keep('other', 'bo', frame('b', 'cache', 100))
    for (let i = 1; i <= 7; i++) log.keep('ada' + i, 'ada', frame('a', 'cache', i))
    expect(log.size()).toBe(7)
    const ns = log.replay().map(f => f.payload.n)
    expect(ns).toEqual([100, 2, 3, 4, 5, 6, 7])
    expect(ns).not.toContain(1)
  })

  it("'wanderer' is capped per key-prefix+id instead of per name (many players share it)", () => {
    const log = createEvLog({ max: 64, perName: 6 })
    for (let i = 1; i <= 6; i++) log.keep('c:1:' + i, 'wanderer', frame('w1', 'cache', i))
    for (let i = 1; i <= 6; i++) log.keep('c:2:' + i, 'wanderer', frame('w2', 'cache', 10 + i))
    expect(log.size()).toBe(12)                    // two anonymous players, neither evicts the other
    log.keep('c:1:7', 'wanderer', frame('w1', 'cache', 7))
    expect(log.size()).toBe(12)
    expect(log.replay().map(f => f.payload.n)).not.toContain(1)
    expect(log.replay().map(f => f.payload.n)).toContain(11)
  })

  it('drop removes; dropping an unknown key is a no-op', () => {
    const log = createEvLog({ max: 64, perName: 6 })
    log.keep('a', 'ada', frame('a', 'cache', 1))
    log.keep('b', 'ada', frame('a', 'cache', 2))
    log.drop('a')
    log.drop('zzz')
    log.drop(42)
    expect(log.size()).toBe(1)
    expect(log.replay().map(f => f.payload.n)).toEqual([2])
  })

  it('replay preserves insertion order and hands back the frames themselves', () => {
    const log = createEvLog({ max: 64, perName: 6 })
    const f1 = frame('a', 'cache', 1), f2 = frame('b', 'ward', 2), f3 = frame('c', 'cache', 3)
    log.keep('x', 'a', f1); log.keep('y', 'b', f2); log.keep('z', 'c', f3)
    const out = log.replay()
    expect(out).toEqual([f1, f2, f3])
    expect(out[0]).toBe(f1)
    expect(log.replay()).not.toBe(out)             // a fresh array each call; the log is not exposed
  })

  it('defaults to max 64 / perName 6 and clamps bad options', () => {
    const log = createEvLog()
    for (let i = 0; i < 100; i++) log.keep('k' + i, 'n' + i, frame('p', 'cache', i))
    expect(log.size()).toBe(64)
    const tight = createEvLog({ max: 0, perName: 0 })
    tight.keep('a', 'n', frame('p', 'cache', 1))
    expect(tight.size()).toBe(1)
  })

  it('ignores a non-string key or a non-object frame', () => {
    const log = createEvLog()
    log.keep(42, 'n', frame('p', 'cache', 1))
    log.keep('k', 'n', null)
    log.keep('', 'n', frame('p', 'cache', 1))
    expect(log.size()).toBe(0)
  })
})

describe('export / import — the log survives a sleeping room (relay: Durable Object storage)', () => {
  it('export is a plain JSON-safe array of [key, group, frame] in insertion order', () => {
    const log = createEvLog({ max: 64, perName: 6 })
    log.keep('c:1:3,4', 'ada', frame('a', 'cache', 1))
    log.keep('c:2:0,0', 'wanderer', frame('w1', 'cache', 2))
    const out = log.export()
    expect(JSON.parse(JSON.stringify(out))).toEqual(out)
    expect(out.map(e => e[0])).toEqual(['c:1:3,4', 'c:2:0,0'])
    expect(out[0][2]).toEqual(frame('a', 'cache', 1))
  })

  it('import restores the entries, their order and the per-group caps', () => {
    const a = createEvLog({ max: 64, perName: 6 })
    a.keep('other', 'bo', frame('b', 'cache', 100))
    for (let i = 1; i <= 6; i++) a.keep('ada' + i, 'ada', frame('a', 'cache', i))
    const b = createEvLog({ max: 64, perName: 6 })
    b.import(a.export())
    expect(b.size()).toBe(7)
    expect(b.replay().map(f => f.payload.n)).toEqual([100, 1, 2, 3, 4, 5, 6])
    b.keep('ada7', 'ada', frame('a', 'cache', 7))          // a 7th from ada still evicts ada's oldest, not bo's
    expect(b.replay().map(f => f.payload.n)).toEqual([100, 2, 3, 4, 5, 6, 7])
  })

  it('import replaces what was there, re-applies the overall cap, and ignores junk', () => {
    const log = createEvLog({ max: 3, perName: 6 })
    log.keep('old', 'x', frame('x', 'cache', 0))
    log.import([['k1', 'g', frame('p', 'cache', 1)], ['k2', 'g', frame('p', 'cache', 2)], ['k3', 'g', frame('p', 'cache', 3)], ['k4', 'g', frame('p', 'cache', 4)]])
    expect(log.replay().map(f => f.payload.n)).toEqual([2, 3, 4])
    log.import(null)
    expect(log.size()).toBe(0)
    log.import([42, ['', 'g', {}], ['k', 'g', 'not a frame'], ['ok', 'g', frame('p', 'cache', 9)]])
    expect(log.replay().map(f => f.payload.n)).toEqual([9])
  })

  it('a changed flag tells the shell when there is something new to store', () => {
    const log = createEvLog({ max: 64, perName: 6 })
    expect(log.dirty()).toBe(false)
    log.keep('k', 'ada', frame('a', 'cache', 1))
    expect(log.dirty()).toBe(true)
    log.export()
    expect(log.dirty()).toBe(false)
    log.drop('k')
    expect(log.dirty()).toBe(true)
    log.drop('k')                                   // dropping nothing changes nothing
    log.export()
    expect(log.dirty()).toBe(false)
  })
})
