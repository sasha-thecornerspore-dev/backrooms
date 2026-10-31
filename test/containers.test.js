// containers.js — the searchable drawers: a pure roll per container key (one item-eligible slot per chunk, weighted words / empties /
// hauntings), the apply step against a tiny api, and the searched-key log that rides the save.
import { describe, it, expect } from 'vitest'
import {
  CONTAINER_TYPES, DRAWER_NOTES, EMPTY_LINES, SEARCH_HOLD_S, HANDS_FULL_LINE, DRAWER_COST,
  SEARCH_HOLD_DARK_S, TRACE_LINES, SQUEAL_LINE, SQUEAL_NOISE, NOT_NOW_LINE, SEARCHED_HINT, searchingHint,
  foldKey, itemSlot, isItemEligible, rollContainer, applyRoll, createSearchLog,
} from '../src/renderer/containers.js'
import { createNoiseField, floodNoise, loudnessAt } from '../src/renderer/hunt.js'
import { LEVELS } from '../src/renderer/levels.js'
import { PRIO } from '../src/renderer/messages.js'

const SALT = 0x1111
const keyOf = (cx, cy, i) => `${cx},${cy}:${i}`
// every roll of `n` eligible / non-eligible keys at one level, over many chunks so the hash moves
function sample(level, eligible, n, seed = 0, salt = SALT, bonus = 0) {
  const out = []
  for (let cx = -40; out.length < n; cx++) for (let cy = -40; cy < 40 && out.length < n; cy++) for (let i = 0; i < 8 && out.length < n; i++) {
    const key = keyOf(cx, cy, i)
    if (isItemEligible(key, cx, cy, seed, salt) !== eligible) continue
    out.push(rollContainer(key, cx, cy, level, seed, salt, bonus))
  }
  return out
}
// the sweep: 20,000 synthetic keys a floor, eight prop indices a chunk, so the item slot lands one key in eight as it does in play
function sweep(level, n = 20000, seed = 0, salt = LEVELS[level].config.maze.salt) {
  const out = []
  for (let cx = -60; out.length < n; cx++) for (let cy = -60; cy < 60 && out.length < n; cy++) for (let i = 0; i < 8 && out.length < n; i++) {
    out.push(rollContainer(keyOf(cx, cy, i), cx, cy, level, seed, salt))
  }
  return out
}
const histogram = (rolls) => {
  const h = { empty: 0, item: 0, note: 0, trace: 0, haunt: 0 }
  for (const r of rolls) h[r.kind]++
  for (const k in h) h[k] /= rolls.length
  return h
}
const api = (over = {}) => {
  const log = { messages: [], sanity: 0, fired: [], behind: 0, granted: [], noise: [] }
  const a = {
    grant: (type, extra) => { log.granted.push([type, extra]); return { ok: true } },
    message: (text, prio) => log.messages.push([text, prio]),
    sanity: (d) => { log.sanity += d },
    fire: (id) => log.fired.push(id),
    behindYou: () => { log.behind++ },
    noise: (n) => log.noise.push(n),
    ...over,
  }
  return { a, log }
}

const NEW_NOTES = [
  'a coffee mug, stained in rings, one above another.',
  'a lanyard with no badge on it. the clip is bent, as if pulled.',
  'a performance review. under strengths: stays.',
  'a sticky note: do not answer it. the writing gets smaller toward the end.',
  'a box of pens. every pen has been chewed in the same place.',
  'a calendar with every day crossed out, including the ones not yet come.',
  'a memo about the carpet. the carpet is to be left damp.',
  'a photograph of the office party. everyone is facing the wall.',
  'a hand-drawn map of this floor. it runs off the page and carries on across the desk.',
  "a visitor badge. the photo is of the back of someone's head.",
  'a list of exits, all crossed out, then one written in, then crossed out.',
  'a tape measure, pulled out and locked, as if someone meant to come back to it.',
  'a request for a window. denied. reason: there is no outside.',
  'a key ring heavy with keys. none of them open anything here.',
  'a glove, the left one. the drawer beside it is empty in the shape of the right.',
  "a cardigan folded in the drawer, still holding the shape of someone's shoulders.",
  'reading glasses, folded, on top of a letter that was never started.',
  'a birthday card signed by everyone. the name on the front has been left blank.',
  'a packed lunch, the lid still on, the name on the lid rubbed away.',
  "a set of house keys, the fob worn smooth by someone's thumb.",
]
const NEW_EMPTY = [
  'empty. the bottom of the drawer is cleaner than the rest.',
  'nothing but a paperclip, bent straight.',
  'empty. dust, and the outline of something that was here.',
  'nothing. you check again anyway.',
  'empty. the runners squeal.',
]
const plain = (l) => { expect(l).toBe(l.toLowerCase()); expect(l).not.toMatch(/[!0-9]/); expect(l.at(-1)).toBe('.') }

