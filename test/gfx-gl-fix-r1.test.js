// Fixer R1 (core, lifecycle, validation): exception-safe creation, context-loss classification, probe release / once-per-session, the harness gate,
// the synthetic first-frame validation and its tighter criteria, swap-to-CPU safety, the crash marker on a clean unload. Fakes only, no real GL.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createGlRenderer, GpuUnavailable } from '../src/renderer/gfx-gl.js'
import { createRendererWith } from '../src/renderer/renderer.js'
import { GlError, probeGl, isTestRun, harnessOpt, GL_POWER_PREFERENCE } from '../src/renderer/gfx-gl-util.js'
import {
  blockMeans, compareFrames, syntheticFrame, runFirstFrameValidation, validationWanted, validationCacheKey, resetSessionValidation, sessionValidated,
  readValidationCache, writeValidationCache, VALIDATION_KEYS_KEPT,
  GPU_BUILD_ID, VALIDATION_GRID, VALIDATION_LIMITS,
} from '../src/renderer/gfx-gl-g4-validate.js'
import { CRASH_LIMIT, CRASH_HEALTHY_FRAMES } from '../src/renderer/gfx-quality.js'
import { DEFAULT_CONFIG } from '../src/renderer/world.js'
import { levelConfig } from '../src/renderer/levels.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const src = (f) => fs.readFileSync(path.join(here, '..', f), 'utf8').replace(/\r\n/g, '\n')

const setTestRun = (v) => { if (v) globalThis.__backroomsTestRun = true; else delete globalThis.__backroomsTestRun }
beforeEach(() => { setTestRun(true); resetSessionValidation() })
afterEach(() => { setTestRun(false) })

// ── fakes (the same idea as test/gfx-gl-core-gl.test.js) ──
function fakeGl(state) {
  const t = {
    NO_ERROR: 0, INVALID_OPERATION: 0x502, CONTEXT_LOST_WEBGL: 0x9242, isContextLost: () => state.lost, getError: () => (state.getError ? state.getError() : 0),
    getExtension: (n) => (n === 'WEBGL_lose_context' ? { loseContext() { state.lost = true; state.loseCalls++ } } : null),
    readPixels: (x, y, w, h, f, ty, buf) => { if (state.pixels) buf.set(state.pixels(w, h)) },
    createVertexArray: () => { if (state.triThrows) throw new Error('vao boom'); return {} },
  }
  return new Proxy(t, { get(o, k) { if (k in o) return o[k]; if (typeof k === 'string' && /^[A-Z][A-Z0-9_]*$/.test(k)) return k.length + 1000; return () => null } })
}
function rig(over = {}) {
  const state = { lost: false, loseCalls: 0, contexts: 0, gl: null, pixels: null, cpuPixels: null, passLog: [], getError: null, triThrows: false, overlayDraws: 0 }
  state.gl = fakeGl(state)
  const doc = {
    hidden: false,
    createElement() {
      const listeners = {}
      const c = {
        width: 0, height: 0, style: {}, dataset: {}, parentNode: null, ownerDocument: doc, listeners,
        setAttribute() {}, addEventListener(n, f) { (listeners[n] = listeners[n] || []).push(f) },
        remove() { if (c.parentNode) { c.parentNode.children = c.parentNode.children.filter((x) => x !== c); c.parentNode = null } },
        getContext(kind) {
          if (kind === 'webgl2') { state.contexts++; return state.gl }
          return { getImageData: (x, y, w, h) => ({ data: state.cpuPixels ? state.cpuPixels(w, h) : new Uint8ClampedArray(w * h * 4) }), drawImage: (im) => { if (im && im.isOverlay) state.overlayDraws++ } }
        },
        toDataURL: () => 'data:image/png;base64,X',
      }
      return c
    },
  }
  const parent = { children: [], insertBefore(n, ref) { n.parentNode = parent; const i = ref ? parent.children.indexOf(ref) : parent.children.length; parent.children.splice(i < 0 ? parent.children.length : i, 0, n) } }
  const canvas = doc.createElement(); canvas.width = 128; canvas.height = 72; canvas.parentNode = over.detached ? null : parent; if (!over.detached) parent.children.push(canvas)
  const mkPass = (name, extra = {}) => () => ({ render: vi.fn(() => ({})), dispose: vi.fn(() => state.passLog.push(name)), ...extra })
  const store = new Map()
  const deps = {
    probeGl: vi.fn(() => ({ ok: true, webgl2: true, majorPerformanceCaveat: false, unmaskedRenderer: 'ANGLE (Fake)', caps: {} })),
    buildTextures: () => ({}), createLight: () => ({ enabled: false }),
    storage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, v) },
    passes: { world: mkPass('world'), sprites: mkPass('sprites'), post: mkPass('post') },
    createCpuRenderer: vi.fn(() => ({ render: vi.fn(), dispose: vi.fn() })),
    ...over.deps,
  }
  return { state, canvas, parent, deps, store, doc, mkPass, make: (ropts = {}) => createGlRenderer(canvas, levelConfig(DEFAULT_CONFIG, 0), { qualityTier: 'low', gpuValidate: false, ...ropts }, {}, deps) }
}
const player = { x: 5.5, y: 5.5, angle: 0, bobOffset: 0 }
const frame = (r) => r.render(player, () => false, 1, [], 1, {}, null)
const catchErr = (f) => { try { f() } catch (e) { return e } return null }

