// fixedmap.js — an authored, bounded grid that quacks like the chunk cache.
//
// Level ∅ (the hand-authored Harlem Park block) is not procedural: it is a
// fixed grid of cells. This provider exposes the same isWall(wx,wy,pcx,pcy)
// shape createChunkCache does, plus materialAt(wx,wy) for per-cell wall
// materials, and a no-op preload() so game.js can treat it interchangeably.
//
// Cell codes: '.' or ' ' = open floor; any other char = a wall whose char is
// its material id (see level-null-map.js). Everything outside the grid is
// solid — the block is bounded; you cannot walk off the authored map.
//
// With a house plan (block-facade-plan.js planBlockFacade of this grid; block-stacks.js facadeFor(cfg) for a config that draws storeys) the
// map also says what stands above each wall face (the block's storeys): stackAt(wx, wy, side) -> the stack index of the face of cell
// (wx, wy) hit across an x grid line (side 0) or a y grid line (side 1), or -1; `facade` is that plan. Without one, nothing changes.
import { planBlockStacks } from './block-stacks.js'

export function createFixedMap(grid, plan = null) {
  const height = grid.length
  const width  = grid.reduce((w, row) => Math.max(w, row.length), 0)

  function codeAt(wx, wy) {
    const ix = Math.floor(wx), iy = Math.floor(wy)
    if (ix < 0 || iy < 0 || ix >= width || iy >= height) return 'X'   // out of bounds → solid, unnamed
    return (grid[iy] ?? '')[ix] ?? 'X'
  }

  function isWall(wx, wy) {
    const c = codeAt(wx, wy)
    return c !== '.' && c !== ' '
  }

  function materialAt(wx, wy) {
    const ix = Math.floor(wx), iy = Math.floor(wy)
    if (ix < 0 || iy < 0 || ix >= width || iy >= height) return null
    const c = (grid[iy] ?? '')[ix] ?? null
    return (c === '.' || c === ' ' || c == null) ? null : c
  }

  const map = { isWall, materialAt, preload() {}, width, height }
  if (plan) { map.stackAt = stackLookup(plan); map.facade = plan }
  return map
}

// stackAt for a house plan: one typed-array read a wall column a frame (the renderer asks for every column)
function stackLookup(plan) {
  const { faces, width: pw, height: ph } = planBlockStacks(plan)
  return (wx, wy, side) => {
    const ix = Math.floor(wx), iy = Math.floor(wy)
    return ix < 0 || iy < 0 || ix >= pw || iy >= ph ? -1 : faces[(iy * pw + ix) * 2 + (side === 1 ? 1 : 0)]
  }
}

// The world hooks a renderer of this map is created with (renderer.js createRenderer(canvas, config, renderOpts, worldHooks)): the per-cell
// material, and with a house plan (the map's own, or `plan`) the storeys' stacks (stackAt) and the plan itself (facade).
export function fixedMapHooks(map, plan = null) {
  const hooks = { materialAt: (wx, wy) => map.materialAt(wx, wy) }
  if (map.stackAt) { hooks.stackAt = map.stackAt; hooks.facade = map.facade }
  else if (plan) { hooks.stackAt = stackLookup(plan); hooks.facade = plan }
  return hooks
}
