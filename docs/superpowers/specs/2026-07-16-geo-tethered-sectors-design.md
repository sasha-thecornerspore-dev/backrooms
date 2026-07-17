# Geo-Tethered Sectors — design

**Date:** 2026-07-16
**Status:** proposed — subsystem #1 of 5
**Scope:** the foundation only. Portals, teams, capture and modes are sketched here *only* to prove this foundation does not block them.

> **Amended by [2026-07-16-level-zero-factions-and-grain-design.md](2026-07-16-level-zero-factions-and-grain-design.md)**, which answers every open question in §11, adds Baltimore neighborhood grain (§5 there), makes Phase 1b mandatory, brings `custom:` into Phase 1, and adds Level ∅ and the faction function. Read both. Where they disagree, the amendment wins.

---

## 0. The vision, and the decomposition

The request, verbatim:

> "could we make it so that the game is generally tethered to your actual location to start, if we can somehow determine location, or if not, to have player pick a location? could we then sector off geographical areas of some size, say city sized or county sized, so that each possible world is made within that set area, like if you enter in baltimore, youre in baltimore world, but could also say.. find the entrance to Howard County ...and then make it so you can find and or earn warp portals with increasingly strong distance powers. then we divide the game into two other possible play styles cooperative or pvp where you can assemble teams and do battle with other areas. which means some kind of capture features. so moving the pvp idea into something akin to ingress captures"

That is five independent subsystems:

| # | Subsystem | Depends on |
|---|-----------|-----------|
| **1** | **Geo-tethered named sectors** — location → named area → that area *is* the world | — |
| 2 | Travel & warp portals | 1 |
| 3 | Identity & teams | 1 |
| 4 | Territory capture (persistent, Ingress-like) | 3 |
| 5 | Co-op vs PvP modes | 4 |

**This spec covers #1 only**, plus a Phase 0 that is not optional (§1). Each later subsystem gets its own spec.

### The pivot this design makes

The original plan was IP-based auto-detection of the player's location. Research (§A.1) killed it as a *source of truth*:

- **No keyless IP service returns a county at all.** Not one of six tested.
- **Two services disagree on the same IP**: freeipapi → *Baltimore*, ipwho.is → *Clarksville*.
- Three of six were ~30 km off. ipinfo named the **wrong state**.

A service's guess silently becoming a permanent world key is a category error: two friends on one couch, one WAN IP, one build, could land in different worlds and never meet. No retry logic fixes a coin flip.

**The resolution:** demote IP from *authority* to *prefill*. Every IP service returns a lat/lng; we ship the boundary data and resolve the point to a sector **locally**, then **a human confirms it**, and the confirmed ID is written **once**. Determinism stops being defended and becomes structural.

Consequence, and it is a real feature: **nothing about the player ever leaves the machine.** No IP, no coordinates, no sector. There is no API to go down, no rate limit, no ToS, and nothing to disclose. That is not a privacy feature bolted on — it is what the architecture happens to be.

---

## 1. PHASE 0 — the relay is broken, and it is the whole product

**This ships first, alone, before any geo work.** It is ~4 lines and it fixes a live defect in the only feature anyone uses.

### 1.1 Defect A — the anchor is discarded on every online game

`src/net/client.js:31` sends the anchor seed:

```js
const join = { type: 'join', roomId: String(roomId), name: selfName }
if (worldSeed != null) join.worldSeed = worldSeed
```

`relay/relay.js:40-46` handles `join` and **never reads `msg.worldSeed`**. The relay takes a seed only from a `?seed=` param (`relay.js:17`), and `src/renderer/index.html:463` builds the URL with no such param:

```js
startMultiplayer(`${RELAY_URL}/?room=${encodeURIComponent(code)}`, code, ...)
```

`Number(null)` → `0` → fails the `seedParam > 0` guard at `relay.js:21` → falls to `relay.js:23`:

```js
: (Math.floor(Math.random() * 0xFFFFFFFF) + 1)   // ← always this branch
```

**Every online game is a random maze.** Meanwhile `game.js:216` renders *"your body remains at 39.2854,-76.6083."* The product actively lies about its premise online.

`server/index.js:72-77` (the LAN server) honours `msg.worldSeed` correctly. Only the public relay drops it.

**Why this survived testing:** `_relaytest.mjs` asserts two clients receive *the same* seed — which they do. It never asserts the seed matches what was **requested**. That is the exact shape of the blind spot.

**Fix:** read `msg.worldSeed` in the `join` handler, mirroring `server/index.js:72-77`. Prefer this over adding `&seed=` to the URL — it keeps the seed out of the URL and matches the existing protocol.

### 1.2 Defect B — the world is deleted when the room empties

`relay/relay.js:62-65`:

```js
// if the last player is gone, forget the world so the room can be reborn
if (this.ctx.getWebSockets().length <= 1) {
  try { await this.ctx.storage.delete('seed') } catch { /* ignore */ }
}
```

Two players quit; the same room code yields a **different world** tomorrow. This was a deliberate choice when rooms were throwaway. It is fatal now: **nothing persistent can be built in a room that erases itself.** Every part of subsystem #4 is blocked by this one line.

**Fix:** delete the block. Persistence is the precondition for territory.

### 1.3 Defect C — `roomId` is echoed empty

`relay.js:44` sends `roomId: ''`. Echo the real room id.

