# Level ∅ (lean cut) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Level ∅ — the hand-authored Harlem Park inner-block-park — as the game's one-way-down entry level: an enclosed Baltimore rowhouse block rendered with per-cell materials (formstone / CMU-sealed doors / plywood+numbers / black windows / brick / occupied) under open sky, that you fall out of into the lobby.

**Architecture:** Three additive engine capabilities, each backward-compatible with the existing procedural levels: (1) a **fixed-map world provider** (`createFixedMap`) with the same `isWall(wx,wy,pcx,pcy)` interface as `createChunkCache`, plus `materialAt(wx,wy)`; (2) **per-cell wall materials** — `castRay` returns the hit cell, the renderer holds an array of wall textures and picks one by material id (procedural levels use id 0 = today's wallpaper, byte-identical); (3) a **sky** ceiling path (vertical gradient instead of drop-ceiling tiles) gated on `config.sky`. Level ∅ is `LEVELS[4]`, addressed explicitly, one-way down to level 0 (scalar exit, no `exits[]` refactor — deferred to the map/portals phase). The game boots into ∅; on descent it enters the normal 0→1→2→3→0 ring.

**Tech Stack:** Vanilla ESM, HTML5 canvas software raycaster, vitest (`environment: 'node'`, zero mocks, pure-module tests). Electron shell.

## Global Constraints

- **Branch:** `feat/level-null-harlem-park` (already created off `fix/config-lights`, which is PR #9). Do not commit to `main`.
- **Backward compatibility is mandatory.** Procedural levels 0–3 must render byte-identically. New material/sky code paths activate only when a level opts in (`cfg.map` / `cfg.sky`). Existing `items.test.js`, `decor.test.js`, `world.test.js`, `levels.test.js` golden values must not change.
- **Save format stays `v: 1`.** `save.js` merges and tolerates extra keys; `snapshot()` may gain keys but never bumps `v` (a bump silently discards every saved run — `save.js:12`).
- **Test house style:** pure functions, `environment: 'node'`, no mocks, no jsdom. `game.js`, `index.html`, and `renderer.js` have no unit harness — verify those via CDP (`npx electron . --remote-debugging-port=9333` + `Emulation.setFocusEmulationEnabled`; occluded windows throttle rAF but a real crash still stops a heartbeat).
- **The lore rule (from the spec):** the horror is that it is true. Name the *system* (HOLC, the 1961 plan, notice `EXTENSION`), never residents. Occupied houses interleaved with sealed ones are non-negotiable — some windows lit, nobody comes out.
- **Lean-cut boundary:** ship geometry + materials + sky + one-way-down entry. DEFER to a follow-up: the Creative Camouflage "photo of a window" reveal beat, the readable statutory-notice prop, and players-meeting-in-∅ (solo ∅ first).

---

### Task 1: Fixed-map world provider

**Files:**
- Create: `src/renderer/fixedmap.js`
- Test: `test/fixedmap.test.js`

**Interfaces:**
- Produces: `createFixedMap(grid) -> { isWall(wx, wy, pcx?, pcy?), materialAt(wx, wy), preload(), width, height }`
  - `grid`: `string[]` — each row a string of cell codes; `.` / ` ` = open, any other char = a wall whose char is its material id.
  - `isWall`: true for wall cells **and for everything outside the grid bounds** (the block is bounded; you cannot walk off the authored map).
  - `materialAt`: the wall's char (e.g. `'F'`) for wall cells, `null` for open/out-of-bounds. Signature mirrors nothing in the cache — it is new.
  - `preload()`: no-op (a fixed map has nothing to stream), present so callers can treat it like `createChunkCache`.

- [ ] **Step 1: Write the failing test**

```js
// test/fixedmap.test.js
import { describe, it, expect } from 'vitest'
import { createFixedMap } from '../src/renderer/fixedmap.js'

const GRID = [
  'FFFF',
  'F..F',
  'F..P',
  'FFFF',
]

describe('createFixedMap', () => {
  it('reports open cells and wall cells', () => {
    const m = createFixedMap(GRID)
    expect(m.width).toBe(4); expect(m.height).toBe(4)
    expect(m.isWall(1.5, 1.5)).toBe(false)   // '.'
    expect(m.isWall(0.5, 0.5)).toBe(true)    // 'F'
  })
  it('treats out-of-bounds as solid wall (the block is bounded)', () => {
    const m = createFixedMap(GRID)
    expect(m.isWall(-1, 1)).toBe(true)
    expect(m.isWall(99, 1)).toBe(true)
    expect(m.isWall(1, -5)).toBe(true)
  })
  it('returns the material char for walls, null for open', () => {
    const m = createFixedMap(GRID)
    expect(m.materialAt(0.5, 0.5)).toBe('F')
    expect(m.materialAt(3.5, 2.5)).toBe('P')
    expect(m.materialAt(1.5, 1.5)).toBeNull()
    expect(m.materialAt(-1, -1)).toBeNull()
  })
  it('preload is a no-op that does not throw', () => {
    const m = createFixedMap(GRID)
    expect(() => m.preload(0, 0)).not.toThrow()
  })
})
```

- [ ] **Step 2: Run it — expect FAIL** (`npx vitest run test/fixedmap.test.js` → "createFixedMap is not a function")

- [ ] **Step 3: Implement**

```js
// src/renderer/fixedmap.js — an authored, bounded grid that quacks like the chunk cache.
// Cell codes: '.' or ' ' = open; any other char = a wall whose char is its material id.
export function createFixedMap(grid) {
  const height = grid.length
  const width  = grid.reduce((w, row) => Math.max(w, row.length), 0)
  const cell = (ix, iy) => (grid[iy] ?? '')[ix] ?? 'X'   // out of bounds → 'X' (solid, unnamed)

  function isWall(wx, wy) {
    const ix = Math.floor(wx), iy = Math.floor(wy)
    if (ix < 0 || iy < 0 || ix >= width || iy >= height) return true
    const c = cell(ix, iy)
    return c !== '.' && c !== ' '
  }
  function materialAt(wx, wy) {
    const ix = Math.floor(wx), iy = Math.floor(wy)
    if (ix < 0 || iy < 0 || ix >= width || iy >= height) return null
    const c = cell(ix, iy)
    return (c === '.' || c === ' ') ? null : c
  }
  return { isWall, materialAt, preload() {}, width, height }
}
```

- [ ] **Step 4: Run it — expect PASS**
- [ ] **Step 5: Commit** — `git add src/renderer/fixedmap.js test/fixedmap.test.js && git commit -m "feat: fixed-map world provider — an authored bounded grid with per-cell materials"`

---

### Task 2: The Level ∅ authored map

**Files:**
- Create: `src/renderer/level-null-map.js`
- Test: `test/level-null-map.test.js`

**Interfaces:**
- Consumes: `createFixedMap` (Task 1) in the test only.
- Produces: `NULL_MAP` (`string[]`), `NULL_SPAWN` (`{x, y}` inside the enclosed park), `NULL_EXIT` (`{x, y}` the no-clip-down gap, in an open cell). Material chars: `F` formstone, `C` CMU-sealed door, `P` plywood+number, `B` brick, `W` black open window, `O` occupied (lit) house, `M` marble stoop (floor-level accent, still a wall cell for the lean cut).

**Design (author, do not placeholder):** a rectangular ring of rowhouse backs enclosing an open inner park. Perimeter is walls; interior is open (`.`) except a few marble stoops / stray masonry. One ~3-cell gap in the perimeter is the way *in* (narrative: "you enter through the gap the paperwork left"); the exit tile sits in the open park. Interleave `O` (occupied) among `F/C/P/W` on the perimeter so it reads as processed, not abandoned. ~24×18 cells.

- [ ] **Step 1: Write the failing test** (asserts the invariants the hand-authored art must satisfy — not the exact glyphs)

```js
// test/level-null-map.test.js
import { describe, it, expect } from 'vitest'
import { NULL_MAP, NULL_SPAWN, NULL_EXIT } from '../src/renderer/level-null-map.js'
import { createFixedMap } from '../src/renderer/fixedmap.js'

function reachable(map, sx, sy, tx, ty) {           // flood fill over open cells
  const m = createFixedMap(map), seen = new Set(), q = [[Math.floor(sx), Math.floor(sy)]]
  const key = (x, y) => `${x},${y}`
  while (q.length) {
    const [x, y] = q.pop()
    if (x === Math.floor(tx) && y === Math.floor(ty)) return true
    for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
      const nx = x + dx, ny = y + dy, k = key(nx, ny)
      if (!seen.has(k) && !m.isWall(nx + 0.5, ny + 0.5)) { seen.add(k); q.push([nx, ny]) }
    }
  }
  return false
}

describe('Level ∅ map', () => {
  it('is a non-trivial enclosed block', () => {
    expect(NULL_MAP.length).toBeGreaterThan(12)
    expect(NULL_MAP[0]).toMatch(/^[^.\s]+$/)                 // solid top edge (enclosed)
    expect(NULL_MAP[NULL_MAP.length - 1]).toMatch(/^[^.\s]+$/) // solid bottom edge
  })
  it('spawns the player in an open cell', () => {
    const m = createFixedMap(NULL_MAP)
    expect(m.isWall(NULL_SPAWN.x, NULL_SPAWN.y)).toBe(false)
  })
  it('exit is an open cell reachable from spawn (there is always a way down)', () => {
    const m = createFixedMap(NULL_MAP)
    expect(m.isWall(NULL_EXIT.x, NULL_EXIT.y)).toBe(false)
    expect(reachable(NULL_MAP, NULL_SPAWN.x, NULL_SPAWN.y, NULL_EXIT.x, NULL_EXIT.y)).toBe(true)
  })
  it('uses only known material codes', () => {
    const ok = new Set(['.', ' ', 'F', 'C', 'P', 'B', 'W', 'O', 'M', 'X'])
    for (const row of NULL_MAP) for (const ch of row) expect(ok.has(ch)).toBe(true)
  })
  it('interleaves occupied houses among the sealed ones (non-negotiable)', () => {
    const joined = NULL_MAP.join('')
    expect(joined.includes('O')).toBe(true)   // lived-in
    expect(joined.includes('C')).toBe(true)   // CMU-sealed
  })
})
```

- [ ] **Step 2: Run it — expect FAIL** (module missing)
- [ ] **Step 3: Author `src/renderer/level-null-map.js`** — hand-draw the grid to pass every invariant above. Keep the perimeter solid, carve the interior park open, place one perimeter gap, set `NULL_SPAWN` just inside the gap and `NULL_EXIT` deeper in the park. Interleave `O` among `F/C/P/W/B`, dot the interior with the odd `M`. (This is the art step — real content, no TODO.)
- [ ] **Step 4: Run it — expect PASS**
- [ ] **Step 5: Commit** — `feat: hand-author the Harlem Park block (Level ∅ map)`

---

### Task 3: castRay returns the hit cell

**Files:**
- Modify: `src/renderer/raycaster.js` (the two `return` sites)
- Test: `test/raycaster.test.js` (extend)

**Interfaces:**
- Produces: `castRay(...)` return gains `mx` (int hit cell X) and `my` (int hit cell Y). Existing `{dist, side, wallX}` unchanged. The no-hit return sets `mx/my` to the last stepped cell.

- [ ] **Step 1: Add a failing assertion** to an existing raycaster test — after a known hit, `expect(Number.isInteger(hit.mx)).toBe(true)` and assert the hit cell matches the wall you placed (e.g. a wall at x=5 hit from x=0 facing +x → `hit.mx === 5`).
- [ ] **Step 2: Run — expect FAIL** (`hit.mx` is undefined)
- [ ] **Step 3: Implement** — in `castRay`, include `mx, my` in both the hit return and the fall-through return. These are the loop variables already tracked (`mx`, `my`); just add them to the returned object literals.
- [ ] **Step 4: Run all raycaster tests — expect PASS** (additive; existing assertions untouched)
- [ ] **Step 5: Commit** — `feat: castRay returns the hit cell (mx,my) for per-cell wall materials`

---

### Task 4: Multi-material walls + sky in the renderer

**Files:**
- Modify: `src/renderer/renderer.js` — `buildTextures` (build a wall texture per material), `createRenderer` signature (accept `materials` + `materialAt`), the ceiling pass (sky), the wall pass (pick texture by material).

**Interfaces:**
- Consumes: `castRay` `hit.mx/my` (Task 3); `cfg.sky` (Task 5); `cfg.materials` (Task 5) — `{ F:'#…', C:'#…', … }` material→base-colour map.
- Produces: `createRenderer(canvas, config, renderOpts, worldHooks)` — `worldHooks.materialAt(wx,wy)` optional. When absent (procedural levels) every wall uses `tex.walls[0]` = today's wallpaper (byte-identical). `config.sky` (a `[r,g,b]` or hex) swaps the ceiling for a vertical gradient.

**Design:** `buildTextures` returns `{ walls: { '0': Uint8Array, F: …, C: …, … }, ceil, floor, light }`. Material `'0'` is the existing wallpaper (unchanged code path). Each named material is the same tile generator tinted to its base colour, with a per-material tweak (CMU = flat grey, no baseboard; W = near-black with a faint frame; P = grey-brown + a bright "number" block; O = formstone + a lit-window rectangle). The wall pass computes `const mat = materialAt ? materialAt(hit.mx + 0.5, hit.my + 0.5) : null; const wt = tex.walls[mat] ?? tex.walls['0']` once per column (not per pixel). Sky: in the ceiling half, if `hasSky`, write `lerp(skyTop, fog, rowFrac)` per row (constant across the row, like the existing fog rows) instead of tile sampling.

- [ ] **Step 1** — Extend `buildTextures` to build `walls['0']` (current wallpaper, code moved verbatim) plus one tinted variant per material char in a fixed list `['F','C','P','B','W','O','M']`, each from `config.materials[char]` (fallback to `palette.wall`).
- [ ] **Step 2** — Add `hasSky`/`skyRgb` from `config.sky` in `createRenderer`; in the ceiling pass, branch to the gradient when `hasSky`.
- [ ] **Step 3** — Thread `worldHooks.materialAt` into `render`; pick `wt` per column by material.
- [ ] **Step 4: Verify byte-identical procedural output.** With no `materialAt` and no `sky`, render level 0 and confirm it matches pre-change (CDP: reuse the in-page render-diff harness from the config.lights fix — diff must be 0 across the whole frame for identical player state).
- [ ] **Step 5: Verify ∅ look** (after Task 6 wires it) — CDP screenshot: distinct wall materials visible, open sky above.
- [ ] **Step 6: Commit** — `feat: per-cell wall materials and a sky ceiling path (opt-in; procedural levels unchanged)`

---

### Task 5: Level ∅ in levels.js

**Files:**
- Modify: `src/renderer/levels.js` (append `LEVELS[4]`; `levelConfig` already handles index 4 via `LEVELS[4 % 5]`)
- Test: `test/levels.test.js` (update the ring/count assertions for the appended, out-of-ring ∅)

**Interfaces:**
- Consumes: `NULL_MAP`, `NULL_SPAWN`, `NULL_EXIT` (Task 2).
- Produces: `LEVELS[4]` — `{ id: '∅', name: 'level ∅ — the block', config: { map: NULL_MAP, spawn: NULL_SPAWN, sky: '#b9b7ae', lights: false, materials: {…}, entities:{enabled:false}, music:{…}, exit:{ target: 0, denom: 1, label: 'no-clip out', hint: '…' }, messages:[…] } }`. `exit.target: 0` = one-way down into the lobby; nothing targets index 4, so the 0→1→2→3→0 ring is preserved. `denom` is unused for a fixed map (the exit is placed at `NULL_EXIT`, Task 6) but kept for shape.

- [ ] **Step 1** — Update `test/levels.test.js`: `levelCount()` now `5`; `LEVELS.map(l=>l.id)` is `[0,1,2,3,'∅']`; add: ∅'s `exit.target === 0`; no numeric level targets `4` (`LEVELS.slice(0,4).every(l => l.config.exit.target !== 4)`); keep the `0→1→2→3→0` assertions unchanged. Adjust the "wraps out-of-range" test: `levelConfig(DEFAULT_CONFIG, 5).levelIndex === 0` and drop/replace the `-1 → 3` case (now `-1 → '∅'`).
- [ ] **Step 2: Run — expect FAIL** on the new assertions.
- [ ] **Step 3** — Append `LEVELS[4]` with the ∅ config (real palette, materials map, music mood tuned bleak-outdoor, messages sourced from the lore — HOLC grade D, the 1961 plan, `EXTENSION`; name the system not residents).
- [ ] **Step 4: Run — expect PASS** (all of `levels.test.js`, and the untouched `world/items/decor` suites still green).
- [ ] **Step 5: Commit** — `feat: Level ∅ config — the block, one-way down into the lobby`

---

### Task 6: Wire ∅ into the level lifecycle (game.js)

**Files:**
- Modify: `src/renderer/game.js` — `buildLevel` (provider selection + spawn + renderer hooks), `descend` (already generic), `snapshot`/`persist` (record ∅), boot index.

**Interfaces:**
- Consumes: `createFixedMap` (Task 1); `cfg.map`, `cfg.spawn`, `NULL_EXIT` via cfg (Task 5); `createRenderer(..., worldHooks)` (Task 4).

**Design:** in `buildLevel(index)`:
```js
const cfg = levelConfig(base, index)
const fixed = cfg.map ? createFixedMap(cfg.map) : null
const world = fixed ?? createChunkCache(cfg, worldSeed)
world.preload(0, 0)
const isWall = (wx, wy, pcx, pcy) => world.isWall(wx, wy, pcx, pcy)
const gfx = createRenderer(canvas, cfg, renderOpts, fixed ? { materialAt: (wx, wy) => fixed.materialAt(wx, wy) } : {})
// spawn: fixed map uses cfg.spawn; procedural keeps HALF+0.5
if (cfg.spawn) { player.x = cfg.spawn.x; player.y = cfg.spawn.y } else { player.x = HALF + 0.5; player.y = HALF + 0.5 }
```
For ∅ the single exit is placed at `NULL_EXIT` rather than scattered by decor: when `cfg.map`, seed `decor` with one exit at `cfg.exitAt` (add `NULL_EXIT` to the ∅ config as `exitAt`), or special-case the exit list. Simplest for the lean cut: give `createDecorSystem` an optional `fixedExits` (array) via `enterLevel`, used verbatim when present. Entities/items density can stay low or off for ∅ (`entities.enabled:false`; items sparse). Boot: `initGame` starts at index `4` (∅) for a fresh run; `descend(0,…)` on exit drops to the lobby; CONTINUE restores the saved index (which may be a numeric level — ∅ is entry-only, never resumed into).

- [ ] **Step 1** — CDP boot check: fresh run starts in ∅ (HUD reads `level ∅ — the block`), sky visible, materials visible, an exit reachable.
- [ ] **Step 2** — CDP: walk to `NULL_EXIT`, press F → fade → level 0 (the lobby, lit). Confirm one-way (no exit back to ∅ from level 0).
- [ ] **Step 3** — Confirm procedural levels unchanged (descend 0→1→2→3, screenshots match expectations; level 2/3 dark per the shipped `config.lights` fix).
- [ ] **Step 4** — `snapshot()` records the level index within `v:1`; a run saved in ∅ that is reloaded lands in the lobby (∅ is entry-only). No save discarded.
- [ ] **Step 5: Commit** — `feat: boot into Level ∅ and fall one-way into the lobby`

---

### Task 7: Entry copy + integration pass

**Files:**
- Modify: `src/renderer/index.html` (intake/start copy referencing the block, if the start screen names the level), `README.md` (document Level ∅ in the descent table).

- [ ] **Step 1** — Update the README descent section: add the ∅ row ("the block — Harlem Park; enter through the gap, fall into the lobby"). Keep the lore truthful and system-named.
- [ ] **Step 2** — CDP full playthrough screenshot set: ∅ → lobby → level 1. Save to `docs/screenshots/` if worth featuring.
- [ ] **Step 3** — Run the whole suite (`npm test`) — all green.
- [ ] **Step 4: Commit** — `docs: Level ∅ in the descent; screenshots`

---

### Task 8: Ship

- [ ] **Step 1** — `git push -u origin feat/level-null-harlem-park`
- [ ] **Step 2** — Open a PR against `main` (base may need `fix/config-lights` to merge first, or rebase onto `main` once PR #9 lands). Body: what ∅ is, the lore sourcing, the three engine additions, backward-compat proof, verification screenshots. Do **not** auto-merge — leave for review.
- [ ] **Step 3** — Note deferred follow-ups in the PR: camouflage reveal beat, readable notice prop, players-meeting-in-∅.

---

## Self-review notes

- **Spec coverage (§2 of the amendment):** enclosed block ✓ (T2), materials from §2.1b ✓ (T2/T4), sky ✓ (T4), one-way-down preserving the ring ✓ (T5), occupied houses ✓ (T2 invariant), entry-through-the-gap ✓ (T2/T6). Deferred per the lean-cut decision: camouflage reveal, notice prop, MP-in-∅ (§9.3/9.5).
- **Backward-compat:** materials/sky are opt-in; procedural levels pass no `materialAt`/`sky` → identical output (T4 Step 4 proves it). Save stays `v:1` (T6 Step 4).
- **Precondition already shipped:** `config.lights` (PR #9) — ∅'s `lights:false` + sky depends on it.
- **Open decision surfaced, not silently taken:** `exits[]` is deferred; ∅ is one-way down with a scalar exit. Revisit at the map/portals phase (subsystem #2).
