// rollcall.js — the roll call: who answered your whistle, who has gone quiet, and the company you draw on near a friend.
//
// Pure. The whistle itself is the integrator's (game.js whistleOut: audio.whistle + one noise of WHISTLE_NOISE at your feet + the 'ev'
// frame + one line); this module keeps the numbers and the small sums it needs: the pitch a player whistles at, the chat bearing
// ('near ↗'), how loud and where a friend's whistle sounds, the count line (words, never digits — the map footer is the only stat),
// and the three 'ev' registrations as data. The roll call and the pool run on the MILLISECOND clock the caller injects (game.js:
// performance.now(), so a kneel or a whistle arriving from the socket outside the loop is counted on the same clock); every `t` is
// optional and defaults to now().
import { exitArrow } from './compass.js'

export const SEMIS = Object.freeze([0, 2, 4, 7, 9, 12, 14])   // a major pentatonic over two octaves: any two calls sit well together
export const FAR_CELLS = 12
export const WORDS = Object.freeze([, 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'])

export const WHISTLE_COOLDOWN_MS = 10000   // your own whistle (the bus's outgoing 8 s gap is the wire's; this is the hall's)
export const WHISTLE_NOISE = 14            // louder than the ward's 12: the things round two corners hear it
export const QUIET_SANITY = 4
export const SOLO_SANITY = 2
export const FAR_BONUS = Object.freeze({ cells: 12, sanity: 4, company: 20 })
export const ECHO = Object.freeze({ chance: 1 / 6, delayMs: 1200, sanity: 3, footfalls: 2 })
export const COMPANY = Object.freeze({ max: 60, drain: 3, refill: 0.75, rate: 3 })
export const NO_ANSWER_LINE = 'the hall takes it and gives nothing back.'
export const ECHO_LINE = 'something whistles back. the pitch is wrong.'

const defaultNow = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())

// FNV-1a over the UTF-16 code units, unsigned: a pitch must never change between releases or machines
function hash32(s) {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

// two 'wanderer's are told apart by their ids
export function whistlePitch(id, name) {
  return SEMIS[hash32(String(id) + '\0' + String(name)) % SEMIS.length]
}

export function bearingLabel(dx, dy, angle) {
  const dist = Math.hypot(dx, dy)
  return `${dist < FAR_CELLS ? 'near' : dist < 40 ? 'far' : 'very far'} ${exitArrow(Math.atan2(dy, dx) - angle)}`
}

export function whistleGain(dist, radioOn) {
  const g = 1 - dist / 40
  return (g < 0.08 ? 0.08 : g > 1 ? 1 : g) / (radioOn ? 2 : 1)
}

// a friend to your right pans right
export function whistlePan(dx, dy, angle) {
  const s = Math.sin(Math.atan2(dy, dx) - angle)
  return s < -1 ? -1 : s > 1 ? 1 : s
}

export function countLine(n) {
  return n <= 1 ? 'one. just you.' : n === 2 ? 'two of you, counting yourself.' : n <= 12 ? `${WORDS[n]} of you.` : 'more of you than you can count.'
}

// the three registrations, as data for bus.register(kind, spec); `c` is the boolean the emit sends (count <= 32), so undefined fails
export function evKinds(getMyId) {
  return Object.freeze({
    whistle: { check: (p) => Number.isInteger(p.lvl) && p.lvl >= 0 && p.lvl <= 4 && Number.isFinite(p.x) && Number.isFinite(p.y) && p.c <= 32, minGapMs: 8000, posKeys: ['x', 'y'] },
    kneel: { check: (p) => typeof p.to === 'string' && p.to === getMyId(), maxDist: 2.0, minGapMs: 350 },
    woke: { check: (p) => typeof p.by === 'string' && p.by === getMyId(), maxDist: 3.0 },
  })
}

const NO_PEERS = []

// farCells is the far-bonus reach the caller compares against (FAR_BONUS.cells); the module's own labels use FAR_CELLS
export function createRollCall({ now = defaultNow, rng = Math.random, quietMs = 90000, farCells = FAR_CELLS, farMs = 60000, forgetMs = 600000 } = {}) {
  const recs = new Map()      // id -> { id, name, lastTouch, hearAt, listedAt, seated }
  const farAt = new Map()     // id -> the last far bonus
  const out = []              // the one effects array tick() hands back
  const pool = []             // its reused effect records

  function rec(id, t) {
    let r = recs.get(id)
    if (!r) { r = { id, name: null, lastTouch: t, hearAt: -Infinity, listedAt: t, seated: false }; recs.set(id, r) }
    return r
  }

  function hear(id, name, x, y, t = now()) {
    const r = rec(id, t)
    if (name != null) r.name = name
    r.hearAt = t; r.x = x; r.y = y
    r.lastTouch = t
  }

  // a chat line from them, or a frame they stood within 6 cells
  function touch(id, t = now()) { rec(id, t).lastTouch = t }

  // `peers` is bus.freshPeersOnFloor(): those not in it this tick are exempt (kept as they are), never re-seated
  function tick(t = now(), peers = NO_PEERS) {
    out.length = 0
    const list = peers || NO_PEERS
    for (let i = 0; i < list.length; i++) {
      const p = list[i]
      const r = rec(p.id, t)
      if (p.name != null) r.name = p.name
      r.listedAt = t
      if (!r.seated) { r.seated = true; r.lastTouch = t; continue }
      if (t - r.lastTouch > quietMs) {
        r.lastTouch = t
        const e = pool[out.length] || (pool[out.length] = { type: 'quiet', id: null, name: null, line: '' })
        e.id = r.id; e.name = r.name; e.line = `it has been a while since ${r.name}. the hall is quiet.`
        out.push(e)
      }
    }
    // unseen in a list for forgetMs: dropped (a whistle still inside the count keeps it)
    for (const [id, r] of recs) if (t - r.listedAt > forgetMs && t - r.hearAt > quietMs) recs.delete(id)
    return out
  }

  // who answered: hears only (a touch is not an answer)
  function count(t = now()) {
    let n = 1
    for (const r of recs.values()) if (t - r.hearAt <= quietMs) n++
    return n
  }

  function echoRoll() { return rng() < ECHO.chance }

  function farBonusOk(id, t = now()) {
    const last = farAt.get(id)
    if (last !== undefined && t - last < farMs) return false
    farAt.set(id, t)
    return true
  }

  function forget(id) { recs.delete(id); farAt.delete(id) }

  return { hear, touch, tick, count, echoRoll, farBonusOk, forget }
}

// The company pool: being near a friend steadies you while it lasts; apart, it refills. At runtime W4's sanityStep drives it through
// add(companyDelta); step() is the reference drain / refill the tests replay against.
export function createCompany({ max = COMPANY.max, drain = COMPANY.drain, refill = COMPANY.refill, rate = COMPANY.rate } = {}) {
  let value = max
  const res = { sanityDelta: 0, exhaustedNow: false }

  function add(n) {
    if (Number.isNaN(n)) return value
    const v = value + n
    value = v < 0 ? 0 : v > max ? max : v
    return value
  }

  function step(dt, friendNear) {
    res.exhaustedNow = false
    if (friendNear) {
      if (value > 0) {
        const v = value - drain * dt
        value = v > 0 ? v : 0
        res.sanityDelta = rate
        res.exhaustedNow = value === 0
      } else {
        res.sanityDelta = 0
      }
    } else {
      const v = value + refill * dt
      value = v > max ? max : v
      res.sanityDelta = 0
    }
    return res
  }

  function reset() { value = max }

  return { get value() { return value }, add, step, reset }
}
