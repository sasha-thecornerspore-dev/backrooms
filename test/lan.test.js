// HOST LAN / JOIN LAN must meet with the defaults (MP-1) and HOST keeps one server (MP-4).
// Every real server here binds 127.0.0.1 so no firewall prompt is ever raised.
import { describe, it, expect, afterEach } from 'vitest'
import { readFileSync } from 'fs'
import { WebSocket } from 'ws'
import { createServer } from '../server/index.js'
import { createMultiplayerClient } from '../src/net/client.js'
import { lanAddress, lanUrl, createLanHost, LAN_PORT, LAN_ROOM } from '../src/lan.js'

global.WebSocket = WebSocket
const LOCAL = '127.0.0.1'
const html = readFileSync(new URL('../src/renderer/index.html', import.meta.url), 'utf8')
const mainSrc = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8')

const cleanup = []
afterEach(async () => { while (cleanup.length) await cleanup.pop()() })
const closeLater = (s) => cleanup.push(() => new Promise((r) => s.close(() => r())))

describe('lanAddress / lanUrl', () => {
  const ifaces = {
    lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }, { address: '::1', family: 'IPv6', internal: true }],
    'vEthernet': [{ address: 'fe80::1', family: 'IPv6', internal: false }],
    'Wi-Fi': [{ address: '192.168.1.23', family: 'IPv4', internal: false }],
    eth1: [{ address: '10.0.0.5', family: 'IPv4', internal: false }],
  }
  it('picks the first non-internal IPv4 address', () => {
    expect(lanAddress(ifaces)).toBe('192.168.1.23')
  })
  it('skips link-local 169.254 addresses and prefers a home-LAN range', () => {
    const win = {
      'Ethernet 2': [{ address: '169.254.83.107', family: 'IPv4', internal: false }],
      'vEthernet (WSL)': [{ address: '172.24.160.1', family: 'IPv4', internal: false }],
      'Wi-Fi': [{ address: '192.168.0.42', family: 'IPv4', internal: false }],
    }
    expect(lanAddress(win)).toBe('192.168.0.42')
    expect(lanAddress({ a: win['Ethernet 2'] })).toBe(null)
    expect(lanAddress({ a: win['Ethernet 2'], b: win['vEthernet (WSL)'] })).toBe('172.24.160.1')
    expect(lanAddress({ a: [{ address: '100.70.1.2', family: 'IPv4', internal: false }] })).toBe('100.70.1.2')
  })
  it('prefers the real network adapter over Hyper-V / WSL / VM switches in the same range', () => {
    const ifs = {
      'vEthernet (WSL)': [{ family: 'IPv4', address: '172.28.208.1', internal: false }],
      'vEthernet (Default Switch)': [{ family: 'IPv4', address: '172.24.192.1', internal: false }],
      Ethernet: [{ family: 'IPv4', address: '172.16.20.101', internal: false }],
    }
    expect(lanAddress(ifs)).toBe('172.16.20.101')
    expect(lanAddress({ 'VirtualBox Host-Only Network': [{ family: 'IPv4', address: '192.168.56.1', internal: false }], 'Wi-Fi': [{ family: 'IPv4', address: '10.0.0.7', internal: false }] })).toBe('10.0.0.7')
    expect(lanAddress({ 'vEthernet (WSL)': [{ family: 'IPv4', address: '172.28.208.1', internal: false }] })).toBe('172.28.208.1')   // only a virtual one: better than none
  })
  it('accepts the numeric family some Node versions report', () => {
    expect(lanAddress({ en0: [{ address: '10.1.2.3', family: 4, internal: false }] })).toBe('10.1.2.3')
  })
  it('returns null when only loopback / IPv6 exist', () => {
    expect(lanAddress({ lo: ifaces.lo, v6: ifaces.vEthernet })).toBe(null)
    expect(lanAddress(undefined)).toBe(null)
    expect(lanUrl({ lo: ifaces.lo }, 8765)).toBe(null)
  })
  it('builds the ws:// url a friend types into JOIN LAN', () => {
    expect(lanUrl(ifaces, 8765)).toBe('ws://192.168.1.23:8765')
  })
})

