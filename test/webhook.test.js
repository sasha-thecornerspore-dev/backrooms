import { describe, it, expect } from 'vitest'
import { isBlockedAddress, validateWebhookUrl, buildBeaconTarget, resolveAndPin, fireBeacon } from '../src/webhook.js'

// Every assertion below names its own input, so a failure reports WHICH address
// regressed rather than a bare "expected false to be true".
const blocks = (ip) => expect([ip, isBlockedAddress(ip)]).toEqual([ip, true])
const allows = (ip) => expect([ip, isBlockedAddress(ip)]).toEqual([ip, false])

describe('isBlockedAddress', () => {
  it.each([
    '0.0.0.0', '127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255',
    '192.168.1.1', '169.254.169.254', '169.254.0.1', '100.64.0.1', '224.0.0.1',
    '255.255.255.255',
  ])('blocks IPv4 private / loopback / link-local / metadata / CGNAT %s', blocks)

  it.each([
    '1.1.1.1', '8.8.8.8', '93.184.216.34', '172.15.0.1', '172.32.0.1',
  ])('allows ordinary public IPv4 %s', allows)

  // Boundaries of the hand-rolled IPv4 ranges. These were only ever verified by
  // hand; pinning them here stops a later edit from quietly widening the hole.
  it.each(['100.64.0.0', '100.127.255.255'])('blocks CGNAT edge %s', blocks)
  it.each(['100.63.255.255', '100.128.0.0'])('allows just outside CGNAT %s', allows)

  it.each([
    '224.0.0.0',        // first multicast
    '239.255.255.255',  // last multicast
    '240.0.0.1',        // 240/4 reserved
    '255.255.255.255',  // broadcast
  ])('blocks multicast / reserved edge %s', blocks)
  it('allows the address just below multicast', () => allows('223.255.255.255'))

  it.each([
    '::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1',
  ])('blocks IPv6 loopback / ULA / link-local / mapped-private %s', blocks)

  // fe80::/10 spans fe80:: through febf:ffff:...; fe00:: and fbff:: are outside it.
  it.each(['fe80::', 'fe9f::1', 'feaf::1', 'febf::1'])('blocks IPv6 link-local edge %s', blocks)

  // MEANING CHANGED by the allowlist inversion. These two are outside fe80::/10,
  // so under the old enumerate-the-blocked design they were "allowed". They are
  // also outside 2000::/3 — unassigned, not globally routable — so the allowlist
  // now refuses them. Inputs kept, expectation flipped deliberately: they still
  // pin the fe80::/10 edge (neither is caught by the link-local rule), they just
  // land on the default-refuse path instead of falling off the end of the chain.
  it.each(['fe00::1', 'fbff::1'])('blocks just outside IPv6 link-local %s (unassigned)', blocks)

  // fc00::/7 spans fc00:: through fdff:ffff:...
  it.each(['fc00::', 'fdff:ffff::1'])('blocks IPv6 ULA edge %s', blocks)

  it.each(['ff00::1', 'ff02::1'])('blocks IPv6 multicast %s', blocks)

  // FINDING 1 — the classifier must judge the VALUE, not the spelling. Every
  // address below is a valid IPv6 literal per net.isIP() and every one of them
  // resolves to something that must never be a webhook target. The old text
  // matcher let all of them through.
  it.each([
    '::ffff:a9fe:a9fe',          // 169.254.169.254 — cloud metadata, hex-grouped
    '::ffff:7f00:1',             // 127.0.0.1 — hex-grouped
    '::ffff:0a00:1',             // 10.0.0.1 — hex-grouped
    '0:0:0:0:0:ffff:127.0.0.1',  // IPv4-mapped, fully expanded
    '0:0:0:0:0:0:0:1',           // loopback, fully expanded
    '0:0:0:0:0:0:0:0',           // unspecified, fully expanded
    '::127.0.0.1',               // IPv4-compatible (deprecated, still routes)
    '::1%lo0',                   // loopback with a zone id
  ])('blocks alternate spelling %s', blocks)

  // new URL() rewrites the one mapped form the old matcher caught into a form it
  // missed. This is the concrete SSRF path, not a theoretical one.
  it('blocks the hostname new URL() produces for a mapped metadata address', () => {
    const host = new URL('http://[::ffff:169.254.169.254]/').hostname.replace(/^\[|\]$/g, '')
    expect(host).toBe('::ffff:a9fe:a9fe')
    blocks(host)
  })

  // Global unicast is 2000::/3, so ANY address whose first four groups are zero
  // sits in ::/64 — entirely special-purpose space. None of it is ordinary
  // routable address room, so an unrecognized form there must fail closed rather
  // than fall through to "not blocked".
  it.each([
    '::ffff:0:127.0.0.1',        // IPv4-translated (::ffff:0:0/96) loopback
    '::ffff:0:169.254.169.254',  // IPv4-translated cloud metadata
    '::ffff:0:10.0.0.1',         // IPv4-translated private
    '::ffff:0:7f00:1',           // same, hex-grouped
    '::ffff:0:a9fe:a9fe',        // same, hex-grouped
  ])('blocks IPv4-translated %s', blocks)

  it('blocks an unrecognized ::/64 form rather than letting it through', () => {
    blocks('::1234:5678:9abc')
  })

  // The ::/64 rule must not become a blanket block: a public IPv4 embedded in a
  // mapped or translated address is legitimately reachable and stays allowed.
  it.each([
    '::ffff:8.8.8.8',     // IPv4-mapped public
    '::ffff:0:8.8.8.8',   // IPv4-translated public
  ])('allows public IPv4 embedded in %s', allows)

  // NAT64. On a DNS64/NAT64 network (IPv6-only carriers, some cloud setups)
  // dns.lookup() synthesizes EVERY IPv4 answer as 64:ff9b::<v4>. If these are not
  // decoded, the entire IPv4 blocklist silently stops applying on such a network.
  it.each([
    '64:ff9b::7f00:1',            // 127.0.0.1
    '64:ff9b::a9fe:a9fe',         // 169.254.169.254 — cloud metadata
    '64:ff9b::a00:1',             // 10.0.0.1
    '64:ff9b::127.0.0.1',         // same, dotted spelling
    '64:ff9b::169.254.169.254',   // same, dotted spelling
  ])('blocks IPv4 embedded in NAT64 well-known prefix %s', blocks)

  it.each([
    '64:ff9b::8.8.8.8',   // dotted
    '64:ff9b::808:808',   // hex — same address
  ])('allows public IPv4 embedded in NAT64 prefix %s', allows)

  it('blocks the RFC 8215 local-use NAT64 prefix 64:ff9b:1::/48', () => {
    blocks('64:ff9b:1::7f00:1')
  })

  // MEANING CHANGED by the allowlist inversion. These were added to prove the
  // NAT64 rule did not over-match its neighbours, and they still do — neither is
  // decoded as NAT64. But they are outside 2000::/3, so instead of falling through
  // to "allowed" they now hit the default refuse. The original intent (no
  // over-match) is preserved by the 64:ff9b::8.8.8.8 vs 64:ff9c::8.8.8.8 pair
  // below, which distinguishes decoded-and-public from not-decoded.
  it.each(['64:ff9c::1', '65:ff9b::1'])('blocks NAT64-adjacent prefix %s (unassigned)', blocks)

  // 6to4 (2002::/16) embeds an IPv4 address in g[1]/g[2] — 2002:AABB:CCDD::/48
  // carries AA.BB.CC.DD. Same shape of hole as ::/64 and NAT64: decode and judge
  // the embedded value rather than trusting the wrapper.
  it.each([
    '2002:7f00:1::1',      // 127.0.0.1
    '2002:a9fe:a9fe::1',   // 169.254.169.254 — cloud metadata
  ])('blocks IPv4 embedded in 6to4 %s', blocks)
  it('allows 6to4 carrying a public IPv4', () => allows('2002:808:808::1'))

  // Ranges that need no special case once the classifier allowlists 2000::/3 —
  // none of these are globally-routable unicast, so none of them are permitted.
  it.each([
    'fec0::1',        // deprecated site-local (RFC 3879)
    '64:ff9b:2::1',   // unassigned gap inside 64:ff9b::/32
    '100::1',         // 100::/64 discard-only
  ])('blocks non-routable range %s (no special case required)', blocks)

  // 2001:db8::/32 is the documentation range. It sits INSIDE 2000::/3, so the
  // allowlist permits it. Asserting the real behaviour rather than adding a
  // special case: it is not a private or internal destination, merely reserved
  // for docs, so allowing it is consistent with the contract.
  it('allows the documentation range 2001:db8::1 (inside 2000::/3)', () => {
    allows('2001:db8::1')
  })

  // Boundary of `(g[0] & 0xe000) !== 0x2000` — the single line the entire
  // allowlist rests on. 1fff:: is the last address below 2000::/3, 4000:: is
  // the first above it; 2000:: and 3fff:: are the first and last addresses
  // inside it. Unasserted until now.
  it.each(['1fff::1'])('blocks just below the 2000::/3 boundary %s', blocks)
  it.each(['2000::1', '3fff::1'])('allows at the edges of the 2000::/3 boundary %s', allows)
  it.each(['4000::1'])('blocks just above the 2000::/3 boundary %s', blocks)

  // Guard that the NAT64 /96 decode does not over-match its neighbours: the
  // well-known prefix carrying 8.8.8.8 is reachable, the adjacent prefix is not.
  it('does not decode a NAT64-adjacent prefix as NAT64', () => {
    allows('64:ff9b::8.8.8.8')
    blocks('64:ff9c::8.8.8.8')
  })

  it.each([
    '2606:4700:4700::1111',
    '2001:4860:4860::8888',
  ])('allows ordinary public IPv6 %s', allows)

  // MEANING CHANGED by the allowlist inversion. These entered the suite in round 1
  // as false positives of the old /^fe[89ab]/ and /^f[cd]/ text regexes, asserted
  // allowed to prove the value-based classifier no longer mis-blocked them by
  // SPELLING. They are still not mis-blocked by spelling — but 0fe8:: and 00fc::
  // are unassigned, outside 2000::/3, and the allowlist refuses them on their
  // VALUE. Inputs kept and expectation flipped: the round-1 regression they guard
  // against would now show up as fe8::1 being blocked for the wrong reason, which
  // this still catches via the 2606:/2001: assertions immediately above.
  it.each([
    'fe8::1',   // = 0fe8:: — unassigned
    'fc::1',    // = 00fc:: — unassigned
  ])('blocks unassigned IPv6 %s (was a text-regex false positive)', blocks)

  // Anything that is not a bare IP literal is blocked: callers only ever hand us
  // resolved literals, so a non-literal means something upstream is wrong.
  it.each([
    ['(empty string)', ''],
    ['example.com', 'example.com'],
    ['127.1', '127.1'],              // short form — not a bare literal
    ['2130706433', '2130706433'],    // decimal integer form
    ['010.0.0.1', '010.0.0.1'],      // octal-looking leading zero
    ['256.1.1.1', '256.1.1.1'],      // out of range
    ['null', null],
    ['undefined', undefined],
  ])('blocks non-IP input %s', (_label, ip) => {
    expect([_label, isBlockedAddress(ip)]).toEqual([_label, true])
  })
})

