// audio.js, the pulse's small sounds (T1-1, S1): your own steps by floor, the pickup ticks, paper in your hands, the panels going out,
// the twelve calls (the tells and the landmarks) and the hum's glide. The fake context records the graph (see audio-bump.test.js):
// every one ends on the ambience bus (through one panner when panned, never straight into the destination), none of them can be louder
// than 0.06 however it is asked, the noise recipes all play slices of the one second initAudio builds, the hum glides on its detune and
// its gain, and nothing plays or throws without a context.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { installFakeAudioContext } from './audio-fake.js'
import * as audio from '../src/renderer/audio.js'
import { DEFAULT_CONFIG } from '../src/renderer/world.js'

let fake, timers, ctx, ambience, humOsc, humGain
beforeAll(() => {
  fake = installFakeAudioContext()
  // the fake's start() keeps only the time; a slice of the noise is start(t, offset, dur), so keep every argument as well
  const proto = globalThis.AudioContext.prototype, make = proto.createBufferSource
  proto.createBufferSource = function () {
    const n = make.call(this), start = n.start
    n.startArgs = []
    n.start = (...a) => { n.startArgs.push(a); start(...a) }
    return n
  }
  timers = {
    setInterval:   vi.spyOn(globalThis, 'setInterval').mockImplementation(() => 1),
    clearInterval: vi.spyOn(globalThis, 'clearInterval').mockImplementation(() => {}),
    setTimeout:    vi.spyOn(globalThis, 'setTimeout').mockImplementation(() => 1),   // distant events: no dangling real timers
  }
  audio.initAudio(DEFAULT_CONFIG)
  ctx = fake.nodes.ctxs[0]
  ambience = fake.nodes.all.find((n) => n.kind === 'gain' && n.out.includes(ctx.destination))
  humOsc = fake.nodes.all.find((n) => n.kind === 'oscillator' && n.type === 'sawtooth')   // before any call: the hum is the only saw
  humGain = humOsc.out[0].out[0]                                                          // hum -> its low-pass -> its gain
  expect(ambience).toBeTruthy(); expect(humGain.out).toEqual([ambience])
})
afterAll(() => { for (const s of Object.values(timers)) s.mockRestore(); fake.restore() })

function made(fn) { const before = fake.nodes.all.length; fn(); return fake.nodes.all.slice(before) }
const of = (nodes, kind) => nodes.filter((n) => n.kind === kind)
const sources = (nodes) => nodes.filter((n) => n.kind === 'oscillator' || n.kind === 'buffer-source')
const freq = (o) => (o.frequency.calls.length ? o.frequency.calls[0][1] : o.frequency.value)
const vals = (p) => (p.calls.length ? p.calls.filter((c) => typeof c[1] === 'number').map((c) => c[1]) : [p.value])
const peakOf = (g) => Math.max(...vals(g.gain))
const last = (p) => p.calls[p.calls.length - 1]

// the loudest a node's output can be at the bus: the product of the largest value each gain on the way can take (sources are at most 1,
// noise samples too; filters and panners pass at most 1). An edge into an AudioParam is modulation (the whisper's wobble), not output.
function toBus(n) {
  if (n === ambience) return 1
  let best = 0
  for (const to of n.out) if (to.kind !== 'param' && to.out) best = Math.max(best, toBus(to))
  return best * (n.kind === 'gain' ? Math.max(0, ...vals(n.gain)) : 1)
}
const span = (s) => [s.started[0], s.stopped.length ? s.stopped[0] : s.startArgs?.[0]?.[2] != null ? s.started[0] + s.startArgs[0][2] : Infinity]
// the loudest the sum can get: at every source's start, add every source sounding then at its own loudest
function bound(nodes) {
  const ss = sources(nodes).map((s) => ({ w: span(s), p: toBus(s) }))
  let worst = 0
  for (const { w: [at] } of ss) worst = Math.max(worst, ss.reduce((a, { w: [s0, s1], p }) => a + (s0 <= at && at < s1 ? p : 0), 0))
  return worst
}
// a modulator only moves a param (the whisper's wobble on its band-pass): it is not heard, so it need not reach the bus
const modulates = (n) => n.out.length > 0 && n.out.every((to) => to.kind === 'param' || modulates(to))
// every source reaches the bus, nothing is wired straight to the destination, everything that plays is started once and ends
function onTheBus(nodes) {
  expect(nodes.length).toBeGreaterThan(0)
  for (const n of nodes) expect(n.out).not.toContain(ctx.destination)
  for (const s of sources(nodes)) {
    expect(s.started).toHaveLength(1)
    expect(Number.isFinite(span(s)[1])).toBe(true)
    if (!modulates(s)) expect(toBus(s)).toBeGreaterThan(0)
  }
}

