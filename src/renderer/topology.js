// topology.js — the stacked floors.
//
// The levels are stacked in ONE world coordinate system: the hole you fall through on level 0 at (x, y) drops you onto level 1 near
// (x, y), so the building keeps its shape. Each level's `ways` are its exit first ([0] is always today's exit, so every legacy path
// is untouched), then the ways this release adds: a stairwell up under one in three of the parent floor's exits (the partner gate,
// decided child-side from the PARENT's exit gate), and on level 1 alone a one-way lift to level 3. Pure: no DOM, no game state.
// game.js's travel() does the moving; this module says where you land and what is said.
import { LEVELS } from './levels.js'
import { CHANNELS } from './channels.js'
import { CHUNK_SIZE } from './world.js'

export const WAY_KINDS = Object.freeze(['down', 'up', 'lift', 'ring'])
export const UP_ONE_IN = 3        // one parent exit in three has a stairwell beneath it
export const LIFT_DENOM = 24      // one level-1 chunk in twenty-four holds the lift

const N = LEVELS.length
const wrap = (i) => ((i % N) + N) % N
const saltOf = (i) => LEVELS[i].config.maze?.salt | 0
// decor.js:51 — the parent's exit gate denominator exactly as decor reads it
const exitDenomOf = (i) => Math.max(1, LEVELS[i].config.exit?.denom ?? 6)

// decor.js's hash, verbatim: the partner gate must see the parent's exits exactly where decor.js put them
function hash(a, b, c = 0) {
  let h = (a * 2654435761 ^ b * 2246822519 ^ Math.imul(c, 3266489917)) >>> 0
  h ^= h >>> 16; h = Math.imul(h, 0x45d9f3b) >>> 0
  h ^= h >>> 16
  return h >>> 0
}

const [EXIT_A, EXIT_B] = CHANNELS.exits.gate
const [UP_A, UP_B] = CHANNELS.upStair.gate
const [UP_MX, UP_AX, UP_MY, UP_AY] = CHANNELS.upStair.rng
const [LIFT_A, LIFT_B] = CHANNELS.lift.gate
const [LIFT_MX, LIFT_AX, LIFT_MY, LIFT_AY] = CHANNELS.lift.rng

// ── the graph ──
// [0] is the level's exit as levels.js names it (kind by direction: a target below is 'down', one above is the 'ring' back); the
// stairwell up leads to the floor directly above (partnerOf names it); the lift is level 1's alone.
const UP = (target) => ({ kind: 'up', target, label: 'stairwell up', partnerOf: target })
const WAYS = LEVELS.map((lvl, i) => {
  const ex = lvl.config.exit
  const first = { kind: ex.target < i ? 'ring' : 'down', target: ex.target, denom: ex.denom, label: ex.label }
  const list = [first]
  if (i === 1) list.push(UP(0), { kind: 'lift', target: 3, denom: LIFT_DENOM, label: 'the lift' })
  else if (i === 2 || i === 3) list.push(UP(i - 1))
  for (const w of list) Object.freeze(w)
  return Object.freeze(list)
})

export function waysFor(index) { return WAYS[wrap(index)] }

// ── the partner gate (child-side, pure) ──
// A stairwell up exists on floor T at chunk (cx, cy) iff the PARENT floor S = T - 1 has an exit gate pass there (decor.js:104 with the
// parent's salt and denom) AND T's own 1-in-3 sub-gate passes: so most holes have no stair beneath them, and no stair leads up to a
// chunk without a hole. Whether the parent's exit actually found an open cell is not part of the gate (walls are not).
export function hasUpStair(T, cx, cy, seed = 0) {
  const S = T - 1
  if (!Number.isInteger(T) || S < 0 || T > 3) return false
  const saltS = saltOf(S)
  if (hash(cx + EXIT_A + saltS, cy + EXIT_B + saltS, seed) % exitDenomOf(S) !== 0) return false
  const saltT = saltOf(T)
  return hash(cx + UP_A + saltT, cy + UP_B + saltT, seed) % UP_ONE_IN === 0
}

// the chunk's hall crossing: open at every epoch (world.js:153-154), so it is the one spot that can always be fallen back to
export function chunkMid(cx, cy) { return { x: cx * CHUNK_SIZE + (CHUNK_SIZE >> 1) + 0.5, y: cy * CHUNK_SIZE + (CHUNK_SIZE >> 1) + 0.5 } }

// ── the decor pass ──
// stairsPass(cfg, ways) -> (ctx) => void, or null when the level has no 'up' / 'lift' way. Runs inside decor.js's pass pipeline on its
// own channels (channels.js upStair / lift) through ctx.rngFrom / ctx.hash / ctx.openCell, so nothing placed above it moves. On solid
// walls (no open cell) the stair stands at the chunk midpoint, which is open at every epoch.
export function stairsPass(cfg, ways) {
  const list = ways ?? cfg?.ways ?? []
  const up = list.find((w) => w.kind === 'up') ?? null
  const lift = list.find((w) => w.kind === 'lift') ?? null
  if (!up && !lift) return null
  // the floor this pass runs on: levels.js's index for the ring floors; a stairwell up always leads to the floor directly above
  const T = Number.isInteger(cfg?.levelIndex) ? cfg.levelIndex : (up ? up.target + 1 : 1)
  return (ctx) => {
    const { cx, cy, salt, seed } = ctx
    if (up && hasUpStair(T, cx, cy, seed)) {
      const rng = ctx.rngFrom(cx * UP_MX + salt + UP_AX, cy * UP_MY + salt + UP_AY, seed)
      const spot = ctx.openCell(rng)
      const at = spot ? { x: spot.wx, y: spot.wy } : chunkMid(cx, cy)
      ctx.add('stair', { key: `${ctx.key}:up`, x: at.x, y: at.y, kind: 'up', target: up.target, label: up.label, cx, cy })
    }
    if (lift && ctx.hash(cx + LIFT_A + salt, cy + LIFT_B + salt, seed) % LIFT_DENOM === 0) {
      const rng = ctx.rngFrom(cx * LIFT_MX + salt + LIFT_AX, cy * LIFT_MY + salt + LIFT_AY, seed)
      const spot = ctx.openCell(rng)
      const at = spot ? { x: spot.wx, y: spot.wy } : chunkMid(cx, cy)
      ctx.add('stair', { key: `${ctx.key}:lift`, x: at.x, y: at.y, kind: 'lift', target: lift.target, label: lift.label, cx, cy })
    }
  }
}

