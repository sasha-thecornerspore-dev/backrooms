// containers.js — the searchable drawers. Walk up to a cabinet, hold F for three quarters of a second, and the drawer gives up what it
// holds: most often words, sometimes nothing, sometimes a thing you can carry, sometimes a floor plan that marks your map, rarely a
// door two rooms over or a figure in the corridor you just walked. What a drawer holds is a pure function of its key, its chunk and a
// bonus (0 unless tier 2a pays for danger), so a save and a reload agree; whether you have already opened it rides the save through
// createSearchLog (levelmem.searchedFor / noteSearched).
//
// Pure: no DOM, no game state. game.js runs the hold, the cancel, the noise and the per-level cost; applyRoll does the one roll's
// side effects through a tiny api so the module never touches the inventory or the message queue itself.
import { LEVELS } from './levels.js'
import { CHANNELS } from './channels.js'
import { ITEM_TYPES } from './items.js'
import { PRIO } from './messages.js'

export const CONTAINER_TYPES = Object.freeze({
  cabinet: 'the cabinet', crate: 'the crate', box: 'the box', toolbox: 'the toolbox', 'cabinet-e': 'the panel cabinet',
  cart: 'the cart', drum: 'the drum', couch: 'the couch cushions',
})
export const SEARCH_HOLD_S = 0.75
// the longer hold in the dark, for tier 2a (exported now, unused here)
export const SEARCH_HOLD_DARK_S = 1.1
export const HANDS_FULL_LINE = 'there is something here, but your hands are full.'
// the search's own words: the hint while the hold runs (never a plate), over a searched one, and the refusal with something close
export const NOT_NOW_LINE = 'not now. something is close.'
export const SEARCHED_HINT = 'searched.'
export function searchingHint(type) { return CONTAINER_TYPES[type] ? `searching ${CONTAINER_TYPES[type]}` : 'searching' }
// the deep floors charge for every completed search (game.js applies it: applyRoll does not know the level); the line is said once a level
export const DRAWER_COST = Object.freeze({ minLevel: 2, sanity: 2, line: 'something counts the drawers you open.' })
// the one empty that is heard: applyRoll makes a real noise of 3 at the drawer with it
export const SQUEAL_LINE = 'empty. the runners squeal.'
export const EMPTY_LINES = Object.freeze([
  'empty. someone has been through here.',
  'empty. the drawer sticks on the way back.',
  'nothing. a smell of warm paper.',
  'empty. the bottom of the drawer is cleaner than the rest.',
  'nothing but a paperclip, bent straight.',
  'empty. dust, and the outline of something that was here.',
  'nothing. you check again anyway.',
  SQUEAL_LINE,
])
// a trace pins something on your map (api.trace, content first, a way on last) and says which
export const TRACE_LINES = Object.freeze({
  content: 'a floor plan with one room shaded in. you mark it on yours.',
  way: 'a floor plan. someone has circled a corner and written down.',
})
export const DRAWER_NOTES = Object.freeze([
  'a memo: DO NOT DRINK FROM THE FOUNTAIN ON 2. it is dated the day you fell in.',
  'a name badge. the name has been scratched out and written again, smaller.',
  'an inventory of chairs. forty-one listed, forty-three counted, in a different hand.',
  'a leave request, approved. the dates are both the same day.',
  'a form in triplicate. the pink copy is blank, the yellow copy is blank, the white copy is missing.',
  'a floor plan. the room you are standing in is not on it.',
  'a sign-out sheet. the last name signed out but never in.',
  'a memo about the hum. it asks everyone to stop mentioning the hum.',
  'a receipt for forty-one chairs. the vendor address is this one.',
  'a laminated card: IN THE EVENT OF. the rest has been cut off with scissors.',
  'a letter of resignation, unsent, addressed to a department of one.',
  'a stapler. the staples have been removed one at a time and lined up.',
  'a timesheet. every entry reads 9 to 5. every date is the same date.',
  'a map of the fire exits. each one has been crossed out, lightly, in pencil.',
  'a notice: the fountain on 2 has been repaired. there is no 2.',
  'a photograph of this drawer, open, with the photograph in it.',
  'minutes of a meeting. attendees: one. action items: keep walking.',
  'a key with no teeth. the tag says SPARE.',
  'a page of the phone list. every extension is the same four digits.',
  'a card of condolence, signed by the whole office. nobody has filled in the name.',
  'a coffee mug, stained in rings, one above another.',
  'a lanyard with no badge on it. the clip is bent, as if pulled.',
  'a performance review. under strengths: stays.',
  'a sticky note: do not answer it. the writing gets smaller toward the end.',
  'a box of pens. every pen has been chewed in the same place.',
  'a calendar with every day crossed out, including the ones not yet come.',
  'a memo about the carpet. the carpet is to be left damp.',
  'a photograph of the office party. everyone is facing the wall.',
  'a hand-drawn map of this floor. it runs off the page and carries on across the desk.',
  "a visitor badge. the photo is of the back of someone's head.",
  'a list of exits, all crossed out, then one written in, then crossed out.',
  'a tape measure, pulled out and locked, as if someone meant to come back to it.',
  'a request for a window. denied. reason: there is no outside.',
  'a key ring heavy with keys. none of them open anything here.',
  'a glove, the left one. the drawer beside it is empty in the shape of the right.',
  "a cardigan folded in the drawer, still holding the shape of someone's shoulders.",
  'reading glasses, folded, on top of a letter that was never started.',
  'a birthday card signed by everyone. the name on the front has been left blank.',
  'a packed lunch, the lid still on, the name on the lid rubbed away.',
  "a set of house keys, the fob worn smooth by someone's thumb.",
])
const FOUND_LABEL = Object.freeze({
  'almond-water': 'almond water', glowstick: 'a glowstick', bandage: 'a bandage', polaroid: 'a polaroid camera', radio: 'a radio',
})
const HAUNT_IDS = Object.freeze(['door-slam', 'cold-spot', 'footsteps', 'behind-you'])

