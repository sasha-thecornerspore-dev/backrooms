// Track D: comfort, the flicker limiter (WCAG 2.3.1), the polaroid flash, frame pacing, the device heuristic, the DPR /
// canvas planner, the adaptive resolution controller, the quality director, pickRenderer and the crash-loop breaker.
// Everything here is pure (no DOM): simulated traces stand in for real frame times and real random draws.
import { describe, it, expect } from 'vitest'
import {
  TIERS, TIER_ORDER, comfortFor, effectiveFlicker,
  createFlickerState, stepFlicker, flickerLimits, DIP_LEVEL, DIP_WINDOW, MAX_DIPS_PER_SEC,
  flashFor, createFramePacer,
  readDeviceEnv, deviceClass, startTierFor, budgetScale, INTERNAL_PX_BUDGET,
  planCanvas, renderScaleFor, CANVAS_PX_BUDGET, MAX_DPR_RATIO, RENDER_SCALE_FLOOR,
  createAdaptiveController, createQualityDirector, GRAPHICS_CHOICES,
  pickRenderer, isSoftwareGl, parseRendererOverride,
  armCrashMarker, tickCrashMarker, crashLoopTripped, CRASH_LIMIT, CRASH_HEALTHY_FRAMES, CRASH_EXPIRY_MS,
} from '../src/renderer/gfx-quality.js'
import { mulberry32 } from '../src/renderer/gfx-util.js'

// ───────────────────────────────────────────────── comfort ─────────────────────────────────────────────────
describe('comfortFor (tier-aware defaults)', () => {
  it('an untouched legacy renderer is never clamped, so the harness baseline stays reproducible', () => {
    expect(comfortFor({})).toEqual({ reduceFlicker: false, maxGlobalDip: 1 })
    expect(comfortFor({ qualityTier: 'legacy' }).maxGlobalDip).toBe(1)
    expect(comfortFor({ qualityTier: 'no-such-tier' }).maxGlobalDip).toBe(1)
  })
  it('every real tier bounds the whole-frame dip at 50% by default', () => {
    for (const t of TIER_ORDER) expect(comfortFor({ qualityTier: t }).maxGlobalDip).toBe(0.5)
  })
  it('an explicit maxGlobalDip (what game.js always sets) bounds even the legacy look', () => {
    expect(comfortFor({ qualityTier: 'legacy', maxGlobalDip: 0.5 }).maxGlobalDip).toBe(0.5)
    expect(comfortFor({ maxGlobalDip: 0.05 }).maxGlobalDip).toBe(0.1)      // sanity-clamped: never a frozen black screen
    expect(comfortFor({ maxGlobalDip: 7 }).maxGlobalDip).toBe(1)
    expect(comfortFor({ maxGlobalDip: NaN }).maxGlobalDip).toBe(1)
  })
  it('reduceFlicker takes the smaller of 0.25 and whatever else applies', () => {
    for (const o of [{}, { qualityTier: 'high' }, { maxGlobalDip: 0.5 }, { qualityTier: 'legacy', maxGlobalDip: 1 }]) {
      expect(comfortFor({ ...o, reduceFlicker: true }).maxGlobalDip).toBe(0.25)
    }
    expect(comfortFor({ reduceFlicker: true, maxGlobalDip: 0.15 }).maxGlobalDip).toBe(0.15)
  })
  it('the clamp holds the flicker scalar at 1 - maxGlobalDip', () => {
    const c = comfortFor({ qualityTier: 'medium' })
    expect(effectiveFlicker(0.14, c)).toBe(0.5)
    expect(effectiveFlicker(0.7, c)).toBe(0.7)
  })
})

// ────────────────────────────────── the flicker limiter (WCAG 2.3.1) ──────────────────────────────────
const LEVELS = {   // cfg.flicker of levels.js, plus two adversarial tunings
  L0: { rate: 0.06, depth: 0.55, recoverySpeed: 12 },
  L2: { rate: 0.16, depth: 0.85, recoverySpeed: 9 },
  L3: { rate: 0.22, depth: 0.92, recoverySpeed: 8 },
  always: { rate: 1, depth: 1, recoverySpeed: 8 },       // rolls a dip at every opportunity, as deep as possible
  slow: { rate: 1, depth: 0.92, recoverySpeed: 3 },      // the slowest recovery: the widest gap between start and crossing
}

// run the machine; onFrame(st, t) may write st.target/st.timer like game.js's event handlers do
function runFlicker({ seconds = 180, dtOf = () => 1 / 60, tune, reduce = false, rand, calmOf = () => false, onFrame = null }) {
  const st = createFlickerState()
  const t = [], v = [], starts = []
  let now = 0
  while (now < seconds) {
    const dt = dtOf(now)
    if (onFrame) onFrame(st, now)
    const before = st.si, prevStarts = st.starts.slice()
    stepFlicker(st, dt, tune, rand, calmOf(now), reduce)
    now += dt
    if (st.si !== before) for (let i = 0; i < 3; i++) if (st.starts[i] !== prevStarts[i]) starts.push(st.starts[i])
    t.push(now); v.push(st.value)
  }
  return { st, t, v, starts }
}
// times at which the OUTPUT falls through `level`
function fallingCrossings(t, v, level) {
  const out = []
  for (let i = 1; i < v.length; i++) if (v[i - 1] >= level && v[i] < level) out.push(t[i])
  return out
}
// the most events inside any half-open window [x, x + w)
function maxInWindow(times, w) {
  let best = 0
  for (let i = 0, j = 0; i < times.length; i++) {
    if (j < i) j = i
    while (j < times.length && times[j] < times[i] + w) j++
    if (j - i > best) best = j - i
  }
  return best
}
// zigzag: every swing of at least `amp` (a WCAG "pair of opposing changes" is a down-swing then an up-swing)
function swings(t, v, amp) {
  const out = []
  let dir = 0, ext = v[0], extT = t[0]
  for (let i = 1; i < v.length; i++) {
    if (dir >= 0) {                                   // riding up (or undecided): looking for a top
      if (v[i] > ext) { ext = v[i]; extT = t[i] }
      if (ext - v[i] >= amp) { out.push({ t: extT, down: true }); dir = -1; ext = v[i]; extT = t[i] }
    } else {                                          // riding down: looking for a bottom
      if (v[i] < ext) { ext = v[i]; extT = t[i] }
      if (v[i] - ext >= amp) { out.push({ t: extT, down: false }); dir = 1; ext = v[i]; extT = t[i] }
    }
  }
  return out
}
const downTimes = (t, v, amp) => swings(t, v, amp).filter((x) => x.down).map((x) => x.t)
// the ORIGINAL inline machine from game.js (before the limiter), verbatim
function runOriginal(tune, rand, seconds) {
  let timer = 0, tgt = 1, value = 1, now = 0
  const t = [], v = []
  while (now < seconds) {
    const dt = 1 / 60
    timer -= dt
    if (timer <= 0) {
      if (rand() < tune.rate) { tgt = 1 - tune.depth * rand(); timer = 0.04 + rand() * 0.12 }
      else { tgt = 0.92 + rand() * 0.08; timer = 0.8 + rand() * 3 }
    }
    value += (tgt - value) * Math.min(1, dt * tune.recoverySpeed)
    now += dt; t.push(now); v.push(value)
  }
  return { t, v }
}