// ── arrivals ──
// The spiral: every cell offset within Chebyshev radius SPIRAL_R, nearest (Euclidean) first, ties in scan order (dy, then dx). Built
// once; findOpenNear walks it until the ring runs out.
const SPIRAL_R = 8
const SPIRAL = []
for (let dy = -SPIRAL_R; dy <= SPIRAL_R; dy++) for (let dx = -SPIRAL_R; dx <= SPIRAL_R; dx++) SPIRAL.push({ dx, dy, d2: dx * dx + dy * dy, ring: Math.max(Math.abs(dx), Math.abs(dy)) })
SPIRAL.sort((a, b) => a.d2 - b.d2 || a.dy - b.dy || a.dx - b.dx)

// the centre of the nearest open cell within `rings` of (x, y), the own cell first, or null. floorFn(ix, iy) -> true = open.
export function findOpenNear(x, y, floorFn, rings = 3) {
  const ix = Math.floor(x), iy = Math.floor(y)
  const R = Math.min(rings, SPIRAL_R)
  for (let i = 0; i < SPIRAL.length; i++) {
    const o = SPIRAL[i]
    if (o.ring > R) continue
    if (floorFn(ix + o.dx, iy + o.dy)) return { x: ix + o.dx + 0.5, y: iy + o.dy + 0.5 }
  }
  return null
}

// beside a way: the centre of the first open 4-neighbour cell two away along an open cardinal (the cell between open too, so you can
// walk back to it), then one away, else the spot itself. East, west, south, north.
const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]]
export function offsetBeside(spot, floorFn) {
  const sx = Math.floor(spot.x), sy = Math.floor(spot.y)
  for (let i = 0; i < DIRS.length; i++) {
    const [dx, dy] = DIRS[i]
    if (floorFn(sx + dx, sy + dy) && floorFn(sx + 2 * dx, sy + 2 * dy)) return { x: sx + 2 * dx + 0.5, y: sy + 2 * dy + 0.5 }
  }
  for (let i = 0; i < DIRS.length; i++) {
    const [dx, dy] = DIRS[i]
    if (floorFn(sx + dx, sy + dy)) return { x: sx + dx + 0.5, y: sy + dy + 0.5 }
  }
  return spot
}

// where you land on the new floor, in the shared coordinate system:
//   • beside the partner way when there is one (the stair under the hole you fell through, the hole over the stair you climbed),
//   • a ring arrival with memory: where you last stood on that floor (mem.x / mem.y from levelmem),
//   • else the from-chunk's midpoint (the lift always: it has no partner).
// Validated: a start inside a wall moves to the nearest open cell within three rings, else the midpoint, which is open at every epoch.
// The angle is preserved (whatever is passed in, 0 when nothing). chunk is the from-chunk: the arrival is placed within it.
export function arrivalFor({ way, fromCx, fromCy, partner = null, mem = null, floorFn, angle = 0 }) {
  let start
  if (partner) start = offsetBeside(partner, floorFn)
  else if (way?.kind === 'ring' && mem?.x != null && mem?.y != null) start = { x: mem.x, y: mem.y }
  else start = chunkMid(fromCx, fromCy)
  if (!floorFn(Math.floor(start.x), Math.floor(start.y))) start = findOpenNear(start.x, start.y, floorFn) ?? chunkMid(fromCx, fromCy)
  return { x: start.x, y: start.y, angle, chunk: { cx: fromCx, cy: fromCy } }
}

// ── the words ──
// wayMessage(way, ctx): the line for an arrival by this way (null when there is nothing to say). ctx.before = true asks for the line said
// before the fade instead (only the lift has one).
export function wayMessage(way, { partner = null, mem = null, before = false } = {}) {
  if (!way) return null
  if (before) return way.kind === 'lift' ? 'the lift arrives without being called. it only goes one place.' : null
  switch (way.kind) {
    case 'down': return partner ? 'you land a few rooms over from where you fell.' : 'you land a few rooms over. there is no way back up here.'
    case 'up': return 'you climb. the air is thinner and the same.'
    case 'lift': return 'the doors close behind you. the lift does not come back for you.'
    case 'ring': return mem?.x != null ? 'the carpet remembers you.' : null
    default: return null
  }
}

export function shortName(index) { return index === 4 || index === '∅' ? 'the block' : `level ${index}` }

export function wayLabel(way) { return `${way.label} — ${shortName(way.target)}` }
