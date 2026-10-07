// placement.js — cell classification, wall sides, the hug, the lane rule and settleChunk. Pure; runs in Node.
import { describe, it, expect } from 'vitest'
import {
  HUG_GAP, LANE_MIN, JUNCTION_MAX_R, CLUTTER_LINES, classifyCell, wallSides, corridorAxis, settle, settleChunk,
} from '../src/renderer/placement.js'
import { PLAYER_R, PLAYER_WALL_R, footprintRadius, visualHalf, colliderFor } from '../src/renderer/collide.js'
import { unitJitter } from '../src/renderer/gfx-sprites.js'
import { createChunkCache, createGridReader, DEFAULT_CONFIG } from '../src/renderer/world.js'
import { levelConfig } from '../src/renderer/levels.js'

// a hand-written 9x9 grid ('#' wall, '.' open) with every class in it
const GRID = [
  '#########',
  '#..#....#',
  '#..#.##.#',
  '##.#.##.#',
  '##...#.##',
  '#..#.#.##',
  '#.##....#',
  '#....##.#',
  '#########',
]
const gridFloor = (ix, iy) => GRID[iy]?.[ix] === '.'
const sidesOf = (N, E, S, W) => ({ N, E, S, W })
// the decor hash (decor.js:17), copied so the parity rule can be checked from outside
function hash(a, b, c = 0) {
  let h = (a * 2654435761 ^ b * 2246822519 ^ Math.imul(c, 3266489917)) >>> 0
  h ^= h >>> 16; h = Math.imul(h, 0x45d9f3b) >>> 0
  h ^= h >>> 16
  return h >>> 0
}
const rec = (kind, type, x, y, over = {}) => Object.assign(colliderFor(kind, { x, y, type, key: 'k' }), over)

describe('constants', () => {
  it('ships the numbers from the plan', () => {
    expect(HUG_GAP).toBe(0.02)
    expect(LANE_MIN).toBe(0.30)
    expect(JUNCTION_MAX_R).toBe(0.22)
  })

  it('CLUTTER_LINES are the lines to ship: lowercase, no exclamation marks', () => {
    expect(CLUTTER_LINES).toEqual({
      couch: 'you edge past the couch.',
      chairpile: 'you squeeze through the chairs. they shift.',
      tvwall: 'you squeeze past the televisions. they are all on.',
      transformer: 'you edge past the transformer. it is warm.',
      crate: 'you edge past the crate.',
      default: 'you edge past it.',
    })
    for (const s of Object.values(CLUTTER_LINES)) { expect(s).toBe(s.toLowerCase()); expect(s).not.toContain('!') }
  })
})

