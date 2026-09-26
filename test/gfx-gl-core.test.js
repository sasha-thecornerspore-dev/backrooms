// renderer.js selection + fallback logic against fake canvases and fake backends (no WebGL, no DOM): the GPU is chosen only when asked for and
// probed, any failure — creation, a runtime throw, a lost context, a slow verdict — swaps to the CPU in place and is remembered, the crash marker
// follows its lifecycle, and the harness's software-GL escape hatch exists only through renderOpts.
import { describe, it, expect, vi } from 'vitest'
// the harness-only hooks (allowSoftwareGl, __failGl, gpuValidate) are honoured only in a test run (see isTestRun in gfx-gl-util.js)
globalThis.__backroomsTestRun = true
import { createRendererWith, GPU_AUTO } from '../src/renderer/renderer.js'
import { CRASH_HEALTHY_FRAMES, CRASH_LIMIT } from '../src/renderer/gfx-quality.js'
import { GlError } from '../src/renderer/gfx-gl-util.js'

const MARKER = 'backrooms:gpu-marker'
const memStore = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), _m: m } }
const fakeCanvas = (id = 'c') => ({ id, width: 320, height: 180, style: {}, ownerDocument: { createElement: () => fakeCanvas('t') }, toDataURL: () => 'data:image/png;base64,CPU' })
const okProbe = { ok: true, webgl2: true, majorPerformanceCaveat: false, unmaskedRenderer: 'ANGLE (Fake GPU)', reason: 'ok' }

// a backend that records what it was asked to do; `failOn` = (frameIndex) => Error | null
function fakeBackend(kind, opts = {}) {
  const b = {
    kind, frames: 0, disposed: 0, args: [],
    render(...a) { b.frames++; b.args.push(a); const e = opts.failOn && opts.failOn(b.frames); if (e) throw e },
    dispose() { b.disposed++ },
    info: kind === 'gpu' ? { renderer: 'Fake', software: false, validation: 'off' } : undefined,
  }
  if (opts.capture) b.capture = opts.capture
  return b
}

function rig(over = {}) {
  const store = memStore()
  const made = { cpu: [], gl: [] }
  const deps = {
    storage: () => store,
    search: () => over.search || '',
    now: () => 1_000_000,
    warn: vi.fn(),
    probeGl: vi.fn(() => over.probe || okProbe),
    createCpu: vi.fn(() => { const b = fakeBackend('cpu'); made.cpu.push(b); return b }),
    createGl: vi.fn(() => { if (over.glThrows) throw over.glThrows; const b = fakeBackend('gpu', { failOn: over.failOn, capture: over.capture }); made.gl.push(b); return b }),
  }
  return { store, made, deps, create: createRendererWith(deps) }
}
const CFG = { palette: {} }

describe('selection', () => {
  it('auto stays CPU while GPU_AUTO is false', () => {
    expect(GPU_AUTO).toBe(false)
    const r = rig()
    const g = r.create(fakeCanvas(), CFG, { renderer: 'auto' })
    expect(g.kind).toBe('cpu'); expect(r.deps.createGl).not.toHaveBeenCalled(); expect(r.deps.probeGl).not.toHaveBeenCalled()
  })
  it('an explicit gpu pref reaches the GL backend and arms the crash marker before the first frame', () => {
    const r = rig()
    const g = r.create(fakeCanvas(), CFG, { renderer: 'gpu' })
    expect(g.kind).toBe('gpu'); expect(g.why).toBe('forced')
    expect(JSON.parse(r.store.getItem(MARKER)).count).toBe(1)
    expect(g.diagnostics()).toContain('kind=gpu')
  })
  it('?renderer=gpu selects it too, ?renderer=cpu and pref cpu never do', () => {
    expect(rig({ search: '?renderer=gpu' }).create(fakeCanvas(), CFG, {}).kind).toBe('gpu')
    const a = rig({ search: '?renderer=cpu' }); expect(a.create(fakeCanvas(), CFG, { renderer: 'gpu' }).kind).toBe('cpu'); expect(a.deps.createGl).not.toHaveBeenCalled()
    const b = rig(); const g = b.create(fakeCanvas(), CFG, { renderer: 'cpu' }); expect(g.kind).toBe('cpu'); expect(g.why).toBe('pref-cpu'); expect(b.deps.createGl).not.toHaveBeenCalled()
  })
  it('a tripped crash loop forces the CPU; ?renderer=gpu overrides it', () => {
    const r = rig(); r.store.setItem(MARKER, JSON.stringify({ armedAt: 1_000_000 - 1000, count: CRASH_LIMIT }))
    const g = r.create(fakeCanvas(), CFG, { renderer: 'gpu' })
    expect(g.kind).toBe('cpu'); expect(g.why).toBe('crash-loop')
    const r2 = rig({ search: '?renderer=gpu' }); r2.store.setItem(MARKER, JSON.stringify({ armedAt: 1_000_000 - 1000, count: CRASH_LIMIT }))
    expect(r2.create(fakeCanvas(), CFG, {}).kind).toBe('gpu')
  })
  it('software GL is refused unless the harness opts in through renderOpts.allowSoftwareGl', () => {
    const sw = { ok: false, webgl2: true, majorPerformanceCaveat: true, unmaskedRenderer: 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device))', reason: 'software-gl' }
    const a = rig({ probe: sw }); const g = a.create(fakeCanvas(), CFG, { renderer: 'gpu' })
    expect(g.kind).toBe('cpu'); expect(g.why).toBe('software-gl')
    expect(a.deps.probeGl.mock.calls[0][1]).toEqual({ allowSoftware: false })
    const b = rig({ probe: { ...sw, ok: true } }); const h = b.create(fakeCanvas(), CFG, { renderer: 'gpu', allowSoftwareGl: true })
    expect(h.kind).toBe('gpu'); expect(b.deps.probeGl.mock.calls[0][1]).toEqual({ allowSoftware: true })
    // a URL parameter cannot turn it on: only the options object the embedding code builds
    const c = rig({ probe: sw, search: '?allowSoftwareGl=1' }); expect(c.create(fakeCanvas(), CFG, { renderer: 'gpu' }).kind).toBe('cpu')
  })
  it('the title attract canvas is always the CPU renderer', () => {
    const r = rig({ search: '?renderer=gpu' })
    expect(r.create(fakeCanvas('attract'), CFG, { renderer: 'gpu' }).kind).toBe('cpu'); expect(r.deps.createGl).not.toHaveBeenCalled()
  })
})

