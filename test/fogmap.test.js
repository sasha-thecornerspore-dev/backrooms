// fogmap.js — the pencil sheet: per-level chunk bitfields of walked cells, pins for what was seen, epochs that fade rather than erase,
// the stale/lost rule, the trail ring, and the cached base64 save shape.
import { describe, it, expect } from 'vitest'
import {
  CELL_BYTES, MAX_CHUNKS, revealRadius, createFogMap, buildMapView, packBits, unpackBits,
} from '../src/renderer/fogmap.js'
import { CHUNK_SIZE } from '../src/renderer/world.js'
import { WAY_KINDS } from '../src/renderer/topology.js'

const N = CHUNK_SIZE
const open = () => true
// two horizontal corridors at y = 5 and y = 7 with a wall row between: everything else solid
const twoHalls = (ix, iy) => iy === 5 || iy === 7
const at = (x, y, angle = 0) => ({ x, y, angle })
const way = (key, kind, x, y, target = 1, label = 'descend') => ({ key, kind, x, y, target, label })
const bitSet = (u8, lx, ly) => { const b = ly * N + lx; return (u8[b >> 3] >> (b & 7) & 1) === 1 }

describe('constants', () => {
  it('61 bytes hold a 22x22 chunk, 400 chunks per level, radius 3 on the shallow floors and 2 below', () => {
    expect(CELL_BYTES).toBe(61)
    expect(CELL_BYTES * 8).toBeGreaterThanOrEqual(N * N)
    expect(MAX_CHUNKS).toBe(400)
    expect(revealRadius(0)).toBe(3); expect(revealRadius(1)).toBe(3)
    expect(revealRadius(2)).toBe(2); expect(revealRadius(3)).toBe(2)
  })
})

describe('packBits / unpackBits', () => {
  it('round-trips any byte pattern and is node-safe (no btoa)', () => {
    const u8 = new Uint8Array(CELL_BYTES)
    for (let i = 0; i < u8.length; i++) u8[i] = (i * 37 + 11) & 0xFF
    const s = packBits(u8)
    expect(typeof s).toBe('string')
    expect(/^[A-Za-z0-9+/]*=*$/.test(s)).toBe(true)
    expect(Array.from(unpackBits(s))).toEqual(Array.from(u8))
    expect(Array.from(unpackBits(packBits(new Uint8Array(0)), 0))).toEqual([])
  })
  it('rejects the wrong length and bad characters', () => {
    expect(unpackBits(packBits(new Uint8Array(10)))).toBeNull()
    expect(unpackBits('not base64 at all!')).toBeNull()
    expect(unpackBits(42)).toBeNull()
  })
})

