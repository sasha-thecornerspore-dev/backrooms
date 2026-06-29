# the backrooms

> you have no-clipped out of reality.

an infinite procedural first-person horror maze. fluorescent lights, damp carpet, no exit.

---

## install

download the latest installer from [releases](../../releases/latest) and run it. the game auto-updates when new versions ship.

**windows:** `The Backrooms Setup x.x.x.exe`

---

## the wish system

while wandering, you may encounter a presence — a faint shimmer in the wall.

press **e** to speak. state your request.

wishes are reviewed. some are granted. when a wish is granted, the world drifts — palette shifts, sounds change, messages grow more specific. players update and notice the world is not quite as it was.

the spirits decide. or rather, i do.

---

## controls

| key | action |
|-----|--------|
| wasd | move / strafe |
| arrow keys | turn (when mouse unlocked) |
| click | lock mouse for look |
| e | speak to a presence |
| esc | unlock mouse / close dialog |

---

## the world

the maze generates infinitely in every direction. chunks are cached for a small radius around you. when you travel far and return, the world may not remember what it was. it is not trying to confuse you. it simply does not care.

---

## building from source

```bash
npm install
npm start        # run in dev
npm test         # run unit tests
npm run dist     # build installer (requires CSC_LINK, CSC_KEY_PASSWORD env vars)
```

---

## wish pipeline (maintainer notes)

1. player submits wish in-game → github issue opens with label `wish, pending`
2. review the issue — edit the body to your interpretation if needed
3. label `granted` → action calls claude → PR opens with modified `world.json`
4. review the diff, adjust if needed, merge
5. release builds automatically, players auto-update

label `denied` → bot closes with *"the spirits did not answer."*
