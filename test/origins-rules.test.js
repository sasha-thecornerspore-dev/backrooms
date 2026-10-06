// origin-rules.js — the composer of the five blocks, and LEGACY: the post-core game.js, byte for byte.
import { describe, it, expect } from 'vitest'
import { existsSync } from 'fs'
import {
  rulesFor, LEGACY, LEGACY_EFFECT, LEGACY_LAST_LINE, RULE_KEYS, LOSE_TRACK_REF, STILL_HIDDEN_S, LIT_SIGHT_MUL,
} from '../src/renderer/origin-rules.js'
import { ORIGINS } from '../src/renderer/origin-intake.js'
import { TENANT } from '../src/renderer/origin-tenant.js'
import { THIN, GLOW_LINE, FIRST_SHOT_LINE } from '../src/renderer/origin-thin.js'
import { pinCaption } from '../src/renderer/origin-anchored.js'
import { EVENTS } from '../src/renderer/events.js'

const STILLNESS = new URL('../src/renderer/stillness.js', import.meta.url)
// every item type game.js names (ITEM_NAMES, game.js:48-56)
const ITEM_TYPES = ['almond-water', 'glowstick', 'bandage', 'polaroid', 'radio', 'plumb', 'ballast', 'extension-slip']
const PIN = { lat: 39.2994, lng: -76.641 }
const sorted = (o) => Object.keys(o).sort()
const pctx = (o = {}) => ({ depth: 2, stillFor: 2.5, noiseFor: 3, flashlight: false, radioOn: false, litNear: false, ...o })
const copy = (p) => ({ sightMul: p.sightMul, hidden: p.hidden, loseTrackMul: p.loseTrackMul, noiseMul: p.noiseMul })

describe('rulesFor — the cache and the key set', () => {
  it('an unfiled player is LEGACY, thin or not', () => {
    expect(rulesFor(null, false)).toBe(LEGACY)
    expect(rulesFor(null, true)).toBe(LEGACY)
    expect(rulesFor(undefined, false)).toBe(LEGACY)
  })

  it('cached per (origin, thin) and frozen', () => {
    for (const o of ORIGINS) for (const t of [false, true]) {
      const r = rulesFor(o, t)
      expect(rulesFor(o, t)).toBe(r)
      expect(Object.isFrozen(r)).toBe(true)
      expect(r).not.toBe(LEGACY)
    }
    expect(rulesFor('tenant', true)).not.toBe(rulesFor('tenant', false))
    expect(Object.isFrozen(LEGACY)).toBe(true)
  })

  it('every block has exactly RULE_KEYS plus id', () => {
    expect(RULE_KEYS).toEqual(['lightTerm', 'perception', 'damageMul', 'wardRecoil', 'exitGrab', 'wayReveal', 'scrapSanity', 'sweetWater',
      'sourWater', 'itemEffect', 'friendBase', 'giverMul', 'npcLine', 'presenceReply', 'wishMeta', 'eventWeights', 'polaroid',
      'canDevelopClaim', 'radio', 'canHoldSeam', 'beacon', 'deathEffects', 'leash', 'crosserPause'])
    expect(Object.isFrozen(RULE_KEYS)).toBe(true)
    const want = [...RULE_KEYS, 'id'].sort()
    expect(sorted(LEGACY)).toEqual(want)
    expect(sorted(THIN)).toEqual(want)
    for (const o of ORIGINS) for (const t of [false, true]) expect([o, t, sorted(rulesFor(o, t))]).toEqual([o, t, want])
  })
})

