// firstrun.js — the first run, authored. The lobby is the establishing shot: on the fixed first world a fresh solo run finds a note by
// the spawn that names a lost soul and where they stand, the soul names a room, and the room holds the first way down. Three steps, four
// lines, and the faint pull held back until the soul has spoken or the lobby has had its 120 s.
//
// Pure. The places were picked on the fixed world (worldSeed null) in the harness: a fresh run spawns at the origin's hall crossing,
// facing down the long east hall; the radio's page lies on that hall 17 u on and is still the first thing read; the note lies at the next
// crossing, at the mouth of the hall that runs south; the soul stands in the alcove by the orange cone further east; the room is the wide
// one through the wall at the south end of that hall, around the way the compass names from the spawn (26 m). test/firstrun-world.test.js
// pins every one of them on a real chunk cache. Nothing that exists moves: the note is a record of its own (frag -1, never in SCRAPS,
// never a page's key), and the soul keeps its pool for everyone else and for every other time.
//
// createFirstRun({ fresh, worldSeed, room, step, level }) -> {
//   onLevel(index)  a floor arrived on: the thread listens on the lobby, waits on the block, and lapses for good on any floor below
//   tick(dt)        lobby time, while it listens
//   onRead(id)      a note read (its record's key) -> true when it was the thread's note: step 1
//   onSoul(key)     a lost soul spoken to (its chunk key) -> the soul's own line (step 2), its line asked again, or null (the pool)
//   onEnter(ix, iy) the cell you stand in -> the room's line, once, on entering the room at step 2 (step 3: done); else null
//   step()  0..3     done()  step 3     on()  it can still advance
//   unlocked()      the pull and the exit hint come free: step >= 2, 120 s of lobby time, or the thread holds nothing here
//   toward()        the room's way while the thread waits on the room (where the pull should lean), else null
// }
// Off: anything but a fresh solo run of the fixed first world (fresh !== true, any worldSeed, an online room), a resume past the room
// (step >= 3), and the block and every floor below. Off, it holds nothing and says nothing.
import { LOBBY, BLOCK } from './topology.js'

export const FIRST_RUN_UNLOCK_S = 120
// the presence hush: on a run's first lobby visit, before any death, the presence waits this long before it offers to speak
export const PRESENCE_HUSH_S = 40

// at the crossing past the radio's page, where the hall south to the room begins: on the line a fresh player walks, in sight from the page
export const FIRST_NOTE = Object.freeze({
  key: 'firstrun', x: 33.5, y: 12.5,
  text: 'if you have only just come through: someone waits by the orange cone, further down this hall. ask them. they remember the way down.',
})
// the soul of chunk 2,0 (decor keys a soul by its chunk): the alcove north of the hall, a few steps from the cone
export const FIRST_SOUL = Object.freeze({
  key: '2,0',
  line: 'the way down is in the wide room through the wall, back where you found the paper. the corner there has worn thin.',
  again: 'you will know the room. it is the one that does not want you in it.',
})
// the room, in integer cells (inclusive): the wide room of chunk 1,1 the crossing hall runs into, around that chunk's exit
export const FIRST_ROOM = Object.freeze({
  key: '1,1', x0: 27, y0: 23, x1: 39, y1: 28,
  way: Object.freeze({ key: '1,1', x: 34.5, y: 24.5 }),
  line: 'the corner of this room has come away from itself.',
})

// the step table: step n waits for STEPS[n]; at DONE the thread is over
export const STEPS = Object.freeze([
  Object.freeze({ on: 'read', key: FIRST_NOTE.key }),
  Object.freeze({ on: 'soul', key: FIRST_SOUL.key }),
  Object.freeze({ on: 'enter', key: FIRST_ROOM.key }),
])
export const DONE = STEPS.length

export function inRoom(ix, iy) {
  return ix >= FIRST_ROOM.x0 && ix <= FIRST_ROOM.x1 && iy >= FIRST_ROOM.y0 && iy <= FIRST_ROOM.y1
}

// the note as a scrap record for decor's list: read on the same card as a page, but frag -1 so it is no page, and never the block's form
export function noteRecord() {
  return { key: FIRST_NOTE.key, x: FIRST_NOTE.x, y: FIRST_NOTE.y, frag: -1, firstrun: true }
}

export function createFirstRun({ fresh = false, worldSeed = null, room = false, step = 0, level = LOBBY } = {}) {
  let at = Number.isInteger(step) && step > 0 ? Math.min(step, DONE) : 0
  const off = fresh !== true || (worldSeed !== null && worldSeed !== undefined) || !!room
  let here = false        // on the lobby now
  let lapsed = false      // gone below: the loop may bring you back, the thread does not come with it
  let lobbyT = 0

  const on = () => !off && !lapsed && at < DONE
  const listening = () => here && on()

  function onLevel(index) {
    here = index === LOBBY
    if (!here && index !== BLOCK && index !== '∅') lapsed = true    // the block is the way in, not a way on
  }
  onLevel(level)

  function tick(dt) { if (listening() && Number.isFinite(dt) && dt > 0) lobbyT += dt }

  function onRead(id) {
    if (!listening() || at !== 0 || id !== FIRST_NOTE.key) return false
    at = 1
    return true
  }

  // before the note the soul is any lost soul; after the room it goes back to its pool
  function onSoul(key) {
    if (!listening() || at < 1 || key !== FIRST_SOUL.key) return null
    if (at === 1) { at = 2; return FIRST_SOUL.line }
    return FIRST_SOUL.again
  }

  function onEnter(ix, iy) {
    if (!listening() || at !== 2 || !inRoom(ix, iy)) return null
    at = DONE
    return FIRST_ROOM.line
  }

  function unlocked() { return !listening() || at >= 2 || lobbyT >= FIRST_RUN_UNLOCK_S }
  function toward() { return listening() && at === 2 ? FIRST_ROOM.way : null }

  return { onLevel, tick, onRead, onSoul, onEnter, step: () => at, done: () => at >= DONE, on, unlocked, toward }
}
