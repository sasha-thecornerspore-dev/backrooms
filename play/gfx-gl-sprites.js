// gfx-gl-sprites.js — the GPU SPRITE PASS: the same procedural sprites the CPU path draws (gfx-sprites.js getFrame() frames: premultiplied RGBA layers
// with mip chains, placement rects, modes over / screen, emit, fogK, floor decals, rim planes), drawn as INSTANCED quads into the world pass's
// scene texture and depth-tested per pixel against the world pass's column distances.
//
//   createSpritePass(env) -> { render(fs, entities, world) -> nameplates[], dispose() }
//     env         { gl, tex, light, caps, ropts, tri, config }
//     world       { W, H, sceneFbo, colsTex, ... }: blend INTO world.sceneFbo; depth-test against world.colsTex row 0, texel x, channel R
//                 (the corrected wall distance; COL_FAR = nothing there): a sprite pixel shows where the column's wall is FARTHER than the sprite
//     returns     the remote-player nameplate records exactly as gfx-sprites.js drawSprites() returns them ({sx, y, name, alpha, speech, hp},
//                 sx/y in the internal W x H frame)
//
// SPLIT OF WORK. The CPU half (gfx-gl-sprites-plan.js) is drawSprites' entity logic — cull, MAXS priority cap, far-to-near order, per-kind pose,
// warp, pulse, light, fog, rim and dissolve terms — writing one instance per layer into a reused Float32Array. The atlas bookkeeping is
// gfx-gl-sprites-atlas.js: layer mips are uploaded ON DEMAND (the mip the CPU blitter's pickMip would use) with texSubImage2D, into one RGBA8 atlas
// (+ an R8 plane for the rim data), shelf-packed with a texel gutter; atlas full -> flush (or grow, 1024 up to 2048) and re-plan. This file is the GL: program, buffers, draw.
//
// SHADING (mirrors blitRect / setLayerColour): per fragment
//   over    src.rgb = texel.rgb * m * cm * dk + texel.a * F * dk (+ rim);  src.a = texel.a * A * dk;   blend ONE, ONE_MINUS_SRC_ALPHA
//   screen  src.rgb = texel.rgb * m * cm;                                                        blend ONE, ONE_MINUS_SRC_COLOR
// with m = alpha * light * (1 - fog) * tints, F = fog colour * fog * alpha (0..1), cm the sideways lit-face gradient, dk the dissolve, rim the
// edge light from the nearest emitter. Colours stay in the CPU's non-linear 0..1 space (no sRGB conversion). Consecutive instances of one blend
// mode are drawn together, so the painter's order (far to near, layers in art order) is exactly the CPU's.
//
// Filtering: the CPU picks a mip so texels are 1..1.2 px and samples nearest; here the same mip is sampled bilinearly (hardware), which is
// smoother when a sprite is magnified — welcome — and identical in placement, size and colour.
import { compileProgram, createTexture2D, GlError } from './gfx-gl-util.js'
import { mulberry32 } from './gfx-util.js'
import { prewarmSprites } from './gfx-sprites.js'
import { createAtlasManager, isLittleEndian } from './gfx-gl-sprites-atlas.js'
import { createSpritePlanner, IF, MODE_SCREEN } from './gfx-gl-sprites-plan.js'

const PREWARM_MS = 40
const ATLAS_SIZE = 1024                   // starting side: a worst-case frame (120 mixed entities over 900 frames) peaks at ~41% of it (5 MB RGBA8 + R8)
const ATLAS_MAX = 2048                    // it doubles up to this (and the device's maxTexture) only when a flush did not make room
const STRIDE = IF * 4