describe('validateWebhookUrl', () => {
  it('accepts a plain https url', () => {
    expect(validateWebhookUrl('https://example.com/hook').hostname).toBe('example.com')
  })
  it('rejects http, non-443 ports, credentials, and blocked literal IPs', () => {
    expect(() => validateWebhookUrl('http://example.com')).toThrow()
    expect(() => validateWebhookUrl('https://example.com:8443/x')).toThrow()
    expect(() => validateWebhookUrl('https://user:pw@example.com')).toThrow()
    expect(() => validateWebhookUrl('https://127.0.0.1/x')).toThrow()
    expect(() => validateWebhookUrl('not a url')).toThrow()
  })

  // CORRECTION 1 — new URL() keeps the square brackets around an IPv6 host
  // (hostname === '[::1]'), and net.isIP('[::1]') is 0, so an unstripped guard
  // never fires and a loopback literal passes validation. These pin that the
  // brackets get stripped before the blocklist check runs.
  it('rejects a bracketed IPv6 loopback literal', () => {
    expect(() => validateWebhookUrl('https://[::1]/x')).toThrow()
  })
  it('rejects a bracketed IPv6 literal that decodes to cloud metadata', () => {
    expect(() => validateWebhookUrl('https://[::ffff:169.254.169.254]/x')).toThrow()
  })
})

