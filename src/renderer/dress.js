// dress.js — room dressing. Rooms become rooms: a 5x5 lobby office has a run of cabinets along a wall that really is a wall, two chairs
// round a box in the middle, papers underfoot, sometimes a plant in the corner; a storeroom has crates stacked in a corner and a pallet by
// the door; a pump room drums along one wall and a toolbox at the valve; a switch room is ringed with panel cabinets and a transformer in
// the corner you have to walk around. Solid and hugged, so a room now has interior cover: a place to break a stalker's line.
//
// Pure. An appended decor pass on its own channels.js constants (ctx.hash / ctx.rngFrom; never an existing pass's rng), so every older
// placement stays byte-identical. The records look like scatter props ({ key, x, y, type, rot }, keys `${chunkKey}:d${i}`) and then go
// through settleChunk like any prop: the hug and the lane rule happen there, the reach gate runs with the pass on.
//
// Placement rule (the one that keeps rooms passable): every SOLID piece sits either in a perimeter cell with >= 1 wall side and no open
// outward neighbour (so it hugs a real wall and never stands in a doorway) or, for the centre pieces, in an interior cell. Decals and
// the pallet ('none' in collide.js) go anywhere in the room.
import { CHUNK_SIZE } from './world.js'
import { wallSides } from './placement.js'
import { CHANNELS } from './channels.js'
import { SOLID_CLASS } from './collide.js'
import { unitJitter } from './gfx-sprites.js'

export const MAX_DRESSED_PROPS = 8      // per chunk: planSprites drops far props first past its cap (gfx-sprites.js planSprites)
export const MAX_ROOMS = 2              // rooms dressed per chunk, 5x5 first
const HALL = CHUNK_SIZE >> 1            // the cross hallway: world lx or ly === 11
const NODE_LO = 3, NODE_HI = CHUNK_SIZE - 5   // the node cells scanned: odd lx, ly in 3..17 (1 and 19 would straddle the border)
const RUN_STEP = 0.5                    // pieces along a wall run
const CLUSTER_STEP = 0.45               // the crate cluster
const CHAIR_OFF = 0.55                  // chairs round the box
const SIDES = ['N', 'E', 'S', 'W']
const OPPOSITE = { N: 'S', S: 'N', E: 'W', W: 'E' }

// ── findRooms(floorFn, cx, cy) -> [{ cx, cy, size: 3|5, cells: [{ wx, wy, sides, door, interior, cornerWalls }] }] ──
// floorFn(ix, iy) -> true = open (integer world cells); only this chunk's cells are ever read. wx / wy are the cell's INTEGER world
// coords; sides = placement.wallSides; door = a perimeter cell with an open outward 4-neighbour; cornerWalls = the count of wall sides
// (2 only in a two-wall corner). A 5x5 room is a node whose 5x5 is fully open; a 3x3 room a node whose 3x3 is fully open and is not inside
// any 5x5 one. A room with a perimeter cell adjacent to a hall cell is skipped (the hall is never a room). 5x5s first, then scan order.
export function findRooms(floorFn, cx, cy) {
  const ox = cx * CHUNK_SIZE, oy = cy * CHUNK_SIZE
  const openAround = (lx, ly, h) => {
    for (let dy = -h; dy <= h; dy++) for (let dx = -h; dx <= h; dx++) if (!floorFn(ox + lx + dx, oy + ly + dy)) return false
    return true
  }
  const big = []
  for (let ly = NODE_LO; ly <= NODE_HI; ly += 2) for (let lx = NODE_LO; lx <= NODE_HI; lx += 2) if (openAround(lx, ly, 2)) big.push(lx, ly)
  const inBig = (lx, ly) => { for (let i = 0; i < big.length; i += 2) if (Math.abs(lx - big[i]) <= 2 && Math.abs(ly - big[i + 1]) <= 2) return true; return false }
  const out = [], seen = new Set()
  const consider = (lx, ly, h) => {
    const k = lx * CHUNK_SIZE + ly
    if (seen.has(k)) return
    seen.add(k)
    const room = roomAt(floorFn, cx, cy, lx, ly, h)
    if (room) out.push(room)
  }
  for (let i = 0; i < big.length; i += 2) consider(big[i], big[i + 1], 2)
  for (let ly = NODE_LO; ly <= NODE_HI; ly += 2) for (let lx = NODE_LO; lx <= NODE_HI; lx += 2) if (!inBig(lx, ly) && openAround(lx, ly, 1)) consider(lx, ly, 1)
  return out
}

