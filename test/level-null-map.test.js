import { describe, it, expect } from 'vitest'
import { NULL_MAP, NULL_SPAWN, NULL_EXIT } from '../src/renderer/level-null-map.js'
import { createFixedMap } from '../src/renderer/fixedmap.js'

// flood fill over open cells — is the exit reachable on foot from spawn?
function reachable(map, sx, sy, tx, ty) {
  const m = createFixedMap(map), seen = new Set(), q = [[Math.floor(sx), Math.floor(sy)]]
  const key = (x, y) => `${x},${y}`
  seen.add(key(Math.floor(sx), Math.floor(sy)))
  while (q.length) {
    const [x, y] = q.pop()
    if (x === Math.floor(tx) && y === Math.floor(ty)) return true
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy, k = key(nx, ny)
      if (!seen.has(k) && !m.isWall(nx + 0.5, ny + 0.5)) { seen.add(k); q.push([nx, ny]) }
    }
  }
  return false
}

describe('Level ∅ map', () => {
  it('is a non-trivial enclosed block', () => {
    expect(NULL_MAP.length).toBeGreaterThan(12)
    expect(NULL_MAP[0]).toMatch(/^[^.\s]+$/)                       // solid top edge
    expect(NULL_MAP[NULL_MAP.length - 1]).toMatch(/^[^.\s]+$/)     // solid bottom edge
  })

  it('spawns the player in an open cell', () => {
    const m = createFixedMap(NULL_MAP)
    expect(m.isWall(NULL_SPAWN.x, NULL_SPAWN.y)).toBe(false)
  })

  it('exit is an open cell reachable from spawn (there is always a way down)', () => {
    const m = createFixedMap(NULL_MAP)
    expect(m.isWall(NULL_EXIT.x, NULL_EXIT.y)).toBe(false)
    expect(reachable(NULL_MAP, NULL_SPAWN.x, NULL_SPAWN.y, NULL_EXIT.x, NULL_EXIT.y)).toBe(true)
  })

  it('uses only known material codes', () => {
    const ok = new Set(['.', ' ', 'F', 'C', 'P', 'B', 'W', 'O', 'M', 'X'])
    for (const row of NULL_MAP) for (const ch of row) expect(ok.has(ch)).toBe(true)
  })

  it('interleaves occupied houses among the sealed ones (non-negotiable)', () => {
    const joined = NULL_MAP.join('')
    expect(joined.includes('O')).toBe(true)   // lived-in
    expect(joined.includes('C')).toBe(true)   // CMU-sealed
  })
})
