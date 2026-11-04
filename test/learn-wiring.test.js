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
  it('the escape events are answered in onEntityEvent, once, with a discovery plate of kind learn', () => {
    const body = game.slice(at('function onEntityEvent(ev)'), at('// Flicker state (persists'))
    expect(body).toContain(lift(CASE))
    expect(lift(CASE)).toBe("case 'escape-still': case 'escape-ward': case 'escape-run': case 'escape-flash': { const l = learning.escape(level.index, ev.kind, playT); if (l) plate('learn', l, PRIO.discovery) } break")
    expect(count(/learning\.escape\(/g)).toBe(1)
    expect(count(/plate\('learn'/g)).toBe(1)
    for (const k of Object.values(ESCAPE_KINDS)) expect(lift(CASE)).toContain(`case '${k}':`)
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
function rig({ map = null } = {}) {
  const said = []
  let now = 0
  const plates = createPlateBudget()
  const mem = createLevelMemory()
  const learning = createLearning({ mem })
  const level = { index: 2, cfg: { map } }
  const show = (t, p) => said.push([now, t, p])
  const h = new Function('plates', 'showMessage', 'level', 'msgQ', 'PRIO', 'learning',
    `let playT = 0\n${lift(PLATE)}\n` +
    `function onEsc(ev) { switch (ev.kind) { ${lift(CASE)} } }\n` +
    'function drainFrame() { const held = plates.drain(playT); if (held) showMessage(held, PRIO.discovery) }\n' +
    'return { plate, onEsc, drainFrame, set: (t) => { playT = t } }')(plates, show, level, { idle: () => true }, PRIO, learning)
  const run = (to, events = {}) => {
    for (; now <= to + 1e-9; now = Math.round((now + 0.1) * 10) / 10) {
      h.set(now)
      if (events[now]) events[now]()
      h.drainFrame()
    }
  }
  const esc = (m) => () => h.onEsc({ kind: ESCAPE_KINDS[m], id: 1, x: 0, y: 0, d: 3, variant: 'shade' })
  return { h, said, run, esc, plates, mem, learning }
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
