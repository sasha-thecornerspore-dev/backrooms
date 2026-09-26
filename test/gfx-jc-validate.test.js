// Fixer JC, H4-3: programs are collected lazily, so a post program that fails to compile or link can first surface INSIDE the synthetic
// validation frame. That is a shader / program failure (its own stage, persisted like any other), not a validation mismatch: info.validation
// must not say the device failed the picture check ('failed' is kept for a picture that does not match). Fake WebGL, fake passes.
import { describe, it, expect, vi } from 'vitest'
globalThis.__backroomsTestRun = true
import { createGlRenderer } from '../src/renderer/gfx-gl.js'
import { createRendererWith, GPU_MARKER_KEY } from '../src/renderer/renderer.js'
import { GlError } from '../src/renderer/gfx-gl-util.js'
import { GPU_BUILD_ID, validationCacheKey, readValidationCache } from '../src/renderer/gfx-gl-g4-validate.js'
import { CRASH_LIMIT } from '../src/renderer/gfx-quality.js'
import { DEFAULT_CONFIG } from '../src/renderer/world.js'
import { levelConfig } from '../src/renderer/levels.js'

function fakeGl(state) {
  const t = {
    NO_ERROR: 0, isContextLost: () => state.lost, getError: () => 0,
    getExtension: (n) => (n === 'WEBGL_lose_context' ? { loseContext() { state.lost = true } } : null),
    readPixels: (x, y, w, h, f, ty, buf) => { if (state.pixels) buf.set(state.pixels(w, h)) },
  }
  return new Proxy(t, { get(o, k) { if (k in o) return o[k]; if (typeof k === 'string' && /^[A-Z][A-Z0-9_]*$/.test(k)) return k.length + 1000; return () => null } })
}
function fakeDoc(state) {
  const doc = {
    createElement() {
      const c = {
        width: 0, height: 0, style: {}, dataset: {}, parentNode: null, ownerDocument: doc, id: '',
        setAttribute() {}, addEventListener() {},
        remove() { if (c.parentNode) { c.parentNode.children = c.parentNode.children.filter((x) => x !== c); c.parentNode = null } },
        getContext(kind) {
          if (kind === 'webgl2') return state.gl
          return { getImageData: (x, y, w, h) => ({ data: state.cpuPixels(w, h) }), drawImage() {}, fillRect() {} }
        },
        toDataURL: () => 'data:,',
      }
      return c
    },
  }
  return doc
}
// a top-bright / bottom-dark picture (the GL readback is bottom-up)
const pic = (w, h, bottomUp) => { const d = new Uint8ClampedArray(w * h * 4); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = ((bottomUp ? h - 1 - y : y) * w + x) * 4, v = y < h / 2 ? 200 : 60; d[o] = v; d[o + 1] = v * 0.9; d[o + 2] = v * 0.5; d[o + 3] = 255 } return d }

// postRender(callIndex) may throw: the post pass's render, as gfx-gl.js calls it (frames 1-3, then the validation draws before frame 4)
function rig(postRender) {
  const state = { lost: false, gl: null, pixels: (w, h) => pic(w, h, true), cpuPixels: (w, h) => pic(w, h, false) }
  state.gl = fakeGl(state)
  const doc = fakeDoc(state)
  const parent = { children: [], insertBefore(n) { n.parentNode = parent; parent.children.push(n) } }
  const canvas = doc.createElement(); canvas.id = 'c'; canvas.width = 128; canvas.height = 72; canvas.parentNode = parent; parent.children.push(canvas)
  let postCalls = 0
  const store = new Map()
  const deps = {
    probeGl: () => ({ ok: true, webgl2: true, majorPerformanceCaveat: false, unmaskedRenderer: 'ANGLE (Fake)', caps: {} }),
    buildTextures: () => ({}), createLight: () => ({ enabled: false }),
    storage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, v) },
    passes: {
      world: () => ({ render: () => ({}), dispose() {} }),
      sprites: () => ({ render: () => ({}), dispose() {} }),
      post: () => ({ render: () => { postCalls++; postRender(postCalls, state) }, dispose() {} }),
    },
    createCpuRenderer: vi.fn(() => ({ render: vi.fn(), dispose: vi.fn() })),
  }
  const cfg = levelConfig(DEFAULT_CONFIG, 0)
  return { state, canvas, deps, store, cfg, make: () => createGlRenderer(canvas, cfg, { qualityTier: 'low', gpuValidate: true }, {}, deps) }
}
const player = { x: 5.5, y: 5.5, angle: 0, bobOffset: 0 }
const frame = (r) => r.render(player, () => false, 1, [], 1, {}, null)
const programFails = (n) => { if (n === 4) throw new GlError('program', 'post-bloom failed to link', 'ERROR: 0:12: fake link log') }

