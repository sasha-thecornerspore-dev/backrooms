// The dropped line and the rejoin (release 2.0.7, the crew): src/net/client.js against a fake WebSocket on an injected clock — the drop
// is told, the same room is asked for again under the same name and seed on a growing, jittered spacing, the arrival is never settled
// again, a flood close (4029) and disconnect() never retry, the tries stop after four minutes and one press starts them over. Then what
// rides on it: stillFor read when asked, the relay's replay of a returning player's caches laid once (the real bus, ledger and items
// around game.js's own handler), a friend's line coming back read as one line, the movement-rate switch, and the privacy pins — the game
// never asks for a location, the frames the client sends and the ev kinds the bus knows are a closed list, the heartbeat stays v:1.
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createMultiplayerClient, FLOOD_CLOSE, REJOIN, COMEBACK_MS, rejoinDelay, LINE, lineNotice, foldChat, sysText,
  JOINED_LINE, LEFT_LINE, CAME_BACK_LINE, POS_HZ, posHz, posGapS, SHARED_NAMES, HOLD,
} from '../src/net/client.js'
import { createEvBus, STATUSES } from '../src/net/evbus.js'
import { createCacheLedger, cacheKey, isCachePayload, extraFor, cacheSig, HAND_TAKES_KEPT, NAME_CAP_EXEMPT } from '../src/renderer/caches.js'
import { createItemSystem } from '../src/renderer/items.js'
import { createLevelMemory } from '../src/renderer/levelmem.js'
import { findOpenNear } from '../src/renderer/topology.js'
import { DEFAULT_CONFIG } from '../src/renderer/world.js'
import { CARD_KEYS } from '../src/renderer/papercard.js'
import { ACTIONS, SITUATIONAL } from '../src/renderer/touch.js'
import { validateWorld } from '../tools/validate-world.mjs'
import { createServer } from '../server/index.js'
import { WebSocket } from 'ws'

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms))

const root = fileURLToPath(new URL('..', import.meta.url))
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8').replace(/\r\n/g, '\n')
const game = read('src/renderer/game.js'), clientSrc = read('src/net/client.js'), busSrc = read('src/net/evbus.js')
const html = read('src/renderer/index.html')
const at = (src, s, from = 0) => { const k = src.indexOf(s, from); expect(k, s).toBeGreaterThanOrEqual(0); return k }
const slice = (src, from, to) => { const a = at(src, from), b = src.indexOf(to, a + from.length); expect(b, to).toBeGreaterThan(a); return src.slice(a, b + to.length) }
const lineOf = (src, from) => { const a = at(src, from); const b = src.indexOf('\n', a); return src.slice(a, b < 0 ? undefined : b) }

// ── the rig: a fake WebSocket the test plays the room through, and a clock whose timers run only when it is advanced ──
function rig({ random = () => 0.5 } = {}) {
  let t = 0, nextId = 1
  const timers = new Map()
  const clock = {
    now: () => t,
    setTimeout: (fn, ms) => { const id = nextId++; timers.set(id, { at: t + Math.max(0, Number(ms) || 0), ms, fn }); return id },
    clearTimeout: (id) => { timers.delete(id) },
    // run every timer due within ms, in time order (a timer may set another)
    advance(ms) {
      const end = t + ms
      for (;;) {
        let best = null
        for (const [id, x] of timers) if (x.at <= end && (best === null || x.at < best[1].at)) best = [id, x]
        if (best === null) break
        timers.delete(best[0]); t = best[1].at; best[1].fn()
      }
      t = end
    },
    // the wait to the next timer of at least `min` ms (the rejoin's spacing; the try's own 10 s timeout and the 0 ms hand-over are not it)
    next(min = 1) { let m = Infinity; for (const x of timers.values()) if (x.ms >= min && x.ms !== REJOIN.TRY_MS) m = Math.min(m, x.at - t); return m },
    get size() { return timers.size },
  }
  const sockets = []
  class FakeWS {
    constructor(url) { this.url = url; this.sent = []; this.closed = false; sockets.push(this) }
    send(s) { this.sent.push(JSON.parse(s)) }
    close() { this.closed = true }
    // the room's side
    open() { this.onopen?.() }
    msg(o) { this.onmessage?.({ data: JSON.stringify(o) }) }
    drop(code = 1006, reason = '') { this.onclose?.({ code, reason }) }
  }
  const c = createMultiplayerClient('wss://relay.test/?room=lamp', { WebSocket: FakeWS, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, now: clock.now, random })
  const lines = [], chats = []
  c.onLine((state, info) => lines.push([state, info]))
  c.onChat((...a) => chats.push(a))
  const last = () => sockets[sockets.length - 1]
  // the room lets the newest socket in
  const welcome = (id, extra = {}) => { const s = last(); s.open(); s.msg({ type: 'welcome', playerId: id, worldSeed: 77, roomId: 'lamp', ...extra }); return s }
  // the first join: connect() resolved
  async function join(id = 'me1', extra = { first: true }) {
    const p = c.connect('lamp', 1985557259, 'ada')
    welcome(id, extra)
    return p
  }
  return { c, clock, sockets, last, welcome, join, lines, chats }
}
const players = (s, list) => s.msg({ type: 'players', list })
const states = (lines) => lines.map(([s]) => s)
const waits = (lines) => lines.filter(([s]) => s === 'dropped' || s === 'retrying').map(([, i]) => i.inMs)

describe('the spacing: about 1 s, 2 s, 4 s … to 30 s, each ±25 %', () => {
  it('doubles from FIRST_MS to CAP_MS, and the jitter is a quarter either way', () => {
    expect(REJOIN.FIRST_MS).toBe(1000); expect(REJOIN.CAP_MS).toBe(30000); expect(REJOIN.JITTER).toBe(0.25)
    expect([0, 1, 2, 3, 4, 5, 6, 40].map((a) => rejoinDelay(a, () => 0.5))).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000])
    expect([0, 1, 5].map((a) => rejoinDelay(a, () => 0))).toEqual([750, 1500, 22500])
    expect([0, 1, 5].map((a) => rejoinDelay(a, () => 1))).toEqual([1250, 2500, 37500])
    for (const bad of [-3, 1.5, NaN, undefined, '2']) expect(rejoinDelay(bad, () => 0.5)).toBe(1000)
    for (const r of [() => NaN, () => -4, () => 9]) { const d = rejoinDelay(2, r); expect(d).toBeGreaterThanOrEqual(3000); expect(d).toBeLessThanOrEqual(5000) }
    expect(REJOIN.FOR_MS).toBe(4 * 60 * 1000)
  })
})

