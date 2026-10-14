// relay/mapslink.js — a phone's Google Maps share link (Share → Copy link gives maps.app.goo.gl/<id>, with no coordinates in
// it) resolved to the pin it points at, for GET /maps. Only the two short-link hosts are ever fetched first, and only Google
// Maps URLs after that; the coordinates are read by src/renderer/anchor.js's parser, the one the title screen uses.
//
// The redirect fixtures are real Location headers of maps.app.goo.gl links, as printed by `curl -I` in a public bug report
// (github.com/minad/osm/issues/56, 2026-01-23): a place shared from its card, a right-click "share this location" near a
// landmark, and one in open ground (the dropped pin, which lands on /maps/search/<lat>,+<lng>). The Baltimore ones are the
// same shapes with this game's own block in them.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { SHORT_HOSTS, MAX_REDIRECTS, shortLink, readHop, resolveShortLink } from '../relay/mapslink.js'
import { parseAnchor } from '../src/renderer/anchor.js'

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8')

const LOC = {
  place: 'https://www.google.com/maps/place/Eiffel+Tower/@48.8606054,2.3149334,13z/data=!4m6!3m5!1s0x47e66e2964e34e2d:0x8ddca9ee380ef7e0!8m2!3d48.8583701!4d2.2944813!16zL20vMDJqODE?entry=tts&g_ep=EgoyMDI2MDEyMS4wIPu8ASoASAFQAw%3D%3D&skid=8dac7003-872c-4229-b9a8-f4c71bd67c60',
  nearPoi: 'https://www.google.com/maps/place/Eiffel+Tower/data=!4m7!3m6!1s0x47e66fe1f3bfb4ad:0x7bd31375becf28cd!8m2!3d48.8584011!4d2.294499!16s%2Fg%2F11bbrgffb2!19sChIJrbS_8-Fv5kcRzSjPvnUT03s?entry=tts&g_ep=EgoyMDI2MDEyMS4wIPu8ASoASAFQAw%3D%3D&skid=2c00aadf-a137-43cb-b446-12bf7f1a3fbc',
  droppedPin: 'https://www.google.com/maps/search/48.861500,+2.300271?entry=tts&g_ep=EgoyMDI2MDEyMS4wIPu8ASoASAFQAw%3D%3D&skid=728c6fbc-a4c3-423d-8770-bcd061ab85d5',
  baltimorePin: 'https://www.google.com/maps/search/39.297500,+-76.643000?entry=tts&g_ep=EgoyMDI2MDEyMS4wIPu8ASoASAFQAw%3D%3D&skid=00000000-0000-4000-8000-000000000000',
  baltimorePlace: 'https://www.google.com/maps/place/Harlem+Park,+Baltimore,+MD/@39.2975,-76.6430,16z/data=!3m1!4b1!4m6!3m5!1s0x89c8049c3f5b2a4f:0x0!8m2!3d39.2972!4d-76.6427!16s?entry=tts',
  noCoords: 'https://maps.google.com/?q=Harlem+Park,+Baltimore,+MD&ftid=0x89c8049c3f5b2a4f:0x1f5c1b2a3d4e5f60&entry=gps',
}

