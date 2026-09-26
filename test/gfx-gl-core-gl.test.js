// gfx-gl.js (the orchestrator) against a fake WebGL2 context, fake canvases and fake passes: the sibling canvas lifecycle, the size / shake sync,
// context loss, the first-frame validation wiring, the forced-failure hooks, dispose, and pass-creation failure cleanup. No real GL.
import { describe, it, expect, vi } from 'vitest'
// the harness-only hooks (allowSoftwareGl, __failGl, gpuValidate) are honoured only in a test run (see isTestRun in gfx-gl-util.js)
globalThis.__backroomsTestRun = true
import { createGlRenderer, GpuUnavailable } from '../src/renderer/gfx-gl.js'
import { GlError, siblingLayout, requireUniforms } from '../src/renderer/gfx-gl-util.js'
import { GPU_BUILD_ID, validationCacheKey, readValidationCache } from '../src/renderer/gfx-gl-g4-validate.js'
import * as validateMod from '../src/renderer/gfx-gl-g4-validate.js'
import { DEFAULT_CONFIG } from '../src/renderer/world.js'
import { levelConfig } from '../src/renderer/levels.js'

// ── fakes ──
function fakeGl(state) {
  const t = {
    NO_ERROR: 0, isContextLost: () => state.lost, getError: () => 0,
    getExtension: (n) => (n === 'WEBGL_lose_context' ? { loseContext() { state.lost = true; state.loseCalls++ } } : null),
    readPixels: (x, y, w, h, f, ty, buf) => { if (state.pixels) buf.set(state.pixels(w, h)) },
  }
  return new Proxy(t, { get(o, k) { if (k in o) return o[k]; if (typeof k === 'string' && /^[A-Z][A-Z0-9_]*$/.test(k)) return k.length + 1000; return () => null } })
}
function fakeDoc(state) {
  const doc = {
    createElement() {
      const listeners = {}
      const c = {
        width: 0, height: 0, style: {}, dataset: {}, parentNode: null, ownerDocument: doc, listeners,
        setAttribute() {}, addEventListener(n, f) { (listeners[n] = listeners[n] || []).push(f) },
        remove() { if (c.parentNode) { c.parentNode.children = c.parentNode.children.filter((x) => x !== c); c.parentNode = null } },
        getContext(kind) {
          if (kind === 'webgl2') { state.contexts++; return state.gl }
          return { getImageData: (x, y, w, h) => ({ data: state.cpuPixels ? state.cpuPixels(w, h) : new Uint8ClampedArray(w * h * 4) }), drawImage() {} }
        },
        toDataURL: () => 'data:image/png;base64,X',
      }
      return c
    },
  }
  return doc
}
function rig(over = {}) {
  const state = { lost: false, loseCalls: 0, contexts: 0, gl: null, pixels: null, cpuPixels: null, passLog: [] }
  state.gl = fakeGl(state)
  const doc = fakeDoc(state)
  const parent = { children: [], insertBefore(n, ref) { n.parentNode = parent; const i = ref ? parent.children.indexOf(ref) : parent.children.length; parent.children.splice(i < 0 ? parent.children.length : i, 0, n) } }
  const canvas = doc.createElement(); canvas.width = 64; canvas.height = 36; canvas.parentNode = parent; parent.children.push(canvas)
  const mkPass = (name, extra = {}) => () => ({ render: vi.fn(() => ({})), dispose: vi.fn(() => state.passLog.push(name)), ...extra })
  const store = new Map()
  const deps = {
    probeGl: () => ({ ok: true, webgl2: true, majorPerformanceCaveat: false, unmaskedRenderer: 'ANGLE (Fake)', caps: {} }),
    buildTextures: () => ({}), createLight: () => ({ enabled: false }),
    storage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, v) },
    passes: { world: mkPass('world'), sprites: mkPass('sprites'), post: mkPass('post') },
    createCpuRenderer: vi.fn(() => ({ render: vi.fn(), dispose: vi.fn() })),
    ...over.deps,
  }
  return { state, canvas, parent, deps, store, make: (ropts = {}) => createGlRenderer(canvas, levelConfig(DEFAULT_CONFIG, 0), { qualityTier: 'low', gpuValidate: false, ...ropts }, {}, deps) }
}
const player = { x: 5.5, y: 5.5, angle: 0, bobOffset: 0 }
const frame = (r) => r.render(player, () => false, 1, [], 1, {}, null)