// ════════════════════ LC-2 / LC-12: exception-safe creation ════════════════════
describe('createGlRenderer creation failures release everything (LC-2, LC-12)', () => {
  const clean = (r) => { expect(r.parent.children).toEqual([r.canvas]); expect(r.state.loseCalls).toBe(1) }
  it('buildTextures throwing leaves no sibling canvas and releases the context', () => {
    const r = rig({ deps: { buildTextures: () => { throw new Error('tex boom') } } })
    const e = catchErr(() => r.make()); expect(e).toBeInstanceOf(GlError); expect(e.stage).toBe('init'); clean(r)
  })
  it('createLight throwing, and the fullscreen triangle failing, do the same', () => {
    const a = rig({ deps: { createLight: () => { throw new Error('light boom') } } }); expect(catchErr(() => a.make())).toBeInstanceOf(GlError); clean(a)
    const b = rig(); b.state.triThrows = true; expect(catchErr(() => b.make())).toBeInstanceOf(GlError); clean(b)
  })
  it('a pass that throws releases the context and disposes the earlier passes', () => {
    const r = rig(); r.deps.passes = { world: r.mkPass('world'), sprites: () => { throw new Error('boom') }, post: r.mkPass('post') }
    const e = catchErr(() => r.make()); expect(e.stage).toBe('init'); clean(r); expect(r.state.passLog).toEqual(['post', 'world'])      // post is created first (it only queues programs), then world; both released
  })
  it('a pass throwing a GlError keeps its stage (a shader link failure is a persistent failure)', () => {
    const r = rig(); r.deps.passes = { ...r.deps.passes, sprites: () => { throw new GlError('program', 'failed to link', 'log') } }
    expect(catchErr(() => r.make()).stage).toBe('program'); clean(r)
  })
  it('a canvas with no parent is refused with GpuUnavailable(no-parent) before any context exists', () => {
    const r = rig({ detached: true })
    const e = catchErr(() => r.make()); expect(e).toBeInstanceOf(GpuUnavailable); expect(e.reason).toBe('no-parent'); expect(r.state.contexts).toBe(0)
  })
  it('a context refused by the browser leaves no canvas behind', () => {
    const r = rig(); r.state.gl = null
    expect(catchErr(() => r.make())).toBeInstanceOf(GpuUnavailable); expect(r.parent.children).toEqual([r.canvas])
  })
  it("the real context's renderer string is checked: software GL behind a hardware-looking probe is refused, and keys the cache", () => {
    const r = rig(); r.state.gl = new Proxy(r.state.gl, { get(o, k) { if (k === 'getExtension') return (n) => (n === 'WEBGL_debug_renderer_info' ? { UNMASKED_RENDERER_WEBGL: 7 } : o.getExtension(n)); if (k === 'getParameter') return (p) => (p === 7 ? 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device))' : null); return o[k] } })
    const e = catchErr(() => r.make()); expect(e).toBeInstanceOf(GpuUnavailable); expect(e.reason).toBe('software-gl'); expect(r.parent.children).toEqual([r.canvas])
  })
})

// ════════════════════ LC-3: context loss is session-only, wherever it surfaces ════════════════════
describe('a lost context is reported as stage "context" wherever it surfaces (LC-3)', () => {
  it('lost during creation: a shader failure becomes GlError("context")', () => {
    const r = rig(); r.deps.passes = { ...r.deps.passes, world: () => { r.state.lost = true; throw new GlError('shader', 'createShader returned null (the context is lost)') } }
    const e = catchErr(() => r.make()); expect(e.stage).toBe('context'); expect(r.parent.children).toEqual([r.canvas])
  })
  it('CONTEXT_LOST_WEBGL from getError on the first frames is context, not frame', () => {
    const r = rig(); const g = r.make(); frame(g)
    r.state.getError = () => { r.state.lost = true; return 0x9242 }
    const e = catchErr(() => frame(g)); expect(e).toBeInstanceOf(GlError); expect(e.stage).toBe('context')
  })
  it('a genuine GL error on the first frames stays stage "frame" (persistent)', () => {
    const r = rig(); const g = r.make(); r.state.getError = () => 0x502
    expect(catchErr(() => frame(g)).stage).toBe('frame')
  })
  it('a pass throwing while the context is lost is context', () => {
    const r = rig(); r.deps.passes = { ...r.deps.passes, post: () => ({ render: () => { r.state.lost = true; throw new GlError('shader', 'lazy compile: context lost') }, dispose() {} }) }
    const g = r.make(); expect(catchErr(() => frame(g)).stage).toBe('context')
  })
  it('the validation readback of a lost context (zeros) is context, not validate', () => {
    const r = rig(); r.state.cpuPixels = (w, h) => picture(w, h)
    r.state.pixels = (w, h) => { r.state.lost = true; return new Uint8Array(w * h * 4) }
    const g = r.make({ gpuValidate: true }); for (let i = 0; i < 3; i++) frame(g)
    expect(catchErr(() => frame(g)).stage).toBe('context')
  })
  it('renderer.js: a loss during the first frames is not persisted, and warns once', () => {
    const store = new Map(), warn = vi.fn()
    const lostErr = new GlError('context', 'the WebGL context was lost')
    const gl = { kind: 'gpu', frames: 0, lost: true, render() { throw lostErr }, dispose: vi.fn() }
    const create = createRendererWith({
      storage: () => ({ getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) }),
      search: () => '', now: () => 5, warn, probeGl: () => okProbe, createGl: () => gl, createCpu: () => ({ kind: 'cpu', render() {}, dispose() {} }), onPageHide: () => () => {},
    })
    const g = create(fakeCanvas(), { palette: {} }, { renderer: 'gpu' }); g.render(1)
    expect(g.kind).toBe('cpu'); expect(g.why).toBe('gpu-failed-context'); expect(store.get('backrooms:gpu-marker')).toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(1); expect(String(warn.mock.calls[0][0])).toMatch(/context was lost.*CPU renderer/)
  })
  it('renderer.js: a backend whose `lost` flag is set is transient even if the error names another stage', () => {
    const store = new Map()
    const gl = { kind: 'gpu', lost: true, render() { throw new GlError('validate', 'zeros') }, dispose() {} }
    const create = createRendererWith({
      storage: () => ({ getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) }),
      search: () => '', now: () => 5, warn() {}, probeGl: () => okProbe, createGl: () => gl, createCpu: () => ({ render() {}, dispose() {} }), onPageHide: () => () => {},
    })
    const g = create(fakeCanvas(), { palette: {} }, { renderer: 'gpu' }); g.render(1)
    expect(g.why).toBe('gpu-failed-context'); expect(store.get('backrooms:gpu-marker')).toBeUndefined()
  })
})

