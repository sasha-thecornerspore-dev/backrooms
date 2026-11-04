// feelings.js — a floor's feeling for one visit: the roll (deterministic in the world seed, the floor and the visit), the rules that keep
// it off (the block, a room, the lobby's first visit and the first run's thread, the kill switch, a repeat), the dark's overlay (only the
// lights and the lighting recipe; darker, never brighter, and still readable), the quiet's multipliers, and the passer's hand over the
// drawers and the chairs. The identity: a visit that does not feel leaves the cfg exactly levelConfig's.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  FEEL, FEELINGS, FEELING_IDS, FEEL_PATHS, NO_FEELING, rawFeeling, feelingFor, applyFeeling, handOf, markPassage,
} from '../src/renderer/feelings.js'
import { CHANNELS } from '../src/renderer/channels.js'
import { levelConfig, LEVELS } from '../src/renderer/levels.js'
import { DEFAULT_CONFIG, createChunkCache } from '../src/renderer/world.js'
import { LEVEL_LIGHTING, resolveLighting } from '../src/renderer/gfx-light.js'
import { CONTAINER_TYPES, createSearchLog } from '../src/renderer/containers.js'
import { createDecorSystem } from '../src/renderer/decor.js'
import { dressPass } from '../src/renderer/dress.js'
import { hauntsPass } from '../src/renderer/haunts.js'
import { stairsPass, waysFor } from '../src/renderer/topology.js'
import { LEGACY, rulesFor, RULE_KEYS } from '../src/renderer/origin-rules.js'
import { statusMods, STATUSES, WORDS } from '../src/renderer/status.js'
import { createEventScheduler, eventInterval, ARRIVAL } from '../src/renderer/events.js'

const src = readFileSync(new URL('../src/renderer/feelings.js', import.meta.url), 'utf8')
const cfgOf = (i, base = DEFAULT_CONFIG) => levelConfig(base, i)
const FLOORS = [0, 1, 2, 3]
const ON = { room: false, thread: false, on: true }

describe('the table', () => {
  it('three feelings, each with its one line: lowercase, short, no exclamation mark, no digit, no number word', () => {
    expect(FEELING_IDS).toEqual(['dark', 'quiet', 'passage'])
    expect(FEELINGS.dark.line).toBe('the lights are out here.')
    expect(FEELINGS.quiet.line).toBe('it is very quiet.')
    expect(FEELINGS.passage.line).toBe('someone came through here before you.')
    const words = new RegExp(`\\b(${WORDS.join('|')}|hundred|thousand|first|second|third|once|twice)\\b`)
    for (const id of FEELING_IDS) {
      const l = FEELINGS[id].line
      expect(l).toBe(l.toLowerCase()); expect(l).not.toMatch(/[!\d]/); expect(l).not.toMatch(words); expect(l.split(' ').length).toBeLessThanOrEqual(7)
      expect(l.endsWith('.')).toBe(true)
    }
  })
  it('is frozen data, and the only cfg paths the overlay may write are the lights and the lighting recipe', () => {
    for (const o of [FEEL, FEELINGS, FEELING_IDS, FEEL_PATHS, NO_FEELING, ...Object.values(FEELINGS), ...Object.values(FEELINGS.dark.light)]) expect(Object.isFrozen(o)).toBe(true)
    expect(FEEL_PATHS).toEqual(['lights', 'look.lighting', 'messages'])
  })
  it('the quiet lowers the hum a little and spreads the events and the murmurs; every other record leaves all three at 1', () => {
    const q = FEELINGS.quiet
    expect(q.hum).toBeGreaterThan(0.4); expect(q.hum).toBeLessThan(1)
    expect(q.events).toBeGreaterThan(1); expect(q.events).toBeLessThanOrEqual(3)
    expect(q.murmurs).toBeGreaterThan(1); expect(q.murmurs).toBeLessThanOrEqual(3)
    expect(NO_FEELING).toMatchObject({ id: null, line: null, events: 1, murmurs: 1, hum: 1 })
  })
  it('the line\'s two moments sit where the arrival leaves a plate: ahead of the 3.8 s lines, or after every line an arrival says', () => {
    expect(FEEL.aheadMs).toBeGreaterThan(2600); expect(FEEL.aheadMs).toBeLessThan(3800)
    expect(FEEL.afterMs).toBeGreaterThan(7800); expect(FEEL.afterMs).toBeLessThan(9500)
  })
  it('its own hash channel, appended last; it reads no other channel and no epoch', () => {
    expect(Object.keys(CHANNELS).at(-1)).toBe('feelings')
    expect(CHANNELS.feelings.gate).toHaveLength(2); expect(CHANNELS.feelings.pick).toHaveLength(2); expect(CHANNELS.feelings.rng).toHaveLength(4)
    expect(src).not.toMatch(/CHANNELS\.(?!feelings\b)\w+/)
    expect(src).not.toMatch(/epoch/i)
    expect(src).not.toMatch(/SCRAPS|fragmentAt/)
  })
})

