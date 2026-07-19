# The Two-Way Membrane & the Verification Ladder — design

**Date:** 2026-07-18
**Status:** proposed. Grounds the outside-world mechanic captured in
[2026-07-18-the-recursion-and-outside-world-IDEAS.md](2026-07-18-the-recursion-and-outside-world-IDEAS.md).
Backed by a 4-agent research pass (beacon feasibility, patent prior-art, codebase MVP, adversarial refute).
Patentability lives in a separate memo: [2026-07-18-outside-world-patent-memo.md](2026-07-18-outside-world-patent-memo.md).

---

## 1. The idea, in one line

Because the game *is* reality (recursively — the lore), the boundary between them is crossable **both ways**, and both crossings are legitimate routes to the same thing:

- **Physical → game.** Go to a real place; it gives you something *in* the game.
- **Game → reality.** Reach the same thing by going *into* the game (warp/descend), and the game surfaces real coordinates/clues back at you.

Two routes, one destination. The spectacle is the *symmetry* — walking there and warping there are the same act.

**The load-bearing rule (the user's):** the mechanic is not "prove you were there → get loot." It is **proof-of-presence *strength* scales the *value* of the reward.** Weak proof → weak loot. Strong proof → strong loot. Cheating the weak tier is *allowed* — it only ever yields weak loot, which is the entire anti-cheat model.

---

## 2. Why this fits what already exists (nothing is greenfield)

The research (codebase-mvp agent) found the seams are already cut:

| Half of the membrane | Already shipped |
|---|---|
| **Game → reality** | `anchor.js:bodyUrl()` + the settings **"locate your body"** button open Google Maps at your anchor; the **drift HUD** (`driftMeters`) shows how far you've walked from your real body; **Level ∅** literally renders a real address (806 N Carey St). |
| **Physical → game** | `parseAnchor()` turns a pasted Maps link into `{lat,lng}`; `anchorSeed()` turns that into the deterministic place key; **`applyIdentity()`** (index.html) is the single chokepoint where a run's identity is set — the natural place to hang a check-in. |
| **Persistence** | `prefs.js` (localStorage, `PREF_DEFAULTS`) for client state; the Cloudflare **relay Durable Object** now stores per-room state permanently (Phase-0 fix) — the extension point for shared/server-side check-ins. |
| **Rewards = items** | `items.js` already grants `worldSeed`-seeded loot with graded effects (bandage +40hp, almond-water, glowstick). "Reward value" = which item types / rarity a tier may grant. **Phase 1b already makes a place's loot place-specific**, so the premise is real, not a skin. |

---

## 3. The verification ladder

Four rungs; each is a real sensing method (from the beacon-tech research), ordered by how hard it is to fake and how local it is. Reward value is **hard-capped per rung.**

| Rung | Sensing | Spoof-resistance | Desktop? | Reward value | Build |
|---|---|---|---|---|---|
| **T0 Trust** | You paste a Maps pin. No proof — you *assert* presence. | None (by design). | ✅ (exists) | Low, hard-capped. Cheap consumables / a "polaroid of {place}". | **Now** |
| **T1 Soft signals** | Native geolocation (GPS/IP via main-process IPC) roughly agrees with the pin; dwell time; `resolveSectorAt` confirms it's a real named sector. | Weak-moderate. | ✅ (needs IPC) | Medium. | After sectors Phase 2 |
| **T2 On-site beacon** | An **ultrasonic near-ultrasound (18–20 kHz) beacon** in the room; the laptop mic hears it — sound is blocked by walls, so you must share the acoustic space. | Moderate (static tone → replayable). | ✅ **best desktop fit** (Web Audio, no phone, no extra client HW) | High / rare; first tier that can seed a persistent territory claim. | Later |
| **T3 Cryptographic co-presence** | The beacon emits a **server-signed, time-rotating nonce**; client relays it; server checks signature + freshness window + round-trip timing + geofence. Unforgeable at distance, un-replayable in time, bounded in space. | Strong. | ✅ desktop (beacon is external HW) | Top / unique loot + Ingress-style territory. | Later (patent core) |

**The novel "electronic beacon in a limited physical area" you asked for = T2/T3, ultrasonic.** It's the one option that satisfies your exact phrase *and* runs on the desktop Electron target with zero extra client hardware (the laptop's own mic + speaker via Web Audio do both emit and decode 18–20 kHz), *and* has natural wall-blocking locality. Lore-frames perfectly as **"a signal bleeding through the membrane."** (BLE / Wi-Fi-RTT / UWB were all shelved — each needs a phone and/or special radios the desktop client can't use. GPS/IP is demoted to coarse sector-anchoring only — it's the trust-me bottom by definition.)

