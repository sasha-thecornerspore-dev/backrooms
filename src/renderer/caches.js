// caches.js — a thing set down with a phrase lifted from the pages and an arrow.
//
// A cache IS a dropped item (items.js `dropped`, persisted per floor by levelmem):
// the note rides the record as trailing fields (ph, oct, by, byId, cacheKey).
// This module owns the words, the arrow, the wire checks and the LEDGER — an
// INDEX over cacheKey -> who set it down / which local 'd:' key holds it now,
// plus the per-owner caps. It never stores where a placed cache lies (the
// dropped record does); `pending` holds a received cache only until its
// floor's buildLevel places it. No free text anywhere. Pure.
import { EXIT_DIRS } from './compass.js'

// Every phrase is lifted from a page (scraps.js SCRAPS) — PHRASE_FRAG[i] is the
// page it came from, so what you can say is the part of the record you found.
// The index is the wire's `ph`: a slot keeps its place when its words change.
export const PHRASES = Object.freeze([
  'take the left.',
  'take the right.',
  'it loops.',
  'the almond water is real. drink it.',
  'the dark drinks you back.',
  'it has been an hour of quiet.',
  'i counted too.',
  'there is only further in.',
  'stand still here. the lights hold.',
  'presence it cannot touch.',
  'i am close behind.',
  'it is easier to be lost together.',
])
export const PHRASE_FRAG = Object.freeze([12, 12, 12, 3, 3, 6, 8, 7, 22, 22, 11, 5])

export const MAX_PER_OWNER = 6
// the blank-name default: many strangers share it, so it is capped per id only
export const NAME_CAP_EXEMPT = Object.freeze(['wanderer'])
// the pick 'nothing': today's plain drop
export const NOTE_NONE = null

function fnv1a(s) {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) }
  return h >>> 0
}

// Six distinct phrase indices for this floor and this kind of thing. With
// `readSet` (the frags you have read) the six come only from the pages you
// found, once they hold six phrases; until then, everyone's hashed six.
export function menuFor(lvl, type, readSet = null) {
  let s = fnv1a(`${lvl}:${type}`) | 1
  const next = () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return s >>> 0 }
  let a = PHRASES.map((_, i) => i)
  if (readSet) { const known = a.filter((i) => readSet.has(PHRASE_FRAG[i])); if (known.length >= 6) a = known }
  for (let i = 0; i < 6; i++) {
    const j = i + next() % (a.length - i)
    const t = a[i]; a[i] = a[j]; a[j] = t
  }
  return a.slice(0, 6)
}

// <= 48 chars for any int cell: the servers slice keep/drop keys at 48
export function cacheKey(lvl, cx, cy) { return `c:${lvl}:${cx},${cy}` }

const KEY_RE = /^c:(\d):(-?\d+),(-?\d+)$/
export function parseCacheKey(key) {
  if (typeof key !== 'string') return null
  const m = KEY_RE.exec(key)
  if (!m) return null
  const lvl = +m[1]
  if (lvl > 4) return null
  return { lvl, cx: +m[2], cy: +m[3] }
}

// the dropper's absolute facing in eighths, clockwise from +x (compass.js's rounding);
// `& 7` folds negatives and any winding
export function octOf(angle) { return Math.round(angle / (Math.PI / 4)) & 7 }

// the dropper's facing as seen from the reader's heading
export function arrowFor(oct, readerAngle) {
  return Number.isInteger(oct) && oct >= 0 && oct <= 7 ? EXIT_DIRS[(oct - octOf(readerAngle)) & 7] : ''
}

const isInt = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi
const isNum = (v) => typeof v === 'number' && Number.isFinite(v)

function exOk(ex) {
  if (ex === undefined) return true
  if (!ex || typeof ex !== 'object' || Array.isArray(ex)) return false
  for (const k of Object.keys(ex)) if ((k !== 'sour' && k !== 'tool') || ex[k] !== true) return false
  return true
}

// The 'cache' kind's check. `types` is a Set or an object keyed by type (ITEM_NAMES).
// Unknown keys (the bus's own nonce `n`) are ignored.
export function isCachePayload(p, types) {
  if (!p || typeof p !== 'object') return false
  if (!isInt(p.lvl, 0, 4) || !Number.isInteger(p.cx) || !Number.isInteger(p.cy)) return false
  if (!isNum(p.x) || !isNum(p.y)) return false
  // the cell is where it lies: a key for a far cell would replace (erase) whatever is there
  if (p.cx !== Math.floor(p.x) || p.cy !== Math.floor(p.y)) return false
  if (typeof p.type !== 'string') return false
  if (!(types instanceof Set ? types.has(p.type) : (!!types && Object.prototype.hasOwnProperty.call(types, p.type)))) return false
  if (!isInt(p.ph, -1, PHRASES.length - 1) || !isInt(p.oct, -1, 7)) return false
  return exOk(p.ex)
}

export function isTakePayload(p) {
  return !!p && typeof p === 'object' && typeof p.key === 'string' && parseCacheKey(p.key) !== null
}

// dropAt's `extra` for a received cache. No `on`: a relayed radio arrives silent;
// no clocks: they belong to the one who set it down. by / byId come from the
// frame the server stamped, never from the payload.
export function extraFor(p, id, name, key) {
  return {
    ...(p.ex?.sour && { sour: true }),
    ...(p.ex?.tool && { tool: true }),
    ph: p.ph,
    oct: p.oct,
    by: String(name ?? 'wanderer').slice(0, 24),
    byId: String(id),
    cacheKey: key,
  }
}

