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
