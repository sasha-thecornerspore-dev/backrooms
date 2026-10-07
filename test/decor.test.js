import { describe, it, expect } from 'vitest'
import { createDecorSystem } from '../src/renderer/decor.js'
import { levelConfig } from '../src/renderer/levels.js'
import { DEFAULT_CONFIG, createChunkCache, CHUNK_SIZE } from '../src/renderer/world.js'

const open  = () => false   // no walls
const solid = () => true    // walls everywhere
const L0 = levelConfig(DEFAULT_CONFIG, 0)

describe('decor system', () => {
  it('places props and exits deterministically', () => {
    const a = createDecorSystem(L0, open); a.update(0, 0)
    const b = createDecorSystem(L0, open); b.update(0, 0)
    expect(a.getProps()).toEqual(b.getProps())
    expect(a.getExits()).toEqual(b.getExits())
  })

  it('scatters furniture props in the scan radius', () => {
    const sys = createDecorSystem(L0, open); sys.update(0, 0)
    expect(sys.getProps().length).toBeGreaterThan(0)
    for (const p of sys.getProps()) expect(L0.props.types).toContain(p.type)
  })

  it('always leaves at least one findable exit nearby', () => {
    const sys = createDecorSystem(L0, open); sys.update(0, 0)
    const exits = sys.getExits()
    expect(exits.length).toBeGreaterThan(0)
    for (const e of exits) expect(e.target).toBe(L0.exit.target)
  })

  it('nearestExit finds an exit within range and nothing beyond it', () => {
    const sys = createDecorSystem(L0, open); sys.update(0, 0)
    const e = sys.getExits()[0]
    expect(sys.nearestExit(e.x + 0.3, e.y, 1.1).key).toBe(e.key)
    expect(sys.nearestExit(e.x + 40, e.y + 40, 1.1)).toBeNull()
  })

  it('places nothing where every cell is wall', () => {
    const sys = createDecorSystem(L0, solid); sys.update(0, 0)
    expect(sys.getProps()).toHaveLength(0)
    expect(sys.getExits()).toHaveLength(0)
  })

  it('enterLevel swaps prop set and resets placement', () => {
    const sys = createDecorSystem(L0, open); sys.update(0, 0)
    const L2 = levelConfig(DEFAULT_CONFIG, 2)
    sys.enterLevel(L2); sys.update(0, 0)
    for (const p of sys.getProps()) expect(L2.props.types).toContain(p.type)
  })

  it('a fixed-map level pins exactly one exit at exitAt and skips the scatter', () => {
    const cfg = { ...L0, exitAt: { x: 12.5, y: 9.5 }, exit: { target: 0, denom: 1 } }
    const sys = createDecorSystem(cfg, open); sys.update(0, 0)
    const exits = sys.getExits()
    expect(exits).toHaveLength(1)                          // one, not the denom-1 scatter
    expect(exits[0]).toMatchObject({ x: 12.5, y: 9.5, target: 0 })
    sys.update(40, 40)                                     // walking far never evicts it
    expect(sys.getExits()).toHaveLength(1)
  })

  // ── the form on the counter: a fixed-map level's authored notes (cfg.notes, ∅ only) ──
  const FORM_CFG = { ...L0, exitAt: { x: 12.5, y: 9.5 }, exit: { target: 0, denom: 1 }, scraps: { denom: 0 }, notes: [{ x: 6.5, y: 6.5 }] }

  it('cfg.notes places exactly one scrap, keyed outside the chunks, frag -1, form', () => {
    const sys = createDecorSystem(FORM_CFG, open); sys.update(0, 0)
    expect(sys.getScraps()).toEqual([{ key: '∅:n0', x: 6.5, y: 6.5, frag: -1, form: true }])
    sys.update(40, 40)                                     // never evicted, like the '∅' exit
    expect(sys.getScraps()).toEqual([{ key: '∅:n0', x: 6.5, y: 6.5, frag: -1, form: true }])
    sys.update(40, 40)
    expect(sys.getScraps()).toHaveLength(1)                // placed once
  })

  it('nearestScrap finds the form within 1.8 and nothing beyond', () => {
    const sys = createDecorSystem(FORM_CFG, open); sys.update(0, 0)
    expect(sys.nearestScrap(6.7, 6.5, 1.8).key).toBe('∅:n0')
    expect(sys.nearestScrap(40, 40, 1.8)).toBeNull()
  })

  it('enterLevel to a cfg without notes clears the form', () => {
    const sys = createDecorSystem(FORM_CFG, open); sys.update(0, 0)
    sys.enterLevel(L0); sys.update(0, 0)
    expect(sys.getScraps().some((s) => String(s.key).startsWith('∅:n'))).toBe(false)
    sys.enterLevel(FORM_CFG); sys.update(0, 0)             // and back: re-read, placed again
    expect(sys.getScraps().filter((s) => s.form)).toHaveLength(1)
  })
})