// decor.js's hash and rng, verbatim: the roll reads the same (cx, cy, seed) space as every other chunk placement, on its own
// channels.js constants (containerSlot / containerRoll), so it perturbs nothing and nothing perturbs it
function hash(a, b, c = 0) {
  let h = (a * 2654435761 ^ b * 2246822519 ^ Math.imul(c, 3266489917)) >>> 0
  h ^= h >>> 16; h = Math.imul(h, 0x45d9f3b) >>> 0
  h ^= h >>> 16
  return h >>> 0
}
function rngFrom(a, b, seed = 0) {
  let s = hash(a, b, seed) | 1
  return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 0xffffffff }
}
const [SLOT_A, SLOT_B] = CHANNELS.containerSlot.gate
const [ROLL_A, ROLL_B] = CHANNELS.containerRoll.gate

// foldKey(key) -> int32: sum of charCode * 31^k, so any key shape folds ('3,-2:4' from the scatter, '3,-2:d2' from a dressed room)
export function foldKey(key) {
  const s = String(key)
  let h = 0, p = 1
  for (let i = 0; i < s.length; i++) { h = (h + Math.imul(s.charCodeAt(i), p)) | 0; p = Math.imul(p, 31) }
  return h
}

// the one index in eight that may hold an item in this chunk; consecutive prop indices fold to distinct residues, so at most one of
// eight scatter props is ever item-eligible (the fold is int32, so its residue is read on the low three bits: a negative fold is
// as eligible as a positive one)
export function itemSlot(cx, cy, seed, salt) { return hash(cx + SLOT_A + salt, cy + SLOT_B + salt, seed) % 8 }
export function isItemEligible(key, cx, cy, seed, salt) { return (foldKey(key) & 7) === itemSlot(cx, cy, seed, salt) }

function itemPool(levelIndex) {
  const lvl = Number.isInteger(levelIndex) ? LEVELS[levelIndex] : LEVELS.find((l) => l.id === levelIndex)
  const types = lvl?.config.items?.types?.length ? lvl.config.items.types : ITEM_TYPES
  if (Number.isInteger(levelIndex) && levelIndex >= 1 && levelIndex <= 3 && !types.includes('bandage')) return [...types, 'bandage']
  return types
}

