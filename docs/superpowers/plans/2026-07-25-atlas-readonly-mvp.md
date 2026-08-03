# Read-Only Atlas Map (MVP) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A public web page that renders hand-authored **genesis** beacons on a dark slippy map, each clickable to read its strata archive — the disclosure-safe first slice of the Beacon Atlas.

**Architecture:** Static site content on the **`gh-pages`** branch (same as the existing landing page — no build step). A tiny pure ES module (`atlas-core.mjs`) owns all data validation and display logic and is unit-tested under plain `node`; the view (`atlas/index.html`) owns the Leaflet map and DOM. Beacon data is a static `beacons.json` whose shape is exactly what the future Worker read-API will serve, so the front-end never changes when the backend arrives.

**Tech Stack:** Static HTML/CSS/ES-modules on GitHub Pages; Leaflet 1.9.4 (vendored locally); CARTO dark basemap tiles (external, attributed); `node` for the standalone self-test. No package manager, no bundler, no framework.

## Global Constraints

- **Branch:** all work happens on a branch off **`gh-pages`** (e.g. `atlas-mvp`), merged to `gh-pages` only in the final task. `gh-pages` auto-deploys on push, so never push half-built work to it directly.
- **No build step, no framework, no package.json.** Files are served as-authored, matching the existing `index.html`. The self-test runs with `node atlas/atlas-core.test.mjs` (ESM via `.mjs`, no config).
- **Self-contained except map tiles.** Vendor Leaflet locally (no CDN at runtime); the only permitted external runtime request is basemap tiles from CARTO, which must carry attribution `© OpenStreetMap contributors © CARTO`.
- **Disclosure boundary:** genesis beacons only, hand-authored. **No** placement mechanism, no accumulation, no coordinates derived from any player — nothing from the private placement-engine spec appears here.
- **Public-landmark / safety rule:** a beacon that invites a physical visit (`sealed: false`) must be a genuine **public landmark**, never a residential or condemned structure. **806 N Carey is `sealed: true`** — shown for its lore, explicitly **not** a check-in/travel target (its real doors are masoned shut; you "enter through the gap the paperwork left," i.e. the game). See the note under the plan.
- **Aesthetic:** reuse the landing page's palette and voice — `--y:#c9ba72` (genesis gold), `--sig:#8fdcac` (organic/surfaced green), `--rust:#a05a3a` (sealed), `--bg:#050403`, mono/serif type, grain/scan/vignette overlays, lowercase in-world copy.
- **Data shape is the API contract:** `{ version, beacons: [ { id, kind, sealed?, name, subtitle?, lat, lng, blurb?, strata: [ { tier, ts, fragment } ] } ] }`. `kind ∈ {"genesis","organic"}`, `tier ∈ {"deep","faint"}`, `ts` is an ISO date string.

## File Structure

| File | Responsibility |
|---|---|
| `atlas/atlas-core.mjs` (new) | Pure, DOM-free, network-free logic: validate beacon data, order strata, marker style, stratum labels. Runs in `node` and in the browser. |
| `atlas/atlas-core.test.mjs` (new) | Standalone `node` self-test for `atlas-core.mjs` + validation of the real `beacons.json`. |
| `atlas/beacons.json` (new) | Genesis beacon data (806 N Carey, sealed). The static stand-in for the future read-API. |
| `atlas/vendor/leaflet.js`, `atlas/vendor/leaflet.css` (new) | Vendored Leaflet 1.9.4. |
| `atlas/index.html` (new) | The map page: aesthetic shell, Leaflet map, markers, strata panel. |
| `index.html` (modify) | Add a link to `/atlas/` from the landing page. |

---

### Task 1: Pure core module (`atlas-core.mjs`)

