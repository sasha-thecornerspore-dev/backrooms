// the five rule blocks: tenant, anchored, processed, unnamed, and the thin layer.
import { describe, it, expect } from 'vitest'
import * as intakeMod from '../src/renderer/origin-intake.js'
import * as tenantMod from '../src/renderer/origin-tenant.js'
import * as anchoredMod from '../src/renderer/origin-anchored.js'
import * as processedMod from '../src/renderer/origin-processed.js'
import * as unnamedMod from '../src/renderer/origin-unnamed.js'
import * as thinMod from '../src/renderer/origin-thin.js'
import { intake } from '../src/renderer/origin-intake.js'
import { rulesFor, LEGACY, LEGACY_EFFECT, LEGACY_LAST_LINE } from '../src/renderer/origin-rules.js'
import { NULL_MAP } from '../src/renderer/level-null-map.js'
import { createFixedMap } from '../src/renderer/fixedmap.js'
import { formatAnchor, anchorSeed } from '../src/renderer/anchor.js'
import { EVENTS } from '../src/renderer/events.js'

const {
  TENANT, DOOR_LINES, DOOR_SANITY, SEALED_CELLS, facingCell, sealedCellIndex, isSealedMaterial, doorLine, TENANT_EVENTS, EXIT_GRAB,
} = tenantMod
const {
  ANCHORED, LEASH_FREE_M, LEASH_PER_M, CALM_S, leashDrain, leashDebtStep, pinCaption, isSamePin, MERCY_LINE, DEATH_LINE, FRIEND_SAME_PIN,
} = anchoredMod
const {
  PROCESSED, floorKey, SLIP_LINE, RADIO_KEY_LINE, OPENED_LINE, RELEASE_LINE, SOUR, NPC_REFUSAL, WISH_REPLY, claimRefile,
} = processedMod
const { UNNAMED, parseNameWish, spellCard, refileWithName, spelledLine, ONLINE_LINE, GLYPH_LINE, LAST_GROUP_LINE } = unnamedMod
const {
  THIN, STILL_S, MEMORY_S, DAMAGE_MUL, RECOIL_DIST, RECOIL_SHAKE, NOISE_MUL, RADIO_CARRY, GLOW_SANITY,
  RECOIL_LINE, FIRST_SHOT_LINE, FIRST_LINE, AGAIN_LINE, CURE_LINE, GLOW_LINE, CROSSER, thinGiverMul, thinHidden,
} = thinMod

const PIN = { lat: 39.2994, lng: -76.641 }
const pctx = (o = {}) => ({ depth: 2, stillFor: 2.5, noiseFor: 3, flashlight: false, radioOn: false, litNear: false, ...o })
const copy = (p) => ({ sightMul: p.sightMul, hidden: p.hidden, loseTrackMul: p.loseTrackMul, noiseMul: p.noiseMul })

