// server/evlog.js — COPY of relay/evlog.js. Do not edit here: edit relay/evlog.js and
// re-copy. The packaged app bundles server/ but not relay/, so the node server cannot
// import across. test/evguard.test.js asserts both copies are equal below their headers.
// relay/evlog.js — the keep/drop log: frames a room remembers for late joiners.
//
// The ONLY server-stateful addition of the ev substrate, and the owner's
// explicit opt-in (relay: env.EV_LOG; node server: --evlog / EV_LOG=1). A
// client marks a frame keep:'<key>' (a cache set down) and the same key
// drop:'<key>' (the cache taken); whoever joins later gets the surviving
// frames replayed right after welcome, stamped replay:true by the server.
//
// Pure; server/evlog.js is a byte-identical copy below its header (the
// packaged app bundles server/ but not relay/). test/evguard.test.js keeps
// the two equal.
//
// Bounds: `max` newest keys overall (FIFO), `perName` per sender name (a 7th
// from one name evicts that name's oldest). 'wanderer' is the shared blank
// name, so its cap is counted per key-prefix + sender id instead (W6
// NAME_CAP_EXEMPT) — one anonymous player cannot evict another's.

const DEFAULTS = { max: 64, perName: 6 }
const SHARED_NAME = 'wanderer'

export function createEvLog(opts = {}) {
  const max = Math.max(1, (opts.max | 0) || DEFAULTS.max)
  const perName = Math.max(1, (opts.perName | 0) || DEFAULTS.perName)
  const entries = new Map()   // key → { group, frame } in insertion order

  const groupOf = (key, name, frame) =>
    name === SHARED_NAME ? key.split(':')[0] + '|' + String(frame.id ?? '') : String(name ?? '')

  function keep(key, name, frame) {
    if (typeof key !== 'string' || !key || !frame || typeof frame !== 'object') return
    const group = groupOf(key, name, frame)
    entries.delete(key)                   // same key replaces, and becomes the newest
    let own = 0
    let oldest = null
    for (const [k, e] of entries) {
      if (e.group !== group) continue
      if (oldest === null) oldest = k
      own++
    }
    if (own >= perName && oldest !== null) entries.delete(oldest)
    entries.set(key, { group, frame })
    while (entries.size > max) entries.delete(entries.keys().next().value)
  }

  function drop(key) {
    if (typeof key === 'string') entries.delete(key)
  }

  function replay() {
    const out = []
    for (const e of entries.values()) out.push(e.frame)
    return out
  }

  function size() { return entries.size }

  return { keep, drop, replay, size }
}
