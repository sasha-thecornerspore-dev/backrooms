import { describe, it, expect } from 'vitest'
import { getPref, getPrefs, setPref, onPrefChange, PREF_DEFAULTS } from '../src/renderer/prefs.js'

// prefs.js has no localStorage in the node test env; it falls back to an
// in-memory copy of the defaults, which is exactly what we exercise here.
describe('prefs', () => {
  it('exposes sane defaults for every toggle', () => {
    expect(PREF_DEFAULTS.music).toBe(true)
    expect(PREF_DEFAULTS.damage).toBe(true)
    expect(PREF_DEFAULTS.creatures).toBe(true)
    expect(typeof PREF_DEFAULTS.mouseSensitivity).toBe('number')
    expect(typeof PREF_DEFAULTS.musicVolume).toBe('number')
  })

  it('getPrefs returns a copy carrying every default key', () => {
    const p = getPrefs()
    for (const k of Object.keys(PREF_DEFAULTS)) expect(k in p).toBe(true)
    p.music = 'mutated'
    expect(getPref('music')).not.toBe('mutated')   // copy, not the live object
  })

  it('setPref updates the value and notifies subscribers', () => {
    let seen
    const off = onPrefChange((k, v) => { if (k === 'grain') seen = v })
    setPref('grain', false)
    expect(getPref('grain')).toBe(false)
    expect(seen).toBe(false)
    off()
    setPref('grain', true)   // restore
  })

  it('does not notify when the value is unchanged, and unsubscribe works', () => {
    let count = 0
    const off = onPrefChange(() => count++)
    setPref('crosshair', false)   // changed → notify
    setPref('crosshair', false)   // same → no notify
    off()
    setPref('crosshair', true)    // unsubscribed → no notify
    expect(count).toBe(1)
  })

  it('carries beacon defaults (off, empty target)', () => {
    expect(PREF_DEFAULTS.beaconEffect).toBe('off')
    expect(PREF_DEFAULTS.beaconWebhook).toBe('')
  })
})
