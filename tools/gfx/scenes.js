// scenes.js — the harness scene definitions (data + builders).
//
// A scene is { id, group?, desc, build(env) }, where env = { mods, base, size } and
//   mods  = the data modules loaded from the --src tree (createRenderer, levelConfig, LEVELS,
//           createChunkCache, createFixedMap, createDecorSystem, createEntitySystem, createItemSystem,
//           NULL_MAP, CHUNK_SIZE, ...)
//   base  = the base world config (DEFAULT_CONFIG <- world.json), exactly what game.js starts from
//   size  = { w, h } the canvas size
// build() returns the frame spec the harness draws:
//   { cfg, hooks, cache, player, flicker, fogMul, lights, entities, renderOpts? }
// which is exactly what game.js hands createRenderer()/render(). One PNG is produced per scene id;
// several ids may share a `group` (so `--scenes sprites-lineup` selects the whole family).
//
// To add a scene: append to SCENES (or push from a loop, as the lineup pages do). Pick the pose by
// looking at `node tools/gfx/scout.mjs --src <dir> --level N` (an ASCII map), then verify the PNG.
// Angles are in DEGREES here (0 = +x / east, 90 = +y / south — the renderer's own convention).
//
// This file MUST stay import-safe outside the browser and must not import game modules: they come
// in through env.mods so the harness can point at any src/renderer tree.
//
// Each graphics track adds ITS OWN scenes in its own file (scenes-a1.js … scenes-e.js) by exporting
// register(kit); this file calls them at the bottom. Never edit another track's file, and prefix your scene
// ids with your track name (a1-…, a2-…, b-…, c-…, d-…, e-…). Keeping scene lists in separate files is what lets
// the tracks merge without conflicts.
import { register as regA1 } from './scenes-a1.js'
import { register as regA2 } from './scenes-a2.js'
import { register as regB } from './scenes-b.js'
import { register as regC } from './scenes-c.js'
import { register as regD } from './scenes-d.js'
import { register as regE } from './scenes-e.js'
import { register as regInt } from './scenes-int.js'

export const DEFAULT_SIZE = { w: 960, h: 540 }
// 0 is the canonical unseeded world: createChunkCache(cfg, 0) yields epoch 0 (the maze a fresh game
// shows) and decor/items hash with seed 0 — so these scenes are what a new player really sees.
export const WORLD_SEED = 0
export const RNG_SEED = 0xB4C700          // Math.random seed, re-applied before every scene is built
export const WARMUP_FRAMES = 8            // identical frames drawn before the captured (9th) frame
// what game.js passes as renderOpts (prefs defaults)
export const RENDER_OPTS = { grain: true, particles: true, crosshair: true }

const rad = (d) => (d * Math.PI) / 180

// ── entity plumbing (mirrors game.js, ~lines 1036-1059 of the pristine tree) ────────────────────
// game.js builds one flat array in THIS order and passes it to render(). If a later phase makes
// game.js forward more fields (prop rot/key, exit target, note frag, enemy state/dir/stagger,
// remote-player angle, apparition vx/vy), extend the mapping functions below and nothing else.
export const asProp     = (p) => ({ x: p.x, y: p.y, kind: 'prop', type: p.type, rot: p.rot, key: p.key })
export const asExit     = (e) => ({ x: e.x, y: e.y, kind: 'exit', target: e.target, key: e.key })
export const asNpc      = (n) => ({ x: n.x, y: n.y, kind: 'npc', name: 'a lost soul', key: n.key })
export const asItem     = (it) => ({ x: it.x, y: it.y, kind: 'item', itemType: it.type, key: it.key })
export const asNote     = (s, readSet) => ({ x: s.x, y: s.y, kind: 'note', read: readSet.has(s.frag), frag: s.frag, key: s.key })
export const asMachine  = (m, vendedSet) => ({ x: m.x, y: m.y, kind: 'machine', vended: vendedSet.has(m.key), key: m.key })
export const asSight    = (s) => ({ x: s.x, y: s.y, kind: 'sight', sightType: s.type, key: s.key })
export const asRemote   = (p) => ({ x: p.x, y: p.y, kind: 'player', name: p.name || 'wanderer', angle: p.angle, chatText: p.chatText, hp: p.hp })
export const asApparition = (a) => ({ x: a.x, y: a.y, variant: a.variant, vx: a.vx, vy: a.vy })

// An enemy exactly as entities.js makeEntity() creates it (the renderer receives these objects as-is).
export function makeEnemy(variant, x, y, type = 'stalker') {
  return { x, y, type, variant, state: 'idle', dir: 0, dirTimer: 4, stagger: 0, wardHits: 0, chunkCx: Math.floor(x / 22), chunkCy: Math.floor(y / 22) }
}

