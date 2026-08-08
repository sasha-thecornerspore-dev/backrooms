// relay/atlas.js — pure, runtime-free logic for the Atlas data layer.
// No Durable Object, no storage, no network. The Atlas DO in relay.js is a thin
// shell that loads a plain store object, calls these, and saves the result.
// Unit-tested like seed.js. Store shape: { version: 1, beacons: [ beacon ] }.

export const BEACON_KINDS = ['genesis', 'organic']
export const STRATUM_TIERS = ['deep', 'faint']
const ID_RE = /^[a-z0-9-]{1,64}$/

export function emptyStore() { return { version: 1, beacons: [] } }

export function beaconIdOk(id) { return typeof id === 'string' && ID_RE.test(id) }

export function validateStratum(s) {
  if (s == null || typeof s !== 'object') return { ok: false, error: 'stratum is not an object' }
  if (!STRATUM_TIERS.includes(s.tier)) return { ok: false, error: `tier must be one of ${STRATUM_TIERS.join('|')}` }
  if (typeof s.ts !== 'string' || Number.isNaN(Date.parse(s.ts))) return { ok: false, error: 'ts must be an ISO date string' }
  if (typeof s.fragment !== 'string' || !s.fragment) return { ok: false, error: 'fragment must be a non-empty string' }
  return { ok: true }
}

export function validateBeacon(b) {
  if (b == null || typeof b !== 'object') return { ok: false, error: 'beacon is not an object' }
  if (!beaconIdOk(b.id)) return { ok: false, error: 'beacon.id must match ^[a-z0-9-]{1,64}$' }
  if (!BEACON_KINDS.includes(b.kind)) return { ok: false, error: `beacon ${b.id}: kind must be one of ${BEACON_KINDS.join('|')}` }
  if (typeof b.name !== 'string' || !b.name) return { ok: false, error: `beacon ${b.id}: name must be a non-empty string` }
  if (typeof b.lat !== 'number' || b.lat < -90 || b.lat > 90) return { ok: false, error: `beacon ${b.id}: lat out of range` }
  if (typeof b.lng !== 'number' || b.lng < -180 || b.lng > 180) return { ok: false, error: `beacon ${b.id}: lng out of range` }
  if (b.sealed !== undefined && typeof b.sealed !== 'boolean') return { ok: false, error: `beacon ${b.id}: sealed must be boolean` }
  if (b.subtitle !== undefined && typeof b.subtitle !== 'string') return { ok: false, error: `beacon ${b.id}: subtitle must be a string` }
  if (b.blurb !== undefined && typeof b.blurb !== 'string') return { ok: false, error: `beacon ${b.id}: blurb must be a string` }
  const strata = b.strata ?? []
  if (!Array.isArray(strata)) return { ok: false, error: `beacon ${b.id}: strata must be an array` }
  for (let i = 0; i < strata.length; i++) {
    const e = validateStratum(strata[i])
    if (!e.ok) return { ok: false, error: `beacon ${b.id} strata[${i}]: ${e.error}` }
  }
  return { ok: true }
}

// Constant-time bearer check. Returns false unless authHeader is exactly
// "Bearer <secret>" and a non-empty secret is configured.
export function authorize(authHeader, secret) {
  if (typeof secret !== 'string' || secret.length === 0) return false
  if (typeof authHeader !== 'string') return false
  const m = authHeader.match(/^Bearer\s+(.+)$/)
  if (!m) return false
  const given = m[1]
  if (given.length !== secret.length) return false
  let x = 0
  for (let i = 0; i < secret.length; i++) x |= given.charCodeAt(i) ^ secret.charCodeAt(i)
  return x === 0
}

// "/atlas/beacons" | "/atlas/beacons/:id" | "/atlas/beacons/:id/strata" -> route, else null.
export function parseAtlasPath(pathname) {
  const parts = String(pathname).replace(/^\/+|\/+$/g, '').split('/')
  if (parts[0] === 'atlas' && parts[1] === 'passage' && parts.length === 2) return { resource: 'passage' }
  if (parts[0] !== 'atlas' || parts[1] !== 'beacons') return null
  if (parts.length === 2) return { resource: 'beacons' }
  if (parts.length === 3) return { resource: 'beacon', id: parts[2] }
  if (parts.length === 4 && parts[3] === 'strata') return { resource: 'strata', id: parts[2] }
  if (parts.length === 4 && parts[3] === 'checkin') return { resource: 'checkin', id: parts[2] }
  if (parts.length === 4 && parts[3] === 'dropin') return { resource: 'dropin', id: parts[2] }
  return null
}

export function readAtlas(store, route) {
  if (route.resource === 'beacons') return { status: 200, json: { version: store.version ?? 1, beacons: store.beacons } }
  if (route.resource === 'beacon') {
    const b = store.beacons.find(x => x.id === route.id)
    return b ? { status: 200, json: b } : { status: 404, json: { error: 'no such beacon' } }
  }
  return { status: 404, json: { error: 'not found' } }
}

// Upsert a beacon. If updating and the body omits `strata`, the existing strata
// are preserved (so metadata edits don't wipe the archive). Returns a new store
// on success; on error, no `store` field (caller persists nothing).
export function upsertBeacon(store, id, beacon) {
  if (!beaconIdOk(id)) return { status: 400, json: { error: 'bad id' } }
  const existing = store.beacons.find(x => x.id === id)
  const b = { ...beacon, id }
  if (b.strata === undefined && existing) b.strata = existing.strata
  const e = validateBeacon(b)
  if (!e.ok) return { status: 400, json: { error: e.error } }
  const beacons = store.beacons.filter(x => x.id !== id).concat([b])
  return { status: 200, json: b, store: { ...store, beacons } }
}

