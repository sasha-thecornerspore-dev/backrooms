import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer } from '../server/index.js'
import { WebSocket } from 'ws'
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
