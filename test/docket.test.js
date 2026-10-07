import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import {
  EMPTY_DOCKET, STATUS_KEYS, EMPTY_STANDING, PLACEMENT_KEYS, DECOR_DEFAULT_DENOM,
  standingOf, standing, placementMods, applyPlacement, withRoom, ambientMods, rollCall, trayLean,
} from '../src/renderer/docket.js'
import { levelConfig } from '../src/renderer/levels.js'
import { DEFAULT_CONFIG } from '../src/renderer/world.js'
import { createDecorSystem } from '../src/renderer/decor.js'
import { createItemSystem } from '../src/renderer/items.js'

const C = (e = 0, c = 0, l = 0) => ({ extension: e, compliance: c, litigation: l })
const docketOf = (row, depth = 2) => ({ ...EMPTY_DOCKET, [String(depth)]: row })
// a standing with an exact lead and margin, for the sweeps
const stOf = (lead, m, depth = 1) => ({ counts: C(), total: 10, lead, margin: lead ? m : 0, depth })

describe('docket — the constants', () => {
  it('EMPTY_DOCKET is frozen zeros for 0..3 with the three columns', () => {
    expect(Object.keys(EMPTY_DOCKET)).toEqual(['0', '1', '2', '3'])
    for (const k of ['0', '1', '2', '3']) expect(EMPTY_DOCKET[k]).toEqual(C())
    expect(Object.isFrozen(EMPTY_DOCKET)).toBe(true)
    expect(Object.isFrozen(EMPTY_DOCKET['2'])).toBe(true)
  })

  it('STATUS_KEYS are the three columns; notice-mailed is never counted', () => {
    expect(STATUS_KEYS).toEqual(['extension', 'compliance', 'litigation'])
    expect(STATUS_KEYS).not.toContain('notice-mailed')
  })

  it('EMPTY_STANDING is frozen and leans nowhere', () => {
    expect(EMPTY_STANDING).toEqual({ counts: C(), total: 0, lead: null, margin: 0, depth: null })
    expect(Object.isFrozen(EMPTY_STANDING)).toBe(true)
    expect(Object.isFrozen(EMPTY_STANDING.counts)).toBe(true)
  })

  it('DECOR_DEFAULT_DENOM mirrors decor.js', () => {
    expect(DECOR_DEFAULT_DENOM).toEqual({ scraps: 7, machines: 20, npc: 16 })
    const src = readFileSync(new URL('../src/renderer/decor.js', import.meta.url), 'utf8')
    expect(src).toContain('config.npc?.denom ?? 16')
    expect(src).toContain('config.scraps?.denom ?? 7')
    expect(src).toContain('config.machines?.denom ?? 20')
  })

  it('DEFAULT_CONFIG.docket deep-equals EMPTY_DOCKET', () => {
    expect(DEFAULT_CONFIG.docket).toEqual(EMPTY_DOCKET)
  })
})

