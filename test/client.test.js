import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer } from '../server/index.js'
import { WebSocket, WebSocketServer } from 'ws'
import { createMultiplayerClient } from '../src/net/client.js'

// inject Node WebSocket for test environment
global.WebSocket = WebSocket

let server, port

beforeAll(async () => {
  server = await createServer(0)
  port = server.address().port
})

afterAll(() => server.close())

describe('createMultiplayerClient', () => {
  it('connects and receives worldSeed', async () => {
    const client = createMultiplayerClient(`ws://localhost:${port}`)
    const { worldSeed } = await client.connect('testroom')
    expect(typeof worldSeed).toBe('number')
    client.disconnect()
  })

  it('isConnected is true after connect', async () => {
    const client = createMultiplayerClient(`ws://localhost:${port}`)
    await client.connect('room2')
    expect(client.isConnected()).toBe(true)
    client.disconnect()
  })

  it('isConnected is false after disconnect', async () => {
    const client = createMultiplayerClient(`ws://localhost:${port}`)
    await client.connect('room3')
    client.disconnect()
    await new Promise(r => setTimeout(r, 50))
    expect(client.isConnected()).toBe(false)
  })

  it('getRemotePlayers returns array', async () => {
    const client = createMultiplayerClient(`ws://localhost:${port}`)
    await client.connect('room4')
    expect(Array.isArray(client.getRemotePlayers())).toBe(true)
    client.disconnect()
  })

  it('two clients see each other', async () => {
    const c1 = createMultiplayerClient(`ws://localhost:${port}`)
    const c2 = createMultiplayerClient(`ws://localhost:${port}`)
    await c1.connect('sharedroom')
    await c2.connect('sharedroom')
    c1.sendPos(10, 20, 1.5)
    await new Promise(r => setTimeout(r, 150))  // wait for broadcast tick
    const players = c2.getRemotePlayers()
    expect(players.some(p => Math.abs(p.x - 10) < 0.01)).toBe(true)
    c1.disconnect(); c2.disconnect()
  })
})

// ---- W1: the net substrate on the client side ------------------------------
// A raw ws server stands in for an OLD server (no welcome.first, no 'ev') and
// for frames the real one never sends.
function fakeServer(onJoin) {
  return new Promise((resolve) => {
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 }, () => {
      const url = `ws://127.0.0.1:${wss.address().port}`
      resolve({ wss, url, close: () => new Promise(r => wss.close(() => r())) })
    })
    wss.on('connection', (sock) => {
      sock.on('message', (raw) => {
        const msg = JSON.parse(raw.toString())
        if (msg.type === 'join') onJoin(sock, msg)
        else sock.emit('client-msg', msg)
      })
    })
  })
}
const send = (sock, obj) => sock.send(typeof obj === 'string' ? obj : JSON.stringify(obj))
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

