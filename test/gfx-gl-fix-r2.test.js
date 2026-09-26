// gfx-gl-fix-r2.test.js — the world-pass review fixes that can be pinned without a GPU: the exact 16-bit-split modulo (SH-06 / W2-07), the packed wall rows
// (W2-04), the shader source contract (W2-01 uNear, SH-02 clamped wall v, SH-04 / W2-08 no early return before flatPixel's result, W2-05 clamped pool index),
// and the two-phase program build (W2-02 / SH-05: queue, then collect; a compile or link failure is still a GlError).
// The look itself (near-field filter, legacy nearest, row edges) is verified by rendering: tools/gfx/parity.mjs and the hug poses.
import { describe, it, expect } from 'vitest'
import { hash2Ref } from '../src/renderer/gfx-gl-world-data.js'
import { worldFragmentSource, worldUniformNames } from '../src/renderer/gfx-gl-world-shader.js'
import { createWorldPass, wallRows, startProgram, finishProgram, programReady } from '../src/renderer/gfx-gl-world.js'
import { GlError } from '../src/renderer/gfx-gl-util.js'
import { buildTextures } from '../src/renderer/gfx-textures.js'
import { createLight } from '../src/renderer/gfx-light.js'
import { levelConfig } from '../src/renderer/levels.js'
import { DEFAULT_CONFIG } from '../src/renderer/world.js'

// The GLSL modExact, spelled out in JS with the operand widths the GPU sees. `bound` collects every intermediate so the test can prove each one is
// exactly representable in fp32 (below 2^24).
function modExactRef(h, n, bound) {
  n = Math.max(n, 1)
  const hi = h >>> 16, lo = h & 65535
  const a = hi % n, b = 65536 % n, c = a * b, d = lo % n
  if (bound) bound.push(hi, lo, a, b, c, d, c + d)
  return (c + d) % n
}

describe('modExact (SH-06 / W2-07): h % n through 16-bit halves is exact', () => {
  const hashes = [0, 1, 2, 65535, 65536, 65537, 0x7fffffff, 0x80000000, 0xfffe0000, 0xffffffff, 0x01000000, 0x00ffffff, 0x01000001, 4294967295 - 12345]
  for (let a = -40; a <= 40; a += 3) for (let b = -40; b <= 40; b += 7) for (const c of [1, 2]) hashes.push(hash2Ref(a, b, c))
  let s = 123456789
  for (let i = 0; i < 3000; i++) { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; hashes.push(s) }
  it('equals JS % for every hash and every n in 1..16 (and the larger counts up to 255)', () => {
    const bound = [], wrong = []
    for (const h of hashes) {
      for (let n = 1; n <= 16; n++) if (modExactRef(h, n, bound) !== h % n) wrong.push([h, n])
      for (const n of [17, 31, 64, 100, 127, 200, 255]) if (modExactRef(h, n, bound) !== h % n) wrong.push([h, n])
    }
    expect(wrong).toEqual([])
    // every intermediate is an integer below 2^24, so an fp32-based divide cannot round any of them
    expect(bound.every((v) => Number.isInteger(v) && v < (1 << 24))).toBe(true)
  })
  it('the variant pick equals the CPU pick hash2(...) % n in the range where the CPU hash is exact', () => {
    const cpu = (a, b, c, n) => hash2Ref(a, b, c) % n
    for (let a = -300; a <= 300; a += 37) for (let b = -300; b <= 300; b += 41) for (let n = 1; n <= 16; n++) for (const c of [1, 2]) expect(modExactRef(hash2Ref(a, b, c), n)).toBe(cpu(a, b, c, n))
  })
  it('the shader uses it for both floor / ceiling variant picks, and never the raw uint % on the hash', () => {
    for (const lit of [true, false]) {
      const src = worldFragmentSource({ lit, sky: false })
      expect(src).toContain('uint modExact(uint h, uint n)')
      expect(src).toContain('(((h >> 16u) % n) * (65536u % n) + (h & 65535u) % n) % n')
      expect(src).toMatch(/modExact\(hash2u\(cell\.x, cell\.y, isFloor \? 1u : 2u\)/)
      expect(src).not.toMatch(/hash2u\([^)]*\)\s*%/)
    }
  })
})

