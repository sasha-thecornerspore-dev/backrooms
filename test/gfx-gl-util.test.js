// gfx-gl-util.js (the pure parts: column packing, the probe against fake canvases), gfx-frame.js, and pickRenderer's harness escape hatch.
// The GL calls themselves are exercised by the harness (tools/gfx/run.mjs --ropts '{"renderer":"gpu","allowSoftwareGl":true}') on SwiftShader.
import { describe, it, expect } from 'vitest'
import { COL_FAR, COL_ROWS, packColumn, newColumnBuffer, probeGl, GlError } from '../src/renderer/gfx-gl-util.js'
import { FOV, HF, horizonRow, buildFrameState } from '../src/renderer/gfx-frame.js'
import { pickRenderer } from '../src/renderer/gfx-quality.js'
import { TIERS } from '../src/renderer/gfx-quality.js'

describe('column texture layout', () => {
  it('is W x 2 RGBA texels, row 0 first', () => {
    const W = 5, b = newColumnBuffer(W)
    expect(b.length).toBe(W * COL_ROWS * 4)
    packColumn(b, W, 3, [7.5, 0.25, 2, 1], [9, 8, 7, 6])
    expect([...b.slice(12, 16)]).toEqual([7.5, 0.25, 2, 1])            // row 0, texel 3
    expect([...b.slice((W + 3) * 4, (W + 3) * 4 + 4)]).toEqual([9, 8, 7, 6])   // row 1, texel 3
    expect(COL_FAR).toBeGreaterThan(1e8)
  })
  it('leaves row 1 alone when none is given', () => {
    const b = newColumnBuffer(2); b.fill(-1); packColumn(b, 2, 0, [1, 2, 3, 4])
    expect([...b.slice(8, 12)]).toEqual([-1, -1, -1, -1])
  })
})

describe('probeGl', () => {
  const fakeCanvas = (strictGl, laxGl) => () => ({ width: 0, height: 0, getContext: (kind, o) => (o && o.failIfMajorPerformanceCaveat ? strictGl : laxGl) })
  const fakeGl = (renderer = 'ANGLE (NVIDIA)') => ({
    RENDERER: 1, MAX_TEXTURE_SIZE: 2, MAX_ARRAY_TEXTURE_LAYERS: 3,
    getExtension: (n) => (n === 'WEBGL_debug_renderer_info' ? { UNMASKED_RENDERER_WEBGL: 9 } : n === 'EXT_color_buffer_float' ? {} : null),
    getParameter: (p) => (p === 9 ? renderer : p === 2 ? 8192 : p === 3 ? 2048 : renderer),
    isContextLost: () => false,
  })
  it('reports no WebGL2 when neither context can be made', () => {
    expect(probeGl(fakeCanvas(null, null))).toMatchObject({ ok: false, webgl2: false, reason: 'no-webgl2' })
  })
  it('accepts a hardware (strict) context and reads its capabilities', () => {
    const p = probeGl(fakeCanvas(fakeGl(), null))
    expect(p).toMatchObject({ ok: true, webgl2: true, majorPerformanceCaveat: false, reason: 'ok', unmaskedRenderer: 'ANGLE (NVIDIA)' })
    expect(p.caps).toMatchObject({ maxTexture: 8192, maxArrayLayers: 2048, floatTarget: true })
  })
  it('refuses a software-only context (strict fails, lax works) unless the harness opts in', () => {
    const sw = fakeGl('ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device))')
    expect(probeGl(fakeCanvas(null, sw))).toMatchObject({ ok: false, majorPerformanceCaveat: true, reason: 'software-gl' })
    expect(probeGl(fakeCanvas(null, sw), { allowSoftware: true })).toMatchObject({ ok: true, reason: 'software-allowed' })
  })
  it('refuses a lost context', () => {
    const g = { ...fakeGl(), isContextLost: () => true }
    expect(probeGl(fakeCanvas(g, null))).toMatchObject({ ok: false, reason: 'context-lost' })
  })
  it('GlError carries its stage and the driver log', () => {
    const e = new GlError('shader', 'boom', 'line 3: syntax')
    expect(e.stage).toBe('shader'); expect(e.log).toBe('line 3: syntax'); expect(e.message).toContain('line 3')
  })
})

describe('gfx-frame', () => {
  it('has the field of view the raycaster always used', () => { expect(FOV).toBeCloseTo(Math.PI / 2.4, 12); expect(HF).toBeCloseTo(FOV / 2, 12) })
  it('puts the horizon at half height, moved by the bob at the tier scale', () => {
    expect(horizonRow(400, 0, 0.6)).toBe(200)
    expect(horizonRow(400, undefined, 0.6)).toBe(200)
    expect(horizonRow(400, 10, 0.5)).toBe(205)
  })
  it('builds the frame state both backends read', () => {
    const player = { x: 1, y: 2, angle: 0.5, bobOffset: 4 }
    const fs = buildFrameState({ W: 100, H: 60, OW: 160, OH: 100, fog: 20, fogRgb: [1, 2, 3], fogMul: 1, flicker: 0.3, frame: 6, timing: null, player, lights: {}, lightsOn: true,
      hasSky: false, skyRgb: null, light: null, quality: TIERS.medium, opts: { qualityTier: 'medium' }, levelKey: '0', look: undefined })
    expect(fs).toMatchObject({ W: 100, H: 60, OW: 160, OH: 100, fog: 20, rawFlicker: 0.3, frame: 6, levelKey: '0', fov: FOV, hf: HF })
    expect(fs.HH).toBe(horizonRow(60, 4, TIERS.medium.scale))
    expect(fs.t).toBeCloseTo(0.1, 12); expect(fs.dt).toBeCloseTo(1 / 60, 12)
    expect(fs.flicker).toBeGreaterThanOrEqual(0.5)                        // comfort-clamped for a real tier
    expect(fs.handled).toEqual({ flashlight: false, glow: false })
    const t = buildFrameState({ ...{ W: 1, H: 1, OW: 1, OH: 1, fog: 1, fogRgb: [0, 0, 0], fogMul: 1, flicker: 1, frame: 1, player, lights: {}, quality: TIERS.medium, opts: {} }, timing: { t: 2.5, dt: 0.02 } })
    expect(t.t).toBe(2.5); expect(t.dt).toBe(0.02)
  })
})

describe('pickRenderer: harness escape hatch', () => {
  const probeSw = { webgl2: true, majorPerformanceCaveat: true }
  it('a software GL is CPU unless allowSoftware (test harness only)', () => {
    expect(pickRenderer({ pref: 'gpu', probe: probeSw, unmaskedRenderer: 'SwiftShader' })).toEqual({ backend: 'cpu', reason: 'software-gl' })
    expect(pickRenderer({ pref: 'gpu', probe: probeSw, unmaskedRenderer: 'SwiftShader', allowSoftware: true })).toEqual({ backend: 'gpu', reason: 'forced' })
  })
  it('the URL and pref kill switches still win over allowSoftware', () => {
    expect(pickRenderer({ pref: 'gpu', urlOverride: 'cpu', probe: probeSw, allowSoftware: true }).backend).toBe('cpu')
    expect(pickRenderer({ pref: 'cpu', probe: probeSw, allowSoftware: true }).backend).toBe('cpu')
  })
})