describe('classifyCell on the 9x9 grid', () => {
  it('labels room / corridor / nook / junction as drawn', () => {
    for (const [x, y] of [[1, 1], [2, 1], [1, 2], [2, 2]]) expect(classifyCell(gridFloor, x, y), `${x},${y}`).toBe('room')
    for (const [x, y] of [[2, 3], [3, 4], [5, 6]]) expect(classifyCell(gridFloor, x, y), `${x},${y}`).toBe('corridor')
    for (const [x, y] of [[6, 4], [7, 3]]) expect(classifyCell(gridFloor, x, y), `${x},${y}`).toBe('nook')
    for (const [x, y] of [[2, 4], [4, 1], [4, 6], [6, 6], [1, 7], [2, 5]]) expect(classifyCell(gridFloor, x, y), `${x},${y}`).toBe('junction')
  })

  it('accepts world coordinates (any point inside the cell)', () => {
    expect(classifyCell(gridFloor, 2.5, 3.5)).toBe('corridor')
    expect(classifyCell(gridFloor, 2.01, 3.99)).toBe('corridor')
    expect(classifyCell(gridFloor, 1.5, 1.5)).toBe('room')
  })

  it('wallSides reads N = -y, E = +x, S = +y, W = -x', () => {
    expect(wallSides(gridFloor, 2, 3)).toEqual(sidesOf(false, true, false, true))   // the x-walled corridor
    expect(wallSides(gridFloor, 3, 4)).toEqual(sidesOf(true, false, true, false))   // the y-walled corridor
    expect(wallSides(gridFloor, 6, 4)).toEqual(sidesOf(true, true, false, true))    // the nook opens south
    expect(wallSides(gridFloor, 2.5, 4.5)).toEqual(sidesOf(false, false, false, true))
  })

  it('corridorAxis: walls N+S -> x, walls E+W -> y, else null', () => {
    expect(corridorAxis(sidesOf(true, false, true, false))).toBe('x')
    expect(corridorAxis(sidesOf(false, true, false, true))).toBe('y')
    expect(corridorAxis(sidesOf(true, true, false, true))).toBe('y')         // a nook opening south is walked along y
    expect(corridorAxis(sidesOf(false, false, false, false))).toBeNull()
    expect(corridorAxis(sidesOf(true, true, true, true))).toBeNull()
    expect(corridorAxis(sidesOf(true, true, false, false))).toBeNull()
  })

  it('a hall cell classifies identically from both sides of a chunk border (world coordinates)', () => {
    const cfg = levelConfig(DEFAULT_CONFIG, 0)
    const cache = createChunkCache(cfg, 0)
    const grid = createGridReader(cache, (wx, wy, pcx, pcy) => cache.isWall(wx, wy, pcx, pcy))
    grid.setPlayerChunk(0, 0)
    const a = classifyCell(grid.floor, 21.5, 11.5)        // last hall cell of chunk (0, 0)
    const b = classifyCell(grid.floor, 22.5, 11.5)        // first hall cell of chunk (1, 0)
    expect(a).toBe('corridor')
    expect(b).toBe(a)
    expect(wallSides(grid.floor, 21.5, 11.5)).toEqual(sidesOf(true, false, true, false))
    expect(wallSides(grid.floor, 22.5, 11.5)).toEqual(sidesOf(true, false, true, false))
  })
})

