// collide.js — the one radius table, the per-chunk collider index, the circle resolver (wall AABB, solid push-out, tangential bias),
// creatures as bodies, the contact edges, and the legacy point mover. Everything here is pure and runs in Node.
import { describe, it, expect, vi } from 'vitest'
import {
  PLAYER_R, PLAYER_WALL_R, SOLID_CLASS, footprintRadius, visualHalf, creatureRadius, colliderFor, createColliderIndex,
  resolveCircle, creatureBlocks, movePoint, createSolidWorld,
} from '../src/renderer/collide.js'
import { PROP_SPEC, SIGHT_SPEC, MACHINE_SPEC, PERSON, FIG } from '../src/renderer/gfx-sprites.js'
import { SIGHT_TYPES } from '../src/renderer/decor.js'
import { CHUNK_SIZE } from '../src/renderer/world.js'

function mulberry32(seed) {
  let s = seed >>> 0
  return () => { s += 0x6D2B79F5; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = t + Math.imul(t ^ (t >>> 7), 61 | t) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}
const open = () => true
const dist = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by)
// the four corners of the player's wall box, the test's own copy of the rule
const aabbOpen = (floor, x, y) => {
  const R = PLAYER_WALL_R
  return floor(Math.floor(x - R), Math.floor(y - R)) && floor(Math.floor(x + R), Math.floor(y - R))
      && floor(Math.floor(x - R), Math.floor(y + R)) && floor(Math.floor(x + R), Math.floor(y + R))
}
// a record placed by hand (what placement.js writes), defaulting to a solid prop in a room
const rec = (over = {}) => ({ id: over.id ?? 1, x: 5, y: 0.5, r: 0.2, cls: 'solid', kind: 'prop', type: 'crate', key: 'k', cx: 0, cy: 0, cellCls: 'room', hug: null, ...over })
const indexWith = (...records) => {
  const index = createColliderIndex()
  const byKey = new Map()
  for (const r of records) { const k = `${Math.floor(r.x / CHUNK_SIZE)},${Math.floor(r.y / CHUNK_SIZE)}`; r.cx = Math.floor(r.x / CHUNK_SIZE); r.cy = Math.floor(r.y / CHUNK_SIZE); if (!byKey.has(k)) byKey.set(k, []); byKey.get(k).push(r) }
  for (const [k, list] of byKey) index.setChunk(k, list)
  return index
}
const fresh = () => ({ x: 0, y: 0, entered: null, enterSpeed: 0, enterNormalDot: 0, clutterId: 0, clutterType: null, clutterEntered: false, stepType: null, blockedBy: null })

