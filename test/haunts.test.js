// haunts.js — the placed hauntings: the table, the pure pick, the appended decor pass on the channels.js haunts constants, the
// cooldown tracker, and the effects each id resolves to (a still figure where you were, chairs turned, water, a knock, your light).
// The decor golden guard (pass on vs off leaves every older placement byte-identical; haunts never in walls) lives here too.
import { describe, it, expect } from 'vitest'
import { HAUNTS, hauntsPass, chooseHaunt, createHauntTracker, hauntEffects } from '../src/renderer/haunts.js'
import { CHANNELS } from '../src/renderer/channels.js'
import { createDecorSystem } from '../src/renderer/decor.js'
import { levelConfig } from '../src/renderer/levels.js'
import { createChunkCache, createGridReader, CHUNK_SIZE, DEFAULT_CONFIG } from '../src/renderer/world.js'

const CS = CHUNK_SIZE
// decor.js's hash and rng, copied so the pass can be driven from a fake ctx
function hash(a, b, c = 0) {
  let h = (a * 2654435761 ^ b * 2246822519 ^ Math.imul(c, 3266489917)) >>> 0
  h ^= h >>> 16; h = Math.imul(h, 0x45d9f3b) >>> 0
  h ^= h >>> 16
  return h >>> 0
}
function rngFrom(a, b, seed = 0) {
  let s = hash(a, b, seed) | 1
  return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 0xffffffff }
}
const ID = (h) => h.id
const byId = (id) => HAUNTS.find((h) => h.id === id)
const fakeCtx = (cx, cy, { salt = 0, seed = 0, props, open = true, cfg = {} } = {}) => {
  const calls = { hash: [], rng: [], added: [] }
  const ctx = {
    cx, cy, key: `${cx},${cy}`, pcx: 0, pcy: 0, salt, seed, cfg,
    isWall: () => !open,
    hash: (a, b, c) => { calls.hash.push([a, b, c]); return hash(a, b, c) },
    rngFrom: (a, b, c) => { calls.rng.push([a, b, c]); return rngFrom(a, b, c) },
    openCell: (rng) => open ? { wx: cx * CS + 1 + Math.floor(rng() * (CS - 2)) + 0.5, wy: cy * CS + 1 + Math.floor(rng() * (CS - 2)) + 0.5 } : null,
    add: (kind, rec) => calls.added.push([kind, rec]),
  }
  if (props) ctx.props = props
  return { ctx, calls }
}
const chair = (x, y, rot = 0.3) => ({ key: `c${x},${y}`, x, y, type: 'chair', rot })
const prop = (type, x, y) => ({ key: `${type}${x},${y}`, x, y, type, rot: 0.1 })
const player = (x, y, angle) => ({ x, y, angle })
const open = () => true
const L = (i, denom) => { const c = levelConfig(DEFAULT_CONFIG, i); return denom === undefined ? c : { ...c, haunts: { denom } } }

describe('HAUNTS', () => {
  it('is the five-row table, frozen', () => {
    expect(HAUNTS).toEqual([
      { id: 'standing-figure', minLevel: 1, radius: 6, cooldownS: 240, sanity: -5 },
      { id: 'chairs-moved', minLevel: 0, radius: 4, cooldownS: 300, sanity: -2, needsProps: 'chair' },
      { id: 'running-water', minLevel: 2, radius: 7, cooldownS: 200, sanity: -3 },
      { id: 'knock-inside', minLevel: 3, radius: 3, cooldownS: 180, sanity: -4, needsProps: 'cabinet-e' },
      { id: 'your-own-light', minLevel: 1, radius: 5, cooldownS: 260, sanity: -3 },
    ])
    expect(Object.isFrozen(HAUNTS)).toBe(true)
    for (const h of HAUNTS) expect(Object.isFrozen(h)).toBe(true)
  })
})

