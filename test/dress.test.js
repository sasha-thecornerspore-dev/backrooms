// dress.js — room dressing on the appended dress channel: findRooms over real generateChunk grids, the set rules (solids hug a real wall,
// never a doorway; centre pieces interior only), the pass through decor (appended, never shifting the scatter) and the reach gate with
// the pass on.
import { describe, it, expect } from 'vitest'
import {
  SETS, SETS_FOR_LEVEL, MAX_DRESSED_PROPS, findRooms, dressRoom, dressPass,
} from '../src/renderer/dress.js'
import { CHANNELS } from '../src/renderer/channels.js'
import { createDecorSystem } from '../src/renderer/decor.js'
import { levelConfig } from '../src/renderer/levels.js'
import { generateChunk, createChunkCache, createGridReader, CHUNK_SIZE, DEFAULT_CONFIG } from '../src/renderer/world.js'
import { PROP_SPEC, unitJitter } from '../src/renderer/gfx-sprites.js'
import { SOLID_CLASS } from '../src/renderer/collide.js'
import { wallSides } from '../src/renderer/placement.js'
import { walkable, cellsCovered, reachesSpot, loses } from '../src/renderer/reach.js'

const CS = CHUNK_SIZE
const HALL = CS >> 1
const key = (cx, cy) => `${cx},${cy}`
const isSolid = (type) => SOLID_CLASS[type] !== 'none'

// a floorFn over ONE generated chunk (anything outside it is wall), plus the raw grid
function chunkFloor(cx, cy, salt = 0, epoch = 0) {
  const g = generateChunk(cx, cy, epoch, { salt })
  const f = (ix, iy) => { const lx = ix - cx * CS, ly = iy - cy * CS; return lx >= 0 && ly >= 0 && lx < CS && ly < CS && g[ly * CS + lx] === 0 }
  f.grid = g
  return f
}
// a small deterministic rng for dressRoom unit cases (dressRoom takes any () -> [0, 1))
function xorshift(seed) {
  let s = Math.imul(seed | 0, 0x9E3779B1) | 1
  const next = () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 0xffffffff }
  next(); next()                                                              // past the warm-up, so small seeds differ in their first draw
  return next
}
// the decor hash (decor.js:17), copied so gated chunks can be told apart from outside
function hash(a, b, c = 0) {
  let h = (a * 2654435761 ^ b * 2246822519 ^ Math.imul(c, 3266489917)) >>> 0
  h ^= h >>> 16; h = Math.imul(h, 0x45d9f3b) >>> 0
  h ^= h >>> 16
  return h >>> 0
}
const openAround = (floorFn, wx, wy, h) => {
  for (let dy = -h; dy <= h; dy++) for (let dx = -h; dx <= h; dx++) if (!floorFn(wx + dx, wy + dy)) return false
  return true
}
const walled = (cfg, seed = 0) => {
  const cache = createChunkCache(cfg, seed)
  const isWall = (wx, wy, pcx, pcy) => cache.isWall(wx, wy, pcx, pcy)
  return { cache, isWall, grid: createGridReader(cache, isWall) }
}
const bundlesOf = (cfg, isWall, passes, seed = 0) => {
  const bundles = new Map()
  const sys = createDecorSystem(cfg, isWall, seed, passes ? { passes, onChunk: (k, b) => bundles.set(k, b) } : null)
  return { sys, bundles }
}
const LVL = (i, denom) => { const c = levelConfig(DEFAULT_CONFIG, i); return denom === undefined ? c : { ...c, dress: { denom } } }
const dressed = (p) => p.key.includes(':d')
const cellOf = (room, x, y) => room.cells.find((c) => c.wx === Math.floor(x) && c.wy === Math.floor(y))

