// src/renderer/wish-post.js — the one way a wish leaves the room, from the desktop app (main.js 'submit-wish') and from a browser
// (game.js, where there is no window.backrooms): a POST to the relay's /wish. No token rides in either.
import { describe, it, expect, vi } from 'vitest'
import { readFileSync, readdirSync } from 'fs'
import { WISH_URL, postWish } from '../src/renderer/wish-post.js'

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8')

describe('postWish', () => {
  it('posts { text, meta, version } as JSON to the relay and hands back its answer', async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ ok: true, number: 7 }), { status: 201 }))
    const text = 'make the fog warmer\nfiled under: EXTENSION · level 2'
    await expect(postWish(text, { origin: 'processed' }, { version: '2.0.0', fetch: f })).resolves.toEqual({ ok: true, number: 7 })
    expect(f).toHaveBeenCalledTimes(1)
    const [url, init] = f.mock.calls[0]
    expect(url).toBe(WISH_URL)
    expect(init.method).toBe('POST')
    expect(init.headers['content-type']).toBe('application/json')
    expect(JSON.parse(init.body)).toEqual({ text, meta: { origin: 'processed' }, version: '2.0.0' })
  })
  it('a browser knows no version and sends none; a missing meta goes as null', async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ ok: true, number: 8 }), { status: 201 }))
    await postWish('let me out', undefined, { fetch: f })
    expect(JSON.parse(f.mock.calls[0][1].body)).toEqual({ text: 'let me out', meta: null })
  })
  it('a refusal comes back as the relay said it; a page that is not the relay\'s answer as { ok: false }', async () => {
    const no = vi.fn(async () => new Response(JSON.stringify({ ok: false, reason: 'rate' }), { status: 429 }))
    await expect(postWish('x', null, { fetch: no })).resolves.toEqual({ ok: false, reason: 'rate' })
    const junk = vi.fn(async () => new Response('<html>bad gateway</html>', { status: 502 }))
    await expect(postWish('x', null, { fetch: junk })).resolves.toEqual({ ok: false, reason: 'http 502' })
    const down = vi.fn(async () => { throw new TypeError('Failed to fetch') })
    await expect(postWish('x', null, { fetch: down })).rejects.toThrow('Failed to fetch')     // the callers' catch keeps it silent
  })
  it('uses the global fetch when none is handed in', async () => {
    const f = vi.fn(async () => new Response('{"ok":true,"number":1}', { status: 201 }))
    vi.stubGlobal('fetch', f)
    try { await postWish('x', null) } finally { vi.unstubAllGlobals() }
    expect(f).toHaveBeenCalledTimes(1)
  })
})

describe('the address', () => {
  it('is the relay the online rooms already use, over https, at /wish', () => {
    expect(WISH_URL).toBe('https://backrooms-relay.jeff-schatz112.workers.dev/wish')
    const relay = /const RELAY_URL = '(wss:\/\/[^']+)'/.exec(read('../src/renderer/index.html'))[1]
    expect(WISH_URL).toBe(relay.replace(/^wss:/, 'https:') + '/wish')
  })
})

describe('no token anywhere in the app', () => {
  it('main.js posts through postWish and never talks to GitHub', () => {
    const main = read('../src/main.js')
    expect(main).toContain("from './renderer/wish-post.js'")
    expect(main).toContain('postWish(text, meta, { version: app.getVersion() })')
    for (const s of ['api.github.com', 'wishToken', 'Authorization', 'build-config', 'buildConfig']) expect([s, main.includes(s)]).toEqual([s, false])
  })
  it('no file the app or the browser build ships mentions a wish token, and the template for one is gone', () => {
    const files = ['src/main.js', 'src/preload.cjs', 'src/sw.js', ...readdirSync(new URL('../src/renderer/', import.meta.url)).map((f) => `src/renderer/${f}`)]
    for (const f of files.filter((x) => /\.(js|cjs|html|json)$/.test(x))) {
      expect([f, /wishToken|ISSUES_TOKEN|ghp_|github_pat_/.test(read(`../${f}`))]).toEqual([f, false])
    }
    expect(readdirSync(new URL('../src/', import.meta.url))).not.toContain('build-config.template.json')
  })
  it('the release workflow writes no build config and no secret into the app', () => {
    const yml = read('../.github/workflows/build-release.yml')
    expect(yml).not.toContain('ISSUES_TOKEN')
    expect(yml).not.toContain('wishToken')
    expect(yml).not.toContain('src/build-config.json')
  })
  it('an old build-config.json left on a maintainer\'s disk never rides into an installer', () => {
    const files = JSON.parse(read('../package.json')).build.files
    expect(files).toContain('!src/build-config.json')
    expect(files).not.toContain('!src/build-config.template.json')
  })
})

describe('game.js: a browser wish goes to the relay too', () => {
  const game = read('../src/renderer/game.js')
  const line = game.split('\n').find((l) => l.includes('window.backrooms?.submitWish'))
  it('imports postWish and calls it when there is no desktop bridge', () => {
    expect(game).toContain("import { postWish } from './wish-post.js'")
    expect(line.trim()).toBe('try { if (window.backrooms?.submitWish) await window.backrooms.submitWish(r.submit.text, r.submit.meta); else await postWish(r.submit.text, r.submit.meta) } catch (e) { /* silent */ }')
  })
  it('the line, run: the desktop bridge when there is one, the relay when not, and a failure stays silent', async () => {
    const AsyncFunction = (async () => {}).constructor
    const run = new AsyncFunction('window', 'r', 'postWish', line)
    const r = { submit: { text: 'let me out', meta: { origin: null } } }
    const sent = [], posted = []
    await run({ backrooms: { submitWish: async (t, m) => { sent.push([t, m]) } } }, r, async (t, m) => { posted.push([t, m]) })
    expect([sent, posted]).toEqual([[['let me out', { origin: null }]], []])
    await run({}, r, async (t, m) => { posted.push([t, m]) })
    expect(posted).toEqual([['let me out', { origin: null }]])
    await expect(run({}, r, async () => { throw new TypeError('Failed to fetch') })).resolves.toBeUndefined()
  })
})
