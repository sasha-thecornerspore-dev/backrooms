import { describe, it, expect } from 'vitest'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  PHRASES, MAX_PER_OWNER, NAME_CAP_EXEMPT, NOTE_NONE, menuFor, cacheKey, parseCacheKey, octOf, arrowFor,
  isCachePayload, isTakePayload, extraFor, createCacheLedger,
} from '../src/renderer/caches.js'
import { EXIT_DIRS } from '../src/renderer/compass.js'

// game.js's ITEM_NAMES shape: an object keyed by type
const ITEM_NAMES = { 'almond-water': 'almond water', glowstick: 'glowstick', bandage: 'bandage', polaroid: 'polaroid', radio: 'radio' }
const TYPES = new Set(Object.keys(ITEM_NAMES))

describe('caches: the words', () => {
  it('PHRASES: 12, frozen, lowercase, no exclamation marks, each ends in a full stop', () => {
    expect(PHRASES).toHaveLength(12)
    expect(Object.isFrozen(PHRASES)).toBe(true)
    for (const p of PHRASES) {
      expect(p).toBe(p.toLowerCase())
      expect(p).not.toContain('!')
      expect(p.endsWith('.')).toBe(true)
    }
    expect(MAX_PER_OWNER).toBe(6)
    expect(NAME_CAP_EXEMPT).toEqual(['wanderer'])
    expect(NOTE_NONE).toBeNull()
  })

  it('menuFor: six distinct indices in 0..11, deterministic, and floor / thing both matter', () => {
    for (const [lvl, type] of [[0, 'radio'], [1, 'radio'], [2, 'bandage'], [3, 'almond-water'], [4, 'glowstick']]) {
      const m = menuFor(lvl, type)
      expect(m).toHaveLength(6)
      expect(new Set(m).size).toBe(6)
      for (const i of m) { expect(Number.isInteger(i)).toBe(true); expect(i).toBeGreaterThanOrEqual(0); expect(i).toBeLessThan(12) }
      expect(menuFor(lvl, type)).toEqual(m)
      expect(menuFor(lvl, type)).not.toBe(m)      // a fresh array each call
    }
    const a = menuFor(1, 'radio')
    const differs = [menuFor(2, 'radio'), menuFor(1, 'bandage'), menuFor(3, 'polaroid')].some(m => m.join() !== a.join())
    expect(differs).toBe(true)
  })
})

describe('caches: keys and arrows', () => {
  it('cacheKey / parseCacheKey', () => {
    expect(cacheKey(2, -3, 14)).toBe('c:2:-3,14')
    expect(parseCacheKey('c:2:-3,14')).toEqual({ lvl: 2, cx: -3, cy: 14 })
    expect(parseCacheKey(cacheKey(0, 0, 0))).toEqual({ lvl: 0, cx: 0, cy: 0 })
    expect(parseCacheKey(cacheKey(4, 99999, -99999))).toEqual({ lvl: 4, cx: 99999, cy: -99999 })
    for (const bad of ['cache:2:1,1', 'c:5:1,1', 'c:2:1.5,1', '', 'c:2:1,1 ', 'c:-1:1,1']) expect(parseCacheKey(bad)).toBeNull()
    for (const bad of [null, undefined, 7, {}, ['c:1:0,0']]) expect(parseCacheKey(bad)).toBeNull()
    // the servers slice keep/drop keys at 48
    expect(cacheKey(4, -2147483648, -2147483648).length).toBeLessThanOrEqual(48)
  })

  it('octOf rounds to eighths like the compass and folds any winding', () => {
    expect(octOf(0)).toBe(0)
    expect(octOf(Math.PI / 2)).toBe(2)
    expect(octOf(-Math.PI / 4)).toBe(7)
    expect(octOf(2 * Math.PI)).toBe(0)
    expect(octOf(Math.PI)).toBe(4)
    expect(octOf(-6 * Math.PI + Math.PI / 4)).toBe(1)
  })

  it('arrowFor: the dropper\'s facing seen from the reader\'s heading', () => {
    expect(arrowFor(0, 0)).toBe('↑')
    expect(arrowFor(0, Math.PI / 2)).toBe('←')
    expect(arrowFor(2, 0)).toBe('→')
    for (let oct = 0; oct < 8; oct++) {
      for (const a of [0, 0.3, Math.PI / 2, -1.1, 3]) {
        expect(arrowFor(oct, a)).toBe(arrowFor(oct, a + 2 * Math.PI))
        expect(EXIT_DIRS).toContain(arrowFor(oct, a))
      }
    }
    expect(arrowFor(-1, 0)).toBe('')
    expect(arrowFor(8, 0)).toBe('')
    expect(arrowFor(1.5, 0)).toBe('')
    expect(arrowFor(undefined, 0)).toBe('')
  })
})

