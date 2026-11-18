// gfx-sprites.js — Level ∅'s yard props in its Harlem Park look (PROP_HP, propArtName):
// bulging black contractor bags with tied necks and torn litter, a car tire with tread blocks on a dull steel rim, tree-of-heaven seedlings
// and grass in a dirt clump, a wet crushed carton.
//   * the gate: the block's art only on a level whose look is { facade: 'harlem' }, only for its four yard types; 'box' is Level 0's and
//     Level 1's too, so their art (and the block's without the look) keeps its bytes, pinned here from main (2e66b96)
//   * only the art changes: the variant pick, mirror, tint, scale, lean, sway and the ground shadow stay the type's (planProp), on the CPU
//     plan and on the GPU planner built from it; the warm queue and prewarm ask for the art the level will draw
//   * the art: deterministic, premultiplied, inside the type's own canvas, and it means what it should (black poly with a sheen, dark rubber
//     on grey steel, green leaflets over dirt, wet kraft card); none of it is the boards' crew-mark orange
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createHash } from 'node:crypto'
import {
  PROP_SPEC, PROP_HP, propArtName, getFrame, resetAtlas, planSprites, prewarmSprites, warmQueue, variantHash,
} from '../src/renderer/gfx-sprites.js'
import { createSpritePlanner } from '../src/renderer/gfx-gl-sprites-plan.js'
import { LEVELS, levelConfig } from '../src/renderer/levels.js'
import { DEFAULT_CONFIG } from '../src/renderer/world.js'

vi.setConfig({ testTimeout: 60000 })

const TYPES = ['trash', 'tire', 'weeds', 'box']
const LOOK = { facade: 'harlem', floor: 'yard' }
const NULL_IX = LEVELS.findIndex((l) => l.id === '∅')
const FOV = Math.PI / 2.4
const frameSha = (fr) => {
  const h = createHash('sha256')
  for (const l of fr.layers) {
    h.update(JSON.stringify([l.x0, l.x1, l.y0, l.y1, l.mode, l.emit, l.fogK, l.floor, l.rimK, l.alpha]))
    for (const m of l.mips) { h.update(JSON.stringify([m.w, m.h])); h.update(Buffer.from(m.px.buffer, m.px.byteOffset, m.px.byteLength)) }
  }
  return h.digest('hex')
}
// the opaque texels of a frame's top mip, un-premultiplied, with their row from the bottom (0 = the floor row)
function texels(fr) {
  const m = fr.layers[0].mips[0], out = []
  for (let y = 0; y < m.h; y++) for (let x = 0; x < m.w; x++) {
    const p = m.px[y * m.w + x], a = p >>> 24
    if (a < 200) continue
    const r = ((p & 255) * 255) / a, g = (((p >>> 8) & 255) * 255) / a, b = (((p >>> 16) & 255) * 255) / a
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b)
    out.push({ r, g, b, x, y, up: m.h - 1 - y, h: m.h, w: m.w, lum: 0.299 * r + 0.587 * g + 0.114 * b, sat: mx > 0 ? (mx - mn) / mx : 0 })
  }
  return out
}
const mean = (a, f) => a.reduce((s, t) => s + f(t), 0) / a.length
const pct = (a, f, q) => { const s = a.map(f).sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(q * s.length))] }
const mkFs = (over = {}) => ({
  W: 320, H: 180, HH: 90, fog: 16, fogRgb: [154, 150, 140], flicker: 1, t: 1.3, dt: 1 / 60, hf: FOV / 2, fov: FOV,
  player: { x: 0, y: 0, angle: 0 }, opts: {}, lights: {}, comfort: {}, levelKey: '∅', look: LOOK, light: null, handled: {}, ...over,
})
// under a frozen clock no frame is ever deferred past the generation budget: what is in view is drawn
const frozen = (fn) => { const spy = vi.spyOn(performance, 'now').mockReturnValue(0); try { return fn() } finally { spy.mockRestore() } }
const recsOf = (fs, ents) => frozen(() => { planSprites(fs, ents); const P = planSprites(fs, ents); return P.recs.slice(0, P.count).map((r) => ({ ...r })) })
// a rot that draws variant v (planProp: variantHash % 3), mirrored or not
const rotFor = (v, mirror = false) => { for (let i = 1; ; i++) { const r = i * 0.0137, vh = variantHash(r); if (vh % 3 === v && !!(vh & 0x100) === mirror) return r } }

