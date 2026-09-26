// Fix wave R3 (sprites and post): SP-1 level warm-up, SP-3 atlas sizing / growth / whole-sprite drawing, SP-4 explicit texture levels,
// PP-1 overlay redraw gate, PP-2 / SH-03 sampler precision, and pins for the planner-vs-CPU decisions the review re-checked.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { createAtlasManager, THRASH_FRAMES } from '../src/renderer/gfx-gl-sprites-atlas.js'
import { createSpritePlanner, IF, F_SHADOW, MODE_SCREEN } from '../src/renderer/gfx-gl-sprites-plan.js'
import { getFrame, atlasStats, resetAtlas } from '../src/renderer/gfx-sprites.js'
import { newOverlayMemo, overlayUnchanged, overlayRemember } from '../src/renderer/gfx-gl-post-math.js'
import * as SH from '../src/renderer/gfx-gl-post-shaders.js'

const FOV = Math.PI / 2.4
const mkFs = (over = {}) => ({
  W: 320, H: 180, HH: 90, fog: 16, fogRgb: [212, 200, 122], flicker: 1, t: 1.3, dt: 1 / 60, hf: FOV / 2, fov: FOV,
  player: { x: 0, y: 0, angle: 0 }, opts: {}, lights: {}, comfort: {}, levelKey: '0', light: null, handled: {}, ...over,
})
function fakeAtlas() {
  const m = new Map()
  return { rectFor(mip) { let r = m.get(mip); if (!r) { r = { x: 1 + m.size * 2, y: 1, w: mip.w, h: mip.h, rim: !!mip.rim }; m.set(mip, r) } return r }, m }
}
const prop = (d, lat = 0, type = 'crate', rot = 5.6) => ({ kind: 'prop', type, x: d, y: lat, rot, key: 'k' + d + type })
const enemy = (over = {}) => ({ x: 4, y: 0, type: 'stalker', variant: 'smiler', state: 'idle', dir: 0, stagger: 0, chunkCx: 3, chunkCy: 5, ...over })
const inst = (out, i) => Array.from(out.inst.subarray(i * IF, (i + 1) * IF))
const all = (out) => { const a = []; for (let i = 0; i < out.count; i++) a.push(inst(out, i)); return a }
// under a frozen clock (as in the harness) no frame is ever deferred past the generation budget: what is in view is drawn
const frozen = (fn) => { const spy = vi.spyOn(performance, 'now').mockReturnValue(0); try { return fn() } finally { spy.mockRestore() } }
const plan2 = (fs, ents, atlas = fakeAtlas()) => frozen(() => { const pl = createSpritePlanner(atlas); pl.plan(fs, ents); pl.plan(fs, ents); return pl.out })
const src = (f) => readFileSync(new URL('../src/renderer/' + f, import.meta.url), 'utf8')

describe('SP-1: the planner warms the level\'s sprite set in the background', () => {
  beforeEach(() => resetAtlas())
  const config = { exit: true, scraps: { denom: 7 }, props: { types: ['crate', 'chair'] }, items: { types: ['radio'] }, entities: { stalkerVariants: ['smiler'], wandererVariants: [] } }
  it('builds the cast one frame per plan (never a burst), and the exit is ready before it is ever in view', () => {
    const pl = createSpritePlanner(fakeAtlas(), { config })
    const ents = [prop(9, 0, 'box')]                 // something in view so plan() runs its whole body
    pl.plan(mkFs(), ents)
    let maxStep = 0, prev = atlasStats().frames
    for (let i = 0; i < 800; i++) {
      pl.plan(mkFs({ dt: 1 / 60 }), ents)
      const f = atlasStats().frames
      maxStep = Math.max(maxStep, f - prev); prev = f
    }
    expect(maxStep).toBeLessThanOrEqual(2)           // a background frame, plus at most a sibling the draw path asked for
    const before = atlasStats().frames
    getFrame('exit', 'portal', 0, 0, 0, 0); getFrame('creature', 'smiler', 0, 1, 0, 0); getFrame('prop', 'chair', 1, 0, 0, 0)
    expect(atlasStats().frames).toBe(before)         // all built already: first sighting builds nothing
  })
  it('queues sights only on levels 0-3', () => {
    const pl = createSpritePlanner(fakeAtlas())
    for (let i = 0; i < 300; i++) pl.plan(mkFs({ levelKey: '0' }), [prop(9, 0, 'box')])
    const n = atlasStats().frames
    resetAtlas()
    const pl2 = createSpritePlanner(fakeAtlas())
    for (let i = 0; i < 300; i++) pl2.plan(mkFs({ levelKey: '∅' }), [prop(9, 0, 'box')])
    expect(n).toBeGreaterThan(atlasStats().frames)   // no sights on Level ∅
  })
})