describe('the flicker limiter: dips per second', () => {
  it('never more than 3 dips in any second, whatever the level tuning and frame rate (seeded random draws)', () => {
    const dts = { '60Hz': () => 1 / 60, '144Hz': () => 1 / 144, '30Hz': () => 1 / 30, 'clamped-20fps': () => 0.05 }
    for (const [tuneName, tune] of Object.entries(LEVELS)) {
      for (const [dtName, dtOf] of Object.entries(dts)) {
        const { t, v, starts } = runFlicker({ tune, dtOf, rand: mulberry32(1234), seconds: 240 })
        const seen = maxInWindow(fallingCrossings(t, v, DIP_LEVEL), 1)
        expect(seen, `${tuneName}@${dtName} output dips/s`).toBeLessThanOrEqual(MAX_DIPS_PER_SEC)
        expect(maxInWindow(starts, DIP_WINDOW), `${tuneName}@${dtName} starts per window`).toBeLessThanOrEqual(3)
        for (let i = 1; i < starts.length; i++) expect(starts[i] - starts[i - 1], `${tuneName}@${dtName} spacing`).toBeGreaterThanOrEqual(flickerLimits(false).minGap - 1e-9)
      }
    }
  })

  it('the always-dip tunings actually produce dips (the test is not vacuous), yet stay bounded', () => {
    const { t, v, starts } = runFlicker({ tune: LEVELS.always, rand: mulberry32(7), seconds: 120 })
    const crossings = fallingCrossings(t, v, DIP_LEVEL)
    expect(crossings.length).toBeGreaterThan(120)             // hundreds of dips in two minutes...
    expect(maxInWindow(crossings, 1)).toBeLessThanOrEqual(3)  // ...never more than 3 in one second
    expect(starts.length).toBeGreaterThan(120)
  })

  it('a hostile random source (always the deepest dip) and irregular frame times cannot break the bound', () => {
    const r = mulberry32(99)
    const hostile = (() => { let n = 0; return () => (n++ % 2 === 0 ? 0 : 0.999999) })()      // decision rolls always dip, depth always max
    const dtOf = () => [1 / 240, 1 / 144, 1 / 60, 1 / 30, 0.05, 0.011][Math.floor(r() * 6)]
    for (const tune of [LEVELS.always, LEVELS.slow, LEVELS.L3]) {
      const { t, v } = runFlicker({ tune, rand: hostile, dtOf, seconds: 120 })
      expect(maxInWindow(fallingCrossings(t, v, DIP_LEVEL), 1)).toBeLessThanOrEqual(3)
    }
  })

  it('external writers (lights-cascade, sour water, item effects) are rate-limited too, even when spammed every frame', () => {
    const r = mulberry32(5)
    const spam = (st) => { if (r() < 0.7) { st.target = 0.14; st.timer = 0.7 } }              // the cascade write, over and over
    for (const tune of [LEVELS.L0, LEVELS.L3, LEVELS.always]) {
      const { t, v, starts } = runFlicker({ tune, rand: mulberry32(3), onFrame: spam, seconds: 120 })
      expect(maxInWindow(fallingCrossings(t, v, DIP_LEVEL), 1)).toBeLessThanOrEqual(3)
      expect(maxInWindow(starts, DIP_WINDOW)).toBeLessThanOrEqual(3)
    }
    // a different external write each frame: shallow, deep, held, zero-hold
    const wild = (st) => { const k = Math.floor(r() * 5); if (k === 0) { st.target = 0.5; st.timer = 0.3 } else if (k === 1) { st.target = 0.02; st.timer = 0 } else if (k === 2) { st.target = 0.85; st.timer = 3 } }
    const { t, v } = runFlicker({ tune: LEVELS.L3, rand: mulberry32(8), onFrame: wild, seconds: 120 })
    expect(maxInWindow(fallingCrossings(t, v, DIP_LEVEL), 1)).toBeLessThanOrEqual(3)
  })

  it('the whole-signal flash count (down-swings of >= 5% and >= 10% brightness) stays at or under 3 per second', () => {
    for (const amp of [0.05, 0.1]) {
      for (const tune of [LEVELS.L0, LEVELS.L2, LEVELS.L3, LEVELS.always, LEVELS.slow]) {
        for (const seed of [42, 43, 44]) {
          const { t, v } = runFlicker({ tune, rand: mulberry32(seed), seconds: 240 })
          expect(maxInWindow(downTimes(t, v, amp), 1), `amp ${amp} seed ${seed}`).toBeLessThanOrEqual(MAX_DIPS_PER_SEC)
        }
      }
    }
  })

  it('the detector is not vacuous: the ORIGINAL machine breaks the 3/s bound under an always-dip tuning, this one does not', () => {
    let worstOld = 0, worstNew = 0
    for (const seed of [1234, 42, 7]) {
      const old = runOriginal(LEVELS.always, mulberry32(seed), 240)
      worstOld = Math.max(worstOld, maxInWindow(downTimes(old.t, old.v, 0.05), 1))
      const nw = runFlicker({ tune: LEVELS.always, rand: mulberry32(seed), seconds: 240 })
      worstNew = Math.max(worstNew, maxInWindow(downTimes(nw.t, nw.v, 0.05), 1))
    }
    expect(worstOld).toBeGreaterThan(MAX_DIPS_PER_SEC)
    expect(worstNew).toBeLessThanOrEqual(MAX_DIPS_PER_SEC)
  })

  it('reduceFlicker: dips are 1 s apart at least, never deeper than 25%, and the value never moves faster than 5/s', () => {
    const lim = flickerLimits(true)
    for (const tune of [LEVELS.L3, LEVELS.always]) {
      const wild = (st, now) => { if (Math.floor(now * 60) % 7 === 0) { st.target = 0.1; st.timer = 0.7 } }
      const { t, v, starts } = runFlicker({ tune, rand: mulberry32(11), reduce: true, onFrame: wild, seconds: 120 })
      expect(Math.min(...v)).toBeGreaterThanOrEqual(0.75 - 1e-9)
      expect(maxInWindow(fallingCrossings(t, v, DIP_LEVEL), 1)).toBeLessThanOrEqual(1)
      for (let i = 1; i < starts.length; i++) expect(starts[i] - starts[i - 1]).toBeGreaterThanOrEqual(lim.minGap - 1e-9)
      let worst = 0
      for (let i = 1; i < v.length; i++) worst = Math.max(worst, Math.abs(v[i] - v[i - 1]) / (t[i] - t[i - 1]))
      expect(worst).toBeLessThanOrEqual(lim.maxSpeed * (1 - 0) + 1e-6)   // |dv/dt| <= speed * |target - value| <= 5 * 1
    }
  })

  it('switching reduceFlicker on mid-dip pulls the value up to the cap at once', () => {
    const st = createFlickerState()
    const r = mulberry32(2)
    st.target = 0.14; st.timer = 2
    for (let i = 0; i < 60; i++) stepFlicker(st, 1 / 60, LEVELS.L3, r, false, false)
    expect(st.value).toBeLessThan(0.3)
    stepFlicker(st, 1 / 60, LEVELS.L3, r, false, true)
    expect(st.value).toBeGreaterThanOrEqual(0.75)
  })
})

