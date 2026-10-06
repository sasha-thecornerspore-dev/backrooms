// collide.js — solid bodies. The ONE radius table (player, furniture, creatures), a per-chunk collider index, the circle
// resolver (wall box, solid push-out with the corridor bias, clutter and pallet edges), creatures as bodies, the contact
// edges, and the legacy point mover game.js dispatches to when the pref is off.
//
// Pure: imports only the sprite spec tables (the sizes the art is drawn at are the sizes you collide with) and CHUNK_SIZE
// (the index buckets by chunk). Hot paths allocate nothing: the query scratch, the report and the touching set are reused.
//
// Compass: N = -y, S = +y, E = +x, W = -x (the map's up is north). A record's `hug` is the wall it leans on; the free side
// is the opposite one, and that is where the tangential bias sends you.
import { PROP_SPEC, SIGHT_SPEC, MACHINE_SPEC, PERSON, FIG } from './gfx-sprites.js'
import { CHUNK_SIZE } from './world.js'

export const PLAYER_R = 0.16          // the player's radius against bodies
export const PLAYER_WALL_R = 0.12     // half-size of the player's box against wall faces

// ── the radius table ────────────────────────────────────────────────────────────────────────────────────────────────────
function specFor(kind, type) {
  if (kind === 'machine') return MACHINE_SPEC
  if (kind === 'npc') return PERSON.npc
  if (kind === 'sight') return SIGHT_SPEC[type] || PROP_SPEC.box
  return PROP_SPEC[type] || PROP_SPEC.box                       // unknown prop -> a box
}
// footprint = 0.45 of the drawn width: you stop a touch inside the sprite's silhouette, which reads as "against it"
export function footprintRadius(kind, type) { return specFor(kind, type).w * 0.45 }
export function visualHalf(kind, type) { return specFor(kind, type).w / 2 }
// creatures are a little thinner than their art (0.375 of the width): max (crawler .375) + PLAYER_R = .535 < .62 contact damage
export function creatureRadius(variant) { return (FIG[variant] || FIG.shade).w * 0.375 }

// What a body does to you: 'solid' pushes, 'none' is walked over (the pallet taps once on entry). 'clutter' (slows, never
// pushes) is assigned per record by placement.js, never here. This release has no pushables. Unknown type -> 'solid'.
export const SOLID_CLASS = {
  chair: 'solid', cabinet: 'solid', box: 'solid', crate: 'solid', cone: 'solid', papers: 'none', plant: 'solid',
  pallet: 'none', barrel: 'solid', drum: 'solid', couch: 'solid', cart: 'solid', pipe: 'solid', valve: 'solid',
  vent: 'solid', toolbox: 'solid', transformer: 'solid', 'cabinet-e': 'solid', spool: 'solid', sign: 'solid',
  trash: 'solid', tire: 'solid', weeds: 'none',
  tvwall: 'solid', chairpile: 'solid', payphone: 'solid', mannequin: 'solid',
  machine: 'solid', npc: 'solid',
}

// colliderFor(kind, decorRecord) -> record { id, x, y, r, cls, kind, type, key, cx, cy, cellCls, hug }
// cellCls ('corridor'|'nook'|'junction'|'room') and hug ('N'|'E'|'S'|'W'|null) are written by placement.js's settle.
// ids are small positive ints (the touching set is an Int32 ring); a record re-made after a chunk reload is a new id.
let NEXT_ID = 1
export function colliderFor(kind, obj) {
  const type = (kind === 'machine' || kind === 'npc') ? kind : (obj.type ?? obj.sightType ?? null)
  const id = NEXT_ID
  NEXT_ID = NEXT_ID >= 0x7fffffff ? 1 : NEXT_ID + 1
  return {
    id, x: obj.x, y: obj.y, r: footprintRadius(kind, type), cls: SOLID_CLASS[type] ?? 'solid',
    kind, type, key: obj.key, cx: Math.floor(obj.x / CHUNK_SIZE), cy: Math.floor(obj.y / CHUNK_SIZE), cellCls: null, hug: null,
  }
}