describe('connect → first / arrival', () => {
  it('connect resolves first from the real server and arrival follows it', async () => {
    const c1 = createMultiplayerClient(`ws://127.0.0.1:${port}`)
    const c2 = createMultiplayerClient(`ws://127.0.0.1:${port}`)
    const w1 = await c1.connect('firstroom', null, 'ada')
    expect(w1.first).toBe(true)
    expect(c1.arrival()).toBe('walked')
    const w2 = await c2.connect('firstroom', null, 'bo')
    expect(w2.first).toBe(false)
    expect(c2.arrival()).toBe('dropped')
    expect(Object.keys(w2)).toEqual(['worldSeed', 'playerId', 'roomId', 'first'])
    c1.disconnect(); c2.disconnect()
  })

  it("old server (no first): 'dropped' when the first players list shows others", async () => {
    const fs = await fakeServer((sock) => {
      send(sock, { type: 'welcome', playerId: 'me', worldSeed: 7, roomId: 'r' })
      send(sock, { type: 'players', list: [{ id: 'me', x: 0, y: 0, angle: 0, name: 'ada' }, { id: 'b', x: 1, y: 1, angle: 0, name: 'bo' }] })
    })
    const c = createMultiplayerClient(fs.url)
    const w = await c.connect('r', null, 'ada')
    expect(w.first).toBeUndefined()
    await sleep(30)
    expect(c.arrival()).toBe('dropped')
    c.disconnect(); await fs.close()
  })

  it("old server (no first): 'walked' when the first list is only me", async () => {
    const fs = await fakeServer((sock) => {
      send(sock, { type: 'welcome', playerId: 'me', worldSeed: 7, roomId: 'r' })
      send(sock, { type: 'players', list: [{ id: 'me', x: 0, y: 0, angle: 0, name: 'ada' }] })
    })
    const c = createMultiplayerClient(fs.url)
    await c.connect('r')
    await sleep(30)
    expect(c.arrival()).toBe('walked')
    c.disconnect(); await fs.close()
  })

  it("old server (no first): 'walked' on the 400 ms timeout, and a late list does not flip it", async () => {
    let sock
    const fs = await fakeServer((s) => { sock = s; send(s, { type: 'welcome', playerId: 'me', worldSeed: 7, roomId: 'r' }) })
    const c = createMultiplayerClient(fs.url)
    await c.connect('r')
    expect(c.arrival()).toBe('walked')             // the default, before anything is known
    await sleep(450)
    send(sock, { type: 'players', list: [{ id: 'me' }, { id: 'b', x: 1, y: 1, name: 'bo' }] })
    await sleep(30)
    expect(c.arrival()).toBe('walked')
    expect(c.getRemotePlayers().length).toBe(1)   // the list itself still lands
    c.disconnect(); await fs.close()
  })
})

describe('forward compatibility', () => {
  it("incoming {type:'future'} leaves remotePlayers and callbacks untouched", async () => {
    let sock
    const fs = await fakeServer((s) => {
      sock = s
      send(s, { type: 'welcome', playerId: 'me', worldSeed: 7, roomId: 'r', first: true, extra: 1 })
      send(s, { type: 'players', list: [{ id: 'me' }, { id: 'b', x: 1, y: 1, angle: 0, name: 'bo' }] })
    })
    const c = createMultiplayerClient(fs.url)
    const chats = [], typings = [], evs = []
    c.onChat((...a) => chats.push(a)); c.onTyping((...a) => typings.push(a)); c.onEv(m => evs.push(m))
    await c.connect('r')
    await sleep(20)
    const strip = () => JSON.stringify(c.getRemotePlayers().map(({ stillFor, ...p }) => p))
    const before = strip()
    send(sock, { type: 'future', id: 'b', list: [], text: 'x' })
    send(sock, 'not json')
    send(sock, { type: 'players', list: [{ id: 'me' }, { id: 'b', x: 1, y: 1, angle: 0, name: 'bo' }] })
    await sleep(30)
    expect(strip()).toBe(before)
    expect(chats).toEqual([]); expect(typings).toEqual([]); expect(evs).toEqual([])
    c.disconnect(); await fs.close()
  })
})

