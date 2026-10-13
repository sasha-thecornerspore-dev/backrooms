// haunts.js — the placed hauntings. Some places are wrong every time: a figure standing still in the mouth of the corridor you just
// walked, gone when you are three steps away; chairs that have been moved; running water that keeps your pace; a knock from inside a
// panel cabinet; your own light going out for a breath. They never hurt you, never move toward you, and never happen while something
// real is close — the calm gate in game.js — so a still figure can be trusted to be the building, and anything that moves is not.
//
// Pure. The pass is an appended decor pass on its own channels.js constants (haunts: gate / rng / pick) through ctx.hash / ctx.rngFrom /
// ctx.openCell, so every older placement stays byte-identical; a haunt is a record { key: `${chunkKey}:h`, x, y, id } handed to
// ctx.add('haunt'). The tracker owns the per-key cooldowns; hauntEffects turns an id into the one-shot the game applies.
import { CHANNELS } from './channels.js'

const H = (o) => Object.freeze(o)
export const HAUNTS = Object.freeze([
  H({ id: 'standing-figure', minLevel: 1, radius: 6, cooldownS: 240, sanity: -5 }),
  H({ id: 'chairs-moved', minLevel: 0, radius: 4, cooldownS: 300, sanity: -2, needsProps: 'chair' }),
  H({ id: 'running-water', minLevel: 2, radius: 7, cooldownS: 200, sanity: -3 }),
  H({ id: 'knock-inside', minLevel: 3, radius: 3, cooldownS: 180, sanity: -4, needsProps: 'cabinet-e' }),
  H({ id: 'your-own-light', minLevel: 1, radius: 5, cooldownS: 260, sanity: -3 }),
])
const BY_ID = new Map(HAUNTS.map((h) => [h.id, h]))

const [GATE_A, GATE_B] = CHANNELS.haunts.gate
const [RNG_MX, RNG_AX, RNG_MY, RNG_AY] = CHANNELS.haunts.rng
const [PICK_A, PICK_B] = CHANNELS.haunts.pick

// decor.js's hash, verbatim: chooseHaunt is called from outside the pass too (tests, tools), so it cannot lean on ctx.hash
function hash(a, b, c = 0) {
  let h = (a * 2654435761 ^ b * 2246822519 ^ Math.imul(c, 3266489917)) >>> 0
  h ^= h >>> 16; h = Math.imul(h, 0x45d9f3b) >>> 0
  h ^= h >>> 16
  return h >>> 0
}

const FIGURE_MIN = 3.5           // the figure stands past vanishAt, five or six paces back
const FIGURE_TTL = 12            // and does not wait for you forever
const CHAIRS_R = 4
const EMPTY = []

// a prop of `type` within `r` of `at` (or anywhere in the list when there is no spot yet)
function hasProp(props, type, at, r) {
  if (!props) return false
  for (let i = 0; i < props.length; i++) {
    const p = props[i]
    if (p.type !== type) continue
    if (!at) return true
    const dx = p.x - at.x, dy = p.y - at.y
    if (dx * dx + dy * dy <= r * r) return true
  }
  return false
}

// chooseHaunt(cx, cy, seed, salt, levelIndex, propsInChunk, at = null) -> id | null: the pick hash over the ids eligible on this floor
// whose needsProps (if any) is satisfied by a prop of that type within radius in THIS chunk's freshly built prop list. `at` is the
// haunt's spot when known (the pass passes it); without one any prop of the type in the list counts. Null when nothing is eligible.
export function chooseHaunt(cx, cy, seed, salt, levelIndex, propsInChunk, at = null) {
  if (!Number.isInteger(levelIndex) || levelIndex < 0 || levelIndex > 3) return null
  const eligible = []
  for (let i = 0; i < HAUNTS.length; i++) {
    const h = HAUNTS[i]
    if (h.minLevel > levelIndex) continue
    if (h.needsProps && !hasProp(propsInChunk, h.needsProps, at, h.radius)) continue
    eligible.push(h)
  }
  if (!eligible.length) return null
  return eligible[hash(cx + PICK_A + (salt | 0), cy + PICK_B + (salt | 0), seed | 0) % eligible.length].id
}

// hauntsPass(cfg) -> pass | null: null when cfg.haunts?.denom is 0 / absent (Level ∅, a base config). One haunt at most per gated
// chunk, at an open cell from the haunts rng, its id from the pick hash over what the chunk's own props allow (ctx.props, when decor
// exposes it; without it only the prop-free ids are eligible).
export function hauntsPass(cfg) {
  const denom = cfg?.haunts?.denom | 0
  if (denom <= 0) return null
  const levelIndex = cfg.levelIndex
  return (ctx) => {
    const { cx, cy, salt, seed } = ctx
    if (ctx.hash(cx + GATE_A + salt, cy + GATE_B + salt, seed) % denom !== 0) return
    const rng = ctx.rngFrom(cx * RNG_MX + salt + RNG_AX, cy * RNG_MY + salt + RNG_AY, seed)
    const spot = ctx.openCell(rng)
    if (!spot) return
    const at = { x: spot.wx, y: spot.wy }
    const id = pick(ctx, levelIndex, at)
    if (!id) return
    ctx.add('haunt', { key: `${ctx.key}:h`, x: spot.wx, y: spot.wy, id })
  }
}
// the pass's pick goes through ctx.hash (the registry test pins the call), the same hash as chooseHaunt's
function pick(ctx, levelIndex, at) {
  if (!Number.isInteger(levelIndex) || levelIndex < 0 || levelIndex > 3) return null
  const props = ctx.props ?? EMPTY
  const eligible = []
  for (let i = 0; i < HAUNTS.length; i++) {
    const h = HAUNTS[i]
    if (h.minLevel > levelIndex) continue
    if (h.needsProps && !hasProp(props, h.needsProps, at, h.radius)) continue
    eligible.push(h)
  }
  if (!eligible.length) return null
  return eligible[ctx.hash(ctx.cx + PICK_A + ctx.salt, ctx.cy + PICK_B + ctx.salt, ctx.seed) % eligible.length].id
}

