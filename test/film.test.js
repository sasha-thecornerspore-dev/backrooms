// film.js — the film is worth what it shows: a creature in the frame, close, with a clear line to you, develops on the polaroid and its
// den goes on your pencil sheet, once a kind a visit. The den is where it lives (its chunk's hall crossing) or, for a thing that followed
// you down, the cell it was caught in. compose-polaroid.js is not touched (its captions and the column's pins are the origins' and the
// claim's), and the den pin rides the map's save as any pin does: old maps load without one.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { DEN_RANGE, KINDS, DEN_LINE, denLine, denOf, createFilm } from '../src/renderer/film.js'
import { polaroidCaption, LINES } from '../src/renderer/compose-polaroid.js'
import { LEGACY, rulesFor } from '../src/renderer/origin-rules.js'
import { statusMods, STATUSES, depthOf } from '../src/renderer/status.js'
import { ORIGINS } from '../src/renderer/origin-intake.js'
import { createFogMap, buildMapView } from '../src/renderer/fogmap.js'
import { GLYPHS, drawMap } from '../src/renderer/mapcard.js'
import { inViewCone, lineOfSight } from '../src/renderer/raycaster.js'
import { HF } from '../src/renderer/gfx-frame.js'
import { chunkMid } from '../src/renderer/topology.js'
import { DREAD_W } from '../src/renderer/dread.js'
import { DEFAULT_CONFIG, CHUNK_SIZE, createChunkCache, createGridReader } from '../src/renderer/world.js'
import { levelConfig } from '../src/renderer/levels.js'
import { createEntitySystem } from '../src/renderer/entities.js'
import { formatAnchor } from '../src/renderer/anchor.js'

const src =(p) => readFileSync(new URL(p, import.meta.url), 'utf8')
const open = () => true
const losOn = (floor) => (ax, ay, bx, by) => lineOfSight(ax, ay, bx, by, floor)
const OPEN_LOS = losOn(open)
const opts = (over = {}) => ({ cone: inViewCone, hf: HF, los: OPEN_LOS, home: () => true, ...over })
const me = (x = 10.5, y = 10.5, angle = 0) => ({ x, y, angle })
// a creature as entities.js keeps it: where it stands, its kind, the chunk it was placed in
const thing = (variant, x, y, cx = Math.floor(x / CHUNK_SIZE), cy = Math.floor(y / CHUNK_SIZE)) => ({ x, y, variant, chunkCx: cx, chunkCy: cy })
const NUMBER_WORDS = /\b(zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|twenty|thirty|forty|fifty|hundred|thousand|first|second|third|once|twice)\b/

describe('the table', () => {
  it('the reach is five cells; the kinds are the seven creatures (dread.js weighs the same seven), as the bestiary names them', () => {
    expect(DEN_RANGE).toBe(5)
    expect([...KINDS].sort()).toEqual(Object.keys(DREAD_W).sort())
    expect(Object.isFrozen(KINDS)).toBe(true)
    const manual = src('../docs/manual.html')
    for (const k of KINDS) expect(manual, k).toContain(`<div class="name">${k}</div>`)
  })
  it('one line, the kind filled in: lowercase, no exclamation mark, no digits, no number words, short', () => {
    expect(DEN_LINE).toBe('the film develops the {kind}, and the hall it keeps to. you mark it on your map.')
    for (const k of KINDS) {
      const s = denLine(k)
      expect(s).toBe(`the film develops the ${k}, and the hall it keeps to. you mark it on your map.`)
      expect(s).toBe(s.toLowerCase())
      expect(s).not.toMatch(/[!0-9]/)
      expect(s).not.toMatch(NUMBER_WORDS)
      expect(s.length).toBeLessThan(90)
    }
    expect(denLine('thin')).toBeNull()                    // an apparition is not a creature: nothing to name
    expect(denLine(undefined)).toBeNull()
  })
})

