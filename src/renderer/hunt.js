// hunt.js — how the things find you, and what they do about it. Pure: no DOM, no audio, no strings.
//
// Perception travels the maze: a noise is one bounded BFS flood over the floor (loudness falls with path length, never
// through walls) that every nearby creature reads at its own cell; sight is line of sight on a per-frame budget. The
// shared machine is roam / alert / investigate / hunt / search, plus the one stagger spec (flee, then the 'turning'
// opening) that every ward and flash goes through. The variants (variants.js) intercept it per creature. moveToward /
// moveAway are the obstacle layer: a creature steps around furniture by probing headings, never by steering on cells.
//
// entities.js owns the list, the spawns and the ward; it calls stepAI(e, dt, ctx, spec, env, threat) for every gated
// creature and separate(gated, env) after. `env` is ONE object entities.js mutates per frame:
//   { dt, now, pcx, pcy, player, ctx, isWall(ix, iy), floor(ix, iy), obstacles | null, field, losBudget, damage,
//     helpers (made here, once), threat }
// Nothing here allocates per frame: the helpers object, the event pool and the noise field are made once.
import { lineOfSight } from './raycaster.js'
import { creatureRadius } from './collide.js'
import { specFor, stepVariant, sightRange, CRAWLER_DMG } from './variants.js'
import { entityPhase } from './gfx-sprites.js'
import { moveEntity } from './entities.js'

export { lineOfSight }

export const DISPEL_S = 240            // a dispelled chunk stays empty this long
export const TURNING_S = 0.8           // the opening after a stagger's flee

const TAU = Math.PI * 2
const CONTACT = 0.62                   // > max creatureRadius + PLAYER_R
const SIGHT_SKIP = 34                  // beyond this nothing is even considered
const NEAR_SIGHT = 2.0                 // within this no line is needed
const PERC_ROAM = 0.35, PERC_HUNT = 0.15
const NOISE_LIVE = 0.45
const NOISE_W = 31, NOISE_R = 15, NOISE_CELLS = NOISE_W * NOISE_W, NOISE_POPS = 160
const ALERT_S = 0.9, FLINCH_S = 0.25
const INVEST_MAX = 10, ARRIVE = 0.8
const SEARCH_MAX = 14, DWELL = 1.2, NO_PROGRESS = 4, WAYPOINTS = 3
const HOLD_AFTER = 1.5, HOLD_S = 1.0
const BLOCKED_TURN = 0.4
const FLEE_SPEED = 1.8, RETREAT_SPEED = 2.0
const PROBE = 0.35
const OFFS = [0.6, -0.6, 1.2, -1.2, 1.9, -1.9]
const DX4 = [1, -1, 0, 0], DY4 = [0, 0, 1, -1]
// the hunting phases: threat.hunted here, and what entities.snapshotChasers counts as on your heels
export const HUNTING = new Set(['hunt', 'freeze', 'windup', 'lunge', 'recover', 'arcCharge'])

function hash3(a, b, c) {
  let h = (Math.imul(a | 0, 374761393) + Math.imul(b | 0, 668265263) + Math.imul(c | 0, 2246822519)) | 0
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return (h ^ (h >>> 16)) >>> 0
}

// ── the record every creature carries on this path ──────────────────────────────────────────────────────────────────
// makeEntity seeds the first block; an injected test entity gets everything here, once.
function initFields(e) {
  if (e.searchK !== undefined) return
  e.ai ??= 'roam'; e.stagger ??= 0; e.pending ??= 0; e.wardHits ??= 0; e.dirTimer ??= 0; e.dir ??= 0
  e.percT ??= 0; e.lostT ??= 0; e.huntT ??= 0; e.searchT ??= 0; e.blockedT ??= 0; e.holdT ??= 0; e.burstT ??= 0
  e.steer ??= 1; e.steerT ??= 0; e.staggerBlockedT ??= 0
  e.lastSeenX ??= null; e.lastSeenY ??= null; e.tx ??= null; e.ty ??= null; e.searchN ??= 0
  e.seen = false; e.los = false; e.fresh = false; e.heardId = 0; e.noiseL = 0
  e.turnT = 0; e.turnBurst = false; e.investT = 0
  e.searchK = -1; e.dwellT = 0; e.progT = 0; e.bestD = Infinity
}

