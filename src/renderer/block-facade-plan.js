// block-facade-plan.js — Level ∅ (the block): the house plan. Which wall cells of the ring are one house, what each house is
// (status, type and the seeded attributes), how tall it stands, the two juts, the authored ground rectangles and the two
// utility-pole spots: the grouping rule and the seeded attributes, the heights and storeys, the pole spots and the ground.
//
// Pure and seeded: no DOM, no Math.random, no module state; import-safe in Node. The same (map, seed) always gives the same plan, and
// test/block-facade-plan.test.js pins every fact of the stock plan. The plan decides; the art only reads it.
//
// Units: x and y in cells (1 cell = 2 m; +x east, +y south, row 0 is the north edge). Every height (and the few
// horizontal lengths that sit beside them) is { m, cells }: metres above the yard and the same in cells.
// Seeded draws: a house's draw for an attribute is hash2(houseIndex, attr, seed) % n (gfx-util.js hash2, exact uint32 maths, the
// same function the wall variant pick uses, gfx-world.js:307), so a probability p = a / n is the test `% n < a`.
//
// Policy: the plan holds no address, number or text, only cell codes, shapes, heights and draws.
import { hash2 } from './gfx-util.js'

export const HOUSE_SEED = 0x48500001
export const CELL_M = 2                                 // metres per cell

// ── bay status: O occupied; C, P, W vacant; F, B, M (and anything else) neutral ──────────────────────────────────────────
const BAY_STATUS = { O: 'occupied', C: 'vacant', P: 'vacant', W: 'vacant' }
export function bayStatus(code) { return BAY_STATUS[code] ?? 'neutral' }

// a house is occupied if any bay is, vacant if any bay is, else neutral (the grouping never mixes the two)
export function houseStatus(codes) {
  let occ = false, vac = false
  for (const c of codes) { const s = bayStatus(c); if (s === 'occupied') occ = true; else if (s === 'vacant') vac = true }
  if (occ && vac) throw new Error(`planBlockFacade: the house '${codes}' mixes occupied and vacant bays`)
  return occ ? 'occupied' : vac ? 'vacant' : 'neutral'
}

// ── the grouping rule ───────────────────────────────────────────────────────────────────────────────────────────────────────
// Split a run into houses of 3 or 2 bays; a 1-bay piece only at a run end (next to a corner); a house never mixes occupied and
// vacant bays; the lowest total cost wins (1-bay 10, 2-bay 1, 3-bay 0); on a tie the larger house comes first (the size list
// that is larger at its first difference). Returns the house sizes in run order; throws if the run has no valid split.
export const SPLIT_COST = Object.freeze([Infinity, 10, 1, 0])
export function splitRun(codes) {
  const n = codes.length
  const st = Array.from(codes, bayStatus)
  // best[i]: the cheapest valid split of the suffix codes[i..] (null if none); larger first houses are tried first and only a
  // strictly cheaper option replaces one, so among equal costs the larger first house, then the larger rest, is kept
  const best = new Array(n + 1).fill(null)
  best[n] = { cost: 0, sizes: [] }
  for (let i = n - 1; i >= 0; i--) {
    for (let k = 3; k >= 1; k--) {
      if (i + k > n || best[i + k] === null) continue
      if (k === 1 && i !== 0 && i !== n - 1) continue
      let occ = false, vac = false
      for (let j = i; j < i + k; j++) { if (st[j] === 'occupied') occ = true; else if (st[j] === 'vacant') vac = true }
      if (occ && vac) continue
      const cost = SPLIT_COST[k] + best[i + k].cost
      if (best[i] === null || cost < best[i].cost) best[i] = { cost, sizes: [k, ...best[i + k].sizes] }
    }
  }
  if (best[0] === null) throw new Error(`planBlockFacade: the run '${codes}' has no valid split`)
  return best[0].sizes
}

