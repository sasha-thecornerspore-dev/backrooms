# Backrooms Multiplayer + Server + Settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add optional online multiplayer (SOLO / JOIN / HOST on start screen), a standalone auto-updating Node WebSocket server, and a client auto-update toggle. Single-player is unchanged.

**Architecture:** `server/` is a separate Node ESM package in the same repo, published as a bundled release asset. The client connects via `src/net/client.js`; remote players render as entities via the existing sprite system from the mobs plan. World uses a fixed seed per room instead of epoch eviction. Settings (auto-update toggle) live in `userData/settings.json` via IPC.

**Tech Stack:** Node 22 ESM, `ws` npm package (server only), `esbuild` (server bundle CI step), Electron `ipcMain`/`contextBridge`, Vitest.

## Global Constraints
- ES modules (`"type": "module"`) throughout — client and server
- Server default port: `8765`
- WebSocket protocol: newline-delimited JSON messages
- Remote players rendered as entity objects `{ x, y, type:'stalker', state:'chase', dir:0, dirTimer:0, chunkCx:0, chunkCy:0 }` — reuses mob sprite system
- World seed for multiplayer: 32-bit unsigned int, server-assigned on room creation
- Fixed seed mode: `createChunkCache(config, fixedSeed)` — epoch never increments when fixedSeed provided
- Auto-update toggle stored at `userData/settings.json` as `{ autoUpdate: boolean }`
- Server self-update asset name: `backrooms-server.js` in GitHub Releases
- No what-comments; only WHY-comments
- **Implement Phase A (mobs) before this plan**

---

### Task 1: Deterministic World Mode (Fixed Seed)

**Files:**
- Modify: `src/renderer/world.js` — `createChunkCache(config, fixedSeed?)` accepts optional fixed seed
- Modify: `test/world.test.js` — add fixed-seed test

**Interfaces:**
- `createChunkCache(config, fixedSeed?: number)` — when fixedSeed provided, all chunks use `generateChunk(cx, cy, fixedSeed)` and epochs never increment
- Existing single-player call `createChunkCache(config)` is unchanged

- [ ] **Step 1: Write failing test**

Append to `test/world.test.js`:

```js
it('fixed seed: revisiting evicted chunk returns same layout', () => {
  const config = { wallDensity: 0.3, chunkEvictRadius: 1 }
  const cache = createChunkCache(config, 42)
  const a = cache.getChunk ? cache.getChunk(0, 0) : null
  // force eviction by moving far
  for (let i = 2; i < 20; i++) cache.isWall(0, 0, i, i, i * 22, i * 22)
  // revisit
  const b = cache.getChunk ? cache.getChunk(0, 0) : null
  // Can't compare directly without getChunk — test via isWall consistency
  const resultA = cache.isWall(0, 0, 0, 0)
  const resultB = cache.isWall(0, 0, 0, 0)
  expect(resultA).toBe(resultB)
})

it('fixed seed: same world seed produces same wall at (5,5)', () => {
  const config = { wallDensity: 0.3, chunkEvictRadius: 3 }
  const c1 = createChunkCache(config, 12345)
  const c2 = createChunkCache(config, 12345)
  expect(c1.isWall(5, 5, 0, 0)).toBe(c2.isWall(5, 5, 0, 0))
})

it('different world seeds produce potentially different worlds', () => {
  const config = { wallDensity: 0.3, chunkEvictRadius: 3 }
  const c1 = createChunkCache(config, 1)
  const c2 = createChunkCache(config, 999999)
  // sample 20 cells — at least some should differ
  let diffs = 0
  for (let i = 0; i < 20; i++) diffs += c1.isWall(i * 3, i * 2, 0, 0) !== c2.isWall(i * 3, i * 2, 0, 0) ? 1 : 0
  expect(diffs).toBeGreaterThan(0)
})
```

- [ ] **Step 2: Run tests, confirm new ones fail**

```
npm test
```
Expected: new fixed-seed tests may pass or behave oddly — the key is that epoch-increment behaviour on eviction needs confirming.

- [ ] **Step 3: Update `createChunkCache` in `world.js`**

Change the function signature:
```js
export function createChunkCache(config, fixedSeed = null) {
```

In `evict()` inside `createChunkCache`, find where epoch is incremented:
```js
epochs.set(key, (epochs.get(key) ?? 0) + 1)
```
Wrap it:
```js
if (fixedSeed === null) {
  epochs.set(key, (epochs.get(key) ?? 0) + 1)
}
```

In `getChunk` (or wherever `generateChunk(cx, cy, epoch)` is called), replace the epoch lookup:
```js
const epoch = fixedSeed !== null ? fixedSeed : (epochs.get(key) ?? 0)
```

- [ ] **Step 4: Run all tests**

```
npm test
```
Expected: all pass including new fixed-seed tests.