describe('docket — standing', () => {
  it('zeros: lead null, margin 0, total 0', () => {
    const s = standing(EMPTY_DOCKET, 0)
    expect(s).toEqual({ counts: C(), total: 0, lead: null, margin: 0, depth: 0 })
  })

  it('one file does not lead (max < 2)', () => {
    const s = standing(docketOf(C(1)), 2)
    expect(s.lead).toBeNull()
    expect(s.margin).toBe(0)
    expect(s.total).toBe(1)
  })

  it('a tie does not lead', () => {
    const s = standing(docketOf(C(3, 3)), 2)
    expect(s.lead).toBeNull()
    expect(s.margin).toBe(0)
    expect(s.total).toBe(6)
  })

  it('{e:5,c:2,l:1} leans extension by 3/8', () => {
    const s = standing(docketOf(C(5, 2, 1)), 2)
    expect(s.lead).toBe('extension')
    expect(s.margin).toBe(3 / 8)
    expect(s.total).toBe(8)
    expect(s.depth).toBe(2)
    expect(s.counts).toEqual(C(5, 2, 1))
  })

  it('any depth outside the integers 0..3 is the EMPTY_STANDING itself', () => {
    const d = docketOf(C(9, 0, 0), 0)
    for (const depth of [4, '∅', null, undefined, NaN, -1, 1.5, '1']) expect(standing(d, depth)).toBe(EMPTY_STANDING)
  })

  it('a level row that is not an object reads as zeros', () => {
    for (const row of [null, 5, 'x', [1, 2, 3], true]) {
      expect(standing({ ...EMPTY_DOCKET, '1': row }, 1)).toEqual({ counts: C(), total: 0, lead: null, margin: 0, depth: 1 })
    }
  })

  it('never throws on a non-object docket', () => {
    for (const d of [null, undefined, 7, 'docket', [], true]) {
      expect(() => standing(d, 2)).not.toThrow()
      expect(standing(d, 2).total).toBe(0)
    }
  })

  it('counts are copied and coerced: non-integers and negatives read 0, extra keys ignored', () => {
    const row = { extension: 2.5, compliance: -3, litigation: '4', 'notice-mailed': 9, other: 3 }
    const s = standingOf(row, 1)
    expect(s.counts).toEqual(C())
    expect(s.total).toBe(0)
    const src = C(4, 1, 0)
    const t = standingOf(src)
    expect(t.counts).not.toBe(src)
    expect(t.depth).toBeNull()
  })

  it('margin is clamped 0..1', () => {
    const s = standingOf(C(7))
    expect(s.lead).toBe('extension')
    expect(s.margin).toBe(1)
  })
})

describe('docket — placementMods', () => {
  const leads = [null, 'extension', 'compliance', 'litigation']
  it('every lead × margin keeps the overlay inside PLACEMENT_KEYS', () => {
    for (const lead of leads) for (const m of [0, 0.1, 0.3, 1]) {
      const o = placementMods(stOf(lead, m))
      for (const k of Object.keys(o)) expect(PLACEMENT_KEYS).toContain(k)
      if (!lead || m === 0) expect(o).toEqual({})
    }
  })

  it('PLACEMENT_KEYS are the four placement paths and touch no difficulty or golden key', () => {
    expect(PLACEMENT_KEYS).toEqual(['scraps.denom', 'machines.denom', 'npc.denom', 'items.types'])
    expect(Object.isFrozen(PLACEMENT_KEYS)).toBe(true)
    const banned = ['fogDistance', 'flicker', 'entities', 'exit', 'damage', 'lights', 'wallDensity', 'maze', 'dress', 'haunts', 'sights']
    for (const k of PLACEMENT_KEYS) for (const b of banned) expect(k.startsWith(b)).toBe(false)
  })

  it('extension: fewer pages and machines between; the water only past 0.2', () => {
    const o = placementMods(stOf('extension', 0.5))
    expect(o['scraps.denom']).toBeCloseTo(0.85, 12)
    expect(o['machines.denom']).toBeCloseTo(0.85, 12)
    expect(o['items.types']).toEqual(['almond-water'])
    expect(placementMods(stOf('extension', 0.2))['items.types']).toBeUndefined()
    expect(placementMods(stOf('extension', 0.1))['items.types']).toBeUndefined()
    expect(placementMods(stOf('extension', 0.3))['items.types']).toEqual(['almond-water'])
  })

  it('compliance m 1: pages ×1.6, souls ×1.3', () => {
    const o = placementMods(stOf('compliance', 1))
    expect(o['scraps.denom']).toBeCloseTo(1.6, 12)
    expect(o['npc.denom']).toBeCloseTo(1.3, 12)
    expect(Object.keys(o).sort()).toEqual(['npc.denom', 'scraps.denom'])
  })

  it('litigation m 0.3: a camera and a radio, souls ×0.91', () => {
    const o = placementMods(stOf('litigation', 0.3))
    expect(o['items.types']).toEqual(['polaroid', 'radio'])
    expect(o['npc.denom']).toBeCloseTo(0.91, 12)
    expect(placementMods(stOf('litigation', 0.2))['items.types']).toBeUndefined()
  })

  it('takes one argument and is a pure function of the standing', () => {
    expect(placementMods.length).toBe(1)
    const st = standing(docketOf(C(5, 2, 1)), 2)
    expect(placementMods(st)).toEqual(placementMods(st))
    expect(placementMods(st)).toEqual(placementMods(standing(docketOf(C(5, 2, 1)), 2)))
  })
})

