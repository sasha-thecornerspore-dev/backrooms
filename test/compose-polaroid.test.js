// compose-polaroid.js — what the film develops: a friend in frame, the column's own film, a lost soul, the thin figure, the
// honest film / the finalizing hall, the letter. First match wins.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { polaroidCaption, developsClaim, glyph, LINES } from '../src/renderer/compose-polaroid.js'
import { LEGACY, rulesFor } from '../src/renderer/origin-rules.js'
import { FIRST_SHOT_LINE } from '../src/renderer/origin-thin.js'
import { GLYPH_LINE } from '../src/renderer/origin-unnamed.js'
import { pinCaption } from '../src/renderer/origin-anchored.js'
import { statusMods, STATUSES, depthOf } from '../src/renderer/status.js'
import { anchorSeed } from '../src/renderer/anchor.js'

const ANCHOR = { lat: 51.5007, lng: -0.1246 }
const PIN = anchorSeed(ANCHOR.lat, ANCHOR.lng)
const THIN_NEAR = 'the film shows someone who was not in the room. you can see the wall through them.'
const FINALIZING = 'the film shows the hall as it will finalize: darker, one door fewer.'
const HONEST = 'the film shows the hall as it is. nothing that was not in the room.'
const letter = (g) => `the film develops one letter that was not in the room: "${g}". transcribe it.`

function mkCtx(over = {}) {
  return {
    rules: LEGACY, mods: statusMods('notice-mailed'), subject: null, soul: null, doorArrow: null, thinNear: false, status: 'notice-mailed',
    index: 0, depth: 0, sanity: 100, origin: null, thin: false, thinFirstShot: false, anchor: null, D: 0, firstShotOfLevel: false,
    photoIdx: 0, player: { x: 3.5, y: 4.5 }, lvl: 0, ...over,
  }
}
// ONE reused subject record, as W7's subjectInFrame hands it
const subject = { id: 'p7', name: 'maddie', x: 5, y: 5, dist: 2, facingMe: true, st: 'ok', thin: false, seen: false, origin: null, status: 'notice-mailed', aseed: null }
function setSubject(over) { Object.assign(subject, { id: 'p7', name: 'maddie', st: 'ok', thin: false, origin: null, status: 'notice-mailed', aseed: null }, over); return subject }

describe('glyph / developsClaim', () => {
  it("glyph spells 'iwashere'", () => {
    let s = ''
    for (let i = 0; i < 16; i++) s += glyph(i)
    expect(s).toBe('iwashereiwashere')
  })
  it('the table: compliance false; unnamed false for every status; litigation true even finalizing; the rest the legacy gate', () => {
    for (let index = 0; index <= 4; index++) for (const sanity of [0, 39, 40, 100]) {
      const depth = depthOf(index), legacyGate = !(sanity < 40 || index >= 3)
      for (const st of STATUSES) {
        const mods = statusMods(st)
        expect(developsClaim(rulesFor('unnamed', false), mods, index, depth, sanity)).toBe(false)
        const want = st === 'compliance' ? false : st === 'litigation' ? true : legacyGate
        for (const rules of [LEGACY, rulesFor('tenant', false), rulesFor('anchored', true), rulesFor('processed', false)]) {
          expect(developsClaim(rules, mods, index, depth, sanity), `${st} i${index} s${sanity}`).toBe(want)
        }
      }
    }
  })
})

