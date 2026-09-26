// Track HP / task 3, the FLAGGED (perceptually identical, max delta 1) optimisation: the modern tiers draw the static flashlight gradient once into
// an offscreen layer per canvas size and blit it additively; the legacy tier and callers without a post state keep the exact gradient fill.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { flashLayer, drawLights, lightBox, createPostState, composeFrame } from '../src/renderer/gfx-post.js'
import { TIERS } from '../src/renderer/gfx-quality.js'
import { fakeDoc2d } from './gfx-hp-fakes.js'

afterEach(() => { vi.unstubAllGlobals() })

const cfg = { levelIndex: 0, palette: { fog: '#D4C87A' }, particles: { count: 0 } }
const fsFor = (tier, OW = 1280, OH = 720, lights = { flashlight: true }) => ({
  W: OW >> 1, H: OH >> 1, OW, OH, t: 0.5, dt: 1 / 60, frame: 3, flicker: 1, rawFlicker: 1, fov: 1.309, player: { x: 1, y: 1, angle: 0 }, lights,
  opts: { grain: false, particles: false, crosshair: false, bloom: false }, quality: TIERS[tier], levelKey: '0', handled: { flashlight: false, glow: false }, light: { enabled: tier !== 'legacy' },
})

describe('flashLayer', () => {
  it('is built once per canvas size, dither-aligned (origin a multiple of 8) and covering the gradient box; a resize redraws the same canvas', () => {
    const doc = fakeDoc2d(); vi.stubGlobal('document', doc)
    const post = createPostState(cfg)
    const f = flashLayer(post, 1280, 720)
    const b = lightBox(640, 720 * 0.52, 720 * 0.72, 1280, 720)
    expect(f.x0 % 8).toBe(0); expect(f.y0 % 8).toBe(0)
    expect(f.x0).toBeLessThanOrEqual(b[0]); expect(f.x0 + f.canvas.width).toBe(b[0] + b[2]); expect(f.y0 + f.canvas.height).toBe(b[1] + b[3])
    const made = doc.created, grads = doc.gradients
    expect(flashLayer(post, 1280, 720)).toBe(f); expect(doc.gradients).toBe(grads)
    const g = flashLayer(post, 960, 540)
    expect(g.canvas).toBe(f.canvas); expect(doc.created).toBe(made); expect(doc.gradients).toBe(grads + 1)
  })
})

describe('drawLights with and without the layer', () => {
  it('with a post state: one additive blit of the layer, no gradient; without: the exact box-filled gradient', () => {
    const doc = fakeDoc2d(); vi.stubGlobal('document', doc)
    const post = createPostState(cfg)
    const a = doc.createElement('canvas').getContext('2d')
    drawLights(a, fsFor('medium'), post)
    expect(a.calls.filter((c) => c[0] === 'drawImage')).toEqual([['drawImage', post.flash.canvas, post.flash.x0, post.flash.y0]])
    expect(a.calls.some((c) => c[0] === 'fillRect')).toBe(false)
    const b = doc.createElement('canvas').getContext('2d')
    drawLights(b, fsFor('medium'))
    expect(b.calls.filter((c) => c[0] === 'fillRect').map((c) => c.slice(1))).toEqual([lightBox(640, 720 * 0.52, 720 * 0.72, 1280, 720)])
  })
  it('composeFrame: the modern tiers use the layer, the legacy tier keeps the exact fill; a lit world (handled) draws neither', () => {
    const doc = fakeDoc2d(); vi.stubGlobal('document', doc)
    for (const [tier, layered] of [['legacy', false], ['low', true], ['medium', true]]) {
      const post = createPostState(cfg)
      const ctx = doc.createElement('canvas').getContext('2d'), wctx = doc.createElement('canvas').getContext('2d')
      composeFrame(ctx, wctx, { width: 640, height: 360 }, fsFor(tier), post, [])
      expect(!!post.flash, tier).toBe(layered)
    }
    const post = createPostState(cfg)
    const fs = fsFor('high'); fs.handled.flashlight = true
    composeFrame(doc.createElement('canvas').getContext('2d'), doc.createElement('canvas').getContext('2d'), { width: 640, height: 360 }, fs, post, [])
    expect(post.flash).toBeUndefined()
  })
})
