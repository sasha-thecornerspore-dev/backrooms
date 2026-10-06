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
//
// The pass pipeline (this release): props -> exit -> npc -> scrap -> machine -> sight -> hooks.passes (stairs, dressing, hauntings:
// each on its own channels.js constants via ctx.hash / ctx.rngFrom / ctx.openCell) -> settleChunk over the bodies (props, machine,
// sight, npc: never exits, stairs or items) -> hooks.onChunk(key, bundle). The settled position IS the drawn position, and the same
// records go to the collider index. No walls -> no hugging, so the open-grid goldens are untouched.
import { CHUNK_SIZE } from './world.js'
import { fragmentAt } from './scraps.js'
import { colliderFor, footprintRadius, visualHalf } from './collide.js'
import { settleChunk } from './placement.js'
import { unitJitter } from './gfx-sprites.js'
import { walkable, loses } from './reach.js'

// The third channel `c` is the world seed. Math.imul(0, K) === 0 and X ^ 0 === X,
// so with seed 0 this hash is byte-identical to the original — the unseeded world
// and every golden test are untouched. See items.js for the full rationale.
function hash(a, b, c = 0) {
  let h = (a * 2654435761 ^ b * 2246822519 ^ Math.imul(c, 3266489917)) >>> 0
  h ^= h >>> 16; h = Math.imul(h, 0x45d9f3b) >>> 0
  h ^= h >>> 16
  return h >>> 0
}

function rngFrom(a, b, seed = 0) {
  let s = hash(a, b, seed) | 1
  return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 0xffffffff }
}

// Rare landmark set-pieces — memorable sights that break the uniform corridors
// and give you something to orient by. Non-interactive; drawn big in renderer.js.
export const SIGHT_TYPES = ['chairpile', 'tvwall', 'payphone', 'mannequin']

// the exit's way: cfg.ways[0] when the level names its ways (topology), else the plain descent with the exit's label
function wayDown(cfg) { return cfg.ways?.[0] ?? { kind: 'down', label: cfg.exit?.label ?? 'descend' } }
const EMPTY = []
const TRUE = () => true
// an authored note's scrap key ('∅:n0', ...), built once: update() runs every frame
const NOTE_KEYS = []
const noteKey = (i) => NOTE_KEYS[i] ?? (NOTE_KEYS[i] = '∅:n' + i)

