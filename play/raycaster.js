import { HF } from './gfx-frame.js'

export function castRay(px, py, angle, isWallFn, maxDist = 96) {
  const ca = Math.cos(angle)
  const sa = Math.sin(angle)

  let mx = Math.floor(px)
  let my = Math.floor(py)

  const ddx = Math.abs(ca) < 1e-10 ? 1e30 : Math.abs(1 / ca)
  const ddy = Math.abs(sa) < 1e-10 ? 1e30 : Math.abs(1 / sa)

  let sx, sy, sdx, sdy
  if (ca < 0) { sx = -1; sdx = (px - mx) * ddx }
  else         { sx =  1; sdx = (mx + 1 - px) * ddx }
  if (sa < 0) { sy = -1; sdy = (py - my) * ddy }
  else         { sy =  1; sdy = (my + 1 - py) * ddy }

  let side = 0

  for (let i = 0; i < maxDist * 2; i++) {
    if (sdx < sdy) { sdx += ddx; mx += sx; side = 0 }
    else            { sdy += ddy; my += sy; side = 1 }

    if (isWallFn(mx, my)) {
      const dist = side === 0 ? sdx - ddx : sdy - ddy
      let wallX = side === 0 ? py + dist * sa : px + dist * ca
      wallX -= Math.floor(wallX)
      return { dist, side, wallX, mx, my }   // mx,my = hit cell, for per-cell wall materials
    }

    if (Math.sqrt((mx - px) ** 2 + (my - py) ** 2) > maxDist) break
  }

  return { dist: maxDist, side: 0, wallX: 0, mx, my }
}

// Can (ax, ay) see (bx, by)? The castRay DDA walked cell by cell toward the target and stopped AT the target cell: false when any cell
// before it is not open (floorFn(ix, iy) -> true = open, the grid reader's contract). The starting cell and the target cell never block
// (a thing stands in one, the other is what is looked at). maxSteps bounds the walk; 0 means 2*ceil(dist)+2, enough for any straight
// walk of that length. Allocation-free: this is the one LOS the sprite pass, the map, the pins and hunt perception share.
export function lineOfSight(ax, ay, bx, by, floorFn, maxSteps = 0) {
  let mx = Math.floor(ax), my = Math.floor(ay)
  const tx = Math.floor(bx), ty = Math.floor(by)
  if (mx === tx && my === ty) return true
  const dx = bx - ax, dy = by - ay
  const dist = Math.sqrt(dx * dx + dy * dy)
  if (!(maxSteps > 0)) maxSteps = 2 * Math.ceil(dist) + 2
  const ca = dx / dist, sa = dy / dist                          // dist > 0: the cells differ
  const ddx = Math.abs(ca) < 1e-10 ? 1e30 : Math.abs(1 / ca)
  const ddy = Math.abs(sa) < 1e-10 ? 1e30 : Math.abs(1 / sa)
  let sx, sy, sdx, sdy
  if (ca < 0) { sx = -1; sdx = (ax - mx) * ddx }
  else         { sx =  1; sdx = (mx + 1 - ax) * ddx }
  if (sa < 0) { sy = -1; sdy = (ay - my) * ddy }
  else         { sy =  1; sdy = (my + 1 - ay) * ddy }
  for (let i = 0; i < maxSteps; i++) {
    if (sdx < sdy) { sdx += ddx; mx += sx }
    else            { sdy += ddy; my += sy }
    if (mx === tx && my === ty) return true
    if (!floorFn(mx, my)) return false
  }
  return false                                                  // out of steps before the target: not seen
}

// Is (x, y) inside the camera's view cone from (px, py) facing pa? EXACTLY the sprite-pass cull (gfx-sprites.js:2707-2714), copied once so
// 'seen on the map' = 'seen by the thing' = 'drawn on screen': perpendicular depth fwd in [0.35, reach], lateral offset within
// fwd * tan(min(1.45, hf + 0.1)) + 0.8. hf defaults to the renderer's half field of view (gfx-frame.js HF = FOV / 2, FOV = PI / 2.4).
export function inViewCone(px, py, pa, x, y, hf = HF, reach) {
  const ex = x - px, ey = y - py
  const ca = Math.cos(pa), sa = Math.sin(pa)
  const fwd = ex * ca + ey * sa
  if (!(fwd >= 0.35)) return false
  if (fwd > reach) return false
  const lat = -ex * sa + ey * ca
  const lim = fwd * Math.tan(Math.min(1.45, hf + 0.1)) + 0.8
  return !(lat > lim || lat < -lim)
}
