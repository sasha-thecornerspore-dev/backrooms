// feelings.js — how a floor feels, this time. On some solo arrivals on one of the four procedural floors the floor carries one feeling
// for that visit and says so once: the lights are out (the panels dark, far fewer lamps, a darker dark between them, so your own light
// matters), a designed quiet (the hum a little lower, the floor's events and murmurs further apart), or signs that someone came through
// first (drawers already searched, chairs moved). Each line is true of what you then see and hear; nothing else about the floor moves:
// the maze, the spawn denominators, the items, the creatures and every number the file keeps are the floor's own.
//
// Pure, and import-light: a function of the world seed, the floor and the visit (levelmem's count, this arrival included), on its own
// channels.js constants (CHANNELS.feelings: gate = whether, pick = which, rng = the passer's hand), so a replay of the same arrivals feels
// the same, and no placement stream is touched. game.js asks once per buildLevel, at the cfg stage, and keeps the record on the level.
//
//   rawFeeling(seed, level, visit) -> id | null          the visit's roll, before any rule
//   feelingFor({ seed, level, visit, room, thread, on }) -> record (NO_FEELING when none)
//       never on the block or off the four floors, never in a multiplayer room (which feeling a room rolls would need a wire field: an
//       owner decision), never on the lobby's first visit of a run nor while the first run's thread can still advance there, never with
//       the kill switch off (world.json `feelings: false`, carried by levelConfig), and never the same feeling on two consecutive visits
//       to one floor (a roll equal to the previous visit's roll is let go). About one arrival in three feels.
//   applyFeeling(cfg, record) -> the SAME cfg            the dark's overlay at the cfg stage, on FEEL_PATHS only (docket.js's pattern):
//       cfg.lights = false (the panels go out; gfx-light.js then lights the floor by its sparse lamps), cfg.look.lighting merged with
//       the floor's dark recipe, and the floor's murmurs that say its lights are on left out of the visit's draw (FEELINGS.dark.mute).
//       Nothing else is ever written: not the maze, a denominator, the items, the fog distance or the flicker.
//   handOf(key, record, salt) -> 0..1                    the passer's hand over one prop key, for this visit
//   markPassage(props, record, log) -> count             on a visit someone came through first, as each chunk comes in: the drawers the
//       hand picks are marked searched in this visit's log (never levelmem's: the floor does not remember a stranger's search), and the
//       chairs it picks are turned in place, the way the chairs-moved haunt turns them (dress.js / gfx-sprites.js: rot picks the chair)
import { CHANNELS } from './channels.js'
import { CONTAINER_TYPES, foldKey } from './containers.js'

const [GATE_A, GATE_B] = CHANNELS.feelings.gate
const [PICK_A, PICK_B] = CHANNELS.feelings.pick
const [HAND_MX, HAND_AX, HAND_MY, HAND_AY] = CHANNELS.feelings.rng

// decor.js's hash, verbatim (the roll and the hand are asked outside any decor pass)
function hash(a, b, c = 0) {
  let h = (a * 2654435761 ^ b * 2246822519 ^ Math.imul(c, 3266489917)) >>> 0
  h ^= h >>> 16; h = Math.imul(h, 0x45d9f3b) >>> 0
  h ^= h >>> 16
  return h >>> 0
}

const F = Object.freeze

// the roll and the timing (S7 turns these, never game.js)
export const FEEL = F({
  // a visit's roll, in a hundred: the repeat rule lets about one in eight of those go, so about one arrival in three feels
  chance: 38,
  // the line, after the floor's plate, on a floor you come back to and on a resume: the arrival's second plate, ahead of the 3.8 s summary
  // (let go then, as it is whenever the window is full)
  aheadMs: 3600,
  // the line on a first visit and on a wake: after every line the arrival says of its own (the hint and the filing 3.8 s, the way you came
  // 7.5 s, the hint after the filing 7.6 s; the wake's 2.6 / 5.2 / 7.8 s), so it only takes a plate they leave free, else it is let go
  afterMs: 8400,
  // the hum's glide into the quiet, and home again on the next floor
  humS: 3,
})

// the dark: the lights out, through the light model's own recipe (gfx-light.js LEVEL_LIGHTING, merged under cfg.look.lighting). On the
// lobby and the habitable zone the panels go out (cfg.lights false) and lamps far apart are all that burn; on the pipes and the station a
// third of their own lamps still burn (`every` three times theirs: a lamp cell's hash is 0 mod `every`, gfx-light.js lampCandidate, so a
// lamp still lit stands where one of theirs stood, never somewhere new). The dark between the lamps is darker, and so is the fog in it.
// Readable without your light: the ambient on the floor's own wall colour is never below nine tenths of the pipes' own visibility floor
// (level 2's ambient on level 2's walls; test/feelings.test.js), so walls still read their shapes
const DARK_LIGHT = F({
  0: F({ ambient: 0.24, peak: 1.3, radius: 3.6, every: 12, ceilAmbient: 0.12, fogBase: 0.28 }),
  1: F({ ambient: 0.27, peak: 1.25, radius: 3.6, every: 12, ceilAmbient: 0.12, fogBase: 0.28 }),
  2: F({ ambient: 0.35, every: 24, ceilAmbient: 0.13, fogBase: 0.26 }),
  3: F({ ambient: 0.5, every: 27, ceilAmbient: 0.2, fogBase: 0.26 }),
})