export function makePlayer(x, y, angleDeg) {
  return { x, y, angle: rad(angleDeg), bob: 0, bobOffset: 0, moving: false, hp: 100, maxHp: 100 }
}

// game.js buildLevel(): cfg -> fixed map or chunk cache (world seed fixed), preload, materialAt hook.
export function buildWorld(env, levelIndex, gridOverride = null) {
  const { mods, base } = env
  const cfg = mods.levelConfig(base, levelIndex)
  const cache = gridOverride ? mods.createFixedMap(gridOverride)
    : cfg.map ? mods.createFixedMap(cfg.map)
    : mods.createChunkCache(cfg, WORLD_SEED)
  cache.preload(0, 0)
  const hooks = cfg.map && !gridOverride ? { materialAt: (wx, wy) => cache.materialAt(wx, wy) } : {}
  return { cfg, cache, hooks }
}

// The real seeded decor / items / enemies around the player, assembled the way game.js does.
//   enemies: false | true (spawn via createEntitySystem) ; extra: hand-placed entities appended
export function populate(env, world, player, { enemies = true, readSet = new Set(), vended = new Set(), remote = [], apparitions = [], extra = [] } = {}) {
  const { mods, base } = env
  const { cfg, cache } = world
  const CS = mods.CHUNK_SIZE
  const pcx = Math.floor(player.x / CS), pcy = Math.floor(player.y / CS)
  const isWall = (wx, wy) => cache.isWall(wx, wy, pcx, pcy)
  const itemSys = mods.createItemSystem(base, isWall, WORLD_SEED)
  const decor = mods.createDecorSystem(cfg, isWall, WORLD_SEED)
  itemSys.enterLevel(cfg)
  decor.update(0, 0); itemSys.update(0, 0)
  cache.preload(pcx, pcy); itemSys.update(pcx, pcy); decor.update(pcx, pcy)
  const esys = mods.createEntitySystem(cfg, isWall)
  // dt = 0: enemies are placed by the (deterministic) spawn hash but do not walk between frames
  if (enemies && cfg.entities?.enabled) esys.update(0, player, pcx, pcy, 1)
  return [
    ...(enemies ? esys.getEntities() : []),
    ...remote.map(asRemote),
    ...decor.getNpcs().map(asNpc),
    ...decor.getProps().map(asProp),
    ...decor.getExits().map(asExit),
    ...itemSys.getWorldItems().map(asItem),
    ...decor.getScraps().map((s) => asNote(s, readSet)),
    ...decor.getMachines().map((m) => asMachine(m, vended)),
    ...decor.getSights().map(asSight),
    ...apparitions.map(asApparition),
    ...extra,
  ]
}

// A scene over a real level: pose + optional lights/flicker/fog, real decor, hand-placed extras.
function levelScene({ id, desc, level, x, y, angle, flicker = 1, fogMul = 1, lights = {}, enemies = true, extra = null, remote = [], apparitions = [] }) {
  return {
    id, desc,
    build(env) {
      const world = buildWorld(env, level)
      const player = makePlayer(x, y, angle)
      const entities = populate(env, world, player, {
        enemies, remote, apparitions,
        extra: typeof extra === 'function' ? extra(env, player) : (extra || []),
      })
      return { cfg: world.cfg, hooks: world.hooks, cache: world.cache, player, flicker, fogMul, lights, entities }
    },
  }
}

// ── the sprite test map (open floor, fixed grid) ────────────────────────────────────────────────
// Level-0 look (lit lobby ceiling), no procedural walls, so sprites are judged in isolation.
function openGrid(w, h) {
  const rows = []
  for (let y = 0; y < h; y++) rows.push(y === 0 || y === h - 1 ? 'X'.repeat(w) : 'X' + '.'.repeat(w - 2) + 'X')
  return rows
}

// ── the real levels ─────────────────────────────────────────────────────────────────────────────
// Poses were picked with tools/gfx/scout.mjs (ASCII map of the seed-0 world) and confirmed by eye.
export const SCENES = []

