// Fixer S (review of graphics M1): sprite light tint vs emissive layers (SPR-01/W1), the double flicker (SPR-02), the warm
// queue (SPR-03), the sprite cap (SPR-05), motion records and unknown kinds (SPR-06), and the shared TexSet memo (W7).
import { describe, it, expect, beforeEach } from 'vitest'
import { drawSprites, resetAtlas, atlasStats, getFrame, prewarmSprites, motionProbe } from '../src/renderer/gfx-sprites.js'
import { buildTexturesMemo, buildTextures, texturesMemoSize, clearTexturesMemo } from '../src/renderer/gfx-textures.js'

const FOV = Math.PI / 2.4
const GREY = ((255 << 24) | (100 << 16) | (100 << 8) | 100) >>> 0
function scene(over = {}) {
  const W = 200, H = 120
  const buf = new Uint32Array(W * H).fill(GREY)
  const z = new Float32Array(W).fill(60)
  const fs = {
    W, H, HH: H >> 1, fog: 30, fogRgb: [100, 100, 100], flicker: 1, t: 0.4, dt: 1 / 60, hf: FOV / 2, fov: FOV,
    player: { x: 0, y: 0, angle: 0 }, opts: {}, lights: {}, levelKey: 'test', ...over,
  }
  return { W, H, buf, z, fs }
}
const lightOf = (tint, at = 1) => ({ enabled: true, at: () => at, tint: () => tint, nearest: () => null })
const px = (p) => [p & 255, (p >> 8) & 255, (p >> 16) & 255]
const meanOf = (S, pred) => {
  let n = 0, r = 0, g = 0, b = 0
  for (let y = 0; y < S.H; y++) for (let x = 0; x < S.W; x++) {
    const p = S.buf[y * S.W + x]
    if (p === GREY || !pred(x, y)) continue
    const c = px(p); r += c[0]; g += c[1]; b += c[2]; n++
  }
  return { n, r: r / (n || 1), g: g / (n || 1), b: b / (n || 1) }
}
const total = (m) => m.r + m.g + m.b
const exitAt = (d) => ({ kind: 'exit', x: d, y: 0, key: 'e' })
const propAt = (d, lat = 0, type = 'crate') => ({ kind: 'prop', type, x: d, y: lat, rot: 5.6, key: 'k' + d + '_' + lat })

describe('SPR-01 / W1: emissive layers keep their own colour under the scene light tint', () => {
  beforeEach(() => resetAtlas())

  it('the exit beam stays cold (b >= r) under an amber lamp tint and under daylight amber', () => {
    for (const tint of [[1, 0.57, 0.23], [1, 0.75, 0.43]]) {
      const S = scene({ light: lightOf(tint) })
      drawSprites(S.buf, S.z, S.fs, [exitAt(5)])
      // the beam is the tall column above the portal body: rows well above the horizon
      const beam = meanOf(S, (x, y) => y < S.H / 2 - 22)
      expect(beam.n, 'beam pixels drawn').toBeGreaterThan(8)
      expect(beam.b, JSON.stringify(tint)).toBeGreaterThanOrEqual(beam.r)
    }
  })

  it('an amber tint still warms a non-emissive prop (the light model keeps working)', () => {
    const S = scene({ light: lightOf([1, 0.57, 0.23]) })
    drawSprites(S.buf, S.z, S.fs, [propAt(4)])
    const m = meanOf(S, () => true)
    expect(m.r).toBeGreaterThan(m.b)
  })

  it('a neutral tint leaves the exit as the legacy path draws it', () => {
    const a = scene({ light: lightOf([1, 1, 1]) }); drawSprites(a.buf, a.z, a.fs, [exitAt(5)])
    const b = scene(); drawSprites(b.buf, b.z, b.fs, [exitAt(5)])
    expect(meanOf(a, () => true).b).toBeCloseTo(meanOf(b, () => true).b, 0)
  })
})

