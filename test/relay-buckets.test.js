// test/relay-buckets.test.js — the relay guard (2.0.7). pos, chat and typing each have a pace (relay/evguard.js pace), on both
// servers: a frame over its limit is dropped and nothing is said, and a socket that keeps flooding is closed 4029 'too fast'. The
// atlas's two open writes, a check-in and a drop-in, pass one flood guard that every sender shares, kept by no address.
//
// The promise this file holds: an honest client never loses a frame in steady play and is never closed, whatever its line does;
// a flooder is closed. The honest client is made frame by frame the way game.js makes it (the frame loop, netTimer, the three
// keys of a line), so the proof is about the client as written, not a rate someone wrote down.
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'fs'
import { WebSocket } from 'ws'

vi.mock('cloudflare:workers', () => ({ DurableObject: class { constructor(ctx, env) { this.ctx = ctx; this.env = env } } }))

const relay = await import('../relay/relay.js')
const { Room, Gate, atlasOpenWrite } = relay
const worker = relay.default
const {
  pace, posBucket, chatBucket, typingBucket, floodStrike, evBucket,
  POS_RATE, POS_BURST, CHAT_RATE, CHAT_BURST, TYPING_RATE, TYPING_BURST, FLOOD_STRIKES, FLOOD_HEAL, FLOOD_CLOSE, FLOOD_REASON,
} = await import('../relay/evguard.js')
const serverGuard = await import('../server/evguard.js')
const { GATE_RULES, GLOBAL_GATE, DAY_MS, hashIp, gateKey } = await import('../relay/wishgate.js')
const { createServer } = await import('../server/index.js')

const raw = (p) => readFileSync(new URL(p, import.meta.url), 'utf8')
const read = (p) => raw(p).replace(/\r\n/g, '\n')         // the source guards read lines, whatever the checkout's line endings
const T0 = Date.UTC(2026, 10, 8, 21, 0, 0)
const MIN = 60_000

