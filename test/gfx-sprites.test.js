// gfx-sprites.js — the pure parts of the sprite pass: atlas addressing, frame selection from enemy state, column
// visibility runs, the deterministic software-rasterised frames, and the blitter's contract (per-column depth test,
// floor anchoring, fog, light, flicker, translucency). All of it runs in Node: the rasteriser and the blitter only touch
// typed arrays.
import { describe, it, expect, vi } from 'vitest'
import { createHash } from 'node:crypto'
import {
  STATES, FACINGS, FACING_FRONT, FACING_BACK, FACING_SIDE, ANIM_FRAMES, PROP_SPEC, FIG, PERSON, ITEM_COLORS, SIGHT_SPEC,
  stateIndex, creatureState, apparitionState, animFrame, entityPhase, wrapAngle, headingRel, creatureFacing, headsRight,
  frameIndex, frameKey, variantHash, propVariant, unitJitter, visibleRuns, pickMip,
  getFrame, resetAtlas, atlasStats, drawSprites, packLayer, createPaint, prewarmSprites, NEAR_STATIC, planSprites,
} from '../src/renderer/gfx-sprites.js'

const sha = (a) => createHash('sha256').update(Buffer.from(a.buffer, a.byteOffset, a.byteLength)).digest('hex')
const frameHash = (fr) => sha(Uint32Array.from(fr.layers.flatMap((l) => Array.from(l.mips[0].px))))

const enemy = (over = {}) => ({ x: 0, y: 0, type: 'stalker', variant: 'smiler', state: 'idle', dir: 0, stagger: 0, chunkCx: 3, chunkCy: 5, ...over })

describe('atlas addressing', () => {
  it('frameIndex is unique across every (variant, state, anim, facing) combination', () => {
    const seen = new Set()
    for (let v = 0; v < 3; v++) for (let s = 0; s < STATES.length; s++) for (let a = 0; a < 2; a++) for (let f = 0; f < FACINGS.length; f++) seen.add(frameIndex(v, s, a, f))
    expect(seen.size).toBe(3 * STATES.length * 2 * FACINGS.length)
    expect(Math.min(...seen)).toBe(0)
  })

  it('frameKey names the same address as a readable string', () => {
    expect(frameKey('creature', 'smiler', 0, 'chase', 1, FACING_FRONT)).toBe('creature/smiler/0/chase/1/f')
    expect(frameKey('prop', 'barrel', 2, 'idle', 0, FACING_SIDE)).toBe('prop/barrel/2/idle/0/s')
    expect(frameKey('creature', 'hound', 0, 'stagger', 0, FACING_BACK)).toBe('creature/hound/0/stagger/0/b')
  })

  it('stateIndex maps names to slots and unknown names to idle', () => {
    STATES.forEach((s, i) => expect(stateIndex(s)).toBe(i))
    expect(stateIndex('nonsense')).toBe(0)
  })
})