describe('the flicker limiter: behaviour', () => {
  // the original inline machine from game.js, verbatim, for parity
  function original(dt, st, fl, rand) {
    st.timer -= dt
    if (st.calm) { st.tgt = 0.97 }
    else if (st.timer <= 0) {
      if (rand() < fl.rate) { st.tgt = 1 - fl.depth * rand(); st.timer = 0.04 + rand() * 0.12; st.dipAt.push(st.t) }
      else { st.tgt = 0.92 + rand() * 0.08; st.timer = 0.8 + rand() * 3 }
    }
    st.value += (st.tgt - st.value) * Math.min(1, dt * fl.recoverySpeed)
    st.t += dt
  }
  it('is the original machine, draw for draw, until the original first re-dips inside the limiter spacing', () => {
    for (const tune of [LEVELS.L0, { rate: 0.01, depth: 0.5, recoverySpeed: 12 }]) {
      const rOld = mulberry32(2024), rNew = mulberry32(2024)
      const o = { timer: 0, tgt: 1, value: 1, t: 0, dipAt: [], calm: false }
      const n = createFlickerState()
      let firstDivergence = -1
      for (let i = 0; i < 60 * 600; i++) {
        original(1 / 60, o, tune, rOld)
        stepFlicker(n, 1 / 60, tune, rNew, false, false)
        if (Math.abs(o.value - n.value) > 1e-12) { firstDivergence = o.t; break }
      }
      const gaps = o.dipAt.map((x, i) => (i ? x - o.dipAt[i - 1] : Infinity))
      const firstTooClose = gaps.findIndex((g) => g < flickerLimits(false).minGap)
      if (firstDivergence < 0) {
        expect(firstTooClose, 'no divergence means the original never re-dipped that fast either').toBe(-1)
      } else {
        expect(firstTooClose).toBeGreaterThan(-1)                       // it diverged only because the original broke the rule
        expect(firstDivergence).toBeGreaterThanOrEqual(o.dipAt[firstTooClose] - 1e-9)
      }
    }
    // and the low-rate tuning never diverges at all over ten minutes
    const rOld = mulberry32(31), rNew = mulberry32(31)
    const o = { timer: 0, tgt: 1, value: 1, t: 0, dipAt: [], calm: false }, n = createFlickerState()
    const tune = { rate: 0.01, depth: 0.5, recoverySpeed: 12 }
    let maxErr = 0
    for (let i = 0; i < 60 * 600; i++) { original(1 / 60, o, tune, rOld); stepFlicker(n, 1 / 60, tune, rNew, false, false); maxErr = Math.max(maxErr, Math.abs(o.value - n.value)) }
    expect(maxErr).toBeLessThan(1e-12)
  })

  it('the calm hold (almond water) steadies the light at 0.97 and cancels any dip request', () => {
    const st = createFlickerState()
    const r = mulberry32(1)
    for (let i = 0; i < 200; i++) stepFlicker(st, 1 / 60, LEVELS.always, r, true, false)
    expect(st.target).toBe(0.97)
    expect(st.value).toBeGreaterThan(0.96)
    st.target = 0.14; st.timer = 1                                       // an event fires during the calm
    stepFlicker(st, 1 / 60, LEVELS.always, r, true, false)
    expect(st.target).toBe(0.97)
    expect(st.value).toBeGreaterThan(0.95)
  })

  it('an external dip is honoured immediately when the limiter is idle (the lights-cascade still cascades)', () => {
    const st = createFlickerState()
    const r = mulberry32(1)
    for (let i = 0; i < 30; i++) stepFlicker(st, 1 / 60, LEVELS.L0, () => 0.99, false, false)   // settle: no dips rolled
    st.target = 0.14; st.timer = 0.7                                                              // fireEvent('lights-cascade')
    for (let i = 0; i < 20; i++) stepFlicker(st, 1 / 60, LEVELS.L0, () => 0.99, false, false)
    expect(st.target).toBe(0.14)
    expect(st.value).toBeLessThan(0.4)
    for (let i = 0; i < 300; i++) stepFlicker(st, 1 / 60, LEVELS.L0, () => 0.99, false, false)  // then the loop recovers it
    expect(st.value).toBeGreaterThan(0.9)
    void r
  })

  it('an external dip that arrives while the limiter is busy is delayed, not lost', () => {
    const st = createFlickerState()
    const never = () => 0.99
    st.target = 0.5; st.timer = 0.3; stepFlicker(st, 1 / 60, LEVELS.L0, never, false, false)     // dip #1 (accepted)
    const t0 = st.t
    for (let i = 0; i < 6; i++) stepFlicker(st, 1 / 60, LEVELS.L0, never, false, false)
    st.target = 0.14; st.timer = 0.7                                                              // dip #2, 0.1 s later: too soon
    let minAfter = 1
    let firstLow = -1
    for (let i = 0; i < 90; i++) { stepFlicker(st, 1 / 60, LEVELS.L0, never, false, false); if (st.value < 0.3 && firstLow < 0) firstLow = st.t - t0; minAfter = Math.min(minAfter, st.value) }
    expect(minAfter).toBeLessThan(0.3)                                 // it did happen...
    expect(firstLow).toBeGreaterThan(0.3)                              // ...but not within the spacing of the first
    expect(firstLow).toBeLessThan(1.6)                                 // ...and soon enough to belong to its moment
  })

  it('a request that cannot be served within 1.5 s is dropped instead of firing late', () => {
    const st = createFlickerState()
    const never = () => 0.99
    // reduceFlicker spaces dips 1 s apart: fill the limiter, then ask for a dip and keep the limiter busy past the TTL
    st.target = 0.5; st.timer = 0.2; stepFlicker(st, 1 / 60, LEVELS.L0, never, false, true)
    st.starts = [st.t, st.t, st.t]                                     // pretend a burst just used every slot...
    st.target = 0.3; st.timer = 0.3; stepFlicker(st, 1 / 60, LEVELS.L0, never, false, true)
    expect(Number.isNaN(st.pendTarget)).toBe(false)                    // ...so the request is parked
    st.starts = [st.t + 100, st.t + 100, st.t + 100]                   // and the limiter stays busy far beyond the TTL
    for (let i = 0; i < 200; i++) stepFlicker(st, 1 / 60, LEVELS.L0, never, false, true)
    expect(Number.isNaN(st.pendTarget)).toBe(true)
  })

  it('external non-dip writes (finale, ballast: steady for a while) pass through', () => {
    const st = createFlickerState()
    st.target = 1; st.timer = 1.2
    stepFlicker(st, 1 / 60, LEVELS.always, () => 0, false, false)
    expect(st.timer).toBeGreaterThan(1.1)
    expect(st.target).toBe(1)
  })
})

// ─────────────────────────────────────────── polaroid flash ───────────────────────────────────────────
describe('flashFor', () => {
  it('is a gentle, ramped flash: well under the old 90% white instant-on', () => {
    const f = flashFor(false)
    expect(f.peak).toBeLessThanOrEqual(0.4)
    expect(f.peak).toBeGreaterThan(0.1)
    expect(f.attackMs).toBeGreaterThanOrEqual(100)
    expect(f.decayMs).toBeGreaterThan(f.attackMs)
    expect(f.minGapMs).toBeGreaterThanOrEqual(400)                    // at most ~2 flashes a second even when mashed
    expect(1000 / f.minGapMs).toBeLessThanOrEqual(MAX_DIPS_PER_SEC)
  })
  it('reduceFlicker lowers the peak again, slows the ramp and spaces flashes further apart', () => {
    const a = flashFor(false), b = flashFor(true)
    expect(b.peak).toBeLessThan(a.peak)
    expect(b.peak).toBeLessThanOrEqual(0.2)
    expect(b.attackMs).toBeGreaterThan(a.attackMs)
    expect(b.minGapMs).toBeGreaterThan(a.minGapMs)
  })
})

// ─────────────────────────────────────────────── frame pacing ───────────────────────────────────────────────
describe('createFramePacer (fpsCap)', () => {
  function run(hz, cap, seconds = 10, jitterMs = 0, seed = 1) {
    const p = createFramePacer(), r = mulberry32(seed)
    const period = 1000 / hz
    let n = 0, ts = 0, first = -1, last = -1
    for (let i = 0; i < hz * seconds; i++) {
      ts = i * period + (jitterMs ? (r() - 0.5) * jitterMs : 0)
      if (p.due(ts, cap)) { n++; if (first < 0) first = ts; last = ts }
    }
    return { fps: (n - 1) / ((last - first) / 1000), n }
  }
  it('cap 0 processes every frame', () => { expect(run(60, 0).n).toBe(600); expect(run(144, 0).n).toBe(1440) })
  it('30 on a 60 Hz display is exactly every other frame', () => { expect(run(60, 30).fps).toBeCloseTo(30, 0) })
  it('60 on a 60 Hz display drops nothing', () => { expect(run(60, 60).n).toBe(600) })
  it('60 on a 144 Hz display averages 60 (the naive skip gives 48)', () => { expect(Math.abs(run(144, 60).fps - 60)).toBeLessThan(0.7) })
  it('30 on a 144 Hz display averages 30', () => { expect(Math.abs(run(144, 30).fps - 30)).toBeLessThan(0.7) })
  it('30 on a 120 Hz display averages 30', () => { expect(Math.abs(run(120, 30).fps - 30)).toBeLessThan(0.5) })
  it('tolerates timestamp jitter without dropping to a lower rate', () => {
    expect(Math.abs(run(60, 30, 20, 1.2).fps - 30)).toBeLessThan(1.5)
    expect(Math.abs(run(144, 60, 20, 1.2).fps - 60)).toBeLessThan(2)
  })
  it('resynchronises after a stall instead of bursting to catch up', () => {
    const p = createFramePacer()
    expect(p.due(0, 30)).toBe(true)
    expect(p.due(16.7, 30)).toBe(false)
    expect(p.due(5000, 30)).toBe(true)                                 // the tab was hidden for 5 s
    expect(p.due(5016.7, 30)).toBe(false)                              // no catch-up burst
    expect(p.due(5033.4, 30)).toBe(true)
  })
})

