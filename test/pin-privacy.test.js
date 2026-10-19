// The pin and the room (fix/pin-privacy). Solo keeps the pin's own ~11 m seed — the game's promise, its golden values below. Whatever leaves
// the machine for a room is the NEIGHBOURHOOD's (anchor.js ROOM_GRID, two decimals): the join's worldSeed, host or joiner, relay or LAN;
// the 'here' mark; an invite's anchor. A pinned player is told once, beside 'connected', what the room has of it. The rules are pinned
// here; the wiring is lifted out of index.html / game.js and run (they only run in a page); the wire is a real client against a stand-in
// server that keeps every frame, and against the real LAN server for what another player receives.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import { WebSocket, WebSocketServer } from 'ws'
import { anchorSeed, neighbourhood, neighbourhoodSeed, pinTag, ROOM_GRID } from '../src/renderer/anchor.js'
import { buildInvite, readInvite, inviteFor, roomPinLine, ROOM_PIN_LINE, ROOM_PIN_MARK } from '../src/renderer/site.js'
import { createMultiplayerClient } from '../src/net/client.js'
import { createEvBus } from '../src/net/evbus.js'
import { createServer } from '../server/index.js'
import { roomSeed } from '../relay/seed.js'
import { ANCHORED, FRIEND_SAME_PIN } from '../src/renderer/origin-anchored.js'

global.WebSocket = WebSocket   // the client finds it on globalThis (client.test.js does the same)

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const html = read('../src/renderer/index.html')
const game = read('../src/renderer/game.js')
const at = (src, s, from = 0) => { const k = src.indexOf(s, from); expect(k, s).toBeGreaterThan(0); return k }
const slice = (src, from, to) => { const a = at(src, from), b = src.indexOf(to, a); expect(b, to).toBeGreaterThan(a); return src.slice(a, b) }
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
async function until(fn, ms = 2000) { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) throw new Error('timed out'); await sleep(10) } }

const PIN = { lat: 39.2975, lng: -76.643 }          // a door in west baltimore (where relay-routes.test.js's short link lands)
const SEED = anchorSeed(PIN.lat, PIN.lng)            // the solo seed: it inverts to that door
const HOOD = neighbourhoodSeed(PIN)                  // what a room is told
// the 2.0.1 mark, verbatim: what an older copy says of its pin in 'here' (16 bits of its exact seed, room-salted)
const tag201 = (seed, ws) => Math.imul((seed ^ (ws | 0)) >>> 0, 0x9E3779B1) >>> 16
// a fixed spread of real places (no Math.random in a pinned test)
function places(n, s = 1) {
  const out = []
  const next = () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32
  for (let i = 0; i < n; i++) out.push({ lat: -85 + next() * 170, lng: -180 + next() * 360 })
  return out
}
// every 4-decimal door strictly inside the room cell centred on `cell`: 99 × 99 of them
function doorsIn(cell) {
  const out = []
  for (let i = -49; i <= 49; i++) for (let j = -49; j <= 49; j++) out.push({ lat: cell.lat + i / 1e4, lng: cell.lng + j / 1e4 })
  return out
}
// a stand-in server that keeps every raw frame and welcomes a join into the seed it asked for (or 7)
function recorder() {
  return new Promise((resolve) => {
    const frames = []
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 }, () => {
      resolve({ frames, url: `ws://127.0.0.1:${wss.address().port}`, close: () => new Promise(r => wss.close(() => r())) })
    })
    wss.on('connection', (sock) => sock.on('message', (raw) => {
      const s = raw.toString(), msg = JSON.parse(s)
      frames.push(s)
      if (msg.type === 'join') sock.send(JSON.stringify({ type: 'welcome', playerId: 'me', worldSeed: msg.worldSeed ?? 7, roomId: msg.roomId, first: true }))
    }))
  })
}

