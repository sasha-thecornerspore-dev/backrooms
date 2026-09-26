// scenes-c.js — harness scenes owned by track C (atmosphere: post, sky, bloom, grade, particles, tape).
// scenes.js calls register(kit) after the base scenes exist; see the KIT block at the bottom of scenes.js.
// Every id is prefixed "c-". Each scene pins the tier it shows off through renderOpts.qualityTier (the harness's
// --quality flag overrides that for every scene, e.g. `--quality legacy` proves the legacy path is untouched).
//   node tools/gfx/run.mjs --src <src/renderer> --out tools/gfx/out/c --scenes c-lnull-sky,c-l0-bloom
export function register(kit) {
  const { levelScene, RENDER_OPTS } = kit
  const ro = (tier, extra) => ({ ...RENDER_OPTS, qualityTier: tier, ...(extra || null) })

  // wrap a kit.levelScene so its spec carries renderOpts
  function withOpts(scene, opts, group) {
    const build = scene.build
    return { ...scene, group: group || scene.group || scene.id, build(env) { return { ...build(env), renderOpts: opts } } }
  }
  // a scene on an open, fixed 22x21 floor in level `lv` (that level's palette, fog, particles and post), camera at (9.5, 10.5)
  function openScene({ id, desc, level, tier, entities, angle = 0, x = 9.5, y = 10.5, flicker = 1, fogMul = 1, lights = {}, extraOpts, group, look }) {
    return {
      id, desc, group: group || id,
      build(env) {
        const world = kit.buildWorld(env, level, kit.openGrid(22, 21))
        const player = kit.makePlayer(x, y, angle)
        const ents = typeof entities === 'function' ? entities(kit) : (entities || [])
        const cfg = look ? { ...world.cfg, look } : world.cfg
        return { cfg, hooks: world.hooks, cache: world.cache, player, flicker, fogMul, lights, entities: ents, renderOpts: ro(tier, extraOpts) }
      },
    }
  }
  const push = (s) => kit.SCENES.push(s)

  // ── Level ∅ sky: the same spot at four headings, 20 degrees apart. The clouds must slide across the frame as the player
  // turns (they are mapped by view angle, not painted on the screen). Feature edges in `a` reappear shifted in `b`, `c`, `d`.
  ;[80, 100, 120, 140].forEach((a, i) => {
    push(withOpts(levelScene({ id: `c-lnull-sky-${'abcd'[i]}`, level: 4, x: 10.5, y: 8.5, angle: a, enemies: false,
      desc: `level null: mid-yard at heading ${a} degrees — overcast sky (the clouds pan with the heading; compare a/b/c/d)` }), ro('medium'), 'c-lnull-sky'))
  })
  // debug: the sky with grade/vignette/grain off, for measuring the pan numerically (tools/gfx/out/xcorr.mjs)
  ;[80, 100].forEach((a, i) => {
    const sc = levelScene({ id: `c-dbg-sky-${'ab'[i]}`, level: 4, x: 10.5, y: 8.5, angle: a, enemies: false, desc: `debug: raw sky at heading ${a}` })
    const b = sc.build
    push({ ...sc, group: 'c-dbg', build(env) { const o = b(env); return { ...o, cfg: { ...o.cfg, look: { grade: { strength: 0, lift: 0, contrast: 0 }, post: { grain: 0 } } }, renderOpts: ro('medium') } } })
  })
  push(withOpts(levelScene({ id: 'c-lnull-sky-legacy', level: 4, x: 10.5, y: 8.5, angle: 100, enemies: false,
    desc: 'level null: the same view as c-lnull-sky-b at the legacy tier (the old flat gradient)' }), ro('legacy'), 'c-lnull-sky'))

  // ── bloom (tier high): the same room with and without the bright-pass composite, so the difference can be diffed
  push(withOpts(levelScene({ id: 'c-l0-bloom', level: 0, x: 18.0, y: 26.0, angle: -45, desc: 'level 0: the lit room at tier high — halo bleeding off the ceiling panels onto the wall tops' }),
    ro('high'), 'c-l0-bloom'))
  push(withOpts(levelScene({ id: 'c-l0-bloom-off', level: 0, x: 18.0, y: 26.0, angle: -45, desc: 'level 0: the same room at tier high with bloom switched off (opts.bloom=false)' }),
    ro('high', { bloom: false }), 'c-l0-bloom'))
  push(withOpts(levelScene({ id: 'c-l0-bloom-corridor', level: 0, x: 11.5, y: 19.5, angle: 90, desc: 'level 0: the long corridor at tier high — bloom on the ceiling and the vanishing point' }),
    ro('high'), 'c-l0-bloom'))

  // ── the gameplay cues must survive grade + bloom: an exit beam, an unread note and a glowstick in the dark of level 2 / 3
  const cues = (k) => [k.asExit({ x: 14.5, y: 9.6 }), k.asNote({ x: 12.4, y: 11.4, frag: 0 }, new Set()), k.asItem({ x: 11.3, y: 9.4, type: 'glowstick' })]
  for (const tier of ['legacy', 'medium', 'high']) {
    push(openScene({ id: `c-l2-cues-${tier}`, level: 2, tier, entities: cues, desc: `level 2: exit beam + unread note + glowstick in the dark, tier ${tier} (the cold beam must stay cold and readable)`, group: 'c-cues' }))
  }
  push(openScene({ id: 'c-l3-cues-high', level: 3, tier: 'high', entities: cues, desc: 'level 3: the same cues at tier high (blue-black grade, blue bloom tint)', group: 'c-cues' }))

  // ── particles: steam rising in level 2 (lit by a flashlight), sparks in level 3, dust in the lobby and a glowstick's wash
  push(withOpts(levelScene({ id: 'c-l2-particles', level: 2, x: 33.5, y: -3.5, angle: 270, lights: { flashlight: true }, extra: () => [kit.makeEnemy('lurker', 34.5, -8.5)],
    desc: 'level 2: steam rising through the flashlight beam (tier medium) — near wisps large and soft, far ones small' }), ro('medium'), 'c-particles'))
  push(withOpts(levelScene({ id: 'c-l2-particles-dark', level: 2, x: 33.5, y: -3.5, angle: 270, extra: () => [kit.makeEnemy('lurker', 34.5, -8.5)],
    desc: 'level 2: the same with no light on (steam nearly invisible in the dark)' }), ro('medium'), 'c-particles'))
  push(withOpts(levelScene({ id: 'c-l3-sparks', level: 3, x: -4.5, y: -10.5, angle: 180, extra: () => [kit.makeEnemy('tesla', -7.5, -11.9)],
    desc: 'level 3: electrical sparks (tier medium) — soft, additive, never a strobe' }), ro('medium'), 'c-particles'))
  push(withOpts(levelScene({ id: 'c-l0-dust-glow', level: 0, x: 11.5, y: 19.5, angle: 90, fogMul: 1.6, lights: { glow: [80, 235, 110] },
    desc: 'level 0: dust in a green glowstick wash (tier medium) — motes near the light pick up its colour' }), ro('medium'), 'c-particles'))

  // ── the flicker overlay: the legacy path draws a black 0.75*(1-flicker) overlay ON TOP of a world already dimmed by the same
  // scalar. With a live light model (medium and up) the overlay is gone; the legacy tier keeps it.
  push(withOpts(levelScene({ id: 'c-l0-dip-legacy', level: 0, x: 11.5, y: 19.5, angle: 90, flicker: 0.35,
    desc: 'level 0: a flicker dip (0.35) with NO light model — the legacy black overlay is drawn (tier legacy)' }), ro('legacy'), 'c-l0-dip'))
  push(withOpts(levelScene({ id: 'c-l0-dip-light', level: 0, x: 11.5, y: 19.5, angle: 90, flicker: 0.35,
    desc: 'level 0: the same dip with the light model live — the overlay is skipped, only the world dimming remains (tier medium)' }), ro('medium'), 'c-l0-dip'))

  // ── a wish-drifted palette (config.palette is what wishes drift): the grade must follow the new hue, not drag it back to stock
  const drifted = (id, level, palette, desc) => {
    const sc = levelScene({ id, level, x: 11.5, y: 19.5, angle: 90, desc })
    const b = sc.build
    push({ ...sc, group: 'c-drift', build(env) { const o = b(env); return { ...o, cfg: { ...o.cfg, palette: { ...o.cfg.palette, ...palette } }, renderOpts: ro('medium') } } })
  }
  drifted('c-l1-drift', 1, { wall: '#8C7470', ceiling: '#9E8886', floor: '#3A3030', fog: '#A2868A' }, 'level 1 with its palette drifted toward rose (wish): the cold-green grade follows the new fog hue instead of pulling it back to green')
  drifted('c-l0-drift', 0, { wall: '#9A70C8', ceiling: '#D8C0E8', floor: '#2A2048', fog: '#B88AD4' }, 'level 0 drifted to violet (wish): still graded in its own hue')

  // ── the tape layer (opt-in): gate drift + fringe + soft focus, low contrast
  push(withOpts(levelScene({ id: 'c-l0-tape', level: 0, x: 11.5, y: 19.5, angle: 90, desc: 'level 0: the optional tape layer on (opts.tape) at tier medium' }), ro('medium', { tape: true }), 'c-tape'))
  push(withOpts(levelScene({ id: 'c-l0-tape-off', level: 0, x: 11.5, y: 19.5, angle: 90, desc: 'level 0: the same frame with the tape layer off (the default)' }), ro('medium'), 'c-tape'))
}
