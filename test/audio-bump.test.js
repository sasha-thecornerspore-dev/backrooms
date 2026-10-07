// audio.js bump(kind, intensity, pan) (integrator, the collide item): the one-shot a body answers with. The fake context records the
// graph: every kind ends on the ambience bus, the gain follows the intensity (clamped to 0..1), a panner appears only when a pan is
// asked for, and a kind the recipe book does not know ('silent', anything else) plays nothing.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { installFakeAudioContext } from './audio-fake.js'
import * as audio from '../src/renderer/audio.js'
import { DEFAULT_CONFIG } from '../src/renderer/world.js'

let fake, timers, ambience
beforeAll(() => {
  fake = installFakeAudioContext()
  timers = {
    setInterval:   vi.spyOn(globalThis, 'setInterval').mockImplementation(() => 1),
    clearInterval: vi.spyOn(globalThis, 'clearInterval').mockImplementation(() => {}),
    setTimeout:    vi.spyOn(globalThis, 'setTimeout').mockImplementation(() => 1),   // distant events: no dangling real timers
  }
  audio.initAudio(DEFAULT_CONFIG)
  // the ambience bus is the one gain initAudio wires straight into the destination
  ambience = fake.nodes.all.find((n) => n.kind === 'gain' && n.out.includes(fake.nodes.ctxs[0].destination))
  expect(ambience).toBeTruthy()
})
afterAll(() => { for (const s of Object.values(timers)) s.mockRestore(); fake.restore() })

// the nodes one call created
function made(fn) { const before = fake.nodes.all.length; fn(); return fake.nodes.all.slice(before) }
const sinks = (nodes) => nodes.filter((n) => n.out.includes(ambience))
const ramps = (g) => g.gain.calls.filter((c) => c[0] === 'exponentialRampToValueAtTime' || c[0] === 'linearRampToValueAtTime').map((c) => c[1])

describe('bump', () => {
  it("'thud' is one sine 110 -> 40 Hz into a gain of 0.10 x intensity on the ambience bus, started and stopped", () => {
    const nodes = made(() => audio.bump('thud', 0.5))
    const o = nodes.find((n) => n.kind === 'oscillator'), g = nodes.find((n) => n.kind === 'gain')
    expect(o.type).toBe('sine')
    expect(o.frequency.calls[0]).toEqual(['setValueAtTime', 110, 0])
    expect(o.frequency.calls[1][0]).toBe('exponentialRampToValueAtTime'); expect(o.frequency.calls[1][1]).toBe(40)
    expect(o.out).toContain(g); expect(sinks(nodes)).toEqual([g])
    expect(ramps(g)).toContain(0.05)
    expect(o.started).toHaveLength(1); expect(o.stopped).toHaveLength(1)
    expect(nodes.some((n) => n.kind === 'panner')).toBe(false)             // centred: no panner node
  })
  it("'hollow' is a triangle 180 -> 70 Hz; 'wood' a 70 Hz sine tap", () => {
    const h = made(() => audio.bump('hollow'))
    const ho = h.find((n) => n.kind === 'oscillator')
    expect(ho.type).toBe('triangle'); expect(ho.frequency.calls[0][1]).toBe(180); expect(ho.frequency.calls[1][1]).toBe(70)
    expect(sinks(h)).toHaveLength(1)
    const w = made(() => audio.bump('wood', 0.5))
    const wo = w.find((n) => n.kind === 'oscillator')
    expect(wo.type).toBe('sine'); expect(wo.frequency.calls).toEqual([['setValueAtTime', 70, 0]])
    expect(ramps(w.find((n) => n.kind === 'gain'))).toContain(0.04)
  })
  it("'scrape' is a noise burst through a 900 Hz band-pass; 'murmur' the whisper's graph at half gain", () => {
    const s = made(() => audio.bump('scrape'))
    expect(s.find((n) => n.kind === 'buffer-source').buffer.length).toBe(Math.floor(48000 * 0.12))
    const bp = s.find((n) => n.kind === 'biquad')
    expect(bp.type).toBe('bandpass'); expect(bp.frequency.value).toBe(900)
    expect(sinks(s)).toHaveLength(1)
    const m = made(() => audio.bump('murmur'))
    expect(m.some((n) => n.kind === 'buffer-source')).toBe(true)
    expect(m.find((n) => n.kind === 'biquad').type).toBe('bandpass')
    const mg = sinks(m)
    expect(mg).toHaveLength(1)
    expect(ramps(mg[0])).toContain(0.03 * 0.5)
  })
  it('a pan makes one panner into the bus; the intensity is clamped to 0..1', () => {
    const p = made(() => audio.bump('thud', 7, 0.6))
    const pan = p.find((n) => n.kind === 'panner')
    expect(pan.pan.value).toBe(0.6); expect(pan.out).toContain(ambience)
    expect(p.find((n) => n.kind === 'gain').out).toContain(pan)
    expect(ramps(p.find((n) => n.kind === 'gain'))).toContain(0.10)
    const q = made(() => audio.bump('wood', 1, -3))
    expect(q.find((n) => n.kind === 'panner').pan.value).toBe(-1)
  })
  it("'silent' and an unknown kind play nothing (not even a panner)", () => {
    expect(made(() => audio.bump('silent'))).toEqual([])
    expect(made(() => audio.bump('glass', 1, 0.3))).toEqual([])
  })
  it('the sanity whisper is unchanged: full gain, straight into the destination', () => {
    const w = made(() => audio.whisper())
    const g = w.filter((n) => n.kind === 'gain').find((n) => n.out.includes(fake.nodes.ctxs[0].destination))
    expect(g).toBeTruthy()
    expect(ramps(g)).toContain(0.03)
  })
})