// ── seeded attributes ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// The attr ids are the second hash2 argument; never renumber them (the house plan's test pins every draw).
export const ATTR = Object.freeze({
  backStoreys: 0, cladding: 1, paint: 2, peel: 3, gutter: 4, coping: 5, roofless: 6, ailanthus: 7, vine: 8, ac: 9, dish: 10,
  mortar: 11, placard: 12,
  curbW: 40, curbE: 41, pole: 42,                       // ground and pole draws: hash2(segment or pole index, attr, seed)
})
const STOREYS_A = [1, 1, 2, 2, 2, 2, 2, 2, 2, 3, 3, 3]   // % 12: 1 storey 2/12 = 1/6, 2 storeys 7/12, 3 storeys 3/12 = 1/4
const PAINTS = ['cream', 'red-oxide', 'grey']            // equally
// The formstone parge share: the share of a house's formstone surfaces that show the grey cement-parge variant.
// Base 1/8, today's weight of the parge tile in the F slot list (gfx-textures.js formstoneSet: the patch, 1 of 8 slots); vacant houses
// double it.
const PARGE_SHARE = 0.125, PARGE_SHARE_VACANT = 0.25

// ── heights, metres above the yard ───────────────────────────────────────────────────────────────────────────────────────────
export const DIMS = Object.freeze({
  ringFloors: Object.freeze([0.38, 3.58, 6.48]),       // floors at the ring face (back building or main rear wall); a 3rd storey at
                                                        // the 2-storey roof level
  aRoof: Object.freeze([0, 3.55, 6.48, 9.45]),         // type A roof by back-building storeys: the coping less the 0.45 m parapet
  aCoping: Object.freeze([0, 4.0, 6.93, 9.9]),         // type A parapet and coping: 4.0 (2.0) / 6.93 (3.47) / 9.9 (4.95)
  mainOffset: 6.0,                                      // the main block's rear wall, behind the ring face (outside the grid)
  mainFloors: Object.freeze([0.76, 4.57, 8.08]),
  mainEave: 10.6,                                       // rear eave with the half-round gutter, 10.6 (5.3); the roof drains to the rear
  bEave: 6.48, bCornice: 6.8,                           // type B: the main rear wall, eave 6.48, corbelled brick cornice and gutter 6.8 (3.4)
  cornerTop: 10.6,                                      // corner single: the corner house's side wall, 10.6 (5.3), the main block's storeys
  jutBasement: 0.76,                                    // jut front: marble basement 0.76, storeys 3.20 and 2.90, cornice 0.60
  jutFloors: Object.freeze([0.76, 3.96]),
  jutCorniceBase: 6.86, jutCorniceTop: 7.46,            // 7.46 (3.73) to the cornice top
  jutBackEave: 7.1,                                     // the back (north) wall: eave with gutter
  jutDepth: 2.8,                                        // body depth 2.8 m (1.4 cells): a cut-row slice
})
const H = (m) => ({ m, cells: m / CELL_M })

// ── the authored ground, cells; for NULL_MAP ────────────────────────────────────────────────────────────────────────────────
export const BLOCK_GROUND = Object.freeze({
  // the ghost of the closed alley: asphalt over concrete, 4.4 m wide, a central gutter, broken granite curb remnants on both edges
  // (60% present, at most 5 cm reveal); invented geometry, not a measured trace
  alley: Object.freeze({ x0: 1.4, y0: 1.0, x1: 3.6, y1: 17.0, gutterX: 2.5, curbShare: 0.6, curbRevealM: 0.05 }),
  court: Object.freeze({ x0: 11, y0: 2, x1: 15, y1: 4 }),                          // a broken paved court (asphalt)
  // shelter footings: a concrete slab with four rusted post stubs, 0.1 cell in from each slab corner, at most 8 cm tall
  footings: Object.freeze({ x0: 19.2, y0: 5.2, x1: 20.8, y1: 6.6, postInset: 0.1, postMaxM: 0.08 }),
  // the scorched ring of a lost barbecue pit, a decal with flush bricks, centred in cell (20, 9); radius 0.45 cell
  scorch: Object.freeze({ x: 20, y: 9, r: 0.45 }),
  // kept plain so the form and the portal read
  plain: Object.freeze([Object.freeze({ what: 'note', x: 6, y: 6 }), Object.freeze({ what: 'exit', x: 18, y: 13 })]),
})

