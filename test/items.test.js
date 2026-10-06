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

describe('tools (read on every press, never consumed)', () => {
  function withTool() {
    const sys = makeSystem()
    sys.inventory.length = 0
    sys.inventory.push({ type: 'plumb', tool: true }, { type: 'glowstick' })
    return sys
  }

  it('grant carries the tool flag through to the inventory', () => {
    const sys = makeSystem()
    sys.inventory.length = 0
    expect(sys.grant('plumb', { tool: true })).toEqual({ ok: true })
    expect(sys.inventory[0]).toEqual({ type: 'plumb', tool: true })
  })

  it('a tool reads on every press and is never spliced away', () => {
    const sys = withTool()
    sys.select(0)
    expect(sys.useSelected()).toEqual({ type: 'plumb', tool: true })
    expect(sys.useSelected()).toEqual({ type: 'plumb', tool: true })   // still there
    expect(sys.inventory).toHaveLength(2)
    expect(sys.inventory[0]).toEqual({ type: 'plumb', tool: true })
  })

  it('discard still removes a tool (unlike use, which only reads it)', () => {
    const sys = withTool()
    sys.select(0)
    expect(sys.discardSelected()).toEqual({ type: 'plumb' })
    expect(sys.inventory.map(i => i.type)).toEqual(['glowstick'])
  })
})

describe('discard', () => {
  function loaded(types) {
    const sys = makeSystem(openWorld, { items: { density: 1, types: ['glowstick'] } })
    sys.inventory.length = 0
    for (const t of types) sys.inventory.push({ type: t })
    return sys
  }

  it('drops the selected item and returns its type', () => {
    const sys = loaded(['almond-water', 'radio'])
    sys.select(0)
    expect(sys.discardSelected()).toEqual({ type: 'almond-water' })
    expect(sys.inventory.map(i => i.type)).toEqual(['radio'])
  })

  it('drops even the radio (unlike use, which toggles it)', () => {
    const sys = loaded(['radio'])
    sys.select(0)
    expect(sys.discardSelected()).toEqual({ type: 'radio' })
    expect(sys.inventory).toHaveLength(0)
  })

  it('returns null on an empty slot', () => {
    const sys = loaded([])
    expect(sys.discardSelected()).toBeNull()
  })

  it('clamps selection after dropping the last slot', () => {
    const sys = loaded(['almond-water', 'glowstick'])
    sys.select(1)
    sys.discardSelected()
    expect(sys.selected).toBe(0)
    expect(sys.getSelected().type).toBe('almond-water')
  })
})

describe('enterLevel', () => {
  it('wipes world items and rescans with the new level type set, keeping inventory', () => {
    const sys = makeSystem()
    sys.update(0, 0)
    sys.inventory.push({ type: 'polaroid' })
    expect(sys.getWorldItems().length).toBeGreaterThan(0)

    sys.enterLevel({ items: { density: 1, types: ['bandage'] }, maze: { salt: 0x99 } })
    expect(sys.getWorldItems()).toHaveLength(0)   // cleared until next scan
    expect(sys.inventory.map(i => i.type)).toEqual(['polaroid']) // inventory survives

    sys.update(0, 0)
    expect(sys.getWorldItems().every(i => i.type === 'bandage')).toBe(true)
  })
})

