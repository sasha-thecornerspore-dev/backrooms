// casebook.js — what the field terminal reads back (terminal.js): the record of what you found, kept on this device.
//
// One key, backrooms:casebook = { v: 1, seeded, pages, souls, drawers, thread, caches, sights, dens, margin }, global per browser or app
// like the prefs: it outlives runs and rooms, is never part of the save and is never sent. Each entry is indices into the game's own
// tables plus the floor it was found on (-1: an earlier walk the save did not say the floor of), so the record holds no text of its own
// but the margin you write:
//   pages   [[frag, lv]]        m.'s pages read, in the order found (SCRAPS index)
//   souls   [[k, i, lv]]        a lost soul's line: k 0 is the souls' own pool (game.js NPC_LINES), k n the n-th status's line
//   drawers [[i, lv]]           a drawer's note (containers.js DRAWER_NOTES)
//   thread  0..3                how far the first run's thread came (firstrun.js)
//   caches  [[ph, lv, mine]]    a cache's phrase picked up (caches.js PHRASES), the newest 24; who left it is memory only
//   sights  [[type, lv]]        a sight seen (sightpins.js SIGHT_LINES)
//   dens    [[kind, lv]]        a den the film caught (film.js KINDS)
//   margin  [string]            your lines: at most 12 of 80 characters, control characters stripped
// It never holds an answer, a seal key, a caption, another player's name, the radio, a coordinate or the pin, the thin layer, the
// block's lines, or anything of the atlas. Writes go out on a debounce (and flush()); a storage that throws keeps it all in memory.
//
// createCasebook({ storage, bounds, onFirst }) -> { page, soul, drawer, thread, cache, sight, den (each true only when new), jot, strike,
//   seed, forget, view, toJSON, flush }. bounds = { pages, souls: [n0, n1..], drawers, phrases, sights: [keys], kinds: [KINDS], floors,
//   thread }. onFirst fires on the first find this device keeps (seeded pages from a save are not finds; after forget it may fire again).

export const CASEBOOK_KEY = 'backrooms:casebook'
export const CASEBOOK_V = 1
export const BOOK_KEYS = Object.freeze(['v', 'seeded', 'pages', 'souls', 'drawers', 'thread', 'caches', 'sights', 'dens', 'margin'])
export const BOOK_CAPS = Object.freeze({ caches: 24, margin: 12, line: 80 })

const isInt = Number.isInteger
// C0, DEL, C1 and the bidirectional controls: none of them reaches the margin
const CONTROL = /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g
export function cleanLine(s) {
  return typeof s === 'string' ? s.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim().slice(0, BOOK_CAPS.line).trim() : ''
}

const empty = () => ({ v: CASEBOOK_V, seeded: false, pages: [], souls: [], drawers: [], thread: 0, caches: [], sights: [], dens: [], margin: [] })
const lvOk = (lv, b, unknown) => isInt(lv) && (lv >= 0 ? lv < b.floors : unknown && lv === -1)
const idx = (i, n) => isInt(i) && i >= 0 && i < n
const has = (list, v) => Array.isArray(list) && list.includes(v)

// one entry, checked and copied to its exact shape, or null
const SHAPES = {
  pages: (e, b) => (idx(e[0], b.pages) && lvOk(e[1], b, true) ? [e[0], e[1]] : null),
  souls: (e, b) => (idx(e[0], b.souls.length) && idx(e[1], b.souls[e[0]]) && lvOk(e[2], b) ? [e[0], e[1], e[2]] : null),
  drawers: (e, b) => (idx(e[0], b.drawers) && lvOk(e[1], b) ? [e[0], e[1]] : null),
  caches: (e, b) => (idx(e[0], b.phrases) && lvOk(e[1], b) && typeof e[2] === 'boolean' ? [e[0], e[1], e[2]] : null),
  sights: (e, b) => (typeof e[0] === 'string' && has(b.sights, e[0]) && lvOk(e[1], b) ? [e[0], e[1]] : null),
  dens: (e, b) => (typeof e[0] === 'string' && has(b.kinds, e[0]) && lvOk(e[1], b) ? [e[0], e[1]] : null),
}
// what makes two entries the same find
const KEY_OF = {
  pages: (e) => e[0],
  souls: (e) => e[0] + ':' + e[1],
  drawers: (e) => e[0],
  caches: (e) => e[0] + ':' + e[1] + ':' + e[2],
  sights: (e) => e[0] + ':' + e[1],
  dens: (e) => e[0] + ':' + e[1],
}

// raw (the stored JSON, or an object) -> a fresh, valid book. Empty, corrupt or foreign: an empty book. Unknown keys, out-of-range or
// wrong-type entries and repeats are dropped; the caps hold (the newest kept)
export function parseCasebook(raw, bounds) {
  let o = raw
  if (typeof raw === 'string') { try { o = JSON.parse(raw) } catch (e) { o = null } }
  const book = empty()
  if (!o || typeof o !== 'object' || Array.isArray(o) || o.v !== CASEBOOK_V) return book
  book.seeded = o.seeded === true
  for (const k of Object.keys(SHAPES)) {
    if (!Array.isArray(o[k])) continue
    const seen = new Set()
    for (const e of o[k]) {
      if (!Array.isArray(e)) continue
      const x = SHAPES[k](e, bounds)
      if (!x) continue
      const key = KEY_OF[k](x)
      if (seen.has(key)) continue
      seen.add(key); book[k].push(x)
    }
  }
  if (book.caches.length > BOOK_CAPS.caches) book.caches = book.caches.slice(-BOOK_CAPS.caches)
  if (isInt(o.thread) && o.thread > 0 && o.thread <= bounds.thread) book.thread = o.thread
  if (Array.isArray(o.margin)) for (const m of o.margin) { const t = cleanLine(m); if (t) book.margin.push(t) }
  if (book.margin.length > BOOK_CAPS.margin) book.margin = book.margin.slice(-BOOK_CAPS.margin)
  return book
}

