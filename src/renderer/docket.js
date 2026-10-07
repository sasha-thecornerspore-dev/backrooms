// docket.js — the floor's file.
//
// Every wish filed under a status carries a trailer ('filed under: EXTENSION · level 2');
// a workflow step recounts them into world.json's `docket` (open files per status per
// floor) and the release ships it. Here that tally becomes a STANDING per floor, and the
// standing leans ritual geography — where the pages, the machines and the souls fall, what
// the tray drops, how often the dark stirs — never difficulty. Pure and import-free: a
// function of world.json + level (+ the room's cached standing, for the ambient terms only),
// so every client of one release lays a seed's floor out the same. A zero docket is today.

const zeros = () => ({ extension: 0, compliance: 0, litigation: 0 })
const freezeRow = () => Object.freeze(zeros())

export const EMPTY_DOCKET = Object.freeze({ '0': freezeRow(), '1': freezeRow(), '2': freezeRow(), '3': freezeRow() })

// the three docket columns; 'notice-mailed' is the unfiled default and is never counted
export const STATUS_KEYS = Object.freeze(['extension', 'compliance', 'litigation'])

export const EMPTY_STANDING = Object.freeze({ counts: freezeRow(), total: 0, lead: null, margin: 0, depth: null })

// the ONLY cfg paths the overlay may touch: exits stay put so every client of a seed sees the
// same ways; dress / haunts / sights are the core's own placement goldens
export const PLACEMENT_KEYS = Object.freeze(['scraps.denom', 'machines.denom', 'npc.denom', 'items.types'])

// mirrors decor.js's fallbacks (`config.npc?.denom ?? 16`, …) — a test pins the spellings
export const DECOR_DEFAULT_DENOM = Object.freeze({ scraps: 7, machines: 20, npc: 16 })

const count = (v) => (Number.isInteger(v) && v >= 0 ? v : 0)
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

// a lead needs two files at least and a clear first place; the margin is its lead over the
// runner-up as a share of every open file
export function standingOf(counts, depth = null) {
  const src = isObj(counts) ? counts : {}
  const c = { extension: count(src.extension), compliance: count(src.compliance), litigation: count(src.litigation) }
  const total = c.extension + c.compliance + c.litigation
  let lead = null, max = -1, second = -1
  for (const k of STATUS_KEYS) {
    const v = c[k]
    if (v > max) { second = max; max = v; lead = k } else if (v > second) second = v
  }
  if (!(max >= 2 && max > second)) lead = null
  const margin = lead ? Math.max(0, Math.min(1, (max - second) / Math.max(total, 1))) : 0
  return { counts: c, total, lead, margin, depth }
}

// the CALLER resolves depth (`cfg.map ? null : depthOf(index)`): ∅ never inherits the lobby's
// docket, and a drifted docket (not an object, a row not an object) reads as zeros
export function standing(docket, depth) {
  if (!Number.isInteger(depth) || depth < 0 || depth > 3) return EMPTY_STANDING
  const row = isObj(docket) ? docket[String(depth)] : null
  return standingOf(isObj(row) ? row : null, depth)
}

// the overlay by lead: denoms stored as multipliers, items.types as the entries to append.
// one argument on purpose — the room never reaches placement
export function placementMods(st) {
  const lead = st?.lead ?? null
  const m = st?.margin ?? 0
  if (!lead || !(m > 0)) return {}
  if (lead === 'extension') {
    const o = { 'scraps.denom': 1 - 0.3 * m, 'machines.denom': 1 - 0.3 * m }
    if (m > 0.2) o['items.types'] = ['almond-water']
    return o
  }
  if (lead === 'compliance') return { 'scraps.denom': 1 + 0.6 * m, 'npc.denom': 1 + 0.3 * m }
  if (lead === 'litigation') {
    const o = { 'npc.denom': 1 - 0.3 * m }
    if (m > 0.2) o['items.types'] = ['polaroid', 'radio']
    return o
  }
  return {}
}