const strOrNull = (v) => v === undefined || v === null || typeof v === 'string'

// cacheKey -> { key, lvl, cx, cy, id, name, t, localKey, pending }
export function createCacheLedger({ maxPerOwner = MAX_PER_OWNER } = {}) {
  const entries = new Map()

  // oldest by t; ties go to insertion order (Map order)
  function oldestWhere(pred) {
    let best = null
    for (const e of entries.values()) if (pred(e) && (best === null || e.t < best.t)) best = e
    return best
  }
  function countWhere(pred) {
    let n = 0
    for (const e of entries.values()) if (pred(e)) n++
    return n
  }
  function capBy(pred, evicted) {
    while (countWhere(pred) >= maxPerOwner) {
      const o = oldestWhere(pred)
      if (!o) break
      entries.delete(o.key)
      evicted.push(o)
    }
  }

  function place({ key, lvl, cx, cy, id = null, name = null, t = 0, pending = null }) {
    const replaced = entries.get(key) ?? null
    if (replaced) entries.delete(key)
    const evicted = []
    if (id !== null && id !== undefined) capBy((e) => e.id === id, evicted)
    // a named player reconnecting with a fresh id does not reset the cap
    if (name !== null && name !== undefined && !NAME_CAP_EXEMPT.includes(name)) capBy((e) => e.name === name, evicted)
    entries.set(key, { key, lvl, cx, cy, id: id ?? null, name: name ?? null, t, localKey: null, pending: pending ?? null })
    return { replaced, evicted }
  }

  function take(key) {
    const e = entries.get(key)
    if (!e) return null
    entries.delete(key)
    return e
  }

  function get(key) { return entries.get(key) ?? null }
  function localKey(key) { return entries.get(key)?.localKey ?? null }
  function bind(key, lk) { const e = entries.get(key); if (e) e.localKey = lk ?? null }

  function forLevel(lvl) {
    const out = []
    for (const e of entries.values()) if (e.lvl === lvl) out.push(e)
    return out
  }

  function pendingFor(lvl) {
    const out = []
    for (const e of entries.values()) if (e.lvl === lvl && e.pending !== null) out.push(e)
    return out.sort((a, b) => a.t - b.t)   // stable: ties keep insertion order
  }

  function clearPending(lvl) {
    for (const e of entries.values()) if (e.lvl === lvl) e.pending = null
  }

  // Learn this residency's local keys from what the floor holds; adopt what the
  // floor remembers but the index does not (no caps: what the floor kept, stays).
  function rebind(lvl, records) {
    for (const e of entries.values()) if (e.lvl === lvl) e.localKey = null
    if (!records) return
    for (const r of records) {
      if (!r || typeof r.key !== 'string' || !r.key.startsWith('d:') || typeof r.cacheKey !== 'string') continue
      const k = parseCacheKey(r.cacheKey)
      if (!k || k.lvl !== lvl) continue
      let e = entries.get(r.cacheKey)
      if (!e) {
        e = { key: r.cacheKey, lvl, cx: k.cx, cy: k.cy, id: r.byId ?? null, name: r.by ?? null, t: 0, localKey: null, pending: null }
        entries.set(r.cacheKey, e)
      }
      e.localKey = r.key
    }
  }

  // localKey is per-residency and never saved
  function snapshot() {
    const out = { v: 1, entries: [], pending: [] }
    for (const e of entries.values()) {
      const row = { key: e.key, lvl: e.lvl, cx: e.cx, cy: e.cy, id: e.id, name: e.name, t: e.t }
      if (e.pending) out.pending.push({ ...row, x: e.pending.x, y: e.pending.y, type: e.pending.type, extra: { ...e.pending.extra } })
      else out.entries.push(row)
    }
    return out
  }

  function rowOk(r) {
    if (!r || typeof r !== 'object') return null
    const k = parseCacheKey(r.key)
    if (!k) return null
    if (r.lvl !== k.lvl || r.cx !== k.cx || r.cy !== k.cy) return null
    if (!strOrNull(r.id) || !strOrNull(r.name)) return null
    return { key: r.key, lvl: k.lvl, cx: k.cx, cy: k.cy, id: r.id ?? null, name: r.name ?? null, t: isNum(r.t) ? r.t : 0, localKey: null, pending: null }
  }

  // Tolerates undefined / garbage: every row is checked; a save without caches -> empty.
  function restore(s) {
    entries.clear()
    if (!s || typeof s !== 'object') return
    if (Array.isArray(s.entries)) {
      for (const r of s.entries) { const e = rowOk(r); if (e) entries.set(e.key, e) }
    }
    if (Array.isArray(s.pending)) {
      for (const r of s.pending) {
        const e = rowOk(r)
        if (!e || !isNum(r.x) || !isNum(r.y) || typeof r.type !== 'string') continue
        if (!r.extra || typeof r.extra !== 'object' || Array.isArray(r.extra)) continue
        e.pending = { x: r.x, y: r.y, type: r.type, extra: { ...r.extra } }
        entries.set(e.key, e)
      }
    }
  }

  return {
    place, take, get, localKey, bind, rebind, forLevel, pendingFor, clearPending, snapshot, restore,
    get size() { return entries.size },
  }
}
