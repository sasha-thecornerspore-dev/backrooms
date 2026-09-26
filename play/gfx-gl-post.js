// gfx-gl-post.js — the GPU POST PASS: takes the finished scene texture (world + sprites, internal resolution) and produces the visible frame on
// the GL canvas: the same look gfx-post.js composeFrame gives the CPU path at every tier, plus the 2D OVERLAY (remote-player nameplates, speech
// bubbles, crosshair) drawn crisp at full resolution.
//
//   createPostPass(env) -> { render(fs, world, nameplates), resize(OW, OH), dispose(), state }
//     env    { gl, canvas (the GL canvas), overlay (SET here to a transparent 2D canvas stacked over it), config, ropts, caps, tri }
//     world  { W, H, sceneTex, ... }      sceneTex is bottom-up like every GL texture
//   `render` writes to the default framebuffer (the visible GL canvas, canvas.width x canvas.height). `state` is the CPU stage's post-state object
//   (particle field, atmosphere) — exposed for the parity harness (tools/gfx/post-parity.*), nothing in the game reads it.
//
// The frame, in the CPU stage's own order (gfx-post.js header), everything at LOW resolution first because that is where the CPU does it too:
//   modern tiers   bloom (bright pass on a 1/2 -> 1/4 -> 1/8 chain, local-contrast emitter gate, blur, SCREEN composite)
//                  -> [rising steam, drawn into the low-res frame] -> highlight gain -> veil (vignette + shadow lift) -> luma grain     "compose"
//                  -> bilinear upscale [+ tape drift / fringe / soft focus] -> legacy blackout overlay (only without a light model)     "up"
//                  -> particles (dust, sparks: instanced quads that read the frame's brightness from the 1/8 chain) -> flashlight / glow gradients
//   legacy tier    grain -> bilinear upscale + radial vignette + blackout overlay -> particles (plain dots) -> flashlight / glow gradients
//   both           then the 2D overlay: nameplates and the crosshair, via the CPU stage's own drawNameplates / drawCrosshair
// Nothing here invents motion: flicker is fs.flicker and flickerOverlayAlpha (the CPU stage's own functions), grain hops at 24 Hz from fs.t, the
// particle field is the CPU stage's seeded field stepped by the same rules (gfx-gl-post-particles.js).
//
// Resources: every intermediate target is allocated lazily and reused (bloom chain 1/2, 1/4, 1/8 + a 1/32 grid; RGBA16F when the device can render to
// it, else RGBA8), reallocated only when the internal size changes. No JS allocation per frame. Any failure throws GlError.
import { GlError, startProgram, finishProgram, programReady, createTexture2D, createFramebuffer, FULLSCREEN_VS } from './gfx-gl-util.js'
import { createPostState, fitParticles, flickerOverlayAlpha, drawNameplates, drawCrosshair, veilColors, VEIL_A, uiScaleOf } from './gfx-post.js'
import {
  postPlan, bloomSizes, grainTilePixels, legacyGrainPixels, grainOffsetModern, grainOffsetLegacy, gainFor, glowPulse, newOverlayMemo, overlayUnchanged, overlayRemember,
  GRAIN_TILE, LEGACY_TILE, LEGACY_GRAIN_ALPHA, LEGACY_VIGNETTE,
} from './gfx-gl-post-math.js'
import { createSink, stepModern, stepLegacy, INST } from './gfx-gl-post-particles.js'
import { DOWN_FS, GRID_FS, BRIGHT_FS, BLUR_FS, WIDE_FS, COMPOSE_FS, UP_FS, LIGHTS_FS, PARTICLE_VS, PARTICLE_FS, UNIFORMS } from './gfx-gl-post-shaders.js'

const NONE = []
const NOT_HANDLED = Object.freeze({ flashlight: false, glow: false })