describe('sibling canvas', () => {
  it('is inserted right after #c, pointer-events none, and removed on dispose (once)', () => {
    const r = rig(); const g = r.make()
    expect(r.parent.children.length).toBe(2); expect(r.parent.children[0]).toBe(r.canvas)
    const sib = r.parent.children[1]; expect(sib.style.pointerEvents).toBe('none'); expect(sib.style.position).toBe('fixed'); expect(sib).toBe(g.canvas)
    g.dispose(); g.dispose()
    expect(r.parent.children).toEqual([r.canvas])
    expect(r.state.loseCalls).toBe(1)                                        // the context is released explicitly
    expect(r.state.passLog.sort()).toEqual(['post', 'sprites', 'world'])     // each pass disposed exactly once
  })
  it('follows #c: size, css box, and the shake transform (and clears it)', () => {
    const r = rig(); const g = r.make(); const sib = g.canvas
    frame(g); expect([sib.width, sib.height, sib.style.width, sib.style.transform || '']).toEqual([64, 36, '64px', ''])
    r.canvas.width = 128; r.canvas.height = 72; r.canvas.style.width = '640px'; r.canvas.style.height = '360px'; r.canvas.style.transform = 'translate(3px, -2px)'
    frame(g); expect([sib.width, sib.height, sib.style.width, sib.style.height, sib.style.transform]).toEqual([128, 72, '640px', '360px', 'translate(3px, -2px)'])
    r.canvas.style.transform = ''; frame(g); expect(sib.style.transform).toBe('')
  })
  it('siblingLayout is pure: falls back to the backing-store size when #c has no inline css size', () => {
    expect(siblingLayout({ width: 10, height: 5, style: {} })).toEqual({ width: 10, height: 5, cssW: '10px', cssH: '5px', transform: '' })
    expect(siblingLayout({ width: 10, height: 5, style: { width: '7px', height: '4px', transform: 't' } })).toMatchObject({ cssW: '7px', cssH: '4px', transform: 't' })
  })
  it('does not create the sibling when the probe fails or the context is refused', () => {
    const a = rig({ deps: { probeGl: () => ({ ok: false, reason: 'software-gl' }) } })
    expect(() => a.make()).toThrow(GpuUnavailable); expect(a.parent.children.length).toBe(1)
    const b = rig(); b.state.gl = null; expect(() => b.make()).toThrow(/context-creation-failed/); expect(b.parent.children.length).toBe(1)
  })
})

describe('pass creation failure', () => {
  it('cleans the sibling and the earlier passes up and throws a GlError', () => {
    const r = rig({ deps: { passes: { world: () => ({ render() {}, dispose: () => r.state.passLog.push('world') }), sprites: () => { throw new Error('boom') }, post: () => ({}) } } })
    let err = null; try { r.make() } catch (e) { err = e }
    expect(err).toBeInstanceOf(GlError); expect(err.stage).toBe('init'); expect(err.message).toMatch(/boom/)
    expect(r.parent.children.length).toBe(1); expect(r.state.passLog).toEqual(['world'])
  })
  it('passes without resize/dispose methods are tolerated', () => {
    const bare = () => ({ render: () => ({}) })
    const r = rig({ deps: { passes: { world: bare, sprites: bare, post: bare } } }); const g = r.make()
    expect(() => { frame(g); g.dispose() }).not.toThrow()
  })
})