describe('the radius table', () => {
  it('footprintRadius is SPEC.w * 0.45 for every prop and sight, 0.135 for a machine, 0.117 for a lost soul', () => {
    for (const [t, s] of Object.entries(PROP_SPEC)) expect(footprintRadius('prop', t), t).toBeCloseTo(s.w * 0.45, 12)
    for (const t of SIGHT_TYPES) expect(footprintRadius('sight', t), t).toBeCloseTo(SIGHT_SPEC[t].w * 0.45, 12)
    expect(footprintRadius('machine')).toBeCloseTo(MACHINE_SPEC.w * 0.45, 12)
    expect(footprintRadius('machine')).toBeCloseTo(0.135, 12)
    expect(footprintRadius('npc')).toBeCloseTo(PERSON.npc.w * 0.45, 12)
    expect(footprintRadius('npc')).toBeCloseTo(0.117, 12)
    expect(footprintRadius('prop', 'not-a-thing')).toBeCloseTo(PROP_SPEC.box.w * 0.45, 12)     // unknown -> box
    expect(footprintRadius('sight', 'not-a-thing')).toBeCloseTo(PROP_SPEC.box.w * 0.45, 12)
  })

  it('visualHalf is half the spec width', () => {
    expect(visualHalf('prop', 'cabinet')).toBeCloseTo(PROP_SPEC.cabinet.w / 2, 12)
    expect(visualHalf('sight', 'tvwall')).toBeCloseTo(SIGHT_SPEC.tvwall.w / 2, 12)
    expect(visualHalf('machine')).toBeCloseTo(MACHINE_SPEC.w / 2, 12)
    expect(visualHalf('npc')).toBeCloseTo(PERSON.npc.w / 2, 12)
    expect(visualHalf('prop', 'nope')).toBeCloseTo(PROP_SPEC.box.w / 2, 12)
  })

  it('creatureRadius is FIG.w * 0.375 for every variant, the shade for an unknown one', () => {
    for (const [v, f] of Object.entries(FIG)) expect(creatureRadius(v), v).toBeCloseTo(f.w * 0.375, 12)
    expect(creatureRadius('shade')).toBeCloseTo(0.135, 12)
    expect(creatureRadius('watcher')).toBeCloseTo(0.105, 12)
    expect(creatureRadius('smiler')).toBeCloseTo(0.12, 12)
    expect(creatureRadius('hound')).toBeCloseTo(0.3225, 12)
    expect(creatureRadius('crawler')).toBeCloseTo(0.375, 12)
    expect(creatureRadius('lurker')).toBeCloseTo(0.0975, 12)
    expect(creatureRadius('tesla')).toBeCloseTo(0.1425, 12)
    expect(creatureRadius('something-else')).toBeCloseTo(creatureRadius('shade'), 12)
    expect(creatureRadius(undefined)).toBeCloseTo(creatureRadius('shade'), 12)
  })

  it('PLAYER_R and PLAYER_WALL_R are the shipped numbers', () => {
    expect(PLAYER_R).toBe(0.16)
    expect(PLAYER_WALL_R).toBe(0.12)
  })

  it('contact damage (0.62) exceeds the largest creature radius plus the player: a closing creature still lands its hit', () => {
    const maxR = Math.max(...Object.keys(FIG).map(creatureRadius))
    expect(0.62).toBeGreaterThan(maxR + PLAYER_R)
    expect(maxR + PLAYER_R).toBeCloseTo(0.535, 12)
  })

  it('SOLID_CLASS is complete over PROP_SPEC + SIGHT_TYPES + machine + npc, and only papers, weeds and the pallet are none', () => {
    for (const t of Object.keys(PROP_SPEC)) expect(SOLID_CLASS[t], t).toBeDefined()
    for (const t of SIGHT_TYPES) expect(SOLID_CLASS[t], t).toBeDefined()
    expect(SOLID_CLASS.machine).toBe('solid')
    expect(SOLID_CLASS.npc).toBe('solid')
    for (const [t, c] of Object.entries(SOLID_CLASS)) {
      expect(['solid', 'none'], t).toContain(c)
      expect(c, t).toBe(t === 'papers' || t === 'weeds' || t === 'pallet' ? 'none' : 'solid')
    }
  })

  it('colliderFor builds a record from a decor object: radius, class, chunk, and placement fields left for placement.js', () => {
    const r = colliderFor('prop', { key: '2,-1:3', x: 50.5, y: -3.5, type: 'cabinet', rot: 1 })
    expect(r).toMatchObject({ x: 50.5, y: -3.5, kind: 'prop', type: 'cabinet', key: '2,-1:3', cls: 'solid', cx: 2, cy: -1, cellCls: null, hug: null })
    expect(r.r).toBeCloseTo(footprintRadius('prop', 'cabinet'), 12)
    expect(Number.isInteger(r.id)).toBe(true)
    expect(colliderFor('prop', { key: 'a', x: 1, y: 1, type: 'papers' }).cls).toBe('none')
    expect(colliderFor('prop', { key: 'a', x: 1, y: 1, type: 'unknown-thing' }).cls).toBe('solid')
    expect(colliderFor('machine', { key: 'm', x: 1, y: 1 })).toMatchObject({ kind: 'machine', type: 'machine', cls: 'solid' })
    expect(colliderFor('npc', { key: 'n', x: 1, y: 1 })).toMatchObject({ kind: 'npc', type: 'npc', cls: 'solid' })
    expect(colliderFor('sight', { key: 's', x: 1, y: 1, type: 'chairpile' }).r).toBeCloseTo(SIGHT_SPEC.chairpile.w * 0.45, 12)
    const a = colliderFor('prop', { key: 'a', x: 1, y: 1, type: 'box' }), b = colliderFor('prop', { key: 'a', x: 1, y: 1, type: 'box' })
    expect(a.id).not.toBe(b.id)
  })
})

