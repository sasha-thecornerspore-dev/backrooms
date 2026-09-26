// Fixer L (light + world pass): W1 (tint is near-neutral away from pools), W3 (the flicker budget keeps the frame's mean luminance above
// the comfort floor), PS-3 (a visibility floor on the dark lamp levels), W5 (the lightmap fades out instead of popping at its radius),
// W9 (NaN / garbage in look.lighting never blacks the frame out).
import { describe, it, expect } from 'vitest'
import { createLight, resolveLighting, lmEdgeFade, LEVEL_LIGHTING } from '../src/renderer/gfx-light.js'
import { renderWorld } from '../src/renderer/gfx-world.js'
import { buildTextures } from '../src/renderer/gfx-textures.js'
import { levelConfig } from '../src/renderer/levels.js'
import { DEFAULT_CONFIG, createChunkCache } from '../src/renderer/world.js'
import { NULL_MAP } from '../src/renderer/level-null-map.js'
import { hexToRgb } from '../src/renderer/gfx-util.js'
import { comfortFor, effectiveFlicker, qualityFor } from '../src/renderer/gfx-quality.js'

const cfgOf = (i) => levelConfig(DEFAULT_CONFIG, i)
const FOV = Math.PI / 2.4

// one world-pass frame of a level, the way gfx-cpu.js builds the frame state; returns the buffer
function renderFrame(cfg, light, tex, isWall, materialAt, { W = 96, H = 54, tier = 'high', pose, raw = 1, t = 0, dt = 1 / 30, reduce = false, lights = {}, fog = null, fogRgb = null } = {}) {
  const comfort = comfortFor({ qualityTier: tier, reduceFlicker: reduce, maxGlobalDip: 0.5 })
  const buf = new Uint32Array(W * H), z = new Float32Array(W)
  const fs = {
    W, H, HH: H >> 1, OW: W, OH: H, fog: fog ?? cfg.fogDistance, fogRgb: fogRgb ?? hexToRgb(cfg.palette.fog), fogMul: 1,
    flicker: effectiveFlicker(raw, comfort), rawFlicker: raw, comfort, frame: 1, t, dt,
    player: { ...pose, bobOffset: 0 }, lights, lightsOn: cfg.lights !== false, hasSky: !!cfg.sky, skyRgb: cfg.sky ? hexToRgb(cfg.sky) : null,
    light, quality: qualityFor(tier), opts: {}, levelKey: String(cfg.levelIndex), look: cfg.look, handled: {}, fov: FOV, hf: FOV / 2,
  }
  renderWorld(fs, tex, light, isWall, materialAt, buf, z)
  return buf
}
const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4 }
function meanLum(buf) { let m = 0; for (const p of buf) m += 0.2126 * lin(p & 255) + 0.7152 * lin((p >>> 8) & 255) + 0.0722 * lin((p >>> 16) & 255); return m / buf.length }
function lumaP(buf, q) {
  const l = Array.from(buf, (p) => 0.299 * (p & 255) + 0.587 * ((p >>> 8) & 255) + 0.114 * ((p >>> 16) & 255)).sort((a, b) => a - b)
  return l[Math.min(l.length - 1, Math.floor(q * l.length))]
}
function setup(levelIdx) {
  const cfg = cfgOf(levelIdx)
  const cc = createChunkCache(cfg, 12345)
  return { cfg, tex: buildTextures(cfg.palette, cfg.materials, cfg.look, String(cfg.levelIndex)), isWall: (x, y) => cc.isWall(x, y, 0, 0) }
}
// open poses looking down the longest open run, deterministic
function poses(isWall, n) {
  const out = []
  for (let i = 0; out.length < n && i < 4000; i++) {
    const x = ((i * 7919) % 41) + 0.5 - 20, y = ((i * 104729) % 37) + 0.5 - 18
    if (isWall(x, y)) continue
    let best = 0, ba = 0
    for (let a = 0; a < 8; a++) { const ang = a * Math.PI / 4; let d = 0; while (d < 14 && !isWall(x + Math.cos(ang) * d, y + Math.sin(ang) * d)) d += 0.25; if (d > best) { best = d; ba = ang } }
    if (best > 5) out.push({ x, y, angle: ba })
  }
  return out
}

