// gfx-cpu.js — the CPU raycaster backend. Owns everything with a lifetime: the canvases and their contexts,
// the low-res world buffer / z-buffer, the textures, the particle field, the film-grain phase and the frame
// counter. It contains no art logic: each frame it builds the frame-state object `fs` and calls the stages in
// order — world pass (gfx-world.js), sprite pass (gfx-sprites.js), then the screen-space stages (gfx-post.js).
//
// Frame state `fs` (read-only for the stages):
//   W, H, HH        low-res world buffer size and the horizon row (HH includes the head-bob offset)
//   OW, OH          visible canvas size (the upscale target)
//   fog, fogRgb, fogMul, frame
//   flicker         the game's flicker scalar AFTER the comfort clamp (gfx-quality.js effectiveFlicker): use this to dim
//                   anything globally. rawFlicker is the unclamped value: use it as the *event intensity* (1 - rawFlicker)
//                   that spatial flicker (per-panel dips in gfx-light.js) is driven by.
//   comfort         { reduceFlicker, maxGlobalDip } from renderOpts (gfx-quality.js comfortFor)
//   t, dt           real seconds since the start / since the last frame, from render()'s optional `timing` argument
//                   ({ t, dt }); falls back to frame/60 and 1/60. ANIMATE FROM t/dt, never from `frame`.
//   player, lights, lightsOn, hasSky, skyRgb, opts (the live renderOpts object)
//   light           the light model (gfx-light.js); light.enabled === false ⇒ use the legacy shading
//   quality         the current tier from gfx-quality.js: { scale, texFilter, lightDetail, bloom, particles }. The tier is
//                   renderOpts.qualityTier; renderOpts.renderScale (0.3..1), when set, overrides the tier's scale — that is
//                   how the adaptive controller (Track D) trades resolution for frame time.
//   levelKey        '0'..'3' | '∅' | 'legacy' — the key for each stage's own per-level defaults (gfx-util.js levelKey)
//   handled         { flashlight, glow, flicker } — a stage that already lit the surfaces with the player's light per pixel sets
//                   the flag so gfx-post does not draw the screen-space gradient on top a second time (flicker: the world pass
//                   already applied the dip spatially, so the whole-frame blackout overlay must not be drawn as well)
//   look            config.look (or undefined): the level's optional overrides — sky, grade, post, lighting — for the stages that read them
//   fov, hf         field of view and half of it (radians)
//
// Import-safe in Node: `document` is only touched inside createCpuRenderer().
import { hexToRgb, levelKey } from './gfx-util.js'
import { buildTexturesMemo, buildGrain } from './gfx-textures.js'
import { renderWorld } from './gfx-world.js'
import { drawSprites, prewarmSprites } from './gfx-sprites.js'
import { createPostState, seedParticles, buildVignette, composeFrame } from './gfx-post.js'
import { createLight } from './gfx-light.js'
import { qualityFor } from './gfx-quality.js'
import { buildFrameState } from './gfx-frame.js'

const PREWARM_MS = 40      // hard cap on the up-front sprite build (prewarmSprites checks it between frames)

