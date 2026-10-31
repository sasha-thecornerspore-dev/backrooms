// pathfield.js — how far a cell is from you through the maze: the floors of the nine chunks around yours copied into one reused
// 49 x 49 array, then one 4-connected BFS over it. Distances on hand-built grids (a corridor, an open room, a 3-thick chunk wall with
// and without its doorway), the window's bounds and the 3 x 3 block, next() always one step nearer, pick()'s band / accept / out, the
// arrays it lives in (the same three across 1,000 builds, nothing constructed), one getChunk per chunk per build, and a real Level 1
// cache read as preload holds it.
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import { createPathField, PF_R, PF_W } from '../src/renderer/pathfield.js'
import { DEFAULT_CONFIG, CHUNK_SIZE, createChunkCache, createGridReader, generateChunk } from '../src/renderer/world.js'
import { levelConfig } from '../src/renderer/levels.js'

const N = CHUNK_SIZE
const src = fs.readFileSync(new URL('../src/renderer/pathfield.js', import.meta.url), 'utf8')

// ── fixtures ────────────────────────────────────────────────────────────────────────────────────────────────────────
// a world as a chunk cache: wall(ix, iy) -> true when solid. Each chunk is cut once and handed back as the same array; every ask is kept
function fakeCache(wall) {
  const chunks = new Map(), asks = []
  return {
    asks,
    getChunk(cx, cy, pcx, pcy) {
      asks.push([cx, cy, pcx, pcy])
      const k = `${cx},${cy}`
      let c = chunks.get(k)
      if (!c) {
        c = new Uint8Array(N * N)
        for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) c[y * N + x] = wall(cx * N + x, cy * N + y) ? 1 : 0
        chunks.set(k, c)
      }
      return c
    },
  }
}
// the test's own BFS over a floor function, bounded to a box: path length in open cells from (sx, sy), -1 where not reached
function pathLengths(floor, sx, sy, x0, y0, x1, y1) {
  const d = new Map(); const q = [[sx, sy]]; d.set(`${sx},${sy}`, 0)
  while (q.length) {
    const [x, y] = q.shift(); const p = d.get(`${x},${y}`)
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy, k = `${nx},${ny}`
      if (nx < x0 || ny < y0 || nx > x1 || ny > y1 || !floor(nx, ny) || d.has(k)) continue
      d.set(k, p + 1); q.push([nx, ny])
    }
  }
  return (x, y) => d.get(`${x},${y}`) ?? -1
}
// every cell of the field's window against a reference
function eachCell(f, fn) {
  for (let ly = 0; ly < PF_W; ly++) for (let lx = 0; lx < PF_W; lx++) fn(f.ox + lx, f.oy + ly)
}
const seq = (...v) => { let i = 0; return () => v[Math.min(i++, v.length - 1)] }

describe('createPathField: distances', () => {
  it('a 49 x 49 window, radius 24', () => {
    expect(PF_R).toBe(24)
    expect(PF_W).toBe(49)
  })

  it('a corridor: the distance along it is the cells walked, and nothing off it is reached', () => {
    const f = createPathField()
    const reached = f.build(11, 11, fakeCache((x, y) => y !== 11))
    expect(reached).toBe(49)
    expect(f.reached).toBe(49)
    for (let k = -24; k <= 24; k++) expect(f.dist(11 + k, 11)).toBe(Math.abs(k))
    expect(f.dist(11, 12)).toBe(-1)
    expect(f.dist(11, 10)).toBe(-1)
  })

  it('an open room: 4-connected distance |dx| + |dy| to the window\'s edge, and -1 past it', () => {
    const f = createPathField()
    expect(f.build(11, 11, fakeCache(() => false))).toBe(PF_W * PF_W)
    expect(f.ox).toBe(11 - 24)
    expect(f.oy).toBe(11 - 24)
    eachCell(f, (x, y) => expect(f.dist(x, y)).toBe(Math.abs(x - 11) + Math.abs(y - 11)))
    expect(f.dist(11 + 24, 11 + 24)).toBe(48)
    for (const [x, y] of [[11 + 25, 11], [11 - 25, 11], [11, 11 + 25], [11, 11 - 25], [1e6, 0]]) expect(f.dist(x, y)).toBe(-1)
  })

  it('a 3-thick chunk wall: the far side is reached only through its doorway, never through it', () => {
    // the wall straddles the border of chunks 0 and 1 (x 21..23); its doorway is at y 5
    const withDoor = (x, y) => x >= 21 && x <= 23 && y !== 5
    const sealed = (x, y) => x >= 21 && x <= 23
    const f = createPathField()
    f.build(18, 11, fakeCache(withDoor))
    expect(f.dist(26, 11)).toBe(6 + 8 + 6)                     // up to the doorway, through, and back down: not the 8 a line would say
    const ref = pathLengths((x, y) => !withDoor(x, y), 18, 11, f.ox, f.oy, f.ox + PF_W - 1, f.oy + PF_W - 1)
    eachCell(f, (x, y) => expect(f.dist(x, y)).toBe(ref(x, y)))
    f.build(18, 11, fakeCache(sealed))
    expect(f.dist(26, 11)).toBe(-1)
    expect(f.dist(24, 11)).toBe(-1)
    expect(f.dist(20, 11)).toBe(2)
    eachCell(f, (x, y) => { if (x >= 21) expect(f.dist(x, y)).toBe(-1) })
  })

  it('where you stand is open whatever the copy says', () => {
    const f = createPathField()
    expect(f.build(11, 11, fakeCache((x, y) => x === 11 && y === 11))).toBe(PF_W * PF_W)
    expect(f.dist(11, 11)).toBe(0)
  })

  it('a float cell is floored', () => {
    const f = createPathField()
    f.build(11.7, 11.2, fakeCache(() => false))
    expect(f.ox).toBe(11 - 24)
    expect(f.dist(13.9, 11.5)).toBe(2)
  })

  it('a cache with no getChunk (the block\'s fixed map) reaches nothing', () => {
    const f = createPathField()
    expect(f.build(5, 5, { isWall: () => false, preload() {} })).toBe(0)
    expect(f.dist(5, 5)).toBe(-1)
    expect(f.build(5, 5, null)).toBe(0)
  })

  it('before any build every cell is -1', () => {
    const f = createPathField()
    expect(f.dist(0, 0)).toBe(-1)
    expect(f.dist(10, 10)).toBe(-1)
  })
})