// ════════════════════ LC-1 / P4: the probe releases its context and runs once per session ════════════════════
describe('probeGl and the once-per-session probe (LC-1, P4)', () => {
  const probeRig = ({ strictOk = true, laxOk = true, lostFlag = false, throwOn = '' } = {}) => {
    const log = { made: 0, lost: 0, opts: [] }
    const mkGl = () => ({
      isContextLost: () => lostFlag, getParameter: () => 8, RENDERER: 1, MAX_TEXTURE_SIZE: 2, MAX_ARRAY_TEXTURE_LAYERS: 3,
      getExtension: (n) => { if (throwOn === n) throw new Error('ext boom'); return n === 'WEBGL_lose_context' ? { loseContext() { log.lost++ } } : null },
    })
    let n = 0
    const makeCanvas = () => ({ width: 0, height: 0, getContext: (k, o) => { log.opts.push(o); const strict = n++ === 0; if (strict ? !strictOk : !laxOk) return null; log.made++; return mkGl() } })
    return { makeCanvas, log }
  }
  it('releases the context on the ok path', () => { const { makeCanvas, log } = probeRig(); expect(probeGl(makeCanvas).ok).toBe(true); expect(log.lost).toBe(log.made) })
  it('releases the context on the software-gl path (strict refused, lax works)', () => {
    const { makeCanvas, log } = probeRig({ strictOk: false }); const p = probeGl(makeCanvas)
    expect(p.reason).toBe('software-gl'); expect(p.ok).toBe(false); expect(log.made).toBe(1); expect(log.lost).toBe(1)
  })
  it('releases the context on the context-lost path and when a getter throws', () => {
    const a = probeRig({ lostFlag: true }); expect(probeGl(a.makeCanvas).reason).toBe('context-lost'); expect(a.log.lost).toBe(a.log.made)
    const b = probeRig({ throwOn: 'EXT_color_buffer_float' }); const p = probeGl(b.makeCanvas); expect(p.ok).toBe(false); expect(b.log.lost).toBe(b.log.made)
  })
  it('asks the probe context for the same powerPreference the real one uses', () => {
    const { makeCanvas, log } = probeRig(); probeGl(makeCanvas)
    expect(GL_POWER_PREFERENCE).toBe('high-performance'); expect(log.opts[0].powerPreference).toBe(GL_POWER_PREFERENCE)
    expect(src('src/renderer/gfx-gl.js')).toContain('powerPreference: GL_POWER_PREFERENCE')
  })
  it('renderer.js probes once per session and hands the probe to createGl', () => {
    const probeGlFn = vi.fn(() => okProbe), createGl = vi.fn(() => ({ kind: 'gpu', render() {}, dispose() {} }))
    const create = createRendererWith({ storage: () => null, search: () => '', now: () => 5, warn() {}, probeGl: probeGlFn, createGl, createCpu: () => ({ render() {}, dispose() {} }), onPageHide: () => () => {} })
    for (let i = 0; i < 5; i++) create(fakeCanvas(), { palette: {} }, { renderer: 'gpu' }).dispose()
    expect(probeGlFn).toHaveBeenCalledTimes(1)
    expect(createGl.mock.calls[0][4].probe).toBe(okProbe)
  })
  it('a software-gl verdict is remembered too (no context per level start); a lost probe is retried next level', () => {
    const sw = { ok: false, webgl2: true, majorPerformanceCaveat: true, unmaskedRenderer: 'SwiftShader', reason: 'software-gl' }
    const p1 = vi.fn(() => sw)
    const c1 = createRendererWith({ storage: () => null, search: () => '', now: () => 5, warn() {}, probeGl: p1, createGl: vi.fn(), createCpu: () => ({ render() {}, dispose() {} }), onPageHide: () => () => {} })
    for (let i = 0; i < 4; i++) expect(c1(fakeCanvas(), { palette: {} }, { renderer: 'gpu' }).kind).toBe('cpu')
    expect(p1).toHaveBeenCalledTimes(1)
    const p2 = vi.fn(() => ({ ok: false, webgl2: true, reason: 'context-lost', majorPerformanceCaveat: false }))
    const c2 = createRendererWith({ storage: () => null, search: () => '', now: () => 5, warn() {}, probeGl: p2, createGl: vi.fn(), createCpu: () => ({ render() {}, dispose() {} }), onPageHide: () => () => {} })
    for (let i = 0; i < 3; i++) c2(fakeCanvas(), { palette: {} }, { renderer: 'gpu' })
    expect(p2).toHaveBeenCalledTimes(3)
  })
  it('createGlRenderer uses a handed-in probe and does not probe again', () => {
    const r = rig(); const probe = { ok: true, webgl2: true, majorPerformanceCaveat: false, unmaskedRenderer: 'ANGLE (Handed)', caps: {} }
    r.deps.probe = probe; r.make(); expect(r.deps.probeGl).not.toHaveBeenCalled()
  })
})

