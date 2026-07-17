# Phase 0 — Relay Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make online co-op honour the player's anchor for the first time, and stop the relay deleting the world when the room empties.

**Architecture:** The seed decision currently lives in `Room.fetch()` — the WebSocket upgrade — which runs *before* the client's `join` message exists, so the seed the client sends can never be read. Move the decision into the `join` handler and extract the whole policy into one pure function, `roomSeed(requested, stored)`, in a file plain vitest can import. `relay.js` keeps only the plumbing.

**Tech Stack:** Cloudflare Worker + Durable Object (WebSocket Hibernation API, SQLite-backed), vitest (`environment: 'node'`), wrangler.

## Global Constraints

- **Tests:** vitest, `environment: 'node'`, `include: ['test/**/*.test.js']`. **Zero mocks** — house style. 99 tests currently pass; they must all still pass.
- **No new dependencies.** Do **not** add `@cloudflare/vitest-pool-workers` — it forces a config split and breaks the zero-mock style.
- **Do not touch the electron version in this plan** — it is `^33.4.11` and is simply out of scope here. *(Not because it is dangerous: electron was **wrongly blamed** for the hard-lock. The bump was tested 2026-07-10 and reverted; the real cause — `getChunk` returning `undefined` after `evict`, crashing `isWall` — was found the next day in `5a02abf`. That bug hard-locked the game on **any** electron version, so it was almost certainly what froze the electron test too. PR #2's CVE bump is very likely safe and should be re-evaluated on its own merits, not blocked by this misattribution.)*
- ES modules throughout (`"type": "module"`).
- **Seeds are uint32, `> 0` and `<= 0xFFFFFFFF`, and never 0.** `world.js:191` treats `0` as both "fixed seed" and "unseeded first visit" — a 0 seed silently produces the drift world while claiming to be seeded. This project has hit it three times.
- **The relay is deployed and live** at `wss://backrooms-relay.jeff-schatz112.workers.dev`. A passing unit test does not prove the anchor survives the wire. Task 5 is not optional.
- Never skip hooks or bypass signing on commits.

## File Structure

| File | Responsibility |
|---|---|
| `relay/seed.js` | **New.** Pure seed policy: `roomSeed(requested, stored)`, `isValidSeed(v)`. Zero imports. The only file that decides what world a room has. |
| `test/relay-seed.test.js` | **New.** Unit tests for the above. |
| `relay/relay.js` | **Modify.** Plumbing only. Imports `roomSeed`; resolves the seed in `join`, not `fetch`; never deletes it. |
| `src/renderer/index.html` | **Modify.** One `applyIdentity({anchor})` called from all three start paths. |
| `_relaytest.mjs` | **Modify.** Assert the received seed equals the **requested** seed, against a fresh room. |

---

### Task 1: The seed policy, as a pure function

**Files:**
- Create: `relay/seed.js`
- Test: `test/relay-seed.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `roomSeed(requested: unknown, stored: unknown) -> number` (uint32, 1..0xFFFFFFFF, never 0) and `isValidSeed(v: unknown) -> boolean`. Task 2 imports both.

**Why this file exists:** `relay.js:12` does `import { DurableObject } from 'cloudflare:workers'`, which cannot resolve under vitest's `node` environment. That is exactly why `relay.js` has zero tests, and exactly why Defect A shipped unnoticed. Pull the decision out where it can be tested.

- [ ] **Step 1: Write the failing test**

Create `test/relay-seed.test.js`:

```js
import { describe, it, expect } from 'vitest'
import { roomSeed, isValidSeed } from '../relay/seed.js'

describe('isValidSeed', () => {
  it('accepts uint32 seeds above zero', () => {
    expect(isValidSeed(1)).toBe(true)
    expect(isValidSeed(12345)).toBe(true)
    expect(isValidSeed(0xFFFFFFFF)).toBe(true)
  })

  it('rejects 0, negatives, non-integers, junk and out-of-range', () => {
    // 0 is reserved: world.js treats it as BOTH "fixed seed" and "no seed".
    expect(isValidSeed(0)).toBe(false)
    expect(isValidSeed(-1)).toBe(false)
    expect(isValidSeed(1.5)).toBe(false)
    expect(isValidSeed(0x100000000)).toBe(false)
    expect(isValidSeed(NaN)).toBe(false)
    expect(isValidSeed('abc')).toBe(false)
    expect(isValidSeed(null)).toBe(false)
    expect(isValidSeed(undefined)).toBe(false)
  })
})

describe('roomSeed', () => {
  it('honours a requested seed when the room has no world yet', () => {
    // THE DEFECT: the relay never read the client's requested seed, so every
    // online game was Math.random() while the HUD reported the real anchor.
    expect(roomSeed(12345, null)).toBe(12345)
  })

  it('lets a stored seed win over a requested one — the first joiner fixes the world', () => {
    expect(roomSeed(12345, 999)).toBe(999)
  })

  it('returns the stored seed when nothing is requested', () => {
    expect(roomSeed(null, 999)).toBe(999)
  })

  it('agrees with itself for the same stored value', () => {
    // The real postcondition. "Returns random" is NOT testable and PASSES
    // WHILE BROKEN — that is the exact shape of the blind spot Defect A
    // lived in. Assert agreement instead.
    expect(roomSeed(null, 999)).toBe(roomSeed(null, 999))
    expect(roomSeed(7, 999)).toBe(roomSeed(42, 999))
  })

  it('mints a valid seed when neither is usable', () => {
    for (const junk of [0, -1, 1.5, NaN, 'abc', 0x100000000, null, undefined]) {
      expect(isValidSeed(roomSeed(junk, null))).toBe(true)
    }
  })

  it('never returns 0', () => {
    expect(roomSeed(0, null)).not.toBe(0)
    expect(roomSeed(-1, null)).not.toBe(0)
    for (let i = 0; i < 2000; i++) expect(roomSeed(null, null)).not.toBe(0)
  })

  it('coerces numeric strings, because JSON is untrusted', () => {
    expect(roomSeed('12345', null)).toBe(12345)
    expect(roomSeed(null, '999')).toBe(999)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/relay-seed.test.js`
Expected: FAIL — `Failed to resolve import "../relay/seed.js"`.

- [ ] **Step 3: Write the minimal implementation**

Create `relay/seed.js`:

```js
// relay/seed.js — what world does a room have?
//
// Extracted from relay.js so plain vitest can import it: relay.js imports
// 'cloudflare:workers', which cannot resolve under environment:'node'. That
// untestability is why the relay silently threw away every anchor seed.
//
// No imports. Pure. The only place the seed decision is made.

const MAX = 0xFFFFFFFF

// Seeds are uint32 and never 0 — world.js:191 reads 0 as both "fixed seed"
// and "unseeded first visit", so a 0 seed produces the drift world while
// claiming to be seeded.
export function isValidSeed(v) {
  if (v === null || v === undefined || v === '') return false
  const n = Number(v)
  return Number.isInteger(n) && n > 0 && n <= MAX
}

// Precedence: the room's existing world wins, then the joiner's request,
// then a fresh one. The first player into a virgin room fixes its world.
export function roomSeed(requested, stored) {
  if (isValidSeed(stored)) return Number(stored)
  if (isValidSeed(requested)) return Number(requested)
  return Math.floor(Math.random() * MAX) + 1   // 1 .. 0xFFFFFFFF, never 0
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/relay-seed.test.js`
Expected: PASS — 8 tests.

- [ ] **Step 5: Run the whole suite**

Run: `npm test`
Expected: PASS — all pre-existing tests plus the 8 new ones.

- [ ] **Step 6: Commit**

```bash
git add relay/seed.js test/relay-seed.test.js
git commit -m "feat: extract the relay's seed policy into a testable pure function

relay.js imports 'cloudflare:workers', unresolvable under vitest's node
environment. That is why it has zero tests, and why it silently discarded
every anchor seed. roomSeed(requested, stored) is the whole decision, in a
file plain vitest can import."
```

---

### Task 2: Make the relay read the seed the client actually sends

**Files:**
- Modify: `relay/relay.js` — remove seed logic from `fetch()` (`:15-33`), resolve it in the `join` handler (`:40-46`), delete the cleanup (`:62-65`).

**Interfaces:**
- Consumes: `roomSeed(requested, stored)` from `relay/seed.js` (Task 1).
- Produces: the `welcome` frame now carries the honoured seed and the real `roomId`. `src/net/client.js:41` already consumes both — no client change needed.

**The core insight:** the seed is currently decided in `fetch()`, which is the WebSocket *upgrade*. The client's `join` message — the only thing carrying `worldSeed` (`client.js:31`) — does not exist yet at that point. So no guard fix in `fetch()` can ever work. The decision must move to `join`.

**Concurrency:** two clients joining at once is safe. Durable Objects have **input gates** — while a storage operation is in flight, no other events are delivered to the object. The `get` → `put` window cannot interleave.

- [ ] **Step 1: Add the import**

In `relay/relay.js`, directly below the existing `import { DurableObject } from 'cloudflare:workers'` (line 12):

```js
import { roomSeed } from './seed.js'
```

- [ ] **Step 2: Strip the seed logic out of `fetch()`**

Replace the whole `async fetch(request)` method (lines 15–33) with:

```js
  async fetch(request) {
    // No seed logic here: this is the WebSocket upgrade, and the join message
    // that carries the client's requested seed has not arrived yet. The world
    // is decided in webSocketMessage('join') instead.
    const pair = new WebSocketPair()
    const client = pair[0], server = pair[1]
    const id = crypto.randomUUID().slice(0, 12)
    server.serializeAttachment({ id, name: 'wanderer', x: 0, y: 0, angle: 0 })
    this.ctx.acceptWebSocket(server)
    return new Response(null, { status: 101, webSocket: client })
  }
```

The now-unused `const url = new URL(request.url)` and `const seedParam = ...` go with it. Note `request` is no longer read — keep the parameter name for clarity.

- [ ] **Step 3: Resolve the seed in the join handler**

Replace the `if (msg.type === 'join') { ... }` branch (lines 40–46) with:

```js
    if (msg.type === 'join') {
      att.name = String(msg.name || 'wanderer').slice(0, 24)
      ws.serializeAttachment(att)
      const roomId = String(msg.roomId || 'default').slice(0, 32)
      // The first joiner into a virgin room fixes its world — from their
      // anchor if they sent one. Input gates make this get/put atomic.
      const stored = await this.ctx.storage.get('seed')
      const seed = roomSeed(msg.worldSeed, stored)
      if (stored == null) await this.ctx.storage.put('seed', seed)
      ws.send(JSON.stringify({ type: 'welcome', playerId: att.id, worldSeed: seed, roomId }))
      this.broadcast({ type: 'joined', id: att.id, name: att.name }, att.id)
      this.pushPlayers()
    } else if (msg.type === 'pos') {
```

This fixes **Defect A** (`msg.worldSeed` is now read, mirroring `server/index.js:72-77`) and **Defect C** (`roomId` was hardcoded `''`) together.

- [ ] **Step 4: Stop deleting the world**

Replace `async webSocketClose(ws)` (lines 59–66) with:

```js
  async webSocketClose(ws) {
    const att = ws.deserializeAttachment() || {}
    this.broadcast({ type: 'left', id: att.id, name: att.name }, att.id)
    // The world is NEVER forgotten. A room is a persistent place. The old
    // storage.delete('seed') here meant the same room code produced a
    // different maze tomorrow — and it blocks all persistent territory.
  }
```

- [ ] **Step 5: Verify nothing else referenced the removed code**

Run: `grep -n "seedParam\|storage.delete\|roomId: ''" relay/relay.js`
Expected: **no output.** If anything prints, it was missed.

Run: `npm test`
Expected: PASS — unchanged. (`relay.js` has no unit tests; this proves nothing broke elsewhere. Task 5 is what proves this task.)

- [ ] **Step 6: Commit**

```bash
git add relay/relay.js
git commit -m "fix: relay honours the anchor seed and stops deleting the world

Two live defects.

The relay never read msg.worldSeed. client.js:31 has always sent it, and
server/index.js:72-77 honours it correctly, but the relay resolved the seed
in fetch() — the WebSocket upgrade, before the join message exists — and only
from a ?seed= param that index.html never sends. Number(null) is 0, the guard
rejected it, and every online game fell to Math.random() while game.js:216
reported the player's real coordinates. Move the decision into join.

And webSocketClose deleted the seed when the room emptied, so the same room
code gave a different maze tomorrow. That one line blocks all persistent
territory. The world is now never forgotten.

Also echoes the real roomId instead of ''."
```

---

### Task 3: One `applyIdentity`, called from all three start paths

**Files:**
- Modify: `src/renderer/index.html` — `takeAnchor()` at `:381-386`, the CONTINUE handler at `:471-475`.

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `applyIdentity({anchor}) -> {lat,lng}|null`. Later phases add `sectorId` to the same bag.

**The defect:** `currentAnchor` is assigned **only** inside `takeAnchor()` (`:382`), which the CONTINUE handler never calls. A resumed anchored run passes `savedRun.anchor` into `initGame`, so the drift HUD works — but `currentAnchor` stays `null`, `#locate-row` stays hidden, and `btn-locate` does nothing.

**Why one function and not three fixes:** `index.html` has **zero test coverage** (vitest runs `environment: 'node'`, no jsdom). Untestable risk must live in the smallest possible surface. Later phases add a fourth caller; three parallel copies would drift.

- [ ] **Step 1: Replace `takeAnchor` with `applyIdentity` + a thin wrapper**

Replace lines 381–386 of `src/renderer/index.html`:

```js
    // The single place currentAnchor and the locate row are set. Called from
    // all three start paths — solo, online, continue — so a resumed run gets
    // a working "locate your body" button instead of a dead one.
    function applyIdentity({ anchor }) {
      currentAnchor = anchor || null
      const locateRow = document.getElementById('locate-row')
      if (locateRow) locateRow.style.display = currentAnchor ? 'block' : 'none'
      return currentAnchor
    }

    function takeAnchor() {
      return applyIdentity({ anchor: parseAnchor(anchorInput.value) })
    }
```

`startSolo` (`:389`) and `startMultiplayer` (`:406`) already call `takeAnchor()`, so they route through `applyIdentity` unchanged.

- [ ] **Step 2: Route CONTINUE through it**

Replace the CONTINUE handler body (lines 471–475):

```js
      cont.onclick = async () => {
        startStatus.textContent = ''
        const anchor = applyIdentity({ anchor: savedRun.anchor ?? null })
        startEl.style.display = 'none'
        await initGame(canvas, { worldSeed: savedRun.worldSeed ?? null, anchor, resume: savedRun })
      }
```

- [ ] **Step 3: Verify there is exactly one assignment site**

Run: `grep -n "currentAnchor = \|applyIdentity\|takeAnchor" src/renderer/index.html`
Expected: exactly **one** `currentAnchor = ` (inside `applyIdentity`), one `applyIdentity` definition, three call sites (`takeAnchor`, CONTINUE, and the `startSolo`/`startMultiplayer` pair via `takeAnchor`).

- [ ] **Step 4: Verify by hand — this file cannot be unit-tested**

Run: `npm start`

1. Paste `39.2904,-76.6122` into the anchor field → **SOLO**. Confirm the ⚙ settings panel shows **locate your body** and the button opens Google Maps at that spot.
2. Quit. Relaunch. Press **CONTINUE**.
3. Confirm **locate your body** is present *and works*. **Before this change it was hidden and dead.**
4. Relaunch, press **SOLO** with an empty anchor field, and confirm the locate row is **hidden** (no fabricated coordinates).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/index.html
git commit -m "fix: CONTINUE restores the anchor identity, not just the world

currentAnchor was assigned only inside takeAnchor(), which the CONTINUE
handler never called. A resumed anchored run got a working drift HUD but a
hidden, dead 'locate your body' button.

One applyIdentity({anchor}) now serves all three start paths. index.html has
no test coverage, so the risk belongs in one function rather than three
copies — and later phases add a fourth caller."
```

---

### Task 4: Make the smoke test able to catch this class of bug

**Files:**
- Modify: `_relaytest.mjs` (whole file).

**Interfaces:**
- Consumes: the deployed Worker's `welcome` frame — `{playerId, worldSeed, roomId}`.
- Produces: nothing importable. A manual script.

**Why it missed Defect A:** the current script asserts `seeds_match: jeff.got.welcome === maddie.got.welcome`. Two clients receiving **the same random seed** satisfies that perfectly. It never sends a `worldSeed` and never checks the seed is the one **requested**. It passes while the feature is entirely broken.

**The trap Task 2 introduces:** now that seeds persist (Defect B fixed), a fixed room name keeps its **first** seed forever. Re-running against `?room=smoketest` would return the seed minted on the very first run and fail every time after. **The room name must be unique per run.**

- [ ] **Step 1: Rewrite the script**

Replace `_relaytest.mjs` entirely:

```js
import { WebSocket } from 'ws'

const HOST = 'wss://backrooms-relay.jeff-schatz112.workers.dev'
// A fresh room every run. Seeds are now permanent (relay.js webSocketClose no
// longer deletes them), so a fixed room name would keep the seed minted on the
// FIRST run forever and fail every run after.
const ROOM = `smoke-${Date.now().toString(36)}`
const URL  = `${HOST}/?room=${ROOM}`

// Jeff anchors; Maddie does not. Maddie must inherit Jeff's world.
const WANT = 123456789

function mk(name, worldSeed) {
  const ws = new WebSocket(URL)
  const got = { welcome: null, roomId: null, players: 0, joined: [], chat: [] }
  ws.on('open', () => {
    const join = { type: 'join', roomId: ROOM, name }
    if (worldSeed != null) join.worldSeed = worldSeed
    ws.send(JSON.stringify(join))
  })
  ws.on('message', (d) => {
    const m = JSON.parse(d.toString())
    if (m.type === 'welcome') { got.welcome = m.worldSeed; got.roomId = m.roomId }
    else if (m.type === 'players') got.players++
    else if (m.type === 'joined') got.joined.push(m.name)
    else if (m.type === 'chat') got.chat.push(`${m.name}: ${m.text}`)
  })
  return { ws, got }
}

const jeff = mk('Jeff', WANT)
await new Promise(r => setTimeout(r, 700))
const maddie = mk('Maddie', null)
await new Promise(r => setTimeout(r, 700))
maddie.ws.send(JSON.stringify({ type: 'pos', x: 12.3, y: 4.5, angle: 1.1 }))
await new Promise(r => setTimeout(r, 400))
maddie.ws.send(JSON.stringify({ type: 'chat', text: 'hi jeff!' }))
await new Promise(r => setTimeout(r, 1500))

const checks = {
  // THE ONE THAT MATTERED. The old script only checked the two clients agreed
  // with each other — which passed while every online game was Math.random().
  seed_is_what_jeff_requested: jeff.got.welcome === WANT,
  maddie_inherited_jeffs_world: maddie.got.welcome === WANT,
  roomId_echoed: jeff.got.roomId === ROOM,
  jeff_got_player_updates: jeff.got.players > 0,
  jeff_saw_maddie_join: jeff.got.joined.includes('Maddie'),
  jeff_received_chat: jeff.got.chat.length > 0,
}

console.log(JSON.stringify({
  room: ROOM,
  requested: WANT,
  jeff_worldSeed: jeff.got.welcome,
  maddie_worldSeed: maddie.got.welcome,
  ...checks,
}, null, 1))

jeff.ws.close(); maddie.ws.close()
const failed = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k)
if (failed.length) { console.error('FAILED:', failed.join(', ')); process.exit(1) }
console.log('ALL PASS')
process.exit(0)
```

Note it now **exits non-zero on failure**. The old script always exited 0, so it could not fail even in principle.

- [ ] **Step 2: Confirm it fails against the CURRENTLY DEPLOYED relay**

This is the important step — it proves the test can detect the bug.

Run: `node _relaytest.mjs`
Expected: **FAIL**, `seed_is_what_jeff_requested: false`, with `jeff_worldSeed` some random uint32 rather than `123456789`, and `roomId_echoed: false`. Exit code 1.

If it *passes* here, someone already deployed Task 2 — check with `git log` and `npx wrangler deployments list` before continuing.

- [ ] **Step 3: Commit**

```bash
git add _relaytest.mjs
git commit -m "test: assert the relay honours the REQUESTED seed, not just agreement

The old smoke test checked that two clients received the same seed. They
always did — the same random one. It passed while every online game ignored
the anchor, which is exactly how the defect shipped.

Now Jeff joins with a known seed and Maddie joins with none: Jeff must get
what he asked for and Maddie must inherit it. Uses a fresh room per run,
because seeds are now permanent, and exits non-zero on failure."
```

---

### Task 5: Deploy and verify against the live Worker

**Files:** none — deployment and verification.

**Interfaces:**
- Consumes: everything from Tasks 1, 2 and 4.
- Produces: a relay that actually honours anchors.

**This task is not optional.** `relay.js` has no unit tests by construction (Task 1). The only proof this works is two real clients through the real Worker. A green `npm test` proves the seed *policy*; it proves nothing about the *wire*.

- [ ] **Step 1: Confirm the full suite is green before deploying**

Run: `npm test`
Expected: PASS — all pre-existing tests plus 8 new.

- [ ] **Step 2: Deploy**

```bash
cd relay && npx wrangler deploy
```

Expected: a `Uploaded backrooms-relay` line, a `Deployed backrooms-relay` line, and a version ID. Wrangler is authenticated as `jeff.schatz112@gmail.com`.

If it prompts to log in, stop — do not create new credentials. Report it.

- [ ] **Step 3: Verify against the live Worker**

```bash
cd .. && node _relaytest.mjs
```

Expected: `ALL PASS`, exit 0, with:
```
"jeff_worldSeed": 123456789,
"maddie_worldSeed": 123456789,
"seed_is_what_jeff_requested": true,
"maddie_inherited_jeffs_world": true,
"roomId_echoed": true,
```

**This is the first time in the project's history that an online room has honoured an anchor.**

- [ ] **Step 4: Verify the world now survives an empty room**

The regression Defect B caused, tested by hand:

```bash
node -e "
import('ws').then(async ({WebSocket}) => {
  const room = 'persist-' + Date.now().toString(36)
  const url = 'wss://backrooms-relay.jeff-schatz112.workers.dev/?room=' + room
  const seedOf = (want) => new Promise((res) => {
    const ws = new WebSocket(url)
    ws.on('open', () => ws.send(JSON.stringify({type:'join', roomId:room, name:'probe', ...(want!=null?{worldSeed:want}:{})})))
    ws.on('message', d => { const m = JSON.parse(d.toString()); if (m.type==='welcome') { ws.close(); res(m.worldSeed) } })
  })
  const first = await seedOf(555000111)          // fixes the world, then leaves
  await new Promise(r => setTimeout(r, 3000))    // room is now empty
  const second = await seedOf(999888777)         // asks for a DIFFERENT seed
  console.log({ first, second, survived_empty_room: first === second })
  process.exit(first === second ? 0 : 1)
})
"
```

Expected: `{ first: 555000111, second: 555000111, survived_empty_room: true }`.

The second client asks for a *different* seed and must be **refused** — the room already has a world, and it kept it through being empty. Before this fix, `second` would have been a fresh random number.

- [ ] **Step 5: Verify in the actual game with two clients**

Run: `npm start`

1. Paste `39.2904,-76.6122` into the anchor field.
2. **PLAY ONLINE** → a **brand-new** room code (old rooms already have a random world fixed — see Step 6).
3. Launch a second instance, same code, **no anchor**.
4. Confirm both players see the same walls and can walk to each other without clipping through geometry.
5. Both quit. Rejoin the **same code**. Confirm **the world is the same maze**, not a new one.

- [ ] **Step 6: Record the migration note**

No migration is needed, but the consequence must be written down. Append to `docs/superpowers/plans/2026-07-16-phase-0-relay-fix.md` under a `## Deployment record` heading:

```markdown
## Deployment record

Deployed <date>, version <id>.

**Pre-existing rooms keep their random world forever.** Any room code used
before this deploy already has a random seed in Durable Object storage, and
storage now survives the room emptying. Those rooms will never honour an
anchor — the first joiner fixed the world, and that is now permanent and
correct behaviour.

**No migration.** A room code is free; use a new one to get an anchored world.
Wiping storage would be the alternative and is not worth it — it would reset
every existing room's world for no gain.
```

- [ ] **Step 7: Commit and push**

```bash
git add docs/superpowers/plans/2026-07-16-phase-0-relay-fix.md
git commit -m "docs: record the Phase 0 relay deployment

Pre-existing rooms keep their random world permanently now that storage
survives an empty room. That is correct — the first joiner fixed it. No
migration; a new room code gets an anchored world."
git push origin docs/geo-tethered-sectors-spec
```

---

## Verification summary

| Defect | Proof it is fixed |
|---|---|
| **A** — anchor discarded online | Task 4 Step 2 fails against the old relay; Task 5 Step 3 passes against the new one |
| **B** — world deleted when room empties | Task 5 Step 4: `survived_empty_room: true` |
| **C** — `roomId: ''` | Task 5 Step 3: `roomId_echoed: true` |
| **D** — CONTINUE's dead locate button | Task 3 Step 4: the button is present and works after CONTINUE |
| The blind spot itself | Task 4: the smoke test now asserts the seed matches what was **requested**, and exits non-zero |

## Out of scope

Sectors, the gazetteer, polygons, Level ∅, factions, Phase 1b (threading `worldSeed` into items/decor), and the dead `config.lights` bug (Phase 2b). Phase 0 ships alone.

### Deliberately dropped from Phase 0: the `world.json` fetch — **and the spec is wrong about it**

Spec §10 lists *"Delete the dead `world.json` fetch"* under Phase 0. **Do not do that**, and do not do it here.

The dead fetch is real: `world.js:35` does `fetch('./world.json')` from a `file://` origin (`main.js:88 loadFile`), Chromium's `fetch` has no `file:` scheme, it throws, and `world.js:39-41`'s bare `catch { return DEFAULT_CONFIG }` swallows it. `game.js:52` (`const base = await loadConfig()`) has therefore always received `DEFAULT_CONFIG`.

But **`src/renderer/world.json` is not dead weight — it is the output of the wish pipeline**:

- `.github/workflows/wish-grant.yml:25` reads it, `:59` writes the Claude-modified version back, `:78` commits it, and merging **ships a release** that players auto-update into.
- README documents this as a headline feature: *"when a wish is granted, the world drifts — palette shifts, sounds change… players update and notice the world is not quite as it was."*

**Therefore every granted wish has been a no-op.** The issue is labelled, the API is called, the PR opens, the version bumps, the installer builds, players update — and the game reads `DEFAULT_CONFIG` exactly as before. Nobody noticed because the shipped `world.json` still matches `DEFAULT_CONFIG` closely enough.

So the fix is **not** "delete the file and the fetch" — that would silently delete the wish system. The fix is to **make `world.json` actually load** (via IPC from the main process, per spec §6's rule that any non-`file://`-safe read lives in main), which would make the wish pipeline work for the first time.

That is a real feature with a real decision in it, it touches the release pipeline, and it has nothing to do with the relay. **It gets its own spec and its own plan.** Amend spec §10 to remove it from Phase 0.
