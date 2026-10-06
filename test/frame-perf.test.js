// The whole non-render frame, in node, against a REAL level 1 (sharedConventions #9): the chunk cache, the grid reader, the collider
// index that decor fills through the stairs / dress / haunts passes, the solid world, the entity system on the hunt path with twenty
// creatures injected beside the player, the items, the fog map, the pins, the compass and the haunt check — stepped exactly as game.js's
// loop steps them, 600 frames at dt = 1/60. Two things are pinned: the budget (under 150 ms for the lot, so the simulation is never what
// a frame waits on) and the identities the hot path lives by — update() hands back the one threat record and movePlayer the one report,
// every frame, so nothing below the renderer allocates per frame. The 600 frames are walked twice back to back (the second run is the
// warmed, steady state the game lives in); the better run carries the budget, both carry the identities — a machine busy with the rest of
// the suite must not fail a frame that is fast.
import { describe, it, expect } from 'vitest'
import { DEFAULT_CONFIG, CHUNK_SIZE, createChunkCache, createGridReader } from '../src/renderer/world.js'
import { levelConfig } from '../src/renderer/levels.js'
import { waysFor, stairsPass, chunkMid, findOpenNear } from '../src/renderer/topology.js'
import { dressPass } from '../src/renderer/dress.js'
import { hauntsPass, createHauntTracker } from '../src/renderer/haunts.js'
import { createColliderIndex, createSolidWorld } from '../src/renderer/collide.js'
import { createDecorSystem } from '../src/renderer/decor.js'
import { createEntitySystem } from '../src/renderer/entities.js'
import { solidCreature } from '../src/renderer/hunt.js'
import { createItemSystem } from '../src/renderer/items.js'
import { createFogMap, revealRadius } from '../src/renderer/fogmap.js'
import { visibleWays, PROX_PIN } from '../src/renderer/sightpins.js'
import { compassLines, compassText } from '../src/renderer/compass.js'
import { quiet } from '../src/renderer/tactics.js'
import { HF } from '../src/renderer/gfx-frame.js'

const FRAMES = 600, DT = 1 / 60, CREATURES = 20, BUDGET_MS = 150
const SPEED = 0.05                      // game.js: const SPEED = 0.05; sp = SPEED * dt * 60 * mult

// buildLevel(1) as game.js builds it, minus the renderer: cache -> grid -> bodies -> decor(hooks) -> solid -> entitySys
function buildLevel(index) {
  const cfg = levelConfig(DEFAULT_CONFIG, index)
  cfg.ways = waysFor(index)
  const worldSeed = null                                      // a plain solo run: the unseeded world
  const cache = createChunkCache(cfg, worldSeed)
  cache.preload(0, 0)
  const isWall = (wx, wy, pcx, pcy) => cache.isWall(wx, wy, pcx, pcy)
  const grid = createGridReader(cache, isWall)
  grid.setPlayerChunk(0, 0)
  const bodies = createColliderIndex()
  const decor = createDecorSystem(cfg, isWall, worldSeed, {
    passes: [stairsPass(cfg, cfg.ways), dressPass(cfg), hauntsPass(cfg)].filter(Boolean),
    onChunk: (k, bundle) => bodies.setChunk(k, bundle.colliders),
    onEvict: (k) => bodies.dropChunk(k),
  })
  const solid = createSolidWorld({ index: bodies, floorFn: grid.floor, solidCreature })
  const clock = { playT: 0 }
  const entitySys = createEntitySystem(cfg, isWall, { obstacles: solid.forEntities, grid, now: () => clock.playT })
  const itemSys = createItemSystem(cfg, isWall, worldSeed)
  itemSys.enterLevel(cfg, null, null)
  const mid = chunkMid(0, 0), m = findOpenNear(mid.x, mid.y, grid.floor) ?? mid
  const player = { x: m.x, y: m.y, angle: 0, hp: 100, maxHp: 100 }
  decor.update(0, 0); itemSys.update(0, 0)
  return { index, cfg, cache, grid, bodies, decor, solid, entitySys, itemSys, player, clock }
}

