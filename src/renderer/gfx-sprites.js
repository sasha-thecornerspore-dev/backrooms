// gfx-sprites.js — the sprite pass: pickups, props, exits, notes, machines, landmark sights, creatures and remote
// players. No DOM anywhere (import-safe in Node, unit-testable); the pass writes straight into the low-res world buffer.
//
// ARCHITECTURE (shared with the later WebGL path)
//   * Every sprite is authored as a PRE-RASTERISED FRAME generated once, lazily, by a seeded, deterministic software
//     rasteriser (typed arrays only — no Canvas2D, no Math.random). A frame is a list of LAYERS; a layer is a
//     premultiplied RGBA texture with a mip chain, a world-space rectangle (x0..x1 across, y0..y1 up from the floor, in
//     wall heights: 1.0 = floor to ceiling) and a blend mode (0 over, 1 screen). The atlas is keyed by
//     (kind, name, variant, state, anim frame, facing); see frameIndex()/frameKey() and getFrame().
//   * ONE PLAN, TWO BACKENDS. planSprites(fs, entities) decides everything about what is drawn (cull, cap, order, pose, warp,
//     colour, fog, light, rim, dissolve, nameplates) and returns a list of drawable records, one per layer (section 6). The CPU
//     pass drawSprites() blits those records (section 7); the GPU pass (gfx-gl-sprites-plan.js) turns the SAME records into
//     instances. Nothing about a sprite is decided twice, so the two paths cannot drift.
//   * drawSprites(buf32, zbuffer, fs, entities) blits layers into the world buffer BEFORE it is put on the canvas:
//     per-COLUMN depth test against the z-buffer for every kind (runs of visible columns, see visibleRuns), colour fogged
//     toward the fog colour exactly like a wall texel, lit by fs.light (ambient 1 when it is missing or disabled), dimmed
//     by fs.flicker, animated from fs.t only. Sprites stand ON the floor: projected with the PERPENDICULAR depth (the
//     same quantity the z-buffer holds), floor line at HH + unit/2.
//   * Creatures read enemy state / dir / stagger: chase, flee, stagger and idle are different frames plus a runtime warp
//     (lean, sway, hem ripple) so motion is continuous. Emissive tells (eyes, grin, arcs) live in their own screen-blended
//     layer so light never dims them. Rim light comes from fs.light.nearest() when the light model is live.
//
// CONTRACT WITH THE OTHER STAGES
//   drawSprites(buf32, zbuffer, fs, entities) -> nameplates[]     called AFTER the world pass, BEFORE buf32 is put on the canvas
//     buf32     the low-res world buffer (Uint32, ABGR, stride fs.W); sprites are blended into it
//     zbuffer   per-column PERPENDICULAR wall distance (what gfx-world.js writes)
//     fs        the frame state: W H HH fog fogRgb flicker t dt hf player light lights comfort levelKey opts
//               fs.light   {enabled, at(x,y), tint(x,y), nearest(x,y)}: ambient 1 unless enabled === true. nearest() may report
//                          its colour as 0..1 or 0..255. fs.opts.spriteLightOverride replaces fs.light (harness / tests only).
//               fs.comfort.reduceFlicker slows the crawling animations (TV static, arcs, sway).
//     entities  the flat list game.js builds. Fields read: x y kind; prop type rot; exit target; note read frag; machine vended;
//               sight sightType; item itemType; player/npc name angle chatText hp; enemy variant state dir stagger; apparition
//               variant vx vy. (`key` is passed through for the WebGL path; the CPU art varies from `rot` and position.)
//     returns   the remote-player nameplate records {sx, y, name, alpha, speech, hp} (a reused array; read it this frame).
//   planSprites(fs, entities) -> { recs, count, sprites, plates }     the same decisions without a buffer (the GPU pass builds on it; the
//               record layout is in section 6). The plan is module state: read it before the next planSprites / drawSprites call.
//   Frames are built lazily (a few ms each). A miss is built synchronously unless this call has already spent GEN_BUDGET_MS, in which
//   case that sprite waits a frame; the first sight of a thing also queues its other poses. prewarmSprites(levelConfig) builds the head of
//   the level's list up front (both backends call it at creation) and queues the rest, built one frame per call in the background (skipped
//   when the frame budget is tight); a level drawn without it queues a built-in list for its key on its first draw. Queueing a DIFFERENT level's
//   list first drops the previous level's unbuilt tail (warmForLevel), so each level starts with a fresh queue on both backends.
//
// Every exported pure helper is covered by test/gfx-sprites.test.js.

import { hash2, hash2Legacy, mulberry32, levelKey } from './gfx-util.js'

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 1. TABLES
// ════════════════════════════════════════════════════════════════════════════════════════════════

export const ITEM_COLORS = {
  'almond-water': [190, 215, 235],
  'glowstick':    [120, 235, 90],
  'bandage':      [235, 235, 240],
  'polaroid':     [235, 230, 220],
  'radio':        [200, 100, 55],
}

// World sizes are in WALL HEIGHTS (1.0 = floor to ceiling, the eye is at 0.5). The old table had a chair as tall as the ceiling;
// these are true scale plus about a third (a person 0.58, a chair 0.40, a filing cabinet 0.54): the rooms read as big without the
// furniture vanishing in the fog. h/w = the sprite's nominal box; c = the base colour the art is built from; lean = may lean a little
// (per-instance shear); decal = a flat floor decal.
export const PROP_SPEC = {
  chair:       { h: 0.40, w: 0.26, c: [56, 48, 40],   lean: 1 },
  cabinet:     { h: 0.54, w: 0.29, c: [86, 84, 68] },
  box:         { h: 0.27, w: 0.34, c: [122, 96, 58] },
  crate:       { h: 0.33, w: 0.40, c: [110, 88, 56] },
  cone:        { h: 0.31, w: 0.21, c: [200, 90, 30],  lean: 1 },
  papers:      { h: 0.02, w: 0.40, c: [220, 214, 196], decal: 1 },
  plant:       { h: 0.52, w: 0.34, c: [60, 74, 40] },
  pallet:      { h: 0.18, w: 0.50, c: [120, 96, 60] },
  barrel:      { h: 0.38, w: 0.24, c: [90, 70, 46] },
  drum:        { h: 0.36, w: 0.24, c: [70, 78, 60] },
  couch:       { h: 0.33, w: 0.72, c: [78, 68, 54] },
  cart:        { h: 0.35, w: 0.31, c: [150, 150, 156], lean: 1 },
  pipe:        { h: 1.00, w: 0.17, c: [96, 84, 64] },
  valve:       { h: 0.46, w: 0.31, c: [110, 92, 66] },
  vent:        { h: 0.38, w: 0.42, c: [90, 84, 70] },
  toolbox:     { h: 0.18, w: 0.34, c: [150, 60, 40] },
  transformer: { h: 0.84, w: 0.48, c: [76, 80, 90] },
  'cabinet-e': { h: 0.72, w: 0.35, c: [70, 74, 84] },
  spool:       { h: 0.42, w: 0.38, c: [96, 82, 62] },
  sign:        { h: 0.44, w: 0.29, c: [210, 170, 40], lean: 1 },
  // Level ∅: the dumping-ground yard — real debris, photographic and unheroic
  trash:       { h: 0.26, w: 0.42, c: [34, 34, 36],   decal: 0 },
  tire:        { h: 0.28, w: 0.30, c: [28, 28, 28],   lean: 1 },
  weeds:       { h: 0.32, w: 0.40, c: [92, 100, 58] },
}

// Creatures. h/w = world height / footprint width; `low` ones crouch on the floor; the flags name the canon tells.
// Heights are floor-anchored: a lurker is the tallest thing in the game and stoops under the ceiling (h = 1.0).
export const FIG = {
  shade:   { w: 0.36, h: 0.68, tint: [18, 15, 12], low: false },
  watcher: { w: 0.28, h: 0.76, tint: [16, 16, 18], low: false, eyes: true },
  smiler:  { w: 0.32, h: 0.72, tint: [14, 12, 12], low: false, grin: true },
  hound:   { w: 0.86, h: 0.42, tint: [20, 17, 15], low: true,  eyes: true },
  crawler: { w: 1.00, h: 0.28, tint: [16, 14, 12], low: true },
  lurker:  { w: 0.26, h: 1.00, tint: [10, 12, 14], low: false, eyes: true },
  tesla:   { w: 0.38, h: 0.80, tint: [16, 22, 32], low: false, electric: true, eyes: true },
  // a faint drop-in — someone who fell in from far away, minted thin: you can see the wall through them, and they do not
  // know they are translucent.
  thin:    { w: 0.26, h: 0.64, tint: [112, 128, 150], low: false, thin: true },
}

// people: a remote co-op player and a "lost soul" NPC must never be confused
export const PERSON = {
  player: { w: 0.24, h: 0.58 },
  npc:    { w: 0.26, h: 0.52 },
}

export const SIGHT_SPEC = {
  tvwall:    { h: 0.66, w: 0.70 },
  chairpile: { h: 0.86, w: 0.96 },
  payphone:  { h: 0.58, w: 0.22 },
  mannequin: { h: 0.60, w: 0.22 },
}

export const MACHINE_SPEC = { h: 0.62, w: 0.30 }
export const EXIT_SPEC = { h: 0.86, w: 0.46, beam: 2.7 }

// The near cull. Static bodies (props, sights, machines, lost souls) are solid (collide.js), so the camera is never inside one: the
// closest a head-on meeting gets is footprint r + PLAYER_R >= 0.255, and they may draw down to 0.15. What moves (creatures, remote
// players, apparitions) is not pinned that way and keeps the old 0.35, which bounds the fill cost of a thing standing on you.
export const NEAR_STATIC = 0.15

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 2. FRAME SELECTION (pure)
// ════════════════════════════════════════════════════════════════════════════════════════════════

export const STATES = ['idle', 'chase', 'flee', 'stagger']
const STATE_IX = { idle: 0, chase: 1, flee: 2, stagger: 3 }
export const FACING_FRONT = 0, FACING_BACK = 1, FACING_SIDE = 2
export const FACINGS = ['f', 'b', 's']
export const ANIM_FRAMES = [1, 2, 2, 2]   // gait frames per state
export const ANIM_HZ = [0, 2.2, 3.0, 2.6] // gait cycles per second per state
const TAU = Math.PI * 2

export function stateIndex(state) { const i = STATE_IX[state]; return i === undefined ? 0 : i }

// The pose an enemy is in: a warded one reels (stagger) whatever else it was doing.
export function creatureState(ent) {
  if (ent.stagger > 0 || ent.state === 'stagger') return 'stagger'
  if (ent.state === 'chase') return 'chase'
  if (ent.state === 'flee') return 'flee'
  return 'idle'
}

// Event apparitions carry only a velocity: a fast crosser (2.6 u/s) runs (the flee gait), a slow drop-in (1.1 u/s) drifts.
export function apparitionState(ent) {
  const vx = ent.vx || 0, vy = ent.vy || 0
  return vx * vx + vy * vy > 3.2 ? 'flee' : 'idle'
}

// Gait frame for a state at time t (seconds); `phase` (0..1, per entity) de-syncs neighbours.
export function animFrame(stateIx, t, phase) {
  const n = ANIM_FRAMES[stateIx] | 0
  if (n <= 1) return 0
  return (((t * ANIM_HZ[stateIx] + phase) * n) | 0) % n
}

// Stable per-entity phase in [0,1): enemies have a chunk address from their spawn hash; hand-placed ones fall back to 0.
export function entityPhase(ent) {
  return hash2(ent.chunkCx | 0, ent.chunkCy | 0, 91) / 4294967296
}

export function wrapAngle(a) {
  a = (a + Math.PI) % TAU
  if (a < 0) a += TAU
  return a - Math.PI
}

// The angle between an entity's heading and the direction from it to the camera: 0 = walking straight at the viewer.
export function headingRel(ent, camX, camY) {
  return wrapAngle((ent.dir || 0) - Math.atan2(camY - ent.y, camX - ent.x))
}

// Which facing bucket to show. Hunting, reeling and idle things face you (their tells — eyes, grin — stay visible); a
// wanderer running away shows its back; a low creature seen side-on shows its profile (mirrored by the caller when it
// heads to the right of the view).
export function creatureFacing(ent, camX, camY, low) {
  const s = creatureState(ent)
  if (s === 'chase' || s === 'stagger') return FACING_FRONT
  const rel = Math.abs(headingRel(ent, camX, camY))
  if (s === 'flee' && rel > (2 * Math.PI) / 3) return FACING_BACK     // a fleeing thing shows its back
  if (low && rel > Math.PI / 3 && rel <= (2 * Math.PI) / 3) return FACING_SIDE
  return FACING_FRONT      // idle things turn to face you: their tells stay visible
}

// True when the creature heads toward the RIGHT of the view (the art's profile faces left, so it is mirrored).
export function headsRight(ent, camAngle) {
  const dir = ent.dir || 0
  return -Math.cos(dir) * Math.sin(camAngle) + Math.sin(dir) * Math.cos(camAngle) > 0
}

// Atlas keys. frameIndex is the allocation-free numeric slot used at draw time; frameKey is the same address as a string.
export function frameIndex(v, stateIx, anim, facing) { return ((v * 4 + stateIx) * 2 + anim) * 3 + facing }
export function frameKey(kind, name, v, state, anim, facing) {
  return `${kind}/${name}/${v}/${state}/${anim}/${FACINGS[facing]}`
}

// Per-instance variation from the prop's seeded rotation (identical for every client): a stable hash, a variant
// index, a flip bit and a jitter in [-1, 1].
export function variantHash(rot) { return hash2(Math.round((rot || 0) * 65536), 0x51ed, 3) }
export function propVariant(rot, n) { return variantHash(rot) % n }
export function unitJitter(rot, salt) { return (hash2(Math.round((rot || 0) * 65536), salt, 7) / 4294967296) * 2 - 1 }

// Column visibility. Writes [start, end) pairs of the columns in [xa, xb) whose wall is FARTHER than `depth` and returns
// how many runs there are. `runs` must hold 2 * ceil((xb - xa) / 2 + 1) ints. This is the per-column depth test.
export function visibleRuns(zbuf, xa, xb, depth, runs) {
  let n = 0, start = -1
  for (let x = xa; x < xb; x++) {
    if (zbuf[x] > depth) { if (start < 0) start = x }
    else if (start >= 0) { runs[n++] = start; runs[n++] = x; start = -1 }
  }
  if (start >= 0) { runs[n++] = start; runs[n++] = xb }
  return n >> 1
}

// The mip whose height is closest to (but not below) the on-screen height: texels stay 1..~1.2 px.
export function pickMip(mips, screenH) {
  let m = 0
  while (m + 1 < mips.length && mips[m + 1].h >= screenH * 0.85) m++
  return m
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 3. THE SOFTWARE RASTERISER (art kit)
// ════════════════════════════════════════════════════════════════════════════════════════════════
// A paint is premultiplied RGBA in floats (rgb 0..255 already multiplied by alpha 0..1). Shapes are signed-distance
// functions with a 1px soft edge; shaders write their colour into the SR/SG/SB/SA scratch globals.

let SR = 0, SG = 0, SB = 0, SA = 1

// Math.hypot is an order of magnitude slower than this in V8; the rasteriser calls it per pixel
function hyp(a, b) { return Math.sqrt(a * a + b * b) }

export function createPaint(w, h) { return { w, h, px: new Float32Array(w * h * 4), rim: null } }

function over(px, i, r, g, b, a) {
  const inv = 1 - a
  px[i] = r * a + px[i] * inv
  px[i + 1] = g * a + px[i + 1] * inv
  px[i + 2] = b * a + px[i + 2] * inv
  px[i + 3] = a + px[i + 3] * inv
}

function paintShape(P, bx0, by0, bx1, by1, dist, shade) {
  const w = P.w, px = P.px
  const x0 = Math.max(0, Math.floor(bx0)), y0 = Math.max(0, Math.floor(by0))
  const x1 = Math.min(w, Math.ceil(bx1)), y1 = Math.min(P.h, Math.ceil(by1))
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const d = dist(x + 0.5, y + 0.5)
      if (d >= 0.5) continue
      SA = 1
      shade(x + 0.5, y + 0.5, d)
      const a = SA * (d <= -0.5 ? 1 : 0.5 - d)
      if (a > 0) over(px, (y * w + x) * 4, SR, SG, SB, a)
    }
  }
}

// signed distances (negative inside)
const sdBox = (cx, cy, hw, hh, r = 0) => (x, y) => {
  const qx = Math.abs(x - cx) - hw + r, qy = Math.abs(y - cy) - hh + r
  return hyp(qx > 0 ? qx : 0, qy > 0 ? qy : 0) + Math.min(Math.max(qx, qy), 0) - r
}
const sdEll = (cx, cy, rx, ry) => (x, y) => (hyp((x - cx) / rx, (y - cy) / ry) - 1) * Math.min(rx, ry)
const sdSeg = (ax, ay, bx, by, ra, rb) => {
  const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy || 1
  return (x, y) => {
    let t = ((x - ax) * dx + (y - ay) * dy) / l2
    t = t < 0 ? 0 : t > 1 ? 1 : t
    return hyp(x - (ax + dx * t), y - (ay + dy * t)) - (ra + (rb - ra) * t)
  }
}
const sdPoly = (pts) => {
  const n = pts.length >> 1
  return (x, y) => {
    let d = 1e9, s = 1
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const ax = pts[i * 2], ay = pts[i * 2 + 1], bx = pts[j * 2], by = pts[j * 2 + 1]
      const ex = bx - ax, ey = by - ay, wx = x - ax, wy = y - ay
      const l2 = ex * ex + ey * ey || 1
      let t = (wx * ex + wy * ey) / l2; t = t < 0 ? 0 : t > 1 ? 1 : t
      const qx = wx - ex * t, qy = wy - ey * t
      const dd = qx * qx + qy * qy
      if (dd < d) d = dd
      const c1 = y >= ay, c2 = y < by, c3 = ex * wy > ey * wx
      if ((c1 && c2 && c3) || (!c1 && !c2 && !c3)) s = -s
    }
    return s * Math.sqrt(d)
  }
}

// convenience fills (bounding boxes include the 1px edge)
export function fillBox(P, x0, y0, x1, y1, shade, r = 0) { paintShape(P, x0 - 1, y0 - 1, x1 + 1, y1 + 1, sdBox((x0 + x1) / 2, (y0 + y1) / 2, (x1 - x0) / 2, (y1 - y0) / 2, r), shade) }
export function fillEll(P, cx, cy, rx, ry, shade) { paintShape(P, cx - rx - 1, cy - ry - 1, cx + rx + 1, cy + ry + 1, sdEll(cx, cy, rx, ry), shade) }
export function fillSeg(P, ax, ay, bx, by, ra, rb, shade) {
  const m = Math.max(ra, rb) + 1
  paintShape(P, Math.min(ax, bx) - m, Math.min(ay, by) - m, Math.max(ax, bx) + m, Math.max(ay, by) + m, sdSeg(ax, ay, bx, by, ra, rb), shade)
}
export function fillPoly(P, pts, shade) {
  let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9
  for (let i = 0; i < pts.length; i += 2) { x0 = Math.min(x0, pts[i]); x1 = Math.max(x1, pts[i]); y0 = Math.min(y0, pts[i + 1]); y1 = Math.max(y1, pts[i + 1]) }
  paintShape(P, x0 - 1, y0 - 1, x1 + 1, y1 + 1, sdPoly(pts), shade)
}

// shaders
export const flat = (r, g, b, a = 1) => () => { SR = r; SG = g; SB = b; SA = a }

// a tileable value-noise field for grain, stains and folds
const NT = 64
let NOISE = null
function noiseTable() {
  if (NOISE) return NOISE
  const rnd = mulberry32(0x5eed1e), t = new Float32Array(NT * NT)
  for (let i = 0; i < t.length; i++) t[i] = rnd()
  return (NOISE = t)
}
export function nz(x, y) {
  const t = NOISE || noiseTable()
  const xi = Math.floor(x), yi = Math.floor(y)
  let fx = x - xi, fy = y - yi
  fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy)
  const x0 = xi & (NT - 1), x1 = (xi + 1) & (NT - 1), y0 = (yi & (NT - 1)) * NT, y1 = ((yi + 1) & (NT - 1)) * NT
  return (t[y0 + x0] * (1 - fx) + t[y0 + x1] * fx) * (1 - fy) + (t[y1 + x0] * (1 - fx) + t[y1 + x1] * fx) * fy
}
export function fbm(x, y) { return nz(x, y) * 0.62 + nz(x * 2.13 + 17.3, y * 2.13 + 5.1) * 0.38 }

// A material shader for box-ish surfaces: base colour, a light from the upper left (kx/ky), a cylinder profile across x
// (cyl > 0), grain, and vertical streaks. (x0..x1, y0..y1) is the surface's extent so the gradients are relative.
export function mat(o) {
  const [br, bg, bb] = o.c
  const x0 = o.x0, w = (o.x1 - o.x0) || 1, y0 = o.y0, h = (o.y1 - o.y0) || 1
  const kx = o.kx ?? -0.22, ky = o.ky ?? -0.12, cyl = o.cyl || 0, gr = o.grain ?? 0.07, st = o.streak || 0
  const sx = o.seed || 0
  const T = noiseTable(), ox = (sx * 5) | 0, oy = (sx * 3) | 0
  return (x, y) => {
    const u = (x - x0) / w, v = (y - y0) / h
    let m = 1.06 + kx * u + ky * v
    if (cyl) { const c = (u - 0.34) * 2; m += cyl * (0.55 - c * c * 0.5) }
    m *= 1 - gr * 0.5 + gr * T[(((y | 0) + oy) & 63) * 64 + (((x | 0) + ox) & 63)]
    if (st) m *= 1 - st * nz(x * 0.7 + sx * 3, y * 0.09 + sx)
    SR = br * m; SG = bg * m; SB = bb * m
  }
}

// Signed-distance fields for organic silhouettes (creatures): union with optional smoothing, then shaded as a soft volume.
export function createField(w, h) { return { w, h, f: new Float32Array(w * h).fill(1e3) } }
function fieldAdd(F, bx0, by0, bx1, by1, dist, k) {
  const { w, f } = F
  const x0 = Math.max(0, Math.floor(bx0 - k)), y0 = Math.max(0, Math.floor(by0 - k))
  const x1 = Math.min(w, Math.ceil(bx1 + k)), y1 = Math.min(F.h, Math.ceil(by1 + k))
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const d = dist(x + 0.5, y + 0.5), i = y * w + x, a = f[i]
      if (k > 0) {
        const hh = Math.max(k - Math.abs(a - d), 0) / k
        f[i] = Math.min(a, d) - hh * hh * k * 0.25
      } else if (d < a) f[i] = d
    }
  }
}
export function fieldEll(F, cx, cy, rx, ry, k = 0) { fieldAdd(F, cx - rx, cy - ry, cx + rx, cy + ry, sdEll(cx, cy, rx, ry), k) }
export function fieldSeg(F, ax, ay, bx, by, ra, rb = ra, k = 0) {
  const m = Math.max(ra, rb)
  fieldAdd(F, Math.min(ax, bx) - m, Math.min(ay, by) - m, Math.max(ax, bx) + m, Math.max(ay, by) + m, sdSeg(ax, ay, bx, by, ra, rb), k)
}
export function fieldPoly(F, pts, k = 0) {
  let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9
  for (let i = 0; i < pts.length; i += 2) { x0 = Math.min(x0, pts[i]); x1 = Math.max(x1, pts[i]); y0 = Math.min(y0, pts[i + 1]); y1 = Math.max(y1, pts[i + 1]) }
  fieldAdd(F, x0, y0, x1, y1, sdPoly(pts), k)
}
export function fieldBox(F, x0, y0, x1, y1, r = 0, k = 0) { fieldAdd(F, x0, y0, x1, y1, sdBox((x0 + x1) / 2, (y0 + y1) / 2, (x1 - x0) / 2, (y1 - y0) / 2, r), k) }

// Shade a field as a soft clay-like volume lit from the upper left; writes premultiplied colour into P and, when
// st.rim is set, the signed edge normal (for the dynamic rim light) into P.rim.
//   st.c        albedo [r,g,b]          st.R      bulge radius in px (bigger = puffier)
//   st.amb/dif  ambient / diffuse       st.sky    extra top light      st.cold  cold bounce tint from below
//   st.tex(x,y) optional albedo multiplier (folds, hood void...)      st.alpha optional per-pixel alpha (thin, fades)
export function paintField(P, F, st) {
  const { w, h } = P, f = F.f, px = P.px
  const R = st.R || 5, amb = st.amb ?? 0.55, dif = st.dif ?? 0.85, sky = st.sky ?? 0.12
  const [ar, ag, ab] = st.c
  const cool = st.cold || 0
  const rim = st.rim ? (P.rim || (P.rim = new Float32Array(w * h))) : null
  const soft = st.soft || 0.75
  const Lx = -0.52, Ly = -0.6, Lz = 0.61
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x, d = f[i]
      if (d >= soft) continue
      const gx = (f[i + 1] - f[i - 1]) * 0.5, gy = (f[i + w] - f[i - w]) * 0.5
      const gl = hyp(gx, gy) || 1
      const nx0 = gx / gl, ny0 = gy / gl
      const t = Math.min(1, Math.max(0, -d / R))
      const z = Math.sqrt(Math.max(0.0025, 1 - (1 - t) * (1 - t)))
      const s = (1 - t) / z
      const inv = 1 / Math.sqrt(s * s + 1)
      const nx = nx0 * s * inv, ny = ny0 * s * inv, nzv = inv
      let lam = nx * Lx + ny * Ly + nzv * Lz
      if (lam < 0) lam = 0
      const up = ny < 0 ? -ny : 0
      let lum = amb + dif * lam + sky * up
      let cr = ar, cg = ag, cb = ab
      if (st.tex) { const m = st.tex(x + 0.5, y + 0.5, d); cr *= m; cg *= m; cb *= m }
      const dn = ny > 0 ? ny * cool : 0
      const a = d <= -soft ? 1 : (soft - d) / (2 * soft)
      let al = a
      if (st.alpha) al *= st.alpha(x + 0.5, y + 0.5)
      if (al <= 0) continue
      const pr = (cr * lum + dn * 20) * al, pg = (cg * lum + dn * 26) * al, pb = (cb * lum + dn * 44) * al
      const j = i * 4
      const ia = 1 - al
      px[j] = pr + px[j] * ia; px[j + 1] = pg + px[j + 1] * ia; px[j + 2] = pb + px[j + 2] * ia; px[j + 3] = al + px[j + 3] * ia
      if (rim) {
        const e = t < 0.6 ? (1 - t / 0.6) : 0
        rim[i] = nx0 * e * Math.sqrt(e) * al
      }
    }
  }
}

// Multiply the colour of everything already painted by shade(x, y) -> factor, optionally lifting toward a dust colour.
export function tonePaint(P, fn) {
  const { w, h, px } = P
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const j = (y * w + x) * 4, a = px[j + 3]
      if (a <= 0.004) continue
      const m = fn(x + 0.5, y + 0.5)
      px[j] *= m; px[j + 1] *= m; px[j + 2] *= m
    }
  }
}

// Straight-alpha colour added on top of what is painted (only where there is paint), e.g. dust, rust, sheen.
export function stainPaint(P, fn) {
  const { w, h, px } = P
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const j = (y * w + x) * 4, a = px[j + 3]
      if (a <= 0.004) continue
      SA = 0
      fn(x + 0.5, y + 0.5)
      if (SA <= 0) continue
      const k = SA
      px[j] = px[j] * (1 - k) + SR * k * a
      px[j + 1] = px[j + 1] * (1 - k) + SG * k * a
      px[j + 2] = px[j + 2] * (1 - k) + SB * k * a
    }
  }
}

