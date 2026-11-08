// The field terminal's record (casebook.js): what the terminal reads back, kept per device under backrooms:casebook. Indices into the
// game's own tables and a floor, never text but the margin; bounded, capped, debounced, and safe over a storage that throws.
import { describe, it, expect } from 'vitest'
import { createCasebook, parseCasebook, cleanLine, CASEBOOK_KEY, BOOK_KEYS, BOOK_CAPS } from '../src/renderer/casebook.js'

const B = { pages: 26, souls: [12, 0, 1, 1, 1], drawers: 40, phrases: 12, sights: ['chairpile', 'tvwall', 'payphone', 'mannequin'],
  kinds: ['shade', 'smiler', 'hound', 'lurker', 'watcher', 'crawler', 'tesla'], floors: 4, thread: 3 }
const mem = () => { const m = new Map(), writes = []; return { m, writes, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { writes.push(k); m.set(k, String(v)) } } }
const throwing = { getItem() { throw new Error('blocked') }, setItem() { throw new Error('blocked') } }
// a hand-run debounce: timers wait until run()
function clock() {
  const t = []
  return { setTimer: (f) => { t.push(f); return t.length }, clearTimer: (id) => { t[id - 1] = null }, run: () => { const fs = t.splice(0); for (const f of fs) if (f) f() }, pending: () => t.filter(Boolean).length }
}
const make = (o = {}) => { const c = clock(); const st = o.storage === undefined ? mem() : o.storage; return { c, st, b: createCasebook({ storage: st, bounds: B, ...c, ...o }) } }

describe('parseCasebook: empty, corrupt or foreign loads empty; only valid entries survive', () => {
  const EMPTY = { v: 1, seeded: false, pages: [], souls: [], drawers: [], thread: 0, caches: [], sights: [], dens: [], margin: [] }
  it('nothing, junk, the wrong version or another shape: an empty book', () => {
    for (const raw of [null, undefined, '', 'not json', '{', '[]', '[1,2]', '42', 'null', '{"v":2,"pages":[[1,0]]}', '{"pages":[[1,0]]}', { v: '1' }, [], 7])
      expect(parseCasebook(raw, B), String(raw)).toEqual(EMPTY)
  })
  it('out-of-range, wrong-type and unknown entries are dropped, repeats too; unknown keys never come back', () => {
    const raw = {
      v: 1, seeded: true, extra: 'x', answer: 'nope', x: 3, y: 4,
      pages: [[1, 0], [1, 2], [26, 0], [-1, 0], [2, -1], [3, -2], [4, 4], ['5', 0], [6.5, 0], [7], 'x', [8, 1, 'extra']],
      souls: [[0, 11, 1], [0, 12, 1], [1, 0, 1], [2, 0, 3], [5, 0, 0], [0, 1, -1], [0, 11, 2]],
      drawers: [[39, 0], [40, 0], [3, 9]],
      thread: 9,
      caches: [[2, 1, true], [12, 1, true], [3, 1, 'yes'], [4, 1, false]],
      sights: [['payphone', 2], ['ufo', 1], [7, 1], ['payphone', 2]],
      dens: [['hound', 3], ['dragon', 1], ['shade', 0]],
      margin: ['ok line', 7, '', '  spaced  out  ', 'bad\u0000char‮flip'],
    }
    const b = parseCasebook(JSON.stringify(raw), B)
    expect(Object.keys(b)).toEqual(BOOK_KEYS)
    expect(b).toEqual({ v: 1, seeded: true, pages: [[1, 0], [2, -1], [8, 1]], souls: [[0, 11, 1], [2, 0, 3]], drawers: [[39, 0]], thread: 0,
      caches: [[2, 1, true], [4, 1, false]], sights: [['payphone', 2]], dens: [['hound', 3], ['shade', 0]], margin: ['ok line', 'spaced out', 'bad char flip'] })
  })
  it('caps hold on load: the newest caches and margin lines kept', () => {
    const raw = { v: 1, caches: Array.from({ length: 30 }, (_, i) => [i % 12, i % 4, i % 2 === 0]), margin: Array.from({ length: 20 }, (_, i) => 'line ' + i) }
    const b = parseCasebook(raw, B)
    expect(b.caches.length).toBeLessThanOrEqual(BOOK_CAPS.caches)
    expect(b.margin).toEqual(Array.from({ length: 12 }, (_, i) => 'line ' + (i + 8)))
  })
})