describe('the collider index', () => {
  it('query returns colliders from all 8 neighbour chunks and none from chunks 2 away; dropChunk removes them', () => {
    const index = createColliderIndex()
    const N = CHUNK_SIZE
    let id = 1
    for (let cy = -1; cy <= 1; cy++) for (let cx = -1; cx <= 1; cx++) {
      index.setChunk(`${cx},${cy}`, [rec({ id: id++, x: cx * N + N / 2, y: cy * N + N / 2, cx, cy })])
    }
    index.setChunk('2,0', [rec({ id: 99, x: 2 * N + N / 2, y: N / 2, cx: 2, cy: 0 })])
    index.setChunk('0,-2', [rec({ id: 98, x: N / 2, y: -2 * N + N / 2, cx: 0, cy: -2 })])
    expect(index.size).toBe(11)
    const out = []
    const n = index.query(N / 2, N / 2, 1000, out)
    expect(n).toBe(9)
    const ids = out.slice(0, n).map((r) => r.id).sort((a, b) => a - b)
    expect(ids).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9])
    index.dropChunk('1,0')
    expect(index.query(N / 2, N / 2, 1000, out)).toBe(8)
    expect(index.size).toBe(10)
    index.dropChunk('nope,nope')      // unknown keys are ignored
    expect(index.size).toBe(10)
  })

  it('query matches by circle overlap (r + record.r) and writes into the caller-owned array without allocating', () => {
    const a = rec({ id: 1, x: 5, y: 5, r: 0.2 }), b = rec({ id: 2, x: 8, y: 5, r: 0.2 })
    const index = indexWith(a, b)
    const out = []
    expect(index.query(5.3, 5, 0.16, out)).toBe(1)          // d 0.3 < 0.36
    expect(out[0]).toBe(a)
    expect(index.query(5.4, 5, 0.16, out)).toBe(0)          // d 0.4 > 0.36
    const n = index.query(6.5, 5, 1.4, out)                // d 1.5 < 1.6 for both
    expect(n).toBe(2)
    expect(new Set([out[0], out[1]])).toEqual(new Set([a, b]))
    expect(index.query(6.5, 5, 1.4, out)).toBe(2)
    expect(index.query(6.5, 5, 1.2, out)).toBe(0)           // d 1.5 > 1.4
    expect(out[0] === a || out[0] === b).toBe(true)          // the same record objects, no copies
  })

  it('setChunk on a known key replaces its records', () => {
    const index = createColliderIndex()
    index.setChunk('0,0', [rec({ id: 1 }), rec({ id: 2, x: 6 })])
    expect(index.size).toBe(2)
    index.setChunk('0,0', [rec({ id: 3 })])
    expect(index.size).toBe(1)
    const out = []
    expect(index.query(5, 0.5, 100, out)).toBe(1)
    expect(out[0].id).toBe(3)
  })
})