// Draw a glow-type paint: additive colour blobs (for screen-blended layers), no alpha model.
export function glowEll(P, cx, cy, rx, ry, r, g, b, a, pow = 1.6) {
  const w = P.w, px = P.px
  const x0 = Math.max(0, Math.floor(cx - rx)), x1 = Math.min(w, Math.ceil(cx + rx))
  const y0 = Math.max(0, Math.floor(cy - ry)), y1 = Math.min(P.h, Math.ceil(cy + ry))
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const d = hyp((x + 0.5 - cx) / rx, (y + 0.5 - cy) / ry)
      if (d >= 1) continue
      const k = Math.pow(1 - d, pow) * a
      const j = (y * w + x) * 4
      px[j] = Math.min(255, px[j] + r * k); px[j + 1] = Math.min(255, px[j + 1] + g * k)
      px[j + 2] = Math.min(255, px[j + 2] + b * k); px[j + 3] = Math.min(1, Math.max(px[j + 3], k))
    }
  }
}
export function glowSeg(P, ax, ay, bx, by, wid, r, g, b, a) {
  const w = P.w, px = P.px
  const m = wid + 1
  const dist = sdSeg(ax, ay, bx, by, wid, wid)
  const x0 = Math.max(0, Math.floor(Math.min(ax, bx) - m)), x1 = Math.min(w, Math.ceil(Math.max(ax, bx) + m))
  const y0 = Math.max(0, Math.floor(Math.min(ay, by) - m)), y1 = Math.min(P.h, Math.ceil(Math.max(ay, by) + m))
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const d = dist(x + 0.5, y + 0.5)
      if (d >= 0.5) continue
      const k = a * (d <= -0.5 ? 1 : 0.5 - d)
      const j = (y * w + x) * 4
      px[j] = Math.min(255, px[j] + r * k); px[j + 1] = Math.min(255, px[j + 1] + g * k)
      px[j + 2] = Math.min(255, px[j + 2] + b * k); px[j + 3] = Math.min(1, Math.max(px[j + 3], k))
    }
  }
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 4. LAYERS AND THE ATLAS
// ════════════════════════════════════════════════════════════════════════════════════════════════
// packLayer turns a paint into a Layer: premultiplied ABGR Uint32 mips (little-endian, the same packing as buf32), an
// optional rim plane (Uint8, 128 = none, >128 = edge facing right, <128 = facing left), each texel row's opaque span (rs, see
// rowSpans), and the placement rect. A mip is { w, h, px, rim, rs }.
//   opts: mode 0 over | 1 screen; emit 0..1 (1 = not dimmed by scene light or flicker); fogK 0..1 (how much fog acts on
//         it: 1 = like a wall, less = a beacon that carries through fog); floor (a flat decal); rimK (takes rim light)

// Per texel row, the columns [c0, c1) that hold any texel with alpha > 0 (c0 = c1 = 0: an empty row), as an Int32Array of 2 * h. The
// blitter never reads outside a row's span: every texel there is transparent.
export function rowSpans(px, w, h) {
  const rs = new Int32Array(h * 2)
  for (let y = 0; y < h; y++) {
    const o = y * w
    let a = 0, b = w
    while (a < w && (px[o + a] >>> 24) === 0) a++
    if (a === w) continue
    while ((px[o + b - 1] >>> 24) === 0) b--
    rs[y * 2] = a; rs[y * 2 + 1] = b
  }
  return rs
}

function packMip(P) {
  const { w, h, px } = P
  const out = new Uint32Array(w * h)
  for (let i = 0, n = w * h; i < n; i++) {
    const j = i * 4
    const a = Math.min(255, Math.max(0, Math.round(px[j + 3] * 255)))
    if (a === 0) continue
    const r = Math.min(a, px[j] + 0.5) | 0, g = Math.min(a, px[j + 1] + 0.5) | 0, b = Math.min(a, px[j + 2] + 0.5) | 0   // premultiplied: never brighter than alpha
    out[i] = ((a << 24) | (b << 16) | (g << 8) | r) >>> 0
  }
  return out
}

function halve(m) {
  const w = m.w >> 1, h = m.h >> 1
  const px = new Uint32Array(w * h), rim = m.rim ? new Uint8Array(w * h) : null
  const s = m.px
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const a = s[(y * 2) * m.w + x * 2], b = s[(y * 2) * m.w + x * 2 + 1], c = s[(y * 2 + 1) * m.w + x * 2], d = s[(y * 2 + 1) * m.w + x * 2 + 1]
      const r = ((a & 255) + (b & 255) + (c & 255) + (d & 255)) >> 2
      const g = (((a >> 8) & 255) + ((b >> 8) & 255) + ((c >> 8) & 255) + ((d >> 8) & 255)) >> 2
      const bl = (((a >> 16) & 255) + ((b >> 16) & 255) + ((c >> 16) & 255) + ((d >> 16) & 255)) >> 2
      const al = ((a >>> 24) + (b >>> 24) + (c >>> 24) + (d >>> 24)) >> 2
      px[y * w + x] = ((al << 24) | (bl << 16) | (g << 8) | r) >>> 0
      if (rim) {
        const i0 = (y * 2) * m.w + x * 2
        rim[y * w + x] = (m.rim[i0] + m.rim[i0 + 1] + m.rim[i0 + m.w] + m.rim[i0 + m.w + 1] + 2) >> 2
      }
    }
  }
  return { w, h, px, rim, rs: rowSpans(px, w, h) }
}

// Crop a paint to the box that holds any paint (plus a pixel of margin) and shrink the world rect to match, so the blitter never
// scans the empty canvas around a small feature (an eye glow on a whole-figure canvas, a note's halo corner).
function cropToContent(P, x0, x1, y0, y1) {
  const { w, h, px } = P
  let bx0 = w, bx1 = -1, by0 = h, by1 = -1
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (px[(y * w + x) * 4 + 3] > 0.002) { if (x < bx0) bx0 = x; if (x > bx1) bx1 = x; if (y < by0) by0 = y; if (y > by1) by1 = y }
    }
  }
  if (bx1 < 0) return { P: { w: 1, h: 1, px: new Float32Array(4), rim: null }, x0, x1: x0 + (x1 - x0) / w, y0: y1 - (y1 - y0) / h, y1 }
  bx0 = Math.max(0, bx0 - 1); by0 = Math.max(0, by0 - 1); bx1 = Math.min(w, bx1 + 2); by1 = Math.min(h, by1 + 2)
  if (bx0 === 0 && by0 === 0 && bx1 === w && by1 === h) return { P, x0, x1, y0, y1 }
  const nw = bx1 - bx0, nh = by1 - by0
  const np = new Float32Array(nw * nh * 4), nr = P.rim ? new Float32Array(nw * nh) : null
  for (let y = 0; y < nh; y++) {
    np.set(px.subarray(((y + by0) * w + bx0) * 4, ((y + by0) * w + bx1) * 4), y * nw * 4)
    if (nr) nr.set(P.rim.subarray((y + by0) * w + bx0, (y + by0) * w + bx1), y * nw)
  }
  const tw = (x1 - x0) / w, th = (y1 - y0) / h
  return { P: { w: nw, h: nh, px: np, rim: nr }, x0: x0 + bx0 * tw, x1: x0 + bx1 * tw, y0: y1 - by1 * th, y1: y1 - by0 * th }
}

export function packLayer(P0, x0_, x1_, y0_, y1_, o = {}) {
  const { P, x0, x1, y0, y1 } = cropToContent(P0, x0_, x1_, y0_, y1_)
  const px = packMip(P)
  let rim = null
  if (P.rim) {
    rim = new Uint8Array(P.w * P.h)
    for (let i = 0; i < rim.length; i++) rim[i] = Math.max(0, Math.min(255, Math.round(128 + P.rim[i] * 127)))
  } else if (o.rim) {
    rim = new Uint8Array(P.w * P.h).fill(128)
  }
  const mips = [{ w: P.w, h: P.h, px, rim, rs: rowSpans(px, P.w, P.h) }]
  let m = mips[0]
  while (m.w >= 8 && m.h >= 8) { m = halve(m); mips.push(m) }
  return { x0, x1, y0, y1, mips, mode: o.mode | 0, emit: o.emit || 0, fogK: o.fogK ?? 1, floor: !!o.floor, rimK: o.rimK || 0, alpha: o.alpha ?? 1 }
}

export function makeFrame(layers) { return { layers } }

// The atlas: kind -> name -> array of frames, addressed by frameIndex(). Frames are generated on first use (a few ms each),
// never per draw, and shared by every renderer (the art is level-independent; the level's look reaches the sprite through
// fog, light and a palette tint applied when it is blitted).
const ATLAS = Object.create(null)
const GENERATORS = Object.create(null)   // kind -> (name, v, stateIx, anim, facing) -> Frame
let FRAMES_BUILT = 0, TEX_BYTES = 0
let FALLBACK = null

export function registerGenerator(kind, fn) { GENERATORS[kind] = fn }

function fallbackFrame() {
  if (FALLBACK) return FALLBACK
  const P = createPaint(16, 24)
  fillBox(P, 2, 2, 14, 22, mat({ c: [120, 110, 100], x0: 2, x1: 14, y0: 2, y1: 22 }), 2)
  return (FALLBACK = makeFrame([packLayer(P, -0.1, 0.1, 0, 0.3, { rimK: 0 })]))
}

export function getFrame(kind, name, v = 0, stateIx = 0, anim = 0, facing = 0) {
  const byKind = ATLAS[kind] || (ATLAS[kind] = Object.create(null))
  const list = byKind[name] || (byKind[name] = [])
  const idx = frameIndex(v, stateIx, anim, facing)
  let fr = list[idx]
  if (fr === undefined) {
    try {
      const gen = GENERATORS[kind]
      fr = gen ? gen(name, v, stateIx, anim, facing) : null
    } catch (e) {
      fr = null
    }
    if (!fr) fr = fallbackFrame()
    else {
      FRAMES_BUILT++
      for (const l of fr.layers) for (const m of l.mips) TEX_BYTES += m.px.byteLength + (m.rim ? m.rim.byteLength : 0)
    }
    list[idx] = fr
    if (!list.warm) { list.warm = true; queueSiblings(kind, name) }   // first sight of this thing: build its other poses over the next frames
  }
  return fr
}

// The other frames a sprite will need soon (its other states / variants / banks), queued the first time it is seen and built
// one per drawSprites call, so a creature's chase pose or a prop's other variants are ready before they are asked for.
const WARMQ = []
const WARMQ_KEYS = new Set()       // the keys currently queued: a frame is queued at most once
const warmKey = (a) => a[0] + '|' + a[1] + '|' + a[2] + '|' + a[3] + '|' + a[4] + '|' + a[5]
function warmPush(a) { const k = warmKey(a); if (!WARMQ_KEYS.has(k)) { WARMQ_KEYS.add(k); WARMQ.push(a) } }
// a frame the draw path had to skip goes to the front (once): repeated misses of the same frame just keep it there
function warmFront(a) {
  const k = warmKey(a)
  if (WARMQ_KEYS.has(k)) {
    const i = WARMQ.findIndex((q) => warmKey(q) === k)
    if (i <= 0) return
    WARMQ.splice(i, 1)
  } else WARMQ_KEYS.add(k)
  WARMQ.unshift(a)
}
function queueSiblings(kind, name) {
  if (kind === 'creature') {
    const low = !!(FIG[name] && FIG[name].low)
    for (let s = 0; s < STATES.length; s++) for (let a = 0; a < ANIM_FRAMES[s]; a++) {
      warmPush([kind, name, 0, s, a, FACING_FRONT])
      if (low) warmPush([kind, name, 0, s, a, FACING_SIDE])
    }
  } else if (kind === 'prop') {
    for (let v = 0; v < 3; v++) warmPush([kind, name, v, 0, 0, 0])
  } else if (kind === 'exit') {
    warmPush([kind, name, 0, 0, 1, 0])
  } else if (kind === 'sight' && name === 'tvwall') {
    for (let b = 1; b < 4; b++) warmPush([kind, name, 0, 0, b & 1, b >> 1])
  } else if (kind === 'person') {
    warmPush([kind, name, 0, 1, 0, 0]); warmPush([kind, name, 0, 1, 1, 0])
  }
}
const nowMs = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : 0)
let GEN_MS = 0                   // time spent generating frames during the current drawSprites call
const GEN_BUDGET_MS = 9          // past this, further missing frames wait for a later call (the sprite pops in a frame or two late)
let WARM_WAIT = 0                // draw calls to leave alone after an expensive background frame

// The draw path's frame lookup: a hit is free; a miss builds the frame now unless this call has already spent its budget, in
// which case the entity is skipped this frame and its frame goes to the FRONT of the queue. Under the harness's frozen clock
// no time ever passes, so scenes always render complete.
function frameFor(kind, name, v, s, a, f) {
  const byKind = ATLAS[kind], list = byKind && byKind[name]
  if (list !== undefined) { const fr = list[frameIndex(v, s, a, f)]; if (fr !== undefined) return fr }
  if (GEN_MS > GEN_BUDGET_MS) { warmFront([kind, name, v, s, a, f]); return null }
  const t0 = nowMs()
  const fr = getFrame(kind, name, v, s, a, f)
  GEN_MS += nowMs() - t0
  return fr
}

const hasFrame = (a) => { const l = ATLAS[a[0]] && ATLAS[a[0]][a[1]]; return l !== undefined && l[frameIndex(a[2], a[3], a[4], a[5])] !== undefined }
function warmStep(slow) {
  let a = WARMQ.shift()
  while (a !== undefined) { WARMQ_KEYS.delete(warmKey(a)); if (!hasFrame(a)) break; a = WARMQ.shift() }   // already built by the draw path: free
  if (a === undefined) return
  const t0 = nowMs()
  getFrame(a[0], a[1], a[2], a[3], a[4], a[5])
  const dt = nowMs() - t0
  GEN_MS += dt
  WARM_WAIT = dt > 12 ? 14 : dt > 5 ? 5 : slow ? 2 : 0     // an expensive frame buys the device a rest (a slow device rests between any two)
}

// What each level can show (mirrors levels.js), queued in the background the first time the level is drawn.
const LEVEL_SPRITES = {
  '0': { props: ['chair', 'cabinet', 'box', 'cone', 'papers', 'plant'], items: ['almond-water', 'glowstick', 'polaroid', 'radio'], creatures: [], machines: true, notes: true, sights: true },
  '1': { props: ['pallet', 'barrel', 'crate', 'couch', 'cart', 'box'], items: ['almond-water', 'glowstick', 'bandage', 'polaroid', 'radio'], creatures: ['smiler', 'hound', 'watcher'], notes: true, sights: true },
  '2': { props: ['pipe', 'valve', 'drum', 'toolbox', 'vent', 'crate'], items: ['almond-water', 'glowstick', 'bandage', 'radio'], creatures: ['lurker', 'hound', 'crawler'], notes: true, sights: true },
  '3': { props: ['transformer', 'cabinet-e', 'spool', 'sign', 'drum'], items: ['almond-water', 'glowstick', 'bandage', 'radio'], creatures: ['tesla', 'smiler', 'watcher'], notes: true, sights: true },
  '∅': { props: ['trash', 'tire', 'weeds', 'box'], items: ['polaroid'], creatures: [] },
}
let LAST_LEVEL = null
const LEVEL_QUEUED = new Set()     // level keys whose own config list was queued (prewarmSprites / queueLevelSprites): LEVEL_SPRITES is not needed
function queueLevel(key) {
  if (LEVEL_QUEUED.has(key)) return
  const L = LEVEL_SPRITES[key]
  if (!L) return
  for (const c of L.creatures) warmPush(['creature', c, 0, 0, 0, FACING_FRONT])
  warmPush(['exit', 'portal', 0, 0, 0, 0])
  for (const t of L.props) warmPush(['prop', t, 0, 0, 0, 0])
  for (const t of L.items) warmPush(['item', t, 0, 0, 0, 0])
  if (L.notes) warmPush(['note', 'unread', 0, 0, 0, 0]); warmPush(['note', 'read', 0, 0, 0, 0])
  if (L.machines) warmPush(['machine', 'lit', 0, 0, 0, 0]); warmPush(['machine', 'spent', 0, 0, 0, 0])
  if (L.sights) for (const t of Object.keys(SIGHT_SPEC)) warmPush(['sight', t, 0, 0, 0, 0])
}

// The frames a level can show, from its CONFIG, most important first (a cut drops the tail): the exit, notes and machines, the first
// pose of each creature (idle, then chase), one variant of each prop and item, then the other prop variants and creature poses, then
// (levels 0-3) the landmark sights.
const SIGHT_LEVELS = { '0': 1, '1': 1, '2': 1, '3': 1 }
function levelJobs(c) {
  const jobs = []
  if (c.exit || c.exitAt) jobs.push(['exit', 'portal', 0, 0, 0, 0])
  if (c.scraps && c.scraps.denom !== 0) jobs.push(['note', 'unread', 0, 0, 0, 0], ['note', 'read', 0, 0, 0, 0])
  if (c.machines && c.machines.denom !== 0) jobs.push(['machine', 'lit', 0, 0, 0, 0], ['machine', 'spent', 0, 0, 0, 0])
  const ent = c.entities, cast = []
  if (ent && ent.enabled !== false) for (const v of [...(ent.stalkerVariants || []), ...(ent.wandererVariants || [])]) if (FIG[v] && !cast.includes(v)) cast.push(v)
  for (const v of cast) jobs.push(['creature', v, 0, 0, 0, FACING_FRONT])
  for (const v of cast) jobs.push(['creature', v, 0, 1, 0, FACING_FRONT])
  for (const t of (c.props && c.props.types) || []) jobs.push(['prop', PROP_SPEC[t] ? t : 'box', 0, 0, 0, 0])
  for (const t of (c.items && c.items.types) || []) jobs.push(['item', ITEM_COLORS[t] ? t : 'radio', 0, 0, 0, 0])
  for (const t of (c.props && c.props.types) || []) for (let v = 1; v < 3; v++) jobs.push(['prop', PROP_SPEC[t] ? t : 'box', v, 0, 0, 0])
  for (const v of cast) for (const s of [2, 3]) jobs.push(['creature', v, 0, s, 0, FACING_FRONT])
  if (SIGHT_LEVELS[levelKey(c)]) for (const t of Object.keys(SIGHT_SPEC)) jobs.push(['sight', t, 0, 0, 0, 0])
  return jobs
}

// HS-1: the queue is module state shared by every renderer, but its jobs belong to ONE level. When a level's list is queued for a level other
// than the one the queue was last filled for (a new renderer on another level: CPU or GPU, the queue is shared), the old level's unbuilt tail is
// dropped first, so the new level's first seconds build the new level's frames. Jobs for a sprite the new level lists too (a creature's other
// poses, a prop's variants) are kept, behind the new level's own list. The same level queued again (both backends' creation paths, a re-run)
// keeps everything. Timing only: every frame is built on demand anyway, so what is drawn does not change.
let WARM_LEVEL = null
function warmForLevel(key, jobs) {
  if (key === WARM_LEVEL) return null
  const had = WARM_LEVEL !== null
  WARM_LEVEL = key
  if (!had || WARMQ.length === 0) return null
  const names = new Set(jobs.map((j) => j[0] + '|' + j[1]))
  const keep = WARMQ.filter((a) => names.has(a[0] + '|' + a[1]))
  WARMQ.length = 0; WARMQ_KEYS.clear()
  return keep
}
// a snapshot of the background queue (tests / tools): [kind, name, v, state, anim, facing] per job, in build order
export function warmQueue() { return WARMQ.map((a) => a.slice()) }

// Build a level's frames up front (synchronous), as far as `maxMs` allows, and queue the rest for the background (built one frame per
// draw call, CPU and GPU alike). Both backends call it at creation with the level config, so the (few ms per frame) generation cost is
// off the first sighting. Returns frames built.
export function prewarmSprites(config, maxMs = 400) {
  const t0 = typeof performance !== 'undefined' ? performance.now() : 0
  const before = FRAMES_BUILT
  const jobs = levelJobs(config || {})
  const keep = config ? warmForLevel(levelKey(config), jobs) : null
  let i = 0
  for (; i < jobs.length; i++) {
    const j = jobs[i]
    if (i > 0 && typeof performance !== 'undefined' && performance.now() - t0 > maxMs) break     // the first (most important) job always runs
    getFrame(j[0], j[1], j[2], j[3], j[4], j[5])
  }
  for (; i < jobs.length; i++) warmPush(jobs[i])
  if (keep) for (const a of keep) warmPush(a)
  if (config) LEVEL_QUEUED.add(levelKey(config))
  return FRAMES_BUILT - before
}
// Queue a level's whole list for the background without building anything now.
export function queueLevelSprites(config) {
  if (!config) return
  const jobs = levelJobs(config)
  const keep = warmForLevel(levelKey(config), jobs)
  for (const j of jobs) warmPush(j)
  if (keep) for (const a of keep) warmPush(a)
  LEVEL_QUEUED.add(levelKey(config))
}

export function atlasStats() { return { frames: FRAMES_BUILT, bytes: TEX_BYTES } }
export function resetAtlas() { for (const k of Object.keys(ATLAS)) delete ATLAS[k]; FRAMES_BUILT = 0; TEX_BYTES = 0; WARMQ.length = 0; WARMQ_KEYS.clear(); LAST_LEVEL = null; LEVEL_QUEUED.clear(); WARM_WAIT = 0; MOTION.length = 0; WARM_LEVEL = null }

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 5. THE ART
// ════════════════════════════════════════════════════════════════════════════════════════════════
// @@CREATURES-BEGIN@@
function strHash(s) {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) }
  return h >>> 0
}
// strHash is a full-range uint32, outside the range the pre-Math.imul hash2 was exact in: the frozen legacy construction keeps every sprite's art
// exactly as it has always been drawn (gfx-util.js hash2Legacy)
const seedOf = (name, a = 0, b = 0, c = 0) => hash2Legacy(strHash(name), (a * 16 + b) * 8 + c, 0x9e37)
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t) }

// ── creature and person canvas ──
// Normalised figure coordinates: origin at the feet, x across, y up, 1.0 = the figure's full height. G.X/Y/L map them to
// pixels (L = a length). The canvas is wider than the body so the runtime sway never crops it.
const PPU_FIG = 144
function makeG(w, h, ppu, padX) {
  const fw = Math.ceil((w + padX * 2) * ppu), fh = Math.ceil((h + 0.03) * ppu)
  const S = h * ppu, feet = fh - 0.015 * ppu
  return {
    fw, fh, S, feet, ppu, P: createPaint(fw, fh), F: createField(fw, fh),
    X: (nx) => fw / 2 + nx * S, Y: (ny) => feet - ny * S, L: (n) => n * S,
    rect: [-(fw / 2) / ppu, (fw / 2) / ppu, -0.015, feet / ppu],
  }
}

// a limb as two tapered capsules meeting at an IK elbow; bend = +1 puts the elbow left of the root->end line, -1 right
function limb(F, x0, y0, x1, y1, l1, l2, bend, r0, r1, r2, k) {
  let dx = x1 - x0, dy = y1 - y0, d = hyp(dx, dy) || 1e-3
  const reach = l1 + l2 - 0.5
  if (d > reach) { x1 = x0 + (dx * reach) / d; y1 = y0 + (dy * reach) / d; dx = x1 - x0; dy = y1 - y0; d = reach }
  const a = (l1 * l1 - l2 * l2 + d * d) / (2 * d)
  const h = Math.sqrt(Math.max(0, l1 * l1 - a * a))
  const ux = dx / d, uy = dy / d
  const ex = x0 + ux * a - uy * h * bend, ey = y0 + uy * a + ux * h * bend
  fieldSeg(F, x0, y0, ex, ey, r0, r1, k)
  fieldSeg(F, ex, ey, x1, y1, r1, r2, k)
  return [ex, ey, x1, y1]
}

// a hand: a palm and a fan of fingers pointing along (ux, uy)
function hand(F, x, y, ux, uy, size, fingers, flen, k) {
  fieldEll(F, x + ux * size * 0.3, y + uy * size * 0.3, size * 0.55, size * 0.7, k)
  const base = Math.atan2(uy, ux)
  for (let i = 0; i < fingers; i++) {
    const a = base + (fingers > 1 ? (i / (fingers - 1) - 0.5) * 0.7 : 0)
    const sx = x + ux * size * 0.6, sy = y + uy * size * 0.6
    fieldSeg(F, sx, sy, sx + Math.cos(a) * flen, sy + Math.sin(a) * flen, size * 0.16, size * 0.07, 0)
  }
}

// hand target (normalised) for a side (-1 left, +1 right) in each state; anim swaps which hand leads
function handTarget(stateIx, anim, sd, R) {
  const a = anim ? 1 : -1
  if (stateIx === 1) return [sd * (R.shHW + 0.09), R.shY - 0.2 + 0.03 * a * sd]   // lunging: short, foreshortened arms crooked out to grab, hands big
  if (stateIx === 2) return [sd * 0.115, 0.34 + 0.1 * a * sd]
  if (stateIx === 3) return [sd * 0.095, R.headY - 0.02 + 0.03 * a * sd]
  if (R.handX === undefined) return [sd * (R.shHW + 0.028), R.shY - 0.02 - (R.arm.l1 + R.arm.l2) * 0.955]
  return [sd * R.handX, R.handY]
}
const HEAD_OFF = [[0, 0], [0, -0.07], [0, -0.055], [0.006, 0.012]]   // head dx, dy per state

// The shared humanoid: legs, feet, pelvis, chest, shoulders, neck, head and arms with hands — one smoothly unioned field.
function humanoid(G, R, stateIx, anim, o = {}) {
  const { F, X, Y, L } = G
  const k = L(o.k ?? 0.03)
  const hd = HEAD_OFF[stateIx]
  const hunch = (o.hunch || 0) + (stateIx === 1 ? 0.035 : 0)      // lunging: shoulders drop, the head thrusts forward
  const tilt = o.tilt || 0
  const shY = R.shY - hunch * 0.6
  if (!o.noLegs) {
    for (const sd of [-1, 1]) {
      const st = stateIx === 3 ? R.leg.stance * 1.35 : R.leg.stance
      const lift = stateIx === 1 || stateIx === 2 ? Math.max(0, (anim ? sd : -sd)) * 0.045 : 0
      limb(F, X(sd * R.hipHW), Y(R.hipY), X(sd * st), Y(0.02 + lift), L(R.leg.l1), L(R.leg.l2), -sd * 0.6, L(R.leg.r0), L(R.leg.r1), L(R.leg.r2), k)
      if (R.foot) fieldEll(F, X(sd * (st + R.foot * 0.35)), Y(0.012 + lift), L(R.foot), L(R.foot * 0.36), k * 0.5)
    }
  }
  // pelvis, waist, chest, sloping shoulders
  const chRy = R.chestRy ?? 0.12
  fieldEll(F, X(0), Y(R.hipY + 0.015), L(R.hipHW * 1.4), L(0.07), k)
  fieldSeg(F, X(0), Y(R.hipY + 0.05), X(tilt * 0.5), Y(shY - chRy * 0.8), L(R.waistHW), L(R.waistHW * 1.05), k)
  fieldEll(F, X(tilt * 0.5), Y(shY - chRy + 0.02), L(R.shHW * 0.95), L(chRy), k)
  fieldPoly(F, [X(-R.neckR * 1.5), Y(shY + 0.04), X(R.neckR * 1.5), Y(shY + 0.04), X(R.shHW * 1.02), Y(shY - 0.015), X(-R.shHW * 1.02), Y(shY - 0.015)], k)
  const hx = hd[0] + tilt, hy = R.headY + hd[1] - hunch
  fieldSeg(F, X(tilt * 0.4), Y(shY + 0.01), X(hx), Y(hy - R.hry * 0.55), L(R.neckR), L(R.neckR * 0.92), k)
  fieldEll(F, X(hx), Y(hy), L(R.hrx), L(R.hry), k)
  if (R.jaw) fieldEll(F, X(hx), Y(hy - R.hry * 0.55), L(R.hrx * 0.68), L(R.hry * 0.55), k)
  if (!o.noArms) {
    for (const sd of [-1, 1]) {
      const [tx, ty] = handTarget(stateIx, anim, sd, R)
      const fsh = stateIx === 1 ? 0.56 : 1                      // an arm reaching at the viewer is foreshortened
      const [, , wx, wy] = limb(F, X(sd * R.shHW * 0.98 + tilt * 0.5), Y(shY - 0.02), X(tx), Y(ty), L(R.arm.l1 * fsh), L(R.arm.l2 * fsh), -sd, L(R.arm.r0), L(R.arm.r1), L(R.arm.r2), k)
      if (R.hand) {
        const dx = wx - X(sd * R.shHW), dy = wy - Y(shY), dl = hyp(dx, dy) || 1
        hand(F, wx, wy, dx / dl, dy / dl, L(R.hand.size * (stateIx === 1 ? 1.35 : 1)), R.hand.fingers, L(R.hand.flen * (stateIx === 1 ? 1.25 : 1)), k * 0.5)
      }
    }
  }
  return { hx, hy, shY }
}

