import { describe, it, expect } from 'vitest'
import { createItemSystem } from '../src/renderer/items.js'
import { createDecorSystem } from '../src/renderer/decor.js'
import { levelConfig } from '../src/renderer/levels.js'
import { DEFAULT_CONFIG } from '../src/renderer/world.js'

// Phase 1b: the world seed must reach items, props, exits and NPCs — not just
// walls. Before this, every world had byte-identical furniture at the same
// chunks, so "your county is your world" was a hash of the walls with a name
// taped on: Howard County and Baltimore had the same radio in the same room.

const open = () => false            // no walls — placement is pure hash
const L0 = levelConfig(DEFAULT_CONFIG, 0)

const items = (sys) => { sys.update(0, 0); return JSON.stringify(sys.getWorldItems()) }
const decor = (sys) => {
  sys.update(0, 0)
  return JSON.stringify({ props: sys.getProps(), exits: sys.getExits(), npcs: sys.getNpcs?.() ?? [] })
}

describe('items respond to the world seed', () => {
  it('different seeds place a different world of items', () => {
    const a = items(createItemSystem(DEFAULT_CONFIG, open, 111111))
    const b = items(createItemSystem(DEFAULT_CONFIG, open, 999999))
    expect(a).not.toBe(b)
  })

  it('the same seed is perfectly reproducible', () => {
    const a = items(createItemSystem(DEFAULT_CONFIG, open, 424242))
    const b = items(createItemSystem(DEFAULT_CONFIG, open, 424242))
    expect(a).toBe(b)
  })

  // THE LOAD-BEARING GUARANTEE. A world seed of 0 (or none) must produce the
  // exact placement the game has always produced — otherwise every existing
  // save and every existing golden test silently changes. Math.imul(0, K) === 0
  // and X ^ 0 === X, so the seeded hash reduces to the original when seed is 0.
  it('seed 0 and no seed are byte-identical to each other', () => {
    const none = items(createItemSystem(DEFAULT_CONFIG, open))
    const zero = items(createItemSystem(DEFAULT_CONFIG, open, 0))
    expect(zero).toBe(none)
  })

  it('a null seed degrades to the unseeded world (solo unanchored runs)', () => {
    const none = items(createItemSystem(DEFAULT_CONFIG, open))
    const nul  = items(createItemSystem(DEFAULT_CONFIG, open, null))
    expect(nul).toBe(none)
  })
})

describe('decor responds to the world seed', () => {
  it('different seeds place different props/exits/npcs', () => {
    const a = decor(createDecorSystem(L0, open, 111111))
    const b = decor(createDecorSystem(L0, open, 999999))
    expect(a).not.toBe(b)
  })

  it('the same seed is perfectly reproducible', () => {
    const a = decor(createDecorSystem(L0, open, 424242))
    const b = decor(createDecorSystem(L0, open, 424242))
    expect(a).toBe(b)
  })

  it('seed 0 and no seed are byte-identical', () => {
    const none = decor(createDecorSystem(L0, open))
    const zero = decor(createDecorSystem(L0, open, 0))
    expect(zero).toBe(none)
  })
})

describe('seed and level stay orthogonal', () => {
  // seed picks WHICH place; salt picks WHICH floor. They must not collapse into
  // each other — two levels of the same world must still differ, and the same
  // level in two worlds must differ.
  it('two levels of one world differ (salt still works under a seed)', () => {
    const seed = 313131
    const lvl0 = items(createItemSystem(levelConfig(DEFAULT_CONFIG, 0), open, seed))
    const lvl1 = items(createItemSystem(levelConfig(DEFAULT_CONFIG, 1), open, seed))
    expect(lvl0).not.toBe(lvl1)
  })

  it('the same level in two worlds differs (seed still works under a salt)', () => {
    const cfg = levelConfig(DEFAULT_CONFIG, 1)
    const worldA = items(createItemSystem(cfg, open, 100))
    const worldB = items(createItemSystem(cfg, open, 200))
    expect(worldA).not.toBe(worldB)
  })
})
