# Atlas Live Data Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the Atlas a live, server-backed data layer — a Cloudflare Durable Object that serves beacons + strata over HTTP (seeded with the genesis data) and accepts admin-authored edits — so the map can grow and, later, accumulate strata without a static-file redeploy.

**Architecture:** Extend the **existing** `backrooms-relay` Worker (`relay/relay.js`). Add a second Durable Object class, `Atlas`, a **global singleton** (`idFromName('global')`) that stores `{ version, beacons: [...] }` in KV-style DO storage — mirroring how the `Room` DO uses `ctx.storage`. All validation, auth, routing, and read/write logic lives in a pure, runtime-free module (`relay/atlas.js`) that is unit-tested like `relay/seed.js`; the DO class is a thin shell that loads the store, calls the pure handlers, and persists the result. Public reads are CORS-open GETs; writes require an admin bearer secret.

**Tech Stack:** Cloudflare Workers + Durable Objects (`cloudflare:workers`, compat `2025-06-01`), `wrangler`, Vitest for the pure helpers. No new dependencies, no SQL (KV-style `ctx.storage.get/put` with a JSON blob, matching the `Room` DO).

## Global Constraints

- **Extend, don't replace.** The `Room` WebSocket relay in `relay/relay.js` must keep working unchanged. The Atlas is additive: a new class, a new binding, a new migration tag, new HTTP routes under `/atlas`.
- **Reuse the tested-pure-helpers pattern.** All logic goes in `relay/atlas.js` as pure functions (no DO, no storage, no network), unit-tested in `test/atlas.test.js` — exactly how `relay/seed.js` is tested by `test/relay-seed.test.js`. The DO class is a thin adapter.
- **Data shape is the Atlas contract** (identical to the gh-pages `atlas/beacons.json`): `{ "version": 1, "beacons": [ { id, kind, sealed?, name, subtitle?, lat, lng, blurb?, strata: [ { tier, ts, fragment } ] } ] }`. `kind ∈ {genesis, organic}`, `tier ∈ {deep, faint}`, ids match `^[a-z0-9-]{1,64}$`.
- **Public reads are open + CORS; writes are gated.** `GET /atlas/*` returns `access-control-allow-origin: *` (the gh-pages site fetches cross-origin). `PUT`/`POST` require `Authorization: Bearer <ATLAS_ADMIN_KEY>`, compared in constant time. `ATLAS_ADMIN_KEY` is a Worker **secret** (`wrangler secret put`), never committed.
- **Disclosure boundary:** genesis, hand-authored beacons only. No placement mechanism, no spawn data — nothing from the private placement-engine spec. This layer is CRUD over admin-authored data.
- **Scope / non-goals (deliberately deferred to a later plan):** *player-identity* strata writes (the claim-code console + the physical-vs-drop-in presence proof) are **not** here. This plan proves the write path with an admin key first; opening writes to players comes after the identity model is decided.

## File Structure

| File | Responsibility |
|---|---|
| `relay/atlas.js` (new) | Pure logic: validation, id check, bearer auth, path parsing, read/write handlers over a plain store object. Runtime-free, unit-tested. |
| `test/atlas.test.js` (new) | Vitest unit tests for `relay/atlas.js` (+ validates the seed data). |
| `relay/atlas-seed.js` (new) | The genesis seed (`806 N Carey`, sealed) as an exported JS object — loaded into the DO on first use. |
| `relay/relay.js` (modify) | Add the `Atlas` DO class (thin shell) + route `/atlas/*` to it in the default `fetch`. |
| `relay/wrangler.jsonc` (modify) | Add the `ATLAS` binding + a `v2` migration adding the `Atlas` sqlite class. |

---

### Task 1: Pure Atlas logic (`relay/atlas.js`)

