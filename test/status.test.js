import { describe, it, expect, vi, afterEach } from 'vitest'
import { existsSync } from 'node:fs'
import {
  STATUSES, DEFAULT_STATUS, CLOSINGS, STATUS_LABEL, DAY_MS, depthOf, loadFile, saveFile, canFile, canRefile,
  parseStatusWish, fileStatus, wishTrailer, parseTrailer, stripTrailers, wishPrompt, statusMods, npcLines, STRINGS,
} from '../src/renderer/status.js'
import { SCRAPS } from '../src/renderer/scraps.js'

const EVBUS = new URL('../src/net/evbus.js', import.meta.url)
const hasEvbus = existsSync(EVBUS)

// the post-core lines the legacy rows must reproduce, quoted from src/renderer/game.js (feat/richness 2cb9c76)
const SANITY_DEPTH_LINE = 'sdelta -= (level.index >= 0 && level.index <= 3 ? level.index : 0) * 0.5'   // game.js:1796
const FINALIZING_LINE = 'const finalizing = sanity < 40 || (level?.index ?? 0) >= 3'                       // game.js:987
const DEEP_LINE = 'const deep = dfloor === 2 || dfloor === 3'                                             // game.js:1008
// evaluate a quoted line exactly as game.js does
const quotedDepthTerm = new Function('level', `let sdelta = 0; ${SANITY_DEPTH_LINE}; return sdelta`)
const quotedFinalizing = new Function('level', 'sanity', `${FINALIZING_LINE}; return finalizing`)
const quotedDeep = new Function('dfloor', `${DEEP_LINE}; return deep`)

describe('depthOf — one helper over both domains', () => {
  it('maps level.index and cfg.levelIndex to a depth 0..3', () => {
    const cases = [['∅', 0], [4, 0], ['0', 0], [0, 0], ['3', 3], [3, 3], [2, 2], ['2', 2], [1, 1], ['1', 1],
      [null, 0], [undefined, 0], [NaN, 0], [5, 0], ['x', 0], ['', 0], [-1, 0], [Infinity, 0], [{}, 0]]
    for (const [v, d] of cases) expect(depthOf(v), String(v)).toBe(d)
  })
  it.skipIf(!hasEvbus)('equals evbus.depthOf on the index domain and shares its four words', async () => {
    const ev = await import('../src/net/evbus.js')
    for (let i = 0; i <= 4; i++) expect(depthOf(i), String(i)).toBe(ev.depthOf(i))
    expect([...STATUSES]).toEqual([...ev.STATUSES])
  })
})

describe('the words', () => {
  it('statuses, closings, labels', () => {
    expect([...STATUSES]).toEqual(['notice-mailed', 'extension', 'compliance', 'litigation'])
    expect(DEFAULT_STATUS).toBe('notice-mailed')
    expect([...CLOSINGS]).toEqual(['extension', 'compliance', 'litigation'])
    expect(STATUS_LABEL).toEqual({ 'notice-mailed': 'NOTICE MAILED', extension: 'EXTENSION', compliance: 'COMPLIANCE', litigation: 'LITIGATION' })
    expect(DAY_MS).toBe(86_400_000)
    expect(Object.isFrozen(STATUS_LABEL)).toBe(true)
  })
})

