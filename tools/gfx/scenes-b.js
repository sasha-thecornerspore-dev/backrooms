// scenes-b.js — harness scenes owned by track B (sprites and creatures).
// scenes.js calls register(kit) after the base scenes exist; see the KIT block at the bottom of scenes.js.
// Prefix every scene id with "b-". Do not edit any other track's scene file.
//
//   b-creature-states      the SAME creature idle / chase / stagger side by side (smiler near, hound far)
//   b-thin                 the see-through drop-in in front of a wall: the wall stays visible through it
//   b-exit-note-colours    exit (cold blue) vs unread note (warm) vs read note vs a lit machine, in a dark level
//   b-props-l2             Level 2's prop set at two distances plus a lurker behind them
//   b-lnull-debris         Level ∅'s trash / tire / weeds (every variant) in front of the rowhouse backs
//   b-players              co-op players (facing / turned away) and lost souls, distinguishable at a glance
//   b-rim                  the dynamic-light path: an emitter behind the sprites rims them (uses a stand-in fs.light)
//   b-closeup              close range: how the pre-rasterised frames magnify
//   b-sprites-timing       the sprite-heavy pose the timing script measures (not a beauty shot)
//
// Rot values 5.6 / 5.4 / 9.0 select prop variant 0 / 1 / 2 (the art picks a variant from the seeded `rot`).
export function register(kit) {
  const { SCENES, buildWorld, makePlayer, makeEnemy, openGrid, rad, asProp, asExit, asItem, asNote, asMachine, asRemote, asNpc, asApparition, RENDER_OPTS } = kit

  const CAM = { x: 9.5, y: 10.5, angle: 0 }
  // a world point `dist` ahead of the camera at `bearing` degrees (0 = straight ahead, + = to the right)
  const at = (dist, bearing, cam = CAM) => {
    const a = rad(cam.angle + bearing)
    return [cam.x + dist * Math.cos(a), cam.y + dist * Math.sin(a)]
  }
  const enemy = (variant, dist, bearing, over = {}, type) => {
    const [x, y] = at(dist, bearing)
    const stalker = variant === 'smiler' || variant === 'hound' || variant === 'lurker' || variant === 'tesla'
    return { ...makeEnemy(variant, x, y, type || (stalker ? 'stalker' : 'wanderer')), ...over }
  }
  const TOWARD = Math.PI      // heading west: toward the camera
  const scene = (id, desc, level, grid, entities, extra = {}) => SCENES.push({
    id, desc,
    build(env) {
      const world = buildWorld(env, level, grid)
      const player = makePlayer(CAM.x, CAM.y, CAM.angle)
      return { cfg: world.cfg, hooks: world.hooks, cache: world.cache, player, flicker: extra.flicker ?? 1, fogMul: extra.fogMul ?? 1, lights: extra.lights || {}, entities: entities(env), renderOpts: extra.renderOpts }
    },
  })

  // ── the same creature in three states ───────────────────────────────────────────────────────
  scene('b-creature-states',
    'the same smiler idle / chasing / staggered (3.6 away, left to right) and the same hound idle-in-profile / chasing / staggered behind them (7 away)',
    0, openGrid(22, 21), () => [
      enemy('smiler', 3.6, -24, { state: 'idle', dir: 0 }),
      enemy('smiler', 3.6, 0, { state: 'chase', dir: TOWARD }),
      enemy('smiler', 3.6, 24, { state: 'staggered', stagger: 2.2, wardHits: 1, dir: 0 }),
      enemy('hound', 7, -12, { state: 'idle', dir: Math.PI / 2 }),
      enemy('hound', 7, 11, { state: 'chase', dir: TOWARD }),
      enemy('hound', 7, 34, { state: 'stagger', stagger: 2.2, dir: 0 }),
    ])

  // ── thin: the wall must stay visible through it ─────────────────────────────────────────────
  const thinGrid = () => {
    const rows = openGrid(22, 21)
    // a 2-cell-thick wall block 5 cells ahead of the camera, rows 7..13 (a clean vertical edge to see through the figures)
    return rows.map((r, y) => (y >= 7 && y <= 13 ? r.slice(0, 15) + 'XX' + r.slice(17) : r))
  }
  scene('b-thin',
    'a thin drop-in (translucent) standing in front of a wall block, half over the wall and half over the open floor, and another farther off; a solid shade crossing for contrast',
    0, thinGrid(), () => {
      const [x1, y1] = at(3.9, -5), [x2, y2] = at(2.6, 17), [x3, y3] = at(4.6, 13)
      return [
        asApparition({ x: x1, y: y1, variant: 'thin', vx: 0.2, vy: 0.5 }),
        asApparition({ x: x2, y: y2, variant: 'thin', vx: 0, vy: 0 }),
        asApparition({ x: x3, y: y3, variant: 'shade', vx: 0, vy: 2.6 }),
      ]
    })

  // ── exit vs note colours (a dark level so the glows carry) ──────────────────────────────────
  scene('b-exit-note-colours',
    'level-2 dark: the cold blue exit (6 away), an unread note (warm glow), a read note (dim), a stocked and a spent vending machine, a glowstick item: blue = exit, warm = note',
    2, openGrid(22, 21), () => {
      const P = (d, b) => at(d, b)
      const [ex, ey] = P(6, -14), [n1x, n1y] = P(3.1, 9), [n2x, n2y] = P(3.6, 21), [m1x, m1y] = P(5.2, -32), [m2x, m2y] = P(6.5, 30), [gx, gy] = P(2.6, -3)
      return [
        asExit({ x: ex, y: ey, target: 3, key: 'e' }),
        asNote({ x: n1x, y: n1y, frag: 1, key: 'n1' }, new Set()),
        asNote({ x: n2x, y: n2y, frag: 2, key: 'n2' }, new Set([2])),
        asMachine({ x: m1x, y: m1y, key: 'm1' }, new Set()),
        asMachine({ x: m2x, y: m2y, key: 'm2' }, new Set(['m2'])),
        asItem({ x: gx, y: gy, type: 'glowstick', key: 'g' }),
      ]
    })

  // ── level 2 props ───────────────────────────────────────────────────────────────────────────
  const ROTS = [5.6, 5.4, 9.0]
  scene('b-props-l2',
    'level 2 props: pipe, valve, drum, toolbox, vent, crate — near row (3.4 away, variant 0) and far row (6.4 away, variants 1 and 2) — and a lurker beyond',
    2, openGrid(22, 21), () => {
      const types = ['pipe', 'valve', 'drum', 'toolbox', 'vent', 'crate']
      const out = []
      types.forEach((t, i) => {
        const [x, y] = at(3.4, -27 + i * 10.8)
        out.push(asProp({ x, y, type: t, rot: ROTS[0], key: 'a' + i }))
        const [fx, fy] = at(6.4, -28 + i * 11.2 + 4)
        out.push(asProp({ x: fx, y: fy, type: t, rot: ROTS[1 + (i & 1)], key: 'b' + i }))
      })
      out.push(enemy('lurker', 9.4, 2, { state: 'idle', dir: TOWARD }))
      return out
    })

  // ── level ∅ debris ──────────────────────────────────────────────────────────────────────────
  SCENES.push({
    id: 'b-lnull-debris',
    desc: 'level null: trash, a tyre and weeds (all three variants of each, both flips) strewn along the yard in front of the south rowhouse backs',
    build(env) {
      const world = buildWorld(env, 4)
      const player = makePlayer(12.5, 12.0, 90)
      const at2 = (d, b) => { const a = rad(90 + b); return [12.5 + d * Math.cos(a), 12.0 + d * Math.sin(a)] }
      const out = []
      const layout = [['trash', 2.0, -22], ['tire', 2.5, -8], ['weeds', 2.2, 8], ['trash', 3.0, 22], ['weeds', 3.6, -30], ['tire', 3.6, -3], ['trash', 3.9, 14], ['tire', 4.1, 26], ['weeds', 4.6, -15], ['weeds', 4.4, 33], ['box', 3.0, 3]]
      layout.forEach(([t, d, b], i) => { const [x, y] = at2(d, b); out.push(asProp({ x, y, type: t, rot: ROTS[i % 3] + (i % 2 ? 0 : 0), key: 'd' + i })) })
      return { cfg: world.cfg, hooks: world.hooks, cache: world.cache, player, flicker: 1, fogMul: 1, lights: {}, entities: out }
    },
  })

  // ── people ──────────────────────────────────────────────────────────────────────────────────
  scene('b-players',
    'two co-op players (one facing you with a speech bubble, one turned away), a far player, and two lost souls (3 and 6 away): cold and upright vs slumped and grey',
    0, openGrid(22, 21), () => {
      const [a, b] = at(3.2, -20), [c, d] = at(3.4, 17), [e, f] = at(7.2, -6), [g, h] = at(4.2, -2), [i, j] = at(6.4, 30)
      return [
        asRemote({ x: a, y: b, name: 'wanderer', angle: Math.PI, chatText: 'is anyone there?', hp: 88 }),
        asRemote({ x: c, y: d, name: 'moss', angle: 0, hp: 64 }),
        asRemote({ x: e, y: f, name: 'far', angle: Math.PI, hp: 100 }),
        asNpc({ x: g, y: h, key: 'a' }),
        asNpc({ x: i, y: j, key: 'b' }),
      ]
    })

  // ── the dynamic light path (a stand-in fs.light: an emitter beyond the sprites) ─────────────
  const emitter = (ex, ey) => ({
    enabled: true,
    at: () => 0.85,
    tint: () => [1, 0.96, 0.82],
    nearest: (x, y) => ({ x: ex, y: ey, dist: Math.hypot(ex - x, ey - y), r: 255, g: 232, b: 170 }),
    panelLevel: () => 1,
  })
  scene('b-rim',
    'the dynamic-light path: a warm emitter beyond and left of a shade, a smiler, a hound and a co-op player rims them on the side facing it (stand-in fs.light; the real model plugs in through the same fields)',
    0, openGrid(22, 21), () => [
      enemy('shade', 4.2, -22, { dir: TOWARD }),
      enemy('smiler', 4.2, -4, { state: 'chase', dir: TOWARD }),
      enemy('hound', 4.8, 15, { state: 'chase', dir: TOWARD }),
      asRemote({ x: at(4.2, 30)[0], y: at(4.2, 30)[1], name: 'lit', angle: Math.PI, hp: 100 }),
    ], { renderOpts: { ...RENDER_OPTS, spriteLightOverride: emitter(15.5, 6.5) } })

  // ── close up: how the frames magnify ──
  scene('b-closeup',
    'close range (1.7-2.4 away): a cabinet, a couch, a chasing smiler, a co-op player and an item — the pre-rasterised frames magnified',
    0, openGrid(22, 21), () => [
      asProp({ x: at(1.9, -22)[0], y: at(1.9, -22)[1], type: 'cabinet', rot: ROTS[0], key: 'c1' }),
      asProp({ x: at(2.3, 24)[0], y: at(2.3, 24)[1], type: 'couch', rot: ROTS[1], key: 'c2' }),
      enemy('smiler', 2.4, 0, { state: 'chase', dir: TOWARD }),
      asItem({ x: at(1.5, -6)[0], y: at(1.5, -6)[1], type: 'polaroid', key: 'ci' }),
      asRemote({ x: at(3.2, 14)[0], y: at(3.2, 14)[1], name: 'near', angle: Math.PI, hp: 80 }),
    ])

  // ── the pose the timing script measures ─────────────────────────────────────────────────────
  scene('b-sprites-timing',
    'a busy sprite view: two rows of props, several creatures, players and items across the whole field of view',
    0, openGrid(22, 21), () => {
      const out = []
      const types = ['chair', 'cabinet', 'box', 'crate', 'cone', 'plant', 'pallet', 'barrel', 'couch', 'cart']
      types.forEach((t, i) => { const [x, y] = at(2.6 + (i % 3) * 1.4, -34 + i * 7.6); out.push(asProp({ x, y, type: t, rot: ROTS[i % 3], key: 't' + i })) })
      out.push(enemy('shade', 3.3, -10, { dir: TOWARD, state: 'chase' }), enemy('smiler', 4.4, 8, { dir: TOWARD, state: 'chase' }), enemy('watcher', 5.5, -22), enemy('hound', 3.0, 26, { state: 'chase', dir: TOWARD }), enemy('lurker', 6.2, 0, { dir: TOWARD }))
      out.push(asRemote({ x: at(3.8, -2)[0], y: at(3.8, -2)[1], name: 'p', angle: Math.PI, hp: 90 }))
      out.push(asExit({ x: at(7, 14)[0], y: at(7, 14)[1], target: 1, key: 'x' }), asNote({ x: at(3.2, -30)[0], y: at(3.2, -30)[1], frag: 0, key: 'nn' }, new Set()))
      return out
    })
}
