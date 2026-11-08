// Vertical look in the renderer (gfx-frame.js): a y-shear. player.pitch moves the HORIZON row (HH) and leaves the CENTRE row (HC: half the
// height and the head-bob) where it is. What is in the world is drawn around HH; the camera's height (the floor / ceiling span), the
// hand-held flashlight and the sky's gradient are measured from HC. Pinned here on the CPU passes, which the GPU pass mirrors formula for
// formula (its shader and uniforms are checked at the bottom; the pixels are compared on SwiftShader by tools/gfx/parity.mjs):
//   - level (pitch 0, or a hand-built fs with no HC) every byte is what it was: the old arithmetic exactly
//   - pitched, the world frame IS the level frame moved down / up by the pitch's rows, floor, ceiling, walls, light pools and sky alike, on
//     the classic shading and the lit tiers: the rows meet the walls at any pitch (rowDistance), nothing in the world tilts
//   - the sprites' floor line follows the horizon by the same rows; the flashlight's beam does NOT (it is in your hand): on the sprites it
//     is measured on the standing body (gfx-light.js flashDv), so looking up climbs a thing instead of leaving it, and the flat boost follows
//   - the sky's scratch is sized by the frame (a horizon two rows past the largest so far read past it: black rows; on a fresh module)
//   - the dust field slides with the tilt, streams out of the horizon walking forward and is lit from the ceiling where the ceiling is,
//     the same on the CPU draw and the GPU step
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { buildFrameState, horizonRow, pitchRows, PITCH_LIMIT, FOV } from '../src/renderer/gfx-frame.js'
import { renderWorld, rowDistance } from '../src/renderer/gfx-world.js'
import { renderSky } from '../src/renderer/gfx-sky.js'
import { planSprites, prewarmSprites, FIG, PERSON, ITEM_H } from '../src/renderer/gfx-sprites.js'
import { createLight, flashDv, flashTiltK, FLASH_PITCH } from '../src/renderer/gfx-light.js'
import { buildTextures } from '../src/renderer/gfx-textures.js'
import { levelConfig } from '../src/renderer/levels.js'
import { DEFAULT_CONFIG, createChunkCache } from '../src/renderer/world.js'
import { NULL_MAP } from '../src/renderer/level-null-map.js'
import { hexToRgb, levelKey, mulberry32 } from '../src/renderer/gfx-util.js'
import { qualityFor, TIERS } from '../src/renderer/gfx-quality.js'
import { buildSkyRows } from '../src/renderer/gfx-gl-world-data.js'
import { worldFragmentSource, worldUniformNames } from '../src/renderer/gfx-gl-world-shader.js'
import { createPostState, seedParticles, drawParticlesModern, drawBloom, airLight } from '../src/renderer/gfx-post.js'
import { createSink, stepModern } from '../src/renderer/gfx-gl-post-particles.js'
import { PITCH_MAX } from '../src/renderer/look.js'
import fs from 'node:fs'

const cfgOf = (i) => levelConfig(DEFAULT_CONFIG, i)
const nullHooks = { materialAt: (wx, wy) => { const r = NULL_MAP[Math.floor(wy)], c = r && r[Math.floor(wx)]; return c && c !== '.' ? c : null } }
const nullWall = (wx, wy) => { const r = NULL_MAP[Math.floor(wy)], c = r && r[Math.floor(wx)]; return !(c === '.' || c === ' ') }

// a level as the game draws it: config, textures, the wall test (and the fixed map's materials on Level ∅)
function scene(i) {
  const cfg = cfgOf(i)
  if (cfg.map) return { cfg, tex: buildTextures(cfg.palette, cfg.materials, cfg.look, levelKey(cfg)), isWall: nullWall, hooks: nullHooks }
  const cc = createChunkCache(cfg, 12345)
  return { cfg, tex: buildTextures(cfg.palette, cfg.materials, cfg.look, levelKey(cfg)), isWall: (x, y) => cc.isWall(x, y, 0, 0), hooks: {} }
}
// an open spot near (x0, y0) with a long view along +x
function openPose(isWall, x0, y0) {
  for (let r = 0; r < 12; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
    const x = Math.floor(x0) + dx + 0.5, y = Math.floor(y0) + dy + 0.5
    if (!isWall(x, y) && !isWall(x + 1, y) && !isWall(x + 2, y)) return { x: x + 0.13, y: y + 0.07, angle: 0.21 }
  }
  throw new Error('no open spot')
}
// the frame state exactly as both backends build it (gfx-frame.js)
function frameState(sc, tier, player, { W = 160, H = 90, lights = {}, light = null } = {}) {
  const { cfg } = sc
  return buildFrameState({
    W, H, OW: W, OH: H, fog: cfg.fogDistance, fogRgb: hexToRgb(cfg.palette.fog), fogMul: 1, flicker: 1, frame: 7, timing: { t: 4.25, dt: 1 / 60 },
    player, lights, lightsOn: cfg.lights !== false, hasSky: !!cfg.sky, skyRgb: cfg.sky ? hexToRgb(cfg.sky) : null,
    light, quality: qualityFor(tier), opts: { qualityTier: tier }, levelKey: levelKey(cfg), look: cfg.look,
  })
}
// one world pass, with a fresh light model (its flicker clock starts the same every time)
function world(sc, tier, player, o = {}) {
  const W = o.W ?? 160, H = o.H ?? 90
  const light = createLight(sc.cfg, sc.hooks)
  const f = frameState(sc, tier, player, { ...o, light })
  if (o.edit) o.edit(f)
  const buf = new Uint32Array(W * H), z = new Float32Array(W)
  renderWorld(f, o.tex || sc.tex, light, sc.isWall, sc.hooks.materialAt || null, buf, z)
  return { buf, z, fs: f, light }
}
const same = (a, b) => { if (a.length !== b.length) return false; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true }

