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
import { NULL_MAP, NULL_SPAWN, NULL_EXIT } from './level-null-map.js'

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
      scraps: { denom: 5 },   // the lobby — the most-trodden floor, the most notes
      machines: { denom: 16 },   // a little more civilization near the surface
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
      scraps: { denom: 9 },   // fewer make it this deep, and fewer stop to write
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
      scraps: { denom: 9 },
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

  // ── Level ∅ — The Block ──────────────────────────────────────────────
  // A hand-authored real place: an inner-block park in Harlem Park, West
  // Baltimore, grounded in the record (see level-null-map.js). Outdoors —
  // open sky instead of a ceiling — enclosed by rowhouse backs of formstone,
  // brick, plywood, black windows, and lit occupied houses. The shared front
  // door of the whole game: you enter here and fall one-way into the lobby.
  // Appended at index 4; the descent ring (0→1→2→3→0) never targets it, so it
  // stays a one-time entrance OUTSIDE the ring.
  {
    id: '∅',
    name: 'level ∅ — the block',
    sub: 'harlem park, west baltimore. a plan erased the street and left this.',
    config: {
      // ceiling is unused (sky replaces it); wall is the material-'0' fallback
      palette: { wall: '#B8A888', ceiling: '#B9B7AE', floor: '#5A5048', fog: '#9A968C' },
      fogDistance: 22,
      flicker: { rate: 0.02, depth: 0.20, recoverySpeed: 14 },   // daylight — barely flickers
      sky: '#B9B7AE',                                            // overcast Baltimore grey
      lights: false,                                            // outdoor — no drop-ceiling
      map: NULL_MAP, spawn: NULL_SPAWN, exitAt: NULL_EXIT,       // the authored fixed grid
      materials: {
        F: '#B8A888',   // formstone — fake stone over brick
        C: '#8F8F8F',   // CMU block, sealing a door
        P: '#7A6A52',   // plywood, house number sprayed on
        B: '#8A4A3A',   // brick
        W: '#141414',   // an open upper window: a black hole
        O: '#7A5A48',   // occupied — a light on
        M: '#D2D0C8',   // marble stoop
      },
      // dead-air ambient: wind, distant city, no muzak — beatless and bleak
      music: { root: 98, scale: [0, 2, 3, 7, 10], progressions: [[0, 3], [0, 2], [3, 0]],
               tempo: 1100, beatsPerChord: 16, beatsPerBar: 4, groove: 0, arpLen: 2.2,
               leadChance: 0.07, brightness: 600, wobble: 0.010, bend: 0.05, noteLen: 4.5, volume: 0.045 },
      maze:  { salt: 0x4444 },                                  // unused (fixed map) — kept distinct
      particles: { count: 30, color: [180, 176, 168], size: 1.6, sway: 0.4, speed: 0.2 },  // drifting ash/dust
      entities: { enabled: false },                             // the monster here is a municipal filing system
      items: { density: 40, types: ['polaroid'] },              // sparse — a camera, for evidence
      props: { density: 0.4, types: ['trash', 'tire', 'weeds', 'box'] },  // the dumping-ground yard
      scraps: { denom: 0 },   // no office-wanderer notes here — this is a real place
      machines: { denom: 0 },
      exit:  { target: 0, denom: 1, label: 'no-clip out',
               hint: 'the front doors are sealed with block. the only way out is the gap the paperwork left.' },
      messages: [
        'a form was left on the counter. someone started filling it out. they got bored.',
        'the front doors are filled with concrete block, behind the original frames.',
        'a photograph of a window, glued where a window was.',
        'graded hazardous in 1937. the same year they patented the stone to cover it.',
        'the notice on the door says EXTENSION. it has said EXTENSION for twenty-one years.',
        'some of the windows have lights on. nobody comes out.',
        'you are standing in woodyear street. woodyear street is not there.',
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
    scraps:   merge('scraps'),
    machines: merge('machines'),
    exit:     { ...(c.exit ?? {}) },
    // level messages replace the base atmospheric set
    messages: c.messages ?? base?.messages ?? [],
    levelIndex: lvl.id,
    levelName:  lvl.name,
    levelSub:   lvl.sub,
  }
}

export function levelCount() { return LEVELS.length }

// ── alternate tracks ────────────────────────────────────────────────────────
// Each level's own `music` block above is its native mood, and stays the
// default. These are hand-tuned alternates the player cycles with N.
//
// They are slow, beatless ambient in the Marconi Union vein, and the recipe is
// deliberate rather than decorative:
//   groove: 0        — switches the kick/hat off entirely (audio.js:262). No pulse.
//   tempo 900–1200   — 50–66 BPM, resting-heart-rate territory.
//   beatsPerChord 16 — 16–19 seconds on a single chord. Harmony you drift in,
//                      not harmony that goes somewhere.
//   leadChance ~0.1  — sparse and irregular, so no melody ever repeats and the
//                      ear can't anticipate the next note. That unpredictability
//                      is the whole trick behind Weightless; a hummable tune
//                      would defeat it.
//   long noteLen     — notes outlast their own chord and blur into the next.
// Pentatonic scales throughout: no leading tone, so nothing ever resolves.
export const TRACKS = [
  {
    name: 'weightless',
    hint: 'something almost restful.',
    mood: { root: 130.81, scale: [0, 3, 5, 7, 10],
            progressions: [[0, 2], [0, 3], [2, 0], [3, 0]],
            tempo: 1000, beatsPerChord: 16, beatsPerBar: 4, groove: 0,
            arpLen: 2.0, leadChance: 0.10, brightness: 700, wobble: 0.004,
            bend: 0.05, noteLen: 4.0, volume: 0.055 },
  },
  {
    name: 'deep field',
    hint: 'the room exhales.',
    mood: { root: 110, scale: [0, 2, 3, 7, 10],
            progressions: [[0, 3], [0, 2], [3, 2]],
            tempo: 1200, beatsPerChord: 16, beatsPerBar: 4, groove: 0,
            arpLen: 2.4, leadChance: 0.08, brightness: 520, wobble: 0.006,
            bend: 0.04, noteLen: 5.0, volume: 0.05 },
  },
  {
    name: 'tape loop',
    hint: 'a warmth that is not quite in tune.',
    mood: { root: 146.83, scale: [0, 2, 4, 7, 9],
            progressions: [[0, 3, 2], [0, 2], [2, 0, 3]],
            tempo: 900, beatsPerChord: 12, beatsPerBar: 4, groove: 0,
            arpLen: 1.6, leadChance: 0.14, brightness: 900, wobble: 0.014,
            bend: 0.09, noteLen: 3.5, volume: 0.055 },
  },
]