export function appendStratum(store, id, stratum) {
  const b = store.beacons.find(x => x.id === id)
  if (!b) return { status: 404, json: { error: 'no such beacon' } }
  const e = validateStratum(stratum)
  if (!e.ok) return { status: 400, json: { error: e.error } }
  const layer = { tier: stratum.tier, ts: stratum.ts, fragment: stratum.fragment }
  const nb = { ...b, strata: [...(b.strata ?? []), layer] }
  const beacons = store.beacons.map(x => (x.id === id ? nb : x))
  return { status: 201, json: nb, store: { ...store, beacons } }
}

// Great-circle distance in metres (haversine).
export function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000, toRad = d => d * Math.PI / 180
  const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1)
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)))
}

const CHECKIN_RADIUS_M = 120
const CHECKIN_COOLDOWN_MS = 6 * 3600 * 1000

// A presence-proved check-in. Verifies proximity to a non-sealed beacon, dedups
// per device (visitorHash is opaque + beacon-salted by the caller), appends a
// faint server-authored stratum, and NEVER stores the coordinates. Pure.
export function checkin(store, dedup, id, coords, visitorHash, now, opts = {}) {
  const radius = opts.radiusM ?? CHECKIN_RADIUS_M
  const cooldown = opts.cooldownMs ?? CHECKIN_COOLDOWN_MS
  const b = store.beacons.find(x => x.id === id)
  if (!b) return { status: 404, json: { error: 'no such beacon' } }
  if (b.sealed) return { status: 403, json: { error: 'this door is sealed — not a way in' } }
  const lat = coords && coords.lat, lng = coords && coords.lng
  if (typeof lat !== 'number' || typeof lng !== 'number' || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return { status: 400, json: { error: 'bad coordinates' } }
  }
  if (haversineMeters(lat, lng, b.lat, b.lng) > radius) {
    return { status: 403, json: { error: 'too far from the door' } }
  }
  const pruned = {}
  for (const [k, ts] of Object.entries(dedup || {})) if (now - ts < cooldown) pruned[k] = ts
  if (visitorHash && pruned[visitorHash] != null) return { status: 429, json: { error: 'you were here recently' } }
  if (visitorHash) pruned[visitorHash] = now
  const layer = { tier: 'faint', ts: new Date(now).toISOString(), fragment: 'someone stood at the door.' }
  const nb = { ...b, strata: [...(b.strata ?? []), layer] }
  const beacons = store.beacons.map(x => (x.id === id ? nb : x))
  return { status: 201, json: nb, store: { ...store, beacons }, dedup: pruned }
}

// ── passage: the drop-in economy. A per-visitor balance that regenerates over
// time; reaching a far beacon spends it, scaled by distance. Anonymous (the
// caller keys storage by a hash of the device token). ──
const PASSAGE_CAP = 1000, PASSAGE_REGEN_PER_HR = 100, PASSAGE_COST_PER_KM = 5, PASSAGE_MIN_COST = 1

export function regenBalance(rec, now, opts = {}) {
  const cap = opts.cap ?? PASSAGE_CAP, perHr = opts.regenPerHr ?? PASSAGE_REGEN_PER_HR
  if (!rec) return cap
  const hrs = Math.max(0, (now - (rec.ts ?? now)) / 3600000)
  return Math.min(cap, (rec.balance ?? cap) + hrs * perHr)
}

export function passageCost(distanceM, opts = {}) {
  const perKm = opts.costPerKm ?? PASSAGE_COST_PER_KM
  return Math.max(opts.minCost ?? PASSAGE_MIN_COST, Math.ceil((distanceM / 1000) * perKm))
}

// Drop in on a far (non-sealed) beacon: charge distance-scaled passage from the
// regenerated balance, append a faint stratum, and discard the coordinates. Pure.
export function dropin(store, passageRec, id, coords, now, opts = {}) {
  const b = store.beacons.find(x => x.id === id)
  if (!b) return { status: 404, json: { error: 'no such beacon' } }
  if (b.sealed) return { status: 403, json: { error: 'this door is sealed — not a way in' } }
  const lat = coords && coords.lat, lng = coords && coords.lng
  if (typeof lat !== 'number' || typeof lng !== 'number' || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return { status: 400, json: { error: 'bad coordinates' } }
  }
  const cost = passageCost(haversineMeters(lat, lng, b.lat, b.lng), opts)
  const balance = regenBalance(passageRec, now, opts)
  if (balance < cost) return { status: 402, json: { error: 'not enough passage', passage: Math.floor(balance), cost } }
  const layer = { tier: 'faint', ts: new Date(now).toISOString(), fragment: 'someone reached the door from far off.' }
  const nb = { ...b, strata: [...(b.strata ?? []), layer] }
  const beacons = store.beacons.map(x => (x.id === id ? nb : x))
  return { status: 201, json: { beacon: nb, passage: Math.floor(balance - cost), cost },
           store: { ...store, beacons }, passage: { balance: balance - cost, ts: now } }
}
