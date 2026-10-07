// origin-unnamed.js — the file cannot spell you.
//
// You came without a name the dark can read (blank, or 'wanderer'). The things cannot keep a lookup on you (a short memory),
// a page and a friend steady you more, sweet water less; the film develops a letter that is not yours and the radio does not
// say whose the last group was, so you can hold no seam and develop no claim. Say 'call me …' or 'my name is …' to the
// presence and confirm the spelling, and the file re-files you: a tenant, or anchored with a pin — never processed
// (processed is checked first at intake, so the facts that left you unnamed cannot make you processed).
import { isBlankName } from './origin-intake.js'
import { LEGACY, LEGACY_EFFECT, LOSE_TRACK_REF, fileBase } from './origin-rules.js'
import { FIRST_LINE, AGAIN_LINE } from './origin-thin.js'

export const MEMORY_S = 0.75
export const SCRAP_SANITY = 9
export const SWEET_WATER = 20
export const FRIEND_BASE = 4

export const NAME_RE = /^(?:call me|my name is)\s+([a-z0-9][a-z0-9 _-]{0,20})\s*$/i
export const ONLINE_LINE = 'the room will know you next time.'
export const GLYPH_LINE = 'the film develops a letter. it is not one of yours. you have none.'
export const LAST_GROUP_LINE = 'it reads the last group, then stops. it did not say whose.'

// the name in a naming wish, case kept, or null ('i am …' stays an ordinary wish; so does a name the file still cannot spell)
export function parseNameWish(text) {
  if (typeof text !== 'string') return null
  const m = NAME_RE.exec(text.trim())
  if (!m) return null
  const name = m[1].trim()
  return isBlankName(name) ? null : name
}

export function spellCard(name) {
  return { text: `${name}. is that how it is spelled?`, foot: 'e · yes      esc · no' }
}

// a NEW intake ctx with the name written in (the caller files it again: intake() -> rulesFor())
export function refileWithName(intakeCtx, name) {
  return { ...intakeCtx, name }
}

export function spelledLine(name, origin) {
  return `${String(name).toLowerCase()}. spelled. ` +
    (origin === 'anchored' ? 'the file has your body at a pin.' : 'the file has you at an address now.')
}

const percept = { sightMul: 1, hidden: false, loseTrackMul: 1, noiseMul: 1 }
const radio = { heartbeat: 'none', followUp: null }

export const UNNAMED = Object.freeze({
  id: 'unnamed',
  lightTerm: (flashlight, litNear) => (flashlight ? 2 : litNear ? 1 : -2),   // unlit in a friend's light, the dark eats slower
  perception: (ctx) => {
    percept.sightMul = 1
    percept.loseTrackMul = MEMORY_S / LOSE_TRACK_REF   // the file cannot keep a lookup on you
    percept.noiseMul = 1
    return fileBase(percept, ctx)
  },
  damageMul: 1,
  wardRecoil: false,
  exitGrab: 1.6,
  wayReveal: 'seen',
  scrapSanity: SCRAP_SANITY,
  sweetWater: SWEET_WATER,
  sourWater: () => null,
  itemEffect: () => LEGACY_EFFECT,
  friendBase: () => FRIEND_BASE,
  giverMul: () => 1,
  npcLine: () => null,
  presenceReply: () => null,
  wishMeta: () => ({ origin: 'unnamed' }),
  eventWeights: () => LEGACY.eventWeights(),
  polaroid: (ctx) => (ctx && ctx.glyph != null ? { cap: GLYPH_LINE, advance: false } : null),
  canDevelopClaim: false,
  radio: (ctx) => { radio.followUp = ctx?.last ? LAST_GROUP_LINE : null; return radio },
  canHoldSeam: false,
  beacon: Object.freeze({ carriesPin: false, filesFloor: false, line: null }),
  deathEffects: (ctx) => ({ mintThin: true, leashDebt: 0, line: ctx?.thin ? AGAIN_LINE : FIRST_LINE }),
  leash: false,
  crosserPause: () => null,
})
