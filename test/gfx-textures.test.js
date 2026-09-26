// gfx-textures.js — the procedural tile art. The sha256 goldens below were computed from the ORIGINAL
// buildTextures() in renderer.js (commit 407b148, before the module split), so a pass here proves the refactor
// preserved every texture byte. Palettes / materials are copied from levels.js (level 0 and level ∅) rather than
// imported, so a later palette tweak in levels.js cannot silently move these goldens.
import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { buildTextures, buildWallTile } from '../src/renderer/gfx-textures.js'
import { hexToRgb, mulberry32 } from '../src/renderer/gfx-util.js'

const sha = (u8) => createHash('sha256').update(u8).digest('hex')

const L0 = { wall: '#C8B870', ceiling: '#E8E0C0', floor: '#4A3820', fog: '#D4C87A' }
const LN = { wall: '#B8A888', ceiling: '#B9B7AE', floor: '#5A5048', fog: '#9A968C' }
const LN_MATERIALS = { F: '#B8A888', C: '#8F8F8F', P: '#7A6A52', B: '#8A4A3A', W: '#141414', O: '#7A5A48', M: '#D2D0C8' }

describe('buildTextures — TexSet shape', () => {
  const tex = buildTextures(L0)

  it('exposes the tile size the world pass must sample with', () => {
    expect(tex.ts).toBe(64)
    expect(tex.tmask).toBe(63)
    expect(tex.tmask).toBe(tex.ts - 1)
  })

  it('has the four base tiles, each ts*ts RGB bytes', () => {
    for (const t of [tex.walls['0'], tex.ceil, tex.floor, tex.light]) {
      expect(t).toBeInstanceOf(Uint8Array)
      expect(t.length).toBe(tex.ts * tex.ts * 3)
    }
  })

  it('procedural levels get only material 0; authored maps add one tile per material code', () => {
    expect(Object.keys(tex.walls)).toEqual(['0'])
    const ln = buildTextures(LN, LN_MATERIALS)
    expect(Object.keys(ln.walls)).toEqual(['0', 'F', 'C', 'P', 'B', 'W', 'O', 'M'])
  })

  it('carries `look` through untouched (absent => today\'s look)', () => {
    expect(tex.look).toBeNull()
    const look = { wall: 'concrete' }
    expect(buildTextures(L0, null, look).look).toBe(look)
  })
})

describe('buildTextures — golden bytes from the original renderer.js', () => {
  it('level 0: wall 0, ceiling, floor, light panel', () => {
    const t = buildTextures(L0)
    expect(sha(t.walls['0'])).toBe('271a04fba8118033801e9436a980e1eaf54c58f4fa616d015ee005b782c0f0f1')
    expect(sha(t.ceil)).toBe('56ba02e2ef57f0bcf33b1449fe7ead84a0a9afbfacb204c1a3135b7f87aef82e')
    expect(sha(t.floor)).toBe('7e8fb9fe627e97e5b3e730b9755f736f691f52c6aa9289edd801f81165e2d9dc')
    expect(sha(t.light)).toBe('4abf1cf335489ea4cdcafb686df93a29b96be8a21227068e9862cc9041abf5ef')
  })

  it('level ∅: the base tiles plus every authored-material tile (formstone, CMU, plywood, brick, window, lit window, marble)', () => {
    const t = buildTextures(LN, LN_MATERIALS)
    expect(sha(t.walls['0'])).toBe('8553cf55610fa6ee07a997acc19663e8a100c4a2543bc4529794204ed19d5813')
    expect(sha(t.walls.F)).toBe('ef732bc240f63f27a5da4c10630b14ac89e201c11d15dabd20a295b16bab7ff9')
    expect(sha(t.walls.C)).toBe('8f7dbd5934544f29bad349b47f23e891baf5328f12405d1092571eb75ace5237')
    expect(sha(t.walls.P)).toBe('e3ff68ae51b1d026059f30457f1b6ec874c1a8b5ca799597d456f0c30b4c77cf')
    expect(sha(t.walls.B)).toBe('4a93b52be4d101bf5706bc626f7b20dd214698b0ac5e7cfdcfd4d505493e3ea5')
    expect(sha(t.walls.W)).toBe('8347ecd859aba83eea8f821c0bc931ec1d1fe2c7fd884bdb1735773df1beebdf')
    expect(sha(t.walls.O)).toBe('d9d65fd5c8d92824455a796ff997e839ef8b2b9399a80064a16b2941d39d4e30')
    expect(sha(t.walls.M)).toBe('6894987f9e15ae2305afc42959ed6eae8ad424d00699c8643a4fcb70f1e5b19c')
    expect(sha(t.ceil)).toBe('0fb9e1add9b4c736f484fbd74990a548bfc2857c4397fdf822766a392f23e48b')
    expect(sha(t.floor)).toBe('5797e05028554fa4a025db8c1a9fed04dd56e96082e396cd7e9fb0861f5fd209')
    expect(sha(t.light)).toBe('4abf1cf335489ea4cdcafb686df93a29b96be8a21227068e9862cc9041abf5ef')   // the panel ignores the palette
  })
})

