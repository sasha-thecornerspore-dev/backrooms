import { describe, it, expect } from 'vitest'
import {
  canFinale, standConditions, standTick, isCloseWish, closeFile, closingOverlay, closingLines, closingReply,
  isWishOpen, CLOSED_OFFICE, closingProgress, slipText, NO_STANDING, yourFileLines, WORDS,
} from '../src/renderer/closings.js'
import { STATUSES, STRINGS } from '../src/renderer/status.js'
import { SLIP_LINE as PROCESSED_SLIP_LINE } from '../src/renderer/origin-processed.js'

const CLOSING_VALUES = ['extension', 'compliance', 'litigation']
// game.js:1081 (2cb9c76) — the extension slip's line today, quoted
const LEGACY_SLIP = 'notice 30150A. status: EXTENSION — the one line the system never closed. a door left ajar it cannot foreclose. make your claim where the presence waits.'
const file = (n, extra = {}) => ({ status: 'notice-mailed', at: null, ledgerHeard: false, closing: null, redacted: Array.from({ length: n }, (_, i) => i), ...extra })

describe('canFinale — the unaffiliated keep today\'s ending', () => {
  it('litigation and notice-mailed may hold the seam while nothing is closed', () => {
    expect(canFinale('litigation', null)).toBe(true)
    expect(canFinale('notice-mailed', null)).toBe(true)
    expect(canFinale('notice-mailed', undefined)).toBe(true)
    expect(canFinale('extension', null)).toBe(false)
    expect(canFinale('compliance', null)).toBe(false)
  })
  it('nobody once a closing is filed', () => {
    for (const s of STATUSES) for (const c of CLOSING_VALUES) expect(canFinale(s, c), `${s} ${c}`).toBe(false)
  })
})

describe('the stand', () => {
  const REF = { status: 'extension', closing: null, depth: 3, standFloor: 3, flashlight: false, ledgerHeard: true, moving: false, nearD: Infinity, sanity: 60, transitioning: false }
  it('the reference ctx stands', () => {
    expect(standConditions(REF)).toBe(true)
  })
  it('any one flip breaks it', () => {
    const flips = [
      { flashlight: true }, { moving: true }, { nearD: 9 }, { ledgerHeard: false }, { sanity: 30 }, { transitioning: true },
      { closing: 'extension' }, { status: 'notice-mailed' }, { status: 'compliance' }, { status: 'litigation' },
      { depth: 2, standFloor: 3 }, { depth: 1, standFloor: 2 }, { ledgerHeard: 'yes' },
    ]
    for (const f of flips) expect(standConditions({ ...REF, ...f }), JSON.stringify(f)).toBe(false)
  })
  it('the edges', () => {
    expect(standConditions({ ...REF, nearD: 10 })).toBe(true)
    expect(standConditions({ ...REF, sanity: 31 })).toBe(true)
    expect(standConditions({ ...REF, depth: 2, standFloor: 2 })).toBe(true)
  })
  it('never below depth 2: the lobby and ∅ are out', () => {
    for (const sf of [1, 0, -1]) for (let d = 0; d <= 3; d++) expect(standConditions({ ...REF, depth: d, standFloor: sf }), `${sf} ${d}`).toBe(false)
  })
  it('standFloor absent reads as 3', () => {
    const { standFloor, ...rest } = REF
    expect(standConditions(rest)).toBe(true)
    expect(standConditions({ ...rest, depth: 2 })).toBe(false)
    expect(standConditions({ ...REF, standFloor: undefined })).toBe(true)
    expect(standConditions({ ...REF, standFloor: null })).toBe(true)
  })
})