describe('legacy identity — the sanity depth term (game.js:1796, quoted)', () => {
  it('notice-mailed reproduces the quoted line on every index, ∅ draining 0', () => {
    const m = statusMods('notice-mailed')
    for (let i = 0; i <= 4; i++) {
      const want = quotedDepthTerm({ index: i })       // what the quoted line subtracts, as an additive term
      expect(want === -((i >= 0 && i <= 3 ? i : 0) * 0.5)).toBe(true)
      expect(m.sanityDepthTerm(i, depthOf(i)), String(i)).toBe(want)   // Object.is: not even a -0 where game.js has +0
    }
    expect(m.sanityDepthTerm(4, 0) === 0).toBe(true)
    expect(m.sanityDepthTerm(3, 3)).toBe(-1.5)
  })
  it('compliance and litigation equal notice-mailed on every (index, depth)', () => {
    const n = statusMods('notice-mailed')
    for (const s of ['compliance', 'litigation']) {
      for (let i = 0; i <= 4; i++) for (let d = 0; d <= 3; d++) expect(statusMods(s).sanityDepthTerm(i, d), `${s} ${i} ${d}`).toBe(n.sanityDepthTerm(i, d))
    }
  })
  it('extension inverts it: the deep holds you, the street frays you', () => {
    const t = statusMods('extension').sanityDepthTerm
    expect(t(4, 0)).toBe(-1.0)
    expect(t(0, 0)).toBe(-0.75)
    expect(t(1, 1)).toBe(-0.25)
    expect(t(2, 2)).toBe(0.25)
    expect(t(3, 3)).toBe(0.75)
  })
})

describe('legacy identity — the polaroid glyph (game.js:987, quoted)', () => {
  it('notice-mailed and extension develop the glyph exactly when the quoted line is not finalizing', () => {
    for (const s of ['notice-mailed', 'extension']) {
      const g = statusMods(s).polaroidGlyph
      for (let i = 0; i <= 4; i++) for (const san of [0, 39, 40, 100]) {
        expect(g(i, depthOf(i), san), `${s} ${i} ${san}`).toBe(!quotedFinalizing({ index: i }, san))
      }
      expect(g(3, 3, 100)).toBe(false)
      expect(g(0, 0, 30)).toBe(false)
      expect(g(1, 1, 50)).toBe(true)
      expect(g(4, 0, 100)).toBe(false)           // ∅ reads the index: finalizing today
    }
  })
  it('litigation develops it everywhere; compliance never', () => {
    for (let i = 0; i <= 4; i++) for (const san of [0, 20, 39, 40, 100]) {
      expect(statusMods('litigation').polaroidGlyph(i, depthOf(i), san)).toBe(true)
      expect(statusMods('compliance').polaroidGlyph(i, depthOf(i), san)).toBe(false)
    }
    expect(statusMods('litigation').polaroidGlyph(3, 3, 20)).toBe(true)
    expect(statusMods('compliance').polaroidGlyph(0, 0, 100)).toBe(false)
  })
})

describe('statusMods — inversions, never stats', () => {
  const KEYS = ['sanityDepthTerm', 'sourWater', 'polaroidGlyph', 'thinSanity', 'sealedCards', 'radioMode', 'npcLine']
  it('four frozen objects with the same seven keys in the same order', () => {
    for (const s of STATUSES) {
      const m = statusMods(s)
      expect(Object.isFrozen(m), s).toBe(true)
      expect(Object.keys(m), s).toEqual(KEYS)
      expect(typeof m.sanityDepthTerm).toBe('function')
      expect(typeof m.polaroidGlyph).toBe('function')
      expect(typeof m.radioMode).toBe('function')
      expect(['today', 'advance']).toContain(m.sourWater)
      expect([0, 4]).toContain(m.thinSanity)
      expect(typeof m.sealedCards).toBe('boolean')
      expect(m.npcLine === null || typeof m.npcLine === 'string').toBe(true)
      expect(statusMods(s)).toBe(m)                               // a singleton, built once
      for (const bad of ['wardCost', 'huntDrain', 'aggroMul', 'bandage', 'glowstick', 'chaseMul', 'noiseMul', 'damageMul']) expect(bad in m, bad).toBe(false)
    }
  })
  it('the rows', () => {
    expect(STATUSES.map(s => statusMods(s).thinSanity)).toEqual([0, 0, 0, 4])
    expect(STATUSES.map(s => statusMods(s).sealedCards)).toEqual([false, false, true, false])
    expect(STATUSES.map(s => statusMods(s).sourWater)).toEqual(['today', 'advance', 'today', 'today'])
    expect(statusMods('notice-mailed').npcLine).toBe(null)
    expect(statusMods('extension').npcLine).toBe('you can stop looking for the stairs now.')
    expect(statusMods('compliance').npcLine).toBe('the thirteen who complied — nobody remembers them. that was the point.')
    expect(statusMods('litigation').npcLine).toBe('write it where the dark can read it. then write it again.')
  })
  it('an unknown status reads as the default', () => {
    expect(statusMods('king')).toBe(statusMods('notice-mailed'))
    expect(statusMods(undefined)).toBe(statusMods('notice-mailed'))
  })
  it('npcLines: none for the unaffiliated, so NPC_LINES.concat(...) is NPC_LINES byte for byte', () => {
    expect(npcLines('notice-mailed')).toEqual([])
    const NPC = ['a', 'b']
    expect(NPC.concat(npcLines('notice-mailed'))).toEqual(NPC)
    for (const s of ['extension', 'compliance', 'litigation']) expect(npcLines(s)).toEqual([statusMods(s).npcLine])
  })
})

