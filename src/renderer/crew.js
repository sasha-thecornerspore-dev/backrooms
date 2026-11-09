// crew.js — the crew, in words: who is in the room (/who), a friend re-filed under a new word, a friend who came in from your square.
//
// Pure: no DOM, no clock, no net. Everything here is read off what the room already says — the players list (names) and each friend's
// 'here' heartbeat as the event bus believed it (src/net/evbus.js: lvl 0..4, status, aseed — their pin's neighbourhood mark, anchor.js
// pinTag). Nothing new is sent between players, and nothing here is a number: a floor by its name, a file by its word.
//
// Level ∅ (lvl 4) stays as it is: a friend there has no floor in /who, the watch says nothing about anyone on it, nor to you while you
// stand on it (game.js gates the console's /who there too).
//
//   whoLines(peers, self) -> the /who lines: you first, then each friend; solo (or everyone gone), one line that says so
//   refileLine(name, word) -> '— name re-filed under <word>.' (as the chat draws a people line: '— ' + name + ' ' + refileText(word));
//     a word is said as every voice says it: 'notice mailed', never the file's own key
//   squareMatch(a, b) -> two pinned players share a square (tags or records with .aseed; 0 is the room's own square, and it counts)
//   createCrewWatch() -> { heard(ev, ctx) }: the people lines one friend's heartbeat earns (evbus.js onPeerFile)
import { LEVELS } from './levels.js'
import { STATUSES } from './status.js'
import { floorWord } from './terminal.js'
import { NAME_CAP_EXEMPT } from './caches.js'

// VOICE REVIEW: every line below is new in v2.0.7 and waits for the owner's voice pass. Lowercase, no '!', no digits, no coordinates,
// tags or seeds; a name is spliced in as it was typed. REFILE and SQUARE are people lines: the chat draws them as '— name ' + the line
export const CREW = Object.freeze({
  WHO_SOLO: 'no one is here but you.',
  WHO_SELF: 'you',                                          // the name on your own row
  WHO_ROW: '{name} · {floor} · filed under {word}.',
  WHO_ROW_NO_FLOOR: '{name} · filed under {word}.',         // a friend on the block: no floor, ever
  WHO_ROW_UNPLACED: '{name} · the file has not placed them.', // no fresh heartbeat (an older copy, or gone quiet): no floor, no word
  REFILE: 're-filed under {word}.',
  SQUARE: 'came in from your square.',
  PHOTO_WORD: ' filed under {word}.',                       // compose-polaroid.js: after the subject's line, before the letter
})

// the four procedural floors by name, as the field terminal says them ('level 2 — pipe dreams' -> 'pipe dreams'); the block is none
export const CREW_FLOORS = Object.freeze(LEVELS.filter((l) => Number.isInteger(l.id)).map((l) => floorWord(l.name)))
const BLOCK = 4                                              // level.index of ∅ (evbus.js: a peer on ∅ arrives as lvl 4)
const WORD_SET = new Set(STATUSES)

// a template's {slots}; a value is spliced verbatim (a function replacer: no `$` pattern in a name is read)
const fill = (tpl, vars) => tpl.replace(/\{(\w+)\}/g, (m, k) => (vars[k] != null ? String(vars[k]) : m))

// the word a file is under, as every voice says it ('notice mailed', as the form and the file's own row say it: origin-intake.js F7), or
// null for anything the file has no such word for
export function fileWord(status) { return WORD_SET.has(status) ? status.replace('-', ' ') : null }
// a floor by its name: null on the block and for anything that is not one of the four
export function floorName(lvl) { return Number.isInteger(lvl) && lvl >= 0 && lvl < CREW_FLOORS.length ? CREW_FLOORS[lvl] : null }

