// Wish #5: "a big plaque on the wall with me and maddie's name on it" — the owner: "grant the wish. make it viewable on a lightpost at the
// 806 N Carey maze", and what it says: "Mads n Dads were here". A lightpost stands in the park on Level ∅ (the block), a body like any
// sight, with a big plaque bolted to it; E within reach lays the plaque on the paper card.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { PLAQUE_TEXT, PLAQUE_REACH, PLAQUE_HINT, plaqueText, nearPlaque } from '../src/renderer/plaque.js'
import { NULL_MAP, NULL_SPAWN, NULL_EXIT, NULL_LIGHTPOST } from '../src/renderer/level-null-map.js'
import { LEVELS, levelConfig } from '../src/renderer/levels.js'
import { DEFAULT_CONFIG, createGridReader } from '../src/renderer/world.js'
import { createDecorSystem, SIGHT_TYPES } from '../src/renderer/decor.js'
import { createFixedMap } from '../src/renderer/fixedmap.js'
import { SIGHT_SPEC, getFrame, drawSprites, queueLevelSprites, warmQueue, resetAtlas } from '../src/renderer/gfx-sprites.js'
import { footprintRadius, createColliderIndex, createSolidWorld, resolveCircle, PLAYER_R } from '../src/renderer/collide.js'

