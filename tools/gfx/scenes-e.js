// scenes-e.js — harness scenes owned by track E (HUD and title attract mode).
// scenes.js calls register(kit) after the base scenes exist; see the KIT block at the bottom of scenes.js.
//
// The HUD is DOM, not canvas: it is looked at with tools/gfx/page.cjs (the real page in a hidden Electron window). What lives here
// are the frames the title-screen attract mode draws — the real renderer down the Level 0 route that gfx-attract.js plans — at the
// backing size the page uses (640x360), so a tier, a texture or a lighting change can be judged on exactly what the title shows:
//   e-attract-a1..a4   a third of the way along each straight of the loop        e-attract-t1..t4   the middle of each turn
//   e-attract-still    the reduced-motion pose
// gfx-attract.js is imported from THIS checkout (../../src/renderer), not from --src: only its pure route/camera functions are used, the
// renderer that draws the frame is still the one under test (env.mods.createRenderer). (A static import on purpose: a top-level await
// here would let the harness page report itself loaded before window.__harness exists.)
import * as attract from '../../src/renderer/gfx-attract.js'

export function register(kit) {
  const { SCENES } = kit
  const size = { w: attract.ATTRACT_VIEW.w, h: attract.ATTRACT_VIEW.h }
  const renderOpts = { grain: true, particles: true, crosshair: false, qualityTier: 'low' }

  const planFor = (env) => {
    const cfg = env.mods.levelConfig(env.base, 0)
    const cache = env.mods.createChunkCache(cfg, attract.ATTRACT_SEED)
    cache.preload(0, 0)
    const route = attract.planRoute({ isOpen: (cx, cy) => !cache.isWall(cx + 0.5, cy + 0.5), seed: attract.ATTRACT_SEED })
    return { cfg, cache, route }
  }
  const scene = (id, desc, pose) => SCENES.push({
    id, desc, size, group: 'e-attract',
    build(env) {
      const { cfg, cache, route } = planFor(env)
      const p = pose(route)
      const player = { x: p.x, y: p.y, angle: p.angle ?? p.heading, bob: 0, bobOffset: 0, moving: false, hp: 100, maxHp: 100 }
      return { cfg, hooks: {}, cache, player, flicker: 1, fogMul: 1, lights: {}, entities: [], renderOpts }
    },
  })

  // route.segs alternates line, arc, line, arc ...
  for (let k = 0; k < 4; k++) {
    scene(`e-attract-a${k + 1}`, `title attract mode: a third of the way along straight ${k + 1} of the Level 0 loop (640x360, tier low)`,
      (route) => { const g = route.segs[2 * k]; return attract.sampleRoute(route, g.s0 + g.len * 0.34) })
    scene(`e-attract-t${k + 1}`, `title attract mode: the middle of turn ${k + 1} (the swing round a junction)`,
      (route) => { const g = route.segs[2 * k + 1]; return attract.sampleRoute(route, g.s0 + g.len * 0.5) })
  }
  scene('e-attract-still', 'title attract mode: the prefers-reduced-motion still frame (down the longest straight)', (route) => attract.stillPose(route))
}