describe('the roll', () => {
  it('is deterministic in the world seed, the floor and the visit: the same arrivals feel the same', () => {
    for (const seed of [0, 1, 7, 123456, -42]) for (const level of FLOORS) for (let visit = 1; visit <= 12; visit++) {
      expect(rawFeeling(seed, level, visit)).toBe(rawFeeling(seed, level, visit))
      expect(feelingFor({ seed, level, visit, ...ON })).toEqual(feelingFor({ seed, level, visit, ...ON }))
    }
    // a null seed (the fixed first world) is seed 0
    expect(feelingFor({ seed: null, level: 2, visit: 5, ...ON })).toEqual(feelingFor({ seed: 0, level: 2, visit: 5, ...ON }))
  })
  it('the fixed first world\'s sequence is pinned (a change to the roll moves every replay: it must be meant)', () => {
    // (picked so a fixed-world run's first loop down is the floors as they are, and its first way back to the lobby finds the lights out)
    const seq = (level) => Array.from({ length: 10 }, (_, i) => feelingFor({ seed: null, level, visit: i + 1, ...ON }).id ?? '-').join(' ')
    expect(FLOORS.map(seq)).toEqual([
      '- dark - - - - - dark - passage',
      '- - passage - - dark - quiet - -',
      '- - quiet passage - dark - dark - -',
      '- - - passage - - - quiet - -',
    ])
  })
  it('about one arrival in three feels, the three about evenly', () => {
    let n = 0, felt = 0
    const by = { dark: 0, quiet: 0, passage: 0 }
    for (let seed = 0; seed < 400; seed++) for (const level of [1, 2, 3]) for (let visit = 1; visit <= 12; visit++) {
      n++
      const f = feelingFor({ seed, level, visit, ...ON })
      if (f.id) { felt++; by[f.id]++ }
    }
    expect(felt / n).toBeGreaterThan(0.29); expect(felt / n).toBeLessThan(0.37)
    for (const id of FEELING_IDS) { expect(by[id] / felt, id).toBeGreaterThan(0.27); expect(by[id] / felt, id).toBeLessThan(0.4) }
  })
  it('never the same feeling on two consecutive visits to one floor', () => {
    for (let seed = 0; seed < 300; seed++) for (const level of FLOORS) {
      let prev = null
      for (let visit = 1; visit <= 40; visit++) {
        const id = feelingFor({ seed, level, visit, ...ON }).id
        if (id) expect(id, `${seed}/${level}/${visit}`).not.toBe(prev)
        prev = id
      }
    }
  })
  it('a visit that feels carries the record game.js reads: the line, the multipliers, where and when', () => {
    let seen = 0
    for (let visit = 2; visit < 60 && seen < 3; visit++) {
      const f = feelingFor({ seed: 9, level: 1, visit, ...ON })
      if (!f.id) continue
      seen++
      expect(f).toMatchObject({ line: FEELINGS[f.id].line, level: 1, visit, seed: 9 })
      if (f.id === 'quiet') expect(f).toMatchObject({ events: FEELINGS.quiet.events, murmurs: FEELINGS.quiet.murmurs, hum: FEELINGS.quiet.hum })
      else expect(f).toMatchObject({ events: 1, murmurs: 1, hum: 1 })
      expect(Object.isFrozen(f)).toBe(true)
    }
    expect(seen).toBe(3)
  })
})

