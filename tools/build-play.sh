#!/usr/bin/env bash
# usage: PLAY_SW_VERSION=22 bash tools/build-play.sh src <gh-pages>/play   (bump the version on every rebuild so clients refetch)
#        PLAY_TARGET=itch bash tools/build-play.sh src <dir>              (the same bundle for a portal: no counter, no service worker; tools/build-itch.sh)
#        GOATCOUNTER_CODE=<code>                                          (the site build's counter; default backrooms)
# Build a self-contained, path-independent PWA bundle of the game into $DEST.
# Flattens the ../net/ imports (client.js from index.html, evbus.js from game.js) so everything lives in one
# directory, giving clean relative paths that work at any mount point (/, /play/, etc).
set -euo pipefail
PLAY_SW_VERSION="${PLAY_SW_VERSION:-22}"
PLAY_TARGET="${PLAY_TARGET:-site}"                  # site = backrooms.thecornerspore.dev/play/ (the counter goes in) · itch = a portal zip (it never does)
GOATCOUNTER_CODE="${GOATCOUNTER_CODE:-backrooms}"   # the one constant: the site counts at https://<code>.goatcounter.com/count
SRC="${1:?src dir}"      # .../backrooms/src
DEST="${2:?dest dir}"    # .../play
case "$PLAY_TARGET" in site|itch) ;; *) echo "PLAY_TARGET must be site or itch (got '$PLAY_TARGET')" >&2; exit 1 ;; esac
# the code lands inside a URL in the page: a plain goatcounter code or nothing
[[ "$GOATCOUNTER_CODE" =~ ^[a-z0-9][a-z0-9-]*$ ]] || { echo "GOATCOUNTER_CODE must be a plain goatcounter code (a-z, 0-9, -), got '$GOATCOUNTER_CODE'" >&2; exit 1; }

rm -rf "$DEST"; mkdir -p "$DEST/icons"