// mulberry32: the same draws on every run
function rng(seed) {
  return () => {
    seed = (seed + 0x6D2B79F5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// What an honest client sends, as game.js makes it. pos: the frame loop, each frame's time jittered ±40 % around 1/fps, its dt
// capped at 0.05 s, netTimer += dt, and at 0.05 s or more one pos and netTimer = 0. The hand: `lines` lines a second, three keys
// each, evenly (Enter opens the line; the letter sends typing on; Enter sends the chat, and closing the line sends typing off).
// Then the line: each frame arrives 20 to 170 ms after it was made, never before the one made ahead of it, and nothing arrives
// while the line is stalled (stalls: [from s, for s]): what would have come then comes all at once as it clears.
// -> [{ gen, t, type }] in arrival order, times in ms from 0
function honest({ seconds, fps = 60, lines = 0, stalls = [], seed = 1 }) {
  const r = rng(seed), out = []
  let t = 0, netTimer = 0
  while (t < seconds * 1000) {
    const frame = (1000 / fps) * (0.6 + 0.8 * r())
    t += frame
    netTimer += Math.min(frame / 1000, 0.05)
    if (netTimer >= 0.05) { netTimer = 0; out.push({ gen: t, type: 'pos' }) }
  }
  if (lines > 0) {
    const key = 1000 / lines / 3
    for (let s = 0; s < seconds * 1000; s += 1000 / lines) out.push({ gen: s + key, type: 'typing' }, { gen: s + 2 * key, type: 'chat' }, { gen: s + 2 * key, type: 'typing' })
  }
  out.sort((a, b) => a.gen - b.gen)
  let last = 0
  for (const f of out) {
    let at = Math.max(last, f.gen + 20 + 150 * r())
    for (const [from, len] of stalls) if (at >= from * 1000 && at < (from + len) * 1000) at = (from + len) * 1000
    f.t = last = at
  }
  return out
}

// every frame through pace, on one attachment -> how many passed, were dropped, would have closed the socket
function play(frames, att = {}) {
  const n = { pass: 0, drop: 0, close: 0 }
  for (const f of frames) n[pace(att, f.type, T0 + f.t)]++
  return n
}

// a sender at a steady rate -> the second it would be closed at (null: never, within `seconds`), and how many frames it sent
function flood(rate, type = 'pos', seconds = 600) {
  const att = {}
  let n = 0
  for (let t = 0; t < seconds * 1000; t += 1000 / rate) {
    n++
    if (pace(att, type, T0 + t) === 'close') return { at: t / 1000, frames: n }
  }
  return { at: null, frames: n }
}

describe('the limits are twice what an honest client sends at the most, read off the client', () => {
  const game = read('../src/renderer/game.js')
  const client = read('../src/net/client.js')
  it('pos: one when netTimer passes 0.05 s of play, netTimer back to 0, a frame\'s dt capped at 0.05 s: 20 a second at the most', () => {
    const line = game.split('\n').find((l) => l.includes('mpClient.sendPos('))
    expect(line).toContain('netTimer >=')
    expect(line).toContain('netTimer = 0; mpClient.sendPos(')
    expect(game).toContain('const dt = Math.min(rawMs / 1000, 0.05)')
    expect(game.split('mpClient.sendPos(').length - 1).toBe(1)
    // the model below is that loop: never two within 0.05 s of play, whatever the frame rate
    for (const fps of [20, 30, 60, 144, 240, 500]) {
      const pos = honest({ seconds: 60, fps, seed: fps }).map((f) => f.gen)
      for (let i = 1; i < pos.length; i++) expect(pos[i] - pos[i - 1]).toBeGreaterThanOrEqual(50 - 1e-9)
      expect(pos.length).toBeLessThanOrEqual(60 * 20 + 1)
    }
    expect(POS_RATE).toBeGreaterThanOrEqual(2 * 20)
  })
  it('chat: typed by hand, sent from one place, the line closing on its Enter: three keys a line, five lines a second from the fastest hand', () => {
    expect(game.split('mpClient.sendChat(').length - 1).toBe(1)
    const enter = game.slice(game.indexOf("chatInputEl?.addEventListener('keydown'"))
    expect(enter.indexOf('mpClient.sendChat(t)')).toBeLessThan(enter.indexOf('closeChat()\n'))
    const sendChat = client.slice(client.indexOf('function sendChat('))
    expect(sendChat.indexOf('if (!t) return')).toBeLessThan(sendChat.indexOf("ws.send(JSON.stringify({ type: 'chat'"))   // an empty line sends nothing
    expect(CHAT_RATE).toBeGreaterThanOrEqual(2 * 5)
  })
  it('typing: on with the first key of a line, off on the 1800 ms stop timer or as the line closes: two a line, ten a second', () => {
    expect(game).toContain('if (!typingSent) { typingSent = true; mpClient.sendTyping(true) }')
    expect(game).toContain('typingStopT = setTimeout(() => { typingSent = false; mpClient.sendTyping(false) }, 1800)')
    expect(game).toContain('if (typingSent) { typingSent = false; clearTimeout(typingStopT); mpClient?.sendTyping(false) }')
    expect(game.split('sendTyping(').length - 1).toBe(3)
    expect(TYPING_RATE).toBeGreaterThanOrEqual(2 * 10)
  })
  it('the bursts, the strikes and the close', () => {
    expect([POS_RATE, POS_BURST, CHAT_RATE, CHAT_BURST, TYPING_RATE, TYPING_BURST]).toEqual([40, 60, 10, 20, 20, 40])
    expect([FLOOD_STRIKES, FLOOD_HEAL]).toEqual([2400, 30])
    expect(FLOOD_CLOSE).toBe(4029)
    expect(FLOOD_REASON).toBe('too fast')
    // strikes heal faster than an honest client makes frames over any long stretch: pos 20 and a hand's two lines a second, 6
    expect(FLOOD_HEAL).toBeGreaterThan(20 + 2 * 3)
  })
})

describe('an honest client never loses a frame and is never closed', () => {
  it('ten minutes at full rate, at any frame rate, with the hand at its fastest the whole time: every frame passes', () => {
    for (const fps of [30, 60, 144, 240]) {
      const frames = honest({ seconds: 600, fps, lines: 5, seed: fps })
      const n = play(frames)
      expect([fps, n.drop, n.close]).toEqual([fps, 0, 0])
      expect(n.pass).toBe(frames.length)
      expect(frames.filter((f) => f.type === 'chat').length).toBe(3000)
    }
  })
  it('a line that stalls two and a half seconds hands over what it queued, and still nothing is lost', () => {
    const stalls = [[60, 2.5], [120, 2.5], [180, 2.5], [182.6, 2.5]]
    const frames = honest({ seconds: 240, lines: 5, stalls, seed: 7 })
    const clump = frames.filter((f) => f.t === (182.6 + 2.5) * 1000)
    expect(clump.length).toBeGreaterThan(70)                 // the stall really did bunch them
    expect(play(frames)).toEqual({ pass: frames.length, drop: 0, close: 0 })
  })
  it('stall after stall, up to a minute and a half each, never closes it (what is refused is stale: the next frame is newer)', () => {
    const stalls = [[60, 5], [120, 10], [200, 30], [300, 60], [420, 90], [520, 90], [620, 90], [720, 90]]
    const n = play(honest({ seconds: 900, lines: 2, stalls, seed: 3 }))
    expect(n.close).toBe(0)
    expect(n.drop).toBeGreaterThan(0)                        // the long ones did run over the bursts
  })
  it('ninety-second stalls back to back, a second of play between them, twenty times: never closed', () => {
    const stalls = Array.from({ length: 20 }, (_, i) => [10 + i * 91, 90])
    const n = play(honest({ seconds: 20 * 91 + 20, lines: 2, stalls, seed: 11 }))
    expect(n.close).toBe(0)
  })
  it('over a minute even with the hand at its fastest throughout the stall', () => {
    expect(play(honest({ seconds: 120, lines: 5, stalls: [[30, 65]], seed: 5 })).close).toBe(0)
  })
})

describe('a flooder is closed', () => {
  it('at a thousand a second, of any of the three, in under three seconds', () => {
    for (const type of ['pos', 'chat', 'typing']) {
      const f = flood(1000, type)
      expect([type, f.at != null && f.at < 3]).toEqual([type, true])
    }
  })
  it('a client sending pos every frame of a fast screen is closed in seconds; anything past its limit by more than the heal, in the end', () => {
    expect(flood(240).at).toBeLessThan(15)
    expect(flood(144).at).toBeLessThan(35)
    expect(flood(100).at).toBeLessThan(90)
    expect(flood(80).at).toBeLessThan(300)
  })
  it('at its limit nothing is refused; up to the limit and the heal it is clipped, never closed', () => {
    expect(play(Array.from({ length: 24_000 }, (_, i) => ({ t: i * 25, type: 'pos' })))).toEqual({ pass: 24_000, drop: 0, close: 0 })
    const n = play(Array.from({ length: 42_000 }, (_, i) => ({ t: i * (1000 / 70), type: 'pos' })))
    expect(n.close).toBe(0)
    expect(n.drop).toBeGreaterThan(10_000)
  })
  it('once out of strikes it stays out: the servers stop reading it, and pace keeps saying close', () => {
    const att = {}
    let t = T0
    while (pace(att, 'pos', t) !== 'close') t += 1
    expect(pace(att, 'chat', t)).toBe('pass')               // its own chat bucket is still full ...
    for (let i = 0; i < CHAT_BURST; i++) pace(att, 'chat', t)
    expect(pace(att, 'chat', t)).toBe('close')              // ... and the next refusal finds no strike either
  })
})

describe('the buckets: chat and typing, and where they keep their tokens', () => {
  it('chat: a burst of 20, then 10 a second', () => {
    const att = {}
    for (let i = 0; i < 20; i++) expect(chatBucket(att, T0)).toBe(true)
    expect(chatBucket(att, T0)).toBe(false)
    expect(chatBucket(att, T0 + 50)).toBe(false)
    expect(chatBucket(att, T0 + 100)).toBe(true)
    expect(chatBucket(att, T0 + 100)).toBe(false)
  })
  it('typing: a burst of 40, then 20 a second', () => {
    const att = {}
    for (let i = 0; i < 40; i++) expect(typingBucket(att, T0)).toBe(true)
    expect(typingBucket(att, T0)).toBe(false)
    expect(typingBucket(att, T0 + 50)).toBe(true)
    expect(typingBucket(att, T0 + 50)).toBe(false)
  })
  it('pos: a burst of 60, then 40 a second', () => {
    const att = {}
    for (let i = 0; i < 60; i++) expect(posBucket(att, T0)).toBe(true)
    expect(posBucket(att, T0)).toBe(false)
    expect(posBucket(att, T0 + 25)).toBe(true)
  })
  it('a refused frame costs one strike; the strikes come back at 30 a second, never past 2400', () => {
    const att = {}
    for (let i = 0; i < CHAT_BURST; i++) pace(att, 'chat', T0)
    expect(pace(att, 'chat', T0)).toBe('drop')
    expect(att.flTok).toBe(FLOOD_STRIKES - 1)
    expect(floodStrike(att, T0 + 1000)).toBe(true)
    expect(att.flTok).toBe(FLOOD_STRIKES - 1)              // 30 back, capped, one spent
  })
  it('each on fields of its own on the attachment, the ev bucket untouched, and it all survives a JSON round trip (hibernation)', () => {
    const att = { id: 'a', name: 'ada' }
    pace(att, 'pos', T0); pace(att, 'chat', T0); pace(att, 'typing', T0)
    expect(Object.keys(att).sort()).toEqual(['chT', 'chTok', 'id', 'name', 'posT', 'posTok', 'tyT', 'tyTok'])
    expect(att.evTok).toBeUndefined()
    const copy = JSON.parse(JSON.stringify(att))
    expect([copy.posTok, copy.chTok, copy.tyTok]).toEqual([POS_BURST - 1, CHAT_BURST - 1, TYPING_BURST - 1])
    expect(evBucket(copy, T0)).toBe(true)
    expect(pace(att, 'join', T0)).toBe('pass')             // a type it does not pace passes, and is not counted
    expect(pace(att, 'constructor', T0)).toBe('pass')
  })
})

// ── the relay's Room, driven through the real class over fake sockets (as test/relay-room.test.js does) ──
function fakeStorage() {
  const m = new Map()
  return { m, get: async (k) => structuredClone(m.get(k)), put: async (k, v) => { m.set(k, structuredClone(v)) }, delete: async (k) => m.delete(k), getAlarm: async () => null, setAlarm: async () => {} }
}
function sock(id) {
  return {
    att: { id, name: 'wanderer', x: 0, y: 0, angle: 0 }, sent: [], closed: [], writes: 0,
    send(raw) { this.sent.push(JSON.parse(raw)) },
    close(code, reason) { this.closed.push([code, reason]) },
    serializeAttachment(a) { this.writes++; this.att = structuredClone(a) },
    deserializeAttachment() { return structuredClone(this.att) },
  }
}
function room(storage = fakeStorage(), sockets = []) {
  const r = new Room({ storage, getWebSockets: () => sockets.slice() }, {})
  return {
    r, sockets, storage,
    async join(id, name) {
      const ws = sock(id)
      sockets.push(ws)
      await r.webSocketMessage(ws, JSON.stringify({ type: 'join', roomId: 'r', name }))
      return ws
    },
    send: (ws, frame) => r.webSocketMessage(ws, JSON.stringify(frame)),
  }
}
const of = (ws, type) => ws.sent.filter((m) => m.type === type)

describe("the relay's Room paces them, and closes a flooder 4029 'too fast'", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(T0) })
  afterEach(() => { vi.useRealTimers() })

  it('an honest client at full rate for three minutes, the hand at its fastest: every frame relayed, never closed', async () => {
    const a = room()
    const ada = await a.join('ada1', 'ada')
    const bo = await a.join('bo1', 'bo')
    const pushes = of(bo, 'players').length
    const frames = honest({ seconds: 180, lines: 5, seed: 21 })
    let chats = 0, typing = 0, pos = 0
    for (const f of frames) {
      vi.setSystemTime(T0 + f.t)
      if (f.type === 'pos') { pos++; await a.send(ada, { type: 'pos', x: pos, y: 1, angle: 0, hp: 100 }) }
      else if (f.type === 'chat') { chats++; await a.send(ada, { type: 'chat', text: 'go' }) }
      else { typing++; await a.send(ada, { type: 'typing', on: typing % 2 === 1 }) }
    }
    expect(ada.closed).toEqual([])
    expect(of(bo, 'players').length - pushes).toBe(pos)
    expect(of(bo, 'chat').length).toBe(chats)
    expect(of(bo, 'typing').length).toBe(typing)
    expect(of(bo, 'players').at(-1).list.find((p) => p.id === 'ada1').x).toBe(pos)
    expect(chats).toBe(900)
  })

  it('over the limit a frame is dropped and nothing is said: 25 lines at once, the friend hears 20, the sender stays', async () => {
    const a = room()
    const ada = await a.join('ada1', 'ada')
    const bo = await a.join('bo1', 'bo')
    const before = ada.sent.length
    for (let i = 0; i < 25; i++) await a.send(ada, { type: 'chat', text: `line ${i}` })
    expect(of(bo, 'chat').map((m) => m.text)).toEqual(Array.from({ length: 20 }, (_, i) => `line ${i}`))
    expect(ada.sent.length).toBe(before)                    // no word back to the sender
    expect(ada.closed).toEqual([])
    expect(ada.att.flTok).toBe(FLOOD_STRIKES - 5)
  })

  it('a flooder is closed 4029 too fast once, seen out at once, and nothing it still sends reaches anyone', async () => {
    const a = room()
    const ada = await a.join('ada1', 'ada')
    const bo = await a.join('bo1', 'bo')
    for (let i = 0; i < 3000; i++) await a.send(ada, { type: 'pos', x: i, y: 0, angle: 0 })   // all in the same instant
    expect(ada.closed).toEqual([[FLOOD_CLOSE, FLOOD_REASON]])
    expect(of(bo, 'left')).toEqual([{ type: 'left', id: 'ada1', name: 'ada' }])
    expect(ada.att.flood).toBe(true)
    const seen = bo.sent.length, adaSeen = ada.sent.length
    await a.send(ada, { type: 'chat', text: 'still here' })
    await a.send(ada, { type: 'typing', on: true })
    await a.send(ada, { type: 'ev', kind: 'whistle', payload: {} })
    await a.send(ada, { type: 'join', roomId: 'r', name: 'ada' })
    vi.setSystemTime(T0 + 60_000)                          // a minute on, its buckets full again: still nothing
    await a.send(ada, { type: 'pos', x: 1, y: 1, angle: 0 })
    expect(bo.sent.length).toBe(seen)
    await a.send(bo, { type: 'pos', x: 2, y: 2, angle: 0 })  // the friend moves: the list no longer has the flooder, nor is it sent to it
    expect(of(bo, 'players').at(-1).list.map((p) => p.id)).toEqual(['bo1'])
    expect(ada.sent.length).toBe(adaSeen)
    await a.r.webSocketClose(ada)                          // its close goes through: no second 'left'
    expect(of(bo, 'left').length).toBe(1)
    expect(ada.closed.length).toBe(1)
  })

  it('a chat or a typing flood is closed the same way', async () => {
    for (const frame of [{ type: 'chat', text: 'x' }, { type: 'typing', on: true }]) {
      const a = room()
      const ada = await a.join('ada1', 'ada')
      for (let i = 0; i < 3000 && !ada.closed.length; i++) await a.send(ada, frame)
      expect([frame.type, ada.closed]).toEqual([frame.type, [[4029, 'too fast']]])
    }
  })

  it('the tokens ride the attachment, written back after every change, refused or not: a room that wakes from hibernation remembers', async () => {
    const st = fakeStorage(), sockets = []
    const a = room(st, sockets)
    const ada = await a.join('ada1', 'ada')
    const bo = await a.join('bo1', 'bo')
    for (let i = 0; i < 20; i++) await a.send(ada, { type: 'chat', text: 'x' })
    let w = ada.writes
    await a.send(ada, { type: 'chat', text: 'x' })        // refused: its strike is written back
    expect(ada.writes).toBe(w + 1)
    expect(ada.att.flTok).toBe(FLOOD_STRIKES - 1)
    const b = room(st, sockets)                              // the object slept: a fresh instance over the same sockets
    await b.send(ada, { type: 'chat', text: 'after' })
    expect(of(bo, 'chat').length).toBe(20)                // still refused: the bucket came back with the socket
    w = ada.writes
    for (const frame of [{ type: 'pos', x: 1, y: 1, angle: 0 }, { type: 'typing', on: true }]) await b.send(ada, frame)
    expect(ada.writes).toBe(w + 2)                           // passed: each one's tokens written back too
    expect(ada.att.posT).toBe(T0)
    expect(ada.att.tyT).toBe(T0)
  })

  it('ev keeps its own bucket, unchanged: 20 at once, then 10 a second, and a refused ev is no strike', async () => {
    const a = room()
    const ada = await a.join('ada1', 'ada')
    const bo = await a.join('bo1', 'bo')
    for (let i = 0; i < 25; i++) await a.send(ada, { type: 'ev', kind: 'whistle', payload: { n: i } })
    expect(of(bo, 'ev').length).toBe(20)
    expect(ada.att.flTok).toBeUndefined()
  })
})