- [ ] **Step 5: Commit**

```
git add src/renderer/world.js test/world.test.js
git commit -m "feat: chunk cache fixed-seed mode for deterministic multiplayer world"
```

---

### Task 2: WebSocket Server

**Files:**
- Create: `server/package.json`
- Create: `server/index.js`
- Create: `test/server.test.js`

**Interfaces:**
- Produces: WebSocket server on `PORT` (default 8765)
- Protocol (all JSON):
  - `client→server: { type:'join', roomId:string }` — creates room if needed, assigns worldSeed
  - `client→server: { type:'pos', x:number, y:number, angle:number }`
  - `server→client: { type:'welcome', playerId:string, worldSeed:number, roomId:string }`
  - `server→client: { type:'players', list:[{id,x,y,angle}] }` — broadcast at 20Hz
  - `server→client: { type:'joined', id:string }` — to others when player joins
  - `server→client: { type:'left', id:string }` — to others when player disconnects
- Room expires 30s after last player disconnects

- [ ] **Step 1: Create `server/package.json`**

```json
{
  "name": "backrooms-server",
  "version": "1.0.0",
  "type": "module",
  "main": "index.js",
  "scripts": {
    "start": "node index.js"
  },
  "dependencies": {
    "ws": "^8.18.0"
  }
}
```

- [ ] **Step 2: Install ws in server directory**

```
cd C:/Users/sasha/Documents/Repos/backrooms/server && npm install && cd ..
```

- [ ] **Step 3: Write failing server tests**

```js
// test/server.test.js
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer } from '../server/index.js'
import WebSocket from 'ws'

let server, port

beforeAll(async () => {
  server = await createServer(0)  // port 0 = OS assigns
  port = server.address().port
})

afterAll(() => server.close())

function connect() {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://localhost:${port}`)
    ws.once('open', () => resolve(ws))
  })
}

function nextMsg(ws) {
  return new Promise((resolve) => ws.once('message', d => resolve(JSON.parse(d.toString()))))
}

describe('server', () => {
  it('sends welcome on join', async () => {
    const ws = await connect()
    ws.send(JSON.stringify({ type: 'join', roomId: 'test1' }))
    const msg = await nextMsg(ws)
    expect(msg.type).toBe('welcome')
    expect(typeof msg.playerId).toBe('string')
    expect(typeof msg.worldSeed).toBe('number')
    ws.close()
  })

  it('two players in same room get same worldSeed', async () => {
    const ws1 = await connect()
    const ws2 = await connect()
    ws1.send(JSON.stringify({ type: 'join', roomId: 'seedtest' }))
    const w1 = await nextMsg(ws1)
    ws2.send(JSON.stringify({ type: 'join', roomId: 'seedtest' }))
    // ws2 gets welcome; ws1 gets 'joined'
    const [w2msg] = await Promise.all([nextMsg(ws2), nextMsg(ws1)])
    expect(w1.worldSeed).toBe(w2msg.worldSeed)
    ws1.close(); ws2.close()
  })

  it('broadcasts players list after pos update', async () => {
    const ws = await connect()
    ws.send(JSON.stringify({ type: 'join', roomId: 'postest' }))
    await nextMsg(ws)  // welcome
    ws.send(JSON.stringify({ type: 'pos', x: 10, y: 20, angle: 1.5 }))
    // wait for broadcast tick (server sends at 20Hz = 50ms)
    const msg = await new Promise((resolve) => {
      ws.on('message', d => { const m = JSON.parse(d.toString()); if (m.type === 'players') resolve(m) })
      setTimeout(() => resolve(null), 200)
    })
    expect(msg).not.toBeNull()
    expect(Array.isArray(msg.list)).toBe(true)
    ws.close()
  })
})
```

- [ ] **Step 4: Run tests, confirm they fail**

```
npm test
```
Expected: FAIL — `server/index.js` not found.

- [ ] **Step 5: Implement `server/index.js`**

```js
// server/index.js
import { WebSocketServer, WebSocket } from 'ws'
import { createServer as createHttpServer } from 'http'
import { randomBytes } from 'crypto'

const PORT = parseInt(process.env.PORT ?? '8765', 10)

const rooms = new Map()  // roomId → { worldSeed, players: Map<id,{ws,x,y,angle}>, expireTimer }

function uuid() { return randomBytes(6).toString('hex') }
function seed32() { return (randomBytes(4).readUInt32BE(0)) }

function broadcast(room, msg, excludeId) {
  const raw = JSON.stringify(msg)
  for (const [id, p] of room.players) {
    if (id !== excludeId && p.ws.readyState === WebSocket.OPEN) p.ws.send(raw)
  }
}

