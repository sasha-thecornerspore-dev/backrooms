// plates.js — the plate budget: how much the building may put on screen while you arrive, and how often it may speak unasked after.
// Sound comes first; a line held back here has already had its sound.
//
// Pure, no imports. game.js wraps showMessage for the arrival and the unprompted kinds only (messages.js is untouched): admit() says
// whether a line shows now or waits, drain() hands a waiting one back once the arrival has settled. Times are the play clock, in seconds.
//
// createPlateBudget({ window: 45, max: 2, gap: 20 }) -> { arrive(t), admit(kind, t, line) -> 'show' | 'queue', drain(t) -> line | null }
//   arrive(t)  a floor's arrival opens a window of `window` s; the old floor's waiting lines do not follow you down
//   admit      inside the window at most `max` arrival or unprompted plates show, the floor's own line one of them (it always shows);
//              outside it unprompted text shows at most once per `gap` s, and never ahead of an older line still waiting. Player-caused
//              text (reading, searching, speaking, a gate), combat warnings and any kind the budget does not know always show and are
//              never counted. A line held back waits when its text is given (at most QUEUE_CAP: the first ones are kept); without
//              its text it is let go — the caller's way to drop a line whose moment passes with it
//   drain(t)   after the window, the oldest waiting line: the window's own one per DRAIN_S, a line held after it once per `gap`. Allocates
//              nothing (game.js asks every frame)
// arrivalPlate(cfg, first) -> the plate a floor arrives with: its sub-line the first time (never shown anywhere before), its name after
//   (the HUD carries the name already). The block keeps its name.
export const ARRIVAL_KINDS = Object.freeze(['floor', 'arrival'])
export const UNPROMPTED_KINDS = Object.freeze(['event', 'murmur', 'haunt', 'beat', 'clock', 'vignette', 'sign'])
export const FREE_KINDS = Object.freeze(['read', 'search', 'speak', 'gate', 'combat'])
export const DRAIN_S = 10
export const QUEUE_CAP = 4

// a budgeted kind: an arrival or an unprompted line. Everything else is free
const budgeted = (kind) => ARRIVAL_KINDS.includes(kind) || UNPROMPTED_KINDS.includes(kind)

export function createPlateBudget({ window = 45, max = 2, gap = 20 } = {}) {
  const lines = [], early = []        // the waiting lines, oldest first, and whether each was held inside an arrival window
  let winEnd = -Infinity              // the open window's end (none yet: every line is past one)
  let shown = 0                       // budgeted plates shown in the open window
  let lastT = -Infinity               // when the last budgeted plate went up (a drained one too)

  function arrive(t) { winEnd = t + window; shown = 0; lines.length = 0; early.length = 0 }

  function hold(line, inWindow) {
    if (!line || lines.length >= QUEUE_CAP) return
    lines.push(line); early.push(inWindow)
  }

  function admit(kind, t, line = null) {
    if (!budgeted(kind)) return 'show'
    if (t < winEnd) {
      if (kind === 'floor' || shown < max) { shown++; lastT = t; return 'show' }
      hold(line, true)
      return 'queue'
    }
    if (lines.length === 0 && t - lastT >= gap) { lastT = t; return 'show' }
    hold(line, false)
    return 'queue'
  }

  function drain(t) {
    if (t < winEnd || lines.length === 0) return null
    if (t - lastT < (early[0] ? DRAIN_S : gap)) return null
    early.shift(); lastT = t
    return lines.shift()
  }

  return { arrive, admit, drain }
}

export function arrivalPlate(cfg, first) {
  if (!cfg) return ''
  return first && !cfg.map && cfg.levelSub ? cfg.levelSub : cfg.levelName
}
