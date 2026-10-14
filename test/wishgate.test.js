// relay/wishgate.js — the pure half of the relay's POST /wish: the body's shape, the word filter, the issue the app has always
// filed (title / body / labels), the GitHub request, the per-address limiter's arithmetic and the origins a browser may call from.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import {
  WISH_MAX, ALLOWED_ORIGINS, DEFAULT_REPO, DAY_MS, GATE_RULES,
  WISH_ORIGINS, GLOBAL_GATE, originOk, corsHeaders, validateWish, filterWish, buildIssue, quietMentions, issueRequest, gateTake, gateKey, hashIp,
} from '../relay/wishgate.js'
import { wishTitle, wishLabels } from '../src/wish-labels.js'
import { wishTrailer, parseTrailer } from '../src/renderer/status.js'
import { ORIGINS } from '../src/renderer/origin-intake.js'

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8')

describe('validateWish: the body the app and the browser send', () => {
  it('accepts { text, meta, version } and hands back exactly that, the meta normalised to { origin }', () => {
    expect(validateWish({ text: 'let me out', meta: { origin: null }, version: '2.0.0' }))
      .toEqual({ ok: true, wish: { text: 'let me out', meta: { origin: null }, version: '2.0.0' } })
    for (const o of ORIGINS) {
      expect(validateWish({ text: 'x', meta: { origin: o } }).wish).toEqual({ text: 'x', meta: { origin: o }, version: null })
    }
  })
  it('meta and version may be left out (a browser knows no version); {} reads as no column', () => {
    expect(validateWish({ text: 'x' })).toEqual({ ok: true, wish: { text: 'x', meta: { origin: null }, version: null } })
    expect(validateWish({ text: 'x', meta: null, version: null }).ok).toBe(true)
    expect(validateWish({ text: 'x', meta: {} }).wish.meta).toEqual({ origin: null })
  })
  it('keeps the text byte for byte: the trailer line, the tabs, the length up to 500', () => {
    const filed = 'make the fog warmer' + wishTrailer('extension', 2)
    expect(validateWish({ text: filed }).wish.text).toBe(filed)
    expect(validateWish({ text: 'a\tb' }).wish.text).toBe('a\tb')
    expect(WISH_MAX).toBe(500)
    expect(validateWish({ text: 'a'.repeat(500) }).ok).toBe(true)
  })
  it("refuses what is not a wish: 'body', 'text', 'meta', 'version'", () => {
    for (const b of [null, undefined, 'let me out', 42, ['let me out'], { text: 'x', labels: ['granted'] }, { text: 'x', title: 'y' }]) {
      expect(validateWish(b)).toEqual({ ok: false, reason: 'body' })
    }
    for (const text of ['', '   ', '\n\n', 'a'.repeat(501), 42, null, undefined, ['x'], 'a\u0000b', 'a\u001bb', 'a\rb', 'a\u007fb']) {
      expect(validateWish({ text })).toEqual({ ok: false, reason: 'text' })
    }
    for (const meta of ['processed', 42, [], { origin: 'keeper' }, { origin: 'processed', extra: 1 }, { origin: 1 }]) {
      expect(validateWish({ text: 'x', meta })).toEqual({ ok: false, reason: 'meta' })
    }
    for (const version of ['2.0', 'v2.0.0', '2.0.0.0', '<script>', 2, '2.0.0-' + 'a'.repeat(40), '2.0.0\nx']) {
      expect(validateWish({ text: 'x', version })).toEqual({ ok: false, reason: 'version' })
    }
    expect(validateWish({ text: 'x', version: '0.0.0-test' }).ok).toBe(true)
  })
})