describe('caches: the wire checks', () => {
  const ok = () => ({ lvl: 1, cx: 3, cy: 4, x: 3.5, y: 4.5, type: 'radio', ph: 2, oct: 0, n: 7 })

  it('isCachePayload accepts a good frame against an ITEM_NAMES object and a Set', () => {
    expect(isCachePayload(ok(), ITEM_NAMES)).toBe(true)
    expect(isCachePayload(ok(), TYPES)).toBe(true)
  })

  it('isCachePayload rejects the bad ones', () => {
    const bad = [
      { ph: 12 }, { ph: -2 }, { oct: 8 }, { type: 'knife' }, { lvl: 5 }, { lvl: '1' }, { cx: 1.5 }, { x: NaN },
      { ex: { on: true } }, { ex: { sour: false } }, { ex: 'sour' }, { ex: null }, { y: Infinity }, { type: 7 },
      { type: 'toString' }, { oct: -2 }, { cy: '4' },
    ]
    for (const b of bad) {
      expect(isCachePayload({ ...ok(), ...b }, ITEM_NAMES)).toBe(false)
      expect(isCachePayload({ ...ok(), ...b }, TYPES)).toBe(false)
    }
    expect(isCachePayload(null, ITEM_NAMES)).toBe(false)
    expect(isCachePayload('x', ITEM_NAMES)).toBe(false)
  })

  it('isCachePayload accepts ex absent, {}, { sour, tool }, and ph -1 with oct 3', () => {
    expect(isCachePayload({ ...ok(), ex: {} }, ITEM_NAMES)).toBe(true)
    expect(isCachePayload({ ...ok(), ex: { sour: true, tool: true } }, ITEM_NAMES)).toBe(true)
    expect(isCachePayload({ ...ok(), ex: { sour: true } }, TYPES)).toBe(true)
    expect(isCachePayload({ ...ok(), ph: -1, oct: 3 }, ITEM_NAMES)).toBe(true)
    expect(isCachePayload({ ...ok(), ph: 5, oct: -1 }, ITEM_NAMES)).toBe(true)
  })

  it('isTakePayload', () => {
    expect(isTakePayload({ key: 'c:1:0,0' })).toBe(true)
    expect(isTakePayload({ key: 'c:1:0,0', n: 3 })).toBe(true)
    expect(isTakePayload({ key: 'x' })).toBe(false)
    expect(isTakePayload({})).toBe(false)
    expect(isTakePayload({ key: 1 })).toBe(false)
    expect(isTakePayload(null)).toBe(false)
  })

  it('extraFor builds dropAt\'s extra from the frame, never with on or clocks', () => {
    expect(extraFor({ ex: { sour: true }, ph: 3, oct: 5 }, 'id9', 'maddie', 'c:1:0,0'))
      .toEqual({ sour: true, ph: 3, oct: 5, by: 'maddie', byId: 'id9', cacheKey: 'c:1:0,0' })
    expect(extraFor({ ph: 0, oct: 0, on: true, onUntil: 9, t0: 2 }, 'a', 'b', 'c:0:0,0'))
      .toEqual({ ph: 0, oct: 0, by: 'b', byId: 'a', cacheKey: 'c:0:0,0' })
    expect(extraFor({ ex: { tool: true }, ph: -1, oct: 2 }, 'a', 'b', 'k').tool).toBe(true)
    expect(extraFor({ ph: 1, oct: 1 }, 'a', 'x'.repeat(30), 'k').by).toBe('x'.repeat(24))
    expect(extraFor({ ph: 1, oct: 1 }, 'a', undefined, 'k').by).toBe('wanderer')
    const p = { ph: 1, oct: 1 }
    expect(extraFor(p, 'a', 'b', 'k')).not.toBe(extraFor(p, 'a', 'b', 'k'))
  })
})

