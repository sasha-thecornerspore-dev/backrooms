// film.js — the film is worth what it shows. A creature in the frame, close, with a clear line to you, develops on the polaroid, and the
// photo puts its den on your pencil sheet: once a kind a visit, and yours alone.
//
// Pure: no DOM, no audio, no prefs, no net, no clock. Per shot, so it may allocate (compose-polaroid.js's rule); nothing here runs per frame.
// game.js (developDen) runs it after the caption, as a step of its own: compose-polaroid.js is untouched, so its captions and the column's
// pins (the anchored pin, the tenant's address: the origins' and the claim's) develop exactly as they did. Never on the block, never with
// the creatures pref off (there is nothing in the halls to catch), and the pin is the sheet's like any other (fogmap.js pinThing 'den',
// flag = the kind, saved with the map), never sent anywhere: a friend's sheet does not get it.
//
// THE DEN. entities.js keeps the chunk each creature was placed in (chunkCx, chunkCy). A chunk that rolls a creature on this floor
// (entities.js isSpawnChunk: opts.home) is where it lives: each time the chunk streams back in, its creature stands up again by the chunk's
// hall crossing (topology.js chunkMid, open at every epoch), so that cell is the den. A thing that followed you down was placed where it
// arrived, not where it lives: its den is the cell it was caught in.
//
// DEN_RANGE: the reach in cells, straight-line AND the frame's own (evidence.inFrame with the walls' line of sight; no line, no den).
// KINDS: the creatures by the names the manual's bestiary gives them (variants.js's ids); a thing with no kind is a shade (as specFor reads it).
// denLine(kind) -> the line the film develops (DEN_LINE, the kind's name filled in), or null for anything that is not a creature
// denOf(e, home) -> { x, y }: the den's cell centre
// createFilm() -> { arrive(), develop(player, entities, opts) -> { key, kind, x, y, line } | null, caught(kind) -> boolean }
//   arrive()   a visit begins (game.js startVisit): every kind may develop again
//   develop    the nearest creature in frame within DEN_RANGE whose kind this visit has not developed yet, and that kind is spent; at most one
//              den a shot. opts = { cone, hf, los(ax, ay, bx, by), home(cx, cy) -> boolean }, read in the call and never kept
import { inFrame } from './evidence.js'
import { chunkMid } from './topology.js'

export const DEN_RANGE = 5
export const KINDS = Object.freeze(['shade', 'smiler', 'hound', 'lurker', 'watcher', 'crawler', 'tesla'])
// VOICE: flagged for the owner's read (one template, the bestiary's name in it)
export const DEN_LINE = 'the film develops the {kind}, and the hall it keeps to. you mark it on your map.'

const known = (kind) => KINDS.indexOf(kind) !== -1

export function denLine(kind) { return known(kind) ? DEN_LINE.replace('{kind}', () => kind) : null }

export function denOf(e, home) {
  if (home(e.chunkCx, e.chunkCy)) return chunkMid(e.chunkCx, e.chunkCy)
  return { x: Math.floor(e.x) + 0.5, y: Math.floor(e.y) + 0.5 }
}

export function createFilm() {
  const spent = new Set()                 // the kinds this visit has developed
  const frame = { cone: null, hf: 0, maxCells: DEN_RANGE, los: null }

  function develop(player, entities, opts) {
    if (!opts || typeof opts.los !== 'function') return null
    frame.cone = opts.cone; frame.hf = opts.hf; frame.los = opts.los
    let best = null, bestD2 = DEN_RANGE * DEN_RANGE + 1e-9
    for (let i = 0; i < entities.length; i++) {
      const e = entities[i]
      const kind = e.variant ?? 'shade'
      if (!known(kind) || spent.has(kind)) continue
      const dx = e.x - player.x, dy = e.y - player.y
      const d2 = dx * dx + dy * dy
      if (d2 >= bestD2) continue
      if (!inFrame(player, e.x, e.y, frame)) continue
      best = e; bestD2 = d2
    }
    frame.los = null; frame.cone = null                         // hold no caller's closure past the call
    if (best === null) return null
    const kind = best.variant ?? 'shade'
    spent.add(kind)
    const at = denOf(best, opts.home)
    return { key: 'den:' + Math.floor(at.x) + ',' + Math.floor(at.y), kind, x: at.x, y: at.y, line: denLine(kind) }
  }

  return { arrive: () => spent.clear(), develop, caught: (kind) => spent.has(kind) }
}
