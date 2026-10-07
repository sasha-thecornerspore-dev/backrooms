import { describe, it, expect } from 'vitest'
import { stickToKeys, lookYaw, ACTIONS } from '../src/renderer/touch.js'

const R = 66

describe('stickToKeys', () => {
  it('deadzone: a tiny nudge moves nothing', () => {
    expect(stickToKeys(3, -3, R)).toEqual({ KeyW: false, KeyS: false, KeyA: false, KeyD: false, ShiftLeft: false })
  })
  it('pushing up = forward (W), no accidental strafe', () => {
    const k = stickToKeys(0, -40, R)
    expect(k.KeyW).toBe(true)
    expect(k.KeyS).toBe(false); expect(k.KeyA).toBe(false); expect(k.KeyD).toBe(false)
  })
  it('down = back (S), left = A, right = D', () => {
    expect(stickToKeys(0, 40, R).KeyS).toBe(true)
    expect(stickToKeys(-40, 0, R).KeyA).toBe(true)
    expect(stickToKeys(40, 0, R).KeyD).toBe(true)
  })
  it('forward-right diagonal engages both W and D', () => {
    const k = stickToKeys(30, -30, R)
    expect(k.KeyW).toBe(true); expect(k.KeyD).toBe(true)
    expect(k.KeyS).toBe(false); expect(k.KeyA).toBe(false)
  })
  it('a rim-forward push sprints (ShiftLeft + W)', () => {
    const k = stickToKeys(0, -R, R)
    expect(k.KeyW).toBe(true); expect(k.ShiftLeft).toBe(true)
  })
  it('a mid-range forward push does NOT sprint', () => {
    const k = stickToKeys(0, -40, R)
    expect(k.KeyW).toBe(true); expect(k.ShiftLeft).toBe(false)
  })
})

describe('lookYaw', () => {
  it('is zero for no drag, positive rightward, negative leftward', () => {
    expect(lookYaw(0, 100)).toBe(0)
    expect(lookYaw(100, 100)).toBeGreaterThan(0)
    expect(lookYaw(-100, 100)).toBeLessThan(0)
  })
  it('scales linearly with the sensitivity pref', () => {
    expect(lookYaw(100, 200)).toBeCloseTo(lookYaw(100, 100) * 2, 6)
  })
})

// the map opens from Tab on a keyboard and from the paper corner #map-tab on a phone (sharedConventions #12): the action buttons stay the
// five they were plus the whistle (W5's CALL, last), and none of them is Tab — the tab's touchstart / click set K['Tab'] itself (game.js),
// so the one edge in the loop folds it
describe('ACTIONS', () => {
  it('has exactly six entries and none is Tab', () => {
    expect(ACTIONS).toHaveLength(6)
    expect(ACTIONS.map(a => a.code)).toEqual(['KeyF', 'KeyQ', 'Space', 'KeyE', 'KeyL', 'KeyC'])
    expect(ACTIONS.some(a => a.code === 'Tab')).toBe(false)
    expect(ACTIONS[5]).toEqual({ code: 'KeyC', label: 'CALL', hint: 'whistle' })
  })
})
