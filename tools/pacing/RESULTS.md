# Pacing results: Tier 1 (2.0.4, "the maze has a pulse")

The same tools measure three trees: 2.0.3 (`20f4650`), 2.0.4 as built (`5bfb1ae`, before the review fixes), and 2.0.4 after the four review batches and tune rounds 1 and 2 (`943525b`, the column **2.0.4 measured**).
- Tune round 1 changed four constants: `compass.js` `PULL_WAIT_S` 90 → 60 and `LOST_AFTER_S` 60 → 50, and `dread.js` `TELL_BASE` 0.12 → 0.25 and `TELL_K` 0.4 → 0.8.
- Tune round 2 changed no game code. The bot now sees the travel's black veil (`#fade`), so a line put up while the screen is black is no plate.

Two tools, both run the same way on each tree:
- **The pacing walker** (`walks.mjs`, `analyze.mjs`). It walks 60 worlds per floor (seed null plus 1–59), 300 s each, as an explore walker and as a seek walker (a compass follower), with the light off 14% of the time.
- **The playtest bot** (`bot/`). It plays 3-minute sessions on the real renderer: the fresh lobby, L1, L2, L3, and a fresh run that takes ways, plus six more seeds of that run.

The 2.0.3 column comes from the same tools on 2.0.3. It differs from the plan's "today" column only where the new light-off share changes it (see *Method*).

## Tier 1 acceptance

