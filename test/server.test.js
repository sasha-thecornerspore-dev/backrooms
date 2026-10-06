// test/server.test.js
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer } from '../server/index.js'
import WebSocket from 'ws'

let server, port

beforeAll(async () => {
  server = await createServer(0)  // port 0 = OS assigns
  port = server.address().port
})

afterAll(() => server.close())

function connect() {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://localhost:${port}`)
    ws.once('open', () => resolve(ws))
  })
}

function nextMsg(ws) {
  return new Promise((resolve) => ws.once('message', d => resolve(JSON.parse(d.toString()))))
}

describe('server', () => {
  it('sends welcome on join', async () => {
    const ws = await connect()
    ws.send(JSON.stringify({ type: 'join', roomId: 'test1' }))
    const msg = await nextMsg(ws)
    expect(msg.type).toBe('welcome')
    expect(typeof msg.playerId).toBe('string')
    expect(typeof msg.worldSeed).toBe('number')
    ws.close()
  })

  it('two players in same room get same worldSeed', async () => {
    const ws1 = await connect()
    const ws2 = await connect()
    ws1.send(JSON.stringify({ type: 'join', roomId: 'seedtest' }))
    const w1 = await nextMsg(ws1)
    ws2.send(JSON.stringify({ type: 'join', roomId: 'seedtest' }))
    // ws2 gets welcome; ws1 gets 'joined'
    const [w2msg] = await Promise.all([nextMsg(ws2), nextMsg(ws1)])
    expect(w1.worldSeed).toBe(w2msg.worldSeed)
    ws1.close(); ws2.close()
  })

  it('honours a worldSeed override when creating a room', async () => {
    const ws = await connect()
    ws.send(JSON.stringify({ type: 'join', roomId: 'anchored', worldSeed: 123456789 }))
    const msg = await nextMsg(ws)
    expect(msg.worldSeed).toBe(123456789)
    // second joiner gets the same seed even if they ask for a different one
    const ws2 = await connect()
    ws2.send(JSON.stringify({ type: 'join', roomId: 'anchored', worldSeed: 42 }))
    const [w2] = await Promise.all([nextMsg(ws2), nextMsg(ws)])
    expect(w2.worldSeed).toBe(123456789)
    ws.close(); ws2.close()
  })

  it('ignores invalid worldSeed overrides', async () => {
    const ws = await connect()
    ws.send(JSON.stringify({ type: 'join', roomId: 'badseed', worldSeed: 'evil' }))
    const msg = await nextMsg(ws)
    expect(typeof msg.worldSeed).toBe('number')
    expect(msg.worldSeed).toBeGreaterThan(0)
    ws.close()
  })

  it('broadcasts players list after pos update', async () => {
    const ws = await connect()
    ws.send(JSON.stringify({ type: 'join', roomId: 'postest' }))
    await nextMsg(ws)  // welcome
    ws.send(JSON.stringify({ type: 'pos', x: 10, y: 20, angle: 1.5 }))
    // wait for broadcast tick (server sends at 20Hz = 50ms)
    const msg = await new Promise((resolve) => {
      ws.on('message', d => { const m = JSON.parse(d.toString()); if (m.type === 'players') resolve(m) })
      setTimeout(() => resolve(null), 200)
    })
    expect(msg).not.toBeNull()
    expect(Array.isArray(msg.list)).toBe(true)
    ws.close()
  })
})

// ---- W1: welcome.first, the 'ev' forwarder, the opt-in keep/drop log --------

// Every message the server emits for a socket, filtered by type; the 20 Hz
// players list is noise for these tests.
function collect(ws, type, ms = 150) {
  return new Promise((resolve) => {
    const got = []
    const on = (d) => { const m = JSON.parse(d.toString()); if (m.type === type) got.push(m) }
    ws.on('message', on)
    setTimeout(() => { ws.off('message', on); resolve(got) }, ms)
  })
}

function joinOn(ws, roomId, name) {
  ws.send(JSON.stringify({ type: 'join', roomId, name }))
  return new Promise((resolve) => {
    const on = (d) => { const m = JSON.parse(d.toString()); if (m.type === 'welcome') { ws.off('message', on); resolve(m) } }
    ws.on('message', on)
  })
}