// ── the LAN server: the same pace, over real sockets ──
describe('the LAN server mirrors it (server/index.js, over real sockets)', () => {
  let server, port
  const open = () => new Promise((resolve, reject) => { const ws = new WebSocket(`ws://127.0.0.1:${port}`); ws.once('open', () => resolve(ws)); ws.once('error', reject) })
  const join = (ws, roomId, name) => new Promise((resolve) => {
    const on = (d) => { const m = JSON.parse(d.toString()); if (m.type === 'welcome') { ws.off('message', on); resolve(m) } }
    ws.on('message', on)
    ws.send(JSON.stringify({ type: 'join', roomId, name }))
  })
  const listen = (ws, type) => { const got = []; ws.on('message', (d) => { const m = JSON.parse(d.toString()); if (m.type === type) got.push(m) }); return got }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  beforeAll(async () => { server = await createServer(0, '127.0.0.1'); port = server.address().port })
  afterAll(() => server.close())

  it("a pos flooder is closed 4029 'too fast' and seen out of the room once; the friend stays", async () => {
    const ada = await open(); await join(ada, 'flood-lan', 'ada')
    const bo = await open(); await join(bo, 'flood-lan', 'bo')
    const left = listen(bo, 'left')
    const closed = new Promise((resolve) => ada.once('close', (code, reason) => resolve([code, reason.toString()])))
    for (let i = 0; i < 6000; i++) ada.send(JSON.stringify({ type: 'pos', x: i, y: 0, angle: 0 }))
    expect(await closed).toEqual([4029, 'too fast'])
    await sleep(100)
    expect(left.map((m) => m.name)).toEqual(['ada'])
    expect(bo.readyState).toBe(WebSocket.OPEN)
    bo.close()
  })

  it('over the limit a line is dropped and nothing is said: 25 at once, the friend hears about 20, the sender stays', async () => {
    const ada = await open(); await join(ada, 'chat-lan', 'ada')
    const bo = await open(); await join(bo, 'chat-lan', 'bo')
    const heard = listen(bo, 'chat')
    for (let i = 0; i < 25; i++) ada.send(JSON.stringify({ type: 'chat', text: `line ${i}` }))
    await sleep(200)
    expect(heard.length).toBeGreaterThanOrEqual(CHAT_BURST)
    expect(heard.length).toBeLessThan(25)
    expect(ada.readyState).toBe(WebSocket.OPEN)
    ada.close(); bo.close()
  })
})