// every export, at its loudest
const LOUD = {
  'step carpet':   () => audio.step('carpet', 1),
  'step concrete': () => audio.step('concrete', 1),
  'step grate':    () => audio.step('grate', 1),
  'step rubber':   () => audio.step('rubber', 1),
  'step wet':      () => audio.step('wet', 1),
  'pickup':        () => audio.pickup(),
  'paper page':    () => audio.paper('page'),
  'paper map':     () => audio.paper('map'),
  'panelsOut':     () => audio.panelsOut(),
  ...Object.fromEntries(audio.CALL_SOUNDS.map((s) => [`call ${s}`, () => audio.call(s, 1)])),
}

describe('the tables', () => {
  it('STEP_MATERIAL is keyed by level index: carpet, concrete, grate, rubber; Level ∅ (index 4) has no entry (the hold)', () => {
    expect(audio.STEP_MATERIAL).toEqual({ 0: 'carpet', 1: 'concrete', 2: 'grate', 3: 'rubber' })
    expect(Object.isFrozen(audio.STEP_MATERIAL)).toBe(true)
    expect(audio.STEP_MATERIAL[4]).toBeUndefined()
    expect(made(() => audio.step(audio.STEP_MATERIAL[4], 0.9))).toEqual([])
  })
  it('CALL_SOUNDS names the twelve recipes, in the plan order', () => {
    expect(audio.CALL_SOUNDS).toEqual(['ring', 'offhook', 'hiss', 'creak', 'buzz', 'click', 'pant', 'drip', 'rasp', 'hush', 'thump', 'scrape'])
    expect(Object.isFrozen(audio.CALL_SOUNDS)).toBe(true)
  })
})

