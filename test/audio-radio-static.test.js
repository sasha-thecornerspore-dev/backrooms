// audio.js setRadioStatic(gain, tc): the radio's hiss (radiostatic.js says how loud). The fake context records the graph: nothing is
// built until a hiss is first asked for, then ONE chain is, once — the one second of noise initAudio built, looped, its pitch drifting
// slowly (a modulator into the source's detune), through one band-pass into one gain, and into the destination beside the radio's
// notes: no panner anywhere on it, one channel, so it says near and never where. Every change after that is one setTargetAtTime on
// that gain (a glide: it never zippers) and nothing else; an unchanged ask touches nothing; it is never louder than the cap. The
// radio's tune itself is the same graph it always was. Without a context it is silent and throws nothing.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { installFakeAudioContext } from './audio-fake.js'
import { DEFAULT_CONFIG } from '../src/renderer/world.js'
import { STATIC } from '../src/renderer/radiostatic.js'

let fake, timers, audio, ctx
beforeEach(async () => {
  fake = installFakeAudioContext()
  let tick = null
  timers = {
    setInterval:   vi.spyOn(globalThis, 'setInterval').mockImplementation((f) => { tick = f; return 1 }),
    clearInterval: vi.spyOn(globalThis, 'clearInterval').mockImplementation(() => {}),
    setTimeout:    vi.spyOn(globalThis, 'setTimeout').mockImplementation(() => 1),
  }
  timers.fire = () => tick && tick()
  vi.resetModules()
  audio = await import('../src/renderer/audio.js')
  audio.initAudio(DEFAULT_CONFIG)
  ctx = fake.nodes.ctxs[0]
})
afterEach(() => { for (const k of ['setInterval', 'clearInterval', 'setTimeout']) timers[k].mockRestore(); fake.restore() })

function made(fn) { const before = fake.nodes.all.length; fn(); return fake.nodes.all.slice(before) }
const of = (nodes, kind) => nodes.filter((n) => n.kind === kind)
const noiseSecond = () => {
  // the one second of noise initAudio built: every slice the steps play is of it
  const n = made(() => audio.step('carpet', 0.5))
  return of(n, 'buffer-source')[0].buffer
}

describe('built once, the first time a hiss is asked for', () => {
  it('nothing at all until then: a zero ask builds nothing, and the level reads 0', () => {
    expect(made(() => { audio.setRadioStatic(0, 0.05); audio.setRadioStatic(0, 0.9) })).toEqual([])
    expect(audio.radioStaticLevel()).toBe(0)
  })
  it('then one chain: the shared noise looped, a slow drift on its pitch, one band-pass, one gain, into the destination and nowhere else', () => {
    const buf = noiseSecond()
    const n = made(() => audio.setRadioStatic(0.02, STATIC.rise))
    expect(n.map((x) => x.kind).sort()).toEqual(['biquad', 'buffer-source', 'gain', 'gain', 'oscillator'])
    const [src] = of(n, 'buffer-source'), [bp] = of(n, 'biquad'), [lfo] = of(n, 'oscillator')
    expect(src.buffer).toBe(buf); expect(src.loop).toBe(true)
    expect(buf.numberOfChannels).toBe(1)
    expect(src.started).toHaveLength(1); expect(src.stopped).toEqual([])
    expect(lfo.started).toHaveLength(1); expect(lfo.stopped).toEqual([])
    expect(bp.type).toBe('bandpass')
    expect(src.out).toEqual([bp])
    const out = bp.out[0]
    expect(out.kind).toBe('gain'); expect(out.out).toEqual([ctx.destination])
    // the drift only moves the source's pitch: it is never heard on its own
    const depth = lfo.out[0]
    expect(depth.kind).toBe('gain'); expect(depth.out).toEqual([src.detune])
    expect(lfo.frequency.value).toBeLessThan(1)
  })
  it('no panner, ever, on the hiss: one level for both ears', () => {
    const spy = vi.spyOn(ctx, 'createStereoPanner')
    const n = made(() => { for (let i = 1; i <= 40; i++) audio.setRadioStatic(i / 1000, STATIC.rise) })
    expect(spy).not.toHaveBeenCalled()
    expect(of(n, 'panner')).toEqual([])
    spy.mockRestore()
  })
})

