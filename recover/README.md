# Field Recovery — the case board

`/recover/` is a static case board. A **case** is a JSON manifest of 3–6 **instruments** (stations); each opens
when the player files a single word or number whose salted SHA-256 matches the station's gate. Answers never
ship in plaintext. Progress lives in this browser's `localStorage` (`cs.case.<case>.<station>`), and the game's
field console (`/recover`, `/file`) writes the same keys, so a task done in the maze shows as read here.

## Files

| file | what |
|---|---|
| `engine.js` | pure logic: normalize, salted gate check, keyring, linear progression, in-page proximity, the field-read seal |
| `index.html` | the board: the picker (no `?case`) and the runner (`?case=<id>`) |
| `cases/index.json` | the picker's list: `{cases:[{id, code, title, blurb, surfaced, stations[], geo?}]}` |
| `cases/<id>.json` | one manifest per case (built by `tools/recover-build-case.mjs` in the main repo — never by hand) |

## Manifest schema (additive; older cases keep working)

```
{ id, title ("CODE — name"), intro,
  stations: [ { id, title, where, clue, prompt, onSolve,
      gate: { type: "sha256", hash },                       // sha256("cornerspore:" + normalized answer)
      link?: { label, href, archive? },                     // https or same-site; archive = web.archive.org copy
      parity?: ["in the record — …", "in the world — …", "in the maze — …"],
      maze?: { level | levels: [..], hint },                // the console prints hint on those floors
      geo?:  { name, lat, lng, radiusM, hours, hint, kind: "public-landmark", beacon? } } ],
  reward: { title, text, fieldText?, key, href, linkLabel } }
```

## The rules that matter

- **Hints point, never tell.** A `maze.hint` or `geo.hint` says where to read, never what it says. The validator
  rejects a manifest whose answer appears inside any text visible before that station opens.
- **A place-read instrument is never mandatory.** Every `geo` station also carries a public-record link. The
  "i am standing at it" button asks for the device's position only when pressed. If the landmark is a live,
  unsealed door on the atlas, the position goes to the relay's existing check-in (it verifies proximity and keeps
  no coordinates) and a 201 seals the station **field-read**; otherwise the position is compared in the page and
  dropped, and the read is labelled unverified. A miss never states a distance. The safety line is fixed in the
  page, not the manifest. When every place-read instrument of a case was field-read, the reward closes with
  `fieldText`.
- **Places come only from the landmark allowlist** in the main repo (`tools/author/landmarks.json`): public
  grounds, daytime, legible from where anyone may stand, never near the sealed door. Adding one is a human act.
- **Only https or same-site links render.** A manifest cannot smuggle other schemes onto the board.
- **Propagation**: a merged change is live in roughly 1–15 minutes (Pages build plus edge cache).

To author a case, see `tools/author/README.md` in the main repo. To validate one:
`node tools/recover-validate.mjs recover/cases/<id>.json <local answers.json>`.
