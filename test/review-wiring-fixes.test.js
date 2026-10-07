// The wiring review's confirmed findings, pinned (W-R1..4, RT-A/B, DS-R1..5, FEEL-1..5/7..9, SD-radioOn-dropped). game.js only boots in a
// page, so each fix is a source guard on game.js plus, where a pure module carries the behaviour, the failure replayed against the real
// module (items.js, levelmem.js, haunts.js, fogmap.js, death.js, ward.js, messages.js) with game.js's own lines where they can be lifted.
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import { DEFAULT_CONFIG } from '../src/renderer/world.js'
import { createItemSystem } from '../src/renderer/items.js'
import { createLevelMemory, applyResume } from '../src/renderer/levelmem.js'
import { createHauntTracker } from '../src/renderer/haunts.js'
import { createFogMap } from '../src/renderer/fogmap.js'
import { resolveDeath } from '../src/renderer/death.js'
import { createWardCharger } from '../src/renderer/ward.js'

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8')
const game = read('../src/renderer/game.js')
const html = read('../src/renderer/index.html')
const at = (s, from = 0) => { const k = game.indexOf(s, from); expect(k, s).toBeGreaterThan(0); return k }
const slice = (from, to) => { const a = at(from), b = game.indexOf(to, a); expect(b, to).toBeGreaterThan(a); return game.slice(a, b) }
const buildBody = slice('function buildLevel(index, at = null) {', 'const fader = createFader(')
const travelBody = slice('function travel(way) {', '// die(): death.js resolves it')
const dieBody = slice('function die(d = null) {', '// ── input ──')
const loopBody = slice('function loop(ts) {', 'requestAnimationFrame(loop)   // ALWAYS reschedule')
const resumeBody = slice('if (resume) {', 'buildLevel(mpClient ? 0 : 4)')

