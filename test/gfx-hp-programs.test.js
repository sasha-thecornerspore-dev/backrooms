// Track HP / task 4: the GPU post pass QUEUES its nine programs at creation (startProgram: nothing blocks) and COLLECTS them (finishProgram, the
// uniform check, the static uniforms) at first use or as soon as the driver reports them finished — with the same failure semantics as before:
// every program must compile, link and expose its uniforms, or a GlError is thrown (now by the render that collects it). Fake WebGL2, no GPU.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { createPostPass } from '../src/renderer/gfx-gl-post.js'
import { GlError } from '../src/renderer/gfx-gl-util.js'
import { TIERS } from '../src/renderer/gfx-quality.js'
import { DEFAULT_CONFIG } from '../src/renderer/world.js'
import { levelConfig } from '../src/renderer/levels.js'
import { fakeGl, fakeDoc2d } from './gfx-hp-fakes.js'

afterEach(() => { vi.unstubAllGlobals() })

function rig(glOpts = {}) {
  const doc = fakeDoc2d(); vi.stubGlobal('document', doc)
  const gl = fakeGl(glOpts)
  const canvas = doc.createElement('canvas'); canvas.width = 160; canvas.height = 90
  const env = { gl, canvas, config: levelConfig(DEFAULT_CONFIG, 0), ropts: {}, caps: {}, tri: { draw() {}, dispose() {} } }
  return { gl, env, st: gl.state }
}
const fsFor = (tier, frame = 1, over = {}) => ({
  W: 80, H: 45, OW: 160, OH: 90, t: frame / 60, dt: 1 / 60, frame, flicker: 1, rawFlicker: 1, fov: 1.309, player: { x: 5, y: 5, angle: 0 }, lights: {},
  opts: { grain: true, particles: false, crosshair: true }, quality: TIERS[tier], levelKey: '0', handled: { flashlight: false, glow: false }, light: { enabled: tier !== 'legacy' }, ...over,
})
const world = { W: 80, H: 45, sceneTex: {} }
const linkQueries = (st) => st.statusQueries

describe('post programs: queued at creation, collected on use', () => {
  it('creation queues all nine and asks the driver nothing (no status query can block)', () => {
    const r = rig({ parallel: true }); r.st.ready = () => false
    const pass = createPostPass(r.env)
    expect(r.st.programs.length).toBe(9)
    expect(r.st.programs.every((p) => p.linked)).toBe(true)                // compile + link were requested ...
    expect(linkQueries(r.st)).toBe(0)                                       // ... but nothing was asked back
    pass.dispose()
    expect(r.st.deletedPrograms).toBe(9)                                    // dispose releases the programs still queued
  })
  it('with the parallel extension: a frame collects what it uses plus whatever the driver has finished; the rest wait', () => {
    const r = rig({ parallel: true }); r.st.ready = () => false
    const pass = createPostPass(r.env)
    pass.render(fsFor('legacy'), world, [])                                 // legacy: grain compose + upscale only
    const collected = r.st.statusQueries
    expect(collected).toBeGreaterThan(0)
    const q1 = r.st.statusQueries
    pass.render(fsFor('legacy', 2), world, [])
    expect(r.st.statusQueries).toBe(q1)                                     // nothing new was needed, nothing reported ready: no query
    r.st.ready = () => true
    pass.render(fsFor('legacy', 3), world, [])                              // now the driver says the rest are done: collected off the critical path
    const q3 = r.st.statusQueries
    expect(q3).toBeGreaterThan(q1)
    pass.render(fsFor('high', 4, { opts: { grain: true, particles: true, crosshair: true, bloom: true }, lights: { flashlight: true } }), world, [])
    expect(r.st.statusQueries).toBe(q3)                                     // bloom / particles / lights were already collected
    pass.dispose()
  })
  it('without the extension every program is collected by the first frame (the status query blocks either way)', () => {
    const r = rig({ parallel: false })
    const pass = createPostPass(r.env)
    expect(linkQueries(r.st)).toBe(0)
    pass.render(fsFor('legacy'), world, [])
    const q = r.st.statusQueries
    pass.render(fsFor('high', 2, { opts: { grain: true, particles: true, crosshair: true, bloom: true }, lights: { flashlight: true } }), world, [])
    expect(r.st.statusQueries).toBe(q)
    pass.dispose()
  })
})

describe('post programs: failure semantics', () => {
  it('a fragment shader that does not compile is a GlError naming the program (thrown by the render that collects it)', () => {
    const r = rig({ parallel: false, failCompile: 'uBloomGain' })        // the compose program
    const pass = createPostPass(r.env)                                      // (creation only queues)
    let e = null; try { pass.render(fsFor('medium'), world, []) } catch (x) { e = x }
    expect(e).toBeInstanceOf(GlError); expect(e.stage).toBe('shader'); expect(e.message).toMatch(/post\.compose fragment shader failed to compile/)
    expect(() => pass.render(fsFor('medium', 2), world, [])).toThrow(GlError)          // asked again: still a GlError, not a TypeError
    pass.dispose()
  })
  it('a program that is not used this frame still fails as soon as it is collected', () => {
    const r = rig({ parallel: true, failLink: 'uTint' }); r.st.ready = () => false    // bright (bloom only)
    const pass = createPostPass(r.env)
    expect(() => pass.render(fsFor('legacy'), world, [])).not.toThrow()     // not needed, not finished: not reported yet
    r.st.ready = () => true
    expect(() => pass.render(fsFor('legacy', 2), world, [])).toThrow(/post\.bright failed to link/)
    pass.dispose()
  })
  it('a uniform the driver optimised away is a GlError, not a silent no-op at draw time', () => {
    const r = rig({ parallel: false, dropUniform: 'uVeilD' })
    const pass = createPostPass(r.env)
    let e = null; try { pass.render(fsFor('medium'), world, []) } catch (x) { e = x }
    expect(e).toBeInstanceOf(GlError); expect(e.stage).toBe('post'); expect(e.message).toMatch(/compose: uniform uVeilD/)
    pass.dispose()
  })
  it('a context that cannot create a shader fails at creation and leaves nothing queued', () => {
    const r = rig({ parallel: true })
    let n = 0
    r.env.gl = new Proxy(r.gl, { get(o, k) { if (k === 'createShader') return (t) => (++n > 5 ? null : o.createShader(t)); const v = o[k]; return v } })
    expect(() => createPostPass(r.env)).toThrow(GlError)
    expect(r.st.deletedPrograms).toBe(2)                                    // the two programs already queued were released
  })
})