describe('standTick', () => {
  it('44.9 s then one bad frame: nothing, and the clock returns to zero', () => {
    let held = 0
    for (let i = 0; i < 449; i++) {
      const r = standTick(held, 0.1, true)
      expect(r.done).toBe(false)
      held = r.held
    }
    expect(held).toBeGreaterThan(44.8)
    const r = standTick(held, 0.1, false)
    expect(r.held).toBe(0)
    expect(r.done).toBe(false)
  })
  it('45 s: done exactly once, on the crossing frame', () => {
    let held = 0
    const doneAt = []
    let prev = 0
    for (let i = 0; i < 470; i++) {
      const r = standTick(held, 0.1, true)
      if (r.done) { doneAt.push(i); expect(prev).toBeLessThan(45); expect(r.held).toBeGreaterThanOrEqual(45) }
      prev = held = r.held
    }
    expect(doneAt.length).toBe(1)
    expect(doneAt[0]).toBeGreaterThanOrEqual(448)
    expect(doneAt[0]).toBeLessThanOrEqual(450)
    const after = standTick(held, 0.1, true)
    expect(after.done).toBe(false)
    expect(after.held).toBeGreaterThan(held)
  })
  it('one reused object, never a new one per frame', () => {
    const a = standTick(0, 0.1, true)
    const b = standTick(a.held, 0.1, false)
    const c = standTick(0, 1, true, 2)
    expect(b).toBe(a)
    expect(c).toBe(a)
  })
  it('needS 2, dt 1: done on the second frame', () => {
    const r1 = standTick(0, 1, true, 2)
    expect(r1.done).toBe(false)
    const h = r1.held
    const r2 = standTick(h, 1, true, 2)
    expect(r2.done).toBe(true)
    expect(r2.held).toBe(2)
  })
})

describe('closing the file', () => {
  it('isCloseWish reads only the one sentence', () => {
    for (const t of ['close the file', ' Close The File ', 'close the file\n']) expect(isCloseWish(t), t).toBe(true)
    for (const t of ['compliance', 'please close the file', 'close the file now', '', null, undefined]) expect(isCloseWish(t), String(t)).toBe(false)
  })
  it('not ready until thirteen pages are given up', () => {
    const f12 = file(12)
    const r = closeFile(f12)
    expect(r.file).toBe(f12)
    expect(r.closed).toBe(false)
    expect(r.reply).toBe('the file is not ready to close. twelve of thirteen pages given up.')
    expect(r.reply.endsWith('twelve of thirteen pages given up.')).toBe(true)
    expect(closeFile(file(0)).reply).toBe('the file is not ready to close. zero of thirteen pages given up.')
  })
  it('thirteen or more: compliance', () => {
    for (const n of [13, 26]) {
      const f = file(n, { status: 'compliance', at: 5 })
      const r = closeFile(f)
      expect(r.closed).toBe(true)
      expect(r.file).not.toBe(f)
      expect(r.file.closing).toBe('compliance')
      expect(r.file.status).toBe('compliance')
      expect(r.file.redacted).toEqual(f.redacted)
      expect(r.reply).toBe(STRINGS.COMPLIANCE_CLOSED)
      expect(f.closing).toBe(null)
    }
    expect(STRINGS.COMPLIANCE_CLOSED).toBe('the file reaches compliance. the fourteenth, in twenty-one years. the office does not celebrate.')
  })
  it('WORDS count zero to thirteen', () => {
    expect(WORDS.length).toBe(14)
    expect(WORDS[0]).toBe('zero')
    expect(WORDS[4]).toBe('four')
    expect(WORDS[12]).toBe('twelve')
    expect(WORDS[13]).toBe('thirteen')
    expect(Object.isFrozen(WORDS)).toBe(true)
  })
})

