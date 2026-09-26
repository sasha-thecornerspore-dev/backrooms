// events.js — Living Atmosphere.
//
// A pure, frame-driven scheduler for the maze's occasional ambient dread events:
// the lights guttering out down a corridor, a far door slamming, a figure that
// crosses an intersection and is gone, the hum cutting to dead silence. It only
// DECIDES what fires and when; game.js owns the side effects (audio/flicker/a
// transient apparition), so this file stays pure and unit-testable with an
// injected rng. It consumes runtime randomness like the existing message/flicker
// timers — no chunk-hash placement, no save state, no golden-test surface.

// The event catalogue. `minLevel` gates by depth; `weight` biases the roll.
// (Level ∅ — the authored outdoor block — is excluded by the caller, not here.)
export const EVENTS = [
  { id: 'lights-cascade', weight: 3, minLevel: 0 },   // panels gutter out ahead, then return
  { id: 'door-slam',      weight: 4, minLevel: 0 },   // somewhere, a door slams shut
  { id: 'hum-stops',      weight: 2, minLevel: 0 },   // the hum cuts to silence, then resumes
  { id: 'cold-spot',      weight: 3, minLevel: 0 },   // a chill; breath fogs where there is no cold
  { id: 'footsteps',      weight: 3, minLevel: 1 },   // footfalls that keep pace, then stop
  { id: 'crosser',        weight: 3, minLevel: 1 },   // a figure crosses the hall far off
]

// Seconds between event *attempts*, scaled by tension: deeper floors and lower
// sanity pull events closer together. Returns a [min,max] window. Pure.
export function eventInterval(level, sanity) {
  const lvl = (typeof level === 'number' && level > 0) ? level : 0
  const depth = Math.min(3, lvl) / 3                                  // 0..1
  const dread = 1 - Math.max(0, Math.min(100, sanity ?? 100)) / 100   // 0 calm .. 1 frayed
  const tension = Math.min(1, depth * 0.6 + dread * 0.6)              // 0..1
  const base = 80 - tension * 45                                      // ~80s calm → ~35s tense
  return [base * 0.6, base * 1.4]
}

// Create a scheduler. `rng` is injectable for tests (defaults to Math.random).
// The tension-scaled interval (min ~21s) always dominates any fixed cooldown, so
// there is no separate cooldown — the interval IS the gap between events.
export function createEventScheduler({ rng = Math.random, events = EVENTS } = {}) {
  let timer = 0
  let next = pickWindow(0, 100)   // first event after a calm interval, whatever the floor

  function pickWindow(level, sanity) {
    const [a, b] = eventInterval(level, sanity)
    return a + rng() * (b - a)
  }

  // Weighted roll over the events eligible at this depth. null if none.
  function pick(level) {
    const pool = events.filter((e) => (level ?? 0) >= (e.minLevel ?? 0))
    const total = pool.reduce((s, e) => s + e.weight, 0)
    if (total <= 0) return null
    let r = rng() * total
    for (const e of pool) { r -= e.weight; if (r <= 0) return e.id }
    return pool[pool.length - 1].id
  }

  return {
    // Advance by dt seconds. Returns an event id to fire this frame, or null.
    // ctx: { level, sanity, canFire } — canFire gates on modal/transition states,
    // and while it is false the timer does not advance (no banked burst on unpause).
    tick(dt, ctx = {}) {
      if (!ctx.canFire) return null
      timer += dt
      if (timer < next) return null
      timer = 0
      next = pickWindow(ctx.level, ctx.sanity)
      return pick(ctx.level)
    },
    _pick: pick,   // exposed for tests
  }
}