describe('the gate: the block\'s own art, only in its Harlem Park look', () => {
  it('PROP_HP names an art for exactly the four yard types; PROP_SPEC is untouched', () => {
    expect(Object.keys(PROP_HP).sort()).toEqual([...TYPES].sort())
    for (const t of TYPES) expect(PROP_HP[t]).toBe(t + '-hp')
    for (const k of Object.keys(PROP_SPEC)) expect(k.endsWith('-hp'), k).toBe(false)
    expect(Object.keys(PROP_SPEC)).toHaveLength(23)
  })

  it('propArtName: the block\'s art with look.facade \'harlem\', the type\'s own otherwise, and never for another type', () => {
    for (const t of TYPES) {
      expect(propArtName(t, LOOK)).toBe(PROP_HP[t])
      expect(propArtName(t, { facade: 'harlem' })).toBe(PROP_HP[t])
      for (const look of [undefined, null, {}, { floor: 'yard' }, { facade: 'other' }]) expect(propArtName(t, look)).toBe(t)
    }
    for (const t of Object.keys(PROP_SPEC)) if (!TYPES.includes(t)) expect(propArtName(t, LOOK)).toBe(t)
  })

  it('only the block carries the look: every other floor draws every prop type with the art it always had', () => {
    expect(levelConfig(DEFAULT_CONFIG, NULL_IX).look.facade).toBe('harlem')
    for (let k = 0; k < LEVELS.length; k++) {
      if (k === NULL_IX) continue
      const cfg = levelConfig(DEFAULT_CONFIG, k)
      for (const t of (cfg.props && cfg.props.types) || []) expect(propArtName(t, cfg.look), `level ${LEVELS[k].id} ${t}`).toBe(t)
    }
  })

  it('the legacy art keeps its bytes: the four types\' twelve frames are main\'s (2e66b96), whatever the block has drawn', () => {
    // sha256 of each frame's layer rects and every mip's texels, from main before this art existed
    const PIN = {
      trash: ['51751c5ac40c62375b19256a7ce84d324d8d689192a50499978c18ccb7287bb8', 'dfaaa2758e05aaae5aa4c65801cfc19954784e71bfe420b9320aa4c301e92189', 'a3e61e8f3b9a68fc298fb7cfbe07cbabcdd614cdf98e992514a56e815161c6c2'],
      tire: ['6579973a97dba977efe7141b424a48d2bcbc6a2fc13e8fb9b57508e2350768f6', '72c855cd2d5ce778b42091a6cb7d1916abb291df232668995290010de6952eb4', '19e42ee58d7108e650f33e2165869e0d44a1afad72f7bd2df31d943cc3e8a36e'],
      weeds: ['520fee40c8e3d6afb935540075b292c6b7152c02ec5edb1a92a4e421ecc77506', '462a97724f4e9750e5ce500e1e573f341b1599df149644b36d50200305370da6', '46b115b815052808114001a78b9b1ebc958da229050e422edb7b72dbafa20432'],
      box: ['ff6b3da4a0e3aa0ee1bc7a9cf674c42e1c7e1bd5b4a090ea04c0778ca50a0035', '436479376331917d4d54eb91423a37cf13d7f0542d0f3ff1db2ec2f1b0df6821', 'dcba9e980e418dd102ce9a0ef2f2ec7fe4ed75f44edbd3f837bdca21f0d170ae'],
    }
    resetAtlas()
    for (const t of TYPES) for (let v = 0; v < 3; v++) getFrame('prop', PROP_HP[t], v)         // the block's first
    for (const t of TYPES) for (let v = 0; v < 3; v++) expect(frameSha(getFrame('prop', t, v)), `${t} v${v}`).toBe(PIN[t][v])
  })
})

