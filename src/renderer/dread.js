// dread.js — what you hear before you see it. A creature near you through the maze raises a dread that tension.js turns into a slow
// heartbeat, and now and then its own sound reaches you from where it is: its tell. Distance is path distance (pathfield.js), so a
// thing behind a wall weighs nothing and is never heard. Nothing hunting you counts (the hunt has its own heart), nor anything still
// arriving or reeling.
//
// Pure: no DOM, no audio. game.js runs it on a 4 Hz timer, builds the field at most twice a second while dreadNear holds, and plays
// what the teller hands back through audio.call.
//
// DREAD_R                                  the reach, in path cells
// DREAD_W, TELL                            each kind's weight, each kind's sound (audio.call names)
// dreadFrom(entities, field, player, out) -> out
//   out = { dread 0..1, x, y, variant, d, los }: the sum over everything that counts within DREAD_R, and the nearest of it
//   (d -1 and variant null when nothing counts). field null (none built) is no dread. Reused: read it, do not keep it
// dreadNear(entities, player) -> boolean   something that could count stands within DREAD_R in a straight line: the build's gate
// createTeller({ rng }) -> { tick(dt, dreadOut, player, rangeMul = 1) -> slot | null, reset() }
//   slot = { sound, gain, pan, variant }, one reused record: play it now, do not keep it
import { inViewCone } from './raycaster.js'
import { HF } from './gfx-frame.js'

export const DREAD_R = 24
export const DREAD_W = Object.freeze({ shade: 0.4, smiler: 0.5, hound: 0.6, lurker: 0.6, watcher: 0.4, crawler: 0.3, tesla: 0.5 })
export const TELL = Object.freeze({ shade: 'thump', smiler: 'click', hound: 'pant', lurker: 'drip', watcher: 'hush', crawler: 'rasp', tesla: 'buzz' })
// hunt.js HUNTING, copied (dread.test.js pins it): importing hunt.js would bring the creature machine and the sprites into a timer
export const HUNTING = new Set(['hunt', 'freeze', 'windup', 'lunge', 'recover', 'arcCharge'])

const FALL = 6                    // a creature this many cells off weighs half
const LINE = DREAD_R + 1.5        // the straight-line gate: path cells are whole, you and it stand anywhere in yours
const LINE2 = LINE * LINE
const TELL_NEAR = 7               // nearer than this it is not a sound in the walls, it is there
const TELL_GAP_S = 3.5
const TELL_BASE = 0.12, TELL_K = 0.4
const SCRAPE = 0.2                // a chair moves somewhere instead
const PAN = 0.85

// still arriving, reeling (hunt.deriveState's stagger) or on your heels: none of these is dread
function counts(e) {
  return !(e.pending > 0) && !(e.stagger > 0) && e.ai !== 'stagger' && !HUNTING.has(e.ai)
}

export function dreadNear(entities, player) {
  for (let i = 0; i < entities.length; i++) {
    const e = entities[i]
    if (!counts(e)) continue
    const dx = e.x - player.x, dy = e.y - player.y
    if (dx * dx + dy * dy <= LINE2) return true
  }
  return false
}

export function dreadFrom(entities, field, player, out) {
  let sum = 0
  out.variant = null; out.d = -1; out.los = false
  if (field && entities) {
    for (let i = 0; i < entities.length; i++) {
      const e = entities[i]
      if (!counts(e)) continue
      const dx = e.x - player.x, dy = e.y - player.y
      if (dx * dx + dy * dy > LINE2) continue           // no path through the maze is shorter than the line
      const d = field.dist(Math.floor(e.x), Math.floor(e.y))
      if (d < 0 || d > DREAD_R) continue                // -1: behind walls, or past the window
      const v = e.variant ?? 'shade'                    // variants.specFor reads a creature with no kind as a shade
      sum += (DREAD_W[v] ?? DREAD_W.shade) / (1 + d / FALL)
      if (out.d < 0 || d < out.d) { out.x = e.x; out.y = e.y; out.variant = v; out.d = d; out.los = e.los === true }
    }
  }
  out.dread = sum < 1 ? sum : 1
  return out
}

// The nearest contributor, out of sight (not on your screen: hunt's budgeted line and the sprite cull, as variants.watched reads it),
// between TELL_NEAR and the reach: by chance, at least TELL_GAP_S apart. rangeMul scales the reach, and the gain falls from 0.75
// beside you to 0.25 at it.
export function createTeller({ rng = Math.random } = {}) {
  const slot = { sound: '', gain: 0, pan: 0, variant: '' }
  let since = Infinity

  function tick(dt, o, player, rangeMul = 1) {
    since += dt
    if (!o || o.d < 0 || since < TELL_GAP_S) return null
    const R = DREAD_R * rangeMul
    if (o.d < TELL_NEAR || o.d > R) return null
    if (o.los && inViewCone(player.x, player.y, player.angle, o.x, o.y, HF, R)) return null
    if (rng() >= (TELL_BASE + TELL_K * o.dread) * dt) return null
    since = 0
    slot.variant = o.variant
    slot.sound = rng() < SCRAPE ? 'scrape' : (TELL[o.variant] ?? TELL.shade)
    slot.gain = 0.25 + 0.5 * (1 - o.d / R)
    const s = Math.sin(Math.atan2(o.y - player.y, o.x - player.x) - player.angle)
    slot.pan = (s < -1 ? -1 : s > 1 ? 1 : s) * PAN
    return slot
  }

  function reset() { since = Infinity }

  return { tick, reset }
}