describe('radioMode (game.js:1008, quoted)', () => {
  it('every status hears the ledger at depth 2 and 3; below, the unaffiliated hear static and the filed hear the roll', () => {
    for (const s of STATUSES) for (let d = 0; d <= 3; d++) {
      const m = statusMods(s).radioMode(d)
      if (quotedDeep(d)) expect(m, `${s} ${d}`).toBe('ledger')
      else expect(m, `${s} ${d}`).toBe(s === 'notice-mailed' ? 'crackle' : 'roll')
    }
  })
})

describe('parseStatusWish', () => {
  it('reads the bare word or "file me under <word>"', () => {
    expect(parseStatusWish('extension')).toBe('extension')
    expect(parseStatusWish('  Compliance ')).toBe('compliance')
    expect(parseStatusWish('FILE ME UNDER litigation')).toBe('litigation')
    expect(parseStatusWish('file me under extension\n')).toBe('extension')
  })
  it('anything else is not a status wish', () => {
    for (const t of ['i want litigation', 'extend the fog', 'close the file', 'file me under notice-mailed', '', 'notice-mailed', null, undefined, 42]) {
      expect(parseStatusWish(t), String(t)).toBe(null)
    }
  })
})

describe('canFile / canRefile', () => {
  it('canFile needs the ledger, five pages, or depth', () => {
    expect(canFile({ ledgerHeard: false, pagesRead: 4, depth: 1 })).toBe(false)
    expect(canFile({ ledgerHeard: true, pagesRead: 0, depth: 0 })).toBe(true)
    expect(canFile({ ledgerHeard: false, pagesRead: 5, depth: 0 })).toBe(true)
    expect(canFile({ ledgerHeard: false, pagesRead: 0, depth: 2 })).toBe(true)
    expect(canFile({ ledgerHeard: false, pagesRead: 0, depth: 3 })).toBe(true)
    expect(canFile({ ledgerHeard: 'yes', pagesRead: 0, depth: 0 })).toBe(false)
  })
  it('canRefile waits a day', () => {
    const at = 1_700_000_000_000
    expect(canRefile(at, at + DAY_MS - 1)).toBe(false)
    expect(canRefile(at, at + DAY_MS)).toBe(true)
    expect(canRefile(null, 0)).toBe(true)
    expect(canRefile(null, at)).toBe(true)
    expect(canRefile(undefined, 0)).toBe(true)
  })
})

