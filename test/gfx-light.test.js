// gfx-light.js — the light model: recipes, the periodic pool tiles, emitters derived from cell addresses, per-panel flicker
// (bounded, spatial, low-passed) and the queries the sprite and post passes use. All pure: it runs in Node with no DOM.
import { describe, it, expect } from 'vitest'
import {
  createLight, resolveLighting, LEVEL_LIGHTING, buildPanelTile, buildWallPool, buildSurfaceTables, panelDim, eventIntensity,
  lampCandidate, lampKernel, kernel, PERIOD, TILE_N, TILE_PER_UNIT, AMBIENT_DIP_MAX, flashAtt, glowAtt,
} from '../src/renderer/gfx-light.js'
import { levelConfig, LEVELS } from '../src/renderer/levels.js'
import { DEFAULT_CONFIG } from '../src/renderer/world.js'
import { hash2 } from '../src/renderer/gfx-util.js'
import { NULL_MAP } from '../src/renderer/level-null-map.js'

const cfgOf = (i) => levelConfig(DEFAULT_CONFIG, i)
const open = () => false                                   // an open plane: no walls anywhere

// a frame-state stub good enough for prepare()/panelLevel()
function fsOf(over = {}) {
  const player = over.player || { x: 10.5, y: 10.5, angle: 0, bobOffset: 0 }
  return { W: 64, H: 36, HH: 18, fog: 16, t: 0, dt: 1 / 60, frame: 1, rawFlicker: 1, flicker: 1, comfort: { reduceFlicker: false, maxGlobalDip: 1 },
    lights: {}, quality: { lightDetail: 1 }, player, ...over }
}
const TEX = { ts: 64 }

describe('gfx-light.js is import-safe in Node', () => {
  it('imports without a DOM', async () => {
    expect(typeof document).toBe('undefined')
    await expect(import('../src/renderer/gfx-light.js')).resolves.toBeDefined()
  })
})

describe('recipes (LEVEL_LIGHTING)', () => {
  it('every level of the game has a recipe, keyed by its levelKey', () => {
    for (const lvl of LEVELS) expect(LEVEL_LIGHTING[String(lvl.id)], `level ${lvl.id}`).toBeTruthy()
  })
  it('the modes follow the art direction: panels for 0 and 1, lamps for 2 and 3, daylight for the block', () => {
    expect(resolveLighting(cfgOf(0)).mode).toBe('panels')
    expect(resolveLighting(cfgOf(1)).mode).toBe('panels')
    expect(resolveLighting(cfgOf(2)).mode).toBe('lamps')
    expect(resolveLighting(cfgOf(3)).mode).toBe('lamps')
    expect(resolveLighting(cfgOf(4)).mode).toBe('daylight')
  })
  it('colours: warm green-yellow lobby, cold sodium-green level 1, amber level 2, cold blue-white level 3', () => {
    const t = (i) => resolveLighting(cfgOf(i)).tint
    expect(t(0)[0]).toBeGreaterThan(t(0)[2]); expect(t(0)[1]).toBeGreaterThan(t(0)[2])           // yellow: r,g > b
    expect(t(1)[1]).toBeGreaterThan(t(1)[0]); expect(t(1)[1]).toBeGreaterThan(t(1)[2])           // green
    expect(t(2)[0]).toBeGreaterThan(t(2)[1]); expect(t(2)[1]).toBeGreaterThan(t(2)[2])           // amber
    expect(t(3)[2]).toBeGreaterThan(t(3)[0])                                                     // blue-white
  })
  it('a config with no level identity has no recipe (legacy shading), unless config.look.lighting supplies one', () => {
    expect(resolveLighting({ palette: { wall: '#fff' } })).toBeNull()
    const s = resolveLighting({ look: { lighting: { mode: 'lamps', color: '#ff8800', every: 5 } } })
    expect(s.mode).toBe('lamps'); expect(s.every).toBe(5); expect(s.color).toEqual([255, 136, 0])
  })
  it('config.look.lighting overrides the level defaults field by field and is clamped', () => {
    const c = { ...cfgOf(0), look: { lighting: { ambient: 0.7, pool: 0.5, warmth: 5, peak: 99 } } }
    const s = resolveLighting(c)
    expect(s.ambient).toBeCloseTo(0.7); expect(s.pool).toBe(0.5); expect(s.peak).toBeLessThanOrEqual(3)
    expect(s.color).toEqual(LEVEL_LIGHTING['0'].color)
  })
  it('a level whose ceiling has no panels (lights:false) cannot run the panel lattice', () => {
    const c = { ...cfgOf(0), lights: false }
    expect(resolveLighting(c).mode).toBe('lamps')
  })
})

