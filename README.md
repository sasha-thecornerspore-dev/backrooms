# the backrooms

> you have no-clipped out of reality.

an infinite procedural first-person horror maze that descends through four levels. fluorescent lights, damp carpet, tight office corridors, no exit — only the way down.

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

## ▶ the live site — [thecornerspore.dev](https://thecornerspore.dev/)

<p align="center">
  <b><a href="https://thecornerspore.dev/">enter the finding →</a></b><br>
  <a href="https://thecornerspore.dev/play/">play in your browser</a> ·
  <a href="https://thecornerspore.dev/manual/">the field manual</a> ·
  <a href="https://thecornerspore.dev/codex/">the record — the lore</a> ·
  <a href="https://thecornerspore.dev/atlas/">the atlas</a>
</p>

> **these links render in your browser.** GitHub shows `.html` files inside this repo as *source code*, not as a page — so open the manual and the lore through the links above, not by clicking files under `docs/`.

---

## 📖 the field manual

**[open the illustrated field manual →](https://thecornerspore.dev/manual/)**

everything in one place: controls, how to read your instruments, the four-floor descent, the items, the file the office keeps on you, the beacon, and the deeper record. it renders in any browser.

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
| bandage | patches you up — restores hit points. carry a few before you go deep. |
| polaroid camera | captures evidence — saved to `Pictures/backrooms/`. point it at a friend and the film develops what the file wrote on them, and they will know |
| radio | plays a tune that is almost right. presences can be found from much farther away. other things also hear it. |

six slots. `1–6` selects, `q` uses, `x` sets it down. some things are worth carrying, some are worth using where you found them, some are worth leaving behind.

**leave a word.** when you set something down, a card asks whether to leave a word with it — six of m.'s phrases, the same six for that floor and that kind of thing, whoever is holding it. *take the left.* *the water here is sour.* *i am close behind.* pick one (or **0** for nothing) and the thing becomes a **cache**: it lies where it fell, with an arrow for the way you were facing. whoever picks it up reads it on the card — the phrase, the arrow turned to where *they* stand, and who left it. the prompt tells you before you take it: *f · take the bandage · left by maddie*. the floor remembers your caches between visits and across a quit; online, the room sees them as you set them down, and the relay keeps the last of them for whoever comes through after you. a stranger's word steadies you, a little. no free text, ever — only what m. wrote.

---

## the wish system

while wandering, you may encounter a presence — a faint shimmer in the wall.

press **e** to speak. state your request.

wishes are reviewed. some are granted. when a wish is granted, the world drifts — palette shifts, sounds change, items grow scarce or plentiful, messages grow more specific. players update and notice the world is not quite as it was.

the spirits decide. or rather, i do.

---

## the file

> *the file has you now.*

somewhere above the drop ceiling there is an office, and it keeps a file on everyone who falls through. you never fill it in. it fills itself in — and the backrooms reads it.

**the column.** nobody chooses one. the first way you take down, the file writes you in by how you arrived:

| how you came in | the file writes | what that means down here |
|------|---------|---------|
| alone, with a name | **tenant** — *the file has you at an address.* | the street does not mind you; the deep frays you faster. your hands find a way from further off, your map marks every way the floor has loaded, and on the block the sealed doors tell you whose address they are. |
| with an anchor | **anchored** — *the file has your body at a pin.* | the body stays where you fell through. drift too far from it and it pulls — settings ⚙ shows the *leash*. a photograph quiets it for a while. |
| with no name | **unnamed** — *the file cannot spell you.* | the things cannot keep hold of you; a page or a friend steadies you more. tell a presence *call me …* and it will ask how that is spelled. |
| first into a shared room | **processed** — *the file opened a line on you.* | the souls see the stamp. the radio reads everything to you, and once, the key. your wishes are amendments. |

and over any of them, a layer: **thin**. drop into a room someone already walks, or come back up from the dark, and *not all of you arrived*. the things lose you faster and hear you less — but the light goes through you, and a ward pushes you back as well as them. ballast cures it. until the first way down nothing is written: on the block, the form lies on the counter (**e** to read it; `/intake` reads it anywhere).

**filed under.** the file also keeps a **status**, and this one is yours to choose. it begins as a notice nobody answered. once the file can hear you — the numbers station has read you its last group, or you have found five of m.'s pages, or you are deep enough — a presence offers three stamps under the request. tap one, or type it:

| status | what it turns inside out |
|------|---------|
| **extension** · *let it stay open* | the deep holds you and the street frays you. sour water stops taking anything — somewhere a line moves instead. |
| **compliance** · *close the file* | the film turns honest. a page you have not read comes **sealed**: read it, or leave it unread (**x**) and give it to the file. |
| **litigation** · *contest it* | the claim develops on every photograph, even on the dark floors. a thin figure in frame is evidence. |

the lost souls know which word you are under, and so does the room — *entered the level, filed under extension.* the office files once a day. after that it is closed until tomorrow. and the status is not part of any save: it follows you into every run, and into every room.

**three ways a file closes.** each status has its ending, and none of them is a door out.

- **extension** — on the deepest floor, after the station has read you its last group: stand in the dark, light off, still, with nothing near. long enough, and the notice is extended over you. *twenty-two years.*
- **compliance** — give thirteen pages up unread, then tell a presence to *close the file*. the shimmer leaves the walls, and the floors stop leaving pages out.
- **litigation** — hold the seam. the station in the deep is counting toward something, and the extension slip names the one line the system never closed. claim it at a presence, then push it into the dark with your beacon (**b**).

**your file** (settings ⚙) shows what the office has on you — the word you are under and since when, how the file has you, and how far your closing has come — with a **request a new notice** button that puts you back under the notice nobody answered (once a day: the old file stays closed). solo or online, press **enter** and type `/status` for the same lines.

**the floors keep count.** a wish sent from a filed run carries its word with it — `filed under: EXTENSION · level 2` — and every release recounts them. a floor whose files lean one way leans with them: its machines stock for it and stamp the tray (*the tray is stamped COMPLIANCE.*), its pages and souls come more or less often, and the radio on the near floors reads the floor's roll call. who is standing on the floor with you moves it too.

---

## controls

| key | action |
|-----|--------|
| wasd | move / strafe |
| shift | run (watch your legs) |
| arrow keys | turn (when mouse unlocked) |
| click | lock mouse for look |
| space (hold to charge) | **ward** — tap to shove the things back; hold it and your steps slow while the air tightens, then a narrower, longer push throws them farther (costs your legs) |
| f | take an item · take a way — no-clip through an exit, climb a stairwell, step into the lift |
| f · search a cabinet | by a cabinet, crate, box, drum or panel: hold still for a moment and the drawer gives up what it holds — a step away leaves it; not while something is close |
| tab | the map (hold your pace) |
| q | use selected item |
| x · set down | set the selected item down where you stand, with one of m.'s phrases and an arrow for whoever finds it — a talking radio keeps talking where it lies |
| c · whistle | call out — a two-note whistle the floor and your friends hear; the things hear it too |
| l | flashlight on / off — go dark in a friend's light and the things see you less |
| 1–6 | select inventory slot |
| e | speak to a presence or a lost soul · read a page, or the form on the counter |
| enter | chat (in online play) — and the field console, solo too: `/status` (your file), `/intake` (the form), `/recover` · `/cases` · `/file` |
| b | fire your beacon — your own webhook, set in settings ⚙ |
| m | mute / unmute the music |
| n | next track — cycle the ambient beds, or back to the floor's own song |
| esc | unlock mouse / close dialog |

your **hit points** sit under the level name, top-left. level 0 is safe; below it, the things in the fog will take them from you. bandages and time bring them back.

you are not defenceless. face a thing that hunts you and press **space** — a **ward**, a shove of will and light that throws it back and leaves it reeling, unable to reach you while it recovers. keep at it and the presence comes apart entirely. warding spends your stamina, so you cannot lean on it forever — pick your moment.

---

## settings

hit the gear ⚙ (top-right) for the control panel. everything added is optional and modular, and your choices persist between runs:

| toggle | what it does |
|--------|--------------|
| music | the generative bed on/off, plus a volume slider |
| ambience | the fluorescent hum, drone, and distant events |
| film grain / crosshair / head-bob | visual feel |
| mouse sensitivity | look speed |
| creatures | turn every entity off for pure liminal exploration |
| solid furniture | walk around things — the chairs, crates, cabinets and machines have bodies, and so do the things in the fog; off, you pass through them as before |
| can take damage | off for a peaceful, no-stakes wander |
| your file | what the office has on you, once a run is under way — the word you are under, how the file has you, how far your closing has come — and **request a new notice** |

auto-update and software rendering live in the same panel, and so does **locate your body** for an anchored run (with the leash, when the file has you at a pin).

---

## multiplayer

type your **name**, hit **PLAY ONLINE**, pick a **room code**, and share it. anyone who enters the same code falls into the same world — anywhere on the internet, no host and no port-forwarding. it runs on a small always-on Cloudflare relay (`relay/`). you see each other as pale figures with nameplates, and **press Enter to chat**.

- **PLAY ONLINE** — the public relay + a room code (the easy way).
- **JOIN LAN / HOST LAN** — the old direct-connection path (`ws://host:port` + room code) for same-network play; the standalone server ships as `backrooms-server.js` on each release (`node backrooms-server.js`, default port 8765).
- the first person into a room fixes its world; everyone else inherits it.

**the whistle (c).** call out, and everyone on your floor hears two notes at a pitch that is only yours — panned to where you stand, fainter the farther you are, with a line in their chat that says *near* or *far* and which way. the hall counts who has answered lately and tells you, in words: *two of you, counting yourself.* a friend who goes a minute and a half without a whistle, a word, or standing near you has gone quiet, and you will feel it. alone, the hall keeps the sound. sometimes it does not, and the pitch that answers is wrong. the things hear every call — a whistle carries further than a ward. on a phone it is the **CALL** button.

**a friend's light (l).** the things see by light. once you have taken your first way down, stand dark in a friend's flashlight — a few steps from them, nothing between you — and the things in the fog have a harder time finding you, and the dark eats at you slower. the game names whose light it is when you go dark in it. their light helps the people standing in it, never the one carrying it.

**push for each other (space).** the things are not the same things on every screen. when a friend wards, everyone on that floor feels it where the friend stands: what was in front of them reels, or comes apart, on your side too — and if you were standing in front of their push when it met something, it steadies you. *maddie pushes the dark off you.*

**evidence (the polaroid).** photograph a friend and the film develops what the file wrote on them — and the photograph reaches them. *someone has evidence of you. you are harder to erase.* for a minute and a half their mind will not sink below a quarter, and the others see them solid, however thin they have become. photograph a friend who is down and they are counted back at once.

**down, not dead.** with a friend on your floor, a hit that would kill you lays you **down** instead: your light goes out and you have twenty-five seconds in the dark. you can still whistle. a friend who finds you, faces you and presses **f** stays with you — light on, holding still — and counts you back. a photograph does it faster. if nobody comes, it is a death.

## save & continue

solo runs auto-save — your level, position, hit points and whole inventory, what every floor remembers of you, and the sheets of your map — every few seconds, on every descent, and when you quit. **CONTINUE** on the title screen drops you back exactly where you left off.

---

## the world

the maze generates infinitely in every direction. chunks are cached for a small radius around you. when you travel far and return, the world may not remember what it was. it is not trying to confuse you. it simply does not care.

it is rendered with a hand-written textured raycaster — damp wallpaper, drop-ceiling tiles lit by flickering fluorescent panels, mottled carpet, film grain. no game engine, no assets, just math and the color yellow.

the sound is the same: **generative weirdcore music**, synthesised live and never looping. detuned pads breathe under a music-box melody that is almost-but-not-quite right, washed through a reverb built from noise, with tape wow-and-flutter and the occasional pitch that slides away. every level tunes it to its own mood — dreamy in the lobby, curdled below, dissonant at the bottom. no `.mp3`, no loop point; it writes itself as you walk. press **m** to silence it.

---

## the descent

the maze is no longer one endless yellow floor. it is a stack of levels, and each one has a way down. find a **no-clip exit** — a dark, breathing doorway standing in the fog — and press **f** to fall through. there is always one within a short walk; the game whispers how to find the next as you arrive.

every solo run begins outside, in **the block** — the one real place in the game.

| level | what it is | the way down |
|-------|-----------|--------------|
| **∅ — the block** | a real inner-block park in harlem park, west baltimore, under open grey sky. rowhouse backs of formstone, brick, plywood with sprayed house numbers, doors sealed with concrete, black open windows, marble stoops. some houses are lived in — a light on, nobody comes out. a plan erased the street and left this. | the front doors are sealed with block. the only way out is the gap the paperwork left — no-clip through it and fall into the lobby. **one way down.** |
| **0 — the lobby** | mono-yellow rooms, damp carpet, the fluorescent hum. safe. nothing hunts you here. | no-clip through a thin, torn corner and fall out of the lobby. |
| **1 — habitable zone** | colder concrete and dim service lights. things live here now — watch your hit points. | a hole in the floor, or a stairwell down into the pipes. |
| **2 — pipe dreams** | a maze of maintenance tunnels. steam, rust, and the dark between the pipes. bring your own light. | follow the pipes to a service hatch and drop into the dark. |
| **3 — electrical station** | a lightless labyrinth of transformers and live cable. the deepest you should go. | a door humming with current — through it, the lobby waits again. |

descend and the world changes around you: the palette, the fog, the clutter, and what is in it with you. your hit points and your inventory come with you.

the floors are stacked in one building. under some holes there is a **stairwell up**, back to the floor you fell from, a few rooms over from where you landed; and somewhere on level 1 a **lift** stands, uncalled — it only goes one place, and it does not come back for you. the floor you left remembers you: what you took stays taken, what you set down lies where you left it, and a machine you emptied clunks again only after you have been away a while. press **tab** for the map — a sheet of pencil strokes for what you have walked and small glyphs for what you have seen, held while you keep moving at half pace. and when something finally has you, you do not wake where you fell in: you wake a floor above, beside the hole you fell through, lighter — whatever was in your hand is gone, your ceiling a little lower, the trays empty for that visit.

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
