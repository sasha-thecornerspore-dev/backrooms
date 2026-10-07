// compose-gates.js — three decisions game.js makes once each: may the seam hold, what the beacon does, what a death is. Pure:
// no DOM, no audio, no prefs, no net; per call, so they may allocate.
//
// finaleGate: the core's gate (the claim typed, the beacon pushed, the seam not yet held) plus the file's — a column that can
// write a name where the dark can read it (rules.canHoldSeam: not the unnamed), a file still open, under litigation or the notice
// never answered (closings.js canFinale). beaconDecision: the webhook fires whenever a beacon is set; the counter-claim only
// counts toward the seam when the file can hold one (else NO_STANDING follows); the column's push line, its pin in the payload
// (the anchored's), its floor filed (the processed's). deathDecision: lying down while someone fresh is on the floor, waiting
// while down, else a death (death.js resolves it) carrying the column's consequences (rules.deathEffects) and, when nobody came,
// the timeout's cost. 'you wake where you fell in.' is never said: death.js wakes you a floor above.
import { canFinale, NO_STANDING } from './closings.js'

export const NO_BEACON_LINE = 'no beacon set. register one in settings.'
export const CLAIM_LINE = 'you fire the beacon — not a cry for help. a claim. i was here. put it in the file.'
export const LEGACY_PUSH_LINE = 'you push the beacon into the dark...'
export const NOBODY_CAME = 'nobody came.'

const CLAIM_TARGET = 'extension30150a'

export function finaleGate({ seamHeld, claimFiled, beaconFired, rules, status, closing }) {
  return !seamHeld && !!claimFiled && !!beaconFired && rules.canHoldSeam === true && canFinale(status, closing)
}

// target: the webhook lowercased, letters and digits only (game.js computes it from getPref('beaconWebhook'))
export function beaconDecision({ effect, target, rules, status, closing, anchor, webhook }) {
  const counterClaim = String(target || '').includes(CLAIM_TARGET)
  if (!effect || effect === 'off') {
    return { fire: false, counterClaim, setBeaconFired: false, filesFloor: false, lines: [NO_BEACON_LINE], payload: null }
  }
  const b = rules.beacon
  const payload = { effect, webhook }
  if (b.carriesPin && anchor) payload.anchor = anchor
  const lines = [counterClaim ? CLAIM_LINE : (b.line ?? LEGACY_PUSH_LINE)]
  let setBeaconFired = false
  if (counterClaim) {
    if (canFinale(status, closing)) setBeaconFired = true
    else lines.push(NO_STANDING)
  }
  return { fire: true, counterClaim, setBeaconFired, filesFloor: b.filesFloor === true, lines, payload }
}

// ctx: { mp, peers (fresh peers on this floor), downSt ('ok' | 'down'), rules, filed, thin, D (drift + leash debt), timeout }
// -> 'wait' | 'down' | { die: true, mintThin, leashDebt, sanity, regenDelay, line }
export function deathDecision({ mp, peers, downSt, rules, filed, thin, D, timeout }) {
  if (downSt === 'down' && !timeout) return 'wait'
  if (downSt !== 'down' && mp && peers > 0 && !timeout) return 'down'
  const fx = rules.deathEffects({ filed, thin, D })
  const line = timeout ? [NOBODY_CAME, fx.line].filter(Boolean).join(' ') : fx.line
  return {
    die: true,
    mintThin: fx.mintThin === true && filed === true,
    leashDebt: fx.leashDebt,
    sanity: timeout ? -20 : 0,
    regenDelay: timeout ? 12 : 0,
    line: line ?? null,
  }
}
