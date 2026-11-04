// learn.js — the things learn your habits (M19, plan §4 row 6). Pure: no DOM, no audio, no clocks of its own (the play clock is passed in).
//
// Every floor counts how you got away from its hunts, by method, as the hunt tells them apart (hunt.js ESCAPE_KINDS):
//   still   the hunt lost you while the file hid you (aiCtx.hidden: still and silent, light and radio off)
//   run     it lost the line while you were not hidden: a corner, a door, distance; or you left it beyond the gate
//   ward    a push ended the hunt (it reeled, turned and searched where you had been; or it came apart in the light)
//   flash   the polaroid did (it reeled blind, or ran from it)
// A getaway counts when the thing gives up (its search runs out, it comes apart, it falls beyond the gate), not when the hunt breaks:
// a search that finds you again was no getaway. The lurker sent off by your light is its own rule, not a habit: not counted; nor is
// anything after a crawler's grab, which is its one rule and never a hunt (hunt.js huntsYou). A brood that gives up together is one getaway (LEARN.merge). The counts are the floor's memory (levelmem.escapesFor / noteEscape), so they
// last the rest of the run there, through a death and across a quit, and a new run starts clean.
//
// After the third getaway by one method on a floor (LEARN.after), every thing on that floor gains one refinement against it, for the
// rest of the run there. The refinements reach the hunt through ONE object (refinements(level)) handed to entities.setLearn: a table
// per method, null until it is taught. hunt.js and entities.js read it; with no object (null) nothing is tagged, emitted or changed.
// Each refinement reads only its own method's moment, so a player who switches method escapes as before:
//   still   while you are hidden, it waits where it lost you longer (x its loseTrack): 'it has learned to wait.'
//   run     when it loses the line, it keeps your last heading a few cells further (walls stop it), a moment longer, and searches there
//   ward    its reel before the turning opening is shorter (the opening, its double count and the dispel count are untouched)
//   flash   its blind reel is shorter; the smiler and the lurker run from it for less long
// Each is said once per floor (game.js: a discovery plate, kind 'learn', through the plate budget): the moment the floor learns it when
// the budget has room, else once an arrival on that floor has settled, offered again until it shows. A death or a travel before then
// does not lose it, nor does a quit: what each floor has said is its memory too (levelmem.toldOf / noteTold), so it is never said twice.
//
// Solo only. In a room each client runs its own things, but a friend's ward is relayed onto yours (game.js bus 'ward') and a room keeps
// no save: the habits would be no one's. Never on the block (Level ∅: no hunts, and nothing changes there). With the creatures setting
// off nothing hunts, so nothing counts and nothing acts.
import { ESCAPE_METHODS } from './levelmem.js'

const f = Object.freeze
export const LEARN = f({
  after: 3,            // the getaways by one method on a floor that teach its things
  merge: 20,           // s: another getaway by the same method within this of the last counted one is the same getaway
  // against stillness: x spec.loseTrack while the file hides you (shade 3.5 s -> 6.3 s). Never the watcher or the crawler: they never hunt
  still: f({ shade: 1.8, smiler: 1.8, hound: 1.5, lurker: 2, tesla: 1.6 }),
  // against the run: at the loss, on along your last heading up to `lead` u (stopped short of a wall; under a cell of room, none), and
  // `extra` s more before it searches there. The hound reads a trail best; the tesla barely moves
  run: f({ lead: f({ shade: 3, smiler: 3, hound: 4, lurker: 2.5, tesla: 2 }), extra: 1.5 }),
  // against the ward: x the reel before the turning opening (shade 2.6 s -> 1.88 s; the 0.8 s opening itself stays)
  ward: f({ shade: 0.6, smiler: 0.6, hound: 0.7, lurker: 0.6, watcher: 0.6, crawler: 0.7, tesla: 0.7 }),
  // against the flash: x the blind reel (1.8 s -> 1.08 s); the two that run from it start their 3 s run `head` s in
  flash: f({ reel: f({ shade: 0.6, hound: 0.6, watcher: 0.6, crawler: 0.6, tesla: 0.7 }), head: f({ smiler: 1.2, lurker: 1.2 }) }),
})

// said once per floor per method, as the floor learns it. 'it has learned to wait.' is the plan's; the other three are the owner's to
// voice (flagged for the voice pass)
export const LEARN_LINES = f({
  still: 'it has learned to wait.',
  ward: 'it has learned to come back.',
  run: 'it has learned which way you run.',
  flash: 'it has learned the flash.',
})

// the hunt's escape events (hunt.js ESCAPE_KINDS) -> the method they count
export const METHOD_OF = f(Object.fromEntries(ESCAPE_METHODS.map((m) => [`escape-${m}`, m])))

// whether a floor learns at all: alone, and never on the block
export function learnsHere({ room, block }) { return !room && !block }

// createLearning({ mem, tune }) -> { refinements(level), escape(level, kind, t), unsaid(level), said(level, line) }
//   refinements(level)  the ONE object the entity system reads ({ still, run, ward, flash }: tune's table, or null), filled for `level`.
//                       game.js hands it to entities.setLearn at buildLevel; escape() refreshes it in place when it is that floor's
//   escape(level, kind, t)  a getaway (the hunt's escape event `kind`) on `level` at play time t: counted unless it merges with the last
//                       one of its method there -> the line to say when this one taught the floor, else null
//   unsaid(level)       the line of a lesson the floor refinements was filled for has learned and not said yet, or null (another floor,
//                       or none). A read: game.js asks it every frame once an arrival settles; it allocates nothing and writes nothing
//   said(level, line)   the line showed: its method is said on that floor for good (levelmem.noteTold) -> whether it was a lesson line
export function createLearning({ mem, tune = LEARN }) {
  const refine = { still: null, run: null, ward: null, flash: null }
  let at = null, atLevel = null                                   // the floor refine was last filled for (its key, and as asked)
  const pend = []                                                 // that floor's lessons learned and not yet said, by method
  const lastT = new Map()                                         // 'level:method' -> when its last getaway was counted (not saved)

  function fill(level) {
    const c = mem.escapesFor(level)
    refine.still = c.still >= tune.after ? tune.still : null
    refine.run = c.run >= tune.after ? tune.run : null
    refine.ward = c.ward >= tune.after ? tune.ward : null
    refine.flash = c.flash >= tune.after ? tune.flash : null
    at = String(level); atLevel = level
    pend.length = 0
    for (const m of ESCAPE_METHODS) if (c[m] >= tune.after && !mem.toldOf(level, m)) pend.push(m)
  }

  function refinements(level) { fill(level); return refine }

  function escape(level, kind, t) {
    const method = Object.hasOwn(METHOD_OF, kind) ? METHOD_OF[kind] : null
    if (method === null) return null
    const key = `${level}:${method}`
    const last = lastT.get(key)
    if (last !== undefined && t - last < tune.merge) return null
    lastT.set(key, t)
    const n = mem.noteEscape(level, method)
    if (at === String(level)) fill(level)
    return n === tune.after ? LEARN_LINES[method] : null
  }

  function unsaid(level) { return level === atLevel && pend.length > 0 ? LEARN_LINES[pend[0]] : null }

  function said(level, line) {
    const method = ESCAPE_METHODS.find((m) => LEARN_LINES[m] === line)
    if (method === undefined) return false
    mem.noteTold(level, method)
    if (at === String(level)) { const i = pend.indexOf(method); if (i !== -1) pend.splice(i, 1) }
    return true
  }

  return { refinements, escape, unsaid, said }
}
