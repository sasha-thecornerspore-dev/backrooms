import { describe, it, expect } from 'vitest'
import { computeLures, lureWithin, quiet, createCommit, QUIET_SECONDS, RADIO_BATTERY, GLOW_TTL } from '../src/renderer/tactics.js'

const radio = (x, y, on, onUntil) => ({ key: `d:${x},${y}`, x, y, type: 'radio', on, onUntil })

describe('computeLures', () => {
  it('returns only dropped radios that are on and still have battery, nearest first, at most 2', () => {
    const dropped = new Map()
    const far = radio(20, 0, true, 100), near = radio(2, 0, true, 100), mid = radio(6, 0, true, 100)
    for (const r of [far, near, mid,
      radio(1, 0, false, 100),            // off
      radio(1, 1, true, 5),               // battery gone at t=10
      { key: 'd:g', x: 0.5, y: 0, type: 'glowstick', t0: 0 }]) dropped.set(r.key, r)
    const lures = computeLures(dropped, 10, 0, 0)
    expect(lures).toEqual([near, mid])
  })

  it('reuses one array across calls and empties it when nothing qualifies', () => {
    const dropped = new Map()
    dropped.set('a', radio(3, 0, true, 50))
    const a = computeLures(dropped, 0, 0, 0)
    expect(a).toHaveLength(1)
    const b = computeLures(dropped, 60, 0, 0)
    expect(b).toBe(a)
    expect(b).toHaveLength(0)
    expect(computeLures(new Map(), 0, 0, 0)).toBe(a)
  })

  it('accepts a plain array too', () => {
    const lures = computeLures([radio(1, 0, true, 10), radio(2, 0, true, 10), radio(3, 0, true, 10)], 0, 0, 0)
    expect(lures.map(l => l.x)).toEqual([1, 2])
  })
})

describe('lureWithin', () => {
  it('is true when any lure lies within r of the point', () => {
    const lures = [radio(10, 0, true, 100), radio(0, 5, true, 100)]
    expect(lureWithin(lures, 0, 0, 5)).toBe(true)
    expect(lureWithin(lures, 0, 0, 4.9)).toBe(false)
    expect(lureWithin([], 0, 0, 100)).toBe(false)
  })
})

describe('quiet', () => {
  it('halves the footstep loudness while the timer runs', () => {
    expect(quiet(5)).toBe(0.5)
    expect(quiet(0)).toBe(1)
    expect(quiet(-1)).toBe(1)
  })
})

describe('createCommit', () => {
  it('runs for its duration, then reports done once and goes idle', () => {
    const c = createCommit(1.2)
    expect(c.active).toBe(false)
    expect(c.tick(0.5)).toBe('idle')
    c.start()
    expect(c.active).toBe(true)
    expect(c.tick(0.5)).toBe('running')
    expect(c.tick(0.5)).toBe('running')
    expect(c.tick(0.2)).toBe('done')
    expect(c.active).toBe(false)
    expect(c.tick(0.1)).toBe('idle')
  })

  it('cancel() leaves it idle without ever reporting done', () => {
    const c = createCommit(1.2)
    c.start()
    c.tick(1.0)
    c.cancel()
    expect(c.active).toBe(false)
    expect(c.tick(0.5)).toBe('idle')
    // a fresh start runs the full duration again
    c.start()
    expect(c.tick(1.0)).toBe('running')
    expect(c.tick(0.2)).toBe('done')
  })
})

describe('constants', () => {
  it('match the spec', () => {
    expect(QUIET_SECONDS).toBe(20)
    expect(RADIO_BATTERY).toBe(180)
    expect(GLOW_TTL).toBe(240)
  })
})
