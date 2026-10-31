// tension.js — the hunted state as music. Nothing on screen changes; the
// floor's own song thickens and your heart comes into your ears, and when you
// lose it the music takes a long breath before it sounds like itself again.
//
// Pure. game.js feeds it the hunt's threat report each frame and acts on what
// comes back: a heartbeat cadence, a mood transition for audio.setMood, one
// 'it is close.' line. The result object is reused: read it, do not keep it.
//
// createTension() -> { tick(dt, threat, hp, dread = 0) -> { level, beat, mood, just, close, huntLevel }, reset() }
//   threat: { hunted, nearest, gaze, arcPending } (hunt.createThreat); null is calm
//   dread   0..1 from dread.js (a creature near you through the maze, not hunting): a term of its own, chasing dread x DREAD_K (at most
//           DREAD_CAP) at the same attack and falling at 2/s, so a slow heartbeat comes before anything hunts you and stops within a
//           beat of the thing going (a ward dispels it, it drifts out of reach), and dread alone never enters the hunt mood. 0 is
//           exactly the tick before it: dread's term stays 0 and the level is huntLevel
//   level   0..1, the louder of huntLevel and dread's term: a hunt's fade keeps its long breath, and dread's lift never lengthens it
//   beat    seconds until the next heartbeat (heartbeatPeriod), Infinity when calm
//   mood    'calm' | 'hunt' with hysteresis: enter after 1.5 s above TENSION_ENTER, exit after 6 s with huntLevel below TENSION_EXIT
//           (dread's term stays under TENSION_ENTER: it never moves the enter, the exit or the close, and never holds the mood)
//   just    'enter' | 'exit' on the transition frame, else null
//   close   true once when level crosses 0.85 upward, at most once per 12 s
//   huntLevel  the hunt's own chase of its target, attack 0.9/s and decay 0.12/s (the mood's exit and the pulse read it, so dread can
//              never hold either up)
// huntDelta(mood) / calmDelta(mood): the four mood keys setMood may patch live. Tempo is never one of them.
export const TENSION_ENTER = 0.55
export const TENSION_EXIT  = 0.25
export const DREAD_CAP = 0.35   // above BEAT_FLOOR, below TENSION_ENTER
export const DREAD_K   = 0.6

const ATTACK = 0.9, DECAY = 0.12, DREAD_DECAY = 2
const ENTER_S = 1.5, EXIT_S = 6
const CLOSE_AT = 0.85, CLOSE_THROTTLE_S = 12
const BEAT_FLOOR = 0.15
const NEAR_FULL = 12          // a hunter this far reads as the mildest hunt
const NONE = {}

export function heartbeatPeriod(level) {
  return level < BEAT_FLOOR ? Infinity : 1.3 - 0.95 * level
}

export function createTension() {
  const res = { level: 0, beat: Infinity, mood: 'calm', just: null, close: false, huntLevel: 0 }
  let level = 0, huntLevel = 0, dreadLevel = 0, mood = 'calm'
  let above = 0, below = 0         // time spent past the enter / exit lines
  let was85 = false, closeCd = 0

  function reset() {
    level = 0; huntLevel = 0; dreadLevel = 0; mood = 'calm'; above = 0; below = 0; was85 = false; closeCd = 0
    res.level = 0; res.beat = Infinity; res.mood = mood; res.just = null; res.close = false; res.huntLevel = 0
  }

  function tick(dt, threat, hp, dread = 0) {
    const th = threat || NONE
    let target = 0
    if (th.hunted) target = 0.6 + 0.4 * (1 - Math.min(th.nearest ?? NEAR_FULL, NEAR_FULL) / NEAR_FULL)
    if (th.gaze && target < 0.35) target = 0.35
    if (th.arcPending && target < 0.8) target = 0.8
    if (hp < 25 && target < 0.4) target = 0.4
    huntLevel = huntLevel < target ? Math.min(target, huntLevel + ATTACK * dt) : Math.max(target, huntLevel - DECAY * dt)
    // dread's own term chases on its own, falling fast (DREAD_DECAY): a beat it raised stops within a beat of the thing going
    const dTarget = dread > 0 ? Math.min(DREAD_CAP, dread * DREAD_K) : 0
    dreadLevel = dreadLevel < dTarget ? Math.min(dTarget, dreadLevel + ATTACK * dt) : Math.max(dTarget, dreadLevel - DREAD_DECAY * dt)
    level = huntLevel > dreadLevel ? huntLevel : dreadLevel

    let just = null
    if (mood === 'calm') {
      above = level > TENSION_ENTER ? above + dt : 0
      if (above >= ENTER_S) { mood = 'hunt'; just = 'enter'; above = 0; below = 0 }
    } else {
      below = huntLevel < TENSION_EXIT ? below + dt : 0   // the hunt's own level: dread never holds the mood up
      if (below >= EXIT_S) { mood = 'calm'; just = 'exit'; above = 0; below = 0 }
    }

    if (closeCd > 0) closeCd = Math.max(0, closeCd - dt)
    const is85 = level >= CLOSE_AT
    let close = false
    if (is85 && !was85 && closeCd <= 0) { close = true; closeCd = CLOSE_THROTTLE_S }
    was85 = is85

    res.level = level; res.beat = heartbeatPeriod(level); res.mood = mood; res.just = just; res.close = close; res.huntLevel = huntLevel
    return res
  }

  return { tick, reset }
}

// audio.js's own fallbacks, so a base mood missing a key restores to what the engine was playing.
const BRIGHTNESS = 1200, VOLUME = 0.06, LEAD = 0.35, GROOVE = 0

export function huntDelta(mood) {
  return { groove: 1, leadChance: 0.05, brightness: (mood.brightness ?? BRIGHTNESS) * 0.7, volume: (mood.volume ?? VOLUME) * 1.15 }
}

export function calmDelta(mood) {
  return { groove: mood.groove ?? GROOVE, leadChance: mood.leadChance ?? LEAD, brightness: mood.brightness ?? BRIGHTNESS, volume: mood.volume ?? VOLUME }
}