describe('frame selection from enemy state', () => {
  it('reads state and stagger: a warded creature reels whatever else it was doing', () => {
    expect(creatureState(enemy({ state: 'idle' }))).toBe('idle')
    expect(creatureState(enemy({ state: 'chase' }))).toBe('chase')
    expect(creatureState(enemy({ state: 'flee' }))).toBe('flee')
    expect(creatureState(enemy({ state: 'stagger' }))).toBe('stagger')
    expect(creatureState(enemy({ state: 'chase', stagger: 1.4 }))).toBe('stagger')
    expect(creatureState({ x: 1, y: 1, variant: 'shade' })).toBe('idle')     // an event apparition carries no state
  })

  it('a fast crosser uses the running gait, a slow drop-in drifts', () => {
    expect(apparitionState({ vx: 2.6, vy: 0 })).toBe('flee')
    expect(apparitionState({ vx: 0.7, vy: 0.85 })).toBe('idle')
    expect(apparitionState({})).toBe('idle')
  })

  it('gait frames cycle over time, are per-entity phased, and idle stays on frame 0', () => {
    const chase = stateIndex('chase')
    const seen = new Set()
    for (let t = 0; t < 2; t += 0.05) seen.add(animFrame(chase, t, 0))
    expect([...seen].sort()).toEqual([0, 1])
    for (let t = 0; t < 3; t += 0.1) expect(animFrame(stateIndex('idle'), t, 0.4)).toBe(0)
    expect(ANIM_FRAMES[stateIndex('idle')]).toBe(1)
    // a phase offset moves the cycle
    let differ = 0
    for (let t = 0; t < 2; t += 0.05) if (animFrame(chase, t, 0) !== animFrame(chase, t, 0.5)) differ++
    expect(differ).toBeGreaterThan(5)
  })

  it('entityPhase is stable, in [0,1), and differs between chunks', () => {
    const a = entityPhase(enemy({ chunkCx: 3, chunkCy: 5 })), b = entityPhase(enemy({ chunkCx: 4, chunkCy: 5 }))
    expect(a).toBe(entityPhase(enemy({ chunkCx: 3, chunkCy: 5 })))
    expect(a).toBeGreaterThanOrEqual(0); expect(a).toBeLessThan(1)
    expect(a).not.toBe(b)
    expect(entityPhase({ x: 1, y: 2 })).toBe(entityPhase({ x: 9, y: 9 }))       // a hand-placed one falls back to a constant
  })

  it('wrapAngle folds to (-pi, pi]', () => {
    expect(wrapAngle(0)).toBeCloseTo(0)
    expect(Math.cos(wrapAngle(Math.PI * 3))).toBeCloseTo(-1, 6)
    expect(Math.abs(wrapAngle(Math.PI * 3))).toBeCloseTo(Math.PI, 6)
    expect(Math.abs(wrapAngle(-Math.PI * 2.5) + Math.PI / 2)).toBeLessThan(1e-9)
  })

  it('facing: hunting and reeling creatures face you; idle ones turn to you; only a fleeing one shows its back', () => {
    const cam = [0, 0]
    const toward = { x: 6, y: 0, dir: Math.PI }     // at (6,0) heading west, straight at the camera at the origin
    const away = { x: 6, y: 0, dir: 0 }
    expect(creatureFacing(enemy({ ...toward, state: 'chase' }), ...cam, false)).toBe(FACING_FRONT)
    expect(creatureFacing(enemy({ ...away, state: 'chase' }), ...cam, false)).toBe(FACING_FRONT)
    expect(creatureFacing(enemy({ ...away, state: 'stagger', stagger: 2 }), ...cam, false)).toBe(FACING_FRONT)
    expect(creatureFacing(enemy({ ...away, state: 'idle' }), ...cam, false)).toBe(FACING_FRONT)
    expect(creatureFacing(enemy({ ...away, state: 'flee' }), ...cam, false)).toBe(FACING_BACK)
    expect(creatureFacing(enemy({ ...toward, state: 'flee' }), ...cam, false)).toBe(FACING_FRONT)
  })

  it('low creatures show their profile when they walk across the view, mirrored by the side they head to', () => {
    const across = enemy({ x: 6, y: 0, dir: Math.PI / 2, state: 'idle' })       // heading +y (south)
    expect(creatureFacing(across, 0, 0, true)).toBe(FACING_SIDE)
    expect(creatureFacing(across, 0, 0, false)).toBe(FACING_FRONT)               // a tall one has no profile art
    // camera facing east (angle 0): screen-right is +y, so heading +y is heading right (mirrored); -y is left
    expect(headsRight(enemy({ dir: Math.PI / 2 }), 0)).toBe(true)
    expect(headsRight(enemy({ dir: -Math.PI / 2 }), 0)).toBe(false)
    // turn the camera to face south (angle pi/2): screen-right is -x, so heading -x (dir pi) is heading right
    expect(headsRight(enemy({ dir: Math.PI }), Math.PI / 2)).toBe(true)
    expect(headingRel(enemy({ x: 6, y: 0, dir: Math.PI }), 0, 0)).toBeCloseTo(0, 6)
  })
})

describe('per-instance variation from the seeded rot', () => {
  it('is deterministic and covers every variant', () => {
    expect(variantHash(1.2345)).toBe(variantHash(1.2345))
    const counts = [0, 0, 0]
    for (let i = 0; i < 300; i++) counts[propVariant(i * 0.137, 3)]++
    for (const c of counts) expect(c).toBeGreaterThan(60)
    expect(propVariant(undefined, 3)).toBe(propVariant(0, 3))
  })

  it('jitter stays in [-1, 1] and differs by salt', () => {
    let lo = 1, hi = -1, diff = 0
    for (let i = 0; i < 200; i++) {
      const j = unitJitter(i * 0.37, 11); lo = Math.min(lo, j); hi = Math.max(hi, j)
      if (unitJitter(i * 0.37, 12) !== j) diff++
    }
    expect(lo).toBeGreaterThanOrEqual(-1); expect(hi).toBeLessThanOrEqual(1)
    expect(lo).toBeLessThan(-0.7); expect(hi).toBeGreaterThan(0.7)
    expect(diff).toBeGreaterThan(190)
  })
})

