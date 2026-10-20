// test/evguard.test.js — the three pure guards every 'ev' frame passes on both
// servers, plus the textual mirror: relay.js cannot run under vitest (it
// imports 'cloudflare:workers'), so its branch is checked as source.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { evKindOk, evFrameOk, evBucket, evKeepOk, evDropOk, evKeepBucket, EV_KIND_RE, EV_FRAME_MAX, EV_RATE, EV_BURST, EV_KEEP_KINDS, EV_DROP_KINDS, EV_KEEP_RATE, EV_KEEP_BURST } from '../relay/evguard.js'
import * as serverCopy from '../server/evguard.js'

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8')
// the copy in server/ carries a header pointing at the original; the code below it is byte-identical
const body = (src) => src.split('\n').filter(l => !l.startsWith('//')).join('\n').trim()

describe('evKindOk', () => {
  it('accepts the documented kinds', () => {
    for (const k of ['here', 'whistle', 'kneel', 'woke', 'cache', 'take', 'ward', 'photo', 'a', 'a-1', 'a'.repeat(16)]) {
      expect(evKindOk(k)).toBe(true)
    }
  })
  it("rejects 'Ward', 17 chars, '', non-strings", () => {
    expect(evKindOk('Ward')).toBe(false)
    expect(evKindOk('a'.repeat(17))).toBe(false)
    expect(evKindOk('')).toBe(false)
    expect(evKindOk('-a')).toBe(false)
    expect(evKindOk('1a')).toBe(false)
    expect(evKindOk('a_b')).toBe(false)
    expect(evKindOk(undefined)).toBe(false)
    expect(evKindOk(null)).toBe(false)
    expect(evKindOk(42)).toBe(false)
  })
  it('exposes the regex the protocol documents', () => {
    expect(String(EV_KIND_RE)).toBe('/^[a-z][a-z0-9-]{0,15}$/')
  })
})

describe('evFrameOk', () => {
  it('accepts a string or a Buffer up to 1536 UTF-16 units', () => {
    expect(EV_FRAME_MAX).toBe(1536)
    expect(evFrameOk('x'.repeat(1536))).toBe(true)
    expect(evFrameOk(Buffer.from('x'.repeat(1536)))).toBe(true)
    expect(evFrameOk(new TextEncoder().encode('{"type":"ev"}').buffer)).toBe(true)
  })
  it('rejects a 1537-unit string and a non-string raw', () => {
    expect(evFrameOk('x'.repeat(1537))).toBe(false)
    expect(evFrameOk(Buffer.from('x'.repeat(1537)))).toBe(false)
    expect(evFrameOk({ type: 'ev' })).toBe(false)
    expect(evFrameOk(42)).toBe(false)
    expect(evFrameOk(null)).toBe(false)
    expect(evFrameOk(undefined)).toBe(false)
  })
})

describe('evBucket', () => {
  it('allows a burst of 20 then refills at 10/s with injected time', () => {
    expect(EV_RATE).toBe(10); expect(EV_BURST).toBe(20)
    const att = {}
    let t = 1000
    for (let i = 0; i < 20; i++) expect(evBucket(att, t)).toBe(true)
    expect(evBucket(att, t)).toBe(false)
    expect(evBucket(att, t + 50)).toBe(false)     // half a token is not a token
    expect(evBucket(att, t + 100)).toBe(true)     // one token per 100 ms
    expect(evBucket(att, t + 100)).toBe(false)
    t += 100 + 1000                               // a full second → 10 tokens
    for (let i = 0; i < 10; i++) expect(evBucket(att, t)).toBe(true)
    expect(evBucket(att, t)).toBe(false)
  })
  it('never banks more than the burst', () => {
    const att = {}
    expect(evBucket(att, 0)).toBe(true)
    for (let i = 0; i < 25; i++) expect(evBucket(att, 1000000)).toBe(i < 20)
  })
  it('keeps its state in the attachment it is handed (the relay round-trips it)', () => {
    const att = { id: 'a', name: 'b' }
    evBucket(att, 500)
    expect(att.id).toBe('a'); expect(att.name).toBe('b')
    expect(att.evT).toBe(500)
    expect(att.evTok).toBe(19)
    const copy = JSON.parse(JSON.stringify(att))  // survives serializeAttachment
    expect(evBucket(copy, 500)).toBe(true)
    expect(copy.evTok).toBe(18)
  })
  it('a clock that runs backwards does not drain or mint tokens', () => {
    const att = {}
    evBucket(att, 1000)
    expect(evBucket(att, 900)).toBe(true)
    expect(att.evTok).toBe(18)
  })
})