// ── what the renderer and the collider read ─────────────────────────────────────────────────────────────────────────
// Every phase maps into gfx-sprites STATES; no new frames. A reeling thing shows the stagger pose whatever it was doing,
// alert is a flinch (stagger) for its first quarter second, the boxed-in hold reads as idle (the lost-you beat).
export function deriveState(e) {
  let s
  if (e.stagger > 0 || e.ai === 'stagger') s = 'stagger'
  else if (e.ai === 'hunt' || e.ai === 'lunge') s = e.holdT > 0 ? 'idle' : 'chase'
  else if (e.ai === 'retreat') s = 'flee'
  else if (e.ai === 'alert') s = ALERT_S - e.holdT < FLINCH_S ? 'stagger' : 'idle'
  else s = 'idle'
  e.state = s
  return s
}

export function hostile(e) {
  return specFor(e.variant).hostilePhases.has(e.ai) && !(e.stagger > 0) && !(e.pending > 0)
}

// The one creature-solidity rule (collide.movePlayer takes it as solidFn): reeling, turning and still-arriving things
// are soft, the watcher is never a body, a crawler lying still is walked over.
export function solidCreature(e) {
  return !(e.pending > 0) && !(e.stagger > 0) && e.ai !== 'turning' && e.variant !== 'watcher' && !(e.variant === 'crawler' && e.ai === 'still')
}

// ── hearing: one bounded flood per new noise ────────────────────────────────────────────────────────────────────────
// A 31x31 window around the noise cell; a 4-connected BFS over open cells pops at most 160 of them. loudness(cell) =
// L / (1 + pathLen / 4): a walk (3) carries 8 path cells, a sprint (7) 24, a ward (12) 44. Everything is reused: the
// Int16 queue, the Uint16 generation stamps (a cell belongs to the flood whose stamp it carries) and the Float32 field.
export function createNoiseField() {
  return {
    lo: new Float32Array(NOISE_CELLS), gen: new Uint16Array(NOISE_CELLS), q: new Int16Array(NOISE_CELLS), pl: new Uint8Array(NOISE_CELLS),
    stamp: 0, ox: 0, oy: 0, x: 0, y: 0, L: 0, t: -Infinity, id: 0, popped: 0,
  }
}

export function floodNoise(field, noise, floorFn) {
  const cx = Math.floor(noise.x), cy = Math.floor(noise.y)
  field.ox = cx - NOISE_R; field.oy = cy - NOISE_R
  field.x = noise.x; field.y = noise.y; field.L = noise.L; field.t = noise.t
  field.id++
  if (field.stamp === 65535) { field.gen.fill(0); field.stamp = 0 }
  const stamp = ++field.stamp
  const { lo, gen, q, pl } = field
  const L = noise.L
  let head = 0, tail = 0, popped = 0
  const start = NOISE_R * NOISE_W + NOISE_R
  gen[start] = stamp; pl[start] = 0; lo[start] = L
  q[tail++] = start
  while (head < tail && popped < NOISE_POPS) {
    const i = q[head++]
    popped++
    const lx = i % NOISE_W, ly = (i - lx) / NOISE_W
    const p = pl[i] + 1
    const v = L / (1 + p / 4)
    // four neighbours, inside the window, open, not yet in this flood
    for (let k = 0; k < 4; k++) {
      const jx = lx + DX4[k], jy = ly + DY4[k]
      if (jx < 0 || jy < 0 || jx >= NOISE_W || jy >= NOISE_W) continue
      const j = jy * NOISE_W + jx
      if (gen[j] === stamp) continue
      if (!floorFn(field.ox + jx, field.oy + jy)) continue
      gen[j] = stamp; pl[j] = p; lo[j] = v
      q[tail++] = j
    }
  }
  field.popped = popped
  return popped
}