// ════════════════════ LC-10 / P6: the harness gate ════════════════════
describe('software GL and the fail hooks need the test-run marker (LC-10, P6)', () => {
  it('isTestRun / harnessOpt read only globalThis.__backroomsTestRun === true', () => {
    setTestRun(false); expect(isTestRun()).toBe(false); expect(harnessOpt({ allowSoftwareGl: true }, 'allowSoftwareGl')).toBeUndefined()
    globalThis.__backroomsTestRun = 'yes'; expect(isTestRun()).toBe(false)
    setTestRun(true); expect(isTestRun()).toBe(true); expect(harnessOpt({ a: 1 }, 'a')).toBe(1)
  })
  it('createGlRenderer ignores __failGl outside a test run', () => {
    setTestRun(false)
    const r = rig(); expect(() => r.make({ __failGl: 'create' })).not.toThrow()
    const g = rig().make({ __failGl: 'frame' }); expect(() => frame(g)).not.toThrow()
  })
  it('createGlRenderer ignores allowSoftwareGl outside a test run (the real context is asked to fail on a caveat)', () => {
    setTestRun(false)
    const seen = []; const r = rig(); const cv = r.doc.createElement; const orig = r.doc.createElement
    r.doc.createElement = function () { const c = orig.call(r.doc); const g = c.getContext; c.getContext = (k, o) => { if (k === 'webgl2') seen.push(o); return g(k, o) }; return c }
    r.make({ allowSoftwareGl: true }); expect(seen.at(-1).failIfMajorPerformanceCaveat).toBe(true)
    setTestRun(true); r.make({ allowSoftwareGl: true }); expect(seen.at(-1).failIfMajorPerformanceCaveat).toBe(false)
    void cv
  })
  it('gpuValidate:false in the options is ignored outside a test run (validation still runs)', () => {
    setTestRun(false)
    const r = rig(); const g = r.make({ gpuValidate: false }); expect(g.info.validation).toBe('pending')
  })
  it('renderer.js: allowSoftwareGl reaches the probe and pickRenderer only in a test run', () => {
    const sw = { ok: true, webgl2: true, majorPerformanceCaveat: true, unmaskedRenderer: 'ANGLE (SwiftShader)', reason: 'software-allowed' }
    const mk = () => { const probeGlFn = vi.fn(() => sw); return { probeGlFn, create: createRendererWith({ storage: () => null, search: () => '', now: () => 5, warn() {}, probeGl: probeGlFn, createGl: () => ({ kind: 'gpu', render() {}, dispose() {} }), createCpu: () => ({ render() {}, dispose() {} }), onPageHide: () => () => {} }) } }
    setTestRun(false); const a = mk(); const ga = a.create(fakeCanvas(), { palette: {} }, { renderer: 'gpu', allowSoftwareGl: true })
    expect(ga.kind).toBe('cpu'); expect(ga.why).toBe('software-gl'); expect(a.probeGlFn.mock.calls[0][1]).toEqual({ allowSoftware: false })
    setTestRun(true); const b = mk(); expect(b.create(fakeCanvas(), { palette: {} }, { renderer: 'gpu', allowSoftwareGl: true }).kind).toBe('gpu')
  })
  it('game.js reads the __backroomsRenderOpts hook only under the marker; the harness and page.cjs set the marker', () => {
    expect(src('src/renderer/game.js')).toMatch(/__backroomsRenderOpts[^\n]*\n?[^\n]*__backroomsTestRun === true[^\n]*Object\.assign\(renderOpts, dbg\)|__backroomsTestRun === true\) Object\.assign\(renderOpts, dbg\)/)
    expect(src('tools/gfx/page.cjs')).toContain('window.__backroomsTestRun = true; window.__backroomsRenderOpts')
    expect(src('tools/gfx/harness.html')).toContain('window.__backroomsTestRun = true')
  })
})

