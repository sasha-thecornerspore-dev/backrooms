// origin-processed.js — the file opened a line on you.
//
// You walked into a shared room and opened it: the file stamped your column before you asked. Below the first floor the ledger
// has your location; the radio reads every group to you, and once, the key (subtract the drift, then a=1..z=26), never the
// plaintext. A page steadies you less, the souls see the stamp, sour water is only a ledger line, a beacon files the floor
// (a filed floor never restocks: game.js vendedFor(index, -Infinity) on a floorKey in filedFloors), a wish is an amendment.
// Vocabulary: processed strings say what the file DID. Only the slip carries the record's own words (W3's slipText reads it).
import { LEGACY, LEGACY_EFFECT, LEGACY_LAST_LINE, fileBase } from './origin-rules.js'
import { FIRST_LINE, AGAIN_LINE } from './origin-thin.js'

export const SCRAP_SANITY = 3

export const SLIP_LINE = 'notice 30150A. status: EXTENSION. issued 2004-11-08. extended. extended. extended. the file has a column for how many times. it does not have a column for why.'
export const RADIO_KEY_LINE = 'it reads three behind. it always reads three behind.'
export const OPENED_LINE = 'the file opened a line on you. it stamped your column before you asked.'
export const RELEASE_LINE = 'your body is still at the pin. the file no longer needs it.'
export const BEACON_LINE = 'you push the beacon into the dark. the floor files the push.'
export const WISH_REPLY = 'amendment received. the file will be corrected, or it will not.'
export const SOUR = Object.freeze({ sanity: 0, slam: false, whisper: false, flicker: false, line: 'the water is sour. a line moves in a ledger. it is your line. it moved years ago.' })
export const NPC_REFUSAL = Object.freeze({ text: 'you are one of them. i can see the stamp.', sanity: -2 })

// the key of a filed floor: the world seed the way it is keyed everywhere (| 0), and the level index
export function floorKey(worldSeed, levelIndex) {
  return `${worldSeed | 0}:${levelIndex}`
}

// a claim ('i was here') re-files the litigant as processed; an anchored body is released first
export function claimRefile(origin) {
  return { origin: 'processed', lines: origin === 'anchored' ? [RELEASE_LINE, OPENED_LINE] : [OPENED_LINE] }
}

const percept = { sightMul: 1, hidden: false, loseTrackMul: 1, noiseMul: 1 }
const radio = { heartbeat: 'every', followUp: null }

export const PROCESSED = Object.freeze({
  id: 'processed',
  lightTerm: (flashlight) => (flashlight ? 2 : -2),
  perception: (ctx) => {
    percept.sightMul = (ctx?.depth ?? 0) >= 2 ? 1.25 : 1   // the ledger has your location
    percept.loseTrackMul = 1
    percept.noiseMul = 1
    return fileBase(percept, ctx)
  },
  damageMul: 1,
  wardRecoil: false,
  exitGrab: 1.6,
  wayReveal: 'seen',
  scrapSanity: SCRAP_SANITY,
  sweetWater: 35,
  sourWater: () => SOUR,
  itemEffect: () => LEGACY_EFFECT,
  friendBase: () => 3,
  giverMul: () => 1,
  npcLine: () => NPC_REFUSAL,
  presenceReply: (kind) => (kind === 'wish' ? WISH_REPLY : null),
  wishMeta: () => ({ origin: 'processed' }),
  eventWeights: () => LEGACY.eventWeights(),
  polaroid: () => null,
  canDevelopClaim: true,
  radio: (ctx) => {
    radio.followUp = ctx?.firstDeepHearing ? RADIO_KEY_LINE : (ctx?.last ? LEGACY_LAST_LINE : null)
    return radio
  },
  canHoldSeam: true,
  beacon: Object.freeze({ carriesPin: false, filesFloor: true, line: BEACON_LINE }),
  deathEffects: (ctx) => ({ mintThin: true, leashDebt: 0, line: ctx?.thin ? AGAIN_LINE : FIRST_LINE }),
  leash: false,
  crosserPause: () => null,
})
