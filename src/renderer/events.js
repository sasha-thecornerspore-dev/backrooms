// events.js — Living Atmosphere.
//
// A pure, frame-driven scheduler for the maze's occasional ambient dread events:
// the lights guttering out down a corridor, a far door slamming, a figure that
// crosses an intersection and is gone, the hum cutting to dead silence. It only
// DECIDES what fires and when; game.js owns the side effects (audio/flicker/a
// transient apparition), so this file stays pure and unit-testable with an
// injected rng. It consumes runtime randomness like the existing message/flicker
// timers — no chunk-hash placement, no save state, no golden-test surface.

// The event catalogue. `minLevel` and `maxLevel` (absent: no ceiling) gate by depth; `weight` biases the roll.
// (Level ∅ — the authored outdoor block — is excluded by the caller, not here.)
// The first six are wired by hand in game.js fireEvent. The rest carry their effect as data, `fx`:
// { line, sound (an audio.js call() id), count, gap (s between repeats), pan (0..1, the caller picks the side), flick (a
// flicker target, 0 for none) }, played by fireEvent's one generic branch. events.test.js checks that every id has one or the
// other, so new content cannot land as an id with no effect at all.
export const EVENTS = [
  { id: 'lights-cascade', weight: 3, minLevel: 0 },   // panels gutter out ahead, then return
  { id: 'door-slam',      weight: 4, minLevel: 0 },   // somewhere, a door slams shut
  { id: 'hum-stops',      weight: 2, minLevel: 0 },   // the hum cuts to silence, then resumes
  { id: 'cold-spot',      weight: 3, minLevel: 0 },   // a chill; breath fogs where there is no cold
  { id: 'footsteps',      weight: 3, minLevel: 1 },   // footfalls that keep pace, then stop
  { id: 'crosser',        weight: 3, minLevel: 1 },   // a figure crosses the hall far off
  // a bell trill twice, a few rooms over (ring is a bell, not a dial tone)
  { id: 'phone-rings',    weight: 2, minLevel: 0, maxLevel: 1,
    fx: { line: 'a phone is ringing a few rooms over. it stops before you find it.', sound: 'ring', count: 2, gap: 4, pan: 0.8, flick: 0 } },
  { id: 'chair-scrape',   weight: 2, minLevel: 0, maxLevel: 1,
    fx: { line: 'in the next room, someone pushes a chair back from a desk.', sound: 'scrape', count: 1, gap: 0, pan: 0.6, flick: 0 } },
  { id: 'pipe-knock',     weight: 2, minLevel: 2, maxLevel: 2,
    fx: { line: 'something knocks along the pipe toward you. then away.', sound: 'thump', count: 4, gap: 0.5, pan: 0.7, flick: 0 } },
  // a thud and a dip in the light, then it settles
  { id: 'breaker-trip',   weight: 2, minLevel: 3, maxLevel: 3,
    fx: { line: 'a breaker trips somewhere. the dark leans closer, then settles.', sound: 'thump', count: 1, gap: 0, pan: 0, flick: 0.3 } },
]

// eventFx(id, events = EVENTS) -> fx | null: a data event's effect, for fireEvent's generic branch (the hand-wired six have none)
export function eventFx(id, events = EVENTS) {
  for (let i = 0; i < events.length; i++) if (events[i].id === id) return events[i].fx ?? null
  return null
}

// the arrival event: on arriving at a floor, more often than not the next event comes early, and it is heard, not read
export const ARRIVAL = Object.freeze({ p: 0.55, min: 16, max: 60 })

// the footsteps event keeps your pace for real: your next `steps` steps are each echoed `delay` s behind, until `still` s without one
export const FOOTSTEPS_ECHO = Object.freeze({ steps: 8, delay: 0.14, still: 0.8 })

// A shuffle bag over `items`, never handing out the same item twice running, a refill included (when only that item is left
// in the bag, the rest is dropped and the bag refilled: a lone item is the one case that must repeat). swap(items) changes
// what goes in at the next refill and empties the bag, keeping the last item so the swap cannot repeat it either.
// Allocation-free once the bag has grown to size.
function shuffleBag(items, rng) {
  const bag = []
  let last
  function refill() {
    bag.length = 0
    for (let i = 0; i < items.length; i++) bag.push(items[i])
    for (let i = bag.length - 1; i > 0; i--) {
      const j = Math.min(i, (rng() * (i + 1)) | 0)
      const t = bag[i]; bag[i] = bag[j]; bag[j] = t
    }
  }
  // the index of the nearest entry under the top that differs from `last`, or -1
  function other() {
    for (let j = bag.length - 1; j >= 0; j--) if (bag[j] !== last) return j
    return -1
  }
  return {
    next() {
      if (!items.length) return undefined
      if (!bag.length) refill()
      let j = other()
      if (j < 0) { refill(); j = other(); if (j < 0) j = bag.length - 1 }
      const top = bag.length - 1, t = bag[top]; bag[top] = bag[j]; bag[j] = t
      last = bag.pop()
      return last
    },
    swap(next) { items = next; bag.length = 0 },
  }
}