### 1.4 Defect D — CONTINUE leaves the locate button dead

`currentAnchor` is assigned only inside `takeAnchor()` (`index.html:382`), which the CONTINUE handler (`index.html:471-475`) never calls. A resumed anchored run passes `savedRun.anchor` to `initGame` (so the drift HUD works) but `#locate-row` stays hidden and `btn-locate` no-ops.

**Fix:** one `applyIdentity({sectorId, anchor})` called from **all three** origins (solo, online, continue). Not three parallel copies — `index.html` has no test coverage (§7), so the risk must live in the smallest possible surface.

### 1.5 Testability of Phase 0

`relay.js:12` imports `cloudflare:workers`, which is unresolvable under vitest's `environment: 'node'`. **That is precisely why `relay.js` has zero tests and precisely why Defect A shipped.**

Extract `relay/seed.js` — a pure `roomSeed(requestedSeed, storedSeed)` — so plain vitest can import it. Do **not** adopt `@cloudflare/vitest-pool-workers`; it needs a config split and breaks the zero-mock house style.

The postcondition must be stated correctly. *"Returns random"* is not testable and passes while broken. Test instead:
- `roomSeed(12345, null) === 12345` — a requested seed is honoured
- `roomSeed(null, 999) === 999` — a stored seed wins
- `roomSeed(0, null)` and `roomSeed(-1, null)` never return 0
- two calls with the same stored value agree

Also add to `_relaytest.mjs`: assert the received seed equals the **requested** seed, not merely that the two clients agree.

**Phase 0 ships value with zero new UI and no geo work.**

---

## 2. SECTOR MODEL

### 2.1 What a sector is

A sector is a real geographic area. Its ID string is hashed into a uint32 world seed. **Same sector ID ⇒ byte-identical maze, forever.**

Two grains, one namespace:

| Grain | ID form | Source | Count | Example |
|---|---|---|---|---|
| **US county** | `us-fips:24027` | Census `cb_2024_us_county_500k` | ~3,235 | `Howard County, Maryland` |
| **Country** | `world:FRA` | Natural Earth `ne_10m_admin_0_countries`, field `ADM0_A3` | 258 | `France` |

Total ≈ **3,493 sectors covering every landmass on Earth.** Only open ocean resolves to `null`.

**Why counties in the US:** counties tile the US with no gaps and no overlaps. Cities do not — most land is unincorporated, and `sector: null` is the one thing territory cannot be built on. Baltimore **city** (`24510`) and Baltimore **County** (`24005`) are ordinary distinct rows, a distinction most geocoders break on.

**Why `ADM0_A3` and never `ISO_A2`:** Natural Earth sets `ISO_A2 = '-99'` for 22 rows at 10m — including **France and Norway** (the countries layer folds in overseas territories, so no single code fits), alongside Kosovo, Northern Cyprus and Somaliland. Keying on `ISO_A2` would hash **France, Norway, Kosovo, N. Cyprus and Somaliland to one identical maze**, labelled from a name table with no `-99` entry. `ISO_A2_EH` does not fix it (still `-99` for N. Cyprus and Somaliland; and it is **not unique** — `AU`×4, `FR`×2 at 10m). Taiwan is a further trap: `ISO_A2 = "CN-TW"`, which a `!= '-99'` guard passes through.

**`ADM0_A3` is the only field that is 100% populated and 100% unique at every scale (258/258, measured).** It is not ISO alpha-3 (Palestine=`PSX`, W. Sahara=`SAH`, Kosovo=`KOS`), which is why the namespace is `world:` and not `iso:` — we are naming a folder, not asserting an ISO code.

### 2.2 The asymmetry is not new

The objection "Howard County (650 km²) and Russia (17.1M km²) as peers is incoherent" is weaker than it looks. The **already-agreed US county grain alone spans 28,500:1**: Yukon-Koyukuk, AK is 376,856 km² — *larger than Germany, larger than ~170 countries* — while Kalawao County, HI is 13 km². The country layer widens existing heterogeneity; it does not introduce it.

This is only survivable because **sector area does not determine board size** (§8.2). Once area is cosmetic, grain heterogeneity is cosmetic too.

### 2.3 Sector → world seed

```js
// src/shared/sector.js — pure, zero deps, imported by renderer AND worker
export const DEFAULT_SECTOR = 'us-fips:24510'   // Baltimore city. the joke that stuck.

export function sectorSeed(id) {                // FNV-1a + final mix
  let h = 0x811c9dc5
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  h = Math.imul(h ^ (h >>> 15), 0x2545f491)
  h = (h ^ (h >>> 16)) >>> 0
  return h === 0 ? 1 : h
}

export function isSectorId(s) {
  return typeof s === 'string' && /^(us-fips:\d{5}|world:[A-Z]{3}|custom:[a-z0-9-]{1,40})$/.test(s)
}
```

**Never 0:** `world.js:191` reads `const epoch = fixedSeed !== null ? fixedSeed : (epochs.get(k) ?? 0)`. A seed of 0 is honoured as a fixed seed *and* is identical to the unseeded first-visit epoch — a sector hashing to 0 would silently produce the drift world while claiming to be seeded. `anchorSeed` already guards this (`anchor.js:43`); `server/index.js:38` and `relay.js:21` each guard independently. This project has hit the 0 case three times.