describe('settle: the hug', () => {
  const vis = visualHalf('prop', 'cabinet'), r = footprintRadius('prop', 'cabinet')

  it('hugs a cabinet to vis + 0.02 from the chosen wall face and names the side', () => {
    const n = rec('prop', 'cabinet', 4.5, 7.5)
    settle(n, 'corridor', sidesOf(true, false, true, false), r, vis, 1)
    expect(n.y).toBeCloseTo(7 + vis + HUG_GAP, 12); expect(n.x).toBe(4.5); expect(n.hug).toBe('N'); expect(n.cellCls).toBe('corridor')
    const s = rec('prop', 'cabinet', 4.5, 7.5)
    settle(s, 'corridor', sidesOf(true, false, true, false), r, vis, -1)
    expect(s.y).toBeCloseTo(8 - vis - HUG_GAP, 12); expect(s.hug).toBe('S')
    const e = rec('prop', 'cabinet', 4.5, 7.5)
    settle(e, 'corridor', sidesOf(false, true, false, true), r, vis, 1)
    expect(e.x).toBeCloseTo(5 - vis - HUG_GAP, 12); expect(e.y).toBe(7.5); expect(e.hug).toBe('E')
    const w = rec('prop', 'cabinet', 4.5, 7.5)
    settle(w, 'corridor', sidesOf(false, true, false, true), r, vis, -1)
    expect(w.x).toBeCloseTo(4 + vis + HUG_GAP, 12); expect(w.hug).toBe('W')
    // +1 is the first of [N, E, S, W] that is a wall, -1 the last: a nook opening south hugs N or W
    const k1 = rec('prop', 'cabinet', 4.5, 7.5); settle(k1, 'nook', sidesOf(true, true, false, true), r, vis, 1)
    expect(k1.hug).toBe('N')
    const k2 = rec('prop', 'cabinet', 4.5, 7.5); settle(k2, 'nook', sidesOf(true, true, false, true), r, vis, -1)
    expect(k2.hug).toBe('W')
  })

  it('a hug moves a record by at most 0.48 - vis and never out of its cell', () => {
    for (const type of ['pipe', 'cone', 'payphone', 'cabinet', 'couch', 'chairpile']) {
      const kind = type === 'payphone' || type === 'chairpile' ? 'sight' : 'prop'
      const v = visualHalf(kind, type)
      for (const side of [1, -1]) {
        const o = rec(kind, type, 4.5, 7.5)
        settle(o, 'room', sidesOf(true, true, true, true), footprintRadius(kind, type), v, side)
        expect(Math.hypot(o.x - 4.5, o.y - 7.5)).toBeLessThanOrEqual(0.48 - v + 1e-12)
        expect(Math.floor(o.x)).toBe(4); expect(Math.floor(o.y)).toBe(7)
      }
    }
  })

  it('picks the unitJitter side when both sides are walls (deterministic over 1000 rots, both sides used)', () => {
    const sideFn = (p) => (unitJitter(p.rot, 23) < 0 ? -1 : 1)
    let north = 0, south = 0
    for (let i = 0; i < 1000; i++) {
      const rot = (i / 1000) * Math.PI * 2
      const a = rec('prop', 'cabinet', 4.5, 7.5, { rot })
      const b = rec('prop', 'cabinet', 4.5, 7.5, { rot })
      const side = sideFn(a)
      settle(a, 'corridor', sidesOf(true, false, true, false), r, vis, side)
      settle(b, 'corridor', sidesOf(true, false, true, false), r, vis, side)
      expect(a.y).toBe(b.y)
      if (side > 0) { north++; expect(a.hug).toBe('N'); expect(a.y).toBeCloseTo(7 + vis + HUG_GAP, 12) }
      else { south++; expect(a.hug).toBe('S'); expect(a.y).toBeCloseTo(8 - vis - HUG_GAP, 12) }
    }
    expect(north).toBeGreaterThan(200); expect(south).toBeGreaterThan(200)
  })

  it('settleChunk asks sideFn per record: sights, machines and souls pick by chunk-hash parity', () => {
    const seed = 424242
    const sideFn = (p) => (p.kind === 'prop' ? (unitJitter(p.rot, 23) < 0 ? -1 : 1) : ((hash(p.cx, p.cy, seed) & 1) ? 1 : -1))
    // a y-corridor at x = 4: N and S open, E and W walls
    const floor = (ix) => ix === 4
    const seen = []
    for (let cy = 0; cy < 40; cy++) {
      const y = cy * 22 + 7.5
      const list = [rec('machine', 'machine', 4.5, y), rec('npc', 'npc', 4.5, y), rec('sight', 'payphone', 4.5, y)]
      expect(settleChunk(list, floor, footprintRadius, visualHalf, sideFn)).toBe(list)
      const want = (hash(0, cy, seed) & 1) ? 'E' : 'W'
      for (const o of list) { expect(o.hug, `${o.kind} @ ${cy}`).toBe(want); expect(o.cellCls).toBe('corridor') }
      seen.push(want)
    }
    expect(seen).toContain('E'); expect(seen).toContain('W')
  })

  it("a 'none' record never moves", () => {
    const p = rec('prop', 'papers', 4.5, 7.5)
    expect(p.cls).toBe('none')
    settle(p, 'corridor', sidesOf(true, false, true, false), footprintRadius('prop', 'papers'), visualHalf('prop', 'papers'), 1)
    expect(p.x).toBe(4.5); expect(p.y).toBe(7.5); expect(p.hug).toBeNull(); expect(p.cls).toBe('none'); expect(p.cellCls).toBe('corridor')
    const w = rec('prop', 'weeds', 4.5, 7.5)
    settle(w, 'nook', sidesOf(true, true, false, true), footprintRadius('prop', 'weeds'), visualHalf('prop', 'weeds'), -1)
    expect(w.x).toBe(4.5); expect(w.y).toBe(7.5); expect(w.cls).toBe('none')
  })

  it('a room cell with a wall hugs it, without one stays centred; the footprint is never reduced', () => {
    const a = rec('prop', 'couch', 4.5, 7.5)
    settle(a, 'room', sidesOf(false, false, false, false), footprintRadius('prop', 'couch'), visualHalf('prop', 'couch'), 1)
    expect(a.x).toBe(4.5); expect(a.y).toBe(7.5); expect(a.hug).toBeNull(); expect(a.cls).toBe('solid'); expect(a.cellCls).toBe('room')
    const b = rec('prop', 'couch', 4.5, 7.5)
    settle(b, 'room', sidesOf(false, false, false, true), footprintRadius('prop', 'couch'), visualHalf('prop', 'couch'), 1)
    expect(b.hug).toBe('W'); expect(b.x).toBeCloseTo(4 + visualHalf('prop', 'couch') + HUG_GAP, 12); expect(b.cls).toBe('solid')
  })
})