function roomAt(floorFn, cx, cy, lx, ly, h) {
  // straddling the chunk edge: the room and its outward ring must lie inside this chunk (the node scan already guarantees it)
  if (lx - h < 1 || ly - h < 1 || lx + h > CHUNK_SIZE - 2 || ly + h > CHUNK_SIZE - 2) return null
  const ox = cx * CHUNK_SIZE, oy = cy * CHUNK_SIZE
  const cells = []
  for (let dy = -h; dy <= h; dy++) {
    for (let dx = -h; dx <= h; dx++) {
      const wx = ox + lx + dx, wy = oy + ly + dy
      const sides = wallSides(floorFn, wx, wy)
      const perim = dx === -h || dx === h || dy === -h || dy === h
      let door = false
      if (perim) {
        const px = lx + dx, py = ly + dy
        // a perimeter cell next to the hall (or on it): not a room
        if (px + 1 === HALL || px - 1 === HALL || py + 1 === HALL || py - 1 === HALL) return null
        if ((dy === -h && !sides.N) || (dy === h && !sides.S) || (dx === -h && !sides.W) || (dx === h && !sides.E)) door = true
      }
      const cornerWalls = (sides.N ? 1 : 0) + (sides.E ? 1 : 0) + (sides.S ? 1 : 0) + (sides.W ? 1 : 0)
      cells.push({ wx, wy, sides, door, interior: !perim, cornerWalls })
    }
  }
  return { cx, cy, size: 2 * h + 1, cells }
}

// ── the dresser: what a set function places with ────────────────────────────────────────────────────────────────────────
const pick = (rng, list) => list[(rng() * list.length) | 0]

// decor.sideFn leans a hugged prop on the FIRST wall of [N, E, S, W] when unitJitter(rot, 23) >= 0, the LAST otherwise. A piece dressed
// against one wall of a two-wall corner draws its rot until the parity leans that way (a 1/256 miss after 8 draws falls back to either).
function leanRot(rng, cell, wall) {
  let rot = rng() * Math.PI * 2
  if (!wall || !cell || cell.cornerWalls < 2) return rot
  let first = null
  for (let i = 0; i < 4; i++) if (cell.sides[SIDES[i]]) { first = SIDES[i]; break }
  const wantFirst = wall === first
  for (let t = 0; t < 8 && (unitJitter(rot, 23) >= 0) !== wantFirst; t++) rot = rng() * Math.PI * 2
  return rot
}

// the perimeter cells along one edge, in order, corners included
function edgeCells(room, edge) {
  const h = room.size >> 1, n = room.size, out = []
  for (let i = 0; i < n; i++) {
    const dx = edge === 'W' ? -h : edge === 'E' ? h : i - h
    const dy = edge === 'N' ? -h : edge === 'S' ? h : i - h
    out.push(room.cells[(dy + h) * n + (dx + h)])
  }
  return out
}
// the longest consecutive stretch of non-door cells along an edge (every such cell has the edge's wall behind it)
function stretch(room, edge) {
  let best = [], cur = []
  for (const c of edgeCells(room, edge)) {
    if (c.door) { cur = []; continue }
    cur.push(c)
    if (cur.length > best.length) best = cur
  }
  return best
}

function dresser(room, rng) {
  const n = room.size, h = n >> 1
  const key = `${room.cx},${room.cy}`
  const used = new Set()
  const records = []
  let solids = 0
  const centre = room.cells[(room.cells.length - 1) >> 1]
  const at = (dx, dy) => room.cells[(dy + h) * n + (dx + h)]
  const free = (list) => list.filter((c) => !used.has(c))
  // add(type, x, y, cell, wall): the record, rot from the rng (parity-matched to `wall` in a two-wall corner), the cell marked used
  const add = (type, x, y, cell, wall = null) => {
    records.push({ key: `${key}:d${records.length}`, x, y, type, rot: leanRot(rng, cell, wall) })
    if (SOLID_CLASS[type] !== 'none') solids++
    if (cell) used.add(cell)
  }
  const b = {
    rng, room, centre, at, records,
    get solids() { return solids },
    corners: () => free(room.cells.filter((c) => c.cornerWalls === 2)),
    interior: () => free(room.cells.filter((c) => c.interior)),
    doors: () => room.cells.filter((c) => c.door),
    // the walled runs: edges whose longest non-door stretch holds >= min cells
    runs: (min = 2) => SIDES.map((edge) => ({ edge, cells: stretch(room, edge) })).filter((r) => r.cells.length >= min),
    // n pieces `step` apart centred on the run, each hugging the run's wall; a cell another feature already holds is skipped
    run: (r, type, count, step = RUN_STEP) => {
      const alongX = r.edge === 'N' || r.edge === 'S'
      const c0 = r.cells[0], a0 = alongX ? c0.wx : c0.wy
      const mid = a0 + r.cells.length / 2
      const taken = new Set(used)
      for (let i = 0; i < count; i++) {
        const a = mid + (i - (count - 1) / 2) * step
        const cell = r.cells[Math.min(r.cells.length - 1, Math.max(0, Math.floor(a - a0)))]
        if (taken.has(cell)) continue
        if (alongX) add(type, a, c0.wy + 0.5, cell, r.edge)
        else add(type, c0.wx + 0.5, a, cell, r.edge)
      }
    },
    // one piece at a cell's centre
    put: (type, cell, wall = null) => add(type, cell.wx + 0.5, cell.wy + 0.5, cell, wall),
    place: (type, x, y, cell, wall = null) => add(type, x, y, cell, wall),
    papers: () => { const c = pick(rng, free(room.cells).length ? free(room.cells) : room.cells); add('papers', c.wx + 0.5, c.wy + 0.5, c) },
  }
  return b
}

