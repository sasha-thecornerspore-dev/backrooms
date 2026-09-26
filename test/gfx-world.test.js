// gfx-world.js / module import safety. The world pass is pure (typed arrays in, typed arrays out), so it runs in
// Node. The pixel-level guarantees of the refactor live in tools/gfx (the Electron harness); these tests cover
// what vitest can: every renderer module imports without a DOM, and the world pass samples with the TexSet's
// own tile size instead of a hard-coded 64.
import { describe, it, expect } from 'vitest'
import { renderWorld } from '../src/renderer/gfx-world.js'
import { buildTextures } from '../src/renderer/gfx-textures.js'
import { createLight } from '../src/renderer/gfx-light.js'
import { levelConfig } from '../src/renderer/levels.js'
import { DEFAULT_CONFIG, createChunkCache } from '../src/renderer/world.js'
import { createFixedMap } from '../src/renderer/fixedmap.js'
import { hexToRgb } from '../src/renderer/gfx-util.js'
import { comfortFor, effectiveFlicker, qualityFor } from '../src/renderer/gfx-quality.js'

describe('renderer modules are import-safe in Node (no document/window at module scope)', () => {
  const mods = ['gfx-util', 'gfx-textures', 'gfx-light', 'gfx-world', 'gfx-sprites', 'gfx-post', 'gfx-cpu', 'renderer']
  for (const m of mods) {
    it(`${m}.js imports without a DOM`, async () => {
      expect(typeof document).toBe('undefined')
      expect(typeof window).toBe('undefined')
      await expect(import(`../src/renderer/${m}.js`)).resolves.toBeDefined()
    })
  }

  it('renderer.js keeps the public entry point', async () => {
    const r = await import('../src/renderer/renderer.js')
    expect(typeof r.createRenderer).toBe('function')
  })
})

// a 12x12 open box with solid border; the player stands in the middle looking east
const isWall = (wx, wy) => wx <= 0 || wy <= 0 || wx >= 11 || wy >= 11

function frameState(W, H, over = {}) {
  const fov = Math.PI / 2.4
  return {
    W, H, HH: H >> 1, OW: W, OH: H,
    fog: 1e9, fogRgb: [212, 200, 122], fogMul: 1, flicker: 1, frame: 1, t: 0,
    player: { x: 5.5, y: 5.5, angle: 0, bobOffset: 0 },
    lights: {}, lightsOn: false, hasSky: false, skyRgb: null,
    quality: { scale: 0.6 }, opts: {}, fov, hf: fov / 2,
    ...over,
  }
}

// a ts*ts tile whose texel (x, y) is (base + x, base + y, base)
function tile(ts, base) {
  const t = new Uint8Array(ts * ts * 3)
  for (let y = 0; y < ts; y++) for (let x = 0; x < ts; x++) { const i = (y * ts + x) * 3; t[i] = base + x; t[i + 1] = base + y; t[i + 2] = base }
  return t
}