describe('settle: the lane rule', () => {
  const inCorridor = (kind, type) => {
    const o = rec(kind, type, 4.5, 7.5)
    settle(o, 'corridor', sidesOf(true, false, true, false), footprintRadius(kind, type), visualHalf(kind, type), 1)
    return o
  }
  const free = (kind, type) => (1 - PLAYER_WALL_R) - (visualHalf(kind, type) + HUG_GAP + footprintRadius(kind, type) + PLAYER_R)

  it('free = (1 - PLAYER_WALL_R) - (vis + HUG_GAP + r + PLAYER_R) = 0.70 - 0.95 w', () => {
    expect(free('prop', 'cabinet')).toBeCloseTo(0.70 - 0.95 * 0.29, 12)
    expect(free('prop', 'couch')).toBeCloseTo(0.016, 12)
    expect(free('sight', 'chairpile')).toBeCloseTo(-0.212, 12)
  })

  it('couch, chairpile, tvwall, transformer become clutter in a corridor', () => {
    expect(inCorridor('prop', 'couch').cls).toBe('clutter')
    expect(inCorridor('sight', 'chairpile').cls).toBe('clutter')
    expect(inCorridor('sight', 'tvwall').cls).toBe('clutter')
    expect(inCorridor('prop', 'transformer').cls).toBe('clutter')
  })

  it('crate, vent, cabinet, npc, machine, payphone stay solid (and the rest of the table)', () => {
    for (const [kind, type] of [['prop', 'crate'], ['prop', 'vent'], ['prop', 'cabinet'], ['npc', 'npc'], ['machine', 'machine'], ['sight', 'payphone'],
      ['prop', 'pipe'], ['prop', 'barrel'], ['prop', 'drum'], ['prop', 'cone'], ['prop', 'chair'], ['prop', 'box'], ['prop', 'plant'],
      ['prop', 'cabinet-e'], ['prop', 'spool'], ['sight', 'mannequin']]) {
      expect(inCorridor(kind, type).cls, type).toBe('solid')
    }
  })

  it('the same table holds in a nook', () => {
    const inNook = (kind, type) => { const o = rec(kind, type, 4.5, 7.5); settle(o, 'nook', sidesOf(true, true, false, true), footprintRadius(kind, type), visualHalf(kind, type), 1); return o }
    expect(inNook('prop', 'couch').cls).toBe('clutter'); expect(inNook('prop', 'transformer').cls).toBe('clutter')
    expect(inNook('prop', 'crate').cls).toBe('solid'); expect(inNook('prop', 'cabinet').cls).toBe('solid')
  })

  it('a cone at a wall-less junction stays solid and centred; a couch there becomes clutter', () => {
    const cone = rec('prop', 'cone', 4.5, 7.5)
    settle(cone, 'junction', sidesOf(false, false, false, false), footprintRadius('prop', 'cone'), visualHalf('prop', 'cone'), 1)
    expect(cone.cls).toBe('solid'); expect(cone.x).toBe(4.5); expect(cone.y).toBe(7.5); expect(cone.hug).toBeNull(); expect(cone.cellCls).toBe('junction')
    const tf = rec('prop', 'transformer', 4.5, 7.5)                 // r .216 <= .22: still solid at a crossing
    settle(tf, 'junction', sidesOf(false, false, false, false), footprintRadius('prop', 'transformer'), visualHalf('prop', 'transformer'), 1)
    expect(tf.cls).toBe('solid')
    const couch = rec('prop', 'couch', 4.5, 7.5)
    settle(couch, 'junction', sidesOf(false, false, false, false), footprintRadius('prop', 'couch'), visualHalf('prop', 'couch'), 1)
    expect(couch.cls).toBe('clutter'); expect(couch.x).toBe(4.5)
    expect(footprintRadius('prop', 'couch')).toBeGreaterThan(JUNCTION_MAX_R)
    // a junction WITH a wall side hugs it and then applies the lane rule
    const c2 = rec('prop', 'couch', 4.5, 7.5)
    settle(c2, 'junction', sidesOf(true, false, false, false), footprintRadius('prop', 'couch'), visualHalf('prop', 'couch'), 1)
    expect(c2.hug).toBe('N'); expect(c2.cls).toBe('clutter')
    const k2 = rec('prop', 'cabinet', 4.5, 7.5)
    settle(k2, 'junction', sidesOf(true, false, false, false), footprintRadius('prop', 'cabinet'), visualHalf('prop', 'cabinet'), 1)
    expect(k2.hug).toBe('N'); expect(k2.cls).toBe('solid')
  })

  it('a chair in a corridor is hugged so a 0.12-AABB walker on the centreline never touches its disc', () => {
    for (const side of [1, -1]) {
      const chair = rec('prop', 'chair', 4.5, 7.5)
      settle(chair, 'corridor', sidesOf(true, false, true, false), footprintRadius('prop', 'chair'), visualHalf('prop', 'chair'), side)
      expect(chair.cls).toBe('solid')
      // the walker's centre runs along y = 7.5 (its 0.12 box clear of both wall faces); its disc is PLAYER_R
      for (let x = 3; x <= 6; x += 0.05) {
        const d = Math.hypot(x - chair.x, 7.5 - chair.y)
        expect(d).toBeGreaterThan(chair.r + PLAYER_R)
      }
    }
  })
})

