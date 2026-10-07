// feedback.js — what a contact sounds like and says: the bump-kind table, the intensity curve, the hard-bump rule and the rate gate.
import { describe, it, expect } from 'vitest'
import { BUMP_KIND, BUMP_LINES, bumpKindFor, bumpIntensity, isHardBump, createBumpGate } from '../src/renderer/feedback.js'
import { PROP_SPEC } from '../src/renderer/gfx-sprites.js'
import { SIGHT_TYPES } from '../src/renderer/decor.js'

const KINDS = ['thud', 'hollow', 'scrape', 'wood', 'murmur', 'silent']

describe('bumpKindFor', () => {
  it('covers every PROP_SPEC key, every SIGHT_TYPES entry, the machine and the lost soul, each in exactly one kind', () => {
    const all = Object.values(BUMP_KIND).flat()
    for (const t of Object.keys(PROP_SPEC)) expect(all.filter((x) => x === t), t).toHaveLength(1)
    for (const t of SIGHT_TYPES) expect(all.filter((x) => x === t), t).toHaveLength(1)
    expect(all.filter((x) => x === 'machine')).toHaveLength(1)
    expect(all.filter((x) => x === 'npc')).toHaveLength(1)
    expect(Object.keys(BUMP_KIND).sort()).toEqual([...KINDS].sort())
    for (const t of Object.keys(PROP_SPEC)) expect(KINDS, t).toContain(bumpKindFor('prop', t))
    for (const t of SIGHT_TYPES) expect(KINDS, t).toContain(bumpKindFor('sight', t))
    expect(KINDS).toContain(bumpKindFor('machine'))
    expect(KINDS).toContain(bumpKindFor('npc'))
  })

  it('names the shipped kinds', () => {
    expect(bumpKindFor('prop', 'papers')).toBe('silent')
    expect(bumpKindFor('prop', 'weeds')).toBe('silent')
    expect(bumpKindFor('prop', 'pallet')).toBe('wood')
    expect(bumpKindFor('prop', 'cabinet')).toBe('thud')
    expect(bumpKindFor('prop', 'cabinet-e')).toBe('thud')
    expect(bumpKindFor('prop', 'drum')).toBe('hollow')
    expect(bumpKindFor('prop', 'barrel')).toBe('hollow')
    expect(bumpKindFor('machine')).toBe('hollow')
    expect(bumpKindFor('prop', 'chair')).toBe('scrape')
    expect(bumpKindFor('prop', 'cone')).toBe('scrape')
    expect(bumpKindFor('prop', 'cart')).toBe('scrape')
    expect(bumpKindFor('prop', 'trash')).toBe('scrape')
    expect(bumpKindFor('prop', 'tire')).toBe('scrape')
    expect(bumpKindFor('npc')).toBe('murmur')
    expect(bumpKindFor('sight', 'tvwall')).toBe('thud')
    expect(bumpKindFor('sight', 'mannequin')).toBe('thud')
    expect(bumpKindFor('prop', 'never-made')).toBe('thud')       // unknown: the default body
  })
})

describe('bumpIntensity', () => {
  it('maps a 3.0 u/s walk to 0.3 and a 5.4 u/s sprint to 1, clamped at both ends', () => {
    expect(bumpIntensity(3.0)).toBeCloseTo(0.3, 9)
    expect(bumpIntensity(5.4)).toBeCloseTo(1, 9)
    expect(bumpIntensity(0)).toBe(0.3)
    expect(bumpIntensity(1)).toBe(0.3)
    expect(bumpIntensity(20)).toBe(1)
    expect(bumpIntensity(3.7)).toBeCloseTo(0.5, 9)
  })
})

describe('isHardBump', () => {
  const cab = { id: 1, cls: 'solid', kind: 'prop', type: 'cabinet' }
  const report = (over = {}) => ({ entered: cab, enterSpeed: 5.4, enterNormalDot: 1, ...over })
  it('is false for a 3.0 u/s walk into a cabinet and for a glancing sprint', () => {
    expect(isHardBump(report({ enterSpeed: 3.0 }), false)).toBe(false)
    expect(isHardBump(report({ enterSpeed: 3.0 }), true)).toBe(false)
    expect(isHardBump(report({ enterNormalDot: 0.3 }), true)).toBe(false)
  })
  it('is true for a head-on 5.4 u/s sprint, only while sprint is wanted and only on an ENTER edge into a solid', () => {
    expect(isHardBump(report(), true)).toBe(true)
    expect(isHardBump(report(), false)).toBe(false)
    expect(isHardBump(report({ entered: null }), true)).toBe(false)
    expect(isHardBump(report({ entered: { ...cab, cls: 'clutter' } }), true)).toBe(false)
    expect(isHardBump(report({ enterSpeed: 4.0 }), true)).toBe(false)         // strictly above 4.0
    expect(isHardBump(report({ enterSpeed: 4.01 }), true)).toBe(true)
    expect(isHardBump(report({ enterNormalDot: 0.7 }), true)).toBe(false)     // strictly above 0.7
    expect(isHardBump(report({ enterNormalDot: 0.71 }), true)).toBe(true)
    expect(isHardBump(null, true)).toBe(false)
  })
})

describe('BUMP_LINES', () => {
  it('ships the lines, lowercase and without exclamation marks, with a default', () => {
    expect(BUMP_LINES.cabinet).toBe('it does not move.')
    expect(BUMP_LINES.transformer).toBe('it hums against your shoulder. you step back.')
    expect(BUMP_LINES.machine).toBe('the machine rocks, and settles, and says nothing.')
    expect(BUMP_LINES.npc).toBe('they do not look at you. "mind."')
    expect(BUMP_LINES.crate).toBe('it is heavier than it looks.')
    expect(BUMP_LINES.default).toBe('it does not move.')
    for (const s of Object.values(BUMP_LINES)) { expect(s).toBe(s.toLowerCase()); expect(s).not.toContain('!') }
  })
})

describe('createBumpGate', () => {
  it('lets at most one near per 0.5 s and one far per 2 s', () => {
    const g = createBumpGate()
    expect(g.near(0)).toBe(true)
    expect(g.near(0.2)).toBe(false)
    expect(g.near(0.49)).toBe(false)
    expect(g.near(0.5)).toBe(true)
    expect(g.near(0.9)).toBe(false)
    expect(g.near(1.0)).toBe(true)
    expect(g.far(0)).toBe(true)
    expect(g.far(1.9)).toBe(false)
    expect(g.far(2.0)).toBe(true)
    expect(g.far(3.5)).toBe(false)
    expect(g.far(4.0)).toBe(true)
  })

  it('near and far are independent of each other', () => {
    const g = createBumpGate()
    expect(g.near(0)).toBe(true)
    expect(g.far(0.1)).toBe(true)
    expect(g.near(0.5)).toBe(true)
    expect(g.far(2.1)).toBe(true)
  })

  it('never lets more than 8 through in any 1 s window', () => {
    const g = createBumpGate()
    const passed = []
    let t = 0
    // hammer both lanes every 10 ms for 6 s
    for (let i = 0; i < 600; i++, t += 0.01) { if (g.near(t)) passed.push(t); if (g.far(t)) passed.push(t) }
    expect(passed.length).toBeGreaterThan(10)
    for (let i = 0; i < passed.length; i++) {
      let n = 0
      for (let j = i; j < passed.length && passed[j] - passed[i] < 1; j++) n++
      expect(n).toBeLessThanOrEqual(8)
    }
  })
})
