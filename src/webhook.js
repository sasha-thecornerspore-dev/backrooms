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

function isBlockedV6(ip) {
  const s = ip.toLowerCase()
  const mapped = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)   // IPv4-mapped → judge as v4
  if (mapped) return isBlockedV4(mapped[1])
  if (s === '::' || s === '::1') return true               // unspecified, loopback
  if (/^fe[89ab]/.test(s)) return true                     // fe80::/10 link-local
  if (/^f[cd]/.test(s)) return true                        // fc00::/7 unique-local
  if (s.startsWith('ff')) return true                      // ff00::/8 multicast
  return false
}
