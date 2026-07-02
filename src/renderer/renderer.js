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
  const baseFog  = config.fogDistance

  const ITEM_COLORS = {
    'almond-water': [190, 215, 235],
    'glowstick':    [120, 220, 90],
    'polaroid':     [235, 230, 220],
    'radio':        [190, 95, 55],
  }

  const FOV = Math.PI / 2.4
  const HF  = FOV / 2

  let zbuffer = null  // Float32Array(W), allocated on first render or resize

  // fogMul > 1 pushes the fog back (glowstick); it resets when the light dies
  function render(player, isWallFn, flicker, entities = [], fogMul = 1) {
    const fog = baseFog * fogMul
    const W = canvas.width, H = canvas.height
    const HH = (H / 2 + (player.bobOffset ?? 0)) | 0

    // Allocate/reset zbuffer each frame
    if (!zbuffer || zbuffer.length !== W) zbuffer = new Float32Array(W)
    zbuffer.fill(0)

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
        const base = isFloor ? floorRgb : ceilRgb
        const r = Math.min(255, Math.round(lerp(base[0], fogRgb[0], distF) * flicker))
        const g = Math.min(255, Math.round(lerp(base[1], fogRgb[1], distF) * flicker))
        const b = Math.min(255, Math.round(lerp(base[2], fogRgb[2], distF) * flicker))
        const i = (y * W + x) * 4
        d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = 255
      }
    }

    ctx.putImageData(img, 0, 0)

    const RAYS = W
    for (let col = 0; col < RAYS; col++) {
      const angle = player.angle - HF + (col / RAYS) * FOV
      const hit   = castRay(player.x, player.y, angle, isWallFn)

      const corr = hit.dist * Math.cos(angle - player.angle)
      zbuffer[col] = corr
      const wh   = Math.min(H * 4, H / Math.max(0.001, corr))
      const wt   = HH - wh / 2

      const distF   = Math.min(1, corr / fog)
      const sideMul = hit.side === 1 ? 0.72 : 1.0

      const r = Math.min(255, Math.round(lerp(wallRgb[0] * sideMul, fogRgb[0], distF) * flicker))
      const g = Math.min(255, Math.round(lerp(wallRgb[1] * sideMul, fogRgb[1], distF) * flicker))
      const b = Math.min(255, Math.round(lerp(wallRgb[2] * sideMul, fogRgb[2], distF) * flicker))

      ctx.fillStyle = `rgb(${r},${g},${b})`
      ctx.fillRect(col, wt, 1, wh)
    }

    // sprite pass — entities rendered as dark billboard silhouettes
    if (entities && entities.length > 0) {
      const HALF_FOV = FOV / 2
      // sort far→near so closer entities overdraw
      const sorted = [...entities].sort((a, b) => {
        const da = (a.x - player.x) ** 2 + (a.y - player.y) ** 2
        const db = (b.x - player.x) ** 2 + (b.y - player.y) ** 2
        return db - da
      })
      for (const ent of sorted) {
        const ex = ent.x - player.x
        const ey = ent.y - player.y
        const entDist = Math.sqrt(ex * ex + ey * ey)
        if (entDist < 0.5) continue
        // angle of entity relative to player heading
        const entAngle = Math.atan2(ey, ex) - player.angle
        // normalise to [-PI, PI]
        const relAngle = ((entAngle + Math.PI * 3) % (Math.PI * 2)) - Math.PI
        if (Math.abs(relAngle) > HALF_FOV + 0.2) continue

        const screenX = Math.floor(W / 2 + (relAngle / HALF_FOV) * (W / 2))

        // fog factor — same curve as wall fog
        const fogT = Math.min(1, entDist / fog)

        if (ent.kind === 'item') {
          // small, floor-anchored, faintly luminous
          const spriteH = Math.max(2, Math.min(H, Math.floor((H / entDist) * 0.22)))
          const spriteW = Math.max(1, Math.floor(spriteH * 0.55))
          const bottom = HH + (H / entDist) / 2
          const top = Math.floor(bottom - spriteH)
          const alpha = (1 - fogT) * 0.9
          if (alpha < 0.04) continue
          const [ir, ig, ib] = ITEM_COLORS[ent.itemType] ?? [220, 220, 220]
          for (let sx = screenX - spriteW / 2; sx < screenX + spriteW / 2; sx++) {
            const col = Math.floor(sx)
            if (col < 0 || col >= W) continue
            if (zbuffer[col] <= entDist) continue
            const core = Math.abs(sx - screenX) < spriteW * 0.2
            const a = core ? Math.min(1, alpha * 1.4) : alpha
            ctx.fillStyle = `rgba(${ir},${ig},${ib},${a.toFixed(3)})`
            ctx.fillRect(col, top, 1, spriteH)
          }
          continue
        }

        const spriteH = Math.min(H * 2, Math.floor(H / entDist))
        const spriteW = Math.floor(spriteH * 0.4)
        const top = Math.floor((H - spriteH) / 2 + (player.bobOffset ?? 0) * 4)

        const alpha = (1 - fogT) * 0.92

        if (alpha < 0.04) continue

        ctx.fillStyle = `rgba(20,15,10,${alpha.toFixed(3)})`
        for (let sx = screenX - spriteW / 2; sx < screenX + spriteW / 2; sx++) {
          const col = Math.floor(sx)
          if (col < 0 || col >= W) continue
          if (zbuffer[col] <= entDist) continue  // wall is closer — skip this column
          ctx.fillRect(col, top, 1, spriteH)
        }
      }
    }

    const vig = ctx.createRadialGradient(W / 2, H / 2, H * 0.12, W / 2, H / 2, H * 0.85)
    vig.addColorStop(0, 'rgba(0,0,0,0)')
    vig.addColorStop(1, 'rgba(0,0,0,0.55)')
    ctx.fillStyle = vig
    ctx.fillRect(0, 0, W, H)

    if (flicker < 0.9) {
      ctx.fillStyle = `rgba(0,0,0,${(1 - flicker) * 0.75})`
      ctx.fillRect(0, 0, W, H)
    }
  }

  return { render }
}
