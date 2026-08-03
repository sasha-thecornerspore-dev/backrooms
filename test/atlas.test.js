import { describe, it, expect } from 'vitest'
import {
  beaconIdOk, validateStratum, validateBeacon, authorize,
  parseAtlasPath, readAtlas, upsertBeacon, appendStratum, emptyStore,
} from '../relay/atlas.js'
import SEED from '../relay/atlas-seed.js'

const beacon = (over = {}) => ({ id: 'x', kind: 'genesis', name: 'X', lat: 39.3, lng: -76.6, strata: [], ...over })

describe('beaconIdOk', () => {
  it('accepts minted ids, rejects junk', () => {
    expect(beaconIdOk('806-n-carey')).toBe(true)
    expect(beaconIdOk('BAD')).toBe(false)
    expect(beaconIdOk('a/b')).toBe(false)
    expect(beaconIdOk('')).toBe(false)
    expect(beaconIdOk(null)).toBe(false)
  })
})

describe('validateStratum / validateBeacon', () => {
  it('validates a good stratum and beacon', () => {
    expect(validateStratum({ tier: 'deep', ts: '2026-07-26T00:00:00Z', fragment: 'x' }).ok).toBe(true)
    expect(validateBeacon(beacon()).ok).toBe(true)
  })
  it('rejects bad tier / ts / fragment', () => {
    expect(validateStratum({ tier: 'no', ts: '2026-07-26', fragment: 'x' }).ok).toBe(false)
    expect(validateStratum({ tier: 'deep', ts: 'nope', fragment: 'x' }).ok).toBe(false)
    expect(validateStratum({ tier: 'deep', ts: '2026-07-26', fragment: '' }).ok).toBe(false)
  })
  it('rejects bad id / kind / coords / sealed type', () => {
    expect(validateBeacon(beacon({ id: 'BAD' })).ok).toBe(false)
    expect(validateBeacon(beacon({ kind: 'zzz' })).ok).toBe(false)
    expect(validateBeacon(beacon({ lat: 200 })).ok).toBe(false)
    expect(validateBeacon(beacon({ lng: 999 })).ok).toBe(false)
    expect(validateBeacon(beacon({ sealed: 'yes' })).ok).toBe(false)
  })
})

describe('authorize (constant-time bearer)', () => {
  it('accepts the exact key, rejects everything else', () => {
    expect(authorize('Bearer s3cret', 's3cret')).toBe(true)
    expect(authorize('Bearer wrong', 's3cret')).toBe(false)
    expect(authorize('s3cret', 's3cret')).toBe(false)          // missing "Bearer "
    expect(authorize('Bearer s3cret', '')).toBe(false)          // no secret configured
    expect(authorize(null, 's3cret')).toBe(false)
    expect(authorize('Bearer s3cre', 's3cret')).toBe(false)     // length differs
  })
})

describe('parseAtlasPath', () => {
  it('routes the three shapes and rejects the rest', () => {
    expect(parseAtlasPath('/atlas/beacons')).toEqual({ resource: 'beacons' })
    expect(parseAtlasPath('/atlas/beacons/806-n-carey')).toEqual({ resource: 'beacon', id: '806-n-carey' })
    expect(parseAtlasPath('/atlas/beacons/806-n-carey/strata')).toEqual({ resource: 'strata', id: '806-n-carey' })
    expect(parseAtlasPath('/atlas')).toBe(null)
    expect(parseAtlasPath('/nope')).toBe(null)
    expect(parseAtlasPath('/atlas/beacons/x/y')).toBe(null)
  })
})

describe('readAtlas', () => {
  const store = { version: 1, beacons: [beacon({ id: 'a' }), beacon({ id: 'b' })] }
  it('lists all, fetches one, 404s the unknown', () => {
    expect(readAtlas(store, { resource: 'beacons' }).json.beacons.length).toBe(2)
    expect(readAtlas(store, { resource: 'beacon', id: 'a' }).status).toBe(200)
    expect(readAtlas(store, { resource: 'beacon', id: 'zzz' }).status).toBe(404)
  })
})

describe('upsertBeacon', () => {
  it('inserts, updates, preserves strata on metadata-only update, rejects bad data', () => {
    const s0 = emptyStore()
    const ins = upsertBeacon(s0, 'a', beacon({ id: 'a', strata: [{ tier: 'deep', ts: '2026-01-01T00:00:00Z', fragment: 'one' }] }))
    expect(ins.status).toBe(200)
    expect(ins.store.beacons.length).toBe(1)
    // metadata-only update (no strata field) keeps the existing strata
    const upd = upsertBeacon(ins.store, 'a', { kind: 'genesis', name: 'A2', lat: 39.3, lng: -76.6 })
    expect(upd.status).toBe(200)
    expect(upd.store.beacons[0].name).toBe('A2')
    expect(upd.store.beacons[0].strata.length).toBe(1)
    // bad id / body -> 400, store untouched
    expect(upsertBeacon(ins.store, 'BAD', beacon()).status).toBe(400)
    expect(upsertBeacon(ins.store, 'a', { kind: 'zzz' }).status).toBe(400)
  })
})

describe('appendStratum', () => {
  it('appends to an existing beacon, 404s the unknown, 400s bad data', () => {
    const s0 = { version: 1, beacons: [beacon({ id: 'a', strata: [] })] }
    const r = appendStratum(s0, 'a', { tier: 'faint', ts: '2026-07-26T00:00:00Z', fragment: 'new' })
    expect(r.status).toBe(201)
    expect(r.store.beacons[0].strata.length).toBe(1)
    expect(appendStratum(s0, 'zzz', { tier: 'deep', ts: '2026-07-26T00:00:00Z', fragment: 'x' }).status).toBe(404)
    expect(appendStratum(s0, 'a', { tier: 'no', ts: 'x', fragment: '' }).status).toBe(400)
  })
})

describe('atlas-seed', () => {
  it('is a valid store and every beacon validates', () => {
    expect(Array.isArray(SEED.beacons)).toBe(true)
    for (const b of SEED.beacons) expect(validateBeacon(b).ok).toBe(true)
  })
  it('contains 806 N Carey as a sealed genesis beacon', () => {
    expect(SEED.beacons.some(b => b.id === '806-n-carey' && b.sealed === true && b.kind === 'genesis')).toBe(true)
  })
})