**Files:**
- Create: `atlas/atlas-core.mjs`
- Test: `atlas/atlas-core.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces (later tasks and the view import these exact names):
  - `validateStratum(s): {ok: boolean, error?: string}`
  - `validateBeacon(b): {ok: boolean, error?: string}`
  - `validateBeaconSet(doc): {ok: boolean, error: string|null, count: number}`
  - `orderStrata(strata): Stratum[]` — newest-first, deterministic, non-mutating
  - `beaconStyle(beacon): {color: string, label: string, className: string}`
  - `stratumLabel(stratum, indexFromTop): string`
  - constants `BEACON_KINDS`, `STRATUM_TIERS`

- [ ] **Step 1: Write the failing test**

Create `atlas/atlas-core.test.mjs`:

```js
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  validateStratum, validateBeacon, validateBeaconSet,
  orderStrata, beaconStyle, stratumLabel,
} from './atlas-core.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
let pass = 0, fail = 0
const check = (name, ok) => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`) }
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)

// validateStratum
check('stratum ok',            validateStratum({ tier: 'deep', ts: '2026-07-25T00:00:00Z', fragment: 'x' }).ok)
check('stratum bad tier',     !validateStratum({ tier: 'nope', ts: '2026-07-25', fragment: 'x' }).ok)
check('stratum bad ts',       !validateStratum({ tier: 'deep', ts: 'not-a-date', fragment: 'x' }).ok)
check('stratum empty fragment', !validateStratum({ tier: 'deep', ts: '2026-07-25', fragment: '' }).ok)

// validateBeacon
const good = { id: 'x', kind: 'genesis', name: 'X', lat: 39.3, lng: -76.6, strata: [] }
check('beacon ok',            validateBeacon(good).ok)
check('beacon bad kind',     !validateBeacon({ ...good, kind: 'zzz' }).ok)
check('beacon lat range',    !validateBeacon({ ...good, lat: 200 }).ok)
check('beacon lng range',    !validateBeacon({ ...good, lng: 999 }).ok)
check('beacon sealed type',  !validateBeacon({ ...good, sealed: 'yes' }).ok)
check('beacon subtitle type',!validateBeacon({ ...good, subtitle: 5 }).ok)
check('beacon missing name', !validateBeacon({ ...good, name: '' }).ok)
check('beacon strata !array',!validateBeacon({ ...good, strata: 'no' }).ok)

// validateBeaconSet
check('set ok',    validateBeaconSet({ beacons: [good] }).ok)
check('set count', validateBeaconSet({ beacons: [good] }).count === 1)
check('set dup id',!validateBeaconSet({ beacons: [good, { ...good }] }).ok)
check('set !doc',  !validateBeaconSet([]).ok)

// orderStrata — newest first, non-mutating, deterministic tie-break
const s1 = { tier: 'deep',  ts: '2026-01-01T00:00:00Z', fragment: 'a' }
const s2 = { tier: 'faint', ts: '2026-06-01T00:00:00Z', fragment: 'b' }
const ordered = orderStrata([s1, s2])
check('orderStrata newest first', ordered[0].fragment === 'b' && ordered[1].fragment === 'a')
check('orderStrata no mutate',    eq([s1, s2].map(s => s.fragment), ['a', 'b']))

// beaconStyle
check('style genesis gold',  beaconStyle({ kind: 'genesis' }).color === '#c9ba72')
check('style organic green', beaconStyle({ kind: 'organic' }).color === '#8fdcac')
check('style sealed rust',   beaconStyle({ kind: 'genesis', sealed: true }).color === '#a05a3a')

// stratumLabel
check('stratum label', stratumLabel({ tier: 'deep', ts: '2026-07-25T12:00:00Z', fragment: 'x' }, 0)
                        === 'layer 001 · deep · 2026-07-25')

// the real shipped data validates
const doc = JSON.parse(readFileSync(join(HERE, 'beacons.json'), 'utf8'))
check('beacons.json validates', validateBeaconSet(doc).ok)

console.log(`\n${pass}/${pass + fail} passed`)
process.exit(fail ? 1 : 0)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node atlas/atlas-core.test.mjs`
Expected: FAIL — `Cannot find module ... atlas-core.mjs` (module does not exist yet). The `beacons.json` line also cannot run yet; that is fine — the run errors before the counts print.

