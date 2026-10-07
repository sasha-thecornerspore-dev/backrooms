// death.js — the one owner of dying and of maxHp this release: you wake a floor above beside the hole, lighter.
import { describe, it, expect } from 'vitest'
import { MAX_HP_FLOOR, SCAR, resolveDeath, onArrive, wakeSpot } from '../src/renderer/death.js'

const cells = (...list) => { const s = new Set(list.map(([x, y]) => `${x},${y}`)); return (ix, iy) => s.has(`${ix},${iy}`) }
const base = (over = {}) => ({ level: 2, inventory: [{ type: 'almond-water' }, { type: 'radio', on: true }], selected: 0, maxHp: 100, deaths: 0, ...over })

describe('resolveDeath', () => {
  it('constants', () => { expect(MAX_HP_FLOOR).toBe(60); expect(SCAR).toBe(5) })

  it('wakes a floor above: 2 -> 1, 3 -> 2, 1 -> 0; the lobby and the block wake where they are', () => {
    expect(resolveDeath(base({ level: 2 })).wakeLevel).toBe(1)
    expect(resolveDeath(base({ level: 3 })).wakeLevel).toBe(2)
    expect(resolveDeath(base({ level: 1 })).wakeLevel).toBe(0)
    expect(resolveDeath(base({ level: 0 })).wakeLevel).toBe(0)
    expect(resolveDeath(base({ level: 4 })).wakeLevel).toBe(4)
  })

  it('vendLocked is true on every death; deaths increments; the message is the one line', () => {
    for (const level of [0, 1, 2, 3, 4]) {
      const r = resolveDeath(base({ level, deaths: 3 }))
      expect(r.vendLocked).toBe(true)
      expect(r.deaths).toBe(4)
      expect(r.message).toBe('you wake beside the hole you fell through. something of you stayed down there.')
    }
    expect(resolveDeath(base({ deaths: undefined })).deaths).toBe(1)
  })

  it('the selected consumable is lost and named; the input is not mutated; the result is a new array', () => {
    const state = base({ selected: 0 })
    const inv0 = state.inventory, snap = JSON.stringify(inv0)
    const r = resolveDeath(state)
    expect(r.inventory).not.toBe(inv0)
    expect(JSON.stringify(inv0)).toBe(snap)
    expect(r.inventory).toEqual([{ type: 'radio', on: true }])
    expect(r.inventory[0]).not.toBe(inv0[1])                             // deep copy: game.js splices in place afterwards
    expect(r.selected).toBe(0)
    expect(r.dropped).toBe('almond-water')
    expect(r.droppedLine).toBe('your hands opened. the almond-water is still down there.')
    const named = resolveDeath(base({ selected: 0, names: { 'almond-water': 'almond water' } }))
    expect(named.droppedLine).toBe('your hands opened. the almond water is still down there.')
  })

  it('a tool is kept; ballast and the extension slip are never lost; an empty hand drops nothing', () => {
    const tool = resolveDeath(base({ inventory: [{ type: 'plumb', tool: true }, { type: 'bandage' }], selected: 0 }))
    expect(tool.inventory).toEqual([{ type: 'plumb', tool: true }, { type: 'bandage' }])
    expect(tool.dropped).toBeNull(); expect(tool.droppedLine).toBeNull()
    for (const type of ['ballast', 'extension-slip']) {
      const r = resolveDeath(base({ inventory: [{ type: 'bandage' }, { type }], selected: 1 }))
      expect(r.inventory).toEqual([{ type: 'bandage' }, { type }])
      expect(r.dropped).toBeNull()
      expect(r.selected).toBe(1)
    }
    const empty = resolveDeath(base({ inventory: [], selected: 0 }))
    expect(empty.inventory).toEqual([]); expect(empty.dropped).toBeNull(); expect(empty.selected).toBe(0)
    const past = resolveDeath(base({ inventory: [{ type: 'bandage' }], selected: 4 }))   // the slot is empty: nothing to lose
    expect(past.inventory).toEqual([{ type: 'bandage' }]); expect(past.dropped).toBeNull(); expect(past.selected).toBe(0)
  })

  it('a plumb without its tool flag (an old save, reloaded) is still kept, as items.js keeps it (SD-plumb-death)', () => {
    const r = resolveDeath(base({ inventory: [{ type: 'bandage' }, { type: 'plumb' }], selected: 1 }))
    expect(r.inventory).toEqual([{ type: 'bandage' }, { type: 'plumb' }])
    expect(r.dropped).toBeNull(); expect(r.droppedLine).toBeNull()
    expect(r.selected).toBe(1)
  })

  it('selected is clamped like items.js after the loss', () => {
    const last = resolveDeath(base({ inventory: [{ type: 'bandage' }, { type: 'glowstick' }, { type: 'almond-water' }], selected: 2 }))
    expect(last.inventory).toEqual([{ type: 'bandage' }, { type: 'glowstick' }])
    expect(last.selected).toBe(1)
    const mid = resolveDeath(base({ inventory: [{ type: 'bandage' }, { type: 'glowstick' }, { type: 'almond-water' }], selected: 1 }))
    expect(mid.inventory).toEqual([{ type: 'bandage' }, { type: 'almond-water' }])
    expect(mid.selected).toBe(1)
    const only = resolveDeath(base({ inventory: [{ type: 'bandage' }], selected: 0 }))
    expect(only.inventory).toEqual([]); expect(only.selected).toBe(0)
  })

  it('maxHp loses the scar each death and floors at 60', () => {
    let hp = 100
    const seen = []
    for (let i = 0; i < 12; i++) { hp = resolveDeath(base({ maxHp: hp })).maxHp; seen.push(hp) }
    expect(seen).toEqual([95, 90, 85, 80, 75, 70, 65, 60, 60, 60, 60, 60])
    expect(resolveDeath(base({ maxHp: 62 })).maxHp).toBe(60)
    expect(resolveDeath(base({ maxHp: 50 })).maxHp).toBe(60)            // never below the floor, even from below it
  })

  it('onArrive: a first visit gives five back, capped at 100; a return gives nothing', () => {
    expect(onArrive(95, true)).toBe(100)
    expect(onArrive(100, true)).toBe(100)
    expect(onArrive(97, true)).toBe(100)
    expect(onArrive(60, true)).toBe(65)
    expect(onArrive(95, false)).toBe(95)
    expect(onArrive(60, false)).toBe(60)
  })
})