// ── the atlas: one shared flood guard in front of its open writes ──
function gateNamespace() {
  const names = [], instances = new Map()
  return {
    names, instances,
    idFromName: (n) => { names.push(n); return { name: n } },
    get: (id) => {
      if (!instances.has(id.name)) {
        const m = new Map()
        const storage = { get: async (k) => m.get(k), put: async (k, v) => { m.set(k, v) }, deleteAll: async () => { m.clear() }, setAlarm: async () => {}, _m: m }
        instances.set(id.name, new Gate({ storage }, {}))
      }
      return instances.get(id.name)
    },
  }
}
function atlasNamespace() {
  const seen = []
  const stub = { fetch: async (req) => { seen.push(`${req.method} ${new URL(req.url).pathname}`); return new Response('{}', { status: 201 }) } }
  return { seen, idFromName: (n) => ({ name: n }), get: () => stub }
}
const HOST = 'https://backrooms-relay.jeff-schatz112.workers.dev'
const atlasReq = (path, { method = 'POST', ip = '203.0.113.7', body = { visitor: 'v1', lat: 1, lng: 2 } } = {}) => new Request(HOST + path, {
  method, headers: { 'content-type': 'application/json', 'CF-Connecting-IP': ip },
  body: method === 'GET' || method === 'OPTIONS' ? undefined : JSON.stringify(body),
})
const ip = (i) => `198.51.${(i >> 8) & 255}.${i & 255}`

