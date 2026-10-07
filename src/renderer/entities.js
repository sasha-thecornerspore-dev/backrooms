import { CHUNK_SIZE } from './world.js'
import { specFor } from './variants.js'
import { stepAI, separate, createThreat, createNoiseField, floodNoise, lineOfSight, DISPEL_S, HUNTING } from './hunt.js'
import { creatureRadius } from './collide.js'

const MAX_ENTITIES = 20
const DISPEL_MAX = 64          // dispelledUntil entries kept (oldest dropped)
const NOISE_SLOTS = 8
const GATE_CHUNKS = 3          // Chebyshev chunk distance within which the hunt path runs in full
const LOS_BUDGET = 6           // line-of-sight walks per frame
const EMPTY_OPTS = {}

function hash(a, b) {
  let h = (a * 2654435761 ^ b * 2246822519) >>> 0
  h ^= h >>> 16; h = Math.imul(h, 0x45d9f3b) >>> 0
  h ^= h >>> 16
  return h
}

function entityRng(cx, cy) {
  let s = hash(cx, cy) | 1
  return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 0xffffffff }
}

function shouldSpawn(cx, cy, spawnDenom) {
  return hash(cx + 1000, cy + 2000) % spawnDenom === 0
}

// Advance one entity along e.dir at `speed`, sliding along walls (turn 90° on a
// blocked axis). Shared by the normal AI and the ward-stagger flee. Returns true when
// either axis was refused. With `obstacles` (collide.forEntities) a step that lands
// inside a body is refused too — unless the creature already stands inside one, which
// may always step (it has to be able to leave).
export function moveEntity(e, speed, dt, isWallFn, playerCx, playerCy, obstacles = null, rObst = 0) {
  const nx = e.x + Math.cos(e.dir) * speed * dt
  const ny = e.y + Math.sin(e.dir) * speed * dt
  const origX = e.x, origY = e.y
  let canX = !isWallFn(Math.floor(nx), Math.floor(origY), playerCx, playerCy)
  let canY = !isWallFn(Math.floor(origX), Math.floor(ny), playerCx, playerCy)
  if (obstacles !== null && (canX || canY) && (nx !== origX || ny !== origY)
      && obstacles.blocked(canX ? nx : origX, canY ? ny : origY, rObst) && !obstacles.blocked(origX, origY, rObst)) {
    canX = false; canY = false
  }
  if (canX) e.x = nx; else e.dir += Math.PI * 0.5
  if (canY) e.y = ny; else e.dir -= Math.PI * 0.5
  return !canX || !canY
}

let NEXT_ID = 1
// the hunt-path record (hunt.js lazily completes it with its own working fields)
function huntShape(e) {
  e.id = NEXT_ID++
  e.ai = 'roam'; e.percT = 0; e.lostT = 0; e.huntT = 0; e.searchT = 0; e.blockedT = 0; e.holdT = 0; e.burstT = 0
  e.steer = 1; e.steerT = 0; e.staggerBlockedT = 0
  e.lastSeenX = null; e.lastSeenY = null; e.tx = null; e.ty = null; e.searchN = 0; e.pending = 0
  return e
}

function makeEntity(cx, cy, stalkerDenom, variants) {
  const rng = entityRng(cx, cy)
  const type = rng() < 1 / stalkerDenom ? 'stalker' : 'wanderer'
  const list = (variants && variants[type] && variants[type].length) ? variants[type] : ['shade']
  const variant = list[(rng() * list.length) | 0]
  return huntShape({
    x: cx * CHUNK_SIZE + CHUNK_SIZE / 2 + (rng() - 0.5) * 4,
    y: cy * CHUNK_SIZE + CHUNK_SIZE / 2 + (rng() - 0.5) * 4,
    type,
    variant,
    state: 'idle',
    dir: rng() * Math.PI * 2,
    dirTimer: 3 + rng() * 4,
    stagger: 0,     // seconds left reeling from a ward — cannot chase or strike
    wardHits: 0,    // wards it has absorbed; enough of them and it comes apart
    chunkCx: cx,
    chunkCy: cy,
  })
}