describe('docket — applyPlacement', () => {
  it('an empty overlay returns the same cfg, deep-equal to a fresh build', () => {
    for (let i = 0; i < 4; i++) {
      const cfg = levelConfig(DEFAULT_CONFIG, i)
      expect(applyPlacement(cfg, {})).toBe(cfg)
      expect(cfg).toEqual(levelConfig(DEFAULT_CONFIG, i))
      expect(applyPlacement(cfg, placementMods(EMPTY_STANDING))).toBe(cfg)
      expect(cfg).toEqual(levelConfig(DEFAULT_CONFIG, i))
    }
  })

  it('denoms round to integers >= 1', () => {
    const l0 = levelConfig(DEFAULT_CONFIG, 0)               // scraps 5
    applyPlacement(l0, { 'scraps.denom': 0.7 })
    expect(l0.scraps.denom).toBe(4)
    const l2 = levelConfig(DEFAULT_CONFIG, 2)               // scraps 9
    applyPlacement(l2, { 'scraps.denom': 1.6 })
    expect(l2.scraps.denom).toBe(14)
    const tiny = { scraps: { denom: 1 } }
    applyPlacement(tiny, { 'scraps.denom': 0.1 })
    expect(tiny.scraps.denom).toBe(1)
    for (const lead of ['extension', 'compliance', 'litigation']) for (const m of [0.1, 0.3, 0.5, 1]) {
      const c = applyPlacement(levelConfig(DEFAULT_CONFIG, 1), placementMods(stOf(lead, m)))
      for (const x of ['scraps', 'machines', 'npc']) {
        if (c[x]?.denom === undefined) continue
        expect(Number.isInteger(c[x].denom)).toBe(true)
        expect(c[x].denom).toBeGreaterThanOrEqual(1)
      }
    }
  })

  it('a denom of 0 stays 0 (the fixed block, the closing zero)', () => {
    const z = levelConfig(DEFAULT_CONFIG, 4)
    expect(z.scraps.denom).toBe(0)
    applyPlacement(z, { 'scraps.denom': 1.6, 'machines.denom': 0.7 })
    expect(z.scraps.denom).toBe(0)
    expect(z.machines.denom).toBe(0)
  })

  it('an absent npc key is made from the decor default (16 × 1.3 → 21)', () => {
    const cfg = levelConfig(DEFAULT_CONFIG, 1)
    expect(cfg.npc).toBeUndefined()
    applyPlacement(cfg, { 'npc.denom': 1.3 })
    expect(cfg.npc).toEqual({ denom: 21 })
  })

  it('items.types appends after the existing entries, in order', () => {
    const cfg = levelConfig(DEFAULT_CONFIG, 1)
    const before = cfg.items.types.slice()
    const items = cfg.items
    applyPlacement(cfg, { 'items.types': ['polaroid', 'radio'] })
    expect(cfg.items.types).toEqual([...before, 'polaroid', 'radio'])
    expect(cfg.items.density).toBe(items.density)
    expect(items.types).toEqual(before)                     // the old object is not mutated
  })

  it('never touches the exits, the docket or the ways', () => {
    for (const lead of ['extension', 'compliance', 'litigation']) for (const m of [0.3, 1]) {
      const cfg = levelConfig(DEFAULT_CONFIG, 2)
      cfg.ways = [{ target: 3 }]
      const exit = cfg.exit, docket = cfg.docket, ways = cfg.ways
      const exitJson = JSON.stringify(exit)
      applyPlacement(cfg, placementMods(stOf(lead, m)))
      expect(cfg.exit).toBe(exit)
      expect(JSON.stringify(cfg.exit)).toBe(exitJson)
      expect(cfg.docket).toBe(docket)
      expect(cfg.ways).toBe(ways)
    }
  })

  it('returns the cfg it was given', () => {
    const cfg = levelConfig(DEFAULT_CONFIG, 0)
    expect(applyPlacement(cfg, { 'scraps.denom': 0.85 })).toBe(cfg)
  })
})

