// compass.js — the two-line compass: the nearest way you have SEEN (stale ones with a '~'), the faint pull when none is known, and
// 'the way you came'; plus the arrival summary said when a floor is known.
import { describe, it, expect } from 'vitest'
import {
  EXIT_DIRS, exitArrow, wayLabel, FAINT, compassLines, compassText, arrivalSummary, numberWord,
  PULL_WAIT_S, PULL_FRESH_S, PULL_WOBBLE, pullVisible, pullWobble, lostDue, seenLine, SEEN_ON, SEEN_OFF,
} from '../src/renderer/compass.js'
import { wayLabel as topoLabel } from '../src/renderer/topology.js'

// game.js:60-65 as it was, byte for byte, so the arrows cannot drift
const OLD_DIRS = ['↑', '↗', '→', '↘', '↓', '↙', '←', '↖']
function oldExitArrow(rel) {
  let a = rel % (Math.PI * 2)
  if (a < 0) a += Math.PI * 2
  return OLD_DIRS[Math.round(a / (Math.PI / 4)) % 8]
}

const player = (x, y, angle = 0) => ({ x, y, angle })
const pin = (key, type, x, y, target = 2, label = 'descend', lost = false, chunkKey = '0,0') => ({ key, type, x, y, target, label, lost, chunkKey })

describe('exitArrow', () => {
  it('is the old game.js table, byte for byte, across the whole circle', () => {
    expect(EXIT_DIRS).toEqual(OLD_DIRS)
    for (let rel = -14; rel <= 14; rel += 0.0137) expect(exitArrow(rel)).toBe(oldExitArrow(rel))
    for (let k = 0; k < 8; k++) expect(exitArrow(k * Math.PI / 4)).toBe(OLD_DIRS[k])
    expect(exitArrow(0)).toBe('↑'); expect(exitArrow(Math.PI / 2)).toBe('→'); expect(exitArrow(-Math.PI / 2)).toBe('←'); expect(exitArrow(Math.PI)).toBe('↓')
  })
})

describe('wayLabel', () => {
  it('is topology.js wayLabel: label — floor, per kind', () => {
    expect(wayLabel).toBe(topoLabel)
    expect(wayLabel({ kind: 'down', label: 'descend', target: 2 })).toBe('descend — level 2')
    expect(wayLabel({ kind: 'up', label: 'stairwell up', target: 0 })).toBe('stairwell up — level 0')
    expect(wayLabel({ kind: 'lift', label: 'the lift', target: 3 })).toBe('the lift — level 3')
    expect(wayLabel({ kind: 'ring', label: 'climb out', target: 0 })).toBe('climb out — level 0')
    expect(wayLabel({ kind: 'ring', label: 'no-clip out', target: 4 })).toBe('no-clip out — the block')
  })
})

