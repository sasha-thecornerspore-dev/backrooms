// compose-gates.js — the finale's gate, the beacon's decision, the death's decision.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import * as gates from '../src/renderer/compose-gates.js'
import { finaleGate, beaconDecision, deathDecision, NO_BEACON_LINE, CLAIM_LINE, LEGACY_PUSH_LINE, NOBODY_CAME } from '../src/renderer/compose-gates.js'
import { LEGACY, rulesFor } from '../src/renderer/origin-rules.js'
import { NO_STANDING } from '../src/renderer/closings.js'
import { BEACON_LINE as ANCHORED_PUSH } from '../src/renderer/origin-anchored.js'
import { BEACON_LINE as PROCESSED_PUSH } from '../src/renderer/origin-processed.js'
import { STATUSES } from '../src/renderer/status.js'

const ORIGINS = ['tenant', 'anchored', 'processed', 'unnamed']
const ALL = [LEGACY, ...ORIGINS.flatMap((o) => [rulesFor(o, false), rulesFor(o, true)])]
const W = 'https://ntfy.sh/EXTENSION-30150A'
const ANCHOR = { lat: 51.5007, lng: -0.1246 }

describe('finaleGate', () => {
  const flags = { seamHeld: false, claimFiled: true, beaconFired: true }
  it('the unnamed hold no seam; every other block does (W2 owns the rule as rules.canHoldSeam)', () => {
    expect(finaleGate({ ...flags, rules: rulesFor('unnamed', false), status: 'litigation', closing: null })).toBe(false)
    expect(finaleGate({ ...flags, rules: rulesFor('unnamed', true), status: 'litigation', closing: null })).toBe(false)
    for (const r of [LEGACY, rulesFor('tenant', false), rulesFor('anchored', true), rulesFor('processed', false)]) {
      expect(finaleGate({ ...flags, rules: r, status: 'litigation', closing: null })).toBe(true)
    }
  })
  it('a closed file holds no seam; extension and compliance hold none; litigation and notice-mailed do', () => {
    for (const closing of ['extension', 'compliance', 'litigation']) expect(finaleGate({ ...flags, rules: LEGACY, status: 'litigation', closing })).toBe(false)
    expect(finaleGate({ ...flags, rules: LEGACY, status: 'extension', closing: null })).toBe(false)
    expect(finaleGate({ ...flags, rules: LEGACY, status: 'compliance', closing: null })).toBe(false)
    expect(finaleGate({ ...flags, rules: LEGACY, status: 'litigation', closing: null })).toBe(true)
    expect(finaleGate({ ...flags, rules: LEGACY, status: 'notice-mailed', closing: null })).toBe(true)
    expect(finaleGate({ ...flags, seamHeld: true, rules: LEGACY, status: 'litigation', closing: null })).toBe(false)
  })
  it('exports no canHoldSeam of its own', () => {
    expect('canHoldSeam' in gates).toBe(false)
    const src = readFileSync(new URL('../src/renderer/compose-gates.js', import.meta.url), 'utf8')
    expect(src).not.toMatch(/export[^\n]*canHoldSeam/)
  })
})

describe('beaconDecision', () => {
  const base = (over) => ({ effect: 'pulse', target: 'httpsntfyshsomewhere', rules: LEGACY, status: 'notice-mailed', closing: null, anchor: null, webhook: W, ...over })
  it('fires the webhook whenever an effect is set; payload null and the no-beacon line when off', () => {
    for (const rules of ALL) for (const status of STATUSES) for (const target of ['extension30150a', 'elsewhere']) {
      const b = beaconDecision(base({ rules, status, target }))
      expect(b.fire).toBe(true)
      expect(b.payload.effect).toBe('pulse')
      expect(b.payload.webhook).toBe(W)
    }
    for (const effect of ['off', '', null, undefined]) {
      const b = beaconDecision(base({ effect, rules: rulesFor('processed', false) }))
      expect(b).toEqual({ fire: false, counterClaim: false, setBeaconFired: false, filesFloor: false, lines: [NO_BEACON_LINE], payload: null })
    }
    expect(NO_BEACON_LINE).toBe('no beacon set. register one in settings.')
  })
  it('the counter-claim sets beaconFired only when the file can hold a finale; otherwise NO_STANDING follows (and it still fires)', () => {
    for (const status of STATUSES) for (const closing of [null, 'extension', 'compliance', 'litigation']) {
      const b = beaconDecision(base({ target: 'xextension30150ax', status, closing }))
      const can = closing == null && (status === 'litigation' || status === 'notice-mailed')
      expect(b.counterClaim).toBe(true)
      expect(b.setBeaconFired).toBe(can)
      expect(b.lines).toEqual(can ? [CLAIM_LINE] : [CLAIM_LINE, NO_STANDING])
      expect(b.fire).toBe(true)
    }
    const plain = beaconDecision(base({ status: 'extension' }))
    expect(plain.lines).toEqual([LEGACY_PUSH_LINE])
    expect(plain.setBeaconFired).toBe(false)
  })
  it('the pin rides the payload only for the anchored, and only when there is one', () => {
    const a = beaconDecision(base({ rules: rulesFor('anchored', false), anchor: ANCHOR }))
    expect(a.payload).toEqual({ effect: 'pulse', webhook: W, anchor: ANCHOR })
    expect('anchor' in beaconDecision(base({ rules: rulesFor('anchored', false), anchor: null })).payload).toBe(false)
    expect('anchor' in beaconDecision(base({ rules: rulesFor('tenant', false), anchor: ANCHOR })).payload).toBe(false)
    expect('anchor' in beaconDecision(base({ rules: LEGACY, anchor: ANCHOR })).payload).toBe(false)
  })
  it("the push line is the column's; the counter-claim line is everyone's", () => {
    expect(beaconDecision(base({ rules: rulesFor('anchored', false) })).lines).toEqual([ANCHORED_PUSH])
    expect(beaconDecision(base({ rules: rulesFor('processed', true) })).lines).toEqual([PROCESSED_PUSH])
    expect(beaconDecision(base({ rules: rulesFor('tenant', false) })).lines).toEqual([LEGACY_PUSH_LINE])
    for (const rules of ALL) expect(beaconDecision(base({ rules, target: 'extension30150a' })).lines[0]).toBe(CLAIM_LINE)
    expect(CLAIM_LINE).toBe('you fire the beacon — not a cry for help. a claim. i was here. put it in the file.')
    expect(LEGACY_PUSH_LINE).toBe('you push the beacon into the dark...')
  })
  it('only the processed file the floor (claim or not)', () => {
    for (const rules of ALL) for (const target of ['extension30150a', 'elsewhere']) {
      expect(beaconDecision(base({ rules, target })).filesFloor).toBe(rules.id === 'processed' || rules.id === 'processed+thin')
    }
  })
})

