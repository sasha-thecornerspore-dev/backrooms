import { castRay } from './raycaster.js'

function hexToRgb(hex) {
  const n = parseInt(hex.replace('#', ''), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

function lerp(a, b, t) { return a + (b - a) * t }

export function createRenderer(canvas, config) {
  const ctx = canvas.getContext('2d', { alpha: false })

  const wallRgb  = hexToRgb(config.palette.wall)
  const ceilRgb  = hexToRgb(config.palette.ceiling)
  const floorRgb = hexToRgb(config.palette.floor)
  const fogRgb   = hexToRgb(config.palette.fog)
  const fog      = config.fogDistance

  function render(player, isWallFn, flicker) {
    const W = canvas.width, H = canvas.height
    const HH = (H / 2 + player.bobOffset) | 0
    const FOV = Math.PI / 2.4
    const HF  = FOV / 2

    // ── Floor & ceiling via ImageData ─────────────────────────
    const img = ctx.createImageData(W, H)
    const d   = img.data

    const ca0 = Math.cos(player.angle - HF), sa0 = Math.sin(player.angle - HF)
    const ca1 = Math.cos(player.angle + HF), sa1 = Math.sin(player.angle + HF)

    for (let y = 0; y < H; y++) {
      const isFloor = y > HH
      const rowDist = isFloor
        ? (H - HH) / Math.max(1, y - HH)
        : HH       / Math.max(1, HH - y)

      const distF = Math.min(1, rowDist / fog)

      if (rowDist > fog) {
        // Beyond fog: solid fog colour
        const fr = Math.round(fogRgb[0] * flicker)
        const fg = Math.round(fogRgb[1] * flicker)
        const fb = Math.round(fogRgb[2] * flicker)
        for (let x = 0; x < W; x++) {
          const i = (y * W + x) * 4
          d[i] = fr; d[i + 1] = fg; d[i + 2] = fb; d[i + 3] = 255
        }
        continue
      }

      const stepX = rowDist * (ca1 - ca0) / W
      const stepY = rowDist * (sa1 - sa0) / W
      let fx = player.x + rowDist * ca0
      let fy = player.y + rowDist * sa0

      for (let x = 0; x < W; x++, fx += stepX, fy += stepY) {
        const base   = isFloor ? floorRgb : ceilRgb
        const bright = isFloor ? 1 : (((Math.floor(fx * 2) + Math.floor(fy * 2)) & 1) ? 1.04 : 0.97)
        const r = Math.min(255, Math.round(lerp(base[0] * bright, fogRgb[0], distF) * flicker))
        const g = Math.min(255, Math.round(lerp(base[1] * bright, fogRgb[1], distF) * flicker))
        const b = Math.min(255, Math.round(lerp(base[2] * bright, fogRgb[2], distF) * flicker))
        const i = (y * W + x) * 4
        d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = 255
      }
    }

    ctx.putImageData(img, 0, 0)

    // ── Wall columns ──────────────────────────────────────────
    const RAYS = W
    for (let col = 0; col < RAYS; col++) {
      const angle = player.angle - HF + (col / RAYS) * FOV
      const hit   = castRay(player.x, player.y, angle, isWallFn)

      // Fisheye correction
      const corr = hit.dist * Math.cos(angle - player.angle)
      const wh   = Math.min(H * 4, H / Math.max(0.001, corr))
      const wt   = HH - wh / 2

      const distF   = Math.min(1, corr / fog)
      const sideMul = hit.side === 1 ? 0.72 : 1.0
      // Subtle wallpaper stripe via wallX
      const stripe  = 1 + Math.sin(hit.wallX * Math.PI * 6) * 0.04

      const r = Math.min(255, Math.round(lerp(wallRgb[0] * sideMul * stripe, fogRgb[0], distF) * flicker))
      const g = Math.min(255, Math.round(lerp(wallRgb[1] * sideMul * stripe, fogRgb[1], distF) * flicker))
      const b = Math.min(255, Math.round(lerp(wallRgb[2] * sideMul * stripe, fogRgb[2], distF) * flicker))

      ctx.fillStyle = `rgb(${r},${g},${b})`
      ctx.fillRect(col, wt, 1, wh)
    }

    // ── Vignette ─────────────────────────────────────────────
    const vig = ctx.createRadialGradient(W / 2, H / 2, H * 0.12, W / 2, H / 2, H * 0.85)
    vig.addColorStop(0, 'rgba(0,0,0,0)')
    vig.addColorStop(1, 'rgba(0,0,0,0.55)')
    ctx.fillStyle = vig
    ctx.fillRect(0, 0, W, H)

    // ── Flicker darkening ─────────────────────────────────────
    if (flicker < 0.9) {
      ctx.fillStyle = `rgba(0,0,0,${(1 - flicker) * 0.75})`
      ctx.fillRect(0, 0, W, H)
    }
  }

  return { render }
}
