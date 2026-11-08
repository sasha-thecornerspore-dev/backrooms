// look.js — vertical look's state: the pitch the renderer draws (player.pitch) and the input gathered since the last frame (player.pitchIn).
// 1:1 with the mouse and the drag (the yaw's rate), clamped to a third of the view each way, held where it is left (no drift), level at
// once with the pref off, eased back to exactly level while the view is held (lying down, a fall's or a death's veil), and allocation-free:
// the two fields are written in place and nothing else is touched.
import { describe, it, expect } from 'vitest'
import { lookInput, lookStep, lookLevel, PITCH_MAX, MOUSE_PITCH, TOUCH_PITCH, LEVEL_TAU, LEVEL_SNAP } from '../src/renderer/look.js'
import { lookYaw } from '../src/renderer/touch.js'

const fresh = () => ({ x: 1, y: 2, angle: 0.5, bobOffset: 0, pitch: 0, pitchIn: 0 })
const step = (p, o = {}) => lookStep(p, o.dt ?? 1 / 60, o.on ?? true, o.invert ?? false, o.held ?? false)

describe('lookInput / lookStep: the mouse and the drag', () => {
  it('the mouse pulled toward you (movementY > 0) looks down, at the yaw\'s rate; inverted it looks up', () => {
    const p = fresh()
    lookInput(p, 50, MOUSE_PITCH, 100)
    expect(p.pitch).toBe(0)                                   // gathered, not drawn until the loop's step
    expect(step(p)).toBeCloseTo(-0.1, 12)
    expect(p.pitch).toBeCloseTo(-0.1, 12); expect(p.pitchIn).toBe(0)
    const q = fresh()
    lookInput(q, 50, MOUSE_PITCH, 100)
    expect(step(q, { invert: true })).toBeCloseTo(0.1, 12)
    expect(MOUSE_PITCH).toBe(0.002)                            // the same 0.002 per px the yaw turns (game.js mousemove)
  })
  it('several events in one frame add up; the sensitivity scales them; a bogus sensitivity is 100%', () => {
    const p = fresh()
    for (let i = 0; i < 10; i++) lookInput(p, -3, MOUSE_PITCH, 200)
    expect(step(p)).toBeCloseTo(0.12, 12)
    for (const bad of [NaN, 0, -50, undefined, Infinity]) {
      const q = fresh(); lookInput(q, -10, MOUSE_PITCH, bad)
      expect(step(q), String(bad)).toBeCloseTo(0.02, 12)
    }
  })
  it('NaN, Infinity, 0 and undefined add nothing, and a NaN never reaches the frame', () => {
    const p = fresh()
    for (const dy of [NaN, Infinity, -Infinity, 0, undefined, null]) lookInput(p, dy, MOUSE_PITCH, 100)
    expect(p.pitchIn).toBe(0); expect(step(p)).toBe(0)
    p.pitchIn = NaN; expect(step(p)).toBe(0)
    p.pitch = NaN; expect(step(p)).toBe(0)
  })
  it('clamps to a third of the view each way and drops the excess: coming back from the clamp starts at once', () => {
    const p = fresh()
    expect(PITCH_MAX).toBeGreaterThan(0.28); expect(PITCH_MAX).toBeLessThanOrEqual(1 / 3 + 1e-9)
    lookInput(p, -10000, MOUSE_PITCH, 100)
    expect(step(p)).toBe(PITCH_MAX)
    lookInput(p, 10, MOUSE_PITCH, 100)                        // a little the other way: off the stop at once, no wind-up to unwind
    expect(step(p)).toBeCloseTo(PITCH_MAX - 0.02, 12)
    lookInput(p, 1e6, MOUSE_PITCH, 100)
    expect(step(p)).toBe(-PITCH_MAX)
  })
  it('no drift: with no input the pitch is held to the bit, frame after frame', () => {
    const p = fresh()
    lookInput(p, -37, MOUSE_PITCH, 135)
    const v = step(p)
    for (let i = 0; i < 20000; i++) step(p, { dt: (i % 7 + 1) / 240 })
    expect(Object.is(p.pitch, v)).toBe(true)
  })
  it('the touch drag tilts under its own yaw rate, so a sideways swipe barely tilts', () => {
    expect(TOUCH_PITCH).toBeLessThan(lookYaw(1, 100))
    const p = fresh()
    lookInput(p, 25, TOUCH_PITCH, 100)
    expect(step(p)).toBeCloseTo(-25 * TOUCH_PITCH, 12)
  })
})