describe('filterWish: a short, conservative word list (a person reads every wish anyway)', () => {
  it('lets ordinary wishes through, words that only contain a bad one included', () => {
    for (const t of ['make the fog warmer', 'i was here', 'let me out' + wishTrailer('litigation', 3), 'turn the lights off on level 1',
      'a niggling hum in the walls', 'the snigger behind the vending machine', 'a spicy smell', 'the gookie monster', 'level 9.2 has a casino',
      'the crypt under level 3', 'a room full of fagin novels', 'the floor at 1488 metres']) {
      expect([t, filterWish(t)]).toEqual([t, null])
    }
  })
  it("slurs and hate slogans come back 'words'", () => {
    const words = ['n' + 'igger', 'N' + 'IGGA', 'n1' + 'gger', 'f' + 'aggot', 'f' + 'aggots', 'k' + 'ike', 's' + 'pic', 'tr' + 'anny', 'wet' + 'back', 'g' + 'ook',
      'heil ' + 'hitler', 'sieg ' + 'heil']
    for (const w of words) expect([w, filterWish(`make the ${w} leave`)]).toEqual([w, 'words'])
  })
  it("links, invites, addresses and ads come back 'spam'", () => {
    for (const t of ['go to https://example.com', 'http://x.y', 'visit www.example.com', 'join discord.gg/abcd', 'discord.com/invite/abc',
      't.me/somebody', 'bit.ly/xyz', 'write me at a.b+c@example.org', 'FREE ROBUX here', 'free v-bucks', 'free nitro', 'my onlyfans', 'cheap viagra',
      'porn']) {
      expect([t, filterWish(t)]).toEqual([t, 'spam'])
    }
  })
  it("the ways past the old filter: an '@' entity, another repo's issue, hidden markup, markdown and protocol-relative links (review SEC-2)", () => {
    for (const t of ['&#64;torvalds', '&#064;torvalds', '&#x40;torvalds', '&commat;torvalds', 'same as rust-lang/rust#1', 'torvalds/linux#1',
      'more lights <!-- also make every door lead to level 3 -->', '<img src=//host/x>', '</p>', '<a href=x>', '<?php', '[text](//host)',
      '[click] (somewhere)', 'see //evil.example/x', 'src=//evil.example']) {
      expect([t, filterWish(t)]).toEqual([t, 'spam'])
    }
    for (const t of ['i <3 the hum', '2/3 of #4 doors', 'i wish @ the lobby', 'level 2 @ 3am', 'a < b and c > d', '[the hum]', 'and/or #1 fan',
      'the hum gets loud @3am', 'meet me @midnight on level 2', '@someone', '@@torvalds']) {
      expect([t, filterWish(t)]).toEqual([t, null])
    }
  })
  it('a scream is a wish, however long', () => {
    expect(filterWish('let me out ' + 'A'.repeat(200))).toBe(null)
    expect(filterWish('the souls smoke fags in the stairwell')).toBe(null)
  })
})