// mutates and returns the SAME cfg, once per buildLevel at the cfg stage. a denom of 0 stays 0
// (∅'s zeros, compliance's closing zero); a duplicate items.types entry is the lean itself
// (items.js picks `types[hash % types.length]`, so two waters double the water)
export function applyPlacement(cfg, overlay) {
  if (!overlay) return cfg
  for (const k of PLACEMENT_KEYS) {
    const v = overlay[k]
    if (v === undefined) continue
    if (k === 'items.types') {
      if (!Array.isArray(v) || !v.length) continue
      cfg.items = { ...(cfg.items ?? {}), types: [...(cfg.items?.types ?? []), ...v] }
      continue
    }
    if (!Number.isFinite(v)) continue
    const x = k.slice(0, k.indexOf('.'))
    const cur = cfg[x]?.denom ?? DECOR_DEFAULT_DENOM[x]
    cfg[x] = { ...(cfg[x] ?? {}), denom: cur === 0 ? 0 : Math.max(1, Math.round(cur * v)) }
  }
  return cfg
}

// the docket standing plus the room's fresh on-floor statuses (W1's bus.roomStanding()) —
// AMBIENT terms only; 'notice-mailed' and total are ignored
export function withRoom(st, room) {
  if (!room) return st
  const c = st?.counts ?? EMPTY_STANDING.counts
  return standingOf({
    extension: count(c.extension) + count(room.extension),
    compliance: count(c.compliance) + count(room.compliance),
    litigation: count(c.litigation) + count(room.litigation),
  }, st?.depth ?? null)
}

// recomputed on buildLevel and on the room's change, never per frame
export function ambientMods(st, room = null) {
  const a = withRoom(st ?? EMPTY_STANDING, room)
  const m = a.margin
  const tension = a.lead === 'extension' ? 0.15 * m : a.lead === 'compliance' ? -0.15 * m : 0
  const thinChance = a.lead === 'litigation' ? 0.3 + 0.2 * m : 0.3
  const standFloor = a.depth === 2 && a.lead === 'extension' ? 2 : 3
  return { tension, thinChance, standFloor }
}

// order: the lead first, then by count, ties alphabetical (STATUS_KEYS sorted)
const ALPHA = Object.freeze(STATUS_KEYS.slice().sort())
const byCount = (c, lead) => (a, b) => (a === lead ? -1 : b === lead ? 1 : 0) || c[b] - c[a] || (a < b ? -1 : a > b ? 1 : 0)

// the station reading the docket: never a number, at most nine words
export function rollCall(st) {
  const s = st ?? EMPTY_STANDING
  const total = s.total ?? 0
  if (total <= 0) return 'the station reads the floor. nothing is filed here.'
  if (total === 1) return 'one file is open on this floor. the floor does not lean.'
  const c = s.counts
  const order = ALPHA.slice().sort(byCount(c, s.lead))
  const n = Math.min(9, total)
  // largest remainder: floor every share, then hand the rest out by remainder (ties in order)
  const quota = {}
  let given = 0
  for (const k of order) { quota[k] = Math.floor((c[k] * n) / total); given += quota[k] }
  const rest = order.slice().sort((a, b) => {
    const ra = (c[a] * n) / total - quota[a], rb = (c[b] * n) / total - quota[b]
    return rb - ra || order.indexOf(a) - order.indexOf(b)
  })
  for (let i = 0; given < n && i < rest.length; i++, given++) quota[rest[i]]++
  const words = []
  for (const k of order) for (let i = 0; i < quota[k]; i++) words.push(k)
  return 'the station reads the floor, slow and patient: ' + words.join('. ') + '. — ' +
    (s.lead ? `the floor leans toward ${s.lead}.` : 'the floor does not lean.')
}

// the tray reads the DOCKET standing (level.st), never the room: one stamp per release
const TRAY = Object.freeze({
  extension: Object.freeze({ item: 'almond-water', stamp: 'EXTENSION' }),
  compliance: Object.freeze({ item: 'bandage', stamp: 'COMPLIANCE' }),
  litigation: Object.freeze({ item: 'polaroid', stamp: 'LITIGATION' }),
})
const NO_TRAY = Object.freeze({ item: null, stamp: null })

export function trayLean(st) {
  const lead = st?.lead
  return typeof lead === 'string' && Object.hasOwn(TRAY, lead) ? TRAY[lead] : NO_TRAY
}
