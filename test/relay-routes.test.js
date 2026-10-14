// relay/relay.js's two HTTP routes and the Gate durable object, driven through the worker's own fetch handler. relay.js imports
// 'cloudflare:workers', which does not exist under node: a two-line stand-in for DurableObject is enough, because the routes
// only call the Gate through the stub env.GATE hands back. GitHub and Google are a fake global fetch that records every call.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'fs'

vi.mock('cloudflare:workers', () => ({ DurableObject: class { constructor(ctx, env) { this.ctx = ctx; this.env = env } } }))

const relay = (await import('../relay/relay.js'))
const worker = relay.default
const { Gate } = relay
const { hashIp, GATE_RULES } = await import('../relay/wishgate.js')

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8')
const SITE = 'https://backrooms.thecornerspore.dev'
const ITCH = 'https://html-classic.itch.zone'
const IP = '203.0.113.7'

// a Gate namespace whose instances are real Gate objects over in-memory storage — so the limits are the real ones
function gateNamespace() {
  const names = [], instances = new Map()
  const storage = () => {
    const m = new Map(); let alarm = null
    return {
      get: async (k) => m.get(k), put: async (k, v) => { m.set(k, v) }, deleteAll: async () => { m.clear() },
      setAlarm: async (t) => { alarm = t }, getAlarm: async () => alarm, _m: m,
    }
  }
  return {
    names, instances,
    idFromName: (n) => { names.push(n); return { name: n } },
    get: (id) => {
      if (!instances.has(id.name)) instances.set(id.name, new Gate({ storage: storage() }, {}))
      return instances.get(id.name)
    },
  }
}

let gh, env
beforeEach(() => {
  gh = []
  env = { GITHUB_TOKEN: 'tok_secret', GITHUB_REPO: 'sasha-thecornerspore-dev/backrooms', GATE: gateNamespace(), ROOM: null }
  vi.stubGlobal('fetch', vi.fn(async (url, init) => {
    gh.push({ url: String(url), init })
    if (String(url).startsWith('https://api.github.com/')) return new Response(JSON.stringify({ number: 42, html_url: 'x' }), { status: 201 })
    if (String(url) === 'https://maps.app.goo.gl/XUFcwN87E75DX3xY8') {
      return new Response(null, { status: 302, headers: { location: 'https://www.google.com/maps/search/39.297500,+-76.643000?entry=tts' } })
    }
    if (String(url) === 'https://maps.app.goo.gl/nowhere1') return new Response('a page, no redirect', { status: 200 })
    return new Response('no', { status: 404 })
  }))
})
afterEach(() => vi.unstubAllGlobals())

const wishReq = (body, { origin = SITE, ip = IP, raw } = {}) => new Request('https://backrooms-relay.jeff-schatz112.workers.dev/wish', {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(origin ? { Origin: origin } : {}), 'CF-Connecting-IP': ip },
  body: raw ?? JSON.stringify(body),
})
const mapsReq = (u, { origin = SITE, ip = IP } = {}) => new Request(`https://backrooms-relay.jeff-schatz112.workers.dev/maps?u=${encodeURIComponent(u)}`, {
  headers: { ...(origin ? { Origin: origin } : {}), 'CF-Connecting-IP': ip },
})

describe('the relay still answers what it always did', () => {
  it('a plain GET is the banner', async () => {
    const res = await worker.fetch(new Request('https://backrooms-relay.jeff-schatz112.workers.dev/'), env)
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('the backrooms relay is running.')
  })
})

