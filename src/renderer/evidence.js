// evidence.js — evidence of you. A photograph of a friend develops what the file wrote on them; a photograph OF you makes you harder
// to erase for a while, or counts you back when you are down (game.js routes that through the one wake function, never die()).
//
// Pure. The frame test IS the sprite cull (raycaster.js inViewCone), so 'in frame' = 'drawn on screen' = 'seen by the thing'.
// Nothing allocates per call: subjectInFrame refills ONE reused result object (callers copy what they keep).
//
// inFrame(self, x, y, { cone, hf, maxCells, los }) -> boolean; without los the reach is SUBJECT_RANGE_NO_LOS.
// subjectInFrame(self, peers, { pos, cone, hf, maxCells, los }) -> the nearest non-legacy peer in frame, flattened into
//   { id, name, x, y, dist, facingMe, st, thin, seen, origin, status, aseed } (origin = rec.o, the bus's wire spelling) | null.
// createEvidence({ windowS, floor }) -> { seen(byId, t), floorAt(t), active(t), by(), until() } on playT SECONDS: a second photo
//   inside the window moves the end, it never raises the floor.
// photoOutcome(downSt) -> 'counted' | 'evidence'
import { inViewCone } from './raycaster.js'
import { HF } from './gfx-frame.js'

export const SUBJECT_RANGE = 10, SOUL_RANGE = 10, SUBJECT_RANGE_NO_LOS = 6, FACING_ME = 0.6
export const EVIDENCE_WINDOW_S = 90, EVIDENCE_FLOOR = 25
export const EVIDENCE_LINE = 'someone has evidence of you. you are harder to erase.'
export const COUNTED_LINE  = 'someone has evidence of you. you are counted.'

export function inFrame(self, x, y, { cone = inViewCone, hf = HF, maxCells = SUBJECT_RANGE, los = null } = {}) {
  const reach = los ? maxCells : Math.min(maxCells, SUBJECT_RANGE_NO_LOS)
  return cone(self.x, self.y, self.angle, x, y, hf, reach) && (los === null || los(self.x, self.y, x, y))
}

const subject = { id: null, name: null, x: 0, y: 0, dist: 0, facingMe: false, st: 'ok', thin: false, seen: false, origin: null, status: null, aseed: null }
const frameOpts = { cone: inViewCone, hf: HF, maxCells: SUBJECT_RANGE, los: null }

export function subjectInFrame(self, peers, { pos, cone = inViewCone, hf = HF, maxCells = SUBJECT_RANGE, los = null } = {}) {
  frameOpts.cone = cone; frameOpts.hf = hf; frameOpts.maxCells = maxCells; frameOpts.los = los
  let best = null, bestD2 = Infinity, bx = 0, by = 0, ba = null
  for (let i = 0; i < peers.length; i++) {
    const rec = peers[i]
    if (rec.legacy === true) continue
    const q = pos(rec.id)
    if (!q) continue
    const qx = q.x, qy = q.y, qa = q.angle                       // read at once, never retained
    const dx = qx - self.x, dy = qy - self.y
    const d2 = dx * dx + dy * dy
    if (d2 >= bestD2) continue
    if (!inFrame(self, qx, qy, frameOpts)) continue
    best = rec; bestD2 = d2; bx = qx; by = qy; ba = qa
  }
  frameOpts.los = null                                           // hold no caller's closure past the call
  if (best === null) return null
  let facingMe = false
  if (typeof ba === 'number') {                                  // they are looking at you, within ±FACING_ME
    const d = Math.atan2(self.y - by, self.x - bx) - ba
    facingMe = Math.abs(Math.atan2(Math.sin(d), Math.cos(d))) <= FACING_ME
  }
  subject.id = best.id; subject.name = best.name; subject.x = bx; subject.y = by; subject.dist = Math.sqrt(bestD2)
  subject.facingMe = facingMe; subject.st = best.st; subject.thin = best.thin; subject.seen = best.seen
  subject.origin = best.o; subject.status = best.status; subject.aseed = best.aseed
  return subject
}

export function createEvidence({ windowS = EVIDENCE_WINDOW_S, floor = EVIDENCE_FLOOR } = {}) {
  let until = -Infinity, lastBy = null
  const active = (t) => t < until
  return {
    seen(byId, t) { until = t + windowS; lastBy = byId },       // refresh, never stack
    active,
    floorAt: (t) => (active(t) ? floor : 0),
    by: () => lastBy,
    until: () => until,
  }
}

// W5's st is a string ('ok' is truthy): compare it
export function photoOutcome(downSt) { return downSt === 'down' ? 'counted' : 'evidence' }