describe('the graph and the bus', () => {
  it.each(Object.keys(LOUD))('%s: every source on the ambience bus, started once and ended, none into the destination', (name) => {
    onTheBus(made(LOUD[name]))
  })
  it("step('carpet'): a 0.06 s slice of noise through a 300 Hz band-pass", () => {
    const n = made(() => audio.step('carpet'))
    const [src] = of(n, 'buffer-source'), [bp] = of(n, 'biquad')
    expect(of(n, 'oscillator')).toEqual([])
    expect(bp.type).toBe('bandpass'); expect(bp.frequency.value).toBe(300)
    expect(src.startArgs[0][2]).toBeCloseTo(0.06, 9)
    expect(src.out).toEqual([bp]); expect(toBus(bp)).toBeGreaterThan(0)
  })
  it("step('concrete'): a sine 90 -> 60 Hz inside 0.05 s, plus a 2 kHz click", () => {
    const n = made(() => audio.step('concrete')), t = ctx.currentTime
    const [body, click] = of(n, 'oscillator')
    expect(body.type).toBe('sine'); expect(freq(body)).toBe(90)
    expect(body.frequency.calls[1]).toEqual(['exponentialRampToValueAtTime', 60, t + 0.05])
    expect(freq(click)).toBe(2000)
    expect(span(click)[1] - t).toBeLessThan(0.05)                                 // a click, not a tone
  })
  it("step('grate'): a 260 Hz triangle with a 1.8 kHz ping; step('rubber'): one 70 Hz sine, 0.06 s", () => {
    const g = of(made(() => audio.step('grate')), 'oscillator')
    expect(g.map((o) => [o.type, freq(o)])).toEqual([['triangle', 260], ['sine', 1800]])
    const r = made(() => audio.step('rubber')), t = ctx.currentTime
    const [o] = of(r, 'oscillator')
    expect(of(r, 'oscillator')).toHaveLength(1)
    expect([o.type, freq(o)]).toEqual(['sine', 70])
    expect(last(of(r, 'gain')[0].gain)).toEqual(['exponentialRampToValueAtTime', 0.0004, t + 0.06])
  })
  it("step's gain is the intensity: a sprint (0.9) is 0.9 / 0.5 of a walk; a walk's knock peaks at 0.35 x footfall's 0.05", () => {
    const loudest = (m, k) => Math.max(...of(made(() => audio.step(m, k)), 'gain').map(peakOf))
    for (const m of ['carpet', 'concrete', 'grate', 'rubber', 'wet']) {
      expect(loudest(m, 0.9)).toBeCloseTo(loudest(m, 0.5) * 0.9 / 0.5, 12)
      expect(loudest(m, 0.5)).toBeLessThanOrEqual(0.35 * 0.05 * 1.7 + 1e-12)          // noise in a step may carry 1.7x: its band passes little of it
      expect(loudest(m)).toBe(loudest(m, 0.5))                                         // the default is a walk
    }
    for (const m of ['concrete', 'grate']) {
      const [knock] = of(made(() => audio.step(m, 0.5)), 'gain')
      expect(peakOf(knock)).toBeCloseTo(0.35 * 0.05, 12)
    }
  })
  it('pickup(): two 30 ms ticks, 1.2 then 1.6 kHz, at 0.04', () => {
    const n = made(() => audio.pickup()), t = ctx.currentTime
    const o = of(n, 'oscillator'), g = of(n, 'gain')
    expect(o.map(freq)).toEqual([1200, 1600])
    expect(g.map(peakOf)).toEqual([0.04, 0.04])
    for (const x of g) expect(last(x.gain)[2] - x.gain.calls[0][2]).toBeCloseTo(0.03, 9)
    expect(o[1].started[0]).toBeGreaterThanOrEqual(span(o[0])[1])                  // one tick, then the other
    expect(o[0].started[0]).toBe(t)
  })
  it("paper('page'): one 0.18 s high-passed burst; paper('map'): two 0.1 s bursts, one after the other", () => {
    const p = made(() => audio.paper('page'))
    expect(of(p, 'buffer-source').map((s) => s.startArgs[0][2])).toEqual([0.18])
    expect(of(p, 'biquad').map((f) => f.type)).toEqual(['highpass'])
    const m = made(() => audio.paper('map')), [a, b] = of(m, 'buffer-source')
    expect(of(m, 'buffer-source').map((s) => s.startArgs[0][2])).toEqual([0.1, 0.1])
    expect(of(m, 'biquad').map((f) => f.type)).toEqual(['highpass', 'highpass'])
    expect(b.started[0]).toBeGreaterThanOrEqual(span(a)[1])
  })
  it('panelsOut(): three soft thuds a quarter second apart, each further off than the last', () => {
    const n = made(() => audio.panelsOut()), t = ctx.currentTime
    const o = of(n, 'oscillator')
    expect(o.map((x) => x.started[0] - t).map((x) => +x.toFixed(9))).toEqual([0, 0.25, 0.5])
    for (const x of o) { expect(x.type).toBe('sine'); expect(freq(x)).toBe(110); expect(x.frequency.calls[1][1]).toBe(40) }
    const peaks = of(n, 'gain').map(peakOf)
    expect(peaks[0]).toBeLessThan(0.10)                                                // softer than bump's thud
    expect(peaks[1]).toBeLessThan(peaks[0]); expect(peaks[2]).toBeLessThan(peaks[1])
  })

  it("'ring' is a bell heard through walls, not a dial tone: two partials near 1.1 and 1.4 kHz under a low-pass, struck at 20 Hz for 2 s, then ringing out", () => {
    const n = made(() => audio.call('ring', 1)), t = ctx.currentTime
    const o = of(n, 'oscillator')
    expect(o.map(freq)).toEqual([1100, 1400])
    for (const f of o.map(freq)) for (const dial of [350, 440, 480]) expect(Math.abs(f - dial) / dial).toBeGreaterThan(0.5)
    const [wall] = of(n, 'biquad')
    expect(wall.type).toBe('lowpass'); expect(wall.frequency.value).toBeLessThanOrEqual(2000)
    const gongs = of(n, 'gain')
    expect(gongs).toHaveLength(2)
    for (let i = 0; i < 2; i++) { expect(o[i].out).toEqual([gongs[i]]); expect(gongs[i].out).toEqual([wall]) }   // each gong its own envelope, both through the wall
    // the clapper: every blow a setValueAtTime, the two gongs taking turns, 20 a second for 2 s
    const blows = gongs.flatMap((g) => g.gain.calls.filter((c) => c[0] === 'setValueAtTime').map((c) => c[2] - t)).sort((a, b) => a - b)
    expect(blows).toHaveLength(40)
    blows.forEach((b, i) => expect(b).toBeCloseTo(i * 0.05, 9))
    for (const g of gongs) {
      const c = g.gain.calls
      for (let i = 0; i + 1 < c.length; i++) if (c[i][0] === 'setValueAtTime') expect(c[i + 1][1]).toBeLessThanOrEqual(c[i][1] * 0.4)   // each blow falls away before the next: gated, never steady
      expect(last(g.gain)[1]).toBeLessThanOrEqual(0.001)                               // and rings out after the last
      expect(last(g.gain)[2] - t).toBeGreaterThan(2.1)
    }
    for (const x of o) expect(span(x)[1] - t).toBeGreaterThanOrEqual(last(gongs[0].gain)[2] - t)
    expect(Math.max(...gongs.map(peakOf))).toBeGreaterThan(0.02)                      // a landmark you can hear
  })
  it("'offhook' is the 440 + 480 Hz pair from a small earpiece, steady for 2 s (no clapper)", () => {
    const n = made(() => audio.call('offhook', 1)), t = ctx.currentTime
    const o = of(n, 'oscillator')
    expect(o.map(freq)).toEqual([440, 480])
    const [g] = of(n, 'gain')
    expect(of(n, 'gain')).toHaveLength(1)
    expect(g.gain.calls.length).toBeLessThanOrEqual(4)
    for (const x of o) expect(span(x)[1] - t).toBeGreaterThanOrEqual(2)
  })
  it("'hiss' 0.4 s and 'rasp' 0.3 s of band-passed noise (the rasp at 400 Hz); 'pant' three breaths through 600 Hz", () => {
    const h = made(() => audio.call('hiss'))
    expect(of(h, 'buffer-source').map((s) => s.startArgs[0][2])).toEqual([0.4]); expect(of(h, 'biquad')[0].type).toBe('bandpass')
    const r = made(() => audio.call('rasp'))
    expect(of(r, 'buffer-source').map((s) => s.startArgs[0][2])).toEqual([0.3])
    expect(of(r, 'biquad')[0].type).toBe('bandpass'); expect(of(r, 'biquad')[0].frequency.value).toBe(400)
    const p = made(() => audio.call('pant'))
    const bp = of(p, 'biquad')[0], g = of(p, 'gain')[0]
    expect(bp.type).toBe('bandpass'); expect(bp.frequency.value).toBe(600)
    const swells = g.gain.calls.filter((c, i, a) => i > 0 && c[1] > 0 && a[i - 1][1] === 0)
    expect(swells).toHaveLength(3)
  })
  it("'creak' a wood tap pitched down; 'buzz' a 120 Hz saw through a 1 kHz band-pass, 0.25 s; 'drip' 1.4 -> 0.9 kHz in 0.05 s", () => {
    const c = made(() => audio.call('creak'))
    const [co] = of(c, 'oscillator')
    expect(co.frequency.calls[1][1]).toBeLessThan(freq(co))
    const b = made(() => audio.call('buzz')), t = ctx.currentTime
    const [bo] = of(b, 'oscillator'), [bf] = of(b, 'biquad')
    expect([bo.type, freq(bo)]).toEqual(['sawtooth', 120])
    expect([bf.type, bf.frequency.value]).toEqual(['bandpass', 1000])
    expect(span(bo)[1] - t).toBeCloseTo(0.25, 1)
    const d = made(() => audio.call('drip'))
    const [dro] = of(d, 'oscillator')
    expect(freq(dro)).toBe(1400); expect(dro.frequency.calls[1]).toEqual(['exponentialRampToValueAtTime', 900, t + 0.05])
  })
  it("'click' two 3 kHz ticks; 'thump' 50 Hz; 'hush' the whisper, under the sanity one at the default gain; 'scrape' bump's scrape", () => {
    const c = of(made(() => audio.call('click')), 'oscillator')
    expect(c.map(freq)).toEqual([3000, 3000])
    expect(c[1].started[0]).toBeGreaterThanOrEqual(span(c[0])[1])
    const th = made(() => audio.call('thump'))
    expect(of(th, 'oscillator').map(freq)).toEqual([50])
    expect(of(th, 'biquad')[0].type).toBe('lowpass')
    const h = made(() => audio.call('hush'))
    expect(of(h, 'buffer-source')).toHaveLength(1); expect(of(h, 'biquad')[0].type).toBe('bandpass')
    const hushPeak = peakOf(of(h, 'gain').find((g) => g.out.includes(ambience)))
    expect(hushPeak).toBeCloseTo(0.03 * 0.6, 12)
    expect(hushPeak).toBeLessThan(0.03)                                                // the sanity whisper's own peak
    const s = made(() => audio.call('scrape')), w = made(() => audio.bump('scrape', 0.5))
    expect(s.map((x) => x.kind)).toEqual(w.map((x) => x.kind))
    expect(of(s, 'biquad')[0].frequency.value).toBe(900)
    expect(peakOf(of(s, 'gain')[0])).toBeCloseTo(peakOf(of(w, 'gain')[0]), 12)
  })
  it('an unknown material, sound or kind plays nothing (not even a panner); so does a silent gain or intensity', () => {
    for (const fn of [() => audio.step('marble', 1, 0.4), () => audio.step(undefined), () => audio.step('toString', 1, 0.4),
                      () => audio.call('bell', 1, 0.4), () => audio.call('constructor', 1, 0.4), () => audio.call(),
                      () => audio.paper('scroll'), () => audio.paper(),
                      () => audio.step('carpet', 0), () => audio.step('grate', NaN, 0.5), () => audio.step('rubber', -1),
                      () => audio.call('ring', 0, 0.5), () => audio.call('hiss', NaN), () => audio.call('scrape', -2, 0.3)]) {
      expect(made(fn)).toEqual([])
    }
  })
})