// createBag(n, rng) -> { next() -> index }: the murmurs' draw, each of n lines once per refill and never the same line twice
// running; -1 when there are no lines
export function createBag(n, rng = Math.random) {
  const idx = []
  for (let i = 0; i < n; i++) idx.push(i)
  const bag = shuffleBag(idx, rng)
  return { next: () => (n > 0 ? bag.next() : -1) }
}

// Seconds between event *attempts*, scaled by tension: deeper floors and lower
// sanity pull events closer together. Returns a [min,max] window. Pure.
// `tension` is the docket's / the closing's lean (±0.15, −0.3): added INSIDE the 0..1 clamp so
// a calm lobby cannot go below calm nor a frayed floor past frayed; 0 is the old window exactly.
export function eventInterval(level, sanity, tension = 0) {
  const lvl = (typeof level === 'number' && level > 0) ? level : 0
  const depth = Math.min(3, lvl) / 3                                  // 0..1
  const dread = 1 - Math.max(0, Math.min(100, sanity ?? 100)) / 100   // 0 calm .. 1 frayed
  const t = Math.max(0, Math.min(1, depth * 0.6 + dread * 0.6 + (Number.isFinite(tension) ? tension : 0)))   // 0..1
  const base = 80 - t * 45                                            // ~80s calm → ~35s tense
  return [base * 0.6, base * 1.4]
}

// Create a scheduler. `rng` is injectable for tests (defaults to Math.random).
// The tension-scaled interval (min ~21s) always dominates any fixed cooldown, so
// there is no separate cooldown — the interval IS the gap between events.
// `config` ({ events, tension }) is read at every tick and never rebuilt: game.js swaps the
// catalogue at filing and its one retension() writes the lean; absent, one is built from `events`.
export function createEventScheduler({ rng = Math.random, events = EVENTS, config = null } = {}) {
  const cfg = config ?? { events, tension: 0 }
  let timer = 0
  let next = pickWindow(0, 100)   // first event after a calm interval, whatever the floor
  let arrival = false             // the pending event is the arrival's (arrive): fired, it is sound-only
  let soundOnly = false           // what the last tick returned was the arrival event

  function pickWindow(level, sanity) {
    const [a, b] = eventInterval(level, sanity, cfg.tension)
    return a + rng() * (b - a)
  }

  // Weighted shuffle bag over the events eligible at this depth (an entry per point of weight), rebuilt only when that
  // pool changes (another floor's, or a swapped catalogue), never the same id twice running. null if none.
  const bag = shuffleBag([], rng)
  let poolKey = ''
  const eligible = (e, lvl) => lvl >= (e.minLevel ?? 0) && lvl <= (e.maxLevel ?? Infinity) && e.weight > 0
  function pick(level) {
    const lvl = level ?? 0
    let key = ''
    for (const e of cfg.events) if (eligible(e, lvl)) key += `${e.id}:${e.weight},`
    if (!key) return null
    if (key !== poolKey) {
      poolKey = key
      const ids = []
      for (const e of cfg.events) if (eligible(e, lvl)) for (let w = Math.max(1, Math.round(e.weight)); w > 0; w--) ids.push(e.id)
      bag.swap(ids)
    }
    return bag.next()
  }

  return {
    // Advance by dt seconds. Returns an event id to fire this frame, or null.
    // ctx: { level, sanity, canFire } — canFire gates on modal/transition states,
    // and while it is false the timer does not advance (no banked burst on unpause).
    tick(dt, ctx = {}) {
      soundOnly = false
      if (!ctx.canFire) return null
      timer += dt
      if (timer < next) return null
      timer = 0
      soundOnly = arrival; arrival = false
      next = pickWindow(ctx.level, ctx.sanity)
      return pick(ctx.level)
    },
    // A floor has just begun (the travel, the wake, the start, the resume): with p ARRIVAL.p the next event comes in
    // [ARRIVAL.min, ARRIVAL.max] s and is the arrival's (heard, not read); otherwise it comes from the floor's own window.
    arrive(level = 0, sanity = 100) {
      timer = 0
      arrival = rng() < ARRIVAL.p
      next = arrival ? ARRIVAL.min + rng() * (ARRIVAL.max - ARRIVAL.min) : pickWindow(level, sanity)
    },
    // A beat asks for an event now: one from the bag, and the clock starts over from the floor's window. null if none.
    fireNow(level, sanity) {
      timer = 0
      arrival = false; soundOnly = false
      next = pickWindow(level, sanity)
      return pick(level)
    },
    get soundOnly() { return soundOnly },
    _pick: pick,                   // exposed for tests
    _next: () => next,
    _arrival: () => arrival,
    config: cfg,   // the mutable { events, tension } every tick reads
  }
}
