// relay/mapslink.js — a phone's Google Maps share link, resolved to the pin it points at (the relay's GET /maps?u=).
//
// Share → Copy link in Google Maps gives https://maps.app.goo.gl/<id>, which carries no coordinates: they are in the URL it
// redirects to. A browser page cannot follow that redirect itself (no CORS on Google's side), so the relay does — and only
// that. The first fetch is always a short link rebuilt from its id on one of the two short-link hosts, never the string the
// caller sent; every later fetch is a redirect to https://(www.)google.com/maps…, at most MAX_REDIRECTS of them, with
// redirect: 'manual' so nothing is followed behind our back. Coordinates are read by src/renderer/anchor.js's parseAnchor,
// imported: the title screen's anchor field and the relay agree on what a link means. Nothing here logs.
//
// Pure but for the fetch it is handed, so vitest drives it with real-shaped Location headers.
import { parseAnchor } from '../src/renderer/anchor.js'

export const SHORT_HOSTS = Object.freeze(['maps.app.goo.gl', 'goo.gl'])
export const MAX_REDIRECTS = 3
const UA = 'backrooms-relay (+https://backrooms.thecornerspore.dev)'

// the whole string, nothing around it: https, one of the two forms, an id, and at most the share sheet's ?g_st= tag
const SHORT_RE = /^https:\/\/(maps\.app\.goo\.gl\/|goo\.gl\/maps\/)([A-Za-z0-9_-]{4,64})(?:\?g_st=[A-Za-z0-9._-]{1,64})?$/

// → the canonical short link ('https://maps.app.goo.gl/<id>' | 'https://goo.gl/maps/<id>') | null
export function shortLink(u) {
  if (typeof u !== 'string') return null
  const m = SHORT_RE.exec(u.trim())
  return m ? `https://${m[1]}${m[2]}` : null
}

const GOOGLE = new Set(['www.google.com', 'google.com'])
// a URL we may fetch next: https on the default port, no credentials, (www.)google.com, under /maps
function followable(u) {
  return u.protocol === 'https:' && !u.username && !u.password && !u.port && GOOGLE.has(u.hostname) && /^\/maps(?:\/|$)/.test(u.pathname)
}
// a URL we may read a pin from: the followable ones, and maps.google.com (read, never fetched)
function readable(u) {
  return followable(u) || (u.protocol === 'https:' && !u.username && !u.password && !u.port && u.hostname === 'maps.google.com')
}
function pinOf(u) {
  const a = parseAnchor(u.href)
  return a ? { lat: a.lat, lng: a.lng } : null
}

// One redirect's Location, resolved against the URL that sent it. → { lat, lng } | { follow: url } | { reason }
export function readHop(location, base) {
  if (typeof location !== 'string' || !location.trim()) return { reason: 'badredirect' }
  let u
  try { u = new URL(location, base) } catch { return { reason: 'badredirect' } }
  // a consent wall (an EU egress) is read, never fetched: the place it would continue to is in its continue= parameter
  if (u.protocol === 'https:' && u.hostname === 'consent.google.com' && !u.port && !u.username) {
    let c
    try { c = new URL(u.searchParams.get('continue') || '') } catch { return { reason: 'nocoords' } }
    if (!readable(c)) return { reason: 'badredirect' }
    return pinOf(c) || { reason: 'nocoords' }
  }
  const short = shortLink(u.href)
  if (short) return { follow: short }
  if (!readable(u)) return { reason: 'badredirect' }
  const pin = pinOf(u)
  if (pin) return pin
  return followable(u) ? { follow: u.href } : { reason: 'nocoords' }
}

// → { lat, lng } | { reason: 'link' | 'nocoords' | 'badredirect' | 'upstream' }
export async function resolveShortLink(link, fetchFn) {
  let url = shortLink(link)
  if (!url) return { reason: 'link' }
  for (let hop = 0; ; hop++) {
    let res
    try {
      res = await fetchFn(url, { method: 'GET', redirect: 'manual', headers: { 'user-agent': UA } })
    } catch {
      return { reason: 'upstream' }
    }
    const body = res.body
    if (body && typeof body.cancel === 'function') body.cancel().catch(() => {})   // only the headers matter
    const loc = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null
    if (!loc) return { reason: res.ok ? 'nocoords' : 'upstream' }
    const step = readHop(loc, url)
    if (step.lat != null) return step
    if (step.follow && hop < MAX_REDIRECTS) { url = step.follow; continue }
    return { reason: step.reason || 'nocoords' }
  }
}