**IDs are strings, always.** `us-fips:05061` (Howard County, Arkansas) loses its leading zero the instant anything calls `Number()`.

The seed reaches its single consumer, `game.js:98` `createChunkCache(cfg, worldSeed)`. `cfg.maze.salt` is untouched: **seed → epoch (which place)**, **salt → XOR (which floor)** stay orthogonal, per `levels.js` (`0x0000/0x1111/0x2222/0x3333`) and the assertions at `levels.test.js:39-42`.

### 2.4 The ID is the rendezvous token, not the pin

**The seed comes from the ID, never from the resolution.** This is load-bearing and it collapses most of the risk in this design:

- The start screen shows the sector ID as **copyable text**, next to the pin field.
- The pin **prefills** the ID. The human **confirms** it.
- Friends rendezvous by sharing `us-fips:24510` — **not** by both resolving the same pin.

This is strictly more reliable than any resolver because it removes the resolver from the trust path. It is also what makes §3's version-skew risk drop to zero for anyone who shares a token.

### 2.5 Sector → persistence key: **the room code is sacred**

Today `idFromName(room)` is the whole DO identity, and a room code **always** works. Rekeying the DO to include the sector would make the code insufficient — a friend typing `jeff-and-maddie` from memory would land in a different Durable Object with no error, no players, and no way to diagnose it.

**The DO key does not change. The sector is state *inside* the room DO, not a dimension of its key.**

```js
// relay/relay.js — default export, UNCHANGED
const room = (url.searchParams.get('room') || 'default').slice(0, 32)
const stub = env.ROOM.get(env.ROOM.idFromName(room))
```

The first connection into a virgin room fixes its sector, stored in `ctx.storage`, echoed to every joiner in `welcome`. The seed is **derived from stored state, never from a client message** — which kills Defect A structurally rather than patching it. Legacy rooms (`sectorId === null`) keep the existing storage-backed random seed; that storage is the only thing making a random room seed *shared*, so it stays.

### 2.6 Anchor and sector: disjoint jobs

They currently fight over `worldSeed` at `index.html:392`. A precedence rule would be fragile. Give them different jobs:

| Concept | Owns | Reaches |
|---|---|---|
| **Sector** | *which world* — `worldSeed = sectorSeed(sectorId)` | `game.js:98` only |
| **Anchor** | *where your body is* — `{lat, lng}` | `game.js:112` flavour, `:216` drift HUD, `btn-locate` |

`anchorSeed()` stays exported and tested so old saves replay their world; `index.html` simply stops calling it. This deliberately kills the ~11 m granularity bug: two friends pasting pins 20 m apart now get the **same** world, because both pins resolve to the same county.

**Anchor may be null and stays null.** Do not fabricate coordinates from a sector centroid — a player who never gave a location must not be told *"your body remains at 39.2904,-76.6122"* with a working button to a place they've never been. Degrade instead:

```
anchor set   → "your body remains at 39.2904,-76.6122."   + drift HUD + locate button
anchor null  → "your body is somewhere in Baltimore city."  (no coords, no button)
```

**Not doing:** "anchor picks your spawn chunk." Spawn is hardcoded `HALF + 0.5` (`game.js:106`, `:155`) — the origin room `world.js` guarantees carved open. An arbitrary spawn needs a find-an-open-cell routine that does not exist, and would make the drift HUD measure distance from an arbitrary point rather than anything geographic.

---

## 3. DETERMINISM GUARANTEE

**Claim:** two players who both intend "Baltimore" get byte-identical worlds, now and in five years.

| Step | Mechanism | Why it cannot drift |
|---|---|---|
| intent → ID | Human picks from the shipped ledger, pastes a pin, or **is handed the token by a friend** | All local. No third party. |
| ID → seed | `sectorSeed('us-fips:24510')` | Pure function of a string. Golden-value tested. |
| seed → maze | `generateChunk(cx, cy, epoch=seed, salt)` | Already deterministic (`world.js:84`), already asserted (`world.test.js:112-127`) |
| seed → MP world | Worker derives from stored `sectorId`; client uses `welcome.worldSeed` | Server is sole authority. Client never supplies a seed. |

**Cross-machine resolution is bit-exact and carries zero risk.** Point-in-polygon is `+ - * /` and comparisons on IEEE-754 float64; TopoJSON dequantization is integer delta-decode; the `Math.imul`/`>>> 0` seed math is exact. Same version, same pin ⇒ same sector on every CPU and engine.

**The real risk is version skew.** A ±10 km border uncertainty band across ~251,000 km of international borders ≈ **~3.4% of world land could flip sectors between dataset builds.** `electron-updater` means clients drift apart in an uncontrolled window.

Three locks:

1. **Write-once.** `sectorId` is written exactly once per install. Detection of any kind runs **only** when `prefs.sectorId === null`. Changing sectors is only ever an explicit player action. A re-detect on a later launch is the mechanism that orphans saves; it is forbidden in code and tested.
2. **The token beats the pin.** Version skew moves only what is *suggested*, never what is *played*. Anyone who shares an ID is immune.
3. **Version in the handshake.** `datasetVersion` rides in `join`/`welcome`. **Refuse the join on mismatch** with an in-fiction message. A refused join beats two people watching each other clip through walls — which is exactly what happens today, since `relay.js:47-50` broadcasts `pos` with zero validation that the clients agree on the world.