export function createCpuRenderer(canvas, config, renderOpts = {}, worldHooks = {}) {
  const ctx = canvas.getContext('2d', { alpha: false })
  const ropts = renderOpts   // shared mutable object: { grain, crosshair } — read live

  // Fixed-map levels (Level ∅) supply materialAt(wx,wy) -> material code so walls
  // can differ cell-to-cell. Absent (procedural levels) → every wall is '0'.
  const materialAt = worldHooks.materialAt || null

  const fogRgb  = hexToRgb(config.palette.fog)
  const baseFog = config.fogDistance
  // Whether the drop-ceiling fluorescent panels light up. Levels set lights:false
  // (Pipe Dreams, Electrical Station) to go dark — honoured in the ceiling pass
  // (gfx-world.js). Was declared in config and levels but read nowhere; the panels drew
  // unconditionally. `!== false` keeps the lit default for any config missing it.
  const lightsOn = config.lights !== false
  // Outdoor levels (Level ∅) replace the drop-ceiling with open sky.
  const skyRgb  = config.sky ? hexToRgb(config.sky) : null
  const hasSky  = !!skyRgb
  const LEVEL_KEY = levelKey(config)
  const tex     = buildTexturesMemo(config.palette, config.materials, config.look, LEVEL_KEY)     // shared, read-only
  const light   = createLight(config, worldHooks)
  // build the level's exit / notes / props / first creature poses now, under a hard cap (a cut drops the tail; the draw path and
  // the background queue build whatever is left), so they do not hitch the first time they come into view
  try { prewarmSprites(config, PREWARM_MS) } catch (e) { /* the sprites build lazily anyway */ }
  const grainCanvas = buildGrain()
  let frame = 0

  // the current tier, with the optional live scale override (cached so no object is allocated per frame)
  let qBase = null, qOver = null
  function currentQuality() {
    const base = qualityFor(ropts.qualityTier), s = ropts.renderScale
    if (!(s >= 0.3 && s <= 1) || s === base.scale) return base
    if (qBase !== base || qOver.scale !== s) { qBase = base; qOver = Object.freeze({ ...base, scale: s }) }
    return qOver
  }

  // grain phase, particle field, vignette and grain pattern live in the post-stage state
  const post = createPostState(config)

  // low-res world buffer + its own 2D context
  const world = document.createElement('canvas')
  const wctx  = world.getContext('2d', { alpha: false })
  post.grainPattern = wctx.createPattern(grainCanvas, 'repeat')

  let zbuffer = null
  let img = null, buf32 = null
  let RW = 0, RH = 0, winW = 0, winH = 0, curScale = 0

  // (Re)allocate the low-res buffers when the canvas size or the tier's render scale changes. The vignette and the
  // particle field only depend on the canvas size, so a scale change alone does not re-seed them (no visible pop).
  function ensureBuffers(W, H, scale) {
    const sizeChanged = !(winW === W && winH === H)
    if (!sizeChanged && scale === curScale && img) return
    winW = W; winH = H; curScale = scale
    RW = Math.max(1, Math.round(W * scale))
    RH = Math.max(1, Math.round(H * scale))
    world.width = RW; world.height = RH
    img = wctx.createImageData(RW, RH)
    buf32 = new Uint32Array(img.data.buffer)
    zbuffer = new Float32Array(RW)

    if (sizeChanged || !post.vignette) {
      post.vignette = buildVignette(W, H)
      seedParticles(post, winW, winH)
    }
  }

  // timing (optional): { t, dt } real seconds since the start / since the previous frame, from the game loop
  function render(player, isWallFn, flicker, entities = [], fogMul = 1, lights = {}, timing = null) {
    frame++
    const fog = baseFog * fogMul
    const quality = currentQuality()
    ensureBuffers(canvas.width, canvas.height, quality.scale)
    // everything below draws into the low-res world buffer (RW x RH)
    const W = RW, H = RH
    const fs = buildFrameState({
      W, H, OW: canvas.width, OH: canvas.height, fog, fogRgb, fogMul, flicker, frame, timing, player, lights, lightsOn, hasSky, skyRgb,
      light, quality, opts: ropts, levelKey: LEVEL_KEY, look: config.look,
    })

    renderWorld(fs, tex, light, isWallFn, materialAt, buf32, zbuffer)

    // sprites are blitted into the low-res world buffer (per-column depth test against zbuffer) before it goes to the
    // canvas; remote-player labels come back for the full-res pass
    const namePlates = drawSprites(buf32, zbuffer, fs, entities)
    wctx.putImageData(img, 0, 0)

    composeFrame(ctx, wctx, world, fs, post, namePlates)
  }

  return { render }
}