describe('SP-3: atlas sizing, growth and whole sprites', () => {
  const mip = (w, h) => ({ w, h, px: new Uint32Array(w * h), rim: null })
  it('starts small: the GPU pass defaults to a 1024 atlas that may double to 2048', () => {
    const s = src('gfx-gl-sprites.js')
    expect(/const ATLAS_SIZE = 1024\b/.test(s)).toBe(true)
    expect(/const ATLAS_MAX = 2048\b/.test(s)).toBe(true)
    expect(/maxTexture/.test(s)).toBe(true)
  })
  it('a full atlas is flushed first; one that fills again soon grows (never past maxSize); one frame that cannot fit grows at once', () => {
    const sizes = []
    const A = createAtlasManager({ size: 64, maxSize: 256, upload() {}, resize: (n) => sizes.push(n) })
    expect(A.canGrow).toBe(true)
    expect(A.recover(5000)).toBe('flush')
    expect(A.recover(5000 + THRASH_FRAMES + 1)).toBe('flush')              // a long time later: the working set changed, not too big
    expect(A.recover(5000 + THRASH_FRAMES + 50)).toBe('grow')              // filled again right after a flush
    expect(sizes).toEqual([128]); expect(A.size).toBe(128); expect(A.st.size).toBe(128)
    expect(A.recover(9999, true)).toBe('grow'); expect(sizes).toEqual([128, 256])
    expect(A.canGrow).toBe(false)
    expect(A.recover(10000, true)).toBe('flush'); expect(sizes.length).toBe(2)
    expect(A.rectFor(mip(100, 100))).not.toBeNull()                        // the grown page takes what 64 could not
  })
  it('a failed reallocation keeps the old size and stops trying', () => {
    const A = createAtlasManager({ size: 64, maxSize: 256, upload() {}, resize() { throw new Error('out of memory') } })
    A.recover(1); expect(A.recover(2)).toBe('flush')
    expect(A.size).toBe(64); expect(A.canGrow).toBe(false)
  })
  it('a fixed atlas (no resize callback) never grows', () => {
    const A = createAtlasManager({ size: 64, upload() {} })
    expect(A.canGrow).toBe(false); expect(A.grow()).toBe(false)
  })
  it('a sprite whose layers do not all fit is dropped whole, not drawn as floating eyes; earlier sprites stay', () => {
    let n = 0
    const atlas = { rectFor(m) { if (n >= 2) return null; n++; return { x: 1 + n * 2, y: 1, w: m.w, h: m.h, rim: !!m.rim } } }
    const pl = createSpritePlanner(atlas)
    // far prop first (one body rect), then a near creature whose body gets the last rect and whose eyes do not
    const ents = [prop(9), enemy({ x: 4 })]
    n = 0
    const out = frozen(() => pl.plan(mkFs(), ents))
    expect(out.atlasFull).toBe(true)
    const a = all(out)
    expect(a.length).toBeGreaterThan(0)
    for (const i of a) expect(i[4]).toBeGreaterThan(8)                      // only the prop (depth 9): no creature shadow or body left over
    let total = 0
    for (let r = 0; r < out.runCount; r++) total += out.runs[r * 3 + 1]
    expect(total).toBe(out.count)
  })
})