// ── the index ───────────────────────────────────────────────────────────────────────────────────────────────────────────
// Records live in per-chunk lists keyed by a packed (cx, cy) so a query builds no key strings. query(x, y, r, out) writes
// every record of any class whose circle overlaps (x, y, r) from the 3x3 chunk neighbourhood into the caller's `out`
// (left oversized: read out[0..n)) and returns n.
const pack = (cx, cy) => cx * 65536 + cy                       // injective while |cy| < 32768
function parseKey(key) {
  const i = key.indexOf(',')
  return [Number(key.slice(0, i)), Number(key.slice(i + 1))]
}
export function createColliderIndex() {
  const chunks = new Map()                                      // pack(cx, cy) -> records[]
  let total = 0
  function setChunk(key, records) {
    const [cx, cy] = parseKey(key)
    if (!Number.isFinite(cx) || !Number.isFinite(cy)) return
    const k = pack(cx, cy)
    const prev = chunks.get(k)
    if (prev) total -= prev.length
    const list = records ? records.slice() : []                 // our own copy: the caller may reuse its bundle
    chunks.set(k, list)
    total += list.length
  }
  function dropChunk(key) {
    const [cx, cy] = parseKey(key)
    const k = pack(cx, cy)
    const prev = chunks.get(k)
    if (!prev) return
    total -= prev.length
    chunks.delete(k)
  }
  function query(x, y, r, out) {
    const cx = Math.floor(x / CHUNK_SIZE), cy = Math.floor(y / CHUNK_SIZE)
    let n = 0
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const list = chunks.get(pack(cx + dx, cy + dy))
        if (!list) continue
        for (let i = 0; i < list.length; i++) {
          const c = list[i], ex = c.x - x, ey = c.y - y, R = r + c.r
          if (ex * ex + ey * ey < R * R) out[n++] = c
        }
      }
    }
    return n
  }
  return { setChunk, dropChunk, query, get size() { return total } }
}

// ── the resolver ────────────────────────────────────────────────────────────────────────────────────────────────────────
// the four corners of the player's wall box, open or not (floorFn(ix, iy) -> true = open)
function boxOpen(floorFn, x, y) {
  const R = PLAYER_WALL_R
  const x0 = Math.floor(x - R), x1 = Math.floor(x + R), y0 = Math.floor(y - R), y1 = Math.floor(y + R)
  if (!floorFn(x0, y0)) return false
  if (x1 !== x0 && !floorFn(x1, y0)) return false
  if (y1 !== y0) {
    if (!floorFn(x0, y1)) return false
    if (x1 !== x0 && !floorFn(x1, y1)) return false
  }
  return true
}

const Q = []                                                    // the query scratch for this module's own asks
const COS20 = Math.cos(20 * Math.PI / 180)
const QUERY_PAD = 0.6                                           // a frame's step (<= 0.27 at the dt cap) plus two push-outs
const PUSH_EPS = 1e-4

function notePush(out, c, ex, ey) {
  const n = out.pushN
  for (let i = 0; i < n; i++) if (out.push[i] === c) return     // one report per record per frame
  out.push[n] = c; out.pushNx[n] = ex; out.pushNy[n] = ey
  out.pushN = n + 1
}

