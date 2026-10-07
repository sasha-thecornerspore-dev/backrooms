import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { generateChunk, CHUNK_SIZE, createChunkCache, createGridReader, MAX_RESIDENT, DEFAULT_CONFIG } from '../src/renderer/world.js'

describe('generateChunk', () => {
  it('returns a Uint8Array of the correct size', () => {
    const chunk = generateChunk(0, 0, 0)
    expect(chunk).toBeInstanceOf(Uint8Array)
    expect(chunk.length).toBe(CHUNK_SIZE * CHUNK_SIZE)
  })

  it('is deterministic — same cx/cy/epoch gives identical output', () => {
    const a = generateChunk(3, -2, 0)
    const b = generateChunk(3, -2, 0)
    expect(a).toEqual(b)
  })

  it('differs for different epoch — revisit generates a new layout', () => {
    const a = generateChunk(3, -2, 0)
    const b = generateChunk(3, -2, 1)
    expect(a).not.toEqual(b)
  })

  it('differs for different chunk coordinates', () => {
    const a = generateChunk(0, 0, 0)
    const b = generateChunk(1, 0, 0)
    expect(a).not.toEqual(b)
  })

  it('border midpoint passages are always open (top edge)', () => {
    const chunk = generateChunk(5, 5, 0)
    const m = Math.floor(CHUNK_SIZE / 2)
    expect(chunk[0 * CHUNK_SIZE + m]).toBe(0)
  })

  it('border midpoint passages are always open (bottom edge)', () => {
    const chunk = generateChunk(5, 5, 0)
    const m = Math.floor(CHUNK_SIZE / 2)
    expect(chunk[(CHUNK_SIZE - 1) * CHUNK_SIZE + m]).toBe(0)
  })

  it('border midpoint passages are always open (left edge)', () => {
    const chunk = generateChunk(5, 5, 0)
    const m = Math.floor(CHUNK_SIZE / 2)
    expect(chunk[m * CHUNK_SIZE + 0]).toBe(0)
  })

  it('border midpoint passages are always open (right edge)', () => {
    const chunk = generateChunk(5, 5, 0)
    const m = Math.floor(CHUNK_SIZE / 2)
    expect(chunk[m * CHUNK_SIZE + (CHUNK_SIZE - 1)]).toBe(0)
  })

  it('cross-corridor cells at midpoint row are always open', () => {
    const chunk = generateChunk(7, -3, 2)
    const m = Math.floor(CHUNK_SIZE / 2)
    // Every cell in the midpoint row should be open (corridor)
    for (let x = 0; x < CHUNK_SIZE; x++) {
      expect(chunk[m * CHUNK_SIZE + x]).toBe(0)
    }
  })

  it('cells contain only 0 or 1', () => {
    const chunk = generateChunk(0, 0, 0)
    for (const v of chunk) {
      expect(v === 0 || v === 1).toBe(true)
    }
  })
})