describe('the frame state: HH (the horizon) moves, HC (the centre) does not', () => {
  it('pitchRows: whole rows of the frame, + looks up (the horizon goes down); 0, undefined, NaN are level; bounded by PITCH_LIMIT', () => {
    expect(pitchRows(90, 0)).toBe(0); expect(pitchRows(90, undefined)).toBe(0); expect(pitchRows(90, NaN)).toBe(0); expect(pitchRows(90, null)).toBe(0)
    expect(pitchRows(90, 0.2)).toBe(18); expect(pitchRows(90, -0.2)).toBe(-18); expect(pitchRows(100, 0.123)).toBe(12)
    expect(pitchRows(100, 5)).toBe(PITCH_LIMIT * 100); expect(pitchRows(100, -Infinity)).toBe(-PITCH_LIMIT * 100)
    expect(PITCH_MAX).toBeLessThan(PITCH_LIMIT)                      // the game's own bound sits inside the renderer's
  })
  it('buildFrameState: level, HH === HC (today\'s row) and tilt 0; pitched, HC keeps the bob and HH = HC + the rows', () => {
    const sc = { cfg: cfgOf(0) }
    for (const bob of [0, 3.7, -4]) {
      const lv = frameState(sc, 'medium', { x: 1, y: 1, angle: 0, bobOffset: bob, pitch: 0 })
      expect(lv.HH).toBe(horizonRow(90, bob, TIERS.medium.scale)); expect(lv.HC).toBe(lv.HH); expect(lv.tilt).toBe(0)
      const up = frameState(sc, 'medium', { x: 1, y: 1, angle: 0, bobOffset: bob, pitch: 0.25 })
      expect(up.HC).toBe(lv.HH); expect(up.HH).toBe(lv.HH + 23); expect(up.tilt).toBeCloseTo(23 / 90, 12)
      const dn = frameState(sc, 'medium', { x: 1, y: 1, angle: 0, bobOffset: bob, pitch: -0.3 })
      expect(dn.HC).toBe(lv.HH); expect(dn.HH).toBe(lv.HH - 27)
    }
    const none = frameState(sc, 'medium', { x: 1, y: 1, angle: 0, bobOffset: 2 })      // an old caller: no pitch field at all
    expect(none.HH).toBe(none.HC); expect(none.tilt).toBe(0)
    const tiny = frameState(sc, 'medium', { x: 1, y: 1, angle: 0, bobOffset: 9, pitch: 0.4 }, { W: 16, H: 9 })
    expect(tiny.HH).toBeLessThanOrEqual(8); expect(tiny.HH).toBeGreaterThanOrEqual(0)                       // a pitched horizon stays in the frame
  })
})

describe('rowDistance: the floor and ceiling meet the walls at any pitch', () => {
  it('a wall slice centred on the horizon ends where the floor (and the ceiling) reach the wall\'s distance', () => {
    const r = mulberry32(0x9e1)
    for (let n = 0; n < 4000; n++) {
      const H = 2 * (20 + ((r() * 300) | 0)), HC = H / 2, P = Math.round((r() * 2 - 1) * PITCH_MAX * H), HH = HC + P   // (an even frame, no bob)
      const corr = 0.7 + r() * 20
      const whF = H / corr, wtF = HH - whF / 2
      const y1 = Math.floor(wtF + whF), y0 = Math.ceil(wtF)            // the wall's rows y0 .. y1 - 1 (gfx-world.js castColumns)
      if (y1 + 1 < H && y1 - 1 > HH) {
        expect(rowDistance(y1 + 1, H, HH, HC)).toBeLessThanOrEqual(corr * (1 + 1e-12))     // the floor in front of the wall
        expect(rowDistance(y1 - 1, H, HH, HC)).toBeGreaterThanOrEqual(corr * (1 - 1e-12))  // ... and behind its base
      }
      if (y0 - 1 >= 0 && y0 + 1 < HH) {
        expect(rowDistance(y0 - 1, H, HH, HC)).toBeLessThanOrEqual(corr * (1 + 1e-12))
        expect(rowDistance(y0 + 1, H, HH, HC)).toBeGreaterThanOrEqual(corr * (1 - 1e-12))
      }
    }
  })
  it('level, it is the arithmetic the passes always did', () => {
    for (const [y, H, HH] of [[70, 90, 45], [10, 90, 45], [45, 90, 45], [60, 91, 47]]) {
      expect(rowDistance(y, H, HH, HH)).toBe(y > HH ? (H - HH) / Math.max(1, y - HH) : HH / Math.max(1, HH - y))
    }
  })
})

