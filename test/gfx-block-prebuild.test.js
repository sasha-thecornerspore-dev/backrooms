// gfx-block-prebuild.test.js — Level ∅'s TexSet built ahead of time, a few ms at a time while the title is up (gfx-textures.js
// prebuildTextures / prebuildLevelTextures; gfx-block-facade.js §3b: the recipes and the bay compositor as stepped jobs).
//   * the same bytes: the job paused at EVERY pause point gives the TexSet buildTextures gives (every tile, its storey band tiles, and which
//     slots share a tile), and a recipe stepped that way the raster it paints in one go
//   * the handover: buildTexturesMemo takes a job part-way and finishes it, the TexSet it returns is the same, and the job is gone
//   * nothing runs without the look (or on levels 0-3): no job, no idle callback; a cancelled job is dropped and the memo builds afresh
//   * the idle slices: one slice per idle callback, never past the deadline, until done or cancelled
//   (the title's wiring: block-prebuild-wiring.test.js)
import { describe, it, expect, vi } from 'vitest'
import { createHash } from 'node:crypto'
import * as BF from '../src/renderer/gfx-block-facade.js'
import { buildTextures, buildTexturesMemo, clearTexturesMemo, prebuildTextures, prebuildLevelTextures, cancelPrebuilds, prebuildsPending,
  PREBUILD_SLICE_MS } from '../src/renderer/gfx-textures.js'
import { levelConfig } from '../src/renderer/levels.js'
import { BLOCK, LOBBY } from '../src/renderer/topology.js'
import { DEFAULT_CONFIG } from '../src/renderer/world.js'
import { levelKey } from '../src/renderer/gfx-util.js'

vi.setConfig({ testTimeout: 60000 })

const CFG = levelConfig(DEFAULT_CONFIG, BLOCK), KEY = levelKey(CFG)
const args = (cfg = CFG) => [cfg.palette, cfg.materials, cfg.look, levelKey(cfg)]
// every tile of a TexSet and of its wallBands, by path, plus the order in which distinct tiles fill the slots (shared tiles stay shared)
function digest(tex) {
  const parts = [], ids = new Map(), order = []
  const walk = (v, path) => {
    if (v == null) { parts.push(path + '=null'); return }
    if (ArrayBuffer.isView(v)) {
      parts.push(path + '=' + createHash('sha256').update(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)).digest('hex'))
      if (!ids.has(v)) ids.set(v, ids.size)
      order.push(ids.get(v))
      return
    }
    if (Array.isArray(v)) { v.forEach((x, i) => walk(x, path + '[' + i + ']')); return }
    if (typeof v === 'object') { for (const k of Object.keys(v).sort()) walk(v[k], path + '.' + k); return }
    parts.push(path + '=' + String(v))
  }
  walk(tex, 'tex')
  walk(tex.wallBands, 'bands')
  return { tiles: parts, identity: order.join(','), distinct: ids.size }
}
let SYNC = null
const sync = () => (SYNC ??= digest(buildTextures(...args())))

