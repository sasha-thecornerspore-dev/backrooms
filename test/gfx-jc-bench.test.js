// Fixer JC: the ?gfxbench=1 benchmark and the GPU crash-loop marker (H-CORE-1 / E2E-1), and the benchmark's reduced motion (H-CORE-6).
// The run must leave the marker EXACTLY as it found it — a tripped crash loop, a pre-existing count, nothing — unless one of its own GPU starts
// failed in a way the game remembers, which stays recorded. Driven through the REAL renderer factory (createRendererWith) with fake backends
// and an in-memory localStorage, the way startBench drives it (createMarkerGuard + note(r) before each dispose + finish()).
import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
globalThis.__backroomsTestRun = true
import { createMarkerGuard, benchReducedMotion, PREFS_KEY } from '../src/renderer/gfx-bench.js'
import { createRendererWith, GPU_MARKER_KEY } from '../src/renderer/renderer.js'
import { CRASH_HEALTHY_FRAMES, CRASH_LIMIT } from '../src/renderer/gfx-quality.js'
import { GlError } from '../src/renderer/gfx-gl-util.js'

const root = path.resolve(import.meta.dirname, '..')
const src = (f) => fs.readFileSync(path.join(root, f), 'utf8')

const NOW = 5_000_000
const memStore = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: vi.fn((k, v) => m.set(k, String(v))), removeItem: vi.fn((k) => m.delete(k)), _m: m } }
const fakeCanvas = () => ({ id: 'c', width: 320, height: 180, style: {}, ownerDocument: { createElement: () => fakeCanvas() }, toDataURL: () => 'data:,' })
const okProbe = { ok: true, webgl2: true, majorPerformanceCaveat: false, unmaskedRenderer: 'ANGLE (Fake GPU)', reason: 'ok' }
function backend(kind, failOn) {
  const b = { kind, frames: 0, render() { b.frames++; const e = failOn && failOn(b.frames); if (e) throw e }, dispose() {}, info: kind === 'gpu' ? { validation: 'passed' } : undefined }
  return b
}
// the bench's factory, over a store; gl = (frameIndex) => Error | null for the GPU backend, or glThrows at creation
function benchFactory(store, { failOn, glThrows } = {}) {
  return createRendererWith({
    storage: () => store, search: () => '', now: () => NOW, warn: () => {}, onPageHide: () => () => {},
    probeGl: () => okProbe,
    createCpu: () => backend('cpu'),
    createGl: () => { if (glThrows) throw glThrows; return backend('gpu', failOn) },
  })
}
const player = { x: 1.5, y: 1.5, angle: 0 }
// one benchmark "segment": create a GPU renderer, draw n frames, note it, dispose it (runSegment's order)
function segment(factory, guard, n) {
  const r = factory(fakeCanvas(), { palette: {} }, { renderer: 'gpu', qualityTier: 'medium' })
  if (r.kind === 'gpu') for (let i = 0; i < n; i++) r.render(player, () => false, 1, [], 1, {}, null)
  guard.note(r); r.dispose()
  return r
}
const planted = (count, armedAt = NOW - 1000) => JSON.stringify({ armedAt, count })