// rollContainer(key, cx, cy, levelIndex, seed, salt, bonus = 0) -> { kind: 'empty' } | { kind: 'item', type, extra } |
// { kind: 'note', text } | { kind: 'trace', fallback } | { kind: 'haunt', id }. Eligible (the chunk's item slot): 50 item / 30 note /
// 10 trace / 10 haunt; otherwise 38 empty / 39 note / 10 trace / 3 item / 10 haunt: one key in eight is eligible, so a floor's drawers
// give an item about one time in eleven and are empty about one time in three. The haunt band is where it always was, so the same
// drawers haunt. Level 0 folds the haunt share into notes. `bonus` (points out of a hundred, from a second draw on the same hash)
// only ever turns an empty or a note into an item; at 0 the table is exact. Almond water is sour 30% of the time from level 2 down.
export function rollContainer(key, cx, cy, levelIndex, seed = 0, salt = 0, bonus = 0) {
  seed |= 0; salt |= 0
  const fk = foldKey(key)
  const eligible = isItemEligible(key, cx, cy, seed, salt)
  const a = cx + ROLL_A + salt + fk, b = cy + ROLL_B + salt
  const h = hash(a, b, seed)
  const roll = h % 100
  const rng = rngFrom(a, b, seed)                     // the picks within a kind: which words, which thing, sour or not
  let kind
  if (eligible) kind = roll < 50 ? 'item' : roll < 80 ? 'note' : roll < 90 ? 'trace' : 'haunt'
  else kind = roll < 38 ? 'empty' : roll < 77 ? 'note' : roll < 87 ? 'trace' : roll < 90 ? 'item' : 'haunt'
  if (kind === 'haunt' && levelIndex === 0) kind = 'note'
  if (bonus > 0 && (kind === 'empty' || kind === 'note') && Math.floor(h / 100) % 100 < bonus) kind = 'item'
  if (kind === 'empty') return { kind }
  if (kind === 'note') return { kind, text: DRAWER_NOTES[(rng() * DRAWER_NOTES.length) | 0] }
  if (kind === 'trace') return { kind, fallback: DRAWER_NOTES[(rng() * DRAWER_NOTES.length) | 0] }
  if (kind === 'haunt') return { kind, id: HAUNT_IDS[(rng() * HAUNT_IDS.length) | 0] }
  const pool = itemPool(levelIndex)
  const type = pool[(rng() * pool.length) | 0]
  const extra = {}
  if (type === 'almond-water' && Number.isInteger(levelIndex) && levelIndex >= 2 && rng() < 0.3) extra.sour = true
  return { kind, type, extra }
}

// applyRoll(roll, api) -> boolean: false when the drawer could not be emptied (an item with no hand free), so the key stays unsearched
// and the caller holds the roll (createSearchLog hold) to replay it at the next search.
// api = { grant(type, extra) -> { ok }, message(text, prio), sanity(delta), fire(id), behindYou(), noise?(n), trace?() }
//   trace() pins one thing on the map and names it: 'content' (a landmark, a sight, a cache, a page's chunk) before 'way' (a way
//   on), or null when there is nothing left to pin; absent or null, the trace reads as its own fallback note
let emptyN = 0
export function applyRoll(roll, api) {
  if (!roll) return false
  switch (roll.kind) {
    case 'empty': {
      const line = EMPTY_LINES[emptyN++ % EMPTY_LINES.length]
      api.message(line, PRIO.interaction)
      if (line === SQUEAL_LINE) api.noise?.(3)
      return true
    }
    case 'note':
      api.message(roll.text, PRIO.interaction)
      api.sanity(3)
      return true
    case 'trace': {
      const got = api.trace?.() ?? null
      if (typeof got === 'string' && Object.hasOwn(TRACE_LINES, got)) { api.message(TRACE_LINES[got], PRIO.interaction); return true }
      api.message(roll.fallback, PRIO.interaction)                     // nothing to pin: the plan was only paper, read as a note
      api.sanity(3)
      return true
    }
    case 'haunt':
      if (roll.id === 'behind-you') api.behindYou()
      else api.fire(roll.id)
      return true
    case 'item': {
      const r = api.grant(roll.type, roll.extra ?? {})
      if (!r || !r.ok) { api.message(HANDS_FULL_LINE, PRIO.interaction); return false }
      api.message(`in the drawer: ${FOUND_LABEL[roll.type] ?? roll.type}.`, PRIO.interaction)
      return true
    }
    default:
      return false
  }
}

// createSearchLog() -> { isSearched(key), markSearched(key), keys(), clear(), seed(keys), hold(key, roll), held(key) }: the keys opened
// on this floor. seed() takes whatever levelmem.searchedFor hands over (a Set, an array, a parsed JSON array); keys() is JSON-ready.
// hold() keeps a roll your hands were too full for, for this visit only (never saved): the next search there replays held(key)
// instead of rolling again, so a drawer that said it had something never says empty after; a completed search or clear() drops it.
export function createSearchLog() {
  const set = new Set()
  const holds = new Map()
  return {
    isSearched: (key) => set.has(String(key)),
    markSearched: (key) => { set.add(String(key)); holds.delete(String(key)) },
    keys: () => [...set],
    clear: () => { set.clear(); holds.clear() },
    seed: (keys) => { if (keys) for (const k of keys) if (k != null) set.add(String(k)) },
    hold: (key, roll) => { holds.set(String(key), roll) },
    held: (key) => holds.get(String(key)) ?? null,
  }
}
