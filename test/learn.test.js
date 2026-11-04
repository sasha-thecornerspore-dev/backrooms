// M19, creatures that learn your habits (plan §4 row 6). Each floor counts how you got away from its hunts, by method: stillness (the
// hunt lost you while the file hid you), the run (it lost the line while you were not hidden), the ward (a push ended the hunt) and the
// flash (the polaroid did). A getaway is counted when the thing gives up (its search runs out, it comes apart in the light, or it falls
// beyond the gate) and the floor's memory keeps the counts for the rest of the run (levelmem, additive optional fields). After the third
// getaway by one method on a floor, every thing on that floor gains one refinement against it, through env.learn (entities.setLearn),
// which defaults off:
//   stillness  it waits longer where it lost you while you are hidden (x its loseTrack)
//   the run    when it loses the line it keeps your last heading a few cells further, a moment longer, and searches there
//   the ward   its reel before the turning opening is shorter (the opening and the dispel count are untouched)
//   the flash  the blind reel is shorter; a thing that runs from it (the smiler, the lurker) runs for less long
// A player who switches method escapes as before: each refinement reads only its own method's moment. With the seam off (no setLearn,
// or null) nothing is tagged, nothing is emitted and every trajectory is byte for byte the code before M19 (golden hashes below).
import { describe, it, expect } from 'vitest'
import { LEARN, LEARN_LINES, METHOD_OF, createLearning, learnsHere } from '../src/renderer/learn.js'
import { createLevelMemory, applyResume, ESCAPE_METHODS } from '../src/renderer/levelmem.js'
import { ESCAPE_KINDS, TURNING_S, letGo, createThreat } from '../src/renderer/hunt.js'
import { createEntitySystem } from '../src/renderer/entities.js'
import { VARIANT_SPEC, specFor } from '../src/renderer/variants.js'
import { SCRAPS } from '../src/renderer/scraps.js'
import { HF } from '../src/renderer/gfx-frame.js'
import { CHUNK_SIZE } from '../src/renderer/world.js'
import { run as harness, SCENARIOS } from './learn-harness.js'

const DT = 1 / 60
const N = CHUNK_SIZE
const quiet = { chunkEvictRadius: 3, entities: { enabled: false } }
const open = () => true
const mkGrid = (floor) => ({ floor, setPlayerChunk() {} })
const wallOf = (floor) => (wx, wy) => !floor(Math.floor(wx), Math.floor(wy))
function mkCtx(player, over = {}) {
  return { flashlight: false, sprinting: false, dark: false, fog: 16, radioOn: false, lures: [], t: 0, hf: HF, playerAngle: player.angle ?? 0, player, damage: 16,
    sightMul: 1, hidden: false, loseTrackMul: 1, noiseMul: 1, ...over }
}
function ent(x, y, variant = 'shade', over = {}) {
  return { id: over.id ?? 1, x, y, type: 'stalker', variant, state: 'idle', dir: 0, dirTimer: 99, stagger: 0, wardHits: 0, chunkCx: Math.floor(x / N), chunkCy: Math.floor(y / N), ...over }
}
// the refinement object entities.setLearn takes: counting alone (every table null), or with some of LEARN's tables on
const counting = () => ({ still: null, run: null, ward: null, flash: null })
const withTables = (...methods) => { const o = counting(); for (const m of methods) o[m] = LEARN[m]; return o }
function drive(sys, player, ctx, seconds, each = null) {
  const kinds = [], out = []
  const n = Math.round(seconds / DT)
  for (let i = 0; i < n; i++) {
    if (each) each(i, i * DT)
    sys.update(DT, player, Math.floor(player.x / N), Math.floor(player.y / N), ctx)
    const m = sys.drainEvents(out)
    for (let k = 0; k < m; k++) kinds.push(out[k].kind)
  }
  return kinds
}
// a shade at (5.5, 5.5) and you at (15.5, 5.5); a wall column at x = 10 that can be raised to break the line
function scene(learn, variant = 'shade') {
  const s = { wall: false }
  const floor = (ix) => !(s.wall && ix === 10)
  const player = { x: 15.5, y: 5.5, angle: Math.PI }
  const ctx = mkCtx(player)
  const sys = createEntitySystem(quiet, wallOf(floor), { grid: mkGrid(floor), obstacles: null })
  if (learn !== undefined) sys.setLearn(learn)
  const e = ent(5.5, 5.5, variant)
  sys.getEntities().push(e)
  return { s, player, ctx, sys, e }
}
// how long a hunt lasts once the line is gone: frames in 'hunt' after the wall goes up
function huntTail(learn, hidden) {
  const { s, player, ctx, sys, e } = scene(learn)
  drive(sys, player, ctx, 0.5)
  expect(e.ai).toBe('hunt')
  if (hidden) ctx.hidden = true; else s.wall = true
  let t = 0
  while (e.ai === 'hunt' && t < 20) { drive(sys, player, ctx, DT); t += DT }
  return t
}

