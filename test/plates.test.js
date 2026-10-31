// plates.js — the plate budget: at most two plates in an arrival's first 45 s (the floor's own line and one more), unprompted text at
// most once per 20 s after it, player-caused text and combat warnings always, and the held lines handed back in order once the arrival
// has settled. Plus arrivalPlate: the floor's sub-line on a first visit, its name after, the block's name always.
import { describe, it, expect } from 'vitest'
import {
  createPlateBudget, arrivalPlate, ARRIVAL_KINDS, UNPROMPTED_KINDS, FREE_KINDS, DRAIN_S, QUEUE_CAP,
} from '../src/renderer/plates.js'
import { levelConfig } from '../src/renderer/levels.js'
import { DEFAULT_CONFIG } from '../src/renderer/world.js'
import { BLOCK } from '../src/renderer/topology.js'

// a seeded stream, so the barrage below is the same every run
function stream(seed) {
  let s = seed >>> 0
  return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 0xffffffff }
}
const BUDGETED = [...ARRIVAL_KINDS, ...UNPROMPTED_KINDS]

describe('the kinds', () => {
  it('names the arrival, unprompted and free kinds, frozen and disjoint', () => {
    expect(ARRIVAL_KINDS).toEqual(['floor', 'arrival'])
    expect(UNPROMPTED_KINDS).toEqual(['event', 'murmur', 'haunt', 'beat', 'clock', 'vignette', 'sign'])
    expect(FREE_KINDS).toEqual(['read', 'search', 'speak', 'gate', 'combat'])
    for (const k of [ARRIVAL_KINDS, UNPROMPTED_KINDS, FREE_KINDS]) expect(Object.isFrozen(k)).toBe(true)
    const all = [...ARRIVAL_KINDS, ...UNPROMPTED_KINDS, ...FREE_KINDS]
    expect(new Set(all).size).toBe(all.length)
    expect(DRAIN_S).toBe(10)
    expect(QUEUE_CAP).toBe(4)
  })
})

describe('createPlateBudget: the arrival window', () => {
  it('shows the floor line and one more; the rest of the window waits', () => {
    const b = createPlateBudget()
    b.arrive(100)
    expect(b.admit('floor', 100, 'level 1 — habitable zone')).toBe('show')
    expect(b.admit('arrival', 103, 'find a hole in the floor')).toBe('show')
    expect(b.admit('arrival', 111, 'you land a few rooms over')).toBe('queue')
    expect(b.admit('arrival', 117, 'the file has you now')).toBe('queue')
    expect(b.admit('murmur', 130, 'the concrete sweats.')).toBe('queue')
    expect(b.admit('event', 144.9, 'a door slams')).toBe('queue')
  })

  it('no more than 2 plates in the 45 s window after arrive, under a barrage of every budgeted kind', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const rnd = stream(seed)
      const b = createPlateBudget()
      const t0 = rnd() * 500
      b.arrive(t0)
      let shown = 0
      if (b.admit('floor', t0, 'the floor') === 'show') shown++
      for (let t = t0; t < t0 + 45; t += 0.25 + rnd() * 3) {
        const kind = BUDGETED[(rnd() * BUDGETED.length) | 0]
        if (kind === 'floor') continue
        if (b.admit(kind, t, `line ${t}`) === 'show') shown++
        expect(b.drain(t)).toBeNull()                         // nothing comes back inside the window
      }
      expect(shown, `seed ${seed}`).toBeLessThanOrEqual(2)
    }
  })

  it('the floor line always shows, even when the window is spent', () => {
    const b = createPlateBudget({ max: 1 })
    b.arrive(0)
    expect(b.admit('arrival', 1, 'a')).toBe('show')
    expect(b.admit('floor', 2, 'the floor')).toBe('show')
    expect(b.admit('murmur', 3, 'm')).toBe('queue')
  })

  it('a new arrival opens a fresh window and the old floor\'s lines do not follow you down', () => {
    const b = createPlateBudget()
    b.arrive(0)
    b.admit('floor', 0, 'f0'); b.admit('arrival', 1, 'a0'); b.admit('murmur', 2, 'old')
    b.arrive(30)
    expect(b.admit('floor', 30, 'f1')).toBe('show')
    expect(b.admit('arrival', 31, 'a1')).toBe('show')
    expect(b.admit('arrival', 32, 'held')).toBe('queue')
    expect(b.drain(75)).toBe('held')
    expect(b.drain(200)).toBeNull()
  })
})

describe('createPlateBudget: player-caused text and combat', () => {
  it('always shows, inside and outside the window, and never spends the budget', () => {
    const b = createPlateBudget()
    b.arrive(0)
    expect(b.admit('floor', 0, 'f')).toBe('show')
    for (const k of FREE_KINDS) for (let t = 0.5; t < 45; t += 4) expect(b.admit(k, t, 'x'), `${k} at ${t}`).toBe('show')
    expect(b.admit('arrival', 44, 'the hint')).toBe('show')    // the window's second plate is still there to spend
    for (const k of FREE_KINDS) for (let t = 46; t < 60; t += 0.5) expect(b.admit(k, t)).toBe('show')
    expect(b.admit('murmur', 64.5, 'm')).toBe('show')          // 20 s after the hint; the free lines in between did not count
  })

  it('a kind it does not know is let through, never swallowed', () => {
    const b = createPlateBudget()
    b.arrive(0)
    b.admit('floor', 0, 'f'); b.admit('arrival', 1, 'a')
    expect(b.admit('something-new', 2, 'x')).toBe('show')
    expect(b.admit(undefined, 3, 'y')).toBe('show')
  })
})

