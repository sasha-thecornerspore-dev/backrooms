import { describe, it, expect } from 'vitest'
import { installFakeAudioContext } from './audio-fake.js'

describe('installFakeAudioContext', () => {
  it('installs globalThis.AudioContext, records connect() edges in nodes, and restore() removes the global', () => {
    const before = globalThis.AudioContext
    const { nodes, restore } = installFakeAudioContext()
    expect(typeof globalThis.AudioContext).toBe('function')
    const ac = new globalThis.AudioContext()
    expect(ac.sampleRate).toBe(48000)
    expect(ac.currentTime).toBe(0)
    expect(nodes.ctxs).toContain(ac)
    const o = ac.createOscillator(), f = ac.createBiquadFilter(), g = ac.createGain(), p = ac.createStereoPanner()
    expect(o.connect(f)).toBe(f)
    f.connect(g); g.connect(p); p.connect(ac.destination)
    expect(nodes.edges).toEqual([[o, f], [f, g], [g, p], [p, ac.destination]])
    expect(o.out).toEqual([f])
    expect(nodes.all.map((n) => n.kind)).toEqual(['oscillator', 'biquad', 'gain', 'panner'])
    restore()
    expect(globalThis.AudioContext).toBe(before)
    expect('AudioContext' in globalThis).toBe(before !== undefined)
  })

  it('AudioParams take the scheduling calls, keep a value, and are connect() targets', () => {
    const { nodes, restore } = installFakeAudioContext()
    try {
      const ac = new AudioContext()
      const g = ac.createGain(), o = ac.createOscillator()
      expect(g.gain.value).toBe(1)
      expect(o.frequency.value).toBe(440)
      g.gain.value = 0.3
      g.gain.setValueAtTime(0.5, 1); g.gain.linearRampToValueAtTime(0.1, 2); g.gain.exponentialRampToValueAtTime(0.01, 3); g.gain.setTargetAtTime(0.2, 4, 0.5)
      expect(g.gain.calls.map((c) => c[0])).toEqual(['setValueAtTime', 'linearRampToValueAtTime', 'exponentialRampToValueAtTime', 'setTargetAtTime'])
      expect(g.gain.value).toBe(0.2)
      o.connect(g.gain)
      expect(nodes.edges).toEqual([[o, g.gain]])
    } finally { restore() }
  })

  it('buffers hand out channel data of the requested length; sources start/stop and remember it', () => {
    const { restore } = installFakeAudioContext()
    try {
      const ac = new AudioContext()
      const b = ac.createBuffer(2, 480, 48000)
      expect(b.length).toBe(480); expect(b.numberOfChannels).toBe(2); expect(b.sampleRate).toBe(48000); expect(b.duration).toBeCloseTo(0.01)
      const d = b.getChannelData(1)
      expect(d).toBeInstanceOf(Float32Array); expect(d.length).toBe(480)
      expect(b.getChannelData(1)).toBe(d)
      const s = ac.createBufferSource()
      s.buffer = b; s.loop = true; s.start(0.5); s.stop(2)
      expect(s.started).toEqual([0.5]); expect(s.stopped).toEqual([2])
      const o = ac.createOscillator(); o.start(); o.stop(1)
      expect(o.started).toEqual([0]); expect(o.stopped).toEqual([1])
    } finally { restore() }
  })

  it('is enough to run audio.js initAudio without throwing (mirrors gfx-hp-fakes: lifecycle and calls, nothing heard)', async () => {
    const { nodes, restore } = installFakeAudioContext()
    try {
      const { initAudio } = await import('../src/renderer/audio.js')
      const { DEFAULT_CONFIG } = await import('../src/renderer/world.js')
      initAudio(DEFAULT_CONFIG)
      expect(nodes.edges.length).toBeGreaterThan(0)
      expect(nodes.edges.some(([, to]) => to.kind === 'destination')).toBe(true)
    } finally { restore() }
  })
})