// ── the tables ──────────────────────────────────────────────────────────────────────────────────────────────────────
describe('learn.js: the tables', () => {
  const VARIANTS = Object.keys(VARIANT_SPEC)
  it('the third getaway by one method teaches a floor; a brood that gives up together is one getaway', () => {
    expect(LEARN.after).toBe(3)
    expect(LEARN.merge).toBeGreaterThan(0)
    expect(Object.isFrozen(LEARN)).toBe(true)
  })
  it('one modest refinement per method, per variant where the variants differ; every key is a variant', () => {
    const keys = (o) => Object.keys(o).every((k) => VARIANTS.includes(k))
    expect(keys(LEARN.still)).toBe(true); expect(keys(LEARN.run.lead)).toBe(true); expect(keys(LEARN.ward)).toBe(true)
    expect(keys(LEARN.flash.reel)).toBe(true); expect(keys(LEARN.flash.head)).toBe(true)
    for (const v of Object.values(LEARN.still)) { expect(v).toBeGreaterThan(1); expect(v).toBeLessThanOrEqual(2) }       // waits longer, at most twice
    for (const v of Object.values(LEARN.run.lead)) { expect(v).toBeGreaterThan(0); expect(v).toBeLessThanOrEqual(4) }    // a few cells on
    expect(LEARN.run.extra).toBeGreaterThan(0); expect(LEARN.run.extra).toBeLessThan(specFor('shade').loseTrack)
    for (const v of [...Object.values(LEARN.ward), ...Object.values(LEARN.flash.reel)]) { expect(v).toBeGreaterThanOrEqual(0.5); expect(v).toBeLessThan(1) }
    for (const v of Object.values(LEARN.flash.head)) { expect(v).toBeGreaterThan(0); expect(v).toBeLessThan(3) }       // the run from the flash is 3 s
    expect(Object.keys(LEARN.flash.head).sort()).toEqual(['lurker', 'smiler'])                                          // the two that run from it
    // the watcher and the crawler never hunt: nothing to wait for or follow
    for (const v of ['watcher', 'crawler']) { expect(LEARN.still[v]).toBeUndefined(); expect(LEARN.run.lead[v]).toBeUndefined() }
  })
  it('the methods are levelmem\'s, the hunt\'s escape events name them, and learn maps each event back', () => {
    expect(ESCAPE_METHODS).toEqual(['still', 'ward', 'run', 'flash'])
    for (const m of ESCAPE_METHODS) { expect(ESCAPE_KINDS[m]).toBe(`escape-${m}`); expect(METHOD_OF[`escape-${m}`]).toBe(m) }
    expect(Object.keys(METHOD_OF)).toHaveLength(4)
  })
  it('one line per method, said once: lowercase, no exclamation, no digits, no number words, short, never an echo of the pages', () => {
    expect(Object.keys(LEARN_LINES)).toEqual(ESCAPE_METHODS)
    expect(LEARN_LINES.still).toBe('it has learned to wait.')
    const NUMBER_WORDS = /\b(zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|first|second|third|fourth|fifth|once|twice|thrice)\b/
    for (const l of Object.values(LEARN_LINES)) {
      expect(l).toBe(l.toLowerCase()); expect(l).not.toContain('!'); expect(l).not.toMatch(/\d/); expect(l).not.toMatch(NUMBER_WORDS)
      expect(l.length).toBeLessThanOrEqual(40); expect(l.startsWith('it has learned')).toBe(true); expect(l.endsWith('.')).toBe(true)
      for (const s of SCRAPS) expect(s).not.toContain(l.slice(0, -1))
    }
    expect(new Set(Object.values(LEARN_LINES)).size).toBe(4)
  })
  it('a floor learns alone, never in a room and never on the block', () => {
    expect(learnsHere({ room: false, block: false })).toBe(true)
    expect(learnsHere({ room: true, block: false })).toBe(false)
    expect(learnsHere({ room: false, block: true })).toBe(false)
  })
})

