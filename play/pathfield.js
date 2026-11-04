// pathfield.js — how far a cell is from you through the maze, never through its walls. One bounded BFS from your cell over a
// 49 x 49 window: the floors of the chunks around yours are copied into one reused array first, so the flood reads typed arrays
// only (no key string, no Map per cell). dread.js reads distances from it; Tier 2's director walks it (next) and picks its cells
// from it (pick).
//
// Pure. The three arrays are made once in createPathField; build, dist, next and pick allocate nothing.
//
// createPathField() -> field
//   build(ix, iy, cache) -> reached   flood from your cell. cache is world.js createChunkCache: the 3 x 3 chunks around yours are
//                                     read, one getChunk each, and preload already holds them, so nothing is generated or evicted.
//                                     Within 2 cells of a chunk border the window's far side reaches up to 2 cells past that
//                                     block; those read as wall. A cache without getChunk (the block's fixed map) reaches nothing.
//   dist(ix, iy) -> -1 | d             path length in cells; -1 off the window, behind walls or not reached
//   next(ix, iy, out) -> boolean       the 4-neighbour one step nearer you: out.x, out.y its centre, out.d its distance.
//                                     false at you and off the field
//   pick(minD, maxD, rng, accept, out, tries = 8) -> boolean
//                                     a random reached cell with minD <= d <= maxD that accept(ix, iy) takes (null takes any),
//                                     written as next writes. The caller owns out, so two picks never alias
//   cells, pd, q                       the copy (0 floor, 1 wall), the distances (-1 unreached), the flood's order (d never falls)
//   ox, oy, reached                    the window's corner cell and how many cells the last build reached
import { CHUNK_SIZE } from './world.js'

export const PF_R = 24
export const PF_W = PF_R * 2 + 1

const PF_CELLS = PF_W * PF_W
const N = CHUNK_SIZE
const START = PF_R * PF_W + PF_R          // you, at the window's centre
const DX4 = [1, -1, 0, 0], DY4 = [0, 0, 1, -1]

export function createPathField() {
  const cells = new Uint8Array(PF_CELLS)
  const pd = new Int16Array(PF_CELLS).fill(-1)
  const q = new Int16Array(PF_CELLS)
  const f = { cells, pd, q, ox: 0, oy: 0, reached: 0, build, dist, next, pick }

  function build(ix, iy, cache) {
    ix = Math.floor(ix); iy = Math.floor(iy)
    const ox = ix - PF_R, oy = iy - PF_R
    f.ox = ox; f.oy = oy; f.reached = 0
    cells.fill(1); pd.fill(-1)
    if (!cache || typeof cache.getChunk !== 'function') return 0
    // the copy: each of the nine chunks' rows that fall inside the window, one getChunk per chunk
    const pcx = Math.floor(ix / N), pcy = Math.floor(iy / N)
    for (let cy = pcy - 1; cy <= pcy + 1; cy++) {
      const y0 = Math.max(cy * N, oy), y1 = Math.min(cy * N + N, oy + PF_W)
      for (let cx = pcx - 1; cx <= pcx + 1; cx++) {
        const x0 = Math.max(cx * N, ox), x1 = Math.min(cx * N + N, ox + PF_W)
        const ch = cache.getChunk(cx, cy, pcx, pcy)
        for (let y = y0; y < y1; y++) {
          const from = (y - cy * N) * N - cx * N, to = (y - oy) * PF_W - ox
          for (let x = x0; x < x1; x++) cells[to + x] = ch[from + x]
        }
      }
    }
    // the flood: where you stand is open whatever the copy says
    pd[START] = 0; q[0] = START
    let head = 0, tail = 1
    while (head < tail) {
      const i = q[head++]
      const lx = i % PF_W, ly = (i - lx) / PF_W
      const p = pd[i] + 1
      for (let k = 0; k < 4; k++) {
        const jx = lx + DX4[k], jy = ly + DY4[k]
        if (jx < 0 || jy < 0 || jx >= PF_W || jy >= PF_W) continue
        const j = jy * PF_W + jx
        if (pd[j] >= 0 || cells[j] !== 0) continue
        pd[j] = p; q[tail++] = j
      }
    }
    f.reached = tail
    return tail
  }

  function dist(ix, iy) {
    const lx = Math.floor(ix) - f.ox, ly = Math.floor(iy) - f.oy
    if (lx < 0 || ly < 0 || lx >= PF_W || ly >= PF_W) return -1
    return pd[ly * PF_W + lx]
  }

  // a reached cell's flood parent is one step nearer, so some neighbour always is
  function next(ix, iy, out) {
    const d = dist(ix, iy)
    if (d <= 0) return false
    const lx = Math.floor(ix) - f.ox, ly = Math.floor(iy) - f.oy
    for (let k = 0; k < 4; k++) {
      const jx = lx + DX4[k], jy = ly + DY4[k]
      if (jx < 0 || jy < 0 || jx >= PF_W || jy >= PF_W) continue
      if (pd[jy * PF_W + jx] !== d - 1) continue
      out.x = f.ox + jx + 0.5; out.y = f.oy + jy + 0.5; out.d = d - 1
      return true
    }
    return false
  }

  // where distance d starts in the flood's order (the first entry at d or more)
  function firstAt(d) {
    let lo = 0, hi = f.reached
    while (lo < hi) {
      const m = (lo + hi) >> 1
      if (pd[q[m]] < d) lo = m + 1; else hi = m
    }
    return lo
  }

  // the flood is in order of distance, so a band is one run of q: two searches, then a few draws from it
  function pick(minD, maxD, rng, accept, out, tries = 8) {
    const a = firstAt(minD), b = firstAt(maxD + 1)
    if (b <= a) return false
    for (let t = 0; t < tries; t++) {
      const i = q[Math.min(b - 1, a + Math.floor(rng() * (b - a)))]
      const lx = i % PF_W, ly = (i - lx) / PF_W
      const ix = f.ox + lx, iy = f.oy + ly
      if (accept && !accept(ix, iy)) continue
      out.x = ix + 0.5; out.y = iy + 0.5; out.d = pd[i]
      return true
    }
    return false
  }

  return f
}
