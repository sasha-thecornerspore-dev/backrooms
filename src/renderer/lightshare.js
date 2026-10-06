// lightshare.js — who carries the light. A friend's flashlight reaches the people standing in it, and a friend's ward lands on
// YOUR creatures only where it hits: on a relay the things are client-local, so the receiver re-runs the warder's tap on its own.
//
// Pure. game.js owns the bus, the peer positions and the messages; this module owns the geometry and the lines. Nothing allocates:
// every helper returns an existing record, a boolean or a string, and peers are read by index (the bus's one reused array).
//
// litFriendNear(self, peers, { cells, los, pos }) -> the nearest lit, non-legacy peer record within reach (identity) | null
//   pos(id) -> { x, y } | null is the client's live remote record; los(ax, ay, bx, by) the core's lineOfSight over the floor.
//   without los the light reaches only LIT_RANGE_NO_LOS (a wall between you is assumed close).
// inCone(ward, self, { range, arc }) -> the receiver-side mirror of entities.js ward()'s cone test, WARD_TAP's shape by default
//   (the relayed payload { x, y, a, lvl } carries no charged flag: only the tap-shaped core of a ward is believed remotely).
// wardOutcome(cone, res) -> 'steadied' | 'nothing' | 'elsewhere' | 'silent';  wardLine(outcome, name, res) -> string | null
// litOffLine(name | null) -> the L line; null is game.js's own string byte for byte.
import { WARD_TAP } from './ward.js'

export const LIT_RANGE = 6, LIT_RANGE_NO_LOS = 4

export function litFriendNear(self, peers, { cells = LIT_RANGE, los = null, pos } = {}) {
  const reach = los ? cells : Math.min(cells, LIT_RANGE_NO_LOS)
  const r2 = reach * reach
  let best = null, bestD2 = Infinity
  for (let i = 0; i < peers.length; i++) {
    const rec = peers[i]
    if (rec.legacy === true || rec.lit !== true) continue        // belt and braces: the bus never hands a legacy record over
    const q = pos(rec.id)
    if (!q) continue
    const qx = q.x, qy = q.y                                     // read at once, never retained
    const dx = qx - self.x, dy = qy - self.y
    const d2 = dx * dx + dy * dy
    if (d2 > r2 || d2 >= bestD2) continue                        // equal d² keeps the first
    if (los && !los(self.x, self.y, qx, qy)) continue
    best = rec; bestD2 = d2
  }
  return best
}

export function inCone(ward, self, { range = WARD_TAP.range, arc = WARD_TAP.cone } = {}) {
  // the same arithmetic as entities.js ward() so the verdicts agree to the last bit (equality at the edge is IN there too)
  const dx = self.x - ward.x, dy = self.y - ward.y
  const d = Math.sqrt(dx * dx + dy * dy)
  if (d > range) return false
  let a = Math.atan2(dy, dx) - ward.a
  a = Math.atan2(Math.sin(a), Math.cos(a))
  return !(Math.abs(a) > arc / 2)
}

export function wardOutcome(cone, res) {
  const touched = res.hit > 0 || res.dispelled > 0
  if (cone) return touched ? 'steadied' : 'nothing'
  return touched ? 'elsewhere' : 'silent'                       // a miss that was not near you is not your business
}

export function wardLine(outcome, name, res) {
  switch (outcome) {
    case 'steadied': return `${name} pushes the dark off you.`
    case 'nothing':  return `${name} pushes at the dark near you. it gives nothing back.`
    case 'elsewhere':                                            // the plurals mirror the core's own ward lines
      if (res.dispelled > 0) return res.dispelled > 1 ? `they come apart in ${name}'s light.` : `it comes apart in ${name}'s light.`
      return res.hit > 1 ? `they recoil from ${name}.` : `it recoils from ${name}.`
    default: return null
  }
}

export function litOffLine(litName) {
  return litName ? `flashlight off — you stand in ${litName}'s light.` : 'flashlight off — the dark leans in.'
}