// ── levelmem: the counts, additive and optional in the save ─────────────────────────────────────────────────────────
describe('levelmem: the getaways each floor counts', () => {
  it('counts per floor and per method; an unknown method is not counted; a fresh floor reads zero', () => {
    const mem = createLevelMemory()
    expect(mem.escapesFor(2)).toEqual({ still: 0, ward: 0, run: 0, flash: 0 })
    expect(mem.get(2)).toBeNull()                                        // reading does not make a record
    expect(mem.noteEscape(2, 'still')).toBe(1); expect(mem.noteEscape(2, 'still')).toBe(2); expect(mem.noteEscape(2, 'ward')).toBe(1)
    expect(mem.noteEscape(3, 'run')).toBe(1)
    expect(mem.noteEscape(2, 'lure')).toBe(0); expect(mem.noteEscape(2, 'toString')).toBe(0)
    expect(mem.escapesFor(2)).toEqual({ still: 2, ward: 1, run: 0, flash: 0 })
    expect(mem.escapesFor(3)).toEqual({ still: 0, ward: 0, run: 1, flash: 0 })
    const c = mem.escapesFor(2); c.still = 50
    expect(mem.escapesFor(2).still).toBe(2)                              // a copy: the floor's own count is untouched
    for (let i = 0; i < 300; i++) mem.noteEscape(1, 'flash')
    expect(mem.escapesFor(1).flash).toBe(99)                             // capped
  })
  it('the save carries escapes only for a floor that counted one; export -> import is an identity', () => {
    const mem = createLevelMemory()
    mem.arrive(1, { cx: 0, cy: 0 }, 0); mem.arrive(2, { cx: 0, cy: 0 }, 5)
    mem.noteEscape(2, 'run'); mem.noteEscape(2, 'run'); mem.noteEscape(2, 'flash')
    const out = mem.export()
    expect('escapes' in out[1]).toBe(false)
    expect(out[2].escapes).toEqual({ still: 0, ward: 0, run: 2, flash: 1 })
    expect(JSON.parse(JSON.stringify(out))).toEqual(out)
    const back = createLevelMemory(); back.import(JSON.parse(JSON.stringify(out)))
    expect(back.export()).toEqual(out)
    expect(back.escapesFor(2)).toEqual({ still: 0, ward: 0, run: 2, flash: 1 })
  })
  it('a save from before M19 (no escapes anywhere) loads: every floor reads zero and exports as it came', () => {
    const old = { 2: { x: 30.5, y: 40.5, angle: 1, cx: 1, cy: 1, visits: 2, lastT: 90, arrived: { cx: 4, cy: -1 }, taken: ['1,1:0'], vended: [['3,3', 50, 1]], searched: ['c:9'], dropped: [] } }
    const mem = createLevelMemory()
    const r = applyResume({ v: 1, level: 2, x: 30.5, y: 40.5, memory: old, playT: 100 }, {
      mem, buildLevel() {}, applyPlayer: (s) => ({ x: s.x, y: s.y }), updateAt() {}, settlePlayer() {},
    })
    expect(r.level).toBe(2)
    expect(mem.escapesFor(2)).toEqual({ still: 0, ward: 0, run: 0, flash: 0 })
    expect(mem.export()).toEqual(old)
    expect('escapes' in mem.export()[2]).toBe(false)
  })
  it('garbage in the field falls back to zero, a floor of zeros keeps no field, the counts are floored and capped', () => {
    const mem = createLevelMemory()
    for (const bad of ['x', 5, null, [], { still: 'a', ward: -3, run: NaN, flash: Infinity }]) {
      expect(() => mem.import({ 1: { escapes: bad } })).not.toThrow()
      expect(mem.escapesFor(1)).toEqual({ still: 0, ward: 0, run: 0, flash: 0 })
      expect('escapes' in mem.export()[1]).toBe(false)
    }
    mem.import({ 1: { escapes: { still: 2.7, ward: 1e9, run: 1, flash: 0, lure: 7 } } })
    expect(mem.escapesFor(1)).toEqual({ still: 2, ward: 99, run: 1, flash: 0 })
    expect(mem.export()[1].escapes).toEqual({ still: 2, ward: 99, run: 1, flash: 0 })
  })
  it('the lessons said: per floor and method, saved only once one is said, garbage read as none', () => {
    const mem = createLevelMemory()
    expect(mem.toldOf(2, 'still')).toBe(false)
    expect(mem.get(2)).toBeNull()                                        // asking makes no record
    expect(mem.noteTold(2, 'lure')).toBe(false)
    expect(mem.get(2)).toBeNull()
    expect(mem.noteTold(2, 'still')).toBe(true); expect(mem.noteTold(2, 'still')).toBe(true)
    expect(mem.toldOf(2, 'still')).toBe(true); expect(mem.toldOf(2, 'run')).toBe(false); expect(mem.toldOf(3, 'still')).toBe(false)
    mem.arrive(1, { cx: 0, cy: 0 }, 0)
    const out = mem.export()
    expect('told' in out[1]).toBe(false)
    expect(out[2].told).toEqual(['still'])
    const back = createLevelMemory(); back.import(JSON.parse(JSON.stringify(out)))
    expect(back.export()).toEqual(out)
    expect(back.toldOf(2, 'still')).toBe(true)
    for (const bad of ['x', 5, null, {}, [7, 'lure', null]]) {
      expect(() => mem.import({ 1: { told: bad } })).not.toThrow()
      expect(mem.toldOf(1, 'still')).toBe(false)
      expect('told' in mem.export()[1]).toBe(false)
    }
    mem.import({ 1: { told: ['run', 'lure', 'run', 'flash'] } })
    expect(mem.export()[1].told).toEqual(['run', 'flash'])
  })
})