describe('chooseHaunt', () => {
  it('is deterministic in (cx, cy, seed, salt, level, props) and moves with the chunk, the seed and the salt', () => {
    const a = chooseHaunt(3, -2, 0, 0x1111, 3, [])
    expect(chooseHaunt(3, -2, 0, 0x1111, 3, [])).toBe(a)
    expect(typeof a).toBe('string')
    const ids = (f) => new Set([...Array(60)].map((_, i) => f(i)))
    expect(ids((i) => chooseHaunt(i, -2, 0, 0x1111, 3, [])).size).toBeGreaterThan(1)
    expect(ids((i) => chooseHaunt(3, -2, i, 0x1111, 3, [])).size).toBeGreaterThan(1)
    expect(ids((i) => chooseHaunt(3, -2, 0, 0x1111 + i, 3, [])).size).toBeGreaterThan(1)
  })

  it('respects minLevel: never an id from a deeper floor; level 0 without a chair has nothing', () => {
    for (let level = 0; level <= 3; level++) {
      for (let cx = -10; cx < 10; cx++) for (let cy = -10; cy < 10; cy++) {
        const id = chooseHaunt(cx, cy, 0, 0x2222, level, [])
        if (id === null) { expect(HAUNTS.filter((h) => h.minLevel <= level && !h.needsProps)).toHaveLength(0); continue }
        expect(byId(id).minLevel).toBeLessThanOrEqual(level)
        expect(byId(id).needsProps).toBeUndefined()                       // no props given: needsProps ids are out
      }
    }
    expect(chooseHaunt(0, 0, 0, 0, 0, [])).toBeNull()
    expect(chooseHaunt(0, 0, 0, 0, '∅', [chair(5.5, 5.5)])).toBeNull()
    expect(chooseHaunt(0, 0, 0, 0, 4, [chair(5.5, 5.5)])).toBeNull()      // ∅ is index 4: nothing haunts the block
  })

  it('a needsProps id is chosen only when a matching prop is within its radius of the spot in the given list', () => {
    const at = { x: 10.5, y: 10.5 }
    // level 0: chairs-moved is the only eligible id, so a chair in range decides it
    expect(chooseHaunt(0, 0, 0, 0, 0, [chair(12.5, 10.5)], at)).toBe('chairs-moved')
    expect(chooseHaunt(0, 0, 0, 0, 0, [chair(16.5, 10.5)], at)).toBeNull()         // 6 away > radius 4
    expect(chooseHaunt(0, 0, 0, 0, 0, [prop('box', 11.5, 10.5)], at)).toBeNull()   // wrong type
    expect(chooseHaunt(0, 0, 0, 0, 0, [chair(12.5, 10.5)])).toBe('chairs-moved')   // no spot: anywhere in the chunk's list counts
    // level 3: knock-inside needs a panel cabinet within 3
    const seen = (props, spot) => new Set([...Array(200)].map((_, i) => chooseHaunt(i, 7, 0, 0x3333, 3, props, spot)))
    expect(seen([], at).has('knock-inside')).toBe(false)
    expect(seen([prop('cabinet-e', 14.5, 10.5)], at).has('knock-inside')).toBe(false)   // 4 away
    expect(seen([prop('cabinet-e', 12.5, 10.5)], at).has('knock-inside')).toBe(true)
    expect(seen([prop('cabinet-e', 12.5, 10.5)], at).has('chairs-moved')).toBe(false)   // no chair
    expect(seen([prop('cabinet-e', 12.5, 10.5), chair(9.5, 10.5)], at).has('chairs-moved')).toBe(true)
    for (const id of seen([prop('cabinet-e', 12.5, 10.5), chair(9.5, 10.5)], at)) expect(HAUNTS.map(ID)).toContain(id)
  })

  it('every eligible id turns up somewhere on level 3 with the props to hand', () => {
    const got = new Set()
    for (let cx = 0; cx < 30; cx++) for (let cy = 0; cy < 30; cy++) got.add(chooseHaunt(cx, cy, 0, 0x3333, 3, [chair(1, 1), prop('cabinet-e', 1, 1)]))
    expect([...got].sort()).toEqual(HAUNTS.map(ID).sort())
  })
})