// resolveCircle(x, y, nx, ny, index, floorFn, out): the intended move (x, y) -> (nx, ny) against walls and bodies.
// Writes out.x/out.y and a contact report: out.push[0..pushN) are the solids that pushed this frame (with their normals
// in out.pushNx/pushNy, body -> player), out.clutterId/clutterType/clutterEntered, out.stepType ('pallet' once per entry).
// `out` is reused across frames: the clutter and pallet edges compare against what it held last time.
export function resolveCircle(x, y, nx, ny, index, floorFn, out) {
  // (1) walls: today's tryMove, x then y, but a leg only lands where the whole 0.12 box is open
  let px = x, py = y
  if (nx !== px && boxOpen(floorFn, nx, py)) px = nx
  if (ny !== py && boxOpen(floorFn, px, ny)) py = ny
  const wx = px, wy = py                                        // pre-push: wall-free whenever the start was

  if (!out.push) { out.push = []; out.pushNx = []; out.pushNy = [] }
  out.pushN = 0
  const n = index.query(px, py, PLAYER_R + QUERY_PAD, Q)

  // (2) circle push-out against every solid, up to twice (a second body may have been entered by the first push)
  for (let it = 0; it < 2; it++) {
    let moved = false
    for (let i = 0; i < n; i++) {
      const c = Q[i]
      if (c.cls !== 'solid') continue
      let ex = px - c.x, ey = py - c.y
      const R = c.r + PLAYER_R
      const d2 = ex * ex + ey * ey
      if (d2 >= R * R) continue
      let d = Math.sqrt(d2)
      if (d < 1e-9) {                                           // dead centre: back the way you came, else east
        const bx = x - nx, by = y - ny, m = Math.sqrt(bx * bx + by * by)
        if (m > 1e-9) { ex = bx / m; ey = by / m } else { ex = 1; ey = 0 }
        d = 0
      } else { ex /= d; ey /= d }
      const depth = R - d + PUSH_EPS
      let mx = ex * depth, my = ey * depth
      // (3) tangential bias: a near head-on meeting with a body that hugs a corridor wall becomes a slide toward the free
      // side, not a dead stop. The lane's axis is perpendicular to the hug; "head-on" = the normal within 20 deg of it.
      if (c.hug && (c.cellCls === 'corridor' || c.cellCls === 'nook')) {
        const alongX = c.hug === 'N' || c.hug === 'S'
        if ((alongX ? Math.abs(ex) : Math.abs(ey)) >= COS20) {
          if (c.hug === 'N') my += depth
          else if (c.hug === 'S') my -= depth
          else if (c.hug === 'E') mx -= depth
          else mx += depth
        }
      }
      px += mx; py += my
      moved = true
      notePush(out, c, ex, ey)
    }
    if (!moved) break
  }

  // (4) a push never ends in a wall: an axis that landed inside one reverts to its pre-push value
  if ((px !== wx || py !== wy) && !boxOpen(floorFn, px, py)) {
    if (boxOpen(floorFn, px, wy)) py = wy
    else if (boxOpen(floorFn, wx, py)) px = wx
    else { px = wx; py = wy }
  }
  out.x = px; out.y = py

  // (5) clutter slows and a pallet taps; neither pushes
  let clutter = null, pallet = null
  for (let i = 0; i < n; i++) {
    const c = Q[i]
    if (c.cls === 'solid') continue
    const ex = px - c.x, ey = py - c.y, R = c.r + PLAYER_R
    if (ex * ex + ey * ey >= R * R) continue
    if (c.cls === 'clutter') { if (!clutter) clutter = c }
    else if (c.type === 'pallet') { if (!pallet) pallet = c }
  }
  const prevClutter = out.clutterId | 0, prevPallet = out.palletId | 0
  out.clutterId = clutter ? clutter.id : 0
  out.clutterType = clutter ? clutter.type : null
  out.clutterEntered = clutter !== null && clutter.id !== prevClutter
  out.palletId = pallet ? pallet.id : 0
  out.stepType = pallet !== null && pallet.id !== prevPallet ? 'pallet' : null
  return out
}

// ── creatures as bodies ─────────────────────────────────────────────────────────────────────────────────────────────────
// The one rule (hunt.js blocks() uses it too): a move that ends inside a solid creature's radius + PLAYER_R AND closes on
// it is refused; a move that opens the distance is always allowed, so you can never be pinned inside one. Only entities
// within 1.5 u of the end point are consulted (solidFn is never asked about the rest).
const CONSULT_R2 = 1.5 * 1.5
export function creatureBlocks(x0, y0, x1, y1, entities, solidFn) {
  if (!entities) return null
  for (let i = 0; i < entities.length; i++) {
    const e = entities[i]
    const dx = e.x - x1, dy = e.y - y1
    const d1 = dx * dx + dy * dy
    if (d1 > CONSULT_R2) continue
    if (!solidFn(e)) continue
    const R = creatureRadius(e.variant) + PLAYER_R
    if (d1 >= R * R) continue
    const ox = e.x - x0, oy = e.y - y0
    if (d1 < ox * ox + oy * oy) return e
  }
  return null
}

