// origin-intake.js — the form on the counter: who the file says you are, written by how you arrived.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { existsSync, readFileSync } from 'fs'
import {
  ORIGINS, isValidPin, intake, isBlankName, filingLine, formText, FORM_FOOT, AMEND_LINE,
  parseIntakeCommand, identityOut, identityIn, normaliseIntakeCtx,
} from '../src/renderer/origin-intake.js'
import { formatAnchor } from '../src/renderer/anchor.js'
import { writeSave, readSave } from '../src/renderer/save.js'

const PIN = { lat: 39.2994, lng: -76.641 }
const EVBUS = new URL('../src/net/evbus.js', import.meta.url)

describe('intake — the table', () => {
  const routes = ['solo', 'online', 'lan', 'host']
  const arrivals = ['walked', 'dropped', null]
  const anchors = [PIN, null, { lat: 91, lng: 0 }]
  const names = ['ada', '', '  ', 'wanderer', 'Wanderer']
  it('every combination files exactly one origin, in the order processed > anchored > unnamed > tenant', () => {
    let n = 0
    for (const route of routes) for (const arrival of arrivals) for (const anchor of anchors) for (const name of names) {
      const ctx = { route, arrival, anchor, name }
      const pin = anchor === PIN
      const blank = name.trim() === '' || name.trim().toLowerCase() === 'wanderer'
      const want = route !== 'solo' && (arrival ?? 'walked') === 'walked' ? 'processed'
        : pin ? 'anchored'
        : blank ? 'unnamed'
        : 'tenant'
      expect([route, arrival, anchor, name, intake(ctx)]).toEqual([route, arrival, anchor, name, want])
      expect(ORIGINS).toContain(intake(ctx))
      n++
    }
    expect(n).toBe(4 * 3 * 3 * 5)
  })

  it('arrival only ever decides the processed rule (thin is not intake\'s business)', () => {
    for (const arrival of ['walked', 'dropped', null]) {
      expect(intake({ route: 'solo', arrival, anchor: null, name: 'ada' })).toBe('tenant')
      expect(intake({ route: 'solo', arrival, anchor: PIN, name: '' })).toBe('anchored')
    }
    expect(intake({ route: 'online', arrival: 'dropped', anchor: null, name: 'ada' })).toBe('tenant')
    expect(intake({ route: 'online', arrival: null, anchor: PIN, name: 'ada' })).toBe('processed')
  })

  it('isValidPin and isBlankName', () => {
    expect(isValidPin(PIN)).toBe(true)
    expect(isValidPin({ lat: -90, lng: 180 })).toBe(true)
    for (const bad of [null, undefined, {}, { lat: 91, lng: 0 }, { lat: 0, lng: -181 }, { lat: 'x', lng: 1 }, { lat: NaN, lng: 0 }, { lat: Infinity, lng: 0 }, 'pin'])
      expect([bad, isValidPin(bad)]).toEqual([bad, false])
    for (const b of ['', '  ', 'wanderer', ' WANDERER ', null, undefined]) expect([b, isBlankName(b)]).toEqual([b, true])
    for (const s of ['ada', 'wanderer2', 'the wanderer']) expect([s, isBlankName(s)]).toEqual([s, false])
  })
})

describe('filingLine', () => {
  it('says the file has you, the drop, and the line it opened, in that order', () => {
    expect(filingLine('tenant', false)).toBe('the file has you now. it has you at an address.')
    expect(filingLine('tenant', true)).toBe('the file has you now. it has you at an address. you dropped in. not all of you arrived.')
    expect(filingLine('processed', false)).toBe('the file has you now. it opened a line on you.')
    expect(filingLine('processed', true)).toBe('the file has you now. you dropped in. not all of you arrived. it opened a line on you.')
    for (const o of ORIGINS) for (const t of [false, true]) {
      const s = filingLine(o, t)
      expect(s).toBe(s.toLowerCase())
      expect(s).not.toContain('!')
    }
  })
  it('names the column it wrote a solo player into: no two columns read the same line (F6)', () => {
    expect(filingLine('anchored', false)).toBe('the file has you now. it has your body at a pin.')
    expect(filingLine('unnamed', false)).toBe('the file has you now. it cannot spell you.')
    expect(filingLine('unnamed', true)).toBe('the file has you now. it cannot spell you. you dropped in. not all of you arrived.')
    expect(new Set(ORIGINS.map((o) => filingLine(o, false))).size).toBe(ORIGINS.length)
    expect(filingLine(null, false)).toBe('the file has you now.')
  })
})

