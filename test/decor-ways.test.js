// decor-ways — topology.stairsPass run through decor.js's pass pipeline: the stairs up sit under one in three of the parent floor's exits
// (the partner gate), the lift on L1 alone, midpoints on solid walls, and nothing above the pass moves.
import { describe, it, expect } from 'vitest'
import { createDecorSystem } from '../src/renderer/decor.js'
import { levelConfig, LEVELS } from '../src/renderer/levels.js'
import { createChunkCache, CHUNK_SIZE, DEFAULT_CONFIG } from '../src/renderer/world.js'
import { CHANNELS } from '../src/renderer/channels.js'
import { waysFor, stairsPass, hasUpStair, chunkMid, UP_ONE_IN, LIFT_DENOM } from '../src/renderer/topology.js'

const CS = CHUNK_SIZE
const open = () => false
const solid = () => true
function hash(a, b, c = 0) {
  let h = (a * 2654435761 ^ b * 2246822519 ^ Math.imul(c, 3266489917)) >>> 0
  h ^= h >>> 16; h = Math.imul(h, 0x45d9f3b) >>> 0
  h ^= h >>> 16
  return h >>> 0
}
const cfgFor = (i) => { const c = levelConfig(DEFAULT_CONFIG, i); c.ways = waysFor(i); return c }
// the 24x24 chunk window every count below runs over
const WIN = { x0: -12, y0: -12, n: 24 }
const inWin = (cx, cy) => cx >= WIN.x0 && cx < WIN.x0 + WIN.n && cy >= WIN.y0 && cy < WIN.y0 + WIN.n
// scan the window through decor.update (radius 3 per call), collecting every chunk's onChunk bundle; eviction only re-scans identically
function scanWindow(cfg, isWall, hooks = {}, seed = 0) {
  const bundles = new Map()
  const sys = createDecorSystem(cfg, isWall, seed, { ...hooks, onChunk: (k, b) => { const [cx, cy] = k.split(',').map(Number); if (inWin(cx, cy)) bundles.set(k, b) } })
  for (let py = WIN.y0 + 3; py - 3 < WIN.y0 + WIN.n; py += 7) for (let px = WIN.x0 + 3; px - 3 < WIN.x0 + WIN.n; px += 7) sys.update(px, py)
  expect(bundles.size).toBe(WIN.n * WIN.n)
  return { sys, bundles }
}
const stairsOf = (bundles, kind) => { const out = new Map(); for (const [k, b] of bundles) for (const s of b.stairs) if (s.kind === kind) out.set(k, s); return out }

