// items.js — things the Backrooms leaves lying around.
// Pure state module: deterministic chunk-seeded spawns, pickup, a small
// inventory, use() and discard() descriptors. Effects are applied by game.js.
// Inventory persists across level transitions; world items are reset per level
// via enterLevel().
import { CHUNK_SIZE } from './world.js'

export const ITEM_TYPES = ['almond-water', 'glowstick', 'bandage', 'polaroid', 'radio']
export const MAX_SLOTS = 6

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

  function getWorldItems() { return [...worldItems.values()] }

  function nearestItem(px, py, maxDist = 1.4) {
    let best = null, bestD = maxDist * maxDist
    for (const it of worldItems.values()) {
      const d = (it.x - px) ** 2 + (it.y - py) ** 2
      if (d < bestD) { bestD = d; best = it }
    }
    return best
  }

  function pickUp(key) {
    const item = worldItems.get(key)
    if (!item) return { ok: false, reason: 'gone' }
    if (inventory.length >= MAX_SLOTS) return { ok: false, reason: 'full' }
    worldItems.delete(key)
    taken.add(key)
    inventory.push({ type: item.type })
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

  // Reconfigure item types/density for a new level and wipe world-item state.
  // Inventory and the currently-selected slot are intentionally preserved.
  function enterLevel(cfg) {
    density = Math.max(1, cfg?.items?.density ?? density)
    types   = (cfg?.items?.types?.length ? cfg.items.types : types)
    salt    = (cfg?.maze?.salt | 0)
    worldItems.clear()
    scanned.clear()
    taken.clear()
  }

  return {
    update, getWorldItems, nearestItem, pickUp, grant,
    select, getSelected, useSelected, discardSelected, isRadioOn, enterLevel,
    inventory,
    get selected() { return selected },
  }
}