describe('closingOverlay', () => {
  it('nothing closed is one frozen empty object', () => {
    const co = closingOverlay(null)
    expect(Object.isFrozen(co)).toBe(true)
    expect(Object.keys(co).length).toBe(0)
    expect(co.scrapsDenom === 0).toBe(false)
    expect(co.tension ?? 0).toBe(0)
    expect(co.presence).toBe(undefined)
    expect(co.sanityDepthTerm).toBe(undefined)
    expect(closingOverlay(null)).toBe(co)
    expect(closingOverlay(undefined)).toBe(co)
    expect(closingOverlay('litigation')).toBe(co)
    expect(closingOverlay('nonsense')).toBe(co)
  })
  it('compliance: no presence, no pages, less tension', () => {
    const co = closingOverlay('compliance')
    expect(co).toEqual({ presence: false, scrapsDenom: 0, tension: -0.3 })
    expect(Object.isFrozen(co)).toBe(true)
    expect(closingOverlay('compliance')).toBe(co)
  })
  it('extension: the street frays you, the deep holds you', () => {
    const co = closingOverlay('extension')
    expect(Object.isFrozen(co)).toBe(true)
    expect(Object.keys(co)).toEqual(['sanityDepthTerm'])
    const t = co.sanityDepthTerm
    expect(t(0, 0)).toBe(-1.5)
    expect(t(4, 0)).toBe(-1.5)
    expect(t(1, 1)).toBe(-0.75)
    expect(t(2, 2)).toBe(0.75)
    expect(t(3, 3)).toBe(0.75)
  })
  it('isWishOpen: only compliance closes the office', () => {
    expect(isWishOpen(null)).toBe(true)
    expect(isWishOpen(undefined)).toBe(true)
    expect(isWishOpen('extension')).toBe(true)
    expect(isWishOpen('litigation')).toBe(true)
    expect(isWishOpen('compliance')).toBe(false)
    expect(CLOSED_OFFICE).toBe('the file is closed. there is no one to ask.')
  })
})

describe('closingLines / closingReply', () => {
  it('extension\'s three', () => {
    expect([...closingLines('extension')]).toEqual([
      'the lights hold.',
      'the notice is extended. twenty-two years. you are in it now, under the same word.',
      'the deep is home. the street is the thin place.',
    ])
  })
  it('compliance\'s first line is the dialog\'s reply', () => {
    const L = closingLines('compliance')
    expect(L.length).toBe(3)
    expect(L[0]).toBe(closeFile(file(13)).reply)
  })
  it('the seam keeps its own lines; nothing closed has none', () => {
    expect([...closingLines('litigation')]).toEqual([])
    expect([...closingLines(null)]).toEqual([])
  })
  it('closingReply', () => {
    expect(closingReply('extension')).toBe('the file notes the extension. received.')
    for (const c of [null, 'compliance', 'litigation']) expect(closingReply(c)).toBe(null)
  })
  it('lowercase, no exclamation', () => {
    for (const c of [...CLOSING_VALUES, null]) for (const l of [...closingLines(c), closingReply(c) ?? '']) {
      expect(l).toBe(l.toLowerCase())
      expect(l).not.toContain('!')
    }
  })
})

describe('closingProgress', () => {
  it('extension: the ledger, then the stand', () => {
    const p = closingProgress('extension', { ledgerHeard: true, closing: null })
    expect(p.done).toBe(false)
    expect(p.steps).toEqual([{ label: 'the station has read its last group to you', met: true }, { label: 'standing in the dark on the deepest floor', met: false }])
    expect(closingProgress('extension', { ledgerHeard: true, closing: 'extension' }).done).toBe(true)
  })
  it('compliance: thirteen pages, then the file closed', () => {
    const p = closingProgress('compliance', { redacted: [1, 2, 3, 4] })
    expect(p.steps[0]).toEqual({ label: 'four of thirteen pages given up', met: false })
    expect(p.steps[1]).toEqual({ label: 'the file, closed', met: false })
    expect(p.done).toBe(false)
    const q = closingProgress('compliance', { redacted: Array.from({ length: 13 }, (_, i) => i), closing: 'compliance' })
    expect(q.steps[0]).toEqual({ label: 'thirteen pages given up', met: true })
    expect(q.steps[1].met).toBe(true)
    expect(q.done).toBe(true)
    expect(closingProgress('compliance', { redacted: 7 }).steps[0].label).toBe('seven of thirteen pages given up')
    expect(closingProgress('compliance', { redacted: 20 }).steps[0]).toEqual({ label: 'thirteen pages given up', met: true })
  })
  it('litigation: the claim, then the beacon', () => {
    const p = closingProgress('litigation', { claimFiled: true, beaconFired: false })
    expect(p.steps).toEqual([{ label: 'the claim, typed', met: true }, { label: 'the beacon, pushed', met: false }])
    expect(p.done).toBe(false)
    expect(closingProgress('litigation', { claimFiled: true, beaconFired: true, closing: 'litigation' }).done).toBe(true)
  })
  it('the unaffiliated have no steps', () => {
    expect(closingProgress('notice-mailed', {})).toEqual({ done: false, steps: [] })
    expect(closingProgress('notice-mailed')).toEqual({ done: false, steps: [] })
  })
})