describe('SP-4: the sprite shader samples with an explicit level', () => {
  it('has no implicit-derivative texture() call (it runs after a discard and inside branches)', () => {
    const s = src('gfx-gl-sprites.js')
    expect(/\btexture\(/.test(s)).toBe(false)
    expect((s.match(/textureLod\(/g) || []).length).toBe(2)
  })
})

describe('PP-2 / SH-03: every post shader declares highp sampler precision', () => {
  it('the fragment shaders and PARTICLE_VS', () => {
    for (const k of ['DOWN_FS', 'GRID_FS', 'BRIGHT_FS', 'BLUR_FS', 'WIDE_FS', 'COMPOSE_FS', 'UP_FS', 'LIGHTS_FS', 'PARTICLE_FS', 'PARTICLE_VS']) {
      expect(SH[k], k).toMatch(/precision highp sampler2D;/)
      expect(SH[k], k).toMatch(/precision highp float;/)
    }
  })
})

describe('PP-1: the overlay is redrawn only when something changed', () => {
  it('a static crosshair frame is skipped; plates, a pref, ui scale or size change redraw', () => {
    const m = newOverlayMemo()
    expect(overlayUnchanged(m, false, 0, true, 1, 960, 540)).toBe(false)     // nothing drawn yet
    overlayRemember(m, 0, true, 1, 960, 540)
    expect(overlayUnchanged(m, false, 0, true, 1, 960, 540)).toBe(true)
    expect(overlayUnchanged(m, false, 1, true, 1, 960, 540)).toBe(false)     // a plate now
    expect(overlayUnchanged(m, false, 0, false, 1, 960, 540)).toBe(false)    // crosshair toggled
    expect(overlayUnchanged(m, false, 0, true, 2, 960, 540)).toBe(false)     // ui scale
    expect(overlayUnchanged(m, false, 0, true, 1, 1280, 720)).toBe(false)    // size
    expect(overlayUnchanged(m, true, 0, true, 1, 960, 540)).toBe(false)      // the canvas was resized (and so cleared)
    overlayRemember(m, 2, true, 1, 960, 540)
    expect(overlayUnchanged(m, false, 0, true, 1, 960, 540)).toBe(false)     // the frame after the last plate clears it
    overlayRemember(m, 0, true, 1, 960, 540)
    expect(overlayUnchanged(m, false, 0, true, 1, 960, 540)).toBe(true)
  })
  it('gfx-gl-post.js uses the gate', () => { expect(src('gfx-gl-post.js')).toMatch(/overlayUnchanged\(ovMemo/) })
})

describe('planner decisions re-checked against gfx-sprites.js drawSprites', () => {
  const exit = { kind: 'exit', x: 6, y: 0, key: 'e' }
  const tintLight = (t) => ({ enabled: true, at: () => 1, tint: () => t, nearest: () => null })
  it('emissive layers keep their own colour under the light tint (the exit beam stays cold blue); reflective ones take it', () => {
    const plain = plan2(mkFs({ light: tintLight([1, 1, 1]) }), [exit])
    const plainA = all(plain)
    const tinted = plan2(mkFs({ light: tintLight([1.6, 0.6, 0.6]) }), [exit])
    const tintedA = all(tinted)
    expect(tintedA.length).toBe(plainA.length)
    let same = 0
    for (let i = 0; i < plainA.length; i++) {
      if (plainA[i][5] & F_SHADOW) continue
      if ([20, 21, 22].every((k) => Math.abs(plainA[i][k] - tintedA[i][k]) < 1e-6)) same++
    }
    expect(same).toBeGreaterThan(0)                  // the emissive (beam / glow) layers
    let screens = 0
    for (let r = 0; r < tinted.runCount; r++) if (tinted.runs[r * 3 + 2] === MODE_SCREEN) for (let k = 0; k < tinted.runs[r * 3 + 1]; k++) {
      const i = tintedA[tinted.runs[r * 3] + k], j = plainA[tinted.runs[r * 3] + k]
      screens++
      for (const q of [20, 21, 22]) expect(i[q]).toBeCloseTo(j[q], 6)         // screen layers: no tint at all
    }
    expect(screens).toBeGreaterThan(0)
  })
  it('no second flicker at the lit tiers: the colour and fog terms ignore fs.flicker when a light model is on, and follow it in legacy', () => {
    const body = (o) => all(o).find((a) => !(a[5] & F_SHADOW))
    const lit = (fl) => body(plan2(mkFs({ flicker: fl, light: tintLight([1, 1, 1]) }), [prop(6)]))
    expect(lit(0.5)[20]).toBeCloseTo(lit(1)[20], 6); expect(lit(0.5)[24]).toBeCloseTo(lit(1)[24], 6)
    const leg = (fl) => body(plan2(mkFs({ flicker: fl }), [prop(6)]))
    expect(leg(0.5)[20]).toBeLessThan(leg(1)[20] * 0.7)
    expect(leg(0.5)[24]).toBeLessThan(leg(1)[24])
    const handled = body(plan2(mkFs({ flicker: 0.5, handled: { flicker: true } }), [prop(6)]))
    expect(handled[20]).toBeCloseTo(leg(1)[20], 6)
  })
  it('over the 384 cap a far prop is evicted before near props and a far creature survives', () => {
    const many = []
    for (let i = 0; i < 384; i++) many.push(prop(1.5 + (i % 6) * 0.5, ((i * 37) % 100) / 100 - 0.5, 'box', 5.6 + i))
    const out = plan2(mkFs({ W: 640, H: 360, HH: 180 }), [...many, prop(13, 0, 'chair', 3.3), enemy({ x: 14, y: 0.2 })])
    const a = all(out)
    expect(a.filter((i) => i[5] & F_SHADOW).length).toBeLessThanOrEqual(384)
    expect(a.some((i) => i[4] > 12.5 && i[4] < 13.5)).toBe(false)             // the far prop went
    expect(a.some((i) => i[4] > 13.5)).toBe(true)                             // the far creature stayed
  })
  it('unnamed remote players still get motion records: a mover sways more than a stander, and neither makes a nameplate', () => {
    const pl = createSpritePlanner(fakeAtlas())
    const at = (x, t) => pl.plan(mkFs({ t }), [{ kind: 'player', x, y: 0, angle: Math.PI }])
    expect(at(5, 1.0).plates.length).toBe(0)
    const still = inst(at(5, 1.2), 1)[13] / (180 / 5)
    const moved = inst(at(5.9, 1.4), 1)[13] / (180 / 5.9)
    expect(still).toBeCloseTo(0.008, 3)
    expect(moved).toBeCloseTo(0.014, 3)
  })
  it('an unknown entity kind is skipped (even one that carries a variant or type), not drawn as a creature', () => {
    expect(plan2(mkFs(), [{ kind: 'zzz', x: 4, y: 0, variant: 'smiler', type: 'stalker' }]).count).toBe(0)
    expect(plan2(mkFs(), [{ kind: 'zzz', x: 4, y: 0 }, prop(5)]).count).toBeGreaterThan(0)
    expect(plan2(mkFs(), [enemy()]).count).toBeGreaterThan(0)                 // a creature has no kind
  })
})
