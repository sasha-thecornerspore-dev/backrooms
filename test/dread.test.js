// dread.js — what you hear before you see it. Dread is summed over path distance (pathfield.js) only, so a thing behind a wall weighs
// nothing; pending, reeling and hunting things are skipped (the hunt has its own heart). The teller plays a creature's own sound from
// where it is, out of sight, between 7 cells and the reach, never twice inside 3.5 s. Weights, reach and skips, the HUNTING copy, the
// chunk wall, then the teller's cadence, gap, chance, band, sight, gain and pan.
import { describe, it, expect } from 'vitest'
import { DREAD_R, DREAD_W, TELL, HUNTING as DREAD_HUNTING, dreadFrom, dreadNear, createTeller } from '../src/renderer/dread.js'
import { HUNTING, deriveState } from '../src/renderer/hunt.js'
import { VARIANT_SPEC, VARIANT_PHASES } from '../src/renderer/variants.js'
import { createPathField } from '../src/renderer/pathfield.js'
import { CHUNK_SIZE } from '../src/renderer/world.js'

const N = CHUNK_SIZE

// a world as a chunk cache (wall(ix, iy) -> solid), each chunk cut once
function fakeCache(wall) {
  const chunks = new Map()
  return {
    getChunk(cx, cy) {
      const k = `${cx},${cy}`
      if (!chunks.has(k)) {
        const c = new Uint8Array(N * N)
        for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) c[y * N + x] = wall(cx * N + x, cy * N + y) ? 1 : 0
        chunks.set(k, c)
      }
      return chunks.get(k)
    },
  }
}
const room = () => false
function fieldAt(ix, iy, wall = room) { const f = createPathField(); f.build(ix, iy, fakeCache(wall)); return f }
const thing = (x, y, variant = 'shade', extra = {}) => ({ x, y, variant, ai: 'roam', pending: 0, stagger: 0, los: false, ...extra })
const mkOut = () => ({ dread: 0, x: 0, y: 0, variant: null, d: -1, los: false })
const P = { x: 11.5, y: 11.5, angle: 0 }

describe('the tables', () => {
  it('DREAD_R is 24 path cells; the weights and the tells, one per kind of creature', () => {
    expect(DREAD_R).toBe(24)
    expect(DREAD_W).toEqual({ shade: 0.4, smiler: 0.5, hound: 0.6, lurker: 0.6, watcher: 0.4, crawler: 0.3, tesla: 0.5 })
    expect(TELL).toEqual({ smiler: 'click', hound: 'pant', lurker: 'drip', tesla: 'buzz', crawler: 'rasp', watcher: 'hush', shade: 'thump' })
    expect(Object.keys(DREAD_W).sort()).toEqual(Object.keys(VARIANT_SPEC).sort())
    expect(Object.keys(TELL).sort()).toEqual(Object.keys(VARIANT_SPEC).sort())
    expect(Object.isFrozen(DREAD_W)).toBe(true)
    expect(Object.isFrozen(TELL)).toBe(true)
  })

  it('HUNTING is hunt.js\'s, copied: the same phases, every one a real phase', () => {
    expect([...DREAD_HUNTING].sort()).toEqual([...HUNTING].sort())
    for (const ph of DREAD_HUNTING) expect(VARIANT_PHASES).toContain(ph)
  })
})