describe('context loss', () => {
  it('a lost context throws GlError("context") from the next render and capture, and is never rebuilt', () => {
    const r = rig(); const g = r.make(); frame(g)
    r.parent.children[1].listeners.webglcontextlost[0]({})
    expect(g.lost).toBe(true)
    let e = null; try { frame(g) } catch (x) { e = x }
    expect(e).toBeInstanceOf(GlError); expect(e.stage).toBe('context')
    r.parent.children[1].listeners.webglcontextrestored[0]({})            // a restore is ignored
    expect(() => frame(g)).toThrow(/lost/)
    expect(() => g.capture()).toThrow(/lost/)
  })
  it('isContextLost() alone (no event yet) is enough', () => {
    const r = rig(); const g = r.make(); frame(g); r.state.lost = true
    expect(() => frame(g)).toThrow(GlError)
  })
  it('a render after dispose throws instead of touching freed GL objects', () => {
    const r = rig(); const g = r.make(); g.dispose(); expect(() => frame(g)).toThrow(/disposed/)
  })
})

describe('forced failures (renderOpts.__failGl)', () => {
  it('create / frame / frame:N / lost / validate', () => {
    expect(() => rig().make({ __failGl: 'create' })).toThrow(/forced/)
    const a = rig().make({ __failGl: 'frame' }); expect(() => frame(a)).toThrow(/forced failure on frame 1/)
    const b = rig().make({ __failGl: 'frame:3' }); frame(b); frame(b); expect(() => frame(b)).toThrow(/frame 3/)
    const c = rig().make({ __failGl: 'lost' }); frame(c); expect(() => frame(c)).toThrow(GlError); expect(c.lost).toBe(true)
  })
})

