// src/net/evbus.js — the event bus every co-op lens rides.
//
// One generic relayed message ('ev', see relay/evguard.js) carries every
// verb: whistle, kneel, woke, cache, take, ward, photo — and 'here', the 3 s
// heartbeat that says which floor a friend is on and what the file knows
// about them (origin, thin, status, aseed, light, down, seen). The server
// attaches id/name/t and forwards; THIS is where a frame is believed or not:
//   • registered kind + check(payload)       (the allowlist is one list)
//   • nonce LRU per id                        (a relay replay cannot double a verb)
//   • LIVE gates: per-(id,kind) minGap, maxDist and posKeys against the
//     position the players list reports — you cannot claim to be where the
//     list says you are not
//   • REPLAY (msg.replay === true, stamped by the server from its keep/drop
//     log): replayable kinds only, gates skipped, check and nonce kept
// Peers without a fresh 'here' are LEGACY: an old client, or a friend whose
// heartbeat stopped 8 s ago. Legacy peers keep today's behaviour everywhere
// (onFloor true, never lit/thin/down/stamped).
//
// Pure. deps: { send(kind, payload, opts), now() ms, self() → {x,y,lvl},
// peerPos(id) → {x,y}|null, peerIds() → Set, selfId (value or fn),
// mergeRemote?(id, fields) — lets the client's remote records carry the
// here fields for the renderer }.

export const HERE_INTERVAL_MS = 3000
export const STALE_MS = 8000
export const POS_SLACK = 2.0
export const NONCE_LRU = 256
export const HERE_MIN_GAP_MS = 250

export const STATUSES = ['notice-mailed', 'extension', 'compliance', 'litigation']
const ORIGINS = new Set([null, 'tenant', 'anchored', 'unnamed', 'processed'])
const STS = new Set(['ok', 'down', 'kneel'])
const STATUS_SET = new Set(STATUSES)

// level.index → depth: '∅' is index 4 and the shallowest place there is.
export function depthOf(index) { return index === 4 ? 0 : index }

// The chat-sys line for a friend's floor change, or null when depth held.
export function floorChangeLine(from, to) {
  if (from === 4) return 'fell in.'
  const a = depthOf(from), b = depthOf(to)
  if (b > a) return 'no-clipped deeper.'
  if (b < a) return 'climbed back.'
  return null
}

function hereOk(p) {
  return !!p && typeof p === 'object' &&
    Number.isInteger(p.lvl) && p.lvl >= 0 && p.lvl <= 4 &&
    typeof p.lit === 'boolean' && STS.has(p.st) && typeof p.seen === 'boolean' &&
    ORIGINS.has(p.o) && typeof p.thin === 'boolean' && STATUS_SET.has(p.status) &&
    (p.aseed === null || Number.isInteger(p.aseed)) && p.v === 1
}

function hereShape(f) {
  const lvl = Math.max(0, Math.min(4, Math.trunc(Number(f.lvl)) || 0))
  return {
    lvl,
    lit: !!f.lit,
    st: STS.has(f.st) ? f.st : 'ok',
    seen: !!f.seen,
    o: ORIGINS.has(f.o) ? f.o : null,
    thin: !!f.thin,
    status: STATUS_SET.has(f.status) ? f.status : 'notice-mailed',
    aseed: Number.isInteger(f.aseed) ? f.aseed : null,
    v: 1,
  }
}
const HERE_KEYS = ['lvl', 'lit', 'st', 'seen', 'o', 'thin', 'status', 'aseed']
const sameHere = (a, b) => { for (const k of HERE_KEYS) if (a[k] !== b[k]) return false; return true }