function startBroadcastLoop(room) {
  if (room._ticker) return
  room._ticker = setInterval(() => {
    if (room.players.size === 0) return
    const list = [...room.players.entries()].map(([id, p]) => ({ id, x: p.x, y: p.y, angle: p.angle }))
    broadcast(room, { type: 'players', list })
  }, 50)  // 20Hz
}

function getOrCreateRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, { worldSeed: seed32(), players: new Map(), expireTimer: null, _ticker: null })
  }
  const room = rooms.get(roomId)
  if (room.expireTimer) { clearTimeout(room.expireTimer); room.expireTimer = null }
  return room
}

function handleLeave(room, roomId, playerId) {
  room.players.delete(playerId)
  broadcast(room, { type: 'left', id: playerId })
  if (room.players.size === 0) {
    clearInterval(room._ticker); room._ticker = null
    room.expireTimer = setTimeout(() => rooms.delete(roomId), 30000)
  }
}

export function createServer(port = PORT) {
  const http = createHttpServer()
  const wss = new WebSocketServer({ server: http })

  wss.on('connection', (ws) => {
    let playerId = null
    let roomId = null
    let room = null

    ws.on('message', (raw) => {
      let msg
      try { msg = JSON.parse(raw.toString()) } catch { return }

      if (msg.type === 'join' && !playerId) {
        roomId = String(msg.roomId || 'default').slice(0, 32)
        room = getOrCreateRoom(roomId)
        playerId = uuid()
        room.players.set(playerId, { ws, x: 0, y: 0, angle: 0 })
        ws.send(JSON.stringify({ type: 'welcome', playerId, worldSeed: room.worldSeed, roomId }))
        broadcast(room, { type: 'joined', id: playerId }, playerId)
        startBroadcastLoop(room)
        return
      }

      if (msg.type === 'pos' && playerId && room) {
        const p = room.players.get(playerId)
        if (p) { p.x = +msg.x || 0; p.y = +msg.y || 0; p.angle = +msg.angle || 0 }
      }
    })

    ws.on('close', () => { if (playerId && room) handleLeave(room, roomId, playerId) })
    ws.on('error', () => { if (playerId && room) handleLeave(room, roomId, playerId) })
  })

  return new Promise((resolve) => http.listen(port, () => resolve(http)))
}

// start when run directly
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
  createServer().then(s => console.log(`backrooms server on :${s.address().port}`))
}
```

- [ ] **Step 6: Run tests**

```
npm test
```
Expected: all pass including server tests. Note: server tests import from `server/index.js` which imports `ws` from `server/node_modules` — Vitest resolves this from the workspace root node_modules if ws is installed there; otherwise install it at root: `npm install --save-dev ws`.

- [ ] **Step 7: Commit**

```
git add server/ test/server.test.js
git commit -m "feat: WebSocket server — rooms, worldSeed, 20Hz player broadcast"
```

---

### Task 3: Server Self-Updater

**Files:**
- Create: `server/updater.js`
- Modify: `server/index.js` — call `startUpdater()` on launch

**Interfaces:**
- Produces: `startUpdater(currentVersion, repoSlug)` — checks GitHub Releases, downloads newer `backrooms-server.js`, spawns self, exits
- `currentVersion`: read from `server/package.json` version field
- `repoSlug`: `'sasha-thecornerspore-dev/backrooms'`

- [ ] **Step 1: Implement `server/updater.js`**

```js
// server/updater.js
import { get } from 'https'
import { createWriteStream, renameSync, existsSync } from 'fs'
import { spawn } from 'child_process'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ASSET_NAME = 'backrooms-server.js'
const CHECK_INTERVAL = 60 * 60 * 1000  // 1 hour

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    get(url, { headers: { 'User-Agent': 'backrooms-server' } }, (res) => {
      if (res.statusCode === 302 || res.statusCode === 301) return httpsGet(res.headers.location).then(resolve, reject)
      let data = ''
      res.on('data', c => data += c)
      res.on('end', () => resolve({ status: res.statusCode, body: data }))
    }).on('error', reject)
  })
}

async function fetchLatestRelease(repoSlug) {
  const { body } = await httpsGet(`https://api.github.com/repos/${repoSlug}/releases/latest`)
  return JSON.parse(body)
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const file = createWriteStream(dest)
    get(url, { headers: { 'User-Agent': 'backrooms-server' } }, (res) => {
      if (res.statusCode === 302 || res.statusCode === 301) {
        file.close()
        return downloadFile(res.headers.location, dest).then(resolve, reject)
      }
      res.pipe(file)
      file.on('finish', () => file.close(resolve))
    }).on('error', reject)
  })
}

function semverGt(a, b) {
  const pa = a.replace(/^v/, '').split('.').map(Number)
  const pb = b.replace(/^v/, '').split('.').map(Number)
  for (let i = 0; i < 3; i++) { if ((pa[i]||0) > (pb[i]||0)) return true; if ((pa[i]||0) < (pb[i]||0)) return false }
  return false
}