describe('lookStep: off, held, levelled', () => {
  it('off (the pref): a level view at once, the input dropped; switched back on it starts level, nothing replays', () => {
    const p = fresh()
    lookInput(p, -60, MOUSE_PITCH, 100); step(p)
    expect(p.pitch).toBeGreaterThan(0)
    lookInput(p, -60, MOUSE_PITCH, 100)
    expect(step(p, { on: false })).toBe(0)
    expect(p.pitch).toBe(0); expect(p.pitchIn).toBe(0)
    for (let i = 0; i < 5; i++) { lookInput(p, -60, MOUSE_PITCH, 100); expect(step(p, { on: false })).toBe(0) }
    expect(step(p)).toBe(0)
  })
  it('held: the input is dropped and the view eases back to level, frame-rate independent, landing on exactly 0', () => {
    const at = (hz, secs) => {
      const p = fresh(); p.pitch = 0.3
      for (let i = 0; i < Math.round(secs * hz); i++) { lookInput(p, -40, MOUSE_PITCH, 100); step(p, { dt: 1 / hz, held: true }) }
      return p.pitch
    }
    expect(at(60, 0.5)).toBeCloseTo(0.3 * Math.exp(-0.5 / LEVEL_TAU), 9)
    expect(at(144, 0.5)).toBeCloseTo(at(60, 0.5), 9)            // the same ease at any refresh rate
    expect(at(30, 0.5)).toBeCloseTo(at(60, 0.5), 9)
    expect(at(60, 3)).toBe(0)                                    // snapped, not a residue
    expect(LEVEL_SNAP * 2160).toBeLessThan(0.5)                 // the snap is under half a row at any render size: no visible jump
    const p = fresh(); p.pitch = -0.2
    step(p, { held: true, dt: 0 })
    expect(p.pitch).toBe(-0.2)                                   // a zero step moves nothing
  })
  it('lookLevel: a level view at once, the input dropped (an arrival, a wake)', () => {
    const p = fresh(); p.pitch = 0.25; p.pitchIn = 0.1
    lookLevel(p)
    expect(p.pitch).toBe(0); expect(p.pitchIn).toBe(0)
    expect(step(p)).toBe(0)
  })
})

describe('allocation-free', () => {
  it('writes the two fields in place, returns a number, and never adds a key (the player keeps its shape)', () => {
    const p = fresh(), keys = Object.keys(p).join()
    for (let i = 0; i < 5000; i++) {
      lookInput(p, (i % 13) - 6, i % 2 ? MOUSE_PITCH : TOUCH_PITCH, 100 + (i % 50))
      const v = lookStep(p, 1 / 60, i % 997 !== 0, i % 3 === 0, i % 211 < 20)
      expect(typeof v).toBe('number')
      if (i % 500 === 0) lookLevel(p)
    }
    expect(Object.keys(p).join()).toBe(keys)
    expect([p.x, p.y, p.angle, p.bobOffset]).toEqual([1, 2, 0.5, 0])
  })
  it('a player without the fields gets just the two (the touch adapter can be handed a bare { angle })', () => {
    const p = { angle: 0 }
    lookInput(p, 10, TOUCH_PITCH, 100); lookStep(p, 1 / 60, true, false, false)
    expect(Object.keys(p).sort()).toEqual(['angle', 'pitch', 'pitchIn'])
  })
  it('the module allocates nothing in its functions (no literals, no constructors)', async () => {
    const fs = await import('node:fs')
    const src = fs.readFileSync(new URL('../src/renderer/look.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
    const code = src.split('\n').filter((l) => !l.trimStart().startsWith('//')).join('\n').replace(/\/\/.*$/gm, '')
    expect(code).not.toMatch(/\bnew\b|\[|=>\s*\{|\{\s*\w+\s*:/)
  })
})
