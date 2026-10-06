// reach.js — the walkable flood (0.12 AABB vs walls, PLAYER_R + 0.02 vs solid bodies) and the reach gate: settling furniture
// against real generateChunk grids never seals a cell, a border passage, or anything you need to stand next to.
import { describe, it, expect } from 'vitest'
import { walkable, cellsCovered, reachesSpot, loses } from '../src/renderer/reach.js'
import { createDecorSystem } from '../src/renderer/decor.js'
import { createItemSystem } from '../src/renderer/items.js'
import { levelConfig } from '../src/renderer/levels.js'
import { createChunkCache, createGridReader, CHUNK_SIZE, DEFAULT_CONFIG } from '../src/renderer/world.js'
import { createFixedMap } from '../src/renderer/fixedmap.js'
import { NULL_MAP, NULL_SPAWN, NULL_EXIT } from '../src/renderer/level-null-map.js'
import { PLAYER_R, createColliderIndex, createSolidWorld } from '../src/renderer/collide.js'
import { waysFor, stairsPass } from '../src/renderer/topology.js'
import { dressPass } from '../src/renderer/dress.js'

// the gate runs with the passes game.js runs: the stairs up / the lift (never bodies, but spots that must stay reachable) and the room
// dressing (solids that must seal nothing); built per level, as buildLevel does (the haunts pass places no body and no spot)
const passesFor = (cfg, index) => [stairsPass(cfg, waysFor(index)), dressPass(cfg)].filter(Boolean)
const CS = CHUNK_SIZE
const key = (cx, cy) => `${cx},${cy}`
const chunkOf = (x, y) => key(Math.floor(x / CS), Math.floor(y / CS))

// a 9x9 grid for the unit cases ('#' wall, '.' open)
const GRID = [
  '#########',
  '#.......#',
  '#.#####.#',
  '#.#...#.#',
  '#.#.#.#.#',
  '#.#.#...#',
  '#.#.#####',
  '#.......#',
  '#########',
]
const gridFloor = (ix, iy) => GRID[iy]?.[ix] === '.'
const B9 = { x0: 0, y0: 0, x1: 9, y1: 9 }
const solid = (x, y, r, over = {}) => ({ id: 1, x, y, r, cls: 'solid', kind: 'prop', type: 'crate', key: 'k', cx: 0, cy: 0, cellCls: null, hug: null, ...over })

describe('walkable on a small grid', () => {
  it('covers exactly the open cells reachable from the origin with the 0.12 box, and the mask knows its geometry', () => {
    const m = walkable(gridFloor, [], 1.5, 1.5, B9)
    expect(m).toBeInstanceOf(Uint8Array)
    expect(m.length).toBe(72 * 72)
    const cells = cellsCovered(m)
    for (let y = 0; y < 9; y++) for (let x = 0; x < 9; x++) expect(cells.has(key(x, y)), key(x, y)).toBe(gridFloor(x, y))
    // the band a 0.12 box can stand in inside a 1-wide corridor is [k + 0.12, k + 0.88]: 6 of the 8 samples per axis
    expect(reachesSpot(m, 1.5, 4.5, 0.1)).toBe(true)
    expect(reachesSpot(m, 1.06, 4.5, 0.05)).toBe(false)
  })

  it('a solid body blocks samples within r + PLAYER_R + 0.02; clutter and none do not', () => {
    // the inner pocket (3..5, 3..5) has two mouths, the straight cells (3, 6) and (6, 5); a solid at each centre (blocked radius
    // .38 in a band .76 wide) seals it, while the mouth cells themselves stay covered from the outside
    const mouths = [solid(3.5, 6.5, 0.2), solid(6.5, 5.5, 0.2, { id: 2 })]
    const before = walkable(gridFloor, [], 1.5, 1.5, B9)
    const after = walkable(gridFloor, mouths, 1.5, 1.5, B9)
    expect(reachesSpot(after, 3.5, 6.5, PLAYER_R + 0.2 + 0.02 - 1e-6)).toBe(false)
    expect(reachesSpot(before, 3.5, 6.5, 0.1)).toBe(true)
    const lost = loses(before, after)
    expect(lost.sort()).toEqual(['3,3', '3,4', '3,5', '4,3', '5,3', '5,4', '5,5'].sort())
    const cells = cellsCovered(after)
    expect(cells.has('3,6')).toBe(true); expect(cells.has('6,5')).toBe(true)
    const as = (cls, type = 'crate') => mouths.map((m) => ({ ...m, cls, type }))
    expect(loses(before, walkable(gridFloor, as('clutter'), 1.5, 1.5, B9))).toEqual([])
    expect(loses(before, walkable(gridFloor, as('none', 'papers'), 1.5, 1.5, B9))).toEqual([])
  })

  it('a body sitting on the origin sample does not kill the flood: it starts from the nearest free sample', () => {
    const m = walkable(gridFloor, [solid(1.5, 1.5, 0.1)], 1.5, 1.5, B9)
    expect(cellsCovered(m).size).toBeGreaterThan(20)
    expect(reachesSpot(m, 1.5, 1.5, PLAYER_R + 0.1 + 0.02 - 1e-6)).toBe(false)
  })

  it('default bounds are the chunk under the origin plus a one-cell border', () => {
    const m = walkable(() => true, [], 11.5, 11.5)
    expect(m.length).toBe((CS + 2) * 8 * (CS + 2) * 8)
    const cells = cellsCovered(m)
    expect(cells.has(key(-1, -1))).toBe(true)
    expect(cells.has(key(CS, CS))).toBe(true)
    expect(cells.has(key(-2, 0))).toBe(false)
  })

  it('loses() is empty for identical masks and lists cells in the before set only', () => {
    const a = walkable(gridFloor, [], 1.5, 1.5, B9)
    expect(loses(a, a)).toEqual([])
    const none = walkable(() => false, [], 1.5, 1.5, B9)
    expect(cellsCovered(none).size).toBe(0)
    expect(loses(a, none).length).toBe(cellsCovered(a).size)
  })
})