describe('a dropped line: told, emptied, and the same room asked for again', () => {
  it('a close after welcome says dropped, empties the list, and the next try asks with the same room, name and seed', async () => {
    const r = rig()
    const w = await r.join('me1')
    expect(w).toEqual({ worldSeed: 77, playerId: 'me1', roomId: 'lamp', first: true })
    const first = r.last().sent[0]
    expect(first).toEqual({ type: 'join', roomId: 'lamp', name: 'ada', worldSeed: 1985557259 })
    players(r.last(), [{ id: 'me1', x: 1, y: 1, name: 'ada' }, { id: 'b', x: 2, y: 2, angle: 0, name: 'bo' }])
    expect(r.c.getRemotePlayers().map((p) => p.id)).toEqual(['b'])
    expect([r.c.isConnected(), r.c.lineState()]).toEqual([true, 'live'])
    r.last().drop(1006)
    expect(states(r.lines)).toEqual(['dropped'])
    expect(r.lines[0][1]).toEqual({ attempt: 0, inMs: 1000 })
    expect([r.c.isConnected(), r.c.lineState(), r.c.getRemotePlayers()]).toEqual([false, 'retrying', []])
    // nothing goes while the line is down
    r.c.sendPos(1, 2, 0, 100); r.c.sendTyping(true); r.c.sendEv('whistle', {})
    expect(r.sockets.length).toBe(1)
    r.clock.advance(999)
    expect(r.sockets.length).toBe(1)                      // not before its time
    r.clock.advance(1)
    expect(r.sockets.length).toBe(2)
    r.last().open()
    expect(r.last().sent).toEqual([first])                // the SAME room, the SAME name, the SAME requested seed
    r.last().msg({ type: 'welcome', playerId: 'me2', worldSeed: 77, roomId: 'lamp', first: true })
    expect(states(r.lines)).toEqual(['dropped', 'back'])
    expect(r.lines[1][1]).toEqual({ attempt: 1, sameWorld: true })   // the room keeps the world you walk (a LAN server started again may not)
    expect([r.c.isConnected(), r.c.lineState(), r.c.id]).toEqual([true, 'live', 'me2'])
    expect(r.c.getRemotePlayers()).toEqual([])            // refilled by the next list, not before
    players(r.last(), [{ id: 'me2', x: 1, y: 1, name: 'ada' }, { id: 'b2', x: 2, y: 2, angle: 0, name: 'bo' }])
    expect(r.c.getRemotePlayers().map((p) => p.id)).toEqual(['b2'])
    r.c.sendPos(3, 4, 0, 90)
    expect(r.last().sent.at(-1)).toEqual({ type: 'pos', x: 3, y: 4, angle: 0, hp: 90 })
    expect(r.clock.next()).toBe(Infinity)                  // back: no try waits
  })

  it('a try that fails waits longer each time, jittered; every try asks the same', async () => {
    const seq = [0, 1, 0.5, 0, 1, 0.25, 0.75]
    let k = 0
    const r = rig({ random: () => seq[k++ % seq.length] })
    await r.join()
    r.last().drop()
    for (let i = 0; i < 6; i++) { r.clock.advance(r.clock.next()); r.last().open(); r.last().drop(1006) }
    const w = waits(r.lines)
    expect(w).toEqual([750, 2500, 4000, 6000, 20000, 26250, 33750])
    const base = [1000, 2000, 4000, 8000, 16000, 30000, 30000]
    w.forEach((d, i) => { expect(d).toBeGreaterThanOrEqual(base[i] * 0.75); expect(d).toBeLessThanOrEqual(base[i] * 1.25) })
    expect(states(r.lines)).toEqual(['dropped', 'retrying', 'retrying', 'retrying', 'retrying', 'retrying', 'retrying'])
    for (const s of r.sockets.slice(1)) expect(s.sent).toEqual([r.sockets[0].sent[0]])
  })

  it('a room that came back with another world says so on back (a LAN host started again); the line holds all the same', async () => {
    const r = rig()
    await r.join()
    r.last().drop()
    r.clock.advance(1000); r.welcome('me2', { worldSeed: 5 })
    expect(r.lines.at(-1)).toEqual(['back', { attempt: 1, sameWorld: false }])
    expect(r.c.lineState()).toBe('live')
  })
  it('a try the room never answers is given up after TRY_MS and the next is spaced as any other', async () => {
    const r = rig()
    await r.join()
    r.last().drop()
    r.clock.advance(1000)
    expect(r.sockets.length).toBe(2)                      // open, never welcomed, never closed
    r.clock.advance(REJOIN.TRY_MS)
    expect(r.sockets[1].closed).toBe(true)
    expect(r.lines.at(-1)).toEqual(['retrying', { attempt: 1, inMs: 2000 }])
    r.sockets[1].msg({ type: 'welcome', playerId: 'late', worldSeed: 77, roomId: 'lamp' })   // a socket let go of says nothing
    expect([r.c.lineState(), r.c.id]).toEqual(['retrying', 'me1'])
  })

  it('a line that falls again soon after it came back keeps its spacing; one that held a while starts over', async () => {
    const r = rig()
    await r.join()
    r.last().drop()
    r.clock.advance(1000); r.welcome('me2')               // back after one try
    r.clock.advance(5000); r.last().drop()                // falls again at once
    expect(r.lines.at(-1)).toEqual(['dropped', { attempt: 1, inMs: 2000 }])
    r.clock.advance(2000); r.welcome('me3')
    r.clock.advance(REJOIN.STEADY_MS); r.last().drop()    // it held
    expect(r.lines.at(-1)).toEqual(['dropped', { attempt: 0, inMs: 1000 }])
  })
})

describe('against the real LAN server (server/index.js)', () => {
  it('a socket that dies under the client comes back into the same room under the same name; the friend reads one line', async () => {
    const srv = await createServer(0, '127.0.0.1')
    const url = `ws://127.0.0.1:${srv.address().port}`
    const made = []
    class Rec extends WebSocket { constructor(u) { super(u); made.push(this) } }
    const until = async (fn, ms = 4000) => { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) throw new Error('timed out'); await sleepMs(10) } }
    try {
      const a = createMultiplayerClient(url, { WebSocket: Rec, random: () => 0 })
      const b = createMultiplayerClient(url, { WebSocket: Rec })
      const aLines = [], bChats = []
      a.onLine((s) => aLines.push(s)); b.onChat((...x) => bChats.push(x))
      const wa = await a.connect('lanroom', 4242, 'ada')
      await b.connect('lanroom', null, 'bo')
      expect(a.arrival()).toBe('walked')
      a.sendPos(3, 3, 0, 100)
      await until(() => b.getRemotePlayers().length === 1 && a.getRemotePlayers().length === 1)
      const firstId = a.id
      made[0].terminate()                                   // the line dies under the client: no disconnect() asked for it
      await until(() => aLines.includes('dropped'))
      expect(a.getRemotePlayers()).toEqual([])
      await until(() => aLines.includes('back'))
      expect(a.id).not.toBe(firstId)
      expect(a.arrival()).toBe('walked')                    // not settled again: bo was there, and it is still the first join's
      expect(made.length).toBe(3)                           // a's first, b's, a's rejoin
      await until(() => a.getRemotePlayers().length === 1)
      expect(a.getRemotePlayers()[0].name).toBe('bo')
      await until(() => bChats.some((c) => c[1] === CAME_BACK_LINE))
      expect(bChats.map((c) => [c[0], c[1]])).toEqual([['ada', LEFT_LINE], ['ada', CAME_BACK_LINE]])
      expect(wa.worldSeed).toBe(4242)
      a.disconnect(); b.disconnect()
    } finally { srv.close() }
  })
})

describe('a rejoin is not an arrival', () => {
  it('dropped in on others, then the relay restarts: the first socket back is told first: true, and it is still not a walk in', async () => {
    const r = rig()
    await r.join('me1', { first: false })
    expect(r.c.arrival()).toBe('dropped')
    r.last().drop(1001)                                   // a relay deploy goes away cleanly
    r.clock.advance(1000)
    r.welcome('me2', { first: true })                     // alone in the restarted room
    players(r.last(), [{ id: 'me2', x: 0, y: 0, name: 'ada' }])
    r.clock.advance(1000)
    expect(r.c.arrival()).toBe('dropped')
  })
  it('walked into an empty room, then back to a full one: still walked', async () => {
    const r = rig()
    await r.join('me1', { first: true })
    r.last().drop()
    r.clock.advance(1000)
    r.welcome('me2', { first: false })
    players(r.last(), [{ id: 'me2' }, { id: 'b', x: 1, y: 1, name: 'bo' }])
    expect(r.c.arrival()).toBe('walked')
  })
  it('an old server (no first): the first list decides; a rejoin\'s list never does, nor its timer', async () => {
    const r = rig()
    const p = r.c.connect('lamp', null, 'ada'); r.welcome('me1')
    await p
    players(r.last(), [{ id: 'me1' }, { id: 'b', x: 1, y: 1, name: 'bo' }])
    expect(r.c.arrival()).toBe('dropped')
    r.last().drop()
    r.clock.advance(1000); r.welcome('me2')
    players(r.last(), [{ id: 'me2' }])
    r.clock.advance(1000)
    expect(r.c.arrival()).toBe('dropped')
    // the line dropped before anything was known: the default stands, and the rejoin does not decide it
    const q = rig()
    const pq = q.c.connect('lamp', null, 'ada'); q.welcome('me1'); await pq
    q.last().drop()
    q.clock.advance(1000); q.welcome('me2')
    players(q.last(), [{ id: 'me2' }, { id: 'b', x: 1, y: 1, name: 'bo' }])
    q.clock.advance(1000)
    expect(q.c.arrival()).toBe('walked')
  })
})

