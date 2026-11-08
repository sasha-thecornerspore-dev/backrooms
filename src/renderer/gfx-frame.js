// gfx-frame.js — the per-frame state `fs` both backends (gfx-cpu.js, gfx-gl.js) hand to their stages, built in ONE place so the CPU and GPU
// paths can never disagree about the field of view, the horizon row, the comfort-clamped flicker or the timing. Pure and import-safe in Node.
//
// buildFrameState({ W, H, OW, OH, fog, fogRgb, fogMul, flicker, frame, timing, player, lights, lightsOn, hasSky, skyRgb, light, quality,
//                   opts, levelKey, look }) -> fs        (the field list is documented in gfx-cpu.js)
//
// VERTICAL LOOK is a y-shear (look.js): player.pitch, a fraction of the frame height, moves the horizon row and nothing else. So the frame
// carries two rows:
//   HC  the CENTRE row: half the height plus the head-bob — where the view axis meets the screen. The floor / ceiling casting's span (the
//       camera's height above the floor, in rows: H - HC below, HC above), the flashlight's beam (held in the hand: it points where you look)
//       and the sky's gradient (anchored to the elevation, not to the top of the screen) are measured from it.
//   HH  the HORIZON row: HC plus the pitch, in whole rows. Everything placed in the world is drawn around it: the walls' slices, the floor /
//       ceiling rows' distances, the sprites' floor line, the sky's elevation.
// With the pitch at 0 (vertical look off, a level view, a hand-built fs without HC) HH === HC and every pass draws what it drew before.
//   tilt = (HH - HC) / H, the pitch actually drawn (0 when level): the light model's flashlight on the floor and the dust field read it.
import { comfortFor, effectiveFlicker } from './gfx-quality.js'

export const FOV = Math.PI / 2.4
export const HF = FOV / 2
export const PITCH_LIMIT = 0.4       // the renderer's own bound on player.pitch (look.js keeps the game inside ±PITCH_MAX, under it)

// The centre row of a W x H internal frame: half the height, moved by the head-bob (a fraction of the frame at scale 1, so it is multiplied by
// the tier's render scale to keep the same visible bob at every resolution).
export function horizonRow(H, bobOffset, scale) { return (H / 2 + (bobOffset ?? 0) * scale) | 0 }

// The pitch in whole rows of an H-row frame (+ = looking up: the horizon moves down). 0, undefined and NaN are a level view.
export function pitchRows(H, pitch) {
  if (!(pitch > 0 || pitch < 0)) return 0
  const p = pitch > PITCH_LIMIT ? PITCH_LIMIT : pitch < -PITCH_LIMIT ? -PITCH_LIMIT : pitch
  return Math.round(p * H)
}

export function buildFrameState(o) {
  const { W, H, player, quality, timing, opts: ropts } = o
  const comfort = comfortFor(ropts)
  const HC = horizonRow(H, player.bobOffset, quality.scale), pr = pitchRows(H, player.pitch)
  // a pitched horizon stays inside the frame (the game's bound keeps it well inside; a tiny frame might not)
  const HH = pr === 0 ? HC : Math.max(0, Math.min(H - 1, HC + pr))
  return {
    W, H, HH, HC, tilt: (HH - HC) / H, OW: o.OW, OH: o.OH,
    fog: o.fog, fogRgb: o.fogRgb, fogMul: o.fogMul, flicker: effectiveFlicker(o.flicker, comfort), rawFlicker: o.flicker, comfort, frame: o.frame,
    t: timing ? timing.t : o.frame / 60, dt: timing ? timing.dt : 1 / 60,
    player, lights: o.lights, lightsOn: o.lightsOn, hasSky: o.hasSky, skyRgb: o.skyRgb,
    light: o.light, quality, opts: ropts, levelKey: o.levelKey, look: o.look, handled: { flashlight: false, glow: false },
    fov: FOV, hf: HF,
  }
}
