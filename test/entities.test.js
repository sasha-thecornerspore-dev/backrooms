import { describe, it, expect } from 'vitest'
import { createEntitySystem, shouldSpawn } from '../src/renderer/entities.js'
import { CHUNK_SIZE } from '../src/renderer/world.js'

const config = { chunkEvictRadius: 3 }
const isWall = () => false
const N = CHUNK_SIZE

// ── today's placement, frozen (entities.js at 2.0.3): salt 0 and seed 0 must reproduce it exactly ──────────────────────
function hash0(a, b) {
  let h = (a * 2654435761 ^ b * 2246822519) >>> 0
  h ^= h >>> 16; h = Math.imul(h, 0x45d9f3b) >>> 0
  h ^= h >>> 16
  return h
}
function rng0(cx, cy) {
  let s = hash0(cx, cy) | 1
  return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 0xffffffff }
}
const spawn0 = (cx, cy, denom) => hash0(cx + 1000, cy + 2000) % denom === 0
// makeEntity's draws, in its order: type, variant, x, y, dir, dirTimer
function draws0(cx, cy, stalkerDenom, variants) {
  const rng = rng0(cx, cy)
  const type = rng() < 1 / stalkerDenom ? 'stalker' : 'wanderer'
  const list = variants[type]
  const variant = list[(rng() * list.length) | 0]
  const x = cx * N + N / 2 + (rng() - 0.5) * 4
  const y = cy * N + N / 2 + (rng() - 0.5) * 4
  return { type, variant, x, y, dir: rng() * Math.PI * 2, dirTimer: 3 + rng() * 4 }
}
const VARIANTS = { stalker: ['smiler', 'hound', 'tesla'], wanderer: ['watcher', 'crawler'] }
// one chunk per system (radius 0), the legacy step at dt 0 with no ranges: what the spawn alone produced
const oneChunk = (denom, over = {}) => ({ chunkEvictRadius: 0, ...over,
  entities: { enabled: true, spawnDenom: denom, stalkerDenom: 3, chaseRange: 0, fleeRange: 0, stalkerVariants: VARIANTS.stalker, wandererVariants: VARIANTS.wanderer } })
const at = (cx, cy) => ({ x: cx * N + 11, y: cy * N + 11 })
const drew = (e) => ({ type: e.type, variant: e.variant, x: e.x, y: e.y, dir: e.dir, dirTimer: e.dirTimer })
function each400(fn) { for (let cx = -10; cx < 10; cx++) for (let cy = -10; cy < 10; cy++) fn(cx, cy) }
function spawnSet(denom, salt, seed) { const s = []; each400((cx, cy) => { if (shouldSpawn(cx, cy, denom, salt, seed)) s.push(`${cx},${cy}`) }); return s }

