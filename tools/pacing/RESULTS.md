# Pacing results: Tier 1 (2.0.4, "the maze has a pulse")

The same tools measure three trees: 2.0.3 (`20f4650`), 2.0.4 as built (`5bfb1ae`, before the review fixes), and 2.0.4 after the four review batches and tune round 1 (`5da959a`, the column **2.0.4 measured**). Tune round 1 changed four constants: `compass.js` `PULL_WAIT_S` 90 → 60 and `LOST_AFTER_S` 60 → 50, and `dread.js` `TELL_BASE` 0.12 → 0.25 and `TELL_K` 0.4 → 0.8.

Two tools, both run the same way on each tree:
- **The pacing walker** (`walks.mjs`, `analyze.mjs`). It walks 60 worlds per floor (seed null plus 1–59), 300 s each, as an explore walker and as a seek walker (a compass follower), with the light off 14% of the time.
- **The playtest bot** (`bot/`). It plays 3-minute sessions on the real renderer: the fresh lobby, L1, L2, L3, and a fresh run that takes ways, plus six more seeds of that run.

The 2.0.3 column comes from the same tools on 2.0.3. It differs from the plan's "today" column only where the new light-off share changes it (see *Method*).

## Tier 1 acceptance

| metric | 2.0.3 measured | Tier 1 target | 2.0.4 (as built) measured | 2.0.4 measured |
|---|---|---|---|---|
| seek-walk (compass follower) time on a floor, p50 (walker, L0 · L1 · L2 · L3) | 13 · 11 · 13 · 18 s | 45–90 s | 86 · 95 · 104 · 108 s | 71 · 74 · 79 · 79 s |
| fresh run: time in the lobby, for a bot that follows the thread (p50, min–max of n runs) | 23 s (21–80; n 7) | 90–150 s | 72 s (47–180, one never left in 180; n 7) | 55 s (48–81; n 7) |
| plates in the first 45 s of an arrival, any floor (bot, most in one arrival: arrival + unprompted / every plate) | 5 / 14 | ≤ 2 | 2 / 8 | 3 / 9 (the game's `plate()` admitted 2; see miss 2) |
| plate on screen (bot, range over sessions) | 34%–77% | ≤ 40% | 26%–55% | 35%–56% |
| `you rummage.` plates / flashlight plates per run / smiler teaching lines per run (bot; smiler: walker, most in one walk) | 83 / 4 / 3 | 0 / ≤ 2 / ≤ 1 | 0 / 1 / 1 | 0 / 1 / 1 |
| compass followers sent to a stair up first (walker, L1 · L2 · L3, of n worlds) | 24 · 30 · 21 of 60 | 0 | 0 · 0 · 0 of 60 | 0 · 0 · 0 of 60 |
| repeated lines within 5 min (walker, explore, L0 · L1 · L2 · L3; in brackets without the flashlight's lines) | 48% · 45% · 43% · 44% (20% · 18% · 18% · 23%) | ≤ 10% | 1% · 1% · 4% · 6% (2% · 2% · 5% · 8%) | 1% · 1% · 4% · 6% (1% · 1% · 6% · 8%) |
| drawer item / empty share (sweep of the tree's table, L1–3; bot rolls, n) | sweep 6.2–6.3% / 52.2–53.2%; bot 2.3% / 31.5% (n 89) | 8–10% / ≤ 35% | sweep 8.9–9.1% / 33.3–34.0%; bot 4.3% / 29.0% (n 93) | sweep 8.9–9.1% / 33.3–34.0%; bot 7.8% / 24.3% (n 103) |
| L1–L2 sightings preceded by a tell or the heartbeat 5–25 s earlier (walker, both walkers) | — | ≥ 80% | 76% (93/122); 85% (93/109) leaving out a visit's first 5 s | 82% (96/117); 92% (96/104) leaving out a visit's first 5 s |
| heartbeats with no creature within 24 path cells (walker, dread's own beats, L1 · L2 · L3; of all dread beats) | — | 0 | 0 · 8 · 10 (of 709) | 0 · 1 · 8 (of 585) |
| quiet stretches ≥ 45 s (no happening, no unprompted text) per 5 min (walker, explore, L0 · L1 · L2 · L3) | 2.78 · 2.45 · 2.25 · 1.78 | ≥ 1 | 2.62 · 2.25 · 2.35 · 1.73 | 2.38 · 2.53 · 2.22 · 1.58 |
| gap between happenings, p90 (walker, explore, L0 · L1 · L2 · L3; no Tier 1 target) | 107 · 95 · 85 · 70 s | — | 113 · 89 · 83 · 65 s | 113 · 94 · 80 · 62 s |
| frame-perf, 600 frames (`test/frame-perf.test.js`, not these tools) | passes | < 150 ms, identities held, path field zero-allocation | passes | passes |
| light-off share (walker setting, measured) | 14% | — | 14% | 14% |

**2.0.4 meets 7 of the 11 measures that have a target and misses 4.**
- Tune round 1 moved two measures into range: the seek walk and the cued sightings.
- The fresh lobby, plate on screen and dread beats far from a creature still miss, as before tuning.
- The plate budget misses by the tool's count in 1 arrival of 25, on a line nobody can see (miss 2). The game's own `plate()` admitted at most 2 plates in every arrival window.

### What it misses, and the suspect for each
1. **The fresh run leaves the lobby at 55 s p50** (48–81 s, n 7; the target is 90–150 s).
   - All 7 runs read the first-run note at 15–18 s and heard the soul at 29–33 s. The pull showed at once and pointed at the room's way. They left at 48–55 s (4 runs) or 67–81 s (3 runs).
   - The bot is noisy here. The previous measure, on `b07d456`, had 3 of 7 runs meet the soul and gave 84 s. The tune step's 7 runs on this tree had 6 of 7 meet it and gave 68 s. Over this tree's 14 runs, 13 left by 81 s; the other left at 168 s after meeting the soul at 106 s.
   - Suspect: the authored thread is short for anyone who follows it. The fresh branch of `compass.js` `pullVisible` shows the pull at step 2, and `toward()` points it at the room's way, 15–50 s of walking from the soul.
   - Knobs, none of them a plain constant:
     - A floor-time floor on the step-2 pull. The tune step tried 75 s and dropped it: 5 of 7 bots then took a different way, a few steps from the soul, at 32–36 s.
     - A longer walk from `FIRST_SOUL` to `FIRST_ROOM` (`firstrun.js`). The note's and the soul's lines name those places, so this needs the owner's voice.
     - Or let playtest #1 judge it: a person reads and looks around more slowly than this bot.
2. **One arrival counted 3 budgeted plates in its first 45 s** (fresh run, seed 602, L1 at 54.3 s; the other 24 arrivals had at most 2).
   - The bot opened the map on L0 at 48.1 s. That queued `you start drawing. it is the only way to know you are moving.` as a discovery line behind a sight line.
   - Its 6 s discovery gap ran out in the last frame before `buildLevel`'s `msgQ.clear()`. So `#msg` held it for one frame (0.05 s) under `#fade`, then faded it.
   - Then came the floor's line and L1's exit hint. The game's `plate()` log for that arrival reads show, show, queue, queue: 2 admitted.
   - Knobs:
     - In `game.js`, clear `msgQ` when `travel()` starts, or skip `msgQ.tick` while `transitioning`. Then an old floor's queued line is never promoted under the veil.
     - Or, in `stats.mjs`, do not count a plate that is gone within a frame or is shown while `#fade` is up. The first knob also fixes the cause.
3. **Plates are on screen 35–56% of the time** (target ≤ 40%). 8 of the 11 sessions are above 40%: the seven fresh runs (43–56%) and L2 (53%).
   - Arrival and unprompted plates take 7–21% of the time, and warnings take 0–2%.
   - The bot's own plates take 26–42%: drawer results (it searched 5–13 drawers in each 3 minutes), the soul's word, bumps and the light.
   - Knob: the hold of player-caused plates (`messages.js` `holdS`, 4.2 s), or fewer result lines. The bot searches more eagerly than a person may, so read this miss together with playtest #1.
4. **9 of 585 dread beats sound with no creature within 24 path cells** (0 on L1, 1 on L2, 8 on L3; target 0).
   - All 9 come 0.4–6 s after a ward dispels the creature. The heartbeat reads `level` (`tension.js`: `heartbeatPeriod(level)`), and `level`'s slow fall (`DECAY` 0.12/s, shared with the hunt) holds it over the beat floor after the dread has gone.
   - Knob: in `tension.js`, beat on max(`huntLevel`, a dread term with its own fast fall). The tune step's prototype of this gave 0 · 0 · 0 in the walker. It changes how tension combines its terms, not a constant, so it was left to the owner.

### Met since tune round 1
- **Seek-walk p50 71 · 74 · 79 · 79 s.** The pull frees at 60 s on every floor.
  - Split halves (seeds null–29 / 30–59): L0 72 / 71, L1 75 / 73, L2 75 / 85, L3 77 / 80 s. All of them are inside 45–90 s.
  - Per floor (L0–L3), 12–16 of 60 seekers find a way by wandering before the pull, and 4–10 get an early hint from a page or a soul.
  - The other 34–44 wait the full 60 s, then walk a median 23–36 s on the pull. L2's p90 is 142 s.
- **82% of L1–L2 sightings are cued** (96/117; the 95% interval is 74–88%). It is met, without much margin.
  - The 21 uncued sightings: 13 come in a visit's first 5 s, with the creature already in view on arrival. Leaving those out gives 92%.
  - Tells come about half again as often as before (305 · 779 · 859 on L1–L3 over the walks, against 212 · 510 · 585 on `b07d456`).

The pull never names a stair up: 0 of 180 seekers were sent to one, against 75 of 180 on 2.0.3. Walking onto a stair up while wandering is not counted; that happened to 49 seekers.

## Notes

### Noise
- **The walker is deterministic for each seed.** Its noise is which 60 worlds it walks; the split halves above show its size.
  - Tune round 1's constants account for every walker change since the previous measure (`b07d456`).
  - The setting's line now shows at 50–59 s in 35 of 60 L0 explore walks (before: 60–76 s in 40 of 60). That moves L0's quiet stretches from 2.30 to 2.38.
  - The shorter seek walks (the pull frees at 60 s, not 90 s) leave less time for dread beats: 585 against 626.
- **The bot is not deterministic.** The same session on the same seed differs from run to run.
  - Fresh lobby p50 over three runs of 7 on the same lobby code: 84 s (`b07d456`), 68 s and 55 s (this tree). Nothing the tune changed is read on a fresh lobby.
  - Plate on screen over three runs of the 11 sessions: 30–57% (`b07d456`), then on this tree 36–52% with one 76% session (a bot warding a frozen smiler) and 35–56%.
- **The bot's drawer rolls are not independent.** A drawer's roll is fixed by its key, and every fresh run opens the same boxes in the fixed lobby. The box by the soul gives a floor plan to every bot that opens it (7 of 7 here). The sweep is the measure.
- **The bot met few creatures.** Sightings and heartbeats are the walker's.

### What playtest #1 must still judge
- **The seek walk.** Is 71–79 s to a way on, with the pull after 60 s, lost or stuck, or now too kind?
- **The fresh lobby.** The note → soul → room thread takes this bot 48–81 s. Is a person who reads and listens let go too soon? Is 90–150 s still the right target for a person?
- **The plates.** Do drawer results on screen (26–42% of the time for this bot) feel like noise or like play? A person probably searches less.
- **Dread.** Tells now come about half again as often. Do they read as warnings or as clutter? Does anyone notice a beat or two after a ward has dispelled the thing?
- **The quiet.** Every floor has at least 1.58 quiet stretches per 5 minutes. Is that dread or boredom? A clear "bored in the maze" on L1–L2 is the go for Tier 2a.

### How the tools follow the review
- **The walker follows two of the review's game.js changes.** The tree's game.js is sniffed for both (`lib.mjs` `WIRING`: `lostWait`, `ambientIdle`), so the 2.0.3 and as-built columns are unchanged.
  - The setting's line waits `LOST_AFTER_S` and is never said after a lead (W2).
  - An ambient line that the queue would drop is no plate and no count (W4).
- **The bot's plate hook matches the reviewed `plate()`.** `test/pacing-tools.test.js` fails if the plate or tell anchor slips on a tree that has them.
- **`stats.mjs` counts clutter lines as the player's** (`placement.js` `CLUTTER_LINES`), like bump lines (tune round 1). Rerunning it over the 2.0.3 and as-built bot logs gives byte-identical `metrics.json`, so those columns stand.

### Method
- **Port check.** `walks.mjs --legacy --seeds 20` on 2.0.3 reproduces the catch-up walker draw for draw: identical events. It gives the plan's numbers:
  - seek p50 12 / 13.1 / 17.3 / 17.6 s;
  - stairs up first 0 / 10 / 11 / 5 of 20;
  - repeats 17 / 19 / 21 / 27%;
  - happening gaps p50 / p90 81 / 107 s on L0.
- **The light-off share is new.** It is 15% asked and 14% measured, in 6–14 s stretches. On 2.0.3 every toggle says its line, so repeats rise from 17–27% to 43–48%. The bracketed figures leave the flashlight's lines out (18–23%).
- **Sample sizes.**
  - Walker: 60 worlds × 4 floors × 2 walkers.
  - Bot: one 3-minute session per floor, and 7 fresh runs. Its drawer counts (89–103 rolls) cannot settle 8–10%: 8/103 has a 95% interval of 4–15%. The sweep, over 20,000 keys per floor and the containers actually placed, is the measure.
- **How the bot's plates are classed.** The same rules apply on every tree.
  - **Player-caused:** a line said within 2.5 s after a key the bot pressed to act (E, F, Q, L, Space, C, Tab), plus bump, clutter and landmark lines.
  - **Arrival:** a line said within 12 s of a travel or a death, with no key pressed since.
  - **Warning:** the hunt's lines.
  - **Arrival + unprompted:** everything else. This is the column T1-4 budgets.
  - The tree's own murmurs, and lines fired by an event or a haunt, are always unprompted, unless a drawer rolled them.
  - Each arrival window ends at the next arrival.
  - On 2.0.4, the instrumented copy also logs every `plate()` decision, so this can be cross-checked.
- **What the walker does not model.** Searches and their floor plans; game.js's delayed `later()` arrival lines; the dimmer view with the light off. Its "lines in the first 45 s" are therefore approximate. The bot's count is the measure.
- **Only scratch copies are instrumented.** The bot only ever patches a copy outside the tree. None of the 49 sessions logged a page error or a blocked network request (11 on 2.0.3, 11 on the tree as built, 16 on `b07d456`, 11 on this tree). The block is installed when the bot takes over, so the boot before that is not covered.

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