describe('formText — the form on the stoop', () => {
  it('a blank name leaves the line for the dark to fill, and asks last', () => {
    const t = formText({ route: 'solo', arrival: null, anchor: null, name: '' }, undefined)
    expect(t[0]).toBe('intake.')
    expect(t).toContain('name: ______.')
    expect(t).toContain('address: woodyear st. (there is no woodyear st.)')
    expect(t).toContain('status: ______. the pen ran out.')
    expect(t[t.length - 1]).toBe('the file cannot spell you. write your name where the dark can read it.')
    expect(formText({ name: 'wanderer' })).toContain('name: ______.')
  })

  it('a name fills it, a pin replaces the address, a status fills the status', () => {
    const t = formText({ route: 'solo', arrival: null, anchor: PIN, name: 'ada' }, 'extension')
    expect(t).toEqual([
      'intake.',
      'name: ada.',
      'address: 39.2994,-76.6410. the body is there.',
      'status: extension.',
    ])
    // F7: the word as every voice says it; the pen runs out only on a blank
    expect(formText({ name: 'ada' }, 'notice-mailed')).toContain('status: notice mailed.')
    expect(formText({ name: 'ada' }, 'notice-mailed').join('\n')).not.toMatch(/notice-mailed|pen ran out/)
    expect(formText({ name: 'ada' }, '')).toContain('status: ______. the pen ran out.')
    expect(t[2]).toBe(`address: ${formatAnchor(PIN)}. the body is there.`)
    for (const ctx of [{ name: 'ada', anchor: PIN }, { name: '', anchor: null }, { name: 'Ada', anchor: { lat: 91, lng: 0 } }])
      for (const line of formText(ctx, 'notice-mailed')) { expect(line).toBe(line.toLowerCase()); expect(line).not.toContain('!') }
  })

  it('FORM_FOOT, and /intake shows the form or refuses an amendment', () => {
    expect(FORM_FOOT).toBe('the form on the counter.')
    expect(parseIntakeCommand('')).toEqual({ show: true })
    expect(parseIntakeCommand('  ')).toEqual({ show: true })
    expect(parseIntakeCommand(undefined)).toEqual({ show: true })
    expect(parseIntakeCommand('tenant')).toEqual({ refuse: 'the file does not take amendments. it takes forms.' })
    expect(AMEND_LINE).toBe('the file does not take amendments. it takes forms.')
  })
})