// ════════════════════ SH-01 / LC-4: the tighter validation criteria ════════════════════
// a small "corridor with a prop" picture on the 64 x 36 grid
const GW = VALIDATION_GRID.w, GH = VALIDATION_GRID.h
function picture(w, h, f) {
  const fn = f || ((x, y) => (y < h * 0.3 ? [150, 140, 90] : y > h * 0.7 ? [60, 45, 25] : (x > w * 0.45 && x < w * 0.6 ? [190, 175, 120] : [110, 95, 55])))
  const d = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const [r, g, b] = fn(x, y), o = (y * w + x) * 4; d[o] = r; d[o + 1] = g; d[o + 2] = b; d[o + 3] = 255 }
  return d
}
const W = 128, H = 72
const grid = (f) => blockMeans(picture(W, H, f), W, H, GW, GH, false)
const sceneFn = (x, y) => (y < H * 0.3 ? [150, 140, 90] : y > H * 0.7 ? [60, 45, 25] : (x > W * 0.45 && x < W * 0.6 ? [190, 175, 120] : (x > W * 0.72 && x < W * 0.88 && y > H * 0.4 ? [40, 60, 90] : [110, 95, 55])))
describe('compareFrames: the per-block maximum, dark frames, flips and swaps (SH-01, LC-4)', () => {
  const ref = grid(sceneFn)
  it('accepts the same picture and a hair-different render', () => {
    expect(compareFrames(grid(sceneFn), ref).ok).toBe(true)
    expect(compareFrames(grid((x, y) => sceneFn(x, y).map((v) => v * 0.98 + 1)), ref).ok).toBe(true)
  })
  it('a sprite-sized hole (a missing sprite pass) fails on the worst block only', () => {
    const hole = (x, y) => ((x > 60 && x < 72 && y > 30 && y < 50) ? [60, 45, 25] : sceneFn(x, y))      // ~0.5% of the frame: mean, block mean and corr barely move
    const r = compareFrames(grid(hole), ref)
    expect(r.reasons).toContain('max-block')
    expect(r.meanAbs).toBeLessThan(VALIDATION_LIMITS.blockDiff)                        // the whole-frame numbers barely move
    expect(r.maxBlock).toBeGreaterThan(VALIDATION_LIMITS.maxBlock)
  })
  it('a vertical flip, a mirror, an R/B swap, a dark and an over-exposed frame all fail — including on a dim (dark level) frame', () => {
    const dim = (x, y) => sceneFn(x, y).map((v) => v * 0.22), dref = grid(dim)
    for (const [name, r0] of [['bright', ref], ['dim', dref]]) {
      const f = (fn) => (name === 'dim' ? (x, y) => fn(x, y).map((v) => v * 0.22) : fn)
      expect(compareFrames(grid(f((x, y) => sceneFn(x, H - 1 - y))), r0).ok, `flip ${name}`).toBe(false)
      expect(compareFrames(grid(f((x, y) => sceneFn(W - 1 - x, y))), r0).ok, `mirror ${name}`).toBe(false)
      expect(compareFrames(grid(f((x, y) => sceneFn(x, y).slice().reverse())), r0).ok, `swap ${name}`).toBe(false)
      expect(compareFrames(grid(f((x, y) => sceneFn(x, y).map((v) => v * 0.5))), r0).ok, `dark ${name}`).toBe(false)
      expect(compareFrames(grid(f((x, y) => sceneFn(x, y).map((v) => Math.min(255, v * 1.6)))), r0).ok, `bright ${name}`).toBe(false)
    }
  })
  it('an all-black GPU frame fails on a dim but not black CPU frame (the old flat rule missed it)', () => {
    const dim = grid((x, y) => [8 + (x > 64 ? 3 : 0), 7, 5])                       // cpuStd < 0.02, mean below the old 0.14 limits
    const r = compareFrames(grid(() => [0, 0, 0]), dim)
    expect(r.informative).toBe(true); expect(r.ok).toBe(false); expect(r.reasons).toEqual(expect.arrayContaining(['dark']))
  })
  it('a black CPU reference is uninformative (deferred), but a bright GPU frame against it still fails', () => {
    const black = grid(() => [0, 0, 0])
    const r = compareFrames(grid(() => [1, 1, 1]), black); expect(r.informative).toBe(false); expect(r.ok).toBe(true)
    expect(compareFrames(grid(() => [200, 200, 200]), black).ok).toBe(false)
  })
})

describe('runFirstFrameValidation: deferral, the session memory and the cache (LC-5, P3)', () => {
  const mem = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, v) } }
  const frames = (g, c) => ({ readGpu: () => ({ data: g, w: W, h: H, flipY: false }), renderCpu: () => ({ data: c, w: W, h: H }) })
  it('an uninformative reference returns deferred and records nothing', () => {
    const st = mem(); const black = picture(W, H, () => [0, 0, 0])
    const r = runFirstFrameValidation({ ...frames(black, black), storage: st, key: 'k' })
    expect(r.deferred).toBe(true); expect(st.getItem('backrooms:gpu-validated')).toBeNull(); expect(sessionValidated('k')).toBe(false)
  })
  it('a pass is remembered in memory, so blocked storage validates once per page session', () => {
    const p = picture(W, H)
    expect(runFirstFrameValidation({ ...frames(p, p), storage: null, key: 'dev|m2' }).deferred).toBe(false)
    expect(sessionValidated('dev|m2')).toBe(true)
    expect(validationWanted({ ropts: {}, allowSoftware: false, storage: null, key: 'dev|m2' })).toBe(false)
    expect(validationWanted({ ropts: { gpuValidate: true }, allowSoftware: false, storage: null, key: 'dev|m2' })).toBe(true)
  })
  it('createGlRenderer with unavailable localStorage validates on the first renderer only', () => {
    const r = rig({ deps: { storage: null } }); r.state.pixels = (w, h) => flipRows(picture(w, h), w, h); r.state.cpuPixels = (w, h) => picture(w, h)
    const a = r.make({ gpuValidate: undefined }); for (let i = 0; i < 5; i++) frame(a)
    expect(a.info.validation).toBe('passed'); expect(r.deps.createCpuRenderer).toHaveBeenCalledTimes(1)
    const b = r.make({ gpuValidate: undefined }); expect(b.info.validation).toBe('cached'); for (let i = 0; i < 6; i++) frame(b)
    expect(r.deps.createCpuRenderer).toHaveBeenCalledTimes(1)
  })
  it('the device cache keeps the last few keys: alternating GPUs do not re-validate', () => {
    const st = mem(); const ks = ['iGPU|m2-2', 'dGPU|m2-2']
    ks.forEach((k) => runFirstFrameValidation({ readGpu: () => ({ data: picture(W, H), w: W, h: H }), renderCpu: () => ({ data: picture(W, H), w: W, h: H }), storage: st, key: k }))
    resetSessionValidation()
    expect(readValidationCache(st, 'iGPU|m2-2')).toBe(true); expect(readValidationCache(st, 'dGPU|m2-2')).toBe(true); expect(readValidationCache(st, 'other|m2-2')).toBe(false)
    for (let i = 0; i < 6; i++) writeValidationCache(st, 'gpu' + i + '|m2-2')
    expect(JSON.parse(st.getItem('backrooms:gpu-validated')).keys.length).toBe(VALIDATION_KEYS_KEPT); expect(readValidationCache(st, 'iGPU|m2-2')).toBe(false)
  })
  it('the build id was bumped', () => { expect(GPU_BUILD_ID).not.toBe('m2-1'); expect(validationCacheKey('X', GPU_BUILD_ID)).toContain(GPU_BUILD_ID) })
})
const flipRows = (d, w, h) => { const o = new Uint8ClampedArray(d.length); for (let y = 0; y < h; y++) o.set(d.subarray(y * w * 4, (y + 1) * w * 4), (h - 1 - y) * w * 4); return o }

