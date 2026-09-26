// gfx-sky.js — the overcast sky of Level ∅: the seeded cloud strip, the sky/haze colour ramp, and renderSky's two looks
// (legacy gradient at the `legacy` tier; the panning cloud layer at every other tier). All pure: runs in Node, no DOM.
import { describe, it, expect } from 'vitest'
import { renderSky, buildCloudStrip, cloudStrip, CLOUD_W, CLOUD_H, skyBase, skyConfigFor, LEVEL_SKY, noise2, cloudDensity, stripRowTan } from '../src/renderer/gfx-sky.js'
import { TIERS } from '../src/renderer/gfx-quality.js'

const px = (buf, W, x, y) => { const v = buf[y * W + x]; return [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, v >>> 24] }
const lum = (c) => 0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2]

// a modern-tier frame state for Level ∅ (960x540 at scale 0.6 → 576x324)
function fsFor(over = {}) {
  const W = 576, H = 324
  return {
    W, H, HH: 162, skyRgb: [185, 183, 174], fogRgb: [154, 150, 140], flicker: 1, t: 0, hf: 0.6545, fov: 1.309,
    player: { x: 10, y: 8, angle: 1.5 }, quality: TIERS.medium, levelKey: '∅', light: { enabled: false }, ...over,
  }
}

describe('cloud strip', () => {
  it('is deterministic: two builds are byte-identical, and the shared strip is that same field', () => {
    const a = buildCloudStrip(), b = buildCloudStrip()
    expect(a.length).toBe(CLOUD_W * CLOUD_H)
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true)
    expect(Buffer.from(cloudStrip()).equals(Buffer.from(a))).toBe(true)
    expect(cloudStrip()).toBe(cloudStrip())          // built once, shared
  })
  it('is a soft mottled field: full range in use, mid-grey on average, no hard edges', () => {
    const s = cloudStrip()
    let lo = 255, hi = 0, sum = 0, maxStep = 0
    for (let j = 0; j < CLOUD_H; j++) for (let i = 0; i < CLOUD_W; i++) {
      const v = s[j * CLOUD_W + i]
      lo = Math.min(lo, v); hi = Math.max(hi, v); sum += v
      const n = s[j * CLOUD_W + ((i + 1) % CLOUD_W)]
      if (j > 8) maxStep = Math.max(maxStep, Math.abs(v - n))   // (the rows nearest the horizon are compressed and fade out in the sky anyway)
    }
    const mean = sum / s.length
    expect(hi - lo).toBeGreaterThan(150)
    expect(mean).toBeGreaterThan(90); expect(mean).toBeLessThan(170)
    expect(maxStep).toBeLessThan(40)                  // adjacent azimuth texels never jump: clouds have soft edges
  })
  it('wraps seamlessly around the circle (azimuth 0 and 2π are the same place)', () => {
    const s = cloudStrip()
    for (const j of [10, 40, 80]) {
      const seam = Math.abs(s[j * CLOUD_W] - s[j * CLOUD_W + CLOUD_W - 1])
      expect(seam).toBeLessThan(40)
    }
  })
  it('the value noise is a pure function of the lattice (same input, same output) and stays in 0..1', () => {
    for (const [x, y] of [[0.3, 0.7], [-4.2, 9.9], [123.4, -56.7]]) {
      expect(noise2(x, y)).toBe(noise2(x, y))
      const n = noise2(x, y); expect(n).toBeGreaterThanOrEqual(0); expect(n).toBeLessThanOrEqual(1)
      const d = cloudDensity(x, y); expect(d).toBeGreaterThanOrEqual(0); expect(d).toBeLessThanOrEqual(1)
    }
  })
  it('fading octaves out removes detail (the anti-alias used near the horizon)', () => {
    const full = [], soft = []
    for (let i = 0; i < 200; i++) { full.push(cloudDensity(i * 0.11, 3.3)); soft.push(cloudDensity(i * 0.11, 3.3, [1, 0, 0, 0, 0])) }
    const rough = (a) => a.slice(1).reduce((s, v, i) => s + Math.abs(v - a[i]), 0)
    expect(rough(soft)).toBeLessThan(rough(full))
  })
  it('strip rows map monotonically to elevation', () => {
    for (let j = 1; j < CLOUD_H; j++) expect(stripRowTan(j)).toBeGreaterThan(stripRowTan(j - 1))
  })
})