describe('ledger: the index and the caps', () => {
  const at = (cx, extra = {}) => ({ key: cacheKey(1, cx, 0), lvl: 1, cx, cy: 0, id: 'a', name: 'maddie', t: cx, ...extra })

  it('place -> get / forLevel; take removes and returns it; take(unknown) -> null', () => {
    const L = createCacheLedger()
    const r = L.place(at(1))
    expect(r).toEqual({ replaced: null, evicted: [] })
    expect(L.get('c:1:1,0')).toMatchObject({ key: 'c:1:1,0', lvl: 1, cx: 1, cy: 0, id: 'a', name: 'maddie', t: 1, localKey: null, pending: null })
    expect(L.forLevel(1).map(e => e.key)).toEqual(['c:1:1,0'])
    expect(L.forLevel(2)).toEqual([])
    expect(L.size).toBe(1)
    const e = L.take('c:1:1,0')
    expect(e.key).toBe('c:1:1,0')
    expect(L.get('c:1:1,0')).toBeNull()
    expect(L.size).toBe(0)
    expect(L.take('c:1:1,0')).toBeNull()
    expect(L.take('c:9:9,9')).toBeNull()
  })

  it('one live cache per level+cell: a second place returns the first as replaced', () => {
    const L = createCacheLedger()
    L.place(at(1))
    const first = L.get('c:1:1,0')
    const r = L.place(at(1, { id: 'b', name: 'moss', t: 9 }))
    expect(r.replaced).toBe(first)
    expect(r.evicted).toEqual([])
    expect(L.size).toBe(1)
    expect(L.get('c:1:1,0').id).toBe('b')
  })

  it('a 7th from one id evicts that id\'s oldest', () => {
    const L = createCacheLedger()
    for (let i = 0; i < 6; i++) expect(L.place(at(i, { name: 'wanderer' })).evicted).toEqual([])
    const r = L.place(at(6, { name: 'wanderer' }))
    expect(r.evicted.map(e => e.key)).toEqual(['c:1:0,0'])
    expect(L.size).toBe(6)
  })

  it('oldest by t, ties broken by insertion', () => {
    const L = createCacheLedger()
    for (let i = 0; i < 6; i++) L.place(at(i, { t: i === 3 ? -5 : 1 }))
    expect(L.place(at(6)).evicted.map(e => e.key)).toEqual(['c:1:3,0'])
    expect(L.place(at(7)).evicted.map(e => e.key)).toEqual(['c:1:0,0'])
  })

  it('7 from one NAME across two ids evicts that name\'s oldest', () => {
    const L = createCacheLedger()
    for (let i = 0; i < 4; i++) L.place(at(i, { id: 'old' }))
    for (let i = 4; i < 6; i++) L.place(at(i, { id: 'new' }))
    const r = L.place(at(6, { id: 'new' }))
    expect(r.evicted.map(e => e.key)).toEqual(['c:1:0,0'])
    expect(L.size).toBe(6)
  })

  it('wanderer is capped per id only', () => {
    const L = createCacheLedger()
    for (let i = 0; i < 6; i++) expect(L.place(at(i, { id: 'a', name: 'wanderer' })).evicted).toEqual([])
    expect(L.place(at(6, { id: 'b', name: 'wanderer' })).evicted).toEqual([])
    expect(L.size).toBe(7)
    const r = L.place(at(7, { id: 'a', name: 'wanderer' }))
    expect(r.evicted.map(e => e.key)).toEqual(['c:1:0,0'])
    expect(L.size).toBe(7)
  })

  it('entries with id null count toward the name cap only', () => {
    const L = createCacheLedger()
    for (let i = 0; i < 6; i++) L.place(at(i, { id: null }))
    expect(L.place(at(6, { id: null })).evicted.map(e => e.key)).toEqual(['c:1:0,0'])
    const W = createCacheLedger()
    for (let i = 0; i < 8; i++) expect(W.place(at(i, { id: null, name: 'wanderer' })).evicted).toEqual([])
    expect(W.size).toBe(8)
  })

  it('maxPerOwner is configurable', () => {
    const L = createCacheLedger({ maxPerOwner: 2 })
    L.place(at(0)); L.place(at(1))
    expect(L.place(at(2)).evicted).toHaveLength(1)
    expect(L.size).toBe(2)
  })
})

