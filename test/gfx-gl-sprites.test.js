// The GPU sprite pass's pure halves: the shelf packer / atlas manager (gfx-gl-sprites-atlas.js) and the entity -> instance planner
// (gfx-gl-sprites-plan.js), pinned against the CPU blitter (gfx-sprites.js drawSprites) that is the source of truth for WHAT is drawn.
// The GL itself (the shader, blending, the depth test) is verified by rendering: tools/gfx/g2-parity.cjs and the harness on SwiftShader.
import { describe, it, expect, vi } from 'vitest'
import { ShelfPacker, createAtlasManager } from '../src/renderer/gfx-gl-sprites-atlas.js'
import { createSpritePlanner, IF, F_MIRROR, F_RIM, F_SHADOW, MODE_OVER, MODE_SCREEN } from '../src/renderer/gfx-gl-sprites-plan.js'
import { drawSprites, getFrame, pickMip, variantHash } from '../src/renderer/gfx-sprites.js'

// ── the packer ──
describe('ShelfPacker', () => {
  it('never overlaps, stays inside the page, and keeps a gutter between items', () => {
    const p = new ShelfPacker(128, 128, 1), placed = []
    let seed = 7
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
    for (let i = 0; i < 200; i++) {
      const w = 3 + Math.floor(rnd() * 30), h = 3 + Math.floor(rnd() * 30)
      const r = p.alloc(w, h)
      if (!r) continue
      expect(r.x + w + 1).toBeLessThanOrEqual(128); expect(r.y + h + 1).toBeLessThanOrEqual(128)
      for (const q of placed) {
        const sep = r.x + w + 1 <= q.x || q.x + q.w + 1 <= r.x || r.y + h + 1 <= q.y || q.y + q.h + 1 <= r.y
        expect(sep).toBe(true)
      }
      placed.push({ x: r.x, y: r.y, w, h })
    }
    expect(placed.length).toBeGreaterThan(20)
  })
  it('returns null for an item larger than the page and when the page is full, and reset() empties it', () => {
    const p = new ShelfPacker(32, 32, 1)
    expect(p.alloc(40, 4)).toBeNull()
    expect(p.alloc(31, 31)).not.toBeNull()
    expect(p.alloc(31, 31)).toBeNull()
    p.reset()
    expect(p.alloc(31, 31)).not.toBeNull()
  })
  it('reuses a shelf for items of similar height', () => {
    const p = new ShelfPacker(256, 256, 1)
    const a = p.alloc(20, 21), b = p.alloc(20, 20), c = p.alloc(20, 19)
    expect(b.y).toBe(a.y); expect(c.y).toBe(a.y)
  })
})

// ── the manager ──
const fakeMip = (w, h, rim = false) => ({ w, h, px: new Uint32Array(w * h).fill(0xff102030), rim: rim ? new Uint8Array(w * h).fill(128) : null })
describe('atlas manager', () => {
  it('uploads a mip once, hands back the same rect, and views the texels as RGBA bytes', () => {
    const ups = []
    const A = createAtlasManager({ size: 128, upload: (x, y, w, h, px8, rim8) => ups.push({ x, y, w, h, px8, rim8 }) })
    const m = fakeMip(10, 6, true)
    const r = A.rectFor(m)
    expect(A.rectFor(m)).toBe(r)
    expect(ups.length).toBe(1)
    expect(r).toMatchObject({ w: 10, h: 6, rim: true })
    expect(ups[0].px8.byteLength).toBe(10 * 6 * 4)
    expect(ups[0].px8[0]).toBe(0x30); expect(ups[0].px8[3]).toBe(0xff)         // ABGR uint32 -> R,G,B,A bytes (little endian)
    expect(ups[0].rim8).toBe(m.rim)
    expect(r.x).toBeGreaterThanOrEqual(1); expect(r.y).toBeGreaterThanOrEqual(1)   // a leading gutter texel
  })
  it('gives distinct, non-overlapping rects with a gutter, then null when full; flush() lets it re-upload', () => {
    const ups = []
    const A = createAtlasManager({ size: 64, upload: () => ups.push(1) })
    const ms = [], rs = []
    for (let i = 0; i < 40; i++) { const m = fakeMip(14, 14); ms.push(m); rs.push(A.rectFor(m)) }
    const ok = rs.filter(Boolean)
    expect(ok.length).toBeLessThan(40); expect(ok.length).toBeGreaterThan(4); expect(rs[39]).toBeNull()
    for (let i = 0; i < ok.length; i++) for (let j = i + 1; j < ok.length; j++) {
      const a = ok[i], b = ok[j]
      expect(a.x + a.w < b.x || b.x + b.w < a.x || a.y + a.h < b.y || b.y + b.h < a.y).toBe(true)
    }
    const n = ups.length
    A.flush()
    expect(A.st.flushes).toBe(1)
    expect(A.rectFor(ms[0])).not.toBeNull()
    expect(ups.length).toBe(n + 1)
  })
})

