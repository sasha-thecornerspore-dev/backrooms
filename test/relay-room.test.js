// relay/relay.js's Room: the keep/drop log as the live relay keeps it — in the Room's own storage, loaded once per instance,
// written at most once per 10 s, forgotten after 30 days. Driven through the real Room class over a fake ctx (the same two-line
// stand-in for 'cloudflare:workers' as relay-routes.test.js) and a fake storage that counts every write by key, so the
// write budget the Workers free plan cares about is measured, not assumed.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('cloudflare:workers', () => ({ DurableObject: class { constructor(ctx, env) { this.ctx = ctx; this.env = env } } }))

const { Room } = await import('../relay/relay.js')
const { createEvLog, DAY_MS } = await import('../relay/evlog.js')

const T0 = Date.UTC(2026, 9, 20, 12, 34, 56, 789)   // a Tuesday afternoon, to the millisecond

function fakeStorage(init = {}) {
  const m = new Map(Object.entries(init))
  let alarm = null
  const st = {
    m, puts: {}, deletes: {}, fail: {}, alarms: [],
    get: async (k) => {
      if (st.fail[k] > 0) { st.fail[k]--; throw new Error('storage unavailable') }
      return m.has(k) ? structuredClone(m.get(k)) : undefined
    },
    put: async (k, v) => { st.puts[k] = (st.puts[k] || 0) + 1; m.set(k, structuredClone(v)) },
    delete: async (k) => { st.deletes[k] = (st.deletes[k] || 0) + 1; return m.delete(k) },
    getAlarm: async () => alarm,
    setAlarm: async (t) => { st.alarms.push(t); alarm = t },
  }
  return st
}

function sock(id) {
  return {
    att: { id, name: 'wanderer', x: 0, y: 0, angle: 0 }, sent: [],
    send(raw) { this.sent.push(JSON.parse(raw)) },
    serializeAttachment(a) { this.att = structuredClone(a) },
    deserializeAttachment() { return structuredClone(this.att) },
  }
}

function room(storage, env = {}) {
  const sockets = []
  const ctx = { storage, getWebSockets: () => sockets.slice() }
  const r = new Room(ctx, env)
  return {
    r, sockets,
    async join(id, name) {
      const ws = sock(id)
      sockets.push(ws)
      await r.webSocketMessage(ws, JSON.stringify({ type: 'join', roomId: 'r', name }))
      return ws
    },
    async leave(ws) { sockets.splice(sockets.indexOf(ws), 1); await r.webSocketClose(ws) },
    ev: (ws, frame) => r.webSocketMessage(ws, JSON.stringify({ type: 'ev', ...frame })),
  }
}

const cache = (n, extra = {}) => ({ kind: 'cache', payload: { lvl: 1, cx: n, cy: 0, n }, keep: `c:1:${n},0`, ...extra })
const replayed = (ws) => ws.sent.filter(m => m.type === 'ev' && m.replay)
const storedRows = (st) => st.m.get('evlog') || []

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(T0) })
afterEach(() => { vi.useRealTimers() })

describe('a room that sleeps wakes with its caches', () => {
  it('a new instance reads the stored log once and replays it, stamped replay', async () => {
    const st = fakeStorage()
    const a = room(st)
    const ada = await a.join('ada1', 'ada')
    await a.ev(ada, cache(1)); await a.ev(ada, cache(2))
    await vi.advanceTimersByTimeAsync(10_000)
    expect(storedRows(st).map(r => r[0])).toEqual(['c:1:1,0', 'c:1:2,0'])

    const b = room(st)                                      // the object was evicted: a fresh instance over the same storage
    const bo = await b.join('bo1', 'bo')
    expect(replayed(bo).map(m => m.payload.n)).toEqual([1, 2])
    expect(replayed(bo).every(m => m.name === 'ada' && m.kind === 'cache')).toBe(true)
  })

  it('what is kept carries the day it was set down, never the millisecond', async () => {
    const st = fakeStorage()
    const a = room(st)
    const ada = await a.join('ada1', 'ada')
    const bo = await a.join('bo1', 'bo')
    await a.ev(ada, cache(1))
    const live = bo.sent.find(m => m.type === 'ev')
    expect(live.t).toBe(T0)                                 // the live frame is as it always was
    await vi.advanceTimersByTimeAsync(10_000)
    const day = Math.floor(T0 / DAY_MS) * DAY_MS
    expect(storedRows(st)[0][2].t).toBe(day)
    expect(JSON.stringify(st.m.get('evlog'))).not.toContain(String(T0))
    const cy = await room(st).join('cy1', 'cy')
    expect(replayed(cy)[0].t).toBe(day)
  })
})

