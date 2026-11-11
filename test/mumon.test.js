// Wish #27, "Mumon will be counted last" — the owner: "make the name Mumon unavailable except for me and make other players see Mumon
// different and intricate and larger character". The name is held by a key only the owner has (relay/names.js, OWNER_KEY); the room
// marks the owner's player and the game draws it as PERSON.mumon.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import WebSocket from 'ws'

vi.mock('cloudflare:workers', () => ({ DurableObject: class { constructor(ctx, env) { this.ctx = ctx; this.env = env } } }))

const names = await import('../relay/names.js')
const serverNames = await import('../server/names.js')
const { Room } = await import('../relay/relay.js')
const { createServer } = await import('../server/index.js')
const { createMultiplayerClient } = await import('../src/net/client.js')
const owner = await import('../src/renderer/owner.js')
const { PERSON, drawSprites } = await import('../src/renderer/gfx-sprites.js')
const { ENTITY_FILLS } = await import('../src/renderer/game.js')

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const SECRET = 'a-long-owner-secret-0123456789'
const { isReservedName, nameLetters, ownerKeyOk, admitName, OWNER_MARK, SHARED_NAME } = names

describe('relay/names.js: who may be called Mumon', () => {
  it('reads a name as its letters: case, spacing, punctuation, held letters and look-alikes do not count', () => {
    expect(nameLetters('Mumon')).toBe('mumon')
    for (const n of ['Mumon', 'MUMON', 'mumon', ' Mumon ', 'Mu mon', 'M.u.m.o.n', 'MUM0N', 'Mummon', 'Muumoon', 'rnumon', 'Mvmon',
      'Mùmón', 'Mumоn' /* a Cyrillic о */, 'мumon' /* a Cyrillic м */, 'Mumoп' /* a Cyrillic п */, 'MumonSatanic', 'xX_mumon_Xx', 'the real mumon', 'mumon2'])
      expect(isReservedName(n), n).toBe(true)
  })
  it('leaves every other name alone', () => {
    for (const n of ['wanderer', 'maddie', 'jo', 'Mum', 'monk', 'Mumo', 'mon mu', 'moon', 'Mumbo', 'lemon', 'summon', 'muon', '', null, undefined])
      expect(isReservedName(n), String(n)).toBe(false)
  })
  it('the key: both strings, the secret 16..128 long, the same length and the same characters', () => {
    expect(ownerKeyOk(SECRET, SECRET)).toBe(true)
    expect(ownerKeyOk(SECRET.slice(0, -1) + 'x', SECRET)).toBe(false)
    expect(ownerKeyOk(SECRET + 'x', SECRET)).toBe(false)
    expect(ownerKeyOk('', SECRET)).toBe(false)
    expect(ownerKeyOk(undefined, SECRET)).toBe(false)
    expect(ownerKeyOk(SECRET, undefined)).toBe(false)                    // no secret set: no one holds the name
    expect(ownerKeyOk('short', 'short')).toBe(false)                     // a secret under 16 holds nothing
    expect(ownerKeyOk('x'.repeat(129), 'x'.repeat(129))).toBe(false)
  })
  it('admitName: an ordinary name passes as asked; Mumon without the key is wanderer; with it, kept and marked', () => {
    expect(admitName('maddie', undefined, SECRET)).toEqual({ name: 'maddie', mark: null })
    expect(admitName('', undefined, SECRET)).toEqual({ name: SHARED_NAME, mark: null })
    expect(admitName('x'.repeat(40), undefined, SECRET)).toEqual({ name: 'x'.repeat(24), mark: null })
    expect(admitName('Mumon', undefined, SECRET)).toEqual({ name: 'wanderer', mark: null })
    expect(admitName('MUM0N', 'wrong-key-wrong-key-wrong-k', SECRET)).toEqual({ name: 'wanderer', mark: null })
    expect(admitName('Mumon', SECRET, undefined)).toEqual({ name: 'wanderer', mark: null })
    expect(admitName('Mumon', SECRET, SECRET)).toEqual({ name: 'Mumon', mark: OWNER_MARK })
    expect(admitName('MumonSatanic', SECRET, SECRET)).toEqual({ name: 'MumonSatanic', mark: 'mumon' })
    expect(admitName('maddie', SECRET, SECRET)).toEqual({ name: 'maddie', mark: null })   // the key marks only the name it holds
  })
  it('server/names.js is relay/names.js below its header, and behaves the same', () => {
    const body = (src) => src.split('\n').filter((l) => !l.startsWith('//')).join('\n').trim()
    expect(body(read('../server/names.js'))).toBe(body(read('../relay/names.js')))
    expect(read('../server/names.js')).toMatch(/COPY of relay\/names\.js/)
    expect(serverNames.admitName('Mumon', SECRET, SECRET)).toEqual(admitName('Mumon', SECRET, SECRET))
  })
})

