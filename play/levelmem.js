// levelmem.js — what each floor remembers of you.
//
// Per level (keyed by String(level)): where you last stood and which chunk you arrived in, how many times you have come, what you took
// (item keys — they never respawn), which machines you emptied and when, which drawers you searched, and what you set down. The one
// owner of this state this release: game.js asks it on every buildLevel / travel / death and saves export() in the snapshot.
//
// A vended key expires only when VEND_RESTOCK_S have passed AND you have been away (visits advanced since the vend): restock needs an
// absence, so it never happens while you watch. Pure: no DOM, no clocks of its own (the play clock is passed in).
import { CHUNK_SIZE } from './world.js'

export const VEND_RESTOCK_S = 600
const CAP = Object.freeze({ taken: 2000, searched: 2000, vended: 500, dropped: 24 })

const num = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d)
const int = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : d)
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

function fresh() {
  return { x: null, y: null, angle: 0, cx: 0, cy: 0, visits: 0, lastT: 0, arrived: null, taken: new Set(), vended: [], searched: new Set(), dropped: [] }
}

// a Set that forgets its oldest entry past the cap (insertion order is the age)
function noteCapped(set, key, cap) {
  if (set.has(key)) return
  set.add(key)
  while (set.size > cap) set.delete(set.values().next().value)
}

export function createLevelMemory() {
  const recs = new Map()   // String(level) -> record

  function rec(level) {
    const k = String(level)
    let r = recs.get(k)
    if (!r) { r = fresh(); recs.set(k, r) }
    return r
  }

  // you are leaving `level` from (player.x, player.y) in chunk fromC at play time t
  function leave(level, player, fromC, t) {
    const r = rec(level)
    r.x = player.x; r.y = player.y; r.angle = player.angle ?? 0
    r.cx = fromC?.cx ?? r.cx; r.cy = fromC?.cy ?? r.cy
    r.lastT = t
    return r
  }

  // you have arrived on `level` in `chunk` at play time t; returns the record (visits counts this one)
  function arrive(level, chunk, t) {
    const r = rec(level)
    r.visits += 1
    r.arrived = { cx: chunk?.cx ?? 0, cy: chunk?.cy ?? 0 }
    r.lastT = t
    return r
  }

  function get(level) { return recs.get(String(level)) ?? null }

  function takenFor(level) { return rec(level).taken }
  function noteTaken(level, key) { noteCapped(rec(level).taken, String(key), CAP.taken) }

  function searchedFor(level) { return rec(level).searched }
  function noteSearched(level, key) { noteCapped(rec(level).searched, String(key), CAP.searched) }

  // is this vend entry still spent at `now`? expired = enough time AND an absence since
  const spent = (r, e, now) => !(now - e[1] >= VEND_RESTOCK_S && r.visits > e[2])

  // the keys still spent at `now`: a fresh Set (buildLevel keeps it as the frame's vendedSet)
  function vendedFor(level, now) {
    const out = new Set()
    const r = get(level)
    if (!r) return out
    for (const e of r.vended) if (spent(r, e, now)) out.add(e[0])
    return out
  }

  // the machine `key` was emptied at play time t (this visit); one entry per key, oldest out past the cap
  function noteVended(level, key, t) {
    const r = rec(level)
    key = String(key)
    for (let i = 0; i < r.vended.length; i++) if (r.vended[i][0] === key) { r.vended.splice(i, 1); break }
    r.vended.push([key, num(t), r.visits])
    while (r.vended.length > CAP.vended) r.vended.shift()
  }

  // true when `key` was spent on a previous visit and has restocked since (so the line 'the machine has been refilled. by whom.' is
  // earned); drawing it again (noteVended) replaces the entry, so it is true exactly once per restock. A previous visit alone is not a
  // restock: the clock read is `now` when given, else the current visit's arrival time (lastT) — the moment buildLevel took vendedFor.
  function wasRestocked(level, key, now = null) {
    const r = get(level)
    if (!r) return false
    key = String(key)
    const t = typeof now === 'number' && Number.isFinite(now) ? now : r.lastT
    for (const e of r.vended) if (e[0] === key) return !spent(r, e, t)
    return false
  }

  function droppedFor(level) { return rec(level).dropped.slice() }
  function setDropped(level, list) { rec(level).dropped = Array.isArray(list) ? list.slice(-CAP.dropped) : [] }

  // plain data for the save file: Sets become arrays
  function exportAll() {
    const out = {}
    for (const [k, r] of recs) {
      out[k] = {
        x: r.x, y: r.y, angle: r.angle, cx: r.cx, cy: r.cy, visits: r.visits, lastT: r.lastT,
        arrived: r.arrived ? { cx: r.arrived.cx, cy: r.arrived.cy } : null,
        taken: [...r.taken], vended: r.vended.map((e) => [e[0], e[1], e[2]]), searched: [...r.searched], dropped: r.dropped.slice(),
      }
    }
    return out
  }

  // replaces what is here; tolerates undefined / garbage / oversized arrays (every field falls back, every list is filtered and capped
  // to its newest entries)
  function importAll(obj) {
    recs.clear()
    if (!isObj(obj)) return
    for (const k of Object.keys(obj)) {
      const s = obj[k]
      if (!isObj(s)) continue
      const r = fresh()
      r.x = typeof s.x === 'number' && Number.isFinite(s.x) ? s.x : null
      r.y = typeof s.y === 'number' && Number.isFinite(s.y) ? s.y : null
      if (r.x === null || r.y === null) { r.x = null; r.y = null }
      r.angle = num(s.angle); r.cx = int(s.cx); r.cy = int(s.cy); r.visits = Math.max(0, int(s.visits)); r.lastT = num(s.lastT)
      r.arrived = isObj(s.arrived) && Number.isFinite(s.arrived.cx) && Number.isFinite(s.arrived.cy) ? { cx: Math.floor(s.arrived.cx), cy: Math.floor(s.arrived.cy) } : null
      const strs = (a, cap) => (Array.isArray(a) ? a.filter((v) => typeof v === 'string') : []).slice(-cap)
      for (const key of strs(s.taken, CAP.taken)) r.taken.add(key)
      for (const key of strs(s.searched, CAP.searched)) r.searched.add(key)
      if (Array.isArray(s.vended)) {
        const seen = new Set()
        const v = []
        for (const e of s.vended) {
          if (!Array.isArray(e) || typeof e[0] !== 'string' || !Number.isFinite(e[1]) || !Number.isFinite(e[2]) || seen.has(e[0])) continue
          seen.add(e[0]); v.push([e[0], e[1], Math.floor(e[2])])
        }
        r.vended = v.slice(-CAP.vended)
      }
      if (Array.isArray(s.dropped)) r.dropped = s.dropped.filter(isObj).slice(-CAP.dropped)
      recs.set(String(k), r)
    }
  }

  return {
    leave, arrive, get, takenFor, noteTaken, vendedFor, noteVended, wasRestocked, searchedFor, noteSearched, droppedFor, setDropped,
    export: exportAll, import: importAll,
  }
}

