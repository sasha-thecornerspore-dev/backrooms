# Level ∅, Factions, and Baltimore Grain — design

**Date:** 2026-07-16
**Status:** proposed — amendment to [2026-07-16-geo-tethered-sectors-design.md](2026-07-16-geo-tethered-sectors-design.md)
**Scope:** answers the open questions in that spec's §11, adds the overworld verdict, the faction function, and sub-county grain.

> **Provenance:** the research behind this was verified — real files downloaded and measured, real endpoints queried, real statutes read. The adversarial critique and synthesis phases **did not run** (session limit). Treat the *facts* as verified and the *judgement* as one pass, not three.

---

## 0. DECISIONS TAKEN

Answers to §11 of the parent spec:

| # | Question | Decision |
|---|---|---|
| 1 | Activision patent `US12296271B2` | **Noted, proceeding.** Recorded in the parent spec §11.1. Not revisited. Not legal advice. |
| 2 | Disputed borders — ship de facto, hide the flag? | **Rejected — inverted.** Contested ground becomes the game's factions, derived mechanically (§4). |
| 3 | County grain too coarse? | **Superseded.** Baltimore City gets neighborhood grain (§5). |
| 4 | Is Phase 1b funded? | **Yes. Mandatory.** Without it every sector shares identical furniture and the premise is a hash with a name taped on. |
| 5 | `custom:` in or out? | **In**, Phase 1. Zero KB, no downside. |

---

## 1. THE OVERWORLD VERDICT — measured

**Do not rasterize real streets.** The reason is not cost. It is that the engine cannot render the thing the feature was for.

### 1.1 The renderer cannot draw a building

| Constraint | Evidence |
|---|---|
| Wall height is hardcoded at **exactly 1 world unit = 2 m** | `renderer.js:263` — `const whF = H / Math.max(0.001, corr)`, slice centred at `HH - whF/2`. There is no per-cell height. |
| Nothing behind a wall can ever be drawn | `raycaster.js:23-28` — `castRay` returns on **first hit**. |
| Hard **192 m** view clamp | `renderer.js:256` — `rayMax = Math.min(96, ceil(fog)+3)`. The Inner Harbor is ~1 km across. |

A geographically accurate Baltimore in this engine is **a 2-metre-tall hedge maze shaped like Baltimore, with a sky**. A downtown high-rise and a rowhouse render identically. No skyline, no landmarks, **no recognition** — and recognition was the entire point.

A skyline requires per-cell heights **and** multi-hit rays. That is not a modification of `castRay`; it is a different renderer (est. 3,000–5,000 lines against a **3,173-line** codebase — i.e. doubling the project), and §1.2 shows it lands at 117–198% of frame budget anyway.

### 1.2 The perf model — the prior assumption was wrong

Measured: 1152 ray columns (1920 × `RENDER_SCALE` 0.6), 64 view angles, 400 frames, real chunk-cache `isWall` path.

| Scenario | fog | wall-pass ms | % of 16.7 ms frame |
|---|---|---|---|
| **office maze (shipping)** | 16 | **1.71** | 10.3% |
| street grid (100 m blocks / 12 m streets) | 96 | 4.03 | 24.1% |
| open plaza | 60 | 19.45 | **116.5%** |
| **open plaza** | **96** | **32.98** | **197.5%** |

**Streets are affordable — 2.35× the shipping maze.** The earlier "long sightlines = perf cliff" fear was **false**: a street canyon is still a maze, because facades 12 m across terminate rays early. Counterintuitively, as fog *rises* the share of rays running to max *falls* (20.3% → 3.9%).

**The cliff is open ground** (harbor, parks, lots) at **19.25×** — precisely where landmarks would go. And wanting a skyline makes the plaza number the *normal case everywhere*, because multi-hit rays never terminate early.

**Outdoors is partly cheaper:** flat sky replaces the textured ceiling raster — 22.88 ms → 9.30 ms, roughly **2.3× cheaper**, a saving that *exceeds* the extra ray cost of streets. An outdoor level with single-height walls is plausibly **net cheaper than the current indoor maze**.

### 1.3 The aesthetic argument