describe('the CPU world pass: level is unchanged, pitched is the level frame moved by the pitch', () => {
  const cases = [[0, 'legacy'], [0, 'low'], [0, 'high'], [2, 'medium'], [4, 'legacy'], [4, 'high']]
  for (const [lvl, tier] of cases) {
    it(`level ${lvl}, ${tier}`, () => {
      const sc = scene(lvl)
      const pose = sc.cfg.map ? { x: 5.5, y: 8.5, angle: 0.15 } : openPose(sc.isWall, 6, 6)
      const W = 160, H = 90
      const level = world(sc, tier, { ...pose, bobOffset: 0, pitch: 0 })
      // pitch 0, no pitch field, a hand-built fs with no HC: the same bytes
      expect(same(world(sc, tier, { ...pose, bobOffset: 0 }).buf, level.buf)).toBe(true)
      expect(same(world(sc, tier, { ...pose, bobOffset: 0 }, { edit: (f) => { delete f.HC; delete f.tilt } }).buf, level.buf)).toBe(true)
      for (const pitch of [0.2, -0.17, PITCH_MAX, -PITCH_MAX]) {
        const p = world(sc, tier, { ...pose, bobOffset: 0, pitch })
        const P = p.fs.HH - p.fs.HC
        expect(P).toBe(Math.round(pitch * H))
        expect(same(p.buf, level.buf)).toBe(false)
        // every row the two frames share: pitched row y + P is level row y, pixel for pixel. The one exception is the horizon row of a wall:
        // it sits exactly on the boundary between the tile's two middle texel rows ((y - wtF) * TS / whF = TS / 2), and wtF is a different
        // double at another horizon, so that row may round to either (the next texel row: a rounding, not a seam)
        let rows = 0, edge = 0
        for (let y = 0; y < H; y++) {
          const yp = y + P
          if (yp < 0 || yp >= H) continue
          for (let x = 0; x < W; x++) {
            if (p.buf[yp * W + x] === level.buf[y * W + x]) continue
            if (y !== level.fs.HH || !(level.z[x] < 1e8)) throw new Error(`pitch ${pitch}: (${x}, ${yp}) differs from level (${x}, ${y})`)
            edge++
          }
          rows++
        }
        expect(rows).toBe(H - Math.abs(P))
        expect(edge).toBeLessThanOrEqual(W)
        expect(same(p.z, level.z)).toBe(true)                        // the z-buffer (what the sprites test against) is the same
      }
    })
  }
  it('looking up on Level ∅ shows more sky: the rows above the level view\'s top are the top colour (classic and overcast)', () => {
    const sc = scene(4), W = 160, H = 90
    for (const tier of ['legacy', 'high']) {
      const up = world(sc, tier, { x: 5.5, y: 8.5, angle: 0.15, bobOffset: 0, pitch: 0.25 })
      const P = up.fs.HH - up.fs.HC
      expect(P).toBeGreaterThan(10)
      // the sky reaches further down the screen: the row under the level view's horizon is sky now, not floor (where no wall covers it)
      const level = world(sc, tier, { x: 5.5, y: 8.5, angle: 0.15, bobOffset: 0, pitch: 0 })
      let skyCols = 0
      for (let x = 0; x < W; x++) if (level.z[x] > 6) { skyCols++; expect(up.buf[(level.fs.HH + 2) * W + x]).toBe(level.buf[(level.fs.HH + 2 - P) * W + x]) }
      expect(skyCols).toBeGreaterThan(0)
    }
  })
})

