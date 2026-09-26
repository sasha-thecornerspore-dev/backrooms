// Fixer JP / H4-2: the cached flashlight layer (low / medium: the player's whole flashlight) must not silently vanish when its 2D context is lost
// and restored (a GPU-process restart, a driver reset, a sleep/resume clears a GPU-backed canvas). The layer asks its context every frame
// (isContextLost) and listens for 'contextlost' / 'contextrestored' on its canvas: while lost the gradient is filled directly, once back the layer
// is redrawn. The veil (vignette + shadow lift) is redrawn after a loss too. A healthy context changes nothing.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { flashLayer, drawLights, drawGrade, createPostState, lightBox } from '../src/renderer/gfx-post.js'
import { TIERS } from '../src/renderer/gfx-quality.js'

afterEach(() => { vi.unstubAllGlobals() })

// A document whose canvases hand out a recording 2D context that can be LOST: ctx.lose() makes isContextLost() true and fires 'contextlost',
// ctx.restore() clears the canvas (as Chrome does), makes it false and fires 'contextrestored'. c.fire(type) fires an event without touching
// the context (a loss and restore that both happen between two frames). ctx.fills counts the gradient fills into it.
function lossyDoc() {
  const doc = { created: 0, canvases: [] }
  doc.createElement = () => {
    doc.created++
    const ls = {}
    const c = {
      width: 300, height: 150, style: {}, painted: false,
      addEventListener(type, fn) { (ls[type] || (ls[type] = [])).push(fn) },
      fire(type) { for (const fn of ls[type] || []) fn({ type }) },
      listeners: (type) => (ls[type] || []).length,
      getContext() { return ctx },
    }
    let lost = false
    const ctx = {
      canvas: c, calls: [], fills: 0,
      isContextLost: () => lost,
      lose() { lost = true; c.fire('contextlost') },
      restore() { lost = false; c.painted = false; c.fire('contextrestored') },
      createRadialGradient: () => ({ addColorStop() {} }),
      createLinearGradient: () => ({ addColorStop() {} }),
      setTransform() {},
      fillRect(...a) { this.calls.push(['fillRect', ...a]); if (!lost) { this.fills++; c.painted = true } },
      drawImage(...a) { this.calls.push(['drawImage', ...a]) },
    }
    doc.canvases.push(c)
    return c
  }
  return doc
}
// the visible canvas's context: records calls, never lost (save / restore are the canvas API's here)
function screenCtx() {
  const calls = []
  return { calls, save() {}, restore() {}, fillRect(...a) { calls.push(['fillRect', ...a]) }, drawImage(...a) { calls.push(['drawImage', ...a]) }, createRadialGradient: () => ({ addColorStop() {} }) }
}

const cfg = { levelIndex: 2, palette: { fog: '#20242a' }, particles: { count: 0 } }
const fsFor = (tier, OW = 1280, OH = 720) => ({
  W: OW >> 1, H: OH >> 1, OW, OH, t: 0.5, dt: 1 / 60, frame: 3, flicker: 1, rawFlicker: 1, fov: 1.309, player: { x: 1, y: 1, angle: 0 }, lights: { flashlight: true },
  opts: { grain: false, particles: false, crosshair: false, bloom: false }, quality: TIERS[tier], levelKey: '2', handled: { flashlight: false, glow: false }, light: { enabled: tier !== 'legacy' },
})
const blits = (ctx) => ctx.calls.filter((c) => c[0] === 'drawImage')
const fills = (ctx) => ctx.calls.filter((c) => c[0] === 'fillRect')

