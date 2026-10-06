// decor.js — the pass pipeline (hooks.passes after the sights block, hooks.onChunk / onEvict), the settled bodies, the stairs list
// and the way / prop getters this release adds. The open-grid goldens live in decor.test.js and stay byte-identical.
import { describe, it, expect, vi } from 'vitest'
import { createDecorSystem, SIGHT_TYPES } from '../src/renderer/decor.js'
import { levelConfig } from '../src/renderer/levels.js'
import { createChunkCache, createGridReader, CHUNK_SIZE, DEFAULT_CONFIG } from '../src/renderer/world.js'
import { footprintRadius, visualHalf } from '../src/renderer/collide.js'
import { wallSides, HUG_GAP } from '../src/renderer/placement.js'
import { unitJitter } from '../src/renderer/gfx-sprites.js'

const open = () => false
const solid = () => true
const CS = CHUNK_SIZE
// denser sights than shipping so every scan has some to assert on
const L0 = { ...levelConfig(DEFAULT_CONFIG, 0), sights: { denom: 4 } }
// the decor hash (decor.js:17), copied so the chunk-parity side rule can be checked from outside
function hash(a, b, c = 0) {
  let h = (a * 2654435761 ^ b * 2246822519 ^ Math.imul(c, 3266489917)) >>> 0
  h ^= h >>> 16; h = Math.imul(h, 0x45d9f3b) >>> 0
  h ^= h >>> 16
  return h >>> 0
}
const walled = (cfg = L0, seed = 0) => {
  const cache = createChunkCache(cfg, seed)
  const isWall = (wx, wy, pcx, pcy) => cache.isWall(wx, wy, pcx, pcy)
  return { cache, isWall, grid: createGridReader(cache, isWall) }
}
const bundlesOf = (cfg, isWall, hooks = {}, seed = 0) => {
  const bundles = new Map()
  const sys = createDecorSystem(cfg, isWall, seed, { ...hooks, onChunk: (k, b) => bundles.set(k, b) })
  return { sys, bundles }
}
// a pass that adds one crate per chunk from its own rng channel, and a stair in every third chunk
const dress = (ctx) => {
  const rng = ctx.rngFrom(ctx.cx * 359 + ctx.salt + 19, ctx.cy * 947 + ctx.salt + 61, ctx.seed)
  const spot = ctx.openCell(rng)
  if (spot) ctx.add('prop', { key: `${ctx.key}:dress0`, x: spot.wx, y: spot.wy, type: 'crate', rot: rng() * Math.PI * 2 })
}
const stairs = (ctx) => {
  if ((((ctx.cx + ctx.cy) % 3) + 3) % 3 !== 0) return
  const rng = ctx.rngFrom(ctx.cx * 1013 + ctx.salt + 13, ctx.cy * 569 + ctx.salt + 31, ctx.seed)
  const spot = ctx.openCell(rng)
  if (spot) ctx.add('stair', { key: `${ctx.key}:up`, x: spot.wx, y: spot.wy, kind: 'up', target: 3, label: 'the stairwell up' })
}

