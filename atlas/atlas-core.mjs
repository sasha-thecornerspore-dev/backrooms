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
  if (s.src !== undefined && typeof s.src !== 'string') return { ok: false, error: 'src must be a string when present' }
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

// ── layered doors: a display tier computed from PUBLIC presence strata only ──
// Presence strata are the marks check-ins/drop-ins leave. Authored strata (the
// record) are never gated, never counted, never hidden. The tier counts DISTINCT
// UTC days with presence inside a rolling window, so a burst of marks in one
// afternoon is one day, and a door that nobody walks fades as days roll out.
export const PRESENCE_WINDOW_DAYS = 14
export const DOOR_TIERS = ['a door', 'walked', 'worn', 'thick', 'layered']

export function isPresence(s) {
  return !!s && (s.src === 'presence' || /^someone (stood at|reached) the door/.test(String(s.fragment || '')))
}
const dayOf = (ts) => String(ts).slice(0, 10)

// {tier 0..4, label, days, weight, newestTs, fading}. 'stood' days weigh 1, 'reached'
// (drop-in) days weigh 0.5; a day with both weighs 1. fading = newest presence is
// more than 10 days old (the door is losing its hold).
export function doorTier(strata, now = Date.now(), windowDays = PRESENCE_WINDOW_DAYS) {
  const cutoff = now - windowDays * 86400000
  const byDay = new Map()
  let newest = null
  for (const s of strata ?? []) {
    if (!isPresence(s)) continue
    const t = Date.parse(s.ts)
    if (Number.isNaN(t) || t < cutoff || t > now + 86400000) continue
    const w = /reached the door/.test(String(s.fragment || '')) ? 0.5 : 1
    byDay.set(dayOf(s.ts), Math.max(byDay.get(dayOf(s.ts)) ?? 0, w))
    if (newest == null || t > newest) newest = t
  }
  let weight = 0
  for (const w of byDay.values()) weight += w
  const tier = weight >= 10 ? 4 : weight >= 6 ? 3 : weight >= 3 ? 2 : weight >= 1 ? 1 : 0
  const fading = tier > 0 && newest != null && (now - newest) > 10 * 86400000
  return { tier, label: DOOR_TIERS[tier], days: byDay.size, weight, newestTs: newest == null ? null : new Date(newest).toISOString(), fading }
}

export function recencyBucket(ts, now = Date.now()) {
  const t = Date.parse(ts)
  if (Number.isNaN(t)) return 'older'
  const d = (now - t) / 86400000
  return d < 1 ? 'today' : d < 7 ? 'this week' : d < 31 ? 'this month' : 'older'
}

// The panel never lists presence marks one by one (that would publish a timetable of
// who stood where). Authored strata come back newest-first, untouched; all presence
// collapses into ONE summary entry.
export function visibleStrata(strata, now = Date.now()) {
  const authored = orderStrata((strata ?? []).filter((s) => !isPresence(s)))
  const presence = (strata ?? []).filter(isPresence)
  if (!presence.length) return authored
  const newest = presence.reduce((a, s) => (Date.parse(s.ts) > Date.parse(a.ts) ? s : a))
  return [{ tier: 'faint', ts: newest.ts, collapsed: true, count: presence.length,
            fragment: presence.length + ' mark' + (presence.length === 1 ? '' : 's') + ' · last ' + recencyBucket(newest.ts, now) }, ...authored]
}

export function haversineM(lat1, lng1, lat2, lng2) {
  const R = 6371000, toR = (d) => d * Math.PI / 180
  const dLat = toR(lat2 - lat1), dLng = toR(lng2 - lng1)
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toR(lat1)) * Math.cos(toR(lat2)) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(a))
}

// Cases whose surfaced geo instrument sits at this door: an explicit beacon id wins,
// distance is the fallback for display only. (index.json case entries may carry
// geo:{station,name,lat,lng,beacon} for their FIRST geo station — later doors are
// revealed by the board as the trail is walked, never listed here.)
export function nearbyCases(beacon, cases, maxM = 250) {
  return (cases ?? []).filter((c) => c && c.geo && (
    (c.geo.beacon && c.geo.beacon === beacon.id) ||
    (typeof c.geo.lat === 'number' && typeof c.geo.lng === 'number' && haversineM(beacon.lat, beacon.lng, c.geo.lat, c.geo.lng) <= maxM)))
}

// The live registry wins per id; bundled genesis doors the registry does not know yet
// still show (flagged bundled:true so the page hides check-in until the relay lists them).
export function mergeRegistries(live, bundled) {
  const out = new Map()
  for (const b of (bundled && bundled.beacons) || []) out.set(b.id, { ...b, bundled: true })
  for (const b of (live && live.beacons) || []) out.set(b.id, { ...b, bundled: false })
  return { beacons: [...out.values()] }
}

// Parse a URL hash ("#806-n-carey") into a beacon id, or null. Only the id
// charset we mint (lowercase letters, digits, hyphen) is allowed, so a crafted
// hash cannot select anything unexpected or inject into a lookup.
export function beaconIdFromHash(hash) {
  if (typeof hash !== 'string') return null
  const id = hash.replace(/^#/, '')
  return /^[a-z0-9-]{1,64}$/.test(id) ? id : null
}