describe('column visibility runs (the per-column depth test)', () => {
  const runs = new Int32Array(64)
  const list = (n) => Array.from({ length: n }, (_, i) => [runs[i * 2], runs[i * 2 + 1]])

  it('everything in front of every wall is one run', () => {
    const z = new Float32Array(20).fill(9)
    expect(visibleRuns(z, 3, 15, 4, runs)).toBe(1)
    expect(list(1)).toEqual([[3, 15]])
  })

  it('a near wall in the middle splits the sprite into two runs', () => {
    const z = new Float32Array(20).fill(9)
    z.fill(2, 8, 11)
    expect(visibleRuns(z, 4, 16, 4, runs)).toBe(2)
    expect(list(2)).toEqual([[4, 8], [11, 16]])
  })

  it('a sprite behind a wall corner keeps only the columns past it', () => {
    const z = new Float32Array(20).fill(1.5); z.fill(9, 12, 20)
    expect(visibleRuns(z, 6, 18, 4, runs)).toBe(1)
    expect(list(1)).toEqual([[12, 18]])
  })

  it('fully hidden is zero runs; a wall exactly at the sprite depth hides it', () => {
    expect(visibleRuns(new Float32Array(10).fill(3), 0, 10, 5, runs)).toBe(0)
    expect(visibleRuns(new Float32Array(10).fill(5), 0, 10, 5, runs)).toBe(0)
    expect(visibleRuns(new Float32Array(10).fill(5.001), 0, 10, 5, runs)).toBe(1)
  })

  it('alternating columns produce one run each', () => {
    const z = new Float32Array(9)
    for (let i = 0; i < 9; i++) z[i] = i & 1 ? 1 : 9
    const big = new Int32Array(40)
    expect(visibleRuns(z, 0, 9, 4, big)).toBe(5)
  })
})

describe('mip choice', () => {
  const mips = [{ h: 128 }, { h: 64 }, { h: 32 }, { h: 16 }, { h: 8 }]
  it('picks the smallest mip that is not below ~85% of the on-screen height', () => {
    expect(pickMip(mips, 400)).toBe(0)
    expect(pickMip(mips, 128)).toBe(0)
    expect(pickMip(mips, 70)).toBe(1)
    expect(pickMip(mips, 30)).toBe(2)
    expect(pickMip(mips, 9)).toBe(4)
    expect(pickMip(mips, 1)).toBe(4)
  })
})

