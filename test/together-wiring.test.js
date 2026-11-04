// 2.0.5's five together (feelings, learn, radio, film, touch), replayed where they meet. Each feature's own guard replays it alone; here
// the pieces lifted out of game.js run side by side on one play clock against the real modules:
//   - one arrival: the floor's feeling (feelings.js, said by travel() / die() through later()), the third getaway on a floor (learn.js,
//     onEntityEvent's 'learn' plate) and a photo that develops a den (film.js, firePolaroid's developDen) in the same first 45 s, with the
//     frame's unasked lines, through the real plates.js and the real message queue: never more than two budgeted plates in the window,
//     the feeling at most once, the floor's lesson said once (offered again until it shows, never dropped), the den once a visit and
//     never a plate;
//   - the radio's warning (radiostatic.js) under each feeling: the dark, the quiet and the passage leave dread and the hiss as they are
//     (the dark rewrites the lights only; the quiet lowers the hum, which is not the hiss's road to the speakers);
//   - Level ∅: every new road is shut there (no feeling, nothing learned, no den, no hiss, no hum change).
// game.js only boots in a page, so these are the lifted pieces plus source guards.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import { installFakeAudioContext } from './audio-fake.js'
import { FEEL, feelingFor, applyFeeling, NO_FEELING } from '../src/renderer/feelings.js'
import { createPlateBudget, arrivalPlate, FREE_KINDS } from '../src/renderer/plates.js'
import { createLearning, learnsHere, LEARN, LEARN_LINES } from '../src/renderer/learn.js'
import { createLevelMemory } from '../src/renderer/levelmem.js'
import { ESCAPE_KINDS } from '../src/renderer/hunt.js'
import { createFilm, denLine } from '../src/renderer/film.js'
import { createFogMap } from '../src/renderer/fogmap.js'
import { PRIO, createMessageQueue } from '../src/renderer/messages.js'
import { inViewCone, lineOfSight } from '../src/renderer/raycaster.js'
import { HF } from '../src/renderer/gfx-frame.js'
import { levelConfig } from '../src/renderer/levels.js'
import { DEFAULT_CONFIG, createChunkCache, createGridReader } from '../src/renderer/world.js'
import { arrivalSummary } from '../src/renderer/compass.js'
import { filingLine } from '../src/renderer/origin-intake.js'
import { BLOCK, chunkMid, findOpenNear } from '../src/renderer/topology.js'
import { DREAD_CLOCK, dreadFrom, dreadNear, createTeller } from '../src/renderer/dread.js'
import { createPathField } from '../src/renderer/pathfield.js'
import { createRadioStatic } from '../src/renderer/radiostatic.js'

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8')
const game = read('../src/renderer/game.js')
const at = (s, from = 0) => { const k = game.indexOf(s, from); expect(k, s).toBeGreaterThan(0); return k }
const slice = (from, to) => { const a = at(from), b = game.indexOf(to, a); expect(b, to).toBeGreaterThan(a); return game.slice(a, b) }
const lift = (re) => { const m = game.match(re); expect(m, String(re)).not.toBeNull(); return m[0] }
const lcg = (s) => () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296)

const PLATE = /function plate\(kind, text, prio, keep = true\) \{[\s\S]*?\r?\n {2}\}/
const VISIT = /function startVisit\(\) \{[\s\S]*?\r?\n {2}\}/
const LATER = /function later\(ms, text, prio, keep = true\) \{[^\n]*\}/
const DEN = /function developDen\(\) \{[\s\S]*?\r?\n {2}\}/
const CASE = /case 'escape-still': case 'escape-ward': case 'escape-run': case 'escape-flash': \{[^\n]*\} break/
const OFFER = /if \(creaturesOn && !transitioning && plates\.settled\(playT\)\) \{[^\n]*\}/
const LOS = 'const frameLos = (ax, ay, bx, by) => lineOfSight(ax, ay, bx, by, level.grid.floor)'
const OPTS = 'const DEN_OPTS = { cone: inViewCone, hf: HF, los: frameLos, home: (cx, cy) => level.entitySys.isSpawnChunk(cx, cy) }'
const travelBody = slice('function travel(way) {', '// die(): death.js resolves it')
const dieBody = slice('function die(d = null) {', '// ── input ──')
const TAIL = travelBody.slice(travelBody.indexOf('startVisit()'), travelBody.lastIndexOf('bus?.here(hereFields())'))
const WAKE = dieBody.slice(dieBody.indexOf('startVisit()'), dieBody.indexOf('bus?.here(hereFields())'))
const FILE = lift(/later\([0-9]+, filingLine\(origin, thin\), PRIO\.discovery\)/)

