# The Beacon Atlas — design

> **Status:** design, approved in brainstorming 2026-07-25. Umbrella spec for a three-subsystem
> feature. Each subsystem gets its own implementation plan.
>
> **Disclosure boundary (read first).** This document is in a **public** repository. It describes the
> *properties* of the beacon-placement system but deliberately contains **none** of its mechanism. The
> keyed cell derivation, the distinct-player accumulation, the population threshold, and the POI-snap
> internals live in a **private** companion spec (`04_DESIGN-SPEC_atlas-placement-engine.md`, kept
> outside every repo) because that mechanism is adjacent to a pending patent disclosure. Treat the
> placement engine here as a **black box** that emits public-landmark, k-anonymous beacons. Do not add
> mechanism detail to this file.

## 0. One line

Real-world "doors" (beacons) surface on a public map as the playerbase grows; players reach them by
walking there or by dropping in from a map link; every visit leaves a permanent layer, so each door
becomes a readable archive of everyone who ever observed it.

## 1. The loop, end to end

1. A player starts a run from a real place (existing `anchor.js` flow: a pasted Google Maps link or
   `lat,lng` → `{lat,lng}` → deterministic world seed). The **placement engine** privately notes the
   spawn-in. This is invisible in-game and never stored as a point (see the private spec).
2. When an area has accumulated **enough distinct players**, the engine surfaces a **beacon**, snapped
   to a **public landmark** in that area, and it appears on the **Atlas**. Genesis beacons (hand-placed,
   lore sites) are present from day one; organic beacons appear only as areas legitimately qualify.
3. A player reaches a beacon two ways:
   - **Physically** — go to the real place. Free, and it writes a **deep** stratum (strongest record).
   - **Drop in** — paste a map link and arrive from anywhere. Costs a distance-scaled resource
     (**passage**) and writes a **faint** stratum. **Travel items** reduce the cost or extend range.
4. Each visit **deepens** the beacon's strata. Nothing is consumed; late arrivals find more than early
   ones did.
5. The **Atlas** renders all of it: the live map, and the readable archive you decode down through the
   layers. The public web **reads** everything and **writes** nothing; every world-change flows through
   the authenticated game client.

## 2. Beacons (public view)

A beacon is a public marker on the Atlas at a real-world **public landmark** — a park, library, transit
stop, civic or commercial POI. Two kinds:

- **Genesis** — hand-authored, tied to the lore (the first is **806 N Carey St**, Level ∅; a few more
  Observer-relevant sites). Present at launch, visually distinct (gold).
- **Organic** — produced by the placement engine as the playerbase grows (signal-green).

**The k-anonymity property (guaranteed by the engine, not by this document):** an organic beacon can
only exist after **≥ N distinct players** have entered its coarse area, and it is always snapped to a
**public landmark**, never to a spawn coordinate and never to anything residential. Therefore the
strongest inference any observer can draw from a beacon is *"≥ N different people have, at some point,
entered from somewhere in this ~1 km area"* — attached to a landmark, **never to a person and never to a
point.** `N` is chosen so this holds even at low population (see the private spec for the value and how
it adapts).

The placement engine is a black box to everything in this document: it takes spawn-ins and emits
POI-snapped, k-anonymous beacons. Nothing here — no client, no public API, no map tile — ever sees a
cell boundary, a player count, a distinct-player token, or a raw coordinate.

## 3. Strata (the payoff)

A **stratum** is one record a visit writes to a beacon:

```
stratum = { visit_id, beacon_id, tier: "deep" | "faint", ts, fragment, actor_pseudonym }
```

- **Never consumed.** Visits accumulate; a beacon only deepens. This is the whole reason the Atlas is an
  archive rather than a race board.
- **Deep vs faint.** A **physical** arrival (presence proof, §4) writes a **deep** stratum carrying a
  full fragment and the better reward. A **drop-in** writes a **faint** stratum: a thin mark, low reward.
  This is the membrane spec's *proof-strength → reward-value* ladder
  ([2026-07-18-two-way-membrane-design.md](2026-07-18-two-way-membrane-design.md) §3), reused.