// createHauntTracker({ now }) -> { check(px, py, haunts, { calm }), fire(key) }: check returns the nearest haunt within its radius
// whose cooldown has elapsed, or null when calm is false (something real is close, or you are busy); fire(key) starts its cooldown.
// No allocation: the record itself comes back.
export function createHauntTracker({ now } = {}) {
  const clock = typeof now === 'function' ? now : () => 0
  const firedAt = new Map()
  function check(px, py, haunts, opts) {
    const calm = typeof opts === 'boolean' ? opts : !!(opts && opts.calm)
    if (!calm || !haunts) return null
    const t = clock()
    let best = null, bestD = Infinity
    for (let i = 0; i < haunts.length; i++) {
      const h = haunts[i]
      const spec = BY_ID.get(h.id)
      if (!spec) continue
      const dx = h.x - px, dy = h.y - py
      const d = dx * dx + dy * dy
      if (d > spec.radius * spec.radius || d >= bestD) continue
      const last = firedAt.get(h.key)
      if (last !== undefined && t - last < spec.cooldownS) continue
      best = h; bestD = d
    }
    return best
  }
  function fire(key) { firedAt.set(key, clock()) }
  return { check, fire }
}

// hauntEffects(id, ctx = { player, props, isOpen, trail }) -> null | { ephemera?, audio?, timerS?, shake?, moveProps?, flashlightOff?,
// message, sanity }. A null effect does not consume the cooldown (the game only fires the key on a non-null result).
//   standing-figure: a still 'shade' (never a watcher: a still figure is the building) on the farthest open trail cell behind you,
//                    FIGURE_MIN or more away; ttl FIGURE_TTL, vanishAt 3 (the ephemera loop drops it when you come within three).
//   chairs-moved:    every 'chair' within CHAIRS_R behind you turns by 1.0 rad in place, permanently (planProp hashes rot into the
//                    variant and the lean, so each becomes a different chair). moveProps lists the records ALREADY turned.
//   running-water:   footfall:8 kept up through a 12 s timer.   knock-inside: one doorSlam and a 0.2 shake.
//   your-own-light:  the flashlight off for 1.4 s (restored only if the L-toggle counter is unchanged).
export function hauntEffects(id, ctx = {}) {
  const spec = BY_ID.get(id)
  if (!spec) return null
  switch (id) {
    case 'standing-figure': {
      const at = figureSpot(ctx)
      if (!at) return null
      return {
        ephemera: { x: at.x, y: at.y, vx: 0, vy: 0, ttl: FIGURE_TTL, variant: 'shade', vanishAt: 3 },
        audio: 'whisper',
        message: 'someone is standing where you were. they do not move.',
        sanity: spec.sanity,
      }
    }
    case 'chairs-moved': {
      const p = ctx.player, props = ctx.props
      if (!p || !props) return null
      const fx = Math.cos(p.angle), fy = Math.sin(p.angle)
      const moved = []
      for (let i = 0; i < props.length; i++) {
        const c = props[i]
        if (c.type !== 'chair') continue
        const dx = c.x - p.x, dy = c.y - p.y
        if (dx * dx + dy * dy > CHAIRS_R * CHAIRS_R || fx * dx + fy * dy >= 0) continue
        c.rot = (c.rot || 0) + 1.0
        moved.push(c)
      }
      if (!moved.length) return null
      return { moveProps: moved, message: 'the chairs have been moved. nobody moved them.', sanity: spec.sanity }
    }
    case 'running-water':
      return { audio: 'footfall:8', timerS: 12, message: 'running water. do not follow it.', sanity: spec.sanity }
    case 'knock-inside':
      return { audio: 'doorSlam', shake: 0.2, message: 'something knocks, once, from inside the cabinet.', sanity: spec.sanity }
    case 'your-own-light':
      return { flashlightOff: 1.4, message: 'your light goes out. it was not the battery.', sanity: spec.sanity }
    default:
      return null
  }
}

// the farthest trail cell (fog.lastTrail: newest first) that is open, behind the player and at least FIGURE_MIN away, or null
function figureSpot({ player, isOpen, trail }) {
  if (!player || !trail) return null
  const fx = Math.cos(player.angle), fy = Math.sin(player.angle)
  for (let i = trail.length - 1; i >= 0; i--) {
    const t = trail[i]
    const dx = t.x - player.x, dy = t.y - player.y
    if (dx * dx + dy * dy < FIGURE_MIN * FIGURE_MIN) continue             // too close: it would vanish at once
    if (fx * dx + fy * dy >= 0) continue
    if (isOpen && !isOpen(t.x, t.y)) continue
    return t
  }
  return null
}