describe('hooks.passes', () => {
  it('a pass runs once per placed chunk with the documented ctx', () => {
    const seen = []
    const sys = createDecorSystem(L0, open, 7, { passes: [(ctx) => seen.push(ctx)] })
    sys.update(0, 0)
    expect(seen).toHaveLength(49)
    const ctx = seen.find((c) => c.cx === 2 && c.cy === -3)
    expect(ctx).toBeTruthy()
    expect(ctx.key).toBe('2,-3')
    expect(ctx.pcx).toBe(0); expect(ctx.pcy).toBe(0)
    expect(ctx.salt).toBe(L0.maze.salt | 0)
    expect(ctx.seed).toBe(7)
    expect(ctx.cfg).toBe(L0)
    expect(typeof ctx.isWall).toBe('function'); expect(ctx.isWall(2 * CS + 3.5, -3 * CS + 4.5)).toBe(false)
    expect(typeof ctx.hash).toBe('function'); expect(ctx.hash(11, 13, 7)).toBe(ctx.hash(11, 13, 7)); expect(ctx.hash(11, 13, 7)).toBe(hash(11, 13, 7))
    expect(typeof ctx.rngFrom).toBe('function')
    const r = ctx.rngFrom(1, 2, 7); const v = r(); expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThan(1)
    expect(ctx.rngFrom(1, 2, 7)()).toBe(v)
    const spot = ctx.openCell(ctx.rngFrom(5, 6, 7))
    expect(Math.floor(spot.wx / CS)).toBe(2); expect(Math.floor(spot.wy / CS)).toBe(-3)
    expect(spot.wx % 1).toBeCloseTo(0.5, 12)
    expect(typeof ctx.add).toBe('function')
  })

  it('ctx.isWall is bound to the scan chunk and ctx.openCell retries over walls (none on a solid grid)', () => {
    const asked = []
    const sys = createDecorSystem(L0, (wx, wy, pcx, pcy) => { asked.push([pcx, pcy]); return true }, 0, { passes: [(ctx) => { expect(ctx.openCell(ctx.rngFrom(1, 1))).toBeNull() }] })
    sys.update(4, -2)
    expect(asked.length).toBeGreaterThan(0)
    for (const [pcx, pcy] of asked) { expect(pcx).toBe(4); expect(pcy).toBe(-2) }
  })

  it("add('prop') records appear in getProps() AFTER the scatter props with the scatter list unchanged", () => {
    const plain = bundlesOf(L0, open)
    const dressed = bundlesOf(L0, open, { passes: [dress] })
    plain.sys.update(0, 0); dressed.sys.update(0, 0)
    expect(plain.bundles.size).toBe(49)
    for (const [k, a] of plain.bundles) {
      const b = dressed.bundles.get(k)
      expect(b.props.length).toBe(a.props.length + 1)
      expect(b.props.slice(0, a.props.length)).toEqual(a.props)              // appended, never shifted
      expect(b.props.at(-1).key).toBe(`${k}:dress0`)
      expect(b.props.at(-1).type).toBe('crate')
    }
    const got = dressed.sys.getProps()
    expect(got.filter((p) => p.key.endsWith(':dress0'))).toHaveLength(49)
    expect(got.length).toBe(plain.sys.getProps().length + 49)
    // the pass's rng is its own: nothing else moved
    expect(dressed.sys.getExits()).toEqual(plain.sys.getExits())
    expect(dressed.sys.getNpcs()).toEqual(plain.sys.getNpcs())
    expect(dressed.sys.getMachines()).toEqual(plain.sys.getMachines())
    expect(dressed.sys.getSights()).toEqual(plain.sys.getSights())
  })

  it('a chunk whose scatter placed nothing still lists the pass record', () => {
    // density 0 -> no scatter props at all; the pass still adds one per chunk and getProps() sees them
    const cfg = { ...L0, props: { density: 0, types: ['chair'] } }
    const { sys, bundles } = bundlesOf(cfg, open, { passes: [dress] })
    sys.update(0, 0)
    expect(sys.getProps()).toHaveLength(49)
    for (const b of bundles.values()) { expect(b.props).toHaveLength(1); expect(b.colliders.filter((c) => c.kind === 'prop')).toHaveLength(1) }
  })

  it('null passes are skipped; no hooks means no passes', () => {
    const sys = createDecorSystem(L0, open, 0, { passes: [null, undefined, dress] })
    sys.update(0, 0)
    expect(sys.getProps().filter((p) => p.key.endsWith(':dress0'))).toHaveLength(49)
    const a = createDecorSystem(L0, open); a.update(0, 0)
    const b = createDecorSystem(L0, open, 0, null); b.update(0, 0)
    expect(a.getProps()).toEqual(b.getProps())
  })

  it('passes run after the sights block, in order', () => {
    const order = []
    const sys = createDecorSystem(L0, open, 0, { passes: [() => order.push('a'), () => order.push('b')] })
    sys.update(0, 0)
    expect(order.slice(0, 2)).toEqual(['a', 'b'])
    expect(order.filter((o) => o === 'a')).toHaveLength(49)
  })
})

