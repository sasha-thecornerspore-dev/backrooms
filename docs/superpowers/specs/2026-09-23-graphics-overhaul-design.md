# Graphics overhaul — design (2026-09-23)

Goal: make the maze look dramatically better — lighting, surfaces, creatures, atmosphere — without changing
gameplay, maps, seeds, multiplayer parity, or the project's promise (*"no game engine, no assets, just math and the
colour yellow"*). Owner's brief: "pretty far, do the best we can."

Two milestones, in order:

- **M1 — deepen the CPU raycaster** (all of it works on every device, no GPU dependence).
- **M2 — a WebGL2 backend** on the same data (textures, light model, sprite atlas), with the CPU renderer kept as the
  fallback and a kill switch.

Shipping the PWA = `tools/build-play.sh` into the gh-pages `play/` dir.

## What the recon found (facts to design against)

- `renderer.js` (1062 lines) is a CPU pipeline: per-row floor/ceiling cast → per-column wall cast (`castRay`, first hit
  only, one wall height) → `putImageData` into a 0.6-scale buffer → Canvas2D vector sprites → grain → bilinear upscale
  → vignette / flicker blackout → particles → flashlight/glow gradients → nameplates → crosshair.
- **There is no light model.** Ceiling panels are bright texels; floor and walls are shaded only by linear distance fog
  × a single global `flicker` scalar. The flashlight is a screen-space gradient that lights nothing.
- Levels 2 and 3 are recoloured lobbies (same 64px wallpaper/carpet/ceiling tiles). Only Level ∅ has per-cell
  materials (`worldHooks.materialAt`, fixed maps only) and sky.
- Creatures are black lozenges with two dots (`drawFigure`); props are flat rectangles; only the centre column of most
  sprites is depth-tested (they bleed through corners); sprites ignore `flicker`; enemy `state/dir/stagger` are never read.
- The frame budget is tight: the textured floor/ceiling pass dominated at ~23 ms on the recon harness; the wall pass is
  cheap. Chromebooks/Android are first-class targets. No on-device timing exists.
- `devicePixelRatio` is ignored; no quality setting; `RENDER_SCALE` is a constant 0.6; animations are frame-coupled.
- Full-frame luminance dips reach 92% on Level 3 with no per-second cap; the Polaroid flash is 90% white. Nothing honours
  `prefers-reduced-motion`.
- Nothing tests the renderer. `castRay`'s `{dist, side, wallX, mx, my}` shape is pinned by `test/raycaster.test.js`.

## Non-negotiables

1. **Procedural only.** No image/model/font assets added. Everything is generated from seeded PRNGs at load.
2. **Render-only.** Do not touch `isWall`, chunk generation, seeded placement (`decor.js`, `items.js`, `entities.js`
   placement hashes/RNG order), `levels.js` type lists, or anything that changes what the maze *is*. Existing golden tests
   must stay green (baseline: 279 pass, 1 pre-existing unrelated failure `client.test.js › two clients see each other`).
