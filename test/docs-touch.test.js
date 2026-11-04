// The docs follow I5: a phone has TYPE (Enter) and BEACON (B) now, each shown only while its key would do something, so the manual and
// the README stop saying touch has no way into the chat, the console or the beacon. The labels and keys are imported from touch.js, so
// the next change to a button turns this red until the docs follow.
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { ACTIONS, SITUATIONAL } from '../src/renderer/touch.js'

const root = path.resolve(import.meta.dirname, '..')
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8').replace(/\r\n/g, '\n')
const readme = read('README.md'), manual = read('docs/manual.html')
const section = (doc, from, to) => { const a = doc.indexOf(from), b = doc.indexOf(to, a + 1); expect(a, from).toBeGreaterThan(-1); expect(b, to).toBeGreaterThan(a); return doc.slice(a, b) }
const KEY = { KeyF: 'F', KeyQ: 'Q', Space: 'Space', KeyE: 'E', KeyL: 'L', KeyC: 'C', Enter: 'Enter', KeyB: 'B' }

describe('the manual: on a phone or tablet', () => {
  const touch = section(manual, '<h3 id="touch">On a phone or tablet</h3>', '<h3 id="platforms">')
  it('names all eight buttons with their keys, the two new ones with their hints', () => {
    for (const a of [...ACTIONS, ...SITUATIONAL]) expect(touch, a.label).toContain(`<b>${a.label}</b> (${KEY[a.code]}`)
    for (const s of SITUATIONAL) expect(touch, s.hint).toContain(`<i>${s.hint}</i>`)
  })
  it('says when the two show: TYPE whenever the line can open (a room\'s chat, the console alone) with the phone\'s keyboard; BEACON once one is set', () => {
    expect(touch).toContain('<b>TYPE</b> (Enter — <i>chat · console</i>) is there whenever the line can open: the chat in a room, the <a href="#console">console</a> alone.')
    expect(touch).toContain('your phone\'s keyboard')
    expect(touch).toContain('<b>BEACON</b> (B — <i>send a signal</i>) appears once a beacon is set in settings')
    expect(touch).toContain('clear of your gauges, your slots and the gear')
  })
  it('no longer says touch has no way into the chat, the console or the beacon; only the track change still needs a keyboard', () => {
    expect(touch).not.toContain('Touch has no way into the chat or the console, no beacon')
    expect(touch).toContain('Touch has no track change; the music switch lives in settings.')
  })
  it('the platforms table: the phone column names TYPE for the chat and console, BEACON for the beacon', () => {
    const table = section(manual, '<h3 id="platforms">', '</table>')
    expect(table).toContain('<tr><td class="k">chat &amp; console</td><td data-label="desktop app">Enter</td><td data-label="browser / installed web app">Enter</td><td data-label="phone / tablet">the TYPE button</td></tr>')
    expect(table).toContain('<td data-label="phone / tablet">the BEACON button, once one is set; goes quiet</td>')
    expect(table).not.toContain('keyboard only')
    expect(table).not.toContain('no button')
  })
})

describe('the README: on a phone or tablet', () => {
  const touch = section(readme, '**on a phone or tablet**', 'your **hit points** sit under')
  it('names all eight buttons with their keys', () => {
    const key = { KeyF: 'f', KeyQ: 'q', Space: 'space', KeyE: 'e', KeyL: 'l', KeyC: 'c', Enter: 'enter', KeyB: 'b' }
    for (const a of [...ACTIONS, ...SITUATIONAL]) expect(touch, a.label).toContain(`**${a.label}** (${key[a.code]}`)
  })
  it('says when TYPE and BEACON come, and that only the music still needs a keyboard', () => {
    expect(touch).toContain('two more come only when they would do something: **TYPE** (enter) whenever the line can open — the chat in a room, the field console alone — and it brings up your phone\'s keyboard; **BEACON** (b) once a beacon is set in settings.')
    expect(touch).toContain('only the music (**m**, **n**) still needs a keyboard')
    expect(touch).not.toContain('the beacon (**b**), the chat and the field console (**enter**)')
  })
})