// the relay's Room over a fake ctx (as relay-room.test.js drives it)
function relayRoom(env = {}) {
  const sockets = []
  const storage = { get: async () => undefined, put: async () => {}, delete: async () => true, getAlarm: async () => null, setAlarm: async () => {} }
  const r = new Room({ storage, getWebSockets: () => sockets.slice() }, { EV_LOG: '0', ...env })
  const sock = (id) => ({
    att: { id, name: 'wanderer', x: 0, y: 0, angle: 0 }, sent: [],
    send(raw) { this.sent.push(JSON.parse(raw)) },
    serializeAttachment(a) { this.att = structuredClone(a) },
    deserializeAttachment() { return structuredClone(this.att) },
  })
  return {
    async join(id, name, key) {
      const ws = sock(id); sockets.push(ws)
      await r.webSocketMessage(ws, JSON.stringify({ type: 'join', roomId: 'r', name, ...(key !== undefined ? { key } : {}) }))
      return ws
    },
    // the same socket asks again (a client never does today; the room must not keep a mark the new name has no right to)
    async again(ws, name) { await r.webSocketMessage(ws, JSON.stringify({ type: 'join', roomId: 'r', name })); return ws },
  }
}

describe('relay.js: the room keeps the name for the key', () => {
  it('Mumon without the key joins as wanderer, is told so in welcome, and carries no mark', async () => {
    const R = relayRoom({ OWNER_KEY: SECRET })
    const a = await R.join('a', 'maddie')
    const b = await R.join('b', 'Mumon')
    expect(b.att.name).toBe('wanderer')
    expect(b.att.mark).toBeUndefined()
    expect(b.sent.find((m) => m.type === 'welcome').name).toBe('wanderer')
    expect(a.sent.find((m) => m.type === 'joined')).toEqual({ type: 'joined', id: 'b', name: 'wanderer' })
    const list = a.sent.filter((m) => m.type === 'players').pop().list
    expect(list.find((p) => p.id === 'b')).toEqual({ id: 'b', x: 0, y: 0, angle: 0, name: 'wanderer', hp: 100 })
  })
  it('with the key: the name is kept, and joined and players carry mark: mumon; the key is never kept or sent on', async () => {
    const R = relayRoom({ OWNER_KEY: SECRET })
    const a = await R.join('a', 'maddie')
    const b = await R.join('b', 'Mumon', SECRET)
    expect(b.att).toMatchObject({ name: 'Mumon', mark: 'mumon' })
    expect(JSON.stringify(b.att)).not.toContain(SECRET)
    expect(b.sent.find((m) => m.type === 'welcome').name).toBe('Mumon')
    expect(a.sent.find((m) => m.type === 'joined')).toEqual({ type: 'joined', id: 'b', name: 'Mumon', mark: 'mumon' })
    expect(a.sent.filter((m) => m.type === 'players').pop().list.find((p) => p.id === 'b')).toMatchObject({ name: 'Mumon', mark: 'mumon' })
    for (const ws of [a, b]) expect(JSON.stringify(ws.sent)).not.toContain(SECRET)
  })
  it('no OWNER_KEY set on the relay: nobody is Mumon, key or no key; an ordinary name is untouched', async () => {
    const R = relayRoom({})
    expect((await R.join('b', 'Mumon', SECRET)).att.name).toBe('wanderer')
    const c = await R.join('c', 'maddie', SECRET)
    expect(c.att.name).toBe('maddie'); expect(c.att.mark).toBeUndefined()
  })
  it('a rejoin as an ordinary name drops a mark the socket had', async () => {
    const R = relayRoom({ OWNER_KEY: SECRET })
    const b = await R.join('b', 'Mumon', SECRET)
    expect(b.att.mark).toBe('mumon')
    await R.again(b, 'maddie')
    expect(b.att).toMatchObject({ name: 'maddie' })
    expect(b.att.mark).toBeUndefined()
  })
})

