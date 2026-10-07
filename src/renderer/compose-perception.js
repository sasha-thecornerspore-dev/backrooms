// compose-perception.js — the file's reading of you, as the things perceive it. Pure: no DOM, no audio, no prefs, no net.
//
// game.js's one aiCtx carries four trailing fields the hunt path reads (hunt.js rangeFor / sees / perceive / hearing / the
// hunt's loseTrack, variants.js's watcher and crawler; every read is `ctx.x ?? default`, so an 11-key ctx is today's game):
//   sightMul      x the creature's effective sight range, after the dark halving and the beam
//   hidden        the things cannot SEE you this frame (the line itself is still read; contact is distance, unchanged)
//   loseTrackMul  x spec.loseTrack: how long a hunter keeps coming after it loses the line
//   noiseMul      x what a creature hears of YOUR noises (a lure's and a friend's are never scaled)
// The numbers are the rule blocks' (origin-rules.js and the origin blocks: rules.perception(ctx)); LEGACY is { 1, false, 1, 1 }
// always. perceptionFor is the one seam game.js calls per frame: it copies the block's object (each block reuses its own; copy,
// never retain) into ONE reused object here, and the caller copies the four values onto aiCtx.

export const AI_CTX_KEYS = Object.freeze(['flashlight', 'sprinting', 'dark', 'fog', 'radioOn', 'lures', 't', 'hf', 'playerAngle', 'player', 'damage',
  'sightMul', 'hidden', 'loseTrackMul', 'noiseMul'])

export const AI_CTX_DEFAULTS = Object.freeze({ sightMul: 1, hidden: false, loseTrackMul: 1, noiseMul: 1 })

const out = { sightMul: 1, hidden: false, loseTrackMul: 1, noiseMul: 1 }

// ctx = { rules, depth, stillFor, noiseFor, flashlight, radioOn, litNear } -> the one reused { sightMul, hidden, loseTrackMul, noiseMul }
export function perceptionFor(ctx) {
  const p = ctx.rules.perception(ctx)
  out.sightMul = p.sightMul
  out.hidden = p.hidden === true          // hunt.js hides only on `true`: the copy says what the things will do
  out.loseTrackMul = p.loseTrackMul
  out.noiseMul = p.noiseMul
  return out
}