describe('dreadFrom', () => {
  it('one creature weighs DREAD_W / (1 + d / 6) at its path distance, and is named', () => {
    const f = fieldAt(11, 11)
    const out = mkOut()
    expect(dreadFrom([thing(17.5, 11.5, 'shade')], f, P, out)).toBe(out)
    expect(out.dread).toBeCloseTo(0.4 / 2, 12)
    expect(out).toMatchObject({ x: 17.5, y: 11.5, variant: 'shade', d: 6, los: false })
    for (const v of Object.keys(DREAD_W)) {
      dreadFrom([thing(11.5, 23.5, v)], f, P, out)
      expect(out.dread).toBeCloseTo(DREAD_W[v] / (1 + 12 / 6), 12)
      expect(out.variant).toBe(v)
    }
  })

  it('reaches exactly DREAD_R path cells: 24 counts, 25 does not, off the field does not', () => {
    const f = fieldAt(11, 11)
    const out = mkOut()
    dreadFrom([thing(11.5 + 24, 11.5, 'hound')], f, P, out)
    expect(out.d).toBe(24)
    expect(out.dread).toBeCloseTo(0.6 / 5, 12)
    dreadFrom([thing(11.5 + 24, 12.5, 'hound')], f, P, out)        // in the window, 25 cells off
    expect(out.dread).toBe(0)
    expect(out.d).toBe(-1)
    expect(out.variant).toBe(null)
    dreadFrom([thing(80.5, 11.5, 'hound')], f, P, out)
    expect(out.dread).toBe(0)
  })

  it('sums every contributor, clamps at 1, and names the nearest', () => {
    const f = fieldAt(11, 11)
    const out = mkOut()
    dreadFrom([thing(20.5, 11.5, 'shade'), thing(14.5, 11.5, 'tesla', { los: true }), thing(11.5, 2.5, 'crawler')], f, P, out)
    expect(out.dread).toBeCloseTo(0.4 / (1 + 9 / 6) + 0.5 / (1 + 3 / 6) + 0.3 / (1 + 9 / 6), 12)
    expect(out).toMatchObject({ x: 14.5, y: 11.5, variant: 'tesla', d: 3, los: true })
    const pack = [0, 1, 2, 3].map((k) => thing(12.5 + k, 11.5, 'hound'))
    dreadFrom(pack, f, P, out)
    expect(out.dread).toBe(1)
    expect(out.d).toBe(1)
  })

  it('skips what is still arriving, what reels and what hunts you; a roaming one beside them still counts', () => {
    const f = fieldAt(11, 11)
    const out = mkOut()
    const skipped = [
      thing(13.5, 11.5, 'hound', { pending: 0.4 }),
      thing(13.5, 11.5, 'hound', { stagger: 1.2 }),
      thing(13.5, 11.5, 'hound', { ai: 'stagger' }),
      ...[...HUNTING].map((ai) => thing(13.5, 11.5, 'hound', { ai })),
    ]
    for (const e of skipped) {
      dreadFrom([e], f, P, out)
      expect(out.dread).toBe(0)
      expect(dreadNear([e], P)).toBe(false)
    }
    // every skipped one is reeling or hunting by hunt.js's own reading, or not here yet
    for (const e of skipped) expect(e.pending > 0 || deriveState({ ...e, holdT: 0 }) === 'stagger' || HUNTING.has(e.ai)).toBe(true)
    dreadFrom([...skipped, thing(17.5, 11.5, 'watcher', { ai: 'search' })], f, P, out)
    expect(out.dread).toBeCloseTo(0.4 / 2, 12)
    expect(out.variant).toBe('watcher')
    for (const ai of ['roam', 'alert', 'investigate', 'search', 'turning', 'retreat', 'shadow', 'still']) {
      dreadFrom([thing(17.5, 11.5, 'shade', { ai })], f, P, out)
      expect(out.dread).toBeGreaterThan(0)
    }
  })

  it('no field (nothing near enough to build one) and no creatures are no dread', () => {
    const out = mkOut()
    dreadFrom([thing(13.5, 11.5, 'hound')], null, P, out)
    expect(out).toMatchObject({ dread: 0, d: -1, variant: null })
    dreadFrom([], fieldAt(11, 11), P, out)
    expect(out.dread).toBe(0)
  })

  it('a creature with no kind reads as a shade, as variants.specFor does', () => {
    const out = mkOut()
    dreadFrom([{ ...thing(17.5, 11.5), variant: undefined }], fieldAt(11, 11), P, out)
    expect(out.dread).toBeCloseTo(0.4 / 2, 12)
    expect(out.variant).toBe('shade')
  })
})