describe('POST /wish', () => {
  it('files the issue the app always filed, with the relay\'s token, and answers { ok, number }', async () => {
    const text = 'make the fog warmer\nfiled under: EXTENSION · level 2'
    const res = await worker.fetch(wishReq({ text, meta: { origin: 'processed' }, version: '2.0.0' }), env)
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({ ok: true, number: 42 })
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(SITE)
    expect(gh.length).toBe(1)
    expect(gh[0].url).toBe('https://api.github.com/repos/sasha-thecornerspore-dev/backrooms/issues')
    expect(gh[0].init.headers.Authorization).toBe('Bearer tok_secret')
    expect(JSON.parse(gh[0].init.body)).toEqual({
      title: '[WISH] make the fog warmer',
      body: `${text}\n\n---\nsubmitted from backrooms v2.0.0`,
      labels: ['wish', 'pending', 'status:extension', 'amendment'],
    })
  })
  it('a browser wish (no version) from the itch CDN', async () => {
    const res = await worker.fetch(wishReq({ text: 'let me out', meta: { origin: null } }, { origin: ITCH }), env)
    expect(res.status).toBe(201)
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(ITCH)
    expect(JSON.parse(gh[0].init.body).body).toBe('let me out\n\n---\nsubmitted from backrooms on the web')
  })
  it('the desktop app\'s main process sends no Origin at all, and is let in', async () => {
    const res = await worker.fetch(wishReq({ text: 'let me out', meta: { origin: null }, version: '2.0.0' }, { origin: null }), env)
    expect(res.status).toBe(201)
  })
  it('the preflight: allowed origins get the CORS headers, others a 403', async () => {
    const ok = await worker.fetch(new Request('https://r.example/wish', { method: 'OPTIONS', headers: { Origin: 'null', 'Access-Control-Request-Method': 'POST' } }), env)
    expect(ok.status).toBe(204)
    expect(ok.headers.get('Access-Control-Allow-Origin')).toBe('null')
    expect(ok.headers.get('Access-Control-Allow-Headers')).toBe('content-type')
    const no = await worker.fetch(new Request('https://r.example/wish', { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } }), env)
    expect(no.status).toBe(403)
    expect(no.headers.get('Access-Control-Allow-Origin')).toBe(null)
  })
  it('refusals carry a reason and never reach GitHub', async () => {
    const cases = [
      [wishReq({ text: 'x' }, { origin: 'https://evil.example' }), 403, 'origin'],
      [wishReq(null, { raw: '{not json' }), 400, 'body'],
      [wishReq({ text: '' }), 400, 'text'],
      [wishReq({ text: 'x', meta: { origin: 'keeper' } }), 400, 'meta'],
      [wishReq({ text: 'x', labels: ['granted'] }), 400, 'body'],
      [wishReq({ text: 'make the ' + 'f' + 'aggot leave' }), 422, 'words'],
      [wishReq({ text: 'go to https://example.com' }), 422, 'spam'],
      [wishReq(null, { raw: JSON.stringify({ text: 'x'.repeat(5000) }) }), 413, 'body'],
    ]
    for (const [req, status, reason] of cases) {
      const res = await worker.fetch(req, env)
      expect([reason, res.status, await res.json()]).toEqual([reason, status, { ok: false, reason }])
    }
    const get = await worker.fetch(new Request('https://r.example/wish', { headers: { Origin: SITE } }), env)
    expect([get.status, await get.json()]).toEqual([405, { ok: false, reason: 'method' }])
    expect(gh).toEqual([])
    expect(env.GATE.names).toEqual([])                      // nothing a refusal decides costs a player one of their wishes
  })
  it('with no token set the relay files nothing: 503 closed', async () => {
    delete env.GITHUB_TOKEN
    const res = await worker.fetch(wishReq({ text: 'let me out' }), env)
    expect([res.status, await res.json()]).toEqual([503, { ok: false, reason: 'closed' }])
    expect(gh).toEqual([])
  })
  it('three in ten minutes from one address; the fourth is 429 rate with a Retry-After, and GitHub never sees it', async () => {
    for (let i = 0; i < 3; i++) expect((await worker.fetch(wishReq({ text: `wish ${i}` }), env)).status).toBe(201)
    const res = await worker.fetch(wishReq({ text: 'wish 3' }), env)
    expect([res.status, await res.json()]).toEqual([429, { ok: false, reason: 'rate' }])
    expect(Number(res.headers.get('Retry-After'))).toBeGreaterThan(0)
    expect(gh.length).toBe(3)
    expect((await worker.fetch(wishReq({ text: 'from elsewhere' }, { ip: '198.51.100.9' }), env)).status).toBe(201)
  })
  it('the gate is named by a salted hash of CF-Connecting-IP, never the address', async () => {
    await worker.fetch(wishReq({ text: 'let me out' }), env)
    expect(env.GATE.names.length).toBe(1)
    expect(env.GATE.names[0]).toBe(await hashIp(IP, 'backrooms-gate'))
    expect(env.GATE.names[0]).not.toContain(IP)
    env.IP_SALT = 'pepper'
    await worker.fetch(wishReq({ text: 'let me out again' }), env)
    expect(env.GATE.names[1]).toBe(await hashIp(IP, 'pepper'))
  })
  it('GitHub failing is 502 upstream', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })))
    const res = await worker.fetch(wishReq({ text: 'let me out' }), env)
    expect([res.status, await res.json()]).toEqual([502, { ok: false, reason: 'upstream' }])
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('down') }))
    const res2 = await worker.fetch(wishReq({ text: 'let me out' }), env)
    expect([res2.status, await res2.json()]).toEqual([502, { ok: false, reason: 'upstream' }])
  })
})

