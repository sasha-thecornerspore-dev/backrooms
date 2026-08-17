// The Backrooms — PWA service worker.
// Precaches the app shell so the game installs and runs offline on ChromeOS /
// any browser. Cross-origin requests (the Cloudflare multiplayer relay) are
// never intercepted, so online play is unaffected. This file is only ever
// registered over http(s); under Electron's file:// it is never loaded.
const CACHE = 'backrooms-pwa-v6'
const SHELL = [
  '/renderer/index.html',
  '/renderer/game.js', '/renderer/touch.js', '/renderer/scraps.js', '/renderer/events.js', '/renderer/anchor.js', '/renderer/items.js', '/renderer/save.js',
  '/renderer/world.js', '/renderer/decor.js', '/renderer/fixedmap.js', '/renderer/level-null-map.js',
  '/renderer/levels.js', '/renderer/raycaster.js', '/renderer/renderer.js', '/renderer/entities.js',
  '/renderer/audio.js', '/renderer/prefs.js',
  '/net/client.js', '/settings.js',
  '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png',
]

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE)
    // add each individually so one renamed/missing file can't abort the install
    await Promise.allSettled(SHELL.map((u) => c.add(u)))
    await self.skipWaiting()
  })())
})

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k)
    await self.clients.claim()
  })())
})

self.addEventListener('fetch', (e) => {
  const req = e.request
  if (req.method !== 'GET') return
  if (new URL(req.url).origin !== self.location.origin) return // relay/api pass straight through
  e.respondWith((async () => {
    const cached = await caches.match(req)
    if (cached) return cached
    try {
      const res = await fetch(req)
      if (res.ok) { const c = await caches.open(CACHE); c.put(req, res.clone()) }
      return res
    } catch (err) {
      if (req.mode === 'navigate') {
        const idx = await caches.match('/renderer/index.html')
        if (idx) return idx
      }
      throw err
    }
  })())
})
