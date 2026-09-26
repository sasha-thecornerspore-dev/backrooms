// scenes-d.js — harness scenes owned by track D (quality / comfort / preferences).
// scenes.js calls register(kit) after the base scenes exist; see the KIT block at the bottom of scenes.js.
// Prefix every scene id with "d-". Do not edit any other track's scene file.
//
// What track D changes is not a new picture but how the SAME picture is produced on every device, so these scenes hold
// the view still and vary the knobs:
//   d-scale-*      the adaptive controller's whole range on two levels: renderScale 0.4 (its floor), 0.6 (today) and 0.9
//                  (its ceiling). Is the floor still readable? Is the ceiling worth its pixels?
//   d-tier-*       the three named tiers side by side on the same view
//   d-dip-l3-*     the deepest whole-frame flicker dip the game can produce (Level 3, flicker 0.14) under the three comfort
//                  settings: legacy (no clamp), the shipped default (never below 50%) and reduceFlicker (never below 75%)
//   d-dpr-*        the hi-DPI plan: a 1.5x canvas whose internal buffer is the same size as the 1x canvas's
//
// The harness's --quality / --reduce-flicker flags override the tier / reduceFlicker set here.
export function register(kit) {
  const RO = kit.RENDER_OPTS
  // wrap a levelScene so its frame spec also carries renderOpts (the live prefs object the renderer reads)
  const withOpts = (scene, ro, size) => {
    const build = scene.build
    scene.build = (env) => ({ ...build(env), renderOpts: { ...RO, ...ro } })
    if (size) scene.size = size
    return scene
  }

  // the two poses the base scenes use: the lobby corridor and the Level ∅ yard (the two extremes of the palette)
  const L0 = { level: 0, x: 11.5, y: 19.5, angle: 90 }
  const LN = { level: 4, x: 12.5, y: 13.0, angle: 90 }

  for (const [tag, pose, name] of [['l0', L0, 'lobby corridor'], ['ln', LN, 'Level null yard']]) {
    for (const [s, tier] of [[0.4, 'low'], [0.6, 'medium'], [0.9, 'high']]) {
      kit.SCENES.push(withOpts(kit.levelScene({
        id: `d-scale-${tag}-${String(Math.round(s * 100)).padStart(3, '0')}`,
        desc: `${name} at renderScale ${s} (${tier} tier): the adaptive controller's ${s === 0.4 ? 'floor' : s === 0.9 ? 'ceiling' : 'middle (today\'s 0.6)'}`,
        ...pose,
      }), { qualityTier: tier, renderScale: s }))
    }
  }

  for (const tier of ['low', 'medium', 'high']) {
    kit.SCENES.push(withOpts(kit.levelScene({
      id: `d-tier-${tier}`,
      desc: `level 2 pipe dreams, the base scene's pose, at the ${tier} tier's own scale and features (no renderScale override)`,
      level: 2, x: 33.5, y: -3.5, angle: 270, extra: () => [kit.makeEnemy('lurker', 34.5, -8.5)],
    }), { qualityTier: tier }))
  }

  // the deepest dip the state machine can request: Level 3 (depth 0.92) -> flicker 0.14
  const L3 = { level: 3, x: -4.5, y: -10.5, angle: 180, flicker: 0.14 }
  kit.SCENES.push(
    withOpts(kit.levelScene({ id: 'd-dip-l3-legacy', desc: 'level 3 at flicker 0.14 with NO comfort clamp (the old behaviour: 86% blackout)', ...L3 }), {}),
    withOpts(kit.levelScene({ id: 'd-dip-l3-default', desc: 'level 3 at flicker 0.14 with the shipped comfort default (maxGlobalDip 0.5: never below half brightness)', ...L3 }), { qualityTier: 'medium', maxGlobalDip: 0.5 }),
    withOpts(kit.levelScene({ id: 'd-dip-l3-reduce', desc: 'level 3 at flicker 0.14 with reduceFlicker (maxGlobalDip 0.25: never below 75% brightness)', ...L3 }), { qualityTier: 'medium', maxGlobalDip: 0.5, reduceFlicker: true }),
  )

  // hi-DPI: css 960x540 either way. Off: canvas 960x540 @ renderScale 0.6. On (ratio 1.5): canvas 1440x810 @ renderScale 0.4.
  // Both raycast a 576x324 buffer; only the full-resolution overlays (vignette, grain, particles, crosshair) differ.
  kit.SCENES.push(
    withOpts(kit.levelScene({ id: 'd-dpr-off', desc: 'hi-DPI off: 960x540 canvas, renderScale 0.6 (576x324 internal)', ...LN }), { qualityTier: 'medium', renderScale: 0.6 }),
    withOpts(kit.levelScene({ id: 'd-dpr-on', desc: 'hi-DPI on at ratio 1.5: 1440x810 canvas, renderScale 0.4 (still 576x324 internal)', ...LN }), { qualityTier: 'medium', renderScale: 0.4, uiScale: 1.5 }, { w: 1440, h: 810 }),
  )
}