describe('resolveCircle', () => {
  it('a circle walking +x into a solid collider stops at exactly r + PLAYER_R', () => {
    const cab = rec({ id: 1, x: 5, y: 0.5, r: footprintRadius('prop', 'cabinet'), type: 'cabinet' })
    const index = indexWith(cab)
    const out = fresh()
    let x = 4.0, y = 0.5
    for (let i = 0; i < 60; i++) { resolveCircle(x, y, x + 0.05, y, index, open, out); x = out.x; y = out.y }
    expect(y).toBeCloseTo(0.5, 9)
    expect(dist(x, y, cab.x, cab.y)).toBeCloseTo(cab.r + PLAYER_R, 3)
    expect(dist(x, y, cab.x, cab.y)).toBeGreaterThanOrEqual(cab.r + PLAYER_R)
  })

  it('a cone (r .0945) is reached at 0.2545', () => {
    const cone = rec({ id: 1, x: 5, y: 0.5, r: footprintRadius('prop', 'cone'), type: 'cone' })
    expect(cone.r).toBeCloseTo(0.0945, 12)
    const index = indexWith(cone)
    const out = fresh()
    let x = 4.0, y = 0.5
    for (let i = 0; i < 60; i++) { resolveCircle(x, y, x + 0.05, y, index, open, out); x = out.x; y = out.y }
    expect(dist(x, y, cone.x, cone.y)).toBeCloseTo(0.2545, 3)
  })

  it('slides along a wall with a diagonal velocity: y advances, x does not', () => {
    const floor = (ix, iy) => ix < 5                      // a wall face at x = 5
    const index = createColliderIndex()
    const out = fresh()
    resolveCircle(4.86, 0.5, 4.91, 0.55, index, floor, out)
    expect(out.x).toBe(4.86)
    expect(out.y).toBeCloseTo(0.55, 12)
    // and a step that fits is taken in full
    resolveCircle(4.80, 0.5, 4.85, 0.55, index, floor, out)
    expect(out.x).toBeCloseTo(4.85, 12); expect(out.y).toBeCloseTo(0.55, 12)
  })

  it('slides around a solid body with a diagonal velocity: y advances, x barely does', () => {
    const cab = rec({ id: 1, x: 5, y: 0.5, r: footprintRadius('prop', 'cabinet'), type: 'cabinet' })
    const index = indexWith(cab)
    const out = fresh()
    const x0 = 5 - (cab.r + PLAYER_R) - 1e-4, y0 = 0.5
    resolveCircle(x0, y0, x0 + 0.05, y0 + 0.05, index, open, out)
    expect(out.y).toBeGreaterThan(y0 + 0.03)
    expect(out.x).toBeLessThan(x0 + 0.01)
    expect(dist(out.x, out.y, cab.x, cab.y)).toBeGreaterThanOrEqual(cab.r + PLAYER_R)
  })

  it('tangential bias: a head-on meeting with a hugged corridor body (0.30 of lane left) slides past it, not a dead stop', () => {
    // one lane of cells (x, 0); a body of r 0.2 in the middle hugs the north wall, so 0.30 of the lane is left south of it
    const floor = (ix, iy) => iy === 0 && ix >= 0 && ix < 20
    const run = (cellCls) => {
      const body = rec({ id: 1, x: 8, y: 0.5, r: 0.2, cellCls, hug: 'N' })
      const index = indexWith(body)
      const out = fresh()
      let x = 6, y = 0.5, firstContactY = null
      for (let i = 0; i < 240; i++) {
        resolveCircle(x, y, x + 0.05, y, index, floor, out)
        if (firstContactY === null && out.pushN > 0) firstContactY = out.y
        x = out.x; y = out.y
        expect(aabbOpen(floor, x, y), `frame ${i}`).toBe(true)
        expect(dist(x, y, body.x, body.y)).toBeGreaterThan(body.r + PLAYER_R - 0.03)
      }
      return { x, y, firstContactY }
    }
    const corridor = run('corridor')
    expect(corridor.firstContactY).toBeGreaterThan(0.5)                 // displaced toward the free side on the frame it met the body
    expect(corridor.x).toBeGreaterThan(8.5)                             // and it got past
    const nook = run('nook')
    expect(nook.x).toBeGreaterThan(8.5)
    const room = run('room')                                            // no bias in a room: a perfectly head-on meeting is a stop
    expect(room.x).toBeLessThan(8 - 0.2 - PLAYER_R + 0.01)
    expect(room.y).toBeCloseTo(0.5, 9)
  })

  it('the bias points away from the hug on every side and only within 20 degrees of the axis', () => {
    const probe = (hug, px, py, nx, ny) => {
      const body = rec({ id: 1, x: 10, y: 10, r: 0.2, cellCls: 'corridor', hug })
      const index = indexWith(body)
      const out = fresh()
      resolveCircle(px, py, nx, ny, index, open, out)
      return out
    }
    // approaching along x: hug N -> pushed +y (south), hug S -> pushed -y
    expect(probe('N', 9.7, 10, 9.68, 10).y).toBeGreaterThan(10)
    expect(probe('S', 9.7, 10, 9.68, 10).y).toBeLessThan(10)
    // approaching along y: hug E -> pushed -x (west), hug W -> pushed +x
    expect(probe('E', 10, 9.7, 10, 9.68).x).toBeLessThan(10)
    expect(probe('W', 10, 9.7, 10, 9.68).x).toBeGreaterThan(10)
    // a push normal 45 degrees off the axis gets no bias: pure push-out along the normal
    const diag = probe('N', 10 - 0.22, 10 - 0.22, 10 - 0.22, 10 - 0.22)
    expect(diag.x).toBeCloseTo(diag.y, 9)
    // no hug: no bias
    const none = probe(null, 9.7, 10, 9.68, 10)
    expect(none.y).toBeCloseTo(10, 12)
  })

  it('never ends inside a wall, even when pushed by a collider flush to a wall (2000 random grids, 0.12 AABB)', () => {
    const rng = mulberry32(0xC011)
    const W = 12
    let pushes = 0
    for (let n = 0; n < 2000; n++) {
      const cells = new Uint8Array(W * W)
      for (let i = 0; i < cells.length; i++) cells[i] = rng() < 0.3 ? 1 : 0
      const floor = (ix, iy) => ix >= 0 && iy >= 0 && ix < W && iy < W && cells[iy * W + ix] === 0
      // the player starts in an open cell with its box open
      let ix, iy, tries = 0
      do { ix = (rng() * W) | 0; iy = (rng() * W) | 0 } while (cells[iy * W + ix] === 1 && ++tries < 500)
      if (cells[iy * W + ix] === 1) continue
      const x = ix + 0.13 + rng() * 0.74, y = iy + 0.13 + rng() * 0.74
      // a collider flush to the nearest wall face of that cell (or just somewhere near when there is none)
      const r = 0.08 + rng() * 0.25
      let bx = x + (rng() - 0.5) * 0.8, by = y + (rng() - 0.5) * 0.8
      const sides = [[1, 0], [-1, 0], [0, 1], [0, -1]].filter(([dx, dy]) => !floor(ix + dx, iy + dy))
      if (sides.length) {
        const [dx, dy] = sides[(rng() * sides.length) | 0]
        if (dx) { bx = ix + (dx > 0 ? 1 - r : r); by = iy + rng() }
        else    { by = iy + (dy > 0 ? 1 - r : r); bx = ix + rng() }
      }
      const index = indexWith(rec({ id: 1, x: bx, y: by, r }))
      const out = fresh()
      const a = (rng() * Math.PI * 2), m = rng() * 0.27
      resolveCircle(x, y, x + Math.cos(a) * m, y + Math.sin(a) * m, index, floor, out)
      if (out.pushN > 0) pushes++
      expect(aabbOpen(floor, out.x, out.y), `grid ${n}`).toBe(true)
      expect(Number.isFinite(out.x) && Number.isFinite(out.y)).toBe(true)
    }
    expect(pushes).toBeGreaterThan(200)       // the property was actually exercised
  })

  it('clutter never pushes: overlapping sets clutterId/clutterType, clutterEntered on the first frame only; a pallet taps once per entry', () => {
    const chair = rec({ id: 7, x: 5, y: 0.5, r: 0.117, cls: 'clutter', type: 'chair' })
    const pallet = rec({ id: 8, x: 9, y: 0.5, r: 0.225, cls: 'none', type: 'pallet' })
    const papers = rec({ id: 9, x: 13, y: 0.5, r: 0.18, cls: 'none', type: 'papers' })
    const index = indexWith(chair, pallet, papers)
    const out = fresh()
    const step = (x, y, nx, ny) => { resolveCircle(x, y, nx, ny, index, open, out); return out }
    // into the chair
    step(4.5, 0.5, 4.8, 0.5)
    expect(out.x).toBeCloseTo(4.8, 12)                  // no push
    expect(out.clutterId).toBe(7); expect(out.clutterType).toBe('chair'); expect(out.clutterEntered).toBe(true)
    step(4.8, 0.5, 4.9, 0.5)
    expect(out.clutterId).toBe(7); expect(out.clutterEntered).toBe(false)
    step(4.9, 0.5, 5.6, 0.5)
    expect(out.clutterId).toBe(0); expect(out.clutterType).toBe(null); expect(out.clutterEntered).toBe(false)
    step(5.6, 0.5, 5.2, 0.5)                             // back in: a new entry
    expect(out.clutterEntered).toBe(true)
    // the pallet
    step(8.5, 0.5, 8.7, 0.5)
    expect(out.x).toBeCloseTo(8.7, 12)
    expect(out.stepType).toBe('pallet')
    step(8.7, 0.5, 8.9, 0.5)
    expect(out.stepType).toBe(null)
    step(8.9, 0.5, 9.6, 0.5)                             // off it
    expect(out.stepType).toBe(null)
    step(9.6, 0.5, 9.2, 0.5)                             // on again
    expect(out.stepType).toBe('pallet')
    // papers are nothing at all
    step(12.5, 0.5, 12.9, 0.5)
    expect(out.x).toBeCloseTo(12.9, 12); expect(out.stepType).toBe(null); expect(out.clutterId).toBe(0); expect(out.pushN).toBe(0)
  })

  it('resolves two overlapping solids in its two iterations and reports both pushes', () => {
    const a = rec({ id: 1, x: 5, y: 0.3, r: 0.2 }), b = rec({ id: 2, x: 5, y: 0.7, r: 0.2 })
    const index = indexWith(a, b)
    const out = fresh()
    resolveCircle(4.4, 0.5, 4.72, 0.5, index, open, out)   // d .344 to both < .36
    expect(out.pushN).toBe(2)
    expect(out.x).toBeLessThan(4.72)
    expect(dist(out.x, out.y, a.x, a.y)).toBeGreaterThan(0.36 - 0.02)
    expect(dist(out.x, out.y, b.x, b.y)).toBeGreaterThan(0.36 - 0.02)
  })
})