describe('tenant', () => {
  it('the doors: seven lines, each said by exactly four of the 28 sealed cells', () => {
    const counts = new Map()
    for (const [ix, iy] of SEALED_CELLS) { const l = doorLine(ix, iy); counts.set(l, (counts.get(l) ?? 0) + 1) }
    expect(DOOR_LINES).toHaveLength(7)
    expect([...counts.keys()].sort()).toEqual([...DOOR_LINES].sort())
    for (const n of counts.values()) expect(n).toBe(4)
    expect(DOOR_SANITY).toBe(3)
  })

  it('the doors are the system\'s claim about an address, never a resident', () => {
    for (const l of DOOR_LINES) {
      expect(l).not.toMatch(/you knew|lived here/)
      expect(l).not.toMatch(/\b(?:mr|mrs|miss|ms)\b/)
      expect(l.replace(/30150A|EXTENSION/g, '')).toBe(l.replace(/30150A|EXTENSION/g, '').toLowerCase())
      expect(l).not.toContain('!')
    }
  })

  it('SEALED_CELLS is the row-major scan of the block\'s C and P cells', () => {
    const scan = []
    for (let iy = 0; iy < NULL_MAP.length; iy++) for (let ix = 0; ix < NULL_MAP[iy].length; ix++) {
      const m = NULL_MAP[iy][ix]
      if (m === 'C' || m === 'P') scan.push([ix, iy, m])
    }
    expect(SEALED_CELLS).toEqual(scan)
    expect(SEALED_CELLS.filter((c) => c[2] === 'C')).toHaveLength(14)
    expect(SEALED_CELLS.filter((c) => c[2] === 'P')).toHaveLength(14)
    expect(sealedCellIndex(2, 0)).toBe(0)
    expect(sealedCellIndex(21, 17)).toBe(27)
    expect(sealedCellIndex(6, 6)).toBe(-1)
    expect(sealedCellIndex(-1, 0)).toBe(-1)
  })

  it('isSealedMaterial, facingCell, and a door that is not a door says nothing', () => {
    expect(isSealedMaterial('C') && isSealedMaterial('P')).toBe(true)
    expect(isSealedMaterial('F')).toBe(false)
    expect(isSealedMaterial(null)).toBe(false)
    expect(facingCell({ x: 2.5, y: 2.5, angle: 0 })).toEqual({ ix: 3, iy: 2 })
    expect(facingCell({ x: 2.5, y: 2.5, angle: Math.PI / 2 })).toEqual({ ix: 2, iy: 3 })
    expect(facingCell({ x: 2.5, y: 2.5, angle: Math.PI })).toEqual({ ix: 1, iy: 2 })
    const fm = createFixedMap(NULL_MAP)
    const open = facingCell({ x: 2.5, y: 2.5, angle: 0 })
    expect(isSealedMaterial(fm.materialAt(open.ix + 0.5, open.iy + 0.5))).toBe(false)
    expect(doorLine(open.ix, open.iy)).toBe(null)
    const sealed = facingCell({ x: 1.5, y: 3.5, angle: Math.PI })   // (0, 3) is 'C'
    expect(isSealedMaterial(fm.materialAt(sealed.ix + 0.5, sealed.iy + 0.5))).toBe(true)
    expect(doorLine(sealed.ix, sealed.iy)).toBe(DOOR_LINES[sealedCellIndex(0, 3) % 7])
    expect(fm.materialAt(-0.5, 0.5)).toBe(null)
    expect(doorLine(-1, 0)).toBe(null)
  })

  it('the light: the street does not mind you, the deep frays', () => {
    expect(TENANT.lightTerm(false, false, 0)).toBe(0)
    expect(TENANT.lightTerm(false, false, 1)).toBe(0)
    expect(TENANT.lightTerm(false, false, 2)).toBe(-3)
    expect(TENANT.lightTerm(false, false, 3)).toBe(-3)
    for (const ln of [false, true]) for (let d = 0; d <= 3; d++) expect(TENANT.lightTerm(true, ln, d)).toBe(2)
  })

  it('perception: the file forwarded your address below the first floor', () => {
    expect(copy(TENANT.perception({ depth: 1, stillFor: 0, noiseFor: Infinity, flashlight: false, radioOn: false, litNear: false })))
      .toEqual({ sightMul: 1, hidden: false, loseTrackMul: 1, noiseMul: 1 })
    expect(copy(TENANT.perception(pctx({ stillFor: 0 })))).toEqual({ sightMul: 1.3, hidden: false, loseTrackMul: 1, noiseMul: 1.5 })
    expect(copy(TENANT.perception(pctx()))).toEqual({ sightMul: 1.3, hidden: true, loseTrackMul: 1, noiseMul: 1.5 })
    expect(TENANT.perception(pctx({ stillFor: 1.9 })).hidden).toBe(false)
    expect(TENANT.perception(pctx({ flashlight: true })).hidden).toBe(false)
    expect(TENANT.perception(pctx({ radioOn: true })).hidden).toBe(false)
    expect(TENANT.perception(pctx({ noiseFor: 1 })).hidden).toBe(false)
    expect(TENANT.perception(pctx({ litNear: true })).sightMul).toBeCloseTo(1.3 * 0.45, 12)
    expect(TENANT.perception(pctx({ litNear: true, flashlight: true })).sightMul).toBe(1.3)
    expect(TENANT.perception(pctx())).toBe(TENANT.perception(pctx({ depth: 0 })))
  })

  it('the grab, the map, the crossers, the complaint, the beacon, the death', () => {
    expect(TENANT.exitGrab).toBe(2.4)
    expect(EXIT_GRAB).toBe(2.4)
    expect(TENANT.wayReveal).toBe('loaded')
    expect(Object.isFrozen(TENANT_EVENTS)).toBe(true)
    expect(TENANT_EVENTS).toHaveLength(EVENTS.length)
    expect(TENANT.eventWeights()).toBe(TENANT_EVENTS)
    for (let i = 0; i < EVENTS.length; i++) {
      if (EVENTS[i].id === 'crosser') expect(TENANT_EVENTS[i]).toEqual({ ...EVENTS[i], weight: 6 })
      else expect(TENANT_EVENTS[i]).toEqual(EVENTS[i])
    }
    expect(EVENTS.find((e) => e.id === 'crosser').weight).toBe(3)   // the shared catalogue is untouched
    expect(TENANT.presenceReply('wish')).toBe('logged as a complaint from a resident. complaints are not requests, but they are kept.')
    expect(TENANT.presenceReply('claim')).toBe(null)
    expect(TENANT.beacon).toEqual({ carriesPin: false, filesFloor: false, line: null })
    expect(TENANT.deathEffects({ filed: true, thin: false, D: 500 })).toEqual({ mintThin: true, leashDebt: 0, line: 'not all of you came back up.' })
    expect(TENANT.deathEffects({ filed: true, thin: true, D: 500 }).line).toBe('still thin.')
    expect(TENANT.scrapSanity).toBe(6)
    expect(TENANT.sweetWater).toBe(35)
  })
})