describe('compassLines', () => {
  it('points at the nearest known way first, then the way you came, two lines at most', () => {
    const out = []
    const p = player(0.5, 0.5, 0)
    const known = [pin('far', 'down', 40.5, 0.5), pin('near', 'down', 10.5, 0.5), pin('lift', 'lift', 0.5, 30.5, 3, 'the lift'), pin('up', 'up', 2.5, 0.5, 0, 'stairwell up')]
    const arrived = { key: 'arrived:0', type: 'arrived', x: 0.5, y: -12.5 }
    const r = compassLines({ player: p, known, fallback: null, arrived, stale: null }, out)
    expect(r).toBe(out)
    expect(out.length).toBe(2)
    expect(out[0]).toEqual({ arrow: '↑', text: 'descend — level 2', dist: 10 })
    expect(out[1]).toEqual({ arrow: '←', text: 'the way you came', dist: 13 })
    expect(compassText(out)).toBe('↑  descend — level 2  ·  10m\n←  the way you came  ·  13m')
  })

  it('never points at a stairwell up, and omits the way you came when there is none', () => {
    const out = []
    compassLines({ player: player(0.5, 0.5), known: [pin('up', 'up', 2.5, 0.5, 0, 'stairwell up')], fallback: null, arrived: null }, out)
    expect(out.length).toBe(0)
    expect(compassText(out)).toBe('')
    compassLines({ player: player(0.5, 0.5), known: [pin('a', 'ring', 0.5, 5.5, 0, 'climb out')], fallback: null, arrived: null }, out)
    expect(out.length).toBe(1)
    expect(out[0].text).toBe('climb out — level 0')
    expect(out[0].arrow).toBe('→')
  })

  it('falls back to the nearest loaded way with FAINT when nothing is known, and the faint line never names metres', () => {
    const out = []
    const fb = { rec: { key: 'x', kind: 'down', x: 20.5, y: 0.5, label: 'descend', target: 2 }, dist: 20 }
    compassLines({ player: player(0.5, 0.5), known: [], fallback: fb, arrived: null }, out)
    expect(out.length).toBe(1)
    expect(out[0]).toEqual({ arrow: '↑', text: FAINT, dist: 20 })
    expect(FAINT).toBe('something pulls, faintly')
    expect(compassText(out)).toBe('↑  something pulls, faintly')
    compassLines({ player: player(0.5, 0.5), known: [], fallback: fb, arrived: { x: 0.5, y: -12.5 } }, out)
    expect(compassText(out)).toBe('↑  something pulls, faintly\n←  the way you came  ·  13m')
    expect(compassText(out)).not.toMatch(/faintly[^\n]*\d/)
    // a known way wins over the fallback even when the fallback is nearer
    compassLines({ player: player(0.5, 0.5), known: [pin('k', 'down', 60.5, 0.5)], fallback: fb, arrived: null }, out)
    expect(out[0].text).toBe('descend — level 2')
    expect(out[0].dist).toBe(60)
  })

  it('prefixes ~ for stale pins and excludes lost ones', () => {
    const out = []
    const known = [pin('lost', 'down', 5.5, 0.5, 2, 'descend', true), pin('stale', 'down', 15.5, 0.5, 2, 'descend', false, '0,0'), pin('ok', 'down', 25.5, 0.5, 2, 'descend', false, '1,0')]
    compassLines({ player: player(0.5, 0.5), known, fallback: null, arrived: null, stale: (q) => q.chunkKey === '0,0' }, out)
    expect(out.length).toBe(1)
    expect(out[0].text).toBe('~descend — level 2')
    expect(out[0].dist).toBe(15)
    compassLines({ player: player(0.5, 0.5), known: [known[0]], fallback: null, arrived: null }, out)
    expect(out.length).toBe(0)
    const fb = { rec: known[0], dist: 5 }
    compassLines({ player: player(0.5, 0.5), known: [known[0]], fallback: fb, arrived: null }, out)
    expect(out[0].text).toBe(FAINT)                                 // the lost hole can still pull, faintly, as a loaded way
  })

  it('reuses `out` and its line objects across calls (identity)', () => {
    const out = []
    const p = player(0.5, 0.5)
    const arrived = { x: 0.5, y: 9.5 }
    compassLines({ player: p, known: [pin('a', 'down', 9.5, 0.5)], fallback: null, arrived }, out)
    const l0 = out[0], l1 = out[1]
    compassLines({ player: p, known: [pin('b', 'down', 4.5, 0.5)], fallback: null, arrived }, out)
    expect(out[0]).toBe(l0); expect(out[1]).toBe(l1)
    expect(out[0].dist).toBe(4)
    compassLines({ player: p, known: [], fallback: null, arrived }, out)
    expect(out.length).toBe(1)
    expect(out[0]).toBe(l1)
    expect(out[0].text).toBe('the way you came')
    compassLines({ player: p, known: [pin('c', 'down', 2.5, 0.5)], fallback: null, arrived }, out)
    expect(out[0]).toBe(l0); expect(out[1]).toBe(l1)
  })

  it('a pin without a label still reads by its kind', () => {
    const out = []
    compassLines({ player: player(0.5, 0.5), known: [{ key: 'q', type: 'lift', x: 3.5, y: 0.5, target: 3, lost: false }], fallback: null, arrived: null }, out)
    expect(out[0].text).toBe('the lift — level 3')
  })
})

describe('compassText', () => {
  it('rounds the distance and joins with a newline (known-way text is unchanged)', () => {
    expect(compassText([{ arrow: '↗', text: 'descend — level 2', dist: 41.4 }, { arrow: '←', text: 'the way you came', dist: 11.6 }]))
      .toBe('↗  descend — level 2  ·  41m\n←  the way you came  ·  12m')
    expect(compassText([{ arrow: '↓', text: '~the lift — level 3', dist: 7.5 }])).toBe('↓  ~the lift — level 3  ·  8m')
    expect(compassText([])).toBe('')
  })
})