// ── the gate over real levels ───────────────────────────────────────────────────────────────────────────────────────────
// Scans the real chunk world of a level with the decor system (settling on), collects every placed thing per chunk and returns
// the first `n` chunks (the scan order is deterministic) with their colliders and spots.
function scanLevel(index, seed, n) {
  const cfg = levelConfig(DEFAULT_CONFIG, index)
  cfg.ways = waysFor(index)
  const cache = createChunkCache(cfg, seed)
  const isWall = (wx, wy, pcx, pcy) => cache.isWall(wx, wy, pcx, pcy)
  const grid = createGridReader(cache, isWall)
  const bundles = new Map()
  const decor = createDecorSystem(cfg, isWall, seed, { passes: passesFor(cfg, index), onChunk: (k, b) => bundles.set(k, b) })
  const items = createItemSystem(cfg, isWall, seed)
  items.enterLevel(cfg)
  const spots = new Map()   // chunk key -> [{ x, y, radius, what }]
  const spot = (o, radius, what) => { const k = chunkOf(o.x, o.y); if (!spots.has(k)) spots.set(k, []); spots.get(k).push({ x: o.x, y: o.y, radius, what: `${what} ${o.key}` }) }
  const seen = new Set()
  const take = (list, radius, what) => { for (const o of list) { if (seen.has(`${what}:${o.key}`)) continue; seen.add(`${what}:${o.key}`); spot(o, radius, what) } }
  for (const [px, py] of [[0, 0], [0, 7]]) {
    decor.update(px, py); items.update(px, py)
    take(decor.getExits(), 1.6, 'exit'); take(decor.getStairs(), 1.6, 'stair'); take(items.getWorldItems(), 1.4, 'item')
    take(decor.getScraps(), 1.8, 'scrap'); take(decor.getMachines(), 1.6, 'machine'); take(decor.getNpcs(), 1.8, 'npc')
    take(decor.getProps(), 1.5, 'prop')
  }
  const chunks = [...bundles.keys()].slice(0, n).map((k) => {
    const [cx, cy] = k.split(',').map(Number)
    const colliders = []
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const b = bundles.get(key(cx + dx, cy + dy)); if (b) colliders.push(...b.colliders) }
    return { cx, cy, colliders, own: bundles.get(k).colliders, spots: spots.get(k) ?? [] }
  })
  return { cfg, grid, chunks }
}

function gateChunk(grid, c) {
  grid.setPlayerChunk(c.cx, c.cy)
  const ox = c.cx * CS + CS / 2 + 0.5, oy = c.cy * CS + CS / 2 + 0.5        // the hall crossing (local 11, 11)
  const before = walkable(grid.floor, [], ox, oy)
  const after = walkable(grid.floor, c.colliders, ox, oy)
  const lost = loses(before, after)
  expect(lost, `chunk ${c.cx},${c.cy}: cells sealed by settling`).toEqual([])
  const cells = cellsCovered(after)
  for (const [x, y] of [[CS / 2, 0], [CS / 2, CS - 1], [0, CS / 2], [CS - 1, CS / 2]]) {
    expect(cells.has(key(c.cx * CS + x, c.cy * CS + y)), `chunk ${c.cx},${c.cy}: border midpoint ${x},${y}`).toBe(true)
  }
  for (const s of c.spots) expect(reachesSpot(after, s.x, s.y, s.radius), `chunk ${c.cx},${c.cy}: ${s.what} at ${s.x},${s.y}`).toBe(true)
  return { before, after }
}