describe('chat ids and ev', () => {
  it('onChat receives msg.id as the 4th arg (chat, joined, left, local echo)', async () => {
    let sock
    const fs = await fakeServer((s) => {
      sock = s
      send(s, { type: 'welcome', playerId: 'me', worldSeed: 7, roomId: 'r', first: true })
      send(s, { type: 'players', list: [{ id: 'me' }, { id: 'b', x: 1, y: 1, angle: 0, name: 'bo' }] })
    })
    const c = createMultiplayerClient(fs.url)
    const chats = []
    c.onChat((...a) => chats.push(a))
    await c.connect('r', null, 'ada')
    await sleep(20)
    send(sock, { type: 'joined', id: 'b', name: 'bo' })
    send(sock, { type: 'chat', id: 'b', name: 'bo', text: 'hi' })
    send(sock, { type: 'chat', id: 'me', name: 'ada', text: 'echo from server' })
    send(sock, { type: 'left', id: 'b', name: 'bo' })
    await sleep(30)
    c.sendChat('hello')
    expect(chats).toEqual([
      ['bo', 'entered the level.', true, 'b'],
      ['bo', 'hi', false, 'b'],
      ['bo', 'no-clipped away.', true, 'b'],
      ['ada', 'hello', false, 'me'],
    ])
    c.disconnect(); await fs.close()
  })

  it("sendEv writes {type:'ev', kind, payload, ...opts}; onEv delivers others' frames and never my own", async () => {
    let sock
    const fromClient = []
    const fs = await fakeServer((s) => {
      sock = s
      s.on('client-msg', m => fromClient.push(m))
      send(s, { type: 'welcome', playerId: 'me', worldSeed: 7, roomId: 'r', first: true })
    })
    const c = createMultiplayerClient(fs.url)
    const evs = []
    c.onEv(m => evs.push(m))
    await c.connect('r')
    c.sendEv('cache', { cx: 1 }, { keep: 'c:1:1,1' })
    c.sendEv('kneel', { to: 'b' })
    await sleep(30)
    expect(fromClient).toEqual([
      { type: 'ev', kind: 'cache', payload: { cx: 1 }, keep: 'c:1:1,1' },
      { type: 'ev', kind: 'kneel', payload: { to: 'b' } },
    ])
    send(sock, { type: 'ev', id: 'b', name: 'bo', kind: 'whistle', payload: { c: 1 }, t: 5 })
    send(sock, { type: 'ev', id: 'me', name: 'ada', kind: 'whistle', payload: { c: 2 }, t: 6 })
    send(sock, { type: 'ev', id: 'z', name: 'zed', kind: 'cache', payload: { cx: 1 }, t: 7, replay: true })
    await sleep(30)
    expect(evs).toEqual([
      { type: 'ev', id: 'b', name: 'bo', kind: 'whistle', payload: { c: 1 }, t: 5 },
      { type: 'ev', id: 'z', name: 'zed', kind: 'cache', payload: { cx: 1 }, t: 7, replay: true },
    ])
    c.disconnect(); await fs.close()
  })

  it('the relay\'s replay right after welcome reaches a listener registered later (as initGame does, after its world loads), on the next tick', async () => {
    const fs = await fakeServer((s) => {
      send(s, { type: 'welcome', playerId: 'me', worldSeed: 7, roomId: 'r', first: false })
      send(s, { type: 'ev', id: 'ada', name: 'ada', kind: 'cache', payload: { cx: 1 }, t: 1, replay: true })
      send(s, { type: 'ev', id: 'me', name: 'me', kind: 'cache', payload: { cx: 9 }, t: 2, replay: true })   // my own: never
      send(s, { type: 'ev', id: 'ada', name: 'ada', kind: 'take', payload: { key: 'c:1:1,1' }, t: 3, replay: true })
    })
    const c = createMultiplayerClient(fs.url)
    await c.connect('r')
    await sleep(20)                                   // the world.json fetch
    const evs = []
    c.onEv(m => evs.push(m))
    expect(evs).toEqual([])                           // not inside the caller's synchronous setup
    await sleep(0)
    expect(evs.map((m) => [m.kind, m.t])).toEqual([['cache', 1], ['take', 3]])
    const late = []
    c.onEv(m => late.push(m))                         // drained once: a second listener gets only what comes after
    await sleep(10)
    expect(late).toEqual([])
    c.disconnect(); await fs.close()
  })

  it('the early queue is bounded and a reconnect forgets it', async () => {
    let joins = 0
    const fs = await fakeServer((s) => {
      joins++
      send(s, { type: 'welcome', playerId: 'me', worldSeed: 7, roomId: 'r', first: true })
      for (let i = 0; i < 300; i++) send(s, { type: 'ev', id: 'b', name: 'bo', kind: 'here', payload: {}, t: joins * 1000 + i })
    })
    const c = createMultiplayerClient(fs.url)
    await c.connect('r')
    await sleep(40)
    await c.connect('r')                              // a fresh join: the old room's frames are not this one's
    await sleep(40)
    const evs = []
    c.onEv(m => evs.push(m))
    await sleep(10)
    expect(evs.length).toBe(256)
    expect([evs[0].t, evs[255].t]).toEqual([2000, 2255])
    c.disconnect(); await fs.close()
  })

  it('sendEv is a no-op while disconnected', () => {
    const c = createMultiplayerClient('ws://127.0.0.1:1')
    expect(() => c.sendEv('kneel', {})).not.toThrow()
  })

  it('exposes the player id once welcomed', async () => {
    const c = createMultiplayerClient(`ws://127.0.0.1:${port}`)
    expect(c.id).toBe(null)
    const { playerId } = await c.connect('idroom')
    expect(c.id).toBe(playerId)
    expect(c.getId()).toBe(playerId)
    c.disconnect()
  })
})

