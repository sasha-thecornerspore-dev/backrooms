# Graphics: testing on your own devices

The game has two renderers. The **CPU** renderer is the default and always works. The **GPU** (WebGL2) renderer is finished but switched
off for everyone (`GPU_AUTO = false` in `src/renderer/renderer.js`) until it has been measured on real Chromebooks and phones. Nobody can do
that except you, on your devices. This page says how to do it in a few minutes and what to send back.

Everything below is switched on by adding something to the page's **address** (`?gfxbench=1`, `?gfxstats=1`, `?renderer=...`), so it works
wherever you can edit the address: the deployed `/play/` page (after the next deploy) in a normal browser tab. The installed app (PWA) and the
Electron desktop app have no address bar, and the Electron app always loads the page without one, so these switches cannot be used there:
open the same address in a browser tab on that device instead. None of it changes your saved game or your settings (what the GPU renderer
itself stores on the device is listed in §3).

## 0. Make sure you have the new version

The installed game (PWA) keeps a copy of itself for offline play. After a deploy, open the page, wait a few seconds, then **reload once**: the
new copy takes over on that reload. If `?gfxbench=1` below just shows the normal title screen, reload again.

## 1. The benchmark (about a minute) — `?gfxbench=1`

Open the play page with `?gfxbench=1` at the end of the address, for example `https://<your-site>/play/?gfxbench=1`.

1. Plug the device in if you can, close other tabs, set the screen to stay on.
2. Press **START** and leave it alone for about a minute. It walks slowly through five places (Level 0 corridor and room, Level 2 pipes,
   Level 3 station, the Level ∅ yard) five times: the CPU renderer at low, medium and high quality, then the GPU renderer at medium and high.
   The screen fades to black between views; nothing flashes; creatures stand still. The camera moves less (a shorter walk, a smaller, slower
   look around) when the device asks for reduced motion or **Reduce flicker** is on in the game's settings. Don't switch tabs (it stops and
   says so).
3. At the end you get a results card: a one-line verdict, a table and the "GPU_AUTO checks". Press **COPY RESULT** and paste the text into a
   message. That text is all we need.

Do it **twice on each device** (the numbers move a little between runs). The phone: in Chrome (a normal tab is fine). The Chromebook: in
a browser tab (not the installed app: it has no address bar).

What the table means:

| column | meaning |
| --- | --- |
| p50 / p95 / p99 | how long frames took on screen (ms). 16.7 = 60 fps, 33.3 = 30 fps. **p95** is "almost every frame is at least this fast" |
| >33 ms | share of frames slower than 30 fps (visible stutter) |
| render() p50 / p95 | CPU time the game spends drawing a frame (on the GPU path most of the work is on the graphics chip, so this is small) |
| internal | the resolution the world is drawn at before it is scaled to the screen |
| start ms | the worst hitch while a view starts (creating the renderer; on the GPU: compiling shaders and the one-time self-check) |
| validation | the GPU's one-time self-check against the CPU picture: `passed` is what we want; `failed` = the GPU picture did not match; `error` = the check could not finish because the GPU itself failed (the status column says how); `skipped` = it could not judge (a tiny or hidden window) |

If a GPU line says `unavailable (...)`, the reason in brackets explains it:

- `software-gl` or `no-webgl2`: the browser has no real GPU for WebGL here (the CPU renderer is the right one on that device);
- `crash-loop`: the GPU is blocked on this device for up to 24 hours, either because two GPU starts in a row never finished or because the GPU
  failed in a way that is remembered (§4);
- `gpu-failed-creation`: it could not start (for example a shader would not compile);
- `session-gpu-failed-...`: an earlier GPU line of this same run failed, so the rest of the run stays on the CPU.

A line that says `fell-back (gpu-failed-...)` started, then gave up while drawing (the part after `gpu-failed-` names the step).

## 2. The live stats panel — `?gfxstats=1`

Add `?gfxstats=1` to the address and play normally. A small dark panel shows, twice a second (on a computer it sits in the top-right corner
under the settings gear; on a phone held upright, under the health plate and item bar, with the centre messages moved below it; on a phone
held sideways, at the top between the health plate and the buttons):

- `renderer gpu (forced)` or `renderer cpu (...)` — which renderer is drawing and why, and how many times this session the GPU was given up
  (`fallbacks`)
- the GPU's name and its self-check result (GPU only)
- quality tier, render scale, canvas size and devicePixelRatio
- frame time p50 / p95 (the last ~4 seconds) and the share of frames slower than 30 fps
- the CPU time render() takes, p50 / p95
- what the last level start cost (building the level, creating the renderer, the first frame, ready)

Combine it with the switches below, e.g. `?gfxstats=1&renderer=gpu`. A screenshot of the panel on each level is a useful extra.

## 3. Forcing a renderer — `?renderer=cpu` / `?renderer=gpu`