describe('createServer listen errors', () => {
  it('rejects with EADDRINUSE instead of hanging or throwing when the port is taken', async () => {
    const a = await createServer(0, LOCAL); closeLater(a)
    await expect(createServer(a.address().port, LOCAL)).rejects.toMatchObject({ code: 'EADDRINUSE' })
  })
  it('binds only the host it is given', async () => {
    const a = await createServer(0, LOCAL); closeLater(a)
    expect(a.address().address).toBe(LOCAL)
  })
})

describe('createLanHost', () => {
  it('defaults to port 8765 and the room JOIN LAN defaults to', () => {
    expect(LAN_PORT).toBe(8765)
    expect(LAN_ROOM).toBe('backrooms')
    expect(html).toMatch(/id="join-url"[^>]*value="ws:\/\/localhost:8765"/)
    expect(html).toMatch(/id="join-room"[^>]*value="backrooms"/)
    expect(html).toMatch(/const LAN_ROOM = 'backrooms'/)
    expect(html).not.toMatch(/startMultiplayer\([^)]*'local'\)/)
  })

  it('uses the preferred port when it is free', async () => {
    const probe = await createServer(0, LOCAL)
    const free = probe.address().port
    await new Promise((r) => probe.close(() => r()))
    const host = createLanHost({ createServer, port: free, host: LOCAL })
    cleanup.push(() => host.close())
    expect(await host.start()).toBe(free)
  })

  it('falls back to a free port only when the preferred one is taken', async () => {
    const busy = await createServer(0, LOCAL); closeLater(busy)
    const taken = busy.address().port
    const host = createLanHost({ createServer, port: taken, host: LOCAL })
    cleanup.push(() => host.close())
    const port = await host.start()
    expect(port).not.toBe(taken)
    expect(port).toBeGreaterThan(0)
  })

  it('does not fall back on other errors, and a later click can retry', async () => {
    let calls = 0
    const boom = Object.assign(new Error('EACCES'), { code: 'EACCES' })
    const fake = async (port) => {
      calls++
      if (calls === 1) throw boom
      return { address: () => ({ port }), close: (cb) => cb() }
    }
    const host = createLanHost({ createServer: fake, port: 8765 })
    await expect(host.start()).rejects.toBe(boom)
    expect(calls).toBe(1)
    expect(await host.start()).toBe(8765)
  })

  it('keeps ONE server: repeated and concurrent HOST clicks get the same port', async () => {
    let made = 0
    const counting = (p, h) => { made++; return createServer(p, h) }
    const host = createLanHost({ createServer: counting, port: 0, host: LOCAL })
    cleanup.push(() => host.close())
    const [a, b] = await Promise.all([host.start(), host.start()])
    const c = await host.start()
    expect(made).toBe(1)
    expect(b).toBe(a)
    expect(c).toBe(a)
  })

  it('close() stops the server so the port is free again', async () => {
    const host = createLanHost({ createServer, port: 0, host: LOCAL })
    const port = await host.start()
    expect(host.running).toBe(true)
    await host.close()
    expect(host.running).toBe(false)
    const again = await createServer(port, LOCAL); closeLater(again)
    expect(again.address().port).toBe(port)
  })

  it('a host and a joiner using the defaults meet in the same world', async () => {
    const host = createLanHost({ createServer, port: 0, host: LOCAL })
    cleanup.push(() => host.close())
    const port = await host.start()
    const a = createMultiplayerClient(`ws://${LOCAL}:${port}`)
    const b = createMultiplayerClient(`ws://${LOCAL}:${port}`)
    cleanup.push(async () => { a.disconnect(); b.disconnect() })
    const wa = await a.connect(LAN_ROOM, null, 'host')
    const wb = await b.connect('backrooms', null, 'friend')   // JOIN LAN's default room
    expect(wb.worldSeed).toBe(wa.worldSeed)
  })
})

describe('main.js wiring', () => {
  it('keeps the LAN host at module level and closes it on quit', () => {
    expect(mainSrc).toMatch(/^let lanHost = null/m)
    expect(mainSrc).toMatch(/createLanHost\(\{ createServer \}\)/)
    expect(mainSrc).toMatch(/app\.on\('before-quit'[^\n]*lanHost\.close\(\)/)
    expect(mainSrc).not.toMatch(/createServer\(0\)/)
  })
})