describe('constants', () => {
  it('names the eight container types with their in-fiction labels, the hold, the lines', () => {
    expect(CONTAINER_TYPES).toEqual({
      cabinet: 'the cabinet', crate: 'the crate', box: 'the box', toolbox: 'the toolbox', 'cabinet-e': 'the panel cabinet',
      cart: 'the cart', drum: 'the drum', couch: 'the couch cushions',
    })
    expect(SEARCH_HOLD_S).toBe(0.75)
    expect(EMPTY_LINES).toEqual(['empty. someone has been through here.', 'empty. the drawer sticks on the way back.', 'nothing. a smell of warm paper.', ...NEW_EMPTY])
    expect(HANDS_FULL_LINE).toBe('there is something here, but your hands are full.')
    expect(DRAWER_COST).toEqual({ minLevel: 2, sanity: 2, line: 'something counts the drawers you open.' })
    expect(Object.isFrozen(CONTAINER_TYPES)).toBe(true); expect(Object.isFrozen(DRAWER_NOTES)).toBe(true); expect(Object.isFrozen(EMPTY_LINES)).toBe(true)
  })

  it('T1-9: the dark hold for 2a, the trace lines, the search lines, the squeal', () => {
    expect(SEARCH_HOLD_DARK_S).toBe(1.1)
    expect(TRACE_LINES).toEqual({
      content: 'a floor plan with one room shaded in. you mark it on yours.',
      way: 'a floor plan. someone has circled a corner and written down.',
    })
    expect(Object.isFrozen(TRACE_LINES)).toBe(true)
    expect(SQUEAL_LINE).toBe('empty. the runners squeal.'); expect(EMPTY_LINES).toContain(SQUEAL_LINE)
    expect(NOT_NOW_LINE).toBe('not now. something is close.')
    expect(SEARCHED_HINT).toBe('searched.')
    expect(searchingHint('cabinet')).toBe('searching the cabinet')
    expect(searchingHint('couch')).toBe('searching the couch cushions')
    expect(searchingHint('what')).toBe('searching')
    for (const l of [...Object.values(TRACE_LINES), NOT_NOW_LINE, SEARCHED_HINT, ...NEW_EMPTY]) plain(l)
  })

  it('DRAWER_NOTES holds forty distinct lowercase one-liners, no exclamation marks (shouted memo text aside)', () => {
    expect(DRAWER_NOTES).toHaveLength(40)
    expect(new Set(DRAWER_NOTES).size).toBe(40)
    expect(DRAWER_NOTES.slice(20)).toEqual(NEW_NOTES)                   // appended: the first twenty keep their order
    for (const n of NEW_NOTES) plain(n)
    for (const n of DRAWER_NOTES) {
      expect(typeof n).toBe('string')
      expect(n.length).toBeGreaterThan(10)
      expect(n).not.toContain('!')
      expect(n[0]).toBe(n[0].toLowerCase())
      expect(n.at(-1)).toBe('.')
    }
    expect(DRAWER_NOTES).toContain('a memo: DO NOT DRINK FROM THE FOUNTAIN ON 2. it is dated the day you fell in.')
    expect(DRAWER_NOTES).toContain('a name badge. the name has been scratched out and written again, smaller.')
    for (const l of EMPTY_LINES) expect(l).toBe(l.toLowerCase())
  })
})

