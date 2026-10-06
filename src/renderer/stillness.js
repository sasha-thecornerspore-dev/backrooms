// stillness.js — how long you have stood still, and how long since you made a sound ('if the lights go out, stop moving. it hunts
// movement.'). Pure, no imports, on the PLAY clock in seconds (it feeds perception every frame and must freeze with the loop).
//
// It only keeps the numbers. Whether the things can see you is not decided here: W2's rule blocks turn stillFor / noiseFor / the light /
// the radio into aiCtx.hidden (hidden after STILL_HIDDEN_S still and silent, light and radio off; thin's STILL_THIN_S in its place;
// never for an unfiled player), and hunt.js reads aiCtx.hidden. A noise you make — your ward, your whistle, a sprint step — resets
// both clocks: a thing that hears you has you, however still you stand. A friend's ward and the lures never call noise().
export const STILL_THIN_S = 0.6
export const STILL_HIDDEN_S = 2
export const HUNTS_MOVEMENT_LINE = 'it hunts movement. you remember that now.'

const defaultNow = () => (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000

export function createStillness({ now = defaultNow } = {}) {
  let stillSince = now(), lastNoise = -Infinity, lit = false, radio = false

  // the per-frame report (right after `player.moving = moved`)
  function note({ moving, flashlight, radioOn, t = now() }) {
    if (moving) stillSince = t
    lit = !!flashlight
    radio = !!radioOn
  }

  function noise(t = now()) { lastNoise = t; stillSince = t }

  function stillFor(t = now()) { return t - stillSince }
  function noiseFor(t = now()) { return t - lastNoise }

  function reset() { stillSince = now(); lastNoise = -Infinity; lit = false; radio = false }

  return { note, noise, stillFor, noiseFor, reset, get lit() { return lit }, get radio() { return radio } }
}