describe('wallRows (W2-04): the CPU\'s own rows travel with the column', () => {
  const cpuRows = (corr, H, HH) => {
    const whF = H / Math.max(0.001, corr), wtF = HH - whF / 2
    const y0 = Math.max(0, Math.ceil(wtF)), y1 = Math.min(H, Math.floor(wtF + whF))
    return y1 <= y0 ? [0, 0] : [y0, y1]
  }
  const unpack = (pk) => { const y0 = Math.floor(Math.fround(pk) * (1 / 4096)); return [y0, Math.fround(pk) - y0 * 4096] }
  it('round-trips through float32 for a sweep of distances, frame sizes and horizons', () => {
    for (const [H, HH] of [[180, 90], [180, 93.5], [540, 271], [1080, 540.4], [720, 300]]) {
      for (let corr = 0.05; corr < 200; corr *= 1.07) {
        const pk = wallRows(corr, H, HH)
        expect(Math.fround(pk)).toBe(pk)                        // exact in fp32 (what the column texture stores)
        expect(unpack(pk)).toEqual(cpuRows(corr, H, HH))
      }
    }
  })
  it('an empty span (a wall too thin to cover a row) packs to 0, and a frame too tall for the pack asks the shader to recompute (-1)', () => {
    expect(wallRows(1e6, 180, 90)).toBe(0)
    expect(wallRows(2, 4096, 2048)).toBe(-1)
  })
})

