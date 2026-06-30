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