- `?renderer=gpu` uses the GPU renderer for this visit (if the device has a real GPU and the self-check passes). It also tries the GPU when
  it is blocked for 24 hours (§4): that is on purpose, for testing.
- `?renderer=cpu` never touches the GPU. This is also the emergency switch if the GPU path ever misbehaves.

The switch itself only affects that page load and is not saved; without it the game uses the CPU renderer (while `GPU_AUTO` is off). Your
saved game and settings are never touched. A GPU start does store two small entries on the device (browser storage), which the next GPU
start reads:

- `backrooms:gpu-marker` — the crash-loop marker (set before the first GPU frame, cleared after a few seconds of healthy frames) and the
  24-hour block of §4;
- `backrooms:gpu-validated` — which GPU + game build already passed the self-check, so it does not run on every start.

## 4. What the automatic fallbacks mean

The GPU renderer steps aside by itself, and the game carries on with the CPU renderer without a reload:

| what happened | when | remembered for |
| --- | --- | --- |
| no usable GPU: no WebGL2, a software rasteriser, or the browser would not give a GPU context | at a level start | this visit only (checked again next visit) |
| it could not start: a shader would not compile or link, a GPU buffer or pass could not be set up | at a level start | this visit, and 24 hours on this device |
| the self-check failed (the GPU picture did not match the CPU picture), a GPU error in the first frames, or any error while drawing | in the first frames, or any time | this visit, and 24 hours |
| the graphics context was lost (driver reset, too many tabs) | any time | this visit only |
| frames stayed very slow even at the lowest resolution | after a few seconds | this visit only |

"24 hours" is the crash-loop block below: on the next visits the GPU line of the benchmark and the stats panel say `crash-loop` until it
expires.

**Crash loop protection:** if the page dies twice in a row while starting the GPU renderer (a GPU process crash, a hard freeze, before a few
seconds of healthy frames), the next start uses the CPU renderer for 24 hours. `?renderer=gpu` overrides that on purpose, and a GPU session
that then runs healthily clears it. The benchmark leaves it exactly as it found it (a block stays a block); only if one of the benchmark's
own GPU runs fails in a remembered way (the rows marked "24 hours" above) is that failure recorded, like anywhere else.

The stats panel's `fallbacks` count and the `why` text say which of these happened.

## 5. When to switch the GPU on for everyone (`GPU_AUTO = true`)

Flip it only when **all** of this holds, from two benchmark runs on **each** test device (at least the Chromebook and the Android phone):

1. `hardware GPU` is checked (the device's WebGL is a real GPU, not a software rasteriser);
2. both GPU lines are `ok`, `validation passed`, and **0 fallbacks** (the card's "GPU_AUTO checks" say **ALL PASS**);
3. **GPU medium is not slower than CPU medium**: its p95 frame time is at most 5% (+0.5 ms) above CPU medium's, and its >33 ms share is not
   more than 1 point higher (that is the fifth check on the card);
4. on **at least one** device the verdict reads "GPU … is N× faster than CPU medium" (p95 at least 15% lower) — otherwise there is nothing to
   gain and no reason to take the risk;
5. a few minutes of real play with `?renderer=gpu&gfxstats=1` on Level ∅, 0 and 2 shows `fallbacks 0` and nothing that looks wrong next to
   `?renderer=cpu` (the exit's blue beam, the warm glow of unread notes and see-through figures must look the same).

Then: set `GPU_AUTO = true` in `src/renderer/renderer.js`, bump both offline cache names (`CACHE` in `src/sw.js` and the default
`PLAY_SW_VERSION` in `tools/build-play.sh`), and deploy. `?renderer=cpu` stays as the escape hatch, and the automatic fallbacks above keep
protecting devices that were not tested.

If a device fails check 3 but passes the others, GPU_AUTO stays off; the result is still useful (it shows where the GPU path is slow).

## For developers

- The benchmark is `src/renderer/gfx-bench.js` (pure parts tested in `test/gfx-hc-bench.test.js` and `test/gfx-jc-bench.test.js`); the panel
  is `src/renderer/gfx-stats.js` (`test/gfx-hc-stats.test.js`, `test/gfx-jc-stats.test.js`).
- On a desktop: `MSYS_NO_PATHCONV=1 node_modules/electron/dist/electron.exe tools/gfx/page.cjs --query '?gfxbench=quick' --visible ...`
  runs a short benchmark in the real page (`--gpu` for the machine's real GPU; `--ropts '{"allowSoftwareGl":true}'` for SwiftShader, whose
  numbers mean nothing). `node tools/gfx/levelstart.mjs [--gpu]` measures level-start costs per configuration.
- The benchmark never writes the save or the prefs (it only reads the stored Reduce flicker setting). The only renderer state it touches is
  the GPU crash marker: each GPU start arms it as in the game, and at the end of the run (finished, interrupted or failed) it is put back
  exactly as the run found it, unless one of the run's own GPU starts failed persistently (renderer.js wrote the 24-hour block), which stays.
  Its self-check results are kept in memory only.
