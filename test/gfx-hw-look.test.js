// Track HW, stage 1 (look): the lit ceiling panel's diffuser (V6), the lamp fixture ring (lamp pixelation) and the Level 0 carpet (V7).
import { describe, it, expect } from 'vitest'
import { buildTextures } from '../src/renderer/gfx-textures.js'
import { LEVELS } from '../src/renderer/levels.js'

const levelOf = (k) => LEVELS.find((l) => String(l.id) === k).config
const tex = (k, palette = null) => buildTextures(palette || levelOf(k).palette, levelOf(k).materials || null, null, k)
const lum = (t, i) => 0.299 * t[i] + 0.587 * t[i + 1] + 0.114 * t[i + 2]

describe('V6 the fluorescent panel reads as a diffuser, not hard stripes', () => {
  for (const k of ['0', '1']) {
    it(`level ${k}: the tube bands are low-contrast and soft-edged, the frame and the mean brightness are kept`, () => {
      const t = tex(k).light, TS = 64
      // row means over the middle of the panel (away from the lamp holders), so the film noise averages out
      const rows = []
      for (let y = 4; y < TS - 4; y++) { let s = 0; for (let x = 12; x < TS - 12; x++) s += lum(t, (y * TS + x) * 3); rows.push(s / (TS - 24)) }
      const inner = rows
      const span = Math.max(...inner) - Math.min(...inner)
      let step = 0
      for (let i = 1; i < inner.length; i++) step = Math.max(step, Math.abs(inner[i] - inner[i - 1]))
      expect(span).toBeLessThan(0.045 * 250)        // was a 7.5% tube / gap contrast (~18 levels); now about half
      expect(span).toBeGreaterThan(0.02 * 250)      // ...but the tubes still show through
      expect(step).toBeLessThan(6)                  // soft shoulders (~4.7 a row at most): the old pattern stepped ~17 levels from one row to the next
      let m = 0; for (let i = 0; i < t.length; i += 3) m += lum(t, i)
      m /= TS * TS
      expect(m).toBeGreaterThan(0.99 * (k === '0' ? 219.95 : 213.28))      // the old panel's mean luminance
      expect(m).toBeLessThan(1.01 * (k === '0' ? 219.95 : 213.28))
      // the aluminium frame is untouched: darker than the diffuser, all the way round
      for (const [x, y] of [[1, 30], [62, 30], [30, 1], [30, 62]]) expect(lum(t, (y * TS + x) * 3)).toBeLessThan(0.85 * rows[28])
    })
  }
})

// ── the lamp fixture's ring (Level 2 / 3) ──
import { createLight } from '../src/renderer/gfx-light.js'
import { renderWorld } from '../src/renderer/gfx-world.js'
import { levelConfig } from '../src/renderer/levels.js'
import { DEFAULT_CONFIG, createChunkCache } from '../src/renderer/world.js'
import { hexToRgb } from '../src/renderer/gfx-util.js'
import { comfortFor, qualityFor } from '../src/renderer/gfx-quality.js'
import { worldFragmentSource } from '../src/renderer/gfx-gl-world-shader.js'