describe('generated frames are deterministic, well-formed and non-empty', () => {
  it('the same address builds byte-identical frames after the atlas is dropped', { timeout: 60000 }, () => {
    const addrs = [['creature', 'smiler', 0, 1, 1, 0], ['creature', 'hound', 0, 0, 0, FACING_SIDE], ['prop', 'barrel', 1, 0, 0, 0], ['item', 'radio'], ['exit', 'portal', 0, 0, 1, 0]]
    const first = addrs.map((a) => frameHash(getFrame(...a)))
    resetAtlas()
    const second = addrs.map((a) => frameHash(getFrame(...a)))
    expect(second).toEqual(first)
  })

  it('variants, states and poses really are different pictures', () => {
    const h = (...a) => frameHash(getFrame(...a))
    expect(h('prop', 'crate', 0)).not.toBe(h('prop', 'crate', 1))
    expect(h('prop', 'crate', 1)).not.toBe(h('prop', 'crate', 2))
    const idle = h('creature', 'smiler', 0, 0, 0, 0), chase = h('creature', 'smiler', 0, 1, 0, 0), stag = h('creature', 'smiler', 0, 3, 0, 0)
    expect(new Set([idle, chase, stag]).size).toBe(3)
    expect(h('creature', 'smiler', 0, 1, 0, 0)).not.toBe(h('creature', 'smiler', 0, 1, 1, 0))     // the two gait frames
    expect(h('creature', 'hound', 0, 0, 0, FACING_FRONT)).not.toBe(h('creature', 'hound', 0, 0, 0, FACING_SIDE))
    expect(h('person', 'player', 0, 0, 0, 0)).not.toBe(h('person', 'npc', 0, 0, 0, 0))
  })

  it('getFrame memoises: the same object comes back and the counters do not grow', () => {
    const a = getFrame('prop', 'chair', 0)
    const before = atlasStats().frames
    expect(getFrame('prop', 'chair', 0)).toBe(a)
    expect(atlasStats().frames).toBe(before)
  })

  function checkFrame(fr, label) {
    expect(fr.layers.length, label).toBeGreaterThan(0)
    let opaque = 0
    for (const lay of fr.layers) {
      expect(lay.x1, label).toBeGreaterThan(lay.x0)
      expect(lay.y1, label).toBeGreaterThan(lay.y0)
      const top = lay.mips[0]
      expect(top.px).toBeInstanceOf(Uint32Array)
      expect(top.px.length).toBe(top.w * top.h)
      for (let m = 1; m < lay.mips.length; m++) expect(lay.mips[m].w).toBe(lay.mips[m - 1].w >> 1)
      if (lay.mode === 0 && !lay.floor) {
        // premultiplied: no colour channel may exceed the alpha channel
        for (let i = 0; i < top.px.length; i++) {
          const p = top.px[i], a = p >>> 24
          if ((p & 255) > a + 1 || ((p >> 8) & 255) > a + 1 || ((p >> 16) & 255) > a + 1) { expect.fail(`${label}: pixel ${i} not premultiplied`); break }
          if (a > 200) opaque++
        }
      }
    }
    return opaque
  }

  it('every prop type paints a sensible, non-empty picture (three variants)', () => {
    for (const name of Object.keys(PROP_SPEC)) {
      for (let v = 0; v < 3; v++) {
        const opaque = checkFrame(getFrame('prop', name, v), `prop ${name} v${v}`)
        if (name !== 'papers') expect(opaque, `prop ${name} v${v} is nearly empty`).toBeGreaterThan(60)
      }
    }
  }, 60000)

  it('every creature variant paints in every state (and a profile for the low ones)', () => {
    for (const name of Object.keys(FIG)) {
      for (let s = 0; s < STATES.length; s++) {
        const n = ANIM_FRAMES[s]
        for (let a = 0; a < n; a++) {
          const fr = getFrame('creature', name, 0, s, a, FACING_FRONT)
          expect(checkFrame(fr, `creature ${name} ${STATES[s]} ${a}`) + (name === 'thin' ? 1e3 : 0)).toBeGreaterThan(200)
        }
      }
    }
    for (const low of ['hound', 'crawler']) for (const s of [0, 1]) checkFrame(getFrame('creature', low, 0, s, 0, FACING_SIDE), `${low} side`)
  }, 120000)

  it('a creature frame is [lit body, emissive tells]; the emissive layer is screen-blended and self-lit', () => {
    const fr = getFrame('creature', 'smiler', 0, 0, 0, 0)
    expect(fr.layers[0].mode).toBe(0); expect(fr.layers[0].emit).toBe(0)
    expect(fr.layers[1].mode).toBe(1); expect(fr.layers[1].emit).toBe(1)
    expect(getFrame('creature', 'tesla', 0, 0, 0, 0).layers.length).toBeGreaterThanOrEqual(4)    // body, tells, three arc banks
    expect(getFrame('creature', 'shade', 0, 0, 0, 0).layers.length).toBe(1)                        // the shade has no tell
  })

  it('people, items, notes, machines, sights and the exit all have art', () => {
    for (const p of Object.keys(PERSON)) for (const s of [0, 1]) checkFrame(getFrame('person', p, 0, s, 0, 0), `person ${p}`)
    for (const it of Object.keys(ITEM_COLORS)) expect(getFrame('item', it).layers.length).toBe(3)
    expect(getFrame('note', 'unread').layers.length).toBe(2)
    expect(getFrame('note', 'read').layers.length).toBe(1)
    expect(getFrame('machine', 'lit').layers.length).toBeGreaterThan(getFrame('machine', 'spent').layers.length)
    for (const s of Object.keys(SIGHT_SPEC)) checkFrame(getFrame('sight', s, 0, 0, 0, 0), `sight ${s}`)
    const ex = getFrame('exit', 'portal', 0, 0, 0, 0)
    expect(ex.layers.length).toBe(4)
    expect(ex.layers[0].floor).toBe(true)
  })

  it('packLayer builds a premultiplied mip chain that halves each level', () => {
    const P = createPaint(16, 16)
    for (let i = 0; i < 16 * 16; i++) { P.px[i * 4] = 100; P.px[i * 4 + 1] = 50; P.px[i * 4 + 2] = 25; P.px[i * 4 + 3] = 1 }
    const l = packLayer(P, -0.1, 0.1, 0, 0.2)
    expect(l.mips.map((m) => m.w)).toEqual([16, 8, 4])
    expect(l.mips[0].px[0] >>> 24).toBe(255)
    expect(l.mips[1].px[0] & 255).toBe(100)
  })
})

// ── the blitter's contract, through drawSprites ─────────────────────────────────────────────────
const FOV = Math.PI / 2.4
function scene(over = {}) {
  const W = 200, H = 120
  const buf = new Uint32Array(W * H).fill(((255 << 24) | (60 << 16) | (170 << 8) | 210) >>> 0)     // a flat pale-yellow background
  const z = new Float32Array(W).fill(30)
  const fs = {
    W, H, HH: H >> 1, fog: 16, fogRgb: [212, 200, 122], flicker: 1, t: 0.4, hf: FOV / 2, fov: FOV,
    player: { x: 0, y: 0, angle: 0 }, opts: {}, lights: {}, ...over,
  }
  return { W, H, buf, z, fs }
}
const bg = () => ((255 << 24) | (60 << 16) | (170 << 8) | 210) >>> 0
const changed = (S) => { let n = 0; for (let i = 0; i < S.buf.length; i++) if (S.buf[i] !== bg()) n++; return n }
const bounds = (S) => {
  let x0 = 1e9, x1 = -1, y0 = 1e9, y1 = -1
  for (let y = 0; y < S.H; y++) for (let x = 0; x < S.W; x++) if (S.buf[y * S.W + x] !== bg()) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y) }
  return { x0, x1, y0, y1 }
}
const lum = (p) => (p & 255) + ((p >> 8) & 255) + ((p >> 16) & 255)
const propAt = (d, type = 'crate', rot = 5.6, lat = 0) => ({ kind: 'prop', type, x: d, y: lat, rot, key: 'k' })

