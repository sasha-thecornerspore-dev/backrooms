# Pacing results: Tier 1 (2.0.4, "the maze has a pulse")

**Draft.** It measures the 2.0.4 tree as built, before the review fixes. A later step adds a column for the fixed tree.

Two tools, both run the same way on each tree:
- **The pacing walker** (`walks.mjs`, `analyze.mjs`). It walks 60 worlds per floor (seed null plus 1–59), 300 s each, as an explore walker and as a seek walker (a compass follower), with the light off 14% of the time.
- **The playtest bot** (`bot/`). It plays 3-minute sessions on the real renderer: the fresh lobby, L1, L2, L3, and a fresh run that takes ways, plus six more seeds of that run.

The 2.0.3 column comes from the same tools on 2.0.3 (`20f4650`). It differs from the plan's "today" column only where the new light-off share changes it (see *Notes*).

## Tier 1 acceptance

| metric | 2.0.3 measured | Tier 1 target | 2.0.4 (as built) measured |
|---|---|---|---|
| seek-walk (compass follower) time on a floor, p50 (walker, L0 · L1 · L2 · L3) | 13 · 11 · 13 · 18 s | 45–90 s | 86 · 95 · 104 · 108 s |
| fresh run: time in the lobby, for a bot that follows the thread (p50, min–max of n runs) | 23 s (21–80; n 7) | 90–150 s | 72 s (47–180, one never left in 180; n 7) |
| plates in the first 45 s of an arrival, any floor (bot, most in one arrival: arrival + unprompted / every plate) | 5 / 14 | ≤ 2 | 2 / 8 |
| plate on screen (bot, range over sessions) | 34%–77% | ≤ 40% | 26%–55% |
| `you rummage.` plates / flashlight plates per run / smiler teaching lines per run (bot; smiler: walker, most in one walk) | 83 / 4 / 3 | 0 / ≤ 2 / ≤ 1 | 0 / 1 / 1 |
| compass followers sent to a stair up first (walker, L1 · L2 · L3, of n worlds) | 24 · 30 · 21 of 60 | 0 | 0 · 0 · 0 of 60 |
| repeated lines within 5 min (walker, explore, L0 · L1 · L2 · L3; in brackets without the flashlight's lines) | 48% · 45% · 43% · 44% (20% · 18% · 18% · 23%) | ≤ 10% | 1% · 1% · 4% · 6% (2% · 2% · 5% · 8%) |
| drawer item / empty share (sweep of the tree's table, L1–3; bot rolls, n) | sweep 6.2–6.3% / 52.2–53.2%; bot 2.3% / 31.5% (n 89) | 8–10% / ≤ 35% | sweep 8.9–9.1% / 33.3–34.0%; bot 4.3% / 29.0% (n 93) |
| L1–L2 sightings preceded by a tell or the heartbeat 5–25 s earlier (walker, both walkers) | — | ≥ 80% | 76% (93/122); 85% (93/109) leaving out a visit's first 5 s |
| heartbeats with no creature within 24 path cells (walker, dread's own beats, L1 · L2 · L3; of all dread beats) | — | 0 | 0 · 8 · 10 (of 709) |
| quiet stretches ≥ 45 s (no happening, no unprompted text) per 5 min (walker, explore, L0 · L1 · L2 · L3) | 2.78 · 2.45 · 2.25 · 1.78 | ≥ 1 | 2.62 · 2.25 · 2.35 · 1.73 |
| gap between happenings, p90 (walker, explore, L0 · L1 · L2 · L3; no Tier 1 target) | 107 · 95 · 85 · 70 s | — | 113 · 89 · 83 · 65 s |
| frame-perf, 600 frames (`test/frame-perf.test.js`, not these tools) | passes | < 150 ms, identities held, path field zero-allocation | passes |
| light-off share (walker setting, measured) | 14% | — | 14% |

**2.0.4 as built meets 6 of the 11 measures that have a target and misses 5.**

### What it misses, and the suspect for each
1. **Seek-walk p50 is 95–108 s on L1–L3** (L0 is 86 s, inside the target).
   - About a third of seekers find a way by wandering before the pull shows. The other two thirds wait out the full `PULL_WAIT_S = 90` (`compass.js`), then walk 22–31 s more.
   - Few seekers get a hint early: 7–16 of 60 per floor read a page or speak to a soul on the way.
   - Knobs: `PULL_WAIT_S` (about 60–70 s would put the p50 inside 45–90), or more early hints. The drawers' floor plans are not modelled in the walker.
2. **The fresh run leaves the lobby too early when the bot follows the thread** (target 90–150 s).
   - In 5 of 7 runs the bot reads the note and hears the soul at 29–44 s, then follows the pull straight to the room's way. It leaves at 47–86 s.
   - In the other 2 runs it misses the soul. The pull then waits for 120 s, and the bot leaves at 156 s or not at all.
   - Suspect: the authored distances in `firstrun.js` (`FIRST_NOTE`, `FIRST_SOUL`, `FIRST_ROOM`). Once the thread reaches step 2, the pull points at the room's way (`toward()`) and is shown at once (`compass.js` `pullVisible`, fresh branch: `step >= 2`).
   - Knob: a floor-time floor on the fresh branch (step 2 and some floor time), or a longer route.
3. **Plates are on screen 26–55% of the time** (target ≤ 40%).
   - Arrival and unprompted plates take 3–21% of the time. The bot's own plates take 17–49%: drawer results, the soul's word, bumps and the light. L2 is the worst at 52%, with 14 drawers searched in 3 minutes.
   - Removing `you rummage.` was the lever T1-4 pulled. What is left is the dwell of player-caused plates (`messages.js` dwell) and how many of them there are.
   - The bot searches drawers more eagerly than a person may. Read this miss together with playtest #1.
4. **76% of L1–L2 sightings are preceded by a tell or the heartbeat** (target ≥ 80%; 95% interval 68–83%).
   - Of the 29 sightings with no cue, 13 come in the first 5 s of a visit, where nothing can come 5 s earlier: the creature is in view on arrival. Leaving those out gives 85%.
   - Most of the rest have a cue less than 5 s before them.
   - Knobs: `dread.js` `TELL_BASE` / `TELL_K` (how often a tell plays) and `TELL_NEAR`. Or decide that arrival sightings are out of scope.
5. **18 of 709 dread beats sound with no creature within 24 path cells** (0 on L1, 8 on L2, 10 on L3; target 0).
   - 17 come in `level`'s slow fall (`DECAY` 0.12/s) after dread has already gone. Some are the beat or two after the creature moves out of reach.
   - The longer ones follow a hunt. Dread lifts `level` toward `DREAD_CAP` before the hunt, and `level` keeps that head start through the hunt and its fall, while `huntLevel` falls from lower. So for up to about 7 s after the creature is gone, `level` is above the beat floor and `huntLevel` is not.
   - One beat is a disagreement between the path field and the walker's own BFS (the field reads 4 cells, the BFS 46).
   - Suspect: `tension.js`, where one `level` chases max(hunt, dread). Knob: let the dread term decay on its own, and beat on max(`huntLevel`, dread level).
   - The 2.0.3 column has `—`: its heartbeats are all the hunt's own.

The pull never names a stair up: 0 of 180 seekers were sent to one, against 75 of 180 on 2.0.3. Walking onto a stair up while wandering is not counted; that happened to 49 seekers.

## Notes
- **Port check.** `walks.mjs --legacy --seeds 20` on 2.0.3 reproduces the catch-up walker draw for draw: identical events. It gives the plan's numbers:
  - seek p50 12 / 13.1 / 17.3 / 17.6 s;
  - stairs up first 0 / 10 / 11 / 5 of 20;
  - repeats 17 / 19 / 21 / 27%;
  - happening gaps p50 / p90 81 / 107 s on L0.
- **The light-off share is new.** It is 15% asked and 14% measured, in 6–14 s stretches. On 2.0.3 every toggle says its line, so repeats rise from 17–27% to 43–48%. The bracketed figures leave the flashlight's lines out (18–23%).
- **Sample sizes.**
  - Walker: 60 worlds × 4 floors × 2 walkers. Split-half seek p50s agree within 2–19 s on 2.0.4 (L1 97 / 95, L2 102 / 104, L3 104 / 111) and within 3 s on 2.0.3.
  - Bot: one 3-minute session per floor, and 7 fresh runs. Its drawer counts (89 and 93 rolls) cannot settle 8–10%: 4/93 has a 95% interval of 2–11%. The sweep, over 20,000 keys per floor and the containers actually placed, is the measure.
  - The bot met almost no creatures (0–2 sightings per tree). Sightings and heartbeats are the walker's.
- **How the bot's plates are classed.** The same rules apply on both trees.
  - **Player-caused:** a line said within 2.5 s after a key the bot pressed to act (E, F, Q, L, Space, C, Tab), plus bump lines and landmark lines.
  - **Arrival:** a line said within 12 s of a travel or a death, with no key pressed since.
  - **Warning:** the hunt's lines.
  - **Arrival + unprompted:** everything else. This is the column T1-4 budgets.
  - The tree's own murmurs, and lines fired by an event or a haunt, are always unprompted, unless a drawer rolled them.
  - Each arrival window ends at the next arrival.
  - On 2.0.4, the instrumented copy also logs every `plate()` decision, so this can be cross-checked.
- **What the walker does not model.** Searches and their floor plans; game.js's delayed `later()` arrival lines; the dimmer view with the light off. Its "lines in the first 45 s" are therefore approximate. The bot's count is the measure.
- **Only scratch copies are instrumented.** The bot only ever patches a copy outside the tree. None of the 22 sessions logged a page error or a blocked network request. The block is installed when the bot takes over, so the boot before that is not covered.

## How to run
Run everything from PowerShell after `Set-Location` into the measuring worktree, so the working directory is short; Electron and node fail to start from a long one. Never use npx. `<tree>` is the worktree you are measuring; `<out>` is a short scratch folder.
```
node tools/pacing/walks.mjs --src <tree>/src/renderer --out <out>/w.json --seeds 60            # ~2 min; --legacy --seeds 20 = the 2.0.3-era walker
node tools/pacing/analyze.mjs --walks <out>/w.json --out <out>/s                               # <out>/s.json + s.md (Tier 1 measures, drawer sweep, old tables)
node tools/pacing/bot/run.mjs --tree <tree> --out <out>/bot                                    # 5 sessions x 180 s game time, in parallel (~4 min)
node tools/pacing/bot/run.mjs --tree <tree> --out <out>/bot --sessions fresh-takes-way --seeds 601,602,603,604,605,606
node tools/pacing/bot/stats.mjs --dir <out>/bot                                                # digest.txt per session, stats.txt, metrics.json
node tools/pacing/table.mjs --col "2.0.3 measured|<a>/s.json|<a>/bot/metrics.json|passes" --col "2.0.4 (as built) measured|<b>/s.json|<b>/bot/metrics.json|passes" --out <out>/table.md
node node_modules/vitest/vitest.mjs run test/frame-perf.test.js                                # the frame-perf row
```
- `run.mjs` patches `<out>/bot/src`, a copy, and drives `tools/gfx/page.cjs --drive tools/pacing/bot/session.cjs` with this worktree's Electron.
- `ascii.mjs` and `creature-diag.mjs` take `--src` as well.
- `test/pacing-tools.test.js` guards the library and the patch anchors.