describe('SPR-02: no second flicker dip once the light model carries it', () => {
  beforeEach(() => resetAtlas())
  const lit = (flicker, over) => { const S = scene({ flicker, ...over }); drawSprites(S.buf, S.z, S.fs, [propAt(4, 0, 'cabinet')]); return meanOf(S, () => true) }

  it('legacy path: the sprite dims with fs.flicker', () => {
    expect(total(lit(0.4, {}))).toBeLessThan(total(lit(1, {})) * 0.85)
  })
  it('lit tier (light.enabled): fs.flicker does not dim the sprite again', () => {
    const L = lightOf([1, 1, 1])
    expect(total(lit(0.4, { light: L }))).toBeCloseTo(total(lit(1, { light: L })), 0)
  })
  it('handled.flicker alone is enough', () => {
    expect(total(lit(0.4, { handled: { flicker: true } }))).toBeCloseTo(total(lit(1, { handled: { flicker: true } })), 0)
  })
  it('the fog colour is not scaled by the flicker at lit tiers either', () => {
    const far = (flicker) => { const S = scene({ flicker, light: lightOf([1, 1, 1]), fog: 6 }); drawSprites(S.buf, S.z, S.fs, [propAt(5.6)]); return meanOf(S, () => true) }
    expect(total(far(0.3))).toBeCloseTo(total(far(1)), 0)
  })
})

describe('SPR-03: the warm queue', () => {
  beforeEach(() => resetAtlas())

  it('a slow device (dt 60 ms) warms the level cast too, one frame per call after a rest', () => {
    const S = scene({ levelKey: '3', dt: 0.06 })
    const ents = [propAt(4, 0, 'transformer')]
    drawSprites(S.buf, S.z, S.fs, ents)
    const f0 = atlasStats().frames
    for (let i = 0; i < 200; i++) drawSprites(S.buf, S.z, S.fs, ents)
    expect(atlasStats().frames).toBeGreaterThan(f0 + 3)
  })

  it('prewarmSprites builds a level cast, and what it built is answered from memory afterwards', () => {
    const cfg = { props: { types: ['chair'] }, exit: {}, scraps: { denom: 5 }, entities: { enabled: true, stalkerVariants: ['smiler'], wandererVariants: [] } }
    resetAtlas()
    expect(prewarmSprites(cfg, 0)).toBeLessThanOrEqual(2)    // a tiny cap stops after the first job (the exit; its ring frame is a sibling): never a long hitch
    resetAtlas()
    prewarmSprites(cfg, 1e9)
    const f = atlasStats().frames
    expect(f).toBeGreaterThan(5)
    getFrame('exit', 'portal', 0, 0, 0, 0); getFrame('note', 'unread', 0, 0, 0, 0); getFrame('creature', 'smiler', 0, 1, 0, 0)
    expect(atlasStats().frames).toBe(f)
  })

  it('a cut-short prewarm builds the exit first', () => {
    resetAtlas()
    const cfg = { props: { types: ['chair', 'cone'] }, exit: {}, entities: { enabled: true, stalkerVariants: ['smiler'], wandererVariants: [] } }
    prewarmSprites(cfg, 0)
    const f = atlasStats().frames
    getFrame('exit', 'portal', 0, 0, 0, 0)
    expect(atlasStats().frames).toBe(f)
  })
})

describe('SPR-05: the sprite cap drops far props, not exits and notes', () => {
  beforeEach(() => resetAtlas())
  it('with more than 384 visible things, an exit listed last is still drawn', () => {
    const props = []
    for (let i = 0; i < 420; i++) props.push(propAt(6 + (i % 20) * 0.3, ((i * 7) % 30 - 15) * 0.1, 'crate'))
    const ex = { kind: 'exit', x: 25, y: 0, key: 'e' }
    const S = scene({ fog: 40 }); drawSprites(S.buf, S.z, S.fs, [...props, ex])
    const S2 = scene({ fog: 40 }); drawSprites(S2.buf, S2.z, S2.fs, props)
    let diff = 0
    for (let i = 0; i < S.buf.length; i++) if (S.buf[i] !== S2.buf[i]) diff++
    expect(diff).toBeGreaterThan(20)
  })
})