describe('the keep/drop log holds caches only, at its own pace', () => {
  it("only a 'cache' keep and a 'take' drop are logged", () => {
    expect(EV_KEEP_KINDS).toEqual(['cache'])
    expect(EV_DROP_KINDS).toEqual(['take'])
    expect(evKeepOk('cache')).toBe(true)
    for (const k of ['take', 'ward', 'photo', 'here', 'junk', '', undefined]) expect(evKeepOk(k)).toBe(false)
    expect(evDropOk('take')).toBe(true)
    for (const k of ['cache', 'ward', 'junk', undefined]) expect(evDropOk(k)).toBe(false)
  })
  it('a stored keep: a burst of 4, then one every 2 s, on its own fields of the attachment', () => {
    expect(EV_KEEP_RATE).toBe(0.5); expect(EV_KEEP_BURST).toBe(4)
    const att = {}
    for (let i = 0; i < 4; i++) expect(evKeepBucket(att, 1000)).toBe(true)
    expect(evKeepBucket(att, 1000)).toBe(false)
    expect(evKeepBucket(att, 2999)).toBe(false)
    expect(evKeepBucket(att, 3000)).toBe(true)
    expect(att.evTok).toBeUndefined()                // the ev bucket is untouched
    expect(evBucket(att, 3000)).toBe(true)
    expect(att.kpT).toBe(3000)
  })
})

describe('the server copy mirrors relay/evguard.js', () => {
  it('server/evguard.js is byte-identical below its header', () => {
    expect(body(read('../server/evguard.js'))).toBe(body(read('../relay/evguard.js')))
    expect(read('../server/evguard.js')).toMatch(/relay\/evguard\.js/)
    expect(serverCopy.evKindOk('here')).toBe(true)
  })
  it('server/evlog.js is byte-identical below its header', () => {
    expect(body(read('../server/evlog.js'))).toBe(body(read('../relay/evlog.js')))
    expect(read('../server/evlog.js')).toMatch(/relay\/evlog\.js/)
  })
})

describe("relay.js carries the mirrored 'ev' branch (source guard: it cannot run in node)", () => {
  const relay = read('../relay/relay.js')
  const server = read('../server/index.js')
  it("keeps the room's log in durable storage through the pure shell (test/relay-room.test.js drives it)", () => {
    expect(relay).toMatch(/createStoredLog\(this\.ctx\.storage, \{ max: 64, perName: 6, ttlDays: 30 \}\)/)
    expect(relay).toMatch(/const EV_FLUSH_MS = 10_000/)
  })
  it('imports the guards and the log from the pure modules', () => {
    expect(relay).toMatch(/import \{ evKindOk, evFrameOk, evBucket, evKeepOk, evDropOk, evKeepBucket \} from '\.\/evguard\.js'/)
    expect(relay).toMatch(/import \{ createStoredLog \} from '\.\/evlog\.js'/)
    expect(server).toMatch(/import \{ evKindOk, evFrameOk, evBucket, evKeepOk, evDropOk, evKeepBucket \} from '\.\/evguard\.js'/)
    expect(server).toMatch(/import \{ createEvLog \} from '\.\/evlog\.js'/)
  })
  it('both servers log only the kinds the log holds, a keep within its budget', () => {
    for (const src of [relay, server]) {
      const branch = src.slice(src.indexOf("msg.type === 'ev'"))
      expect(branch).toMatch(/evKeepOk\(kind\) && evKeepBucket\(/)
      expect(branch).toMatch(/evDropOk\(kind\)/)
    }
  })
  it("has the 'ev' branch with the three guards in order and the sender excluded", () => {
    for (const src of [relay, server]) {
      const i = src.indexOf("msg.type === 'ev'")
      expect(i).toBeGreaterThan(0)
      const branch = src.slice(i)
      const a = branch.indexOf('evFrameOk(raw)'), b = branch.indexOf('evKindOk(kind)'), c = branch.indexOf('evBucket(')
      expect(a).toBeGreaterThan(0); expect(b).toBeGreaterThan(a); expect(c).toBeGreaterThan(b)
      expect(branch).toMatch(/\{ type: 'ev', id: [a-zA-Z.]+, name: [a-zA-Z.]+, kind, payload: msg\.payload, t: Date\.now\(\) \}/)
      expect(branch).toMatch(/msg\.keep\.slice\(0, 48\)/)
      expect(branch).toMatch(/msg\.drop\.slice\(0, 48\)/)
    }
    expect(relay).toMatch(/this\.broadcast\(out, att\.id\)/)
    expect(server).toMatch(/broadcast\(room, out, playerId\)/)
  })
  it('adds welcome.first the documented way on both servers', () => {
    expect(relay).toMatch(/first: this\.ctx\.getWebSockets\(\)\.length === 1/)
    expect(relay).not.toMatch(/first: stored == null/)
    expect(server).toMatch(/const first = room\.players\.size === 0/)
    expect(server.indexOf('const first = room.players.size === 0')).toBeLessThan(server.indexOf('room.players.set(playerId'))
  })
  it('replays the kept frames after welcome, server-stamped, behind the opt-in', () => {
    expect(relay).toMatch(/env\.EV_LOG !== '0'/)
    expect(relay).toMatch(/\{ \.\.\.f, replay: true \}/)
    expect(server).toMatch(/\{ \.\.\.f, replay: true \}/)
    expect(server).toMatch(/--evlog/)
  })
})