// ── createLearning: counting, the third, the line once, the reused refinement object ────────────────────────────────
describe('createLearning', () => {
  it('the third getaway by one method turns its table on for that floor and says its line once; the fourth says nothing', () => {
    const mem = createLevelMemory(), L = createLearning({ mem })
    const R = L.refinements(2)
    expect(R).toEqual(counting())
    expect(L.escape(2, 'escape-still', 10)).toBeNull()
    expect(L.escape(2, 'escape-still', 40)).toBeNull()
    expect(R.still).toBeNull()
    expect(L.escape(2, 'escape-still', 70)).toBe('it has learned to wait.')
    expect(R.still).toBe(LEARN.still)                                    // the one object the entity system holds sees it at once
    expect(R.ward).toBeNull(); expect(R.run).toBeNull(); expect(R.flash).toBeNull()
    expect(L.escape(2, 'escape-still', 100)).toBeNull()
    expect(mem.escapesFor(2).still).toBe(4)
    expect(L.refinements(2)).toBe(R)                                     // reused, never rebuilt
  })
  it('each method on its own count; each floor its own; a brood that gives up together counts once', () => {
    const mem = createLevelMemory(), L = createLearning({ mem })
    L.refinements(1)
    for (const t of [0, 5, 19.9]) L.escape(1, 'escape-ward', t)          // inside the merge window of the first: one getaway
    expect(mem.escapesFor(1).ward).toBe(1)
    L.escape(1, 'escape-run', 6)                                         // another method in the window is its own
    expect(mem.escapesFor(1)).toEqual({ still: 0, ward: 1, run: 1, flash: 0 })
    L.escape(1, 'escape-ward', 21); L.escape(1, 'escape-ward', 30)       // 21 is past the window from 0; 30 is within it of 21
    expect(mem.escapesFor(1).ward).toBe(2)
    expect(L.escape(1, 'escape-ward', 50)).toBe(LEARN_LINES.ward)
    L.escape(3, 'escape-ward', 51)                                       // another floor's count is its own (and its window)
    expect(mem.escapesFor(3).ward).toBe(1)
    expect(L.refinements(3).ward).toBeNull()                             // the same object, now for floor 3
    expect(L.refinements(1).ward).toBe(LEARN.ward)
  })
  it('a getaway counted on another floor than the one asked for does not touch the refinements handed out', () => {
    const mem = createLevelMemory(), L = createLearning({ mem })
    for (const t of [0, 30]) L.escape(2, 'escape-flash', t)
    const R = L.refinements(1)
    expect(L.escape(2, 'escape-flash', 60)).toBe(LEARN_LINES.flash)
    expect(R.flash).toBeNull()
    expect(L.refinements(2).flash).toBe(LEARN.flash)
  })
  it('anything that is not an escape event is not counted', () => {
    const mem = createLevelMemory(), L = createLearning({ mem })
    for (const k of ['lost', 'seen', 'escape-lure', '', undefined]) expect(L.escape(1, k, 0)).toBeNull()
    expect(mem.get(1)).toBeNull()
  })
  it('a resumed run keeps what each floor learned, and never says it again', () => {
    const mem = createLevelMemory(), L = createLearning({ mem })
    L.refinements(2)
    for (const t of [0, 30, 60]) L.escape(2, 'escape-run', t)
    expect(L.said(2, LEARN_LINES.run)).toBe(true)
    const back = createLevelMemory(); back.import(JSON.parse(JSON.stringify(mem.export())))
    const L2 = createLearning({ mem: back })
    expect(L2.refinements(2).run).toBe(LEARN.run)
    expect(L2.unsaid(2)).toBeNull()
    expect(L2.escape(2, 'escape-run', 200)).toBeNull()
  })
  it('a lesson learned and not yet said waits for its floor until it is said, through a death, a travel and a quit', () => {
    const mem = createLevelMemory(), L = createLearning({ mem })
    L.refinements(2)
    expect(L.unsaid(2)).toBeNull()
    for (const t of [0, 30]) L.escape(2, 'escape-still', t)
    expect(L.unsaid(2)).toBeNull()                                       // not learned yet: nothing to say
    expect(L.escape(2, 'escape-still', 60)).toBe(LEARN_LINES.still)
    expect(L.unsaid(2)).toBe(LEARN_LINES.still)                          // learned, not said: offered again
    expect(L.unsaid(2)).toBe(LEARN_LINES.still)                          // asking says nothing
    expect(L.unsaid(1)).toBeNull()                                       // another floor's lesson is not this one's
    L.refinements(1)                                                     // you travel up: not said there
    expect(L.unsaid(1)).toBeNull(); expect(L.unsaid(2)).toBeNull()
    L.refinements(2)                                                     // and back: still waiting
    expect(L.unsaid(2)).toBe(LEARN_LINES.still)
    // a quit before it is said: the resume offers it, once
    const back = createLevelMemory(); back.import(JSON.parse(JSON.stringify(mem.export())))
    const L2 = createLearning({ mem: back })
    L2.refinements(2)
    expect(L2.unsaid(2)).toBe(LEARN_LINES.still)
    expect(L2.said(2, 'a murmur.')).toBe(false)                          // not a lesson: nothing marked
    expect(L2.unsaid(2)).toBe(LEARN_LINES.still)
    expect(L2.said(2, LEARN_LINES.still)).toBe(true)
    expect(L2.unsaid(2)).toBeNull()
    expect(back.toldOf(2, 'still')).toBe(true)
    // two learned and not said: offered one after the other
    for (const t of [100, 130, 160]) L2.escape(2, 'escape-flash', t)
    for (const t of [101, 131, 161]) L2.escape(2, 'escape-ward', t)
    expect(L2.unsaid(2)).toBe(LEARN_LINES.ward)                          // (the methods' order: still, ward, run, flash)
    L2.said(2, LEARN_LINES.ward)
    expect(L2.unsaid(2)).toBe(LEARN_LINES.flash)
    L2.said(2, LEARN_LINES.flash)
    expect(L2.unsaid(2)).toBeNull()
  })
  it('unsaid is a read (game.js asks it every frame once an arrival settles): the same answer every ask, nothing written', () => {
    const mem = createLevelMemory(), L = createLearning({ mem })
    L.refinements(3)
    for (const t of [0, 30, 60]) L.escape(3, 'escape-ward', t)
    const before = JSON.stringify(mem.export())
    for (let i = 0; i < 1000; i++) expect(L.unsaid(3)).toBe(LEARN_LINES.ward)
    expect(L.unsaid(4)).toBeNull()
    expect(JSON.stringify(mem.export())).toBe(before)
  })
})