export function loudnessAt(field, ix, iy) {
  const lx = ix - field.ox, ly = iy - field.oy
  if (lx < 0 || ly < 0 || lx >= NOISE_W || ly >= NOISE_W) return 0
  const i = ly * NOISE_W + lx
  return field.gen[i] === field.stamp ? field.lo[i] : 0
}

// ── sight ───────────────────────────────────────────────────────────────────────────────────────────────────────────
// sight = spec.sight (x1.5 for a tesla hearing your radio) halved in the dark, +3 in the dark when your flashlight is
// on; the hound and the crawler ignore the dark. Within 2 u no line is needed.
function rangeFor(e, spec, ctx) {
  let r = sightRange(spec, ctx)
  if (ctx.dark && e.variant !== 'hound' && e.variant !== 'crawler') { r *= 0.5; if (ctx.flashlight) r += 3 }
  return r
}

export function sees(e, player, ctx, spec, floorFn) {
  const dx = player.x - e.x, dy = player.y - e.y
  const d = Math.sqrt(dx * dx + dy * dy)
  if (d > SIGHT_SKIP || d > rangeFor(e, spec, ctx)) return false
  if (d <= NEAR_SIGHT) return true
  return lineOfSight(e.x, e.y, player.x, player.y, floorFn)
}

// the budgeted tick: a creature past its interval walks one line (if the frame has budget left) or keeps its verdict
// and tries again next frame. The verdict covers the whole fog reach so the variants' watched() has a line to read.
function perceive(e, d, spec, ctx, env) {
  e.percT -= env.dt
  if (e.percT > 0) return
  const p = env.player
  let los
  if (d > SIGHT_SKIP) los = false
  else if (d <= NEAR_SIGHT) los = true
  else if (d > Math.max(rangeFor(e, spec, ctx), ctx.fog || 0)) los = false
  else if (env.losBudget > 0) { env.losBudget--; los = lineOfSight(e.x, e.y, p.x, p.y, env.floor) }
  else return                                                 // skipped: keep the old verdict, retry next frame
  e.los = los
  e.seen = los && d <= rangeFor(e, spec, ctx)
  e.fresh = true
  const base = HUNTING.has(e.ai) ? PERC_HUNT : PERC_ROAM        // every hunting phase, or a tesla's arc lands through a wall
  e.percT = base * (0.85 + 0.3 * entityPhase(e))             // the phase offsets the cadence so a brood drifts apart
}

// ── the helpers the variants call (one object per env) ──────────────────────────────────────────────────────────────
function makeHelpers(env) {
  return {
    moveToward: (e, x, y, speed) => moveToward(e, x, y, speed, env),
    moveAway: (e, x, y, speed) => moveAway(e, x, y, speed, env),
    // the player's line is the budgeted verdict; anything else is walked now
    los: (e, x, y) => (env.player && x === env.player.x && y === env.player.y) ? e.los === true : lineOfSight(e.x, e.y, x, y, env.floor),
    dist: (e, x, y) => { const dx = e.x - x, dy = e.y - y; return Math.sqrt(dx * dx + dy * dy) },
    hashT: (e, salt) => hash3(e.id | 0, salt | 0, 0x9e37) / 4294967296,
    event: (kind, e, extra) => env.threat.emit(kind, e, extra),
  }
}