describe('settleChunk', () => {
  it('classifies each record by its own cell, settles in place and returns the same array', () => {
    const sideFn = () => 1
    const list = [
      rec('prop', 'cabinet', 2.5, 3.5),      // corridor (walls E, W): hug E
      rec('prop', 'couch', 3.5, 4.5),        // corridor (walls N, S): hug N, clutter
      rec('prop', 'cone', 1.5, 1.5),         // room with a N wall: hugs it, solid
      rec('prop', 'papers', 6.5, 4.5),       // nook, but 'none': untouched
      rec('prop', 'box', 2.5, 4.5),          // junction with a W wall: hug W
    ]
    const out = settleChunk(list, gridFloor, footprintRadius, visualHalf, sideFn)
    expect(out).toBe(list)
    expect(list[0].hug).toBe('E'); expect(list[0].x).toBeCloseTo(3 - visualHalf('prop', 'cabinet') - HUG_GAP, 12); expect(list[0].cls).toBe('solid'); expect(list[0].cellCls).toBe('corridor')
    expect(list[1].hug).toBe('N'); expect(list[1].cls).toBe('clutter'); expect(list[1].cellCls).toBe('corridor')
    expect(list[2].hug).toBe('N'); expect(list[2].x).toBe(1.5); expect(list[2].y).toBeCloseTo(1 + visualHalf('prop', 'cone') + HUG_GAP, 12); expect(list[2].cellCls).toBe('room'); expect(list[2].cls).toBe('solid')
    expect(list[3].x).toBe(6.5); expect(list[3].y).toBe(4.5); expect(list[3].cls).toBe('none'); expect(list[3].cellCls).toBe('nook')
    expect(list[4].hug).toBe('W'); expect(list[4].cellCls).toBe('junction'); expect(list[4].cls).toBe('solid')
  })

  // FEEL-6: two solids hugging opposite walls of one 1-wide cell each pass the lane rule alone, but together close it
  const pairGap = (a, b) => 1 - (visualHalf(a.kind, a.type) + HUG_GAP + a.r) - (visualHalf(b.kind, b.type) + HUG_GAP + b.r)
  const bySide = (list, sides) => (p) => sides[list.indexOf(p)]

  it('two spools hugging opposite walls of one corridor cell: the later one becomes clutter, the lane stays open', () => {
    const list = [rec('prop', 'spool', 2.5, 3.5), rec('prop', 'spool', 2.5, 3.5)]   // corridor (walls E, W)
    settleChunk(list, gridFloor, footprintRadius, visualHalf, bySide(list, [1, -1]))
    expect(list[0].hug).toBe('E'); expect(list[1].hug).toBe('W')
    expect(pairGap(list[0], list[1])).toBeLessThan(2 * PLAYER_R + 0.02)
    expect(list[0].cls).toBe('solid'); expect(list[1].cls).toBe('clutter')
    // the positions are the hugged ones either way: only the class changes
    expect(list[1].x).toBeCloseTo(2 + visualHalf('prop', 'spool') + HUG_GAP, 12)
  })

  it('of two unequal bodies the smaller is demoted, whichever comes first', () => {
    for (const order of [['cabinet', 'spool'], ['spool', 'cabinet']]) {
      const list = order.map((t) => rec('prop', t, 3.5, 4.5))                       // corridor (walls N, S)
      settleChunk(list, gridFloor, footprintRadius, visualHalf, bySide(list, [1, -1]))
      expect(list.map((p) => p.hug)).toEqual(['N', 'S'])
      expect(pairGap(list[0], list[1])).toBeLessThan(2 * PLAYER_R + 0.02)
      for (const p of list) expect(p.cls, p.type).toBe(p.type === 'cabinet' ? 'clutter' : 'solid')
    }
  })

  it('a pair that leaves the player 2 PLAYER_R + 0.02 stays solid; same-wall pairs, other cells and rooms are untouched', () => {
    const pair = [rec('prop', 'cabinet', 2.5, 3.5), rec('prop', 'cabinet', 2.5, 3.5)]
    settleChunk(pair, gridFloor, footprintRadius, visualHalf, bySide(pair, [1, -1]))
    expect(pairGap(pair[0], pair[1])).toBeGreaterThanOrEqual(2 * PLAYER_R + 0.02)
    expect(pair.map((p) => p.hug)).toEqual(['E', 'W']); expect(pair.map((p) => p.cls)).toEqual(['solid', 'solid'])
    const same = [rec('prop', 'spool', 2.5, 3.5), rec('prop', 'spool', 2.5, 3.5)]
    settleChunk(same, gridFloor, footprintRadius, visualHalf, () => 1)
    expect(same.map((p) => p.hug)).toEqual(['E', 'E']); expect(same.map((p) => p.cls)).toEqual(['solid', 'solid'])
    const apart = [rec('prop', 'spool', 2.5, 7.5), rec('prop', 'spool', 3.5, 7.5)]   // neighbouring cells of one corridor
    settleChunk(apart, gridFloor, footprintRadius, visualHalf, bySide(apart, [1, -1]))
    expect(apart.map((p) => p.hug)).toEqual(['N', 'S']); expect(apart.map((p) => p.cls)).toEqual(['solid', 'solid'])
    const room = [rec('prop', 'spool', 1.5, 1.5), rec('prop', 'spool', 1.5, 1.5)]    // a room cell never has opposite walls
    settleChunk(room, gridFloor, footprintRadius, visualHalf, bySide(room, [1, -1]))
    expect(room.map((p) => p.cls)).toEqual(['solid', 'solid'])
  })

  it('a body already clutter or none does not count: the solid partner stays solid', () => {
    const list = [rec('prop', 'couch', 2.5, 3.5), rec('prop', 'spool', 2.5, 3.5), rec('prop', 'papers', 2.5, 3.5)]
    settleChunk(list, gridFloor, footprintRadius, visualHalf, bySide(list, [1, -1, 1]))
    expect(list[0].cls).toBe('clutter'); expect(list[1].cls).toBe('solid'); expect(list[2].cls).toBe('none')
  })

  it('an empty list is returned as is', () => {
    const list = []
    expect(settleChunk(list, gridFloor, footprintRadius, visualHalf, () => 1)).toBe(list)
  })
})
