import { describe, it, expect } from 'vitest'
import {
  beaconIdOk, validateStratum, validateBeacon, authorize,
  parseAtlasPath, readAtlas, upsertBeacon, appendStratum, emptyStore,
  haversineMeters, checkin, regenBalance, passageCost, dropin, capPresenceStrata,
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

describe('haversineMeters', () => {
  it('is ~0 for the same point and ~111km for 1 degree of latitude', () => {
    expect(haversineMeters(39.3, -76.6, 39.3, -76.6)).toBeLessThan(1)
    const d = haversineMeters(39.0, -76.6, 40.0, -76.6)
    expect(d).toBeGreaterThan(110000); expect(d).toBeLessThan(112000)
  })
})

describe('parseAtlasPath checkin', () => {
  it('routes /atlas/beacons/:id/checkin', () => {
    expect(parseAtlasPath('/atlas/beacons/x/checkin')).toEqual({ resource: 'checkin', id: 'x' })
  })
})

describe('checkin', () => {
  const near = { lat: 39.3001, lng: -76.6001 }
  const far = { lat: 39.9, lng: -76.6 }
  const base = () => ({ version: 1, beacons: [
    { id: 'open', kind: 'genesis', name: 'O', lat: 39.3, lng: -76.6, strata: [] },
    { id: 'shut', kind: 'genesis', sealed: true, name: 'S', lat: 39.3, lng: -76.6, strata: [] },
  ]})
  const NOW = 1_000_000_000_000
  it('appends a faint stratum when near, discarding coords', () => {
    const r = checkin(base(), {}, 'open', near, 'k1', NOW)
    expect(r.status).toBe(201)
    expect(r.store.beacons[0].strata.length).toBe(1)
    expect(r.store.beacons[0].strata[0].tier).toBe('faint')
    expect(JSON.stringify(r.store)).not.toContain('39.3001')
  })
  it('rejects too-far (403), sealed (403), bad coords (400), unknown (404)', () => {
    expect(checkin(base(), {}, 'open', far, 'k1', NOW).status).toBe(403)
    expect(checkin(base(), {}, 'shut', near, 'k1', NOW).status).toBe(403)
    expect(checkin(base(), {}, 'open', { lat: 999, lng: 0 }, 'k1', NOW).status).toBe(400)
    expect(checkin(base(), {}, 'zzz', near, 'k1', NOW).status).toBe(404)
  })
  it('dedups the same device within cooldown, allows after it', () => {
    const first = checkin(base(), {}, 'open', near, 'k1', NOW)
    expect(checkin(base(), first.dedup, 'open', near, 'k1', NOW + 1000).status).toBe(429)
    expect(checkin(base(), first.dedup, 'open', near, 'k1', NOW + 7 * 3600 * 1000).status).toBe(201)
    expect(checkin(base(), first.dedup, 'open', near, 'k2', NOW + 1000).status).toBe(201)
  })
})

describe('regenBalance / passageCost', () => {
  it('new visitor starts at cap; grows over time; caps', () => {
    expect(regenBalance(null, 0)).toBe(1000)
    expect(regenBalance({ balance: 500, ts: 0 }, 3600000)).toBe(600)
    expect(regenBalance({ balance: 990, ts: 0 }, 3600000)).toBe(1000)
  })
  it('cost floors at 1 and scales with distance', () => {
    expect(passageCost(0)).toBe(1)
    expect(passageCost(100000)).toBe(500)
  })
})

describe('dropin', () => {
  const base = () => ({ version: 1, beacons: [
    { id: 'open', kind: 'genesis', name: 'O', lat: 39.3, lng: -76.6, strata: [] },
    { id: 'shut', kind: 'genesis', sealed: true, name: 'S', lat: 39.3, lng: -76.6, strata: [] },
  ]})
  const from = { lat: 40.0, lng: -76.6 }
  const NOW = 1_000_000_000_000
  it('charges passage, appends a faint stratum, stores no coords', () => {
    const r = dropin(base(), null, 'open', from, NOW)
    expect(r.status).toBe(201)
    expect(r.json.cost).toBeGreaterThan(1)
    expect(r.json.passage).toBe(1000 - r.json.cost)
    expect(r.passage.balance).toBe(1000 - r.json.cost)
    const s = r.store.beacons[0].strata[0]
    expect(s.tier).toBe('faint')
    expect(Object.keys(s).sort()).toEqual(['fragment', 'src', 'tier', 'ts'])
  })
  it('402 when the balance is too low', () => {
    expect(dropin(base(), { balance: 5, ts: NOW }, 'open', from, NOW).status).toBe(402)
  })
  it('403 sealed, 400 bad coords, 404 unknown', () => {
    expect(dropin(base(), null, 'shut', from, NOW).status).toBe(403)
    expect(dropin(base(), null, 'open', { lat: 999, lng: 0 }, NOW).status).toBe(400)
    expect(dropin(base(), null, 'zzz', from, NOW).status).toBe(404)
  })
})

// ── Abuse-resistance: presence strata are the accumulating archive, but an
// unauthenticated flood must not grow the single store value without bound.
// Presence layers are ring-buffered; authored (deep/genesis) strata are never
// dropped. Mirrors the pre-deploy review's blocker on unbounded store growth.
describe('presence strata cap', () => {
  const openBeacon = () => ({ version: 1, beacons: [
    { id: 'open', kind: 'genesis', name: 'O', lat: 39.3, lng: -76.6, strata: [
      { tier: 'deep', ts: '2020-01-01T00:00:00Z', fragment: 'authored lore' },
    ] },
  ] })
  const near = { lat: 39.3001, lng: -76.6001 }
  const from = { lat: 40.0, lng: -76.6 }
  const NOW = 1_000_000_000_000

  it('marks check-in and drop-in strata as presence-sourced', () => {
    const c = checkin(openBeacon(), {}, 'open', near, 'k1', NOW)
    expect(c.store.beacons[0].strata.at(-1).src).toBe('presence')
    const d = dropin(openBeacon(), null, 'open', from, NOW)
    expect(d.store.beacons[0].strata.at(-1).src).toBe('presence')
  })

  it('drop-in caps presence strata at 50 (oldest dropped) and never drops authored strata', () => {
    let store = openBeacon()
    for (let i = 0; i < 60; i++) store = dropin(store, null, 'open', from, NOW + i).store
    const strata = store.beacons[0].strata
    expect(strata.filter(s => s.src === 'presence').length).toBe(50)
    const authored = strata.filter(s => s.src !== 'presence')
    expect(authored.length).toBe(1)
    expect(authored[0].fragment).toBe('authored lore')
  })

  it('check-in also caps its presence strata at 50', () => {
    let store = openBeacon(); let dedup = {}
    for (let i = 0; i < 60; i++) {
      const r = checkin(store, dedup, 'open', near, 'k' + i, NOW + i)
      store = r.store; dedup = r.dedup
    }
    expect(store.beacons[0].strata.filter(s => s.src === 'presence').length).toBe(50)
  })

  // the leak a2a276d set out to close: at the cap, today's hidden mark must not push a visible past-day mark out
  it("at the cap, a same-day check-in or drop-in leaves the public view exactly as it was; it moves when the day turns", () => {
    const day = (d) => `2026-10-${String(d).padStart(2, '0')}T00:00:00Z`
    const past = []
    for (let i = 0; i < 50; i++) past.push({ tier: 'faint', ts: day(1 + (i % 19)), fragment: 'someone stood at the door.', src: 'presence' })
    past.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0))
    let store = openBeacon()
    store.beacons[0].strata.push(...past)
    const at = (iso) => Date.parse(iso)
    const view = (now) => readAtlas(store, { resource: 'beacons' }, now).json.beacons[0].strata
    const before = view(at('2026-10-20T08:00:00Z'))
    expect(before.filter(s => s.src === 'presence').length).toBe(50)
    let dedup = {}
    for (let i = 0; i < 5; i++) {
      const r = checkin(store, dedup, 'open', near, 'k' + i, at('2026-10-20T09:17:00Z') + i)
      store = r.store; dedup = r.dedup
    }
    store = dropin(store, null, 'open', from, at('2026-10-20T11:02:00Z')).store
    expect(view(at('2026-10-20T23:59:00Z'))).toEqual(before)
    // storage holds both: the 50 past-day marks and today's 6 (each kind capped at 50)
    expect(store.beacons[0].strata.filter(s => s.src === 'presence').length).toBe(56)
    // the next UTC day: today's marks come into view, the oldest past ones leave, and the view is still 50 marks
    const next = view(at('2026-10-21T00:00:01Z'))
    expect(next.filter(s => s.src === 'presence').length).toBe(50)
    expect(next.filter(s => s.ts === day(20)).length).toBe(6)
    expect(next.filter(s => s.src !== 'presence').map(s => s.fragment)).toEqual(['authored lore'])
  })

  it('today\'s marks have their own bound: the 51st of the day evicts the day\'s oldest, never a past-day mark', () => {
    const strata = [{ tier: 'deep', ts: '2020-01-01T00:00:00Z', fragment: 'authored lore' }]
    for (let i = 0; i < 3; i++) strata.push({ tier: 'faint', ts: '2026-10-19T00:00:00Z', fragment: 'p' + i, src: 'presence' })
    for (let i = 0; i < 51; i++) strata.push({ tier: 'faint', ts: '2026-10-20T00:00:00Z', fragment: 't' + i, src: 'presence' })
    const out = capPresenceStrata(strata, 50, '2026-10-20T00:00:00Z')
    expect(out.map(s => s.fragment).slice(0, 4)).toEqual(['authored lore', 'p0', 'p1', 'p2'])
    expect(out.filter(s => s.ts === '2026-10-20T00:00:00Z').length).toBe(50)
    expect(out.find(s => s.fragment === 't0')).toBeUndefined()
  })
})