// a tattered cloak polygon from the shoulders down to a ragged hem; `shift` swings the hem sideways
function cloak(G, rnd, topY, topHW, botY, botHW, tat, shift, k) {
  const { F, X, Y, L } = G
  const pts = [X(-topHW), Y(topY), X(topHW), Y(topY)]
  const N = 13
  for (let i = 0; i <= N; i++) {
    const t = i / N
    const x = botHW * (1 - 2 * t) + shift
    const y = botY + tat * ((i & 1) ? 0.3 + rnd() * 0.7 : rnd() * 0.25)
    pts.push(X(x), Y(y))
  }
  fieldPoly(F, pts, k ?? L(0.035))
}

const clothTex = (seed, streak = 1) => (x, y) => 1 + streak * 0.34 * (nz(x * 0.3 + seed, y * 0.045 + seed * 0.7) - 0.5) * 2 + 0.1 * (nz(x * 1.4, y * 1.4) - 0.5)

// eyes / tells drawn into a glow paint (additive colour, alpha = brightness)
function eyePair(GP, x, y, dx, rx, ry, col, a) {
  for (const sd of [-1, 1]) {
    glowEll(GP, x + sd * dx, y, rx * 3.4, ry * 3.4, col[0], col[1], col[2], a * 0.2, 1.9)
    glowEll(GP, x + sd * dx, y, rx * 1.7, ry * 1.7, col[0], col[1], col[2], a * 0.9, 0.8)
    glowEll(GP, x + sd * dx, y, rx * 0.9, ry * 0.9, 255, 255, 255, a, 0.6)
  }
}

const RIG = {
  shade:   { hipY: 0.46, hipHW: 0.07, shY: 0.75, shHW: 0.15, waistHW: 0.11, headY: 0.865, hrx: 0.105, hry: 0.125, neckR: 0.05, chestRy: 0.13,
             arm: { l1: 0.2, l2: 0.19, r0: 0.05, r1: 0.042, r2: 0.03 }, reachX: 0.11, reachY: 0.5,
             leg: { l1: 0.24, l2: 0.23, r0: 0.05, r1: 0.045, r2: 0.035, stance: 0.09 } },
  watcher: { hipY: 0.45, hipHW: 0.05, shY: 0.72, shHW: 0.105, waistHW: 0.052, headY: 0.875, hrx: 0.088, hry: 0.108, neckR: 0.026, chestRy: 0.1,
             arm: { l1: 0.25, l2: 0.25, r0: 0.032, r1: 0.026, r2: 0.017 }, reachX: 0.12, reachY: 0.5,
             hand: { size: 0.036, fingers: 4, flen: 0.06 },
             leg: { l1: 0.235, l2: 0.235, r0: 0.042, r1: 0.03, r2: 0.021, stance: 0.055 }, foot: 0.032 },
  smiler:  { hipY: 0.45, hipHW: 0.055, shY: 0.725, shHW: 0.105, waistHW: 0.055, headY: 0.875, hrx: 0.06, hry: 0.08, neckR: 0.026, chestRy: 0.11,
             arm: { l1: 0.26, l2: 0.26, r0: 0.032, r1: 0.024, r2: 0.016 }, reachX: 0.13, reachY: 0.52,
             hand: { size: 0.04, fingers: 4, flen: 0.075 },
             leg: { l1: 0.235, l2: 0.235, r0: 0.048, r1: 0.034, r2: 0.024, stance: 0.06 }, foot: 0.034 },
  lurker:  { hipY: 0.5, hipHW: 0.035, shY: 0.79, shHW: 0.07, waistHW: 0.036, headY: 0.935, hrx: 0.045, hry: 0.062, neckR: 0.017, chestRy: 0.11,
             arm: { l1: 0.28, l2: 0.28, r0: 0.022, r1: 0.017, r2: 0.011 }, reachX: 0.1, reachY: 0.5,
             hand: { size: 0.024, fingers: 4, flen: 0.085 },
             leg: { l1: 0.26, l2: 0.25, r0: 0.03, r1: 0.021, r2: 0.014, stance: 0.04 }, foot: 0.022 },
  tesla:   { hipY: 0.45, hipHW: 0.08, shY: 0.75, shHW: 0.17, waistHW: 0.11, headY: 0.87, hrx: 0.092, hry: 0.1, neckR: 0.055, chestRy: 0.14,
             arm: { l1: 0.22, l2: 0.22, r0: 0.058, r1: 0.05, r2: 0.04 }, reachX: 0.16, reachY: 0.55,
             hand: { size: 0.05, fingers: 0, flen: 0 },
             leg: { l1: 0.23, l2: 0.23, r0: 0.065, r1: 0.05, r2: 0.045, stance: 0.105 }, foot: 0.06 },
  thin:    { hipY: 0.48, hipHW: 0.055, shY: 0.78, shHW: 0.11, waistHW: 0.07, headY: 0.9, hrx: 0.056, hry: 0.076, neckR: 0.026, chestRy: 0.12,
             arm: { l1: 0.22, l2: 0.22, r0: 0.03, r1: 0.025, r2: 0.017 }, reachX: 0.12, reachY: 0.56,
             hand: { size: 0.03, fingers: 4, flen: 0.05 },
             leg: { l1: 0.25, l2: 0.24, r0: 0.04, r1: 0.03, r2: 0.021, stance: 0.06 }, foot: 0.03 },
  player:  { hipY: 0.47, hipHW: 0.062, shY: 0.78, shHW: 0.135, waistHW: 0.085, headY: 0.9, hrx: 0.066, hry: 0.078, neckR: 0.03, chestRy: 0.13,
             arm: { l1: 0.22, l2: 0.21, r0: 0.04, r1: 0.032, r2: 0.023 }, reachX: 0.13, reachY: 0.5,
             hand: { size: 0.032, fingers: 0, flen: 0 },
             leg: { l1: 0.25, l2: 0.23, r0: 0.05, r1: 0.038, r2: 0.028, stance: 0.07 }, foot: 0.042 },
  npc:     { hipY: 0.47, hipHW: 0.062, shY: 0.76, shHW: 0.135, waistHW: 0.095, headY: 0.86, hrx: 0.068, hry: 0.08, neckR: 0.034, chestRy: 0.13,
             arm: { l1: 0.22, l2: 0.21, r0: 0.04, r1: 0.032, r2: 0.023 }, reachX: 0.12, reachY: 0.4,
             hand: { size: 0.032, fingers: 0, flen: 0 },
             leg: { l1: 0.25, l2: 0.23, r0: 0.05, r1: 0.038, r2: 0.028, stance: 0.065 }, foot: 0.04 },
}

// Build one creature frame. Returns a Frame: layer 0 = the lit body (rim-capable), layer 1 = emissive tells (eyes, grin),
// layers 2.. = electric arc banks (tesla). Front views for tall creatures; low ones also have a side profile.
function creatureFrame(name, stateIx, anim, facing) {
  const spec = FIG[name] || FIG.shade
  const seed = seedOf(name, 0, stateIx, anim * 3 + facing)
  const rnd = mulberry32(seed)
  const G = makeG(spec.w, spec.h, PPU_FIG, 0.09)
  const GP = createPaint(G.fw, G.fh)                       // glow paint
  let build
  if (name === 'hound') build = facing === FACING_SIDE ? buildHoundSide : buildHoundFront
  else if (name === 'crawler') build = facing === FACING_SIDE ? buildCrawlerSide : buildCrawlerFront
  else build = BUILDERS[name] || BUILDERS.shade
  const info = build(G, GP, rnd, stateIx, anim) || {}
  const t = spec.tint
  const lift = name === 'thin' ? 1 : 1.5
  paintField(G.P, G.F, {
    c: [t[0] * lift + 5, t[1] * lift + 5, t[2] * lift + 5], R: G.L(info.bulge || 0.05), soft: info.soft || 0.75,
    amb: name === 'thin' ? 0.8 : 0.62, dif: name === 'thin' ? 0.55 : 0.95, sky: 0.1,
    cold: name === 'tesla' ? 1 : 0.35, rim: true, tex: info.tex || clothTex(seed % 97),
    alpha: name === 'thin' ? (x, y) => 0.42 + 0.58 * smooth(0, 1, (G.feet - y) / G.L(0.4)) : null,
  })
  const layers = [packLayer(G.P, G.rect[0], G.rect[1], G.rect[2], G.rect[3], { rimK: 1 })]
  if (info.glow !== false) layers.push(packLayer(GP, G.rect[0], G.rect[1], G.rect[2], G.rect[3], { mode: 1, emit: 1, fogK: 0.8 }))
  if (info.arcs) for (const a of info.arcs) layers.push(packLayer(a, G.rect[0], G.rect[1], G.rect[2], G.rect[3], { mode: 1, emit: 1, fogK: 0.8 }))
  return makeFrame(layers)
}

const BUILDERS = {}

// ─ shade: a hooded, cloaked, hunched figure — the classic ─
BUILDERS.shade = (G, GP, rnd, s, anim) => {
  const { F, X, Y, L } = G
  const R = RIG.shade
  const sw = (anim ? 1 : -1) * (s === 2 ? 0.05 : 0.018)
  const head = humanoid(G, R, s, anim, { noLegs: true, hunch: 0.035, k: 0.05, tilt: 0.014 })
  // an uneven cloak: one shoulder higher, the hem torn into long strips
  cloak(G, rnd, R.shY + 0.03, 0.15, 0.015, s === 3 ? 0.33 : 0.29, 0.09, sw, L(0.04))
  fieldEll(F, X(-0.15), Y(R.shY - 0.025), L(0.075), L(0.06), L(0.04))
  for (let i = 0; i < 3; i++) {
    const x = (rnd() - 0.5) * 0.5 + sw
    fieldSeg(F, X(x), Y(0.1), X(x + (rnd() - 0.5) * 0.04), Y(0.004), L(0.012), L(0.004), 0)
  }
  // hood: a pointed crown that droops forward over the face
  fieldEll(F, X(head.hx), Y(head.hy + 0.02), L(0.115), L(0.145), L(0.05))
  fieldPoly(F, [X(head.hx - 0.07), Y(head.hy + 0.06), X(head.hx + 0.075), Y(head.hy + 0.06), X(head.hx + 0.03), Y(head.hy + 0.19), X(head.hx + 0.005), Y(head.hy + 0.185)], L(0.04))
  const seed = 5
  const hx = X(head.hx), hy = Y(head.hy - 0.005)
  return {
    bulge: 0.075,
    tex: (x, y) => {
      const v = clothTex(seed)(x, y)
      const hd = hyp((x - hx) / L(0.062), (y - hy) / L(0.08))      // the hood's hollow: nothing looks back
      return hd < 1 ? v * (0.28 + 0.72 * smooth(0.5, 1, hd)) : v
    },
    glow: false,
  }
}

// ─ watcher: gaunt, long-armed, in a rag of coat, with a too-large head and two pale unblinking eyes ─
BUILDERS.watcher = (G, GP, rnd, s, anim) => {
  const { F, X, Y, L } = G
  const R = RIG.watcher
  const head = humanoid(G, R, s, anim, { k: 0.02, tilt: 0.008 })
  const pts = [X(-0.12), Y(0.715), X(0.12), Y(0.715)]
  for (let i = 0; i <= 9; i++) { const t = i / 9; pts.push(X(0.155 * (1 - 2 * t)), Y(0.25 + ((i & 1) ? 0.07 : 0) * (0.4 + rnd()) + rnd() * 0.04)) }
  fieldPoly(F, pts, L(0.03))
  eyePair(GP, X(head.hx), Y(head.hy + 0.005), L(0.04), L(0.02), L(0.034), [214, 226, 208], 1)
  return { bulge: 0.04 }
}

// ─ smiler: a dark, formless figure whose only lit features are a wide, too-bright toothy grin and two slanted eyes ─
BUILDERS.smiler = (G, GP, rnd, s, anim) => {
  const R = RIG.smiler
  const { F, X, Y, L } = G
  const head = humanoid(G, R, s, anim, { k: 0.03, hunch: 0.025, tilt: 0.02 })
  // a long coat hanging from narrow shoulders, and a tilted, egg-shaped head
  const pts = [X(-0.115), Y(0.72), X(0.115), Y(0.72)]
  for (let i = 0; i <= 8; i++) { const t = i / 8; pts.push(X(0.17 * (1 - 2 * t)), Y(0.24 + ((i & 1) ? 0.06 : 0) * (0.5 + rnd()) + rnd() * 0.04)) }
  fieldPoly(F, pts, L(0.04))
  fieldEll(F, X(head.hx + 0.014), Y(head.hy - 0.04), L(0.07), L(0.105), L(0.03))
  fieldEll(F, X(head.hx - 0.006), Y(head.hy + 0.05), L(0.06), L(0.06), L(0.03))
  const cx = X(head.hx + 0.01), cy = Y(head.hy - 0.028)
  const half = L(0.078), depth = L(0.03), gap = L(0.024)
  const N = 27
  // two rows of small teeth with the dark of the mouth between them: a grin, not a smiley
  for (let row = 0; row < 2; row++) {
    for (let i = 0; i < N; i++) {
      const u = -1 + (2 * i) / (N - 1)
      const x = cx + u * half
      const yb = cy + depth * (1 - u * u) - depth * 0.5 + (row ? gap * (1 - u * u * 0.55) : 0)
      const th = (0.4 + rnd() * 0.6) * L(0.02) * (1 - u * u * 0.5)
      if (row === 0) glowSeg(GP, x, yb - L(0.002), x, yb + th, 0.75, 250, 246, 226, 1)
      else glowSeg(GP, x, yb - th, x, yb + L(0.002), 0.75, 244, 240, 218, 0.95)
    }
  }
  for (let i = 0; i < N - 1; i++) {
    const u0 = -1 + (2 * i) / (N - 1), u1 = -1 + (2 * (i + 1)) / (N - 1)
    glowSeg(GP, cx + u0 * half, cy + depth * (1 - u0 * u0) - depth * 0.5, cx + u1 * half, cy + depth * (1 - u1 * u1) - depth * 0.5, 0.8, 238, 234, 214, 0.9)
  }
  glowEll(GP, cx, cy + gap * 0.5, half * 1.6, L(0.08), 240, 232, 205, 0.2, 1.4)
  for (const sd of [-1, 1]) {   // narrow slanted eyes above the grin
    glowSeg(GP, cx + sd * L(0.05), Y(head.hy + 0.05) - sd * 0.9, cx + sd * L(0.022), Y(head.hy + 0.04) + sd * 0.9, 1.0, 232, 236, 224, 0.95)
  }
  return { bulge: 0.05, soft: 1.5 }
}

// ─ lurker: too tall, too thin, a small head bent forward from under the ceiling ─
BUILDERS.lurker = (G, GP, rnd, s, anim) => {
  const R = RIG.lurker
  const { F, X, Y, L } = G
  const head = humanoid(G, R, s, anim, { k: 0.016, hunch: 0.04, tilt: 0.02 })
  const pts = [X(-0.06), Y(0.76), X(0.06), Y(0.76)]
  for (let i = 0; i <= 6; i++) { const t = i / 6; pts.push(X(0.085 * (1 - 2 * t)), Y(0.32 + ((i & 1) ? 0.07 : 0) * (0.4 + rnd()) + rnd() * 0.05)) }
  fieldPoly(F, pts, L(0.02))
  eyePair(GP, X(head.hx), Y(head.hy + 0.005), L(0.017), L(0.008), L(0.011), [210, 222, 232], 0.9)
  return { bulge: 0.02 }
}

// ─ tesla: a stiff, insulated figure wreathed in a flickering electric outline ─
BUILDERS.tesla = (G, GP, rnd, s, anim) => {
  const { F, X, Y, L } = G
  const R = RIG.tesla
  const head = humanoid(G, R, s, anim, { k: 0.03 })
  fieldBox(F, X(-0.19), Y(0.78), X(0.19), Y(0.6), L(0.035), L(0.03))              // a bulky insulated jacket
  fieldBox(F, X(-0.15), Y(0.62), X(0.15), Y(0.42), L(0.03), L(0.03))              // apron / tool belt
  fieldEll(F, X(head.hx), Y(head.hy + 0.008), L(0.102), L(0.108), L(0.02))          // a domed helmet
  // a visor slit rather than two dots
  glowSeg(GP, X(head.hx - 0.05), Y(head.hy), X(head.hx + 0.05), Y(head.hy), 1.4, 150, 215, 255, 0.95)
  glowEll(GP, X(head.hx), Y(head.hy), L(0.09), L(0.03), 160, 220, 255, 0.35, 1.4)
  const f = G.F.f, { fw, fh } = G
  const edge = []
  for (let y = 1; y < fh - 1; y++) for (let x = 1; x < fw - 1; x++) { const d = f[y * fw + x]; if (d > -0.6 && d < 0.6) edge.push(x, y) }
  for (let i = 0; i < edge.length; i += 2) glowEll(GP, edge[i] + 0.5, edge[i + 1] + 0.5, 1.6, 1.6, 120, 190, 255, 0.34, 1)
  const arcs = []
  for (let b = 0; b < 3; b++) {
    const A = createPaint(fw, fh)
    const r2 = mulberry32(seedOf('tesla-arc', s, anim, b))
    for (let n = 0; n < 9 && edge.length; n++) {
      const ei = ((r2() * (edge.length / 2)) | 0) * 2
      let x = edge[ei] + 0.5, y = edge[ei + 1] + 0.5
      const gx = (f[Math.min(fh - 1, edge[ei + 1] + 1) * fw + edge[ei]] - f[Math.max(0, edge[ei + 1] - 1) * fw + edge[ei]])
      const gy0 = (f[edge[ei + 1] * fw + Math.min(fw - 1, edge[ei] + 1)] - f[edge[ei + 1] * fw + Math.max(0, edge[ei] - 1)])
      let ang = Math.atan2(gx, gy0) + (r2() - 0.5) * 1.6
      const segs = 3 + ((r2() * 3) | 0)
      for (let k = 0; k < segs; k++) {
        const len = L(0.018 + r2() * 0.03)
        const nx = x + Math.cos(ang) * len, ny = y + Math.sin(ang) * len
        glowSeg(A, x, y, nx, ny, 0.75, 170, 222, 255, 0.95 - k * 0.12)
        x = nx; y = ny; ang += (r2() - 0.5) * 2.3
      }
    }
    arcs.push(A)
  }
  return { bulge: 0.05, arcs }
}

// ─ thin: a pale person, minted thin — see-through, a little too tall, unaware ─
BUILDERS.thin = (G, GP, rnd, s, anim) => {
  const { F, X, Y, L } = G
  const R = RIG.thin
  humanoid(G, R, s === 1 || s === 3 ? 0 : s, anim, { k: 0.03, tilt: 0.008 })
  const pts = [X(-0.125), Y(0.775), X(0.125), Y(0.775)]
  for (let i = 0; i <= 6; i++) { const t = i / 6; pts.push(X(0.15 * (1 - 2 * t)), Y(0.32 + ((i & 1) ? 0.04 : 0) + rnd() * 0.03)) }
  fieldPoly(F, pts, L(0.04))
  return { bulge: 0.07, glow: false, soft: 2.2, tex: () => 1 }
}

// ─ hound: low, heavy-chested, long-legged, wrong. The canvas is ~2 S wide, so these are drawn in wide S units. ─
function buildHoundFront(G, GP, rnd, s, anim) {
  const { F, X, Y, L } = G
  const crouch = s === 1 ? 0.05 : 0
  fieldEll(F, X(0), Y(0.66 - crouch), L(0.52), L(0.3), L(0.09))                // hunched shoulders
  fieldEll(F, X(0), Y(0.42 - crouch), L(0.24), L(0.3), L(0.08))                // chest
  fieldEll(F, X(0), Y(0.38 - crouch * 1.4), L(0.22), L(0.24), L(0.06))         // skull, low between the shoulders
  fieldSeg(F, X(0), Y(0.3 - crouch), X(0), Y(0.1), L(0.11), L(0.05), L(0.05))    // muzzle
  for (const sd of [-1, 1]) {
    fieldPoly(F, [X(sd * 0.1), Y(0.5 - crouch * 1.4), X(sd * 0.2), Y(0.52 - crouch * 1.4), X(sd * 0.17), Y(0.74 - crouch * 1.4)], L(0.03))   // ears, laid back
    const st = (anim ? sd : -sd) * (s === 1 ? 0.1 : 0)
    limb(F, X(sd * 0.4), Y(0.56), X(sd * 0.44), Y(0.03 + Math.max(0, st) * 0.6), L(0.36), L(0.34), -sd, L(0.13), L(0.09), L(0.05), L(0.06))
    fieldEll(F, X(sd * 0.44), Y(0.03), L(0.07), L(0.035), L(0.02))
  }
  eyePair(GP, X(0), Y(0.4 - crouch * 1.4), L(0.1), L(0.04), L(0.03), [230, 234, 214], 1.05)
  return { bulge: 0.12 }
}
function buildHoundSide(G, GP, rnd, s, anim) {
  const { F, X, Y, L } = G
  const run = s === 1 ? 1 : 0, a = anim ? 1 : -1
  const hy = 0.5 - run * 0.05
  fieldEll(F, X(0.05), Y(0.62), L(0.44), L(0.22), L(0.09))                       // ribcage / shoulders
  fieldEll(F, X(0.3), Y(0.56), L(0.34), L(0.16), L(0.08))                        // the tucked waist
  fieldEll(F, X(0.58), Y(0.6), L(0.24), L(0.2), L(0.07))                         // hips
  fieldSeg(F, X(-0.26), Y(0.7), X(-0.55), Y(hy + 0.05), L(0.14), L(0.1), L(0.07))   // neck, thrust forward and down
  fieldEll(F, X(-0.64), Y(hy), L(0.15), L(0.11), L(0.05))                        // skull
  fieldSeg(F, X(-0.72), Y(hy - 0.02), X(-0.93), Y(hy - 0.09), L(0.075), L(0.035), L(0.03))   // muzzle
  fieldPoly(F, [X(-0.6), Y(hy + 0.06), X(-0.55), Y(hy + 0.24), X(-0.47), Y(hy + 0.05)], L(0.02))   // an ear
  fieldSeg(F, X(0.78), Y(0.68), X(0.98), Y(0.9), L(0.055), L(0.015), L(0.03))    // tail
  const legs = [[-0.2, -1, 0.09], [0.0, 1, 0.09], [0.5, -1, 0.11], [0.68, 1, 0.11]]
  for (const [lx, ph, r0] of legs) {
    const sw = run ? a * ph * 0.16 : 0
    limb(F, X(lx), Y(0.5), X(lx + sw + (lx > 0.4 ? 0.06 : 0)), Y(0.035 + (run && sw * ph > 0 ? 0.1 : 0)), L(0.32), L(0.3), lx < 0.3 ? 1 : -1, L(r0), L(r0 * 0.66), L(0.038), L(0.05))
  }
  glowEll(GP, X(-0.7), Y(hy + 0.03), L(0.1), L(0.075), 226, 230, 212, 0.45, 1.4)
  glowEll(GP, X(-0.7), Y(hy + 0.03), L(0.045), L(0.033), 255, 255, 250, 0.98, 0.8)
  return { bulge: 0.09 }
}

// ─ crawler: a low, wide, many-limbed thing that goes on all fours the wrong way round ─
function buildCrawlerFront(G, GP, rnd, s, anim) {
  const { F, X, Y, L } = G
  const a = anim ? 1 : -1
  fieldEll(F, X(0), Y(0.6), L(0.7), L(0.3), L(0.09))                            // the wide back
  fieldEll(F, X(0), Y(0.3), L(0.16), L(0.22), L(0.05))                          // a small head, held low, blank
  for (const sd of [-1, 1]) {
    limb(F, X(sd * 0.5), Y(0.62), X(sd * (1.1 + a * sd * 0.05)), Y(0.03), L(0.72), L(0.7), -sd * 0.5, L(0.09), L(0.06), L(0.03), L(0.05))
    limb(F, X(sd * 0.32), Y(0.5), X(sd * (0.7 - a * sd * 0.06)), Y(0.03), L(0.6), L(0.6), -sd * 0.5, L(0.08), L(0.05), L(0.03), L(0.05))
  }
  return { bulge: 0.1, glow: false }
}
function buildCrawlerSide(G, GP, rnd, s, anim) {
  const { F, X, Y, L } = G
  const a = anim ? 1 : -1
  fieldEll(F, X(0.05), Y(0.6), L(0.62), L(0.27), L(0.08))
  fieldEll(F, X(-0.72), Y(0.42), L(0.16), L(0.19), L(0.05))
  fieldSeg(F, X(-0.42), Y(0.6), X(-0.62), Y(0.46), L(0.16), L(0.1), L(0.05))
  for (const [lx, ph] of [[-0.38, 1], [-0.1, -1], [0.3, 1], [0.55, -1]]) {
    limb(F, X(lx), Y(0.62), X(lx + a * ph * 0.1), Y(0.03), L(0.6), L(0.6), lx < 0.1 ? 1 : -1, L(0.07), L(0.045), L(0.026), L(0.05))
  }
  return { bulge: 0.08, glow: false }
}

// ─ people ─
const PERSON_ART = {
  player: (G, GP, rnd, s, anim) => {
    const { F, X, Y, L } = G
    const R = RIG.player
    const head = humanoid(G, R, s === 1 ? 2 : 0, anim, { k: 0.026 })
    fieldBox(F, X(-0.15), Y(0.8), X(0.15), Y(0.44), L(0.05), L(0.03))          // a padded jacket to the hip
    fieldEll(F, X(head.hx), Y(head.hy + 0.02), L(R.hrx * 1.05), L(R.hry * 1.0), L(0.02))
    // a soft cold lamp glow at the chest and head — other people carry a little light
    glowEll(GP, X(head.hx), Y(head.hy - 0.02), L(0.16), L(0.19), 150, 190, 240, 0.34, 1.6)
    glowEll(GP, X(0), Y(0.6), L(0.2), L(0.26), 130, 170, 235, 0.16, 1.7)
    return { bulge: 0.06 }
  },
  npc: (G, GP, rnd, s, anim) => {
    const { F, X, Y, L } = G
    const R = RIG.npc
    const head = humanoid(G, R, 0, anim, { k: 0.03, hunch: 0.05 })
    const pts = [X(-0.14), Y(0.72), X(0.14), Y(0.72)]
    for (let i = 0; i <= 8; i++) { const t = i / 8; pts.push(X(0.18 * (1 - 2 * t)), Y(0.2 + ((i & 1) ? 0.07 : 0) * (0.4 + rnd()) + rnd() * 0.04)) }
    fieldPoly(F, pts, L(0.04))
    void head
    return { bulge: 0.06, glow: false }
  },
}
const PERSON_COL = { player: [118, 132, 160], npc: [126, 116, 102] }
function personFrame(name, stateIx, anim, facing) {
  const spec = PERSON[name] || PERSON.player
  const seed = seedOf('person-' + name, 0, stateIx, anim * 3 + facing)
  const rnd = mulberry32(seed)
  const G = makeG(spec.w, spec.h, PPU_FIG, 0.09)
  const GP = createPaint(G.fw, G.fh)
  const info = PERSON_ART[name](G, GP, rnd, stateIx, anim) || {}
  const c = PERSON_COL[name]
  paintField(G.P, G.F, {
    c, R: G.L(info.bulge || 0.06), amb: 0.6, dif: 0.7, sky: 0.12, cold: name === 'player' ? 1.4 : 0.2, rim: true,
    tex: (x, y) => {
      const base = 0.92 + 0.16 * (nz(x * 0.4 + seed % 31, y * 0.08) - 0.5) * 2
      const R0 = RIG[name]
      const headY = G.Y(R0.headY - 0.045), legY = G.Y(R0.hipY + 0.02)
      if (y < headY + G.L(0.03)) return base * 1.32                       // the head reads paler than the clothes
      if (y > legY) return base * (name === 'player' ? 0.62 : 0.82)         // trousers darker than the coat
      return base
    },
  })
  // the co-op player carries a little light of their own (cold blue = other people): a fraction of emit keeps the body's cold
  // cast from being wiped by a warm room tint, a gentler fog keeps it through a yellow lobby. The lost soul is lit like a wall.
  const layers = [packLayer(G.P, G.rect[0], G.rect[1], G.rect[2], G.rect[3], name === 'player' ? { rimK: 1, emit: 0.45, fogK: 0.8 } : { rimK: 1 })]
  if (info.glow !== false) layers.push(packLayer(GP, G.rect[0], G.rect[1], G.rect[2], G.rect[3], { mode: 1, emit: 1, fogK: 0.7 }))
  return makeFrame(layers)
}