describe('anchored', () => {
  it('the leash: free to 200 m, a point a second per 400 m past it, none while calm', () => {
    expect([LEASH_FREE_M, LEASH_PER_M, CALM_S]).toEqual([200, 400, 60])
    expect(leashDrain(0, 0)).toBe(0)
    expect(leashDrain(200, 0)).toBe(0)
    expect(leashDrain(600, 0)).toBe(1)
    expect(leashDrain(1000, 0)).toBe(2)
    expect(leashDrain(1000, 0.1)).toBe(0)
    expect(leashDebtStep(10, 0.5)).toBe(9.5)
    expect(leashDebtStep(0.2, 1)).toBe(0)
    expect(ANCHORED.leash).toBe(true)
  })

  it('the pin caption', () => {
    expect(pinCaption(PIN, 340, null)).toBe('the film shows 39.2994,-76.6410. it is 340 m behind you and it has not moved.')
    expect(pinCaption(PIN, 340, 'i')).toBe('the film shows 39.2994,-76.6410. it is 340 m behind you and it has not moved. one letter developed beside it: "i".')
  })

  it('isSamePin is the anchor seed\'s ~11 m rounding', () => {
    const near = { lat: 39.29942, lng: -76.64102 }   // a few metres off, same 4-decimal cell
    const far = { lat: 39.3084, lng: -76.641 }       // ~1 km north
    expect(anchorSeed(near.lat, near.lng)).toBe(anchorSeed(PIN.lat, PIN.lng))
    expect(isSamePin(PIN, PIN)).toBe(true)
    expect(isSamePin(PIN, near)).toBe(true)
    expect(isSamePin(PIN, far)).toBe(false)
    expect(isSamePin(PIN, null)).toBe(false)
    expect(isSamePin(null, null)).toBe(false)
  })

  it('the polaroid finds the pin past 200 m or on the first shot of a floor', () => {
    expect(ANCHORED.polaroid({ D: 300, firstShotOfLevel: false, glyph: 'w', anchor: PIN }))
      .toEqual({ cap: pinCaption(PIN, 300, 'w'), advance: true, leashCalm: 60 })
    const first = ANCHORED.polaroid({ D: 50, firstShotOfLevel: true, glyph: null, anchor: PIN })
    expect(first).toEqual({ cap: pinCaption(PIN, 50, null), advance: false, leashCalm: 60 })
    expect(ANCHORED.polaroid({ D: 50, firstShotOfLevel: false, glyph: 'w', anchor: PIN })).toBe(null)
  })

  it('a same-pin friend steadies you more', () => {
    expect(FRIEND_SAME_PIN).toBe(5)
    expect(ANCHORED.friendBase({ rp: { aseed: 7 }, selfAseed: 7 })).toBe(5)
    expect(ANCHORED.friendBase({ rp: { aseed: 8 }, selfAseed: 7 })).toBe(3)
    expect(ANCHORED.friendBase({ rp: { aseed: null }, selfAseed: null })).toBe(3)
    expect(ANCHORED.friendBase({ rp: {}, selfAseed: undefined })).toBe(3)
  })

  it('the death, the beacon, the address line, the mercy', () => {
    expect(ANCHORED.deathEffects({ filed: true, thin: true, D: 640 }))
      .toEqual({ mintThin: true, leashDebt: 640, line: 'the body is pulling you back. it is not there yet. still thin.' })
    expect(ANCHORED.deathEffects({ filed: true, thin: false, D: 640 }).line).toBe(`${DEATH_LINE} not all of you came back up.`)
    expect(ANCHORED.beacon).toEqual({ carriesPin: true, filesFloor: false, line: 'you push the beacon into the dark. it carries the pin.' })
    expect(ANCHORED.presenceReply('wish')).toBe('your request is noted against an address. the address is real. that is the problem.')
    expect(ANCHORED.presenceReply('claim')).toBe(null)
    expect(MERCY_LINE).toBe('the floor moved under the pin. for a moment you are close. it will not stay.')
    expect(copy(ANCHORED.perception(pctx({ stillFor: 0 })))).toEqual({ sightMul: 1, hidden: false, loseTrackMul: 1, noiseMul: 1 })
    expect(ANCHORED.perception(pctx()).hidden).toBe(true)
  })
})

