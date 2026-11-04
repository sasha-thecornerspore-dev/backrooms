// radiostatic.js — the radio as a fuzzy warning (M21). Pure: no DOM, no audio, no prefs, no net; nothing allocates after create.
//
// Your radio, on, hisses under its tune, and the hiss rises with the dread you already feel (dread.js dreadFrom over the path field):
// a thing near you along the halls lifts it, and a thing behind a wall counts only for the long way round to it, however close it
// stands (nothing, when that is past dread's reach). The level is one number for both ears, read off a sum that never asks the
// bearing, so it says something is near and never where. A hunt holds it where it was (dread counts nothing hunting you, and the hiss must not fall away as the thing
// comes on; the hunt has its own heart). The radio off, the creatures off, a fade or the block: no hiss, the radio as it always was.
// The price is the file's, not this module's: with the radio on you are never hidden (origin-rules.js fileBase, origin-thin.js,
// and compose-perception.js perceptionFor holds the seam to it).
//
// STATIC                          max   the hiss at its loudest (audio.js caps it at PEAK_CAP)
//                                 full  the dread that reaches max (dread is clamped at 1)
//                                 curve under 1, so a thing at the edge of dread's reach is already heard
//                                 rise / fall / cut  the glide's time constants in s: coming up, dying away, the radio or the
//                                 creatures switched off
// staticLevel(dread) -> 0..max    monotone in dread; 0 for no dread (or anything that is not a positive number)
// createRadioStatic() -> { tick(dread, hunted, radioOn, live) -> { gain, tc }, reset() }
//   dread    dreadOut.dread, 0..1           hunted   the threat record's hunted
//   radioOn  your radio, carried and on     live     creatures live, no fade, not the block
//   one reused record: hand it to audio.setRadioStatic(gain, tc) now, keep nothing
export const STATIC = Object.freeze({ max: 0.05, full: 0.6, curve: 0.7, rise: 0.4, fall: 0.9, cut: 0.05 })

export function staticLevel(dread) {
  if (!(dread > 0)) return 0
  if (dread >= STATIC.full) return STATIC.max
  return STATIC.max * Math.pow(dread / STATIC.full, STATIC.curve)
}

export function createRadioStatic() {
  const res = { gain: 0, tc: STATIC.cut }
  let held = 0

  function tick(dread, hunted, radioOn, live) {
    if (radioOn !== true || live !== true) { held = 0; res.gain = 0; res.tc = STATIC.cut; return res }
    const lv = staticLevel(dread)
    let g = lv
    if (hunted === true) { if (lv > held) held = lv; g = held }
    else held = lv
    res.tc = g >= res.gain ? STATIC.rise : STATIC.fall
    res.gain = g
    return res
  }

  function reset() { held = 0; res.gain = 0; res.tc = STATIC.cut }

  return { tick, reset }
}
