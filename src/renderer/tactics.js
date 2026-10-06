// tactics.js — the quiet verbs: set the radio down and walk away, drink the
// sweet water and go soft-footed, hold still and wrap the wound.
//
// Pure math only. The polaroid blind is entities.flash; the lure is read by the
// hunt through getLures; the commit is driven by game.js each frame. A dropped
// glowstick is a breadcrumb sprite with no light and no creature effect
// (gfx-light has no point-emitter API), so nothing here knows about it.
export const QUIET_SECONDS = 20     // sweet almond water: footsteps at half loudness
export const RADIO_BATTERY = 180    // a radio set down talking runs this long
export const GLOW_TTL      = 240    // a dropped glowstick gutters out after this

const lures = []                    // reused: computeLures hands back the same array every call

// The 2 nearest dropped radios that are on and still have battery, nearest first.
// `dropped` is the items Map (or any iterable of records { x, y, type, on, onUntil }).
export function computeLures(dropped, t, px, py) {
  lures.length = 0
  let a = null, ad = Infinity, b = null, bd = Infinity
  const list = dropped && typeof dropped.values === 'function' && !Array.isArray(dropped) ? dropped.values() : dropped
  if (list) for (const it of list) {
    if (it.type !== 'radio' || !it.on || !(t < it.onUntil)) continue
    const d = (it.x - px) ** 2 + (it.y - py) ** 2
    if (d < ad) { b = a; bd = ad; a = it; ad = d }
    else if (d < bd) { b = it; bd = d }
  }
  if (a) lures.push(a)
  if (b) lures.push(b)
  return lures
}

export function lureWithin(lures, px, py, r) {
  const r2 = r * r
  for (let i = 0; i < lures.length; i++) {
    const l = lures[i]
    if ((l.x - px) ** 2 + (l.y - py) ** 2 <= r2) return true
  }
  return false
}

// Footstep loudness multiplier while the quiet timer runs.
export function quiet(timer) { return timer > 0 ? 0.5 : 1 }

// A committed action: start() it, tick() it each frame; 'done' lands once at the
// end, cancel() drops it where it stands (the bandage stays in your hand).
export function createCommit(duration) {
  let active = false, t = 0
  function start() { active = true; t = 0 }
  function cancel() { active = false; t = 0 }
  function tick(dt) {
    if (!active) return 'idle'
    t += dt
    if (t >= duration) { active = false; t = 0; return 'done' }
    return 'running'
  }
  return { tick, cancel, start, get active() { return active } }
}