describe('ledger: pending, rebind, local keys', () => {
  const pend = (lvl, cx, t) => ({ key: cacheKey(lvl, cx, 0), lvl, cx, cy: 0, id: 'p' + cx, name: 'n' + cx, t, pending: { x: cx + 0.5, y: 0.5, type: 'bandage', extra: { ph: 1, oct: 2 } } })

  it('pendingFor lists only that level\'s pending entries, oldest first; clearPending nulls them', () => {
    const L = createCacheLedger()
    L.place(pend(2, 1, 5))
    L.place(pend(2, 2, 1))
    L.place(pend(3, 3, 0))
    L.place({ key: 'c:2:9,0', lvl: 2, cx: 9, cy: 0, id: 'z', name: 'z', t: 0 })
    expect(L.pendingFor(2).map(e => e.key)).toEqual(['c:2:2,0', 'c:2:1,0'])
    expect(L.pendingFor(3).map(e => e.key)).toEqual(['c:3:3,0'])
    L.clearPending(2)
    expect(L.pendingFor(2)).toEqual([])
    expect(L.get('c:2:1,0').pending).toBeNull()
    expect(L.pendingFor(3)).toHaveLength(1)
  })

  it('localKey / bind round-trip', () => {
    const L = createCacheLedger()
    L.place({ key: 'c:1:0,0', lvl: 1, cx: 0, cy: 0, id: 'a', name: 'b', t: 0 })
    expect(L.localKey('c:1:0,0')).toBeNull()
    L.bind('c:1:0,0', 'd:7')
    expect(L.localKey('c:1:0,0')).toBe('d:7')
    expect(L.localKey('c:1:9,9')).toBeNull()
    L.bind('c:1:9,9', 'd:8')                  // unknown: nothing happens
    expect(L.size).toBe(1)
  })

  it('rebind binds, nulls stale keys on that level, adopts without caps and ignores the rest', () => {
    const L = createCacheLedger()
    L.place({ key: 'c:1:0,0', lvl: 1, cx: 0, cy: 0, id: 'a', name: 'b', t: 0 })
    L.place({ key: 'c:1:5,5', lvl: 1, cx: 5, cy: 5, id: 'a', name: 'b', t: 1 })
    L.place({ key: 'c:2:0,0', lvl: 2, cx: 0, cy: 0, id: 'a', name: 'b', t: 2 })
    L.bind('c:1:5,5', 'd:old')
    L.bind('c:2:0,0', 'd:other')
    const recs = [
      { key: 'd:3', x: 0.5, y: 0.5, type: 'bandage', cacheKey: 'c:1:0,0' },
      { key: 'd:4', x: 1, y: 1, type: 'radio' },                                  // a plain drop
      { key: 'd:5', x: 1, y: 1, type: 'radio', cacheKey: 'c:2:7,7' },             // another floor's key
      { key: '3,3', x: 1, y: 1, type: 'radio', cacheKey: 'c:1:3,3' },             // a chunk spawn, not a drop
      { key: 'd:6', x: 1, y: 1, type: 'radio', cacheKey: 'bad' },
    ]
    for (let i = 0; i < 7; i++) recs.push({ key: 'd:1' + i, x: i, y: 9, type: 'bandage', cacheKey: cacheKey(1, i, 9), by: 'maddie', byId: 'm1' })
    L.rebind(1, recs)
    expect(L.localKey('c:1:0,0')).toBe('d:3')
    expect(L.localKey('c:1:5,5')).toBeNull()        // stale on this level
    expect(L.localKey('c:2:0,0')).toBe('d:other')   // another level untouched
    expect(L.get('c:2:7,7')).toBeNull()
    expect(L.get('c:1:3,3')).toBeNull()
    for (let i = 0; i < 7; i++) {
      expect(L.get(cacheKey(1, i, 9))).toMatchObject({ lvl: 1, cx: i, cy: 9, id: 'm1', name: 'maddie', t: 0, pending: null, localKey: 'd:1' + i })
    }
    expect(L.forLevel(1)).toHaveLength(9)
    const anon = createCacheLedger()
    anon.rebind(1, [{ key: 'd:0', cacheKey: 'c:1:0,0' }])
    expect(anon.get('c:1:0,0')).toMatchObject({ id: null, name: null })
  })
})