const known = (r) => r != null && Number.isInteger(r.lvl) && r.lvl >= 0 && r.lvl <= BLOCK && fileWord(r.status) !== null
function whoRow(name, r) {
  if (!known(r)) return fill(CREW.WHO_ROW_UNPLACED, { name })
  const floor = floorName(r.lvl), word = fileWord(r.status)
  return floor ? fill(CREW.WHO_ROW, { name, floor, word }) : fill(CREW.WHO_ROW_NO_FLOOR, { name, word })
}

// peers: [{ id, name, lvl, status }] — lvl / status null (or absent) when the bus has no fresh heartbeat for them; self: { id, lvl, status }
// or null. Your own id never lists twice. -> the lines, in the order given
export function whoLines(peers, self = null) {
  const list = []
  for (const p of peers || []) if (p && !(self && self.id != null && p.id === self.id)) list.push(p)
  if (!list.length) return [CREW.WHO_SOLO]
  const rows = []
  if (self) rows.push(whoRow(CREW.WHO_SELF, self))
  for (const p of list) rows.push(whoRow(typeof p.name === 'string' && p.name ? p.name : 'someone', p))
  return rows
}

// the chat's body for a re-filing ('re-filed under litigation.'), and the line as the chat draws it
export function refileText(word) { return fill(CREW.REFILE, { word: fileWord(word) ?? word }) }
export function refileLine(name, word) { return '— ' + name + ' ' + refileText(word) }
export function squareLine(name) { return '— ' + name + ' ' + CREW.SQUARE }
// the photo's word (compose-polaroid.js), or '' for a file the film has no word for
export function photoWord(status) { const w = fileWord(status); return w ? fill(CREW.PHOTO_WORD, { word: w }) : '' }

// two pinned players share a square: the same neighbourhood's mark in this room (anchor.js pinTag — 16 bits of the cell's seed, salted by
// the room's world seed, so equal marks are equal cells, near enough). A mark of 0 is the room's own square (the room was drawn from it),
// and it counts like any other. Either side without a pin (null, or anything that is not a mark) never matches. The photo's SUBJECT_PIN
// reads this same rule, so the square line never says more than the film already does
const tagOf = (v) => (v !== null && typeof v === 'object' ? v.aseed : v)
export function squareMatch(a, b) {
  const x = tagOf(a), y = tagOf(b)
  return Number.isInteger(x) && Number.isInteger(y) && x === y
}

// One friend's heartbeat, as the bus heard it (evbus.js onPeerFile: { id, name, lvl, status, aseed, first, from } — from is the word the
// last heartbeat said, null on the first) -> the people lines it earns, each said once:
//   • a re-filing: the word changed since their last heartbeat (never on the first: that is not a change, it is news to you)
//   • the square: the first heartbeat of a friend whose pin's square is yours — once per friend a session (by name: a friend who comes
//     back under a new id is not news again; by id for the blank name many share, caches.js NAME_CAP_EXEMPT: two of them are two people)
// Nothing about a friend on the block, nothing to you while you stand on it, nothing about yourself.
// ctx: { selfId, selfTag (your pin's mark in this room, or null), onBlock (you are on ∅) }
const NONE = Object.freeze([])
export function createCrewWatch() {
  const squared = new Set()
  return {
    heard(ev, { selfId = null, selfTag = null, onBlock = false } = {}) {
      if (!ev || typeof ev.id !== 'string' || ev.id === selfId) return NONE
      if (onBlock || ev.lvl === BLOCK) return NONE
      if (ev.first) {
        if (!squareMatch(ev.aseed, selfTag)) return NONE
        const key = typeof ev.name === 'string' && ev.name && !NAME_CAP_EXEMPT.includes(ev.name) ? 'n:' + ev.name : 'i:' + ev.id
        if (squared.has(key)) return NONE
        squared.add(key)
        return [CREW.SQUARE]
      }
      const w = fileWord(ev.status)
      if (w === null || fileWord(ev.from) === null || ev.from === ev.status) return NONE
      return [refileText(w)]
    },
  }
}