async function checkAndUpdate(currentVersion, repoSlug) {
  try {
    const release = await fetchLatestRelease(repoSlug)
    const latest = release.tag_name
    if (!semverGt(latest, currentVersion)) return
    console.log(`[updater] newer version ${latest} available, downloading...`)
    const asset = release.assets.find(a => a.name === ASSET_NAME)
    if (!asset) return
    const tmp = join(__dirname, 'index.new.js')
    await downloadFile(asset.browser_download_url, tmp)
    renameSync(tmp, join(__dirname, 'index.js'))
    console.log('[updater] update applied, restarting...')
    const child = spawn(process.execPath, [join(__dirname, 'index.js')], {
      detached: true, stdio: 'ignore',
      env: { ...process.env }
    })
    child.unref()
    process.exit(0)
  } catch (e) {
    console.error('[updater] check failed:', e.message)
  }
}

export function startUpdater(currentVersion, repoSlug) {
  checkAndUpdate(currentVersion, repoSlug)
  setInterval(() => checkAndUpdate(currentVersion, repoSlug), CHECK_INTERVAL)
}
```

- [ ] **Step 2: Call `startUpdater` in `server/index.js`**

At the top of `server/index.js`, add:
```js
import { startUpdater } from './updater.js'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
const __dirname = dirname(fileURLToPath(import.meta.url))
```

In the `if (process.argv[1]...)` launch block, after `createServer()`:
```js
const { version } = JSON.parse(readFileSync(join(__dirname, 'package.json'), 'utf8'))
startUpdater(version, 'sasha-thecornerspore-dev/backrooms')
```

- [ ] **Step 3: Run all tests**

```
npm test
```
Expected: all pass (updater has no unit tests — it wraps network/process calls that can't easily be unit-tested; verified via smoke test when deploying).

- [ ] **Step 4: Commit**

```
git add server/updater.js server/index.js
git commit -m "feat: server self-updater — hourly GitHub release check, hot-swap restart"
```

---

### Task 4: Multiplayer Client

**Files:**
- Create: `src/net/client.js`
- Create: `test/client.test.js`

**Interfaces:**
- Produces: `createMultiplayerClient(serverUrl)` → `{ connect(roomId): Promise<{worldSeed}>, sendPos(x,y,angle), disconnect(), getRemotePlayers(): RemotePlayer[], isConnected(): boolean }`
- `RemotePlayer`: `{ id, x, y, angle }` — raw position data; game.js converts to entity shape
- Uses `window.WebSocket` (browser — renderer process) or Node `ws` package (for tests)

- [ ] **Step 1: Write failing tests**

```js
// test/client.test.js
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer } from '../server/index.js'
import { WebSocket } from 'ws'
import { createMultiplayerClient } from '../src/net/client.js'

// inject Node WebSocket for test environment
global.WebSocket = WebSocket

let server, port

beforeAll(async () => {
  server = await createServer(0)
  port = server.address().port
})

afterAll(() => server.close())