describe('fallback', () => {
  it('a creation failure uses the CPU, writes the crash marker, and the next start skips the GPU', () => {
    const r = rig({ glThrows: new GlError('shader', 'no compile', 'ERROR: 0:1') })
    const g = r.create(fakeCanvas(), CFG, { renderer: 'gpu' })
    expect(g.kind).toBe('cpu'); expect(g.why).toBe('gpu-failed-creation')
    expect(JSON.parse(r.store.getItem(MARKER)).count).toBe(CRASH_LIMIT)
    expect(r.deps.warn).toHaveBeenCalled()
    g.render(1)
    expect(r.made.cpu[0].frames).toBe(1)
    const again = r.create(fakeCanvas(), CFG, { renderer: 'gpu' })     // a later level in the same session
    expect(again.kind).toBe('cpu'); expect(r.deps.createGl).toHaveBeenCalledTimes(1)
  })
  it('a runtime throw on frame N swaps to the CPU in place and the game keeps rendering', () => {
    const r = rig({ failOn: (n) => (n === 3 ? new GlError('frame', 'WebGL error INVALID_OPERATION on frame 3') : null) })
    const g = r.create(fakeCanvas(), CFG, { renderer: 'gpu' })
    const kinds = []
    for (let i = 1; i <= 6; i++) { g.render(i); kinds.push(g.kind) }
    expect(kinds).toEqual(['gpu', 'gpu', 'cpu', 'cpu', 'cpu', 'cpu'])
    expect(r.made.gl[0].disposed).toBe(1)                                // the GL backend was released
    expect(r.made.cpu[0].frames).toBe(4)                                 // frame 3 was redrawn on the CPU, then 4..6
    expect(r.made.cpu[0].args[0][0]).toBe(3)                             // with the same arguments the failed frame had
    expect(g.why).toBe('gpu-failed-runtime')
    expect(JSON.parse(r.store.getItem(MARKER)).count).toBe(CRASH_LIMIT)
  })
  it('the marker is cleared after CRASH_HEALTHY_FRAMES healthy frames, not before', () => {
    const r = rig(); const g = r.create(fakeCanvas(), CFG, { renderer: 'gpu' })
    for (let i = 1; i < CRASH_HEALTHY_FRAMES; i++) g.render(i)
    expect(r.store.getItem(MARKER)).not.toBeNull()
    g.render(0)
    expect(r.store.getItem(MARKER)).toBeNull()
  })
  it('a lost context is session-only: CPU from then on, but nothing persisted', () => {
    const r = rig({ failOn: (n) => (n === 2 ? new GlError('context', 'the WebGL context was lost') : null) })
    const g = r.create(fakeCanvas(), CFG, { renderer: 'gpu' })
    g.render(1); g.render(2)
    expect(g.kind).toBe('cpu'); expect(g.why).toBe('gpu-failed-context')
    expect(r.store.getItem(MARKER)).toBeNull()                            // the marker this instance armed was put back
    const next = r.create(fakeCanvas(), CFG, { renderer: 'gpu' })         // next level, same session
    expect(next.kind).toBe('cpu'); expect(r.deps.createGl).toHaveBeenCalledTimes(1)
    // ...but a fresh page load (a new factory: no session memory) tries the GPU again
    expect(rig().create(fakeCanvas(), CFG, { renderer: 'gpu' }).kind).toBe('gpu')
  })
  it('a validation failure is a persisted failure', () => {
    const r = rig({ failOn: (n) => (n === 4 ? new GlError('validate', 'the GPU frame does not match') : null) })
    const g = r.create(fakeCanvas(), CFG, { renderer: 'gpu' })
    for (let i = 1; i <= 5; i++) g.render(i)
    expect(g.kind).toBe('cpu'); expect(JSON.parse(r.store.getItem(MARKER)).count).toBe(CRASH_LIMIT)
  })
})

