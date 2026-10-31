// the first run on the FIXED first world (worldSeed null: the decor seed 0, every chunk at epoch 0), built the way buildLevel builds the
// lobby — the shipped world.json, the docket's lean, the same passes — on a real chunk cache. The lines say a note lies by the spawn on the
// hall a fresh player walks, that someone waits by an orange cone further down that hall, and that the way down is in the wide room through
// the wall back where the paper was. This pins that all of it is really there, and that nothing the thread names moved anything.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { FIRST_NOTE, FIRST_SOUL, FIRST_ROOM, inRoom, threadHolds, createFirstRun } from '../src/renderer/firstrun.js'
import { DEFAULT_CONFIG, CHUNK_SIZE, createChunkCache, createGridReader } from '../src/renderer/world.js'
import { levelConfig } from '../src/renderer/levels.js'
import { createDecorSystem } from '../src/renderer/decor.js'
import { createItemSystem } from '../src/renderer/items.js'
import { waysFor, stairsPass, chunkMid, findOpenNear, LOBBY } from '../src/renderer/topology.js'
import { dressPass } from '../src/renderer/dress.js'
import { hauntsPass } from '../src/renderer/haunts.js'
import { standing, placementMods, applyPlacement, EMPTY_DOCKET } from '../src/renderer/docket.js'
import { CONTAINER_TYPES } from '../src/renderer/containers.js'
import { SCRAPS } from '../src/renderer/scraps.js'
import { lineOfSight } from '../src/renderer/raycaster.js'
import { walkable, reachesSpot } from '../src/renderer/reach.js'

const CS = CHUNK_SIZE
const cellOf = (o) => ({ x: Math.floor(o.x), y: Math.floor(o.y) })
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y)

// the lobby as a fresh solo run builds it: loadConfig's merge, levelConfig, the docket's placement lean, the ways, then the cache and
// decor game.js makes (createChunkCache(cfg, worldSeed) and createDecorSystem(cfg, isWall, worldSeed, passes) with worldSeed null);
// `docket` stands in for the shipped one (a recount's lean)
const SHIPPED = JSON.parse(readFileSync(new URL('../src/renderer/world.json', import.meta.url), 'utf8'))
function fixedLobby(docket = SHIPPED.docket) {
  const base = { ...DEFAULT_CONFIG, ...SHIPPED, docket }
  const cfg = levelConfig(base, LOBBY)
  applyPlacement(cfg, placementMods(standing(base.docket, 0)))
  cfg.ways = waysFor(LOBBY)
  const cache = createChunkCache(cfg, null)
  const isWall = (wx, wy, pcx, pcy) => cache.isWall(wx, wy, pcx, pcy)
  const grid = createGridReader(cache, isWall)
  const bundles = new Map()
  const decor = createDecorSystem(cfg, isWall, null, {
    passes: [stairsPass(cfg, cfg.ways), dressPass(cfg), hauntsPass(cfg)].filter(Boolean),
    onChunk: (k, b) => bundles.set(k, b),
  })
  grid.setPlayerChunk(0, 0); decor.update(0, 0)
  const items = createItemSystem(cfg, isWall, null)
  items.enterLevel(cfg); items.update(0, 0)
  const colliders = []
  for (const b of bundles.values()) colliders.push(...b.colliders)
  const mid = chunkMid(0, 0)
  const spawn = findOpenNear(mid.x, mid.y, grid.floor) ?? mid
  return { cfg, grid, decor, items, colliders, spawn }
}

const W = fixedLobby()
// one flood over the spawn's block of the floor (spawn chunk, the note's, the soul's, the room's), the real bodies standing in it
const REACH = walkable(W.grid.floor, W.colliders, W.spawn.x, W.spawn.y, { x0: -1, y0: -1, x1: 3 * CS + 1, y1: 2 * CS + 1 })
// the thread's places are pinned while the shipped docket keeps the lobby's souls where the thread found them; a recount that leans the
// lobby compliance or litigation re-lays them, and then the thread is off (firstrun.js threadHolds) and there is nothing here to pin
const HOLDS = threadHolds(SHIPPED.docket)

