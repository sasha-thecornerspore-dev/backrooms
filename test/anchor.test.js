import { describe, it, expect } from 'vitest'
import { parseAnchor, anchorSeed, formatAnchor, driftMeters, bodyUrl } from '../src/renderer/anchor.js'

describe('parseAnchor', () => {
  it('parses bare "lat, lng"', () => {
    expect(parseAnchor('35.0168, -80.5901')).toEqual({ lat: 35.0168, lng: -80.5901 })
  })

  it('parses @lat,lng map-centre URLs', () => {
    const url = 'https://www.google.com/maps/@40.7484405,-73.9856644,17z'
    expect(parseAnchor(url)).toEqual({ lat: 40.7484405, lng: -73.9856644 })
  })

  it('parses ?q=lat,lng URLs', () => {
    expect(parseAnchor('https://maps.google.com/?q=51.5007,-0.1246')).toEqual({ lat: 51.5007, lng: -0.1246 })
  })

  it('parses api=1 query= URLs with encoded comma', () => {
    expect(parseAnchor('https://www.google.com/maps/search/?api=1&query=48.8584%2C2.2945'))
      .toEqual({ lat: 48.8584, lng: 2.2945 })
  })

  it('prefers the place pin (!3d/!4d) over the map centre', () => {
    const url = 'https://www.google.com/maps/place/Somewhere/@40.7,-74.1,17z/data=!3m1!4b1!4m6!3m5!1s0x0:0x0!8m2!3d40.7484405!4d-73.9856644'
    expect(parseAnchor(url)).toEqual({ lat: 40.7484405, lng: -73.9856644 })
  })

  it('rejects junk, empty, and out-of-range coords', () => {
    expect(parseAnchor('')).toBeNull()
    expect(parseAnchor('the poolrooms')).toBeNull()
    expect(parseAnchor('91,0')).toBeNull()
    expect(parseAnchor('0,181')).toBeNull()
    expect(parseAnchor(null)).toBeNull()
  })
})

describe('anchorSeed', () => {
  it('is deterministic and 32-bit', () => {
    const s1 = anchorSeed(35.0168, -80.5901)
    const s2 = anchorSeed(35.0168, -80.5901)
    expect(s1).toBe(s2)
    expect(s1).toBeGreaterThan(0)
    expect(s1).toBeLessThanOrEqual(0xFFFFFFFF)
  })

  it('nearby-but-distinct places differ, ~11m rounding collapses', () => {
    expect(anchorSeed(35.0168, -80.5901)).not.toBe(anchorSeed(35.0169, -80.5901))
    expect(anchorSeed(35.01681, -80.59012)).toBe(anchorSeed(35.01682, -80.59008))
  })

  it('never returns 0', () => {
    for (let i = 0; i < 500; i++) {
      expect(anchorSeed(-90 + i * 0.36, -180 + i * 0.72)).not.toBe(0)
    }
  })
})

describe('helpers', () => {
  it('formatAnchor renders 4dp', () => {
    expect(formatAnchor({ lat: 35.0168, lng: -80.5901 })).toBe('35.0168,-80.5901')
  })

  it('driftMeters: 1 cell = 2m', () => {
    expect(driftMeters(14, 11, 11, 11)).toBe(6)
    expect(driftMeters(11, 11, 11, 11)).toBe(0)
  })

  it('bodyUrl points at google maps search', () => {
    const u = bodyUrl({ lat: 35.0168, lng: -80.5901 })
    expect(u.startsWith('https://www.google.com/maps/search/?api=1&query=')).toBe(true)
    expect(u).toContain('35.0168')
  })
})
