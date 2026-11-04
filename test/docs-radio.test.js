// The docs follow the radio's static (M21): the manual's radio card and the README's radio row say, in plain words, that a carried
// radio that is on hisses when something is near through the halls, louder as it closes by the way you walk (a thing just behind a
// wall only as loud as the long way round), never which way, and (the manual) never with the creatures off; and both still say its
// price, that you cannot hide with it on. Each claim is held against the code it describes, so a change to either turns this red.
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { createRadioStatic } from '../src/renderer/radiostatic.js'
import { dreadFrom } from '../src/renderer/dread.js'
import { perceptionFor } from '../src/renderer/compose-perception.js'
import { rulesFor } from '../src/renderer/origin-rules.js'

const root = path.resolve(import.meta.dirname, '..')
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8').replace(/\r\n/g, '\n')
const readme = read('README.md'), manual = read('docs/manual.html'), audio = read('src/renderer/audio.js')
const card = (() => { const a = manual.indexOf('<div class="name">radio</div>'); return manual.slice(a, manual.indexOf('</div>', a + 30)) })()
const row = (/^\| radio \|[^\n]*$/m.exec(readme) || [''])[0]

describe('the manual\'s radio card', () => {
  it('says the hiss: near through the halls, the way you would walk, the long way round a wall, never which way, held while hunted, none with creatures off', () => {
    expect(card).toContain('Carried and on, it warns you too, after a fashion.')
    expect(card).toContain('it hisses when something is near you through the halls')
    expect(card).toContain('louder as the thing closes by the way you would have to walk')
    expect(card).toContain('one just behind a wall is only as loud as the long way round to it')
    expect(card).toContain('The hiss never says which way.')
    expect(card).toContain('Once something is coming for you, the hiss does not die down, but it no longer rises for that thing: it hears only what is not after you yet. One that is already after you when it comes, as one that followed you down is, brings no hiss at all.')
    expect(card).toContain('With the creatures switched off, it never hisses.')
  })
  it('still says its price, and still tells the numbers station as it was', () => {
    expect(card).toContain('it means you cannot hide by standing still')
    expect(card).toContain('<b>the numbers station</b>')
  })
})

describe('the README\'s radio row', () => {
  it('says the hiss and its price in the row', () => {
    expect(row).toContain('carried and on, it hisses when something is near you through the halls')
    expect(row).toContain('a thing just behind a wall is only as loud as the long way round')
    expect(row).toContain('never says which way')
    expect(row).toContain('once a thing is after you the hiss no longer rises for it, and one that followed you down brings none')
    expect(row).toContain('you cannot hide with it on')
  })
})

describe('what the docs say is what the code does', () => {
  it('no direction: the hiss\'s recipe has no panner', () => {
    const a = audio.indexOf('export function setRadioStatic('), b = audio.indexOf('\n}\n', a)
    expect(a).toBeGreaterThan(0)
    expect(audio.slice(a, b)).not.toMatch(/panTo|createStereoPanner|createPanner/)
  })
  it('creatures off: no hiss; held while hunted; on and live, a hiss', () => {
    const rs = createRadioStatic()
    expect(rs.tick(0.5, false, true, false).gain).toBe(0)
    const g = rs.tick(0.5, false, true, true).gain
    expect(g).toBeGreaterThan(0)
    expect(rs.tick(0, true, true, true).gain).toBe(g)
  })
  it('the thing hunting you is not in it: dread counts nothing hunting, so a hunter closing raises nothing, and one already hunting when it comes brings none', () => {
    const player = { x: 10.5, y: 10.5 }
    const out = { dread: 0, x: 0, y: 0, variant: null, d: -1, los: false }
    const field = { dist: (ix, iy) => Math.abs(ix - 10) + Math.abs(iy - 10) }          // open floor: the path is the walk
    dreadFrom([{ x: 15.5, y: 10.5, variant: 'hound', ai: 'roam', pending: 0, stagger: 0 }], field, player, out)
    expect(out.dread).toBeGreaterThan(0)                                       // the same thing, roaming, is heard
    for (const ai of ['hunt', 'windup', 'lunge', 'recover', 'arcCharge', 'freeze']) {
      for (const d of [9, 5, 2]) {
        dreadFrom([{ x: 10.5 + d, y: 10.5, variant: 'hound', ai, pending: 0, stagger: 0 }], field, player, out)
        expect(out.dread, `${ai} ${d}`).toBe(0)
      }
    }
    const rs = createRadioStatic()                                         // a follower: the fade let the hiss go, it arrives hunting
    for (let k = 0; k < 10; k++) expect(rs.tick(0, true, true, true).gain).toBe(0)
  })
  it('the radio on, a filed player standing still in the dark is not hidden', () => {
    const c = { depth: 1, stillFor: 9, noiseFor: Infinity, flashlight: false, litNear: false }
    expect(perceptionFor({ rules: rulesFor('tenant', false), ...c, radioOn: false }).hidden).toBe(true)
    expect(perceptionFor({ rules: rulesFor('tenant', false), ...c, radioOn: true }).hidden).toBe(false)
  })
})
