// webhook.js — outbound "beacon" signal (T0 solo).
//
// A player registers their own webhook target; pressing B in-game fires a
// small fixed POST to it. The renderer has no network access, so the main
// process calls fireBeacon() here. This module is SSRF-hardened and pure
// (Node builtins only, no Electron) so it can be unit-tested in isolation.
//
// SCOPE: T0 fires the player's OWN webhook to themselves. No co-presence,
// matching, or shared index of any kind lives here.

import net from 'net'

// True when a LITERAL ip must never be a webhook target. Anything that is not
// a bare IP literal is blocked too — callers only ever pass resolved literals.
export function isBlockedAddress(ip) {
  const v = net.isIP(ip)
  if (v === 4) return isBlockedV4(ip)
  if (v === 6) return isBlockedV6(ip)
  return true
}

function isBlockedV4(ip) {
  const p = ip.split('.').map(Number)
  if (p.length !== 4 || p.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return true
  const [a, b] = p
  if (a === 0) return true                            // 0.0.0.0/8 "this network"
  if (a === 10) return true                           // 10/8 private
  if (a === 127) return true                          // 127/8 loopback
  if (a === 169 && b === 254) return true             // 169.254/16 link-local + cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true    // 172.16/12 private
  if (a === 192 && b === 168) return true             // 192.168/16 private
  if (a === 100 && b >= 64 && b <= 127) return true   // 100.64/10 carrier-grade NAT
  if (a >= 224) return true                           // 224/4 multicast + 240/4 reserved + broadcast
  return false
}

// Classify the VALUE, not the spelling. `::ffff:a9fe:a9fe`, `::ffff:169.254.169.254`
// and `0:0:0:0:0:ffff:a9fe:a9fe` are the same address; text matching catches one
// and misses the rest. new URL() actively rewrites between these forms, so a
// prefix/exact matcher is a hole, not a nit.
function isBlockedV6(ip) {
  const g = expandV6(ip)
  if (!g) return true                                        // unparseable → fail closed

  // Global unicast is 2000::/3, so g[0..3] all zero means the address is inside
  // ::/64 — entirely special-purpose space, none of it ordinary routable room.
  if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0) {
    // (g[4], g[5]) identifies the known IPv4-bearing forms: (0,0) covers ::,
    // ::1 and IPv4-compatible; (0,0xffff) IPv4-mapped; (0xffff,0) IPv4-translated.
    // For those the low 32 bits ARE an IPv4 address, so let isBlockedV4 judge it —
    // that keeps a public embedded address (::ffff:8.8.8.8) legitimately reachable.
    const known = (g[4] === 0 && (g[5] === 0 || g[5] === 0xffff)) ||
                  (g[4] === 0xffff && g[5] === 0)
    if (!known) return true                                  // unrecognized ::/64 form → fail closed
    return isBlockedV4([g[6] >> 8, g[6] & 0xff, g[7] >> 8, g[7] & 0xff].join('.'))
  }

  // NAT64 (RFC 6052). On a DNS64/NAT64 network — IPv6-only mobile carriers, some
  // cloud setups — the resolver synthesizes EVERY IPv4 answer into one of these
  // prefixes. Callers hand us those resolved addresses, so without this branch the
  // entire IPv4 blocklist quietly stops applying on such a network.
  if (g[0] === 0x0064 && g[1] === 0xff9b) {
    // 64:ff9b:1::/48 (RFC 8215 local-use). RFC 6052 §2.2 spreads the embedded IPv4
    // across bits 48-71 and 72-95 with the u-octet at 64-71 skipped; rather than
    // guess at that layout, block the whole /48. It is local-use translation space,
    // never an ordinary destination, so nothing legitimate is lost.
    if (g[2] === 0x0001) return true
    // 64:ff9b::/96 (well-known prefix): g[2..5] are zero and the embedded IPv4 sits
    // in the low 32 bits. Judge it, so public traffic on these networks still works.
    if (g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0) {
      return isBlockedV4([g[6] >> 8, g[6] & 0xff, g[7] >> 8, g[7] & 0xff].join('.'))
    }
  }

  if ((g[0] & 0xffc0) === 0xfe80) return true                // fe80::/10 link-local
  if ((g[0] & 0xfe00) === 0xfc00) return true                // fc00::/7 unique-local
  if ((g[0] & 0xff00) === 0xff00) return true                // ff00::/8 multicast
  return false
}

// Expand an IPv6 literal to eight 16-bit groups, or null if it will not expand.
// Safe to be strict here: net.isIP() has already validated the literal, so a
// rejection means something is off and the caller fails closed.
function expandV6(literal) {
  try {
    let s = String(literal).toLowerCase().split('%')[0]      // drop any %zone suffix

    // A trailing dotted quad occupies the final two groups — rewrite it as hex
    // so the rest of the expansion only ever deals with 16-bit groups.
    const cut = s.lastIndexOf(':') + 1
    if (s.slice(cut).includes('.')) {
      const q = s.slice(cut).split('.')
      if (q.length !== 4 || q.some(d => !/^\d{1,3}$/.test(d) || Number(d) > 255)) return null
      const hi = (Number(q[0]) << 8) | Number(q[1])
      const lo = (Number(q[2]) << 8) | Number(q[3])
      s = s.slice(0, cut) + hi.toString(16) + ':' + lo.toString(16)
    }

    const halves = s.split('::')
    if (halves.length > 2) return null                       // at most one :: run
    const head = halves[0] ? halves[0].split(':') : []
    const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : []

    let parts
    if (halves.length === 1) {
      parts = head                                           // uncompressed: must be all 8
    } else {
      const fill = 8 - head.length - tail.length
      if (fill < 1) return null
      parts = [...head, ...Array(fill).fill('0'), ...tail]
    }
    if (parts.length !== 8 || parts.some(h => !/^[0-9a-f]{1,4}$/.test(h))) return null
    return parts.map(h => parseInt(h, 16))
  } catch {
    return null
  }
}
