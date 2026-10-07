import { describe, it, expect } from 'vitest'
import { VARIANT_SPEC, VARIANT_PHASES, specFor, watched, litAt, stepVariant, sightRange, CRAWLER_DMG, TESLA_ARC_DMG } from '../src/renderer/variants.js'
import { inViewCone } from '../src/renderer/raycaster.js'
import { HF } from '../src/renderer/gfx-frame.js'
import { FIG } from '../src/renderer/gfx-sprites.js'

const DT = 1 / 60

function mulberry32(seed) {
  let s = seed >>> 0
  return () => { s += 0x6D2B79F5; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = t + Math.imul(t ^ (t >>> 7), 61 | t) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}
// a point at camera depth fwd and lateral offset lat (inverse of the cull's rotation)
const place = (px, py, pa, fwd, lat) => [px + fwd * Math.cos(pa) - lat * Math.sin(pa), py + fwd * Math.sin(pa) + lat * Math.cos(pa)]

// hunt.js's helpers, stubbed: straight-line moves by speed * dt (dt set per frame), LOS and blocked as switches, events recorded
function mkHelpers() {
  const H = {
    dt: DT, losOk: true, blocked: false, events: [],
    moveToward(e, x, y, speed) {
      const dx = x - e.x, dy = y - e.y, d = Math.hypot(dx, dy)
      e.dir = Math.atan2(dy, dx)
      if (H.blocked) return true
      if (d > 1e-9) { const s = Math.min(d, speed * H.dt) / d; e.x += dx * s; e.y += dy * s }
      return false
    },
    moveAway(e, x, y, speed) {
      const dx = e.x - x, dy = e.y - y, d = Math.hypot(dx, dy)
      e.dir = Math.atan2(dy, dx)
      if (H.blocked) return true
      if (d > 1e-9) { e.x += dx / d * speed * H.dt; e.y += dy / d * speed * H.dt }
      return false
    },
    los: () => H.losOk,
    dist: (e, x, y) => Math.hypot(e.x - x, e.y - y),
    hashT: () => 0.5,
    event: (kind, e, extra) => { H.events.push({ kind, id: e.id, extra }) },
  }
  return H
}
function mkThreat() { return { hunted: false, nearest: Infinity, nearestEntity: null, gaze: false, gazeRate: 0, dmg: 0, dmgKind: null, arcPending: false } }
function resetThreat(t) { t.gaze = false; t.gazeRate = 0; t.dmg = 0; t.dmgKind = null; t.arcPending = false }
function mkCtx(player, over = {}) {
  return { flashlight: true, sprinting: false, dark: false, fog: 14, radioOn: false, lures: [], t: 0, hf: HF, playerAngle: player.angle, player, damage: 14, ...over }
}
function mkEnt(variant, x, y, ai = 'hunt') {
  return { id: 1, x, y, type: 'stalker', variant, ai, state: 'idle', dir: 0, dirTimer: 2, stagger: 0, wardHits: 0, pending: 0, chunkCx: 0, chunkCy: 0 }
}
// run n frames; the threat is reset each frame the way hunt.js does before stepping
function run(e, ctx, H, th, seconds, each) {
  const n = Math.round(seconds / DT)
  for (let i = 0; i < n; i++) { resetThreat(th); H.dt = DT; stepVariant(e, DT, ctx, H, th); if (each) each(i) }
}
const kinds = (H) => H.events.map(ev => ev.kind)

describe('VARIANT_SPEC', () => {
  it('every FIG variant except thin has a spec; specFor falls back to shade', () => {
    for (const v of Object.keys(FIG)) { if (v === 'thin') continue; expect(VARIANT_SPEC[v], v).toBeDefined() }
    expect(VARIANT_SPEC.thin).toBeUndefined()
    expect(specFor('nonsense')).toBe(VARIANT_SPEC.shade)
    expect(specFor(undefined)).toBe(VARIANT_SPEC.shade)
    expect(specFor('hound')).toBe(VARIANT_SPEC.hound)
  })

  it('every spec has the full shape', () => {
    for (const [v, s] of Object.entries(VARIANT_SPEC)) {
      for (const k of ['roam', 'hunt', 'sight', 'hearK', 'loseTrack', 'dispelAt', 'staggerT', 'wardMul']) expect(typeof s[k], `${v}.${k}`).toBe('number')
      expect(s.hostilePhases instanceof Set, v).toBe(true)
      expect(s.step === null || typeof s.step === 'function', v).toBe(true)
    }
    expect(VARIANT_SPEC.shade.step).toBe(null)
    expect(VARIANT_SPEC.shade).toMatchObject({ roam: 0.5, hunt: 3.3, sight: 12, hearK: 1, loseTrack: 3.5, dispelAt: 3, staggerT: 2.6, wardMul: 1 })
  })

  it('every hunt speed except tesla and the hound stalk is faster than a walk and slower than a sprint', () => {
    for (const [v, s] of Object.entries(VARIANT_SPEC)) {
      if (v === 'tesla' || v === 'hound') continue
      expect(s.hunt, v).toBeGreaterThan(3.0)
      expect(s.hunt, v).toBeLessThan(5.4)
    }
    expect(VARIANT_SPEC.tesla.hunt).toBe(1.1)
    expect(VARIANT_SPEC.hound.hunt).toBe(2.0)
  })

  it('every hostilePhases entry is in VARIANT_PHASES; the watcher is never hostile', () => {
    for (const [v, s] of Object.entries(VARIANT_SPEC)) for (const ph of s.hostilePhases) expect(VARIANT_PHASES, `${v}:${ph}`).toContain(ph)
    expect(VARIANT_SPEC.watcher.hostilePhases.size).toBe(0)
    expect([...VARIANT_SPEC.smiler.hostilePhases].sort()).toEqual(['freeze', 'hunt'])
    expect([...VARIANT_SPEC.hound.hostilePhases].sort()).toEqual(['hunt', 'lunge'])
    expect([...VARIANT_SPEC.crawler.hostilePhases]).toEqual(['lunge'])
    expect([...VARIANT_SPEC.tesla.hostilePhases].sort()).toEqual(['arcCharge', 'hunt'])
    for (const ph of ['roam', 'alert', 'investigate', 'hunt', 'search', 'stagger', 'turning', 'freeze', 'windup', 'lunge', 'recover', 'retreat', 'shadow', 'still', 'arcCharge']) expect(VARIANT_PHASES).toContain(ph)
  })

  it('ships the fixed damages and the per-variant ward numbers', () => {
    expect(CRAWLER_DMG).toBe(10)
    expect(TESLA_ARC_DMG).toBe(8)
    expect(VARIANT_SPEC.hound).toMatchObject({ roam: 0.8, sight: 10, hearK: 1.6, loseTrack: 6, dispelAt: 2, staggerT: 2.0, wardMul: 2 })
    expect(VARIANT_SPEC.smiler).toMatchObject({ roam: 0.4, hunt: 3.6, sight: 13, dispelAt: 3, staggerT: 2.6 })
    expect(VARIANT_SPEC.lurker).toMatchObject({ roam: 0.3, hunt: 3.4, sight: 18, dispelAt: 3, staggerT: 2.6 })
    expect(VARIANT_SPEC.watcher).toMatchObject({ roam: 0.6, sight: 16, dispelAt: 1, staggerT: 1.5 })
    expect(VARIANT_SPEC.crawler).toMatchObject({ roam: 0, hearK: 0.5, sight: 3, dispelAt: 2, staggerT: 2.0 })
    expect(VARIANT_SPEC.tesla).toMatchObject({ roam: 0.5, hunt: 1.1, sight: 11, hearK: 1, dispelAt: 2, staggerT: 1.3 })
  })
})

describe('watched()', () => {
  const player = { x: 3, y: -2, angle: 0.7 }
  const lim = (fwd) => fwd * Math.tan(HF + 0.1)
  it('is the sprite cull: lateral edge at fwd*tan(hf+0.1)+0.8, depth from 0.35', () => {
    let [x, y] = place(player.x, player.y, player.angle, 5, lim(5) + 0.79)
    expect(watched({ x, y }, player, HF, 14, true)).toBe(true);
    [x, y] = place(player.x, player.y, player.angle, 5, lim(5) + 0.81)
    expect(watched({ x, y }, player, HF, 14, true)).toBe(false);
    [x, y] = place(player.x, player.y, player.angle, 0.3, 0)
    expect(watched({ x, y }, player, HF, 14, true)).toBe(false);
    [x, y] = place(player.x, player.y, player.angle, 13.9, 0)
    expect(watched({ x, y }, player, HF, 14, true)).toBe(true);
    [x, y] = place(player.x, player.y, player.angle, 14.1, 0)
    expect(watched({ x, y }, player, HF, 14, true)).toBe(false)
  })
  it('needs line of sight too', () => {
    const [x, y] = place(player.x, player.y, player.angle, 5, 0)
    expect(watched({ x, y }, player, HF, 14, false)).toBe(false)
    expect(watched({ x, y }, player, HF, 14, true)).toBe(true)
  })
  it('matches inViewCone && los for 50 random placements', () => {
    const rnd = mulberry32(3)
    let seen = 0
    for (let i = 0; i < 50; i++) {
      const p = { x: rnd() * 20 - 10, y: rnd() * 20 - 10, angle: rnd() * Math.PI * 2 }
      const e = { x: p.x + rnd() * 30 - 15, y: p.y + rnd() * 30 - 15 }
      const fog = 8 + rnd() * 8, los = rnd() < 0.7
      const w = watched(e, p, HF, fog, los)
      expect(w).toBe(inViewCone(p.x, p.y, p.angle, e.x, e.y, HF, fog) && los)
      if (w) seen++
    }
    expect(seen).toBeGreaterThan(3)
  })
})

describe('litAt()', () => {
  const player = { x: 0, y: 0, angle: 0 }
  it('is lit by the flashlight when watched within 9, and always on a lit floor', () => {
    expect(litAt({ x: 5, y: 0 }, mkCtx(player, { dark: true, flashlight: true }), true)).toBe(true)
    expect(litAt({ x: 9.5, y: 0 }, mkCtx(player, { dark: true, flashlight: true }), true)).toBe(false)
    expect(litAt({ x: 5, y: 0 }, mkCtx(player, { dark: true, flashlight: true }), false)).toBe(false)
    expect(litAt({ x: 5, y: 0 }, mkCtx(player, { dark: true, flashlight: false }), true)).toBe(false)
    expect(litAt({ x: 5, y: 0 }, mkCtx(player, { dark: false, flashlight: false }), false)).toBe(true)
  })
})

describe('stepVariant()', () => {
  it('leaves shade, staggered, turning and pending creatures to hunt.js', () => {
    const player = { x: 0, y: 0, angle: 0 }
    const ctx = mkCtx(player), H = mkHelpers(), th = mkThreat()
    const shade = mkEnt('shade', 5, 0)
    expect(stepVariant(shade, DT, ctx, H, th)).toBe(false)
    expect(shade.x).toBe(5)
    const smiler = mkEnt('smiler', 5, 0); smiler.stagger = 1
    expect(stepVariant(smiler, DT, ctx, H, th)).toBe(false)
    expect(smiler.ai).toBe('hunt')
    const turning = mkEnt('smiler', 5, 0, 'turning')
    expect(stepVariant(turning, DT, ctx, H, th)).toBe(false)
    const pending = mkEnt('crawler', 5, 0, 'roam'); pending.pending = 0.5
    expect(stepVariant(pending, DT, ctx, H, th)).toBe(false)
    expect(pending.ai).toBe('roam')
    expect(th.dmg).toBe(0)
  })

  it('steps an injected entity missing every variant field', () => {
    const player = { x: 0, y: 0, angle: 0 }
    const ctx = mkCtx(player), H = mkHelpers(), th = mkThreat()
    const e = { x: 5, y: 0, variant: 'hound', type: 'stalker', ai: 'hunt', dir: 0 }
    expect(() => stepVariant(e, DT, ctx, H, th)).not.toThrow()
    expect(e.ai).toBe('windup')
  })
})

describe('smiler', () => {
  it('freezes while watched (speed 0, gaze 1.5) and moves at 3.6 the moment you look away', () => {
    const player = { x: 0, y: 0, angle: 0 }
    const ctx = mkCtx(player), H = mkHelpers(), th = mkThreat()
    const e = mkEnt('smiler', 5, 0)
    expect(stepVariant(e, DT, ctx, H, th)).toBe(true)
    expect(e.ai).toBe('freeze')
    expect(e.x).toBe(5); expect(e.y).toBe(0)
    expect(th.gaze).toBe(true)
    expect(th.gazeRate).toBe(1.5)
    run(e, ctx, H, th, 1.0)
    expect(e.ai).toBe('freeze'); expect(e.x).toBe(5)
    expect(th.gaze).toBe(true)
    player.angle = Math.PI                      // turned 180 degrees: not on screen
    resetThreat(th)
    expect(stepVariant(e, DT, ctx, H, th)).toBe(true)
    expect(e.ai).toBe('hunt')
    expect(5 - e.x).toBeGreaterThanOrEqual(3.6 * DT - 1e-9)
    expect(th.gaze).toBe(false)
    // in hunt and unwatched the base machine owns it
    resetThreat(th)
    expect(stepVariant(e, DT, ctx, H, th)).toBe(false)
    expect(e.ai).toBe('hunt')
  })

  it('announces its first freeze within 6 u once per hunt', () => {
    const player = { x: 0, y: 0, angle: 0 }
    const ctx = mkCtx(player), H = mkHelpers(), th = mkThreat()
    const e = mkEnt('smiler', 10, 0)
    stepVariant(e, DT, ctx, H, th)
    expect(e.ai).toBe('freeze')
    expect(kinds(H)).toEqual([])                // 10 u: too far to read the rule
    e.x = 5
    player.angle = Math.PI; stepVariant(e, DT, ctx, H, th)
    player.angle = 0; stepVariant(e, DT, ctx, H, th)
    expect(kinds(H)).toEqual(['smiler-freeze'])
    player.angle = Math.PI; stepVariant(e, DT, ctx, H, th)
    player.angle = 0; stepVariant(e, DT, ctx, H, th)
    expect(kinds(H)).toEqual(['smiler-freeze'])  // once per hunt
    e.ai = 'search'; stepVariant(e, DT, ctx, H, th)   // the hunt ended
    e.ai = 'hunt'; stepVariant(e, DT, ctx, H, th)
    expect(kinds(H)).toEqual(['smiler-freeze', 'smiler-freeze'])
  })

  it('is hostile while frozen and only while on screen within 6 u does it freeze at all', () => {
    expect(VARIANT_SPEC.smiler.hostilePhases.has('freeze')).toBe(true)
    const player = { x: 0, y: 0, angle: 0 }
    const ctx = mkCtx(player), H = mkHelpers(), th = mkThreat()
    H.losOk = false                             // a wall between: drawn nowhere, so it keeps coming
    const e = mkEnt('smiler', 5, 0)
    expect(stepVariant(e, DT, ctx, H, th)).toBe(false)
    expect(e.ai).toBe('hunt')
  })
})

describe('hound', () => {
  function windupHound(x = 5) {
    const player = { x: 0, y: 0, angle: 0 }
    const ctx = mkCtx(player), H = mkHelpers(), th = mkThreat()
    const e = mkEnt('hound', x, 0)
    expect(stepVariant(e, DT, ctx, H, th)).toBe(true)
    return { player, ctx, H, th, e }
  }

  it('winds up for 0.55 s with the dir locked at the start, then lunges along it', () => {
    const { player, ctx, H, th, e } = windupHound()
    expect(e.ai).toBe('windup')
    expect(kinds(H)).toEqual(['hound-windup'])
    expect(e.dir).toBeCloseTo(Math.PI, 9)
    player.x = 0; player.y = 3                  // strafing during the windup
    run(e, ctx, H, th, 0.3)
    expect(e.ai).toBe('windup')
    expect(e.dir).toBeCloseTo(Math.PI, 9)
    expect(e.x).toBe(5); expect(e.y).toBe(0)
    run(e, ctx, H, th, 0.3)
    expect(e.ai).toBe('lunge')
    run(e, ctx, H, th, 0.2)
    expect(e.dir).toBeCloseTo(Math.PI, 9)       // along the locked dir, not toward where you strafed
    expect(e.y).toBeCloseTo(0, 6)
    expect(e.x).toBeLessThan(5 - 6.5 * 0.15)
  })

  it('a blocked lunge ends in recover, then hunt after 1.1 s', () => {
    const { player, ctx, H, th, e } = windupHound()
    run(e, ctx, H, th, 0.56)
    expect(e.ai).toBe('lunge')
    H.blocked = true
    run(e, ctx, H, th, DT)
    expect(e.ai).toBe('recover')
    expect(kinds(H)).toEqual(['hound-windup'])
    H.blocked = false
    run(e, ctx, H, th, 1.0)
    expect(e.ai).toBe('recover')
    const x0 = e.x
    player.x = -10                              // you got well clear: no second windup to muddy the hand-back
    run(e, ctx, H, th, 0.15)
    expect(e.ai).toBe('hunt')
    expect(x0 - e.x).toBeGreaterThan(0.02)      // the recover's last 0.1 s drifts on at 0.3
    expect(x0 - e.x).toBeLessThan(0.05)
    expect(stepVariant(e, DT, ctx, H, th)).toBe(false)   // d > 7: the stalk is the base machine's
  })

  it('skids past: the lunge ends with hound-pass once it crosses where you stood at the windup', () => {
    const { player, ctx, H, th, e } = windupHound(3)
    player.x = 0; player.y = 3                  // you stepped aside
    run(e, ctx, H, th, 0.56)
    let passed = false
    run(e, ctx, H, th, 0.6, () => { if (e.ai === 'recover') passed = true })
    expect(passed).toBe(true)
    expect(kinds(H)).toEqual(['hound-windup', 'hound-pass'])
    expect(e.x).toBeLessThan(-0.3)
    expect(e.x).toBeGreaterThan(-0.3 - 6.5 * DT - 1e-9)   // it stopped the frame it crossed
    expect(th.dmg).toBe(0)
  })

  it('a lunge hit deals damage * 1.25 as kind lunge', () => {
    const { ctx, H, th, e } = windupHound(3)
    let hit = null
    run(e, ctx, H, th, 1.2, () => { if (th.dmg > 0 && !hit) hit = { dmg: th.dmg, kind: th.dmgKind, ai: e.ai } })
    expect(hit).toEqual({ dmg: 14 * 1.25, kind: 'lunge', ai: 'lunge' })
  })

  it('a lunge covers 3.9 u: from 5 u it falls short, recovers (your window), and takes you on the second burst', () => {
    const { ctx, H, th, e } = windupHound()
    const seen = []
    let hitT = -1
    run(e, ctx, H, th, 3.5, (i) => { if (seen[seen.length - 1] !== e.ai) seen.push(e.ai); if (th.dmg > 0 && hitT < 0) hitT = i * DT })
    expect(seen.slice(0, 6)).toEqual(['windup', 'lunge', 'recover', 'hunt', 'windup', 'lunge'])
    expect(hitT).toBeGreaterThan(0.55 + 0.6 + 1.1)
    expect(hitT).toBeLessThan(3.0)
  })

  it('does not wind up without line of sight or beyond 7 u', () => {
    const player = { x: 0, y: 0, angle: 0 }
    const ctx = mkCtx(player), H = mkHelpers(), th = mkThreat()
    const far = mkEnt('hound', 7.5, 0)
    expect(stepVariant(far, DT, ctx, H, th)).toBe(false)
    expect(far.ai).toBe('hunt')
    H.losOk = false
    const walled = mkEnt('hound', 5, 0)
    expect(stepVariant(walled, DT, ctx, H, th)).toBe(false)
    expect(walled.ai).toBe('hunt')
  })
})

describe('lurker', () => {
  it('stops while lit by the beam, retreats after 1.2 s of it, then searches', () => {
    const player = { x: 0, y: 0, angle: 0 }
    const ctx = mkCtx(player, { dark: true, flashlight: true }), H = mkHelpers(), th = mkThreat()
    const e = mkEnt('lurker', 5, 0)
    expect(stepVariant(e, DT, ctx, H, th)).toBe(true)
    expect(e.ai).toBe('freeze')
    expect(kinds(H)).toEqual(['lurker-hunt'])
    run(e, ctx, H, th, 1.0)
    expect(e.x).toBe(5); expect(e.y).toBe(0)
    expect(e.ai).toBe('freeze')
    run(e, ctx, H, th, 0.25)
    expect(e.ai).toBe('retreat')               // hunt.deriveState: retreat -> 'flee'
    expect(VARIANT_PHASES).toContain('retreat')
    run(e, ctx, H, th, 1.0)
    expect(e.x).toBeGreaterThan(6.5)
    run(e, ctx, H, th, 2.1)
    expect(e.ai).toBe('search')
  })

  it('moves at 3.4 when the beam is off it, and the lit clock is continuous', () => {
    const player = { x: 0, y: 0, angle: 0 }
    const ctx = mkCtx(player, { dark: true, flashlight: true }), H = mkHelpers(), th = mkThreat()
    const e = mkEnt('lurker', 5, 0)
    run(e, ctx, H, th, 1.0)
    expect(e.ai).toBe('freeze')
    ctx.flashlight = false
    expect(stepVariant(e, DT, ctx, H, th)).toBe(true)
    expect(e.ai).toBe('hunt')
    expect(5 - e.x).toBeGreaterThanOrEqual(3.4 * DT - 1e-9)
    expect(stepVariant(e, DT, ctx, H, th)).toBe(false)   // the base machine hunts from here
    ctx.flashlight = true
    run(e, ctx, H, th, 1.0)
    expect(e.ai).toBe('freeze')                 // the earlier 1.0 s did not carry over
  })

  it('a lit floor counts as lit even with the flashlight off and your back turned', () => {
    const player = { x: 0, y: 0, angle: Math.PI }
    const ctx = mkCtx(player, { dark: false, flashlight: false }), H = mkHelpers(), th = mkThreat()
    const e = mkEnt('lurker', 5, 0)
    run(e, ctx, H, th, 1.0)
    expect(e.ai).toBe('freeze'); expect(e.x).toBe(5)
    run(e, ctx, H, th, 0.3)
    expect(e.ai).toBe('retreat')
  })

  it('is hostile only in hunt', () => {
    expect([...VARIANT_SPEC.lurker.hostilePhases]).toEqual(['hunt'])
  })
})

describe('watcher', () => {
  it('never sets damage, even at contact range', () => {
    const player = { x: 0, y: 0, angle: 0 }
    const ctx = mkCtx(player), H = mkHelpers(), th = mkThreat()
    const e = mkEnt('watcher', 0.3, 0, 'roam'); e.type = 'wanderer'
    run(e, ctx, H, th, 1.0, () => expect(th.dmg).toBe(0))
    expect(VARIANT_SPEC.watcher.hostilePhases.size).toBe(0)
  })

  it('shadows you: holds a distance in [6, 9] after 10 s with you standing still', () => {
    for (const start of [14, 5.5, 7.5]) {
      const player = { x: 0, y: 0, angle: 0 }
      const ctx = mkCtx(player), H = mkHelpers(), th = mkThreat()
      const e = mkEnt('watcher', start, 0, 'roam'); e.type = 'wanderer'
      expect(stepVariant(e, DT, ctx, H, th)).toBe(true)
      expect(e.ai).toBe('shadow')
      run(e, ctx, H, th, 10)
      const d = Math.hypot(e.x, e.y)
      expect(d, `from ${start}`).toBeGreaterThanOrEqual(6 - 1e-6)
      expect(d, `from ${start}`).toBeLessThanOrEqual(9 + 1e-6)
      expect(e.ai).toBe('shadow')
      expect(e.dir).toBeCloseTo(Math.PI, 6)    // faces the camera
    }
  })

  it('flees under 4.5 and returns to shadowing at 6', () => {
    const player = { x: 0, y: 0, angle: 0 }
    const ctx = mkCtx(player), H = mkHelpers(), th = mkThreat()
    const e = mkEnt('watcher', 4, 0, 'shadow'); e.type = 'wanderer'
    stepVariant(e, DT, ctx, H, th)
    expect(e.ai).toBe('retreat')
    run(e, ctx, H, th, 3)
    expect(e.ai).toBe('shadow')
    expect(Math.hypot(e.x, e.y)).toBeGreaterThanOrEqual(6 - 1e-6)
  })

  it('costs you only while you watch it back, within 12', () => {
    const player = { x: 0, y: 0, angle: 0 }
    const ctx = mkCtx(player), H = mkHelpers(), th = mkThreat()
    const e = mkEnt('watcher', 8, 0, 'shadow'); e.type = 'wanderer'
    run(e, ctx, H, th, DT)
    expect(th.gaze).toBe(true); expect(th.gazeRate).toBe(3)
    player.angle = Math.PI
    run(e, ctx, H, th, DT)
    expect(th.gaze).toBe(false); expect(th.gazeRate).toBe(0)
    player.angle = 0; e.x = 13
    run(e, ctx, H, th, DT)
    expect(th.gaze).toBe(false)
    H.losOk = false; e.x = 8
    run(e, ctx, H, th, DT)
    expect(th.gaze).toBe(false)
  })

  it('goes back to roaming when it has not seen you for a while; dispels on one ward and names the event', () => {
    const player = { x: 0, y: 0, angle: 0 }
    const ctx = mkCtx(player), H = mkHelpers(), th = mkThreat()
    const e = mkEnt('watcher', 8, 0, 'shadow'); e.type = 'wanderer'
    H.losOk = false
    run(e, ctx, H, th, 3.0)
    expect(e.ai).toBe('shadow')
    run(e, ctx, H, th, 0.7)
    expect(e.ai).toBe('roam')
    expect(VARIANT_SPEC.watcher.dispelAt).toBe(1)
    expect(VARIANT_SPEC.watcher.dispelEvent).toBe('watcher-dispelled')
    for (const v of ['shade', 'smiler', 'hound', 'lurker', 'crawler', 'tesla']) expect(VARIANT_SPEC[v].dispelEvent).toBe(null)
  })
})

describe('crawler', () => {
  const mk = (d, over) => {
    const player = { x: 0, y: 0, angle: 0 }
    const ctx = mkCtx(player, { dark: true, flashlight: true, ...over }), H = mkHelpers(), th = mkThreat()
    const e = mkEnt('crawler', d, 0, 'roam'); e.type = 'wanderer'
    return { player, ctx, H, th, e }
  }

  it('lies still whatever the base machine decided, and stays still at d >= 3', () => {
    const { ctx, H, th, e } = mk(3.0, { flashlight: false })
    for (const ai of ['roam', 'alert', 'investigate', 'hunt', 'search']) {
      e.ai = ai
      expect(stepVariant(e, DT, ctx, H, th)).toBe(true)
      expect(e.ai).toBe('still')
    }
    run(e, ctx, H, th, 2)
    expect(e.ai).toBe('still'); expect(e.x).toBe(3)
    expect(VARIANT_SPEC.crawler.roam).toBe(0)
  })

  it('stays still under the beam when it is on screen', () => {
    const { ctx, H, th, e } = mk(2.5)
    run(e, ctx, H, th, 2)
    expect(e.ai).toBe('still'); expect(e.x).toBe(2.5)
  })

  it('takes your ankles when the beam leaves it: lunge, dmg 10, the crawler event, then a 4 s retreat', () => {
    const { player, ctx, H, th, e } = mk(2.5)
    player.angle = Math.PI                      // flashlight on, facing away
    stepVariant(e, DT, ctx, H, th)
    expect(e.ai).toBe('lunge')
    let hit = null, retreatT = 0, x0 = 0
    run(e, ctx, H, th, 1.0, () => {
      if (th.dmg > 0 && !hit) { hit = { dmg: th.dmg, kind: th.dmgKind }; x0 = e.x }
      if (e.ai === 'retreat') retreatT += DT
    })
    expect(hit).toEqual({ dmg: 10, kind: 'contact' })
    expect(kinds(H)).toEqual(['crawler'])
    expect(e.ai).toBe('retreat')
    run(e, ctx, H, th, 5, () => { if (e.ai === 'retreat') retreatT += DT })
    expect(retreatT).toBeGreaterThan(3.95); expect(retreatT).toBeLessThan(4.05)
    expect(e.x).toBeGreaterThan(x0 + 1.6 * 3.9)
    expect(e.ai).toBe('still')
  })

  it('lunges in the dark with the flashlight off, and a missed lunge lasts 1.0 s', () => {
    const { ctx, H, th, e } = mk(2.5, { flashlight: false })
    H.blocked = true                            // it cannot reach you
    stepVariant(e, DT, ctx, H, th)
    expect(e.ai).toBe('lunge')
    run(e, ctx, H, th, 0.95)
    expect(e.ai).toBe('lunge')
    run(e, ctx, H, th, 0.1)
    expect(e.ai).toBe('retreat')
    expect(th.dmg).toBe(0)
    expect(kinds(H)).toEqual([])
  })

  it('is hostile only in lunge', () => {
    expect([...VARIANT_SPEC.crawler.hostilePhases]).toEqual(['lunge'])
  })
})

describe('tesla', () => {
  it('charges for 0.5 s with the arc pending, then jolts for 8 as kind arc', () => {
    const player = { x: 0, y: 0, angle: 0 }
    const ctx = mkCtx(player, { dark: true }), H = mkHelpers(), th = mkThreat()
    const e = mkEnt('tesla', 3, 0)
    expect(stepVariant(e, DT, ctx, H, th)).toBe(true)
    expect(e.ai).toBe('arcCharge'); expect(th.arcPending).toBe(true)
    let pendingFrames = 0, jolt = null
    run(e, ctx, H, th, 0.6, () => { if (th.arcPending) pendingFrames++; if (th.dmg > 0 && !jolt) jolt = { dmg: th.dmg, kind: th.dmgKind, pending: th.arcPending, x: e.x } })
    expect(pendingFrames).toBeGreaterThanOrEqual(28)
    expect(pendingFrames).toBeLessThanOrEqual(31)
    expect(jolt).toEqual({ dmg: 8, kind: 'arc', pending: false, x: 3 })   // it did not move during the charge
    expect(kinds(H)).toEqual(['arc'])
    expect(e.ai).toBe('hunt')
    expect(e.x).toBeLessThan(3)                  // then it comes on, at the turret's 1.1
    // the cooldown: 1.4 s before it can charge again
    run(e, ctx, H, th, 1.3)
    expect(kinds(H)).toEqual(['arc'])
    run(e, ctx, H, th, 0.7)
    expect(kinds(H)).toEqual(['arc', 'arc'])
  })

  it('a wall between you at 0.3 s cancels it', () => {
    const player = { x: 0, y: 0, angle: 0 }
    const ctx = mkCtx(player, { dark: true }), H = mkHelpers(), th = mkThreat()
    const e = mkEnt('tesla', 3, 0)
    run(e, ctx, H, th, 0.3)
    expect(e.ai).toBe('arcCharge')
    H.losOk = false
    run(e, ctx, H, th, DT)
    expect(e.ai).toBe('hunt')
    expect(th.arcPending).toBe(false)
    run(e, ctx, H, th, 0.5)
    expect(th.dmg).toBe(0)
    expect(kinds(H)).toEqual([])
  })

  it('a dropped playing radio draws it instead of you', () => {
    const player = { x: 0, y: 0, angle: 0 }
    const ctx = mkCtx(player, { dark: true, lures: [{ x: 30, y: 0 }, { x: 20, y: 0 }] }), H = mkHelpers(), th = mkThreat()
    const e = mkEnt('tesla', 10, 0)
    expect(stepVariant(e, DT, ctx, H, th)).toBe(true)
    expect(e.x).toBeGreaterThan(10)
    expect(e.dir).toBeCloseTo(0, 9)             // toward the nearer lure at 20
    run(e, ctx, H, th, 1.0)
    expect(e.x).toBeCloseTo(10 + 1.1 * (1 + DT), 3)
  })

  it('a carried playing radio widens its sight to 16.5 and it still comes for you', () => {
    const player = { x: 0, y: 0, angle: 0 }
    const ctx = mkCtx(player, { dark: true, radioOn: true, lures: [] }), H = mkHelpers(), th = mkThreat()
    const e = mkEnt('tesla', 10, 0)
    expect(sightRange(VARIANT_SPEC.tesla, ctx)).toBeCloseTo(16.5, 9)
    expect(sightRange(VARIANT_SPEC.tesla, mkCtx(player, { radioOn: false }))).toBe(11)
    expect(sightRange(VARIANT_SPEC.smiler, ctx)).toBe(13)
    expect(stepVariant(e, DT, ctx, H, th)).toBe(true)
    expect(e.x).toBeLessThan(10)
    expect(e.dir).toBeCloseTo(Math.PI, 9)
  })

  it('without line of sight the base machine owns the hunt', () => {
    const player = { x: 0, y: 0, angle: 0 }
    const ctx = mkCtx(player, { dark: true }), H = mkHelpers(), th = mkThreat()
    H.losOk = false
    const e = mkEnt('tesla', 3, 0)
    expect(stepVariant(e, DT, ctx, H, th)).toBe(false)
    expect(e.ai).toBe('hunt'); expect(e.x).toBe(3)
  })
})

describe('allocation', () => {
  it('stepping every variant for 600 frames keeps the threat and entity identities and allocates no event objects itself', () => {
    const player = { x: 0, y: 0, angle: 0 }
    const ctx = mkCtx(player, { dark: true }), H = mkHelpers(), th = mkThreat()
    const ents = ['smiler', 'hound', 'lurker', 'watcher', 'crawler', 'tesla'].map((v, i) => { const e = mkEnt(v, 4 + i, 0.5 * i); e.id = i; return e })
    const keysBefore = ents.map(e => { stepVariant(e, DT, ctx, H, th); return Object.keys(e).length })
    for (let f = 0; f < 600; f++) {
      resetThreat(th)
      player.angle = (f % 120) < 60 ? 0 : Math.PI
      for (const e of ents) stepVariant(e, DT, ctx, H, th)
    }
    ents.forEach((e, i) => expect(Object.keys(e).length, e.variant).toBe(keysBefore[i]))   // fields are added once, on the first step
    for (const e of ents) expect(VARIANT_PHASES).toContain(e.ai)
  })
})