describe('drawSprites: placement', () => {
  it('draws nothing for an empty list and returns an empty nameplate array', () => {
    const S = scene()
    expect(drawSprites(S.buf, S.z, S.fs, [])).toEqual([])
    expect(drawSprites(S.buf, S.z, S.fs, undefined)).toEqual([])
    expect(changed(S)).toBe(0)
  })

  it('stands the sprite ON the floor line, centred, and it grows as it nears (perpendicular projection)', () => {
    const S = scene()
    drawSprites(S.buf, S.z, S.fs, [propAt(4)])
    const b = bounds(S)
    const floorRow = S.fs.HH + S.H / (2 * 4)
    expect(b.y1).toBeGreaterThanOrEqual(Math.floor(floorRow) - 3); expect(b.y1).toBeLessThanOrEqual(Math.ceil(floorRow) + 1)     // the base (and its soft shadow) sits on the floor
    expect((b.x0 + b.x1) / 2).toBeGreaterThan(S.W / 2 - 4); expect((b.x0 + b.x1) / 2).toBeLessThan(S.W / 2 + 4)
    const S2 = scene()
    drawSprites(S2.buf, S2.z, S2.fs, [propAt(2)])
    const b2 = bounds(S2)
    expect(b2.y1 - b2.y0).toBeGreaterThan((b.y1 - b.y0) * 1.6)
  })

  it('an off-axis sprite is anchored with its PERPENDICULAR depth, not its straight-line distance', () => {
    // a prop 4 ahead and 3 to the side (distance 5) must still meet the floor at the row of depth 4
    const S = scene()
    drawSprites(S.buf, S.z, S.fs, [propAt(4, 'crate', 5.6, 1.4)])
    const b = bounds(S)
    const row4 = S.fs.HH + S.H / (2 * 4)
    expect(Math.abs(b.y1 - row4)).toBeLessThan(4)
    expect(b.x0).toBeGreaterThan(S.W / 2)          // to the right of centre
  })

  it('culls what is behind the player, beyond the fog, and far off to the side', () => {
    const S = scene()
    drawSprites(S.buf, S.z, S.fs, [propAt(-3), propAt(17), propAt(3, 'crate', 5.6, 40)])
    expect(changed(S)).toBe(0)
  })

  it('a tall creature is anchored on the floor: its feet, not its middle, sit at the floor line', () => {
    const S = scene()
    drawSprites(S.buf, S.z, S.fs, [enemy({ variant: 'lurker', x: 4, y: 0, state: 'idle' })])
    const b = bounds(S)
    const row4 = S.fs.HH + S.H / (2 * 4)
    expect(b.y1).toBeLessThanOrEqual(Math.ceil(row4) + 2)
    expect(b.y1).toBeGreaterThan(Math.floor(row4) - 4)
    expect(S.fs.HH - b.y0).toBeGreaterThan(10)    // the lurker rises well above the horizon
  })
})

describe('drawSprites: the near cull', () => {
  // static bodies are solid, so the camera can never be inside one: they draw down to NEAR_STATIC; what moves keeps the old 0.35
  it('NEAR_STATIC is 0.15', () => { expect(NEAR_STATIC).toBe(0.15) })

  // planSprites(...).sprites is how many entities survived the cull (the plan is reused: read it at once)
  const kept = (e) => planSprites(scene().fs, [e]).sprites

  it('keeps a prop at fwd 0.2 and drops a creature at fwd 0.2', () => {
    expect(kept(propAt(0.2))).toBe(1)
    expect(kept(enemy({ variant: 'lurker', x: 0.2, y: 0, state: 'idle' }))).toBe(0)
    expect(kept(enemy({ variant: 'lurker', x: 0.4, y: 0, state: 'idle' }))).toBe(1)
  })

  it('a prop at fwd 0.1 is dropped; a machine, a sight and a lost soul at fwd 0.2 are kept; a remote player at 0.2 is not', () => {
    expect(kept(propAt(0.1))).toBe(0)
    expect(kept(propAt(NEAR_STATIC))).toBe(1)
    expect(kept(propAt(NEAR_STATIC - 1e-6))).toBe(0)
    expect(kept({ kind: 'machine', x: 0.2, y: 0, vended: false, key: 'm' })).toBe(1)
    expect(kept({ kind: 'sight', x: 0.2, y: 0, sightType: 'payphone', key: 's' })).toBe(1)
    expect(kept({ kind: 'npc', x: 0.2, y: 0, name: 'a lost soul', key: 'n' })).toBe(1)
    expect(kept({ kind: 'player', x: 0.2, y: 0, name: 'ann', angle: 0 })).toBe(0)
    expect(kept({ kind: 'player', x: 0.4, y: 0, name: 'ann', angle: 0 })).toBe(1)
    expect(kept({ kind: 'item', x: 0.2, y: 0, itemType: 'radio', key: 'i' })).toBe(0)        // items and notes are not bodies: 0.35 stays
    expect(kept({ kind: 'exit', x: 0.2, y: 0, target: 1, key: 'e' })).toBe(0)
  })
})