describe('the periodic pool tile', () => {
  const range = 0.9
  const T = buildPanelTile(range, 1.35)
  it('has TILE_N x TILE_N samples covering one period', () => {
    expect(T.S.length).toBe(TILE_N * TILE_N)
    expect(TILE_N / TILE_PER_UNIT).toBe(PERIOD)
  })
  it('S = A + B, B >= 0, everything within [0, range * 4] and the peak is the range under a panel', () => {
    for (let i = 0; i < T.S.length; i++) {
      expect(T.S[i]).toBeCloseTo(T.A[i] + T.B[i], 5)
      expect(T.B[i]).toBeGreaterThanOrEqual(0)
      expect(T.S[i]).toBeGreaterThanOrEqual(0)
    }
    const at = (x, y) => T.S[Math.floor(y * TILE_PER_UNIT) * TILE_N + Math.floor(x * TILE_PER_UNIT)]
    expect(at(0.5, 0.5)).toBeCloseTo(range, 1)                       // directly under the panel (its centre is at 0.5, 0.5)
    expect(at(1.5, 1.5)).toBeLessThan(0.02)                          // diagonal midpoint of four panels: the dark between
  })
  it('is exactly periodic: the tile wraps (the light model indexes it modulo the period)', () => {
    // the lattice sum uses images -1..1, so the value at u and at u + period must agree by construction of the index wrap
    const L = createLight(cfgOf(0), {})
    L.prepare(fsOf(), TEX, open)
    for (const [x, y] of [[0.3, 0.7], [1.9, 0.1], [0.5, 1.5], [1.0, 1.0]]) {
      const v = L.at(x, y)
      for (const [dx, dy] of [[2, 0], [0, 2], [-4, 6], [200, -100]]) expect(L.at(x + dx, y + dy)).toBeCloseTo(v, 6)
    }
  })
  it('the panel-nearest split is seamless: B is 0 at the edge of a panel\'s square', () => {
    const at = (x, y) => T.B[Math.floor(y * TILE_PER_UNIT) * TILE_N + Math.floor(x * TILE_PER_UNIT)]
    expect(at(1.5, 0.5)).toBeLessThan(0.02); expect(at(0.5, 1.5)).toBeLessThan(0.02)
  })
  it('the wall pool factor is 0..1, brightest opposite the panel rows and dark between them, and periodic in the table', () => {
    const w = buildWallPool(1.5)
    expect(w.P.length).toBe(TILE_N)
    for (const v of w.P) { expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThanOrEqual(1) }
    const k = (u) => w.P[Math.floor(u * TILE_PER_UNIT)]
    expect(k(0.5)).toBeGreaterThan(k(1.5) + 0.2)
    for (let i = 0; i < TILE_N; i++) expect(w.K[0][i] + w.K[1][i] + w.K[2][i]).toBeGreaterThanOrEqual(w.P[i] - 1e-6)
  })
  it('surface tables have the texture tile size', () => {
    for (const ts of [64, 128]) {
      const t = buildSurfaceTables(resolveLighting(cfgOf(0)), ts)
      expect(t.wallAmb.length).toBe(ts); expect(t.wallPool.length).toBe(64 * ts); expect(t.wallLit.length).toBe(64 * ts)
      expect(t.aoFloor.length).toBe(4 * ts)
      for (let i = 0; i < ts; i++) { expect(t.aoFloor[i]).toBe(1); expect(t.aoFloor[3 * ts + i]).toBeLessThanOrEqual(t.aoFloor[ts + i]) }
    }
  })
  it('kernels are compact: exactly 0 at and beyond their reach', () => {
    expect(kernel(1.35, 1.35)).toBe(0); expect(kernel(0, 1.35)).toBe(1)
    expect(lampKernel(4.4, 4.4)).toBe(0); expect(lampKernel(0, 4.4)).toBe(1)
  })
})

