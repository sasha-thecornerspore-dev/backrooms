# Final Review Fix Report

Date: 2026-06-28

## FIX 1: Shell injection in `.github/workflows/wish-grant.yml`

All steps that previously interpolated `${{ github.event.issue.body }}` directly into shell `run:` blocks now route through `env:` blocks. Affected steps:
- "Extract wish text from issue body" — `ISSUE_BODY` env var, `echo "text=${ISSUE_BODY}"`
- "Call Claude API to modify world.json" — `ISSUE_BODY` env var, `WISH="$ISSUE_BODY"`
- "Create branch and PR" — `ISSUE_BODY`, `ISSUE_TITLE`, `ISSUE_NUM` env vars; all inline expressions removed from shell
- "Comment on issue" — `ISSUE_NUM` env var replaces `${{ github.event.issue.number }}`

## FIX 2: Wish text included in issue body (`src/main.js`)

Changed issue `body` field from:
```
submitted from backrooms v{version}
```
to:
```
{wish text}

---
submitted from backrooms v{version}
```

This ensures the wish text is present in the issue body so the workflow's Claude API call receives the actual wish content.

## FIX 3: `.gitignore` missing `src/build-config.json`

Already present on line 5 of `.gitignore`. No change required.

## FIX 4: `wallDensity` from config not used in `generateChunk` (`src/renderer/world.js`)

- `createChunkCache(config)` now accepts a config object (with backward-compat fallback for bare number)
- Extracts `evictRadius` from `config.chunkEvictRadius` (default 3) and `wallDensity` from `config.wallDensity` (default 0.30)
- `generateChunk` signature extended to `generateChunk(cx, cy, epoch, density = 0.30)`
- Random fill now uses `rnd() > (1 - density)` instead of hardcoded `0.70`
- `getChunk` passes `wallDensity` to `generateChunk`
- `game.js` updated: `createChunkCache(config.chunkEvictRadius)` → `createChunkCache(config)`
- `test/world.test.js` updated: all `createChunkCache(N)` calls changed to `createChunkCache({ chunkEvictRadius: N, wallDensity: 0.30 })`

## FIX 5: `evict()` called with wrong center (`src/renderer/world.js`)

- `getChunk(cx, cy, playerCx = cx, playerCy = cy)` — now accepts optional player chunk coords; passes them to `evict(playerCx, playerCy)` instead of using the chunk being loaded as the center
- `isWall(wx, wy, playerCx, playerCy)` — accepts player chunk coords and forwards to `getChunk`; defaults to chunk coords if omitted (safe for preload)
- `preload(pcx, pcy)` — passes `pcx, pcy` to `getChunk` as the player center
- `game.js` `tryMove` — computes `pcx/pcy` from `player.x/y` and passes to `cache.isWall`
- `game.js` render call — computes `pcx/pcy` and passes via lambda closure to `cache.isWall`

## Test Results

```
Test Files  2 passed (2)
      Tests 19 passed (19)
```

All tests green. No regressions.
