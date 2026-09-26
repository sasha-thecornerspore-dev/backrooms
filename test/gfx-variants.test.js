// TexSet v2 tile variants in the world pass (gfx-world.js): per-cell wall / floor / ceiling variants are chosen by
// hashing the cell address (never a PRNG stream), only when the TexSet supplies them; with null variants the pass is
// exactly the single-base-tile behaviour the pixel-identical refactor was proven against.
import { describe, it, expect } from 'vitest'
import { renderWorld } from '../src/renderer/gfx-world.js'
import { castRay } from '../src/renderer/raycaster.js'
import { hash2 } from '../src/renderer/gfx-util.js'

const isWall = (wx, wy) => wx <= 0 || wy <= 0 || wx >= 11 || wy >= 11   // 12x12 box, player in the middle
const fov = Math.PI / 2.4
const W = 96, H = 40

function fs(over = {}) {
  return {
    W, H, HH: H >> 1, OW: W, OH: H,
    fog: 1e9, fogRgb: [212, 200, 122], fogMul: 1, flicker: 1, rawFlicker: 1, frame: 1, t: 0, dt: 1 / 60,
    player: { x: 5.5, y: 5.5, angle: 0, bobOffset: 0 },
    lights: {}, lightsOn: false, hasSky: false, skyRgb: null, light: null, comfort: { reduceFlicker: false, maxGlobalDip: 1 },
    quality: { scale: 0.6 }, opts: {}, fov, hf: fov / 2, ...over,
  }
}
const tile = (ts, base) => {
  const t = new Uint8Array(ts * ts * 3)
  for (let i = 0; i < t.length; i += 3) { t[i] = base; t[i + 1] = base; t[i + 2] = base }
  return t
}
function render(tex, over) {
  const buf32 = new Uint32Array(W * H), zbuffer = new Float32Array(W)
  renderWorld(fs(over), tex, null, isWall, null, buf32, zbuffer)
  return buf32
}
const red = (buf, x, y) => buf[y * W + x] & 255
const base = (extra = {}) => ({ ts: 2, tmask: 1, walls: { 0: tile(2, 100) }, ceil: tile(2, 60), floor: tile(2, 40), light: tile(2, 200), ...extra })

describe('wall variants', () => {
  it('null variants (or a single-entry array) leave every wall on the base tile', () => {
    for (const wallVar of [null, { 0: [tile(2, 180)] }]) {
      const buf = render(base({ wallVar }))
      for (let x = 0; x < W; x++) {
        const r = red(buf, x, H >> 1)
        // y-side faces are darkened to 72%; either way it is the 100-tile (72..100), never the 180 one
        expect(r).toBeGreaterThanOrEqual(70); expect(r).toBeLessThanOrEqual(101)
      }
    }
  })
  it('a multi-entry array is indexed by hash2(hitCellX, hitCellY, side) % length', () => {
    const tex = base({ wallVar: { 0: [tile(2, 100), tile(2, 200)] } })
    const buf = render(tex)
    let seen0 = 0, seen1 = 0
    for (let col = 0; col < W; col++) {
      const angle = -fov / 2 + (col / W) * fov
      const hit = castRay(5.5, 5.5, angle, isWall, 20)
      const idx = hash2(hit.mx, hit.my, hit.side) % 2
      const r = red(buf, col, H >> 1)
      const sideMul = hit.side === 1 ? 0.72 : 1
      const expected = (idx === 0 ? 100 : 200) * sideMul
      expect(Math.abs(r - expected), `col ${col}`).toBeLessThanOrEqual(2)
      if (idx === 0) seen0++; else seen1++
    }
    expect(seen0 + seen1).toBe(W)
    expect(seen0).toBeGreaterThan(0); expect(seen1).toBeGreaterThan(0)   // the scene really exercises both variants
  })
  it('is deterministic frame to frame', () => {
    const tex = base({ wallVar: { 0: [tile(2, 100), tile(2, 200)] } })
    expect(Array.from(render(tex))).toEqual(Array.from(render(tex)))
  })
})

describe('floor and ceiling variants', () => {
  it('null variants give a single floor colour along the bottom rows', () => {
    const buf = render(base())
    const vals = new Set()
    for (let x = 0; x < W; x++) vals.add(red(buf, x, H - 1))
    expect([...vals].every((v) => v === 40)).toBe(true)
  })
  it('floor variants appear per cell, both kinds present, and are stable', () => {
    const tex = base({ floorVar: [tile(2, 40), tile(2, 140)] })
    const a = render(tex), b = render(tex)
    expect(Array.from(a)).toEqual(Array.from(b))
    // every floor pixel is exactly one of the two tiles' colours (walls are 72..100 and never collide with 40/140);
    // rows near the horizon reach many distinct cells, so both variants must occur
    let low = 0, high = 0
    for (let y = (H >> 1) + 1; y < H; y++) for (let x = 0; x < W; x++) { const r = red(a, x, y); if (r === 40) low++; else if (r === 140) high++ }
    expect(low).toBeGreaterThan(0); expect(high).toBeGreaterThan(0)
  })
  it('ceiling variants are picked with a different hash channel than the floor', () => {
    // same two tiles for both; if the channel were shared, ceiling and floor would mirror each other exactly
    const tiles = [tile(2, 40), tile(2, 140)]
    const buf = render(base({ floorVar: tiles, ceilVar: tiles, ceil: tile(2, 40) }))
    let differing = 0
    for (let d = 1; d <= 6; d++) for (let x = 0; x < W; x++) {
      if (red(buf, x, (H >> 1) - d) !== red(buf, x, (H >> 1) + d)) differing++
    }
    expect(differing).toBeGreaterThan(0)
  })
})
