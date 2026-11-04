// M19 wiring (learn.js): game.js makes ONE learning over the run's floor memory, hands each floor's entity system its refinements at
// buildLevel (null in a room and on the block: nothing is tagged, said or changed there), and answers a thing's escape event by counting
// the getaway; the third by one method on a floor says that method's line once, as a discovery plate of its own kind ('learn') through
// the plate budget. With the creatures setting off the things are not updated, warded or flashed at all, so no escape event comes. These
// are source guards plus the pieces lifted out of game.js and replayed against the real plates.js, learn.js and levelmem.js.
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import { createPlateBudget, UNPROMPTED_KINDS, DRAIN_S } from '../src/renderer/plates.js'
import { createLearning, learnsHere, LEARN, LEARN_LINES } from '../src/renderer/learn.js'
import { createLevelMemory } from '../src/renderer/levelmem.js'
import { ESCAPE_KINDS } from '../src/renderer/hunt.js'
import { PRIO } from '../src/renderer/messages.js'

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8')
const game = read('../src/renderer/game.js')
const sw = read('../src/sw.js')
const build = read('../tools/build-play.sh')
const at = (s, from = 0) => { const k = game.indexOf(s, from); expect(k, s).toBeGreaterThan(0); return k }
const count = (re) => (game.match(re) || []).length
const lift = (re) => { const m = game.match(re); expect(m, String(re)).not.toBeNull(); return m[0] }
const loopAt = game.indexOf('function loop(ts) {')
const PLATE = /function plate\(kind, text, prio, keep = true\) \{[\s\S]*?\r?\n {2}\}/
const CASE = /case 'escape-still': case 'escape-ward': case 'escape-run': case 'escape-flash': \{[^\n]*\} break/
// a lesson the floor learned and has not said (learn.js unsaid), offered again each frame once an arrival has settled
const OFFER = /if \(creaturesOn && !transitioning && plates\.settled\(playT\)\) \{[^\n]*\}/
const SET = /entitySys\.setLearn\([^\n]*\)/

