// gfx-gl-util.js — the thin, dependency-free WebGL2 layer the GPU backend is built on (gfx-gl.js and its passes). Every function takes the
// `gl` context (or a canvas factory) as an argument; nothing touches `document`/`window` at module scope, so the pure helpers are unit-tested in
// Node and the GL ones are exercised by the harness (tools/gfx, --renderer gpu, on SwiftShader).
//
//   probeGl(makeCanvas, opts)      can this machine give us a REAL (hardware) WebGL2 context, and what can it do?   -> { ok, reason, ... }
//   compileProgram(gl, vs, fs, label)      compile + link, throwing GlError with the driver's log on failure   -> { prog, u (uniform locations), label }
//   createTexture2D / createTextureArray / createFramebuffer      small wrappers that name every parameter
//   fullscreenTriangle(gl)         one oversized triangle from gl_VertexID (no buffers, no attributes)
//   FULLSCREEN_VS                  the matching vertex shader (`vUv` 0..1 across the target; `gl_FragCoord` is the pixel)
//   COL_* / packColumn             the per-column ray data the CPU uploads (see the layout below)
//
// The COLUMN TEXTURE (contract shared by the world and sprite passes): RGBA32F, W x 2 texels, sampled with texelFetch (NEAREST, no extension).
//   row 0, texel x:  R = corr   perpendicular distance to the wall the column's ray hit (the value the CPU z-buffer holds); COL_FAR when the
//                               ray left the fog radius without a hit — sprites depth-test against exactly this
//                    G = wallX  0..1 along the wall face
//                    B = layer  index of the wall tile in the wall texture array (-1 = none)
//                    A = side   0 = the ray crossed an x-grid line, 1 = a y-grid line
//   row 1, texel x:  free for the world pass (per-column lighting terms); the sprite pass never reads it.

export class GlError extends Error {
  constructor(stage, message, log) {
    super(`${stage}: ${message}${log ? `\n${log}` : ''}`)
    this.name = 'GlError'; this.stage = stage; this.log = log || ''
  }
}

// A column's ray found no wall within the fog radius: farther than anything the frame can show.
export const COL_FAR = 1e9
export const COL_ROWS = 2

// Write one column's texels into a Float32Array laid out row-major as W x COL_ROWS RGBA texels. `r0` = [corr, wallX, layer, side]; `r1` = optional
// [a, b, c, d] for the second row. Pure.
export function packColumn(out, W, col, r0, r1) {
  let o = col * 4
  out[o] = r0[0]; out[o + 1] = r0[1]; out[o + 2] = r0[2]; out[o + 3] = r0[3]
  if (r1) { o = (W + col) * 4; out[o] = r1[0]; out[o + 1] = r1[1]; out[o + 2] = r1[2]; out[o + 3] = r1[3] }
}
export function newColumnBuffer(W) { return new Float32Array(W * COL_ROWS * 4) }

// ── test-run gate ───────────────────────────────────────────────────────────────────────────────────────────────────────────
// The hooks that weaken the production safety rules (renderOpts.allowSoftwareGl = software GL, __failGl = forced failures, gpuValidate = the first-frame
// check on/off) are honoured ONLY when the harness has marked the page as a test run BEFORE the game script ran: tools/gfx/page.cjs (its preload) and
// harness.html set globalThis.__backroomsTestRun = true. Nothing a player can reach (a pref, the URL, the __backroomsRenderOpts hook alone) sets it.
export function isTestRun() { try { return globalThis.__backroomsTestRun === true } catch { return false } }
// the renderOpts hook `key`, or undefined outside a test run
export function harnessOpt(ropts, key) { return ropts && isTestRun() ? ropts[key] : undefined }

// The GL context asks for the high-performance adapter. This is a deliberate choice, not a default: on an Optimus / hybrid laptop it wakes the
// discrete GPU (more heat and power for a game whose GPU work is small) but it also avoids the classic "the browser picked the slow integrated
// GPU for a canvas" outcome, and the probe asks for the same thing so its UNMASKED_RENDERER is the adapter the real context will land on.
export const GL_POWER_PREFERENCE = 'high-performance'