describe('dreadNear: the build\'s gate', () => {
  it('true for a creature that could count within DREAD_R in a straight line, else false', () => {
    expect(dreadNear([thing(11.5 + 24, 11.5)], P)).toBe(true)
    expect(dreadNear([thing(11.5, 11.5 - 20)], P)).toBe(true)
    expect(dreadNear([thing(11.5 + 30, 11.5)], P)).toBe(false)
    expect(dreadNear([thing(11.5 + 19, 11.5 + 19)], P)).toBe(false)
    expect(dreadNear([], P)).toBe(false)
    expect(dreadNear([thing(13.5, 11.5, 'hound', { ai: 'hunt' }), thing(40.5, 11.5)], P)).toBe(false)
  })
  it('whatever path distance dreadFrom can count, the gate has let through', () => {
    const f = fieldAt(11, 11)
    const out = mkOut()
    for (let x = -13; x <= 35; x++) for (let y = -13; y <= 35; y++) {
      const e = thing(x + 0.99, y + 0.99)
      dreadFrom([e], f, { x: 11.0, y: 11.0, angle: 0 }, out)
      if (out.dread > 0) expect(dreadNear([e], { x: 11.0, y: 11.0, angle: 0 })).toBe(true)
    }
  })
})

describe('honest: behind a wall is nowhere', () => {
  // a 3-thick wall at the border of chunks 0 and 1 (x 21..23); the doorway, when there is one, at y 9
  const sealed = (x) => x >= 21 && x <= 23
  const door = (x, y) => x >= 21 && x <= 23 && y !== 9
  const you = { x: 19.5, y: 11.5, angle: Math.PI }              // facing away, so nothing is in sight

  it('a creature 7 u away behind a chunk wall gives dread 0 and never a tell', () => {
    const f = fieldAt(19, 11, sealed)
    const out = mkOut()
    const e = thing(26.5, 11.5, 'hound')
    expect(Math.hypot(e.x - you.x, e.y - you.y)).toBe(7)
    expect(dreadNear([e], you)).toBe(true)                      // near enough in a line to build for
    dreadFrom([e], f, you, out)
    expect(out.dread).toBe(0)
    expect(out.d).toBe(-1)
    const teller = createTeller({ rng: () => 0 })
    for (let i = 0; i < 200; i++) expect(teller.tick(0.25, out, you, 1)).toBe(null)
  })

  it('the same creature with a doorway near: path distance, dread and a tell', () => {
    const f = fieldAt(19, 11, door)
    const out = mkOut()
    dreadFrom([thing(26.5, 11.5, 'hound')], f, you, out)
    expect(out.d).toBe(2 + 7 + 2)
    expect(out.dread).toBeCloseTo(0.6 / (1 + 11 / 6), 12)
    const slot = createTeller({ rng: () => 0 }).tick(0.25, out, you, 1)
    expect(slot).not.toBe(null)
    expect(slot.sound).toBe('scrape')                           // rng 0 < 0.2: the chair
  })
})