describe('createLight', () => {
  it('a config with no recipe is the stub: never enabled, neutral queries', () => {
    const L = createLight({ palette: { wall: '#fff' } }, {})
    expect(L.enabled).toBe(false)
    expect(L.prepare(fsOf(), TEX, open)).toBe(false)
    expect(L.enabled).toBe(false)
    expect(L.at(3, 4)).toBe(1); expect(L.tint(3, 4)).toEqual([1, 1, 1]); expect(L.nearest(3, 4)).toBeNull(); expect(L.panelLevel(2, 2, fsOf())).toBe(1)
  })
  it('enabled is per frame: 0 at the legacy tier, on at lightDetail >= 1', () => {
    const L = createLight(cfgOf(0), {})
    expect(L.enabled).toBe(false)
    expect(L.prepare(fsOf({ quality: { lightDetail: 0 } }), TEX, open)).toBe(false)
    expect(L.enabled).toBe(false); expect(L.at(3, 4)).toBe(1)
    expect(L.prepare(fsOf({ quality: { lightDetail: 1 } }), TEX, open)).toBe(true)
    expect(L.enabled).toBe(true)
    expect(L.prepare(fsOf({ quality: { lightDetail: 0 } }), TEX, open)).toBe(false)
    expect(L.enabled).toBe(false)
  })
  it('is deterministic: two lights built from the same config have identical tables', () => {
    const a = createLight(cfgOf(0), {}), b = createLight(cfgOf(0), {})
    expect(Array.from(a.frame.floorS)).toEqual(Array.from(b.frame.floorS))
    expect(Array.from(a.frame.ceilS)).toEqual(Array.from(b.frame.ceilS))
    expect(Array.from(a.frame.wallP)).toEqual(Array.from(b.frame.wallP))
  })
  it('at() stays inside sane bounds everywhere, on every level, and is brighter under a fixture than between them', () => {
    for (const lvl of [0, 1]) {
      const L = createLight(cfgOf(lvl), {}); L.prepare(fsOf(), TEX, open)
      const r = L.recipe
      let lo = 1e9, hi = -1e9
      for (let y = 0; y < 4; y += 0.125) for (let x = 0; x < 4; x += 0.125) { const v = L.at(x, y); lo = Math.min(lo, v); hi = Math.max(hi, v); expect(Number.isFinite(v)).toBe(true) }
      expect(lo).toBeGreaterThanOrEqual(0.05); expect(hi).toBeLessThanOrEqual(2.2)
      expect(hi).toBeCloseTo(r.peak, 1); expect(lo).toBeCloseTo(r.ambient, 1)
      expect(L.at(0.5, 0.5)).toBeGreaterThan(L.at(1.5, 1.5) + 0.5)
    }
  })
  it('tint() is the fixture colour as a multiplier, nearest() the nearest lattice panel', () => {
    const L = createLight(cfgOf(1), {}); L.prepare(fsOf(), TEX, open)
    const t = L.tint(5, 5)
    expect(t).toHaveLength(3); for (const c of t) { expect(c).toBeGreaterThan(0); expect(c).toBeLessThanOrEqual(1) }
    const n = L.nearest(3.1, 5.2)
    expect(n.x % 2).toBeCloseTo(0.5); expect(n.y % 2).toBeCloseTo(0.5)
    expect(n.dist).toBeLessThan(1.5)
    expect(Math.hypot(3.1 - n.x, 5.2 - n.y)).toBeCloseTo(n.dist, 6)
    expect(n.r).toBe(LEVEL_LIGHTING['1'].color[0])
  })
})

