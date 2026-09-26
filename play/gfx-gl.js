// gfx-gl.js — the WebGL2 backend. createGlRenderer(canvas, config, renderOpts, worldHooks) returns the same shape as the CPU backend
//   { render(player, isWallFn, flicker, entities, fogMul, lights, timing), kind: 'gpu', capture(), dispose(), lost, info }
// or THROWS (GlError / GpuUnavailable) if it cannot come up — renderer.js catches that and builds the CPU renderer instead. The CPU renderer is
// always the fallback and is never replaced by software GL (probeGl / pickRenderer enforce it; only the test harness may opt into SwiftShader).
//
// Principle: the CPU stays the source of truth for the WORLD. castRay and the chunk cache (isWall generates chunks as a side effect) run on the CPU
// exactly as they do for the CPU renderer, so maze parity, collision and determinism cannot drift; the GPU only shades. Per frame:
//     fs = buildFrameState(...)                       (gfx-frame.js — shared with the CPU backend)
//     world     = worldPass.render(fs, isWallFn)      rays + light tables on the CPU, floor / ceiling / sky / walls / light / fog on the GPU
//     nameplates = spritePass.render(fs, entities, world)   instanced billboards, depth-tested against the world's column distances
//     postPass.render(fs, world, nameplates)          grade, vignette, grain, particles, bloom, then the crisp 2D overlay
// The passes live in gfx-gl-world.js / gfx-gl-sprites.js / gfx-gl-post.js (one owner each; their headers state the interface). A pass's
// `resize` and `dispose` are optional as far as this file is concerned (it calls them only when present).
//
// CANVASES. The GL context is created on a SIBLING canvas stacked over #c (pointer-events: none, so pointer lock and clicks still reach #c):
// #c keeps its untouched 2D context, which is what makes the CPU fallback instant — a canvas that ever produced a WebGL context can never
// return a 2D one. The sibling follows #c's size and its shake transform every frame (siblingLayout in gfx-gl-util.js) and is removed on dispose.
// Creation is EXCEPTION-SAFE end to end: from the moment the sibling canvas / context exist, ANY throw (a pass that will not compile, a lost
// context, a failing helper) runs the same teardown as dispose() — passes disposed, the context released (WEBGL_lose_context), the canvas removed —
// so a failed GPU start can never leave an opaque black canvas over the CPU fallback or a live context behind. A canvas with no parent is refused
// (GpuUnavailable 'no-parent') instead of building a renderer nobody can see.
//
// FAILURE POLICY. Anything wrong THROWS a GlError from render()/capture()/creation and renderer.js swaps to the CPU renderer in place:
//   - a GL error in the first frames, a failed compile/link/framebuffer            -> GlError (stage names the step, .log the driver's text)
//   - context loss: the safest policy is to give up the GPU path for the rest of the session. A lost context is NOT rebuilt (no fragile state
//     recreation, no retry loop): the next render() throws GlError('context'), and a `webglcontextrestored` is ignored. A loss is recognised
//     wherever it surfaces (a null shader at creation, a getError of CONTEXT_LOST_WEBGL, zeros from readPixels in the validation): every failure
//     raised while the context is lost is reported as stage 'context', which renderer.js treats as SESSION-only (never a 24 h ban).
//   - FIRST-FRAME VALIDATION (gfx-gl-g4-validate.js): before render call VALIDATE_AT[0] one SYNTHETIC frame (a pose near the player's with a prop, a
//     note and an npc a few cells ahead, flashlight on, in the real world — independent of what is on screen) is drawn by the GPU passes at a small size, compared with a
//     throwaway CPU render of the same frame, and a black / garbage / flipped / mis-exposed / sprite-less picture throws GlError('validate'). A pass
//     is remembered per (device, build) in localStorage and in memory for the session. A tiny canvas, a hidden page or a black reference defers the
//     check to a later render call (VALIDATE_AT) instead of failing.
// renderOpts hooks for tests and the harness — HONOURED ONLY in a test run (isTestRun(): the harness sets globalThis.__backroomsTestRun before the game
// script runs; a player cannot): __failGl = 'create' | 'frame' | 'frame:N' | 'lost' | 'validate' forces that failure; gpuValidate true|false forces the
// validation on|off; allowSoftwareGl lets the harness use SwiftShader.
import { hexToRgb, levelKey } from './gfx-util.js'
import { buildTextures, texturesMemoSize, clearTexturesMemo } from './gfx-textures.js'
import { createLight } from './gfx-light.js'
import { qualityFor, isSoftwareGl } from './gfx-quality.js'
import { buildFrameState } from './gfx-frame.js'
import {
  GlError, probeGl, fullscreenTriangle, glErrorName, siblingLayout, GL_POWER_PREFERENCE, isTestRun, harnessOpt, releaseContext, readUnmaskedRenderer,
} from './gfx-gl-util.js'
import { createWorldPass } from './gfx-gl-world.js'
import { createSpritePass } from './gfx-gl-sprites.js'
import { createPostPass } from './gfx-gl-post.js'
import { createCpuRenderer } from './gfx-cpu.js'
import { GPU_BUILD_ID, validationCacheKey, validationWanted, runFirstFrameValidation, syntheticFrame, settleFrame } from './gfx-gl-g4-validate.js'