registerGenerator('creature', (name, v, s, anim, facing) => creatureFrame(name, s, anim, facing))
registerGenerator('person', (name, v, s, anim, facing) => personFrame(name, s, anim, facing))
// @@CREATURES-END@@

// @@PROPS-BEGIN@@
// ── props ──
// A prop is painted front-on into a canvas whose body box is (u: 0..1 across, v: 0..1 up) — X(u)/Y(v) map to pixels — then
// finished (edge darkening, contact shadow, dust, stains) and packed as one lit layer. Three seeded variants per type
// (different wear, colour, arrangement); per-instance tint / flip / lean are applied at draw time.
const PPU_PROP = 136

function propCanvas(spec, padU = 0.05) {
  const bw = Math.round(spec.w * PPU_PROP), bh = Math.round(spec.h * PPU_PROP)
  const padX = Math.max(3, Math.round(padU * PPU_PROP)), padT = 3, padB = 3
  const fw = bw + padX * 2, fh = bh + padT + padB
  const floor = fh - padB
  return {
    P: createPaint(fw, fh), fw, fh, bw, bh, padX, floor,
    X: (u) => padX + u * bw, Y: (v) => floor - v * bh, W: (u) => u * bw, H: (v) => v * bh,
    rect: [-(fw / 2) / PPU_PROP, (fw / 2) / PPU_PROP, -padB / PPU_PROP, (fh - padB) / PPU_PROP],
  }
}
const cmul = (c, m) => [Math.min(255, c[0] * m), Math.min(255, c[1] * m), Math.min(255, c[2] * m)]
const cmix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]

// a lit slab: (u0,v0)-(u1,v1) in body coordinates
function slab(c, u0, v0, u1, v1, col, o = {}) {
  const x0 = c.X(u0), x1 = c.X(u1), y0 = c.Y(v1), y1 = c.Y(v0)
  fillBox(c.P, x0, y0, x1, y1, mat({ c: col, x0, x1, y0, y1, kx: o.kx ?? -0.24, ky: o.ky ?? -0.14, cyl: o.cyl || 0, grain: o.grain ?? 0.07, streak: o.streak || 0, seed: o.seed || 0 }), o.r ?? 1)
  return [x0, y0, x1, y1]
}
// a straight stroke of constant thickness (px)
function stroke(c, x0, y0, x1, y1, w, col, a = 1) { fillSeg(c.P, x0, y0, x1, y1, w / 2, w / 2, flat(col[0], col[1], col[2], a)) }
function disc(c, cx, cy, rx, ry, col, o = {}) {
  fillEll(c.P, cx, cy, rx, ry, mat({ c: col, x0: cx - rx, x1: cx + rx, y0: cy - ry, y1: cy + ry, cyl: o.cyl || 0, kx: o.kx ?? -0.2, ky: o.ky ?? -0.2, grain: o.grain ?? 0.06 }))
}

// darken a 1px rim wherever paint meets nothing, so props hold their shape against a bright background
function outlinePaint(P, k) {
  const { w, h, px } = P
  const a = new Float32Array(w * h)
  for (let i = 0; i < a.length; i++) a[i] = px[i * 4 + 3]
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      if (a[i] < 0.5) continue
      const e = Math.min(x > 0 ? a[i - 1] : 0, x < w - 1 ? a[i + 1] : 0, y > 0 ? a[i - w] : 0, y < h - 1 ? a[i + w] : 0)
      if (e < 0.35) { const m = k + (1 - k) * e; px[i * 4] *= m; px[i * 4 + 1] *= m; px[i * 4 + 2] *= m }
    }
  }
}

// dust near the floor, drips and stains, a contact shadow at the base — what makes it look left there for years
function finishProp(c, o = {}) {
  const P = c.P, seed = o.seed || 0
  if (o.outline !== 0) outlinePaint(P, o.outline ?? 0.62)
  const dustK = o.dust ?? 0.35, stainK = o.stain ?? 0.3, dust = o.dustCol || [190, 178, 148]
  const ao = o.ao ?? 0.28
  const { w, h, px } = P
  const T = noiseTable(), sox = (seed * 5) | 0, soy = (seed * 3) | 0
  for (let y = 0; y < h; y++) {
    const hh = (c.floor - (y + 0.5)) / c.bh                  // 0 at the floor, 1 at the top
    const dustA = dustK > 0 && hh < 0.32 ? dustK * smooth(0.32, 0, hh) : 0
    const aoK = hh < 0.11 ? 1 - ao * smooth(0.11, 0, hh) : 1
    for (let x = 0; x < w; x++) {
      const j = (y * w + x) * 4, a = px[j + 3]
      if (a <= 0.004) continue
      const stain = stainK > 0 ? stainK * Math.max(0, nz(x * 0.22 + seed * 3, y * 0.04 + seed) - 0.55) * 3.2 : 0
      let k = 0, cr = 0, cg = 0, cb = 0
      if (stain > 0) { k = Math.min(0.65, stain); cr = 26; cg = 20; cb = 12 }
      else if (dustA > 0) { k = Math.min(0.6, dustA * (0.5 + 0.5 * T[(((y | 0) + soy) & 63) * 64 + (((x | 0) + sox) & 63)])); cr = dust[0]; cg = dust[1]; cb = dust[2] }
      if (k > 0.01) { px[j] = px[j] * (1 - k) + cr * k * a; px[j + 1] = px[j + 1] * (1 - k) + cg * k * a; px[j + 2] = px[j + 2] * (1 - k) + cb * k * a }
      if (aoK < 1) { px[j] *= aoK; px[j + 1] *= aoK; px[j + 2] *= aoK }
    }
  }
}

function propLayer(c, o = {}) {
  return packLayer(c.P, c.rect[0], c.rect[1], c.rect[2], c.rect[3], { rimK: 0, ...o })
}

const PROP_ART = {}
const PROP_FINISH = {}

// ─ chair: an office chair, a wooden school chair, a folding steel chair ─
PROP_ART.chair = (c, rnd, v, spec) => {
  const { X, Y } = c
  const fab = cmul(spec.c, [1, 1.3, 0.85][v]), steel = [128, 128, 132]
  if (v === 0) {
    for (const u of [0.12, 0.3, 0.7, 0.88]) { disc(c, X(u), Y(0.035), c.W(0.04), c.W(0.04), [26, 26, 28]); stroke(c, X(0.5), Y(0.17), X(u), Y(0.05), 1.7, steel) }
    stroke(c, X(0.5), Y(0.34), X(0.5), Y(0.15), 2.4, steel)
    slab(c, 0.06, 0.4, 0.15, 0.6, cmul(fab, 0.8), { r: 1 }); slab(c, 0.85, 0.4, 0.94, 0.6, cmul(fab, 0.8), { r: 1 })
    slab(c, 0.14, 0.32, 0.86, 0.45, fab, { r: 2, streak: 0.2 })
    slab(c, 0.2, 0.5, 0.8, 0.98, cmul(fab, 1.05), { r: 3, streak: 0.25, seed: 4 })
    stroke(c, X(0.5), Y(0.52), X(0.5), Y(0.95), 1, cmul(fab, 0.5), 0.6)
  } else if (v === 1) {
    for (const [u0, u1] of [[0.1, 0.17], [0.83, 0.9]]) slab(c, u0, 0.02, u1, 0.42, cmul(fab, 0.7), { r: 0.5, streak: 0.3 })
    slab(c, 0.06, 0.4, 0.94, 0.5, fab, { r: 1, streak: 0.25 })
    for (const [u0, u1] of [[0.1, 0.17], [0.83, 0.9]]) slab(c, u0, 0.5, u1, 0.98, cmul(fab, 0.85), { r: 0.5 })
    slab(c, 0.1, 0.86, 0.9, 0.98, fab, { r: 1, streak: 0.25 })
    for (let i = 0; i < 4; i++) slab(c, 0.22 + i * 0.16, 0.55, 0.3 + i * 0.16, 0.86, cmul(fab, 0.92), { r: 0.5 })
  } else {
    stroke(c, X(0.15), Y(0.02), X(0.85), Y(0.44), 1.6, steel); stroke(c, X(0.85), Y(0.02), X(0.15), Y(0.44), 1.6, steel)
    slab(c, 0.1, 0.42, 0.9, 0.5, [70, 66, 60], { r: 1 })
    stroke(c, X(0.14), Y(0.5), X(0.14), Y(0.98), 1.8, steel); stroke(c, X(0.86), Y(0.5), X(0.86), Y(0.98), 1.8, steel)
    slab(c, 0.12, 0.62, 0.88, 0.94, [72, 68, 60], { r: 2 })
  }
}
PROP_FINISH.chair = { dust: 0.2, stain: 0.15, ao: 0.2 }

// ─ cabinet: a four-drawer filing cabinet ─
PROP_ART.cabinet = (c, rnd, v, spec) => {
  const { X, Y } = c
  const body = [[92, 96, 76], [122, 116, 98], [78, 84, 88]][v]
  slab(c, 0, 0, 1, 1, body, { r: 1.5, streak: 0.18, seed: v })
  slab(c, 0.03, 0.0, 0.97, 0.035, cmul(body, 0.55), { r: 0 })
  for (let i = 0; i < 4; i++) {
    const v0 = 0.05 + i * 0.235, v1 = v0 + 0.21
    const open = v === 2 && i === 0 ? 0.03 : 0
    if (open) slab(c, 0.04, v0 - 0.006, 0.96, v0 + 0.02, [16, 16, 18], { r: 0 })
    slab(c, 0.05, v0 + open, 0.95, v1 + open, cmul(body, 1.06), { r: 1.2, streak: 0.12, seed: i + v * 4 })
    stroke(c, X(0.05), Y(v0 + open), X(0.95), Y(v0 + open), 1, cmul(body, 0.4), 0.9)
    slab(c, 0.36, v0 + 0.07 + open, 0.64, v0 + 0.115 + open, [40, 40, 42], { r: 1 })
    stroke(c, X(0.37), Y(v0 + 0.118 + open), X(0.63), Y(v0 + 0.118 + open), 1, [180, 178, 170], 0.6)
    slab(c, 0.4, v0 + 0.15 + open, 0.6, v0 + 0.19 + open, [214, 208, 190], { r: 0.5, grain: 0.1 })
  }
  for (let i = 0; i < 6; i++) { const x = X(0.05 + rnd() * 0.9), y = Y(0.08 + rnd() * 0.85); stroke(c, x, y, x + (rnd() - 0.4) * 5, y + rnd() * 3, 0.8, cmul(body, 1.3), 0.5) }
}
PROP_FINISH.cabinet = { dust: 0.25, stain: 0.2 }

// ─ box: cardboard, taped, one flap lifted ─
PROP_ART.box = (c, rnd, v, spec) => {
  const { X, Y } = c
  const card = cmul(spec.c, [1, 1.12, 0.88][v])
  slab(c, 0, 0, 1, 0.86, card, { r: 1, streak: 0.2, seed: v * 3, grain: 0.1 })
  slab(c, 0, 0.84, 0.52, 1, cmul(card, 1.1), { r: 1, streak: 0.1 })
  slab(c, 0.5, 0.84, 1, 0.97 + v * 0.01, cmul(card, 0.92), { r: 1 })
  stroke(c, X(0.5), Y(0.86), X(0.5), Y(0.2), 3.2, [176, 156, 108], 0.85)
  stroke(c, X(0.5), Y(0.86), X(0.5), Y(0.86), 3.2, [176, 156, 108], 0)
  slab(c, 0.12, 0.2, 0.36, 0.34, cmul(card, 0.72), { r: 0.5, grain: 0.05 })
  stroke(c, X(0.6), Y(0.3), X(0.86), Y(0.3), 1.2, cmul(card, 0.6), 0.7)
  stroke(c, X(0.6), Y(0.24), X(0.8), Y(0.24), 1.2, cmul(card, 0.6), 0.7)
  if (v === 2) fillPoly(c.P, [X(0), Y(0.86), X(0.14), Y(0.86), X(0.02), Y(0.66)], flat(...cmul(card, 0.6)))    // a crushed corner
}
PROP_FINISH.box = { dust: 0.3, stain: 0.35 }

// ─ crate: planks, gaps, braces and nails ─
PROP_ART.crate = (c, rnd, v, spec) => {
  const { X, Y } = c
  const wood = cmul(spec.c, [1, 0.88, 1.12][v])
  slab(c, 0, 0, 1, 1, [22, 16, 10], { r: 1 })
  const n = 4
  for (let i = 0; i < n; i++) {
    const v0 = 0.02 + i * (0.96 / n), v1 = v0 + (0.96 / n) - 0.03
    slab(c, 0.03, v0, 0.97, v1, cmul(wood, 0.9 + rnd() * 0.24), { r: 0.6, streak: 0.4, seed: i * 5 + v, grain: 0.14 })
  }
  slab(c, 0.03, 0, 0.19, 1, cmul(wood, 0.82), { r: 0.6, streak: 0.3 }); slab(c, 0.81, 0, 0.97, 1, cmul(wood, 0.82), { r: 0.6, streak: 0.3 })
  stroke(c, X(0.15), Y(0.08), X(0.85), Y(0.92), 6, cmul(wood, 0.8), 0.95)
  for (const [u, vv] of [[0.11, 0.1], [0.11, 0.9], [0.89, 0.1], [0.89, 0.9], [0.3, 0.27], [0.7, 0.73]]) disc(c, X(u), Y(vv), 1, 1, [46, 40, 34])
  if (v === 1) slab(c, 0.34, 0.4, 0.66, 0.58, [150, 40, 30], { r: 0, grain: 0.2 })          // a stencilled mark
}
PROP_FINISH.crate = { dust: 0.3, stain: 0.25 }

// ─ cone: a scuffed traffic cone ─
PROP_ART.cone = (c, rnd, v, spec) => {
  const { X, Y } = c
  const or = [[206, 92, 32], [190, 84, 30], [214, 110, 40]][v]
  slab(c, 0.02, 0, 0.98, 0.07, [50, 46, 42], { r: 1 })
  fillPoly(c.P, [X(0.5), Y(0.98), X(0.62), Y(0.98), X(0.86), Y(0.07), X(0.14), Y(0.07), X(0.38), Y(0.98)], mat({ c: or, x0: X(0.14), x1: X(0.86), y0: Y(0.98), y1: Y(0.07), cyl: 0.45, kx: -0.3, grain: 0.09, streak: 0.2, seed: v }))
  const band = (v0, v1) => {
    const hw = (vv) => 0.12 + (1 - vv) * 0.36 - 0.03
    fillPoly(c.P, [X(0.5 - hw(v1)), Y(v1), X(0.5 + hw(v1)), Y(v1), X(0.5 + hw(v0)), Y(v0), X(0.5 - hw(v0)), Y(v0)], mat({ c: [232, 232, 226], x0: X(0.1), x1: X(0.9), y0: Y(v1), y1: Y(v0), cyl: 0.4, kx: -0.3, grain: 0.1 }))
  }
  band(0.44, 0.6); band(0.68, 0.78)
}
PROP_FINISH.cone = { dust: 0.4, stain: 0.2, ao: 0.2 }

// ─ papers: sheets scattered on the floor (a top-down decal) ─
PROP_ART.papers = (c, rnd, v, spec) => {
  // repainted on its own square canvas by PROP_DECAL below
}

// ─ plant: a potted plant ─
PROP_ART.plant = (c, rnd, v, spec) => {
  const { X, Y } = c
  const leaf = cmul(spec.c, [1, 0.8, 1.25][v])
  const potCol = [[120, 74, 52], [42, 42, 46], [96, 96, 92]][v]
  const n = 11 + ((rnd() * 5) | 0)
  for (let i = 0; i < n; i++) {
    const a = -Math.PI / 2 + (i / (n - 1) - 0.5) * 2.5 + (rnd() - 0.5) * 0.3
    const len = c.H(0.4 + rnd() * 0.42), wid = c.W(0.05 + rnd() * 0.03)
    const bx = X(0.5 + (rnd() - 0.5) * 0.08), by = Y(0.3)
    const tx = bx + Math.cos(a) * len, ty = by + Math.sin(a) * len + len * 0.08 * Math.abs(Math.cos(a))
    const mx = bx + Math.cos(a) * len * 0.55, my = by + Math.sin(a) * len * 0.55
    const dead = v === 2 && rnd() < 0.45
    const lc = dead ? [92, 76, 44] : cmul(leaf, 0.75 + rnd() * 0.5)
    const nx = -Math.sin(a) * wid, ny = Math.cos(a) * wid
    fillPoly(c.P, [bx, by, mx + nx, my + ny, tx, ty, mx - nx, my - ny], mat({ c: lc, x0: Math.min(bx, tx), x1: Math.max(bx, tx) + 1, y0: Math.min(ty, by), y1: by, kx: -0.3, ky: -0.1, grain: 0.14, seed: i }))
    stroke(c, bx, by, tx, ty, 0.9, cmul(lc, 0.6), 0.6)
  }
  fillPoly(c.P, [X(0.22), Y(0.3), X(0.78), Y(0.3), X(0.68), Y(0), X(0.32), Y(0)], mat({ c: potCol, x0: X(0.22), x1: X(0.78), y0: Y(0.3), y1: Y(0), cyl: 0.35, kx: -0.3, grain: 0.1 }))
  slab(c, 0.2, 0.27, 0.8, 0.32, cmul(potCol, 1.12), { r: 1 })
}
PROP_FINISH.plant = { dust: 0.15, stain: 0.1, outline: 0.7, ao: 0.15 }

// ─ pallet: one to three, stacked ─
PROP_ART.pallet = (c, rnd, v, spec) => {
  const { X, Y } = c
  const wood = cmul(spec.c, 0.95 + rnd() * 0.15)
  const tiers = 1 + (v % 3), th = 1 / tiers
  for (let t = 0; t < tiers; t++) {
    const v0 = t * th, v1 = v0 + th
    slab(c, 0, v1 - th * 0.22, 1, v1, cmul(wood, 0.95 + rnd() * 0.2), { r: 0.6, streak: 0.4, seed: t * 7 + v, grain: 0.16 })
    slab(c, 0, v0, 1, v0 + th * 0.2, cmul(wood, 0.8 + rnd() * 0.2), { r: 0.6, streak: 0.4, seed: t * 3 + 1, grain: 0.16 })
    for (const u of [0.02, 0.44, 0.9]) slab(c, u, v0 + th * 0.2, u + 0.09, v1 - th * 0.22, cmul(wood, 0.7), { r: 0.5, streak: 0.3 })
    for (let i = 0; i < 7; i++) stroke(c, X(rnd()), Y(v1 - th * 0.11), X(rnd()), Y(v1 - th * 0.11), 0.8, cmul(wood, 0.55), 0.6)
  }
}
PROP_FINISH.pallet = { dust: 0.4, stain: 0.35, ao: 0.4 }

// ─ barrel: a wooden barrel with iron hoops ─
PROP_ART.barrel = (c, rnd, v, spec) => {
  const { X, Y } = c
  const wood = cmul(spec.c, [1, 0.86, 1.15][v])
  const prof = (vv) => 0.42 + 0.08 * Math.sin(Math.PI * vv)          // bulge
  const pts = []
  for (let i = 0; i <= 12; i++) { const vv = i / 12; pts.push(X(0.5 - prof(vv)), Y(vv)) }
  for (let i = 12; i >= 0; i--) { const vv = i / 12; pts.push(X(0.5 + prof(vv)), Y(vv)) }
  fillPoly(c.P, pts, mat({ c: wood, x0: X(0.02), x1: X(0.98), y0: Y(1), y1: Y(0), cyl: 0.8, kx: -0.3, grain: 0.12, streak: 0.35, seed: v }))
  for (let i = 1; i < 7; i++) stroke(c, X(0.1 + i * 0.13), Y(0.02), X(0.1 + i * 0.13), Y(0.98), 0.8, cmul(wood, 0.55), 0.55)
  for (const vv of [0.12, 0.34, 0.66, 0.88]) {
    const hw = prof(vv) + 0.005
    fillBox(c.P, X(0.5 - hw), Y(vv + 0.028), X(0.5 + hw), Y(vv - 0.028), mat({ c: [70, 66, 62], x0: X(0.5 - hw), x1: X(0.5 + hw), y0: Y(vv + 0.03), y1: Y(vv - 0.03), cyl: 0.7, kx: -0.3, grain: 0.1 }), 0.5)
  }
  fillEll(c.P, X(0.5), Y(0.985), c.W(0.35), c.H(0.02), flat(...cmul(wood, 0.5)))
}
PROP_FINISH.barrel = { dust: 0.25, stain: 0.3 }

// ─ drum: a steel oil drum with rolled ribs, rust and peeled paint ─
PROP_ART.drum = (c, rnd, v, spec) => {
  const { X, Y } = c
  const paint = [[74, 84, 64], [116, 52, 40], [64, 82, 110]][v]
  fillBox(c.P, X(0.06), Y(0.97), X(0.94), Y(0.02), mat({ c: paint, x0: X(0.06), x1: X(0.94), y0: Y(0.97), y1: Y(0.02), cyl: 0.85, kx: -0.28, grain: 0.1, streak: 0.4, seed: v }), 2)
  slab(c, 0.05, 0.94, 0.95, 1, cmul(paint, 1.2), { r: 2, cyl: 0.8 })                    // the lid rim
  for (const vv of [0.2, 0.48, 0.75]) fillBox(c.P, X(0.055), Y(vv + 0.02), X(0.945), Y(vv - 0.02), mat({ c: cmul(paint, 0.78), x0: X(0.055), x1: X(0.945), y0: Y(vv + 0.02), y1: Y(vv - 0.02), cyl: 0.9, kx: -0.28 }), 0.5)
  disc(c, X(0.7), Y(0.985), c.W(0.05), c.H(0.018), [60, 60, 58])
  stainPaint(c.P, (x, y) => {                                                         // rust bloom + peeled paint
    const n = nz(x * 0.18 + v * 9, y * 0.11)
    if (n > 0.6) { SR = 128; SG = 66; SB = 34; SA = Math.min(0.85, (n - 0.6) * 5) }
  })
}
PROP_FINISH.drum = { dust: 0.2, stain: 0.5 }

// ─ couch: a sagging three-seat sofa ─
PROP_ART.couch = (c, rnd, v, spec) => {
  const { X, Y } = c
  const fab = cmul(spec.c, [1, 1.15, 0.85][v])
  for (const u of [0.05, 0.9]) slab(c, u, 0, u + 0.05, 0.1, [30, 26, 22], { r: 0.5 })
  slab(c, 0.06, 0.08, 0.94, 0.62, cmul(fab, 0.85), { r: 2, streak: 0.3, seed: v })                 // back
  for (let i = 0; i < 3; i++) slab(c, 0.17 + i * 0.22, 0.4, 0.37 + i * 0.22, 0.85, cmul(fab, 1.02), { r: 3, streak: 0.25, seed: i + 3 * v, grain: 0.14 })
  for (let i = 0; i < 3; i++) slab(c, 0.17 + i * 0.22, 0.1, 0.37 + i * 0.22, 0.42, fab, { r: 3, streak: 0.2, seed: i + 8 })
  slab(c, 0, 0.06, 0.17, 0.72, cmul(fab, 1.08), { r: 4, streak: 0.25, seed: 20 })
  slab(c, 0.83, 0.06, 1, 0.72, cmul(fab, 0.92), { r: 4, streak: 0.25, seed: 21 })
  stroke(c, X(0.17), Y(0.42), X(0.83), Y(0.42), 1, cmul(fab, 0.5), 0.6)
}
PROP_FINISH.couch = { dust: 0.2, stain: 0.45 }

// ─ cart: a shopping cart — a wire basket you can see through ─
PROP_ART.cart = (c, rnd, v, spec) => {
  const { X, Y } = c
  const wire = [172, 172, 178]
  const g = 2.1
  for (const u of [0.08, 0.92]) stroke(c, X(u), Y(0.7), X(u), Y(0.16), g, wire)
  stroke(c, X(0.08), Y(0.7), X(0.92), Y(0.7), g, wire)
  stroke(c, X(0.14), Y(0.16), X(0.86), Y(0.16), g, wire)
  for (let i = 1; i < 6; i++) stroke(c, X(0.08 + i * 0.14), Y(0.68), X(0.16 + i * 0.12), Y(0.17), 0.9, wire, 0.85)
  for (let i = 1; i < 4; i++) stroke(c, X(0.1), Y(0.7 - i * 0.14), X(0.9), Y(0.7 - i * 0.14), 0.9, wire, 0.85)
  stroke(c, X(0.05), Y(0.94), X(0.95), Y(0.94), 3, [56, 56, 60])                   // the handle
  stroke(c, X(0.08), Y(0.94), X(0.08), Y(0.7), g, wire); stroke(c, X(0.92), Y(0.94), X(0.92), Y(0.7), g, wire)
  stroke(c, X(0.18), Y(0.16), X(0.18), Y(0.06), g, wire); stroke(c, X(0.82), Y(0.16), X(0.82), Y(0.06), g, wire)
  for (const u of [0.18, 0.82]) disc(c, X(u), Y(0.035), c.W(0.055), c.W(0.055), [24, 24, 26])
}
PROP_FINISH.cart = { outline: 1, dust: 0.1, stain: 0, ao: 0.1 }

// ─ pipe: a floor-to-ceiling pipe with flanges, a bracket, rust and a drip stain ─
PROP_ART.pipe = (c, rnd, v, spec) => {
  const { X, Y } = c
  const base = [[104, 90, 68], [88, 96, 92], [118, 92, 62]][v]
  fillBox(c.P, X(0.22), Y(1), X(0.78), Y(0), mat({ c: base, x0: X(0.22), x1: X(0.78), y0: Y(1), y1: Y(0), cyl: 0.95, kx: -0.3, grain: 0.1, streak: 0.5, seed: v }), 0)
  for (const vv of [0.18, 0.55, 0.9]) {
    fillBox(c.P, X(0.1), Y(vv + 0.02), X(0.9), Y(vv - 0.02), mat({ c: cmul(base, 1.1), x0: X(0.1), x1: X(0.9), y0: Y(vv + 0.02), y1: Y(vv - 0.02), cyl: 0.8, kx: -0.3 }), 0.5)
    for (const u of [0.16, 0.84]) disc(c, X(u), Y(vv), 1, 1, [40, 36, 30])
  }
  slab(c, 0.05, 0.36, 0.95, 0.4, [50, 48, 46], { r: 0 })                                // a bracket
  slab(c, 0.05, 0.31, 0.11, 0.44, [50, 48, 46], { r: 0 })
  for (let i = 0; i < 3; i++) slab(c, 0.22, 0.62 + i * 0.05, 0.78, 0.66 + i * 0.05, [172, 168, 150], { r: 0, grain: 0.15 })   // wrapped insulation
  stainPaint(c.P, (x, y) => { const n = nz(x * 0.4 + v * 5, y * 0.03); if (n > 0.55) { SR = 120; SG = 62; SB = 30; SA = Math.min(0.8, (n - 0.55) * 4) } })
}
PROP_FINISH.pipe = { dust: 0.15, stain: 0.35, outline: 0.7, ao: 0.2 }

// ─ valve: a standpipe with a big handwheel and a gauge ─
PROP_ART.valve = (c, rnd, v, spec) => {
  const { X, Y } = c
  const brass = [[126, 104, 62], [106, 108, 100], [128, 96, 60]][v]
  fillBox(c.P, X(0.4), Y(0.66), X(0.6), Y(0), mat({ c: cmul(brass, 0.9), x0: X(0.4), x1: X(0.6), y0: Y(0.66), y1: Y(0), cyl: 0.9, kx: -0.3 }), 0)
  slab(c, 0.28, 0, 0.72, 0.06, cmul(brass, 0.8), { r: 1 })
  fillBox(c.P, X(0.18), Y(0.5), X(0.82), Y(0.4), mat({ c: brass, x0: X(0.18), x1: X(0.82), y0: Y(0.5), y1: Y(0.4), cyl: 0.7, kx: -0.3 }), 2)
  stroke(c, X(0.5), Y(0.5), X(0.5), Y(0.72), 3, [80, 76, 70])
  disc(c, X(0.5), Y(0.76), c.W(0.44), c.H(0.13), [176, 42, 34], { cyl: 0.3 })
  disc(c, X(0.5), Y(0.76), c.W(0.34), c.H(0.095), [0, 0, 0])
  // the wheel is a ring: knock the middle back out
  const P = c.P
  for (let i = 0; i < 4; i++) { const a = (i / 4) * Math.PI; stroke(c, X(0.5) - Math.cos(a) * c.W(0.4), Y(0.76) - Math.sin(a) * c.H(0.11), X(0.5) + Math.cos(a) * c.W(0.4), Y(0.76) + Math.sin(a) * c.H(0.11), 2, [176, 42, 34]) }
  disc(c, X(0.5), Y(0.76), c.W(0.05), c.H(0.02), [214, 96, 70])
  void P
  disc(c, X(0.76), Y(0.3), c.W(0.11), c.W(0.11), [206, 202, 190]); disc(c, X(0.76), Y(0.3), c.W(0.08), c.W(0.08), [36, 36, 34])
  stroke(c, X(0.76), Y(0.3), X(0.79), Y(0.33), 0.9, [230, 200, 60])
}
PROP_FINISH.valve = { dust: 0.2, stain: 0.3 }