describe('W9: NaN / garbage in look.lighting', () => {
  const junk = { ambient: NaN, peak: 'k', pool: undefined, radius: {}, contact: Infinity, fogGain: null, fogBase: 'x', fogGlow: NaN, ceilAmbient: NaN, every: NaN, warmth: NaN,
    windows: { radius: NaN, strength: 'z' } }
  for (const lvl of [0, 2, 4]) {
    it(`level ${lvl}: a garbage override falls back to the level default and stays finite`, () => {
      const cfg = { ...cfgOf(lvl), look: { ...(cfgOf(lvl).look || {}), lighting: junk } }
      const s = resolveLighting(cfg), d = resolveLighting(cfgOf(lvl))
      for (const k of ['ambient', 'peak', 'radius', 'fogGain', 'fogBase', 'fogGlow', 'ceilAmbient', 'every', 'warmth']) expect(Number.isFinite(s[k]), k).toBe(true)
      for (const k of ['ambient', 'radius', 'fogBase', 'fogGlow', 'ceilAmbient', 'every', 'warmth']) expect(s[k], k).toBeCloseTo(d[k], 6)
      for (const c of [...s.tint, ...s.ambTint]) expect(Number.isFinite(c)).toBe(true)
    })
  }
  it('a frame rendered with garbage lighting is not black', () => {
    const { cfg, tex, isWall } = setup(0)
    const bad = { ...cfg, look: { ...(cfg.look || {}), lighting: { ambient: NaN, peak: NaN, ceilAmbient: 'k', fogGain: NaN } } }
    const light = createLight(bad, {})
    const buf = renderFrame(bad, light, tex, isWall, null, { pose: { x: 2.5, y: 2.5, angle: 0 } })
    let lit = 0
    for (const p of buf) if ((p & 0xffffff) !== 0) lit++
    expect(lit).toBeGreaterThan(buf.length * 0.9)
    expect(meanLum(buf)).toBeGreaterThan(0.02)
  })
  it('numeric strings are still honoured', () => {
    expect(resolveLighting({ ...cfgOf(0), look: { lighting: { ambient: '0.7' } } }).ambient).toBeCloseTo(0.7)
  })
})

describe('W1 (light half): light.tint is near-neutral away from the pools', () => {
  const hooks = { materialAt: (wx, wy) => { const r = NULL_MAP[Math.floor(wy)], c = r && r[Math.floor(wx)]; return c && c !== '.' ? c : null } }
  const wallAt = (wx, wy) => { const r = NULL_MAP[Math.floor(wy)], c = r && r[Math.floor(wx)]; return !(c === '.' || c === ' ') }
  const fsOf = (player, over = {}) => ({ W: 64, H: 36, HH: 18, fog: 22, t: 0, dt: 1 / 60, frame: 1, rawFlicker: 1, flicker: 1, comfort: { reduceFlicker: false, maxGlobalDip: 1 },
    lights: {}, quality: { lightDetail: 1 }, player, ...over })
  const spread = (c) => Math.max(...c) - Math.min(...c)
  it('Level null: daylight away from a window is neutral, the spill in front of a window is warm', () => {
    const L = createLight(cfgOf(4), hooks)
    L.prepare(fsOf({ x: 8.5, y: 6.5, angle: 0 }), { ts: 64 }, wallAt)
    const far = L.tint(8.5, 4.5), near = L.tint(15.5, 9.4)
    expect(spread(far)).toBeLessThan(0.06)
    expect(near[0] - near[2]).toBeGreaterThan(0.25)
    expect(near[0] - near[2]).toBeGreaterThan(spread(far) * 4)
  })
  it('Level 2: a point in the dark between lamps is less amber than one right under a lamp', () => {
    const L = createLight(cfgOf(2), {})
    L.prepare(fsOf({ x: 10.5, y: 10.5, angle: 0 }, { fog: 18 }), { ts: 64 }, () => false)
    let lamp = null, dark = null
    for (let y = 4; y < 17; y += 0.5) for (let x = 4; x < 17; x += 0.5) {
      const p = L.at(x, y)
      if (!lamp || p > lamp.p) lamp = { x, y, p }
      if (!dark || p < dark.p) dark = { x, y, p }
    }
    const tl = L.tint(lamp.x, lamp.y), td = L.tint(dark.x, dark.y)
    expect(td[2] / td[0]).toBeGreaterThan(tl[2] / tl[0])       // the lamp's tint is the more saturated (less blue)
    for (const c of [...tl, ...td]) expect(c).toBeGreaterThan(0)
  })
  it('a glowstick still pulls the tint toward its own colour', () => {
    const L = createLight(cfgOf(0), {})
    L.prepare(fsOf({ x: 10.5, y: 10.5, angle: 0 }, { quality: { lightDetail: 2 }, lights: { glow: [80, 235, 110] } }), { ts: 64 }, () => false)
    const t = L.tint(10.5, 10.5)
    expect(t[1]).toBeGreaterThan(t[2])
  })
})