describe('the non-render frame on a real level 1 with twenty creatures (600 frames at 1/60)', () => {
  const L = buildLevel(1)
  const { cfg, cache, grid, bodies, decor, solid, entitySys, itemSys, player, clock } = L
  const epochOf = (cx, cy) => cache.epochOf(cx, cy)
  const fog = createFogMap()
  const haunts = createHauntTracker({ now: () => clock.playT })
  const nearestWayFn = (x, y) => decor.nearestWay(x, y, 2)
  const compassState = { player, known: null, fallback: null, arrived: null, stale: (p) => fog.isStale(1, p.chunkKey, epochOf) }
  const compassOut = [], seenWays = [], seenSights = [], entEvents = []
  const aiCtx = { flashlight: true, sprinting: false, dark: !cfg.lights, fog: cfg.fogDistance, radioOn: false, lures: [], t: 0, hf: HF, playerAngle: 0, player, damage: cfg.entities?.damage ?? 16 }
  // the hunters: a mix of the floor's own kinds, 5..10 u out, never inside a body or a wall; the first update() lets them in (the
  // pending twenty fill MAX_ENTITIES, so the floor spawns nothing of its own on top)
  const kinds = [...cfg.entities.stalkerVariants, ...cfg.entities.wandererVariants]
  const followers = Array.from({ length: CREATURES }, (_, i) => ({ type: 'stalker', variant: kinds[i % kinds.length], wardHits: 0 }))
  const placed = entitySys.inject(followers, player.x, player.y, 5, 10, 0, (x, y) => solid.forEntities.blocked(x, y, 0.2))

  // the walker's state across runs: the play clock, the cell / compass memos, the last hit, the identities seen so far
  const S = { playT: 0, lureT: 0, stepT: 0, hits: -Infinity, frame: 0, lastCellIx: NaN, lastCellIy: NaN, lastCompassAngle: -Infinity, lastWayCount: -1, lastCompassText: '', pcx: NaN, pcy: NaN, threat: null, report: null, sameThreat: true, sameReport: true, maxEntities: 0, crossings: 0 }

  // ONE frame of game.js's loop below the renderer, in its order
  function frame(dt) {
    const f = S.frame++
    S.playT += dt; clock.playT = S.playT
    // ── the things set down: their clocks, then the lures (recomputed when dirty or every 0.5 s) ──
    itemSys.expireDropped(S.playT)
    S.lureT += dt
    if (itemSys.isDirty() || S.lureT >= 0.5) { S.lureT = 0; aiCtx.lures = itemSys.getLures(S.playT, player.x, player.y) }
    const pcx = Math.floor(player.x / CHUNK_SIZE), pcy = Math.floor(player.y / CHUNK_SIZE)
    if (pcx !== S.pcx || pcy !== S.pcy) { if (!Number.isNaN(S.pcx)) S.crossings++; S.pcx = pcx; S.pcy = pcy }
    grid.setPlayerChunk(pcx, pcy)
    // ── movement: one step forward along the heading, scaled by the clutter underfoot, through ONE movePlayer; a blocked step
    //    turns the walker (a maze walk: corners, furniture, the creatures that will not let you through) ──
    const x0 = player.x, y0 = player.y
    const sp = SPEED * dt * 60
    const mult2 = solid.clutterAt(player.x, player.y)
    const report = solid.movePlayer(player, player.x + Math.cos(player.angle) * sp * mult2, player.y + Math.sin(player.angle) * sp * mult2, dt, false, entitySys.getEntities())
    if (S.report === null) S.report = report; else if (report !== S.report) S.sameReport = false
    const movedD = Math.hypot(player.x - x0, player.y - y0)
    if (movedD < sp * 0.25) player.angle += 1.9 + (f % 7) * 0.1
    else if (f % 150 === 149) player.angle += 0.7
    const moved = movedD > 1e-6
    // ── stream world + subsystems around the player ──
    cache.preload(pcx, pcy)
    itemSys.update(pcx, pcy)
    decor.update(pcx, pcy)
    // ── the map: O(1) until the cell changes, then the flood, the pins of what is seen, the stale check ──
    const cix = Math.floor(player.x), ciy = Math.floor(player.y)
    const cellChanged = cix !== S.lastCellIx || ciy !== S.lastCellIy
    S.lastCellIx = cix; S.lastCellIy = ciy
    const st = fog.step(1, player.x, player.y, revealRadius(1), grid.floor, epochOf)
    if (st) {
      const reach = cfg.fogDistance
      let n = visibleWays(player, decor.getExits(), grid.floor, reach * 1.35, HF, seenWays)
      for (let i = 0; i < n; i++) { const e = seenWays[i]; fog.pinWay(1, e, epochOf(Math.floor(e.x / CHUNK_SIZE), Math.floor(e.y / CHUNK_SIZE))) }
      n = visibleWays(player, decor.getStairs(), grid.floor, reach * 1.35, HF, seenWays)
      for (let i = 0; i < n; i++) { const s = seenWays[i]; fog.pinWay(1, s, epochOf(s.cx, s.cy)) }
      n = visibleWays(player, decor.getSights(), grid.floor, reach, HF, seenSights)
      for (let i = 0; i < n; i++) { const s = seenSights[i]; fog.pinThing(1, s.key, 'sight', s.x, s.y) }
      const mc = decor.nearestMachine(player.x, player.y, PROX_PIN); if (mc) fog.pinThing(1, mc.key, 'machine', mc.x, mc.y, false)
      const sc = decor.nearestScrap(player.x, player.y, PROX_PIN); if (sc) fog.pinThing(1, sc.key, 'note', sc.x, sc.y, false)
      const np = decor.nearestNpc(player.x, player.y, PROX_PIN); if (np) fog.pinThing(1, np.key, 'npc', np.x, np.y)
      fog.checkStale(1, player, nearestWayFn, epochOf)
    }
    // ── the compass: recomputed on a cell / heading / known-ways change only ──
    const known = fog.ways(1)
    if (cellChanged || Math.abs(player.angle - S.lastCompassAngle) > 0.05 || known.length !== S.lastWayCount) {
      S.lastCompassAngle = player.angle; S.lastWayCount = known.length
      compassState.known = known
      compassState.fallback = decor.nearestWayAny(player.x, player.y)
      compassState.arrived = fog.arrivedPin(1)
      compassLines(compassState, compassOut)
      const s = compassText(compassOut)
      if (s !== S.lastCompassText) S.lastCompassText = s
    }
    // ── the things: what they know this frame, the footsteps they hear, one update, the event drain ──
    aiCtx.sprinting = false; aiCtx.t = S.playT; aiCtx.playerAngle = player.angle
    S.stepT += moved ? dt : 0
    if (S.stepT >= 0.45) { S.stepT = 0; entitySys.noise(player.x, player.y, 3 * quiet(0)) }
    const th = entitySys.update(dt, player, pcx, pcy, aiCtx)
    if (S.threat === null) S.threat = th; else if (th !== S.threat) S.sameThreat = false
    entitySys.drainEvents(entEvents)
    entitySys.takeWakeEvent()
    S.maxEntities = Math.max(S.maxEntities, entitySys.getEntities().length)
    // ── the hauntings, only while calm ──
    const calm = !th.hunted && th.nearest >= 14 && S.playT - S.hits > 20
    const h = calm ? haunts.check(player.x, player.y, decor.getHaunts(), true) : null
    if (h) haunts.fire(h.key)
    // ── HP: contact damage with the game's i-frames; the walker never dies (the floor stays level 1) ──
    if (th.dmg > 0) { S.hits = S.playT; player.hp = Math.max(1, player.hp - th.dmg) }
  }

  function run(frames) {
    const t0 = performance.now()
    for (let f = 0; f < frames; f++) frame(DT)
    return performance.now() - t0
  }

  it('is a real level: walls, settled bodies, a way, and twenty creatures placed beside the player', () => {
    expect(cfg.entities.enabled).toBe(true)
    expect(bodies.size).toBeGreaterThan(0)
    expect(decor.getProps().length).toBeGreaterThan(0)
    expect(decor.getExits().length + decor.getStairs().length).toBeGreaterThan(0)
    expect(grid.floor(Math.floor(player.x), Math.floor(player.y))).toBe(true)
    expect(placed).toBe(CREATURES)
  })

  it(`steps the whole frame ${FRAMES} times in under ${BUDGET_MS} ms, with the same threat and the same report every frame`, () => {
    const ms1 = run(FRAMES)
    const ms2 = run(FRAMES)
    const best = Math.min(ms1, ms2)
    console.info(`frame-perf: ${FRAMES} frames x ${CREATURES} creatures: ${ms1.toFixed(1)} ms cold, ${ms2.toFixed(1)} ms warm (${(best / FRAMES * 1000).toFixed(0)} us/frame best, ${S.crossings} chunk crossings, ${entitySys.getEntities().length} creatures left)`)
    expect(S.frame).toBe(2 * FRAMES)
    expect(S.sameThreat, 'update() returns the one threat record every frame').toBe(true)
    expect(S.sameReport, 'movePlayer returns the one report every frame').toBe(true)
    expect(S.maxEntities).toBe(CREATURES)
    expect(entitySys.getEntities().length).toBeGreaterThan(0)
    expect(best, `${FRAMES} frames took ${ms1.toFixed(1)} / ${ms2.toFixed(1)} ms`).toBeLessThan(BUDGET_MS)
  })
})