describe('foldKey', () => {
  it('folds any key shape to an int32 and tells the scatter and dressed shapes apart', () => {
    const a = foldKey('3,-2:4'), b = foldKey('3,-2:d2')
    expect(Number.isInteger(a)).toBe(true); expect(Number.isInteger(b)).toBe(true)
    expect(a | 0).toBe(a); expect(b | 0).toBe(b)
    expect(a).not.toBe(b)
    expect(foldKey('3,-2:4')).toBe(a)                                   // pure
    expect(foldKey('')).toBe(0)
    // the stated fold: sum of charCode * 31^k, as int32
    let want = 0, p = 1
    for (let i = 0; i < '3,-2:4'.length; i++) { want = (want + Math.imul('3,-2:4'.charCodeAt(i), p)) | 0; p = Math.imul(p, 31) }
    expect(a).toBe(want)
    expect(foldKey(7)).toBe(foldKey('7'))                                // a non-string key is stringified
  })
})

describe('rollContainer', () => {
  it('is deterministic in (key, cx, cy, level, seed, salt) and moves with each of them', () => {
    const base = rollContainer('3,-2:1', 3, -2, 1, 0, SALT)
    expect(rollContainer('3,-2:1', 3, -2, 1, 0, SALT)).toEqual(base)
    expect(['empty', 'item', 'note', 'haunt']).toContain(base.kind)
    const rolls = (f) => [...Array(40)].map((_, i) => JSON.stringify(f(i)))
    const differs = (f) => new Set(rolls(f)).size > 1
    expect(differs((i) => rollContainer(`3,-2:${i}`, 3, -2, 1, 0, SALT))).toBe(true)
    expect(differs((i) => rollContainer('3,-2:1', 3 + i, -2, 1, 0, SALT))).toBe(true)
    expect(differs((i) => rollContainer('3,-2:1', 3, -2 + i, 1, 0, SALT))).toBe(true)
    expect(differs((i) => rollContainer('3,-2:1', 3, -2, 1, i, SALT))).toBe(true)
    expect(differs((i) => rollContainer('3,-2:1', 3, -2, 1, 0, SALT + i))).toBe(true)
  })

  it('returns exactly the documented shapes', () => {
    const seen = new Set()
    for (const r of [...sample(2, true, 400), ...sample(2, false, 400)]) {
      seen.add(r.kind)
      if (r.kind === 'empty') expect(Object.keys(r)).toEqual(['kind'])
      else if (r.kind === 'item') { expect(Object.keys(r).sort()).toEqual(['extra', 'kind', 'type']); expect(typeof r.type).toBe('string'); expect(typeof r.extra).toBe('object') }
      else if (r.kind === 'note') { expect(Object.keys(r).sort()).toEqual(['kind', 'text']); expect(DRAWER_NOTES).toContain(r.text) }
      else if (r.kind === 'haunt') { expect(Object.keys(r).sort()).toEqual(['id', 'kind']); expect(['door-slam', 'cold-spot', 'footsteps', 'behind-you']).toContain(r.id) }
      else if (r.kind === 'trace') { expect(Object.keys(r).sort()).toEqual(['fallback', 'kind']); expect(DRAWER_NOTES).toContain(r.fallback) }
      else throw new Error(`unknown kind ${r.kind}`)
    }
    expect([...seen].sort()).toEqual(['empty', 'haunt', 'item', 'note', 'trace'])
  })

  it('a 10k-key histogram lands within ±3% of the stated weights: eligible 50 item/30/10 trace/10, not eligible 38 empty/39/10 trace/3 item/10', () => {
    const e = histogram(sample(1, true, 10000))
    expect(e.item).toBeGreaterThan(0.47); expect(e.item).toBeLessThan(0.53)
    expect(e.note).toBeGreaterThan(0.27); expect(e.note).toBeLessThan(0.33)
    expect(e.trace).toBeGreaterThan(0.07); expect(e.trace).toBeLessThan(0.13)
    expect(e.haunt).toBeGreaterThan(0.07); expect(e.haunt).toBeLessThan(0.13)
    expect(e.empty).toBe(0)
    const n = histogram(sample(1, false, 10000))
    expect(n.empty).toBeGreaterThan(0.35); expect(n.empty).toBeLessThan(0.41)
    expect(n.note).toBeGreaterThan(0.36); expect(n.note).toBeLessThan(0.42)
    expect(n.trace).toBeGreaterThan(0.07); expect(n.trace).toBeLessThan(0.13)
    expect(n.item).toBeGreaterThan(0.01); expect(n.item).toBeLessThan(0.05)
    expect(n.haunt).toBeGreaterThan(0.07); expect(n.haunt).toBeLessThan(0.13)
  })

  it('the 20,000-key sweep on L1-3: item 8-10%, empty at most 35%, trace 8-12%', () => {
    for (const level of [1, 2, 3]) {
      const h = histogram(sweep(level))
      expect(h.item, `L${level} item`).toBeGreaterThanOrEqual(0.08); expect(h.item, `L${level} item`).toBeLessThanOrEqual(0.10)
      expect(h.empty, `L${level} empty`).toBeLessThanOrEqual(0.35)
      expect(h.trace, `L${level} trace`).toBeGreaterThanOrEqual(0.08); expect(h.trace, `L${level} trace`).toBeLessThanOrEqual(0.12)
    }
  })

  it("level 0 never yields 'haunt': the haunt share folds into notes", () => {
    const e = histogram(sample(0, true, 10000)), n = histogram(sample(0, false, 10000))
    expect(e.haunt).toBe(0); expect(n.haunt).toBe(0)
    expect(e.note).toBeGreaterThan(0.37); expect(e.note).toBeLessThan(0.43)        // 30 + 10
    expect(n.note).toBeGreaterThan(0.46); expect(n.note).toBeLessThan(0.52)        // 39 + 10
    expect(n.empty).toBeGreaterThan(0.35); expect(e.item).toBeGreaterThan(0.47)
    expect(histogram(sweep(0)).haunt).toBe(0)
    expect(histogram(sweep(0)).trace).toBeGreaterThan(0.08)                       // the lobby has rooms worth a floor plan too
  })

  it('at most one item-eligible container per 8 prop indices per chunk; 400 chunks x 5 containers average few items', () => {
    let items = 0
    for (let cx = 0; cx < 20; cx++) for (let cy = 0; cy < 20; cy++) {
      const slot = itemSlot(cx, cy, 0, SALT)
      expect(slot).toBeGreaterThanOrEqual(0); expect(slot).toBeLessThan(8)
      let eligible8 = 0
      for (let i = 0; i < 8; i++) if (isItemEligible(keyOf(cx, cy, i), cx, cy, 0, SALT)) eligible8++
      expect(eligible8).toBeLessThanOrEqual(1)
      for (let i = 0; i < 5; i++) if (rollContainer(keyOf(cx, cy, i), cx, cy, 1, 0, SALT).kind === 'item') items++
    }
    // five of eight indices present, one slot in eight at half, the other seven at three in a hundred: 5/8 * 1/2 + 35/8 * 0.03 = 0.44
    expect(items / 400).toBeLessThanOrEqual(0.6)
    expect(items).toBeGreaterThan(0)
  })

  it('bonus only turns an empty or a note into an item; at 0 (or absent) the table is exact', () => {
    const N = 6000
    for (const eligible of [true, false]) {
      const base = sample(2, eligible, N)
      expect(sample(2, eligible, N, 0, SALT, 0)).toEqual(base)
      const plus = sample(2, eligible, N, 0, SALT, 30)
      const all = sample(2, eligible, N, 0, SALT, 100)
      let moved = 0
      for (let i = 0; i < N; i++) {
        const a = base[i], b = plus[i]
        if (a.kind === 'empty' || a.kind === 'note') {
          if (b.kind !== a.kind) { expect(b.kind).toBe('item'); moved++ }
          else expect(b).toEqual(a)
          expect(all[i].kind).toBe('item')                                        // a full bonus takes every empty and note
          if (b.kind === 'item') expect(all[i]).toEqual(b)                        // monotone: what 30 made an item, 100 keeps the same item
        } else {
          expect(b).toEqual(a); expect(all[i]).toEqual(a)                         // items, traces and haunts never move
        }
      }
      const pool = base.filter((r) => r.kind === 'empty' || r.kind === 'note').length
      expect(moved / pool).toBeGreaterThan(0.26); expect(moved / pool).toBeLessThan(0.34)
    }
    for (const r of sample(1, false, 3000, 0, SALT, 40)) if (r.kind === 'item') expect(LEVELS[1].config.items.types).toContain(r.type)
  })

  it('the roll is pure in key, chunk and bonus', () => {
    for (const bonus of [0, 15, 20]) {
      const a = rollContainer('4,-1:3', 4, -1, 2, 77, SALT, bonus)
      expect(rollContainer('4,-1:3', 4, -1, 2, 77, SALT, bonus)).toEqual(a)
    }
    expect(rollContainer('4,-1:3', 4, -1, 2, 77, SALT)).toEqual(rollContainer('4,-1:3', 4, -1, 2, 77, SALT, 0))
  })

  it("item results only name the level's item types, plus 'bandage' on levels 1..3", () => {
    for (let level = 0; level <= 3; level++) {
      const types = LEVELS[level].config.items.types
      const pool = new Set(level >= 1 ? [...types, 'bandage'] : types)
      const got = new Set()
      for (const r of sample(level, true, 3000)) if (r.kind === 'item') { expect(pool.has(r.type), `${level}:${r.type}`).toBe(true); got.add(r.type) }
      expect(got.size).toBe(pool.size)                                 // every type turns up
      if (level === 0) expect(got.has('bandage')).toBe(false)
      else expect(got.has('bandage')).toBe(true)
    }
  })

  it('almond water is sour about 30% of the time at level >= 2 and never below', () => {
    for (let level = 0; level <= 3; level++) {
      let water = 0, sour = 0
      for (const r of sample(level, true, 6000)) {
        if (r.kind !== 'item') continue
        if (r.type !== 'almond-water') { expect(r.extra.sour).toBeUndefined(); continue }
        water++
        if (r.extra.sour) sour++
        else expect(r.extra).toEqual({})
      }
      expect(water).toBeGreaterThan(100)
      if (level < 2) expect(sour).toBe(0)
      else { expect(sour / water).toBeGreaterThan(0.24); expect(sour / water).toBeLessThan(0.36) }
    }
  })
})

