// Track HW, stage 2: renderSky skips its per-channel clamps on a row whose every block provably stays inside a byte (the cloud term's
// range, pushed through the same monotonic arithmetic). The sky must come out byte-identical to the frozen reference (test/gfx-hw-ref/)
// for any frame: angles, times, horizons, odd widths, a wall cover row, and a look.sky override loud enough to need the clamps.
import { describe, it, expect } from 'vitest'
import { renderSky } from '../src/renderer/gfx-sky.js'
import { renderSky as refRenderSky } from './gfx-hw-ref/gfx-sky.js'

function rng(seed) { let s = seed >>> 0; return () => { s = (s + 0x6d2b79f5) >>> 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 } }

describe('renderSky with clamp-free rows draws what the reference draws', () => {
  it('random frames, stock and extreme sky looks, with and without a cover row', () => {
    const r = rng(0x51c7)
    const looks = [undefined, { sky: { amp: 0.9, ampB: 1.4 } }, { sky: { amp: 2.5, ampB: -0.8, glow: 0.6 } }, { sky: { amp: 0.1, ampB: 0.42, band: 0.3 } }]
    let frames = 0
    for (let n = 0; n < 160; n++) {
      const W = 7 + ((r() * 300) | 0), H = 5 + ((r() * 200) | 0)
      const HH = ((r() * 1.4 - 0.2) * H) | 0
      const bright = n % 3 === 0
      const fs = {
        W, H, HH, skyRgb: bright ? [250, 252, 255] : [185, 183, 174], fogRgb: bright ? [255, 240, 230] : [150, 150, 146],
        flicker: n % 5 === 0 ? 1.7 : 1, t: r() * 5000, hf: 0.4 + r() * 0.5, player: { angle: (r() - 0.5) * 40 },
        levelKey: n % 2 ? '∅' : 'x', look: looks[n % looks.length], quality: { lightDetail: 1 }, light: null,
      }
      let cover = null
      if (n % 4 === 1) { cover = new Int32Array(W); for (let x = 0; x < W; x++) cover[x] = r() < 0.5 ? -(H + 2) : 1 - ((r() * H) | 0) }
      const a = new Uint32Array(W * H), b = new Uint32Array(W * H)
      renderSky({ ...fs }, a, cover)
      refRenderSky({ ...fs }, b)                  // (the reference predates the cover row: it fills every sky pixel)
      // pixel (x, y) is covered by a wall exactly when -y < cover[x]: the wall pass draws it, so only the others must agree
      let bad = -1
      for (let y = 0; y < H && bad < 0; y++) for (let x = 0; x < W; x++) if (!(cover && -y < cover[x]) && a[y * W + x] !== b[y * W + x]) { bad = y * W + x; break }
      expect(bad, `frame ${n}: ${W}x${H} HH ${HH}: first differing pixel`).toBe(-1)
      frames++
    }
    expect(frames).toBe(160)
  })
})