describe('remote records', () => {
  it('keeps fields the bus writes across list merges, and mergeRemote ignores unknown ids', async () => {
    let sock
    const fs = await fakeServer((s) => {
      sock = s
      send(s, { type: 'welcome', playerId: 'me', worldSeed: 7, roomId: 'r', first: true })
      send(s, { type: 'players', list: [{ id: 'me' }, { id: 'b', x: 1, y: 1, angle: 0, name: 'bo', hp: 100 }] })
    })
    const c = createMultiplayerClient(fs.url)
    await c.connect('r')
    await sleep(20)
    c.mergeRemote('b', { origin: 'tenant', thin: true, status: 'extension', aseed: 5, lit: true, st: 'down', seen: false, legacy: false })
    c.mergeRemote('nobody', { thin: true })
    send(sock, { type: 'players', list: [{ id: 'me' }, { id: 'b', x: 2, y: 1, angle: 0, name: 'bo', hp: 90 }] })
    await sleep(30)
    const [b] = c.getRemotePlayers()
    expect(b).toMatchObject({ id: 'b', x: 2, hp: 90, origin: 'tenant', thin: true, status: 'extension', aseed: 5, lit: true, st: 'down', seen: false, legacy: false })
    expect(c.getRemotePlayers().length).toBe(1)
    c.disconnect(); await fs.close()
  })

  it('stillFor grows while successive list positions agree (< 0.02) and resets on movement', async () => {
    let sock
    const fs = await fakeServer((s) => {
      sock = s
      send(s, { type: 'welcome', playerId: 'me', worldSeed: 7, roomId: 'r', first: true })
    })
    const c = createMultiplayerClient(fs.url)
    await c.connect('r')
    const list = (x) => send(sock, { type: 'players', list: [{ id: 'me' }, { id: 'b', x, y: 1, angle: 0, name: 'bo' }] })
    list(1); await sleep(20)
    expect(c.getRemotePlayers()[0].stillFor).toBe(0)
    list(1.01); await sleep(650)
    list(1.0); await sleep(20)
    expect(c.getRemotePlayers()[0].stillFor).toBeGreaterThanOrEqual(0.6)
    list(1.5); await sleep(20)
    expect(c.getRemotePlayers()[0].stillFor).toBe(0)
    c.disconnect(); await fs.close()
  })

  it('a real server: a parked friend reads still after 0.7 s; a moving one does not', async () => {
    const c1 = createMultiplayerClient(`ws://127.0.0.1:${port}`)
    const c2 = createMultiplayerClient(`ws://127.0.0.1:${port}`)
    await c1.connect('stillroom'); await c2.connect('stillroom')
    c1.sendPos(3, 3, 0)
    await sleep(700)
    // the full suite runs files in parallel: a loaded machine delays the server's 20 Hz lists, so give the clock up to 1.5 s more to read 0.6
    for (let t = 0; t < 1500 && !(c2.getRemotePlayers()[0]?.stillFor >= 0.6); t += 25) await sleep(25)
    expect(c2.getRemotePlayers()[0].stillFor).toBeGreaterThanOrEqual(0.6)
    c1.sendPos(4, 3, 0)
    await sleep(120)
    expect(c2.getRemotePlayers()[0].stillFor).toBeLessThan(0.2)
    c1.disconnect(); c2.disconnect()
  })
})
