// scenes-a2.js — harness scenes owned by track A2 (world pass + lighting).
// scenes.js calls register(kit) after the base scenes exist; see the KIT block at the bottom of scenes.js.
// Every scene id is prefixed "a2-". Do not edit any other track's scene file.
//
// Each key view exists twice: `a2-<name>` takes its quality tier from the harness (`--quality`, default legacy), and the
// group `a2-tiers` holds the same views with the tier forced (`a2-<name>-low|medium|high`), so
//     node tools/gfx/run.mjs --src <dir> --out <dir> --scenes a2-tiers
// renders every key view at every lit tier in one run (do not pass --quality with it: the flag overrides the forced tier).
export function register(kit) {
  const { levelScene } = kit

  // a level scene plus its renderOpts / warm-up length
  function view({ id, group, desc, warmup, tier, flicker, ...pose }) {
    const s = levelScene({ id, desc, flicker: flicker ?? 1, ...pose })
    const build = s.build
    s.build = (env) => {
      const spec = build(env)
      if (tier) spec.renderOpts = { ...kit.RENDER_OPTS, qualityTier: tier }
      return spec
    }
    if (group) s.group = group
    if (warmup != null) s.warmup = warmup
    return s
  }

  // [name, description, pose]
  const KEY = [
    ['l0-pools', 'level 0: standing at the edge of the big open area facing east: drop-ceiling panels overhead, pools of light on the carpet with dark between',
      { level: 0, x: 9.5, y: 7.5, angle: 0, enemies: false }],
    ['l0-room', 'level 0: inside a large room, facing its far corner: panels, contact shading where the walls meet floor and ceiling',
      { level: 0, x: 18.0, y: 26.0, angle: -45, enemies: false }],
    ['l0-corridor', 'level 0: a long straight one-wide hall: the lattice pools rhythmically down the floor, the walls pool along their length',
      { level: 0, x: 11.5, y: 19.5, angle: 90, enemies: false }],
    ['l0-flashlight', 'level 0: the player flashlight lights the surfaces it points at (a hall, dark between the pools)',
      { level: 0, x: 11.5, y: 19.5, angle: 90, lights: { flashlight: true }, enemies: false }],
    ['l0-glow', 'level 0: a green glowstick lights the floor, walls and ceiling around the player',
      { level: 0, x: 11.5, y: 19.5, angle: 90, fogMul: 1.6, lights: { glow: [80, 235, 110] }, enemies: false }],
    ['l1-hall', 'level 1: cold sodium-green fluorescents over grey concrete',
      { level: 1, x: 11.5, y: 19.5, angle: 90, enemies: false }],
    ['l2-flashlight', 'level 2: the flashlight cuts a beam down a long dark corridor, four units from the nearest lamp',
      { level: 2, x: 11.5, y: 8.5, angle: 90, lights: { flashlight: true }, enemies: false }],
    ['l3-hall', 'level 3: a long black hall, the nearest lamp five units away (the frame the flashlight scene is compared with)',
      { level: 3, x: 24.5, y: 23.5, angle: 0, enemies: false }],
    ['l3-flashlight', 'level 3: the same black hall with the flashlight on: a warm cone on floor, walls and far end',
      { level: 3, x: 24.5, y: 23.5, angle: 0, lights: { flashlight: true }, enemies: false }],
    ['l3-glow', 'level 3: a green glowstick lights the black hall around the player',
      { level: 3, x: -4.5, y: -10.5, angle: 180, fogMul: 1.6, lights: { glow: [80, 235, 110] } }],
    ['l2-lamps', 'level 2: sparse amber emergency lamps in the dark, light that stops at the corners',
      { level: 2, x: 33.5, y: -3.5, angle: 270 }],
    ['l3-lamps', 'level 3: cold blue-white lamps in a black hall',
      { level: 3, x: -4.5, y: -10.5, angle: 180 }],
    ['lnull-daylight', 'level null: overcast daylight, soft even light, contact shading where the rowhouses meet the ground',
      { level: 4, x: 12.5, y: 13.0, angle: 90 }],
    ['lnull-windows', 'level null: the occupied row that juts into the park: its lit windows spill warm light onto the ground in front of them',
      { level: 4, x: 15.5, y: 6.5, angle: 90 }],
  ]
  for (const [name, desc, pose] of KEY) {
    kit.SCENES.push(view({ id: `a2-${name}`, desc, ...pose }))
    for (const tier of ['low', 'medium', 'high']) {
      kit.SCENES.push(view({ id: `a2-${name}-${tier}`, group: 'a2-tiers', desc: `${desc} [tier ${tier}]`, tier, ...pose }))
    }
  }

  // an open hall (no maze) so the periodic lattice of pools is readable at a glance: 40 x 30 cells, camera at (10.5, 14.5)
  function openHall(id, desc, level, x, y, angle, extra = {}) {
    return {
      id, desc, ...(extra.tier ? { group: 'a2-tiers' } : {}),
      warmup: extra.warmup,
      build(env) {
        const world = kit.buildWorld(env, level, kit.openGrid(44, 30))
        const player = kit.makePlayer(x, y, angle)
        const spec = { cfg: world.cfg, hooks: world.hooks, cache: world.cache, player, flicker: extra.flicker ?? 1, fogMul: extra.fogMul ?? 1, lights: extra.lights || {}, entities: [] }
        if (extra.tier) spec.renderOpts = { ...kit.RENDER_OPTS, qualityTier: extra.tier }
        return spec
      },
    }
  }
  kit.SCENES.push(openHall('a2-l0-lattice', 'level 0: an open 44x30 hall (no maze) so the periodic lattice of panels and pools is readable: bright pools under the panels, dark between, in rows to the horizon', 0, 10.5, 14.5, 0))
  kit.SCENES.push(openHall('a2-l0-lattice-diag', 'level 0: the same open hall looking down a diagonal of the lattice', 0, 6.5, 6.5, 40))
  for (const tier of ['low', 'medium', 'high']) {
    kit.SCENES.push(openHall(`a2-l0-lattice-${tier}`, `open hall [tier ${tier}]`, 0, 10.5, 14.5, 0, { tier }))
    kit.SCENES.push(openHall(`a2-l0-lattice-diag-${tier}`, `open hall diagonal [tier ${tier}]`, 0, 6.5, 6.5, 40, { tier }))
  }

  // the "lights-cascade" event at its peak: rawFlicker 0.2 (the game's target is 0.14). Held long enough that the model's
  // low-pass has settled, so the frame shows the wave: panels far ahead dark, the ones beside the player still lit.
  const CASC = { level: 0, x: 9.5, y: 7.5, angle: 0, enemies: false, flicker: 0.2, warmup: 90 }
  kit.SCENES.push(view({ id: 'a2-l0-cascade', desc: 'level 0: lights-cascade at its peak (rawFlicker 0.2): panels gutter out ahead of the player first, a bounded ambient dip', ...CASC }))
  for (const tier of ['low', 'medium', 'high']) {
    kit.SCENES.push(view({ id: `a2-l0-cascade-${tier}`, group: 'a2-tiers', desc: `lights-cascade [tier ${tier}]`, tier, ...CASC }))
  }
  // a routine dip: a smaller event, so only some panels are dimmed and the rest stay lit
  const DIP = { level: 0, x: 9.5, y: 7.5, angle: 0, enemies: false, flicker: 0.55, warmup: 40 }
  kit.SCENES.push(view({ id: 'a2-l0-dip', desc: 'level 0: a routine dip (rawFlicker 0.55): a few panels dim, most stay lit', ...DIP }))
  for (const tier of ['low', 'medium', 'high']) {
    kit.SCENES.push(view({ id: `a2-l0-dip-${tier}`, group: 'a2-tiers', desc: `routine dip [tier ${tier}]`, tier, ...DIP }))
  }
}