describe('never', () => {
  // the visits a roll would feel on (so every rule below is shown taking a real feeling away)
  const feltAt = (level, seed = 3) => { for (let v = 2; v < 80; v++) if (feelingFor({ seed, level, visit: v, ...ON }).id) return v; throw new Error('none') }
  it('on the block, off the four floors, or with no real visit', () => {
    for (const level of [4, '∅', -1, 5, null, undefined, 1.5]) for (let visit = 0; visit < 30; visit++) {
      expect(rawFeeling(0, level, visit)).toBeNull()
      expect(feelingFor({ seed: 0, level, visit, ...ON })).toBe(NO_FEELING)
    }
    for (const visit of [0, -1, 1.5, NaN, undefined]) expect(feelingFor({ seed: 0, level: 1, visit, ...ON })).toBe(NO_FEELING)
    // and the overlay never touches the block's cfg, whatever it is handed
    const B = cfgOf(4), before = JSON.parse(JSON.stringify(B))
    for (let v = 2; v < 40; v++) applyFeeling(B, feelingFor({ seed: 0, level: 2, visit: v, ...ON }))
    expect(JSON.parse(JSON.stringify(B))).toEqual(before)
  })
  it('in a multiplayer room', () => {
    for (const level of FLOORS) for (let visit = 1; visit < 40; visit++) expect(feelingFor({ seed: 5, level, visit, room: true, thread: false, on: true })).toBe(NO_FEELING)
  })
  it('on the lobby\'s first visit of a run, nor while the first run\'s thread can still advance there; other floors\' first visits may', () => {
    for (let seed = 0; seed < 500; seed++) expect(feelingFor({ seed, level: 0, visit: 1, ...ON })).toBe(NO_FEELING)
    const v = feltAt(0)
    expect(feelingFor({ seed: 3, level: 0, visit: v, ...ON }).id).not.toBeNull()
    expect(feelingFor({ seed: 3, level: 0, visit: v, room: false, thread: true, on: true })).toBe(NO_FEELING)
    let firsts = 0
    for (let seed = 0; seed < 300; seed++) for (const level of [1, 2, 3]) if (feelingFor({ seed, level, visit: 1, ...ON }).id) firsts++
    expect(firsts).toBeGreaterThan(0)
  })
  it('with the kill switch off: world.json `feelings: false`, read through levelConfig', () => {
    const v = feltAt(2)
    expect(feelingFor({ seed: 3, level: 2, visit: v, ...ON }).id).not.toBeNull()
    for (const i of FLOORS) expect(cfgOf(i).feelings).toBe(true)                                       // absent: on
    for (const i of FLOORS) expect(cfgOf(i, { ...DEFAULT_CONFIG, feelings: true }).feelings).toBe(true)
    const off = { ...DEFAULT_CONFIG, feelings: false }
    for (const i of [...FLOORS, 4]) expect(cfgOf(i, off).feelings).toBe(false)
    expect(feelingFor({ seed: 3, level: 2, visit: v, room: false, thread: false, on: cfgOf(2, off).feelings })).toBe(NO_FEELING)
    // the shipped world.json carries the switch, on
    const shipped = JSON.parse(readFileSync(new URL('../src/renderer/world.json', import.meta.url), 'utf8'))
    expect(shipped.feelings).toBe(true)
  })
})