describe('the flashlight is held in the hand: it follows the view, not the horizon', () => {
  // a flat grey wall half a unit ahead fills every column, so what the beam adds to a wall pixel is its screen-space profile alone
  const flat = (v) => { const a = new Uint8Array(64 * 64 * 3); a.fill(v); return a }
  const tex = { ts: 64, tmask: 63, walls: { 0: flat(40) }, ceil: flat(40), floor: flat(40), light: flat(40) }   // (dark: the beam never clips at a byte)
  const sc = { cfg: cfgOf(0), tex, isWall: (x) => x >= 1, hooks: {} }
  const W = 96, H = 120, x = 48
  const beam = (pitch) => {
    const pose = { x: 0.5, y: 0.5, angle: 0, bobOffset: 0, pitch }
    const on = world(sc, 'high', pose, { W, H, tex, lights: { flashlight: true } }), off = world(sc, 'high', pose, { W, H, tex })
    const d = new Float64Array(H)
    for (let y = 0; y < H; y++) d[y] = ((on.buf[y * W + x] >>> 8) & 255) - ((off.buf[y * W + x] >>> 8) & 255)
    return { d, HH: on.fs.HH, HC: on.fs.HC }
  }
  it('row for row the beam on the wall is where it was level, while the horizon moved', () => {
    const lv = beam(0)
    let peak = 0
    for (let y = 0; y < H; y++) if (lv.d[y] > lv.d[peak]) peak = y
    expect(lv.d[peak]).toBeGreaterThan(20)                                // the beam is there
    expect(Math.abs(peak - (lv.HC + 0.16 * H))).toBeLessThanOrEqual(4)    // below the centre by the beam's own downward pitch
    for (const pitch of [0.25, -0.25]) {
      const p = beam(pitch)
      expect(Math.abs(p.HH - lv.HH)).toBeGreaterThan(25)
      for (let y = 0; y < H; y++) expect(Math.abs(p.d[y] - lv.d[y]), `pitch ${pitch} row ${y}`).toBeLessThanOrEqual(1)   // (each pixel truncated on its own)
    }
  })
  // Level 2 with its lamps' pools off (only the dark between them, so nothing but the beam changes), the player's light on. A point at
  // height y and distance d is drawn (0.5 - y) / d below the horizon, the beam's centre is 0.16 below the view's: level it lands on the
  // floor about three units out
  const base = cfgOf(2), cfg2 = { ...base, look: { ...(base.look || {}), lighting: { pool: 0 } } }
  const at = (tilt, wx, h = 0, flashlight = true) => {
    const light = createLight(cfg2, {})
    const f = frameState({ cfg: cfg2 }, 'high', { x: 0.5, y: 0.5, angle: 0, bobOffset: 0 }, { light, lights: { flashlight } })
    f.tilt = tilt
    light.prepare(f, sc.tex, () => false, null)
    return light.at(wx, 0.5, h)
  }
  const near = 1.7, mid = 3.5, far = 6.5, farther = 8.5                     // 1.2, 3, 6 and 8 units ahead
  it('light.at on the floor (h 0): looking down brings the beam onto the floor near you, looking up takes it further out', () => {
    expect(at(0, near)).toBeLessThan(2.1)                                         // (inside the clamp: the comparisons below are real)
    expect(at(-0.2, near)).toBeGreaterThan(at(0, near) + 0.2)
    expect(at(0.25, near)).toBeLessThan(at(0, near) - 0.2)
    expect(at(0.1, far)).toBeGreaterThan(at(0, far))
    expect(at(-0.2, far)).toBeLessThan(at(0, far) - 0.1)
    expect(at(0.25, near, 0, false)).toBe(at(0, near, 0, false))                  // without the flashlight the tilt changes no light at all
  })
  it('light.at on a body (what lights the sprites): the beam climbs it as you look up, and a light at its face never darkens it', () => {
    const smiler = FIG.smiler.h, tall = 1
    for (const h of [smiler, tall, PERSON.player.h, ITEM_H]) for (const wx of [near, mid, far, farther]) expect(at(0, wx, h)).toBe(at(0, wx))   // level: what it always was
    // near: the beam is already on the body; looking up slides it up the body and the light holds, all the way to the stop
    for (const h of [smiler, tall]) for (const t of [0.05, 0.2, PITCH_MAX]) expect(at(t, near, h), `h ${h} tilt ${t}`).toBe(at(0, near, h))
    for (const t of [0.05, 0.2, 0.25]) expect(at(t, mid, tall)).toBe(at(0, mid, tall))   // three units out, the beam on its chest: no darker
    // far: level the beam passes under its feet; looking up a little brings it onto the body (brighter), past its top it goes
    expect(at(0.1, far, smiler)).toBeGreaterThan(at(0, far, smiler) + 0.02)
    expect(at(0.15, farther, smiler)).toBeGreaterThan(at(0, farther, smiler) + 0.02)
    expect(at(PITCH_MAX, farther, smiler)).toBeLessThan(at(0.15, farther, smiler) - 0.03)
    expect(at(PITCH_MAX, farther, smiler)).toBeLessThan(at(0, farther, smiler))
    // looking down: the feet are the body's nearest point to a lowered beam, as on the floor
    for (const wx of [near, far]) for (const t of [-0.2, -PITCH_MAX]) expect(at(t, wx, smiler)).toBe(at(t, wx))
    expect(at(-PITCH_MAX, farther, smiler)).toBeLessThan(at(0, farther, smiler) - 0.1)
    // a thing on the floor (an item) leaves the beam as the floor does
    expect(at(0.25, near, ITEM_H)).toBeLessThan(at(0, near, ITEM_H) - 0.2)
    expect(at(0.25, near, smiler, false)).toBe(at(0, near, smiler, false))
  })
  it("flashDv / flashTiltK: level is the feet's old arithmetic exactly, h 0 the floor's at any tilt, and the factor never above 1", () => {
    const r = mulberry32(0xbea4)
    for (let n = 0; n < 3000; n++) {
      const d = 0.05 + r() * 14, h = r() * 1.2, t = (r() * 2 - 1) * PITCH_MAX
      expect(flashDv(d, 0, h)).toBe(0.5 / Math.max(0.5, d) - FLASH_PITCH)
      expect(flashTiltK(d, 0, h)).toBe(1)
      expect(flashDv(d, t, 0)).toBeCloseTo(0.5 / Math.max(0.5, d) + t - FLASH_PITCH, 14)
      const k = flashTiltK(d, t, h)
      expect(k).toBeGreaterThan(0); expect(k).toBeLessThanOrEqual(1)
      if (t > 0) { expect(Math.abs(flashDv(d, t, h))).toBeLessThanOrEqual(Math.abs(flashDv(d, t, 0)) + 1e-12) }   // a body is never further from the beam than its feet
    }
  })
  it("the sprites' flat flashlight boost follows the tilt: looking down at a thing five units out takes it, looking up at a near one keeps it", () => {
    const sc0 = scene(0)
    prewarmSprites(sc0.cfg, 2000)
    const pose = openPose(sc0.isWall, 6, 6)
    const ca = Math.cos(pose.angle), sa = Math.sin(pose.angle)
    const lit = (pitch, dist) => {
      const ents = [{ kind: 'npc', name: 'someone', x: pose.x + ca * dist, y: pose.y + sa * dist }]
      const f = frameState(sc0, 'medium', { ...pose, bobOffset: 0, pitch }, { lights: { flashlight: true } })   // (no light model: the boost alone)
      for (let i = 0; i < 30; i++) planSprites(f, ents)
      const P = planSprites(f, ents)
      let m = 0
      for (let i = 0; i < P.count; i++) if (!P.recs[i].shadow && !P.recs[i].screen) m = Math.max(m, P.recs[i].mr)
      return m
    }
    expect(lit(0, 5)).toBeGreaterThan(0)
    expect(lit(-PITCH_MAX, 5)).toBeLessThan(lit(0, 5) * 0.95)
    for (const p of [0.1, 0.2, PITCH_MAX]) expect(lit(p, 1.5), `pitch ${p}`).toBe(lit(0, 1.5))
  })
})