describe('W-R1 / RT-A / DS-R1: the items meet the new floor\'s walls, never null and never the old floor\'s', () => {
  it('buildLevel enters the items (and reads the vend memory) only after `level = {` stands, before the first decor / item scan', () => {
    const lv = buildBody.indexOf('level = { index, cfg, cache, grid, bodies, decor, solid, entitySys, gfx, messages }')
    expect(lv).toBeGreaterThan(0)
    const enter = buildBody.indexOf('itemSys.enterLevel(cfg, cfg.map ? null : mem.takenFor(index), cfg.map ? null : mem.droppedFor(index))')
    const vend = buildBody.indexOf('vendedSet = mem.vendedFor(index, filedFloors.has(floorKey(worldSeed, index)) ? -Infinity : playT)')
    const scan = buildBody.indexOf('decor.update(spawnChunk.cx, spawnChunk.cy); itemSys.update(spawnChunk.cx, spawnChunk.cy)')
    expect(enter).toBeGreaterThan(lv); expect(vend).toBeGreaterThan(lv)
    expect(enter).toBeLessThan(scan); expect(vend).toBeLessThan(scan)
    expect((buildBody.match(/itemSys\.enterLevel\(/g) || []).length).toBe(1)
    // the proxy itemSys was built with reads the CURRENT level: that is why the order matters
    expect(game).toContain('createItemSystem(base, (wx, wy, pcx, pcy) => level.cache.isWall(wx, wy, pcx, pcy), worldSeed)')
  })

  // the real items.js behind game.js's proxy: a `level` variable read at call time
  const cfg = { ...DEFAULT_CONFIG }
  const proxySystem = () => {
    const box = { level: null }
    const sys = createItemSystem(cfg, (wx, wy, pcx, pcy) => box.level.cache.isWall(wx, wy, pcx, pcy), 0)
    return { box, sys }
  }
  const floorOf = (wallAt) => ({ cache: { isWall: (wx, wy) => wallAt(Math.floor(wx), Math.floor(wy)) } })
  const REC = [{ x: 7.5, y: 2.5, type: 'glowstick', t0: 0 }]

  it('a resume with a set-down record: entering before the level stands throws (the old order); after it, the record lies where it was left', () => {
    const before = proxySystem()
    expect(() => before.sys.enterLevel(cfg, null, REC)).toThrow(TypeError)          // `level` still null: the Continue crash
    const after = proxySystem()
    after.box.level = floorOf(() => false)                                          // buildLevel: level = { ... } first
    expect(() => after.sys.enterLevel(cfg, null, REC)).not.toThrow()
    expect(after.sys.getDropped()).toEqual([{ x: 7.5, y: 2.5, type: 'glowstick', t0: 0 }])
  })

  it('a travel: the arrival floor\'s record is tested against the arrival floor, not moved off its open cell by the floor left behind', () => {
    const leaving = floorOf((ix, iy) => ix === 7 && iy === 2)                       // the floor you leave has a wall on that cell
    const arriving = floorOf(() => false)                                           // the floor you arrive on is open there
    const old = proxySystem(); old.box.level = leaving
    old.sys.enterLevel(cfg, null, REC)
    expect(old.sys.getDropped()[0]).not.toMatchObject({ x: 7.5, y: 2.5 })           // the old order: nudged off open ground
    const fixed = proxySystem(); fixed.box.level = arriving
    fixed.sys.enterLevel(cfg, null, REC)
    expect(fixed.sys.getDropped()[0]).toMatchObject({ x: 7.5, y: 2.5 })
  })
})

describe('W-R2: an emptied machine restocks on the first return after a long enough absence', () => {
  it('travel and die re-read vendedFor once the visit is counted (mem.arrive), so the spent set is the arrival\'s', () => {
    expect(travelBody.indexOf('vendedSet = mem.vendedFor(level.index, filedFloors.has(floorKey(worldSeed, level.index)) ? -Infinity : playT)')).toBeGreaterThan(travelBody.indexOf('const rec = mem.arrive(way.target, spawnChunk, playT)'))
    expect(dieBody.indexOf('vendedSet = mem.vendedFor(level.index, filedFloors.has(floorKey(worldSeed, level.index)) ? -Infinity : playT)')).toBeGreaterThan(dieBody.indexOf('mem.arrive(level.index, spawnChunk, playT)'))
  })
  it('replayed on the real levelmem: buildLevel\'s read is still spent, the read after arrive is not, and wasRestocked agrees', () => {
    const mem = createLevelMemory()
    mem.arrive(1, { cx: 0, cy: 0 }, 0); mem.noteVended(1, 'm', 10); mem.leave(1, { x: 1, y: 1 }, { cx: 0, cy: 0 }, 20)
    expect(mem.vendedFor(1, 1000).has('m')).toBe(true)                              // buildLevel's read: the visit not yet counted
    mem.arrive(1, { cx: 0, cy: 0 }, 1000)
    expect(mem.vendedFor(1, 1000).has('m')).toBe(false)                             // travel's re-read: restocked, the prompt shows
    expect(mem.wasRestocked(1, 'm', 1000)).toBe(true)                               // 'the machine has been refilled. by whom.'
  })
})

describe('W-R3: a held ward costs your legs', () => {
  it('the idle regen does not run while the charger is latched', () => {
    expect(game).toMatch(/if \(moved && wantSprint\)\s+stamina = Math\.max\(0, stamina - 22 \* dt\)\r?\n\s*else if \(!charger\.isCharging\(\)\)\s+stamina = Math\.min\(100, stamina \+ 9 \* dt\)/)
    expect(game).not.toMatch(/\n\s*else\s+stamina = Math\.min\(100, stamina \+ 9 \* dt\)/)
  })
  it('replayed with the real charger and game.js\'s two stamina lines: standing still under a hold, stamina falls at 6/s', () => {
    const charger = createWardCharger()
    let stamina = 80
    const dt = 1 / 60, seen = []
    for (let i = 0; i < 30; i++) {                                                  // 0.5 s held (press edge once, no release)
      const w = charger.tick(dt, 1, 0, stamina)
      if (w?.charging) stamina = Math.max(0, stamina - w.drain * dt)
      const moved = false, wantSprint = false
      if (moved && wantSprint) stamina = Math.max(0, stamina - 22 * dt)
      else if (!charger.isCharging()) stamina = Math.min(100, stamina + 9 * dt)
      seen.push(stamina)
    }
    expect(seen[29]).toBeLessThan(seen[0])
    expect(80 - seen[29]).toBeCloseTo(6 * 30 * dt, 5)
  })
})

describe('W-R4: each floor keeps its own haunt cooldowns', () => {
  it('the trackers are per level, picked in buildLevel; nothing builds one per frame', () => {
    expect(game).toContain('const hauntTrackers = new Map()')
    expect(game).not.toMatch(/const haunts = createHauntTracker/)
    expect(buildBody).toContain('haunts = hauntTrackers.get(index) ?? hauntTrackers.set(index, createHauntTracker({ now: () => playT })).get(index)')
    expect(loopBody).not.toContain('createHauntTracker(')
  })
  it('replayed: a haunt fired at chunk 2,3 on level 1 does not hold back level 2\'s haunt at the same chunk key', () => {
    let now = 100
    const trackers = new Map()
    const pick = (index) => trackers.get(index) ?? trackers.set(index, createHauntTracker({ now: () => now })).get(index)
    const h = { key: '2,3:h', id: 'your-own-light', x: 40.5, y: 50.5 }
    const l1 = pick(1)
    expect(l1.check(40.5, 50.5, [h], true)).toBe(h)
    l1.fire(h.key)
    now = 150
    expect(l1.check(40.5, 50.5, [h], true)).toBeNull()                              // its own floor: cooling down
    expect(pick(2).check(40.5, 50.5, [h], true)).toBe(h)                            // the floor below: its own clock
    expect(pick(1)).toBe(l1)                                                        // a return finds the same tracker
  })
})

describe('RT-B: the loop never shadows initGame\'s config `base`', () => {
  it('no binding named base is declared inside loop(); the murmur reads base.messageInterval; the song base is songBase', () => {
    expect(loopBody).not.toMatch(/\b(const|let|var)\s+base\b/)
    expect(loopBody).toContain('msgNext  = base.messageInterval[0] + Math.random() * (base.messageInterval[1] - base.messageInterval[0])')
    expect(loopBody).toContain('const songBase = trackIdx < 0 ? cfg.music : TRACKS[trackIdx].mood')
    expect(game).toMatch(/export async function initGame\([^\n]*\r?\n\s*const base = await loadConfig\(\)/)
  })
})

describe('DS-R2: a note / machine / sight / soul never overwrites the way pinned in its chunk', () => {
  it('game.js namespaces every non-way pin by kind; the way pins keep the bare decor key', () => {
    expect(game).toContain("fog.pinThing(L, 's:' + s.key, 'sight', s.x, s.y)")
    expect(game).toContain("fog.pinThing(L, 'm:' + m.key, 'machine', m.x, m.y, vendedSet.has(m.key))")
    expect(game).toContain("fog.pinThing(L, 'n:' + sc.key, 'note', sc.x, sc.y, readSet.has(sc.frag))")
    expect(game).toContain("fog.pinThing(L, 'p:' + np.key, 'npc', np.x, np.y)")
    expect(game).toContain("fog.pinThing(level.index, 'm:' + m.key, 'machine', m.x, m.y, true)")
    expect(game).toContain("fog.pinThing(level.index, 'n:' + scrap.key, 'note', scrap.x, scrap.y, true)")
    expect(game).not.toMatch(/fog\.pinThing\([^,]+, (s|m|sc|np|scrap)\.key,/)
  })
  it('replayed on the real fogmap: an exit and a note in one chunk are two pins, the hole stays a way, and both survive export / import', () => {
    const fog = createFogMap()
    const exit = { key: '-29,-28', x: -632.5, y: -610.5, kind: 'down', target: 2, label: 'a hole in the carpet' }
    fog.pinWay(1, exit)
    fog.pinThing(1, 'n:' + exit.key, 'note', -631.5, -607.5, false)
    expect(fog.pins(1).size).toBe(2)
    expect(fog.ways(1).map((p) => p.type)).toEqual(['down'])
    expect(fog.countWays(1).down).toBe(1)
    fog.pinWay(1, exit)                                                             // seen again: still the one way, still a hole
    expect(fog.ways(1)).toHaveLength(1); expect(fog.ways(1)[0].type).toBe('down')
    const back = createFogMap()
    expect(back.import(JSON.parse(JSON.stringify(fog.export())))).toBe(true)
    expect(back.ways(1).map((p) => [p.key, p.type])).toEqual([['-29,-28', 'down']])
    expect(back.pins(1).get('n:-29,-28').type).toBe('note')
  })
})

describe('DS-R3: the save keeps the inventory\'s flags', () => {
  // game.js's own row function, lifted from the source and run
  const src = game.match(/const invRow = \(i\) => \(\{[\s\S]*?\n\s*\}\)\r?\n/)
  it('snapshot and resume both go through invRow (type + on / sour / tool; the plumb is a tool by its type)', () => {
    expect(src).not.toBeNull()
    expect(game).toContain('inventory: itemSys.inventory.map(invRow),')
    expect(game).toContain('for (const it of s.inventory) itemSys.inventory.push(invRow(it))')
    expect(game).not.toMatch(/inventory\.map\(i => \(\{ type: i\.type, \.\.\.\(i\.on \? \{ on: true \} : \{\}\) \}\)\)/)
  })
  it('replayed: a plumb carried through a save / reload is still kept on death; sour water comes back sour; a radio keeps playing', () => {
    const invRow = new Function(`${src[0].replace('const invRow =', 'return')}`)()
    const saved = JSON.parse(JSON.stringify([{ type: 'plumb', tool: true }, { type: 'almond-water', sour: true }, { type: 'radio', on: true }, { type: 'bandage' }].map(invRow)))
    const restored = saved.map(invRow)
    expect(restored).toEqual([{ type: 'plumb', tool: true }, { type: 'almond-water', sour: true }, { type: 'radio', on: true }, { type: 'bandage' }])
    expect(resolveDeath({ level: 2, inventory: restored, selected: 0, maxHp: 100, deaths: 0 }).dropped).toBeNull()
    expect(invRow({ type: 'plumb' })).toEqual({ type: 'plumb', tool: true })        // a save from before the flag heals
  })
})

describe('DS-R4 / DS-R5 / FEEL-7: the resume and the fresh boot', () => {
  it('the resume restores the locked trays and records a visit only when the save carries none', () => {
    expect(resumeBody).toContain('vendLocked = resume.vendLocked === true')
    expect(resumeBody).toContain('if (!mem.get(level.index)?.visits) mem.arrive(level.index, r.spawnChunk ?? { cx: r.pcx, cy: r.pcy }, playT)')
    expect(resumeBody.indexOf('const r = applyResume(')).toBeLessThan(resumeBody.indexOf('mem.arrive('))
    expect(game).toMatch(/memory: mem\.export\(\), playT, deaths,[^\n]*\r?\n\s*vendLocked,/)
  })
  it('replayed: a v:1 save gets its visit, so a later return is not a first visit; a save with memory is not counted twice', () => {
    const run = (save) => {
      const mem = createLevelMemory()
      const r = applyResume(save, { mem, buildLevel: () => {}, applyPlayer: (s) => ({ x: s.x, y: s.y }), updateAt: () => {}, settlePlayer: () => {} })
      if (!mem.get(r.level)?.visits) mem.arrive(r.level, r.spawnChunk ?? { cx: r.pcx, cy: r.pcy }, 0)
      return { mem, r }
    }
    const v1 = run({ v: 1, level: 1, x: 33.5, y: 11.5 })
    v1.mem.leave(1, { x: 33.5, y: 11.5 }, { cx: 1, cy: 0 }, 10)
    expect(v1.mem.arrive(1, { cx: 1, cy: 0 }, 20).visits).toBe(2)                   // a return, not a first visit
    const withMem = run({ v: 1, level: 1, x: 33.5, y: 11.5, memory: { 1: { visits: 3, arrived: { cx: 1, cy: 0 } } } })
    expect(withMem.mem.get(1).visits).toBe(3)
  })
  it('the fresh boot settles the spawn out of any body it hugs', () => {
    expect(game).toMatch(/buildLevel\(mpClient \? 0 : 4\); mem\.arrive\(level\.index, spawnChunk, playT\)[^\n]*\r?\n\s*if \(getPref\('solidBodies'\)\) level\.solid\.settlePlayer\(player\)/)
  })
})

describe('FEEL-1 / FEEL-4: an arrival\'s delayed lines belong to that arrival', () => {
  it('travel and die bump arrivalGen once past their guards and schedule every line through later(); no bare showMessage timer is left in either', () => {
    expect(travelBody).toMatch(/transitioning = true\r?\n\s*arrivalGen\+\+/)
    expect(dieBody).toMatch(/transitioning = true\r?\n\s*arrivalGen\+\+/)
    for (const b of [travelBody, dieBody]) expect(b).not.toMatch(/setTimeout\(\(\) => showMessage/)
    expect((travelBody.match(/later\(/g) || []).length).toBe(7)                    // + the filing line and the anchored mercy line (origins, I5)
    expect((dieBody.match(/later\(/g) || []).length).toBe(3)                       // + the death decision's own line at 7800 ms (I9)
  })
  it('later() drops a line when a newer arrival has begun (replayed from game.js\'s own source)', () => {
    const src = game.match(/function later\(ms, text, prio\) \{[^\n]*\}/)[0]
    const timers = [], said = []
    const mk = new Function('setTimeout', 'showMessage', `let arrivalGen = 0; ${src}; return { later, next: () => arrivalGen++ }`)
    const g = mk((f, ms) => timers.push({ f, ms }), (t, p) => said.push([t, p]))
    g.next(); g.later(7500, 'you land a few rooms over. there is no way back up here.', 1)
    g.next(); g.later(2600, 'you wake beside the hole you fell through. something of you stayed down there.', 1)    // a death in between
    for (const t of timers.sort((a, b) => a.ms - b.ms)) t.f()
    expect(said).toEqual([['you wake beside the hole you fell through. something of you stayed down there.', 1]])
  })
  it('with followers placed, the first-visit hint gives its discovery slot to \'it followed you down.\'', () => {
    expect(travelBody).toContain('const followed = followers.length ? level.entitySys.inject(')
    expect(travelBody).toContain('if (level.cfg.exit?.hint && !followed) later(3800, level.cfg.exit.hint, PRIO.discovery)')
  })
})

describe('FEEL-2 / FEEL-3: the hit lines and the hound\'s tell land when they happen', () => {
  it('the hit, the jolt, the crawler and the first windup are urgent; \'it is close.\' is not said on the heels of \'it has seen you.\'', () => {
    expect(game).toContain("showMessage(th.dmgKind === 'arc' ? 'the current finds you.' : 'it has you.', PRIO.urgent)")
    expect(game).toContain("showMessage('something takes your ankles.', PRIO.urgent)")
    expect(game).toContain("if (!houndTold) { houndTold = true; showMessage('it gathers itself. push now.', PRIO.urgent) }")
    expect(game).toContain("if (tn.close && playT - lastSeenLine > 1.6) showMessage('it is close.', PRIO.combat)")
    expect(game).toContain("showMessage('it has seen you.', PRIO.combat)")                         // the level name / lift FIFO stays combat
  })
})

describe('FEEL-5: you wake facing the hole the line names', () => {
  it('die() prefers the exit in the chunk, then the nearest loaded hole, and only then any way', () => {
    expect(dieBody).toMatch(/const exit = level\.decor\.exitAt\(C\.cx, C\.cy\) \?\? nearestOf\(level\.decor\.getKind\('down'\), mid\.x, mid\.y\) \?\? level\.decor\.nearestWayAny\(mid\.x, mid\.y\)\?\.rec \?\? null/)
    const src = game.match(/function nearestOf\(list, x, y\) \{[\s\S]*?\n {2}\}/)[0]
    const nearestOf = new Function(`${src}; return nearestOf`)()
    const a = { x: 10, y: 0 }, b = { x: 3, y: 4 }
    expect(nearestOf([a, b], 0, 0)).toBe(b)
    expect(nearestOf([], 0, 0)).toBeNull()
  })
})

describe('FEEL-8: the block offers no map', () => {
  it('on Level ∅ the paper corner and the hint row\'s tab entry are hidden (its separator goes with it)', () => {
    expect(html).toContain('body[data-level="∅"] #map-tab, body[data-level="∅"] #hint .k-map { display: none; }')
    // (I10: the whistle sits after set down; the map's span still carries its own separator, so hiding it leaves no stray dot)
    expect(html).toContain('<span>x set down</span> · <span>c whistle</span><span class="k-map"> · tab map</span> · <span>1-6 slots</span>')
  })
})

describe('FEEL-9: holding W into a cabinet does not cancel the search', () => {
  it('the drawer is left on a real step (displacement), not on a held key', () => {
    expect(game).toMatch(/const x0 = player\.x, y0 = player\.y\r?\n\s*tryMove\(player\.x \+ mx \* mult2, player\.y \+ my \* mult2\)\r?\n\s*stepped = \(player\.x - x0\) \*\* 2 \+ \(player\.y - y0\) \*\* 2 > 1e-6/)
    expect(game).toContain("if (searchT > 0 && stepped) { searchT = 0; searchTarget = null; showMessage('you leave the drawer.', PRIO.interaction) }")
    expect(game).not.toMatch(/searchT > 0 && moved/)
  })
})

describe('SD-radioOn-dropped: only a carried radio widens the tesla\'s sight', () => {
  it('aiCtx.radioOn is the carried radio; the hum and the presence range keep the lure-inclusive radioOn', () => {
    expect(game).toContain('aiCtx.radioOn = itemSys.isRadioOn(); aiCtx.t = playT;')
    expect(game).toContain('const radioOn = itemSys.isRadioOn() || lureWithin(lures, player.x, player.y, 12)')
    expect(game).toContain('if (radioOn !== radioWasOn) { radioWasOn = radioOn; setRadio(radioOn) }')
    expect(game).toContain('const presenceRange = radioOn ? 400 : 4')
  })
})
