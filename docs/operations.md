# operations — the building, the relay, the site

*what runs where, what it needs, how it is deployed, how it is watched, and what to do when it is not answering.*
*written 2026-10-20 against 2.0.3; keep it current with every release that changes a secret, a route or a deploy step.*

## 1. the map

| piece | where it runs | deployed by | source |
|---|---|---|---|
| **the site** — backrooms.thecornerspore.dev: the finding, the record (codex), the field manual, the atlas page, the case board, the hidden pages | GitHub Pages from the `gh-pages` branch (`CNAME` = backrooms.thecornerspore.dev; DNS at Cloudflare, **not proxied** — resolves straight to GitHub's 185.199.x) | by hand: commit to `gh-pages` | `gh-pages` branch |
| **the browser game** — /play/ (PWA, service worker, world.json) | same branch, `play/` | `Site (gh-pages /play/)`: Build & Release's publish job starts it on the new tag every time it publishes a release (a release published by hand in the UI starts it too); by hand, run it from the Actions tab on any tag or branch | built from `src/` |
| **the relay** — rooms (WebSocket, Durable Object `Room`), `/wish`, `/maps`, `/atlas/*` (DO `Atlas`), rate limits (DO `Gate`) | Cloudflare Worker `backrooms-relay` on account `jeff-schatz112`, `wss://backrooms-relay.jeff-schatz112.workers.dev` | `Relay (Cloudflare Worker)` on a push to main touching `relay/` or a file it imports (needs the two Cloudflare secrets, §2), or by hand `cd relay && npx wrangler deploy` | `relay/` + six files it imports from `src/`: `wish-labels.js`, `renderer/anchor.js`, `renderer/origin-intake.js`, `renderer/status.js`, `renderer/prefs.js`, `renderer/scraps.js` |
| **the installers** — Windows nsis, Linux AppImage/.deb, macOS universal dmg/zip (macOS 13 or later since 2.0.3), the LAN server bundle, the itch web zip | GitHub Releases | `Build & Release` on every push to main whose `package.json` version is not yet published (draft → upload → publish) | `src/`, `server/`, `build/` |
| **auto-update** — desktop installs check GitHub Releases (`latest*.yml`); `backrooms-server.js` updates itself hourly | the players' machines | the release itself | `src/updater.js`, `server/updater.js` |
| **wishes** — POST /wish → GitHub issue (`wish`, `pending`) → a person labels `granted` → `Grant Wish` opens a PR that edits `src/renderer/world.json` → merged → shipped | GitHub Issues + Actions | `wish-grant.yml`; `wish-auto.yml` is **paused** (manual dispatch only) | relay `wishgate.js`, `tools/docket.mjs`, `tools/validate-world.mjs` |
| **itch.io mirror** | itch.io, channels windows/linux/mac/html5 | the `itch` job of Build & Release — **inactive** until `BUTLER_API_KEY` is set and `BUTLER_SHA256` pinned | `tools/build-itch.sh` |
| **the counter** | GoatCounter (`backrooms.goatcounter.com`), cookieless, /play/ and the front page only | nothing to deploy | `tools/build-play.sh` injects it into /play/; the front page carries it by hand |

## 2. secrets and keys — inventory and rotation

| secret | lives in | used by | scope | rotate |
|---|---|---|---|---|
| `GITHUB_TOKEN` (relay) | Cloudflare worker secret (`npx wrangler secret put GITHUB_TOKEN` from `relay/`) | `POST /wish` files issues | fine-grained token on **this repository only**, issues read+write, nothing else | fine-grained tokens expire (≤ 1 year): note the expiry date here when you make one: `____`. Secret missing → `/wish` answers `closed` (503); token expired or revoked → `upstream` (502), and wishes are lost silently either way — the health check sees neither; see §4 |
| `IP_SALT` (relay) | Cloudflare worker secret | salts the per-sender hash for the Gate | a long random string — **set it**: without it the Gate falls back to the public constant `'backrooms-gate'` (relay.js `gate()`), and a hashed address is then only as private as that constant | never needs to; rotating resets the day's rate-limit memory |
| `ATLAS_ADMIN_KEY` (relay) | Cloudflare worker secret | admin writes `PUT /atlas/beacons/:id`, `POST /atlas/beacons/:id/strata` | a long random string | if it leaks, `wrangler secret put` a new one; nothing else references it |
| `EV_LOG` (relay var) | `relay/wrangler.jsonc` `vars` (declared `"1"`) — **only there**: `wrangler deploy` replaces dashboard variables with the file's, and deploys are now automatic | `'0'` turns the keep/drop log off: nothing replayed or kept, and a room's stored log is deleted the next time someone joins it (anything else, or unset, is on) | — | — |
| `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | GitHub Actions secrets of the **`relay` environment** (Settings → Environments → relay: deployment branches = main; a required reviewer if you want one). Repository secrets work too, but then no branch rule guards them | `Relay (Cloudflare Worker)` deploy | a custom API token for **this account only**: Account → Workers Scripts → Edit, **no zone resources** (the relay lives on workers.dev). Not the "Edit Cloudflare Workers" template as it comes: that also grants Workers Routes on every zone, KV and R2 | yearly, or on any suspicion |
| `CSC_LINK`, `CSC_KEY_PASSWORD` | GitHub Actions secrets | Windows code signing in Build & Release | the .pfx and its password | at certificate expiry |
| `BUTLER_API_KEY` | GitHub Actions secret (unset) | itch push | itch.io API key | when set; pin `BUTLER_SHA256` first |
| `CLAUDE_CODE_OAUTH_TOKEN` | GitHub Actions secret | `wish-grant.yml` and the paused `wish-auto.yml` | the maintainer's Claude subscription (`claude setup-token`) | ~1 year |
| `RELEASE_PUSH_TOKEN` | not set, and **not wired**: no workflow reads it. `wish-auto.yml`'s checkout or push would have to use it before an auto-grant could start Build & Release (README, wish pipeline) | — | a PAT with contents write | yearly, once wired |

A retired token is listed here only once it is confirmed revoked, with the date.

**before adding the Cloudflare token**: Workers dashboard → backrooms-relay → Settings → Variables and Secrets. `GITHUB_TOKEN`, `IP_SALT` and `ATLAS_ADMIN_KEY` must each have the type **Secret**. A value entered there as plain text is a variable, and the next `wrangler deploy` deletes it.

### what the relay keeps

invocation logs are off for the whole worker: no request URL, address or body is logged. What it does store:

- **each room's seed** — forever, by design (a room is a place).
- **each room's keep/drop log** (`evlog`, 2.0.3): for every cache still lying there, the name the player chose, the cache's place in the maze (floor, cell, item, phrase, arrow) and the UTC day it was set down — never the time of day, never a pin. The last 64 per room, 6 per name, and nothing older than 30 days: the room's alarm deletes it. Replayed to anyone who enters the room code. `EV_LOG` `'0'` turns it off (§2).
- **the Gate** — per salted address hash, the times of recent `/wish` and `/maps` requests, wiped a day after the last.
- **the atlas** — beacons and their strata; presence marks at the resolution of a UTC day, today's kept out of view until the day ends, the newest 50 past-day marks per beacon; per beacon a map of salted device hashes for the 6-hour check-in cooldown; per hashed device token a passage balance.

## 3. deploying

**a release.** bump `version` in `package.json`, write `docs/release-notes/v<version>.md`, push to main. Build & Release creates a draft `v<version>`, builds three platforms, uploads, publishes, starts `Site (gh-pages /play/)` on the new tag (which rebuilds `/play/` with the next service-worker number), and (when configured) pushes itch. If the relay protocol changed — a new message type, frame-size or rate rules, a kind the keep/drop log holds (`relay/evguard.js` `EV_KEEP_KINDS` / `EV_DROP_KINDS`), or anything under `relay/` — the relay must go out **first or together**: `Relay (Cloudflare Worker)` runs on the same push. A new `ev` kind that is only relayed needs no relay deploy: the relay checks a kind's spelling, not a list.

**the relay by hand.** `cd relay && npx wrangler deploy` from a full checkout. Never renumber or edit a deployed migration tag in `wrangler.jsonc` (v1 Room, v2 Atlas, v3 Gate), and never add a `deleted_classes` (or `renamed_classes` / `transferred_classes`) migration for Room, Atlas or Gate: that is what deletes their data (a deploy that simply leaves a class out is generally refused). `test/relay-routes.test.js` holds both rules, and the relay workflow runs the whole suite before every deploy. Secrets survive deploys; plain-text dashboard variables do not (§2).

**the site by hand.** edit `gh-pages`. For `/play/`, run `Site (gh-pages /play/)` from the Actions tab (a tag or a branch of this repository). Without Actions, from a checkout with gh-pages beside it: `PLAY_SW_VERSION=$(( $(git -C ../gh-pages log -p --format= -- play/sw.js | grep -oE 'backrooms-play-v[0-9]+' | grep -oE '[0-9]+$' | sort -n | tail -1) + 1 )) bash tools/build-play.sh src ../gh-pages/play` — the highest number gh-pages has ever shipped, plus one, as the workflow does — then commit and push. GitHub Pages serves within a minute or two.

**rolling back.** installers: re-run a previous tag's release? No — `electron-updater` only moves forward; publish a new patch version that reverts the change. relay: the workflow rolls a deploy back by itself when the new version does not answer; by hand, `cd relay && npx wrangler rollback` (Cloudflare keeps versions; it goes to the one before), or redeploy from the previous commit. Never roll back to a worker from before 2.0.0: the atlas-branch workers served presence marks to the minute, and today's. A rollback below 2.0.3 stops reading the stored keep/drop logs: they stay stored, unread (and unexpired), until a 2.0.3 relay is back. site: `git revert` on `gh-pages`, then run `Site (gh-pages /play/)` again — it takes one more than the highest number ever shipped, so a revert cannot make a number repeat.

## 4. watching

- **Health** (`.github/workflows/health.yml`): every half hour probes the front page, `/play/`, `/play/sw.js`, the manual, the atlas page, the relay front page, `/atlas/beacons`, the `/wish` CORS preflight from the site, a WebSocket upgrade and a real join, and GitHub's latest release. Anything that fails is probed again two minutes later; only a failure both times counts. Then it opens issue *health: something is not answering* (label `ops`) whose body is the list failing now, and comments only when that list changes; the next green run closes it. Watch that issue. The join uses a room code no player can type (it starts with a control character, which the game strips), so the seed it fixes is in a room nobody else enters.
- **Cloudflare dashboard → Workers → backrooms-relay**: requests, errors, CPU time, DO storage, and **rows written** — on the Workers free plan the Durable Object rows-written allowance (per day, for the whole account; the dashboard shows the current numbers) is the limit that runs out first. What writes: a new room's seed, each Gate take (`/wish`, `/maps`), atlas check-ins and drop-ins, and each room's keep/drop log (at most one write per room every 10 s, plus one when the last player leaves, plus its expiry alarm). When the allowance is gone, writes fail across the account until 00:00 UTC: a new room gets no welcome, `/wish` and `/maps` fail, check-ins answer 503. Health does not see it (its room already has a seed). Workers Paid turns that hard stop into billing.
- **Atlas backup** (`atlas-backup.yml`): **off by default** (owner decision). Setting the repository variable `ATLAS_BACKUP` to `public` turns on a weekly snapshot to `gh-pages/atlas/backup/`; a manual run writes one either way. It holds the authored atlas only — beacons and their written strata — and stops before writing anything it does not recognise. Presence marks are never archived publicly, and neither will any Hall or roll-call data be. A restore brings back the beacons and authored strata; not presence (regenerable: the 14-day door rings start again), not the check-in dedup maps or passage balances. Cloudflare's point-in-time recovery for SQLite-backed objects covers bad writes for a while (check the current window); it does not cover a class deleted by a migration.
- **what is not watched**: whether `/wish` can still file. A free probe: `curl -s -X POST -H 'Origin: https://backrooms.thecornerspore.dev' -d x https://backrooms-relay.jeff-schatz112.workers.dev/wish` answers 503 `closed` when the secret is missing and 400 `body` when it is set — it never reaches the rate gate or GitHub, so it catches "missing" but not "expired". For expiry, file one test wish a month and close it. GoatCounter itself; itch.io. And GitHub **disables scheduled workflows in a public repository after 60 days without activity in it**: Health (and the atlas backup, if on) then stop without a word. Any commit resets the clock; a disabled workflow is re-enabled from the Actions tab.

## 5. when it goes wrong

| symptom | look | do |
|---|---|---|
| health issue: site 4xx/5xx | GitHub Pages status, the `gh-pages` branch's last commit, the CNAME file | revert the last gh-pages commit; if Pages is down, wait — the desktop app is unaffected |
| health issue: relay front page or atlas | Cloudflare status; Workers dashboard errors | `npx wrangler rollback`; if the DO is unhealthy the dashboard shows it per class |
| new rooms never get a welcome, `/wish` and `/maps` fail, atlas check-ins 503 — all at once | Workers dashboard → Durable Objects → rows written today | the free plan's daily write allowance is spent: it comes back at 00:00 UTC. If it is being burned on purpose, `EV_LOG` `'0'` in `wrangler.jsonc` and a deploy stops the keep/drop log's writes |
| rooms join but friends do not see each other's verbs | mixed versions (`here` heartbeat missing → legacy peers) | update together; nothing to do server-side |
| wishes stop arriving | `/wish` answers `closed` (503) → `GITHUB_TOKEN` missing; `upstream` (502) → the token expired or was revoked, or GitHub is failing | make a new fine-grained token, `wrangler secret put GITHUB_TOKEN` |
| players report "that place cannot be found" for short maps links | Workers dashboard → status codes for `/maps` (metrics only: invocation logs are off). 429 → the Gate (a shared NAT or campus); 502 or 422 → Google changed the maps.app.goo.gl redirect (`relay/mapslink.js` `resolveShortLink`) | a real 429 load: raise `GATE_RULES.maps` in `wishgate.js`; a changed redirect: update `mapslink.js` and its test |
| a release never publishes | the draft exists but an asset failed (`gh release view v<ver>`) | re-run the failed job; the build re-uploads with `--clobber` into the same draft |
| a release published but `/play/` did not move | the publish job's "Ship the browser copy" step, then the `Site (gh-pages /play/)` run | run `Site (gh-pages /play/)` from the Actions tab on the tag |
| a release has no mac files | the macOS build job (it is optional, so the workflow is green without it) | read that job's own log; re-run it into the same draft before publishing if you can |
| macOS users cannot open the app | Gatekeeper (not notarized); or macOS 12 or older, which 2.0.3 (Electron 44) no longer runs on | right-click → open; on macOS 12, stay on 2.0.2 or play in the browser. Notarization needs an Apple Developer account ($99/yr) — decision pending |
| a player's pin leaked into a room | they are on 2.0.1 or older | the 2.0.2 notes say what to do: leave the room code, open a new one, update together |

## 6. known gaps (as of 2026-10-20) and the plan

1. **dependencies** — fixed in 2.0.3: electron 44, vitest 5, overrides; `npm audit` 22 → 0. Build & Release warns (never blocks) on new **high** findings (`npm audit --audit-level=high`): keep it at no new high findings, and read the moderates when you bump.
2. **the relay was deployed by hand** — fixed by `relay-deploy.yml` once the two Cloudflare secrets are in the `relay` environment.
3. **the service-worker number was bumped by hand** — fixed by `site-deploy.yml`, which Build & Release starts when it publishes.
4. **nothing watched the building** — fixed by `health.yml`.
5. **the atlas had no backup** — `atlas-backup.yml` exists, **off** until the owner sets `ATLAS_BACKUP` (§4); authored data only.
6. **the room's keep/drop log forgot on hibernation** — fixed in 2.0.3's relay: it is stored in the Room's own storage (`evlog`), paced and forgotten after 30 days (§2).
7. **the relay lives on a `workers.dev` name that carries the account's handle** — a Workers custom domain `relay.thecornerspore.dev` is the fix (free; the zone is already on Cloudflare); the client then prefers it and keeps the old name as fallback. Planned for 2.1.0 so old clients keep working.
8. **itch.io mirror inactive** — pin `BUTLER_SHA256`, add `BUTLER_API_KEY`, confirm `ITCH_GAME`.
9. **macOS not notarized; Windows signing depends on `CSC_*` secrets being present** — owner decision.
10. **no uptime record of `/wish` token expiry** — monthly test wish; write the expiry date in §2.