// ── the utility poles: inside the invisible NE and SW corner cells, 0.07 cell (on each axis) from the open corner ──────────
// wood pole 11–12 m (seeded per pole, in decimetres), LED cobra-head arm at about 7.6 m, service drops to occupied backs at 5.5 m
export const POLE = Object.freeze({ fromCorner: 0.07, heightDmMin: 110, heightDmSpan: 11, cobraM: 7.6, dropM: 5.5 })

// ── the plan ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// map: the grid as rows of cell codes (level-null-map.js NULL_MAP). Returns
//   { seed, width, height, runs, houses (the ring, run order), juts (in x order), ground, poles }
export function planBlockFacade(map, seed = HOUSE_SEED) {
  seed = seed >>> 0
  const height = map.length
  const width = map.reduce((w, row) => Math.max(w, row.length), 0)
  if (width < 3 || height < 3) throw new Error('planBlockFacade: the map is smaller than 3 x 3')
  const code = (x, y) => (x < 0 || y < 0 || x >= width || y >= height) ? 'X' : ((map[y] ?? '')[x] ?? 'X')
  const open = (x, y) => { const c = code(x, y); return c === '.' || c === ' ' }

  // the four runs, clockwise as seen from the park; the corner cells have no visible face and belong to no run
  const runs = [], houses = []
  for (const def of runDefs(width, height)) {
    const cells = def.xy.map(([x, y]) => {
      if (open(x, y)) throw new Error(`planBlockFacade: the ring is open at (${x}, ${y})`)
      return { x, y, code: code(x, y) }
    })
    const codes = cells.map((c) => c.code).join('')
    const run = { side: def.side, face: def.face, cells, codes, houses: [] }
    let at = 0
    splitRun(codes).forEach((k, j) => {
      const hc = cells.slice(at, at + k); at += k
      const type = k === 3 ? 'A' : k === 2 ? 'B' : 'corner'
      const h = makeHouse(houses.length, `${def.side}${j}`, def.side, def.face, hc, k, type, seed, null)
      houses.push(h); run.houses.push(h.id)
    })
    runs.push(run)
  }

  // the juts: each interior wall block is one house standing in the park (back = its north row, front = its south row)
  const juts = findJuts(width, height, open).map((J, k) => {
    const back = [], front = []
    for (let x = J.x0; x <= J.x1; x++) {
      back.push({ x, y: J.y0, code: code(x, J.y0) })
      front.push({ x, y: J.y0 + 1, code: code(x, J.y0 + 1) })
    }
    // the door bay is the end toward the jut's own side of the park: west end on J-west, east end on J-east
    const doorSide = J.x0 + J.x1 + 1 < width ? 'W' : 'E'
    const all = [...back, ...front]
    const jut = {
      name: doorSide === 'W' ? 'J-west' : 'J-east',
      doorSide, doorX: doorSide === 'W' ? J.x0 : J.x1,
      back, front,
      // the exposed party-wall end faces: the plane x, from y0 to y1 (cells)
      ends: [{ side: 'W', x: J.x0, y0: J.y0, y1: J.y1 + 1 }, { side: 'E', x: J.x1 + 1, y0: J.y0, y1: J.y1 + 1 }],
      // the front: formstone wrap on a formstone house (J-west), else pressed brick with marble lintels and sills (J-east)
      frontCladding: all.some((c) => c.code === 'F') ? 'formstone' : 'pressed',
      frontY: J.y0 + DIMS.jutDepth / CELL_M,       // the front face line: the body depth from the jut's north edge
    }
    return makeHouse(houses.length + k, `J${k}`, 'J', 'S', all, back.length, 'jut', seed, jut)
  })

  return { seed, width, height, runs, houses, juts, ground: planGround(seed), poles: planPoles(width, height, seed) }
}

function runDefs(w, h) {
  const north = [], east = [], south = [], west = []
  for (let x = 1; x <= w - 2; x++) north.push([x, 0])
  for (let y = 1; y <= h - 2; y++) east.push([w - 1, y])
  for (let x = w - 2; x >= 1; x--) south.push([x, h - 1])
  for (let y = h - 2; y >= 1; y--) west.push([0, y])
  return [
    { side: 'N', face: 'S', xy: north },
    { side: 'E', face: 'W', xy: east },
    { side: 'S', face: 'N', xy: south },
    { side: 'W', face: 'E', xy: west },
  ]
}