describe('the overlay', () => {
  // every visit of a few seeds on a floor: the dark ones, and the rest
  const visits = (level, want) => {
    const out = []
    for (let seed = 0; seed < 40 && out.length < 4; seed++) for (let v = 1; v < 30 && out.length < 4; v++) {
      const f = feelingFor({ seed, level, visit: v, ...ON })
      if (want === null ? f.id !== 'dark' : f.id === want) out.push(f)
    }
    return out
  }
  it('identity: a visit that is not dark (no feeling, the quiet, the passage) leaves the cfg exactly levelConfig\'s, and the same object', () => {
    for (const i of FLOORS) {
      for (const f of [NO_FEELING, ...visits(i, 'quiet'), ...visits(i, 'passage'), null, undefined]) {
        const cfg = cfgOf(i)
        expect(applyFeeling(cfg, f)).toBe(cfg)
        expect(cfg).toEqual(cfgOf(i))
      }
    }
  })
  it('the dark writes the lights and the lighting recipe and nothing else: the maze, the denominators, the items, the fog and the flicker stay', () => {
    for (const i of FLOORS) {
      const [f] = visits(i, 'dark')
      expect(f, String(i)).toBeTruthy()
      const was = cfgOf(i), cfg = cfgOf(i)
      expect(applyFeeling(cfg, f)).toBe(cfg)
      const changed = Object.keys(cfg).filter((k) => JSON.stringify(cfg[k]) !== JSON.stringify(was[k]))
      expect(changed.sort(), String(i)).toEqual(i <= 1 ? ['lights', 'look', 'messages'] : ['look'])
      expect(cfg.lights).toBe(false)
      expect(Object.keys(cfg.look)).toEqual(['lighting'])
      expect(cfg.look.lighting).toEqual(FEELINGS.dark.light[i])
      for (const k of ['maze', 'entities', 'items', 'props', 'scraps', 'machines', 'sights', 'dress', 'haunts', 'exit', 'fogDistance', 'flicker', 'palette', 'music', 'particles'])
        expect(cfg[k], `${i}.${k}`).toEqual(was[k])
      // the murmurs: the floor's own, less only the ones that would say the lights are on
      expect(cfg.messages).toEqual(was.messages.filter((m) => !FEELINGS.dark.mute.includes(m)))
      expect(cfg.messages.length).toBeGreaterThanOrEqual(was.messages.length - 2)
      // a recipe already there is kept under it (a grant's look survives)
      const own = cfgOf(i); own.look = { wall: 'x', lighting: { warmth: 0.5 } }
      applyFeeling(own, f)
      expect(own.look).toEqual({ wall: 'x', lighting: { warmth: 0.5, ...FEELINGS.dark.light[i] } })
    }
  })
  it('the spawn denominators and the maze knobs are the floor\'s own with any feeling, so every placement golden holds', () => {
    for (const i of FLOORS) for (const f of [...visits(i, 'dark'), ...visits(i, 'quiet'), ...visits(i, 'passage')]) {
      const cfg = applyFeeling(cfgOf(i), f), was = cfgOf(i)
      expect(cfg.maze).toEqual(was.maze)
      expect(cfg.entities.spawnDenom).toBe(was.entities.spawnDenom); expect(cfg.entities.stalkerDenom).toBe(was.entities.stalkerDenom)
      for (const k of ['scraps', 'machines', 'sights', 'dress', 'haunts']) expect(cfg[k]?.denom).toBe(was[k]?.denom)
      expect(cfg.items).toEqual(was.items)
    }
  })
  it('the LEGACY and status numbers never read a feeling: the rules and the status terms are what they were', () => {
    expect(src).not.toMatch(/origin-rules|status\.js|closings|compose-/)
    const snap = () => JSON.stringify([
      RULE_KEYS.map((k) => typeof LEGACY[k] === 'function' ? [LEGACY[k](true), LEGACY[k](false)] : LEGACY[k]),
      STATUSES.map((s) => FLOORS.map((i) => statusMods(s).sanityDepthTerm(i, i))),
      rulesFor('legacy', false).lightTerm(true), rulesFor('legacy', false).lightTerm(false),
    ])
    const before = snap()
    for (const i of FLOORS) for (const f of visits(i, 'dark')) applyFeeling(cfgOf(i), f)
    expect(snap()).toBe(before)
  })
})