describe('the den', () => {
  it('a creature that lives in its chunk keeps to the chunk\'s hall crossing; one that followed you down, to where it was caught', () => {
    const e = thing('hound', 14.2, 9.7, 0, 0)
    expect(denOf(e, () => true)).toEqual(chunkMid(0, 0))
    expect(denOf(e, () => false)).toEqual({ x: 14.5, y: 9.5 })
    const seen = []
    denOf(thing('hound', 30.1, -4.2, 1, -1), (cx, cy) => { seen.push([cx, cy]); return true })
    expect(seen).toEqual([[1, -1]])                       // asked about the chunk it was placed in, not the one it stands in now
    // one that followed you down (entities.inject marks it) lives nowhere here, even when it came down in a chunk that is another's home
    const f = { ...thing('hound', 14.2, 9.7, 0, 0), follower: true }
    const asked = []
    expect(denOf(f, (cx, cy) => { asked.push([cx, cy]); return true })).toEqual({ x: 14.5, y: 9.5 })
    expect(asked).toEqual([])
  })
  it('on a real floor: a thing that followed you down into a chunk where another lives is pinned where you caught it, not at that one\'s den', () => {
    for (const lvl of [1, 2, 3]) {
      const cfg = levelConfig(DEFAULT_CONFIG, lvl)
      const cache = createChunkCache(cfg, null)
      const isWall = (wx, wy, pcx, pcy) => cache.isWall(wx, wy, pcx, pcy)
      const grid = createGridReader(cache, isWall)
      let found = 0
      for (let k = 0; k < 400 && found < 3; k++) {
        const pcx = (k % 20) * 3, pcy = Math.floor(k / 20) * 3
        grid.setPlayerChunk(pcx, pcy); cache.preload(pcx, pcy)
        const sys = createEntitySystem(cfg, isWall, { grid, seed: 12345 })
        const nearX = pcx * CHUNK_SIZE + 11.5, nearY = pcy * CHUNK_SIZE + 11.5
        if (!grid.floor(Math.floor(nearX), Math.floor(nearY))) continue
        if (!sys.inject([{ type: 'stalker', variant: 'hound' }], nearX, nearY, 7, 10, 0)) continue
        sys.update(0, { x: nearX, y: nearY, angle: 0 }, pcx, pcy)              // it arrives (no delay)
        const f = sys.getEntities().find((e) => e.follower === true)
        if (!f || !sys.isSpawnChunk(f.chunkCx, f.chunkCy)) continue             // only the case at issue: it came down in a home chunk
        let v = null
        for (let j = 0; j < 64 && !v; j++) {
          const a = j / 64 * Math.PI * 2, r = 2.5 + (j % 5) * 0.5
          const x = Math.floor(f.x + Math.cos(a) * r) + 0.5, y = Math.floor(f.y + Math.sin(a) * r) + 0.5
          if (grid.floor(Math.floor(x), Math.floor(y)) && lineOfSight(x, y, f.x, f.y, grid.floor) && Math.hypot(f.x - x, f.y - y) <= DEN_RANGE) v = { x, y, angle: Math.atan2(f.y - y, f.x - x) }
        }
        if (!v) continue
        const d = createFilm().develop(v, [f], opts({ los: losOn(grid.floor), home: (cx, cy) => sys.isSpawnChunk(cx, cy) }))
        expect(d).not.toBeNull()
        expect({ x: d.x, y: d.y }, `L${lvl} ${f.x},${f.y}`).toEqual({ x: Math.floor(f.x) + 0.5, y: Math.floor(f.y) + 0.5 })
        expect(d.key).toBe(`den:${Math.floor(f.x)},${Math.floor(f.y)}`)
        found++
      }
      expect(found, `L${lvl}`).toBeGreaterThan(0)
    }
  })
  it('on a real floor: a spawned creature\'s den is its spawn chunk\'s hall crossing, open floor, a chunk that rolls a creature', () => {
    const cfg = levelConfig(DEFAULT_CONFIG, 1)
    const cache = createChunkCache(cfg, null)
    const isWall = (wx, wy, pcx, pcy) => cache.isWall(wx, wy, pcx, pcy)
    const grid = createGridReader(cache, isWall)
    const sys = createEntitySystem(cfg, isWall, { grid })
    let found = 0
    for (let c = 0; c < 6 && found < 3; c++) {
      grid.setPlayerChunk(c * 7, 0); cache.preload(c * 7, 0)
      sys.update(0, { x: c * 7 * CHUNK_SIZE + 11.5, y: 11.5, angle: 0 }, c * 7, 0)
      for (const e of sys.getEntities()) {
        // a vantage: an open cell 2.5..4.5 away with a clear line to it, facing it
        let v = null
        for (let k = 0; k < 64 && !v; k++) {
          const a = k / 64 * Math.PI * 2, r = 2.5 + (k % 5) * 0.5
          const x = Math.floor(e.x + Math.cos(a) * r) + 0.5, y = Math.floor(e.y + Math.sin(a) * r) + 0.5
          if (grid.floor(Math.floor(x), Math.floor(y)) && lineOfSight(x, y, e.x, e.y, grid.floor) && Math.hypot(e.x - x, e.y - y) <= DEN_RANGE) v = { x, y, angle: Math.atan2(e.y - y, e.x - x) }
        }
        if (!v) continue
        const film = createFilm()
        const d = film.develop(v, [e], opts({ los: losOn(grid.floor), home: (cx, cy) => sys.isSpawnChunk(cx, cy) }))
        expect(d, JSON.stringify([e.x, e.y, e.variant])).not.toBeNull()
        expect(sys.isSpawnChunk(e.chunkCx, e.chunkCy)).toBe(true)
        expect(e.follower).toBe(false)                    // the floor's own: it lives here
        expect({ x: d.x, y: d.y }).toEqual(chunkMid(e.chunkCx, e.chunkCy))
        expect(grid.floor(Math.floor(d.x), Math.floor(d.y))).toBe(true)
        expect([d.kind, d.line, d.key]).toEqual([e.variant, denLine(e.variant), `den:${Math.floor(d.x)},${Math.floor(d.y)}`])
        found++
      }
    }
    expect(found).toBeGreaterThan(0)
  })
})

