// compass.js — the two-line compass under the HUD.
//
// Line 1 points at the nearest way you have SEEN of a kind that leads on (down, the lift, the ring back), any distance, from the fog
// map's ways list and nothing else; a stale one (its chunk moved under it) keeps its place with a '~'. When nothing is known it points
// at the nearest loaded way as 'something pulls, faintly', so it is never blank where today it pointed somewhere. Line 2 is 'the way you
// came', toward the arrived pin, omitted when there is none. Two lines, never three. Pure, allocation-free once `out` has its two slots.
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
// a pin imported without its label still reads by kind
const KIND_LABEL = { down: 'descend', lift: 'the lift', ring: 'climb out', up: 'stairwell up' }

const leadsOn = (k) => k === 'down' || k === 'lift' || k === 'ring'

function textFor(p) {
  const kind = p.type ?? p.kind
  const label = p.label ?? KIND_LABEL[kind] ?? kind
  return p.target != null ? labelOf({ label, target: p.target }) : `${label} — ${shortName(p.target)}`
}

function fill(s, player, x, y, text, dist) {
  s.arrow = exitArrow(Math.atan2(y - player.y, x - player.x) - player.angle)
  s.text = text
  s.dist = dist
}

// compassLines({ player, known, fallback, arrived, stale }, out) -> out
//   known: fog.ways(level) (pins { type, x, y, label, target, lost, chunkKey }); fallback: decor.nearestWayAny() ({ rec, dist } | null);
//   arrived: fog.arrivedPin(level) | null; stale: (pin) -> boolean | null. `out` is reused, as are its two line objects.
export function compassLines({ player, known, fallback = null, arrived = null, stale = null }, out) {
  const slots = out.slots || (out.slots = [{ arrow: '', text: '', dist: 0 }, { arrow: '', text: '', dist: 0 }])
  let n = 0
  let best = null, bestD2 = Infinity
  if (known) for (let i = 0; i < known.length; i++) {
    const p = known[i]
    if (p.lost || !leadsOn(p.type ?? p.kind)) continue
    const dx = p.x - player.x, dy = p.y - player.y
    const d2 = dx * dx + dy * dy
    if (d2 < bestD2) { bestD2 = d2; best = p }
  }
  if (best) {
    fill(slots[0], player, best.x, best.y, (stale && stale(best) ? '~' : '') + textFor(best), Math.sqrt(bestD2))
    out[n++] = slots[0]
  } else if (fallback && fallback.rec) {
    const r = fallback.rec
    const dist = fallback.dist ?? Math.sqrt((r.x - player.x) ** 2 + (r.y - player.y) ** 2)
    fill(slots[0], player, r.x, r.y, FAINT, dist)
    out[n++] = slots[0]
  }
  if (arrived) {
    fill(slots[1], player, arrived.x, arrived.y, CAME, Math.sqrt((arrived.x - player.x) ** 2 + (arrived.y - player.y) ** 2))
    out[n++] = slots[1]
  }
  if (out.length !== n) out.length = n
  return out
}

// '↗  descend — level 2  ·  41m' newline '←  the way you came  ·  12m'; '' when there is nothing to point at
export function compassText(out) {
  let s = ''
  for (let i = 0; i < out.length; i++) {
    const l = out[i]
    s += (i ? '\n' : '') + `${l.arrow}  ${l.text}  ·  ${Math.round(l.dist)}m`
  }
  return s
}

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
