import { describe, it, expect } from 'vitest'
import { scaleFrequency } from '../src/renderer/audio.js'

// scaleFrequency is the one pure, testable piece of the generative music engine
// (the rest is Web Audio graph wiring, exercised in-browser). It maps a scale
// degree above a root frequency to Hz, wrapping octaves for degrees past the end.
describe('scaleFrequency', () => {
  const PENT = [0, 2, 4, 7, 9]   // major pentatonic

  it('degree 0 is the root', () => {
    expect(scaleFrequency(220, PENT, 0)).toBeCloseTo(220, 5)
  })

  it('the octave option doubles the frequency per octave', () => {
    expect(scaleFrequency(220, PENT, 0, 1)).toBeCloseTo(440, 5)
    expect(scaleFrequency(220, PENT, 0, 2)).toBeCloseTo(880, 5)
  })

  it('a scale degree is the equal-tempered ratio of its semitone', () => {
    // degree 3 of the pentatonic = 7 semitones = a perfect fifth = *2^(7/12)
    expect(scaleFrequency(220, PENT, 3)).toBeCloseTo(220 * 2 ** (7 / 12), 5)
  })

  it('degrees past the scale length wrap up an octave', () => {
    // degree 5 wraps to degree 0 one octave higher
    expect(scaleFrequency(220, PENT, 5)).toBeCloseTo(scaleFrequency(220, PENT, 0, 1), 5)
    expect(scaleFrequency(220, PENT, 6)).toBeCloseTo(scaleFrequency(220, PENT, 1, 1), 5)
  })

  it('negative degrees wrap downward', () => {
    expect(scaleFrequency(440, PENT, -5)).toBeCloseTo(scaleFrequency(440, PENT, 0, -1), 5)
  })

  it('is always a positive finite frequency', () => {
    for (let d = -12; d <= 24; d++) {
      const f = scaleFrequency(261.63, [0, 1, 3, 6, 7, 10], d)
      expect(f).toBeGreaterThan(0)
      expect(Number.isFinite(f)).toBe(true)
    }
  })
})