describe('drawSprites: per-column occlusion', () => {
  it('only the columns whose wall is farther than the sprite are painted (props included)', () => {
    const S = scene()
    // a wall 2 ahead covers the LEFT half of the screen; the prop stands 5 ahead, centred
    S.z.fill(2, 0, S.W / 2)
    drawSprites(S.buf, S.z, S.fs, [propAt(5)])
    const b = bounds(S)
    expect(b.x0).toBeGreaterThanOrEqual(S.W / 2)             // nothing bled across the near wall
    expect(changed(S)).toBeGreaterThan(20)                    // ...but the visible half is drawn (the old code drew all or nothing)
    // and the same for a creature
    const S2 = scene()
    S2.z.fill(2, 0, S2.W / 2)
    drawSprites(S2.buf, S2.z, S2.fs, [enemy({ variant: 'shade', x: 4, y: 0 })])
    expect(bounds(S2).x0).toBeGreaterThanOrEqual(S2.W / 2)
    expect(changed(S2)).toBeGreaterThan(20)
  })

  it('a sprite whose centre is hidden still shows the sliver that is not', () => {
    const S = scene()
    S.z.fill(2, 0, S.W / 2 + 3)                                // hides the centre column and a few beyond it
    drawSprites(S.buf, S.z, S.fs, [propAt(5, 'couch')])
    expect(changed(S)).toBeGreaterThan(10)
    expect(bounds(S).x0).toBeGreaterThanOrEqual(S.W / 2 + 3)
  })

  it('a fully hidden sprite paints nothing', () => {
    const S = scene()
    S.z.fill(2)
    drawSprites(S.buf, S.z, S.fs, [propAt(5), enemy({ variant: 'smiler', x: 5, y: 0 })])
    expect(changed(S)).toBe(0)
  })
})

describe('drawSprites: fog, light, flicker, translucency', () => {
  const body = (S) => { const b = bounds(S); return S.buf[Math.round((b.y0 + b.y1) / 2) * S.W + Math.round((b.x0 + b.x1) / 2)] }

  it('a sprite in the far fog has become the fog colour; up close it keeps its own', () => {
    const near = scene(); drawSprites(near.buf, near.z, near.fs, [propAt(2.5, 'crate')])
    const far = scene(); drawSprites(far.buf, far.z, far.fs, [propAt(15.5, 'cabinet-e')])
    const fog = [212, 200, 122]
    const px = body(far), r = px & 255, g = (px >> 8) & 255, b = (px >> 16) & 255
    // 15.5 of 16: within ~10% of the fog colour on each channel
    expect(Math.abs(r - fog[0])).toBeLessThan(26); expect(Math.abs(g - fog[1])).toBeLessThan(26); expect(Math.abs(b - fog[2])).toBeLessThan(26)
    const n = body(near)
    expect(lum(n)).toBeLessThan(lum(px) - 60)                  // the near crate is much darker than fog
  })

  it('fs.light dims a sprite, a missing or disabled light model is ambient 1', () => {
    const plain = scene(); drawSprites(plain.buf, plain.z, plain.fs, [propAt(3, 'cabinet')])
    const off = scene({ light: { enabled: false, at: () => 0.2, tint: () => [1, 1, 1], nearest: () => null } }); drawSprites(off.buf, off.z, off.fs, [propAt(3, 'cabinet')])
    const dark = scene({ light: { enabled: true, at: () => 0.3, tint: () => [1, 1, 1], nearest: () => null } }); drawSprites(dark.buf, dark.z, dark.fs, [propAt(3, 'cabinet')])
    expect(sha(off.buf)).toBe(sha(plain.buf))
    expect(lum(body(dark))).toBeLessThan(lum(body(plain)) * 0.75)
  })

  it('fs.flicker dims sprites like it dims the world', () => {
    const a = scene(); drawSprites(a.buf, a.z, a.fs, [propAt(3, 'cabinet')])
    const b = scene({ flicker: 0.4 }); drawSprites(b.buf, b.z, b.fs, [propAt(3, 'cabinet')])
    expect(lum(body(b))).toBeLessThan(lum(body(a)) * 0.7)
  })

  it('a thin drop-in stays see-through: the background shows through its body', () => {
    const S = scene()
    drawSprites(S.buf, S.z, S.fs, [{ x: 3, y: 0, variant: 'thin', vx: 0.2, vy: 0.4 }])
    const b = bounds(S)
    let close = 0, total = 0
    for (let y = b.y0; y <= b.y1; y++) for (let x = b.x0; x <= b.x1; x++) {
      const p = S.buf[y * S.W + x]
      if (p === bg()) continue
      total++
      const d = Math.abs((p & 255) - 210) + Math.abs(((p >> 8) & 255) - 170) + Math.abs(((p >> 16) & 255) - 60)
      if (d < 200) close++          // an opaque pale-blue body on this yellow would differ by far more
    }
    expect(total).toBeGreaterThan(200)
    expect(close / total).toBeGreaterThan(0.85)
    // ...whereas a shade is opaque: its body is much darker than the background
    const S2 = scene()
    drawSprites(S2.buf, S2.z, S2.fs, [enemy({ variant: 'shade', x: 3, y: 0 })])
    const b2 = bounds(S2)
    const mid = S2.buf[Math.round((b2.y0 + b2.y1) / 2) * S2.W + Math.round((b2.x0 + b2.x1) / 2)]
    expect(lum(mid)).toBeLessThan(lum(bg()) * 0.55)
  })

  it('the exit keeps a cold blue cast and a note a warm one: they are never confused', () => {
    const S = scene()
    S.buf.fill(((255 << 24) | (30 << 16) | (30 << 8) | 30) >>> 0)         // a dark ground so the glows show
    S.fs.fogRgb = [40, 40, 40]
    drawSprites(S.buf, S.z, S.fs, [{ kind: 'exit', x: 4, y: -0.5, target: 1, key: 'e' }, { kind: 'note', x: 3, y: 0.9, read: false, frag: 1, key: 'n' }])
    let coldR = 0, coldB = 0, warmR = 0, warmB = 0
    for (let y = 0; y < S.H; y++) for (let x = 0; x < S.W; x++) {
      const p = S.buf[y * S.W + x]
      if (p === (((255 << 24) | (30 << 16) | (30 << 8) | 30) >>> 0)) continue
      const r = p & 255, b = (p >> 16) & 255
      if (x < S.W / 2) { coldR += r; coldB += b } else { warmR += r; warmB += b }
    }
    expect(coldB).toBeGreaterThan(coldR)      // left of centre: the exit is bluer than red
    expect(warmR).toBeGreaterThan(warmB)      // right of centre: the note is redder than blue
  })
})

