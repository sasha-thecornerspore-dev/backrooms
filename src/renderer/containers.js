// containers.js — the searchable drawers. Walk up to a cabinet, hold F for three quarters of a second, and the drawer gives up what it
// holds: most often words, sometimes nothing, sometimes a thing you can carry, rarely a door two rooms over or a figure in the corridor
// you just walked. What a drawer holds is a pure function of its key and its chunk, so a save and a reload agree; whether you have
// already opened it rides the save through createSearchLog (levelmem.searchedFor / noteSearched).
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
export const HANDS_FULL_LINE = 'there is something here, but your hands are full.'
// the deep floors charge for every completed search (game.js applies it: applyRoll does not know the level); the line is said once a level
export const DRAWER_COST = Object.freeze({ minLevel: 2, sanity: 2, line: 'something counts the drawers you open.' })
export const EMPTY_LINES = Object.freeze([
  'empty. someone has been through here.',
  'empty. the drawer sticks on the way back.',
  'nothing. a smell of warm paper.',
])
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

// rollContainer(key, cx, cy, levelIndex, seed, salt) -> { kind: 'empty' } | { kind: 'item', type, extra } | { kind: 'note', text } |
// { kind: 'haunt', id }. Eligible (the chunk's item slot): 50 item / 40 note / 10 haunt; otherwise 60 empty / 30 note / 10 haunt;
// level 0 folds the haunt share into notes. Almond water is sour 30% of the time from level 2 down.
export function rollContainer(key, cx, cy, levelIndex, seed = 0, salt = 0) {
  seed |= 0; salt |= 0
  const fk = foldKey(key)
  const eligible = isItemEligible(key, cx, cy, seed, salt)
  const a = cx + ROLL_A + salt + fk, b = cy + ROLL_B + salt
  const roll = hash(a, b, seed) % 100
  const rng = rngFrom(a, b, seed)                     // the picks within a kind: which words, which thing, sour or not
  let kind
  if (eligible) kind = roll < 50 ? 'item' : roll < 90 ? 'note' : 'haunt'
  else kind = roll < 60 ? 'empty' : roll < 90 ? 'note' : 'haunt'
  if (kind === 'haunt' && levelIndex === 0) kind = 'note'
  if (kind === 'empty') return { kind }
  if (kind === 'note') return { kind, text: DRAWER_NOTES[(rng() * DRAWER_NOTES.length) | 0] }
  if (kind === 'haunt') return { kind, id: HAUNT_IDS[(rng() * HAUNT_IDS.length) | 0] }
  const pool = itemPool(levelIndex)
  const type = pool[(rng() * pool.length) | 0]
  const extra = {}
  if (type === 'almond-water' && Number.isInteger(levelIndex) && levelIndex >= 2 && rng() < 0.3) extra.sour = true
  return { kind, type, extra }
}

// applyRoll(roll, api) -> boolean: false when the drawer could not be emptied (an item with no hand free), so the key stays unsearched.
// api = { grant(type, extra) -> { ok }, message(text, prio), sanity(delta), fire(id), behindYou() }
let emptyN = 0
export function applyRoll(roll, api) {
  if (!roll) return false
  switch (roll.kind) {
    case 'empty':
      api.message(EMPTY_LINES[emptyN++ % EMPTY_LINES.length], PRIO.interaction)
      return true
    case 'note':
      api.message(roll.text, PRIO.interaction)
      api.sanity(3)
      return true
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

// createSearchLog() -> { isSearched(key), markSearched(key), keys(), clear(), seed(keys) }: the keys opened on this floor. seed() takes
// whatever levelmem.searchedFor hands over (a Set, an array, a parsed JSON array); keys() is JSON-ready.
export function createSearchLog() {
  const set = new Set()
  return {
    isSearched: (key) => set.has(String(key)),
    markSearched: (key) => { set.add(String(key)) },
    keys: () => [...set],
    clear: () => { set.clear() },
    seed: (keys) => { if (keys) for (const k of keys) if (k != null) set.add(String(k)) },
  }
}
