// compass.js — the two-line compass under the HUD.
//
// Line 1 points at the nearest way you have SEEN of a kind that leads on (down, the lift, the ring back), any distance, from the fog
// map's ways list and nothing else; a stale one (its chunk moved under it) keeps its place with a '~'. When nothing is known it may
// point at the nearest loaded way that leads on as 'something pulls, faintly': no metres, only once the floor has had you a while or
// given you a hint (pullVisible), and a little off true (pullWobble), so it hints at a direction instead of walking you past everything.
// Line 2 is 'the way you came', toward the arrived pin, omitted when there is none. Two lines, never three. Pure, allocation-free
// once `out` has its two slots.
export { wayLabel } from './topology.js'
import { wayLabel as labelOf, shortName } from './topology.js'

// A directional arrow (clockwise from straight-ahead) for the descent compass — game.js:60-65 as it was.
export const EXIT_DIRS = ['↑', '↗', '→', '↘', '↓', '↙', '←', '↖']
export function exitArrow(rel) {
  let a = rel % (Math.PI * 2)
  if (a < 0) a += Math.PI * 2
  return EXIT_DIRS[Math.round(a / (Math.PI / 4)) % 8]
}

export const FAINT = 'something pulls, faintly'
const CAME = 'the way you came'

// the faint pull waits: 90 s of floor time this visit, or a hint from the floor (a page read, a trace pinned, a soul's line).
// On a fresh run's lobby it waits for the first-run thread instead: its second step, or 120 s.
export const PULL_WAIT_S = 90
export const PULL_FRESH_S = 120
// pullVisible({ floorT, hinted, fresh, step }) -> boolean. fresh: a fresh run's lobby with the first-run thread on; step: that
// thread's step. The exit-hint plate there follows the same rule.
export function pullVisible({ floorT = 0, hinted = false, fresh = false, step = 0 } = {}) {
  if (fresh) return step >= 2 || floorT >= PULL_FRESH_S
  return hinted || floorT >= PULL_WAIT_S
}
// ±30°, slow: a sine of floor time (a period of about 44 s) and a phase the caller picks once a visit, never per-frame noise;
// tier 2a passes a wider `amp` below sanity 25
export const PULL_WOBBLE = Math.PI / 6
export function pullWobble(floorT, phase = 0, amp = PULL_WOBBLE) { return amp * Math.sin(floorT / 7 + phase) }
// the caller redraws the compass this often even when you stand still: the lean moves with floor time, not with your cell
export const PULL_REDRAW_S = 0.5
// a pin imported without its label still reads by kind
const KIND_LABEL = { down: 'descend', lift: 'the lift', ring: 'climb out', up: 'stairwell up' }

const leadsOn = (k) => k === 'down' || k === 'lift' || k === 'ring'

function textFor(p) {
  const kind = p.type ?? p.kind
  const label = p.label ?? KIND_LABEL[kind] ?? kind
  return p.target != null ? labelOf({ label, target: p.target }) : `${label} — ${shortName(p.target)}`
}

function fill(s, player, x, y, text, dist, turn = 0) {
  s.arrow = exitArrow(Math.atan2(y - player.y, x - player.x) - player.angle + turn)
  s.text = text
  s.dist = dist
}

// compassLines({ player, known, fallback, arrived, stale, pull, wobble, skip }, out) -> out
//   known: fog.ways(level) (pins { type, x, y, label, target, lost, chunkKey }); fallback: decor.nearestWayOn() ({ rec, dist } | null);
//   arrived: fog.arrivedPin(level) | null; stale: (pin) -> boolean | null. pull: false hides the faint line (pullVisible);
//   wobble: radians off true for the faint line only (pullWobble); skip: (kind) -> boolean | null passes over a kind in the known
//   list and the fallback alike (a gated ring, later). `out` is reused, as are its two line objects.
export function compassLines({ player, known, fallback = null, arrived = null, stale = null, pull = true, wobble = 0, skip = null }, out) {
  const slots = out.slots || (out.slots = [{ arrow: '', text: '', dist: 0 }, { arrow: '', text: '', dist: 0 }])
  let n = 0
  let best = null, bestD2 = Infinity
  if (known) for (let i = 0; i < known.length; i++) {
    const p = known[i]
    const kind = p.type ?? p.kind
    if (p.lost || !leadsOn(kind) || (skip && skip(kind))) continue
    const dx = p.x - player.x, dy = p.y - player.y
    const d2 = dx * dx + dy * dy
    if (d2 < bestD2) { bestD2 = d2; best = p }
  }
  if (best) {
    fill(slots[0], player, best.x, best.y, (stale && stale(best) ? '~' : '') + textFor(best), Math.sqrt(bestD2))
    out[n++] = slots[0]
  } else if (pull && fallback && fallback.rec && !(skip && skip(fallback.rec.kind ?? fallback.rec.type))) {
    const r = fallback.rec
    const dist = fallback.dist ?? Math.sqrt((r.x - player.x) ** 2 + (r.y - player.y) ** 2)
    fill(slots[0], player, r.x, r.y, FAINT, dist, wobble)
    out[n++] = slots[0]
  }
  if (arrived) {
    fill(slots[1], player, arrived.x, arrived.y, CAME, Math.sqrt((arrived.x - player.x) ** 2 + (arrived.y - player.y) ** 2))
    out[n++] = slots[1]
  }
  if (out.length !== n) out.length = n
  return out
}

// '↗  descend — level 2  ·  41m' newline '←  the way you came  ·  12m'; '' when there is nothing to point at. The faint line
// names no metres: a pull, not a measurement. faintMetres keeps them on it: the block's compass, as it was (the hold).
export function compassText(out, faintMetres = false) {
  let s = ''
  for (let i = 0; i < out.length; i++) {
    const l = out[i]
    s += (i ? '\n' : '') + (l.text === FAINT && !faintMetres ? `${l.arrow}  ${l.text}` : `${l.arrow}  ${l.text}  ·  ${Math.round(l.dist)}m`)
  }
  return s
}

// the setting's line waits this long into a visit: past the arrival's plates (plates.js, 45 s), before the faint pull frees (90 s)
export const LOST_AFTER_S = 60
// lostDue(out, said, floorT, guided) -> boolean: levels.js LOST_LINE may be said now — the compass shows no way (neither a known
// one nor the faint pull), the floor has had you LOST_AFTER_S of this visit and given you no lead (guided: a hint, the first
// run's note), and the line has not been said this visit. You are lost, not only new
export function lostDue(out, said, floorT = 0, guided = false) {
  return !said && !guided && floorT >= LOST_AFTER_S && !(out.length > 0 && out[0].text !== CAME)
}

// the seen line (T1-6): it names the thing only when it is on screen (in the view cone, in sight); off screen the creature's
// tell, panned toward it, carries the direction instead of words
export const SEEN_ON = 'it has seen you.'
export const SEEN_OFF = 'something has seen you.'
export function seenLine(onScreen) { return onScreen ? SEEN_ON : SEEN_OFF }

export function numberWord(n) { return n === 1 ? 'one' : n === 2 ? 'two' : n === 3 ? 'three' : n === 4 ? 'four' : String(n) }

// said on arriving at a floor you have been on: null on a first visit or without counts
export function arrivalSummary(counts, visits) {
  if (!counts || !(visits >= 2)) return null
  const d = counts.down | 0
  let s = 'you have been on this floor before.'
  if (d === 1) s += ' one way down is on your map.'
  else if (d > 1) s += ` ${numberWord(d)} ways down are on your map.`
  return s
}