describe('stairsPass', () => {
  it('is null for levels with no way up (L0, ∅) and a function for L1-L3', () => {
    expect(stairsPass(cfgFor(0), waysFor(0))).toBeNull()
    expect(stairsPass(cfgFor(4), waysFor(4))).toBeNull()
    for (const i of [1, 2, 3]) expect(typeof stairsPass(cfgFor(i), waysFor(i))).toBe('function')
  })

  for (const T of [1, 2, 3]) {
    it(`L${T} has an 'up' stair at C iff L${T - 1}'s exit gate passes at C and the 1-in-3 sub-gate passes; count ~ 1/12`, () => {
      const S = T - 1
      const cfg = cfgFor(T)
      const { bundles } = scanWindow(cfg, open, { passes: [stairsPass(cfg, cfg.ways)] })
      const ups = stairsOf(bundles, 'up')
      const saltS = LEVELS[S].config.maze.salt | 0, denomS = LEVELS[S].config.exit.denom, saltT = cfg.maze.salt | 0
      const [ea, eb] = CHANNELS.exits.gate, [ua, ub] = CHANNELS.upStair.gate
      const parent = scanWindow(cfgFor(S), open)   // the parent floor's own exits, placed by decor.js itself
      for (const [k] of bundles) {
        const [cx, cy] = k.split(',').map(Number)
        const parentGate = hash(cx + ea + saltS, cy + eb + saltS, 0) % denomS === 0
        const want = parentGate && hash(cx + ua + saltT, cy + ub + saltT, 0) % UP_ONE_IN === 0
        expect(ups.has(k), k).toBe(want)
        expect(hasUpStair(T, cx, cy, 0), k).toBe(want)
        if (want) {
          expect(parent.sys.exitAt(cx, cy) ?? parent.bundles.has(k), k).toBeTruthy()   // there is an exit above every stair up
          const s = ups.get(k)
          expect(s).toMatchObject({ key: `${k}:up`, kind: 'up', target: S, label: 'stairwell up', cx, cy })
          expect(Math.floor(s.x / CS)).toBe(cx); expect(Math.floor(s.y / CS)).toBe(cy)
          expect(((s.x % 1) + 1) % 1).toBeCloseTo(0.5, 12); expect(((s.y % 1) + 1) % 1).toBeCloseTo(0.5, 12)   // cell centres (negative coords too)
        }
      }
      const expected = WIN.n * WIN.n / (denomS * UP_ONE_IN)
      expect(ups.size).toBeGreaterThanOrEqual(expected * 0.7)
      expect(ups.size).toBeLessThanOrEqual(expected * 1.3)
    })
  }

  it('every stair up on L1 sits under an exit the lobby really places (open grid)', () => {
    const cfg = cfgFor(1)
    const { bundles } = scanWindow(cfg, open, { passes: [stairsPass(cfg, cfg.ways)] })
    const lobby = scanWindow(cfgFor(0), open)
    for (const [k] of stairsOf(bundles, 'up')) expect(lobby.sys.getExits().some((e) => e.key === k) || lobby.bundles.has(k)).toBe(true)
    // and the reverse ratio: roughly one in three lobby exits has a stair beneath it
    let withStair = 0, exits = 0
    for (const [k] of bundles) {
      const [cx, cy] = k.split(',').map(Number)
      if (hash(cx + 5150, cy + 6270, 0) % 4 === 0) { exits++; if (stairsOf(bundles, 'up').has(k)) withStair++ }
    }
    expect(withStair / exits).toBeGreaterThan(1 / 3 * 0.7); expect(withStair / exits).toBeLessThan(1 / 3 * 1.3)
  })

  it('the lift: L1 count ~ 1/24 on its own gate; L2 and L3 have none', () => {
    const cfg = cfgFor(1)
    const { bundles } = scanWindow(cfg, open, { passes: [stairsPass(cfg, cfg.ways)] })
    const lifts = stairsOf(bundles, 'lift')
    const [la, lb] = CHANNELS.lift.gate, salt = cfg.maze.salt | 0
    for (const [k] of bundles) {
      const [cx, cy] = k.split(',').map(Number)
      const want = hash(cx + la + salt, cy + lb + salt, 0) % LIFT_DENOM === 0
      expect(lifts.has(k), k).toBe(want)
      if (want) expect(lifts.get(k)).toMatchObject({ key: `${k}:lift`, kind: 'lift', target: 3, label: 'the lift', cx, cy })
    }
    const expected = WIN.n * WIN.n / LIFT_DENOM
    expect(lifts.size).toBeGreaterThanOrEqual(expected * 0.7)
    expect(lifts.size).toBeLessThanOrEqual(expected * 1.3)
    for (const i of [2, 3]) {
      const c = cfgFor(i)
      const r = scanWindow(c, open, { passes: [stairsPass(c, c.ways)] })
      expect(stairsOf(r.bundles, 'lift').size).toBe(0)
    }
  })

  it('on solid walls stairs fall back to the chunk midpoint (never empty)', () => {
    const cfg = cfgFor(1)
    const { bundles } = scanWindow(cfg, solid, { passes: [stairsPass(cfg, cfg.ways)] })
    const ups = stairsOf(bundles, 'up'), lifts = stairsOf(bundles, 'lift')
    expect(ups.size).toBeGreaterThan(0); expect(lifts.size).toBeGreaterThan(0)
    for (const [k, s] of [...ups, ...lifts]) {
      const [cx, cy] = k.split(',').map(Number)
      expect(hasUpStair(1, cx, cy, 0) || s.kind === 'lift').toBe(true)
      if (s.kind === 'up') expect(hasUpStair(1, cx, cy, 0)).toBe(true)
      expect(s.x).toBe(chunkMid(cx, cy).x); expect(s.y).toBe(chunkMid(cx, cy).y)
    }
    // the gate still decides: the solid grid has exactly the open grid's set of stair chunks
    const openRun = scanWindow(cfg, open, { passes: [stairsPass(cfg, cfg.ways)] })
    expect([...ups.keys()].sort()).toEqual([...stairsOf(openRun.bundles, 'up').keys()].sort())
    expect([...lifts.keys()].sort()).toEqual([...stairsOf(openRun.bundles, 'lift').keys()].sort())
  })

  it('on real walls every stair stands on an open cell', () => {
    const cfg = cfgFor(2)
    const cache = createChunkCache(cfg, 0)
    const isWall = (wx, wy, pcx, pcy) => cache.isWall(wx, wy, pcx, pcy)
    const { bundles } = scanWindow(cfg, isWall, { passes: [stairsPass(cfg, cfg.ways)] })
    const ups = stairsOf(bundles, 'up')
    expect(ups.size).toBeGreaterThan(0)
    for (const [, s] of ups) expect(isWall(s.x, s.y, s.cx, s.cy)).toBe(false)
  })

  it('draws its constants from channels.js (upStair / lift gate + rng), through ctx.rngFrom / ctx.hash / ctx.openCell', () => {
    const cfg = cfgFor(1)
    const pass = stairsPass(cfg, cfg.ways)
    const salt = cfg.maze.salt | 0, seed = 5
    // find a chunk that has both a stair up and a lift under seed 5
    let cx = 0, cy = 0, found = false
    outer: for (cy = -40; cy < 40; cy++) for (cx = -40; cx < 40; cx++) {
      if (hasUpStair(1, cx, cy, seed) && hash(cx + CHANNELS.lift.gate[0] + salt, cy + CHANNELS.lift.gate[1] + salt, seed) % LIFT_DENOM === 0) { found = true; break outer }
    }
    expect(found).toBe(true)
    const rngArgs = [], hashArgs = [], added = []
    const ctx = {
      cx, cy, key: `${cx},${cy}`, pcx: cx, pcy: cy, salt, seed, cfg,
      isWall: () => false,
      hash: (a, b, c) => { hashArgs.push([a, b, c]); return hash(a, b, c) },
      rngFrom: (a, b, c) => { rngArgs.push([a, b, c]); let s = hash(a, b, c) | 1; return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 0xffffffff } },
      openCell: (rng) => ({ wx: cx * CS + 1 + Math.floor(rng() * 20) + 0.5, wy: cy * CS + 1 + Math.floor(rng() * 20) + 0.5 }),
      add: (kind, rec) => added.push([kind, rec]),
    }
    pass(ctx)
    const [umx, uax, umy, uay] = CHANNELS.upStair.rng, [lmx, lax, lmy, lay] = CHANNELS.lift.rng
    expect(rngArgs).toEqual([[cx * umx + salt + uax, cy * umy + salt + uay, seed], [cx * lmx + salt + lax, cy * lmy + salt + lay, seed]])
    expect(hashArgs).toContainEqual([cx + CHANNELS.lift.gate[0] + salt, cy + CHANNELS.lift.gate[1] + salt, seed])
    expect(added.map(([k]) => k)).toEqual(['stair', 'stair'])
    expect(added[0][1]).toMatchObject({ key: `${cx},${cy}:up`, kind: 'up', target: 0, label: 'stairwell up', cx, cy })
    expect(added[1][1]).toMatchObject({ key: `${cx},${cy}:lift`, kind: 'lift', target: 3, label: 'the lift', cx, cy })
    expect(CHANNELS.upStair.rng).toEqual([1013, 13, 569, 31]); expect(CHANNELS.lift.rng).toEqual([1033, 7, 751, 19])
    expect(CHANNELS.upStair.gate).toEqual([9311, 4177]); expect(CHANNELS.lift.gate).toEqual([8629, 1109])
  })

  it('getExits() positions / targets / kinds are unchanged with the pass on; getStairs lists the pass records', () => {
    for (const i of [1, 2, 3]) {
      const cfg = cfgFor(i)
      const plain = createDecorSystem(cfg, open); plain.update(0, 0)
      const withPass = createDecorSystem(cfg, open, 0, { passes: [stairsPass(cfg, cfg.ways)] }); withPass.update(0, 0)
      expect(withPass.getExits()).toEqual(plain.getExits())
      expect(withPass.getProps()).toEqual(plain.getProps())
      expect(withPass.getMachines()).toEqual(plain.getMachines())
      expect(withPass.getNpcs()).toEqual(plain.getNpcs())
      expect(withPass.getSights()).toEqual(plain.getSights())
      expect(plain.getStairs()).toEqual([])
      const st = withPass.getStairs()
      for (const s of st) expect(['up', 'lift']).toContain(s.kind)
      expect(withPass.getKind('up').length).toBe(st.filter((s) => s.kind === 'up').length)
      for (const e of withPass.getExits()) expect(e.kind).toBe(cfg.ways[0].kind)
    }
  })
})