describe('frames held for a listener that has not come yet', () => {
  it('go with the socket they came on; the next one\'s replay is held and handed to the first listener; with a listener, straight to it', async () => {
    const r = rig()
    await r.join('me1')
    r.last().msg({ type: 'ev', id: 'f', name: 'maddie', kind: 'cache', payload: { cx: 1 }, t: 1, replay: true })
    r.last().drop()
    r.clock.advance(1000); r.welcome('me2')
    r.last().msg({ type: 'ev', id: 'f', name: 'maddie', kind: 'cache', payload: { cx: 1 }, t: 2, replay: true })
    const evs = []
    r.c.onEv((m) => evs.push(m.t))
    expect(evs).toEqual([])                               // the hand-over is the next tick
    r.clock.advance(0)
    expect(evs).toEqual([2])                              // the dead socket's frame is not handed over beside its own replay
    r.last().drop()
    r.clock.advance(r.clock.next()); r.welcome('me3')     // (it fell again soon after it came back: the spacing goes on from 2 s)
    r.last().msg({ type: 'ev', id: 'f', name: 'maddie', kind: 'cache', payload: { cx: 1 }, t: 3, replay: true })
    r.last().msg({ type: 'ev', id: 'me3', name: 'ada', kind: 'whistle', payload: {}, t: 4 })   // my own: never
    expect(evs).toEqual([2, 3])
  })
})

describe('the flood close (4029) and disconnect() never retry', () => {
  it('FLOOD_CLOSE is 4029', () => { expect(FLOOD_CLOSE).toBe(4029) })
  it('closed for flooding after welcome: its own state, no try, and the press does nothing', async () => {
    const r = rig()
    await r.join()
    r.last().drop(FLOOD_CLOSE, 'too fast')
    expect(states(r.lines)).toEqual(['flood'])
    expect([r.c.lineState(), r.c.isConnected(), r.clock.size]).toEqual(['flood', false, 0])
    expect(r.c.rejoinNow()).toBe(false)
    r.clock.advance(10 * 60_000)
    expect(r.sockets.length).toBe(1)
  })
  it('a try the room closes for flooding: the tries stop there', async () => {
    const r = rig()
    await r.join()
    r.last().drop()
    r.clock.advance(1000); r.last().open(); r.last().drop(FLOOD_CLOSE)
    expect(states(r.lines)).toEqual(['dropped', 'flood'])
    r.clock.advance(10 * 60_000)
    expect(r.sockets.length).toBe(2)
    expect(r.c.rejoinNow()).toBe(false)
  })
  it('a first join closed for flooding rejects, says "too fast", and never tries', async () => {
    const r = rig()
    const p = r.c.connect('lamp', null, 'ada')
    r.last().drop(FLOOD_CLOSE)
    await expect(p).rejects.toThrow('too fast')
    r.clock.advance(60_000)
    expect([r.sockets.length, r.lines, r.c.lineState()]).toEqual([1, [], 'off'])
  })
  it('disconnect(): the close it causes is not a drop, and it stops a retry under way', async () => {
    const r = rig()
    await r.join()
    r.c.disconnect()
    r.sockets[0].drop(1000)
    r.clock.advance(10 * 60_000)
    expect([r.lines, r.sockets.length, r.c.lineState(), r.c.rejoinNow()]).toEqual([[], 1, 'off', false])
    const q = rig()
    await q.join()
    q.last().drop()
    q.clock.advance(1000)                                  // a try is open
    q.c.disconnect()
    q.last().drop()
    q.clock.advance(10 * 60_000)
    expect([states(q.lines), q.sockets.length, q.clock.next()]).toEqual([['dropped'], 2, Infinity])
  })
  it('a first join that fails rejects and never tries (connect() says it, index.html shows it)', async () => {
    const r = rig()
    const p = r.c.connect('lamp', null, 'ada')
    r.last().drop(1006)
    await expect(p).rejects.toThrow('connection closed before welcome')
    r.clock.advance(60_000)
    expect([r.sockets.length, r.lines]).toEqual([1, []])
  })
})

describe('the tries stop after four minutes; one press starts them over', () => {
  it('eleven tries spaced 1, 2, 4, 8, 16, then 30 s; the next would start past four minutes: gave-up, and nothing more', async () => {
    const r = rig()
    await r.join()
    r.last().drop()
    let tries = 0
    while (r.c.lineState() === 'retrying') { r.clock.advance(r.clock.next()); tries++; r.last().open(); r.last().drop(1006) }
    expect(tries).toBe(11)
    expect(r.clock.now()).toBe(211_000)                     // the eleventh failed here; a twelfth would start past four minutes
    expect(states(r.lines).at(-1)).toBe('gave-up')
    expect(waits(r.lines)).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000, 30000, 30000, 30000])
    r.clock.advance(60 * 60_000)
    expect(r.sockets.length).toBe(12)
    // the press still works after a give-up: a try at once, and it can come back
    expect(r.c.rejoinNow()).toBe(true)
    expect(r.sockets.length).toBe(13)
    expect(r.lines.at(-1)).toEqual(['retrying', { attempt: 0, inMs: 0 }])
    r.welcome('me9')
    expect([states(r.lines).at(-1), r.c.lineState()]).toEqual(['back', 'live'])
  })
  it('the press while a try waits its spacing: the wait is dropped, a try goes now, and the spacing starts over behind it', async () => {
    const r = rig()
    await r.join()
    r.last().drop()
    for (let i = 0; i < 3; i++) { r.clock.advance(r.clock.next()); r.last().open(); r.last().drop() }
    expect(r.clock.next()).toBe(8000)
    const n = r.sockets.length
    expect(r.c.rejoinNow()).toBe(true)
    expect([r.sockets.length, r.clock.next()]).toEqual([n + 1, Infinity])
    r.last().open(); r.last().drop()
    expect(r.lines.at(-1)).toEqual(['retrying', { attempt: 1, inMs: 2000 }])
    // a press while a try is already open is that try: no second socket
    r.clock.advance(2000)
    const m = r.sockets.length
    expect(r.c.rejoinNow()).toBe(true)
    expect(r.sockets.length).toBe(m)
    // and the four minutes count from the press
    r.last().drop()
    let tries = 0
    while (r.c.lineState() === 'retrying') { r.clock.advance(r.clock.next()); tries++; r.last().drop() }
    expect(tries).toBe(11)
  })
  it('never while the line holds', async () => {
    const r = rig()
    expect(r.c.rejoinNow()).toBe(false)
    await r.join()
    expect(r.c.rejoinNow()).toBe(false)
    expect(r.sockets.length).toBe(1)
  })
})

describe('stillFor is read when it is asked', () => {
  it('grows between two lists, and a move resets it', async () => {
    const r = rig()
    await r.join()
    const list = (x) => players(r.last(), [{ id: 'me1' }, { id: 'b', x, y: 1, angle: 0, name: 'bo' }])
    list(5)
    expect(r.c.getRemotePlayers()[0].stillFor).toBe(0)
    r.clock.advance(2500)                                  // no list for 2.5 s (a parked friend, a quiet room)
    expect(r.c.getRemotePlayers()[0].stillFor).toBe(2.5)
    r.clock.advance(500)
    expect(r.c.getRemotePlayers()[0].stillFor).toBe(3)
    list(5.01)                                             // the list barely moves: still
    r.clock.advance(1000)
    expect(r.c.getRemotePlayers()[0].stillFor).toBe(4)
    list(6)
    expect(r.c.getRemotePlayers()[0].stillFor).toBe(0)
    expect(clientSrc).toContain('stillFor: p.stillSince == null ? 0 : Math.max(0, (t - p.stillSince) / 1000)')
  })
})