describe('only the art changes: the instance is still the type\'s', () => {
  beforeEach(() => resetAtlas())

  it('the CPU plan draws the block\'s frame on the block in its look, the type\'s without it; shadow, depth, tint, mirror, lean and sway are the same', () => {
    for (const t of TYPES) {
      for (const [v, mirror] of [[0, false], [1, true], [2, false]]) {
        const ent = { kind: 'prop', type: t, x: 2.4, y: 0.3, rot: rotFor(v, mirror), key: 'p' }
        const hp = recsOf(mkFs(), [ent]), legacy = recsOf(mkFs({ look: undefined }), [ent]), lobby = recsOf(mkFs({ levelKey: '0', look: undefined }), [ent])
        const body = (recs) => recs.filter((r) => !r.shadow)
        const shadow = (recs) => recs.filter((r) => r.shadow)
        expect(body(hp).map((r) => r.lay), `${t} v${v}`).toEqual([getFrame('prop', PROP_HP[t], v).layers[0]])
        expect(body(legacy).map((r) => r.lay)).toEqual([getFrame('prop', t, v).layers[0]])
        expect(body(lobby).map((r) => r.lay)).toEqual([getFrame('prop', t, v).layers[0]])
        expect(shadow(hp)).toEqual(shadow(legacy))                                                 // the ground shadow: the envelope's
        const keep = (r) => ({ depth: r.depth, mirror: r.mirror, A: r.A, mr: r.mr, mg: r.mg, mb: r.mb, lean: r.lean, swayA: r.swayA, swayP: r.swayP, rim: r.rim })
        expect(body(hp).map(keep)).toEqual(body(legacy).map(keep))
        if (t === 'weeds') expect(body(hp)[0].swayA).toBeGreaterThan(0)                            // the weeds still move in the wind
        if (t === 'tire') expect(body(hp)[0].lean).not.toBe(0)                                      // and a tire still leans
      }
    }
  })

  it('an unknown type falls back to the box, and on the block to the block\'s box', () => {
    const ent = { kind: 'prop', type: 'no-such-thing', x: 2.4, y: 0, rot: rotFor(1), key: 'u' }
    expect(recsOf(mkFs(), [ent]).filter((r) => !r.shadow).map((r) => r.lay)).toEqual([getFrame('prop', 'box-hp', 1).layers[0]])
    expect(recsOf(mkFs({ look: undefined }), [ent]).filter((r) => !r.shadow).map((r) => r.lay)).toEqual([getFrame('prop', 'box', 1).layers[0]])
  })

  it('the GPU planner (built on the same plan) uploads the block\'s mips on the block and the type\'s elsewhere', () => {
    const atlas = () => { const m = new Map(); return { m, rectFor(mip) { let r = m.get(mip); if (!r) { r = { x: 1, y: 1, w: mip.w, h: mip.h, rim: !!mip.rim }; m.set(mip, r) } return r } } }
    for (const t of TYPES) {
      const ent = { kind: 'prop', type: t, x: 2.4, y: 0, rot: rotFor(2), key: 'g' }
      const run = (fs) => frozen(() => { const a = atlas(), pl = createSpritePlanner(a); pl.plan(fs, [ent]); pl.plan(fs, [ent]); return a.m })
      const mipsOf = (name) => new Set(getFrame('prop', name, 2).layers[0].mips)
      const onBlock = [...run(mkFs()).keys()], elsewhere = [...run(mkFs({ levelKey: '1', look: undefined })).keys()]
      expect(onBlock.some((m) => mipsOf(PROP_HP[t]).has(m)), t).toBe(true)
      expect(onBlock.some((m) => mipsOf(t).has(m)), t).toBe(false)
      expect(elsewhere.some((m) => mipsOf(t).has(m)), t).toBe(true)
      expect(elsewhere.some((m) => mipsOf(PROP_HP[t]).has(m)), t).toBe(false)
    }
  })

  it('prewarm and the warm queue ask for the art the level will draw', () => {
    const block = levelConfig(DEFAULT_CONFIG, NULL_IX), lobby = levelConfig(DEFAULT_CONFIG, 0)
    const propJobs = () => warmQueue().filter((j) => j[0] === 'prop').map((j) => j[1])
    resetAtlas(); prewarmSprites(block, 0)
    const fromConfig = propJobs()
    for (const t of TYPES) { expect(fromConfig, t).toContain(PROP_HP[t]); expect(fromConfig, t).not.toContain(t) }
    resetAtlas(); prewarmSprites({ ...block, look: undefined }, 0)
    for (const t of TYPES) { expect(propJobs(), t).toContain(t); expect(propJobs(), t).not.toContain(PROP_HP[t]) }
    resetAtlas(); prewarmSprites(lobby, 0)
    expect(propJobs()).toContain('box'); expect(propJobs()).not.toContain('box-hp')
    // a renderer that never prewarmed: the first draw queues the level's built-in list, in the look it draws
    resetAtlas(); frozen(() => planSprites(mkFs(), [{ kind: 'prop', type: 'box', x: 50, y: 0, rot: 0, key: 'far' }]))
    for (const t of TYPES) expect(propJobs(), t).toContain(PROP_HP[t])
    resetAtlas(); frozen(() => planSprites(mkFs({ levelKey: '0', look: undefined }), [{ kind: 'prop', type: 'box', x: 50, y: 0, rot: 0, key: 'far' }]))
    expect(propJobs()).toContain('box'); expect(propJobs()).not.toContain('box-hp')
  })
})