describe('step', () => {
  it('floods only open cells: a corridor between walls marks one wide, the parallel corridor two cells over stays blank', () => {
    const fog = createFogMap()
    const r = fog.step(0, 10.5, 5.5, 3, twoHalls)
    expect(r).toEqual({ marked: true, smudged: false })
    for (let x = 7; x <= 13; x++) expect(fog.has(0, x + 0.5, 5.5)).toBe(true)
    expect(fog.has(0, 6.5, 5.5)).toBe(false); expect(fog.has(0, 14.5, 5.5)).toBe(false)
    for (let x = 6; x <= 14; x++) {
      expect(fog.has(0, x + 0.5, 6.5)).toBe(false)        // the wall row
      expect(fog.has(0, x + 0.5, 7.5)).toBe(false)        // the hall you did not enter
      expect(fog.has(0, x + 0.5, 4.5)).toBe(false)
    }
  })

  it('in the open the flood is the full Chebyshev square and asks the grid at most 49 times', () => {
    const fog = createFogMap()
    let asks = 0
    fog.step(1, 50.5, 50.5, 3, (ix, iy) => { asks++; return true })
    expect(asks).toBeLessThanOrEqual(49)
    let n = 0
    for (let y = 45; y <= 55; y++) for (let x = 45; x <= 55; x++) if (fog.has(1, x + 0.5, y + 0.5)) n++
    expect(n).toBe(49)
    expect(fog.has(1, 46.5, 50.5)).toBe(false)
  })

  it('returns false on the same cell and the same reused result object on a new one', () => {
    const fog = createFogMap()
    const a = fog.step(0, 10.5, 5.5, 3, twoHalls)
    expect(fog.step(0, 10.7, 5.2, 3, twoHalls)).toBe(false)
    expect(fog.step(0, 10.1, 5.9, 3, twoHalls)).toBe(false)
    const b = fog.step(0, 11.5, 5.5, 3, twoHalls)
    expect(b).toBe(a)
    expect(fog.step(2, 11.5, 5.5, 3, twoHalls)).toBe(a)   // a new floor counts as a change
  })

  it('cells across a chunk border land in the right chunk arrays', () => {
    const fog = createFogMap()
    fog.step(0, N - 0.5, 5.5, 3, open)
    const ex = fog.export()[0]
    expect(Object.keys(ex.chunks).sort()).toEqual(['0,0', '1,0'])
    const c0 = unpackBits(ex.chunks['0,0']), c1 = unpackBits(ex.chunks['1,0'])
    expect(bitSet(c0, N - 1, 5)).toBe(true)
    expect(bitSet(c0, N - 4, 5)).toBe(true)
    expect(bitSet(c1, 0, 5)).toBe(true)
    expect(bitSet(c1, 2, 5)).toBe(true)
    expect(bitSet(c1, 3, 5)).toBe(false)
    expect(fog.has(0, N + 2.5, 5.5)).toBe(true)
    expect(fog.has(0, N + 3.5, 5.5)).toBe(false)
  })

  it('MAX_CHUNKS eviction drops the chunk farthest from the player', () => {
    const fog = createFogMap()
    for (let i = 0; i <= MAX_CHUNKS; i++) fog.step(0, i * N + 11.5, 11.5, 0, open)
    const ex = fog.export()[0]
    expect(Object.keys(ex.chunks)).toHaveLength(MAX_CHUNKS)
    expect(fog.has(0, 11.5, 11.5)).toBe(false)                   // chunk 0,0 went
    expect(fog.has(0, N + 11.5, 11.5)).toBe(true)                 // chunk 1,0 stayed
    expect(fog.has(0, MAX_CHUNKS * N + 11.5, 11.5)).toBe(true)
  })

  it('keeps the last eight distinct cell centres as a trail, newest first', () => {
    const fog = createFogMap()
    for (let i = 0; i < 10; i++) fog.step(0, i + 0.5, 0.5, 0, open)
    const t = fog.lastTrail(3)
    expect(t).toEqual([{ x: 9.5, y: 0.5 }, { x: 8.5, y: 0.5 }, { x: 7.5, y: 0.5 }])
    expect(fog.lastTrail(20)).toHaveLength(8)
    fog.step(0, 8.5, 0.5, 0, open)                                // back one: distinct, moved to the front
    expect(fog.lastTrail(2)).toEqual([{ x: 8.5, y: 0.5 }, { x: 9.5, y: 0.5 }])
    expect(fog.lastTrail(20)).toHaveLength(8)
  })
})