describe('hooks.onChunk / onEvict', () => {
  it('onChunk receives colliders for every prop, machine, sight and npc of the chunk, plus the lists', () => {
    const { sys, bundles } = bundlesOf(L0, open, { passes: [stairs] })
    sys.update(0, 0)
    expect(bundles.size).toBe(49)
    let machines = 0, sightsN = 0, npcs = 0, stairsN = 0
    for (const [k, b] of bundles) {
      expect(Object.keys(b).sort()).toEqual(['colliders', 'machine', 'npc', 'props', 'sight', 'stairs'].sort())
      const want = b.props.length + (b.machine ? 1 : 0) + (b.sight ? 1 : 0) + (b.npc ? 1 : 0)
      expect(b.colliders, k).toHaveLength(want)
      const kinds = b.colliders.map((c) => c.kind)
      expect(kinds.filter((x) => x === 'prop')).toHaveLength(b.props.length)
      expect(kinds.filter((x) => x === 'machine')).toHaveLength(b.machine ? 1 : 0)
      expect(kinds.filter((x) => x === 'sight')).toHaveLength(b.sight ? 1 : 0)
      expect(kinds.filter((x) => x === 'npc')).toHaveLength(b.npc ? 1 : 0)
      for (const c of b.colliders) {
        expect(c.r).toBeCloseTo(footprintRadius(c.kind, c.type), 12)
        expect(c.cellCls).toBe('room'); expect(c.hug).toBeNull()                    // the open grid: nothing hugs
        expect(c.cls === 'solid' || c.cls === 'none').toBe(true)
        expect(c.key).toBeTruthy()
      }
      if (b.sight) { expect(SIGHT_TYPES).toContain(b.sight.type); expect(b.colliders.find((c) => c.kind === 'sight').type).toBe(b.sight.type) }
      if (b.machine) machines++
      if (b.sight) sightsN++
      if (b.npc) npcs++
      stairsN += b.stairs.length
      expect(b.stairs).toEqual(sys.getStairs().filter((s) => s.key.startsWith(`${k}:`)))
    }
    expect(machines).toBeGreaterThan(0); expect(sightsN).toBeGreaterThan(0); expect(npcs).toBeGreaterThan(0); expect(stairsN).toBeGreaterThan(0)
    // the colliders' positions are the drawn (settled) positions
    for (const b of bundles.values()) for (const c of b.colliders) {
      const rec = c.kind === 'prop' ? b.props.find((p) => p.key === c.key) : b[c.kind]
      expect(rec.x).toBe(c.x); expect(rec.y).toBe(c.y)
    }
  })

  it('onChunk is called for an empty chunk too (a solid grid), with no colliders', () => {
    const { sys, bundles } = bundlesOf(L0, solid)
    sys.update(0, 0)
    expect(bundles.size).toBe(49)
    for (const b of bundles.values()) { expect(b.colliders).toEqual([]); expect(b.props).toEqual([]); expect(b.machine).toBeNull(); expect(b.npc).toBeNull(); expect(b.sight).toBeNull() }
  })

  it('onEvict fires for a chunk that leaves r + 2 and its stairs go with it', () => {
    const evicted = []
    const sys = createDecorSystem(L0, open, 0, { passes: [stairs], onEvict: (k) => evicted.push(k) })
    sys.update(0, 0)
    expect(sys.getStairs().length).toBeGreaterThan(0)
    sys.update(10, 10)
    expect(evicted).toHaveLength(49)
    expect(evicted).toContain('-3,-3'); expect(evicted).toContain('3,3')
    for (const s of sys.getStairs()) { expect(s.cx).toBeGreaterThanOrEqual(7); expect(s.cy).toBeGreaterThanOrEqual(7) }
    expect(sys.getProps().every((p) => Math.floor(p.x / CS) >= 7)).toBe(true)
    sys.update(10, 10)
    expect(evicted).toHaveLength(49)                                           // nothing else left
  })

  it('enterLevel clears the stairs and re-reads the config', () => {
    const sys = createDecorSystem(L0, open, 0, { passes: [stairs] })
    sys.update(0, 0)
    expect(sys.getStairs().length).toBeGreaterThan(0)
    sys.enterLevel(levelConfig(DEFAULT_CONFIG, 2))
    expect(sys.getStairs()).toEqual([])
    sys.update(0, 0)
    expect(sys.getStairs().length).toBeGreaterThan(0)
    for (const p of sys.getProps()) expect(levelConfig(DEFAULT_CONFIG, 2).props.types).toContain(p.type)
  })
})