describe('constants and sets', () => {
  it('MAX_DRESSED_PROPS is 8 and every set names existing PROP_SPEC types, one set per level 0-3', () => {
    expect(MAX_DRESSED_PROPS).toBe(8)
    expect(Object.keys(SETS).sort()).toEqual(['office', 'pump', 'storeroom', 'switch'])
    for (const s of Object.values(SETS)) {
      expect(s.types.length).toBeGreaterThan(0)
      for (const t of s.types) expect(PROP_SPEC[t], t).toBeTruthy()
      expect(typeof s.five).toBe('function'); expect(typeof s.three).toBe('function')
    }
    expect(SETS_FOR_LEVEL[0]).toBe(SETS.office)
    expect(SETS_FOR_LEVEL[1]).toBe(SETS.storeroom)
    expect(SETS_FOR_LEVEL[2]).toBe(SETS.pump)
    expect(SETS_FOR_LEVEL[3]).toBe(SETS.switch)
    expect(SETS_FOR_LEVEL['∅']).toBeUndefined()
    expect(Object.isFrozen(SETS)).toBe(true); expect(Object.isFrozen(SETS_FOR_LEVEL)).toBe(true)
  })
})

// chunk (3,-2) holds only 5x5 rooms once the hall filter has run; (0,1) holds both sizes
for (const [cx, cy] of [[3, -2], [0, 1]]) describe(`findRooms on generateChunk(${cx},${cy},0)`, () => {
  const floor = chunkFloor(cx, cy, 0)
  const rooms = findRooms(floor, cx, cy)
  const big5 = []   // every node whose 5x5 is fully open, from the grid alone
  for (let ly = 3; ly <= 17; ly += 2) for (let lx = 3; lx <= 17; lx += 2) if (openAround(floor, cx * CS + lx, cy * CS + ly, 2)) big5.push([cx * CS + lx, cy * CS + ly])
  const inside5 = (wx, wy) => big5.some(([bx, by]) => Math.abs(wx - bx) <= 2 && Math.abs(wy - by) <= 2)
  const hallAdjacent = (room) => {
    const h = room.size >> 1
    return room.cells.some((c) => {
      if (c.interior) return false
      const lx = c.wx - cx * CS, ly = c.wy - cy * CS
      return [[lx + 1, ly], [lx - 1, ly], [lx, ly + 1], [lx, ly - 1]].some(([nx, ny]) => nx === HALL || ny === HALL)
    }) && h >= 0
  }

  it('finds rooms, 5x5 first, each a node whose 3x3 / 5x5 is fully open and tagged with the chunk', () => {
    expect(rooms.length).toBeGreaterThan(0)
    expect(rooms.some((r) => r.size === 5)).toBe(true)
    if (cx === 0) expect(rooms.some((r) => r.size === 3)).toBe(true)
    let seen3 = false
    for (const r of rooms) {
      expect(r.cx).toBe(cx); expect(r.cy).toBe(cy)
      expect([3, 5]).toContain(r.size)
      if (r.size === 3) seen3 = true
      else expect(seen3).toBe(false)                                   // every 5x5 precedes every 3x3
      expect(r.cells).toHaveLength(r.size * r.size)
      const mid = r.cells[(r.cells.length - 1) >> 1]
      const lx = mid.wx - cx * CS, ly = mid.wy - cy * CS
      expect(lx % 2).toBe(1); expect(ly % 2).toBe(1)                    // a node cell
      expect(lx).toBeGreaterThanOrEqual(3); expect(lx).toBeLessThanOrEqual(17)
      expect(ly).toBeGreaterThanOrEqual(3); expect(ly).toBeLessThanOrEqual(17)
      expect(openAround(floor, mid.wx, mid.wy, r.size >> 1)).toBe(true)
      if (r.size === 3) expect(inside5(mid.wx, mid.wy)).toBe(false)      // a 3x3 is never inside a 5x5
      for (const c of r.cells) expect(floor(c.wx, c.wy)).toBe(true)
    }
    // dedupe by centre
    const centres = rooms.map((r) => { const m = r.cells[(r.cells.length - 1) >> 1]; return `${m.wx},${m.wy}` })
    expect(new Set(centres).size).toBe(centres.length)
  })

  it('is complete: every qualifying node is returned, and only those', () => {
    const want = []
    for (let ly = 3; ly <= 17; ly += 2) for (let lx = 3; lx <= 17; lx += 2) {
      const wx = cx * CS + lx, wy = cy * CS + ly
      if (openAround(floor, wx, wy, 2)) want.push([wx, wy, 5])
      else if (openAround(floor, wx, wy, 1) && !inside5(wx, wy)) want.push([wx, wy, 3])
    }
    // minus the hall-adjacent ones (checked on the perimeter cells of the would-be room)
    const touchesHall = (wx, wy, h) => {
      for (let dy = -h; dy <= h; dy++) for (let dx = -h; dx <= h; dx++) {
        if (Math.abs(dx) !== h && Math.abs(dy) !== h) continue
        const lx = wx + dx - cx * CS, ly = wy + dy - cy * CS
        if ([[lx + 1, ly], [lx - 1, ly], [lx, ly + 1], [lx, ly - 1]].some(([nx, ny]) => nx === HALL || ny === HALL)) return true
      }
      return false
    }
    const expected = want.filter(([wx, wy, s]) => !touchesHall(wx, wy, s >> 1)).map(([wx, wy, s]) => `${wx},${wy}:${s}`).sort()
    const got = rooms.map((r) => { const m = r.cells[(r.cells.length - 1) >> 1]; return `${m.wx},${m.wy}:${r.size}` }).sort()
    expect(got).toEqual(expected)
    expect(expected.length).toBeLessThan(want.length)                 // the hall filter did something here
  })

  it('door cells are exactly the perimeter cells with an open outward 4-neighbour; sides / interior / cornerWalls agree with the grid', () => {
    for (const r of rooms) {
      const h = r.size >> 1, mid = r.cells[(r.cells.length - 1) >> 1]
      for (const c of r.cells) {
        const dx = c.wx - mid.wx, dy = c.wy - mid.wy
        const perim = Math.abs(dx) === h || Math.abs(dy) === h
        expect(c.interior).toBe(!perim)
        expect(c.sides).toEqual({ N: !floor(c.wx, c.wy - 1), E: !floor(c.wx + 1, c.wy), S: !floor(c.wx, c.wy + 1), W: !floor(c.wx - 1, c.wy) })
        expect(c.cornerWalls).toBe((c.sides.N ? 1 : 0) + (c.sides.E ? 1 : 0) + (c.sides.S ? 1 : 0) + (c.sides.W ? 1 : 0))
        let outwardOpen = false
        if (dy === -h && floor(c.wx, c.wy - 1)) outwardOpen = true
        if (dy === h && floor(c.wx, c.wy + 1)) outwardOpen = true
        if (dx === -h && floor(c.wx - 1, c.wy)) outwardOpen = true
        if (dx === h && floor(c.wx + 1, c.wy)) outwardOpen = true
        expect(c.door, `${c.wx},${c.wy}`).toBe(perim && outwardOpen)
        if (!c.interior && !c.door) expect(c.cornerWalls).toBeGreaterThanOrEqual(1)
        if (c.interior) { expect(c.door).toBe(false); expect(c.cornerWalls).toBe(0) }
      }
      expect(r.cells.some((c) => c.door)).toBe(true)                   // every room has a way in
    }
  })

  it('no returned room has a perimeter cell adjacent to a hall cell', () => {
    for (const r of rooms) expect(hallAdjacent(r), `${r.cx},${r.cy} ${r.size}`).toBe(false)
  })

  it('rooms straddling the chunk edge are skipped: only nodes 3..17 are scanned and every cell stays inside the chunk interior', () => {
    for (const r of rooms) for (const c of r.cells) {
      const lx = c.wx - cx * CS, ly = c.wy - cy * CS
      expect(lx).toBeGreaterThanOrEqual(1); expect(lx).toBeLessThanOrEqual(CS - 2)
      expect(ly).toBeGreaterThanOrEqual(1); expect(ly).toBeLessThanOrEqual(CS - 2)
    }
    // a 3x3 open pocket in the chunk's corner (cells 0..2) is centred on node 1: never a room
    const corner = (ix, iy) => { const lx = ix - 5 * CS, ly = iy - 5 * CS; return lx >= 0 && lx <= 2 && ly >= 0 && ly <= 2 }
    expect(openAround(corner, 5 * CS + 1, 5 * CS + 1, 1)).toBe(true)
    expect(findRooms(corner, 5, 5)).toEqual([])
    // an all-open grid: 5x5 rooms at every node not touching the hall, nothing at node 1 or 19, no 3x3s (all inside a 5x5)
    const all = findRooms(() => true, 0, 0)
    expect(all.every((r) => r.size === 5)).toBe(true)
    const nodes = all.map((r) => { const m = r.cells[12]; return [m.wx, m.wy] })
    expect(nodes.length).toBe(25)
    for (const [x, y] of nodes) { expect([3, 5, 7, 15, 17]).toContain(x); expect([3, 5, 7, 15, 17]).toContain(y) }
    for (const r of all) for (const c of r.cells) if (!c.interior) expect(c.door).toBe(true)
  })

  it('reads only the chunk it is asked about', () => {
    const asked = []
    findRooms((ix, iy) => { asked.push([ix, iy]); return true }, 2, -1)
    for (const [ix, iy] of asked) {
      expect(ix).toBeGreaterThanOrEqual(2 * CS); expect(ix).toBeLessThan(3 * CS)
      expect(iy).toBeGreaterThanOrEqual(-1 * CS); expect(iy).toBeLessThan(0)
    }
  })
})