// interior wall blocks (4-neighbour components inside the ring), each a full 2-row rectangle, in (x0, y0) order
function findJuts(width, height, open) {
  const seen = new Uint8Array(width * height), out = []
  for (let y = 1; y <= height - 2; y++) {
    for (let x = 1; x <= width - 2; x++) {
      if (open(x, y) || seen[y * width + x]) continue
      seen[y * width + x] = 1
      const stack = [[x, y]]
      let n = 0, x0 = x, x1 = x, y0 = y, y1 = y
      while (stack.length) {
        const [cx, cy] = stack.pop()
        n++
        if (cx < x0) x0 = cx; if (cx > x1) x1 = cx; if (cy < y0) y0 = cy; if (cy > y1) y1 = cy
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = cx + dx, ny = cy + dy
          if (nx < 1 || ny < 1 || nx > width - 2 || ny > height - 2) continue
          if (open(nx, ny) || seen[ny * width + nx]) continue
          seen[ny * width + nx] = 1
          stack.push([nx, ny])
        }
      }
      if (y1 - y0 !== 1 || n !== (x1 - x0 + 1) * 2) throw new Error(`planBlockFacade: the interior block at (${x0}, ${y0}) is not a 2-row jut`)
      out.push({ x0, y0, x1, y1 })
    }
  }
  return out.sort((a, b) => a.x0 - b.x0 || a.y0 - b.y0)
}

function makeHouse(index, id, run, face, cells, bays, type, seed, jut) {
  const codes = cells.map((c) => c.code).join('')
  const status = houseStatus(codes)
  const attrs = drawAttributes(index, codes, status, type, jut ? jut.frontCladding : null, seed)
  return { index, id, run, face, cells, codes, bays, status, type, ...attrs, heights: heightsFor(type, attrs.backStoreys), jut }
}

// every seeded attribute (ATTR); null where the attribute does not apply
function drawAttributes(index, codes, status, type, frontCladding, seed) {
  const d = (attr, n) => hash2(index, attr, seed) % n
  const vacant = status === 'vacant', occupied = status === 'occupied'
  const hasF = codes.includes('F')
  // type: 3-bay A (back building at the ring face, main block behind), 2-bay B (main rear wall), corner single, jut
  const backStoreys = type === 'A' ? STOREYS_A[d(ATTR.backStoreys, 12)] : null
  // upper cladding: with an F bay formstone 60% / common brick 40%; otherwise common brick bare 40% / painted 60%
  let cladding, paint = null
  if (hasF) cladding = d(ATTR.cladding, 5) < 3 ? 'formstone' : 'common'
  else if (d(ATTR.cladding, 5) < 2) cladding = 'common'
  else { cladding = 'painted'; paint = PAINTS[d(ATTR.paint, 3)] }
  // paint state: peel 0–10% when lived in or neutral, 15–40% when vacant (permille, so the draw stays an integer)
  const peelPermille = vacant ? 150 + d(ATTR.peel, 251) : d(ATTR.peel, 101)
  const formstone = hasF || cladding === 'formstone' || frontCladding === 'formstone'
  return {
    backStoreys, cladding, paint,
    peelPermille, peel: peelPermille / 1000,
    pargeShare: formstone ? (vacant ? PARGE_SHARE_VACANT : PARGE_SHARE) : 0,
    // roofline: intact unless vacant; vacant: gutter missing 1/2, sagging coping 1/3, roofless 1/6 (sky through the upper voids)
    gutterMissing: vacant && d(ATTR.gutter, 2) < 1,
    copingSagging: vacant && d(ATTR.coping, 3) < 1,
    roofless: vacant && d(ATTR.roofless, 6) < 1,
    // greenery (vacant): ailanthus from the parapet or gutter 1/3; a vine on the back wall 1/6
    ailanthus: vacant && d(ATTR.ailanthus, 3) < 1,
    vine: vacant && d(ATTR.vine, 6) < 1,
    // occupied extras: a window AC unit 1/3, the service drop and meter always, a satellite dish 1/4
    ac: occupied && d(ATTR.ac, 3) < 1,
    serviceDrop: occupied,
    meter: occupied,
    dish: occupied && d(ATTR.dish, 4) < 1,
    // white-striped joints on 1 in 4 pressed-brick fronts (only the J-east front is pressed brick)
    mortarStriped: frontCladding === 'pressed' ? d(ATTR.mortar, 4) < 1 : null,
    // the invented vacancy placard: 1/3 of vacant houses
    placard: vacant && d(ATTR.placard, 3) < 1,
  }
}

