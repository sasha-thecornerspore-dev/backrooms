# Pacing results: Tier 1 (2.0.4, "the maze has a pulse")

The same tools measure three trees: 2.0.3 (`20f4650`), 2.0.4 as built (`5bfb1ae`, before the review fixes), and 2.0.4 after the four review batches (`b07d456`, the column **2.0.4 measured**).

Two tools, both run the same way on each tree:
- **The pacing walker** (`walks.mjs`, `analyze.mjs`). It walks 60 worlds per floor (seed null plus 1–59), 300 s each, as an explore walker and as a seek walker (a compass follower), with the light off 14% of the time.
- **The playtest bot** (`bot/`). It plays 3-minute sessions on the real renderer: the fresh lobby, L1, L2, L3, and a fresh run that takes ways, plus six more seeds of that run.

The 2.0.3 column comes from the same tools on 2.0.3. It differs from the plan's "today" column only where the new light-off share changes it (see *Notes*).

## Tier 1 acceptance

| metric | 2.0.3 measured | Tier 1 target | 2.0.4 (as built) measured | 2.0.4 measured |
|---|---|---|---|---|
| seek-walk (compass follower) time on a floor, p50 (walker, L0 · L1 · L2 · L3) | 13 · 11 · 13 · 18 s | 45–90 s | 86 · 95 · 104 · 108 s | 86 · 95 · 104 · 107 s |
| fresh run: time in the lobby, for a bot that follows the thread (p50, min–max of n runs) | 23 s (21–80; n 7) | 90–150 s | 72 s (47–180, one never left in 180; n 7) | 84 s (54–156; n 7) |
| plates in the first 45 s of an arrival, any floor (bot, most in one arrival: arrival + unprompted / every plate) | 5 / 14 | ≤ 2 | 2 / 8 | 2 / 8 |
| plate on screen (bot, range over sessions) | 34%–77% | ≤ 40% | 26%–55% | 30%–57% |
| `you rummage.` plates / flashlight plates per run / smiler teaching lines per run (bot; smiler: walker, most in one walk) | 83 / 4 / 3 | 0 / ≤ 2 / ≤ 1 | 0 / 1 / 1 | 0 / 1 / 1 |
| compass followers sent to a stair up first (walker, L1 · L2 · L3, of n worlds) | 24 · 30 · 21 of 60 | 0 | 0 · 0 · 0 of 60 | 0 · 0 · 0 of 60 |
| repeated lines within 5 min (walker, explore, L0 · L1 · L2 · L3; in brackets without the flashlight's lines) | 48% · 45% · 43% · 44% (20% · 18% · 18% · 23%) | ≤ 10% | 1% · 1% · 4% · 6% (2% · 2% · 5% · 8%) | 1% · 1% · 4% · 6% (2% · 1% · 6% · 8%) |
| drawer item / empty share (sweep of the tree's table, L1–3; bot rolls, n) | sweep 6.2–6.3% / 52.2–53.2%; bot 2.3% / 31.5% (n 89) | 8–10% / ≤ 35% | sweep 8.9–9.1% / 33.3–34.0%; bot 4.3% / 29.0% (n 93) | sweep 8.9–9.1% / 33.3–34.0%; bot 4.2% / 28.1% (n 96) |
| L1–L2 sightings preceded by a tell or the heartbeat 5–25 s earlier (walker, both walkers) | — | ≥ 80% | 76% (93/122); 85% (93/109) leaving out a visit's first 5 s | 76% (89/117); 86% (89/104) leaving out a visit's first 5 s |
| heartbeats with no creature within 24 path cells (walker, dread's own beats, L1 · L2 · L3; of all dread beats) | — | 0 | 0 · 8 · 10 (of 709) | 0 · 1 · 10 (of 626) |
| quiet stretches ≥ 45 s (no happening, no unprompted text) per 5 min (walker, explore, L0 · L1 · L2 · L3) | 2.78 · 2.45 · 2.25 · 1.78 | ≥ 1 | 2.62 · 2.25 · 2.35 · 1.73 | 2.3 · 2.53 · 2.22 · 1.58 |
| gap between happenings, p90 (walker, explore, L0 · L1 · L2 · L3; no Tier 1 target) | 107 · 95 · 85 · 70 s | — | 113 · 89 · 83 · 65 s | 113 · 94 · 80 · 62 s |
| frame-perf, 600 frames (`test/frame-perf.test.js`, not these tools) | passes | < 150 ms, identities held, path field zero-allocation | passes | passes |
| light-off share (walker setting, measured) | 14% | — | 14% | 14% |

**2.0.4 meets 6 of the 11 measures that have a target and misses 5.** These are the same five that the tree as built missed. The review fixes changed none of the five knobs below. Every other change from the as-built column is within noise or is explained under *Noise*.

### What it misses, and the suspect for each
1. **Seek-walk p50 is 95 · 104 · 107 s on L1–L3.** L0 is 86 s, inside the target.
   - 17–22 of 60 seekers per floor find a way by wandering before the pull shows. 8–16 get a hint early from a page or a soul.
   - 26–38 per floor wait the full `PULL_WAIT_S = 90` (`compass.js`), then walk a median 20–29 s on the pull.
   - Knob: `PULL_WAIT_S`. About 60–70 s would put the p50 inside 45–90. More early hints would also work.
   - The walker does not search, so a floor plan's hint is not modelled. A player who searches gets the pull sooner.
2. **The fresh run leaves the lobby at 84 s p50** (54–156 s, n 7; the target is 90–150 s).
   - 3 of 7 runs read the note at 15–18 s and hear the soul at 31–33 s. They follow the pull to the room's way and leave at 54–69 s.
   - The other 4 never meet the soul. Two wander onto a way (84 s, 93 s). One leaves after a floor plan and a way it saw (145 s). One leaves after the 120 s unlock (156 s).
   - Suspect (unchanged): at step 2 the fresh branch of `compass.js` `pullVisible` shows the pull at once, and `toward()` points it at the room's way.
   - Knob: give that branch a floor-time floor as well (step 2 and about 70–80 s of lobby time), or lengthen the authored walk from `FIRST_SOUL` to `FIRST_ROOM` (`firstrun.js`). The review left this number to the measure step and the owner (C11).
3. **Plates are on screen 30–57% of the time** (target ≤ 40%). 8 of the 11 sessions are above 40%.
   - Arrival and unprompted plates take 8–18% of the time, and warnings take 0–4%.
   - The bot's own plates take 17–48%: drawer results (it searched 4–16 drawers in each 3 minutes), the soul's word, bumps and the light. `a floor plan with one room shaded in. you mark it on yours.` alone showed 22 times.
   - Knob: the hold of player-caused plates (`messages.js`, `holdS` 4.2 s) or how many of them there are. The bot searches more eagerly than a person may, so read this miss together with playtest #1.
4. **76% of L1–L2 sightings are preceded by a tell or the heartbeat** (89/117; target ≥ 80%; 95% interval 68–83%).
   - 13 of the 28 sightings with no cue come in the first 5 s of a visit, when the creature is already in view on arrival. Leaving those out gives 86%.
   - Knobs (unchanged): `dread.js` `TELL_BASE`, `TELL_K` and `TELL_NEAR`. Or decide that sightings on arrival are out of scope; the measure is then met.
5. **11 of 626 dread beats sound with no creature within 24 path cells** (0 on L1, 1 on L2, 10 on L3; target 0). The tree as built had 18 of 709.
   - All 11 come in `level`'s slow fall (`DECAY` 0.12/s) after dread has gone. None is now a disagreement between the path field and the walker's BFS.
   - The review (W3) moved the hunt mood's exit onto `huntLevel`. The heartbeat still reads `level` (`tension.js`: `heartbeatPeriod(level)`), and `level` keeps the dread term and falls slowly.
   - Knob: in `tension.js`, beat on max(`huntLevel`, a dread term with its own fast decay), so a dread beat stops within a beat or two of dread going.
   - The 2.0.3 column has `—`: its heartbeats are all the hunt's own.

The pull never names a stair up: 0 of 180 seekers were sent to one, against 75 of 180 on 2.0.3. Walking onto a stair up while wandering is not counted; that happened to 49 seekers.

## Notes

### Noise
- **The walker is deterministic for each seed.** Its noise is which 60 worlds it walks.
  - Split-half seek p50s (seeds null–29 / 30–59) on 2.0.4: L0 98 / 79, L1 97 / 95, L2 102 / 104, L3 104 / 108 s.
  - On L0–L2, 2.0.4 and the tree as built give the same seek p50 to the tenth of a second. L3 differs by 1.6 s. The fixes do not touch the seek walk.
- **The world seed fix (review D3) gives the L1–L3 creatures new places for every world seed except 0.** So the walker meets other creatures than on the tree as built: 34 L1 sightings (73 before) and 83 L2 sightings (49 before).
  - The cued share holds at 76%. The dread-beat and quiet-stretch rows shift with these creatures. The sample is new; the measure is the same.
- **The bot is not deterministic.** The same session on the same seed differs from run to run.
  - A first run of the five sessions on this tree, the same game but without the plate log, gave plates on screen 28–68% (this run: 30–57%).
  - In that run, the fresh run of seed 505 left the lobby at 48 s; in this run it left at 156 s.
  - With 7 fresh runs, the 2nd to 6th run (68–145 s) is the median's 87% interval.
- **The bot's drawer rolls are not independent.** The seven fresh runs walk the same fixed lobby and open the same boxes. Three of them rolled the same floor plan at 30–32 s, and floor plans were 22 of 96 rolls against the table's 10%. The sweep is the measure.
- **The bot met few creatures** (0–2 sightings per session). Sightings and heartbeats are the walker's.

### What playtest #1 must still judge
- **The seek walk.** Is 86–107 s to a way on, with the pull after 90 s, lost or stuck? The seek walker is a stand-in: it neither searches nor reads a room the way a person does.
- **The fresh lobby.** Is a player who reads the note and speaks to the soul let go too soon (54–69 s here)? Does one who misses the soul wait too long (up to the 120 s unlock)?
- **The plates.** Do drawer results on screen (17–48% of the time for this bot) feel like noise or like play? A person probably searches less.
- **Dread.** Do the tells before a sighting and the slow heartbeat read as warnings? Does anyone notice a beat or two after the creature has gone?
- **The quiet.** Every floor has at least 1.58 quiet stretches per 5 minutes. Is that dread or boredom? A clear "bored in the maze" on L1–L2 is the go for Tier 2a.

### How the tools follow the review
- **The walker follows two of the review's game.js changes.** The tree's game.js is sniffed for both (`lib.mjs` `WIRING`: `lostWait`, `ambientIdle`), so the 2.0.3 and as-built columns are unchanged.
  - The setting's line waits `LOST_AFTER_S` (60 s) and is never said after a lead (W2). On L0 it now shows at 60–76 s in 40 of 60 walks; before, it showed at 1.6 s in all 60. L0's quiet stretches fall from 2.62 to 2.30 because the line now breaks a long quiet instead of riding the arrival.
  - An ambient line that the queue would drop is no plate and no count (W4).
- **The bot's plate hook matches the reviewed `plate()`.** The kind and text check moved up a few lines there. `test/pacing-tools.test.js` now fails if the plate or tell anchor slips on a tree that has them.

### Method
- **Port check.** `walks.mjs --legacy --seeds 20` on 2.0.3 reproduces the catch-up walker draw for draw: identical events. It gives the plan's numbers:
  - seek p50 12 / 13.1 / 17.3 / 17.6 s;
  - stairs up first 0 / 10 / 11 / 5 of 20;
  - repeats 17 / 19 / 21 / 27%;
  - happening gaps p50 / p90 81 / 107 s on L0.
- **The light-off share is new.** It is 15% asked and 14% measured, in 6–14 s stretches. On 2.0.3 every toggle says its line, so repeats rise from 17–27% to 43–48%. The bracketed figures leave the flashlight's lines out (18–23%).
- **Sample sizes.**
  - Walker: 60 worlds × 4 floors × 2 walkers.
  - Bot: one 3-minute session per floor, and 7 fresh runs. Its drawer counts (89–96 rolls) cannot settle 8–10%: 4/96 has a 95% interval of 2–10%. The sweep, over 20,000 keys per floor and the containers actually placed, is the measure.
- **How the bot's plates are classed.** The same rules apply on every tree.
  - **Player-caused:** a line said within 2.5 s after a key the bot pressed to act (E, F, Q, L, Space, C, Tab), plus bump lines and landmark lines.
  - **Arrival:** a line said within 12 s of a travel or a death, with no key pressed since.
  - **Warning:** the hunt's lines.
  - **Arrival + unprompted:** everything else. This is the column T1-4 budgets.
  - The tree's own murmurs, and lines fired by an event or a haunt, are always unprompted, unless a drawer rolled them.
  - Each arrival window ends at the next arrival.
  - On 2.0.4, the instrumented copy also logs every `plate()` decision, so this can be cross-checked.
- **What the walker does not model.** Searches and their floor plans; game.js's delayed `later()` arrival lines; the dimmer view with the light off. Its "lines in the first 45 s" are therefore approximate. The bot's count is the measure.
- **Only scratch copies are instrumented.** The bot only ever patches a copy outside the tree. None of the 38 sessions (11 on 2.0.3, 11 on the tree as built, 16 on 2.0.4) logged a page error or a blocked network request. The block is installed when the bot takes over, so the boot before that is not covered.

## How to run
Run everything from PowerShell after `Set-Location` into the measuring worktree, so the working directory is short; Electron and node fail to start from a long one. Never use npx. `<tree>` is the worktree you are measuring; `<out>` is a short scratch folder.
```
node tools/pacing/walks.mjs --src <tree>/src/renderer --out <out>/w.json --seeds 60            # ~2 min; --legacy --seeds 20 = the 2.0.3-era walker
node tools/pacing/analyze.mjs --walks <out>/w.json --out <out>/s                               # <out>/s.json + s.md (Tier 1 measures, drawer sweep, old tables)
node tools/pacing/bot/run.mjs --tree <tree> --out <out>/bot                                    # 5 sessions x 180 s game time, in parallel (~4 min)
node tools/pacing/bot/run.mjs --tree <tree> --out <out>/bot --sessions fresh-takes-way --seeds 601,602,603,604,605,606
node tools/pacing/bot/stats.mjs --dir <out>/bot                                                # digest.txt per session, stats.txt, metrics.json
node tools/pacing/table.mjs --col "2.0.3 measured|<a>/s.json|<a>/bot/metrics.json|passes" --col "2.0.4 (as built) measured|<b>/s.json|<b>/bot/metrics.json|passes" --col "2.0.4 measured|<c>/s.json|<c>/bot/metrics.json|passes" --out <out>/table.md
node node_modules/vitest/vitest.mjs run test/frame-perf.test.js                                # the frame-perf row
```
- `run.mjs` patches `<out>/bot/src`, a copy, and drives `tools/gfx/page.cjs --drive tools/pacing/bot/session.cjs` with this worktree's Electron. Its log line lists the game hooks it applied; on 2.0.4 that includes `plate` and `tell`.
- `ascii.mjs` and `creature-diag.mjs` take `--src` as well.
- `test/pacing-tools.test.js` guards the library and the patch anchors.