describe('hauntsPass', () => {
  it('is null for denom 0, a missing haunts block, or no cfg', () => {
    expect(hauntsPass(L(0, 0))).toBeNull()
    expect(hauntsPass(L(4))).toBeNull()
    expect(hauntsPass({ ...L(1), haunts: {} })).toBeNull()
    expect(hauntsPass({ ...L(1), haunts: undefined })).toBeNull()
    expect(hauntsPass(null)).toBeNull(); expect(hauntsPass(undefined)).toBeNull()
    expect(typeof hauntsPass(L(1))).toBe('function')
  })

  it('draws its gate, rng and pick constants from channels.js haunts, exactly', () => {
    const pass = hauntsPass(L(3, 1))
    const salt = L(3).maze.salt | 0, seed = 5
    const { ctx, calls } = fakeCtx(4, -6, { salt, seed, props: [] })
    pass(ctx)
    const [GA, GB] = CHANNELS.haunts.gate, [MX, AX, MY, AY] = CHANNELS.haunts.rng, [PA, PB] = CHANNELS.haunts.pick
    expect([GA, GB]).toEqual([9203, 1531]); expect([MX, AX, MY, AY]).toEqual([227, 43, 593, 89]); expect([PA, PB]).toEqual([467, 941])
    expect(calls.hash[0]).toEqual([4 + GA + salt, -6 + GB + salt, seed])
    expect(calls.rng).toEqual([[4 * MX + salt + AX, -6 * MY + salt + AY, seed]])
    expect(calls.hash[1]).toEqual([4 + PA + salt, -6 + PB + salt, seed])
    expect(calls.hash).toHaveLength(2)
    expect(calls.added).toHaveLength(1)
  })

  it("gates about one chunk in denom and adds { key: `${key}:h`, x, y, id } through ctx.add('haunt')", () => {
    const denom = 8, cfg = L(2, denom), salt = cfg.maze.salt | 0
    const pass = hauntsPass(cfg)
    let gated = 0, total = 0
    for (let cx = -20; cx < 20; cx++) for (let cy = -20; cy < 20; cy++) {
      total++
      const { ctx, calls } = fakeCtx(cx, cy, { salt, seed: 0, props: [], cfg })
      pass(ctx)
      const want = hash(cx + 9203 + salt, cy + 1531 + salt, 0) % denom === 0
      expect(calls.added.length).toBe(want ? 1 : 0)
      if (!want) { expect(calls.rng).toEqual([]); continue }
      gated++
      const [kind, rec] = calls.added[0]
      expect(kind).toBe('haunt')
      expect(Object.keys(rec).sort()).toEqual(['id', 'key', 'x', 'y'])
      expect(rec.key).toBe(`${cx},${cy}:h`)
      expect(Math.floor(rec.x / CS)).toBe(cx); expect(Math.floor(rec.y / CS)).toBe(cy)
      expect(rec.x - Math.floor(rec.x)).toBeCloseTo(0.5, 12); expect(rec.y - Math.floor(rec.y)).toBeCloseTo(0.5, 12)
      expect(HAUNTS.map(ID)).toContain(rec.id)
      expect(byId(rec.id).minLevel).toBeLessThanOrEqual(2)
      expect(rec.id).toBe(chooseHaunt(cx, cy, 0, salt, 2, [], { x: rec.x, y: rec.y }))
    }
    expect(gated / total).toBeGreaterThan(1 / denom - 0.04); expect(gated / total).toBeLessThan(1 / denom + 0.04)
  })

  it('adds nothing on a solid chunk (no open cell), nothing when no id is eligible, and reads ctx.props for needsProps', () => {
    const pass0 = hauntsPass(L(0, 1))
    const salt0 = L(0).maze.salt | 0
    const { ctx: solidCtx, calls: solidCalls } = fakeCtx(1, 1, { salt: salt0, open: false, props: [chair(30.5, 30.5)] })
    pass0(solidCtx)
    expect(solidCalls.added).toEqual([])
    // level 0 has only chairs-moved: with no chair in the chunk the gated chunk stays unhaunted, with one within 4 it is haunted
    let withChair = 0, without = 0
    for (let cx = 0; cx < 12; cx++) for (let cy = 0; cy < 12; cy++) {
      const a = fakeCtx(cx, cy, { salt: salt0, props: [] }); pass0(a.ctx); without += a.calls.added.length
      const b = fakeCtx(cx, cy, { salt: salt0 }); pass0(b.ctx); without += b.calls.added.length      // no ctx.props at all
      const spot = fakeCtx(cx, cy, { salt: salt0, props: [] }).ctx.openCell(rngFrom(cx * 227 + salt0 + 43, cy * 593 + salt0 + 89, 0))
      const c = fakeCtx(cx, cy, { salt: salt0, props: [chair(spot.wx + 1, spot.wy)] }); pass0(c.ctx); withChair += c.calls.added.length
      if (c.calls.added.length) expect(c.calls.added[0][1].id).toBe('chairs-moved')
    }
    expect(without).toBe(0)
    expect(withChair).toBe(144)
  })
})

