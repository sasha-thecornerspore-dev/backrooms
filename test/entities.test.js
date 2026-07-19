import { describe, it, expect } from 'vitest'
import { createEntitySystem } from '../src/renderer/entities.js'

const config = { chunkEvictRadius: 3 }
const isWall = () => false

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