describe('fileStatus', () => {
  const now = 1_800_000_000_000
  const fresh = () => loadFile(undefined)
  it('an unanswered notice cannot file', () => {
    const f = fresh()
    const r = fileStatus(f, 'extension', now, false)
    expect(r.file).toBe(f)
    expect(r.reply).toBe(STRINGS.NOTICE_UNANSWERED)
    expect(r.line).toBe(null)
    expect(r.resets).toEqual([])
  })
  it('the first filing', () => {
    const f = { ...fresh(), ledgerHeard: true }
    const r = fileStatus(f, 'extension', now, true)
    expect(r.file).not.toBe(f)
    expect(r.file).toEqual({ status: 'extension', at: now, ledgerHeard: true, closing: null, redacted: [] })
    expect(r.reply).toBe(STRINGS.FILED)
    expect(r.line).toBe(null)
    expect(r.resets).toEqual(['photoIdx', 'stationIdx', 'claimFiled'])
    expect(f.status).toBe('notice-mailed')                                  // never a mutation in place
  })
  it('the office is closed until a day has passed; then a refile clears the closing and the pages', () => {
    const at = now - (23 * 3600 + 59 * 60) * 1000
    const f = { status: 'extension', at, ledgerHeard: true, closing: 'extension', redacted: [1, 2] }
    const shut = fileStatus(f, 'compliance', now, true)
    expect(shut.file).toBe(f)
    expect(shut.reply).toBe(STRINGS.OFFICE_CLOSED)
    expect(shut.line).toBe(null)
    expect(shut.resets).toEqual([])
    const g = { ...f, at: now - DAY_MS }
    const r = fileStatus(g, 'compliance', now, true)
    expect(r.file).toEqual({ status: 'compliance', at: now, ledgerHeard: true, closing: null, redacted: [] })
    expect(r.reply).toBe(STRINGS.FILED)
    expect(r.line).toBe(STRINGS.REFILED)
  })
  it('the same word replies and changes nothing', () => {
    const f = { status: 'litigation', at: now - 10, ledgerHeard: false, closing: null, redacted: [] }
    const r = fileStatus(f, 'litigation', now, true)
    expect(r.file).toBe(f)
    expect(r.reply).toBe(STRINGS.SAME_STATUS)
    expect(r.line).toBe(null)
    expect(r.resets).toEqual([])
  })
  it('a new notice needs no standing, only the day', () => {
    const f = { status: 'litigation', at: now - DAY_MS, ledgerHeard: false, closing: 'litigation', redacted: [4] }
    const r = fileStatus(f, 'notice-mailed', now, false)
    expect(r.file).toEqual({ status: 'notice-mailed', at: now, ledgerHeard: false, closing: null, redacted: [] })
    expect(r.reply).toBe(STRINGS.NEW_NOTICE)
    expect(r.line).toBe(STRINGS.REFILED)
  })
  it('beaconFired is never reset', () => {
    for (const s of ['extension', 'compliance', 'litigation', 'notice-mailed']) {
      const r = fileStatus({ status: s === 'notice-mailed' ? 'extension' : 'notice-mailed', at: null, ledgerHeard: true, closing: null, redacted: [] }, s, now, true)
      expect(r.resets).not.toContain('beaconFired')
    }
  })
})

describe('loadFile', () => {
  const DEF = { status: 'notice-mailed', at: null, ledgerHeard: false, closing: null, redacted: [] }
  it('anything that is not a file is the default file', () => {
    for (const raw of [undefined, null, 'x', [], 42, true]) expect(loadFile(raw), String(raw)).toEqual(DEF)
  })
  it('drops what it does not recognise', () => {
    expect(loadFile({ status: 'king', closing: 'maybe', at: 'yesterday', ledgerHeard: 1 })).toEqual(DEF)
    expect(loadFile({ status: 'compliance', closing: 'compliance', at: 5, ledgerHeard: true, redacted: [3, 3, -1, 26, 'a', 25, 2.5] }))
      .toEqual({ status: 'compliance', at: 5, ledgerHeard: true, closing: 'compliance', redacted: [3, 25] })
    expect(SCRAPS.length).toBe(26)
    expect(loadFile({ redacted: [SCRAPS.length - 1, SCRAPS.length] }).redacted).toEqual([SCRAPS.length - 1])
    expect(loadFile({ redacted: 'all' }).redacted).toEqual([])
  })
  it('a fresh object every time, and a round trip', () => {
    const f = { status: 'extension', at: 1234, ledgerHeard: true, closing: 'extension', redacted: [0, 7] }
    const g = loadFile(f)
    expect(g).not.toBe(f)
    expect(g.redacted).not.toBe(f.redacted)
    expect(g).toEqual(f)
    expect(loadFile(JSON.parse(JSON.stringify(g)))).toEqual(g)
    expect(loadFile(undefined)).not.toBe(loadFile(undefined))
  })
})