**Files:**
- Create: `relay/atlas.js`
- Test: `test/atlas.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces (the DO shell in Task 5 and later tasks import these):
  - `beaconIdOk(id): boolean`
  - `validateStratum(s): {ok, error?}` · `validateBeacon(b): {ok, error?}`
  - `authorize(authHeader, secret): boolean` (constant-time bearer compare)
  - `parseAtlasPath(pathname): {resource: 'beacons'|'beacon'|'strata', id?} | null`
  - `readAtlas(store, route): {status, json}`
  - `upsertBeacon(store, id, beacon): {status, json, store?}`
  - `appendStratum(store, id, stratum): {status, json, store?}`
  - `emptyStore(): {version, beacons}`
  - constants `BEACON_KINDS`, `STRATUM_TIERS`

- [ ] **Step 1: Write the failing test**

Create `test/atlas.test.js`:

```js
import { describe, it, expect } from 'vitest'
import {
  beaconIdOk, validateStratum, validateBeacon, authorize,
  parseAtlasPath, readAtlas, upsertBeacon, appendStratum, emptyStore,
} from '../relay/atlas.js'

const beacon = (over = {}) => ({ id: 'x', kind: 'genesis', name: 'X', lat: 39.3, lng: -76.6, strata: [], ...over })

describe('beaconIdOk', () => {
  it('accepts minted ids, rejects junk', () => {
    expect(beaconIdOk('806-n-carey')).toBe(true)
    expect(beaconIdOk('BAD')).toBe(false)
    expect(beaconIdOk('a/b')).toBe(false)
    expect(beaconIdOk('')).toBe(false)
    expect(beaconIdOk(null)).toBe(false)
  })
})

describe('validateStratum / validateBeacon', () => {
  it('validates a good stratum and beacon', () => {
    expect(validateStratum({ tier: 'deep', ts: '2026-07-26T00:00:00Z', fragment: 'x' }).ok).toBe(true)
    expect(validateBeacon(beacon()).ok).toBe(true)
  })
  it('rejects bad tier / ts / fragment', () => {
    expect(validateStratum({ tier: 'no', ts: '2026-07-26', fragment: 'x' }).ok).toBe(false)
    expect(validateStratum({ tier: 'deep', ts: 'nope', fragment: 'x' }).ok).toBe(false)
    expect(validateStratum({ tier: 'deep', ts: '2026-07-26', fragment: '' }).ok).toBe(false)
  })
  it('rejects bad id / kind / coords / sealed type', () => {
    expect(validateBeacon(beacon({ id: 'BAD' })).ok).toBe(false)
    expect(validateBeacon(beacon({ kind: 'zzz' })).ok).toBe(false)
    expect(validateBeacon(beacon({ lat: 200 })).ok).toBe(false)
    expect(validateBeacon(beacon({ lng: 999 })).ok).toBe(false)
    expect(validateBeacon(beacon({ sealed: 'yes' })).ok).toBe(false)
  })
})

describe('authorize (constant-time bearer)', () => {
  it('accepts the exact key, rejects everything else', () => {
    expect(authorize('Bearer s3cret', 's3cret')).toBe(true)
    expect(authorize('Bearer wrong', 's3cret')).toBe(false)
    expect(authorize('s3cret', 's3cret')).toBe(false)          // missing "Bearer "
    expect(authorize('Bearer s3cret', '')).toBe(false)          // no secret configured
    expect(authorize(null, 's3cret')).toBe(false)
    expect(authorize('Bearer s3cre', 's3cret')).toBe(false)     // length differs
  })
})

describe('parseAtlasPath', () => {
  it('routes the three shapes and rejects the rest', () => {
    expect(parseAtlasPath('/atlas/beacons')).toEqual({ resource: 'beacons' })
    expect(parseAtlasPath('/atlas/beacons/806-n-carey')).toEqual({ resource: 'beacon', id: '806-n-carey' })
    expect(parseAtlasPath('/atlas/beacons/806-n-carey/strata')).toEqual({ resource: 'strata', id: '806-n-carey' })
    expect(parseAtlasPath('/atlas')).toBe(null)
    expect(parseAtlasPath('/nope')).toBe(null)
    expect(parseAtlasPath('/atlas/beacons/x/y')).toBe(null)
  })
})