describe('LEGACY IDENTITY — game.js at 2cb9c76', () => {
  it('lightTerm is `flashlight ? 2 : -2` (game.js sanity block)', () => {
    for (const litNear of [false, true]) for (let depth = 0; depth <= 3; depth++) {
      expect(LEGACY.lightTerm(true, litNear, depth)).toBe(2)
      expect(LEGACY.lightTerm(false, litNear, depth)).toBe(-2)
    }
  })

  it('perception is { 1, false, 1, 1 } for every input, one reused object', () => {
    const first = LEGACY.perception(pctx())
    for (const stillFor of [0, 0.6, 2, 2.5, 100]) for (const noiseFor of [0, 1, 3, 100, Infinity])
      for (const flashlight of [false, true]) for (const radioOn of [false, true]) for (const litNear of [false, true])
        for (let depth = 0; depth <= 3; depth++) {
          const p = LEGACY.perception({ depth, stillFor, noiseFor, flashlight, radioOn, litNear })
          expect(p).toBe(first)
          expect(copy(p)).toEqual({ sightMul: 1, hidden: false, loseTrackMul: 1, noiseMul: 1 })
        }
  })

  it('the numbers: damage, recoil, grab, reveal, scrap, sweet water, friend, giver', () => {
    expect(LEGACY.damageMul).toBe(1)
    expect(LEGACY.wardRecoil).toBe(false)
    expect(LEGACY.exitGrab).toBe(1.6)
    expect(LEGACY.wayReveal).toBe('seen')
    expect(LEGACY.scrapSanity).toBe(6)
    expect(LEGACY.sweetWater).toBe(35)
    for (const rp of [{}, { aseed: 7 }, { aseed: null }, null]) for (const selfAseed of [7, null, undefined])
      expect(LEGACY.friendBase({ rp, selfAseed })).toBe(3)
    expect(LEGACY.giverMul(0)).toBe(1)
    expect(LEGACY.giverMul(5)).toBe(1)
    expect(LEGACY.leash).toBe(false)
    expect(LEGACY.canDevelopClaim).toBe(true)
    expect(LEGACY.canHoldSeam).toBe(true)
  })

  it('sour water runs the legacy branches; every item is the legacy effect', () => {
    for (let i = 0; i <= 4; i++) expect(LEGACY.sourWater(i)).toBe(null)
    expect(Object.isFrozen(LEGACY_EFFECT)).toBe(true)
    expect(LEGACY_EFFECT.legacy).toBe(true)
    for (const type of ITEM_TYPES) for (let i = 0; i <= 4; i++) {
      expect(LEGACY.itemEffect({ type }, i)).toBe(LEGACY_EFFECT)
      expect(LEGACY.itemEffect({ type, sour: true, on: true }, i)).toBe(LEGACY_EFFECT)
    }
  })

  it('npc, presence, wish meta, events, polaroid, crosser', () => {
    expect(LEGACY.npcLine()).toBe(null)
    expect(LEGACY.presenceReply('wish')).toBe(null)
    expect(LEGACY.presenceReply('claim')).toBe(null)
    expect(LEGACY.wishMeta()).toEqual({ origin: null })
    expect(LEGACY.eventWeights()).toBe(EVENTS)
    for (const c of [{}, { thinFirstShot: true }, { D: 900, firstShotOfLevel: true, glyph: 'i', anchor: PIN }])
      expect(LEGACY.polaroid(c)).toBe(null)
    expect(LEGACY.crosserPause()).toBe(null)
  })

  it('the radio reads the last group and stops: that one was yours (1900 ms line)', () => {
    expect(LEGACY_LAST_LINE).toBe('it reads the last group, then stops. that one was yours.')
    expect({ ...LEGACY.radio({ last: true }) }).toEqual({ heartbeat: 'last', followUp: 'it reads the last group, then stops. that one was yours.' })
    expect({ ...LEGACY.radio({ last: false }) }).toEqual({ heartbeat: 'last', followUp: null })
    expect({ ...LEGACY.radio({ last: false, firstDeepHearing: true }) }).toEqual({ heartbeat: 'last', followUp: null })
    expect(LEGACY.radio({ last: true })).toBe(LEGACY.radio({ last: false }))   // one reused object
  })

  it('the beacon and death are the legacy triples', () => {
    expect(LEGACY.beacon).toEqual({ carriesPin: false, filesFloor: false, line: null })
    expect(LEGACY.deathEffects({ filed: false, thin: false, D: 900 })).toEqual({ mintThin: false, leashDebt: 0, line: null })
    expect(LEGACY.deathEffects({ filed: true, thin: true, D: 900 })).toEqual({ mintThin: false, leashDebt: 0, line: null })
  })
})