describe('the same bytes', () => {
  it('a job paused at every pause point gives the TexSet buildTextures gives, storey bands and shared tiles included', () => {
    const job = prebuildTextures(...args())
    expect(job).not.toBeNull()
    let slices = 0
    while (!job.step(0)) slices++                       // a 0 ms slice: the job pauses at every pause point it reaches
    expect(slices).toBeGreaterThan(5000)
    const tex = job.take()
    const a = sync(), b = digest(tex)
    expect(b.tiles.length).toBe(a.tiles.length)
    expect(b.tiles).toEqual(a.tiles)
    expect(b.identity).toBe(a.identity)
    expect(b.distinct).toBe(a.distinct)
    expect(Object.keys(tex)).not.toContain('wallBands')                   // still not enumerable: the TexSet compares as before
    expect(Object.getOwnPropertyDescriptor(tex, 'wallBands').get).toBeTypeOf('function')
  })

  it('a recipe stepped through every pause gives the raster it paints in one go (rgb, cav, height, meta)', () => {
    const cases = [
      ['paintFormstone', 2, 2, { palette: 'grey', variant: 'spall', foot: true, snap: true, ss: 1 }],
      ['paintCommonBrick', 2, 2, { variant: 'ghostOpening', foot: true, ss: 1 }],
      ['paintPlywood', 1.6, 1.8, { mark: true, age: [0.85, 0.85], ss: 1 }],
      ['paintPaintedWood', 0.4, 1.2, { paint: 'white', peel: 0.4, grain: 'y', ss: 1 }],
      ['paintPartyWall', 2, 2, { ss: 1, ghostK: 3 }],
      ['paintWindowInterior', 0.9, 1.3, { mode: 'void', rail: true, ss: 1 }],
      ['paintYard', 1, 1, { cover: 'grass', ss: 2 }],
    ]
    for (const [name, w, h, opts] of cases) {
      const R = BF.RECIPES[name], seed = BF.subSeed(0x51EB, name)
      const A = R(w, h, 32, seed, null, opts)
      const it = R.steps(w, h, 32, seed, null, opts)
      let r, pauses = 0
      BF.STEP.on = true; BF.STEP.due = 0
      try { while (!(r = it.next()).done) pauses++ } finally { BF.STEP.on = false }
      const B = r.value
      expect(pauses, name).toBeGreaterThan(0)
      expect(Buffer.from(B.rgb.buffer).equals(Buffer.from(A.rgb.buffer)), name).toBe(true)
      expect(Buffer.from(B.cav.buffer).equals(Buffer.from(A.cav.buffer)), name).toBe(true)
      if (A.height) expect(Buffer.from(B.height.buffer).equals(Buffer.from(A.height.buffer)), name).toBe(true)
      expect(JSON.stringify(B.meta ?? null), name).toBe(JSON.stringify(A.meta ?? null))
    }
  })

  it('the pause points are fine-grained: a raster pass pauses before its first texel and then every 4 texels at most', () => {
    const R = BF.newRaster(1, 0.5, 32, { height: false })                // 32 × 16 texels
    let texels = 0, since = 0, most = 0, pauses = 0, beforeFirst = false
    const it = BF.rasterizeSteps(R, (s) => { texels++; since++; s.r = s.tx; s.g = s.ty; s.b = 1 }, { ss: 1 })
    BF.STEP.on = true; BF.STEP.due = 0
    try {
      let r
      while (!(r = it.next()).done) { if (pauses === 0 && texels === 0) beforeFirst = true; pauses++; most = Math.max(most, since); since = 0 }
    } finally { BF.STEP.on = false }
    expect(beforeFirst).toBe(true)
    expect(texels).toBe(32 * 16)
    expect(most).toBeLessThanOrEqual(4)
    expect(pauses).toBeGreaterThanOrEqual(32 * 16 / 4)
    const A = BF.newRaster(1, 0.5, 32, { height: false })
    BF.rasterize(A, (s) => { s.r = s.tx; s.g = s.ty; s.b = 1 }, { ss: 1 })
    expect(Buffer.from(R.rgb.buffer).equals(Buffer.from(A.rgb.buffer))).toBe(true)
  })

  it('the crew mark pauses inside its glyph test too (between the rows of its mask), and gives the same mark', () => {
    const seed = BF.subSeed(0x51EB, 'crew-pauses')
    const A = BF.crewMark(seed)
    const it = BF.paintPlywood.steps(1.6, 1.8, 32, seed, null, { mark: true, markSeed: seed, age: [0.85, 0.85], ss: 1 })
    let pauses = 0, r
    BF.STEP.on = true; BF.STEP.due = 0
    try { while (!(r = it.next()).done) pauses++ } finally { BF.STEP.on = false }
    expect(pauses).toBeGreaterThan(0)
    expect(JSON.stringify(r.value.meta.mark)).toBe(JSON.stringify(A))
    // the mask: the same values built in one go as row by row inside a stepped job
    const m1 = BF.crewMarkMask(A)
    BF.STEP.on = true; BF.STEP.due = 0
    let m2
    try { m2 = BF.crewMarkMask(A) } finally { BF.STEP.on = false }        // (a drain: it finishes in one go even inside a slice)
    expect(Buffer.from(m2.values.buffer).equals(Buffer.from(m1.values.buffer))).toBe(true)
  })

  it('a recipe with a plain paint(ctx) still paints in one go, and its steps give the same raster', () => {
    const plain = BF.makeRecipe({ name: 'plainTest', stock: 'B', paint(ctx) { ctx.raster((s) => { s.r = 40 + 100 * s.x; s.g = 60; s.b = 80 * s.y }); return { n: 1 } } })
    const stepped = BF.makeRecipe({ name: 'steppedTest', stock: 'B', *paint(ctx) { yield* ctx.raster((s) => { s.r = 40 + 100 * s.x; s.g = 60; s.b = 80 * s.y }); return { n: 1 } } })
    const A = plain(1, 1, 32, 7, null, { ss: 1 }), B = stepped(1, 1, 32, 7, null, { ss: 1 }), C = BF.drain(plain.steps(1, 1, 32, 7, null, { ss: 1 }))
    for (const X of [B, C]) { expect(Array.from(X.rgb)).toEqual(Array.from(A.rgb)); expect(X.meta).toEqual({ n: 1 }) }
    expect(A.rgb[3 * 33]).toBeGreaterThan(0)
  })
})