describe('GET /maps', () => {
  it('a short link comes back as { lat, lng } and nothing else', async () => {
    const res = await worker.fetch(mapsReq('https://maps.app.goo.gl/XUFcwN87E75DX3xY8?g_st=ic'), env)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ lat: 39.2975, lng: -76.643 })
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    expect(gh.map((c) => c.url)).toEqual(['https://maps.app.goo.gl/XUFcwN87E75DX3xY8'])
  })
  it('anything but a short link fetches nothing: 400 link', async () => {
    for (const u of ['https://evil.example/x', 'http://169.254.169.254/', 'https://www.google.com/maps/@1,2,17z', '']) {
      const res = await worker.fetch(mapsReq(u), env)
      expect([u, res.status, await res.json()]).toEqual([u, 400, { ok: false, reason: 'link' }])
    }
    const none = await worker.fetch(new Request('https://r.example/maps', { headers: { Origin: SITE } }), env)
    expect(none.status).toBe(400)
    expect(gh).toEqual([])
  })
  it('a link that leads nowhere is 422 nocoords, a dead one 502 upstream; a foreign origin 403; too many 429', async () => {
    const nowhere = await worker.fetch(mapsReq('https://maps.app.goo.gl/nowhere1'), env)
    expect([nowhere.status, await nowhere.json()]).toEqual([422, { ok: false, reason: 'nocoords' }])
    const dead = await worker.fetch(mapsReq('https://maps.app.goo.gl/deadbeef'), env)
    expect([dead.status, await dead.json()]).toEqual([502, { ok: false, reason: 'upstream' }])
    expect((await worker.fetch(mapsReq('https://maps.app.goo.gl/XUFcwN87E75DX3xY8', { origin: 'https://evil.example' }), env)).status).toBe(403)
    const n = GATE_RULES.maps[0].max
    let last
    for (let i = 0; i < n + 1; i++) last = await worker.fetch(mapsReq('https://maps.app.goo.gl/XUFcwN87E75DX3xY8', { ip: '192.0.2.1' }), env)
    expect([last.status, await last.json()]).toEqual([429, { ok: false, reason: 'rate' }])
  })
})

describe('Gate: one per hashed address, a list of recent take times, wiped a day after the last', () => {
  it('takes by the rules, sets the wipe a day out, and the alarm wipes it all', async () => {
    const store = new Map(); let alarm = null
    const g = new Gate({ storage: { get: async (k) => store.get(k), put: async (k, v) => { store.set(k, v) }, deleteAll: async () => { store.clear() }, setAlarm: async (t) => { alarm = t } } }, {})
    const t0 = Date.now()
    for (let i = 0; i < 3; i++) expect((await g.take('wish')).ok).toBe(true)
    const no = await g.take('wish')
    expect(no.ok).toBe(false)
    expect(no.retryMs).toBeGreaterThan(0)
    expect(store.get('wish').length).toBe(3)
    expect(alarm).toBeGreaterThanOrEqual(t0 + 86_400_000)
    expect(await g.take('nonsense')).toEqual({ ok: false, retryMs: 0 })
    await g.alarm()
    expect(store.size).toBe(0)
  })
})

describe('relay.js and its config', () => {
  it('logs nothing: no console call anywhere in the worker', () => {
    for (const f of ['../relay/relay.js', '../relay/wishgate.js', '../relay/mapslink.js']) expect([f, /console\./.test(read(f))]).toEqual([f, false])
  })
  it('wrangler.jsonc binds GATE, adds it in a v2 migration after v1, names the repo, and turns invocation logs off', () => {
    const cfg = JSON.parse(read('../relay/wrangler.jsonc'))
    expect(cfg.durable_objects.bindings).toEqual([{ name: 'ROOM', class_name: 'Room' }, { name: 'GATE', class_name: 'Gate' }])
    expect(cfg.migrations).toEqual([{ tag: 'v1', new_sqlite_classes: ['Room'] }, { tag: 'v2', new_sqlite_classes: ['Gate'] }])
    expect(cfg.vars.GITHUB_REPO).toBe('sasha-thecornerspore-dev/backrooms')
    expect(cfg.observability.logs.invocation_logs).toBe(false)
    expect(JSON.stringify(cfg)).not.toMatch(/GITHUB_TOKEN|IP_SALT/)    // secrets, set with `wrangler secret put`, never in the file
  })
})
