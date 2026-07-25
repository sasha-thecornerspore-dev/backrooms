# The Atlas — how it works, and how to add a door

The Atlas is the public map of **beacons** ("doors") at `/atlas/`. It is a static page on the
`gh-pages` branch — no build step, no backend (yet). This note is for whoever adds or edits beacons.

## Files

| File | What it is |
|---|---|
| `beacons.json` | **The data.** Every beacon and its strata. This is the only file you edit to add a door. |
| `atlas-core.mjs` | Pure logic (validation, strata ordering, marker styles, hash parsing). No DOM, no network. |
| `atlas-core.test.mjs` | Standalone self-test. Run it to check your edits: `node atlas/atlas-core.test.mjs`. |
| `index.html` | The map page (Leaflet + the strata panel). You rarely touch this. |
| `vendor/` | Vendored Leaflet (do not edit). |

## The one rule that must never slip

**A beacon that invites a physical visit must be a genuine, safe, *public* landmark** — a park, a
library, a transit stop, a civic building. **Never** a home, a private address, or a condemned/unsafe
structure, and never a place you would not send a stranger (including a kid — the audience includes
minors).

Anything that is *lore* but **not** a safe way-in must be marked **`"sealed": true`**. A sealed beacon
shows its whole story on the map but is styled as a warning (rust) and labelled "not a way in." That is
why **806 N Carey is `sealed`** — its doors are masoned shut and it is not a place to send anyone; it
exists on the map for its record, not as a destination.

When in doubt: `sealed`.

## The beacon format

`beacons.json` is `{ "version": 1, "beacons": [ … ] }`. Each beacon:

```json
{
  "id": "harlem-park-square",        // required. lowercase letters, digits, hyphen. UNIQUE. this is the share link: /atlas/#harlem-park-square
  "kind": "genesis",                  // required. "genesis" (hand-placed, gold) — that is all you author by hand. ("organic" is reserved for the future auto-placement engine, green.)
  "sealed": false,                    // optional. true = lore only, not a way in (rust). OMIT or false = a real, safe, public way-in. RE-READ THE RULE ABOVE.
  "name": "Harlem Park Square",       // required. the human name.
  "subtitle": "West Baltimore",       // optional. a small grey line under the name.
  "lat": 39.2960,                     // required. -90..90. the LANDMARK's own public coordinate — never a person's location.
  "lng": -76.6390,                    // required. -180..180.
  "blurb": "…",                        // optional. one or two in-world sentences shown at the top of the panel.
  "strata": [                          // required (may be empty []). the readable archive, one layer per entry.
    { "tier": "deep",  "ts": "2004-11-08T00:00:00Z", "fragment": "…" },
    { "tier": "faint", "ts": "2025-11-08T00:00:00Z", "fragment": "…" }
  ]
}
```

Strata fields:
- `tier` — `"deep"` (a physical/strong record; green left-rule in the panel) or `"faint"` (a light record; rust rule).
- `ts` — an ISO date string (`"2026-07-25T00:00:00Z"`). The panel reads strata **newest-first**, so the most recent layer sits on top and you dig *down* into older ones. Historical dates are fine — a place's own history is its deepest strata.
- `fragment` — the text of the layer. This is where the Cicada/Observer lore lives.

## How to add a door

1. Pick a **safe public landmark** (see the rule). Get its public coordinates.
2. Add a beacon object to the `beacons` array in `beacons.json`, following the format above. Give it a
   unique `id` (that id becomes its share link, `/atlas/#your-id`).
3. **Validate:**
   ```
   node atlas/atlas-core.test.mjs
   ```
   It must print `N/N passed`, exit 0. It checks every field, rejects duplicate ids, and confirms the
   whole file parses. If it fails, it names the beacon and field that is wrong.
4. Commit `beacons.json` and push `gh-pages` — GitHub Pages redeploys in about a minute. The map fits
   itself to all beacons automatically once there is more than one.

## Notes

- **The map is empty of "way-in" doors on purpose right now** — 806 is `sealed`. Add your first real
  public-landmark door and it becomes a gold, clickable destination.
- **Forward-compatible:** this static `beacons.json` is the exact shape the future server read-API will
  serve, so moving to a live backend won't change the page.
- **Not here:** how *organic* beacons get placed (the auto-placement engine) is intentionally **not** in
  this repo — it is patent-adjacent and kept private. This file only ever contains hand-authored genesis
  beacons.
