// test/evbus.test.js — the client-side bus every lens rides: allowlist, check,
// nonce LRU, live gates (minGap / maxDist / posKeys), the server-stamped replay
// path, the 3 s 'here' heartbeat and the floor filter it makes possible.
import { describe, it, expect } from 'vitest'
import { createEvBus, floorChangeLine, depthOf, HERE_INTERVAL_MS, STALE_MS, POS_SLACK, NONCE_LRU } from '../src/net/evbus.js'

function rig(opts = {}) {
  const sent = []
  const merged = []
  let t = 0
  const peers = new Map(opts.peers || [])          // id → {x,y}
  const selfState = { x: 5, y: 5, lvl: 1 }
  const bus = createEvBus({
    send: (kind, payload, o) => sent.push({ kind, payload, opts: o }),
    now: () => t,
    self: () => selfState,
    peerPos: (id) => peers.get(id) || null,
    peerIds: () => new Set(peers.keys()),
    selfId: 'me',
    mergeRemote: (id, f) => merged.push({ id, f }),
    ...opts.deps,
  })
  return { bus, sent, merged, peers, selfState, at: (v) => { t = v }, advance: (dt) => { t += dt } }
}

const HERE = { lvl: 1, lit: true, st: 'ok', seen: false, o: 'tenant', thin: false, status: 'extension', aseed: null, v: 1 }
let nonce = 1000
const frame = (id, kind, payload, extra = {}) => ({ type: 'ev', id, name: id, kind, payload: { ...payload, n: nonce++ }, t: 0, ...extra })
const hereFrom = (id, over = {}, extra = {}) => frame(id, 'here', { ...HERE, ...over }, extra)

describe('receive — allowlist, check, nonce', () => {
  it('drops an unregistered kind even with a handler attached', () => {
    const { bus } = rig()
    const got = []
    bus.on('zzz', m => got.push(m))
    expect(bus.receive(frame('b', 'zzz', { a: 1 }))).toBe(false)
    expect(got).toEqual([])
  })

  it('drops a payload whose check() says no', () => {
    const { bus, peers } = rig()
    peers.set('b', { x: 5, y: 5 })
    bus.register('kneel', { check: p => typeof p.to === 'string' })
    const got = []
    bus.on('kneel', m => got.push(m))
    expect(bus.receive(frame('b', 'kneel', { to: 42 }))).toBe(false)
    expect(bus.receive(frame('b', 'kneel', { to: 'me' }))).toBe(true)
    expect(got.length).toBe(1)
    expect(got[0]).toMatchObject({ id: 'b', name: 'b', payload: { to: 'me' }, replay: false })
    expect(typeof got[0].t).toBe('number')
  })

  it('drops its own frames and frames without an id', () => {
    const { bus } = rig()
    bus.register('kneel', { check: () => true })
    expect(bus.receive(frame('me', 'kneel', {}))).toBe(false)
    expect(bus.receive({ type: 'ev', kind: 'kneel', payload: { n: 1 } })).toBe(false)
    expect(bus.receive(null)).toBe(false)
  })

  it('drops a duplicate nonce per id, not across ids', () => {
    const { bus } = rig()
    bus.register('woke', { check: () => true })
    const got = []
    bus.on('woke', m => got.push(m.id))
    const f = frame('b', 'woke', { by: 'x' })
    expect(bus.receive(f)).toBe(true)
    expect(bus.receive({ ...f })).toBe(false)
    expect(bus.receive({ ...f, id: 'c', name: 'c' })).toBe(true)
    expect(got).toEqual(['b', 'c'])
  })

  it('the nonce window is an LRU of 256 per id', () => {
    const { bus } = rig()
    bus.register('woke', { check: () => true })
    expect(NONCE_LRU).toBe(256)
    const first = { type: 'ev', id: 'b', name: 'b', kind: 'woke', payload: { n: 1 }, t: 0 }
    bus.receive(first)
    for (let i = 2; i <= 257; i++) bus.receive({ ...first, payload: { n: i } })
    expect(bus.receive({ ...first, payload: { n: 257 } })).toBe(false)   // still remembered
    expect(bus.receive(first)).toBe(true)                                  // n=1 aged out
  })
})