---

## 4. MVP — ship T0, client-only, now

Smallest slice that completes the *physical→game* half at its weakest, harmless rung (the game→reality half already ships):

1. On the intake screen, once `currentAnchor` is set from a pasted pin (existing `applyIdentity` path), show a **"check in"** action.
2. On check-in, compute a stable **place key** from the anchor, look it up in a new persistent `prefs.checkins` ledger.
3. If absent (or past a cooldown), grant **one hard-capped low-value item** into `itemSys.inventory` via a small `grantItem` helper + a `tier → itemType` table, and stamp the ledger `{place, timestamp}`.
4. Re-checking-in at the same place within cooldown grants nothing (anti-farm).

No polygons, no sectors, no server, no hardware. Rides entirely on `parseAnchor`/`anchorSeed` + `prefs` + `items` + the `v:1` tolerant save.

**Files:** `prefs.js` (new `checkins` default), `items.js` (grant helper + tier table), `index.html` (button near `#locate-row`), `game.js` (accept the granted reward), `anchor.js` (a `placeKey()`), `test/prefs.test.js` + `test/items.test.js`. Optional follow-on: move the ledger into the relay DO (a `checkin` message) so check-ins are shared and can later feed territory.

---

## 5. Risks & the decisions they force

- **T0 is trivially cheatable — by design.** The *only* thing protecting the economy is the **hard value cap** on the trust tier. Keep the `tier → reward` table small, explicit, and **tested** — a single high-value item leaking into T0 collapses the whole ladder's incentive.
- **Place-key granularity is wrong at T0.** `anchorSeed` rounds to ~11 m, so pins 20 m apart are *different places* — the exact bug the sector system exists to fix. Check-ins should ultimately key on **`sectorId`** (sectors Phase 2), not raw coords. MVP can ship on `anchorSeed` but must note the key will migrate.
- **The `file://` renderer wall.** Every rung above T0 (geolocation, Web-Audio/Bluetooth sensing) must go through a **narrow main-process IPC** (`main.js`/`preload.cjs`), never a generic outbound escape hatch. Plan that seam now.
- **Anti-replay only exists from T3 up.** A static T2 tone can be recorded and replayed; don't ship T2 as "verified" high-value loot without at least a server freshness challenge, or it silently degrades to trust-tier security at high-tier payoff.
- **Patent exposure is real and mostly negative** — see the memo. `anchorSeed` already reads on Activision's GPS-seed patent *today*; the beacon space is dense (LISNR, Shopkick). Don't let a patent hope gate shipping the game.

---

## 6. Sequencing

1. **T0 check-in MVP** — now, client-only. Completes the two-way loop at the trust tier.
2. **Migrate the place key to `sectorId`** — with sectors Phase 1/2.
3. **T1 soft signals** — once `resolveSectorAt` + main-process geolocation IPC exist.
4. **T2 ultrasonic beacon (Web Audio)** — a real "go to this spot" mechanic for curated locations; software-only MVP first (laptop-to-laptop), hardened beacon box later.
5. **T3 signed rolling-nonce + relay verification + territory DO** — the endgame, and the only genuinely patent-adjacent piece.

**The point to hold onto:** the whole thing is playable and lore-true at T0 with code that already exists. Everything above T0 is optional escalation, not a prerequisite.