describe('createTeller', () => {
  const far = (d, extra = {}) => ({ dread: 1, x: P.x, y: P.y + d, variant: 'hound', d, los: false, ...extra })   // to your right, out of sight

  it('plays at once, then every 3.5 s at most, on the 4 Hz timer', () => {
    const teller = createTeller({ rng: () => 0 })
    const at = []
    for (let i = 0; i < 80; i++) if (teller.tick(0.25, far(12), P, 1)) at.push(i * 0.25)
    expect(at[0]).toBe(0)
    expect(at.length).toBeGreaterThan(4)
    for (let k = 1; k < at.length; k++) expect(at[k] - at[k - 1]).toBe(3.5)
  })

  it('the chance per tick is (0.12 + 0.4 x dread) x dt', () => {
    const at = (dread, dt) => createTeller({ rng: () => 0.5 }).tick(dt, far(12, { dread }), P, 1) !== null
    expect(at(1, 1)).toBe(true)                                  // 0.52 > 0.5
    expect(at(0.9, 1)).toBe(false)                               // 0.48
    expect(at(1, 0.25)).toBe(false)                              // 0.13
    const c = []
    createTeller({ rng: () => { c.push(1); return 0.129 } }).tick(0.25, far(12), P, 1)
    expect(c.length).toBe(2)                                     // 0.129 < 0.13: it plays, and a second draw picks the sound
  })

  it('a chair moves instead one time in five', () => {
    const play = (...draws) => { let i = 0; return createTeller({ rng: () => draws[i++] }).tick(0.25, far(12), P, 1) }
    expect(play(0, 0.19).sound).toBe('scrape')
    expect(play(0, 0.2).sound).toBe('pant')
    for (const v of Object.keys(TELL)) {
      let i = 0
      const s = createTeller({ rng: () => [0, 0.9][i++] }).tick(0.25, far(12, { variant: v }), P, 1)
      expect(s.sound).toBe(TELL[v])
      expect(s.variant).toBe(v)
    }
  })

  it('only between 7 path cells and DREAD_R x rangeMul', () => {
    const t = (d, mul = 1) => createTeller({ rng: () => 0 }).tick(0.25, far(d), P, mul) !== null
    expect(t(6)).toBe(false)
    expect(t(7)).toBe(true)
    expect(t(24)).toBe(true)
    expect(t(25)).toBe(false)
    expect(t(12, 0.5)).toBe(true)
    expect(t(13, 0.5)).toBe(false)
    expect(createTeller({ rng: () => 0 }).tick(0.25, far(12), P)).not.toBe(null)    // rangeMul defaults to 1
  })

  it('never for a creature in sight: in your view cone with a line to you', () => {
    const t = (o, p = P) => createTeller({ rng: () => 0 }).tick(0.25, o, p, 1)
    const ahead = { dread: 1, x: P.x + 12, y: P.y, variant: 'smiler', d: 12, los: true }
    expect(t(ahead)).toBe(null)
    expect(t({ ...ahead, los: false })).not.toBe(null)          // round a corner ahead of you
    expect(t({ ...ahead, x: P.x - 12 })).not.toBe(null)         // behind you, in a line
    expect(t(ahead, { ...P, angle: Math.PI / 2 })).not.toBe(null)   // you turned away
  })

  it('gain 0.25 + 0.5 x (1 - d / R), panned to its bearing', () => {
    const t = (o, mul = 1, p = P) => createTeller({ rng: () => 0 }).tick(0.25, o, p, mul)
    let s = t(far(7))
    expect(s.gain).toBeCloseTo(0.25 + 0.5 * (1 - 7 / 24), 12)
    expect(s.pan).toBeCloseTo(0.85, 12)                          // facing +x, +y is your right
    expect(t(far(24)).gain).toBeCloseTo(0.25, 12)
    expect(t(far(12), 0.5).gain).toBeCloseTo(0.25, 12)           // R is the tell's reach
    expect(t(far(12), 1.7).gain).toBeCloseTo(0.25 + 0.5 * (1 - 12 / (24 * 1.7)), 12)
    s = t({ ...far(12), y: P.y - 12 })
    expect(s.pan).toBeCloseTo(-0.85, 12)
    s = t({ ...far(12), x: P.x - 12, y: P.y })                  // straight behind: centred
    expect(Math.abs(s.pan)).toBeLessThan(1e-9)
    s = t({ ...far(12), x: P.x + 12, y: P.y + 12 })
    expect(s.pan).toBeCloseTo(Math.SQRT1_2 * 0.85, 9)
    for (let a = -Math.PI; a <= Math.PI; a += 0.1) {
      const o = { ...far(12), x: P.x + Math.cos(a) * 12, y: P.y + Math.sin(a) * 12 }
      const r = t(o, 1, { ...P, angle: 0.3 })
      if (r) { expect(r.pan).toBeGreaterThanOrEqual(-0.85); expect(r.pan).toBeLessThanOrEqual(0.85) }
    }
  })

  it('hands back one reused slot; nothing to tell is null; reset() lets the next one play at once', () => {
    const teller = createTeller({ rng: () => 0 })
    const a = teller.tick(0.25, far(12), P, 1)
    expect(a).not.toBe(null)
    expect(teller.tick(0.25, far(12), P, 1)).toBe(null)          // inside the gap
    teller.reset()
    const b = teller.tick(0.25, far(12), P, 1)
    expect(b).toBe(a)
    expect(teller.tick(5, null, P, 1)).toBe(null)
    expect(teller.tick(5, { dread: 0, x: 0, y: 0, variant: null, d: -1, los: false }, P, 1)).toBe(null)
    expect(createTeller().tick(0.25, null, P)).toBe(null)        // an rng of its own when none is given
  })

  it('the gap runs while there is nothing to tell', () => {
    const teller = createTeller({ rng: () => 0 })
    expect(teller.tick(0.25, far(12), P, 1)).not.toBe(null)
    for (let i = 0; i < 13; i++) teller.tick(0.25, null, P, 1)  // 3.25 s of nothing
    expect(teller.tick(0.25, far(12), P, 1)).not.toBe(null)      // 3.5 s since the last
  })
})