describe('creatureBlocks', () => {
  const hound = { x: 5, y: 5, variant: 'hound' }      // r .3225 + .16 = .4825
  const yes = () => true
  it('a move ending 0.3 from a solid creature and closing on it is refused', () => {
    expect(creatureBlocks(4.4, 5, 4.7, 5, [hound], yes)).toBe(hound)
  })
  it('the same end point reached while moving away is allowed', () => {
    expect(creatureBlocks(4.8, 5, 4.7, 5, [hound], yes)).toBe(null)
    expect(creatureBlocks(5, 5, 4.7, 5, [hound], yes)).toBe(null)        // even from dead centre: you can never be pinned inside one
  })
  it('a creature 2 u away is never consulted; solidFn false never refuses; the first blocker wins', () => {
    const far = { x: 7, y: 5, variant: 'crawler' }
    const solidFn = vi.fn(() => true)
    expect(creatureBlocks(4.4, 5, 4.7, 5, [far], solidFn)).toBe(null)
    expect(solidFn).not.toHaveBeenCalled()
    expect(creatureBlocks(4.4, 5, 4.7, 5, [hound], () => false)).toBe(null)
    const other = { x: 4.7, y: 5.2, variant: 'smiler' }
    expect(creatureBlocks(4.4, 5, 4.7, 5, [other, hound], (e) => e === hound)).toBe(hound)
    expect(creatureBlocks(4.4, 5, 4.7, 5, [other, hound], yes)).toBe(other)
  })
  it('a far-enough end point is allowed even while closing', () => {
    expect(creatureBlocks(4.0, 5, 4.4, 5, [hound], yes)).toBe(null)        // d 0.6 > 0.4825
  })
})

