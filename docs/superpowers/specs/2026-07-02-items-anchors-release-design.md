# Items, Anchors & Release Finish — Design Spec
*2026-07-02*

Autonomous session: user asked for novel features, an auto-update option, items + inventory,
a Google Maps tie-in, and the release finished on GitHub. Auto-update (toggle in settings,
`electron-updater`, restart-on-demand) already shipped in `fc2e5d6` — it just has no release
to update from yet. This spec covers everything else.

---

## 1. Release pipeline fixes (v1.0.0 → v1.1.0 actually ships)

**Diagnosed failures:**

| Problem | Fix |
|---|---|
| `win.certificateFile: "${env.CSC_LINK}"` in package.json is treated literally — signing dies with `open ${env.CSC_LINK}` | Delete `certificateFile`/`certificatePassword`; electron-builder natively reads `CSC_LINK`/`CSC_KEY_PASSWORD` env vars (secrets are set on the repo) |
| `author` missing warning | `"author": "Corner Spore"` |
| `wish-grant.yml` invalid YAML (line 90) — multiline `--body "..."` string has lines at column 0, terminating the `run: \|` block scalar → every push shows a 0s failed run | Build the PR body with `printf` into a `BODY` var |
| "Upload server" step uses bash syntax on windows-latest (pwsh default shell) and resolves the release from `github.ref_name` (= `main`, not a tag) | `shell: bash`; derive `TAG="v$(node -p require('./package.json').version)"` |
| electron-builder publishes a **draft** release by default; electron-updater ignores drafts and `releases/tags/` can't see them | `"publish": { ..., "releaseType": "release" }` |
| `build/icon.ico` is a 1×1 placeholder — electron-builder requires ≥256×256 | Generate a real 256×256 Backrooms-styled icon (PNG-compressed ICO) via script |
| Packaged `files` list omits `server/**` but main.js `import('../server/index.js')` powers the HOST button; `ws` is devDependency-only | Add `server/**/*` to files (excluding its lockfiles is unnecessary), move `ws` to `dependencies` |
| Node 20 deprecation warnings on runners | `node-version: '22'` |

Version bumps to **1.1.0**; push to main triggers Build & Release; success = published GitHub
release with `The Backrooms Setup 1.1.0.exe`, `latest.yml`, `*.blockmap`, `backrooms-server.js`.

---

## 2. Items & inventory

New module `src/renderer/items.js` — pure logic, DOM-free, fully unit-testable.
Effects are *applied* in game.js; items.js only owns state.

**Spawning.** Deterministic, chunk-seeded like entities: `hash(cx+7777, cy+9999) % density === 0`
(density from `world.json > items.density`, default 5 → ~1 item per 5 chunks). Item type picked by
seeded hash from `items.types`. Position: up to 20 seeded random cells in the chunk, first open
(non-wall) cell wins. One item max per chunk. A picked-up item never respawns during the session
(`taken` set keyed `cx,cy`) — but when the world forgets an evicted chunk, its item may return.
The Backrooms restocks itself.

**Item types & effects:**

| Item | Use | Effect |
|---|---|---|
| almond water | consumed | stamina → full; lights steady (flicker suppressed 20 s) |
| glowstick | consumed | fog distance ×1.6 for 45 s |
| polaroid | consumed | captures the current frame → PNG saved to `Pictures/backrooms/` via IPC; white flash |
| radio | toggle | eerie music-box loop; presences detectable from much farther, but stalkers aggro from 1.5× range |

**Inventory.** 6 slots, no stacking. Hotbar UI bottom-center (faded monospace, same aesthetic).
`F` picks up the nearest item within 1.4 cells (E stays reserved for presences),
`1–6` selects, `Q` uses selected. Full inventory → "your hands are full."

**Rendering.** Items ride the existing billboard sprite pass as small, floor-anchored,
per-type-colored sprites (pale blue = almond water, green = glowstick, off-white = polaroid,
rust = radio) with a faint bright core so they read against the fog.

**world.json** gains `"items": { "density": 5, "types": [...] }` — wishes can now drift item
scarcity and mix.

---

## 3. Google Maps anchors — "no-clip from a real place"

New module `src/renderer/anchor.js`, pure + unit-testable:

- `parseAnchor(text)` — accepts a pasted Google Maps URL (`@lat,lng`, `q=lat,lng`, `!3d…!4d…`)
  or a bare `lat, lng` pair → `{lat, lng}` (validated ranges) or `null`.
- `anchorSeed(lat, lng)` — 32-bit hash of coords rounded to 4 dp, never 0. Same place ⇒ same maze,
  for everyone.
- `driftMeters(player, spawn)` — 1 grid cell = 2 m.
- `bodyUrl(anchor)` — `https://www.google.com/maps/search/?api=1&query=lat,lng`.

**UX.** Start screen gets one optional input: *"anchor — paste a google maps link (optional)"*.
Works for SOLO (seed = anchorSeed) and HOST (client sends the seed with `join`; server uses it
when creating the room — first joiner wins). HUD gains a second line:
`anchor 35.0168,-80.5901 · drift 132m`. When anchored, occasional bespoke message:
*"your body remains at {lat}, {lng}."* Settings modal gains **locate your body** — opens Google
Maps at the anchor in the external browser through a main-process IPC handler that only allows
`https://www.google.com/maps` URLs.

Anchored worlds use the fixed-seed chunk cache (no epoch drift): anchored places hold their shape.

---

## 4. Sprint & stamina (makes almond water matter)

`Shift` sprints at 1.8× while stamina (0–100) drains 22/s; regen 9/s while not sprinting;
at 0 you walk. Thin HUD stamina bar, only visible when < 100. Almond water restores it fully.

---

## 5. Server change (minimal)

`join` message accepts optional numeric `worldSeed`; used only when the room is being created.
Covered by a server unit test.

## 6. Out of scope

Item drop/placement, stacking, geocoding of place names (needs an API key), Mac builds,
wish-grant end-to-end test (needs a live labeled issue).