describe('the shader source contract', () => {
  const variants = [{ lit: true, sky: false }, { lit: true, sky: true }, { lit: false, sky: false }, { lit: false, sky: true }]
  it('declares uNear (W2-01) and the contract lists it', () => {
    for (const v of variants) {
      const src = worldFragmentSource(v)
      expect(src).toContain('uniform float uNear;')
      expect(worldUniformNames(v)).toContain('uNear')
      expect(src).toMatch(/if \(uNear > 0\.5 && nearK < 1\.0\) w\.x = 1\.0;/)
      expect(src).toContain('const float NEAR_TEXEL = 0.13, NEAR_TEXEL_WALL = 0.17;')      // the CPU's thresholds (gfx-world.js)
    }
  })
  it('clamps the wall v half a texel inside the tile in both wallPixel paths (SH-02), and leaves the floor / ceiling uv alone', () => {
    for (const v of variants) {
      const src = worldFragmentSource(v)
      expect(src).toMatch(v.lit ? /clamp\(v, 0\.5 \/ uTSf, 1\.0 - 0\.5 \/ uTSf\)/ : /clamp\(\(y - wtF\) \/ whF, 0\.5 \/ uTSf, 1\.0 - 0\.5 \/ uTSf\)/)
      expect(src).not.toMatch(/tileAt\(vec2\(wallX, \(y - wtF\) \/ whF\)/)
      expect(src).toMatch(/tileAt\(f, /)                                                     // floors: the raw fraction, REPEAT sampler
    }
  })
  it('flatPixel has no early return for the sky (SH-04 / W2-08); main() routes the sky rows instead', () => {
    for (const v of variants) {
      const src = worldFragmentSource(v)
      const i = src.indexOf('vec3 flatPixel')
      const fp = src.slice(i, src.indexOf('\n}\n', i))
      expect(fp).not.toContain('skyPixel')
      expect(src).toContain('#ifdef SKY\n    if (y <= uHH) col = skyPixel(x, y); else\n#endif')      // compiled in only by the SKY define
      expect(src.includes('#define SKY\n')).toBe(v.sky)
    }
  })
  it('clamps the pool table index (W2-05)', () => {
    const src = worldFragmentSource({ lit: true, sky: false })
    expect(src).toContain('min(int(f.x * 32.0), 31)')
    expect(src).toContain('min(int(f.y * 32.0), 31)')
  })
  it('the wall rows come from the column when supplied (c1.w >= 0) and are recomputed otherwise', () => {
    const src = worldFragmentSource({ lit: true, sky: false })
    expect(src).toContain('if (c1.w >= 0.0) { y0 = floor(c1.w * (1.0 / 4096.0)); y1 = c1.w - y0 * 4096.0; }')
  })
})

// ── the two-phase program build against a scripted context ──
function scriptedGl({ parallel = false, done = true, linkOk = true, fsCompileOk = true } = {}) {
  const log = []
  const consts = new Map()
  const c = (k) => { if (!consts.has(k)) consts.set(k, 0x1000 + consts.size); return consts.get(k) }
  let id = 0
  const state = { done }
  const specOf = (p) => { const f = p.shaders.map((s) => s.src || '').find((s) => s.includes('#define')) || ''; return { lit: f.includes('#define LIT'), sky: f.includes('#define SKY') } }
  const target = {
    log, state,
    getError: () => c('NO_ERROR'),
    getExtension: (n) => (n === 'KHR_parallel_shader_compile' && parallel ? { COMPLETION_STATUS_KHR: c('COMPLETION_STATUS_KHR') } : null),
    getParameter: () => 8,
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
      if (k === c('LINK_STATUS')) { log.push('q-link'); return linkOk }
      if (k === c('COMPLETION_STATUS_KHR')) { log.push('q-done'); return state.done }
      if (k === c('ACTIVE_UNIFORMS')) return worldUniformNames(specOf(p)).length
      return 0
    },
    getActiveUniform: (p, i) => ({ name: worldUniformNames(specOf(p))[i] }),
    getUniformLocation: (p, n) => ({ n }),
  }
  return new Proxy(target, {
    get(t, k) {
      if (k in t) return t[k]
      if (typeof k === 'string' && /^[A-Z][A-Z0-9_]+$/.test(k)) return c(k)
      return () => ({})
    },
  })
}

describe('startProgram / finishProgram / programReady (W2-02 / SH-05)', () => {
  it('startProgram queues the compile and link without asking the driver for anything', () => {
    const gl = scriptedGl()
    const p = startProgram(gl, 'vs', '#version 300 es\n#define LIT\nfs', 'w')
    expect(gl.log).toEqual(['compile', 'compile', 'link'])
    expect(p.label).toBe('w')
  })
  it('finishProgram reads the status, deletes the shaders, and returns the uniform map', () => {
    const gl = scriptedGl()
    const p = finishProgram(startProgram(gl, 'vs', '#version 300 es\n#define LIT\nfs', 'w'))
    expect(gl.log).toContain('q-link')
    expect(Object.keys(p.u)).toEqual(worldUniformNames({ lit: true, sky: false }))
  })
  it('a fragment shader that does not compile is a GlError(shader) carrying the log; a bad link is a GlError(program)', () => {
    let e = null
    try { finishProgram(startProgram(scriptedGl({ linkOk: false, fsCompileOk: false }), 'vs', 'fs', 'w')) } catch (x) { e = x }
    expect(e).toBeInstanceOf(GlError); expect(e.stage).toBe('shader'); expect(e.message).toMatch(/fragment shader failed to compile/); expect(String(e.log)).toBe('FRAGMENT LOG')
    e = null
    try { finishProgram(startProgram(scriptedGl({ linkOk: false }), 'vs', 'fs', 'w')) } catch (x) { e = x }
    expect(e).toBeInstanceOf(GlError); expect(e.stage).toBe('program'); expect(e.message).toMatch(/failed to link/)
  })
  it('programReady polls COMPLETION_STATUS_KHR when the extension exists, and is always true (the query itself blocks) when it does not', () => {
    const gl = scriptedGl({ parallel: true, done: false })
    const p = startProgram(gl, 'vs', 'fs', 'w')
    const ext = gl.getExtension('KHR_parallel_shader_compile')
    expect(programReady(p, ext)).toBe(false)
    gl.state.done = true
    expect(programReady(p, ext)).toBe(true)
    expect(programReady(p, null)).toBe(true)
  })
})

describe('createWorldPass schedules both variants (W2-02 / SH-05)', () => {
  const cfg = levelConfig(DEFAULT_CONFIG, 0)
  const tex = buildTextures(cfg.palette, cfg.materials, cfg.look, '0')
  const make = (gl, tier) => createWorldPass({ gl, config: cfg, tex, light: createLight(cfg, {}), materialAt: null, tri: null, caps: { maxTexture: 4096, maxArrayLayers: 256 }, ropts: { qualityTier: tier } })
  const count = (gl, k) => gl.log.filter((x) => x === k).length
  it('without KHR_parallel_shader_compile both variants are built at creation, so no compile is left for the middle of a frame', () => {
    const gl = scriptedGl({ parallel: false })
    make(gl, 'medium')
    expect(count(gl, 'link')).toBe(2); expect(count(gl, 'q-link')).toBe(2)
  })
  it('with it the creation tier\'s variant is collected at creation and the other is queued to compile in the background', () => {
    const gl = scriptedGl({ parallel: true, done: false })
    make(gl, 'medium')
    expect(count(gl, 'link')).toBe(2); expect(count(gl, 'q-link')).toBe(1)
  })
  it('a level built at the auto tier (legacy first) still builds the lit variant', () => {
    const gl = scriptedGl({ parallel: false })
    make(gl, 'auto')
    expect(count(gl, 'link')).toBe(2)
  })
  it('a shader the driver rejects is a GlError at creation', () => {
    expect(() => make(scriptedGl({ linkOk: false, fsCompileOk: false }), 'medium')).toThrow(GlError)
  })
  it('dispose deletes a variant that is still compiling', () => {
    const gl = scriptedGl({ parallel: true, done: false })
    const pass = make(gl, 'medium')
    const before = count(gl, 'deleteProgram')
    pass.dispose()
    expect(count(gl, 'deleteProgram') - before).toBe(2)     // the collected one and the pending one
  })
})