// ── the planner ──
const FOV = Math.PI / 2.4
function mkFs(over = {}) {
  return {
    W: 320, H: 180, HH: 90, fog: 16, fogRgb: [212, 200, 122], flicker: 1, t: 1.3, dt: 1 / 60, hf: FOV / 2, fov: FOV,
    player: { x: 0, y: 0, angle: 0 }, opts: {}, lights: {}, comfort: {}, levelKey: '0', light: null, handled: {}, ...over,
  }
}
// an atlas that just numbers the mips it is asked about
function fakeAtlas() {
  const m = new Map()
  return { rectFor(mip) { let r = m.get(mip); if (!r) { r = { x: 1 + m.size * 2, y: 1, w: mip.w, h: mip.h, rim: !!mip.rim }; m.set(mip, r) } return r }, m }
}
const prop = (d, lat = 0, type = 'crate', rot = 5.6) => ({ kind: 'prop', type, x: d, y: lat, rot, key: 'k' + d + type })
const enemy = (over = {}) => ({ x: 4, y: 0, type: 'stalker', variant: 'smiler', state: 'idle', dir: 0, stagger: 0, chunkCx: 3, chunkCy: 5, ...over })
// under a frozen clock (as in the harness) no frame is ever deferred past the generation budget: two plans always draw everything in view
const frozen = (fn) => { const spy = vi.spyOn(performance, 'now').mockReturnValue(0); try { return fn() } finally { spy.mockRestore() } }
const build = (fs, ents, atlas = fakeAtlas()) => frozen(() => { const pl = createSpritePlanner(atlas); pl.plan(fs, ents); pl.plan(fs, ents); return { pl, out: pl.out, atlas } })
const inst = (out, i) => Array.from(out.inst.subarray(i * IF, (i + 1) * IF))

describe('planner: culling, order and the cap (the same rules as drawSprites)', () => {
  it('draws nothing for an empty list', () => {
    const { out } = build(mkFs(), [])
    expect(out.count).toBe(0); expect(out.runCount).toBe(0); expect(out.plates).toEqual([])
  })
  it('culls what is behind the player, beyond the fog, or far off to the side', () => {
    const { out } = build(mkFs(), [prop(-3), prop(30), prop(4, 40)])
    expect(out.count).toBe(0)
    expect(build(mkFs(), [prop(4)]).out.count).toBeGreaterThan(0)
  })
  it('the exit reaches 1.35x farther than anything else', () => {
    const ex = (d) => ({ kind: 'exit', x: d, y: 0, key: 'e' })
    expect(build(mkFs(), [prop(19)]).out.count).toBe(0)
    expect(build(mkFs(), [ex(19)]).out.count).toBeGreaterThan(0)
    expect(build(mkFs(), [ex(23)]).out.count).toBe(0)
  })
  it('paints far to near and merges same-mode neighbours into runs', () => {
    const { out } = build(mkFs(), [prop(3, 0, 'chair'), prop(9, 0.5, 'cabinet'), prop(6, -0.5, 'box')])
    expect(out.count).toBeGreaterThan(3)
    const depths = []
    for (let i = 0; i < out.count; i++) depths.push(inst(out, i)[4])
    for (let i = 1; i < depths.length; i++) expect(depths[i]).toBeLessThanOrEqual(depths[i - 1] + 1e-6)     // never a far sprite after a nearer one
    expect(depths[0]).toBeGreaterThan(8.5)                                                                 // the farthest sprite (9 away) is painted first
    let total = 0
    for (let r = 0; r < out.runCount; r++) total += out.runs[r * 3 + 1]
    expect(total).toBe(out.count)
  })
  it('caps at 384 sprites and keeps the important ones (a far prop goes before a near prop or a creature)', () => {
    const many = []
    for (let i = 0; i < 500; i++) many.push(prop(1 + (i % 12) + i * 0.001, ((i * 37) % 100) / 100 - 0.5, 'box', 5.6 + i))
    many.push(enemy({ x: 14, y: 0.3 }))
    const { pl } = build(mkFs({ W: 640, H: 360, HH: 180 }), many)
    // 384 sprites at most: count distinct depths of shadows (one per sprite)
    let shadows = 0
    for (let i = 0; i < pl.out.count; i++) if (inst(pl.out, i)[5] & F_SHADOW) shadows++
    expect(shadows).toBeLessThanOrEqual(384)
    // the creature (14 away, key*0.05) survives: its eyes/grin layers are screen-mode instances
    let screen = 0
    for (let r = 0; r < pl.out.runCount; r++) if (pl.out.runs[r * 3 + 2] === MODE_SCREEN) screen++
    expect(screen).toBeGreaterThan(0)
  })
})

