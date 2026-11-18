// block-stacks.js (the block's storeys): the storey stacks of the block and which one every wall face shows,
// and the fixed map's stackAt over them (fixedmap.js). The tiles are gfx-textures.js's (gfx-block-bands.test.js); the plan is pinned by
// block-facade-plan.test.js.
import { describe, it, expect } from 'vitest'
import { planBlockStacks, facadeFor, houseLook, houseRoof, lookKey } from '../src/renderer/block-stacks.js'
import { planBlockFacade, HOUSE_SEED } from '../src/renderer/block-facade-plan.js'
import { createFixedMap, fixedMapHooks } from '../src/renderer/fixedmap.js'
import { NULL_MAP } from '../src/renderer/level-null-map.js'
import { levelConfig, LEVELS } from '../src/renderer/levels.js'
import { DEFAULT_CONFIG } from '../src/renderer/world.js'
import { isSealedMaterial } from '../src/renderer/origin-tenant.js'

const plan = planBlockFacade(NULL_MAP, HOUSE_SEED)
const S = planBlockStacks(plan)
const open = (x, y) => { const c = (NULL_MAP[y] ?? '')[x]; return c === '.' || c === ' ' }
const W = NULL_MAP[0].length, H = NULL_MAP.length
const at = (x, y, side) => S.faces[(y * W + x) * 2 + side]
// every wall face that an open cell looks at: (cell, side) with side 0 = an east / west face, 1 = a north / south face
function visibleFaces() {
  const out = []
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (open(x, y)) continue
    if ((x > 0 && open(x - 1, y)) || (x < W - 1 && open(x + 1, y))) out.push([x, y, 0])
    if ((y > 0 && open(x, y - 1)) || (y < H - 1 && open(x, y + 1))) out.push([x, y, 1])
  }
  return out
}

describe('planBlockStacks over the stock map', () => {
  it('every face an open cell looks at has a stack; nothing else does', () => {
    const vis = visibleFaces()
    expect(vis.length).toBe(96)                                          // the stock map has 96 exposed faces
    const seen = new Set(vis.map(([x, y, s]) => `${x},${y},${s}`))
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) for (const side of [0, 1]) {
      const i = at(x, y, side)
      if (seen.has(`${x},${y},${side}`)) { expect(i, `${x},${y},${side}`).toBeGreaterThanOrEqual(0); expect(i).toBeLessThan(S.stacks.length) }
      else expect(i, `${x},${y},${side}`).toBe(-1)
    }
  })
  it('over each bay stands what its code says: sealed doors under black windows, lit bays under shades, solid bays blank', () => {
    const bayOf = { C: 'window', W: 'window', P: 'board', O: 'shade', F: 'solid', B: 'solid' }
    for (const h of plan.houses) for (const c of h.cells) {
      const s = S.stacks[at(c.x, c.y, h.run === 'N' || h.run === 'S' ? 1 : 0)]
      expect(s.kind).toBe('upper')
      expect(s.bay).toBe(h.type === 'corner' ? 'corner' : bayOf[c.code])
      expect(s.look).toEqual(houseLook(h)); expect(s.roof).toBe(houseRoof(h))
      if (isSealedMaterial(c.code)) expect(s.look.wear).toBe('vacant')       // every knock door is in a vacant house
      if (c.code === 'O') expect(s.look.wear).toBe('kept')
    }
  })
  it('the variants: P boarded 1 in 4, O lit 1 in 2, F / B a small window 1 in 3; roofless houses show the sky in their voids', () => {
    for (const s of S.stacks.filter((t) => t.kind === 'upper')) {
      const count = (v) => s.variants.filter((n) => n === v).length
      if (s.bay === 'board') { expect(s.variants.length).toBe(4); expect(count('boarded')).toBe(1) }
      if (s.bay === 'shade') expect(s.variants).toEqual(['lit', 'dark'])
      if (s.bay === 'solid') { expect(s.variants.length).toBe(3); expect(count('small')).toBe(1) }
      const voids = s.variants.filter((n) => n === 'void' || n === 'rail').length, skies = s.variants.filter((n) => n === 'sky' || n === 'skyRail').length
      if (s.look.roofless) expect(voids).toBe(0); else expect(skies).toBe(0)
    }
    expect(S.stacks.some((s) => s.look && s.look.roofless && s.variants.includes('sky'))).toBe(true)       // E1 and W4 are roofless (the stock plan)
  })
  it('the juts: back rows show the house back, fronts their door bay at the jut\'s own end (M), ends the party wall', () => {
    for (const h of plan.juts) {
      const J = h.jut
      for (const c of J.back) expect(S.stacks[at(c.x, c.y, 1)].kind).toBe('upper')
      for (const c of J.front) {
        const s = S.stacks[at(c.x, c.y, 1)]
        expect(s.kind).toBe('front'); expect(s.jut).toBe(J.name); expect(s.clad).toBe(J.frontCladding)
        expect(s.bay).toBe(c.x === J.doorX ? 'door' : 'window')
      }
      for (const x of [J.ends[0].x, J.ends[1].x - 1]) for (const [k, y] of [J.ends[0].y0, J.ends[0].y0 + 1].entries()) {
        const s = S.stacks[at(x, y, 0)]
        expect(s.kind).toBe('end'); expect(s.cell).toBe(k)
      }
    }
    expect(plan.juts.map((h) => h.jut.doorX)).toEqual([8, 16])
  })
  it('stacks are shared by key and the order is fixed (the same plan gives the same indices)', () => {
    expect(new Set(S.stacks.map((s) => s.key)).size).toBe(S.stacks.length)
    const again = planBlockStacks(planBlockFacade(NULL_MAP, HOUSE_SEED))
    expect(again.stacks.map((s) => s.key)).toEqual(S.stacks.map((s) => s.key))
    expect(Buffer.from(again.faces.buffer).equals(Buffer.from(S.faces.buffer))).toBe(true)
    for (const s of S.stacks) if (s.look) expect(s.key).toContain(lookKey(s.look))
  })
  it('the stacks carry no text: every string is a code word of the art', () => {
    const words = JSON.stringify(S.stacks)
    expect(words).not.toMatch(/\d{3}/)     // (no run of three digits at all, so none of the game text's either)
  })
})

