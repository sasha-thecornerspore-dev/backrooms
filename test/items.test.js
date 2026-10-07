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

  it('throwSelected never passes through a one-cell wall: back against the wall, the item lands at the feet (RT-2)', () => {
    // one-cell wall at x in [11, 12); the corridor beyond (cell 12) is open
    const wallAt11 = (wx) => Math.floor(wx) === 11
    const sys = loaded(['radio'], wallAt11)
    sys.select(0)
    // the player's 0.12 wall box rests against the wall face: 1.2 u ahead is cell 12, the far side
    const r = sys.throwSelected(10.88, 10.5, 0, 7)
    expect(r.ok).toBe(true)
    expect(r.x).toBe(10.88); expect(r.y).toBe(10.5)
    expect(Math.floor(r.item.x)).not.toBe(12)
    // the probe case: x = 9.87 in cell 9, wall cell 10, cell 11 open
    const wallAt10 = (wx) => Math.floor(wx) === 10
    const sys2 = loaded(['radio'], wallAt10)
    const r2 = sys2.throwSelected(9.87, 10.5, 0, 7)
    expect(r2.x).toBe(9.87); expect(r2.y).toBe(10.5)
    // the same throw with the wall gone lands 1.2 ahead as before
    const r3 = loaded(['radio']).throwSelected(9.87, 10.5, 0, 7)
    expect(r3.x).toBeCloseTo(11.07)
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

  it('restoreDropped puts a record saved on a wall cell back on the nearest open cell centre (DS-4)', () => {
    // a single wall cell at (5, 5); everything else is floor
    const wallCell = (wx, wy) => Math.floor(wx) === 5 && Math.floor(wy) === 5
    const sys = makeSystem(wallCell)
    sys.restoreDropped([
      { x: 5.5, y: 5.5, type: 'radio', on: true, onUntil: 90 },   // inside the wall
      { x: 7.5, y: 5.5, type: 'glowstick', t0: 10 },             // on open floor: untouched
    ])
    expect(sys.getDropped()).toEqual([
      { x: 5.5, y: 4.5, type: 'radio', on: true, onUntil: 90 },   // first open neighbour in spiral order
      { x: 7.5, y: 5.5, type: 'glowstick', t0: 10 },
    ])
    // the lure now comes from the nudged, reachable spot
    expect(sys.getLures(50, 0, 0)[0]).toMatchObject({ x: 5.5, y: 4.5 })
    // enterLevel seeds through the same path
    const sys2 = makeSystem(wallCell)
    sys2.enterLevel({ items: { density: 1, types: ['bandage'] }, maze: { salt: 0 } }, null, [{ x: 5.2, y: 5.8, type: 'bandage' }])
    expect(sys2.getDropped()).toEqual([{ x: 5.5, y: 4.5, type: 'bandage' }])
    // nothing open within 3 rings: the record is kept where it was rather than lost
    const sys3 = makeSystem(solidWorld)
    sys3.restoreDropped([{ x: 5.5, y: 5.5, type: 'bandage' }])
    expect(sys3.getDropped()).toEqual([{ x: 5.5, y: 5.5, type: 'bandage' }])
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

// ── W6: caches. A cache is a dropped record plus a note (ph, oct, by, byId,
// cacheKey) riding as trailing optional fields; nothing above is changed.
import { KEPT, MAX_DROPPED } from '../src/renderer/items.js'

describe('caches: the note rides the dropped record', () => {
  const NOTE_KEYS = ['ph', 'oct', 'by', 'byId', 'cacheKey']
  function holding(types, isWall = openWorld) {
    const sys = makeSystem(isWall, { items: { density: 1, types: ['glowstick'] } })
    sys.inventory.length = 0
    for (const t of types) sys.inventory.push(typeof t === 'string' ? { type: t } : { ...t })
    return sys
  }
  const strip = (r) => { const o = { ...r }; delete o.key; return o }

  it('legacy identity: no fifth argument and note null give today\'s records and rows', () => {
    for (const note of [undefined, null]) {
      const sys = holding(['bandage', { type: 'radio', on: true }, { type: 'almond-water', sour: true }])
      const args = (now) => note === undefined ? [10.5, 10.5, 0, now] : [10.5, 10.5, 0, now, note]
      const a = sys.throwSelected(...args(5)).item
      expect(a).toEqual({ key: 'd:0', x: a.x, y: 10.5, type: 'bandage' })
      expect(Object.keys(a)).toEqual(['key', 'x', 'y', 'type'])
      const b = sys.throwSelected(...args(5)).item
      expect(b).toEqual({ key: 'd:1', x: b.x, y: 10.5, type: 'radio', on: true, onUntil: 185 })
      expect(Object.keys(b)).toEqual(['key', 'x', 'y', 'type', 'on', 'onUntil'])
      const c = sys.throwSelected(...args(5)).item
      expect(c).toEqual({ key: 'd:2', x: c.x, y: 10.5, type: 'almond-water', sour: true })
      expect(Object.keys(c)).toEqual(['key', 'x', 'y', 'type', 'sour'])
      expect(sys.getDropped()).toEqual([
        { x: a.x, y: 10.5, type: 'bandage' },
        { x: b.x, y: 10.5, type: 'radio', on: true, onUntil: 185 },
        { x: c.x, y: 10.5, type: 'almond-water', sour: true },
      ])
    }
  })

  it('a note on a sour water keeps sour and carries ph / oct / by / byId; getDropped and restoreDropped carry them', () => {
    const sys = holding([{ type: 'almond-water', sour: true }])
    const r = sys.throwSelected(5.5, 5.5, 0, 3, { ph: 3, oct: 5, by: 'maddie', byId: 'id9' })
    expect(r.ok).toBe(true)
    expect(r.item).toMatchObject({ type: 'almond-water', sour: true, ph: 3, oct: 5, by: 'maddie', byId: 'id9' })
    expect(r.item.cacheKey).toBeUndefined()
    // game.js only knows the landing cell after the throw: the key is written onto the live record
    r.item.cacheKey = 'c:1:5,5'
    const rows = sys.getDropped()
    expect(rows).toEqual([{ x: r.x, y: 5.5, type: 'almond-water', sour: true, ph: 3, oct: 5, by: 'maddie', byId: 'id9', cacheKey: 'c:1:5,5' }])
    const fresh = holding([])
    fresh.restoreDropped(JSON.parse(JSON.stringify(rows)))
    expect(fresh.getDropped()).toEqual(rows)
    expect(strip(fresh.getWorldItems()[0])).toEqual(strip(r.item))
  })

  it('the item\'s own flags ride under the note: a talking radio keeps talking', () => {
    const sys = holding([{ type: 'radio', on: true }])
    const r = sys.throwSelected(5.5, 5.5, 0, 10, { ph: 0, oct: 1, by: 'm', byId: undefined })
    expect(r.item).toEqual({ key: 'd:0', x: r.x, y: 5.5, type: 'radio', on: true, onUntil: 190, ph: 0, oct: 1, by: 'm' })
    expect(sys.inventory).toHaveLength(0)
  })

  it('dropAt checks the note fields: integers, strings, slices', () => {
    const sys = makeSystem(solidWorld)
    const a = sys.dropAt(1, 1, 'bandage', { ph: 1.5, oct: '3', by: 7, byId: 9, cacheKey: {} }, 0)
    for (const k of NOTE_KEYS) expect(a).not.toHaveProperty(k)
    const b = sys.dropAt(1, 1, 'bandage', { ph: -1, oct: 7, by: 'x'.repeat(30), byId: 'id', cacheKey: 'c:1:' + '9'.repeat(60) }, 0)
    expect(b.ph).toBe(-1)
    expect(b.oct).toBe(7)
    expect(b.by).toBe('x'.repeat(24))
    expect(b.byId).toBe('id')
    expect(b.cacheKey).toHaveLength(48)
    const c = sys.dropAt(2, 2, 'radio', { on: true }, 0)
    expect(Object.keys(c)).toEqual(['key', 'x', 'y', 'type', 'on', 'onUntil'])
    const d = sys.dropAt(2, 2, 'glowstick', {}, 4)
    expect(Object.keys(d)).toEqual(['key', 'x', 'y', 'type', 't0'])
  })

  it('pickUp of a cache hands over the thing, not the note; res.item keeps the note', () => {
    const sys = makeSystem(solidWorld)
    const it = sys.dropAt(1, 1, 'almond-water', { sour: true, tool: true, on: true, ph: 4, oct: 2, by: 'maddie', byId: 'id9', cacheKey: 'c:1:1,1' }, null)
    const res = sys.pickUp(it.key)
    expect(res.ok).toBe(true)
    expect(res.item).toBe(it)
    expect(res.item).toMatchObject({ ph: 4, oct: 2, by: 'maddie', byId: 'id9', cacheKey: 'c:1:1,1' })
    expect(sys.inventory[0]).toEqual({ type: 'almond-water', on: true, sour: true, tool: true })
    expect(sys.pickUp(it.key)).toEqual({ ok: false, reason: 'gone' })
  })

  it('takeDropped: a friend took it — out of the world, never into the hand', () => {
    const sys = makeSystem(solidWorld)
    sys.inventory.push({ type: 'bandage' })
    const it = sys.dropAt(4, 4, 'radio', { ph: 1, oct: 1, cacheKey: 'c:1:4,4' }, 0)
    sys.isDirty()
    expect(sys.takeDropped('d:0')).toBe(it)
    expect(sys.inventory).toHaveLength(1)
    expect(sys.isDirty()).toBe(true)
    expect(sys.isDirty()).toBe(false)
    expect(sys.nearestItem(4, 4)).toBeNull()
    expect(sys.getWorldItems()).toEqual([])
    for (const k of ['d:0', 'd:99', '0,0', null, undefined, 7]) expect(sys.takeDropped(k)).toBeNull()
    expect(sys.isDirty()).toBe(false)
    // a chunk spawn is not taken this way
    const w = makeSystem()
    w.update(0, 0)
    const spawn = w.getWorldItems()[0]
    w.isDirty()
    expect(w.takeDropped(spawn.key)).toBeNull()
    expect(w.getWorldItems()).toContain(spawn)
    expect(w.isDirty()).toBe(false)
  })

  it('MAX_DROPPED eviction counts caches: 25 noted drops keep the newest 24', () => {
    const sys = makeSystem(solidWorld)
    for (let i = 0; i < 25; i++) sys.dropAt(i, 0, 'bandage', { ph: 1, oct: 0, cacheKey: `c:1:${i},0` }, 0)
    const rows = sys.getDropped()
    expect(rows).toHaveLength(MAX_DROPPED)
    expect(rows[0].cacheKey).toBe('c:1:1,0')
    expect(rows[23].cacheKey).toBe('c:1:24,0')
  })

  it('KEPT is exported: plumb, ballast, the extension slip — and they are still kept', () => {
    expect([...KEPT].sort()).toEqual(['ballast', 'extension-slip', 'plumb'])
    for (const type of ['plumb', 'ballast', 'extension-slip']) {
      const sys = holding([{ type }])
      expect(sys.throwSelected(0, 0, 0, 0, { ph: 1, oct: 0 })).toEqual({ ok: false, reason: 'kept' })
      expect(sys.inventory).toHaveLength(1)
    }
    expect(holding([{ type: 'bandage', tool: true }]).throwSelected(0, 0, 0, 0, { ph: 1, oct: 0 })).toEqual({ ok: false, reason: 'kept' })
  })
})