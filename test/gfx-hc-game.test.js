// Track HC: game.js's per-frame CPU costs outside the renderer. The sprite list is assembled from pooled records (the renderer must receive
// exactly what the old per-frame .map() calls built: same fields, same values, same order), resize storms are coalesced to one layout per
// animation frame, and a level change keeps the screen black until the new level has drawn its first frames.
import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import { createEntityAssembler, ENTITY_FILLS as F, createResizeGate, watchDpr, SETTLE_FRAMES, SETTLE_MAX_MS } from '../src/renderer/game.js'
import { mulberry32 } from '../src/renderer/gfx-util.js'

// the assembly exactly as game.js wrote it before the pooling (verbatim maps, same spread order)
function legacyAssemble(w) {
  const remoteEntities = w.mp ? w.remote.map(p => ({ x: p.x, y: p.y, kind: 'player', name: p.name || 'wanderer', angle: p.angle, chatText: p.chatText, hp: p.hp })) : []
  const propEntities = w.props.map(p => ({ x: p.x, y: p.y, kind: 'prop', type: p.type, rot: p.rot, key: p.key }))
  const exitEntities = w.exits.map(e => ({ x: e.x, y: e.y, kind: 'exit', target: e.target, key: e.key }))
  const npcEntities  = w.npcs.map(n => ({ x: n.x, y: n.y, kind: 'npc', name: 'a lost soul', key: n.key }))
  const itemEntities = w.items.map(it => ({ x: it.x, y: it.y, kind: 'item', itemType: it.type, key: it.key }))
  const scrapEntities = w.scraps.map(s => ({ x: s.x, y: s.y, kind: 'note', read: w.readSet.has(s.frag), frag: s.frag, key: s.key }))
  const machineEntities = w.machines.map(m => ({ x: m.x, y: m.y, kind: 'machine', vended: w.vendedSet.has(m.key), key: m.key }))
  const sightEntities = w.sights.map(s => ({ x: s.x, y: s.y, kind: 'sight', sightType: s.type, key: s.key }))
  const apparitionEntities = w.ephemera.map(a => ({ x: a.x, y: a.y, variant: a.variant, vx: a.vx, vy: a.vy }))
  const enemyEntities = w.creaturesOn ? w.enemies : []
  return [
    ...enemyEntities, ...remoteEntities, ...npcEntities,
    ...propEntities, ...exitEntities, ...itemEntities, ...scrapEntities, ...machineEntities, ...sightEntities, ...apparitionEntities,
  ]
}
// the pooled assembly exactly as game.js now writes it
function pooledAssemble(A, w) {
  A.begin()
  if (w.creaturesOn) A.pass(w.enemies)
  if (w.mp) A.add('player', w.remote, F.player)
  A.add('npc', w.npcs, F.npc)
  A.add('prop', w.props, F.prop)
  A.add('exit', w.exits, F.exit)
  A.add('item', w.items, F.item)
  A.add('note', w.scraps, F.note, w.readSet)
  A.add('machine', w.machines, F.machine, w.vendedSet)
  A.add('sight', w.sights, F.sight)
  A.add('apparition', w.ephemera, F.apparition)
  return A.end()
}
function randomWorld(rnd) {
  const n = (k) => Math.floor(rnd() * k)
  const list = (k, f) => Array.from({ length: n(k) }, (_, i) => f(i))
  const xy = () => ({ x: rnd() * 40 - 20, y: rnd() * 40 - 20 })
  return {
    mp: rnd() < 0.6, creaturesOn: rnd() < 0.7,
    remote: list(4, (i) => ({ ...xy(), name: rnd() < 0.3 ? '' : `w${i}`, angle: rnd() * 6, chatText: rnd() < 0.5 ? null : 'hi', hp: n(100), id: 'extra-field-not-forwarded' })),
    enemies: list(5, (i) => ({ ...xy(), type: 'stalker', variant: 'smiler', state: 'idle', dir: 0, stagger: 0, key: `e${i}` })),
    npcs: list(3, (i) => ({ ...xy(), key: `n${i}`, line: 'x' })),
    props: list(60, (i) => ({ ...xy(), type: ['chair', 'box', 'drum'][i % 3], rot: n(4), key: `p${i}` })),
    exits: list(3, (i) => ({ ...xy(), target: i, key: `x${i}` })),
    items: list(8, (i) => ({ ...xy(), type: 'bandage', key: `i${i}` })),
    scraps: list(4, (i) => ({ ...xy(), frag: n(6), key: `s${i}` })),
    machines: list(3, (i) => ({ ...xy(), key: `m${i}` })),
    sights: list(3, (i) => ({ ...xy(), type: 'tvwall', key: `g${i}` })),
    ephemera: list(3, () => ({ ...xy(), variant: 'thin', vx: rnd(), vy: rnd(), ttl: 2 })),
    readSet: new Set([0, 2]), vendedSet: new Set(['m1']),
  }
}