describe('planner vs the CPU blitter', () => {
  // the CPU sprite's changed-pixel bounding box, and the planner's union of non-shadow instance rects (with warp padding)
  function cpuBounds(ent, fs) {
    const bg = 0x80808080
    const buf = new Uint32Array(fs.W * fs.H).fill(bg), z = new Float32Array(fs.W).fill(1e9)
    for (let i = 0; i < 12; i++) drawSprites(buf.fill(bg), z, fs, [ent])       // the frame build budget: warm it
    buf.fill(bg); drawSprites(buf, z, fs, [ent])
    let x0 = 1e9, x1 = -1, y0 = 1e9, y1 = -1
    for (let y = 0; y < fs.H; y++) for (let x = 0; x < fs.W; x++) if (buf[y * fs.W + x] !== bg) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y) }
    return { x0, x1, y0, y1 }
  }
  function gpuBounds(ent, fs) {
    const pl = createSpritePlanner(fakeAtlas())
    for (let i = 0; i < 12; i++) pl.plan(fs, [ent])
    const out = pl.plan(fs, [ent])
    let x0 = 1e9, x1 = -1, y0 = 1e9, y1 = -1
    for (let i = 0; i < out.count; i++) {
      const a = inst(out, i)
      x0 = Math.min(x0, a[0]); x1 = Math.max(x1, a[1]); y0 = Math.min(y0, a[2]); y1 = Math.max(y1, a[3])
    }
    return { x0, x1, y0, y1 }
  }
  const cases = {
    'a crate': prop(5), 'a lurker': enemy({ variant: 'lurker', x: 5, y: 0.2 }), 'a hound in profile': enemy({ variant: 'hound', x: 6, y: -0.4, dir: Math.PI / 2 }),
    'an item': { kind: 'item', itemType: 'polaroid', x: 3, y: 0.3, key: 'i' }, 'an unread note': { kind: 'note', read: false, x: 4, y: -0.5, frag: 1, key: 'n' },
    'the exit': { kind: 'exit', x: 7, y: 0, key: 'e' }, 'a remote player': { kind: 'player', name: 'sam', x: 4, y: 0.4, angle: 0, key: 'p' },
  }
  for (const [name, ent] of Object.entries(cases)) {
    it(`${name}: the instances' union rect covers the pixels the CPU blitter changes, and is not much bigger`, () => {
      const fs = mkFs()
      const c = cpuBounds(ent, fs), g = gpuBounds(ent, fs)
      expect(c.x1).toBeGreaterThan(0)
      expect(g.x0).toBeLessThanOrEqual(c.x0 + 1.01); expect(g.x1).toBeGreaterThanOrEqual(c.x1 - 1.01)
      expect(g.y0).toBeLessThanOrEqual(c.y0 + 1.01); expect(g.y1).toBeGreaterThanOrEqual(c.y1 - 1.01)
      expect(g.x1 - g.x0).toBeLessThan((c.x1 - c.x0) * 1.5 + 12)
      expect(g.y1 - g.y0).toBeLessThan((c.y1 - c.y0) * 1.5 + 12)
    })
  }

  it('returns the same nameplate records as drawSprites', () => {
    const fs = mkFs()
    const players = [
      { kind: 'player', name: 'sam', x: 4, y: 0.4, angle: 0, chatText: 'hi', hp: 3, key: 'p1' },
      { kind: 'player', name: 'ada', x: 7, y: -1, angle: 2, key: 'p2' },
      { kind: 'npc', name: 'a lost soul', x: 5, y: 0, key: 'n1' },
    ]
    const buf = new Uint32Array(fs.W * fs.H), z = new Float32Array(fs.W).fill(1e9)
    for (let i = 0; i < 12; i++) drawSprites(buf, z, fs, players)
    const cpu = drawSprites(buf, z, fs, players).map((p) => ({ ...p }))
    const pl = createSpritePlanner(fakeAtlas())
    for (let i = 0; i < 12; i++) pl.plan(fs, players)
    const gpu = pl.plan(fs, players).plates.map((p) => ({ ...p }))
    expect(cpu.length).toBe(3)
    expect(gpu).toEqual(cpu)
  })
})