describe('the hold: a line that has said nothing for two seconds sends a position now and then, and its typing waits', () => {
  it('steady play holds nothing; quiet, one position a second; the room speaks, and every one goes again with the typing it held', async () => {
    expect(HOLD).toEqual({ QUIET_MS: 2000, PROBE_MS: 1000, BYTES: 1024 })
    const r = rig()
    await r.join()
    const s = r.last()
    const sent = (type) => s.sent.filter((f) => f.type === type)
    // the room answers each position with a list (relay.js pushPlayers; a LAN server every 50 ms): nothing is held
    for (let i = 0; i < 40; i++) { r.c.sendPos(i, 0, 0, 100); players(s, [{ id: 'me1', x: i, y: 0 }]); r.clock.advance(50) }
    expect(sent('pos').length).toBe(40)
    // the line stalls: nothing comes back. For two seconds every position still goes, then one a second
    const stall = (ms) => { for (let k = 0; k < ms / 50; k++) { r.clock.advance(50); r.c.sendPos(k, 1, 0, 100) } }
    stall(2000)
    expect(sent('pos').length).toBe(80)                       // 39 inside the two seconds, and the first of the probes
    stall(10_000)
    expect(sent('pos').length).toBe(90)                       // ten seconds quiet: ten positions, not two hundred
    stall(13 * 60_000)                                        // as long as a stalled TCP connection lives (Linux gives up at about 15 min)
    expect(sent('pos').length).toBe(90 + 13 * 60)
    // typing waits while it is quiet: only the last one asked for, and only once the line speaks
    r.c.sendTyping(true); r.c.sendTyping(false); r.c.sendTyping(true)
    expect(sent('typing')).toEqual([])
    players(s, [{ id: 'me1' }])
    expect(sent('typing')).toEqual([{ type: 'typing', on: true }])
    players(s, [{ id: 'me1' }])
    expect(sent('typing').length).toBe(1)                     // said once
    const n = sent('pos').length
    r.c.sendPos(9, 9, 0, 100); r.c.sendPos(9, 9, 0, 100); r.c.sendTyping(false)
    expect([sent('pos').length - n, sent('typing').at(-1)]).toEqual([2, { type: 'typing', on: false }])
  })
  it('chat and ev frames are never held; a socket with more than a kilobyte waiting holds positions too; a dropped line forgets held typing', async () => {
    const r = rig()
    await r.join()
    const s = r.last()
    r.clock.advance(5000)                                     // quiet
    r.c.sendChat('hello'); r.c.sendEv('whistle', { x: 1 })
    expect(s.sent.map((f) => f.type)).toEqual(['join', 'chat', 'ev'])
    players(s, [{ id: 'me1' }])
    s.bufferedAmount = 4096                                   // the socket itself could not hand it on yet
    r.c.sendPos(1, 1, 0, 100); r.c.sendPos(1, 1, 0, 100); r.c.sendTyping(true)
    expect(s.sent.filter((f) => f.type === 'pos').length).toBe(1)
    s.bufferedAmount = 0
    r.c.sendPos(2, 2, 0, 100)
    expect(s.sent.filter((f) => f.type === 'pos').length).toBe(2)
    r.clock.advance(5000)
    r.c.sendTyping(false)                                     // held by the quiet line ...
    s.drop()                                                  // ... which drops: it is not carried to the next socket
    r.clock.advance(1000); const s2 = r.welcome('me2')
    players(s2, [{ id: 'me2' }])
    expect(s2.sent.map((f) => f.type)).toEqual(['join'])
    expect(clientSrc).not.toMatch(/bufferedAmount\s*=/)        // read, never written
  })
})

describe('a friend\'s line coming back is one quiet line', () => {
  it('a leave and a join under the same name within ninety seconds: "\'s line came back."; later, or another name: today\'s two lines', async () => {
    const r = rig()
    await r.join()
    const s = r.last()
    s.msg({ type: 'left', id: 'b', name: 'bo' })
    r.clock.advance(30_000)
    s.msg({ type: 'joined', id: 'b2', name: 'bo' })
    s.msg({ type: 'left', id: 'c', name: 'cy' })
    r.clock.advance(COMEBACK_MS + 1)
    s.msg({ type: 'joined', id: 'c2', name: 'cy' })
    s.msg({ type: 'joined', id: 'd', name: 'dee' })
    s.msg({ type: 'joined', id: 'b3', name: 'bo' })          // the pair was spent on the first
    expect(r.chats).toEqual([
      ['bo', LEFT_LINE, true, 'b'], ['bo', CAME_BACK_LINE, true, 'b2'],
      ['cy', LEFT_LINE, true, 'c'], ['cy', JOINED_LINE, true, 'c2'],
      ['dee', JOINED_LINE, true, 'd'], ['bo', JOINED_LINE, true, 'b3'],
    ])
    expect([JOINED_LINE, LEFT_LINE]).toEqual(['entered the level.', 'no-clipped away.'])   // today's two lines, unchanged
    expect(COMEBACK_MS).toBe(90_000)
  })
  it('the names in the room when my own line dropped, coming in after I am back, came back too; my own old socket is neither a ghost nor a leave', async () => {
    const r = rig()
    await r.join('me1')
    players(r.last(), [{ id: 'me1' }, { id: 'b', x: 1, y: 1, name: 'bo' }])
    r.last().drop()
    r.clock.advance(1000); r.welcome('me2')
    const s = r.last()
    players(s, [{ id: 'me2' }, { id: 'me1', x: 9, y: 9, name: 'ada' }])   // the room has not noticed my old socket is dead
    expect(r.c.getRemotePlayers()).toEqual([])
    s.msg({ type: 'left', id: 'me1', name: 'ada' })
    s.msg({ type: 'joined', id: 'b2', name: 'bo' })
    expect(r.chats).toEqual([['bo', CAME_BACK_LINE, true, 'b2']])
  })
  it('the blank name many share is never one line: a "wanderer" leaving and another arriving are two people, folded into nothing', async () => {
    expect(SHARED_NAMES).toEqual(NAME_CAP_EXEMPT)                // the same blank one the caches and the relay's log count per id
    const r = rig()
    await r.join()
    const s = r.last()
    s.msg({ type: 'joined', id: 'p1', name: 'wanderer' })
    r.clock.advance(5000)
    s.msg({ type: 'left', id: 'p1', name: 'wanderer' })
    r.clock.advance(30_000)
    s.msg({ type: 'joined', id: 'p2', name: 'wanderer' })        // a stranger, also unnamed
    s.msg({ type: 'left', id: 'q', name: '' })                   // and a frame with no name at all ('someone')
    s.msg({ type: 'joined', id: 'q2', name: '' })
    expect(r.chats.map(([n, t]) => [n, t])).toEqual([
      ['wanderer', JOINED_LINE], ['wanderer', LEFT_LINE], ['wanderer', JOINED_LINE], ['someone', LEFT_LINE], ['someone', JOINED_LINE],
    ])
    const log = r.chats.map(([from, text, sys]) => ({ from, text, sys }))
    expect(foldChat(log)).toBe(log)                              // the first one's leaving stays said
    // nor does my own drop count a wanderer who was in the room
    players(s, [{ id: 'me1' }, { id: 'p2', x: 1, y: 1, name: 'wanderer' }])
    s.drop()
    r.clock.advance(1000); r.welcome('me2')
    r.last().msg({ type: 'joined', id: 'p3', name: 'wanderer' })
    expect(r.chats.at(-1)).toEqual(['wanderer', JOINED_LINE, true, 'p3'])
  })
  it('a name the room still lists after my own line came back never left: a newcomer under it later enters the level', async () => {
    const r = rig()
    await r.join('me1')
    players(r.last(), [{ id: 'me1' }, { id: 'b', x: 1, y: 1, name: 'bo' }, { id: 'c', x: 2, y: 2, name: 'cy' }])
    r.last().drop()
    r.clock.advance(1000); r.welcome('me2')
    const s = r.last()
    players(s, [{ id: 'me2' }, { id: 'b', x: 1, y: 1, name: 'bo' }])   // bo never left; cy dropped with me
    r.clock.advance(30_000)
    s.msg({ type: 'joined', id: 'b9', name: 'bo' })              // someone new under bo's name (bo is still here)
    s.msg({ type: 'joined', id: 'c2', name: 'cy' })              // cy coming in after me: her line came back
    expect(r.chats).toEqual([['bo', JOINED_LINE, true, 'b9'], ['cy', CAME_BACK_LINE, true, 'c2']])
    const log = r.chats.map(([from, text, sys]) => ({ from, text, sys }))
    expect(foldChat([{ from: 'bo', text: LEFT_LINE, sys: true }, ...log]).length).toBe(3)   // nothing of bo's folds: no came-back of his
  })
  it('the chat log folds the leave into it: "— bo\'s line came back."; an unanswered leave and every other line read as they did', () => {
    const L = [
      { from: 'bo', text: LEFT_LINE, sys: true }, { from: 'cy', text: 'hi', sys: false }, { from: 'bo', text: CAME_BACK_LINE, sys: true },
      { from: 'dee', text: LEFT_LINE, sys: true }, { from: '', text: 'connected — Enter to chat · /me to emote · /invite for a link', sys: true },
    ]
    const shown = foldChat(L)
    expect(shown.map((l) => (l.sys ? sysText(l.from, l.text) : `${l.from}: ${l.text}`))).toEqual([
      'cy: hi', "— bo's line came back.", '— dee no-clipped away.', '—  connected — Enter to chat · /me to emote · /invite for a link',
    ])
    const plain = [{ from: 'bo', text: LEFT_LINE, sys: true }, { from: 'bo', text: JOINED_LINE, sys: true }]
    expect(foldChat(plain)).toBe(plain)
    // a leave with another line of theirs between is not the one it answers
    const between = [{ from: 'bo', text: LEFT_LINE, sys: true }, { from: 'bo', text: 'whistles · near ↑', sys: true }, { from: 'bo', text: CAME_BACK_LINE, sys: true }]
    expect(foldChat(between)).toBe(between)
    expect(sysText('bo', 'whistles · near ↑')).toBe('— bo whistles · near ↑')
  })
  it('game.js renders the log through foldChat and sysText', () => {
    const render = slice(game, 'function renderChat() {', '.join(\'\')')
    expect(render).toContain('chatLogEl.innerHTML = foldChat(chatLines).map(l => {')
    expect(render).toContain('if (l.sys) return `<div class="chat-sys">${escapeHtml(sysText(l.from, l.text))}</div>`')
  })
})