// ── the sets ────────────────────────────────────────────────────────────────────────────────────────────────────────────
// office (Level 0): a wall-run of 2-3 cabinets along the longest fully-walled run, two chairs at ±0.55 round a centre box, papers, 30% a
// plant in a two-wall corner. 3x3: one cabinet in a two-wall corner (if any) + papers.
function officeFive(b, v) {
  const rs = b.runs(2)
  if (rs.length) {
    let longest = 0
    for (const r of rs) if (r.cells.length > longest) longest = r.cells.length
    b.run(pick(b.rng, rs.filter((r) => r.cells.length === longest)), 'cabinet', v ? 3 : 2)
  }
  const c = b.centre
  b.put('box', c)
  for (const s of [-1, 1]) {
    if (v) b.place('chair', c.wx + 0.5, c.wy + 0.5 + s * CHAIR_OFF, b.at(0, s))
    else b.place('chair', c.wx + 0.5 + s * CHAIR_OFF, c.wy + 0.5, b.at(s, 0))
  }
  b.papers()
  const plant = b.rng() < 0.3
  const cs = b.corners()
  if (plant && cs.length) b.put('plant', pick(b.rng, cs))
}
function officeThree(b) {
  const cs = b.corners()
  if (cs.length) b.put('cabinet', pick(b.rng, cs))
  b.papers()
}

// storeroom (Level 1): 2-3 crates clustered 0.45 apart in a two-wall corner (two along the N/S wall, the third along the E/W wall), a
// pallet in the interior cell nearest a door, 40% a cart in the interior. 3x3: one crate in a two-wall corner + papers.
function storeroomFive(b, v) {
  const cs = b.corners()
  if (cs.length) {
    const c = pick(b.rng, cs)
    const ns = c.sides.N ? 'N' : 'S', ew = c.sides.E ? 'E' : 'W'
    const inX = c.sides.W ? 1 : -1, inY = c.sides.N ? 1 : -1       // into the room
    const x = c.wx + 0.5, y = c.wy + 0.5
    b.place('crate', x, y, c, ns)
    b.place('crate', x + inX * CLUSTER_STEP, y, c, ns)
    if (v) b.place('crate', x, y + inY * CLUSTER_STEP, c, ew)
  }
  const doors = b.doors(), ints = b.interior()
  let best = null, bd = Infinity
  for (const i of ints) for (const d of doors) {
    const dd = (i.wx - d.wx) ** 2 + (i.wy - d.wy) ** 2
    if (dd < bd) { bd = dd; best = i }
  }
  if (best) b.put('pallet', best)
  const cart = b.rng() < 0.4
  const rest = b.interior()
  if (cart && rest.length) b.put('cart', pick(b.rng, rest))
}
function storeroomThree(b) {
  const cs = b.corners()
  if (cs.length) b.put('crate', pick(b.rng, cs))
  b.papers()
}

// pump room (Level 2): 2-3 drums along one walled run (0.5 apart), a valve on the opposite run (any other walled run failing that) with a
// toolbox at its foot in the interior. 3x3: one drum in a two-wall corner.
function pumpFive(b, v) {
  const rs = b.runs(2)
  let drumEdge = null
  if (rs.length) { const r = pick(b.rng, rs); drumEdge = r.edge; b.run(r, 'drum', v ? 3 : 2) }
  const order = drumEdge ? [OPPOSITE[drumEdge], ...SIDES.filter((e) => e !== drumEdge && e !== OPPOSITE[drumEdge])] : SIDES
  const h = b.room.size >> 1, c = b.centre
  for (const e of order) {
    // a non-corner non-door cell on that edge: its foot (one cell inward) is interior
    const cand = edgeCells(b.room, e).filter((cell, i) => i > 0 && i < b.room.size - 1 && !cell.door)
    if (!cand.length) continue
    const vc = pick(b.rng, cand)
    b.put('valve', vc, e)
    const dx = vc.wx - c.wx, dy = vc.wy - c.wy
    const foot = b.at(dx === -h ? dx + 1 : dx === h ? dx - 1 : dx, dy === -h ? dy + 1 : dy === h ? dy - 1 : dy)
    b.put('toolbox', foot)
    break
  }
}
function pumpThree(b) {
  const cs = b.corners()
  if (cs.length) b.put('drum', pick(b.rng, cs))
}