describe('the handover', () => {
  it('buildTexturesMemo takes a job part-way, finishes it and returns the same TexSet; the job is then gone and the memo holds it', () => {
    clearTexturesMemo(); cancelPrebuilds()
    const job = prebuildTextures(...args())
    expect(prebuildTextures(...args())).toBe(job)                         // one job per key
    for (let i = 0; i < 12; i++) expect(job.step(2)).toBe(false)          // ~25 ms of a ~1.3 s build: far from done
    expect(job.slices).toBe(12)
    expect(prebuildsPending()).toBe(1)
    const tex = buildTexturesMemo(...args())                             // what the block's renderer calls (gfx-cpu.js, gfx-gl.js)
    expect(job.done).toBe(true)
    expect(prebuildsPending()).toBe(0)
    expect(buildTexturesMemo(...args())).toBe(tex)                        // the memo holds it now
    expect(prebuildTextures(...args())).toBeNull()                        // nothing left to build ahead for that key
    const a = sync(), b = digest(tex)
    expect(b.tiles).toEqual(a.tiles)
    expect(b.identity).toBe(a.identity)
    clearTexturesMemo()
  })

  it('a cancelled job is dropped: take() gives nothing, the memo builds its own (and a key change never takes a job)', () => {
    clearTexturesMemo(); cancelPrebuilds()
    const job = prebuildTextures(...args())
    job.step(2)
    job.cancel()
    expect(job.cancelled).toBe(true)
    expect(prebuildsPending()).toBe(0)
    expect(job.take()).toBeNull()
    expect(job.step(5)).toBe(true)                                        // a cancelled job does no more work
    const other = prebuildTextures(...args())
    expect(other).not.toBe(job)
    // a different palette (a drifted wish) is another key: the job for the stock palette is not taken for it
    const drifted = { ...CFG.palette, floor: '#5B5048' }
    expect(prebuildsPending()).toBe(1)
    const keyOf = (p) => KEY + '|' + JSON.stringify([p, CFG.materials, CFG.look])
    expect(keyOf(drifted)).not.toBe(other.key)
    expect(other.key).toBe(keyOf(CFG.palette))
    cancelPrebuilds()
    expect(prebuildsPending()).toBe(0)
  })
})

describe('nothing runs where it is not needed', () => {
  it('without the look (or on levels 0-3) there is no job and no idle callback', () => {
    const idle = vi.fn()
    expect(prebuildTextures(CFG.palette, CFG.materials, null, '∅')).toBeNull()
    expect(prebuildLevelTextures({ ...CFG, look: null }, { idle })).toBeNull()
    expect(prebuildLevelTextures({ ...CFG, look: { floor: 'yard' } }, { idle })).toBeNull()
    for (const i of [0, 1, 2, 3]) expect(prebuildLevelTextures(levelConfig(DEFAULT_CONFIG, i), { idle })).toBeNull()
    expect(prebuildLevelTextures(levelConfig(DEFAULT_CONFIG, LOBBY), { idle })).toBeNull()
    expect(prebuildLevelTextures(null, { idle })).toBeNull()
    expect(idle).not.toHaveBeenCalled()
    expect(prebuildsPending()).toBe(0)
  })
})