describe('applyRoll', () => {
  it('item: grants it and says so; full hands -> false and the hands-full line, nothing else', () => {
    const ok = api()
    expect(applyRoll({ kind: 'item', type: 'glowstick', extra: {} }, ok.a)).toBe(true)
    expect(ok.log.granted).toEqual([['glowstick', {}]])
    expect(ok.log.messages).toHaveLength(1)
    expect(ok.log.messages[0][0]).toContain('glowstick'); expect(ok.log.messages[0][1]).toBe(PRIO.interaction)
    expect(ok.log.sanity).toBe(0)
    const sour = api()
    applyRoll({ kind: 'item', type: 'almond-water', extra: { sour: true } }, sour.a)
    expect(sour.log.granted).toEqual([['almond-water', { sour: true }]])
    expect(sour.log.messages[0][0]).toContain('almond water')
    const full = api({ grant: () => ({ ok: false, reason: 'full' }) })
    expect(applyRoll({ kind: 'item', type: 'radio', extra: {} }, full.a)).toBe(false)
    expect(full.log.messages).toEqual([[HANDS_FULL_LINE, PRIO.interaction]])
    expect(full.log.sanity).toBe(0); expect(full.log.fired).toEqual([]); expect(full.log.behind).toBe(0)
  })

  it('note: true, the text at interaction priority and +3 sanity', () => {
    const { a, log } = api()
    expect(applyRoll({ kind: 'note', text: DRAWER_NOTES[3] }, a)).toBe(true)
    expect(log.messages).toEqual([[DRAWER_NOTES[3], PRIO.interaction]])
    expect(log.sanity).toBe(3)
    expect(log.granted).toEqual([])
  })

  it('haunt: fire(id) for the event ids, behindYou() for behind-you; no line of its own', () => {
    for (const id of ['door-slam', 'cold-spot', 'footsteps']) {
      const { a, log } = api()
      expect(applyRoll({ kind: 'haunt', id }, a)).toBe(true)
      expect(log.fired).toEqual([id]); expect(log.behind).toBe(0); expect(log.messages).toEqual([]); expect(log.sanity).toBe(0)
    }
    const { a, log } = api()
    expect(applyRoll({ kind: 'haunt', id: 'behind-you' }, a)).toBe(true)
    expect(log.behind).toBe(1); expect(log.fired).toEqual([]); expect(log.messages).toEqual([])
  })

  it('empty: true with one of EMPTY_LINES, cycling through all eight; the squeal is a real noise, SQUEAL_NOISE', () => {
    const seen = new Set()
    for (let i = 0; i < 16; i++) {
      const { a, log } = api()
      expect(applyRoll({ kind: 'empty' }, a)).toBe(true)
      expect(log.messages).toHaveLength(1)
      expect(EMPTY_LINES).toContain(log.messages[0][0]); expect(log.messages[0][1]).toBe(PRIO.interaction)
      expect(log.sanity).toBe(0)
      expect(log.noise).toEqual(log.messages[0][0] === SQUEAL_LINE ? [SQUEAL_NOISE] : [])
      seen.add(log.messages[0][0])
    }
    expect(seen.size).toBe(8)
    // an api without noise still says the line
    for (let i = 0; i < 8; i++) { const { a } = api({ noise: undefined }); expect(() => applyRoll({ kind: 'empty' }, a)).not.toThrow() }
  })

  it('the squeal carries farther than the search it ends (every completed search is a noise of 4 at the drawer, game.js resolveSearch; a thing reacts to the loudest it hears)', () => {
    expect(SQUEAL_NOISE).toBeGreaterThan(4)
    const corridor = (x, y) => y === 60
    const heardOver = (L) => {
      const f = createNoiseField(); floodNoise(f, { x: 60.5, y: 60.5, L, t: 0 }, corridor)
      let n = 0
      for (let x = 40; x <= 80; x++) if (loudnessAt(f, x, 60) >= 1) n++
      return n
    }
    expect(heardOver(SQUEAL_NOISE)).toBeGreaterThan(heardOver(4))
  })

  it('trace: the content line or the way line, by what api.trace() pinned; true either way, no sanity', () => {
    for (const [got, line] of [['content', TRACE_LINES.content], ['way', TRACE_LINES.way]]) {
      let asked = 0
      const { a, log } = api({ trace: () => { asked++; return got } })
      expect(applyRoll({ kind: 'trace', fallback: DRAWER_NOTES[5] }, a)).toBe(true)
      expect(asked).toBe(1)
      expect(log.messages).toEqual([[line, PRIO.interaction]])
      expect(log.sanity).toBe(0)
    }
  })

  it('trace: nothing to pin (or no api.trace) shows the roll\'s own fallback note, as a note', () => {
    for (const over of [{ trace: () => null }, { trace: () => undefined }, { trace: () => 'what' }, {}]) {
      const { a, log } = api(over)
      expect(() => applyRoll({ kind: 'trace', fallback: DRAWER_NOTES[7] }, a)).not.toThrow()
      expect(log.messages).toEqual([[DRAWER_NOTES[7], PRIO.interaction]])
      expect(log.sanity).toBe(3)
    }
  })

  it('an unknown roll is a no-op that returns false', () => {
    const { a, log } = api()
    expect(applyRoll(null, a)).toBe(false)
    expect(applyRoll({ kind: 'what' }, a)).toBe(false)
    expect(log.messages).toEqual([])
  })
})