- [ ] **Step 3: Write minimal implementation**

Create `atlas/atlas-core.mjs`:

```js
// atlas-core.mjs — pure helpers for the Atlas map.
// No DOM, no Leaflet, no network: runs under plain `node` for tests and imports
// as an ES module in the browser. The view (index.html) owns the map + DOM.

export const BEACON_KINDS = ['genesis', 'organic']
export const STRATUM_TIERS = ['deep', 'faint']

export function validateStratum(s) {
  if (s == null || typeof s !== 'object') return { ok: false, error: 'stratum is not an object' }
  if (!STRATUM_TIERS.includes(s.tier)) return { ok: false, error: `tier must be one of ${STRATUM_TIERS.join('|')}` }
  if (typeof s.ts !== 'string' || Number.isNaN(Date.parse(s.ts))) return { ok: false, error: 'ts must be an ISO date string' }
  if (typeof s.fragment !== 'string' || !s.fragment) return { ok: false, error: 'fragment must be a non-empty string' }
  return { ok: true }
}

export function validateBeacon(b) {
  if (b == null || typeof b !== 'object') return { ok: false, error: 'beacon is not an object' }
  if (typeof b.id !== 'string' || !b.id) return { ok: false, error: 'beacon.id must be a non-empty string' }
  if (!BEACON_KINDS.includes(b.kind)) return { ok: false, error: `beacon ${b.id}: kind must be one of ${BEACON_KINDS.join('|')}` }
  if (typeof b.name !== 'string' || !b.name) return { ok: false, error: `beacon ${b.id}: name must be a non-empty string` }
  if (typeof b.lat !== 'number' || b.lat < -90 || b.lat > 90) return { ok: false, error: `beacon ${b.id}: lat out of range` }
  if (typeof b.lng !== 'number' || b.lng < -180 || b.lng > 180) return { ok: false, error: `beacon ${b.id}: lng out of range` }
  if (b.sealed !== undefined && typeof b.sealed !== 'boolean') return { ok: false, error: `beacon ${b.id}: sealed must be boolean` }
  if (b.subtitle !== undefined && typeof b.subtitle !== 'string') return { ok: false, error: `beacon ${b.id}: subtitle must be a string` }
  if (b.blurb !== undefined && typeof b.blurb !== 'string') return { ok: false, error: `beacon ${b.id}: blurb must be a string` }
  const strata = b.strata ?? []
  if (!Array.isArray(strata)) return { ok: false, error: `beacon ${b.id}: strata must be an array` }
  for (let i = 0; i < strata.length; i++) {
    const e = validateStratum(strata[i])
    if (!e.ok) return { ok: false, error: `beacon ${b.id} strata[${i}]: ${e.error}` }
  }
  return { ok: true }
}

export function validateBeaconSet(doc) {
  if (doc == null || typeof doc !== 'object' || !Array.isArray(doc.beacons)) {
    return { ok: false, error: 'document must be { beacons: [...] }', count: 0 }
  }
  const seen = new Set()
  for (const b of doc.beacons) {
    const e = validateBeacon(b)
    if (!e.ok) return { ok: false, error: e.error, count: 0 }
    if (seen.has(b.id)) return { ok: false, error: `duplicate beacon id: ${b.id}`, count: 0 }
    seen.add(b.id)
  }
  return { ok: true, error: null, count: doc.beacons.length }
}

// Read "down through the layers": newest first (top layer = most recent), with a
// stable fragment tie-break so equal timestamps order deterministically. Copies.
export function orderStrata(strata) {
  return [...(strata ?? [])].sort((a, b) => {
    const t = Date.parse(b.ts) - Date.parse(a.ts)
    return t !== 0 ? t : a.fragment.localeCompare(b.fragment)
  })
}

// Marker style: sealed=rust, genesis=gold, organic=signal-green.
export function beaconStyle(beacon) {
  if (beacon.sealed) return { color: '#a05a3a', label: 'sealed', className: 'b-sealed' }
  if (beacon.kind === 'genesis') return { color: '#c9ba72', label: 'genesis', className: 'b-genesis' }
  return { color: '#8fdcac', label: 'surfaced', className: 'b-organic' }
}

// One line per stratum in the archive list: "layer 001 · deep · 2026-07-25".
export function stratumLabel(stratum, indexFromTop) {
  const n = String(indexFromTop + 1).padStart(3, '0')
  return `layer ${n} · ${stratum.tier} · ${stratum.ts.slice(0, 10)}`
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node atlas/atlas-core.test.mjs`
Expected: the `beacons.json validates` line will FAIL (file not created until Task 2); **every other check passes.** That single failure is expected here and is closed by Task 2. Confirm the output shows only that one FAIL.