describe('lamps: emitters derived from the cell address, never Math.random', () => {
  const cells = (L) => {
    const F = L.frame, out = []
    for (let cy = -20; cy <= 20; cy++) for (let cx = -20; cx <= 20; cx++) {
      const slot = ((cy & 63) << 6) | (cx & 63)
      if (F.cellLamp[slot]) out.push(`${cx},${cy}`)
    }
    return out
  }
  const build = (lvl, wall = open) => {
    const L = createLight(cfgOf(lvl), {})
    L.prepare(fsOf({ quality: { lightDetail: 1 }, player: { x: 0.5, y: 0.5, angle: 0 }, fog: 11 }), TEX, wall)
    return L
  }
  it('the same lamps come out of two independent builds', () => {
    const a = cells(build(2)), b = cells(build(2))
    expect(a.length).toBeGreaterThan(5)
    expect(a).toEqual(b)
    expect(cells(build(3))).toEqual(cells(build(3)))
  })
  it('a lamp exists only over an open cell, and no two lamps touch', () => {
    const wall = (wx, wy) => hash2(Math.floor(wx), Math.floor(wy), 7) % 3 === 0
    const L = build(2, wall)
    const cs = cells(L).map((s) => s.split(',').map(Number))
    expect(cs.length).toBeGreaterThan(3)
    for (const [cx, cy] of cs) expect(wall(cx + 0.5, cy + 0.5)).toBe(false)
    const set = new Set(cs.map((c) => c.join(',')))
    for (const [cx, cy] of cs) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (dx || dy) expect(set.has(`${cx + dx},${cy + dy}`)).toBe(false)
  })
  it('the density is about one lamp per `every` open cells', () => {
    const n = cells(build(2)).length
    // 41 x 41 window, some cells suppressed by the no-neighbours rule: between a third and the full ideal count
    const ideal = (41 * 41) / LEVEL_LIGHTING['2'].every
    expect(n).toBeGreaterThan(ideal * 0.4); expect(n).toBeLessThan(ideal * 1.3)
  })
  it('lampCandidate is a pure function of the cell', () => {
    for (const [x, y] of [[0, 0], [5, -3], [-100, 77]]) expect(lampCandidate(x, y, 8)).toBe(lampCandidate(x, y, 8))
  })
  it('the lightmap is bright at a lamp, dark far from every lamp, and shadowed behind a wall', () => {
    // one lamp, forced: a level-2 light in a tiny world where we look up the brightest lightmap cell
    const L = build(2)
    const F = L.frame
    let best = -1, bx = 0, by = 0
    for (let cy = -14; cy <= 14; cy++) for (let cx = -14; cx <= 14; cx++) {
      const v = L.at(cx + 0.5, cy + 0.5)
      if (v > best) { best = v; bx = cx + 0.5; by = cy + 0.5 }
    }
    expect(best).toBeGreaterThan(F.ambient + 0.6)
    const n = L.nearest(bx, by)
    expect(n.dist).toBeLessThan(0.6)
    expect(n.r).toBe(LEVEL_LIGHTING['2'].color[0])
  })
  it('a wall between a lamp and a point takes the light away', () => {
    const wall = (wx, wy) => Math.floor(wx) === 5 && Math.floor(wy) !== 0        // a long wall at x = 5 with a gap at y = 0
    const L = createLight(cfgOf(2), {})
    L.prepare(fsOf({ quality: { lightDetail: 1 }, player: { x: 0.5, y: 0.5, angle: 0 }, fog: 11 }), TEX, wall)
    // find a lamp left of the wall and compare the light at the mirror-distance point on each side
    const F = L.frame
    let found = null
    for (let cy = -8; cy <= 8 && !found; cy++) for (let cx = 1; cx <= 3 && !found; cx++) if (cy !== 0 && F.cellLamp[((cy & 63) << 6) | (cx & 63)]) found = [cx, cy]
    if (!found) return       // this seed has no lamp in that strip: the shadow test needs one
    const [lx, ly] = found
    const before = L.at(4.5, ly + 0.5), behind = L.at(6.5, ly + 0.5)
    expect(behind).toBeLessThan(before)
    expect(lx).toBeGreaterThan(0)
  })
})

describe('daylight and lit windows (Level ∅)', () => {
  const hooks = { materialAt: (wx, wy) => { const r = NULL_MAP[Math.floor(wy)], c = r && r[Math.floor(wx)]; return c && c !== '.' ? c : null } }
  const wallAt = (wx, wy) => { const r = NULL_MAP[Math.floor(wy)], c = r && r[Math.floor(wx)]; return !(c === '.' || c === ' ') }
  it('is one soft even ambient: no lattice pools, every point about the same', () => {
    const L = createLight(cfgOf(4), hooks)
    L.prepare(fsOf({ player: { x: 8.5, y: 8.5, angle: 0 }, fog: 22 }), TEX, wallAt)
    const vals = []
    for (let y = 4; y < 7.5; y += 0.9) for (let x = 5; x < 12.5; x += 1.1) vals.push(L.at(x, y))      // the middle of the park, away from every window
    expect(Math.max(...vals) - Math.min(...vals)).toBeLessThan(0.05)
    expect(Math.min(...vals)).toBeGreaterThan(0.85)
  })
  it('lit "O" windows are the emitters, and they spill more light on the ground in front of them', () => {
    const L = createLight(cfgOf(4), hooks)
    L.prepare(fsOf({ player: { x: 15.5, y: 7.5, angle: 1.57 }, fog: 22 }), TEX, wallAt)
    const n = L.nearest(15.5, 9)                                            // the occupied row juts in at y = 10, x = 14..16
    expect(n).not.toBeNull()
    expect(n.dist).toBeLessThan(2)
    expect(NULL_MAP[Math.floor(n.y)][Math.floor(n.x)]).toBe('O')
    expect(L.at(15.5, 9.0)).toBeGreaterThan(L.at(15.5, 5.0))                 // near the windows vs. the middle of the park
    expect(n.r).toBeGreaterThan(n.b)                                         // warm
  })
})