// ── the seam, off and on, on a fake grid ────────────────────────────────────────────────────────────────────────────
describe('hunt.js / entities.js: with the seam off nothing is tagged or said', () => {
  it('no setLearn, or setLearn(null): no lrn field, no escape event, through a hunt, a ward, a search and a give-up', () => {
    for (const learn of [undefined, null]) {
      const { s, player, ctx, sys, e } = scene(learn)
      let kinds = drive(sys, player, ctx, 0.5)
      s.wall = true
      kinds = kinds.concat(drive(sys, player, ctx, 20))
      e.ai = 'hunt'; e.x = 14.5; s.wall = false
      sys.ward(player)
      kinds = kinds.concat(drive(sys, player, ctx, 20, (i) => { if (i === 30) { player.x = 60.5; player.y = 60.5 } }))
      expect(kinds.filter((k) => k.startsWith('escape-'))).toEqual([])
      expect('lrn' in e).toBe(false); expect('lrnHead' in e).toBe(false); expect('lrnLed' in e).toBe(false)
    }
  })
})

describe('the getaways the hunt tells apart (counting on, no refinement yet)', () => {
  it('stillness: the hunt loses you while the file hides you, the search runs out -> escape-still', () => {
    const { player, ctx, sys, e } = scene(counting())
    drive(sys, player, ctx, 0.5)
    ctx.hidden = true
    const kinds = drive(sys, player, ctx, 25)
    expect(e.ai).toBe('roam')
    expect(kinds.filter((k) => k.startsWith('escape-'))).toEqual(['escape-still'])
  })
  it('the run: the line breaks while you are not hidden -> escape-run when it gives up', () => {
    const { s, player, ctx, sys, e } = scene(counting())
    drive(sys, player, ctx, 0.5)
    s.wall = true
    const kinds = drive(sys, player, ctx, 25)
    expect(e.ai).toBe('roam')
    expect(kinds.filter((k) => k.startsWith('escape-'))).toEqual(['escape-run'])
  })
  it('the ward: it reels, turns, searches where you were and finds nothing -> escape-ward; a ward that dispels a hunter is one at once', () => {
    const { player, ctx, sys, e } = scene(counting())
    drive(sys, player, ctx, 0.5)
    e.x = 14.2; e.y = 5.5
    expect(sys.ward(player).hit).toBe(1)
    let kinds = drive(sys, player, ctx, 2.2)
    player.x = 60.5; player.y = 60.5                                     // you are long gone when it turns
    kinds = kinds.concat(drive(sys, player, ctx, 20))
    expect(e.ai).toBe('roam')
    expect(kinds.filter((k) => k.startsWith('escape-'))).toEqual(['escape-ward'])
    const b = scene(counting(), 'watcher')                               // dispelAt 1: one push takes it apart
    b.e.ai = 'shadow'; b.e.x = 14.2
    const res = b.sys.ward(b.player)
    expect(res.dispelled).toBe(1)
    const out = []; b.sys.update(DT, b.player, 0, 0, b.ctx); b.sys.drainEvents(out)
    expect(out.map((ev) => ev.kind)).toEqual(['watcher-dispelled'])      // a watcher shadowing you was never hunting: not a getaway
    const c = scene(counting(), 'hound')                                 // dispelAt 2
    c.e.ai = 'hunt'; c.e.x = 14.2; c.e.wardHits = 1
    expect(c.sys.ward(c.player).dispelled).toBe(1)
    c.sys.update(DT, c.player, 0, 0, c.ctx); c.sys.drainEvents(out)
    expect(out.map((ev) => ev.kind)).toEqual(['escape-ward'])
  })
  it('the flash: it reels blind (or runs), searches, gives up -> escape-flash', () => {
    for (const v of ['shade', 'smiler']) {
      const { player, ctx, sys, e } = scene(counting(), v)
      drive(sys, player, ctx, 0.5)
      e.x = 12.5; e.y = 5.5
      player.angle = Math.PI
      expect(sys.flash(player).hit).toBe(1)
      let kinds = drive(sys, player, ctx, 0.5)
      player.x = 60.5; player.y = 60.5
      kinds = kinds.concat(drive(sys, player, ctx, 22))
      expect(e.ai, v).toBe('roam')
      expect(kinds.filter((k) => k.startsWith('escape-')), v).toEqual(['escape-flash'])
    }
  })
  it('not a getaway: a ward on a thing that was not hunting you; a search that finds you again; the lurker sent off by your light', () => {
    const a = scene(counting())
    a.e.ai = 'roam'; a.e.x = 14.2; a.player.x = 15.5
    a.ctx.hidden = true                                                  // it never sees you
    a.sys.ward(a.player)
    a.player.x = 60.5; a.player.y = 60.5
    expect(drive(a.sys, a.player, a.ctx, 20).filter((k) => k.startsWith('escape-'))).toEqual([])
    const b = scene(counting())
    drive(b.sys, b.player, b.ctx, 0.5)
    b.s.wall = true
    drive(b.sys, b.player, b.ctx, 4.5)
    expect(b.e.ai).toBe('search')
    b.s.wall = false                                                     // the search finds you: the hunt goes on, nothing was got away from
    let kinds = drive(b.sys, b.player, b.ctx, 1)
    expect(b.e.ai).toBe('hunt')
    expect(kinds.filter((k) => k.startsWith('escape-'))).toEqual([])
    const c = scene(counting(), 'lurker')
    c.ctx.dark = true; c.ctx.flashlight = true
    c.player.angle = Math.PI                                             // facing it: the beam holds it until it goes
    kinds = drive(c.sys, c.player, c.ctx, 1.5)
    c.e.x = 8.5
    kinds = kinds.concat(drive(c.sys, c.player, c.ctx, 3))
    c.player.x = 60.5; c.player.y = 60.5
    kinds = kinds.concat(drive(c.sys, c.player, c.ctx, 20))
    expect(kinds).toContain('lurker-hunt')
    expect(kinds.filter((k) => k.startsWith('escape-'))).toEqual([])
  })
  it('not a getaway: a crawler\'s grab (its lunge is its one rule, not a hunt), whatever comes after it', () => {
    const none = (kinds) => kinds.filter((k) => k.startsWith('escape-'))
    // you stand beside it in the dark: it takes your ankles, draws off and lies still; then you walk off beyond the gate
    const a = scene(counting(), 'crawler')
    a.e.x = 13.5; a.ctx.dark = true
    let kinds = drive(a.sys, a.player, a.ctx, 6)
    expect(kinds).toContain('crawler')
    expect(a.e.ai).toBe('still')
    expect('lrn' in a.e).toBe(false)                                     // never tagged as hunting you
    a.player.x = 5.5 + 5 * N
    kinds = kinds.concat(drive(a.sys, a.player, a.ctx, 1))
    expect(a.e.ai).toBe('roam')
    expect(none(kinds)).toEqual([])
    // a ward that takes it apart mid-grab (dispelAt 2), and one that only sends it reeling, then the gate
    const b = scene(counting(), 'crawler')
    b.e.ai = 'lunge'; b.e.x = 14.2; b.e.wardHits = 1
    expect(b.sys.ward(b.player).dispelled).toBe(1)
    expect(none(drive(b.sys, b.player, b.ctx, DT))).toEqual([])
    const c = scene(counting(), 'crawler')
    c.e.ai = 'lunge'; c.e.x = 14.2
    expect(c.sys.ward(c.player).hit).toBe(1)
    kinds = drive(c.sys, c.player, c.ctx, 3)
    c.player.x = 5.5 + 5 * N
    kinds = kinds.concat(drive(c.sys, c.player, c.ctx, 1))
    expect(none(kinds)).toEqual([])
    expect('lrn' in c.e).toBe(false)
    // a flash mid-grab, then the gate
    const f = scene(counting(), 'crawler')
    f.e.ai = 'lunge'; f.e.x = 12.5; f.player.angle = Math.PI
    expect(f.sys.flash(f.player).hit).toBe(1)
    kinds = drive(f.sys, f.player, f.ctx, 3)
    f.player.x = 5.5 + 5 * N
    kinds = kinds.concat(drive(f.sys, f.player, f.ctx, 1))
    expect(none(kinds)).toEqual([])
    expect('lrn' in f.e).toBe(false)
  })
  it('a hunter left behind beyond the gate (three chunks) is a getaway by the run', () => {
    const { player, ctx, sys, e } = scene(counting())
    drive(sys, player, ctx, 0.5)
    expect(e.ai).toBe('hunt')
    player.x = 5.5 + 5 * N; player.y = 5.5                               // five chunks off: it only wanders now
    const kinds = drive(sys, player, ctx, DT * 2)
    expect(e.ai).toBe('roam')
    expect(kinds).toEqual(['escape-run'])
  })
  it('letGo emits the method a thing carries, once, and clears it; a hunt or nothing emits nothing', () => {
    const th = createThreat()
    const e = { id: 7, x: 1, y: 2, variant: 'hound', lrn: 'flash' }
    letGo(e, th, 3); letGo(e, th, 3)
    expect(th.events.map((ev) => [ev.kind, ev.id, ev.variant, ev.d])).toEqual([['escape-flash', 7, 'hound', 3]])
    expect(e.lrn).toBe('')
    for (const lrn of ['hunt', '', 'lure']) { e.lrn = lrn; letGo(e, th, 0) }
    expect(th.events).toHaveLength(1)
  })
})

