// topology.js — the stacked floors: every level's ways (the exit first, then the stairs up and the lift), the partner gate, validated
// arrivals in one world coordinate system, and the words said on the way.
import { describe, it, expect } from 'vitest'
import {
  WAY_KINDS, UP_ONE_IN, LIFT_DENOM, waysFor, hasUpStair, chunkMid, findOpenNear, offsetBeside, arrivalFor, wayMessage, shortName, wayLabel,
} from '../src/renderer/topology.js'
import { LEVELS } from '../src/renderer/levels.js'
import { CHANNELS } from '../src/renderer/channels.js'
import { CHUNK_SIZE } from '../src/renderer/world.js'

const CS = CHUNK_SIZE
// decor.js's hash, copied so the gates can be recomputed from outside
function hash(a, b, c = 0) {
  let h = (a * 2654435761 ^ b * 2246822519 ^ Math.imul(c, 3266489917)) >>> 0
  h ^= h >>> 16; h = Math.imul(h, 0x45d9f3b) >>> 0
  h ^= h >>> 16
  return h >>> 0
}
const open = () => true
const solid = () => false
// a floor made of a set of open integer cells
const cells = (...list) => { const s = new Set(list.map(([x, y]) => `${x},${y}`)); return (ix, iy) => s.has(`${ix},${iy}`) }

describe('waysFor', () => {
  it('names the four kinds and the two sub-denominators', () => {
    expect(WAY_KINDS).toEqual(['down', 'up', 'lift', 'ring'])
    expect(UP_ONE_IN).toBe(3)
    expect(LIFT_DENOM).toBe(24)
  })

  it("[0] is always today's exit: kind by direction, target / denom / label from levels.js", () => {
    for (let i = 0; i < LEVELS.length; i++) {
      const ex = LEVELS[i].config.exit
      expect(waysFor(i)[0]).toEqual({ kind: ex.target < i ? 'ring' : 'down', target: ex.target, denom: ex.denom, label: ex.label })
    }
    expect(waysFor(0)[0]).toEqual({ kind: 'down', target: 1, denom: 4, label: 'no-clip deeper' })
    expect(waysFor(3)[0]).toEqual({ kind: 'ring', target: 0, denom: 5, label: 'climb out' })
  })

  it('the graph edges are exactly as specified', () => {
    expect(waysFor(0)).toHaveLength(1)
    const l1 = waysFor(1)
    expect(l1).toHaveLength(3)
    expect(l1[0]).toEqual({ kind: 'down', target: 2, denom: 4, label: 'descend' })
    expect(l1[1]).toEqual({ kind: 'up', target: 0, label: 'stairwell up', partnerOf: 0 })
    expect(l1[2]).toEqual({ kind: 'lift', target: 3, denom: 24, label: 'the lift' })
    const l2 = waysFor(2)
    expect(l2).toHaveLength(2)
    expect(l2[0]).toEqual({ kind: 'down', target: 3, denom: 5, label: 'descend' })
    expect(l2[1]).toEqual({ kind: 'up', target: 1, label: 'stairwell up', partnerOf: 1 })
    const l3 = waysFor(3)
    expect(l3).toHaveLength(2)
    expect(l3[0].kind).toBe('ring')
    expect(l3[1]).toEqual({ kind: 'up', target: 2, label: 'stairwell up', partnerOf: 2 })
    expect(l3.some((w) => w.kind === 'lift')).toBe(false)             // no lift on L3
    for (let i = 0; i < LEVELS.length; i++) for (const w of waysFor(i)) expect(WAY_KINDS).toContain(w.kind)
  })

  it('level ∅ (index 4) has only the one-way ring out to the lobby', () => {
    const w = waysFor(4)
    expect(w).toHaveLength(1)
    expect(w[0]).toEqual({ kind: 'ring', target: 0, denom: 1, label: 'no-clip out' })
  })

  it('wraps the index like levelConfig and returns stable, frozen data', () => {
    expect(waysFor(5)).toBe(waysFor(0))
    expect(waysFor(-1)).toBe(waysFor(4))
    expect(Object.isFrozen(waysFor(1))).toBe(true)
    expect(Object.isFrozen(waysFor(1)[1])).toBe(true)
  })
})

