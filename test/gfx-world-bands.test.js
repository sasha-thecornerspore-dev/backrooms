// The storeys on the CPU: with the level's wallH 3.5 the world pass draws every wall
// slice from a band canvas (gfx-world.js band columns). Pinned here against a REFERENCE that draws every wall pixel on its own, straight
// from the documented arithmetic (no runs, no reused pixels, no clamp skipped), on the legacy shading and every lit tier, level and pitched,
// near and far, with and without the flashlight; and against the 1-cell frame for everything the taller wall must not move: the floor, the
// z-buffer (all the sprites test against), the foot of every wall. wallH 1 and no stackAt draw the old bytes (gfx-hw-perf.test.js).
import { describe, it, expect } from 'vitest'
import { renderWorld, pickBands } from '../src/renderer/gfx-world.js'
import { createLight, buildSurfaceTables, flashAtt, FLASH_PITCH, FLASH_SX, FLASH_SY } from '../src/renderer/gfx-light.js'
import { castRay } from '../src/renderer/raycaster.js'
import { buildFrameState } from '../src/renderer/gfx-frame.js'
import { buildTexturesMemo } from '../src/renderer/gfx-textures.js'
import { levelConfig, LEVELS } from '../src/renderer/levels.js'
import { DEFAULT_CONFIG } from '../src/renderer/world.js'
import { createFixedMap, fixedMapHooks } from '../src/renderer/fixedmap.js'
import { facadeFor } from '../src/renderer/block-stacks.js'
import { hash2, hexToRgb, levelKey } from '../src/renderer/gfx-util.js'
import { qualityFor } from '../src/renderer/gfx-quality.js'

const BLOCK = LEVELS.findIndex((l) => l.id === '∅')
const cfg = levelConfig(DEFAULT_CONFIG, BLOCK)
const map = createFixedMap(cfg.map)
const hooks = fixedMapHooks(map, facadeFor(cfg))
const tex = buildTexturesMemo(cfg.palette, cfg.materials, cfg.look, levelKey(cfg))
const rad = (d) => (d * Math.PI) / 180

function frame(tier, player, o = {}) {
  const q = qualityFor(tier), W = o.W ?? 200, H = o.H ?? 120
  const light = createLight(cfg, hooks)
  const isWall = (wx, wy) => map.isWall(wx, wy)
  const fs = buildFrameState({
    W, H, OW: W, OH: H, fog: cfg.fogDistance, fogRgb: hexToRgb(cfg.palette.fog), fogMul: 1, flicker: 1, frame: 3, timing: { t: 2, dt: 1 / 60 },
    player, lights: o.lights || {}, lightsOn: false, hasSky: true, skyRgb: hexToRgb(cfg.sky), light, quality: q, opts: { qualityTier: tier },
    levelKey: '∅', look: cfg.look, wallH: o.wallH ?? cfg.wallH, stackAt: o.stackAt === undefined ? hooks.stackAt : o.stackAt,
  })
  const buf = new Uint32Array(W * H), z = new Float32Array(W)
  renderWorld(fs, tex, light, isWall, hooks.materialAt, buf, z)
  return { fs, buf, z, light, W, H, isWall }
}