**ID mutation, honestly.** FIPS GEOIDs churn on renames: Dade FL `12025`→Miami-Dade `12086`; Shannon SD `46113`→Oglala Lakota `46102` (2015). Connecticut retired `09001`–`09015` in 2022 for planning regions; Alaska split `02261`. These are rare, announced, roughly decadal, and versioned. Every persisted sector carries `vintage`. A remapped ID changes that sector's maze — a real, bounded, detectable cost, and the best available option: OSM `osm_id` mints a new ID on any weekly reimport, and Nominatim `place_id` is documented as non-permanent and differs per server.

ISO alpha-2 is **not** the stable alternative it is assumed to be — codes have been reused five times (`BQ`, `AI` after an 8-year gap, `CS`, `GE`, `SK`), and ISO's only written rule is *"at least five years"*, not 50. This is a further reason `world:` keys on `ADM0_A3` rather than ISO.

---

## 4. LOCATION FLOW

A horror beat, not a consent dialog — and there is nothing to consent to, because nothing leaves the machine.

**This section describes the end state (post-Phase 2).** Per §10, Phase 1 ships §4.1 (intake), §4.3 (ledger), §4.4 (decline) and §4.6 (filed-under bar) — the ID and type-ahead paths, no polygons. The pin-resolution paths (§4.2 reveal, §4.5 ocean) arrive with Phase 2. Until then a pasted pin falls through to the ledger, which is the designed fallthrough anyway.

### 4.1 First launch — the front desk

`prefs.sectorId === null`. Replaces the anchor input at `index.html:287`. **Nothing is gated**; the button row stays live throughout.

```
                    ── VISITOR INTAKE ──

         a form has been left on the counter for you.
         someone has already started filling it out.
         they got bored.

         NAME ........ [ wanderer                    ]
         ORIGIN ...... [ ____________________        ]  ← blinking

              paste a maps link, or type a place.

                     [ FILE ME UNDER BALTIMORE ]
```

One field, three behaviours by what you type:
- **`parseAnchor` accepts it** (Maps URL, `@lat,lng`, `?q=`, bare `39.29,-76.61`) → resolve locally.
- **A sector ID** (`us-fips:24027`, `world:FRA`) → accept directly. *This is the rendezvous path.*
- **Anything else** → live type-ahead over the shipped ledger.

### 4.2 The reveal

The field is replaced, character by character, by what the building decides you are:

```
ORIGIN ...... [ 39.2904, -76.6122_          ]
ORIGIN ...... [ MARYLAND_                   ]
ORIGIN ...... [ BALTIMORE CITY, MARYLAND    ]

              file us-fips:24510.
              you have been here before.

              [ that's not me ]        [ ...yes ]
```

Showing the raw coordinates *before* the name — the machine's evidence, then its conclusion — doubles as debuggability: when resolution is wrong, the player sees why. *"you have been here before"* is a lie the building tells everyone; it costs one string.

Resolution is a bbox prefilter plus one ray-cast: sub-millisecond. The typewriter is the only thing making it take time, deliberately.

### 4.3 The ledger (type-ahead, offline, always)

```
> howard
  Howard County, Maryland ......... us-fips:24027
  Howard County, Texas ............ us-fips:48227
  Howard County, Indiana .......... us-fips:18067
  Howard County, Nebraska ......... us-fips:31093
  Howard County, Missouri ......... us-fips:29089
  Howard County, Iowa ............. us-fips:19089
  Howard County, Arkansas ......... us-fips:05061
```

Seven rows, seven IDs, one name — the executable demonstration that **name is not a key**. Search matches name, state, country or ID. Zero network, zero latency, zero ToS.

**The ledger is not the fallback. It is the correctness guarantee.** ~100 lines, and it is what makes every other path optional.

### 4.4 Decline

`FILE ME UNDER BALTIMORE` → `DEFAULT_SECTOR`, `sectorSource = 'default'`, play immediately. The house guessed Baltimore and it is not sorry.

### 4.5 No sector at this point — ocean only

`resolveSectorAt` returns `null` only for open ocean now that countries ship.

```
ORIGIN ...... [ 40.0000, -30.0000           ]

              there is no file for that place.
              the cabinet only goes as far as the coast.

              [ OPEN THE LEDGER ]     [ FILE ME UNDER BALTIMORE ]
```

### 4.6 After first launch

```
FILED UNDER ── BALTIMORE CITY, MARYLAND · us-fips:24510 ── [ copy ] [ refile ]
```