describe('lamp fixtures: the ring is measured from the sub-texel position (smooth, not stair-stepped)', () => {
  const FOV = Math.PI / 2.4
  const cfg = levelConfig(DEFAULT_CONFIG, 2), cc = createChunkCache(cfg, 12345)
  const isWall = (x, y) => cc.isWall(x, y, 0, 0)
  const tex = buildTextures(cfg.palette, cfg.materials, cfg.look, '2')
  const frame = (pose, W, H, tier) => {
    const light = createLight(cfg, {}), buf = new Uint32Array(W * H), z = new Float32Array(W)
    const fs = { W, H, HH: H >> 1, OW: W, OH: H, fog: cfg.fogDistance, fogRgb: hexToRgb(cfg.palette.fog), fogMul: 1, flicker: 1, rawFlicker: 1,
      comfort: comfortFor({ qualityTier: tier, maxGlobalDip: 0.5 }), frame: 1, t: 0, dt: 1 / 30, player: { ...pose, bobOffset: 0 }, lights: {}, lightsOn: true,
      hasSky: false, skyRgb: null, light, quality: qualityFor(tier), opts: {}, levelKey: '2', look: cfg.look, handled: {}, fov: FOV, hf: FOV / 2 }
    renderWorld(fs, tex, light, isWall, null, buf, z)
    return { buf, light }
  }
  const lumOf = (p) => 0.299 * (p & 255) + 0.587 * ((p >>> 8) & 255) + 0.114 * ((p >>> 16) & 255)

  it('a close lamp\'s bulb edge has many intermediate shades per row at every tier (one flat step per texel before)', () => {
    // find a real lamp near the origin from the light's own cell window, with an open cell to stand in west of it
    const F = frame({ x: 0.5, y: 0.5, angle: 0 }, 64, 36, 'medium').light.frame
    let lamp = null, best = 1e9
    for (let cy = F.occCy - F.occR; cy <= F.occCy + F.occR; cy++) for (let cx = F.occCx - F.occR; cx <= F.occCx + F.occR; cx++) {
      if (F.cellLamp[((cy & 63) << 6) | (cx & 63)] !== 1 || isWall(cx - 0.5, cy + 0.5) || isWall(cx - 1.5, cy + 0.5)) continue
      const d = Math.abs(cx) + Math.abs(cy); if (d < best) { best = d; lamp = { cx, cy } }
    }
    expect(lamp).not.toBe(null)
    for (const tier of ['low', 'medium', 'high']) {
      const W = 480, H = 270, { buf } = frame({ x: lamp.cx + 0.5 - 1.5, y: lamp.cy + 0.57, angle: 0 }, W, H, tier)
      let maxL = 0
      for (let i = 0; i < W * (H >> 1); i++) maxL = Math.max(maxL, lumOf(buf[i]))
      expect(maxL).toBeGreaterThan(150)                      // the bulb is in view
      let distinct = 0, rows = 0
      for (let y = 0; y < H >> 1; y++) {
        const s = new Set()
        for (let x = 0; x < W; x++) { const p = buf[y * W + x], l = lumOf(p); if (l > maxL * 0.45 && l < maxL * 0.9) s.add(p) }
        if (s.size) { distinct += s.size; rows++ }
      }
      expect(rows).toBeGreaterThan(6)
      expect(distinct / rows).toBeGreaterThan(2.5)          // measured 3.4 (the integer-texel disc gave 1.3)
    }
  }, 60000)

  it('the GPU shader measures the lamp disc from the same sub-texel position', () => {
    const src = worldFragmentSource({ lit: true, sky: false })
    const lampBlock = src.slice(src.indexOf('if (lampC) {'))
    expect(lampBlock).toMatch(/vec2 pd = f \* uTSf - HT;/)
    expect(lampBlock).not.toMatch(/vec2 pd = vec2\(tt\) - HT;/)
  })
})

// ── V7: the Level 0 carpet stays in the lobby's yellow-brown ──
describe('V7 the Level 0 carpet has no orange / red-brown blotches, and stays palette-relative', () => {
  const hs = (r, g, b) => {
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b)
    if (mx === mn) return [0, 0]
    let h
    if (mx === r) h = 60 * (((g - b) / (mx - mn)) % 6); else if (mx === g) h = 60 * ((b - r) / (mx - mn) + 2); else h = 60 * ((r - g) / (mx - mn) + 4)
    return [(h + 360) % 360, (mx - mn) / mx]
  }
  const hexHs = (hex) => hs(...hexToRgb(hex))
  const stats = (tiles, hue0, sat0) => {
    let n = 0, redder = 0, hot = 0, far = 0, dsum = 0
    for (const t of tiles) for (let i = 0; i < t.length; i += 3) {
      const [h, s] = hs(t[i], t[i + 1], t[i + 2]); n++
      let dh = h - hue0; if (dh > 180) dh -= 360; if (dh < -180) dh += 360
      dsum += dh
      if (dh < -3) redder++
      if (s > sat0 * 1.16) hot++
      if (Math.abs(dh) > 20) far++
    }
    return { redder: redder / n, hot: hot / n, far: far / n, meanDh: dsum / n }
  }
  it('no texel of the carpet (base and every variant) is redder or much more saturated than the floor colour itself', () => {
    const pal = levelOf('0').palette, [h0, s0] = hexHs(pal.floor)
    const t = tex('0')
    const s = stats([t.floor, ...t.floorVar], h0, s0)
    expect(s.redder).toBeLessThan(0.02)       // was 17% (the orange second tone and the red-brown stains)
    expect(s.hot).toBeLessThan(0.02)          // was 40%
  })
  it('a wish-drifted floor colour drags the whole carpet with it (the tones are multiples of the palette hex)', () => {
    for (const floor of ['#3C4A30', '#4A3858']) {                       // drifted to an olive green, to a violet
      const pal = { ...levelOf('0').palette, floor }
      const [h0, s0] = hexHs(pal.floor)
      const t = tex('0', pal)
      const s = stats([t.floor, ...t.floorVar], h0, s0)
      expect(s.far).toBeLessThan(0.02)
      expect(Math.abs(s.meanDh)).toBeLessThan(5)
    }
  })
})
