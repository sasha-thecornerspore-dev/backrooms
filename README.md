# the backrooms

> you have no-clipped out of reality.

an infinite procedural first-person horror maze. fluorescent lights, damp carpet, no exit.

<p align="center">
  <img src="docs/screenshots/pillars.jpg" width="100%" alt="the backrooms — pillars under a fluorescent ceiling grid">
</p>

<p align="center">
  <img src="docs/screenshots/lights.jpg"   width="49%" alt="glowing ceiling panels over yellow rooms">
  <img src="docs/screenshots/corridor.jpg" width="49%" alt="a symmetric corridor receding into fog">
</p>
<p align="center">
  <img src="docs/screenshots/expanse.jpg"  width="49%" alt="an endless expanse of pillars in the haze">
  <img src="docs/screenshots/title.jpg"    width="49%" alt="the title screen, anchored to a real place">
</p>

<sub>rendered by a hand-written textured raycaster — no game engine, no assets, just math and the colour yellow.</sub>

---

## install

download the latest installer from [releases](../../releases/latest) and run it. the game auto-updates when new versions ship (you can turn that off in settings ⚙ — you'll get a quiet "restart now" prompt instead).

**windows:** `The Backrooms Setup x.x.x.exe`

---

## anchors — no-clip from a real place

on the start screen you can paste a **google maps link** (or bare `lat,lng`) into the anchor field. you will fall through *that* place. the same place always produces the same maze — for everyone. the hud tracks how far you've drifted from your body, and settings ⚙ has **locate your body**, which opens google maps at the spot where you fell through.

anchored worlds hold their shape. unanchored worlds forget you were ever there.

hosting with an anchor carries the whole room down with you — the first player into a room decides its world.

---

## items

the backrooms restocks itself. things are left lying around; walk close and press **f**.

| item | use (q) |
|------|---------|
| almond water | restores your legs, and the lights hold steady for a while |
| glowstick | pushes the fog back. temporarily. |
| polaroid camera | captures evidence — saved to `Pictures/backrooms/` |
| radio | plays a tune that is almost right. presences can be found from much farther away. other things also hear it. |

six slots. `1–6` selects, `q` uses. some things are worth carrying, some are worth using where you found them.

---

## the wish system

while wandering, you may encounter a presence — a faint shimmer in the wall.

press **e** to speak. state your request.

wishes are reviewed. some are granted. when a wish is granted, the world drifts — palette shifts, sounds change, items grow scarce or plentiful, messages grow more specific. players update and notice the world is not quite as it was.

the spirits decide. or rather, i do.

---

## controls

| key | action |
|-----|--------|
| wasd | move / strafe |
| shift | run (watch your legs) |
| arrow keys | turn (when mouse unlocked) |
| click | lock mouse for look |
| f | take an item |
| q | use selected item |
| 1–6 | select inventory slot |
| e | speak to a presence |
| esc | unlock mouse / close dialog |

---

## multiplayer

**host** spins up a local room; **join** connects to someone else's (`ws://host:port` + room code). everyone in a room shares one world and sees each other as dark figures in the fog. the standalone server ships as `backrooms-server.js` on each release (`node backrooms-server.js`, default port 8765) and keeps itself up to date.

---

## the world

the maze generates infinitely in every direction. chunks are cached for a small radius around you. when you travel far and return, the world may not remember what it was. it is not trying to confuse you. it simply does not care.

it is rendered with a hand-written textured raycaster — damp wallpaper, drop-ceiling tiles lit by flickering fluorescent panels, mottled carpet, film grain. no game engine, no assets, just math and the color yellow.

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
3. label `granted` → action calls claude → PR opens with modified `world.json` and a patch version bump
4. review the diff, adjust if needed, merge
5. release builds automatically, players auto-update

label `denied` → bot closes with *"the spirits did not answer."*