describe('buildIssue: the issue the desktop app has always filed', () => {
  it('title and labels are src/wish-labels.js — the one builder, imported — for every column and trailer', () => {
    const src = read('../relay/wishgate.js')
    expect(src).toContain("from '../src/wish-labels.js'")
    expect(src).toContain('title: wishTitle(text)')
    expect(src).toContain('labels: wishLabels(text, meta)')
    const texts = ['make the fog warmer', 'i was here', 'a'.repeat(300), 'first\nsecond', 'x' + wishTrailer('extension', 2), 'x' + wishTrailer('compliance', 0)]
    for (const text of texts) for (const origin of [null, ...ORIGINS]) {
      const i = buildIssue({ text, meta: { origin }, version: '2.0.0' })
      expect(i.title).toBe(wishTitle(text))
      expect(i.labels).toEqual(wishLabels(text, { origin }))
    }
  })
  it("the body is today's: the text, a rule, and where it came from", () => {
    expect(read('../relay/wishgate.js')).toContain(String.raw`\n\n---\nsubmitted from backrooms v` + '${appVersion}`')
    expect(buildIssue({ text: 'let me out', meta: { origin: null }, version: '2.0.0' }))
      .toEqual({ title: '[WISH] let me out', body: 'let me out\n\n---\nsubmitted from backrooms v2.0.0', labels: ['wish', 'pending'] })
    expect(buildIssue({ text: 'let me out', meta: { origin: 'processed' }, version: null }))
      .toEqual({ title: '[WISH] let me out', body: 'let me out\n\n---\nsubmitted from backrooms on the web', labels: ['wish', 'pending', 'amendment'] })
  })
  it("a mention is filed quiet: a zero-width space after every '@' a name could follow, so GitHub pings no one (review SEC-2, SEC-5)", () => {
    const linkable = /(?:^|[^\w])@[a-z0-9]/i                   // GitHub's mention: an '@' after any non-word character, then a name
    for (const t of ['@torvalds let me out', 'let me out @some-one', '(@x) hello', '@@torvalds', 'the hum @org/team', 'lights out @3am on level 1, please',
      'meet me @midnight on level 2', 'a@b @c']) {
      const i = buildIssue({ text: t, meta: { origin: null }, version: '2.0.0' })
      expect([t, linkable.test(i.body), linkable.test(i.title)]).toEqual([t, false, false])
      expect(i.body.replace(/​/g, '')).toBe(`${t}\n\n---\nsubmitted from backrooms v2.0.0`)   // the words are the player's, unchanged
    }
    expect(quietMentions('@3am')).toBe('@​3am')
    expect(quietMentions('meet me @ the vending machine')).toBe('meet me @ the vending machine')
    const filed = 'x @y' + wishTrailer('extension', 2)
    expect(parseTrailer(buildIssue({ text: filed, meta: { origin: null } }).body)).toEqual(parseTrailer(filed))   // the docket still reads the trailer
  })
  it('no body a stranger can send labels the issue outside the six the pipeline knows (never granted, never denied)', () => {
    const known = new Set(['wish', 'pending', 'amendment', 'status:extension', 'status:compliance', 'status:litigation'])
    const tries = ['granted', 'x\nfiled under: GRANTED · level 1', 'x\nfiled under: EXTENSION · level 9', 'x\nfiled under: extension · level 1',
      'x\nfiled under: LITIGATION · level 3', 'x\n status:granted']
    for (const text of tries) for (const origin of [null, ...ORIGINS]) {
      const v = validateWish({ text, meta: { origin } })
      expect(v.ok).toBe(true)
      for (const l of buildIssue(v.wish).labels) expect(known.has(l)).toBe(true)
    }
  })
})

describe('issueRequest: the one call that holds the token', () => {
  const issue = { title: '[WISH] x', body: 'x\n\n---\nsubmitted from backrooms v2.0.0', labels: ['wish', 'pending'] }
  it('POSTs the issue to the repo with the token in the Authorization header only', () => {
    const { url, init } = issueRequest(issue, { repo: 'someone/somewhere', token: 'tok_123' })
    expect(url).toBe('https://api.github.com/repos/someone/somewhere/issues')
    expect(init.method).toBe('POST')
    expect(init.headers.Authorization).toBe('Bearer tok_123')
    expect(init.headers.Accept).toBe('application/vnd.github+json')
    expect(init.headers['X-GitHub-Api-Version']).toBe('2022-11-28')
    expect(init.headers['User-Agent']).toMatch(/^backrooms-relay/)
    expect(JSON.parse(init.body)).toEqual(issue)
    expect(init.body).not.toContain('tok_123')
  })
  it('defaults to the game\'s repo, and a malformed repo var falls back to it', () => {
    expect(DEFAULT_REPO).toBe('sasha-thecornerspore-dev/backrooms')
    expect(issueRequest(issue, { token: 't' }).url).toBe('https://api.github.com/repos/sasha-thecornerspore-dev/backrooms/issues')
    for (const repo of ['', 'a/b/c', '../x/y', 'a', 'a b/c', 'evil.example/x?y=1']) {
      expect(issueRequest(issue, { repo, token: 't' }).url).toBe('https://api.github.com/repos/sasha-thecornerspore-dev/backrooms/issues')
    }
  })
})