describe('develop: in frame, within reach, with a clear line', () => {
  it('a hound four cells ahead develops once; again on this visit it does not; a smiler then does; a new visit lets the hound again', () => {
    const film = createFilm()
    const hound = thing('hound', 14.5, 10.5, 0, 0), smiler = thing('smiler', 13.5, 11.0, 0, 0)
    const d = film.develop(me(), [hound], opts())
    expect(d).toEqual({ key: 'den:11,11', kind: 'hound', x: 11.5, y: 11.5, line: denLine('hound') })
    expect(film.caught('hound')).toBe(true)
    expect(film.develop(me(), [hound], opts())).toBeNull()
    expect(film.develop(me(), [thing('hound', 12.5, 10.5)], opts())).toBeNull()      // another hound: the kind is spent this visit
    expect(film.develop(me(), [hound, smiler], opts())?.kind).toBe('smiler')
    expect(film.develop(me(), [hound, smiler], opts())).toBeNull()
    film.arrive()
    expect(film.caught('hound')).toBe(false)
    expect(film.develop(me(), [hound], opts())?.kind).toBe('hound')
  })
  it('the nearest creature whose kind is not spent yet; at most one den a shot', () => {
    const film = createFilm()
    const near = thing('watcher', 12.5, 10.5), far = thing('tesla', 14.5, 10.5)
    expect(film.develop(me(), [far, near], opts()).kind).toBe('watcher')
    expect(film.develop(me(), [far, near], opts()).kind).toBe('tesla')
    expect(film.develop(me(), [far, near], opts())).toBeNull()
  })
  it('a thing with no kind is a shade; a kind the bestiary does not know develops nothing and spends nothing', () => {
    const film = createFilm()
    expect(film.develop(me(), [{ x: 13.5, y: 10.5, chunkCx: 0, chunkCy: 0 }], opts()).kind).toBe('shade')
    expect(film.develop(me(), [thing('mimic', 13.5, 10.5)], opts())).toBeNull()
    expect(film.caught('mimic')).toBe(false)
  })
  it('out of reach does not: past five cells straight-line, even when the frame\'s forward reach is under five', () => {
    const film = createFilm()
    expect(film.develop(me(), [thing('hound', 15.6, 10.5)], opts())).toBeNull()
    expect(film.develop(me(), [thing('hound', 14.8, 13.4)], opts())).toBeNull()     // 4.3 forward, 2.9 aside: 5.2 away
    expect(film.develop(me(), [thing('hound', 15.4, 10.5)], opts())?.kind).toBe('hound')
  })
  it('out of frame does not: behind you, beside you, too close to the lens', () => {
    const film = createFilm()
    expect(film.develop(me(), [thing('hound', 7.5, 10.5)], opts())).toBeNull()
    expect(film.develop(me(), [thing('hound', 10.5, 14.5)], opts())).toBeNull()
    expect(film.develop(me(), [thing('hound', 10.6, 10.5)], opts())).toBeNull()
    expect(film.caught('hound')).toBe(false)
  })
  it('behind a wall does not (the walls\' line of sight); without a line of sight to ask, nothing develops', () => {
    const film = createFilm()
    const wall = (ix) => ix !== 12                                                   // a wall across the hall at x = 12
    expect(film.develop(me(), [thing('hound', 13.5, 10.5)], opts({ los: losOn(wall) }))).toBeNull()
    expect(film.develop(me(), [thing('hound', 13.5, 10.5)], opts({ los: null }))).toBeNull()
    expect(film.develop(me(), [thing('hound', 13.5, 10.5)], opts({ los: undefined }))).toBeNull()
    expect(film.develop(me(), [thing('hound', 11.8, 10.5)], opts({ los: losOn(wall) }))?.kind).toBe('hound')
  })
  it('no creatures, nothing to pin', () => {
    const film = createFilm()
    expect(film.develop(me(), [], opts())).toBeNull()
  })
  it('the frame is the photo\'s own: a closure handed in is not held past the call', () => {
    const film = createFilm()
    const o = opts()
    film.develop(me(), [thing('hound', 13.5, 10.5)], o)
    expect(o.los).toBe(OPEN_LOS)                                                     // the caller's options are not written to
  })
})