describe('createEntityAssembler (the pooled sprite list)', () => {
  it('hands the renderer exactly what the old .map() assembly built — fields, key order, values and list order — over many random frames', () => {
    const rnd = mulberry32(12345)
    const A = createEntityAssembler()
    for (let frame = 0; frame < 300; frame++) {
      const w = randomWorld(rnd)
      const want = legacyAssemble(w), got = pooledAssemble(A, w)
      expect(got.length).toBe(want.length)
      expect(JSON.stringify(got)).toBe(JSON.stringify(want))            // stringify compares key ORDER too
      for (let i = 0; i < got.length; i++) expect(Object.keys(got[i])).toEqual(Object.keys(want[i]))
      // the enemies are the entity system's own objects, handed through untouched (as before)
      if (w.creaturesOn) for (let i = 0; i < w.enemies.length; i++) expect(got[i]).toBe(w.enemies[i])
    }
  })
  it('reuses the output array and every record: nothing new is allocated once the pools cover the largest frame', () => {
    const A = createEntityAssembler()
    const w = randomWorld(mulberry32(7)); w.props = Array.from({ length: 40 }, (_, i) => ({ x: i, y: 1, type: 'box', rot: 0, key: `p${i}` }))
    const a = pooledAssemble(A, w), firstProps = a.filter((e) => e.kind === 'prop')
    w.props.forEach((p) => { p.x += 0.5 })
    const b = pooledAssemble(A, w)
    expect(b).toBe(a)                                                    // same array object
    const secondProps = b.filter((e) => e.kind === 'prop')
    for (let i = 0; i < secondProps.length; i++) expect(secondProps[i]).toBe(firstProps[i])      // same records, new values
    expect(secondProps[3].x).toBe(3.5)
    expect(A.poolSize('prop')).toBe(40)
    w.props.length = 10
    const c = pooledAssemble(A, w)
    expect(c.filter((e) => e.kind === 'prop').length).toBe(10)          // a shorter frame is not padded with stale records
    expect(A.poolSize('prop')).toBe(40)                                 // the pool keeps its high-water mark
  })
  it('an empty world gives an empty list', () => {
    const A = createEntityAssembler()
    const w = { mp: false, creaturesOn: false, remote: [], enemies: [], npcs: [], props: [], exits: [], items: [], scraps: [], machines: [], sights: [], ephemera: [], readSet: new Set(), vendedSet: new Set() }
    expect(pooledAssemble(A, w)).toEqual([])
  })
})

describe('resize coalescing', () => {
  it('any number of requests between two frames gives one layout', () => {
    const g = createResizeGate()
    expect(g.take()).toBe(false)
    for (let i = 0; i < 30; i++) g.request()
    expect(g.pending).toBe(true)
    expect(g.take()).toBe(true)
    expect(g.take()).toBe(false)
  })
  it('watchDpr fires on a devicePixelRatio change and re-arms for the new ratio; stop() detaches', () => {
    const queries = []
    const win = {
      devicePixelRatio: 1,
      matchMedia(q) { const m = { q, fns: [], addEventListener: (ev, fn) => m.fns.push(fn), removeEventListener: (ev, fn) => { m.fns = m.fns.filter((f) => f !== fn) } }; queries.push(m); return m },
    }
    const cb = vi.fn()
    const stop = watchDpr(win, cb)
    expect(queries[0].q).toBe('(resolution: 1dppx)')
    win.devicePixelRatio = 2; queries[0].fns[0]()
    expect(cb).toHaveBeenCalledTimes(1)
    expect(queries[1].q).toBe('(resolution: 2dppx)')
    stop()
    expect(queries[1].fns.length).toBe(0)
    expect(() => watchDpr({ devicePixelRatio: 1 }, cb)).not.toThrow()         // no matchMedia: the loop's periodic check is the fallback
  })
})