describe('processed', () => {
  it('floorKey keys a floor the way worldSeed is keyed everywhere (| 0)', () => {
    expect(floorKey(null, 2)).toBe('0:2')
    expect(floorKey(0, 2)).toBe('0:2')
    expect(floorKey(123456, '∅')).toBe('123456:∅')
    expect(floorKey(4294967295, 1)).toBe('-1:1')
  })

  it('the vocabulary: the file did things; only the slip says what it calls them', () => {
    expect(SLIP_LINE).toContain('status: EXTENSION')
    expect(SLIP_LINE).toContain('2004-11-08')
    for (const s of [RADIO_KEY_LINE, OPENED_LINE, RELEASE_LINE, SOUR.line, NPC_REFUSAL.text, processedMod.BEACON_LINE, WISH_REPLY]) {
      expect(s).toBe(s.toLowerCase())
      expect(s).not.toContain('!')
      expect(s.toLowerCase().replace(/[^a-z]/g, '')).not.toMatch(/iwashere/)
      expect(s).not.toMatch(/extension|compliance|litigation|notice-mailed/)
    }
  })

  it('sour water, sweet water, scraps, the npc', () => {
    expect(PROCESSED.sourWater(2)).toBe(SOUR)
    expect(SOUR).toEqual({ sanity: 0, slam: false, whisper: false, flicker: false, line: 'the water is sour. a line moves in a ledger. it is your line. it moved years ago.' })
    expect(Object.isFrozen(SOUR)).toBe(true)
    expect(PROCESSED.sweetWater).toBe(35)
    expect(PROCESSED.scrapSanity).toBe(3)
    expect(processedMod.SCRAP_SANITY).toBe(3)
    expect(PROCESSED.npcLine()).toEqual({ text: 'you are one of them. i can see the stamp.', sanity: -2 })
  })

  it('perception: the ledger has your location below the first floor', () => {
    expect(copy(PROCESSED.perception(pctx({ depth: 1, stillFor: 0 })))).toEqual({ sightMul: 1, hidden: false, loseTrackMul: 1, noiseMul: 1 })
    expect(copy(PROCESSED.perception(pctx({ depth: 3, stillFor: 0 })))).toEqual({ sightMul: 1.25, hidden: false, loseTrackMul: 1, noiseMul: 1 })
    expect(PROCESSED.perception(pctx()).hidden).toBe(true)
    expect(PROCESSED.perception(pctx({ litNear: true })).sightMul).toBeCloseTo(1.25 * 0.45, 12)
  })

  it('the radio reads every group, and the key on the first deep hearing', () => {
    expect({ ...PROCESSED.radio({ last: false, firstDeepHearing: true }) }).toEqual({ heartbeat: 'every', followUp: RADIO_KEY_LINE })
    expect({ ...PROCESSED.radio({ last: true, firstDeepHearing: false }) }).toEqual({ heartbeat: 'every', followUp: LEGACY_LAST_LINE })
    expect({ ...PROCESSED.radio({ last: false, firstDeepHearing: false }) }).toEqual({ heartbeat: 'every', followUp: null })
  })

  it('the beacon files the floor; the wish is an amendment; a claim re-files you', () => {
    expect(PROCESSED.beacon).toEqual({ carriesPin: false, filesFloor: true, line: 'you push the beacon into the dark. the floor files the push.' })
    expect(PROCESSED.wishMeta()).toEqual({ origin: 'processed' })
    expect(PROCESSED.presenceReply('wish')).toBe('amendment received. the file will be corrected, or it will not.')
    expect(PROCESSED.presenceReply('claim')).toBe(null)
    expect(claimRefile('anchored')).toEqual({ origin: 'processed', lines: [RELEASE_LINE, OPENED_LINE] })
    expect(claimRefile('tenant')).toEqual({ origin: 'processed', lines: [OPENED_LINE] })
  })
})

