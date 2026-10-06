// placement.js — settled placement. Furniture reads as put there by people: a cabinet flush against the corridor wall, a barrel in
// the corner, the payphone on the wall, the lost soul leaning against the side. And a sprint down the long hall is never
// interrupted: whatever hugs a corridor wall must leave the player's box a lane (LANE_MIN) or it stops being a body you push
// against and becomes clutter you edge through (collide.js honours 'clutter' vs 'solid').
//
// Pure: classifies a cell from floorFn(ix, iy) -> true = open (the grid reader), mutates collider records in place. Called once per
// chunk placement (decor.js settleChunk), never per frame.
//
// Compass, shared with collide.js: N = -y, E = +x, S = +y, W = -x.
import { PLAYER_R, PLAYER_WALL_R, footprintRadius, visualHalf } from './collide.js'

export const HUG_GAP = 0.02           // the sprite's visual edge sits this far off the wall face
export const LANE_MIN = 0.30          // the lane a hugged corridor body must leave the player's centre, else it is clutter
export const JUNCTION_MAX_R = 0.22    // the biggest footprint that may stand centred in a wall-less junction cell

// what you hear when you edge through clutter (collide reports clutterEntered with the record's type)
export const CLUTTER_LINES = {
  couch: 'you edge past the couch.',
  chairpile: 'you squeeze through the chairs. they shift.',
  tvwall: 'you squeeze past the televisions. they are all on.',
  transformer: 'you edge past the transformer. it is warm.',
  crate: 'you edge past the crate.',
  default: 'you edge past it.',
}

const SIDES = ['N', 'E', 'S', 'W']

// 'room' when the cell is part of any fully open 2x2 block; else 'nook' with exactly one open 4-neighbour; else 'corridor' when
// the open neighbours lie on one axis (the hall cells and doorways); else 'junction' (bends, crossings, tees).
export function classifyCell(floorFn, wx, wy) {
  const ix = Math.floor(wx), iy = Math.floor(wy)
  for (let dy = -1; dy <= 0; dy++) {
    for (let dx = -1; dx <= 0; dx++) {
      const x = ix + dx, y = iy + dy
      if (floorFn(x, y) && floorFn(x + 1, y) && floorFn(x, y + 1) && floorFn(x + 1, y + 1)) return 'room'
    }
  }
  const n = floorFn(ix, iy - 1), s = floorFn(ix, iy + 1), e = floorFn(ix + 1, iy), w = floorFn(ix - 1, iy)
  const count = (n ? 1 : 0) + (s ? 1 : 0) + (e ? 1 : 0) + (w ? 1 : 0)
  if (count === 1) return 'nook'
  const alongY = n || s, alongX = e || w
  if (alongY !== alongX) return 'corridor'
  return 'junction'
}

// { N, E, S, W }: true = that neighbour is a wall
export function wallSides(floorFn, wx, wy) {
  const ix = Math.floor(wx), iy = Math.floor(wy)
  return { N: !floorFn(ix, iy - 1), E: !floorFn(ix + 1, iy), S: !floorFn(ix, iy + 1), W: !floorFn(ix - 1, iy) }
}

// the axis you walk along: walls N and S -> 'x', walls E and W -> 'y', neither or both -> null
export function corridorAxis(sides) {
  const ns = sides.N && sides.S, ew = sides.E && sides.W
  if (ns && !ew) return 'x'
  if (ew && !ns) return 'y'
  return null
}

// settle(rec, cls, sides, r, vis, side): mutates rec.x / rec.y / rec.cls / rec.hug / rec.cellCls.
//   HUG: in any cell with a wall side the centre moves to vis + HUG_GAP from that wall face (so the drawn edge nearly touches it),
//        `side` choosing among several (+1 the first of [N, E, S, W] that is a wall, -1 the last).
//   LANE RULE ('corridor' / 'nook'): free = (1 - PLAYER_WALL_R) - (vis + HUG_GAP + r + PLAYER_R); below LANE_MIN -> 'clutter'.
//   'junction' without a wall: solid only up to JUNCTION_MAX_R; with one: hug, then the lane rule.
//   'room': full footprint, hugging a wall if there is one.
//   'none' records (papers, the pallet, weeds) are never moved or reclassed.
export function settle(rec, cls, sides, r, vis, side) {
  rec.cellCls = cls
  if (rec.cls === 'none') { rec.hug = null; return rec }
  const ix = Math.floor(rec.x), iy = Math.floor(rec.y)
  let hug = null
  if (side > 0) { for (let i = 0; i < 4; i++) if (sides[SIDES[i]]) { hug = SIDES[i]; break } }
  else { for (let i = 3; i >= 0; i--) if (sides[SIDES[i]]) { hug = SIDES[i]; break } }
  if (hug) {
    const off = vis + HUG_GAP
    if (hug === 'N') rec.y = iy + off
    else if (hug === 'S') rec.y = iy + 1 - off
    else if (hug === 'E') rec.x = ix + 1 - off
    else rec.x = ix + off
  }
  rec.hug = hug
  const lane = () => {
    const free = (1 - PLAYER_WALL_R) - (vis + HUG_GAP + r + PLAYER_R)
    if (free < LANE_MIN) rec.cls = 'clutter'
  }
  if (cls === 'corridor' || cls === 'nook') lane()
  else if (cls === 'junction') {
    if (hug) lane()
    else if (r > JUNCTION_MAX_R) rec.cls = 'clutter'
  }
  return rec
}

const OPPOSITE = { N: 'S', S: 'N', E: 'W', W: 'E' }

// settleChunk(records, floorFn, radiusFn, visFn, sideFn): every record settled in place by its own cell; returns records.
// Then the pair rule: the lane rule is per body, so two solids hugging opposite walls of one corridor / nook cell can each pass it
// and together close the cell. When the gap between their discs, 1 - (visA + HUG_GAP + rA) - (visB + HUG_GAP + rB), is under
// 2 PLAYER_R + 0.02 the smaller footprint (the later on a tie) becomes clutter.
export function settleChunk(records, floorFn, radiusFn = footprintRadius, visFn = visualHalf, sideFn) {
  for (let i = 0; i < records.length; i++) {
    const rec = records[i]
    const cls = classifyCell(floorFn, rec.x, rec.y)
    const sides = wallSides(floorFn, rec.x, rec.y)
    settle(rec, cls, sides, radiusFn(rec.kind, rec.type), visFn(rec.kind, rec.type), sideFn ? sideFn(rec) : 1)
  }
  for (let i = 0; i < records.length; i++) {
    const a = records[i]
    for (let j = i + 1; j < records.length && a.cls === 'solid'; j++) {
      const b = records[j]
      if (b.cls !== 'solid' || !a.hug || b.hug !== OPPOSITE[a.hug]) continue
      if (a.cellCls !== 'corridor' && a.cellCls !== 'nook') continue
      if (Math.floor(a.x) !== Math.floor(b.x) || Math.floor(a.y) !== Math.floor(b.y)) continue
      const ra = radiusFn(a.kind, a.type), rb = radiusFn(b.kind, b.type)
      const gap = 1 - (visFn(a.kind, a.type) + HUG_GAP + ra) - (visFn(b.kind, b.type) + HUG_GAP + rb)
      if (gap < 2 * PLAYER_R + 0.02) (ra < rb ? a : b).cls = 'clutter'
    }
  }
  return records
}