describe('SPR-06: motion records and unknown kinds', () => {
  beforeEach(() => resetAtlas())
  const player = (x, y) => ({ kind: 'player', x, y, name: 'wanderer', angle: Math.PI })

  it('two unnamed remote players keep separate motion records: one walks, one stands', () => {
    let last = null
    for (let i = 0; i < 25; i++) last = motionProbe([player(4 + i * 0.06, -3), player(4, 3)], 1 + i * 0.1)
    expect(last).toEqual([true, false])
  })

  it('a standing unnamed pair is never seen as moving, whatever order the list arrives in', () => {
    for (let i = 0; i < 30; i++) {
      const pair = i % 2 ? [player(4, -3), player(4, 3)] : [player(4, 3), player(4, -3)]
      expect(motionProbe(pair, 1 + i * 0.1).some(Boolean)).toBe(false)
    }
  })

  it('players with an id keep their record by id', () => {
    const p = (id, x) => ({ ...player(x, 0), id })
    let last = null
    for (let i = 0; i < 25; i++) last = motionProbe([p('a', 4), p('b', 4 + i * 0.06)], 1 + i * 0.1)
    expect(last).toEqual([false, true])
  })

  it('an entity of an unknown kind is not drawn as a creature', () => {
    const S = scene()
    drawSprites(S.buf, S.z, S.fs, [{ kind: 'wat', x: 4, y: 0 }])
    expect(meanOf(S, () => true).n).toBe(0)
    const T = scene()
    drawSprites(T.buf, T.z, T.fs, [{ x: 4, y: 0 }])          // no kind and no variant/type either
    expect(meanOf(T, () => true).n).toBe(0)
  })

  it('enemies (no kind, a type and a variant) and apparitions (a variant and a velocity) are still drawn', () => {
    const S = scene()
    drawSprites(S.buf, S.z, S.fs, [{ x: 4, y: 0, type: 'stalker', variant: 'smiler', state: 'idle', stagger: 0, dir: 0, chunkCx: 1, chunkCy: 1 }])
    expect(meanOf(S, () => true).n).toBeGreaterThan(20)
    const T = scene()
    drawSprites(T.buf, T.z, T.fs, [{ x: 4, y: 0, variant: 'shade', vx: 1, vy: 0 }])
    expect(meanOf(T, () => true).n).toBeGreaterThan(20)
  })
})

describe('W7: buildTextures memo', () => {
  const pal = { wall: '#c8b84a', floor: '#6b5a2a', ceiling: '#d8d0a0', fog: '#c8c060', light: '#fff8d0' }
  beforeEach(() => clearTexturesMemo())

  it('returns the same TexSet for the same inputs and a new one when the palette, look or level changes', () => {
    const a = buildTexturesMemo(pal, null, null, 'legacy')
    expect(buildTexturesMemo({ ...pal }, null, null, 'legacy')).toBe(a)
    expect(buildTexturesMemo({ ...pal, wall: '#c8b84b' }, null, null, 'legacy')).not.toBe(a)
    expect(buildTexturesMemo(pal, null, { grade: { sat: 1.1 } }, 'legacy')).not.toBe(a)
    expect(buildTexturesMemo(pal, null, null, '2')).not.toBe(a)
  }, 60000)
  it('is bounded', () => {
    for (let i = 0; i < 20; i++) buildTexturesMemo({ ...pal, wall: '#' + (0x100000 + i * 977).toString(16) }, null, null, 'legacy')
    expect(texturesMemoSize()).toBeLessThanOrEqual(6)
  })
  it('is content-identical to a direct build', () => {
    const m = buildTexturesMemo(pal, null, null, 'legacy'), d = buildTextures(pal, null, null, 'legacy')
    expect(Buffer.from(m.floor).equals(Buffer.from(d.floor))).toBe(true)
    expect(Buffer.from(m.walls['0']).equals(Buffer.from(d.walls['0']))).toBe(true)
  })
})