// ─ vent: a duct housing with a louvred grille ─
PROP_ART.vent = (c, rnd, v, spec) => {
  const { X, Y } = c
  const steel = cmul(spec.c, [1, 1.15, 0.85][v])
  slab(c, 0, 0, 1, 1, steel, { r: 2, streak: 0.25, seed: v })
  slab(c, 0.08, 0.1, 0.92, 0.9, [16, 15, 14], { r: 1 })
  for (let i = 0; i < 9; i++) {
    const vv = 0.14 + i * 0.085
    slab(c, 0.1, vv, 0.9, vv + 0.055, cmul(steel, 0.95 - (i & 1) * 0.15), { r: 0, streak: 0.1 })
    stroke(c, X(0.1), Y(vv), X(0.9), Y(vv), 1, [8, 8, 8], 0.9)
  }
  for (const [u, vv] of [[0.04, 0.05], [0.96, 0.05], [0.04, 0.95], [0.96, 0.95]]) disc(c, X(u), Y(vv), 1.3, 1.3, [40, 38, 34])
  stainPaint(c.P, (x, y) => { const n = nz(x * 0.3 + v * 5, y * 0.05); if (n > 0.58) { SR = 110; SG = 60; SB = 30; SA = Math.min(0.7, (n - 0.58) * 4) } })
}
PROP_FINISH.vent = { dust: 0.25, stain: 0.3 }

// ─ toolbox: a red metal toolbox with a latch ─
PROP_ART.toolbox = (c, rnd, v, spec) => {
  const { X, Y } = c
  const red = [[164, 52, 38], [56, 92, 130], [176, 128, 40]][v]
  stroke(c, X(0.3), Y(0.86), X(0.7), Y(0.86), 3, [70, 70, 72]); stroke(c, X(0.3), Y(0.86), X(0.28), Y(0.62), 2.6, [70, 70, 72]); stroke(c, X(0.7), Y(0.86), X(0.72), Y(0.62), 2.6, [70, 70, 72])
  slab(c, 0, 0, 1, 0.66, red, { r: 2, streak: 0.2, seed: v })
  slab(c, 0.01, 0.5, 0.99, 0.56, cmul(red, 0.7), { r: 0 })
  slab(c, 0.42, 0.44, 0.58, 0.6, [188, 186, 176], { r: 1 })
  for (const u of [0.05, 0.95]) disc(c, X(u), Y(0.1), 1.3, 1.3, [40, 38, 36])
  stainPaint(c.P, (x, y) => { const n = nz(x * 0.35 + 5, y * 0.3 + v); if (n > 0.62) { SR = 200; SG = 196; SB = 184; SA = Math.min(0.55, (n - 0.62) * 4) } })   // worn-through paint
}
PROP_FINISH.toolbox = { dust: 0.3, stain: 0.2 }

// ─ transformer: a grey pad-mount transformer with cooling fins and porcelain insulators ─
PROP_ART.transformer = (c, rnd, v, spec) => {
  const { X, Y } = c
  const gray = cmul(spec.c, [1, 1.12, 0.9][v])
  for (const u of [0.22, 0.5, 0.78]) {
    slab(c, u - 0.05, 0.86, u + 0.05, 0.96, [176, 164, 140], { r: 2, cyl: 0.6 })
    slab(c, u - 0.025, 0.94, u + 0.025, 1, [168, 156, 132], { r: 1, cyl: 0.6 })
    for (let i = 0; i < 3; i++) slab(c, u - 0.06, 0.875 + i * 0.03, u + 0.06, 0.89 + i * 0.03, [186, 174, 150], { r: 1 })
  }
  slab(c, 0.04, 0.0, 0.96, 0.86, gray, { r: 2, streak: 0.25, seed: v })
  slab(c, 0, 0.78, 1, 0.86, cmul(gray, 1.1), { r: 2 })
  for (const [u0, u1] of [[0.05, 0.4], [0.6, 0.95]]) {
    slab(c, u0, 0.1, u1, 0.72, cmul(gray, 0.62), { r: 1 })
    const n = 11
    for (let i = 0; i < n; i++) { const x0 = u0 + (i + 0.15) * (u1 - u0) / n; slab(c, x0, 0.12, x0 + (u1 - u0) / n * 0.58, 0.7, cmul(gray, 0.9 + (i & 1) * 0.12), { r: 0.5 }) }
  }
  slab(c, 0.41, 0.3, 0.59, 0.56, [206, 172, 44], { r: 1, grain: 0.1 })
  fillPoly(c.P, [X(0.5), Y(0.53), X(0.44), Y(0.34), X(0.56), Y(0.34)], flat(30, 26, 20))
  stroke(c, X(0.5), Y(0.49), X(0.5), Y(0.41), 1.6, [206, 172, 44])
  slab(c, 0.04, 0, 0.96, 0.04, [40, 40, 42], { r: 0 })
}
PROP_FINISH.transformer = { dust: 0.2, stain: 0.35 }

// ─ cabinet-e: an electrical cabinet, double doors, a warning label, dim status lights ─
PROP_ART['cabinet-e'] = (c, rnd, v, spec) => {
  const { X, Y } = c
  const steel = cmul(spec.c, [1, 1.12, 0.88][v])
  slab(c, 0, 0, 1, 1, steel, { r: 2, streak: 0.22, seed: v })
  slab(c, 0.05, 0.05, 0.48, 0.93, cmul(steel, 1.06), { r: 1, streak: 0.18, seed: 2 }); slab(c, 0.52, 0.05, 0.95, 0.93, cmul(steel, 0.98), { r: 1, streak: 0.18, seed: 3 })
  for (let i = 0; i < 7; i++) { const vv = 0.78 + i * 0.02; stroke(c, X(0.1), Y(vv), X(0.42), Y(vv), 1, [20, 20, 22], 0.85) }
  fillPoly(c.P, [X(0.27), Y(0.68), X(0.35), Y(0.52), X(0.19), Y(0.52)], flat(212, 176, 40))
  fillPoly(c.P, [X(0.27), Y(0.64), X(0.31), Y(0.545), X(0.23), Y(0.545)], flat(34, 30, 22))
  slab(c, 0.62, 0.44, 0.86, 0.6, [214, 208, 190], { r: 0.5, grain: 0.1 })
  for (let i = 0; i < 3; i++) stroke(c, X(0.65), Y(0.575 - i * 0.04), X(0.83), Y(0.575 - i * 0.04), 0.9, [70, 66, 60], 0.7)
  slab(c, 0.44, 0.44, 0.56, 0.5, [70, 66, 62], { r: 1 })
  disc(c, X(0.5), Y(0.4), 1.6, 1.6, [50, 50, 54])
  stroke(c, X(0.5), Y(1), X(0.5), Y(1), 1, [0, 0, 0], 0)
}
PROP_FINISH['cabinet-e'] = { dust: 0.2, stain: 0.3 }

// ─ spool: a cable reel — the round face, or on its rim ─
PROP_ART.spool = (c, rnd, v, spec) => {
  const { X, Y } = c
  const wood = cmul(spec.c, [1, 0.88, 1.12][v])
  if (v !== 1) {
    disc(c, X(0.5), Y(0.5), c.W(0.5), c.H(0.5), wood, { cyl: 0.25, grain: 0.14 })
    disc(c, X(0.5), Y(0.5), c.W(0.38), c.H(0.38), [32, 30, 30], { grain: 0.1 })
    for (let i = 0; i < 6; i++) stroke(c, X(0.5) + Math.cos(i * 1.047) * c.W(0.1), Y(0.5) + Math.sin(i * 1.047) * c.H(0.1), X(0.5) + Math.cos(i * 1.047) * c.W(0.46), Y(0.5) + Math.sin(i * 1.047) * c.H(0.46), 1.2, cmul(wood, 0.6), 0.7)
    disc(c, X(0.5), Y(0.5), c.W(0.1), c.H(0.1), [10, 10, 10])
    disc(c, X(0.5), Y(0.5), c.W(0.22), c.H(0.22), cmul(wood, 0.85), { cyl: 0.2 })
    disc(c, X(0.5), Y(0.5), c.W(0.08), c.H(0.08), [8, 8, 8])
  } else {
    slab(c, 0, 0, 0.14, 1, wood, { r: 1, streak: 0.4, grain: 0.14 }); slab(c, 0.86, 0, 1, 1, cmul(wood, 0.85), { r: 1, streak: 0.4, grain: 0.14 })
    slab(c, 0.14, 0.12, 0.86, 0.88, [26, 26, 28], { r: 0 })
    for (let i = 0; i < 9; i++) stroke(c, X(0.14), Y(0.16 + i * 0.08), X(0.86), Y(0.16 + i * 0.08), 1.1, [60, 60, 66], 0.8)
    stroke(c, X(0.14), Y(0.5), X(0.86), Y(0.5), 2, [156, 60, 40], 0.9)
  }
}
PROP_FINISH.spool = { dust: 0.3, stain: 0.3 }

// ─ sign: a yellow caution A-frame ─
PROP_ART.sign = (c, rnd, v, spec) => {
  const { X, Y } = c
  const yel = [[214, 176, 40], [204, 150, 36], [220, 190, 60]][v]
  stroke(c, X(0.18), Y(0), X(0.34), Y(0.5), 3, [60, 60, 62]); stroke(c, X(0.82), Y(0), X(0.66), Y(0.5), 3, [60, 60, 62])
  fillPoly(c.P, [X(0.5), Y(1), X(0.9), Y(0.14), X(0.1), Y(0.14)], mat({ c: yel, x0: X(0.1), x1: X(0.9), y0: Y(1), y1: Y(0.14), kx: -0.2, grain: 0.1, streak: 0.2, seed: v }))
  fillPoly(c.P, [X(0.5), Y(0.86), X(0.78), Y(0.22), X(0.22), Y(0.22)], flat(...cmul(yel, 0.94)))
  slab(c, 0.46, 0.4, 0.54, 0.68, [28, 24, 18], { r: 1 })
  disc(c, X(0.5), Y(0.3), 2.2, 2.2, [28, 24, 18])
  slab(c, 0.1, 0.04, 0.9, 0.16, cmul(yel, 0.9), { r: 1 })
}
PROP_FINISH.sign = { dust: 0.25, stain: 0.3 }

// ─ trash (level ∅): slumped black bags, a split one, loose litter ─
PROP_ART.trash = (c, rnd, v, spec) => {
  const { X, Y } = c
  const bags = [[0.3, 0.3, 0.26, 0.29], [0.64, 0.27, 0.28, 0.3], [0.47, 0.5, 0.19, 0.19]]
  const plastic = [[42, 42, 46], [32, 34, 38], [50, 49, 50]]     // cool grey-black: no brown, no orange
  bags.forEach(([cx, cy, rx, ry], i) => {
    const col = plastic[(i + v) % 3]
    fillEll(c.P, X(cx), Y(cy), c.W(rx), c.H(ry), mat({ c: col, x0: X(cx - rx), x1: X(cx + rx), y0: Y(cy + ry), y1: Y(cy - ry), cyl: 0.7, kx: -0.35, ky: -0.25, grain: 0.12 }))
    // a glossy highlight where light slides over the plastic, and a crumpled fold: bags, not animals
    fillEll(c.P, X(cx - rx * 0.35), Y(cy + ry * 0.4), c.W(rx * 0.3), c.H(ry * 0.14), flat(120, 122, 130, 0.5))
    stroke(c, X(cx + rx * 0.2), Y(cy + ry * 0.7), X(cx + rx * 0.45), Y(cy - ry * 0.2), 1, cmul(col, 1.7), 0.55)
    // the gathered neck and the two tied ears at the top, leaning each its own way
    const lean = ((i + v) % 2 ? 1 : -1) * 0.03
    fillPoly(c.P, [X(cx - 0.05), Y(cy + ry * 0.85), X(cx - 0.09 + lean), Y(cy + ry * 1.42), X(cx - 0.01), Y(cy + ry * 1.08), X(cx + 0.02 + lean), Y(cy + ry * 1.5), X(cx + 0.06), Y(cy + ry * 0.85)], flat(...col))
  })
  // spilled litter, flat and pale, kept off the bags' feet: paper and cartons in muted greys and greens (no warm glints)
  for (let i = 0; i < 6; i++) {
    const x = X(0.04 + rnd() * 0.92), y = Y(0.01 + rnd() * 0.05)
    const kind = (rnd() * 3) | 0
    const litter = [[120, 122, 124], [150, 150, 146], [82, 104, 90]][kind]
    fillBox(c.P, x - 2, y - 1, x + 2 + rnd() * 3, y + 1, flat(...cmul(litter, 0.7 + rnd() * 0.3)), 0.45)
  }
}
PROP_FINISH.trash = { dust: 0.2, stain: 0.2, outline: 0.75, ao: 0.4, dustCol: [150, 140, 122] }

// ─ tire (level ∅): standing, leaning, or lying flat ─
PROP_ART.tire = (c, rnd, v, spec) => {
  const { X, Y } = c
  if (v === 2) {                         // lying flat: a squat torus
    fillEll(c.P, X(0.5), Y(0.5), c.W(0.5), c.H(0.5), mat({ c: [30, 30, 30], x0: X(0), x1: X(1), y0: Y(1), y1: Y(0), cyl: 0.6, kx: -0.3, grain: 0.14 }))
    fillEll(c.P, X(0.5), Y(0.62), c.W(0.24), c.H(0.2), flat(14, 14, 14))
    fillEll(c.P, X(0.5), Y(0.7), c.W(0.3), c.H(0.06), flat(48, 46, 44, 0.5))
    return
  }
  const sq = v === 1 ? 0.8 : 1
  fillEll(c.P, X(0.5), Y(0.5), c.W(0.5 * sq), c.H(0.5), mat({ c: [34, 34, 34], x0: X(0), x1: X(1), y0: Y(1), y1: Y(0), cyl: 0.5, kx: -0.3, grain: 0.14, streak: 0.2 }))
  for (let i = 0; i < 40; i++) {                                    // tread blocks around the rim
    const a = (i / 40) * Math.PI * 2
    stroke(c, X(0.5) + Math.cos(a) * c.W(0.47 * sq), Y(0.5) + Math.sin(a) * c.H(0.47), X(0.5) + Math.cos(a) * c.W(0.5 * sq), Y(0.5) + Math.sin(a) * c.H(0.5), 1.5, [12, 12, 12], 0.85)
  }
  fillEll(c.P, X(0.5), Y(0.5), c.W(0.32 * sq), c.H(0.32), mat({ c: [46, 46, 46], x0: X(0.18), x1: X(0.82), y0: Y(0.82), y1: Y(0.18), cyl: 0.4, kx: -0.3, grain: 0.1 }))
  for (const r of [0.28, 0.24]) fillEll(c.P, X(0.5), Y(0.5), c.W(r * sq), c.H(r), flat(58, 56, 54, 0.32))
  // the rim hole: see-through (paint it back to nothing by overpainting with erase)
  const P = c.P, cx = X(0.5), cy = Y(0.5), rx = c.W(0.15 * sq), ry = c.H(0.15)
  for (let y = Math.floor(cy - ry - 1); y <= Math.ceil(cy + ry + 1); y++) for (let x = Math.floor(cx - rx - 1); x <= Math.ceil(cx + rx + 1); x++) {
    const d = hyp((x + 0.5 - cx) / rx, (y + 0.5 - cy) / ry)
    if (d < 1) { const k = Math.min(1, (1 - d) * Math.min(rx, ry) * 1.6); const j = (y * P.w + x) * 4; P.px[j] *= 1 - k; P.px[j + 1] *= 1 - k; P.px[j + 2] *= 1 - k; P.px[j + 3] *= 1 - k }
  }
  disc(c, X(0.5), Y(0.5), c.W(0.13 * sq), c.H(0.13), [70, 62, 52], { cyl: 0.2 })
  fillEll(c.P, X(0.5), Y(0.5), c.W(0.08 * sq), c.H(0.08), flat(18, 18, 18))
}
PROP_FINISH.tire = { dust: 0.5, stain: 0.15, outline: 0.7, dustCol: [130, 122, 108] }

// ─ weeds (level ∅): a tuft of weeds and dry grass in a crack ─
PROP_ART.weeds = (c, rnd, v, spec) => {
  const { X, Y } = c
  const greens = [[84, 92, 58], [112, 104, 66], [76, 88, 62], [122, 110, 74]]
  const n = 34
  const blades = []
  for (let i = 0; i < n; i++) blades.push([0.5 + (rnd() - 0.5) * 0.5, rnd(), i])
  blades.sort((a, b) => a[1] - b[1])
  for (const [bx, r, i] of blades) {
    const h = 0.4 + r * 0.55, lean = (bx - 0.5) * 1.2 + (rnd() - 0.5) * 0.3
    const col = cmul(greens[(i + v) % 4], 0.62 + rnd() * 0.42)
    const x0 = X(bx), y0 = Y(0.02), x1 = X(bx + lean * h * 0.55), y1 = Y(h)
    const mx = X(bx + lean * h * 0.15), my = Y(h * 0.55)
    fillSeg(c.P, x0, y0, mx, my, 1.5, 1.1, flat(...col)); fillSeg(c.P, mx, my, x1, y1, 1.1, 0.3, flat(...cmul(col, 1.08)))
    if (i % 7 === 0) fillEll(c.P, x1, y1 - 1, 1.6, 3.2, flat(...cmul(col, 0.7)))          // a seed head
  }
  for (let i = 0; i < 5; i++) {                                                             // broad-leaved weeds low down
    const a = -Math.PI / 2 + (rnd() - 0.5) * 2.2, len = c.H(0.18 + rnd() * 0.16)
    const bx = X(0.5 + (rnd() - 0.5) * 0.3), by = Y(0.03)
    fillPoly(c.P, [bx, by, bx + Math.cos(a) * len * 0.5 - 2, by + Math.sin(a) * len * 0.5, bx + Math.cos(a) * len, by + Math.sin(a) * len, bx + Math.cos(a) * len * 0.5 + 2, by + Math.sin(a) * len * 0.5], flat(...cmul(greens[i % 4], 0.85)))
  }
  fillEll(c.P, X(0.5), Y(0.02), c.W(0.4), c.H(0.045), flat(72, 64, 52, 0.85))                // dirt and gravel at the root
}
PROP_FINISH.weeds = { dust: 0.1, stain: 0, outline: 1, ao: 0.1 }

// papers: a floor decal painted top-down on a square canvas; the layer is flagged `floor` so it is foreshortened by the view
function papersFrame(v) {
  const N = 64
  const P = createPaint(N, N)
  const rnd = mulberry32(seedOf('papers', v))
  const sheets = 5 + ((rnd() * 4) | 0)
  for (let i = 0; i < sheets; i++) {
    const cx = N / 2 + (rnd() - 0.5) * N * 0.6, cy = N / 2 + (rnd() - 0.5) * N * 0.6
    const a = rnd() * Math.PI, hw = N * 0.16, hh = N * 0.21
    const ca = Math.cos(a), sa = Math.sin(a)
    const tone = 0.82 + rnd() * 0.2
    const corner = (sx, sy) => [cx + ca * sx * hw - sa * sy * hh, cy + sa * sx * hw + ca * sy * hh]
    const [p0, p1, p2, p3] = [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)]
    fillPoly(P, [p0[0], p0[1], p1[0], p1[1], p2[0], p2[1], p3[0], p3[1]], mat({ c: [226 * tone, 220 * tone, 200 * tone], x0: cx - hw, x1: cx + hw, y0: cy - hh, y1: cy + hh, kx: -0.1, ky: -0.1, grain: 0.1, seed: i }))
    for (let l = -0.6; l <= 0.7; l += 0.28) {                         // typed lines
      const [a0, a1] = [corner(-0.7, l), corner(0.7, l)]
      fillSeg(P, a0[0], a0[1], a1[0], a1[1], 0.4, 0.4, flat(70, 66, 60, 0.5))
    }
  }
  const layer = packLayer(P, -0.19, 0.19, -0.19, 0.19, { floor: true })
  return makeFrame([layer])
}

function propFrame(name, v) {
  if (name === 'papers') return papersFrame(v)
  const spec = PROP_SPEC[name] || PROP_SPEC.box
  const art = PROP_ART[name] || PROP_ART.box
  const c = propCanvas(spec)
  const rnd = mulberry32(seedOf(name, v, 1))
  art(c, rnd, v, spec)
  finishProp(c, { seed: v * 13 + strHash(name) % 17, ...(PROP_FINISH[name] || {}) })
  const layers = [propLayer(c)]
  return makeFrame(layers)
}
registerGenerator('prop', (name, v) => propFrame(name, v))
// @@PROPS-END@@
// @@ITEMS-BEGIN@@
// ── items, notes, the vending machine, the exit ──
// Pickups: a soft coloured halo (screen, self-lit, pulses), the object (over, partly self-lit so its pale core reads in the
// dark), and a small hot core. All three stand on the floor; the caller lifts them by a little bobbing.
const PPU_ITEM = 320
const ITEM_BOX = { w: 0.17, h: 0.23 }

function itemCanvas() {
  const bw = Math.round(ITEM_BOX.w * PPU_ITEM), bh = Math.round(ITEM_BOX.h * PPU_ITEM)
  const padX = 6, padT = 6, padB = 4
  const fw = bw + padX * 2, fh = bh + padT + padB, floor = fh - padB
  return {
    P: createPaint(fw, fh), fw, fh, bw, bh, padX, floor,
    X: (u) => padX + u * bw, Y: (v) => floor - v * bh, W: (u) => u * bw, H: (v) => v * bh,
    rect: [-(fw / 2) / PPU_ITEM, (fw / 2) / PPU_ITEM, -padB / PPU_ITEM, (fh - padB) / PPU_ITEM],
  }
}

const ITEM_ART = {}
ITEM_ART.glowstick = (c, rnd) => {
  const { X, Y } = c
  const g = ITEM_COLORS.glowstick
  // a plastic tube, cracked and lit from inside, leaning
  const ax = X(0.36), ay = Y(0.04), bx = X(0.64), by = Y(0.96)
  fillSeg(c.P, ax, ay, bx, by, c.W(0.15), c.W(0.15), flat(g[0] * 0.7, g[1] * 0.85, g[2] * 0.6))
  fillSeg(c.P, ax + 1, ay, bx + 1, by, c.W(0.09), c.W(0.09), flat(g[0], 255, g[2] * 1.1))
  fillSeg(c.P, ax + 1.5, ay - 3, bx + 1.5, by + 3, c.W(0.035), c.W(0.035), flat(235, 255, 225))
  fillSeg(c.P, bx, by, bx, by, c.W(0.14), c.W(0.14), flat(40, 60, 34))
  return { emit: 0.85 }
}
ITEM_ART['almond-water'] = (c, rnd) => {
  const { X, Y } = c
  // a small pale plastic bottle, label band, cap
  const body = [176, 208, 226]
  fillPoly(c.P, [X(0.3), Y(0.68), X(0.7), Y(0.68), X(0.78), Y(0.55), X(0.78), Y(0.03), X(0.22), Y(0.03), X(0.22), Y(0.55)], mat({ c: body, x0: X(0.22), x1: X(0.78), y0: Y(0.68), y1: Y(0.03), cyl: 0.55, kx: -0.3, grain: 0.05 }))
  fillBox(c.P, X(0.36), Y(0.86), X(0.64), Y(0.66), mat({ c: [214, 232, 240], x0: X(0.36), x1: X(0.64), y0: Y(0.86), y1: Y(0.66), cyl: 0.5 }), 1)
  fillBox(c.P, X(0.33), Y(1), X(0.67), Y(0.86), mat({ c: [232, 236, 238], x0: X(0.33), x1: X(0.67), y0: Y(1), y1: Y(0.86), cyl: 0.5 }), 1.5)
  fillBox(c.P, X(0.22), Y(0.44), X(0.78), Y(0.24), flat(238, 230, 205), 0)
  for (let i = 0; i < 3; i++) fillBox(c.P, X(0.3), Y(0.4 - i * 0.05), X(0.7 - i * 0.1), Y(0.38 - i * 0.05), flat(120, 100, 70, 0.7), 0)
  fillEll(c.P, X(0.34), Y(0.5), c.W(0.05), c.H(0.11), flat(255, 255, 255, 0.55))
  return { emit: 0.4 }
}
ITEM_ART.bandage = (c) => {
  const { X, Y } = c
  // a white first-aid tin with a red cross
  fillBox(c.P, X(0.1), Y(0.8), X(0.9), Y(0.02), mat({ c: [232, 232, 236], x0: X(0.1), x1: X(0.9), y0: Y(0.8), y1: Y(0.02), kx: -0.3, ky: -0.15, grain: 0.05 }), 3)
  fillBox(c.P, X(0.1), Y(0.8), X(0.9), Y(0.72), flat(206, 206, 212), 2)
  fillBox(c.P, X(0.4), Y(0.62), X(0.6), Y(0.14), flat(190, 42, 38), 0)
  fillBox(c.P, X(0.2), Y(0.46), X(0.8), Y(0.3), flat(190, 42, 38), 0)
  fillBox(c.P, X(0.44), Y(0.98), X(0.56), Y(0.8), flat(180, 180, 186), 1)
  return { emit: 0.4 }
}
ITEM_ART.polaroid = (c) => {
  const { X, Y } = c
  const cream = ITEM_COLORS.polaroid
  fillBox(c.P, X(0.06), Y(0.8), X(0.94), Y(0.06), mat({ c: cream, x0: X(0.06), x1: X(0.94), y0: Y(0.8), y1: Y(0.06), kx: -0.3, ky: -0.2, grain: 0.05 }), 3.5)
  fillBox(c.P, X(0.06), Y(0.8), X(0.94), Y(0.64), flat(66, 64, 60), 3)
  fillBox(c.P, X(0.06), Y(0.32), X(0.94), Y(0.06), flat(214, 200, 176), 3)
  disc(c, X(0.5), Y(0.42), c.W(0.3), c.W(0.3), [44, 44, 52], { cyl: 0.4 })
  disc(c, X(0.5), Y(0.42), c.W(0.2), c.W(0.2), [16, 18, 26], { cyl: 0.3 })
  disc(c, X(0.42), Y(0.5), c.W(0.05), c.W(0.05), [170, 190, 220])
  fillBox(c.P, X(0.72), Y(0.74), X(0.88), Y(0.68), flat(230, 226, 208), 1)
  fillBox(c.P, X(0.14), Y(0.9), X(0.3), Y(0.8), flat(60, 58, 54), 1)
  for (let i = 0; i < 4; i++) fillBox(c.P, X(0.08 + i * 0.02), Y(0.28 - i * 0.03), X(0.15 + i * 0.02), Y(0.27 - i * 0.03), flat([210, 60, 50][0], [60, 150, 70][i % 2] + 40, 60, 0.9), 0)
  return { emit: 0.4 }
}
ITEM_ART.radio = (c) => {
  const { X, Y } = c
  const body = ITEM_COLORS.radio
  fillSeg(c.P, X(0.78), Y(0.68), X(0.96), Y(1), 1.2, 0.8, flat(206, 206, 196))
  fillBox(c.P, X(0.34), Y(0.86), X(0.66), Y(0.68), flat(52, 46, 40), 3)
  fillBox(c.P, X(0.05), Y(0.72), X(0.95), Y(0.03), mat({ c: body, x0: X(0.05), x1: X(0.95), y0: Y(0.72), y1: Y(0.03), kx: -0.3, ky: -0.2, grain: 0.07, streak: 0.15 }), 3)
  fillBox(c.P, X(0.1), Y(0.62), X(0.5), Y(0.12), flat(50, 34, 24), 1.5)
  for (let i = 0; i < 6; i++) fillBox(c.P, X(0.13), Y(0.57 - i * 0.075), X(0.47), Y(0.555 - i * 0.075), flat(120, 84, 56, 0.85), 0)
  disc(c, X(0.72), Y(0.5), c.W(0.14), c.W(0.14), [220, 214, 196], { cyl: 0.3 })
  disc(c, X(0.72), Y(0.5), c.W(0.05), c.W(0.05), [60, 56, 50])
  fillBox(c.P, X(0.58), Y(0.66), X(0.9), Y(0.6), flat(226, 220, 190), 1)
  fillBox(c.P, X(0.7), Y(0.66), X(0.72), Y(0.6), flat(190, 60, 44), 0)
  return { emit: 0.35 }
}

