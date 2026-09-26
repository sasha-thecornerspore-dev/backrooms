// Track HS (sprites), GPU side: the sprite program is built in two phases (gfx-gl-util.js startProgram / programReady / finishProgram) so that with
// KHR_parallel_shader_compile the driver compiles it alongside the other passes' programs and the level's sprite frames, and it is collected at the
// latest on first use. Failure semantics stay the same: a shader that does not compile / link, a missing uniform or a misbound attribute is a GlError.
// Driven against a scripted WebGL2 context (the GL itself is exercised by the harness and tools/gfx/g2-parity.cjs).
import { describe, it, expect, vi } from 'vitest'
import { createSpritePass } from '../src/renderer/gfx-gl-sprites.js'
import { GlError } from '../src/renderer/gfx-gl-util.js'

const UNIFORMS = ['uAtlas', 'uRim', 'uCols', 'uDith', 'uRes', 'uAtlasSize']
function scriptedGl({ parallel = false, done = true, linkOk = true, fsCompileOk = true, uniforms = UNIFORMS } = {}) {
  const log = []
  const consts = new Map()
  const c = (k) => { if (!consts.has(k)) consts.set(k, 0x1000 + consts.size); return consts.get(k) }
  let id = 0
  const state = { done }
  const target = {
    log, state,
    getError: () => c('NO_ERROR'),
    getExtension: (n) => (n === 'KHR_parallel_shader_compile' && parallel ? { COMPLETION_STATUS_KHR: c('COMPLETION_STATUS_KHR') } : null),
    getParameter: () => 4096,
    isContextLost: () => false,
    createShader: (t) => ({ id: ++id, t, kind: 'shader' }),
    shaderSource: (s, src) => { s.src = src },
    compileShader: () => log.push('compile'),
    createProgram: () => ({ id: ++id, kind: 'program', shaders: [] }),
    attachShader: (p, s) => p.shaders.push(s),
    linkProgram: () => log.push('link'),
    deleteShader: () => log.push('deleteShader'),
    deleteProgram: () => log.push('deleteProgram'),
    getShaderParameter: (s) => { log.push('q-compile'); return s.t === c('VERTEX_SHADER') ? true : fsCompileOk },
    getShaderInfoLog: () => 'FRAGMENT LOG',
    getProgramInfoLog: () => 'LINK LOG',
    getProgramParameter: (p, k) => {
      if (k === c('LINK_STATUS')) { log.push('q-link'); return linkOk && fsCompileOk }
      if (k === c('COMPLETION_STATUS_KHR')) { log.push('q-done'); return state.done }
      if (k === c('ACTIVE_UNIFORMS')) return uniforms.length
      return 0
    },
    getActiveUniform: (p, i) => ({ name: uniforms[i] }),
    getUniformLocation: (p, n) => ({ n }),
    getAttribLocation: (p, n) => Number(n.slice(2)),
    createTexture: () => ({ id: ++id, kind: 'texture' }),
    texImage2D: () => log.push('tex'),
    deleteTexture: () => log.push('deleteTexture'),
    useProgram: () => log.push('use'),
    drawArraysInstanced: () => log.push('draw'),
  }
  return new Proxy(target, {
    get(t, k) {
      if (k in t) return t[k]
      if (typeof k === 'string' && /^[A-Z][A-Z0-9_]+$/.test(k)) return c(k)
      return () => ({})
    },
  })
}

const FOV = Math.PI / 2.4
const fs = { W: 160, H: 90, HH: 45, fog: 16, fogRgb: [120, 110, 90], flicker: 1, t: 1, dt: 1 / 60, hf: FOV / 2, player: { x: 0, y: 0, angle: 0 }, opts: {}, lights: {}, comfort: {}, levelKey: 'test' }
const world = { W: 160, H: 90, sceneFbo: {}, colsTex: {} }
const crate = [{ kind: 'prop', type: 'crate', x: 4, y: 0, rot: 5.6, key: 'c' }]
const frozen = (fn) => { const spy = vi.spyOn(performance, 'now').mockReturnValue(0); try { return fn() } finally { spy.mockRestore() } }
const make = (gl) => createSpritePass({ gl, caps: { maxTexture: 4096 }, ropts: {}, config: null })
const at = (log, k) => log.indexOf(k)