describe('createSolidWorld.movePlayer', () => {
  const world = (records = [], floor = open, solid = () => true) => createSolidWorld({ index: indexWith(...records), floorFn: floor, solidCreature: solid })

  it('moves the player and returns the one reused report', () => {
    const w = world()
    const p = { x: 1, y: 1 }
    const r1 = w.movePlayer(p, 1.1, 1.05, 1 / 60, false, [])
    expect(p.x).toBeCloseTo(1.1, 12); expect(p.y).toBeCloseTo(1.05, 12)
    expect(r1.x).toBe(p.x); expect(r1.y).toBe(p.y)
    expect(r1.entered).toBe(null); expect(r1.blockedBy).toBe(null); expect(r1.clutterId).toBe(0); expect(r1.stepType).toBe(null)
    const r2 = w.movePlayer(p, 1.2, 1.1, 1 / 60, false, [])
    expect(r2).toBe(r1)
  })

  it('slides x-only (then y-only) when the full move is refused by a creature; stays when both are', () => {
    const hound = { x: 5, y: 5, variant: 'hound' }
    const w = world()
    // from the south-west, going north-east: the y leg closes, the x leg is the one that opens the distance
    const p = { x: 5.0, y: 4.45 }
    let r = w.movePlayer(p, 5.1, 4.55, 1 / 60, false, [hound])
    expect(r.blockedBy).toBe(hound)
    expect(p.x).toBeCloseTo(5.1, 12); expect(p.y).toBeCloseTo(4.45, 12)
    // mirrored: y-only
    const q = { x: 4.45, y: 5.0 }
    r = w.movePlayer(q, 4.55, 5.1, 1 / 60, false, [hound])
    expect(r.blockedBy).toBe(hound)
    expect(q.x).toBeCloseTo(4.45, 12); expect(q.y).toBeCloseTo(5.1, 12)
    // straight in: both legs close, so the player stays
    const s = { x: 4.45, y: 5.0 }
    r = w.movePlayer(s, 4.55, 5.0, 1 / 60, false, [hound])
    expect(r.blockedBy).toBe(hound)
    expect(s.x).toBe(4.45); expect(s.y).toBe(5.0)
    // and a soft creature never refuses
    const soft = createSolidWorld({ index: createColliderIndex(), floorFn: open, solidCreature: () => false })
    const t = { x: 4.45, y: 5.0 }
    r = soft.movePlayer(t, 4.55, 5.0, 1 / 60, false, [hound])
    expect(r.blockedBy).toBe(null); expect(t.x).toBeCloseTo(4.55, 12)
  })

  it('contact edges: pressing on one solid for 3 s is one ENTER; leaving for 0.5 s and returning is a second', () => {
    const cab = rec({ id: 1, x: 5, y: 0.5, r: footprintRadius('prop', 'cabinet'), type: 'cabinet' })
    const w = world([cab])
    const p = { x: 4.6, y: 0.5 }
    const dt = 1 / 60
    let enters = 0, firstDot = null, firstSpeed = null
    for (let i = 0; i < 180; i++) {
      const r = w.movePlayer(p, p.x + 3.0 * dt, p.y, dt, false, [])
      if (r.entered) { enters++; expect(r.entered).toBe(cab); if (firstDot === null) { firstDot = r.enterNormalDot; firstSpeed = r.enterSpeed } }
    }
    expect(enters).toBe(1)
    expect(firstDot).toBeCloseTo(1, 6)
    expect(firstSpeed).toBeCloseTo(3.0, 6)
    // still touching after a short pause (0.3 s < 0.4 s): no new edge
    for (let i = 0; i < 18; i++) w.movePlayer(p, p.x - 0.1 * dt, p.y, dt, false, [])
    for (let i = 0; i < 10; i++) if (w.movePlayer(p, p.x + 3.0 * dt, p.y, dt, false, []).entered) enters++
    expect(enters).toBe(1)
    // away for 0.5 s, then back: a second ENTER
    for (let i = 0; i < 30; i++) expect(w.movePlayer(p, p.x - 0.05, p.y, dt, false, []).entered).toBe(null)
    for (let i = 0; i < 60; i++) if (w.movePlayer(p, p.x + 3.0 * dt, p.y, dt, false, []).entered) enters++
    expect(enters).toBe(2)
  })

  it('enterNormalDot is below 0.5 at a 60-degree glance', () => {
    const cab = rec({ id: 1, x: 5, y: 0.5, r: footprintRadius('prop', 'cabinet'), type: 'cabinet' })
    const R = cab.r + PLAYER_R
    const w = world([cab])
    const p = { x: 4.0, y: 0.5 + R * Math.sin(Math.PI / 3) }
    let dot = null
    for (let i = 0; i < 40 && dot === null; i++) { const r = w.movePlayer(p, p.x + 0.05, p.y, 1 / 60, false, []); if (r.entered) dot = r.enterNormalDot }
    expect(dot).not.toBe(null)
    expect(dot).toBeLessThan(0.5)
    expect(dot).toBeGreaterThan(0)
  })

  it('a hard sprint into a cabinet reports the intended speed, not the resolved one', () => {
    const cab = rec({ id: 1, x: 5, y: 0.5, r: footprintRadius('prop', 'cabinet'), type: 'cabinet' })
    const w = world([cab])
    const p = { x: 5 - cab.r - PLAYER_R - 0.05, y: 0.5 }
    const r = w.movePlayer(p, p.x + 5.4 / 60, p.y, 1 / 60, true, [])
    expect(r.entered).toBe(cab)
    expect(r.enterSpeed).toBeCloseTo(5.4, 6)
    expect(r.enterNormalDot).toBeCloseTo(1, 6)
    expect(dist(p.x, p.y, cab.x, cab.y)).toBeGreaterThanOrEqual(cab.r + PLAYER_R)
  })

  it('reports clutter and the pallet step through the same report', () => {
    const chair = rec({ id: 7, x: 5, y: 0.5, r: 0.117, cls: 'clutter', type: 'chair' })
    const pallet = rec({ id: 8, x: 9, y: 0.5, r: 0.225, cls: 'none', type: 'pallet' })
    const w = world([chair, pallet])
    const p = { x: 4.6, y: 0.5 }
    let r = w.movePlayer(p, 4.8, 0.5, 1 / 60, false, [])
    expect(r.clutterId).toBe(7); expect(r.clutterType).toBe('chair'); expect(r.clutterEntered).toBe(true); expect(r.entered).toBe(null)
    r = w.movePlayer(p, 4.9, 0.5, 1 / 60, false, [])
    expect(r.clutterEntered).toBe(false)
    expect(w.clutterAt(4.9, 0.5)).toBe(0.55)
    expect(w.clutterAt(7, 0.5)).toBe(1)
    expect(w.clutterAt(9, 0.5)).toBe(1)                    // a pallet is not clutter
    p.x = 8.6
    r = w.movePlayer(p, 8.8, 0.5, 1 / 60, false, [])
    expect(r.stepType).toBe('pallet'); expect(r.clutterId).toBe(0)
    r = w.movePlayer(p, 8.9, 0.5, 1 / 60, false, [])
    expect(r.stepType).toBe(null)
  })
})

