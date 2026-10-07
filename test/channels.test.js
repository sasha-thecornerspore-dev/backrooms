import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { CHANNELS } from '../src/renderer/channels.js'

const decorSrc = readFileSync(new URL('../src/renderer/decor.js', import.meta.url), 'utf8')
const entries = Object.entries(CHANNELS)

describe('CHANNELS', () => {
  it('names every channel the release plan places by', () => {
    expect(Object.keys(CHANNELS).sort()).toEqual(
      ['props', 'exits', 'npcs', 'scraps', 'machines', 'sights', 'upStair', 'lift', 'dress', 'containerSlot', 'containerRoll', 'haunts'].sort())
  })

  it('every hash gate a-constant is distinct across entries (type/pick gates included)', () => {
    const as = []
    for (const [, c] of entries) { if (c.gate) as.push(c.gate[0]); if (c.type) as.push(c.type[0]); if (c.pick) as.push(c.pick[0]) }
    expect(as.length).toBeGreaterThan(0)
    expect(new Set(as).size).toBe(as.length)
  })

  it('every (mulX, addX) rng pair is distinct', () => {
    const pairs = entries.filter(([, c]) => c.rng).map(([, c]) => `${c.rng[0]},${c.rng[1]}`)
    expect(pairs.length).toBeGreaterThan(0)
    expect(new Set(pairs).size).toBe(pairs.length)
  })

  it('every (a, b) gate pair is distinct', () => {
    const pairs = []
    for (const [, c] of entries) { if (c.gate) pairs.push(c.gate.join(',')); if (c.type) pairs.push(c.type.join(',')); if (c.pick) pairs.push(c.pick.join(',')) }
    expect(new Set(pairs).size).toBe(pairs.length)
  })

  it('shapes: gates are [a, b], rngs are [mulX, addX, mulY, addY], all positive integers', () => {
    for (const [, c] of entries) {
      for (const k of ['gate', 'type', 'pick']) if (c[k]) { expect(c[k]).toHaveLength(2); for (const n of c[k]) expect(Number.isInteger(n) && n > 0).toBe(true) }
      if (c.rng) { expect(c.rng).toHaveLength(4); for (const n of c.rng) expect(Number.isInteger(n) && n > 0).toBe(true) }
    }
  })

  it('decor.js reads exactly these constants for the existing passes (the registry cannot drift from the code)', () => {
    const gate = ([a, b]) => new RegExp(`hash\\(cx \\+ ${a} \\+ salt, cy \\+ ${b} \\+ salt, seed\\)`)
    const rng = ([mx, ax, my, ay]) => new RegExp(`rngFrom\\(cx \\* ${mx} \\+ salt \\+ ${ax}, cy \\* ${my} \\+ salt \\+ ${ay}, seed\\)`)
    expect(decorSrc).toMatch(rng(CHANNELS.props.rng))
    for (const k of ['exits', 'npcs', 'scraps', 'machines', 'sights']) {
      expect(decorSrc).toMatch(gate(CHANNELS[k].gate))
      expect(decorSrc).toMatch(rng(CHANNELS[k].rng))
    }
    expect(decorSrc).toMatch(gate(CHANNELS.sights.type))
  })

  it('is frozen data', () => {
    expect(Object.isFrozen(CHANNELS)).toBe(true)
    for (const [, c] of entries) expect(Object.isFrozen(c)).toBe(true)
  })
})