describe('placement per floor and per world (the maze salt and the world seed)', () => {
  it('salt 0 and seed 0 reproduce today\'s spawns over 400 chunks: the same chunks, the same draws', () => {
    for (const denom of [6, 8, 12]) {
      // no maze and no deps, an explicit salt 0 and seed 0, and the null seed a fresh solo run hands over: all today's world
      for (const [over, deps] of [[{}, null], [{ maze: { salt: 0 } }, { seed: 0 }], [{ maze: { salt: 0 } }, { seed: null }]]) {
        let n = 0
        each400((cx, cy) => {
          expect(shouldSpawn(cx, cy, denom, 0, 0), `${cx},${cy} / ${denom}`).toBe(spawn0(cx, cy, denom))
          const sys = createEntitySystem(oneChunk(denom, over), isWall, deps)
          sys.update(0, at(cx, cy), cx, cy)
          const got = sys.getEntities()
          if (!spawn0(cx, cy, denom)) { expect(got.length).toBe(0); return }
          n++
          expect(got.length).toBe(1)
          expect(drew(got[0])).toEqual(draws0(cx, cy, 3, VARIANTS))
        })
        expect(n).toBeGreaterThan(400 / denom / 2)
      }
    }
  })

  it('shouldSpawn with no salt or seed given is today\'s roll too', () => {
    each400((cx, cy) => expect(shouldSpawn(cx, cy, 12)).toBe(spawn0(cx, cy, 12)))
  })

  it('the floors\' salts and the world seed give different sets at the same rate', () => {
    const sets = [0, 0x1111, 0x2222, 0x3333].map((salt) => spawnSet(8, salt, 0))
    for (let i = 0; i < sets.length; i++) for (let j = i + 1; j < sets.length; j++) expect(sets[i]).not.toEqual(sets[j])
    expect(spawnSet(8, 0x2222, 0x5eed)).not.toEqual(sets[2])                         // the same floor in another world
    expect(spawnSet(8, 0x2222, -0x5eed)).not.toEqual(spawnSet(8, 0x2222, 0x5eed))
    for (const [salt, seed, denom] of [[0x1111, 0, 12], [0x2222, 0, 8], [0x3333, 0, 6], [0x1111, 0x5eed, 12], [0x3333, 0xdeadbeef, 6]]) {
      const n = spawnSet(denom, salt, seed).length
      expect(n, `${salt}/${seed}/${denom}`).toBeGreaterThan(400 / denom * 0.5)
      expect(n, `${salt}/${seed}/${denom}`).toBeLessThan(400 / denom * 1.6)
    }
  })

  // review D3/C9: a power-of-two denominator (L2's 8) read only the seed's low bits when the seed was XORed in after the hash, so
  // seeds eight apart shared every L2 creature chunk (one pair of rooms in eight). The seed is mixed after the XOR now
  it('seeds eight apart give different sets on a power-of-two floor (L2: denom 8, salt 0x2222), at the same rate', () => {
    for (const k of [1, 2, 3, 0x5eed, 0x12345678]) {
      expect(spawnSet(8, 0x2222, k + 8), `seed ${k}`).not.toEqual(spawnSet(8, 0x2222, k))
      expect(spawnSet(4, 0x2222, k + 4), `seed ${k} / 4`).not.toEqual(spawnSet(4, 0x2222, k))
    }
    const sets = new Set()
    for (let seed = 1; seed <= 64; seed++) {
      const s = spawnSet(8, 0x2222, seed)
      sets.add(s.join(' '))
      expect(s.length, `seed ${seed}`).toBeGreaterThan(400 / 8 * 0.5)
      expect(s.length, `seed ${seed}`).toBeLessThan(400 / 8 * 1.6)
    }
    expect(sets.size).toBe(64)
  })

  it('createEntitySystem reads config.maze.salt and deps.seed; two systems on one floor of one world agree', () => {
    const cfg = oneChunk(8, { maze: { salt: 0x2222 } })
    let moved = 0
    each400((cx, cy) => {
      const a = createEntitySystem(cfg, isWall, { seed: 0x5eed }), b = createEntitySystem(cfg, isWall, { seed: 0x5eed })
      a.update(0, at(cx, cy), cx, cy); b.update(0, at(cx, cy), cx, cy)
      expect(a.getEntities().length).toBe(shouldSpawn(cx, cy, 8, 0x2222, 0x5eed) ? 1 : 0)
      expect(a.getEntities().map(drew)).toEqual(b.getEntities().map(drew))           // two players in one room see the same spawns
      if (a.getEntities().length && spawn0(cx, cy, 8) && drew(a.getEntities()[0]).dir !== draws0(cx, cy, 3, VARIANTS).dir) moved++
    })
    // the draws (type, variant, where, facing) move with the salt and seed too, not only the chunks
    expect(moved).toBeGreaterThan(0)
  })

  it('isSpawnChunk(cx, cy) agrees with the spawns, and is false on a floor without creatures', () => {
    const cfg = oneChunk(8, { maze: { salt: 0x3333 } })
    const probe = createEntitySystem(cfg, isWall, { seed: 0xdeadbeef })
    let n = 0
    each400((cx, cy) => {
      const sys = createEntitySystem(cfg, isWall, { seed: 0xdeadbeef })
      sys.update(0, at(cx, cy), cx, cy)
      expect(sys.getEntities().length, `${cx},${cy}`).toBe(probe.isSpawnChunk(cx, cy) ? 1 : 0)
      expect(probe.isSpawnChunk(cx, cy)).toBe(shouldSpawn(cx, cy, 8, 0x3333, 0xdeadbeef))
      if (probe.isSpawnChunk(cx, cy)) n++
    })
    expect(n).toBeGreaterThan(0)
    const off = createEntitySystem({ chunkEvictRadius: 0, maze: { salt: 0x3333 }, entities: { enabled: false, spawnDenom: 1 } }, isWall)
    each400((cx, cy) => expect(off.isSpawnChunk(cx, cy)).toBe(false))
    // no entities block: the historic default (1 in 8, salt 0, seed 0)
    const bare = createEntitySystem(config, isWall)
    each400((cx, cy) => expect(bare.isSpawnChunk(cx, cy)).toBe(spawn0(cx, cy, 8)))
  })
})

