// items.js — things the Backrooms leaves lying around.
// Pure state module: deterministic chunk-seeded spawns, pickup, a small
// inventory, use() and discard() descriptors. Effects are applied by game.js.
// Inventory persists across level transitions; world items are reset per level
// via enterLevel(). Dropped items (set down on purpose) live in their own map:
// never chunk-evicted, picked up like any item, saved per floor by game.js.
import { CHUNK_SIZE } from './world.js'
import { computeLures, RADIO_BATTERY, GLOW_TTL } from './tactics.js'
import { findOpenNear } from './topology.js'

export const ITEM_TYPES = ['almond-water', 'glowstick', 'bandage', 'polaroid', 'radio']
export const MAX_SLOTS = 6
export const MAX_DROPPED = 24
// the deep-stack finds are not put down: a reading, a weight, the one line that stayed open
export const KEPT = new Set(['plumb', 'ballast', 'extension-slip'])
const THROW_AHEAD = 1.2
// the throw is marched in steps of 0.3 u: no step can skip a one-cell (1 u) wall
const THROW_STEPS = 4

// The third channel `c` is the world seed. Math.imul is an EXACT 32-bit multiply
// (no float rounding, identical on every engine), and Math.imul(0, K) === 0, so
// X ^ 0 === X: with seed 0 this hash is byte-identical to the original two-arg
// version. Different worlds therefore get different placement; the unseeded
// world — and every existing golden test — is untouched.
function hash(a, b, c = 0) {
  let h = (a * 2654435761 ^ b * 2246822519 ^ Math.imul(c, 3266489917)) >>> 0
  h ^= h >>> 16; h = Math.imul(h, 0x45d9f3b) >>> 0
  h ^= h >>> 16
  return h >>> 0
}

function itemRng(cx, cy, seed = 0) {
  let s = hash(cx + 7777, cy + 9999, seed) | 1
  return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 0xffffffff }
}

