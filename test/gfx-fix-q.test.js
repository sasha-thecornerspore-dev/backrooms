// Fixer Q: the adaptive controller must not read a throttled display as overload (PQ-1), must not pulse on a machine whose
// cost workMs cannot see (PQ-2), the reduceFlicker default must follow the OS until the player chooses (PQ-3 / PS-4),
// tier lookups must not accept prototype keys (W8), the flash shares the dip limiter's budget (PS-5), and the settings
// wording / shake gating (PQ-6, W2, PS-2).
import { describe, it, expect, vi, afterEach } from 'vitest'
import fs from 'node:fs'
import {
  qualityFor, comfortFor, TIERS, createAdaptiveController, createFlickerState, stepFlicker, flashFor, flashWait, noteFlash,
  FLASH_DIP_SPACING, MAX_DIPS_PER_SEC,
} from '../src/renderer/gfx-quality.js'
import { mulberry32 } from '../src/renderer/gfx-util.js'

// ─────────────────────────────────────── PQ-1 / PQ-2: controller simulations ───────────────────────────────────────
const TIER_MUL = { low: 1, medium: 1.2, high: 1.6 }
// frame = (cpu work + gpu cost) rounded up to a whole display period; workMs sees only the cpu part
function sim(ctl, { seconds, cpu, gpu = () => 0, period = 1000 / 60, t0 = 0 }) {
  const log = []
  let t = t0
  const end = t0 + seconds * 1000
  while (t < end) {
    const w = cpu(ctl.scale, ctl.tier, t / 1000)
    const frame = Math.max(period, Math.ceil((w + gpu(ctl.scale, ctl.tier, t / 1000)) / period - 1e-9) * period)
    const changed = ctl.update(frame, w)
    t += frame
    if (changed) log.push({ t: t / 1000, tier: ctl.tier, scale: ctl.scale, reason: ctl.reason })
  }
  return log
}

describe('PQ-1: a throttled display is not overload', () => {
  it('30 Hz rAF with 5 ms of work does not collapse, from any start tier', () => {
    for (const [tier, scale] of [['high', 0.75], ['medium', 0.6], ['low', 0.5]]) {
      const c = createAdaptiveController({ tier, scale, maxTier: 'high' })
      const log = sim(c, { seconds: 300, cpu: () => 5, period: 1000 / 30 })
      expect(log.some((e) => e.reason === 'down-tier'), `${tier}: no tier drop`).toBe(false)
      expect(c.scale, `${tier}: scale`).toBeGreaterThanOrEqual(scale)
      expect(log.filter((e) => e.reason === 'down-scale').length, tier).toBeLessThanOrEqual(1)     // at most the one probe step, which is undone
      expect(c.budgetMs).toBeGreaterThan(1000 / 30)                                                // the budget follows the measured period
    }
  })
  it('the probe step is undone and the controller keeps its tier on the throttled display', () => {
    const c = createAdaptiveController({ tier: 'high', scale: 0.75 })
    const log = sim(c, { seconds: 300, cpu: (s) => 2 + 6 * s * s, period: 1000 / 30 })
    expect(log.find((e) => e.reason === 'throttled')).toBeTruthy()
    expect(c.tier).toBe('high')
    expect(c.scale).toBeGreaterThanOrEqual(0.75)
  })
  it('other throttles (20 Hz, 15 Hz) work out, and a display that speeds up again gets the 60 fps budget back', () => {
    for (const hz of [20, 15]) {
      const c = createAdaptiveController({ tier: 'medium', scale: 0.6, maxTier: 'medium' })
      sim(c, { seconds: 120, cpu: () => 4, period: 1000 / hz })
      expect(c.tier, `${hz} Hz`).toBe('medium'); expect(c.scale, `${hz} Hz`).toBeGreaterThanOrEqual(0.6)
    }
    const c = createAdaptiveController({ tier: 'medium', scale: 0.6, maxTier: 'medium' })
    sim(c, { seconds: 60, cpu: () => 4, period: 1000 / 30 })
    expect(c.budgetMs).toBeGreaterThan(40)
    sim(c, { seconds: 60, cpu: () => 4, period: 1000 / 60, t0: 60000 })
    expect(c.budgetMs).toBeCloseTo(1000 / 60 * 1.25, 6)
    expect(c.tier).toBe('medium')
  })
  it('a REAL overload on a 30 Hz display (work scales with resolution) is still answered', () => {
    const c = createAdaptiveController({ tier: 'high', scale: 0.75 })
    const log = sim(c, { seconds: 120, cpu: (s, tier) => 4 + 140 * s * s * TIER_MUL[tier] / 1.6, period: 1000 / 30 })
    expect(log.some((e) => e.reason === 'down-scale')).toBe(true)
    expect(c.scale).toBeLessThan(0.75)
  })
  it('a GPU-bound machine (frames respond to resolution) is NOT mistaken for a throttle', () => {
    const c = createAdaptiveController({ tier: 'high', scale: 0.75 })
    const log = sim(c, { seconds: 120, cpu: () => 3, gpu: (s) => 60 * s * s })
    expect(log.some((e) => e.reason === 'throttled')).toBe(false)
    expect(c.scale).toBeLessThan(0.6)
  })
  it('the measured display period is the median of the fastest quarter of the intervals', () => {
    const c = createAdaptiveController({ tier: 'medium', scale: 0.6, maxTier: 'medium' })
    sim(c, { seconds: 30, cpu: () => 5, period: 1000 / 30 })
    expect(c.periodMs).toBeGreaterThan(30); expect(c.periodMs).toBeLessThan(36)
  })
})

