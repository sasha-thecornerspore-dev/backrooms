// The static's price (M21): with your radio on you are never hidden. Every rule block already says so (origin-rules.js fileBase hides
// only with the light and the radio off; origin-thin.js lets the radio half-carry a still thin player; LEGACY never hides), and the
// seam the frame reads, compose-perception.js perceptionFor, now holds it for any block: the radio on, `hidden` is false. Swept over
// every block, the seam's four numbers are the block's own, so holding it changes nothing today. The rest of the radio's reading is
// where it was and is not counted twice: the tesla looks half as far again for a carried, playing radio (variants.js), the static
// itself is a sound only — radiostatic.js reads no creature and imports nothing, and nothing it hands back reaches the things.
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import { perceptionFor, AI_CTX_KEYS } from '../src/renderer/compose-perception.js'
import { LEGACY, rulesFor } from '../src/renderer/origin-rules.js'
import { ORIGINS } from '../src/renderer/origin-intake.js'
import { VARIANT_SPEC, sightRange } from '../src/renderer/variants.js'
import { createRadioStatic } from '../src/renderer/radiostatic.js'

const BLOCKS = [['legacy', LEGACY], ...ORIGINS.flatMap((o) => [[o, rulesFor(o, false)], [o + '+thin', rulesFor(o, true)]])]
// every ctx the frame can hand the seam, near enough: the depths, the stillness and noise clocks round both rules' lines, the light, a friend's
function* sweep(radioOn) {
  for (const depth of [0, 1, 2, 3]) for (const stillFor of [0, 0.3, 0.6, 1, 1.99, 2, 2.5, 10, 600])
    for (const noiseFor of [0, 0.5, 0.6, 2, 3, 60, Infinity]) for (const flashlight of [false, true]) for (const litNear of [false, true])
      yield { depth, stillFor, noiseFor, flashlight, radioOn, litNear }
}
const four = (p) => ({ sightMul: p.sightMul, hidden: p.hidden === true, loseTrackMul: p.loseTrackMul, noiseMul: p.noiseMul })

describe('the radio on: never hidden', () => {
  it('through the seam, for every block and every ctx', () => {
    let n = 0
    for (const [name, rules] of BLOCKS) for (const c of sweep(true)) { expect(perceptionFor({ rules, ...c }).hidden, `${name} ${JSON.stringify(c)}`).toBe(false); n++ }
    expect(n).toBeGreaterThan(5000)
  })
  it('and every block already says so on its own: the seam\'s four numbers are the block\'s, radio on or off (nothing changes today)', () => {
    for (const [name, rules] of BLOCKS) for (const on of [false, true]) for (const c of sweep(on)) {
      const own = four(rules.perception({ ...c }))
      expect(four(perceptionFor({ rules, ...c })), `${name} ${JSON.stringify(c)}`).toEqual(own)
      if (on) expect(own.hidden, name).toBe(false)
    }
  })
  it('the radio off, a block may still hide you: the rule is the radio\'s, not a ban on hiding', () => {
    const still = { depth: 1, stillFor: 5, noiseFor: Infinity, flashlight: false, radioOn: false, litNear: false }
    for (const o of ORIGINS) {
      expect(perceptionFor({ rules: rulesFor(o, false), ...still }).hidden, o).toBe(true)
      expect(perceptionFor({ rules: rulesFor(o, true), ...still }).hidden, o + '+thin').toBe(true)
      expect(perceptionFor({ rules: rulesFor(o, false), ...still, radioOn: true }).hidden, o).toBe(false)
    }
    expect(perceptionFor({ rules: LEGACY, ...still }).hidden).toBe(false)   // never filed, never hidden
  })
  it('the seam holds it against a block that would hide you with the radio on; its other numbers pass as they were', () => {
    const hider = { perception: () => ({ sightMul: 0.7, hidden: true, loseTrackMul: 0.4, noiseMul: 0.9 }) }
    const c = { depth: 2, stillFor: 9, noiseFor: 9, flashlight: false, litNear: false }
    expect(perceptionFor({ rules: hider, ...c, radioOn: true })).toEqual({ sightMul: 0.7, hidden: false, loseTrackMul: 0.4, noiseMul: 0.9 })
    expect(perceptionFor({ rules: hider, ...c, radioOn: false })).toEqual({ sightMul: 0.7, hidden: true, loseTrackMul: 0.4, noiseMul: 0.9 })
  })
})

describe('nothing counted twice', () => {
  it('the tesla still looks half as far again for a carried, playing radio, and no other kind looks further for it', () => {
    for (const [v, spec] of Object.entries(VARIANT_SPEC)) {
      const off = sightRange(spec, { radioOn: false }), on = sightRange(spec, { radioOn: true })
      expect(on, v).toBe(v === 'tesla' ? spec.sight * 1.5 : spec.sight)
      expect(off, v).toBe(spec.sight)
    }
  })
  it('the static is a sound only: radiostatic.js imports nothing and its record carries a gain and a time constant, nothing the things read', () => {
    const src = fs.readFileSync(new URL('../src/renderer/radiostatic.js', import.meta.url), 'utf8')
    expect(src).not.toMatch(/^\s*import\b/m)
    const r = createRadioStatic().tick(0.5, false, true, true)
    expect(Object.keys(r).sort()).toEqual(['gain', 'tc'])
    for (const k of Object.keys(r)) expect(AI_CTX_KEYS).not.toContain(k)
  })
})