describe('gateTake: the per-address limiter (3 wishes in 10 minutes, 10 a day)', () => {
  const MIN = 60_000
  it('the rules are the ones the launch needs', () => {
    expect(DAY_MS).toBe(86_400_000)
    expect(GATE_RULES.wish).toEqual([{ windowMs: 10 * MIN, max: 3 }, { windowMs: DAY_MS, max: 10 }])
    expect(GATE_RULES.maps.length).toBe(2)
    expect(GATE_RULES.wishAll).toEqual([{ windowMs: DAY_MS, max: 300 }])   // the one bucket every sender shares (review SEC-3)
    expect(GLOBAL_GATE).toBe('global')
    expect(Object.isFrozen(GATE_RULES)).toBe(true)
  })
  it('three, then a refusal that says when the oldest leaves the window, then three more after it does', () => {
    let s = []
    const t0 = 1_000_000_000
    for (let i = 0; i < 3; i++) { const r = gateTake(s, t0 + i * MIN, GATE_RULES.wish); expect(r.ok).toBe(true); s = r.stamps }
    const no = gateTake(s, t0 + 3 * MIN, GATE_RULES.wish)
    expect(no).toEqual({ ok: false, stamps: s, retryMs: 7 * MIN })
    expect(gateTake(s, t0 + 10 * MIN - 1, GATE_RULES.wish).ok).toBe(false)
    expect(gateTake(s, t0 + 10 * MIN, GATE_RULES.wish).ok).toBe(true)
  })
  it('ten a day, however they are spaced; the eleventh waits for the first to be a day old', () => {
    let s = []
    const t0 = 5_000_000_000, HOUR = 60 * MIN
    for (let i = 0; i < 10; i++) { const r = gateTake(s, t0 + i * HOUR, GATE_RULES.wish); expect(r.ok).toBe(true); s = r.stamps }
    const no = gateTake(s, t0 + 10 * HOUR, GATE_RULES.wish)
    expect([no.ok, no.retryMs]).toEqual([false, DAY_MS - 10 * HOUR])
    const later = gateTake(s, t0 + DAY_MS, GATE_RULES.wish)
    expect(later.ok).toBe(true)
    expect(later.stamps.length).toBe(10)            // the first one aged out of the day and was dropped
  })
  it('never mutates what it is handed; junk stored state reads as empty', () => {
    const s = Object.freeze([1, 2, 3])
    expect(() => gateTake(s, 10, GATE_RULES.wish)).not.toThrow()
    for (const junk of [null, undefined, 'x', 42, { 0: 1 }, [NaN, 'a', null]]) {
      expect(gateTake(junk, 1000, GATE_RULES.wish)).toEqual({ ok: true, stamps: [1000], retryMs: 0 })
    }
  })
})

describe('hashIp: the address is never stored, only a salted hash of it names the gate', () => {
  it('is 32 hex characters, stable, and changes with the address and the salt', async () => {
    const a = await hashIp('203.0.113.7', 'salt')
    expect(a).toMatch(/^[0-9a-f]{32}$/)
    expect(await hashIp('203.0.113.7', 'salt')).toBe(a)
    expect(await hashIp('203.0.113.8', 'salt')).not.toBe(a)
    expect(await hashIp('203.0.113.7', 'other')).not.toBe(a)
    expect(a).not.toContain('203')
    expect(await hashIp('', 'salt')).toMatch(/^[0-9a-f]{32}$/)
  })
})