describe('PQ-2: a per-session ceiling stops the pulsing on a machine workMs cannot see', () => {
  const gpuBound = (k) => ({ cpu: (s) => 4 * s * s, gpu: (s) => k * s * s })
  it('a fixed-cost GPU-bound machine makes at most a couple of scale changes per hour once settled', () => {
    for (const k of [45, 30, 60]) {
      const c = createAdaptiveController({ tier: 'medium', scale: 0.6, maxTier: 'medium' })
      const log = sim(c, { seconds: 3600, ...gpuBound(k) })
      expect(log.filter((e) => e.t > 900).length, `gpu ${k}: changes after 15 min`).toBeLessThanOrEqual(2)
      expect(log.length, `gpu ${k}: total in an hour`).toBeLessThanOrEqual(10)
    }
  })
  it('a failed up-step goes back to the pre-probe level (not the proportional formula) and is capped there', () => {
    const c = createAdaptiveController({ tier: 'medium', scale: 0.5, maxTier: 'medium' })
    const log = sim(c, { seconds: 900, cpu: () => 3, gpu: (s) => (s <= 0.55 + 1e-9 ? 8 : 40) })  // 0.6 is a cliff the CPU model cannot see
    const fail = log.find((e) => e.reason === 'down-probe')
    expect(fail).toBeTruthy()
    expect(fail.scale).toBe(0.55)
    expect(log.filter((e) => e.t > fail.t).length).toBe(0)                                       // it stays at 0.55
  })
  it('a resize (setBounds) lifts the ceiling', () => {
    const c = createAdaptiveController({ tier: 'medium', scale: 0.5, maxTier: 'medium' })
    const gpu = (s) => (s <= 0.55 + 1e-9 ? 8 : 40)
    const log = sim(c, { seconds: 300, cpu: () => 3, gpu })
    expect(log.some((e) => e.reason === 'down-probe')).toBe(true)
    c.setBounds(0.4, 0.85)
    const again = sim(c, { seconds: 300, cpu: () => 3, gpu, t0: 300000 })
    expect(again.some((e) => e.reason === 'up-scale')).toBe(true)                                // free to probe again
  })
  it('a healthy machine still climbs to its ceiling (the cap only exists after a failed probe)', () => {
    const c = createAdaptiveController({ tier: 'low', scale: 0.4, maxTier: 'high' })
    sim(c, { seconds: 900, cpu: () => 2 })
    expect(c.tier).toBe('high'); expect(c.scale).toBe(0.9)
  })
})