// ── the caches: game.js's own handler, lifted, over the real bus, ledger, items and floors' memory ──
describe('a returning player\'s caches: the relay\'s replay after a rejoin is laid once', () => {
  const cacheOn = slice(game, "bus.on('cache', ({ id, name, payload: p, replay }) => {", '\n    })')
  const removeSrc = slice(game, '  function removeCache(e) {', '\n  }')
  const regCache = lineOf(game, "bus.register('cache', ")
  const ITEM_NAMES = { 'almond-water': 'almond water', radio: 'radio', bandage: 'bandage', glowstick: 'glowstick' }
  function world(selfId) {
    let t = 10000
    const me = { id: selfId }
    const bus = createEvBus({ send: () => {}, now: () => t, self: () => ({ x: 10, y: 10, lvl: 1 }), peerPos: () => null, peerIds: () => new Set(), selfId: () => me.id })
    new Function('bus', 'isCachePayload', 'ITEM_NAMES', regCache)(bus, isCachePayload, ITEM_NAMES)
    const items = createItemSystem({ ...DEFAULT_CONFIG }, () => false, 0), ledger = createCacheLedger(), mem = createLevelMemory()
    const level = { index: 1, grid: { floor: () => true } }, said = []
    const removeCache = new Function('level', 'itemSys', 'mem', `${removeSrc}\nreturn removeCache`)(level, items, mem)
    new Function('bus', 'level', 'cacheKey', 'ledger', 'playT', 'extraFor', 'removeCache', 'findOpenNear', 'itemSys', 'addChatLine', cacheOn)(
      bus, level, cacheKey, ledger, 7, extraFor, removeCache, findOpenNear, items, (...a) => said.push(a))
    return { bus, items, ledger, mem, me, said, tick: (ms) => { t += ms } }
  }
  // what throwSelected does with a word: the dropped record, the ledger's entry with its payload, the frame the room hears
  function setDown(w, { by = 'ada', byId = 'me1', type = 'radio', on = true, x = 12.5, y = 10.5, ph = 3, oct = 2 } = {}) {
    const cx = Math.floor(x), cy = Math.floor(y), key = cacheKey(1, cx, cy)
    const it = w.items.dropAt(x, y, type, { on, ph, oct, by, byId, cacheKey: key }, 1000)
    const p = { lvl: 1, cx, cy, x, y, type, ex: {}, ph, oct }
    w.ledger.place({ key, lvl: 1, cx, cy, id: byId, name: by, t: 7, p })
    w.ledger.bind(key, it.key)
    return { key, p, it }
  }
  const replayOf = (id, name, p, n) => ({ type: 'ev', id, name, kind: 'cache', payload: { ...p, n }, t: 1, replay: true })

  it('throwSelected hands the ledger the frame it sends; the handler asks isEcho before it lays a replay; F remembers a take by hand', () => {
    const thrown = slice(game, 'function throwSelected(note = null) {', "relayLater('cache', p, { keep: ck })")
    expect(thrown).toContain('const p = { lvl: level.index, cx, cy, x: r.x, y: r.y, type: t, ex: exOf(r.item), ph: note.ph, oct: note.oct }')
    expect(thrown).toContain('const old = ledger.place({ key: ck, lvl: level.index, cx, cy, id: myId(), name: myName(), t: playT, p })')
    expect(cacheOn.indexOf('if (replay && ledger.isEcho(key, id, name, p)) return')).toBeLessThan(cacheOn.indexOf('const r = ledger.place({'))
    expect(cacheOn).toContain('const r = ledger.place({ key, lvl: p.lvl, cx: p.cx, cy: p.cy, id, name, t: playT, p, pending:')
    expect(game).toContain('ledger.take(res.item.cacheKey, true)')
  })
  it('my own talking radio, handed back under my old id after the rejoin: not laid a second time, and still talking', () => {
    const w = world('me1')
    const { key, p } = setDown(w)
    w.me.id = 'me2'                                        // the rejoin's new id: the client no longer knows the old one's frames as mine
    expect(w.bus.receive(replayOf('me1', 'ada', p, 4))).toBe(true)
    expect(w.items.getDropped()).toEqual([{ x: 12.5, y: 10.5, type: 'radio', on: true, onUntil: w.items.getDropped()[0].onUntil, ph: 3, oct: 2, by: 'ada', byId: 'me1', cacheKey: key }])
    expect(w.items.getDropped()[0].onUntil).toBeGreaterThan(1000)
    expect(w.ledger.size).toBe(1)
    expect(w.said).toEqual([])
    // the same again (a second rejoin), and under a later id of mine with my name: once
    expect(w.bus.receive(replayOf('me1', 'ada', p, 4))).toBe(false)   // the bus's nonce already has it
    expect(w.bus.receive(replayOf('me0', 'ada', p, 9))).toBe(true)
    expect(w.items.getDropped().length).toBe(1)
  })
  it('a cache I carried off while the line was dead is not put back by the replay', () => {
    const w = world('me1')
    const { key, p, it } = setDown(w, { type: 'bandage', on: false })
    expect(w.items.pickUp(it.key).ok).toBe(true)
    w.ledger.take(key, true)
    w.me.id = 'me2'
    expect(w.bus.receive(replayOf('me1', 'ada', p, 5))).toBe(true)
    expect([w.items.getDropped(), w.items.inventory.map((i) => i.type), w.ledger.get(key)]).toEqual([[], ['bandage'], null])
  })
  it('a friend\'s cache I carried off: the replay of that very frame is not laid again; the same thing set down there again since is', () => {
    const w = world('me1')
    const p = { lvl: 1, cx: 12, cy: 10, x: 12.5, y: 10.5, type: 'glowstick', ex: {}, ph: 3, oct: 2 }
    expect(w.bus.receive(replayOf('bo1', 'bo', p, 7))).toBe(true)
    const key = cacheKey(1, 12, 10), d = w.items.getDropped()
    expect(d.map((x) => [x.byId, x.cacheKey])).toEqual([['bo1', key]])
    // I pick it up by hand (game.js F): the take may reach the relay only after the next replay
    expect(w.items.pickUp(w.ledger.localKey(key)).ok).toBe(true)
    w.ledger.take(key, true)
    expect(w.items.getDropped()).toEqual([])
    // the relay's replay of that very frame (its sender's id and nonce, once the bus's own memory of it is gone): an echo
    expect(w.ledger.isEcho(key, 'bo1', 'bo', { ...p, n: 7 })).toBe(true)
    // bo set the same glowstick with the same word down there again while my line was dead: a new frame, and it is laid
    expect(w.ledger.isEcho(key, 'bo1', 'bo', { ...p, n: 12 })).toBe(false)
    expect(w.ledger.isEcho(key, 'bo2', 'bo', { ...p, n: 7 })).toBe(false)       // under a new id of theirs: a new frame too
    expect(w.bus.receive(replayOf('bo1', 'bo', p, 12))).toBe(true)
    expect(w.ledger.get(key)).toMatchObject({ id: 'bo1', name: 'bo' })
    // a cache whose frame the ledger never saw (my own, set down before it went out): by owner and thing, as before
    const l = createCacheLedger()
    l.place({ key: 'c:1:2,2', lvl: 1, cx: 2, cy: 2, id: 'me1', name: 'ada', p: { type: 'radio', ph: 1, oct: 0 } })
    l.take('c:1:2,2', true)
    expect(l.isEcho('c:1:2,2', 'me1', 'ada', { type: 'radio', ph: 1, oct: 0, n: 40 })).toBe(true)
  })
  it('a friend\'s cache on its own floor, waiting, is laid once when the replay comes again; their nonce is the first guard', () => {
    const w = world('me1')
    const p = { lvl: 2, cx: 3, cy: 3, x: 3.5, y: 3.5, type: 'glowstick', ex: {}, ph: 1, oct: 0 }
    expect(w.bus.receive(replayOf('f', 'maddie', p, 1))).toBe(true)
    expect(w.ledger.pendingFor(2).map((e) => e.key)).toEqual(['c:2:3,3'])
    expect(w.bus.receive(replayOf('f', 'maddie', p, 1))).toBe(false)              // the nonce
    expect(w.bus.receive(replayOf('f2', 'maddie', p, 1))).toBe(true)               // her new id after her own rejoin, the same thing: an echo
    expect(w.ledger.pendingFor(2).map((e) => [e.key, e.id])).toEqual([['c:2:3,3', 'f']])
  })
  it('anything else for the key is news, as before: another owner, another thing, the blank name under another id, a live frame', () => {
    const w = world('me1')
    const { key, p } = setDown(w, { by: 'wanderer', byId: 'me1', type: 'bandage', on: false })
    w.me.id = 'me2'
    expect(w.bus.receive(replayOf('w9', 'wanderer', p, 1))).toBe(true)               // another wanderer: the blank name proves nothing
    expect(w.items.getDropped().map((d) => d.byId)).toEqual(['w9'])
    expect(w.bus.receive(replayOf('w9', 'wanderer', { ...p, ph: 5 }, 2))).toBe(true) // the same owner, another word
    expect(w.items.getDropped().map((d) => [d.byId, d.ph])).toEqual([['w9', 5]])
    expect(w.bus.receive(replayOf('z', 'zed', { ...p, ph: 5 }, 1))).toBe(true)       // another owner
    expect(w.items.getDropped().map((d) => d.byId)).toEqual(['z'])
    expect(w.ledger.get(key)).toMatchObject({ id: 'z', name: 'zed' })
  })
  it('the ledger on its own: isEcho by key, owner (name past a new id, never the blank one) and thing; a set-down on the cell retires a hand take', () => {
    const l = createCacheLedger()
    const p = { type: 'radio', ph: 2, oct: 1, ex: { sour: true } }
    l.place({ key: 'c:1:1,1', lvl: 1, cx: 1, cy: 1, id: 'a', name: 'ada', p })
    expect(l.isEcho('c:1:1,1', 'a', 'ada', p)).toBe(true)
    expect(l.isEcho('c:1:1,1', 'a2', 'ada', { ...p, n: 9 })).toBe(true)
    expect(l.isEcho('c:1:1,1', 'b', 'bo', p)).toBe(false)
    expect(l.isEcho('c:1:1,1', 'a', 'ada', { ...p, ex: {} })).toBe(false)
    expect(l.isEcho('c:1:2,2', 'a', 'ada', p)).toBe(false)
    expect(l.isEcho('c:1:1,1', 'a', 'ada', null)).toBe(false)
    l.place({ key: 'c:1:5,5', lvl: 1, cx: 5, cy: 5, id: 'w1', name: 'wanderer', p })
    expect([l.isEcho('c:1:5,5', 'w1', 'wanderer', p), l.isEcho('c:1:5,5', 'w2', 'wanderer', p)]).toEqual([true, false])
    // a take that was not by hand (a friend's, or nothing open to lay it on) leaves nothing behind
    l.take('c:1:1,1')
    expect(l.isEcho('c:1:1,1', 'a', 'ada', p)).toBe(false)
    l.place({ key: 'c:1:1,1', lvl: 1, cx: 1, cy: 1, id: 'a', name: 'ada', p })
    l.take('c:1:1,1', true)
    expect(l.isEcho('c:1:1,1', 'a', 'ada', p)).toBe(true)
    l.place({ key: 'c:1:1,1', lvl: 1, cx: 1, cy: 1, id: 'b', name: 'bo', p: { ...p, ph: 0 } })
    l.take('c:1:1,1')
    expect(l.isEcho('c:1:1,1', 'a', 'ada', p)).toBe(false)
    // what a floor holds is known by its record (rebind), a save's pending by its extra; the snapshot carries none of it
    const m = createCacheLedger()
    m.rebind(1, [{ key: 'd:4', x: 3.5, y: 3.5, type: 'bandage', ph: 1, oct: 0, by: 'ada', byId: 'a', cacheKey: 'c:1:3,3' }])
    expect(m.isEcho('c:1:3,3', 'a', 'ada', { type: 'bandage', ph: 1, oct: 0, ex: {} })).toBe(true)
    m.place({ key: 'c:2:3,3', lvl: 2, cx: 3, cy: 3, id: 'a', name: 'ada', pending: { x: 3.5, y: 3.5, type: 'radio', extra: extraFor({ ph: 4, oct: 1, ex: { tool: true } }, 'a', 'ada', 'c:2:3,3') } })
    expect(m.isEcho('c:2:3,3', 'a', 'ada', { type: 'radio', ph: 4, oct: 1, ex: { tool: true } })).toBe(true)
    const snap = m.snapshot()
    expect(JSON.stringify(snap)).not.toMatch(/sig|\|/)
    const n = createCacheLedger(); n.restore(snap)
    expect(n.isEcho('c:2:3,3', 'a', 'ada', { type: 'radio', ph: 4, oct: 1, ex: { tool: true } })).toBe(true)
    expect(n.isEcho('c:1:3,3', 'a', 'ada', { type: 'bandage', ph: 1, oct: 0, ex: {} })).toBe(false)   // known again once its floor rebinds
    expect(cacheSig('radio', 2, 1, true, false)).toBe('radio|2|1|10')
    // the hand takes are bounded
    const h = createCacheLedger()
    for (let i = 0; i <= HAND_TAKES_KEPT; i++) { h.place({ key: `c:1:${i},0`, lvl: 1, cx: i, cy: 0, id: 'a', name: 'ada', p }); h.take(`c:1:${i},0`, true) }
    expect([h.isEcho('c:1:0,0', 'a', 'ada', p), h.isEcho(`c:1:${HAND_TAKES_KEPT},0`, 'a', 'ada', p)]).toEqual([false, true])
  })
})