describe('hasUpStair (the partner gate)', () => {
  it("passes iff the PARENT's exit gate passes with the parent's salt and denom AND the child's 1-in-3 sub-gate passes", () => {
    for (const T of [1, 2, 3]) {
      const S = T - 1
      const saltS = LEVELS[S].config.maze.salt | 0, denomS = LEVELS[S].config.exit.denom
      const saltT = LEVELS[T].config.maze.salt | 0
      const [ea, eb] = CHANNELS.exits.gate, [ua, ub] = CHANNELS.upStair.gate
      let n = 0
      for (let cy = -12; cy < 12; cy++) for (let cx = -12; cx < 12; cx++) {
        for (const seed of [0, 77]) {
          const want = hash(cx + ea + saltS, cy + eb + saltS, seed) % denomS === 0 && hash(cx + ua + saltT, cy + ub + saltT, seed) % UP_ONE_IN === 0
          expect(hasUpStair(T, cx, cy, seed)).toBe(want)
          if (want) n++
        }
      }
      expect(n).toBeGreaterThan(0)
    }
  })

  it('is false where there is no floor above (L0, ∅)', () => {
    for (let cy = -5; cy < 5; cy++) for (let cx = -5; cx < 5; cx++) { expect(hasUpStair(0, cx, cy, 0)).toBe(false); expect(hasUpStair(4, cx, cy, 0)).toBe(false) }
  })
})

describe('chunkMid / findOpenNear / offsetBeside', () => {
  it('chunkMid is the chunk\'s always-open hall crossing', () => {
    expect(chunkMid(0, 0)).toEqual({ x: 11.5, y: 11.5 })
    expect(chunkMid(2, -3)).toEqual({ x: 2 * CS + 11.5, y: -3 * CS + 11.5 })
  })

  it('findOpenNear returns the own cell centre when open', () => {
    expect(findOpenNear(5.2, 7.9, open)).toEqual({ x: 5.5, y: 7.5 })
  })

  it('findOpenNear spirals nearest-first: distance 1 before √2 before 2, and null past the rings', () => {
    expect(findOpenNear(5.5, 5.5, solid)).toBeNull()
    expect(findOpenNear(5.5, 5.5, cells([7, 5]))).toEqual({ x: 7.5, y: 5.5 })                       // distance 2
    expect(findOpenNear(5.5, 5.5, cells([7, 5], [6, 6]))).toEqual({ x: 6.5, y: 6.5 })               // √2 beats 2
    expect(findOpenNear(5.5, 5.5, cells([7, 5], [6, 6], [5, 4]))).toEqual({ x: 5.5, y: 4.5 })       // 1 beats √2
    expect(findOpenNear(5.5, 5.5, cells([8, 5]))).toEqual({ x: 8.5, y: 5.5 })                       // the third ring
    expect(findOpenNear(5.5, 5.5, cells([9, 5]))).toBeNull()                                        // past 3 rings
    expect(findOpenNear(5.5, 5.5, cells([9, 5]), 4)).toEqual({ x: 9.5, y: 5.5 })                    // rings widened
    // the order within one ring is deterministic: ties broken by scan order (dy, then dx)
    expect(findOpenNear(5.5, 5.5, cells([5, 6], [6, 5]))).toEqual({ x: 6.5, y: 5.5 })                 // (+1, 0) scans before (0, +1)
    expect(findOpenNear(5.5, 5.5, cells([5, 6], [4, 5]))).toEqual({ x: 4.5, y: 5.5 })                 // (-1, 0) scans before (0, +1)
  })

  it('offsetBeside prefers an open cardinal at distance 2 (with the cell between open), then 1, else the spot itself', () => {
    const spot = { x: 10.5, y: 10.5 }
    expect(offsetBeside(spot, open)).toEqual({ x: 12.5, y: 10.5 })
    expect(offsetBeside(spot, cells([10, 10], [10, 9], [10, 8]))).toEqual({ x: 10.5, y: 8.5 })          // north at 2
    expect(offsetBeside(spot, cells([10, 10], [10, 8]))).toBe(spot)                                    // the cell between is a wall: not "along an open cardinal"
    expect(offsetBeside(spot, cells([10, 10], [9, 10]))).toEqual({ x: 9.5, y: 10.5 })                   // only distance 1 open
    expect(offsetBeside(spot, cells([10, 10]))).toBe(spot)
    expect(offsetBeside(spot, solid)).toBe(spot)
  })
})

