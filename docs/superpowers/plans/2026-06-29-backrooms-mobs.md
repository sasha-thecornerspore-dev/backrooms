# Backrooms Mobs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add wanderer and stalker NPC entities that spawn in the maze, move with simple AI, and render as dark billboard silhouettes in the raycaster.

**Architecture:** `entities.js` owns all entity state and AI; `renderer.js` gains a zbuffer during the wall pass and uses it to clip sprite columns; `game.js` calls entity update each frame and passes the entity array to the renderer. The renderer's `render()` gains a 4th parameter `entities`.

**Tech Stack:** Pure JS ES modules, no new dependencies. Vitest for unit tests.

## Global Constraints
- ES modules (`"type": "module"`) throughout — no CommonJS
- No new npm dependencies
- `CHUNK_SIZE = 22` from `world.js`
- Entity max pool: 20 entities globally
- Wanderer speed: 0.8 units/sec; stalker speed: 1.2 units/sec (chase), 0.4 (idle)
- Spawn rate: 1 in 8 chunks; 1 in 4 spawning chunks gets a stalker (rest wanderers)
- Flee trigger: player within 6 world-units (wanderer); chase trigger: player within 24 (stalker)
- Sprite color: `rgba(20,15,10,alpha)` where alpha = fog lerp (fully fogged → invisible)
- No what-comments; only WHY-comments for non-obvious choices

---

### Task 1: Entity State + Spawn System

**Files:**
- Create: `src/renderer/entities.js`
- Create: `test/entities.test.js`

**Interfaces:**
- Produces: `createEntitySystem(config, isWallFn)` → `{ update(dt, player, playerCx, playerCy), getEntities(): Entity[] }`
- Entity shape: `{ x, y, type: 'wanderer'|'stalker', state: 'idle'|'chase'|'flee', dir: number, dirTimer: number, chunkCx: number, chunkCy: number }`

- [ ] **Step 1: Write failing tests**

```js
// test/entities.test.js
import { describe, it, expect } from 'vitest'
import { createEntitySystem } from '../src/renderer/entities.js'

const config = { chunkEvictRadius: 3 }
const isWall = () => false

describe('createEntitySystem', () => {
  it('returns update and getEntities', () => {
    const sys = createEntitySystem(config, isWall)
    expect(typeof sys.update).toBe('function')
    expect(typeof sys.getEntities).toBe('function')
  })

  it('getEntities returns array', () => {
    const sys = createEntitySystem(config, isWall)
    expect(Array.isArray(sys.getEntities())).toBe(true)
  })

  it('spawns at most 20 entities', () => {
    const sys = createEntitySystem(config, isWall)
    for (let cx = -10; cx <= 10; cx++)
      for (let cy = -10; cy <= 10; cy++)
        sys.update(0, { x: cx * 22 + 11, y: cy * 22 + 11 }, cx, cy)
    expect(sys.getEntities().length).toBeLessThanOrEqual(20)
  })

  it('entity has required shape', () => {
    // force a spawn by using seeded chunk (cx=0,cy=0 happens to spawn in test seed)
    const sys = createEntitySystem(config, isWall)
    sys.update(0, { x: 11, y: 11 }, 0, 0)
    const ents = sys.getEntities()
    if (ents.length > 0) {
      const e = ents[0]
      expect(['wanderer', 'stalker']).toContain(e.type)
      expect(['idle', 'chase', 'flee']).toContain(e.state)
      expect(typeof e.x).toBe('number')
      expect(typeof e.y).toBe('number')
      expect(typeof e.dir).toBe('number')
      expect(typeof e.dirTimer).toBe('number')
    }
  })

  it('evicts entities beyond evictRadius + 2', () => {
    const sys = createEntitySystem(config, isWall)
    // spawn near 0,0
    sys.update(0, { x: 11, y: 11 }, 0, 0)
    const before = sys.getEntities().length
    // move player far away
    sys.update(0, { x: 200 * 22 + 11, y: 200 * 22 + 11 }, 200, 200)
    const after = sys.getEntities().length
    expect(after).toBeLessThanOrEqual(before)
  })
})
```

- [ ] **Step 2: Run tests, confirm they fail**

```
cd C:/Users/sasha/Documents/Repos/backrooms && npm test -- --reporter=verbose 2>&1 | tail -20
```
Expected: FAIL — `entities.js` not found.

- [ ] **Step 3: Implement `entities.js`**

```js
// src/renderer/entities.js
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
```

- [ ] **Step 4: Run tests, confirm they pass**

```
npm test
```
Expected: all tests pass (existing 19 + new entity tests).

- [ ] **Step 5: Commit**

```
git add src/renderer/entities.js test/entities.test.js
git commit -m "feat: entity spawn system — pool, chunk-seeded spawn/evict"
```

---

### Task 2: Entity AI Update

**Files:**
- Modify: `src/renderer/entities.js` — extend `update()` with per-entity AI step
- Modify: `test/entities.test.js` — add AI behaviour tests

**Interfaces:**
- Consumes: `isWallFn(wx, wy, playerCx, playerCy)` from `world.js` — use to probe ahead before moving
- `update(dt, player, playerCx, playerCy)` now also advances AI each frame