describe('the block\'s art', () => {
  it('is deterministic, premultiplied, one lit layer, and stays inside the type\'s own canvas', () => {
    resetAtlas()
    const first = TYPES.flatMap((t) => [0, 1, 2].map((v) => frameSha(getFrame('prop', PROP_HP[t], v))))
    resetAtlas()
    const second = TYPES.flatMap((t) => [0, 1, 2].map((v) => frameSha(getFrame('prop', PROP_HP[t], v))))
    expect(second).toEqual(first)
    expect(new Set(first).size).toBe(12)                                                          // twelve different pictures
    for (const t of TYPES) {
      const sp = PROP_SPEC[t], PPU = 136, padX = Math.max(3, Math.round(0.05 * PPU))
      const fw = Math.round(sp.w * PPU) + padX * 2, fh = Math.round(sp.h * PPU) + 6
      for (let v = 0; v < 3; v++) {
        const fr = getFrame('prop', PROP_HP[t], v), L = fr.layers[0], m = L.mips[0]
        expect(fr.layers).toHaveLength(1)
        expect([L.mode, L.emit, L.rimK, L.floor]).toEqual([0, 0, 0, false])
        expect(frameSha(fr)).not.toBe(frameSha(getFrame('prop', t, v)))
        expect(L.x0).toBeGreaterThanOrEqual(-(fw / 2) / PPU - 1e-9); expect(L.x1).toBeLessThanOrEqual(fw / 2 / PPU + 1e-9)
        expect(L.y0).toBeGreaterThanOrEqual(-3 / PPU - 1e-9); expect(L.y1).toBeLessThanOrEqual((fh - 3) / PPU + 1e-9)
        let opaque = 0
        for (const p of m.px) {
          const a = p >>> 24
          if ((p & 255) > a + 1 || ((p >> 8) & 255) > a + 1 || ((p >> 16) & 255) > a + 1) expect.fail(`${t} v${v}: not premultiplied`)
          if (a > 200) opaque++
        }
        expect(opaque, `${t} v${v}`).toBeGreaterThan(300)
      }
    }
  })

  it('policy: no texel of it is the boards\' crew-mark orange', () => {
    for (const t of TYPES) for (let v = 0; v < 3; v++) {
      const hot = texels(getFrame('prop', PROP_HP[t], v)).filter((q) => q.r > 150 && q.g > 60 && q.g < 140 && q.b < 80 && q.r - q.b > 110)
      expect(hot.length, `${t} v${v}`).toBe(0)
    }
  })

  it('trash: black poly bags with a sheen, never brown; pale litter on the ground', () => {
    for (let v = 0; v < 3; v++) {
      const T = texels(getFrame('prop', 'trash-hp', v)), bag = T.filter((q) => q.lum < 100)
      expect(pct(T, (q) => q.lum, 0.5), `v${v}`).toBeLessThan(50)                                 // black
      expect(pct(T, (q) => q.lum, 0.97), `v${v}`).toBeGreaterThan(75)                             // with a sheen (and the litter)
      expect(mean(bag, (q) => q.b - q.r), `v${v}`).toBeGreaterThanOrEqual(0)                      // cool, not brown: bags, not animals
      expect(T.filter((q) => q.up <= 4 && q.lum > 95 && q.sat < 0.25).length, `v${v}`).toBeGreaterThan(2)   // litter at their feet
    }
  })

  it('tire: dark rubber; standing or leaning, a dull grey steel wheel in it', () => {
    for (let v = 0; v < 3; v++) {
      const T = texels(getFrame('prop', 'tire-hp', v))
      expect(pct(T, (q) => q.lum, 0.5), `v${v}`).toBeLessThan(45)
      if (v === 2) continue                                                                       // lying flat, the wheel is down in the bead
      const steel = T.filter((q) => q.lum > 55 && q.lum < 150 && q.sat < 0.2 && Math.abs(q.x - q.w / 2) < q.w * 0.3 && Math.abs(q.up - q.h / 2) < q.h * 0.3)
      expect(steel.length, `v${v}`).toBeGreaterThan(40)
      expect(pct(steel, (q) => q.lum, 0.9), `v${v}`).toBeLessThan(150)                           // dull, not chrome
    }
  })

  it('weeds: green leaflets over a clump of dirt', () => {
    for (let v = 0; v < 3; v++) {
      const T = texels(getFrame('prop', 'weeds-hp', v))
      expect(T.filter((q) => q.g > q.r + 6 && q.g > q.b + 12).length, `v${v}`).toBeGreaterThan(v === 2 ? 15 : 60)
      const dirt = T.filter((q) => q.up >= 3 && q.up <= 5)                                         // (below it the clump thins into the ground)
      expect(dirt.length, `v${v}`).toBeGreaterThan(30)
      expect(mean(dirt, (q) => q.r - q.b), `v${v}`).toBeGreaterThan(8)                            // brown earth at the foot
    }
  })

  it('box: kraft card, wet from the ground up (its foot darker than its middle)', () => {
    for (let v = 0; v < 3; v++) {
      const T = texels(getFrame('prop', 'box-hp', v))
      expect(mean(T, (q) => q.r) > mean(T, (q) => q.g) && mean(T, (q) => q.g) > mean(T, (q) => q.b), `v${v}`).toBe(true)
      const top = Math.max(...T.map((q) => q.up)), foot = T.filter((q) => q.up >= 1 && q.up <= top * 0.18), mid = T.filter((q) => q.up >= top * 0.45 && q.up <= top * 0.7)
      expect(mean(foot, (q) => q.lum), `v${v}`).toBeLessThan(mean(mid, (q) => q.lum) * 0.85)
    }
  })
})
