import { describe, it, expect, vi, afterEach } from 'vitest'
import { getPref, getPrefs, setPref, onPrefChange, PREF_DEFAULTS, PREF_CHOICES, normalizePref } from '../src/renderer/prefs.js'

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

describe('solidBodies pref', () => {
  it('defaults true and normalizes a non-boolean to the default', () => {
    expect(PREF_DEFAULTS.solidBodies).toBe(true)
    expect('solidBodies' in getPrefs()).toBe(true)
    expect(normalizePref('solidBodies', true)).toBe(true)
    expect(normalizePref('solidBodies', false)).toBe(false)
    for (const bad of ['yes', 'false', 0, 1, null, undefined, {}, []]) expect(normalizePref('solidBodies', bad), String(bad)).toBe(true)
  })
  it('setPref coerces a garbage value back to true and persists only booleans', () => {
    setPref('solidBodies', false)
    expect(getPref('solidBodies')).toBe(false)
    setPref('solidBodies', 'maybe')
    expect(getPref('solidBodies')).toBe(true)
  })
})

describe('graphics & comfort prefs', () => {
  it('ship safe, backwards-compatible defaults', () => {
    expect(PREF_DEFAULTS.graphicsQuality).toBe('auto')
    expect(PREF_DEFAULTS.reduceFlicker).toBe(false)     // the *effective* default follows prefers-reduced-motion (tested below)
    expect(PREF_DEFAULTS.fpsCap).toBe(0)
    expect(PREF_DEFAULTS.hiDpi).toBe(false)             // DPR awareness is opt-in
    expect(PREF_DEFAULTS.renderer).toBe('auto')
    for (const k of ['graphicsQuality', 'reduceFlicker', 'fpsCap', 'hiDpi', 'renderer']) expect(k in getPrefs()).toBe(true)
  })

  it('the enumerated prefs list exactly the values the game understands', () => {
    expect(PREF_CHOICES.graphicsQuality).toEqual(['auto', 'low', 'medium', 'high', 'legacy'])
    expect(PREF_CHOICES.fpsCap).toEqual([0, 30, 60])
    expect(PREF_CHOICES.renderer).toEqual(['auto', 'gpu', 'cpu'])
    for (const [k, list] of Object.entries(PREF_CHOICES)) expect(list, k).toContain(PREF_DEFAULTS[k])
  })

  it('normalizePref accepts valid values and replaces anything else with the default', () => {
    for (const v of PREF_CHOICES.graphicsQuality) expect(normalizePref('graphicsQuality', v)).toBe(v)
    for (const v of [0, 30, 60]) expect(normalizePref('fpsCap', v)).toBe(v)
    for (const v of ['auto', 'gpu', 'cpu']) expect(normalizePref('renderer', v)).toBe(v)
    for (const bad of ['ultra', '', 'AUTO', null, undefined, 3, {}, []]) expect(normalizePref('graphicsQuality', bad), String(bad)).toBe('auto')
    for (const bad of [15, 144, -1, NaN, 'fast', null, undefined, true, '']) expect(normalizePref('fpsCap', bad), String(bad)).toBe(0)
    for (const bad of ['both', 1, null]) expect(normalizePref('renderer', bad)).toBe('auto')
  })
  it('a numeric select value arrives as a string: fpsCap coerces it', () => {
    expect(normalizePref('fpsCap', '30')).toBe(30)
    expect(normalizePref('fpsCap', '60')).toBe(60)
    expect(normalizePref('fpsCap', '0')).toBe(0)
    expect(normalizePref('fpsCap', '45')).toBe(0)
  })
  it('booleans must be booleans; other keys are untouched', () => {
    expect(normalizePref('hiDpi', true)).toBe(true)
    expect(normalizePref('hiDpi', 'yes')).toBe(false)
    expect(normalizePref('hiDpi', 1)).toBe(false)
    expect(normalizePref('reduceFlicker', false)).toBe(false)
    expect(normalizePref('playerName', 'anything goes')).toBe('anything goes')
    expect(normalizePref('music', 'x')).toBe('x')
  })

  it('setPref validates: an invalid value is replaced by the default and notifies once', () => {
    const seen = []
    const off = onPrefChange((k, v) => { if (k === 'graphicsQuality' || k === 'fpsCap') seen.push([k, v]) })
    setPref('graphicsQuality', 'high')
    setPref('graphicsQuality', 'bogus')       // -> 'auto'
    setPref('graphicsQuality', 'auto')        // already auto: no notification
    setPref('fpsCap', '30')                   // -> 30
    setPref('fpsCap', 144)                    // -> 0
    off()
    expect(getPref('graphicsQuality')).toBe('auto')
    expect(getPref('fpsCap')).toBe(0)
    expect(seen).toEqual([['graphicsQuality', 'high'], ['graphicsQuality', 'auto'], ['fpsCap', 30], ['fpsCap', 0]])
  })
})