describe('the atlas: one flood guard every sender shares, in front of check-ins and drop-ins only', () => {
  let env
  beforeEach(() => { env = { GATE: gateNamespace(), ATLAS: atlasNamespace() } })

  it('the rule: at most 200 in ten minutes and 2000 a day, from everyone at once', () => {
    expect(GATE_RULES.atlasAll).toEqual([{ windowMs: 10 * MIN, max: 200 }, { windowMs: DAY_MS, max: 2000 }])
    expect(Object.isFrozen(GATE_RULES.atlasAll)).toBe(true)
    expect(GATE_RULES.wishAll).toEqual([{ windowMs: DAY_MS, max: 300 }])     // the wish gates are untouched
  })

  it('a check-in and a drop-in each take from the one shared gate, then reach the atlas', async () => {
    expect((await worker.fetch(atlasReq('/atlas/beacons/door-1/checkin'), env)).status).toBe(201)
    expect((await worker.fetch(atlasReq('/atlas/beacons/door-1/dropin', { ip: '192.0.2.4' }), env)).status).toBe(201)
    expect(env.GATE.names).toEqual([GLOBAL_GATE, GLOBAL_GATE])
    expect(env.ATLAS.seen).toEqual(['POST /atlas/beacons/door-1/checkin', 'POST /atlas/beacons/door-1/dropin'])
  })

  it('it stores no address: one gate, named for no one, holding only take times', async () => {
    const ips = Array.from({ length: 30 }, (_, i) => ip(i))
    for (const a of ips) await worker.fetch(atlasReq('/atlas/beacons/door-1/checkin', { ip: a }), env)
    expect([...env.GATE.instances.keys()]).toEqual([GLOBAL_GATE])
    const m = env.GATE.instances.get(GLOBAL_GATE).ctx.storage._m
    expect([...m.keys()]).toEqual(['atlasAll'])
    expect(m.get('atlasAll').length).toBe(30)
    expect(m.get('atlasAll').every((t) => typeof t === 'number')).toBe(true)
    const kept = JSON.stringify([...m.entries()])
    for (const a of ips) {
      expect(kept).not.toContain(a)
      expect(kept).not.toContain(await hashIp(gateKey(a), 'backrooms-gate'))
    }
  })

  it('shared: 200 from 200 addresses in ten minutes, then the next, from anyone, is refused like a /wish: 429 rate with a Retry-After', async () => {
    for (let i = 0; i < 200; i++) {
      const path = i % 2 ? '/atlas/beacons/door-1/dropin' : '/atlas/beacons/door-1/checkin'
      expect((await worker.fetch(atlasReq(path, { ip: ip(i) }), env)).status).toBe(201)
    }
    const res = await worker.fetch(atlasReq('/atlas/beacons/door-1/checkin', { ip: '192.0.2.200' }), env)
    expect([res.status, await res.json()]).toEqual([429, { ok: false, reason: 'rate' }])
    expect(Number(res.headers.get('Retry-After'))).toBeGreaterThan(0)
    expect(Number(res.headers.get('Retry-After'))).toBeLessThanOrEqual(600)
    expect(res.headers.get('access-control-allow-origin')).toBe('*')      // the page can read it
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    expect(env.ATLAS.seen.length).toBe(200)                                // a refused write never reaches the atlas
    // and reads go on as ever
    expect((await worker.fetch(atlasReq('/atlas/beacons', { method: 'GET' }), env)).status).toBe(201)
    expect(env.ATLAS.seen.at(-1)).toBe('GET /atlas/beacons')
  })

  it('the day: 2000, however they are spread', async () => {
    const all = env.GATE.get(env.GATE.idFromName(GLOBAL_GATE))
    const now = Date.now()
    await all.ctx.storage.put('atlasAll', Array.from({ length: 1999 }, (_, i) => now - 11 * MIN - i * 30_000))
    expect((await worker.fetch(atlasReq('/atlas/beacons/door-1/checkin'), env)).status).toBe(201)
    const res = await worker.fetch(atlasReq('/atlas/beacons/door-1/dropin', { ip: '192.0.2.9' }), env)
    expect(res.status).toBe(429)
    expect(Number(res.headers.get('Retry-After'))).toBeGreaterThan(600)
  })

  it('reads, the passage balance, a preflight and the admin\'s keyed writes never touch it', async () => {
    const free = [
      atlasReq('/atlas/beacons', { method: 'GET' }),
      atlasReq('/atlas/beacons/door-1', { method: 'GET' }),
      atlasReq('/atlas/passage', { body: { visitor: 'v1' } }),
      atlasReq('/atlas/beacons/door-1/checkin', { method: 'OPTIONS' }),
      atlasReq('/atlas/beacons/door-1', { method: 'PUT', body: { id: 'door-1' } }),
      atlasReq('/atlas/beacons/door-1/strata', { body: { tier: 'deep' } }),
      atlasReq('/atlas/beacons/door-1/checkin', { method: 'GET' }),
      atlasReq('/atlas/nowhere'),
    ]
    for (const req of free) await worker.fetch(req, env)
    expect(env.GATE.names).toEqual([])
    expect(env.ATLAS.seen.length).toBe(free.length)
  })

  it('atlasOpenWrite names exactly the two', () => {
    const is = (method, path) => atlasOpenWrite(new Request(HOST + path, { method }), new URL(HOST + path))
    expect(is('POST', '/atlas/beacons/door-1/checkin')).toBe(true)
    expect(is('POST', '/atlas/beacons/door-1/dropin')).toBe(true)
    expect(is('POST', '/atlas/beacons/door-1/checkin/')).toBe(true)          // parseAtlasPath reads it the same way
    for (const [m, p] of [['GET', '/atlas/beacons/door-1/checkin'], ['POST', '/atlas/passage'], ['POST', '/atlas/beacons/door-1/strata'], ['PUT', '/atlas/beacons/door-1'], ['POST', '/atlas/beacons']]) {
      expect([m, p, is(m, p)]).toEqual([m, p, false])
    }
  })
})

