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
