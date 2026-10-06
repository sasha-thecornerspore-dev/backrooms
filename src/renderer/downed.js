// downed.js — going down instead of dying while a friend is on the floor, and being counted back by one who kneels with their light on.
//
// Pure, no imports, on the MILLISECOND clock the caller injects (game.js: performance.now() — kneel ticks arrive from the socket outside
// the loop, and a 25 s limit must not stop counting because the tab is hidden); every `t` is optional and defaults to now().
//   createDownState  your side: 'ok' | 'down', the kneel count (one kneeler at a time, eight ticks, not before 4 s), the 25 s limit
//   downedInFront    who you could kneel by (the nearest downed friend in reach and in front, through an injected line of sight)
//   createKneel      the kneeler's side: a tick to emit every 500 ms while the friend stays down and near, and the memory of whom you
//                    knelt by (their 'woke' frame lands after their here.st has already flipped to 'ok')
// The decision to go down is W4's deathDecision; waking never reaches die(), never mints thin, never adds leash debt.
export const DOWN_LINE = 'everything goes dark. you are still here. somewhere, someone may notice.'
export const KNEEL_HINT = 'f · stay with them'
export const HANDS_LINE = 'your hands are on them.'
export const LIGHT_STAYS_LINE = 'your light stays on them.'
export const WOKEN_LINE = 'you are counted. you come back.'
export const KNEELER_LINE = 'you stayed. you counted them back.'
export const WAKE = Object.freeze({ hp: 60, sanity: 10, invuln: 2, regenDelay: 0 })
export const KNEELER_SANITY = 8
export const DOWN_BEAT = Object.freeze({ intensity: 0.3, everyS: 2 })

const defaultNow = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())

// tickMs is the kneeler's cadence (createKneel emits on it); the downed side only enforces minTickMs / lockMs
export function createDownState({ now = defaultNow, limitMs = 25000, holdMs = 4000, tickMs = 500, lockMs = 1200, minTickMs = 350, ticksToWake = 8 } = {}) {
  let st = 'ok', downAt = NaN, progress = 0, kneeler = null, lastTick = -Infinity, timedOut = false

  function clear() { st = 'ok'; downAt = NaN; progress = 0; kneeler = null; lastTick = -Infinity; timedOut = false }

  function goDown(t = now()) {
    if (st === 'down') return
    st = 'down'; downAt = t; progress = 0; kneeler = null; lastTick = -Infinity; timedOut = false
  }

  function kneelTick(fromId, t = now()) {
    if (st !== 'down') return 'ignored'
    if (kneeler !== null && kneeler !== fromId && t - lastTick <= lockMs) return 'ignored'   // one kneeler per down
    if (t - lastTick < minTickMs) return 'ignored'                                           // a flood counts once per 350 ms
    if (kneeler !== fromId || t - lastTick > lockMs) { progress = 0; kneeler = fromId }      // silence opens the lock; the count starts over
    lastTick = t
    progress++
    if (progress >= ticksToWake && t - downAt >= holdMs) { clear(); return 'woken' }       // the fall takes 4 s to be a fall
    return 'progress'
  }

  // evidence (W7's photo) wakes you at once, no hold
  function wakeNow(t = now()) {
    if (st !== 'down') return 'ignored'
    clear()
    return 'woken'
  }

  function tick(t = now()) {
    if (st === 'down' && !timedOut && t - downAt >= limitMs) { timedOut = true; return 'timeout' }
    return null
  }

  // the #down veil's opacity: lifts as you are counted, darkens back when the count lapses
  function lift(t = now()) {
    if (st !== 'down') return 0
    return 0.9 - 0.45 * (progress < ticksToWake ? progress : ticksToWake) / ticksToWake
  }

  return {
    get st() { return st }, get progress() { return progress }, get kneeler() { return kneeler }, get since() { return downAt },
    goDown, kneelTick, wakeNow, tick, lift, reset: clear,
  }
}

const NO_OPTS = Object.freeze({})
const TAU = Math.PI * 2

// wrap to (-π, π]
function wrap(a) {
  a %= TAU
  if (a > Math.PI) a -= TAU
  else if (a <= -Math.PI) a += TAU
  return a
}

// the nearest record in `peers` (the integrator's remoteOnFloor) that is down, within reach, in front and in sight; the record itself
export function downedInFront(player, peers, opts = NO_OPTS) {
  const cells = opts.cells ?? 1.3, arc = opts.arc ?? 0.6, los = opts.los ?? null
  let best = null, bestD = Infinity
  for (let i = 0; i < peers.length; i++) {
    const rp = peers[i]
    if (!rp || rp.st !== 'down') continue
    const dx = rp.x - player.x, dy = rp.y - player.y
    const d = Math.hypot(dx, dy)
    if (d > cells || d >= bestD) continue
    if (Math.abs(wrap(Math.atan2(dy, dx) - player.angle)) > arc) continue
    if (los && !los(player.x, player.y, rp.x, rp.y)) continue
    best = rp; bestD = d
  }
  return best
}

export function createKneel({ now = defaultNow, tickMs = 500, leaveCells = 6, rewardMs = 2000 } = {}) {
  let st = null, last = null

  function start(id, name, t = now(), pressCount = 0) {
    st = { id, name, t0: t, ticks: 0, lastEmit: -Infinity, lastTick: t, press0: pressCount }
  }

  function stop(t = now()) {
    if (!st) return
    last = { id: st.id, at: t }
    st = null
  }

  // `target` is the remoteOnFloor record for st.id, or null
  function tick(t = now(), target, player) {
    if (!st) return null
    if (!target || target.st !== 'down' || Math.hypot(target.x - player.x, target.y - player.y) > leaveCells) { stop(t); return 'ended' }
    if (t - st.lastEmit >= tickMs) { st.lastEmit = t; st.lastTick = t; st.ticks++; return 'emit' }
    return null
  }

  // the hint's opacity while kneeling: no numbers on screen
  function dim() {
    const n = st ? st.ticks : 0
    return 1 - 0.65 * (n < 8 ? n : 8) / 8
  }

  function wasKneelingOn(id, t = now()) {
    return !!((st && st.id === id) || (last && last.id === id && t - last.at < rewardMs))
  }

  return { get st() { return st }, start, stop, tick, dim, wasKneelingOn }
}