// switch room (Level 3): cabinet-e along two walled runs (0.5 apart, 4 in all: 2 + 2, or 3 + 1), a transformer in a two-wall corner, a
// spool in the interior. 3x3: one cabinet-e in a two-wall corner.
function switchFive(b, v) {
  const pool = b.runs(2), counts = v ? [3, 1] : [2, 2]
  for (let i = 0; i < 2 && pool.length; i++) {
    const k = (b.rng() * pool.length) | 0
    b.run(pool[k], 'cabinet-e', counts[i])
    pool.splice(k, 1)
  }
  const cs = b.corners()
  if (cs.length) b.put('transformer', pick(b.rng, cs))
  const ints = b.interior()
  if (ints.length) b.put('spool', pick(b.rng, ints))
}
function switchThree(b) {
  const cs = b.corners()
  if (cs.length) b.put('cabinet-e', pick(b.rng, cs))
}

const set = (name, level, types, five, three) => Object.freeze({ name, level, types: Object.freeze(types), five, three })
export const SETS = Object.freeze({
  office:    set('office',    0, ['cabinet', 'chair', 'box', 'papers', 'plant'],  officeFive,    officeThree),
  storeroom: set('storeroom', 1, ['crate', 'pallet', 'cart', 'papers'],           storeroomFive, storeroomThree),
  pump:      set('pump',      2, ['drum', 'valve', 'toolbox', 'papers'],          pumpFive,      pumpThree),
  switch:    set('switch',    3, ['cabinet-e', 'transformer', 'spool', 'papers'], switchFive,    switchThree),
})
export const SETS_FOR_LEVEL = Object.freeze({ 0: SETS.office, 1: SETS.storeroom, 2: SETS.pump, 3: SETS.switch })

// ── dressRoom(room, set, rng) -> records [{ key: `${cx},${cy}:d${i}`, x, y, type, rot }] ──
// Two variants per set from the rng (the count of the run / cluster, the chairs' axis), which runs / corners from the rng among the
// qualifying ones; a room that ends up with no solid piece gets papers only. Keys count from d0 per call: dressPass re-keys them per chunk.
export function dressRoom(room, set, rng) {
  const b = dresser(room, rng)
  const variant = rng() < 0.5 ? 0 : 1
  if (room.size === 5) set.five(b, variant)
  else set.three(b, variant)
  if (!b.solids && !b.records.some((r) => r.type === 'papers')) b.papers()
  return b.records
}

// ── dressPass(cfg) -> pass | null ──
// null when cfg.dress?.denom is 0 / absent or the level has no set (Level ∅). Gate and rng from channels.js dress; the chunk's walls are
// read once from ctx.isWall into a local grid, so the dressing is a function of this chunk alone.
export function dressPass(cfg) {
  const denom = cfg?.dress?.denom | 0
  if (denom <= 0) return null
  const set = SETS_FOR_LEVEL[cfg.levelIndex]
  if (!set) return null
  const [GA, GB] = CHANNELS.dress.gate
  const [MX, AX, MY, AY] = CHANNELS.dress.rng
  const N = CHUNK_SIZE
  return (ctx) => {
    const { cx, cy, salt, seed } = ctx
    if (ctx.hash(cx + GA + salt, cy + GB + salt, seed) % denom !== 0) return
    const rng = ctx.rngFrom(cx * MX + salt + AX, cy * MY + salt + AY, seed)
    const ox = cx * N, oy = cy * N
    const grid = new Uint8Array(N * N)
    for (let ly = 0; ly < N; ly++) for (let lx = 0; lx < N; lx++) grid[ly * N + lx] = ctx.isWall(ox + lx + 0.5, oy + ly + 0.5) ? 0 : 1
    const floorFn = (ix, iy) => { const lx = ix - ox, ly = iy - oy; return lx >= 0 && ly >= 0 && lx < N && ly < N && grid[ly * N + lx] === 1 }
    const rooms = findRooms(floorFn, cx, cy)
    let n = 0
    for (let r = 0; r < rooms.length && r < MAX_ROOMS && n < MAX_DRESSED_PROPS; r++) {
      const recs = dressRoom(rooms[r], set, rng)
      for (let i = 0; i < recs.length && n < MAX_DRESSED_PROPS; i++) {
        recs[i].key = `${ctx.key}:d${n++}`
        ctx.add('prop', recs[i])
      }
    }
  }
}
