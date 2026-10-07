import { describe, it, expect } from 'vitest'
import { createTension, huntDelta, calmDelta, heartbeatPeriod, TENSION_ENTER, TENSION_EXIT } from '../src/renderer/tension.js'

const calm = { hunted: false, nearest: Infinity, gaze: false, arcPending: false }
const hunted = (nearest) => ({ hunted: true, nearest, gaze: false, arcPending: false })

// run n frames of dt with a fixed threat; returns the last result
function run(t, seconds, threat, hp = 100, dt = 0.05) {
  let out = null
  const n = Math.round(seconds / dt)
  for (let i = 0; i < n; i++) out = t.tick(dt, threat, hp)
  return out
}

describe('createTension level', () => {
  it('reaches 0.6 within 1 s of hunted=true at nearest 12', () => {
    const t = createTension()
    const r = run(t, 1, hunted(12))
    expect(r.level).toBeGreaterThanOrEqual(0.6)
    expect(r.level).toBeLessThanOrEqual(0.6 + 1e-9)
  })

  it('a closer hunter raises the target: nearest 0 → 1.0', () => {
    const t = createTension()
    expect(run(t, 2, hunted(0)).level).toBeCloseTo(1, 6)
  })

  it('decays below 0.25 only after >= 4 s of hunted=false', () => {
    const t = createTension()
    run(t, 2, hunted(6))                       // target 0.8
    expect(t.tick(0.05, hunted(6), 100).level).toBeCloseTo(0.8, 6)
    const at4 = run(t, 4, calm)
    expect(at4.level).toBeGreaterThanOrEqual(0.25)
    const at5 = run(t, 1, calm)
    expect(at5.level).toBeLessThan(0.25)
  })

  it('gaze, a pending arc and low hp each hold their own floor', () => {
    expect(run(createTension(), 2, { ...calm, gaze: true }).level).toBeCloseTo(0.35, 6)
    expect(run(createTension(), 2, { ...calm, arcPending: true }).level).toBeCloseTo(0.8, 6)
    expect(run(createTension(), 2, calm, 20).level).toBeCloseTo(0.4, 6)
    expect(run(createTension(), 2, calm, 25).level).toBe(0)
  })

  it('hands back one reused result object and tolerates a null threat', () => {
    const t = createTension()
    const a = t.tick(0.05, null, 100)
    const b = t.tick(0.05, calm, 100)
    expect(b).toBe(a)
    expect(a).toEqual({ level: 0, beat: Infinity, mood: 'calm', just: null, close: false })
  })
})

describe('mood hysteresis', () => {
  it('enters hunt only after 1.5 s above 0.55 and says so on exactly one frame', () => {
    const t = createTension()
    // level crosses 0.55 at ~0.61 s; hunt mood needs 1.5 s more → ~2.1 s
    const r1 = run(t, 1.8, hunted(0))
    expect(r1.mood).toBe('calm')
    let enters = 0, r
    for (let i = 0; i < 20; i++) { r = t.tick(0.05, hunted(0), 100); if (r.just === 'enter') enters++ }
    expect(r.mood).toBe('hunt')
    expect(enters).toBe(1)
    expect(r.just).toBeNull()
  })

  it('exits only after 6 s below 0.25; a 2 s dip does not exit', () => {
    const t = createTension()
    run(t, 3, hunted(0))
    expect(t.tick(0.05, hunted(0), 100).mood).toBe('hunt')
    // decay from 1.0 to below 0.25 takes 6.25 s; then dip for 2 s
    run(t, 6.3, calm)
    const dipped = run(t, 2, calm)
    expect(dipped.level).toBeLessThan(0.25)
    expect(dipped.mood).toBe('hunt')
    // the hunt resumes: the exit clock resets
    run(t, 1, hunted(0))
    expect(t.tick(0.05, hunted(0), 100).mood).toBe('hunt')
    // now let it go: 6.25 s to fall below 0.25, then 6 s more to exit
    run(t, 6.3, calm)
    const r5 = run(t, 5.5, calm)
    expect(r5.mood).toBe('hunt')
    let exits = 0, r
    for (let i = 0; i < 20; i++) { r = t.tick(0.05, calm, 100); if (r.just === 'exit') exits++ }
    expect(r.mood).toBe('calm')
    expect(exits).toBe(1)
  })

  it('reset() returns to calm at level 0 with no transition reported', () => {
    const t = createTension()
    run(t, 3, hunted(0))
    t.reset()
    const r = t.tick(0.05, calm, 100)
    expect(r).toEqual({ level: 0, beat: Infinity, mood: 'calm', just: null, close: false })
  })

  it('exposes the thresholds', () => {
    expect(TENSION_ENTER).toBe(0.55)
    expect(TENSION_EXIT).toBe(0.25)
  })
})