describe('the refinements, each against its own method only', () => {
  it('stillness: while you are hidden it waits where it lost you x LEARN.still; not hidden, or untaught, it lets go as before', () => {
    const base = specFor('shade').loseTrack
    const off = huntTail(counting(), true), on = huntTail(withTables('still'), true)
    expect(off).toBeGreaterThanOrEqual(base); expect(off).toBeLessThan(base + 0.2)   // (it reads you hidden on its next look: <= 0.17 s)
    expect(on - off).toBeCloseTo(base * (LEARN.still.shade - 1), 1)
    expect(huntTail(withTables('still'), false)).toBeCloseTo(huntTail(counting(), false), 9)   // you ran instead: as before
  })
  it('the run: it keeps your last heading a few cells on, a moment longer, then searches there; hidden, it does not', () => {
    const go = (learn, hidden) => {
      const { s, player, ctx, sys, e } = scene(learn)
      drive(sys, player, ctx, 1, () => { player.x += 2 * DT })           // you were heading +x when it last saw you
      const lx = player.x
      s.wall = true
      if (hidden) ctx.hidden = true
      let t = 0
      while (e.ai === 'hunt' && t < 20) { drive(sys, player, ctx, DT); t += DT }
      return { t, e, lx }
    }
    const off = go(counting(), false), on = go(withTables('run'), false)
    expect(off.e.tx).toBeLessThan(off.lx + 0.2)
    expect(on.e.lastSeenX).toBeCloseTo(off.e.lastSeenX + LEARN.run.lead.shade, 1)
    expect(Math.abs(on.e.lastSeenY - off.e.lastSeenY)).toBeLessThan(0.05)
    expect(on.e.ai).toBe('search'); expect(on.e.tx).toBeCloseTo(on.e.lastSeenX, 6)   // it searches where your heading led
    expect(on.t).toBeCloseTo(off.t + LEARN.run.extra, 1)
    const hid = go(withTables('run'), true)                              // you stood still and hid: the stillness getaway, as before
    expect(hid.e.lastSeenX).toBeCloseTo(go(counting(), true).e.lastSeenX, 9)
    expect(hid.t).toBeCloseTo(go(counting(), true).t, 6)
  })
  it('the run: a wall right ahead of your heading leaves it where it lost you', () => {
    const s = { wall: false }
    const floor = (ix) => !(s.wall && ix === 10) && ix < 17
    const player = { x: 15.5, y: 5.5, angle: Math.PI }
    const ctx = mkCtx(player)
    const sys = createEntitySystem(quiet, wallOf(floor), { grid: mkGrid(floor), obstacles: null })
    sys.setLearn(withTables('run'))
    const e = ent(5.5, 5.5)
    sys.getEntities().push(e)
    drive(sys, player, ctx, 0.5, () => { player.x = Math.min(16.4, player.x + 2 * DT) })
    s.wall = true
    drive(sys, player, ctx, 4)                                           // (a lead would hold the hunt to ~5.2 s)
    expect(e.ai).toBe('search')                                          // no room ahead: searched at once, as before
    expect(e.tx).toBeLessThan(17)
  })
  it('the ward: the reel before the opening is shorter; the opening is the same 0.8 s', () => {
    for (const v of ['shade', 'hound', 'tesla']) {
      const { player, ctx, sys, e } = scene(withTables('ward'), v)
      e.ai = 'hunt'; e.x = 14.2
      sys.ward(player)
      const T = specFor(v).staggerT
      expect(e.stagger, v).toBeCloseTo(TURNING_S + (T - TURNING_S) * LEARN.ward[v], 9)
      const u = scene(counting(), v)
      u.e.ai = 'hunt'; u.e.x = 14.2
      u.sys.ward(u.player)
      expect(u.e.stagger, v).toBe(T)
      let turnT = null
      drive(sys, player, ctx, 3, () => { if (turnT === null && e.ai === 'turning') turnT = e.turnT })
      expect(turnT, v).toBeCloseTo(TURNING_S, 9)
    }
  })
  it('the ward: the opening still counts double and the dispel count is untouched', () => {
    const { player, sys, e } = scene(withTables('ward'))
    e.ai = 'turning'; e.x = 14.2
    const res = sys.ward(player)
    expect(res.opening).toBe(1); expect(e.wardHits).toBe(2)
  })
  it('the flash: a shorter blind reel; the smiler and the lurker run from it for less long', () => {
    const { player, sys, e } = scene(withTables('flash'))
    e.ai = 'hunt'; e.x = 12.5; player.angle = Math.PI
    sys.flash(player)
    expect(e.stagger).toBeCloseTo(1.8 * LEARN.flash.reel.shade, 9)
    for (const v of ['smiler', 'lurker']) {
      const a = scene(withTables('flash'), v), b = scene(counting(), v)
      for (const x of [a, b]) { x.e.ai = 'hunt'; x.e.x = 12.5; x.player.angle = Math.PI; x.sys.flash(x.player) }
      expect(a.e.ai).toBe('retreat'); expect(a.e.phaseT).toBe(LEARN.flash.head[v]); expect(b.e.phaseT).toBe(0)
      const ranFor = (x) => { let t = 0; while (x.e.ai === 'retreat' && t < 10) { drive(x.sys, x.player, x.ctx, DT); t += DT } return t }
      expect(ranFor(a), v).toBeCloseTo(ranFor(b) - LEARN.flash.head[v], 1)
    }
  })
})