describe('server/index.js: a LAN server holds the name the same way', () => {
  let server, port
  const open = () => new Promise((resolve) => { const ws = new WebSocket(`ws://localhost:${port}`); ws.once('open', () => resolve(ws)) })
  const next = (ws, type) => new Promise((resolve) => { const on = (d) => { const m = JSON.parse(d.toString()); if (m.type === type) { ws.off('message', on); resolve(m) } }; ws.on('message', on) })
  afterEach(() => { delete process.env.OWNER_KEY; if (server) server.close(); server = null })

  it('without OWNER_KEY: Mumon is wanderer (welcome says so), and no mark reaches the others', async () => {
    server = await createServer(0); port = server.address().port
    const a = await open(); a.send(JSON.stringify({ type: 'join', roomId: 'lan-m1', name: 'maddie' })); await next(a, 'welcome')
    const b = await open()
    const joined = next(a, 'joined')
    b.send(JSON.stringify({ type: 'join', roomId: 'lan-m1', name: 'Mumon', key: SECRET }))
    expect((await next(b, 'welcome')).name).toBe('wanderer')
    expect(await joined).toEqual({ type: 'joined', id: expect.any(String), name: 'wanderer' })
    a.close(); b.close()
  })
  it('with OWNER_KEY set and the key sent: the name is kept and marked in joined and players', async () => {
    process.env.OWNER_KEY = SECRET
    server = await createServer(0); port = server.address().port
    const a = await open(); a.send(JSON.stringify({ type: 'join', roomId: 'lan-m2', name: 'maddie' })); await next(a, 'welcome')
    const b = await open()
    const joined = next(a, 'joined')
    b.send(JSON.stringify({ type: 'join', roomId: 'lan-m2', name: 'Mumon', key: SECRET }))
    expect((await next(b, 'welcome')).name).toBe('Mumon')
    expect(await joined).toMatchObject({ name: 'Mumon', mark: 'mumon' })
    const list = (await next(a, 'players')).list
    expect(list.find((p) => p.name === 'Mumon')).toMatchObject({ mark: 'mumon' })
    expect(list.find((p) => p.name === 'maddie').mark).toBeUndefined()
    a.close(); b.close()
  })
})