describe('buildBeaconTarget', () => {
  const ctx = { appVersion: '1.4.0', now: 0 }
  it('builds an ntfy target from a sanitized topic', () => {
    const t = buildBeaconTarget('ntfy', 'my-room_1', ctx)
    expect(t.url).toBe('https://ntfy.sh/my-room_1')
    expect(t.body).toContain('beacon')
  })
  it('rejects an ntfy topic with unsafe characters', () => {
    expect(() => buildBeaconTarget('ntfy', 'a/b', ctx)).toThrow()
    expect(() => buildBeaconTarget('ntfy', '', ctx)).toThrow()
  })
  it('requires a discord host for the discord effect', () => {
    expect(buildBeaconTarget('discord', 'https://discord.com/api/webhooks/1/x', ctx).url)
      .toContain('discord.com')
    expect(() => buildBeaconTarget('discord', 'https://evil.example/x', ctx)).toThrow()
  })
  it('builds a custom json target and rejects unknown effects', () => {
    const t = buildBeaconTarget('custom', 'https://example.com/hook', ctx)
    expect(JSON.parse(t.body)).toMatchObject({ event: 'beacon', app: 'backrooms', version: '1.4.0' })
    expect(() => buildBeaconTarget('nope', '', ctx)).toThrow()
  })
})

