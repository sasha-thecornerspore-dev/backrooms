// Track HC: the ?gfxstats=1 diagnostics panel (gfx-stats.js) and the renderer's session fallback counter it shows. The panel is opt-in by URL
// only and must cost nothing when off; its numbers (percentiles of the real frame interval and of render()) are pure and tested here.
import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import { statsEnabled, percentileOf, createFrameStats, statsLines, createStatsOverlay, STATS_PERIOD_MS } from '../src/renderer/gfx-stats.js'
import { createRendererWith } from '../src/renderer/renderer.js'
import { GlError } from '../src/renderer/gfx-gl-util.js'

describe('statsEnabled', () => {
  it('only the gfxstats URL parameter turns it on', () => {
    for (const q of ['?gfxstats=1', '?a=2&gfxstats=true', '?gfxstats=on', '?gfxstats=YES']) expect(statsEnabled(q), q).toBe(true)
    for (const q of ['', '?gfxstats=0', '?gfxstats=', '?gfxstats', '?stats=1', '?renderer=gpu', null, undefined]) expect(statsEnabled(q), String(q)).toBe(false)
    expect(statsEnabled(new URLSearchParams('gfxstats=1'))).toBe(true)
  })
})

describe('frame statistics', () => {
  it('nearest-rank percentiles', () => {
    const a = Float64Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    expect(percentileOf(a, 10, 0.5)).toBe(5)
    expect(percentileOf(a, 10, 0.95)).toBe(10)
    expect(percentileOf(a, 10, 0.9)).toBe(9)
    expect(percentileOf(a, 1, 0.99)).toBe(1)
    expect(Number.isNaN(percentileOf(a, 0, 0.5))).toBe(true)
  })
  it('keeps the last `cap` frames (a ring), ignores garbage, counts frames slower than 33 ms', () => {
    const s = createFrameStats(4)
    expect(s.summary().n).toBe(0)
    s.note(100, 50); s.note(NaN, 1); s.note(-1, 1); s.note(5, -2)            // the 100 ms frame is pushed out below; garbage never enters
    for (const v of [10, 20, 30, 40]) s.note(v, v / 10)
    const r = s.summary()
    expect(r.n).toBe(4)
    expect(r.frameP50).toBe(20); expect(r.frameP95).toBe(40)
    expect(r.renderP50).toBe(2); expect(r.renderP95).toBe(4)
    expect(r.over33).toBeCloseTo(0.25)
    s.reset(); expect(s.count).toBe(0)
  })
})

describe('statsLines', () => {
  const sum = { n: 10, frameP50: 16.7, frameP95: 18.2, renderP50: 4.1, renderP95: 6.3, over33: 0.1 }
  it('a CPU frame: kind, why, fallbacks, tier / scale / canvas / dpr, frame and render percentiles, no GPU line', () => {
    const l = statsLines({ kind: 'cpu', why: 'auto-cpu-until-verified', fallbacks: 0, tier: 'medium', scale: 0.6, canvasW: 1280, canvasH: 720, cssW: 1280, cssH: 720, dpr: 1 }, sum)
    expect(l[0]).toBe('renderer cpu (auto-cpu-until-verified) · fallbacks 0')
    expect(l.join('\n')).not.toMatch(/^gpu /m)
    expect(l[1]).toBe('tier medium · scale 0.60 · canvas 1280x720 · dpr 1.00')
    expect(l[2]).toBe('frame p50 16.7 · p95 18.2 ms (60 fps) · >33ms 10%')
    expect(l[3]).toBe('render p50 4.1 · p95 6.3 ms')
  })
  it('a GPU frame names the GPU (clipped), flags software and shows the validation; a hi-DPI canvas shows its css size; the level start', () => {
    const l = statsLines({
      kind: 'gpu', why: 'forced', fallbacks: 1, info: { renderer: 'ANGLE (Intel, Intel(R) Iris(R) Plus Graphics Direct3D11 vs_5_0 ps_5_0, D3D11-27.20.100.9365)', software: true, validation: 'passed' },
      tier: 'high', scale: 0.5, canvasW: 1920, canvasH: 1080, cssW: 1280, cssH: 720, dpr: 1.5,
      levelStart: { level: 2, buildMs: 81.23, gfxMs: 60, firstMs: 12.5, readyMs: 120 },
    }, sum)
    expect(l[1]).toMatch(/^gpu ANGLE \(Intel, .*… \[software\] · validation passed$/)
    expect(l[1].length).toBeLessThan(110)
    expect(l[2]).toBe('tier high · scale 0.50 · canvas 1920x1080 (css 1280x720) · dpr 1.50')
    expect(l[5]).toBe('level 2 start: build 81.2 (renderer 60.0) ms')
    expect(l[6]).toBe('  first frame 12.5 · ready 120.0 ms')                // two lines: a phone-width panel wraps nothing away
  })
  it('never throws on an empty snapshot', () => {
    expect(() => statsLines(null, null)).not.toThrow()
    expect(statsLines({}, { n: 0 })[2]).toMatch(/^frame p50 - · p95 - ms/)
  })
})

// a minimal DOM: just what createStatsOverlay touches
function fakeDoc() {
  const mk = () => ({ style: {}, attrs: {}, children: [], textContent: '', setAttribute(k, v) { this.attrs[k] = v }, appendChild(c) { this.children.push(c); c.parent = this }, remove() { if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1) } })
  return { body: mk(), createElement: mk }
}
describe('createStatsOverlay', () => {
  it('one aria-hidden, pointer-events:none panel under the HUD cluster, refreshed every 500 ms, removed on dispose', () => {
    const doc = fakeDoc(), parent = doc.createElement('div')
    const timers = { setInterval: vi.fn(() => 7), clearInterval: vi.fn() }
    const read = vi.fn(() => ({ kind: 'cpu', why: 'pref-cpu', fallbacks: 0, tier: 'low', scale: 0.5, canvasW: 800, canvasH: 450, dpr: 2 }))
    const o = createStatsOverlay({ doc, parent, read, timers })
    expect(parent.children).toEqual([o.el])
    expect(o.el.attrs['aria-hidden']).toBe('true')
    expect(o.el.style.pointerEvents).toBe('none')
    expect(o.el.style.position).toBeUndefined()                    // it flows inside the cluster: no fixed position of its own
    expect(timers.setInterval).toHaveBeenCalledWith(expect.any(Function), STATS_PERIOD_MS)
    expect(STATS_PERIOD_MS).toBe(500)
    for (let i = 0; i < 30; i++) o.frame(16.7, 3)
    timers.setInterval.mock.calls[0][0]()
    expect(o.el.textContent).toMatch(/renderer cpu \(pref-cpu\)/)
    expect(o.el.textContent).toMatch(/frame p50 16\.7/)
    o.dispose(); o.dispose()
    expect(timers.clearInterval).toHaveBeenCalledTimes(1)
    expect(parent.children).toEqual([])
  })
  it('without a parent it is fixed to the top-left corner of the body; a throwing read() leaves a panel, not an exception', () => {
    const doc = fakeDoc()
    const o = createStatsOverlay({ doc, read: () => { throw new Error('no level yet') }, timers: { setInterval: () => 1, clearInterval: () => {} } })
    expect(doc.body.children[0]).toBe(o.el)
    expect(o.el.style.position).toBe('fixed')
    expect(o.el.textContent).toMatch(/^renderer \?/)
  })
})

