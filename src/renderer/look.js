// look.js — vertical look: the view's pitch, drawn as a y-shear of the raycaster's frame (the classic trick: the horizon row moves up or
// down and every pass draws around it; nothing in the world tilts, so walls stay upright and the maze stays a maze).
//
// The pitch is a FRACTION OF THE VIEW HEIGHT: +0.2 looks up (the horizon sits a fifth of the frame lower), -0.2 looks down. In the
// renderer's projection a wall one unit tall at distance one fills the frame, so the vertical focal length is the frame height and the
// pitch is the tangent of the look angle: a mouse pixel that turns the view 0.002 rad (the yaw, at 100%) tilts it 0.002 too, the same feel.
// gfx-frame.js turns it into rows (horizonRow + pitchRows) for both backends.
//
// The state lives ON THE PLAYER, beside the angle it pairs with, the way touch.js already turns player.angle directly:
//   player.pitch    what the renderer draws this frame (gfx-frame.js reads it, nothing else does: it never goes on the wire, the save, the
//                   map, the things' perception or the polaroid's frame, which all stay horizontal)
//   player.pitchIn  the vertical input gathered since the last frame, already scaled by its rate and the sensitivity (the mouse handler and
//                   the touch look-drag add to it; lookStep spends it)
//
//   lookInput(p, dy, perPx, sens)   dy screen px (+ = down: the mouse pulled toward you, a finger dragged down), at perPx pitch per px and
//                                   the mouseSensitivity pref (%), added to p.pitchIn. NaN / 0 / Infinity add nothing.
//   lookMouse(p, e, locked, sens)   one mousemove (game.js's handler is this one call): e.movementX turns p.angle at MOUSE_YAW, the yaw the
//                                   game always had, and e.movementY is gathered at MOUSE_PITCH (lookInput), both at the sensitivity; with
//                                   the pointer not locked to the view the mouse does nothing at all.
//   lookStep(p, dt, on, invert, held) -> p.pitch    once a frame, before the render: spends p.pitchIn and clamps to ±PITCH_MAX.
//                   on false (the pref off)  the view is level at once, exactly as it was before vertical look (pitch 0, input dropped)
//                   held true (lying down, a fall between floors, a death's fade)  the input is dropped and the view eases back to level
//                                                   (LEVEL_TAU, frame-rate independent), landing on exactly 0 (LEVEL_SNAP): no residue
//                   otherwise  1:1 with the input (no smoothing lag, like the yaw), held where it is left: no drift, no auto-centre
//   lookLevel(p)    a level view at once, the input dropped: game.js sets you down level under the veil (an arrival, a wake)
// Pure, import-safe in Node, and allocation-free (number fields written in place). The touch drag gathers its tilt through lookInput too,
// with its own rate and touch.js's tiltWeight: a turning swipe's drift tilts nothing.

export const PITCH_MAX = 0.32        // ±, of the view height: about a third each way, short of where the shear starts to read as stretched
export const MOUSE_YAW = 0.002       // rad per mouse px at 100%: the yaw (lookMouse)
export const MOUSE_PITCH = 0.002     // per mouse px at 100%: the yaw's rate, the same feel both ways
export const TOUCH_PITCH = 0.004     // per drag px at 100%: a little under the drag's yaw (0.0055, touch.js lookYaw); and only the part of
                                     // a drag that is mostly up and down tilts at all (touch.js tiltWeight: a turning swipe's drift does not)
export const LEVEL_TAU = 0.22        // s: the ease back to level while the view is held
export const LEVEL_SNAP = 0.0002     // below this the ease lands on exactly 0 (under half a row even at 2160 internal rows: no jump)

export function lookInput(p, dy, perPx, sens) {
  if (!(dy > 0 || dy < 0) || !Number.isFinite(dy)) return
  const s = sens > 0 && Number.isFinite(sens) ? sens / 100 : 1
  p.pitchIn = (p.pitchIn || 0) + dy * perPx * s
}

export function lookMouse(p, e, locked, sens) {
  if (!locked) return
  p.angle += e.movementX * MOUSE_YAW * (sens / 100)
  lookInput(p, e.movementY, MOUSE_PITCH, sens)
}

export function lookStep(p, dt, on, invert, held) {
  const inp = p.pitchIn || 0
  p.pitchIn = 0
  let v = p.pitch || 0
  if (!on) v = 0
  else if (held) {
    v *= Math.exp(-(dt > 0 ? dt : 0) / LEVEL_TAU)
    if (v < LEVEL_SNAP && v > -LEVEL_SNAP) v = 0
  } else {
    v += invert ? inp : -inp                           // the mouse pulled toward you looks down; inverted, it looks up
    if (v > PITCH_MAX) v = PITCH_MAX; else if (v < -PITCH_MAX) v = -PITCH_MAX
    if (v !== v) v = 0                                  // (a NaN never reaches the frame)
  }
  p.pitch = v
  return v
}

export function lookLevel(p) { p.pitch = 0; p.pitchIn = 0 }
