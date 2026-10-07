// compose-radio.js — what the radio reads: silence, the crackle, the roll call, or the ledger (with the column's heartbeat and
// follow-up, and the roll call's count over the legacy last line).
import { describe, it, expect } from 'vitest'
import { radioLine, words, WORDS, RADIO_GROUPS, COUNT_LINE } from '../src/renderer/compose-radio.js'
import { LEGACY, LEGACY_LAST_LINE, rulesFor } from '../src/renderer/origin-rules.js'
import { RADIO_KEY_LINE } from '../src/renderer/origin-processed.js'
import { LAST_GROUP_LINE } from '../src/renderer/origin-unnamed.js'
import { statusMods } from '../src/renderer/status.js'
import { WORDS as CLOSING_WORDS } from '../src/renderer/closings.js'
import { WORDS as ROLLCALL_WORDS } from '../src/renderer/rollcall.js'

const ledger = (over = {}) => ({ on: true, rules: LEGACY, mode: 'ledger', stationIdx: 3, groups: RADIO_GROUPS, count: 1, firstDeepHearing: false, rollLine: null, ...over })

describe('the ledger, through the blocks', () => {
  it('unnamed: no heartbeat on the last group, and it did not say whose', () => {
    const r = radioLine(ledger({ rules: rulesFor('unnamed', false) }))
    expect(r.heartbeat).toBe(false)
    expect(r.followUps).toEqual([{ text: LAST_GROUP_LINE, ms: 1900 }])
    expect(LAST_GROUP_LINE).toBe('it reads the last group, then stops. it did not say whose.')
  })
  it('the count layers over the legacy last line only', () => {
    expect(radioLine(ledger({ count: 3 })).followUps).toEqual([{ text: 'it reads the last group, then stops. those were yours — three of you.', ms: 1900 }])
    expect(radioLine(ledger({ count: 2 })).followUps[0].text).toBe('it reads the last group, then stops. those were yours — two of you.')
    expect(radioLine(ledger({ count: 1 })).followUps).toEqual([{ text: LEGACY_LAST_LINE, ms: 1900 }])
    expect(radioLine(ledger({ count: 5, rules: rulesFor('unnamed', false) })).followUps[0].text).toBe(LAST_GROUP_LINE)   // unnamed beats the count
    expect(COUNT_LINE(4)).toBe('it reads the last group, then stops. those were yours — four of you.')
  })
  it('processed: a heartbeat on every group; the key line once on the first deep hearing', () => {
    const P = rulesFor('processed', false)
    for (let s = 0; s < 4; s++) expect(radioLine(ledger({ rules: P, stationIdx: s })).heartbeat).toBe(true)
    const key = radioLine(ledger({ rules: P, stationIdx: 0, firstDeepHearing: true }))
    expect(key.followUps).toEqual([{ text: RADIO_KEY_LINE, ms: 1900 }])
    expect(key.keyLineNow).toBe(true)
    const last = radioLine(ledger({ rules: P, stationIdx: 3, firstDeepHearing: false }))
    expect(last.followUps).toEqual([{ text: LEGACY_LAST_LINE, ms: 1900 }])
    expect(last.keyLineNow).toBe(false)
    expect(radioLine(ledger({ rules: P, stationIdx: 3, count: 4 })).followUps[0].text).toBe(COUNT_LINE(4))
    expect(radioLine(ledger({ rules: P, stationIdx: 1 })).followUps).toEqual([])
  })
  it('the legacy heartbeat beats on the last group only; advance on every ledger read; ledgerHeardNow on the last', () => {
    for (let s = 0; s < 4; s++) {
      const r = radioLine(ledger({ stationIdx: s }))
      expect(r.heartbeat).toBe(s === 3)
      expect(r.advance).toBe(true)
      expect(r.blip).toBe(true)
      expect(r.ledgerHeardNow).toBe(s === 3)
      expect(r.message).toBe(`the station counts, slow and patient: ${RADIO_GROUPS[s]}${s === 3 ? '' : ' …'}   [${s + 1}/4]`)
    }
  })
  it("a block's reused radio object is read inside the call", () => {
    const shared = { heartbeat: 'every', followUp: 'a line.' }
    const rules = { ...LEGACY, radio: () => shared }
    const r = radioLine(ledger({ rules, stationIdx: 0 }))
    shared.heartbeat = 'none'; shared.followUp = 'another.'
    expect(r.heartbeat).toBe(true)
    expect(r.followUps).toEqual([{ text: 'a line.', ms: 1900 }])
  })
})

describe('the other modes', () => {
  it('roll: the roll call line (or the crackle when there is none), a blip, no advance', () => {
    const r = radioLine({ on: true, rules: LEGACY, mode: 'roll', stationIdx: 2, groups: RADIO_GROUPS, count: 3, firstDeepHearing: true, rollLine: 'six of you on this floor.' })
    expect(r).toEqual({ message: 'six of you on this floor.', blip: true, heartbeat: false, followUps: [], advance: false, ledgerHeardNow: false, keyLineNow: false })
    expect(radioLine({ on: true, rules: LEGACY, mode: 'roll', stationIdx: 0, groups: RADIO_GROUPS, count: 1, firstDeepHearing: false, rollLine: null }).message).toBe('the radio crackles to life.')
  })
  it('crackle on depth 0-1 for notice-mailed; roll for a filed status', () => {
    expect(statusMods('notice-mailed').radioMode(1)).toBe('crackle')
    expect(statusMods('extension').radioMode(0)).toBe('roll')
    const r = radioLine({ on: true, rules: LEGACY, mode: statusMods('notice-mailed').radioMode(0), stationIdx: 0, groups: RADIO_GROUPS, count: 1, firstDeepHearing: false, rollLine: 'x' })
    expect(r).toEqual({ message: 'the radio crackles to life.', blip: false, heartbeat: false, followUps: [], advance: false, ledgerHeardNow: false, keyLineNow: false })
  })
  it('off: silent, whatever the mode', () => {
    for (const mode of ['ledger', 'roll', 'crackle']) {
      expect(radioLine({ on: false, rules: rulesFor('processed', false), mode, stationIdx: 3, groups: RADIO_GROUPS, count: 4, firstDeepHearing: true, rollLine: 'x' }))
        .toEqual({ message: 'the radio falls silent.', blip: false, heartbeat: false, followUps: [], advance: false, ledgerHeardNow: false, keyLineNow: false })
    }
  })
})

describe('words', () => {
  it('one .. thirty-two, then many', () => {
    expect(WORDS.length).toBe(32)
    expect(words(1)).toBe('one')
    expect(words(13)).toBe('thirteen')
    expect(words(20)).toBe('twenty')
    expect(words(21)).toBe('twenty-one')
    expect(words(32)).toBe('thirty-two')
    expect(words(33)).toBe('many')
    for (let n = 1; n <= 32; n++) expect(words(n)).toMatch(/^[a-z-]+$/)
  })
  it('agrees with closings.WORDS (1..13) and rollcall.WORDS (1..12)', () => {
    for (let n = 1; n <= 13; n++) expect(words(n)).toBe(CLOSING_WORDS[n])
    for (let n = 1; n <= 12; n++) expect(words(n)).toBe(ROLLCALL_WORDS[n])
  })
})
