// The floor feelings, wired (feelings.js into game.js): buildLevel rolls the visit's feeling at the cfg stage (the world seed, the floor,
// the visit with this arrival counted; a room, the lobby's thread and the kill switch passed in) and lays the dark over the cfg before the
// world, the decor and the renderer are built; the passage marks drawers and turns chairs as each chunk comes in (this visit's search log,
// never levelmem's); the quiet spreads the events and the murmurs and lowers the hum, which every other floor glides home; the things see
// by the floor's own light. The line is one budgeted discovery plate, let go when the window is full: replayed here with the real plates.js
// and game.js's own plate(), later() and startVisit(), so the arrival budget (at most 2 plates in an arrival's first 45 s) still holds.
// game.js only boots in a page, so these are source guards plus the pieces lifted out of game.js and replayed against the real modules.
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import { FEEL, FEELINGS, feelingFor, NO_FEELING } from '../src/renderer/feelings.js'
import { createPlateBudget, arrivalPlate, DRAIN_S } from '../src/renderer/plates.js'
import { levelConfig } from '../src/renderer/levels.js'
import { DEFAULT_CONFIG } from '../src/renderer/world.js'
import { arrivalSummary } from '../src/renderer/compass.js'
import { filingLine } from '../src/renderer/origin-intake.js'
import { PRIO } from '../src/renderer/messages.js'
import { createEventScheduler, EVENTS } from '../src/renderer/events.js'
import { wayMessage, LOBBY, BLOCK } from '../src/renderer/topology.js'

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8')
const game = read('../src/renderer/game.js')
const at = (s, from = 0) => { const k = game.indexOf(s, from); expect(k, s).toBeGreaterThan(0); return k }
const slice = (from, to) => { const a = at(from), b = game.indexOf(to, a); expect(b, to).toBeGreaterThan(a); return game.slice(a, b) }
const lift = (re) => { const m = game.match(re); expect(m, String(re)).not.toBeNull(); return m[0] }
const count = (s) => game.split(s).length - 1
const loopAt = game.indexOf('function loop(ts) {')
const build = () => slice('function buildLevel(index, at = null) {', '// lift the veil only once')
const travel = () => slice('function travel(way) {', '// die(): death.js resolves it')
const die = () => slice('function die(d = null) {', '// ── input ──')
const boot = () => slice('if (resume) {', 'if (bus) mpClient.onEv(bus.receive)')

const ROLL = 'const feel  = feelingFor({ seed: worldSeed, level: index, visit: (mem.get(index)?.visits ?? 0) + (level ? 1 : 0), room: !!mpClient, thread: firstRun.on(), on: cfg.feelings })'
const LINE_TRAVEL = 'if (level.feel.line) later(first || filing ? FEEL.afterMs : FEEL.aheadMs, level.feel.line, PRIO.discovery, false)'
const LINE_WAKE = 'if (rebuilt && level.feel.line) later(FEEL.afterMs, level.feel.line, PRIO.discovery, false)'
const LINE_BOOT = 'if (level.feel.line) later(FEEL.aheadMs, level.feel.line, PRIO.discovery, false)'

describe('the imports and the shell', () => {
  it('game.js imports the roll, the overlay, the passer\'s hand and the timing by their real names, and the hum\'s glide', () => {
    expect(game).toMatch(/import \{ feelingFor, applyFeeling, markPassage, FEEL \} from '\.\/feelings\.js'/)
    expect(game).toMatch(/import \{ initAudio, [^\n]*\bsetHum\b[^\n]*, humDuck, step, [^\n]* \} from '\.\/audio\.js'/)
  })
  it('feelings.js is in src/sw.js and tools/build-play.sh', () => {
    expect(read('../src/sw.js')).toContain("'/renderer/feelings.js'")
    expect(read('../tools/build-play.sh')).toContain("'feelings.js'")
  })
})

