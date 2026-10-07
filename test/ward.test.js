import { describe, it, expect } from 'vitest'
import { createWardCharger, wardOpts, WARD_TAP, WARD_CHARGED } from '../src/renderer/ward.js'

// press / release are edge COUNTS: the caller increments them on keydown / keyup
// and the charger reacts to the count changing, never to a held boolean.
function drive(ch, steps) {
  // steps: [dt, press, release, stamina] → the last tick's result
  let out = null
  for (const [dt, p, r, s = 100] of steps) out = ch.tick(dt, p, r, s)
  return out
}

describe('createWardCharger', () => {
  it('press at t=0, release at 0.2 → a tap costing 20', () => {
    const ch = createWardCharger()
    expect(ch.tick(0.016, 1, 0, 100)?.charging).toBe(true)
    expect(ch.isCharging()).toBe(true)
    const w = drive(ch, [[0.1, 1, 0], [0.084, 1, 1]])
    expect(w.charged).toBe(false)
    expect(w.cost).toBe(20)
    expect(w.holdT).toBeLessThan(0.4)
    expect(ch.isCharging()).toBe(false)
  })

  it('release at 0.5 → charged, costing 35', () => {
    const ch = createWardCharger()
    const w = drive(ch, [[0.1, 1, 0], [0.2, 1, 0], [0.2, 1, 1]])
    expect(w.charged).toBe(true)
    expect(w.cost).toBe(35)
    expect(w.holdT).toBeGreaterThanOrEqual(0.4)
  })

  it('while charging it reports moveMul 0.55 and a 6/s stamina drain', () => {
    const ch = createWardCharger()
    const w = ch.tick(0.1, 1, 0, 100)
    expect(w).toMatchObject({ charging: true, moveMul: 0.55, drain: 6 })
    expect(w.holdT).toBeCloseTo(0)
    const w2 = ch.tick(0.1, 1, 0, 100)
    expect(w2.holdT).toBeCloseTo(0.1)
    expect(w2).toBe(w)   // one reused result object while charging
  })

  it('no release by 1.0 s → auto-fires charged and a later release fires nothing', () => {
    const ch = createWardCharger()
    let fired = null, frames = 0
    // the latch frame counts no hold (the press landed somewhere inside it); four more quarter-seconds reach 1.0
    for (let i = 0; i < 6 && !fired; i++) {
      const w = ch.tick(0.25, 1, 0, 100); frames++
      if (w && !w.charging) fired = w
    }
    expect(fired).not.toBeNull()
    expect(frames).toBe(5)
    expect(fired.holdT).toBeCloseTo(1.0)
    expect(fired.charged).toBe(true)
    expect(ch.isCharging()).toBe(false)
    // the keyup arrives late (or never): nothing more happens
    expect(ch.tick(0.016, 1, 0, 100)).toBeNull()
    expect(ch.tick(5, 1, 1, 100)).toBeNull()
  })

  it('press and release counted in the same tick → a tap (a sub-frame touch tap registers)', () => {
    const ch = createWardCharger()
    const w = ch.tick(0.016, 1, 1, 100)
    expect(w).not.toBeNull()
    expect(w.charged).toBe(false)
    expect(w.charging).toBeUndefined()
    expect(ch.isCharging()).toBe(false)
  })

  it('forceRelease() drops the latch: the next tick is null and the release costs nothing', () => {
    const ch = createWardCharger()
    ch.tick(0.1, 1, 0, 100)
    expect(ch.isCharging()).toBe(true)
    ch.forceRelease()
    expect(ch.isCharging()).toBe(false)
    expect(ch.tick(0.1, 1, 0, 100)).toBeNull()
    expect(ch.tick(0.1, 1, 1, 100)).toBeNull()
  })

  it('stamina 15 at release → denied winded, and no cooldown is started', () => {
    const ch = createWardCharger()
    const w = drive(ch, [[0.1, 1, 0], [0.1, 1, 1, 15]])
    expect(w).toEqual({ denied: 'winded' })
    expect(ch.isCharging()).toBe(false)
    // the legs were never spent: a fresh tap right away goes through
    expect(ch.tick(0.016, 2, 2, 100).cost).toBe(20)
  })

  it('a charged release needs 35: stamina 30 is winded', () => {
    const ch = createWardCharger()
    expect(drive(ch, [[0.3, 1, 0], [0.3, 1, 0], [0.1, 1, 1, 30]])).toEqual({ denied: 'winded' })
  })

  it('cooldown blocks a second tap within 0.65 s and lets one through after', () => {
    const ch = createWardCharger()
    expect(ch.tick(0.016, 1, 1, 100).cost).toBe(20)
    expect(ch.tick(0.3, 2, 2, 100)).toBeNull()         // 0.3 s later: still recovering
    expect(ch.isCharging()).toBe(false)
    expect(ch.tick(0.4, 3, 3, 100).cost).toBe(20)      // 0.7 s after the first: free again
  })

  it('a charged ward cools down for 1.2 s', () => {
    const ch = createWardCharger()
    expect(drive(ch, [[0.1, 1, 0], [0.5, 1, 0], [0.1, 1, 1]]).charged).toBe(true)
    expect(ch.tick(0.9, 2, 2, 100)).toBeNull()
    expect(ch.tick(0.4, 3, 3, 100).cost).toBe(20)
  })

  it('a second press while already latched is ignored (no double latch)', () => {
    const ch = createWardCharger()
    ch.tick(0.1, 1, 0, 100)
    const w = ch.tick(0.1, 2, 0, 100)
    expect(w.charging).toBe(true)
    expect(w.holdT).toBeCloseTo(0.1)
  })
})

describe('wardOpts', () => {
  it('tap is today\'s defaults; charged is narrower, longer and heavier', () => {
    expect(wardOpts(false)).toEqual({ range: 2.6, cone: 0.7 * Math.PI, knockback: 1.7, hits: 1 })
    expect(wardOpts(true)).toEqual({ range: 4.0, cone: 0.39 * Math.PI, knockback: 3.2, hits: 2 })
    expect(wardOpts(true).cone).toBeLessThan(wardOpts(false).cone)
    expect(wardOpts(true).range).toBe(4.0)
    expect(wardOpts(false)).toBe(WARD_TAP)
    expect(wardOpts(true)).toBe(WARD_CHARGED)
  })
})
