// The Backrooms — PWA service worker (self-contained /play/ build).
// Precaches the whole game so it installs and runs offline. Cross-origin
// requests (the Cloudflare multiplayer relay) are never intercepted, and
// neither are the recovery-engine case manifests under /recover/ — those
// must always be live so a case can change without a cache bump.
const CACHE = 'backrooms-play-v17'
const SHELL = [
  './', 'index.html',
  'game.js', 'touch.js', 'scraps.js', 'events.js', 'anchor.js', 'items.js', 'save.js', 'world.js', 'decor.js',
  'fixedmap.js', 'level-null-map.js', 'levels.js', 'raycaster.js', 'renderer.js',
  'gfx-util.js', 'gfx-textures.js', 'gfx-world.js', 'gfx-sprites.js', 'gfx-post.js', 'gfx-cpu.js', 'gfx-sky.js', 'gfx-light.js', 'gfx-quality.js', 'gfx-attract.js',
  'gfx-frame.js', 'gfx-gl-g4-validate.js', 'gfx-gl-post-math.js', 'gfx-gl-post-particles.js', 'gfx-gl-post-shaders.js', 'gfx-gl-sprites-atlas.js', 'gfx-gl-sprites-plan.js', 'gfx-gl.js', 'gfx-gl-util.js', 'gfx-gl-world.js', 'gfx-gl-world-data.js', 'gfx-gl-world-shader.js', 'gfx-gl-sprites.js', 'gfx-gl-post.js',
  'entities.js', 'audio.js', 'prefs.js', 'client.js',
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
