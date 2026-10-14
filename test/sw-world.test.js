// Both service workers (src/sw.js for the installed app shell, the one tools/build-play.sh writes for /play/), run against fakes:
// world.json goes to the network first — revalidated, so a granted wish reaches an installed copy on its next load — and the cached copy
// answers only when the network fails; everything else keeps its cache-first path.
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8').replace(/\r\n/g, '\n')
const build = read('tools/build-play.sh')
const SOURCES = {
  'src/sw.js': { js: read('src/sw.js'), origin: 'https://example.test', world: '/renderer/world.json', other: '/renderer/game.js' },
  // the heredoc build-play.sh writes, with its one substitution made
  'build-play.sh sw.js': {
    js: build.slice(build.indexOf('<<JS\n') + 5, build.indexOf('\nJS\n')).replace('${PLAY_SW_VERSION}', '99'),
    origin: 'https://example.test', world: '/play/world.json', other: '/play/game.js',
  },
}

// a worker world: one cache, a scripted network, the listeners the script registers
function boot(js, origin, net) {
  const listeners = {}
  const store = new Map()
  const calls = []
  const cache = { put: async (req, res) => { store.set(req.url, res) }, add: async () => {} }
  const caches = { open: async () => cache, match: async (req) => store.get(typeof req === 'string' ? req : req.url), keys: async () => [], delete: async () => true }
  const fetch = async (req, init) => { calls.push({ url: req.url, init }); return net(req, init) }
  const self = { location: { origin }, addEventListener: (t, f) => { listeners[t] = f }, skipWaiting: async () => {}, clients: { claim: async () => {} } }
  new Function('self', 'caches', 'fetch', js)(self, caches, fetch)
  const request = (p) => {
    let answer = null
    listeners.fetch({ request: { method: 'GET', url: origin + p, mode: 'cors' }, respondWith: (pr) => { answer = pr } })
    return answer
  }
  const res = (body) => ({ ok: true, body, clone() { return res(body) } })
  return { request, store, calls, res }
}

for (const [name, s] of Object.entries(SOURCES)) {
  describe(`${name}: world.json is network-first`, () => {
    it('asks the network first, revalidating past the HTTP cache, and keeps the fresh copy for offline', async () => {
      const w = boot(s.js, s.origin, () => w.res('fresh'))
      w.store.set(s.origin + s.world, w.res('stale'))
      const r = await w.request(s.world)
      expect(r.body).toBe('fresh')
      expect(w.calls).toEqual([{ url: s.origin + s.world, init: { cache: 'no-cache' } }])
      expect(w.store.get(s.origin + s.world).body).toBe('fresh')
    })
    it('offline, the cached copy answers', async () => {
      const w = boot(s.js, s.origin, () => { throw new TypeError('offline') })
      w.store.set(s.origin + s.world, w.res('cached'))
      expect((await w.request(s.world)).body).toBe('cached')
    })
    it('offline with nothing cached, the failure reaches world.js (which falls back to DEFAULT_CONFIG)', async () => {
      const w = boot(s.js, s.origin, () => { throw new TypeError('offline') })
      await expect(w.request(s.world)).rejects.toThrow('offline')
    })
    it('any other file is still served cache-first', async () => {
      const w = boot(s.js, s.origin, () => w.res('net'))
      w.store.set(s.origin + s.other, w.res('cached'))
      expect((await w.request(s.other)).body).toBe('cached')
      expect(w.calls).toEqual([])
    })
  })
}
