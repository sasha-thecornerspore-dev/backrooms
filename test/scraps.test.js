import { describe, it, expect } from 'vitest'
import { createDecorSystem } from '../src/renderer/decor.js'
import { levelConfig } from '../src/renderer/levels.js'
import { DEFAULT_CONFIG } from '../src/renderer/world.js'
import { SCRAPS, fragmentAt } from '../src/renderer/scraps.js'

const open  = () => false
const solid = () => true
const L0 = levelConfig(DEFAULT_CONFIG, 0)   // Lobby — scraps denom 5

describe('fragmentAt', () => {
  it('is deterministic and always in range', () => {
    expect(fragmentAt(3, 7, 0, 0)).toBe(fragmentAt(3, 7, 0, 0))
    for (let cx = 0; cx < 24; cx++) for (let cy = 0; cy < 24; cy++) {
      const f = fragmentAt(cx, cy, 0, 0)
      expect(f).toBeGreaterThanOrEqual(0)
      expect(f).toBeLessThan(SCRAPS.length)
    }
  })
})

describe('scrap placement', () => {
  it('places scraps deterministically with a valid frag index', () => {
    const a = createDecorSystem(L0, open); a.update(0, 0)
    const b = createDecorSystem(L0, open); b.update(0, 0)
    expect(a.getScraps()).toEqual(b.getScraps())
    expect(a.getScraps().length).toBeGreaterThan(0)
    for (const s of a.getScraps()) {
      expect(s.frag).toBeGreaterThanOrEqual(0)
      expect(s.frag).toBeLessThan(SCRAPS.length)
    }
  })

  it('places no scraps where every cell is wall, or when denom is 0', () => {
    const walled = createDecorSystem(L0, solid); walled.update(0, 0)
    expect(walled.getScraps()).toHaveLength(0)
    const off = createDecorSystem({ ...L0, scraps: { denom: 0 } }, open); off.update(0, 0)
    expect(off.getScraps()).toHaveLength(0)
  })

  it('nearestScrap finds within range and nothing beyond it', () => {
    const sys = createDecorSystem(L0, open); sys.update(0, 0)
    const s = sys.getScraps()[0]
    expect(sys.nearestScrap(s.x + 0.2, s.y, 1.8).key).toBe(s.key)
    expect(sys.nearestScrap(s.x + 40, s.y + 40, 1.8)).toBeNull()
  })

  // The golden guard: scraps ride their own hash channel + srng, appended after
  // the npc block, so turning them on must NOT shift any prop/exit/npc placement.
  it('adding scraps does not perturb prop / exit / npc placement', () => {
    const on  = createDecorSystem({ ...L0, scraps: { denom: 5 } }, open); on.update(0, 0)
    const off = createDecorSystem({ ...L0, scraps: { denom: 0 } }, open); off.update(0, 0)
    expect(on.getProps()).toEqual(off.getProps())
    expect(on.getExits()).toEqual(off.getExits())
    expect(on.getNpcs()).toEqual(off.getNpcs())
    expect(on.getScraps().length).toBeGreaterThan(0)   // and scraps really did appear
    expect(off.getScraps().length).toBe(0)
  })

  it('enterLevel clears scraps and re-reads denom', () => {
    const sys = createDecorSystem(L0, open); sys.update(0, 0)
    expect(sys.getScraps().length).toBeGreaterThan(0)
    sys.enterLevel({ ...L0, scraps: { denom: 0 } }); sys.update(0, 0)
    expect(sys.getScraps()).toHaveLength(0)
  })
})
