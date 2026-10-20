// test/evlog.test.js — the keep/drop log: the only server-stateful addition,
// behind the owner's opt-in. Pure; both servers wrap the same module.
import { describe, it, expect } from 'vitest'
import { createEvLog, createStoredLog, DAY_MS } from '../relay/evlog.js'

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

  it("'wanderer' is capped per sender id instead of per name (many players share it)", () => {
    const log = createEvLog({ max: 64, perName: 6 })
    for (let i = 1; i <= 6; i++) log.keep('c:1:' + i, 'wanderer', frame('w1', 'cache', i))
    for (let i = 1; i <= 6; i++) log.keep('c:2:' + i, 'wanderer', frame('w2', 'cache', 10 + i))
    expect(log.size()).toBe(12)                    // two anonymous players, neither evicts the other
    log.keep('c:1:7', 'wanderer', frame('w1', 'cache', 7))
    expect(log.size()).toBe(12)
    expect(log.replay().map(f => f.payload.n)).not.toContain(1)
    expect(log.replay().map(f => f.payload.n)).toContain(11)
  })

  it("one anonymous sender cannot slip its cap by varying the key's prefix (it would flush everyone else's)", () => {
    const log = createEvLog({ max: 64, perName: 6 })
    for (let i = 0; i < 58; i++) log.keep('c:1:' + i, 'n' + i, frame('h' + i, 'cache', i))
    for (let i = 0; i < 64; i++) log.keep('p' + i + ':1:0,0', 'wanderer', frame('grief', 'cache', 1000 + i))
    const ns = log.replay().map(f => f.payload.n)
    expect(ns.filter(n => n >= 1000).length).toBe(6)
    expect(ns.filter(n => n < 1000).length).toBe(58)          // every honest cache is still there
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

  it('replay preserves insertion order and hands back the frames, their time cut to the UTC day', () => {
    const log = createEvLog({ max: 64, perName: 6 })
    const f1 = frame('a', 'cache', 1), f2 = frame('b', 'ward', 2), f3 = frame('c', 'cache', 3)
    log.keep('x', 'a', f1); log.keep('y', 'b', f2); log.keep('z', 'c', f3)
    const out = log.replay()
    expect(out).toEqual([f1, f2, f3].map(f => ({ ...f, t: 0 })))
    expect(log.replay()).not.toBe(out)             // a fresh array each call; the log is not exposed
  })

  it('a kept frame carries the day it was set down, never the millisecond', () => {
    const t = Date.UTC(2026, 9, 20, 17, 3, 9, 412)
    const log = createEvLog({ now: () => t })
    log.keep('c:1:0,0', 'ada', { ...frame('a', 'cache', 1), t })
    expect(log.replay()[0].t).toBe(Date.UTC(2026, 9, 20))
    expect(log.export()[0][3]).toBe(Math.floor(t / DAY_MS))
  })

  it('the same thing set down again the same day changes nothing (no write)', () => {
    let now = Date.UTC(2026, 9, 20, 9)
    const log = createEvLog({ now: () => now })
    log.keep('c:1:0,0', 'ada', { ...frame('a', 'cache', 1), t: now })
    log.export()
    now += 3600_000
    log.keep('c:1:0,0', 'ada', { ...frame('a', 'cache', 1), t: now })
    expect(log.dirty()).toBe(false)
    log.keep('c:1:0,0', 'ada', { ...frame('a', 'cache', 2), t: now })
    expect(log.dirty()).toBe(true)
  })

  it('forgets after 30 days: never replayed, pruned on import, and it says when the oldest goes', () => {
    let now = Date.UTC(2026, 9, 1, 12)
    const log = createEvLog({ now: () => now })
    log.keep('old', 'ada', { ...frame('a', 'cache', 1), t: now })
    now += 10 * DAY_MS
    log.keep('new', 'bo', { ...frame('b', 'cache', 2), t: now })
    expect(log.expiresAt()).toBe((Math.floor(Date.UTC(2026, 9, 1) / DAY_MS) + 31) * DAY_MS)
    const rows = log.export()
    now = Date.UTC(2026, 9, 31, 23, 59)                       // day 30 after the first: still here
    expect(log.replay().map(f => f.payload.n)).toEqual([1, 2])
    now = Date.UTC(2026, 10, 1)                               // day 31: gone
    expect(log.replay().map(f => f.payload.n)).toEqual([2])
    expect(log.dirty()).toBe(true)
    const again = createEvLog({ now: () => now })
    again.import(rows)
    expect(again.size()).toBe(1)
    expect(again.dirty()).toBe(true)                           // the shorter log is what gets written next
    expect(createEvLog().expiresAt()).toBe(null)
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

describe('createStoredLog — the relay\'s storage shell, over a fake storage', () => {
  const store = (init) => {
    const m = new Map(init ? [['evlog', init]] : []), calls = []
    let fail = 0
    return {
      m, calls, failNext: (n) => { fail = n },
      get: async (k) => { calls.push('get'); if (fail > 0) { fail--; throw new Error('down') } return m.get(k) },
      put: async (k, v) => { calls.push('put'); m.set(k, JSON.parse(JSON.stringify(v))) },
      delete: async (k) => { calls.push('delete'); m.delete(k) },
    }
  }
  const row = (k, n) => [k, 'ada', frame('a', 'cache', n)]

  it('loads once, and a wake reads what was written', async () => {
    const st = store([row('k1', 1), row('k2', 2)])
    const s = createStoredLog(st)
    const log = await s.load()
    expect(await s.load()).toBe(log)
    expect(st.calls).toEqual(['get'])
    expect(log.replay().map(f => f.payload.n)).toEqual([1, 2])
    log.keep('k3', 'bo', frame('b', 'cache', 3))
    expect(await s.flush()).toBe(true)
    const woke = await createStoredLog(st).load()
    expect(woke.replay().map(f => f.payload.n)).toEqual([1, 2, 3])
  })

  it('a failed read assigns nothing, writes nothing, and is retried', async () => {
    const st = store([row('k1', 1), row('k2', 2)])
    st.failNext(1)
    const s = createStoredLog(st)
    expect(await s.load()).toBe(null)
    expect(await s.flush()).toBe(false)
    expect(st.calls).toEqual(['get'])
    const log = await s.load()
    expect(log.size()).toBe(2)
  })

  it('nothing changed, nothing written; an emptied log deletes the key; a failed write is tried again', async () => {
    const st = store([row('k1', 1)])
    const s = createStoredLog(st)
    const log = await s.load()
    log.drop('nope')
    expect(await s.flush()).toBe(false)
    log.drop('k1')
    st.delete = async () => { throw new Error('down') }
    expect(await s.flush()).toBe(false)
    expect(s.dirty()).toBe(true)
    st.delete = async (k) => { st.calls.push('delete'); st.m.delete(k) }
    expect(await s.flush()).toBe(true)
    expect(st.m.has('evlog')).toBe(false)
    expect(st.calls.filter(c => c !== 'get')).toEqual(['delete'])
  })

  it('erase deletes only what is there', async () => {
    const st = store([row('k1', 1)])
    expect(await createStoredLog(st).erase()).toBe(true)
    expect(st.m.has('evlog')).toBe(false)
    await createStoredLog(st).erase()
    expect(st.calls.filter(c => c === 'delete').length).toBe(1)
  })
})

describe('export / import — the log survives a sleeping room (relay: Durable Object storage)', () => {
  it('export is a plain JSON-safe array of [key, group, frame, day] in insertion order', () => {
    const log = createEvLog({ max: 64, perName: 6 })
    log.keep('c:1:3,4', 'ada', frame('a', 'cache', 1))
    log.keep('c:2:0,0', 'wanderer', frame('w1', 'cache', 2))
    const out = log.export()
    expect(JSON.parse(JSON.stringify(out))).toEqual(out)
    expect(out.map(e => e[0])).toEqual(['c:1:3,4', 'c:2:0,0'])
    expect(out[0][2]).toEqual({ ...frame('a', 'cache', 1), t: 0 })
    expect(out.map(e => e[1])).toEqual(['ada', 'wanderer|w1'])
    expect(Number.isInteger(out[0][3])).toBe(true)
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
