// anchor.js — "no-clip from a real place"
// Parses a pasted Google Maps link (or bare coordinates) into an anchor,
// and turns that anchor into a deterministic world seed. Everyone who
// anchors the same place falls into the same maze.

const PIN_RE   = /!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/
const QUERY_RE = /[?&]q(?:uery)?=(-?\d+(?:\.\d+)?)(?:%2C|,)\s*(-?\d+(?:\.\d+)?)/i
const AT_RE    = /@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/
const BARE_RE  = /^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/

function valid(lat, lng) {
  return Number.isFinite(lat) && Number.isFinite(lng) &&
    lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180
}

// Accepts Google Maps URLs (place pin !3d..!4d.., ?q=/query= param, @lat,lng
// map centre) or a bare "lat, lng" pair. Returns {lat, lng} or null.
export function parseAnchor(text) {
  if (typeof text !== 'string') return null
  const t = text.trim()
  if (!t) return null
  // pin coords are the most specific in a maps URL, then explicit query, then map centre
  for (const re of [PIN_RE, QUERY_RE, AT_RE, BARE_RE]) {
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
export function anchorSeed(lat, lng) {
  const a = Math.round((lat + 90) * 10000) | 0
  const b = Math.round((lng + 180) * 10000) | 0
  let h = Math.imul(a, 374761393) ^ Math.imul(b, 668265263)
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  h = (h ^ (h >>> 16)) >>> 0
  return h === 0 ? 1 : h
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