- **The archive.** A beacon's stack of strata is its readable history. The Atlas renders it as layers you
  read *down* through — the last to arrive reads everything laid before them. Fragments are the
  Cicada/Observer content (ciphered lore, clues), authored or templated per beacon.
- **Storage.** Strata live server-side in the relay Durable Object (extended per the Phase-0 persistence
  fix in [2026-07-16-geo-tethered-sectors-design.md](2026-07-16-geo-tethered-sectors-design.md)).
- **Public exposure is redacted.** The public archive shows the fragment, the tier, and the timestamp. It
  does **not** expose the actor pseudonym in a way that links strata across beacons into a trail (a
  trail across real places is a tracking primitive; see §6).

## 4. Travel & the near-world bias

The design goal you set: reaching *local* doors should be easy and worth more; reaching *distant* doors
should be expensive and worth less; and items should help.

- **Physical arrival is free** and writes a deep stratum. You already paid with your feet; the game does
  not charge you again, and it rewards you the most. This is what biases the whole system local —
  nobody walks 500 miles, so the doors you actually stand at are the ones near you.
- **Drop-in costs "passage."** A drop-in via a map link spends a resource that **scales with distance**
  from where you last were, and writes only a faint stratum. Far doors cost a lot of passage for a thin
  reward; near doors cost little.
- **Travel items** (new loot types in the existing `items.js` inventory) **reduce passage cost or extend
  range** — the facilitators you asked for. They are place-seeded loot like the existing almond-water /
  glowstick / bandage, so they slot into the system that already exists.
- **Reward** grants into the existing inventory, typed from the beacon's place — deep (physical) visits
  get the better loot. No parallel economy; the payoff feeds the game you already have.

**Anti-abuse falls out of the shape:** couch-touring distant beacons is capped by passage cost *and* by
faint-only strata, and the high-value deep tier is gated on a presence proof the drop-in path cannot
supply. The presence-proof tiers are the verification ladder (T0 asserted → T1 soft geolocation → T2/T3
on-site) already specified in the membrane spec and begun with the beacon T0 work.

## 5. The Atlas (public site)

The site is a significant, interactive surface — **not** a map viewer. It has two faces.

### 5.1 Public read surface (no login, mobile-first)

- The **map**: a dark-styled slippy map (MapLibre/Leaflet) with beacon markers — genesis gold, organic
  signal-green — matching the landing-page aesthetic already on `gh-pages`.
- **Read the archive**: click a beacon → read *down* its strata, decode the fragments, follow a beacon's
  lineage. This is the deep interactivity.
- **The field instrument**: the site is mobile-responsive, and the phone is where the *physical* half of
  the loop happens — you check in (geolocation) at a real door from your phone's browser on the Atlas,
  not from the desktop game. (See §8 on mobile.)

### 5.2 Private console (signed in)

- Your travels, your laid strata, your **passage** balance, generated **drop-in links** to paste into the
  game, and beacon watchlists.
- It **reads everything and writes only to your own account.** Every change to the *shared* world still
  goes through the authenticated game client — the public web can read the whole world and change none
  of it. This is the smallest possible abuse/child-safety surface, and it is a hard constraint (§6).
- **Auth: a claim-code bind.** The game shows a short one-time code; you paste it into the Atlas to bind
  the console to your game identity. No passwords, no account creation flow on the web. (Recommended over
  email magic-links; revisit if the game grows a real account system.)

### 5.3 Architecture

- Static front-end on **`gh-pages`** (the existing deploy).
- A Cloudflare **Worker read-API** backed by the existing relay **Durable Object**, which holds beacon +
  strata state.
- **Public** endpoints (`GET /beacons`, `GET /beacon/:id/strata`) expose only POI-snapped beacons and
  redacted, k-anonymous strata. **Console** endpoints require the claim-code session and are scoped to
  the caller's own account.