- [ ] **Step 5: Commit**

```bash
git add atlas/atlas-core.mjs atlas/atlas-core.test.mjs
git commit -m "feat(atlas): pure core — beacon validation, strata ordering, styles"
```

---

### Task 2: Genesis beacon data (`beacons.json`)

**Files:**
- Create: `atlas/beacons.json`
- Test: `atlas/atlas-core.test.mjs` (extend)

**Interfaces:**
- Consumes: `validateBeaconSet` (Task 1).
- Produces: the static `beacons.json` document the view (Task 3) fetches.

- [ ] **Step 1: Write the failing test**

Append these two checks to `atlas/atlas-core.test.mjs`, immediately after the existing `beacons.json validates` line:

```js
check('beacons.json has 806 sealed genesis',
  doc.beacons.some(b => b.id === '806-n-carey' && b.sealed === true && b.kind === 'genesis'))
check('beacons.json every sealed beacon has strata',
  doc.beacons.filter(b => b.sealed).every(b => Array.isArray(b.strata) && b.strata.length > 0))
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node atlas/atlas-core.test.mjs`
Expected: FAIL on `beacons.json validates` / `has 806 sealed genesis` — the file does not exist yet, so `readFileSync` throws (or, if a stub exists, the id check fails).

- [ ] **Step 3: Write the data**

Create `atlas/beacons.json`:

```json
{
  "version": 1,
  "beacons": [
    {
      "id": "806-n-carey",
      "kind": "genesis",
      "sealed": true,
      "name": "806 N Carey Street",
      "subtitle": "Harlem Park · notice 30150A · EXTENSION",
      "lat": 39.2966,
      "lng": -76.6414,
      "blurb": "the first door. sealed by the city with concrete block behind its original frame — a masoned door does not open. you do not enter here. you enter through the gap the paperwork left.",
      "strata": [
        { "tier": "faint", "ts": "2025-11-08T00:00:00Z", "fragment": "still — EXTENSION. twenty-one years. the notice never resolves. it is extended, indefinitely." },
        { "tier": "deep",  "ts": "2004-11-08T00:00:00Z", "fragment": "2004 — the notice. 30150A: condemned as unsafe for occupancy; the public is warned to keep away." },
        { "tier": "deep",  "ts": "1961-01-01T00:00:00Z", "fragment": "1961 — the plan. the inside of the block is cleared; woodyear and vincent streets erased, leaving inner-block parks no one asked to keep." },
        { "tier": "deep",  "ts": "1937-01-01T00:00:00Z", "fragment": "1937 — the map. a federal residential security map rings black west baltimore in red and stamps it D, 'hazardous.' not one building was inspected. the hazard it scored was the people." }
      ]
    }
  ]
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node atlas/atlas-core.test.mjs`
Expected: PASS — `N/N passed`, with all `beacons.json` checks green (this also closes the one expected failure left over from Task 1).

- [ ] **Step 5: Commit**

```bash
git add atlas/beacons.json atlas/atlas-core.test.mjs
git commit -m "feat(atlas): genesis beacon data — 806 N Carey (sealed)"
```

---

### Task 3: The map page — vendor Leaflet + render markers