| metric | 2.0.3 measured | Tier 1 target | 2.0.4 (as built) measured | 2.0.4 measured |
|---|---|---|---|---|
| seek-walk (compass follower) time on a floor, p50 (walker, L0 · L1 · L2 · L3) | 13 · 11 · 13 · 18 s | 45–90 s | 86 · 95 · 104 · 108 s | 71 · 74 · 79 · 79 s |
| fresh run: time in the lobby, for a bot that follows the thread (p50, min–max of n runs) | 23 s (21–80; n 7) | 90–150 s | 72 s (47–180, one never left in 180; n 7) | 56 s (42–75; n 7) |
| plates in the first 45 s of an arrival, any floor (bot, most in one arrival: arrival + unprompted / every plate) | 5 / 14 | ≤ 2 | 2 / 8 | 3 / 13 (the game's `plate()` admitted 2; see miss 2) |
| plate on screen (bot, range over sessions) | 34%–77% | ≤ 40% | 26%–55% | 41%–64% |
| `you rummage.` plates / flashlight plates per run / smiler teaching lines per run (bot; smiler: walker, most in one walk) | 83 / 4 / 3 | 0 / ≤ 2 / ≤ 1 | 0 / 1 / 1 | 0 / 1 / 1 |
| compass followers sent to a stair up first (walker, L1 · L2 · L3, of n worlds) | 24 · 30 · 21 of 60 | 0 | 0 · 0 · 0 of 60 | 0 · 0 · 0 of 60 |
| repeated lines within 5 min (walker, explore, L0 · L1 · L2 · L3; in brackets without the flashlight's lines) | 48% · 45% · 43% · 44% (20% · 18% · 18% · 23%) | ≤ 10% | 1% · 1% · 4% · 6% (2% · 2% · 5% · 8%) | 1% · 1% · 4% · 6% (1% · 1% · 6% · 8%) |
| drawer item / empty share (sweep of the tree's table, L1–3; bot rolls, n) | sweep 6.2–6.3% / 52.2–53.2%; bot 2.3% / 31.5% (n 89) | 8–10% / ≤ 35% | sweep 8.9–9.1% / 33.3–34.0%; bot 4.3% / 29.0% (n 93) | sweep 8.9–9.1% / 33.3–34.0%; bot 6.1% / 28.6% (n 98) |
| L1–L2 sightings preceded by a tell or the heartbeat 5–25 s earlier (walker, both walkers) | — | ≥ 80% | 76% (93/122); 85% (93/109) leaving out a visit's first 5 s | 82% (96/117); 92% (96/104) leaving out a visit's first 5 s |
| heartbeats with no creature within 24 path cells (walker, dread's own beats, L1 · L2 · L3; of all dread beats) | — | 0 | 0 · 8 · 10 (of 709) | 0 · 1 · 8 (of 585) |
| quiet stretches ≥ 45 s (no happening, no unprompted text) per 5 min (walker, explore, L0 · L1 · L2 · L3) | 2.78 · 2.45 · 2.25 · 1.78 | ≥ 1 | 2.62 · 2.25 · 2.35 · 1.73 | 2.38 · 2.53 · 2.22 · 1.58 |
| gap between happenings, p90 (walker, explore, L0 · L1 · L2 · L3; no Tier 1 target) | 107 · 95 · 85 · 70 s | — | 113 · 89 · 83 · 65 s | 113 · 94 · 80 · 62 s |
| frame-perf, 600 frames (`test/frame-perf.test.js`, not these tools) | passes | < 150 ms, identities held, path field zero-allocation | passes | passes |
| light-off share (walker setting, measured) | 14% | — | 14% | 14% |

**2.0.4 meets 7 of the 11 measures that have a target and misses 4.** Frame-perf passes as well.
- Met: the seek walk, stairs up, repeats, the drawer sweep, the cued sightings, the quiet stretches, and the rummage, flashlight and smiler lines.
- Missed: the fresh lobby, plate on screen and dread beats far from a creature, as at the last measure.
- The plate budget misses by the tool's count in 1 arrival of 26, on a line the player caused (miss 2). The game's own `plate()` admitted at most 2 plates in every arrival window.
- The walker's numbers are byte-identical to the last measure's, since no game code changed. Every bot number is a fresh run.

### What it misses, and the suspect for each
1. **The fresh run leaves the lobby at 56 s p50** (42–75 s, n 7; the target is 90–150 s).
   - All 7 runs read the first-run note at 15–18 s and heard the soul at 29–33 s.
   - They reached the room at 42–74 s and left 0.1–7 s later, after 1–3 searches.
   - Over the 21 fresh runs on this game code (three bot runs), the p50 is 55 s (42–126 s). Only 1 of the 21 is inside 90–150 s.
   - Suspect: the authored thread is short for anyone who follows it. The pull shows at step 2 and `toward()` points it at the room's way; the bots took 11–42 s from the soul to the room.
   - Knobs, none of them a plain constant:
     - Move the thread's room or soul (`firstrun.js` `FIRST_ROOM`, `FIRST_SOUL`). The note's and the soul's lines name those places, so this needs the owner's voice.
     - A floor-time floor on the step-2 pull. Tune round 2 tried 75 s and dropped it: the bots then took the way beside the soul.
     - Or let playtest #1 judge the target: a person reads and looks around more slowly than this bot.
2. **One arrival counted 3 budgeted plates in its first 45 s** (fresh run, seed 604, L3 at 163.9 s; the other 25 arrivals had at most 2).
   - The three are the floor's line, the way's hint, and `something counts the drawers you open.`
   - The third is the player's. It was said 0.8 s after the bot searched a drum, then waited in the queue behind the result (`empty. someone has been through here.`). It went up 6.05 s after it was said.
   - `stats.mjs` matches a plate to its `showMessage` only within 6 s, so this plate lost its cause and was counted as budgeted.
   - The game's `plate()` log for that arrival reads show, show, queue: 2 admitted.
   - Knob, in the tool: in `stats.mjs`, match a plate to its say over the queue's longest wait (a held result plus the discovery gap), not 6 s. No game change is needed.
3. **Plates are on screen 41–64% of the time** (target ≤ 40%). All 11 sessions are above 40%.
   - Budgeted plates take 3–19% of the time and warnings 0–9%.
   - The bot's own plates take 19–49%: drawer results (4–18 searches in 3 minutes), ward lines (`you push at the dark. it gives nothing back.` 21 times, 19 of them in two runs that were hunted), the soul's word and the light.
   - L2 is at 53% with 3% budgeted. Its player-caused plates, with 18 searches, take 49%.
   - Over the 33 bot sessions on this game code, budgeted plates never take more than 21%, and 26 sessions are above 40% in all.
   - Knob: the hold of player-caused plates (`messages.js` `holdS`, 4.2 s), or fewer result lines. The bot searches and wards more eagerly than a person may, so read this miss together with playtest #1.
4. **9 of 585 dread beats sound with no creature within 24 path cells** (0 on L1, 1 on L2, 8 on L3; target 0).
   - Four are dread alone. `level` (0.21–0.26) falls after a ward dispels the creature and beats once, 0.35–0.85 s after.
   - Five are the tail of a hunt's fade. Dread's earlier lift keeps `level` 0.10–0.17 over `huntLevel`, so the beat outlasts `huntLevel`'s crossing of the floor by about a second.
   - `DREAD_CAP`, `DREAD_K` and `DECAY` are in `tension.js`, and any cap over the beat floor leaves the tail.
   - Knob: in `tension.js`, dread as its own fast-falling term, with the heartbeat on max(`huntLevel`, that term). Tune round 1's prototype of this gave 0 · 0 · 0 in the walker. It changes how tension combines its terms, not a constant, so it is left to the owner.

### Met since tune round 1
- **Seek-walk p50 71 · 74 · 79 · 79 s.** The pull frees at 60 s on every floor.
  - Split halves (seeds null–29 / 30–59): L0 72 / 71, L1 75 / 73, L2 75 / 85, L3 77 / 80 s. All of them are inside 45–90 s.
  - Per floor (L0–L3), 12–16 of 60 seekers find a way by wandering before the pull, and 4–10 get an early hint from a page or a soul.
  - The other 34–44 wait the full 60 s, then walk a median 23–36 s on the pull. L2's p90 is 142 s.
- **82% of L1–L2 sightings are cued** (96/117; the 95% interval is 74–88%). It is met, without much margin.
  - The 21 uncued sightings: 13 come in a visit's first 5 s, with the creature already in view on arrival. Leaving those out gives 92%.
  - Tells come about half again as often as at the review's end (305 · 779 · 859 on L1–L3 over the walks, against 212 · 510 · 585 on `b07d456`).

The pull never names a stair up: 0 of 180 seekers were sent to one, against 75 of 180 on 2.0.3. Walking onto a stair up while wandering is not counted; that happened to 49 seekers.

## Notes

### Noise
- **The walker is deterministic for each seed.** Its noise is which 60 worlds it walks; the split halves above show its size. Rerun on this tree, it gives the last measure's walks byte for byte.
- **The bot is not deterministic.** The same session on the same seed differs from run to run, and the noise between runs is larger than most changes it is asked to see.
  - Fresh lobby p50 over runs of 7 on the same lobby code: 84 s (`b07d456`), then 68, 55, 55 and 56 s (this game code).
  - Plate on screen over three runs of the 11 sessions on this game code: 35–56%, 32–50% and 41–64%. One long hunt moves a session a long way: here seed 605 was hunted for about a minute, warded 20 times and reached 64%.
  - The plate budget's tool misses (miss 2 here, the veil at the last measure) each come from 1 arrival of 25–27, a line held in the queue at an edge the tool draws.
- **The bot's drawer rolls are not independent.** A drawer's roll is fixed by its key, and every fresh run opens the same boxes in the fixed lobby. The box by the soul gives a floor plan to every bot that opens it. The sweep is the measure.
- **The bot met few creatures.** Sightings and heartbeats are the walker's.

### What playtest #1 must still judge
- **The fresh lobby.** The note → soul → room thread takes this bot 42–75 s. Is a person who reads and listens let go too soon? Is 90–150 s still the right target for a person?
- **The seek walk.** Is 71–79 s to a way on, with the pull after 60 s, lost or stuck, or now too kind?
- **The plates.** Do drawer results and ward lines on screen (19–49% of the time for this bot) feel like noise or like play? A person probably searches and wards less.
- **Dread.** Do the tells read as warnings or as clutter? Does anyone notice a beat or two after a ward has dispelled the thing?
- **The quiet.** Every floor has at least 1.58 quiet stretches per 5 minutes. Is that dread or boredom? A clear "bored in the maze" on L1–L2 is the go for Tier 2a.

### How the tools follow the review
- **The walker follows two of the review's game.js changes.** The tree's game.js is sniffed for both (`lib.mjs` `WIRING`: `lostWait`, `ambientIdle`), so the 2.0.3 and as-built columns are unchanged.
  - The setting's line waits `LOST_AFTER_S` and is never said after a lead (W2).
  - An ambient line that the queue would drop is no plate and no count (W4).
- **The bot's plate hook matches the reviewed `plate()`.** `test/pacing-tools.test.js` fails if the plate or tell anchor slips on a tree that has them.
- **`stats.mjs` counts clutter lines as the player's** (`placement.js` `CLUTTER_LINES`), like bump lines (tune round 1).
- **The bot sees the travel's veil** (tune round 2). `bot.js` dims what stacks under `#fade` by the veil's opacity and logs `(veiled)`; `stats.mjs` hides it like `(hidden)`. `test/pacing-tools.test.js` guards that `#fade` still stacks over the base `#msg`.
- Rerunning the current `stats.mjs` over the 2.0.3 and as-built bot logs gives byte-identical `metrics.json`, so those columns stand.

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
  - A plate is matched to its line's `showMessage` only within 6 s. A line held longer in the queue loses its cause and counts as unprompted (miss 2).
  - On 2.0.4, the instrumented copy also logs every `plate()` decision, so this can be cross-checked.
- **What the walker does not model.** Searches and their floor plans; game.js's delayed `later()` arrival lines; the dimmer view with the light off. Its "lines in the first 45 s" are therefore approximate. The bot's count is the measure.
- **Only scratch copies are instrumented.** The bot only ever patches a copy outside the tree. None of the 71 sessions logged a page error or a blocked network request (11 on 2.0.3, 11 on the tree as built, 16 on `b07d456`, 33 on this game code). The block is installed when the bot takes over, so the boot before that is not covered.

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
