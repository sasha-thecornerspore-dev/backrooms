// compose-wish.js — the one wish router: close -> name (unnamed) -> status -> claim -> wish.
import { describe, it, expect, vi, beforeEach } from 'vitest'

// the real status.js, with its two router-facing functions wrapped so the order and the arguments can be watched
vi.mock('../src/renderer/status.js', async (importOriginal) => {
  const real = await importOriginal()
  return { ...real, fileStatus: vi.fn(real.fileStatus), parseStatusWish: vi.fn(real.parseStatusWish) }
})

import { wishRoute, isClaim, LEGACY_CLAIM_REPLY, LEGACY_WISH_REPLY } from '../src/renderer/compose-wish.js'
import { LEGACY, rulesFor } from '../src/renderer/origin-rules.js'
import { claimRefile, OPENED_LINE, RELEASE_LINE } from '../src/renderer/origin-processed.js'
import { loadFile, fileStatus, parseStatusWish } from '../src/renderer/status.js'
import { closeFile } from '../src/renderer/closings.js'

const NOW = 1_800_000_000_000
const file = (over = {}) => ({ ...loadFile(null), ...over })
beforeEach(() => { fileStatus.mockClear(); parseStatusWish.mockClear() })
const ctx = (text, over = {}) => ({ text, origin: null, rules: LEGACY, file: file(), canFile: true, now: NOW, depth: 1, ...over })

describe('the order', () => {
  it("'close the file' under compliance -> close (closeFile's result); under any other status an ordinary wish", () => {
    const f = file({ status: 'compliance', at: 1, redacted: [0, 1, 2] })
    const r = wishRoute(ctx('close the file', { file: f, origin: 'processed', rules: rulesFor('processed', false) }))
    expect(r).toEqual({ kind: 'close', ...closeFile(f) })
    expect(parseStatusWish).not.toHaveBeenCalled()
    expect(fileStatus).not.toHaveBeenCalled()
    expect(r.reply).toBe('the file is not ready to close. three of thirteen pages given up.')
    expect(r.submit).toBeUndefined()
    const full = file({ status: 'compliance', at: 1, redacted: [...Array(13).keys()] })
    const c = wishRoute(ctx(' Close The File ', { file: full }))
    expect(c.kind).toBe('close')
    expect(c.closed).toBe(true)
    expect(c.file.closing).toBe('compliance')
    expect(wishRoute(ctx('close the file', { file: file({ status: 'extension', at: 1 }) })).kind).toBe('wish')
  })
  it("'call me ada' is a name only for the unnamed; 'my name is i was here' names (name wins over claim); 'i am ada' is a wish", () => {
    const un = { origin: 'unnamed', rules: rulesFor('unnamed', false) }
    expect(wishRoute(ctx('call me ada', un))).toEqual({ kind: 'name', name: 'ada' })
    expect(wishRoute(ctx('call me ada', { origin: 'tenant', rules: rulesFor('tenant', false) })).kind).toBe('wish')
    expect(wishRoute(ctx('my name is i was here', un))).toEqual({ kind: 'name', name: 'i was here' })
    expect(wishRoute(ctx('i am ada', un)).kind).toBe('wish')
  })
  it("'extension' / 'file me under litigation' -> status: fileStatus(file, chosen, now, canFile)'s fields, passed through", () => {
    const f = file({ status: 'notice-mailed', at: null })
    const r = wishRoute(ctx('extension', { file: f, canFile: true }))
    expect(fileStatus).toHaveBeenCalledTimes(1)
    expect(fileStatus.mock.calls[0]).toEqual([f, 'extension', NOW, true])
    expect(fileStatus.mock.calls[0][0]).toBe(f)
    expect(r.resets).toBe(fileStatus.mock.results[0].value.resets)
    expect(r.line).toBe(fileStatus.mock.results[0].value.line)
    expect(r.kind).toBe('status')
    expect(r.chosen).toBe('extension')
    const w = fileStatus(f, 'extension', NOW, true)
    expect(r.file).toEqual(w.file)
    expect(r.reply).toBe(w.reply)
    expect(r.line).toBe(w.line)
    expect(r.resets).toBe(w.resets)
    expect(r.submit).toBeUndefined()
    const g = file({ status: 'extension', at: NOW - 2 * 86_400_000 })
    const l = wishRoute(ctx('file me under litigation', { file: g, canFile: false }))
    const wl = fileStatus(g, 'litigation', NOW, false)
    expect(l).toEqual({ kind: 'status', chosen: 'litigation', ...wl })
    const ok = wishRoute(ctx('file me under litigation', { file: g, canFile: true }))
    expect(ok.line).toBe('the office opens a new file. the old one is still closed.')
    expect(ok.resets).toEqual(['photoIdx', 'stationIdx', 'claimFiled'])
  })
  it("'i was here' -> claim with the legacy reply and claimRefile(origin) (null when already processed)", () => {
    for (const o of [null, 'tenant', 'anchored', 'unnamed', 'processed']) {
      const r = wishRoute(ctx('i was here', { origin: o, rules: rulesFor(o, false) }))
      expect(r.kind).toBe('claim')
      expect(r.reply).toBe(LEGACY_CLAIM_REPLY)
      expect(r.refile).toEqual(o === 'processed' ? null : claimRefile(o))
    }
    expect(wishRoute(ctx('i was here', { origin: 'tenant', rules: rulesFor('tenant', false) })).refile).toEqual({ origin: 'processed', lines: [OPENED_LINE] })
    expect(wishRoute(ctx('i was here', { origin: 'anchored', rules: rulesFor('anchored', false) })).refile).toEqual({ origin: 'processed', lines: [RELEASE_LINE, OPENED_LINE] })
  })
  it('local kinds carry no submit and no refile', () => {
    const un = { origin: 'unnamed', rules: rulesFor('unnamed', false) }
    for (const r of [wishRoute(ctx('call me ada', un)), wishRoute(ctx('extension')), wishRoute(ctx('close the file', { file: file({ status: 'compliance', at: 1 }) }))]) {
      expect(r.submit).toBeUndefined()
      expect(r.refile).toBeUndefined()
    }
  })
})

