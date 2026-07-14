// levels.js — the descent.
//
// The Backrooms is no longer one endless yellow floor. It is a stack of
// levels, each with its own look, its own rules, and its own way down.
// Descriptions and the no-clip transition lore follow the Backrooms wiki
// canon (Level 0 "The Lobby" → 1 "Habitable Zone" → 2 "Pipe Dreams" →
// 3 "Electrical Station").
//
// Each level is a partial config that is merged OVER the base world config
// (DEFAULT_CONFIG, possibly drifted by world.json). game.js rebuilds the
// world, renderer, entities and decor from the merged config on every
// transition. Inventory and hit points carry with you; the world does not.

export const LEVELS = [
  // ── Level 0 — The Lobby ──────────────────────────────────────────────
  // Mono-yellow rooms, damp carpet, the fluorescent hum. Safe. No entities.
  {
    id: 0,
    name: 'level 0 — the lobby',
    sub: 'the hum of fluorescent light. damp carpet. no exit. you are here.',
    config: {
      palette: { wall: '#C8B870', ceiling: '#E8E0C0', floor: '#4A3820', fog: '#D4C87A' },
      fogDistance: 16,
      flicker: { rate: 0.06, depth: 0.55, recoverySpeed: 12 },
      // dreamy, nostalgic mall-muzak that isn't quite right — light, lively beat
      music: { root: 220, scale: [0, 2, 4, 7, 9], progressions: [[0, 3, 4, 2], [0, 2, 3, 4], [2, 4, 0, 3]],
               tempo: 400, beatsPerChord: 8, beatsPerBar: 4, groove: 0.5, arpLen: 0.5, leadChance: 0.35,
               brightness: 1500, wobble: 0.006, bend: 0.10, noteLen: 1.5, volume: 0.06 },
      maze:  { salt: 0x0000, roomChance: 0.16, braid: 0.12, corridor: 1 },
      particles: { count: 45, color: [235, 228, 190], size: 1.4, sway: 0.35, speed: 0.25 },   // pale dust
      lights: true,
      entities: { enabled: false },
      items: { density: 5, types: ['almond-water', 'glowstick', 'polaroid', 'radio'] },
      props: { density: 3, types: ['chair', 'cabinet', 'box', 'cone', 'papers', 'plant'] },
      exit:  { target: 1, denom: 4, label: 'no-clip deeper',
               hint: 'the walls are thin here — no-clip through a torn corner and you fall out of the lobby.' },
      messages: [
        'the wallpaper is the same in every direction.',
        'the carpet is damp.',
        'the lights do not turn off.',
        'you have been walking for hours. days. weeks.',
        'the humming never stops.',
        'there is no exit. keep looking.',
        'level 0. somewhere. always.',
      ],
    },
  },

  // ── Level 1 — Habitable Zone ─────────────────────────────────────────
  // Bigger, colder concrete. Dim service lighting. Things live here now.
  {
    id: 1,
    name: 'level 1 — habitable zone',
    sub: 'concrete and dim service lights. something moved in the warehouse dark.',
    config: {
      palette: { wall: '#8C8674', ceiling: '#9E9A88', floor: '#39372F', fog: '#A29C86' },
      fogDistance: 14,
      flicker: { rate: 0.10, depth: 0.70, recoverySpeed: 10 },
      // melancholy, minor — the muzak has curdled — steady beat
      music: { root: 174.61, scale: [0, 3, 5, 7, 10], progressions: [[0, 2, 4, 3], [0, 3, 2, 4], [3, 2, 4, 0]],
               tempo: 440, beatsPerChord: 8, beatsPerBar: 4, groove: 0.55, arpLen: 0.55, leadChance: 0.32,
               brightness: 1050, wobble: 0.010, bend: 0.16, noteLen: 1.6, volume: 0.055 },
      maze:  { salt: 0x1111, roomChance: 0.15, braid: 0.12, corridor: 1 },
      particles: { count: 55, color: [205, 208, 200], size: 1.4, sway: 0.3, speed: 0.3 },   // grey dust
      lights: true,
      entities: { enabled: true, spawnDenom: 12, stalkerDenom: 4, chaseRange: 22, damage: 14,
                  stalkerVariants: ['smiler', 'hound'], wandererVariants: ['watcher'] },
      items: { density: 5, types: ['almond-water', 'glowstick', 'bandage', 'polaroid', 'radio'] },
      props: { density: 4, types: ['pallet', 'barrel', 'crate', 'couch', 'cart', 'box'] },
      exit:  { target: 2, denom: 4, label: 'descend',
               hint: 'find a hole in the floor or a stairwell down — the pipes are below.' },
      messages: [
        'the concrete sweats.',
        'a shopping cart, alone, a mile from anywhere.',
        'you are not the only thing awake here.',
        'the lights buzz, then stop, then buzz.',
        'something followed you in from the lobby.',
        'level 1. it is bigger than it looks.',
      ],
    },
  },

  // ── Level 2 — Pipe Dreams ────────────────────────────────────────────
  // A maze of maintenance tunnels. Hot, dark, steaming. It is worse here.
  {
    id: 2,
    name: 'level 2 — pipe dreams',
    sub: 'endless maintenance tunnels. steam, rust, and the dark between the pipes.',
    config: {
      palette: { wall: '#705C46', ceiling: '#4C4238', floor: '#2B2520', fog: '#5C503E' },
      fogDistance: 11,
      flicker: { rate: 0.16, depth: 0.85, recoverySpeed: 9 },
      // dizzy whole-tone drift — nothing resolves down here — sparse beat
      music: { root: 146.83, scale: [0, 2, 4, 6, 8, 10], progressions: [[0, 2, 4, 1], [4, 2, 0, 3], [0, 4, 2, 5]],
               tempo: 500, beatsPerChord: 8, beatsPerBar: 4, groove: 0.35, arpLen: 0.6, leadChance: 0.28,
               brightness: 820, wobble: 0.016, bend: 0.22, noteLen: 1.8, volume: 0.05 },
      maze:  { salt: 0x2222, roomChance: 0.10, braid: 0.08, corridor: 1 },
      particles: { count: 40, color: [190, 182, 170], size: 2.6, sway: 0.55, speed: 0.5, rise: true },   // rising steam
      lights: false,
      entities: { enabled: true, spawnDenom: 8, stalkerDenom: 3, chaseRange: 26, damage: 18,
                  stalkerVariants: ['lurker', 'hound'], wandererVariants: ['crawler'] },
      items: { density: 4, types: ['almond-water', 'glowstick', 'bandage', 'radio'] },
      props: { density: 5, types: ['pipe', 'valve', 'drum', 'toolbox', 'vent', 'crate'] },
      exit:  { target: 3, denom: 5, label: 'descend',
               hint: 'follow the pipes to a service hatch, then drop into the dark below.' },
      messages: [
        'the pipes tick as they cool. or fill.',
        'steam, from somewhere. it is warm and wrong.',
        'do not follow the sound of running water.',
        'the dark here has weight.',
        'level 2. bring your own light.',
      ],
    },
  },

  // ── Level 3 — Electrical Station ─────────────────────────────────────
  // A lightless labyrinth of transformers and live cable. Then, the way up.
  {
    id: 3,
    name: 'level 3 — electrical station',
    sub: 'transformers hum with current in the black. one door leads back up.',
    config: {
      palette: { wall: '#4C505A', ceiling: '#3A3E46', floor: '#22252B', fog: '#363B44' },
      fogDistance: 10,
      flicker: { rate: 0.22, depth: 0.92, recoverySpeed: 8 },
      // dissonant, half-step clusters — the current sings wrong — driving dark beat
      music: { root: 130.81, scale: [0, 1, 3, 6, 7, 10], progressions: [[0, 3, 1, 4], [0, 1, 4, 3], [4, 1, 3, 0]],
               tempo: 520, beatsPerChord: 8, beatsPerBar: 4, groove: 0.65, arpLen: 0.6, leadChance: 0.26,
               brightness: 700, wobble: 0.022, bend: 0.28, noteLen: 2.0, volume: 0.05 },
      maze:  { salt: 0x3333, roomChance: 0.08, braid: 0.06, corridor: 1 },
      particles: { count: 34, color: [170, 215, 255], size: 1.3, sway: 0.25, speed: 0.65, spark: true },   // electrical sparks
      lights: false,
      entities: { enabled: true, spawnDenom: 6, stalkerDenom: 2, chaseRange: 30, damage: 22,
                  stalkerVariants: ['tesla', 'smiler'], wandererVariants: ['watcher'] },
      items: { density: 4, types: ['almond-water', 'glowstick', 'bandage', 'bandage', 'radio'] },
      props: { density: 5, types: ['transformer', 'cabinet-e', 'spool', 'sign', 'drum'] },
      exit:  { target: 0, denom: 5, label: 'climb out',
               hint: 'a door humming with current — through it, the lobby waits again.' },
      messages: [
        'everything here is live. do not touch the walls.',
        'the current hums a note you can feel in your teeth.',
        'something with too many joints is in here with you.',
        'the way up is here. somewhere. find the humming door.',
        'level 3. the deepest you should go.',
      ],
    },
  },
]

// Merge a level's partial config over a base config. Object-valued keys
// (palette, flicker, maze, entities, items, props, exit) are shallow-merged
// so a level need only override the fields it cares about.
export function levelConfig(base, index) {
  const lvl = LEVELS[((index % LEVELS.length) + LEVELS.length) % LEVELS.length]
  const c = lvl.config
  const merge = (k) => ({ ...(base?.[k] ?? {}), ...(c?.[k] ?? {}) })
  return {
    ...base,
    ...c,
    palette:  merge('palette'),
    flicker:  merge('flicker'),
    maze:     merge('maze'),
    music:    merge('music'),
    entities: { ...(c.entities ?? {}) },   // level fully owns entity rules
    items:    merge('items'),
    props:    merge('props'),
    exit:     { ...(c.exit ?? {}) },
    // level messages replace the base atmospheric set
    messages: c.messages ?? base?.messages ?? [],
    levelIndex: lvl.id,
    levelName:  lvl.name,
    levelSub:   lvl.sub,
  }
}

export function levelCount() { return LEVELS.length }
