// The film's wiring (M6, film is worth what it shows): game.js keeps one film (film.js) and one hoisted frame for it, lets the caught kinds
// go when a visit begins, and after the polaroid's caption runs the den as a step of its own: a creature in the frame, close, with a clear
// line, goes on your sheet as a 'den' pin (fogmap.js) and the film names it, once a kind a visit. Never on the block, never with the
// creatures pref off, never on the wire. The photo's own result, so, as the caption, free of the plate budget; said as what you found
// (discovery: never dropped, after the photo's own lines), since a third interaction line from one shot pushes the flash's line out of the
// queue whenever a combat line is up. game.js only boots in a page, so these are source guards plus the pieces lifted out of game.js and
// replayed against the real modules.
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import { createFilm, denLine } from '../src/renderer/film.js'
import { createFogMap } from '../src/renderer/fogmap.js'
import { createPlateBudget, FREE_KINDS, ARRIVAL_KINDS, UNPROMPTED_KINDS } from '../src/renderer/plates.js'
import { PRIO, createMessageQueue } from '../src/renderer/messages.js'
import { inViewCone, lineOfSight } from '../src/renderer/raycaster.js'
import { HF } from '../src/renderer/gfx-frame.js'
import { chunkMid, BLOCK } from '../src/renderer/topology.js'

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8')
const game = read('../src/renderer/game.js')
const at = (s, from = 0) => { const k = game.indexOf(s, from); expect(k, s).toBeGreaterThan(0); return k }
const slice = (from, to) => { const a = at(from), b = game.indexOf(to, a); expect(b, to).toBeGreaterThan(a); return game.slice(a, b) }
const count = (re) => (game.match(re) || []).length
const lift = (re) => { const m = game.match(re); expect(m, String(re)).not.toBeNull(); return m[0] }
const loopAt = game.indexOf('function loop(ts) {')
const PLATE = /function plate\(kind, text, prio, keep = true\) \{[\s\S]*?\r?\n {2}\}/
const VISIT = /function startVisit\(\) \{[\s\S]*?\r?\n {2}\}/
const LATER = /function later\(ms, text, prio, keep = true\) \{[^\n]*\}/
const DEN = /function developDen\(\) \{[\s\S]*?\r?\n {2}\}/
const LOS = 'const frameLos = (ax, ay, bx, by) => lineOfSight(ax, ay, bx, by, level.grid.floor)'
const OPTS = 'const DEN_OPTS = { cone: inViewCone, hf: HF, los: frameLos, home: (cx, cy) => level.entitySys.isSpawnChunk(cx, cy) }'