// ── settled placement (placement.js through decor) ──────────────────────────────────────────────────────────────────────
const walled = (cfg = L0, seed = 0) => {
  const cache = createChunkCache(cfg, seed)
  return (wx, wy, pcx, pcy) => cache.isWall(wx, wy, pcx, pcy)
}
const bodiesOf = (sys) => [...sys.getProps(), ...sys.getNpcs(), ...sys.getMachines(), ...sys.getSights()]
const frac = (v) => v - Math.floor(v)

describe('settled placement', () => {
  it('settled positions differ from the cell centre by <= 0.40 per axis and stay in the same cell on a generateChunk-backed isWall', () => {
    const sys = createDecorSystem(L0, walled()); sys.update(0, 0)
    const bodies = bodiesOf(sys)
    expect(bodies.length).toBeGreaterThan(50)
    let moved = 0
    for (const b of bodies) {
      const cx = Math.floor(b.x) + 0.5, cy = Math.floor(b.y) + 0.5
      expect(Math.abs(b.x - cx)).toBeLessThanOrEqual(0.40)
      expect(Math.abs(b.y - cy)).toBeLessThanOrEqual(0.40)
      expect(b.x - cx === 0 || b.y - cy === 0).toBe(true)                      // a hug moves one axis only
      if (b.x !== cx || b.y !== cy) { moved++; expect(b.hug).toMatch(/^[NESW]$/) }
      expect(['room', 'corridor', 'nook', 'junction']).toContain(b.cellCls)
      expect(['solid', 'clutter', 'none']).toContain(b.cls)
    }
    expect(moved).toBeGreaterThan(20)
    // exits, scraps are never settled: still at cell centres, no placement fields
    for (const e of [...sys.getExits(), ...sys.getScraps()]) { expect(frac(e.x)).toBeCloseTo(0.5, 12); expect(frac(e.y)).toBeCloseTo(0.5, 12); expect('hug' in e).toBe(false) }
  })

  it('on the open grid nothing moves: every body sits at its cell centre, unhugged, in a room', () => {
    const sys = createDecorSystem(L0, open); sys.update(0, 0)
    for (const b of bodiesOf(sys)) {
      expect(frac(b.x)).toBeCloseTo(0.5, 12); expect(frac(b.y)).toBeCloseTo(0.5, 12)
      expect(b.hug).toBeNull(); expect(b.cellCls).toBe('room')
      expect(b.cls).toBe(b.type === 'papers' ? 'none' : 'solid')
    }
  })

  it('two systems with identical walls produce byte-identical settled lists', () => {
    const a = createDecorSystem(L0, walled()); a.update(0, 0)
    const b = createDecorSystem(L0, walled()); b.update(0, 0)
    expect(JSON.stringify(bodiesOf(a))).toBe(JSON.stringify(bodiesOf(b)))
    expect(JSON.stringify(a.getExits())).toBe(JSON.stringify(b.getExits()))
  })

  it('exit records carry kind/label; positions and targets are unchanged vs a cfg without ways', () => {
    const plain = createDecorSystem(L0, open); plain.update(0, 0)
    const ways = createDecorSystem({ ...L0, ways: [{ kind: 'hole', label: 'drop through the floor' }] }, open); ways.update(0, 0)
    const a = plain.getExits(), b = ways.getExits()
    expect(a.length).toBeGreaterThan(0)
    expect(a.map((e) => [e.key, e.x, e.y, e.target])).toEqual(b.map((e) => [e.key, e.x, e.y, e.target]))
    for (const e of a) expect(e).toMatchObject({ kind: 'down', label: L0.exit.label })
    for (const e of b) expect(e).toMatchObject({ kind: 'hole', label: 'drop through the floor' })
    // no exit label at all -> 'descend'
    const bare = createDecorSystem({ ...L0, exit: { target: 1, denom: 4 } }, open); bare.update(0, 0)
    for (const e of bare.getExits()) expect(e).toMatchObject({ kind: 'down', label: 'descend' })
    // the fixed-map exit likewise
    const fixed = createDecorSystem({ ...L0, exitAt: { x: 12.5, y: 9.5 }, exit: { target: 0, denom: 1, label: 'no-clip out' } }, open); fixed.update(0, 0)
    expect(fixed.getExits()[0]).toMatchObject({ key: '∅', x: 12.5, y: 9.5, target: 0, kind: 'down', label: 'no-clip out' })
    // enterLevel re-reads ways
    ways.enterLevel(levelConfig(DEFAULT_CONFIG, 1)); ways.update(0, 0)
    for (const e of ways.getExits()) expect(e).toMatchObject({ kind: 'down', label: 'descend' })
  })

  it('props keep their chunk after settling (a hug never crosses a cell, let alone a chunk)', () => {
    const sys = createDecorSystem(L0, walled()); sys.update(0, 0)
    for (const p of sys.getProps()) {
      const [cx, cy] = p.key.split(':')[0].split(',').map(Number)
      expect(Math.floor(p.x / CHUNK_SIZE)).toBe(cx); expect(Math.floor(p.y / CHUNK_SIZE)).toBe(cy)
    }
  })
})