**Files:**
- Create: `atlas/vendor/leaflet.js`, `atlas/vendor/leaflet.css`, `atlas/index.html`
- Test: manual browser verification (static site; no unit harness — matches the existing `index.html`). The pure logic it relies on is already covered by Task 1.

**Interfaces:**
- Consumes: `beacons.json` (Task 2); `validateBeaconSet`, `beaconStyle` (Task 1); Leaflet global `L`.
- Produces: `window`-level nothing; a rendered map. Task 4 adds the click→panel behavior to this same file.

- [ ] **Step 1: Vendor Leaflet 1.9.4**

Run (from the repo root, on the `atlas-mvp` branch):

```bash
mkdir -p atlas/vendor
curl -fsSL https://unpkg.com/leaflet@1.9.4/dist/leaflet.js  -o atlas/vendor/leaflet.js
curl -fsSL https://unpkg.com/leaflet@1.9.4/dist/leaflet.css -o atlas/vendor/leaflet.css
```

Verify: `head -c 80 atlas/vendor/leaflet.js` shows the Leaflet banner containing `Leaflet 1.9.4`. (Only these two files are needed — the map uses `L.circleMarker`, which requires no marker-image assets.)

- [ ] **Step 2: Create the page**

Create `atlas/index.html`:

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>THE ATLAS — surfaced doors</title>
<meta name="description" content="A live registry of doors that have surfaced in the world.">
<link rel="stylesheet" href="vendor/leaflet.css">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Crect width='100' height='100' fill='%23c9ba72'/%3E%3Crect x='38' y='20' width='24' height='6' fill='%23fff'/%3E%3C/svg%3E">
<style>
  :root{ --y:#c9ba72; --yb:#e7dc93; --dim:#8a7f52; --faint:#5c5636; --bg:#050403;
    --rust:#a05a3a; --sig:#8fdcac; --sigb:#bff3d4; --ink:#020201;
    --mono:"Courier New",ui-monospace,monospace; --serif:Georgia,"Times New Roman",serif; }
  *{margin:0;padding:0;box-sizing:border-box}
  html,body{height:100%}
  body{background:var(--bg);color:var(--y);font-family:var(--mono);overflow:hidden}
  #map{position:absolute;inset:0;background:#040302;z-index:1}
  .leaflet-container{background:#040302}
  .vignette{position:fixed;inset:0;pointer-events:none;z-index:400;
    background:radial-gradient(ellipse at 50% 42%,transparent 45%,rgba(0,0,0,.5) 100%)}
  .scan{position:fixed;inset:0;pointer-events:none;z-index:401;opacity:.25;
    background:repeating-linear-gradient(to bottom,transparent 0 3px,rgba(0,0,0,.18) 3px 4px)}
  .topbar{position:fixed;top:0;left:0;right:0;z-index:410;display:flex;justify-content:space-between;
    align-items:center;padding:14px 20px;background:linear-gradient(to bottom,rgba(4,3,2,.9),transparent);
    font-size:10px;letter-spacing:2px;color:var(--faint);text-transform:uppercase}
  .topbar .home{color:var(--dim)} .topbar .home:hover{color:var(--y)}
  .title{font-family:var(--serif);letter-spacing:.3em;color:var(--y);font-size:15px}
  .legend{position:fixed;left:20px;bottom:18px;z-index:410;font-size:10px;letter-spacing:1px;
    color:var(--faint);line-height:1.9}
  .legend .dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px;vertical-align:middle}
  a{color:var(--yb);text-decoration:none}
  .err{position:fixed;inset:0;z-index:420;display:none;place-items:center;text-align:center;
    background:rgba(4,3,2,.85);color:var(--rust);font-size:13px;letter-spacing:2px;padding:24px}
</style>
</head>
<body>
<div id="map"></div>
<div class="vignette"></div><div class="scan"></div>
<div class="topbar">
  <a class="home" href="../">◂ THE BACKROOMS</a>
  <span class="title">THE ATLAS</span>
  <span id="count">—</span>