describe('receive — live gates', () => {
  it('per-(id,kind) minGap', () => {
    const { bus, peers, at } = rig()
    peers.set('b', { x: 5, y: 5 }); peers.set('c', { x: 5, y: 5 })
    bus.register('whistle', { check: () => true, minGapMs: 500 })
    bus.register('kneel', { check: () => true, minGapMs: 500 })
    at(1000)
    expect(bus.receive(frame('b', 'whistle', {}))).toBe(true)
    at(1100)
    expect(bus.receive(frame('b', 'whistle', {}))).toBe(false)   // same id, same kind, too soon
    expect(bus.receive(frame('b', 'kneel', {}))).toBe(true)      // same id, other kind
    expect(bus.receive(frame('c', 'whistle', {}))).toBe(true)    // other id
    at(1500)
    expect(bus.receive(frame('b', 'whistle', {}))).toBe(true)
  })

  it('maxDist against peerPos; a peer the list does not know is dropped', () => {
    const { bus, peers, selfState } = rig()
    bus.register('ward', { check: () => true, maxDist: 10 })
    selfState.x = 0; selfState.y = 0
    peers.set('b', { x: 6, y: 8 })        // exactly 10
    expect(bus.receive(frame('b', 'ward', {}))).toBe(true)
    peers.set('b', { x: 6, y: 8.1 })
    expect(bus.receive(frame('b', 'ward', {}))).toBe(false)
    expect(bus.receive(frame('ghost', 'ward', {}))).toBe(false)
  })

  it('posKeys: 3 cells off the list position dropped, 1.5 delivered, peerPos null dropped', () => {
    const { bus, peers } = rig()
    expect(POS_SLACK).toBe(2.0)
    bus.register('ward', { check: () => true, posKeys: ['x', 'y'] })
    peers.set('b', { x: 10, y: 10 })
    expect(bus.receive(frame('b', 'ward', { x: 13, y: 10 }))).toBe(false)
    expect(bus.receive(frame('b', 'ward', { x: 11.5, y: 10 }))).toBe(true)
    expect(bus.receive(frame('b', 'ward', { x: 'a', y: 10 }))).toBe(false)
    expect(bus.receive(frame('nobody', 'ward', { x: 10, y: 10 }))).toBe(false)
  })
})

describe('receive — replay path', () => {
  it('replay of a replayable kind from an unknown id is delivered; the same frame live is dropped', () => {
    const { bus } = rig()
    bus.register('cache', { check: p => Number.isInteger(p.cx), maxDist: 20, posKeys: ['x', 'y'], replayable: true })
    const got = []
    bus.on('cache', m => got.push(m))
    const f = frame('unknown', 'cache', { cx: 3, x: 1, y: 1 })
    expect(bus.receive({ ...f, replay: true })).toBe(true)
    expect(got[0].replay).toBe(true)
    expect(bus.receive(f)).toBe(false)                    // nonce already seen
    const g = frame('unknown', 'cache', { cx: 4, x: 1, y: 1 })
    expect(bus.receive(g)).toBe(false)                    // live: peerPos null → dropped
  })

  it('replay keeps check() and the nonce, skips minGap', () => {
    const { bus } = rig()
    bus.register('cache', { check: p => Number.isInteger(p.cx), minGapMs: 5000, replayable: true })
    expect(bus.receive(frame('z', 'cache', { cx: 'bad' }, { replay: true }))).toBe(false)
    const a = frame('z', 'cache', { cx: 1 }, { replay: true })
    expect(bus.receive(a)).toBe(true)
    expect(bus.receive(frame('z', 'cache', { cx: 2 }, { replay: true }))).toBe(true)  // 64 replays arrive at once
    expect(bus.receive({ ...a })).toBe(false)
  })

  it('replay of a non-replayable kind is dropped; only the literal true counts', () => {
    const { bus, peers } = rig()
    peers.set('b', { x: 5, y: 5 })
    bus.register('whistle', { check: () => true })
    expect(bus.receive(frame('b', 'whistle', {}, { replay: true }))).toBe(false)
    bus.register('cache', { check: () => true, replayable: true, maxDist: 1 })
    expect(bus.receive(frame('far', 'cache', {}, { replay: 1 }))).toBe(false)  // not server-stamped → live gates
  })
})