function itemFrame(name) {
  const c = itemCanvas()
  const rnd = mulberry32(seedOf('item-' + name))
  const info = (ITEM_ART[name] || ITEM_ART.radio)(c, rnd) || {}
  finishProp(c, { seed: strHash(name) % 23, dust: 0.08, stain: 0, ao: 0.2, outline: 0.75 })
  const col = ITEM_COLORS[name] || [220, 220, 220]
  // halo: a soft pool of the item's own colour, wider than the object
  const Hn = 56, H = createPaint(Hn, Hn)
  glowEll(H, Hn / 2, Hn / 2, Hn / 2, Hn / 2, col[0], col[1], col[2], 0.62, 1.7)
  const halo = packLayer(H, -0.24, 0.24, -0.09, 0.39, { mode: 1, emit: 1, fogK: 0.6 })
  const body = packLayer(c.P, c.rect[0], c.rect[1], c.rect[2], c.rect[3], { emit: info.emit ?? 0.4, fogK: 1 })
  // a pale hot core, kept from the old art: a small bright bloom where the item is brightest
  const Cn = 24, C = createPaint(Cn, Cn)
  glowEll(C, Cn / 2, Cn / 2, Cn / 2, Cn / 2, Math.min(255, col[0] + 60), Math.min(255, col[1] + 60), Math.min(255, col[2] + 60), 0.5, 1.9)
  const core = packLayer(C, -0.08, 0.08, 0.04, 0.2, { mode: 1, emit: 1, fogK: 0.7 })
  return makeFrame([halo, body, core])
}
registerGenerator('item', (name) => itemFrame(name))

// ─ notes: a torn pale page; unread ones carry a warm glow (never the exit's cold blue) ─
function noteFrame(name) {
  const read = name === 'read'
  const PPUn = 300
  const bw = Math.round(0.15 * PPUn), bh = Math.round(0.2 * PPUn), pad = 6
  const fw = bw + pad * 2, fh = bh + pad * 2
  const P = createPaint(fw, fh)
  const rnd = mulberry32(seedOf('note', read ? 1 : 0))
  const X = (u) => pad + u * bw, Y = (v) => pad + (1 - v) * bh
  // the page with a torn top-right corner and a deckled bottom edge
  const pts = [X(0), Y(1), X(0.7), Y(1), X(0.78), Y(0.94), X(0.86), Y(0.97), X(1), Y(0.84)]
  for (let i = 0; i <= 8; i++) pts.push(X(1 - i * 0.02 - rnd() * 0.02), Y(0.84 - i * 0.105 - rnd() * 0.02))
  for (let i = 0; i <= 10; i++) pts.push(X(0.95 - i * 0.095), Y(0.0 + rnd() * 0.03))
  pts.push(X(0), Y(0.05))
  const tone = read ? 0.86 : 1
  fillPoly(P, pts, (x, y) => { const m = tone * (0.94 + 0.1 * nz(x * 0.5, y * 0.5)) * (1 - 0.1 * (x - pad) / bw); SR = 230 * m; SG = 222 * m; SB = 198 * m })
  // ruled lines and a hand scribble
  for (let i = 0; i < 8; i++) fillSeg(P, X(0.08), Y(0.82 - i * 0.095), X(0.92), Y(0.82 - i * 0.095), 0.45, 0.45, flat(126, 138, 156, 0.55))
  for (let i = 0; i < 6; i++) {
    let x = X(0.12), y = Y(0.845 - i * 0.095)
    const len = 0.45 + rnd() * 0.4
    for (let k = 0; k < 14; k++) { const nx = x + c2(len / 14 * bw), ny = y + (rnd() - 0.5) * 2.4; fillSeg(P, x, y, nx, ny, 0.5, 0.5, flat(60, 52, 44, 0.8)); x = nx; y = ny }
  }
  fillSeg(P, X(0.3), Y(0.1), X(0.7), Y(0.16), 0.8, 0.3, flat(120, 110, 90, 0.35))               // a crease
  outlinePaint(P, 0.7)
  const rectW = (fw / 2) / PPUn, rectH = fh / PPUn
  const layers = []
  if (!read) {
    const Hn = 64, H = createPaint(Hn, Hn)
    glowEll(H, Hn / 2, Hn / 2, Hn / 2, Hn / 2, 255, 214, 138, 0.7, 1.55)
    layers.push(packLayer(H, -0.22, 0.22, -0.02, 0.42, { mode: 1, emit: 1, fogK: 0.55 }))
  }
  layers.push(packLayer(P, -rectW, rectW, 0, rectH, { emit: read ? 0.2 : 0.55, alpha: read ? 0.62 : 0.97 }))
  return makeFrame(layers)
}
function c2(n) { return n }
registerGenerator('note', (name) => noteFrame(name))

// ─ the vending machine: a mundane, unbranded drinks machine, cold light in its glass ─
function machineFrame(name) {
  const lit = name === 'lit'
  const PPUm = 200
  const bw = Math.round(MACHINE_SPEC.w * PPUm), bh = Math.round(MACHINE_SPEC.h * PPUm), pad = 6
  const fw = bw + pad * 2, fh = bh + 8, floor = fh - 4
  const P = createPaint(fw, fh)
  const c = { P, X: (u) => pad + u * bw, Y: (v) => floor - v * bh, W: (u) => u * bw, H: (v) => v * bh, fw, fh, bw, bh, floor }
  const { X, Y } = c
  const body = [178, 174, 162]
  slab(c, 0, 0.02, 1, 1, body, { r: 3, streak: 0.16, seed: 2, grain: 0.06 })
  slab(c, 0.02, 0, 0.98, 0.03, cmul(body, 0.45), { r: 0 })
  // glass: dark, deep, framed
  slab(c, 0.07, 0.36, 0.72, 0.93, [30, 34, 36], { r: 2, grain: 0.03 })
  slab(c, 0.1, 0.385, 0.69, 0.905, lit ? [40, 52, 56] : [14, 16, 18], { r: 1, grain: 0.03 })
  // shelves of pale, label-less bottles
  const rnd = mulberry32(seedOf('machine', lit ? 1 : 0))
  const bottles = []
  for (let r = 0; r < 4; r++) {
    const v0 = 0.4 + r * 0.125
    slab(c, 0.1, v0 - 0.006, 0.69, v0 + 0.004, cmul(body, 0.6), { r: 0 })
    for (let k = 0; k < 6; k++) {
      if (!lit && r === 1 && k === 2) continue     // the bottle that was taken
      const u = 0.125 + k * 0.095
      const tone = 0.9 + rnd() * 0.18
      slab(c, u, v0 + 0.006, u + 0.055, v0 + 0.095, lit ? [212 * tone, 224 * tone, 228 * tone] : [96 * tone, 104 * tone, 106 * tone], { r: 1.5, grain: 0.05 })
      slab(c, u + 0.014, v0 + 0.095, u + 0.041, v0 + 0.11, lit ? [230, 236, 238] : [110, 114, 116], { r: 0.8 })
      bottles.push([u, v0])
    }
  }
  // control column: buttons, coin slot, a ready light
  slab(c, 0.77, 0.4, 0.94, 0.92, cmul(body, 0.55), { r: 1.5 })
  for (let i = 0; i < 8; i++) slab(c, 0.8 + (i & 1) * 0.07, 0.8 - (i >> 1) * 0.06, 0.85 + (i & 1) * 0.07, 0.84 - (i >> 1) * 0.06, [212, 208, 196], { r: 0.8 })
  slab(c, 0.8, 0.5, 0.91, 0.54, [26, 26, 28], { r: 1 })
  slab(c, 0.8, 0.44, 0.91, 0.47, lit ? [232, 182, 64] : [84, 66, 30], { r: 1 })
  // the dispense tray: a dark slot with a hinged flap
  slab(c, 0.14, 0.06, 0.66, 0.2, [12, 12, 14], { r: 1.5 })
  slab(c, 0.17, 0.08, 0.63, 0.13, cmul(body, 0.5), { r: 1 })
  stainPaint(P, (x, y) => { const n = nz(x * 0.3 + 3, y * 0.05); if (n > 0.66) { SR = 70; SG = 62; SB = 46; SA = Math.min(0.32, (n - 0.66) * 2.5) } })
  outlinePaint(P, 0.66)
  tonePaint(P, (x, y) => 1 - 0.25 * smooth(0.08, 0, (floor - y) / bh))
  const rect = [-(fw / 2) / PPUm, (fw / 2) / PPUm, -4 / PPUm, (fh - 4) / PPUm]
  const layers = [packLayer(P, rect[0], rect[1], rect[2], rect[3], { emit: 0.05 })]
  if (lit) {
    // the interior light: a cold wash over the glass and a brighter tint on the bottles, plus the ready light and a spill on the floor
    const Gp = createPaint(fw, fh)
    const gx0 = X(0.1), gx1 = X(0.69), gy0 = Y(0.905), gy1 = Y(0.385)
    fillBox(Gp, gx0, gy0, gx1, gy1, (x, y) => { const t = (y - gy0) / (gy1 - gy0); SR = 150 - 40 * t; SG = 184 - 44 * t; SB = 196 - 40 * t; SA = 0.42 - 0.16 * t }, 1)
    for (const [u, v0] of bottles) glowEll(Gp, X(u + 0.028), Y(v0 + 0.05), c.W(0.06), c.H(0.07), 200, 226, 232, 0.24, 1.2)
    glowEll(Gp, X(0.855), Y(0.455), c.W(0.05), c.W(0.05), 255, 200, 90, 0.85, 1.1)
    layers.push(packLayer(Gp, rect[0], rect[1], rect[2], rect[3], { mode: 1, emit: 1, fogK: 0.8 }))
    const Sp = createPaint(48, 48)
    glowEll(Sp, 24, 24, 24, 24, 150, 190, 205, 0.38, 1.4)
    layers.push(packLayer(Sp, -0.3, 0.3, -0.05, 0.42, { mode: 1, emit: 1, fogK: 1, floor: true }))
  }
  return makeFrame(layers)
}
registerGenerator('machine', (name) => machineFrame(name))

// ─ the exit: a torn doorway in the world, a breathing cold rim, a beam that carries through fog ─
// layers: 0 floor ring (screen decal) · 1 beam (over) · 2 the dark portal · 3 rim glow (screen)
function exitFrame(name, v, s, anim) {
  const PPUe = 200
  const W = EXIT_SPEC.w, Hh = EXIT_SPEC.h
  const bw = Math.round(W * PPUe), bh = Math.round(Hh * PPUe), pad = 10
  const fw = bw + pad * 2, fh = bh + pad + 4, floor = fh - 4
  const X = (u) => pad + u * bw, Y = (vv) => floor - vv * bh
  const rect = [-(fw / 2) / PPUe, (fw / 2) / PPUe, -4 / PPUe, (fh - 4) / PPUe]
  // a pointed-arch rift, ragged along its edge
  const rnd = mulberry32(seedOf('exit', 0))
  const outline = []
  const N = 26
  const halfW = (t) => 0.5 * Math.pow(Math.sin(Math.PI * Math.min(1, t * 0.98 + 0.02)), 0.55)   // t: 0 floor .. 1 apex
  const jitter = []
  for (let i = 0; i <= N; i++) jitter.push((rnd() - 0.5) * 0.028)
  for (let i = 0; i <= N; i++) { const t = i / N; outline.push(X(0.5 - halfW(t) * 0.96 + jitter[i]), Y(t)) }
  for (let i = N; i >= 0; i--) { const t = i / N; outline.push(X(0.5 + halfW(t) * 0.96 - jitter[(i * 7) % (N + 1)]), Y(t)) }
  const P = createPaint(fw, fh)
  const ph = anim ? 0.5 : 0
  // the same shape as an analytic distance (a 54-edge polygon test per pixel was most of this frame's cost)
  const hwL = [], hwR = []
  for (let i = 0; i <= N; i++) { const h = halfW(i / N) * 0.96; hwL.push(h - jitter[i]); hwR.push(h - jitter[(i * 7) % (N + 1)]) }
  const cxp = X(0.5)
  const shapeDist = (x, y) => {
    const t = (floor - y) / bh
    if (t < 0) return 1 - t * bh
    if (t > 1) return 1 + (t - 1) * bh
    const f = t * N, i = f | 0, u = f - i, i2 = i < N ? i + 1 : N
    const hw = x < cxp ? hwL[i] + (hwL[i2] - hwL[i]) * u : hwR[i] + (hwR[i2] - hwR[i]) * u
    return Math.abs(x - cxp) - hw * bw
  }
  paintShape(P, pad - 2, floor - bh - 2, pad + bw + 2, floor + 2, shapeDist, (x, y) => {
    const u = (x - pad) / bw, t = (floor - y) / bh
    const streak = nz(x * 0.55 + ph * 30, y * 0.05 + ph * 9)
    const depth = smooth(0, 0.5, 0.5 - Math.abs(u - 0.5)) * 0.5
    const m = 0.5 + 0.9 * Math.max(0, streak - 0.55) * 1.6
    SR = 5 + 22 * m * (1 - depth) * (0.5 + 0.5 * t); SG = 7 + 30 * m * (1 - depth) * (0.5 + 0.5 * t); SB = 12 + 48 * m * (1 - depth) * (0.5 + 0.5 * t)
  })
  // the rim: a thin bright line along the outline and a soft halo hugging it
  const G = createPaint(fw, fh)
  for (let i = 0; i < outline.length; i += 2) {
    const j = (i + 2) % outline.length
    const flick = 0.75 + 0.25 * nz(i * 0.7, 3.1)
    glowSeg(G, outline[i], outline[i + 1], outline[j], outline[j + 1], 1.5, 205 * flick, 224 * flick, 248 * flick, 1)
  }
  const G2 = createPaint(fw, fh)
  for (let i = 0; i < outline.length; i += 4) {          // the halo is soft: every other segment, wider
    const j = (i + 4) % outline.length
    glowSeg(G2, outline[i], outline[i + 1], outline[j], outline[j + 1], 6.5, 120, 170, 236, 0.3)
  }
  for (let i = 0; i < G.px.length; i++) { G.px[i] = Math.min(255, G.px[i] + G2.px[i]) }
  // beam: a tall column of cold light that fades upward
  const Bw = 36, Bh = 128
  const B = createPaint(Bw, Bh)
  for (let y = 0; y < Bh; y++) {
    const t = 1 - y / Bh
    for (let x = 0; x < Bw; x++) {
      const u = (x + 0.5) / Bw * 2 - 1
      const e = 1 - Math.abs(u)
      const a = Math.pow(e, 1.0) * Math.pow(t, 1.0) * 0.92
      const core = e * e * e                       // a whiter heart inside the cold blue
      const j = (y * Bw + x) * 4
      B.px[j] = (150 + 70 * core) * a; B.px[j + 1] = (196 + 36 * core) * a; B.px[j + 2] = (250 + 5 * core) * a; B.px[j + 3] = a
    }
  }
  // dust motes drifting in the light
  for (let i = 0; i < 9; i++) { const x = 6 + rnd() * (Bw - 12), y = rnd() * Bh * 0.8 + 6; const j = (((y | 0) * Bw) + (x | 0)) * 4; B.px[j] = 240; B.px[j + 1] = 248; B.px[j + 2] = 255; B.px[j + 3] = 0.9 * (1 - y / Bh) }
  // the floor ring
  const Rn = 64, R = createPaint(Rn, Rn)
  for (let y = 0; y < Rn; y++) for (let x = 0; x < Rn; x++) {
    const d = hyp(x + 0.5 - Rn / 2, y + 0.5 - Rn / 2) / (Rn / 2)
    if (d >= 1) continue
    const ring = Math.exp(-Math.pow((d - 0.82) / 0.07, 2)), fill = Math.pow(1 - d, 1.6) * 0.5
    const a = Math.min(1, ring * 0.95 + fill)
    const j = (y * Rn + x) * 4
    R.px[j] = 170 * a; R.px[j + 1] = 208 * a; R.px[j + 2] = 244 * a; R.px[j + 3] = a
  }
  return makeFrame([
    packLayer(R, -0.34, 0.34, -0.3, 0.3, { mode: 1, emit: 1, fogK: 0.55, floor: true }),
    packLayer(B, -0.19, 0.19, 0.5, EXIT_SPEC.beam, { emit: 1, fogK: 0.45 }),
    packLayer(P, rect[0], rect[1], rect[2], rect[3], { emit: 1, fogK: 0.9 }),
    packLayer(G, rect[0], rect[1], rect[2], rect[3], { mode: 1, emit: 1, fogK: 0.5 }),
  ])
}
registerGenerator('exit', (name, v, s, anim) => exitFrame(name, v, s, anim))
// @@ITEMS-END@@
// @@SIGHTS-BEGIN@@
// ── landmark sights ──
const PPU_SIGHT = 168

function sightCanvas(spec, ppu = PPU_SIGHT, pad = 6) {
  const bw = Math.round(spec.w * ppu), bh = Math.round(spec.h * ppu)
  const fw = bw + pad * 2, fh = bh + 8, floor = fh - 4
  return {
    P: createPaint(fw, fh), fw, fh, bw, bh, padX: pad, floor, ppu,
    X: (u) => pad + u * bw, Y: (v) => floor - v * bh, W: (u) => u * bw, H: (v) => v * bh,
    rect: [-(fw / 2) / ppu, (fw / 2) / ppu, -4 / ppu, (fh - 4) / ppu],
  }
}

// ─ a wall of CRT televisions all tuned to static: four banks of snow so it crawls ─
function tvwallFrame(bank) {
  const spec = SIGHT_SPEC.tvwall
  const c = sightCanvas(spec)
  const { X, Y } = c
  const rnd = mulberry32(seedOf('tvwall', 0))
  const G = createPaint(c.fw, c.fh)
  const rnd2 = mulberry32(seedOf('tvsnow', bank))
  const cols = 3, rows = 3
  const cw = 1 / cols, rh = 1 / rows
  for (let r = 0; r < rows; r++) {
    for (let k = 0; k < cols; k++) {
      const off = (rnd() - 0.5) * 0.012
      const u0 = k * cw + 0.008 + off, u1 = (k + 1) * cw - 0.008 + off, v0 = r * rh + 0.006, v1 = (r + 1) * rh - 0.004
      const plastic = [[44, 42, 40], [52, 48, 42], [38, 38, 40], [56, 52, 46]][(r * 3 + k) % 4]
      slab(c, u0, v0, u1, v1, plastic, { r: 3, streak: 0.12, seed: r * 3 + k, grain: 0.08 })
      // the tube: inset, dark, curved corners
      const su0 = u0 + (u1 - u0) * 0.1, su1 = u0 + (u1 - u0) * 0.74, sv0 = v0 + (v1 - v0) * 0.16, sv1 = v1 - (v1 - v0) * 0.13
      slab(c, su0, sv0, su1, sv1, [10, 12, 14], { r: c.H((sv1 - sv0) * 0.28), grain: 0.02 })
      // controls
      disc(c, X(u1 - (u1 - u0) * 0.12), Y(v1 - (v1 - v0) * 0.3), 2.2, 2.2, [96, 92, 84])
      disc(c, X(u1 - (u1 - u0) * 0.12), Y(v1 - (v1 - v0) * 0.6), 2.2, 2.2, [82, 80, 74])
      for (let i = 0; i < 4; i++) stroke(c, X(u1 - (u1 - u0) * 0.19), Y(v0 + (v1 - v0) * (0.15 + i * 0.04)), X(u1 - (u1 - u0) * 0.05), Y(v0 + (v1 - v0) * (0.15 + i * 0.04)), 0.8, [20, 20, 20], 0.8)
      // the snow: per-pixel noise with a rolling bar, cool and grey-blue
      const bar = ((rnd2() * 0.9) + 0.05)
      const gx0 = X(su0), gx1 = X(su1), gy0 = Y(sv1), gy1 = Y(sv0)
      fillBox(G, gx0, gy0, gx1, gy1, (x, y) => {
        const t = (y - gy0) / (gy1 - gy0)
        const n = rnd2()
        const bd = (t - bar) / 0.09, band = 1 + 0.5 * (bd * bd < 1 ? 1 - bd * bd : 0)
        const curve = 1 - 0.35 * Math.pow(Math.abs((x - (gx0 + gx1) / 2) / ((gx1 - gx0) / 2)), 2.2)
        const m = (0.15 + 0.65 * n * n) * band * curve
        SR = 150 * m; SG = 174 * m; SB = 192 * m; SA = 1
      }, c.H((sv1 - sv0) * 0.28))
    }
  }
  // a tangle of cable trailing along the floor
  for (let i = 0; i < 4; i++) stroke(c, X(0.1 + rnd() * 0.8), Y(0.005), X(0.1 + rnd() * 0.8), Y(0.02), 1.6, [16, 16, 16], 0.9)
  outlinePaint(c.P, 0.6)
  finishProp(c, { dust: 0.3, stain: 0.2, outline: 0, ao: 0.3 })
  const body = packLayer(c.P, c.rect[0], c.rect[1], c.rect[2], c.rect[3], { emit: 0.04 })
  const glow = packLayer(G, c.rect[0], c.rect[1], c.rect[2], c.rect[3], { mode: 1, emit: 1, fogK: 0.7 })
  const Sp = createPaint(56, 56)
  glowEll(Sp, 28, 28, 28, 28, 130, 156, 178, 0.3, 1.4)
  const halo = packLayer(Sp, -0.62, 0.62, 0, 0.9, { mode: 1, emit: 1, fogK: 0.8 })
  return makeFrame([body, glow, halo])
}

// ─ a heap of chairs, thrown together ─
function chairpileFrame() {
  const spec = SIGHT_SPEC.chairpile
  const c = sightCanvas(spec, 160)
  const { X, Y, P } = c
  const rnd = mulberry32(seedOf('chairpile', 0))
  // hand-placed pile: [cx, cy (0 floor .. 1 top), angle (rad, 0 = upright), mirror, scale]
  const plan = [
    [0.16, 0.13, 1.45, 1, 1.0], [0.34, 0.11, 3.14, 0, 1.05], [0.56, 0.12, -1.35, 1, 1.0], [0.78, 0.13, 3.0, 1, 0.95], [0.9, 0.12, 1.6, 0, 0.9],
    [0.26, 0.34, 2.6, 0, 1.0], [0.48, 0.32, 0.3, 1, 1.05], [0.7, 0.34, -2.4, 0, 1.0],
    [0.38, 0.55, -0.6, 1, 1.0], [0.6, 0.58, 3.5, 0, 0.95],
    [0.5, 0.76, 0.9, 1, 0.9],
  ]
  const tones = [[74, 56, 40], [50, 46, 44], [92, 66, 40], [58, 50, 40], [70, 64, 56]]
  const S0 = c.bh * 0.3
  for (let i = 0; i < plan.length; i++) {
    const [px, py, ang, mir, sc] = plan[i]
    const col = cmul(tones[i % tones.length], 0.85 + rnd() * 0.3)
    const ca = Math.cos(ang), sa = Math.sin(ang), m = mir ? -1 : 1
    const ox = X(px), oy = Y(py)
    const tf = (lx, ly) => [ox + (ca * lx * m - sa * ly) * S0 * sc, oy - (sa * lx * m + ca * ly) * S0 * sc]
    const seg = (ax, ay, bx, by, w, cc) => { const [x0, y0] = tf(ax, ay), [x1, y1] = tf(bx, by); stroke(c, x0, y0, x1, y1, w, cc) }
    const dark = cmul(col, 0.3)
    const parts = [
      [-0.5, 0, 0.5, 0, 5.2], [-0.5, 0, -0.55, 1.0, 4.4], [-0.53, 0.7, -0.53, 0.7, 0], [-0.55, 1.0, -0.4, 1.02, 3.6],
      [0.45, 0, 0.5, -0.95, 2.8], [0.36, 0, 0.42, -0.95, 2.4], [-0.45, 0, -0.52, -0.95, 2.8], [-0.36, 0, -0.42, -0.95, 2.4],
      [-0.54, 0.55, -0.54, 0.55, 0], [-0.52, 0.4, -0.55, 0.9, 1.6],
    ]
    for (const [ax, ay, bx, by, w] of parts) if (w > 0) seg(ax, ay, bx, by, w + 2.2, dark)
    for (const [ax, ay, bx, by, w] of parts) if (w > 0) seg(ax, ay, bx, by, w, cmul(col, w > 3 ? 1.1 : 0.9))
    seg(-0.5, 0.06, 0.5, 0.06, 1.2, cmul(col, 1.4))
  }
  finishProp(c, { dust: 0.3, stain: 0.2, outline: 0.55, ao: 0.4 })
  return makeFrame([packLayer(P, c.rect[0], c.rect[1], c.rect[2], c.rect[3], {})])
}

// ─ a payphone on a post, alone: a dim display, a hung handset, its cord ─
function payphoneFrame() {
  const spec = SIGHT_SPEC.payphone
  const c = sightCanvas(spec, 200, 8)
  const { X, Y, P } = c
  const steel = [58, 62, 68]
  slab(c, 0.4, 0, 0.6, 0.36, cmul(steel, 0.8), { r: 1, cyl: 0.7, streak: 0.3 })          // the post
  slab(c, 0.3, 0, 0.7, 0.03, cmul(steel, 0.6), { r: 1 })
  slab(c, 0.06, 0.34, 0.94, 0.98, steel, { r: 3, streak: 0.2, seed: 3, grain: 0.08 })     // housing
  slab(c, 0.12, 0.88, 0.88, 0.95, [92, 100, 112], { r: 1.5 })                              // header plate
  slab(c, 0.16, 0.64, 0.66, 0.82, [14, 18, 20], { r: 1.5 })                                // display
  for (let r = 0; r < 4; r++) for (let k = 0; k < 3; k++) slab(c, 0.2 + k * 0.14, 0.38 + r * 0.06, 0.28 + k * 0.14, 0.42 + r * 0.06, [122, 124, 120], { r: 0.8 })
  slab(c, 0.72, 0.5, 0.82, 0.78, [24, 26, 28], { r: 1 })                                   // coin slot column
  stroke(c, X(0.77), Y(0.72), X(0.77), Y(0.66), 1.4, [190, 170, 96], 0.7)
  // the handset hangs on the left with a coiled cord
  fillPoly(P, [X(-0.02), Y(0.84), X(0.1), Y(0.84), X(0.12), Y(0.5), X(0.06), Y(0.36), X(-0.04), Y(0.4)], mat({ c: [22, 22, 24], x0: X(-0.02), x1: X(0.12), y0: Y(0.84), y1: Y(0.36), cyl: 0.6, kx: -0.3 }))
  for (let i = 0; i < 9; i++) stroke(c, X(0.02 + (i & 1) * 0.03), Y(0.36 - i * 0.03), X(0.05 - (i & 1) * 0.03), Y(0.35 - i * 0.03), 1.1, [20, 20, 20], 0.9)
  finishProp(c, { dust: 0.25, stain: 0.35, outline: 0.55, ao: 0.3 })
  const body = packLayer(P, c.rect[0], c.rect[1], c.rect[2], c.rect[3], { emit: 0.05 })
  const G = createPaint(c.fw, c.fh)
  fillBox(G, X(0.18), Y(0.8), X(0.64), Y(0.66), (x, y) => { SR = 90; SG = 150; SB = 128; SA = 0.5 }, 1)
  for (let r = 0; r < 4; r++) for (let k = 0; k < 3; k++) glowEll(G, X(0.24 + k * 0.14), Y(0.4 + r * 0.06), 3, 2.4, 120, 170, 150, 0.35, 1)
  glowEll(G, X(0.42), Y(0.72), c.W(0.3), c.H(0.12), 100, 160, 140, 0.18, 1.5)
  return makeFrame([body, packLayer(G, c.rect[0], c.rect[1], c.rect[2], c.rect[3], { mode: 1, emit: 1, fogK: 0.8 })])
}

