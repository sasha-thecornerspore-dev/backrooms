// compass.js — the two-line compass: the nearest way you have SEEN (stale ones with a '~'), the faint pull when none is known, and
// 'the way you came'; plus the arrival summary said when a floor is known.
import { describe, it, expect } from 'vitest'
import {
  EXIT_DIRS, exitArrow, wayLabel, FAINT, compassLines, compassText, arrivalSummary, numberWord,
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

  it('falls back to the nearest loaded way with FAINT when nothing is known (never blank where it used to point)', () => {
    const out = []
    const fb = { rec: { key: 'x', kind: 'down', x: 20.5, y: 0.5, label: 'descend', target: 2 }, dist: 20 }
    compassLines({ player: player(0.5, 0.5), known: [], fallback: fb, arrived: null }, out)
    expect(out.length).toBe(1)
    expect(out[0]).toEqual({ arrow: '↑', text: FAINT, dist: 20 })
    expect(FAINT).toBe('something pulls, faintly')
    expect(compassText(out)).toBe('↑  something pulls, faintly  ·  20m')
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
  it('rounds the distance and joins with a newline', () => {
    expect(compassText([{ arrow: '↗', text: 'descend — level 2', dist: 41.4 }, { arrow: '←', text: 'the way you came', dist: 11.6 }]))
      .toBe('↗  descend — level 2  ·  41m\n←  the way you came  ·  12m')
    expect(compassText([])).toBe('')
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