describe('createHauntTracker', () => {
  const H = (id, x, y) => ({ key: `${Math.floor(x / CS)},${Math.floor(y / CS)}:h`, x, y, id })
  const mk = () => { const s = { t: 0 }; return { s, tr: createHauntTracker({ now: () => s.t }) } }

  it('check returns the haunt in radius, none outside, and null when calm is false', () => {
    const { tr } = mk()
    const fig = H('standing-figure', 10.5, 10.5)          // radius 6
    expect(tr.check(10.5, 15.5, [fig], { calm: true })).toBe(fig)
    expect(tr.check(10.5, 16.5, [fig], { calm: true })).toBe(fig)   // exactly 6: inside
    expect(tr.check(10.5, 16.6, [fig], { calm: true })).toBeNull()
    expect(tr.check(10.5, 10.5, [fig], { calm: false })).toBeNull()
    expect(tr.check(10.5, 10.5, [fig], {})).toBeNull()
    expect(tr.check(10.5, 10.5, [], { calm: true })).toBeNull()
    const knock = H('knock-inside', 40.5, 10.5)           // radius 3
    expect(tr.check(43.5, 10.5, [knock], { calm: true })).toBe(knock)
    expect(tr.check(44.5, 10.5, [knock], { calm: true })).toBeNull()
    expect(tr.check(40.5, 10.5, [{ key: 'x', x: 40.5, y: 10.5, id: 'not-a-haunt' }], { calm: true })).toBeNull()
  })

  it('after fire(key) the key is ignored until its cooldownS has elapsed, by the tracker clock', () => {
    const { s, tr } = mk()
    const fig = H('standing-figure', 10.5, 10.5)           // cooldownS 240
    s.t = 100
    tr.fire(fig.key)
    expect(tr.check(10.5, 10.5, [fig], { calm: true })).toBeNull()
    s.t = 339.9
    expect(tr.check(10.5, 10.5, [fig], { calm: true })).toBeNull()
    s.t = 340
    expect(tr.check(10.5, 10.5, [fig], { calm: true })).toBe(fig)
    tr.fire(fig.key)
    s.t = 400
    expect(tr.check(10.5, 10.5, [fig], { calm: true })).toBeNull()
    const water = H('running-water', 10.5, 12.5)           // cooldownS 200, a different key still fires
    water.key = 'other:h'
    expect(tr.check(10.5, 10.5, [fig, water], { calm: true })).toBe(water)
  })

  it('two in range -> the nearer', () => {
    const { tr } = mk()
    const a = H('standing-figure', 10.5, 10.5), b = { ...H('your-own-light', 14.5, 10.5), key: 'b:h' }
    expect(tr.check(13.5, 10.5, [a, b], { calm: true })).toBe(b)
    expect(tr.check(11.5, 10.5, [a, b], { calm: true })).toBe(a)
    expect(tr.check(11.5, 10.5, [b, a], { calm: true })).toBe(a)      // order does not matter
    expect(tr.check(13.5, 10.5, [a, b], true)).toBe(b)                 // a bare boolean works too
  })
})