describe('a program failure surfacing in the validation frame (H4-3)', () => {
  it('is rethrown as the program failure it is, and info.validation says the check errored, not that the picture failed', () => {
    const r = rig(programFails); const g = r.make()
    for (let i = 0; i < 3; i++) frame(g)
    let e = null; try { frame(g) } catch (x) { e = x }
    expect(e).toBeInstanceOf(GlError); expect(e.stage).toBe('program'); expect(e.message).toMatch(/failed to link/)
    expect(g.info.validation).toBe('error')
    expect(readValidationCache(r.deps.storage, validationCacheKey('ANGLE (Fake)', GPU_BUILD_ID))).toBe(false)
  })
  it('a shader compile failure there too', () => {
    const r = rig((n) => { if (n === 4) throw new GlError('shader', 'post-grade fragment shader failed to compile') }); const g = r.make()
    for (let i = 0; i < 3; i++) frame(g)
    expect(() => frame(g)).toThrow(/failed to compile/); expect(g.info.validation).toBe('error')
  })
  it('a lost context during the validation frame is the context loss (session-only), not a failed picture', () => {
    const r = rig((n, st) => { if (n === 4) { st.lost = true; throw new Error('null program') } }); const g = r.make()
    for (let i = 0; i < 3; i++) frame(g)
    let e = null; try { frame(g) } catch (x) { e = x }
    expect(e.stage).toBe('context'); expect(g.info.validation).toBe('error')
  })
  it('a picture that does not match still reads "failed" (GlError validate)', () => {
    const r = rig(() => {}); r.state.pixels = (w, h) => { const d = new Uint8Array(w * h * 4); for (let i = 3; i < d.length; i += 4) d[i] = 255; return d }
    const g = r.make(); for (let i = 0; i < 3; i++) frame(g)
    let e = null; try { frame(g) } catch (x) { e = x }
    expect(e.stage).toBe('validate'); expect(g.info.validation).toBe('failed')
  })
  it('through renderer.js: the swap to the CPU, and the failure is persisted (the 24 h marker), as for any program failure', () => {
    const r = rig(programFails)
    const store = new Map(), mstore = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) }
    const warn = vi.fn()
    const create = createRendererWith({
      storage: () => mstore, search: () => '', now: () => 1_000_000, warn, onPageHide: () => () => {},
      probeGl: r.deps.probeGl,
      createCpu: () => ({ render() {}, dispose() {} }),
      createGl: (c, cfg, ro, wh, d) => createGlRenderer(c, cfg, ro, wh, { ...r.deps, probe: d && d.probe }),
    })
    const g = create(r.canvas, r.cfg, { renderer: 'gpu', qualityTier: 'low', gpuValidate: true })
    expect(g.kind).toBe('gpu')
    for (let i = 0; i < 4; i++) frame(g)
    expect(g.kind).toBe('cpu'); expect(g.why).toBe('gpu-failed-runtime')
    expect(g.failure).toEqual({ stage: 'runtime', persisted: true })
    expect(JSON.parse(store.get(GPU_MARKER_KEY)).count).toBe(CRASH_LIMIT)
    expect(String(warn.mock.calls[0][1])).toMatch(/failed to link/)
  })
})