describe('renderWorld', () => {
  it('fills the whole buffer with opaque pixels and a depth for every column', () => {
    const W = 48, H = 32
    const buf32 = new Uint32Array(W * H), zbuffer = new Float32Array(W)
    const tex = { ts: 4, tmask: 3, walls: { 0: tile(4, 100) }, ceil: tile(4, 60), floor: tile(4, 40), light: tile(4, 200) }
    renderWorld(frameState(W, H), tex, null, isWall, null, buf32, zbuffer)
    for (const px of buf32) expect(px >>> 24).toBe(255)
    for (const z of zbuffer) { expect(Number.isFinite(z)).toBe(true); expect(z).toBeGreaterThan(0); expect(z).toBeLessThanOrEqual(6) }
  })

  it('samples textures with tex.ts / tex.tmask, not a hard-coded 64', () => {
    // 2x2 tiles: floor texels are (40|41, 40|41, 40); a sampler that assumed 64 would read past the array
    const W = 48, H = 32
    const buf32 = new Uint32Array(W * H), zbuffer = new Float32Array(W)
    const tex = { ts: 2, tmask: 1, walls: { 0: tile(2, 100) }, ceil: tile(2, 60), floor: tile(2, 40), light: tile(2, 200) }
    renderWorld(frameState(W, H), tex, null, isWall, null, buf32, zbuffer)
    // rows well below the horizon, away from any wall slice, are pure floor (fog is effectively infinite => weight ~1)
    for (let y = H - 4; y < H; y++) for (let x = 0; x < W; x++) {
      const px = buf32[y * W + x]
      const r = px & 255, g = (px >>> 8) & 255, b = (px >>> 16) & 255
      expect(r).toBeGreaterThanOrEqual(38); expect(r).toBeLessThanOrEqual(41)
      expect(g).toBeGreaterThanOrEqual(38); expect(g).toBeLessThanOrEqual(41)
      expect(b).toBeGreaterThanOrEqual(38); expect(b).toBeLessThanOrEqual(40)
    }
  })

  it('picks the wall tile from materialAt and falls back to material 0', () => {
    const W = 48, H = 32
    const tex = { ts: 4, tmask: 3, walls: { 0: tile(4, 100), Z: tile(4, 200) }, ceil: tile(4, 60), floor: tile(4, 40), light: tile(4, 200) }
    const run = (materialAt) => {
      const buf32 = new Uint32Array(W * H), zbuffer = new Float32Array(W)
      renderWorld(frameState(W, H), tex, null, isWall, materialAt, buf32, zbuffer)
      return buf32[(H >> 1) * W + (W >> 1)] & 255   // red channel at screen centre (a wall slice)
    }
    const plain = run(null)
    expect(plain).toBeGreaterThanOrEqual(99); expect(plain).toBeLessThanOrEqual(104)
    const special = run(() => 'Z')
    expect(special).toBeGreaterThanOrEqual(199); expect(special).toBeLessThanOrEqual(204)
    expect(run(() => 'unknown-code')).toBe(plain)
  })

  it('draws open sky above the horizon instead of ceiling texels', () => {
    const W = 48, H = 32
    const buf32 = new Uint32Array(W * H), zbuffer = new Float32Array(W)
    const tex = { ts: 4, tmask: 3, walls: { 0: tile(4, 100) }, ceil: tile(4, 60), floor: tile(4, 40), light: tile(4, 200) }
    renderWorld(frameState(W, H, { hasSky: true, skyRgb: [185, 183, 174] }), tex, null, isWall, null, buf32, zbuffer)
    // the top row is pure sky (t = 0); rows are constant across x where no wall slice reaches them
    const top = buf32[0]
    expect(top & 255).toBe(185)
    for (let x = 1; x < W; x++) expect(buf32[x]).toBe(top)
  })
})

