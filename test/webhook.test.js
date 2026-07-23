import { describe, it, expect } from 'vitest'
import { isBlockedAddress } from '../src/webhook.js'

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
  it.each(['fe00::1', 'fbff::1'])('allows just outside IPv6 link-local %s', allows)

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

  // Adjacent prefixes are ordinary space and must not be swept up by the above.
  it.each(['64:ff9c::1', '65:ff9b::1'])('allows NAT64-adjacent prefix %s', allows)

  it.each([
    '2606:4700:4700::1111',
    'fe8::1',   // = 0fe8:: — an ordinary address the old /^fe[89ab]/ regex mis-blocked
    'fc::1',    // = 00fc:: — likewise for /^f[cd]/
  ])('allows ordinary public IPv6 %s', allows)

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