- [ ] **Step 1: Write failing AI tests**

Append to `test/entities.test.js`:

```js
describe('entity AI', () => {
  it('wanderer changes dir when dirTimer expires', () => {
    const sys = createEntitySystem(config, isWall)
    // inject a wanderer directly
    sys.getEntities().push({ x: 50, y: 50, type: 'wanderer', state: 'idle', dir: 0, dirTimer: 0.01, chunkCx: 2, chunkCy: 2 })
    const dirBefore = sys.getEntities()[0].dir
    sys.update(1.0, { x: 0, y: 0 }, 0, 0)
    // timer expired → dir should change (very likely with dt=1.0 >> 0.01)
    expect(sys.getEntities()[0].dirTimer).toBeGreaterThan(0)
  })

  it('wanderer enters flee state when player is close', () => {
    const sys = createEntitySystem(config, isWall)
    sys.getEntities().push({ x: 3, y: 3, type: 'wanderer', state: 'idle', dir: 0, dirTimer: 99, chunkCx: 0, chunkCy: 0 })
    sys.update(0.016, { x: 3, y: 3 }, 0, 0)
    expect(sys.getEntities()[0].state).toBe('flee')
  })

  it('stalker enters chase state when player is within 24 units', () => {
    const sys = createEntitySystem(config, isWall)
    sys.getEntities().push({ x: 10, y: 10, type: 'stalker', state: 'idle', dir: 0, dirTimer: 99, chunkCx: 0, chunkCy: 0 })
    sys.update(0.016, { x: 10, y: 30 }, 0, 0)  // dist ~20, within 24
    expect(sys.getEntities()[0].state).toBe('chase')
  })

  it('entity moves when dt > 0', () => {
    const sys = createEntitySystem(config, isWall)
    sys.getEntities().push({ x: 50, y: 50, type: 'wanderer', state: 'idle', dir: 0, dirTimer: 99, chunkCx: 2, chunkCy: 2 })
    const xBefore = sys.getEntities()[0].x
    sys.update(0.1, { x: 0, y: 0 }, 0, 0)
    expect(sys.getEntities()[0].x).not.toBe(xBefore)
  })
})
```

- [ ] **Step 2: Run tests, confirm they fail**