describe('arrivalFor', () => {
  const fromC = { cx: 3, cy: -2 }
  const partner = { key: '3,-2:up', x: 3 * CS + 4.5, y: -2 * CS + 9.5, kind: 'up' }
  const down = waysFor(0)[0], up = waysFor(1)[1], lift = waysFor(1)[2], ring = waysFor(3)[0]

  it('with a partner lands 2 cells away along an open cardinal, never on the partner cell when a neighbour is open', () => {
    const a = arrivalFor({ way: down, fromCx: fromC.cx, fromCy: fromC.cy, partner, mem: null, floorFn: open, angle: 1.2 })
    const d = Math.abs(a.x - partner.x) + Math.abs(a.y - partner.y)
    expect(d).toBeCloseTo(2, 12)
    expect(a.x === partner.x || a.y === partner.y).toBe(true)
    expect(a.chunk).toEqual(fromC)
    expect(a.angle).toBe(1.2)
    // one open neighbour only: that one, never the partner cell
    const px = Math.floor(partner.x), py = Math.floor(partner.y)
    const b = arrivalFor({ way: up, fromCx: fromC.cx, fromCy: fromC.cy, partner, mem: null, floorFn: cells([px, py], [px, py + 1]) })
    expect(b).toMatchObject({ x: px + 0.5, y: py + 1.5 })
  })

  it('with a solid-except-midpoint floor every start falls back to the from-chunk\'s midpoint', () => {
    const mid = chunkMid(fromC.cx, fromC.cy)
    const onlyMid = (ix, iy) => ix === Math.floor(mid.x) && iy === Math.floor(mid.y)
    for (const args of [
      { way: down, partner },
      { way: up, partner },
      { way: down, partner: null },
      { way: ring, partner: null, mem: { x: 3 * CS + 2.5, y: -2 * CS + 3.5, angle: 0.4 } },
    ]) {
      const a = arrivalFor({ fromCx: fromC.cx, fromCy: fromC.cy, mem: null, floorFn: onlyMid, ...args })
      expect(a.x).toBe(mid.x); expect(a.y).toBe(mid.y)
      expect(a.chunk).toEqual(fromC)
    }
  })

  it('a ring arrival with memory inside a wall moves to the nearest open cell within 3 rings', () => {
    const mem = { x: 40.3, y: 40.8, angle: 2 }
    const a = arrivalFor({ way: ring, fromCx: 1, fromCy: 1, partner: null, mem, floorFn: cells([42, 40], [41, 41]), angle: 2 })
    expect(a).toMatchObject({ x: 41.5, y: 41.5, angle: 2 })                                  // √2 beats 2
    const b = arrivalFor({ way: ring, fromCx: 1, fromCy: 1, partner: null, mem, floorFn: open })
    expect(b.x).toBe(40.3); expect(b.y).toBe(40.8)                                             // open: the remembered spot itself
    const c = arrivalFor({ way: ring, fromCx: 1, fromCy: 1, partner: null, mem: { x: null }, floorFn: open })
    expect(c).toMatchObject(chunkMid(1, 1))                                                     // no memory: the midpoint
  })

  it("'lift' lands at the from-chunk's midpoint", () => {
    const a = arrivalFor({ way: lift, fromCx: 7, fromCy: 7, partner: null, mem: null, floorFn: open, angle: 0.3 })
    expect(a).toEqual({ x: chunkMid(7, 7).x, y: chunkMid(7, 7).y, angle: 0.3, chunk: { cx: 7, cy: 7 } })
  })

  it('angle preserved (0 when not given)', () => {
    expect(arrivalFor({ way: down, fromCx: 0, fromCy: 0, partner: null, mem: null, floorFn: open }).angle).toBe(0)
    expect(arrivalFor({ way: down, fromCx: 0, fromCy: 0, partner: null, mem: null, floorFn: open, angle: -2.5 }).angle).toBe(-2.5)
  })
})

describe('the words', () => {
  it('wayMessage per kind', () => {
    const down = waysFor(0)[0], up = waysFor(1)[1], lift = waysFor(1)[2], ring = waysFor(3)[0]
    expect(wayMessage(down, { partner: { key: 'x' }, mem: null, visits: 1 })).toBe('you land a few rooms over from where you fell.')
    expect(wayMessage(down, { partner: null, mem: null, visits: 1 })).toBe('you land a few rooms over. there is no way back up here.')
    expect(wayMessage(up, { partner: null, mem: null, visits: 2 })).toBe('you climb. the air is thinner and the same.')
    expect(wayMessage(lift, { partner: null, mem: null, visits: 1 })).toBe('the doors close behind you. the lift does not come back for you.')
    expect(wayMessage(lift, { before: true })).toBe('the lift arrives without being called. it only goes one place.')
    expect(wayMessage(down, { before: true })).toBeNull()
    expect(wayMessage(ring, { partner: null, mem: { x: 3, y: 4, visits: 2 }, visits: 2 })).toBe('the carpet remembers you.')
    expect(wayMessage(ring, { partner: null, mem: { x: null, visits: 1 }, visits: 1 })).toBeNull()
    expect(wayMessage(ring, { partner: null, mem: null, visits: 1 })).toBeNull()
    expect(wayMessage({ kind: 'nothing' }, {})).toBeNull()
  })

  it('shortName / wayLabel', () => {
    expect(shortName(0)).toBe('level 0')
    expect(shortName(3)).toBe('level 3')
    expect(shortName(4)).toBe('the block')
    expect(shortName('∅')).toBe('the block')
    expect(wayLabel(waysFor(1)[1])).toBe('stairwell up — level 0')
    expect(wayLabel(waysFor(1)[2])).toBe('the lift — level 3')
    expect(wayLabel(waysFor(4)[0])).toBe('no-clip out — level 0')
  })
})