// ────────────────────────────────────────── device class heuristic ──────────────────────────────────────────
describe('deviceClass / startTierFor', () => {
  const cases = [
    // name, env, class
    ['2-core Chromebook', { deviceMemory: 4, hardwareConcurrency: 2 }, 'low'],
    ['2 GB device', { deviceMemory: 2, hardwareConcurrency: 8 }, 'low'],
    ['1 GB device', { deviceMemory: 1 }, 'low'],
    ['budget phone (3 GB, coarse)', { deviceMemory: 2, hardwareConcurrency: 8, coarsePointer: true }, 'low'],
    ['data saver', { deviceMemory: 8, hardwareConcurrency: 8, saveData: true }, 'low'],
    ['4-core 4 GB Chromebook', { deviceMemory: 4, hardwareConcurrency: 4 }, 'mid'],
    ['mid phone (4 GB, coarse)', { deviceMemory: 4, hardwareConcurrency: 8, coarsePointer: true }, 'mid'],
    ['flagship phone (8 GB, coarse) is not desktop-class', { deviceMemory: 8, hardwareConcurrency: 8, coarsePointer: true }, 'mid'],
    ['iPad / Safari (no deviceMemory, coarse)', { hardwareConcurrency: 6, coarsePointer: true }, 'mid'],
    ['8 GB 4-core desktop', { deviceMemory: 8, hardwareConcurrency: 4 }, 'mid'],
    ['16 GB 8-core desktop (reports 8)', { deviceMemory: 8, hardwareConcurrency: 8 }, 'high'],
    ['6-core 8 GB laptop', { deviceMemory: 8, hardwareConcurrency: 6 }, 'high'],
    ['Firefox/Safari desktop (no deviceMemory, 8 cores)', { hardwareConcurrency: 8 }, 'high'],
    ['nothing known', {}, 'mid'],
    ['garbage values', { deviceMemory: NaN, hardwareConcurrency: -1, coarsePointer: undefined }, 'mid'],
  ]
  for (const [name, env, cls] of cases) it(`${name} -> ${cls}`, () => expect(deviceClass(env)).toBe(cls))
  it('maps the class to a starting tier', () => {
    expect(startTierFor({ deviceMemory: 4, hardwareConcurrency: 2 })).toBe('low')
    expect(startTierFor({})).toBe('medium')
    expect(startTierFor({ deviceMemory: 8, hardwareConcurrency: 8 })).toBe('high')
  })
  it('tolerates a missing env', () => { expect(deviceClass(undefined)).toBe('mid'); expect(deviceClass(null)).toBe('mid') })
  it('readDeviceEnv reads navigator/window defensively', () => {
    const win = { devicePixelRatio: 2, matchMedia: (q) => ({ matches: q.includes('coarse') }) }
    expect(readDeviceEnv({ deviceMemory: 4, hardwareConcurrency: 8, connection: { saveData: false } }, win))
      .toEqual({ deviceMemory: 4, hardwareConcurrency: 8, coarsePointer: true, reducedMotion: false, saveData: false, dpr: 2 })
    expect(readDeviceEnv({}, {})).toEqual({ deviceMemory: null, hardwareConcurrency: null, coarsePointer: false, reducedMotion: false, saveData: false, dpr: 1 })
    expect(readDeviceEnv(undefined, undefined).dpr).toBe(1)
    const thrower = { matchMedia: () => { throw new Error('nope') } }
    expect(readDeviceEnv({}, thrower).coarsePointer).toBe(false)
  })
  it('the internal pixel budgets keep the 1080p legacy frame (0.6 scale = 746 k px) for mid and up', () => {
    expect(INTERNAL_PX_BUDGET.mid).toBeGreaterThan(1920 * 1080 * 0.36)
    expect(INTERNAL_PX_BUDGET.low).toBeGreaterThanOrEqual(1280 * 720 * 0.36)     // a 720p frame at 0.6
    expect(INTERNAL_PX_BUDGET.low).toBeLessThan(INTERNAL_PX_BUDGET.mid)
    expect(INTERNAL_PX_BUDGET.mid).toBeLessThan(INTERNAL_PX_BUDGET.high)
  })
  it('budgetScale is the largest 0.05 step that fits, never outside 0.4..0.9', () => {
    expect(budgetScale(1280, 720, INTERNAL_PX_BUDGET.mid)).toBe(0.9)              // small windows may go all the way up
    expect(budgetScale(1920, 1080, INTERNAL_PX_BUDGET.mid)).toBe(0.6)             // 0.6^2 * 2.07 M = 746 k <= 800 k < 0.65^2 * 2.07 M
    expect(budgetScale(3840, 2160, INTERNAL_PX_BUDGET.mid)).toBe(0.4)             // 4K: floored (the spec's minimum), not below
    expect(budgetScale(1366, 768, INTERNAL_PX_BUDGET.low)).toBe(0.55)
    for (const [w, h] of [[320, 200], [1000, 1000], [5000, 3000]]) for (const b of Object.values(INTERNAL_PX_BUDGET)) {
      const s = budgetScale(w, h, b)
      expect(s).toBeGreaterThanOrEqual(0.4); expect(s).toBeLessThanOrEqual(0.9)
      if (s > 0.4) expect(w * h * s * s).toBeLessThanOrEqual(b)
    }
  })
})

// ────────────────────────────────────────── DPR + the canvas planner ──────────────────────────────────────────
describe('planCanvas / renderScaleFor', () => {
  it('is today\'s behaviour unless hiDpi is on: backing store = css size, ratio 1, whatever the dpr', () => {
    for (const dpr of [1, 1.25, 2, 3]) {
      expect(planCanvas({ cssW: 1280, cssH: 720, dpr, hiDpi: false })).toEqual({ width: 1280, height: 720, cssW: 1280, cssH: 720, ratio: 1 })
    }
  })
  it('hiDpi at dpr 1 (or below) changes nothing', () => {
    expect(planCanvas({ cssW: 1280, cssH: 720, dpr: 1, hiDpi: true }).ratio).toBe(1)
    expect(planCanvas({ cssW: 1280, cssH: 720, dpr: 0.8, hiDpi: true }).ratio).toBe(1)
  })
  it('hiDpi on a 2x display enlarges the backing store, capped by MAX_DPR_RATIO and by the floor arithmetic', () => {
    const p = planCanvas({ cssW: 1280, cssH: 720, dpr: 2, hiDpi: true, minCssScale: 0.6 })
    expect(p.ratio).toBeCloseTo(1.5, 2)
    expect(p.width).toBe(1920); expect(p.height).toBe(1080)
    const q = planCanvas({ cssW: 1280, cssH: 720, dpr: 2, hiDpi: true, minCssScale: 0.4 })   // auto: floor 0.4 must stay reachable
    expect(q.ratio).toBeCloseTo(0.4 / RENDER_SCALE_FLOOR, 2)
    expect(MAX_DPR_RATIO).toBe(1.5)
  })
  it('the presentation canvas stays under the pixel budget', () => {
    for (const [w, h, dpr] of [[1200, 800, 2], [1440, 900, 2], [1920, 1080, 2], [2560, 1440, 2], [412, 915, 2.625], [3840, 2160, 2]]) {
      const p = planCanvas({ cssW: w, cssH: h, dpr, hiDpi: true, minCssScale: 0.6 })
      if (p.ratio > 1.001) expect(p.width * p.height, `${w}x${h}@${dpr}`).toBeLessThanOrEqual(CANVAS_PX_BUDGET * 1.001)
      expect(p.ratio).toBeGreaterThanOrEqual(1)
      expect(p.ratio).toBeLessThanOrEqual(MAX_DPR_RATIO + 1e-9)
    }
    // a 1080p css window on a 2x display may only grow to sqrt(2.6M/2.07M) = 1.12
    expect(planCanvas({ cssW: 1920, cssH: 1080, dpr: 2, hiDpi: true, minCssScale: 0.6 }).ratio).toBeCloseTo(1.12, 1)
    // an already-huge css window (4K at dpr 1... or dpr 2) is never shrunk below css size
    expect(planCanvas({ cssW: 3840, cssH: 2160, dpr: 2, hiDpi: true, minCssScale: 0.6 }).ratio).toBe(1)
  })
  it('the INTERNAL pixel count does not depend on the ratio: renderScale = cssScale / ratio', () => {
    for (const cssScale of [0.4, 0.5, 0.6, 0.75, 0.9]) {
      for (const dpr of [1, 1.25, 1.5, 2, 3]) {
        const p = planCanvas({ cssW: 1366, cssH: 768, dpr, hiDpi: true, minCssScale: cssScale })
        const rs = renderScaleFor(cssScale, p.ratio)
        expect(rs).toBeGreaterThanOrEqual(RENDER_SCALE_FLOOR)                     // gfx-cpu.js would ignore anything lower
        const internal = Math.round(p.width * rs) * Math.round(p.height * rs)
        const wanted = Math.round(1366 * cssScale) * Math.round(768 * cssScale)
        expect(Math.abs(internal - wanted) / wanted, `scale ${cssScale} dpr ${dpr}`).toBeLessThan(0.01)
      }
    }
  })
  it('copes with nonsense input', () => {
    expect(planCanvas({}).ratio).toBe(1)
    expect(planCanvas({ cssW: NaN, cssH: 0, dpr: NaN, hiDpi: true }).width).toBeGreaterThanOrEqual(1)
    expect(renderScaleFor(0.6, 0)).toBe(0.6)
    expect(renderScaleFor(0.1, 1)).toBe(RENDER_SCALE_FLOOR)
    expect(renderScaleFor(5, 1)).toBe(1)
  })
})