describe('src/net/client.js: the key goes only over TLS, and the room\'s name is taken', () => {
  class FakeWS {
    constructor(url) { this.url = url; this.sent = []; FakeWS.last = this }
    send(d) { this.sent.push(JSON.parse(d)) }
    close() {}
  }
  const welcome = (name) => ({ data: JSON.stringify({ type: 'welcome', playerId: 'p1', worldSeed: 7, roomId: 'r', first: true, ...(name !== undefined ? { name } : {}) }) })

  it('wss://: join carries the key; the welcome name becomes getName(), and connect() resolves as it always did', async () => {
    const c = createMultiplayerClient('wss://relay.example/?room=r', { WebSocket: FakeWS, ownerKey: SECRET })
    const p = c.connect('r', null, 'Mumon')
    FakeWS.last.onopen()
    expect(FakeWS.last.sent[0]).toEqual({ type: 'join', roomId: 'r', name: 'Mumon', key: SECRET })
    FakeWS.last.onmessage(welcome('Mumon'))
    expect(Object.keys(await p)).toEqual(['worldSeed', 'playerId', 'roomId', 'first'])
    expect(c.getName()).toBe('Mumon')
  })
  it('ws:// (a LAN server, in the clear): the key is never sent', async () => {
    const c = createMultiplayerClient('ws://192.168.1.4:8765', { WebSocket: FakeWS, ownerKey: SECRET })
    const p = c.connect('r', null, 'Mumon')
    FakeWS.last.onopen()
    expect(FakeWS.last.sent[0]).toEqual({ type: 'join', roomId: 'r', name: 'Mumon' })
    FakeWS.last.onmessage(welcome('wanderer'))
    await p
    expect(c.getName()).toBe('wanderer')
  })
  it('no key held: no key field; an old room that sends no name leaves the asked name', async () => {
    const c = createMultiplayerClient('wss://relay.example/?room=r', { WebSocket: FakeWS })
    const p = c.connect('r', null, 'maddie')
    FakeWS.last.onopen()
    expect(FakeWS.last.sent[0]).toEqual({ type: 'join', roomId: 'r', name: 'maddie' })
    FakeWS.last.onmessage(welcome(undefined))
    await p
    expect(c.getName()).toBe('maddie')
  })
})

describe('owner.js: /owner keeps the key on this device', () => {
  const fakeLS = () => { const m = new Map(); return { m, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) } }
  it('keeps a valid key, says so without the key, reads it back, and forgets it on /owner off', () => {
    const ls = fakeLS()
    expect(owner.ownerCommand('', ls).line).toBe(owner.OWNER_LINES.none)
    const kept = owner.ownerCommand(SECRET, ls)
    expect(kept.line).toBe(owner.OWNER_LINES.kept)
    expect(kept.line).not.toContain(SECRET)
    expect(owner.readOwnerKey(ls)).toBe(SECRET)
    expect(ls.m.get(owner.OWNER_STORE)).toBe(SECRET)
    expect(owner.ownerCommand('  ', ls).line).toBe(owner.OWNER_LINES.held)
    expect(owner.ownerCommand('off', ls).line).toBe(owner.OWNER_LINES.forgot)
    expect(owner.readOwnerKey(ls)).toBeNull()
  })
  it('refuses a key the relay could never accept (short, long, with spaces), and keeps nothing', () => {
    const ls = fakeLS()
    for (const k of ['short', 'x'.repeat(129), 'has a space in it ok']) {
      expect(owner.ownerCommand(k, ls).line).toBe(owner.OWNER_LINES.bad)
      expect(owner.readOwnerKey(ls)).toBeNull()
    }
  })
  it('no storage: no key, and a keep says it failed', () => {
    expect(owner.readOwnerKey(null)).toBeNull()
    expect(owner.ownerCommand(SECRET, null).line).toBe(owner.OWNER_LINES.failed)
    const broken = { getItem: () => { throw new Error('denied') }, setItem: () => { throw new Error('denied') }, removeItem: () => {} }
    expect(owner.readOwnerKey(broken)).toBeNull()
    expect(owner.ownerCommand(SECRET, broken).line).toBe(owner.OWNER_LINES.failed)
  })
})