// ── the threat record ───────────────────────────────────────────────────────────────────────────────────────────────
// One per entity system, returned from every update. Events are pooled (32) and live until the next drain: begin()
// drops last frame's but keeps anything emitted between frames (a ward's dispel), reset() clears everything.
export function createThreat() {
  const pool = []
  for (let i = 0; i < 32; i++) pool.push({ kind: '', id: 0, x: 0, y: 0, d: 0 })
  let pi = 0
  const t = {
    hunted: false, nearest: Infinity, nearestEntity: null, gaze: false, gazeRate: 0, dmg: 0, dmgKind: null, arcPending: false,
    events: [], mark: 0,
    begin() {
      t.hunted = false; t.nearest = Infinity; t.nearestEntity = null; t.gaze = false; t.gazeRate = 0; t.dmg = 0; t.dmgKind = null; t.arcPending = false
      if (t.mark > 0) {
        const ev = t.events, keep = ev.length - t.mark
        for (let i = 0; i < keep; i++) ev[i] = ev[t.mark + i]
        ev.length = keep > 0 ? keep : 0
        t.mark = 0
      }
    },
    end() { t.mark = t.events.length },
    reset() { t.begin(); t.events.length = 0; t.mark = 0 },
    emit(kind, e, d) {
      if (t.events.length >= 32) return null
      const ev = pool[pi]; pi = (pi + 1) & 31
      ev.kind = kind; ev.id = e.id | 0; ev.x = e.x; ev.y = e.y; ev.d = d || 0
      t.events.push(ev)
      return ev
    },
  }
  return t
}

// ── the obstacle layer ──────────────────────────────────────────────────────────────────────────────────────────────
function rObst(e, env) {
  const o = env.obstacles
  return Math.min(o && typeof o.radiusFor === 'function' ? o.radiusFor(e.variant) : creatureRadius(e.variant), 0.22)
}
// one probe 0.35 u ahead along `ang`, against walls and bodies; plus the step itself, so a clear heading is one the
// creature can actually take this frame
function clearHeading(e, ang, speed, env, r) {
  const c = Math.cos(ang), s = Math.sin(ang)
  const px = e.x + c * PROBE, py = e.y + s * PROBE
  if (env.isWall(Math.floor(px), Math.floor(py), env.pcx, env.pcy)) return false
  const o = env.obstacles
  if (o === null || o === undefined) return true
  if (o.blocked(px, py, r)) return false
  const sx = e.x + c * speed * env.dt, sy = e.y + s * speed * env.dt
  return !o.blocked(sx, sy, r)
}
// one obstacle-aware step along e.dir. moveEntity tests each leg against the other leg's ORIGINAL coordinate (the
// legacy slide), so a diagonal step can cut a convex corner into a wall cell; here the y leg is dropped when it does.
function step(e, speed, env, r) {
  const ox = e.x, oy = e.y
  let blocked = moveEntity(e, speed, env.dt, env.isWall, env.pcx, env.pcy, env.obstacles, r)
  if (e.x !== ox && e.y !== oy && env.isWall(Math.floor(e.x), Math.floor(e.y), env.pcx, env.pcy)) { e.y = oy; blocked = true }
  return blocked
}
// the fresh LCG heading the roam wander uses (entities.js:129-130, verbatim)
function lcgHeading(e) {
  e.dir = ((e.dir + 1.3 + (e.x * 7 + e.y * 13) % 2.0)) % TAU
  e.dirTimer = 3 + ((Math.abs(e.x * 17 + e.y * 31) % 4))
}
// steer toward a heading: the direct step, else the first clear probe (+s 0.6, -s 0.6, +s 1.2, ... , back), s keeping
// its sign 0.8 s. None clear -> blockedT; past 1.5 s the hold (idle speed on an LCG heading, no re-aim) for 1.0 s.
function steer(e, want, speed, env) {
  initFields(e)
  const r = rObst(e, env)
  const ox = e.x, oy = e.y
  e.dir = want
  if (!step(e, speed, env, r)) { e.blockedT = 0; return false }
  e.x = ox; e.y = oy
  if (e.steerT > 0) e.steerT -= env.dt
  const s = e.steer < 0 ? -1 : 1
  for (let i = 0; i < 7; i++) {
    const ang = i < 6 ? want + s * OFFS[i] : want + Math.PI
    if (!clearHeading(e, ang, speed, env, r)) continue
    if (i < 6 && e.steerT <= 0) { e.steer = OFFS[i] > 0 ? s : -s; e.steerT = 0.8 }
    e.dir = ang
    step(e, speed, env, r)
    e.dir = ang                                               // a partial slide must not leave the facing rotated
    e.blockedT = 0
    return false
  }
  e.dir = want
  e.blockedT += env.dt
  if (e.blockedT > HOLD_AFTER) { e.blockedT = 0; e.holdT = HOLD_S; lcgHeading(e) }
  return true
}