describe('(1) a friend in frame', () => {
  it('captions by thin / same pin / origin, each after "the film develops {name}. "', () => {
    const cases = [
      [{ thin: true, origin: 'processed', aseed: PIN }, 'you can see the wall through them.'],
      [{ aseed: PIN, origin: 'processed' }, 'the film shows your pin.'],
      [{ origin: 'processed' }, 'there is a stamp on them.'],
      [{ origin: 'anchored', aseed: PIN + 1 }, 'the film shows a pin, and a distance.'],
      [{ origin: 'tenant' }, 'there is an address under them. the street is not there.'],
      [{ origin: 'unnamed' }, 'the caption did not develop.'],
      [{ origin: null }, 'the file has not finished with them.'],
    ]
    for (const [over, tail] of cases) {
      const r = polaroidCaption(mkCtx({ subject: setSubject(over), anchor: ANCHOR, index: 3, depth: 3, sanity: 10 }))   // finalizing: no letter
      expect(r.cap).toBe('the film develops maddie. ' + tail)
      expect(r.glyphAdvance).toBe(false)
      expect(r.emitPhoto).toEqual({ of: 'p7', x: 3.5, y: 4.5, lvl: 0 })
      expect(r.sanity).toBe(8)
    }
    // without an anchor of your own a pin never matches
    expect(polaroidCaption(mkCtx({ subject: setSubject({ aseed: PIN, origin: 'tenant' }), sanity: 10 })).cap).toBe('the film develops maddie. there is an address under them. the street is not there.')
  })
  it('a letter develops beside them only when the claim develops', () => {
    const r = polaroidCaption(mkCtx({ subject: setSubject({ origin: 'tenant' }), photoIdx: 2 }))
    expect(r.cap).toBe('the film develops maddie. there is an address under them. the street is not there. one letter developed beside them: "a".')
    expect(r.glyphAdvance).toBe(true)
    const un = polaroidCaption(mkCtx({ rules: rulesFor('unnamed', false), subject: setSubject({ origin: 'tenant' }), photoIdx: 2 }))
    expect(un.glyphAdvance).toBe(false)
    expect(un.cap).not.toMatch(/one letter/)
  })
  it("a downed friend: 'where they fell. they are counted.', never a letter", () => {
    const r = polaroidCaption(mkCtx({ subject: setSubject({ st: 'down', origin: 'tenant' }), status: 'litigation', mods: statusMods('litigation') }))
    expect(r.cap).toBe('the film develops maddie, where they fell. they are counted.')
    expect(r.glyphAdvance).toBe(false)
    expect(r.emitPhoto).toEqual({ of: 'p7', x: 3.5, y: 4.5, lvl: 0 })
  })
  it('the record is read inside the call: mutating it afterwards changes nothing returned', () => {
    const r = polaroidCaption(mkCtx({ subject: setSubject({ origin: 'tenant' }), lvl: 2 }))
    setSubject({ id: 'zz', name: 'other', origin: 'unnamed' })
    expect(r.cap).toMatch(/^the film develops maddie\. /)
    expect(r.emitPhoto).toEqual({ of: 'p7', x: 3.5, y: 4.5, lvl: 2 })
  })
  it('the subject wins over everything below it', () => {
    const r = polaroidCaption(mkCtx({ rules: rulesFor('anchored', true), thin: true, thinFirstShot: true, anchor: ANCHOR, D: 900, subject: setSubject({ origin: 'tenant' }), soul: { x: 1, y: 1 }, thinNear: true }))
    expect(r.cap).toMatch(/^the film develops maddie\. /)
  })
})