describe('emit', () => {
  it('checks, spaces, stamps a 16-bit nonce and sends', () => {
    const { bus, sent, at } = rig()
    bus.register('whistle', { check: p => typeof p.c === 'number', minGapMs: 300 })
    at(0)
    expect(bus.emit('whistle', { c: 'x' })).toBe(false)
    expect(bus.emit('whistle', { c: 1 })).toBe(true)
    at(100)
    expect(bus.emit('whistle', { c: 2 })).toBe(false)     // outgoing minGap
    at(300)
    expect(bus.emit('whistle', { c: 3 }, { keep: 'k' })).toBe(true)
    expect(sent.length).toBe(2)
    expect(sent[0].kind).toBe('whistle')
    expect(sent[0].payload).toEqual({ c: 1, n: 0 })
    expect(sent[1].payload).toEqual({ c: 3, n: 1 })
    expect(sent[1].opts).toEqual({ keep: 'k' })
    expect(bus.emit('nope', {})).toBe(false)
  })

  it('wraps the nonce at 0xffff', () => {
    const { bus, sent } = rig()
    bus.register('woke', { check: () => true })
    for (let i = 0; i < 0x10001; i++) bus.emit('woke', {})
    expect(sent[0xffff].payload.n).toBe(0xffff)
    expect(sent[0x10000].payload.n).toBe(0)
  })
})

describe('here — the heartbeat out', () => {
  const fields = { lvl: 2, lit: true, st: 'ok', seen: false, o: 'tenant', thin: false, status: 'extension', aseed: null }
  it('sends on first call with the documented shape and v:1, then only on change', () => {
    const { bus, sent, at } = rig()
    at(0)
    bus.here(fields)
    expect(sent.length).toBe(1)
    expect(sent[0].kind).toBe('here')
    expect(Object.keys(sent[0].payload)).toEqual(['lvl', 'lit', 'st', 'seen', 'o', 'thin', 'status', 'aseed', 'v', 'n'])
    expect(sent[0].payload.v).toBe(1)
    at(1000); bus.here({ ...fields })
    expect(sent.length).toBe(1)
    at(1500); bus.here({ ...fields, lit: false })
    expect(sent.length).toBe(2)
    expect(sent[1].payload.lit).toBe(false)
  })

  it('re-sends every 3 s from tick even when nothing changed', () => {
    const { bus, sent, at } = rig()
    expect(HERE_INTERVAL_MS).toBe(3000)
    at(0); bus.here(fields)
    at(2999); bus.tick(2999); expect(sent.length).toBe(1)
    at(3000); bus.tick(3000); expect(sent.length).toBe(2)
    at(4000); bus.here(fields); expect(sent.length).toBe(2)
    at(6000); bus.here(fields); expect(sent.length).toBe(3)
  })

  it('normalises junk into the schema the peers will check', () => {
    const { bus, sent, at } = rig()
    at(0)
    bus.here({ lvl: '3', lit: 1, st: 'flying', seen: null, o: 'king', thin: 'yes', status: 'approved', aseed: 12.5 })
    const p = sent[0].payload
    expect(p).toMatchObject({ lvl: 3, lit: true, st: 'ok', seen: false, o: null, thin: true, status: 'notice-mailed', aseed: null, v: 1 })
    at(1000); bus.here({ lvl: 9 })
    expect(sent[1].payload.lvl).toBe(4)
    at(2000); bus.here({ lvl: -2, aseed: 77, o: 'processed', st: 'down', status: 'litigation' })
    expect(sent[2].payload).toMatchObject({ lvl: 0, aseed: 77, o: 'processed', st: 'down', status: 'litigation' })
  })

  it('a change refused by the outgoing minGap is flushed by the next tick', () => {
    const { bus, sent, at } = rig()
    at(0); bus.here(fields)
    at(50); bus.here({ ...fields, st: 'down' })
    expect(sent.length).toBe(1)
    at(400); bus.tick(400)
    expect(sent.length).toBe(2)
    expect(sent[1].payload.st).toBe('down')
  })
})

