// The Backrooms — PWA service worker (self-contained /play/ build).
// Precaches the whole game so it installs and runs offline. Cross-origin
// requests (the Cloudflare multiplayer relay) are never intercepted.
const CACHE = 'backrooms-play-v7'
const SHELL = [
  './', 'index.html',
  'game.js', 'touch.js', 'scraps.js', 'events.js', 'anchor.js', 'items.js', 'save.js', 'world.js', 'decor.js',
  'fixedmap.js', 'level-null-map.js', 'levels.js', 'raycaster.js', 'renderer.js',
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