describe('shortLink: only the two short-link forms, rebuilt from the id', () => {
  it('names the two hosts and caps the hops', () => {
    expect(SHORT_HOSTS).toEqual(['maps.app.goo.gl', 'goo.gl'])
    expect(MAX_REDIRECTS).toBe(3)
  })
  it('accepts https://maps.app.goo.gl/<id> and https://goo.gl/maps/<id>, and the share sheet\'s ?g_st= tag (dropped)', () => {
    expect(shortLink('https://maps.app.goo.gl/XUFcwN87E75DX3xY8')).toBe('https://maps.app.goo.gl/XUFcwN87E75DX3xY8')
    expect(shortLink('https://maps.app.goo.gl/4nkvfo8BFUnTPzBq9?g_st=ic')).toBe('https://maps.app.goo.gl/4nkvfo8BFUnTPzBq9')
    expect(shortLink('https://maps.app.goo.gl/2xLbT7d8kXtWBVEh6?g_st=com.google.maps.preview.copy')).toBe('https://maps.app.goo.gl/2xLbT7d8kXtWBVEh6')
    expect(shortLink('https://goo.gl/maps/5c6ZmT4Wq8T2')).toBe('https://goo.gl/maps/5c6ZmT4Wq8T2')
    expect(shortLink('  https://maps.app.goo.gl/XUFcwN87E75DX3xY8  ')).toBe('https://maps.app.goo.gl/XUFcwN87E75DX3xY8')
  })
  it('refuses everything else — no other host is ever fetched', () => {
    for (const u of ['http://maps.app.goo.gl/XUFcwN87E75DX3xY8', 'maps.app.goo.gl/XUFcwN87E75DX3xY8', 'https://maps.app.goo.gl.evil.example/abcd',
      'https://maps.app.goo.gl@evil.example/abcd', 'https://evil.example/https://maps.app.goo.gl/abcd', 'https://maps.app.goo.gl/abcd/../../x',
      'https://maps.app.goo.gl/abcd?x=1', 'https://maps.app.goo.gl/abcd#frag', 'https://maps.app.goo.gl/', 'https://maps.app.goo.gl/abc',
      'https://goo.gl/abcdef', 'https://goo.gl/maps/abcd/extra', 'https://maps.app.goo.gl:8443/abcd', 'https://maps.app.goo.gl/' + 'a'.repeat(65),
      'https://www.google.com/maps/@40.7,-74.0,17z', 'javascript:alert(1)', '', null, undefined, 42, ['https://maps.app.goo.gl/abcd']]) {
      expect([u, shortLink(u)]).toEqual([u, null])
    }
  })
})