describe('hauntEffects', () => {
  const trailBack = (px, py, n, dx = -1, dy = 0) => [...Array(n)].map((_, i) => ({ x: px + dx * i, y: py + dy * i }))   // newest first
  const ctxFor = (over = {}) => ({ player: player(10.5, 10.5, 0), props: [], isOpen: open, trail: trailBack(10.5, 10.5, 6), ...over })

  it('every id returns a lowercase, unexclaimed message with its table sanity; unknown ids are null', () => {
    const fx = {
      'standing-figure': hauntEffects('standing-figure', ctxFor()),
      'chairs-moved': hauntEffects('chairs-moved', ctxFor({ props: [chair(8.5, 10.5)] })),
      'running-water': hauntEffects('running-water', ctxFor()),
      'knock-inside': hauntEffects('knock-inside', ctxFor()),
      'your-own-light': hauntEffects('your-own-light', ctxFor()),
    }
    for (const h of HAUNTS) {
      const f = fx[h.id]
      expect(f, h.id).toBeTruthy()
      expect(typeof f.message).toBe('string')
      expect(f.message).toBe(f.message.toLowerCase()); expect(f.message).not.toContain('!'); expect(f.message.at(-1)).toBe('.')
      expect(f.sanity).toBe(h.sanity)
    }
    expect(fx['standing-figure'].message).toBe('someone is standing where you were. they do not move.')
    expect(fx['chairs-moved'].message).toBe('the chairs have been moved. nobody moved them.')
    expect(fx['running-water'].message).toBe('running water. do not follow it.')
    expect(fx['knock-inside'].message).toBe('something knocks, once, from inside the cabinet.')
    expect(fx['your-own-light'].message).toBe('your light goes out. it was not the battery.')
    expect(hauntEffects('nothing', ctxFor())).toBeNull()
    expect(hauntEffects(undefined, ctxFor())).toBeNull()
  })

  it("standing-figure: an ephemera with variant 'shade', vx = vy = 0, vanishAt 3, on an open trail cell behind the player, whisper", () => {
    const ctx = ctxFor()                                                // facing +x, the trail runs back along -x
    const fx = hauntEffects('standing-figure', ctx)
    expect(fx.audio).toBe('whisper')
    const e = fx.ephemera
    expect(e).toMatchObject({ variant: 'shade', vx: 0, vy: 0, vanishAt: 3 })
    expect(e.ttl).toBeGreaterThan(3)
    expect(ctx.trail.some((t) => t.x === e.x && t.y === e.y)).toBe(true)
    const dx = e.x - ctx.player.x, dy = e.y - ctx.player.y
    expect(Math.cos(ctx.player.angle) * dx + Math.sin(ctx.player.angle) * dy).toBeLessThan(0)
    const d = Math.hypot(dx, dy)
    expect(d).toBeGreaterThan(3); expect(d).toBeLessThanOrEqual(6)       // the far end of the trail: five or six paces back
    expect(e).toEqual({ x: 5.5, y: 10.5, vx: 0, vy: 0, ttl: e.ttl, variant: 'shade', vanishAt: 3 })
    expect(fx.moveProps).toBeUndefined(); expect(fx.flashlightOff).toBeUndefined()
  })

  it('standing-figure: null when no open trail cell is behind (facing the trail, a wall over it, or too short a trail)', () => {
    const ctx = ctxFor()
    expect(hauntEffects('standing-figure', { ...ctx, player: player(10.5, 10.5, Math.PI) })).toBeNull()        // looking back down it
    expect(hauntEffects('standing-figure', { ...ctx, isOpen: (x) => x > 9 })).toBeNull()                        // the far cells are wall
    expect(hauntEffects('standing-figure', { ...ctx, isOpen: (x) => x <= 6.5 })).not.toBeNull()                 // only the far one is open
    expect(hauntEffects('standing-figure', { ...ctx, trail: trailBack(10.5, 10.5, 2) })).toBeNull()             // one pace back: too close
    expect(hauntEffects('standing-figure', { ...ctx, trail: [] })).toBeNull()
    expect(hauntEffects('standing-figure', { ...ctx, trail: undefined })).toBeNull()
    // a far cell that is beside you rather than behind does not count
    const side = trailBack(10.5, 10.5, 6, 0, 1)                                                                  // the trail runs along +y
    expect(hauntEffects('standing-figure', { ...ctx, trail: side })).toBeNull()
    expect(hauntEffects('standing-figure', { ...ctx, trail: side, player: player(10.5, 10.5, -Math.PI / 2) })).not.toBeNull()
  })

  it("chairs-moved: adds 1.0 to rot of every 'chair' within 4 behind the player, only those, never restores; null when none", () => {
    const behindNear = chair(8.5, 10.5, 0.3), behindFar = chair(5.5, 10.5, 0.3), ahead = chair(12.5, 10.5, 0.3)
    const box = prop('box', 8.5, 10.5), behindDiag = chair(8.5, 12.5, 1.0)
    const props = [behindNear, behindFar, ahead, box, behindDiag]
    const fx = hauntEffects('chairs-moved', ctxFor({ props }))
    expect(fx.moveProps).toEqual([behindNear, behindDiag])
    expect(behindNear.rot).toBeCloseTo(1.3, 12); expect(behindDiag.rot).toBeCloseTo(2.0, 12)
    expect(behindFar.rot).toBe(0.3); expect(ahead.rot).toBe(0.3); expect(box.rot).toBe(0.1)
    expect(fx.sanity).toBe(-2); expect(fx.ephemera).toBeUndefined(); expect(fx.audio).toBeUndefined()
    // again: moved again, never back
    hauntEffects('chairs-moved', ctxFor({ props }))
    expect(behindNear.rot).toBeCloseTo(2.3, 12)
    expect(hauntEffects('chairs-moved', ctxFor({ props: [ahead, box, behindFar] }))).toBeNull()
    expect(ahead.rot).toBe(0.3); expect(behindFar.rot).toBe(0.3)
    expect(hauntEffects('chairs-moved', ctxFor({ props: [] }))).toBeNull()
    expect(hauntEffects('chairs-moved', ctxFor({ props: undefined }))).toBeNull()
  })

  it('running-water: footfall:8 through a 12 s timer; knock-inside: doorSlam and shake 0.2; your-own-light: flashlightOff 1.4', () => {
    const w = hauntEffects('running-water', ctxFor())
    expect(w).toEqual({ audio: 'footfall:8', timerS: 12, message: 'running water. do not follow it.', sanity: -3 })
    const k = hauntEffects('knock-inside', ctxFor())
    expect(k).toEqual({ audio: 'doorSlam', shake: 0.2, message: 'something knocks, once, from inside the cabinet.', sanity: -4 })
    const l = hauntEffects('your-own-light', ctxFor())
    expect(l).toEqual({ flashlightOff: 1.4, message: 'your light goes out. it was not the battery.', sanity: -3 })
    // these three need nothing from the ctx
    expect(hauntEffects('your-own-light')).toEqual(l)
    expect(hauntEffects('knock-inside', {})).toEqual(k)
  })
})