// ── the reference ──
const mipCache = new Map()
function mip(tile, l) {                                              // box-filtered level l at full size (gfx-world.js mipChain)
  if (l === 0) return tile
  const key = tile; let ch = mipCache.get(key); if (!ch) mipCache.set(key, ch = [])
  if (ch[l]) return ch[l]
  const ts = 64, b = 1 << l, n = b * b, d = new Uint8Array(ts * ts * 3)
  for (let by = 0; by < ts; by += b) for (let bx = 0; bx < ts; bx += b) {
    let r = 0, g = 0, bl = 0
    for (let y = 0; y < b; y++) for (let x = 0; x < b; x++) { const i = ((by + y) * ts + bx + x) * 3; r += tile[i]; g += tile[i + 1]; bl += tile[i + 2] }
    r = (r + (n >> 1)) / n | 0; g = (g + (n >> 1)) / n | 0; bl = (bl + (n >> 1)) / n | 0
    for (let y = 0; y < b; y++) for (let x = 0; x < b; x++) { const i = ((by + y) * ts + bx + x) * 3; d[i] = r; d[i + 1] = g; d[i + 2] = bl }
  }
  return (ch[l] = d)
}
const pack = (r, g, b) => (0xff000000 | ((b > 255 ? 255 : b) | 0) << 16 | ((g > 255 ? 255 : g) | 0) << 8 | ((r > 255 ? 255 : r) | 0)) >>> 0
// every wall pixel of the frame, drawn one at a time: Map(index -> packed pixel)
function reference(f) {
  const { fs, W, H, light, isWall } = f
  const { HH, fog, player, fov: FOV, hf: HF, quality } = fs
  const HC = fs.HC ?? HH
  const lit = light.enabled === true, F = light.frame
  const TS = 64, TMASK = 63, NB = Math.ceil(fs.wallH), VMAX = NB * TS - 1, up = fs.wallH - 1
  const rayMax = Math.min(96, Math.ceil(fog) + 3)
  const out = new Map(), BT = [null, null, null, null]
  for (let col = 0; col < W; col++) {
    const angle = player.angle - HF + (col / W) * FOV
    const hit = castRay(player.x, player.y, angle, isWall, rayMax)
    const corr = hit.dist * Math.cos(angle - player.angle)
    const whF = H / Math.max(0.001, corr), wtF = HH - whF / 2
    const y0 = Math.max(0, Math.ceil(wtF - whF * up)), y1 = Math.min(H, Math.floor(wtF + whF))
    if (y1 <= y0) continue
    const wtC = wtF - whF * (NB - 1), invWh = TS / whF
    const mat = hooks.materialAt(hit.mx + 0.5, hit.my + 0.5), wkey = mat && tex.walls[mat] ? mat : '0'
    let one = tex.walls[wkey]
    const arr = tex.wallVar && tex.wallVar[wkey]
    if (arr && arr.length > 1) one = arr[hash2(hit.mx, hit.my, hit.side) % arr.length]
    pickBands(tex.wallBands, wkey, fs.stackAt ? fs.stackAt(hit.mx, hit.my, hit.side) : -1, hit.mx, hit.my, hit.side, one, BT)
    const distF = Math.min(1, corr / fog), sideMul = hit.side === 1 ? 0.72 : 1
    const tcol = Math.min(TMASK, (hit.wallX * TS) | 0)
    if (!lit) {
      const fl = fs.flicker, a = sideMul * (1 - distF) * fl, fr = fs.fogRgb
      const wR = fr[0] * distF * fl, wG = fr[1] * distF * fl, wB = fr[2] * distF * fl
      for (let y = y0; y < y1; y++) {
        let V = ((y - wtC) * invWh) | 0; if (V > VMAX) V = VMAX
        const T = BT[NB - 1 - (V >> 6)], ti = (V & TMASK) * TS * 3 + tcol * 3
        out.set(y * W + col, pack(T[ti] * a + wR, T[ti + 1] * a + wG, T[ti + 2] * a + wB))
      }
      continue
    }
    // the lit shading (renderLit / bandColumnLit): Level ∅ is daylight with no pool range, so its walls take no pool (pw 0)
    expect(F.poolRange).toBe(0)
    const gdip = F.gdip, fk = F.fogGain * gdip, F0 = fs.fogRgb[0] * fk, F1 = fs.fogRgb[1] * fk, F2 = fs.fogRgb[2] * fk
    const a = sideMul * (1 - distF) * gdip, fw = distF * (F.fogBase + 0)
    const wR = F0 * fw * 1, wG = F1 * fw * 1, wB = F2 * fw * 1
    const filt = quality.texFilter >= 1, near = filt && (quality.texFilter >= 2 || quality.lightDetail >= 2)
    const stepCol = FOV / W * TS
    let m = 0
    if (filt) { const fp = Math.max(TS / whF, corr * stepCol) * 1.4; m = fp > 1 ? Math.min(3, Math.max(0, Math.floor(Math.log2(fp)))) : 0 }
    let nearW = false, nb = tcol, nw = 0
    if (near && m === 0 && corr * stepCol < 0.17) { const fr = hit.wallX * TS - tcol - 0.5; nearW = true; nb = fr < 0 ? (tcol > 0 ? tcol - 1 : tcol) : (tcol < TMASK ? tcol + 1 : tcol); nw = fr < 0 ? -fr : fr }
    const kaR = a * F.atR, kaG = a * F.atG, kaB = a * F.atB, kpR = a * F.tR, kpG = a * F.tG, kpB = a * F.tB
    let dkR = 0, dkG = 0, dkB = 0
    if (F.flash) {
      const an = ((col + 0.5) / W - 0.5) * FOV, sx = Math.fround(Math.exp(-(an * an) / (FLASH_SX * FLASH_SX)))
      const fCol = F.flashK * sx * flashAtt(corr), wk = sideMul * (1 - distF)
      dkR = wk * 1.0 * fCol; dkG = wk * 0.93 * fCol; dkB = wk * 0.76 * fCol
    }
    for (let y = y0; y < y1; y++) {
      let V = ((y - wtC) * invWh) | 0; if (V > VMAX) V = VMAX
      const T = mip(BT[NB - 1 - (V >> 6)], m), ti = (V & TMASK) * TS * 3 + tcol * 3
      let c0 = T[ti], c1 = T[ti + 1], c2 = T[ti + 2]
      if (nearW) { const tj = (V & TMASK) * TS * 3 + nb * 3; c0 = (c0 + (T[tj] - c0) * nw + 0.5) | 0; c1 = (c1 + (T[tj + 1] - c1) * nw + 0.5) | 0; c2 = (c2 + (T[tj + 2] - c2) * nw + 0.5) | 0 }
      let r, g, b
      if (F.flash) {
        const dv = (y - HC) / H - FLASH_PITCH, sy = Math.fround(Math.exp(-(dv * dv) / (FLASH_SY * FLASH_SY)))
        const wa = F.bandAmb[V], wp = F.bandPool[V]
        r = c0 * ((kaR * wa + kpR * wp) + dkR * sy + 0) + wR; g = c1 * ((kaG * wa + kpG * wp) + dkG * sy + 0) + wG; b = c2 * ((kaB * wa + kpB * wp) + dkB * sy + 0) + wB
      } else if (F.single) {
        const L = F.bandLit[V]
        r = c0 * (kpR * L) + wR; g = c1 * (kpG * L) + wG; b = c2 * (kpB * L) + wB
      } else {
        const wa = F.bandAmb[V]
        r = c0 * (kaR * wa) + wR; g = c1 * (kaG * wa) + wG; b = c2 * (kaB * wa) + wB
      }
      out.set(y * W + col, pack(r, g, b))
    }
  }
  return out
}