describe('pan', () => {
  it('a pan makes one panner into the bus and the recipe goes through it; centred makes none; the pan is clamped', () => {
    for (const fn of [(p) => audio.step('grate', 0.5, p), (p) => audio.call('ring', 0.5, p), (p) => audio.call('hush', 0.5, p),
                      (p) => audio.call('scrape', 0.5, p), (p) => audio.call('pant', 0.5, p)]) {
      const n = made(() => fn(0.6))
      const pans = of(n, 'panner')
      expect(pans).toHaveLength(1)
      expect(pans[0].pan.value).toBe(0.6); expect(pans[0].out).toEqual([ambience])
      for (const x of n) if (x !== pans[0]) expect(x.out).not.toContain(ambience)    // nothing goes round it
      expect(of(made(() => fn(0)), 'panner')).toEqual([])
      expect(of(made(() => fn(-3)), 'panner')[0].pan.value).toBe(-1)
      expect(of(made(() => fn(9)), 'panner')[0].pan.value).toBe(1)
    }
  })
  it('your own hands are centred: pickup, paper and the panels make no panner', () => {
    for (const fn of [() => audio.pickup(), () => audio.paper('page'), () => audio.paper('map'), () => audio.panelsOut()]) {
      expect(of(made(fn), 'panner')).toEqual([])
    }
  })
})

