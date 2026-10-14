// site.js — where the game lives on the web (growth-spec §1.2, launch-fixes F5 / F7): the invite link a friend opens, the case board's
// address off the site, the LAN buttons an https page cannot use, the phone's short maps link through the relay, and /invite's pin
// opt-in. Pure functions, so every rule is pinned here; index.html and game.js only wire them (test/invite-wiring.test.js).
import { describe, it, expect, vi } from 'vitest'
import {
  SITE_ORIGIN, PLAY_URL, RELAY_HTTP, ROOM_MAX, RECOVER_LOCAL, RECOVER_SITE, ANCHOR_NOT_FOUND, ANCHOR_LOOKING, PIN_WARNING, PIN_AGAIN,
  NO_DOOR_LINE, NO_PIN_LINE, NO_FIELD_PIN, lanLine, normalizeRoom, readInvite, buildInvite, isOwnSite, recoverBase, lanReachable,
  shortMapsLink, shortLinkQuery, pinFromResolver, resolveShortLink, inviteFor,
} from '../src/renderer/site.js'
import { anchorSeed } from '../src/renderer/anchor.js'

describe('the addresses', () => {
  it('the site, /play/ and the relay are the public ones', () => {
    expect(SITE_ORIGIN).toBe('https://backrooms.thecornerspore.dev')
    expect(PLAY_URL).toBe('https://backrooms.thecornerspore.dev/play/')
    expect(RELAY_HTTP).toBe('https://backrooms-relay.jeff-schatz112.workers.dev')
    expect(ROOM_MAX).toBe(32)
    expect(RECOVER_LOCAL).toBe('../recover/cases/')
    expect(RECOVER_SITE).toBe('https://backrooms.thecornerspore.dev/recover/cases/')
  })
  it('the lines are the ones the owner signed off', () => {
    expect(ANCHOR_NOT_FOUND).toBe("that place cannot be found. short links don't work yet: paste the full link from a computer's address bar, or the two numbers.")
    expect(PIN_WARNING).toBe("a pin in a link is a place in a link. don't share your home.")
    for (const s of [ANCHOR_NOT_FOUND, ANCHOR_LOOKING, PIN_WARNING, PIN_AGAIN, NO_DOOR_LINE, NO_PIN_LINE, NO_FIELD_PIN]) {
      expect(s).toBe(s.toLowerCase())
      expect(s).not.toContain('!')
    }
    // (the LAN line names the title screen's button as it is printed on it)
    expect(lanLine({ code: 'r', lan: 'ws://x' })).toBe('this room is on your network. a friend uses JOIN LAN → ws://x · room r.')
  })
})

describe('normalizeRoom: a room code as the relay will see it', () => {
  it('trims, strips control characters, cuts at 32 and keeps the case', () => {
    expect(normalizeRoom('  yellow-lamp-42  ')).toBe('yellow-lamp-42')
    expect(normalizeRoom('a'.repeat(40))).toBe('a'.repeat(32))
    expect(normalizeRoom('Yellow\u0007Lamp')).toBe('YellowLamp')
    expect(normalizeRoom('YellowLamp')).toBe('YellowLamp')
  })
  it('nothing is null', () => {
    for (const v of ['  ', '', null, undefined, '\u0000', '\u0000\u001f ']) expect(normalizeRoom(v)).toBe(null)
  })
})

describe('the invite link: /play/?room=CODE[&anchor=LAT,LNG]', () => {
  it('builds the room-only link by default', () => {
    expect(buildInvite({ room: 'yellow-lamp-42' })).toBe('https://backrooms.thecornerspore.dev/play/?room=yellow-lamp-42')
    expect(buildInvite({ room: 'r' })).not.toContain('anchor=')
  })
  it('no room, no link', () => {
    expect(buildInvite({ room: '' })).toBe(null)
    expect(buildInvite({ room: '   ' })).toBe(null)
    expect(buildInvite()).toBe(null)
  })
  it('round-trips any code through the URL', () => {
    for (const room of ['a b/ç?&#', 'YellowLamp', 'room-x7k2q', '+plus+']) {
      expect(readInvite(new URL(buildInvite({ room })).search).room).toBe(room)
    }
  })
  it('a 40-character code comes back as its first 32', () => {
    const long = 'abcdefghij'.repeat(4)
    expect(readInvite(`?room=${long}`).room).toBe(long.slice(0, 32))
    expect(readInvite(new URL(buildInvite({ room: long })).search).room).toBe(long.slice(0, 32))
  })
  it('the pin goes in only when it is handed over, at the seed\'s own 4 decimals', () => {
    const url = buildInvite({ room: 'r', anchor: { lat: 39.28541234, lng: -76.60834 } })
    expect(url).toContain('anchor=39.2854%2C-76.6083')
    const read = readInvite(new URL(url).search)
    expect(read.room).toBe('r')
    // the same world through the link: the friend's seed is the sender's
    expect(anchorSeed(read.anchor.lat, read.anchor.lng)).toBe(anchorSeed(39.28541234, -76.60834))
  })
  it('a malformed anchor is dropped, never thrown; a maps link in anchor= parses', () => {
    expect(readInvite('?anchor=999,999').anchor).toBe(null)
    expect(readInvite('?anchor=nowhere').anchor).toBe(null)
    expect(readInvite('?anchor=' + encodeURIComponent('https://www.google.com/maps/@39.2904,-76.6122,17z'))).toEqual({ room: null, anchor: { lat: 39.2904, lng: -76.6122 } })
    expect(readInvite('?anchor=39.2904,-76.6122')).toEqual({ room: null, anchor: { lat: 39.2904, lng: -76.6122 } })
  })
  it('anything else on the address is not an invite', () => {
    expect(readInvite('?gfxbench=1')).toEqual({ room: null, anchor: null })
    expect(readInvite('')).toEqual({ room: null, anchor: null })
    expect(readInvite(undefined)).toEqual({ room: null, anchor: null })
    expect(readInvite('?room=')).toEqual({ room: null, anchor: null })
  })
  it('the room is text: markup in it comes back as the same characters (index.html writes it with textContent)', () => {
    expect(readInvite('?room=' + encodeURIComponent('<script>alert(1)</script>')).room).toBe('<script>alert(1)</script>')
  })
})