// Give a context back to the browser NOW (browsers cap live contexts at ~16 and warn past it) instead of at the next GC. Never throws.
export function releaseContext(gl) {
  try { const lose = gl && gl.getExtension && gl.getExtension('WEBGL_lose_context'); if (lose) lose.loseContext() } catch { /* already gone */ }
}
// the driver's real renderer string (UNMASKED when the debug extension is there), or null
export function readUnmaskedRenderer(gl) {
  try {
    const ext = gl.getExtension('WEBGL_debug_renderer_info')
    const v = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)
    return typeof v === 'string' && v ? v : null
  } catch { return null }
}

// ── probing ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// A throwaway canvas is asked for a WebGL2 context twice: STRICT (failIfMajorPerformanceCaveat, i.e. only if it is hardware accelerated) and,
// if that fails, LAX (so we can say WHY: no WebGL2 at all, or only a software rasteriser). The UNMASKED_RENDERER string is read for the log and
// for the software check in pickRenderer (gfx-quality.js). `allowSoftware` is for the test harness only: it accepts a lax software context.
// The probe context is released on EVERY path out (ok, software, lost, a throw): renderer.js probes at most once per session anyway.
//   -> { ok, webgl2, majorPerformanceCaveat, unmaskedRenderer, reason, caps: { maxTexture, maxArrayLayers, floatTarget, halfFloatTarget, aniso } }
export function probeGl(makeCanvas, opts = {}) {
  const out = { ok: false, webgl2: false, majorPerformanceCaveat: false, unmaskedRenderer: null, reason: 'no-webgl2', caps: null }
  let gl = null, strict = true
  try {
    const c = makeCanvas(); c.width = 8; c.height = 8
    gl = c.getContext('webgl2', { failIfMajorPerformanceCaveat: true, antialias: false, depth: false, stencil: false, powerPreference: GL_POWER_PREFERENCE })
    if (!gl) {
      strict = false
      const c2 = makeCanvas(); c2.width = 8; c2.height = 8
      gl = c2.getContext('webgl2', { antialias: false, depth: false, stencil: false, powerPreference: GL_POWER_PREFERENCE })
    }
  } catch { gl = null }
  if (!gl) return out
  try {
    out.webgl2 = true
    out.majorPerformanceCaveat = !strict
    out.unmaskedRenderer = readUnmaskedRenderer(gl)
    out.caps = {
      maxTexture: gl.getParameter(gl.MAX_TEXTURE_SIZE) | 0,
      maxArrayLayers: gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS) | 0,
      floatTarget: !!gl.getExtension('EXT_color_buffer_float'),
      halfFloatTarget: !!gl.getExtension('EXT_color_buffer_half_float') || !!gl.getExtension('EXT_color_buffer_float'),
      aniso: !!gl.getExtension('EXT_texture_filter_anisotropic'),
    }
    if (gl.isContextLost()) { out.reason = 'context-lost'; return out }
    if (out.majorPerformanceCaveat && !opts.allowSoftware) { out.reason = 'software-gl'; return out }
    out.ok = true; out.reason = out.majorPerformanceCaveat ? 'software-allowed' : 'ok'
    return out
  } catch { out.ok = false; out.reason = 'probe-failed'; return out }
  finally { releaseContext(gl) }
}

// ── programs ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
export const FULLSCREEN_VS = `#version 300 es
out vec2 vUv;
void main() {
  // one triangle covering the viewport: vertices (-1,-1) (3,-1) (-1,3)
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`

function shader(gl, type, src, label) {
  const s = gl.createShader(type)
  if (!s) throw new GlError('shader', `${label}: createShader returned null (${gl.isContextLost() ? 'the context is lost' : 'out of resources'})`)
  gl.shaderSource(s, src); gl.compileShader(s)
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(s); gl.deleteShader(s)
    throw new GlError('shader', `${label} ${type === gl.VERTEX_SHADER ? 'vertex' : 'fragment'} shader failed to compile`, log)
  }
  return s
}