describe('unnamed', () => {
  it('parseNameWish hears "call me" and "my name is", nothing else', () => {
    expect(parseNameWish('call me Ada')).toBe('Ada')
    expect(parseNameWish('my name is  jo ')).toBe('jo')
    expect(parseNameWish('CALL ME ada')).toBe('ada')
    expect(parseNameWish('call me ' + 'a'.repeat(21))).toBe('a'.repeat(21))
    for (const t of ['i am lost', 'i was here', 'call me', 'call me ' + 'a'.repeat(22), 'call me -x', '', null, undefined])
      expect([t, parseNameWish(t)]).toEqual([t, null])
  })

  it('a name re-files you as a tenant, or anchored with a pin, never processed; the ctx is not mutated', () => {
    const solo = Object.freeze({ route: 'solo', arrival: 'walked', anchor: null, name: '' })
    const r = refileWithName(solo, 'ada')
    expect(r).toEqual({ ...solo, name: 'ada' })
    expect(r).not.toBe(solo)
    expect(solo.name).toBe('')
    expect(intake(r)).toBe('tenant')
    expect(intake(refileWithName({ ...solo, anchor: PIN }, 'ada'))).toBe('anchored')
    expect(intake(refileWithName({ route: 'online', arrival: 'dropped', anchor: null, name: '' }, 'ada'))).toBe('tenant')
    expect(intake({ route: 'online', arrival: 'dropped', anchor: null, name: '' })).toBe('unnamed')
  })

  it('the spelling card and the spelled line', () => {
    expect(spellCard('Ada')).toEqual({ text: 'Ada. is that how it is spelled?', foot: 'e · yes      esc · no' })
    expect(spelledLine('Ada', 'tenant')).toBe('ada. spelled. the file has you at an address now.')
    expect(spelledLine('Ada', 'anchored')).toBe('ada. spelled. the file has your body at a pin.')
    expect(ONLINE_LINE).toBe('the room will know you next time.')
  })

  it('no seam, no claim, a little more from scraps and friends, less from water, a short memory', () => {
    expect(UNNAMED.canHoldSeam).toBe(false)
    expect(UNNAMED.canDevelopClaim).toBe(false)
    expect(UNNAMED.scrapSanity).toBe(9)
    expect(UNNAMED.sweetWater).toBe(20)
    for (const c of [{ rp: { aseed: 7 }, selfAseed: 7 }, { rp: {}, selfAseed: null }]) expect(UNNAMED.friendBase(c)).toBe(4)
    for (let depth = 0; depth <= 3; depth++)
      expect(copy(UNNAMED.perception(pctx({ depth, stillFor: 0 })))).toEqual({ sightMul: 1, hidden: false, loseTrackMul: 0.75 / 3.5, noiseMul: 1 })
    expect(copy(UNNAMED.perception(pctx()))).toEqual({ sightMul: 1, hidden: true, loseTrackMul: 0.75 / 3.5, noiseMul: 1 })
    expect(UNNAMED.perception(pctx({ litNear: true })).sightMul).toBeCloseTo(0.45, 12)
  })

  it('the film develops a letter that is not yours; the radio does not say whose', () => {
    expect(UNNAMED.polaroid({ glyph: 'i' })).toEqual({ cap: 'the film develops a letter. it is not one of yours. you have none.', advance: false })
    expect(UNNAMED.polaroid({ glyph: null })).toBe(null)
    expect(GLYPH_LINE).toBe('the film develops a letter. it is not one of yours. you have none.')
    expect({ ...UNNAMED.radio({ last: true }) }).toEqual({ heartbeat: 'none', followUp: 'it reads the last group, then stops. it did not say whose.' })
    expect({ ...UNNAMED.radio({ last: false }) }).toEqual({ heartbeat: 'none', followUp: null })
    expect(LAST_GROUP_LINE).toBe('it reads the last group, then stops. it did not say whose.')
  })
})