// ── the resume order (pure; game.js hands it its closures) ──
// applyResume(resume, deps) restores a saved run in the one documented order:
//   mem.import + playT + deaths -> buildLevel(level, mem.arrived) -> the player fields (deps.applyPlayer, which returns the player so the
//   resumed chunk is read from it) -> decor / items scan at that chunk (deps.updateAt) -> restoreDispelled -> fogImport -> settlePlayer.
// A v:1 save missing every new field loads to today's behaviour: fresh memory, playT 0, deaths 0, no spawn override. The deps a later
// integration step provides (restoreDispelled, fogImport) may be absent. Returns { level, spawnChunk, playT, deaths, pcx, pcy }.
export function applyResume(resume, deps) {
  const r = isObj(resume) ? resume : {}
  const { mem, buildLevel, applyPlayer, updateAt, restoreDispelled, fogImport, settlePlayer } = deps
  mem.import(r.memory)
  const playT = Number(r.playT) || 0
  const deaths = Number.isInteger(r.deaths) && r.deaths >= 0 ? r.deaths : 0
  const level = r.level ?? 0
  const spawnChunk = mem.get(level)?.arrived ?? null
  buildLevel(level, spawnChunk)
  const p = applyPlayer(r) ?? { x: 0, y: 0 }
  const pcx = Math.floor(num(p.x) / CHUNK_SIZE), pcy = Math.floor(num(p.y) / CHUNK_SIZE)
  updateAt(pcx, pcy)
  if (typeof restoreDispelled === 'function') restoreDispelled(Array.isArray(r.dispelled) ? r.dispelled : [], 0)
  if (typeof fogImport === 'function') fogImport(r.fog)
  settlePlayer()
  return { level, spawnChunk, playT, deaths, pcx, pcy }
}
