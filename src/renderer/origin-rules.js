// origin-rules.js — the rule blocks, composed.
//
// Every place game.js reads a number or a line the file could change, it reads `rules.<key>`. LEGACY is the post-core
// game.js itself (the values below are the quoted code's: light `flashlight ? 2 : -2`, the 1.6 grab, +6 a page, +35 sweet
// water, +3 a friend, 'that one was yours.'), so an unfiled player — Level ∅, the lobby before the first way — is
// byte-identical to the game before the file existed. rulesFor(origin, thin) hands out one frozen block per pair, cached,
// so `rules === LEGACY` is an identity test.
//
// THE SHARED BASE: every filed player stands under two perception rules on top of their column's numbers — two seconds still
// and silent with the light and the radio off and the things cannot see you (they hunt movement); unlit in a friend's light
// their sight of you drops to LIT_SIGHT_MUL. The four origin blocks carry it in their perception() (fileBase below); the thin
// layer keeps its own 0.6 s rule and the same light factor; LEGACY never has it.
//
// The blocks import this module and this module imports the blocks. Safe both ways round because neither touches the
// other's bindings at load: the blocks read LEGACY_EFFECT / LEGACY_LAST_LINE / fileBase only inside their functions, and
// rulesFor reads the blocks only when called. Keep it that way (no top-level use across the cycle).
import { EVENTS } from './events.js'
import { ORIGINS } from './origin-intake.js'
import { TENANT } from './origin-tenant.js'
import { ANCHORED } from './origin-anchored.js'
import { PROCESSED } from './origin-processed.js'
import { UNNAMED } from './origin-unnamed.js'
import { THIN } from './origin-thin.js'

export const RULE_KEYS = Object.freeze(['lightTerm', 'perception', 'damageMul', 'wardRecoil', 'exitGrab', 'wayReveal', 'scrapSanity',
  'sweetWater', 'sourWater', 'itemEffect', 'friendBase', 'giverMul', 'npcLine', 'presenceReply', 'wishMeta', 'eventWeights',
  'polaroid', 'canDevelopClaim', 'radio', 'canHoldSeam', 'beacon', 'deathEffects', 'leash', 'crosserPause'])

export const LOSE_TRACK_REF = 3.5    // the shade's spec.loseTrack (variants.js): a block's memory in seconds / this = loseTrackMul
export const STILL_HIDDEN_S = 2      // still and silent this long, light and radio off: hidden (stillness.js keeps the same number)
export const LIT_SIGHT_MUL = 0.45    // unlit, standing in a friend's light

// itemEffect's "do what the game always did": one frozen sentinel, so the hot path allocates nothing and reads `r.legacy`
export const LEGACY_EFFECT = Object.freeze({ legacy: true })
export const LEGACY_LAST_LINE = 'it reads the last group, then stops. that one was yours.'

// after the column's own numbers: the stillness rule and the friend's-light factor (mutates and returns the block's object)
export function fileBase(o, ctx) {
  const c = ctx || {}
  const flashlight = !!c.flashlight
  o.hidden = Math.min(c.stillFor ?? 0, c.noiseFor ?? Infinity) >= STILL_HIDDEN_S && !flashlight && !c.radioOn
  if (c.litNear && !flashlight) o.sightMul *= LIT_SIGHT_MUL
  return o
}

const LEGACY_PERCEPT = Object.freeze({ sightMul: 1, hidden: false, loseTrackMul: 1, noiseMul: 1 })
const legacyRadio = { heartbeat: 'last', followUp: null }
const LEGACY_BEACON = Object.freeze({ carriesPin: false, filesFloor: false, line: null })

export const LEGACY = Object.freeze({
  id: null,
  lightTerm: (flashlight) => (flashlight ? 2 : -2),
  perception: () => LEGACY_PERCEPT,
  damageMul: 1,
  wardRecoil: false,
  exitGrab: 1.6,
  wayReveal: 'seen',
  scrapSanity: 6,
  sweetWater: 35,
  sourWater: () => null,
  itemEffect: () => LEGACY_EFFECT,
  friendBase: () => 3,
  giverMul: () => 1,
  npcLine: () => null,
  presenceReply: () => null,
  wishMeta: () => ({ origin: null }),
  eventWeights: () => EVENTS,
  polaroid: () => null,
  canDevelopClaim: true,
  radio: (ctx) => { legacyRadio.followUp = ctx?.last ? LEGACY_LAST_LINE : null; return legacyRadio },
  canHoldSeam: true,
  beacon: LEGACY_BEACON,
  deathEffects: () => ({ mintThin: false, leashDebt: 0, line: null }),
  leash: false,
  crosserPause: () => null,
})

const cache = new Map()

function blockOf(origin) {
  return origin === 'tenant' ? TENANT : origin === 'anchored' ? ANCHORED : origin === 'processed' ? PROCESSED : UNNAMED
}

// thin over a column: the layer's light, perception, damage, recoil, glowstick, first shot, crosser and giver; the rest the column's
function layerThin(o, id) {
  return Object.freeze({
    ...o,
    id,
    lightTerm: THIN.lightTerm,
    perception: THIN.perception,
    damageMul: THIN.damageMul,
    wardRecoil: THIN.wardRecoil,
    itemEffect: (eff, index) => { const r = THIN.itemEffect(eff, index); return r === LEGACY_EFFECT ? o.itemEffect(eff, index) : r },
    polaroid: (ctx) => (ctx && ctx.thinFirstShot ? THIN.polaroid(ctx) : o.polaroid(ctx)),
    crosserPause: THIN.crosserPause,
    giverMul: THIN.giverMul,
  })
}

// An unfiled player is never thin: rulesFor(null, anything) === LEGACY.
export function rulesFor(origin, thin) {
  if (!ORIGINS.includes(origin)) return LEGACY
  const id = thin === true ? origin + '+thin' : origin
  let r = cache.get(id)
  if (!r) { r = thin === true ? layerThin(blockOf(origin), id) : blockOf(origin); cache.set(id, r) }
  return r
}
