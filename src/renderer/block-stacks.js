// block-stacks.js — Level ∅ (the block), the storeys: what stands above every wall face.
// With the level's wallH 3.5 the raycaster draws the block's walls 7 m tall, still one slice a column, painted in four 2 m bands (band 0 at
// the foot): bands 0–1 (0–4 m) are the cell code's ground storey, bands 2–3 (4–8 m; the top metre is never drawn) the house's upper storey
// and its roofline. This module turns the house plan (block-facade-plan.js) into the STACKS the band tiles are painted from, and says which
// stack every wall face shows. The fixed map (fixedmap.js stackAt) and the tiles (gfx-textures.js TexSet.wallBands) both read it, so a face
// and its tiles always agree.
//
// Pure: no DOM, no Math.random, no module state; import-safe in Node. The plan decides, the art only reads it (block-facade-plan.js).
//
//   planBlockStacks(plan) -> { width, height, stacks, faces }
//     stacks  [Stack, ...] in a fixed order: the index is what stackAt returns and what TexSet.wallBands.upper is indexed by
//     faces   Int16Array(width * height * 2): the stack shown by cell (x, y) hit across an x grid line (side 0, its east / west face) at
//             (y * width + x) * 2, across a y grid line (side 1) at + 1; -1 where nothing is stacked (an open cell, a corner, a hidden face)
//   Stack = { key, kind, ... }
//     kind 'upper'  a ring house's (or a jut back's) upper storey over one kind of bay: { look, roof, bay, variants }
//                   look      { clad: 'common' | 'formstone' | 'painted', paint (painted: 'cream' | 'red-oxide' | 'grey'), wear: 'kept' |
//                             'vacant', roofless }: the cladding the storey is painted in and the state of its paint, frames and roof
//                   roof      'coping' (a parapet and its coping; the corner singles too), 'sag' (the coping sagging), 'cornice' (the 2-bay
//                             house's corbelled brick cornice and gutter), 'bare' (that cornice with its gutter gone), 'eave' (a jut back's
//                             eave, fascia and gutter)
//                   bay       what stands over the code below: 'window' (C, W: a black open window), 'board' (P: the same, 1 in 4
//                             boarded), 'shade' (O: a window with a shade, lit 1 in 2), 'solid' (F, B: blank, 1 in 3 a small window),
//                             'corner' (a corner single: one small window)
//                   variants  the names a face picks from by hash2(mx, my, side + 4) % n (gfx-world.js pickBands)
//     kind 'front'  a jut front bay, all four bands (the marble basement and stoop, the front storeys and the cornice):
//                   { jut: 'J-west' | 'J-east', bay: 'door' | 'window', clad: 'formstone' | 'pressed', striped, occupied, variants }
//     kind 'end'    a jut's exposed party-wall end, all four bands: { cell: 0 (the back row) | 1 (the front row), variants }
//
// Policy: stacks hold only shapes and states drawn from the plan; no number, no text, no address.
import { planBlockFacade, HOUSE_SEED } from './block-facade-plan.js'

// the storey a ring house's bay shows above its ground storey, by the code of the bay
const BAY_OF = Object.freeze({ C: 'window', W: 'window', P: 'board', O: 'shade', F: 'solid', B: 'solid' })
const VARIANTS = Object.freeze({
  window: Object.freeze(['void', 'rail']),
  board: Object.freeze(['void', 'void', 'rail', 'boarded']),          // 1 in 4 boarded (P: the second floor boarded too)
  shade: Object.freeze(['lit', 'dark']),                              // lit 1 in 2 (O)
  solid: Object.freeze(['blank', 'blank', 'small']),                  // 1 in 3 a small window (F, B)
  corner: Object.freeze(['small']),                                   // the corner single's one small upper window
})
// a roofless vacant house shows the sky through its upper voids (its roofline gone)
const ROOFLESS = Object.freeze({ void: 'sky', rail: 'skyRail' })

export function houseLook(h) {
  return Object.freeze({ clad: h.cladding, paint: h.cladding === 'painted' ? h.paint : null, wear: h.status === 'vacant' ? 'vacant' : 'kept', roofless: !!h.roofless })
}
export function houseRoof(h) {
  if (h.type === 'A') return h.copingSagging ? 'sag' : 'coping'
  if (h.type === 'B') return h.gutterMissing ? 'bare' : 'cornice'
  if (h.type === 'jut') return 'eave'
  return 'coping'
}
export const lookKey = (L) => `${L.clad}${L.paint ? ':' + L.paint : ''}|${L.wear}${L.roofless ? '|roofless' : ''}`

export function planBlockStacks(plan) {
  const { width, height } = plan
  const stacks = [], byKey = new Map()
  const faces = new Int16Array(width * height * 2).fill(-1)
  const add = (s) => {
    let i = byKey.get(s.key)
    if (i === undefined) { i = stacks.length; stacks.push(Object.freeze(s)); byKey.set(s.key, i) }
    return i
  }
  const put = (x, y, side, i) => { faces[(y * width + x) * 2 + side] = i }
  const upper = (h, bay) => {
    const look = houseLook(h), roof = houseRoof(h)
    const names = VARIANTS[bay].map((v) => (look.roofless && ROOFLESS[v]) || v)
    return add({ key: `upper|${lookKey(look)}|${roof}|${bay}`, kind: 'upper', look, roof, bay, variants: Object.freeze(names) })
  }
  // the ring: north and south runs are seen across y grid lines (side 1), east and west across x grid lines (side 0)
  for (const h of plan.houses) {
    const side = h.run === 'N' || h.run === 'S' ? 1 : 0
    for (const c of h.cells) put(c.x, c.y, side, upper(h, h.type === 'corner' ? 'corner' : BAY_OF[c.code] ?? 'solid'))
  }
  // the juts: the back row's north faces show the house's back, the front row's south faces its front, both rows' end faces its party walls
  for (const h of plan.juts) {
    const J = h.jut
    for (const c of J.back) put(c.x, c.y, 1, upper(h, BAY_OF[c.code] ?? 'solid'))
    for (const c of J.front) {
      const bay = c.x === J.doorX ? 'door' : 'window'
      put(c.x, c.y, 1, add({ key: `front|${J.name}|${bay}`, kind: 'front', jut: J.name, bay, clad: J.frontCladding, striped: !!h.mortarStriped,
        occupied: h.status === 'occupied', variants: Object.freeze(h.status === 'occupied' ? ['lit', 'dark'] : ['dark']) }))
    }
    for (const e of J.ends) {
      const x = e.side === 'W' ? e.x : e.x - 1
      for (let y = e.y0; y < e.y1; y++) put(x, y, 0, add({ key: `end|${y - e.y0}`, kind: 'end', cell: y - e.y0, variants: Object.freeze(['ghost']) }))
    }
  }
  return { width, height, stacks, faces }
}

// The house plan of a config that draws the block's storeys (Level ∅ with its Harlem Park look and a taller wall: levels.js '∅' look.facade,
// wallH), or null for every other config. The same map always gives the same plan.
export function facadeFor(cfg) {
  if (!cfg || !cfg.map || !(cfg.wallH > 1) || !cfg.look || cfg.look.facade !== 'harlem') return null
  return planBlockFacade(cfg.map, HOUSE_SEED)
}