describe('PS-3: the dark lamp levels keep a visibility floor', () => {
  it('levels 2 and 3 have an ambient floor, and the dark stretches are readable but still darker than the legacy shading', () => {
    for (const k of ['2', '3']) { expect(LEVEL_LIGHTING[k].ambient).toBeGreaterThanOrEqual(0.3); expect(LEVEL_LIGHTING[k].ceilAmbient).toBeGreaterThanOrEqual(0.14) }
    for (const lvl of [2, 3]) {
      const { cfg, tex, isWall } = setup(lvl)
      const ps = poses(isWall, 8)
      const p95s = [], litMeans = [], legMeans = []
      for (const pose of ps) {
        const lit = renderFrame(cfg, createLight(cfg, {}), tex, isWall, null, { pose, tier: 'medium' })
        const leg = renderFrame(cfg, createLight(cfg, {}), tex, isWall, null, { pose, tier: 'legacy' })
        p95s.push(lumaP(lit, 0.95)); litMeans.push(meanLum(lit)); legMeans.push(meanLum(leg))
      }
      p95s.sort((a, b) => a - b)
      expect(p95s[p95s.length >> 1], `level ${lvl} median p95 luma`).toBeGreaterThanOrEqual(28)
      const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length
      expect(avg(litMeans), `level ${lvl} never brighter than the legacy shading`).toBeLessThan(avg(legMeans))
    }
  })
})

describe('W3: the flicker budget', () => {
  // a square-wave cascade (raw 0.14 half the time), several rates; the smallest frame mean / the steady frame mean
  function worstRatio(lvl, tier, reduce, hzs = [6, 2]) {
    const { cfg, tex, isWall } = setup(lvl)
    let worst = 1
    for (const pose of poses(isWall, 2)) for (const hz of hzs) {
      const light = createLight(cfg, {})
      let steady = 0, mn = 9
      for (let f = 0; f < 150; f++) {
        const t = f / 30
        const raw = f < 30 ? 1 : (Math.floor(t * hz * 2) % 2 ? 0.14 : 1)
        const m = meanLum(renderFrame(cfg, light, tex, isWall, null, { W: 64, H: 36, tier, pose, raw, t, reduce }))
        if (f === 29) steady = m
        if (f >= 30 && m < mn) mn = m
      }
      worst = Math.min(worst, mn / steady)
    }
    return worst
  }
  for (const [lvl, tier] of [[0, 'high'], [1, 'high'], [2, 'high'], [3, 'high'], [0, 'medium'], [3, 'medium']]) {
    it(`level ${lvl} at ${tier}: the frame never falls under half of steady luminance (and under 3/4 with reduceFlicker)`, () => {
      expect(worstRatio(lvl, tier, false)).toBeGreaterThanOrEqual(0.5)
      expect(worstRatio(lvl, tier, true, [2])).toBeGreaterThanOrEqual(0.75)
    })
  }
  it('the unclamped legacy comfort (maxGlobalDip 1) is not budgeted: the model is unchanged', () => {
    const cfg = cfgOf(0), light = createLight(cfg, {})
    const fs = { W: 64, H: 36, HH: 18, fog: 16, t: 0, dt: 1 / 60, frame: 1, rawFlicker: 0, flicker: 0, comfort: { reduceFlicker: false, maxGlobalDip: 1 }, lights: {}, quality: { lightDetail: 2 }, player: { x: 10.5, y: 10.5, angle: 0 } }
    for (let i = 0; i < 90; i++) { fs.t = i / 60; light.prepare(fs, { ts: 64 }, () => false) }
    expect(light.frame.dimS).toBe(1)
    expect(light.frame.gdip).toBeCloseTo(1 - 0.34, 2)
  })
})