describe('decor golden guard', () => {
  const walled = (cfg, seed = 0) => {
    const cache = createChunkCache(cfg, seed)
    const isWall = (wx, wy, pcx, pcy) => cache.isWall(wx, wy, pcx, pcy)
    return { cache, isWall, grid: createGridReader(cache, isWall) }
  }

  it('haunts pass on vs off leaves props / exits / npcs / scraps / machines / sights identical, with real walls, every level', () => {
    for (let i = 0; i <= 3; i++) {
      const cfg = L(i, 1)                                            // every chunk gated in
      const { isWall } = walled(cfg)
      const off = createDecorSystem(cfg, isWall, 0, null); off.update(0, 0)
      const on = createDecorSystem(cfg, isWall, 0, { passes: [hauntsPass(cfg)] }); on.update(0, 0)
      expect(on.getProps()).toEqual(off.getProps())
      expect(on.getExits()).toEqual(off.getExits())
      expect(on.getNpcs()).toEqual(off.getNpcs())
      expect(on.getScraps()).toEqual(off.getScraps())
      expect(on.getMachines()).toEqual(off.getMachines())
      expect(on.getSights()).toEqual(off.getSights())
      expect(on.getStairs()).toEqual(off.getStairs())
    }
  })

  it('haunts are never in walls and every gated chunk with an eligible id has exactly one, keyed by its chunk', () => {
    const cfg = L(1, 1)
    const { isWall, grid } = walled(cfg)
    grid.setPlayerChunk(0, 0)
    const pass = hauntsPass(cfg)
    const got = new Map()
    // props are what decor built for the chunk: the pass sees the chunk's own list through ctx.props (the integrator exposes it)
    const bundles = new Map()
    const probe = createDecorSystem(cfg, isWall, 0, { onChunk: (k, b) => bundles.set(k, b) }); probe.update(0, 0)
    const wrap = (ctx) => pass({ ...ctx, props: bundles.get(ctx.key).props, add: (kind, rec) => { if (kind === 'haunt') got.set(ctx.key, rec); else ctx.add(kind, rec) } })
    const sys = createDecorSystem(cfg, isWall, 0, { passes: [wrap] }); sys.update(0, 0)
    expect(got.size).toBeGreaterThan(30)
    for (const [k, rec] of got) {
      expect(rec.key).toBe(`${k}:h`)
      expect(grid.floor(Math.floor(rec.x), Math.floor(rec.y)), rec.key).toBe(true)
      expect(isWall(rec.x, rec.y, 0, 0)).toBe(false)
      expect(HAUNTS.map(ID)).toContain(rec.id)
      expect(byId(rec.id).minLevel).toBeLessThanOrEqual(1)
      if (byId(rec.id).needsProps) {
        const r = byId(rec.id).radius
        expect(bundles.get(k).props.some((p) => p.type === byId(rec.id).needsProps && (p.x - rec.x) ** 2 + (p.y - rec.y) ** 2 <= r * r)).toBe(true)
      }
    }
  })
})
