import { describe, it, expect } from 'vitest'
import { LEVELS, levelConfig, levelCount } from '../src/renderer/levels.js'
import { DEFAULT_CONFIG } from '../src/renderer/world.js'

describe('levels', () => {
  it('defines four levels 0..3', () => {
    expect(levelCount()).toBe(4)
    expect(LEVELS.map(l => l.id)).toEqual([0, 1, 2, 3])
  })

  it('level 0 (the lobby) has entities disabled', () => {
    expect(levelConfig(DEFAULT_CONFIG, 0).entities.enabled).toBe(false)
  })

  it('levels 1-3 enable entities, getting harsher with depth', () => {
    const l1 = levelConfig(DEFAULT_CONFIG, 1).entities
    const l3 = levelConfig(DEFAULT_CONFIG, 3).entities
    expect(l1.enabled).toBe(true)
    expect(l3.enabled).toBe(true)
    expect(l3.damage).toBeGreaterThan(l1.damage)          // deeper hits harder
    expect(l3.spawnDenom).toBeLessThan(l1.spawnDenom)      // deeper spawns more
  })

  it('exits chain 0→1→2→3→0', () => {
    expect(levelConfig(DEFAULT_CONFIG, 0).exit.target).toBe(1)
    expect(levelConfig(DEFAULT_CONFIG, 1).exit.target).toBe(2)
    expect(levelConfig(DEFAULT_CONFIG, 2).exit.target).toBe(3)
    expect(levelConfig(DEFAULT_CONFIG, 3).exit.target).toBe(0)
  })

  it('every level carries a descent hint and a name', () => {
    for (let i = 0; i < 4; i++) {
      const c = levelConfig(DEFAULT_CONFIG, i)
      expect(typeof c.levelName).toBe('string')
      expect(c.exit.hint.length).toBeGreaterThan(10)
    }
  })

  it('each level has a distinct maze salt and palette', () => {
    const salts = LEVELS.map((_, i) => levelConfig(DEFAULT_CONFIG, i).maze.salt)
    expect(new Set(salts).size).toBe(4)
    const walls = LEVELS.map((_, i) => levelConfig(DEFAULT_CONFIG, i).palette.wall)
    expect(new Set(walls).size).toBe(4)
  })

  it('merges partial config over the base (keeps base keys it does not override)', () => {
    const c = levelConfig(DEFAULT_CONFIG, 1)
    expect(c.messageInterval).toEqual(DEFAULT_CONFIG.messageInterval) // untouched base key
    expect(c.palette.wall).not.toBe(DEFAULT_CONFIG.palette.wall)      // overridden
  })

  it('wraps out-of-range indices', () => {
    expect(levelConfig(DEFAULT_CONFIG, 4).levelIndex).toBe(0)
    expect(levelConfig(DEFAULT_CONFIG, -1).levelIndex).toBe(3)
  })
})