describe('drawSprites: entity kinds, nameplates, robustness', () => {
  it('draws every kind without throwing and returns nameplates for named people only', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const S = scene()
    const ents = [
      propAt(4), { kind: 'item', itemType: 'polaroid', x: 3, y: 0.5, key: 'i' }, { kind: 'exit', x: 6, y: -1, target: 2, key: 'x' },
      { kind: 'note', x: 3, y: -0.6, read: true, frag: 3, key: 'n' }, { kind: 'machine', x: 5, y: 1.2, vended: true, key: 'm' },
      { kind: 'sight', sightType: 'payphone', x: 6, y: 2, key: 's' }, { kind: 'sight', sightType: 'nonsense', x: 6, y: -2, key: 's2' },
      { kind: 'player', x: 4, y: -1.4, name: 'moss', angle: 0, hp: 50, chatText: 'hi' }, { kind: 'npc', x: 5, y: 0.2, name: 'a lost soul', key: 'l' },
      enemy({ variant: 'unknown-variant', x: 7, y: 0.3 }), { x: 3, y: 1, variant: 'lurker', vx: 2.6, vy: 0 },
      propAt(5, 'no-such-prop'), { kind: 'item', itemType: 'nope', x: 3.5, y: -0.2 },
    ]
    const plates = drawSprites(S.buf, S.z, S.fs, ents)
    expect(err).not.toHaveBeenCalled()
    err.mockRestore()
    expect(plates.map((p) => p.name).sort()).toEqual(['a lost soul', 'moss'])
    const moss = plates.find((p) => p.name === 'moss')
    expect(moss.speech).toBe('hi'); expect(moss.hp).toBe(50)
    expect(moss.alpha).toBeGreaterThan(0); expect(moss.y).toBeGreaterThan(0)
    expect(changed(S)).toBeGreaterThan(500)
  }, 60000)

  it('is deterministic for the same input', () => {
    const run = () => { const S = scene(); drawSprites(S.buf, S.z, S.fs, [propAt(3), enemy({ variant: 'hound', x: 5, y: 1 }), { kind: 'exit', x: 6, y: -1, target: 1 }]); return sha(S.buf) }
    expect(run()).toBe(run())
  })

  it('a chasing creature and a staggered one of the same kind do not look identical', () => {
    const draw = (over) => { const S = scene(); drawSprites(S.buf, S.z, S.fs, [enemy({ variant: 'smiler', x: 3, y: 0, ...over })]); return sha(S.buf) }
    const idle = draw({ state: 'idle' }), chase = draw({ state: 'chase', dir: Math.PI }), stag = draw({ state: 'stagger', stagger: 2 })
    expect(new Set([idle, chase, stag]).size).toBe(3)
  })

  it('animates from fs.t only: the same time gives the same pixels, a later time moves the sprite', () => {
    const at = (t) => { const S = scene({ t }); drawSprites(S.buf, S.z, S.fs, [enemy({ variant: 'shade', x: 3, y: 0, state: 'chase', dir: Math.PI })]); return sha(S.buf) }
    expect(at(1.0)).toBe(at(1.0))
    expect(at(1.0)).not.toBe(at(1.35))
  })

  it('the rim light path only engages when the light model is live and reports an emitter', () => {
    const emitter = { enabled: true, at: () => 1, tint: () => [1, 1, 1], nearest: () => ({ x: 6, y: -2, dist: 3, r: 255, g: 230, b: 170 }) }
    const a = scene(); drawSprites(a.buf, a.z, a.fs, [enemy({ variant: 'shade', x: 3, y: 0 })])
    const b = scene({ light: emitter }); drawSprites(b.buf, b.z, b.fs, [enemy({ variant: 'shade', x: 3, y: 0 })])
    const c = scene({ opts: { spriteLightOverride: emitter } }); drawSprites(c.buf, c.z, c.fs, [enemy({ variant: 'shade', x: 3, y: 0 })])
    expect(sha(b.buf)).not.toBe(sha(a.buf))
    expect(sha(c.buf)).toBe(sha(b.buf))
  })
})

