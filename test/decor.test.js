import { describe, it, expect } from 'vitest'
import { createDecorSystem } from '../src/renderer/decor.js'
import { levelConfig } from '../src/renderer/levels.js'
import { DEFAULT_CONFIG } from '../src/renderer/world.js'

const open  = () => false   // no walls
const solid = () => true    // walls everywhere
const L0 = levelConfig(DEFAULT_CONFIG, 0)

describe('decor system', () => {
  it('places props and exits deterministically', () => {
    const a = createDecorSystem(L0, open); a.update(0, 0)
    const b = createDecorSystem(L0, open); b.update(0, 0)
    expect(a.getProps()).toEqual(b.getProps())
    expect(a.getExits()).toEqual(b.getExits())
  })

  it('scatters furniture props in the scan radius', () => {
    const sys = createDecorSystem(L0, open); sys.update(0, 0)
    expect(sys.getProps().length).toBeGreaterThan(0)
    for (const p of sys.getProps()) expect(L0.props.types).toContain(p.type)
  })

  it('always leaves at least one findable exit nearby', () => {
    const sys = createDecorSystem(L0, open); sys.update(0, 0)
    const exits = sys.getExits()
    expect(exits.length).toBeGreaterThan(0)
    for (const e of exits) expect(e.target).toBe(L0.exit.target)
  })

  it('nearestExit finds an exit within range and nothing beyond it', () => {
    const sys = createDecorSystem(L0, open); sys.update(0, 0)
    const e = sys.getExits()[0]
    expect(sys.nearestExit(e.x + 0.3, e.y, 1.1).key).toBe(e.key)
    expect(sys.nearestExit(e.x + 40, e.y + 40, 1.1)).toBeNull()
  })

  it('places nothing where every cell is wall', () => {
    const sys = createDecorSystem(L0, solid); sys.update(0, 0)
    expect(sys.getProps()).toHaveLength(0)
    expect(sys.getExits()).toHaveLength(0)
  })

  it('enterLevel swaps prop set and resets placement', () => {
    const sys = createDecorSystem(L0, open); sys.update(0, 0)
    const L2 = levelConfig(DEFAULT_CONFIG, 2)
    sys.enterLevel(L2); sys.update(0, 0)
    for (const p of sys.getProps()) expect(L2.props.types).toContain(p.type)
  })
})