describe('the sprites stand on the pitched floor', () => {
  it('every layer\'s rows move by exactly the pitch\'s rows; columns, depth, mips and light are the level plan\'s', () => {
    const sc = scene(0)
    prewarmSprites(sc.cfg, 2000)
    const pose = openPose(sc.isWall, 6, 6)
    const ca = Math.cos(pose.angle), sa = Math.sin(pose.angle)
    const ents = [
      { kind: 'prop', type: 'box', x: pose.x + ca * 2.2, y: pose.y + sa * 2.2, rot: 0.3 },
      { kind: 'item', type: 'water', x: pose.x + ca * 1.6 - sa * 0.4, y: pose.y + sa * 1.6 + ca * 0.4 },
      { kind: 'npc', name: 'someone', x: pose.x + ca * 3.5 + sa * 0.5, y: pose.y + sa * 3.5 - ca * 0.5 },
    ]
    const plan = (pitch) => {
      const light = createLight(sc.cfg, {})
      const f = frameState(sc, 'medium', { ...pose, bobOffset: 0, pitch }, { light })
      for (let i = 0; i < 30; i++) planSprites(f, ents)                     // (built and warm)
      const P = planSprites(f, ents)
      return { recs: P.recs.slice(0, P.count).map((r) => ({ X0: r.X0, X1: r.X1, Yt: r.Yt, Yb: r.Yb, depth: r.depth, mip: r.mip, mr: r.mr, A: r.A })), plates: P.plates.map((p) => ({ ...p })), rows: f.HH - f.HC }
    }
    const lv = plan(0)
    expect(lv.recs.length).toBeGreaterThan(3)
    expect(lv.plates.length).toBe(1)
    for (const pitch of [0.15, -0.2]) {
      const p = plan(pitch)
      expect(p.rows).not.toBe(0)
      expect(p.recs.length).toBe(lv.recs.length)
      for (let i = 0; i < p.recs.length; i++) {
        const a = p.recs[i], b = lv.recs[i]
        expect(a.X0).toBe(b.X0); expect(a.X1).toBe(b.X1); expect(a.depth).toBe(b.depth); expect(a.mip).toBe(b.mip); expect(a.mr).toBe(b.mr); expect(a.A).toBe(b.A)
        expect(a.Yt - b.Yt).toBeCloseTo(p.rows, 9); expect(a.Yb - b.Yb).toBeCloseTo(p.rows, 9)
      }
      expect(p.plates[0].sx).toBe(lv.plates[0].sx); expect(p.plates[0].y - lv.plates[0].y).toBeCloseTo(p.rows, 9)    // the name rides over the head
    }
  })
})