Two points decide it:

- **Schrödinger's Baltimore.** `game.js:112` — *"your body remains at 39.2854,-76.6083"* — works **because the surface is unreachable**. Rendering it is the one act guaranteed to destroy it: a rendered Baltimore is a *disappointing* Baltimore (2 m tall, blocky, fogged, empty), and the line stops being a haunting and becomes a caption on a bad model.
- **The Backrooms is a wiki.** Its native form is bureaucratic documentation of a place you cannot visit. The parent spec's front desk (`VISITOR INTAKE`, `FILED UNDER — BALTIMORE CITY · us-fips:24510`) **is already the overworld**, and it is Ingress's model exactly: the map is a menu, not a place. Niantic never rendered a walkable street — the player's real body walked it.

### 1.4 Options, by honest cost

| | Option | Cost | Verdict |
|---|---|---|---|
| **A** | **Overworld as a map screen.** Pick sector/portal/target; no-clip *down*. Not walkable. | ~300–600 lines, **zero renderer change**. Reuses the 207 KB TopoJSON already specced. | **Ship.** Territory, portals, "find the entrance to Howard County" — all of it lands here. |
| **B** | **Level ∅ — one hand-authored walkable place.** Sky instead of ceiling. Geo-*true*, not geo-generated. | ~1 week. Sky is a *saving*. | **Ship** (§2). |
| C | Literal street raster, single-height walls | 6–12 weeks + `generateChunk` impurity + test rewrites | **No.** A hedge maze that isn't recognisable as Baltimore. |
| D | Variable heights, skyline, LOD | A new renderer | Not a modification. A different project. |

**A + B ≈ 2 weeks**, versus 3 months for C, which is *worse at the thing it was for*.

---

## 2. LEVEL ∅ — THE INNER BLOCK PARK

One hand-authored location. The shared front door: everyone enters here, the map handles the rest. This solves cold-start (2–5 friends always start together) and it is the **only** place real geography is rendered.

### 2.1 It is a real place, and a document created it

Harlem Park, West Baltimore. Every link verified (§A.3):

| Year | Document / act | Effect |
|---|---|---|
| **1937** | HOLC *Residential Security Map of Baltimore* | Graded **D — "hazardous."** Red. Capital leaves. |
| **1937** | **Formstone patented** in Baltimore (Lasting Products Co.) | Fake stone over real brick. *Trompe-l'œil masonry — the "stones" and "mortar" are the same material.* Sold **"respectability, modernity, and the appearance of upward mobility"** to the neighborhoods the map had just condemned. John Waters: *"the polyester of brick."* |
| **1961** | Harlem Park urban renewal plan | Demolishes hundreds of alley houses — **Woodyear Street, Vincent Street**. Hundreds of residents relocated. |
| 1960s– | 29 **"inner block parks"** created | *"that the remaining residents did not want, that the city had no intention of maintaining and that soon became dumping grounds for trash"* |
| **2004** | **Creative Camouflage Inc.** | Life-sized **photographs of windows and doors** glued to the plywood over vacants, to *"let neighbors feel like they live in a neighborhood that's not as decayed as it is."* $5,000 pilot. |
| **2004-11-08** | Notice `30150A`, 806 N Carey St | Status **`EXTENSION`**. Still. Twenty-one years. |
| **now** | 451 open Vacant Building Notices | **283 status `EXTENSION`.** Only 13 ever reached `COMPLIANCE`. Front doors filled with concrete block. |

**The same year a federal map graded this block hazardous, this city patented the material for covering it up.** That is a coincidence. Use it anyway.

### 2.1a The thesis: the engine's limitation is the subject

The reason literal Baltimore fails (§1.1) is that a raycaster **cannot render depth** — every surface is a flat texture pretending to be a thing.

This block is made of exactly that:

| Surface | What it actually is |
|---|---|
| Formstone | flat stucco pretending to be stone *and* mortar |
| Creative Camouflage | a **photograph of a window**, glued where a window was |
| Painted CMU in a door frame | flat grey pretending to be a door |

