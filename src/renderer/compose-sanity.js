// compose-sanity.js — the one sanity step. Pure: no DOM, no audio, no prefs, no net; one reused result, nothing allocated.
//
// The post-core block in game.js, term for term and in its order (light ±2, the depth drain — Level ∅ drains nothing —, -3
// hunted, -gazeRate under a gaze, +3 for one friend within 6), plus what the file adds: the column's light (rules.lightTerm),
// the status's or a closing's depth term, the pin's leash (rules.leash -> leashDrain), and the company pool a FRESH friend draws
// on (a friend steadies you, then it stops helping until you have been apart a while). Lying down: -1, nothing else counts.
// delta is per second (the caller multiplies by dt, as `sanity + sdelta * dt` does); companyDelta is this frame's (already x dt)
// and goes to rollcall's company.add(). The two lines are the caller's to show (PRIO.discovery).
import { leashDrain } from './origin-anchored.js'
import { thinGiverMul } from './origin-thin.js'

export const COMPANY = Object.freeze({ max: 60, drain: 3, refill: 0.75 })   // rollcall.js COMPANY's three: 60 -> 0 in 20 s, back in 80 s

export const EXHAUSTED_LINE = 'you have been standing together a long time. it stops helping.'
export const DISAGREE_LINE = 'you disagree about the file. it is still easier together.'

const MAILED = 'notice-mailed'

// a status rule, no block owns it: the same word, or someone who never answered, is full company
export function affinity(a, b) {
  return (a === b || a === MAILED || b === MAILED) ? 1 : 0.5
}

const out = { delta: 0, companyDelta: 0, exhaustedNow: false, disagreeNow: false, nearestFriendId: null }
const fb = { rp: null, selfAseed: null }     // the one friendBase argument, refilled per peer

export function sanityStep(ctx) {
  out.exhaustedNow = false; out.disagreeNow = false; out.nearestFriendId = null
  if (ctx.down) { out.delta = -1; out.companyDelta = 0; return out }

  const rules = ctx.rules
  let d = rules.lightTerm(ctx.flashlight, ctx.litNear, ctx.depth)
  if (ctx.standing && d < 0) d = 0             // a stand being held (closings.js): the dark does not eat you — the lights hold
  const co = ctx.closingOverlay
  d += (co && co.sanityDepthTerm) ? co.sanityDepthTerm(ctx.index, ctx.depth) : ctx.mods.sanityDepthTerm(ctx.index, ctx.depth)
  if (ctx.hunted) d -= 3                       // something is on you
  if (ctx.gaze) d -= ctx.gazeRate              // a smiler held on screen (1.5), a watcher watched back (3)
  if (rules.leash) d -= leashDrain((ctx.drift || 0) + (ctx.leashDebt || 0), ctx.leashCalm)

  // friends: one counted. A peer the bus has no fresh here for (an old client, a stale record, no bus at all) is the legacy
  // friend: the first within 6 gives +3 and ends the search. Fresh peers on this floor within 6 are rated base x affinity x
  // giver; the best is drawn from the company pool.
  const remotes = ctx.remotes, fresh = ctx.fresh, onFloor = ctx.onFloor, p = ctx.player
  const self = ctx.self
  let best = null, bestRate = 0, legacyFriend = false
  if (remotes) {
    fb.selfAseed = self ? (self.aseed ?? null) : null
    for (let i = 0; i < remotes.length; i++) {
      const rp = remotes[i]
      const isFresh = fresh != null && fresh(rp.id) === true
      if (isFresh && onFloor && !onFloor(rp.id)) continue
      if (!((rp.x - p.x) ** 2 + (rp.y - p.y) ** 2 < 36)) continue
      if (!isFresh) {
        if (best === null) { legacyFriend = true; break }
        continue                                // a fresh friend was found first: it is the one
      }
      fb.rp = rp
      const rate = rules.friendBase(fb) * affinity(self ? self.status : MAILED, rp.status) * (rp.thin === true ? thinGiverMul(rp.stillFor) : 1)
      if (rate > bestRate) { bestRate = rate; best = rp }
    }
    fb.rp = null
  }
  const dt = ctx.dt
  if (legacyFriend) {
    d += 3
    out.companyDelta = COMPANY.refill * dt     // no FRESH friend: the pool refills (harmless without a bus)
  } else if (best !== null) {
    out.nearestFriendId = best.id
    if (ctx.company > 0) {
      d += bestRate
      out.companyDelta = -COMPANY.drain * dt
      out.exhaustedNow = ctx.companyWas > 0 && ctx.companyWas + out.companyDelta <= 0
    } else out.companyDelta = 0
    const mine = self ? self.status : MAILED
    out.disagreeNow = !ctx.disagreeSaid && mine !== MAILED && best.status != null && best.status !== MAILED && best.status !== mine
  } else {
    out.companyDelta = COMPANY.refill * dt
  }
  out.delta = d
  return out
}
