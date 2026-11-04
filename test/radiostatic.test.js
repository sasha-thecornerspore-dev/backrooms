// radiostatic.js — the radio as a fuzzy warning (M21). Your radio, on, hisses, and the hiss follows the dread you already feel
// (dread.js dreadFrom over the path field): monotone in it, nothing at none, its top at STATIC.full and past it. Nothing about where:
// the level is one number for both ears, read off a sum that never asks the bearing, so a thing on your left and the same thing on
// your right are the same hiss; a thing behind a wall is no hiss however close it stands, and one far round by the halls is a faint
// one. A hunt holds the hiss where it was (dread counts nothing hunting you). The radio off, the creatures off, a fade, the block: no
// hiss at all, the radio as it was. The glide's time constants say which way it is going; the record is the one, every tick.
import { describe, it, expect } from 'vitest'
import { STATIC, staticLevel, createRadioStatic } from '../src/renderer/radiostatic.js'
import { dreadFrom, DREAD_R } from '../src/renderer/dread.js'
import { createPathField } from '../src/renderer/pathfield.js'
import { CHUNK_SIZE } from '../src/renderer/world.js'

const N = CHUNK_SIZE
function fakeCache(wall) {
  const chunks = new Map()
  return {
    getChunk(cx, cy) {
      const k = `${cx},${cy}`
      if (!chunks.has(k)) {
        const c = new Uint8Array(N * N)
        for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) c[y * N + x] = wall(cx * N + x, cy * N + y) ? 1 : 0
        chunks.set(k, c)
      }
      return chunks.get(k)
    },
  }
}
const fieldAt = (ix, iy, wall = () => false) => { const f = createPathField(); f.build(ix, iy, fakeCache(wall)); return f }
const thing = (x, y, variant = 'shade', extra = {}) => ({ x, y, variant, ai: 'roam', pending: 0, stagger: 0, los: false, ...extra })
const mkOut = () => ({ dread: 0, x: 0, y: 0, variant: null, d: -1, los: false })
const P = { x: 11.5, y: 11.5, angle: 0 }

describe('the table', () => {
  it('is frozen, and every number in it is a positive finite one; the top sits under audio.js\'s cap and the glide falls slower than it rises', () => {
    expect(Object.isFrozen(STATIC)).toBe(true)
    expect(Object.keys(STATIC).sort()).toEqual(['curve', 'cut', 'fall', 'full', 'max', 'rise'])
    for (const [k, v] of Object.entries(STATIC)) { expect(Number.isFinite(v), k).toBe(true); expect(v, k).toBeGreaterThan(0) }
    expect(STATIC.max).toBeLessThanOrEqual(0.06)          // audio.js PEAK_CAP
    expect(STATIC.full).toBeLessThanOrEqual(1)            // dread is clamped at 1: the top must be reachable
    expect(STATIC.curve).toBeLessThanOrEqual(1)           // a far thing is already heard
    expect(STATIC.fall).toBeGreaterThan(STATIC.rise)
    expect(STATIC.cut).toBeLessThan(STATIC.rise)
  })
})

describe('staticLevel: the hiss for a dread', () => {
  it('is 0 at no dread, and for anything that is not a positive number', () => {
    for (const d of [0, -0.5, NaN, undefined, null, -Infinity]) expect(staticLevel(d), String(d)).toBe(0)
  })
  it('is monotone in dread: never falls as dread rises, strictly rises below full, and is the top at full and past it', () => {
    let last = -1
    for (let i = 0; i <= 1200; i++) {
      const d = i / 1000, g = staticLevel(d)
      expect(g).toBeGreaterThanOrEqual(last)
      if (d > 0 && d < STATIC.full) expect(g).toBeGreaterThan(last)
      expect(g).toBeGreaterThanOrEqual(0); expect(g).toBeLessThanOrEqual(STATIC.max)
      last = g
    }
    expect(staticLevel(STATIC.full)).toBe(STATIC.max); expect(staticLevel(1)).toBe(STATIC.max); expect(staticLevel(Infinity)).toBe(STATIC.max)
  })
  it('a thing at the edge of the reach is already heard, at least a sixth of the top', () => {
    // the faintest thing dread counts: a crawler (0.3) at DREAD_R path cells, 0.3 / (1 + 24 / 6)
    expect(staticLevel(0.3 / (1 + DREAD_R / 6))).toBeGreaterThan(STATIC.max / 6)
  })
})

