# Pacing results: Tier 1 (2.0.4, "the maze has a pulse")

The same tools measure three trees: 2.0.3 (`20f4650`), 2.0.4 as built (`5bfb1ae`, before the review fixes), and 2.0.4 after the five review batches and tune rounds 1 and 2 (`4599f9f`, the column **2.0.4 measured**).
- Tune round 1 changed four constants: `compass.js` `PULL_WAIT_S` 90 → 60 and `LOST_AFTER_S` 60 → 50, and `dread.js` `TELL_BASE` 0.12 → 0.25 and `TELL_K` 0.4 → 0.8.
- Tune round 2 changed no game code. The bot now sees the travel's black veil (`#fade`), so a line put up while the screen is black is no plate.
- Review batch five changed three things the game does, rather than a tuning number.
  - In `tension.js`, dread is a term of its own that falls at 2/s, and the heartbeat follows the louder of it and the hunt's.
  - A wake, the way that files you and a floor you come back to say their lines again (`game.js` `die()` and `travel()`).
  - Sweet almond water softens the step you hear as it softens the one the things hear.
- Batch five also fixed a tool, and review batch six fixed it again: `stats.mjs` matches a plate to its say within the plate's arrival, however long the line waited in the queue, not within a flat 6 s (see *How the tools follow the review*). On this measure's logs batch six's matcher gives the same numbers as batch five's.

Two tools, both run the same way on each tree:
- **The pacing walker** (`walks.mjs`, `analyze.mjs`). It walks 60 worlds per floor (seed null plus 1–59), 300 s each, as an explore walker and as a seek walker (a compass follower), with the light off 14% of the time.
- **The playtest bot** (`bot/`). It plays 3-minute sessions on the real renderer: the fresh lobby, L1, L2, L3, and a fresh run that takes ways, plus six more seeds of that run.

The 2.0.3 column comes from the same tools on 2.0.3. It differs from the plan's "today" column only where the new light-off share changes it (see *Method*).

## Tier 1 acceptance