const L = (i) => levelConfig(DEFAULT_CONFIG, i)
const feelOn = (id, level = 1) => {
  for (let seed = 0; seed < 50; seed++) for (let v = 2; v < 40; v++) { const f = feelingFor({ seed, level, visit: v }); if (f.id === id) return f }
  throw new Error(id)
}
const FEELS = [NO_FEELING, feelOn('dark'), feelOn('quiet'), feelOn('passage')]

// ── one arrival: game.js's plate(), later(), startVisit(), the escape case, developDen and the frame's drain, lifted together ─────────
// on a play clock with the real budget, the real learning over the real floor memory, the real film and sheet, and the real message
// queue. Every budgeted plate the budget lets show is recorded with its time; every line the HUD shows is recorded as it shows.
function arrival({ index = 1, feel, cfg = L(index), prior = 2 } = {}) {
  const shown = [], timers = [], admitted = [], said = []
  let now = 0
  const msgQ = createMessageQueue()
  const budget = createPlateBudget()
  const plates = { arrive: (t) => budget.arrive(t), drain: (t) => budget.drain(t), settled: (t) => budget.settled(t),
    admit: (kind, t, line) => { const v = budget.admit(kind, t, line); if (v === 'show' && !FREE_KINDS.includes(kind)) admitted.push([t, kind, line]); return v } }
  const mem = createLevelMemory(), learning = createLearning({ mem })
  learning.refinements(index)                                    // buildLevel: the floor's things are handed what it has learned
  // the floor's earlier getaways (a visit before this one): the next by the same way is the third, and teaches
  for (let k = 0; k < prior; k++) learning.escape(index, ESCAPE_KINDS.still, -1000 + k * (LEARN.merge + 5))
  const fog = Object.assign(createFogMap(), { countWays: () => ({ down: 1, up: 0, lift: 0, ring: 0 }) })
  const film = createFilm()
  const ents = [{ x: 14.5, y: 10.5, variant: 'hound', chunkCx: 0, chunkCy: 0 }]
  const level = { index, cfg, feel, grid: { floor: () => true }, entitySys: { getEntities: () => ents, isSpawnChunk: () => true } }
  const player = { x: 10.5, y: 10.5, angle: 0, maxHp: 100 }
  const show = (t, p = PRIO.interaction) => { said.push([now, t, p]); msgQ.push(t, p) }
  const drain = slice('const held = plates.drain(playT)', '// ── Living Atmosphere')
  const h = new Function('plates', 'showMessage', 'setTimeout', 'PRIO', 'msgQ', 'level', 'player', 'film', 'fog', 'getPref', 'inViewCone', 'HF',
    'lineOfSight', 'learning',
    'let playT = 0, arrivalGen = 0, floorT0 = 0, floorHinted = false, pullPhase = 0, lostSaid = false, hintHeld = false\n' +
    'let dreadQuietT = 0, sanity = 100, fieldOn = false, fxLeft = 0, creaturesOn = true, transitioning = false\nconst eventSched = { arrive() {} }, teller = { reset() {} }, dreadOut = { dread: 0 }\n' +
    `${LOS}\n${OPTS}\n${lift(PLATE)}\n${lift(LATER)}\n${lift(VISIT)}\n${lift(DEN)}\nfunction drainFrame() {\n${lift(OFFER)}\n${drain}\n}\n` +
    `function onEsc(ev) { switch (ev.kind) { ${lift(CASE)} } }\n` +
    'function photo(cap) { showMessage(cap); developDen() }\n' +
    'return { plate, later, startVisit, photo, onEsc, drainFrame, set: (t) => { playT = t } }')(plates, show,
    (f, ms) => timers.push({ ms: now * 1000 + ms, f, done: false }), PRIO, msgQ, level, player, film, fog, () => true, inViewCone, HF,
    lineOfSight, learning)
  const run = (to, events = {}) => {
    for (; now <= to + 1e-9; now = Math.round((now + 0.1) * 10) / 10) {
      h.set(now)
      for (const t of timers) if (!t.done && t.ms / 1000 <= now + 1e-9) { t.done = true; t.f() }
      if (events[now]) events[now]()
      h.drainFrame()
      const r = msgQ.tick(0.1); if (r?.show) shown.push([now, r.text])
    }
  }
  const esc = () => h.onEsc({ kind: ESCAPE_KINDS.still, id: 1, x: 0, y: 0, d: 3, variant: 'shade' })
  return { h, run, esc, said, shown, admitted, level, player, fog, mem, inWindow: () => admitted.filter(([t]) => t < 45).length }
}
// travel()'s lines from startVisit() on (feelings-wiring's land(): a hole down, 'the way you came.', the floor's memory as given)
function land({ feel, first = true, filing = false, followed = 0, wayMsg = () => 'the way you came.', ...o } = {}) {
  const x = arrival({ feel, ...o })
  new Function('startVisit', 'plate', 'later', 'arrivalPlate', 'level', 'first', 'filing', 'followed', 'freshLobby', 'way', 'wayMessage',
    'partner', 'mem', 'fog', 'arrivalSummary', 'rec', 'player', 'hp0', 'origin', 'thin', 'filingLine', 'MERCY_LINE', 'PRIO', 'FEEL',
    `let hintHeld = false\nif (filing) ${FILE}\n${TAIL}\nreturn { hintHeld }`)(
    x.h.startVisit, x.h.plate, x.h.later, arrivalPlate, x.level, first, filing, followed, () => false, { kind: 'down', target: x.level.index },
    wayMsg, null, { get: () => null }, x.fog, arrivalSummary, { visits: first ? 1 : 2 }, x.player, 100, 'tenant', false, filingLine,
    'the mercy.', PRIO, FEEL)
  return x
}
// die()'s lines from startVisit() on, on a floor the wake built
function wake({ feel, first = false, d = { line: 'nobody came.' } } = {}) {
  const x = arrival({ feel })
  const r = { message: 'you wake beside the hole you fell through.', dropped: 'almond-water', droppedLine: 'your hands opened.' }
  new Function('startVisit', 'plate', 'later', 'arrivalPlate', 'level', 'first', 'r', 'd', 'PRIO', 'rebuilt', 'FEEL', WAKE)(
    x.h.startVisit, x.h.plate, x.h.later, arrivalPlate, x.level, first, r, d, PRIO, true, FEEL)
  return x
}
const CAP = 'the film shows the hall as it will finalize: darker, one door fewer.'
const unasked = (x, extra = {}) => ({ 1.5: () => x.h.plate('murmur', 'a murmur.', PRIO.ambient, false), 12: () => x.h.plate('event', 'a door.', PRIO.ambient, false),
  20: () => x.h.plate('haunt', 'a haunt.', PRIO.discovery, false), 30: () => x.h.plate('murmur', 'another.', PRIO.ambient, false), ...extra })