describe('readAtlas', () => {
  const store = { version: 1, beacons: [beacon({ id: 'a' }), beacon({ id: 'b' })] }
  it('lists all, fetches one, 404s the unknown', () => {
    expect(readAtlas(store, { resource: 'beacons' }).json.beacons.length).toBe(2)
    expect(readAtlas(store, { resource: 'beacon', id: 'a' }).status).toBe(200)
    expect(readAtlas(store, { resource: 'beacon', id: 'zzz' }).status).toBe(404)
  })
})

describe('upsertBeacon', () => {
  it('inserts, updates, preserves strata on metadata-only update, rejects bad data', () => {
    const s0 = emptyStore()
    const ins = upsertBeacon(s0, 'a', beacon({ id: 'a', strata: [{ tier: 'deep', ts: '2026-01-01T00:00:00Z', fragment: 'one' }] }))
    expect(ins.status).toBe(200)
    expect(ins.store.beacons.length).toBe(1)
    // metadata-only update (no strata field) keeps the existing strata
    const upd = upsertBeacon(ins.store, 'a', { kind: 'genesis', name: 'A2', lat: 39.3, lng: -76.6 })
    expect(upd.status).toBe(200)
    expect(upd.store.beacons[0].name).toBe('A2')
    expect(upd.store.beacons[0].strata.length).toBe(1)
    // bad id / body → 400, store untouched
    expect(upsertBeacon(ins.store, 'BAD', beacon()).status).toBe(400)
    expect(upsertBeacon(ins.store, 'a', { kind: 'zzz' }).status).toBe(400)
  })
})