describe('dressRoom over all levels, 200 chunks', () => {
  const chunks = []
  for (const level of [0, 1, 2, 3]) {
    const salt = levelConfig(DEFAULT_CONFIG, level).maze.salt
    for (let i = 0; i < 50; i++) chunks.push({ level, cx: (i % 10) - 5, cy: Math.floor(i / 10) - 2, salt })
  }

  it('never places a solid record in a door cell or outside a wall-sided perimeter cell / an interior cell; 3x3 gets at most one solid; types exist; <= 8 per room', () => {
    let rooms5 = 0, rooms3 = 0, solids = 0, hugs = 0, centres = 0
    for (const { level, cx, cy, salt } of chunks) {
      const floor = chunkFloor(cx, cy, salt)
      const set = SETS_FOR_LEVEL[level]
      const rng = xorshift(cx * 7919 + cy * 104729 + level)
      for (const room of findRooms(floor, cx, cy)) {
        const recs = dressRoom(room, set, rng)
        expect(recs.length).toBeGreaterThan(0)
        expect(recs.length).toBeLessThanOrEqual(MAX_DRESSED_PROPS)
        expect(new Set(recs.map((r) => r.key)).size).toBe(recs.length)
        let solidN = 0
        for (const r of recs) {
          expect(r.key).toMatch(new RegExp(`^${cx},${cy}:d\\d+$`))
          expect(PROP_SPEC[r.type], r.type).toBeTruthy()
          expect(set.types).toContain(r.type)
          expect(r.rot).toBeGreaterThanOrEqual(0); expect(r.rot).toBeLessThan(Math.PI * 2)
          const cell = cellOf(room, r.x, r.y)
          expect(cell, `${r.type} at ${r.x},${r.y} is inside the room`).toBeTruthy()
          if (!isSolid(r.type)) continue
          solidN++; solids++
          expect(cell.door, `${r.type} in a door cell`).toBe(false)
          if (cell.interior) centres++
          else { expect(cell.cornerWalls).toBeGreaterThanOrEqual(1); hugs++ }
        }
        if (room.size === 3) { rooms3++; expect(solidN).toBeLessThanOrEqual(1) } else rooms5++
        // a room with no solid gets papers
        if (!solidN) expect(recs.some((r) => r.type === 'papers')).toBe(true)
      }
    }
    expect(rooms5).toBeGreaterThan(20); expect(rooms3).toBeGreaterThan(20)
    expect(solids).toBeGreaterThan(100); expect(hugs).toBeGreaterThan(50); expect(centres).toBeGreaterThan(20)
  })

  it('is a pure function of (room, set, rng stream)', () => {
    const floor = chunkFloor(3, -2, 0)
    const rooms = findRooms(floor, 3, -2)
    const a = rooms.map((r) => dressRoom(r, SETS.office, xorshift(5)))
    const b = rooms.map((r) => dressRoom(r, SETS.office, xorshift(5)))
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })

  it('a piece dressed against one wall of a two-wall corner leans on that wall (its rot parity picks the side decor.sideFn hugs)', () => {
    // a 5x5 room with doors only along the S edge: the N run spans the whole edge, the NW / NE corners are two-wall corners
    const G = [
      '#######',
      '#.....#',
      '#.....#',
      '#.....#',
      '#.....#',
      '#.....#',
      '#..#..#',
    ]
    const floor = (ix, iy) => G[iy]?.[ix] === '.'
    // the room is centred on (3, 3); build it the way findRooms does, by hand, so the node-scan rules do not get in the way
    const cells = []
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const wx = 3 + dx, wy = 3 + dy
      const sides = { N: !floor(wx, wy - 1), E: !floor(wx + 1, wy), S: !floor(wx, wy + 1), W: !floor(wx - 1, wy) }
      const perim = Math.abs(dx) === 2 || Math.abs(dy) === 2
      const door = perim && ((dy === -2 && !sides.N) || (dy === 2 && !sides.S) || (dx === -2 && !sides.W) || (dx === 2 && !sides.E))
      cells.push({ wx, wy, sides, door, interior: !perim, cornerWalls: (sides.N ? 1 : 0) + (sides.E ? 1 : 0) + (sides.S ? 1 : 0) + (sides.W ? 1 : 0) })
    }
    const room = { cx: 0, cy: 0, size: 5, cells }
    // the storeroom cluster: three crates in a two-wall corner, two leaning on the N/S wall, one on the E/W wall
    let found = 0
    for (let seed = 1; seed < 40; seed++) {
      const recs = dressRoom(room, SETS.storeroom, xorshift(seed)).filter((r) => r.type === 'crate')
      if (recs.length !== 3) continue
      found++
      const c = cellOf(room, recs[0].x, recs[0].y)
      expect(c.cornerWalls).toBe(2)
      const first = ['N', 'E', 'S', 'W'].find((s) => c.sides[s])          // decor.sideFn: +1 leans on the first wall in N,E,S,W order
      const leansOn = (r) => (unitJitter(r.rot, 23) < 0 ? -1 : 1) > 0 ? first : ['N', 'E', 'S', 'W'].filter((s) => c.sides[s]).at(-1)
      const ns = c.sides.N ? 'N' : 'S', ew = c.sides.E ? 'E' : 'W'
      expect(leansOn(recs[0])).toBe(ns); expect(leansOn(recs[1])).toBe(ns); expect(leansOn(recs[2])).toBe(ew)
      expect(Math.abs(recs[1].x - recs[0].x)).toBeCloseTo(0.45, 12); expect(recs[1].y).toBe(recs[0].y)
      expect(Math.abs(recs[2].y - recs[0].y)).toBeCloseTo(0.45, 12); expect(recs[2].x).toBe(recs[0].x)
    }
    expect(found).toBeGreaterThan(5)
  })
})