describe('thin (the layer alone)', () => {
  it('the numbers', () => {
    expect([STILL_S, MEMORY_S, DAMAGE_MUL, RECOIL_DIST, RECOIL_SHAKE, NOISE_MUL, RADIO_CARRY, GLOW_SANITY])
      .toEqual([0.6, 1.5, 0.7, 1.7, 0.7, 0.5, 0.5, -4])
  })

  it('perception: hidden after 0.6 s still, whatever the light; the radio half-carries', () => {
    const p0 = THIN.perception({ stillFor: 0.59, noiseFor: 10, radioOn: false, flashlight: true })
    expect(copy(p0)).toEqual({ sightMul: 1, hidden: false, loseTrackMul: 1.5 / 3.5, noiseMul: 0.5 })
    expect(THIN.perception({ stillFor: 0.6, noiseFor: 10, radioOn: false, flashlight: true }).hidden).toBe(true)
    expect(THIN.perception({ stillFor: 0.6, noiseFor: 10, radioOn: false, flashlight: false }).hidden).toBe(true)
    expect(THIN.perception({ stillFor: 10, noiseFor: 0.3, radioOn: false, flashlight: false }).hidden).toBe(false)
    const radio = copy(THIN.perception({ stillFor: 10, noiseFor: 10, radioOn: true, flashlight: false }))
    expect(radio.hidden).toBe(false)
    expect(radio.sightMul).toBe(0.5)
    expect(THIN.perception({ stillFor: 10, noiseFor: 10, radioOn: false, flashlight: false, litNear: true }).sightMul).toBeCloseTo(0.45, 12)
    expect(THIN.perception({ stillFor: 10, noiseFor: 10, radioOn: true, flashlight: false, litNear: true }).sightMul).toBeCloseTo(0.225, 12)
    expect(THIN.perception({ stillFor: 10, noiseFor: 10, radioOn: false, flashlight: true, litNear: true }).sightMul).toBe(1)
    expect(THIN.perception(pctx())).toBe(THIN.perception(pctx({ radioOn: true })))
    expect(thinHidden(0.59, 10)).toBe(false)
    expect(thinHidden(0.6, 10)).toBe(true)
    expect(thinHidden(10, 0.3)).toBe(false)
  })

  it('the light goes through you', () => {
    for (const ln of [false, true]) for (let d = 0; d <= 3; d++) expect(THIN.lightTerm(true, ln, d)).toBe(-2)
    for (let d = 0; d <= 3; d++) { expect(THIN.lightTerm(false, false, d)).toBe(2); expect(THIN.lightTerm(false, true, d)).toBe(0) }
  })

  // F1: unlit in a friend's light is +1 on every column (W4 sanityStep light term); thin keeps 0 — the light goes through you
  it("a friend's light steadies every column unlit, and only the layer", () => {
    for (const B of [TENANT, ANCHORED, PROCESSED, UNNAMED]) {
      for (let d = 0; d <= 3; d++) { expect(B.lightTerm(false, true, d)).toBe(1); expect(B.lightTerm(true, true, d)).toBe(2) }
    }
    for (const B of [ANCHORED, PROCESSED, UNNAMED]) for (let d = 0; d <= 3; d++) expect(B.lightTerm(false, false, d)).toBe(-2)
    for (const o of ['tenant', 'anchored', 'processed', 'unnamed']) {
      expect(rulesFor(o, false).lightTerm(false, true, 2)).toBe(1)
      expect(rulesFor(o, true).lightTerm(false, true, 2)).toBe(0)
    }
    for (const ln of [false, true]) expect(LEGACY.lightTerm(false, ln, 2)).toBe(-2)
  })

  it('damage, the recoil, the glowstick, the first shot, the crosser, the giver, the lines', () => {
    expect(THIN.damageMul).toBe(0.7)
    expect(THIN.wardRecoil).toBe(true)
    expect(RECOIL_LINE).toBe('it recoils from you. so do you.')
    expect(THIN.itemEffect({ type: 'glowstick' }, 0)).toEqual({ fog: 45, calm: 8, blip: true, sanity: -4, line: GLOW_LINE })
    expect(THIN.itemEffect({ type: 'glowstick' }, 3).fog).toBe(27)
    expect(THIN.itemEffect({ type: 'glowstick' }, 4).fog).toBe(27)
    expect(THIN.itemEffect({ type: 'almond-water' }, 2)).toBe(LEGACY_EFFECT)
    expect(THIN.itemEffect(null, 2)).toBe(LEGACY_EFFECT)
    expect(THIN.polaroid({ thinFirstShot: true })).toEqual({ cap: FIRST_SHOT_LINE, advance: false })
    expect(THIN.polaroid({ thinFirstShot: false })).toBe(null)
    expect(THIN.crosserPause()).toEqual({ pause: 1.2, sanity: 4, line: 'someone else who dropped in. they wave. you can see the wall through them too.' })
    expect(THIN.crosserPause()).toBe(CROSSER)
    expect(Object.isFrozen(CROSSER)).toBe(true)
    expect(thinGiverMul(0.59)).toBe(0)
    expect(thinGiverMul(0.6)).toBe(1)
    for (const s of [0, 0.59, 0.6, 3]) expect(THIN.giverMul(s)).toBe(thinGiverMul(s))
    expect(CURE_LINE).toBe('you are as here as anyone.')
    expect(FIRST_LINE).toBe('not all of you came back up.')
    expect(AGAIN_LINE).toBe('still thin.')
  })
})