describe('saveFile — always a fresh copy (prefs.js setPref drops a same-reference write)', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.resetModules() })
  it('writes an object that is not the file, and a second save after a mutation still lands', async () => {
    vi.resetModules()
    const ls = { getItem: () => null, setItem: vi.fn() }
    vi.stubGlobal('localStorage', ls)
    const prefs = await import('../src/renderer/prefs.js')
    const st = await import('../src/renderer/status.js')
    const f = st.loadFile({ status: 'compliance', at: 1, redacted: [1] })
    st.saveFile(f)
    const w1 = prefs.getPref('file')
    expect(w1).not.toBe(f)
    expect(w1.redacted).not.toBe(f.redacted)
    expect(w1).toEqual(f)
    f.redacted.push(2)
    st.saveFile(f)
    expect(ls.setItem).toHaveBeenCalledTimes(2)
    expect(JSON.parse(ls.setItem.mock.calls.at(-1)[1]).file.redacted).toEqual([1, 2])
    expect(prefs.getPref('file').redacted).toEqual([1, 2])
    expect(st.loadFile(prefs.getPref('file'))).toEqual(f)
  })
  it('import-safe without a browser: saveFile then getPref round-trips in memory', async () => {
    vi.resetModules()
    const prefs = await import('../src/renderer/prefs.js')
    const st = await import('../src/renderer/status.js')
    st.saveFile(st.loadFile({ status: 'litigation', at: 9 }))
    expect(st.loadFile(prefs.getPref('file'))).toEqual({ status: 'litigation', at: 9, ledgerHeard: false, closing: null, redacted: [] })
  })
})

describe('the wish trailer', () => {
  it('names the status and the depth; nothing for the unaffiliated', () => {
    expect(wishTrailer('extension', 2)).toBe('\nfiled under: EXTENSION · level 2')
    expect(wishTrailer('compliance', 0)).toBe('\nfiled under: COMPLIANCE · level 0')
    expect(wishTrailer('litigation', 3)).toBe('\nfiled under: LITIGATION · level 3')
    for (let d = 0; d <= 3; d++) expect(wishTrailer('notice-mailed', d)).toBe('')
  })
  it('parseTrailer reads it back', () => {
    for (const s of ['extension', 'compliance', 'litigation']) for (let d = 0; d <= 3; d++) {
      expect(parseTrailer('let me out\nplease' + wishTrailer(s, d))).toEqual({ status: s, level: d })
    }
  })
  it('the last matching line wins; CRLF and padding are trimmed', () => {
    expect(parseTrailer('x\nfiled under: EXTENSION · level 1\nfiled under: LITIGATION · level 3')).toEqual({ status: 'litigation', level: 3 })
    expect(parseTrailer('x\r\nfiled under: COMPLIANCE · level 2\r\n')).toEqual({ status: 'compliance', level: 2 })
    expect(parseTrailer('x\n  filed under: EXTENSION · level 0  \n\nsigned')).toEqual({ status: 'extension', level: 0 })
  })
  it('stripTrailers drops every line the parser would read, and only those (R3SP-2)', () => {
    expect(stripTrailers('let me stay\nfiled under: LITIGATION · level 3')).toBe('let me stay')
    expect(stripTrailers('a\r\n  filed under: EXTENSION · level 0  \r\nb')).toBe('a\r\nb')
    expect(stripTrailers('filed under: COMPLIANCE · level 2')).toBe('')
    expect(stripTrailers('x\nfiled under: extension · level 2')).toBe('x\nfiled under: extension · level 2')
    expect(stripTrailers('just a wish')).toBe('just a wish')
    expect(parseTrailer(stripTrailers('a\nfiled under: LITIGATION · level 3\nfiled under: EXTENSION · level 1'))).toBe(null)
  })
  it('null when there is none', () => {
    expect(parseTrailer('just a wish')).toBe(null)
    expect(parseTrailer('x\nfiled under: extension · level 2')).toBe(null)
    expect(parseTrailer('x\nfiled under: EXTENSION · level 4')).toBe(null)
    expect(parseTrailer('x\nfiled under: NOTICE MAILED · level 1')).toBe(null)
    expect(parseTrailer('')).toBe(null)
    for (const bad of [null, undefined, 42, {}, ['filed under: EXTENSION · level 1']]) expect(parseTrailer(bad)).toBe(null)
  })
})