**The raycaster fakes surfaces because that is all it can do. The block is fake surfaces because that is what was done to it.** The medium and the subject are the same technique. Level ∅ is not a compromise forced by the renderer — it is the one subject this renderer was accidentally built to tell the truth about.

The epigraph is a real resident, quoted in the *Baltimore Sun*, 2004, about a real photograph glued to a real house:

> **"Even though it's fake, you have to look up on it to see that it's fake."** — Barbara Lloyd

### 2.1b The material set (from Street View reference, 800-block N Carey St)

The palette and props are **observed, not invented**:

| Element | Detail |
|---|---|
| **Sealed doors** | Wooden surround intact — arch, carved keystone, peeling cream paint, green-black algae staining — and the opening behind it **filled with grey CMU**. Not plywood. Masonry. |
| **Plywood** | Weathered grey-brown, visible grain, over some doors/windows. **House number hand-sprayed on it** — `808` dark, `810` orange. |
| **Formstone** | Irregular tan / grey / brown / pink blocks. Kitsch, durable, and a lie. |
| **Open windows** | Upper floors: no glass, no board. **A black hole in the brick.** The most Backrooms thing on the street and it costs one texture. |
| **Marble steps** | Cracked. Classic Baltimore stoop. |
| **Occupied houses interleaved** | Real curtains, real glass, reflecting trees — **directly beside the sealed ones**. This matters: the block is not abandoned, it is *processed*. People live there. |
| **Palette** | brick red-orange · formstone tan/grey · plywood grey-brown · CMU grey · marble white-grey · foliage green · **the black of open windows** |
| **Notice** | A small pale/pink slip on the door. Weathered, curling, unreadable at distance (§9.4). |

**A plan erased a street and replaced it with an enclosed empty space nobody asked for and nobody has maintained since 1961.** It is reachable only through gaps between rowhouses. It has been sitting inside that block for sixty-five years being *not a street, not a yard, not a park*.

That is a liminal space created by paperwork, and it is real. **The player stands in Woodyear Street. Woodyear Street is not there.**

### 2.2 Why this and not the worst block by count

Carrollton Ridge has **758** notices — the highest in the city — and was the obvious pick. **Rejected: its history does not support the lore.** Its HOLC-D grade could not be verified, and its decline is deindustrialisation and white flight (Bethlehem Steel, GM) — a different, also-true story that does not fit a map-as-antagonist frame. Attaching redlining lore to it would be inventing history, which forfeits the only thing that makes this good.

Sandtown-Winchester (594) is verified redlined but carries Freddie Gray's death. **We do not build a monster level on a specific man's death.**

**Harlem Park (451)** is the block where every beat is documented.

**Standing rule:** the horror is that it is true. Any lore beat that cannot be sourced does not ship. We name the *system*, never the residents.

### 2.3 The geometry is the engine's best case

| Property | Consequence |
|---|---|
| Walled on all sides by rowhouse backs | Rays terminate on facades → the **2.35× street-canyon case**, not the 19× plaza case |
| Entered through ~3 m gaps | Textbook raycaster corridors |
| Open to the sky | **2.3× cheaper** than the textured ceiling — this level may run *faster* than the lobby |
| One block interior | Hand-authorable with real care. No GIS pipeline, no new engine, no spatial index |
| Rowhouse ceiling ≈ 2.4 m | The hardcoded 2 m wall height stops being a limitation and becomes **correct** |

Everything that made accurate Baltimore hopeless was about *outdoors at scale*. None of it applies to one enclosed courtyard.

**Same engine.** A hand-authored grid map is what this engine's ancestors did.

### 2.4 The prop — and how you get in

Baltimore City Code **§120.2.1** prescribes the notice: it must advise that the structure is **"condemned as being unsafe or dangerous for occupancy or use"** and that **"the public is warned to keep away."** At least **24 inches wide × 8 inches high**. **Signed by the Building Official.**

The door is **806 N Carey Street** — notice **`30150A`**, issued **2004-11-08**, block 0089 lot 060, status **`EXTENSION`**. Real, still open, twenty-one years later.

**`EXTENSION` is the most Backrooms word in the dataset.** The notice never resolves. It is extended. Indefinitely.