describe('gateKey: one sender is an IPv4 address or an IPv6 /64 (review SEC-3)', () => {
  it('an IPv4 address is itself; nothing is nothing', () => {
    expect(gateKey('203.0.113.7')).toBe('203.0.113.7')
    expect(gateKey(' 203.0.113.7 ')).toBe('203.0.113.7')
    expect(gateKey('')).toBe('')
    expect(gateKey(null)).toBe('')
  })
  it('an IPv6 address, compressed or full, is its first four hextets', () => {
    expect(gateKey('2001:db8:85a3:1234:abcd:ef01:2345:6789')).toBe('2001:db8:85a3:1234::/64')
    expect(gateKey('2001:0DB8:85A3:1234:0000:0000:0000:0001')).toBe('2001:db8:85a3:1234::/64')
    expect(gateKey('2001:db8:85a3:1234::1')).toBe('2001:db8:85a3:1234::/64')
    expect(gateKey('2001:db8::1')).toBe('2001:db8:0:0::/64')
    expect(gateKey('2001:db8:0:0:ffff::9')).toBe(gateKey('2001:db8::1'))
    expect(gateKey('::1')).toBe('0:0:0:0::/64')
    expect(gateKey('fe80::1%eth0')).toBe('fe80:0:0:0::/64')
    expect(gateKey('[2001:db8::1]')).toBe('2001:db8:0:0::/64')
  })
  it('the 2^64 addresses of one /64 are one sender; the next /64 is another', () => {
    const a = gateKey('2001:db8:aa:bb:1:2:3:4'), b = gateKey('2001:db8:aa:bb:ffff:ffff:ffff:ffff'), c = gateKey('2001:db8:aa:bc::1')
    expect(a).toBe(b)
    expect(c).not.toBe(a)
  })
  it('an IPv4-mapped address is the IPv4 address it carries (never one bucket for every mapped client)', () => {
    expect(gateKey('::ffff:203.0.113.7')).toBe('203.0.113.7')
    expect(gateKey('0:0:0:0:0:ffff:cb00:7107')).toBe('203.0.113.7')
    expect(gateKey('::ffff:198.51.100.9')).not.toBe(gateKey('::ffff:203.0.113.7'))
  })
  it('what does not read as an address is kept as it came', () => {
    for (const s of ['1:2:3', '1::2::3', 'zz::1', '1:2:3:4:5:6:7:8:9', 'not:an:address']) expect([s, gateKey(s)]).toEqual([s, s])
  })
})

describe('origins: the site, the itch CDN and the desktop app; nothing else from a browser', () => {
  it("/wish takes the site and the itch CDN only: never 'null' or 'file://', which any page can send (review SEC-4)", () => {
    expect(WISH_ORIGINS).toEqual(['https://backrooms.thecornerspore.dev', 'https://html-classic.itch.zone', 'https://html.itch.zone', 'https://v6p9d9t4.ssl.hwcdn.net'])
    for (const o of ['null', 'file://']) {
      expect(originOk(o, WISH_ORIGINS)).toBe(false)
      expect(corsHeaders(o, WISH_ORIGINS)).toEqual({ Vary: 'Origin' })
    }
    expect(originOk(null, WISH_ORIGINS)).toBe(true)          // the desktop app's main process sends no Origin
  })
  it('lists them', () => {
    expect(ALLOWED_ORIGINS).toEqual(['https://backrooms.thecornerspore.dev', 'https://html-classic.itch.zone', 'https://html.itch.zone',
      'https://v6p9d9t4.ssl.hwcdn.net', 'null', 'file://'])
  })
  it('lets them in, and a request with no Origin (the desktop app\'s main process) too', () => {
    for (const o of ALLOWED_ORIGINS) expect(originOk(o)).toBe(true)
    expect(originOk(null)).toBe(true)
    expect(originOk(undefined)).toBe(true)
  })
  it('keeps out look-alikes', () => {
    for (const o of ['https://evil.example', 'http://backrooms.thecornerspore.dev', 'https://backrooms.thecornerspore.dev.evil.example',
      'https://evil.itch.zone.example', 'https://itch.io', '']) expect([o, originOk(o)]).toEqual([o, false])
  })
  it('echoes an allowed origin with the methods and the one header the client sends', () => {
    const h = corsHeaders('https://html-classic.itch.zone')
    expect(h['Access-Control-Allow-Origin']).toBe('https://html-classic.itch.zone')
    expect(h['Access-Control-Allow-Methods']).toBe('GET, POST, OPTIONS')
    expect(h['Access-Control-Allow-Headers']).toBe('content-type')
    expect(h.Vary).toBe('Origin')
    expect(corsHeaders('null')['Access-Control-Allow-Origin']).toBe('null')
    expect(corsHeaders(null)).toEqual({ Vary: 'Origin' })
    expect(corsHeaders('https://evil.example')).toEqual({ Vary: 'Origin' })
  })
})