describe('slipText', () => {
  it('legacy, quoted (game.js:1081)', () => {
    for (const [o, s, c] of [['tenant', 'notice-mailed', null], [null, 'notice-mailed', null], ['tenant', 'litigation', null], ['anchored', 'compliance', null]]) {
      expect(slipText(o, s, c), `${o} ${s} ${c}`).toBe(LEGACY_SLIP)
    }
    expect(STRINGS.SLIP_LEGACY).toBe(LEGACY_SLIP)
  })
  it('the extension\'s own slip', () => {
    for (const [o, s, c] of [['tenant', 'extension', null], ['processed', 'litigation', 'extension'], ['unnamed', 'notice-mailed', 'extension']]) {
      const t = slipText(o, s, c)
      expect(t).toContain('it will not close')
      expect(t).not.toContain('make your claim')
      expect(t).toBe(STRINGS.SLIP_EXTENSION)
    }
    expect(STRINGS.SLIP_EXTENSION).toBe('notice 30150A. status: EXTENSION. twenty-two years. it is yours now, and it will not close.')
  })
  it('the processed read their own line', () => {
    expect(slipText('processed', 'litigation', null)).toBe(PROCESSED_SLIP_LINE)
    expect(slipText('processed', 'notice-mailed', null)).toBe(PROCESSED_SLIP_LINE)
  })
})

describe('your file', () => {
  const ORIGIN_LINES = {
    tenant: 'the file has you at an address.',
    anchored: 'the file has your body at a pin.',
    unnamed: 'the file cannot spell you.',
    processed: 'the file opened a line on you.',
    null: 'the file does not have you yet.',
  }
  it('an unanswered notice', () => {
    const L = yourFileLines(file(0), null, closingProgress('notice-mailed', {}))
    expect(L).toEqual(['notice mailed. unanswered.', 'the file does not have you yet.', 'request a new notice'])
  })
  it('filed, with the date', () => {
    const f = file(0, { status: 'extension', at: Date.UTC(2026, 9, 6), ledgerHeard: true })
    const L = yourFileLines(f, 'tenant', closingProgress('extension', { ledgerHeard: true, closing: null }))
    expect(L).toEqual([
      'filed under extension · since 2026-10-06',
      'the file has you at an address.',
      'the station has read its last group to you · done',
      'standing in the dark on the deepest floor',
      'request a new notice',
    ])
    expect(yourFileLines({ ...f, at: null }, 'tenant', null)[0]).toBe('filed under extension')
  })
  it('every origin has its line; the last is always the control', () => {
    for (const o of [null, 'tenant', 'anchored', 'unnamed', 'processed']) {
      const L = yourFileLines(file(0), o, null)
      expect(L[1]).toBe(ORIGIN_LINES[String(o)])
      expect(L.at(-1)).toBe('request a new notice')
    }
  })
  it('/status: lowercase, no digits but the date', () => {
    for (const s of STATUSES) for (const o of [null, 'tenant', 'anchored', 'unnamed', 'processed']) {
      const f = file(4, { status: s, at: s === 'notice-mailed' ? null : Date.UTC(2026, 9, 6), ledgerHeard: true })
      const j = yourFileLines(f, o, closingProgress(s, { ...f, claimFiled: true, beaconFired: false })).slice(0, -1).join(' · ')
      expect(j).toBe(j.toLowerCase())
      expect(j).not.toContain('!')
      expect(j.replace('2026-10-06', '')).not.toMatch(/\d/)
    }
  })
})

describe('the two refusals', () => {
  it('as written', () => {
    expect(NO_STANDING).toBe('you have no standing to file this.')
    expect(CLOSED_OFFICE).toBe('the file is closed. there is no one to ask.')
  })
})
