// audio.js whistle(semis, pan, gain) (W5): a friend calling out — two sine notes a fourth apart, ~0.4 s, on the ambience bus, panned
// like bump. The fake context records the graph (see audio-bump.test.js): the pitch, the two peaks and their decay, the panner rule,
// the gain clamp, and nothing at all for a silent call.
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
    setTimeout:    vi.spyOn(globalThis, 'setTimeout').mockImplementation(() => 1),
  }
  audio.initAudio(DEFAULT_CONFIG)
  ambience = fake.nodes.all.find((n) => n.kind === 'gain' && n.out.includes(fake.nodes.ctxs[0].destination))
  expect(ambience).toBeTruthy()
})
afterAll(() => { for (const s of Object.values(timers)) s.mockRestore(); fake.restore() })

function made(fn) { const before = fake.nodes.all.length; fn(); return fake.nodes.all.slice(before) }
const ramps = (g) => g.gain.calls.filter((c) => c[0] === 'exponentialRampToValueAtTime').map((c) => c[1])
const peak = (g) => Math.max(...ramps(g))

describe('whistle', () => {
  it('whistle(0): two sines, 880 Hz and a fourth up, each into its own gain on the ambience bus; peaks 0.07 / 0.063, decay to 0.0004', () => {
    const nodes = made(() => audio.whistle(0))
    const osc = nodes.filter((n) => n.kind === 'oscillator'), gains = nodes.filter((n) => n.kind === 'gain')
    expect(osc).toHaveLength(2); expect(gains).toHaveLength(2)
    expect(nodes.some((n) => n.kind === 'panner')).toBe(false)
    expect(osc.map((o) => o.type)).toEqual(['sine', 'sine'])
    const t = fake.nodes.ctxs[0].currentTime
    expect(osc[0].frequency.calls[0][0]).toBe('setValueAtTime')
    expect(osc[0].frequency.calls[0][1]).toBeCloseTo(880, 6); expect(osc[0].frequency.calls[0][2]).toBe(t)
    expect(osc[1].frequency.calls[0][1]).toBeCloseTo(880 * 2 ** (5 / 12), 6)
    expect(osc[1].frequency.calls[0][2]).toBeCloseTo(t + 0.17, 9)
    expect(osc[0].out).toEqual([gains[0]]); expect(osc[1].out).toEqual([gains[1]])
    for (const g of gains) expect(g.out).toEqual([ambience])
    expect(peak(gains[0])).toBeCloseTo(0.07, 12); expect(peak(gains[1])).toBeCloseTo(0.063, 12)
    expect(ramps(gains[0]).at(-1)).toBe(0.0004); expect(ramps(gains[1]).at(-1)).toBe(0.0004)
    expect(gains[0].gain.calls[0]).toEqual(['setValueAtTime', 0.0001, t])
    expect(gains[0].gain.calls.map((c) => c[2])).toEqual([t, t + 0.012, t + 0.19])
    expect(gains[1].gain.calls.map((c) => c[2]).map((x) => +x.toFixed(6))).toEqual([t + 0.17, t + 0.182, t + 0.40].map((x) => +x.toFixed(6)))
    expect(osc[0].started).toEqual([t]); expect(osc[0].stopped).toEqual([t + 0.2])
    expect(osc[1].started[0]).toBeCloseTo(t + 0.17, 9); expect(osc[1].stopped[0]).toBeCloseTo(t + 0.41, 9)
  })
  it('whistle(7) starts a fifth up', () => {
    const o = made(() => audio.whistle(7)).filter((n) => n.kind === 'oscillator')
    expect(o[0].frequency.calls[0][1]).toBeCloseTo(880 * 2 ** (7 / 12), 6)
    expect(o[1].frequency.calls[0][1]).toBeCloseTo(880 * 2 ** (12 / 12), 6)
  })
  it('a pan makes one panner into the bus and both gains go through it; the pan is clamped', () => {
    const p = made(() => audio.whistle(0, 0.6))
    const pans = p.filter((n) => n.kind === 'panner')
    expect(pans).toHaveLength(1)
    expect(pans[0].pan.value).toBe(0.6); expect(pans[0].out).toEqual([ambience])
    for (const g of p.filter((n) => n.kind === 'gain')) expect(g.out).toEqual([pans[0]])
    expect(made(() => audio.whistle(0, -3)).find((n) => n.kind === 'panner').pan.value).toBe(-1)
  })
  it('the gain scales both peaks and is clamped to 1', () => {
    const half = made(() => audio.whistle(0, 0, 0.5)).filter((n) => n.kind === 'gain')
    expect(peak(half[0])).toBeCloseTo(0.035, 12); expect(peak(half[1])).toBeCloseTo(0.0315, 12)
    const loud = made(() => audio.whistle(0, 0, 4)).filter((n) => n.kind === 'gain')
    expect(peak(loud[0])).toBeCloseTo(0.07, 12)
  })
  it('a silent call makes no nodes at all', () => {
    expect(made(() => audio.whistle(0, 0, 0))).toEqual([])
    expect(made(() => audio.whistle(0, 0, -1))).toEqual([])
    expect(made(() => audio.whistle(0, 0.5, NaN))).toEqual([])
  })
})