SCENES.push(
  levelScene({ id: 'l0-corridor', desc: 'level 0: standing at the start of a long straight, 1-wide hall; drop-ceiling panels and walls recede into yellow fog',
    level: 0, x: 11.5, y: 19.5, angle: 90 }),
  // (18.0, 26.0) is the inside of a big room whose two walls meet in a clean 90-degree corner dead ahead
  levelScene({ id: 'l0-room', desc: 'level 0: inside a large room, facing its far corner (two wallpaper walls meeting, lit ceiling above)',
    level: 0, x: 18.0, y: 26.0, angle: -45 }),
  levelScene({ id: 'l0-dip', desc: 'level 0: same view as l0-corridor with the flicker scalar dipped to 0.35 (a light-dip frame)',
    level: 0, x: 11.5, y: 19.5, angle: 90, flicker: 0.35 }),
  levelScene({ id: 'l0-flashlight', desc: 'level 0: same view as l0-corridor with the player flashlight on',
    level: 0, x: 11.5, y: 19.5, angle: 90, lights: { flashlight: true } }),
  levelScene({ id: 'l0-glow', desc: 'level 0: same view as l0-corridor with a green glowstick wash and fog pushed back 1.6x',
    level: 0, x: 11.5, y: 19.5, angle: 90, fogMul: 1.6, lights: { glow: [80, 235, 110] } }),
  levelScene({ id: 'l1-hall', desc: 'level 1 (habitable zone): a long grey hall, unlit concrete palette, no sprites',
    level: 1, x: 11.5, y: 19.5, angle: 90 }),
  // real seeded props here: a toolbox (dead ahead, ~4 away), a drum far right, the natural crawler far ahead;
  // plus one hand-placed lurker (the level's stalker) beside the toolbox so a creature is actually visible in the dark
  levelScene({ id: 'l2-pipes', desc: 'level 2 (pipe dreams): dark tunnel, a toolbox dead ahead, a drum far right, and a lurker just beyond the toolbox',
    level: 2, x: 33.5, y: -3.5, angle: 270, extra: () => [makeEnemy('lurker', 34.5, -8.5)] }),
  // the natural smiler stalks the hall 4.5 ahead; a hand-placed tesla stands in the open bay to the right
  levelScene({ id: 'l3-station', desc: 'level 3 (electrical station): dark blue hall, a smiler ahead in the corridor and a tesla in the bay to the right',
    level: 3, x: -4.5, y: -10.5, angle: 180, extra: () => [makeEnemy('tesla', -7.5, -11.9)] }),
  // facing the south row of rowhouse backs: plywood+number, black window, brick, formstone, lit window
  levelScene({ id: 'lnull-yard', desc: 'level null: facing the south rowhouse backs 4 cells away: plywood with number, black window, brick, formstone, a lit window, CMU',
    level: 4, x: 12.5, y: 13.0, angle: 90 }),
  // the yard from the SW corner: the jutting lit rows + marble stoops, the exit portal, the east wall receding
  levelScene({ id: 'lnull-wide', desc: 'level null: wide view across the yard: the lit-window row and marble stoops, the exit portal, the east wall in fog',
    level: 4, x: 4.5, y: 15.0, angle: -20 }),
)

// ── the sprite lineup ───────────────────────────────────────────────────────────────────────────
// A purpose-built open test map (fixed grid, level-0 look). The camera stands at (9.5, 10.5) looking
// east. Because the renderer's FOV is only ~75 degrees, ONE of each visible thing cannot fit in one
// frame, so the lineup is split into pages. Each page has five things in a zig-zag: near ones at ~3 world
// units, far ones at ~6, at bearings -30/-15/0/+15/+30 degrees. Odd pages swap which slots are near, and a
// few key pages are repeated flipped so every creature/person/exit is seen at BOTH distances.
const LINEUP_W = 22, LINEUP_H = 21
const LINEUP_CAM = { x: 9.5, y: 10.5, angle: 0 }
const SLOT_BEARINGS = [-30, -15, 0, 15, 30]
const SLOT_DIST = [[3, 6, 3, 6, 3], [6, 3, 6, 3, 6]]

const PROP_TYPES = [   // every entry of PROP_SPEC in renderer.js, then the three level-null yard props that fall back to the box art
  'chair', 'cabinet', 'box', 'crate', 'cone', 'papers', 'plant', 'pallet', 'barrel', 'drum', 'couch', 'cart', 'pipe',
  'valve', 'vent', 'toolbox', 'transformer', 'cabinet-e', 'spool', 'sign', 'trash', 'tire', 'weeds',
]
const ITEM_TYPES = ['almond-water', 'glowstick', 'bandage', 'polaroid', 'radio']
const SIGHT_TYPES = ['chairpile', 'tvwall', 'payphone', 'mannequin']
const STALKERS = new Set(['smiler', 'hound', 'lurker', 'tesla'])
const CREATURES = ['smiler', 'hound', 'watcher', 'lurker', 'crawler', 'tesla', 'shade', 'thin']

