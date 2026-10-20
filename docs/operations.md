# operations — the building, the relay, the site

*what runs where, what it needs, how it is deployed, how it is watched, and what to do when it is not answering.*
*written 2026-10-20 against 2.0.2; keep it current with every release that changes a secret, a route or a deploy step.*

## 1. the map

| piece | where it runs | deployed by | source |
|---|---|---|---|
| **the site** — backrooms.thecornerspore.dev: the finding, the record (codex), the field manual, the atlas page, the case board, the hidden pages | GitHub Pages from the `gh-pages` branch (`CNAME` = backrooms.thecornerspore.dev; DNS at Cloudflare, **not proxied** — resolves straight to GitHub's 185.199.x) | by hand: commit to `gh-pages` | `gh-pages` branch |
| **the browser game** — /play/ (PWA, service worker, world.json) | same branch, `play/` | `Site (gh-pages /play/)` workflow on every published release, or by hand with `PLAY_SW_VERSION=<last+1> bash tools/build-play.sh src <gh-pages>/play` | built from `src/` |
| **the relay** — rooms (WebSocket, Durable Object `Room`), `/wish`, `/maps`, `/atlas/*` (DO `Atlas`), rate limits (DO `Gate`) | Cloudflare Worker `backrooms-relay` on account `jeff-schatz112`, `wss://backrooms-relay.jeff-schatz112.workers.dev` | `Relay (Cloudflare Worker)` workflow on a push to main touching `relay/` (needs the two Cloudflare secrets), or by hand `cd relay && npx wrangler deploy` | `relay/` + four files it imports from `src/` |
| **the installers** — Windows nsis, Linux AppImage/.deb, macOS universal dmg/zip, the LAN server bundle, the itch web zip | GitHub Releases | `Build & Release` on every push to main whose `package.json` version is not yet published (draft → upload → publish) | `src/`, `server/`, `build/` |
| **auto-update** — desktop installs check GitHub Releases (`latest*.yml`); `backrooms-server.js` updates itself hourly | the players' machines | the release itself | `src/updater.js`, `server/updater.js` |
| **wishes** — POST /wish → GitHub issue (`wish`, `pending`) → a person labels `granted` → `Grant Wish` opens a PR that edits `src/renderer/world.json` → merged → shipped | GitHub Issues + Actions | `wish-grant.yml`; `wish-auto.yml` is **paused** (manual dispatch only) | relay `wishgate.js`, `tools/docket.mjs`, `tools/validate-world.mjs` |
| **itch.io mirror** | itch.io, channels windows/linux/mac/html5 | the `itch` job of Build & Release — **inactive** until `BUTLER_API_KEY` is set and `BUTLER_SHA256` pinned | `tools/build-itch.sh` |
| **the counter** | GoatCounter (`backrooms.goatcounter.com`), cookieless, /play/ and the front page only | nothing to deploy | `tools/build-play.sh` injects it |

## 2. secrets and keys — inventory and rotation

| secret | lives in | used by | scope | rotate |
|---|---|---|---|---|
| `GITHUB_TOKEN` (relay) | Cloudflare worker secret (`npx wrangler secret put GITHUB_TOKEN` from `relay/`) | `POST /wish` files issues | fine-grained token on **this repository only**, issues read+write, nothing else | fine-grained tokens expire (≤ 1 year): note the expiry date here when you make one: `____`. When it lapses `/wish` answers `closed` and wishes are lost silently — the health check does not see this; a monthly test wish does |
| `IP_SALT` (relay) | Cloudflare worker secret | salts the per-sender hash for the Gate | optional | never needs to; rotating resets the day's rate-limit memory |
| `ATLAS_ADMIN_KEY` (relay) | Cloudflare worker secret | admin writes `PUT /atlas/beacons/:id`, `POST /atlas/beacons/:id/strata` | a long random string | if it leaks, `wrangler secret put` a new one; nothing else references it |
| `EV_LOG` (relay var) | `wrangler.jsonc` vars / dashboard | `'0'` turns the keep/drop log off | — | — |
| `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | GitHub Actions secrets (environment `relay`) | `Relay (Cloudflare Worker)` deploy | token from the "Edit Cloudflare Workers" template, this account | yearly, or on any suspicion |
| `CSC_LINK`, `CSC_KEY_PASSWORD` | GitHub Actions secrets | Windows code signing in Build & Release | the .pfx and its password | at certificate expiry |
| `BUTLER_API_KEY` | GitHub Actions secret (unset) | itch push | itch.io API key | when set; pin `BUTLER_SHA256` first |
| `CLAUDE_CODE_OAUTH_TOKEN` | GitHub Actions secret | `wish-grant.yml` and the paused `wish-auto.yml` | the maintainer's Claude subscription (`claude setup-token`) | ~1 year |
| `RELEASE_PUSH_TOKEN` | optional GitHub Actions secret | lets an auto-grant push trigger Build & Release | a PAT with contents write | yearly |

## 3. deploying

**a release.** bump `version` in `package.json`, write `docs/release-notes/v<version>.md`, push to main. Build & Release creates a draft `v<version>`, builds three platforms, uploads, publishes, and (when configured) pushes itch. `Site (gh-pages /play/)` then rebuilds `/play/` with the next service-worker number. If the relay protocol changed (`src/net/evbus.js` kinds, `relay/*`), the relay must go out **first or together**: `Relay (Cloudflare Worker)` runs on the same push when `relay/` changed.

**the relay by hand.** `cd relay && npx wrangler deploy` from a full checkout. Never renumber or drop a migration tag in `wrangler.jsonc` (v1 Room, v2 Atlas, v3 Gate): a deploy that omits a class deletes that class's data. Secrets survive deploys.

**the site by hand.** edit `gh-pages`; for `/play/`: `PLAY_SW_VERSION=$(($(grep -oE 'play-v[0-9]+' play/sw.js | tr -dc 0-9)+1)) bash tools/build-play.sh src ../gh-pages/play`, commit, push. GitHub Pages serves within a minute or two.

**rolling back.** installers: re-run a previous tag's release? No — `electron-updater` only moves forward; publish a new patch version that reverts the change. relay: `cd relay && npx wrangler rollback` (Cloudflare keeps versions), or redeploy from the previous commit. site: `git revert` on `gh-pages`, bump the service-worker number again (the number must always go up).

## 4. watching

- **Health** (`.github/workflows/health.yml`): every half hour probes the front page, `/play/`, `/play/sw.js`, the manual, the atlas page, the relay front page, `/atlas/beacons`, the `/wish` CORS preflight from the site, a real WebSocket join to a throwaway room, and GitHub's latest release. A failure opens issue *health: something is not answering* (label `ops`); the next green run closes it. Watch that issue.
- **Cloudflare dashboard → Workers → backrooms-relay**: requests, errors, CPU time, DO storage. Observability is on, invocation logs are **off** on purpose (nothing about a request is kept).
- **Atlas backup** (`atlas-backup.yml`): weekly public snapshot to `gh-pages/atlas/backup/`.
- **what is not watched**: whether `/wish` can still file (token expiry) — file one test wish a month and close it; GoatCounter itself; itch.io.

## 5. when it goes wrong

| symptom | look | do |
|---|---|---|
| health issue: site 4xx/5xx | GitHub Pages status, the `gh-pages` branch's last commit, the CNAME file | revert the last gh-pages commit; if Pages is down, wait — the desktop app is unaffected |
| health issue: relay front page or atlas | Cloudflare status; Workers dashboard errors | `npx wrangler rollback`; if the DO is unhealthy the dashboard shows it per class |
| rooms join but friends do not see each other's verbs | mixed versions (`here` heartbeat missing → legacy peers) | update together; nothing to do server-side |
| wishes stop arriving | `/wish` answers `closed` → `GITHUB_TOKEN` missing or expired | make a new fine-grained token, `wrangler secret put GITHUB_TOKEN` |
| players report "that place cannot be found" for short maps links | `/maps` 5xx or the Gate rate-limiting a shared NAT | check Cloudflare logs are off (they are); the per-sender gate is by /64 or IP — a campus will hit it; raise `GATE_RULES.maps` in `wishgate.js` if it is real |
| a release never publishes | the draft exists but an asset failed (`gh release view v<ver>`) | re-run the failed job; the build re-uploads with `--clobber` into the same draft |
| macOS users cannot open the app | Gatekeeper (not notarized) | right-click → open; notarization needs an Apple Developer account ($99/yr) — decision pending |
| a player's pin leaked into a room | they are on 2.0.1 or older | the 2.0.2 notes say what to do: leave the room code, open a new one, update together |

## 6. known gaps (as of 2026-10-20) and the plan

1. **dependencies** — fixed in 2.0.3: electron 44, vitest 5, overrides; `npm audit` 22 → 0. Keep `npm audit` at zero in the Build & Release test step.
2. **the relay was deployed by hand** — fixed by `relay-deploy.yml` once the two Cloudflare secrets are added.
3. **the service-worker number was bumped by hand** — fixed by `site-deploy.yml`.
4. **nothing watched the building** — fixed by `health.yml`.
5. **the atlas had no backup** — fixed by `atlas-backup.yml`.
6. **the room's keep/drop log forgot on hibernation** — fixed in 2.0.3's relay: it is stored in the Room's own storage (`evlog`).
7. **the relay lives on a `workers.dev` name that carries the account's handle** — a Workers custom domain `relay.thecornerspore.dev` is the fix (free; the zone is already on Cloudflare); the client then prefers it and keeps the old name as fallback. Planned for 2.1.0 so old clients keep working.
8. **itch.io mirror inactive** — pin `BUTLER_SHA256`, add `BUTLER_API_KEY`, confirm `ITCH_GAME`.
9. **macOS not notarized; Windows signing depends on `CSC_*` secrets being present** — owner decision.
10. **no uptime record of `/wish` token expiry** — monthly test wish; write the expiry date in §2.