describe('the sky', () => {
  const sky = hexToRgb('#9aa6ad'), fog = hexToRgb('#b8b2a0')
  const mk = (over) => ({ W: 96, H: 54, HH: 27, HC: 27, hf: Math.PI / 4.8, skyRgb: sky, fogRgb: fog, flicker: 1, t: 3, player: { angle: 0.4 }, levelKey: '∅', look: undefined,
    quality: { lightDetail: 1 }, light: { enabled: true }, ...over })
  it('a horizon two rows past the largest so far draws every row (the scratch is sized by the frame)', async () => {
    // on a FRESH gfx-sky.js: its scratch lives at module level, and vitest isolates files, not tests, so the Level ∅ frames drawn above have
    // already grown it past every frame of this loop (the old scratch would pass here, read past by nothing). A new module starts it empty
    vi.resetModules()
    const { renderSky: freshSky } = await import('../src/renderer/gfx-sky.js')
    for (let HH = 4; HH < 54; HH++) {
      const f = mk({ HH, HC: HH }), buf = new Uint32Array(96 * 54)
      freshSky(f, buf)
      for (let y = 0; y <= Math.min(HH, 53); y++) for (let x = 0; x < 96; x += 7) expect(buf[y * 96 + x] & 0xffffff, `HH ${HH} row ${y}`).not.toBe(0)
    }
  })
  it('buildSkyRows (the GPU\'s per-row table) moves with the horizon like the CPU rows: row y + P pitched is row y level', () => {
    const W4 = 54 * 2 * 4
    const level = new Float32Array(W4), up = new Float32Array(W4), down = new Float32Array(W4)
    expect(buildSkyRows(mk({}), level, 54)).toBe(28)
    expect(buildSkyRows(mk({ HH: 37 }), up, 54)).toBe(38)
    expect(buildSkyRows(mk({ HH: 17 }), down, 54)).toBe(18)
    for (let y = 0; y <= 27; y++) for (let c = 0; c < 4; c++) {
      expect(up[(y + 10) * 4 + c]).toBe(level[y * 4 + c]); expect(up[(54 + y + 10) * 4 + c]).toBe(level[(54 + y) * 4 + c])
      if (y >= 10) { expect(down[(y - 10) * 4 + c]).toBe(level[y * 4 + c]); expect(down[(54 + y - 10) * 4 + c]).toBe(level[(54 + y) * 4 + c]) }
    }
    // above the level view's top: the top colour (the gradient is clamped there), under the faint stratification of the strip rows it reaches
    for (let y = 0; y < 10; y++) for (let c = 0; c < 3; c++) expect(Math.abs(up[y * 4 + c] / level[c] - 1)).toBeLessThan(0.06)
  })
})

