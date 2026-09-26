// gfx-gl-world.js — the GPU WORLD PASS. The CPU keeps everything that decides WHAT is in the world (castRay over the chunk cache, materials, the
// light model's per-frame tables); this pass turns that into pixels: floor, ceiling / sky, walls, lighting and fog, into an offscreen scene texture
// at the internal resolution. It never reads the map: the CPU hands it one row of per-column ray results (the COLUMN TEXTURE, gfx-gl-util.js) so a
// maze that the CPU renderer draws is drawn identically here, and chunk generation, collision and determinism are untouched.
//
//   createWorldPass(env) -> { render(fs, isWallFn) -> world, resize(W, H), dispose() }
//     env    { gl, config, tex (TexSet), light (gfx-light.js model or null), materialAt, caps, ropts, tri (fullscreenTriangle) }
//     world  { W, H, sceneTex, sceneFbo, colsTex, zb (Float32Array, corr per column — the CPU z-buffer), lit }
//   Coordinates: the scene texture is stored bottom-up like every GL texture; the shader numbers rows from the top like the CPU's buf32.
//
// WHAT RUNS WHERE. Per frame the CPU does what gfx-world.js does before it touches a pixel: light.prepare(fs, tex, isWallFn, materialAt) (which builds the
// light model's tables), one castRay per column, the wall's variant and pool share per column (gfx-gl-world-data.js), and uploads the SMALL tables the
// shader reads — only when they change: the cell window (contact bits, lamp fixtures) when the player changes cell, the lamp lightmap likewise (and every
// frame while a flicker event re-mixes it), the panel level grid while an event is in flight. The GPU then evaluates, per pixel, the same formulas as
// renderLegacy / renderLit / renderSky (gfx-gl-world-shader.js). The pass picks the LIT or LEGACY shading with the very condition renderWorld uses,
// sets fs.handled.* exactly when the CPU pass does, and keeps light.enabled in step.
//
// SURFACES. Every tile of the TexSet lives in ONE mipmapped RGBA8 texture array (planTiles): walls (one layer per material, or per variant), floor and
// ceiling variants (chosen per cell in the shader by the same hash2 as the CPU), the light panel. Two samplers pick the look by tier: texFilter 0 samples
// NEAREST (the CPU's crisp texels, no mips), texFilter >= 1 samples trilinear + anisotropic where the device has it (this replaces the CPU's hand-built
// mip chains); the CPU's near-field horizontal 2-tap (texFilter >= 2 or lightDetail >= 2) is the uNear uniform, and the legacy shading, which the CPU never
// filters, is always nearest. The footprint is analytic (textureGrad), so it never depends on neighbouring pixels.
//
// FALLBACKS. Sampling RGBA32F / R32F with texelFetch is core WebGL2 (no extension), so the only float-texture requirement is probed at creation and a
// device that cannot do it throws GlError -> the CPU renderer. There is deliberately no half-float variant: a column's distance and wall coordinate
// (a fraction of a texel) do not survive fp16. Too many tile layers for MAX_ARRAY_TEXTURE_LAYERS, a frame wider than MAX_TEXTURE_SIZE, a missing
// uniform, a shader that does not compile: all GlError at creation (or at the first frame that needs the variant).
import { castRay } from './raycaster.js'
import { rayAsk, rayAskDone } from './gfx-world.js'
import { hexToRgb, levelKey } from './gfx-util.js'
import { resolvePalette } from './gfx-textures.js'
import { FLASH_PITCH, FLASH_SX, FLASH_SY } from './gfx-light.js'
import { cloudStrip, skyConfigFor } from './gfx-sky.js'
import {
  FULLSCREEN_VS, GlError, createTexture2D, createTextureArray, createFramebuffer, COL_FAR, COL_ROWS,
  startProgram, programReady, finishProgram,
} from './gfx-gl-util.js'
import { worldFragmentSource, worldUniformNames } from './gfx-gl-world-shader.js'
import {
  POOL_N, OCC_N, LM_N, LMC_N, LEV_MAX, CLOUD_W, CLOUD_H, planTiles, tilesToRgba, wallLayer, wallPoolShare, fillCellTexture, fillPoolTable, fillWallTable,
  buildSkyRows,
} from './gfx-gl-world-data.js'