describe('createSearchLog', () => {
  it('marks, asks, lists, clears', () => {
    const log = createSearchLog()
    expect(log.isSearched('0,0:1')).toBe(false)
    log.markSearched('0,0:1'); log.markSearched('0,0:d2'); log.markSearched('0,0:1')
    expect(log.isSearched('0,0:1')).toBe(true); expect(log.isSearched('0,0:d2')).toBe(true); expect(log.isSearched('0,0:3')).toBe(false)
    expect(log.keys().sort()).toEqual(['0,0:1', '0,0:d2'])
    log.clear()
    expect(log.keys()).toEqual([]); expect(log.isSearched('0,0:1')).toBe(false)
  })

  it('round-trips through JSON and seed(), and seed() takes a Set (levelmem.searchedFor) as well as an array', () => {
    const a = createSearchLog()
    a.markSearched('1,2:0'); a.markSearched('-3,4:d1')
    const b = createSearchLog()
    b.seed(JSON.parse(JSON.stringify(a.keys())))
    expect(b.keys().sort()).toEqual(a.keys().sort())
    const c = createSearchLog()
    c.seed(new Set(a.keys()))
    expect(c.isSearched('1,2:0')).toBe(true); expect(c.isSearched('-3,4:d1')).toBe(true)
    c.seed(null); c.seed(undefined); c.seed([7, null])                 // tolerant: non-strings are stringified, nullish skipped
    expect(c.isSearched('7')).toBe(true); expect(c.isSearched('null')).toBe(false)
    expect(c.keys()).toHaveLength(3)
  })

  it('hold(key, roll) keeps a hands-full roll for the visit; held() hands it back; a search or clear() lets it go; keys() never shows it', () => {
    const log = createSearchLog()
    const roll = { kind: 'item', type: 'radio', extra: {} }
    expect(log.held('2,2:1')).toBeNull()
    log.hold('2,2:1', roll)
    expect(log.held('2,2:1')).toBe(roll)
    expect(log.isSearched('2,2:1')).toBe(false); expect(log.keys()).toEqual([])
    log.markSearched('2,2:1')
    expect(log.held('2,2:1')).toBeNull()
    log.hold('2,2:2', roll); log.clear()
    expect(log.held('2,2:2')).toBeNull()
    log.hold(5, roll); expect(log.held('5')).toBe(roll)               // keys stringify, as markSearched's do
    log.seed(['5']); expect(log.held('5')).toBe(roll)                 // seed() adds searched keys only; it never restores a hold
  })

  it('hands full, then free: the drawer replays the held roll, so it never says empty after the hands-full line', () => {
    const log = createSearchLog()
    let free = false
    const said = []
    const a = {
      grant: () => ({ ok: free }), message: (t) => said.push(t), sanity: () => {}, fire: () => {}, behindYou: () => {}, noise: () => {},
    }
    // resolveSearch's order: the held roll wins over a fresh one, whatever the bonus is by then
    const key = '1,1:0'
    const first = { kind: 'item', type: 'glowstick', extra: {} }
    const search = (bonus) => log.held(key) ?? rollContainer(key, 1, 1, 1, 0, SALT, bonus)
    log.hold(key, first)                                               // what resolveSearch does when applyRoll returns false
    expect(applyRoll(search(0), a)).toBe(false); expect(said).toEqual([HANDS_FULL_LINE])
    free = true
    const again = search(20)
    expect(again).toBe(first)
    expect(applyRoll(again, a)).toBe(true); log.markSearched(key)
    expect(said).toEqual([HANDS_FULL_LINE, 'in the drawer: a glowstick.'])
    expect(log.held(key)).toBeNull()
  })
})