describe('frame generation is budgeted and can be warmed', () => {
  it('a call that has already spent its generation budget leaves the next cold sprite for the following call', () => {
    resetAtlas()
    let t = 0
    const spy = vi.spyOn(performance, 'now').mockImplementation(() => (t += 20))       // every frame "takes" 20 ms to build
    const S = scene()
    const far = propAt(6, 'chair'), near = propAt(2.5, 'barrel', 5.6, 0)
    drawSprites(S.buf, S.z, S.fs, [far, near])          // far first (painter order): builds the chair, budget gone, barrel waits
    const afterFirst = changed(S)
    const b1 = bounds(S)
    expect(afterFirst).toBeGreaterThan(0)
    expect(b1.y1 - b1.y0).toBeLessThan(S.H / 4)          // only the small far chair is on screen
    drawSprites(S.buf, S.z, S.fs, [far, near])          // the barrel's frame was queued at the front: it is built and drawn now
    const b2 = bounds(S)
    expect(b2.y1 - b2.y0).toBeGreaterThan(b1.y1 - b1.y0)
    spy.mockRestore()
  })

  it('under a frozen clock (the harness) nothing is ever deferred: every sprite is drawn on its first call', () => {
    resetAtlas()
    const spy = vi.spyOn(performance, 'now').mockImplementation(() => 1234)
    const ents = [propAt(6, 'chair'), propAt(2.5, 'barrel', 5.6, 0), propAt(4, 'cabinet', 5.4, -1.2)]
    let sum = 0
    for (const e of ents) { resetAtlas(); const S1 = scene(); drawSprites(S1.buf, S1.z, S1.fs, [e]); sum += changed(S1) }
    resetAtlas()
    const S = scene()
    drawSprites(S.buf, S.z, S.fs, ents)
    expect(changed(S)).toBeGreaterThan(sum * 0.8)          // (a little less than the sum: overlaps)
    spy.mockRestore()
  })

  it('prewarmSprites builds a level cast up front, and the atlas then answers from memory', () => {
    resetAtlas()
    const n = prewarmSprites({ props: { types: ['chair', 'cone'] }, items: { types: ['radio'] }, exit: {}, entities: { enabled: true, stalkerVariants: ['smiler'], wandererVariants: ['watcher'] } }, 1e9)
    expect(n).toBeGreaterThanOrEqual(2 * 3 + 1 + 1 + 6)
    const built = atlasStats().frames
    const a = getFrame('prop', 'chair', 2), b = getFrame('creature', 'smiler', 0, 1, 0, 0)
    expect(atlasStats().frames).toBe(built)
    expect(a.layers.length).toBeGreaterThan(0); expect(b.layers.length).toBe(2)
    expect(prewarmSprites(null)).toBe(0)
  })

  it('the first draw of a level queues its cast, built one frame per call, also on a slow frame', () => {
    resetAtlas()
    const S = scene({ levelKey: '2', dt: 1 / 60 })
    const ent = [propAt(4, 'valve')]
    drawSprites(S.buf, S.z, S.fs, ent)
    const f1 = atlasStats().frames
    let f2 = f1
    for (let i = 0; i < 40 && f2 === f1; i++) { drawSprites(S.buf, S.z, S.fs, ent); f2 = atlasStats().frames }   // an expensive warm frame buys a few calls of rest
    expect(f2).toBeGreaterThan(f1)
    // a slow frame (dt over 24 ms) still warms (SPR-03: it used to never warm on slow devices), just with more rest between frames
    const slow = scene({ levelKey: '2', dt: 0.05 })
    let f3 = f2
    for (let i = 0; i < 60 && f3 === f2; i++) { drawSprites(slow.buf, slow.z, slow.fs, ent); f3 = atlasStats().frames }
    expect(f3).toBeGreaterThan(f2)
  })
})
