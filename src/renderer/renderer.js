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

export function createRenderer(canvas, config, renderOpts = {}) {
  const ctx = canvas.getContext('2d', { alpha: false })
  const ropts = renderOpts   // shared mutable object: { grain, crosshair } — read live

  const fogRgb  = hexToRgb(config.palette.fog)
  const baseFog = config.fogDistance
  const tex     = buildTextures(config.palette)
  const grainCanvas = buildGrain()
  let grainPhase = 0
  let frame = 0

  // ── atmospheric particles: dust motes, rising steam, or electrical sparks ──
  const pcfg = config.particles || {}
  const PCOUNT = Math.max(0, pcfg.count ?? 0)
  const particles = []
  function seedParticles() {
    particles.length = 0
    for (let i = 0; i < PCOUNT; i++) {
      particles.push({ x: Math.random() * winW, y: Math.random() * winH, z: 0.35 + Math.random() * 0.65, ph: Math.random() * 6.283 })
    }
  }

  const ITEM_COLORS = {
    'almond-water': [190, 215, 235],
    'glowstick':    [120, 235, 90],
    'bandage':      [235, 235, 240],
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

    seedParticles()
  }

  function render(player, isWallFn, flicker, entities = [], fogMul = 1, lights = {}) {
    frame++
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
    const namePlates = []   // remote-player labels, drawn crisp at full-res later
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
        } else if (ent.kind === 'prop') {
          drawProp(ent, screenX, entDist, fogT, HH, H, W)
        } else if (ent.kind === 'exit') {
          drawExit(ent, screenX, entDist, fogT, HH, H, W)
        } else if (ent.kind === 'player' || ent.kind === 'npc') {
          drawPlayer(ent, screenX, entDist, fogT, HH, H, W, namePlates)
        } else {
          drawFigure(ent, screenX, entDist, fogT, HH, H, W)
        }
      }
    }

    // ── film grain (plain source-over — no 'overlay' blend, which is a heavy
    // per-frame full-screen composite that can stress the GPU/driver over time.
    // The tile textures already carry baked static grain; this just adds motion.)
    if (grainPattern && ropts.grain !== false) {
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

    // ── atmospheric particles (dust / steam / sparks), full-res over the scene ──
    if (PCOUNT && ropts.particles !== false) {
      const col = pcfg.color || [225, 220, 200]
      const cs = `${col[0]},${col[1]},${col[2]}`
      const rise = !!pcfg.rise, spark = !!pcfg.spark
      const sway = pcfg.sway ?? 0.3, speed = pcfg.speed ?? 0.3, baseSize = pcfg.size ?? 1.4
      ctx.save()
      ctx.fillStyle = `rgb(${cs})`
      for (const p of particles) {
        p.ph += 0.02
        p.x += Math.sin(p.ph) * sway * p.z
        p.y += (rise ? -1 : 1) * speed * (0.5 + p.z)
        if (p.y < -8)      { p.y = OH + 8; p.x = Math.random() * OW }
        else if (p.y > OH + 8) { p.y = -8; p.x = Math.random() * OW }
        if (p.x < -8) p.x = OW + 8; else if (p.x > OW + 8) p.x = -8
        const flick = spark ? (0.25 + 0.75 * Math.abs(Math.sin(p.ph * 4))) : 1
        ctx.globalAlpha = (spark ? 0.7 : 0.28) * (0.4 + 0.6 * p.z) * flick * flicker
        ctx.beginPath(); ctx.arc(p.x, p.y, baseSize * (0.6 + p.z), 0, 6.283); ctx.fill()
      }
      ctx.restore()
    }

    // ── the player's own light: flashlight cone + a glowstick's colored wash ──
    if (lights.flashlight) {
      const g = ctx.createRadialGradient(OW / 2, OH * 0.52, OH * 0.04, OW / 2, OH * 0.52, OH * 0.72)
      g.addColorStop(0, 'rgba(255,244,212,0.24)')
      g.addColorStop(0.5, 'rgba(255,238,196,0.09)')
      g.addColorStop(1, 'rgba(0,0,0,0)')
      ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.fillStyle = g; ctx.fillRect(0, 0, OW, OH); ctx.restore()
    }
    if (lights.glow) {
      const [gr, gg, gb] = lights.glow
      const pulse = 0.72 + 0.28 * Math.sin(frame * 0.11)
      const g = ctx.createRadialGradient(OW / 2, OH * 0.6, OH * 0.03, OW / 2, OH * 0.6, OH * 0.62)
      g.addColorStop(0, `rgba(${gr},${gg},${gb},${(0.20 * pulse).toFixed(3)})`)
      g.addColorStop(1, 'rgba(0,0,0,0)')
      ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.fillStyle = g; ctx.fillRect(0, 0, OW, OH); ctx.restore()
    }

    // ── remote-player nameplates — full-res so names stay crisp ──
    if (namePlates.length) {
      const inv = 1 / RENDER_SCALE
      ctx.save()
      ctx.textAlign = 'center'
      for (const np of namePlates) {
        if (np.sx < 0 || np.sx >= RW) continue
        const fx = np.sx * inv
        const fy = Math.max(16, np.y * inv)
        // nameplate
        ctx.font = 'bold 13px "Courier New", monospace'
        const w = ctx.measureText(np.name).width + 14
        ctx.globalAlpha = Math.min(1, np.alpha + 0.25)
        ctx.fillStyle = 'rgba(8,10,14,0.72)'
        ctx.fillRect(fx - w / 2, fy - 15, w, 18)
        ctx.fillStyle = 'rgba(226,233,246,0.96)'
        ctx.fillText(np.name, fx, fy - 2)
        // floating speech bubble above the name — you SEE them talk in the fog
        if (np.speech) {
          ctx.font = '13px "Courier New", monospace'
          const msg = np.speech.length > 44 ? np.speech.slice(0, 43) + '…' : np.speech
          const bw = ctx.measureText(msg).width + 16
          const by = fy - 22
          ctx.globalAlpha = 1
          ctx.fillStyle = 'rgba(14,17,24,0.92)'
          ctx.fillRect(fx - bw / 2, by - 16, bw, 20)
          ctx.beginPath(); ctx.moveTo(fx - 4, by + 4); ctx.lineTo(fx + 4, by + 4); ctx.lineTo(fx, by + 9); ctx.closePath(); ctx.fill()
          ctx.fillStyle = 'rgba(150,210,255,0.98)'
          ctx.fillText(msg, fx, by - 2)
        }
        // teammate HP bar under the name (co-op awareness)
        if (np.hp != null) {
          const bw = 42, bx = fx - bw / 2, hy = fy + 3
          ctx.globalAlpha = Math.min(1, np.alpha + 0.25)
          ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.fillRect(bx - 1, hy - 1, bw + 2, 5)
          const hpf = Math.max(0, Math.min(1, np.hp / 100))
          ctx.fillStyle = hpf > 0.5 ? 'rgba(90,190,100,0.95)' : hpf > 0.25 ? 'rgba(210,180,60,0.95)' : 'rgba(210,70,60,0.95)'
          ctx.fillRect(bx, hy, bw * hpf, 3)
        }
      }
      ctx.restore()
    }

    // ── crosshair — a small dark dot with a faint light outline, centred ──
    if (ropts.crosshair !== false) {
      const ccx = OW / 2, ccy = OH / 2
      ctx.save()
      ctx.globalAlpha = 0.5
      ctx.fillStyle = 'rgba(255,255,255,0.7)'
      ctx.fillRect(ccx - 2, ccy - 2, 4, 4)
      ctx.fillStyle = 'rgba(0,0,0,0.9)'
      ctx.fillRect(ccx - 1, ccy - 1, 2, 2)
      ctx.restore()
    }
  }

  // Soft contact shadow ellipse under a floor-standing sprite.
  function contactShadow(cx, floorY, w, alpha) {
    if (alpha < 0.03) return
    wctx.save()
    wctx.globalAlpha = alpha
    wctx.fillStyle = '#000'
    wctx.beginPath()
    wctx.ellipse(cx, floorY, w * 0.6, Math.max(1, w * 0.18), 0, 0, Math.PI * 2)
    wctx.fill()
    wctx.restore()
  }

  // Palette-tinted clutter: chairs, cabinets, pipes, transformers… Billboarded,
  // floor-anchored, non-interactive. Recognisable silhouettes over fidelity.
  const PROP_SPEC = {
    chair:       { h: 0.95, w: 0.6, c: [40, 34, 26] },
    cabinet:     { h: 1.55, w: 0.7, c: [70, 66, 54] },
    box:         { h: 0.7,  w: 0.8, c: [122, 96, 58] },
    crate:       { h: 0.75, w: 0.85, c: [110, 88, 56] },
    cone:        { h: 0.6,  w: 0.5, c: [200, 90, 30] },
    papers:      { h: 0.16, w: 0.7, c: [220, 214, 196] },
    plant:       { h: 1.1,  w: 0.6, c: [60, 74, 40] },
    pallet:      { h: 0.26, w: 1.0, c: [120, 96, 60] },
    barrel:      { h: 1.0,  w: 0.55, c: [90, 70, 46] },
    drum:        { h: 1.0,  w: 0.6, c: [70, 78, 60] },
    couch:       { h: 0.85, w: 1.3, c: [78, 68, 54] },
    cart:        { h: 1.0,  w: 0.8, c: [150, 150, 156] },
    pipe:        { h: 1.4,  w: 0.5, c: [96, 84, 64] },
    valve:       { h: 0.9,  w: 0.6, c: [110, 92, 66] },
    vent:        { h: 0.8,  w: 0.9, c: [90, 84, 70] },
    toolbox:     { h: 0.4,  w: 0.7, c: [150, 60, 40] },
    transformer: { h: 1.8,  w: 0.9, c: [76, 80, 90] },
    'cabinet-e': { h: 1.7,  w: 0.8, c: [70, 74, 84] },
    spool:       { h: 1.0,  w: 1.0, c: [96, 82, 62] },
    sign:        { h: 0.9,  w: 0.7, c: [210, 170, 40] },
  }

  function drawProp(ent, screenX, entDist, fogT, HH, H, W) {
    if (screenX < 0 || screenX >= W || zbuffer[screenX] <= entDist) return
    const spec = PROP_SPEC[ent.type] ?? PROP_SPEC.box
    const unit = H / entDist                         // pixels per world unit
    const floorY = HH + unit / 2
    const ph = spec.h * unit
    const pw = spec.w * unit
    const top = floorY - ph
    const alpha = (1 - fogT) * 0.96
    if (alpha < 0.05 || pw < 1) return
    const [r, g, b] = spec.c
    const shade = 1 - fogT * 0.6
    const col = (m = 1) => `rgba(${(r * m * shade) | 0},${(g * m * shade) | 0},${(b * m * shade) | 0},${alpha.toFixed(3)})`
    const cx = screenX
    const L = cx - pw / 2

    contactShadow(cx, floorY, pw, alpha * 0.4)
    wctx.save()
    const t = ent.type

    if (t === 'chair') {
      wctx.fillStyle = col(1)
      wctx.fillRect(L + pw * 0.15, top + ph * 0.45, pw * 0.7, ph * 0.14)   // seat
      wctx.fillRect(L + pw * 0.15, top, pw * 0.16, ph * 0.6)               // backrest
      wctx.fillStyle = col(0.7)
      wctx.fillRect(L + pw * 0.2, top + ph * 0.6, pw * 0.1, ph * 0.4)      // legs
      wctx.fillRect(L + pw * 0.7, top + ph * 0.6, pw * 0.1, ph * 0.4)
    } else if (t === 'cabinet' || t === 'cabinet-e' || t === 'transformer') {
      wctx.fillStyle = col(1)
      wctx.fillRect(L, top, pw, ph)
      wctx.strokeStyle = col(0.6); wctx.lineWidth = Math.max(1, pw * 0.04)
      for (let d = 1; d <= 3; d++) { const yy = top + ph * d / 4; wctx.beginPath(); wctx.moveTo(L, yy); wctx.lineTo(L + pw, yy); wctx.stroke() }
      if (t === 'transformer') { wctx.fillStyle = `rgba(220,180,40,${(alpha * 0.8).toFixed(3)})`; wctx.fillRect(L + pw * 0.3, top + ph * 0.1, pw * 0.4, ph * 0.1) }
    } else if (t === 'cone') {
      wctx.fillStyle = col(1)
      wctx.beginPath(); wctx.moveTo(cx, top); wctx.lineTo(L, floorY); wctx.lineTo(L + pw, floorY); wctx.closePath(); wctx.fill()
      wctx.fillStyle = `rgba(240,240,235,${(alpha * 0.8).toFixed(3)})`
      wctx.fillRect(L + pw * 0.2, top + ph * 0.4, pw * 0.6, ph * 0.14)     // reflective band
    } else if (t === 'plant') {
      wctx.fillStyle = col(0.8); wctx.fillRect(L + pw * 0.3, top + ph * 0.6, pw * 0.4, ph * 0.4)   // pot
      wctx.fillStyle = col(1)
      for (let i = -2; i <= 2; i++) { wctx.beginPath(); wctx.moveTo(cx, top + ph * 0.6); wctx.lineTo(cx + i * pw * 0.18, top); wctx.lineTo(cx + i * pw * 0.05, top + ph * 0.6); wctx.closePath(); wctx.fill() }
    } else if (t === 'barrel' || t === 'drum') {
      wctx.fillStyle = col(1); wctx.fillRect(L + pw * 0.15, top, pw * 0.7, ph)
      wctx.strokeStyle = col(0.6); wctx.lineWidth = Math.max(1, pw * 0.05)
      for (const f of [0.25, 0.5, 0.75]) { const yy = top + ph * f; wctx.beginPath(); wctx.moveTo(L + pw * 0.15, yy); wctx.lineTo(L + pw * 0.85, yy); wctx.stroke() }
    } else if (t === 'couch') {
      wctx.fillStyle = col(1); wctx.fillRect(L, top + ph * 0.3, pw, ph * 0.7)
      wctx.fillRect(L, top, pw * 0.16, ph); wctx.fillRect(L + pw * 0.84, top, pw * 0.16, ph)
    } else if (t === 'pallet' || t === 'papers') {
      wctx.fillStyle = col(1); wctx.fillRect(L, top, pw, ph)
      wctx.strokeStyle = col(0.6); wctx.lineWidth = 1
      for (let i = 1; i < 4; i++) { const xx = L + pw * i / 4; wctx.beginPath(); wctx.moveTo(xx, top); wctx.lineTo(xx, top + ph); wctx.stroke() }
    } else if (t === 'pipe' || t === 'valve' || t === 'vent') {
      wctx.fillStyle = col(1); wctx.fillRect(L + pw * 0.35, top, pw * 0.3, ph)   // vertical pipe
      if (t === 'valve') { wctx.strokeStyle = col(0.7); wctx.lineWidth = Math.max(1, pw * 0.08); wctx.beginPath(); wctx.arc(cx, top + ph * 0.5, pw * 0.3, 0, Math.PI * 2); wctx.stroke() }
      if (t === 'vent') { wctx.fillStyle = col(0.7); wctx.fillRect(L, top + ph * 0.2, pw, ph * 0.5) }
    } else if (t === 'cart') {
      wctx.strokeStyle = col(1); wctx.lineWidth = Math.max(1, pw * 0.06)
      wctx.strokeRect(L + pw * 0.15, top + ph * 0.2, pw * 0.7, ph * 0.5)       // basket
      wctx.fillStyle = col(0.5); wctx.beginPath(); wctx.arc(L + pw * 0.3, floorY - ph * 0.05, pw * 0.09, 0, 7); wctx.arc(L + pw * 0.7, floorY - ph * 0.05, pw * 0.09, 0, 7); wctx.fill()
    } else if (t === 'spool') {
      wctx.fillStyle = col(1); wctx.fillRect(L, top, pw * 0.12, ph); wctx.fillRect(L + pw * 0.88, top, pw * 0.12, ph)
      wctx.fillStyle = col(0.7); wctx.fillRect(L + pw * 0.12, top + ph * 0.15, pw * 0.76, ph * 0.7)
    } else if (t === 'sign') {
      wctx.fillStyle = col(1)
      wctx.beginPath(); wctx.moveTo(cx, top); wctx.lineTo(L, floorY); wctx.lineTo(L + pw, floorY); wctx.closePath(); wctx.fill()
      wctx.fillStyle = `rgba(20,20,20,${alpha.toFixed(3)})`; wctx.fillRect(cx - pw * 0.04, top + ph * 0.3, pw * 0.08, ph * 0.35)   // exclamation
      wctx.fillRect(cx - pw * 0.04, top + ph * 0.72, pw * 0.08, pw * 0.08)
    } else { // box / crate / toolbox / default
      wctx.fillStyle = col(1); wctx.fillRect(L, top, pw, ph)
      wctx.strokeStyle = col(0.65); wctx.lineWidth = Math.max(1, pw * 0.05)
      wctx.strokeRect(L, top, pw, ph)
      wctx.beginPath(); wctx.moveTo(L, top); wctx.lineTo(L + pw, top + ph); wctx.moveTo(L + pw, top); wctx.lineTo(L, top + ph); wctx.stroke()
    }
    wctx.restore()
  }

  // A "no-clip" exit: a dark doorway/hole standing on the floor, with a faint
  // rim that breathes so it reads as findable in the fog.
  function drawExit(ent, screenX, entDist, fogT, HH, H, W) {
    if (screenX < 0 || screenX >= W || zbuffer[screenX] <= entDist) return
    const unit = H / entDist
    const floorY = HH + unit / 2
    const dh = 1.6 * unit
    const dw = 0.9 * unit
    const top = floorY - dh
    const alpha = (1 - fogT)
    if (alpha < 0.04 || dw < 1) return
    const cx = screenX
    const L = cx - dw / 2
    const pulse = 0.55 + 0.45 * Math.sin(frame * 0.07)

    contactShadow(cx, floorY, dw * 1.2, alpha * 0.5)
    wctx.save()

    // glowing light beam rising from the spot — the beacon that carries through fog
    const beamTop = floorY - dh * 1.7
    const beam = wctx.createLinearGradient(0, beamTop, 0, floorY)
    const ba = (alpha * (0.32 + 0.26 * pulse)).toFixed(3)
    beam.addColorStop(0, 'rgba(150,190,230,0)')
    beam.addColorStop(1, `rgba(175,208,242,${ba})`)
    wctx.fillStyle = beam
    wctx.fillRect(cx - dw * 0.34, beamTop, dw * 0.68, floorY - beamTop)

    // the dark portal itself
    wctx.globalAlpha = alpha
    wctx.fillStyle = '#050608'
    wctx.beginPath()
    wctx.moveTo(L, floorY)
    wctx.lineTo(L + dw * 0.12, top + dh * 0.06)
    wctx.quadraticCurveTo(cx, top, L + dw * 0.88, top + dh * 0.06)
    wctx.lineTo(L + dw, floorY)
    wctx.closePath()
    wctx.fill()

    // bright breathing rim
    wctx.globalAlpha = alpha * (0.7 + 0.3 * pulse)
    wctx.strokeStyle = 'rgba(205,224,248,0.95)'
    wctx.lineWidth = Math.max(1.5, dw * 0.06)
    wctx.stroke()

    // bright base ring on the floor — reads even at distance
    wctx.globalAlpha = alpha * (0.45 + 0.5 * pulse)
    wctx.strokeStyle = 'rgba(185,214,244,0.9)'
    wctx.lineWidth = Math.max(1, dw * 0.05)
    wctx.beginPath()
    wctx.ellipse(cx, floorY, dw * 0.5, Math.max(1, dw * 0.16), 0, 0, Math.PI * 2)
    wctx.stroke()

    wctx.restore()
  }

  // A cloaked standing figure: a rounded hood widening to a skirt, with faint
  // eyes when close. Column spans respect the wall zbuffer so it hides properly.
  // Drawn into the low-res world buffer (wctx).
  // Per-variant silhouette + tells. `shade` is the classic hunched figure; the
  // others read differently in the fog — a low hound, a tall lurker, a grinning
  // smiler, an electric thing — so levels feel populated by distinct creatures.
  const FIG = {
    shade:   { w: 0.42, h: 1.0,  tint: [18, 15, 12], low: false },
    watcher: { w: 0.40, h: 1.0,  tint: [16, 16, 18], low: false, eyes: true },
    smiler:  { w: 0.44, h: 1.0,  tint: [14, 12, 12], low: false, grin: true },
    hound:   { w: 0.72, h: 0.5,  tint: [22, 14, 10], low: true,  eyes: true },
    crawler: { w: 0.9,  h: 0.42, tint: [16, 14, 12], low: true },
    lurker:  { w: 0.3,  h: 1.25, tint: [10, 12, 14], low: false, eyes: true },
    tesla:   { w: 0.42, h: 1.05, tint: [16, 22, 32], low: false, electric: true, eyes: true },
  }
  function drawFigure(ent, screenX, entDist, fogT, HH, H, W) {
    const s = FIG[ent.variant] || FIG.shade
    const fullH = H / entDist
    const spriteH = Math.min(H * 2, Math.floor(fullH * s.h))
    const spriteW = Math.floor(spriteH * s.w)
    if (spriteW < 1) return
    const bottom  = s.low ? (HH + fullH / 2) : Math.floor(HH + spriteH * 0.5)
    const topBase = bottom - spriteH
    const alpha = (1 - fogT) * 0.95
    if (alpha < 0.04) return
    const half = spriteW / 2
    const hood = s.low ? 0.12 : 0.34

    for (let sx = -half; sx <= half; sx++) {
      const col = Math.floor(screenX + sx)
      if (col < 0 || col >= W) continue
      if (zbuffer[col] <= entDist) continue
      const u = sx / half
      const top = topBase + (u * u) * spriteH * hood
      const hgt = bottom - top
      if (hgt <= 0) continue
      const sh = 1 - Math.abs(u) * 0.32
      wctx.fillStyle = `rgba(${(s.tint[0] * sh) | 0},${(s.tint[1] * sh) | 0},${(s.tint[2] * sh) | 0},${alpha.toFixed(3)})`
      wctx.fillRect(col, top | 0, 1, hgt | 0)
    }

    const sc = Math.floor(screenX)
    // smiler — a wide, too-bright grin
    if (s.grin && entDist < 12 && sc >= 0 && sc < W && zbuffer[sc] > entDist) {
      const gy = topBase + spriteH * 0.19
      wctx.strokeStyle = `rgba(232,226,205,${((1 - entDist / 12) * 0.9).toFixed(3)})`
      wctx.lineWidth = Math.max(1, spriteW * 0.06)
      wctx.beginPath(); wctx.arc(sc, gy - spriteW * 0.25, spriteW * 0.42, 0.18 * Math.PI, 0.82 * Math.PI); wctx.stroke()
    }
    // tesla — flickering electric outline
    if (s.electric && ((frame + sc) % 6) < 2) {
      wctx.strokeStyle = `rgba(150,210,255,${(alpha * 0.65).toFixed(3)})`
      wctx.lineWidth = 1
      wctx.strokeRect(sc - half, topBase, spriteW, spriteH)
    }
    // pale eyes when close
    if (s.eyes && entDist < 9) {
      const eyeAlpha = (1 - entDist / 9) * (s.electric ? 0.7 : 0.5)
      const eyeY = topBase + spriteH * (s.low ? 0.22 : 0.16)
      const eyeDx = spriteW * 0.13
      const eyeR = Math.max(1, spriteW * 0.05)
      wctx.fillStyle = s.electric ? `rgba(170,220,255,${eyeAlpha.toFixed(3)})` : `rgba(220,225,210,${eyeAlpha.toFixed(3)})`
      for (const dx of [-eyeDx, eyeDx]) {
        const col = Math.floor(screenX + dx)
        if (col >= 0 && col < W && zbuffer[col] > entDist) wctx.fillRect(col - (eyeR | 0), eyeY, (eyeR * 2) | 0, (eyeR * 1.4) | 0)
      }
    }
  }

  // A fellow wanderer (remote player): a pale, upright human figure — clearly a
  // person, not one of the lurking things — and a nameplate recorded for full-res.
  function drawPlayer(ent, screenX, entDist, fogT, HH, H, W, namePlates) {
    const spriteH = Math.min(H * 2, Math.floor(H / entDist))
    const spriteW = Math.floor(spriteH * 0.36)
    if (spriteW < 1) return
    const topBase = Math.floor(HH - spriteH * 0.5)
    const bottom  = topBase + spriteH
    const alpha = (1 - fogT) * 0.96
    if (alpha < 0.05) return
    const half = spriteW / 2

    for (let sx = -half; sx <= half; sx++) {
      const col = Math.floor(screenX + sx)
      if (col < 0 || col >= W) continue
      if (zbuffer[col] <= entDist) continue
      const u = sx / half
      const top = topBase + spriteH * 0.20 + (u * u) * spriteH * 0.06
      const hgt = bottom - top
      if (hgt <= 0) continue
      const shade = 120 - Math.abs(u) * 42
      wctx.fillStyle = `rgba(${shade | 0},${(shade * 1.05) | 0},${(shade * 1.18) | 0},${alpha.toFixed(3)})`
      wctx.fillRect(col, top | 0, 1, hgt | 0)
    }
    const sc = Math.floor(screenX)
    if (sc >= 0 && sc < W && zbuffer[sc] > entDist) {
      const headR = Math.max(1, spriteW * 0.22)
      wctx.fillStyle = `rgba(152,158,170,${alpha.toFixed(3)})`
      wctx.beginPath(); wctx.arc(screenX, topBase + spriteH * 0.12, headR, 0, Math.PI * 2); wctx.fill()
    }
    contactShadow(screenX, bottom, spriteW * 0.9, alpha * 0.4)
    if (ent.name) namePlates.push({ sx: screenX, y: topBase - spriteH * 0.03, name: ent.name, alpha, speech: ent.chatText, hp: ent.hp })
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
    } else if (t === 'bandage') {
      wctx.fillStyle = `rgb(${r},${g},${b})`
      wctx.fillRect(cx - w * 0.32, top + size * 0.25, w * 0.64, size * 0.6) // white box
      wctx.fillStyle = 'rgba(210,50,50,0.95)'                              // red cross
      wctx.fillRect(cx - w * 0.05, top + size * 0.33, w * 0.10, size * 0.44)
      wctx.fillRect(cx - w * 0.20, top + size * 0.48, w * 0.40, size * 0.14)
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