// T1-2: the faint pull earns its place: it waits, it names no metres, it wobbles slowly, and the caller may skip a kind
describe('the faint pull', () => {
  it('pins its numbers', () => {
    expect(PULL_WAIT_S).toBe(90); expect(PULL_FRESH_S).toBe(120); expect(PULL_WOBBLE).toBeCloseTo(Math.PI / 6, 12)
  })

  it('pullVisible: hidden before 90 s of floor time and shown from 90 s; a hint unlocks it at once', () => {
    expect(pullVisible({ floorT: 0 })).toBe(false)
    expect(pullVisible({ floorT: 89.9 })).toBe(false)
    expect(pullVisible({ floorT: 90 })).toBe(true)
    expect(pullVisible({ floorT: 400 })).toBe(true)
    expect(pullVisible({ floorT: 3, hinted: true })).toBe(true)
    expect(pullVisible({})).toBe(false); expect(pullVisible()).toBe(false)
  })

  it("pullVisible on a fresh run's lobby: step 2 of the first-run thread, or 120 s; a hint there does not unlock it", () => {
    expect(pullVisible({ floorT: 100, fresh: true, step: 1 })).toBe(false)
    expect(pullVisible({ floorT: 10, fresh: true, step: 1, hinted: true })).toBe(false)
    expect(pullVisible({ floorT: 10, fresh: true, step: 2 })).toBe(true)
    expect(pullVisible({ floorT: 10, fresh: true, step: 3 })).toBe(true)
    expect(pullVisible({ floorT: 119.9, fresh: true })).toBe(false)
    expect(pullVisible({ floorT: 120, fresh: true })).toBe(true)
  })

  it('compassLines leaves the faint line out while the pull is hidden; known ways and the way you came stay', () => {
    const out = []
    const fb = { rec: { key: 'x', kind: 'down', x: 20.5, y: 0.5, label: 'descend', target: 2 }, dist: 20 }
    const arrived = { x: 0.5, y: -12.5 }
    compassLines({ player: player(0.5, 0.5), known: [], fallback: fb, arrived, pull: false }, out)
    expect(out.length).toBe(1); expect(out[0].text).toBe('the way you came')
    compassLines({ player: player(0.5, 0.5), known: [pin('k', 'down', 10.5, 0.5)], fallback: fb, arrived: null, pull: false }, out)
    expect(out.length).toBe(1); expect(out[0].text).toBe('descend — level 2')
    compassLines({ player: player(0.5, 0.5), known: [], fallback: fb, arrived: null, pull: true }, out)
    expect(out[0].text).toBe(FAINT)
  })

  it('pullWobble stays within ±30°, is slow (no per-frame noise) and is a pure function of floor time and phase', () => {
    let maxStep = 0, peak = 0
    for (let t = 0; t <= 900; t += 1 / 60) {
      const w = pullWobble(t, 1.3)
      expect(Math.abs(w)).toBeLessThanOrEqual(PULL_WOBBLE + 1e-12)
      peak = Math.max(peak, Math.abs(w))
      maxStep = Math.max(maxStep, Math.abs(pullWobble(t + 1 / 60, 1.3) - w))
      expect(pullWobble(t, 1.3)).toBe(w)
    }
    expect(peak).toBeGreaterThan(PULL_WOBBLE * 0.99)                          // it does reach its bound
    expect(maxStep).toBeLessThan(PULL_WOBBLE / 7 / 60 + 1e-9)                 // a frame moves it by under a tenth of a degree
    expect(pullWobble(0, 0)).toBe(0)
    expect(pullWobble(7 * Math.PI / 2, 0)).toBeCloseTo(PULL_WOBBLE, 12)
    expect(Math.abs(pullWobble(7 * Math.PI / 2, 0, Math.PI / 4))).toBeCloseTo(Math.PI / 4, 12)   // tier 2a widens the bound
  })

  it('the wobble turns the faint arrow only; a known way points true', () => {
    const out = []
    const fb = { rec: { key: 'x', kind: 'down', x: 20.5, y: 0.5, label: 'descend', target: 2 }, dist: 20 }
    compassLines({ player: player(0.5, 0.5), known: [], fallback: fb, arrived: null, wobble: Math.PI / 2 }, out)
    expect(out[0].arrow).toBe('→')
    compassLines({ player: player(0.5, 0.5), known: [], fallback: fb, arrived: null, wobble: Math.PI / 12 }, out)
    expect(out[0].arrow).toBe('↑')
    compassLines({ player: player(0.5, 0.5), known: [pin('k', 'down', 10.5, 0.5)], fallback: fb, arrived: { x: 0.5, y: -12.5 }, wobble: Math.PI / 2 }, out)
    expect(out[0].arrow).toBe('↑'); expect(out[1].arrow).toBe('←')
  })

  it('skip(kind) passes over a kind in both the known list and the fallback', () => {
    const out = []
    const known = [pin('lift', 'lift', 3.5, 0.5, 3, 'the lift'), pin('down', 'down', 30.5, 0.5)]
    compassLines({ player: player(0.5, 0.5), known, fallback: null, arrived: null, skip: (k) => k === 'lift' }, out)
    expect(out[0].text).toBe('descend — level 2')
    compassLines({ player: player(0.5, 0.5), known, fallback: null, arrived: null, skip: null }, out)
    expect(out[0].text).toBe('the lift — level 3')
    const ring = { rec: { key: 'r', kind: 'ring', x: 9.5, y: 0.5, label: 'climb out', target: 0 }, dist: 9 }
    compassLines({ player: player(0.5, 0.5), known: [pin('r', 'ring', 5.5, 0.5, 0, 'climb out')], fallback: ring, arrived: null, skip: (k) => k === 'ring' }, out)
    expect(out.length).toBe(0)
    compassLines({ player: player(0.5, 0.5), known: [], fallback: ring, arrived: null, skip: () => false }, out)
    expect(out[0].text).toBe(FAINT)
  })

  it('lostDue: the lost line is due only while no way is shown and it has not been said this visit', () => {
    const out = []
    const fb = { rec: { key: 'x', kind: 'down', x: 20.5, y: 0.5, label: 'descend', target: 2 }, dist: 20 }
    compassLines({ player: player(0.5, 0.5), known: [], fallback: fb, arrived: { x: 0.5, y: -12.5 }, pull: false }, out)
    expect(lostDue(out, false)).toBe(true)
    expect(lostDue(out, true)).toBe(false)
    compassLines({ player: player(0.5, 0.5), known: [], fallback: fb, arrived: null, pull: true }, out)
    expect(lostDue(out, false)).toBe(false)                                   // the pull is showing
    compassLines({ player: player(0.5, 0.5), known: [pin('k', 'down', 10.5, 0.5)], fallback: null, arrived: null, pull: false }, out)
    expect(lostDue(out, false)).toBe(false)                                   // a way is known
    compassLines({ player: player(0.5, 0.5), known: [], fallback: null, arrived: null }, out)
    expect(lostDue(out, false)).toBe(true)
  })
})