const ARRIVALS = [
  (feel) => land({ feel }), (feel) => land({ feel, first: false }), (feel) => land({ feel, filing: true }),
  (feel) => land({ feel, followed: 1, wayMsg: () => null }), (feel) => wake({ feel }), (feel) => wake({ feel, d: null }),
]

describe('one arrival: the feeling, the floor\'s lesson and the den inside the real plate budget', () => {
  it('a floor you come back to, a feeling, the third getaway and a photo in its first seconds: two plates, the lesson held, the den free', () => {
    const f = feelOn('dark')
    const x = land({ feel: f, first: false })
    x.run(44.9, { 2: x.esc, 6: () => x.h.photo(CAP) })
    // the window's two: the floor's name and the lesson (taken at 2 s); the feeling's line comes after, finds the window full and is let go
    expect(x.admitted.map((a) => a[1])).toEqual(['floor', 'learn'])
    expect(x.said.map((s) => s[1])).toEqual([L(1).levelName, LEARN_LINES.still, CAP, denLine('hound')])
    x.run(120)
    expect(x.said.filter((s) => s[1] === f.line)).toHaveLength(0)
    expect(x.shown.map((s) => s[1])).toEqual([L(1).levelName, LEARN_LINES.still, CAP, denLine('hound')])
  })
  it('the same arrival with the getaway after the feeling\'s line: the feeling takes the second plate and the lesson waits out the window', () => {
    const f = feelOn('quiet')
    const x = land({ feel: f, first: false })
    x.run(120, { 10: x.esc, 6: () => x.h.photo(CAP) })
    expect(x.inWindow()).toBe(2)
    expect(x.said.map((s) => [s[0], s[1]])).toEqual([[0, L(1).levelName], [FEEL.aheadMs / 1000, f.line], [6, CAP], [6, denLine('hound')], [45, LEARN_LINES.still]])
    expect(x.shown.map((s) => s[1])).toEqual([L(1).levelName, f.line, CAP, denLine('hound'), LEARN_LINES.still])   // nothing dropped
  })
  it('every arrival, every feeling, the lesson at any moment of the window, a photo, the frame\'s unasked lines: never a third plate in 45 s', () => {
    let n = 0
    for (const feel of FEELS) for (const make of ARRIVALS) for (const te of [0.5, 2, 3.7, 4, 7.6, 8.5, 20, 44]) for (const tp of [1, 5, 9]) {
      const x = make(feel)
      x.run(130, unasked(x, { [te]: x.esc, [tp]: () => x.h.photo(CAP) }))
      const tag = `${feel.id}/${ARRIVALS.indexOf(make)}/${te}/${tp}`
      expect(x.inWindow(), tag).toBeLessThanOrEqual(2)
      if (feel.line) expect(x.said.filter((s) => s[1] === feel.line).length, tag).toBeLessThanOrEqual(1)
      expect(x.said.filter((s) => s[1] === LEARN_LINES.still).length, tag).toBe(1)             // held when the window is full, never let go
      expect(x.said.filter((s) => s[1] === denLine('hound')).length, tag).toBe(1)              // the photo's own, once a visit
      expect(x.admitted.some((a) => a[2] === denLine('hound') || a[2] === CAP), tag).toBe(false)  // never a plate
      // the queue drops no discovery line: everything said that is not ambient reaches the screen, the lesson and the den included
      const seen = new Set(x.shown.map((s) => s[1]))
      for (const [, t, p] of x.said) if (p !== PRIO.ambient && p !== PRIO.interaction) expect(seen.has(t), `${tag}: ${t}`).toBe(true)
      n++
    }
    expect(n).toBe(FEELS.length * ARRIVALS.length * 8 * 3)
  })
  it('the den and the lesson are each what a visit allows: a second photo develops nothing more, a fourth getaway teaches nothing more', () => {
    const x = land({ feel: feelOn('passage'), first: false })
    x.run(130, { 2: x.esc, 5: () => x.h.photo(CAP), 30: () => x.h.photo('a second caption.'), 70: x.esc, 100: x.esc })
    expect(x.said.filter((s) => s[1] === denLine('hound'))).toHaveLength(1)
    expect(x.said.filter((s) => s[1] === LEARN_LINES.still)).toHaveLength(1)
    expect(x.mem.escapesFor(1).still).toBe(5)
  })
})