// ───────────────────────────────────────────── W8: prototype keys ─────────────────────────────────────────────
describe('W8: prototype keys are not tiers', () => {
  it('qualityFor falls back to legacy for anything that is not an own key', () => {
    for (const k of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf', undefined, null, 3, {}]) {
      expect(qualityFor(k), String(k)).toBe(TIERS.legacy)
    }
    for (const k of Object.keys(TIERS)) expect(qualityFor(k)).toBe(TIERS[k])
  })
  it('comfortFor treats a prototype key as legacy (no clamp unless explicit)', () => {
    for (const k of ['constructor', 'toString', '__proto__']) {
      expect(comfortFor({ qualityTier: k }).maxGlobalDip).toBe(1)
      expect(comfortFor({ qualityTier: k, maxGlobalDip: 0.5 }).maxGlobalDip).toBe(0.5)
    }
    expect(comfortFor({ qualityTier: 'medium' }).maxGlobalDip).toBe(0.5)
  })
})

// ─────────────────────────────────────── PS-5: the flash and the dip limiter ───────────────────────────────────────
describe('PS-5: the polaroid flash shares the flicker limiter', () => {
  it('the standard peak is lower and still gentle', () => {
    expect(flashFor(false).peak).toBeLessThanOrEqual(0.3)
    expect(flashFor(false).peak).toBeGreaterThan(0.1)
  })
  it('a flash is held back right after a dip start, and counts as a dip start itself', () => {
    const st = createFlickerState()
    stepFlicker(st, 1 / 60, { rate: 1, depth: 0.5, recoverySpeed: 20 }, () => 0.5, false, false)     // a dip starts
    expect(flashWait(st, false)).toBeGreaterThanOrEqual(FLASH_DIP_SPACING - 0.05)
    const idle = createFlickerState(); idle.t = 10
    expect(flashWait(idle, false)).toBe(0)
    noteFlash(idle)
    expect(flashWait(idle, false)).toBeGreaterThan(0.6)                                             // a second flash right behind it waits
  })
  it('flashes and dips together never exceed 3 events in any 1 s, with the fastest tuning and a mashing player', () => {
    const rand = mulberry32(7)
    const st = createFlickerState()
    const events = []
    let t = 0, nextPress = 0, pending = false
    const tune = { rate: 1, depth: 0.9, recoverySpeed: 30 }
    while (t < 120) {
      const before = st.starts.slice()
      stepFlicker(st, 1 / 60, tune, rand, false, false)
      for (let i = 0; i < 3; i++) if (st.starts[i] !== before[i]) events.push(st.starts[i])
      t += 1 / 60
      if (t >= nextPress) { nextPress = t + 0.15; pending = true }        // the player mashes the shutter every 0.15 s
      if (pending && flashWait(st, false) === 0) {                        // game.js: fire when allowed, then count it as a start
        const s0 = st.starts.slice(); noteFlash(st); pending = false
        for (let i = 0; i < 3; i++) if (st.starts[i] !== s0[i]) events.push(st.starts[i])
      }
    }
    events.sort((a, b) => a - b)
    let best = 0
    for (let i = 0; i < events.length; i++) { let j = i; while (j < events.length && events[j] < events[i] + 1) j++; best = Math.max(best, j - i) }
    expect(events.length).toBeGreaterThan(50)
    expect(best).toBeLessThanOrEqual(MAX_DIPS_PER_SEC)
  })
})