export class GpuUnavailable extends Error {
  constructor(reason, probe) { super(`GPU renderer unavailable: ${reason}`); this.name = 'GpuUnavailable'; this.reason = reason; this.probe = probe || null }
}

const CHECK_FRAMES = 3       // the GL error queue is read for the first few frames only (a getError() stalls the pipeline)
// The render calls (1-based) the validation is attempted BEFORE drawing: the 4th (the first-frame uploads have settled), and only if that one could not
// judge (tiny canvas, hidden page, a black reference) the 12th and the 40th. After the last one without a verdict the check is 'skipped' (nothing cached).
const VALIDATE_AT = Object.freeze([4, 12, 40])
const REF_WIDTH = 480        // the validation frame (GPU and CPU reference alike) is at most this wide: one cheap frame, once per device + build
const MIN_VALIDATE_W = 64, MIN_VALIDATE_H = 36     // a smaller canvas cannot say anything: defer, never fail

const nowMs = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now())
const call = (o, m, ...a) => (o && typeof o[m] === 'function' ? o[m](...a) : undefined)

// deps (tests only): probe (an already-run probeGl result: renderer.js probes once per session), probeGl, buildTextures, createLight,
// createCpuRenderer, passes { world, sprites, post }, storage (a localStorage-like)
export function createGlRenderer(canvas, config, renderOpts = {}, worldHooks = {}, deps = {}) {
  const doc = canvas.ownerDocument || (typeof document !== 'undefined' ? document : null)
  if (!doc) throw new GpuUnavailable('no-document')
  const makeCanvas = () => doc.createElement('canvas')
  const ropts = renderOpts
  const testRun = isTestRun()
  const allowSoftware = testRun && !!ropts.allowSoftwareGl
  const failHook = testRun && typeof ropts.__failGl === 'string' ? ropts.__failGl : ''
  if (failHook === 'create') throw new GlError('test', 'forced failure (__failGl=create)')
  const parent = canvas.parentNode
  if (!parent) throw new GpuUnavailable('no-parent')         // a detached #c: the sibling would render where nobody can see it

  // ── 1. is there a usable GPU? (a throwaway canvas, once per session: renderer.js hands its probe in; the real context is created next) ──
  const probe = deps.probe || (deps.probeGl || probeGl)(makeCanvas, { allowSoftware })
  if (!probe.ok) throw new GpuUnavailable(probe.reason, probe)

  let glCanvas = null, gl = null, tri = null, world = null, sprites = null, post = null, st = null
  let lost = false, disposed = false, glRenderer = probe.unmaskedRenderer
  const env = { gl: null, canvas: null, overlay: null, config, tex: null, light: null, materialAt: null, caps: probe.caps, ropts, tri: null, probe }

  // the one teardown: creation failure and dispose() share it. Idempotent; every step is guarded (the context may already be gone).
  function teardown() {
    try { call(sprites, 'dispose') } catch { /* context already gone */ }
    try { call(post, 'dispose') } catch { /* ignore */ }
    try { call(world, 'dispose') } catch { /* ignore */ }
    try { call(tri, 'dispose') } catch { /* ignore */ }
    if (gl) releaseContext(gl)                                    // released explicitly (browsers cap live contexts at ~16)
    try { if (glCanvas) glCanvas.remove() } catch { /* ignore */ }
    try { if (env.overlay) env.overlay.remove() } catch { /* ignore */ }
  }
  const lostNow = () => {
    if (lost) return true
    try { if (gl && gl.isContextLost()) lost = true } catch { /* ignore */ }
    return lost
  }
  // Any failure raised while the context is lost IS the context loss (a null shader, a CONTEXT_LOST_WEBGL error, zeros from readPixels): report it as
  // stage 'context' so it is session-only, never a persisted 24 h ban of a healthy GPU. Otherwise the error stays what it was.
  const asFailure = (e) => (lostNow() && !(e instanceof GpuUnavailable) && !(e instanceof GlError && e.stage === 'context')
    ? new GlError('context', `the WebGL context was lost (${e && e.message ? String(e.message).split('\n')[0] : e})`) : e)
  const failFor = (stage, msg) => (lostNow() ? new GlError('context', `the WebGL context was lost (${stage}: ${msg})`) : new GlError(stage, msg))

  let LEVEL_KEY = '', materialAt = null, lightsOn = true, fogRgb = null, skyRgb = null, tex = null, light = null
  const P = deps.passes || {}
  try {
    // ── 2. the sibling GL canvas and its context ──
    glCanvas = makeCanvas()
    glCanvas.setAttribute('aria-hidden', 'true')
    if (glCanvas.dataset) glCanvas.dataset.gfx = 'gl'
    st = glCanvas.style
    st.position = 'fixed'; st.left = '0'; st.top = '0'; st.pointerEvents = 'none'; st.display = 'block'
    glCanvas.width = canvas.width; glCanvas.height = canvas.height
    gl = glCanvas.getContext('webgl2', {
      alpha: false, antialias: false, depth: false, stencil: false, premultipliedAlpha: false, preserveDrawingBuffer: false,
      powerPreference: GL_POWER_PREFERENCE, failIfMajorPerformanceCaveat: !allowSoftware,
    })
    if (!gl) throw new GpuUnavailable('context-creation-failed', probe)
    // the renderer string of the context that will actually draw (a dual-GPU laptop's probe can land on another adapter): the software refusal, the
    // validation cache key and the diagnostics all use THIS one
    glRenderer = readUnmaskedRenderer(gl) || probe.unmaskedRenderer
    if (!allowSoftware && isSoftwareGl(glRenderer)) throw new GpuUnavailable('software-gl', { ...probe, unmaskedRenderer: glRenderer })
    parent.insertBefore(glCanvas, canvas.nextSibling)

    // Context loss: give the GPU path up for the session (renderer.js swaps at the next render). No preventDefault: we do not want a restore.
    glCanvas.addEventListener('webglcontextlost', () => { lost = true })
    glCanvas.addEventListener('webglcontextrestored', () => { /* deliberately ignored: a restored context has none of our GL objects */ })

    // ── 3. everything the passes share ──
    LEVEL_KEY = levelKey(config)
    materialAt = worldHooks.materialAt || null
    fogRgb = hexToRgb(config.palette.fog)
    skyRgb = config.sky ? hexToRgb(config.sky) : null
    lightsOn = config.lights !== false
    tex = (deps.buildTextures || buildTextures)(config.palette, config.materials, config.look, LEVEL_KEY)
    light = (deps.createLight || createLight)(config, worldHooks)
    tri = fullscreenTriangle(gl)
    Object.assign(env, { gl, canvas: glCanvas, tex, light, materialAt, tri })
    world = (P.world || createWorldPass)(env)
    sprites = (P.sprites || createSpritePass)(env)
    post = (P.post || createPostPass)(env)
  } catch (e) {
    const err = asFailure(e instanceof GlError || e instanceof GpuUnavailable ? e : new GlError('init', String(e && e.message || e)))
    teardown()
    throw err
  }

  // ── first-frame validation setup ──
  const storage = deps.storage !== undefined ? deps.storage : (() => { try { return globalThis.localStorage || null } catch { return null } })()
  const cacheKey = validationCacheKey(glRenderer, GPU_BUILD_ID)
  const gpuValidate = harnessOpt(ropts, 'gpuValidate')
  const measure = gpuValidate === 'measure'           // harness only: run the check, record the metrics and both frames, never fail (tuning the limits)
  const validateWanted = validationWanted({ ropts: { gpuValidate: measure ? true : gpuValidate }, allowSoftware, storage, key: cacheKey })
  let validation = validateWanted ? 'pending' : (gpuValidate === false || allowSoftware ? 'off' : 'cached'), validationMetrics = null, validationFrames = null, validationMs = 0
  let validationDraws = null          // { cpu, gpu }: how many draws each side needed before its picture stopped changing (settleFrame)

  // ── per-frame plumbing ──
  let frame = 0, lastArgs = null, qBase = null, qOver = null, cssW = '', cssH = '', tf = ''
  function currentQuality() {                       // the tier, with the optional live scale override (cached: nothing is allocated per frame)
    const base = qualityFor(ropts.qualityTier), s = ropts.renderScale
    if (!(s >= 0.3 && s <= 1) || s === base.scale) return base
    if (qBase !== base || qOver.scale !== s) { qBase = base; qOver = Object.freeze({ ...base, scale: s }) }
    return qOver
  }
  // the sibling tracks #c: backing store, css box and the shake transform game.js writes to #c.style (siblingLayout is the pure part)
  function syncCanvas() {
    const L = siblingLayout(canvas)
    if (glCanvas.width !== L.width || glCanvas.height !== L.height) { glCanvas.width = L.width; glCanvas.height = L.height }
    if (L.cssW !== cssW || L.cssH !== cssH) { st.width = cssW = L.cssW; st.height = cssH = L.cssH }
    if (L.transform !== tf) { st.transform = tf = L.transform }
  }

  // one GL frame. `v` (the validation frame only) = { w, h, opts }: draw at that small size with those options and leave #c's layout alone.
  function draw(args, advance, v) {
    if (disposed) throw new GlError('disposed', 'the GL renderer was disposed')
    if (lostNow()) throw new GlError('context', 'the WebGL context was lost')
    const [player, isWallFn, flicker, entities = [], fogMul = 1, lights = {}, timing = null] = args
    if (advance) frame++
    if (advance && failHook) {
      if (failHook === 'frame' || (failHook.startsWith('frame:') && frame === Number(failHook.slice(6)))) throw new GlError('test', `forced failure on frame ${frame} (__failGl)`)
      if (failHook === 'lost' && frame === 2) { releaseContext(gl); lost = true; throw new GlError('context', 'forced context loss (__failGl=lost)') }
    }
    if (v) { if (glCanvas.width !== v.w || glCanvas.height !== v.h) { glCanvas.width = v.w; glCanvas.height = v.h } } else syncCanvas()
    const quality = currentQuality()
    const W = Math.max(1, Math.round(glCanvas.width * quality.scale)), H = Math.max(1, Math.round(glCanvas.height * quality.scale))
    const fs = buildFrameState({
      W, H, OW: glCanvas.width, OH: glCanvas.height, fog: config.fogDistance * fogMul, fogRgb, fogMul, flicker, frame, timing, player, lights,
      lightsOn, hasSky: !!skyRgb, skyRgb, light, quality, opts: v ? v.opts : ropts, levelKey: LEVEL_KEY, look: config.look,
    })
    try {
      const wd = world.render(fs, isWallFn)
      const nameplates = sprites.render(fs, entities, wd)
      post.render(fs, wd, nameplates)
    } catch (e) { throw asFailure(e) }
    if (v || frame <= CHECK_FRAMES) { const err = glErrorName(gl); if (err) throw failFor('frame', `WebGL error ${err} on frame ${frame}`) }
  }

  // ── first-frame validation: a synthetic GPU frame vs a throwaway CPU render of the same frame ──
  let readBuf = null
  function readGpu() {
    const w = glCanvas.width, h = glCanvas.height
    if (!readBuf || readBuf.length !== w * h * 4) readBuf = new Uint8Array(w * h * 4)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, readBuf)
    if (lostNow()) throw new GlError('context', 'the WebGL context was lost during the validation readback')      // a lost context reads back zeros
    return { data: readBuf, w, h, flipY: true }
  }
  function renderCpuReference(syn, rw, rh, opts) {
    const c = makeCanvas(); c.width = rw; c.height = rh
    const memo = texturesMemoSize()
    let rr = null
    try {
      rr = (deps.createCpuRenderer || createCpuRenderer)(c, config, { ...opts, renderer: 'cpu' }, worldHooks)
      const g2 = c.getContext('2d')
      // drawn until it stops changing: a sprite whose lazy build did not fit this call's budget appears on a later call (settleFrame)
      const st = settleFrame(() => {
        rr.render(syn.player, syn.isWall, syn.flicker, syn.entities, syn.fogMul, syn.lights, VALIDATE_TIMING)
        return { data: g2.getImageData(0, 0, rw, rh).data, w: rw, h: rh }
      })
      validationDraws = { ...(validationDraws || {}), cpu: st.draws }
      return st.frame
    } finally {
      try { call(rr, 'dispose') } catch { /* ignore */ }
      c.width = 0; c.height = 0                        // release the backing store now, not at the next GC
      if (memo === 0) { try { clearTexturesMemo() } catch { /* ignore */ } }      // do not keep the reference's CPU textures alive
    }
  }
  // measure mode only: a frame as a PNG data URL (the GPU readback is bottom-up)
  function png(fr, flipY) {
    const c = makeCanvas(); c.width = fr.w; c.height = fr.h
    const img = c.getContext('2d').createImageData(fr.w, fr.h)
    for (let y = 0; y < fr.h; y++) img.data.set(fr.data.subarray(((flipY ? fr.h - 1 - y : y) * fr.w) * 4, ((flipY ? fr.h - 1 - y : y) * fr.w + fr.w) * 4), y * fr.w * 4)
    c.getContext('2d').putImageData(img, 0, 0)
    return c.toDataURL('image/png')
  }
  const VALIDATE_TIMING = Object.freeze({ t: 0.5, dt: 1 / 60 })      // both renderers animate from the same clock
  // Called BEFORE render call `n` (1-based) draws. Sets `validation`; throws GlError('validate' | 'context' | ...) on a real failure.
  function maybeValidate(args, n) {
    if (validation !== 'pending' || !VALIDATE_AT.includes(n)) return
    const last = n >= VALIDATE_AT[VALIDATE_AT.length - 1]
    const cw = canvas.width | 0, ch = canvas.height | 0
    if (cw < MIN_VALIDATE_W || ch < MIN_VALIDATE_H || doc.hidden === true) { if (last) validation = 'skipped'; return }     // cannot judge yet: not a failure
    if (lostNow()) throw new GlError('context', 'the WebGL context was lost')
    validation = 'running'
    const t0 = nowMs()
    const vw = Math.min(REF_WIDTH, cw), vh = Math.max(MIN_VALIDATE_H, Math.round(vw * ch / cw))
    let syn = null
    try { syn = syntheticFrame(args[0] && args[0].x, args[0] && args[0].y, args[1]) } catch { validation = 'skipped'; return }      // the wall test failed: not evidence against the GPU
    // no grain, particles or crosshair in either frame (random or overlay-only: they would only add noise to the metric)
    const opts = { ...ropts, grain: false, particles: false, crosshair: false }
    let ref = null, gpuFrame = null
    try { ref = renderCpuReference(syn, vw, vh, opts) } catch (e) { validation = 'skipped'; return }      // the CPU reference itself failed: not evidence against the GPU
    try {
      if (failHook === 'validate') throw new GlError('validate', 'forced failure (__failGl=validate)')
      const r = runFirstFrameValidation({
        readGpu: () => {
          // the same settling as the CPU reference: the GL sprite plan builds lazily under the same kind of budget
          const st = settleFrame(() => { draw([syn.player, syn.isWall, syn.flicker, syn.entities, syn.fogMul, syn.lights, VALIDATE_TIMING], false, { w: vw, h: vh, opts }); return readGpu() })
          validationDraws = { ...(validationDraws || {}), gpu: st.draws }
          const g = st.frame; if (measure) gpuFrame = { data: g.data.slice(), w: g.w, h: g.h }
          return g
        },
        renderCpu: () => ref, storage, key: cacheKey,
      })
      validationMetrics = r.metrics; validationMs = nowMs() - t0        // the one-frame hitch this costs (CPU reference + synchronous 480 px readback)
      validation = r.deferred ? (last ? 'skipped' : 'pending') : 'passed'
      if (measure && gpuFrame) { try { validationFrames = { gpu: png(gpuFrame, true), cpu: png(ref, false) } } catch { /* ignore */ } }
    } catch (e) {
      validationMs = nowMs() - t0
      if (measure && gpuFrame) { try { validationFrames = { gpu: png(gpuFrame, true), cpu: png(ref, false) } } catch { /* ignore */ } }
      if (measure && e instanceof GlError && e.stage === 'validate') { validationMetrics = e.metrics || null; validation = 'measured-fail'; return }
      validation = 'failed'; throw asFailure(e)
    }
  }

  function render(...args) {
    lastArgs = args
    maybeValidate(args, frame + 1)
    draw(args, true)
  }

  // The Polaroid needs the pixels. A WebGL canvas is only readable in the task that drew it, so this re-draws the last frame (without advancing
  // the frame counter) and reads it straight away; the 2D overlay, if the post pass has one, is composited on top.
  function capture() {
    if (disposed) throw new GlError('disposed', 'the GL renderer was disposed')
    if (!lastArgs) return glCanvas.toDataURL('image/png')
    draw(lastArgs, false)
    const c = makeCanvas(); c.width = glCanvas.width; c.height = glCanvas.height
    try {
      const g = c.getContext('2d')
      g.drawImage(glCanvas, 0, 0)
      if (env.overlay) g.drawImage(env.overlay, 0, 0, c.width, c.height)
      return c.toDataURL('image/png')
    } finally { c.width = 0; c.height = 0 }              // release the full-size backing store now, not at the next GC
  }

  // idempotent
  function dispose() {
    if (disposed) return
    disposed = true
    teardown()
    readBuf = null; lastArgs = null
  }

  return {
    render, kind: 'gpu', capture, dispose,
    get lost() { return lost },
    get disposed() { return disposed },
    get info() { return { renderer: glRenderer, software: probe.majorPerformanceCaveat, caps: probe.caps, validation, validationMetrics, validationFrames, validationMs, validationDraws, frames: frame } },
    canvas: glCanvas,
  }
}
