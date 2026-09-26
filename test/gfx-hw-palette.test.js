// W9 (second half): a config whose palette misses a hex (palette.ceiling undefined, a wish that wrote garbage) must not throw anywhere
// the renderer reads it: hexToRgb falls back to a neutral grey, buildTextures fills the missing entry from the level's own stock palette
// (levels.js) or, for a hand-built config, a neutral default, and createRenderer (the CPU backend) builds and draws a frame.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { hexToRgb, NEUTRAL_RGB } from '../src/renderer/gfx-util.js'
import { buildTextures, resolvePalette, PALETTE_KEYS } from '../src/renderer/gfx-textures.js'
import { LEVELS, levelConfig } from '../src/renderer/levels.js'
import { DEFAULT_CONFIG } from '../src/renderer/world.js'
import { createCpuRenderer } from '../src/renderer/gfx-cpu.js'

const KEYS = ['legacy', ...LEVELS.map((l) => String(l.id))]
const stockOf = (key) => { const l = LEVELS.find((x) => String(x.id) === key); return l ? l.config.palette : DEFAULT_CONFIG.palette }
const materialsOf = (key) => { const l = LEVELS.find((x) => String(x.id) === key); return (l && l.config.materials) || null }
const without = (pal, k, v) => { const p = { ...pal }; if (v === undefined) delete p[k]; else p[k] = v; return p }
const BAD = [undefined, null, '', 'not-a-colour', 42]

describe('W9 hexToRgb never throws', () => {
  it('parses a valid hex exactly as before', () => {
    expect(hexToRgb('#C8B870')).toEqual([200, 184, 112])
    expect(hexToRgb('4A3820')).toEqual([74, 56, 32])
  })
  it('a missing / unparsable hex gives a fresh copy of the fallback (neutral grey by default)', () => {
    for (const v of BAD) expect(hexToRgb(v)).toEqual([...NEUTRAL_RGB])
    expect(hexToRgb(undefined, [1, 2, 3])).toEqual([1, 2, 3])
    const a = hexToRgb(undefined); a[0] = 0
    expect(hexToRgb(undefined)).toEqual([...NEUTRAL_RGB])          // the default is never handed out by reference
  })
})

describe('W9 buildTextures with a palette that misses a key', () => {
  it('a complete palette passes through untouched (the same object: memo keys and bytes unchanged)', () => {
    for (const key of KEYS) { const p = stockOf(key); expect(resolvePalette(p, key)).toBe(p) }
  })
  it('every palette key, every level: a missing or bad entry falls back to the level\'s own entry, so the tiles are byte-identical to the stock ones', () => {
    for (const key of KEYS) {
      if (key === 'legacy') continue
      const stock = stockOf(key), mats = materialsOf(key)
      const ref = buildTextures(stock, mats, null, key)
      for (const k of PALETTE_KEYS) {
        for (const v of (k === 'ceiling' ? [undefined, 'garbage'] : [undefined])) {
          const pal = without(stock, k, v)
          expect(resolvePalette(pal, key)[k]).toBe(stock[k])
          let tex
          expect(() => { tex = buildTextures(pal, mats, null, key) }).not.toThrow()
          expect(tex.light).toEqual(ref.light); expect(tex.floor).toEqual(ref.floor); expect(tex.ceil).toEqual(ref.ceil); expect(tex.walls['0']).toEqual(ref.walls['0'])
        }
      }
    }
  }, 180000)
  it('a hand-built (legacy) config falls back to a neutral default, and an absent palette object does not throw either', () => {
    for (const k of PALETTE_KEYS) {
      for (const v of BAD) {
        const pal = without(DEFAULT_CONFIG.palette, k, v)
        const r = resolvePalette(pal, 'legacy')
        expect(typeof r[k]).toBe('string'); expect(hexToRgb(r[k])).toHaveLength(3)
        const tex = buildTextures(pal, null, null, 'legacy')
        expect(tex.light.length).toBe(tex.ts * tex.ts * 3)
      }
    }
    expect(() => buildTextures(undefined, null, null, 'legacy')).not.toThrow()
    expect(() => buildTextures(null, null, null, '0')).not.toThrow()
    expect(resolvePalette(undefined, '2')).toEqual(stockOf('2'))
  }, 60000)
})

// a canvas / 2D context stand-in: every method is a no-op, image data is real
function mockCtx() {
  return new Proxy({}, {
    get(t, k) {
      if (k in t) return t[k]
      if (k === 'createLinearGradient' || k === 'createRadialGradient') return () => ({ addColorStop() {} })
      if (k === 'createPattern') return () => ({})
      if (k === 'measureText') return () => ({ width: 40 })
      if (k === 'getImageData') return (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h })
      if (k === 'createImageData') return (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h })
      return () => {}
    },
    set(t, k, v) { t[k] = v; return true },
  })
}
const fakeCanvas = (w = 96, h = 54) => ({ width: w, height: h, getContext: () => mockCtx() })

describe('W9 createRenderer (CPU backend) with a palette that misses a key', () => {
  afterEach(() => { vi.unstubAllGlobals() })
  it('builds and draws a frame for every palette key missing, at a lit and a legacy tier', () => {
    vi.stubGlobal('document', { createElement: () => fakeCanvas(0, 0) })
    const isWall = (x, y) => Math.abs(Math.floor(x)) > 3 || Math.abs(Math.floor(y)) > 3
    const player = { x: 0.5, y: 0.5, angle: 0.3, bobOffset: 0 }
    for (const idx of [0, 2]) {
      const cfg = levelConfig(DEFAULT_CONFIG, idx)
      for (const k of PALETTE_KEYS) {
        for (const tier of ['legacy', 'medium']) {
          const c = { ...cfg, palette: without(cfg.palette, k) }
          expect(() => { const r = createCpuRenderer(fakeCanvas(), c, { qualityTier: tier }); r.render(player, isWall, 1, [], 1, {}, { t: 1, dt: 1 / 60 }) }).not.toThrow()
        }
      }
    }
  }, 60000)
})