describe('the thread and the docket\'s lean (review D1/C10)', () => {
  const row0 = (r) => ({ ...EMPTY_DOCKET, '0': { extension: 0, compliance: 0, litigation: 0, ...r } })
  const soulOf = (L) => L.decor.getNpcs().find((n) => n.key === FIRST_SOUL.key)

  it('the shipped docket: the thread is on exactly when it holds', () => {
    const fr = createFirstRun({ fresh: true, docket: SHIPPED.docket }); fr.onLevel(LOBBY)
    expect(fr.on()).toBe(HOLDS)
  })

  it('a compliance or litigation lead on the lobby\'s row really takes the soul the note names away: the guard is not idle', () => {
    for (const r of [{ compliance: 2 }, { litigation: 2 }]) {
      const docket = row0(r)
      expect(threadHolds(docket)).toBe(false)
      expect(soulOf(fixedLobby(docket)), JSON.stringify(r)).toBeUndefined()
      const fr = createFirstRun({ fresh: true, docket }); fr.onLevel(LOBBY)
      expect(fr.on()).toBe(false)
    }
  })

  it('an extension lead leaves the soul and the radio\'s page where the thread found them: the thread holds', () => {
    const zero = soulOf(fixedLobby(EMPTY_DOCKET))
    expect(zero).toBeDefined()
    for (const r of [{ extension: 2 }, { extension: 5, compliance: 2, litigation: 2 }]) {
      const docket = row0(r), L = fixedLobby(docket)
      expect(threadHolds(docket)).toBe(true)
      const soul = soulOf(L)
      expect(soul, JSON.stringify(r)).toBeDefined()
      expect([soul.x, soul.y]).toEqual([zero.x, zero.y])
      const page = L.decor.getScraps().find((s) => s.key === '1,0')
      expect([page?.x, page?.y], JSON.stringify(r)).toEqual([28.5, 11.5])
    }
  })
})

describe.runIf(HOLDS)('the fixed lobby a fresh run arrives in', () => {
  it('spawns at the origin chunk\'s hall crossing, facing down the long east hall', () => {
    expect(W.spawn).toEqual({ x: 11.5, y: 11.5 })
    for (let x = 11; x < 3 * CS; x++) expect(W.grid.floor(x, 11), `hall cell ${x},11`).toBe(true)
  })

  it('the first page a fresh player reads is still the radio\'s, where it always lay', () => {
    const page = W.decor.getScraps().find((s) => s.key === '1,0')
    expect(page).toBeDefined()
    expect([page.x, page.y]).toEqual([28.5, 11.5])
    expect(SCRAPS[page.frag]).toMatch(/^the radio in the wall counts/)
    expect(dist(page, W.spawn)).toBeLessThan(dist(FIRST_NOTE, W.spawn))   // the page first, the note after it
  })
})

describe.runIf(HOLDS)('the note', () => {
  it('lies on an open cell, near the spawn, beside the hall line the fresh player walks', () => {
    const c = cellOf(FIRST_NOTE)
    expect(W.grid.floor(c.x, c.y)).toBe(true)
    expect([FIRST_NOTE.x % 1, FIRST_NOTE.y % 1]).toEqual([0.5, 0.5])
    expect(dist(FIRST_NOTE, W.spawn)).toBeLessThan(24)
    expect(FIRST_NOTE.x).toBeGreaterThan(W.spawn.x)
    expect(Math.abs(FIRST_NOTE.y - W.spawn.y)).toBeLessThanOrEqual(1)     // within the 1.8 read reach of a walk straight down the hall
    // in sight from where the radio's page lies, and from the hall all the way up to it
    const page = W.decor.getScraps().find((s) => s.key === '1,0')
    expect(lineOfSight(page.x, page.y, FIRST_NOTE.x, FIRST_NOTE.y, W.grid.floor)).toBe(true)
    for (let x = Math.floor(page.x); x < FIRST_NOTE.x; x++) expect(lineOfSight(x + 0.5, 11.5, FIRST_NOTE.x, FIRST_NOTE.y, W.grid.floor), `from ${x},11`).toBe(true)
  })

  it('is reach-gated: the flood from the spawn, through the settled bodies, reaches it', () => {
    expect(reachesSpot(REACH, FIRST_NOTE.x, FIRST_NOTE.y, 1.8)).toBe(true)
    expect(reachesSpot(REACH, FIRST_NOTE.x, FIRST_NOTE.y, 0.25)).toBe(true)
  })

  it('has the prompt to itself: no page, way, item, drawer or body crowds it, and no page moved for it', () => {
    for (const s of W.decor.getScraps()) expect(dist(s, FIRST_NOTE), `page ${s.key}`).toBeGreaterThan(3.6)
    for (const e of W.decor.getExits()) expect(dist(e, FIRST_NOTE)).toBeGreaterThan(1.6)
    for (const it of W.items.getWorldItems()) expect(dist(it, FIRST_NOTE)).toBeGreaterThan(1.4)
    for (const p of W.decor.getProps()) {
      if (CONTAINER_TYPES[p.type]) expect(dist(p, FIRST_NOTE), `drawer ${p.key}`).toBeGreaterThan(1.5)
    }
    for (const b of W.colliders) if (b.cls === 'solid') expect(dist(b, FIRST_NOTE), `body ${b.key}`).toBeGreaterThan(b.r + 0.3)
    for (const n of W.decor.getNpcs()) expect(dist(n, FIRST_NOTE)).toBeGreaterThan(1.8)
    for (const m of W.decor.getMachines()) expect(dist(m, FIRST_NOTE)).toBeGreaterThan(1.6)
    expect(W.decor.getScraps().some((s) => s.key === FIRST_NOTE.key)).toBe(false)   // decor never places it: the wiring does
  })

  it('says what is there: an orange cone further down this hall', () => {
    expect(FIRST_NOTE.text).toMatch(/orange cone, further down this hall/)
    expect(FIRST_NOTE.text).toMatch(/they remember the way down/)
  })
})

