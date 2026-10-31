// The docs follow 2.0.4's pulse (review S9, S10, C14, S11, S13): the manual and README quote the lines the game says now, not the
// ones it stopped saying, and say what the compass and the ambience setting do now. The game's own lines are imported, so the next
// change to one of them turns this red until the docs follow.
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { LEVELS } from '../src/renderer/levels.js'
import { NOT_NOW_LINE, SEARCHED_HINT, TRACE_LINES, searchingHint } from '../src/renderer/containers.js'
import { FAINT } from '../src/renderer/compass.js'

const root = path.resolve(import.meta.dirname, '..')
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8').replace(/\r\n/g, '\n')
const readme = read('README.md'), manual = read('docs/manual.html'), index = read('src/renderer/index.html')
const docs = { readme, manual }

describe('the lobby\'s arrival line', () => {
  it('the manual quotes the lobby\'s sub-line as the game shows it, without the old "no exit."', () => {
    expect(manual).toContain(`<p class="line">${LEVELS[0].sub}</p>`)
    for (const [k, d] of Object.entries(docs)) expect(d, k).not.toContain('no exit. you are here')
  })
})

describe('the drawers', () => {
  it('no doc quotes "you rummage." any more; both quote the refusal whole', () => {
    for (const [k, d] of Object.entries(docs)) {
      expect(d, k).not.toContain('you rummage.')
      expect(d, k).toContain(NOT_NOW_LINE)
      expect(d, k).not.toMatch(/not now\.(?! something is close\.)/)
    }
  })
  it('the manual says the hold\'s hint, the searched hint, a floor plan, and a find held for the visit', () => {
    expect(manual).toContain(`<i>${searchingHint('cabinet')}</i>`)
    expect(manual).toContain(`<i>${SEARCHED_HINT}</i>`)
    expect(manual).toContain(`<i>${TRACE_LINES.content}</i>`)
    expect(manual).toMatch(/hands are full[^<]*waits in that drawer/)
    expect(readme).toContain(`*${SEARCHED_HINT}*`)
    expect(readme).toContain('a floor plan that marks your map')
    expect(readme).toMatch(/hands are too full for waits in the drawer/)
  })
})

describe('the compass', () => {
  it('no doc promises the faint line at once or with a distance', () => {
    expect(manual).not.toContain('each with an arrow turned to your facing and a distance')
    expect(manual).not.toContain(`until you have seen one, it says <code>${FAINT}</code>.`)
    expect(manual).toContain(`<code>${FAINT}</code>: no distance, and not quite true`)
    expect(readme).not.toContain(`when you have seen none, *${FAINT}*.`)
    expect(readme).toContain(`after a while or a hint, *${FAINT}*: no distance, and not quite true`)
  })
})

describe('the ambience setting', () => {
  it('the hint, the manual and the README say it carries your steps and the sounds of things nearby', () => {
    const hint = index.match(/Ambience <span class="set-hint">([^<]*)<\/span>/)[1]
    expect(hint).not.toBe('hum &amp; drone')
    expect(hint).toContain('steps')
    expect(hint).toBe(hint.toLowerCase())
    expect(hint).not.toMatch(/[0-9!]/)
    expect(manual).toMatch(/<td class="k">Ambience<\/td>.*<td data-label="notes">[^<]*your own steps[^<]*<\/td>/)
    expect(readme).toMatch(/^\| ambience \| [^\n]*your own steps[^\n]*\|$/m)
  })
})
