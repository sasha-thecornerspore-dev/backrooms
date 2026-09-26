// Track HW, stage 2: the lit floor pass jumps from cell to cell along a row by the exact run of pixels each cell covers (cellRun in
// gfx-world.js) instead of testing every pixel's cell. The run must be exactly the pixels a pixel-by-pixel walk puts in the cell, at every
// scale the pass uses (2^21 .. 2^23 fixed-point units per cell), for steps of either sign, zero, and rows that start or land exactly on a
// cell boundary; test/gfx-hw-perf.test.js then checks whole frames against the frozen reference.
import { describe, it, expect } from 'vitest'
import { cellRun, RUN } from '../src/renderer/gfx-world.js'

// the walk: pixels x in [0, W) whose coordinate p0 + x*d (added up one pixel at a time, as the old loop did) is in cell c
function walk(p0, d, c, S, W) {
  let lo = -1, hi = -1, p = p0
  for (let x = 0; x < W; x++, p = (p + d) | 0) {
    const inCell = (p >> S) === c
    if (inCell && lo < 0) lo = x
    if (!inCell && lo >= 0 && hi < 0) hi = x
  }
  if (lo < 0) return null
  return { lo, hi: hi < 0 ? W : hi }
}

// a small deterministic generator (the test must not depend on Math.random)
function rng(seed) { let s = seed >>> 0; return () => { s = (s + 0x6d2b79f5) >>> 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 } }

describe('cellRun: the exact run of a cell along a row', () => {
  it('matches the pixel-by-pixel walk for random rows at every fixed-point scale', () => {
    const r = rng(0x5eed)
    let checked = 0
    for (const S of [21, 22, 23]) {
      const CU = 2 ** S
      for (let n = 0; n < 4000; n++) {
        const W = 1 + ((r() * 900) | 0)
        // a row that stays inside the positive int32 range, like the pass's (its two ends within 8 .. 250 units of the relative origin)
        const a = 8 + r() * 242, b = 8 + r() * 242
        const p0 = (a * CU) | 0
        let d = Math.round((b - a) * CU / W)
        if (n % 17 === 0) d = 0
        if (n % 23 === 0) d = Math.round(d / CU * 8) * (CU / 8)                  // steps that land exactly on cell boundaries
        if (p0 + W * d < 0 || p0 + W * d >= 2 ** 31) continue
        const x0 = (r() * W) | 0
        const c = (p0 + x0 * d) >> S
        cellRun(p0, d, c, CU, W)
        const w = walk(p0, d, c, S, W)
        expect({ lo: Math.max(0, RUN.lo), hi: RUN.hi }, `S=${S} p0=${p0} d=${d} c=${c} W=${W}`).toEqual(w)
        checked++
      }
    }
    expect(checked).toBeGreaterThan(10000)
  })

  it('rows that start exactly on a boundary, and single-pixel rows', () => {
    const S = 22, CU = 2 ** S
    for (const [p0, d, W] of [[5 * CU, CU / 4, 40], [5 * CU, -CU / 4, 40], [5 * CU - 1, 1, 10], [5 * CU, -1, 10], [9 * CU + 3, CU, 7], [9 * CU, -CU, 7], [100 * CU, 12345, 1], [100 * CU, 0, 30]]) {
      for (let x0 = 0; x0 < W; x0++) {
        const c = (p0 + x0 * d) >> S
        cellRun(p0, d, c, CU, W)
        expect({ lo: Math.max(0, RUN.lo), hi: RUN.hi }, `p0=${p0} d=${d} x0=${x0}`).toEqual(walk(p0, d, c, S, W))
      }
    }
  })
})