describe('here — peers, the floor filter, staleness', () => {
  it('a fresh here on another floor → onFloor false; same floor → true; legacy ids → true', () => {
    const { bus, peers, selfState, merged } = rig()
    peers.set('b', { x: 1, y: 1 }); peers.set('old', { x: 2, y: 2 })
    selfState.lvl = 1
    expect(bus.receive(hereFrom('b', { lvl: 2 }))).toBe(true)
    expect(bus.onFloor('b')).toBe(false)
    expect(bus.fresh('b')).toBe(true)
    expect(bus.onFloor('old')).toBe(true)      // no here yet → legacy → today's behaviour
    expect(bus.fresh('old')).toBe(false)
    expect(bus.onFloor('nobody')).toBe(true)
    bus.receive(hereFrom('b', { lvl: 1 }))
    expect(bus.onFloor('b')).toBe(true)
    expect(merged[0]).toEqual({ id: 'b', f: { lvl: 2, lit: true, st: 'ok', seen: false, origin: 'tenant', thin: false, status: 'extension', aseed: null, legacy: false } })
  })

  it('rejects a malformed here', () => {
    const { bus, peers } = rig()
    peers.set('b', { x: 1, y: 1 })
    expect(bus.receive(hereFrom('b', { lvl: 5 }))).toBe(false)
    expect(bus.receive(hereFrom('b', { st: 'flying' }))).toBe(false)
    expect(bus.receive(hereFrom('b', { status: 'approved' }))).toBe(false)
    expect(bus.receive(hereFrom('b', { o: 'king' }))).toBe(false)
    expect(bus.receive(hereFrom('b', { v: 2 }))).toBe(false)
    expect(bus.receive(hereFrom('b', { aseed: 1.5 }))).toBe(false)
    expect(bus.receive(hereFrom('b', { lit: 'yes' }))).toBe(false)
    expect(bus.fresh('b')).toBe(false)
  })

  it('a here older than 8 s makes the peer legacy again: onFloor true, fresh false', () => {
    const { bus, peers, selfState, at } = rig()
    expect(STALE_MS).toBe(8000)
    peers.set('b', { x: 1, y: 1 })
    selfState.lvl = 1
    at(1000); bus.receive(hereFrom('b', { lvl: 3 }))
    expect(bus.onFloor('b')).toBe(false)
    at(9000); bus.tick(9000)
    expect(bus.onFloor('b')).toBe(false)
    at(9001); bus.tick(9001)
    expect(bus.onFloor('b')).toBe(true)
    expect(bus.fresh('b')).toBe(false)
    expect(bus.peers.get('b').lvl).toBe(3)       // the record stays; only its freshness changed
  })

  it('tick prunes ids absent from peerIds() and seats legacy records for new ones', () => {
    const { bus, peers } = rig()
    peers.set('b', { x: 1, y: 1 })
    bus.receive(hereFrom('b'))
    expect(bus.peers.has('b')).toBe(true)
    peers.delete('b'); peers.set('c', { x: 0, y: 0 })
    bus.tick(0)
    expect(bus.peers.has('b')).toBe(false)
    expect(bus.peers.get('c')).toMatchObject({ id: 'c', legacy: true })
    expect(bus.onFloor('c')).toBe(true)
  })

  it('freshPeersOnFloor reuses one array and lists only fresh peers on my floor', () => {
    const { bus, peers, selfState } = rig()
    peers.set('b', { x: 1, y: 1 }); peers.set('c', { x: 1, y: 1 }); peers.set('d', { x: 1, y: 1 })
    selfState.lvl = 2
    bus.receive(hereFrom('b', { lvl: 2 }))
    bus.receive(hereFrom('c', { lvl: 3 }))
    bus.tick(0)
    const a = bus.freshPeersOnFloor()
    expect(a.map(p => p.id)).toEqual(['b'])
    bus.receive(hereFrom('c', { lvl: 2 }))
    const a2 = bus.freshPeersOnFloor()
    expect(a2).toBe(a)
    expect(a2.map(p => p.id).sort()).toEqual(['b', 'c'])
  })
})