describe('compose-polaroid.js is as it was', () => {
  it('its lines, verbatim', () => {
    expect(LINES).toEqual({
      SUBJECT_DOWN: 'the film develops {name}, where they fell. they are counted.',
      SUBJECT_THIN: 'the film develops {name}. you can see the wall through them.',
      SUBJECT_PIN: 'the film develops {name}. the film shows your pin.',
      SUBJECT_PROCESSED: 'the film develops {name}. there is a stamp on them.',
      SUBJECT_ANCHORED: 'the film develops {name}. the film shows a pin, and a distance.',
      SUBJECT_TENANT: 'the film develops {name}. there is an address under them: woodyear st. the street goes on. not here.',
      SUBJECT_UNNAMED: 'the film develops {name}. the caption did not develop.',
      SUBJECT_UNKNOWN: 'the film develops {name}. the file has not finished with them.',
      SUBJECT_GLYPH: ' one letter developed beside them: "{g}".',
      SOUL_DOOR: 'the film shows them, and behind them, faintly, a door: {arrow}',
      SOUL_NONE: 'the film shows them, and nothing behind them.',
      THIN_NEAR: 'the film shows someone who was not in the room. you can see the wall through them.',
      EVIDENCE_SUFFIX: ' evidence.',
      HONEST_FILM: 'the film shows the hall as it is. nothing that was not in the room.',
      FINALIZING: 'the film shows the hall as it will finalize: darker, one door fewer.',
      GLYPH: 'the film develops one letter that was not in the room: "{g}". transcribe it.',
    })
  })
  it('every caption over every column, layer, status, subject, soul, floor and sanity: the digest taken at 2.0.4 (36ac9a4)', () => {
    const fnv = (s) => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0 } return h.toString(16).padStart(8, '0') }
    const subjects = [null,
      ...[null, ...ORIGINS].map((o) => ({ id: 'p', name: 'maddie', st: 'ok', thin: false, origin: o, aseed: null })),
      { id: 'p', name: 'maddie', st: 'down', thin: false, origin: 'tenant', aseed: null },
      { id: 'p', name: 'maddie', st: 'ok', thin: true, origin: 'anchored', aseed: null },
      { id: 'p', name: 'm$&ie', st: 'ok', thin: false, origin: 'processed', aseed: 7 }]
    const rows = []
    for (const origin of [null, ...ORIGINS]) for (const thin of [false, true]) {
      const rules = origin === null && !thin ? LEGACY : rulesFor(origin, thin)
      for (const status of STATUSES) for (const s of subjects) for (const soul of [null, { x: 1, y: 1 }]) for (const arrow of [null, '↗'])
        for (const thinNear of [false, true]) for (let index = 0; index <= 4; index++) for (const sanity of [0, 39, 40, 100])
          for (const first of [false, true]) for (const photoIdx of [0, 5]) {
            const ctx = { rules, mods: statusMods(status), subject: s, soul, doorArrow: arrow, thinNear, status, index, depth: depthOf(index), sanity,
              origin, thin, thinFirstShot: first, anchor: origin === 'anchored' ? { lat: 51.5, lng: -0.12 } : null, pinTag: 7, D: 42, firstShotOfLevel: first,
              photoIdx, player: { x: 3.5, y: 4.5 }, lvl: index }
            rows.push(JSON.stringify(polaroidCaption(ctx)))
          }
    }
    expect(rows.length).toBe(230400)
    // 2.0.7 (decision 3): the pin caption says where the body lies in words, not its numbers. Put the numbers back where the words are and
    // every caption is 2.0.4's, byte for byte: nothing else moved (these subjects carry no word, so the photo's word adds nothing either)
    const words = 'the film shows where you fell through.', pin = 'the film shows ' + formatAnchor({ lat: 51.5, lng: -0.12 }) + '.'
    expect(rows.some((r) => r.includes(words))).toBe(true)
    expect(rows.every((r) => !/\d\.\d{4}/.test(r))).toBe(true)
    expect(fnv(rows.map((r) => r.split(words).join(pin)).join('\n'))).toBe('cfe8501d')
  })
  it('the film\'s den is a step of its own: film.js reads no caption, and compose-polaroid.js knows nothing of dens', () => {
    const film = src('../src/renderer/film.js'), cp = src('../src/renderer/compose-polaroid.js')
    const imports = (s) => s.split(/\r?\n/).filter((l) => /^import /.test(l))
    expect(imports(film)).toEqual(["import { inFrame } from './evidence.js'", "import { chunkMid } from './topology.js'"])
    expect(film.replace(/^\/\/.*$/gm, '')).not.toMatch(/polaroidCaption|LINES\b/)
    expect(cp).not.toMatch(/\bden\b|film\.js/)
    const code = film.replace(/\/\/.*$/gm, '')
    expect(code).not.toMatch(/\b(document|window|getPref|localStorage|bus|emit|fetch|Math\.random|performance)\b/)   // pure: no DOM, no prefs, no wire, no clock
  })
})