describe('the figure: other players see Mumon larger, and different', () => {
  it('PERSON.mumon is half as tall again as a player, and wider', () => {
    expect(PERSON.mumon.h / PERSON.player.h).toBeGreaterThan(1.45)
    expect(PERSON.mumon.w).toBeGreaterThan(PERSON.player.w)
    expect(PERSON.mumon.h).toBeLessThan(1)                       // under the ceiling
  })
  // a remote player 4 ahead, drawn alone on a flat background: the drawn rows and columns
  const drawn = (over) => {
    const W = 200, H = 120, bgc = ((255 << 24) | (60 << 16) | (170 << 8) | 210) >>> 0
    const buf = new Uint32Array(W * H).fill(bgc), z = new Float32Array(W).fill(30)
    const fs = { W, H, HH: H >> 1, fog: 16, fogRgb: [212, 200, 122], flicker: 1, t: 0.4, hf: 0.6, fov: 1.2, player: { x: 0, y: 0, angle: 0 }, opts: {}, lights: {} }
    const plates = drawSprites(buf, z, fs, [{ kind: 'player', x: 4, y: 0, name: 'someone', angle: Math.PI, hp: 100, ...over }]).map((p) => ({ ...p }))
    let x0 = 1e9, x1 = -1, y0 = 1e9, y1 = -1, n = 0
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (buf[y * W + x] !== bgc) { n++; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y) }
    return { h: y1 - y0, w: x1 - x0, n, plates, buf }
  }
  it('a player marked mumon is drawn taller and wider, with a higher nameplate; any other mark draws a plain player', () => {
    const plain = drawn({}), big = drawn({ mark: 'mumon' }), other = drawn({ mark: 'someone-else' })
    expect(big.h).toBeGreaterThan(plain.h * 1.3)
    expect(big.w).toBeGreaterThan(plain.w)
    expect(big.n).toBeGreaterThan(plain.n * 1.5)
    expect(big.plates[0].y).toBeLessThan(plain.plates[0].y)
    expect(big.plates[0].name).toBe('someone')
    expect(Array.from(other.buf)).toEqual(Array.from(plain.buf))
  })
  it('game.js forwards only the mark mumon onto the entity', () => {
    const r = {}
    ENTITY_FILLS.player(r, { x: 1, y: 2, name: 'Mumon', mark: 'mumon' }); expect(r.mark).toBe('mumon')
    ENTITY_FILLS.player(r, { x: 1, y: 2, name: 'x', mark: '<b>' }); expect(r.mark).toBeUndefined()
    ENTITY_FILLS.player(r, { x: 1, y: 2, name: 'x' }); expect(r.mark).toBeUndefined()
  })
})

describe('game.js and index.html wiring', () => {
  const game = read('../src/renderer/game.js'), html = read('../src/renderer/index.html')
  it('/owner runs ownerCommand and says its line; it is not in the help, and never goes out as chat', () => {
    expect(game).toContain("import { ownerCommand } from './owner.js'")
    expect(game).toMatch(/\} else if \(cmd === 'owner'\) \{\n(?:\s*\/\/[^\n]*\n)*\s*showMessage\(ownerCommand\(arg\)\.line\)\n/)
    expect(game).not.toMatch(/try \/recover[^']*\/owner/)
    expect(game).toContain("if (t.startsWith('/') && !t.startsWith('/me ')) handleCommand(t)")
  })
  it('index.html hands the kept key to the client', () => {
    expect(html).toContain("import { readOwnerKey } from './owner.js'")
    expect(html).toContain('const mpClient = createMultiplayerClient(serverUrl, { ownerKey: readOwnerKey() })')
  })
  it('a name the room would not give is said once, after the line is set up', () => {
    expect(game).toContain("const asked = (String(getPref('playerName') ?? '').trim() || 'wanderer').slice(0, 24)")
    expect(game).toContain('if (mpClient.getName() !== asked) setTimeout(() => showMessage(`the room will not call you ${asked}. here you are ${mpClient.getName()}.`, PRIO.interaction), 2200)')
  })
  it('the offline shells list owner.js', () => {
    expect(read('../src/sw.js')).toContain("'/renderer/owner.js'")
    expect(read('../tools/build-play.sh')).toContain("'owner.js'")
  })
})