describe('the gain cap', () => {
  it.each(Object.keys(LOUD))('%s: never louder than 0.06 at the bus, every voice sounding at once at its loudest', (name) => {
    expect(bound(made(LOUD[name]))).toBeLessThanOrEqual(0.06 + 1e-12)
  })
  it('an over-range gain or intensity is clamped to 1 (the same graph as 1, no louder)', () => {
    for (const s of audio.CALL_SOUNDS) expect(bound(made(() => audio.call(s, 40, 0.3)))).toBeCloseTo(bound(made(() => audio.call(s, 1, 0.3))), 12)
    for (const m of ['carpet', 'concrete', 'grate', 'rubber', 'wet']) expect(bound(made(() => audio.step(m, 7)))).toBeCloseTo(bound(made(() => audio.step(m, 1))), 12)
  })
  it("the gain scales a call: half the gain, half the peak (the scrape too, under its cap)", () => {
    for (const s of audio.CALL_SOUNDS) expect(bound(made(() => audio.call(s, 0.25)))).toBeCloseTo(bound(made(() => audio.call(s, 0.5))) / 2, 12)
  })
})

describe('one noise buffer', () => {
  it('a hundred noise calls allocate no buffer: every slice is of the one second initAudio built, and fits inside it', () => {
    const spy = vi.spyOn(ctx, 'createBuffer')
    const plays = [() => audio.step('carpet', 0.5, 0.2), () => audio.step('wet', 0.9), () => audio.paper('page'), () => audio.paper('map'),
                   () => audio.call('hiss', 0.7), () => audio.call('pant', 0.6, -0.4), () => audio.call('rasp', 0.6, 0.5)]
    const n = made(() => { for (let i = 0; i < 100; i++) plays[i % plays.length]() })
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
    const srcs = of(n, 'buffer-source')
    expect(srcs.length).toBeGreaterThanOrEqual(100)
    const bufs = new Set(srcs.map((s) => s.buffer))
    expect(bufs.size).toBe(1)
    const [buf] = bufs
    expect(buf.length).toBe(48000); expect(buf.duration).toBe(1); expect(buf.numberOfChannels).toBe(1)
    const d = buf.getChannelData(0)
    expect(d.some((v) => v !== 0)).toBe(true)
    expect(d.every((v) => v >= -1 && v <= 1)).toBe(true)
    for (const s of srcs) {
      const [, off, dur] = s.startArgs[0]
      expect(off).toBeGreaterThanOrEqual(0); expect(off + dur).toBeLessThanOrEqual(1)
      expect(s.stopped).toEqual([])                                                    // the slice's own duration ends it
    }
  })
})

