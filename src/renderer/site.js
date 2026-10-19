// site.js — where the game lives on the web: the public origin, the invite link a friend opens (/play/?room=CODE[&anchor=LAT,LNG]), the
// case board's address off the site, and the relay's door for a phone's short maps link. Pure: no DOM, no globals read — index.html and
// game.js hand in what they have (location, fetch) and do the wiring.
import { parseAnchor, neighbourhood, neighbourhoodSeed } from './anchor.js'

export const SITE_ORIGIN = 'https://backrooms.thecornerspore.dev'
export const PLAY_URL = SITE_ORIGIN + '/play/'
export const RELAY_HTTP = 'https://backrooms-relay.jeff-schatz112.workers.dev'   // the same worker as index.html's wss:// RELAY_URL
export const ROOM_MAX = 32                                                          // the relay and the online modal cut a code at 32 too
export const RECOVER_LOCAL = '../recover/cases/'
export const RECOVER_SITE = SITE_ORIGIN + '/recover/cases/'
export const RESOLVE_TIMEOUT_MS = 8000

// the lines of the way in
export const ANCHOR_NOT_FOUND = "that place cannot be found. paste the full link from a computer's address bar, or the two numbers."
export const ANCHOR_LOOKING = 'looking for that place…'
export const PIN_WARNING = "a pin in a link is a place in a link. don't share your home, and don't paste this on stream."   // growth-spec §1.1, both opt-ins
export const PIN_PRESS_AGAIN = 'press again to send it with your place.'                // the PLAY ONLINE box's second press
export const PIN_AGAIN = '/invite pin again puts it in the link.'
export const NO_DOOR_LINE = 'no one can follow you here. play online and leave a door open.'
export const NO_PIN_LINE = 'you came in without a pin. the link carries the room only.'
export const NO_FIELD_PIN = 'there is no pin in the anchor field. the link carries the room only.'   // the modal's 'include my place', unpinned
export const lanLine = ({ code, lan }) => `this room is on your network. a friend uses JOIN LAN → ${lan || 'your address'} · room ${code}.`
// a pin in a room, said once beside 'connected' (game.js): a room's world is drawn from a pin's neighbourhood, never the pin. The first
// when the room's seed is your neighbourhood's (you opened it, or someone from the same cell did); the second when it was drawn before you
// came — your pin then reaches the others only as its neighbourhood's 'here' mark (anchor.js pinTag)
export const ROOM_PIN_LINE = "this room is drawn from your pin's neighbourhood. anyone with the code can see roughly where — never the door."
export const ROOM_PIN_MARK = "this room was drawn before you came. the others get only a mark of your pin's neighbourhood — enough to read roughly where, never the door."

// a room code as the relay will see it: text, no control characters, trimmed, at most 32; nothing -> null. The case is kept: the relay's
// room name is case-sensitive, so lowering it would split a room in two
export function normalizeRoom(s) {
  const t = String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, ROOM_MAX)
  return t || null
}

// ?room=CODE[&anchor=LAT,LNG] -> { room, anchor }; anything malformed is dropped, never thrown
export function readInvite(search) {
  let q
  try { q = new URLSearchParams(search || '') } catch { return { room: null, anchor: null } }
  return { room: normalizeRoom(q.get('room')), anchor: parseAnchor(q.get('anchor') || '') }
}

// the link a friend opens. The pin only when the caller hands one over (it is opt-in), and then only its neighbourhood, at the room
// grid's 2 decimals (anchor.js neighbourhood): a room's maze is drawn from no more than that, so the link carries no more of the place
// than the room uses. The friend's copy — 2.0.1 too — asks the room for the same seed the sender's does (anchor.js neighbourhoodSeed)
export function buildInvite({ room, anchor = null } = {}) {
  const code = normalizeRoom(room)
  if (!code) return null
  const q = new URLSearchParams({ room: code })
  const n = neighbourhood(anchor)
  if (n) q.set('anchor', `${n.lat.toFixed(2)},${n.lng.toFixed(2)}`)
  return `${PLAY_URL}?${q}`
}

