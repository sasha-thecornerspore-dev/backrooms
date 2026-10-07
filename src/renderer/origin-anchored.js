// origin-anchored.js — the file has your body at a pin.
//
// You came with a real place. The body stays there; the further you drift from where you came in, the harder it pulls: past
// LEASH_FREE_M a point of sanity a second per LEASH_PER_M (a pin caption on the film calms it for CALM_S). D is always the
// drift from this floor's spawn plus the leash debt a death leaves (game.js driftD()); the debt pays itself off at a metre a
// second. A friend standing on the same pin steadies you more. The pin leaves the machine only through the player's OWN
// custom beacon webhook.
import { formatAnchor, anchorSeed } from './anchor.js'
import { isValidPin } from './origin-intake.js'
import { LEGACY, LEGACY_EFFECT, fileBase } from './origin-rules.js'
import { FIRST_LINE, AGAIN_LINE } from './origin-thin.js'

export const LEASH_FREE_M = 200
export const LEASH_PER_M = 400
export const CALM_S = 60
export const DEBT_DECAY_M_PER_S = 1
export const FRIEND_SAME_PIN = 5

export const MERCY_LINE = 'the floor moved under the pin. for a moment you are close. it will not stay.'
export const DEATH_LINE = 'the body is pulling you back. it is not there yet.'
export const BEACON_LINE = 'you push the beacon into the dark. it carries the pin.'
const WISH_LINE = 'your request is noted against an address. the address is real. that is the problem.'

// sanity per second the pin takes back
export function leashDrain(D, calm) {
  return calm > 0 ? 0 : Math.max(0, (D - LEASH_FREE_M) / LEASH_PER_M)
}

export function leashDebtStep(debt, dt) {
  return Math.max(0, debt - dt * DEBT_DECAY_M_PER_S)
}

export function pinCaption(anchor, D, glyph) {
  return `the film shows ${formatAnchor(anchor)}. it is ${D} m behind you and it has not moved.` +
    (glyph ? ` one letter developed beside it: "${glyph}".` : '')
}

// the same ~11 m cell anchor.js seeds the maze from (the room's seed still wins: 'same pin', never 'same maze')
export function isSamePin(a, b) {
  return isValidPin(a) && isValidPin(b) && anchorSeed(a.lat, a.lng) === anchorSeed(b.lat, b.lng)
}

const percept = { sightMul: 1, hidden: false, loseTrackMul: 1, noiseMul: 1 }

export const ANCHORED = Object.freeze({
  id: 'anchored',
  lightTerm: (flashlight, litNear) => (flashlight ? 2 : litNear ? 1 : -2),   // unlit in a friend's light, the dark eats slower
  perception: (ctx) => {
    percept.sightMul = 1
    percept.loseTrackMul = 1
    percept.noiseMul = 1
    return fileBase(percept, ctx)
  },
  damageMul: 1,
  wardRecoil: false,
  exitGrab: 1.6,
  wayReveal: 'seen',
  scrapSanity: 6,
  sweetWater: 35,
  sourWater: () => null,
  itemEffect: () => LEGACY_EFFECT,
  friendBase: (ctx) => (ctx?.rp?.aseed != null && ctx.rp.aseed === ctx.selfAseed ? FRIEND_SAME_PIN : 3),
  giverMul: () => 1,
  npcLine: () => null,
  presenceReply: (kind) => (kind === 'wish' ? WISH_LINE : null),
  wishMeta: () => ({ origin: 'anchored' }),
  eventWeights: () => LEGACY.eventWeights(),
  polaroid: (ctx) => {
    const c = ctx || {}
    if (!isValidPin(c.anchor) || !(c.D > LEASH_FREE_M || c.firstShotOfLevel)) return null
    return { cap: pinCaption(c.anchor, c.D, c.glyph), advance: c.glyph != null, leashCalm: CALM_S }
  },
  canDevelopClaim: true,
  radio: (ctx) => LEGACY.radio(ctx),
  canHoldSeam: true,
  beacon: Object.freeze({ carriesPin: true, filesFloor: false, line: BEACON_LINE }),
  deathEffects: (ctx) => ({ mintThin: true, leashDebt: ctx?.D > 0 ? ctx.D : 0, line: DEATH_LINE + ' ' + (ctx?.thin ? AGAIN_LINE : FIRST_LINE) }),
  leash: true,
  crosserPause: () => null,
})
