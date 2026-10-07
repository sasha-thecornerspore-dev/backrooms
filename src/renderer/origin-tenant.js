// origin-tenant.js — the file has you at an address.
//
// A solo player with a name and no pin. The street does not mind you (no light drain on the block or the lobby), the deep
// frays you faster; below the first floor the file has forwarded your address (the things see and hear you further). Your map
// marks every loaded way, your hands find a way from further off, and more figures cross the far halls. On Level ∅ the sealed
// doors talk to you — the system's claim about an address, never a resident (they read the FIXED map only: materialAt).
import { NULL_MAP } from './level-null-map.js'
import { EVENTS } from './events.js'
import { LEGACY, LEGACY_EFFECT, fileBase } from './origin-rules.js'
import { FIRST_LINE, AGAIN_LINE } from './origin-thin.js'

export const EXIT_GRAB = 2.4
export const DOOR_SANITY = 3

export const DOOR_LINES = Object.freeze([
  'the file has you at 806. you have never been here. the file does not have a column for that.',
  'notice 30150A. status: EXTENSION. the file says this is your door. the door is grey block.',
  'the number is sprayed in orange on the plywood. the file says it is yours. it is not, and it is.',
  'behind the board is a photograph of a window. the file has you living behind a photograph.',
  'graded hazardous in 1937. the file has had your address since before you were born.',
  'the notice has been extended twenty-one years. your tenancy is one of the extensions.',
  'a light is on next door. nobody comes out. they are not in the file either.',
])

export function isSealedMaterial(m) { return m === 'C' || m === 'P' }

// the block's 28 sealed doors (CMU and plywood), row-major: [ix, iy, material]
export const SEALED_CELLS = (() => {
  const out = []
  for (let iy = 0; iy < NULL_MAP.length; iy++) for (let ix = 0; ix < NULL_MAP[iy].length; ix++) {
    const m = NULL_MAP[iy][ix]
    if (isSealedMaterial(m)) out.push(Object.freeze([ix, iy, m]))
  }
  return Object.freeze(out)
})()

export function sealedCellIndex(ix, iy) {
  for (let i = 0; i < SEALED_CELLS.length; i++) if (SEALED_CELLS[i][0] === ix && SEALED_CELLS[i][1] === iy) return i
  return -1
}

export function doorLine(ix, iy) {
  const i = sealedCellIndex(ix, iy)
  return i < 0 ? null : DOOR_LINES[i % DOOR_LINES.length]
}

// the cell an arm's length ahead of you
export function facingCell(player, dist = 1.2) {
  return { ix: Math.floor(player.x + Math.cos(player.angle) * dist), iy: Math.floor(player.y + Math.sin(player.angle) * dist) }
}

// the scheduler's catalogue with the crosser twice as likely; every other entry as it was
export const TENANT_EVENTS = Object.freeze(EVENTS.map((e) => Object.freeze(e.id === 'crosser' ? { ...e, weight: 6 } : { ...e })))

const WISH_LINE = 'logged as a complaint from a resident. complaints are not requests, but they are kept.'
const percept = { sightMul: 1, hidden: false, loseTrackMul: 1, noiseMul: 1 }

export const TENANT = Object.freeze({
  id: 'tenant',
  lightTerm: (flashlight, litNear, depth) => (flashlight ? 2 : litNear ? 1 : (depth <= 1 ? 0 : -3)),
  perception: (ctx) => {
    const deep = (ctx?.depth ?? 0) >= 2   // the file forwarded your address
    percept.sightMul = deep ? 1.3 : 1
    percept.loseTrackMul = 1
    percept.noiseMul = deep ? 1.5 : 1
    return fileBase(percept, ctx)
  },
  damageMul: 1,
  wardRecoil: false,
  exitGrab: EXIT_GRAB,
  wayReveal: 'loaded',
  scrapSanity: 6,
  sweetWater: 35,
  sourWater: () => null,
  itemEffect: () => LEGACY_EFFECT,
  friendBase: () => 3,
  giverMul: () => 1,
  npcLine: () => null,
  presenceReply: (kind) => (kind === 'wish' ? WISH_LINE : null),
  wishMeta: () => ({ origin: 'tenant' }),
  eventWeights: () => TENANT_EVENTS,
  polaroid: () => null,
  canDevelopClaim: true,
  radio: (ctx) => LEGACY.radio(ctx),
  canHoldSeam: true,
  beacon: Object.freeze({ carriesPin: false, filesFloor: false, line: null }),
  deathEffects: (ctx) => ({ mintThin: true, leashDebt: 0, line: ctx?.thin ? AGAIN_LINE : FIRST_LINE }),
  leash: false,
  crosserPause: () => null,
})