describe('dedup map cap', () => {
  const openBeacon = () => ({ version: 1, beacons: [
    { id: 'open', kind: 'genesis', name: 'O', lat: 39.3, lng: -76.6, strata: [] },
  ] })
  const near = { lat: 39.3001, lng: -76.6001 }
  const NOW = 1_000_000_000_000
  it('bounds the per-beacon dedup map to 500 most-recent entries', () => {
    let store = openBeacon(); let dedup = {}
    for (let i = 0; i < 600; i++) {
      const r = checkin(store, dedup, 'open', near, 'dev' + i, NOW + i)
      store = r.store; dedup = r.dedup
    }
    expect(Object.keys(dedup).length).toBeLessThanOrEqual(500)
  })
})

// ── Presence is public: never an exact timestamp. A per-visit time series at a public place
// is a timetable of when someone stood there; the atlas only ever needs the day.
describe('presence is served at day resolution', () => {
  const store = () => ({ version: 1, beacons: [
    { id: 'open', kind: 'genesis', name: 'O', lat: 39.3, lng: -76.6, strata: [
      { tier: 'deep', ts: '2020-01-01T13:45:10Z', fragment: 'authored lore' },
    ] },
  ] })
  const near = { lat: 39.3001, lng: -76.6001 }
  const NOW = Date.parse('2026-09-16T15:42:07.123Z')

  it('check-in and drop-in store the day, not the moment', () => {
    const c = checkin(store(), {}, 'open', near, 'k1', NOW)
    expect(c.store.beacons[0].strata.at(-1).ts).toBe('2026-09-16T00:00:00Z')
    expect(c.json.strata.some(s => s.src === 'presence')).toBe(false)   // today's mark is not public yet
    const d = dropin(store(), null, 'open', { lat: 40, lng: -76.6 }, NOW)
    expect(d.store.beacons[0].strata.at(-1).ts).toBe('2026-09-16T00:00:00Z')
    expect(d.json.beacon.strata.some(s => s.src === 'presence')).toBe(false)
  })

  it('reads truncate presence marks stored before the change, and leave authored strata exact', () => {
    const legacy = store()
    legacy.beacons[0].strata.push({ tier: 'faint', ts: '2026-09-15T21:03:59.000Z', fragment: 'someone stood at the door.', src: 'presence' })
    const LATER = Date.parse('2026-09-17T08:00:00Z')
    for (const r of [readAtlas(legacy, { resource: 'beacons' }, LATER).json.beacons[0], readAtlas(legacy, { resource: 'beacon', id: 'open' }, LATER).json]) {
      expect(r.strata.find(s => s.src === 'presence').ts).toBe('2026-09-15T00:00:00Z')
      expect(r.strata.find(s => s.src !== 'presence').ts).toBe('2020-01-01T13:45:10Z')
    }
    expect(legacy.beacons[0].strata.at(-1).ts).toBe('2026-09-15T21:03:59.000Z')   // read is pure
  })
})

describe("today's presence stays private until the day is over", () => {
  const open = () => ({ version: 1, beacons: [{ id: 'open', kind: 'genesis', name: 'O', lat: 39.3, lng: -76.6, strata: [] }] })
  it('a poller sees nothing change during the day, and one mark the next day', () => {
    const MORNING = Date.parse('2026-09-16T09:12:00Z'), LATER = Date.parse('2026-09-16T23:59:00Z'), NEXT = Date.parse('2026-09-17T00:00:01Z')
    const c = checkin(open(), {}, 'open', { lat: 39.3001, lng: -76.6001 }, 'k', MORNING)
    expect(readAtlas(c.store, { resource: 'beacons' }, MORNING).json.beacons[0].strata.length).toBe(0)
    expect(readAtlas(c.store, { resource: 'beacons' }, LATER).json.beacons[0].strata.length).toBe(0)
    const next = readAtlas(c.store, { resource: 'beacon', id: 'open' }, NEXT).json.strata
    expect(next.length).toBe(1)
    expect(next[0].ts).toBe('2026-09-16T00:00:00Z')
  })
})