describe('prefs load-time behaviour (fresh module, stubbed browser)', () => {
  const fresh = async (stubs = {}) => {
    vi.resetModules()
    for (const [k, v] of Object.entries(stubs)) vi.stubGlobal(k, v)
    return import('../src/renderer/prefs.js')
  }
  afterEach(() => { vi.unstubAllGlobals(); vi.resetModules() })
  const store = (obj) => ({ getItem: () => (obj === null ? null : JSON.stringify(obj)), setItem: vi.fn() })
  const motion = (matches) => (q) => ({ matches: q.includes('prefers-reduced-motion') ? matches : false })

  it('reduceFlicker defaults ON when the system asks for reduced motion, OFF otherwise', async () => {
    expect((await fresh({ matchMedia: motion(true) })).getPref('reduceFlicker')).toBe(true)
    expect((await fresh({ matchMedia: motion(false) })).getPref('reduceFlicker')).toBe(false)
    expect((await fresh({})).getPref('reduceFlicker')).toBe(false)                   // no matchMedia at all (Node, old browsers)
    expect((await fresh({ matchMedia: () => { throw new Error('blocked') } })).getPref('reduceFlicker')).toBe(false)
  })
  it('an explicit stored choice beats the system default in both directions', async () => {
    expect((await fresh({ matchMedia: motion(true), localStorage: store({ reduceFlicker: false }) })).getPref('reduceFlicker')).toBe(false)
    expect((await fresh({ matchMedia: motion(false), localStorage: store({ reduceFlicker: true }) })).getPref('reduceFlicker')).toBe(true)
  })
  it('a stored garbage value falls back to the (device) default instead of reaching the renderer', async () => {
    const m = await fresh({ matchMedia: motion(true), localStorage: store({ reduceFlicker: 'maybe', graphicsQuality: 'ultra', fpsCap: 144, hiDpi: 'yes', renderer: 7, solidBodies: 'off' }) })
    expect(m.getPref('reduceFlicker')).toBe(true)
    expect(m.getPref('graphicsQuality')).toBe('auto')
    expect(m.getPref('fpsCap')).toBe(0)
    expect(m.getPref('hiDpi')).toBe(false)
    expect(m.getPref('renderer')).toBe('auto')
    expect(m.getPref('solidBodies')).toBe(true)
  })
  it('valid stored values survive, and unrelated stored keys are left alone', async () => {
    const m = await fresh({ localStorage: store({ graphicsQuality: 'legacy', fpsCap: 60, hiDpi: true, renderer: 'cpu', playerName: 'ann', music: false }) })
    expect(m.getPrefs()).toMatchObject({ graphicsQuality: 'legacy', fpsCap: 60, hiDpi: true, renderer: 'cpu', playerName: 'ann', music: false })
  })
  it('an old save with none of the new keys just gets the defaults', async () => {
    const m = await fresh({ localStorage: store({ music: false, grain: false }) })
    expect(m.getPrefs()).toMatchObject({ graphicsQuality: 'auto', fpsCap: 0, hiDpi: false, renderer: 'auto', music: false, grain: false })
  })
  it('a corrupt or non-object store does not throw', async () => {
    for (const bad of [null, [1, 2], 'text', 42]) {
      const m = await fresh({ localStorage: { getItem: () => JSON.stringify(bad), setItem() {} } })
      expect(m.getPref('graphicsQuality')).toBe('auto')
    }
    const m = await fresh({ localStorage: { getItem: () => '{not json', setItem() {} } })
    expect(m.getPref('fpsCap')).toBe(0)
  })
  it('persists a valid change and never persists an invalid one', async () => {
    const ls = store(null)
    const m = await fresh({ localStorage: ls })
    m.setPref('graphicsQuality', 'medium')
    expect(JSON.parse(ls.setItem.mock.calls.at(-1)[1]).graphicsQuality).toBe('medium')
    m.setPref('graphicsQuality', 'ultra')
    expect(JSON.parse(ls.setItem.mock.calls.at(-1)[1]).graphicsQuality).toBe('auto')
  })
})