describe('a failed read never costs the room its caches', () => {
  it('no replay and no keep while the read fails; the next message reads again, and nothing stored is overwritten', async () => {
    const seed = createEvLog({ max: 64, perName: 6 })
    for (let i = 0; i < 64; i++) seed.keep(`c:1:${i},9`, 'n' + i, { type: 'ev', id: 'p' + i, name: 'n' + i, kind: 'cache', payload: { n: i }, t: T0 })
    const st = fakeStorage({ evlog: seed.export() })
    st.fail.evlog = 2                                       // the join's read and the first keep's read both fail
    const a = room(st)
    const ada = await a.join('ada1', 'ada')
    expect(replayed(ada)).toEqual([])
    await a.ev(ada, cache(100))                             // relayed, but not kept: the log could not be read
    await vi.advanceTimersByTimeAsync(30_000)
    expect(st.puts.evlog).toBeUndefined()
    expect(storedRows(st).length).toBe(64)

    vi.advanceTimersByTime(5_000)                           // the keep budget refills
    await a.ev(ada, cache(101))                             // this read succeeds: the stored 64 come in under the new one
    await vi.advanceTimersByTimeAsync(10_000)
    expect(st.puts.evlog).toBe(1)
    const keys = storedRows(st).map(r => r[0])
    expect(keys.length).toBe(64)
    expect(keys).toContain('c:1:101,0')
    expect(keys).toContain('c:1:63,9')
  })
})

describe('writes are paced: the free plan counts rows written per day', () => {
  it('a socket keeping as fast as it may still writes the room log at most once per 10 s', async () => {
    const st = fakeStorage()
    const a = room(st)
    const ada = await a.join('ada1', 'ada')
    for (let i = 0; i < 600; i++) {                        // a minute of 'ev' frames at the full 10 a second, every one a keep
      await a.ev(ada, cache(i % 50))
      await vi.advanceTimersByTimeAsync(100)
    }
    await vi.advanceTimersByTimeAsync(10_000)
    expect(st.puts.evlog).toBeLessThanOrEqual(7)            // 60 s / 10 s, and the one that lands after
    // and only what the keep budget let through was kept at all: a burst of 4, then one every 2 s
    expect(storedRows(st).length).toBeLessThanOrEqual(6)   // ada's own cap (perName 6) holds it there anyway
  })

  it('a keep over the budget is still relayed live, just not stored', async () => {
    const st = fakeStorage()
    const a = room(st)
    const ada = await a.join('ada1', 'ada')
    const bo = await a.join('bo1', 'bo')
    for (let i = 0; i < 8; i++) await a.ev(ada, cache(i))  // one instant: 4 within the budget, 4 over it
    expect(bo.sent.filter(m => m.type === 'ev').length).toBe(8)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(storedRows(st).map(r => r[2].payload.n)).toEqual([0, 1, 2, 3])
  })

  it('only a cache keep or a take drop is stored; any other kind is relayed and forgotten', async () => {
    const st = fakeStorage()
    const a = room(st)
    const ada = await a.join('ada1', 'ada')
    const bo = await a.join('bo1', 'bo')
    await a.ev(ada, { kind: 'ward', payload: { lvl: 1, x: 1, y: 1, a: 0 }, keep: 'w:1' })
    await a.ev(ada, { kind: 'junk', payload: 'x'.repeat(1200), keep: 'z:1' })
    expect(bo.sent.filter(m => m.type === 'ev').map(m => m.kind)).toEqual(['ward', 'junk'])
    await vi.advanceTimersByTimeAsync(10_000)
    expect(st.puts.evlog).toBeUndefined()
    await a.ev(ada, cache(1))
    await a.ev(ada, { kind: 'cache', payload: {}, drop: 'c:1:1,0' })   // a drop riding the wrong kind takes nothing
    await vi.advanceTimersByTimeAsync(10_000)
    expect(storedRows(st).map(r => r[0])).toEqual(['c:1:1,0'])
    await a.ev(ada, { kind: 'take', payload: { key: 'c:1:1,0' }, drop: 'c:1:1,0' })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(st.m.has('evlog')).toBe(false)                   // the last cache taken: the key is deleted, not kept empty
  })

  it('a drop that takes nothing, and the same cache set down again, write nothing', async () => {
    const st = fakeStorage()
    const a = room(st)
    const ada = await a.join('ada1', 'ada')
    await a.ev(ada, cache(1))
    await vi.advanceTimersByTimeAsync(10_000)
    expect(st.puts.evlog).toBe(1)
    await a.ev(ada, { kind: 'take', payload: { key: 'c:1:9,9' }, drop: 'c:1:9,9' })
    await vi.advanceTimersByTimeAsync(3_000)
    await a.ev(ada, cache(1))
    await vi.advanceTimersByTimeAsync(10_000)
    expect(st.puts.evlog).toBe(1)
    expect(st.deletes.evlog).toBeUndefined()
  })

  it('the last one out writes what is waiting at once', async () => {
    const st = fakeStorage()
    const a = room(st)
    const ada = await a.join('ada1', 'ada')
    await a.ev(ada, cache(1))
    expect(st.puts.evlog).toBeUndefined()
    await a.leave(ada)
    expect(st.puts.evlog).toBe(1)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(st.puts.evlog).toBe(1)                           // and the timer has nothing left to write
  })
})