const TAU = Math.PI * 2
const WALLX_MAX = 1 - 2 ** -24  // the largest float32 below 1: a wallX stored as fp32 must never round up to 1.0 (that would wrap to texel 0; the CPU clamps to TMASK)
const ROW_PACK = 4096           // the wall's first / last row travel packed as y0 * ROW_PACK + y1 (exact in fp32 while y1 < ROW_PACK and y0 * ROW_PACK + y1 < 2^24)
const GRAD_SCALE = 1.0          // >1 trades sharpness for stability (the CPU biases its mip level by 1.4-1.8)
const MAX_ANISO = 8
const SHARP = 2.5          // soft edge (in pixels) between magnified texels: crisp like the CPU's texels, but antialiased (see tileAt in the shader)

// units: 0 tiles, 1 columns, 2 pool, 3 wall tables, 4 cells, 5 lightmap, 6 lightmap-any, 7 panel levels, 8 sky rows, 9 cloud strip
const UNIT = { tiles: 0, cols: 1, pool: 2, wallTab: 3, cells: 4, lm: 5, lmAny: 6, lev: 7, skyRows: 8, cloud: 9 }

// Can this device sample a float texture with texelFetch? (core in WebGL2, but a lost or software context has been seen to refuse). -> null | reason
function floatTextureProblem(gl) {
  const t = gl.createTexture()
  try {
    gl.bindTexture(gl.TEXTURE_2D, t)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, 2, 1, 0, gl.RGBA, gl.FLOAT, new Float32Array(8))
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, 2, 2, 0, gl.RED, gl.FLOAT, new Float32Array(4))
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    const e = gl.getError()
    return e === gl.NO_ERROR ? null : `float texture upload raised 0x${e.toString(16)}`
  } finally { gl.bindTexture(gl.TEXTURE_2D, null); gl.deleteTexture(t) }
}

// (startProgram / programReady / finishProgram moved to gfx-gl-util.js so every pass can compile in parallel; re-exported here for older imports)
export { startProgram, programReady, finishProgram }

// The wall's first and last row of a column, in the CPU's own double arithmetic (gfx-world.js: ceil(wtF), floor(wtF + whF), clamped to the frame), packed
// as y0 * ROW_PACK + y1; an empty span packs as 0. The shader would recompute these in fp32, which can land a row off for a thin distant wall. A frame
// taller than the pack allows returns -1 and the shader falls back to its own arithmetic.
export function wallRows(corr, H, HH) {
  if (H >= ROW_PACK) return -1
  const whF = H / Math.max(0.001, corr), wtF = HH - whF / 2
  const y0 = Math.max(0, Math.ceil(wtF)), y1 = Math.min(H, Math.floor(wtF + whF))
  return y1 <= y0 ? 0 : y0 * ROW_PACK + y1
}