describe('createRadioStatic: tick(dread, hunted, radioOn, live)', () => {
  it('the radio on, live, nothing hunting: the hiss is staticLevel(dread), the same record every tick', () => {
    const rs = createRadioStatic()
    const r0 = rs.tick(0, false, true, true)
    for (let i = 0; i <= 100; i++) {
      const d = i / 100, r = rs.tick(d, false, true, true)
      expect(r).toBe(r0)
      expect(r.gain).toBe(staticLevel(d))
    }
  })
  it('the radio off, or creatures off / a fade / the block (live false): no hiss at any dread, hunted or not, cut fast', () => {
    for (const [on, live] of [[false, true], [true, false], [false, false]]) {
      const rs = createRadioStatic()
      for (let i = 0; i <= 20; i++) for (const hunted of [false, true]) {
        const r = rs.tick(i / 20, hunted, on, live)
        expect([r.gain, r.tc], `${on} ${live}`).toEqual([0, STATIC.cut])
      }
    }
  })
  it('switching the radio off mid-hiss drops it to nothing at the cut; on again, it comes back up at the rise', () => {
    const rs = createRadioStatic()
    expect(rs.tick(0.5, false, true, true)).toMatchObject({ gain: staticLevel(0.5), tc: STATIC.rise })
    expect(rs.tick(0.5, false, false, true)).toMatchObject({ gain: 0, tc: STATIC.cut })
    expect(rs.tick(0.5, false, true, true)).toMatchObject({ gain: staticLevel(0.5), tc: STATIC.rise })
    expect(rs.tick(0.5, false, true, false)).toMatchObject({ gain: 0, tc: STATIC.cut })   // the creatures switched off
  })
  it('rises at the rise, falls at the fall', () => {
    const rs = createRadioStatic()
    expect(rs.tick(0.2, false, true, true).tc).toBe(STATIC.rise)
    expect(rs.tick(0.4, false, true, true).tc).toBe(STATIC.rise)
    expect(rs.tick(0.1, false, true, true).tc).toBe(STATIC.fall)
    expect(rs.tick(0, false, true, true)).toMatchObject({ gain: 0, tc: STATIC.fall })   // the thing goes: it lingers out, it is not cut
  })
  it('a hunt holds it: dread counts nothing hunting you, so the hiss keeps the level it had, and still rises with anything else near', () => {
    const rs = createRadioStatic()
    rs.tick(0.3, false, true, true)
    expect(rs.tick(0, true, true, true).gain).toBe(staticLevel(0.3))      // it saw you: its dread is gone, the hiss is not
    expect(rs.tick(0.1, true, true, true).gain).toBe(staticLevel(0.3))
    expect(rs.tick(0.5, true, true, true).gain).toBe(staticLevel(0.5))    // a second thing comes in: it rises
    expect(rs.tick(0.2, true, true, true).gain).toBe(staticLevel(0.5))
    expect(rs.tick(0.2, false, true, true)).toMatchObject({ gain: staticLevel(0.2), tc: STATIC.fall })   // the hunt lets go
    expect(rs.tick(0, true, false, true).gain).toBe(0)                    // the radio off forgets the hold
    expect(rs.tick(0, true, true, true).gain).toBe(0)
  })
  it('reset forgets the hold and the level', () => {
    const rs = createRadioStatic()
    rs.tick(0.6, false, true, true); rs.reset()
    expect(rs.tick(0, true, true, true)).toMatchObject({ gain: 0 })
  })
})

describe('nothing about where: the path\'s dread, one level for both ears', () => {
  const level = (ents, f, p = P) => { const o = mkOut(); dreadFrom(ents, f, p, o); return createRadioStatic().tick(o.dread, false, true, true).gain }
  it('the same thing on your left, your right, ahead or behind, at the same path distance, is the same hiss, whichever way you face', () => {
    const f = fieldAt(11, 11)
    const at = [[17.5, 11.5], [5.5, 11.5], [11.5, 17.5], [11.5, 5.5]]
    const want = level([thing(17.5, 11.5)], f)
    expect(want).toBeGreaterThan(0)
    for (const angle of [0, Math.PI / 2, Math.PI, -Math.PI / 3]) {
      for (const [x, y] of at) expect(level([thing(x, y)], f, { ...P, angle }), `${x},${y} @${angle}`).toBe(want)
    }
  })
  it('a thing coming along a hall raises it step by step', () => {
    // a long open corridor east of you, walls either side
    const hall = (x, y) => y !== 11
    const f = fieldAt(11, 11, hall)
    let last = 0
    for (let x = 11 + DREAD_R; x >= 13; x--) {
      const g = level([thing(x + 0.5, 11.5, 'hound')], f)
      expect(g, `x ${x}`).toBeGreaterThan(last)
      last = g
    }
  })
  it('a thing two cells away behind a wall, far round by the halls, is a faint hiss; out of reach by path, none, however close the line', () => {
    // a wall along x = 13 with one gap far to the south: the thing at (14, 11) stands 3 cells off in a line, the path goes round
    const gapY = 11 + 9
    const wall = (x, y) => x === 13 && y !== gapY
    const f = fieldAt(11, 11, wall)
    const behind = thing(14.5, 11.5, 'hound')
    const o = mkOut(); dreadFrom([behind], f, P, o)
    expect(o.d).toBe(1 + 9 + 2 + 9)                                           // round by the gap: 21 path cells
    const near = level([thing(12.5, 11.5, 'hound')], fieldAt(11, 11))          // the same hound in the open, one cell off
    expect(level([behind], f)).toBeGreaterThan(0)
    expect(level([behind], f)).toBeLessThan(near / 2)
    const sealed = (x, y) => x === 13                                          // no gap at all: unreachable by path
    expect(level([behind], fieldAt(11, 11, sealed))).toBe(0)
  })
})