export function moveToward(e, tx, ty, speed, env) {
  return steer(e, Math.atan2(ty - e.y, tx - e.x), speed, env)
}

export function moveAway(e, x, y, speed, env) {
  return steer(e, Math.atan2(e.y - y, e.x - x), speed, env)
}

// the roam wander (entities.js:126-131 verbatim) through the obstacle-aware step
function wander(e, speed, env) {
  e.dirTimer -= env.dt
  if (e.dirTimer <= 0) lcgHeading(e)
  return step(e, speed, env, rObst(e, env))
}

// ── separation: two hounds are two hounds ───────────────────────────────────────────────────────────────────────────
// For every overlapping pair (d < ri + rj) push apart along the pair normal: a staggered one takes the whole overlap,
// otherwise half each; an axis that would enter a wall is reverted. Entities never separate from the player.
function nudge(e, mx, my, env) {
  const nx = e.x + mx, ny = e.y + my
  if (!env.isWall(Math.floor(nx), Math.floor(e.y), env.pcx, env.pcy)) e.x = nx
  if (!env.isWall(Math.floor(e.x), Math.floor(ny), env.pcx, env.pcy)) e.y = ny
}
export function separate(entities, env) {
  const n = entities.length
  for (let i = 0; i < n; i++) {
    const a = entities[i], ra = creatureRadius(a.variant)
    for (let j = i + 1; j < n; j++) {
      const b = entities[j]
      const dx = b.x - a.x, dy = b.y - a.y
      const R = ra + creatureRadius(b.variant)
      const d2 = dx * dx + dy * dy
      if (d2 >= R * R) continue
      let nx, ny
      const d = Math.sqrt(d2)
      if (d < 1e-6) { const ang = ((a.id | 0) + (b.id | 0)) * 2.399; nx = Math.cos(ang); ny = Math.sin(ang) } else { nx = dx / d; ny = dy / d }
      const over = R - d + 1e-4
      const aReels = a.stagger > 0, bReels = b.stagger > 0
      const fa = aReels && !bReels ? 1 : bReels && !aReels ? 0 : 0.5
      if (fa > 0) nudge(a, -nx * over * fa, -ny * over * fa, env)
      if (fa < 1) nudge(b, nx * over * (1 - fa), ny * over * (1 - fa), env)
    }
  }
}

