# The Backrooms — Mobs + Multiplayer Design Spec
*2026-06-29*

---

## Phase A: NPC Mobs

### Overview
Billboard-sprite entities rendered in the DDA raycaster. Two types: **wanderer** (drifts, flees player) and **stalker** (locks on silently). Spawned per-chunk via seeded RNG, one max per chunk. No pathfinding — entities move in straight lines, redirect on wall collision. Deeply unsettling, not cartoony.

### Entity Shape
```js
{ x, y, type: 'wanderer'|'stalker', state: 'idle'|'chase'|'flee', dir: number, dirTimer: number, chunkCx: number, chunkCy: number }
```

### Spawn Logic
`entityRng(cx, cy)` — deterministic per-chunk. 1 in 8 chunks spawns an entity. Type: 1 in 4 chunks with entity gets a stalker, rest wanderers. Entities spawn near chunk midpoint. The entity system pools up to 20 entities max, evicts entities whose chunk is beyond `chunkEvictRadius + 2`.

### AI
- **Wanderer:** moves at 0.8 units/sec. `dirTimer` counts down (3–7s random), picks new dir. If wall ahead within 0.4 units, picks new dir immediately. If player within 6 units → state='flee', dir = away from player.
- **Stalker:** if player within 24 units → dir toward player, speed 1.2 units/sec. Otherwise slow wander (0.4 units/sec). Never flees.

### Sprite Rendering
After the wall pass, `renderer.js` loops entities sorted by distance (far→near). For each:
- Compute `entityAngle` relative to player, skip if outside FOV
- Project: `screenX = W/2 + Math.tan(relAngle) * (W / (2 * Math.tan(FOV/2))))`  
- `spriteH = Math.floor(H / correctedDist)`
- For each column in sprite width: if `zbuffer[col] > correctedDist`, draw dark silhouette pixel
- Fog-fade same formula as walls

`render(player, isWallFn, flickerIntensity, entities)` — entities array added as 4th parameter.

---

## Phase B: Multiplayer + Server + Settings

### Start Screen
Three buttons replace the single ENTER: **SOLO ▶**, **JOIN ⬡**, **HOST ⬡**. SOLO works exactly as before. JOIN prompts for server URL (default `ws://localhost:8765`) and room code. HOST starts the local server process and connects to it as the first player.

### Multiplayer World
In multiplayer, the chunk cache uses a **fixed world seed** (sent by server on join) instead of epoch-based eviction. `createChunkCache(config, fixedSeed?)` — if `fixedSeed` provided, epochs never increment and `generateChunk(cx, cy, fixedSeed)` is always called. Single-player unchanged.

### Protocol (WebSocket, newline-delimited JSON)
```
client→server: { type:'join', roomId, playerName? }
client→server: { type:'pos', x, y, angle }

server→client: { type:'welcome', playerId, worldSeed, roomId }
server→client: { type:'players', list:[{id,x,y,angle}] }
server→client: { type:'joined', id }
server→client: { type:'left', id }
```
Server broadcasts `players` list at 20Hz. No authoritative physics — client-side movement, server relays.

### Server (`server/`)
Standalone Node.js 22 ESM package. `server/index.js` — HTTP + `ws` WebSocket server. `server/updater.js` — checks GitHub Releases API on startup + hourly, downloads newer `backrooms-server.js` asset, spawns detached replacement process, exits. `server/package.json` — `{ "type": "module", "main": "index.js" }`.

Default port: `8765`. Rooms created on first join with random `worldSeed`. Rooms expire after all players disconnect + 30s.

### Remote Players
Rendered as stalker-type entities by the existing sprite system. The multiplayer client returns remote players as `Entity[]` objects passed alongside mob entities to `renderer.render()`. No separate rendering code.

### Auto-Update Toggle
`userData/settings.json` — `{ autoUpdate: true }`. Exposed via `contextBridge` → `window.backrooms.getSettings()` / `window.backrooms.saveSettings(obj)`. Settings UI: gear icon on start screen, single toggle. When `autoUpdate: false`, `autoUpdater.on('update-downloaded')` fires but `quitAndInstall()` is not called — a manual "Restart to update" button appears instead.

### Server CI Build
`build-release.yml` extended: after the Electron NSIS build, a second step bundles `server/` into a single `backrooms-server.js` via `esbuild --bundle --platform=node` and uploads it as a release asset. The server auto-updater downloads this asset by name.
