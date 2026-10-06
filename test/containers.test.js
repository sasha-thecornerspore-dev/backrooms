// containers.js — the searchable drawers: a pure roll per container key (one item-eligible slot per chunk, weighted words / empties /
// hauntings), the apply step against a tiny api, and the searched-key log that rides the save.
import { describe, it, expect } from 'vitest'
import {
  CONTAINER_TYPES, DRAWER_NOTES, EMPTY_LINES, SEARCH_HOLD_S, HANDS_FULL_LINE, DRAWER_COST,
  foldKey, itemSlot, isItemEligible, rollContainer, applyRoll, createSearchLog,
} from '../src/renderer/containers.js'
import { LEVELS } from '../src/renderer/levels.js'
import { PRIO } from '../src/renderer/messages.js'

const SALT = 0x1111
const keyOf = (cx, cy, i) => `${cx},${cy}:${i}`
// every roll of `n` eligible / non-eligible keys at one level, over many chunks so the hash moves
function sample(level, eligible, n, seed = 0, salt = SALT) {
  const out = []
  for (let cx = -40; out.length < n; cx++) for (let cy = -40; cy < 40 && out.length < n; cy++) for (let i = 0; i < 8 && out.length < n; i++) {
    const key = keyOf(cx, cy, i)
    if (isItemEligible(key, cx, cy, seed, salt) !== eligible) continue
    out.push(rollContainer(key, cx, cy, level, seed, salt))
  }
  return out
}
const histogram = (rolls) => {
  const h = { empty: 0, item: 0, note: 0, haunt: 0 }
  for (const r of rolls) h[r.kind]++
  for (const k in h) h[k] /= rolls.length
  return h
}
const api = (over = {}) => {
  const log = { messages: [], sanity: 0, fired: [], behind: 0, granted: [] }
  const a = {
    grant: (type, extra) => { log.granted.push([type, extra]); return { ok: true } },
    message: (text, prio) => log.messages.push([text, prio]),
    sanity: (d) => { log.sanity += d },
    fire: (id) => log.fired.push(id),
    behindYou: () => { log.behind++ },
    ...over,
  }
  return { a, log }
}

describe('constants', () => {
  it('names the eight container types with their in-fiction labels, the hold, the lines', () => {
    expect(CONTAINER_TYPES).toEqual({
      cabinet: 'the cabinet', crate: 'the crate', box: 'the box', toolbox: 'the toolbox', 'cabinet-e': 'the panel cabinet',
      cart: 'the cart', drum: 'the drum', couch: 'the couch cushions',
    })
    expect(SEARCH_HOLD_S).toBe(0.75)
    expect(EMPTY_LINES).toEqual(['empty. someone has been through here.', 'empty. the drawer sticks on the way back.', 'nothing. a smell of warm paper.'])
    expect(HANDS_FULL_LINE).toBe('there is something here, but your hands are full.')
    expect(DRAWER_COST).toEqual({ minLevel: 2, sanity: 2, line: 'something counts the drawers you open.' })
    expect(Object.isFrozen(CONTAINER_TYPES)).toBe(true); expect(Object.isFrozen(DRAWER_NOTES)).toBe(true); expect(Object.isFrozen(EMPTY_LINES)).toBe(true)
  })

  it('DRAWER_NOTES holds twenty distinct lowercase one-liners, no exclamation marks (shouted memo text aside)', () => {
    expect(DRAWER_NOTES).toHaveLength(20)
    expect(new Set(DRAWER_NOTES).size).toBe(20)
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
      else throw new Error(`unknown kind ${r.kind}`)
    }
    expect([...seen].sort()).toEqual(['empty', 'haunt', 'item', 'note'])
  })

  it('a 10k-key histogram lands within ±3% of the stated weights: eligible 50/40/10, not eligible 60 empty/30/10', () => {
    const e = histogram(sample(1, true, 10000))
    expect(e.item).toBeGreaterThan(0.47); expect(e.item).toBeLessThan(0.53)
    expect(e.note).toBeGreaterThan(0.37); expect(e.note).toBeLessThan(0.43)
    expect(e.haunt).toBeGreaterThan(0.07); expect(e.haunt).toBeLessThan(0.13)
    expect(e.empty).toBe(0)
    const n = histogram(sample(1, false, 10000))
    expect(n.empty).toBeGreaterThan(0.57); expect(n.empty).toBeLessThan(0.63)
    expect(n.note).toBeGreaterThan(0.27); expect(n.note).toBeLessThan(0.33)
    expect(n.haunt).toBeGreaterThan(0.07); expect(n.haunt).toBeLessThan(0.13)
    expect(n.item).toBe(0)
  })

  it("level 0 never yields 'haunt': the haunt share folds into notes", () => {
    const e = histogram(sample(0, true, 10000)), n = histogram(sample(0, false, 10000))
    expect(e.haunt).toBe(0); expect(n.haunt).toBe(0)
    expect(e.note).toBeGreaterThan(0.47); expect(e.note).toBeLessThan(0.53)        // 40 + 10
    expect(n.note).toBeGreaterThan(0.37); expect(n.note).toBeLessThan(0.43)        // 30 + 10
    expect(n.empty).toBeGreaterThan(0.57); expect(e.item).toBeGreaterThan(0.47)
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
    // five of eight indices present, one slot in eight, half of the eligible rolls are items: 5/8 * 1/2 = 0.3125 expected
    expect(items / 400).toBeLessThanOrEqual(0.35)
    expect(items).toBeGreaterThan(0)
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

  it('empty: true with one of EMPTY_LINES, cycling through all three', () => {
    const seen = new Set()
    for (let i = 0; i < 6; i++) {
      const { a, log } = api()
      expect(applyRoll({ kind: 'empty' }, a)).toBe(true)
      expect(log.messages).toHaveLength(1)
      expect(EMPTY_LINES).toContain(log.messages[0][0]); expect(log.messages[0][1]).toBe(PRIO.interaction)
      expect(log.sanity).toBe(0)
      seen.add(log.messages[0][0])
    }
    expect(seen.size).toBe(3)
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
})