describe('game.js wires the panel only when asked', () => {
  const game = fs.readFileSync(new URL('../src/renderer/game.js', import.meta.url), 'utf8')
  it('created under statsEnabled(location.search) and fed only when it exists', () => {
    expect(game).toMatch(/const gfxStats = statsEnabled\(location\.search\) \? createStatsOverlay\(/)
    expect(game).toMatch(/if \(gfxStats\) gfxStats\.frame\(rawMs, r1 - r0\)/)
    expect(game).toMatch(/parent: document\.getElementById\('hud-cluster'\)/)
  })
})

// ── the renderer's session fallback counter ──
const memStore = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) } }
const fakeCanvas = () => ({ id: 'c', width: 320, height: 180, style: {}, ownerDocument: { createElement: () => fakeCanvas() }, toDataURL: () => 'data:,' })
describe('renderer fallbacks', () => {
  it('counts every abandoned GPU path across the renderers of one factory (creation and runtime), never a CPU choice', () => {
    let glMode = 'ok'
    const store = memStore()
    const create = createRendererWith({
      storage: () => store, search: () => '', now: () => 1e6, warn: () => {},
      probeGl: () => ({ ok: true, webgl2: true, majorPerformanceCaveat: false, unmaskedRenderer: 'Fake', reason: 'ok' }),
      createCpu: () => ({ render() {}, dispose() {} }),
      createGl: () => {
        if (glMode === 'throw') throw new GlError('init', 'boom')
        return { kind: 'gpu', render() { if (glMode === 'frame') throw new GlError('frame', 'bad frame') }, dispose() {} }
      },
    })
    const a = create(fakeCanvas(), { palette: {} }, { renderer: 'cpu' })
    expect(a.fallbacks).toBe(0)
    glMode = 'frame'
    const b = create(fakeCanvas(), { palette: {} }, { renderer: 'gpu' })
    expect(b.kind).toBe('gpu'); b.render(); expect(b.kind).toBe('cpu')
    expect(b.fallbacks).toBe(1); expect(a.fallbacks).toBe(1)       // a session count: every renderer of the factory reports it
    const c = createRendererWith({ storage: () => memStore(), search: () => '', now: () => 1e6, warn: () => {}, probeGl: () => ({ ok: true, webgl2: true, unmaskedRenderer: 'Fake', reason: 'ok' }), createCpu: () => ({ render() {}, dispose() {} }), createGl: () => { throw new GlError('init', 'boom') } })
    expect(c(fakeCanvas(), { palette: {} }, { renderer: 'gpu' }).fallbacks).toBe(1)
  })
})