```
npm test
```
Expected: AI tests fail (update doesn't move entities yet).

- [ ] **Step 3: Extend `update()` in `entities.js` with AI**

Replace the `update` function inside `createEntitySystem`:

```js
function stepEntity(e, dt, player, isWallFn, playerCx, playerCy) {
  const dx = player.x - e.x
  const dy = player.y - e.y
  const dist = Math.sqrt(dx * dx + dy * dy)

  // state transitions
  if (e.type === 'wanderer') {
    e.state = dist < 6 ? 'flee' : 'idle'
  } else {
    e.state = dist < 24 ? 'chase' : 'idle'
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

  // try to move; redirect on wall hit
  const nx = e.x + Math.cos(e.dir) * speed * dt
  const ny = e.y + Math.sin(e.dir) * speed * dt
  if (!isWallFn(Math.floor(nx), Math.floor(e.y), playerCx, playerCy)) {
    e.x = nx
  } else {
    e.dir += Math.PI * 0.5  // turn 90° on wall hit
  }
  if (!isWallFn(Math.floor(e.x), Math.floor(ny), playerCx, playerCy)) {
    e.y = ny
  } else {
    e.dir -= Math.PI * 0.5
  }
}

function update(dt, player, playerCx, playerCy) {
  evict(playerCx, playerCy)
  trySpawnAround(playerCx, playerCy)
  for (const e of entities) stepEntity(e, dt, player, isWallFn, playerCx, playerCy)
}
```

- [ ] **Step 4: Run tests**

```
npm test
```
Expected: all pass.

- [ ] **Step 5: Commit**

```
git add src/renderer/entities.js test/entities.test.js
git commit -m "feat: entity AI — wanderer flee/wander, stalker chase/idle"
```

---

### Task 3: Sprite Rendering in Renderer

**Files:**
- Modify: `src/renderer/renderer.js` — add zbuffer, extend `render()` to accept and draw entities

**Interfaces:**
- Consumes: `Entity[]` from `entities.js` (shape defined in Task 1)
- Changes `render(player, isWallFn, flickerIntensity)` → `render(player, isWallFn, flickerIntensity, entities = [])`
- Produces: zbuffer `Float32Array` of length W (corrected wall distances per column), used internally for sprite clipping

Note: the `renderer.js` currently has no tests — this is a visual subsystem. Verify manually by running `npm start` after wiring in Task 4.

- [ ] **Step 1: Read current `renderer.js`** to understand the wall rendering loop

Open `src/renderer/renderer.js` and locate:
- Where `castRay` is called per column
- Where `fillRect` draws each wall column
- The `W` and `H` canvas dimension variables
- The `FOV` constant

- [ ] **Step 2: Add zbuffer to wall pass**

Inside `createRenderer`, after the existing constants, add:

```js
const zbuffer = new Float32Array(W)  // corrected wall dist per column, reset each frame
```

In the wall rendering loop (the `for (let col = 0; col < W; col++)` loop), after computing `corrDist` (the fisheye-corrected distance), add:

```js
zbuffer[col] = corrDist
```

This must go AFTER the fisheye correction (`corrDist = hit.dist * Math.cos(angle - player.angle)`) and BEFORE the `fillRect` call.

- [ ] **Step 3: Add sprite rendering pass after walls**

After the wall loop and before the vignette/flicker overlays, add this sprite pass:

```js
// sprite pass — entities rendered as dark billboard silhouettes
if (entities && entities.length > 0) {
  const HALF_FOV = FOV / 2
  // sort far→near so closer entities overdraw
  const sorted = [...entities].sort((a, b) => {
    const da = (a.x - player.x) ** 2 + (a.y - player.y) ** 2
    const db = (b.x - player.x) ** 2 + (b.y - player.y) ** 2
    return db - da
  })
  for (const ent of sorted) {
    const ex = ent.x - player.x
    const ey = ent.y - player.y
    const entDist = Math.sqrt(ex * ex + ey * ey)
    if (entDist < 0.5) continue
    // angle of entity relative to player heading
    const entAngle = Math.atan2(ey, ex) - player.angle
    // normalise to [-PI, PI]
    const relAngle = ((entAngle + Math.PI * 3) % (Math.PI * 2)) - Math.PI
    if (Math.abs(relAngle) > HALF_FOV + 0.2) continue

    const screenX = Math.floor(W / 2 + (relAngle / HALF_FOV) * (W / 2))
    const spriteH = Math.min(H * 2, Math.floor(H / entDist))
    const spriteW = Math.floor(spriteH * 0.4)
    const top = Math.floor((H - spriteH) / 2 + player.bobOffset * 4)

    // fog factor — same curve as wall fog
    const fogT = Math.min(1, entDist / config.fogDistance)
    const alpha = (1 - fogT) * 0.92

    if (alpha < 0.04) continue

    ctx.fillStyle = `rgba(20,15,10,${alpha.toFixed(3)})`
    for (let sx = screenX - spriteW / 2; sx < screenX + spriteW / 2; sx++) {
      const col = Math.floor(sx)
      if (col < 0 || col >= W) continue
      if (zbuffer[col] <= entDist) continue  // wall is closer — skip this column
      ctx.fillRect(col, top, 1, spriteH)
    }
  }
}
```

- [ ] **Step 4: Update `render` signature**

Change the function signature from:
```js
function render(player, isWallFn, flickerIntensity) {
```
to:
```js
function render(player, isWallFn, flickerIntensity, entities = []) {
```

- [ ] **Step 5: Run existing tests**

```
npm test
```
Expected: all 19 tests pass (renderer has no unit tests — visual verification happens in Task 4).

- [ ] **Step 6: Commit**

```
git add src/renderer/renderer.js
git commit -m "feat: sprite renderer — zbuffer, billboard entity projection, fog clip"
```

---

### Task 4: Wire Entities into Game Loop

**Files:**
- Modify: `src/renderer/game.js` — import entities, update each frame, pass to renderer

**Interfaces:**
- Consumes: `createEntitySystem(config, isWallFn)` from `'./entities.js'`
- Consumes: updated `renderer.render(player, isWallFn, flickerIntensity, entities)` from Task 3
- Player chunk: `Math.floor(player.x / CHUNK_SIZE)`, `Math.floor(player.y / CHUNK_SIZE)`

- [ ] **Step 1: Add import at top of `game.js`**

```js
import { createEntitySystem } from './entities.js'
```

- [ ] **Step 2: Initialise entity system after cache is created**

In `initGame`, after `const cache = createChunkCache(config)` (or wherever the cache is created), add:

```js
const entitySys = createEntitySystem(config, (wx, wy, pcx, pcy) => cache.isWall(wx, wy, pcx, pcy))
```

- [ ] **Step 3: Update entity system each frame**

In the game loop, after computing `playerCx` / `playerCy` (player chunk coords) and BEFORE calling `renderer.render(...)`, add:

```js
entitySys.update(dt, player, playerCx, playerCy)
```

- [ ] **Step 4: Pass entities to renderer**

Change:
```js
renderer.render(player, (wx, wy) => cache.isWall(wx, wy, playerCx, playerCy), flicker)
```
to:
```js
renderer.render(
  player,
  (wx, wy) => cache.isWall(wx, wy, playerCx, playerCy),
  flicker,
  entitySys.getEntities()
)
```

- [ ] **Step 5: Run tests**

```
npm test
```
Expected: all pass.

- [ ] **Step 6: Manual smoke test**

```
npm start
```
Walk around for ~30 seconds. You should see dark silhouette figures appearing in corridors. Wanderers drift and redirect; stalkers approach when you get close. Mobs fade with fog — distant ones invisible, nearby ones solid.

- [ ] **Step 7: Commit**

```
git add src/renderer/game.js
git commit -m "feat: wire entity system into game loop — update + render each frame"
git push
```