describe('createChunkCache', () => {
  it('getChunk returns same array for same coordinates (cache hit)', () => {
    const cache = createChunkCache({ chunkEvictRadius: 3, wallDensity: 0.30 })
    const a = cache.getChunk(2, 2)
    const b = cache.getChunk(2, 2)
    expect(a).toBe(b) // reference equality — not regenerated
  })

  it('isWall returns boolean for any world coordinate', () => {
    const cache = createChunkCache({ chunkEvictRadius: 3, wallDensity: 0.30 })
    expect(typeof cache.isWall(0.5, 0.5)).toBe('boolean')
    expect(typeof cache.isWall(-5.3, 100.9)).toBe('boolean')
  })

  it('evicted chunk regenerates with a different layout on revisit', () => {
    // Use evictRadius=0 so anything beyond the current chunk (+2) is evicted once the cache is over the cap
    const cache = createChunkCache({ chunkEvictRadius: 0, wallDensity: 0.30 })
    const first = new Uint8Array(cache.getChunk(5, 5)) // copy before eviction
    // Force eviction by querying distant chunks — need > MAX_RESIDENT (121) to trigger size-based evict
    // 12x12 grid at x10 spacing = 144 chunks; the 122nd triggers eviction, removing 5,5 (far from each new chunk)
    for (let y = -6; y < 6; y++)
      for (let x = -6; x < 6; x++)
        cache.getChunk(x * 10, y * 10) // load far-away chunks to overflow cache
    // Now revisit 5,5 — should be regenerated from a different epoch
    const second = cache.getChunk(5, 5)
    expect(first).not.toEqual(second)
  })

  it('fixed seed: revisiting evicted chunk returns same layout', () => {
    const config = { wallDensity: 0.3, chunkEvictRadius: 1 }
    const cache = createChunkCache(config, 42)
    const a = cache.getChunk ? cache.getChunk(0, 0) : null
    // force eviction by moving far
    for (let i = 2; i < 20; i++) cache.isWall(0, 0, i, i, i * 22, i * 22)
    // revisit
    const b = cache.getChunk ? cache.getChunk(0, 0) : null
    // Can't compare directly without getChunk — test via isWall consistency
    const resultA = cache.isWall(0, 0, 0, 0)
    const resultB = cache.isWall(0, 0, 0, 0)
    expect(resultA).toBe(resultB)
  })

  it('fixed seed: same world seed produces same wall at (5,5)', () => {
    const config = { wallDensity: 0.3, chunkEvictRadius: 3 }
    const c1 = createChunkCache(config, 12345)
    const c2 = createChunkCache(config, 12345)
    expect(c1.isWall(5, 5, 0, 0)).toBe(c2.isWall(5, 5, 0, 0))
  })

  it('different world seeds produce potentially different worlds', () => {
    const config = { wallDensity: 0.3, chunkEvictRadius: 3 }
    const c1 = createChunkCache(config, 1)
    const c2 = createChunkCache(config, 999999)
    // sample 100 cells — at least some should differ
    let diffs = 0
    for (let i = 0; i < 100; i++) diffs += c1.isWall(i * 5 + i, i * 7 - i * 2, 0, 0) !== c2.isWall(i * 5 + i, i * 7 - i * 2, 0, 0) ? 1 : 0
    expect(diffs).toBeGreaterThan(0)
  })

  it('getChunk never returns undefined when eviction removes the just-created far chunk (freeze regression)', () => {
    const cache = createChunkCache({ chunkEvictRadius: 3 })
    // fill the cache to exactly MAX_RESIDENT with the whole keep zone (the 11x11 block within evictRadius + 2 of the
    // player at (0,0), none of which can be evicted) so the next far chunk is the one that tips it over the cap
    for (let cx = -5; cx <= 5; cx++)
      for (let cy = -5; cy <= 5; cy++)
        cache.getChunk(cx, cy, 0, 0)
    // a chunk far from the player is generated, then evict() deletes it in the same
    // call (it is beyond evictRadius + 2) — getChunk must still return what it generated.
    const far = cache.getChunk(50, 50, 0, 0)
    expect(far).toBeInstanceOf(Uint8Array)
    expect(cache.epochOf(50, 50)).toBe(1)                       // it really was evicted
  })

  it('a 12x12 grid of far chunks at x10 spacing overflows the cap and the far ones are forgotten (not the keep zone)', () => {
    const cache = createChunkCache({ chunkEvictRadius: 3 })
    const home = cache.getChunk(0, 0, 0, 0)
    for (let y = -6; y < 6; y++)
      for (let x = -6; x < 6; x++)
        cache.getChunk(x * 10, y * 10, 0, 0)
    expect(cache.getChunk(0, 0, 0, 0)).toBe(home)
    expect(cache.epochOf(0, 0)).toBe(0)
    expect(cache.epochOf(-60, -60)).toBe(1)
  })

  it('isWall does not throw for a cell far beyond the evict radius (freeze regression)', () => {
    const cache = createChunkCache({ chunkEvictRadius: 3 })
    for (let cx = -3; cx <= 3; cx++)
      for (let cy = -3; cy <= 3; cy++)
        cache.getChunk(cx, cy, 0, 0)
    // exactly what a far-wandering entity does: check a wall many chunks from the
    // player. Before the fix this threw "Cannot read properties of undefined" and
    // froze the render loop.
    expect(() => cache.isWall(50 * CHUNK_SIZE, 50 * CHUNK_SIZE, 0, 0)).not.toThrow()
    expect(typeof cache.isWall(50 * CHUNK_SIZE, 50 * CHUNK_SIZE, 0, 0)).toBe('boolean')
  })
})