describe('while the line is down the bus sends nothing; the take waits in the outbox and goes when it is back', () => {
  const relaySrc = lineOf(game, 'function relayLater(kind, payload, opts) {')
  const flushSrc = lineOf(game, 'if (bus) while (evOutbox.length && bus.ready(')
  it('the bus is handed the client\'s isConnected', () => {
    expect(game).toContain('selfId: () => mpClient.id, mergeRemote: mpClient.mergeRemote, live: mpClient.isConnected,')
  })
  it('emit and ready say no, the heartbeat keeps its change; back, the take goes and the heartbeat at once', () => {
    let t = 10000, live = false
    const sent = []
    const bus = createEvBus({ send: (k, p, o) => sent.push([k, { ...p }, o]), now: () => t, self: () => ({ x: 1, y: 1, lvl: 1 }), peerPos: () => null, peerIds: () => new Set(), selfId: 'me', live: () => live })
    bus.register('take', { check: (p) => typeof p.key === 'string', replayable: true, minGapMs: 500 })
    const evOutbox = []
    const relayLater = new Function('bus', 'evOutbox', `${relaySrc}\nreturn relayLater`)(bus, evOutbox)
    const flush = new Function('bus', 'evOutbox', 'OUTBOX_MARGIN_MS', flushSrc)
    expect(bus.ready('take')).toBe(false)
    relayLater('take', { key: 'c:1:5,5' }, { drop: 'c:1:5,5' })
    bus.here({ lvl: 1, lit: true, st: 'ok', seen: false, o: null, thin: false, status: 'notice-mailed', aseed: null })
    for (let i = 0; i < 10; i++) { t += 1000; flush(bus, evOutbox, 250); bus.tick(t) }
    expect([sent, evOutbox.length]).toEqual([[], 1])
    live = true
    flush(bus, evOutbox, 250); bus.tick(t)
    expect(sent.map(([k, p, o]) => [k, p.key ?? p.lvl, o?.drop])).toEqual([['take', 'c:1:5,5', 'c:1:5,5'], ['here', 1, undefined]])
    expect(evOutbox).toEqual([])
    // and the rest of the time, as before: a bus with no live dep is always live
    const b2 = createEvBus({ send: () => {}, now: () => t, self: () => ({ x: 0, y: 0, lvl: 0 }), peerPos: () => null, peerIds: () => new Set(), selfId: 'me' })
    b2.register('take', { check: () => true, minGapMs: 500 })
    expect([b2.ready('take'), b2.emit('take', { key: 'k' })]).toEqual([true, true])
  })
})