function defaultStorage() { try { return globalThis.localStorage || null } catch (e) { return null } }

export function createCasebook({ storage, bounds, onFirst = null, debounceMs = 2000, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  const st = storage === undefined ? defaultStorage() : storage
  let raw = null
  try { raw = st ? st.getItem(CASEBOOK_KEY) : null } catch (e) { raw = null }
  let book = parseCasebook(raw, bounds)
  const byOf = new Map()          // a cache entry -> who left it, this session only (another player's name is never stored)
  let timer = null

  function toJSON() {
    const o = { v: CASEBOOK_V, seeded: book.seeded }
    for (const k of ['pages', 'souls', 'drawers']) o[k] = book[k].map((e) => e.slice())
    o.thread = book.thread
    for (const k of ['caches', 'sights', 'dens']) o[k] = book[k].map((e) => e.slice())
    o.margin = book.margin.slice()
    return o
  }
  function flush() {
    if (timer !== null) { try { clearTimer(timer) } catch (e) {} timer = null }
    try { if (st) st.setItem(CASEBOOK_KEY, JSON.stringify(toJSON())) } catch (e) { /* memory keeps it for this page */ }
  }
  function dirty() {
    if (timer !== null) return
    try { timer = setTimer(() => { timer = null; flush() }, debounceMs) } catch (e) { flush() }
  }
  const finds = () => book.pages.some((e) => e[1] >= 0) || book.souls.length > 0 || book.drawers.length > 0 || book.thread > 0 ||
    book.caches.length > 0 || book.sights.length > 0 || book.dens.length > 0
  function first(was) { if (!was && onFirst) { try { onFirst() } catch (e) {} } }

  // one find into its list -> true when it is new
  function note(kind, entry) {
    const x = SHAPES[kind](entry, bounds)
    if (!x) return false
    const key = KEY_OF[kind](x)
    const list = book[kind]
    const at = list.findIndex((e) => KEY_OF[kind](e) === key)
    if (at >= 0) {
      // a page an earlier walk kept without its floor learns it now (not a new find)
      if (kind === 'pages' && list[at][1] === -1 && x[1] >= 0) { list[at][1] = x[1]; dirty() }
      return false
    }
    const was = finds()
    list.push(x)
    dirty()
    first(was)
    return true
  }

  return {
    page: (frag, lv) => note('pages', [frag, lv]),
    soul: (k, i, lv) => note('souls', [k, i, lv]),
    drawer: (i, lv) => note('drawers', [i, lv]),
    sight: (type, lv) => note('sights', [type, lv]),
    den: (kind, lv) => note('dens', [kind, lv]),
    thread(step) {
      if (!isInt(step) || step <= book.thread || step > bounds.thread) return false
      const was = finds()
      book.thread = step; dirty(); first(was)
      return true
    },
    cache(ph, lv, mine, by = null) {
      const isNew = note('caches', [ph, lv, !!mine])
      if (!isNew) return false
      const e = book.caches[book.caches.length - 1]
      if (!mine && typeof by === 'string' && by) byOf.set(e, by)
      while (book.caches.length > BOOK_CAPS.caches) byOf.delete(book.caches.shift())
      return true
    },
    // -> 'ok' | 'empty' | 'full'
    jot(text) {
      const t = cleanLine(text)
      if (!t) return 'empty'
      if (book.margin.length >= BOOK_CAPS.margin) return 'full'
      book.margin.push(t); dirty()
      return 'ok'
    },
    // the newest margin line holding the word, struck -> whether one was
    strike(word) {
      const w = cleanLine(word).toLowerCase()
      if (!w) return false
      for (let i = book.margin.length - 1; i >= 0; i--) {
        if (book.margin[i].toLowerCase().includes(w)) { book.margin.splice(i, 1); dirty(); return true }
      }
      return false
    },
    // a save's pages, once per device, with no floor (the save never said): never the radio, never a find
    seed(pagesRead) {
      if (book.seeded) return false
      book.seeded = true
      if (Array.isArray(pagesRead)) for (const f of pagesRead) {
        const x = SHAPES.pages([f, -1], bounds)
        if (x && !book.pages.some((e) => e[0] === x[0])) book.pages.push(x)
      }
      dirty()
      return true
    },
    // the settings' Forget: the record goes, at once (a save's pages are not seeded again)
    forget() {
      book = empty(); book.seeded = true; byOf.clear()
      flush()
    },
    view() {
      const fz = Object.freeze
      return fz({
        seeded: book.seeded,
        pages: fz(book.pages.map((e) => fz({ frag: e[0], lv: e[1] }))),
        souls: fz(book.souls.map((e) => fz({ k: e[0], i: e[1], lv: e[2] }))),
        drawers: fz(book.drawers.map((e) => fz({ i: e[0], lv: e[1] }))),
        thread: book.thread,
        caches: fz(book.caches.map((e) => fz({ ph: e[0], lv: e[1], mine: e[2], by: byOf.get(e) ?? null }))),
        sights: fz(book.sights.map((e) => fz({ type: e[0], lv: e[1] }))),
        dens: fz(book.dens.map((e) => fz({ kind: e[0], lv: e[1] }))),
        margin: fz(book.margin.slice()),
      })
    },
    toJSON,
    flush,
  }
}
