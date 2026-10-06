// stillness.js (W5): how long you have stood still and how long since you made a sound, on the play clock in seconds. hidden is not
// computed here (W2's rule blocks turn these numbers into aiCtx.hidden); this pins the numbers and the two exported thresholds.
import { describe, it, expect } from 'vitest'
import { createStillness, STILL_THIN_S, STILL_HIDDEN_S, HUNTS_MOVEMENT_LINE } from '../src/renderer/stillness.js'

function clocked(t0 = 0) {
  const c = { t: t0 }
  c.s = createStillness({ now: () => c.t })
  return c
}

describe('createStillness', () => {
  it('stillFor grows with injected time while you stand; a moving note resets it to 0', () => {
    const c = clocked(10)
    expect(c.s.stillFor()).toBe(0)
    c.t = 11.5; c.s.note({ moving: false, flashlight: true, radioOn: false })
    expect(c.s.stillFor()).toBe(1.5)
    c.t = 13; expect(c.s.stillFor()).toBe(3)
    c.s.note({ moving: true, flashlight: true, radioOn: false })
    expect(c.s.stillFor()).toBe(0)
    c.t = 13.25; expect(c.s.stillFor()).toBe(0.25)
  })
  it('takes an explicit t on every method', () => {
    const c = clocked(0)
    c.s.note({ moving: true, flashlight: false, radioOn: false, t: 5 })
    expect(c.s.stillFor(7)).toBe(2)
    c.s.noise(8)
    expect(c.s.noiseFor(9)).toBe(1); expect(c.s.stillFor(9)).toBe(1)
  })
  it('noise() resets BOTH stillFor and noiseFor; noiseFor is Infinity before any noise', () => {
    const c = clocked(0)
    expect(c.s.noiseFor()).toBe(Infinity)
    c.t = 4; expect(c.s.stillFor()).toBe(4)
    c.s.noise()
    expect(c.s.stillFor()).toBe(0); expect(c.s.noiseFor()).toBe(0)
    c.t = 6.5
    expect(c.s.stillFor()).toBe(2.5); expect(c.s.noiseFor()).toBe(2.5)
    c.s.note({ moving: true })
    expect(c.s.stillFor()).toBe(0); expect(c.s.noiseFor()).toBe(2.5)     // motion is not a noise
  })
  it('lit / radio mirror the last note', () => {
    const c = clocked(0)
    expect(c.s.lit).toBe(false); expect(c.s.radio).toBe(false)
    c.s.note({ moving: false, flashlight: true, radioOn: true })
    expect(c.s.lit).toBe(true); expect(c.s.radio).toBe(true)
    c.s.note({ moving: false, flashlight: false, radioOn: true })
    expect(c.s.lit).toBe(false); expect(c.s.radio).toBe(true)
  })
  it('reset() clears', () => {
    const c = clocked(0)
    c.s.note({ moving: false, flashlight: true, radioOn: true }); c.s.noise()
    c.t = 9; c.s.reset()
    expect(c.s.stillFor()).toBe(0); expect(c.s.noiseFor()).toBe(Infinity)
    expect(c.s.lit).toBe(false); expect(c.s.radio).toBe(false)
    c.t = 10; expect(c.s.stillFor()).toBe(1)
  })
})

describe('the numbers and the line', () => {
  it('STILL_THIN_S 0.6, STILL_HIDDEN_S 2, the line lowercase with no exclamation mark', () => {
    expect(STILL_THIN_S).toBe(0.6)
    expect(STILL_HIDDEN_S).toBe(2)
    expect(HUNTS_MOVEMENT_LINE).toBe('it hunts movement. you remember that now.')
    expect(HUNTS_MOVEMENT_LINE).toBe(HUNTS_MOVEMENT_LINE.toLowerCase()); expect(HUNTS_MOVEMENT_LINE).not.toContain('!')
  })
})

describe('legacy identity', () => {
  it('stillFor is 0 at t0', () => {
    expect(createStillness({ now: () => 42 }).stillFor()).toBe(0)
  })
})