describe('ledger: snapshot / restore', () => {
  it('round-trips entries and pending; localKey is not saved', () => {
    const L = createCacheLedger()
    L.place({ key: 'c:1:0,0', lvl: 1, cx: 0, cy: 0, id: 'a', name: 'b', t: 3 })
    L.bind('c:1:0,0', 'd:1')
    L.place({ key: 'c:2:1,-1', lvl: 2, cx: 1, cy: -1, id: 'q', name: 'moss', t: 4, pending: { x: 1.5, y: -0.5, type: 'radio', extra: { ph: 2, oct: 3, by: 'moss', byId: 'q', cacheKey: 'c:2:1,-1' } } })
    const s = L.snapshot()
    expect(s.v).toBe(1)
    expect(s.entries).toEqual([{ key: 'c:1:0,0', lvl: 1, cx: 0, cy: 0, id: 'a', name: 'b', t: 3 }])
    expect(s.pending).toEqual([{ key: 'c:2:1,-1', lvl: 2, cx: 1, cy: -1, id: 'q', name: 'moss', t: 4, x: 1.5, y: -0.5, type: 'radio', extra: { ph: 2, oct: 3, by: 'moss', byId: 'q', cacheKey: 'c:2:1,-1' } }])
    const R = createCacheLedger()
    R.restore(JSON.parse(JSON.stringify(s)))
    expect(R.size).toBe(2)
    expect(R.localKey('c:1:0,0')).toBeNull()
    expect(R.get('c:1:0,0')).toMatchObject({ id: 'a', name: 'b', t: 3, pending: null })
    expect(R.pendingFor(2)[0].pending).toEqual({ x: 1.5, y: -0.5, type: 'radio', extra: { ph: 2, oct: 3, by: 'moss', byId: 'q', cacheKey: 'c:2:1,-1' } })
    expect(R.snapshot()).toEqual(s)
  })

  it('restore tolerates garbage and keeps only valid rows', () => {
    const L = createCacheLedger()
    for (const s of [undefined, null, 7, 'x', { entries: 'x' }, { v: 1 }, { pending: [{ key: 'c:1:0,0' }] }]) {
      L.place({ key: 'c:3:3,3', lvl: 3, cx: 3, cy: 3, id: 'z', name: 'z', t: 0 })
      expect(() => L.restore(s)).not.toThrow()
      expect(L.size).toBe(0)                      // restore clears first
    }
    L.restore({ v: 1, entries: [{ key: 'bad' }, null, { key: 'c:1:0,0', lvl: 1, cx: 0, cy: 0, id: 'a', name: 'b', t: 1 }, { key: 'c:1:2,2', lvl: 1, cx: 3, cy: 2 }, { key: 'c:1:4,4', lvl: 1, cx: 4, cy: 4, id: 9 }] })
    expect(L.size).toBe(1)
    expect(L.get('c:1:0,0')).toMatchObject({ id: 'a', name: 'b', t: 1 })
  })

  it('a save without caches -> an empty ledger', () => {
    const save = { v: 1, level: 1, playT: 3 }
    const L = createCacheLedger()
    expect(() => L.restore(save.caches)).not.toThrow()
    expect(L.size).toBe(0)
  })
})