export function createItemSystem(config, isWallFn, worldSeed = 0) {
  let density = Math.max(1, config.items?.density ?? 5)
  let types   = (config.items?.types?.length ? config.items.types : ITEM_TYPES)
  // salt picks WHICH floor (per level); seed picks WHICH world (per anchor/sector).
  // They stay orthogonal: seed rides a separate hash channel, salt shifts coords.
  let salt    = 0
  const seed  = worldSeed | 0   // null / undefined → 0 → the unseeded world

  const worldItems = new Map()  // "cx,cy" → {key, x, y, type}
  const scanned    = new Set()  // chunks already checked this residency
  const taken      = new Set()  // picked up this level — never respawns
  const inventory  = []         // [{type, on?}] — persists across levels
  let   selected   = 0
  const dropped    = new Map()  // "d:n" → {key, x, y, type, on?, onUntil?, t0?, sour?, + a cache's note} — set down, never evicted
  let   dropN      = 0          // next drop key
  let   dirty      = false      // dropped / taken changed since isDirty() last read it
  const expired    = []         // reused: expireDropped's events

  function chunkHasItem(cx, cy) {
    return hash(cx + 7777 + salt, cy + 9999 + salt, seed) % density === 0
  }

  function placeItem(cx, cy, pcx, pcy) {
    const rng = itemRng(cx + salt, cy + salt, seed)
    const type = types[hash(cx + 31 + salt, cy + 17 + salt, seed) % types.length]
    for (let tries = 0; tries < 20; tries++) {
      const lx = 2 + Math.floor(rng() * (CHUNK_SIZE - 4))
      const ly = 2 + Math.floor(rng() * (CHUNK_SIZE - 4))
      const wx = cx * CHUNK_SIZE + lx + 0.5
      const wy = cy * CHUNK_SIZE + ly + 0.5
      if (!isWallFn(wx, wy, pcx, pcy)) {
        const key = `${cx},${cy}`
        worldItems.set(key, { key, x: wx, y: wy, type })
        return
      }
    }
  }

  function update(pcx, pcy) {
    const r = config.chunkEvictRadius ?? 3
    // forget far-away chunks so revisits rescan (mirrors world/entity eviction)
    for (const k of scanned) {
      const [cx, cy] = k.split(',').map(Number)
      if (Math.max(Math.abs(cx - pcx), Math.abs(cy - pcy)) > r + 2) {
        scanned.delete(k)
        worldItems.delete(k)
      }
    }
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const cx = pcx + dx, cy = pcy + dy
        const key = `${cx},${cy}`
        if (scanned.has(key)) continue
        scanned.add(key)
        if (taken.has(key)) continue
        if (chunkHasItem(cx, cy)) placeItem(cx, cy, pcx, pcy)
      }
    }
  }

  function getWorldItems() { return [...worldItems.values(), ...dropped.values()] }

  function nearestItem(px, py, maxDist = 1.4) {
    let best = null, bestD = maxDist * maxDist
    for (const it of worldItems.values()) {
      const d = (it.x - px) ** 2 + (it.y - py) ** 2
      if (d < bestD) { bestD = d; best = it }
    }
    for (const it of dropped.values()) {
      const d = (it.x - px) ** 2 + (it.y - py) ** 2
      if (d < bestD) { bestD = d; best = it }
    }
    return best
  }

  // Dropped keys ('d:') are picked up from the dropped map and never enter `taken`
  // (that set is for chunk spawns, which must not respawn). A dropped radio keeps `on`.
  function pickUp(key) {
    const isDrop = key.startsWith('d:')
    const item = isDrop ? dropped.get(key) : worldItems.get(key)
    if (!item) return { ok: false, reason: 'gone' }
    if (inventory.length >= MAX_SLOTS) return { ok: false, reason: 'full' }
    if (isDrop) {
      dropped.delete(key)
      const inv = { type: item.type }
      if (item.on) inv.on = true
      if (item.sour) inv.sour = true
      if (item.tool) inv.tool = true
      inventory.push(inv)
    } else {
      worldItems.delete(key)
      taken.add(key)
      inventory.push({ type: item.type })
    }
    dirty = true
    return { ok: true, item }
  }

  function select(i) {
    if (i >= 0 && i < MAX_SLOTS) selected = i
  }

  function getSelected() { return inventory[selected] ?? null }

  // Consumables are removed and their type returned; the radio toggles in place.
  function useSelected() {
    const item = inventory[selected]
    if (!item) return null
    if (item.type === 'radio') {
      item.on = !item.on
      return { type: 'radio', on: item.on }
    }
    // tools (e.g. the plumb) take a reading on every press and are never consumed
    if (item.tool) return { type: item.type, tool: true }
    inventory.splice(selected, 1)
    if (selected >= inventory.length && selected > 0) selected = inventory.length - 1
    return { type: item.type, ...(item.sour ? { sour: true } : {}) }
  }

  // Put an item straight into the inventory (a vending machine dispensing, say).
  // `extra` carries per-item flags, e.g. { sour: true } for tainted water.
  function grant(type, extra = {}) {
    if (inventory.length >= MAX_SLOTS) return { ok: false, reason: 'full' }
    inventory.push({ type, ...extra })
    return { ok: true }
  }

  // Drop the selected item out of the inventory entirely. Returns the removed
  // item descriptor (or null if the slot was empty).
  function discardSelected() {
    const item = inventory[selected]
    if (!item) return null
    inventory.splice(selected, 1)
    if (selected >= inventory.length && selected > 0) selected = inventory.length - 1
    return { type: item.type }
  }

  function isRadioOn() {
    return inventory.some(i => i.type === 'radio' && i.on)
  }

  // Read the selected item without touching it (the bandage commit decides first).
  function peekSelected() { return inventory[selected] ?? null }

  // Remove the selected item outright and return its descriptor, like useSelected's
  // consumable branch — no radio toggle, no tool exemption. The other half of peek.
  function consumeSelected() {
    const item = inventory[selected]
    if (!item) return null
    inventory.splice(selected, 1)
    if (selected >= inventory.length && selected > 0) selected = inventory.length - 1
    return { type: item.type, ...(item.sour ? { sour: true } : {}) }
  }

  // ── dropped items ──

  // Set an item down at (x, y). `extra` carries its flags (on, sour, tool, and the
  // clocks when restoring). A radio set down talking gains onUntil; a glowstick
  // gains t0; given clocks win (restoreDropped), and a null `now` sets none.
  // Oldest out past MAX_DROPPED. Returns the record (its key is `d:${n}`).
  function dropAt(x, y, type, extra = {}, now = null) {
    const key = `d:${dropN++}`
    const it = { key, x, y, type }
    if (extra.on) it.on = true
    if (extra.sour) it.sour = true
    if (extra.tool) it.tool = true
    if (extra.onUntil != null) it.onUntil = extra.onUntil
    else if (type === 'radio' && it.on && now != null) it.onUntil = now + RADIO_BATTERY
    if (extra.t0 != null) it.t0 = extra.t0
    else if (type === 'glowstick' && now != null) it.t0 = now
    // a cache's note (caches.js) trails the record; absent, the record is as it was
    if (Number.isInteger(extra.ph)) it.ph = extra.ph
    if (Number.isInteger(extra.oct)) it.oct = extra.oct
    if (typeof extra.by === 'string') it.by = extra.by.slice(0, 24)
    if (typeof extra.byId === 'string') it.byId = extra.byId
    if (typeof extra.cacheKey === 'string') it.cacheKey = extra.cacheKey.slice(0, 48)
    dropped.set(key, it)
    while (dropped.size > MAX_DROPPED) dropped.delete(dropped.keys().next().value)
    dirty = true
    return it
  }

  // Put the selected item down 1.2 u ahead if that cell is open, else at the feet.
  // The whole path is sampled, not just the landing point: with the player's
  // back against a one-cell wall, 1.2 u ahead is the corridor on the OTHER side.
  // The deep-stack finds are kept. Returns { ok, item, x, y } or { ok: false, reason }.
  // `note` (a cache's ph / oct / by / byId) rides over the item's own flags.
  function throwSelected(px, py, angle, now, note = null) {
    const item = inventory[selected]
    if (!item) return { ok: false, reason: 'empty' }
    if (KEPT.has(item.type) || item.tool) return { ok: false, reason: 'kept' }
    const pcx = Math.floor(px / CHUNK_SIZE), pcy = Math.floor(py / CHUNK_SIZE)
    const dx = Math.cos(angle) * THROW_AHEAD, dy = Math.sin(angle) * THROW_AHEAD
    let x = px + dx, y = py + dy
    for (let k = 1; k <= THROW_STEPS; k++) {
      if (isWallFn(px + dx * k / THROW_STEPS, py + dy * k / THROW_STEPS, pcx, pcy)) { x = px; y = py; break }
    }
    inventory.splice(selected, 1)
    if (selected >= inventory.length && selected > 0) selected = inventory.length - 1
    const it = dropAt(x, y, item.type, note ? Object.assign({}, item, note) : item, now)
    return { ok: true, item: it, x, y }
  }

  // Run the clocks: a radio battery goes at onUntil (the radio stays on the
  // floor, silent); a glowstick gutters out at t0 + GLOW_TTL (it is gone).
  // Returns the reused events array: [{ kind: 'battery' | 'gutter', key }].
  function expireDropped(now) {
    expired.length = 0
    for (const it of dropped.values()) {
      if (it.type === 'radio' && it.on && it.onUntil != null && now >= it.onUntil) {
        it.on = false; delete it.onUntil
        expired.push({ kind: 'battery', key: it.key })
      } else if (it.type === 'glowstick' && it.t0 != null && now >= it.t0 + GLOW_TTL) {
        dropped.delete(it.key)
        expired.push({ kind: 'gutter', key: it.key })
      }
    }
    if (expired.length) dirty = true
    return expired
  }

  function exportTaken() { return [...taken] }

  function getDropped() {
    const out = []
    for (const it of dropped.values()) {
      const r = { x: it.x, y: it.y, type: it.type }
      if (it.on) r.on = true
      if (it.onUntil != null) r.onUntil = it.onUntil
      if (it.t0 != null) r.t0 = it.t0
      if (it.sour) r.sour = true
      if (it.ph != null) r.ph = it.ph
      if (it.oct != null) r.oct = it.oct
      if (it.by != null) r.by = it.by
      if (it.byId != null) r.byId = it.byId
      if (it.cacheKey != null) r.cacheKey = it.cacheKey
      out.push(r)
    }
    return out
  }

  // Saved coordinates are not trusted: a regenerated chunk (epoch reset on
  // reload) can put a wall where the item was set down, and a radio talking
  // from inside a wall lures the things to a spot nobody can reach. A record
  // on a wall cell comes back on the nearest open cell centre (3-ring spiral);
  // with nothing open that near it is kept where it was rather than lost.
  function restoreDropped(list) {
    if (!list) return
    for (const r of list) {
      let x = r.x, y = r.y
      const pcx = Math.floor(x / CHUNK_SIZE), pcy = Math.floor(y / CHUNK_SIZE)
      if (isWallFn(x, y, pcx, pcy)) {
        const open = findOpenNear(x, y, (cx, cy) => !isWallFn(cx + 0.5, cy + 0.5, pcx, pcy), 3)
        if (open) { x = open.x; y = open.y }
      }
      dropAt(x, y, r.type, r, null)
    }
  }

  // A friend took it: the record leaves the world without touching the hand.
  // Dropped keys only; a chunk spawn is never removed this way.
  function takeDropped(key) {
    if (typeof key !== 'string' || !key.startsWith('d:')) return null
    const it = dropped.get(key)
    if (!it) return null
    dropped.delete(key)
    dirty = true
    return it
  }

  function getLures(now, px, py) { return computeLures(dropped, now, px, py) }

  // True once after any dropped / taken change; the read clears it.
  function isDirty() { const d = dirty; dirty = false; return d }

  // Reconfigure item types/density for a new level and wipe world-item state,
  // then seed what this floor remembers (keys taken, items set down) from the
  // arguments. Inventory and the currently-selected slot are intentionally preserved.
  function enterLevel(cfg, takenKeys = null, droppedList = null) {
    density = Math.max(1, cfg?.items?.density ?? density)
    types   = (cfg?.items?.types?.length ? cfg.items.types : types)
    salt    = (cfg?.maze?.salt | 0)
    worldItems.clear()
    scanned.clear()
    taken.clear()
    dropped.clear()
    if (takenKeys) for (const k of takenKeys) taken.add(k)
    restoreDropped(droppedList)
    dirty = true
  }

  return {
    update, getWorldItems, nearestItem, pickUp, grant,
    select, getSelected, useSelected, discardSelected, isRadioOn, enterLevel,
    peekSelected, consumeSelected,
    dropAt, throwSelected, expireDropped, exportTaken, getDropped, restoreDropped, getLures, isDirty,
    takeDropped,
    inventory,
    get selected() { return selected },
  }
}