describe('readHop: one Location, read', () => {
  it('reads the pin with anchor.js\'s parser — the pin over the map centre, the dropped pin\'s search form', () => {
    expect(readHop(LOC.place, 'https://maps.app.goo.gl/XUFcwN87E75DX3xY8')).toEqual({ lat: 48.8583701, lng: 2.2944813 })
    expect(readHop(LOC.nearPoi, 'https://maps.app.goo.gl/RGqeepWkXZvL6hdu9')).toEqual({ lat: 48.8584011, lng: 2.294499 })
    expect(readHop(LOC.droppedPin, 'https://maps.app.goo.gl/9Siqc1oagRHhB3sAA')).toEqual({ lat: 48.8615, lng: 2.300271 })
    expect(readHop(LOC.baltimorePin, 'https://maps.app.goo.gl/x1y2z3')).toEqual({ lat: 39.2975, lng: -76.643 })
    expect(readHop(LOC.baltimorePlace, 'https://maps.app.goo.gl/x1y2z3')).toEqual({ lat: 39.2972, lng: -76.6427 })
    for (const k of Object.keys(LOC)) {
      const h = readHop(LOC[k], 'https://maps.app.goo.gl/abcd')
      if (h.lat != null) expect(h).toEqual(parseAnchor(new URL(LOC[k]).href))
    }
  })
  it('a Google Maps URL with no pin in it is the next hop; maps.google.com without one is the end', () => {
    expect(readHop('https://www.google.com/maps?q=Harlem+Park&ftid=0x1:0x2', 'https://maps.app.goo.gl/abcd'))
      .toEqual({ follow: 'https://www.google.com/maps?q=Harlem+Park&ftid=0x1:0x2' })
    expect(readHop('/maps/place/Harlem+Park', 'https://www.google.com/maps?q=x')).toEqual({ follow: 'https://www.google.com/maps/place/Harlem+Park' })
    expect(readHop('https://goo.gl/maps/5c6ZmT4Wq8T2', 'https://goo.gl/maps/abcd')).toEqual({ follow: 'https://goo.gl/maps/5c6ZmT4Wq8T2' })
    expect(readHop(LOC.noCoords, 'https://goo.gl/maps/abcd')).toEqual({ reason: 'nocoords' })
    expect(readHop('https://maps.google.com/?q=51.5007,-0.1246', 'https://goo.gl/maps/abcd')).toEqual({ lat: 51.5007, lng: -0.1246 })
  })
  it('a consent wall is read, never fetched: the pin in its continue= URL, or nothing', () => {
    const c = 'https://consent.google.com/m?continue=' + encodeURIComponent(LOC.place) + '&gl=DE&m=0&pc=m&uxe=eomtm&cm=2&hl=en&src=1'
    expect(readHop(c, 'https://maps.app.goo.gl/abcd')).toEqual({ lat: 48.8583701, lng: 2.2944813 })
    expect(readHop('https://consent.google.com/m?continue=' + encodeURIComponent('https://www.google.com/maps?q=x'), 'https://maps.app.goo.gl/abcd'))
      .toEqual({ reason: 'nocoords' })
    expect(readHop('https://consent.google.com/m?continue=' + encodeURIComponent('https://evil.example/@1,2'), 'https://maps.app.goo.gl/abcd'))
      .toEqual({ reason: 'badredirect' })
  })
  it('anywhere else is refused, coordinates or not', () => {
    for (const l of ['https://evil.example/maps/@39.29,-76.61,17z', 'http://www.google.com/maps/@39.29,-76.61,17z', 'https://www.google.com.evil.example/maps/@1,2',
      'https://www.google.com@evil.example/maps/@1,2', 'https://www.google.com:8080/maps/@1,2', 'https://user:pw@www.google.com/maps/@1,2',
      'https://www.google.com/search?q=1,2', 'https://www.google.com/url?q=https://evil.example', 'https://accounts.google.com/maps', 'data:text/plain,1,2',
      'file:///etc/passwd', 'http://169.254.169.254/latest/meta-data', 'https://[::1]/maps', '', null]) {
      expect([l, readHop(l, 'https://maps.app.goo.gl/abcd')]).toEqual([l, { reason: 'badredirect' }])
    }
  })
  it('mapslink.js reads coordinates through anchor.js, imported (one parser for the field and the relay)', () => {
    const src = read('../relay/mapslink.js')
    expect(src).toContain("import { parseAnchor } from '../src/renderer/anchor.js'")
    expect(src).not.toMatch(/console\./)
  })
})

// a fake fetch: a map of url → Location (or a status), recording every call
function fakeFetch(routes) {
  const calls = []
  const fn = async (url, init) => {
    calls.push({ url, init })
    const r = routes[url]
    if (r instanceof Error) throw r
    if (r == null) return { status: 404, ok: false, headers: new Map() }
    if (typeof r === 'number') return { status: r, ok: r < 300, headers: new Map() }
    return { status: 302, ok: false, headers: new Map([['location', r]]) }
  }
  return { fn, calls }
}