// the line for a pin in a room (above), or null: no pin. worldSeed: the room's, as the welcome handed it over
export function roomPinLine({ anchor = null, worldSeed = null } = {}) {
  const own = neighbourhoodSeed(anchor)
  if (own == null) return null
  return Number(worldSeed) === own ? ROOM_PIN_LINE : ROOM_PIN_MARK
}

// the public site serves /recover/ beside /play/; everywhere else (the desktop app's file://, itch's CDN, localhost) reads the cases from
// the site itself (it sends Access-Control-Allow-Origin: *)
export function isOwnSite(loc) { return !!loc && /^https?:$/.test(loc.protocol) && loc.hostname === new URL(SITE_ORIGIN).hostname }
export function recoverBase(loc) { return isOwnSite(loc) ? RECOVER_LOCAL : RECOVER_SITE }

// JOIN LAN / HOST LAN reach a ws:// server on your network, which an https page is never allowed to open (mixed content)
export function lanReachable(loc) { return !(loc && loc.protocol === 'https:') }

// A phone's Share -> Copy link gives a short link with no coordinates in it. The id after the host is all that is kept: the share sheet's
// place name, the query, anything else pasted around it never leave the page
const SHORT_RE = /(?:^|[^\w.])(?:https?:\/\/)?(maps\.app\.goo\.gl|goo\.gl\/maps)\/([\w-]+)/i
export function shortMapsLink(text) {
  if (typeof text !== 'string') return null
  const m = text.match(SHORT_RE)
  return m ? `https://${m[1].toLowerCase()}/${m[2]}` : null
}
export function shortLinkQuery(link) { return `${RELAY_HTTP}/maps?u=${encodeURIComponent(link)}` }

// the relay's answer: { lat, lng } of a real place (numbers, or numeric strings), else null
const num = (v) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN)
export function pinFromResolver(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  const lat = num(body.lat), lng = num(body.lng)
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) return null
  return { lat, lng }
}

// the short link in `text`, resolved by the relay route (it follows the redirect and hands back lat,lng only) -> { lat, lng } or null.
// Never throws: a refusal, a bad body, no network, or no answer within timeoutMs are all null, and the field says ANCHOR_NOT_FOUND.
// No referrer (the page's own address may carry a room code) and no credentials go with it
export async function resolveShortLink(text, { fetch: f = globalThis.fetch, timeoutMs = RESOLVE_TIMEOUT_MS } = {}) {
  const link = shortMapsLink(text)
  if (!link || typeof f !== 'function') return null
  const ctl = typeof AbortController === 'function' ? new AbortController() : null
  const t = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null
  try {
    const r = await f(shortLinkQuery(link), { signal: ctl?.signal, cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' })
    if (!r || !r.ok) return null
    return pinFromResolver(await r.json())
  } catch {
    return null
  } finally {
    if (t) clearTimeout(t)
  }
}

// /invite [pin] in the console: what is said and what is copied. room is initGame's { code, route, lan } (null solo); warned: the pin's
// warning was shown this session. The pin goes in a link only on '/invite pin' (or 'here'), and only the second time: the first one
// says what a pin in a link is and copies nothing; what goes is its neighbourhood (buildInvite). -> { say, url, warned } (url null: nothing to copy)
export function inviteFor({ arg = '', room = null, anchor = null, warned = false } = {}) {
  if (!room || !normalizeRoom(room.code)) return { say: NO_DOOR_LINE, url: null, warned }
  if (room.route !== 'online') return { say: lanLine(room), url: null, warned }
  const withPin = /^(pin|here)$/i.test(String(arg).trim())
  if (!withPin) return { say: '', url: buildInvite({ room: room.code }), warned }
  if (!anchor) return { say: NO_PIN_LINE, url: buildInvite({ room: room.code }), warned }
  if (!warned) return { say: `${PIN_WARNING}\n${PIN_AGAIN}`, url: null, warned: true }
  return { say: PIN_WARNING, url: buildInvite({ room: room.code, anchor }), warned }
}