describe('the case board: relative on the site, the site\'s own address everywhere else', () => {
  it('on backrooms.thecornerspore.dev /recover/ is a sibling of /play/', () => {
    expect(isOwnSite({ protocol: 'https:', hostname: 'backrooms.thecornerspore.dev' })).toBe(true)
    expect(recoverBase({ protocol: 'https:', hostname: 'backrooms.thecornerspore.dev' })).toBe('../recover/cases/')
  })
  it('the desktop app, itch\'s CDN, localhost and no location read it from the site', () => {
    for (const loc of [{ protocol: 'file:', hostname: '' }, { protocol: 'https:', hostname: 'html-classic.itch.zone' }, { protocol: 'http:', hostname: 'localhost' }, null, undefined]) {
      expect(isOwnSite(loc)).toBe(false)
      expect(recoverBase(loc)).toBe('https://backrooms.thecornerspore.dev/recover/cases/')
    }
  })
})

describe('the LAN buttons: an https page cannot open ws:// on your network', () => {
  it('hidden over https, shown on the desktop app and plain http', () => {
    expect(lanReachable({ protocol: 'https:' })).toBe(false)
    expect(lanReachable({ protocol: 'file:' })).toBe(true)
    expect(lanReachable({ protocol: 'http:' })).toBe(true)
    expect(lanReachable(null)).toBe(true)
  })
})

