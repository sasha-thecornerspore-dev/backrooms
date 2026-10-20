// server/evlog.js — COPY of relay/evlog.js. Do not edit here: edit relay/evlog.js and
// re-copy. The packaged app bundles server/ but not relay/, so the node server cannot
// import across. test/evguard.test.js asserts both copies are equal below their headers.
// relay/evlog.js — the keep/drop log: frames a room remembers for late joiners.
//
// The ONLY server-stateful addition of the ev substrate. On the relay it is on
// unless the EV_LOG var is '0' (declared in relay/wrangler.jsonc, the one place
// it is set); the node server keeps it only with --evlog / EV_LOG=1. A client
// marks a frame keep:'<key>' (a cache set down) and the same key drop:'<key>'
// (the cache taken); whoever joins later gets the surviving frames replayed
// right after welcome, stamped replay:true by the server. Which kinds may be
// kept or dropped, and how often one socket may keep, is evguard.js's.
//
// Pure; server/evlog.js is a byte-identical copy below its header (the
// packaged app bundles server/ but not relay/). test/evguard.test.js keeps
// the two equal.
//
// Bounds: `max` newest keys overall (FIFO), `perName` per sender name (a 7th
// from one name evicts that name's oldest). 'wanderer' is the shared blank
// name, so its cap is counted per sender id instead (W6 NAME_CAP_EXEMPT): one
// anonymous player cannot evict another's, and cannot slip its own cap by
// varying the key's prefix.
//
// What a kept frame holds: {type, id, name, kind, payload, t} — the name the
// player chose, the cache's place in the maze, and t cut to the UTC day it was
// set down (the client never reads t for a cache). An entry older than
// `ttlDays` (30) is forgotten: never replayed, pruned on import, and the
// relay's alarm deletes what is left of it in storage.
//
// createStoredLog(storage): the relay's storage shell around the log, pure so
// a fake storage tests it. The log is loaded once per instance and assigned
// only after the read succeeded: a failed read is retried on the next call,
// and can never write an empty log over a stored one. flush() writes only
// when something changed (and deletes the key once the log is empty); the
// relay decides how often to call it (relay.js: coalesced, at most one write
// per room every 10 s).

const DEFAULTS = { max: 64, perName: 6, ttlDays: 30 }
const SHARED_NAME = 'wanderer'
export const DAY_MS = 86_400_000
export const EVLOG_KEY = 'evlog'
const dayOf = (ms) => Math.floor(ms / DAY_MS)