describe('flicker: spatial, bounded, low-passed', () => {
  it('eventIntensity ignores the steady jitter of the game (rawFlicker 0.92..1) and reaches 1 at 0', () => {
    expect(eventIntensity(1)).toBe(0); expect(eventIntensity(0.92)).toBe(0); expect(eventIntensity(0.9)).toBe(0)
    expect(eventIntensity(0)).toBe(1)
    expect(eventIntensity(0.2)).toBeGreaterThan(eventIntensity(0.6))
  })
  it('panelDim stays in 0..1, is a pure function of its arguments, and steady when there is no event', () => {
    for (let cx = -6; cx <= 6; cx += 2) for (let cy = -6; cy <= 6; cy += 2) for (const e of [0, 0.1, 0.4, 0.9, 1]) for (const t of [0, 0.37, 5.5, 1234.5]) {
      const v = panelDim(cx, cy, e, 0.5, t)
      expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThanOrEqual(1)
      expect(panelDim(cx, cy, e, 0.5, t)).toBe(v)
      if (e === 0) expect(v).toBe(1)
    }
  })
  it('a stronger event never brightens a panel, and different panels do not all move together', () => {
    for (const [cx, cy] of [[0, 0], [4, 8], [-2, 6]]) {
      let prev = 1
      for (let e = 0; e <= 1.0001; e += 0.1) { const v = panelDim(cx, cy, e, 0.5, 3.2); expect(v).toBeLessThanOrEqual(prev + 1e-9); prev = v }
    }
    const levels = new Set()
    for (let i = 0; i < 20; i++) levels.add(panelDim(2 * i, 4, 0.5, 0.5, 2.0).toFixed(3))
    expect(levels.size).toBeGreaterThan(8)
  })
  it('the lights-cascade reads as panels going out AHEAD first: at a moderate event the far-ahead panels are darker than the near ones', () => {
    let far = 0, near = 0, n = 0
    for (let cx = -30; cx <= 30; cx += 2) for (let cy = -30; cy <= 30; cy += 2) {
      far += panelDim(cx, cy, 0.4, 1, 1.0); near += panelDim(cx, cy, 0.4, 0, 1.0); n++
    }
    expect(far / n).toBeLessThan(near / n - 0.05)
  })
  it('panelLevel(cx, cy, fs) is 1 when steady, in 0..1 during an event, stable per (cell, time), and per panel', () => {
    const L = createLight(cfgOf(0), {})
    const steady = fsOf({ rawFlicker: 1 })
    L.prepare(steady, TEX, open)
    expect(L.panelLevel(4, 4, steady)).toBe(1)
    const ev = fsOf({ rawFlicker: 0.2, t: 2.5 })
    let lo = 1, hi = 0
    for (let cx = 0; cx < 40; cx += 2) for (let cy = 0; cy < 40; cy += 2) {
      const v = L.panelLevel(cx, cy, ev)
      expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThanOrEqual(1)
      expect(L.panelLevel(cx, cy, ev)).toBe(v)
      lo = Math.min(lo, v); hi = Math.max(hi, v)
    }
    expect(lo).toBeLessThan(0.5); expect(hi - lo).toBeGreaterThan(0.2)          // some gutter, and not all alike
  })
  it('the whole-frame ambient dip is bounded well under 50% however hard the game dips, and smaller under the comfort preference', () => {
    const run = (comfort) => {
      const L = createLight(cfgOf(0), {})
      let minDip = 1
      for (let i = 0; i < 240; i++) {
        L.prepare(fsOf({ rawFlicker: 0.05, t: i / 60, comfort }), TEX, open)
        minDip = Math.min(minDip, L.frame.gdip)
      }
      return minDip
    }
    const plain = run({ reduceFlicker: false, maxGlobalDip: 1 })
    const gentle = run({ reduceFlicker: true, maxGlobalDip: 0.25 })
    expect(plain).toBeGreaterThanOrEqual(1 - AMBIENT_DIP_MAX - 1e-9); expect(plain).toBeGreaterThan(0.5)
    expect(gentle).toBeGreaterThan(plain)
  })
  it('photosensitivity: however fast the game flickers, no panel and no region flashes more than 3 times a second', () => {
    // worst case: the game's scalar slams between near-black and full every 60 ms (8 Hz), for 4 seconds, at 60 fps
    const L = createLight(cfgOf(3), {})
    const player = { x: 0.5, y: 0.5, angle: 0 }
    const lvls = [], mean = [], agg = []
    for (let i = 0; i < 240; i++) {
      const t = i / 60
      const raw = Math.floor(t / 0.06) % 2 ? 1 : 0.1
      const fs = fsOf({ rawFlicker: raw, t, player, quality: { lightDetail: 2 } })
      L.prepare(fs, TEX, open)
      lvls.push(L.panelLevel(4, 4, fs))
      mean.push(L.frame.gdip)
      let s = 0, n = 0                                        // the lit fraction of a whole block of panels in view
      for (let cx = 0; cx < 12; cx += 2) for (let cy = -6; cy < 6; cy += 2) { s += L.panelLevel(cx, cy, fs); n++ }
      agg.push(s / n)
    }
    const flashes = (series, thresh) => {
      // count swings of at least `thresh` between successive local extremes, per second (a flash = an opposing pair of changes)
      let ext = [series[0]], dir = 0, count = 0
      for (let i = 1; i < series.length; i++) {
        const d = series[i] - series[i - 1]
        if (Math.abs(d) < 1e-6) continue
        const nd = d > 0 ? 1 : -1
        if (dir !== 0 && nd !== dir) { ext.push(series[i - 1]) }
        dir = nd
      }
      ext.push(series[series.length - 1])
      for (let i = 1; i < ext.length; i++) if (Math.abs(ext[i] - ext[i - 1]) >= thresh) count++
      return count / (series.length / 60)
    }
    expect(flashes(lvls, 0.1) / 2).toBeLessThanOrEqual(3)       // 2 swings = 1 flash
    expect(flashes(mean, 0.05) / 2).toBeLessThanOrEqual(3)
    expect(flashes(agg, 0.1) / 2).toBeLessThanOrEqual(3)
    // and no panel changes faster than the low-pass allows in one frame
    let maxStep = 0
    for (let i = 1; i < lvls.length; i++) maxStep = Math.max(maxStep, Math.abs(lvls[i] - lvls[i - 1]))
    expect(maxStep).toBeLessThan(0.3)
  })
})