describe('createPlateBudget: after the window', () => {
  it('unprompted text shows at most once per 20 s', () => {
    const b = createPlateBudget()
    b.arrive(0)
    b.admit('floor', 0, 'f')
    expect(b.admit('murmur', 50, 'a')).toBe('show')
    expect(b.admit('event', 60, 'b')).toBe('queue')
    expect(b.drain(65)).toBeNull()                             // a line held after the window waits the whole gap
    expect(b.drain(69.9)).toBeNull()
    expect(b.drain(70)).toBe('b')
    expect(b.admit('haunt', 80, 'c')).toBe('queue')
    expect(b.drain(89.9)).toBeNull()
    expect(b.drain(90)).toBe('c')
    expect(b.admit('clock', 110, 'd')).toBe('show')
  })

  it('a fresh line never jumps the queue: nothing shows while an older line waits', () => {
    const b = createPlateBudget()
    b.arrive(0)
    b.admit('floor', 0, 'f'); b.admit('arrival', 1, 'a'); b.admit('arrival', 2, 'held')
    expect(b.admit('murmur', 300, 'later')).toBe('queue')     // the gap has long passed, but 'held' is older
    expect(b.drain(300)).toBe('held')
    expect(b.drain(319)).toBeNull()
    expect(b.drain(320)).toBe('later')
  })

  it('works before any arrival: the gap alone', () => {
    const b = createPlateBudget()
    expect(b.admit('murmur', 5, 'a')).toBe('show')
    expect(b.admit('murmur', 10, 'b')).toBe('queue')
    expect(b.drain(25)).toBe('b')
  })

  it('custom window, max and gap', () => {
    const b = createPlateBudget({ window: 10, max: 3, gap: 5 })
    b.arrive(0)
    expect(['floor', 'arrival', 'murmur', 'event'].map((k, i) => b.admit(k, i, k))).toEqual(['show', 'show', 'show', 'queue'])
    expect(b.drain(9)).toBeNull()
    expect(b.drain(12)).toBe('event')                          // 12 - 2 >= DRAIN_S
    expect(b.admit('murmur', 22, 'm')).toBe('show')            // 22 - 12 >= 5
  })
})

describe('createPlateBudget: drain', () => {
  it('hands queued lines back after the window, one per 10 s, oldest first', () => {
    const b = createPlateBudget()
    b.arrive(0)
    b.admit('floor', 0, 'level 1')
    b.admit('arrival', 3, 'hint')
    b.admit('arrival', 5, 'came')
    b.admit('arrival', 6, 'filed')
    b.admit('murmur', 20, 'murmur')
    expect(b.drain(44.9)).toBeNull()
    expect(b.drain(45)).toBe('came')
    expect(b.drain(50)).toBeNull()
    expect(b.drain(54.9)).toBeNull()
    expect(b.drain(55)).toBe('filed')
    expect(b.drain(65)).toBe('murmur')
    expect(b.drain(75)).toBeNull()
    expect(b.drain(500)).toBeNull()
  })

  it('holds at most 4: the first ones are kept, a fifth is let go', () => {
    const b = createPlateBudget()
    b.arrive(0)
    b.admit('floor', 0, 'f'); b.admit('arrival', 1, 'a')
    for (let i = 0; i < 6; i++) expect(b.admit('murmur', 2 + i, `m${i}`)).toBe('queue')
    const out = []
    for (let t = 45; t < 200; t += 1) { const l = b.drain(t); if (l !== null) out.push(l) }
    expect(out).toEqual(['m0', 'm1', 'm2', 'm3'])
  })

  it('a line held back without its text is let go: nothing comes back for it', () => {
    const b = createPlateBudget()
    b.arrive(0)
    b.admit('floor', 0, 'f'); b.admit('arrival', 1, 'a')
    expect(b.admit('event', 2)).toBe('queue')
    expect(b.admit('event', 3, null)).toBe('queue')
    expect(b.admit('event', 4, '')).toBe('queue')
    for (let t = 45; t < 120; t += 1) expect(b.drain(t)).toBeNull()
  })

  it('hands back the very string it was given', () => {
    const b = createPlateBudget()
    b.arrive(0)
    b.admit('floor', 0, 'f'); b.admit('arrival', 1, 'a')
    const line = 'somewhere behind you, a door slams shut.'
    b.admit('event', 2, line)
    expect(b.drain(45)).toBe(line)
  })
})

describe('arrivalPlate', () => {
  const L = (i) => levelConfig(DEFAULT_CONFIG, i)

  it('a first visit arrives with the floor\'s own sub-line, which was never shown before', () => {
    for (const i of [0, 1, 2, 3]) {
      expect(arrivalPlate(L(i), true)).toBe(L(i).levelSub)
      expect(arrivalPlate(L(i), true)).not.toBe(L(i).levelName)
    }
  })

  it('a revisit arrives with the name', () => {
    for (const i of [0, 1, 2, 3]) expect(arrivalPlate(L(i), false)).toBe(L(i).levelName)
  })

  it('the block keeps its name, first visit or not', () => {
    expect(arrivalPlate(L(BLOCK), true)).toBe(L(BLOCK).levelName)
    expect(arrivalPlate(L(BLOCK), false)).toBe(L(BLOCK).levelName)
  })

  it('a floor without a sub-line falls back to its name; no cfg is an empty plate', () => {
    expect(arrivalPlate({ levelName: 'level x' }, true)).toBe('level x')
    expect(arrivalPlate(null, true)).toBe('')
  })
})
