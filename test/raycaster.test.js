import { describe, it, expect } from 'vitest'
import { castRay } from '../src/renderer/raycaster.js'

// Minimal wall grid for testing: wall at integer cell (5, 2)
const testWall = (wx, wy) => Math.floor(wx) === 5 && Math.floor(wy) === 2

describe('castRay', () => {
  it('returns an object with dist, side, wallX', () => {
    const r = castRay(0.5, 0.5, 0, () => false)
    expect(r).toHaveProperty('dist')
    expect(r).toHaveProperty('side')
    expect(r).toHaveProperty('wallX')
  })

  it('returns maxDist when no wall is found', () => {
    const r = castRay(0.5, 0.5, 0, () => false, 96)
    expect(r.dist).toBeGreaterThanOrEqual(96)
  })

  it('hits a wall directly ahead', () => {
    // Player at (5.5, 5.5), facing up (-PI/2), wall at y=2
    const r = castRay(5.5, 5.5, -Math.PI / 2, testWall)
    expect(r.dist).toBeGreaterThan(0)
    expect(r.dist).toBeLessThan(4)
  })

  it('wallX is between 0 and 1', () => {
    const r = castRay(5.5, 5.5, -Math.PI / 2, testWall)
    expect(r.wallX).toBeGreaterThanOrEqual(0)
    expect(r.wallX).toBeLessThan(1)
  })

  it('side is 0 or 1', () => {
    const r = castRay(5.5, 5.5, -Math.PI / 2, testWall)
    expect(r.side === 0 || r.side === 1).toBe(true)
  })

  it('dist increases with distance to wall', () => {
    // Wall at x=10, player moving right from x=1 vs x=5
    const wallRight = (wx, wy) => Math.floor(wx) === 10
    const near = castRay(5.5, 0.5, 0, wallRight)
    const far  = castRay(1.5, 0.5, 0, wallRight)
    expect(far.dist).toBeGreaterThan(near.dist)
  })
})