async function joined(roomId, name) {
  const ws = await connect()
  const welcome = await joinOn(ws, roomId, name)
  return { ws, welcome }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

describe('welcome.first', () => {
  it('is true for the first joiner, false for the second while the first is connected, true again after the first leaves', async () => {
    const a = await joined('firstroom', 'a')
    expect(a.welcome.first).toBe(true)
    const b = await joined('firstroom', 'b')
    expect(b.welcome.first).toBe(false)
    b.ws.close()
    await sleep(100)
    const c = await joined('firstroom', 'c')
    expect(c.welcome.first).toBe(false)     // a is still in the room
    a.ws.close(); c.ws.close()
    await sleep(100)
    const d = await joined('firstroom', 'd')
    expect(d.welcome.first).toBe(true)      // nobody left: first again, same world
    expect(d.welcome.worldSeed).toBe(a.welcome.worldSeed)
    d.ws.close()
  })
})

describe("the 'ev' forwarder", () => {
  it('A sends ev → B receives {type:ev, id:A, name, kind, payload, t}; A does not', async () => {
    const a = await joined('evroom', 'ada')
    const b = await joined('evroom', 'bo')
    const [toB, toA] = await Promise.all([
      collect(b.ws, 'ev'),
      collect(a.ws, 'ev'),
      (async () => { a.ws.send(JSON.stringify({ type: 'ev', kind: 'whistle', payload: { x: 1, y: 2, lvl: 1, c: 3, n: 7 } })) })(),
    ])
    expect(toA).toEqual([])
    expect(toB.length).toBe(1)
    expect(toB[0]).toMatchObject({ type: 'ev', id: a.welcome.playerId, name: 'ada', kind: 'whistle', payload: { x: 1, y: 2, lvl: 1, c: 3, n: 7 } })
    expect(typeof toB[0].t).toBe('number')
    expect(toB[0].replay).toBeUndefined()
    expect(Object.keys(toB[0])).toEqual(['type', 'id', 'name', 'kind', 'payload', 't'])
    a.ws.close(); b.ws.close()
  })

  it('a 2 KB frame is dropped; a 1 KB frame is forwarded verbatim', async () => {
    const a = await joined('evsize', 'ada')
    const b = await joined('evsize', 'bo')
    const big = 'x'.repeat(2048)
    const ok = 'y'.repeat(1024)
    const [toB] = await Promise.all([
      collect(b.ws, 'ev'),
      (async () => {
        a.ws.send(JSON.stringify({ type: 'ev', kind: 'cache', payload: big }))
        a.ws.send(JSON.stringify({ type: 'ev', kind: 'cache', payload: ok }))
      })(),
    ])
    expect(toB.length).toBe(1)
    expect(toB[0].payload).toBe(ok)
    a.ws.close(); b.ws.close()
  })

  it('{type:ev} before join → nothing; kind Bad → nothing; missing kind → nothing', async () => {
    const lone = await connect()
    const [toLone] = await Promise.all([
      collect(lone, 'ev'),
      (async () => { lone.send(JSON.stringify({ type: 'ev', kind: 'whistle', payload: {} })) })(),
    ])
    expect(toLone).toEqual([])
    expect(lone.readyState).toBe(WebSocket.OPEN)
    lone.close()

    const a = await joined('evkind', 'ada')
    const b = await joined('evkind', 'bo')
    const [toB] = await Promise.all([
      collect(b.ws, 'ev'),
      (async () => {
        a.ws.send(JSON.stringify({ type: 'ev', kind: 'Bad', payload: {} }))
        a.ws.send(JSON.stringify({ type: 'ev', payload: {} }))
        a.ws.send(JSON.stringify({ type: 'ev', kind: 'a'.repeat(17), payload: {} }))
        a.ws.send(JSON.stringify({ type: 'ev', kind: 'ok', payload: 1 }))
      })(),
    ])
    expect(toB.length).toBe(1)
    expect(toB[0].kind).toBe('ok')
    a.ws.close(); b.ws.close()
  })

  it('the token bucket lets 20 through at once and holds the rest', async () => {
    const a = await joined('evrate', 'ada')
    const b = await joined('evrate', 'bo')
    const [toB] = await Promise.all([
      collect(b.ws, 'ev', 200),
      (async () => { for (let i = 0; i < 30; i++) a.ws.send(JSON.stringify({ type: 'ev', kind: 'woke', payload: { i } })) })(),
    ])
    expect(toB.length).toBeGreaterThanOrEqual(20)
    expect(toB.length).toBeLessThan(25)          // a refill or two during the 200 ms window at most
    expect(toB.map(m => m.payload.i).slice(0, 20)).toEqual([...Array(20).keys()])
    a.ws.close(); b.ws.close()
  })

  it('keep/drop are ignored when the log is off (the default), and the frame still forwards', async () => {
    const a = await joined('evnolog', 'ada')
    const b = await joined('evnolog', 'bo')
    const [toB] = await Promise.all([
      collect(b.ws, 'ev'),
      (async () => { a.ws.send(JSON.stringify({ type: 'ev', kind: 'cache', payload: { cx: 1 }, keep: 'c:1:1,1' })) })(),
    ])
    expect(toB.length).toBe(1)
    const c = await joined('evnolog', 'cy')
    expect(await collect(c.ws, 'ev')).toEqual([])
    a.ws.close(); b.ws.close(); c.ws.close()
  })
})

describe('the keep/drop log (--evlog opt-in)', () => {
  let logServer, logPort
  beforeAll(async () => {
    logServer = await createServer(0, '127.0.0.1', { evlog: true })
    logPort = logServer.address().port
  })
  afterAll(() => logServer.close())

  // The replay lands in the same chunk as welcome, so listen from the first byte:
  // evs collects every 'ev' the socket ever receives.
  async function ljoin(roomId, name) {
    const ws = await new Promise((resolve) => {
      const s = new WebSocket(`ws://127.0.0.1:${logPort}`)
      s.once('open', () => resolve(s))
    })
    const evs = []
    ws.on('message', (d) => { const m = JSON.parse(d.toString()); if (m.type === 'ev') evs.push(m) })
    const welcome = await joinOn(ws, roomId, name)
    return { ws, welcome, evs }
  }

  it('replays kept frames to a later joiner right after welcome, stamped replay:true; drop removes them', async () => {
    const a = await ljoin('logroom', 'ada')
    a.ws.send(JSON.stringify({ type: 'ev', kind: 'cache', payload: { cx: 1, n: 1 }, keep: 'c:1:1,1' }))
    a.ws.send(JSON.stringify({ type: 'ev', kind: 'cache', payload: { cx: 2, n: 2 }, keep: 'c:1:2,2' }))
    a.ws.send(JSON.stringify({ type: 'ev', kind: 'cache', payload: { cx: 3, n: 3 }, keep: 'k'.repeat(60) }))
    a.ws.send(JSON.stringify({ type: 'ev', kind: 'take', payload: { key: 'c:1:1,1', n: 4 }, drop: 'c:1:1,1' }))
    await sleep(50)
    const c = await ljoin('logroom', 'cy')
    await sleep(100)
    const toC = c.evs
    expect(toC.map(m => m.payload.cx)).toEqual([2, 3])
    for (const m of toC) {
      expect(m.replay).toBe(true)
      expect(m.id).toBe(a.welcome.playerId)
      expect(m.name).toBe('ada')
      expect(m.kind).toBe('cache')
      expect(typeof m.t).toBe('number')
    }
    // the live sender never sees its own frame, kept or not
    expect(a.evs).toEqual([])
    // the log is per room
    const d = await ljoin('otherroom', 'dee')
    await sleep(100)
    expect(d.evs).toEqual([])
    a.ws.close(); c.ws.close(); d.ws.close()
  })

  it('keep wins over drop on one frame; non-string keep/drop are ignored', async () => {
    const a = await ljoin('logroom2', 'ada')
    a.ws.send(JSON.stringify({ type: 'ev', kind: 'cache', payload: { cx: 9 }, keep: 'x', drop: 'x' }))
    a.ws.send(JSON.stringify({ type: 'ev', kind: 'cache', payload: { cx: 10 }, keep: 42 }))
    await sleep(50)
    const c = await ljoin('logroom2', 'cy')
    await sleep(100)
    expect(c.evs.map(m => m.payload.cx)).toEqual([9])
    a.ws.close(); c.ws.close()
  })
})