export const FEELINGS = F({
  // (the murmurs that would say otherwise while the lights are out: the lobby's and the habitable zone's own, quoted whole)
  dark: F({ id: 'dark', line: 'the lights are out here.', light: DARK_LIGHT,
    mute: F(['the lights do not turn off.', 'one of the lights is a different white.', 'the lights buzz, then stop, then buzz.']) }),
  // the hum's level (its pitch is the soft clock's to drop), and the floor's events and murmurs about half as often
  quiet: F({ id: 'quiet', line: 'it is very quiet.', hum: 0.6, events: 2, murmurs: 2 }),
  // about two drawers in five already searched; about three chairs in five turned where they stand
  passage: F({ id: 'passage', line: 'someone came through here before you.', drawers: 0.4, chairs: 0.6, chairTurn: 1 }),
})
// the pick's order: append only (an id's place is its roll)
export const FEELING_IDS = F(['dark', 'quiet', 'passage'])
// the only cfg paths applyFeeling may write
export const FEEL_PATHS = F(['lights', 'look.lighting', 'messages'])

// the record game.js keeps on the level: the line, and the multipliers the loop reads (1 on every visit that does not feel)
const record = (id, level, visit, seed) => {
  const f = id ? FEELINGS[id] : null
  return F({ id: id ?? null, line: f ? f.line : null, events: f?.events ?? 1, murmurs: f?.murmurs ?? 1, hum: f?.hum ?? 1, level, visit, seed })
}
// no feeling: no line, every multiplier 1 (game.js reads it as today exactly)
export const NO_FEELING = record(null, null, 0, 0)

const isFloor = (level) => Number.isInteger(level) && level >= 0 && level <= 3

export function rawFeeling(seed, level, visit) {
  if (!isFloor(level) || !Number.isInteger(visit) || visit < 1) return null
  const s = seed | 0
  if (hash(level + GATE_A, visit + GATE_B, s) % 100 >= FEEL.chance) return null
  return FEELING_IDS[hash(level + PICK_A, visit + PICK_B, s) % FEELING_IDS.length]
}

export function feelingFor({ seed = 0, level, visit, room = false, thread = false, on = true } = {}) {
  if (on === false || room) return NO_FEELING
  if (!isFloor(level) || !Number.isInteger(visit) || visit < 1) return NO_FEELING
  if (level === 0 && (visit === 1 || thread)) return NO_FEELING
  const id = rawFeeling(seed, level, visit)
  if (!id || id === rawFeeling(seed, level, visit - 1)) return NO_FEELING
  return record(id, level, visit, seed | 0)
}

export function applyFeeling(cfg, feel) {
  if (!cfg || !feel || feel.id !== 'dark' || cfg.map) return cfg
  const over = FEELINGS.dark.light[cfg.levelIndex]
  if (!over) return cfg
  cfg.lights = false
  const look = cfg.look ?? {}
  cfg.look = { ...look, lighting: { ...(look.lighting ?? {}), ...over } }
  const mute = FEELINGS.dark.mute
  if (Array.isArray(cfg.messages) && cfg.messages.some((m) => mute.includes(m))) cfg.messages = cfg.messages.filter((m) => !mute.includes(m))
  return cfg
}

export function handOf(key, feel, salt = 0) {
  return hash(foldKey(key) + HAND_AX + (salt | 0) * HAND_MX, (feel?.visit | 0) * HAND_MY + HAND_AY + (feel?.level | 0), feel?.seed | 0) % 1000 / 1000
}

const SALT_DRAWER = 0, SALT_CHAIR = 1

export function markPassage(props, feel, log) {
  if (!feel || feel.id !== 'passage' || !props) return 0
  const P = FEELINGS.passage
  let n = 0
  for (let i = 0; i < props.length; i++) {
    const p = props[i]
    if (CONTAINER_TYPES[p.type] !== undefined) {
      if (log && handOf(p.key, feel, SALT_DRAWER) < P.drawers) { log.markSearched(p.key); n++ }
    } else if (p.type === 'chair' && handOf(p.key, feel, SALT_CHAIR) < P.chairs) {
      p.rot = (p.rot || 0) + P.chairTurn; n++
    }
  }
  return n
}