describe('the two copies and the two servers stay one guard (source guards: relay.js cannot run unmocked in node)', () => {
  const relaySrc = read('../relay/relay.js')
  const serverSrc = read('../server/index.js')

  it('server/evguard.js is relay/evguard.js below its four-line header, byte for byte', () => {
    const eol = raw('../relay/evguard.js').includes('\r\n') ? '\r\n' : '\n'
    const copy = raw('../server/evguard.js').split(eol)
    expect(copy.slice(0, 4).join(eol)).toMatch(/COPY of relay\/evguard\.js/)
    expect(copy.slice(4).join(eol)).toBe(raw('../relay/evguard.js'))
    expect(serverGuard.pace).toBeTypeOf('function')
    expect(serverGuard.FLOOD_CLOSE).toBe(4029)
  })

  it('both servers pace pos, chat and typing before they relay them, and close with FLOOD_CLOSE, FLOOD_REASON', () => {
    const branch = (src, type, end) => { const i = src.indexOf(`msg.type === '${type}'`); return src.slice(i, src.indexOf(end, i)) }
    for (const type of ['pos', 'chat', 'typing']) {
      const r = branch(relaySrc, type, '} else if')
      expect([type, r.includes(`if (!this.paced(ws, att, '${type}')) return`)]).toEqual([type, true])
      expect(r.indexOf('this.paced(')).toBeLessThan(r.indexOf('ws.serializeAttachment(att)'))
      const s = branch(serverSrc, type, 'return\n')
      expect([type, s.includes(`paced(p, '${type}')`)]).toEqual([type, true])
    }
    expect(branch(relaySrc, 'pos', '} else if').indexOf('this.paced(')).toBeLessThan(branch(relaySrc, 'pos', '} else if').indexOf('this.pushPlayers()'))
    for (const src of [relaySrc, serverSrc]) {
      expect(src).toContain('pace(')
      expect(src).toContain('ws.close(FLOOD_CLOSE, FLOOD_REASON)')
      expect(src).not.toContain('close(4029')                // the number lives in evguard.js only
    }
    // the flooder leaves the room before its close is sent (the LAN server), is seen out at once (the relay)
    const lan = serverSrc.slice(serverSrc.indexOf('const paced = '))
    expect(lan.indexOf('handleLeave(room, roomId, playerId)')).toBeLessThan(lan.indexOf('ws.close(FLOOD_CLOSE, FLOOD_REASON)'))
    const rel = relaySrc.slice(relaySrc.indexOf('  paced(ws, att, type) {'))
    expect(rel.indexOf("this.broadcast({ type: 'left'")).toBeGreaterThan(0)
    expect(rel.indexOf('att.flood = true')).toBeLessThan(rel.indexOf('ws.serializeAttachment(att)'))
  })

  it("'ev' is not paced: its branch keeps evBucket alone, on both servers", () => {
    const evRelay = relaySrc.slice(relaySrc.indexOf("msg.type === 'ev'"), relaySrc.indexOf('async webSocketClose'))
    const evServer = serverSrc.slice(serverSrc.indexOf("msg.type === 'ev'"), serverSrc.indexOf("ws.on('close'"))
    for (const b of [evRelay, evServer]) {
      expect(b).toContain('evBucket(')
      expect(b).not.toContain('paced(')
    }
  })

  it('the atlas guard sits in the /atlas forwarding, before the Atlas is reached, on the shared gate', () => {
    const at = relaySrc.slice(relaySrc.indexOf("if (url.pathname.startsWith('/atlas')) {"))
    expect(at.indexOf('atlasOpenWrite(request, url)')).toBeGreaterThan(0)
    expect(at.indexOf("env.GATE.get(env.GATE.idFromName(GLOBAL_GATE)).take('atlasAll')")).toBeGreaterThan(at.indexOf('atlasOpenWrite(request, url)'))
    expect(at.indexOf('stub.fetch(request)')).toBeGreaterThan(at.indexOf("take('atlasAll')"))
    expect(at.slice(0, at.indexOf('stub.fetch(request)'))).not.toContain('CF-Connecting-IP')
  })

  it('no new storage class and the deployed migrations as they were (test/relay-routes.test.js holds them too)', () => {
    const cfg = JSON.parse(read('../relay/wrangler.jsonc'))
    expect(cfg.durable_objects.bindings.map((b) => b.class_name)).toEqual(['Room', 'Atlas', 'Gate'])
    expect(cfg.migrations).toEqual([{ tag: 'v1', new_sqlite_classes: ['Room'] }, { tag: 'v2', new_sqlite_classes: ['Atlas'] }, { tag: 'v3', new_sqlite_classes: ['Gate'] }])
    expect(relaySrc.match(/extends DurableObject/g).length).toBe(3)
  })
})