describe('sky colour ramp', () => {
  const cfg = LEVEL_SKY['∅']
  it('the horizon IS the fog colour and the top IS the sky colour (no glow leaks onto either end)', () => {
    const top = skyBase(1, [185, 183, 174], [154, 150, 140], cfg)
    const hor = skyBase(0, [185, 183, 174], [154, 150, 140], cfg)
    for (let i = 0; i < 3; i++) { expect(top[i]).toBeCloseTo([185, 183, 174][i], 6); expect(hor[i]).toBeCloseTo([154, 150, 140][i], 6) }
  })
  it('the pale band above the horizon lifts the sky a few percent at most, and only there', () => {
    const plain = { ...cfg, glow: 0 }
    let maxLift = 0
    for (let q = 0; q <= 1; q += 0.02) {
      const a = skyBase(q, [185, 183, 174], [154, 150, 140], cfg), b = skyBase(q, [185, 183, 174], [154, 150, 140], plain)
      maxLift = Math.max(maxLift, a[1] / b[1] - 1)
      expect(a[1]).toBeGreaterThanOrEqual(b[1] - 1e-9)
    }
    expect(maxLift).toBeGreaterThan(0.02); expect(maxLift).toBeLessThan(0.07)
  })
  it('is palette-relative: it is built only from the sky and fog colours it is given', () => {
    const a = skyBase(0.5, [100, 50, 20], [10, 20, 30], cfg)
    for (let i = 0; i < 3; i++) expect(a[i]).toBeGreaterThan(Math.min([100, 50, 20][i], [10, 20, 30][i]) - 1)
  })
  it('config overrides merge over the level defaults', () => {
    expect(skyConfigFor({ levelKey: '∅' })).toBe(LEVEL_SKY['∅'])
    expect(skyConfigFor({ levelKey: 'nope' })).toBe(LEVEL_SKY.default)
    expect(skyConfigFor({ levelKey: '∅', look: { sky: { amp: 0.5 } } }).amp).toBe(0.5)
    expect(skyConfigFor({ levelKey: '∅', look: { sky: { amp: 0.5 } } }).haze).toBe(LEVEL_SKY['∅'].haze)
  })
})