describe('the room grid: two decimals, about a kilometre', () => {
  it('is 1e-2 degree: 1.11 km north-south anywhere, 0.86 km east-west at baltimore, under a square kilometre', () => {
    expect(ROOM_GRID).toBe(100)
    const R = 6371.0088                                                   // the mean earth radius, km
    const ns = (Math.PI / 180) * R / ROOM_GRID
    const ew = (lat) => ns * Math.cos(lat * Math.PI / 180)
    expect(ns).toBeCloseTo(1.112, 2)
    expect(ew(39.29)).toBeCloseTo(0.861, 2)
    expect(ns * ew(39.29)).toBeGreaterThan(0.9); expect(ns * ew(39.29)).toBeLessThan(1)
  })
  it('a pin snaps to the nearest grid point; anything that is not a pin has no neighbourhood', () => {
    expect(neighbourhood(PIN)).toEqual({ lat: 39.3, lng: -76.64 })
    expect(neighbourhood({ lat: 39.2949, lng: -76.6451 })).toEqual({ lat: 39.29, lng: -76.65 })
    expect(neighbourhood({ lat: 90, lng: -180 })).toEqual({ lat: 90, lng: -180 })
    for (const v of [null, undefined, {}, { lat: 91, lng: 0 }, { lat: 0, lng: 181 }, { lat: '39.3', lng: '-76.6' }, SEED]) {
      expect(neighbourhood(v), JSON.stringify(v)).toBe(null)
      expect(neighbourhoodSeed(v), JSON.stringify(v)).toBe(null)
    }
  })
  it('the seed is the cell\'s alone: all 9801 doors inside one cell ask a room for the same; each of the eight cells around it asks for another', () => {
    const cell = neighbourhood(PIN), doors = doorsIn(cell)
    expect(new Set(doors.map(neighbourhoodSeed))).toEqual(new Set([HOOD]))
    expect(new Set(doors.map(d => anchorSeed(d.lat, d.lng))).size).toBe(9801)   // solo still tells every one of them apart
    const around = []
    for (const di of [-1, 0, 1]) for (const dj of [-1, 0, 1]) if (di || dj) around.push(neighbourhoodSeed({ lat: cell.lat + di / ROOM_GRID, lng: cell.lng + dj / ROOM_GRID }))
    expect(new Set([HOOD, ...around]).size).toBe(9)
  })
  it('is stable: snapped again, read back from a two-decimal invite, or as a 2.0.1 copy\'s solo seed of the grid point — the same seed; never 0, never the pin\'s own', () => {
    let own = 0
    for (const p of places(2000)) {
      const n = neighbourhood(p), s = neighbourhoodSeed(p)
      expect(neighbourhoodSeed(n)).toBe(s)
      expect(neighbourhoodSeed(readInvite(`?anchor=${n.lat.toFixed(2)},${n.lng.toFixed(2)}`).anchor)).toBe(s)
      expect(anchorSeed(n.lat, n.lng)).toBe(s)
      expect(s).toBeGreaterThan(0); expect(s).toBeLessThanOrEqual(0xFFFFFFFF)
      if (s === anchorSeed(p.lat, p.lng)) own++
    }
    expect(own).toBe(0)
  })
})