describe('createPathField: the 3 x 3 block', () => {
  it('asks the nine chunks around yours once each, evicting relative to yours', () => {
    const f = createPathField()
    const c = fakeCache(() => false)
    f.build(30, -5, c)                                          // chunk (1, -1)
    expect(c.asks.length).toBe(9)
    const keys = new Set(c.asks.map(([cx, cy]) => `${cx},${cy}`))
    expect(keys.size).toBe(9)
    for (let cy = -2; cy <= 0; cy++) for (let cx = 0; cx <= 2; cx++) expect(keys.has(`${cx},${cy}`)).toBe(true)
    for (const [, , pcx, pcy] of c.asks) { expect(pcx).toBe(1); expect(pcy).toBe(-1) }
    f.build(31, -4, c)
    expect(c.asks.length).toBe(18)                              // one getChunk per chunk per build, every build
  })

  it('cells of the window beyond the block read as wall: at most two at the far edge, by a chunk border', () => {
    const f = createPathField()
    const c = fakeCache(() => false)
    f.build(0, 11, c)                                           // the west edge of chunk 0: the window reaches x -24, chunk -2 starts at -23
    expect(f.dist(-22, 11)).toBe(22)
    expect(f.dist(-23, 11)).toBe(-1)
    expect(f.dist(-24, 11)).toBe(-1)
    expect(f.dist(24, 11)).toBe(24)
    f.build(21, 11, c)                                          // the east edge: chunk 2 starts at 44
    expect(f.dist(43, 11)).toBe(22)
    expect(f.dist(44, 11)).toBe(-1)
    expect(f.dist(-3, 11)).toBe(24)
    for (const [cx, cy] of c.asks) { expect(Math.abs(cx)).toBeLessThanOrEqual(1); expect(Math.abs(cy)).toBeLessThanOrEqual(1) }
  })
})