describe('the synthetic validation frame (SH-01)', () => {
  // a 12 x 9 room with a pillar; the wall test is the "real" one
  const room = (wx, wy) => { const x = Math.floor(wx), y = Math.floor(wy); return x < 0 || y < 0 || x >= 12 || y >= 9 || (x === 5 && y === 4) }
  it('puts the camera in the open, turned to the most open direction, with a prop, a note and an npc a few cells ahead, flashlight on', () => {
    const s = syntheticFrame(2.5, 4.5, room)
    expect(s.lights).toEqual({ flashlight: true }); expect(s.entities.map((e) => e.kind)).toEqual(['prop', 'note', 'npc'])
    expect(s.isWall).toBe(room)                                              // the REAL wall test: the light model's occupancy cache must not be poisoned
    expect(room(s.player.x, s.player.y)).toBe(false)
    for (const e of s.entities) {
      const d = Math.hypot(e.x - s.player.x, e.y - s.player.y); expect(d).toBeGreaterThan(1.4); expect(d).toBeLessThan(8); expect(room(e.x, e.y)).toBe(false)
      expect(Math.abs(Math.atan2(e.y - s.player.y, e.x - s.player.x) - s.player.angle)).toBeLessThan(0.4)     // in front of the camera
    }
    expect(s.entities.find((e) => e.kind === 'npc').name).toBeUndefined()      // no nameplate: it is a 2D-overlay item on the GPU, not in the read-back
    // deterministic: the same world and start give the same pose
    expect(syntheticFrame(2.5, 4.5, room).player).toEqual(s.player)
  })
  it('a cramped spot and a walled-in start still give a frame (never throw)', () => {
    const closet = (wx, wy) => { const x = Math.floor(wx), y = Math.floor(wy); return x < 0 || y < 0 || x >= 2 || y >= 1 }
    expect(() => syntheticFrame(0.5, 0.5, closet)).not.toThrow()
    expect(() => syntheticFrame(0.5, 0.5, () => true)).not.toThrow()
    expect(syntheticFrame(3, 3).entities.length).toBeGreaterThan(0)              // no wall test at all (tests / fakes)
  })
  it('createGlRenderer draws it (not the on-screen frame) for the validation, with the sprite entities and at the small size', () => {
    const r = rig(); const seen = []
    r.deps.passes = { world: r.mkPass('world'), post: r.mkPass('post'), sprites: () => ({ render: vi.fn((fs, ents) => { seen.push({ ents, w: fs.OW, h: fs.OH, opts: fs.opts, t: fs.t }); return {} }), dispose() {} }) }
    r.state.pixels = (w, h) => flipRows(picture(w, h), w, h); r.state.cpuPixels = (w, h) => picture(w, h)
    const g = r.make({ gpuValidate: true, grain: true, particles: true, crosshair: true }); for (let i = 0; i < 4; i++) frame(g)
    expect(g.info.validation).toBe('passed'); expect(seen.length).toBe(6)              // 3 frames, the validation frame drawn twice (settleFrame: until it repeats), frame 4
    const v = seen[3]; expect(v.ents.map((e) => e.kind)).toEqual(['prop', 'note', 'npc']); expect(v.w).toBe(128); expect(v.opts).toMatchObject({ grain: false, particles: false, crosshair: false })
    expect(seen[4].ents).toBe(v.ents); expect(seen[5].ents).toEqual([]); expect(seen[5].opts.grain).toBe(true)              // the real frame is drawn after it, with the real options
    const cpuArgs = r.deps.createCpuRenderer.mock.results[0].value.render.mock.calls[0]
    expect(cpuArgs[3].map((e) => e.kind)).toEqual(['prop', 'note', 'npc']); expect(cpuArgs[5]).toEqual({ flashlight: true }); expect(cpuArgs[6].t).toBe(v.t)
    expect(r.canvas.width).toBe(128)                                                     // #c is untouched
  })
})