const T = {
  prop:    (type) => ({ label: type, make: (x, y) => asProp({ x, y, type }) }),
  item:    (t) => ({ label: `item:${t}`, make: (x, y) => asItem({ x, y, type: t }) }),
  exit:    () => ({ label: 'exit', make: (x, y) => asExit({ x, y }) }),
  note:    (read) => ({ label: read ? 'note:read' : 'note:unread', make: (x, y) => asNote({ x, y, frag: 0 }, read ? new Set([0]) : new Set()) }),
  machine: (vended) => ({ label: vended ? 'machine:vended' : 'machine:stocked', make: (x, y) => asMachine({ x, y, key: 'm' }, vended ? new Set(['m']) : new Set()) }),
  sight:   (t) => ({ label: `sight:${t}`, make: (x, y) => asSight({ x, y, type: t }) }),
  player:  () => ({ label: 'player(co-op)', make: (x, y) => asRemote({ x, y, name: 'wanderer', angle: 3.14, chatText: 'is anyone there?', hp: 72 }) }),
  npc:     () => ({ label: 'npc', make: (x, y) => asNpc({ x, y }) }),
  // 'thin' is what event apparitions use ({x, y, variant}, no kind); the other seven are real enemy objects
  creature: (v) => ({
    label: `creature:${v}`,
    make: (x, y) => (v === 'thin' ? asApparition({ x, y, variant: 'thin' }) : makeEnemy(v, x, y, STALKERS.has(v) ? 'stalker' : 'wanderer')),
  }),
}

function lineupPages() {
  const misc = [
    ...PROP_TYPES.map(T.prop), ...ITEM_TYPES.map(T.item), T.exit(), T.note(false), T.note(true),
    T.machine(false), T.machine(true), ...SIGHT_TYPES.map(T.sight), T.player(), T.npc(),
  ]
  const creatures = CREATURES.map(T.creature)
  const pages = []
  const chunk = (list, parity) => { for (let i = 0; i < list.length; i += 5) pages.push({ things: list.slice(i, i + 5), parity }) }
  // parity alternates page to page across the misc list so neighbours sit at opposite distances
  for (let i = 0, p = 0; i < misc.length; i += 5, p++) pages.push({ things: misc.slice(i, i + 5), parity: p % 2 })
  chunk(creatures, 0)
  chunk(creatures, 1)    // the same creatures again with near/far swapped
  // the exit, an unread note, the stocked machine and both people again with near/far swapped
  pages.push({ things: [T.exit(), T.note(false), T.machine(false), T.player(), T.npc()], parity: 1 })
  return pages
}

lineupPages().forEach((page, i) => {
  const dist = SLOT_DIST[page.parity]
  const tag = page.things.map((t, k) => `${t.label}@${dist[k]}`).join(' ')
  SCENES.push({
    id: `sprites-lineup-${String(i + 1).padStart(2, '0')}`,
    group: 'sprites-lineup',
    desc: `sprite test map, page ${i + 1}: ${tag}`,
    build(env) {
      const world = buildWorld(env, 0, openGrid(LINEUP_W, LINEUP_H))
      const player = makePlayer(LINEUP_CAM.x, LINEUP_CAM.y, LINEUP_CAM.angle)
      const entities = page.things.map((t, k) => {
        const a = rad(LINEUP_CAM.angle + SLOT_BEARINGS[k])
        return t.make(LINEUP_CAM.x + dist[k] * Math.cos(a), LINEUP_CAM.y + dist[k] * Math.sin(a))
      })
      return { cfg: world.cfg, hooks: world.hooks, cache: world.cache, player, flicker: 1, fogMul: 1, lights: {}, entities }
    },
  })
})

