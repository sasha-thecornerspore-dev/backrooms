import { describe, it, expect } from 'vitest'
import { createTension, huntDelta, calmDelta, heartbeatPeriod, TENSION_ENTER, TENSION_EXIT, DREAD_CAP, DREAD_K } from '../src/renderer/tension.js'

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
    expect(a).toEqual({ level: 0, beat: Infinity, mood: 'calm', just: null, close: false, huntLevel: 0 })
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
    expect(r).toEqual({ level: 0, beat: Infinity, mood: 'calm', just: null, close: false, huntLevel: 0 })
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

// ── dread (dread.js, T1-8): a creature near you through the maze, not hunting you, raises the floor of the level to at most DREAD_CAP —
//    above the heartbeat's floor, below the hunt's line. The pre-dread tick is kept here verbatim: with dread 0 (or no fourth argument)
//    every frame of a long scripted run matches it number for number, and huntLevel is that same level whatever dread does. ──
function legacyTension() {
  const res = { level: 0, beat: Infinity, mood: 'calm', just: null, close: false }
  let level = 0, mood = 'calm', above = 0, below = 0, was85 = false, closeCd = 0
  function tick(dt, threat, hp) {
    const th = threat || {}
    let target = 0
    if (th.hunted) target = 0.6 + 0.4 * (1 - Math.min(th.nearest ?? 12, 12) / 12)
    if (th.gaze && target < 0.35) target = 0.35
    if (th.arcPending && target < 0.8) target = 0.8
    if (hp < 25 && target < 0.4) target = 0.4
    level = level < target ? Math.min(target, level + 0.9 * dt) : Math.max(target, level - 0.12 * dt)
    let just = null
    if (mood === 'calm') {
      above = level > 0.55 ? above + dt : 0
      if (above >= 1.5) { mood = 'hunt'; just = 'enter'; above = 0; below = 0 }
    } else {
      below = level < 0.25 ? below + dt : 0
      if (below >= 6) { mood = 'calm'; just = 'exit'; above = 0; below = 0 }
    }
    if (closeCd > 0) closeCd = Math.max(0, closeCd - dt)
    const is85 = level >= 0.85
    let close = false
    if (is85 && !was85 && closeCd <= 0) { close = true; closeCd = 12 }
    was85 = is85
    res.level = level; res.beat = level < 0.15 ? Infinity : 1.3 - 0.95 * level; res.mood = mood; res.just = just; res.close = close
    return res
  }
  return { tick }
}

// a long varied script: hunts at every distance, gazes, arcs, low hp, null threats, ragged frame times
function script(frames, seed = 7) {
  let s = seed >>> 0
  const r = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296 }
  const out = []
  let th = calm, hp = 100
  for (let i = 0; i < frames; i++) {
    if (i % 40 === 0) {
      const k = r()
      th = k < 0.3 ? hunted(r() * 14) : k < 0.4 ? { ...calm, gaze: true } : k < 0.48 ? { ...calm, arcPending: true } : k < 0.55 ? null : calm
      hp = r() < 0.15 ? 10 + r() * 20 : 100
    }
    out.push([0.004 + r() * 0.06, th, hp])
  }
  return out
}