describe('validation deferral: a tiny canvas, a hidden page, a black reference (LC-8)', () => {
  it('a tiny canvas defers (never fails) and the sibling canvas is not resized to it', () => {
    const r = rig(); r.canvas.width = 20; r.canvas.height = 10
    r.state.pixels = () => new Uint8Array(4); r.state.cpuPixels = (w, h) => picture(w, h)
    const g = r.make({ gpuValidate: true }); for (let i = 0; i < 6; i++) frame(g)
    expect(g.info.validation).toBe('pending'); expect(r.deps.createCpuRenderer).not.toHaveBeenCalled()
    r.canvas.width = 128; r.canvas.height = 72; r.state.pixels = (w, h) => flipRows(picture(w, h), w, h)
    for (let i = 0; i < 6; i++) frame(g)                                                  // reaches the 12th call now that the canvas is real
    expect(g.info.validation).toBe('passed')
  })
  it('a hidden page defers; after the last checkpoint without a verdict the check is skipped (nothing cached)', () => {
    const r = rig(); r.doc.hidden = true
    const g = r.make({ gpuValidate: true }); for (let i = 0; i < 45; i++) frame(g)
    expect(g.info.validation).toBe('skipped'); expect(r.deps.createCpuRenderer).not.toHaveBeenCalled(); expect(r.store.size).toBe(0)
  })
  it('a black CPU reference defers to a later frame instead of caching a pass', () => {
    const r = rig(); r.state.pixels = (w, h) => new Uint8Array(w * h * 4); r.state.cpuPixels = (w, h) => new Uint8ClampedArray(w * h * 4)
    const g = r.make({ gpuValidate: true }); for (let i = 0; i < 4; i++) frame(g)
    expect(g.info.validation).toBe('pending'); expect(r.store.size).toBe(0)
    for (let i = 0; i < 40; i++) frame(g)
    expect(g.info.validation).toBe('skipped'); expect(r.deps.createCpuRenderer).toHaveBeenCalledTimes(3)      // frames 4, 12 and 40
  })
  it('releases the throwaway CPU renderer each time', () => {
    const r = rig(); r.state.pixels = (w, h) => flipRows(picture(w, h), w, h); r.state.cpuPixels = (w, h) => picture(w, h)
    const g = r.make({ gpuValidate: true }); for (let i = 0; i < 4; i++) frame(g)
    expect(r.deps.createCpuRenderer.mock.results[0].value.dispose).toHaveBeenCalledTimes(1)
  })
})

// ════════════════════ LC-11: the test gaps ════════════════════
describe('gaps the reviewer listed (LC-11)', () => {
  it('capture() composites the 2D overlay on top of the GL canvas', () => {
    const r = rig(); const g = r.make(); frame(g)
    const overlay = r.doc.createElement(); overlay.isOverlay = true
    // the pass hands its overlay through env: the fake post pass sets it at creation
    const r2 = rig(); let envRef = null
    r2.deps.passes = { world: r2.mkPass('world'), sprites: r2.mkPass('sprites'), post: (env) => { envRef = env; env.overlay = overlay; return { render() {}, dispose() {} } } }
    const g2 = r2.make(); frame(g2); expect(envRef).not.toBeNull()
    g2.capture(); expect(r2.state.overlayDraws).toBe(1)
    void g
  })
  it('the first-frame GL-error check fires on frame 2 (INVALID_OPERATION) and only in the first frames', () => {
    const r = rig(); const g = r.make(); frame(g); r.state.getError = () => 0x502
    const e = catchErr(() => frame(g)); expect(e.stage).toBe('frame'); expect(e.message).toMatch(/INVALID_OPERATION/)
    const r2 = rig(); const g2 = r2.make(); for (let i = 0; i < 4; i++) frame(g2); r2.state.getError = () => 0x502
    expect(() => frame(g2)).not.toThrow()                                                 // frame 5: the queue is no longer read
  })
  it('capture() after dispose throws instead of touching freed objects; capture releases its scratch canvas', () => {
    const r = rig(); const g = r.make(); frame(g); const c = r.doc.createElement
    let made = null; r.doc.createElement = function () { const x = c.call(r.doc); made = x; return x }
    g.capture(); expect(made.width).toBe(0); expect(made.height).toBe(0)
    g.dispose(); expect(catchErr(() => g.capture()).stage).toBe('disposed')
  })
  it('game.js disposes the old renderer before it builds the next (buildLevel order)', () => {
    const t = src('src/renderer/game.js'); const a = t.indexOf('level.gfx.dispose()'), b = t.indexOf('const gfx       = makeGfx(cfg, cache)')
    expect(a).toBeGreaterThan(0); expect(b).toBeGreaterThan(a)
  })
})

// ════════════════════ LC-7: swap safety ════════════════════
const okProbe = { ok: true, webgl2: true, majorPerformanceCaveat: false, unmaskedRenderer: 'ANGLE (Fake GPU)', reason: 'ok' }
const fakeCanvas = (id = 'c') => {
  const calls = []
  return { id, width: 320, height: 180, style: {}, ownerDocument: { createElement: () => fakeCanvas('t') }, toDataURL: () => 'data:image/png;base64,CPU', getContext: () => ({ fillStyle: '', fillRect: (...a) => calls.push(a) }), _fills: calls }
}
describe('swapToCpu and capture cannot leave a dead or blank state (LC-7)', () => {
  const deps = (o) => ({ storage: () => null, search: () => '', now: () => 5, warn: vi.fn(), probeGl: () => okProbe, onPageHide: () => () => {}, ...o })
  it('if the CPU renderer cannot be built after a GPU failure the game keeps a non-black state and retries', () => {
    let cpuOk = false; const cpu = { render: vi.fn(), dispose() {} }
    const gl = { kind: 'gpu', render() { throw new GlError('frame', 'boom') }, dispose() {} }
    const create = createRendererWith(deps({ createGl: () => gl, createCpu: () => { if (!cpuOk) throw new Error('oom'); return cpu } }))
    const cv = fakeCanvas(); const g = create(cv, { palette: { fog: '#123456' } }, { renderer: 'gpu' })
    expect(() => g.render(1)).not.toThrow(); expect(g.kind).toBe('cpu'); expect(cv._fills.length).toBe(1)             // painted the fog colour, not black
    expect(() => { for (let i = 0; i < 40; i++) g.render(i) }).not.toThrow()
    cpuOk = true; for (let i = 0; i < 40; i++) g.render(i)                                                            // the retry succeeds
    expect(cpu.render).toHaveBeenCalled()
  })
  it('capture() after a GPU capture failure draws the last frame on the CPU and returns a real image', () => {
    const cpu = { render: vi.fn(), dispose() {} }
    const create = createRendererWith(deps({ createGl: () => ({ kind: 'gpu', render() {}, capture() { throw new GlError('context', 'lost') }, dispose() {} }), createCpu: () => cpu }))
    const g = create(fakeCanvas(), { palette: {} }, { renderer: 'gpu' }); g.render('a', 'b')
    expect(g.capture()).toBe('data:image/png;base64,CPU'); expect(g.kind).toBe('cpu'); expect(cpu.render).toHaveBeenCalledWith('a', 'b')
  })
  it('capture() and noteFrame() after dispose do nothing (no leaked CPU renderer)', () => {
    const createCpu = vi.fn(() => ({ render() {}, dispose() {} }))
    const create = createRendererWith(deps({ createGl: () => ({ kind: 'gpu', render() {}, capture() { throw new Error('x') }, dispose() {} }), createCpu }))
    const g = create(fakeCanvas(), { palette: {} }, { renderer: 'gpu' }); g.dispose()
    expect(g.capture()).toBeNull(); g.noteFrame(500, { atFloor: true }); expect(createCpu).not.toHaveBeenCalled()
  })
})