const VS = `#version 300 es
precision highp float;
precision highp int;
layout(location = 0) in vec4 aI0;
layout(location = 1) in vec4 aI1;
layout(location = 2) in vec4 aI2;
layout(location = 3) in vec4 aI3;
layout(location = 4) in vec4 aI4;
layout(location = 5) in vec4 aI5;
layout(location = 6) in vec4 aI6;
layout(location = 7) in vec4 aI7;
layout(location = 8) in vec4 aI8;
uniform vec2 uRes;                       // internal W, H
flat out vec4 fA0; flat out vec4 fA1; flat out vec4 fA2; flat out vec4 fA3; flat out vec4 fA4;
flat out vec4 fA5; flat out vec4 fA6; flat out vec4 fA7; flat out vec4 fA8;
void main() {
  // the quad covers the sprite's whole-pixel rect, padded sideways by the warp (lean / sway / ripple), rows floor(Yt) .. ceil(Yb)
  float warp = abs(aI3.x) + abs(aI3.y) + abs(aI3.w);
  float pad = warp > 0.0 ? ceil(warp) + 1.0 : 0.0;
  float xl = floor(aI0.x - pad), xr = ceil(aI0.y + pad);
  float yt = floor(aI0.z), yb = ceil(aI0.w);
  float cx = ((gl_VertexID & 1) == 0) ? xl : xr;
  float cy = ((gl_VertexID & 2) == 0) ? yt : yb;
  gl_Position = vec4(cx / uRes.x * 2.0 - 1.0, 1.0 - cy / uRes.y * 2.0, 0.0, 1.0);
  fA0 = aI0; fA1 = aI1; fA2 = aI2; fA3 = aI3; fA4 = aI4; fA5 = aI5; fA6 = aI6; fA7 = aI7; fA8 = aI8;
}`