describe('the den on the pencil sheet', () => {
  it('a den pin is drawn in the map\'s own glyph style', () => {
    expect(GLYPHS.den).toBe('⌂')
    expect(Object.values(GLYPHS).filter((g) => g === GLYPHS.den)).toHaveLength(1)    // its own mark, no other thing's
    const fog = createFogMap()
    fog.step(1, 10.5, 10.5, 2, open)
    fog.pinThing(1, 'den:11,11', 'den', 11.5, 11.5, 'hound')
    const view = buildMapView(fog, 1, me(), { cells: 56 })
    const texts = []
    const ctx = { fillRect() {}, save() {}, restore() {}, translate() {}, rotate() {}, beginPath() {}, moveTo() {}, lineTo() {}, fill() {}, fillText: (t) => texts.push(t) }
    drawMap(ctx, view, {})
    expect(texts).toEqual([GLYPHS.den])
  })
  it('export / import round-trips the den pin: its kind, where it is, its order', () => {
    const fog = createFogMap()
    fog.step(1, 10.5, 10.5, 2, open)
    fog.pinThing(1, 'arrived:3', 'arrived', 10.5, 10.5)
    const p = fog.pinThing(1, 'den:11,11', 'den', 11.5, 11.5, 'hound')
    fog.pinThing(2, 'den:33,-11', 'den', 33.5, -10.5, 'lurker')
    const a = JSON.parse(JSON.stringify(fog.export()))
    expect(a[1].pins).toContainEqual(['den:11,11', 'den', 11.5, 11.5, 'hound', p.t, false])
    const fog2 = createFogMap()
    expect(fog2.import(a)).toBe(true)
    const q = fog2.pins(1).get('den:11,11')
    expect([q.type, q.x, q.y, q.flag, q.t, q.lost]).toEqual(['den', 11.5, 11.5, 'hound', p.t, false])
    expect(fog2.pins(2).get('den:33,-11').flag).toBe('lurker')
    expect(fog2.ways(1)).toEqual([])                                                 // a den is never a way: the compass never points at one
    expect(fog2.export()).toEqual(a)
    // the same den again (a later visit) is the same pin, moved nowhere, never a second one
    fog2.pinThing(1, 'den:11,11', 'den', 11.5, 11.5, 'hound')
    expect([...fog2.pins(1).values()].filter((r) => r.type === 'den')).toHaveLength(1)
  })
  it('an old map (no den anywhere) loads as it did, and gains nothing', () => {
    const old = createFogMap()
    old.step(0, 50.5, 50.5, 2, open); old.step(1, 10.5, 10.5, 2, open)
    old.pinWay(1, { key: '0,0', kind: 'down', x: 12.5, y: 10.5, target: 2, label: 'descend' })
    old.pinThing(1, 'm:a', 'machine', 9.5, 10.5, true)
    old.pinThing(1, 'hurt:9', 'hurt', 10.5, 11.5)
    const saved = JSON.parse(JSON.stringify(old.export()))
    const fog = createFogMap()
    expect(fog.import(saved)).toBe(true)
    expect(fog.export()).toEqual(saved)
    for (const L of [0, 1]) expect([...fog.pins(L).values()].some((r) => r.type === 'den')).toBe(false)
    expect(fog.import({})).toBe(true)                                                // a run that never drew
  })
})