describe('export / import', () => {
  it('round-trips to an identical export, pins included', () => {
    const fog = createFogMap()
    fog.step(0, 10.5, 5.5, 3, twoHalls)
    fog.step(0, 30.5, 7.5, 3, twoHalls)
    fog.pinWay(0, way('1,0', 'down', 30.5, 7.5, 1, 'no-clip deeper'))
    fog.pinThing(0, 'm:1', 'machine', 12.5, 5.5, true)
    fog.step(1, 3.5, 3.5, 2, open)
    const a = fog.export()
    expect(a[0].pins).toEqual([['1,0', 'down', 30.5, 7.5, 1, 1, false], ['m:1', 'machine', 12.5, 5.5, true, 2, false]])
    const fog2 = createFogMap()
    expect(fog2.import(a)).toBe(true)
    expect(fog2.export()).toEqual(a)
    expect(fog2.has(0, 10.5, 5.5)).toBe(true)
    expect(fog2.has(1, 3.5, 3.5)).toBe(true)
    expect(fog2.ways(0)).toHaveLength(1)
    expect(fog2.ways(0)[0].label).toBe('no-clip deeper')          // the label comes back from the level's ways by kind
    expect(fog2.ways(0)[0].target).toBe(1)
    expect(fog2.pins(0).get('m:1').flag).toBe(true)
    expect(JSON.parse(JSON.stringify(a))).toEqual(a)              // plain JSON: it goes in the save
  })

  it('reuses the cached base64 while a chunk is untouched and refreshes it once marked', () => {
    const fog = createFogMap()
    fog.step(0, 5.5, 5.5, 3, open)
    const s1 = fog.export()[0].chunks['0,0']
    fog.step(0, 5.5, 5.5, 3, open)                                // no cell change: nothing marked
    fog.step(0, 5.5, 6.5, 1, open)                                // all cells already set: bits unchanged
    expect(fog.export()[0].chunks['0,0']).toBe(s1)
    fog.step(0, 15.5, 15.5, 1, open)
    const s2 = fog.export()[0].chunks['0,0']
    expect(s2).not.toBe(s1)
    expect(bitSet(unpackBits(s2), 15, 15)).toBe(true)
    expect(bitSet(unpackBits(s1), 15, 15)).toBe(false)
  })

  it('rejects wrong-length base64 chunks and malformed rows but keeps the rest', () => {
    const fog = createFogMap()
    const ok = packBits(new Uint8Array(CELL_BYTES).fill(1))
    const bad = packBits(new Uint8Array(12))
    const r = fog.import({ 0: { chunks: { '0,0': bad, '1,0': ok }, fresh: {}, epochs: {}, pins: [['x', 'down', 'nope', 1, null, 1, false], ['y', 'sight', 3.5, 3.5, null, 2, false]] }, junk: { chunks: {} } })
    expect(r).toBe(false)
    expect(fog.has(0, 0.5, 0.5)).toBe(false)
    expect(fog.has(0, N + 0.5, 0.5)).toBe(true)
    expect(fog.pins(0).has('x')).toBe(false)
    expect(fog.pins(0).has('y')).toBe(true)
    expect(fog.import(null)).toBe(false)
    expect(fog.import({})).toBe(true)
  })

  it('an export of an untouched map is empty', () => {
    expect(createFogMap().export()).toEqual({})
  })
})

describe('epochs', () => {
  it('a changed epoch keeps the old bits (faded) and writes the fresh flood into the fresh layer; smudged once per epoch', () => {
    const fog = createFogMap()
    let epoch = 0
    const epochOf = () => epoch
    fog.step(0, 5.5, 5.5, 1, open, epochOf)
    expect(fog.export()[0].fresh).toEqual({})
    epoch = 1
    const r = fog.step(0, 5.5, 9.5, 1, open, epochOf)
    expect(r.smudged).toBe(true)
    expect(fog.has(0, 5.5, 5.5)).toBe(true)                        // the old strokes stay
    expect(fog.has(0, 5.5, 9.5)).toBe(true)
    const ex = fog.export()[0]
    expect(ex.epochs['0,0']).toBe(1)
    const fresh = unpackBits(ex.fresh['0,0'])
    expect(bitSet(fresh, 5, 9)).toBe(true)
    expect(bitSet(fresh, 5, 5)).toBe(false)
    expect(fog.step(0, 5.5, 12.5, 1, open, epochOf).smudged).toBe(false)   // same epoch: no second smudge
    const view = buildMapView(fog, 0, at(5.5, 12.5), { cells: 56 })
    expect(view.faded.has('0,0')).toBe(true)
    // the fresh layer round-trips through a save
    const fog2 = createFogMap(); fog2.import(fog.export())
    expect(fog2.export()).toEqual(fog.export())
    expect(buildMapView(fog2, 0, at(5.5, 12.5), { cells: 56 }).faded.has('0,0')).toBe(true)
  })

  it('without an epoch function nothing ever fades', () => {
    const fog = createFogMap()
    fog.step(0, 5.5, 5.5, 1, open)
    expect(fog.step(0, 9.5, 9.5, 1, open).smudged).toBe(false)
    expect(fog.isStale(0, '0,0', () => 0)).toBe(false)
    expect(fog.isStale(0, '0,0', null)).toBe(false)
    expect(fog.export()[0].epochs['0,0']).toBe(0)
  })
})