export function createPostPass(env) {
  const { gl, canvas, tri } = env
  const ropts = env.ropts || {}
  const doc = canvas.ownerDocument || (typeof document !== 'undefined' ? document : null)

  // ── programs ──
  // All nine are QUEUED here (startProgram: compile + link requested, nothing asked back, so nothing blocks) and COLLECTED later (finishProgram +
  // the uniform check + the static uniforms): at their first use, or earlier by the first frame that finds them finished (programReady). With
  // KHR_parallel_shader_compile the driver compiles them in parallel with everything else the renderer does meanwhile (the other passes, the first
  // frame's CPU work); without it the first status query blocks, as compileProgram did. Failure semantics are the same as before: every program must
  // compile, link and expose its uniforms (a missing / optimised-away uniform is a GlError, never a silent no-op at draw time) — it is only reported
  // when the program is collected, i.e. by the first render() rather than by createPostPass, and gfx-gl.js treats a render() GlError exactly like a
  // creation one (the CPU renderer takes over, remembered for the session and by the persisted marker).
  const SOURCES = {
    down: [FULLSCREEN_VS, DOWN_FS], grid: [FULLSCREEN_VS, GRID_FS], bright: [FULLSCREEN_VS, BRIGHT_FS], blur: [FULLSCREEN_VS, BLUR_FS],
    wide: [FULLSCREEN_VS, WIDE_FS], compose: [FULLSCREEN_VS, COMPOSE_FS], up: [FULLSCREEN_VS, UP_FS], lights: [FULLSCREEN_VS, LIGHTS_FS],
    particles: [PARTICLE_VS, PARTICLE_FS],
  }
  const P = Object.create(null)                                    // collected: name -> { prog, u, label }
  const queued = new Map()                                         // compiling: name -> the startProgram handle
  const parallel = gl.getExtension('KHR_parallel_shader_compile')
  const dropQueued = () => {
    for (const q of queued.values()) { try { gl.deleteShader(q.vs); gl.deleteShader(q.fs); gl.deleteProgram(q.prog) } catch { /* context gone */ } }
    queued.clear()
  }
  try {
    for (const name in SOURCES) queued.set(name, startProgram(gl, SOURCES[name][0], SOURCES[name][1], `post.${name}`))
  } catch (e) { dropQueued(); throw e }
  let overlay = null, ovCtx = null, ovDirty = false, ovW = '', ovH = '', ovT = ''
  const ovMemo = newOverlayMemo()                                  // what the overlay currently shows (see overlayUnchanged)
  const own = { tex: [], fbo: [], buf: [], vao: [] }          // everything created below, for dispose()

  const post = createPostState(env.config)
  const A = post.atmos

  // ── static uniforms (the atmosphere is fixed per renderer, exactly as on the CPU), set once when each program is collected ──
  const gain = gainFor(A.grade), { V, D } = veilColors(A.grade)
  const INIT = {
    down: (u) => { gl.uniform1i(u.uSrc, 0) },
    grid: (u) => { gl.uniform1i(u.uSrc, 0) },
    blur: (u) => { gl.uniform1i(u.uSrc, 0) },
    wide: (u) => { gl.uniform1i(u.uSrc, 0) },
    bright: (u) => {
      gl.uniform1i(u.uSrc, 0); gl.uniform1i(u.uAvg, 1)
      gl.uniform3f(u.uP, A.bloom.thr, A.bloom.knee, A.bloom.tintMix)
      gl.uniform3f(u.uTint, A.bloom.tint[0], A.bloom.tint[1], A.bloom.tint[2])
    },
    compose: (u) => {
      gl.uniform1i(u.uSrc, 0); gl.uniform1i(u.uHalo, 1); gl.uniform1i(u.uWide, 2); gl.uniform1i(u.uTile, 3)
      gl.uniform2f(u.uBloomGain, A.bloom.gain, A.bloom.gain * A.bloom.wide)
      gl.uniform3f(u.uGain, gain[0], gain[1], gain[2])
      gl.uniform3f(u.uVeilV, V[0] / 255, V[1] / 255, V[2] / 255); gl.uniform3f(u.uVeilD, D[0] / 255, D[1] / 255, D[2] / 255)
      gl.uniform3f(u.uVeil, A.vig.depth, A.vig.from, VEIL_A)
    },
    up: (u) => { gl.uniform1i(u.uLow, 0) },
    lights: () => {},
    particles: (u) => { gl.uniform1i(u.uTiny, 0) },
  }
  // The program `name`, collected now if it is still queued (blocks until its compile is done). Leaves it the CURRENT program. Throws GlError.
  function prog(name) {
    let p = P[name]
    if (!p) {
      const q = queued.get(name)
      if (!q) throw new GlError('post', `${name}: the program failed earlier and is not available`)
      queued.delete(name)
      p = finishProgram(q)                                        // (deletes everything and throws GlError on a compile / link failure)
      for (const n of UNIFORMS[name]) if (!(n in p.u)) { gl.deleteProgram(p.prog); throw new GlError('post', `${name}: uniform ${n} is not active in the compiled program`) }
      P[name] = p
      gl.useProgram(p.prog); INIT[name](p.u)
      return p
    }
    gl.useProgram(p.prog)
    return p
  }
  // collect whatever the driver has finished (a status query that will not block), off the critical path; without the extension this collects
  // them all on the first frame
  function collectReady() {
    for (const [name, q] of queued) if (programReady(q, parallel)) prog(name)
  }

  // ── textures ──
  const track = (t) => { own.tex.push(t); return t }
  const dummy = track(createTexture2D(gl, { w: 1, h: 1, internal: gl.RGBA8, format: gl.RGBA, type: gl.UNSIGNED_BYTE, data: new Uint8Array(4), min: gl.NEAREST, mag: gl.NEAREST }))
  let tileModern = null, tileLegacy = null
  const tileFor = (legacy) => {
    if (legacy) return tileLegacy || (tileLegacy = track(createTexture2D(gl, { w: LEGACY_TILE, h: LEGACY_TILE, internal: gl.RGBA8, format: gl.RGBA, type: gl.UNSIGNED_BYTE, data: legacyGrainPixels(), min: gl.NEAREST, mag: gl.NEAREST, wrap: gl.REPEAT })))
    return tileModern || (tileModern = track(createTexture2D(gl, { w: GRAIN_TILE, h: GRAIN_TILE, internal: gl.RGBA8, format: gl.RGBA, type: gl.UNSIGNED_BYTE, data: grainTilePixels(A.grain.mul, A.grain.add), min: gl.NEAREST, mag: gl.NEAREST, wrap: gl.REPEAT })))
  }

  // ── render targets ──
  // The precision of the bloom planes (light values, blurred): half float when this device can render to it (and the harness does not force 8 bits).
  let fmt = { internal: gl.RGBA8, type: gl.UNSIGNED_BYTE, name: 'rgba8' }
  if (ropts.postTargets !== 'rgba8') {
    try {
      gl.getExtension('EXT_color_buffer_float'); gl.getExtension('EXT_color_buffer_half_float')
      const t = createTexture2D(gl, { w: 2, h: 2, internal: gl.RGBA16F, format: gl.RGBA, type: gl.HALF_FLOAT })
      let f = null
      try { f = createFramebuffer(gl, t, 'post.probe16f') } finally { gl.deleteTexture(t); if (f) gl.deleteFramebuffer(f) }
      fmt = { internal: gl.RGBA16F, type: gl.HALF_FLOAT, name: 'rgba16f' }
    } catch { gl.getError(); /* RGBA8 planes */ }
  }
  const RGBA8 = { internal: gl.RGBA8, type: gl.UNSIGNED_BYTE }
  function target(w, h, f, label) {
    const tex = createTexture2D(gl, { w, h, internal: f.internal, format: gl.RGBA, type: f.type, min: gl.LINEAR, mag: gl.LINEAR })
    const fbo = createFramebuffer(gl, tex, `post.${label}`)
    own.tex.push(tex); own.fbo.push(fbo)
    return { tex, fbo, w, h }
  }
  function free(t) {
    if (!t) return null
    gl.deleteTexture(t.tex); gl.deleteFramebuffer(t.fbo)
    own.tex = own.tex.filter((x) => x !== t.tex); own.fbo = own.fbo.filter((x) => x !== t.fbo)
    return null
  }
  let lowA = null, lowB = null, lowW = 0, lowH = 0                 // the composed low-res frame (and a second one when the steam splits the compose)
  let bl = null, blKey = ''                                        // the bloom chain
  const SZ = {}
  function ensureLow(W, H, needB) {
    if (lowW !== W || lowH !== H) { lowA = free(lowA); lowB = free(lowB); lowW = W; lowH = H }
    if (!lowA) lowA = target(W, H, RGBA8, 'low')
    if (needB && !lowB) lowB = target(W, H, RGBA8, 'lowB')
  }
  function ensureBloom(W, H) {
    const key = `${W}x${H}`
    if (bl && blKey === key) return bl
    if (bl) for (const k of Object.keys(bl)) if (bl[k] && bl[k].tex) free(bl[k])
    const s = bloomSizes(W, H, SZ)
    bl = {
      t1: target(s.w1, s.h1, RGBA8, 'bloom1'), t2: target(s.w2, s.h2, RGBA8, 'bloom2'), t3: target(s.BW, s.BH, RGBA8, 'bloom3'),
      G: target(s.wW, s.wH, fmt, 'grid'), M: target(s.wW, s.wH, fmt, 'gridBlur'), P: target(s.BW, s.BH, fmt, 'emit'), Pb: target(s.BW, s.BH, fmt, 'emitBlur'),
      BW: s.BW, BH: s.BH, wW: s.wW, wH: s.wH, sx: s.sx, sy: s.sy,
    }
    blKey = key
    return bl
  }

  // ── particle buffers: two instanced draws (source-over, additive), one VAO each ──
  const sink = createSink(post.count || 1)
  let pcap = 0
  const bufN = gl.createBuffer(), bufA = gl.createBuffer(), vaoN = gl.createVertexArray(), vaoA = gl.createVertexArray()
  own.buf.push(bufN, bufA); own.vao.push(vaoN, vaoA)
  function wireVao(vao, buf) {
    gl.bindVertexArray(vao); gl.bindBuffer(gl.ARRAY_BUFFER, buf)
    for (let i = 0; i < 3; i++) { gl.enableVertexAttribArray(i); gl.vertexAttribPointer(i, 4, gl.FLOAT, false, INST * 4, i * 16); gl.vertexAttribDivisor(i, 1) }
    gl.bindVertexArray(null)
  }
  wireVao(vaoN, bufN); wireVao(vaoA, bufA)
  function ensureParticleBuffers() {
    if (pcap >= sink.cap) return
    pcap = sink.cap
    gl.bindBuffer(gl.ARRAY_BUFFER, bufN); gl.bufferData(gl.ARRAY_BUFFER, pcap * INST * 4, gl.DYNAMIC_DRAW)
    gl.bindBuffer(gl.ARRAY_BUFFER, bufA); gl.bufferData(gl.ARRAY_BUFFER, pcap * 2 * INST * 4, gl.DYNAMIC_DRAW)
    gl.bindBuffer(gl.ARRAY_BUFFER, null)
    sinkUploaded = false
  }
  let sinkUploaded = false
  function uploadParticles() {
    ensureParticleBuffers()
    if (sink.nN) { gl.bindBuffer(gl.ARRAY_BUFFER, bufN); gl.bufferSubData(gl.ARRAY_BUFFER, 0, sink.N, 0, sink.nN * INST) }
    if (sink.nA) { gl.bindBuffer(gl.ARRAY_BUFFER, bufA); gl.bufferSubData(gl.ARRAY_BUFFER, 0, sink.A, 0, sink.nA * INST) }
    gl.bindBuffer(gl.ARRAY_BUFFER, null)
    sinkUploaded = true
  }

  // ── the 2D overlay: nameplates, speech, crosshair — crisp, full resolution, over the GL canvas ──
  if (doc) {
    overlay = doc.createElement('canvas')
    overlay.setAttribute('aria-hidden', 'true'); overlay.dataset.gfx = 'overlay'
    const st = overlay.style
    st.position = 'fixed'; st.left = '0'; st.top = '0'; st.pointerEvents = 'none'; st.display = 'block'
    overlay.width = canvas.width; overlay.height = canvas.height
    if (canvas.parentNode) canvas.parentNode.insertBefore(overlay, canvas.nextSibling)
    ovCtx = overlay.getContext('2d')
    env.overlay = overlay
  }
  function drawOverlay(fs, plates) {
    if (!overlay || !ovCtx) return
    const cw = canvas.width, ch = canvas.height
    const cs = canvas.style
    if (cs.width !== ovW) overlay.style.width = ovW = cs.width
    if (cs.height !== ovH) overlay.style.height = ovH = cs.height
    if (cs.transform !== ovT) overlay.style.transform = ovT = cs.transform
    const cross = !(fs.opts && fs.opts.crosshair === false), u = uiScaleOf(fs), want = plates.length > 0 || cross
    const resized = overlay.width !== cw || overlay.height !== ch
    // the crosshair is static: when nothing that shapes the overlay changed (no plates now or in the last drawn frame, same crosshair pref,
    // ui scale and canvas size) the canvas already shows the right picture, and leaving it alone keeps the browser from re-rasterising and
    // re-compositing a full-viewport layer every frame
    if (overlayUnchanged(ovMemo, resized, plates.length, cross, u, fs.OW, fs.OH)) return
    if (resized) { overlay.width = cw; overlay.height = ch; ovDirty = false }
    else if (want || ovDirty) ovCtx.clearRect(0, 0, cw, ch)            // (only when something was, or will be, drawn)
    if (want) { drawNameplates(ovCtx, fs, plates); drawCrosshair(ovCtx, fs) }
    ovDirty = want
    overlayRemember(ovMemo, plates.length, cross, u, fs.OW, fs.OH)
  }

  // ── frame state that lives across frames ──
  let lastFrame = -1, sceneSeen = null, lastPlan = null
  const PLAN = {}, GO = [0, 0]
  const glowRgb = [0, 0, 0]

  function setTarget(t, w, h) { gl.bindFramebuffer(gl.FRAMEBUFFER, t ? t.fbo : null); gl.viewport(0, 0, w, h) }
  function bind(unit, tex) { gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, tex) }
  function pass(name, dst) { prog(name); setTarget(dst, dst.w, dst.h) }

  // ── bloom: the bright pass on the tiny frame, blurred twice (tight + wide), in bl.Pb / bl.M ──
  function runBloom(fs, sceneTex) {
    const b = ensureBloom(fs.W, fs.H)
    gl.disable(gl.BLEND)
    pass('down', b.t1); bind(0, sceneTex); tri.draw()
    pass('down', b.t2); bind(0, b.t1.tex); tri.draw()
    pass('down', b.t3); bind(0, b.t2.tex); tri.draw()
    pass('grid', b.G); bind(0, b.t3.tex)
    gl.uniform2i(P.grid.u.uSrcSize, b.BW, b.BH); gl.uniform2i(P.grid.u.uOutSize, b.wW, b.wH); gl.uniform2f(P.grid.u.uScale, b.sx, b.sy); tri.draw()
    pass('blur', b.M); bind(0, b.G.tex); tri.draw()
    pass('bright', b.P); bind(0, b.t3.tex); bind(1, b.M.tex); tri.draw()
    pass('blur', b.Pb); bind(0, b.P.tex); tri.draw()
    pass('wide', b.G); bind(0, b.P.tex)
    gl.uniform2i(P.wide.u.uSrcSize, b.BW, b.BH); gl.uniform2i(P.wide.u.uOutSize, b.wW, b.wH); gl.uniform2f(P.wide.u.uScale, b.sx, b.sy); tri.draw()
    pass('blur', b.M); bind(0, b.G.tex); tri.draw()             // (the local-average grid in M was consumed by the bright pass above)
    return b
  }

  function compose(dst, src, b, doBloom, doGrade, plan, fs) {
    const tile = plan.grain ? tileFor(!plan.modern) : dummy      // (created BEFORE the binds: creating a texture binds it to the active unit)
    const c = prog('compose'); setTarget(dst, dst.w, dst.h)
    bind(0, src)
    bind(1, doBloom ? b.Pb.tex : dummy); bind(2, doBloom ? b.M.tex : dummy)
    const grain = plan.grain && !(plan.steam && !doGrade)         // the steam split: grain belongs to the second half
    bind(3, tile)
    gl.uniform2f(c.u.uRes, dst.w, dst.h)
    gl.uniform1i(c.u.uDoBloom, doBloom ? 1 : 0); gl.uniform1i(c.u.uDoGrade, doGrade ? 1 : 0); gl.uniform1i(c.u.uGrainOn, grain ? 1 : 0)
    if (grain) {
      if (plan.modern) { grainOffsetModern(fs.t, GO); gl.uniform1i(c.u.uTileMask, GRAIN_TILE - 1); gl.uniform1f(c.u.uGrainK, 1) }
      else { grainOffsetLegacy(fs.t, GO); gl.uniform1i(c.u.uTileMask, LEGACY_TILE - 1); gl.uniform1f(c.u.uGrainK, LEGACY_GRAIN_ALPHA) }
      gl.uniform2i(c.u.uGrainOff, GO[0], GO[1])
    }
    tri.draw()
  }

  function drawInstances(vao, n, additive, rgb, tw, th, flick, useLuma, tiny) {
    if (!n) return
    const p = prog('particles')
    gl.enable(gl.BLEND)
    if (additive) gl.blendFunc(gl.SRC_ALPHA, gl.ONE); else gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
    gl.uniform3f(p.u.uColor, rgb[0], rgb[1], rgb[2])
    gl.uniform2f(p.u.uTarget, tw, th); gl.uniform1f(p.u.uFlick, flick)
    gl.uniform1i(p.u.uUseLuma, useLuma ? 1 : 0)
    bind(0, useLuma ? tiny : dummy)
    gl.bindVertexArray(vao); gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, n); gl.bindVertexArray(null)
    gl.disable(gl.BLEND)
  }
  function drawParticleSet(tw, th, fs, useLuma, tiny) {
    drawInstances(vaoN, sink.nN, false, sink.rgb, tw, th, fs.flicker, useLuma, tiny)
    if (sink.nA) drawInstances(vaoA, sink.nA, true, sink.kind === 'spark' ? sink.rgb : sink.glowRgb, tw, th, fs.flicker, useLuma, tiny)
  }

  function render(fs, world, nameplates) {
    const plates = nameplates || NONE
    if (queued.size) collectReady()
    const W = fs.W, H = fs.H, cw = canvas.width, ch = canvas.height
    const plan = lastPlan = postPlan(fs, post, PLAN)
    const advance = fs.frame !== lastFrame          // a re-draw of the same frame (the Polaroid's capture) must not step the simulations again
    lastFrame = fs.frame
    gl.disable(gl.BLEND); gl.disable(gl.DEPTH_TEST); gl.disable(gl.CULL_FACE); gl.disable(gl.SCISSOR_TEST)

    // the scene is sampled bilinearly by the chain and the upscale: make sure it is set up for that (once per texture)
    if (world.sceneTex !== sceneSeen) {
      sceneSeen = world.sceneTex
      gl.bindTexture(gl.TEXTURE_2D, sceneSeen)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    }

    // the particle field: seeded on the first frame, only RESCALED by a canvas resize (as the CPU does: fitParticles), stepped once per frame
    fitParticles(post, fs.OW, fs.OH)
    if (plan.parts && advance) {
      if (plan.modern) stepModern(post, fs, plan.steam ? fs.W / fs.OW : 1, sink); else stepLegacy(post, fs, sink)
      uploadParticles()
    } else if (plan.parts && !sinkUploaded) uploadParticles()

    // bloom chain, then the low-res compose
    let b = null
    if (plan.bloom) b = runBloom(fs, world.sceneTex)
    let final = world.sceneTex
    if (plan.compose) {
      ensureLow(W, H, plan.steam)
      if (plan.steam) {
        compose(lowA, world.sceneTex, b, plan.bloom, false, plan, fs)
        gl.viewport(0, 0, W, H)
        drawParticleSet(W, H, fs, plan.bloom, b && b.t3.tex)
        compose(lowB, lowA.tex, null, false, true, plan, fs)
        final = lowB.tex
      } else {
        compose(lowA, world.sceneTex, b, plan.bloom, plan.grade, plan, fs)
        final = lowA.tex
      }
    }

    // the visible frame
    gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, cw, ch)
    const up = prog('up'); bind(0, final)
    gl.uniform2f(up.u.uOut, cw, ch); gl.uniform2f(up.u.uLowRes, W, H)
    gl.uniform1f(up.u.uFlick, 1 - flickerOverlayAlpha(fs))
    if (plan.modern) gl.uniform3f(up.u.uVig, 0, 1, 2); else gl.uniform3f(up.u.uVig, LEGACY_VIGNETTE.depth, LEGACY_VIGNETTE.r0 * ch, LEGACY_VIGNETTE.r1 * ch)
    if (plan.tape) {
      const d = Math.sin(fs.t * 0.42 + Math.sin(fs.t * 0.13) * 1.7) * A.tape.drift
      gl.uniform4f(up.u.uTape, d, A.tape.fringe, A.tape.soft, 1)
    } else gl.uniform4f(up.u.uTape, 0, 0, 0, 0)
    tri.draw()

    // particles on the visible frame (steam already went into the low-res one), then the player's own light when the world pass did not draw it
    if (plan.parts && !plan.steam) drawParticleSet(cw, ch, fs, plan.bloom, b && b.t3.tex)
    const lights = fs.lights, handled = fs.handled || NOT_HANDLED
    const flash = !!(lights && lights.flashlight && !handled.flashlight), glow = lights && lights.glow && !handled.glow ? lights.glow : null
    if (flash || glow) {
      const l = prog('lights'); gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE)
      gl.uniform2f(l.u.uOut, cw, ch); gl.uniform1i(l.u.uFlash, flash ? 1 : 0)
      if (glow) { glowRgb[0] = glow[0] / 255; glowRgb[1] = glow[1] / 255; glowRgb[2] = glow[2] / 255; gl.uniform4f(l.u.uGlow, glowRgb[0], glowRgb[1], glowRgb[2], 0.20 * glowPulse(fs.t)) }
      else gl.uniform4f(l.u.uGlow, 0, 0, 0, 0)
      tri.draw()
      gl.disable(gl.BLEND)
    }
    gl.activeTexture(gl.TEXTURE0)            // leave the sampler unit the way the other passes expect to find it
    drawOverlay(fs, plates)
  }

  function resize(OW, OH) { fitParticles(post, OW, OH) }

  function dispose() {
    try {
      for (const k in P) gl.deleteProgram(P[k].prog)
      dropQueued()
      for (const t of own.tex) gl.deleteTexture(t)
      for (const f of own.fbo) gl.deleteFramebuffer(f)
      for (const b of own.buf) gl.deleteBuffer(b)
      for (const v of own.vao) gl.deleteVertexArray(v)
    } catch { /* the context may already be gone */ }
    own.tex.length = own.fbo.length = own.buf.length = own.vao.length = 0
    if (overlay) { overlay.remove(); if (env.overlay === overlay) env.overlay = null }
  }

  return { render, resize, dispose, get state() { return post }, get plan() { return lastPlan }, get precision() { return fmt.name } }
}