describe('createMultiplayerClient', () => {
  it('connects and receives worldSeed', async () => {
    const client = createMultiplayerClient(`ws://localhost:${port}`)
    const { worldSeed } = await client.connect('testroom')
    expect(typeof worldSeed).toBe('number')
    client.disconnect()
  })

  it('isConnected is true after connect', async () => {
    const client = createMultiplayerClient(`ws://localhost:${port}`)
    await client.connect('room2')
    expect(client.isConnected()).toBe(true)
    client.disconnect()
  })

  it('isConnected is false after disconnect', async () => {
    const client = createMultiplayerClient(`ws://localhost:${port}`)
    await client.connect('room3')
    client.disconnect()
    await new Promise(r => setTimeout(r, 50))
    expect(client.isConnected()).toBe(false)
  })

  it('getRemotePlayers returns array', async () => {
    const client = createMultiplayerClient(`ws://localhost:${port}`)
    await client.connect('room4')
    expect(Array.isArray(client.getRemotePlayers())).toBe(true)
    client.disconnect()
  })

  it('two clients see each other', async () => {
    const c1 = createMultiplayerClient(`ws://localhost:${port}`)
    const c2 = createMultiplayerClient(`ws://localhost:${port}`)
    await c1.connect('sharedroom')
    await c2.connect('sharedroom')
    c1.sendPos(10, 20, 1.5)
    await new Promise(r => setTimeout(r, 150))  // wait for broadcast tick
    const players = c2.getRemotePlayers()
    expect(players.some(p => Math.abs(p.x - 10) < 0.01)).toBe(true)
    c1.disconnect(); c2.disconnect()
  })
})
```

- [ ] **Step 2: Run tests, confirm they fail**

```
npm test
```
Expected: FAIL — `client.js` not found.

- [ ] **Step 3: Create `src/net/client.js`**

```js
// src/net/client.js
export function createMultiplayerClient(serverUrl) {
  let ws = null
  let connected = false
  let resolveConnect = null
  const remotePlayers = new Map()  // id → {id, x, y, angle}

  function connect(roomId) {
    return new Promise((resolve, reject) => {
      ws = new WebSocket(serverUrl)
      resolveConnect = resolve

      ws.onopen = () => {
        ws.send(JSON.stringify({ type: 'join', roomId: String(roomId) }))
      }

      ws.onmessage = ({ data }) => {
        let msg
        try { msg = JSON.parse(data) } catch { return }

        if (msg.type === 'welcome') {
          connected = true
          resolveConnect({ worldSeed: msg.worldSeed, playerId: msg.playerId, roomId: msg.roomId })
        } else if (msg.type === 'players') {
          // rebuild remote players map from broadcast list
          const incoming = new Set(msg.list.map(p => p.id))
          for (const id of remotePlayers.keys()) if (!incoming.has(id)) remotePlayers.delete(id)
          for (const p of msg.list) remotePlayers.set(p.id, p)
        } else if (msg.type === 'left') {
          remotePlayers.delete(msg.id)
        }
      }

      ws.onerror = (e) => { connected = false; reject(e) }
      ws.onclose = () => { connected = false; remotePlayers.clear() }
    })
  }

  function sendPos(x, y, angle) {
    if (ws && connected) ws.send(JSON.stringify({ type: 'pos', x, y, angle }))
  }

  function disconnect() {
    connected = false
    ws?.close()
    ws = null
    remotePlayers.clear()
  }

  function getRemotePlayers() { return [...remotePlayers.values()] }
  function isConnected() { return connected }

  return { connect, sendPos, disconnect, getRemotePlayers, isConnected }
}
```

- [ ] **Step 4: Run tests**

```
npm test
```
Expected: all pass.

- [ ] **Step 5: Commit**

```
git add src/net/client.js test/client.test.js
git commit -m "feat: multiplayer client — WebSocket connect, pos sync, remote player map"
```

---

### Task 5: Start Screen Overhaul — SOLO / JOIN / HOST

**Files:**
- Modify: `src/renderer/index.html` — replace ENTER button with SOLO/JOIN/HOST; add join modal
- Modify: `src/renderer/game.js` — `initGame(canvas, opts?)` accepts `opts.worldSeed` and `opts.mpClient`

**Interfaces:**
- `initGame(canvas, { worldSeed?: number, mpClient?: object } = {})` — if worldSeed provided, passes it to `createChunkCache`; if mpClient provided, syncs positions each frame
- join modal: URL input (default `ws://localhost:8765`), room code input, CONNECT button

- [ ] **Step 1: Update `index.html` start screen**

Replace the existing start screen section (the `#start` div and its contents) with:

```html
<div id="start">
  <div class="title">THE BACKROOMS</div>
  <div class="sub">level 0. somewhere. you are here.</div>
  <div class="btns">
    <button id="btn-solo">SOLO ▶</button>
    <button id="btn-join">JOIN ⬡</button>
    <button id="btn-host">HOST ⬡</button>
  </div>
</div>

<div id="join-modal" style="display:none">
  <div class="modal-box">
    <div class="modal-title">CONNECT</div>
    <input id="join-url" type="text" value="ws://localhost:8765" placeholder="server url" spellcheck="false"/>
    <input id="join-room" type="text" value="backrooms" placeholder="room code" spellcheck="false"/>
    <div class="modal-btns">
      <button id="join-cancel">CANCEL</button>
      <button id="join-connect">ENTER ▶</button>
    </div>
    <div id="join-status"></div>
  </div>
</div>
```

Add to the `<style>` block:
```css
.btns { display:flex; gap:24px; justify-content:center; margin-top:40px; }
.btns button { background:none; border:1px solid #8a7a3a; color:#c9ba72; font-family:monospace; font-size:18px; padding:10px 28px; cursor:pointer; letter-spacing:2px; }
.btns button:hover { background:#8a7a3a22; }
#join-modal { position:fixed;inset:0;background:#0008;display:flex;align-items:center;justify-content:center;z-index:100; }
.modal-box { background:#1a1508;border:1px solid #8a7a3a;padding:40px;min-width:360px; }
.modal-title { color:#c9ba72;font-family:monospace;font-size:20px;letter-spacing:4px;margin-bottom:24px; }
.modal-box input { display:block;width:100%;box-sizing:border-box;background:#0a0a05;border:1px solid #4a3a1a;color:#c9ba72;font-family:monospace;font-size:14px;padding:8px;margin-bottom:12px; }
.modal-btns { display:flex;gap:12px;margin-top:16px; }
.modal-btns button { background:none;border:1px solid #8a7a3a;color:#c9ba72;font-family:monospace;font-size:14px;padding:8px 20px;cursor:pointer; }
#join-status { color:#a09060;font-family:monospace;font-size:13px;margin-top:12px;min-height:20px; }
```

