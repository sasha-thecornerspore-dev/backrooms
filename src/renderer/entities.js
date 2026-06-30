import { CHUNK_SIZE } from './world.js'

const MAX_ENTITIES = 20
const SPAWN_DENOM = 8      // 1 in 8 chunks spawns
const STALKER_DENOM = 4    // 1 in 4 spawning chunks is a stalker

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

function shouldSpawn(cx, cy) {
  return hash(cx + 1000, cy + 2000) % SPAWN_DENOM === 0
}

function makeEntity(cx, cy) {
  const rng = entityRng(cx, cy)
  const type = rng() < 1 / STALKER_DENOM ? 'stalker' : 'wanderer'
  return {
    x: cx * CHUNK_SIZE + CHUNK_SIZE / 2 + (rng() - 0.5) * 4,
    y: cy * CHUNK_SIZE + CHUNK_SIZE / 2 + (rng() - 0.5) * 4,
    type,
    state: 'idle',
    dir: rng() * Math.PI * 2,
    dirTimer: 3 + rng() * 4,
    chunkCx: cx,
    chunkCy: cy,
  }
}

export function createEntitySystem(config, isWallFn) {
  const entities = []
  const spawnedChunks = new Set()

  function evict(playerCx, playerCy) {
    const radius = (config.chunkEvictRadius ?? 3) + 2
    for (let i = entities.length - 1; i >= 0; i--) {
      const e = entities[i]
      if (Math.abs(e.chunkCx - playerCx) > radius || Math.abs(e.chunkCy - playerCy) > radius) {
        spawnedChunks.delete(`${e.chunkCx},${e.chunkCy}`)
        entities.splice(i, 1)
      }
    }
  }

  function trySpawnAround(playerCx, playerCy) {
    const r = config.chunkEvictRadius ?? 3
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        if (entities.length >= MAX_ENTITIES) return
        const cx = playerCx + dx, cy = playerCy + dy
        const key = `${cx},${cy}`
        if (spawnedChunks.has(key)) continue
        spawnedChunks.add(key)
        if (shouldSpawn(cx, cy)) entities.push(makeEntity(cx, cy))
      }
    }
  }

  function update(dt, player, playerCx, playerCy) {
    evict(playerCx, playerCy)
    trySpawnAround(playerCx, playerCy)
  }

  function getEntities() { return entities }

  return { update, getEntities }
}