export function createWorldPass(env) {
  const { gl, config, tex, light, materialAt, tri, caps, ropts } = env
  const maxTex = (caps && caps.maxTexture) || 2048
  const maxLayers = (caps && caps.maxArrayLayers) || 256
  const hasSky = !!config.sky
  // The fog colour, resolved exactly as gfx-cpu.js and gfx-gl.js resolve it (a palette whose fog hex is missing or invalid, e.g. a wish-drifted one,
  // fogs toward the LEVEL's stock fog from levels.js, not a neutral grey), so the walls, floor and ceiling fog toward the colour the sprites and
  // the post pass use. render() prefers the frame's own fs.fogRgb (the value every other stage of the frame reads) and falls back to this.
  const fogRgb = hexToRgb(resolvePalette(config.palette, levelKey(config)).fog)

  const problem = floatTextureProblem(gl)
  if (problem) throw new GlError('caps', `the GPU world pass needs float textures (${problem}); the CPU renderer is used instead`)

  // ── surfaces: one mipmapped texture array ──
  const plan = planTiles(tex)
  const ts = plan.ts
  if (plan.layers.length > maxLayers) throw new GlError('textures', `${plan.layers.length} tile layers exceed MAX_ARRAY_TEXTURE_LAYERS (${maxLayers})`)
  if (ts > maxTex) throw new GlError('textures', `tile size ${ts} exceeds MAX_TEXTURE_SIZE (${maxTex})`)

  // The variant the creation tier will use is queued now, before the tile / table uploads below (the cheap refusals above come first, so nothing is queued
  // for a device that will be refused), so the driver compiles it while this function does its other work; the PROGRAMS block collects it and queues the other.
  const parallel = gl.getExtension('KHR_parallel_shader_compile')
  const F0 = light && light.frame ? light.frame : null          // the light model's parameter block (null: this level has no lighting recipe)
  const queued = new Map()                                      // key -> { pending, lit } for a variant compiling in the background
  const queue = (lit) => {
    const key = lit ? 'lit' : 'legacy'
    if (!queued.has(key)) queued.set(key, startProgram(gl, FULLSCREEN_VS, worldFragmentSource({ lit, sky: hasSky }), `world-${key}${hasSky ? '-sky' : ''}`))
  }
  const firstLit = !!(F0 && ropts && (ropts.qualityTier === 'low' || ropts.qualityTier === 'medium' || ropts.qualityTier === 'high'))
  try {
    queue(firstLit)
  } catch (e) { for (const q of queued.values()) { gl.deleteShader(q.vs); gl.deleteShader(q.fs); gl.deleteProgram(q.prog) } throw e }
  const tilesTex = createTextureArray(gl, {
    w: ts, h: ts, layers: plan.layers.length, internal: gl.RGBA8, format: gl.RGBA, type: gl.UNSIGNED_BYTE, layerData: tilesToRgba(plan), mips: true,
  })
  const aniso = (() => {
    const e = gl.getExtension('EXT_texture_filter_anisotropic')
    return e ? { e, max: Math.min(MAX_ANISO, gl.getParameter(e.MAX_TEXTURE_MAX_ANISOTROPY_EXT) || 1) } : null
  })()
  const mkSampler = (min, mag) => {
    const s = gl.createSampler()
    gl.samplerParameteri(s, gl.TEXTURE_MIN_FILTER, min); gl.samplerParameteri(s, gl.TEXTURE_MAG_FILTER, mag)
    gl.samplerParameteri(s, gl.TEXTURE_WRAP_S, gl.REPEAT); gl.samplerParameteri(s, gl.TEXTURE_WRAP_T, gl.REPEAT)
    return s
  }
  const sNearest = mkSampler(gl.NEAREST, gl.NEAREST)
  const sFiltered = mkSampler(gl.LINEAR_MIPMAP_LINEAR, gl.LINEAR)
  if (aniso && aniso.max > 1) gl.samplerParameterf(sFiltered, aniso.e.TEXTURE_MAX_ANISOTROPY_EXT, aniso.max)

  // ── small static / rarely changing tables ──
  const nearest2D = (o) => createTexture2D(gl, { min: gl.NEAREST, mag: gl.NEAREST, ...o })
  const f32 = (w, h, data, rgba = true) => nearest2D({ w, h, internal: rgba ? gl.RGBA32F : gl.R32F, format: rgba ? gl.RGBA : gl.RED, type: gl.FLOAT, data })
  let poolTex = null, wallTab = null, cellsTex = null, lmTex = null, lmAnyTex = null, levTex = null, cloudTex = null, skyRowsTex = null
  const wallTabW = Math.max(POOL_N, ts)
  let wallTabTs = 0, cellsKey = '', lmKey = '', lastLampDim = false
  const cellBuf = new Uint8Array(OCC_N * OCC_N * 4)
  const wallTabBuf = new Float32Array(wallTabW * 2 * 4)
  if (F0) {
    poolTex = f32(POOL_N, POOL_N * 2, fillPoolTable(F0, new Float32Array(POOL_N * POOL_N * 2 * 4)))
    wallTab = f32(wallTabW, 2, null)
    cellsTex = nearest2D({ w: OCC_N, h: OCC_N, internal: gl.RGBA8, format: gl.RGBA, type: gl.UNSIGNED_BYTE, data: null })
    lmTex = f32(LM_N, LM_N, null, false)
    lmAnyTex = nearest2D({ w: LMC_N, h: LMC_N, internal: gl.R8, format: gl.RED, type: gl.UNSIGNED_BYTE, data: null })
    levTex = f32(LEV_MAX, LEV_MAX, null, false)
  } else {                                                      // no recipe: the lit shader never runs, but its samplers still need a texture bound
    poolTex = wallTab = lmTex = levTex = null
  }
  if (hasSky) {
    const strip = cloudStrip()
    cloudTex = createTexture2D(gl, { w: CLOUD_W, h: CLOUD_H, internal: gl.R8, format: gl.RED, type: gl.UNSIGNED_BYTE, data: strip, min: gl.LINEAR, mag: gl.LINEAR })
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  }

  // ── programs (specialised by LIT / SKY; the uniforms of each verified when it is collected) ──
  // The creation tier's variant is collected here, so a broken shader is still a GlError at creation and the block is only what is left of its compile
  // after the uploads above. The other variant (a level with a lighting recipe uses both: lit, and legacy when the adaptive tier drops to it or the fog
  // is out of range) is queued only now, so it never competes with the first one, and then either collected at once when the driver cannot compile in
  // parallel (its compile would block wherever it were asked for: better here than as a hitch in the middle of a frame) or left to compile in the
  // background and collected by the first frame that finds it finished (render() polls COMPLETION_STATUS_KHR), or on first use if that comes sooner.
  const programs = new Map()
  function program(lit) {
    const key = lit ? 'lit' : 'legacy'
    let p = programs.get(key)
    if (!p) {
      let q = queued.get(key)
      if (!q) { queue(lit); q = queued.get(key) }
      queued.delete(key)
      const sky = hasSky
      p = finishProgram(q)
      const missing = worldUniformNames({ lit, sky }).filter((n) => !(n in p.u))
      if (missing.length) { gl.deleteProgram(p.prog); throw new GlError('uniform', `world-${key} shader lacks uniform(s): ${missing.join(', ')}`) }
      programs.set(key, p)
    }
    return p
  }
  program(firstLit)
  if (F0) { queue(!firstLit); if (!parallel) program(!firstLit) }

  // ── frame-size resources ──
  let W = 0, H = 0, sceneTex = null, sceneFbo = null, colsTex = null, cols = null, zb = null, skyBuf = null
  const world = { W: 0, H: 0, sceneTex: null, sceneFbo: null, colsTex: null, zb: null, lit: false }

  function resize(w, h) {
    if (w === W && h === H && sceneTex) return
    if (w > maxTex || h > maxTex) throw new GlError('textures', `frame ${w}x${h} exceeds MAX_TEXTURE_SIZE (${maxTex})`)
    disposeTargets()
    W = w; H = h
    sceneTex = createTexture2D(gl, { w: W, h: H, internal: gl.RGBA8, format: gl.RGBA, type: gl.UNSIGNED_BYTE, min: gl.LINEAR, mag: gl.LINEAR })
    sceneFbo = createFramebuffer(gl, sceneTex, 'scene')
    colsTex = f32(W, COL_ROWS, null)
    cols = new Float32Array(W * COL_ROWS * 4); zb = new Float32Array(W)
    if (hasSky) { skyRowsTex = f32(H, 2, null); skyBuf = new Float32Array(H * 2 * 4) }
    world.W = W; world.H = H; world.sceneTex = sceneTex; world.sceneFbo = sceneFbo; world.colsTex = colsTex; world.zb = zb
  }
  function disposeTargets() {
    if (sceneFbo) gl.deleteFramebuffer(sceneFbo)
    for (const t of [sceneTex, colsTex, skyRowsTex]) if (t) gl.deleteTexture(t)
    sceneFbo = sceneTex = colsTex = skyRowsTex = null
  }

  const bindTex = (unit, target, t) => { gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(target, t) }
  const upload2D = (unit, t, w, h, format, type, data) => { bindTex(unit, gl.TEXTURE_2D, t); gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, format, type, data) }

  // ── one frame ──
  function render(fs, isWallFn) {
    resize(fs.W, fs.H)
    if (parallel) for (const [key, q] of [...queued]) if (programReady(q, parallel)) program(key === 'lit')   // collect a variant the driver has finished, off the critical path
    const { player, fov: FOV, hf: HF, fog, quality: q } = fs
    const fogC = Array.isArray(fs.fogRgb) && fs.fogRgb.length >= 3 ? fs.fogRgb : fogRgb
    const px = player.x, py = player.y, angle = player.angle
    const ld = q ? q.lightDetail | 0 : 0

    // the same test renderWorld makes for the lit path; prepare() also sets light.enabled and refreshes the tables the shader reads
    let F = null
    if (light && light.prepare && ld >= 1 && tex.ts >= 32 && tex.ts <= 128 && fog <= 120 && light.prepare(fs, tex, isWallFn, materialAt)) F = light.frame
    else if (light && light.enabled === true) light.enabled = false
    const lit = F !== null
    if (lit && fs.handled) { if (F.flash) fs.handled.flashlight = true; if (F.glow) fs.handled.glow = true; fs.handled.flicker = true }

    // ── columns: one ray each ──
    const rayMax = Math.min(96, Math.ceil(fog) + 3)
    const wall0 = plan.walls['0'].base
    const ask = rayAsk(isWallFn, rayMax, px, py)    // (a frame's rays ask about the same few cells again and again: see gfx-world.js, memoSafe)
    for (let col = 0; col < W; col++) {
      const a = angle - HF + (col / W) * FOV
      const hit = castRay(px, py, a, ask, rayMax)
      const corr = hit.dist * Math.cos(a - angle)
      zb[col] = corr
      const far = hit.dist >= rayMax
      let o = col * 4
      cols[o] = far ? COL_FAR : corr; cols[o + 1] = hit.wallX < WALLX_MAX ? hit.wallX : WALLX_MAX; cols[o + 2] = far ? wall0 : wallLayer(plan, hit, materialAt ? materialAt(hit.mx + 0.5, hit.my + 0.5) : null); cols[o + 3] = hit.side
      o = (W + col) * 4
      cols[o] = lit ? wallPoolShare(F, hit, px, py) : 0; cols[o + 1] = hit.dist; cols[o + 2] = corr; cols[o + 3] = wallRows(corr, H, fs.HH)
    }
    rayAskDone()
    upload2D(UNIT.cols, colsTex, W, COL_ROWS, gl.RGBA, gl.FLOAT, cols)

    // ── the small tables ──
    if (lit) uploadLitTables(F, fs)
    if (hasSky) {
      buildSkyRows(fs, skyBuf, H)
      upload2D(UNIT.skyRows, skyRowsTex, H, 2, gl.RGBA, gl.FLOAT, skyBuf)
    }

    // ── uniforms ──
    const prog = program(lit)
    const u = prog.u
    gl.bindFramebuffer(gl.FRAMEBUFFER, sceneFbo)
    gl.viewport(0, 0, W, H)
    gl.disable(gl.BLEND)
    gl.useProgram(prog.prog)
    const flicker = fs.flicker
    const pxi = Math.floor(px), pyi = Math.floor(py)
    const ca0 = Math.cos(angle - HF), sa0 = Math.sin(angle - HF), ca1 = Math.cos(angle + HF), sa1 = Math.sin(angle + HF)
    gl.uniform1i(u.uTiles, UNIT.tiles); gl.uniform1i(u.uCols, UNIT.cols)
    gl.uniform2f(u.uRes, W, H)
    gl.uniform1f(u.uHH, fs.HH)
    gl.uniform1f(u.uFog, fog)
    gl.uniform1f(u.uAng0, angle - HF); gl.uniform1f(u.uAngStep, FOV / W)
    gl.uniform2f(u.uPFrac, px - pxi, py - pyi); gl.uniform2i(u.uPInt, pxi, pyi)
    gl.uniform2f(u.uDir0, ca0, sa0); gl.uniform2f(u.uDDir, (ca1 - ca0) / W, (sa1 - sa0) / W)
    gl.uniform3f(u.uFloorLayers, plan.floor.base, plan.floor.count, 0); gl.uniform3f(u.uCeilLayers, plan.ceil.base, plan.ceil.count, 0)
    gl.uniform1f(u.uLightLayer, plan.light)
    gl.uniform1f(u.uLightsOn, fs.lightsOn ? 1 : 0)
    // Filtering follows the CPU rule per shading: renderLit filters walls / floors from texFilter >= 1 (mips, here trilinear + anisotropic) and adds the
    // near-field 2-tap blend on texFilter >= 2 or lightDetail >= 2 (uNear); renderLegacy never filters (nearest), so the legacy variant is always nearest.
    const filtered = !!(q && q.texFilter >= 1) && lit
    const near = filtered && (q.texFilter >= 2 || ld >= 2)
    gl.uniform1f(u.uGradScale, GRAD_SCALE); gl.uniform1f(u.uTSf, ts)
    gl.uniform1f(u.uSharp, filtered ? SHARP : 0); gl.uniform1f(u.uNear, near ? 1 : 0)
    gl.uniform1f(u.uIso, filtered && !(aniso && aniso.max > 1) ? 1 : 0)
    bindTex(UNIT.tiles, gl.TEXTURE_2D_ARRAY, tilesTex)
    gl.bindSampler(UNIT.tiles, filtered ? sFiltered : sNearest)
    bindTex(UNIT.cols, gl.TEXTURE_2D, colsTex)

    if (lit) {
      const single = F.single, rc = light.recipe
      const fk = F.fogGain * F.gdip
      gl.uniform3f(u.uFogL, fogC[0] / 255 * fk, fogC[1] / 255 * fk, fogC[2] / 255 * fk)
      gl.uniform1f(u.uGdip, F.gdip)
      if (single) {
        gl.uniform3f(u.uAmbF, F.tR * F.ambient, F.tG * F.ambient, F.tB * F.ambient); gl.uniform3f(u.uAmbC, F.tR * F.ceilAmbient, F.tG * F.ceilAmbient, F.tB * F.ceilAmbient)
        gl.uniform3f(u.uATint, F.tR, F.tG, F.tB)
      } else {
        gl.uniform3f(u.uAmbF, F.aR, F.aG, F.aB); gl.uniform3f(u.uAmbC, F.cR, F.cG, F.cB)
        gl.uniform3f(u.uATint, F.atR, F.atG, F.atB)
      }
      gl.uniform3f(u.uTint, F.tR, F.tG, F.tB)
      gl.uniform1f(u.uFogBase, F.fogBase); gl.uniform1f(u.uFogGlow, F.fogGlow); gl.uniform1f(u.uFloorInv, F.floorInv); gl.uniform1f(u.uCeilInv, F.ceilInv)
      gl.uniform4f(u.uAo, rc.contact * 0.62, 0.62, rc.contact * 0.5, 0.5)
      gl.uniform1f(u.uPanels, F.panels ? 1 : 0); gl.uniform1f(u.uEmit, F.emitters ? 1 : 0); gl.uniform1f(u.uLamps, F.lamps ? 1 : 0)
      gl.uniform2i(u.uOccC, F.occCx, F.occCy); gl.uniform1i(u.uOccR, F.occR); gl.uniform1i(u.uLmR, F.lmR)
      const levOn = F.dimmed && F.lev !== null
      gl.uniform1f(u.uLevOn, levOn ? 1 : 0); gl.uniform1f(u.uModulated, levOn && F.ld >= 2 ? 1 : 0)
      gl.uniform3i(u.uLev3, F.levN, F.levI0, F.levJ0)
      gl.uniform3f(u.uLampCol, F.lampCol[0] / 255, F.lampCol[1] / 255, F.lampCol[2] / 255)
      gl.uniform1f(u.uFlash, F.flash ? 1 : 0); gl.uniform1f(u.uFlashK, F.flashK)
      gl.uniform1f(u.uGlow, F.glow ? 1 : 0); gl.uniform1f(u.uGlowK, F.glowK)
      if (F.glow) {
        const g = F.lights.glow, m = Math.max(g[0], g[1], g[2], 1)
        gl.uniform3f(u.uGlowCol, 0.8 * g[0] / m + 0.2, 0.8 * g[1] / m + 0.2, 0.8 * g[2] / m + 0.2)
      } else gl.uniform3f(u.uGlowCol, 0, 0, 0)
      gl.uniform2f(u.uFlashSxy, FLASH_SX, FLASH_SY); gl.uniform1f(u.uFlashPitch, FLASH_PITCH); gl.uniform1f(u.uFov, FOV)
      const sh = Math.sin(HF), ch = Math.cos(HF)
      gl.uniform1f(u.uSinH2, sh * sh); gl.uniform1f(u.uCosH2, ch * ch)
      gl.uniform1i(u.uPool, UNIT.pool); gl.uniform1i(u.uWallTab, UNIT.wallTab); gl.uniform1i(u.uCells, UNIT.cells)
      gl.uniform1i(u.uLm, UNIT.lm); gl.uniform1i(u.uLmAny, UNIT.lmAny); gl.uniform1i(u.uLev, UNIT.lev)
      bindTex(UNIT.pool, gl.TEXTURE_2D, poolTex); bindTex(UNIT.wallTab, gl.TEXTURE_2D, wallTab); bindTex(UNIT.cells, gl.TEXTURE_2D, cellsTex)
      bindTex(UNIT.lm, gl.TEXTURE_2D, lmTex); bindTex(UNIT.lmAny, gl.TEXTURE_2D, lmAnyTex); bindTex(UNIT.lev, gl.TEXTURE_2D, levTex)
    } else {
      gl.uniform3f(u.uFogL, fogC[0] / 255 * flicker, fogC[1] / 255 * flicker, fogC[2] / 255 * flicker)
      gl.uniform1f(u.uFlicker, flicker)
    }
    if (hasSky) {
      const cfg = skyConfigFor(fs)
      const mode = ld > 0 ? 1 : 0
      const sky = fs.skyRgb, k = mode === 0 ? flicker : 1
      gl.uniform3f(u.uSkyRgb, sky[0] / 255 * k, sky[1] / 255 * k, sky[2] / 255 * k)
      gl.uniform1f(u.uSkyMode, mode)
      const ppr = CLOUD_W / TAU, t = fs.t || 0
      const wrap = (v) => v - Math.floor(v / TAU) * TAU
      gl.uniform1f(u.uSkyA0, wrap(angle - HF - t * cfg.drift) * ppr)
      gl.uniform1f(u.uSkyB0, wrap(angle - HF + t * cfg.drift * 0.7) * ppr * 3 + 211)
      gl.uniform1f(u.uSkyDu, (FOV / W) * ppr); gl.uniform1f(u.uSkyAmpB, cfg.ampB)
      gl.uniform1i(u.uSkyRows, UNIT.skyRows); gl.uniform1i(u.uCloud, UNIT.cloud)
      bindTex(UNIT.skyRows, gl.TEXTURE_2D, skyRowsTex); bindTex(UNIT.cloud, gl.TEXTURE_2D, cloudTex)
    }
    tri.draw()
    gl.bindSampler(UNIT.tiles, null)
    gl.activeTexture(gl.TEXTURE0)
    world.lit = lit
    return world
  }

  // The lit shading's tables. Each is re-uploaded only when its content can have changed (the CPU model rebuilds them on the same events).
  function uploadLitTables(F, fs) {
    if (wallTabTs !== F.ts && F.wallAmb) {
      wallTabTs = F.ts
      upload2D(UNIT.wallTab, wallTab, wallTabW, 2, gl.RGBA, gl.FLOAT, fillWallTable(F, ts, wallTabW, wallTabBuf))
    }
    const dim = !!F.lampDim
    const redo = dim || lastLampDim                                // a flicker event re-mixes the lamps every frame, and once more when it ends
    const ck = `${F.occCx},${F.occCy},${F.occR}`
    if (redo || ck !== cellsKey) { cellsKey = ck; upload2D(UNIT.cells, cellsTex, OCC_N, OCC_N, gl.RGBA, gl.UNSIGNED_BYTE, fillCellTexture(F, cellBuf)) }
    if (F.emitters && F.lm) {
      const lk = `${ck},${F.lmR}`
      if (redo || lk !== lmKey) {
        lmKey = lk
        upload2D(UNIT.lm, lmTex, LM_N, LM_N, gl.RED, gl.FLOAT, F.lm)
        upload2D(UNIT.lmAny, lmAnyTex, LMC_N, LMC_N, gl.RED, gl.UNSIGNED_BYTE, F.lmAny)
      }
    }
    lastLampDim = dim
    if (F.dimmed && F.lev) upload2D(UNIT.lev, levTex, F.levN, F.levN, gl.RED, gl.FLOAT, F.lev)
  }

  function dispose() {
    disposeTargets()
    for (const t of [tilesTex, poolTex, wallTab, cellsTex, lmTex, lmAnyTex, levTex, cloudTex]) if (t) gl.deleteTexture(t)
    gl.deleteSampler(sNearest); gl.deleteSampler(sFiltered)
    for (const p of programs.values()) gl.deleteProgram(p.prog)
    programs.clear()
    for (const q of queued.values()) { gl.deleteShader(q.vs); gl.deleteShader(q.fs); gl.deleteProgram(q.prog) }
    queued.clear()
  }
  return { render, resize, dispose }
}