describe('a phone\'s short maps link', () => {
  it('finds maps.app.goo.gl and goo.gl/maps links, alone or inside shared text, as a clean https link', () => {
    expect(shortMapsLink('https://maps.app.goo.gl/AbC123xyz')).toBe('https://maps.app.goo.gl/AbC123xyz')
    expect(shortMapsLink('maps.app.goo.gl/AbC123xyz')).toBe('https://maps.app.goo.gl/AbC123xyz')
    expect(shortMapsLink('http://MAPS.APP.GOO.GL/AbC123xyz?g_st=ic')).toBe('https://maps.app.goo.gl/AbC123xyz')
    expect(shortMapsLink('https://goo.gl/maps/q1W2e3R4')).toBe('https://goo.gl/maps/q1W2e3R4')
    expect(shortMapsLink('Eiffel Tower\nhttps://maps.app.goo.gl/Zz9_-x')).toBe('https://maps.app.goo.gl/Zz9_-x')   // the share sheet's name never leaves
  })
  it('anything else is not one', () => {
    for (const t of ['', '39.29,-76.61', 'https://www.google.com/maps/@39.2904,-76.6122,17z', 'https://goo.gl/xyz', 'https://maps.app.goo.gl/', 'https://example.com/maps.app.goo.gl', 'notmaps.app.goo.gl/abc', null, 42]) {
      expect(shortMapsLink(t), String(t)).toBe(null)
    }
  })
  it('the relay is asked for the link alone, encoded', () => {
    expect(shortLinkQuery('https://maps.app.goo.gl/AbC123xyz')).toBe('https://backrooms-relay.jeff-schatz112.workers.dev/maps?u=https%3A%2F%2Fmaps.app.goo.gl%2FAbC123xyz')
  })
  it('the relay\'s answer is a real place or nothing', () => {
    expect(pinFromResolver({ lat: 48.8584, lng: 2.2945 })).toEqual({ lat: 48.8584, lng: 2.2945 })
    expect(pinFromResolver({ lat: '48.8584', lng: '2.2945' })).toEqual({ lat: 48.8584, lng: 2.2945 })
    for (const b of [null, 'x', {}, { lat: null, lng: null }, { lat: '', lng: '' }, { lat: 91, lng: 0 }, { lat: 0, lng: 181 }, { lat: NaN, lng: 1 }, { error: 'not found' }, [1, 2]]) {
      expect(pinFromResolver(b), JSON.stringify(b)).toBe(null)
    }
  })

  const ok = (body) => vi.fn(async () => ({ ok: true, status: 200, json: async () => body }))
  it('resolves through the relay route with no referrer and no credentials', async () => {
    const f = ok({ lat: 39.2904, lng: -76.6122 })
    await expect(resolveShortLink('look: https://maps.app.goo.gl/AbC123xyz', { fetch: f })).resolves.toEqual({ lat: 39.2904, lng: -76.6122 })
    expect(f).toHaveBeenCalledTimes(1)
    const [url, init] = f.mock.calls[0]
    expect(url).toBe('https://backrooms-relay.jeff-schatz112.workers.dev/maps?u=https%3A%2F%2Fmaps.app.goo.gl%2FAbC123xyz')
    expect(init).toMatchObject({ credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store' })
  })
  it('never asks the relay about anything but a short link', async () => {
    const f = ok({ lat: 1, lng: 1 })
    await expect(resolveShortLink('39.29,-76.61', { fetch: f })).resolves.toBe(null)
    await expect(resolveShortLink('https://example.com/x', { fetch: f })).resolves.toBe(null)
    expect(f).not.toHaveBeenCalled()
  })
  it('every failure is null, never a throw: a refusal, a bad body, the network, a timeout', async () => {
    const link = 'https://maps.app.goo.gl/AbC123xyz'
    await expect(resolveShortLink(link, { fetch: vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })) })).resolves.toBe(null)
    await expect(resolveShortLink(link, { fetch: ok({ nope: true }) })).resolves.toBe(null)
    await expect(resolveShortLink(link, { fetch: vi.fn(async () => ({ ok: true, json: async () => { throw new SyntaxError('x') } })) })).resolves.toBe(null)
    await expect(resolveShortLink(link, { fetch: vi.fn(async () => { throw new TypeError('Failed to fetch') }) })).resolves.toBe(null)
    await expect(resolveShortLink(link, { fetch: null })).resolves.toBe(null)
    const hang = vi.fn((_u, init) => new Promise((_res, rej) => { init.signal.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError'))) }))
    await expect(resolveShortLink(link, { fetch: hang, timeoutMs: 20 })).resolves.toBe(null)
  })
})

describe('/invite: room only, unless you ask for the pin — and the pin is warned about first', () => {
  const online = { code: 'yellow-lamp-42', route: 'online', lan: null }
  const pin = { lat: 39.28541234, lng: -76.60834 }
  it('solo has no door to leave open', () => {
    expect(inviteFor({ arg: '', room: null })).toEqual({ say: NO_DOOR_LINE, url: null, warned: false })
    expect(NO_DOOR_LINE).toBe('no one can follow you here. play online and leave a door open.')
  })
  it('a LAN room names the address, not a web link', () => {
    const r = inviteFor({ room: { code: 'backrooms', route: 'host', lan: 'ws://192.168.1.20:8765' } })
    expect(r.url).toBe(null)
    expect(r.say).toBe('this room is on your network. a friend uses JOIN LAN → ws://192.168.1.20:8765 · room backrooms.')
    expect(inviteFor({ room: { code: 'b', route: 'lan', lan: null } }).say).toBe('this room is on your network. a friend uses JOIN LAN → your address · room b.')
  })
  it('/invite copies the room only, even with a pin in the run', () => {
    expect(inviteFor({ arg: '', room: online, anchor: pin })).toEqual({ say: '', url: 'https://backrooms.thecornerspore.dev/play/?room=yellow-lamp-42', warned: false })
    expect(inviteFor({ arg: 'please', room: online, anchor: pin }).url).not.toContain('anchor=')
  })
  it('/invite pin the first time only warns: no link, nothing copied', () => {
    const r = inviteFor({ arg: 'pin', room: online, anchor: pin, warned: false })
    expect(r.url).toBe(null)
    expect(r.warned).toBe(true)
    expect(r.say).toBe(PIN_WARNING + '\n' + PIN_AGAIN)
    expect(PIN_AGAIN).toBe('/invite pin again puts it in the link.')
  })
  it('/invite pin once warned carries the pin, and says the warning again as it copies', () => {
    const r = inviteFor({ arg: 'pin', room: online, anchor: pin, warned: true })
    expect(r.url).toBe('https://backrooms.thecornerspore.dev/play/?room=yellow-lamp-42&anchor=39.2854%2C-76.6083')
    expect(r.say).toBe(PIN_WARNING)
    expect(r.warned).toBe(true)
    expect(inviteFor({ arg: ' PIN ', room: online, anchor: pin, warned: true }).url).toContain('anchor=')
    expect(inviteFor({ arg: 'here', room: online, anchor: pin, warned: true }).url).toContain('anchor=')
  })
  it('/invite pin without a pin says so and hands the room-only link', () => {
    const r = inviteFor({ arg: 'pin', room: online, anchor: null, warned: false })
    expect(r).toEqual({ say: NO_PIN_LINE, url: 'https://backrooms.thecornerspore.dev/play/?room=yellow-lamp-42', warned: false })
    expect(NO_PIN_LINE).toBe('you came in without a pin. the link carries the room only.')
  })
})