describe('createPathField: next and pick', () => {
  // a generated maze over the block, so the paths wind
  const maze = new Map()
  const mazeWall = (x, y) => {
    const cx = Math.floor(x / N), cy = Math.floor(y / N), k = `${cx},${cy}`
    if (!maze.has(k)) maze.set(k, generateChunk(cx, cy, 0, { corridor: 1 }))
    return maze.get(k)[(y - cy * N) * N + (x - cx * N)] === 1
  }

  it('next always descends: one 4-neighbour, one step nearer, ending at you', () => {
    const f = createPathField()
    expect(f.build(11, 11, fakeCache(mazeWall))).toBeGreaterThan(300)
    const out = { x: 0, y: 0, d: 0 }
    let walked = 0
    eachCell(f, (x, y) => {
      const d = f.dist(x, y)
      if (d <= 0) return
      expect(f.next(x, y, out)).toBe(true)
      const nx = Math.floor(out.x), ny = Math.floor(out.y)
      expect(out.x).toBe(nx + 0.5)
      expect(out.y).toBe(ny + 0.5)
      expect(Math.abs(nx - x) + Math.abs(ny - y)).toBe(1)
      expect(f.dist(nx, ny)).toBe(d - 1)
      expect(out.d).toBe(d - 1)
      walked++
    })
    expect(walked).toBe(f.reached - 1)
    // following it from the farthest cell arrives at you in exactly d steps
    let far = null
    eachCell(f, (x, y) => { if (!far || f.dist(x, y) > f.dist(far[0], far[1])) far = [x, y] })
    let [x, y] = far, steps = 0
    while (f.next(x, y, out)) { x = Math.floor(out.x); y = Math.floor(out.y); steps++ }
    expect([x, y]).toEqual([11, 11])
    expect(steps).toBe(f.dist(far[0], far[1]))
  })

  it('next is false at you and off the field, and leaves out alone', () => {
    const f = createPathField()
    f.build(11, 11, fakeCache((x, y) => y !== 11))
    const out = { x: 7, y: 7, d: 7 }
    expect(f.next(11, 11, out)).toBe(false)
    expect(f.next(11, 12, out)).toBe(false)
    expect(f.next(500, 500, out)).toBe(false)
    expect(out).toEqual({ x: 7, y: 7, d: 7 })
  })

  it('pick stays in its band and writes the cell\'s centre and distance', () => {
    const f = createPathField()
    f.build(11, 11, fakeCache(mazeWall))
    let s = 1
    const rng = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296 }
    const out = { x: 0, y: 0, d: 0 }
    const seen = new Set()
    for (let i = 0; i < 400; i++) {
      expect(f.pick(3, 5, rng, null, out)).toBe(true)
      const ix = Math.floor(out.x), iy = Math.floor(out.y)
      expect(out.x).toBe(ix + 0.5)
      expect(out.d).toBe(f.dist(ix, iy))
      expect(out.d).toBeGreaterThanOrEqual(3)
      expect(out.d).toBeLessThanOrEqual(5)
      seen.add(`${ix},${iy}`)
    }
    let inBand = 0
    eachCell(f, (x, y) => { const d = f.dist(x, y); if (d >= 3 && d <= 5) inBand++ })
    expect(seen.size).toBe(inBand)                              // every cell of the band comes up
  })

  it('pick honours accept, gives up after its tries, and an empty band is false', () => {
    const f = createPathField()
    f.build(11, 11, fakeCache(() => false))
    const out = { x: -1, y: -1, d: -1 }
    let s = 9
    const rng = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296 }
    for (let i = 0; i < 200; i++) {
      expect(f.pick(10, 20, rng, (ix) => ix > 11, out)).toBe(true)
      expect(Math.floor(out.x)).toBeGreaterThan(11)
    }
    let asked = 0
    const before = { ...out }
    expect(f.pick(10, 20, rng, () => { asked++; return false }, out)).toBe(false)
    expect(asked).toBe(8)
    asked = 0
    expect(f.pick(10, 20, rng, () => { asked++; return false }, out, 3)).toBe(false)
    expect(asked).toBe(3)
    expect(f.pick(60, 70, rng, null, out)).toBe(false)          // nothing that far in the window
    expect(f.pick(5, 4, rng, null, out)).toBe(false)
    expect(out).toEqual(before)
  })

  it('the caller owns out: two picks never alias', () => {
    const f = createPathField()
    f.build(11, 11, fakeCache(() => false))
    const a = { x: 0, y: 0, d: 0 }, b = { x: 0, y: 0, d: 0 }
    expect(f.pick(3, 5, () => 0, null, a)).toBe(true)
    expect(f.pick(14, 20, () => 0.999, null, b)).toBe(true)
    expect(a.d).toBeGreaterThanOrEqual(3); expect(a.d).toBeLessThanOrEqual(5)
    expect(b.d).toBeGreaterThanOrEqual(14); expect(b.d).toBeLessThanOrEqual(20)
    expect(a).not.toBe(b)
  })

  it('an rng that returns 1 stays inside the band', () => {
    const f = createPathField()
    f.build(11, 11, fakeCache(() => false))
    const out = { x: 0, y: 0, d: 0 }
    expect(f.pick(3, 5, () => 1, null, out)).toBe(true)
    expect(out.d).toBe(5)
    expect(f.pick(0, 0, seq(0.5), null, out)).toBe(true)        // d 0 is you
    expect([out.x, out.y, out.d]).toEqual([11.5, 11.5, 0])
  })
})