describe('the dust field slides with the tilt and streams out of the horizon, the same on the CPU draw and the GPU step', () => {
  const cfg = { levelIndex: 0, palette: { fog: '#c9c98f' }, particles: { count: 30, color: [235, 228, 190], size: 1.4, sway: 0.35, speed: 0.25 } }
  const fsAt = (i, tilt, walk = 0) => ({
    W: 576, H: 324, OW: 960, OH: 540, t: i / 60, dt: 1 / 60, frame: i, flicker: 1, fov: FOV, hf: FOV / 2, tilt,
    player: { x: 5 + Math.cos(0.3) * walk * i / 60, y: 5 + Math.sin(0.3) * walk * i / 60, angle: 0.3 }, opts: { particles: true }, quality: TIERS.medium,
    levelKey: '0', handled: { flashlight: false, glow: false }, light: { enabled: true }, lights: {}, comfort: { reduceFlicker: false, maxGlobalDip: 0.5 },
  })
  // a 2D context that draws nothing (the positions are what is compared), and a document whose canvases are the same (gfx-gl-post.test.js)
  const noop2d = () => new Proxy({}, { get: (t, k) => (k === 'createRadialGradient' ? () => ({ addColorStop() {} }) : k === 'createImageData' ? (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }) : () => {}), set: () => true })
  const recorder = noop2d
  let realDoc
  beforeEach(() => { realDoc = globalThis.document; globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: noop2d }) } })
  afterEach(() => { globalThis.document = realDoc })
  // three fields seeded alike (the same positions and the same respawn stream)
  const seeded = () => {
    const rnd = mulberry32(7), keep = Math.random; Math.random = () => rnd()
    try { const p = createPostState(cfg); seedParticles(p, 960, 540); return p } finally { Math.random = keep }
  }
  const twins = () => ({ a: seeded(), b: seeded(), c: seeded() })
  it('a tilt of d moves every mote d of the screen height, and the GPU step agrees with the CPU draw', () => {
    const { a, b, c } = twins(), sink = createSink(30)
    const tilt = (i) => (i < 5 ? 0 : i < 9 ? 0.02 * (i - 4) : 0.08)
    for (let i = 1; i <= 12; i++) {
      drawParticlesModern(recorder(), fsAt(i, tilt(i)), a, 1)
      stepModern(b, fsAt(i, tilt(i)), 1, sink)
      drawParticlesModern(recorder(), fsAt(i, 0), c, 1)                    // the same field, never tilted
    }
    let moved = 0
    for (let k = 0; k < a.particles.length; k++) {
      expect(b.particles[k].x).toBeCloseTo(a.particles[k].x, 9); expect(b.particles[k].y).toBeCloseTo(a.particles[k].y, 9)
      if (Math.abs(a.particles[k].x - c.particles[k].x) < 1e-9 && a.particles[k].y > 10 && a.particles[k].y < 530) {   // (none recycled meanwhile)
        expect(a.particles[k].y - c.particles[k].y).toBeCloseTo(0.08 * 540, 6); moved++
      }
    }
    expect(moved).toBeGreaterThan(15)
  })
  it('walking forward they stream out of the horizon, not the centre: a field held tilted is the level one moved by the tilt, mote for mote', () => {
    const T = -0.25, OH = 540
    const { a, b, c } = twins()
    for (const f of [a, b]) for (const p of f.particles) p.y += T * OH
    for (let i = 1; i <= 14; i++) {
      drawParticlesModern(recorder(), fsAt(i, T, 3), a, 1)
      stepModern(b, fsAt(i, T, 3), 1, createSink(30))
      drawParticlesModern(recorder(), fsAt(i, 0, 3), c, 1)
    }
    let kept = 0
    for (let k = 0; k < a.particles.length; k++) {
      expect(b.particles[k].x).toBeCloseTo(a.particles[k].x, 9); expect(b.particles[k].y).toBeCloseTo(a.particles[k].y, 9)
      if (Math.abs(a.particles[k].x - c.particles[k].x) < 1e-9) { expect(a.particles[k].y - c.particles[k].y).toBeCloseTo(T * OH, 6); kept++ }   // (none recycled)
    }
    expect(kept).toBeGreaterThan(10)
  })
  it('walking forward, a mote that streams off the edge re-forms in the middle distance: about the horizon, on the CPU and the GPU alike', () => {
    for (const T of [-0.25, 0.2]) {
      const { a, b } = twins()
      drawParticlesModern(recorder(), fsAt(1, T, 3), a, 1); stepModern(b, fsAt(1, T, 3), 1, createSink(30))
      for (const f of [a, b]) for (const p of f.particles) p.y = -100                           // every mote off the top
      drawParticlesModern(recorder(), fsAt(2, T, 3), a, 1); stepModern(b, fsAt(2, T, 3), 1, createSink(30))
      const cy = 540 * (0.5 + T)
      for (let k = 0; k < a.particles.length; k++) {
        expect(Math.abs(a.particles[k].y - cy)).toBeLessThanOrEqual(540 * 0.3 + 1e-9)
        expect(b.particles[k].y).toBeCloseTo(a.particles[k].y, 9); expect(b.particles[k].x).toBeCloseTo(a.particles[k].x, 9)
      }
    }
  })
  it("airLight: the ceiling fixtures' term rides the horizon (held between none and all of it), the hand-held lights stay on the glass; level, it is what it was", () => {
    const A = createPostState(cfg).atmos.part, OW = 960, OH = 540, o = { L: 0, g: 0 }
    const L = (x, y, lights, t) => (t === undefined ? airLight(x, y, OW, OH, A, lights, null, o) : airLight(x, y, OW, OH, A, lights, null, o, t)).L
    for (let y = -12; y <= OH + 12; y += 9) for (const lights of [{}, { flashlight: true }, { glow: [80, 235, 110] }]) expect(L(300, y, lights, 0)).toBe(L(300, y, lights))
    for (const t of [0.2, -0.25]) for (let y = 30; y <= 400; y += 10) expect(L(480, y + t * OH, {}, t), `tilt ${t} y ${y}`).toBeCloseTo(L(480, y, {}), 12)
    expect(L(480, 0, {}, 0.3)).toBeCloseTo(A.ambient + A.top, 12); expect(L(480, OH, {}, -0.3)).toBeCloseTo(A.ambient, 12)
    for (const t of [0.2, -0.25]) for (const [x, y] of [[480, 280], [200, 100], [700, 500]]) {
      expect(L(x, y, { flashlight: true }, t) - L(x, y, {}, t)).toBeCloseTo(L(x, y, { flashlight: true }) - L(x, y, {}), 12)
    }
  })
  it('a level view moves no mote (the field is the one it always was)', () => {
    const { a, c } = twins()
    for (let i = 1; i <= 12; i++) { drawParticlesModern(recorder(), fsAt(i, 0), a, 1); const f = fsAt(i, 0); delete f.tilt; drawParticlesModern(recorder(), f, c, 1) }
    for (let k = 0; k < a.particles.length; k++) { expect(a.particles[k].x).toBe(c.particles[k].x); expect(a.particles[k].y).toBe(c.particles[k].y) }
  })
})

