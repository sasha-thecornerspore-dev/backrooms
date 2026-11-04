// The docs follow the film's den (M6): the manual and README say that a creature caught close in the frame develops and goes on your map,
// once a kind a visit, on your map only; they quote the game's own line and draw its own glyph. The line and the glyph are imported, so
// the next change to either turns this red until the docs follow.
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { denLine, KINDS } from '../src/renderer/film.js'
import { GLYPHS } from '../src/renderer/mapcard.js'

const root = path.resolve(import.meta.dirname, '..')
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8').replace(/\r\n/g, '\n')
const readme = read('README.md'), manual = read('docs/manual.html')

describe('the film\'s den in the docs', () => {
  it('the manual\'s polaroid quotes the den line as the game says it, for a kind the bestiary names', () => {
    expect(KINDS).toContain('hound')
    expect(manual).toContain(`<i>${denLine('hound')}</i>`)
    const polaroid = manual.slice(manual.indexOf('<div class="name">polaroid camera</div>'), manual.indexOf('<div class="name">radio</div>'))
    expect(polaroid).toContain(denLine('hound'))
    expect(polaroid).toContain(`as ${GLYPHS.den}`)
    expect(polaroid).toMatch(/once each time you come to a floor/)
    expect(polaroid).toMatch(/on your map only — in a room, a friend's map does not get it/)
    expect(polaroid).toMatch(/creatures setting off there is nothing to catch/)
    expect(polaroid).toMatch(/for one that followed you down, the spot where you caught it/)
  })
  it('the manual\'s map table and the README\'s marks name the den glyph', () => {
    expect(manual).toContain(`<tr><td class="k">${GLYPHS.den}</td><td>a den — where a thing you photographed lives`)
    expect(readme).toContain(`| ${GLYPHS.den} | a den: where a thing you photographed lives |`)
  })
  it('the README\'s polaroid row says the den, once a kind a visit, on your map only', () => {
    const row = readme.split('\n').find((l) => l.startsWith('| polaroid camera |'))
    expect(row).toContain(`its den goes on your map (${GLYPHS.den})`)
    expect(row).toMatch(/once for each kind each time you come to a floor, and on your map only/)
  })
})