describe('floor changes', () => {
  it('maps indices to depth and depth differences to the three lines', () => {
    expect([0, 1, 2, 3, 4].map(depthOf)).toEqual([0, 1, 2, 3, 0])
    expect(floorChangeLine(1, 2)).toBe('no-clipped deeper.')
    expect(floorChangeLine(3, 1)).toBe('climbed back.')
    expect(floorChangeLine(4, 1)).toBe('fell in.')
    expect(floorChangeLine(4, 0)).toBe('fell in.')
    expect(floorChangeLine(2, 2)).toBe(null)
    expect(floorChangeLine(1, 4)).toBe('climbed back.')
  })

  it('onFloorChange fires with (id, name, from, to, line) only on a change, never on the first here', () => {
    const { bus, peers } = rig()
    peers.set('b', { x: 1, y: 1 })
    const got = []
    bus.onFloorChange((...a) => got.push(a))
    bus.receive(hereFrom('b', { lvl: 4 }))
    expect(got).toEqual([])
    bus.receive(hereFrom('b', { lvl: 4 }))
    expect(got).toEqual([])
    bus.receive(hereFrom('b', { lvl: 1 }))
    expect(got).toEqual([['b', 'b', 4, 1, 'fell in.']])
    bus.receive(hereFrom('b', { lvl: 3 }))
    expect(got[1]).toEqual(['b', 'b', 1, 3, 'no-clipped deeper.'])
  })
})

describe('roomStanding', () => {
  it('returns the same object, counts fresh on-floor statuses, and recomputes on messages, not frames', () => {
    const { bus, peers, selfState, at } = rig()
    peers.set('b', { x: 1, y: 1 }); peers.set('c', { x: 1, y: 1 }); peers.set('legacy', { x: 1, y: 1 })
    selfState.lvl = 1
    const changes = []
    bus.onRoomChange(s => changes.push({ ...s }))
    const s0 = bus.roomStanding()
    expect(s0).toEqual({ 'notice-mailed': 0, extension: 0, compliance: 0, litigation: 0, total: 0 })
    at(0)
    bus.receive(hereFrom('b', { status: 'extension' }))
    bus.receive(hereFrom('c', { status: 'litigation', lvl: 2 }))   // other floor: not counted
    const s1 = bus.roomStanding()
    expect(s1).toBe(s0)
    expect(s1).toEqual({ 'notice-mailed': 0, extension: 1, compliance: 0, litigation: 0, total: 1 })
    expect(changes.length).toBe(1)
    bus.receive(hereFrom('c', { status: 'litigation', lvl: 1 }))
    expect(bus.roomStanding()).toEqual({ 'notice-mailed': 0, extension: 1, compliance: 0, litigation: 1, total: 2 })
    expect(changes.length).toBe(2)
    for (let i = 0; i < 100; i++) bus.tick(10 + i)            // frames without news change nothing
    expect(changes.length).toBe(2)
    at(9000); bus.tick(9000)                                   // both stale → legacy → not counted
    expect(bus.roomStanding()).toEqual({ 'notice-mailed': 0, extension: 0, compliance: 0, litigation: 0, total: 0 })
    expect(changes.length).toBe(3)
    expect(bus.roomStanding()).toBe(s0)
  })

  it('follows my own floor', () => {
    const { bus, peers, selfState } = rig()
    peers.set('b', { x: 1, y: 1 })
    selfState.lvl = 1
    bus.receive(hereFrom('b', { lvl: 2, status: 'compliance' }))
    expect(bus.roomStanding().total).toBe(0)
    selfState.lvl = 2
    bus.tick(1)
    expect(bus.roomStanding()).toMatchObject({ compliance: 1, total: 1 })
  })
})

describe('deps', () => {
  it('selfId may be a function (the id is known only after welcome)', () => {
    let id = null
    const { bus } = rig({ deps: { selfId: () => id } })
    bus.register('woke', { check: () => true })
    const f = frame('me2', 'woke', {})
    id = 'me2'
    expect(bus.receive(f)).toBe(false)
  })
  it('works without mergeRemote and with a default clock', () => {
    const bus = createEvBus({ send: () => {}, self: () => ({ x: 0, y: 0, lvl: 0 }), peerPos: () => null, peerIds: () => new Set(), selfId: 'me' })
    expect(bus.receive(hereFrom('b'))).toBe(true)
    expect(bus.fresh('b')).toBe(true)
    bus.tick()
    expect(bus.peers.has('b')).toBe(false)    // absent from peerIds → pruned
  })
})