describe("(2) the column's own film (W2's rules.polaroid)", () => {
  it('thin first shot -> FIRST_SHOT_LINE, no advance, and it wins over the pin', () => {
    const r = polaroidCaption(mkCtx({ rules: rulesFor('anchored', true), thin: true, thinFirstShot: true, anchor: ANCHOR, D: 900 }))
    expect(r.cap).toBe(FIRST_SHOT_LINE)
    expect(r.glyphAdvance).toBe(false)
    expect(r.leashCalm).toBe(0)
  })
  it('anchored at D 201 or the first shot of a floor: the pin, with the letter when it would develop, and 60 s of calm', () => {
    const r = polaroidCaption(mkCtx({ rules: rulesFor('anchored', false), anchor: ANCHOR, D: 201, photoIdx: 1 }))
    expect(r.cap).toBe(pinCaption(ANCHOR, 201, 'w'))
    expect(r.glyphAdvance).toBe(true)
    expect(r.leashCalm).toBe(60)
    const first = polaroidCaption(mkCtx({ rules: rulesFor('anchored', false), anchor: ANCHOR, D: 10, firstShotOfLevel: true, sanity: 10 }))
    expect(first.cap).toBe(pinCaption(ANCHOR, 10, null))
    expect(first.glyphAdvance).toBe(false)
    expect(first.leashCalm).toBe(60)
    const near = polaroidCaption(mkCtx({ rules: rulesFor('anchored', false), anchor: ANCHOR, D: 200, photoIdx: 0 }))
    expect(near.cap).toBe(letter('i'))
    expect(near.leashCalm).toBe(0)
  })
  it("unnamed with a would-be letter -> W2's no-letter line; beside a thin figure the gWould is null, so the thin line", () => {
    const r = polaroidCaption(mkCtx({ rules: rulesFor('unnamed', false), origin: 'unnamed' }))
    expect(r.cap).toBe(GLYPH_LINE)
    expect(r.glyphAdvance).toBe(false)
    expect(r.sanity).toBe(8)
    expect(polaroidCaption(mkCtx({ rules: rulesFor('unnamed', false), origin: 'unnamed', thinNear: true })).cap).toBe(THIN_NEAR)
    // the status gives none (finalizing): unnamed's block returns null -> the finalizing hall
    expect(polaroidCaption(mkCtx({ rules: rulesFor('unnamed', false), origin: 'unnamed', sanity: 10 })).cap).toBe(FINALIZING)
  })
  it("the block is handed the ctx it reads, with gWould null when thinNear or when the status rule gives none", () => {
    const seen = []
    const rules = { ...LEGACY, polaroid: (c) => { seen.push({ ...c }); return null } }
    polaroidCaption(mkCtx({ rules, photoIdx: 3, anchor: ANCHOR, D: 42, firstShotOfLevel: true, thinFirstShot: true, index: 1, depth: 1, sanity: 77 }))
    expect(seen[0]).toEqual({ depth: 1, index: 1, sanity: 77, anchor: ANCHOR, D: 42, firstShotOfLevel: true, thinFirstShot: true, glyph: 's', finalizing: false, thinNear: false })
    polaroidCaption(mkCtx({ rules, thinNear: true }))
    expect(seen[1].glyph).toBe(null)
    polaroidCaption(mkCtx({ rules, sanity: 39 }))
    expect(seen[2].glyph).toBe(null)
    expect(seen[2].finalizing).toBe(true)
    polaroidCaption(mkCtx({ rules, mods: statusMods('compliance') }))
    expect(seen[3].glyph).toBe(null)
    polaroidCaption(mkCtx({ rules, mods: statusMods('litigation'), sanity: 0, index: 4 }))
    expect(seen[4].glyph).toBe('i')
    expect(seen[4].finalizing).toBe(true)
  })
})

describe('(3) a lost soul in frame', () => {
  it('with and without a known door', () => {
    const a = polaroidCaption(mkCtx({ soul: { x: 1, y: 1 }, doorArrow: '↗ 14 m' }))
    expect(a.cap).toBe('the film shows them, and behind them, faintly, a door: ↗ 14 m')
    expect(a.glyphAdvance).toBe(false)
    expect(a.emitPhoto).toBe(null)
    const b = polaroidCaption(mkCtx({ soul: { x: 1, y: 1 }, doorArrow: null, thinNear: true }))
    expect(b.cap).toBe('the film shows them, and nothing behind them.')
  })
})