describe('buildLevel: the roll at the cfg stage', () => {
  it('rolls once, after the docket and the closing have leaned the cfg and the thread has heard the floor, and lays the dark over it', () => {
    const b = build()
    expect(count(ROLL)).toBe(1)
    expect(b).toContain(ROLL)
    expect(b).toContain('const dark  = !cfg.lights')
    expect(b.indexOf('const dark  = !cfg.lights')).toBeLessThan(b.indexOf('applyFeeling(cfg, feel)'))   // the floor's own dark, read first
    expect(b.indexOf('firstRun.onLevel(index)')).toBeLessThan(b.indexOf(ROLL))                           // the thread lapses below first
    expect(b.indexOf('applyPlacement(cfg, placementMods(st))')).toBeLessThan(b.indexOf(ROLL))
    expect(b.indexOf(ROLL)).toBeLessThan(b.indexOf('applyFeeling(cfg, feel)'))
    // before anything reads the cfg: the world, the decor, the renderer and the floor's murmurs
    for (const s of ['createChunkCache(cfg, worldSeed)', 'createDecorSystem(cfg, isWall, worldSeed, {', 'const gfx       = makeGfx(cfg, cache)', '...(cfg.messages || []),'])
      expect(b.indexOf('applyFeeling(cfg, feel)'), s).toBeLessThan(b.indexOf(s))
    expect(count('applyFeeling(')).toBe(1)
  })
  it('the visit counts this arrival on a travel and a wake (built before mem.arrive), and a resume\'s own, already counted', () => {
    // the session's first build is the boot's: a fresh start (no visit counted: never felt) or a resume (its visit counted already)
    expect(game.indexOf('let level = null')).toBeLessThan(game.indexOf('function buildLevel('))
    const t = travel(), d = die(), bo = boot()
    expect(t.indexOf('buildLevel(way.target, fromC)')).toBeLessThan(t.indexOf('const rec = mem.arrive(way.target, spawnChunk, playT)'))
    expect(d.indexOf('buildLevel(r.wakeLevel, C)')).toBeLessThan(d.indexOf('mem.arrive(level.index, spawnChunk, playT)'))
    expect(bo).toContain('buildLevel(entryLevel({ online: !!mpClient, frontDoor })); mem.arrive(level.index, spawnChunk, playT)')
    // the rules the call passes: a room, the lobby's thread, the kill switch (levelConfig carries world.json's); the block is no floor
    expect(feelingFor({ seed: 0, level: BLOCK, visit: 3 })).toBe(NO_FEELING)
  })
  it('the passage is laid as each chunk comes in, into this visit\'s search log after it is cleared and seeded', () => {
    const b = build()
    expect(b).toContain('onChunk: (k, bundle) => { bodies.setChunk(k, bundle.colliders); markPassage(bundle.props, feel, searchLog) },')
    const clr = b.indexOf('searchLog.clear(); searchLog.seed(mem.searchedFor(index));')
    expect(clr).toBeGreaterThan(0)
    expect(clr).toBeLessThan(b.indexOf('decor.update(spawnChunk.cx, spawnChunk.cy)'))                     // the first chunk comes in after
    expect(count('markPassage(')).toBe(1)
    expect(game).not.toMatch(/mem\.noteSearched\([^)]*feel/)                                               // never the floor's memory
  })
  it('keeps the record on the level; a quiet spreads the events and lowers the hum, which every other floor glides home', () => {
    const b = build()
    const line = 'level.feel = feel; level.dark = dark; evConfig.spacing = feel.events; setHum(1, feel.hum, FEEL.humS)'
    expect(b).toContain(line)
    expect(b.indexOf('level = { index, cfg, cache, grid, bodies, decor, solid, entitySys, gfx, messages }')).toBeLessThan(b.indexOf(line))
    expect(count('setHum(')).toBe(2)                                        // the import and this
    expect(count('evConfig.spacing')).toBe(1)
  })
})