// ─ a mannequin: pale, faceless, still ─
RIG.mannequin = { hipY: 0.47, hipHW: 0.05, shY: 0.78, shHW: 0.12, waistHW: 0.07, headY: 0.895, hrx: 0.058, hry: 0.076, neckR: 0.026, chestRy: 0.12,
  arm: { l1: 0.22, l2: 0.21, r0: 0.032, r1: 0.027, r2: 0.022 }, reachX: 0.16, reachY: 0.5,
  hand: { size: 0.03, fingers: 0, flen: 0 },
  leg: { l1: 0.25, l2: 0.23, r0: 0.044, r1: 0.034, r2: 0.025, stance: 0.05 }, foot: 0.036 }
function mannequinFrame() {
  const spec = SIGHT_SPEC.mannequin
  const G = makeG(spec.w, spec.h, PPU_FIG, 0.06)
  const R = RIG.mannequin
  const { F, X, Y, L } = G
  humanoid(G, R, 0, 0, { k: 0.02, tilt: 0.004 })
  fieldBox(F, X(-0.15), Y(0.03), X(0.15), Y(0.0), L(0.008), 0)                      // the base plate
  paintField(G.P, F, {
    c: [186, 180, 168], R: G.L(0.04), amb: 0.62, dif: 0.7, sky: 0.16, cold: 0.3, rim: true,
    tex: (x, y) => 0.95 + 0.1 * (nz(x * 0.5, y * 0.5) - 0.5),
  })
  outlinePaint(G.P, 0.8)
  return makeFrame([packLayer(G.P, G.rect[0], G.rect[1], G.rect[2], G.rect[3], { rimK: 0.6 })])
}

registerGenerator('sight', (name, v, s, anim, facing) => {
  if (name === 'tvwall') return tvwallFrame(anim * 2 + facing)
  if (name === 'chairpile') return chairpileFrame()
  if (name === 'payphone') return payphoneFrame()
  return mannequinFrame()
})
// @@SIGHTS-END@@

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 6. THE SPRITE PLAN — what is drawn, decided once for both backends
// ════════════════════════════════════════════════════════════════════════════════════════════════
// planSprites(fs, entities) turns the entity list into DRAWABLE RECORDS, one per layer to draw, in paint order: far to near, and within a
// sprite its ground shadow first, then its layers in art order. Every decision about WHAT is drawn lives here and nowhere else — cull, the
// MAXS cap and its priority, the far-to-near sort, per-kind frame / pose / facing / mirror, pulses and warps, light / tint / fog / flicker
// terms, rim, dissolve, the remote players' motion records, nameplates, frame generation and the background warm queue — and both backends
// consume the same records: the CPU blitter below (drawSprites = planSprites + blit) and the GPU instance builder (gfx-gl-sprites-plan.js).
//
// RECORD (reused objects, valid until the next planSprites call; numbers are the blitter's own doubles, never rounded):
//   si               the sprite's ordinal in this plan: a sprite's records are contiguous (a backend that cannot draw one of them drops the sprite)
//   lay, mip         the layer, and the mip pickMip() chose for its on-screen height;  shadow: the layer is the soft ground shadow (shadowLayer())
//   X0 X1 Yt Yb      the screen rect in the internal W x H frame, rows from the top
//   xa xb ya yb      the whole-pixel box the layer can touch (the warp's sideways pad included), clipped to the frame; never empty
//   depth, mirror    perpendicular depth (what the z-buffer holds); the art is flipped left-right
//   A, screen        the layer's alpha; the blend mode (screen = a self-lit glow, screen-blended; otherwise lit 'over')
//   mr mg mb         the reflected-colour multipliers: alpha x light x (1 - fog) x flicker x the light / palette tints
//   fr fg fb         the fog term (0..1 of the fog colour, weighted by the fog fraction and alpha; added per texel times its alpha)
//   lean swayA swayP rippleA rippleP      the runtime warp (all 0 for a floor decal)
//   cm0 cmK cmX      the sideways lit face: cm = max(0.15, cm0 + cmK * (x - cmX))
//   rim rimS rimB rimR rimG rimBl         edge light from the nearest emitter (rim: on for this layer; it also needs the mip's rim plane)
//   dith dx dy dph   the "coming apart in the light" dissolve
// The per-frame cost is one pass over the entities; nothing is allocated per frame once the pools have grown (records, nameplates, the sort).

const SIN_N = 1024
const SINT = new Float32Array(SIN_N)
for (let i = 0; i < SIN_N; i++) SINT[i] = Math.sin((i / SIN_N) * TAU)
function sinc(cycles) { return SINT[(cycles * SIN_N) & (SIN_N - 1)] }   // sin(2*pi*cycles) by table

// a 64x64 dither field for the "coming apart in the light" dissolve
const DITH = new Uint8Array(4096)
{ const r = mulberry32(0xd17e7); for (let i = 0; i < 4096; i++) DITH[i] = (r() * 255) | 0 }

// per-frame context (module state: the sprite pass is single-threaded and non-reentrant)
let CW = 0, CH = 0, CHH = 0
let FOGR = 0, FOGG = 0, FOGB = 0        // fog colour * flicker, 0..255
let FLICK = 1, TNOW = 0, REDUCE = false
let HARM_R = 1, HARM_G = 1, HARM_B = 1  // palette harmony tint
let LIGHT = null, LIGHT_ON = false
let CAMX = 0, CAMY = 0, CAMA = 0, CA = 1, SAN = 0
let FLASH = false

// per-sprite state
const S = {
  sx: 0, fwd: 1, side: 0,
  A: 1, L: 1, tr: 1, tg: 1, tb: 1, fogT: 0, lift: 0,
  lean: 0, swayA: 0, swayP: 0, rippleA: 0, rippleP: 0, dith: 0, dx: 0, dy: 0,
  cm0: 1, cmK: 0, hasRim: false, rimS: 0, rimB: 0, rimR: 0, rimG: 0, rimB2: 0, rimK: 0,
}

// the records (one hidden class: every field is created here, in this order)
function newRecord() {
  return {
    si: 0, lay: null, mip: null, shadow: false,
    X0: 0, X1: 0, Yt: 0, Yb: 0, xa: 0, xb: 0, ya: 0, yb: 0, depth: 0, mirror: false,
    A: 1, screen: false, mr: 1, mg: 1, mb: 1, fr: 0, fg: 0, fb: 0,
    lean: 0, swayA: 0, swayP: 0, rippleA: 0, rippleP: 0,
    cm0: 1, cmK: 0, cmX: 0, rim: false, rimS: 0, rimB: 0, rimR: 0, rimG: 0, rimBl: 0,
    dith: 0, dx: 0, dy: 0, dph: 0,
  }
}
const RECS = []
let NREC = 0
let SI = 0                               // the ordinal of the sprite being planned

const MAXS = 384
const SE = new Array(MAXS)
const SD = new Float32Array(MAXS)       // squared distance (sort key)
const SF = new Float32Array(MAXS)       // perpendicular depth
const SL = new Float32Array(MAXS)       // lateral offset in world units (+ = screen right)
const SK = new Float32Array(MAXS)       // eviction key when over the cap: squared distance, x0.05 for anything but a prop
const POOL = []                          // reused nameplate records
const PLATES = []
// the plan planSprites returns (reused): recs[0 .. count) in paint order, `sprites` drawn things, the nameplates, the frame width it was made for
const PLAN = { recs: RECS, count: 0, sprites: 0, plates: PLATES, W: 0 }

const LAYA = new Float32Array(12).fill(1)   // per-layer alpha multipliers a drawer may set for the next planFrame
function resetLayA() { LAYA.fill(1) }

// a per-sprite phase from the position (things that never move: items, notes, machines)
function posPhase(e) { return hash2(Math.round(e.x * 8), Math.round(e.y * 8), 5) / 4294967296 }

// ── light ──
function normRim(n) {
  // fs.light.nearest() reports the emitter colour as 0..1 or 0..255; accept both
  const hi = Math.max(n.r || 0, n.g || 0, n.b || 0)
  if (!(hi > 0)) { S.rimR = 255; S.rimG = 238; S.rimB2 = 196; return }
  const sc = hi > 2 ? 1 : 255
  S.rimR = (n.r || 0) * sc; S.rimG = (n.g || 0) * sc; S.rimB2 = (n.b || 0) * sc
}

// (the sprite's place is in S — fwd, side — not in arguments; see G)
function sampleLight(e) {
  let L = 1, tr = 1, tg = 1, tb = 1
  if (LIGHT_ON) {
    const l = typeof LIGHT.at === 'function' ? LIGHT.at(e.x, e.y) : 1
    if (l > 0) L = l < 0.12 ? 0.12 : l > 1.6 ? 1.6 : l
    const t = typeof LIGHT.tint === 'function' ? LIGHT.tint(e.x, e.y) : null
    if (t) { tr = t[0]; tg = t[1]; tb = t[2] }
  }
  if (FLASH) {
    const fwd = S.fwd
    const off = Math.abs(S.side) / fwd
    const cone = off < 0.55 ? 1 - off / 0.55 : 0
    const range = fwd < 10 ? 1 - fwd / 10 : 0
    L += 0.4 * cone * range
  }
  S.L = L; S.tr = tr; S.tg = tg; S.tb = tb
}

// Rim light from the nearest emitter: which edge catches it (side), how much a backlight rims both (back), what colour.
function setRim(e, rimOn = true) {
  S.hasRim = false
  if (!LIGHT_ON || typeof LIGHT.nearest !== 'function') return
  const n = LIGHT.nearest(e.x, e.y)
  if (!n) return
  const dx = n.x - e.x, dy = n.y - e.y
  const d = Math.sqrt(dx * dx + dy * dy) || 1e-3
  const side = (-dx * SAN + dy * CA) / d      // +1: the emitter is to the screen-right of the sprite
  const back = (dx * CA + dy * SAN) / d       // > 0: it is beyond the sprite (a backlight)
  const k = 1.1 / (1 + d * d * 0.09)          // falls off with distance to the emitter
  normRim(n)
  S.rimS = side * k * 1.5 / 127
  S.rimB = (back > 0 ? back : 0) * k * 0.8 / 127
  S.rimK = k
  S.hasRim = rimOn && k > 0.05
  // a lit face on the side toward the emitter: a gentle horizontal gradient across the body
  S.cm0 = 1 + 0.06 * k
  S.cmK = side * k * 0.3 / Math.max(6, 0.12 * (CH / S.fwd))
}

function initSprite(e, alpha) {
  S.A = alpha; S.lift = 0
  S.lean = 0; S.swayA = 0; S.swayP = 0; S.rippleA = 0; S.rippleP = 0
  S.dith = 0; S.dx = 0; S.dy = 0
  S.hasRim = false; S.cm0 = 1; S.cmK = 0
  sampleLight(e)
}

// ── planning one layer / one frame ──
let SHADOW = null
function shadowLayer() {
  if (SHADOW) return SHADOW
  const N = 40, P = createPaint(N, N)
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const d = hyp((x + 0.5 - N / 2) / (N / 2), (y + 0.5 - N / 2) / (N / 2))
      if (d >= 1) continue
      P.px[(y * N + x) * 4 + 3] = shadowAlpha(d)
    }
  }
  return (SHADOW = packLayer(P, -1, 1, -0.85, 0.85, { floor: true }))
}
// The shadow layer's shape, for a backend that evaluates it analytically (the GPU): a disc of radius 1 over the layer rect, alpha
// (1 - d)^1.25 * 0.9. The CPU blits the packed texture above; both are this function.
export function shadowAlpha(d) { return d >= 1 ? 0 : Math.pow(1 - d, 1.25) * 0.9 }

// One layer of the current sprite (S) at the current fog -> a record, or nothing when it cannot show (faded out, sub-pixel, off-frame).
//   aMul: a per-layer alpha multiplier (pulses, fades). A layer that is not `emit`ting is lit by the scene light and dimmed by the flicker;
//   an emissive one is not (eyes, beacons, glass). Fog acts on both, scaled by the layer's fogK.
// The frame being planned (planFrame / planShadow fill it, planLayer reads it): passed in an object, not as arguments, because V8 boxes every
// double argument of a call it does not inline — a heap number per argument per layer, every frame.
const G = { cx: 0, floorY: 0, unit: 0, depth: 0, mirror: false, sc: 1, lift: 0, aMul: 1 }
function planLayer(lay) {
  const cx = G.cx, floorY = G.floorY, unit = G.unit, depth = G.depth, mirror = G.mirror, sc = G.sc, lift = G.lift, aMul = G.aMul
  if (aMul <= 0.003) return
  const emit = lay.emit
  const f = S.fogT * lay.fogK
  const A = S.A * lay.alpha * aMul
  if (A < 0.003) return
  let X0, X1, Yt, Yb, lean = 0, swayA = 0, swayP = 0, rippleA = 0, rippleP = 0
  if (lay.floor) {
    const cxo = ((lay.x0 + lay.x1) * 0.5) * sc * (mirror ? -1 : 1), hw = (lay.x1 - lay.x0) * 0.5 * sc
    X0 = cx + (cxo - hw) * unit; X1 = cx + (cxo + hw) * unit
    const zN = Math.max(0.25, depth + lay.y0 * sc), zF = depth + lay.y1 * sc
    Yb = CHH + CH / (2 * zN); Yt = CHH + CH / (2 * zF)
  } else {
    lean = S.lean; swayA = S.swayA; swayP = S.swayP; rippleA = S.rippleA; rippleP = S.rippleP
    let a0 = lay.x0 * sc, a1 = lay.x1 * sc
    if (mirror) { const t = -a0; a0 = -a1; a1 = t }
    X0 = cx + a0 * unit; X1 = cx + a1 * unit
    Yb = floorY - (lay.y0 * sc + lift) * unit; Yt = floorY - (lay.y1 * sc + lift) * unit
  }
  const sw = X1 - X0, sh = Yb - Yt
  if (sw < 0.6 || sh < 0.6) return
  const pad = lean !== 0 || swayA !== 0 || rippleA !== 0 ? Math.ceil(Math.abs(lean) + Math.abs(swayA) + Math.abs(rippleA)) + 1 : 0
  let xa = Math.floor(X0 - pad), xb = Math.ceil(X1 + pad)
  if (xa < 0) xa = 0
  if (xb > CW) xb = CW
  let ya = Math.floor(Yt), yb = Math.ceil(Yb)
  if (ya < 0) ya = 0
  if (yb > CH) yb = CH
  if (xb <= xa || yb <= ya) return

  const r = NREC < RECS.length ? RECS[NREC] : (RECS[NREC] = newRecord())
  NREC++
  r.si = SI; r.lay = lay; r.mip = lay.mips[pickMip(lay.mips, sh)]; r.shadow = lay === SHADOW
  r.X0 = X0; r.X1 = X1; r.Yt = Yt; r.Yb = Yb; r.xa = xa; r.xb = xb; r.ya = ya; r.yb = yb; r.depth = depth; r.mirror = mirror
  r.A = A
  const lit = (S.L + (1 - S.L) * emit) * (FLICK + (1 - FLICK) * emit) * (1 - f)
  if (lay.mode === 1) {
    r.screen = true
    r.mr = r.mg = r.mb = A * lit
    r.fr = r.fg = r.fb = 0
  } else {
    r.screen = false
    // the scene's light tint and the palette harmony tint colour what a layer REFLECTS: an emissive layer (beam, eyes, glass, the cold-blue
    // cue of other people) makes its own colour, so both are mixed toward 1 by the layer's emit
    const ke = 1 - emit
    r.mr = A * lit * (1 + (S.tr - 1) * ke) * (1 + (HARM_R - 1) * ke)
    r.mg = A * lit * (1 + (S.tg - 1) * ke) * (1 + (HARM_G - 1) * ke)
    r.mb = A * lit * (1 + (S.tb - 1) * ke) * (1 + (HARM_B - 1) * ke)
    // the fog term is added per pixel weighted by the texel's alpha (a * fr): a body fogs toward the fog colour exactly like a wall texel would
    r.fr = FOGR * f * A * (1 / 255)
    r.fg = FOGG * f * A * (1 / 255)
    r.fb = FOGB * f * A * (1 / 255)
  }
  r.lean = lean; r.swayA = swayA; r.swayP = swayP; r.rippleA = rippleA; r.rippleP = rippleP
  const flat0 = emit >= 0.99
  r.cm0 = flat0 ? 1 : S.cm0; r.cmK = flat0 ? 0 : S.cmK; r.cmX = cx
  r.dith = S.dith; r.dx = S.dx; r.dy = S.dy; r.dph = TNOW * 0.35
  r.rim = S.hasRim && lay.rimK > 0
  if (r.rim) { r.rimS = S.rimS * lay.rimK; r.rimB = S.rimB * lay.rimK; r.rimR = S.rimR; r.rimG = S.rimG; r.rimBl = S.rimB2 }
  else { r.rimS = 0; r.rimB = 0; r.rimR = 0; r.rimG = 0; r.rimBl = 0 }
}

function planFrame(fr, cx, floorY, unit, depth, mirror, sc, lift) {
  const layers = fr.layers
  G.cx = cx; G.floorY = floorY; G.unit = unit; G.depth = depth; G.mirror = mirror; G.sc = sc; G.lift = lift
  for (let i = 0; i < layers.length; i++) { G.aMul = LAYA[i]; planLayer(layers[i]) }
}

// the soft ground shadow: a flat ellipse in the floor plane, foreshortened by the view
function planShadow(cx, depth, unit, radius, opacity) {
  if (opacity < 0.02) return
  G.cx = cx; G.floorY = 0; G.unit = unit; G.depth = depth; G.mirror = false; G.sc = radius; G.lift = 0; G.aMul = opacity
  planLayer(shadowLayer())
}

// ── per-kind planners: (entity); its screen x, perpendicular depth, fog fraction and lateral offset are in S (sx fwd fogT side) ──
const VARIANTS = 3

function planProp(e) {
  const sx = S.sx, fwd = S.fwd, fogT = S.fogT, side = S.side
  const spec = PROP_SPEC[e.type]
  const name = spec ? e.type : 'box'
  const sp = spec || PROP_SPEC.box
  const rot = e.rot || 0
  const unit = CH / fwd, floorY = CHH + unit / 2
  initSprite(e, 1)
  const rq = Math.round(rot * 65536)                // variantHash(rot) / unitJitter(rot, salt), inline
  const vh = hash2(rq, 0x51ed, 3)
  const tj = 1 + 0.07 * ((hash2(rq, 11, 7) / 4294967296) * 2 - 1), hj = 1 + 0.04 * ((hash2(rq, 12, 7) / 4294967296) * 2 - 1)
  S.tr *= tj * hj; S.tg *= tj; S.tb *= tj / hj
  const sc = 1 + 0.06 * ((hash2(rq, 13, 7) / 4294967296) * 2 - 1)
  if (sp.lean) S.lean = ((hash2(rq, 17, 7) / 4294967296) * 2 - 1) * 0.028 * unit
  const sw = PROP_SWAY[name]
  if (sw) { S.swayA = sw * unit; S.swayP = TNOW * (REDUCE ? 0.25 : 0.5) + (vh & 255) / 255 }
  setRim(e, false)                       // a lit side, from the nearest emitter (no rim on furniture)
  const fr = frameFor('prop', name, vh % VARIANTS, 0, 0, 0)
  if (fr === null) return
  resetLayA()
  if (!sp.decal) planShadow(sx, fwd, unit, sp.w * 0.56 * sc, 0.5)
  planFrame(fr, sx, floorY, unit, fwd, (vh & 0x100) !== 0, sc, 0)
}
const PROP_SWAY = { plant: 0.010, weeds: 0.020 }

function creatureMotion(sIx, spec, phase, unit) {
  const k = REDUCE ? 0.6 : 1
  const hz = REDUCE ? 0.5 : 1
  let lift = 0, sc = 1
  if (sIx === 0) {         // idle: barely there — a slow sway and a breath
    S.swayA = 0.012 * unit * k; S.swayP = TNOW * 0.30 * hz + phase
    S.rippleA = 0.006 * unit * k; S.rippleP = TNOW * 0.7 * hz + phase * 3
    sc = 1 + 0.008 * sinc(TNOW * 0.27 + phase)
  } else if (sIx === 1) {  // chase: a rolling gait, leaning in
    S.swayA = 0.022 * unit * k; S.swayP = TNOW * 1.1 * hz + phase
    S.rippleA = 0.012 * unit * k; S.rippleP = TNOW * 2.2 * hz + phase * 3
    lift = (spec.low ? 0.016 : 0.011) * Math.abs(sinc(TNOW * 1.1 * hz + phase))
    sc = 1.025
  } else if (sIx === 2) {  // flee: quick, low, scurrying
    S.swayA = 0.026 * unit * k; S.swayP = TNOW * 1.6 * hz + phase
    S.rippleA = 0.016 * unit * k; S.rippleP = TNOW * 3.2 * hz + phase * 3
    lift = 0.010 * Math.abs(sinc(TNOW * 1.6 * hz + phase))
  } else {                 // stagger: recoiling, shuddering, coming apart in the light
    S.swayA = 0.028 * unit * k; S.swayP = TNOW * 3.3 * hz + phase
    S.rippleA = 0.014 * unit * k; S.rippleP = TNOW * 5 * hz + phase * 3
    S.lean = -0.05 * unit * (0.75 + 0.25 * sinc(TNOW * 1.5 + phase))
    S.dith = 70 + 30 * sinc(TNOW * 0.7 + phase)
    S.dx = 0; S.dy = (TNOW * 9) | 0
  }
  S.lift = lift
  return sc
}

function planCreature(e) {
  const sx = S.sx, fwd = S.fwd, fogT = S.fogT, side = S.side
  const app = e.kind === undefined && e.vx !== undefined
  const name = FIG[e.variant] ? e.variant : 'shade'
  const spec = FIG[name]
  const sIx = stateIndex(app ? apparitionState(e) : creatureState(e))
  const phase = app ? ((hash2(Math.round(e.vx * 100), Math.round(e.vy * 100), 4) / 4294967296)) : entityPhase(e)
  const anim = animFrame(sIx, TNOW, phase)
  let facing = FACING_FRONT, mirror = false, hideFace = false
  if (app) {
    mirror = false
  } else {
    facing = creatureFacing(e, CAMX, CAMY, spec.low)
    if (facing === FACING_BACK) { hideFace = true; facing = FACING_FRONT }
    else if (facing === FACING_SIDE) mirror = headsRight(e, CAMA)
  }
  const unit = CH / fwd, floorY = CHH + unit / 2
  initSprite(e, spec.thin ? (0.36 + 0.03 * sinc(TNOW * 0.21 + phase)) : 1)
  const sc = creatureMotion(sIx, spec, phase, unit) * 1
  if (spec.thin) { S.swayA = 0.012 * unit; S.swayP = TNOW * 0.4 + phase; S.rippleA = 0.02 * unit; S.rippleP = TNOW * 1.3 + phase * 3; S.lift = 0.004 * sinc(TNOW * 0.35 + phase) + 0.01 }
  setRim(e)
  if (sIx === 3) { S.hasRim = true; S.rimR = 232; S.rimG = 240; S.rimB2 = 255; S.rimS = 0; S.rimB = 0.5 / 127 }   // reeling in the ward's light: a pale edge, whatever the room's lamps do
  const fr = frameFor('creature', name, 0, sIx, anim, facing)
  if (fr === null) return
  resetLayA()
  if (hideFace) for (let i = 1; i < fr.layers.length; i++) LAYA[i] = 0
  else if (sIx === 1) { for (let i = 1; i < fr.layers.length; i++) LAYA[i] = 1.15 }
  else if (sIx === 3) { for (let i = 1; i < fr.layers.length; i++) LAYA[i] = 0.55 }
  else { for (let i = 1; i < fr.layers.length; i++) LAYA[i] = 0.85 }
  if (spec.electric && !hideFace) {   // the arcs crackle: one of three banks at a time (slower under the comfort setting)
    const bank = (((TNOW * (REDUCE ? 1.5 : 4) + phase * 3) | 0) % 3)
    for (let i = 2; i < fr.layers.length; i++) LAYA[i] = i - 2 === bank ? (sIx === 1 ? 1.2 : 1) : 0
  }
  planShadow(sx, fwd, unit, spec.w * 0.52, spec.thin ? 0.22 : 0.5)
  planFrame(fr, sx, floorY, unit, fwd, mirror, sc, S.lift || 0)
  S.lift = 0
}

function planItem(e) {
  const sx = S.sx, fwd = S.fwd, fogT = S.fogT, side = S.side
  const type = ITEM_COLORS[e.itemType] ? e.itemType : 'radio'
  const unit = CH / fwd, floorY = CHH + unit / 2
  initSprite(e, 1)
  const ph = posPhase(e)
  const fr = frameFor('item', type, 0, 0, 0, 0)
  if (fr === null) return
  resetLayA()
  const pulse = 0.78 + 0.22 * sinc(TNOW * 0.45 + ph)
  LAYA[0] = pulse
  const lift = 0.014 + 0.010 * sinc(TNOW * 0.5 + ph)
  S.swayA = 0.006 * unit; S.swayP = TNOW * 0.4 + ph
  planShadow(sx, fwd, unit, 0.1, 0.42 - lift * 6)
  planFrame(fr, sx, floorY, unit, fwd, false, 1, lift)
}

function planNote(e) {
  const sx = S.sx, fwd = S.fwd, fogT = S.fogT, side = S.side
  const unit = CH / fwd, floorY = CHH + unit / 2
  initSprite(e, 1)
  const ph = posPhase(e)
  const fr = frameFor('note', e.read ? 'read' : 'unread', 0, 0, 0, 0)
  if (fr === null) return
  resetLayA()
  if (!e.read) LAYA[0] = 0.72 + 0.28 * sinc(TNOW * 0.32 + ph)
  const lift = 0.36 + 0.014 * sinc(TNOW * 0.4 + ph)
  S.swayA = 0.010 * unit; S.swayP = TNOW * 0.33 + ph; S.lean = 0.008 * unit * sinc(TNOW * 0.27 + ph)
  planShadow(sx, fwd, unit, 0.06, 0.20)
  planFrame(fr, sx, floorY, unit, fwd, false, 1, lift)
}

function planMachine(e) {
  const sx = S.sx, fwd = S.fwd, fogT = S.fogT, side = S.side
  const unit = CH / fwd, floorY = CHH + unit / 2
  initSprite(e, 1)
  setRim(e, false)
  const fr = frameFor('machine', e.vended ? 'spent' : 'lit', 0, 0, 0, 0)
  if (fr === null) return
  resetLayA()
  if (!e.vended) LAYA[1] = 0.9 + 0.1 * sinc(TNOW * 0.9 + posPhase(e)) * (REDUCE ? 0.3 : 1)
  planShadow(sx, fwd, unit, MACHINE_SPEC.w * 0.6, 0.5)
  planFrame(fr, sx, floorY, unit, fwd, false, 1, 0)
}

function planSight(e) {
  const sx = S.sx, fwd = S.fwd, fogT = S.fogT, side = S.side
  const t = SIGHT_SPEC[e.sightType] ? e.sightType : 'mannequin'
  const unit = CH / fwd, floorY = CHH + unit / 2
  initSprite(e, 1)
  let anim = 0, facing = 0
  if (t === 'tvwall') { const b = ((TNOW * (REDUCE ? 1.5 : 5)) | 0) % 4; anim = b & 1; facing = b >> 1 }   // four static banks
  setRim(e, false)
  const fr = frameFor('sight', t, 0, 0, anim, facing)
  if (fr === null) return
  resetLayA()
  const ph = posPhase(e)
  if (t === 'payphone') { S.swayA = 0.004 * unit; S.swayP = TNOW * 0.3 + ph }
  planShadow(sx, fwd, unit, SIGHT_SPEC[t].w * 0.5, 0.5)
  planFrame(fr, sx, floorY, unit, fwd, false, 1, 0)
}