describe('facadeFor and the fixed map', () => {
  const block = LEVELS.findIndex((l) => l.id === '∅')
  it('only the block with its look and a taller wall draws storeys', () => {
    const cfg = levelConfig(DEFAULT_CONFIG, block)
    expect(cfg.wallH).toBe(3.5)
    expect(facadeFor(cfg)).toEqual(plan)
    expect(facadeFor({ ...cfg, wallH: 1 })).toBe(null)
    expect(facadeFor({ ...cfg, look: null })).toBe(null)
    expect(facadeFor({ ...cfg, look: { ...cfg.look, facade: 'other' } })).toBe(null)
    for (let i = 0; i < LEVELS.length; i++) if (i !== block) expect(facadeFor(levelConfig(DEFAULT_CONFIG, i))).toBe(null)
  })
  it('createFixedMap without a plan is what it was; with one, stackAt reads the faces (-1 off the map)', () => {
    const bare = createFixedMap(NULL_MAP)
    expect(Object.keys(bare).sort()).toEqual(['height', 'isWall', 'materialAt', 'preload', 'width'])
    const m = createFixedMap(NULL_MAP, plan)
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) for (const side of [0, 1]) {
      expect(m.stackAt(x + 0.5, y + 0.5, side)).toBe(at(x, y, side)); expect(m.stackAt(x, y, side)).toBe(at(x, y, side))
      expect(m.isWall(x + 0.5, y + 0.5)).toBe(bare.isWall(x + 0.5, y + 0.5)); expect(m.materialAt(x + 0.5, y + 0.5)).toBe(bare.materialAt(x + 0.5, y + 0.5))
    }
    for (const [x, y] of [[-1, 3], [3, -1], [W, 3], [3, H]]) expect(m.stackAt(x, y, 0)).toBe(-1)
    expect(m.facade).toBe(plan)
  })
  it('fixedMapHooks: the materials, and the stacks of the map\'s plan or of the one handed in', () => {
    const bare = createFixedMap(NULL_MAP)
    expect(Object.keys(fixedMapHooks(bare))).toEqual(['materialAt'])
    const h = fixedMapHooks(bare, plan), h2 = fixedMapHooks(createFixedMap(NULL_MAP, plan))
    expect(h.facade).toBe(plan); expect(h2.facade).toBe(plan)
    for (const [x, y, s] of visibleFaces()) { expect(h.stackAt(x, y, s)).toBe(at(x, y, s)); expect(h2.stackAt(x, y, s)).toBe(at(x, y, s)) }
    expect(h.materialAt(0.5, 0.5)).toBe('F')
  })
})