**But you cannot go in the front, and that is not a design decision.** Street View confirms the doors on this block are **filled with concrete block** behind their original frames. A masoned door does not open. **The inner block park behind the row is therefore the only way in** — the space the 1961 plan created and then forgot is the only unsealed thing on the block.

Geometry, lore and gameplay converge without being made to:

> The front was sealed by the city. The back was emptied by the city. You enter through the gap the paperwork left.

**Readability — §9.4 is answered by the photographs.** The statutory placard is small, weathered and curling; at 2 m wall height through a 0.6-scale buffer it will not be legible, and that is **fine, because it is not the readable element**. On this block the number that is actually legible is the **house number, hand-sprayed on the plywood in foot-tall letters** — `808`, `810`. That is what the player reads. That is what they can look up. The statutory notice stays as an unreadable pale slip, exactly as it appears in reality — **an official document nobody can read, on a door nobody can open.** The prop survives; only the assumption about *which* text carries it was wrong.

### 2.5 The join

`FILE ME UNDER BALTIMORE` → the same cabinet that stamped `EXTENSION` on 806 N Carey Street in 2004 and never looked again. **The filing system that condemns the house is the filing system that files the player.** The intake form is not framing — it is the antagonist's stationery.

### 2.6 What Level ∅ costs elsewhere

Not free. Three known breakages:

- **`levelConfig(-1)` silently returns the Electrical Station.** `levels.js:154` wraps via modulo — verified by execution. "Level −1" cannot be expressed. Append as index 4; the *name* stays `∅`.
- **One exit per level is a hard assumption.** `decor.js:29` `exitTarget` is a **scalar**; `decor.js:68` stamps every exit with it; `game.js:571` descends to one target. Level 0 needs **up and down**. Requires `exit` → `exits[]` across all 4 levels, plus `decor.js` (`placeChunk`, `nearestExit`, `nearestExitAny`, `enterLevel`), `game.js` (descend, hint, **compass** — which must now disambiguate ↑ from ↓), and `renderer.js` `drawExit` (up and down must read differently in fog or it is a coin flip).
- **`levels.test.js:24` asserts the ring `0→1→2→3→0` closes.** Level 3's exit targets 0 (`levels.js:137`, "climb out" → the lobby). **Someone wrote a test to keep the loop shut, because the closure is the horror.** An overworld opens it. This is a deliberate trade, not an oversight. Level ∅ is **one-way down** — you fall out of it and cannot climb back — which preserves the closure: the ring stays `0→1→2→3→0`, with ∅ as a one-time entrance outside it.

---

## 3. THE MAP IS THE ANTAGONIST

Option A, reframed by §2. The map is not a menu that saved us renderer work — **it is the thing that did this.** A map graded the block hazardous; a plan erased the street; a notice condemned the house. The player consults the same instrument.

This makes map-as-document **thematically load-bearing** rather than a cost-saving compromise, and it is why A and B are one design rather than two.

---

## 4. THE FACTION FUNCTION

**The game never adjudicates sovereignty. It detects that parties disagree.** A hand-maintained list of disputed places would itself take a side; a derived predicate cannot. Re-derives on every dataset bump — a build-script step, never a list.

### 4.1 The predicate

```
POV      = { s : ADM0_A3_s AND FCLASS_s both exist AND both are type C }   // → 31
SENTINEL = /^(-99|UUU|[BC]\d\d)$/            // NE's "no opinion" / breakaway codes — not claims
claims(row)     = { ADM0_A3_x(row) : x ∈ POV, value ∉ SENTINEL }
contested_A(row) = |distinct claims(row)| > 1                  // who claims it
contested_C(row) = ∃x ∈ POV : FCLASS_x ≠ '' AND FCLASS_x ≠ FCLASS_TLC   // status dissent
```

**31 points of view** exist, not the 9 assumed: `AR BD BR CN DE EG ES FR GB GR ID IL IN IT JP KO MA NL NP PK PL PS PT RU SA SE TR TW UA US VN`.

### 4.2 Verified results

