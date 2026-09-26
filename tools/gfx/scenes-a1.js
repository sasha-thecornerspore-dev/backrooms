// scenes-a1.js — harness scenes owned by track A1 (surfaces / textures).
// scenes.js calls register(kit) after the base scenes exist; see the KIT block at the bottom of scenes.js.
// Prefix every scene id with "a1-". Do not edit any other track's scene file.
//
// The close-ups and the variant strips stand in a purpose-built open room (a fixed grid) that is configured as the
// real level (palette, look, textures), so the wall / floor / ceiling variants are seen in isolation from the maze,
// props and creatures. The seed-0 maze / the real ∅ map are used for the in-context views.
export function register(kit) {
  const { SCENES, buildWorld, makePlayer, openGrid, levelScene } = kit

  // an open room W x H, camera at (x, y) looking `angle` degrees (0 = east, 90 = south, -90 = north)
  function roomScene({ id, desc, level, w = 26, h = 10, x, y, angle, fogMul = 1, flicker = 1, lights = {}, size }) {
    SCENES.push({
      id, desc, size,
      build(env) {
        const world = buildWorld(env, level, openGrid(w, h))
        const player = makePlayer(x, y, angle)
        return { cfg: world.cfg, hooks: world.hooks, cache: world.cache, player, flicker, fogMul, lights, entities: [] }
      },
    })
  }

  // ── level 0 ──
  roomScene({ id: 'a1-l0-wall-closeup', desc: 'level 0: a wallpaper wall from 1.3 cells away (damask, stripes, scuffed baseboard); floor and ceiling in the same frame',
    level: 0, x: 9.5, y: 2.3, angle: -90, fogMul: 1.0 })
  roomScene({ id: 'a1-l0-variants', desc: 'level 0: the north wall from 4 cells, ~6 adjacent cells: wall variants side by side (seams), carpet and ceiling variants',
    level: 0, x: 9.5, y: 5.3, angle: -90, fogMul: 1.4 })
  roomScene({ id: 'a1-l0-variants-b', desc: 'level 0: the same wall from further along, a different run of cells',
    level: 0, x: 16.5, y: 5.3, angle: -90, fogMul: 1.4 })

  // ── levels 1-3: one close-up each (a wall 1.3 cells away with floor and ceiling), and a strip of adjacent cells ──
  for (const [level, tag, name] of [[1, 'l1', 'habitable zone (painted cinder block, slab, dirty tile ceiling)'], [2, 'l2', 'pipe dreams (riveted rust steel, wet floor, pipe and duct ceiling)'], [3, 'l3', 'electrical station (steel panels, conduit, deck floor, cable trays)']]) {
    roomScene({ id: 'a1-' + tag + '-closeup', desc: 'level ' + level + ' ' + name + ': a wall from 1.3 cells', level, x: 9.5, y: 2.3, angle: -90, fogMul: 1.6 })
    roomScene({ id: 'a1-' + tag + '-variants', desc: 'level ' + level + ': ~6 adjacent wall cells from 4 cells: variants side by side, floor and ceiling variants', level, x: 9.5, y: 5.3, angle: -90, fogMul: 1.8 })
  }
  roomScene({ id: 'a1-l2-ceiling', desc: 'level 2: looking up and along the pipe / duct runs of the ceiling (a long room, camera at the far end)', level: 2, w: 30, h: 8, x: 2.5, y: 3.5, angle: 0, fogMul: 2.0 })
  roomScene({ id: 'a1-l3-ceiling', desc: 'level 3: the cable-tray ceiling and the deck floor running away down a long room', level: 3, w: 30, h: 8, x: 2.5, y: 3.5, angle: 0, fogMul: 2.0 })

  // ── level ∅ (the real fixed map: materialAt is live) ──
  const nullScene = (id, desc, x, y, angle, fogMul = 1) => SCENES.push(levelScene({ id, desc, level: 4, x, y, angle, fogMul, enemies: false }))
  nullScene('a1-lnull-materials', 'level null: the south rowhouse backs from 3.7 cells: brick, black window, plywood + number, sealed CMU, lit window, formstone (all six codes, side by side)', 3.0, 13.3, 90)
  nullScene('a1-lnull-marble', 'level null: the marble stoop face from 2.4 cells (veined, cracked, worn)', 9.5, 9.4, -90)
  nullScene('a1-lnull-lit', 'level null: the lit, curtained windows of the jutting occupied row from 2.4 cells', 15.5, 7.6, 90)
  nullScene('a1-lnull-formstone', 'level null: the west wall (formstone, CMU, plywood, windows) at a glancing angle along the block', 3.2, 4.0, 200)
  nullScene('a1-lnull-ground', 'level null: the gravel-and-weed ground and the row of backs, fog pulled back', 12.0, 14.5, 90, 1.5)
  // ── texture build cost in the real engine ──
  // Not a picture (the frame is a plain level wall): each scene times createRenderer() — which runs buildTextures() for the level —
  // three times in this Chromium and prints the numbers as a page warning on stderr. Run ONE of them per harness invocation for a cold
  // number (`--scenes a1-buildtime-l4`): the first call in a fresh process also pays JIT warm-up, which is what a player's first level costs.
  for (const level of [0, 1, 2, 3, 4]) {
    SCENES.push({
      id: 'a1-buildtime-l' + level, group: 'a1-buildtime',
      desc: 'timing only: createRenderer() (buildTextures) for level ' + level + ' x3 in this Chromium, printed to stderr; the PNG is a plain wall',
      build(env) {
        const now = (typeof window !== 'undefined' && window.__gfx && window.__gfx.realNow) || (() => performance.now())
        const world = buildWorld(env, level)
        const ms = []
        for (let k = 0; k < 3; k++) {
          const c = document.createElement('canvas'); c.width = 320; c.height = 180
          const t0 = now()
          env.mods.createRenderer(c, world.cfg, {}, world.hooks)
          ms.push(Math.round((now() - t0) * 10) / 10)
        }
        console.warn('a1-buildtime level ' + level + ': createRenderer ms (1st, 2nd, 3rd) = ' + ms.join(', '))
        return { cfg: world.cfg, hooks: world.hooks, cache: world.cache, player: makePlayer(9.5, 2.3, -90), flicker: 1, fogMul: 1, lights: {}, entities: [] }
      },
    })
  }
}