describe('heartbeatPeriod', () => {
  it('is Infinity below 0.15 and monotone decreasing above', () => {
    expect(heartbeatPeriod(0)).toBe(Infinity)
    expect(heartbeatPeriod(0.1499)).toBe(Infinity)
    let prev = heartbeatPeriod(0.15)
    expect(prev).toBeCloseTo(1.3 - 0.95 * 0.15)
    for (let l = 0.2; l <= 1.0001; l += 0.05) {
      const p = heartbeatPeriod(l)
      expect(p).toBeLessThan(prev)
      prev = p
    }
    expect(heartbeatPeriod(1)).toBeCloseTo(0.35)
  })

  it('tick reports beat from the level', () => {
    const t = createTension()
    const r = run(t, 2, hunted(0))
    expect(r.beat).toBeCloseTo(heartbeatPeriod(r.level))
  })
})

describe('close', () => {
  it('fires once per upward crossing of 0.85, throttled to one per 12 s', () => {
    const t = createTension()
    let closes = 0
    for (let i = 0; i < 60; i++) if (t.tick(0.05, hunted(0), 100).close) closes++
    expect(closes).toBe(1)
    // drop below and cross again within 12 s: throttled
    run(t, 2, calm)                                 // 1.0 → 0.76
    for (let i = 0; i < 40; i++) if (t.tick(0.05, hunted(0), 100).close) closes++
    expect(closes).toBe(1)
    // wait out the throttle below the line, then cross again
    run(t, 2, calm)
    run(t, 10, { ...calm, arcPending: true })       // holds 0.8, under the line
    for (let i = 0; i < 40; i++) if (t.tick(0.05, hunted(0), 100).close) closes++
    expect(closes).toBe(2)
  })
})

describe('huntDelta / calmDelta', () => {
  const base = { root: 220, scale: [0, 2, 4], tempo: 400, groove: 0.5, leadChance: 0.35, brightness: 1500, volume: 0.06 }

  it('huntDelta returns exactly groove, leadChance, brightness, volume and never tempo', () => {
    const d = huntDelta(base)
    expect(Object.keys(d).sort()).toEqual(['brightness', 'groove', 'leadChance', 'volume'])
    expect(d).toEqual({ groove: 1, leadChance: 0.05, brightness: 1500 * 0.7, volume: 0.06 * 1.15 })
    expect('tempo' in d).toBe(false)
  })

  it('calmDelta restores the base values for the same four keys', () => {
    const d = calmDelta(base)
    expect(Object.keys(d).sort()).toEqual(['brightness', 'groove', 'leadChance', 'volume'])
    expect(d).toEqual({ groove: 0.5, leadChance: 0.35, brightness: 1500, volume: 0.06 })
    expect('tempo' in d).toBe(false)
  })

  it('a base mood missing a key falls back to the engine defaults', () => {
    expect(calmDelta({})).toEqual({ groove: 0, leadChance: 0.35, brightness: 1200, volume: 0.06 })
    expect(huntDelta({})).toEqual({ groove: 1, leadChance: 0.05, brightness: 1200 * 0.7, volume: 0.06 * 1.15 })
  })
})