- **Signal A flags 16.** Signal C flags 19. **Union = 23.** Plus the `disputed_areas` layer (99 features, 215,221 B) → **121 contested features**.
- Real factions: China/Taiwan, Israel/Palestine, Kosovo/Serbia, Somaliland, W. Sahara, N. Cyprus, Falklands, Spratlys, Guantánamo, Siachen, Gibraltar, Hong Kong.

### 4.3 The three traps — all found by running it, none by reasoning

1. **The France fear was structurally impossible.** The predicate **never reads `ISO_A2`**, and `ISO_A2`'s `-99` is an unrelated sentinel about ISO code assignment that never propagates into the POV columns. Measured: France has **1** distinct claim. Clean — as are Norway, Denmark, Netherlands, USA, Finland, Australia, Portugal, Chile, NZ.
2. **`ADM0_A3_UN` and `ADM0_A3_WB` are dead columns** — numeric type, `-99` on **all 258 rows**. Including them makes **every** row disagree: a 100% false-positive rate. **Exclude by type check, never by name.**
3. **Barbados is a genuine upstream Natural Earth bug** — `ADM0_A3_AR='URY'`, unfixed as of v5.1.2. A predicate that trusts `ADM0_A3_*` unconditionally ships **"Argentina claims Barbados is Uruguay"** — a *fabricated* political claim, worse than omitting a real one. Must be suppressed.

**And a pure-claim predicate misses Palestine entirely** — `PSX` is claimed by all 31; only signal C catches it. **Both signals are required.**

### 4.4 Reaching 2–5 players in Baltimore

Contested world territories are content for nobody at this scale. **Factions are an identity layer, not a destination:** the derived set supplies the *faction roster* (ground that disagrees with itself), and players pick one. Whether contested sectors are ever *visitable* is subsystem #4's problem, not this spec's.

---

## 5. BALTIMORE GRAIN — 279 NEIGHBOURHOODS

| | |
|---|---|
| Layer | `Neighborhood_NSA` — `geodata.baltimorecity.gov/egis/rest/services/Planning/Neighborhoods/MapServer/0` |
| Count | **279** (verified; not the 278 commonly cited — that is an older layer) |
| Names | **279 unique, 0 null, 0 duplicate.** `Hampden`, `Fells Point`, `Federal Hill`, `Canton`, `Mount Vernon`, `Highlandtown`, `Remington` all confirmed as exact values |
| Size | **108 KB** simplified + gzipped, whole city. PIP verified still correct after simplification |
| License | **Codified city law** — Baltimore City Code Art. 1 Subtitle 9 (Ord. 16-463) §9-8(b): *"no restrictions on copying, publishing, further distributing, modifying, or using the data for any non-commercial or commercial purpose."* Not a TOS — a statute. No attribution, no share-alike. |

**ID: `us-nsa:<minted>`.** The critical finding: **the layer has no ID field.** `OBJECTID` is an Esri rowid reassigned on republish; `GlobalID` regenerates on rebuild; `Name` demonstrably drifts. **We mint and freeze our own ID at first ingest and never key on upstream fields** — which is exactly the parent spec's existing rule (§2.4: the ID is the contract).

**Grain nesting.** `us-fips:24510` (Baltimore City) **continues to exist** and keeps its seed — old saves are untouched. Resolution order inside the city is NSA-first. This is additive: a new namespace, no migration of existing keys.

**Known limitation, recorded:** a player holding `us-fips:24510` and one holding `us-nsa:hampden` are in different worlds and cannot meet by pin. They meet the way the parent spec already specifies — **by sharing the ID token** (§2.4). The rendezvous primitive absorbs the grain fork.

---

## 6. FREE BUGS THIS TURNED UP

- **`config.lights` has never worked.** Declared `world.js:14`, set `lights:false` for levels 2–3 in `levels.js`, and **read nowhere**. `isLightCell` (`renderer.js:26-28`) is defined and never called; the ceiling grid draws unconditionally at `renderer.js:240` via an inlined `(cellX & 1) === 0 && (cellY & 1) === 0`. **Pipe Dreams and Electrical Station have fluorescent ceiling panels right now, despite being configured not to.** Step one of any overworld is "turn off the ceiling" — fix the knob first. Same family as the parent spec's dead `world.json` fetch: a config knob that lies.
- **`levelConfig(-1)` → Electrical Station** (§2.6).
- Parent spec §1 (relay drops the anchor; relay deletes the world) is unchanged and still ships first.