describe('the hum', () => {
  it('setHum glides the hum on its detune (cents) and its gain (0.018 x gainMul), arriving in about `seconds`', () => {
    const t = ctx.currentTime, fCalls = humOsc.frequency.calls.length
    audio.setHum(2 ** (-1 / 12), 1, 4)                                                 // the stir warning: half a note down over 4 s
    expect(last(humOsc.detune)[0]).toBe('setTargetAtTime')
    expect(last(humOsc.detune)[1]).toBeCloseTo(-100, 9); expect(last(humOsc.detune)[2]).toBe(t); expect(last(humOsc.detune)[3]).toBeCloseTo(4 / 3, 12)
    expect(last(humGain.gain)).toEqual(['setTargetAtTime', 0.018, t, 4 / 3])
    audio.setHum(1, 1.25, 4)                                                           // the hush swells it
    expect(last(humOsc.detune)[1]).toBe(0)
    expect(last(humGain.gain)[1]).toBeCloseTo(0.0225, 12)
    audio.setHum()                                                                     // the defaults: home, over 3 s
    expect(last(humOsc.detune)).toEqual(['setTargetAtTime', 0, t, 1])
    expect(last(humGain.gain)).toEqual(['setTargetAtTime', 0.018, t, 1])
    expect(humOsc.frequency.calls.length).toBe(fCalls)                                 // the frequency is setFlicker's, untouched
  })
  it('the hum is capped at 0.06 like everything else, may go silent, and ignores nonsense', () => {
    audio.setHum(1, 10, 1)
    expect(last(humGain.gain)[1]).toBe(0.06)
    audio.setHum(1, 0, 1)
    expect(last(humGain.gain)[1]).toBe(0)                                              // a dead wing: no hum at all
    audio.setHum(NaN, -1, NaN)
    expect(last(humOsc.detune)[1]).toBe(0); expect(last(humGain.gain)[1]).toBe(0.018)
    expect(last(humGain.gain)[3]).toBeGreaterThan(0)                                   // an instant, not a division by zero
    audio.setHum(0, 1, 0); expect(last(humOsc.detune)[1]).toBe(0)
    audio.setHum(Infinity, 1, 1); expect(last(humOsc.detune)[1]).toBe(0)
    audio.setHum(16, 1, 1); expect(last(humOsc.detune)[1]).toBeCloseTo(1200, 9)        // an octave either way at most
    audio.setHum(1 / 16, 1, 1); expect(last(humOsc.detune)[1]).toBeCloseTo(-1200, 9)
    audio.setHum(1, 1, 0.5)                                                            // every arrival puts it back
    expect(last(humOsc.detune)[1]).toBe(0); expect(last(humGain.gain)[1]).toBe(0.018)
  })
  it('setFlicker dips the hum from humBase, the base initAudio stored (120 Hz in the shipped config)', async () => {
    audio.setFlicker(1); expect(last(humOsc.frequency)[1]).toBeCloseTo(120, 9)
    audio.setFlicker(0); expect(last(humOsc.frequency)[1]).toBeCloseTo(102, 9)
    vi.resetModules()
    const other = await import('../src/renderer/audio.js')
    other.initAudio({ ...DEFAULT_CONFIG, audio: { ...DEFAULT_CONFIG.audio, humFrequency: 100 } })
    const ctx2 = fake.nodes.ctxs.at(-1)
    const hum2 = fake.nodes.all.find((n) => n.kind === 'oscillator' && n.type === 'sawtooth' && n.frequency.value === 100)
    expect(ctx2).not.toBe(ctx); expect(hum2).toBeTruthy()
    other.setFlicker(1); expect(last(hum2.frequency)[1]).toBeCloseTo(100, 9)
    other.setFlicker(0); expect(last(hum2.frequency)[1]).toBeCloseTo(85, 9)
  })
})