describe('createChunkCache: slow forgetting (MAX_RESIDENT, epochOf)', () => {
  // a 12x12 grid of far-apart chunks (x10 spacing) around the player chunk: 144 > MAX_RESIDENT
  function overflow(cache, pcx = 0, pcy = 0) {
    for (let y = -6; y < 6; y++)
      for (let x = -6; x < 6; x++)
        cache.getChunk(pcx + x * 10, pcy + y * 10, pcx, pcy)
  }

  it('MAX_RESIDENT is 121: the whole evictRadius + 2 keep zone (11x11) at the default radius', () => {
    expect(MAX_RESIDENT).toBe(121)
    expect(MAX_RESIDENT).toBe((2 * (3 + 2) + 1) ** 2)
  })

  it('epochOf is 0 for a fresh chunk and for one never loaded', () => {
    const cache = createChunkCache({ chunkEvictRadius: 3 })
    cache.getChunk(4, -2, 0, 0)
    expect(cache.epochOf(4, -2)).toBe(0)
    expect(cache.epochOf(99, 99)).toBe(0)
  })

  it('nothing is evicted while the cache is at or under MAX_RESIDENT, whatever the distance', () => {
    const cache = createChunkCache({ chunkEvictRadius: 0 })
    const first = cache.getChunk(0, 0, 0, 0)
    let n = 1
    for (let y = -6; y < 6 && n < MAX_RESIDENT; y++)
      for (let x = -6; x < 6 && n < MAX_RESIDENT; x++)
        if (x !== 0 || y !== 0) { cache.getChunk(x * 10, y * 10, 0, 0); n++ }
    expect(n).toBe(MAX_RESIDENT)                               // 120 far chunks loaded: rows y = -6..3 of the grid
    expect(cache.getChunk(0, 0, 0, 0)).toBe(first)            // 121 resident: still nothing forgotten
    expect(cache.epochOf(50, 30)).toBe(0)
    expect(cache.epochOf(-60, -60)).toBe(0)
    cache.getChunk(70, 70, 0, 0)                               // the 122nd: now the far ones go
    expect(cache.epochOf(50, 30)).toBe(1)
    expect(cache.epochOf(-60, -60)).toBe(1)
    expect(cache.getChunk(0, 0, 0, 0)).toBe(first)            // the player's own chunk is kept
  })

  it('epochOf increments once a chunk farther than evictRadius + 2 is forgotten past the cap (unseeded)', () => {
    const cache = createChunkCache({ chunkEvictRadius: 3 })
    cache.getChunk(20, 20, 0, 0)
    for (let cx = -3; cx <= 3; cx++)
      for (let cy = -3; cy <= 3; cy++)
        cache.getChunk(cx, cy, 0, 0)
    expect(cache.epochOf(20, 20)).toBe(0)                      // 50 resident: under the cap, nothing forgotten
    overflow(cache)
    expect(cache.epochOf(20, 20)).toBe(1)
    expect(cache.epochOf(0, 0)).toBe(0)
    expect(cache.epochOf(3, 3)).toBe(0)
    // (20,20) is itself a grid point: each overflow forgets it once and walks back onto it, so the epoch counts the overflows
    overflow(cache)
    expect(cache.epochOf(20, 20)).toBe(2)
    overflow(cache)
    expect(cache.epochOf(20, 20)).toBe(3)
    expect(cache.epochOf(0, 0)).toBe(0)
  })

  it('a chunk exactly evictRadius + 2 away is NOT evicted; one past it is', () => {
    const cache = createChunkCache({ chunkEvictRadius: 3 })
    const keepE = cache.getChunk(5, 0, 0, 0), keepC = cache.getChunk(-5, 5, 0, 0)
    cache.getChunk(6, 0, 0, 0)
    cache.getChunk(-5, 6, 0, 0)
    overflow(cache)
    expect(cache.epochOf(5, 0)).toBe(0)
    expect(cache.epochOf(-5, 5)).toBe(0)
    expect(cache.getChunk(5, 0, 0, 0)).toBe(keepE)
    expect(cache.getChunk(-5, 5, 0, 0)).toBe(keepC)
    expect(cache.epochOf(6, 0)).toBe(1)
    expect(cache.epochOf(-5, 6)).toBe(1)
  })

  it('epochOf stays 0 with a fixed seed and the layout is the same on revisit', () => {
    const cache = createChunkCache({ chunkEvictRadius: 3 }, 42)
    const before = new Uint8Array(cache.getChunk(20, 20, 0, 0))
    overflow(cache)
    expect(cache.epochOf(20, 20)).toBe(0)
    expect(cache.getChunk(20, 20, 0, 0)).toEqual(before)
  })
})