describe('planner: instance terms', () => {
  it('flips a prop exactly when its seeded variant hash says so, and points every body layer at a mip of the atlas', () => {
    for (const rot of [5.6, 5.4, 9.0, 1.3, 2.2, 7.7]) {
      const at = fakeAtlas()
      const { out } = build(mkFs(), [prop(4, 0, 'chair', rot)], at)
      let bodies = 0
      for (let i = 0; i < out.count; i++) {
        const a = inst(out, i)
        if (a[5] & F_SHADOW) continue
        bodies++
        expect((a[5] & F_MIRROR) !== 0).toBe((variantHash(rot) & 0x100) !== 0)
        expect(a[10]).toBeGreaterThan(0); expect(a[11]).toBeGreaterThan(0)
      }
      expect(bodies).toBeGreaterThan(0)
      expect(at.m.size).toBeGreaterThan(0)
    }
  })
  it('a screen-blended layer (an exit glow) is a screen-mode run with no fog term and no dissolve', () => {
    const { out } = build(mkFs(), [{ kind: 'exit', x: 6, y: 0, key: 'e' }])
    let screens = 0
    for (let r = 0; r < out.runCount; r++) {
      if (out.runs[r * 3 + 2] !== MODE_SCREEN) continue
      for (let k = 0; k < out.runs[r * 3 + 1]; k++) {
        const a = inst(out, out.runs[r * 3] + k); screens++
        expect(a[24]).toBe(0); expect(a[25]).toBe(0); expect(a[26]).toBe(0); expect(a[6]).toBe(0)
      }
    }
    expect(screens).toBeGreaterThan(0)
  })
  it('the fog term grows with distance and follows the fog colour; light dims the reflected term but not an emissive layer', () => {
    const near = build(mkFs(), [prop(3)]).out, far = build(mkFs(), [prop(14)]).out
    const body = (o) => { for (let i = 0; i < o.count; i++) { const a = inst(o, i); if (!(a[5] & F_SHADOW)) return a } }
    const an = body(near), af = body(far)
    expect(af[24]).toBeGreaterThan(an[24])              // more fog toward the fog colour
    expect(af[20]).toBeLessThan(an[20])                 // and less of the sprite's own colour
    expect(af[24] / af[25]).toBeGreaterThan(1)          // the fog colour is yellow (r > g)
    const dark = mkFs({ light: { enabled: true, at: () => 0.3, tint: () => [1, 1, 1], nearest: () => null } })
    const lit = build(dark, [{ kind: 'exit', x: 6, y: 0, key: 'e' }]).out
    const bright = build(mkFs(), [{ kind: 'exit', x: 6, y: 0, key: 'e' }]).out
    // the exit's emissive layers keep their brightness in the dark; its non-emissive ones dim
    const sum = (o, screenOnly) => { let s = 0; for (let r = 0; r < o.runCount; r++) if ((o.runs[r * 3 + 2] === MODE_SCREEN) === screenOnly) for (let k = 0; k < o.runs[r * 3 + 1]; k++) s += inst(o, o.runs[r * 3] + k)[20]; return s }
    expect(sum(lit, true)).toBeGreaterThan(sum(bright, true) * 0.7)
  })
  it('legacy shading dims sprites by the flicker; the live light model does not dim them again', () => {
    const e = [prop(4)]
    const full = build(mkFs({ flicker: 1 }), e).out, dim = build(mkFs({ flicker: 0.5 }), e).out
    const first = (o) => { for (let i = 0; i < o.count; i++) { const a = inst(o, i); if (!(a[5] & F_SHADOW)) return a } }
    expect(first(dim)[20]).toBeLessThan(first(full)[20] * 0.7)
    const litFlick = build(mkFs({ flicker: 0.5, light: { enabled: true, at: () => 1, tint: () => [1, 1, 1], nearest: () => null } }), e).out
    expect(first(litFlick)[20]).toBeCloseTo(first(full)[20], 4)
  })
  it('a rim from the nearest emitter switches the rim flag on for layers that have a rim plane, and only then', () => {
    const light = { enabled: true, at: () => 1, tint: () => [1, 1, 1], nearest: () => ({ x: 5, y: 3, dist: 3, r: 255, g: 240, b: 200 }) }
    const { out } = build(mkFs({ light }), [enemy({ variant: 'smiler', x: 4, y: 0 })])
    let rim = 0
    for (let i = 0; i < out.count; i++) { const a = inst(out, i); if (a[5] & F_RIM) { rim++; expect(Math.abs(a[28]) + Math.abs(a[29])).toBeGreaterThan(0) } }
    expect(rim).toBeGreaterThan(0)
    const none = build(mkFs({ light: { ...light, nearest: () => null } }), [enemy({ variant: 'smiler', x: 4, y: 0 })]).out
    for (let i = 0; i < none.count; i++) expect(inst(none, i)[5] & F_RIM).toBe(0)
  })
  it('a staggered creature carries the dissolve level; an idle one does not', () => {
    const st = build(mkFs(), [enemy({ state: 'stagger', stagger: 2 })]).out, idle = build(mkFs(), [enemy()]).out
    let d = 0
    for (let i = 0; i < st.count; i++) d = Math.max(d, inst(st, i)[6])
    expect(d).toBeGreaterThan(40)
    for (let i = 0; i < idle.count; i++) expect(inst(idle, i)[6]).toBe(0)
  })
  it('reports an atlas overflow so the pass can flush and re-plan', () => {
    const tiny = { rectFor: () => null }
    const pl = createSpritePlanner(tiny)
    for (let i = 0; i < 12; i++) pl.plan(mkFs(), [prop(4)])
    expect(pl.plan(mkFs(), [prop(4)]).atlasFull).toBe(true)
  })
  it('reuses its buffers between frames (no growth for a steady scene)', () => {
    const pl = createSpritePlanner(fakeAtlas())
    const ents = [prop(4), enemy({ x: 6 })]
    for (let i = 0; i < 12; i++) pl.plan(mkFs(), ents)
    const a = pl.out.inst, b = pl.out.runs
    pl.plan(mkFs(), ents); pl.plan(mkFs({ t: 5 }), ents)
    expect(pl.out.inst).toBe(a); expect(pl.out.runs).toBe(b)
  })
  it('pickMip agrees with what the planner uploads: the chosen mip height is never below the on-screen height', () => {
    const fr = getFrame('prop', 'crate', 0, 0, 0, 0)
    for (const h of [10, 30, 90, 400]) { const i = pickMip(fr.layers[0].mips, h); expect(fr.layers[0].mips[i].h).toBeGreaterThanOrEqual(Math.min(h * 0.85, fr.layers[0].mips[0].h)) }
    expect(MODE_OVER).toBe(0)
  })
})