function planExit(e) {
  const sx = S.sx, fwd = S.fwd, fogT = S.fogT, side = S.side
  const unit = CH / fwd, floorY = CHH + unit / 2
  initSprite(e, 1)
  const ph = posPhase(e)
  const pulse = 0.55 + 0.45 * sinc(TNOW * 0.35 + ph)
  const fr = frameFor('exit', 'portal', 0, 0, ((TNOW * (REDUCE ? 0.8 : 1.4)) | 0) & 1, 0)
  if (fr === null) return
  resetLayA()
  // layer order in the art: 0 floor ring, 1 beam, 2 portal body, 3 rim glow
  LAYA[0] = 0.55 + 0.45 * pulse
  LAYA[1] = 0.62 + 0.38 * pulse
  LAYA[3] = 0.7 + 0.3 * pulse
  S.swayA = 0.004 * unit; S.swayP = TNOW * 0.5 + ph
  planShadow(sx, fwd, unit, EXIT_SPEC.w * 0.7, 0.45)
  planFrame(fr, sx, floorY, unit, fwd, false, 1, 0)
}

// a co-op player's motion is inferred from position changes between frames (the entity objects are rebuilt every frame)
// Records are matched by the entity's id/key when it has one; otherwise by name and the nearest record within a couple of units
// (two unnamed remote players both arrive as 'wanderer'), each record claimed at most once per planSprites call.
const MOTION = []
let FRAME_N = 0
function playerMoving(e) {
  const id = e.id !== undefined ? e.id : e.key, name = e.name || ''
  let m = null, best = 6.25
  for (let i = 0; i < MOTION.length; i++) {
    const r = MOTION[i]
    if (r.claim === FRAME_N) continue
    if (id !== undefined) { if (r.id === id) { m = r; break }; continue }
    if (r.id !== undefined || r.name !== name) continue
    const d2 = (r.x - e.x) * (r.x - e.x) + (r.y - e.y) * (r.y - e.y)
    if (d2 < best) { best = d2; m = r }
  }
  if (m === null) {
    if (MOTION.length >= 32) MOTION.shift()
    MOTION.push({ id, name, x: e.x, y: e.y, t: TNOW, mv: 0, claim: FRAME_N })
    return false
  }
  m.claim = FRAME_N
  const dt = TNOW - m.t
  if (dt >= 0.08 || dt < 0) {
    const sp = dt > 0 ? hyp(e.x - m.x, e.y - m.y) / dt : 0
    m.mv = sp > 0.5 ? 1 : sp < 0.15 ? 0 : m.mv
    m.x = e.x; m.y = e.y; m.t = TNOW
  }
  return m.mv > 0
}

// test hook: the motion verdicts for one frame's remote players at time t (what planSprites asks per player)
export function motionProbe(players, t) { TNOW = t; FRAME_N++; return players.map(playerMoving) }

// A remote player's heartbeat fields (game.js ENTITY_FILLS.player; undefined / false for a legacy peer, which draws exactly as before):
// thin and not seen by a friend's polaroid -> a faint drifting 0.36 (the drop-in's alpha), down -> half of that, lit (their own light on)
// -> a warm cast, and a down friend's plate reads 'name · down' — built into the plate, never written back to e.name (the motion records
// key on the name).
function planPerson(e, isNpc) {
  const sx = S.sx, fwd = S.fwd, fogT = S.fogT, side = S.side
  const spec = isNpc ? PERSON.npc : PERSON.player
  const unit = CH / fwd, floorY = CHH + unit / 2
  const ph = posPhase(e)
  initSprite(e, isNpc ? 0.94 : (e.thin && !e.seen ? 0.36 + 0.03 * sinc(TNOW * 0.21 + ph) : 0.97) * (e.st === 'down' ? 0.5 : 1))
  let facing = FACING_FRONT
  if (!isNpc && e.angle !== undefined && Math.abs(wrapAngle(e.angle - Math.atan2(CAMY - e.y, CAMX - e.x))) > (2 * Math.PI) / 3) facing = FACING_BACK
  const moving = !isNpc && playerMoving(e)
  const anim = moving ? ((TNOW * 2.4 + ph) * 2 | 0) & 1 : 0
  if (moving) { S.swayA = 0.014 * unit; S.swayP = TNOW * 1.2 + ph } else { S.swayA = (isNpc ? 0.006 : 0.008) * unit; S.swayP = TNOW * 0.3 + ph }
  setRim(e)
  if (!isNpc && e.lit) { S.tg *= 0.92; S.tb *= 0.7 }     // their light is on: the reflected colour warms (red kept, green 0.92, blue 0.7)
  const fr = frameFor('person', isNpc ? 'npc' : 'player', 0, moving ? 1 : 0, anim, FACING_FRONT)
  if (fr === null) return
  resetLayA()
  if (facing === FACING_BACK) for (let i = 1; i < fr.layers.length; i++) LAYA[i] = 0.35     // seen from behind the lamp is mostly hidden
  const lift = moving ? 0.008 * Math.abs(sinc(TNOW * 1.2 + ph)) : 0
  planShadow(sx, fwd, unit, spec.w * 0.55, 0.45)
  planFrame(fr, sx, floorY, unit, fwd, false, 1, lift)
  if (e.name) {
    let p = POOL[PLATES.length]
    if (!p) { p = POOL[PLATES.length] = { sx: 0, y: 0, name: '', alpha: 1, speech: undefined, hp: undefined } }
    p.sx = sx; p.y = floorY - (spec.h + lift + 0.03) * unit; p.name = !isNpc && e.st === 'down' ? e.name + ' · down' : e.name; p.alpha = (1 - fogT) * 0.96; p.speech = e.chatText; p.hp = e.hp
    PLATES.push(p)
  }
}

let ERR_LOGGED = 0

// planSprites(fs, entities) -> PLAN { recs, count, sprites, plates }    (reused: read it before the next call)
// Sort far-to-near, cull what is behind the player / off-screen / beyond the fog, and plan each entity's layers. `fs` needs W H HH fog fogRgb
// flicker t dt hf player light lights comfort levelKey opts (see the file header); the z-buffer is NOT needed — occlusion is the backend's
// per-column (CPU) or per-pixel (GPU) test against the depth in each record.
export function planSprites(fs, entities) {
  PLATES.length = 0
  NREC = 0; PLAN.count = 0; PLAN.sprites = 0
  if (!entities || entities.length === 0) return PLAN
  const { W, H, HH, fog, player } = fs
  CW = W; CH = H; CHH = HH
  GEN_MS = 0
  FRAME_N++
  if (fs.levelKey !== LAST_LEVEL) { LAST_LEVEL = fs.levelKey; queueLevel(fs.levelKey) }
  CAMX = player.x; CAMY = player.y; CAMA = player.angle
  CA = Math.cos(CAMA); SAN = Math.sin(CAMA)
  // at the lit tiers the flicker is already carried spatially by the light model (light.at()), so a second global dip here
  // would blink sprites to half brightness while the world barely moves: FLICK stays 1 and the fog colour is unscaled
  FLICK = (fs.flicker == null || (fs.light && fs.light.enabled === true) || (fs.handled && fs.handled.flicker)) ? 1 : fs.flicker
  TNOW = fs.t || 0
  REDUCE = !!(fs.comfort && fs.comfort.reduceFlicker)
  const fr = fs.fogRgb || [200, 200, 200]
  FOGR = fr[0] * FLICK; FOGG = fr[1] * FLICK; FOGB = fr[2] * FLICK
  const mean = (fr[0] + fr[1] + fr[2]) / 3 || 1
  HARM_R = 1 + 0.22 * (fr[0] / mean - 1); HARM_G = 1 + 0.22 * (fr[1] / mean - 1); HARM_B = 1 + 0.22 * (fr[2] / mean - 1)
  LIGHT = (fs.opts && fs.opts.spriteLightOverride) || fs.light || null
  LIGHT_ON = !!(LIGHT && LIGHT.enabled === true)
  FLASH = !!(fs.lights && fs.lights.flashlight)
  const HF = fs.hf
  const tanLim = Math.tan(Math.min(1.45, HF + 0.1))

  let n = 0
  for (let i = 0; i < entities.length; i++) {
    const e = entities[i]
    const ex = e.x - CAMX, ey = e.y - CAMY
    const fwd = ex * CA + ey * SAN                       // perpendicular depth: what the z-buffer holds
    const near = (e.kind === 'prop' || e.kind === 'sight' || e.kind === 'machine' || e.kind === 'npc') ? NEAR_STATIC : 0.35
    if (!(fwd >= near)) continue                            // static bodies are solid (never entered); moving ones keep the fill-cost bound
    const reach = e.kind === 'exit' ? fog * 1.35 : fog
    if (fwd > reach) continue
    const lat = -ex * SAN + ey * CA                      // + = screen right
    const lim = fwd * tanLim + 0.8
    if (lat > lim || lat < -lim) continue
    const d2 = ex * ex + ey * ey, key = e.kind === 'prop' ? d2 : d2 * 0.05
    if (n >= MAXS) {
      // over the cap: drop the least important thing (a far prop before a far exit / note / creature / near prop), not the
      // one that happened to come last in the list
      let w = 0
      for (let q = 1; q < n; q++) if (SK[q] > SK[w]) w = q
      if (!(key < SK[w])) continue
      for (let q = w; q < n - 1; q++) { SE[q] = SE[q + 1]; SD[q] = SD[q + 1]; SF[q] = SF[q + 1]; SL[q] = SL[q + 1]; SK[q] = SK[q + 1] }
      n--
    }
    SE[n] = e; SD[n] = d2; SF[n] = fwd; SL[n] = lat; SK[n] = key
    // insertion sort, far to near (n is small after culling; no allocation)
    let j = n
    while (j > 0 && SD[j - 1] < SD[j]) {
      const td = SD[j]; SD[j] = SD[j - 1]; SD[j - 1] = td
      const tf = SF[j]; SF[j] = SF[j - 1]; SF[j - 1] = tf
      const tl = SL[j]; SL[j] = SL[j - 1]; SL[j - 1] = tl
      const te = SE[j]; SE[j] = SE[j - 1]; SE[j - 1] = te
      const tk = SK[j]; SK[j] = SK[j - 1]; SK[j - 1] = tk
      j--
    }
    n++
  }

  const halfW = W / 2
  for (let i = 0; i < n; i++) {
    const e = SE[i], fwd = SF[i], lat = SL[i]
    S.fogT = fwd >= fog ? 1 : fwd / fog
    S.sx = halfW + (Math.atan2(lat, fwd) / HF) * halfW
    S.fwd = fwd; S.side = lat
    SI = i
    try {
      const k = e.kind
      if (k === 'item') planItem(e)
      else if (k === 'prop') planProp(e)
      else if (k === 'exit') planExit(e)
      else if (k === 'note') planNote(e)
      else if (k === 'machine') planMachine(e)
      else if (k === 'sight') planSight(e)
      else if (k === 'player') planPerson(e, false)
      else if (k === 'npc') planPerson(e, true)
      else if (k === undefined && (e.variant !== undefined || e.type !== undefined)) planCreature(e)   // enemies and apparitions carry no kind; an unknown kind is not a creature
    } catch (err) {
      if (ERR_LOGGED++ < 3 && typeof console !== 'undefined') console.error('gfx-sprites: draw failed for ' + (e && (e.kind || e.variant)) + ': ' + (err && err.stack || err))
    }
    SE[i] = undefined   // do not retain the frame's entity objects
  }
  if (WARM_WAIT > 0) WARM_WAIT--
  // time-sliced, not dt-gated: at most one background frame per call, only when this call built (almost) nothing itself, and
  // WARM_WAIT spreads the expensive ones out, so a slow device warms up too, at a few ms per frame amortised
  else if (WARMQ.length > 0 && GEN_MS < 4) { try { warmStep(fs.dt > 0.024) } catch (err) { WARMQ.length = 0; WARMQ_KEYS.clear() } }
  PLAN.count = NREC; PLAN.sprites = n; PLAN.W = W
  return PLAN
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 7. THE CPU BLITTER — the plan's records into the low-res world buffer
// ════════════════════════════════════════════════════════════════════════════════════════════════

let BUF = null, ZB = null, BW = 0          // the frame being blitted into: buffer, z-buffer, row stride
let RUNS = new Int32Array(2048)
function growRuns(n) { if (RUNS.length < n * 2 + 4) RUNS = new Int32Array(n * 2 + 64) }
// per-blit column tables, indexed by x - xa (grown, never shrunk): the texel column of each screen column, and the lit-face terms
let TXT = new Int32Array(1024)
let CMR = new Int32Array(1024), CMG = new Int32Array(1024), CMB = new Int32Array(1024)
let CMF = new Float64Array(1024)
function growCols(n) {
  if (TXT.length >= n) return
  const m = n + 256
  TXT = new Int32Array(m); CMR = new Int32Array(m); CMG = new Int32Array(m); CMB = new Int32Array(m); CMF = new Float64Array(m)
}
// the first x in [lo, hi) whose texel column is >= v (TXT non-decreasing over [lo, hi)), or hi; firstLT: < v, TXT non-increasing
function firstGE(lo, hi, off, v) { while (lo < hi) { const m = (lo + hi) >> 1; if (TXT[m - off] >= v) hi = m; else lo = m + 1 } return lo }
function firstLT(lo, hi, off, v) { while (lo < hi) { const m = (lo + hi) >> 1; if (TXT[m - off] < v) hi = m; else lo = m + 1 } return lo }

// Blit one record (a layer's mip) into the world buffer over its screen rect, z-tested per column against its depth, honouring the warp /
// rim / dissolve. Rows outer for cache locality; columns come as visible runs; the texel column advances incrementally (tf += dtf from the
// run's first column; mirroring runs the same walk backwards). Three blends: screen (a glow), plain (the lit over-blend, the common case) and
// full (rim light / dissolve). What makes it cheap, without changing a byte:
//   * each texel row's opaque span [c0, c1) (mip.rs): an empty texel row is skipped, and the columns whose texel lies outside the span —
//     they could only read a transparent texel — are not visited (the texel column is monotonic along a run)
//   * an UNWARPED screen / plain layer samples the same texel columns on every row: the walk is done once per blit into TXT, and each row's
//     run is trimmed to the span by binary search on it. A warped row (or the rare unwarped rim / dissolve layer) walks inline: the columns
//     before the span are stepped over with the same additions (so the walk stays exact) and the walk stops two columns after it has passed
//     the span (the margin covers the rounding of the accumulated steps)
//   * the lit-face gradient depends on the column only: tabulated once per blit
//   * texels and buffer pixels are read as int32 (`| 0`): the bitwise maths is the same, and V8 boxes a uint32 read above 2^31 into a heap
//     number, per pixel
function blitRecord(r) {
  const X0 = r.X0, Yt = r.Yt, Yb = r.Yb, depth = r.depth, mirror = r.mirror
  const xa = r.xa, xb = r.xb, ya = r.ya, yb = r.yb
  const sw = r.X1 - X0, sh = Yb - Yt
  const lean = r.lean, swayA = r.swayA, swayP = r.swayP, rippleA = r.rippleA, rippleP = r.rippleP
  const warp = lean !== 0 || swayA !== 0 || rippleA !== 0
  growRuns((xb - xa) >> 1)
  const nr = visibleRuns(ZB, xa, xb, depth, RUNS)
  if (nr === 0) return

  const mip = r.mip
  const tw = mip.w, th = mip.h, tpx = mip.px, rs = mip.rs
  const rimP = r.rim ? mip.rim : null
  const sxF = tw / sw, syF = th / sh
  const buf = BUF, W = BW
  const mr = r.mr, mg = r.mg, mb = r.mb, fr = r.fr, fg = r.fg, fb = r.fb, A255 = r.A / 255
  const opaqueA = r.A >= 0.9999
  const fr255 = 255 * fr, fg255 = 255 * fg, fb255 = 255 * fb
  const screen = r.screen
  const cm0 = r.cm0, cmK = r.cmK, cmX = r.cmX
  const useCm = cmK !== 0 || cm0 !== 1
  const dith0 = r.dith, ddx = r.dx, ddy = r.dy, dph = r.dph
  const rimS = r.rimS, rimB = r.rimB, rimR = r.rimR, rimG = r.rimG, rimBl = r.rimBl
  const plain = rimP === null && dith0 === 0
  const txMax = tw - 1
  // 8.8 fixed point for the two hot loops: integer multiplies, no float<->int conversions per pixel
  const A256 = (r.A * 256) | 0
  const mri = (mr * 256) | 0, mgi = (mg * 256) | 0, mbi = (mb * 256) | 0
  const fri = (fr * 256) | 0, fgi = (fg * 256) | 0, fbi = (fb * 256) | 0
  const fr255i = (fr255 * 256) | 0, fg255i = (fg255 * 256) | 0, fb255i = (fb255 * 256) | 0
  const dtf = mirror ? -sxF : sxF

  // the lit-face gradient depends on the column only: once per blit, not per pixel
  growCols(xb - xa)
  if (useCm) {
    for (let x = xa; x < xb; x++) {
      let cm = cm0 + cmK * (x - cmX)
      if (cm < 0.15) cm = 0.15
      const i = x - xa
      if (screen) CMR[i] = (mri * cm) | 0
      else if (plain) { const ci = (cm * 256) | 0; CMR[i] = (mri * ci) >> 8; CMG[i] = (mgi * ci) >> 8; CMB[i] = (mbi * ci) >> 8 }
      else CMF[i] = cm
    }
  }

  // an unwarped screen / plain layer: every row walks the same texel columns, so the walk is done once here, run by run
  const useTxt = !warp && (screen || plain)
  if (useTxt) {
    const xl = Math.ceil(X0 - 0.5), xr = Math.ceil(X0 + sw - 0.5)
    for (let q = 0; q < nr; q++) {
      let xs = RUNS[q * 2], xe = RUNS[q * 2 + 1]
      if (xs < xl) xs = xl
      if (xe > xr) xe = xr
      if (xs >= xe) continue
      let tf = mirror ? tw - (xs + 0.5 - X0) * sxF : (xs + 0.5 - X0) * sxF
      for (let x = xs; x < xe; x++) {
        let tx = tf | 0
        tf += dtf
        if (tx > txMax) tx = txMax
        else if (tx < 0) tx = 0
        TXT[x - xa] = tx
      }
    }
  }

  for (let y = ya; y < yb; y++) {
    let ty = ((y + 0.5 - Yt) * syF) | 0
    if (ty >= th) ty = th - 1
    // the texel row's opaque columns [c0, c1): an empty texel row draws nothing
    let c0 = 0, c1 = tw
    if (rs !== undefined) { c0 = rs[ty * 2]; c1 = rs[ty * 2 + 1]; if (c1 <= c0) continue }
    const rowT = ty * tw
    let rx0 = X0
    if (warp) {
      const v = (Yb - (y + 0.5)) / sh
      rx0 += lean * v * v + swayA * sinc(swayP + v * 0.55) * v + rippleA * sinc(rippleP + v * 2.4) * (1 - v * 0.55)
    }
    const xl = Math.ceil(rx0 - 0.5), xr = Math.ceil(rx0 + sw - 0.5)
    // the dissolve comes in drifting bands, not an even speckle
    const dith = dith0 > 0 ? dith0 * (0.25 + 1.5 * (0.5 + 0.5 * sinc(y * 0.021 + dph))) : 0
    const rowB = y * W
    for (let q = 0; q < nr; q++) {
      let xs = RUNS[q * 2], xe = RUNS[q * 2 + 1]
      if (xs < xl) xs = xl
      if (xe > xr) xe = xr
      if (xs >= xe) continue
      if (useTxt) {
        if (mirror) { xs = firstLT(xs, xe, xa, c1); xe = firstLT(xs, xe, xa, c0) } else { xs = firstGE(xs, xe, xa, c0); xe = firstGE(xs, xe, xa, c1) }
        if (screen) {
          for (let x = xs; x < xe; x++) {
            const p = tpx[rowT + TXT[x - xa]] | 0
            if ((p >>> 24) === 0) continue
            const s0 = useCm ? CMR[x - xa] : mri
            const bi = rowB + x, d = buf[bi] | 0
            const dr = d & 255, dg = (d >> 8) & 255, db = (d >> 16) & 255
            // screen: d + s * (255 - d) / 255, with s the glow intensity scaled by the layer's strength
            let r2 = dr + ((((p & 255) * s0) >> 8) * (255 - dr) * 257 >> 16), g2 = dg + (((((p >> 8) & 255) * s0) >> 8) * (255 - dg) * 257 >> 16), b2 = db + (((((p >> 16) & 255) * s0) >> 8) * (255 - db) * 257 >> 16)
            if (r2 > 255) r2 = 255
            if (g2 > 255) g2 = 255
            if (b2 > 255) b2 = 255
            buf[bi] = (255 << 24) | (b2 << 16) | (g2 << 8) | r2
          }
        } else {                                             // plain (a TXT layer is screen or plain)
          for (let x = xs; x < xe; x++) {
            const p = tpx[rowT + TXT[x - xa]] | 0
            const a = p >>> 24
            if (a === 0) continue
            let mrc = mri, mgc = mgi, mbc = mbi
            if (useCm) { const i = x - xa; mrc = CMR[i]; mgc = CMG[i]; mbc = CMB[i] }
            const bi = rowB + x
            let r2, g2, b2
            if (a === 255 && opaqueA) {
              r2 = ((p & 255) * mrc + fr255i + 128) >> 8; g2 = (((p >> 8) & 255) * mgc + fg255i + 128) >> 8; b2 = (((p >> 16) & 255) * mbc + fb255i + 128) >> 8
            } else {
              const d = buf[bi] | 0, ki = 256 - ((a * A256) >> 8)
              r2 = ((d & 255) * ki + (p & 255) * mrc + a * fri + 128) >> 8
              g2 = (((d >> 8) & 255) * ki + ((p >> 8) & 255) * mgc + a * fgi + 128) >> 8
              b2 = (((d >> 16) & 255) * ki + ((p >> 16) & 255) * mbc + a * fbi + 128) >> 8
            }
            if (r2 > 255) r2 = 255
            if (g2 > 255) g2 = 255
            if (b2 > 255) b2 = 255
            buf[bi] = (255 << 24) | (b2 << 16) | (g2 << 8) | r2
          }
        }
        continue
      }
      let tf = mirror ? tw - (xs + 0.5 - rx0) * sxF : (xs + 0.5 - rx0) * sxF
      // trim the walk to the span: step over the columns before it (exactly, without reading texels), stop two columns after it
      if (mirror) {
        if (c1 <= txMax && tf >= c1) { let k = Math.floor((tf - c1) / sxF) - 1; if (k > xe - xs) k = xe - xs; for (let i = 0; i < k; i++) tf += dtf; if (k > 0) xs += k }
        if (c0 > 0 && tf >= c0) { const n = xs + Math.floor((tf - c0) / sxF) + 3; if (n < xe) xe = n }
      } else {
        if (c0 > 0 && tf < c0) { let k = Math.ceil((c0 - tf) / sxF) - 2; if (k > xe - xs) k = xe - xs; for (let i = 0; i < k; i++) tf += dtf; if (k > 0) xs += k }
        if (c1 <= txMax && tf < c1) { const n = xs + Math.ceil((c1 - tf) / sxF) + 2; if (n < xe) xe = n }
      }
      if (screen) {
        for (let x = xs; x < xe; x++) {
          let tx = tf | 0
          tf += dtf
          if (tx > txMax) tx = txMax
          else if (tx < 0) tx = 0
          const p = tpx[rowT + tx] | 0
          if ((p >>> 24) === 0) continue
          const s0 = useCm ? CMR[x - xa] : mri
          const bi = rowB + x, d = buf[bi] | 0
          const dr = d & 255, dg = (d >> 8) & 255, db = (d >> 16) & 255
          // screen: d + s * (255 - d) / 255, with s the glow intensity scaled by the layer's strength
          let r2 = dr + ((((p & 255) * s0) >> 8) * (255 - dr) * 257 >> 16), g2 = dg + (((((p >> 8) & 255) * s0) >> 8) * (255 - dg) * 257 >> 16), b2 = db + (((((p >> 16) & 255) * s0) >> 8) * (255 - db) * 257 >> 16)
          if (r2 > 255) r2 = 255
          if (g2 > 255) g2 = 255
          if (b2 > 255) b2 = 255
          buf[bi] = (255 << 24) | (b2 << 16) | (g2 << 8) | r2
        }
      } else if (plain) {
        for (let x = xs; x < xe; x++) {
          let tx = tf | 0
          tf += dtf
          if (tx > txMax) tx = txMax
          else if (tx < 0) tx = 0
          const p = tpx[rowT + tx] | 0
          const a = p >>> 24
          if (a === 0) continue
          let mrc = mri, mgc = mgi, mbc = mbi
          if (useCm) { const i = x - xa; mrc = CMR[i]; mgc = CMG[i]; mbc = CMB[i] }
          const bi = rowB + x
          let r2, g2, b2
          if (a === 255 && opaqueA) {
            r2 = ((p & 255) * mrc + fr255i + 128) >> 8; g2 = (((p >> 8) & 255) * mgc + fg255i + 128) >> 8; b2 = (((p >> 16) & 255) * mbc + fb255i + 128) >> 8
          } else {
            const d = buf[bi] | 0, ki = 256 - ((a * A256) >> 8)
            r2 = ((d & 255) * ki + (p & 255) * mrc + a * fri + 128) >> 8
            g2 = (((d >> 8) & 255) * ki + ((p >> 8) & 255) * mgc + a * fgi + 128) >> 8
            b2 = (((d >> 16) & 255) * ki + ((p >> 16) & 255) * mbc + a * fbi + 128) >> 8
          }
          if (r2 > 255) r2 = 255
          if (g2 > 255) g2 = 255
          if (b2 > 255) b2 = 255
          buf[bi] = (255 << 24) | (b2 << 16) | (g2 << 8) | r2
        }
      } else {
        for (let x = xs; x < xe; x++) {
          let tx = tf | 0
          tf += dtf
          if (tx > txMax) tx = txMax
          else if (tx < 0) tx = 0
          const ti = rowT + tx
          const p = tpx[ti] | 0
          const a = p >>> 24
          if (a === 0) continue
          const cm = useCm ? CMF[x - xa] : 1
          const bi = rowB + x
          const d = buf[bi] | 0
          let ak = a * A255, dk = 1
          if (dith > 0 && DITH[(((x >> 1) + ddx) & 63) | ((((y >> 1) + ddy) & 63) << 6)] < (rimP !== null ? dith * (0.15 + 2.7 * (rimP[ti] > 128 ? rimP[ti] - 128 : 128 - rimP[ti]) * (1 / 127)) : dith)) { dk = 0.55; ak *= 0.55 }   // it erodes from its outline inward
          const k = 1 - ak
          const m0 = cm * dk
          let r2 = (d & 255) * k + (p & 255) * mr * m0 + a * fr * dk
          let g2 = ((d >> 8) & 255) * k + ((p >> 8) & 255) * mg * m0 + a * fg * dk
          let b2 = ((d >> 16) & 255) * k + ((p >> 16) & 255) * mb * m0 + a * fb * dk
          if (rimP !== null) {
            const rv = rimP[ti] - 128
            const e = (mirror ? -rv : rv) * rimS + (rv < 0 ? -rv : rv) * rimB
            if (e > 0) { r2 += rimR * e; g2 += rimG * e; b2 += rimBl * e }
          }
          if (r2 > 255) r2 = 255
          if (g2 > 255) g2 = 255
          if (b2 > 255) b2 = 255
          buf[bi] = (255 << 24) | (b2 << 16) | (g2 << 8) | r2
        }
      }
    }
  }
}

// Blit a plan (planSprites' result, for a frame of plan.W columns) into the world buffer, every record in paint order. A record the blitter
// cannot draw (a malformed mip) drops the rest of its sprite, as a planning failure does.
export function blitPlan(buf32, zbuffer, plan) {
  const n = plan.count, recs = plan.recs
  if (n === 0) return
  BUF = buf32; ZB = zbuffer; BW = plan.W
  let skip = -1
  for (let i = 0; i < n; i++) {
    const r = recs[i]
    if (r.si === skip) continue
    try { blitRecord(r) } catch (err) {
      skip = r.si
      if (ERR_LOGGED++ < 3 && typeof console !== 'undefined') console.error('gfx-sprites: blit failed: ' + (err && err.stack || err))
    }
  }
  BUF = null; ZB = null      // do not retain the frame's buffers
}

// The CPU sprite pass: plan (section 6), then blit. Returns the nameplate records for the post stage (empty when there are no people).
export function drawSprites(buf32, zbuffer, fs, entities) {
  const P = planSprites(fs, entities)
  blitPlan(buf32, zbuffer, P)
  return P.plates
}