describe('wakeSpot', () => {
  const exit = { key: '0,0', x: 10.5, y: 10.5, target: 1 }
  it('picks the open 4-neighbour at distance 2 (the cell between open), else 1, facing the exit', () => {
    const a = wakeSpot(exit, () => true)
    expect(a).toMatchObject({ x: 12.5, y: 10.5 })
    expect(a.angle).toBeCloseTo(Math.PI, 12)                              // looking back west at the hole
    const b = wakeSpot(exit, cells([10, 10], [10, 11], [10, 12]))
    expect(b).toMatchObject({ x: 10.5, y: 12.5 })
    expect(b.angle).toBeCloseTo(-Math.PI / 2, 12)
    const c = wakeSpot(exit, cells([10, 10], [9, 10]))
    expect(c).toMatchObject({ x: 9.5, y: 10.5 })
    expect(c.angle).toBeCloseTo(0, 12)
    const d = wakeSpot(exit, cells([10, 10], [10, 12]))                  // distance 2 behind a wall: not along an open cardinal
    expect(d).toBeNull()
  })

  it('null when every neighbour is walled, and for no exit', () => {
    expect(wakeSpot(exit, cells([10, 10]))).toBeNull()
    expect(wakeSpot(exit, () => false)).toBeNull()
    expect(wakeSpot(null, () => true)).toBeNull()
  })
})
