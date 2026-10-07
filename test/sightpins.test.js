// sightpins.js — what goes on the map because you SAW it: the sprite pass's own cone and line of sight, run on the cell-change tick.
import { describe, it, expect } from 'vitest'
import { visibleWays, SIGHT_LINES, PROX_PIN } from '../src/renderer/sightpins.js'
import { SIGHT_TYPES } from '../src/renderer/decor.js'
import { HF } from '../src/renderer/gfx-frame.js'

const open = () => true
const wallAt = (wx, wy) => (ix, iy) => !(ix === wx && iy === wy)
const player = (x, y, angle = 0) => ({ x, y, angle })
const rec = (key, x, y) => ({ key, x, y, kind: 'down' })

describe('visibleWays', () => {
  it('pins a way straight ahead with no wall between', () => {
    const out = []
    const list = [rec('a', 8.5, 0.5)]
    expect(visibleWays(player(0.5, 0.5), list, open, 20, HF, out)).toBe(1)
    expect(out[0]).toBe(list[0])
    expect(out.length).toBe(1)
  })

  it('does not pin the same way behind a wall', () => {
    const out = []
    expect(visibleWays(player(0.5, 0.5), [rec('a', 8.5, 0.5)], wallAt(4, 0), 20, HF, out)).toBe(0)
    expect(out.length).toBe(0)
  })

  it('does not pin a way behind the player, nor one beyond reach, nor one too close to be drawn', () => {
    const out = []
    expect(visibleWays(player(0.5, 0.5), [rec('b', -8.5, 0.5)], open, 20, HF, out)).toBe(0)
    expect(visibleWays(player(0.5, 0.5), [rec('c', 40.5, 0.5)], open, 20, HF, out)).toBe(0)
    expect(visibleWays(player(0.5, 0.5), [rec('d', 0.7, 0.5)], open, 20, HF, out)).toBe(0)
    expect(visibleWays(player(0.5, 0.5, Math.PI), [rec('e', -8.5, 0.5)], open, 20, HF, out)).toBe(1)
  })

  it('the cone is the sprite cull: far to the side is out, a little to the side is in', () => {
    const out = []
    expect(visibleWays(player(0.5, 0.5), [rec('s', 6.5, 2.5)], open, 20, HF, out)).toBe(1)
    expect(visibleWays(player(0.5, 0.5), [rec('t', 2.5, 12.5)], open, 20, HF, out)).toBe(0)
  })

  it('reuses `out` and trims it to the count, several records in list order', () => {
    const out = []
    const list = [rec('a', 3.5, 0.5), rec('x', -3.5, 0.5), rec('b', 9.5, 1.5), rec('far', 60.5, 0.5)]
    const n = visibleWays(player(0.5, 0.5), list, open, 20, HF, out)
    expect(n).toBe(2)
    expect(out.length).toBe(2)
    expect(out[0]).toBe(list[0]); expect(out[1]).toBe(list[2])
    const n2 = visibleWays(player(0.5, 0.5), [list[0]], open, 20, HF, out)
    expect(n2).toBe(1)
    expect(out.length).toBe(1)
    expect(visibleWays(player(0.5, 0.5), [], open, 20, HF, out)).toBe(0)
    expect(out.length).toBe(0)
  })

  it('never asks the grid about a record that is out of reach or out of the cone', () => {
    let asks = 0
    const grid = () => { asks++; return true }
    visibleWays(player(0.5, 0.5), [rec('far', 60.5, 0.5), rec('behind', -5.5, 0.5)], grid, 20, HF, [])
    expect(asks).toBe(0)
  })
})

describe('SIGHT_LINES', () => {
  it('covers every SIGHT_TYPES entry with a name and a line, all lowercase and understated', () => {
    for (const t of SIGHT_TYPES) {
      expect(SIGHT_LINES[t]).toBeDefined()
      expect(typeof SIGHT_LINES[t].name).toBe('string')
      expect(typeof SIGHT_LINES[t].line).toBe('string')
      expect(SIGHT_LINES[t].line).toBe(SIGHT_LINES[t].line.toLowerCase())
      expect(SIGHT_LINES[t].line).not.toContain('!')
    }
    expect(Object.keys(SIGHT_LINES).sort()).toEqual([...SIGHT_TYPES].sort())
    expect(SIGHT_LINES.payphone).toEqual({ name: 'the payphone', line: 'a payphone. the cord has been cut. it is ringing.' })
    expect(SIGHT_LINES.mannequin.line).toBe('a mannequin, facing the wall. it was not facing the wall.')
  })

  it('things pin by proximity at 4.5', () => {
    expect(PROX_PIN).toBe(4.5)
  })
})