describe('the idle slices', () => {
  it('one slice per idle callback, never past the idle deadline, re-queued until cancelled', () => {
    cancelPrebuilds(); clearTexturesMemo()
    const queue = []
    const idle = (fn) => { queue.push(fn) }
    const job = prebuildLevelTextures(CFG, { idle, sliceMs: 3 })
    expect(job).not.toBeNull()
    expect(queue.length).toBe(1)
    expect(job.slices).toBe(0)                                            // nothing runs until the page is idle
    queue.shift()({ timeRemaining: () => 0.5 })                           // an idle period too short for a slice: none, asked again
    expect(job.slices).toBe(0)
    expect(queue.length).toBe(1)
    for (let i = 0; i < 4; i++) queue.shift()({ timeRemaining: () => 20 })
    expect(job.slices).toBe(4)
    expect(queue.length).toBe(1)
    expect(job.done).toBe(false)
    job.cancel()
    queue.shift()({ timeRemaining: () => 20 })                            // a callback already queued finds it cancelled: nothing, and no more
    expect(job.slices).toBe(4)
    expect(queue.length).toBe(0)
    expect(PREBUILD_SLICE_MS).toBeGreaterThanOrEqual(2)
    expect(PREBUILD_SLICE_MS).toBeLessThanOrEqual(8)                      // a few ms: off the title's frame budget
  })

  it('one loop a job: a second call for the same config returns the same job and queues no second loop', () => {
    cancelPrebuilds(); clearTexturesMemo()
    const queue = []
    const idle = (fn) => { queue.push(fn) }
    const job = prebuildLevelTextures(CFG, { idle, sliceMs: 3 })
    expect(prebuildLevelTextures(CFG, { idle, sliceMs: 3 })).toBe(job)
    expect(prebuildLevelTextures({ ...CFG }, { idle })).toBe(job)        // the same config, another object: the same key, the same job
    expect(queue.length).toBe(1)
    for (let i = 0; i < 3; i++) queue.shift()({ timeRemaining: () => 20 })
    expect(job.slices).toBe(3)
    expect(queue.length).toBe(1)                                          // still one callback queued, so still one slice an idle period
    expect(prebuildLevelTextures(CFG, { idle })).toBe(job)
    expect(queue.length).toBe(1)
    job.cancel()
    queue.shift()({ timeRemaining: () => 20 })
    expect(queue.length).toBe(0)
    const again = prebuildLevelTextures(CFG, { idle })                   // a cancelled job is gone: a new call starts a new job and its loop
    expect(again).not.toBe(job)
    expect(queue.length).toBe(1)
    cancelPrebuilds()
  })

  it('cancelPrebuilds(keep) drops every job but the one for the config it is given', () => {
    cancelPrebuilds(); clearTexturesMemo()
    const drifted = { ...CFG, palette: { ...CFG.palette, floor: '#5B5048' } }
    const mine = prebuildTextures(...args()), other = prebuildTextures(...args(drifted))
    expect(other).not.toBe(mine)
    expect(prebuildsPending()).toBe(2)
    cancelPrebuilds(CFG)
    expect(other.cancelled).toBe(true)
    expect(mine.cancelled).toBe(false)
    expect(prebuildsPending()).toBe(1)
    cancelPrebuilds(levelConfig(DEFAULT_CONFIG, 0))                      // a config with no job: every job goes
    expect(mine.cancelled).toBe(true)
    expect(prebuildsPending()).toBe(0)
  })

  it('without a deadline (the setTimeout fallback) a slice is sliceMs long; a slice stays short (3 ms asked: well under 100 ms)', () => {
    cancelPrebuilds(); clearTexturesMemo()
    const queue = []
    const job = prebuildLevelTextures(CFG, { idle: (fn) => queue.push(fn), sliceMs: 3 })
    for (let i = 0; i < 30; i++) queue.shift()()
    expect(job.slices).toBe(30)
    expect(job.longest).toBeLessThan(100)
    expect(job.ms).toBeLessThan(30 * 100)
    job.cancel()
  })
})