// ── the machine ─────────────────────────────────────────────────────────────────────────────────────────────────────
function enterHunt(e, d, threat, p) {
  if (e.ai !== 'hunt') { threat.emit('seen', e, d); e.huntT = 0 }
  e.ai = 'hunt'; e.lostT = 0; e.blockedT = 0; e.holdT = 0
  e.lastSeenX = p.x; e.lastSeenY = p.y
}
function enterSearch(e, x, y) {
  e.ai = 'search'; e.lastSeenX = x; e.lastSeenY = y; e.tx = x; e.ty = y
  e.searchT = 0; e.searchK = -1; e.dwellT = 0; e.progT = 0; e.bestD = Infinity; e.blockedT = 0; e.holdT = 0
}
function enterRoam(e) {
  e.ai = 'roam'; e.searchN++; e.dirTimer = 0; e.holdT = 0; e.blockedT = 0
}
function enterTurning(e, burst) {
  e.stagger = 0; e.staggerBlockedT = 0; e.ai = 'turning'; e.turnT = TURNING_S; e.turnBurst = burst
}
// the next search waypoint: radius 2.5-4.0 at an angle hashed from the spawn chunk and the search count
function nextWaypoint(e) {
  e.searchK++
  const h = hash3(e.chunkCx | 0, e.chunkCy | 0, e.searchN + e.searchK)
  const ang = (h / 4294967296) * TAU
  const rad = 2.5 + 1.5 * (((h >>> 8) & 1023) / 1023)
  e.tx = e.lastSeenX + Math.cos(ang) * rad; e.ty = e.lastSeenY + Math.sin(ang) * rad
  e.progT = 0; e.bestD = Infinity
}
function onHeard(e, f, d, threat) {
  const tx = Math.floor(f.x) + 0.5, ty = Math.floor(f.y) + 0.5
  if (e.ai === 'roam' || e.ai === 'search') {
    e.ai = 'alert'; e.holdT = ALERT_S; e.tx = tx; e.ty = ty; e.noiseL = f.L
    e.dir = Math.atan2(ty - e.y, tx - e.x)
    threat.emit('alert', e, d)
  } else if ((e.ai === 'alert' || e.ai === 'investigate') && f.L > e.noiseL) {
    e.tx = tx; e.ty = ty; e.noiseL = f.L
    if (e.ai === 'alert') e.dir = Math.atan2(ty - e.y, tx - e.x)
  }
}
function contact(e, d, spec, env, threat) {
  if (d < CONTACT && spec.hostilePhases.has(e.ai) && !(e.stagger > 0) && !(e.pending > 0)) {
    const dmg = e.variant === 'crawler' ? CRAWLER_DMG : env.damage
    if (dmg > threat.dmg) { threat.dmg = dmg; threat.dmgKind = 'contact' }
  }
  if (HUNTING.has(e.ai) && !(e.stagger > 0)) threat.hunted = true
}