// W1's bus (src/net/evbus.js) arrives on feat/richness with the first integration
// step; until then these cases skip. The registrations are spec 3f's, verbatim.
const EVBUS = new URL('../src/net/evbus.js', import.meta.url)
const HAS_BUS = existsSync(fileURLToPath(EVBUS))

describe('caches over W1\'s bus', () => {
  async function mkBus() {
    const { createEvBus } = await import(/* @vite-ignore */ EVBUS.href)
    let t = 0
    const pos = new Map([['friend', { x: 3.5, y: 4.5 }]])
    const bus = createEvBus({
      send() {}, now: () => t, self: () => ({ x: 0, y: 0, lvl: 1 }),
      peerPos: (id) => pos.get(id) ?? null, peerIds: () => new Set(pos.keys()), selfId: 'me',
    })
    bus.register('cache', { check: (p) => isCachePayload(p, ITEM_NAMES), replayable: true, posKeys: ['x', 'y'], minGapMs: 3000 })
    bus.register('take', { check: isTakePayload, replayable: true, minGapMs: 500 })
    let n = 0
    const cache = (over = {}, id = 'friend', replay = false) => ({ kind: 'cache', id, name: 'maddie', replay, payload: { lvl: 1, cx: 3, cy: 4, x: 3.5, y: 4.5, type: 'radio', ph: 2, oct: 0, n: n++, ...over } })
    const take = (id = 'friend') => ({ kind: 'take', id, name: 'maddie', payload: { key: 'c:1:3,4', n: n++ } })
    return { bus, cache, take, at: (v) => { t = v } }
  }

  it.skipIf(!HAS_BUS)('the check, the live position gate and replay', async () => {
    const { bus, cache } = await mkBus()
    expect(bus.receive(cache({ ph: 12 }))).toBe(false)
    expect(bus.receive(cache({ type: 'knife' }))).toBe(false)
    expect(bus.receive(cache({ x: 6.5, y: 4.5 }))).toBe(false)              // 3 cells from where the list puts them
    expect(bus.receive(cache({}, 'ghost', true))).toBe(true)                // replay: no peerPos needed
    expect(bus.receive(cache({}, 'ghost', false))).toBe(false)              // live: no position, no belief
  })

  it.skipIf(!HAS_BUS)('minGap 3000 on cache, 500 on take; replay is not gated; a nonce counts once', async () => {
    const { bus, cache, take, at } = await mkBus()
    at(0)
    expect(bus.receive(cache())).toBe(true)
    at(1000)
    expect(bus.receive(cache())).toBe(false)
    expect(bus.receive(cache({}, 'friend', true))).toBe(true)
    at(5000)
    expect(bus.receive(take())).toBe(true)
    at(5300)
    expect(bus.receive(take())).toBe(false)
    at(5600)
    expect(bus.receive(take())).toBe(true)
    const f = cache({}, 'friend', true)
    expect(bus.receive(f)).toBe(true)
    expect(bus.receive(f)).toBe(false)
  })
})