describe('docket — withRoom / ambientMods', () => {
  it('the empty standing is the legacy ambience', () => {
    expect(ambientMods(EMPTY_STANDING)).toEqual({ tension: 0, thinChance: 0.3, standFloor: 3 })
    expect(ambientMods(EMPTY_STANDING, null)).toEqual({ tension: 0, thinChance: 0.3, standFloor: 3 })
  })

  it('extension tightens, compliance slackens, litigation thins the crossers', () => {
    expect(ambientMods(stOf('extension', 1)).tension).toBeCloseTo(0.15, 12)
    expect(ambientMods(stOf('compliance', 1)).tension).toBeCloseTo(-0.15, 12)
    const lit = ambientMods(stOf('litigation', 0.5))
    expect(lit.thinChance).toBeCloseTo(0.4, 12)
    expect(lit.tension).toBe(0)
    expect(ambientMods(stOf('extension', 1)).thinChance).toBe(0.3)
  })

  it('standFloor is 2 only at depth 2 leaning extension, 3 everywhere else', () => {
    for (let depth = 0; depth <= 3; depth++) for (const lead of [null, 'extension', 'compliance', 'litigation']) {
      for (const m of [0, 0.1, 0.5, 1]) {
        const f = ambientMods(stOf(lead, m, depth)).standFloor
        expect(f).toBeGreaterThanOrEqual(2)
        expect(f).toBe(depth === 2 && lead === 'extension' ? 2 : 3)
      }
    }
  })

  it('the room tips a single file into a lean — ambience only, never placement', () => {
    const st = standing(docketOf(C(1), 1), 1)
    const room = { 'notice-mailed': 4, extension: 2, compliance: 0, litigation: 0, total: 6 }
    const a = withRoom(st, room)
    expect(a.counts).toEqual(C(3))
    expect(a.lead).toBe('extension')
    expect(a.depth).toBe(1)
    expect(ambientMods(st, room)).not.toEqual(ambientMods(st))
    expect(ambientMods(st, room).tension).toBeGreaterThan(0)
    expect(placementMods(st)).toEqual({})
    expect(st.counts).toEqual(C(1))                          // the docket standing is not mutated
  })

  it('withRoom(st, null) is st; room junk reads 0', () => {
    const st = standing(docketOf(C(5, 2, 1)), 2)
    expect(withRoom(st, null)).toBe(st)
    const b = withRoom(st, { extension: 'x', compliance: 1.5, litigation: -2, total: 99 })
    expect(b.counts).toEqual(C(5, 2, 1))
    expect(b.depth).toBe(2)
  })
})

describe('docket — rollCall', () => {
  // the read words only: between the colon and the closing dash
  const words = (s) => (s.split(': ')[1]?.split(' — ')[0].match(/\b(extension|compliance|litigation)\b(?=\.)/g) ?? [])
  // a seeded rng so the sweep is the same every run
  const rng = (() => { let s = 1234567; return () => ((s = (s * 1103515245 + 12345) >>> 0) / 4294967296) })()

  it('never says a digit, never says more than nine words, never shouts', () => {
    for (let i = 0; i < 200; i++) {
      const row = C(Math.floor(rng() * 40), Math.floor(rng() * 40), Math.floor(rng() * 40))
      const s = rollCall(standingOf(row, 2))
      expect(s).not.toMatch(/\d/)
      expect(words(s).length).toBeLessThanOrEqual(9)
      expect(s).toBe(s.toLowerCase())
      expect(s).not.toContain('!')
    }
  })

  it('{e:6,c:1,l:2} reads the exact line', () => {
    expect(rollCall(standingOf(C(6, 1, 2), 2))).toBe('the station reads the floor, slow and patient: extension. extension. extension. extension. extension. extension. litigation. litigation. compliance. — the floor leans toward extension.')
  })

  it('a tie reads alphabetically and does not lean', () => {
    expect(rollCall(standingOf(C(3, 3), 1))).toBe('the station reads the floor, slow and patient: compliance. compliance. compliance. extension. extension. extension. — the floor does not lean.')
  })

  it('{e:60,c:30,l:10} samples nine words by largest remainder (5 / 3 / 1)', () => {
    const s = rollCall(standingOf(C(60, 30, 10), 3))
    const w = words(s)
    expect(w.length).toBe(9)
    expect(w.filter((x) => x === 'extension').length).toBe(5)
    expect(w.filter((x) => x === 'compliance').length).toBe(3)
    expect(w.filter((x) => x === 'litigation').length).toBe(1)
    expect(s.endsWith('— the floor leans toward extension.')).toBe(true)
    expect(w.indexOf('litigation')).toBe(8)
  })

  it('a positive count can round away', () => {
    const s = rollCall(standingOf(C(80, 19, 1), 2))
    expect(words(s)).not.toContain('litigation')
    expect(words(s).length).toBe(9)
  })

  it('one file, and none', () => {
    expect(rollCall(standingOf(C(1)))).toBe('one file is open on this floor. the floor does not lean.')
    expect(rollCall(standingOf(C(0, 0, 1)))).toBe('one file is open on this floor. the floor does not lean.')
    expect(rollCall(standingOf(C()))).toBe('the station reads the floor. nothing is filed here.')
    expect(rollCall(EMPTY_STANDING)).toBe('the station reads the floor. nothing is filed here.')
  })
})