// ───────────────────────────────────── PQ-3 / PS-4: device defaults are not frozen ─────────────────────────────────────
describe('PQ-3 / PS-4: reduceFlicker follows prefers-reduced-motion until the player chooses', () => {
  const fresh = async (stubs = {}) => {
    vi.resetModules()
    for (const [k, v] of Object.entries(stubs)) vi.stubGlobal(k, v)
    return import('../src/renderer/prefs.js')
  }
  afterEach(() => { vi.unstubAllGlobals(); vi.resetModules() })
  const memStore = (init = null) => {
    let v = init === null ? null : JSON.stringify(init)
    return { getItem: () => v, setItem: vi.fn((k, x) => { v = x }), raw: () => JSON.parse(v) }
  }
  const mm = (state) => (q) => ({
    get matches() { return q.includes('prefers-reduced-motion') ? state.on : false },
    addEventListener: (ev, cb) => { if (ev === 'change') state.cbs.push(cb) },
  })

  it('an unrelated setPref does not persist the device default', async () => {
    const ls = memStore()
    const m = await fresh({ matchMedia: mm({ on: false, cbs: [] }), localStorage: ls })
    m.setPref('music', false)
    expect(ls.raw()).toEqual({ music: false })
  })
  it('a later session with reduced motion ON gets the default ON after such a save', async () => {
    const ls = memStore()
    const a = await fresh({ matchMedia: mm({ on: false, cbs: [] }), localStorage: ls })
    a.setPref('musicVolume', 30)
    const b = await fresh({ matchMedia: mm({ on: true, cbs: [] }), localStorage: ls })
    expect(b.getPref('reduceFlicker')).toBe(true)
    expect(b.getPref('musicVolume')).toBe(30)
  })
  it('an explicit choice IS persisted, even when it equals today\'s default, and then beats the OS', async () => {
    const ls = memStore()
    const a = await fresh({ matchMedia: mm({ on: false, cbs: [] }), localStorage: ls })
    a.setPref('reduceFlicker', false)
    expect(ls.raw().reduceFlicker).toBe(false)
    const b = await fresh({ matchMedia: mm({ on: true, cbs: [] }), localStorage: ls })
    expect(b.getPref('reduceFlicker')).toBe(false)
  })
  it('a live OS change updates the value and notifies while the player has not chosen; not after', async () => {
    const st = { on: false, cbs: [] }
    const m = await fresh({ matchMedia: mm(st), localStorage: memStore() })
    const seen = []
    m.onPrefChange((k, v) => seen.push([k, v]))
    expect(m.getPref('reduceFlicker')).toBe(false)
    st.on = true; st.cbs.forEach((cb) => cb())
    expect(m.getPref('reduceFlicker')).toBe(true)
    expect(seen).toEqual([['reduceFlicker', true]])
    m.setPref('reduceFlicker', false)                                                              // the player chooses
    seen.length = 0
    st.on = true; st.cbs.forEach((cb) => cb())
    expect(m.getPref('reduceFlicker')).toBe(false)
    expect(seen).toEqual([])
  })
  it('an invalid stored value is not an override, so the OS default still applies', async () => {
    const ls = memStore({ reduceFlicker: 'maybe', music: false })
    const m = await fresh({ matchMedia: mm({ on: true, cbs: [] }), localStorage: ls })
    expect(m.getPref('reduceFlicker')).toBe(true)
    m.setPref('grain', false)
    expect('reduceFlicker' in ls.raw()).toBe(false)
  })
  it('works without matchMedia or with the legacy addListener API', async () => {
    const m = await fresh({ localStorage: memStore() })
    expect(m.getPref('reduceFlicker')).toBe(false)
    const cbs = []
    const m2 = await fresh({ matchMedia: () => ({ matches: false, addListener: (cb) => cbs.push(cb) }), localStorage: memStore() })
    expect(m2.getPref('reduceFlicker')).toBe(false)
    expect(cbs.length).toBe(1)
  })
})

// ───────────────────────────────── PQ-6 / W2 / PS-2: settings wording and shake (source guards) ─────────────────────────────────
describe('settings wording and comfort gating', () => {
  const html = fs.readFileSync(new URL('../src/renderer/index.html', import.meta.url), 'utf8')
  const game = fs.readFileSync(new URL('../src/renderer/game.js', import.meta.url), 'utf8')
  const prefs = fs.readFileSync(new URL('../src/renderer/prefs.js', import.meta.url), 'utf8')
  it('the legacy option is called classic shading, not "today\'s look, exactly"', () => {
    expect(html).toMatch(/<option value="legacy">classic shading<\/option>/)
    expect(prefs).not.toMatch(/today's look, exactly/)
  })
  it('hiDpi is disabled and hinted under classic shading; no settings control offers the GPU renderer', () => {
    expect(html).toMatch(/chk\.disabled = off/)
    expect(html).toMatch(/not used with classic shading/)
    expect(html).not.toMatch(/id="set-renderer"/)
  })
  it('screen shake is a quarter as strong under reduceFlicker', () => {
    expect(game).toMatch(/const m = shake \* 8 \* \(renderOpts\.reduceFlicker \? 0\.25 : 1\)/)
  })
})
