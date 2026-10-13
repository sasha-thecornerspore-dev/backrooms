// origin-thin.js — not all of you arrived.
//
// Thin is a layer, not a column: you drop into a room that already had someone live in it, or you come back up from the dark
// (die() mints it for any filed player). The things lose you faster and hear you less, but the light goes through you, the
// green crack of a glowstick is not for you, and a ward pushes you back as well as them. Ballast cures it for good.
// rulesFor() lays the keys marked LAYER over the origin's block; the rest of THIN's keys are the legacy values, for a block
// that is complete on its own (every block has the same key set).
import { EVENTS } from './events.js'
import { LEGACY, LEGACY_EFFECT, LOSE_TRACK_REF, LIT_SIGHT_MUL } from './origin-rules.js'

export const STILL_S = 0.6          // still and silent this long: hidden, whatever the light
export const MEMORY_S = 1.5         // seconds a hunter keeps after you, against the shade's 3.5
export const DAMAGE_MUL = 0.7
export const RECOIL_DIST = 1.7      // the ward's shove back along your own facing
export const RECOIL_SHAKE = 0.7
export const NOISE_MUL = 0.5
export const RADIO_CARRY = 0.5      // a hidden thin player with the radio on: seen at half
export const GLOW_SANITY = -4

export const RECOIL_LINE = 'it recoils from you. so do you.'
export const FIRST_SHOT_LINE = 'the film shows the hall. at the edge of the frame it shows the wall through your hand.'
export const FIRST_LINE = 'not all of you came back up.'
export const AGAIN_LINE = 'still thin.'
export const CURE_LINE = 'you are as here as anyone.'
export const GLOW_LINE = 'the green light goes through you. the crack it opens is not for you.'
export const CROSSER = Object.freeze({ pause: 1.2, sanity: 4, line: 'someone else who dropped in. they wave. you can see the wall through them too.' })

export function thinHidden(stillFor, noiseFor) {
  return Math.min(stillFor ?? 0, noiseFor ?? Infinity) >= STILL_S
}

// a thin remote steadies others only while it stands still (W4 applies it with the REMOTE's thin flag)
export function thinGiverMul(stillFor) { return stillFor >= STILL_S ? 1 : 0 }

const percept = { sightMul: 1, hidden: false, loseTrackMul: 1, noiseMul: 1 }
const LEGACY_BEACON = Object.freeze({ carriesPin: false, filesFloor: false, line: null })

export const THIN = Object.freeze({
  id: 'thin',
  lightTerm: (flashlight, litNear) => (flashlight ? -2 : (litNear ? 0 : 2)),                    // LAYER
  perception: (ctx) => {                                                                          // LAYER
    const c = ctx || {}
    let hidden = thinHidden(c.stillFor, c.noiseFor)
    let sightMul = 1
    if (hidden && c.radioOn) { hidden = false; sightMul = RADIO_CARRY }   // the radio half-carries
    if (c.litNear && !c.flashlight) sightMul *= LIT_SIGHT_MUL
    percept.sightMul = sightMul
    percept.hidden = hidden
    percept.loseTrackMul = MEMORY_S / LOSE_TRACK_REF
    percept.noiseMul = NOISE_MUL
    return percept
  },
  damageMul: DAMAGE_MUL,                                                                          // LAYER
  wardRecoil: true,                                                                               // LAYER
  exitGrab: 1.6,
  wayReveal: 'seen',
  scrapSanity: 6,
  sweetWater: 35,
  sourWater: () => null,
  itemEffect: (eff, index) => {                                                                   // LAYER (the glowstick)
    if (!eff || eff.type !== 'glowstick') return LEGACY_EFFECT
    return { fog: Math.max(18, 45 - Math.min(index || 0, 3) * 6), calm: 8, blip: true, sanity: GLOW_SANITY, line: GLOW_LINE }
  },
  friendBase: () => 3,
  giverMul: thinGiverMul,                                                                         // LAYER
  npcLine: () => null,
  presenceReply: () => null,
  wishMeta: () => ({ origin: null }),
  eventWeights: () => EVENTS,
  polaroid: (ctx) => (ctx && ctx.thinFirstShot ? { cap: FIRST_SHOT_LINE, advance: false } : null),  // LAYER (the first shot)
  canDevelopClaim: true,
  radio: (ctx) => LEGACY.radio(ctx),
  canHoldSeam: true,
  beacon: LEGACY_BEACON,
  deathEffects: () => ({ mintThin: false, leashDebt: 0, line: null }),
  leash: false,
  crosserPause: () => CROSSER,                                                                    // LAYER
})