const FS = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
uniform sampler2D uAtlas;          // RGBA8, premultiplied
uniform sampler2D uRim;            // R8, the rim planes (128 = none)
uniform sampler2D uCols;           // world column texture: row 0, R = corrected wall distance
uniform sampler2D uDith;           // R8 64x64 dissolve field
uniform vec2 uRes;
uniform vec2 uAtlasSize;
flat in vec4 fA0; flat in vec4 fA1; flat in vec4 fA2; flat in vec4 fA3; flat in vec4 fA4;
flat in vec4 fA5; flat in vec4 fA6; flat in vec4 fA7; flat in vec4 fA8;
out vec4 o;
const float TAU = 6.28318530718;
float sinc(float c) { return sin(TAU * c); }
void main() {
  float px = floor(gl_FragCoord.x);
  float py = uRes.y - 1.0 - floor(gl_FragCoord.y);               // row from the top, as buf32 rows are numbered on the CPU
  // the per-column depth test: the sprite shows where the wall of this column is farther than the sprite
  if (texelFetch(uCols, ivec2(int(px), 0), 0).r <= fA1.x) discard;

  float sw = fA0.y - fA0.x, sh = fA0.w - fA0.z;
  float v = (fA0.w - (py + 0.5)) / sh;                           // 0 at the feet, 1 at the top
  float rx0 = fA0.x + fA3.x * v * v + fA3.y * sinc(fA3.z + v * 0.55) * v + fA3.w * sinc(fA4.x + v * 2.4) * (1.0 - v * 0.55);
  float u = (px + 0.5 - rx0) / sw;
  if (u < 0.0 || u >= 1.0) discard;
  int flags = int(fA1.y + 0.5);
  bool mirror = (flags & 1) != 0, rimOn = (flags & 2) != 0, shadow = (flags & 4) != 0;
  if (mirror) u = 1.0 - u;
  float tv = clamp(1.0 - v, 0.0, 0.9999);

  vec2 rs = fA2.zw;
  vec2 tc = clamp(fA2.xy + vec2(u, tv) * rs, fA2.xy + 0.5, fA2.xy + rs - 0.5);
  vec2 uv = tc / uAtlasSize;
  vec4 p;
  if (shadow) {                                                  // the ground shadow: gfx-sprites.js shadowLayer(), evaluated analytically
    float d = length((vec2(u, tv) - 0.5) * 2.0);
    p = vec4(0.0, 0.0, 0.0, d >= 1.0 ? 0.0 : pow(1.0 - d, 1.25) * 0.9);
  } else {
    p = textureLod(uAtlas, uv, 0.0);          // explicit level: no implicit derivatives after a discard / inside a branch (undefined in GLSL ES 3.00)
  }
  if (p.a <= 0.0) discard;
  float rv = 0.0;
  if (rimOn) rv = textureLod(uRim, uv, 0.0).r * 255.0 - 128.0;

  // "coming apart in the light": drifting bands, eroding from the outline inward
  float dk = 1.0, aK = 1.0;
  if (fA1.z > 0.0) {
    float dith = fA1.z * (0.25 + 1.5 * (0.5 + 0.5 * sinc(py * 0.021 + fA1.w)));
    float dv = texelFetch(uDith, ivec2((int(px) >> 1) & 63, ((int(py) >> 1) + int(fA6.w)) & 63), 0).r * 255.0;
    float thr = rimOn ? dith * (0.15 + 2.7 * abs(rv) / 127.0) : dith;
    if (dv < thr) { dk = 0.55; aK = 0.55; }
  }
  float cm = max(0.15, fA4.y + fA4.z * (px - fA4.w));
  vec3 c = p.rgb * fA5.rgb * (cm * dk) + p.a * fA6.rgb * dk;
  if (rimOn) {
    float e = (mirror ? -rv : rv) * fA7.x + abs(rv) * fA7.y;
    if (e > 0.0) c += vec3(fA7.z, fA7.w, fA8.x) * e * smoothstep(0.0, 0.5, p.a);
  }
  o = vec4(c, p.a * fA5.w * aK);
}`

const UNIFORMS = ['uAtlas', 'uRim', 'uCols', 'uDith', 'uRes', 'uAtlasSize']

export function createSpritePass(env) {
  const { gl, caps } = env
  if (!isLittleEndian()) throw new GlError('sprites', 'a big-endian device: the packed sprite texels would need swizzling')
  const prog = compileProgram(gl, VS, FS, 'sprites')
  for (const n of UNIFORMS) if (prog.u[n] === undefined) throw new GlError('sprites', `uniform ${n} is missing from the compiled sprite program`)
  for (let i = 0; i < 9; i++) {
    if (gl.getAttribLocation(prog.prog, 'aI' + i) !== i) throw new GlError('sprites', `attribute aI${i} is not bound to location ${i}`)
  }

  const want = (env.ropts && env.ropts.spriteAtlasSize) | 0            // a test knob: a fixed small atlas exercises the flush path
  const maxTex = (caps && caps.maxTexture) || ATLAS_MAX
  const size0 = Math.max(64, Math.min(want > 0 ? want : ATLAS_SIZE, maxTex))
  const sizeMax = want > 0 ? size0 : Math.max(size0, Math.min(ATLAS_MAX, maxTex))
  let size = size0
  const mkAtlasTex = (n) => createTexture2D(gl, { w: n, h: n, internal: gl.RGBA8, format: gl.RGBA, type: gl.UNSIGNED_BYTE, min: gl.LINEAR, mag: gl.LINEAR })
  const mkRimTex = (n) => createTexture2D(gl, { w: n, h: n, internal: gl.R8, format: gl.RED, type: gl.UNSIGNED_BYTE, min: gl.LINEAR, mag: gl.LINEAR })
  let atlasTex = mkAtlasTex(size), rimTex = mkRimTex(size)
  // the dissolve field: the same 64x64 byte noise the CPU blitter thresholds against (same PRNG, same seed)
  const dith = new Uint8Array(4096)
  { const r = mulberry32(0xd17e7); for (let i = 0; i < 4096; i++) dith[i] = (r() * 255) | 0 }
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
  const dithTex = createTexture2D(gl, { w: 64, h: 64, internal: gl.R8, format: gl.RED, type: gl.UNSIGNED_BYTE, data: dith, min: gl.NEAREST, mag: gl.NEAREST, wrap: gl.REPEAT })
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4)

  function upload(x, y, w, h, rgba8, rim8) {
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, atlasTex)
    gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, w, h, gl.RGBA, gl.UNSIGNED_BYTE, rgba8)
    if (rim8) {
      gl.bindTexture(gl.TEXTURE_2D, rimTex)
      gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, w, h, gl.RED, gl.UNSIGNED_BYTE, rim8)
    }
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4)
  }
  // growing: allocate the bigger pair first, swap, then free the old one (a failed allocation leaves the old atlas untouched)
  function resize(n) {
    gl.getError()
    const a = mkAtlasTex(n), r = mkRimTex(n)
    if (gl.getError() !== gl.NO_ERROR) { gl.deleteTexture(a); gl.deleteTexture(r); throw new GlError('sprites', 'the sprite atlas could not grow to ' + n) }
    gl.deleteTexture(atlasTex); gl.deleteTexture(rimTex)
    atlasTex = a; rimTex = r; size = n
  }
  const atlas = createAtlasManager({ size, maxSize: sizeMax, upload, resize })
  const planner = createSpritePlanner(atlas, { config: env.config })

  // the instance buffer: nine vec4 attributes, one instance per layer; re-pointed per run (WebGL2 has no base instance)
  const vao = gl.createVertexArray()
  const buf = gl.createBuffer()
  let bufBytes = 0
  gl.bindVertexArray(vao)
  gl.bindBuffer(gl.ARRAY_BUFFER, buf)
  for (let i = 0; i < 9; i++) { gl.enableVertexAttribArray(i); gl.vertexAttribDivisor(i, 1) }
  gl.bindVertexArray(null)
  function pointAt(first) {
    for (let i = 0; i < 9; i++) gl.vertexAttribPointer(i, 4, gl.FLOAT, false, STRIDE, first * STRIDE + i * 16)
  }

  // build the level's frames now under a hard cap, as the CPU renderer does at creation (a cut drops the tail; the draw path builds the rest)
  try { prewarmSprites(env.config, PREWARM_MS) } catch { /* the sprites build lazily anyway */ }

  let warned = false, frameNo = 0
  function render(fs, entities, world) {
    frameNo++
    let res = planner.plan(fs, entities)
    if (res.atlasFull) {
      atlas.recover(frameNo)                                     // the atlas is full: forget it (or, if it filled again soon, grow it) and re-upload what THIS frame needs
      res = planner.plan(fs, entities)
      if (res.atlasFull && atlas.canGrow) { atlas.recover(frameNo, true); res = planner.plan(fs, entities) }     // one frame alone did not fit: grow, once more
      if (res.atlasFull && !warned && typeof console !== 'undefined') { warned = true; console.warn('[gfx-gl-sprites] atlas too small for one frame; some sprites are skipped') }
    }
    if (res.count === 0) return res.plates
    const need = res.count * STRIDE
    gl.bindVertexArray(vao)
    gl.bindBuffer(gl.ARRAY_BUFFER, buf)
    if (need > bufBytes) { bufBytes = Math.max(need, bufBytes * 2, 256 * STRIDE); gl.bufferData(gl.ARRAY_BUFFER, bufBytes, gl.DYNAMIC_DRAW) }
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, res.inst, 0, res.count * IF)

    gl.bindFramebuffer(gl.FRAMEBUFFER, world.sceneFbo)
    gl.viewport(0, 0, world.W, world.H)
    gl.disable(gl.DEPTH_TEST); gl.disable(gl.CULL_FACE); gl.disable(gl.SCISSOR_TEST)
    gl.colorMask(true, true, true, true)
    gl.enable(gl.BLEND)
    gl.useProgram(prog.prog)
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, atlasTex)
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, rimTex)
    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, world.colsTex)
    gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, dithTex)
    const u = prog.u
    gl.uniform1i(u.uAtlas, 0); gl.uniform1i(u.uRim, 1); gl.uniform1i(u.uCols, 2); gl.uniform1i(u.uDith, 3)
    gl.uniform2f(u.uRes, world.W, world.H)
    gl.uniform2f(u.uAtlasSize, size, size)
    let mode = -1
    const runs = res.runs
    for (let r = 0; r < res.runCount; r++) {
      const m = runs[r * 3 + 2]
      if (m !== mode) {
        mode = m
        if (m === MODE_SCREEN) gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_COLOR, gl.ZERO, gl.ONE)
        else gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ZERO, gl.ONE)
      }
      pointAt(runs[r * 3])
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, runs[r * 3 + 1])
    }
    gl.bindVertexArray(null)
    gl.disable(gl.BLEND)
    gl.activeTexture(gl.TEXTURE0)
    return res.plates
  }

  function dispose() {
    gl.deleteProgram(prog.prog)
    gl.deleteTexture(atlasTex); gl.deleteTexture(rimTex); gl.deleteTexture(dithTex)
    gl.deleteBuffer(buf); gl.deleteVertexArray(vao)
  }
  return { render, dispose, get stats() { return { ...atlas.st, fill: atlas.packer.fill } } }
}