describe('deathDecision', () => {
  const d = (over) => deathDecision({ mp: false, peers: 0, downSt: 'ok', rules: LEGACY, filed: false, thin: false, D: 0, timeout: false, ...over })
  it("down -> 'wait' every frame until the timeout", () => {
    for (let i = 0; i < 5; i++) expect(d({ downSt: 'down', mp: true, peers: 2 })).toBe('wait')
    expect(d({ downSt: 'down', mp: false })).toBe('wait')
  })
  it("someone fresh on the floor -> 'down'; nobody -> die", () => {
    expect(d({ mp: true, peers: 1 })).toBe('down')
    expect(d({ mp: true, peers: 0 }).die).toBe(true)
    expect(d({ mp: false, peers: 3 }).die).toBe(true)
    expect(d({ mp: true, peers: 1, timeout: true }).die).toBe(true)
  })
  it("'ok' is compared as a string: a truthy downSt is not down", () => {
    expect(d({ downSt: 'ok', mp: true, peers: 1 })).toBe('down')
    expect(d({ downSt: 'ok' }).die).toBe(true)
    expect(d({ downSt: true }).die).toBe(true)
  })
  it("the timeout: -20 sanity, 12 s before the body mends, 'nobody came.' first", () => {
    const r = d({ downSt: 'down', mp: true, peers: 0, timeout: true })
    expect(r).toEqual({ die: true, mintThin: false, leashDebt: 0, sanity: -20, regenDelay: 12, line: NOBODY_CAME })
    expect(NOBODY_CAME).toBe('nobody came.')
    const filed = d({ downSt: 'down', timeout: true, rules: rulesFor('tenant', false), filed: true })
    expect(filed.line).toBe('nobody came. not all of you came back up.')
    expect(filed.line.startsWith('nobody came.')).toBe(true)
  })
  it('a filed death mints thin (again, if thin) with its line; unfiled mints nothing and says nothing', () => {
    for (const o of ORIGINS) {
      const a = d({ rules: rulesFor(o, false), filed: true, thin: false, D: 0 })
      expect(a.mintThin).toBe(true)
      expect(a.line.endsWith('not all of you came back up.')).toBe(true)
      const b = d({ rules: rulesFor(o, true), filed: true, thin: true, D: 0 })
      expect(b.mintThin).toBe(true)
      expect(b.line.endsWith('still thin.')).toBe(true)
      expect(d({ rules: rulesFor(o, false), filed: false }).mintThin).toBe(false)
    }
    expect(d({})).toEqual({ die: true, mintThin: false, leashDebt: 0, sanity: 0, regenDelay: 0, line: null })
  })
  it('the anchored carry the drift as debt, the pull line before the thin piece', () => {
    const r = d({ rules: rulesFor('anchored', false), filed: true, D: 640 })
    expect(r.leashDebt).toBe(640)
    expect(r.line).toBe('the body is pulling you back. it is not there yet. not all of you came back up.')
    expect(d({ rules: rulesFor('tenant', false), filed: true, D: 640 }).leashDebt).toBe(0)
  })
  it('no result says you wake where you fell in', () => {
    for (const rules of ALL) for (const filed of [true, false]) for (const thin of [true, false]) for (const timeout of [true, false]) {
      const r = d({ rules, filed, thin, timeout, D: 300 })
      expect(String(r.line)).not.toContain('you wake where you fell in.')
    }
  })
})