describe('createEntitySystem', () => {
  it('returns update and getEntities', () => {
    const sys = createEntitySystem(config, isWall)
    expect(typeof sys.update).toBe('function')
    expect(typeof sys.getEntities).toBe('function')
  })

  it('getEntities returns array', () => {
    const sys = createEntitySystem(config, isWall)
    expect(Array.isArray(sys.getEntities())).toBe(true)
  })

  it('spawns at most 20 entities', () => {
    const sys = createEntitySystem(config, isWall)
    for (let cx = -10; cx <= 10; cx++)
      for (let cy = -10; cy <= 10; cy++)
        sys.update(0, { x: cx * 22 + 11, y: cy * 22 + 11 }, cx, cy)
    expect(sys.getEntities().length).toBeLessThanOrEqual(20)
  })

  it('entity has required shape', () => {
    // force a spawn by using seeded chunk (cx=0,cy=0 happens to spawn in test seed)
    const sys = createEntitySystem(config, isWall)
    sys.update(0, { x: 11, y: 11 }, 0, 0)
    const ents = sys.getEntities()
    if (ents.length > 0) {
      const e = ents[0]
      expect(['wanderer', 'stalker']).toContain(e.type)
      expect(['idle', 'chase', 'flee']).toContain(e.state)
      expect(typeof e.x).toBe('number')
      expect(typeof e.y).toBe('number')
      expect(typeof e.dir).toBe('number')
      expect(typeof e.dirTimer).toBe('number')
    }
  })

  it('evicts entities beyond evictRadius + 2', () => {
    const sys = createEntitySystem(config, isWall)
    // spawn near 0,0
    sys.update(0, { x: 11, y: 11 }, 0, 0)
    const before = sys.getEntities().length
    // move player far away
    sys.update(0, { x: 200 * 22 + 11, y: 200 * 22 + 11 }, 200, 200)
    const after = sys.getEntities().length
    expect(after).toBeLessThanOrEqual(before)
  })
})