// ────────────────────────────────────────── the adaptive controller ──────────────────────────────────────────
const TIER_MUL = { low: 1, medium: 1.2, high: 1.6 }
// simulated frames at a fixed refresh: work (ms of CPU) from a cost model; the frame time a real display reports is the
// work rounded UP to a whole number of vsyncs (a 60 Hz display shows 16.7 ms whether the work took 3 ms or 15).
function sim(ctl, { seconds, work, vsync = 1000 / 60, noise = 0, seed = 1, hitch = null, passWork = true, t0 = 0 }) {
  const r = mulberry32(seed), log = []
  let t = t0, i = 0
  const end = t0 + seconds * 1000
  while (t < end) {
    let w = work(ctl.scale, ctl.tier, t / 1000)
    if (noise) w *= 1 + noise * (r() * 2 - 1)
    let frame = Math.max(vsync, Math.ceil(w / vsync - 1e-9) * vsync)
    if (hitch) frame += hitch(i, t / 1000) || 0
    const changed = ctl.update(frame, passWork ? w : undefined)
    t += frame; i++
    if (changed) log.push({ t: t / 1000, tier: ctl.tier, scale: ctl.scale, reason: ctl.reason })
  }
  return log
}
// cost = fixed + k * scale^2 * tier multiplier   (k = ms per unit of squared scale at the cheapest tier)
const model = (fixed, k) => (s, tier) => fixed + k * s * s * TIER_MUL[tier]