// ════════════════════ LC-9 / P7: the crash marker on a clean unload ════════════════════
describe('the crash marker: clean unloads and slow GPUs (LC-9, P7)', () => {
  const MARKER = 'backrooms:gpu-marker'
  const memStore = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), m } }
  const setup = (clock = { t: 1_000_000 }) => {
    const store = memStore(); const hooks = []
    const create = createRendererWith({
      storage: () => store, search: () => '', now: () => clock.t, warn() {}, probeGl: () => okProbe,
      createGl: () => ({ kind: 'gpu', render() {}, dispose() {} }), createCpu: () => ({ render() {}, dispose() {} }),
      onPageHide: (fn) => { const h = { fn, on: true }; hooks.push(h); return () => { h.on = false } },
    })
    return { store, hooks, clock, create }
  }
  it('pagehide before the healthy frames gives the marker back: reloads do not count as crashes', () => {
    const s = setup(); const starts = []
    for (let i = 0; i < 6; i++) {                                    // six quick reload cycles: start, a few frames, pagehide (no dispose, like a real unload)
      const g = s.create(fakeCanvas(), { palette: {} }, { renderer: 'gpu' }); starts.push(g.kind); g.render(1)
      s.hooks.filter((h) => h.on).forEach((h) => h.fn())
      expect(s.store.getItem(MARKER)).toBeNull()
    }
    expect(starts).toEqual(Array(6).fill('gpu'))
  })
  it('without pagehide (a real GPU crash) two starts still trip the breaker', () => {
    const s = setup()
    expect(s.create(fakeCanvas(), { palette: {} }, { renderer: 'gpu' }).kind).toBe('gpu')
    expect(s.create(fakeCanvas(), { palette: {} }, { renderer: 'gpu' }).kind).toBe('gpu')
    expect(JSON.parse(s.store.getItem(MARKER)).count).toBe(CRASH_LIMIT)
    const third = s.create(fakeCanvas(), { palette: {} }, { renderer: 'gpu' }); expect(third.kind).toBe('cpu'); expect(third.why).toBe('crash-loop')
  })
  it('the pagehide listener is removed once the marker is cleared or the renderer disposed', () => {
    const s = setup(); const g = s.create(fakeCanvas(), { palette: {} }, { renderer: 'gpu' })
    for (let i = 0; i < CRASH_HEALTHY_FRAMES; i++) g.render(i)
    expect(s.store.getItem(MARKER)).toBeNull(); expect(s.hooks[0].on).toBe(false)
    const g2 = s.create(fakeCanvas(), { palette: {} }, { renderer: 'gpu' }); g2.dispose(); expect(s.hooks[1].on).toBe(false)
  })
  it('a slow GPU clears the marker after ~5 s of healthy frames, not only after 120 frames', () => {
    const s = setup(); const g = s.create(fakeCanvas(), { palette: {} }, { renderer: 'gpu' })
    g.render(1); expect(s.store.getItem(MARKER)).not.toBeNull()
    for (let i = 0; i < 40; i++) g.render(i)                          // 41 frames, all at the same instant: too fast to count as time
    expect(s.store.getItem(MARKER)).not.toBeNull()
    s.clock.t += 6000; g.render(1); expect(s.store.getItem(MARKER)).toBeNull()
  })
  it('a level change (dispose) before the healthy frames hands the previous state back', () => {
    const s = setup(); s.store.setItem(MARKER, JSON.stringify({ armedAt: 1_000_000 - 5, count: 1 }))
    const g = s.create(fakeCanvas(), { palette: {} }, { renderer: 'gpu' }); expect(JSON.parse(s.store.getItem(MARKER)).count).toBe(2)
    g.dispose(); expect(JSON.parse(s.store.getItem(MARKER)).count).toBe(1)
  })
})

// ════════════════════ P5: the PWA cache names ════════════════════
describe('the PWA cache names were bumped past everything deployed (P5)', () => {
  it('src/sw.js CACHE is above the v7 baseline and the play bundle default above the deployed v16', () => {
    expect(Number(/backrooms-pwa-v(\d+)/.exec(src('src/sw.js'))[1])).toBeGreaterThanOrEqual(8)
    expect(Number(/PLAY_SW_VERSION:-(\d+)/.exec(src('tools/build-play.sh'))[1])).toBeGreaterThanOrEqual(18)
  })
})