// ── the game's side: the plate, the press, the key ──
describe('game.js: the dead line said, held, and called back in one press', () => {
  const block = slice(game, "  const lineEl = document.getElementById('line-notice')", '    renderLine()\n  }')
  function play({ touch = false, state = 'live', level = { index: 1, cfg: {} } } = {}) {
    const el = { hidden: true, textContent: '', kids: [], listeners: {}, appendChild(d) { this.kids.push(d.textContent) }, addEventListener(k, f) { this.listeners[k] = f } }
    Object.defineProperty(el, 'textContent', { get() { return this._t ?? '' }, set(v) { this._t = v; this.kids = [] } })
    const doc = { getElementById: (id) => (id === 'line-notice' ? el : null), createElement: () => ({ textContent: '' }) }
    const said = [], heres = [], presses = []
    let s = state, cb = null
    const mp = { lineState: () => s, onLine: (f) => { cb = f }, rejoinNow: () => { presses.push(s); if (s !== 'retrying' && s !== 'gave-up') return false; s = 'retrying'; return true } }
    const bus = { here: (f) => heres.push(f) }
    const api = new Function('document', 'mpClient', 'lineNotice', 'isTouchDevice', 'showMessage', 'PRIO', 'LINE', 'bus', 'hereFields', 'level',
      `${block}\nreturn { renderLine, callLineBack, lineDown }`)(doc, mp, lineNotice, () => touch, (m, p) => said.push([m, p]), { interaction: 2 }, LINE, bus, () => 'here!', level)
    const go = (next, info = {}) => { s = next === 'dropped' ? 'retrying' : next === 'back' ? 'live' : next; cb(next, info) }
    return { el, said, heres, presses, api, go, rows: () => (el.hidden ? null : el.kids) }
  }
  it('dropped: the line once, and the plate holds it with the press; back: said, the plate goes, the heartbeat goes', () => {
    const g = play()
    expect([g.rows(), g.said]).toEqual([null, []])
    g.go('dropped', { inMs: 1000 })
    expect(g.said).toEqual([['the line went dead. the others are gone.', 2]])
    expect(g.rows()).toEqual(['the line went dead. the others are gone.', LINE.TRYING, 'r · call the line back'])
    g.go('retrying', { inMs: 2000 })
    expect(g.said.length).toBe(1)                           // a quiet line: the plate, not #msg
    g.go('gave-up')
    expect(g.rows()).toEqual([LINE.DEAD, LINE.GAVE_UP, LINE.PRESS_KEY])
    g.el.listeners.click({ preventDefault() {} })           // the press still works after a give-up
    expect([g.presses, g.rows()]).toEqual([['gave-up'], [LINE.DEAD, LINE.TRYING, LINE.PRESS_KEY]])
    g.go('back')
    expect([g.rows(), g.said.at(-1), g.heres]).toEqual([null, [LINE.BACK, 2], ['here!']])
    g.api.callLineBack()                                    // the line holds: a press does nothing
    expect(g.presses).toEqual(['gave-up'])
  })
  it('a touch screen is told to tap the plate; a flood close is its own plate with no press, and a tap on it asks for nothing', () => {
    const g = play({ touch: true })
    g.go('dropped')
    expect(g.rows()).toEqual([LINE.DEAD, LINE.TRYING, 'tap · call the line back'])
    g.go('flood')
    expect([g.rows(), g.said.at(-1)]).toEqual([[LINE.FLOOD], [LINE.FLOOD, 2]])
    g.el.listeners.click({ preventDefault() {} })
    expect(g.presses).toEqual([])
  })
  it('a line that dropped while the world was still loading is said when the game comes up', () => {
    const g = play({ state: 'retrying' })
    expect([g.said, g.rows()]).toEqual([[[LINE.DEAD, 2]], [LINE.DEAD, LINE.TRYING, LINE.PRESS_KEY]])
  })
  it('nothing of it on the block (Level ∅): no plate, no line — a room never reaches it, and nothing new is said there', () => {
    const g = play({ level: { index: 4, cfg: { map: {} } } })
    g.go('dropped'); g.go('gave-up'); g.go('flood')
    expect([g.said, g.rows()]).toEqual([[], null])
    expect(read('src/renderer/topology.js')).toContain('return frontDoor && !online ? BLOCK : LOBBY')
  })
  it('R in the loop calls it back, in a room only; no other key, verb, disc or card has R', () => {
    const rLine = lineOf(game, "if (mpClient && K['KeyR'])")
    expect(rLine).toBe("if (mpClient && K['KeyR']) { K['KeyR'] = false; callLineBack() }")
    expect(game.split("'KeyR'").length - 1).toBe(2)          // that one line, and nothing else in the game
    const run = (mp, K) => { let n = 0; new Function('mpClient', 'K', 'callLineBack', rLine)(mp, K, () => n++); return n }
    const K = { KeyR: true }
    expect([run({}, K), K.KeyR]).toEqual([1, false])
    const solo = { KeyR: true }
    expect([run(null, solo), solo.KeyR]).toEqual([0, true])  // solo: the key map is as it was
    for (const f of ['src/renderer/input.js', 'src/renderer/touch.js', 'src/renderer/papercard.js', 'src/renderer/terminal.js', 'src/settings.js']) {
      expect(read(f), f).not.toContain('KeyR')
    }
    expect(CARD_KEYS).not.toContain('KeyR')
    expect([...ACTIONS, ...SITUATIONAL].map((a) => a.code)).not.toContain('KeyR')
    const manual = read('docs/manual.html')
    expect(manual.split('<kbd>R</kbd>').length - 1).toBe(3)   // its own row, the strip's list of what it leaves out, the online note
  })
  it('the plate sits in the chat stack, hidden, the one thing there a finger can press; the chat says no one hears a line typed while dead', () => {
    const stack = slice(html, '<div id="chat-stack">', '</div>\n  </div>')
    expect(stack).toContain('<div id="line-notice" role="button" aria-live="polite" hidden></div>')
    expect(html).toContain('#line-notice[hidden] { display: none; }')
    expect(slice(html, '#line-notice {', '}')).toContain('pointer-events: auto')
    expect(game).toContain("else if (t && mpClient && mpClient.isConnected()) mpClient.sendChat(t)")
    expect(game).toContain("else if (t) showMessage('no one is here to hear it.')")
  })
})