describe('the CPU bloom: the frames between its recomputes slide the halo with the horizon', () => {
  // a canvas whose tiny read-back has one bright patch in a dark frame (so there is a halo), recording what is drawn
  const rec = () => {
    const calls = []
    return new Proxy({ calls }, {
      get(t, k) {
        if (k in t) return t[k]
        if (k === 'getImageData') return (x, y, w, h) => {
          const d = new Uint8ClampedArray(w * h * 4).fill(18)
          for (const [px, py] of [[5, 2], [6, 2], [5, 3], [6, 3]]) { const o = (py * w + px) * 4; d[o] = d[o + 1] = d[o + 2] = 250 }
          return { data: d }
        }
        if (k === 'createImageData') return (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h })
        return (...a) => { calls.push([k, ...a]) }
      },
      set(t, k, v) { t[k] = v; return true },
    })
  }
  let realDoc
  beforeEach(() => { realDoc = globalThis.document; globalThis.document = { createElement: () => { const c = rec(); return { width: 0, height: 0, getContext: () => c } } } })
  afterEach(() => { globalThis.document = realDoc })
  const fsAt = (t, HH, HC) => ({ W: 96, H: 54, HH, HC, OW: 96, OH: 54, t, dt: 1 / 60, fov: FOV, player: { x: 1, y: 1, angle: 0 }, opts: { bloom: true }, quality: { ...TIERS.high } })
  // -> the composite's drawImage call: [name, image, sx, sy, sw, sh, dx, dy, dw, dh] (no turn here: dx stays 0)
  const halo = (post, fs) => { const w = rec(); drawBloom(w, {}, fs, post); const d = w.calls.filter((c) => c[0] === 'drawImage'); expect(d.length).toBe(1); expect(Math.abs(d[0][6])).toBe(0); return d[0] }
  it("a tilt since the recompute moves it by the pitch's rows; a head-bob, a level frame and an unchanged tilt move it not at all", () => {
    const post = createPostState({ levelIndex: 0, palette: { fog: '#D4C87A' }, particles: { count: 0 } })
    expect(halo(post, fsAt(0, 27, 27))[7]).toBe(0)            // computed level
    expect(halo(post, fsAt(0.01, 33, 27))[7]).toBe(6)         // reused, looking up six rows: down six with the room
    expect(halo(post, fsAt(0.02, 20, 27))[7]).toBe(-7)
    expect(halo(post, fsAt(0.03, 29, 29))[7]).toBe(0)         // a bob moves the centre and the horizon alike: level
    expect(halo(post, fsAt(0.05, 33, 27))[7]).toBe(0)         // recomputed tilted
    expect(halo(post, fsAt(0.06, 35, 29))[7]).toBe(0)         // the same tilt under a bob
    expect(halo(post, fsAt(0.07, 27, 27))[7]).toBe(-6)        // back to level before the next recompute
  })
})

describe('the GPU world pass spells the same y-shear', () => {
  it('uHC is a uniform of every variant, and the pass sets it from fs.HC', () => {
    for (const lit of [false, true]) for (const sky of [false, true]) expect(worldUniformNames({ lit, sky })).toContain('uHC')
    const pass = fs.readFileSync(new URL('../src/renderer/gfx-gl-world.js', import.meta.url), 'utf8')
    expect(pass).toContain('gl.uniform1f(u.uHH, fs.HH); gl.uniform1f(u.uHC, fs.HC ?? fs.HH)')
  })
  it('the span (both shadings), the flashlight\'s row factor and the classic sky\'s gradient are measured from uHC; everything placed, from uHH', () => {
    for (const lit of [false, true]) for (const sky of [false, true]) {
      const src = worldFragmentSource({ lit, sky })
      expect(src).toContain('float span = isFloor ? uRes.y - uHC : uHC;')
      expect(src).toContain('float rowDist = span / max(1.0, isFloor ? y - uHH : uHH - y);')
      expect(src).toContain('float wtF = uHH - whF * 0.5;')
      expect(src).not.toMatch(/uRes\.y - uHH|y \/ uHH/)
      if (lit) expect(src).toContain('float syAt(float y) { float dv = (y - uHC) / uRes.y - uFlashPitch;')
      if (sky) expect(src).toContain('float t = uHC > 0.0 ? clamp((y - (uHH - uHC)) / uHC, 0.0, 1.0) : 1.0;')
    }
  })
})