describe('createPathField: the arrays it lives in', () => {
  // the nine chunks around (0, 0), cut once; this getChunk builds no key and returns what it holds
  function holdingCache() {
    const held = []
    for (let cy = -1; cy <= 1; cy++) for (let cx = -1; cx <= 1; cx++) held.push(generateChunk(cx, cy, 0, { corridor: 1 }))
    const c = { asks: 0, getChunk(cx, cy) { c.asks++; return held[(cy + 1) * 3 + (cx + 1)] } }
    return c
  }
  const MADE = ['Array', 'Object', 'Map', 'Set', 'WeakMap', 'ArrayBuffer', 'Uint8Array', 'Int8Array', 'Uint16Array', 'Int16Array', 'Uint32Array',
    'Int32Array', 'Float32Array', 'Float64Array', 'Uint8ClampedArray', 'DataView', 'Error', 'Function']

  it('three typed arrays made once: the same ones across 1,000 builds, nothing constructed, nine getChunk calls a build', () => {
    const f = createPathField()
    const ids = [f.cells, f.pd, f.q]
    expect(f.cells).toBeInstanceOf(Uint8Array)
    expect(f.pd).toBeInstanceOf(Int16Array)
    expect(f.q).toBeInstanceOf(Int16Array)
    for (const a of ids) expect(a.length).toBe(PF_W * PF_W)
    const c = holdingCache()
    const out = { x: 0, y: 0, d: 0 }
    let s = 3
    const rng = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296 }
    const accept = (ix, iy) => ((ix + iy) & 1) === 0
    f.build(11, 11, c)                                          // warm
    // every constructor the global scope offers, counted while the builds run
    const real = {}
    let made = 0
    for (const k of MADE) {
      real[k] = globalThis[k]
      globalThis[k] = new Proxy(real[k], {
        construct(t, a, nt) { made++; return Reflect.construct(t, a, nt) },
        apply(t, self, a) { made++; return Reflect.apply(t, self, a) },
      })
    }
    let total = 0
    try {
      for (let i = 0; i < 1000; i++) {
        total += f.build(i % N, (i * 7) % N, c)
        f.dist(i % N + 3, 11)
        f.next(i % N + 2, 11, out)
        f.pick(4, 12, rng, accept, out)
      }
    } finally {
      for (const k of MADE) globalThis[k] = real[k]
    }
    expect(made).toBe(0)
    expect(total).toBeGreaterThan(1000 * 300)
    expect(c.asks).toBe(9 + 1000 * 9)                           // the warm build and every one after
    expect([f.cells, f.pd, f.q]).toEqual(ids)
    expect(f.cells).toBe(ids[0]); expect(f.pd).toBe(ids[1]); expect(f.q).toBe(ids[2])
  })

  it('the hot paths construct nothing in their text either: no new, no closure, no copy', () => {
    const at = src.indexOf('function build(')
    expect(at).toBeGreaterThan(0)
    const hot = src.slice(at)
    for (const bad of ['new ', '=>', '.slice(', '.subarray(', '.map(', '.filter(', '.concat(', '.split(', '.push(', '`', '...', 'Array.from', 'Object.']) {
      expect(hot.includes(bad), bad).toBe(false)
    }
    // the three arrays are the only allocations, before the functions
    expect((src.slice(0, at).match(/new (Uint8|Int16)Array\(/g) || []).length).toBe(3)
  })
})

describe('createPathField: a real Level 1 cache', () => {
  it('reads the nine chunks preload holds, as they are, and agrees with a BFS walked over the grid', () => {
    const cfg = levelConfig(DEFAULT_CONFIG, 1)
    const cache = createChunkCache(cfg, null)
    cache.preload(0, 0)
    const held = new Map()
    for (let cy = -1; cy <= 1; cy++) for (let cx = -1; cx <= 1; cx++) held.set(`${cx},${cy}`, cache.getChunk(cx, cy, 0, 0))
    const asks = []
    const spy = { getChunk(cx, cy, pcx, pcy) { const c = cache.getChunk(cx, cy, pcx, pcy); asks.push([cx, cy, c]); return c } }
    const f = createPathField()
    const m = N >> 1                                            // the chunk's cross hallway: its whole mid row is open
    const reached = f.build(m, m, spy)
    expect(reached).toBeGreaterThan(400)
    expect(asks.length).toBe(9)
    for (const [cx, cy, c] of asks) expect(c).toBe(held.get(`${cx},${cy}`))   // the arrays preload made: nothing generated, nothing evicted
    // the reference: the grid reader's floor, bounded to the window and the block
    const grid = createGridReader(cache, (wx, wy) => cache.isWall(wx, wy, 0, 0))
    grid.setPlayerChunk(0, 0)
    const x0 = Math.max(f.ox, -N), y0 = Math.max(f.oy, -N), x1 = Math.min(f.ox + PF_W - 1, 2 * N - 1), y1 = Math.min(f.oy + PF_W - 1, 2 * N - 1)
    const ref = pathLengths(grid.floor, m, m, x0, y0, x1, y1)
    let n = 0
    eachCell(f, (x, y) => { expect(f.dist(x, y)).toBe(ref(x, y)); if (ref(x, y) >= 0) n++ })
    expect(n).toBe(reached)
    for (let k = -24; k <= 24; k++) expect(f.dist(m + k, m)).toBe(Math.abs(k))     // the mid row runs through all three chunks
  })
})