// ── the radio's warning under a feeling: game.js's dread block and the static's block, lifted, on a real level 1 under each feeling's cfg ─
const HEAD = '// ── the radio\'s static (radiostatic.js)'
const RADIO = () => slice(HEAD, '// ── sanity —')
const DREAD = () => slice('// ── dread (dread.js)', '// ── the lobby\'s exit hint, held for the first run')
let fake, audio, actx, timers
beforeEach(async () => {
  fake = installFakeAudioContext()
  timers = [vi.spyOn(globalThis, 'setInterval').mockImplementation(() => 1), vi.spyOn(globalThis, 'setTimeout').mockImplementation(() => 1)]
  vi.resetModules()
  audio = await import('../src/renderer/audio.js')
  audio.initAudio(DEFAULT_CONFIG)
  actx = fake.nodes.ctxs[0]
})
afterEach(() => { for (const s of timers) s.mockRestore(); fake.restore() })

// the hum: the sawtooth that setHum detunes, through its low-pass, into its gain (audio.js initAudio)
const humOsc = () => fake.nodes.all.find((n) => n.kind === 'oscillator' && n.type === 'sawtooth')
const humNode = () => humOsc().out[0].out[0]
const hissGain = () => { const src = fake.nodes.all.find((n) => n.kind === 'buffer-source' && n.loop === true); return src ? src.out[0].out[0].gain : null }
const thing = (x, y) => ({ x, y, variant: 'shade', ai: 'roam', los: false, pending: 0, stagger: 0 })
// the floor as buildLevel makes it on a visit with this feeling: the cfg, the feeling laid over it, the world built from that cfg
function floorUnder(feel) {
  const cfg = applyFeeling(levelConfig(DEFAULT_CONFIG, 1), feel)
  const cache = createChunkCache(cfg, null); cache.preload(0, 0)
  const grid = createGridReader(cache, (wx, wy, pcx, pcy) => cache.isWall(wx, wy, pcx, pcy)); grid.setPlayerChunk(0, 0)
  return { cfg, cache, grid }
}
function hissRun(feel) {
  const W = floorUnder(feel), mid = chunkMid(0, 0), m = findOpenNear(mid.x, mid.y, W.grid.floor) ?? mid
  const player = { x: m.x, y: m.y, angle: 0 }
  const probe = createPathField(); probe.build(Math.floor(m.x), Math.floor(m.y), W.cache)
  const cell = { x: 0, y: 0, d: -1 }
  expect(probe.pick(14, 16, lcg(5), null, cell)).toBe(true)
  const e = thing(cell.x, cell.y)
  // the quiet's hum, as buildLevel glides it (every other visit glides it home)
  audio.setHum(1, feel.hum, FEEL.humS)
  const st = { playT: 0, dt: 1 / 60, dreadT: 0, fieldT: -Infinity, fieldOn: false }
  const D = {
    level: { entitySys: { getEntities: () => [e] }, cache: W.cache }, creaturesLive: true, transitioning: false, cfg: W.cfg, player,
    pathField: createPathField(), teller: createTeller({ rng: lcg(3) }), dreadOut: { dread: 0, x: 0, y: 0, variant: null, d: -1, los: false },
    dreadNear, dreadFrom, DREAD_CLOCK, call: () => {},
    radioStatic: createRadioStatic(), setRadioStatic: (g, tc) => audio.setRadioStatic(g, tc), th: { hunted: false }, aiCtx: { radioOn: true },
  }
  const keys = Object.keys(st).join(', ')
  const fn = new Function('st', 'D', `const { ${Object.keys(D).join(', ')} } = D\nlet { ${keys} } = st\n${DREAD()}\n${RADIO()}\nObject.assign(st, { ${keys} })`)
  const log = []
  for (let s = 0; s < 12 && cell.d > 1; s++) {
    for (let i = 0; i < 60; i++) { st.playT = Math.round((st.playT + 1 / 60) * 1e6) / 1e6; actx.currentTime = st.playT; fn(st, D) }
    log.push([cell.d, D.dreadOut.dread, audio.radioStaticLevel()])
    probe.next(Math.floor(cell.x), Math.floor(cell.y), cell); e.x = cell.x; e.y = cell.y
  }
  return { log, hiss: hissGain(), cfg: W.cfg }
}