# game modules (all ./ siblings) + the flattened multiplayer client and event bus
cp "$SRC"/renderer/*.js "$DEST"/            # renderer modules (excludes index.html)
cp "$SRC"/renderer/world.json "$DEST"/world.json   # world.js fetches ./world.json — without it a granted wish never reaches the browser
cp "$SRC"/net/client.js "$DEST"/client.js  # was ../net/client.js
cp "$SRC"/net/evbus.js "$DEST"/evbus.js    # was ../net/evbus.js
cp "$SRC"/icons/icon-192.png "$SRC"/icons/icon-512.png "$DEST"/icons/
# a renderer module that imports from ../net/ (game.js: the event bus) reads its flat sibling instead
for f in "$DEST"/*.js; do
  if grep -q "\.\./net/" "$f"; then
    sed -e "s#\.\./net/evbus\.js#./evbus.js#g" -e "s#\.\./net/client\.js#./client.js#g" "$f" > "$f.tmp" && mv "$f.tmp" "$f"
  fi
done
! grep -l "\.\./net/" "$DEST"/*.js || { echo "a ../net/ import survived the flattening" >&2; exit 1; }

# index.html: rewrite the 4 absolute/escaping paths to flat-relative
sed -e "s#\.\./net/client\.js#./client.js#g" \
    -e "s#href=\"/manifest\.webmanifest\"#href=\"manifest.webmanifest\"#" \
    -e "s#href=\"/icons/icon-192\.png\"#href=\"icons/icon-192.png\"#" \
    -e "s#register('/sw\.js')#register('sw.js')#" \
    "$SRC"/renderer/index.html > "$DEST"/index.html

# the counter (owner decision 2026-10-13): GoatCounter, cookieless, on the site's /play/ only — never the desktop app (it never runs
# this script), never a portal zip (PLAY_TARGET=itch). The counted path is pinned to /play/, so nothing after a ? is ever the path.
if [ "$PLAY_TARGET" = site ]; then
  GC_SETTINGS="<script>window.goatcounter = { path: '/play/' }</script>"
  GC_TAG="<script data-goatcounter=\"https://${GOATCOUNTER_CODE}.goatcounter.com/count\" async src=\"//gc.zgo.at/count.js\"></script>"
  awk -v a="  $GC_SETTINGS" -v b="  $GC_TAG" '!done && /<\/head>/ { print a; print b; done = 1 } { print }' "$DEST"/index.html > "$DEST"/index.html.tmp
  mv "$DEST"/index.html.tmp "$DEST"/index.html
  [ "$(grep -c 'data-goatcounter=' "$DEST"/index.html)" = 1 ] || { echo "the counter was not injected exactly once" >&2; exit 1; }
fi

# a portal copy installs no service worker (growth-spec §3.2): it runs framed, and its origin (html-classic.itch.zone) is shared with
# every other game there — where this worker's activate step would clear caches that are not ours
if [ "$PLAY_TARGET" = itch ]; then
  sed -e "s#if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {#if (false) {   // a portal build registers no service worker (tools/build-play.sh)#" \
    "$DEST"/index.html > "$DEST"/index.html.tmp
  mv "$DEST"/index.html.tmp "$DEST"/index.html
  grep -q "if (false) {   // a portal build registers no service worker" "$DEST"/index.html || { echo "the service-worker registration was not found to switch off" >&2; exit 1; }
fi

# the licences travel with every copy: MIT for the code, CC BY-SA 3.0 for the lore (share-alike wants its notice beside the work)
for f in LICENSE LICENSE-LORE.md; do [ ! -f "$SRC/../$f" ] || cp "$SRC/../$f" "$DEST/$f"; done

cat > "$DEST"/manifest.webmanifest <<'JSON'
{
  "name": "The Backrooms",
  "short_name": "Backrooms",
  "description": "Infinite procedural horror maze. Level ∅. You are here.",
  "id": "./",
  "start_url": "./",
  "scope": "./",
  "display": "fullscreen",
  "display_override": ["fullscreen", "standalone"],
  "orientation": "landscape",
  "background_color": "#000000",
  "theme_color": "#c9ba72",
  "icons": [
    { "src": "icons/icon-192.png", "sizes": "192x192", "type": "image/png", "purpose": "any maskable" },
    { "src": "icons/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any maskable" }
  ]
}
JSON

if [ "$PLAY_TARGET" = site ]; then   # (a portal build registers none: see above)
cat > "$DEST"/sw.js <<JS
// The Backrooms — PWA service worker (self-contained /play/ build).
// Precaches the whole game so it installs and runs offline. Cross-origin
// requests (the Cloudflare multiplayer relay) are never intercepted, and
// neither are the recovery-engine case manifests under /recover/ — those
// must always be live so a case can change without a cache bump. world.json
// is precached but fetched network-first: it changes with every granted wish.
const CACHE = 'backrooms-play-v${PLAY_SW_VERSION}'
const SHELL = [
  './', 'index.html', 'world.json',
  'game.js', 'touch.js', 'scraps.js', 'events.js', 'anchor.js', 'items.js', 'tactics.js', 'save.js', 'world.js', 'decor.js',
  'fixedmap.js', 'level-null-map.js', 'levels.js', 'raycaster.js', 'renderer.js',
  'gfx-util.js', 'gfx-textures.js', 'gfx-world.js', 'gfx-sprites.js', 'gfx-post.js', 'gfx-cpu.js', 'gfx-sky.js', 'gfx-light.js', 'gfx-quality.js', 'gfx-attract.js',
  'gfx-frame.js', 'gfx-gl-g4-validate.js', 'gfx-gl-post-math.js', 'gfx-gl-post-particles.js', 'gfx-gl-post-shaders.js', 'gfx-gl-sprites-atlas.js', 'gfx-gl-sprites-plan.js', 'gfx-gl.js', 'gfx-gl-util.js', 'gfx-gl-world.js', 'gfx-gl-world-data.js', 'gfx-gl-world-shader.js', 'gfx-gl-sprites.js', 'gfx-gl-post.js', 'gfx-stats.js', 'gfx-bench.js',
  'entities.js', 'audio.js', 'prefs.js', 'messages.js', 'input.js', 'client.js', 'evbus.js',
  'collide.js', 'placement.js', 'reach.js', 'feedback.js',
  'hunt.js', 'variants.js', 'ward.js', 'tension.js',
  'topology.js', 'levelmem.js', 'death.js', 'channels.js',
  'fogmap.js', 'sightpins.js', 'mapcard.js', 'compass.js',
  'dress.js', 'containers.js', 'haunts.js', 'papercard.js',
  'origin-intake.js', 'origin-rules.js', 'origin-tenant.js', 'origin-anchored.js', 'origin-processed.js', 'origin-unnamed.js', 'origin-thin.js',
  'compose-perception.js', 'stillness.js', 'compose-sanity.js', 'rollcall.js', 'downed.js', 'status.js', 'closings.js', 'docket.js',
  'compose-polaroid.js', 'compose-radio.js', 'compose-wish.js', 'compose-gates.js', 'evidence.js', 'caches.js', 'lightshare.js',
  'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png',
]
self.addEventListener('install', (e) => e.waitUntil((async () => {
  const c = await caches.open(CACHE)
  await Promise.allSettled(SHELL.map((u) => c.add(u)))
  await self.skipWaiting()
})()))
self.addEventListener('activate', (e) => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k)
  await self.clients.claim()
})()))
self.addEventListener('fetch', (e) => {
  const req = e.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  if (url.origin !== self.location.origin) return
  if (url.pathname.includes('/recover/')) return   // trail manifests stay live — never cached
  // world.json changes with every granted wish: the network first (revalidated, never a stale HTTP-cache copy), the cache only offline
  if (url.pathname.endsWith('/world.json')) {
    e.respondWith((async () => {
      try {
        const res = await fetch(req, { cache: 'no-cache' })
        if (res.ok) { const c = await caches.open(CACHE); c.put(req, res.clone()) }
        return res
      } catch (err) {
        const cached = await caches.match(req)
        if (cached) return cached
        throw err
      }
    })())
    return
  }
  e.respondWith((async () => {
    const cached = await caches.match(req)
    if (cached) return cached
    try {
      const res = await fetch(req)
      if (res.ok) { const c = await caches.open(CACHE); c.put(req, res.clone()) }
      return res
    } catch (err) {
      if (req.mode === 'navigate') {
        const idx = (await caches.match('index.html')) || (await caches.match('./'))
        if (idx) return idx
      }
      throw err
    }
  })())
})
JS
grep -q "backrooms-play-v${PLAY_SW_VERSION}'" "$DEST"/sw.js || { echo "sw.js cache name not substituted" >&2; exit 1; }
fi

echo "built $DEST:"
ls "$DEST" | sed 's/^/  /'
echo "  index.html import rewrite -> $(grep -c "'./client.js'" "$DEST"/index.html) match(es)"
echo "  game.js import rewrite -> $(grep -c "'./evbus.js'" "$DEST"/game.js || true) match(es)"
echo "  target $PLAY_TARGET · counter -> $(if [ "$PLAY_TARGET" = site ]; then echo "https://$GOATCOUNTER_CODE.goatcounter.com/count"; else echo none; fi)"