describe('the loop', () => {
  it('the things see by the floor\'s own light, never the feeling\'s', () => {
    expect(game.slice(loopAt)).toContain('aiCtx.dark = level.dark;')
    expect(game).not.toContain('aiCtx.dark = !cfg.lights')
  })
  it('a quiet floor\'s murmurs come further apart: the visit\'s multiplier on the murmur clock (1 on every other visit)', () => {
    const l = game.slice(loopAt)
    expect(l).toMatch(/msgTimer \+= dt\r?\n\s*if \(msgTimer >= msgNext \* level\.feel\.murmurs\) \{\r?\n\s*msgTimer = 0\r?\n\s*msgNext  = base\.messageInterval\[0\]/)
  })
})

describe('the line, said by the arrival', () => {
  it('a travel says it after the floor\'s plate: ahead of the 3.8 s lines on a floor you come back to, after every line on a first visit', () => {
    const t = travel()
    expect(count(LINE_TRAVEL)).toBe(1)
    const k = t.indexOf(LINE_TRAVEL)
    expect(k).toBeGreaterThan(t.indexOf("plate('floor', arrivalPlate(level.cfg, first), PRIO.combat)"))
    expect(k).toBeGreaterThan(t.indexOf('const first = rec.visits === 1'))
  })
  it('a wake says it only when it built the floor (the same floor\'s wake keeps its feeling, said already), after the wake\'s own lines', () => {
    const d = die()
    expect(d).toMatch(/const rebuilt = r\.wakeLevel !== level\.index\r?\n\s*if \(r\.wakeLevel !== level\.index\) buildLevel\(r\.wakeLevel, C\)/)
    expect(d.indexOf(LINE_WAKE)).toBeGreaterThan(d.indexOf('if (d?.line) later(7800, d.line, PRIO.discovery)'))
  })
  it('a resume says its visit\'s feeling a few seconds after the floor\'s name (a fresh start is never felt)', () => {
    const bo = boot()
    expect(bo.indexOf(LINE_BOOT)).toBeGreaterThan(bo.indexOf("plate('floor', arrivalPlate(level.cfg, !resume), PRIO.combat)"))
    expect(count(LINE_BOOT)).toBe(1)
  })
  it('the save gains nothing: a resume rolls its visit\'s feeling again from the counted visit', () => {
    const snap = slice('function snapshot(full = false) {', 'let saveTimer = 0')
    expect(snap).not.toMatch(/feel/)
  })
})

// game.js's plate(), later() and startVisit() lifted and run on a play clock with the real budget (pulse-wiring's harness), and with them
// the tails of travel(), die() and the boot from startVisit() on, as game.js has them: every line handed to showMessage is recorded with
// its time, and the frame's unasked lines (a murmur, an event, a haunt) are said through the same plate() at their moments
const PLATE = /function plate\(kind, text, prio, keep = true\) \{[\s\S]*?\r?\n {2}\}/
const VISIT = /function startVisit\(\) \{[\s\S]*?\r?\n {2}\}/
const LATER = /function later\(ms, text, prio, keep = true\) \{[^\n]*\}/
function arrival(cfg) {
  const said = [], timers = []
  let now = 0
  const drain = slice('const held = plates.drain(playT)', '// ── Living Atmosphere')
  const h = new Function('plates', 'showMessage', 'setTimeout', 'PRIO', 'msgQ', 'level',
    'let playT = 0, arrivalGen = 0, floorT0 = 0, floorHinted = false, pullPhase = 0, lostSaid = false, hintHeld = false\n' +
    'let dreadQuietT = 0, sanity = 100, fieldOn = false, fxLeft = 0\nconst eventSched = { arrive() {} }, teller = { reset() {} }, dreadOut = { dread: 0 }, film = { arrive() {} }\n' +
    `${lift(PLATE)}\n${lift(LATER)}\n${lift(VISIT)}\nfunction drainFrame() {\n${drain}\n}\n` +
    'return { plate, later, startVisit, drainFrame, set: (t) => { playT = t } }')(createPlateBudget(), (t) => said.push([now, t]), (f, ms) => timers.push({ ms, f, done: false }), PRIO,
    { idle: () => true }, { index: 1, cfg })
  const run = (to, events = {}) => {
    for (; now <= to + 1e-9; now = Math.round((now + 0.1) * 10) / 10) {
      h.set(now)
      for (const t of timers) if (!t.done && t.ms / 1000 <= now + 1e-9) { t.done = true; t.f() }
      if (events[now]) events[now]()
      h.drainFrame()
    }
  }
  // the budget's count: plates shown in an arrival's first 45 s (every line here is an arrival's or an unasked one)
  const inWindow = () => said.filter(([t]) => t < 45).length
  return { h, said, run, inWindow }
}
const L = (i) => levelConfig(DEFAULT_CONFIG, i)
// a record of each feeling on a floor, from the real roll
const feelOn = (id, level = 1) => {
  for (let seed = 0; seed < 50; seed++) for (let v = 2; v < 40; v++) { const f = feelingFor({ seed, level, visit: v }); if (f.id === id) return f }
  throw new Error(id)
}
const dieBody = die(), travelBody = travel()
const WAKE = dieBody.slice(dieBody.indexOf('startVisit()'), dieBody.indexOf('bus?.here(hereFields())'))
const TAIL = travelBody.slice(travelBody.indexOf('startVisit()'), travelBody.lastIndexOf('bus?.here(hereFields())'))
const FILE = lift(/later\([0-9]+, filingLine\(origin, thin\), PRIO\.discovery\)/)
const R = { message: 'you wake beside the hole you fell through.', dropped: 'almond-water', droppedLine: 'your hands opened.' }
// die()'s lines from startVisit() on, on a floor the wake built (rebuilt) or the one you fell on
function wake({ index = 1, feel, first = false, rebuilt = true, r = R, d = { line: 'nobody came.' } } = {}) {
  const cfg = L(index)
  const x = arrival(cfg)
  new Function('startVisit', 'plate', 'later', 'arrivalPlate', 'level', 'first', 'r', 'd', 'PRIO', 'rebuilt', 'FEEL', WAKE)(
    x.h.startVisit, x.h.plate, x.h.later, arrivalPlate, { index, cfg, feel }, first, r, d, PRIO, rebuilt, FEEL)
  return x
}
// travel()'s lines from startVisit() on (pulse-wiring's land(): a hole down, 'the way you came.', the floor's memory as given)
function land({ index = 1, feel, first = true, filing = false, followed = 0, visits = first ? 1 : 2, way = { kind: 'down', target: index },
  wayMsg = () => 'the way you came.', memRec = null, maxHp = first ? 105 : 100 } = {}) {
  const cfg = L(index)
  const x = arrival(cfg)
  new Function('startVisit', 'plate', 'later', 'arrivalPlate', 'level', 'first', 'filing', 'followed', 'freshLobby', 'way', 'wayMessage',
    'partner', 'mem', 'fog', 'arrivalSummary', 'rec', 'player', 'hp0', 'origin', 'thin', 'filingLine', 'MERCY_LINE', 'PRIO', 'FEEL',
    `let hintHeld = false\nif (filing) ${FILE}\n${TAIL}\nreturn { hintHeld }`)(
    x.h.startVisit, x.h.plate, x.h.later, arrivalPlate, { index, cfg, feel }, first, filing, followed, () => false, way,
    wayMsg, null, { get: () => memRec }, { countWays: () => ({ down: 1, up: 0, lift: 0, ring: 0 }) }, arrivalSummary, { visits },
    { maxHp }, 100, 'tenant', false, filingLine, 'the mercy.', PRIO, FEEL)
  return x
}
const unasked = (h) => ({ 1.5: () => h.plate('murmur', 'a murmur.', PRIO.ambient, false), 12: () => h.plate('event', 'a door.', PRIO.ambient, false),
  20: () => h.plate('haunt', 'a haunt.', PRIO.discovery, false), 30: () => h.plate('murmur', 'another.', PRIO.ambient, false) })

describe('replayed: game.js\'s own arrivals with a feeling, inside the arrival budget (the real plates.js)', () => {
  const dark = feelOn('dark'), quiet = feelOn('quiet'), passage = feelOn('passage')
  it('identity: with no feeling every arrival says what it said (pulse-wiring\'s ladders)', () => {
    const back = land({ feel: NO_FEELING, first: false }); back.run(80)
    expect(back.said).toEqual([[0, L(1).levelName], [3.8, arrivalSummary({ down: 1 }, 2)]])
    const first = land({ feel: NO_FEELING }); first.run(80)
    expect(first.said).toEqual([[0, L(1).levelSub], [3.8, L(1).exit.hint], [45, 'the floor remembers you less.']])
  })
  it('a floor you come back to: the floor\'s name, then the line as the second plate; the summary and the way you came are let go', () => {
    for (const f of [dark, quiet, passage]) {
      const { said, run, inWindow } = land({ feel: f, first: false })
      run(120)
      expect(said, f.id).toEqual([[0, L(1).levelName], [FEEL.aheadMs / 1000, f.line]])
      expect(inWindow()).toBe(2)
    }
  })
  it('climbing out on the ring: the line goes first; the lobby\'s own line and the summary are let go', () => {
    const f = feelOn('dark', 0)
    const { said, run } = land({ index: LOBBY, feel: f, first: false, visits: 3, way: { kind: 'ring', target: LOBBY }, wayMsg: wayMessage, memRec: { x: 3, y: 4 } })
    run(120)
    expect(said).toEqual([[0, L(LOBBY).levelName], [FEEL.aheadMs / 1000, f.line]])
  })
  // (2.0.4, review batch six) a lift ride back to a floor you know puts up no name plate: the lift's line takes its place, so the
  // feeling's line has the second plate there too, in place of the summary, as on any return. The first ride is as it was
  it('off the lift on a return the line follows the lift\'s own line, in place of the summary; the first ride has no room for it', () => {
    const lift3 = { kind: 'lift', target: 3 }
    const f = feelOn('quiet', 3)
    const back = land({ index: 3, feel: f, first: false, way: lift3, wayMsg: wayMessage })
    back.run(120)
    expect(back.said).toEqual([[0, wayMessage(lift3, { before: true })], [FEEL.aheadMs / 1000, f.line]])
    expect(back.inWindow()).toBe(2)
    const ride = land({ index: 3, feel: f, first: true, way: lift3, wayMsg: wayMessage })
    ride.run(120)
    expect(ride.said.map((s) => s[1]).slice(0, 2)).toEqual([wayMessage(lift3, { before: true }), L(3).levelSub])
    expect(ride.said.map((s) => s[1])).not.toContain(f.line)
    expect(ride.inWindow()).toBe(2)
  })
  it('a first visit: the floor\'s own line and its hint keep their plates, the raised ceiling waits; the line is let go, never read late', () => {
    const { said, run, inWindow } = land({ feel: dark })
    run(120)
    expect(said).toEqual([[0, L(1).levelSub], [3.8, L(1).exit.hint], [45, 'the floor remembers you less.']])
    expect(inWindow()).toBe(2)
  })
  it('the way that files you: the filing keeps the second plate, the hint waits it out, the line is let go', () => {
    const { said, run, inWindow } = land({ feel: passage, filing: true })
    run(120)
    expect(said).toEqual([[0, L(1).levelSub], [3.8, filingLine('tenant', false)], [45, L(1).exit.hint], [45 + DRAIN_S, 'the floor remembers you less.']])
    expect(inWindow()).toBe(2)
  })
  it('the way that files you onto a floor you have been on (an unfiled save\'s next way): the filing keeps its plate, the line is let go', () => {
    const { said, run, inWindow } = land({ feel: quiet, first: false, filing: true })
    run(120)
    expect(said).toEqual([[0, L(1).levelName], [3.8, filingLine('tenant', false)]])
    expect(inWindow()).toBe(2)
  })
  it('a first visit with no line of its own left (followed down, no way line): the line takes the free plate', () => {
    const { said, run, inWindow } = land({ feel: quiet, followed: 2, wayMsg: () => null, maxHp: 100 })
    run(120)
    expect(said).toEqual([[0, L(1).levelSub], [FEEL.afterMs / 1000, quiet.line]])
    expect(inWindow()).toBe(2)
  })
  it('a wake on a floor it built: where you woke and what you lost keep their plates; the line only takes one they leave free', () => {
    let x = wake({ feel: dark })
    x.run(120)
    expect(x.said).toEqual([[2.6, R.message], [5.2, R.droppedLine], [45, 'nobody came.']])
    x = wake({ feel: dark, r: { ...R, dropped: null, droppedLine: null }, d: null })
    x.run(120)
    expect(x.said).toEqual([[2.6, R.message], [FEEL.afterMs / 1000, dark.line]])
    // the floor you fell on: its feeling was said on arrival, and is not said again
    x = wake({ feel: dark, rebuilt: false, r: { ...R, dropped: null, droppedLine: null }, d: null })
    x.run(120)
    expect(x.said).toEqual([[2.6, R.message]])
  })
  it('every arrival, any feeling, the frame\'s unasked lines too: never more than 2 plates in the first 45 s, the line at most once', () => {
    for (const f of [NO_FEELING, dark, quiet, passage]) {
      const cases = [
        land({ feel: f }), land({ feel: f, first: false }), land({ feel: f, filing: true }), land({ feel: f, followed: 1, wayMsg: () => null }),
        land({ feel: f, first: false, way: { kind: 'lift', target: 1 }, wayMsg: wayMessage }),
        wake({ feel: f }), wake({ feel: f, first: true }), wake({ feel: f, r: { ...R, dropped: null, droppedLine: null }, d: null }),
      ]
      for (const [i, x] of cases.entries()) {
        x.run(120, unasked(x.h))
        expect(x.inWindow(), `${f.id}/${i}`).toBeLessThanOrEqual(2)
        if (f.line) expect(x.said.filter(([, t]) => t === f.line).length).toBeLessThanOrEqual(1)
      }
    }
  })
  it('a resume: the floor\'s name, then the line', () => {
    const bo = boot()
    const tail = bo.slice(bo.indexOf('startVisit()'), bo.indexOf(LINE_BOOT) + LINE_BOOT.length)
    const x = arrival(L(2))
    const f = feelOn('passage', 2)
    new Function('startVisit', 'plate', 'later', 'arrivalPlate', 'level', 'resume', 'freshLobby', 'firstRun', 'PRIO', 'FEEL', `let hintHeld = false\n${tail}`)(
      x.h.startVisit, x.h.plate, x.h.later, arrivalPlate, { index: 2, cfg: L(2), feel: f }, { level: 2 }, () => false, { unlocked: () => true }, PRIO, FEEL)
    x.run(120)
    expect(x.said).toEqual([[0, L(2).levelName], [FEEL.aheadMs / 1000, f.line]])
  })
})

describe('replayed: the quiet with the real scheduler', () => {
  it('the visit\'s events come about half as often, and the arrival\'s is no sooner than its window stretched', () => {
    const count10m = (spacing) => {
      let s = 99
      const rng = () => { s = (s * 16807) % 2147483647; return s / 2147483647 }
      const sch = createEventScheduler({ rng, config: { events: EVENTS, tension: 0, spacing } })
      let n = 0, first = null
      for (let k = 0; k < 40; k++) {
        sch.arrive(1, 90)
        for (let t = 0; t < 600; t++) if (sch.tick(1, { level: 1, sanity: 90, canFire: true })) { n++; if (first === null) first = t }
      }
      return { n, first }
    }
    const loud = count10m(undefined), quiet = count10m(FEELINGS.quiet.events)
    expect(quiet.n / loud.n).toBeGreaterThan(0.4); expect(quiet.n / loud.n).toBeLessThan(0.6)
    expect(quiet.first).toBeGreaterThanOrEqual(16 * FEELINGS.quiet.events - 1)
  })
  it('every other visit writes spacing 1, so a floor after a quiet one has its own windows again (the identity in feelings.test.js)', () => {
    expect(NO_FEELING.events).toBe(1); expect(NO_FEELING.murmurs).toBe(1); expect(NO_FEELING.hum).toBe(1)
  })
})
