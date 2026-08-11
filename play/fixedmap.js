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
export function createFixedMap(grid) {
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

  return { isWall, materialAt, preload() {}, width, height }
}