describe('the reach gate', () => {
  for (const index of [0, 1, 2, 3]) {
    it(`level ${index}, 60 chunks, seed 0: nothing sealed, border passages open, every spot reachable`, () => {
      const { chunks, grid } = scanLevel(index, 0, 60)
      expect(chunks.length).toBe(60)
      let bodies = 0, spots = 0
      for (const c of chunks) { gateChunk(grid, c); bodies += c.own.length; spots += c.spots.length }
      expect(bodies).toBeGreaterThan(60)
      expect(spots).toBeGreaterThan(60)
    })
  }

  it('levels 0-3, 20 chunks each, seed 424242', () => {
    for (const index of [0, 1, 2, 3]) {
      const { chunks, grid } = scanLevel(index, 424242, 20)
      expect(chunks.length).toBe(20)
      for (const c of chunks) gateChunk(grid, c)
    }
  })

  it('the gate is not vacuous: level 0 settles dozens of hugged solid bodies into corridors and nooks', () => {
    const { chunks } = scanLevel(0, 0, 60)
    let hugged = 0, clutter = 0
    for (const c of chunks) for (const b of c.own) {
      if (b.hug && b.cls === 'solid' && (b.cellCls === 'corridor' || b.cellCls === 'nook')) hugged++
      if (b.cls === 'clutter' && b.kind === 'prop') clutter++
    }
    expect(hugged).toBeGreaterThan(10)
    expect(clutter).toBe(0)                     // the lobby's prop set has nothing wider than a plant (only a sight can be clutter here)
  })

  // FEEL-6: two spools hugging opposite walls of one 1-wide cell each passed the lane rule but together left 0.238 u. The flood
  // never noticed (the cells past them stay reachable the long way round), so this walks the real mover down the corridor.
  it('level 3, seed 2654435761, chunk (-1,-2): the real mover walks the N-S corridor past the cell (-21,-28)', () => {
    const seed = 2654435761
    const cfg = levelConfig(DEFAULT_CONFIG, 3)
    cfg.ways = waysFor(3)
    const cache = createChunkCache(cfg, seed)
    const isWall = (wx, wy, pcx, pcy) => cache.isWall(wx, wy, pcx, pcy)
    const grid = createGridReader(cache, isWall)
    const index = createColliderIndex()
    const decor = createDecorSystem(cfg, isWall, seed, {
      passes: passesFor(cfg, 3), onChunk: (k, b) => index.setChunk(k, b.colliders), onEvict: (k) => index.dropChunk(k),
    })
    grid.setPlayerChunk(-1, -2); decor.update(-1, -2)
    for (let y = -30; y <= -26; y++) expect(grid.floor(-21, y), `cell -21,${y}`).toBe(true)
    expect(grid.floor(-22, -28)).toBe(false); expect(grid.floor(-20, -28)).toBe(false)
    const Q = []
    const n = index.query(-20.5, -27.5, 0.5, Q)
    const inCell = Q.slice(0, n).filter((c) => Math.floor(c.x) === -21 && Math.floor(c.y) === -28 && c.cls !== 'none')
    expect(inCell.map((c) => c.type).sort()).toEqual(['spool', 'spool'])
    expect(inCell.map((c) => c.hug).sort()).toEqual(['E', 'W'])
    expect(inCell.filter((c) => c.cls === 'solid')).toHaveLength(1)
    for (const wig of [0, 0.4, 0.9, -0.4, -0.9]) {
      const solid = createSolidWorld({ index, floorFn: grid.floor, solidCreature: () => false })
      const p = { x: -20.5, y: -29.5 }
      let reached = false
      for (let f = 0; f < 900 && !reached; f++) {
        const ang = Math.atan2(-25.5 - p.y, -20.5 - p.x) + wig * Math.sin(f / 7)
        solid.movePlayer(p, p.x + Math.cos(ang) * 0.05, p.y + Math.sin(ang) * 0.05, 1 / 60, false, [])
        reached = Math.floor(p.x) === -21 && Math.floor(p.y) === -26
      }
      expect(reached, `wiggle ${wig}: stopped at ${p.x.toFixed(2)},${p.y.toFixed(2)}`).toBe(true)
    }
  })

  it('NULL_MAP: spawn -> exit reachable with the 0.12 AABB and Level ∅ props are solid', () => {
    const cfg = levelConfig(DEFAULT_CONFIG, 4)
    expect(cfg.map).toBe(NULL_MAP)
    const fixed = createFixedMap(NULL_MAP)
    const isWall = (wx, wy) => fixed.isWall(wx, wy)
    const grid = createGridReader(null, isWall)
    const bundles = new Map()
    const decor = createDecorSystem(cfg, isWall, 0, { passes: [], onChunk: (k, b) => bundles.set(k, b) })
    decor.update(0, 0)
    const colliders = [...bundles.values()].flatMap((b) => b.colliders)
    expect(colliders.length).toBeGreaterThan(0)
    expect(colliders.some((c) => c.cls === 'solid')).toBe(true)
    for (const c of colliders) if (c.cls !== 'none') expect(c.cls, c.type).toBe('solid')
    const bounds = { x0: 0, y0: 0, x1: NULL_MAP[0].length, y1: NULL_MAP.length }
    const mask = walkable(grid.floor, colliders, NULL_SPAWN.x, NULL_SPAWN.y, bounds)
    expect(cellsCovered(mask).has(key(Math.floor(NULL_EXIT.x), Math.floor(NULL_EXIT.y)))).toBe(true)
    expect(reachesSpot(mask, NULL_EXIT.x, NULL_EXIT.y, 1.6)).toBe(true)
    const exits = decor.getExits()
    expect(exits).toHaveLength(1)
    expect(reachesSpot(mask, exits[0].x, exits[0].y, 1.6)).toBe(true)
  })
})