describe('dread: the fourth argument', () => {
  const same = (a, b) => ['level', 'beat', 'mood', 'just', 'close'].every((k) => Object.is(a[k], b[k]))

  it('exposes the cap and the gain: above the heartbeat floor, below the hunt line', () => {
    expect(DREAD_CAP).toBe(0.35)
    expect(DREAD_K).toBe(0.6)
    expect(DREAD_CAP).toBeLessThan(TENSION_ENTER)
    expect(heartbeatPeriod(DREAD_CAP)).toBeLessThan(Infinity)
    expect(heartbeatPeriod(0.15)).toBeLessThan(Infinity)
  })

  it('dread 0, or no fourth argument, gives the pre-dread sequence number for number, and huntLevel is the level', () => {
    const frames = script(6000)
    const ref = legacyTension(), three = createTension(), four = createTension()
    let enters = 0, closes = 0
    for (const [dt, th, hp] of frames) {
      const a = ref.tick(dt, th, hp)
      const b = three.tick(dt, th, hp)
      expect(same(a, b)).toBe(true)
      expect(Object.is(b.huntLevel, b.level)).toBe(true)
      const c = four.tick(dt, th, hp, 0)
      expect(same(a, c)).toBe(true)
      expect(Object.is(c.huntLevel, c.level)).toBe(true)
      if (a.just === 'enter') enters++
      if (a.close) closes++
    }
    expect(enters).toBeGreaterThan(0)                  // the script really ran the hunt's own transitions
    expect(closes).toBeGreaterThan(0)
  })

  it('raises the target to dread x DREAD_K, capped at DREAD_CAP', () => {
    expect(run4(createTension(), 4, calm, 100, 0.5).level).toBeCloseTo(0.3, 9)
    expect(run4(createTension(), 4, calm, 100, 1).level).toBe(DREAD_CAP)
    const r = run4(createTension(), 4, calm, 100, 0.25)
    expect(r.level).toBeCloseTo(0.15, 9)
    expect(r.beat).toBeLessThan(Infinity)               // a slow heartbeat before anything hunts you
  })

  it('never lifts a target that is already higher', () => {
    const a = run(createTension(), 3, hunted(0))
    const b = run4(createTension(), 3, hunted(0), 100, 1)
    expect(b.level).toBe(a.level)
    expect(run4(createTension(), 2, { ...calm, arcPending: true }, 100, 1).level).toBeCloseTo(0.8, 6)
  })

  it('dread alone never enters the hunt mood and never says it is close', () => {
    const t = createTension()
    let r
    for (let i = 0; i < 1200; i++) {
      r = t.tick(0.05, calm, 100, 1)
      expect(r.just).toBeNull()
      expect(r.close).toBe(false)
    }
    expect(r.mood).toBe('calm')
    expect(r.level).toBe(DREAD_CAP)
  })

  it('huntLevel ignores dread: zero under dread alone, the dread-free level under a hunt', () => {
    const t = createTension()
    const r = run4(t, 5, calm, 100, 1)
    expect(r.level).toBe(DREAD_CAP)
    expect(r.huntLevel).toBe(0)
    // the same hunt with and without dread: huntLevel tracks the dread-free run frame by frame
    const plain = createTension(), dread = createTension()
    for (const [dt, th, hp] of script(3000, 11)) {
      const a = plain.tick(dt, th, hp)
      const b = dread.tick(dt, th, hp, 0.9)
      expect(Object.is(b.huntLevel, a.level)).toBe(true)
      expect(b.level).toBeGreaterThanOrEqual(b.huntLevel)
    }
  })

  it('dread never holds the hunt mood up: once the hunt lets go the mood exits on the frame it would with no dread (review W3)', () => {
    // a creature that has lost you searches beside you (dread over 0.42 puts dread x DREAD_K above TENSION_EXIT): the hunt's own level
    // decides the exit, so the music and the presence let go on time
    const exitAt = (dread) => {
      const t = createTension()
      run(t, 5, hunted(4))
      expect(t.tick(0.05, hunted(4), 100).mood).toBe('hunt')
      for (let i = 1; i <= 1200; i++) if (t.tick(0.05, calm, 100, dread).just === 'exit') return i
      return null
    }
    const plain = exitAt(0)
    expect(plain).not.toBeNull()
    expect(plain * 0.05).toBeLessThan(15)
    for (const d of [0.42, 0.6, 1]) expect(exitAt(d), String(d)).toBe(plain)
  })

  it('as dread lifts the level falls back at the decay rate, and reset() clears huntLevel', () => {
    const t = createTension()
    run4(t, 4, calm, 100, 1)
    const r = run4(t, 1, calm, 100, 0)
    expect(r.level).toBeCloseTo(DREAD_CAP - 0.12, 6)
    t.reset()
    expect(t.tick(0.05, calm, 100, 0)).toEqual({ level: 0, beat: Infinity, mood: 'calm', just: null, close: false, huntLevel: 0 })
  })
})

function run4(t, seconds, threat, hp, dread, dt = 0.05) {
  let out = null
  const n = Math.round(seconds / dt)
  for (let i = 0; i < n; i++) out = t.tick(dt, threat, hp, dread)
  return out
}
