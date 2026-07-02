import { describe, it, expect } from 'vitest'
import { createItemSystem, MAX_SLOTS, ITEM_TYPES } from '../src/renderer/items.js'
import { DEFAULT_CONFIG } from '../src/renderer/world.js'

const openWorld = () => false          // no walls anywhere
const solidWorld = () => true          // walls everywhere

function makeSystem(isWall = openWorld, cfg = {}) {
  return createItemSystem({ ...DEFAULT_CONFIG, ...cfg }, isWall)
}

describe('item spawning', () => {
  it('is deterministic — two systems agree exactly', () => {
    const a = makeSystem(); a.update(0, 0)
    const b = makeSystem(); b.update(0, 0)
    expect(a.getWorldItems()).toEqual(b.getWorldItems())
  })

  it('spawns roughly 1 item per `density` chunks in the scan radius', () => {
    const sys = makeSystem()
    sys.update(0, 0)   // 7x7 = 49 chunks at default radius 3, density 5
    const n = sys.getWorldItems().length
    expect(n).toBeGreaterThanOrEqual(3)
    expect(n).toBeLessThanOrEqual(20)
  })

  it('only spawns known types', () => {
    const sys = makeSystem()
    sys.update(0, 0); sys.update(40, 40)
    for (const it of sys.getWorldItems()) expect(ITEM_TYPES).toContain(it.type)
  })

  it('spawns nothing when every cell is wall', () => {
    const sys = makeSystem(solidWorld)
    sys.update(0, 0)
    expect(sys.getWorldItems()).toHaveLength(0)
  })

  it('respects a custom density', () => {
    const dense  = makeSystem(openWorld, { items: { density: 1, types: ['glowstick'] } })
    dense.update(0, 0)
    expect(dense.getWorldItems().length).toBe(49)  // every chunk
    expect(dense.getWorldItems().every(i => i.type === 'glowstick')).toBe(true)
  })
})

describe('pickup & inventory', () => {
  it('picks up the nearest item and removes it from the world', () => {
    const sys = makeSystem()
    sys.update(0, 0)
    const it = sys.getWorldItems()[0]
    const near = sys.nearestItem(it.x + 0.5, it.y, 2)
    expect(near.key).toBe(it.key)
    const res = sys.pickUp(near.key)
    expect(res.ok).toBe(true)
    expect(sys.inventory).toHaveLength(1)
    expect(sys.getWorldItems().find(w => w.key === it.key)).toBeUndefined()
  })

  it('nearestItem returns null beyond range', () => {
    const sys = makeSystem()
    sys.update(0, 0)
    const it = sys.getWorldItems()[0]
    expect(sys.nearestItem(it.x + 50, it.y + 50, 1.4)).toBeNull()
  })

  it('taken items do not respawn after chunk eviction and return', () => {
    const sys = makeSystem()
    sys.update(0, 0)
    const it = sys.getWorldItems()[0]
    sys.pickUp(it.key)
    sys.update(100, 100)   // walk far away — chunk forgotten
    sys.update(0, 0)       // come back — chunk rescanned
    expect(sys.getWorldItems().find(w => w.key === it.key)).toBeUndefined()
  })

  it('rejects pickup when hands are full', () => {
    const sys = makeSystem(openWorld, { items: { density: 1, types: ['glowstick'] } })
    sys.update(0, 0)
    const items = sys.getWorldItems()
    for (let i = 0; i < MAX_SLOTS; i++) expect(sys.pickUp(items[i].key).ok).toBe(true)
    const res = sys.pickUp(items[MAX_SLOTS].key)
    expect(res).toEqual({ ok: false, reason: 'full' })
    expect(sys.inventory).toHaveLength(MAX_SLOTS)
  })
})

describe('use & selection', () => {
  function loaded(types) {
    const sys = makeSystem(openWorld, { items: { density: 1, types: ['glowstick'] } })
    sys.update(0, 0)
    // hand-load the inventory for precise control
    sys.inventory.length = 0
    for (const t of types) sys.inventory.push({ type: t })
    return sys
  }

  it('consumables are removed on use', () => {
    const sys = loaded(['almond-water', 'glowstick'])
    sys.select(0)
    expect(sys.useSelected()).toEqual({ type: 'almond-water' })
    expect(sys.inventory).toHaveLength(1)
    expect(sys.inventory[0].type).toBe('glowstick')
  })

  it('radio toggles in place and reports state', () => {
    const sys = loaded(['radio'])
    sys.select(0)
    expect(sys.useSelected()).toEqual({ type: 'radio', on: true })
    expect(sys.isRadioOn()).toBe(true)
    expect(sys.useSelected()).toEqual({ type: 'radio', on: false })
    expect(sys.isRadioOn()).toBe(false)
    expect(sys.inventory).toHaveLength(1)
  })

  it('using an empty slot returns null', () => {
    const sys = loaded([])
    expect(sys.useSelected()).toBeNull()
  })

  it('selection clamps after consuming the last item', () => {
    const sys = loaded(['almond-water', 'glowstick'])
    sys.select(1)
    sys.useSelected()               // consume slot 1 (last)
    expect(sys.selected).toBe(0)    // clamped back
    expect(sys.getSelected().type).toBe('almond-water')
  })
})