// ── the lit path (lightDetail >= 1) ────────────────────────────────────────────────────────────────────────────────────────────
// Real levels, real textures, the real light model. What must hold: geometry is untouched (same z-buffer), the legacy tier is
// byte-identical whether or not a light is passed, and the lit frame is deterministic, opaque, bounded and never blacked out by flicker.
describe('renderWorld: the lit path', () => {
  const LW = 96, LH = 54, LFOV = Math.PI / 2.4

  function scene(levelIndex, pose = {}) {
    const cfg = levelConfig(DEFAULT_CONFIG, levelIndex)
    const cache = cfg.map ? createFixedMap(cfg.map) : createChunkCache(cfg, 0)
    cache.preload(0, 0)
    const hooks = cfg.map ? { materialAt: (x, y) => cache.materialAt(x, y) } : {}
    const player = { x: pose.x ?? 11.5, y: pose.y ?? 19.5, angle: pose.angle ?? Math.PI / 2, bobOffset: 0 }
    const isWallFn = (x, y) => cache.isWall(x, y, 0, 0)
    return { cfg, hooks, player, isWallFn, tex: buildTextures(cfg.palette, cfg.materials, cfg.look, String(cfg.levelIndex)) }
  }
  function render(sc, tier, over = {}, light = createLight(sc.cfg, sc.hooks)) {
    const comfort = comfortFor({})
    const flick = over.rawFlicker ?? 1
    const fs = {
      W: LW, H: LH, HH: LH >> 1, OW: 960, OH: 540, fog: sc.cfg.fogDistance, fogRgb: hexToRgb(sc.cfg.palette.fog), fogMul: 1,
      flicker: effectiveFlicker(flick, comfort), rawFlicker: flick, comfort, frame: 1, t: over.t ?? 0.1, dt: 1 / 60,
      player: sc.player, lights: over.lights || {}, lightsOn: sc.cfg.lights !== false, hasSky: !!sc.cfg.sky, skyRgb: sc.cfg.sky ? hexToRgb(sc.cfg.sky) : null,
      light, quality: qualityFor(tier), opts: {}, levelKey: String(sc.cfg.levelIndex), handled: { flashlight: false, glow: false }, fov: LFOV, hf: LFOV / 2,
    }
    const buf32 = new Uint32Array(LW * LH), zbuffer = new Float32Array(LW)
    const frames = over.frames ?? 1
    for (let i = 0; i < frames; i++) { fs.frame = i + 1; fs.t = (over.t ?? 0.1) + i / 60; renderWorld(fs, sc.tex, light, sc.isWallFn, sc.hooks.materialAt || null, buf32, zbuffer) }
    return { buf32, zbuffer, light, fs }
  }
  const mean = (buf) => { let s = 0; for (const p of buf) s += (p & 255) + ((p >>> 8) & 255) + ((p >>> 16) & 255); return s / (buf.length * 3) }

  it('the legacy tier is byte-identical with or without a light model, and leaves the light disabled', () => {
    const sc = scene(0)
    const a = render(sc, 'legacy', {}, null)
    const b = render(sc, 'legacy')
    expect(Buffer.from(b.buf32.buffer).equals(Buffer.from(a.buf32.buffer))).toBe(true)
    expect(Array.from(b.zbuffer)).toEqual(Array.from(a.zbuffer))
    expect(b.light.enabled).toBe(false)
  })

  it('every lit tier and level fills the frame with opaque, finite pixels and leaves the geometry (z-buffer) as the legacy path made it', () => {
    for (const lvl of [0, 1, 2, 3, 4]) {
      const pose = lvl === 4 ? { x: 12.5, y: 13, angle: Math.PI / 2 } : lvl === 2 ? { x: 33.5, y: -3.5, angle: 4.71 } : lvl === 3 ? { x: -4.5, y: -10.5, angle: Math.PI } : {}
      const sc = scene(lvl, pose)
      const legacy = render(sc, 'legacy')
      for (const tier of ['low', 'medium', 'high']) {
        const lit = render(sc, tier)
        expect(lit.light.enabled, `${lvl}/${tier}`).toBe(true)
        expect(Array.from(lit.zbuffer), `${lvl}/${tier} z`).toEqual(Array.from(legacy.zbuffer))
        for (const px of lit.buf32) expect(px >>> 24).toBe(255)
        expect(Number.isFinite(mean(lit.buf32))).toBe(true)
      }
    }
  }, 30000)

  it('is deterministic: the same frame from two independent lights is the same picture', () => {
    for (const tier of ['low', 'medium', 'high']) {
      const sc = scene(0, { x: 9.5, y: 7.5, angle: 0 })
      const a = render(sc, tier, { lights: { flashlight: true } }), b = render(sc, tier, { lights: { flashlight: true } })
      expect(Buffer.from(a.buf32.buffer).equals(Buffer.from(b.buf32.buffer)), tier).toBe(true)
    }
  })

  it('light pools: the lit lobby is not a flat wash, but not black either', () => {
    const sc = scene(0, { x: 9.5, y: 7.5, angle: 0 })
    const legacy = render(sc, 'legacy'), lit = render(sc, 'medium')
    const ratio = mean(lit.buf32) / mean(legacy.buf32)
    expect(ratio).toBeGreaterThan(0.4); expect(ratio).toBeLessThan(1.15)
    // the floor rows are not a flat wash: brightness varies across a floor row (pools and their dark between)
    const row = LH - 6
    let lo = 1e9, hi = -1e9
    for (let x = 0; x < LW; x++) { const p = lit.buf32[row * LW + x]; const v = (p & 255) + ((p >>> 8) & 255) + ((p >>> 16) & 255); lo = Math.min(lo, v); hi = Math.max(hi, v) }
    expect(hi / lo).toBeGreaterThan(1.05)
  })

  it('flicker is spatial: a hard event dims the frame by a bounded amount (legacy went to ~20%)', () => {
    const sc = scene(0, { x: 9.5, y: 7.5, angle: 0 })
    const steady = render(sc, 'high', { rawFlicker: 1, frames: 90 }), event = render(sc, 'high', { rawFlicker: 0.2, frames: 90 })
    const legacyEvent = render(sc, 'legacy', { rawFlicker: 0.2 }), legacySteady = render(sc, 'legacy')
    const litRatio = mean(event.buf32) / mean(steady.buf32), legacyRatio = mean(legacyEvent.buf32) / mean(legacySteady.buf32)
    expect(legacyRatio).toBeLessThan(0.3)
    expect(litRatio).toBeGreaterThan(0.4)
    expect(litRatio).toBeLessThan(1)
    expect(event.light.frame.gdip).toBeGreaterThanOrEqual(0.66 - 1e-9)                 // the model's own whole-frame dip is bounded
  }, 30000)

  it("tells the post pass what it handled: the player's lights only at lightDetail 2, the spatial flicker whenever the light is on", () => {
    const sc = scene(0)
    const hi = render(sc, 'high', { lights: { flashlight: true, glow: [80, 235, 110] } })
    expect(hi.fs.handled.flashlight).toBe(true); expect(hi.fs.handled.glow).toBe(true); expect(hi.fs.handled.flicker).toBe(true)
    const med = render(sc, 'medium', { lights: { flashlight: true, glow: [80, 235, 110] } })
    expect(med.fs.handled.flashlight).toBe(false); expect(med.fs.handled.glow).toBe(false); expect(med.fs.handled.flicker).toBe(true)
    const leg = render(sc, 'legacy', { lights: { flashlight: true } })
    expect(leg.fs.handled.flashlight).toBe(false); expect(leg.fs.handled.flicker).toBeUndefined()
  })

  it('the flashlight and the glowstick brighten the frame, and the glowstick tints it', () => {
    const sc = scene(3, { x: -4.5, y: -10.5, angle: Math.PI })
    const off = render(sc, 'high'), fl = render(sc, 'high', { lights: { flashlight: true } }), gl = render(sc, 'high', { lights: { glow: [80, 235, 110] } })
    expect(mean(fl.buf32)).toBeGreaterThan(mean(off.buf32) + 1)
    expect(mean(gl.buf32)).toBeGreaterThan(mean(off.buf32) + 1)
    const chan = (buf, sh) => { let s = 0; for (const p of buf) s += (p >>> sh) & 255; return s }
    expect(chan(gl.buf32, 8) - chan(off.buf32, 8)).toBeGreaterThan(chan(gl.buf32, 16) - chan(off.buf32, 16))      // green gained more than blue
  })

  it('works with a 128-texel tile set', () => {
    const sc = scene(0)
    sc.tex = { ts: 128, tmask: 127, walls: { 0: tile(128, 100) }, ceil: tile(128, 60), floor: tile(128, 90), light: tile(128, 200) }
    for (const tier of ['medium', 'high']) {
      const a = render(sc, tier, { lights: { flashlight: true } })
      for (const px of a.buf32) expect(px >>> 24).toBe(255)
      expect(a.light.enabled).toBe(true)
    }
  }, 30000)

  it('picks per-cell texture variants (floor, ceiling, wall) in the lit path, deterministically, with mip chains built per variant', () => {
    const sc = scene(0, { x: 9.5, y: 7.5, angle: 0 })
    const base = sc.tex
    sc.tex = { ...base, floorVar: [base.floor, tile(64, 20), tile(64, 70)], ceilVar: [base.ceil, tile(64, 150)], wallVar: { 0: [base.walls[0], tile(64, 120), tile(64, 160)] } }
    for (const tier of ['low', 'medium', 'high']) {
      const a = render(sc, tier), b = render(sc, tier)
      expect(Buffer.from(a.buf32.buffer).equals(Buffer.from(b.buf32.buffer)), tier).toBe(true)
      for (const px of a.buf32) expect(px >>> 24).toBe(255)
    }
    const plain = render({ ...sc, tex: base }, 'medium'), varied = render(sc, 'medium')
    expect(Buffer.from(plain.buf32.buffer).equals(Buffer.from(varied.buf32.buffer))).toBe(false)     // the variants reached the screen
  }, 30000)

  it('an open periodic hall looks the same from a far, negative place (positions are kept relative to an even origin)', () => {
    const hall = (ox, oy) => {
      const hc = levelConfig(DEFAULT_CONFIG, 0)
      // the light model is what must be periodic here; A1's per-cell texture variants are hashed by absolute cell address, so they legitimately differ far away
      const tex = { ...buildTextures(hc.palette, hc.materials, hc.look, '0'), wallVar: null, floorVar: null, ceilVar: null }
      const lightM = createLight(hc, {})
      const comfort = comfortFor({})
      const isWallFn = (x, y) => x - ox <= 0 || y - oy <= 0 || x - ox >= 21 || y - oy >= 21
      const fs = { W: LW, H: LH, HH: LH >> 1, OW: 960, OH: 540, fog: 16, fogRgb: hexToRgb(hc.palette.fog), fogMul: 1, flicker: 1, rawFlicker: 1, comfort, frame: 1, t: 0.1, dt: 1 / 60,
        player: { x: ox + 10.5, y: oy + 10.5, angle: 0.4, bobOffset: 0 }, lights: {}, lightsOn: true, hasSky: false, skyRgb: null, light: lightM, quality: qualityFor('medium'),
        opts: {}, levelKey: '0', handled: {}, fov: LFOV, hf: LFOV / 2 }
      const buf32 = new Uint32Array(LW * LH), zbuffer = new Float32Array(LW)
      renderWorld(fs, tex, lightM, isWallFn, null, buf32, zbuffer)
      return buf32
    }
    const near = hall(0, 0), far = hall(-4000, 6000)
    let diff = 0
    for (let i = 0; i < near.length; i++) if (near[i] !== far[i]) diff++
    expect(diff / near.length).toBeLessThan(0.02)
  }, 30000)

  it('an outdoor level draws its sky and lights its rowhouses', () => {
    const sc = scene(4, { x: 12.5, y: 13, angle: Math.PI / 2 })
    const lit = render(sc, 'medium')
    for (const px of lit.buf32) expect(px >>> 24).toBe(255)
    expect(lit.buf32[0] & 255).toBeGreaterThan(60)                                   // sky, not black
  })
})