describe('docket — trayLean', () => {
  it('the tray leans the way the floor leans, stamped in the record\'s own hand', () => {
    expect(trayLean(stOf('extension', 0.5))).toEqual({ item: 'almond-water', stamp: 'EXTENSION' })
    expect(trayLean(stOf('compliance', 0.5))).toEqual({ item: 'bandage', stamp: 'COMPLIANCE' })
    expect(trayLean(stOf('litigation', 0.5))).toEqual({ item: 'polaroid', stamp: 'LITIGATION' })
    expect(trayLean(stOf(null, 0))).toEqual({ item: null, stamp: null })
    expect(trayLean(EMPTY_STANDING)).toEqual({ item: null, stamp: null })
  })
})

describe('docket — legacy identity (a zero docket is today)', () => {
  const open = () => false
  const decor = (cfg) => {
    const sys = createDecorSystem(cfg, open, 424242)
    sys.update(0, 0)
    return JSON.stringify({ props: sys.getProps(), exits: sys.getExits(), npcs: sys.getNpcs?.() ?? [], scraps: sys.getScraps(), machines: sys.getMachines() })
  }
  const items = (cfg) => { const sys = createItemSystem(cfg, open, 424242); sys.update(0, 0); return JSON.stringify(sys.getWorldItems()) }

  it('decor and items are byte-identical with the zero docket overlaid, levels 0..3', () => {
    for (let i = 0; i < 4; i++) {
      const plain = levelConfig(DEFAULT_CONFIG, i)
      const over = applyPlacement(levelConfig(DEFAULT_CONFIG, i), placementMods(standing(DEFAULT_CONFIG.docket, i)))
      expect(over).toEqual(plain)
      expect(decor(over)).toBe(decor(plain))
      expect(items(over)).toBe(items(plain))
    }
  })

  it('a real lean reaches decor and items (the overlay is not inert)', () => {
    const d = { ...EMPTY_DOCKET, '1': C(20, 0, 0) }
    const plain = levelConfig(DEFAULT_CONFIG, 1)
    const over = applyPlacement(levelConfig(DEFAULT_CONFIG, 1), placementMods(standing(d, 1)))
    expect(over.scraps.denom).toBeLessThan(plain.scraps.denom)
    expect(over.items.types.filter((t) => t === 'almond-water').length).toBe(2)
    expect(decor(over)).not.toBe(decor(plain))
  })

  it('the legacy ambience and tray hold for every zero standing', () => {
    for (let i = 0; i < 4; i++) {
      const st = standing(DEFAULT_CONFIG.docket, i)
      expect(ambientMods(st)).toEqual({ tension: 0, thinChance: 0.3, standFloor: 3 })
      expect(trayLean(st)).toEqual({ item: null, stamp: null })
      expect(placementMods(st)).toEqual({})
    }
  })
})