const POSES = [
  { name: 'the yard (the bench pose)', x: 12.5, y: 13.0, a: 90, pitch: 0 },
  { name: 'up against the south row (texel runs)', x: 6.5, y: 15.6, a: 80, pitch: 0 },
  { name: 'looking up at a vacant house', x: 15.5, y: 4.0, a: -90, pitch: 0.3 },
  { name: 'the J-east stoop', x: 16.5, y: 14.0, a: -90, pitch: -0.1 },
  { name: 'across the yard to the corner', x: 3.2, y: 15.1, a: -40, pitch: 0.12 },
]

describe('the band columns draw what the reference draws, pixel for pixel', () => {
  for (const tier of ['legacy', 'low', 'medium', 'high']) {
    for (const p of POSES) {
      for (const lights of [{}, { flashlight: true }]) {
        if (tier === 'legacy' && lights.flashlight) continue
        it(`${tier}, ${p.name}${lights.flashlight ? ', the flashlight on' : ''}`, () => {
          const f = frame(tier, { x: p.x, y: p.y, angle: rad(p.a), bobOffset: 0, pitch: p.pitch }, { lights })
          expect(f.light.enabled).toBe(tier !== 'legacy')
          const ref = reference(f)
          expect(ref.size).toBeGreaterThan(f.W * 10)
          let bad = 0, first = null
          for (const [i, v] of ref) if ((f.buf[i] >>> 0) !== v) { bad++; first = first ?? [i % f.W, (i / f.W) | 0, (f.buf[i] >>> 0).toString(16), v.toString(16)] }
          expect(bad, `first differing wall pixel ${JSON.stringify(first)}`).toBe(0)
        }, 60000)
      }
    }
  }
})

