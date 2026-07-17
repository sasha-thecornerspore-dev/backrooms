import { describe, it, expect } from 'vitest'
import { roomSeed, isValidSeed } from '../relay/seed.js'

describe('isValidSeed', () => {
  it('accepts uint32 seeds above zero', () => {
    expect(isValidSeed(1)).toBe(true)
    expect(isValidSeed(12345)).toBe(true)
    expect(isValidSeed(0xFFFFFFFF)).toBe(true)
  })

  it('rejects 0, negatives, non-integers, junk and out-of-range', () => {
    // 0 is reserved: world.js:191 reads it as BOTH "fixed seed" and "no seed",
    // so a 0 seed silently produces the drift world while claiming to be seeded.
    expect(isValidSeed(0)).toBe(false)
    expect(isValidSeed(-1)).toBe(false)
    expect(isValidSeed(1.5)).toBe(false)
    expect(isValidSeed(0x100000000)).toBe(false)
    expect(isValidSeed(NaN)).toBe(false)
    expect(isValidSeed('abc')).toBe(false)
    expect(isValidSeed(null)).toBe(false)
    expect(isValidSeed(undefined)).toBe(false)
  })
})

describe('roomSeed', () => {
  it('honours a requested seed when the room has no world yet', () => {
    // THE DEFECT: the relay never read the client's requested seed, so every
    // online game was Math.random() while the HUD reported the real anchor.
    expect(roomSeed(12345, null)).toBe(12345)
  })

  it('lets a stored seed win over a requested one — the first joiner fixes the world', () => {
    expect(roomSeed(12345, 999)).toBe(999)
  })

  it('returns the stored seed when nothing is requested', () => {
    expect(roomSeed(null, 999)).toBe(999)
  })

  it('agrees with itself for the same stored value', () => {
    // The real postcondition. "Returns random" is NOT testable and PASSES
    // WHILE BROKEN — that is the exact shape of the blind spot the defect
    // lived in for months. Assert agreement instead.
    expect(roomSeed(null, 999)).toBe(roomSeed(null, 999))
    expect(roomSeed(7, 999)).toBe(roomSeed(42, 999))
  })

  it('mints a valid seed when neither is usable', () => {
    for (const junk of [0, -1, 1.5, NaN, 'abc', 0x100000000, null, undefined]) {
      expect(isValidSeed(roomSeed(junk, null))).toBe(true)
    }
  })

  it('never returns 0', () => {
    expect(roomSeed(0, null)).not.toBe(0)
    expect(roomSeed(-1, null)).not.toBe(0)
    for (let i = 0; i < 2000; i++) expect(roomSeed(null, null)).not.toBe(0)
  })

  it('coerces numeric strings, because JSON is untrusted', () => {
    expect(roomSeed('12345', null)).toBe(12345)
    expect(roomSeed(null, '999')).toBe(999)
  })
})
