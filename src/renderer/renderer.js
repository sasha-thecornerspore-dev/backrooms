import { castRay } from './raycaster.js'

function hexToRgb(hex) {
  const n = parseInt(hex.replace('#', ''), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}
function lerp(a, b, t) { return a + (b - a) * t }
function clamp255(v) { return v < 0 ? 0 : v > 255 ? 255 : v | 0 }

// small deterministic PRNG so the wallpaper is the same every launch
function mulberry32(seed) {
  let s = seed >>> 0
  return () => {
    s += 0x6D2B79F5
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = t + Math.imul(t ^ (t >>> 7), 61 | t) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const TS = 64            // texture tile size (px per world cell)
const TMASK = TS - 1
const OFF = 1 << 24      // large positive offset so `(v+OFF)|0`-OFF == Math.floor(v)

// Drop-ceiling light grid: a panel every other cell on both axes.
function isLightCell(cx, cy) {
  return (cx & 1) === 0 && (cy & 1) === 0
}

// Build the three procedural tiles (wall / ceiling / floor) + the light panel,
// each as a flat Uint8 RGB array of length TS*TS*3.
function buildTextures(palette) {
  const wallRgb  = hexToRgb(palette.wall)
  const ceilRgb  = hexToRgb(palette.ceiling)
  const floorRgb = hexToRgb(palette.floor)
  const rnd = mulberry32(0x0BACC000)

  const wall  = new Uint8Array(TS * TS * 3)
  const ceil  = new Uint8Array(TS * TS * 3)
  const floor = new Uint8Array(TS * TS * 3)
  const light = new Uint8Array(TS * TS * 3)
  const LIGHT = [250, 247, 224]

  // per-column damp streak profile for the wallpaper
  const streak = new Float32Array(TS)
  for (let x = 0; x < TS; x++) streak[x] = 0.94 + 0.10 * rnd()
  // a few darker vertical stains
  for (let s = 0; s < 5; s++) {
    const cx = (rnd() * TS) | 0
    for (let x = cx - 1; x <= cx + 1; x++) if (x >= 0 && x < TS) streak[x] *= 0.9
  }

  for (let y = 0; y < TS; y++) {
    for (let x = 0; x < TS; x++) {
      const i = (y * TS + x) * 3
      const n = (rnd() - 0.5) * 10   // fine film noise

      // ── wall: wallpaper + baseboard ──
      if (y >= TS - 9) {
        // dark skirting board with a highlight lip at the top edge
        const lip = y === TS - 9 ? 1.7 : 1.0
        wall[i]     = clamp255(wallRgb[0] * 0.34 * lip + n)
        wall[i + 1] = clamp255(wallRgb[1] * 0.34 * lip + n)
        wall[i + 2] = clamp255(wallRgb[2] * 0.32 * lip + n)
      } else {
        let m = streak[x]
        if (y % 16 === 0) m *= 0.93          // faint horizontal pattern band
        if ((x + y) % 23 === 0) m *= 1.03    // subtle weave highlight
        wall[i]     = clamp255(wallRgb[0] * m + n)
        wall[i + 1] = clamp255(wallRgb[1] * m + n)
        wall[i + 2] = clamp255(wallRgb[2] * m + n * 0.6)
      }

      // ── ceiling tile: grid seams + noise ──
      const seam = (x < 2 || y < 2 || x > TS - 3 || y > TS - 3) ? 0.7 : 1.0
      ceil[i]     = clamp255(ceilRgb[0] * seam + n * 0.6)
      ceil[i + 1] = clamp255(ceilRgb[1] * seam + n * 0.6)
      ceil[i + 2] = clamp255(ceilRgb[2] * seam + n * 0.6)

      // ── light panel: bright emissive centre, darker aluminium frame ──
      const frame = (x < 4 || y < 4 || x > TS - 5 || y > TS - 5)
      const lb = frame ? 0.78 : 1.0
      light[i]     = clamp255(LIGHT[0] * lb + n * 0.4)
      light[i + 1] = clamp255(LIGHT[1] * lb + n * 0.4)
      light[i + 2] = clamp255(LIGHT[2] * lb + n * 0.4)

      // ── floor: damp mottled carpet ──
      const mot = 0.82 + 0.30 * rnd()
      const seamF = (x < 1 || y < 1) ? 0.8 : 1.0
      floor[i]     = clamp255(floorRgb[0] * mot * seamF + n * 0.5)
      floor[i + 1] = clamp255(floorRgb[1] * mot * seamF + n * 0.5)
      floor[i + 2] = clamp255(floorRgb[2] * mot * seamF + n * 0.4)
    }
  }
  return { wall, ceil, floor, light }
}

// A tileable grayscale noise canvas for animated film grain.
function buildGrain() {
  const N = 128
  const c = document.createElement('canvas')
  c.width = N; c.height = N
  const g = c.getContext('2d')
  const img = g.createImageData(N, N)
  const rnd = mulberry32(0x51CE)
  for (let i = 0; i < N * N; i++) {
    const v = (rnd() * 255) | 0
    img.data[i * 4] = v; img.data[i * 4 + 1] = v; img.data[i * 4 + 2] = v
    img.data[i * 4 + 3] = 255
  }
  g.putImageData(img, 0, 0)
  return c
}

// The world is raycast into an offscreen buffer at this fraction of the window
// resolution, then bilinear-upscaled. The fog and grain hide the softness and
// it roughly triples throughput.
const RENDER_SCALE = 0.6

export function createRenderer(canvas, config) {
  const ctx = canvas.getContext('2d', { alpha: false })

  const fogRgb  = hexToRgb(config.palette.fog)
  const baseFog = config.fogDistance
  const tex     = buildTextures(config.palette)
  const grainCanvas = buildGrain()
  let grainPhase = 0

  const ITEM_COLORS = {
    'almond-water': [190, 215, 235],
    'glowstick':    [120, 235, 90],
    'polaroid':     [235, 230, 220],
    'radio':        [200, 100, 55],
  }

  const FOV = Math.PI / 2.4
  const HF  = FOV / 2

  // low-res world buffer + its own 2D context
  const world = document.createElement('canvas')
  const wctx  = world.getContext('2d', { alpha: false })
  const grainPattern = wctx.createPattern(grainCanvas, 'repeat')

  let zbuffer = null
  let img = null, buf32 = null
  let vignette = null
  let RW = 0, RH = 0, winW = 0, winH = 0

  function ensureBuffers(W, H) {
    if (winW === W && winH === H && img) return
    winW = W; winH = H
    RW = Math.max(1, Math.round(W * RENDER_SCALE))
    RH = Math.max(1, Math.round(H * RENDER_SCALE))
    world.width = RW; world.height = RH
    img = wctx.createImageData(RW, RH)
    buf32 = new Uint32Array(img.data.buffer)
    zbuffer = new Float32Array(RW)

    // precompute the vignette once (full-res, drawn over the upscaled world)
    vignette = document.createElement('canvas')
    vignette.width = W; vignette.height = H
    const vg = vignette.getContext('2d')
    const grad = vg.createRadialGradient(W / 2, H / 2, H * 0.12, W / 2, H / 2, H * 0.85)
    grad.addColorStop(0, 'rgba(0,0,0,0)')
    grad.addColorStop(1, 'rgba(0,0,0,0.58)')
    vg.fillStyle = grad
    vg.fillRect(0, 0, W, H)
  }

  function render(player, isWallFn, flicker, entities = [], fogMul = 1) {
    const fog = baseFog * fogMul
    ensureBuffers(canvas.width, canvas.height)
    // everything below draws into the low-res world buffer (RW x RH)
    const W = RW, H = RH
    const HH = (H / 2 + (player.bobOffset ?? 0) * RENDER_SCALE) | 0

    // fog colour, pre-flickered, packed once
    const fr = fogRgb[0] * flicker, fg = fogRgb[1] * flicker, fb = fogRgb[2] * flicker
    const fogPacked = (255 << 24) | (clamp255(fb) << 16) | (clamp255(fg) << 8) | clamp255(fr)

    const ca0 = Math.cos(player.angle - HF), sa0 = Math.sin(player.angle - HF)
    const ca1 = Math.cos(player.angle + HF), sa1 = Math.sin(player.angle + HF)

    // ── floor & ceiling (per row, textured, with fluorescent panels) ──
    // The fog blend is constant along a row, so it collapses to `tex*a + f` per
    // channel (precomputed here) instead of a lerp() call per pixel. Math.floor
    // is replaced with a positive-offset bit truncation. ~2x cheaper per pixel.
    const F0 = fogRgb[0], F1 = fogRgb[1], F2 = fogRgb[2]
    for (let y = 0; y < H; y++) {
      const isFloor = y > HH
      const rowDist = isFloor
        ? (H - HH) / Math.max(1, y - HH)
        : HH       / Math.max(1, HH - y)
      const rowOff = y * W

      if (rowDist > fog) {
        buf32.fill(fogPacked, rowOff, rowOff + W)
        continue
      }

      const df   = Math.min(1, rowDist / fog)
      const a    = (1 - df) * flicker              // texel weight
      const gR = F0 * df * flicker, gG = F1 * df * flicker, gB = F2 * df * flicker
      const dfL  = df * 0.45                        // light panels glow through fog
      const aL   = (1 - dfL) * flicker
      const gLR = F0 * dfL * flicker, gLG = F1 * dfL * flicker, gLB = F2 * dfL * flicker
      const ceiling = !isFloor
      const tbl  = isFloor ? tex.floor : tex.ceil
      const lt   = tex.light
      const stepX = rowDist * (ca1 - ca0) / W
      const stepY = rowDist * (sa1 - sa0) / W
      let fx = player.x + rowDist * ca0
      let fy = player.y + rowDist * sa0

      for (let x = 0; x < W; x++, fx += stepX, fy += stepY) {
        const cellX = ((fx + OFF) | 0) - OFF
        const cellY = ((fy + OFF) | 0) - OFF
        const tx = ((fx - cellX) * TS) & TMASK
        const ty = ((fy - cellY) * TS) & TMASK
        const ti = (ty * TS + tx) * 3

        let r, g, b
        if (ceiling && (cellX & 1) === 0 && (cellY & 1) === 0) {
          r = lt[ti] * aL + gLR; g = lt[ti + 1] * aL + gLG; b = lt[ti + 2] * aL + gLB
        } else {
          r = tbl[ti] * a + gR;  g = tbl[ti + 1] * a + gG;  b = tbl[ti + 2] * a + gB
        }
        buf32[rowOff + x] = (255 << 24)
          | ((b > 255 ? 255 : b) | 0) << 16
          | ((g > 255 ? 255 : g) | 0) << 8
          | ((r > 255 ? 255 : r) | 0)
      }
    }

    // ── walls (per column, textured) ──
    // Anything past the fog is drawn as solid fog anyway, so there is no point
    // marching rays (and generating chunks) beyond it. This bounds the per-frame
    // isWall calls to the visible radius instead of the old 96-unit default.
    const rayMax = Math.min(96, Math.ceil(fog) + 3)
    for (let col = 0; col < W; col++) {
      const angle = player.angle - HF + (col / W) * FOV
      const hit   = castRay(player.x, player.y, angle, isWallFn, rayMax)
      const corr  = hit.dist * Math.cos(angle - player.angle)
      zbuffer[col] = corr

      const whF = H / Math.max(0.001, corr)   // unclamped slice height
      const wtF = HH - whF / 2
      const y0  = Math.max(0, Math.ceil(wtF))
      const y1  = Math.min(H, Math.floor(wtF + whF))
      if (y1 <= y0) continue

      const distF   = Math.min(1, corr / fog)
      const sideMul = hit.side === 1 ? 0.72 : 1.0
      const texX = Math.min(TMASK, (hit.wallX * TS) | 0)
      const invWh = TS / whF
      // fog blend is constant down the column → precompute texel weight + fog add
      const a  = sideMul * (1 - distF) * flicker
      const wR = fogRgb[0] * distF * flicker, wG = fogRgb[1] * distF * flicker, wB = fogRgb[2] * distF * flicker
      const wt = tex.wall
      const base = texX * 3

      for (let y = y0; y < y1; y++) {
        const texY = (((y - wtF) * invWh) | 0) & TMASK
        const ti = texY * TS * 3 + base
        const r = wt[ti]     * a + wR
        const g = wt[ti + 1] * a + wG
        const b = wt[ti + 2] * a + wB
        buf32[y * W + col] = (255 << 24)
          | ((b > 255 ? 255 : b) | 0) << 16
          | ((g > 255 ? 255 : g) | 0) << 8
          | ((r > 255 ? 255 : r) | 0)
      }
    }

    wctx.putImageData(img, 0, 0)

    // ── sprites (drawn into the low-res world buffer) ──
    if (entities && entities.length > 0) {
      const sorted = [...entities].sort((a, b) => {
        const da = (a.x - player.x) ** 2 + (a.y - player.y) ** 2
        const db = (b.x - player.x) ** 2 + (b.y - player.y) ** 2
        return db - da
      })
      for (const ent of sorted) {
        const ex = ent.x - player.x, ey = ent.y - player.y
        const entDist = Math.sqrt(ex * ex + ey * ey)
        if (entDist < 0.4) continue
        const relAngle = ((Math.atan2(ey, ex) - player.angle + Math.PI * 3) % (Math.PI * 2)) - Math.PI
        if (Math.abs(relAngle) > HF + 0.3) continue
        const screenX = Math.floor(W / 2 + (relAngle / HF) * (W / 2))
        const fogT = Math.min(1, entDist / fog)

        if (ent.kind === 'item') {
          drawItem(ent, screenX, entDist, fogT, HH, H, W)
        } else {
          drawFigure(ent, screenX, entDist, fogT, HH, H, W)
        }
      }
    }

    // ── film grain (plain source-over — no 'overlay' blend, which is a heavy
    // per-frame full-screen composite that can stress the GPU/driver over time.
    // The tile textures already carry baked static grain; this just adds motion.)
    if (grainPattern) {
      grainPhase = (grainPhase + 37) & TMASK
      wctx.save()
      wctx.globalAlpha = 0.045
      wctx.fillStyle = grainPattern
      wctx.translate(-grainPhase, (grainPhase * 2) & 127)
      wctx.fillRect(grainPhase, -((grainPhase * 2) & 127), W + 128, H + 128)
      wctx.restore()
    }

    // ── upscale the world buffer to the window (bilinear softens it into fog) ──
    const OW = canvas.width, OH = canvas.height
    ctx.imageSmoothingEnabled = true
    ctx.drawImage(world, 0, 0, RW, RH, 0, 0, OW, OH)

    // ── vignette (precomputed) + flicker blackout, at full resolution ──
    if (vignette) ctx.drawImage(vignette, 0, 0)
    if (flicker < 0.9) {
      ctx.fillStyle = `rgba(0,0,0,${(1 - flicker) * 0.75})`
      ctx.fillRect(0, 0, OW, OH)
    }
  }

  // A cloaked standing figure: a rounded hood widening to a skirt, with faint
  // eyes when close. Column spans respect the wall zbuffer so it hides properly.
  // Drawn into the low-res world buffer (wctx).
  function drawFigure(ent, screenX, entDist, fogT, HH, H, W) {
    const spriteH = Math.min(H * 2, Math.floor(H / entDist))
    const spriteW = Math.floor(spriteH * 0.42)
    if (spriteW < 1) return
    const topBase = Math.floor(HH - spriteH * 0.5)
    const bottom  = topBase + spriteH
    const alpha = (1 - fogT) * 0.95
    if (alpha < 0.04) return
    const half = spriteW / 2

    for (let sx = -half; sx <= half; sx++) {
      const col = Math.floor(screenX + sx)
      if (col < 0 || col >= W) continue
      if (zbuffer[col] <= entDist) continue
      const u = sx / half                    // -1..1 across the body
      // rounded hood: edges start lower than the centre → hunched silhouette
      const top = topBase + (u * u) * spriteH * 0.34
      const hgt = bottom - top
      if (hgt <= 0) continue
      // slightly darker toward the centre for volume
      const shade = 18 - Math.abs(u) * 6
      wctx.fillStyle = `rgba(${shade | 0},${(shade * 0.8) | 0},${(shade * 0.6) | 0},${alpha.toFixed(3)})`
      wctx.fillRect(col, top | 0, 1, hgt | 0)
    }

    // faint pale eyes when it's close
    if (entDist < 9) {
      const eyeAlpha = (1 - entDist / 9) * 0.5
      const eyeY = topBase + spriteH * 0.16
      const eyeDx = spriteW * 0.13
      const eyeR = Math.max(1, spriteW * 0.05)
      wctx.fillStyle = `rgba(220,225,210,${eyeAlpha.toFixed(3)})`
      for (const dx of [-eyeDx, eyeDx]) {
        const col = Math.floor(screenX + dx)
        if (col >= 0 && col < W && zbuffer[col] > entDist) {
          wctx.fillRect(col - (eyeR | 0), eyeY, (eyeR * 2) | 0, (eyeR * 1.4) | 0)
        }
      }
    }
  }

  // Small floor-anchored pickups: a soft glow plus a suggestive shape per type.
  // Drawn into the low-res world buffer (wctx).
  function drawItem(ent, screenX, entDist, fogT, HH, H, W) {
    const size = Math.max(3, Math.min(H * 0.5, (H / entDist) * 0.24))
    const bottom = HH + (H / entDist) / 2
    const top = bottom - size
    const alpha = (1 - fogT) * 0.95
    if (alpha < 0.05) return
    const [r, g, b] = ITEM_COLORS[ent.itemType] ?? [220, 220, 220]
    const cx = screenX
    const w = Math.max(2, size * 0.5)

    // occlusion: skip entirely if the centre column is behind a wall
    if (screenX >= 0 && screenX < W && zbuffer[screenX] <= entDist) return

    wctx.save()
    // soft glow
    const glow = wctx.createRadialGradient(cx, top + size * 0.5, 1, cx, top + size * 0.5, size * 1.3)
    glow.addColorStop(0, `rgba(${r},${g},${b},${(alpha * 0.5).toFixed(3)})`)
    glow.addColorStop(1, 'rgba(0,0,0,0)')
    wctx.fillStyle = glow
    wctx.fillRect(cx - size * 1.3, top - size * 0.4, size * 2.6, size * 1.9)

    wctx.globalAlpha = alpha
    const t = ent.itemType
    if (t === 'glowstick') {
      wctx.fillStyle = `rgb(${r},${g},${b})`
      wctx.fillRect(cx - w * 0.18, top, w * 0.36, size)         // bright rod
      wctx.fillStyle = 'rgba(255,255,255,0.8)'
      wctx.fillRect(cx - w * 0.06, top, w * 0.12, size)         // hot core
    } else if (t === 'almond-water') {
      wctx.fillStyle = `rgb(${r},${g},${b})`
      wctx.fillRect(cx - w * 0.28, top + size * 0.22, w * 0.56, size * 0.78) // bottle
      wctx.fillStyle = 'rgba(230,240,250,0.9)'
      wctx.fillRect(cx - w * 0.10, top, w * 0.20, size * 0.28)  // neck/cap
    } else if (t === 'polaroid') {
      wctx.fillStyle = `rgb(${r},${g},${b})`
      wctx.fillRect(cx - w * 0.4, top + size * 0.2, w * 0.8, size * 0.7) // body
      wctx.fillStyle = 'rgba(30,30,40,0.9)'
      wctx.fillRect(cx - w * 0.14, top + size * 0.38, w * 0.28, size * 0.34) // lens
    } else { // radio
      wctx.fillStyle = `rgb(${r},${g},${b})`
      wctx.fillRect(cx - w * 0.4, top + size * 0.35, w * 0.8, size * 0.6) // box
      wctx.strokeStyle = 'rgba(220,220,200,0.8)'
      wctx.lineWidth = Math.max(1, w * 0.06)
      wctx.beginPath(); wctx.moveTo(cx + w * 0.2, top + size * 0.35); wctx.lineTo(cx + w * 0.45, top); wctx.stroke() // antenna
    }
    wctx.restore()
  }

  return { render }
}