export function createDecorSystem(config, isWallFn, worldSeed = 0, hooks = null) {
  let cfg = config
  let propTypes = config.props?.types?.length ? config.props.types : ['box']
  let propDens  = config.props?.density ?? 3
  let exitDenom = Math.max(1, config.exit?.denom ?? 6)
  let exitTarget = config.exit?.target ?? 0
  let npcDenom  = Math.max(1, config.npc?.denom ?? 16)
  let scrapDenom = Math.max(0, config.scraps?.denom ?? 7)   // 0 disables (e.g. Level ∅)
  let machineDenom = Math.max(0, config.machines?.denom ?? 20)   // vending machines — rarer; 0 disables
  let sightDenom = Math.max(0, config.sights?.denom ?? 28)       // landmark set-pieces — rarest; 0 disables
  let salt      = config.maze?.salt | 0
  const seed    = worldSeed | 0   // null / undefined → 0 → the unseeded world
  // Fixed-map levels (Level ∅) place ONE exit at an authored point instead of
  // scattering them by chunk hash. When set, procedural exit placement is skipped.
  let fixedExit = config.exitAt || null
  let fixedNotes = config.notes || null   // ...and its authored notes (the ∅ intake form): scraps keyed outside the chunks
  let exitKind  = wayDown(config).kind
  let exitLabel = wayDown(config).label
  const passes  = (hooks?.passes ?? EMPTY).filter((p) => typeof p === 'function')
  const onChunk = typeof hooks?.onChunk === 'function' ? hooks.onChunk : null
  const onEvict = typeof hooks?.onEvict === 'function' ? hooks.onEvict : null

  const props   = new Map()   // "cx,cy" → [{key,x,y,type,rot}]
  const exits    = new Map()  // "cx,cy" → {key,x,y,target,kind,label}
  const stairs   = new Map()  // "cx,cy" → [{key,x,y,kind,target,label,cx,cy}]  (the ways up, from a pass)
  const npcs     = new Map()  // "cx,cy" → {key,x,y}  (a lost soul)
  const scraps   = new Map()  // "cx,cy" → {key,x,y,frag}  (a note left behind)
  const machines = new Map()  // "cx,cy" → {key,x,y}       (a vending machine)
  const sights   = new Map()  // "cx,cy" → {key,x,y,type}  (a landmark set-piece)
  const haunts   = new Map()  // "cx,cy" → {key,x,y,id}    (a placed haunting, from a pass: never a body, never pinned until it fires)
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
    const prng  = rngFrom(cx * 131 + salt + 4242, cy * 197 + salt + 8484, seed)
    const count = Math.floor(propDens) + (prng() < (propDens % 1) ? 1 : 0)
    const list  = []
    for (let i = 0; i < count; i++) {
      const spot = openCell(cx, cy, prng, pcx, pcy)
      if (!spot) continue
      const type = propTypes[(prng() * propTypes.length) | 0]
      list.push({ key: `${key}:${i}`, x: spot.wx, y: spot.wy, type, rot: prng() * Math.PI * 2 })
    }
    if (list.length) props.set(key, list)

    // exit — procedural scatter, unless this level pins a single authored exit
    if (!fixedExit && hash(cx + 5150 + salt, cy + 6270 + salt, seed) % exitDenom === 0) {
      const erng = rngFrom(cx * 313 + salt + 99, cy * 911 + salt + 77, seed)
      const spot = openCell(cx, cy, erng, pcx, pcy)
      if (spot) exits.set(key, { key, x: spot.wx, y: spot.wy, target: exitTarget, kind: exitKind, label: exitLabel })
    }

    // a lost soul — rare, neutral, speaks when you approach
    if (hash(cx + 2200 + salt, cy + 3300 + salt, seed) % npcDenom === 0) {
      const nrng = rngFrom(cx * 617 + salt + 41, cy * 733 + salt + 23, seed)
      const spot = openCell(cx, cy, nrng, pcx, pcy)
      if (spot) npcs.set(key, { key, x: spot.wx, y: spot.wy })
    }

    // a scrap — a note or scratched message from someone before you. FRESH hash
    // channels (4801/9403 gate, 829/457 rng, distinct from props/exits/npcs) and
    // its OWN srng, appended last, so adding scraps never perturbs the existing
    // deterministic placement of anything above.
    if (scrapDenom > 0 && hash(cx + 4801 + salt, cy + 9403 + salt, seed) % scrapDenom === 0) {
      const srng = rngFrom(cx * 829 + salt + 53, cy * 457 + salt + 67, seed)
      const spot = openCell(cx, cy, srng, pcx, pcy)
      if (spot) scraps.set(key, { key, x: spot.wx, y: spot.wy, frag: fragmentAt(cx, cy, seed, salt) })
    }

    // a vending machine — rare, a scrap of civilization. Its own fresh channels
    // (6101/2027 gate, 541/907 rng), appended last, so it perturbs nothing above.
    if (machineDenom > 0 && hash(cx + 6101 + salt, cy + 2027 + salt, seed) % machineDenom === 0) {
      const mrng = rngFrom(cx * 541 + salt + 29, cy * 907 + salt + 83, seed)
      const spot = openCell(cx, cy, mrng, pcx, pcy)
      if (spot) machines.set(key, { key, x: spot.wx, y: spot.wy })
    }

    // a landmark sight — rarest of all, its own fresh channels (3701/5903 gate,
    // 683/419 rng, 271/613 type), appended last so nothing above is perturbed.
    if (sightDenom > 0 && hash(cx + 3701 + salt, cy + 5903 + salt, seed) % sightDenom === 0) {
      const grng = rngFrom(cx * 683 + salt + 37, cy * 419 + salt + 71, seed)
      const spot = openCell(cx, cy, grng, pcx, pcy)
      if (spot) {
        const type = SIGHT_TYPES[hash(cx + 271 + salt, cy + 613 + salt, seed) % SIGHT_TYPES.length]
        sights.set(key, { key, x: spot.wx, y: spot.wy, type })
      }
    }

    // the appended passes: each reads its own channels.js constants and places through ctx, never touching the streams above
    if (passes.length) {
      const ctx = {
        cx, cy, key, pcx, pcy, salt, seed, cfg,
        isWall: (wx, wy) => isWallFn(wx, wy, pcx, pcy),
        hash, rngFrom,
        openCell: (rng) => openCell(cx, cy, rng, pcx, pcy),
        props: list,     // the chunk's freshly built prop list, live: a later pass (haunts) sees what an earlier one (dress) added
        add: (kind, record) => {
          if (kind === 'prop') list.push(record)
          else if (kind === 'stair') {
            if (record.cx === undefined) record.cx = cx
            if (record.cy === undefined) record.cy = cy
            let sl = stairs.get(key)
            if (!sl) { sl = []; stairs.set(key, sl) }
            sl.push(record)
          }
          else if (kind === 'haunt') haunts.set(key, record)
        },
      }
      for (let i = 0; i < passes.length; i++) passes[i](ctx)
      if (list.length && !props.has(key)) props.set(key, list)
    }

    // the bodies: every prop plus this chunk's machine, sight and soul, settled against the real walls, then written back so the
    // drawn position is the settled one and the collider index sees the same record
    const machine = machines.get(key) ?? null, sight = sights.get(key) ?? null, npc = npcs.get(key) ?? null
    const bodies = []
    for (let i = 0; i < list.length; i++) { const c = colliderFor('prop', list[i]); c.rot = list[i].rot; bodies.push(c) }
    if (machine) bodies.push(colliderFor('machine', machine))
    if (sight) bodies.push(colliderFor('sight', sight))
    if (npc) bodies.push(colliderFor('npc', npc))
    if (bodies.length) {
      const floorFn = (ix, iy) => !isWallFn(ix + 0.5, iy + 0.5, pcx, pcy)
      settleChunk(bodies, floorFn, footprintRadius, visualHalf, sideFn)
      for (let i = 0; i < bodies.length; i++) {
        const c = bodies[i]
        const rec = c.kind === 'prop' ? list[i] : c.kind === 'machine' ? machine : c.kind === 'sight' ? sight : npc
        rec.x = c.x; rec.y = c.y; rec.cls = c.cls; rec.hug = c.hug; rec.cellCls = c.cellCls
      }
    }
    if (onChunk) onChunk(key, { colliders: bodies, props: list, machine, sight, npc, stairs: stairs.get(key) ?? EMPTY })
    return bodies
  }

  // the side a hugged body leans to when its cell offers more than one wall: props by their seeded rotation (gfx-sprites unitJitter,
  // the per-instance variation the art already uses), sights / machines / souls by chunk-hash parity. Deterministic; consumes no rng.
  function sideFn(rec) {
    if (rec.kind === 'prop') return unitJitter(rec.rot, 23) < 0 ? -1 : 1
    return (hash(rec.cx, rec.cy, seed) & 1) ? 1 : -1
  }

  // the dev-only reach assertion (a test run only: the harness and vitest set the marker): settling must not seal any cell the
  // walls alone leave reachable from the chunk's hall crossing
  function assertReach(cx, cy, bodies, pcx, pcy) {
    const floorFn = (ix, iy) => !isWallFn(ix + 0.5, iy + 0.5, pcx, pcy)
    const ox = cx * CHUNK_SIZE + (CHUNK_SIZE >> 1) + 0.5, oy = cy * CHUNK_SIZE + (CHUNK_SIZE >> 1) + 0.5
    const lost = loses(walkable(floorFn, EMPTY, ox, oy), walkable(floorFn, bodies, ox, oy))
    if (lost.length) console.error(`[decor] chunk ${cx},${cy}: ${lost.length} cell(s) lost reach after settling: ${lost.join(' ')}`)
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
        scraps.delete(k)
        machines.delete(k)
        sights.delete(k)
        stairs.delete(k)
        haunts.delete(k)
        if (onEvict) onEvict(k)
      }
    }
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const cx = pcx + dx, cy = pcy + dy
        const key = `${cx},${cy}`
        if (scanned.has(key)) continue
        scanned.add(key)
        const bodies = placeChunk(cx, cy, pcx, pcy)
        if (bodies.length && globalThis.__backroomsTestRun === true) assertReach(cx, cy, bodies, pcx, pcy)
      }
    }
    // the single authored exit for a fixed-map level — never chunk-bound, never evicted
    if (fixedExit && !exits.has('∅')) {
      exits.set('∅', { key: '∅', x: fixedExit.x, y: fixedExit.y, target: exitTarget, kind: exitKind, label: exitLabel })
    }
    // the authored notes, the same way: never in `scanned` (never evicted), never settled (a scrap is not a body)
    if (fixedNotes) for (let i = 0; i < fixedNotes.length; i++) {
      const k = noteKey(i)
      if (!scraps.has(k)) scraps.set(k, { key: k, x: fixedNotes[i].x, y: fixedNotes[i].y, frag: -1, form: true })
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

  function getScraps() { return [...scraps.values()] }
  function nearestScrap(px, py, maxDist = 1.8) {
    let best = null, bestD = maxDist * maxDist
    for (const s of scraps.values()) {
      const d = (s.x - px) ** 2 + (s.y - py) ** 2
      if (d < bestD) { bestD = d; best = s }
    }
    return best
  }

  function getMachines() { return [...machines.values()] }
  function nearestMachine(px, py, maxDist = 1.6) {
    let best = null, bestD = maxDist * maxDist
    for (const m of machines.values()) {
      const d = (m.x - px) ** 2 + (m.y - py) ** 2
      if (d < bestD) { bestD = d; best = m }
    }
    return best
  }

  function getSights() { return [...sights.values()] }

  // ── the ways (exits + the stairs a pass added) and the props: the prompt, the compass, the search ──
  function getStairs() {
    const out = []
    for (const sl of stairs.values()) for (const s of sl) out.push(s)
    return out
  }
  function wayAt(cx, cy, kind) {
    const sl = stairs.get(`${cx},${cy}`)
    if (!sl) return null
    for (const s of sl) if (s.kind === kind) return s
    return null
  }
  function exitAt(cx, cy) { return exits.get(`${cx},${cy}`) ?? null }
  function nearestWay(px, py, maxDist = 1.6) {
    let best = null, bestD = maxDist * maxDist
    for (const e of exits.values()) {
      const d = (e.x - px) ** 2 + (e.y - py) ** 2
      if (d < bestD) { bestD = d; best = e }
    }
    for (const sl of stairs.values()) for (const s of sl) {
      const d = (s.x - px) ** 2 + (s.y - py) ** 2
      if (d < bestD) { bestD = d; best = s }
    }
    return best
  }
  // nearest loaded way at ANY distance (the compass): one reused { rec, dist } object, or null
  const anyWay = { rec: null, dist: 0 }
  function nearestWayAny(px, py) {
    let best = null, bestD = Infinity
    for (const e of exits.values()) {
      const d = (e.x - px) ** 2 + (e.y - py) ** 2
      if (d < bestD) { bestD = d; best = e }
    }
    for (const sl of stairs.values()) for (const s of sl) {
      const d = (s.x - px) ** 2 + (s.y - py) ** 2
      if (d < bestD) { bestD = d; best = s }
    }
    if (!best) return null
    anyWay.rec = best; anyWay.dist = Math.sqrt(bestD)
    return anyWay
  }
  function nearestProp(px, py, maxDist = 1.5, pred = TRUE) {
    let best = null, bestD = maxDist * maxDist
    for (const list of props.values()) for (const p of list) {
      if (!pred(p)) continue
      const d = (p.x - px) ** 2 + (p.y - py) ** 2
      if (d < bestD) { bestD = d; best = p }
    }
    return best
  }
  // the placed hauntings (haunts.js records): ONE reused list, rebuilt in place — the tracker reads it on every calm frame
  const hauntList = []
  function getHaunts() {
    hauntList.length = 0
    for (const h of haunts.values()) hauntList.push(h)
    return hauntList
  }
  // every loaded way of one kind: the exits are the level's down way (whatever cfg.ways named it), stairs carry their own kind;
  // 'haunt' is the placed hauntings (a fresh array: getHaunts is the per-frame one)
  function getKind(kind) {
    if (kind === 'haunt') return [...haunts.values()]
    const out = []
    for (const e of exits.values()) if (e.kind === kind) out.push(e)
    for (const sl of stairs.values()) for (const s of sl) if (s.kind === kind) out.push(s)
    return out
  }

  function enterLevel(next) {
    cfg = next
    propTypes = cfg.props?.types?.length ? cfg.props.types : propTypes
    propDens  = cfg.props?.density ?? propDens
    exitDenom = Math.max(1, cfg.exit?.denom ?? exitDenom)
    exitTarget = cfg.exit?.target ?? exitTarget
    npcDenom  = Math.max(1, cfg.npc?.denom ?? npcDenom)
    scrapDenom = Math.max(0, cfg.scraps?.denom ?? scrapDenom)
    machineDenom = Math.max(0, cfg.machines?.denom ?? machineDenom)
    sightDenom = Math.max(0, cfg.sights?.denom ?? sightDenom)
    salt      = cfg.maze?.salt | 0
    fixedExit = cfg.exitAt || null
    fixedNotes = cfg.notes || null
    exitKind  = wayDown(cfg).kind
    exitLabel = wayDown(cfg).label
    props.clear()
    exits.clear()
    npcs.clear()
    scraps.clear()
    machines.clear()
    sights.clear()
    stairs.clear()
    haunts.clear()
    scanned.clear()
  }

  return {
    update, getProps, getExits, nearestExit, nearestExitAny, getNpcs, nearestNpc, getScraps, nearestScrap, getMachines, nearestMachine, getSights, enterLevel,
    getStairs, wayAt, exitAt, nearestWay, nearestWayAny, nearestProp, getKind, getHaunts,
  }
}
