import { describe, it, expect } from 'vitest'
import { lineOfSight, inViewCone } from '../src/renderer/raycaster.js'
import { HF } from '../src/renderer/gfx-frame.js'

const open = () => true
const wallAt = (wx, wy) => (ix, iy) => !(ix === wx && iy === wy)
function mulberry32(seed) {
  let s = seed >>> 0
  return () => { s += 0x6D2B79F5; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = t + Math.imul(t ^ (t >>> 7), 61 | t) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}

describe('lineOfSight', () => {
  it('is clear in an open grid', () => {
    expect(lineOfSight(0.5, 0.5, 12.5, 7.5, open)).toBe(true)
    expect(lineOfSight(12.5, 7.5, 0.5, 0.5, open)).toBe(true)
    expect(lineOfSight(-3.2, 4.7, 9.1, -6.4, open)).toBe(true)
  })

  it('is blocked by one wall cell on the segment', () => {
    expect(lineOfSight(0.5, 0.5, 10.5, 0.5, wallAt(5, 0))).toBe(false)     // along x
    expect(lineOfSight(2.5, 0.5, 2.5, 9.5, wallAt(2, 4))).toBe(false)      // along y
    expect(lineOfSight(0.5, 0.5, 6.5, 6.5, wallAt(3, 3))).toBe(false)      // diagonal
    expect(lineOfSight(10.5, 0.5, 0.5, 0.5, wallAt(5, 0))).toBe(false)     // from the other end
  })

  it('is true when the only wall is past the target', () => {
    expect(lineOfSight(0.5, 0.5, 4.5, 0.5, wallAt(7, 0))).toBe(true)
    expect(lineOfSight(0.5, 0.5, 4.5, 4.5, wallAt(5, 5))).toBe(true)
  })

  it('stops at the target cell: the target itself never blocks and nothing beyond it is asked', () => {
    expect(lineOfSight(0.5, 0.5, 4.5, 0.5, wallAt(4, 0))).toBe(true)
    const asked = []
    lineOfSight(0.5, 0.5, 6.5, 3.5, (ix, iy) => { asked.push([ix, iy]); return true })
    for (const [ix, iy] of asked) { expect(ix).toBeGreaterThanOrEqual(0); expect(ix).toBeLessThanOrEqual(6); expect(iy).toBeGreaterThanOrEqual(0); expect(iy).toBeLessThanOrEqual(3) }
    expect(asked.some(([ix, iy]) => ix === 6 && iy === 3)).toBe(false)
  })

  it('is true within one cell without asking the grid', () => {
    let n = 0
    expect(lineOfSight(3.2, 3.2, 3.8, 3.9, () => { n++; return false })).toBe(true)
    expect(n).toBe(0)
  })

  it('does not ask about the starting cell', () => {
    expect(lineOfSight(2.5, 2.5, 6.5, 2.5, wallAt(2, 2))).toBe(true)
  })

  it('maxSteps bounds the walk and defaults to 2*ceil(dist)+2', () => {
    let n = 0
    expect(lineOfSight(0.5, 0.5, 50.5, 0.5, () => { n++; return true }, 10)).toBe(false)
    expect(n).toBeLessThanOrEqual(10)
    n = 0
    lineOfSight(0.5, 0.5, 30.5, 20.5, () => { n++; return true })
    expect(n).toBeLessThanOrEqual(2 * Math.ceil(Math.hypot(30, 20)) + 2)
  })

  it('returns a plain boolean, deterministically', () => {
    const r = lineOfSight(0.5, 0.5, 9.5, 2.5, wallAt(4, 1))
    expect(typeof r).toBe('boolean')
    expect(lineOfSight(0.5, 0.5, 9.5, 2.5, wallAt(4, 1))).toBe(r)
  })
})

describe('inViewCone', () => {
  // the sprite-pass cull at gfx-sprites.js:2707-2714, transcribed
  function ref(px, py, pa, x, y, hf, reach) {
    const CA = Math.cos(pa), SAN = Math.sin(pa)
    const tanLim = Math.tan(Math.min(1.45, hf + 0.1))
    const ex = x - px, ey = y - py
    const fwd = ex * CA + ey * SAN
    if (!(fwd >= 0.35)) return false
    if (fwd > reach) return false
    const lat = -ex * SAN + ey * CA
    const lim = fwd * tanLim + 0.8
    if (lat > lim || lat < -lim) return false
    return true
  }
  // a point at camera depth fwd and lateral offset lat (inverse of the cull's rotation)
  const place = (px, py, pa, fwd, lat) => [px + fwd * Math.cos(pa) - lat * Math.sin(pa), py + fwd * Math.sin(pa) + lat * Math.cos(pa)]

  it('agrees with the reference transcription for 500 random placements', () => {
    const rnd = mulberry32(7)
    let seen = 0
    for (let i = 0; i < 500; i++) {
      const px = rnd() * 40 - 20, py = rnd() * 40 - 20, pa = rnd() * Math.PI * 4 - Math.PI * 2
      const x = px + rnd() * 40 - 20, y = py + rnd() * 40 - 20, reach = 8 + rnd() * 14
      const hf = rnd() < 0.8 ? HF : rnd() * 1.5
      const r = inViewCone(px, py, pa, x, y, hf, reach)
      expect(r).toBe(ref(px, py, pa, x, y, hf, reach))
      if (r) seen++
    }
    expect(seen).toBeGreaterThan(50)
    expect(seen).toBeLessThan(450)
  })

  it('agrees at the lateral boundary (lat = lim +/- 0.01) and the depth boundaries', () => {
    const rnd = mulberry32(11)
    const tanLim = Math.tan(Math.min(1.45, HF + 0.1))
    for (let i = 0; i < 100; i++) {
      const px = rnd() * 20, py = rnd() * 20, pa = rnd() * Math.PI * 2, reach = 16
      const fwd = 0.35 + rnd() * (reach - 0.35)
      const lim = fwd * tanLim + 0.8
      for (const [lat, want] of [[lim - 0.01, true], [lim + 0.01, false], [-lim + 0.01, true], [-lim - 0.01, false]]) {
        const [x, y] = place(px, py, pa, fwd, lat)
        expect(inViewCone(px, py, pa, x, y, HF, reach)).toBe(want)
        expect(inViewCone(px, py, pa, x, y, HF, reach)).toBe(ref(px, py, pa, x, y, HF, reach))
      }
      for (const [f, want] of [[0.35 + 0.01, true], [0.35 - 0.01, false], [reach - 0.01, true], [reach + 0.01, false]]) {
        const [x, y] = place(px, py, pa, f, 0)
        expect(inViewCone(px, py, pa, x, y, HF, reach)).toBe(want)
      }
    }
  })

  it('clamps the half-angle at 1.45 like the cull', () => {
    const [x, y] = place(0, 0, 0, 2, 2 * Math.tan(1.45) + 0.8 - 0.01)
    expect(inViewCone(0, 0, 0, x, y, 3, 16)).toBe(true)
    const [x2, y2] = place(0, 0, 0, 2, 2 * Math.tan(1.45) + 0.8 + 0.01)
    expect(inViewCone(0, 0, 0, x2, y2, 3, 16)).toBe(false)
  })

  it('never sees behind the camera or inside the near plane', () => {
    expect(inViewCone(0, 0, 0, -3, 0, HF, 16)).toBe(false)
    expect(inViewCone(0, 0, 0, 0.2, 0, HF, 16)).toBe(false)
    expect(inViewCone(0, 0, 0, NaN, 0, HF, 16)).toBe(false)
  })
})