describe('pins and the stale rule', () => {
  it('pinWay appends to a typed, deduped ways list and countWays matches it', () => {
    const fog = createFogMap()
    const list = fog.ways(0)
    fog.pinWay(0, way('0,0', 'down', 5.5, 5.5))
    fog.pinWay(0, way('0,0', 'down', 5.5, 6.5))                    // same key: updated in place, not appended
    fog.pinWay(0, way('0,0:up', 'up', 7.5, 5.5, 0, 'stairwell up'))
    fog.pinWay(0, way('2,0:lift', 'lift', 50.5, 5.5, 3, 'the lift'))
    fog.pinThing(0, 's:1', 'sight', 9.5, 9.5)
    expect(fog.ways(0)).toBe(list)
    expect(list.map((p) => p.key)).toEqual(['0,0', '0,0:up', '2,0:lift'])
    expect(list[0]).toMatchObject({ key: '0,0', type: 'down', x: 5.5, y: 6.5, chunkKey: '0,0', lost: false, label: 'descend', target: 1 })
    expect(fog.countWays(0)).toEqual({ down: 1, up: 1, lift: 1, ring: 0 })
    expect(fog.countWays(0)).toBe(fog.countWays(0))                 // reused
    expect(fog.pins(0).size).toBe(4)
    expect(fog.ways(9)).toEqual([])
    expect(fog.ways(9)).toBe(fog.ways(9))
    expect(9 in fog.export()).toBe(false)                           // asked about, never drawn on: not saved
    expect(fog.countWays(9)).toEqual({ down: 0, up: 0, lift: 0, ring: 0 })
    for (const k of WAY_KINDS) expect(k in fog.countWays(0)).toBe(true)
  })

  it('pinThing keeps the newest arrived pin and the last twelve hurt pins', () => {
    const fog = createFogMap()
    expect(fog.arrivedPin(0)).toBeNull()
    fog.pinThing(0, 'arrived:1', 'arrived', 1.5, 1.5)
    fog.pinThing(0, 'arrived:9', 'arrived', 3.5, 3.5)
    expect(fog.arrivedPin(0)).toMatchObject({ key: 'arrived:9', x: 3.5, y: 3.5 })
    for (let i = 0; i < 15; i++) fog.pinThing(0, 'hurt:' + i, 'hurt', i + 0.5, 0.5)
    const hurt = [...fog.pins(0).values()].filter((p) => p.type === 'hurt')
    expect(hurt).toHaveLength(12)
    expect(hurt.map((p) => p.key)).toContain('hurt:14')
    expect(hurt.map((p) => p.key)).not.toContain('hurt:2')
  })

  it('checkStale returns a lost pin only when a stale way pin is within two cells and nearestWayFn finds nothing', () => {
    const fog = createFogMap()
    let epoch = 0
    const epochOf = () => epoch
    fog.step(0, 5.5, 5.5, 2, open, epochOf)
    const pin = fog.pinWay(0, way('0,0', 'down', 5.5, 5.5))
    expect(fog.isStale(0, '0,0', epochOf)).toBe(false)
    epoch = 1
    expect(fog.isStale(0, '0,0', epochOf)).toBe(true)              // the building moved under it
    expect(fog.checkStale(0, at(12.5, 5.5), () => null, epochOf)).toBeNull()   // too far
    expect(fog.checkStale(0, at(8.5, 5.5), () => null, epochOf)).toBeNull()    // three cells: still too far
    expect(fog.checkStale(0, at(7.5, 6.5), () => ({ key: '0,0' }), epochOf)).toBeNull()   // the way is still there
    expect(pin.lost).toBe(false)
    fog.step(0, 7.5, 6.5, 2, open, epochOf)                        // walking in fades the chunk; stale stays true
    expect(fog.isStale(0, '0,0', epochOf)).toBe(true)
    const lost = fog.checkStale(0, at(7.5, 6.5), () => null, epochOf)
    expect(lost).toBe(pin)
    expect(pin.lost).toBe(true)
    expect(fog.checkStale(0, at(7.5, 6.5), () => null, epochOf)).toBeNull()   // already lost: not reported twice
    expect(fog.countWays(0).down).toBe(1)                          // still on the map
  })

  it('a later pinWay with the same key clears lost and the chunk fade; markLost sets it by hand', () => {
    const fog = createFogMap()
    let epoch = 0
    const epochOf = () => epoch
    fog.step(0, 5.5, 5.5, 1, open, epochOf)
    const pin = fog.pinWay(0, way('0,0', 'down', 5.5, 5.5))
    epoch = 1
    fog.step(0, 6.5, 5.5, 1, open, epochOf)
    fog.markLost(0, '0,0')
    expect(pin.lost).toBe(true)
    expect(buildMapView(fog, 0, at(6.5, 5.5), { cells: 56 }).faded.has('0,0')).toBe(true)
    expect(fog.isStale(0, '0,0', epochOf)).toBe(true)
    fog.pinWay(0, way('0,0', 'down', 6.5, 7.5))
    expect(pin.lost).toBe(false)
    expect(pin.x).toBe(6.5)
    expect(buildMapView(fog, 0, at(6.5, 5.5), { cells: 56 }).faded.has('0,0')).toBe(false)
    expect(fog.isStale(0, '0,0', epochOf)).toBe(false)
    expect(fog.export()[0].fresh).toEqual({})
    expect(fog.export()[0].pins[0][6]).toBe(false)
    expect(fog.isStale(0, '7,7', epochOf)).toBe(false)             // a chunk never walked is not stale
  })
})