describe('first-frame validation', () => {
  // a top-bright / bottom-dark picture; the GL readback is stored bottom-up
  const pic = (w, h, bottomUp) => { const d = new Uint8ClampedArray(w * h * 4); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = ((bottomUp ? h - 1 - y : y) * w + x) * 4, v = y < h / 2 ? 200 : 60; d[o] = v; d[o + 1] = v * 0.9; d[o + 2] = v * 0.5; d[o + 3] = 255 } return d }
  it('runs on frame 4, passes a matching frame, disposes the reference, and caches the pass per device + build', () => {
    const r = rig(); r.state.pixels = (w, h) => pic(w, h, true); r.state.cpuPixels = (w, h) => pic(w, h, false)
    const g = r.make({ gpuValidate: true })
    expect(g.info.validation).toBe('pending')
    for (let i = 0; i < 3; i++) frame(g)
    expect(r.deps.createCpuRenderer).not.toHaveBeenCalled()
    frame(g)
    expect(r.deps.createCpuRenderer).toHaveBeenCalledTimes(1)
    const ref = r.deps.createCpuRenderer.mock.results[0].value
    // drawn until its picture stops changing (settleFrame): here the first two draws are identical, so exactly two
    expect(ref.render).toHaveBeenCalledTimes(2); expect(ref.dispose).toHaveBeenCalledTimes(1)
    expect(g.info.validationDraws).toEqual({ cpu: 2, gpu: 2 })
    expect(g.info.validation).toBe('passed')
    expect(readValidationCache(r.deps.storage, validationCacheKey('ANGLE (Fake)', GPU_BUILD_ID))).toBe(true)
    // the reference ran with the same tier and without grain / particles / crosshair
    expect(r.deps.createCpuRenderer.mock.calls[0][2]).toMatchObject({ qualityTier: 'low', grain: false, particles: false, crosshair: false, renderer: 'cpu' })
    // a second renderer on the same device + build: cached, no CPU reference at all
    const r2 = { ...r }; const g2 = createGlRenderer(r.canvas, levelConfig(DEFAULT_CONFIG, 0), { qualityTier: 'low', gpuValidate: undefined }, {}, r.deps)
    expect(g2.info.validation).toBe('cached'); for (let i = 0; i < 6; i++) frame(g2)
    expect(r.deps.createCpuRenderer).toHaveBeenCalledTimes(1)
  })
  it('a sprite that one side builds only on a later call (the lazy build budget) is waited for, not taken for a broken pass', () => {
    const r = rig()
    // the first CPU draw and the first GPU draw both lack a bright "sprite" block in the middle; every later draw has it
    const withSprite = (w, h, bottomUp) => { const d = pic(w, h, bottomUp); for (let y = (h * 0.4) | 0; y < h * 0.6; y++) for (let x = (w * 0.45) | 0; x < w * 0.55; x++) { const o = ((bottomUp ? h - 1 - y : y) * w + x) * 4; d[o] = 250; d[o + 1] = 240; d[o + 2] = 120 } return d }
    let cpuCalls = 0, gpuCalls = 0
    r.state.cpuPixels = (w, h) => (++cpuCalls === 1 ? pic(w, h, false) : withSprite(w, h, false))
    r.state.pixels = (w, h) => (++gpuCalls === 1 ? pic(w, h, true) : withSprite(w, h, true))
    const g = r.make({ gpuValidate: true }); for (let i = 0; i < 4; i++) frame(g)
    expect(g.info.validation).toBe('passed')
    expect(g.info.validationDraws).toEqual({ cpu: 3, gpu: 3 })
    // and the old single-draw comparison of these very frames would have failed (a sprite-sized worst block): what the settling prevents
    const { compareFrames, blockMeans } = validateMod
    const one = compareFrames(blockMeans(withSprite(64, 36, true), 64, 36, 64, 36, true), blockMeans(pic(64, 36, false), 64, 36, 64, 36, false))
    expect(one.ok).toBe(false)
  })
  it('throws GlError("validate") on a black GPU frame (a driver bug) and does not cache', () => {
    const r = rig(); r.state.pixels = (w, h) => { const d = new Uint8Array(w * h * 4); for (let i = 3; i < d.length; i += 4) d[i] = 255; return d }; r.state.cpuPixels = (w, h) => pic(w, h, false)
    const g = r.make({ gpuValidate: true })
    for (let i = 0; i < 3; i++) frame(g)
    let e = null; try { frame(g) } catch (x) { e = x }
    expect(e).toBeInstanceOf(GlError); expect(e.stage).toBe('validate'); expect(g.info.validation).toBe('failed')
    expect(readValidationCache(r.deps.storage, validationCacheKey('ANGLE (Fake)', GPU_BUILD_ID))).toBe(false)
  })
  it('a vertically flipped GPU frame fails too', () => {
    const r = rig(); r.state.pixels = (w, h) => pic(w, h, false); r.state.cpuPixels = (w, h) => pic(w, h, false)     // forgot the bottom-up storage
    const g = r.make({ gpuValidate: true }); for (let i = 0; i < 3; i++) frame(g)
    expect(() => frame(g)).toThrow(/does not match/)
  })
  it('a broken CPU reference is not evidence against the GPU: skipped, no throw', () => {
    const r = rig({ deps: { createCpuRenderer: () => { throw new Error('cpu broke') } } }); r.state.pixels = (w, h) => pic(w, h, true)
    const g = r.make({ gpuValidate: true }); for (let i = 0; i < 6; i++) frame(g)
    expect(g.info.validation).toBe('skipped')
  })
  it('does not run on the harness software GL unless forced, and never with gpuValidate:false', () => {
    const r = rig(); const g = r.make({ allowSoftwareGl: true, gpuValidate: undefined }); for (let i = 0; i < 6; i++) frame(g)
    expect(g.info.validation).toBe('off'); expect(r.deps.createCpuRenderer).not.toHaveBeenCalled()
  })
  it('__failGl=validate forces a validation failure', () => {
    const r = rig(); r.state.pixels = (w, h) => pic(w, h, true); r.state.cpuPixels = (w, h) => pic(w, h, false)
    const g = r.make({ gpuValidate: true, __failGl: 'validate' }); for (let i = 0; i < 3; i++) frame(g)
    expect(() => frame(g)).toThrow(/forced failure/)
  })
})

describe('requireUniforms', () => {
  it('throws a clear GlError naming the missing uniforms at creation time', () => {
    const p = { label: 'world', u: { uA: 1, uB: 2 } }
    expect(requireUniforms(p, ['uA', 'uB'])).toBe(p)
    expect(() => requireUniforms(p, ['uA', 'uC', 'uD'])).toThrow(/world.*uC, uD/)
  })
})