describe('solo is unchanged: the pin\'s own seed, to the 4-decimal door', () => {
  it('golden values (2.0.1\'s anchorSeed, byte for byte)', () => {
    const golden = [[35.0168, -80.5901, 334897851], [51.50135, -0.14189, 3977604621], [39.2975, -76.643, 3101232666], [-33.86, 151.21, 3382657767],
      [48.8584, 2.2945, 2238221619], [0, 0, 3979201112], [-90, -180, 1], [90, 180, 559140632], [39.3, -76.64, 1985557259]]
    for (const [lat, lng, s] of golden) expect(anchorSeed(lat, lng), `${lat},${lng}`).toBe(s)
    expect(SEED).toBe(3101232666)
    expect(HOOD).toBe(1985557259)                                          // the neighbourhood's: the grid point's solo seed
  })
  it('SOLO hands initGame the pin\'s own seed, and it is the one anchorSeed call on the title page; CONTINUE keeps the saved world', () => {
    const solo = slice(html, 'async function startSolo({ frontDoor = false } = {})', '// one connection attempt at a time')
    expect(solo).toContain('? { worldSeed: anchorSeed(anchor.lat, anchor.lng), anchor, intakeCtx }')
    expect((html.match(/anchorSeed\(/g) || []).length).toBe(1)
    expect(html).toContain('await initGame(canvas, { worldSeed: savedRun.worldSeed ?? null, anchor, resume: savedRun, intakeCtx })')
    expect(game).not.toMatch(/anchorSeed/)                                 // the game itself never sees the pin's seed
  })
})

describe('the join: a room is asked for the neighbourhood, never the pin', () => {
  it('every way into a room — PLAY ONLINE, an invite\'s JOIN, HOST LAN, JOIN LAN — is startMultiplayer, and it asks with neighbourhoodSeed', () => {
    const mp = slice(html, 'async function startMultiplayer(serverUrl, roomId, statusEl, route = \'lan\', lanUrl = serverUrl) {', '// the relay\'s room, from the PLAY ONLINE')
    expect(mp).toContain('const requestedSeed = neighbourhoodSeed(anchor)')
    expect(mp).toContain('const { worldSeed } = await mpClient.connect(roomId, requestedSeed, getName())')
    expect(mp).not.toMatch(/anchorSeed/)
    expect((html.match(/createMultiplayerClient\(/g) || []).length).toBe(1)
    expect((html.match(/\.connect\(/g) || []).length).toBe(1)
    expect(html).toMatch(/import \{[^}]*\bneighbourhoodSeed\b[^}]*\} from '\.\/anchor\.js'/)
    for (const s of ["startMultiplayer(`${RELAY_URL}/?room=${encodeURIComponent(c)}`, c, statusEl, 'online')",
      "await startMultiplayer(`ws://localhost:${port}`, room, startStatus, r ? 'host' : 'lan', info.url || `ws://localhost:${port}`)",
      "startMultiplayer(url, room, null, 'lan')"]) expect(html, s).toContain(s)
  })
  it('lifted and run: the join frame on the wire carries the neighbourhood\'s seed, never the pin\'s, and no coordinates; no pin, no seed', async () => {
    const line = html.match(/const requestedSeed = [^\n]*/)[0]
    const requested = (anchor) => new Function('anchor', 'neighbourhoodSeed', `${line}\nreturn requestedSeed`)(anchor, neighbourhoodSeed)
    const srv = await recorder()
    try {
      const c = createMultiplayerClient(srv.url)
      const w = await c.connect('yellow-lamp-42', requested(PIN), 'ada')
      expect(w.worldSeed).toBe(HOOD)
      const join = srv.frames.find(f => JSON.parse(f).type === 'join')
      expect(JSON.parse(join)).toEqual({ type: 'join', roomId: 'yellow-lamp-42', name: 'ada', worldSeed: HOOD })
      expect(join).not.toContain(String(SEED))
      expect(join).not.toMatch(/39\.29|76\.64|39\.3\b/)
      c.disconnect()
      const c2 = createMultiplayerClient(srv.url)
      await c2.connect('r2', requested(null), 'bo')
      expect(JSON.parse(srv.frames.filter(f => JSON.parse(f).type === 'join')[1])).toEqual({ type: 'join', roomId: 'r2', name: 'bo' })
      c2.disconnect()
    } finally { await srv.close() }
  })
})

describe("'here': the mark is the neighbourhood's, and no number of rooms narrows it further", () => {
  const ROOMS = [7, 8, 3977604621, HOOD, 0xFFFFFFFF, 123456789]
  it('every door in a cell carries one tag in every room — six rooms\' tags together still name the whole cell', () => {
    const doors = doorsIn(neighbourhood(PIN))
    for (const ws of ROOMS) expect(new Set(doors.map(d => pinTag(d, ws))), String(ws)).toEqual(new Set([pinTag(PIN, ws)]))
    expect(new Set(doors.map(d => ROOMS.map(ws => pinTag(d, ws)).join())).size).toBe(1)
    // 2.0.1's mark, over the same doors: two rooms already told almost every door apart
    expect(new Set(doors.map(d => ROOMS.slice(0, 2).map(ws => tag201(anchorSeed(d.lat, d.lng), ws)).join())).size).toBeGreaterThan(9700)
  })
  it('a search over a 5 km box with the tags from two rooms: 2.0.1\'s ends at the door, this one\'s at the whole neighbourhood', () => {
    const [w1, w2] = [1234567, 3977604621]
    const old1 = tag201(SEED, w1), old2 = tag201(SEED, w2), new1 = pinTag(PIN, w1), new2 = pinTag(PIN, w2)
    const oldHits = [], newHits = []
    const c = { lat: Math.round(PIN.lat * 1e4), lng: Math.round(PIN.lng * 1e4) }
    for (let i = -250; i < 250; i++) for (let j = -250; j < 250; j++) {
      const d = { lat: (c.lat + i) / 1e4, lng: (c.lng + j) / 1e4 }
      const s = anchorSeed(d.lat, d.lng)
      if (tag201(s, w1) === old1 && tag201(s, w2) === old2) oldHits.push(d)
      if (pinTag(d, w1) === new1 && pinTag(d, w2) === new2) newHits.push(d)
    }
    expect(oldHits).toEqual([PIN])                                         // the leak this fixes: one door out of 250 000
    expect(newHits.length).toBeGreaterThanOrEqual(9801)                    // now: every door of the cell, and only of the cell
    for (const d of newHits) expect(neighbourhood(d)).toEqual(neighbourhood(PIN))
  })
  it('lifted and run: game.js\'s mark; on the wire (a real client, the real LAN server) the friend receives neither seed', async () => {
    const line = game.match(/const myPinTag = [^\n]*/)[0]
    expect(line).toBe('const myPinTag = pinTag(anchor, worldSeed)')
    const srv = await createServer(0, '127.0.0.1')
    try {
      const url = `ws://127.0.0.1:${srv.address().port}`
      const a = createMultiplayerClient(url), b = createMultiplayerClient(url)
      const { worldSeed } = await a.connect('pinroom', neighbourhoodSeed(PIN), 'ada')
      await b.connect('pinroom', null, 'bo')
      expect(worldSeed).toBe(HOOD)
      const myPinTag = new Function('anchor', 'worldSeed', 'pinTag', `${line}\nreturn myPinTag`)(PIN, worldSeed, pinTag)
      const got = []
      b.onEv((m) => got.push(m))
      const bus = createEvBus({ send: a.sendEv, now: () => Date.now(), self: () => ({ x: 0, y: 0, lvl: 0 }), peerPos: () => null, peerIds: () => new Set(), selfId: () => a.id })
      bus.here({ lvl: 0, lit: true, st: 'ok', seen: false, o: 'anchored', thin: false, status: 'notice-mailed', aseed: myPinTag })
      await until(() => got.some(m => m.kind === 'here'))
      const here = got.find(m => m.kind === 'here'), raw = JSON.stringify(here)
      expect(here.payload.aseed).toBe(pinTag(PIN, HOOD))
      expect(here.payload.aseed).toBeLessThan(65536)
      for (const n of [SEED, HOOD]) expect(raw).not.toContain(String(n))
      expect(raw).not.toMatch(/39\.29|76\.64/)
      a.disconnect(); b.disconnect()
    } finally { srv.close() }
  })
  it('two friends from one neighbourhood still steady each other in a room; a friend from the next one over does not', () => {
    const ws = HOOD, me = pinTag(PIN, ws)
    const fb = (other) => ANCHORED.friendBase({ rp: { aseed: other }, selfAseed: me })
    expect(fb(pinTag({ lat: 39.3021, lng: -76.6388 }, ws))).toBe(FRIEND_SAME_PIN)   // ~600 m off, the same cell
    expect(fb(pinTag({ lat: 39.2949, lng: -76.643 }, ws))).toBe(3)                   // 290 m south, over the line: the next cell
    expect(fb(null)).toBe(3)
  })
})

describe('an invite carries the neighbourhood, never the door', () => {
  it('the box\'s link and /invite pin\'s carry two decimals; the friend asks the room for the sender\'s seed and wears the sender\'s mark', () => {
    const url = buildInvite({ room: 'r', anchor: PIN })
    const console_ = inviteFor({ arg: 'pin', room: { code: 'r', route: 'online', lan: null }, anchor: PIN, warned: true }).url
    expect(console_).toBe(url)
    expect(url).toBe('https://backrooms.thecornerspore.dev/play/?room=r&anchor=39.30%2C-76.64')
    expect(url).not.toMatch(/2975|643\b/)
    const friend = readInvite(new URL(url).search).anchor
    expect(neighbourhoodSeed(friend)).toBe(HOOD)
    for (const ws of [7, HOOD]) expect(pinTag(friend, ws)).toBe(pinTag(PIN, ws))
  })
})

describe('the line: a pinned player is told once what the room has of it', () => {
  it('opened from your neighbourhood: drawn from it; drawn before you came: a mark; no pin: nothing', () => {
    expect(ROOM_PIN_LINE).toBe("this room is drawn from your pin's neighbourhood. anyone with the code can see roughly where — never the door.")
    expect(ROOM_PIN_MARK).toBe("this room was drawn before you came. the others get only a mark of your pin's neighbourhood — enough to read roughly where, never the door.")
    for (const s of [ROOM_PIN_LINE, ROOM_PIN_MARK]) { expect(s).toBe(s.toLowerCase()); expect(s).not.toContain('!') }
    expect(roomPinLine({ anchor: PIN, worldSeed: HOOD })).toBe(ROOM_PIN_LINE)
    expect(roomPinLine({ anchor: { lat: 39.3021, lng: -76.6388 }, worldSeed: HOOD })).toBe(ROOM_PIN_LINE)   // someone from your cell drew it
    expect(roomPinLine({ anchor: PIN, worldSeed: String(HOOD) })).toBe(ROOM_PIN_LINE)
    expect(roomPinLine({ anchor: PIN, worldSeed: 7 })).toBe(ROOM_PIN_MARK)
    expect(roomPinLine({ anchor: PIN, worldSeed: SEED })).toBe(ROOM_PIN_MARK)   // a 2.0.1 room drawn from the very door: not this copy's doing
    expect(roomPinLine({ anchor: null, worldSeed: HOOD })).toBe(null)
    expect(roomPinLine()).toBe(null)
  })
  it('lifted and run: game.js says it in the chat beside \'connected\', in a room only, once', () => {
    const block = slice(game, '  if (mpClient) {\n    mpClient.onChat(addChatLine)', '\n  }\n') + '\n  }'
    expect(block).toContain('const pinLine = roomPinLine({ anchor, worldSeed })')
    expect(at(block, 'if (pinLine) addChatLine(\'\', pinLine, true)')).toBeGreaterThan(at(block, "addChatLine('', 'connected — Enter to chat"))
    expect((game.match(/roomPinLine\(/g) || []).length).toBe(1)
    const run = (mpClient, anchor, worldSeed) => {
      const lines = []
      new Function('mpClient', 'addChatLine', 'showTyping', 'roomPinLine', 'anchor', 'worldSeed', block)(
        mpClient, (from, text, sys) => lines.push(sys ? text : `${from}: ${text}`), () => {}, roomPinLine, anchor, worldSeed)
      return lines
    }
    const mp = { onChat() {}, onTyping() {} }
    expect(run(mp, PIN, HOOD).slice(1)).toEqual([ROOM_PIN_LINE])
    expect(run(mp, PIN, 99).slice(1)).toEqual([ROOM_PIN_MARK])
    expect(run(mp, null, HOOD).slice(1)).toEqual([])
    expect(run(null, PIN, SEED)).toEqual([])                                // solo: no room, no line
  })
})

describe('mixed versions: the room\'s stored world wins, and nothing breaks', () => {
  let srv, url
  beforeAll(async () => { srv = await createServer(0, '127.0.0.1'); url = `ws://127.0.0.1:${srv.address().port}` })
  afterAll(() => { srv.close() })
  // a 2.0.1 copy's join, raw: it asks for its exact pin's seed
  const join201 = (room, seed) => new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    ws.on('open', () => ws.send(JSON.stringify({ type: 'join', roomId: room, name: 'old', worldSeed: seed })))
    ws.on('message', (raw) => { const m = JSON.parse(raw.toString()); if (m.type === 'welcome') resolve({ ws, worldSeed: m.worldSeed }) })
    ws.on('error', reject)
  })
  it('the relay\'s rule: a stored world wins whoever asks next (relay/seed.js, unchanged)', () => {
    expect(roomSeed(HOOD, SEED)).toBe(SEED)                                // a 2.0.1 room drawn from the door keeps it: give the code up
    expect(roomSeed(SEED, HOOD)).toBe(HOOD)                                // a 2.0.1 joiner into a 2.0.2 room gets the neighbourhood's world
  })
  it('a 2.0.1 host first: the newer copy joins the old world and is told it was drawn before it came', async () => {
    const old = await join201('mixed-a', SEED)
    expect(old.worldSeed).toBe(SEED)
    const c = createMultiplayerClient(url)
    const { worldSeed } = await c.connect('mixed-a', HOOD, 'new')
    expect(worldSeed).toBe(SEED)
    expect(roomPinLine({ anchor: PIN, worldSeed })).toBe(ROOM_PIN_MARK)
    c.disconnect(); old.ws.close()
  })
  it('a 2.0.2 host first: the older copy joins the neighbourhood\'s world', async () => {
    const c = createMultiplayerClient(url)
    const { worldSeed } = await c.connect('mixed-b', HOOD, 'new')
    expect(worldSeed).toBe(HOOD)
    const old = await join201('mixed-b', SEED)
    expect(old.worldSeed).toBe(HOOD)
    c.disconnect(); old.ws.close()
  })
  it('an older copy\'s mark is still a well-formed here: believed, never matched, never a crash; pinned at an invite\'s point it matches', () => {
    const ws = HOOD, me = pinTag(PIN, ws)
    let t = 0
    const bus = createEvBus({ send: () => {}, now: () => t, self: () => ({ x: 0, y: 0, lvl: 0 }), peerPos: () => null, peerIds: () => new Set(['old']), selfId: 'me' })
    const here = (aseed, n) => ({ type: 'ev', id: 'old', name: 'old', kind: 'here', t: 0, payload: { lvl: 0, lit: true, st: 'ok', seen: false, o: 'anchored', thin: false, status: 'notice-mailed', aseed, v: 1, n } })
    expect(bus.receive(here(tag201(SEED, ws), 1))).toBe(true)
    const rec = bus.peers.get('old')
    expect(rec.aseed).toBe(tag201(SEED, ws))
    expect(rec.aseed).not.toBe(me)
    expect(ANCHORED.friendBase({ rp: rec, selfAseed: me })).toBe(3)
    t = 1000
    expect(bus.receive(here(tag201(anchorSeed(39.3, -76.64), ws), 2))).toBe(true)   // a 2.0.1 copy that opened a 2.0.2 invite
    expect(ANCHORED.friendBase({ rp: bus.peers.get('old'), selfAseed: me })).toBe(FRIEND_SAME_PIN)
  })
})
