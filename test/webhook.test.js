import { describe, it, expect } from 'vitest'
import { isBlockedAddress } from '../src/webhook.js'

describe('isBlockedAddress', () => {
  it('blocks IPv4 private / loopback / link-local / metadata / CGNAT ranges', () => {
    for (const ip of [
      '0.0.0.0', '127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255',
      '192.168.1.1', '169.254.169.254', '169.254.0.1', '100.64.0.1', '224.0.0.1',
      '255.255.255.255',
    ]) expect(isBlockedAddress(ip)).toBe(true)
  })

  it('allows ordinary public IPv4', () => {
    for (const ip of ['1.1.1.1', '8.8.8.8', '93.184.216.34', '172.15.0.1', '172.32.0.1'])
      expect(isBlockedAddress(ip)).toBe(false)
  })

  it('blocks IPv6 loopback / ULA / link-local and IPv4-mapped private', () => {
    for (const ip of ['::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1'])
      expect(isBlockedAddress(ip)).toBe(true)
  })

  it('allows public IPv6 and blocks non-IP input', () => {
    expect(isBlockedAddress('2606:4700:4700::1111')).toBe(false)
    expect(isBlockedAddress('example.com')).toBe(true)
    expect(isBlockedAddress('')).toBe(true)
  })
})
