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
  if (parts[0] !== 'atlas' || parts[1] !== 'beacons') return null
  if (parts.length === 2) return { resource: 'beacons' }
  if (parts.length === 3) return { resource: 'beacon', id: parts[2] }
  if (parts.length === 4 && parts[3] === 'strata') return { resource: 'strata', id: parts[2] }
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