describe('wishPrompt', () => {
  const base = { origin: null, status: 'notice-mailed', closing: null, canFile: false, canRefile: true }
  it('legacy: today\'s placeholder and the unanswered notice', () => {
    expect(wishPrompt(base)).toEqual({ placeholder: 'speak.', sub: [STRINGS.NOTICE_UNANSWERED] })
    expect(STRINGS.PLACEHOLDER).toBe('speak.')
  })
  it('the stamp lines when you can file, the closed office when you cannot refile', () => {
    expect(wishPrompt({ ...base, canFile: true })).toEqual({ placeholder: 'speak.', sub: ['extension · let it stay open', 'compliance · close the file', 'litigation · contest it'] })
    expect(wishPrompt({ ...base, status: 'extension', canFile: true, canRefile: false }).sub).toEqual(['filed under extension. the office is closed until tomorrow.'])
  })
  it('the placeholder is the origin\'s', () => {
    expect(wishPrompt({ ...base, origin: 'processed' }).placeholder).toBe('amend.')
    expect(wishPrompt({ ...base, origin: 'unnamed' }).placeholder).toBe('the file cannot spell you.')
    for (const o of ['tenant', 'anchored', null]) expect(wishPrompt({ ...base, origin: o }).placeholder).toBe('speak.')
  })
  it('every line lowercase, no exclamation', () => {
    for (const o of [null, 'tenant', 'anchored', 'unnamed', 'processed']) for (const s of STATUSES) for (const cf of [true, false]) for (const cr of [true, false]) {
      const p = wishPrompt({ origin: o, status: s, closing: null, canFile: cf, canRefile: cr })
      for (const l of [p.placeholder, ...p.sub]) { expect(l).toBe(l.toLowerCase()); expect(l).not.toContain('!') }
    }
  })
})

describe('STRINGS', () => {
  const LABELS = /NOTICE MAILED|EXTENSION|COMPLIANCE|LITIGATION/g
  it('frozen, lowercase but for the record\'s own words, never an exclamation', () => {
    expect(Object.isFrozen(STRINGS)).toBe(true)
    const all = []
    for (const v of Object.values(STRINGS)) {
      if (Array.isArray(v)) { expect(Object.isFrozen(v)).toBe(true); all.push(...v) } else all.push(v)
    }
    for (const s of all) {
      expect(typeof s).toBe('string')
      expect(s).not.toContain('!')
      expect(s.replace(/\b30150A\b/g, '').replace(LABELS, ''), s).toBe(s.replace(/\b30150A\b/g, '').replace(LABELS, '').toLowerCase())
    }
  })
  it('the lines, as written', () => {
    expect(STRINGS.FILED).toBe('filed. the office will not confirm receipt.')
    expect(STRINGS.NOTICE_UNANSWERED).toBe('a notice was mailed to you. you have not answered.')
    expect(STRINGS.OFFICE_CLOSED).toBe('the office is closed. come back tomorrow.')
    expect(STRINGS.REFILED).toBe('the office opens a new file. the old one is still closed.')
    expect(STRINGS.NEW_NOTICE).toBe('a new notice is mailed to you. the old file is still closed.')
    expect(STRINGS.SAME_STATUS).toBe('the file already has you under that word.')
    expect(STRINGS.SOUR_ADVANCE).toBe('the water is sour. you have stopped tasting the difference. somewhere a line moves.')
    expect([...STRINGS.STAMP_LINES]).toEqual(['extension · let it stay open', 'compliance · close the file', 'litigation · contest it'])
  })
})