const game = readFileSync(new URL('../src/renderer/game.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const NULL = LEVELS.findIndex((l) => l.id === '∅')
const cfgNull = levelConfig(DEFAULT_CONFIG, NULL)

describe('plaque.js', () => {
  it('the card reads the owner\'s words, exactly as written', () => {
    expect(PLAQUE_TEXT).toBe('Mads n Dads were here')
    expect(plaqueText()).toBe('Mads n Dads were here')
    expect(PLAQUE_HINT).toBe('e · read the plaque')
  })
  it('nearPlaque: within PLAQUE_REACH of it, never without a plaque', () => {
    const at = { x: 10, y: 10 }
    expect(nearPlaque({ x: 10, y: 10 }, at)).toBe(true)
    expect(nearPlaque({ x: 10 + PLAQUE_REACH, y: 10 }, at)).toBe(true)
    expect(nearPlaque({ x: 10 + PLAQUE_REACH + 0.01, y: 10 }, at)).toBe(false)
    expect(nearPlaque({ x: 11, y: 11 }, at)).toBe(true)
    expect(nearPlaque({ x: 10, y: 10 }, null)).toBe(false)
    expect(nearPlaque({ x: 10, y: 10 }, undefined)).toBe(false)
  })
})

describe('the lightpost on the block (Level ∅)', () => {
  const cell = (p) => NULL_MAP[Math.floor(p.y)][Math.floor(p.x)]
  it('stands on open park ground with open ground all round it, clear of the spawn, the exit and the form', () => {
    expect(cell(NULL_LIGHTPOST)).toBe('.')
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]])
      expect(NULL_MAP[Math.floor(NULL_LIGHTPOST.y) + dy][Math.floor(NULL_LIGHTPOST.x) + dx]).toBe('.')
    const far = (a, b, d) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2 > d * d
    expect(far(NULL_LIGHTPOST, NULL_SPAWN, 4)).toBe(true)
    expect(far(NULL_LIGHTPOST, NULL_EXIT, 4)).toBe(true)
    for (const n of cfgNull.notes) expect(far(NULL_LIGHTPOST, n, PLAQUE_REACH + 1.8)).toBe(true)   // its prompt never meets the form's
  })
  it('Level ∅ authors it (sightsAt) and puts the plaque on it; no other floor has either', () => {
    expect(cfgNull.sightsAt).toEqual([{ x: NULL_LIGHTPOST.x, y: NULL_LIGHTPOST.y, type: 'lightpost' }])
    expect(cfgNull.plaque).toEqual(NULL_LIGHTPOST)
    for (let i = 0; i < LEVELS.length; i++) if (i !== NULL) {
      const c = levelConfig(DEFAULT_CONFIG, i)
      expect(c.sightsAt).toBeUndefined(); expect(c.plaque).toBeUndefined()
    }
  })
  it('is never scattered: decor.js SIGHT_TYPES does not hold it', () => {
    expect(SIGHT_TYPES).not.toContain('lightpost')
  })
  it('decor places it once, keyed outside the chunks, never evicted, and hands its body to onChunk once', () => {
    const m = createFixedMap(cfgNull.map)
    const calls = []
    const sys = createDecorSystem(cfgNull, (wx, wy) => m.isWall(wx, wy), 0, { onChunk: (k, b) => calls.push([k, b]) })
    sys.update(0, 0)
    const posts = sys.getSights().filter((s) => s.type === 'lightpost')
    expect(posts).toEqual([{ key: '∅:s0', x: NULL_LIGHTPOST.x, y: NULL_LIGHTPOST.y, type: 'lightpost' }])
    const mine = calls.filter(([k]) => k === '∅:s0')
    expect(mine).toHaveLength(1)
    expect(mine[0][1].colliders).toHaveLength(1)
    expect(mine[0][1].colliders[0]).toMatchObject({ x: NULL_LIGHTPOST.x, y: NULL_LIGHTPOST.y })
    expect(mine[0][1].sight).toBe(posts[0])
    sys.update(40, 40); sys.update(0, 0)
    expect(sys.getSights().filter((s) => s.type === 'lightpost')).toHaveLength(1)
    expect(calls.filter(([k]) => k === '∅:s0')).toHaveLength(1)
    // a travel away and back clears and places it again (the game's new collider index gets the body again)
    sys.enterLevel(levelConfig(DEFAULT_CONFIG, 0)); sys.update(0, 0)
    expect(sys.getSights().some((s) => s.type === 'lightpost')).toBe(false)
    sys.enterLevel(cfgNull); sys.update(0, 0)
    expect(sys.getSights().filter((s) => s.type === 'lightpost')).toHaveLength(1)
    expect(calls.filter(([k]) => k === '∅:s0')).toHaveLength(2)
  })
  it('its body is a post, not a wall: a small footprint', () => {
    expect(footprintRadius('sight', 'lightpost')).toBeLessThan(0.2)
  })

  // the block as buildLevel builds it (game.js): the collider index, decor filing every body through onChunk -> setChunk, the solid world
  // over the index, then decor.update at the spawn's chunk. The block has no passes and no creatures.
  function blockAsTheGameBuildsIt(feed = (bodies, k, b) => bodies.setChunk(k, b.colliders)) {
    const fixed = createFixedMap(cfgNull.map)
    const isWall = (wx, wy, pcx, pcy) => fixed.isWall(wx, wy, pcx, pcy)
    const grid = createGridReader(null, isWall)
    const bodies = createColliderIndex()
    const decor = createDecorSystem(cfgNull, isWall, 0, { passes: [], onChunk: (k, b) => feed(bodies, k, b), onEvict: (k) => bodies.dropChunk(k) })
    const solid = createSolidWorld({ index: bodies, floorFn: grid.floor, solidCreature: () => false })
    decor.update(0, 0)
    return { grid, bodies, solid }
  }
  const postIn = (bodies) => {
    const Q = []
    const n = bodies.query(NULL_LIGHTPOST.x, NULL_LIGHTPOST.y, 0.01, Q)
    return Q.slice(0, n).find((c) => c.type === 'lightpost')
  }

  it('the game\'s collider index holds its body: walk into it from any side and you are pushed out, never through', () => {
    expect(game).toContain('onChunk: (k, bundle) => { bodies.setChunk(k, bundle.colliders);')    // the wiring built here
    const { grid, bodies } = blockAsTheGameBuildsIt()
    const post = postIn(bodies)
    expect(post).toMatchObject({ x: NULL_LIGHTPOST.x, y: NULL_LIGHTPOST.y, kind: 'sight', type: 'lightpost', cls: 'solid' })
    const R = post.r + PLAYER_R
    // one step that would end inside it: the resolver reports the post and leaves you at its edge
    const out = {}
    resolveCircle(post.x - R - 0.02, post.y, post.x - R + 0.1, post.y, bodies, grid.floor, out)
    expect(out.pushN).toBe(1)
    expect(out.push[0]).toBe(post)
    expect(Math.hypot(out.x - post.x, out.y - post.y)).toBeGreaterThanOrEqual(R)
    // the mover (a fresh one each time: its contact ring remembers a touch for 0.4 s), a second of walking straight at it from each
    // side: it stops you at its edge and says it touched the post
    const world = () => createSolidWorld({ index: bodies, floorFn: grid.floor, solidCreature: () => false })
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const solid = world()
      const p = { x: post.x - dx, y: post.y - dy }
      let entered = null, closest = Infinity
      for (let f = 0; f < 60; f++) {
        const rep = solid.movePlayer(p, p.x + dx * 0.05, p.y + dy * 0.05, 1 / 60, false, [])
        if (rep.entered) entered = rep.entered
        closest = Math.min(closest, Math.hypot(p.x - post.x, p.y - post.y))
      }
      expect(entered, `from ${-dx},${-dy}`).toBe(post)
      expect(closest, `from ${-dx},${-dy}`).toBeGreaterThanOrEqual(R)
      expect(Math.hypot(p.x - post.x, p.y - post.y), `from ${-dx},${-dy}`).toBeCloseTo(R, 3)
    }
    // standing inside it (a resume, the solid-bodies pref switched on beside it): the settle puts you outside
    const p = { x: post.x + 0.05, y: post.y }
    world().settlePlayer(p)
    expect(Math.hypot(p.x - post.x, p.y - post.y)).toBeGreaterThanOrEqual(R)
  })

  it('the index holds it whichever comes first, its own key or chunk (0, 0), and through chunk (0, 0) filed again or dropped', () => {
    const handed = []
    const { bodies: forward } = blockAsTheGameBuildsIt((bodies, k, b) => { handed.push([k, b.colliders]); bodies.setChunk(k, b.colliders) })
    expect(handed.map(([k]) => k)).toContain('∅:s0')
    expect(handed.map(([k]) => k)).toContain('0,0')
    const all = (bodies) => { const Q = []; return Q.slice(0, bodies.query(12, 9, 60, Q)) }
    const got = all(forward)
    expect(got.filter((c) => c.type === 'lightpost')).toHaveLength(1)
    expect(got.at(-1).type).toBe('lightpost')                         // after the chunk's own bodies
    expect(handed.find(([k]) => k === '0,0')[1].length).toBeGreaterThan(0)   // seed 0 rolls the yard a prop: the order is tested
    expect(forward.size).toBe(handed.reduce((s, [, l]) => s + l.length, 0))
    // the same bundles, the post's first: the same index, record for record and in the same order
    const backward = createColliderIndex()
    for (const [k, l] of [...handed].sort(([a], [b]) => (b === '∅:s0') - (a === '∅:s0'))) backward.setChunk(k, l)
    expect(all(backward)).toEqual(got)
    // chunk (0, 0) filed again (its own bodies replaced) keeps the post; dropped, the post stays and the chunk's own go
    const own = handed.find(([k]) => k === '0,0')[1]
    forward.setChunk('0,0', own)
    expect(all(forward)).toEqual(got)
    forward.dropChunk('0,0')
    expect(postIn(forward)).toBe(got.find((c) => c.type === 'lightpost'))
    expect(forward.size).toBe(handed.reduce((s, [k, l]) => s + (k === '0,0' ? 0 : l.length), 0))
  })
})