// ── sprites behind a wall corner ────────────────────────────────────────────────────────────────
// Two free-standing wall slabs (1 cell thick) on the plane x = 8, cells y=5..6 and y=10..11, with a 3-cell
// gap between them; the camera stands at (2.5, 8.5) looking east. The four corners that bound the slabs on
// screen are (8,5), (9,7), (9,10) and (8,12). Beside each corner two sprites sit BEHIND the wall (8.2 and
// 10.4 away along the ray from the camera through the corner): the nearer one has its CENTRE on the open
// side of the corner (`into` > 0, so part of its width is hidden behind the slab), the farther one has its
// centre behind the slab (`into` < 0, only a sliver can show). The current renderer depth-tests
// props/items/etc. at their centre column only, so centre-visible props bleed across the slab and
// centre-hidden props vanish; creatures are tested per column and clip correctly. That is exactly what
// this scene exists to show.
const OCC_W = 24, OCC_H = 20, OCC_SLAB_X = 8, OCC_SLABS = [5, 6, 10, 11], OCC_CAM = { x: 2.5, y: 8.5, angle: 0 }
function occlusionGrid() {
  const rows = []
  for (let y = 0; y < OCC_H; y++) {
    let r = ''
    for (let x = 0; x < OCC_W; x++) {
      const wall = x === 0 || y === 0 || x === OCC_W - 1 || y === OCC_H - 1 || (x === OCC_SLAB_X && OCC_SLABS.includes(y))
      r += wall ? 'X' : '.'
    }
    rows.push(r)
  }
  return rows
}
// A sprite at distance D along the ray from the camera through the wall corner (vx, vy), pushed sideways
// by `into` world units toward the OPEN side of the corner (negative = toward the wall).
// `slabSide` says which side of the corner the slab lies on, as seen from the camera.
function cornerSprite(vx, vy, D, slabSide, into, make) {
  const dx = vx - OCC_CAM.x, dy = vy - OCC_CAM.y, len = Math.hypot(dx, dy)
  const ux = dx / len, uy = dy / len
  const nx = -uy, ny = ux                              // unit vector to the RIGHT of the ray
  const lat = slabSide === 'left' ? into : -into      // slab on the left -> open side is to the right
  return make(OCC_CAM.x + ux * D + nx * lat, OCC_CAM.y + uy * D + ny * lat)
}
SCENES.push({
  id: 'sprites-occlusion',
  desc: 'two wall slabs with a gap, four wall corners; near sprite per corner with its centre on the open side (cabinet, smiler, hound, crate: props bleed across the slab, creatures clip) and a far one with its centre behind the wall (watcher, box, plant, lurker: props vanish, creatures show a sliver)',
  build(env) {
    const world = buildWorld(env, 0, occlusionGrid())
    const player = makePlayer(OCC_CAM.x, OCC_CAM.y, OCC_CAM.angle)
    const P = (type) => (x, y) => asProp({ x, y, type })
    const E = (variant) => (x, y) => makeEnemy(variant, x, y, STALKERS.has(variant) ? 'stalker' : 'wanderer')
    const N = 8.2, F = 10.4
    const entities = [
      // corner (8,5): slab to its right (south), open to the left
      cornerSprite(8, 5,  N, 'right', +0.1, P('cabinet')),   cornerSprite(8, 5,  F, 'right', -0.1, E('watcher')),
      // corner (9,7): the far edge of the slab, which is the silhouette edge seen from the camera; open to the right (the gap)
      cornerSprite(9, 7,  N, 'left',  +0.12, E('smiler')),    cornerSprite(9, 7,  F, 'left',  -0.3, P('box')),
      // corner (9,10): likewise the far edge of the second slab; open to the left (the gap)
      cornerSprite(9, 10, N, 'right', +0.15, E('hound')),     cornerSprite(9, 10, F, 'right', -0.3, P('plant')),
      // corner (8,12): slab to its left (north), open to the right
      cornerSprite(8, 12, N, 'left',  +0.1, P('crate')),     cornerSprite(8, 12, F, 'left',  -0.08, E('lurker')),
    ]
    return { cfg: world.cfg, hooks: world.hooks, cache: world.cache, player, flicker: 1, fogMul: 1, lights: {}, entities }
  },
})

// ── per-track scene files ───────────────────────────────────────────────────────────────────────
// kit = everything a track's register() needs to build scenes exactly the way game.js feeds the renderer.
// Push { id, group?, desc, size?, build(env) → spec } onto kit.SCENES. Use kit.levelScene({...}) for a pose over a
// real level (like the base scenes above) or kit.buildWorld/populate/makePlayer/makeEnemy for custom scenes.
const KIT = {
  SCENES, DEFAULT_SIZE, WORLD_SEED, RNG_SEED, WARMUP_FRAMES, RENDER_OPTS,
  asProp, asExit, asNpc, asItem, asNote, asMachine, asSight, asRemote, asApparition,
  makeEnemy, makePlayer, buildWorld, populate, levelScene, openGrid, rad,
}
for (const register of [regA1, regA2, regB, regC, regD, regE, regInt]) register(KIT)

// benchmark poses: [name in bench.json, scene id] — run at 1280x720
export const BENCH = [
  ['l0-corridor', 'l0-corridor'],
  ['l2-pipes', 'l2-pipes'],
  ['lnull-yard', 'lnull-yard'],
]