describe('resolveShortLink: at most three redirects, every one of them to Google Maps', () => {
  it('a place share resolves in one fetch, of the rebuilt short link, without following anything', async () => {
    const f = fakeFetch({ 'https://maps.app.goo.gl/XUFcwN87E75DX3xY8': LOC.place })
    expect(await resolveShortLink('https://maps.app.goo.gl/XUFcwN87E75DX3xY8?g_st=ic', f.fn)).toEqual({ lat: 48.8583701, lng: 2.2944813 })
    expect(f.calls.map((c) => c.url)).toEqual(['https://maps.app.goo.gl/XUFcwN87E75DX3xY8'])
    expect(f.calls[0].init.redirect).toBe('manual')
    expect(f.calls[0].init.method).toBe('GET')
  })
  it('a dropped pin resolves too (the /maps/search/<lat>,+<lng> form)', async () => {
    const f = fakeFetch({ 'https://maps.app.goo.gl/9Siqc1oagRHhB3sAA': LOC.droppedPin })
    expect(await resolveShortLink('https://maps.app.goo.gl/9Siqc1oagRHhB3sAA', f.fn)).toEqual({ lat: 48.8615, lng: 2.300271 })
  })
  it('an old goo.gl/maps link that hops to maps.app.goo.gl and then to the place: two fetches', async () => {
    const f = fakeFetch({ 'https://goo.gl/maps/5c6ZmT4Wq8T2': 'https://maps.app.goo.gl/XUFcwN87E75DX3xY8', 'https://maps.app.goo.gl/XUFcwN87E75DX3xY8': LOC.baltimorePlace })
    expect(await resolveShortLink('https://goo.gl/maps/5c6ZmT4Wq8T2', f.fn)).toEqual({ lat: 39.2972, lng: -76.6427 })
    expect(f.calls.length).toBe(2)
  })
  it('a chain of pinless Google Maps redirects stops after three follows (four fetches), nocoords', async () => {
    const f = fakeFetch({
      'https://maps.app.goo.gl/abcd': 'https://www.google.com/maps?q=a',
      'https://www.google.com/maps?q=a': 'https://www.google.com/maps?q=b',
      'https://www.google.com/maps?q=b': 'https://www.google.com/maps?q=c',
      'https://www.google.com/maps?q=c': 'https://www.google.com/maps?q=d',
      'https://www.google.com/maps?q=d': LOC.place,
    })
    expect(await resolveShortLink('https://maps.app.goo.gl/abcd', f.fn)).toEqual({ reason: 'nocoords' })
    expect(f.calls.length).toBe(1 + MAX_REDIRECTS)
    expect(f.calls.map((c) => c.url)).not.toContain('https://www.google.com/maps?q=d')
  })
  it('a redirect off Google Maps is never fetched', async () => {
    const f = fakeFetch({ 'https://maps.app.goo.gl/abcd': 'http://169.254.169.254/latest/meta-data' })
    expect(await resolveShortLink('https://maps.app.goo.gl/abcd', f.fn)).toEqual({ reason: 'badredirect' })
    expect(f.calls.length).toBe(1)
  })
  it('no redirect, a dead link, a network error', async () => {
    expect(await resolveShortLink('https://maps.app.goo.gl/abcd', fakeFetch({ 'https://maps.app.goo.gl/abcd': 200 }).fn)).toEqual({ reason: 'nocoords' })
    expect(await resolveShortLink('https://maps.app.goo.gl/abcd', fakeFetch({}).fn)).toEqual({ reason: 'upstream' })
    expect(await resolveShortLink('https://maps.app.goo.gl/abcd', fakeFetch({ 'https://maps.app.goo.gl/abcd': new Error('boom') }).fn)).toEqual({ reason: 'upstream' })
  })
  it('a link that is not a short link fetches nothing', async () => {
    const f = fakeFetch({})
    expect(await resolveShortLink('https://evil.example/x', f.fn)).toEqual({ reason: 'link' })
    expect(f.calls).toEqual([])
  })
  it('every URL it ever fetches is a short link or https://(www.)google.com/maps', async () => {
    const f = fakeFetch({
      'https://goo.gl/maps/abcd': 'https://maps.app.goo.gl/efgh',
      'https://maps.app.goo.gl/efgh': '/maps?q=x',
      'https://maps.app.goo.gl/maps?q=x': LOC.place,
    })
    await resolveShortLink('https://goo.gl/maps/abcd', f.fn)
    for (const { url } of f.calls) expect(url).toMatch(/^https:\/\/(?:(?:maps\.app\.goo\.gl\/[A-Za-z0-9_-]+)|(?:goo\.gl\/maps\/[A-Za-z0-9_-]+)|(?:(?:www\.)?google\.com\/maps(?:[/?].*)?))$/)
  })
})