- The renderer never calls the network directly (the game's existing constraint); the game client's
  world-writes go through its own authenticated main-process path.

## 6. Safety & privacy (hard constraints, non-negotiable)

- **Public data reveals only landmarks and k-anon strata** — never a coordinate, never an identity, never
  a per-person trail across beacons. A trail across real places is a stalking primitive; the API must not
  emit one.
- **A minor participates (Marshall, 15).** Every choice above is the conservative one for that reason:
  POI-snap not raw location, ≥N k-anonymity, web-reads-only, physical-proof-gated deep tier, no occupancy
  read-path.
- **Web reads, game writes.** No path lets an anonymous web caller mutate the shared world.
- **The placement mechanism stays private** (patent boundary, §0). The property is public; the mechanism
  is not.

## 7. What this builds on (nothing is greenfield)

| Piece | Already shipped / specified |
|---|---|
| Real place → seed | `anchor.js` (`parseAnchor`, `anchorSeed`, `bodyUrl`), the "locate your body" flow |
| Coarse geographic partition + rendezvous token | [geo-tethered sectors](2026-07-16-geo-tethered-sectors-design.md) (§2.4 "the ID is the token, not the pin") |
| Place-seeded loot | `items.js` graded loot; Phase 1b makes loot place-specific |
| Persistent shared server state | the relay Durable Object (Phase-0 persistence fix) |
| Proof-strength → reward ladder | [two-way membrane](2026-07-18-two-way-membrane-design.md) §3 (T0–T3) |
| Outbound "reacts in the real world" | the beacon T0 work (player-registered webhook, SSRF-hardened) |
| The lore anchor | Level ∅ / 806 N Carey ([level-zero spec](2026-07-16-level-zero-factions-and-grain-design.md)); the public landing page |

## 8. Mobile

- **The Atlas is mobile from day one** — it is responsive HTML, and it is the intended *field* surface.
  The walk-to-a-door half of the loop wants a phone in your pocket, so the phone (browser + geolocation on
  the Atlas) is the field instrument; the desktop client stays where you "descend."
- **The game client stays desktop** (Electron/Windows). A native mobile game client is a large, separate
  effort and is **not** required for this feature — the Atlas carries the field role. Recorded as a
  decision, not a gap.

## 9. Decomposition & sequencing

Three sub-projects, each independently testable, each its own plan:

| # | Sub-project | Owns | Depends on |
|---|---|---|---|
| **A** | **Placement engine** (private spec) | spawn accumulation, k-anon eligibility, POI snap, genesis/organic | — |
| **B** | **Strata & travel** | stratum model, deep/faint, passage economy, travel items, reward ladder | A |
| **C** | **The Atlas** | public map + archive read-API, private console, claim-code auth | A, B |

**Build order A → B → C**, but a thin **read-only** slice of C (map + genesis beacons) can ship early so
the world is visible while B is in progress. **MVP:** genesis beacons on a read-only Atlas + physical
deep-stratum check-in; passage/travel-items and the console follow.

## 10. What we are NOT building (YAGNI)

| Not building | Why |
|---|---|
| A second *playable* web surface (web writes to the world) | §6 child-safety/abuse surface; the game client is the only writer |
| Raw-coordinate beacons / geographic coarsening | §6; POI-snap + k-anon only |
| A parallel currency | passage and rewards live in the existing inventory |
| A native mobile game client | §8; the Atlas is the mobile/field surface |
| Territory/combat over beacons | strata accumulation is non-zero-sum by design; territory can emerge later from strata depth without a combat loop |
| Placement mechanism in this repo | §0 disclosure boundary |

## 11. Open questions

1. **Passage units and the distance curve** — linear, or steeper (so 2× distance is ≫ 2× cost)? Tune to
   make "the next town over" reachable and "across the country" a real commitment.
2. **Fragment authoring** — fully hand-authored per beacon, templated, or seeded from the place? Genesis
   beacons are hand-authored; organic beacons need a scalable fragment source.
3. **Claim-code lifetime and rebind** — one code per device? revocation?
4. **Console identity vs game identity** — the game currently has only a localStorage player name; the
   claim-code binds to *something* — define the durable player id it binds to.
5. **When does an organic beacon retire or move?** Or do they only ever accumulate? (Leaning: never
   retire — permanence is the point.)
