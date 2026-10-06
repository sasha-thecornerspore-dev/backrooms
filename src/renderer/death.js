// death.js — the one owner of dying and of maxHp this release.
//
// When it finally has you, you wake a floor above beside the hole you fell through, lighter: whatever was in your hand is gone (a tool,
// the ballast and the extension slip stay), your ceiling is five points lower (never below 60), the trays are empty for that visit.
// Arriving on a floor for the first time gives five back (never above 100). Pure: game.js applies the result.
import { offsetBeside } from './topology.js'

export const MAX_HP_FLOOR = 60
export const SCAR = 5
// never lost in the fall: the deep-stack finds that are kept (items.js KEPT minus the plumb, which is a tool and keeps itself)
const KEPT = new Set(['ballast', 'extension-slip'])
const WAKE_LINE = 'you wake beside the hole you fell through. something of you stayed down there.'

// the floor you wake on: a floor above for 1..3, the lobby and the block where they are
function wakeLevelFor(level) { return level >= 1 && level <= 3 ? level - 1 : level }

// resolveDeath({ level, inventory, selected, maxHp, deaths, names? }) -> { wakeLevel, inventory, selected, maxHp, deaths, dropped, droppedLine,
// message, vendLocked: true }. The returned inventory is a NEW array of copies (game.js splices itemSys.inventory in place); the input is
// never touched. `names` (optional) maps item types to display names for the dropped line.
export function resolveDeath({ level, inventory, selected, maxHp, deaths, names = null }) {
  const inv = Array.isArray(inventory) ? inventory.map((it) => ({ ...it })) : []
  let sel = Number.isInteger(selected) ? selected : 0
  let dropped = null
  const item = sel >= 0 && sel < inv.length ? inv[sel] : null
  if (item && !item.tool && !KEPT.has(item.type)) {
    inv.splice(sel, 1)
    dropped = item.type
  }
  // items.js's clamp after a removal
  if (sel >= inv.length) sel = inv.length > 0 ? inv.length - 1 : 0
  if (sel < 0) sel = 0
  const hp = typeof maxHp === 'number' && Number.isFinite(maxHp) ? maxHp : 100
  const name = dropped ? (names?.[dropped] ?? dropped) : null
  return {
    wakeLevel: wakeLevelFor(level),
    inventory: inv,
    selected: sel,
    maxHp: Math.max(MAX_HP_FLOOR, hp - SCAR),
    deaths: (Number.isInteger(deaths) && deaths >= 0 ? deaths : 0) + 1,
    dropped,
    droppedLine: dropped ? `your hands opened. the ${name} is still down there.` : null,
    message: WAKE_LINE,
    vendLocked: true,
  }
}

// the ceiling on arrival: a first visit to a floor gives five back, capped at 100 ('the floor remembers you less.' when it rose)
export function onArrive(maxHp, firstVisit) { return firstVisit ? Math.min(100, maxHp + 5) : maxHp }

// where you wake: beside the exit (offsetBeside: two cells along an open cardinal, else one), facing it; null when every neighbour is
// walled or there is no exit to wake beside (game.js then falls back to the chunk midpoint).
export function wakeSpot(exitRec, floorFn) {
  if (!exitRec) return null
  const spot = offsetBeside(exitRec, floorFn)
  if (spot === exitRec) return null
  if (!floorFn(Math.floor(spot.x), Math.floor(spot.y))) return null
  return { x: spot.x, y: spot.y, angle: Math.atan2(exitRec.y - spot.y, exitRec.x - spot.x) }
}
