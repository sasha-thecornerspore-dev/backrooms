// decor.js — the junk lying around, and the ways down.
//
// Two deterministic, chunk-seeded sets of world sprites:
//   • props: non-interactive furniture / clutter (chairs, cabinets, pipes,
//     transformers…) that make a level feel lived-in and abandoned.
//   • exits: rare "no-clip" spots. Standing on one and pressing F drops you
//     to the level's target. There is always one within a short walk.
//
// Mirrors items.js's scan/evict lifecycle. Reconfigured per level via
// enterLevel(); nothing here is ever picked up, so there is no "taken" set.
import { CHUNK_SIZE } from './world.js'

function hash(a, b) {
  let h = (a * 2654435761 ^ b * 2246822519) >>> 0
  h ^= h >>> 16; h = Math.imul(h, 0x45d9f3b) >>> 0
  h ^= h >>> 16
  return h >>> 0
}

function rngFrom(a, b) {
  let s = hash(a, b) | 1
  return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 0xffffffff }
}

export function createDecorSystem(config, isWallFn) {
  let propTypes = config.props?.types?.length ? config.props.types : ['box']
  let propDens  = config.props?.density ?? 3
  let exitDenom = Math.max(1, config.exit?.denom ?? 6)
  let exitTarget = config.exit?.target ?? 0
  let npcDenom  = Math.max(1, config.npc?.denom ?? 16)
  let salt      = config.maze?.salt | 0

  const props   = new Map()   // "cx,cy" → [{key,x,y,type,rot}]
  const exits    = new Map()  // "cx,cy" → {key,x,y,target}
  const npcs     = new Map()  // "cx,cy" → {key,x,y}  (a lost soul)
  const scanned  = new Set()

  function openCell(cx, cy, rng, pcx, pcy) {
    for (let tries = 0; tries < 16; tries++) {
      const lx = 1 + Math.floor(rng() * (CHUNK_SIZE - 2))
      const ly = 1 + Math.floor(rng() * (CHUNK_SIZE - 2))
      const wx = cx * CHUNK_SIZE + lx + 0.5
      const wy = cy * CHUNK_SIZE + ly + 0.5
      if (!isWallFn(wx, wy, pcx, pcy)) return { wx, wy }
    }
    return null
  }

  function placeChunk(cx, cy, pcx, pcy) {
    const key = `${cx},${cy}`

    // props
    const prng  = rngFrom(cx * 131 + salt + 4242, cy * 197 + salt + 8484)
    const count = Math.floor(propDens) + (prng() < (propDens % 1) ? 1 : 0)
    const list  = []
    for (let i = 0; i < count; i++) {
      const spot = openCell(cx, cy, prng, pcx, pcy)
      if (!spot) continue
      const type = propTypes[(prng() * propTypes.length) | 0]
      list.push({ key: `${key}:${i}`, x: spot.wx, y: spot.wy, type, rot: prng() * Math.PI * 2 })
    }
    if (list.length) props.set(key, list)

    // exit
    if (hash(cx + 5150 + salt, cy + 6270 + salt) % exitDenom === 0) {
      const erng = rngFrom(cx * 313 + salt + 99, cy * 911 + salt + 77)
      const spot = openCell(cx, cy, erng, pcx, pcy)
      if (spot) exits.set(key, { key, x: spot.wx, y: spot.wy, target: exitTarget })
    }

    // a lost soul — rare, neutral, speaks when you approach
    if (hash(cx + 2200 + salt, cy + 3300 + salt) % npcDenom === 0) {
      const nrng = rngFrom(cx * 617 + salt + 41, cy * 733 + salt + 23)
      const spot = openCell(cx, cy, nrng, pcx, pcy)
      if (spot) npcs.set(key, { key, x: spot.wx, y: spot.wy })
    }
  }

  function update(pcx, pcy) {
    const r = config.chunkEvictRadius ?? 3
    for (const k of scanned) {
      const [cx, cy] = k.split(',').map(Number)
      if (Math.max(Math.abs(cx - pcx), Math.abs(cy - pcy)) > r + 2) {
        scanned.delete(k)
        props.delete(k)
        exits.delete(k)
        npcs.delete(k)
      }
    }
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const cx = pcx + dx, cy = pcy + dy
        const key = `${cx},${cy}`
        if (scanned.has(key)) continue
        scanned.add(key)
        placeChunk(cx, cy, pcx, pcy)
      }
    }
  }

  function getProps() {
    const out = []
    for (const list of props.values()) for (const p of list) out.push(p)
    return out
  }

  function getExits() { return [...exits.values()] }

  function nearestExit(px, py, maxDist = 1.1) {
    let best = null, bestD = maxDist * maxDist
    for (const e of exits.values()) {
      const d = (e.x - px) ** 2 + (e.y - py) ** 2
      if (d < bestD) { bestD = d; best = e }
    }
    return best
  }

  // Nearest loaded exit at ANY distance (for the HUD direction indicator).
  function nearestExitAny(px, py) {
    let best = null, bestD = Infinity
    for (const e of exits.values()) {
      const d = (e.x - px) ** 2 + (e.y - py) ** 2
      if (d < bestD) { bestD = d; best = e }
    }
    return best ? { x: best.x, y: best.y, dist: Math.sqrt(bestD) } : null
  }

  function getNpcs() { return [...npcs.values()] }
  function nearestNpc(px, py, maxDist = 1.6) {
    let best = null, bestD = maxDist * maxDist
    for (const n of npcs.values()) {
      const d = (n.x - px) ** 2 + (n.y - py) ** 2
      if (d < bestD) { bestD = d; best = n }
    }
    return best
  }

  function enterLevel(cfg) {
    propTypes = cfg.props?.types?.length ? cfg.props.types : propTypes
    propDens  = cfg.props?.density ?? propDens
    exitDenom = Math.max(1, cfg.exit?.denom ?? exitDenom)
    exitTarget = cfg.exit?.target ?? exitTarget
    npcDenom  = Math.max(1, cfg.npc?.denom ?? npcDenom)
    salt      = cfg.maze?.salt | 0
    props.clear()
    exits.clear()
    npcs.clear()
    scanned.clear()
  }

  return { update, getProps, getExits, nearestExit, nearestExitAny, getNpcs, nearestNpc, enterLevel }
}