describe('the way getters', () => {
  const build = () => { const sys = createDecorSystem(L0, open, 0, { passes: [stairs] }); sys.update(0, 0); return sys }

  it('getStairs lists { key, x, y, kind, target, label, cx, cy } for every stair added', () => {
    const sys = build()
    const list = sys.getStairs()
    expect(list.length).toBeGreaterThan(0)
    for (const s of list) {
      expect(s).toMatchObject({ kind: 'up', target: 3, label: 'the stairwell up' })
      expect(s.cx).toBe(Math.floor(s.x / CS)); expect(s.cy).toBe(Math.floor(s.y / CS))
      expect(s.key).toBe(`${s.cx},${s.cy}:up`)
      expect((((s.cx + s.cy) % 3) + 3) % 3).toBe(0)
    }
  })

  it('wayAt(cx, cy, kind) returns the stored stair record or null; exitAt(cx, cy) the exit record or null', () => {
    const sys = build()
    const s = sys.getStairs()[0]
    expect(sys.wayAt(s.cx, s.cy, 'up')).toBe(s)
    expect(sys.wayAt(s.cx, s.cy, 'lift')).toBeNull()
    expect(sys.wayAt(100, 100, 'up')).toBeNull()
    const e = sys.getExits()[0]
    expect(sys.exitAt(Math.floor(e.x / CS), Math.floor(e.y / CS))).toBe(e)
    expect(sys.exitAt(100, 100)).toBeNull()
    const noExit = [...Array(7)].flatMap((_, i) => [...Array(7)].map((_, j) => [i - 3, j - 3])).find(([cx, cy]) => !sys.getExits().some((x) => Math.floor(x.x / CS) === cx && Math.floor(x.y / CS) === cy))
    if (noExit) expect(sys.exitAt(noExit[0], noExit[1])).toBeNull()
  })

  it('nearestWay(px, py, maxDist = 1.6) ranges over exits and stairs and returns the stored record', () => {
    const sys = build()
    const s = sys.getStairs()[0], e = sys.getExits()[0]
    expect(sys.nearestWay(s.x + 0.4, s.y)).toBe(s)
    expect(sys.nearestWay(e.x + 0.4, e.y)).toBe(e)
    expect(sys.nearestWay(s.x + 1.7, s.y)).not.toBe(s)
    expect(sys.nearestWay(s.x + 0.4, s.y, 0.3)).toBeNull()
    expect(sys.nearestExit(s.x + 0.4, s.y, 1.6)).not.toBe(s)                   // the old getter still sees exits only
  })

  it('nearestWayAny(px, py) returns one reused { rec, dist } over exits and stairs, or null with nothing loaded', () => {
    const sys = build()
    const s = sys.getStairs()[0]
    const a = sys.nearestWayAny(s.x + 3, s.y + 4)
    expect(a.rec).toBe(s); expect(a.dist).toBeCloseTo(5, 9)
    const e = sys.getExits()[0]
    const b = sys.nearestWayAny(e.x + 0.1, e.y)
    expect(b).toBe(a)                                                           // the same object, rewritten
    expect(b.rec).toBe(e); expect(b.dist).toBeCloseTo(0.1, 9)
    const empty = createDecorSystem(L0, solid); empty.update(0, 0)
    expect(empty.nearestWayAny(0, 0)).toBeNull()
    // the old getter keeps its { x, y, dist } shape
    expect(sys.nearestExitAny(e.x + 0.1, e.y)).toEqual({ x: e.x, y: e.y, dist: expect.closeTo(0.1, 9) })
  })

  it('getKind(kind) lists the loaded ways of that kind: exits are the down way, stairs by their own kind', () => {
    const sys = build()
    expect(sys.getKind('down')).toEqual(sys.getExits())
    expect(sys.getKind('up')).toEqual(sys.getStairs())
    expect(sys.getKind('lift')).toEqual([])
  })

  it('nearestProp(px, py, maxDist = 1.5, pred) honours the predicate and the range', () => {
    const sys = build()
    const props = sys.getProps()
    const p = props[0]
    expect(sys.nearestProp(p.x + 0.3, p.y)).toBe(p)
    expect(sys.nearestProp(p.x + 0.3, p.y, 1.5, (q) => q.type === p.type)).toBe(p)
    expect(sys.nearestProp(p.x + 0.3, p.y, 1.5, (q) => q !== p)).not.toBe(p)
    expect(sys.nearestProp(p.x + 0.3, p.y, 0.1)).toBeNull()
    expect(sys.nearestProp(p.x + 0.3, p.y, 1.5, () => false)).toBeNull()
    // the nearest, not the first
    let best = null, bd = Infinity
    for (const q of props) { const d = (q.x - 10.2) ** 2 + (q.y - 7.7) ** 2; if (d < bd) { bd = d; best = q } }
    expect(sys.nearestProp(10.2, 7.7, 100)).toBe(best)
  })
})

