// PKG-3: the GPU first-frame validation reads its CPU-reference canvas back several times (settleFrame), which made Chromium warn
// "Multiple readback operations using getImageData are faster with the willReadFrequently attribute set to true". The reference
// canvas's 2D context is now requested with { alpha: false, willReadFrequently: true } BEFORE the CPU renderer is built on it, since
// the first getContext call fixes the attributes (the CPU renderer's own getContext('2d', { alpha: false }) then gets that context).
// Fake WebGL, fake passes; the picture check itself is unchanged and still passes.
import { describe, it, expect, vi } from 'vitest'
globalThis.__backroomsTestRun = true
import { createGlRenderer } from '../src/renderer/gfx-gl.js'
import { DEFAULT_CONFIG } from '../src/renderer/world.js'
import { levelConfig } from '../src/renderer/levels.js'

function fakeGl(state) {
  const t = {
    NO_ERROR: 0, isContextLost: () => false, getError: () => 0, getExtension: () => null,
    readPixels: (x, y, w, h, f, ty, buf) => buf.set(state.pixels(w, h)),
  }
  return new Proxy(t, { get(o, k) { if (k in o) return o[k]; if (typeof k === 'string' && /^[A-Z][A-Z0-9_]*$/.test(k)) return k.length + 1000; return () => null } })
}
const pic = (w, h, bottomUp) => { const d = new Uint8ClampedArray(w * h * 4); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = ((bottomUp ? h - 1 - y : y) * w + x) * 4, v = y < h / 2 ? 200 : 60; d[o] = v; d[o + 1] = v * 0.9; d[o + 2] = v * 0.5; d[o + 3] = 255 } return d }

function rig() {
  const state = { pixels: (w, h) => pic(w, h, true), log: [] }
  state.gl = fakeGl(state)
  const doc = {
    createElement() {
      const c = {
        width: 0, height: 0, style: {}, dataset: {}, parentNode: null, ownerDocument: doc, id: '', ctx2d: null, calls: [],
        setAttribute() {}, addEventListener() {}, remove() {},
        getContext(kind, attrs) {
          c.calls.push({ kind, attrs })
          state.log.push({ canvas: c, what: 'getContext', kind, attrs })
          if (kind === 'webgl2') return state.gl
          if (!c.ctx2d) c.ctx2d = { attrs, getImageData: (x, y, w, h) => ({ data: pic(w, h, false) }), drawImage() {}, fillRect() {} }
          return c.ctx2d
        },
        toDataURL: () => 'data:,',
      }
      return c
    },
  }
  const parent = { children: [], insertBefore(n) { n.parentNode = parent; parent.children.push(n) } }
  const canvas = doc.createElement(); canvas.id = 'c'; canvas.width = 128; canvas.height = 72; canvas.parentNode = parent; parent.children.push(canvas)
  const store = new Map()
  const createCpuRenderer = vi.fn((c) => {
    state.log.push({ canvas: c, what: 'createCpuRenderer' })
    c.getContext('2d', { alpha: false })            // what gfx-cpu.js does first
    return { render: vi.fn(), dispose: vi.fn() }
  })
  const deps = {
    probeGl: () => ({ ok: true, webgl2: true, majorPerformanceCaveat: false, unmaskedRenderer: 'ANGLE (Fake)', caps: {} }),
    buildTextures: () => ({}), createLight: () => ({ enabled: false }),
    storage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, v) },
    passes: {
      world: () => ({ render: () => ({}), dispose() {} }),
      sprites: () => ({ render: () => ({}), dispose() {} }),
      post: () => ({ render: () => {}, dispose() {} }),
    },
    createCpuRenderer,
  }
  const cfg = levelConfig(DEFAULT_CONFIG, 0)
  return { state, deps, make: () => createGlRenderer(canvas, cfg, { qualityTier: 'low', gpuValidate: true }, {}, deps) }
}
const player = { x: 5.5, y: 5.5, angle: 0, bobOffset: 0 }
const frame = (r) => r.render(player, () => false, 1, [], 1, {}, null)

describe('GPU validation readback canvas (PKG-3)', () => {
  it('asks for a willReadFrequently 2D context before the CPU reference renderer is built on it', () => {
    const r = rig(); const g = r.make()
    for (let i = 0; i < 4; i++) frame(g)
    expect(r.deps.createCpuRenderer).toHaveBeenCalled()
    const refCanvas = r.deps.createCpuRenderer.mock.calls[0][0]
    const first2d = refCanvas.calls.find((x) => x.kind === '2d')
    expect(first2d.attrs).toEqual({ alpha: false, willReadFrequently: true })
    const order = r.state.log.filter((e) => e.canvas === refCanvas).map((e) => e.what)
    expect(order.indexOf('getContext')).toBeLessThan(order.indexOf('createCpuRenderer'))
  })
  it('the picture check still passes', () => {
    const r = rig(); const g = r.make()
    for (let i = 0; i < 4; i++) frame(g)
    expect(g.info.validation).toBe('passed')
  })
})