export function createEvBus(deps) {
  const now = deps.now || (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()))
  const myId = () => (typeof deps.selfId === 'function' ? deps.selfId() : deps.selfId)
  const kinds = new Map()        // kind → {check, minGapMs, maxDist, posKeys, replayable}
  const handlers = new Map()     // kind → [cb]
  const lastOut = new Map()      // kind → t
  const lastIn = new Map()       // id → Map(kind → t)
  const nonces = new Map()       // id → {set, q}
  const peers = new Map()        // id → {id, name, lvl, lit, st, seen, o, thin, status, aseed, seenAt, legacy}
  const floorCbs = [], roomCbs = []
  const standing = { 'notice-mailed': 0, extension: 0, compliance: 0, litigation: 0, total: 0 }
  const onFloorList = []         // reused: fresh peers on my floor
  let nOut = 0
  let hereFields = null, hereDirty = false, lastHereAt = -Infinity
  let lastSelfLvl = null

  function register(kind, spec = {}) {
    kinds.set(kind, {
      check: typeof spec.check === 'function' ? spec.check : () => true,
      minGapMs: spec.minGapMs || 0,
      maxDist: spec.maxDist ?? null,
      posKeys: Array.isArray(spec.posKeys) && spec.posKeys.length === 2 ? spec.posKeys : null,
      replayable: !!spec.replayable,
    })
  }

  function on(kind, cb) {
    if (typeof cb !== 'function') return
    if (!handlers.has(kind)) handlers.set(kind, [])
    handlers.get(kind).push(cb)
  }

  function emit(kind, payload, opts) {
    const spec = kinds.get(kind)
    if (!spec || !payload || typeof payload !== 'object') return false
    if (!spec.check(payload)) return false
    const t = now()
    if (spec.minGapMs && lastOut.has(kind) && t - lastOut.get(kind) < spec.minGapMs) return false
    lastOut.set(kind, t)
    payload.n = (nOut++) & 0xffff
    deps.send(kind, payload, opts)
    return true
  }

  function nonceSeen(id, n) {
    if (typeof n !== 'number' || !Number.isFinite(n)) return false
    let rec = nonces.get(id)
    if (!rec) { rec = { set: new Set(), q: [] }; nonces.set(id, rec) }
    if (rec.set.has(n)) return true
    rec.set.add(n); rec.q.push(n)
    if (rec.q.length > NONCE_LRU) rec.set.delete(rec.q.shift())
    return false
  }

  function receive(msg) {
    if (!msg || typeof msg !== 'object' || typeof msg.id !== 'string' || msg.id === myId()) return false
    const spec = kinds.get(msg.kind)
    if (!spec) return false
    const p = msg.payload
    if (!p || typeof p !== 'object' || !spec.check(p)) return false
    const replay = msg.replay === true
    if (replay && !spec.replayable) return false
    const t = now()
    if (!replay) {
      if (spec.minGapMs) {
        let per = lastIn.get(msg.id)
        if (!per) { per = new Map(); lastIn.set(msg.id, per) }
        const last = per.get(msg.kind)
        if (last != null && t - last < spec.minGapMs) return false
        per.set(msg.kind, t)
      }
      if (spec.maxDist != null || spec.posKeys) {
        const pos = deps.peerPos(msg.id)
        if (!pos) return false
        if (spec.maxDist != null) {
          const s = deps.self()
          if (Math.hypot(pos.x - s.x, pos.y - s.y) > spec.maxDist) return false
        }
        if (spec.posKeys) {
          const px = p[spec.posKeys[0]], py = p[spec.posKeys[1]]
          if (typeof px !== 'number' || typeof py !== 'number') return false
          if (Math.hypot(px - pos.x, py - pos.y) > POS_SLACK) return false
        }
      }
    }
    if (nonceSeen(msg.id, p.n)) return false
    const ev = { id: msg.id, name: msg.name, payload: p, t: typeof msg.t === 'number' ? msg.t : t, replay }
    if (msg.kind === 'here') onHere(ev)
    const hs = handlers.get(msg.kind)
    if (hs) for (const cb of hs) { try { cb(ev) } catch {} }
    return true
  }

  // ---- here: peers --------------------------------------------------------
  function seat(id) {
    let rec = peers.get(id)
    if (!rec) {
      rec = { id, name: null, lvl: null, lit: false, st: 'ok', seen: false, o: null, thin: false, status: 'notice-mailed', aseed: null, seenAt: -Infinity, legacy: true }
      peers.set(id, rec)
    }
    return rec
  }

  function onHere(ev) {
    const p = ev.payload
    const rec = seat(ev.id)
    const from = rec.legacy ? null : rec.lvl
    rec.name = ev.name ?? rec.name
    rec.lvl = p.lvl; rec.lit = p.lit; rec.st = p.st; rec.seen = p.seen; rec.o = p.o
    rec.thin = p.thin; rec.status = p.status; rec.aseed = p.aseed
    rec.seenAt = now(); rec.legacy = false
    if (deps.mergeRemote) {
      deps.mergeRemote(ev.id, { lvl: p.lvl, lit: p.lit, st: p.st, seen: p.seen, origin: p.o, thin: p.thin, status: p.status, aseed: p.aseed, legacy: false })
    }
    if (from != null && from !== p.lvl) {
      const line = floorChangeLine(from, p.lvl)
      for (const cb of floorCbs) { try { cb(ev.id, rec.name, from, p.lvl, line) } catch {} }
    }
    recompute()
  }

  const isStale = (rec, t) => t - rec.seenAt > STALE_MS
  const isLegacy = (rec, t) => !rec || rec.legacy || isStale(rec, t)

  function onFloor(id) {
    const rec = peers.get(id)
    if (isLegacy(rec, now())) return true
    return rec.lvl === deps.self().lvl
  }

  function fresh(id) {
    return !isLegacy(peers.get(id), now())
  }

  function freshPeersOnFloor() { return onFloorList }

  // Recomputed on messages (here / players / left), never per frame: tick()
  // only calls this when a peer appeared, vanished, went stale or I moved floors.
  function recompute() {
    const t = now(), lvl = deps.self().lvl
    const before = standing.total, bNm = standing['notice-mailed'], bE = standing.extension, bC = standing.compliance, bL = standing.litigation
    standing['notice-mailed'] = standing.extension = standing.compliance = standing.litigation = standing.total = 0
    onFloorList.length = 0
    for (const rec of peers.values()) {
      if (isLegacy(rec, t) || rec.lvl !== lvl) continue
      onFloorList.push(rec)
      standing[rec.status]++
      standing.total++
    }
    if (standing.total !== before || standing['notice-mailed'] !== bNm || standing.extension !== bE || standing.compliance !== bC || standing.litigation !== bL) {
      for (const cb of roomCbs) { try { cb(standing) } catch {} }
    }
  }

  function roomStanding() { return standing }
  function onRoomChange(cb) { if (typeof cb === 'function') roomCbs.push(cb) }
  function onFloorChange(cb) { if (typeof cb === 'function') floorCbs.push(cb) }

  // ---- here: the heartbeat out ---------------------------------------------
  function flushHere(t) {
    if (!hereFields) return
    if (!hereDirty && t - lastHereAt < HERE_INTERVAL_MS) return
    if (emitHere({ ...hereFields }, t)) { hereDirty = false; lastHereAt = t }
  }

  // the outgoing pace for here lives here, not on the kind, so emit() is one rule
  function emitHere(payload, t) {
    if (t - lastHereAt < HERE_MIN_GAP_MS) return false
    return emit('here', payload)
  }

  function here(fields) {
    const shaped = hereShape(fields || {})
    if (!hereFields || !sameHere(hereFields, shaped)) { hereFields = shaped; hereDirty = true }
    flushHere(now())
  }

  function tick(t = now()) {
    const ids = deps.peerIds()
    let changed = false
    for (const id of peers.keys()) if (!ids.has(id)) { peers.delete(id); changed = true }
    for (const id of ids) if (!peers.has(id)) { seat(id); changed = true }
    for (const rec of peers.values()) {
      // a stale transition is news once; mark it so the next tick is quiet
      if (!rec.legacy && !rec._stale && isStale(rec, t)) { rec._stale = true; changed = true }
      else if (rec._stale && !isStale(rec, t)) { rec._stale = false; changed = true }
    }
    const lvl = deps.self().lvl
    if (lvl !== lastSelfLvl) { lastSelfLvl = lvl; changed = true }
    if (changed) recompute()
    flushHere(t)
  }

  // no inbound gap on here: the server bucket caps the rate and a peer's change
  // must not be lost behind its own heartbeat
  register('here', { check: hereOk })

  return { register, emit, receive, on, here, peers, onFloor, fresh, freshPeersOnFloor, roomStanding, onRoomChange, onFloorChange, tick }
}