describe('identityOut / identityIn — the save', () => {
  const FALLBACK = Object.freeze({ route: 'solo', arrival: null, anchor: null, name: '' })

  it('a v:1 save without the fields resumes unfiled, with the fallback ctx and an empty Set', () => {
    const r = identityIn({ v: 1, level: 2, x: 1, y: 1, hp: 50 }, FALLBACK)
    expect(r).toEqual({ origin: null, thin: false, filed: false, intakeCtx: FALLBACK, filedFloors: new Set() })
    expect(r.intakeCtx).toBe(FALLBACK)
    expect(r.filedFloors).toBeInstanceOf(Set)
    expect(identityIn(null, FALLBACK)).toEqual({ origin: null, thin: false, filed: false, intakeCtx: FALLBACK, filedFloors: new Set() })
  })

  it('a full record round-trips through identityOut -> JSON -> identityIn', () => {
    const state = {
      origin: 'anchored', thin: true, filed: true,
      intakeCtx: { route: 'host', arrival: 'dropped', anchor: { ...PIN }, name: 'ada' },
      filedFloors: new Set(['0:2', '123:1']),
    }
    const out = identityOut(state)
    expect(out).toEqual({
      origin: 'anchored', thin: true, filed: true,
      intakeCtx: { route: 'host', arrival: 'dropped', anchor: PIN, name: 'ada' },
      filedFloors: ['0:2', '123:1'],
    })
    expect(out.intakeCtx).not.toBe(state.intakeCtx)   // a plain copy
    const back = identityIn(JSON.parse(JSON.stringify(out)), FALLBACK)
    expect(back.origin).toBe('anchored')
    expect(back.thin).toBe(true)
    expect(back.filed).toBe(true)
    expect(back.intakeCtx).toEqual(state.intakeCtx)
    expect(back.filedFloors).toEqual(new Set(['0:2', '123:1']))
  })

  it('garbage is dropped field by field', () => {
    const r = identityIn({
      origin: 'king', thin: 'yes', filed: true, filedFloors: [1, '0:2', null],
      intakeCtx: { route: 'bus', arrival: 'flew', anchor: { lat: 'x' }, name: 7 },
    }, FALLBACK)
    expect(r.origin).toBe(null)
    expect(r.thin).toBe(false)
    expect(r.filedFloors).toEqual(new Set(['0:2']))
    expect(r.intakeCtx).toEqual({ route: 'solo', arrival: null, anchor: null, name: '' })
    expect(identityIn({ intakeCtx: { name: 'a'.repeat(40) } }, FALLBACK).intakeCtx.name).toHaveLength(24)
    expect(identityIn({ intakeCtx: 'ctx' }, FALLBACK).intakeCtx).toBe(FALLBACK)
  })

  it('an unfiled record is always { origin: null, thin: false }, whatever the save says', () => {
    const r = identityIn({ origin: 'tenant', thin: true, filed: false }, FALLBACK)
    expect([r.origin, r.thin, r.filed]).toEqual([null, false, false])
    const s = identityIn({ origin: 'tenant', thin: true }, FALLBACK)
    expect([s.origin, s.thin, s.filed]).toEqual([null, false, false])
  })

  it('normaliseIntakeCtx copies a good ctx and falls back on a missing one', () => {
    const fb = { route: 'solo', arrival: null, anchor: PIN, name: '' }
    expect(normaliseIntakeCtx(null, fb)).toBe(fb)
    const ctx = { route: 'lan', arrival: 'walked', anchor: PIN, name: 'jo' }
    const n = normaliseIntakeCtx(ctx, fb)
    expect(n).toEqual(ctx)
    expect(n).not.toBe(ctx)
    expect(n.anchor).not.toBe(ctx.anchor)
  })

  describe('through save.js', () => {
    afterEach(() => vi.unstubAllGlobals())
    it('writeSave / readSave carry the identity (v: 1 kept)', () => {
      const store = new Map()
      vi.stubGlobal('localStorage', {
        getItem: (k) => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => store.set(k, String(v)),
        removeItem: (k) => store.delete(k),
      })
      const state = {
        origin: 'processed', thin: false, filed: true,
        intakeCtx: { route: 'online', arrival: 'walked', anchor: null, name: 'ada' },
        filedFloors: new Set(['0:1']),
      }
      writeSave({ level: 1, x: 2.5, y: 2.5, ...identityOut(state) })
      const s = readSave()
      expect(s.v).toBe(1)
      const back = identityIn(s, FALLBACK)
      expect(back).toEqual({ ...state, filedFloors: new Set(['0:1']) })
    })
  })
})

describe('ORIGINS', () => {
  it('names the four columns, frozen', () => {
    expect(ORIGINS).toEqual(['tenant', 'anchored', 'processed', 'unnamed'])
    expect(Object.isFrozen(ORIGINS)).toBe(true)
  })
  it.skipIf(!existsSync(EVBUS))('match the four evbus.js accepts on the here heartbeat (beside null)', () => {
    const src = readFileSync(EVBUS, 'utf8')
    const m = src.match(/const ORIGINS = new Set\(\[null, ([^\]]*)\]\)/)
    expect(m).not.toBeNull()
    const names = [...m[1].matchAll(/'([^']*)'/g)].map((x) => x[1])
    expect(names.sort()).toEqual([...ORIGINS].sort())
  })
})