// createEntitySystem(config, isWallFn, deps = null)
//   deps = { obstacles: collide.forEntities | null, grid: { floor(ix, iy), setPlayerChunk } | null, now: () => seconds }
//   update(dt, player, pcx, pcy, ctxOrAggroMul) -> threat: a number or undefined fifth argument runs the legacy step
//   verbatim (obstacles never consulted); an object (game.js's aiCtx) runs the hunt path (hunt.stepAI).
export function createEntitySystem(config, isWallFn, deps = null) {
  const entities = []
  const pendingList = []         // injected followers still arriving (not in getEntities())
  const gated = []               // this frame's near entities, for separation
  const spawnedChunks = new Set()
  const dispelledUntil = new Map()   // "cx,cy" -> clock second it may spawn again
  const obstacles = deps?.obstacles ?? null
  const grid = deps?.grid ?? null
  let tSum = 0
  const clock = deps?.now ?? (() => tSum)

  // Per-level rules. Defaults match the historic single-level behaviour so
  // any caller without an `entities` block (e.g. unit tests) keeps spawning.
  const ent         = config?.entities ?? {}
  const enabled     = ent.enabled ?? true
  const spawnDenom  = Math.max(1, ent.spawnDenom ?? 8)
  const stalkerDenom = Math.max(1, ent.stalkerDenom ?? 4)
  const chaseRange  = ent.chaseRange ?? 24
  const fleeRange   = ent.fleeRange ?? 6
  const damage      = ent.damage ?? 16
  const variants    = { stalker: ent.stalkerVariants || ['shade'], wanderer: ent.wandererVariants || ['shade'] }

  const threat = createThreat()
  // one flood per ring slot: several noises in one frame (a ward, a bump, the lures, a footstep) are all heard
  const ring = [], fields = []
  for (let i = 0; i < NOISE_SLOTS; i++) { ring.push({ x: 0, y: 0, L: 0, t: 0, who: 'player' }); fields.push(createNoiseField()) }
  let ringN = 0, woke = 0, huntMode = false, rr = 0
  // the hunt path reads cells through the grid reader (no key string per ask); without one, isWallFn at the cell centre
  const env = { dt: 0, now: 0, pcx: 0, pcy: 0, player: null, ctx: null, isWall: null, floor: null, obstacles, fields, losBudget: LOS_BUDGET, damage, helpers: null, threat }
  env.floor = grid ? (ix, iy) => grid.floor(ix, iy) : (ix, iy) => !isWallFn(ix + 0.5, iy + 0.5, env.pcx, env.pcy)
  env.isWall = (ix, iy) => !env.floor(ix, iy)

  function evict(playerCx, playerCy) {
    const radius = (config?.chunkEvictRadius ?? 3) + 2
    for (let i = entities.length - 1; i >= 0; i--) {
      const e = entities[i]
      if (Math.abs(e.chunkCx - playerCx) > radius || Math.abs(e.chunkCy - playerCy) > radius) {
        spawnedChunks.delete(`${e.chunkCx},${e.chunkCy}`)
        entities.splice(i, 1)
      }
    }
  }

  function trySpawnAround(playerCx, playerCy) {
    if (!enabled) return
    const r = config?.chunkEvictRadius ?? 3
    const now = clock()
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        if (entities.length + pendingList.length >= MAX_ENTITIES) return
        const cx = playerCx + dx, cy = playerCy + dy
        const key = `${cx},${cy}`
        if (spawnedChunks.has(key)) continue
        // the dispel sticks: a chunk whose presence came apart stays empty until its clock runs out
        const until = dispelledUntil.get(key)
        if (until !== undefined && now < until) continue
        spawnedChunks.add(key)
        if (shouldSpawn(cx, cy, spawnDenom)) {
          const e = settleSpawn(makeEntity(cx, cy, stalkerDenom, variants))
          if (e !== null) entities.push(e)
        }
      }
    }
  }

  // A chunk spawn must stand on open floor: makeEntity lands within 2 u of the hall crossing, which is mostly maze wall, and a
  // creature inside a wall cell never frees itself (moveEntity refuses both legs, every steer probe lands in the same cell) yet
  // still sees out of it and hunts. The mid column is the main hall, open at every epoch (world.js), so a wall-bound spawn moves
  // onto it at its own y; a body on that hall cell slides it along the hall, and a hall with no room is skipped. The rng draws
  // happen in makeEntity, untouched, so nothing else about the spawn changes. Returns the entity, or null to skip.
  function settleSpawn(e) {
    const hallX = e.chunkCx * CHUNK_SIZE + (CHUNK_SIZE >> 1) + 0.5
    if (!env.floor(Math.floor(e.x), Math.floor(e.y))) e.x = hallX
    if (!env.floor(Math.floor(e.x), Math.floor(e.y))) return null      // a fixed map: no hall to fall back on
    if (obstacles === null) return e
    const r = creatureRadius(e.variant)
    if (!obstacles.blocked(e.x, e.y, r)) return e
    const y0 = Math.floor(e.y) + 0.5
    for (let k = 1; k <= 4; k++) {
      for (let s = -1; s <= 1; s += 2) {
        const y = y0 + s * k
        if (Math.floor(y / CHUNK_SIZE) !== e.chunkCy) continue
        if (env.floor(Math.floor(hallX), Math.floor(y)) && !obstacles.blocked(hallX, y, r)) { e.x = hallX; e.y = y; return e }
      }
    }
    return null
  }

  function stepEntity(e, dt, player, isWallFn, playerCx, playerCy, aggroMul = 1) {
    const dx = player.x - e.x
    const dy = player.y - e.y
    const dist = Math.sqrt(dx * dx + dy * dy)

    // reeling from a ward — driven away from the player, blind to the hunt, and
    // (in game.js) unable to deal contact damage until it recovers.
    if (e.stagger > 0) {
      e.stagger = Math.max(0, e.stagger - dt)
      e.state = 'stagger'
      e.dir = Math.atan2(-dy, -dx)
      moveEntity(e, 1.8, dt, isWallFn, playerCx, playerCy)
      return
    }

    // state transitions — a playing radio carries; stalkers hear it from farther away
    if (e.type === 'wanderer') {
      e.state = dist < fleeRange ? 'flee' : 'idle'
    } else {
      e.state = dist < chaseRange * aggroMul ? 'chase' : 'idle'
    }

    // pick speed and direction
    let speed
    if (e.type === 'stalker' && e.state === 'chase') {
      speed = 1.2
      e.dir = Math.atan2(dy, dx)
    } else if (e.type === 'wanderer' && e.state === 'flee') {
      speed = 1.0
      e.dir = Math.atan2(-dy, -dx)
      e.dirTimer = 0.5  // re-aim flee direction frequently
    } else {
      speed = e.type === 'stalker' ? 0.4 : 0.8
      e.dirTimer -= dt
      if (e.dirTimer <= 0) {
        // simple LCG off current position for variety
        e.dir = ((e.dir + 1.3 + (e.x * 7 + e.y * 13) % 2.0)) % (Math.PI * 2)
        e.dirTimer = 3 + ((Math.abs(e.x * 17 + e.y * 31) % 4))
      }
    }

    moveEntity(e, speed, dt, isWallFn, playerCx, playerCy)
  }

  // beyond the gate a thing only wanders: the legacy two-probe step at its roam speed, forgetting any hunt
  function farRoam(e, spec, dt, playerCx, playerCy) {
    e.ai = 'roam'
    if (e.stagger > 0) e.stagger = Math.max(0, e.stagger - dt)
    e.dirTimer -= dt
    if (e.dirTimer <= 0) {
      e.dir = ((e.dir + 1.3 + (e.x * 7 + e.y * 13) % 2.0)) % (Math.PI * 2)
      e.dirTimer = 3 + ((Math.abs(e.x * 17 + e.y * 31) % 4))
    }
    moveEntity(e, spec.roam, dt, isWallFn, playerCx, playerCy)
    e.state = 'idle'
  }

  // the legacy frame fills the record the way game.js used to read the list: the nearest unstaggered stalker
  function legacyThreat(player) {
    threat.reset()
    for (let i = 0; i < entities.length; i++) {
      const e = entities[i]
      if (e.type !== 'stalker' || e.stagger > 0) continue
      const dx = e.x - player.x, dy = e.y - player.y
      const d = Math.sqrt(dx * dx + dy * dy)
      if (d < threat.nearest) { threat.nearest = d; threat.nearestEntity = e }
    }
    threat.hunted = threat.nearest < 10
    if (threat.nearest < 0.62) { threat.dmg = damage; threat.dmgKind = 'contact' }
  }

  function huntUpdate(dt, player, playerCx, playerCy, ctx) {
    threat.begin()
    env.dt = dt; env.now = clock(); env.pcx = playerCx; env.pcy = playerCy; env.player = player; env.ctx = ctx
    env.losBudget = LOS_BUDGET
    if (grid && typeof grid.setPlayerChunk === 'function') grid.setPlayerChunk(playerCx, playerCy)
    if (ctx.player !== player) ctx.player = player            // the variants look for you through ctx.player
    if (ctx.damage === undefined) ctx.damage = damage
    gated.length = 0
    const n = entities.length
    // a rotating start shares the line-of-sight budget round-robin
    for (let k = 0; k < n; k++) {
      const e = entities[(rr + k) % n]
      const spec = specFor(e.variant)
      const ecx = Math.floor(e.x / CHUNK_SIZE), ecy = Math.floor(e.y / CHUNK_SIZE)
      if (Math.abs(ecx - playerCx) <= GATE_CHUNKS && Math.abs(ecy - playerCy) <= GATE_CHUNKS) {
        gated.push(e)
        stepAI(e, dt, ctx, spec, env, threat)
      } else farRoam(e, spec, dt, playerCx, playerCy)
    }
    rr = n > 0 ? (rr + 1) % n : 0
    if (obstacles !== null && gated.length > 1) separate(gated, env)
    threat.end()
  }

  function update(dt, player, playerCx, playerCy, ctxOrAggroMul = 1) {
    tSum += dt
    env.pcx = playerCx; env.pcy = playerCy           // the spawn check reads the floor relative to this frame's chunk
    evict(playerCx, playerCy)
    trySpawnAround(playerCx, playerCy)
    if (typeof ctxOrAggroMul === 'object' && ctxOrAggroMul !== null) { huntMode = true; huntUpdate(dt, player, playerCx, playerCy, ctxOrAggroMul) }
    else {
      huntMode = false
      for (const e of entities) stepEntity(e, dt, player, isWallFn, playerCx, playerCy, ctxOrAggroMul)
      legacyThreat(player)
    }
    // followers arrive after their beat (they step from the next frame on)
    for (let i = pendingList.length - 1; i >= 0; i--) {
      const e = pendingList[i]
      e.pending -= dt
      if (e.pending <= 0) { e.pending = 0; pendingList.splice(i, 1); entities.push(e); woke++ }
    }
    return threat
  }

  function getEntities() { return entities }

  function setDispelled(key, until) {
    if (!dispelledUntil.has(key) && dispelledUntil.size >= DISPEL_MAX) dispelledUntil.delete(dispelledUntil.keys().next().value)
    dispelledUntil.set(key, until)
  }

  // The ward — the player's only way to fight back. A shove of will and light in
  // the direction they face: presences inside a cone are knocked back and left
  // reeling (staggered), unable to chase or strike. Warding the same presence
  // enough times disperses it entirely — and the chunk it came from stays empty
  // for DISPEL_S. A creature caught in its turning opening takes the hit twice.
  // Returns the reused { hit, dispelled, opening }.
  const wardRes = { hit: 0, dispelled: 0, opening: 0 }
  function ward(player, opts = EMPTY_OPTS) {
    const range       = opts.range       ?? 2.6
    const halfCone    = (opts.cone       ?? Math.PI * 0.7) / 2   // total arc, split L/R of facing
    const knockback   = opts.knockback   ?? 1.7
    const hits        = opts.hits        ?? 1
    const facing      = player.angle ?? 0
    const pcx = Math.floor(player.x / CHUNK_SIZE)
    const pcy = Math.floor(player.y / CHUNK_SIZE)
    const now = clock()

    wardRes.hit = 0; wardRes.dispelled = 0; wardRes.opening = 0
    for (let i = entities.length - 1; i >= 0; i--) {
      const e = entities[i]
      const dx = e.x - player.x, dy = e.y - player.y
      const d = Math.sqrt(dx * dx + dy * dy)
      if (d > range) continue
      // within the arc in front of the player?
      let a = Math.atan2(dy, dx) - facing
      a = Math.atan2(Math.sin(a), Math.cos(a))   // normalise to (-π, π]
      if (Math.abs(a) > halfCone) continue

      const spec        = specFor(e.variant)
      const staggerTime = opts.staggerTime ?? spec.staggerT
      const dispelAt    = opts.dispelAt    ?? spec.dispelAt
      const kb          = knockback * (e.ai === 'windup' || e.ai === 'lunge' ? spec.wardMul : 1)
      const r           = Math.min(creatureRadius(e.variant), 0.22)
      // shove it away from the player, one axis at a time so walls (and bodies) stop it
      const ux = d > 1e-6 ? dx / d : Math.cos(facing)
      const uy = d > 1e-6 ? dy / d : Math.sin(facing)
      const kx = e.x + ux * kb, ky = e.y + uy * kb
      if (!isWallFn(Math.floor(kx), Math.floor(e.y), pcx, pcy) && !(obstacles !== null && obstacles.blocked(kx, e.y, r))) e.x = kx
      if (!isWallFn(Math.floor(e.x), Math.floor(ky), pcx, pcy) && !(obstacles !== null && obstacles.blocked(e.x, ky, r))) e.y = ky

      const turning = e.ai === 'turning'
      e.stagger = staggerTime
      e.ai = 'stagger'; e.staggerBlockedT = 0; e.turnBurst = false
      e.wardHits = (e.wardHits || 0) + (turning ? 1 + hits : hits)
      if (turning) wardRes.opening++
      wardRes.hit++
      if (e.wardHits >= dispelAt) {
        const key = `${e.chunkCx},${e.chunkCy}`
        spawnedChunks.delete(key)
        setDispelled(key, now + DISPEL_S)
        entities.splice(i, 1)
        wardRes.dispelled++
        if (spec.dispelEvent) threat.emit(spec.dispelEvent, e, d)
      }
    }
    return wardRes
  }

  // The polaroid's flash: everything in the cone with a line to you reels (no knockback, no wardHits); a smiler or a
  // lurker turns and runs instead. Returns the reused { hit }.
  const flashRes = { hit: 0 }
  function flash(player, opts = EMPTY_OPTS) {
    const range    = opts.range   ?? 6
    const halfCone = (opts.cone   ?? Math.PI / 2.4) / 2
    const stagger  = opts.stagger ?? 1.8
    const facing   = player.angle ?? 0
    flashRes.hit = 0
    for (let i = 0; i < entities.length; i++) {
      const e = entities[i]
      const dx = e.x - player.x, dy = e.y - player.y
      const d = Math.sqrt(dx * dx + dy * dy)
      if (d > range) continue
      let a = Math.atan2(dy, dx) - facing
      a = Math.atan2(Math.sin(a), Math.cos(a))
      if (Math.abs(a) > halfCone) continue
      if (!lineOfSight(player.x, player.y, e.x, e.y, env.floor)) continue
      e.stagger = stagger; e.staggerBlockedT = 0; e.turnBurst = false
      if (e.variant === 'smiler' || e.variant === 'lurker') { e.ai = 'retreat'; e.phaseT = 0 } else e.ai = 'stagger'
      flashRes.hit++
    }
    return flashRes
  }

  // noise(x, y, L, who): the only way sound reaches the things. Eight slots, oldest dropped; each floods its own field now,
  // stamped with the running count so a creature can tell which ones it has already heard. `who` is whose it was: 'player'
  // (yours, scaled by aiCtx.noiseMul where it is heard), 'lure', 'friend'.
  function noise(x, y, L, who = 'player') {
    const k = ringN % NOISE_SLOTS
    const slot = ring[k], f = fields[k]
    ringN++
    slot.x = x; slot.y = y; slot.L = L; slot.who = who; slot.t = clock()
    floodNoise(f, slot, env.floor)
    f.id = ringN
  }

  // the stalkers on your heels, for the floor below: in a hunting phase (this path: hunt and the variants' freeze / windup /
  // lunge / recover / arcCharge, hunt.HUNTING) or chasing (legacy), nearest first
  function snapshotChasers(player, maxDist = 10, max = 3) {
    const out = []
    const sorted = entities.slice().sort((a, b) => ((a.x - player.x) ** 2 + (a.y - player.y) ** 2) - ((b.x - player.x) ** 2 + (b.y - player.y) ** 2))
    for (const e of sorted) {
      if (e.type !== 'stalker') continue
      if (huntMode ? !HUNTING.has(e.ai) : e.state !== 'chase') continue
      const dx = e.x - player.x, dy = e.y - player.y
      if (dx * dx + dy * dy > maxDist * maxDist) continue
      out.push({ type: e.type, variant: e.variant, wardHits: e.wardHits || 0 })
      if (out.length >= max) break
    }
    return out
  }

  // inject(list, nearX, nearY, minR, maxR, delaySec, blockedFn) -> how many were placed. Each descriptor spirals out
  // from the point for an open cell minR..maxR away (never closer than 4 u) that blockedFn allows, and arrives hunting
  // toward the point after delaySec. Ignores dispelledUntil: these followed you down.
  function inject(list, nearX, nearY, minR = 7, maxR = 10, delaySec = 0, blockedFn = null) {
    if (!enabled) return 0
    let count = 0
    for (let k = 0; k < list.length; k++) {
      if (entities.length + pendingList.length >= MAX_ENTITIES) break
      const desc = list[k] || {}
      const a0 = (hash(Math.floor(nearX) + k * 31, Math.floor(nearY) + count * 17) / 4294967296) * Math.PI * 2
      let fx = NaN, fy = NaN
      // rings outward across minR..maxR, then inward toward 4 and a little beyond maxR
      for (let ring = 0; ring < 20 && Number.isNaN(fx); ring++) {
        let rad
        if (ring < 8) rad = minR + (maxR - minR) * (ring / 7)
        else if (ring < 14) rad = minR - (ring - 7) * 0.5
        else rad = maxR + (ring - 13) * 0.5
        if (rad < 4) continue
        for (let j = 0; j < 16; j++) {
          const ang = a0 + (j / 16) * Math.PI * 2 + ring * 0.37
          const x = nearX + Math.cos(ang) * rad, y = nearY + Math.sin(ang) * rad
          const ix = Math.floor(x), iy = Math.floor(y)
          const cx = ix + 0.5, cy = iy + 0.5
          if (Math.hypot(cx - nearX, cy - nearY) < 4) continue
          if (!env.floor(ix, iy)) continue
          if (blockedFn && blockedFn(cx, cy)) continue
          fx = cx; fy = cy
          break
        }
      }
      if (Number.isNaN(fx)) continue                                     // dropped: nowhere to stand
      const e = huntShape({
        x: fx, y: fy, type: desc.type ?? 'stalker', variant: desc.variant ?? 'shade', state: 'chase',
        dir: Math.atan2(nearY - fy, nearX - fx), dirTimer: 3, stagger: 0, wardHits: desc.wardHits ?? 0,
        chunkCx: Math.floor(fx / CHUNK_SIZE), chunkCy: Math.floor(fy / CHUNK_SIZE),
      })
      e.ai = 'hunt'; e.lastSeenX = nearX; e.lastSeenY = nearY; e.pending = delaySec
      pendingList.push(e)
      count++
    }
    return count
  }

  function takeWakeEvent() { const n = woke; woke = 0; return n }

  // drainEvents(out) -> n: this frame's hunt events into the caller's array (the event objects are pooled: read them now)
  function drainEvents(out) {
    const ev = threat.events
    const n = ev.length
    for (let i = 0; i < n; i++) out[i] = ev[i]
    out.length = n
    ev.length = 0; threat.mark = 0
    return n
  }

  function getThreat() { return threat }

  function getDispelled() {
    const out = []
    const now = clock()
    for (const [k, until] of dispelledUntil) {
      const rem = until - now
      if (rem <= 0) continue
      const i = k.indexOf(',')
      out.push([Number(k.slice(0, i)), Number(k.slice(i + 1)), rem])
    }
    return out
  }

  // restoreDispelled(list, now): `now` is the clock the remaining seconds count from (the system's own when omitted)
  function restoreDispelled(list, now = clock()) {
    if (!list) return
    for (let i = 0; i < list.length; i++) {
      const d = list[i]
      if (!d || d.length < 3) continue
      setDispelled(`${d[0] | 0},${d[1] | 0}`, now + Math.max(0, +d[2] || 0))
    }
  }

  return { update, getEntities, ward, flash, noise, snapshotChasers, inject, takeWakeEvent, drainEvents, getThreat, getDispelled, restoreDispelled }
}