describe('(4) the thin figure; (5) the honest film / the finalizing hall; (6) the letter', () => {
  it('litigation beside a thin figure: 8 + thinSanity (12) and " evidence."; the other statuses 8 and no suffix', () => {
    for (const st of STATUSES) {
      const r = polaroidCaption(mkCtx({ mods: statusMods(st), status: st, thinNear: true }))
      if (st === 'litigation') { expect(r.cap).toBe(THIN_NEAR + ' evidence.'); expect(r.sanity).toBe(12) }
      else { expect(r.cap).toBe(THIN_NEAR); expect(r.sanity).toBe(8) }
      expect(r.glyphAdvance).toBe(false)
    }
  })
  it('compliance: the honest film; finalizing: the hall; otherwise the letter', () => {
    const c = polaroidCaption(mkCtx({ mods: statusMods('compliance'), status: 'compliance' }))
    expect(c.cap).toBe(HONEST); expect(c.glyphAdvance).toBe(false); expect(c.sanity).toBe(8)
    const f = polaroidCaption(mkCtx({ sanity: 39 }))
    expect(f.cap).toBe(FINALIZING)
    const l = polaroidCaption(mkCtx({ photoIdx: 5 }))
    expect(l.cap).toBe(letter('e')); expect(l.glyphAdvance).toBe(true)
    const lit = polaroidCaption(mkCtx({ mods: statusMods('litigation'), status: 'litigation', index: 4, sanity: 0, photoIdx: 7 }))
    expect(lit.cap).toBe(letter('e'))
  })
  it('the priority table over subject x rules x soul x thinNear x status x finalizing', () => {
    const blocks = [LEGACY, ...['tenant', 'anchored', 'processed', 'unnamed'].flatMap((o) => [rulesFor(o, false), rulesFor(o, true)])]
    let n = 0
    for (const rules of blocks) for (const sub of [null, 'ok', 'down']) for (const soul of [null, { x: 1, y: 1 }]) for (const thinNear of [false, true])
      for (const st of STATUSES) for (const fin of [false, true]) for (const tfs of [false, true]) for (const D of [0, 500]) {
        const ctx = mkCtx({ rules, mods: statusMods(st), status: st, soul, thinNear, sanity: fin ? 10 : 90, index: 1, depth: 1, thin: rules.id?.endsWith('+thin') ?? false,
          thinFirstShot: tfs, anchor: ANCHOR, D, subject: sub ? setSubject({ st: sub, origin: 'tenant' }) : null, photoIdx: 0 })
        const r = polaroidCaption(ctx)
        const dev = rules.canDevelopClaim && statusMods(st).polaroidGlyph(1, 1, ctx.sanity)
        const gW = !thinNear && statusMods(st).polaroidGlyph(1, 1, ctx.sanity) ? 'i' : null
        const o = rules.polaroid({ depth: 1, index: 1, sanity: ctx.sanity, anchor: ANCHOR, D, firstShotOfLevel: false, thinFirstShot: tfs, glyph: gW, finalizing: fin, thinNear })
        let want
        if (sub) want = 1
        else if (o) want = 2
        else if (soul) want = 3
        else if (thinNear) want = 4
        else if (!dev) want = 5
        else want = 6
        const branch = r.emitPhoto ? 1 : r.cap.startsWith('the film shows them') ? 3 : r.cap.startsWith(THIN_NEAR) ? 4 : (r.cap === HONEST || r.cap === FINALIZING) ? 5 : r.cap.startsWith('the film develops one letter that was not in the room') ? 6 : 2
        expect(branch, `${rules.id} ${sub} ${!!soul} ${thinNear} ${st} ${fin} ${tfs} ${D}`).toBe(want)
        if (want === 1 && sub === 'down') expect(r.glyphAdvance).toBe(false)
        if (want === 6) expect(r.glyphAdvance).toBe(true)
        if (want === 3 || want === 4 || want === 5) expect(r.glyphAdvance).toBe(false)
        expect(r.leashCalm).toBe(want === 2 ? (o.leashCalm ?? 0) : 0)
        n++
      }
    expect(n).toBe(9 * 3 * 2 * 2 * 4 * 2 * 2 * 2)
  })
})

describe('LINES and the camera', () => {
  it('every caption string W4 spells, lowercase, no exclamation marks', () => {
    const keys = ['SUBJECT_DOWN', 'SUBJECT_THIN', 'SUBJECT_PIN', 'SUBJECT_PROCESSED', 'SUBJECT_ANCHORED', 'SUBJECT_TENANT', 'SUBJECT_UNNAMED', 'SUBJECT_UNKNOWN',
      'SUBJECT_GLYPH', 'SOUL_DOOR', 'SOUL_NONE', 'THIN_NEAR', 'EVIDENCE_SUFFIX', 'HONEST_FILM', 'FINALIZING', 'GLYPH']
    expect(Object.keys(LINES).sort()).toEqual([...keys].sort())
    expect(Object.isFrozen(LINES)).toBe(true)
    for (const k of keys) {
      expect(typeof LINES[k]).toBe('string')
      expect(LINES[k]).toBe(LINES[k].toLowerCase())
      expect(LINES[k]).not.toMatch(/!/)
    }
    expect(LINES.THIN_NEAR).toBe(THIN_NEAR)
    expect(LINES.FINALIZING).toBe(FINALIZING)
    expect(LINES.HONEST_FILM).toBe(HONEST)
  })
  it('items.js useSelected still splices the consumable before it returns its type (the camera is spent before firePolaroid)', () => {
    const src = readFileSync(new URL('../src/renderer/items.js', import.meta.url), 'utf8')
    const body = src.slice(src.indexOf('function useSelected()'), src.indexOf('function grant('))
    expect(body).toMatch(/inventory\.splice\(selected, 1\)[\s\S]*return \{ type: item\.type/)
    expect(body.indexOf('inventory.splice(selected, 1)')).toBeLessThan(body.lastIndexOf('return { type: item.type'))
  })
})