describe('createSolidWorld.settlePlayer / forEntities', () => {
  const world = (records = [], floor = open) => createSolidWorld({ index: indexWith(...records), floorFn: floor, solidCreature: () => true })

  it('settlePlayer moves a player placed inside a cabinet to >= r + PLAYER_R and returns the distance', () => {
    const cab = rec({ id: 1, x: 5, y: 0.5, r: footprintRadius('prop', 'cabinet'), type: 'cabinet' })
    const w = world([cab])
    const p = { x: 5.02, y: 0.51 }
    const moved = w.settlePlayer(p)
    expect(dist(p.x, p.y, cab.x, cab.y)).toBeGreaterThanOrEqual(cab.r + PLAYER_R)
    expect(moved).toBeCloseTo(dist(p.x, p.y, 5.02, 0.51), 9)
    expect(moved).toBeGreaterThan(0.2)
    expect(w.settlePlayer(p)).toBe(0)                      // nothing left to do
    const q = { x: 5, y: 0.5 }                             // dead centre still resolves
    expect(w.settlePlayer(q)).toBeGreaterThan(0.25)
    expect(dist(q.x, q.y, cab.x, cab.y)).toBeGreaterThanOrEqual(cab.r + PLAYER_R)
  })

  it('settlePlayer keeps the player out of walls and leaves clutter alone', () => {
    const floor = (ix, iy) => iy === 0 && ix >= 0 && ix < 20
    const cab = rec({ id: 1, x: 5, y: 0.5, r: 0.2 })
    const w = world([cab], floor)
    const p = { x: 4.9, y: 0.5 }
    w.settlePlayer(p)
    expect(aabbOpen(floor, p.x, p.y)).toBe(true)
    const chair = rec({ id: 2, x: 9, y: 0.5, r: 0.117, cls: 'clutter', type: 'chair' })
    const w2 = world([chair], floor)
    const q = { x: 9.02, y: 0.5 }
    expect(w2.settlePlayer(q)).toBe(0)
  })

  it('forEntities.blocked: a wall cell or a solid record within r + c.r; never clutter, none or a lost soul', () => {
    const floor = (ix, iy) => !(ix === 3 && iy === 3)
    const cab = rec({ id: 1, x: 10, y: 10, r: 0.2 })
    const chair = rec({ id: 2, x: 14, y: 10, r: 0.117, cls: 'clutter', type: 'chair' })
    const pallet = rec({ id: 3, x: 16, y: 10, r: 0.225, cls: 'none', type: 'pallet' })
    const soul = rec({ id: 4, x: 18, y: 10, r: 0.117, cls: 'solid', kind: 'npc', type: 'npc' })
    const w = world([cab, chair, pallet, soul], floor)
    const fe = w.forEntities
    expect(fe.blocked(3.5, 3.5, 0.1)).toBe(true)
    expect(fe.blocked(2.5, 3.5, 0.1)).toBe(false)
    expect(fe.blocked(10.3, 10, 0.12)).toBe(true)           // d .3 < .32
    expect(fe.blocked(10.35, 10, 0.12)).toBe(false)         // d .35 > .32
    expect(fe.blocked(14.05, 10, 0.3)).toBe(false)
    expect(fe.blocked(16.05, 10, 0.3)).toBe(false)
    expect(fe.blocked(18.05, 10, 0.3)).toBe(false)
    expect(fe.radiusFor('hound')).toBeCloseTo(creatureRadius('hound'), 12)
    expect(fe.radiusFor('nothing')).toBeCloseTo(creatureRadius('shade'), 12)
  })
})