describe('the lightpost sprite', () => {
  it('a post taller than a wall (the block is outdoors), its width the plaque\'s; two layers, the globe\'s light the second', () => {
    expect(SIGHT_SPEC.lightpost.h).toBeGreaterThan(1)
    expect(SIGHT_SPEC.lightpost.w).toBeGreaterThan(SIGHT_SPEC.payphone.w)
    const fr = getFrame('sight', 'lightpost', 0, 0, 0, 0)
    expect(fr.layers).toHaveLength(2)
    expect(fr.layers[1].mode).toBe(1)
  })
  it('drawn on the block it stands taller than a payphone at the same distance', () => {
    const drawn = (type) => {
      const W = 200, H = 160, bg = ((255 << 24) | (60 << 16) | (170 << 8) | 210) >>> 0
      const buf = new Uint32Array(W * H).fill(bg), z = new Float32Array(W).fill(30)
      const fs = { W, H, HH: H >> 1, fog: 22, fogRgb: [154, 150, 140], flicker: 1, t: 0.4, hf: 0.6, fov: 1.2, player: { x: 0, y: 0, angle: 0 }, opts: {}, lights: {} }
      drawSprites(buf, z, fs, [{ kind: 'sight', sightType: type, x: 5, y: 0, key: 's' }])
      let y0 = 1e9, y1 = -1
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (buf[y * W + x] !== bg) { y0 = Math.min(y0, y); y1 = Math.max(y1, y) }
      return y1 - y0
    }
    expect(drawn('lightpost')).toBeGreaterThan(drawn('payphone') * 1.8)
  })
  it('the block warms its frame from its config; the lobby never queues it', () => {
    resetAtlas()
    queueLevelSprites(cfgNull)
    expect(warmQueue().some((j) => j[0] === 'sight' && j[1] === 'lightpost')).toBe(true)
    resetAtlas()
    queueLevelSprites(levelConfig(DEFAULT_CONFIG, 0))
    const lobby = warmQueue().filter((j) => j[0] === 'sight').map((j) => j[1])
    expect(lobby.length).toBeGreaterThan(0)
    expect(lobby).not.toContain('lightpost')
    resetAtlas()
  })
})

describe('game.js: the prompt and E', () => {
  it('reads the plaque within reach of a level\'s plaque, after the way, the form or the scrap, before the soul', () => {
    expect(game).toContain("import { PLAQUE_HINT, plaqueText, nearPlaque } from './plaque.js'")
    expect(game).toContain('const atPlaque = nearPlaque(player, cfg.plaque)')
    expect(game).toMatch(/\} else if \(nearScrap\) \{\n[^\n]*\n[^\n]*\n\s*\} else if \(atPlaque\) \{\n\s*itemHintEl\.textContent = PLAQUE_HINT\n\s*itemHintEl\.style\.opacity = '1'\n\s*\} else if \(nearNpc\) \{/)
    expect(game).toMatch(/else if \(nearScrap\) nearScrap\.form [^\n]*\n\s*else if \(atPlaque\) openPlaque\(\)\n\s*else if \(door\) knockDoor\(door\)/)
    expect(game).toContain("function openPlaque() { openCard('form', { text: plaqueText(), foot: '' }) }")
  })
  it('the offline shells list plaque.js', () => {
    expect(readFileSync(new URL('../src/sw.js', import.meta.url), 'utf8')).toContain("'/renderer/plaque.js'")
    expect(readFileSync(new URL('../tools/build-play.sh', import.meta.url), 'utf8')).toContain("'plaque.js'")
  })
})