describe('without a context', () => {
  const everything = (a) => {
    for (const m of ['carpet', 'concrete', 'grate', 'rubber', 'wet']) a.step(m, 1, 0.5)
    a.pickup(); a.paper('page'); a.paper('map'); a.panelsOut()
    for (const s of a.CALL_SOUNDS) a.call(s, 1, -0.5)
    a.setHum(2, 2, 1)
  }
  it('every export is a quiet no-op before initAudio: nothing made, nothing thrown', async () => {
    vi.resetModules()
    const bare = await import('../src/renderer/audio.js')
    expect(made(() => expect(() => everything(bare)).not.toThrow())).toEqual([])
  })
  it('and when initAudio found no AudioContext at all', async () => {
    vi.resetModules()
    const bare = await import('../src/renderer/audio.js')
    const AC = globalThis.AudioContext
    delete globalThis.AudioContext
    try { bare.initAudio(DEFAULT_CONFIG) } finally { globalThis.AudioContext = AC }
    expect(made(() => expect(() => everything(bare)).not.toThrow())).toEqual([])
  })
  it('catches its own errors: a context that throws on every create, and a hum that will not glide, throw nothing out', () => {
    const names = ['createGain', 'createOscillator', 'createBiquadFilter', 'createStereoPanner', 'createBufferSource', 'createBuffer']
    for (const k of names) ctx[k] = () => { throw new Error('no audio here') }
    const glide = humOsc.detune.setTargetAtTime
    humOsc.detune.setTargetAtTime = () => { throw new Error('no audio here') }
    try {
      expect(() => everything(audio)).not.toThrow()
    } finally {
      for (const k of names) delete ctx[k]
      humOsc.detune.setTargetAtTime = glide
    }
  })
})