describe('dressPass', () => {
  it('is null when cfg.dress is absent, denom 0, or the level has no set', () => {
    expect(dressPass(LVL(0, 0))).toBeNull()
    expect(dressPass({ ...LVL(0), dress: undefined })).toBeNull()
    expect(dressPass({ ...LVL(0), dress: {} })).toBeNull()
    expect(dressPass(LVL(4, 2))).toBeNull()                                   // Level ∅ has no set
    expect(typeof dressPass(LVL(0, 2))).toBe('function')
    expect(typeof dressPass(LVL(3))).toBe('function')                         // levels.js ships a denom
  })

  it('draws its gate and rng constants from channels.js dress, and consumes nothing else of the ctx streams', () => {
    const cfg = LVL(2, 3)
    const pass = dressPass(cfg)
    const calls = { hash: [], rng: [] }
    const ctx = {
      cx: 4, cy: -7, key: '4,-7', pcx: 0, pcy: 0, salt: cfg.maze.salt, seed: 99, cfg,
      isWall: () => true,
      hash: (...a) => { calls.hash.push(a); return 0 },                     // 0 % denom === 0: the gate opens
      rngFrom: (...a) => { calls.rng.push(a); return xorshift(1) },
      openCell: () => { throw new Error('dress must not use openCell') },
      add: () => {},
    }
    pass(ctx)
    const [ga, gb] = CHANNELS.dress.gate, [mx, ax, my, ay] = CHANNELS.dress.rng
    expect(calls.hash).toEqual([[4 + ga + cfg.maze.salt, -7 + gb + cfg.maze.salt, 99]])
    expect(calls.rng).toEqual([[4 * mx + cfg.maze.salt + ax, -7 * my + cfg.maze.salt + ay, 99]])
    expect([ga, gb, mx, ax, my, ay]).toEqual([7307, 1511, 359, 19, 947, 61])
    // a closed gate draws no rng at all
    calls.rng.length = 0
    pass({ ...ctx, hash: () => 1 })
    expect(calls.rng).toEqual([])
  })

  for (const seed of [0, 424242]) {
    it(`seed ${seed}: denom 0 is byte-identical to today's output; denom 2 appends ':d' records and shifts nothing`, () => {
      const base = LVL(0)
      const { isWall } = walled(base, seed)
      const plain = createDecorSystem(base, isWall, seed); plain.update(0, 0)
      const off = bundlesOf(base, isWall, [dressPass(LVL(0, 0))].filter(Boolean), seed); off.sys.update(0, 0)
      for (const g of ['getProps', 'getExits', 'getNpcs', 'getScraps', 'getMachines', 'getSights', 'getStairs']) {
        expect(JSON.stringify(off.sys[g]()), g).toBe(JSON.stringify(plain[g]()))
      }
      const cfg = LVL(0, 2)
      const on = bundlesOf(cfg, walled(cfg, seed).isWall, [dressPass(cfg)], seed); on.sys.update(0, 0)
      for (const g of ['getExits', 'getNpcs', 'getScraps', 'getMachines', 'getSights', 'getStairs']) {
        expect(JSON.stringify(on.sys[g]()), g).toBe(JSON.stringify(plain[g]()))
      }
      const mine = on.sys.getProps().filter(dressed)
      expect(JSON.stringify(on.sys.getProps().filter((p) => !dressed(p)))).toBe(JSON.stringify(plain.getProps()))
      expect(mine.length).toBeGreaterThan(8)
      let dressedChunks = 0
      for (const [k, b] of on.bundles) {
        const [cx, cy] = k.split(',').map(Number)
        const d = b.props.filter(dressed)
        expect(d.length).toBeLessThanOrEqual(MAX_DRESSED_PROPS)
        const plainN = b.props.length - d.length
        expect(b.props.slice(0, plainN).some(dressed)).toBe(false)             // appended after the scatter
        d.forEach((p, i) => expect(p.key).toBe(`${k}:d${i}`))
        if (d.length) { dressedChunks++; expect(hash(cx + 7307 + (cfg.maze.salt | 0), cy + 1511 + (cfg.maze.salt | 0), seed) % 2).toBe(0) }
        for (const p of d) { expect(Math.floor(p.x / CS)).toBe(cx); expect(Math.floor(p.y / CS)).toBe(cy) }
      }
      expect(dressedChunks).toBeGreaterThan(3)
      // pure: a second system over the same walls agrees byte for byte
      const again = bundlesOf(cfg, walled(cfg, seed).isWall, [dressPass(cfg)], seed); again.sys.update(0, 0)
      expect(JSON.stringify(again.sys.getProps())).toBe(JSON.stringify(on.sys.getProps()))
    })
  }

  it('dressed records are settled like any prop: solids hug the room wall they were dressed against, or stand in interior cells', () => {
    for (const level of [0, 1, 2, 3]) {
      const cfg = LVL(level)
      const { isWall, grid } = walled(cfg, 0)
      const { sys, bundles } = bundlesOf(cfg, isWall, [dressPass(cfg)], 0)
      sys.update(0, 0)
      grid.setPlayerChunk(0, 0)
      let hugged = 0, interior = 0
      for (const [k, b] of bundles) {
        const d = b.colliders.filter((c) => c.kind === 'prop' && c.key.includes(':d'))
        if (!d.length) continue
        const [cx, cy] = k.split(',').map(Number)
        const rooms = findRooms(grid.floor, cx, cy)
        // two 5x5s can overlap (a 5x7 open area): a cell that is one room's walled perimeter is the other's doorway, so the piece is
        // judged by the dressed room (one of the first MAX_ROOMS) in which its cell is interior or a non-door perimeter cell
        const sides = (c) => wallSides(grid.floor, c.x, c.y)
        for (const c of d) {
          expect(c.cellCls).toBe('room')
          expect(SETS_FOR_LEVEL[level].types).toContain(c.type)
          const inRooms = rooms.slice(0, 2).filter((r) => cellOf(r, c.x, c.y))
          expect(inRooms.length, `${c.key} ${c.type} lies in a dressed room`).toBeGreaterThan(0)
          if (c.cls === 'none') continue
          expect(c.cls).toBe('solid')
          const cells = inRooms.map((r) => cellOf(r, c.x, c.y))
          const ok = cells.find((cell) => cell.interior || !cell.door)
          expect(ok, `${c.key} ${c.type} at ${c.x},${c.y}: in a doorway`).toBeTruthy()
          if (ok.interior) { interior++; expect(c.hug).toBeNull() }
          else { hugged++; expect(c.hug).toMatch(/^[NESW]$/); expect(ok.sides[c.hug]).toBe(true); expect(sides(c)[c.hug]).toBe(true) }
        }
      }
      expect(hugged, `level ${level}`).toBeGreaterThan(3)
      if (level !== 1) expect(interior, `level ${level}`).toBeGreaterThan(0)
    }
  })

  it('at most two rooms are dressed per chunk, the 5x5s first, under the 8-record cap', () => {
    const cfg = LVL(0, 1)                                                       // every chunk gated open
    const { isWall, grid } = walled(cfg, 0)
    const { sys, bundles } = bundlesOf(cfg, isWall, [dressPass(cfg)], 0)
    sys.update(0, 0)
    grid.setPlayerChunk(0, 0)
    let multi = 0
    for (const [k, b] of bundles) {
      const d = b.props.filter(dressed)
      const [cx, cy] = k.split(',').map(Number)
      const rooms = findRooms(grid.floor, cx, cy)
      const touched = new Set(d.map((p) => rooms.findIndex((r) => cellOf(r, p.x, p.y))))
      expect(touched.has(-1)).toBe(false)
      expect(touched.size).toBeLessThanOrEqual(2)
      for (const i of touched) expect(i).toBeLessThan(2)                        // the first two in findRooms order (5x5 first)
      if (touched.size === 2) multi++
      expect(d.length).toBeLessThanOrEqual(MAX_DRESSED_PROPS)
      if (rooms.length) expect(d.length).toBeGreaterThan(0)
    }
    expect(multi).toBeGreaterThan(0)
  })
})