describe.runIf(HOLDS)('the soul', () => {
  const soul = W.decor.getNpcs().find((n) => n.key === FIRST_SOUL.key)

  it('really stands in the fixed lobby, by its chunk key, further down the hall than the note', () => {
    expect(soul).toBeDefined()
    expect(`${Math.floor(soul.x / CS)},${Math.floor(soul.y / CS)}`).toBe(FIRST_SOUL.key)
    expect(soul.x).toBeGreaterThan(FIRST_NOTE.x)
    expect(Math.abs(soul.y - 11.5)).toBeLessThan(3)
    expect(reachesSpot(REACH, soul.x, soul.y, 1.8)).toBe(true)          // you can stand close enough to speak
  })

  it('waits by an orange cone you can see from the hall', () => {
    const cones = W.decor.getProps().filter((p) => p.type === 'cone' && dist(p, soul) < 5)
    expect(cones.length).toBeGreaterThan(0)
    const cone = cones[0]
    expect(cone.x).toBeGreaterThan(FIRST_NOTE.x)
    let seen = 0
    for (let x = Math.floor(FIRST_NOTE.x); x < Math.ceil(soul.x) + 2; x++) if (lineOfSight(x + 0.5, 11.5, cone.x, cone.y, W.grid.floor)) seen++
    expect(seen).toBeGreaterThanOrEqual(3)
  })

  it('is the only soul the note could mean: none nearer the hall between the note and it', () => {
    for (const n of W.decor.getNpcs()) {
      if (n === soul) continue
      expect(n.x > FIRST_NOTE.x && n.x < soul.x && Math.abs(n.y - 11.5) < 4).toBe(false)
    }
  })
})

describe.runIf(HOLDS)('the room', () => {
  const way = W.decor.getExits().find((e) => e.key === FIRST_ROOM.way.key)

  it('holds the fixed world\'s nearest down way, the one the compass names from the spawn', () => {
    expect(way).toBeDefined()
    expect(way.kind).toBe('down')
    expect([way.x, way.y]).toEqual([FIRST_ROOM.way.x, FIRST_ROOM.way.y])
    expect(inRoom(Math.floor(way.x), Math.floor(way.y))).toBe(true)
    expect(W.decor.nearestWayAny(W.spawn.x, W.spawn.y).rec).toBe(way)
    for (const e of W.decor.getExits()) if (e !== way) expect(dist(e, W.spawn)).toBeGreaterThan(dist(way, W.spawn))
    expect(reachesSpot(REACH, way.x, way.y, 1.6)).toBe(true)
  })

  it('is wide: most of its cells are open floor, and the flood reaches them', () => {
    let open = 0, reached = 0, n = 0
    for (let y = FIRST_ROOM.y0; y <= FIRST_ROOM.y1; y++) for (let x = FIRST_ROOM.x0; x <= FIRST_ROOM.x1; x++) {
      n++
      if (W.grid.floor(x, y)) { open++; if (reachesSpot(REACH, x + 0.5, y + 0.5, 0.5)) reached++ }
    }
    expect(open / n).toBeGreaterThan(0.75)
    expect(reached / open).toBeGreaterThan(0.9)
  })

  it('is through the wall, back where the paper was: a straight walk from the note down the hall that crosses there', () => {
    const x = Math.floor(FIRST_NOTE.x)
    for (let y = Math.floor(FIRST_NOTE.y); y <= FIRST_ROOM.y0; y++) expect(W.grid.floor(x, y), `cell ${x},${y}`).toBe(true)
    // the wall between the blocks is solid either side of the passage the hall makes through it
    for (const y of [CS - 2, CS - 1, CS]) {
      expect(W.grid.floor(x - 1, y)).toBe(false)
      expect(W.grid.floor(x + 1, y)).toBe(false)
    }
    expect(FIRST_ROOM.y0).toBeGreaterThan(CS)                           // the room is in the next block, past that wall
    expect(FIRST_SOUL.line).toMatch(/wide room through the wall, back where you found the paper/)
  })

  it('no other way stands in it, so the room is the way', () => {
    const inside = [...W.decor.getExits(), ...W.decor.getStairs()].filter((e) => inRoom(Math.floor(e.x), Math.floor(e.y)))
    expect(inside).toEqual([way])
  })
})