---

## 7. SEQUENCING

| Phase | Contents |
|---|---|
| **0** | Relay fix (parent §1). Unchanged, still first. |
| **1** | Sectors: `sector.js`, gazetteer, ledger, `custom:`, `datasetVersion` in the handshake. |
| **1b** | **Thread `worldSeed` into items/decor.** Mandatory (§0.4). |
| **2** | Polygons: counties + countries + **279 NSAs**. `resolveSectorAt`. |
| **2b** | Fix `config.lights`. Add `exits[]`. (Preconditions for ∅.) |
| **3** | **Level ∅** — the inner block park, hand-authored, one-way down. |
| **4** | The map screen (option A). Then portals, teams, territory. |

---

## 8. WHAT WE ARE NOT BUILDING

| Not building | Why |
|---|---|
| Literal street rasters (option C) | §1. A hedge maze that isn't Baltimore. |
| A new renderer / skyline (option D) | Doubles the project; still over frame budget. |
| More than one hand-authored location | ∅ is the shared front door. The map is everything else. |
| A walkable Carrollton Ridge | §2.2. The lore isn't true there. |
| Visitable contested territories | §4.4. Content for nobody at 5 players. |
| TIGER road data | Not needed once streets aren't rasterized. |
| OSM anything | ODbL share-alike reaches persistent game state. |

---

## 9. STILL OPEN

1. **Which inner block park?** Harlem Park has 29. Needs one chosen on its documentary record (which alley did it eat) and its shape. Woodyear Street and Vincent Street are named in the record — start there.
2. **Does ∅ break the save?** `save.js:12` — `s.v === 1` else `null`. A format bump **silently discards every saved run**. ∅'s level index must ride in the existing `v: 1` shape (the parent spec's rule: `snapshot()` gains keys, `v` stays 1).
3. **How does ∅ interact with multiplayer?** Everyone enters through the same door — do players see each other *in* ∅ before they fall? Probably yes, and it's the best cold-start moment the game will ever have. Not designed yet.
4. ~~**Is the plywood readable?**~~ **Answered** by Street View reference (§2.4): the legible element is the foot-tall hand-sprayed house number, not the statutory placard. The placard stays deliberately unreadable — which is truer than the original plan.
5. **The camouflage beat — where does it land?** Creative Camouflage (§2.1) is the strongest single image available: a *photograph of a window*, peeling off a board, with nothing behind it. The obvious staging is that the player passes several and only notices at the third. **Unstaged.** Note it is also the level's only "monster" — a horror that is a municipal contractor.
6. **Occupied houses are non-negotiable.** The reference shows lived-in homes **directly beside** the sealed ones — real curtains, real glass. The block is not abandoned, it is *processed*. Rendering an empty street would be both a lie and the poverty-tourism failure this design exists to avoid. **Some windows have lights on. Nobody comes out.**

---

## APPENDIX A — verified facts and sources

### A.1 Renderer (read at commit `5d8929a`)
`renderer.js:263` (wall height), `raycaster.js:23-28` (first-hit), `renderer.js:256` (192 m clamp), `renderer.js:240` + `:26-28` (dead `isLightCell`), `world.js:14` + `levels.js` (dead `config.lights`), `levels.js:154` (modulo wrap, verified by execution), `decor.js:29,:68` (scalar exit), `levels.test.js:24` (closed ring). Codebase 3,173 lines.

