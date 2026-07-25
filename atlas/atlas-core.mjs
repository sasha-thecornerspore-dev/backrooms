// atlas-core.mjs — pure helpers for the Atlas map.
// No DOM, no Leaflet, no network: runs under plain `node` for tests and imports
// as an ES module in the browser. The view (index.html) owns the map + DOM.

export const BEACON_KINDS = ['genesis', 'organic']
export const STRATUM_TIERS = ['deep', 'faint']

export function validateStratum(s) {
  if (s == null || typeof s !== 'object') return { ok: false, error: 'stratum is not an object' }
  if (!STRATUM_TIERS.includes(s.tier)) return { ok: false, error: `tier must be one of ${STRATUM_TIERS.join('|')}` }
  if (typeof s.ts !== 'string' || Number.isNaN(Date.parse(s.ts))) return { ok: false, error: 'ts must be an ISO date string' }
  if (typeof s.fragment !== 'string' || !s.fragment) return { ok: false, error: 'fragment must be a non-empty string' }
  return { ok: true }
}

export function validateBeacon(b) {
  if (b == null || typeof b !== 'object') return { ok: false, error: 'beacon is not an object' }
  if (typeof b.id !== 'string' || !b.id) return { ok: false, error: 'beacon.id must be a non-empty string' }
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

export function validateBeaconSet(doc) {
  if (doc == null || typeof doc !== 'object' || !Array.isArray(doc.beacons)) {
    return { ok: false, error: 'document must be { beacons: [...] }', count: 0 }
  }
  const seen = new Set()
  for (const b of doc.beacons) {
    const e = validateBeacon(b)
    if (!e.ok) return { ok: false, error: e.error, count: 0 }
    if (seen.has(b.id)) return { ok: false, error: `duplicate beacon id: ${b.id}`, count: 0 }
    seen.add(b.id)
  }
  return { ok: true, error: null, count: doc.beacons.length }
}

// Read "down through the layers": newest first (top layer = most recent), with a
// stable fragment tie-break so equal timestamps order deterministically. Copies.
export function orderStrata(strata) {
  return [...(strata ?? [])].sort((a, b) => {
    const t = Date.parse(b.ts) - Date.parse(a.ts)
    return t !== 0 ? t : a.fragment.localeCompare(b.fragment)
  })
}

// Marker style: sealed=rust, genesis=gold, organic=signal-green.
export function beaconStyle(beacon) {
  if (beacon.sealed) return { color: '#a05a3a', label: 'sealed', className: 'b-sealed' }
  if (beacon.kind === 'genesis') return { color: '#c9ba72', label: 'genesis', className: 'b-genesis' }
  return { color: '#8fdcac', label: 'surfaced', className: 'b-organic' }
}

// One line per stratum in the archive list: "layer 001 · deep · 2026-07-25".
export function stratumLabel(stratum, indexFromTop) {
  const n = String(indexFromTop + 1).padStart(3, '0')
  return `layer ${n} · ${stratum.tier} · ${stratum.ts.slice(0, 10)}`
}