describe('the taller wall moves nothing but its top', () => {
  for (const tier of ['legacy', 'high']) {
    it(`${tier}: the z-buffer, the floor and the foot of every wall are the 1-cell frame's; the walls only cover more sky`, () => {
      for (const p of POSES) {
        const player = { x: p.x, y: p.y, angle: rad(p.a), bobOffset: 0, pitch: p.pitch }
        const tall = frame(tier, player), short = frame(tier, player, { wallH: 1, stackAt: null })
        expect(Buffer.from(tall.z.buffer).equals(Buffer.from(short.z.buffer))).toBe(true)        // the sprites test against exactly this
        const { W, H } = tall, HH = tall.fs.HH
        let floor = 0, more = 0
        for (let x = 0; x < W; x++) {
          const whF = H / Math.max(0.001, tall.z[x])
          for (let y = 0; y < H; y++) {
            const i = y * W + x, inShort = y >= Math.ceil(HH - whF / 2) && y < Math.floor(HH + whF / 2)
            if (y > HH && !inShort && y >= Math.floor(HH + whF / 2) + 1) { floor++; expect(tall.buf[i]).toBe(short.buf[i]) }      // the floor
            if (y < HH - whF / 2 - 1 && tall.buf[i] !== short.buf[i]) more++
          }
        }
        expect(floor).toBeGreaterThan(0)
        expect(more).toBeGreaterThan(0)
      }
    })
  }
  it('every wall reaches 3.5 cells: the first wall row is the canvas row (NB - wallH) · TS = 32 (castColumns and the bands agree)', () => {
    const f = frame('high', { x: 12.5, y: 13.0, angle: rad(90), bobOffset: 0, pitch: 0 })
    const { W, H, fs } = f
    for (let x = 0; x < W; x += 7) {
      const whF = H / Math.max(0.001, f.z[x]), top = fs.HH - whF / 2 - 2.5 * whF
      if (top <= 1) continue
      const y0 = Math.ceil(top)
      expect(Math.floor((y0 - (fs.HH - whF / 2 - 3 * whF)) * 64 / whF)).toBeGreaterThanOrEqual(32)
    }
  })
})

describe('the wall light over the band canvas (gfx-light.js buildSurfaceTables(s, ts, wallH, open))', () => {
  const light = createLight(cfg, hooks), S = light.recipe
  it('at the defaults the tables are what they always were', () => {
    const a = buildSurfaceTables(S, 64), b = buildSurfaceTables(S, 64, 1, false)
    for (const k of ['wallPool', 'wallAmb', 'wallLit', 'aoFloor', 'aoCeil']) expect(Buffer.from(b[k].buffer).equals(Buffer.from(a[k].buffer))).toBe(true)
    expect(a.wallAmb.length).toBe(64)
  })
  it('a 3.5-cell open wall: ts · 4 rows, the 1-cell profile over the ground storey, 1.10 above it, no contact at the top', () => {
    const t = buildSurfaceTables(S, 64, 3.5, true), one = buildSurfaceTables(S, 64)
    expect(t.rows).toBe(256); expect(t.wallAmb.length).toBe(256); expect(t.wallLit.length).toBe(64 * 256)
    // the bottom band (canvas rows 192..255) keeps the 1-cell wall's foot (its contact term) and Va = 0.80 + 0.30 z, without the top term
    for (let r = 0; r < 64; r++) {
      const z = 1 - (r + 0.5) / 64, C = 1 - S.contact * 0.3 * Math.exp(-z / 0.09)
      expect(t.wallAmb[192 + r]).toBeCloseTo(S.ambient * (0.8 + 0.3 * z) * C, 6)
      if (z < 0.5) expect(t.wallAmb[192 + r]).toBeCloseTo(one.wallAmb[r], 3)
    }
    for (let r = 32; r < 190; r++) expect(t.wallAmb[r]).toBeCloseTo(S.ambient * 1.1, 5)           // above the first cell: 1.10, no top band (float32)
  })
  it('the light model builds the band tables the first frame that draws a taller wall, and keeps the 1-cell ones', () => {
    const f = frame('high', { x: 12.5, y: 13.0, angle: rad(90), bobOffset: 0, pitch: 0 })
    const F = f.light.frame
    expect(F.bandRows).toBe(256); expect(F.bandAmb.length).toBe(256); expect(F.wallAmb.length).toBe(64)
  })
})