// T1-6's pure helper: the seen line names it only when it is on screen; off screen the panned tell carries the direction
describe('seenLine', () => {
  it('on screen: it has seen you. off screen: something has seen you.', () => {
    expect(seenLine(true)).toBe('it has seen you.')
    expect(seenLine(false)).toBe('something has seen you.')
    expect(seenLine()).toBe('something has seen you.')
    expect(SEEN_ON).toBe('it has seen you.'); expect(SEEN_OFF).toBe('something has seen you.')
  })
})

describe('arrivalSummary', () => {
  it('says nothing on a first visit or without counts', () => {
    expect(arrivalSummary(null, 1)).toBeNull()
    expect(arrivalSummary({ down: 3 }, 1)).toBeNull()
    expect(arrivalSummary(null, 2)).toBeNull()
  })
  it('counts the ways down in words to four, then digits', () => {
    expect(arrivalSummary({ down: 1 }, 2)).toBe('you have been on this floor before. one way down is on your map.')
    expect(arrivalSummary({ down: 2 }, 2)).toBe('you have been on this floor before. two ways down are on your map.')
    expect(arrivalSummary({ down: 4, up: 1 }, 5)).toBe('you have been on this floor before. four ways down are on your map.')
    expect(arrivalSummary({ down: 7 }, 3)).toBe('you have been on this floor before. 7 ways down are on your map.')
    expect(arrivalSummary({ down: 0, up: 1 }, 2)).toBe('you have been on this floor before.')
  })
  it('numberWord', () => {
    expect([1, 2, 3, 4, 5, 12].map(numberWord)).toEqual(['one', 'two', 'three', 'four', '5', '12'])
  })
})