describe('tone sweep', () => {
  const strings = []
  const walk = (v, seen = new Set()) => {
    if (typeof v === 'string') { strings.push(v); return }
    if (!v || typeof v !== 'object' || v instanceof RegExp || seen.has(v)) return
    seen.add(v)
    for (const x of Object.values(v)) walk(x, seen)
  }
  // every exported string — SEALED_CELLS aside: its 'C' / 'P' are NULL_MAP's material codes, not words
  for (const m of [intakeMod, tenantMod, anchoredMod, processedMod, unnamedMod, thinMod])
    for (const v of Object.values(m)) if (v !== SEALED_CELLS) walk(v)
  for (const v of Object.values(LEGACY)) walk(v)
  // what the blocks say when called
  for (const o of ['tenant', 'anchored', 'processed', 'unnamed']) for (const t of [false, true]) {
    const r = rulesFor(o, t)
    strings.push(r.presenceReply('wish') ?? '', r.npcLine()?.text ?? '', r.radio({ last: true, firstDeepHearing: true }).followUp ?? '',
      r.deathEffects({ filed: true, thin: t, D: 300 }).line, r.polaroid({ thinFirstShot: t, D: 300, glyph: 'i', anchor: PIN, firstShotOfLevel: true })?.cap ?? '')
  }

  it('every string is lowercase once the record\'s own uppercase is removed, with no exclamation mark', () => {
    expect(strings.length).toBeGreaterThan(40)
    for (const s of strings) {
      const bare = s.replace(/30150A|EXTENSION/g, '')
      expect([s, bare === bare.toLowerCase()]).toEqual([s, true])
      expect([s, s.includes('!')]).toEqual([s, false])
    }
  })

  it('no death line wakes you where you fell in (the core wakes you a floor above)', () => {
    for (const s of strings) expect(s).not.toContain('you wake where you fell in.')
  })

  it('only DOOR_LINES[1] and SLIP_LINE carry the record\'s uppercase', () => {
    const upper = [...new Set(strings.filter((s) => s !== s.toLowerCase()))]
    expect(upper.sort()).toEqual([DOOR_LINES[1], SLIP_LINE].sort())
  })
})