describe('createCasebook', () => {
  it('each find is true once; a repeat, an out-of-range value, an unknown kind or a wrong type is false and changes nothing', () => {
    const { b } = make()
    expect(b.page(3, 1)).toBe(true); expect(b.page(3, 1)).toBe(false); expect(b.page(3, 2)).toBe(false)
    expect(b.soul(0, 4, 1)).toBe(true); expect(b.soul(0, 4, 2)).toBe(false)
    expect(b.drawer(7, 2)).toBe(true); expect(b.drawer(7, 2)).toBe(false)
    expect(b.thread(1)).toBe(true); expect(b.thread(1)).toBe(false); expect(b.thread(0)).toBe(false); expect(b.thread(3)).toBe(true); expect(b.thread(4)).toBe(false)
    expect(b.cache(2, 1, true)).toBe(true); expect(b.cache(2, 1, true)).toBe(false); expect(b.cache(2, 1, false, 'maddie')).toBe(true)
    expect(b.sight('payphone', 1)).toBe(true); expect(b.sight('payphone', 1)).toBe(false); expect(b.sight('payphone', 2)).toBe(true)
    expect(b.den('hound', 2)).toBe(true); expect(b.den('hound', 2)).toBe(false)
    const before = JSON.stringify(b.toJSON())
    for (const bad of [() => b.page(26, 0), () => b.page(1, 4), () => b.page('1', 0), () => b.page(1.5, 0), () => b.soul(1, 0, 0), () => b.soul(0, 12, 0),
      () => b.soul(9, 0, 0), () => b.drawer(40, 0), () => b.drawer(1, -1), () => b.cache(12, 0, true), () => b.cache(1, 9, true), () => b.sight('ufo', 0),
      () => b.sight('payphone', -1), () => b.den('dragon', 0), () => b.den('hound', 7), () => b.thread('2'), () => b.page(NaN, 0), () => b.page(null, 0)])
      expect(bad()).toBe(false)
    expect(JSON.stringify(b.toJSON())).toBe(before)
  })
  it('a page an earlier walk kept without its floor learns the floor, and is no new find', () => {
    const { b } = make()
    b.seed([5])
    expect(b.page(5, 2)).toBe(false)
    expect(b.toJSON().pages).toEqual([[5, 2]])
  })
  it('the caches keep the newest 24; who left one is this session only', () => {
    const { b, st, c } = make()
    for (let i = 0; i < 30; i++) b.cache(i % 12, Math.floor(i / 12), i % 2 === 0, 'friend' + i)
    const v = b.view()
    expect(v.caches).toHaveLength(BOOK_CAPS.caches)
    expect(v.caches[0]).toEqual({ ph: 6, lv: 0, mine: true, by: null })                // the oldest six dropped
    expect(v.caches[v.caches.length - 1]).toEqual({ ph: 5, lv: 2, mine: false, by: 'friend29' })
    c.run()
    const stored = st.m.get(CASEBOOK_KEY)
    expect(stored).not.toMatch(/friend/)
    const again = createCasebook({ storage: st, bounds: B, ...clock() })
    expect(again.view().caches[23]).toEqual({ ph: 5, lv: 2, mine: false, by: null })
  })
  it('the margin: at most twelve lines of eighty, control characters stripped; strike takes the newest line holding the word', () => {
    const { b } = make()
    expect(b.jot('')).toBe('empty'); expect(b.jot('   \t ')).toBe('empty'); expect(b.jot(null)).toBe('empty')
    expect(b.jot('a\u0007bell and a\ttab‮')).toBe('ok')
    expect(b.view().margin).toEqual(['a bell and a tab'])
    expect(b.jot('x'.repeat(200))).toBe('ok')
    expect(b.view().margin[1]).toHaveLength(80)
    for (let i = 2; i < 12; i++) expect(b.jot('cone ' + i)).toBe('ok')
    expect(b.jot('one too many')).toBe('full')
    expect(b.view().margin).toHaveLength(12)
    expect(b.strike('CONE')).toBe(true)
    expect(b.view().margin).not.toContain('cone 11'); expect(b.view().margin).toContain('cone 10')
    expect(b.strike('kettle')).toBe(false); expect(b.strike('')).toBe(false)
    expect(b.jot('room again')).toBe('ok')
    for (const l of b.view().margin) expect(l).not.toMatch(/[\u0000-\u001f\u007f-\u009f‪-‮]/)
    expect(cleanLine(' a \n b ')).toBe('a b'); expect(cleanLine(5)).toBe('')
  })
  it('seed runs once, from a save\'s pages, with no floor; it never seeds the radio or anything else, and is no find', () => {
    let firsts = 0
    const { b } = make({ onFirst: () => firsts++ })
    expect(b.seed([1, 2, 2, 99, -1, 'x', 3])).toBe(true)
    expect(b.seed([4])).toBe(false)
    const j = b.toJSON()
    expect(j.pages).toEqual([[1, -1], [2, -1], [3, -1]])
    expect(j.seeded).toBe(true)
    expect([j.souls, j.drawers, j.thread, j.caches, j.sights, j.dens, j.margin]).toEqual([[], [], 0, [], [], [], []])
    expect(Object.keys(j)).not.toContain('radio')
    expect(firsts).toBe(0)
    b.page(7, 0)
    expect(firsts).toBe(1)
  })
  it('onFirst fires on the first find this device keeps, once; again only after forget', () => {
    let firsts = 0
    const { b } = make({ onFirst: () => firsts++ })
    b.jot('a line of mine')
    expect(firsts).toBe(0)                                                    // the margin is yours, not a find
    b.sight('tvwall', 1); b.page(2, 1); b.den('hound', 2)
    expect(firsts).toBe(1)
    b.forget()
    b.thread(1)
    expect(firsts).toBe(2)
  })
  it('toJSON keys are exactly the allowed set, and nothing a find must never carry', () => {
    const { b, st, c } = make()
    b.page(1, 0); b.soul(0, 1, 1); b.drawer(2, 2); b.thread(2); b.cache(3, 3, false, 'a friend\'s name'); b.sight('mannequin', 0); b.den('lurker', 1); b.jot('mine')
    const j = b.toJSON()
    expect(Object.keys(j)).toEqual(BOOK_KEYS)
    expect(BOOK_KEYS).toEqual(['v', 'seeded', 'pages', 'souls', 'drawers', 'thread', 'caches', 'sights', 'dens', 'margin'])
    c.run()
    const raw = st.m.get(CASEBOOK_KEY)
    for (const k of ['by', 'answer', 'key', '"x"', '"y"', 'anchor', 'thin', 'caption', 'radio', "a friend's name", 'lat', 'lng'])
      expect(raw, k).not.toContain(k)
    expect(JSON.parse(raw)).toEqual(j)
  })
  it('writes wait for the debounce, and once; flush writes now', () => {
    const { b, st, c } = make()
    b.page(1, 0); b.page(2, 0); b.sight('payphone', 1)
    expect(st.writes).toEqual([]); expect(c.pending()).toBe(1)
    c.run()
    expect(st.writes).toEqual([CASEBOOK_KEY])
    b.jot('later')
    b.flush()
    expect(st.writes).toEqual([CASEBOOK_KEY, CASEBOOK_KEY])
    expect(c.pending()).toBe(0)
    expect(JSON.parse(st.m.get(CASEBOOK_KEY)).margin).toEqual(['later'])
  })
  it('forget wipes it, at once, and a save is not seeded again', () => {
    const { b, st } = make()
    b.page(1, 0); b.jot('mine'); b.cache(1, 1, false, 'someone')
    b.forget()
    const j = JSON.parse(st.m.get(CASEBOOK_KEY))
    expect(j).toEqual({ v: 1, seeded: true, pages: [], souls: [], drawers: [], thread: 0, caches: [], sights: [], dens: [], margin: [] })
    expect(b.seed([3])).toBe(false)
    expect(b.view().pages).toEqual([])
  })
  it('a storage that throws keeps everything in memory, for this page; no storage at all works the same', () => {
    for (const storage of [throwing, null]) {
      const { b, c } = make({ storage })
      expect(b.page(4, 2)).toBe(true)
      expect(b.jot('kept')).toBe('ok')
      expect(() => { c.run(); b.flush(); b.forget() }).not.toThrow()
      b.page(5, 1)
      expect(b.view().pages).toEqual([{ frag: 5, lv: 1 }])
    }
    // importing and creating in Node without localStorage
    expect(() => createCasebook({ bounds: B, ...clock() })).not.toThrow()
  })
  it('view is a frozen read, built fresh', () => {
    const { b } = make()
    b.page(1, 0)
    const v = b.view()
    expect(Object.isFrozen(v)).toBe(true); expect(Object.isFrozen(v.pages)).toBe(true); expect(Object.isFrozen(v.pages[0])).toBe(true)
    b.page(2, 0)
    expect(v.pages).toHaveLength(1); expect(b.view().pages).toHaveLength(2)
  })
})