describe('the submit', () => {
  it('the trailer only for a filed status', () => {
    const ext = wishRoute(ctx('let me out', { file: file({ status: 'extension', at: 1 }), depth: 2 }))
    expect(ext.submit.text).toBe('let me out\nfiled under: EXTENSION · level 2')
    const claim = wishRoute(ctx('i was here', { file: file({ status: 'litigation', at: 1 }), depth: 3 }))
    expect(claim.submit.text).toBe('i was here\nfiled under: LITIGATION · level 3')
    expect(wishRoute(ctx('let me out')).submit.text).toBe('let me out')
  })
  it("meta is rules.wishMeta()'s object", () => {
    expect(wishRoute(ctx('let me out', { origin: 'processed', rules: rulesFor('processed', false) })).submit.meta).toEqual({ origin: 'processed' })
    expect(wishRoute(ctx('i was here', { origin: 'tenant', rules: rulesFor('tenant', true) })).submit.meta).toEqual({ origin: 'tenant' })
  })
  it('the reply: closingReply > the origin’s presence reply > legacy', () => {
    const ext = file({ status: 'extension', at: 1, closing: 'extension' })
    expect(wishRoute(ctx('let me out', { file: ext, origin: 'tenant', rules: rulesFor('tenant', false) })).reply).toBe('the file notes the extension. received.')
    expect(wishRoute(ctx('let me out', { origin: 'tenant', rules: rulesFor('tenant', false) })).reply).toBe('logged as a complaint from a resident. complaints are not requests, but they are kept.')
    expect(wishRoute(ctx('let me out', { origin: 'anchored', rules: rulesFor('anchored', false) })).reply).toBe('your request is noted against an address. the address is real. that is the problem.')
    expect(wishRoute(ctx('let me out', { origin: 'processed', rules: rulesFor('processed', false) })).reply).toBe('amendment received. the file will be corrected, or it will not.')
    expect(wishRoute(ctx('let me out', { origin: 'unnamed', rules: rulesFor('unnamed', false) })).reply).toBe(LEGACY_WISH_REPLY)
    expect(LEGACY_WISH_REPLY).toBe('your request has been received. whether it is heard is another matter.')
    expect(LEGACY_CLAIM_REPLY).toBe('you did not ask. you asserted. the file has no column to deny a claim made. received.')
  })
})

describe('isClaim', () => {
  it('letters only, lowercased', () => {
    expect(isClaim('I was here')).toBe(true)
    expect(isClaim('i.was.here')).toBe(true)
    expect(isClaim('iwashere')).toBe(true)
    expect(isClaim('i was not here')).toBe(false)
    expect(isClaim(null)).toBe(false)
  })
  it('a claim is asked of the status parser first (status comes before the claim) and files nothing', () => {
    wishRoute(ctx('i was here'))
    expect(parseStatusWish).toHaveBeenCalledTimes(1)
    expect(fileStatus).not.toHaveBeenCalled()
  })
})