describe('HS: the sprite program compiles in parallel with the rest of the GPU start-up', () => {
  it('is queued before the pass makes any texture, so the driver compiles it while the atlas and the level\'s frames are built', () => {
    const gl = scriptedGl({ parallel: true, done: false })
    make(gl)
    expect(at(gl.log, 'link')).toBeGreaterThanOrEqual(0)
    expect(at(gl.log, 'link')).toBeLessThan(at(gl.log, 'tex'))
    expect(gl.log).not.toContain('q-link')                              // not waited for
  })
  it('without KHR_parallel_shader_compile it is collected at the end of creation (the status query blocks wherever it is asked)', () => {
    const gl = scriptedGl({ parallel: false })
    const pass = make(gl)
    expect(gl.log).toContain('q-link')
    expect(at(gl.log, 'q-link')).toBeGreaterThan(at(gl.log, 'tex'))    // after the pass's own set-up, not before it
    expect(pass.programState).toBe('ready')
  })
  it('with the extension and a driver that has already finished, it is collected at creation', () => {
    const gl = scriptedGl({ parallel: true, done: true })
    expect(make(gl).programState).toBe('ready')
  })
  it('still compiling: the first render that finds it done collects it; a frame with nothing to draw never waits for it', () => {
    const gl = scriptedGl({ parallel: true, done: false })
    const pass = make(gl)
    expect(pass.programState).toBe('compiling')
    frozen(() => pass.render(fs, [], world))
    expect(gl.log).not.toContain('q-link')
    frozen(() => pass.render({ ...fs, t: 1.1 }, [{ kind: 'prop', type: 'crate', x: 40, y: 0, rot: 5.6, key: 'far' }], world))   // beyond the fog: nothing drawn
    expect(gl.log).not.toContain('q-link')
    gl.state.done = true
    frozen(() => pass.render(fs, crate, world))
    expect(pass.programState).toBe('ready')
    expect(at(gl.log, 'q-link')).toBeLessThan(at(gl.log, 'use'))
    expect(gl.log).toContain('draw')
  })
  it('still compiling at the first frame with sprites: collected on that first use (the query then blocks), and drawn', () => {
    const gl = scriptedGl({ parallel: true, done: false })
    const pass = make(gl)
    frozen(() => pass.render(fs, crate, world))
    expect(pass.programState).toBe('ready')
    expect(gl.log).toContain('draw')
  })
})

describe('HS: the sprite program fails as before (GlError), wherever it is collected', () => {
  it('a fragment shader that does not compile: GlError(shader) at creation without the extension, and the pass frees its textures', () => {
    const gl = scriptedGl({ parallel: false, fsCompileOk: false })
    let e = null
    try { make(gl) } catch (x) { e = x }
    expect(e).toBeInstanceOf(GlError); expect(e.stage).toBe('shader'); expect(String(e.log)).toBe('FRAGMENT LOG')
    expect(gl.log.filter((k) => k === 'deleteTexture').length).toBeGreaterThanOrEqual(3)
  })
  it('the same failure found in the background: GlError(shader) from the render() that first needs the program', () => {
    const gl = scriptedGl({ parallel: true, done: false, fsCompileOk: false })
    const pass = make(gl)
    let e = null
    try { frozen(() => pass.render(fs, crate, world)) } catch (x) { e = x }
    expect(e).toBeInstanceOf(GlError); expect(e.stage).toBe('shader')
    expect(gl.log).not.toContain('draw')
  })
  it('a missing uniform is a GlError(sprites) naming it; a context that links but misbinds an attribute is refused too', () => {
    let e = null
    try { make(scriptedGl({ uniforms: UNIFORMS.filter((u) => u !== 'uDith') })) } catch (x) { e = x }
    expect(e).toBeInstanceOf(GlError); expect(e.message).toMatch(/uDith/)
    const gl = scriptedGl()
    gl.getAttribLocation = () => 0
    e = null
    try { make(gl) } catch (x) { e = x }
    expect(e).toBeInstanceOf(GlError); expect(e.message).toMatch(/attribute aI1/)
  })
  it('dispose frees a program that is still compiling', () => {
    const gl = scriptedGl({ parallel: true, done: false })
    const pass = make(gl)
    const n0 = gl.log.length
    pass.dispose()
    const tail = gl.log.slice(n0)
    expect(tail.filter((k) => k === 'deleteShader').length).toBe(2)
    expect(tail).toContain('deleteProgram')
    expect(pass.programState).toBe('none')
  })
})
