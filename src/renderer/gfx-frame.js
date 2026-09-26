// gfx-frame.js — the per-frame state `fs` both backends (gfx-cpu.js, gfx-gl.js) hand to their stages, built in ONE place so the CPU and GPU
// paths can never disagree about the field of view, the horizon row, the comfort-clamped flicker or the timing. Pure and import-safe in Node.
//
// buildFrameState({ W, H, OW, OH, fog, fogRgb, fogMul, flicker, frame, timing, player, lights, lightsOn, hasSky, skyRgb, light, quality,
//                   opts, levelKey, look }) -> fs        (the field list is documented in gfx-cpu.js)
import { comfortFor, effectiveFlicker } from './gfx-quality.js'

export const FOV = Math.PI / 2.4
export const HF = FOV / 2

// The horizon row of a W x H internal frame: half the height, moved by the head-bob (a fraction of the frame at scale 1, so it is multiplied by
// the tier's render scale to keep the same visible bob at every resolution).
export function horizonRow(H, bobOffset, scale) { return (H / 2 + (bobOffset ?? 0) * scale) | 0 }

export function buildFrameState(o) {
  const { W, H, player, quality, timing, opts: ropts } = o
  const comfort = comfortFor(ropts)
  return {
    W, H, HH: horizonRow(H, player.bobOffset, quality.scale), OW: o.OW, OH: o.OH,
    fog: o.fog, fogRgb: o.fogRgb, fogMul: o.fogMul, flicker: effectiveFlicker(o.flicker, comfort), rawFlicker: o.flicker, comfort, frame: o.frame,
    t: timing ? timing.t : o.frame / 60, dt: timing ? timing.dt : 1 / 60,
    player, lights: o.lights, lightsOn: o.lightsOn, hasSky: o.hasSky, skyRgb: o.skyRgb,
    light: o.light, quality, opts: ropts, levelKey: o.levelKey, look: o.look, handled: { flashlight: false, glow: false },
    fov: FOV, hf: HF,
  }
}