describe('the radio\'s warning while a feeling holds', () => {
  it('the dark, the quiet and the passage: the same dread, the same hiss, cell by cell, as a visit with no feeling', () => {
    const base = hissRun(NO_FEELING)
    expect(base.log.length).toBeGreaterThanOrEqual(8)
    expect(base.log.at(-1)[2]).toBeGreaterThan(0)
    for (const feel of FEELS.slice(1)) {
      const r = hissRun(feel)
      expect(r.log, feel.id).toEqual(base.log)
      expect(r.hiss.calls, feel.id).toEqual(base.hiss.calls)
    }
    expect(floorUnder(feelOn('dark')).cfg.lights).toBe(false)                    // the dark did lie over that floor
  })
  it('the quiet lowers the hum and nothing else: the hiss is not on the hum\'s road (the hum feeds the ambience bus, the hiss the speakers)', () => {
    const quiet = feelOn('quiet')
    hissRun(quiet)
    const src = fake.nodes.all.find((n) => n.kind === 'buffer-source' && n.loop === true)
    expect(src).toBeTruthy()
    // the hiss's gain node goes straight to the destination; the hum's gain feeds the ambience gain, which the hiss never passes
    const hissOut = src.out[0].out[0], hum = humNode()
    expect(hissOut.out).toEqual([actx.destination])
    expect(hum.out).not.toContain(actx.destination)
    expect(hum.out[0].out).toEqual([actx.destination])
    expect(hum.out[0]).not.toBe(hissOut)
    expect(hum.gain.calls.at(-1)[1]).toBeCloseTo(0.018 * quiet.hum, 9)                 // the quiet did lower the hum
    expect(quiet.hum).toBeLessThan(1)
  })
})