describe('buildTextures — determinism and isolation', () => {
  it('two builds from the same palette are byte-identical', () => {
    const a = buildTextures(L0), b = buildTextures(L0)
    expect(sha(a.walls['0'])).toBe(sha(b.walls['0']))
    expect(sha(a.floor)).toBe(sha(b.floor))
  })

  it('adding materials cannot perturb the default wall / ceiling / floor (they use their own PRNGs)', () => {
    const bare = buildTextures(LN), withMats = buildTextures(LN, LN_MATERIALS)
    expect(sha(withMats.walls['0'])).toBe(sha(bare.walls['0']))
    expect(sha(withMats.ceil)).toBe(sha(bare.ceil))
    expect(sha(withMats.floor)).toBe(sha(bare.floor))
  })

  it('a material tile depends only on its base colour, its code and the fixed per-code seed', () => {
    const direct = buildWallTile(hexToRgb('#8A4A3A'), 'B', mulberry32(0x5EED0000 ^ 'B'.charCodeAt(0)))
    expect(sha(direct)).toBe(sha(buildTextures(LN, LN_MATERIALS).walls.B))
  })

  it('palette colours reach the tiles (a different wall colour gives a different wall)', () => {
    expect(sha(buildTextures({ ...L0, wall: '#204060' }).walls['0'])).not.toBe(sha(buildTextures(L0).walls['0']))
  })

  it('is import- and call-safe with no DOM (buildGrain is the only DOM user and is not called here)', () => {
    expect(typeof document).toBe('undefined')
    expect(() => buildTextures(L0)).not.toThrow()
  })
})

describe('buildTextures — level key and look (Track A1)', () => {
  const L0_WALL = '271a04fba8118033801e9436a980e1eaf54c58f4fa616d015ee005b782c0f0f1'
  it('the explicit legacy key, an unknown key and an empty look all reproduce the original tiles byte for byte', () => {
    for (const t of [buildTextures(L0, null, null, 'legacy'), buildTextures(L0, null, null, '9'), buildTextures(L0, null, {}, 'legacy'), buildTextures(L0, undefined, undefined, undefined)]) {
      expect(sha(t.walls['0'])).toBe(L0_WALL)
      expect(t.wallVar).toBeNull(); expect(t.floorVar).toBeNull(); expect(t.ceilVar).toBeNull()
    }
  })
  it('the materials of a hand-built config are the original flat tiles (the ∅ goldens above), even with a level key of ∅ absent', () => {
    expect(sha(buildTextures(LN, LN_MATERIALS, null, 'legacy').walls.F)).toBe('ef732bc240f63f27a5da4c10630b14ac89e201c11d15dabd20a295b16bab7ff9')
  })
  it('a real level key changes the art (levels 0-3 and ∅ no longer share one recoloured tile set)', () => {
    const legacy = buildTextures(L0)
    const real = buildTextures(L0, null, null, '0')
    expect(sha(real.walls['0'])).not.toBe(sha(legacy.walls['0']))
    expect(sha(real.floor)).not.toBe(sha(legacy.floor))
    expect(sha(real.ceil)).not.toBe(sha(legacy.ceil))
    expect(real.ts).toBe(legacy.ts)                                       // still 64: nearest-neighbour texels alias badly at distance
  })
  it('carries the level look through untouched on the styled path too', () => {
    const look = { wall: 'metal' }
    expect(buildTextures(L0, null, look, '0').look).toBe(look)
  })
})
