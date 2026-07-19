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