// ── the legacy mover ────────────────────────────────────────────────────────────────────────────────────────────────────
// game.js's old tryMove body, byte for byte in effect: a point against wall cells, x then y. The result object is reused.
const MP = { x: 0, y: 0 }
export function movePoint(x, y, nx, ny, isWall, pcx, pcy) {
  let px = x, py = y
  if (!isWall(nx, py, pcx, pcy)) px = nx
  if (!isWall(px, ny, pcx, pcy)) py = ny
  MP.x = px; MP.y = py
  return MP
}

// ── the solid world ─────────────────────────────────────────────────────────────────────────────────────────────────────
// createSolidWorld({ index, floorFn, solidCreature }) -> { movePlayer, settlePlayer, clutterAt, forEntities }
//   movePlayer(player, nx, ny, dt, sprinting, entities) -> report { x, y, entered, enterSpeed, enterNormalDot, clutterId,
//     clutterType, clutterEntered, stepType, blockedBy }   (one reused object)
//   settlePlayer(player) -> distance moved: out of any overlapping solid, and out of a wall the box has sunk into
//   clutterAt(x, y) -> 0.55 while standing in clutter, else 1
//   forEntities: { blocked(x, y, r), radiusFor(variant) } — what creatures may not walk into (never clutter, none or a soul)
const TOUCH_N = 16, LEAVE_S = 0.4
export function createSolidWorld({ index, floorFn, solidCreature }) {
  const solidFn = typeof solidCreature === 'function' ? solidCreature : () => false
  const res = { x: 0, y: 0, pushN: 0, push: [], pushNx: [], pushNy: [], clutterId: 0, clutterType: null, clutterEntered: false, palletId: 0, stepType: null }
  const report = { x: 0, y: 0, entered: null, enterSpeed: 0, enterNormalDot: 0, clutterId: 0, clutterType: null, clutterEntered: false, stepType: null, blockedBy: null }

  // the touching set: a fixed ring of record ids with their enter and last-push times; a record leaves 0.4 s after its
  // last push, and only an id not in the set (or expired) is an ENTER edge
  const tIds = new Int32Array(TOUCH_N), tEnter = new Float64Array(TOUCH_N), tLast = new Float64Array(TOUCH_N)
  let t = 0
  function touching(id) {
    for (let i = 0; i < TOUCH_N; i++) if (tIds[i] === id && t - tLast[i] <= LEAVE_S) return i
    return -1
  }
  function claim() {
    let oldest = 0
    for (let i = 0; i < TOUCH_N; i++) {
      if (tIds[i] === 0 || t - tLast[i] > LEAVE_S) return i
      if (tLast[i] < tLast[oldest]) oldest = i
    }
    return oldest
  }

  function movePlayer(player, nx, ny, dt, sprinting, entities) {
    const x0 = player.x, y0 = player.y
    t += dt
    const prevClutter = res.clutterId, prevPallet = res.palletId
    resolveCircle(x0, y0, nx, ny, index, floorFn, res)
    let rx = res.x, ry = res.y
    const blocker = creatureBlocks(x0, y0, rx, ry, entities, solidFn)
    if (blocker) {
      // the wall-slide feel: the x leg alone, then the y leg alone, else stay
      res.clutterId = prevClutter; res.palletId = prevPallet
      resolveCircle(x0, y0, nx, y0, index, floorFn, res)
      if (!creatureBlocks(x0, y0, res.x, res.y, entities, solidFn)) { rx = res.x; ry = res.y }
      else {
        res.clutterId = prevClutter; res.palletId = prevPallet
        resolveCircle(x0, y0, x0, ny, index, floorFn, res)
        if (!creatureBlocks(x0, y0, res.x, res.y, entities, solidFn)) { rx = res.x; ry = res.y }
        else { rx = x0; ry = y0; res.pushN = 0 }               // no displacement, no contact
      }
    }
    player.x = rx; player.y = ry
    report.x = rx; report.y = ry
    report.blockedBy = blocker
    report.entered = null; report.enterSpeed = 0; report.enterNormalDot = 0
    const dx = nx - x0, dy = ny - y0, m = Math.sqrt(dx * dx + dy * dy)
    for (let i = 0; i < res.pushN; i++) {
      const c = res.push[i]
      const s = touching(c.id)
      if (s >= 0) { tLast[s] = t; continue }
      const k = claim()
      tIds[k] = c.id; tEnter[k] = t; tLast[k] = t
      if (report.entered === null) {                            // ENTER edges only; the first of a frame speaks for it
        report.entered = c
        report.enterSpeed = dt > 0 ? m / dt : 0
        const head = m > 1e-9 ? -(dx * res.pushNx[i] + dy * res.pushNy[i]) / m : 0
        report.enterNormalDot = head < 0 ? 0 : head > 1 ? 1 : head
      }
    }
    report.clutterId = res.clutterId; report.clutterType = res.clutterType; report.clutterEntered = res.clutterEntered
    report.stepType = res.stepType
    return report
  }

  // out of a wall the box has sunk into (a resumed save, the pref switched on mid-stride): one cell's worth per axis
  function unstick(x, y) {
    const R = PLAYER_WALL_R, eps = 1e-3
    let x0 = Math.floor(x - R), x1 = Math.floor(x + R), y0 = Math.floor(y - R), y1 = Math.floor(y + R)
    const leftWall = !floorFn(x0, y0) || !floorFn(x0, y1), rightWall = !floorFn(x1, y0) || !floorFn(x1, y1)
    if (leftWall && !rightWall) x = x0 + 1 + R + eps
    else if (rightWall && !leftWall) x = x1 - R - eps
    x0 = Math.floor(x - R); x1 = Math.floor(x + R)
    const topWall = !floorFn(x0, y0) || !floorFn(x1, y0), botWall = !floorFn(x0, y1) || !floorFn(x1, y1)
    if (topWall && !botWall) y = y0 + 1 + R + eps
    else if (botWall && !topWall) y = y1 - R - eps
    SETTLE.x = x; SETTLE.y = y
    return SETTLE
  }

  function settlePlayer(player) {
    const x0 = player.x, y0 = player.y
    let px = x0, py = y0
    for (let it = 0; it < 8; it++) {
      let moved = false
      const n = index.query(px, py, PLAYER_R + QUERY_PAD, Q)
      for (let i = 0; i < n; i++) {
        const c = Q[i]
        if (c.cls !== 'solid') continue
        let ex = px - c.x, ey = py - c.y
        const R = c.r + PLAYER_R
        const d2 = ex * ex + ey * ey
        if (d2 >= R * R) continue
        const d = Math.sqrt(d2)
        if (d < 1e-9) { ex = 1; ey = 0 } else { ex /= d; ey /= d }
        const depth = R - d + PUSH_EPS
        px += ex * depth; py += ey * depth
        moved = true
      }
      if (!boxOpen(floorFn, px, py)) {
        const s = unstick(px, py)
        if (s.x !== px || s.y !== py) { px = s.x; py = s.y; moved = true }
      }
      if (!moved) break
    }
    player.x = px; player.y = py
    return Math.sqrt((px - x0) * (px - x0) + (py - y0) * (py - y0))
  }

  function clutterAt(x, y) {
    const n = index.query(x, y, PLAYER_R, Q)
    for (let i = 0; i < n; i++) if (Q[i].cls === 'clutter') return 0.55
    return 1
  }

  // creatures: a wall cell under the point, or any solid record within r + c.r. Souls are not obstacles to the things.
  function blocked(x, y, r) {
    if (!floorFn(Math.floor(x), Math.floor(y))) return true
    const n = index.query(x, y, r, Q)
    for (let i = 0; i < n; i++) { const c = Q[i]; if (c.cls === 'solid' && c.kind !== 'npc') return true }
    return false
  }

  return { movePlayer, settlePlayer, clutterAt, forEntities: { blocked, radiusFor: creatureRadius } }
}
const SETTLE = { x: 0, y: 0 }