// ── the reach gate with the dress pass on (mirrors test/reach.test.js scanLevel / gateChunk) ─────────────────────────────────
describe('the reach gate with the dress pass on', () => {
  function scan(index, seed, n) {
    const cfg = LVL(index)
    const { isWall, grid } = walled(cfg, seed)
    const { sys, bundles } = bundlesOf(cfg, isWall, [dressPass(cfg)].filter(Boolean), seed)
    sys.update(0, 0)
    return { grid, chunks: [...bundles.keys()].slice(0, n).map((k) => {
      const [cx, cy] = k.split(',').map(Number)
      const colliders = []
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const b = bundles.get(key(cx + dx, cy + dy)); if (b) colliders.push(...b.colliders) }
      return { cx, cy, colliders, own: bundles.get(k) }
    }) }
  }
  for (const index of [0, 1, 2, 3]) {
    it(`level ${index}: no reachability loss, every door cell and every dressed prop stays reachable`, () => {
      const { grid, chunks } = scan(index, 0, 36)
      let dressedN = 0, doors = 0
      for (const c of chunks) {
        grid.setPlayerChunk(c.cx, c.cy)
        const ox = c.cx * CS + CS / 2 + 0.5, oy = c.cy * CS + CS / 2 + 0.5
        const before = walkable(grid.floor, [], ox, oy)
        const after = walkable(grid.floor, c.colliders, ox, oy)
        expect(loses(before, after), `chunk ${c.cx},${c.cy}: cells sealed`).toEqual([])
        const cells = cellsCovered(after)
        const d = c.own.props.filter(dressed)
        if (!d.length) continue
        dressedN += d.length
        for (const p of d) expect(reachesSpot(after, p.x, p.y, 1.5), `${p.key} ${p.type}`).toBe(true)
        const rooms = findRooms(grid.floor, c.cx, c.cy)
        for (const r of rooms.slice(0, 2)) for (const cell of r.cells) if (cell.door) { doors++; expect(cells.has(key(cell.wx, cell.wy)), `door ${cell.wx},${cell.wy}`).toBe(true) }
      }
      expect(dressedN).toBeGreaterThan(4)
      expect(doors).toBeGreaterThan(4)
    })
  }
})