// ── identity: the harness's scripted runs, hashed frame by frame ────────────────────────────────────────────────────
// Taken from test/learn-harness.js on the code before M19 (pulse/2.0.4 at 36ac9a4). Any change to the hunt with the seam off turns
// these red; so does a refinement that leaks into another method's getaway.
const GOLDEN = Object.freeze({
  run: '45a77f97d4d9877e',
  still: '0c0e83150801caaa',
  ward: '94d096e50f1469ec',
  flash: '827b15a01fda727d',
  mixed: '1415d5fa01265631',
})

describe('identity: each new parameter off is byte for byte the hunt before M19', () => {
  it('the scenarios are the five the golden hashes were taken on', () => {
    expect([...SCENARIOS]).toEqual(Object.keys(GOLDEN))
  })
  for (const name of Object.keys(GOLDEN)) {
    it(`${name}: no setLearn, setLearn(null), and counting alone (its escape events aside) all hash to the golden`, () => {
      expect(harness(name).hash).toBe(GOLDEN[name])
      expect(harness(name, { learn: null }).hash).toBe(GOLDEN[name])
      expect(harness(name, { learn: counting() }).hash).toBe(GOLDEN[name])
    })
  }
  it('counting alone sees the getaway each script is about', () => {
    expect(harness('run', { learn: counting() }).kinds['escape-run']).toBeGreaterThan(0)
    expect(harness('still', { learn: counting() }).kinds['escape-still']).toBeGreaterThan(0)
    expect(harness('ward', { learn: counting() }).kinds['escape-ward']).toBeGreaterThan(0)
    expect(harness('flash', { learn: counting() }).kinds['escape-flash']).toBeGreaterThan(0)
    for (const name of ['run', 'still', 'ward', 'flash']) expect(harness(name).kinds['escape-run'] ?? 0).toBe(0)
  })
})

describe('identity: a player who switches method escapes as before', () => {
  // where a method's moment never comes, its refinement changes nothing at all
  const CLEAN = { still: ['run', 'ward', 'flash'], ward: ['run', 'still', 'flash'], flash: ['run', 'still', 'ward'], run: ['still'] }
  for (const [m, names] of Object.entries(CLEAN)) {
    it(`taught against ${m}: ${names.join(', ')} hash to the golden`, () => {
      for (const name of names) expect(harness(name, { learn: withTables(m) }).hash, name).toBe(GOLDEN[name])
    })
  }
  it('and each refinement does act where its own method is used', () => {
    for (const m of ['still', 'ward', 'flash', 'run']) expect(harness(m, { learn: withTables(m) }).hash, m).not.toBe(GOLDEN[m])
  })
})