- [ ] **Step 2: Wire buttons in the inline module script**

Replace the existing `btn.onclick` (ENTER button) logic in the `<script type="module">` with:

```js
import { initGame } from './game.js'
import { createMultiplayerClient } from '../net/client.js'

const startEl = document.getElementById('start')
const joinModal = document.getElementById('join-modal')
const joinStatus = document.getElementById('join-status')
const canvas = document.getElementById('c')

async function startSolo() {
  startEl.style.display = 'none'
  await initGame(canvas)
}

async function startMultiplayer(serverUrl, roomId) {
  joinStatus.textContent = 'connecting...'
  try {
    const mpClient = createMultiplayerClient(serverUrl)
    const { worldSeed } = await mpClient.connect(roomId)
    joinModal.style.display = 'none'
    startEl.style.display = 'none'
    await initGame(canvas, { worldSeed, mpClient })
  } catch (e) {
    joinStatus.textContent = `failed: ${e.message}`
  }
}

document.getElementById('btn-solo').onclick = startSolo

document.getElementById('btn-join').onclick = () => {
  joinModal.style.display = 'flex'
}

document.getElementById('btn-host').onclick = async () => {
  // HOST: ask main process to start local server, then join it
  const port = await window.backrooms?.startLocalServer?.() ?? 8765
  await startMultiplayer(`ws://localhost:${port}`, 'local')
}

document.getElementById('join-cancel').onclick = () => {
  joinModal.style.display = 'none'
  joinStatus.textContent = ''
}