// ── dropped items (fight-verbs): set something down and the floor keeps it ──
describe('dropped items', () => {
  function loaded(types, isWall = openWorld) {
    const sys = makeSystem(isWall, { items: { density: 1, types: ['glowstick'] } })
    sys.inventory.length = 0
    for (const t of types) sys.inventory.push(typeof t === 'string' ? { type: t } : t)
    return sys
  }

  it('dropAt then nearestItem finds it, keyed d:n, and getWorldItems lists it', () => {
    const sys = makeSystem(solidWorld)          // no spawns: only what we drop
    sys.update(0, 0)
    const it = sys.dropAt(5.5, 5.5, 'bandage', {}, 10)
    expect(it.key).toBe('d:0')
    expect(sys.nearestItem(5.9, 5.5)).toBe(it)
    expect(sys.getWorldItems()).toEqual([it])
    expect(sys.dropAt(6.5, 5.5, 'glowstick', {}, 10).key).toBe('d:1')
  })

  it('pickUp of a dropped key returns the item and the slot count rises; a dropped radio keeps on', () => {
    const sys = makeSystem(solidWorld)
    const it = sys.dropAt(5.5, 5.5, 'radio', { on: true }, 0)
    const res = sys.pickUp(it.key)
    expect(res.ok).toBe(true)
    expect(res.item).toBe(it)
    expect(sys.inventory).toHaveLength(1)
    expect(sys.inventory[0]).toEqual({ type: 'radio', on: true })
    expect(sys.getWorldItems()).toHaveLength(0)
    expect(sys.isRadioOn()).toBe(true)
    // taken is for chunk spawns only: a d: key never lands there
    expect(sys.exportTaken()).toEqual([])
    expect(sys.pickUp(it.key)).toEqual({ ok: false, reason: 'gone' })
  })

  it('pickUp of a dropped item respects full hands', () => {
    const sys = loaded(['glowstick', 'glowstick', 'glowstick', 'glowstick', 'glowstick', 'glowstick'])
    const it = sys.dropAt(1, 1, 'bandage', {}, 0)
    expect(sys.pickUp(it.key)).toEqual({ ok: false, reason: 'full' })
    expect(sys.getWorldItems()).toContain(it)
  })

  it('25 drops keep the newest 24', () => {
    const sys = makeSystem(solidWorld)
    for (let i = 0; i < 25; i++) sys.dropAt(i, 0, 'bandage', {}, 0)
    const keys = sys.getWorldItems().map(i => i.key)
    expect(keys).toHaveLength(24)
    expect(keys[0]).toBe('d:1')
    expect(keys[23]).toBe('d:24')
  })

  it('a dropped item survives update() far away (never chunk-evicted)', () => {
    const sys = makeSystem()
    sys.update(0, 0)
    const it = sys.dropAt(3.5, 3.5, 'polaroid', {}, 0)
    sys.update(100, 100)
    sys.update(-100, 50)
    expect(sys.getWorldItems()).toContain(it)
    sys.update(0, 0)
    expect(sys.getWorldItems()).toContain(it)
  })

  it('throwSelected lands 1.2 ahead on open floor and removes the item from the hand', () => {
    const sys = loaded(['bandage', 'glowstick'])
    sys.select(0)
    const r = sys.throwSelected(10.5, 10.5, 0, 7)
    expect(r.ok).toBe(true)
    expect(r.x).toBeCloseTo(11.7); expect(r.y).toBeCloseTo(10.5)
    expect(r.item.type).toBe('bandage')
    expect(r.item.x).toBeCloseTo(11.7)
    expect(sys.inventory.map(i => i.type)).toEqual(['glowstick'])
    expect(sys.getWorldItems()).toContain(r.item)
  })

  it('throwSelected lands at the feet when the cell ahead is a wall', () => {
    const wallAt11 = (wx) => Math.floor(wx) === 11
    const sys = loaded(['bandage'], wallAt11)
    sys.select(0)
    const r = sys.throwSelected(10.5, 10.5, 0, 7)
    expect(r.ok).toBe(true)
    expect(r.x).toBe(10.5); expect(r.y).toBe(10.5)
    // facing the other way the cell ahead is open
    const sys2 = loaded(['bandage'], wallAt11)
    const r2 = sys2.throwSelected(10.5, 10.5, Math.PI, 7)
    expect(r2.x).toBeCloseTo(9.3)
  })

  it('plumb, ballast and the extension slip are kept; an empty hand reports empty', () => {
    for (const type of ['plumb', 'ballast', 'extension-slip']) {
      const sys = loaded([{ type, ...(type === 'plumb' ? { tool: true } : {}) }])
      expect(sys.throwSelected(0, 0, 0, 0)).toEqual({ ok: false, reason: 'kept' })
      expect(sys.inventory).toHaveLength(1)
    }
    expect(loaded([]).throwSelected(0, 0, 0, 0)).toEqual({ ok: false, reason: 'empty' })
  })

  it('a thrown radio keeps on and gains onUntil = now + 180; a glowstick gains t0 = now', () => {
    const sys = loaded([{ type: 'radio', on: true }, 'glowstick'])
    sys.select(0)
    const r = sys.throwSelected(2.5, 2.5, 0, 50)
    expect(r.item).toMatchObject({ type: 'radio', on: true, onUntil: 230 })
    sys.select(0)
    const g = sys.throwSelected(2.5, 2.5, 0, 60)
    expect(g.item).toMatchObject({ type: 'glowstick', t0: 60 })
    expect(g.item.onUntil).toBeUndefined()
    // an off radio gets no battery clock
    const sys2 = loaded([{ type: 'radio' }])
    expect(sys2.throwSelected(2.5, 2.5, 0, 50).item.onUntil).toBeUndefined()
  })

  it('throwSelected clamps the selection like discard', () => {
    const sys = loaded(['almond-water', 'glowstick'])
    sys.select(1)
    sys.throwSelected(0.5, 0.5, 0, 0)
    expect(sys.selected).toBe(0)
    expect(sys.getSelected().type).toBe('almond-water')
  })

  it('enterLevel() empties dropped and seeds taken/dropped from its arguments', () => {
    const sys = makeSystem()
    sys.update(0, 0)
    const spawned = sys.getWorldItems()[0]
    sys.dropAt(1, 1, 'bandage', {}, 0)
    sys.enterLevel({ items: { density: 1, types: ['bandage'] }, maze: { salt: 0x99 } })
    expect(sys.getWorldItems()).toHaveLength(0)
    expect(sys.getDropped()).toEqual([])
    // seeded: the taken key stays taken, the dropped list comes back
    sys.enterLevel({ items: { density: 1, types: ['bandage'] }, maze: { salt: 0 } },
      [spawned.key], [{ x: 4.5, y: 4.5, type: 'radio', on: true, onUntil: 90 }])
    expect(sys.exportTaken()).toEqual([spawned.key])
    expect(sys.getDropped()).toEqual([{ x: 4.5, y: 4.5, type: 'radio', on: true, onUntil: 90 }])
    sys.update(0, 0)
    expect(sys.getWorldItems().find(w => w.key === spawned.key)).toBeUndefined()
    expect(sys.getWorldItems().filter(w => w.type === 'radio')).toHaveLength(1)
  })

  it('restoreDropped round-trips on:true, onUntil and t0', () => {
    const a = makeSystem(solidWorld)
    a.dropAt(1.5, 2.5, 'radio', { on: true }, 100)
    a.dropAt(3.5, 2.5, 'glowstick', {}, 100)
    a.dropAt(5.5, 2.5, 'bandage', {}, 100)
    const list = a.getDropped()
    expect(list).toEqual([
      { x: 1.5, y: 2.5, type: 'radio', on: true, onUntil: 280 },
      { x: 3.5, y: 2.5, type: 'glowstick', t0: 100 },
      { x: 5.5, y: 2.5, type: 'bandage' },
    ])
    const b = makeSystem(solidWorld)
    b.restoreDropped(list)
    expect(b.getDropped()).toEqual(list)
    expect(b.getWorldItems().map(i => i.type)).toEqual(['radio', 'glowstick', 'bandage'])
    expect(b.getLures(150, 0, 0)).toHaveLength(1)
  })

  it('expireDropped reports battery at onUntil and gutter at t0 + 240', () => {
    const sys = makeSystem(solidWorld)
    const r = sys.dropAt(1.5, 1.5, 'radio', { on: true }, 0)       // onUntil 180
    const g = sys.dropAt(2.5, 1.5, 'glowstick', {}, 0)             // gutters at 240
    expect(sys.expireDropped(179.9)).toEqual([])
    expect(sys.expireDropped(180)).toEqual([{ kind: 'battery', key: r.key }])
    expect(r.on).toBe(false)
    expect(sys.getWorldItems()).toContain(r)                       // a dead radio stays on the floor
    expect(sys.getLures(181, 0, 0)).toHaveLength(0)
    expect(sys.expireDropped(239.9)).toEqual([])
    expect(sys.expireDropped(240)).toEqual([{ kind: 'gutter', key: g.key }])
    expect(sys.getWorldItems()).not.toContain(g)
    expect(sys.expireDropped(1000)).toEqual([])
  })

  it('expireDropped reuses its events array', () => {
    const sys = makeSystem(solidWorld)
    sys.dropAt(1.5, 1.5, 'glowstick', {}, 0)
    const a = sys.expireDropped(1)
    const b = sys.expireDropped(240)
    expect(b).toBe(a)
    expect(b).toHaveLength(1)
    expect(sys.expireDropped(241)).toHaveLength(0)
  })

  it('getLures hands lures to tactics: the two nearest live radios', () => {
    const sys = makeSystem(solidWorld)
    sys.dropAt(9, 0, 'radio', { on: true }, 0)
    sys.dropAt(1, 0, 'radio', { on: true }, 0)
    sys.dropAt(5, 0, 'radio', { on: true }, 0)
    sys.dropAt(0.5, 0, 'radio', { on: false }, 0)
    expect(sys.getLures(10, 0, 0).map(l => l.x)).toEqual([1, 5])
    expect(sys.getLures(500, 0, 0)).toEqual([])
  })

  it('peekSelected does not consume, consumeSelected does', () => {
    const sys = loaded(['bandage', { type: 'almond-water', sour: true }])
    sys.select(0)
    expect(sys.peekSelected()).toEqual({ type: 'bandage' })
    expect(sys.peekSelected()).toBe(sys.inventory[0])
    expect(sys.inventory).toHaveLength(2)
    expect(sys.consumeSelected()).toEqual({ type: 'bandage' })
    expect(sys.inventory.map(i => i.type)).toEqual(['almond-water'])
    expect(sys.consumeSelected()).toEqual({ type: 'almond-water', sour: true })
    expect(sys.inventory).toHaveLength(0)
    expect(sys.peekSelected()).toBeNull()
    expect(sys.consumeSelected()).toBeNull()
  })

  it('isDirty is true once after any dropped/taken change and then clears', () => {
    const sys = makeSystem()
    sys.isDirty()                                  // construction noise consumed
    expect(sys.isDirty()).toBe(false)
    const it = sys.dropAt(1, 1, 'bandage', {}, 0)
    expect(sys.isDirty()).toBe(true)
    expect(sys.isDirty()).toBe(false)
    sys.pickUp(it.key)
    expect(sys.isDirty()).toBe(true)
    expect(sys.isDirty()).toBe(false)
    sys.update(0, 0)
    expect(sys.isDirty()).toBe(false)              // a scan alone changes nothing
    sys.pickUp(sys.getWorldItems()[0].key)         // taken changed
    expect(sys.isDirty()).toBe(true)
    const r = sys.dropAt(2, 2, 'radio', { on: true }, 0)
    sys.isDirty()
    sys.expireDropped(100)
    expect(sys.isDirty()).toBe(false)              // nothing expired yet
    sys.expireDropped(r.onUntil)
    expect(sys.isDirty()).toBe(true)
    sys.enterLevel({ items: { density: 5 } })
    expect(sys.isDirty()).toBe(true)               // the floor changed under us
  })
})