describe('the dark is darker, never brighter, and still readable', () => {
  it('every murmur it leaves out is a floor\'s own, word for word, and says the lights are on', () => {
    const all = LEVELS.flatMap((l) => l.config.messages ?? [])
    for (const m of FEELINGS.dark.mute) { expect(all, m).toContain(m); expect(m).toMatch(/lights/) }
  })
  const lum = (hex) => { const n = parseInt(hex.slice(1), 16); return (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255 }
  // the pipes' own visibility floor: level 2's ambient on level 2's wall colour (gfx-light.js: walls read their shapes there unlit)
  const FLOOR = LEVEL_LIGHTING['2'].ambient * lum(LEVELS[2].config.palette.wall)
  it('per floor: ambient, ceiling and fog base at or below the floor\'s own; lamps no nearer together; the dark between lamps readable', () => {
    for (const i of FLOORS) {
      const own = LEVEL_LIGHTING[String(i)], d = FEELINGS.dark.light[i]
      expect(d.ambient, String(i)).toBeLessThan(own.ambient)
      expect(d.ceilAmbient).toBeLessThanOrEqual(own.ceilAmbient)
      expect(d.fogBase).toBeLessThanOrEqual(own.fogBase)
      if (own.mode === 'lamps') { expect(d.every % own.every, String(i)).toBe(0); expect(d.every).toBeGreaterThanOrEqual(2 * own.every) }
      else expect(d.every).toBeGreaterThanOrEqual(8)
      if (d.peak !== undefined) expect(d.peak).toBeLessThanOrEqual(own.peak)
      expect(d.ambient * lum(LEVELS[i].config.palette.wall), String(i)).toBeGreaterThanOrEqual(0.9 * FLOOR)
      for (const k of Object.keys(d)) expect(['ambient', 'peak', 'radius', 'every', 'ceilAmbient', 'fogBase']).toContain(k)
    }
  })
  it('the light model reads it: the lobby and the habitable zone fall back to their lamps, everything clamped in range', () => {
    for (const i of FLOORS) {
      const cfg = cfgOf(i)
      applyFeeling(cfg, { id: 'dark' })
      const s = resolveLighting(cfg), own = resolveLighting(cfgOf(i))
      expect(s.mode).toBe('lamps')
      expect(own.mode).toBe(i <= 1 ? 'panels' : 'lamps')
      expect(s.ambient).toBe(FEELINGS.dark.light[i].ambient); expect(s.every).toBe(FEELINGS.dark.light[i].every)
      expect(s.ambient).toBeLessThan(own.ambient)
    }
  })
})

describe('the passer\'s hand', () => {
  const passage = (level = 1, seed = 4) => { for (let v = 1; v < 80; v++) { const f = feelingFor({ seed, level, visit: v, ...ON }); if (f.id === 'passage') return f } throw new Error('none') }
  const box = (i, type = 'cabinet') => ({ key: `3,-2:${i}`, x: i, y: 0, type, rot: 0.25 })
  it('handOf is a pure 0..1 of the key and the visit: another visit picks other drawers', () => {
    const f = passage(), g = { ...f, visit: f.visit + 1 }
    let same = 0
    for (let i = 0; i < 400; i++) {
      const h = handOf(`3,-2:d${i}`, f)
      expect(h).toBeGreaterThanOrEqual(0); expect(h).toBeLessThan(1)
      expect(handOf(`3,-2:d${i}`, f)).toBe(h)
      if ((h < 0.4) === (handOf(`3,-2:d${i}`, g) < 0.4)) same++
    }
    expect(same).toBeLessThan(330)
  })
  it('only someone\'s passage marks anything; nothing else is touched', () => {
    for (const f of [NO_FEELING, { id: 'dark', level: 1, visit: 3, seed: 0 }, { id: 'quiet', level: 1, visit: 3, seed: 0 }, null]) {
      const props = [box(1), box(2, 'chair'), box(3, 'crate')], log = createSearchLog(), was = JSON.stringify(props)
      expect(markPassage(props, f, log)).toBe(0)
      expect(JSON.stringify(props)).toBe(was); expect(log.keys()).toEqual([])
    }
  })
  it('about two drawers in five already searched (this visit\'s log only), about three chairs in five turned in place; no other prop', () => {
    const f = passage()
    const types = Object.keys(CONTAINER_TYPES)
    const props = []
    for (let i = 0; i < 2000; i++) props.push(box(i, i % 3 === 0 ? 'chair' : i % 3 === 1 ? types[i % types.length] : 'plant'))
    const was = props.map((p) => ({ ...p }))
    const log = createSearchLog()
    markPassage(props, f, log)
    const drawers = props.filter((p) => CONTAINER_TYPES[p.type] !== undefined), chairs = props.filter((p) => p.type === 'chair')
    const searched = drawers.filter((p) => log.isSearched(p.key)).length / drawers.length
    expect(searched).toBeGreaterThan(0.34); expect(searched).toBeLessThan(0.46)
    let turned = 0
    props.forEach((p, i) => {
      expect(p.x).toBe(was[i].x); expect(p.y).toBe(was[i].y); expect(p.type).toBe(was[i].type)   // nothing moves out of its place
      if (p.type === 'chair') { if (p.rot !== was[i].rot) { turned++; expect(p.rot).toBeCloseTo(was[i].rot + FEELINGS.passage.chairTurn, 9) } }
      else expect(p.rot).toBe(was[i].rot)
    })
    expect(turned / chairs.length).toBeGreaterThan(0.53); expect(turned / chairs.length).toBeLessThan(0.67)
    expect(log.keys().every((k) => drawers.some((p) => p.key === k))).toBe(true)
  })
  it('on a real floor: the chunk\'s dressed drawers and chairs as decor hands them over, places and colliders unchanged', () => {
    const cfg = cfgOf(0)
    cfg.ways = waysFor(0)
    const f = passage(0)
    const build = (hook) => {
      const cache = createChunkCache(cfg, null)
      const isWall = (wx, wy, pcx, pcy) => cache.isWall(wx, wy, pcx, pcy)
      const seen = []
      const decor = createDecorSystem(cfg, isWall, null, { passes: [stairsPass(cfg, cfg.ways), dressPass(cfg), hauntsPass(cfg)], onChunk: (k, b) => { seen.push(...b.props); hook?.(b) } })
      cache.preload(0, 0); decor.update(0, 0)
      return seen
    }
    const plain = build(), log = createSearchLog()
    const felt = build((b) => markPassage(b.props, f, log))
    expect(felt.length).toBe(plain.length)
    felt.forEach((p, i) => { expect(p.key).toBe(plain[i].key); expect(p.x).toBe(plain[i].x); expect(p.y).toBe(plain[i].y) })
    expect(plain.filter((p) => CONTAINER_TYPES[p.type] !== undefined).length).toBeGreaterThan(5)
    expect(log.keys().length).toBeGreaterThan(0)
    expect(felt.some((p, i) => p.type === 'chair' && p.rot !== plain[i].rot)).toBe(true)
  })
})

describe('events.js: the quiet\'s spacing, an optional field on the scheduler\'s config (off by default)', () => {
  const seq = (cfg, n = 40) => {
    let s = 7
    const rng = () => { s = (s * 16807) % 2147483647; return s / 2147483647 }
    const sch = createEventScheduler({ rng, config: cfg })
    const out = []
    for (let i = 0; i < n; i++) {
      if (i % 5 === 0) { sch.arrive(i % 4, 80); out.push(['a', sch._next(), sch._arrival()]) }
      let ev = null, t = 0
      while (!ev && t < 2000) { ev = sch.tick(1, { level: i % 4, sanity: 80, canFire: true }); t++ }
      out.push([ev, t, sch._next(), sch.soundOnly])
    }
    return out
  }
  it('identity: absent, 1 or anything that is not a finite positive number, the windows are exactly the old ones (and the same draws)', () => {
    const ref = seq({ events: createEventScheduler().config.events, tension: 0 })
    for (const spacing of [1, undefined, null, 0, -2, NaN, Infinity, '2']) expect(seq({ events: createEventScheduler().config.events, tension: 0, spacing }), String(spacing)).toEqual(ref)
  })
  it('a spacing stretches every window it draws, the arrival\'s too, by exactly that much (the rng draws are the same)', () => {
    let s = 11
    const rng = () => { s = (s * 16807) % 2147483647; return s / 2147483647 }
    let s2 = 11
    const rng2 = () => { s2 = (s2 * 16807) % 2147483647; return s2 / 2147483647 }
    const a = createEventScheduler({ rng, config: { events: createEventScheduler().config.events, tension: 0 } })
    const b = createEventScheduler({ rng: rng2, config: { events: createEventScheduler().config.events, tension: 0, spacing: FEELINGS.quiet.events } })
    for (let i = 0; i < 30; i++) {
      a.arrive(i % 4, 60); b.arrive(i % 4, 60)
      expect(b._arrival()).toBe(a._arrival())
      expect(b._next()).toBeCloseTo(a._next() * FEELINGS.quiet.events, 9)
      if (b._arrival()) { expect(b._next()).toBeGreaterThanOrEqual(ARRIVAL.min * FEELINGS.quiet.events - 1e-9) }
      else { const [lo] = eventInterval(i % 4, 60); expect(b._next()).toBeGreaterThanOrEqual(lo * FEELINGS.quiet.events - 1e-9) }
    }
  })
})
