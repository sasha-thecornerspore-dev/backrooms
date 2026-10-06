// tension.js — the hunted state as music. Nothing on screen changes; the
// floor's own song thickens and your heart comes into your ears, and when you
// lose it the music takes a long breath before it sounds like itself again.
//
// Pure. game.js feeds it the hunt's threat report each frame and acts on what
// comes back: a heartbeat cadence, a mood transition for audio.setMood, one
// 'it is close.' line. The result object is reused: read it, do not keep it.
//
// createTension() -> { tick(dt, threat, hp) -> { level, beat, mood, just, close }, reset() }
//   threat: { hunted, nearest, gaze, arcPending } (hunt.createThreat); null is calm
//   level   0..1, chasing a target with attack 0.9/s and decay 0.12/s
//   beat    seconds until the next heartbeat (heartbeatPeriod), Infinity when calm
//   mood    'calm' | 'hunt' with hysteresis: enter after 1.5 s above TENSION_ENTER, exit after 6 s below TENSION_EXIT
//   just    'enter' | 'exit' on the transition frame, else null
//   close   true once when level crosses 0.85 upward, at most once per 12 s
// huntDelta(mood) / calmDelta(mood): the four mood keys setMood may patch live. Tempo is never one of them.
export const TENSION_ENTER = 0.55
export const TENSION_EXIT  = 0.25

const ATTACK = 0.9, DECAY = 0.12
const ENTER_S = 1.5, EXIT_S = 6
const CLOSE_AT = 0.85, CLOSE_THROTTLE_S = 12
const BEAT_FLOOR = 0.15
const NEAR_FULL = 12          // a hunter this far reads as the mildest hunt
const NONE = {}

export function heartbeatPeriod(level) {
  return level < BEAT_FLOOR ? Infinity : 1.3 - 0.95 * level
}

export function createTension() {
  const res = { level: 0, beat: Infinity, mood: 'calm', just: null, close: false }
  let level = 0, mood = 'calm'
  let above = 0, below = 0         // time spent past the enter / exit lines
  let was85 = false, closeCd = 0

  function reset() {
    level = 0; mood = 'calm'; above = 0; below = 0; was85 = false; closeCd = 0
    res.level = 0; res.beat = Infinity; res.mood = mood; res.just = null; res.close = false
  }

  function tick(dt, threat, hp) {
    const th = threat || NONE
    let target = 0
    if (th.hunted) target = 0.6 + 0.4 * (1 - Math.min(th.nearest ?? NEAR_FULL, NEAR_FULL) / NEAR_FULL)
    if (th.gaze && target < 0.35) target = 0.35
    if (th.arcPending && target < 0.8) target = 0.8
    if (hp < 25 && target < 0.4) target = 0.4
    level = level < target ? Math.min(target, level + ATTACK * dt) : Math.max(target, level - DECAY * dt)

    let just = null
    if (mood === 'calm') {
      above = level > TENSION_ENTER ? above + dt : 0
      if (above >= ENTER_S) { mood = 'hunt'; just = 'enter'; above = 0; below = 0 }
    } else {
      below = level < TENSION_EXIT ? below + dt : 0
      if (below >= EXIT_S) { mood = 'calm'; just = 'exit'; above = 0; below = 0 }
    }

    if (closeCd > 0) closeCd = Math.max(0, closeCd - dt)
    const is85 = level >= CLOSE_AT
    let close = false
    if (is85 && !was85 && closeCd <= 0) { close = true; closeCd = CLOSE_THROTTLE_S }
    was85 = is85

    res.level = level; res.beat = heartbeatPeriod(level); res.mood = mood; res.just = just; res.close = close
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