`refile` opens the ledger — the **only** way `sectorId` changes after first write (lock #1). `copy` is the rendezvous primitive.

### 4.7 Multiplayer

```
PLAY ONLINE — you'll enter BALTIMORE CITY together.
share this:  jeff-and-maddie
```

The share code is **unchanged** — the bare room code, exactly what people text each other. The sector rides as a separate `?sector=` param, used only if the room is virgin. A joiner filed elsewhere is told in character rather than silently relocated:

```
you are being refiled under BALTIMORE CITY for the duration of your visit.
```

---

## 5. FAILURE BEHAVIOR

| Failure | Behaviour |
|---|---|
| No network | **Nothing happens.** The sector path makes no network call. |
| Any API down / rate limited / garbage / timeout | **N/A.** There is no API. |
| VPN / datacenter / CGNAT IP | **N/A.** The IP is never consulted. The VPN user, the tethered user and the couch co-op pair all get exactly what they typed. |
| Pasted text unparseable | Falls through to ledger type-ahead. No error string. |
| Point in open ocean | `null` → §4.5. Not an error. |
| Point near a coastline | 5 km snap-to-nearest (§A.2) — required, not optional. |
| Point in two polygons (enclaves) | Smallest-area-wins. Deterministic. |
| Point in the US | US county file wins over the country file. Fixed order, tested (§A.2). |
| Saved GEOID absent from the current ledger (post-migration) | Loads as `unfiled · us-fips:09001` with a one-time refile prompt. **The world still generates** — the seed is a pure function of the string and needs no ledger. |
| Dataset missing/corrupt | ORIGIN accepts ledger/ID input only; pins report *"the cabinet is jammed. type it yourself."* `DEFAULT_SECTOR` is a **literal in `sector.js`**, deliberately not read from a data file, because a corrupt data file is one of the failures it absorbs. |
| Player presses PLAY before filing | `DEFAULT_SECTOR`, refile stays live. |

Every failure converges on the ledger — one screen, already the primary path.

---

## 6. MODULE BOUNDARIES

The renderer runs at a `file://` origin (`main.js:88 loadFile`). **Any outbound HTTP must live in the main process behind a narrow IPC method.** There is no HTTP in v1, but the constraint is recorded because a later phase may need it.

> **Proof this constraint is real:** `world.js:35` does `fetch('./world.json')` from a `file://` page. Chromium's `fetch` has no `file:` scheme, so it throws, and `world.js:39-41`'s bare `catch { return DEFAULT_CONFIG }` swallows it. `game.js:52` (`await loadConfig()`) has therefore always received `DEFAULT_CONFIG`. Nobody noticed because `src/renderer/world.json` still closely matches it.
>
> **This is not a five-line cleanup, and an earlier draft of this spec was wrong to call it one.** `world.json` is the **output of the wish pipeline** — `.github/workflows/wish-grant.yml` reads it (`:25`), writes the Claude-modified version back (`:59`), commits it (`:78`), and merging ships a release players auto-update into. README sells this as a headline feature: *"when a wish is granted, the world drifts… players update and notice the world is not quite as it was."*
>
> **Every granted wish has therefore been a no-op.** The issue is labelled, the API is called, the PR opens, the version bumps, the installer builds, players update — and the game reads `DEFAULT_CONFIG` exactly as before.
>
> So the fix is **not** "delete the file and the fetch" — that would silently delete the wish system. It is to **make `world.json` load via IPC from the main process**, which would make the wish pipeline work for the first time. That touches the release pipeline and is unrelated to sectors: **it gets its own spec and plan.** Removed from Phase 0.

**New — pure / shared**

| File | Purpose | Interface |
|---|---|---|
| `src/shared/sector.js` | The contract. Imported by renderer **and** worker. | `DEFAULT_SECTOR`, `sectorSeed(id)`, `isSectorId(s)`, `normalizeCustom(s)` |
| `src/renderer/places.gen.js` | **Generated, committed.** Names + IDs + neighbours. **A JS module, not `.json`** — see the `world.json` proof. | `VINTAGE`, `PLACES` |
| `src/renderer/gazetteer.js` | The **only** source of sector names anywhere. | `lookupSector(id)`, `searchSectors(q, limit)`, `neighborsOf(id)` |
| `src/renderer/sector-ui.js` | Intake, typewriter reveal, filed-under bar, ledger. Owns no state; takes callbacks. `index.html` is already ~600 lines of inline script and must not grow. | `mountIntake(el, {onFiled})`, `mountFiledBar(el, sector, {onRefile})` |

**New — main process**

| File | Purpose |
|---|---|
| `src/main/places.js` | Point-in-polygon over both datasets, in fixed order. **Lazy-loads on first IPC call, never at startup** — `main.js:26-30` is the pre-`whenReady` critical path and nothing new goes there. `resolveSectorAt(lat, lng) -> id \| null` |

**New — data / tooling**

| File | Purpose |
|---|---|
| `data/counties.topo.json` | Pinned `cb_2024_us_county_500k`, simplified. ~820 KB. |
| `data/world.topo.json` | Pinned `ne_10m_admin_0_countries`, simplified. **207 KB measured** (§A.2). |
| `tools/build-places.mjs` | One-shot dev script, **not a build step**. Output committed and reviewed as a diff. Must **not** use `us-atlas@3` (§A.3). |

**Changed:** `src/main.js` (one `ipcMain.handle`), `src/preload.cjs` (one method — **not** a generic fetch escape hatch), `src/renderer/index.html` (swap `anchorSeed` → `sectorSeed`; one `applyIdentity()` from all three origins), `src/renderer/prefs.js` (`sectorId`, `sectorSource`, `sectorVintage` — **declared in `PREF_DEFAULTS`**, not smuggled in via `setPref` the way `playerName` was at `index.html:399`, invisible to `prefs.test.js:16-17`'s coverage loop), `src/renderer/game.js` (`initGame` gains `sector`; `snapshot()` gains `sectorId`/`sectorVintage`; **`v` stays 1** — `save.js:12-15` merges and tolerates extra keys, so no player loses a run), `relay/relay.js` + new `relay/seed.js`. `src/renderer/anchor.js` is **unchanged**.

---

## 7. TESTABILITY

**Pure, zero mocks, house style (`environment: 'node'`):**

| Test | Asserts |
|---|---|
| `test/sector.test.js` | Golden seed values as literal snapshots. `sectorSeed` never returns 0 across **every** ID in the ledger. No collisions across all ~3,493. `isSectorId` rejects `'24027'`, `'us-fips:5061'`, `24027`, `null`, trailing space. `normalizeCustom` is frozen and total. |
| `test/gazetteer.test.js` | Every GEOID is a 5-char zero-padded string. No duplicate IDs. `24510` and `24005` both present, both named `Baltimore` — executable proof that name is not a key. `searchSectors('howard')` returns exactly 7. `ADM0_A3` unique 258/258. **No ID is ever `-99`.** |
| `test/sector-agreement.test.js` | **The critical one.** The renderer's and the worker's import paths of `src/shared/sector.js` produce identical uint32s for a golden list. A silent divergence means *"we're in the same room and I can walk through his walls."* |
| `test/relay-seed.test.js` | §1.5's postconditions. |
| `test/world.test.js` (extend) | A sector-derived seed produces stable chunks across eviction (`world.js:180-191`). |

**Fixture, still no mocks:** `test/places.test.js` — `resolveSectorAt` against 3 synthetic polygons plus real assertions: `39.2904,-76.6122 → us-fips:24510`; `39.2037,-76.8610 → us-fips:24027`; `51.5074,-0.1278 → world:GBR`; **two points 20 m apart resolve to the same ID** (the premise test); **a US coastal point 150 m offshore still resolves to its county, not `world:USA`** (the double-coverage regression, §A.2); `40.0,-30.0 → null`; entity count assertions (`258`, §A.2).

**Cannot be tested, and we accept it:** `game.js` and `index.html` have zero coverage — vitest runs `environment: 'node'` with no jsdom. All three seed origins and the sole consumer are untested. **This is why `applyIdentity()` must be one function called from three places.**

---

## 8. ENDGAME PATH

### 8.1 Portals (#2)

```js
const { lat, lng } = offsetLatLng(anchor, bearing, portalRangeMeters)
const sectorId = await window.backrooms.resolveSectorAt(lat, lng)   // same call as intake
```

Identical path to first launch, **offline, so warps work with the network down**. "Find the entrance to Howard County" is answerable because we shipped boundaries: polygons give direction-to-the-line, and a precomputed neighbour table (from shared TopoJSON arcs) gives adjacency.

**Warp is the one subsystem guaranteed to hit `null`** — it *generates* points programmatically, so it will land on borders, in exclaves, and in the ocean. `null` must have defined behaviour: the elevator opens on nothing. Design it in #2, do not discover it.

### 8.2 The board is fixed. Area drives density, not extent.

**Retracted from an earlier draft:** "sector land area bounds the board" does not survive arithmetic. With `CHUNK_SIZE = 22`, 1 cell = 2 m, and `SPEED` × 60 fps = 6 m/s:

| Sector | Chunks | Cross once |
|---|---|---|
| Baltimore City (209 km²) | 108,000 | 40 min |
| **Howard County (650 km²)** | **336,000** | **71 min** |
| Russia (17.1M km²) | 8.8 B | 8 days — and ~441 GB against a **10 GB per-DO cap** |

Two players capturing Baltimore City at 10 s/chunk is **12.5 days of continuous play**. The flagship "dense knife-fight" tier fails by ~70×. Log-compressing area doesn't save it either: it makes Baltimore City and Howard County a 1.2:1 — destroying the exact distinction the system existed to express.

**Resolution:** a **fixed contestable board for every sector** (~64×64 chunks ≈ 2.8 km, ~8 min to cross — an actual knife-fight). Area becomes a **cosmetic modulation** of `roomChance`, `braid` and corridor width. *Baltimore feels tight because the walls are close, not because the map is small.* This is the only version that survives a calculator, and it makes §2.2's grain heterogeneity a non-issue.

**To be unambiguous: the maze stays infinite.** `world.js` generates without bound in every direction and that does not change. The board bound is a **territory-layer concept only** (#4) — the region within which beacons spawn and ownership is tracked. Walk past its edge and the Backrooms continue exactly as they do today; you have simply left the contested ground. This distinction is load-bearing: nothing in #1 or #2 makes the world finite.

### 8.3 Territory (#4)

Territory lives in a dedicated `territory:<sectorId>` DO; play stays in `room:<code>` DOs. Room DOs emit idempotent `{roomId, eventId, sectorId, cx, cy, playerId, ts}`; the territory DO is the **single writer** and dedupes on `(roomId, eventId)`. It can regenerate any chunk server-side (`sectorSeed` is pure, `generateChunk` is deterministic) to **validate a claim without trusting the client**.

**Blocking precondition:** `pushPlayers()` (`relay.js:78-86`) is O(n²) — it fires on **every** `pos` at 20 Hz per client and serializes the full roster to every socket. 20 players ≈ 8,000 sends/sec on one thread. This is latent only because room codes are private and keep rooms tiny. Fix it (a 20 Hz `setInterval` tick, O(n), exactly as `server/index.js:26-33` already does) **before** #3/#4 ship.

**Density:** beacons-per-chunk is a constant. Rural sectors get exactly as many objectives as Baltimore. Sector identity supplies the *name*, never the *content budget*. **Never weight anything by real population** — that re-imports the urban advantage generated density exists to escape.

**Scope:** territory is scoped per-sector by construction. There is no global seed space and a sector-scoped DO cannot express a global leaderboard. The "scope to the friend graph, never globally" lesson is satisfied structurally rather than by discipline.

### 8.4 What #1 does not foreclose

OSM-structural generation (roads→corridors, footprints→rooms) slots in behind the same ID — a sector already has a name, a boundary and a centroid, exactly the query key an OSM extract needs. Note the ODbL share-alike risk if OSM-derived data becomes persistent game state; Census and Natural Earth are public domain with no such condition, which is reason to keep the **keys** PD-derived even if the **geometry** later comes from OSM.

---

## 9. PHASE 1b — the thing that would make this land flat

**Verified:** `items.js:136` (`salt = (cfg?.maze?.salt | 0)`) and `decor.js:144` (`salt = cfg.maze?.salt | 0`). `game.js:98-103`:

```js
const cache = createChunkCache(cfg, worldSeed)   // ← the ONLY consumer
const decor = createDecorSystem(cfg, ...)        // ← no worldSeed
itemSys.enterLevel(cfg)                          // ← no worldSeed
```

**`worldSeed` reaches walls and nothing else.** Every sector on level N has byte-identical item, exit and NPC placement. A player who visits Howard County and Baltimore finds the same radio in the same relative room.

The moment anyone notices, "your real county is your world" is revealed as a skin over a hash.

**Phase 1b is scheduled in the same sprint as Phase 1, not deferred:** thread `worldSeed` into `itemSys.enterLevel` and `createDecorSystem`. Test fallout in `items.test.js` and `decor.test.js` is real — those suites assert placement against the salt-only seed and need golden values regenerated. **This is the one genuinely non-trivial piece of work here. Scope it deliberately; do not discover it after shipping.**

---

## 10. SEQUENCING

| Phase | Contents | Proves |
|---|---|---|
| **0** | Relay: read `msg.worldSeed`; **delete** `storage.delete('seed')`; echo `roomId`; `relay/seed.js` + test. `applyIdentity()` (Defect D). | Anchored online play works **for the first time**. Worlds survive an empty room. **Ships alone, no new UI.** |
| **1** | `sector.js`, `places.gen.js`, `gazetteer.js`, `sector-ui.js` (ledger + ID entry), swap the seed origins, `datasetVersion` in the handshake. | ~250 lines, pure, node-testable, zero network. Two players typing `baltimore` provably get the same world. |
| **1b** | Thread `worldSeed` into items/decor (§9). | Sectors feel like different places. |
| **2** | `places.js` polygons, `resolveSectorAt`, the pin reveal, neighbour table. | Real geo tether, offline. Unlocks #2. |
| **3** | Fix the O(n²) broadcast (§8.3). | Precondition for #3/#4. |

**Phase 0 alone fixes two shipped bugs and is worth merging on its own.**

---

## 11. FOR A HUMAN TO DECIDE

1. **The Activision patent.** US12296271B2, *"GPS seed for game play"*, granted 2025-05-13, active to ~2039. Claim 1: receive GPS location from a game device → form a seed from those coordinates → procedurally generate a game world (coverage discussion explicitly names **maze layouts**). `anchorSeed(lat,lng)` at `anchor.js:37` reads on this **today**, before any of this work. `sectorSeed(id)` is arguably further away — it hashes a government administrative identifier, and coordinates→sector is a lookup, not seed formation. **This is not legal advice.** For a hobby game among friends the practical risk is negligible; if this is ever distributed at scale, get a professional opinion before #2–#5 stack on it. (US9861889B2 / QONQR, location-based gaming with real-world population centers, is **expired** — that space is open.)
2. **Disputed territory is unavoidable.** Natural Earth is explicitly *de facto*: Taipei→Taiwan, Pristina→Kosovo, Hargeisa→Somaliland, Simferopol→**Russia**, El Aaiun→Morocco, Srinagar→India. Jerusalem→Israel at 10m but →Palestine at 50m — **the answer changes with scale**. There is no neutral option; the `_iso` variant folds Kosovo→Serbia, which is a *different* claim, not a neutral one. **Recommendation: ship the de facto default, display `NAME_EN` only, keep `ADM0_A3` internal, and never surface a flag.** Confirm this is acceptable.
3. **Grain is a taste call.** Howard County ≈ 650 km²; everyone in a metro shares one maze. "I'm in Howard County world" is less intimate than "I'm in Ellicott City world." Since the board is fixed (§8.2), sector size constrains nothing but *identity granularity* — but it **is** the identity. **Chosen: truthful-and-coarse over intimate-and-wrong.** Confirm.
4. **Is Phase 1b funded?** If not, don't ship Phase 1 — you'd ship the cost and defer the payoff (§9).
5. **`custom:` — in or out?** A free-form `custom:camden-high-street` folder ("the cabinet has blank folders; the clerk writes what you tell him") costs 0 KB and is arguably more Backrooms-native than a flag. It is specified in `isSectorId` above but **not** in any Phase. Decide whether it ships in Phase 1 or never.

**Non-blocking, recorded:**

6. `vintage` is a schema constant masquerading as config. Changing it is a migration, not a dependency bump. Record it in every save and DO row from day one.
7. `DEFAULT_SECTOR` is one Baltimore for everyone who declines. Fine today (declining sets a *solo* default; rooms are keyed by private code). If a sector ever becomes a DO key, revisit before it becomes the most populated place in the game.
8. **Nothing leaves the machine in v1.** No IP, no coordinates, no sector. Coordinates from a pasted pin never touch disk — only the ID and vintage persist. Say it in the credits and mean it.
9. **Attribution:** Census TIGER and Natural Earth are both public domain — no attribution, no share-alike. Natural Earth's terms: *"No permission is needed to use Natural Earth."* (Its site footer says "All rights reserved" — WordPress boilerplate contradicting the Terms page. Screenshot the Terms page for the file.)

---

## APPENDIX A — verified research

### A.1 IP geolocation (tested 2026-07-16, always with an explicit public IP; no machine was self-located)

- **No keyless service returns county.** None of six.
- **freeipapi → Baltimore; ipwho.is → Clarksville — same IP.** This alone disqualifies IP as a key.
- 3 of 6 were ~30 km off on a trivially verifiable university IP; ipinfo named the wrong state.
- `ip-api.com` is disqualified regardless: free tier is HTTP-only, and its ToS reads *"strictly limited for a non-commercial purpose and in a non-commercial environment."*
- If IP prefill is ever added: `https.get(url, {timeout})` **does not abort** — `req.on('timeout', () => req.destroy())` is mandatory or the socket hangs forever. Pin a `GEO_TEST_IP` and unit-test that the built URL always contains an explicit IP segment, or dev runs geolocate the developer.

### A.2 Natural Earth admin-0 (downloaded, built and measured)

```
mapshaper ne_10m_admin_0_countries.shp \
  -filter-fields ADM0_A3,ISO_A2_EH,NAME_EN \
  -simplify 3% keep-shapes -clean \
  -o format=topojson quantization=3e5 world_admin0.topo.json
```

**207,287 B raw / 74,370 B gzip. 258/258 entities, 0 invalid geometries, `ADM0_A3` unique 258/258.** Resolves 50/50 real cities (incl. Vatican, Monaco, Tuvalu, Honolulu) with 0 wrong and 0 null; all 5 ocean controls correctly `null`.

Three findings that **must** survive into implementation:

1. **Quantization, not simplification, kills microstates.** `q=1e4` (≈4 km) silently drops 8 entities **including Tuvalu, a UN member state**, plus Vatican and Gibraltar. `q=1e5` still breaks Vatican→Italy. **`q=3e5` (≈130 m) is the threshold.** mapshaper does not error — the entity count just drops. **Assert `258` in CI.**
2. **A 5 km snap-to-nearest fallback is required.** Coastal cities land 0.1–2.9 km *offshore* of generalized coastlines — NYC, Copenhagen, Lisbon, Stockholm, Rio and Hong Kong all return `null` on exact point-in-polygon at 50m. Accuracy is **not monotonic with scale**. Ocean controls confirm 5 km causes no false land hits. Use **smallest-area-wins** on multi-hits for enclaves.
3. **Scale choice is forced.** 110m omits **65 entities** including Singapore, Malta, Monaco, Andorra, Bahrain, Hong Kong (a player in Singapore resolves to **Malaysia** — verified). 50m is unusable: Vatican→Italy even unsimplified, and at 1% simplification **London itself returns null**. **10m is the only viable scale** — and after the build above it costs 207 KB, not the ~25 MB its raw shapefile suggests.

**Double coverage is not an edge case — it is the entire US.** Both datasets cover every US point, so resolution order is load-bearing for 100% of the current playerbase. Census `cb_*_500k` files are **clipped to shoreline**; Natural Earth's US polygon is not. A pin 150 m offshore in the Inner Harbor falls out of every county and into `world:USA` — *two friends 150 m apart, different worlds*. **US-county-first, then the 5 km snap, then countries.** This ordering is a tested invariant, not a comment.

### A.3 Rejected data sources

| Source | Why |
|---|---|
| **geoBoundaries CGAZ** | License is **not** clean CC BY 4.0: of 230 ADM0 sources, **84 are ODbL** and 11 CC BY-SA; GitHub resolves the repo as `NOASSERTION`. 154.6 MB. `id` is 100% NULL. Hard-codes a **US Department of State** worldview. |
| **world-atlas npm** | Built from Natural Earth **4.1.0**, last published 2022. IDs are ISO numeric strings; the `-99` problem ships as **null ids** (16 at 10m), and id `'036'` is **duplicated** — not a primary key. |
| **OSM / Nominatim / Photon** | ODbL share-alike — a Derivative Database obligation if IDs or names become persistent game state. Nominatim also disqualified **by policy** for a distributed desktop app. |
| **FAO GAUL legacy** | Non-commercial. |
| **`us-atlas@3`** | Stale: contains retired `09001` and `02261`, lacks `09110`/`02063`/`02066`. Its `properties.name` is the bare name, so `24510` and `24005` are **both** `"Baltimore"` and there are seven bare `"Howard"`s. (An 842 KB copy was downloaded into the repo root during research and has been removed; add to `.gitignore`.) |

### A.4 Sources of the codebase claims

Every file:line in this document was read and verified on 2026-07-16 against the working tree at commit `77968e8`.