describe('createAdaptiveController', () => {
  const start = (o = {}) => createAdaptiveController({ tier: 'high', scale: 0.75, ...o })

  it('starts where it is told, on the 0.01 grid, inside its bounds', () => {
    const c = start()
    expect(c.tier).toBe('high'); expect(c.scale).toBe(0.75)
    expect(createAdaptiveController({ tier: 'low' }).scale).toBe(TIERS.low.scale)
    expect(createAdaptiveController({ tier: 'medium', scale: 0.3 }).scale).toBe(0.4)          // clamped up to the floor
    expect(createAdaptiveController({ tier: 'medium', scale: 0.99 }).scale).toBe(0.9)         // clamped down to the ceiling
    expect(createAdaptiveController({ tier: 'nonsense' }).tier).toBe('medium')
  })

  it('steady, comfortably fast frames: never steps down; climbs slowly to its ceiling and stops', () => {
    const c = start({ tier: 'medium', scale: 0.6, maxTier: 'medium' })
    const log = sim(c, { seconds: 240, work: model(2, 8) })
    expect(log.length).toBeGreaterThan(0)
    expect(log.every((e) => e.reason === 'up-scale')).toBe(true)
    expect(c.scale).toBe(0.75)                                                                 // medium: nominal 0.6 + 0.15
    expect(c.tier).toBe('medium')
    for (let i = 1; i < log.length; i++) expect(log[i].t - log[i - 1].t).toBeGreaterThanOrEqual(10)   // "up slowly"
    expect(log[0].t).toBeGreaterThanOrEqual(8)                                                   // 8 s of unbroken headroom first
  })

  it('a hitch storm (lone 400 ms stalls, a few 100 ms frames) does not move it', () => {
    const c = start()
    const log = sim(c, {
      seconds: 120, work: model(2, 8),
      hitch: (i) => (i % 700 === 350 ? 400 : i % 300 === 100 ? 80 : 0),
    })
    expect(log.filter((e) => e.reason.startsWith('down'))).toEqual([])
    expect(c.stalls).toBeGreaterThan(0)
  })

  it('one or two consecutive very long frames are a stall (ignored); a run of them is a machine that cannot keep up (acted on)', () => {
    const c = start({ scale: 0.9 })                                                             // at its ceiling: healthy frames cannot move it
    for (let i = 0; i < 400; i++) c.update(16.7, 5)                                             // past the startup warm-up, healthy
    for (let rep = 0; rep < 20; rep++) { c.update(600, 5); c.update(700, 5); for (let i = 0; i < 40; i++) c.update(16.7, 5) }
    expect(c.changes).toBe(0)                                                                   // pairs of half-second stalls, 20 times: nothing
    expect(c.stalls).toBe(40)
    // now every frame takes 400-500 ms (2 fps): the old filter called all of that "stalls" and never adapted
    let changed = false
    for (let i = 0; i < 60 && !changed; i++) changed = c.update(450, 300)
    expect(changed).toBe(true)
    expect(c.reason).toBe('down-scale')
    expect(c.scale).toBeLessThanOrEqual(0.5)                                                    // a big overload takes a big step (winsorised, but proportional)
  })

  it('a hopeless machine (every frame 450 ms) walks down to the floor and then sheds the tier', () => {
    const c = start()
    const log = sim(c, { seconds: 240, work: () => 450, vsync: 450, passWork: true })
    expect(log.length).toBeGreaterThan(0)
    expect(c.scale).toBe(0.4); expect(c.tier).toBe('low')
    expect(log.find((e) => e.reason === 'down-tier').scale).toBe(0.4)                           // still scale first, tier only at the floor
  })

  it('a periodic GC-like burst (3 slow frames every 1.5 s) is diluted by the window: still no step down', () => {
    const c = start()
    const log = sim(c, { seconds: 90, work: model(2, 8), hitch: (i) => (i % 90 < 3 ? 45 : 0) })
    expect(log.filter((e) => e.reason.startsWith('down'))).toEqual([])
  })

  it('but a persistent stutter (3 slow frames in every 30) IS treated as overload', () => {
    const c = start()
    const log = sim(c, { seconds: 60, work: model(2, 8), hitch: (i) => (i % 30 < 3 ? 45 : 0) })
    expect(log.some((e) => e.reason === 'down-scale')).toBe(true)
  })

  it('an overload that starts mid-run is answered in about a second (down fast)', () => {
    const c = start()
    const cost = (s, tier, t) => (t < 20 ? model(2, 8) : model(3, 41))(s, tier)                // healthy for 20 s, then a 25 fps machine
    const log = sim(c, { seconds: 40, work: cost })
    const first = log.find((e) => e.t > 20)
    expect(first.reason).toBe('down-scale')
    expect(first.t - 20).toBeLessThan(1.6)
    expect(first.t - 20).toBeGreaterThan(0)
  })

  it('sustained overload from the very start: waits out the 2 s startup, then settles proportionally under budget without touching the tier', () => {
    const c = start()
    const cost = model(3, 41)                                                                   // 40 ms at high/0.75: a 25 fps machine
    const log = sim(c, { seconds: 60, work: cost })
    expect(log[0].reason).toBe('down-scale')
    expect(log[0].t).toBeGreaterThanOrEqual(2)                                                  // cold-start frames are not a fair sample
    expect(log[0].t).toBeLessThan(3.5)
    expect(log.every((e) => e.tier === 'high')).toBe(true)                                     // the scale dial absorbed it all
    expect(cost(c.scale, c.tier)).toBeLessThanOrEqual(1000 / 60)                               // work now fits one 60 Hz frame
    expect(c.scale).toBeGreaterThan(0.4)                                                       // and it did not over-correct to the floor
    expect(log.length).toBeLessThanOrEqual(3)                                                  // 1-2 steps to converge, not a crawl
    // once settled, nothing else happens
    const later = sim(c, { seconds: 120, work: cost, t0: 60000 })
    expect(later).toEqual([])
  })

  it('a big overload reaches the floor quickly, and ONLY THEN steps the tier down', () => {
    const c = start()
    const cost = model(5, 120)                                                                  // hopeless at any scale of the high tier
    const log = sim(c, { seconds: 60, work: cost })
    const firstTier = log.findIndex((e) => e.reason === 'down-tier')
    expect(firstTier).toBeGreaterThan(-1)
    for (const e of log.slice(0, firstTier)) { expect(e.reason).toBe('down-scale'); expect(e.tier).toBe('high') }
    expect(log[firstTier - 1].scale).toBe(0.4)                                                  // the floor was hit first
    expect(log[firstTier].scale).toBe(0.4)                                                      // and the tier drop keeps it there
    expect(log[firstTier].tier).toBe('medium')
    // it walks all the way down while the machine cannot cope, and stops at the bottom
    expect(c.tier).toBe('low'); expect(c.scale).toBe(0.4); expect(c.atFloor).toBe(true)
    expect(log[log.length - 1].t).toBeLessThan(15)
  })

  it('the floor is a floor: nothing more happens when even (low, 0.4) is too slow', () => {
    const c = createAdaptiveController({ tier: 'low', scale: 0.4 })
    const log = sim(c, { seconds: 60, work: () => 90 })
    expect(log).toEqual([])
    expect(c.scale).toBe(0.4); expect(c.tier).toBe('low'); expect(c.atFloor).toBe(true)
  })

  it('a machine just over budget at the floor keeps its tier (features are only shed when it is really struggling)', () => {
    const c = createAdaptiveController({ tier: 'medium', scale: 0.4 })
    const log = sim(c, { seconds: 60, work: () => 25, vsync: 1000 / 40 })                        // 40 fps: over the 20.8 ms budget, under 1.3x
    expect(log.filter((e) => e.reason === 'down-tier')).toEqual([])
    expect(c.tier).toBe('medium')
  })

  it('recovery: after the overload ends it climbs back up, slowly, to where it started and no further', () => {
    const c = start()
    const heavy = model(3, 41), light = model(2, 7)
    const phase = (s, t) => (t < 30 ? heavy(s, 'high') : light(s, 'high'))
    const log = sim(c, { seconds: 400, work: (s, tier, t) => (t < 30 ? heavy(s, tier) : light(s, tier)) })
    void phase
    const downs = log.filter((e) => e.reason.startsWith('down'))
    const ups = log.filter((e) => e.reason.startsWith('up'))
    expect(downs.length).toBeGreaterThan(0)
    expect(ups.length).toBeGreaterThan(0)
    expect(ups[0].t).toBeGreaterThan(30)                                                          // nothing goes up while overloaded
    expect(c.scale).toBeGreaterThanOrEqual(0.75)                                                  // recovered
    expect(c.scale).toBeLessThanOrEqual(0.9)                                                      // never past the ceiling
    for (let i = 1; i < ups.length; i++) expect(ups[i].t - ups[i - 1].t).toBeGreaterThanOrEqual(10)
  })

  it('tier recovery: back up one tier at a time, only after the scale is at its ceiling, waiting 30 s each time', () => {
    const c = createAdaptiveController({ tier: 'low', scale: 0.4, maxTier: 'high' })
    const log = sim(c, { seconds: 900, work: model(2, 6) })                                       // an idle machine
    expect(c.tier).toBe('high'); expect(c.scale).toBe(0.9)
    const tierUps = log.filter((e) => e.reason === 'up-tier')
    expect(tierUps.map((e) => e.tier)).toEqual(['medium', 'high'])
    for (const e of tierUps) {
      const prev = log[log.indexOf(e) - 1]
      expect(prev.reason).toBe('up-scale')                                                        // the scale dial went first
    }
    expect(log.some((e) => e.reason.startsWith('down'))).toBe(false)
  })

  it('the tier never rises above maxTier (the device-class ceiling)', () => {
    const c = createAdaptiveController({ tier: 'low', scale: 0.4, maxTier: 'medium' })
    sim(c, { seconds: 900, work: model(1, 3) })
    expect(c.tier).toBe('medium')
    expect(c.scale).toBeLessThanOrEqual(0.75)
  })

  it('does not oscillate on a borderline load: it settles, and stays settled', () => {
    // 60 Hz vsync: work must stay under 16.7 ms. Choose k so 0.5 fits (15.6 ms) and 0.55 (17.6) does not, model error included.
    const cost = model(2, 34)                                                                     // 2 + 34*s^2 : 0.5 -> 10.5 (x1 low) ; high x1.6
    for (const tier of ['low', 'medium', 'high']) {
      const c = createAdaptiveController({ tier, scale: 0.9, maxTier: tier })
      const log = sim(c, { seconds: 900, work: cost })
      const late = log.filter((e) => e.t > 600)
      expect(late.length, `${tier}: changes after 10 minutes`).toBeLessThanOrEqual(1)
      expect(log.length, `${tier}: total changes in 15 minutes`).toBeLessThanOrEqual(14)
    }
  })

  it('does not oscillate under noise (+-15% work, 60 Hz vsync quantisation)', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const c = start({ tier: 'medium', scale: 0.6, maxTier: 'medium' })
      const log = sim(c, { seconds: 900, work: model(3, 30), noise: 0.15, seed })
      expect(log.filter((e) => e.t > 600).length, `seed ${seed}`).toBeLessThanOrEqual(2)
      expect(log.length, `seed ${seed}`).toBeLessThanOrEqual(16)
    }
  })

  it('a cost model that grows faster than scale^2 (the predictor is wrong) is penalised into stability', () => {
    const cost = (s, tier) => 2 + 60 * Math.pow(s, 3.2) * TIER_MUL[tier]
    const c = createAdaptiveController({ tier: 'medium', scale: 0.6, maxTier: 'medium' })
    const log = sim(c, { seconds: 1800, work: cost })
    expect(log.filter((e) => e.t > 900).length).toBeLessThanOrEqual(2)
    expect(log.length).toBeLessThanOrEqual(20)
  })

  it('a load that steps up and down every 20 s does not make it thrash', () => {
    const c = start({ tier: 'medium', scale: 0.6, maxTier: 'medium' })
    const cost = (s, tier, t) => model(2, Math.floor(t / 20) % 2 ? 55 : 10)(s, tier)
    const log = sim(c, { seconds: 900, work: cost })
    expect(log.length).toBeLessThanOrEqual(60)                                                    // <= one change per 15 s on average
    for (let i = 1; i < log.length; i++) if (log[i].reason.startsWith('up')) expect(log[i].t - log[i - 1].t).toBeGreaterThanOrEqual(9.5)
  })

  it('without workMs (frame time only) it still backs off when slow, and never climbs on a vsync-limited display', () => {
    const c = start({ tier: 'medium', scale: 0.6, maxTier: 'medium' })
    const slow = sim(c, { seconds: 30, work: model(3, 90), passWork: false })
    expect(slow.some((e) => e.reason === 'down-scale')).toBe(true)
    const c2 = start({ tier: 'medium', scale: 0.6, maxTier: 'medium' })
    const fast = sim(c2, { seconds: 120, work: model(1, 4), passWork: false })                     // 60 Hz shows 16.7 ms: no headroom visible
    expect(fast).toEqual([])
    // ...but a 144 Hz display makes the headroom visible in the frame time itself
    const c3 = start({ tier: 'medium', scale: 0.6, maxTier: 'medium' })
    const hi = sim(c3, { seconds: 120, work: model(1, 4), passWork: false, vsync: 1000 / 144 })
    expect(hi.some((e) => e.reason === 'up-scale')).toBe(true)
  })

  it('a 30 fps cap widens the budget: 33 ms frames are not "slow", 60 ms frames are', () => {
    const c = start({ tier: 'medium', scale: 0.6, maxTier: 'medium', targetFps: 30 })
    expect(sim(c, { seconds: 30, work: () => 30, vsync: 1000 / 30 }).filter((e) => e.reason.startsWith('down'))).toEqual([])
    const c2 = start({ tier: 'medium', scale: 0.6, maxTier: 'medium' })
    c2.setTargetFps(30)
    expect(c2.budgetMs).toBeCloseTo(1000 / 30 * 1.25, 6)
    expect(sim(c2, { seconds: 30, work: (s) => 100 * s, vsync: 1000 / 30 }).some((e) => e.reason === 'down-scale')).toBe(true)
  })

  it('ignores garbage input', () => {
    const c = start()
    for (const v of [NaN, -5, 0, Infinity, undefined, null, '16']) expect(c.update(v)).toBe(false)
    expect(c.scale).toBe(0.75)
  })

  it('setBounds re-clamps the scale (a resize changed the pixel budget) and force() jumps', () => {
    const c = start()
    expect(c.setBounds(0.4, 0.6)).toBe(true); expect(c.scale).toBe(0.6)
    expect(c.setBounds(0.4, 0.9)).toBe(false); expect(c.scale).toBe(0.6)
    c.force('low', 0.45); expect(c.tier).toBe('low'); expect(c.scale).toBe(0.45)
  })

  it('property: over random workloads the scale is always on the grid and within 0.4..0.9, the tier always valid', () => {
    for (let seed = 1; seed <= 12; seed++) {
      const r = mulberry32(seed * 977)
      const c = createAdaptiveController({ tier: TIER_ORDER[seed % 3], maxTier: 'high' })
      const cost = (s, tier, t) => (2 + (5 + 100 * r()) * s * s * TIER_MUL[tier]) * (1 + 0.5 * Math.sin(t / (3 + seed)))
      let lo = 9, hi = 0
      const log = sim(c, { seconds: 300, work: cost, noise: 0.3, seed })
      for (const e of [{ scale: c.scale, tier: c.tier }, ...log]) {
        lo = Math.min(lo, e.scale); hi = Math.max(hi, e.scale)
        expect(TIER_ORDER).toContain(e.tier)
        expect(Math.abs(e.scale * 20 - Math.round(e.scale * 20))).toBeLessThan(1e-6)
      }
      expect(lo).toBeGreaterThanOrEqual(0.4 - 1e-9); expect(hi).toBeLessThanOrEqual(0.9 + 1e-9)
    }
  })
})