</div>
<div class="legend">
  <div><span class="dot" style="background:#c9ba72"></span>genesis</div>
  <div><span class="dot" style="background:#8fdcac"></span>surfaced</div>
  <div><span class="dot" style="background:#a05a3a"></span>sealed — lore, not a way in</div>
</div>
<div class="err" id="err">the atlas could not be read.</div>

<script src="vendor/leaflet.js"></script>
<script type="module">
  import { validateBeaconSet, beaconStyle } from './atlas-core.mjs'

  const map = L.map('map', { zoomControl: true, attributionControl: true }).setView([39.2966, -76.6414], 14)
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '© OpenStreetMap contributors © CARTO', maxZoom: 19, subdomains: 'abcd',
  }).addTo(map)

  try {
    const doc = await (await fetch('beacons.json', { cache: 'no-store' })).json()
    const res = validateBeaconSet(doc)
    if (!res.ok) throw new Error(res.error)
    document.getElementById('count').textContent = `${res.count} door${res.count === 1 ? '' : 's'}`
    const pts = []
    for (const b of doc.beacons) {
      const st = beaconStyle(b)
      const m = L.circleMarker([b.lat, b.lng], {
        radius: 7, color: st.color, weight: 2, fillColor: st.color, fillOpacity: 0.35,
      }).addTo(map)
      m.beacon = b            // Task 4 reads this on click
      pts.push([b.lat, b.lng])
    }
    if (pts.length > 1) map.fitBounds(pts, { padding: [60, 60] })
  } catch (e) {
    document.getElementById('err').style.display = 'grid'
    console.error('atlas:', e)
  }
</script>
</body>
</html>
```

- [ ] **Step 3: Verify in the browser**

Serve the site locally and open `atlas/`:
- The map renders in the dark CARTO style, centered on West Baltimore.
- One gold-rust marker sits on the 806 N Carey block. (Genesis + sealed → rust per `beaconStyle`; the legend explains both colors.)
- The top bar reads `THE ATLAS` with `1 door`; the "◂ THE BACKROOMS" link points to `../`.
- No console errors; the `#err` overlay stays hidden.

Take a screenshot for the reviewer.

- [ ] **Step 4: Commit**

```bash
git add atlas/vendor/leaflet.js atlas/vendor/leaflet.css atlas/index.html
git commit -m "feat(atlas): dark map with vendored Leaflet + genesis markers"
```

---

### Task 4: Strata panel — click a beacon, read the archive

**Files:**
- Modify: `atlas/index.html` (add the panel markup, styles, and the click handler in the module script)
- Test: manual browser verification.

**Interfaces:**
- Consumes: `orderStrata`, `stratumLabel`, `beaconStyle` (Task 1); the `m.beacon` property set in Task 3.
- Produces: nothing later tasks depend on.

- [ ] **Step 1: Add the panel markup**

In `atlas/index.html`, immediately after the `<div class="err" id="err">…</div>` line, add:

```html
<aside class="panel" id="panel" aria-hidden="true">
  <button class="panel-x" id="panel-x" aria-label="close">✕</button>
  <div class="panel-kind" id="p-kind"></div>
  <h2 class="panel-name" id="p-name"></h2>
  <div class="panel-sub" id="p-sub"></div>
  <p class="panel-blurb" id="p-blurb"></p>
  <div class="panel-sealed" id="p-sealed">sealed — shown for its record. not a way in.</div>
  <div class="panel-strata-h">strata · read down</div>
  <ol class="panel-strata" id="p-strata"></ol>
</aside>
```

- [ ] **Step 2: Add the panel styles**

In the `<style>` block, before the closing `</style>`, add:

```css
  .panel{position:fixed;top:0;right:0;bottom:0;width:min(380px,88vw);z-index:415;
    background:rgba(4,3,2,.94);border-left:1px solid rgba(138,127,82,.4);
    padding:56px 22px 24px;overflow-y:auto;transform:translateX(100%);
    transition:transform .28s ease;backdrop-filter:blur(2px)}
  .panel.open{transform:none}
  .panel-x{position:absolute;top:14px;right:16px;background:none;border:none;color:var(--dim);
    font-size:16px;cursor:pointer}.panel-x:hover{color:var(--y)}
  .panel-kind{font-size:10px;letter-spacing:3px;text-transform:uppercase;color:var(--rust)}
  .panel-name{font-family:var(--serif);font-weight:400;font-size:22px;color:var(--y);margin:6px 0 2px}
  .panel-sub{font-size:11px;letter-spacing:1px;color:var(--faint);margin-bottom:16px}
  .panel-blurb{font-family:var(--serif);font-size:15px;color:#d3c88f;line-height:1.6;margin-bottom:18px}
  .panel-sealed{display:none;border:1px solid var(--rust);color:var(--rust);font-size:11px;
    letter-spacing:1px;padding:8px 10px;margin-bottom:18px}
  .panel-sealed.show{display:block}
  .panel-strata-h{font-size:10px;letter-spacing:4px;text-transform:uppercase;color:var(--dim);
    border-top:1px solid rgba(138,127,82,.3);padding-top:14px;margin-bottom:10px}
  .panel-strata{list-style:none}
  .panel-strata li{border-left:2px solid rgba(143,220,172,.4);padding:8px 0 12px 12px;margin-bottom:2px}
  .panel-strata li.faint{border-left-color:rgba(160,90,58,.5)}
  .panel-strata .lab{font-size:9px;letter-spacing:2px;color:var(--faint);text-transform:uppercase}
  .panel-strata .frag{font-family:var(--serif);font-size:13px;color:#c8bd86;margin-top:3px;line-height:1.5}
```

- [ ] **Step 3: Wire the click handler**

Add `orderStrata` and `stratumLabel` to the import at the top of the module script:

```js
  import { validateBeaconSet, beaconStyle, orderStrata, stratumLabel } from './atlas-core.mjs'
```

Then, inside the `for (const b of doc.beacons)` loop, after `m.beacon = b`, add:

```js
      m.on('click', () => openPanel(b))
```

And add these functions at the end of the module script (before the closing `</script>`):

```js
  const panel = document.getElementById('panel')
  function openPanel(b) {
    const st = beaconStyle(b)
    document.getElementById('p-kind').textContent = st.label
    document.getElementById('p-kind').style.color = st.color
    document.getElementById('p-name').textContent = b.name
    document.getElementById('p-sub').textContent = b.subtitle || ''
    document.getElementById('p-blurb').textContent = b.blurb || ''
    document.getElementById('p-sealed').classList.toggle('show', !!b.sealed)
    const ol = document.getElementById('p-strata')
    ol.innerHTML = ''
    orderStrata(b.strata).forEach((s, i) => {
      const li = document.createElement('li')
      if (s.tier === 'faint') li.className = 'faint'
      const lab = document.createElement('div'); lab.className = 'lab'; lab.textContent = stratumLabel(s, i)
      const frag = document.createElement('div'); frag.className = 'frag'; frag.textContent = s.fragment
      li.append(lab, frag); ol.appendChild(li)
    })
    panel.classList.add('open'); panel.setAttribute('aria-hidden', 'false')
  }
  function closePanel() { panel.classList.remove('open'); panel.setAttribute('aria-hidden', 'true') }
  document.getElementById('panel-x').addEventListener('click', closePanel)
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closePanel() })
```

- [ ] **Step 4: Verify in the browser**

Reload `atlas/`:
- Click the 806 marker → the panel slides in from the right.
- It shows kind `sealed` (in rust), the name "806 N Carey Street", the subtitle, the blurb, the rust **"sealed — not a way in"** notice, and the strata as four layers **newest-first**: `layer 001 · faint · 2025-11-08` (EXTENSION) at the top, down to `layer 004 · deep · 1937-01-01` (the map) at the bottom.
- The ✕ button and the Escape key both close it.

Screenshot the open panel for the reviewer.

- [ ] **Step 5: Commit**