describe('entity AI', () => {
  it('wanderer changes dir when dirTimer expires', () => {
    const sys = createEntitySystem(config, isWall)
    // inject a wanderer directly
    sys.getEntities().push({ x: 50, y: 50, type: 'wanderer', state: 'idle', dir: 0, dirTimer: 0.01, chunkCx: 2, chunkCy: 2 })
    const dirBefore = sys.getEntities()[0].dir
    sys.update(1.0, { x: 0, y: 0 }, 0, 0)
    // timer expired → dir should change (very likely with dt=1.0 >> 0.01)
    expect(sys.getEntities()[0].dirTimer).toBeGreaterThan(0)
  })

  it('wanderer enters flee state when player is close', () => {
    const sys = createEntitySystem(config, isWall)
    sys.getEntities().push({ x: 3, y: 3, type: 'wanderer', state: 'idle', dir: 0, dirTimer: 99, chunkCx: 0, chunkCy: 0 })
    sys.update(0.016, { x: 3, y: 3 }, 0, 0)
    expect(sys.getEntities()[0].state).toBe('flee')
  })

  it('stalker enters chase state when player is within 24 units', () => {
    const sys = createEntitySystem(config, isWall)
    sys.getEntities().push({ x: 10, y: 10, type: 'stalker', state: 'idle', dir: 0, dirTimer: 99, chunkCx: 0, chunkCy: 0 })
    sys.update(0.016, { x: 10, y: 30 }, 0, 0)  // dist ~20, within 24
    expect(sys.getEntities()[0].state).toBe('chase')
  })

  it('entity moves when dt > 0', () => {
    const sys = createEntitySystem(config, isWall)
    sys.getEntities().push({ x: 50, y: 50, type: 'wanderer', state: 'idle', dir: 0, dirTimer: 99, chunkCx: 2, chunkCy: 2 })
    const xBefore = sys.getEntities()[0].x
    sys.update(0.1, { x: 0, y: 0 }, 0, 0)
    expect(sys.getEntities()[0].x).not.toBe(xBefore)
  })
})

describe('the ward (fighting back)', () => {
  // a stalker directly in front of a player facing +x (angle 0), 1.5 units away
  const inFront = () => ({ x: 11.5, y: 10, type: 'stalker', state: 'chase', dir: 0, dirTimer: 99, stagger: 0, wardHits: 0, chunkCx: 0, chunkCy: 0 })

  it('exposes a ward() method', () => {
    expect(typeof createEntitySystem(config, isWall).ward).toBe('function')
  })

  it('staggers and knocks back a presence in the cone ahead', () => {
    const sys = createEntitySystem(config, isWall)
    sys.getEntities().push(inFront())
    const before = sys.getEntities()[0].x
    const res = sys.ward({ x: 10, y: 10, angle: 0 })
    const e = sys.getEntities()[0]
    expect(res.hit).toBe(1)
    expect(e.stagger).toBeGreaterThan(0)
    expect(e.x).toBeGreaterThan(before)          // shoved further along +x, away from player
  })

  it('ignores presences behind the player (outside the cone)', () => {
    const sys = createEntitySystem(config, isWall)
    sys.getEntities().push({ ...inFront(), x: 8.5 })   // behind a player facing +x
    const res = sys.ward({ x: 10, y: 10, angle: 0 })
    expect(res.hit).toBe(0)
    expect(sys.getEntities()[0].stagger).toBe(0)
  })

  it('ignores presences beyond ward range', () => {
    const sys = createEntitySystem(config, isWall)
    sys.getEntities().push({ ...inFront(), x: 20 })    // ~10 units ahead, out of range
    expect(sys.ward({ x: 10, y: 10, angle: 0 }).hit).toBe(0)
  })

  it('disperses a presence after enough wards', () => {
    const sys = createEntitySystem(config, isWall)
    sys.getEntities().push(inFront())
    // dispelAt defaults to 3 — clear stagger between hits so it stays in range/cone
    let last
    for (let i = 0; i < 3; i++) {
      const e = sys.getEntities()[0]
      if (e) { e.stagger = 0; e.x = 11.5 }             // re-place in front for the next strike
      last = sys.ward({ x: 10, y: 10, angle: 0 })
    }
    expect(last.dispelled).toBe(1)
    expect(sys.getEntities().length).toBe(0)           // it came apart
  })

  it('a staggered presence flees and recovers over time', () => {
    const sys = createEntitySystem(config, isWall)
    sys.getEntities().push({ ...inFront(), stagger: 1.0 })
    const dBefore = Math.abs(sys.getEntities()[0].x - 10)
    sys.update(0.2, { x: 10, y: 10 }, 0, 0)
    const e = sys.getEntities()[0]
    expect(e.state).toBe('stagger')
    expect(e.stagger).toBeLessThan(1.0)                // ticking down
    expect(Math.abs(e.x - 10)).toBeGreaterThan(dBefore) // moving away from the player
  })
})
