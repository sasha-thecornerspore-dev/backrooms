#!/usr/bin/env bash
# usage: PLAY_SW_VERSION=14 bash tools/build-play.sh src <gh-pages>/play   (bump the version on every rebuild so clients refetch)
# Build a self-contained, path-independent PWA bundle of the game into $DEST.
# Flattens the one ../net/client.js import so everything lives in one directory,
# giving clean relative paths that work at any mount point (/, /play/, etc).
set -euo pipefail
PLAY_SW_VERSION="${PLAY_SW_VERSION:-19}"
SRC="${1:?src dir}"      # .../backrooms/src
DEST="${2:?dest dir}"    # .../play

rm -rf "$DEST"; mkdir -p "$DEST/icons"

# game modules (all ./ siblings) + the flattened multiplayer client
cp "$SRC"/renderer/*.js "$DEST"/            # renderer modules (excludes index.html)
cp "$SRC"/net/client.js "$DEST"/client.js  # was ../net/client.js
cp "$SRC"/icons/icon-192.png "$SRC"/icons/icon-512.png "$DEST"/icons/

# index.html: rewrite the 4 absolute/escaping paths to flat-relative
sed -e "s#\.\./net/client\.js#./client.js#g" \
    -e "s#href=\"/manifest\.webmanifest\"#href=\"manifest.webmanifest\"#" \
    -e "s#href=\"/icons/icon-192\.png\"#href=\"icons/icon-192.png\"#" \
    -e "s#register('/sw\.js')#register('sw.js')#" \
    "$SRC"/renderer/index.html > "$DEST"/index.html

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

cat > "$DEST"/sw.js <<JS
// The Backrooms — PWA service worker (self-contained /play/ build).
// Precaches the whole game so it installs and runs offline. Cross-origin
// requests (the Cloudflare multiplayer relay) are never intercepted, and
// neither are the recovery-engine case manifests under /recover/ — those
// must always be live so a case can change without a cache bump.
const CACHE = 'backrooms-play-v${PLAY_SW_VERSION}'
const SHELL = [
  './', 'index.html',
  'game.js', 'touch.js', 'scraps.js', 'events.js', 'anchor.js', 'items.js', 'tactics.js', 'save.js', 'world.js', 'decor.js',
  'fixedmap.js', 'level-null-map.js', 'levels.js', 'raycaster.js', 'renderer.js',
  'gfx-util.js', 'gfx-textures.js', 'gfx-world.js', 'gfx-sprites.js', 'gfx-post.js', 'gfx-cpu.js', 'gfx-sky.js', 'gfx-light.js', 'gfx-quality.js', 'gfx-attract.js',
  'gfx-frame.js', 'gfx-gl-g4-validate.js', 'gfx-gl-post-math.js', 'gfx-gl-post-particles.js', 'gfx-gl-post-shaders.js', 'gfx-gl-sprites-atlas.js', 'gfx-gl-sprites-plan.js', 'gfx-gl.js', 'gfx-gl-util.js', 'gfx-gl-world.js', 'gfx-gl-world-data.js', 'gfx-gl-world-shader.js', 'gfx-gl-sprites.js', 'gfx-gl-post.js', 'gfx-stats.js', 'gfx-bench.js',
  'entities.js', 'audio.js', 'prefs.js', 'messages.js', 'input.js', 'client.js',
  'collide.js', 'placement.js', 'reach.js', 'feedback.js',
  'hunt.js', 'variants.js', 'ward.js', 'tension.js',
  'topology.js', 'levelmem.js', 'death.js', 'channels.js',
  'fogmap.js', 'sightpins.js', 'mapcard.js', 'compass.js',
  'dress.js', 'containers.js', 'haunts.js',
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
  if (new URL(req.url).origin !== self.location.origin) return
  if (new URL(req.url).pathname.includes('/recover/')) return   // trail manifests stay live — never cached
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

echo "built $DEST:"
ls "$DEST" | sed 's/^/  /'
echo "  index.html import rewrite -> $(grep -c "'./client.js'" "$DEST"/index.html) match(es)"