describe('W5: the lightmap fades out over its last cells', () => {
  it('lmEdgeFade is 1 inside, 0 at the radius, and monotone in between', () => {
    expect(lmEdgeFade(0, 15)).toBe(1); expect(lmEdgeFade(12, 15)).toBe(1); expect(lmEdgeFade(15, 15)).toBe(0); expect(lmEdgeFade(20, 15)).toBe(0)
    let prev = 1
    for (let d = 12; d <= 15; d += 0.1) { const f = lmEdgeFade(d, 15); expect(f).toBeLessThanOrEqual(prev + 1e-9); prev = f }
    expect(lmEdgeFade(13.5, 15)).toBeCloseTo(0.5, 5)
  })

  const hooks = { materialAt: (wx, wy) => { const r = NULL_MAP[Math.floor(wy)], c = r && r[Math.floor(wx)]; return c && c !== '.' ? c : null } }
  const wallAt = (wx, wy) => { const r = NULL_MAP[Math.floor(wy)], c = r && r[Math.floor(wx)]; return !(c === '.' || c === ' ') }
  it('light.at() has no step as the player walks away from a lit window', () => {
    const cfg = cfgOf(4), L = createLight(cfg, hooks)
    let prev = null, worst = 0
    for (let px = 0.6; px <= 4.4; px += 0.05) {                 // the window at x 14..16 slides through the fade zone (12..15 cells away)
      L.prepare({ W: 64, H: 36, HH: 18, fog: 22, t: 0, dt: 1 / 60, frame: 1, rawFlicker: 1, flicker: 1, comfort: { reduceFlicker: false, maxGlobalDip: 1 }, lights: {},
        quality: { lightDetail: 1 }, player: { x: px, y: 8.5, angle: 0 } }, { ts: 64 }, wallAt)
      const v = L.at(15.5, 9.2)
      if (prev !== null) worst = Math.max(worst, Math.abs(v - prev))
      prev = v
    }
    expect(worst).toBeLessThan(0.05)                            // the old hard edge was a 0.34 step
  })

  it('the world pass and light.at() agree across the fade zone (floor pixels vs the query)', () => {
    const cfg = { ...cfgOf(4), look: { ...(cfgOf(4).look || {}), lighting: { windows: { strength: 2, radius: 6 } } } }   // a strong, wide spill, so the fade is a big signal
    const L = createLight(cfg, hooks)
    const ts = 64, W = 256, H = 384
    const flat = (v) => { const a = new Uint8Array(ts * ts * 3); a.fill(v); return a }
    const tex = { ts, tmask: ts - 1, walls: { 0: flat(120) }, ceil: flat(100), floor: flat(100), light: flat(100) }
    const pose = { x: 1.5, y: 8.5, angle: 0 }
    const buf = new Uint32Array(W * H), z = new Float32Array(W)
    const comfort = { reduceFlicker: false, maxGlobalDip: 1 }
    const fs = { W, H, HH: H >> 1, OW: W, OH: H, fog: 100, fogRgb: [0, 0, 0], fogMul: 1, flicker: 1, rawFlicker: 1, comfort, frame: 1, t: 0, dt: 1 / 60,
      player: { ...pose, bobOffset: 0 }, lights: {}, lightsOn: true, hasSky: true, skyRgb: [90, 90, 110], light: L, quality: { scale: 0.6, texFilter: 0, lightDetail: 1 },
      opts: {}, levelKey: '∅', look: null, handled: {}, fov: FOV, hf: FOV / 2 }
    renderWorld(fs, tex, L, wallAt, hooks.materialAt, buf, z)
    const F = L.frame, rec = L.recipe
    const ca0 = Math.cos(-FOV / 2), sa0 = Math.sin(-FOV / 2), ca1 = Math.cos(FOV / 2), sa1 = Math.sin(FOV / 2)

    let compared = 0, inFade = 0, worst = 0
    for (let y = (H >> 1) + 1; y < H; y++) {
      const rowDist = (H - (H >> 1)) / Math.max(1, y - (H >> 1))
      for (let x = 0; x < W; x += 4) {
        const ptx = pose.x + rowDist * (ca0 + (ca1 - ca0) * x / W), pty = pose.y + rowDist * (sa0 + (sa1 - sa0) * x / W)
        if (rowDist > 17.5 || z[x] < rowDist || ptx < 12.8 || ptx > 18.4 || pty < 5.5 || pty > 8.95) continue          // the spill in front of the window row, clear of the contact-shaded cells
        const g = ((buf[y * W + x] >>> 8) & 255) / 100
        const a = 1 - rowDist / 100
        const ps = (g / a - F.aG) / F.tG                                          // the pool the pixel carries (ambient-only pixels give ~0)
        const want = L.at(ptx, pty) - rec.ambient
        worst = Math.max(worst, Math.abs(ps - want) - 0.15 * Math.max(want, 0))       // relative 15% + the byte quantisation
        compared++
        const dc = Math.max(Math.abs(ptx - pose.x), Math.abs(pty - pose.y))
        if (dc > 12.4 && dc < 14.6 && want > 0.06) inFade++
      }
    }
    expect(compared).toBeGreaterThan(20)
    expect(inFade).toBeGreaterThan(5)
    expect(worst).toBeLessThan(0.04)                                     // (the unfaded world pass is off by ~0.27 here)
  })
})