describe('capture and dispose', () => {
  it('capture goes through the GL backend on the GPU path and through #c on the CPU path', () => {
    const r = rig({ capture: () => 'data:image/png;base64,GPU' })
    expect(r.create(fakeCanvas(), CFG, { renderer: 'gpu' }).capture()).toBe('data:image/png;base64,GPU')
    expect(rig().create(fakeCanvas(), CFG, { renderer: 'cpu' }).capture()).toBe('data:image/png;base64,CPU')
  })
  it('a capture failure swaps to the CPU and returns the CPU frame rather than throwing', () => {
    const r = rig({ capture: () => { throw new GlError('context', 'lost') } })
    const g = r.create(fakeCanvas(), CFG, { renderer: 'gpu' })
    expect(g.capture()).toBe('data:image/png;base64,CPU'); expect(g.kind).toBe('cpu')       // the CPU draws the frame, #c is read
    g.render(1); expect(r.made.cpu[0].frames).toBe(1)
  })
  it('dispose is idempotent, releases the backend once, hands the crash breaker its state back, and stops rendering', () => {
    const r = rig(); r.store.setItem(MARKER, JSON.stringify({ armedAt: 1_000_000 - 5, count: 1 }))
    const g = r.create(fakeCanvas(), CFG, { renderer: 'gpu' })
    expect(JSON.parse(r.store.getItem(MARKER)).count).toBe(2)
    g.dispose(); g.dispose()
    expect(r.made.gl[0].disposed).toBe(1)
    expect(JSON.parse(r.store.getItem(MARKER)).count).toBe(1)              // a level change before the healthy frames is not a crash
    g.render(1); expect(r.made.gl[0].frames).toBe(0)
  })
  it('many level transitions dispose every previous renderer before the next is created (no live-context leak)', () => {
    const r = rig(); const live = () => r.made.gl.filter((b) => b.disposed === 0).length
    let g = null, maxLive = 0
    for (let i = 0; i < 40; i++) {
      if (g) g.dispose()                                                    // game.js buildLevel does exactly this first
      g = r.create(fakeCanvas(), CFG, { renderer: 'gpu' }); g.render(i)
      maxLive = Math.max(maxLive, live())
    }
    expect(maxLive).toBe(1)
    for (let i = 0; i < CRASH_HEALTHY_FRAMES; i++) g.render(i)
    expect(r.store.getItem(MARKER)).toBeNull()
  })
})

describe('health monitor wiring', () => {
  const slowFeed = (g, secs, ms = 80) => { for (let t = 0; t < secs * 1000; t += ms) g.noteFrame(ms, { budgetMs: 16.7, atFloor: true }) }
  it('an explicit gpu choice is downgraded after sustained slow frames at the minimum scale, for the session only', () => {
    const r = rig(); const g = r.create(fakeCanvas(), CFG, { renderer: 'gpu' })
    slowFeed(g, 20)
    expect(g.kind).toBe('cpu'); expect(g.why).toBe('gpu-failed-health')
    expect(r.store.getItem(MARKER)).toBeNull()
    expect(r.create(fakeCanvas(), CFG, { renderer: 'gpu' }).kind).toBe('cpu')
  })
  it('does nothing while the resolution can still drop, or when the monitor is off', () => {
    const g = rig().create(fakeCanvas(), CFG, { renderer: 'gpu' })
    for (let t = 0; t < 20000; t += 80) g.noteFrame(80, { budgetMs: 16.7, atFloor: false })
    expect(g.kind).toBe('gpu')
    const h = rig().create(fakeCanvas(), CFG, { renderer: 'gpu', gpuHealth: false }); slowFeed(h, 20); expect(h.kind).toBe('gpu')
  })
  it('noteFrame is a no-op on the CPU path', () => {
    const g = rig().create(fakeCanvas(), CFG, { renderer: 'cpu' }); expect(() => slowFeed(g, 20)).not.toThrow(); expect(g.kind).toBe('cpu')
  })
})