3. **Tone.** Deeply unsettling, not cartoony. Threats are silhouettes, light and wrongness. **No gore, no blood, no
   wounds.** A 15-year-old plays this. Level ∅ is a real place: flat, photographic surfaces (the thesis is "a photograph of
   a window glued where a window was"); no recognisable skyline; no residents shown; lit windows stay; the notice stays
   unreadable.
4. **Colour roles.** Lobby stays mono-yellow; every colour is still driven from `config.palette` (wishes drift it).
   Cold blue = exits/instruments/other people; warm glow = unread notes; violet = sanity; green = glowstick/HP; red =
   hurt only. The exit beam and note glow must stay readable through fog. `thin` figures stay see-through (a Polaroid
   caption depends on it).
5. **Photosensitivity.** WCAG 2.3.1 is the ceiling: no more than 3 flashes/second, no large-area high-contrast strobing.
   New effects are spatial and low-contrast. Add a `reduceFlicker` preference (default on when `prefers-reduced-motion`),
   rate-limit the flicker state machine, cap the Polaroid flash.
6. **Every device keeps working.** Quality tiers + adaptive resolution; the CPU renderer is always the fallback, never
   software-GL. Kill switch: pref `renderer: auto|gpu|cpu` and `?renderer=cpu`.
7. **HUD legibility.** HUD ink is near-black with a white glow, tuned for a bright scene. Darker lighting must come with
   HUD backing plates so text stays readable on every level.
8. **PWA plumbing.** New modules are **flat siblings in `src/renderer/`** (no subfolders — `tools/build-play.sh` copies
   `src/renderer/*.js` flat). Every new file must be added to both `SHELL` lists (`src/sw.js` and the heredoc in
   `tools/build-play.sh`) and the cache name bumped. New modules must be **import-safe in Node** (no `document`/`window`
   at module scope) so their pure parts can be unit-tested with vitest.
9. **Keep the extras working.** The polaroid capture (`canvas.toDataURL`) and the radio/beacon/scraps visuals must keep
   working.

## Module map (all flat files in `src/renderer/`)

| file | owns | notes |
|---|---|---|
| `renderer.js` | public entry `createRenderer(canvas, config, renderOpts, worldHooks)` | returns `{ render, kind, capture(), dispose() }`; M1: delegates to `gfx-cpu.js`; M2: selects CPU/GL |
| `gfx-util.js` | `hexToRgb, lerp, clamp255, mulberry32, hash2` | shared by CPU and GL paths |
| `gfx-textures.js` | `buildTextures(palette, materials, look)` → **TexSet**; `buildGrain()` | procedural tile art, per-level styles, decals |
| `gfx-light.js` | light model data + helpers | illumination tiles, emitters, per-panel flicker, flashlight LUT; pure/testable |
| `gfx-world.js` | `renderWorld(fs, tex, light, isWallFn, materialAt, buf32, zbuffer)` | floor/ceiling/wall passes incl. sampling & filtering |
| `gfx-sprites.js` | sprite art + `drawSprites(...)` | atlas of pre-rasterised frames; CPU column blit with per-column z test |
| `gfx-post.js` | `composeFrame(...)` and screen-space overlays | grain, upscale, bloom, grade, vignette, particles, flashlight/glow, nameplates, crosshair |
| `gfx-cpu.js` | `createCpuRenderer(...)` | owns buffers/canvases; sequences stages; no art logic |
| `gfx-quality.js` | `pickRenderer(env)`, quality tiers, adaptive scale, crash-loop breaker | pure, Node-testable |
| `gfx-gl.js` | WebGL2 backend (M2) | separate sibling canvas; never touches `#c`'s 2D context |

### Contracts as implemented (Phase 0 + contract-prep; read the file headers too)
All of these exist in code and are covered by tests; **do not change a contract without telling the integrator** — change
what is behind it.

**Frame state `fs`** (built once per frame in `gfx-cpu.js`, read-only for stages): `W,H,HH` (low-res buffer, horizon row),
`OW,OH` (visible canvas), `fog, fogRgb, fogMul, frame`, `flicker` (**clamped** by the comfort rule — use it to dim anything
globally), `rawFlicker` (the game's unclamped scalar — use it as the *event intensity* `1 - rawFlicker` that drives spatial,
per-panel flicker), `comfort {reduceFlicker, maxGlobalDip}`, `t, dt` (real seconds; **animate from these, never from `frame`**),
`player, lights {flashlight, glow}, lightsOn, hasSky, skyRgb`, `light` (the light model), `quality`, `opts` (the live
`renderOpts` prefs object), `fov, hf`. `render(player, isWallFn, flicker, entities, fogMul, lights, timing?)` — `timing = {t, dt}`
is optional; `game.js` will pass it (Track D).

**TexSet v2** (`gfx-textures.js`): `{ ts, tmask, walls, ceil, floor, light, look, wallVar, ceilVar, floorVar }`. `walls` is the
base tile per material code; `wallVar` is `null | { [code]: Uint8Array[] }` (the world pass picks
`arr[hash2(hitCellX, hitCellY, side) % arr.length]` when `arr.length > 1`), `floorVar`/`ceilVar` are `null | Uint8Array[]`
picked per cell with `hash2(cellX, cellY, 1|2)`. **All tiles of one TexSet share `ts`** (64 or 128). Variants are how stains,
outlets, vents, damage and decals reach the screen — bake them into variant tiles. The selection code is already in
`gfx-world.js` (dormant while the variants are `null`); Track A1 fills the arrays and never edits the world pass.

**Light model** (`gfx-light.js`): `createLight(config) → { enabled, at(wx,wy), tint(wx,wy), nearest(wx,wy), panelLevel(cx,cy,fs) }`.
Today a stub with `enabled:false` (⇒ legacy shading). Track A2 implements it; Track B lights sprites through `fs.light`
(and must treat `enabled === false` as "ambient 1").

**Quality tiers** (`gfx-quality.js`): `renderOpts.qualityTier` (`legacy|low|medium|high`, default `legacy`)
selects `fs.quality = { scale, texFilter (0 nearest|1 mip-mapped|2 mip-mapped + near-field 2-tap bilinear; `high` gets the 2-tap via lightDetail 2), lightDetail (0 legacy|1 pools+contact|2 +dynamic lights and
per-panel flicker), bloom (0|1), particles }`. Stages read these fields; they never hard-code a look. `--quality <tier>` in the harness.

**Sky** (`gfx-sky.js`): `renderSky(fs, buf32)` fills rows `0..HH` for outdoor levels; Track C owns it (clouds, haze, horizon).

**Comfort** (`gfx-quality.js`): `comfortFor(renderOpts)` + `effectiveFlicker(raw, comfort)`. The game always passes `maxGlobalDip 0.5` (`0.25` with
`reduceFlicker`); only a bare harness config is unclamped. The legacy tier's whole-frame blackout overlay is budgeted against that clamp
(`flickerOverlayAlpha`), so the combined factor (world x overlay) stays at or above `1 - maxGlobalDip`.

**Harness flags** added: `--quality <tier>`, `--reduce-flicker`.

### Level look data (optional; absent ⇒ today's look)
`config.look = { wall:'wallpaper|concrete|rust|metal|…', floor:'carpet|concrete|plate|gravel', ceil:'tiles|pipes|ducts|open',
lighting:{ mode:'panels|lamps|daylight', every, color, warmth, pool, ambient }, grade:{ tint, split, contrast }, post:{ bloom,
tape } }`. `levels.js` `levelConfig` must shallow-merge `look` (new top-level keys silently replace otherwise).

## Art direction (the target look)

Shared: heavy damp fog, light in *pools* with real dark between, contact shadows where surfaces meet, faint bloom around
emitters, subtle film grain. Nothing glossy or clean. Surfaces are worn, stained, slightly wrong.

- **L0 lobby** — mono-yellow damask wallpaper with water stains, seams, scuffed baseboard, outlets/vents as decals;
  matted carpet with wear paths; stained ceiling tiles (a few darker/missing); warm green-yellow fluorescent pools.
- **L1 habitable zone** — grey painted cinder block and concrete, stained slab floor, cold sodium-green light; industrial.
- **L2 pipe dreams** — rusted brown panels, exposed pipe/duct ceiling, sparse amber emergency lamps, rising steam.
- **L3 electrical station** — blue-black metal panels, cable trays, cabinet fronts, sparse cold lamps, blue-white arcs.
- **L∅ the block** — overcast daylight, drifting soft clouds, formstone/CMU/plywood/brick with real colour variation,
  gravel-and-weed ground, lit windows with warm curtained depth, cracked marble. Flat, photographic, unheroic.

Creatures keep their canon tells (smiler grin, watcher eyes, hound/crawler low, lurker tall, tesla electric outline,
`thin` translucent) and get: floor-anchoring, rim light from the nearest emitter, soft ground shadow, idle sway,
chase/flee/stagger animation states, distance dissolve into fog. Props get distinct art per type, per-instance variation
from `key`/`rot`, side shading, and floor-decal treatment where appropriate (`papers`, `trash`, `weeds`).

## Sprite architecture (so CPU and GL share it)

Sprites are authored as **pre-rasterised frames in an atlas** generated at startup (deterministic, seeded), not immediate
mode Canvas2D per frame. A frame = (kind, variant/type, state, animFrame, facing bucket). CPU path: blit column runs
where `zbuffer[col] > dist`, fogged toward the fog colour and lit by `fs`; GL path: instanced alpha-blended billboards
against the same depth. `game.js` must pass through the entity fields the art needs (prop `rot/key`, exit `target`, note
`frag`, enemy `state/dir/stagger`, remote-player `angle`, apparition `vx/vy`).

## Quality tiers

Defined in `gfx-quality.js` (see the contracts above): `legacy` (classic distance-fog shading, no light model), `low` (scale 0.5, light pools), `medium` (0.6, pools +
contact shading + mip-mapped textures), `high` (0.75, dynamic lights, bloom). `auto` adapts render scale from the **raw** frame time (not
the clamped `dt`), never below 0.4 or above 0.9, with a pixel budget cap when `devicePixelRatio > 1`. Animations become `dt`-based.

## Verification protocol (nothing else tests the renderer)

`tools/gfx/` (created in Phase 0): an Electron-driven harness that draws deterministic scenes straight to a canvas and
exports PNGs + frame timings. `node tools/gfx/run.mjs --src <path to a src/renderer dir> --out <dir>`; scenes are fixed
(seeded `Math.random`, fixed player poses, fixed frame counts). `compare.mjs <a> <b>` reports per-scene pixel mismatches.
- Pure refactors (Phase 0, the module split) must be **pixel-identical** (0 mismatches) and within +10% frame time. The `legacy`
  tier is *not* pixel-identical to the pre-overhaul renderer: it keeps the classic shading (linear distance fog x the flicker
  scalar, no light model, screen-space flashlight) but the level art (surfaces, sky, post) is new at every tier.
- Visual changes are judged by *looking at the PNGs* (agents can read images) against the art direction above.
- `bench` reports median/p95 `render()` ms per scene; budgets: `medium` ≤ 1.15× baseline on L0; nothing over 33 ms.
- Unit tests for every pure module (`gfx-light`, `gfx-quality`, texture determinism); `vitest run` must stay at
  279 passing + the one known unrelated failure.

## Work breakdown

**Phase 0 (sequential):** harness + baseline → refactor `renderer.js` into the module map above, pixel-identical.
**Phase 1 (parallel worktrees, disjoint file ownership, merged by the integrator):**
- A1 textures/surfaces (`gfx-textures.js`, `levels.js` look data) · A2 world pass + lighting (`gfx-world.js`, `gfx-light.js`)
- B sprites & creatures (`gfx-sprites.js` + the entity pass-through in `game.js`) · C post/atmosphere (`gfx-post.js`)
- D quality/photosensitivity/prefs/dt-based animation (`gfx-quality.js`, `prefs.js`, settings UI, flicker limiter)
- E HUD backing + title attract mode (`index.html`, a new `gfx-attract.js`)
**Phase 1.5:** integrate, adversarial visual + code + perf review, fix.
**M2:** `gfx-gl.js` + selector + capture + fallback + kill switch; on-device verification is the owner's (unverifiable from here).

## M2 design — the WebGL2 backend (written before M1 lands; refine after integration)

**Status:** the GPU backend is complete and opt-in (`renderer: 'gpu'` / `?renderer=gpu`); `auto` keeps choosing the CPU renderer
(`GPU_AUTO = false`) until the owner has measured it on real devices with the `?gfxbench=1` benchmark — the runbook and the exact criteria for
flipping `GPU_AUTO` are in `docs/gfx-device-testing.md` (see "Device testing" at the end of this section). The design below is what was built.

**Principle: keep the CPU as the source of truth for the world; put only shading on the GPU.** `castRay` and the chunk cache
(`isWall`, which generates chunks as a side effect) keep running on the CPU exactly as today, so maze parity, collision,
chunk streaming and determinism cannot drift. Per frame the CPU fills one row of per-column hit data (`dist, wallX, mx, my,
side` as RGBA32F, W ≤ ~1920 texels) — about the 1.7 ms wall pass the benchmarks already show — and uploads it. The GPU then
shades every pixel: floor, ceiling, walls, sky, sprites, light, post. Nothing about the map is uploaded (no 66x66 grid, no
shader DDA), which also removes the "GPU raycaster disagrees with the CPU one" class of bug.

**Backend shape.** `gfx-gl.js` exports `createGlRenderer(canvas, config, renderOpts, worldHooks)` returning the same object
as the CPU path (`{ render, kind: 'gpu', capture(), dispose() }`). `renderer.js` calls `pickRenderer(env)` (Track D,
pure) and wraps GL creation in try/catch: any failure, shader/link error, `webglcontextlost`, or sustained slow frames
swaps `level.gfx` to the CPU renderer in place — the CPU renderer is always the fallback, never software GL.
Probe on a throwaway canvas with `failIfMajorPerformanceCaveat:true`; treat SwiftShader/llvmpipe/"software" in
`WEBGL_debug_renderer_info` as "no GPU".

**Canvases.** A sibling `<canvas>` for GL over `#c` with `pointer-events:none` (pointer lock and clicks still hit `#c`;
`#c` keeps its untouched 2D context so CPU fallback is instant — a canvas that ever produced a 2D context can never return
WebGL). A transparent 2D overlay canvas carries nameplates, speech bubbles and the crosshair (crisp text). The shake
transform (`canvas.style.transform`) moves to a wrapper element.

**Data on the GPU.** TexSet tiles → a mipmapped `TEXTURE_2D_ARRAY` (walls, materials, variants, floor/ceil variants, panel
tile); mipmaps + anisotropic filtering fix the distant shimmer that nearest sampling cannot. Light: the periodic panel pool
is analytic in the shader; the lamp lightmap window is a small RGBA8 texture rebuilt when the player changes cell (same
function as the CPU model — one source of truth in `gfx-light.js`). Sprite atlas (Track B's pre-rasterised frames, RGBA)
→ one texture; sprites are instanced billboards alpha-blended, depth-tested in the fragment shader against the per-column
hit distance texture (so occlusion is exact per pixel and identical in spirit to the CPU column test). Palette, fog,
flicker, `fs.t`, per-level look → uniforms.

**Post on the GPU.** Fixed pipeline of small passes: scene → bright-pass + separable blur chain (bloom) → composite with
grade, vignette, luma grain, optional tape. Flashlight/glow are real lights in the scene shader (no gradient overlay).
Internal resolution is `renderScale x canvas x min(dpr, cap)` under a pixel budget; the adaptive controller (Track D) drives it.

**Capture.** The Polaroid needs pixels: `capture()` re-renders the last frame synchronously and calls `toDataURL` in the same
task (the WebGL drawing buffer is valid until the frame is composited), replacing `game.js`'s direct `canvas.toDataURL`.

**Kill switch and rollback.** Pref `renderer: auto|gpu|cpu`, URL `?renderer=cpu`, a crash-loop marker in localStorage written
before the first GL frame and cleared after N healthy frames, and a runtime downgrade path. The PWA is cache-first with a
fixed cache name and a hand-maintained gh-pages copy, so a bad GL build sticks until the cache constants are bumped in BOTH
places — ship the kill switch in the very first GL build.

**Testing without the owner's devices.** With hardware acceleration off Electron/Chromium runs WebGL on SwiftShader, so the
harness can render the GL path headlessly here: GL output is not byte-comparable to the CPU renderer, so parity is checked
with a perceptual tolerance (mean and 99th-percentile channel delta per scene) plus looking at the PNGs; pure parts (uniform
packing, hit-row packing, sprite instance building, pickRenderer) are unit-tested in Node. **Real frame times on
Chromebooks and phones can only be measured by the owner** — the report must say so plainly and leave `renderer: auto`
conservative (GPU only when the probe is clean and a short in-game timing window beats the CPU path).


### Status and tooling (core, integration, validation — builder G4)

**What runs today.** `renderer.js` is `createRendererWith(deps)` (injectable, unit-tested with fakes) and `createRenderer = createRendererWith()`. `auto` is
still CPU (`GPU_AUTO = false`); `renderer: 'gpu'` (pref) or `?renderer=gpu` picks the GL backend, `renderer: 'cpu'` / `?renderer=cpu` never does, and
the title's `#attract` canvas is always CPU. `allowSoftwareGl` exists only in the options object (harness / page tooling), never a pref or a URL.
Every failure swaps to the CPU in place and is remembered:

| failure | when | remembered |
| --- | --- | --- |
| no usable GPU (probe: no WebGL2 / software GL; `GpuUnavailable`: no GPU context, software renderer string) | `createRenderer` | **session only** |
| creation (shader/link/framebuffer, pass init) | `createRenderer` | this session **and** the persisted crash marker (24 h) |
| GL error in the first 3 frames, any `render()` throw (incl. a lazily collected program failing inside the validation frame: `info.validation` = `'error'`, not `'failed'`), first-frame validation mismatch | `render` | session + persisted marker |
| lost context (`webglcontextlost` or `isContextLost()`) | next `render` | **session only** — never rebuilt, `webglcontextrestored` is ignored |
| sustained slow frames (health monitor) | `noteFrame` | session only |

`game.js` disposes the previous level's renderer **before** creating the next (a GPU renderer owns a WebGL context; browsers cap ~16), routes the
Polaroid through `gfx.capture()` (null when the GPU frame could not be read; the renderer has then swapped to the CPU), passes `renderOpts.renderer`
(and rebuilds the current level's renderer live when the pref changes), feeds the health monitor the real rAF interval, and logs one console line per
level (`[renderer] kind=… why=… gpu=… validation=…`). The GL canvas is a `position:fixed`, `pointer-events:none` sibling right after `#c`; it mirrors
`#c`'s backing size, css box and shake transform every frame (`siblingLayout`), sits below every HUD element, and is removed on dispose (a 40-cycle
create/draw/dispose harness run leaves 0 canvases and 0 "too many contexts" warnings). A crash-loop marker armed by a renderer that is disposed before
its healthy frames (a level change) is handed back to its previous state — only a page that dies leaves it armed.

**First-frame validation** (`gfx-gl-g4-validate.js`): on frame 4 the GPU frame is read back and compared with a throwaway CPU render of the same frame
(own offscreen canvas, at most 480 px wide, no grain/particles/crosshair, disposed at once; the memoised CPU textures are dropped if the reference
built them). Both are reduced to a 32x18 grid of mean colours and `compareFrames` fails on: a per-channel mean difference above 0.14, a mean absolute
block difference above 0.16, or (when the CPU frame has structure, luminance std >= 0.02) a flat GPU frame or a block-luminance correlation below 0.45.
Calibration, measured in the harness (960x540, 7 scenes): the **same** scene at CPU tier `low` vs `high` differs by block 0.002 / correlation 0.998;
CPU `legacy` vs `high` (a deliberately different look, i.e. far more than a GPU/CPU rounding difference) by block 0.05-0.09 / correlation 0.52-0.92
and passes; unit tests show black, garbage, a vertical flip, a channel swap, a flat frame and NaN all failing. The phase-0 flat-colour world pass
fails it (mean colour 0.64 vs 0.50), as it should. A pass is cached in localStorage per `UNMASKED_RENDERER + GPU_BUILD_ID` (bump `GPU_BUILD_ID` in that
file when the shaders change enough to need a re-check); on the harness's software GL it is off unless `gpuValidate: true`.

**Health monitor** (`createGpuHealth`, `shouldDowngradeGpu` in `gfx-quality.js`): frame intervals above 2x the budget for two consecutive 3 s windows
(after a 3 s warm-up; stalls over 1 s ignored) **while the adaptive resolution is at its floor**, only from an explicit `auto`/`gpu` choice. Whether the
CPU would be faster is not knowable, so it is deliberately conservative; the downgrade lasts for the session.

**Tools** (`tools/gfx/`, all use a throwaway profile so no stale crash marker leaks between runs):
- `run.mjs ... --ropts '{"renderer":"gpu","allowSoftwareGl":true}'` renders the GPU path on SwiftShader; the manifest records which backend drew each
  scene, and a scene that silently fell back to the CPU **fails the run** (unless `--allow-fallback`). `--stress N` runs N create/draw/dispose cycles.
- `page.cjs --ropts '{"allowSoftwareGl":true}' --prefs '{"renderer":"gpu"}'` boots the real game page on the GL path (`globalThis.__backroomsRenderOpts`
  is merged into `renderOpts`; `__failGl: 'create'|'frame'|'frame:N'|'lost'|'validate'` forces the fallbacks; `--visible` lets the rAF loop run).
- `parity.mjs` — `node tools/gfx/parity.mjs --src src/renderer --out tools/gfx/out/parity --scenes l0-corridor,l0-room --quality medium[,low,high]`:
  renders CPU and GPU, writes `<tier>/<scene>.side.png` (CPU | GPU | 4x amplified difference) and `parity.json` with per-scene mean absolute channel
  difference, p99 of the per-pixel difference, the fraction of pixels over `--thresh`, mean colours of both frames and the validation's block metric;
  exits 1 above `--max-mean 0.08 / --max-p99 0.40 / --max-over 0.30` or when a scene was not drawn by the GPU. Use `--no-fail` while the passes are built.

### Device testing, diagnostics and level starts (track HC)

The owner's devices decide `GPU_AUTO`; these make that test short, conclusive and safe (runbook: `docs/gfx-device-testing.md`):

- **`?gfxbench=1`** (`gfx-bench.js`): index.html enters it instead of the title and the game (no save read, no pref written, no audio). Five fixed
  views of the seed-0 world (L0 corridor and room, L2 pipes, L3 station, the ∅ yard; real chunks, decor and still creatures) along a smooth camera
  path (gentler under prefers-reduced-motion; fades through black between views; the level's flicker through the rate-limited machine with
  reduceFlicker on), ~2 s each under CPU low/medium/high and GPU medium/high, full-window on rAF. Per configuration: the real frame interval
  p50/p95/p99 and % over 33 ms, render() p50/p95, the start cost (renderer creation + the worst warm-up frame), the internal size, the validation.
  A verdict line, five GPU_AUTO checks (hardware GPU, both GPU configs ok, validation passed, 0 fallbacks, GPU medium not slower than CPU medium)
  and a Copy button (plain text). Only the GPU crash marker is touched: armed by each GPU start as in the game, then put back exactly as the run
  found it (`createMarkerGuard`), unless one of the run's own GPU starts failed persistently, which stays recorded; the validation result
  stays in memory. The camera path is the gentle one under prefers-reduced-motion OR the stored Reduce flicker pref (read only).
  On this machine's Intel Iris Plus (hardware, under heavy load from other agents): GPU high p95 17.4 ms / 0% over 33 ms vs CPU medium 33.8 ms /
  17% — "GPU high is 1.9x faster than CPU medium", all five checks pass. On SwiftShader it reports "software" and fails the checks, as it should.
- **`?gfxstats=1`** (`gfx-stats.js`): a small aria-hidden panel (desktop: top-right under the gear; portrait phone: in the HUD cluster's flow,
  with #msg kept below it; short screens: at the top between the cluster and the touch column — `STATS_CSS`), refreshed twice a second: kind / why / fallbacks, the GPU name
  and validation, tier / scale / canvas / dpr, frame interval and render() p50/p95, the last level start's cost. Created only by the URL parameter.
- **Validation fix:** both renderers build sprite frames lazily under a ~9 ms per-call budget, so the first synthetic validation frame of either side
  could lack a sprite and fail a healthy GPU (it did, on the real Iris Plus at the ∅ spawn: worst block 0.125 > 0.09, the note's glow missing from
  the CPU reference). `settleFrame` now draws each side until two consecutive pictures are identical (≤ 6 draws): worst block 0.031 there.
- **Level starts** (`tools/gfx/levelstart.mjs --gpu`, 1280x720, cold, loaded machine): CPU create 50-450 ms and first frame 20-310 ms per level
  (ready 0.2-0.9 s); GPU (Iris Plus) the first level ~0.85-1.1 s to create (context, shaders, uploads) plus ~0.4-0.5 s of first-frame validation
  on its 4th render (once per device + build), later levels 0.15-0.6 s. A level change now keeps `#fade` black until the new level has drawn 5
  frames (or 1.5 s), so these costs land under the black instead of stuttering the fade-in; the transition (frozen movement, events, contact
  damage) ends 150 ms after the veil lifts, and fades are sequenced (`createFader` in game.js: a stale reveal never lifts a newer fade). The game's FIRST level (boot, no fade) still shows its
  first frames as they come: the validation hitch is visible there once per device + build.
- **game.js CPU costs:** the per-frame sprite list is assembled from pooled records (same fields, values and order; tested against the old code):
  ~48 KB → ~5 KB of garbage per frame on L0 (68 → 8 KB on L2; what is left is the decor/items getters' arrays), 2-3x faster assembly; resize,
  orientationchange and devicePixelRatio changes are coalesced to one layout per animation frame.