describe('buildMapView', () => {
  it('windows on the player cell, counts the set bits in the window and excludes pins outside it', () => {
    const fog = createFogMap()
    fog.step(0, 100.5, 100.5, 3, open)                              // 49 cells around (100, 100)
    fog.step(0, 200.5, 200.5, 3, open)                              // far away: outside the window
    fog.pinWay(0, way('4,4', 'down', 102.5, 99.5))
    fog.pinThing(0, 'far', 'sight', 200.5, 200.5)
    const v = buildMapView(fog, 0, at(100.5, 100.5, 1.2), { cells: 56 })
    expect(v.ox).toBe(100 - 28); expect(v.oy).toBe(100 - 28); expect(v.size).toBe(56)
    expect(v.px).toBe(100.5); expect(v.py).toBe(100.5); expect(v.angle).toBe(1.2)
    expect(v.n).toBe(49)
    expect(v.counts.walked).toBe(49)
    expect(v.counts.total).toBe(98)
    expect(v.counts).toMatchObject({ down: 1, up: 0, lift: 0, ring: 0 })
    const seen = new Set()
    for (let i = 0; i < v.n; i++) {
      const dx = v.cells[2 * i], dy = v.cells[2 * i + 1]
      expect(dx).toBeGreaterThanOrEqual(0); expect(dx).toBeLessThan(56)
      expect(dy).toBeGreaterThanOrEqual(0); expect(dy).toBeLessThan(56)
      expect(fog.has(0, v.ox + dx + 0.5, v.oy + dy + 0.5)).toBe(true)
      expect(v.dim[i]).toBe(0)
      seen.add(dx + ',' + dy)
    }
    expect(seen.size).toBe(49)
    expect(v.nFresh).toBe(0)
    expect(v.faded.size).toBe(0)
    expect(v.pins.map((p) => p.key)).toEqual(['4,4'])
    const v2 = buildMapView(fog, 0, at(100.5, 100.5, 1.2), { cells: 56, out: v })
    expect(v2).toBe(v)
    expect(v2.cells).toBe(v.cells)
  })

  it('flags faded chunks, dims their cells and lists the fresh cells separately', () => {
    const fog = createFogMap()
    let epoch = 0
    const epochOf = () => epoch
    fog.step(0, 5.5, 5.5, 1, open, epochOf)
    epoch = 1
    fog.step(0, 5.5, 12.5, 1, open, epochOf)
    const v = buildMapView(fog, 0, at(5.5, 12.5), { cells: 56 })
    expect(v.faded.has('0,0')).toBe(true)
    expect(v.n).toBe(18)                                             // both floods, old and new, in the dim layer
    for (let i = 0; i < v.n; i++) expect(v.dim[i]).toBe(1)
    expect(v.nFresh).toBe(9)
    for (let i = 0; i < v.nFresh; i++) {
      const dx = v.fresh[2 * i], dy = v.fresh[2 * i + 1]
      expect(Math.abs(v.oy + dy - 12)).toBeLessThanOrEqual(1)
      expect(Math.abs(v.ox + dx - 5)).toBeLessThanOrEqual(1)
    }
    expect(v.counts.walked).toBe(18)
  })

  it('an unknown level gives an empty view', () => {
    const v = buildMapView(createFogMap(), 3, at(0.5, 0.5), { cells: 56 })
    expect(v.n).toBe(0); expect(v.nFresh).toBe(0); expect(v.pins).toEqual([]); expect(v.counts.total).toBe(0)
  })
})