// -> { prog, u, label }. `u` maps every active uniform name (arrays without the "[0]") to its location. Throws GlError.
export function compileProgram(gl, vsSrc, fsSrc, label = 'program') {
  const vs = shader(gl, gl.VERTEX_SHADER, vsSrc, label), fs = shader(gl, gl.FRAGMENT_SHADER, fsSrc, label)
  const prog = gl.createProgram()
  if (!prog) { gl.deleteShader(vs); gl.deleteShader(fs); throw new GlError('program', `${label}: createProgram returned null`) }
  gl.attachShader(prog, vs); gl.attachShader(prog, fs); gl.linkProgram(prog)
  gl.deleteShader(vs); gl.deleteShader(fs)
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(prog); gl.deleteProgram(prog)
    throw new GlError('program', `${label} failed to link`, log)
  }
  const u = Object.create(null)
  for (let i = 0, n = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS); i < n; i++) {
    const info = gl.getActiveUniform(prog, i)
    u[info.name.replace(/\[0\]$/, '')] = gl.getUniformLocation(prog, info.name)
  }
  return { prog, u, label }
}

// Every uniform a pass sets must exist in the linked program (an unused uniform is optimised out by the driver and silently gets location null): call
// this once at pass creation with the names the draw code will use, so a typo or a dead uniform is a clear GlError there, not a silent no-op at draw time.
export function requireUniforms(program, names) {
  const missing = names.filter((n) => !(n in program.u))
  if (missing.length) throw new GlError('program', `${program.label}: uniform(s) not active in the linked program: ${missing.join(', ')}`)
  return program
}

// ── program build, split in two so the driver can compile in parallel ──
// startProgram queues the compile + link and asks nothing back (asking blocks); finishProgram then reads the status and the uniforms. With
// KHR_parallel_shader_compile the browser's driver threads work on every queued program while the CPU carries on (tile / table uploads, the other passes'
// own programs); without it the first status query blocks until the compile is done, exactly as compileProgram does. A compile or link failure is a GlError.
export function startProgram(gl, vsSrc, fsSrc, label) {
  const mk = (type, src) => {
    const s = gl.createShader(type)
    if (!s) throw new GlError('shader', `${label}: createShader returned null (${gl.isContextLost() ? 'the context is lost' : 'out of resources'})`)
    gl.shaderSource(s, src); gl.compileShader(s)
    return s
  }
  const vs = mk(gl.VERTEX_SHADER, vsSrc), fs = mk(gl.FRAGMENT_SHADER, fsSrc)
  const prog = gl.createProgram()
  if (!prog) { gl.deleteShader(vs); gl.deleteShader(fs); throw new GlError('program', `${label}: createProgram returned null`) }
  gl.attachShader(prog, vs); gl.attachShader(prog, fs); gl.linkProgram(prog)
  return { gl, prog, vs, fs, label }
}

// Is the queued program done (a status query will not block)? Always true when the extension is absent (the query blocks instead).
export function programReady(pending, ext) {
  return !ext || !!pending.gl.getProgramParameter(pending.prog, ext.COMPLETION_STATUS_KHR)
}

export function finishProgram(pending) {
  const { gl, prog, vs, fs, label } = pending
  const fail = (kind, msg, log) => { gl.deleteShader(vs); gl.deleteShader(fs); gl.deleteProgram(prog); throw new GlError(kind, msg, log) }
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) fail('shader', `${label} vertex shader failed to compile`, gl.getShaderInfoLog(vs))
    if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) fail('shader', `${label} fragment shader failed to compile`, gl.getShaderInfoLog(fs))
    fail('program', `${label} failed to link`, gl.getProgramInfoLog(prog))
  }
  gl.deleteShader(vs); gl.deleteShader(fs)
  const u = Object.create(null)
  for (let i = 0, n = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS); i < n; i++) {
    const info = gl.getActiveUniform(prog, i)
    u[info.name.replace(/\[0\]$/, '')] = gl.getUniformLocation(prog, info.name)
  }
  return { prog, u, label }
}

// ── textures and targets ────────────────────────────────────────────────────────────────────────────────────────────────────
// o = { w, h, internal (gl.RGBA8 ...), format (gl.RGBA ...), type (gl.UNSIGNED_BYTE ...), data (or null), min, mag, wrap, mips }
export function createTexture2D(gl, o) {
  const t = gl.createTexture()
  gl.bindTexture(gl.TEXTURE_2D, t)
  gl.texImage2D(gl.TEXTURE_2D, 0, o.internal, o.w, o.h, 0, o.format, o.type, o.data || null)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, o.min ?? gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, o.mag ?? gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, o.wrap ?? gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, o.wrap ?? gl.CLAMP_TO_EDGE)
  if (o.mips) gl.generateMipmap(gl.TEXTURE_2D)
  return t
}