const pub = (addr, family = 4) => async () => [{ address: addr, family }]

describe('resolveAndPin', () => {
  it('returns a public address and rejects a blocked one', async () => {
    await expect(resolveAndPin('example.com', pub('93.184.216.34'))).resolves.toBe('93.184.216.34')
    await expect(resolveAndPin('sneaky.internal', pub('169.254.169.254'))).rejects.toThrow()
  })
  it('rejects when ANY resolved address is blocked', async () => {
    const mixed = async () => [{ address: '1.1.1.1', family: 4 }, { address: '10.0.0.1', family: 4 }]
    await expect(resolveAndPin('mixed.example', mixed)).rejects.toThrow()
  })

  // CORRECTION 1 — new URL() keeps the brackets around an IPv6 host
  // ('[::1]'), and net.isIP('[::1]') is 0, so an unstripped hostname would
  // skip the literal-IP check and fall through to a DNS lookup of the
  // literal string "[::1]" instead of being judged (and rejected) directly.
  it('strips brackets from a bracketed IPv6 literal before judging it', async () => {
    let called = false
    const lookup = async () => { called = true; return [{ address: '1.1.1.1', family: 4 }] }
    await expect(resolveAndPin('[::1]', lookup)).rejects.toThrow()
    expect(called).toBe(false)
  })
  it('accepts a bracketed IPv6 literal that is not blocked', async () => {
    let called = false
    const lookup = async () => { called = true; return [{ address: '1.1.1.1', family: 4 }] }
    await expect(resolveAndPin('[2606:4700:4700::1111]', lookup)).resolves.toBe('2606:4700:4700::1111')
    expect(called).toBe(false)
  })
})

describe('fireBeacon', () => {
  it('skips when effect is off without touching the network', async () => {
    let called = false
    const request = () => { called = true }
    const r = await fireBeacon('off', '', { request, lookup: pub('1.1.1.1') })
    expect(r.skipped).toBe(true)
    expect(called).toBe(false)
  })

  it('refuses to fire at a blocked target before any request', async () => {
    let called = false
    const request = () => { called = true }
    await expect(fireBeacon('custom', 'https://x.example/h', {
      request, lookup: pub('127.0.0.1'),
    })).rejects.toThrow()
    expect(called).toBe(false)
  })

  it('posts to a public target and reports a 2xx as ok', async () => {
    const seen = {}
    const fakeReq = (opts, cb) => {
      seen.opts = opts
      const res = { statusCode: 204, resume() {} }
      queueMicrotask(() => cb(res))
      return { on() {}, write() {}, end() {}, destroy() {} }
    }
    const r = await fireBeacon('custom', 'https://example.com/hook', {
      appVersion: '1.4.0', now: 0, lookup: pub('93.184.216.34'), request: fakeReq,
    })
    expect(r).toEqual({ ok: true, status: 204 })
    expect(seen.opts.host).toBe('93.184.216.34')   // connects to the pinned IP
    expect(seen.opts.servername).toBe('example.com')
    expect(seen.opts.headers.Host).toBe('example.com')
    expect(seen.opts.port).toBe(443)
  })

  it('drops the response body and never follows redirects', async () => {
    let resumed = false
    const fakeReq = (opts, cb) => {
      const res = { statusCode: 302, headers: { location: 'https://evil.example/' }, resume() { resumed = true } }
      queueMicrotask(() => cb(res))
      return { on() {}, write() {}, end() {}, destroy() {} }
    }
    const r = await fireBeacon('custom', 'https://example.com/hook', {
      lookup: pub('93.184.216.34'), request: fakeReq,
    })
    expect(resumed).toBe(true)
    expect(r).toEqual({ ok: false, status: 302 })
  })

  it('destroys the request on timeout', async () => {
    let destroyed = null
    const fakeReq = (opts) => {
      const handlers = {}
      const req = {
        on(event, handler) { handlers[event] = handler; return req },
        write() {}, end() {},
        // Mirrors real Node: destroying with an error emits 'error' on the request.
        destroy(err) { destroyed = err; if (err && handlers.error) queueMicrotask(() => handlers.error(err)) },
      }
      queueMicrotask(() => handlers.timeout && handlers.timeout())
      return req
    }
    await expect(fireBeacon('custom', 'https://example.com/hook', {
      lookup: pub('93.184.216.34'), request: fakeReq,
    })).rejects.toThrow()
    expect(destroyed).toBeInstanceOf(Error)
  })
})