export function createEvLog(opts = {}) {
  const max = Math.max(1, (opts.max | 0) || DEFAULTS.max)
  const perName = Math.max(1, (opts.perName | 0) || DEFAULTS.perName)
  const ttlDays = Math.max(1, (opts.ttlDays | 0) || DEFAULTS.ttlDays)
  const clock = typeof opts.now === 'function' ? opts.now : Date.now
  const entries = new Map()   // key → { group, frame, day } in insertion order (day: the UTC day number it was kept)
  let changed = false         // something kept, dropped or forgotten since the last export()

  const groupOf = (name, frame) =>
    name === SHARED_NAME ? SHARED_NAME + '|' + String(frame.id ?? '') : String(name ?? '')

  // forget what is older than ttlDays; -> how many went
  function prune() {
    const today = dayOf(clock())
    let n = 0
    for (const [k, e] of entries) if (today - e.day > ttlDays) { entries.delete(k); n++ }
    if (n) changed = true
    return n
  }

  function keep(key, name, frame) {
    if (typeof key !== 'string' || !key || !frame || typeof frame !== 'object') return
    const day = dayOf(clock())
    const kept = typeof frame.t === 'number' ? { ...frame, t: dayOf(frame.t) * DAY_MS } : frame
    const group = groupOf(name, frame)
    const prev = entries.get(key)
    // the same thing set down again the same day: nothing new to store
    if (prev && prev.group === group && prev.day === day && JSON.stringify(prev.frame) === JSON.stringify(kept)) return
    entries.delete(key)                   // same key replaces, and becomes the newest
    let own = 0
    let oldest = null
    for (const [k, e] of entries) {
      if (e.group !== group) continue
      if (oldest === null) oldest = k
      own++
    }
    if (own >= perName && oldest !== null) entries.delete(oldest)
    entries.set(key, { group, frame: kept, day })
    while (entries.size > max) entries.delete(entries.keys().next().value)
    changed = true
  }

  function drop(key) {
    if (typeof key === 'string' && entries.delete(key)) changed = true
  }

  function replay() {
    prune()
    const out = []
    for (const e of entries.values()) out.push(e.frame)
    return out
  }

  function size() { return entries.size }

  // when the oldest entry is forgotten (ms), or null for an empty log
  function expiresAt() {
    let min = Infinity
    for (const e of entries.values()) if (e.day < min) min = e.day
    return min === Infinity ? null : (min + ttlDays + 1) * DAY_MS
  }

  // a JSON-safe snapshot, oldest first: [key, group, frame, day][]
  function exportLog() {
    const out = []
    for (const [k, e] of entries) out.push([k, e.group, e.frame, e.day])
    changed = false
    return out
  }

  // replace the contents with a snapshot; junk rows are skipped, the overall cap re-applied (per-group caps hold again on the
  // next keep) and anything past ttlDays forgotten (which leaves the log dirty, so the shorter log is what gets written next)
  function importLog(rows) {
    entries.clear()
    if (Array.isArray(rows)) {
      const today = dayOf(clock())
      for (const r of rows) {
        if (!Array.isArray(r) || typeof r[0] !== 'string' || !r[0] || !r[2] || typeof r[2] !== 'object') continue
        entries.set(r[0], { group: String(r[1] ?? ''), frame: r[2], day: Number.isInteger(r[3]) ? r[3] : today })
      }
      while (entries.size > max) entries.delete(entries.keys().next().value)
    }
    changed = false
    prune()
  }

  function dirty() { return changed }

  return { keep, drop, replay, size, prune, expiresAt, export: exportLog, import: importLog, dirty }
}

// storage: { get(key), put(key, value), delete(key), getAlarm?(), setAlarm?(ms) }, each returning a promise (a Durable
// Object's ctx.storage, or a fake). opts go to createEvLog.
export function createStoredLog(storage, opts = {}) {
  let log = null        // the loaded log, null until a read has succeeded
  let pending = null    // the read in flight
  let retry = false     // the last write failed: write again even with nothing new

  function load() {
    if (log) return Promise.resolve(log)
    if (!pending) {
      pending = (async () => {
        try {
          const rows = await storage.get(EVLOG_KEY)
          const l = createEvLog(opts)
          l.import(rows)
          log = l
          return l
        } catch {
          return null       // nothing assigned: the next call reads again, and nothing is written over what is stored
        } finally {
          pending = null
        }
      })()
    }
    return pending
  }

  // write the log if it changed (an empty log deletes the key); -> true when something was written
  async function flush() {
    if (!log || !(log.dirty() || retry)) return false
    const rows = log.export()
    try {
      if (rows.length) await storage.put(EVLOG_KEY, rows)
      else await storage.delete(EVLOG_KEY)
      retry = false
      return true
    } catch {
      retry = true
      return false
    }
  }

  // the alarm that forgets: set for the oldest entry's expiry, and only when none is due sooner (setting one is a write too)
  async function schedule(force = false) {
    if (!log || typeof storage.setAlarm !== 'function') return
    const at = log.expiresAt()
    if (at == null) return
    try {
      const cur = !force && typeof storage.getAlarm === 'function' ? await storage.getAlarm() : null
      if (cur == null || cur > at) await storage.setAlarm(at)
    } catch { /* the next write sets it */ }
  }

  // the alarm itself: forget what is past ttlDays, write (or delete) what is left, set the next one
  async function expire() {
    const l = await load()
    if (!l) return false
    l.prune()
    await flush()
    await schedule(true)
    return true
  }

  // the log switched off (EV_LOG '0'): forget it here and delete what was stored — a read first, so a room with nothing
  // stored costs no write
  async function erase() {
    log = null
    retry = false
    try {
      if ((await storage.get(EVLOG_KEY)) != null) await storage.delete(EVLOG_KEY)
      return true
    } catch {
      return false
    }
  }

  return { load, flush, schedule, expire, erase, dirty: () => !!log && (log.dirty() || retry) }
}
