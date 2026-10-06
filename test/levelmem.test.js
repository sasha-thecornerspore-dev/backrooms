// levelmem.js — what each floor remembers of you: where you stood, what you took and spent and searched, what you set down.
import { describe, it, expect } from 'vitest'
import { createLevelMemory, VEND_RESTOCK_S } from '../src/renderer/levelmem.js'

describe('createLevelMemory', () => {
  it('leave / arrive round-trip, including the chunk; visits increments; get() is null until a floor is touched', () => {
    const mem = createLevelMemory()
    expect(mem.get(1)).toBeNull()
    const a = mem.arrive(1, { cx: 2, cy: -3 }, 10)
    expect(a.visits).toBe(1)
    expect(a.arrived).toEqual({ cx: 2, cy: -3 })
    expect(a.lastT).toBe(10)
    expect(mem.get(1)).toBe(a)
    mem.leave(1, { x: 50.25, y: -60.5, angle: 1.75, hp: 40 }, { cx: 2, cy: -3 }, 120)
    expect(mem.get(1)).toMatchObject({ x: 50.25, y: -60.5, angle: 1.75, cx: 2, cy: -3, lastT: 120, visits: 1 })
    expect(mem.get(1).hp).toBeUndefined()
    const b = mem.arrive(1, { cx: 5, cy: 5 }, 300)
    expect(b).toBe(a)
    expect(b.visits).toBe(2)
    expect(b.arrived).toEqual({ cx: 5, cy: 5 })
    expect(b.x).toBe(50.25)                        // the remembered spot survives the new arrival
    expect(mem.get('1')).toBe(a)                   // keyed by String(level)
    expect(mem.get(2)).toBeNull()
  })

  it('VEND_RESTOCK_S is 600', () => { expect(VEND_RESTOCK_S).toBe(600) })

  it('vendedFor keeps a key spent while visits have not advanced, even after 10000 s', () => {
    const mem = createLevelMemory()
    mem.arrive(2, { cx: 0, cy: 0 }, 0)
    mem.noteVended(2, '0,0', 5)
    mem.noteVended(2, '1,0', 6)
    expect(mem.vendedFor(2, 6)).toEqual(new Set(['0,0', '1,0']))
    expect(mem.vendedFor(2, 10006)).toEqual(new Set(['0,0', '1,0']))     // you watched the whole time: nothing restocks
    expect(mem.vendedFor(2, 10006)).not.toBe(mem.vendedFor(2, 10006))   // a fresh Set each call
    expect(mem.vendedFor(3, 0)).toEqual(new Set())
  })

  it('a spent key expires once 600 s have passed AND visits advanced', () => {
    const mem = createLevelMemory()
    mem.arrive(2, { cx: 0, cy: 0 }, 0)
    mem.noteVended(2, 'm', 100)
    mem.leave(2, { x: 1, y: 1, angle: 0 }, { cx: 0, cy: 0 }, 150)
    mem.arrive(2, { cx: 0, cy: 0 }, 200)                                 // visits 2, but only 100 s since the vend
    expect(mem.vendedFor(2, 200)).toEqual(new Set(['m']))
    expect(mem.vendedFor(2, 699)).toEqual(new Set(['m']))
    expect(mem.vendedFor(2, 700)).toEqual(new Set())                     // 600 s AND an absence
    expect(mem.vendedFor(2, 5000)).toEqual(new Set())
  })

  it('wasRestocked is true exactly once: for a key spent on a previous visit that has expired, until it is spent again', () => {
    const mem = createLevelMemory()
    mem.arrive(1, { cx: 0, cy: 0 }, 0)
    mem.noteVended(1, 'k', 10)
    expect(mem.wasRestocked(1, 'k')).toBe(false)                         // same visit
    mem.arrive(1, { cx: 0, cy: 0 }, 300)
    expect(mem.wasRestocked(1, 'k')).toBe(false)                         // absent, but not 600 s yet
    mem.arrive(1, { cx: 0, cy: 0 }, 900)
    expect(mem.wasRestocked(1, 'k')).toBe(true)
    mem.noteVended(1, 'k', 900)                                          // drawn again: the new spend is this visit's
    expect(mem.wasRestocked(1, 'k')).toBe(false)
    expect(mem.vendedFor(1, 900)).toEqual(new Set(['k']))
    expect(mem.get(1).vended).toEqual([['k', 900, 3]])                   // one entry per key
    expect(mem.wasRestocked(1, 'never')).toBe(false)
    expect(mem.wasRestocked(9, 'k')).toBe(false)
    // with an explicit clock it agrees with vendedFor at that time
    expect(mem.wasRestocked(1, 'k', 1499)).toBe(false)
    mem.arrive(1, { cx: 0, cy: 0 }, 1000)
    expect(mem.wasRestocked(1, 'k', 1499)).toBe(false); expect(mem.vendedFor(1, 1499)).toEqual(new Set(['k']))
    expect(mem.wasRestocked(1, 'k', 1500)).toBe(true); expect(mem.vendedFor(1, 1500)).toEqual(new Set())
  })

  it('taken / searched / dropped are per level', () => {
    const mem = createLevelMemory()
    mem.noteTaken(0, '1,1:3'); mem.noteTaken(0, '1,1:3'); mem.noteTaken(0, '2,2:1')
    mem.noteTaken(1, '9,9:0')
    expect(mem.takenFor(0)).toEqual(new Set(['1,1:3', '2,2:1']))
    expect(mem.takenFor(1)).toEqual(new Set(['9,9:0']))
    expect(mem.takenFor(2)).toEqual(new Set())
    expect(mem.takenFor(0)).toBe(mem.takenFor(0))                        // the live set
    mem.noteSearched(3, 'c:1'); mem.noteSearched(3, 'c:2')
    expect(mem.searchedFor(3)).toEqual(new Set(['c:1', 'c:2']))
    expect(mem.searchedFor(0)).toEqual(new Set())
    expect(mem.droppedFor(2)).toEqual([])
    const list = [{ x: 1, y: 2, type: 'radio', on: true }, { x: 3, y: 4, type: 'glowstick', t0: 5 }]
    mem.setDropped(2, list)
    expect(mem.droppedFor(2)).toEqual(list)
    expect(mem.droppedFor(2)).not.toBe(list)                              // a copy, never the caller's array
    expect(mem.droppedFor(1)).toEqual([])
    mem.setDropped(2, null)
    expect(mem.droppedFor(2)).toEqual([])
  })

  it('export -> import is an identity, and import replaces what was there', () => {
    const mem = createLevelMemory()
    mem.arrive(0, { cx: 0, cy: 0 }, 0)
    mem.leave(0, { x: 11.5, y: 12.5, angle: 0.5 }, { cx: 0, cy: 0 }, 40)
    mem.arrive(1, { cx: 0, cy: 0 }, 41)
    mem.noteTaken(1, 'a'); mem.noteTaken(1, 'b')
    mem.noteVended(1, 'm1', 50)
    mem.noteSearched(1, 's1')
    mem.setDropped(1, [{ x: 1, y: 1, type: 'bandage' }])
    mem.arrive(4, { cx: 0, cy: 0 }, 0)
    const out = mem.export()
    expect(out).toEqual({
      0: { x: 11.5, y: 12.5, angle: 0.5, cx: 0, cy: 0, visits: 1, lastT: 40, arrived: { cx: 0, cy: 0 }, taken: [], vended: [], searched: [], dropped: [] },
      1: { x: null, y: null, angle: 0, cx: 0, cy: 0, visits: 1, lastT: 41, arrived: { cx: 0, cy: 0 }, taken: ['a', 'b'], vended: [['m1', 50, 1]], searched: ['s1'], dropped: [{ x: 1, y: 1, type: 'bandage' }] },
      4: { x: null, y: null, angle: 0, cx: 0, cy: 0, visits: 1, lastT: 0, arrived: { cx: 0, cy: 0 }, taken: [], vended: [], searched: [], dropped: [] },
    })
    expect(JSON.parse(JSON.stringify(out))).toEqual(out)                 // plain data: survives the save file
    const back = createLevelMemory()
    back.noteTaken(7, 'stale')
    back.import(JSON.parse(JSON.stringify(out)))
    expect(back.export()).toEqual(out)
    expect(back.get(7)).toBeNull()
    expect(back.takenFor(1)).toEqual(new Set(['a', 'b']))
    expect(back.searchedFor(1)).toEqual(new Set(['s1']))
    expect(back.droppedFor(1)).toEqual([{ x: 1, y: 1, type: 'bandage' }])
    expect(back.vendedFor(1, 700)).toEqual(new Set(['m1']))              // visits not advanced since the import
    expect(back.get(0).x).toBe(11.5)
  })

  it('import of null / garbage / oversized arrays is safe and capped', () => {
    const mem = createLevelMemory()
    for (const bad of [undefined, null, 0, 'x', [], true, { 1: null }, { 1: 'junk' }, { 1: { taken: 'no', vended: 5, searched: {}, dropped: 'z', visits: 'q', x: 'a' } }]) {
      expect(() => mem.import(bad)).not.toThrow()
    }
    mem.import({ 1: { taken: 'no', vended: 5, searched: {}, dropped: 'z', visits: 'q', x: 'a', arrived: 3 } })
    const r = mem.get(1)
    expect(r).toMatchObject({ x: null, y: null, angle: 0, visits: 0, arrived: null })
    expect(mem.takenFor(1).size).toBe(0); expect(mem.searchedFor(1).size).toBe(0); expect(mem.droppedFor(1)).toEqual([])
    expect(mem.vendedFor(1, 0).size).toBe(0)
    const big = (n, f) => Array.from({ length: n }, (_, i) => f(i))
    mem.import({
      2: {
        taken: big(2500, (i) => `t${i}`).concat([5, null, {}]),
        searched: big(2500, (i) => `s${i}`),
        vended: big(600, (i) => [`v${i}`, i, 1]).concat([['bad'], 'x', [1, 2, 3], ['ok', 'nan', 1]]),
        dropped: big(30, (i) => ({ x: i, y: i, type: 'radio' })).concat([null, 4, 'q']),
        visits: 3.7, x: 1.5, y: 2.5, angle: 0.25, cx: 1, cy: 2, lastT: 9, arrived: { cx: 'a', cy: 2 },
      },
    })
    const e = mem.export()[2]
    expect(e.taken).toHaveLength(2000); expect(e.taken[0]).toBe('t500'); expect(e.taken.at(-1)).toBe('t2499')   // the newest kept
    expect(e.searched).toHaveLength(2000)
    expect(e.vended).toHaveLength(500); expect(e.vended[0]).toEqual(['v100', 100, 1])
    expect(e.dropped).toHaveLength(24); expect(e.dropped[0].x).toBe(6)
    expect(e).toMatchObject({ visits: 3, x: 1.5, y: 2.5, angle: 0.25, cx: 1, cy: 2, lastT: 9, arrived: null })
    // live caps too
    const m2 = createLevelMemory()
    for (let i = 0; i < 2010; i++) m2.noteTaken(0, `k${i}`)
    expect(m2.takenFor(0).size).toBe(2000); expect(m2.takenFor(0).has('k0')).toBe(false); expect(m2.takenFor(0).has('k2009')).toBe(true)
    for (let i = 0; i < 510; i++) m2.noteVended(0, `v${i}`, i)
    expect(m2.get(0).vended).toHaveLength(500)
    m2.setDropped(0, big(30, (i) => ({ x: i, y: 0, type: 'radio' })))
    expect(m2.droppedFor(0)).toHaveLength(24)
  })
})