describe('the film\'s state and its frame', () => {
  it('imports film.js by its real name; one film and one hoisted frame, outside the loop, the frame after the walls\' line it reads', () => {
    expect(game).toMatch(/import \{ polaroidCaption \} from '\.\/compose-polaroid\.js'\r?\n\s*import \{ createFilm \} from '\.\/film\.js'/)
    for (const s of ['const film = createFilm()', OPTS]) { expect(at(s)).toBeLessThan(loopAt); expect(game.split(s).length - 1, s).toBe(1) }
    expect(count(/createFilm\(/g)).toBe(1)
    expect(at(LOS)).toBeLessThan(at(OPTS))
  })
  it('film.js is in src/sw.js and tools/build-play.sh', () => {
    expect(read('../src/sw.js')).toContain("'/renderer/film.js'")
    expect(read('../tools/build-play.sh')).toContain("'film.js'")
  })
})

describe('a visit lets the caught kinds go', () => {
  it('startVisit ends by letting every kind develop again; nothing else does', () => {
    expect(lift(VISIT)).toMatch(/teller\.reset\(\); fieldOn = false; dreadOut\.dread = 0; fxLeft = 0\r?\n\s*film\.arrive\(\)[^\n]*\r?\n {2}\}$/)
    expect(count(/film\.arrive\(\)/g)).toBe(1)
    expect(count(/film\.develop\(/g)).toBe(1)
  })
})

describe('the photo develops its den after the caption', () => {
  it('firePolaroid says the caption, then runs the den, once; the caption is composed as it was', () => {
    const fire = slice('function firePolaroid() {', 'function knownWayArrow() {')
    expect(fire).toMatch(/showMessage\(r\.cap\)\r?\n\s*developDen\(\)[^\n]*\r?\n {2}\}/)
    expect(fire.indexOf('polaroidCaption(')).toBeLessThan(fire.indexOf('developDen()'))
    expect(count(/developDen\(\)/g)).toBe(2)                                           // its declaration and the photo
    expect(at('function developDen() {')).toBeLessThan(at('function firePolaroid() {'))
  })
  it('the den: not on the block, not with the creatures pref off; a \'den\' pin with its kind; said as a find, no plate, nothing sent', () => {
    const den = lift(DEN)
    expect(den).toMatch(/\{\r?\n\s*if \(level\.cfg\.map \|\| !getPref\('creatures'\)\) return\r?\n\s*const d = film\.develop\(player, level\.entitySys\.getEntities\(\), DEN_OPTS\)\r?\n\s*if \(!d\) return\r?\n\s*fog\.pinThing\(level\.index, d\.key, 'den', d\.x, d\.y, d\.kind\)\r?\n\s*showMessage\(d\.line, PRIO\.discovery\)\r?\n {2}\}$/)
    expect(den).not.toMatch(/plate\(|later\(|bus|emit|sendEv|mpClient|persist/)
  })
})

// developDen and the frame it reads, lifted with the real film and the real sheet, on a floor stub: what the photo leaves behind
function rig({ map = null, creatures = true, ents = [], floor = () => true, home = () => true, index = 1 } = {}) {
  const said = [], fog = createFogMap(), film = createFilm()
  const level = { index, cfg: { map }, grid: { floor }, entitySys: { getEntities: () => ents, isSpawnChunk: home } }
  const player = { x: 10.5, y: 10.5, angle: 0 }
  const fn = new Function('level', 'player', 'film', 'fog', 'getPref', 'showMessage', 'PRIO', 'inViewCone', 'HF', 'lineOfSight',
    `${LOS}\n${OPTS}\n${lift(DEN)}\nreturn developDen`)(level, player, film, fog, (k) => (k === 'creatures' ? creatures : true), (t, p) => said.push([t, p]), PRIO, inViewCone, HF, lineOfSight)
  const dens = () => [...fog.pins(index).values()].filter((p) => p.type === 'den').map((p) => [p.key, p.x, p.y, p.flag])
  return { shoot: fn, said, fog, film, dens, level, player }
}
const hound = (x = 14.5, y = 10.5) => ({ x, y, variant: 'hound', chunkCx: 0, chunkCy: 0 })

describe('replayed: the den the photo leaves', () => {
  it('a hound four cells ahead: its den on your sheet at its chunk\'s hall crossing, and the line, as a find; once a visit', () => {
    const r = rig({ ents: [hound()] })
    r.shoot()
    const m = chunkMid(0, 0)
    expect(r.dens()).toEqual([[`den:${Math.floor(m.x)},${Math.floor(m.y)}`, m.x, m.y, 'hound']])
    expect(r.said).toEqual([[denLine('hound'), PRIO.discovery]])
    r.shoot()
    expect(r.said).toHaveLength(1)
    r.film.arrive()                                                                      // what startVisit does
    r.shoot()
    expect(r.said).toHaveLength(2); expect(r.dens()).toHaveLength(1)                     // the same den: the same pin
  })
  it('a thing that followed you down keeps to where it was caught', () => {
    const r = rig({ ents: [hound(13.7, 10.2)], home: () => false })
    r.shoot()
    expect(r.dens()).toEqual([['den:13,10', 13.5, 10.5, 'hound']])
  })
  it('behind a wall (the floor\'s own grid), out of reach, or behind you: nothing', () => {
    for (const o of [{ ents: [hound(13.5, 10.5)], floor: (ix) => ix !== 12 }, { ents: [hound(16.5, 10.5)] }, { ents: [hound(6.5, 10.5)] }]) {
      const r = rig(o)
      r.shoot()
      expect([r.said, r.dens()]).toEqual([[], []])
    }
  })
  it('with the creatures pref off, nothing to pin; on the block, nothing at all', () => {
    for (const o of [{ creatures: false }, { map: { cells: [] }, index: BLOCK }]) {
      const r = rig({ ents: [hound()], ...o })
      r.shoot()
      expect([r.said, r.dens(), r.film.caught('hound')]).toEqual([[], [], false])
    }
  })
})

describe('replayed with the real message queue: the den never pushes the photo\'s own lines out', () => {
  const FLASH = 'the flash catches it. it reels, blind.'
  const CAP = 'the film shows the hall as it will finalize: darker, one door fewer.'
  // what firePolaroid says, in its order: the flash's line on a hit, the caption, then the den (lifted, real film and sheet)
  const shot = (msgQ) => { const r = rig({ ents: [hound()] }); msgQ.push(FLASH, PRIO.interaction); msgQ.push(CAP); r.said.length = 0
    const fn = new Function('level', 'player', 'film', 'fog', 'getPref', 'showMessage', 'PRIO', 'inViewCone', 'HF', 'lineOfSight',
      `${LOS}\n${OPTS}\n${lift(DEN)}\nreturn developDen`)(r.level, r.player, r.film, r.fog, () => true, (t, p) => msgQ.push(t, p), PRIO, inViewCone, HF, lineOfSight)
    fn() }
  const ticks = (msgQ, s) => { const out = []; for (let i = 0; i < s * 10; i++) { const r = msgQ.tick(0.1); if (r?.show) out.push(r.text) } return out }
  it('firePolaroid says the flash\'s line and the caption at interaction (the order the queue sees them)', () => {
    const fire = slice('function firePolaroid() {', 'function knownWayArrow() {')
    expect(fire).toContain(`if (b.hit) showMessage('${FLASH}', PRIO.interaction)`)
    expect(fire.indexOf(`showMessage('${FLASH}'`)).toBeLessThan(fire.indexOf('showMessage(r.cap)'))
    expect(fire.indexOf('showMessage(r.cap)')).toBeLessThan(fire.indexOf('developDen()'))
  })
  for (const up of [null, ['it has seen you.', PRIO.combat], ['level one.', PRIO.combat], ['the hint.', PRIO.discovery]]) {
    it(`with ${up ? `'${up[0]}' up` : 'nothing up'}: the flash's line, the caption and the den all show, in that order`, () => {
      const msgQ = createMessageQueue()
      if (up) { msgQ.push(...up); ticks(msgQ, 0.2) }
      shot(msgQ)
      const seen = ticks(msgQ, 30)
      expect(seen).toEqual([FLASH, CAP, denLine('hound')])
    })
  }
  it('(why not interaction: as a third interaction line under a combat line, it would have dropped the flash\'s line)', () => {
    const msgQ = createMessageQueue()
    msgQ.push('it has seen you.', PRIO.combat); ticks(msgQ, 0.2)
    msgQ.push(FLASH, PRIO.interaction); msgQ.push(CAP); msgQ.push(denLine('hound'), PRIO.interaction)
    expect(ticks(msgQ, 30)).toEqual([CAP, denLine('hound')])
  })
})

// the plate wrapper, later(), startVisit, the den and the frame lifted together on a play clock with the real budget and the real queue;
// a photo is what firePolaroid says: its caption (showMessage, interaction), then developDen. Every plate the budget admits is recorded
function arrival({ ents }) {
  const shown = [], timers = [], admitted = []
  let now = 0
  const msgQ = createMessageQueue()
  const budget = createPlateBudget()
  const plates = { arrive: (t) => budget.arrive(t), drain: (t) => budget.drain(t),
    admit: (kind, t, line) => { const v = budget.admit(kind, t, line); if (v === 'show' && !FREE_KINDS.includes(kind)) admitted.push([t, kind, line]); return v } }
  const fog = createFogMap(), film = createFilm()
  const level = { index: 1, cfg: { map: null }, grid: { floor: () => true }, entitySys: { getEntities: () => ents, isSpawnChunk: () => true } }
  const player = { x: 10.5, y: 10.5, angle: 0 }
  const drain = slice('const held = plates.drain(playT)', '// ── Living Atmosphere')
  const h = new Function('plates', 'showMessage', 'setTimeout', 'PRIO', 'msgQ', 'level', 'player', 'film', 'fog', 'getPref', 'inViewCone', 'HF', 'lineOfSight',
    'let playT = 0, arrivalGen = 0, floorT0 = 0, floorHinted = false, pullPhase = 0, lostSaid = false, hintHeld = false\n' +
    'let dreadQuietT = 0, sanity = 100, fieldOn = false, fxLeft = 0\nconst eventSched = { arrive() {} }, teller = { reset() {} }, dreadOut = { dread: 0 }\n' +
    `${LOS}\n${OPTS}\n${lift(PLATE)}\n${lift(LATER)}\n${lift(VISIT)}\n${lift(DEN)}\nfunction drainFrame() {\n${drain}\n}\n` +
    'function photo(cap) { showMessage(cap); developDen() }\n' +
    'return { plate, later, startVisit, photo, drainFrame, set: (t) => { playT = t } }')(plates, (t, p = PRIO.interaction) => msgQ.push(t, p),
    (f, ms) => timers.push({ ms: now * 1000 + ms, f, done: false }), PRIO, msgQ, level, player, film, fog, () => true, inViewCone, HF, lineOfSight)
  const run = (to, events = {}) => {
    for (; now <= to + 1e-9; now = Math.round((now + 0.1) * 10) / 10) {
      h.set(now)
      for (const t of timers) if (!t.done && t.ms / 1000 <= now + 1e-9) { t.done = true; t.f() }
      if (events[now]) events[now]()
      h.drainFrame()
      const r = msgQ.tick(0.1); if (r?.show) shown.push([now, r.text])
    }
  }
  return { h, shown, admitted, run }
}

describe('replayed with the real plates.js: the den line is the photo\'s, so an arrival still puts up two plates at most in 45 s', () => {
  it('a photo in an arrival\'s first seconds: the caption and the den say themselves, no plate is spent, and the window\'s two still hold', () => {
    const { h, shown, admitted, run } = arrival({ ents: [hound()] })
    h.startVisit()
    h.plate('floor', 'level one.', PRIO.combat)
    h.later(3800, 'the hint.', PRIO.discovery)
    run(44.9, { 6: () => h.photo('the film shows the hall as it will finalize: darker, one door fewer.'),
      12: () => h.plate('event', 'a door, somewhere.', PRIO.ambient, false), 30: () => h.plate('murmur', 'the carpet is damp.', PRIO.ambient, false) })
    expect(shown.map((s) => s[1])).toEqual(['level one.', 'the hint.', 'the film shows the hall as it will finalize: darker, one door fewer.', denLine('hound')])
    expect(admitted.filter((a) => a[0] < 45).map((a) => a[1])).toEqual(['floor', 'arrival'])
    expect(admitted.length).toBeLessThanOrEqual(2)
    // the line's kind: never a budgeted one (it is said as the caption is, through showMessage)
    for (const k of [...ARRIVAL_KINDS, ...UNPROMPTED_KINDS]) expect(lift(DEN)).not.toContain(`'${k}'`)
  })
  it('a second visit: the window opens again, the hound develops again, and the window\'s two still hold', () => {
    const { h, shown, admitted, run } = arrival({ ents: [hound()] })
    h.startVisit(); h.plate('floor', 'level one.', PRIO.combat)
    run(60, { 6: () => h.photo('cap one.'), 20: () => h.photo('cap two.') })
    expect(shown.filter((s) => s[1] === denLine('hound'))).toHaveLength(1)                     // once a kind a visit
    run(130, { 100: () => { h.startVisit(); h.plate('floor', 'level one.', PRIO.combat) }, 104: () => h.photo('cap three.'),
      110: () => h.plate('event', 'a door.', PRIO.ambient, false), 120: () => h.plate('event', 'a door again.', PRIO.ambient, false) })
    expect(shown.filter((s) => s[1] === denLine('hound'))).toHaveLength(2)
    expect(admitted.filter((a) => a[0] >= 100 && a[0] < 145).length).toBeLessThanOrEqual(2)
  })
})