describe('the benchmark leaves the crash marker as it found it (H-CORE-1, E2E-1)', () => {
  it('a tripped crash loop: the GPU never starts, the marker is left exactly as it was (it used to be deleted)', () => {
    const store = memStore(); store.setItem(GPU_MARKER_KEY, planted(CRASH_LIMIT)); store.setItem.mockClear()
    const f = benchFactory(store), g = createMarkerGuard(() => store)
    const a = segment(f, g, 30), b = segment(f, g, 30)
    expect([a.kind, a.why, b.kind, b.why]).toEqual(['cpu', 'crash-loop', 'cpu', 'crash-loop'])
    expect(g.finish()).toBe('unchanged')
    expect(store.getItem(GPU_MARKER_KEY)).toBe(planted(CRASH_LIMIT))
    expect(store.setItem).not.toHaveBeenCalled(); expect(store.removeItem).not.toHaveBeenCalled()
  })
  it('a pre-existing count: healthy GPU runs clear it on the way (as in the game), and the end of the run puts it back exactly', () => {
    const store = memStore(); store.setItem(GPU_MARKER_KEY, planted(1))
    const f = benchFactory(store), g = createMarkerGuard(() => store)
    segment(f, g, CRASH_HEALTHY_FRAMES + 5)                                   // armed to 2, then cleared after the healthy frames
    expect(store.getItem(GPU_MARKER_KEY)).toBe(null)
    segment(f, g, 10)                                                          // armed 1, handed back (null) on dispose
    expect(g.finish()).toBe('restored')
    expect(store.getItem(GPU_MARKER_KEY)).toBe(planted(1))
  })
  it('no marker and clean GPU runs: nothing left behind, nothing written at the end', () => {
    const store = memStore()
    const f = benchFactory(store), g = createMarkerGuard(() => store)
    segment(f, g, 10); segment(f, g, CRASH_HEALTHY_FRAMES)
    store.setItem.mockClear(); store.removeItem.mockClear()
    expect(g.finish()).toBe('unchanged'); expect(store.getItem(GPU_MARKER_KEY)).toBe(null)
    expect(store.setItem).not.toHaveBeenCalled(); expect(store.removeItem).not.toHaveBeenCalled()
  })
  it('a runtime failure in the run (__failGl frame:20 in the page) is recorded and STAYS recorded (it used to be wiped)', () => {
    const store = memStore()
    const f = benchFactory(store, { failOn: (n) => (n === 20 ? new GlError('runtime', 'boom') : null) }), g = createMarkerGuard(() => store)
    const r = segment(f, g, 40)
    expect(r.failure).toEqual({ stage: 'runtime', persisted: true })
    const later = segment(f, g, 10)                                            // the next GPU config: this session stays on the CPU
    expect(later.kind).toBe('cpu')
    expect(g.finish()).toBe('kept-failure')
    expect(JSON.parse(store.getItem(GPU_MARKER_KEY))).toEqual({ armedAt: NOW, count: CRASH_LIMIT })
  })
  it('a creation failure (a shader that will not compile) is recorded and kept, even over a pre-existing count', () => {
    const store = memStore(); store.setItem(GPU_MARKER_KEY, planted(1))
    const f = benchFactory(store, { glThrows: new GlError('shader', 'post fragment shader failed to compile') }), g = createMarkerGuard(() => store)
    const r = segment(f, g, 0)
    expect(r.kind).toBe('cpu'); expect(r.failure).toEqual({ stage: 'creation', persisted: true })
    expect(g.finish()).toBe('kept-failure')
    expect(JSON.parse(store.getItem(GPU_MARKER_KEY)).count).toBe(CRASH_LIMIT)
  })
  it('a transient failure (a lost context) is not a recorded failure: the marker goes back to what the run found', () => {
    const store = memStore(); store.setItem(GPU_MARKER_KEY, planted(1))
    const f = benchFactory(store, { failOn: (n) => (n === 3 ? new GlError('context', 'lost') : null) }), g = createMarkerGuard(() => store)
    const r = segment(f, g, 10)
    expect(r.failure).toEqual({ stage: 'context', persisted: false })
    expect(g.finish()).toBe('unchanged'); expect(store.getItem(GPU_MARKER_KEY)).toBe(planted(1))      // the renderer already handed it back
  })
  it('a run that stops half way (the renderer still live): settling notes and disposes it, then restores', () => {
    const store = memStore()
    const f = benchFactory(store), g = createMarkerGuard(() => store)
    const r = f(fakeCanvas(), { palette: {} }, { renderer: 'gpu' }); r.render(player, () => false, 1, [], 1, {}, null)
    expect(JSON.parse(store.getItem(GPU_MARKER_KEY)).count).toBe(1)          // armed while it runs: a device that dies here is protected
    g.note(r); r.dispose()
    expect(g.finish()).toBe('unchanged'); expect(store.getItem(GPU_MARKER_KEY)).toBe(null)
    expect(g.finish()).toBe('unchanged')                                      // idempotent
  })
  it('no storage (private mode, a throwing getter): never throws', () => {
    const g = createMarkerGuard(() => { throw new Error('SecurityError') })
    expect(g.before).toBe(null); expect(() => g.finish()).not.toThrow()
    const s = { getItem: () => { throw new Error('x') }, setItem: () => { throw new Error('x') }, removeItem: () => { throw new Error('x') } }
    expect(createMarkerGuard(() => s).finish()).toBe('unchanged')
  })
  it('startBench wiring: the guard is taken before anything else, every renderer is noted before its dispose, and it settles on success AND on failure', () => {
    const b = src('src/renderer/gfx-bench.js')
    const run = b.slice(b.indexOf('async function run()'))
    expect(run.indexOf('createMarkerGuard(() => win.localStorage)')).toBeGreaterThan(0)
    expect(run.indexOf('createMarkerGuard(')).toBeLessThan(run.indexOf('await loadConfig()'))
    expect((run.match(/marker\.note\(r\); r\.dispose\(\)/g) || []).length).toBe(2)
    expect(run.match(/r\.dispose\(\)/g).length).toBe(2)                       // no dispose path that skips the note
    const ok = run.indexOf('rep.marker = settleMarker()'), bad = run.indexOf('} catch (e) {\n      settleMarker()'.replace(/\n/g, b.includes('\r\n') ? '\r\n' : '\n'))
    expect(ok).toBeGreaterThan(0); expect(bad).toBeGreaterThan(ok)
    expect(b).not.toMatch(/removeItem\(GPU_MARKER_KEY\)/)
  })
})

describe('the benchmark camera honours the in-game Reduce flicker setting too (H-CORE-6)', () => {
  it('OS query OR the stored pref; a missing or broken pref falls back to the OS query', () => {
    expect(benchReducedMotion(true, null)).toBe(true)
    expect(benchReducedMotion(false, JSON.stringify({ reduceFlicker: true }))).toBe(true)
    expect(benchReducedMotion(false, JSON.stringify({ reduceFlicker: false }))).toBe(false)
    expect(benchReducedMotion(true, JSON.stringify({ reduceFlicker: false }))).toBe(true)      // the OS setting always wins
    for (const s of [null, '', '{', 'null', '42', JSON.stringify({ reduceFlicker: 'yes' })]) expect(benchReducedMotion(false, s), String(s)).toBe(false)
  })
  it('reads the same key prefs.js writes, and only reads it', () => {
    expect(PREFS_KEY).toBe(/const KEY = '([^']+)'/.exec(src('src/renderer/prefs.js'))[1])
    const b = src('src/renderer/gfx-bench.js')
    expect(b).toMatch(/const reduced = benchReducedMotion\(/)
    expect(b).toMatch(/win\.localStorage\.getItem\(PREFS_KEY\)/)
  })
})
