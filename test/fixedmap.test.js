import { describe, it, expect } from 'vitest'
import { createFixedMap } from '../src/renderer/fixedmap.js'

const GRID = [
  'FFFF',
  'F..F',
  'F..P',
  'FFFF',
]

describe('createFixedMap', () => {
  it('reports open cells and wall cells', () => {
    const m = createFixedMap(GRID)
    expect(m.width).toBe(4); expect(m.height).toBe(4)
    expect(m.isWall(1.5, 1.5)).toBe(false)   // '.'
    expect(m.isWall(0.5, 0.5)).toBe(true)    // 'F'
  })

  it('treats out-of-bounds as solid wall (the block is bounded)', () => {
    const m = createFixedMap(GRID)
    expect(m.isWall(-1, 1)).toBe(true)
    expect(m.isWall(99, 1)).toBe(true)
    expect(m.isWall(1, -5)).toBe(true)
    expect(m.isWall(1, 99)).toBe(true)
  })

  it('returns the material char for walls, null for open', () => {
    const m = createFixedMap(GRID)
    expect(m.materialAt(0.5, 0.5)).toBe('F')
    expect(m.materialAt(3.5, 2.5)).toBe('P')
    expect(m.materialAt(1.5, 1.5)).toBeNull()
    expect(m.materialAt(-1, -1)).toBeNull()
  })

  it('preload is a no-op that does not throw', () => {
    const m = createFixedMap(GRID)
    expect(() => m.preload(0, 0)).not.toThrow()
  })
})