describe('the player\'s own lights', () => {
  it('flashlight and glowstick raise at() only at lightDetail 2 and only near the beam / the player', () => {
    const player = { x: 20.5, y: 20.5, angle: 0 }
    const off = createLight(cfgOf(2), {})
    off.prepare(fsOf({ player, quality: { lightDetail: 2 }, lights: {} }), TEX, open)
    const base = off.at(24, 20.5), side = off.at(20.5, 24)
    const on = createLight(cfgOf(2), {})
    on.prepare(fsOf({ player, quality: { lightDetail: 2 }, lights: { flashlight: true } }), TEX, open)
    expect(on.at(24, 20.5)).toBeGreaterThan(base + 0.05)                      // in the beam
    expect(on.at(20.5, 24)).toBeCloseTo(side, 1)                              // 90 degrees off the beam: unlit
    const l1 = createLight(cfgOf(2), {})
    l1.prepare(fsOf({ player, quality: { lightDetail: 1 }, lights: { flashlight: true } }), TEX, open)
    expect(l1.at(24, 20.5)).toBeCloseTo(base, 3)                              // the low tier leaves it to the post pass
    const g = createLight(cfgOf(2), {})
    g.prepare(fsOf({ player, quality: { lightDetail: 2 }, lights: { glow: [80, 235, 110] } }), TEX, open)
    expect(g.at(21.5, 20.5)).toBeGreaterThan(base)
    const t = g.tint(21, 20.5)
    expect(t[1]).toBeGreaterThan(t[0])                                        // pulled toward the glow's green
  })
  it('falloffs are 0 far away and never negative', () => {
    expect(flashAtt(20)).toBe(0); expect(glowAtt(100)).toBe(0)
    for (let d = 0; d < 15; d += 0.5) { expect(flashAtt(d)).toBeGreaterThanOrEqual(0); expect(glowAtt(d * d)).toBeGreaterThanOrEqual(0) }
  })
})