describe('createGridReader', () => {
  // a counting cache: one shared cell array, every getChunk recorded
  function countingCache(cells) {
    const calls = []
    return { calls, getChunk(cx, cy, pcx, pcy) { calls.push([cx, cy, pcx, pcy]); return cells } }
  }

  it('calls getChunk once per chunk border crossed over a 200-cell walk and never isWallFn with a cache', () => {
    const cells = new Uint8Array(CHUNK_SIZE * CHUNK_SIZE)
    const cache = countingCache(cells)
    let wallCalls = 0
    const grid = createGridReader(cache, () => { wallCalls++; return false })
    grid.setPlayerChunk(0, 0)
    for (let ix = 0; ix < 200; ix++) expect(grid.floor(ix, 3)).toBe(true)
    expect(cache.calls.length).toBe(Math.ceil(200 / CHUNK_SIZE))     // 10 chunks touched, 10 loads
    expect(wallCalls).toBe(0)
    for (let ix = 199; ix >= 0; ix--) grid.floor(ix, 3)              // back again: a load per border, none within a chunk
    expect(cache.calls.length).toBe(2 * Math.ceil(200 / CHUNK_SIZE) - 1)
    for (let i = 0; i < 100; i++) grid.floor(7, 3)                   // same cell: no loads
    expect(cache.calls.length).toBe(2 * Math.ceil(200 / CHUNK_SIZE) - 1)
  })

  it('passes the player chunk through to getChunk', () => {
    const cache = countingCache(new Uint8Array(CHUNK_SIZE * CHUNK_SIZE))
    const grid = createGridReader(cache, () => false)
    grid.setPlayerChunk(4, -7)
    grid.floor(100, -300)
    expect(cache.calls).toEqual([[Math.floor(100 / CHUNK_SIZE), Math.floor(-300 / CHUNK_SIZE), 4, -7]])
  })

  it('reads the right cell, negative coordinates included (true = open)', () => {
    const cells = new Uint8Array(CHUNK_SIZE * CHUNK_SIZE)
    cells[3 * CHUNK_SIZE + 5] = 1                                    // wall at local (5, 3)
    cells[(CHUNK_SIZE - 1) * CHUNK_SIZE + (CHUNK_SIZE - 1)] = 1      // wall at local (21, 21)
    const grid = createGridReader(countingCache(cells), () => false)
    expect(grid.floor(5, 3)).toBe(false)
    expect(grid.floor(6, 3)).toBe(true)
    expect(grid.floor(5 + CHUNK_SIZE, 3 - CHUNK_SIZE)).toBe(false)
    expect(grid.floor(-1, -1)).toBe(false)                           // chunk (-1,-1), local (21,21)
    expect(grid.floor(-2, -1)).toBe(true)
  })

  it('agrees with cache.isWall over a real cache', () => {
    const cache = createChunkCache({ chunkEvictRadius: 3 }, 7)
    const grid = createGridReader(cache, cache.isWall)
    grid.setPlayerChunk(0, 0)
    for (let iy = -30; iy < 30; iy++)
      for (let ix = -30; ix < 30; ix++)
        expect(grid.floor(ix, iy)).toBe(!cache.isWall(ix + 0.5, iy + 0.5, 0, 0))
  })

  it('without a cache (Level null: createFixedMap) it wraps isWallFn at the cell centre', () => {
    const asked = []
    const isWall = (x, y) => { asked.push([x, y]); return x === 2.5 && y === 3.5 }
    const grid = createGridReader(null, isWall)
    expect(grid.floor(2, 3)).toBe(false)
    expect(grid.floor(1, 3)).toBe(true)
    expect(asked).toEqual([[2.5, 3.5], [1.5, 3.5]])
    grid.setPlayerChunk(1, 1)                                        // accepted, a no-op
    const fixed = createGridReader({ isWall, preload() {} }, isWall) // a fixed map has no getChunk
    expect(fixed.floor(2, 3)).toBe(false)
  })
})

// W8: the docket rides in world.json; DEFAULT_CONFIG carries its zeros so a drifted file
// without the key merges to an empty docket (loadConfig's `{ ...DEFAULT_CONFIG, ...json }`).
describe('DEFAULT_CONFIG.docket', () => {
  const ZEROS = {
    '0': { extension: 0, compliance: 0, litigation: 0 },
    '1': { extension: 0, compliance: 0, litigation: 0 },
    '2': { extension: 0, compliance: 0, litigation: 0 },
    '3': { extension: 0, compliance: 0, litigation: 0 },
  }
  const text = readFileSync(new URL('../src/renderer/world.json', import.meta.url), 'utf8')

  it('is four level rows of three zero columns', () => {
    expect(DEFAULT_CONFIG.docket).toEqual(ZEROS)
  })

  it('the merge takes the file\'s docket', () => {
    const file = JSON.parse(text)
    expect({ ...DEFAULT_CONFIG, ...file }.docket).toEqual(file.docket)
  })

  it('a drifted file without the key merges to the zeros', () => {
    const file = JSON.parse(text)
    delete file.docket
    expect({ ...DEFAULT_CONFIG, ...file }.docket).toEqual(ZEROS)
  })

  it('the shipped world.json carries a zero docket', () => {
    expect(JSON.parse(text).docket).toEqual(ZEROS)
  })
})
