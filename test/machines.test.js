import { describe, it, expect } from 'vitest'
import { createDecorSystem } from '../src/renderer/decor.js'
import { createItemSystem } from '../src/renderer/items.js'
import { levelConfig } from '../src/renderer/levels.js'
import { DEFAULT_CONFIG } from '../src/renderer/world.js'

const open = () => false
const solid = () => true
const L0 = levelConfig(DEFAULT_CONFIG, 0)   // Lobby — machines denom 16

describe('vending machine placement', () => {
  it('places machines deterministically', () => {
    const a = createDecorSystem(L0, open); a.update(0, 0)
    const b = createDecorSystem(L0, open); b.update(0, 0)
    expect(a.getMachines()).toEqual(b.getMachines())
    expect(a.getMachines().length).toBeGreaterThan(0)
  })

  it('places none in solid walls, or when denom is 0', () => {
    const walled = createDecorSystem(L0, solid); walled.update(0, 0)
    expect(walled.getMachines()).toHaveLength(0)
    const off = createDecorSystem({ ...L0, machines: { denom: 0 } }, open); off.update(0, 0)
    expect(off.getMachines()).toHaveLength(0)
  })

  it('nearestMachine finds within range and nothing beyond it', () => {
    const sys = createDecorSystem(L0, open); sys.update(0, 0)
    const m = sys.getMachines()[0]
    expect(sys.nearestMachine(m.x + 0.2, m.y, 1.6).key).toBe(m.key)
    expect(sys.nearestMachine(m.x + 40, m.y + 40, 1.6)).toBeNull()
  })

  // golden guard: the machine channel must not perturb any earlier placement
  it('adding machines does not perturb props / exits / npcs / scraps', () => {
    const on  = createDecorSystem({ ...L0, machines: { denom: 16 } }, open); on.update(0, 0)
    const off = createDecorSystem({ ...L0, machines: { denom: 0 } }, open); off.update(0, 0)
    expect(on.getProps()).toEqual(off.getProps())
    expect(on.getExits()).toEqual(off.getExits())
    expect(on.getNpcs()).toEqual(off.getNpcs())
    expect(on.getScraps()).toEqual(off.getScraps())
    expect(on.getMachines().length).toBeGreaterThan(0)
    expect(off.getMachines().length).toBe(0)
  })
})

describe('items.grant (vending dispense)', () => {
  const sys = () => createItemSystem(L0, open)

  it('grants an item into the inventory', () => {
    const s = sys()
    expect(s.grant('bandage').ok).toBe(true)
    expect(s.inventory.at(-1)).toEqual({ type: 'bandage' })
  })

  it('refuses once the 6 slots are full', () => {
    const s = sys()
    for (let i = 0; i < 6; i++) expect(s.grant('bandage').ok).toBe(true)
    const r = s.grant('bandage')
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('full')
    expect(s.inventory.length).toBe(6)
  })

  it('carries the sour flag through use(), and a normal grant does not', () => {
    const s = sys()
    s.grant('almond-water', { sour: true })
    s.select(s.inventory.length - 1)
    expect(s.useSelected()).toEqual({ type: 'almond-water', sour: true })
    s.grant('almond-water')
    s.select(s.inventory.length - 1)
    expect(s.useSelected()).toEqual({ type: 'almond-water' })
  })
})