// ──────────────────────────────────────────── the quality director ────────────────────────────────────────────
describe('createQualityDirector', () => {
  const env = { mid: { deviceMemory: 4, hardwareConcurrency: 4 }, low: { deviceMemory: 4, hardwareConcurrency: 2 }, high: { deviceMemory: 8, hardwareConcurrency: 8 } }

  it('auto starts from the device class and writes tier + scale into renderOpts', () => {
    const cases = [['low', 'low', 0.5], ['mid', 'medium', 0.6], ['high', 'high', 0.75]]
    for (const [cls, tier, scale] of cases) {
      const d = createQualityDirector({ env: env[cls], graphicsQuality: 'auto' })
      d.layout(1280, 720, 1)
      const ro = {}
      d.apply(ro)
      expect(ro.qualityTier, cls).toBe(tier)
      expect(ro.renderScale, cls).toBe(scale)
      expect(ro.uiScale).toBe(1)
      expect(d.deviceClass).toBe(cls)
    }
  })
  it('auto respects the internal pixel budget: a 4K window starts at the floor, a small one at the tier scale', () => {
    const big = createQualityDirector({ env: env.mid, graphicsQuality: 'auto' })
    big.layout(3840, 2160, 1)
    expect(big.apply({}).renderScale).toBe(0.4)
    const hd = createQualityDirector({ env: env.mid, graphicsQuality: 'auto' })
    hd.layout(1920, 1080, 1)
    expect(hd.apply({}).renderScale).toBe(0.6)                                     // 746 k px: within the mid budget, look unchanged
    const lowbox = createQualityDirector({ env: env.low, graphicsQuality: 'auto' })
    lowbox.layout(1366, 768, 1)
    expect(lowbox.apply({}).renderScale).toBe(0.5)
  })
  it('fixed tiers apply that tier at its own scale and never adapt', () => {
    for (const t of ['low', 'medium', 'high']) {
      const d = createQualityDirector({ env: env.mid, graphicsQuality: t })
      d.layout(1280, 720, 1)
      const ro = { renderScale: 0.42 }
      d.apply(ro)
      expect(ro.qualityTier).toBe(t)
      expect('renderScale' in ro).toBe(false)                                       // the renderer uses the tier's own scale
      for (let i = 0; i < 2000; i++) expect(d.frame(200, 200)).toBe(false)
    }
  })
  it('legacy is today\'s renderer: tier legacy, no scale override, no DPR', () => {
    const d = createQualityDirector({ env: env.high, graphicsQuality: 'legacy', hiDpi: true })
    const plan = d.layout(1280, 720, 2)
    expect(plan.ratio).toBe(1); expect(plan.width).toBe(1280)
    const ro = {}; d.apply(ro)
    expect(ro.qualityTier).toBe('legacy'); expect('renderScale' in ro).toBe(false)
  })
  it('unknown or missing graphicsQuality falls back to auto', () => {
    expect(createQualityDirector({ env: env.mid, graphicsQuality: 'ultra' }).mode).toBe('auto')
    expect(createQualityDirector({ env: env.mid }).mode).toBe('auto')
    expect(GRAPHICS_CHOICES).toEqual(['auto', 'low', 'medium', 'high', 'legacy'])
  })
  it('auto adapts: sustained slow frames step renderScale down and report the change; apply() carries it', () => {
    const d = createQualityDirector({ env: env.high, graphicsQuality: 'auto' })
    d.layout(1280, 720, 1)
    const ro = {}; d.apply(ro)
    expect(ro.renderScale).toBe(0.75)
    let changed = false
    for (let i = 0; i < 400 && !changed; i++) changed = d.frame(50, 40)
    expect(changed).toBe(true)
    d.apply(ro)
    expect(ro.renderScale).toBeLessThan(0.75)
    expect(ro.renderScale).toBeGreaterThanOrEqual(0.4)
  })
  it('hiDpi: the backing store grows, uiScale reports it, and renderScale compensates so the internal pixels are unchanged', () => {
    const off = createQualityDirector({ env: env.mid, graphicsQuality: 'medium', hiDpi: false })
    const on = createQualityDirector({ env: env.mid, graphicsQuality: 'medium', hiDpi: true })
    const p0 = off.layout(1280, 720, 2), p1 = on.layout(1280, 720, 2)
    expect(p0.width).toBe(1280)
    expect(p1.width).toBeGreaterThan(1280)
    const ro = {}; on.apply(ro)
    expect(ro.uiScale).toBeCloseTo(p1.width / 1280, 3)
    const internalOn = Math.round(p1.width * ro.renderScale) * Math.round(p1.height * ro.renderScale)
    expect(Math.abs(internalOn - 768 * 432) / (768 * 432)).toBeLessThan(0.01)
  })
  it('auto + hiDpi keeps the 0.4 floor reachable (renderScale never below the renderer\'s 0.3)', () => {
    const d = createQualityDirector({ env: env.low, graphicsQuality: 'auto', hiDpi: true })
    const plan = d.layout(1280, 800, 2)
    expect(plan.ratio).toBeGreaterThan(1)
    const ro = {}
    for (let i = 0; i < 3000; i++) { if (d.frame(90, 80)) d.apply(ro) }
    d.apply(ro)
    expect(ro.renderScale).toBeGreaterThanOrEqual(RENDER_SCALE_FLOOR)
    expect(d.state.cssScale).toBe(0.4)                                            // the spec's floor, exactly, even with the canvas 4/3 larger
    expect(Math.abs(ro.renderScale * plan.ratio - 0.4)).toBeLessThan(0.002)       // and renderScale x ratio really is that
  })
  it('for a range of window sizes the auto floor stays exactly 0.4 (width rounding must not raise it)', () => {
    for (const [w, h] of [[1280, 720], [1366, 768], [1707, 960], [960, 516], [1001, 601], [1920, 1080], [412, 915], [1437, 803]]) {
      const d = createQualityDirector({ env: env.low, graphicsQuality: 'auto', hiDpi: true })
      d.layout(w, h, 2)
      const ro = {}
      for (let i = 0; i < 4000; i++) { if (d.frame(120, 110)) d.apply(ro) }
      expect(d.state.cssScale, `${w}x${h}`).toBe(0.4)
    }
  })
  it('apply() and state before the first layout() do not throw (an empty layout is assumed)', () => {
    const d = createQualityDirector({ env: env.mid, graphicsQuality: 'auto' })
    const ro = {}
    expect(() => d.apply(ro)).not.toThrow()
    expect(ro.qualityTier).toBe('medium')
    expect(() => d.state).not.toThrow()
    expect(d.frame(16, 5)).toBe(false)
    d.layout(1280, 720, 1)
    expect(d.apply({}).renderScale).toBe(0.6)
  })
  it('live preference changes: quality mode and hiDpi ask for a new layout; fpsCap does not', () => {
    const d = createQualityDirector({ env: env.mid, graphicsQuality: 'auto' })
    d.layout(1280, 720, 2)
    expect(d.setPrefs({ fpsCap: 30 })).toBe(false)
    expect(d.setPrefs({ hiDpi: true })).toBe(true)
    expect(d.setPrefs({ hiDpi: true })).toBe(false)                              // unchanged
    expect(d.setPrefs({ graphicsQuality: 'high' })).toBe(true)
    expect(d.mode).toBe('high')
    expect(d.setPrefs({ graphicsQuality: 'bogus' })).toBe(false)
    expect(d.mode).toBe('high')
    const ro = {}; d.apply(ro); expect(ro.qualityTier).toBe('high')
    d.setPrefs({ graphicsQuality: 'auto' })
    d.layout(1280, 720, 2); d.apply(ro)
    expect(TIER_ORDER).toContain(ro.qualityTier)
  })
  it('state reports what is applied', () => {
    const d = createQualityDirector({ env: env.mid, graphicsQuality: 'auto' })
    d.layout(1280, 720, 1)
    expect(d.state).toMatchObject({ mode: 'auto', tier: 'medium', cssScale: 0.6, ratio: 1, width: 1280, height: 720, deviceClass: 'mid' })
  })
})

