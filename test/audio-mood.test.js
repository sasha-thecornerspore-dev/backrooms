import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { installFakeAudioContext } from './audio-fake.js'
import * as audio from '../src/renderer/audio.js'
import { DEFAULT_CONFIG } from '../src/renderer/world.js'

// The hunted state is music that never restarts: setMusic swaps the whole mood
// and restarts the beat scheduler ONCE; setMood (added by the integrator in
// audio.js, per the fight-verbs integration notes) patches the live mood object
// in place and must touch neither timer. Until that export lands its case skips.
const HAS_SET_MOOD = typeof audio.setMood === 'function'
let restore, timers

beforeAll(() => {
  ;({ restore } = installFakeAudioContext())
  timers = {
    setInterval:   vi.spyOn(globalThis, 'setInterval').mockImplementation(() => 1),
    clearInterval: vi.spyOn(globalThis, 'clearInterval').mockImplementation(() => {}),
    setTimeout:    vi.spyOn(globalThis, 'setTimeout').mockImplementation(() => 1),   // distant events: no dangling real timers
  }
  audio.initAudio(DEFAULT_CONFIG)
})

afterAll(() => {
  for (const s of Object.values(timers)) s.mockRestore()
  restore()
})

const mood = () => ({ root: 220, scale: [0, 2, 4, 7, 9], progressions: [[0, 3, 4, 2]], tempo: 400, beatsPerChord: 8,
                      beatsPerBar: 4, groove: 0.5, leadChance: 0.35, brightness: 1500, volume: 0.06 })

describe('setMusic', () => {
  it('restarts the beat scheduler exactly once per call', () => {
    timers.setInterval.mockClear(); timers.clearInterval.mockClear()
    audio.setMusic(mood())
    expect(timers.clearInterval).toHaveBeenCalledTimes(1)
    expect(timers.setInterval).toHaveBeenCalledTimes(1)
    expect(timers.setInterval).toHaveBeenCalledWith(expect.any(Function), 400)
  })
})

describe('setMood', () => {
  it.skipIf(!HAS_SET_MOOD)('patches the live mood in place and calls neither setInterval nor clearInterval', () => {
    const m = mood()
    audio.setMusic(m)
    timers.setInterval.mockClear(); timers.clearInterval.mockClear()
    audio.setMood({ groove: 1 })
    expect(timers.setInterval).not.toHaveBeenCalled()
    expect(timers.clearInterval).not.toHaveBeenCalled()
    expect(m.groove).toBe(1)        // Object.assign into the object setMusic was handed: the beat reads it live
    expect(m.tempo).toBe(400)       // tempo is never changed
  })
})