describe('appendStratum', () => {
  it('appends to an existing beacon, 404s the unknown, 400s bad data', () => {
    const s0 = { version: 1, beacons: [beacon({ id: 'a', strata: [] })] }
    const r = appendStratum(s0, 'a', { tier: 'faint', ts: '2026-07-26T00:00:00Z', fragment: 'new' })
    expect(r.status).toBe(201)
    expect(r.store.beacons[0].strata.length).toBe(1)
    expect(appendStratum(s0, 'zzz', { tier: 'deep', ts: '2026-07-26T00:00:00Z', fragment: 'x' }).status).toBe(404)
    expect(appendStratum(s0, 'a', { tier: 'no', ts: 'x', fragment: '' }).status).toBe(400)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/atlas.test.js`
Expected: FAIL — cannot resolve `../relay/atlas.js`.

- [ ] **Step 3: Write the module**

Create `relay/atlas.js`:

```js
// relay/atlas.js — pure, runtime-free logic for the Atlas data layer.
// No Durable Object, no storage, no network. The Atlas DO in relay.js is a thin
// shell that loads a plain store object, calls these, and saves the result.
// Unit-tested like seed.js. Store shape: { version: 1, beacons: [ beacon ] }.

export const BEACON_KINDS = ['genesis', 'organic']
export const STRATUM_TIERS = ['deep', 'faint']
const ID_RE = /^[a-z0-9-]{1,64}$/

export function emptyStore() { return { version: 1, beacons: [] } }

export function beaconIdOk(id) { return typeof id === 'string' && ID_RE.test(id) }

export function validateStratum(s) {
  if (s == null || typeof s !== 'object') return { ok: false, error: 'stratum is not an object' }
  if (!STRATUM_TIERS.includes(s.tier)) return { ok: false, error: `tier must be one of ${STRATUM_TIERS.join('|')}` }
  if (typeof s.ts !== 'string' || Number.isNaN(Date.parse(s.ts))) return { ok: false, error: 'ts must be an ISO date string' }
  if (typeof s.fragment !== 'string' || !s.fragment) return { ok: false, error: 'fragment must be a non-empty string' }
  return { ok: true }
}

export function validateBeacon(b) {
  if (b == null || typeof b !== 'object') return { ok: false, error: 'beacon is not an object' }
  if (!beaconIdOk(b.id)) return { ok: false, error: 'beacon.id must match ^[a-z0-9-]{1,64}$' }
  if (!BEACON_KINDS.includes(b.kind)) return { ok: false, error: `beacon ${b.id}: kind must be one of ${BEACON_KINDS.join('|')}` }
  if (typeof b.name !== 'string' || !b.name) return { ok: false, error: `beacon ${b.id}: name must be a non-empty string` }
  if (typeof b.lat !== 'number' || b.lat < -90 || b.lat > 90) return { ok: false, error: `beacon ${b.id}: lat out of range` }
  if (typeof b.lng !== 'number' || b.lng < -180 || b.lng > 180) return { ok: false, error: `beacon ${b.id}: lng out of range` }
  if (b.sealed !== undefined && typeof b.sealed !== 'boolean') return { ok: false, error: `beacon ${b.id}: sealed must be boolean` }
  if (b.subtitle !== undefined && typeof b.subtitle !== 'string') return { ok: false, error: `beacon ${b.id}: subtitle must be a string` }
  if (b.blurb !== undefined && typeof b.blurb !== 'string') return { ok: false, error: `beacon ${b.id}: blurb must be a string` }
  const strata = b.strata ?? []
  if (!Array.isArray(strata)) return { ok: false, error: `beacon ${b.id}: strata must be an array` }
  for (let i = 0; i < strata.length; i++) {
    const e = validateStratum(strata[i])
    if (!e.ok) return { ok: false, error: `beacon ${b.id} strata[${i}]: ${e.error}` }
  }
  return { ok: true }
}

// Constant-time bearer check. Returns false unless authHeader is exactly
// "Bearer <secret>" and a non-empty secret is configured.
export function authorize(authHeader, secret) {
  if (typeof secret !== 'string' || secret.length === 0) return false
  if (typeof authHeader !== 'string') return false
  const m = authHeader.match(/^Bearer\s+(.+)$/)
  if (!m) return false
  const given = m[1]
  if (given.length !== secret.length) return false
  let x = 0
  for (let i = 0; i < secret.length; i++) x |= given.charCodeAt(i) ^ secret.charCodeAt(i)
  return x === 0
}

// "/atlas/beacons" | "/atlas/beacons/:id" | "/atlas/beacons/:id/strata" → route, else null.
export function parseAtlasPath(pathname) {
  const parts = String(pathname).replace(/^\/+|\/+$/g, '').split('/')
  if (parts[0] !== 'atlas' || parts[1] !== 'beacons') return null
  if (parts.length === 2) return { resource: 'beacons' }
  if (parts.length === 3) return { resource: 'beacon', id: parts[2] }
  if (parts.length === 4 && parts[3] === 'strata') return { resource: 'strata', id: parts[2] }
  return null
}

export function readAtlas(store, route) {
  if (route.resource === 'beacons') return { status: 200, json: { version: store.version ?? 1, beacons: store.beacons } }
  if (route.resource === 'beacon') {
    const b = store.beacons.find(x => x.id === route.id)
    return b ? { status: 200, json: b } : { status: 404, json: { error: 'no such beacon' } }
  }
  return { status: 404, json: { error: 'not found' } }
}

// Upsert a beacon. If updating and the body omits `strata`, the existing strata
// are preserved (so metadata edits don't wipe the archive). Returns a new store
// on success; on error, no `store` field (caller persists nothing).
export function upsertBeacon(store, id, beacon) {
  if (!beaconIdOk(id)) return { status: 400, json: { error: 'bad id' } }
  const existing = store.beacons.find(x => x.id === id)
  const b = { ...beacon, id }
  if (b.strata === undefined && existing) b.strata = existing.strata
  const e = validateBeacon(b)
  if (!e.ok) return { status: 400, json: { error: e.error } }
  const beacons = store.beacons.filter(x => x.id !== id).concat([b])
  return { status: 200, json: b, store: { ...store, beacons } }
}

export function appendStratum(store, id, stratum) {
  const b = store.beacons.find(x => x.id === id)
  if (!b) return { status: 404, json: { error: 'no such beacon' } }
  const e = validateStratum(stratum)
  if (!e.ok) return { status: 400, json: { error: e.error } }
  const layer = { tier: stratum.tier, ts: stratum.ts, fragment: stratum.fragment }
  const nb = { ...b, strata: [...(b.strata ?? []), layer] }
  const beacons = store.beacons.map(x => (x.id === id ? nb : x))
  return { status: 201, json: nb, store: { ...store, beacons } }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/atlas.test.js`
Expected: PASS (all describe blocks green).

- [ ] **Step 5: Commit**

```bash
git add relay/atlas.js test/atlas.test.js
git commit -m "feat(atlas): pure data-layer logic — validation, bearer auth, routing, read/write"
```

---

### Task 2: Genesis seed data (`relay/atlas-seed.js`)

**Files:**
- Create: `relay/atlas-seed.js`
- Test: `test/atlas.test.js` (extend)

**Interfaces:**
- Consumes: `validateBeaconSet`-style checks via the existing validators. (No new exports from atlas.js.)
- Produces: `default` export — the seed store object `{ version, beacons }` — imported by the DO in Task 5.

- [ ] **Step 1: Write the failing test**

Append to `test/atlas.test.js`:

```js
import SEED from '../relay/atlas-seed.js'

describe('atlas-seed', () => {
  it('is a valid store and every beacon validates', () => {
    expect(Array.isArray(SEED.beacons)).toBe(true)
    for (const b of SEED.beacons) expect(validateBeacon(b).ok).toBe(true)
  })
  it('contains 806 N Carey as a sealed genesis beacon', () => {
    expect(SEED.beacons.some(b => b.id === '806-n-carey' && b.sealed === true && b.kind === 'genesis')).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/atlas.test.js`
Expected: FAIL — cannot resolve `../relay/atlas-seed.js`.

- [ ] **Step 3: Write the seed**

Create `relay/atlas-seed.js` (mirrors the gh-pages `atlas/beacons.json`; kept as a JS module so the Worker imports it without JSON-import config):

```js
// relay/atlas-seed.js — the genesis beacons the Atlas DO loads on first use.
// Mirrors the gh-pages atlas/beacons.json. Hand-authored; admin edits happen
// live via the DO after seeding. 806 N Carey is SEALED: lore, not a way in.
export default {
  version: 1,
  beacons: [
    {
      id: '806-n-carey',
      kind: 'genesis',
      sealed: true,
      name: '806 N Carey Street',
      subtitle: 'Harlem Park · notice 30150A · EXTENSION',
      lat: 39.2966,
      lng: -76.6414,
      blurb: 'the first door. sealed by the city with concrete block behind its original frame — a masoned door does not open. you do not enter here. you enter through the gap the paperwork left.',
      strata: [
        { tier: 'faint', ts: '2025-11-08T00:00:00Z', fragment: 'still — EXTENSION. twenty-one years. the notice never resolves. it is extended, indefinitely.' },
        { tier: 'deep',  ts: '2004-11-08T00:00:00Z', fragment: '2004 — the notice. 30150A: condemned as unsafe for occupancy; the public is warned to keep away.' },
        { tier: 'deep',  ts: '1961-01-01T00:00:00Z', fragment: '1961 — the plan. the inside of the block is cleared; woodyear and vincent streets erased, leaving inner-block parks no one asked to keep.' },
        { tier: 'deep',  ts: '1937-01-01T00:00:00Z', fragment: "1937 — the map. a federal residential security map rings black west baltimore in red and stamps it D, 'hazardous.' not one building was inspected. the hazard it scored was the people." },
      ],
    },
  ],
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/atlas.test.js`
Expected: PASS (including the two new seed checks).

- [ ] **Step 5: Commit**

```bash
git add relay/atlas-seed.js test/atlas.test.js
git commit -m "feat(atlas): genesis seed data for the DO (806 N Carey, sealed)"
```

---

### Task 3: Register the `Atlas` Durable Object (`wrangler.jsonc`)

**Files:**
- Modify: `relay/wrangler.jsonc`
- Test: `npx wrangler deploy --dry-run` (config validation only — no deploy)

**Interfaces:**
- Consumes: nothing.
- Produces: the `ATLAS` binding and the `Atlas` sqlite migration that Task 5's DO class needs.

- [ ] **Step 1: Add the binding + migration**

Edit `relay/wrangler.jsonc` to read exactly:

```jsonc
{
  "name": "backrooms-relay",
  "main": "relay.js",
  "compatibility_date": "2025-06-01",
  "observability": { "enabled": true },
  "durable_objects": {
    "bindings": [
      { "name": "ROOM", "class_name": "Room" },
      { "name": "ATLAS", "class_name": "Atlas" }
    ]
  },
  "migrations": [
    { "tag": "v1", "new_sqlite_classes": ["Room"] },
    { "tag": "v2", "new_sqlite_classes": ["Atlas"] }
  ]
}
```

(The `v1` entry stays untouched — migrations are cumulative; `v2` only adds the new class. Never re-list `Room`.)

- [ ] **Step 2: Verify config parses (dry-run)**

Run (from `relay/`): `npx wrangler deploy --dry-run`
Expected: it fails to *resolve the `Atlas` class* (not yet defined in `relay.js`) OR reports the binding — either way, the JSONC parses and the migration is accepted. It must NOT report a JSON syntax error. Task 5 adds the class; a clean dry-run comes at the end of Task 5.

- [ ] **Step 3: Commit**

```bash
git add relay/wrangler.jsonc
git commit -m "feat(atlas): register the Atlas durable object (binding + v2 migration)"
```

---

### Task 4: Regression — the pure suite stays green

**Files:**
- Test: the whole Vitest suite

**Interfaces:**
- Consumes: Tasks 1–2.
- Produces: confidence the Atlas helpers didn't disturb the existing relay/game tests.

- [ ] **Step 1: Run the full suite**

Run: `npm test`
Expected: PASS — all pre-existing tests (including `test/relay-seed.test.js`) plus the new `test/atlas.test.js`. Note the total for the reviewer.

- [ ] **Step 2: Commit** (no-op if nothing changed)

No code change; this is a gate. If `npm test` is green, proceed. If anything broke, fix it before continuing — the Atlas files are additive and must not touch existing tests.

---

### Task 5: The `Atlas` DO shell + routing (`relay/relay.js`)

**Files:**
- Modify: `relay/relay.js` (add imports, the `Atlas` class, and `/atlas` routing in the default `fetch`)
- Test: local `wrangler dev` + `curl` (the DO's HTTP behavior; its pure logic is already unit-tested in Task 1).

**Interfaces:**
- Consumes: everything from `relay/atlas.js` (Task 1) and `SEED` from `relay/atlas-seed.js` (Task 2); the `ATLAS` binding (Task 3).
- Produces: the live endpoints `GET /atlas/beacons`, `GET /atlas/beacons/:id`, `PUT /atlas/beacons/:id`, `POST /atlas/beacons/:id/strata`.

- [ ] **Step 1: Add the imports**

At the top of `relay/relay.js`, below the existing imports (`import { roomSeed } from './seed.js'`), add:

```js
import SEED from './atlas-seed.js'
import { parseAtlasPath, authorize, readAtlas, upsertBeacon, appendStratum } from './atlas.js'
```

- [ ] **Step 2: Add the `Atlas` class**

After the closing brace of the `Room` class (relay.js:90) and before `export default {`, add:

```js
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,PUT,POST,OPTIONS',
  'access-control-allow-headers': 'authorization,content-type',
}
function atlasJson(status, obj) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', ...CORS } })
}

// A single global store of beacons + strata. Reads are open (CORS); writes need
// the admin bearer secret. All logic is the pure module atlas.js; this shell just
// loads the store, calls it, and persists. Seeded from atlas-seed.js on first use.
export class Atlas extends DurableObject {
  async fetch(request) {
    const url = new URL(request.url)
    const route = parseAtlasPath(url.pathname)
    if (!route) return atlasJson(404, { error: 'not found' })
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS })

    let store = await this.ctx.storage.get('store')
    if (!store) { store = SEED; await this.ctx.storage.put('store', store) }

    if (request.method === 'GET') {
      const r = readAtlas(store, route)
      return atlasJson(r.status, r.json)
    }

    // writes require the admin key
    if (!authorize(request.headers.get('authorization'), this.env.ATLAS_ADMIN_KEY)) {
      return atlasJson(401, { error: 'unauthorized' })
    }
    const body = await request.json().catch(() => null)
    if (body == null) return atlasJson(400, { error: 'body must be json' })

    if (request.method === 'PUT' && route.resource === 'beacon') {
      const r = upsertBeacon(store, route.id, body)
      if (r.store) await this.ctx.storage.put('store', r.store)
      return atlasJson(r.status, r.json)
    }
    if (request.method === 'POST' && route.resource === 'strata') {
      const r = appendStratum(store, route.id, body)
      if (r.store) await this.ctx.storage.put('store', r.store)
      return atlasJson(r.status, r.json)
    }
    return atlasJson(405, { error: 'method not allowed' })
  }
}
```

- [ ] **Step 3: Route `/atlas` in the default fetch**

In the `export default { async fetch(request, env) {` handler, add the Atlas route as the FIRST thing inside `fetch`, before the WebSocket/room logic:

```js
export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    if (url.pathname.startsWith('/atlas')) {
      const stub = env.ATLAS.get(env.ATLAS.idFromName('global'))
      return stub.fetch(request)
    }
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('the backrooms relay is running.\nconnect a websocket: wss://<this-host>/?room=CODE', {
        status: 200, headers: { 'content-type': 'text/plain' },
      })
    }
    const room = (url.searchParams.get('room') || 'default').slice(0, 32)
    const stub = env.ROOM.get(env.ROOM.idFromName(room))
    return stub.fetch(request)
  },
}
```

- [ ] **Step 4: Verify config now resolves**

Run (from `relay/`): `npx wrangler deploy --dry-run`
Expected: clean — both `Room` and `Atlas` classes resolve, both bindings and both migrations validate, no errors.

- [ ] **Step 5: Verify the endpoints locally**

Run (from `relay/`): `npx wrangler dev` (starts a local server, default `http://localhost:8787`). In another shell, set a test key and exercise it:

```bash
# reads (open)
curl -s http://localhost:8787/atlas/beacons | head -c 200
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8787/atlas/beacons/806-n-carey   # 200
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8787/atlas/beacons/nope           # 404
curl -s -I http://localhost:8787/atlas/beacons | grep -i access-control-allow-origin          # present

# writes need the key (wrangler dev reads .dev.vars — see note)
curl -s -o /dev/null -w "%{http_code}\n" -X PUT http://localhost:8787/atlas/beacons/test-door \
  -H 'content-type: application/json' -d '{"kind":"genesis","name":"Test","lat":39.3,"lng":-76.6}'   # 401 (no key)
curl -s -o /dev/null -w "%{http_code}\n" -X PUT http://localhost:8787/atlas/beacons/test-door \
  -H "authorization: Bearer testkey" -H 'content-type: application/json' \
  -d '{"kind":"genesis","name":"Test","lat":39.3,"lng":-76.6}'                                        # 200 with the key
```

For `wrangler dev` to know the key, create `relay/.dev.vars` (gitignored — see the note under Step 6) containing `ATLAS_ADMIN_KEY=testkey`. Confirm: unauthenticated write → `401`; authenticated write → `200`; then `GET /atlas/beacons` shows `test-door`; the WebSocket relay still answers (a plain `GET /` returns "the backrooms relay is running.").

- [ ] **Step 6: Commit**

Ensure `relay/.dev.vars` is gitignored first:

```bash
grep -qxF '.dev.vars' .gitignore || echo '.dev.vars' >> .gitignore
git add relay/relay.js .gitignore
git commit -m "feat(atlas): Atlas DO shell + /atlas routing on the relay worker"
```

---

### Task 6: Deploy + set the admin secret (operator step)

**Files:**
- No code. Deployment + secret.

**Interfaces:**
- Consumes: the finished Worker.
- Produces: the live `/atlas` API on the deployed relay, and the follow-up hook for the front-end.

- [ ] **Step 1: Set the admin secret** (a strong random value the operator keeps; never committed)

Run (from `relay/`): `npx wrangler secret put ATLAS_ADMIN_KEY`
Paste a strong random string when prompted.

- [ ] **Step 2: Deploy**

Run (from `relay/`): `npx wrangler deploy`
Expected: deploys `backrooms-relay` with the `v2` migration creating the `Atlas` class. Note the deployed URL (e.g. `https://backrooms-relay.<subdomain>.workers.dev`).

- [ ] **Step 3: Smoke-test the live API**

```bash
BASE=https://backrooms-relay.<subdomain>.workers.dev
curl -s "$BASE/atlas/beacons" | head -c 300          # the seeded 806 beacon
curl -s -o /dev/null -w "%{http_code}\n" "$BASE/atlas/beacons/806-n-carey"   # 200
curl -s -o /dev/null -w "%{http_code}\n" -X PUT "$BASE/atlas/beacons/x" -d '{}'   # 401 (no key)
```

- [ ] **Step 4: Record the URL for the front-end follow-up**

The gh-pages Atlas front-end switch is a **separate, small follow-up** (out of scope for this backend plan): in `atlas/index.html`, fetch `"$BASE/atlas/beacons"` first and fall back to the bundled `beacons.json` if the request fails, so the map degrades gracefully. Record the deployed `$BASE` in the follow-up task. Do not do it here — it lives on the `gh-pages` branch and needs the live URL this task produces.

---

## Self-Review

**Spec coverage** (against `2026-07-25-beacon-atlas-design.md` §5.3 "a Cloudflare Worker read-API backed by the existing relay Durable Object"):
- Worker read-API on the existing relay → Tasks 3, 5 (routes on `backrooms-relay`). ✅
- Backed by a Durable Object → the `Atlas` singleton DO. ✅ (A *new* class, because `Room` is per-room WebSocket state, not a global registry — the honest reading of "the existing relay [worker]".)
- Public reads expose beacons + strata; CORS for the gh-pages origin → Task 5 (`CORS`, GET handlers). ✅
- Genesis seeding → Task 2 + Task 5 (seed-on-first-use). ✅
- Data shape = the future/front-end contract → identical schema to `atlas/beacons.json`. ✅
- Disclosure boundary (no placement mechanism) → CRUD only; the private engine is untouched. ✅
- **Deferred (stated non-goals):** player-identity strata writes (console/claim-code + presence proof) and organic-beacon placement — later plans. The admin-key write path here is the de-risking precursor.

**Placeholder scan:** none — every code step is complete; the only literal placeholder, `<subdomain>`, is a real deployment value the operator fills at deploy time (Task 6), not a code gap.

**Type consistency:** `beaconIdOk`, `validateBeacon`, `validateStratum`, `authorize`, `parseAtlasPath`, `readAtlas`, `upsertBeacon`, `appendStratum`, `emptyStore` are named identically across `relay/atlas.js`, `test/atlas.test.js`, and the DO shell in `relay/relay.js`. The store shape `{version, beacons:[…]}` and beacon/stratum schema match `atlas-seed.js`, the validators, and the read/write handlers. The `{status, json, store?}` handler-result shape is consumed consistently by the DO shell.

**Untested surfaces (declared):** the `Atlas` DO class is an adapter over unit-tested pure functions; like the existing `Room` DO (whose only unit tests are `seed.js`'s), its HTTP behavior is verified by `wrangler dev` + `curl` (Task 5 Step 5) and the live smoke test (Task 6), not by a Workers-runtime test harness (the repo has none). All branching logic worth testing lives in `relay/atlas.js`, fully covered.