describe('game.js: one learning over the floors\' memory', () => {
  it('imports createLearning and learnsHere by their real names; learn.js is in both offline shells', () => {
    expect(game).toMatch(/import \{ createLearning, learnsHere \} from '\.\/learn\.js'/)
    expect(sw).toContain("'/renderer/learn.js'")
    expect(build).toContain("'learn.js'")
  })
  it('one learning, made over the one memory before the loop, never in a frame', () => {
    expect(count(/createLearning\(/g)).toBe(1)
    const made = at('const learning = createLearning({ mem })')
    expect(made).toBeGreaterThan(at('const mem = createLevelMemory()'))
    expect(made).toBeLessThan(loopAt)
  })
  it('buildLevel hands the new floor\'s things its refinements right after making them: null in a room and on the block', () => {
    const build = game.slice(at('function buildLevel(index, at = null) {'), at('const fader = createFader('))
    expect(count(/\.setLearn\(/g)).toBe(1)
    expect(lift(SET)).toBe('entitySys.setLearn(learnsHere({ room: !!mpClient, block: !!cfg.map }) ? learning.refinements(index) : null)')
    const made = build.indexOf('const entitySys = createEntitySystem(cfg, isWall, { obstacles: solid.forEntities, grid, now: () => playT, seed: worldSeed })')
    const set = build.indexOf('entitySys.setLearn(')
    expect(made).toBeGreaterThan(0); expect(set).toBeGreaterThan(made); expect(set).toBeLessThan(build.indexOf('const gfx       = makeGfx(cfg, cache)'))
    // replayed: alone on a hunted floor the refinements, in a room or on the block nothing
    const R = { the: 'refinements' }
    const run = (mpClient, cfg) => { let got; new Function('entitySys', 'learnsHere', 'mpClient', 'cfg', 'learning', 'index', lift(SET))(
      { setLearn: (r) => { got = r } }, learnsHere, mpClient, cfg, { refinements: (i) => (i === 2 ? R : null) }, 2); return got }
    expect(run(null, { map: null })).toBe(R)
    expect(run({ id: 'x' }, { map: null })).toBeNull()
    expect(run(null, { map: [[1]] })).toBeNull()
  })
  it('the escape events are answered in onEntityEvent, once, with a discovery plate of kind learn, marked said only when it shows', () => {
    const body = game.slice(at('function onEntityEvent(ev)'), at('// Flicker state (persists'))
    expect(body).toContain(lift(CASE))
    expect(lift(CASE)).toBe("case 'escape-still': case 'escape-ward': case 'escape-run': case 'escape-flash': { const l = learning.escape(level.index, ev.kind, playT); if (l && plate('learn', l, PRIO.discovery, false)) learning.said(level.index, l) } break")
    expect(count(/learning\.escape\(/g)).toBe(1)
    expect(count(/plate\('learn'/g)).toBe(2)                              // the getaway's, and the frame's offer of one not yet said
    for (const k of Object.values(ESCAPE_KINDS)) expect(lift(CASE)).toContain(`case '${k}':`)
  })
  it('a lesson not yet said is offered again in the frame, beside the budget\'s drain, once an arrival has settled: never under a fade or with the things off', () => {
    expect(lift(OFFER)).toBe("if (creaturesOn && !transitioning && plates.settled(playT)) { const u = learning.unsaid(level.index); if (u !== null && plate('learn', u, PRIO.discovery, false)) learning.said(level.index, u) }")
    expect(count(/learning\.unsaid\(/g)).toBe(1)
    expect(count(/learning\.said\(/g)).toBe(2)
    // just ahead of the drain (the slice the other harnesses lift, drain .. Living Atmosphere, is untouched): an older held line still
    // goes first, as the budget refuses any line while one waits
    const offer = at(lift(OFFER), loopAt), drain = at('const held = plates.drain(playT)', loopAt)
    expect(offer).toBeLessThan(drain)
    expect(game.slice(offer, drain).split('\n').length).toBeLessThanOrEqual(3)
    expect(offer).toBeGreaterThan(at("if (!hintHeld || murmur !== cfg.exit?.hint) plate('murmur', murmur, PRIO.ambient, false)", loopAt))
    expect(at("creaturesOn = getPref('creatures')", loopAt)).toBeLessThan(offer)   // read live at the top of the frame
  })
  it('the budget knows the kind: an unprompted line, held and counted like the others', () => {
    expect(UNPROMPTED_KINDS).toContain('learn')
  })
  it('with the creatures off nothing hunts, wards or flashes, so no escape event comes (the gates are the ones the things already have)', () => {
    expect(game).toContain('const th = creaturesOn ? level.entitySys.update(dt, player, pcx, pcy, aiCtx) : (level.entitySys.getThreat().reset(), level.entitySys.getThreat())')
    expect(game).toContain("const res = getPref('creatures') ? level.entitySys.ward(player, wardOpts(w.charged)) : EMPTY_WARD")
    expect(game).toContain("const b = getPref('creatures') ? level.entitySys.flash(player, FLASH_OPTS) : NO_FLASH")
    expect(game).toContain("const res = getPref('creatures') ? level.entitySys.ward(wardProbe, WARD_TAP) : EMPTY_WARD")
    expect((game.match(/entitySys\.(ward|flash)\(/g) || []).length).toBe(3)
  })
})

// the plate wrapper, the escape case and the frame's drain lifted out of game.js, on a play clock with the real budget, the real
// learning and the real floor memory; every line handed to showMessage is recorded with its time
function rig({ map = null, learns = true } = {}) {
  const said = []
  let now = 0
  const plates = createPlateBudget()
  const mem = createLevelMemory()
  const learning = createLearning({ mem })
  const level = { index: 2, cfg: { map } }
  if (learns) learning.refinements(level.index)                // buildLevel, alone and off the block (learnsHere): never in a room
  const show = (t, p) => said.push([now, t, p])
  const S = { creaturesOn: true, transitioning: false }
  const h = new Function('plates', 'showMessage', 'level', 'msgQ', 'PRIO', 'learning', 'S',
    `let playT = 0\n${lift(PLATE)}\n` +
    `function onEsc(ev) { switch (ev.kind) { ${lift(CASE)} } }\n` +
    `function drainFrame() { const { creaturesOn, transitioning } = S\n${lift(OFFER)}\nconst held = plates.drain(playT); if (held) showMessage(held, PRIO.discovery) }\n` +
    'return { plate, onEsc, drainFrame, set: (t) => { playT = t } }')(plates, show, level, { idle: () => true }, PRIO, learning, S)
  const run = (to, events = {}) => {
    for (; now <= to + 1e-9; now = Math.round((now + 0.1) * 10) / 10) {
      h.set(now)
      if (events[now]) events[now]()
      h.drainFrame()
    }
  }
  const esc = (m) => () => h.onEsc({ kind: ESCAPE_KINDS[m], id: 1, x: 0, y: 0, d: 3, variant: 'shade' })
  // a travel or a death: buildLevel hands the floor's things its refinements (learning.refinements), startVisit opens the window
  const arrive = (index) => { level.index = index; learning.refinements(index); plates.arrive(now) }
  return { h, said, run, esc, plates, mem, learning, level, S, arrive }
}

describe('replayed: the line once, inside the budget', () => {
  it('the third getaway inside an arrival\'s first 45 s waits: never a third budgeted plate in the window, said once it settles', () => {
    const { h, said, run, esc, plates, mem } = rig()
    plates.arrive(0)
    h.plate('floor', 'level two.', PRIO.combat)
    run(44.9, { 3.8: () => h.plate('arrival', 'the hint.', PRIO.discovery), 1: esc('still'), 21.5: esc('still'), 43: esc('still') })
    expect(mem.escapesFor(2).still).toBe(3)
    expect(said.filter((s) => s[0] < 45).map((s) => s[1])).toEqual(['level two.', 'the hint.'])   // the window's two
    run(80)
    expect(said.map((s) => s[1])).toEqual(['level two.', 'the hint.', LEARN_LINES.still])
    expect(said[2][0]).toBe(45); expect(said[2][2]).toBe(PRIO.discovery)
    run(200, { 100: esc('still'), 130: esc('still') })                    // taught already: said once a floor
    expect(said).toHaveLength(3)
  })
  it('past the window it is an unprompted line: one per 20 s, held behind an older one, and kept until its turn', () => {
    const { h, said, run, esc, plates } = rig()
    plates.arrive(0)
    run(100, { 50: esc('ward'), 75: esc('ward'), 90: () => h.plate('murmur', 'a murmur.', PRIO.ambient, false), 100: esc('ward') })
    expect(said.map((s) => [s[0], s[1]])).toEqual([[90, 'a murmur.']])
    run(130)
    expect(said.map((s) => [s[0], s[1]])).toEqual([[90, 'a murmur.'], [110, LEARN_LINES.ward]])
    expect(110 - 90).toBeGreaterThanOrEqual(20)
  })
  it('each method its own line on its own floor count; a brood that gives up together counts once', () => {
    const { said, run, esc, plates, mem } = rig()
    plates.arrive(-1000)
    run(300, { 10: esc('run'), 12: esc('run'), 40: esc('run'), 70: esc('flash'), 75: esc('run'), 100: esc('flash'), 130: esc('flash') })
    expect(mem.escapesFor(2)).toEqual({ still: 0, ward: 0, run: 3, flash: 3 })
    expect(said.map((s) => s[1])).toEqual([LEARN_LINES.run, LEARN_LINES.flash])
    expect(said[0][0]).toBe(75); expect(said[1][0]).toBe(130)
  })
  it('held, then a death on that floor before it is said: never lost, said once there when the next arrival settles', () => {
    const { h, said, run, esc, plates, mem, learning, arrive } = rig()
    learning.refinements(2); plates.arrive(0)
    h.plate('floor', 'level two.', PRIO.combat)
    run(100, { 3.8: () => h.plate('arrival', 'the hint.', PRIO.discovery), 50: esc('still'), 80: esc('still'),
      100: () => h.plate('murmur', 'a murmur.', PRIO.ambient, false) })
    run(115, { 110: esc('still') })                                     // the third, ten seconds after a murmur: it waits its gap
    expect(mem.escapesFor(2).still).toBe(3)
    expect(said.map((s) => s[1])).not.toContain(LEARN_LINES.still)
    run(600, { 115.1: () => { arrive(2); h.plate('floor', 'level two.', PRIO.combat) } })   // the next hunt has you: you wake on the floor
    expect(said.filter((s) => s[1] === LEARN_LINES.still)).toHaveLength(1)
    const when = said.find((s) => s[1] === LEARN_LINES.still)[0]
    expect(when).toBeGreaterThanOrEqual(115.1 + 45)                       // not in the wake's window: once it has settled
    expect(when).toBeLessThan(115.1 + 45 + 1)
    expect(mem.toldOf(2, 'still')).toBe(true)
    run(900, { 700: esc('still') })                                      // said: never again
    expect(said.filter((s) => s[1] === LEARN_LINES.still)).toHaveLength(1)
  })
  it('held, then a travel: not said on the floor you go to; said once when you are back on its own floor and that arrival settles', () => {
    const { h, said, run, esc, plates, learning, arrive, level } = rig()
    learning.refinements(2); plates.arrive(-1000)
    run(60, { 10: esc('ward'), 35: esc('ward'), 50: () => h.plate('murmur', 'a murmur.', PRIO.ambient, false), 55: esc('ward') })
    expect(said.map((s) => s[1])).toEqual(['a murmur.'])
    run(400, { 60.1: () => arrive(3) })                                  // down a hole, before its gap came
    expect(said.map((s) => s[1])).toEqual(['a murmur.'])
    run(600, { 400.1: () => arrive(2) })
    expect(level.index).toBe(2)
    expect(said.map((s) => [s[0], s[1]])).toEqual([[50, 'a murmur.'], [445.1, LEARN_LINES.ward]])
  })
  it('the offer waits out a fade and the things being off, and is never made in a room or on the block (nothing is filled there)', () => {
    const { said, run, esc, plates, mem, S } = rig()
    plates.arrive(0)
    run(44.9, { 1: () => plates.admit('arrival', 1, null), 2: () => plates.admit('arrival', 2, null), 0.5: esc('run'), 21: esc('run'), 42: esc('run') })
    expect(mem.escapesFor(2).run).toBe(3)
    S.creaturesOn = false                                                // learned inside the full window; the things off when it settles
    run(80)
    expect(said).toHaveLength(0)
    S.creaturesOn = true; S.transitioning = true
    run(90)
    expect(said).toHaveLength(0)
    S.transitioning = false
    run(91)
    expect(said.map((s) => [s[0], s[1]])).toEqual([[90.1, LEARN_LINES.run]])
    const r = rig({ learns: false })                                     // a room or the block: buildLevel never fills the learning
    r.plates.arrive(0)
    for (const t of [0, 30, 60]) r.learning.escape(2, ESCAPE_KINDS.flash, t)
    r.run(200)
    expect(r.said).toHaveLength(0)
  })
  it('the arrival budget the plan pins: at most two budgeted plates in the first 45 s however the getaways fall', () => {
    for (let k = 0; k < 40; k++) {
      const { h, said, run, esc, plates } = rig()
      plates.arrive(0)
      h.plate('floor', 'level two.', PRIO.combat)
      const ev = {}
      const methods = ['still', 'ward', 'run', 'flash']
      for (let j = 0; j < 12; j++) ev[Math.round(((k * 7 + j * 3.7) % 44) * 10) / 10] = esc(methods[(k + j) % 4])
      ev[3.8] = () => h.plate('arrival', 'the hint.', PRIO.discovery)
      run(44.9, ev)
      expect(said.length, `run ${k}`).toBeLessThanOrEqual(2)
    }
  })
})

describe('the tables the wiring reads', () => {
  it('the tuning is learn.js\'s, never game.js\'s', () => {
    expect(LEARN.after).toBe(3)
    expect(game).not.toMatch(/LEARN\./)
    for (const l of Object.values(LEARN_LINES)) expect(game).not.toContain(l)   // the lines live in learn.js
  })
})