describe('the flashlight layer and a lost 2D context', () => {
  it('a healthy context: built once, reused every frame (one isContextLost check), listeners attached once', () => {
    const doc = lossyDoc(); vi.stubGlobal('document', doc)
    const post = createPostState(cfg)
    const f = flashLayer(post, 1280, 720)
    expect(f.canvas.painted).toBe(true); expect(f.canvas.getContext().fills).toBe(1)
    for (let i = 0; i < 5; i++) expect(flashLayer(post, 1280, 720)).toBe(f)
    expect(f.canvas.getContext().fills).toBe(1)
    flashLayer(post, 960, 540)                                                // a resize redraws the same canvas: no second pair of listeners
    expect(f.canvas.listeners('contextrestored')).toBe(1); expect(f.canvas.listeners('contextlost')).toBe(1)
    expect(doc.created).toBe(1)
  })
  it('lost: drawLights fills the gradient directly; restored: the layer is redrawn and blitted again (the flashlight never disappears)', () => {
    const doc = lossyDoc(); vi.stubGlobal('document', doc)
    const post = createPostState(cfg)
    const fs = fsFor('medium')
    let ctx = screenCtx(); drawLights(ctx, fs, post)
    const layer = post.flash, lctx = layer.canvas.getContext()
    expect(blits(ctx)).toHaveLength(1); expect(fills(ctx)).toHaveLength(0)
    lctx.lose()
    for (let i = 0; i < 3; i++) {
      ctx = screenCtx(); drawLights(ctx, fs, post)
      expect(blits(ctx)).toHaveLength(0)                                      // the blank layer is not trusted
      expect(fills(ctx).map((c) => c.slice(1))).toEqual([lightBox(640, 720 * 0.52, 720 * 0.72, 1280, 720)])
    }
    lctx.restore()
    expect(layer.canvas.painted).toBe(false)                                  // (the restore cleared it)
    ctx = screenCtx(); drawLights(ctx, fs, post)
    expect(layer.canvas.painted).toBe(true)                                   // redrawn
    expect(post.flash.canvas).toBe(layer.canvas)                              // in the same canvas
    expect(blits(ctx)).toHaveLength(1); expect(fills(ctx)).toHaveLength(0)
    ctx = screenCtx(); drawLights(ctx, fs, post)
    expect(lctx.fills).toBe(2)                                                // and then cached again
  })
  it('a loss AND restore between two frames (isContextLost already false again) is caught by the canvas events', () => {
    const doc = lossyDoc(); vi.stubGlobal('document', doc)
    const post = createPostState(cfg)
    const f = flashLayer(post, 1280, 720), c = f.canvas
    c.painted = false; c.fire('contextlost'); c.fire('contextrestored')       // cleared behind our back
    const g = flashLayer(post, 1280, 720)
    expect(c.painted).toBe(true); expect(c.getContext().fills).toBe(2)
    expect(g.canvas).toBe(c)
    expect(flashLayer(post, 1280, 720)).toBe(g)                               // a single redraw, not one per frame
    expect(c.getContext().fills).toBe(2)
  })
  it('an event from a canvas the post state no longer uses changes nothing', () => {
    const doc = lossyDoc(); vi.stubGlobal('document', doc)
    const post = createPostState(cfg)
    const c = flashLayer(post, 1280, 720).canvas
    post.flash = null
    expect(() => c.fire('contextrestored')).not.toThrow()
    expect(post.flash).toBeNull()
  })
})

describe('the veil and a lost 2D context', () => {
  it('is redrawn at the next frame after a restore (it is built once per size otherwise)', () => {
    const doc = lossyDoc(); vi.stubGlobal('document', doc)
    const post = createPostState(cfg)
    const fs = fsFor('medium', 640, 360), wctx = screenCtx()
    drawGrade(wctx, fs, post)
    const veil = post.veil, vctx = veil.getContext()
    expect(vctx.fills).toBe(1)
    drawGrade(wctx, fs, post); expect(vctx.fills).toBe(1)
    vctx.lose(); vctx.restore()
    drawGrade(wctx, fs, post)
    expect(post.veil).toBe(veil); expect(vctx.fills).toBe(2); expect(veil.painted).toBe(true)
    drawGrade(wctx, fs, post); expect(vctx.fills).toBe(2)
    expect(veil.listeners('contextrestored')).toBe(1)
  })
})
