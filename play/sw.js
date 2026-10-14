// The Backrooms — PWA service worker (self-contained /play/ build).
// Precaches the whole game so it installs and runs offline. Cross-origin
// requests (the Cloudflare multiplayer relay) are never intercepted, and
// neither are the recovery-engine case manifests under /recover/ — those
// must always be live so a case can change without a cache bump. world.json
// is precached but fetched network-first: it changes with every granted wish.
const CACHE = 'backrooms-play-v22'
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
  'compose-polaroid.js', 'compose-radio.js', 'compose-wish.js', 'wish-post.js', 'compose-gates.js', 'evidence.js', 'caches.js', 'lightshare.js', 'site.js',
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
        if (res.ok) (await caches.open(CACHE)).put(req, res.clone())
        return res
      } catch (err) {
        const cached = await caches.match(req)
        if (cached) return cached
        throw err
      }
    })())
    return
  }
  // a navigation with a query (an invite link, /play/?room=CODE) is the same page: matched ignoring the query, never stored once per code
  e.respondWith((async () => {
    const cached = await caches.match(req, req.mode === 'navigate' ? { ignoreSearch: true } : undefined)
    if (cached) return cached
    try {
      const res = await fetch(req)
      if (res.ok && !(req.mode === 'navigate' && new URL(req.url).search)) { const c = await caches.open(CACHE); c.put(req, res.clone()) }
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