// o = { w, h, layers, internal, format, type, layerData: [typed array per layer] (optional), min, mag, wrap, mips, aniso (max anisotropy or 0) }
export function createTextureArray(gl, o) {
  const t = gl.createTexture()
  gl.bindTexture(gl.TEXTURE_2D_ARRAY, t)
  const levels = o.mips ? 1 + Math.floor(Math.log2(Math.max(o.w, o.h))) : 1
  gl.texStorage3D(gl.TEXTURE_2D_ARRAY, levels, o.internal, o.w, o.h, o.layers)
  if (o.layerData) for (let i = 0; i < o.layerData.length; i++) {
    gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, i, o.w, o.h, 1, o.format, o.type, o.layerData[i])
  }
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, o.min ?? (o.mips ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR))
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, o.mag ?? gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, o.wrap ?? gl.REPEAT)
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, o.wrap ?? gl.REPEAT)
  if (o.aniso > 1) { const e = gl.getExtension('EXT_texture_filter_anisotropic'); if (e) gl.texParameterf(gl.TEXTURE_2D_ARRAY, e.TEXTURE_MAX_ANISOTROPY_EXT, o.aniso) }
  if (o.mips) gl.generateMipmap(gl.TEXTURE_2D_ARRAY)
  return t
}

// a framebuffer with one colour texture attached; throws GlError when the combination is not renderable on this device
export function createFramebuffer(gl, tex, label = 'fbo') {
  const fb = gl.createFramebuffer()
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb)
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0)
  const st = gl.checkFramebufferStatus(gl.FRAMEBUFFER)
  gl.bindFramebuffer(gl.FRAMEBUFFER, null)
  if (st !== gl.FRAMEBUFFER_COMPLETE) { gl.deleteFramebuffer(fb); throw new GlError('framebuffer', `${label} incomplete (0x${st.toString(16)})`) }
  return fb
}

// the vertex-only fullscreen triangle: a VAO with no attributes (WebGL2 needs some VAO bound, the default one is fine)
export function fullscreenTriangle(gl) {
  const vao = gl.createVertexArray()
  return { draw() { gl.bindVertexArray(vao); gl.drawArrays(gl.TRIANGLES, 0, 3); gl.bindVertexArray(null) }, dispose() { gl.deleteVertexArray(vao) } }
}

// Drain the error queue (a few frames' worth at most); returns the first error name or null. Cheap enough for the first frames only.
export function glErrorName(gl) {
  const e = gl.getError()
  if (e === gl.NO_ERROR) return null
  let guard = 0; while (gl.getError() !== gl.NO_ERROR && guard++ < 16) { /* drain */ }
  return { [gl.INVALID_ENUM]: 'INVALID_ENUM', [gl.INVALID_VALUE]: 'INVALID_VALUE', [gl.INVALID_OPERATION]: 'INVALID_OPERATION',
    [gl.OUT_OF_MEMORY]: 'OUT_OF_MEMORY', [gl.CONTEXT_LOST_WEBGL]: 'CONTEXT_LOST_WEBGL' }[e] || `0x${e.toString(16)}`
}

// ── the sibling canvas ──────────────────────────────────────────────────────────────────────────────────────────────────────
// The GL canvas stacked over #c mirrors #c: the same backing-store size, the same css box (game.js sets canvas.style.width/height when the DPR
// ratio is not 1, and canvas.style.transform for the screen shake). Pure: reads only width/height/style of the canvas it is handed.
//   -> { width, height, cssW, cssH, transform }   (css strings are '<n>px' or whatever #c's inline style holds; transform '' when none)
export function siblingLayout(canvas) {
  const s = canvas.style || {}
  return {
    width: canvas.width | 0, height: canvas.height | 0,
    cssW: s.width || `${canvas.width | 0}px`, cssH: s.height || `${canvas.height | 0}px`,
    transform: s.transform || '',
  }
}