describe('every change is one glide on the one gain', () => {
  it('a new level: one setTargetAtTime(level, now, tc) and nothing else; no new node; the level reads back', () => {
    const n0 = made(() => audio.setRadioStatic(0.01, STATIC.rise))
    const out = of(n0, 'biquad')[0].out[0]
    const before = out.gain.calls.length
    ctx.currentTime = 12.5
    const n = made(() => { audio.setRadioStatic(0.03, STATIC.rise); audio.setRadioStatic(0.005, STATIC.fall); audio.setRadioStatic(0, STATIC.cut) })
    expect(n).toEqual([])
    expect(out.gain.calls.slice(before)).toEqual([['setTargetAtTime', 0.03, 12.5, STATIC.rise], ['setTargetAtTime', 0.005, 12.5, STATIC.fall],
      ['setTargetAtTime', 0, 12.5, STATIC.cut]])
    expect(audio.radioStaticLevel()).toBe(0)
    // the gain is never jumped: its value is only ever set at the build (to 0, silent) and glided after
    expect(out.gain.calls.every((c) => c[0] === 'setTargetAtTime')).toBe(true)
    expect(out.gain.calls[0][1]).toBe(0.01)
  })
  it('an unchanged ask touches nothing (game.js asks every frame)', () => {
    const n0 = made(() => audio.setRadioStatic(0.02, STATIC.rise))
    const out = of(n0, 'biquad')[0].out[0]
    const k = out.gain.calls.length
    for (let i = 0; i < 600; i++) audio.setRadioStatic(0.02, STATIC.rise)
    expect(out.gain.calls.length).toBe(k)
  })
  it('never louder than the cap however it is asked; nonsense is silence; a bad time constant glides at the cut', () => {
    const n0 = made(() => audio.setRadioStatic(5, 0.4))
    const out = of(n0, 'biquad')[0].out[0]
    expect(out.gain.calls.at(-1)[1]).toBe(0.06)
    audio.setRadioStatic(NaN, 0.4); expect(out.gain.calls.at(-1)[1]).toBe(0)
    audio.setRadioStatic(0.02, -1); expect(out.gain.calls.at(-1)).toEqual(['setTargetAtTime', 0.02, ctx.currentTime, 0.05])
    audio.setRadioStatic(-3, 0.4); expect(out.gain.calls.at(-1)[1]).toBe(0)
  })
  it('the table\'s loudest is under the cap, so the cap never bends it', () => {
    const n0 = made(() => audio.setRadioStatic(STATIC.max, STATIC.rise))
    expect(of(n0, 'biquad')[0].out[0].gain.calls.at(-1)[1]).toBe(STATIC.max)
  })
})

describe('the radio\'s tune is the graph it always was', () => {
  it('a note every 480 ms: a detuned triangle through a band-pass at 900 Hz, up to 0.03 and away, straight into the destination', () => {
    audio.setRadio(true)
    expect(timers.setInterval).toHaveBeenCalledWith(expect.any(Function), 480)
    for (const hissing of [false, true]) {
      if (hissing) audio.setRadioStatic(0.04, STATIC.rise)
      const n = made(() => timers.fire())
      expect(n.map((x) => x.kind)).toEqual(['oscillator', 'gain', 'biquad'])
      const [osc, g, filt] = n
      expect(osc.type).toBe('triangle'); expect(filt.type).toBe('bandpass'); expect(filt.frequency.value).toBe(900); expect(filt.Q.value).toBe(1.2)
      expect(osc.out).toEqual([filt]); expect(filt.out).toEqual([g]); expect(g.out).toEqual([ctx.destination])
      expect(g.gain.calls.map((c) => [c[0], c[1]])).toEqual([['setValueAtTime', 0], ['linearRampToValueAtTime', 0.03], ['linearRampToValueAtTime', 0]])
    }
    audio.setRadio(false)
  })
})

describe('without audio', () => {
  it('silent, and throws nothing', async () => {
    vi.resetModules()
    const bare = await import('../src/renderer/audio.js')
    expect(() => { bare.setRadioStatic(0.03, 0.4); bare.setRadioStatic(0, 0.05) }).not.toThrow()
    expect(bare.radioStaticLevel()).toBe(0)
  })
  it('a context that throws on every create throws nothing out', () => {
    const names = ['createGain', 'createOscillator', 'createBiquadFilter', 'createBufferSource']
    for (const k of names) ctx[k] = () => { throw new Error('no audio here') }
    try { expect(() => audio.setRadioStatic(0.03, 0.4)).not.toThrow() } finally { for (const k of names) delete ctx[k] }
  })
})