describe('renderSky (overcast tiers)', () => {
  it('keeps the legacy gradient at the legacy tier and with a bare fs (no quality field)', () => {
    const fs = fsFor({ quality: TIERS.legacy, flicker: 0.5 })
    const a = new Uint32Array(fs.W * fs.H), b = new Uint32Array(fs.W * fs.H)
    renderSky(fs, a)
    const { quality, ...bare } = fs
    renderSky(bare, b)
    expect(Buffer.from(a.buffer).equals(Buffer.from(b.buffer))).toBe(true)
    // the old formula: linear sky->fog per row, times the flicker scalar
    const [r] = px(a, fs.W, 5, 0)
    expect(r).toBe(Math.floor(185 * 0.5))
  })

  it('draws clouds: rows are no longer flat, but stay inside the sky and fog colours ± the cloud amplitude', () => {
    const fs = fsFor(), buf = new Uint32Array(fs.W * fs.H)
    renderSky(fs, buf)
    let varies = 0
    for (let x = 1; x < fs.W; x++) if (buf[40 * fs.W + x] !== buf[40 * fs.W]) varies++
    expect(varies).toBeGreaterThan(fs.W * 0.5)
    for (let y = 0; y <= fs.HH; y += 9) for (let x = 0; x < fs.W; x += 17) {
      const l = lum(px(buf, fs.W, x, y))
      expect(l).toBeGreaterThan(110); expect(l).toBeLessThan(215)   // never a bright disc, never a black hole
    }
  })

  it('the horizon row equals the fog fill exactly, and rows below the horizon are never touched', () => {
    for (const HH of [162, 161, 100]) {
      const fs = fsFor({ HH, flicker: 0.8 }), buf = new Uint32Array(fs.W * fs.H).fill(0xdeadbeef)
      renderSky(fs, buf)
      const want = fs.fogRgb.map((v) => Math.floor(v * 0.8))
      for (let x = 0; x < fs.W; x += 23) expect(px(buf, fs.W, x, HH).slice(0, 3)).toEqual(want)
      for (let y = HH + 1; y < fs.H; y++) expect(buf[y * fs.W + 3]).toBe(0xdeadbeef)
    }
  })

  it('pans with the view angle: turning by d radians slides the clouds by d * W / fov columns', () => {
    const fs = fsFor(), W = fs.W
    const a = new Uint32Array(W * fs.H), b = new Uint32Array(W * fs.H)
    renderSky(fs, a)
    const dCols = 96                                              // turn by 96 columns' worth of angle
    renderSky({ ...fs, player: { ...fs.player, angle: fs.player.angle + (dCols / W) * fs.fov } }, b)
    // pixel (x + dCols) in frame a is (nearly) pixel x in frame b: compare luminance profiles on a few rows
    let num = 0, da = 0, db = 0
    for (const y of [30, 70, 110]) {
      const ra = [], rb = []
      for (let x = 20; x < W - 20 - dCols; x++) { ra.push(lum(px(a, W, x + dCols, y))); rb.push(lum(px(b, W, x, y))) }
      const ma = ra.reduce((s, v) => s + v, 0) / ra.length, mb = rb.reduce((s, v) => s + v, 0) / rb.length
      for (let i = 0; i < ra.length; i++) { num += (ra[i] - ma) * (rb[i] - mb); da += (ra[i] - ma) ** 2; db += (rb[i] - mb) ** 2 }
    }
    expect(num / Math.sqrt(da * db)).toBeGreaterThan(0.97)
    // ...and it is NOT a screen-space texture: with no turn at all, the unshifted frames differ from the shifted ones
    let same = 0, n = 0
    for (let x = 20; x < W - 20; x++) { n++; if (a[60 * W + x] === b[60 * W + x]) same++ }
    expect(same / n).toBeLessThan(0.5)
  })

  it('a full turn (2π) returns the same sky, and the player angle may grow without bound', () => {
    const fs = fsFor(), a = new Uint32Array(fs.W * fs.H), b = new Uint32Array(fs.W * fs.H), c = new Uint32Array(fs.W * fs.H)
    renderSky(fs, a)
    renderSky({ ...fs, player: { ...fs.player, angle: fs.player.angle + 2 * Math.PI * 40 } }, b)
    const diff = a.reduce((s, v, i) => s + (Math.abs((v & 255) - (b[i] & 255)) > 1 ? 1 : 0), 0)
    expect(diff / a.length).toBeLessThan(0.01)                   // (float wrap of 40 turns: at most 1 level of rounding)
    renderSky({ ...fs, player: { ...fs.player, angle: -1234.5 } }, c)
    let opaque = 0
    for (let i = 0; i < (fs.HH + 1) * fs.W; i++) if (c[i] >>> 24 === 255) opaque++
    expect(opaque).toBe((fs.HH + 1) * fs.W)
  })

  it('drifts slowly with time: a minute later the clouds have moved, one frame later they have not (visibly)', () => {
    const fs = fsFor(), W = fs.W
    const a = new Uint32Array(W * fs.H), b = new Uint32Array(W * fs.H), c = new Uint32Array(W * fs.H)
    renderSky(fs, a); renderSky({ ...fs, t: 1 / 60 }, b); renderSky({ ...fs, t: 60 }, c)
    const dist = (u, v) => { let s = 0; for (let i = 0; i < u.length; i += 7) s += Math.abs((u[i] & 255) - (v[i] & 255)); return s / (u.length / 7) }
    expect(dist(a, b)).toBeLessThan(0.05)
    expect(dist(a, c)).toBeGreaterThan(dist(a, b) * 10)
  })

  it('the flicker scalar dims the sky only when no light model is live (daylight does not flicker)', () => {
    const base = fsFor({ flicker: 0.4 })
    const legacyish = new Uint32Array(base.W * base.H), lit = new Uint32Array(base.W * base.H)
    renderSky(base, legacyish)
    renderSky({ ...base, light: { enabled: true } }, lit)
    const a = lum(px(legacyish, base.W, 100, 40)), b = lum(px(lit, base.W, 100, 40))
    expect(a).toBeLessThan(b * 0.5)
    expect(b).toBeGreaterThan(110)
  })

  it('works at any buffer size, including a shrink after a grow (scratch reuse) and tiny frames', () => {
    const big = fsFor(), small = fsFor({ W: 33, H: 21, HH: 10 })
    const bb = new Uint32Array(big.W * big.H), sb = new Uint32Array(33 * 21)
    renderSky(big, bb); renderSky(small, sb); renderSky(big, bb)
    let opaque = 0
    for (let i = 0; i < 11 * 33; i++) if (sb[i] >>> 24 === 255) opaque++
    expect(opaque).toBe(11 * 33)
    const tiny = new Uint32Array(4 * 4)
    expect(() => renderSky(fsFor({ W: 1, H: 1, HH: 0 }), new Uint32Array(1))).not.toThrow()
    expect(() => renderSky(fsFor({ W: 4, H: 4, HH: 9 }), tiny)).not.toThrow()          // horizon pushed below the bottom
    expect(() => renderSky(fsFor({ W: 4, H: 4, HH: -3 }), tiny)).not.toThrow()         // ...or above the top
  })
})
