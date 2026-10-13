// reach.js — the reach gate (test / dev module). Floods where the player can stand: 4-connected samples on a 0.125 grid, a sample
// free when its PLAYER_WALL_R box touches no wall cell and it sits >= r + PLAYER_R + 0.02 from every 'solid' body ('clutter' and
// 'none' are walked through). Settling furniture (placement.js) must never seal a cell that the walls alone leave open; test/reach.test.js
// runs this over real chunks and decor.js runs it per scanned chunk in a test run (globalThis.__backroomsTestRun) and console.errors
// any loss. Nothing here runs in a shipped frame.
import { CHUNK_SIZE } from './world.js'
import { PLAYER_R, PLAYER_WALL_R } from './collide.js'

const STEP = 0.125, PER_CELL = 8
const BODY_PAD = 0.02
const ORIGIN_SEARCH = 2 * PER_CELL        // how far (in samples) to look for a free start when the origin sample is blocked

// walkable(floorFn, records, ox, oy, bounds) -> Uint8Array mask (1 = reachable sample) carrying its geometry (x0, y0, w, h).
// bounds = { x0, y0, x1, y1 } in integer cells (x1 / y1 exclusive); default: the chunk under (ox, oy) plus a one-cell border.
export function walkable(floorFn, records, ox, oy, bounds) {
  let x0, y0, x1, y1
  if (bounds) { x0 = bounds.x0; y0 = bounds.y0; x1 = bounds.x1; y1 = bounds.y1 }
  else {
    const cx = Math.floor(ox / CHUNK_SIZE), cy = Math.floor(oy / CHUNK_SIZE)
    x0 = cx * CHUNK_SIZE - 1; y0 = cy * CHUNK_SIZE - 1; x1 = x0 + CHUNK_SIZE + 2; y1 = y0 + CHUNK_SIZE + 2
  }
  const cw = x1 - x0, ch = y1 - y0
  const w = cw * PER_CELL, h = ch * PER_CELL
  const mask = new Uint8Array(w * h)
  mask.x0 = x0; mask.y0 = y0; mask.w = w; mask.h = h; mask.step = STEP
  if (w <= 0 || h <= 0) return mask

  // the wall grid once, with a one-cell apron (a box at the edge of the bounds pokes one cell out)
  const gw = cw + 2, gh = ch + 2
  const wall = new Uint8Array(gw * gh)
  for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) wall[y * gw + x] = floorFn(x0 - 1 + x, y0 - 1 + y) ? 0 : 1
  const wallAt = (ix, iy) => {
    const x = ix - x0 + 1, y = iy - y0 + 1
    return x < 0 || y < 0 || x >= gw || y >= gh ? 1 : wall[y * gw + x]
  }
  // the solid bodies as (x, y, blocked radius squared)
  const bx = [], by = [], br2 = []
  if (records) {
    for (let i = 0; i < records.length; i++) {
      const c = records[i]
      if (c.cls !== 'solid') continue
      const R = c.r + PLAYER_R + BODY_PAD
      bx.push(c.x); by.push(c.y); br2.push(R * R)
    }
  }
  const nb = bx.length
  const R = PLAYER_WALL_R
  const free = (i, j) => {
    const x = x0 + (i + 0.5) * STEP, y = y0 + (j + 0.5) * STEP
    const xa = Math.floor(x - R), xb = Math.floor(x + R), ya = Math.floor(y - R), yb = Math.floor(y + R)
    if (wallAt(xa, ya) || wallAt(xb, ya) || wallAt(xa, yb) || wallAt(xb, yb)) return false
    for (let k = 0; k < nb; k++) {
      const ex = x - bx[k], ey = y - by[k]
      if (ex * ex + ey * ey < br2[k]) return false
    }
    return true
  }

  // the start: the origin's sample, or the nearest free one in expanding rings around it
  let si = Math.floor((ox - x0) / STEP), sj = Math.floor((oy - y0) / STEP)
  si = si < 0 ? 0 : si >= w ? w - 1 : si
  sj = sj < 0 ? 0 : sj >= h ? h - 1 : sj
  if (!free(si, sj)) {
    let found = false
    for (let ring = 1; ring <= ORIGIN_SEARCH && !found; ring++) {
      for (let dj = -ring; dj <= ring && !found; dj++) {
        for (let di = -ring; di <= ring; di++) {
          if (Math.max(Math.abs(di), Math.abs(dj)) !== ring) continue
          const i = si + di, j = sj + dj
          if (i < 0 || j < 0 || i >= w || j >= h || !free(i, j)) continue
          si = i; sj = j; found = true; break
        }
      }
    }
    if (!found) return mask
  }

  const queue = new Int32Array(w * h)
  let head = 0, tail = 0
  mask[sj * w + si] = 1
  queue[tail++] = sj * w + si
  while (head < tail) {
    const p = queue[head++]
    const i = p % w, j = (p - i) / w
    if (i > 0 && !mask[p - 1] && free(i - 1, j)) { mask[p - 1] = 1; queue[tail++] = p - 1 }
    if (i < w - 1 && !mask[p + 1] && free(i + 1, j)) { mask[p + 1] = 1; queue[tail++] = p + 1 }
    if (j > 0 && !mask[p - w] && free(i, j - 1)) { mask[p - w] = 1; queue[tail++] = p - w }
    if (j < h - 1 && !mask[p + w] && free(i, j + 1)) { mask[p + w] = 1; queue[tail++] = p + w }
  }
  return mask
}

// the cells ("ix,iy") holding at least one reachable sample
export function cellsCovered(mask) {
  const out = new Set()
  const { x0, y0, w, h } = mask
  for (let j = 0; j < h; j++) {
    const iy = y0 + Math.floor(j / PER_CELL)
    for (let i = 0; i < w; i++) if (mask[j * w + i]) out.add(`${x0 + Math.floor(i / PER_CELL)},${iy}`)
  }
  return out
}

// is any reachable sample within `radius` of (x, y)?
export function reachesSpot(mask, x, y, radius) {
  const { x0, y0, w, h } = mask
  const i0 = Math.max(0, Math.floor((x - radius - x0) / STEP)), i1 = Math.min(w - 1, Math.floor((x + radius - x0) / STEP))
  const j0 = Math.max(0, Math.floor((y - radius - y0) / STEP)), j1 = Math.min(h - 1, Math.floor((y + radius - y0) / STEP))
  const r2 = radius * radius
  for (let j = j0; j <= j1; j++) {
    const sy = y0 + (j + 0.5) * STEP - y
    for (let i = i0; i <= i1; i++) {
      if (!mask[j * w + i]) continue
      const sx = x0 + (i + 0.5) * STEP - x
      if (sx * sx + sy * sy <= r2) return true
    }
  }
  return false
}

// cells reachable before that have no reachable sample after
export function loses(before, after) {
  const was = cellsCovered(before), is = cellsCovered(after)
  const out = []
  for (const k of was) if (!is.has(k)) out.push(k)
  return out
}
