import { CHUNK_SIZE } from './world.js'

const MAX_ENTITIES = 20

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
// blocked axis). Shared by the normal AI and the ward-stagger flee.
function moveEntity(e, speed, dt, isWallFn, playerCx, playerCy) {
  const nx = e.x + Math.cos(e.dir) * speed * dt
  const ny = e.y + Math.sin(e.dir) * speed * dt
  const origX = e.x, origY = e.y
  const canX = !isWallFn(Math.floor(nx), Math.floor(origY), playerCx, playerCy)
  const canY = !isWallFn(Math.floor(origX), Math.floor(ny), playerCx, playerCy)
  if (canX) e.x = nx; else e.dir += Math.PI * 0.5
  if (canY) e.y = ny; else e.dir -= Math.PI * 0.5
}

function makeEntity(cx, cy, stalkerDenom, variants) {
  const rng = entityRng(cx, cy)
  const type = rng() < 1 / stalkerDenom ? 'stalker' : 'wanderer'
  const list = (variants && variants[type] && variants[type].length) ? variants[type] : ['shade']
  const variant = list[(rng() * list.length) | 0]
  return {
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
  }
}

export function createEntitySystem(config, isWallFn) {
  const entities = []
  const spawnedChunks = new Set()

  // Per-level rules. Defaults match the historic single-level behaviour so
  // any caller without an `entities` block (e.g. unit tests) keeps spawning.
  const ent         = config?.entities ?? {}
  const enabled     = ent.enabled ?? true
  const spawnDenom  = Math.max(1, ent.spawnDenom ?? 8)
  const stalkerDenom = Math.max(1, ent.stalkerDenom ?? 4)
  const chaseRange  = ent.chaseRange ?? 24
  const fleeRange   = ent.fleeRange ?? 6
  const variants    = { stalker: ent.stalkerVariants || ['shade'], wanderer: ent.wandererVariants || ['shade'] }

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
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        if (entities.length >= MAX_ENTITIES) return
        const cx = playerCx + dx, cy = playerCy + dy
        const key = `${cx},${cy}`
        if (spawnedChunks.has(key)) continue
        spawnedChunks.add(key)
        if (shouldSpawn(cx, cy, spawnDenom)) entities.push(makeEntity(cx, cy, stalkerDenom, variants))
      }
    }
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

  function update(dt, player, playerCx, playerCy, aggroMul = 1) {
    evict(playerCx, playerCy)
    trySpawnAround(playerCx, playerCy)
    for (const e of entities) stepEntity(e, dt, player, isWallFn, playerCx, playerCy, aggroMul)
  }

  function getEntities() { return entities }

  // The ward — the player's only way to fight back. A shove of will and light in
  // the direction they face: presences inside a cone are knocked back and left
  // reeling (staggered), unable to chase or strike. Warding the same presence
  // enough times disperses it entirely. Returns { hit, dispelled } counts.
  function ward(player, opts = {}) {
    const range       = opts.range       ?? 2.6
    const halfCone    = (opts.cone       ?? Math.PI * 0.7) / 2   // total arc, split L/R of facing
    const knockback   = opts.knockback   ?? 1.7
    const staggerTime = opts.staggerTime ?? 2.6
    const dispelAt    = opts.dispelAt    ?? 3
    const facing      = player.angle ?? 0
    const pcx = Math.floor(player.x / CHUNK_SIZE)
    const pcy = Math.floor(player.y / CHUNK_SIZE)

    let hit = 0, dispelled = 0
    for (let i = entities.length - 1; i >= 0; i--) {
      const e = entities[i]
      const dx = e.x - player.x, dy = e.y - player.y
      const d = Math.sqrt(dx * dx + dy * dy)
      if (d > range) continue
      // within the arc in front of the player?
      let a = Math.atan2(dy, dx) - facing
      a = Math.atan2(Math.sin(a), Math.cos(a))   // normalise to (-π, π]
      if (Math.abs(a) > halfCone) continue

      // shove it away from the player, one axis at a time so walls stop it
      const ux = d > 1e-6 ? dx / d : Math.cos(facing)
      const uy = d > 1e-6 ? dy / d : Math.sin(facing)
      const kx = e.x + ux * knockback, ky = e.y + uy * knockback
      if (!isWallFn(Math.floor(kx), Math.floor(e.y), pcx, pcy)) e.x = kx
      if (!isWallFn(Math.floor(e.x), Math.floor(ky), pcx, pcy)) e.y = ky

      e.stagger = staggerTime
      e.wardHits = (e.wardHits || 0) + 1
      hit++
      if (e.wardHits >= dispelAt) {
        spawnedChunks.delete(`${e.chunkCx},${e.chunkCy}`)
        entities.splice(i, 1)
        dispelled++
      }
    }
    return { hit, dispelled }
  }

  return { update, getEntities, ward }
}