// the heights resolved for one house: the storeys and floors at the face, the roof (or eave, or cornice base), the top of the
// face's silhouette (coping, cornice or eave), and the main block behind (type A); the juts add the basement, the back eave and
// the body depth
function heightsFor(type, backStoreys) {
  const D = DIMS
  const base = { storeys: 0, floors: [], roof: null, top: null, topKind: null, behind: null, basement: null, backEave: null, depth: null }
  if (type === 'A') {
    return {
      ...base,
      storeys: backStoreys,
      floors: D.ringFloors.slice(0, backStoreys).map((m) => H(m)),
      roof: H(D.aRoof[backStoreys]), top: H(D.aCoping[backStoreys]), topKind: 'coping',
      behind: { offset: H(D.mainOffset), storeys: 3, floors: D.mainFloors.map((m) => H(m)), eave: H(D.mainEave) },
    }
  }
  if (type === 'B') {
    return { ...base, storeys: 2, floors: D.ringFloors.slice(0, 2).map((m) => H(m)), roof: H(D.bEave), top: H(D.bCornice), topKind: 'cornice' }
  }
  if (type === 'corner') {
    return { ...base, storeys: 3, floors: D.mainFloors.map((m) => H(m)), roof: H(D.mainEave), top: H(D.cornerTop), topKind: 'eave' }
  }
  return {
    ...base,
    storeys: 2, floors: D.jutFloors.map((m) => H(m)),
    roof: H(D.jutCorniceBase), top: H(D.jutCorniceTop), topKind: 'cornice',
    basement: H(D.jutBasement), backEave: H(D.jutBackEave), depth: H(D.jutDepth),
  }
}

function planGround(seed) {
  const G = BLOCK_GROUND, A = G.alley, F = G.footings, S = G.scorch
  const curbs = []
  for (const [edge, x, attr] of [['W', A.x0, ATTR.curbW], ['E', A.x1, ATTR.curbE]]) {
    // one 1-cell curb segment per row along the strip; present 3 in 5 (60%)
    for (let k = 0, y = Math.floor(A.y0); y < A.y1; k++, y++) curbs.push({ edge, k, x, y0: y, y1: y + 1, present: hash2(k, attr, seed) % 5 < 3 })
  }
  const i = F.postInset
  return {
    alley: { x0: A.x0, y0: A.y0, x1: A.x1, y1: A.y1, gutterX: A.gutterX, curbShare: A.curbShare, curbReveal: H(A.curbRevealM), curbs },
    court: { x0: G.court.x0, y0: G.court.y0, x1: G.court.x1, y1: G.court.y1 },
    footings: {
      x0: F.x0, y0: F.y0, x1: F.x1, y1: F.y1,
      posts: [{ x: F.x0 + i, y: F.y0 + i }, { x: F.x1 - i, y: F.y0 + i }, { x: F.x1 - i, y: F.y1 - i }, { x: F.x0 + i, y: F.y1 - i }],
      postMax: H(F.postMaxM),
    },
    scorch: { cellX: S.x, cellY: S.y, cx: S.x + 0.5, cy: S.y + 0.5, r: S.r },
    plain: G.plain.map((p) => ({ what: p.what, x: p.x, y: p.y })),
  }
}

function planPoles(w, h, seed) {
  const f = POLE.fromCorner
  return [
    { corner: 'NE', cellX: w - 1, cellY: 0, x: (w - 1) + f, y: 1 - f },
    { corner: 'SW', cellX: 0, cellY: h - 1, x: 1 - f, y: (h - 1) + f },
  ].map((p, i) => {
    const dm = POLE.heightDmMin + hash2(i, ATTR.pole, seed) % POLE.heightDmSpan
    return { ...p, heightDm: dm, height: H(dm / 10), cobra: H(POLE.cobraM), drop: H(POLE.dropM) }
  })
}