describe('composition — thin over the origin', () => {
  it('thin overrides light, perception, damage, recoil, crosser and giver; the origin keeps the rest', () => {
    const r = rulesFor('tenant', true)
    expect(r.lightTerm).toBe(THIN.lightTerm)
    expect(r.perception).toBe(THIN.perception)
    expect(r.damageMul).toBe(0.7)
    expect(r.wardRecoil).toBe(true)
    expect(r.crosserPause).toBe(THIN.crosserPause)
    expect(r.giverMul).toBe(THIN.giverMul)
    expect(r.exitGrab).toBe(2.4)
    expect(r.wayReveal).toBe('loaded')
    expect(r.scrapSanity).toBe(6)
    expect(r.eventWeights).toBe(TENANT.eventWeights)
    expect(r.presenceReply).toBe(TENANT.presenceReply)
  })

  it('the polaroid: thin first, then the origin', () => {
    const r = rulesFor('anchored', true)
    expect(r.polaroid({ thinFirstShot: true, D: 300, firstShotOfLevel: false, glyph: 'w', anchor: PIN }))
      .toEqual({ cap: FIRST_SHOT_LINE, advance: false })
    expect(r.polaroid({ thinFirstShot: false, D: 300, firstShotOfLevel: false, glyph: 'w', anchor: PIN }))
      .toEqual({ cap: pinCaption(PIN, 300, 'w'), advance: true, leashCalm: 60 })
  })

  it('the glowstick goes through you; the bandage is still a bandage', () => {
    const r = rulesFor('unnamed', true)
    expect(r.itemEffect({ type: 'glowstick' }, 2)).toEqual({ fog: 33, calm: 8, blip: true, sanity: -4, line: GLOW_LINE })
    expect(r.itemEffect({ type: 'bandage' }, 2)).toBe(LEGACY_EFFECT)
    expect(rulesFor('unnamed', false).itemEffect({ type: 'glowstick' }, 2)).toBe(LEGACY_EFFECT)
  })
})

describe('THE SHARED BASE — every filed player', () => {
  it('two seconds still and silent with the light and the radio off: hidden', () => {
    for (const o of ORIGINS) {
      const p = rulesFor(o, false).perception
      expect([o, p(pctx()).hidden]).toEqual([o, true])
      expect([o, p(pctx({ stillFor: 1.9 })).hidden]).toEqual([o, false])
      expect([o, p(pctx({ noiseFor: 1 })).hidden]).toEqual([o, false])
      expect([o, p(pctx({ flashlight: true })).hidden]).toEqual([o, false])
      expect([o, p(pctx({ radioOn: true })).hidden]).toEqual([o, false])
      expect([o, p(pctx({ stillFor: 2, noiseFor: 2 })).hidden]).toEqual([o, true])
    }
  })

  it('unlit in a friend\'s light: sightMul x LIT_SIGHT_MUL; the flashlight cancels it', () => {
    expect(rulesFor('tenant', false).perception(pctx({ litNear: true })).sightMul).toBeCloseTo(1.3 * 0.45, 12)
    expect(rulesFor('unnamed', false).perception(pctx({ litNear: true })).sightMul).toBeCloseTo(0.45, 12)
    expect(rulesFor('processed', false).perception(pctx({ litNear: true, depth: 3 })).sightMul).toBeCloseTo(1.25 * 0.45, 12)
    expect(rulesFor('anchored', false).perception(pctx({ litNear: true })).sightMul).toBeCloseTo(0.45, 12)
    expect(rulesFor('tenant', false).perception(pctx({ litNear: true, flashlight: true })).sightMul).toBe(1.3)
    expect(rulesFor('unnamed', false).perception(pctx({ litNear: true, flashlight: true })).sightMul).toBe(1)
  })

  it('a thin player keeps its own 0.6 s rule and takes the same light factor', () => {
    const p = rulesFor('tenant', true).perception
    expect(p(pctx({ stillFor: 0.5 })).hidden).toBe(false)
    expect(p(pctx({ stillFor: 0.6 })).hidden).toBe(true)
    const radio = copy(p(pctx({ radioOn: true })))
    expect(radio.hidden).toBe(false)
    expect(radio.sightMul).toBe(0.5)
    expect(p(pctx({ radioOn: true, litNear: true })).sightMul).toBeCloseTo(0.5 * 0.45, 12)
  })

  it('the base never touches LEGACY', () => {
    for (const c of [pctx(), pctx({ litNear: true }), pctx({ stillFor: 100, noiseFor: 100 })])
      expect(copy(LEGACY.perception(c))).toEqual({ sightMul: 1, hidden: false, loseTrackMul: 1, noiseMul: 1 })
  })

  it('the two numbers, and the reference loseTrack', () => {
    expect(STILL_HIDDEN_S).toBe(2)
    expect(LIT_SIGHT_MUL).toBe(0.45)
    expect(LOSE_TRACK_REF).toBe(3.5)
  })

  it.skipIf(!existsSync(STILLNESS))('STILL_HIDDEN_S is the stillness module\'s', async () => {
    const st = await import(STILLNESS.href)
    expect(STILL_HIDDEN_S).toBe(st.STILL_HIDDEN_S)
  })
})