export function stepAI(e, dt, ctx, spec, env, threat) {
  initFields(e)
  env.dt = dt; env.threat = threat
  const H = env.helpers || (env.helpers = makeHelpers(env))
  const p = env.player
  const dx = p.x - e.x, dy = p.y - e.y
  const d = Math.sqrt(dx * dx + dy * dy)
  if (spec.hostilePhases.size > 0 && !(e.stagger > 0) && d < threat.nearest) { threat.nearest = d; threat.nearestEntity = e }

  // hearing: every live flood not yet heard (ids rise with each noise), read once each at this creature's cell; the
  // loudest audible one is reacted to, and everything audible up to the newest counts as heard
  const fs = env.fields
  if (fs) {
    const ix = Math.floor(e.x), iy = Math.floor(e.y)
    let best = null, bestL = 0, top = e.heardId
    for (let k = 0; k < fs.length; k++) {
      const f = fs[k]
      if (!(f.id > e.heardId) || env.now - f.t > NOISE_LIVE) continue
      const l = loudnessAt(f, ix, iy)
      if (l * spec.hearK < 1) continue
      if (f.id > top) top = f.id
      if (l > bestL) { bestL = l; best = f }
    }
    if (best) { e.heardId = top; onHeard(e, best, d, threat) }
  }
  e.fresh = false
  perceive(e, d, spec, ctx, env)

  // the one stagger spec: flee for staggerT - 0.8 s (early into turning when the flee is blocked > 0.4 s), then the
  // turning opening for 0.8 s, which ends in search (or bursts into hunt after a blocked flee)
  if (e.stagger > 0 && e.ai !== 'retreat') {
    e.stagger -= dt
    e.dir = Math.atan2(-dy, -dx)
    if (step(e, FLEE_SPEED, env, rObst(e, env))) e.staggerBlockedT += dt
    if (e.staggerBlockedT > BLOCKED_TURN) enterTurning(e, true)
    else if (e.stagger <= TURNING_S) { enterTurning(e, false); threat.emit('turning', e, d) }
    else e.ai = 'stagger'
    contact(e, d, spec, env, threat)
    return deriveState(e)
  }
  if (e.ai === 'stagger') enterTurning(e, false)             // a reel that ran out without a frame of flee
  if (e.ai === 'turning') {
    e.turnT -= dt
    if (e.turnT <= 0) {
      if (e.turnBurst) { e.ai = 'hunt'; e.burstT = 1.0; e.lostT = 0; e.huntT = 0; e.lastSeenX = p.x; e.lastSeenY = p.y; threat.emit('turn', e, d) }
      else enterSearch(e, p.x, p.y)
    }
    contact(e, d, spec, env, threat)
    return deriveState(e)
  }
  // the lost-you beat: boxed in, it stands on an LCG heading at idle speed and does not re-aim
  if (e.holdT > 0 && e.ai !== 'alert') {
    e.holdT -= dt
    wander(e, spec.roam, env)
    contact(e, d, spec, env, threat)
    return deriveState(e)
  }

  // the variant owns the frame when it says so (freeze, windup, lunge, shadow, still, arcCharge, its own retreat)
  if (!stepVariant(e, dt, ctx, H, threat)) {
    switch (e.ai) {
      case 'alert':
        e.holdT -= dt
        if (e.seen) enterHunt(e, d, threat, p)
        else if (e.holdT <= 0) { e.holdT = 0; e.ai = 'investigate'; e.investT = 0; e.blockedT = 0 }
        break
      case 'investigate': {
        if (e.seen) { enterHunt(e, d, threat, p); break }
        e.investT += dt
        moveToward(e, e.tx, e.ty, spec.hunt * 0.6, env)
        const ax = e.tx - e.x, ay = e.ty - e.y
        if (ax * ax + ay * ay < ARRIVE * ARRIVE || e.investT > INVEST_MAX) enterSearch(e, e.tx, e.ty)
        break
      }
      case 'hunt': {
        if (e.seen) { if (e.fresh) { e.lastSeenX = p.x; e.lastSeenY = p.y } e.lostT = 0 } else e.lostT += dt
        e.huntT += dt
        if (e.burstT > 0) e.burstT -= dt
        moveToward(e, e.lastSeenX, e.lastSeenY, spec.hunt * (e.burstT > 0 ? 1.33 : 1), env)
        if (e.lostT > spec.loseTrack) { if (e.huntT >= 4) threat.emit('lost', e, d); enterSearch(e, e.lastSeenX, e.lastSeenY) }
        break
      }
      case 'search': {
        if (e.seen) { enterHunt(e, d, threat, p); break }
        e.searchT += dt
        if (e.searchT > SEARCH_MAX) { enterRoam(e); break }
        if (e.dwellT > 0) {                                   // standing at a point, looking
          e.dwellT -= dt
          if (e.dwellT <= 0) { e.dwellT = 0; if (e.searchK >= WAYPOINTS - 1) enterRoam(e); else nextWaypoint(e) }
          break
        }
        const sx = e.tx - e.x, sy = e.ty - e.y
        const sd = Math.sqrt(sx * sx + sy * sy)
        if (sd < e.bestD - 0.05) { e.bestD = sd; e.progT = 0 } else e.progT += dt
        if (sd < ARRIVE || e.progT > NO_PROGRESS) e.dwellT = DWELL
        else moveToward(e, e.tx, e.ty, spec.hunt * 0.6, env)
        break
      }
      case 'retreat':                                         // the flash's retreat for a variant without its own
        e.phaseT = (e.phaseT || 0) + dt
        if (e.stagger > 0) e.stagger = Math.max(0, e.stagger - dt)
        moveAway(e, p.x, p.y, RETREAT_SPEED, env)
        if (e.phaseT >= 3) enterSearch(e, p.x, p.y)
        break
      default:                                                // roam, and any variant phase the variant let go of
        wander(e, spec.roam, env)
        if (e.seen) enterHunt(e, d, threat, p)
    }
  }
  contact(e, d, spec, env, threat)
  return deriveState(e)
}