describe('every new line: lowercase, no digits, no exclamation, nothing a place could be read from', () => {
  it('the line\'s own lines and a friend\'s coming back', () => {
    const all = [...Object.values(LINE), CAME_BACK_LINE, sysText('bo', CAME_BACK_LINE)]
    expect(LINE.DEAD).toBe('the line went dead. the others are gone.')
    for (const s of all) {
      expect(s, s).toBe(s.toLowerCase())
      expect(s, s).not.toMatch(/[0-9!]/)
      expect(s, s).not.toMatch(/lat|lng|seed|tag|°/)
    }
    expect(lineNotice('live')).toBe(null); expect(lineNotice('off')).toBe(null); expect(lineNotice('joining')).toBe(null)
  })
})

describe('the movement-rate switch: world.json net.posHz, 5..20, default 20', () => {
  it('posHz / posGapS: at 20 the gap is the 0.05 s it always was', () => {
    expect(POS_HZ).toBe(20)
    expect(posGapS({ posHz: 20 })).toBe(0.05)
    expect(posGapS(undefined)).toBe(0.05)
    expect(posGapS({ posHz: 10 })).toBe(0.1)
    expect(posGapS({ posHz: 5 })).toBe(0.2)
    for (const bad of [{ posHz: 4 }, { posHz: 21 }, { posHz: 12.5 }, { posHz: '10' }, {}, null, 7, []]) expect(posHz(bad), JSON.stringify(bad)).toBe(20)
  })
  it('the shipped world.json carries it at 20, and the game sends a position on it', () => {
    const shipped = JSON.parse(read('src/renderer/world.json'))
    expect(shipped.net).toEqual({ posHz: 20 })
    expect(game).toContain('const POS_GAP_S = posGapS(base.net)')
    expect(game).toContain('if (mpClient?.isConnected() && netTimer >= POS_GAP_S) { netTimer = 0; mpClient.sendPos(player.x, player.y, player.angle, player.hp) }')
    expect(game).not.toContain('netTimer >= 0.05')
  })
  it('validate-world refuses anything but { posHz } with a whole number from 5 to 20; absent is fine', () => {
    const shipped = JSON.parse(read('src/renderer/world.json'))
    const { net: _n, ...without } = shipped
    expect(validateWorld(shipped)).toEqual({ ok: true })
    expect(validateWorld(without)).toEqual({ ok: true })
    for (const posHz of [5, 10, 20]) expect(validateWorld({ ...shipped, net: { posHz } })).toEqual({ ok: true })
    const NO = { ok: false, reason: 'net.posHz must be an integer from 5 to 20' }
    for (const net of [{ posHz: 4 }, { posHz: 21 }, { posHz: 0 }, { posHz: 10.5 }, { posHz: '10' }, {}, { posHz: 10, burst: 2 }, null, [], 20, 'fast'])
      expect(validateWorld({ ...shipped, net }), JSON.stringify(net)).toEqual(NO)
  })
})

// ── privacy pins ──
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (/\.(js|mjs|cjs|html|json|ts)$/.test(e.name)) out.push(p)
  }
  return out
}
describe('privacy: what the game asks for and what leaves it', () => {
  it('the game never asks for a location: no geolocation anywhere in src/', () => {
    const files = walk(path.join(root, 'src'))
    expect(files.length).toBeGreaterThan(50)
    for (const f of files) {
      const s = fs.readFileSync(f, 'utf8')
      expect(s.includes('geolocation'), path.relative(root, f)).toBe(false)
      expect(s.includes('getCurrentPosition') || s.includes('watchPosition'), path.relative(root, f)).toBe(false)
    }
  })
  it('the client sends five frame types and no others: join, pos, chat, typing, ev — in its source and on the wire, a rejoin included', async () => {
    const SENT = ['join', 'pos', 'chat', 'typing', 'ev']
    const typed = []
    for (let k = clientSrc.indexOf("{ type: '"); k >= 0; k = clientSrc.indexOf("{ type: '", k + 1)) {
      const a = k + "{ type: '".length
      typed.push(clientSrc.slice(a, clientSrc.indexOf("'", a)))
    }
    expect([...new Set(typed)].sort()).toEqual([...SENT].sort())
    const r = rig()
    await r.join()
    r.c.sendPos(1, 1, 0, 100); r.c.sendChat('hello'); r.c.sendTyping(true); r.c.sendEv('whistle', { x: 1 }, { keep: 'k' })
    r.last().drop(); r.clock.advance(1000); r.welcome('me2')
    r.c.sendPos(2, 2, 0, 100)
    const wire = r.sockets.flatMap((s) => s.sent)
    expect([...new Set(wire.map((f) => f.type))].sort()).toEqual([...SENT].sort())
    // each with exactly the fields it always had
    expect(wire.map((f) => Object.keys(f).sort().join())).toEqual([
      'name,roomId,type,worldSeed', 'angle,hp,type,x,y', 'text,type', 'on,type', 'keep,kind,payload,type', 'name,roomId,type,worldSeed', 'angle,hp,type,x,y',
    ])
    // the flood close is the one new signal, and it comes from the room, never from the client
    expect(clientSrc).not.toMatch(/\.close\(\s*4029|\.close\(\s*FLOOD_CLOSE/)
  })
  it('the bus knows eight ev kinds and no others; a ninth is refused both ways', () => {
    const kinds = []
    for (const [src, needle] of [[game, "bus.register('"], [busSrc, "  register('"]]) {
      for (let k = src.indexOf(needle); k >= 0; k = src.indexOf(needle, k + 1)) {
        const a = k + needle.length
        kinds.push(src.slice(a, src.indexOf("'", a)))
      }
    }
    expect(kinds.sort()).toEqual(['cache', 'here', 'kneel', 'photo', 'take', 'ward', 'whistle', 'woke'])
    const sent = []
    const bus = createEvBus({ send: (k) => sent.push(k), now: () => 0, self: () => ({ x: 0, y: 0, lvl: 0 }), peerPos: () => ({ x: 0, y: 0 }), peerIds: () => new Set(['f']), selfId: 'me' })
    expect(bus.emit('mark', { x: 1 })).toBe(false)
    expect(bus.receive({ id: 'f', name: 'f', kind: 'mark', payload: { x: 1, n: 1 }, t: 0 })).toBe(false)
    expect(sent).toEqual([])
  })
  it('the here heartbeat stays v:1: it sends v 1 and only its known fields, believes only v 1, and ignores fields it does not know', () => {
    const sent = []
    let t = 0
    const bus = createEvBus({ send: (k, p) => sent.push([k, { ...p }]), now: () => t, self: () => ({ x: 0, y: 0, lvl: 0 }), peerPos: () => null, peerIds: () => new Set(['f']), selfId: 'me' })
    bus.here({ lvl: 2, lit: true, st: 'ok', seen: false, o: 'tenant', thin: false, status: 'extension', aseed: 7, v: 2, wv: 'x', pin: 'a door' })
    expect(sent.length).toBe(1)
    const [kind, p] = sent[0]
    expect(kind).toBe('here')
    expect(p.v).toBe(1)
    expect(Object.keys(p).sort()).toEqual(['aseed', 'lit', 'lvl', 'n', 'o', 'seen', 'st', 'status', 'thin', 'v'])
    const here = (payload, n) => ({ id: 'f', name: 'f', kind: 'here', t: 0, payload: { lvl: 1, lit: true, st: 'ok', seen: false, o: null, thin: false, status: STATUSES[0], aseed: null, ...payload, n } })
    expect(bus.receive(here({ v: 2 }, 1))).toBe(false)
    expect(bus.receive(here({}, 2))).toBe(false)
    expect(bus.receive(here({ v: 1, extra: 'ignored' }, 3))).toBe(true)
    expect(bus.peers.get('f')).not.toHaveProperty('extra')
    expect(busSrc).toContain('(p.aseed === null || Number.isInteger(p.aseed)) && p.v === 1')
    expect(busSrc).toContain("const HERE_KEYS = ['lvl', 'lit', 'st', 'seen', 'o', 'thin', 'status', 'aseed']")
  })
})