describe('game.js wiring (source guards)', () => {
  const game = fs.readFileSync(new URL('../src/renderer/game.js', import.meta.url), 'utf8')
  it('resize, orientationchange and a DPR change only raise the flag; the loop lays out only on a frame the fps cap lets draw (frameDue)', () => {
    expect(game).not.toMatch(/addEventListener\('resize', resize\)/)
    expect(game).toMatch(/addEventListener\('resize', queueResize\)/)
    expect(game).toMatch(/addEventListener\('orientationchange', queueResize\)/)
    expect(game).toMatch(/watchDpr\(window, queueResize\)/)
    expect(game).not.toMatch(/\n\s*if \(resizeGate\.take\(\)\) resize\(\)/)            // the H-CORE-3 strobe: laid out on a frame the pacer then skipped
    expect(game).toMatch(/if \(!frameDue\(ts, pacer, fpsCap, resizeGate, resize\)\) \{ requestAnimationFrame\(loop\); return \}/)
  })
  it('the sprite list is the pooled one: no per-frame .map() of the decor lists is left', () => {
    expect(game).not.toMatch(/getProps\(\)\.map\(/)
    expect(game).not.toMatch(/\.\.\.propEntities/)
    expect(game).toMatch(/const allEntities = entityAsm\.end\(\)/)
  })
  it('a level change lifts the veil only after SETTLE_FRAMES frames of the new level (or SETTLE_MAX_MS)', () => {
    expect(SETTLE_FRAMES).toBeGreaterThanOrEqual(4)                        // the GPU's first-frame validation runs on the 4th render
    expect(SETTLE_MAX_MS).toBeLessThanOrEqual(2000)
    expect(game).toMatch(/if \(frames\(\) - f0 >= settleFrames \|\| now\(\) - s0 >= settleMaxMs\) \{ el\.style\.opacity = '0'; shown\(\) \}/)
    expect(game).toMatch(/settleFrames = SETTLE_FRAMES, settleMaxMs = SETTLE_MAX_MS/)
    expect(game).toMatch(/const fader = createFader\(\{ el: fadeEl, frames: \(\) => frameCount \}\)/)       // behaviour: test/gfx-jc-game.test.js
    expect(game).not.toMatch(/requestAnimationFrame\(\(\) => \{ fadeEl\.style\.opacity = '0' \}\)/)
  })
  it('solid bodies (collide): tryMove dispatches to level.solid.movePlayer (Solid furniture on) or the legacy movePoint (off); the movement block has exactly one tryMove( call site', () => {
    expect(game).toMatch(/if \(!getPref\('solidBodies'\)\) \{\r?\n\s*const pcx = Math\.floor\(player\.x \/ CHUNK_SIZE\)\r?\n\s*const pcy = Math\.floor\(player\.y \/ CHUNK_SIZE\)\r?\n\s*const r = movePoint\(player\.x, player\.y, nx, ny, level\.cache\.isWall, pcx, pcy\)\r?\n\s*player\.x = r\.x; player\.y = r\.y\r?\n\s*return\r?\n\s*\}/)
    expect(game).toMatch(/lastReport = level\.solid\.movePlayer\(player, nx, ny, lastDt, wantSprint, creaturesOn \? level\.entitySys\.getEntities\(\) : EMPTY\)\r?\n\s*noteContact\(lastReport\)/)
    expect(game).not.toMatch(/if \(!level\.cache\.isWall\(nx, player\.y, pcx, pcy\)\) player\.x = nx/)     // the inline point mover lives in collide.js movePoint now
    expect((game.match(/(?<!function )tryMove\(/g) || []).length).toBe(1)                               // W/S/A/D sum into one step: one call site
  })
})
