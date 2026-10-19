// anchor.js — "no-clip from a real place"
// Parses a pasted Google Maps link (or bare coordinates) into an anchor,
// and turns that anchor into a deterministic world seed. Everyone who
// anchors the same place falls into the same maze — solo. A room (the relay
// or a LAN) is only ever told the pin's neighbourhood: neighbourhoodSeed,
// pinTag and site.js buildInvite all start from the room grid below.

const PIN_RE   = /!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/
const QUERY_RE = /[?&]q(?:uery)?=(-?\d+(?:\.\d+)?)(?:%2C|,)\s*(-?\d+(?:\.\d+)?)/i
// a dropped pin's share link lands on /maps/search/39.297500,+-76.643000 — the searched point, so it outranks the map centre
const SEARCH_RE = /\/maps\/search\/(-?\d+(?:\.\d+)?)(?:%2C|,)(?:\+|%20|\s)*(-?\d+(?:\.\d+)?)/i
const AT_RE    = /@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/
const BARE_RE  = /^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/

function valid(lat, lng) {
  return Number.isFinite(lat) && Number.isFinite(lng) &&
    lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180
}

// Accepts Google Maps URLs (place pin !3d..!4d.., ?q=/query= param, /maps/search/lat,lng,
// @lat,lng map centre) or a bare "lat, lng" pair. Returns {lat, lng} or null.
// The relay's GET /maps (relay/mapslink.js) reads a short link's redirect with this same function.
export function parseAnchor(text) {
  if (typeof text !== 'string') return null
  const t = text.trim()
  if (!t) return null
  // pin coords are the most specific in a maps URL, then explicit query or searched point, then map centre
  for (const re of [PIN_RE, QUERY_RE, SEARCH_RE, AT_RE, BARE_RE]) {
    const m = t.match(re)
    if (m) {
      const lat = parseFloat(m[1])
      const lng = parseFloat(m[2])
      if (valid(lat, lng)) return { lat, lng }
      return null
    }
  }
  return null
}

// 32-bit seed from coordinates rounded to 4 decimal places (~11 m).
// Never returns 0 (0 is reserved to mean "no fixed seed").
// The SOLO seed. Its finaliser is invertible, so it gives the place back to
// ~11 m in well under a millisecond: it never leaves the machine (index.html
// startSolo is its one caller there).
export function anchorSeed(lat, lng) {
  const a = Math.round((lat + 90) * 10000) | 0
  const b = Math.round((lng + 180) * 10000) | 0
  let h = Math.imul(a, 374761393) ^ Math.imul(b, 668265263)
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  h = (h ^ (h >>> 16)) >>> 0
  return h === 0 ? 1 : h
}

// The room grid: 1e-2 degree, two decimals. A cell is 1.11 km north-south anywhere and 1.11 km × cos(lat) east-west — 0.86 km at
// Baltimore's 39.3° N, ~0.96 km²: a thousand doors or more in a rowhouse city. 1e-3 (~110 m) would be a block, a few dozen doors; 1e-1
// (~11 km) the whole city, and a pinned room would stop being anyone's place.
export const ROOM_GRID = 100   // cells per degree

// the pin's neighbourhood: the nearest point of the room grid, { lat, lng } at two decimals. null: not a pin
export function neighbourhood(anchor) {
  if (!anchor || !valid(anchor.lat, anchor.lng)) return null
  return { lat: Math.round(anchor.lat * ROOM_GRID) / ROOM_GRID, lng: Math.round(anchor.lng * ROOM_GRID) / ROOM_GRID }
}

// The seed a room is asked for, by a host or a joiner, on the relay or a LAN: the solo seed of the neighbourhood's grid point. It inverts to
// the neighbourhood (what the player is told: site.js roomPinLine), never the door. Snapping first keeps it a function of the cell alone,
// and an invite's two-decimal anchor (site.js buildInvite) asks for the same seed on any copy, 2.0.1 too. null: no pin.
export function neighbourhoodSeed(anchor) {
  const n = neighbourhood(anchor)
  return n ? anchorSeed(n.lat, n.lng) : null
}

// What 'here' says of a pin: 16 bits of the NEIGHBOURHOOD's seed salted with the room's world seed — never the pin's own seed. Built
// from the neighbourhood alone, every door in one cell carries the same tag in every room, so tags gathered across any number of rooms
// narrow a city to that cell and no further. Two friends from one neighbourhood in one room match. It takes the anchor, not a seed, so
// no caller can hand it the pin's own; anything else is null. (The mix is 2.0.1's, over the coarse seed: a 2.0.1 copy pinned at the
// grid point — an invite's anchor — still matches.)
export function pinTag(anchor, worldSeed) {
  const seed = neighbourhoodSeed(anchor)
  if (seed == null) return null
  return Math.imul((seed ^ (worldSeed | 0)) >>> 0, 0x9E3779B1) >>> 16
}

export function formatAnchor({ lat, lng }) {
  return `${lat.toFixed(4)},${lng.toFixed(4)}`
}

// 1 grid cell = 2 metres of carpet
export function driftMeters(px, py, sx, sy) {
  return Math.round(Math.hypot(px - sx, py - sy) * 2)
}

// Where the body fell through. Only https://www.google.com/maps URLs are
// ever opened (the main process enforces the same prefix).
export function bodyUrl({ lat, lng }) {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${lat},${lng}`)}`
}