```bash
git add atlas/index.html
git commit -m "feat(atlas): strata panel — read a beacon's archive down the layers"
```

---

### Task 5: Link from the landing page + deploy

**Files:**
- Modify: `index.html` (the landing page — add a link to `/atlas/`)
- Test: manual browser verification, then deploy.

**Interfaces:**
- Consumes: the finished `atlas/` page.
- Produces: the public link; the deployed site.

- [ ] **Step 1: Add the link on the landing page**

In the landing page `index.html`, the Atlas section already has a "the atlas opens soon" line (`<div class="coming">▸ the atlas opens soon</div>`). Replace that single element with a working link:

```html
      <a class="coming" href="atlas/" style="text-decoration:none;border-bottom:1px solid var(--sig);">▸ enter the atlas</a>
```

If that exact element is not present (the landing page predates the Atlas preview), instead add the link at the end of the `.atlas` section's lead text:

```html
      <p class="lead"><a href="atlas/" style="color:var(--sigb);border-bottom:1px solid var(--sig)">▸ enter the atlas</a></p>
```

- [ ] **Step 2: Verify the link**

Serve locally, open the landing page, click "enter the atlas" → lands on `/atlas/` with the map. From the Atlas, "◂ THE BACKROOMS" returns to the landing page.

- [ ] **Step 3: Run the full self-test once more (regression gate)**

Run: `node atlas/atlas-core.test.mjs`
Expected: `N/N passed`, exit 0.

- [ ] **Step 4: Commit and deploy**

```bash
git add index.html
git commit -m "feat(atlas): link the atlas from the landing page"
```

Merge the `atlas-mvp` branch into `gh-pages` and push — GitHub Pages redeploys automatically:

```bash
git checkout gh-pages
git merge --no-ff atlas-mvp -m "release(atlas): read-only map MVP"
git push origin gh-pages
```

Verify the live site at `/atlas/` after Pages redeploys (~1 min): map renders, marker clickable, strata readable, tiles attributed.

---

## Self-Review

**Spec coverage** (against `2026-07-25-beacon-atlas-design.md`):
- §5.1 public read map, dark style, genesis marker, click-to-read-archive → Tasks 3–4. ✅
- §2 genesis vs organic + the sealed-safety rule → `beaconStyle` (Task 1), 806 `sealed:true` (Task 2), legend + panel notice (Tasks 3–4). ✅
- §3 strata as a readable, newest-first archive → `orderStrata`/`stratumLabel` (Task 1), panel (Task 4). ✅
- §5.3 data shape = the future API contract → `beacons.json` schema (Task 2), validated (Task 1). ✅
- §6 disclosure boundary (no mechanism, public-landmark/sealed safety) → Global Constraints + `sealed:true` on 806. ✅
- §8 mobile/field surface → responsive page (`width=device-width`, `min(380px,88vw)` panel). ✅
- Explicitly **out of scope** here (later plans): the Worker read-API + DO, organic beacons, travel/passage, the console, auth. The static `beacons.json` is the deliberate stand-in.

**Placeholder scan:** none — every step carries complete code or an exact command; no TBD/TODO; the one "expected partial failure" in Task 1 Step 4 is explicitly explained and closed in Task 2.

**Type consistency:** `validateBeacon`/`validateStratum`/`validateBeaconSet`/`orderStrata`/`beaconStyle`/`stratumLabel` are named identically across the module, the test, and the view. The `{id, kind, sealed, name, subtitle, lat, lng, blurb, strata:[{tier, ts, fragment}]}` shape matches across `beacons.json`, the validators, and the panel renderer. `beaconStyle` returns `{color,label,className}` and both the marker (Task 3) and panel (Task 4) use `.color`/`.label`.

**Untested surfaces (declared):** `atlas/index.html` is static-site view code with no unit harness (the repo's existing `index.html` has none either); it is verified in-browser with screenshots. All branching logic worth testing lives in `atlas-core.mjs`, which is fully covered by the `node` self-test.
