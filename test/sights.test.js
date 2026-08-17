import { describe, it, expect } from 'vitest'
import { createDecorSystem, SIGHT_TYPES } from '../src/renderer/decor.js'
import { levelConfig } from '../src/renderer/levels.js'
import { DEFAULT_CONFIG } from '../src/renderer/world.js'

const open = () => false
const solid = () => true
// denser than shipping so the scan radius reliably contains sights to assert on
const L0 = { ...levelConfig(DEFAULT_CONFIG, 0), sights: { denom: 4 } }

describe('landmark sight placement', () => {
  it('places sights deterministically, each with a valid type', () => {
    const a = createDecorSystem(L0, open); a.update(0, 0)
    const b = createDecorSystem(L0, open); b.update(0, 0)
    expect(a.getSights()).toEqual(b.getSights())
    expect(a.getSights().length).toBeGreaterThan(0)
    for (const s of a.getSights()) expect(SIGHT_TYPES).toContain(s.type)
  })

  it('places none in solid walls, or when denom is 0', () => {
    const walled = createDecorSystem(L0, solid); walled.update(0, 0)
    expect(walled.getSights()).toHaveLength(0)
    const off = createDecorSystem({ ...L0, sights: { denom: 0 } }, open); off.update(0, 0)
    expect(off.getSights()).toHaveLength(0)
  })

  it('adding sights does not perturb props / exits / npcs / scraps / machines', () => {
    const on  = createDecorSystem(L0, open); on.update(0, 0)
    const off = createDecorSystem({ ...L0, sights: { denom: 0 } }, open); off.update(0, 0)
    expect(on.getProps()).toEqual(off.getProps())
    expect(on.getExits()).toEqual(off.getExits())
    expect(on.getNpcs()).toEqual(off.getNpcs())
    expect(on.getScraps()).toEqual(off.getScraps())
    expect(on.getMachines()).toEqual(off.getMachines())
    expect(on.getSights().length).toBeGreaterThan(0)
    expect(off.getSights().length).toBe(0)
  })
})