// ─────────────────────────────────────────── renderer selection ───────────────────────────────────────────
describe('pickRenderer truth table', () => {
  const good = { probe: { webgl2: true, majorPerformanceCaveat: false }, unmaskedRenderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)', softwareRender: false, crashMarker: null, now: 1000 }
  const pick = (o) => pickRenderer({ ...good, ...o })
  const table = [
    // description, env override, backend, reason
    ['auto with a healthy GPU', {}, 'gpu', 'auto'],
    ['pref gpu with a healthy GPU', { pref: 'gpu' }, 'gpu', 'forced'],
    ['pref cpu', { pref: 'cpu' }, 'cpu', 'pref-cpu'],
    ['?renderer=cpu beats pref gpu', { pref: 'gpu', urlOverride: 'cpu' }, 'cpu', 'url-cpu'],
    ['?renderer=cpu beats a healthy auto', { urlOverride: 'cpu' }, 'cpu', 'url-cpu'],
    ['?renderer=gpu forces gpu over pref cpu?  no: pref cpu is a kill switch too', { pref: 'cpu', urlOverride: 'gpu' }, 'cpu', 'pref-cpu'],
    ['?renderer=gpu on auto', { urlOverride: 'gpu' }, 'gpu', 'forced'],
    ['not probed yet', { probe: null }, 'cpu', 'not-probed'],
    ['probe reports no WebGL2', { probe: { webgl2: false } }, 'cpu', 'no-webgl2'],
    ['probe reports a performance caveat (software GL)', { probe: { webgl2: true, majorPerformanceCaveat: true } }, 'cpu', 'software-gl'],
    ['UNMASKED_RENDERER says SwiftShader', { unmaskedRenderer: 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)' }, 'cpu', 'software-gl'],
    ['UNMASKED_RENDERER says llvmpipe', { unmaskedRenderer: 'llvmpipe (LLVM 15.0.7, 256 bits)' }, 'cpu', 'software-gl'],
    ['UNMASKED_RENDERER says Basic Render Driver', { unmaskedRenderer: 'ANGLE (Microsoft, Microsoft Basic Render Driver Direct3D11)' }, 'cpu', 'software-gl'],
    ['software GL is refused even when gpu is forced (the CPU raycaster is faster)', { pref: 'gpu', unmaskedRenderer: 'Google SwiftShader' }, 'cpu', 'software-gl'],
    ['software GL is refused even for ?renderer=gpu', { urlOverride: 'gpu', unmaskedRenderer: 'llvmpipe' }, 'cpu', 'software-gl'],
    ['the Electron software-rendering setting', { softwareRender: true }, 'cpu', 'software-render-setting'],
    ['the software-rendering setting beats a forced gpu pref', { softwareRender: true, pref: 'gpu' }, 'cpu', 'software-render-setting'],
    ['a crash loop', { crashMarker: { armedAt: 500, count: 2 } }, 'cpu', 'crash-loop'],
    ['a crash loop beats a forced gpu pref', { crashMarker: { armedAt: 500, count: 3 }, pref: 'gpu' }, 'cpu', 'crash-loop'],
    ['?renderer=gpu is the explicit escape from a crash loop', { crashMarker: { armedAt: 500, count: 3 }, urlOverride: 'gpu' }, 'gpu', 'forced'],
    ['one unclean start is not a loop yet', { crashMarker: { armedAt: 500, count: 1 } }, 'gpu', 'auto'],
    ['a stale marker (over a day old) is ignored', { crashMarker: { armedAt: 0, count: 5 }, now: CRASH_EXPIRY_MS + 10 }, 'gpu', 'auto'],
    ['a garbage pref value means auto', { pref: 'ultra' }, 'gpu', 'auto'],
    ['a garbage url override is ignored', { urlOverride: 'both' }, 'gpu', 'auto'],
    ['unmasked renderer unknown (null) is not treated as software', { unmaskedRenderer: null }, 'gpu', 'auto'],
  ]
  for (const [name, o, backend, reason] of table) {
    it(`${name} -> ${backend} (${reason})`, () => expect(pick(o)).toEqual({ backend, reason }))
  }
  it('no arguments at all is the CPU renderer', () => expect(pickRenderer()).toEqual({ backend: 'cpu', reason: 'not-probed' }))
  it('never returns anything but cpu or gpu, and gpu only when a probe said WebGL2 works', () => {
    const r = mulberry32(3)
    const opts = { pref: ['auto', 'gpu', 'cpu', 'x'], urlOverride: ['cpu', 'gpu', null, 'x'], softwareRender: [true, false], probe: [null, { webgl2: false }, { webgl2: true }, { webgl2: true, majorPerformanceCaveat: true }],
      unmaskedRenderer: [null, 'NVIDIA', 'SwiftShader'], crashMarker: [null, { armedAt: 1, count: 1 }, { armedAt: 1, count: 4 }] }
    for (let i = 0; i < 500; i++) {
      const env = { now: 10 }
      for (const [k, list] of Object.entries(opts)) env[k] = list[Math.floor(r() * list.length)]
      const out = pickRenderer(env)
      expect(['cpu', 'gpu']).toContain(out.backend)
      if (out.backend === 'gpu') { expect(env.probe && env.probe.webgl2).toBeTruthy(); expect(env.probe.majorPerformanceCaveat).toBeFalsy(); expect(isSoftwareGl(env.unmaskedRenderer)).toBe(false); expect(env.softwareRender).toBe(false); expect(env.pref).not.toBe('cpu'); expect(env.urlOverride).not.toBe('cpu') }
    }
  })
})

describe('isSoftwareGl / parseRendererOverride', () => {
  it('recognises the usual software rasterisers and leaves real GPUs alone', () => {
    for (const s of ['Google SwiftShader', 'llvmpipe (LLVM 12)', 'softpipe', 'Mesa OffScreen', 'Microsoft Basic Render Driver', 'D3D11 WARP', 'Apple Software Renderer'])
      expect(isSoftwareGl(s), s).toBe(true)
    for (const s of ['ANGLE (NVIDIA, NVIDIA GeForce RTX 3060)', 'Adreno (TM) 640', 'Apple M2', 'Mali-G78', 'Intel(R) UHD Graphics 620', '', null, undefined, 42])
      expect(isSoftwareGl(s), String(s)).toBe(false)
  })
  it('parses ?renderer= from a query string or URLSearchParams', () => {
    expect(parseRendererOverride('?renderer=cpu')).toBe('cpu')
    expect(parseRendererOverride('?a=1&renderer=GPU')).toBe('gpu')
    expect(parseRendererOverride('?renderer=both')).toBeNull()
    expect(parseRendererOverride('')).toBeNull()
    expect(parseRendererOverride(new URLSearchParams('renderer=cpu'))).toBe('cpu')
    expect(parseRendererOverride(undefined)).toBeNull()
  })
})

describe('crash-loop breaker', () => {
  it('lifecycle: healthy runs clear the marker; two unclean starts in a row trip it; the third start falls back to the CPU', () => {
    let stored = null
    const start = (now) => { const tripped = crashLoopTripped(stored, now); if (!tripped) stored = armCrashMarker(stored, now); return tripped }
    // run 1: healthy
    expect(start(1000)).toBe(false)
    expect(stored.count).toBe(1)
    stored = tickCrashMarker(stored, CRASH_HEALTHY_FRAMES)                   // 120 healthy frames -> cleared
    expect(stored).toBeNull()
    // run 2 and 3: the page dies before the marker is cleared
    expect(start(2000)).toBe(false); expect(stored.count).toBe(1)
    expect(start(3000)).toBe(false); expect(stored.count).toBe(2)            // the marker survived run 2: this start arms count 2
    // run 4: tripped
    expect(start(4000)).toBe(true)
    expect(stored.count).toBe(CRASH_LIMIT)                                    // not re-armed while tripped
    expect(pickRenderer({ probe: { webgl2: true }, crashMarker: stored, now: 4000 })).toEqual({ backend: 'cpu', reason: 'crash-loop' })
  })
  it('tickCrashMarker keeps the marker until N healthy frames have passed', () => {
    const m = armCrashMarker(null, 5)
    expect(tickCrashMarker(m, 0)).toBe(m)
    expect(tickCrashMarker(m, CRASH_HEALTHY_FRAMES - 1)).toBe(m)
    expect(tickCrashMarker(m, CRASH_HEALTHY_FRAMES)).toBeNull()
    expect(tickCrashMarker(m, 10000)).toBeNull()
  })
  it('an old or malformed marker starts a fresh count and never trips', () => {
    expect(armCrashMarker({ armedAt: 0, count: 9 }, CRASH_EXPIRY_MS + 1)).toEqual({ armedAt: CRASH_EXPIRY_MS + 1, count: 1 })
    expect(armCrashMarker({ nope: true }, 100)).toEqual({ armedAt: 100, count: 1 })
    expect(armCrashMarker(undefined, 100).count).toBe(1)
    for (const bad of [null, undefined, {}, { count: 5 }, { armedAt: 1 }, { armedAt: 1, count: 0 }, { armedAt: 1, count: -3 }, 'x', 7])
      expect(crashLoopTripped(bad, 10)).toBe(false)
    expect(crashLoopTripped({ armedAt: 0, count: 9 }, CRASH_EXPIRY_MS + 1)).toBe(false)
    expect(crashLoopTripped({ armedAt: 5, count: 9 }, 10)).toBe(true)
  })
  it('the limit is configurable and the module stays import-safe', () => {
    expect(crashLoopTripped({ armedAt: 1, count: 3 }, 2, 4)).toBe(false)
    expect(crashLoopTripped({ armedAt: 1, count: 4 }, 2, 4)).toBe(true)
    expect(typeof document).toBe('undefined')
  })
})