describe('movePoint (the legacy tryMove)', () => {
  it('reproduces the old tryMove over 1000 random moves on a random wall grid', () => {
    const rng = mulberry32(0x7E57)
    const W = 16
    const cells = new Uint8Array(W * W)
    for (let i = 0; i < cells.length; i++) cells[i] = rng() < 0.3 ? 1 : 0
    const seen = []
    const isWall = (wx, wy, pcx, pcy) => {
      seen.push(pcx, pcy)
      const ix = Math.floor(wx), iy = Math.floor(wy)
      return !(ix >= 0 && iy >= 0 && ix < W && iy < W) || cells[iy * W + ix] === 1
    }
    // game.js:463-468 as it was
    function oldTryMove(player, nx, ny) {
      const pcx = Math.floor(player.x / CHUNK_SIZE)
      const pcy = Math.floor(player.y / CHUNK_SIZE)
      if (!isWall(nx, player.y, pcx, pcy)) player.x = nx
      if (!isWall(player.x, ny, pcx, pcy)) player.y = ny
    }
    for (let n = 0; n < 1000; n++) {
      const x = rng() * W, y = rng() * W
      const nx = x + (rng() - 0.5) * 0.6, ny = y + (rng() - 0.5) * 0.6
      const old = { x, y }
      oldTryMove(old, nx, ny)
      const pcx = Math.floor(x / CHUNK_SIZE), pcy = Math.floor(y / CHUNK_SIZE)
      const r = movePoint(x, y, nx, ny, isWall, pcx, pcy)
      expect(r.x).toBe(old.x)
      expect(r.y).toBe(old.y)
    }
    // the chunk hint is passed straight through
    expect(seen.every((v) => v === 0)).toBe(true)
  })

  it('is passive when the player stands still', () => {
    const r = movePoint(3.5, 3.5, 3.5, 3.5, () => false, 0, 0)
    expect(r.x).toBe(3.5); expect(r.y).toBe(3.5)
  })
})