describe('the log forgets: 30 days, then the alarm deletes it', () => {
  it('a write sets the alarm for the oldest entry\'s expiry, once; the alarm deletes what has expired', async () => {
    const st = fakeStorage()
    const a = room(st)
    const ada = await a.join('ada1', 'ada')
    await a.ev(ada, cache(1))
    await vi.advanceTimersByTimeAsync(10_000)
    const day = Math.floor(T0 / DAY_MS)
    expect(st.alarms).toEqual([(day + 31) * DAY_MS])
    await vi.advanceTimersByTimeAsync(5_000)
    await a.ev(ada, cache(2))
    await vi.advanceTimersByTimeAsync(10_000)
    expect(st.alarms.length).toBe(1)                        // one due already: no second write for it

    vi.setSystemTime((day + 31) * DAY_MS)
    await room(st).r.alarm()                                // a fresh instance, as an alarm wakes it
    expect(st.m.has('evlog')).toBe(false)
  })

  it('an entry past 30 days is never replayed, even before the alarm has run', async () => {
    const old = createEvLog({ max: 64, perName: 6, now: () => T0 - 40 * DAY_MS })
    old.keep('c:1:1,1', 'ada', { type: 'ev', id: 'a', name: 'ada', kind: 'cache', payload: { n: 1 }, t: T0 - 40 * DAY_MS })
    const fresh = createEvLog({ max: 64, perName: 6, now: () => T0 })
    fresh.keep('c:1:2,2', 'bo', { type: 'ev', id: 'b', name: 'bo', kind: 'cache', payload: { n: 2 }, t: T0 })
    const st = fakeStorage({ evlog: [...old.export(), ...fresh.export()] })
    const cy = await room(st).join('cy1', 'cy')
    expect(replayed(cy).map(m => m.payload.n)).toEqual([2])
  })
})

describe("EV_LOG '0' turns it off, and off means gone", () => {
  it('nothing is replayed or kept, and a stored log is deleted on the first join', async () => {
    const seed = createEvLog()
    seed.keep('c:1:1,1', 'ada', { type: 'ev', id: 'a', name: 'ada', kind: 'cache', payload: { n: 1 }, t: T0 })
    const st = fakeStorage({ evlog: seed.export() })
    const a = room(st, { EV_LOG: '0' })
    const bo = await a.join('bo1', 'bo')
    expect(replayed(bo)).toEqual([])
    expect(st.m.has('evlog')).toBe(false)
    await a.ev(bo, cache(5))
    await vi.advanceTimersByTimeAsync(10_000)
    expect(st.m.has('evlog')).toBe(false)
    await a.join('cy1', 'cy')
    expect(st.deletes.evlog).toBe(1)                        // once per instance, and only when there was something to delete
  })
})