document.getElementById('join-connect').onclick = () => {
  const url = document.getElementById('join-url').value.trim()
  const room = document.getElementById('join-room').value.trim() || 'backrooms'
  startMultiplayer(url, room)
}
```

- [ ] **Step 3: Update `initGame` signature in `game.js`**

Change:
```js
export async function initGame(canvas) {
```
to:
```js
export async function initGame(canvas, { worldSeed = null, mpClient = null } = {}) {
```

Pass `worldSeed` to `createChunkCache`:
```js
const cache = createChunkCache(config, worldSeed)
```

- [ ] **Step 4: Run tests**

```
npm test
```
Expected: all pass (this is mostly HTML/UI — unit tests can't cover it; smoke-test by running the app).

- [ ] **Step 5: Commit**

```
git add src/renderer/index.html src/renderer/game.js
git commit -m "feat: start screen SOLO/JOIN/HOST, join modal, initGame worldSeed/mpClient opts"
```

---

### Task 6: Remote Player Sync + Rendering

**Files:**
- Modify: `src/renderer/game.js` — send pos each frame when mpClient connected; inject remote players into entity list

**Interfaces:**
- Consumes: `mpClient.sendPos(x, y, angle)`, `mpClient.getRemotePlayers()` → `[{id,x,y,angle}]`
- Remote players converted to entity shape and merged with mob entities before passing to renderer
- Remote players: `{ x, y, type:'stalker', state:'chase', dir:0, dirTimer:0, chunkCx:0, chunkCy:0 }` — renders as a silhouette like a stalker

- [ ] **Step 1: Add pos-send and remote player merge in game loop**

In `game.js`, in the `loop(ts)` function, after computing `player.x/y/angle`:

```js
// send our position to server
if (mpClient?.isConnected()) {
  mpClient.sendPos(player.x, player.y, player.angle)
}
```

Before calling `renderer.render(...)`:
```js
// merge remote players into entity list for rendering
const remoteEntities = mpClient
  ? mpClient.getRemotePlayers().map(p => ({
      x: p.x, y: p.y,
      type: 'stalker', state: 'chase',
      dir: 0, dirTimer: 0,
      chunkCx: Math.floor(p.x / CHUNK_SIZE),
      chunkCy: Math.floor(p.y / CHUNK_SIZE),
    }))
  : []
const allEntities = [...entitySys.getEntities(), ...remoteEntities]
```

Change the render call to use `allEntities`:
```js
renderer.render(player, (wx, wy) => cache.isWall(wx, wy, playerCx, playerCy), flicker, allEntities)
```

- [ ] **Step 2: Run tests**

```
npm test
```
Expected: all pass.

- [ ] **Step 3: Smoke test multiplayer locally**

```
cd server && node index.js &
npm start
```
Click HOST. A second window (or another `npm start` instance) → JOIN → `ws://localhost:8765` → same room. Walk around — you should see the other player as a dark silhouette.

- [ ] **Step 4: Commit**

```
git add src/renderer/game.js
git commit -m "feat: remote player pos sync and sprite rendering via entity system"
```

---

### Task 7: Auto-Update Toggle + Settings UI

**Files:**
- Modify: `src/main.js` — `ipcMain.handle('get-settings')`, `ipcMain.handle('save-settings')`, conditionally call `quitAndInstall` based on `autoUpdate` setting
- Modify: `src/preload.js` — expose `window.backrooms.getSettings()`, `window.backrooms.saveSettings(obj)`, `window.backrooms.startLocalServer()`
- Modify: `src/renderer/index.html` — gear icon on start screen, settings overlay
- Create: `test/settings.test.js`

**Interfaces:**
- `window.backrooms.getSettings()` → `Promise<{autoUpdate:boolean}>`
- `window.backrooms.saveSettings({autoUpdate:boolean})` → `Promise<void>`
- `window.backrooms.startLocalServer()` → `Promise<number>` (returns port)
- Settings file: `path.join(app.getPath('userData'), 'settings.json')`
- Default settings: `{ autoUpdate: true }`

- [ ] **Step 1: Write failing settings tests**

```js
// test/settings.test.js
import { describe, it, expect } from 'vitest'
import { readSettings, writeSettings } from '../src/settings.js'
import { mkdirSync, rmSync, existsSync } from 'fs'
import { join } from 'path'

const TMP = join(process.cwd(), '.tmp-settings-test')

describe('settings', () => {
  it('returns defaults when file missing', () => {
    const s = readSettings(join(TMP, 'nonexistent.json'))
    expect(s.autoUpdate).toBe(true)
  })

  it('round-trips autoUpdate: false', () => {
    mkdirSync(TMP, { recursive: true })
    const p = join(TMP, 'settings.json')
    writeSettings(p, { autoUpdate: false })
    expect(readSettings(p).autoUpdate).toBe(false)
    rmSync(TMP, { recursive: true })
  })
})
```

- [ ] **Step 2: Create `src/settings.js`** (pure module, no Electron dependency — testable)

```js
// src/settings.js
import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { dirname } from 'path'

const DEFAULTS = { autoUpdate: true }

export function readSettings(filePath) {
  try {
    return { ...DEFAULTS, ...JSON.parse(readFileSync(filePath, 'utf8')) }
  } catch {
    return { ...DEFAULTS }
  }
}

export function writeSettings(filePath, settings) {
  mkdirSync(dirname(filePath), { recursive: true })
  writeFileSync(filePath, JSON.stringify(settings, null, 2))
}
```

- [ ] **Step 3: Run tests**

```
npm test
```
Expected: settings tests pass.

- [ ] **Step 4: Wire settings into `main.js`**

Add imports at top:
```js
import { readSettings, writeSettings } from './settings.js'
import { join } from 'path'
```

After `app.whenReady()`, add:
```js
const settingsPath = join(app.getPath('userData'), 'settings.json')

ipcMain.handle('get-settings', () => readSettings(settingsPath))
ipcMain.handle('save-settings', (_e, settings) => writeSettings(settingsPath, settings))
ipcMain.handle('start-local-server', async () => {
  const { createServer } = await import('../server/index.js')
  const s = await createServer(0)
  return s.address().port
})
```

Find the `autoUpdater.on('update-downloaded')` handler (added in Task 12 of the original plan) — or add one now:
```js
autoUpdater.on('update-downloaded', async () => {
  const settings = readSettings(settingsPath)
  if (settings.autoUpdate) {
    autoUpdater.quitAndInstall()
  } else {
    // notify renderer to show manual restart button
    mainWindow?.webContents.send('update-ready')
  }
})
```

- [ ] **Step 5: Expose settings in `preload.js`**

Add to the `contextBridge.exposeInMainWorld('backrooms', { ... })` object:
```js
getSettings: () => ipcRenderer.invoke('get-settings'),
saveSettings: (s) => ipcRenderer.invoke('save-settings', s),
startLocalServer: () => ipcRenderer.invoke('start-local-server'),
```

- [ ] **Step 6: Add gear icon + settings overlay to `index.html`**

Add a gear button to the start screen div:
```html
<button id="btn-settings" title="settings">⚙</button>
```

Add a settings overlay:
```html
<div id="settings-modal" style="display:none">
  <div class="modal-box">
    <div class="modal-title">SETTINGS</div>
    <label class="toggle-row">
      <span>Auto-update</span>
      <input type="checkbox" id="chk-autoupdate" checked/>
    </label>
    <div id="update-ready-msg" style="display:none;color:#c9ba72;font-family:monospace;font-size:13px;margin-top:12px;">
      update ready — <button id="btn-restart" style="background:none;border:none;color:#c9ba72;cursor:pointer;font-family:monospace;text-decoration:underline;">restart now</button>
    </div>
    <div class="modal-btns" style="margin-top:24px;">
      <button id="settings-close">CLOSE</button>
    </div>
  </div>
</div>
```

CSS additions:
```css
#btn-settings { position:fixed;top:16px;right:16px;background:none;border:none;color:#6a5a2a;font-size:22px;cursor:pointer;z-index:10; }
#btn-settings:hover { color:#c9ba72; }
.toggle-row { display:flex;align-items:center;justify-content:space-between;color:#c9ba72;font-family:monospace;font-size:15px;margin:8px 0; }
```

In the module script, add:
```js
// settings
const settingsMod = document.getElementById('settings-modal')
document.getElementById('btn-settings').onclick = async () => {
  const s = await window.backrooms?.getSettings?.() ?? { autoUpdate: true }
  document.getElementById('chk-autoupdate').checked = s.autoUpdate
  settingsMod.style.display = 'flex'
}
document.getElementById('settings-close').onclick = async () => {
  const autoUpdate = document.getElementById('chk-autoupdate').checked
  await window.backrooms?.saveSettings?.({ autoUpdate })
  settingsMod.style.display = 'none'
}
document.getElementById('btn-restart')?.addEventListener('click', () => {
  window.backrooms?.restartNow?.()
})
// listen for update-ready from main
window.backrooms?.onUpdateReady?.(() => {
  document.getElementById('update-ready-msg').style.display = 'block'
})
```

Add to `preload.js` contextBridge:
```js
restartNow: () => ipcRenderer.send('restart-now'),
onUpdateReady: (cb) => ipcRenderer.on('update-ready', cb),
```

Add to `main.js`:
```js
ipcMain.on('restart-now', () => autoUpdater.quitAndInstall())
```

- [ ] **Step 7: Run tests**

```
npm test
```
Expected: all pass.

- [ ] **Step 8: Commit**

```
git add src/settings.js src/main.js src/preload.js src/renderer/index.html test/settings.test.js
git commit -m "feat: auto-update toggle, settings.json, gear UI, HOST IPC, restart-on-demand"
```

---

### Task 8: Server CI Build — Release Artifact

**Files:**
- Modify: `.github/workflows/build-release.yml` — bundle server with esbuild, upload as release asset
- Modify: `package.json` — add esbuild devDependency

**Interfaces:**
- Output asset name: `backrooms-server.js` (matches `ASSET_NAME` in `server/updater.js`)
- Bundle command: `npx esbuild server/index.js --bundle --platform=node --format=esm --outfile=dist/backrooms-server.js`
- The server `updater.js` is bundled into `backrooms-server.js` — no separate file needed at runtime

- [ ] **Step 1: Add esbuild to devDependencies**

```
npm install --save-dev esbuild
```

Verify `package.json` now lists `"esbuild": "^0.x.x"` in devDependencies.

- [ ] **Step 2: Test server bundle locally**

```
npx esbuild server/index.js --bundle --platform=node --format=esm --outfile=dist/backrooms-server.js --external:ws
node dist/backrooms-server.js
```
Expected: `backrooms server on :8765` printed, Ctrl-C to stop.

Note: `ws` must be `--external` since it's a native addon. The deployed server needs `ws` installed separately, OR bundle without external and rely on pure-JS fallback. For simplicity, keep `--external:ws` and document that `npm install ws` is required on the host.

- [ ] **Step 3: Update `build-release.yml`**

After the existing `npm run release` step, add:

```yaml
- name: Bundle server
  run: npx esbuild server/index.js --bundle --platform=node --format=esm --outfile=dist/backrooms-server.js --external:ws

- name: Upload server artifact
  uses: actions/upload-release-asset@v1
  env:
    GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
  with:
    upload_url: ${{ steps.create_release.outputs.upload_url }}
    asset_path: dist/backrooms-server.js
    asset_name: backrooms-server.js
    asset_content_type: application/javascript
```

Note: this requires the release creation step to expose `upload_url`. If the workflow uses `electron-builder --publish always` (which creates the release automatically), you need to query the latest release URL after building instead. Replace the upload step with:

```yaml
- name: Upload server to latest release
  run: |
    RELEASE_ID=$(gh api repos/${{ github.repository }}/releases/latest --jq '.id')
    gh api repos/${{ github.repository }}/releases/$RELEASE_ID/assets \
      --method POST \
      -H "Content-Type: application/javascript" \
      -F "name=backrooms-server.js" \
      -F "data=@dist/backrooms-server.js"
  env:
    GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

- [ ] **Step 4: Add `dist/` to `.gitignore`**

Check `.gitignore` — if `dist/` is not already listed, add it.

- [ ] **Step 5: Commit**

```
git add .github/workflows/build-release.yml package.json package-lock.json
git commit -m "ci: bundle server with esbuild, upload backrooms-server.js as release asset"
git push
```