### A.2 Live data (queried 2026-07-16)
- `Housing/VBN_Service/MapServer/0` — **11,614** open vacant building notices citywide. Fields: `NoticeNum, DateNotice, NoticeType, Status, Neighborhood, Address, Block, Lot`.
- By neighbourhood: Carrollton Ridge **758**, Broadway East 720, Sandtown-Winchester 594, **Harlem Park 451**, Midtown-Edmondson 334.
- Harlem Park status: **283 EXTENSION**, 134 NOTICE MAILED, 14 APPROVED, **13 COMPLIANCE**, 5 LEGAL REJECT, 2 FOLLOW UP ON LITIGATION.
- Oldest open Harlem Park notices: `30150A` 806 N Carey St (2004-11-08), `33976A` 728 N Gilmor St (2004-12-02), `34319A` 818 N Carrollton Ave (2004-12-03) — **all EXTENSION**.
- `Planning/Neighborhoods/MapServer/0` — 279 NSA features.

### A.3 Documents
- **Baltimore City Code §120.2.1** — condemnation notice: *"condemned as being unsafe or dangerous for occupancy or use"*, *"the public is warned to keep away"*, ≥24″×8″, signed by the Building Official. https://codes.baltimorecity.gov/us/md/cities/baltimore/code/building-codes/II/120
- **Baltimore Heritage — Harlem Park**: the 1961 plan, the demolition of Woodyear and Vincent Streets, the 29 inner block parks *"that the remaining residents did not want, that the city had no intention of maintaining and that soon became dumping grounds for trash."* https://baltimoreheritage.org/programs/harlem-park/ · https://explore.baltimoreheritage.org/items/show/9
- **HOLC 1937 Residential Security Map of Baltimore** — grade D = "hazardous"; West Baltimore redlined; grading criteria explicitly included *"percentage of 'negro families'"*. https://www.library.jhu.edu/news/2017/09/the-baltimore-redlining-map-ranking-neighborhoods/
- **Harlem Park abandonment**: more than half the properties on Harlem Park study blocks abandoned; ~a quarter of buildings vacant.
- **Formstone** — patented 1937, Lewis Albert Knight, Lasting Products Co., Baltimore. *"Stucco colored and shaped to imitate masonry… trompe-l'œil… the 'stones' and 'mortar' being of the same material."* Baltimore became "the Formstone capital of the world." John Waters, *"the polyester of brick"* (and a 1997 documentary, *Little Castles: A Formstone Phenomenon*). https://en.wikipedia.org/wiki/Formstone
- **Creative Camouflage Inc.** — *Baltimore Sun*, "Illusions of occupancy," 2004-06-12. Life-sized **photographs of windows and doors** glued to plywood on vacants; founder Charles W. "Bill" Coleman; ~$5,000 for the Aisquith Street pilot; purpose *"let neighbors feel like they live in a neighborhood that's not as decayed as it is."* Resident Barbara Lloyd: **"Even though it's fake, you have to look up on it to see that it's fake."** Housing Commissioner Paul Graziano: *"worth a closer look."* ACORN's Jacquiline Johnson: *"insulting to the residents of Baltimore."* Criminologist George Kelling: *"a pretty transparent fake."* https://www.baltimoresun.com/2004/06/12/illusions-of-occupancy/
- **Street View reference** (user-supplied, 800-block N Carey St, §2.1b): doors sealed with CMU behind intact wooden surrounds; house numbers hand-sprayed on plywood; formstone; open unboarded upper windows; occupied houses interleaved with sealed ones.
- **Cinder-block sealing is standard practice**: *"Cinderblocks wall off the door and windows of burned and abandoned rowhouses."* Baltimore is now piloting clear polycarbonate panels on ~300 of ~12,000 vacants. https://www.thebanner.com/community/housing/baltimore-clear-boarding-pilot-RSSS6NTD5FCGDD6ZJRRYRCGPHQ/
- **Baltimore City Code Art. 1 Subtitle 9 (Ord. 16-463)** — the open data statute.
- **Natural Earth terms**: *"No permission is needed to use Natural Earth. Crediting the authors is unnecessary."*

### A.4 Not verified — do not treat as fact
- Carrollton Ridge's HOLC grade (searched; not found). Its exclusion (§2.2) rests on this gap, which is the correct reason to exclude it.
- Which specific inner block park ate which alley (§9.1).
- Whether the §120 placard's *physical* wording matches the statute's *required content* — the statute prescribes what the notice must convey, not a verbatim string. If a photograph of a real placard surfaces, prefer it.