| metric | 2.0.3 measured | Tier 1 target | 2.0.4 (as built) measured | 2.0.4 measured |
|---|---|---|---|---|
| seek-walk (compass follower) time on a floor, p50 (walker, L0 · L1 · L2 · L3) | 13 · 11 · 13 · 18 s | 45–90 s | 86 · 95 · 104 · 108 s | 71 · 74 · 79 · 79 s |
| fresh run: time in the lobby, for a bot that follows the thread (p50, min–max of n runs) | 23 s (21–80; n 7) | 90–150 s | 72 s (47–180, one never left in 180; n 7) | 72 s (53–133; n 7) |
| plates in the first 45 s of an arrival, any floor (bot, most in one arrival: arrival + unprompted / every plate) | 4 / 14 | ≤ 2 | 2 / 8 | 2 / 8 |
| plate on screen (bot, range over sessions) | 34%–77% | ≤ 40% | 26%–55% | 36%–53% |
| `you rummage.` plates / flashlight plates per run / smiler teaching lines per run (bot; smiler: walker, most in one walk) | 83 / 4 / 3 | 0 / ≤ 2 / ≤ 1 | 0 / 1 / 1 | 0 / 1 / 1 |
| compass followers sent to a stair up first (walker, L1 · L2 · L3, of n worlds) | 24 · 30 · 21 of 60 | 0 | 0 · 0 · 0 of 60 | 0 · 0 · 0 of 60 |
| repeated lines within 5 min (walker, explore, L0 · L1 · L2 · L3; in brackets without the flashlight's lines) | 48% · 45% · 43% · 44% (20% · 18% · 18% · 23%) | ≤ 10% | 1% · 1% · 4% · 6% (2% · 2% · 5% · 8%) | 1% · 1% · 4% · 6% (1% · 1% · 6% · 8%) |
| drawer item / empty share (sweep of the tree's table, L1–3; bot rolls, n) | sweep 6.2–6.3% / 52.2–53.2%; bot 2.3% / 31.5% (n 89) | 8–10% / ≤ 35% | sweep 8.9–9.1% / 33.3–34.0%; bot 4.3% / 29.0% (n 93) | sweep 8.9–9.1% / 33.3–34.0%; bot 10.5% / 24.8% (n 105) |
| L1–L2 sightings preceded by a tell or the heartbeat 5–25 s earlier (walker, both walkers) | — | ≥ 80% | 76% (93/122); 85% (93/109) leaving out a visit's first 5 s | 82% (96/117); 92% (96/104) leaving out a visit's first 5 s |
| heartbeats with no creature within 24 path cells (walker, dread's own beats, L1 · L2 · L3; of all dread beats) | — | 0 | 0 · 8 · 10 (of 709) | 0 · 0 · 0 (of 371) |
| quiet stretches ≥ 45 s (no happening, no unprompted text) per 5 min (walker, explore, L0 · L1 · L2 · L3) | 2.78 · 2.45 · 2.25 · 1.78 | ≥ 1 | 2.62 · 2.25 · 2.35 · 1.73 | 2.38 · 2.53 · 2.22 · 1.58 |
| gap between happenings, p90 (walker, explore, L0 · L1 · L2 · L3; no Tier 1 target) | 107 · 95 · 85 · 70 s | — | 113 · 89 · 83 · 65 s | 113 · 94 · 80 · 62 s |
| frame-perf, 600 frames (`test/frame-perf.test.js`, not these tools) | passes | < 150 ms, identities held, path field zero-allocation | passes | passes |
| light-off share (walker setting, measured) | 14% | — | 14% | 14% |

**2.0.4 meets 9 of the 11 measures that have a target and misses 2.** Frame-perf passes as well.
- Met: the seek walk, the plate budget, stairs up, repeats, the drawer sweep, the cued sightings, dread beats near a creature, the quiet stretches, and the rummage, flashlight and smiler lines.
- Missed: the fresh lobby and plate on screen, as at the last measure.
- Newly met: dread's beats, by review batch five's heartbeat fix, and the plate budget, which the last measure missed by the tool's count only.
- The walker's numbers are the last measure's except the heartbeat row, which `tension.js` moved. Every bot number is a fresh run.

### What it misses, and the suspect for each
1. **The fresh run leaves the lobby at 72 s p50** (53–133 s, n 7; the target is 90–150 s).
   - 6 of the 7 runs read the first-run note at 15–18 s and heard the soul at 29–32 s.
   - They reached the room at 52–83 s and left 0.1–3.3 s later, after 1–4 searches. From the soul to the room took them 21–52 s.
   - The seventh (seed 602) read the note at 16 s and never heard the soul. The pull came at 120 s, the fallback, and it left at 133 s after 7 searches. It is the only run inside 90–150 s.
   - Review batch five did not touch the lobby's thread. Over 28 fresh runs on this lobby code (the 21 the last measure pooled and these 7), the p50 is 56 s (42–133 s). 2 of the 28 are inside 90–150 s.
   - Suspect: the authored thread is short for anyone who follows it. The pull shows at step 2 and `toward()` points it at the room's way.
   - Knobs, none of them a plain constant:
     - Move the thread's room or soul (`firstrun.js` `FIRST_ROOM`, `FIRST_SOUL`). The note's and the soul's lines name those places, so this needs the owner's voice.
     - A floor-time floor on the step-2 pull. Tune round 2 tried 75 s and dropped it: the bots then took the way beside the soul.
     - Or let playtest #1 judge the target: a person reads and looks around more slowly than this bot.
2. **Plates are on screen 36–53% of the time** (target ≤ 40%). 8 of the 11 sessions are above 40%; seed 602's fresh run (36%), L0 (39%) and L3 (40%) are not.
   - Budgeted plates take 8–15% of the time and warnings 0–6%.
   - The bot's own plates take 25–42%: drawer results above all (6–17 searches in 3 minutes), the soul's word and the light. The floor plan's line (`a floor plan with one room shaded in. you mark it on yours.`) was the most shown line, 22 times.
   - Nothing hunted the bot this run, so it said no ward lines (21 at the last measure).
   - L2 is at 52% with 10% budgeted. Its player-caused plates, with 11 searches, take 42%.
   - Over the 44 sessions of four bot runs (the last measure's three and this one), budgeted plates never take more than 21%, and plate on screen runs 32–64%.
   - Knob: the hold of player-caused plates (`messages.js` `holdS`, 4.2 s), or fewer result lines. The bot searches and wards more eagerly than a person may, so read this miss together with playtest #1.

### Met since review batch five
- **No dread beat sounds far from a creature: 0 · 0 · 0 of 371** (0 · 1 · 8 of 585 at the last measure).
  - Dread's term now falls at 2/s, so a beat it raised stops within a beat of the thing going. The last measure's far beats came after a ward had dispelled the thing, or in the tail of a hunt's fade.
  - Dread's beats fell from 585 to 371, and all heartbeats from 2495 to 2368. The cued sightings did not move (96/117).
- **At most 2 budgeted plates in the first 45 s of every arrival** (2 / 8 over 26 arrivals; 3 / 13 at the last measure).
  - The tool: `stats.mjs` now matches a plate to its say within the plate's arrival, however long the line waited in the queue. A line the player caused that waited behind a result keeps its cause (the last measure's miss).
  - Here 1 of 255 plates needed more than 6 s: a way's hint, held 6.15 s. It is an arrival line either way. No line waited longer.
  - The game: `plate()`'s own log admitted at most 2 budgeted plates in every arrival window. A search's result beside them is free.
- **The filing line went up in all 7 fresh runs.** It was said 3.8 s into the first arrival and went up 3.8–5.9 s in.
  - At the last measure it waited out the window: said at 45 s in 5 of 7 runs, and up in 4.
  - The way's hint, kept, now goes up as the window ends (45.0–45.2 s) in the 6 runs still on the floor then.
- **The wake and the revisit lines are not in these numbers.** No bot died or came back to a floor; seed 605 climbed out at 179.2 s, 0.8 s before its session ended. `test/pulse-wiring.test.js` replays both with the real budget, and every wake stays at 2 plates or fewer in 45 s.

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
- **The walker is deterministic for each seed.** Its noise is which 60 worlds it walks; the split halves above show its size. On this tree it gives byte for byte the walks measured for batch five's heartbeat fix (`4b62508`), so the batch's other commits move no walker number.
- **The bot is not deterministic.** The same session on the same seed differs from run to run, and the noise between runs is larger than most changes it is asked to see.
  - Fresh lobby p50 over runs of 7 on the same lobby code: 84 s (`b07d456`), then 68, 55, 55 and 56 s (the tune rounds' game code), then 72 s (this tree).
  - Plate on screen over those four runs of the 11 sessions: 35–56%, 32–50%, 41–64% and 36–53%.
  - One long hunt moves a session a long way. At the last measure seed 605 was hunted for about a minute, warded 20 times and reached 64%. Nothing hunted the bot this run.
  - The plate budget's two tool misses (the veil, then the queue's wait) each came from 1 arrival of 25–27, a line held at an edge the tool drew. The tool draws neither edge now: the bot reads the veil's opacity, and a plate's say is looked for back to its arrival, where `buildLevel` clears the queue.
- **The bot's drawer rolls are not independent.** A drawer's roll is fixed by its key, and every fresh run opens the same boxes in the fixed lobby. The box by the soul gives a floor plan to every bot that opens it. The sweep is the measure.
- **The bot met few creatures.** Sightings and heartbeats are the walker's.
- **The fresh lobby rests on the shipped docket** (review batch six). The lobby's note and soul, and the pull's longer wait, hold only while the lobby's row of `world.json`'s docket leads nothing that re-lays its souls (`firstrun.js` `threadHolds`). A compliance or litigation lead there (two such wishes filed on the lobby and recounted by `tools/docket.mjs`) turns the thread off: no note, and the pull frees at the ordinary 60 s. The docket ships all zeros, and these numbers and the manual's note are that docket's. No test guards it, because a red test would fail the wish workflows' grant (`wish-auto.yml` runs `npm test` after the recount). Re-measure the fresh lobby, and say so in the manual, if a granted wish ever leans that row.

### What playtest #1 must still judge
- **The fresh lobby.** The note → soul → room thread takes this bot 53–84 s. Is a person who reads and listens let go too soon? Is 90–150 s still the right target for a person?
- **The seek walk.** Is 71–79 s to a way on, with the pull after 60 s, lost or stuck, or now too kind?
- **The plates.** Do drawer results and ward lines on screen (25–42% of the time for this bot) feel like noise or like play? A person probably searches and wards less.
- **Dread.** Do the tells read as warnings or as clutter? The heartbeat now stops within a beat of the thing going: is that the thing leaving, or a cut?
- **The wake and the return.** No bot died or came back to a floor. A person's first death and first return are the first look at those lines outside the replays.
- **The quiet.** Every floor has at least 1.58 quiet stretches per 5 minutes. Is that dread or boredom? A clear "bored in the maze" on L1–L2 is the go for Tier 2a.

### How the tools follow the review
- **The walker follows two of the review's game.js changes.** The tree's game.js is sniffed for both (`lib.mjs` `WIRING`: `lostWait`, `ambientIdle`), so the 2.0.3 and as-built columns are unchanged.
  - The setting's line waits `LOST_AFTER_S` and is never said after a lead (W2).
  - An ambient line that the queue would drop is no plate and no count (W4).
- **The bot's plate hook matches the reviewed `plate()`.** `test/pacing-tools.test.js` fails if the plate or tell anchor slips on a tree that has them.
- **`stats.mjs` counts clutter lines as the player's** (`placement.js` `CLUTTER_LINES`), like bump lines (tune round 1).
- **The bot sees the travel's veil** (tune round 2). `bot.js` dims what stacks under `#fade` by the veil's opacity and logs `(veiled)`; `stats.mjs` hides it like `(hidden)`. `test/pacing-tools.test.js` guards that `#fade` still stacks over the base `#msg`.
- **`stats.mjs` matches a plate to its say within the plate's arrival, however long the line waited** (review batches five and six).
  - Batch five's window, the queue's discovery gap plus its hold (10.2 s), was not the longest wait. The queue drops no discovery line, so a line waits out the gap of every one said before it. The extension's three closing lines, with a landmark's line said 0.4 s after the last of them, put the landmark's line up 12.05 s after its say.
  - Only an arrival ends a wait: `buildLevel` clears the queue, and `clear()` drops what still waits. `lib.mjs` `queueBound` and `buildLevelClears` read both off the measured tree's own `messages.js` and `game.js`. On a tree that kept its lines through an arrival, `stats.mjs` would match with no bound.
  - `matchSays` gives each plate the latest say of its text, in the plate's arrival, that no earlier plate took. A say logged at the arrival's instant is the new floor's; a plate logged there is still the old floor's (the bot reads `#msg` before the game's frame ticks the queue).
  - On the logs of this measure and of the three 2.0.4 runs before it, each plate gets the say that a replay of the logged says through the measured tree's own queue gives it, wherever the replay can place the plate.
  - `stats.txt` lists, per session, the plates with no say and the longest waits.
  - `test/pacing-tools.test.js` guards the matcher, the bound, and that `stats.mjs` uses them.
- **The current `stats.mjs` over the bot logs, against the flat 6 s.**
  - On the as-built logs, 1 of 250 plates gains its cause and no metric moves.
  - On 2.0.3's, 13 of 375 gain theirs, and the most budgeted plates in one arrival falls from 5 to 4. Plate on screen keeps its range; only its split by class moves.
  - 7 of the 13 waited 10.3–14.2 s, past batch five's window: five filing lines, the tv wall's line and a floor-you-know line. Batch six's matcher gives them their say, and no cell of the 2.0.3 column moves.
  - On the 2.0.4 logs (this measure's and the three before it), batch six's matcher changes no plate.
  - The table's 2.0.3 column is the current tool's.
- **Neither tool hears your own steps**, so quiet water's change moves no row.

### Method
- **Port check.** `walks.mjs --legacy --seeds 20` on 2.0.3 reproduces the catch-up walker draw for draw: identical events. It gives the plan's numbers:
  - seek p50 12 / 13.1 / 17.3 / 17.6 s;
  - stairs up first 0 / 10 / 11 / 5 of 20;
  - repeats 17 / 19 / 21 / 27%;
  - happening gaps p50 / p90 81 / 107 s on L0.
- **The light-off share is new.** It is 15% asked and 14% measured, in 6–14 s stretches. On 2.0.3 every toggle says its line, so repeats rise from 17–27% to 43–48%. The bracketed figures leave the flashlight's lines out (18–23%).
- **Sample sizes.**
  - Walker: 60 worlds × 4 floors × 2 walkers.
  - Bot: one 3-minute session per floor, and 7 fresh runs. Its drawer counts (89–105 rolls) cannot settle 8–10%: 11/105 has a 95% interval of 6–18%. The sweep, over 20,000 keys per floor and the containers actually placed, is the measure.
- **How the bot's plates are classed.** The same rules apply on every tree.
  - **Player-caused:** a line said within 2.5 s after a key the bot pressed to act (E, F, Q, L, Space, C, Tab), plus bump, clutter and landmark lines.
  - **Arrival:** a line said within 12 s of a travel or a death, with no key pressed since.
  - **Warning:** the hunt's lines.
  - **Arrival + unprompted:** everything else. This is the column T1-4 budgets.
  - The tree's own murmurs, and lines fired by an event or a haunt, are always unprompted, unless a drawer rolled them.
  - Each arrival window ends at the next arrival.
  - A plate's say is the latest `showMessage` of its text that no earlier plate took, said in the plate's arrival, however long before it. Only an arrival ends a line's wait in the queue: `buildLevel` clears it.
  - A plate with no say is a boot line, said before the bot's hooks, and counts as unprompted: the floor's line or name at 0.1–0.3 s, and on the as-built tree the setting's line at 1.6 s.
  - On 2.0.4, the instrumented copy also logs every `plate()` decision, so this can be cross-checked.
- **What the walker does not model.** Searches and their floor plans; game.js's delayed `later()` arrival lines; the dimmer view with the light off. Its "lines in the first 45 s" are therefore approximate. The bot's count is the measure.
- **Only scratch copies are instrumented.** The bot only ever patches a copy outside the tree. None of the 82 sessions logged a page error or a blocked network request (11 on 2.0.3, 11 on the tree as built, 16 on `b07d456`, 33 on the tune rounds' game code, 11 on this tree). The block is installed when the bot takes over, so the boot before that is not covered.

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
