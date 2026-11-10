// The one new wire signal of 2.0.7: the room closes a socket that floods it with code 4029, reason 'too fast', and a 2.0.7 client takes
// that close as do not call again. The code is written three times — the client (src/net/client.js), the relay (relay/evguard.js) and
// the LAN server's copy (server/evguard.js) — and the three must say the same, or the client retries a room that asked it not to.
// The movement rate the client may be switched to (world.json net.posHz, at most 20) is also what the relay's pace was sized for
// (twice the most an honest client sends), so the two are pinned together here.
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import { FLOOD_CLOSE as CLIENT_CLOSE, POS_HZ, posHz } from '../src/net/client.js'
import { FLOOD_CLOSE as RELAY_CLOSE, FLOOD_REASON as RELAY_REASON, POS_RATE as RELAY_POS_RATE } from '../relay/evguard.js'
import { FLOOD_CLOSE as SERVER_CLOSE, FLOOD_REASON as SERVER_REASON, POS_RATE as SERVER_POS_RATE } from '../server/evguard.js'

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n')

describe('the flood close is the same code everywhere', () => {
  it('client, relay and LAN server all close and read 4029', () => {
    expect(CLIENT_CLOSE).toBe(4029)
    expect(RELAY_CLOSE).toBe(CLIENT_CLOSE)
    expect(SERVER_CLOSE).toBe(CLIENT_CLOSE)
  })

  it("both servers give the reason 'too fast', and the client's refused first join says the same", () => {
    expect(RELAY_REASON).toBe('too fast')
    expect(SERVER_REASON).toBe(RELAY_REASON)
    const client = read('../src/net/client.js')
    expect(client.includes("code === FLOOD_CLOSE ? 'too fast'")).toBe(true)
  })

  it('it is a private-use close code (4000 to 4999), so no browser or proxy means anything else by it', () => {
    expect(CLIENT_CLOSE).toBeGreaterThanOrEqual(4000)
    expect(CLIENT_CLOSE).toBeLessThanOrEqual(4999)
  })

  it('the relay and the LAN server close with the shared constants, never a bare number', () => {
    for (const p of ['../relay/relay.js', '../server/index.js']) {
      const src = read(p)
      expect(src.includes('ws.close(FLOOD_CLOSE, FLOOD_REASON)'), p).toBe(true)
      expect(src.includes('ws.close(4029'), p).toBe(false)
    }
  })
})

describe('the movement rate the client can be switched to stays inside the pace the relay was sized for', () => {
  it('the most the switch allows is 20 a second, and both servers pace pos at twice that', () => {
    expect(POS_HZ).toBe(20)
    expect(posHz({ posHz: 99 })).toBe(POS_HZ)     // anything out of range falls back to 20, never above
    expect(posHz({ posHz: 20 })).toBe(20)
    expect(RELAY_POS_RATE).toBe(2 * POS_HZ)
    expect(SERVER_POS_RATE).toBe(RELAY_POS_RATE)
  })

  it('world.json ships the switch at 20 and the validator caps it at 20', () => {
    const world = JSON.parse(read('../src/renderer/world.json'))
    expect(world.net).toEqual({ posHz: 20 })
    const v = read('../tools/validate-world.mjs')
    expect(v.includes('raw.net.posHz <= 20')).toBe(true)
  })
})