describe('settled bodies against real walls', () => {
  it('a hugged body sits vis + HUG_GAP from the wall face it names, and the side follows the rule', () => {
    const { isWall, grid } = walled()
    const { sys, bundles } = bundlesOf(L0, isWall)
    sys.update(0, 0)
    grid.setPlayerChunk(0, 0)
    let hugged = 0, props = 0, others = 0
    for (const b of bundles.values()) for (const c of b.colliders) {
      if (c.cls === 'none') { expect(c.hug).toBeNull(); continue }
      const ix = Math.floor(c.x), iy = Math.floor(c.y)
      const sides = wallSides(grid.floor, ix, iy)
      const walls = ['N', 'E', 'S', 'W'].filter((k) => sides[k])
      if (!walls.length) { expect(c.hug).toBeNull(); expect(c.x - Math.floor(c.x)).toBeCloseTo(0.5, 12); continue }
      hugged++
      const rec = c.kind === 'prop' ? b.props.find((p) => p.key === c.key) : b[c.kind]
      const side = c.kind === 'prop' ? (unitJitter(rec.rot, 23) < 0 ? -1 : 1) : ((hash(c.cx, c.cy, 0) & 1) ? 1 : -1)
      const want = side > 0 ? walls[0] : walls[walls.length - 1]
      expect(c.hug, `${c.kind} ${c.key}`).toBe(want)
      const vis = visualHalf(c.kind, c.type)
      if (want === 'N') expect(c.y).toBeCloseTo(iy + vis + HUG_GAP, 12)
      if (want === 'S') expect(c.y).toBeCloseTo(iy + 1 - vis - HUG_GAP, 12)
      if (want === 'E') expect(c.x).toBeCloseTo(ix + 1 - vis - HUG_GAP, 12)
      if (want === 'W') expect(c.x).toBeCloseTo(ix + vis + HUG_GAP, 12)
      if (c.kind === 'prop') props++; else others++
      // the drawn record is the settled one
      expect(rec.x).toBe(c.x); expect(rec.y).toBe(c.y); expect(rec.hug).toBe(c.hug); expect(rec.cls).toBe(c.cls); expect(rec.cellCls).toBe(c.cellCls)
    }
    expect(hugged).toBeGreaterThan(30); expect(props).toBeGreaterThan(20); expect(others).toBeGreaterThan(3)
  })
})