// ── Level ∅: every new road shut ──────────────────────────────────────────────────────────────────────────────────────────────────
describe('Level ∅: nothing new there', () => {
  it('no feeling, nothing learned, no den, no hiss (the gates each feature reads, asked with the block\'s own cfg)', () => {
    const block = levelConfig(DEFAULT_CONFIG, BLOCK)
    expect(block.map).toBeTruthy()
    for (let v = 1; v < 40; v++) expect(feelingFor({ seed: v, level: BLOCK, visit: v, on: block.feelings })).toBe(NO_FEELING)
    const before = JSON.stringify(block)
    expect(applyFeeling(block, feelOn('dark'))).toBe(block)
    expect(JSON.stringify(block)).toBe(before)
    expect(learnsHere({ room: false, block: !!block.map })).toBe(false)
    expect(lift(DEN)).toMatch(/if \(level\.cfg\.map \|\| !getPref\('creatures'\)\) return/)
    expect(game).toContain('const rs = radioStatic.tick(dreadOut.dread, th.hunted, aiCtx.radioOn, creaturesLive && !transitioning && !cfg.map)')
  })
  it('the block\'s arrival: its name and its lines at their moments, as 2.0.4 had them (no budget, no feeling line, no lesson, no den)', () => {
    const block = levelConfig(DEFAULT_CONFIG, BLOCK)
    const x = land({ index: BLOCK, cfg: block, feel: NO_FEELING, prior: 0 })
    x.run(60, { 5: () => x.h.photo(CAP) })
    expect(x.admitted).toEqual([])                                                // the block has no budget: plate() hands lines straight on
    expect(x.said.map((s) => s[1])).not.toContain(denLine('hound'))
    expect(x.fog.pins(BLOCK).size ?? [...x.fog.pins(BLOCK)].length).toBe(0)
  })
  it('the hum on the block: buildLevel glides it home (1, 1), the value it has always had there, so a quiet floor before it leaves no trace', () => {
    expect(NO_FEELING.hum).toBe(1)
    audio.setHum(1, feelOn('quiet').hum, FEEL.humS)
    audio.setHum(1, NO_FEELING.hum, FEEL.humS)                                    // what buildLevel does on arriving at the block
    const hum = humNode()
    expect(hum.gain.calls.at(-1)[1]).toBeCloseTo(0.018, 9)                        // audio.js HUM_GAIN: the hum's level at boot
    expect(humOsc().detune.calls.at(-1)[1]).toBe(0)                               // and its pitch: home
  })
})
