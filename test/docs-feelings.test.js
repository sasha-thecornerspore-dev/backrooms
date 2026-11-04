// The docs follow the floor feelings (feelings.js): the manual and the README quote the three lines as the game says them, say what each
// one changes and what it never does, and the README's maintainer notes name world.json's switch. The game's own lines are imported, so
// the next change to one of them turns this red until the docs follow.
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { FEELINGS, FEELING_IDS } from '../src/renderer/feelings.js'
import { SEARCHED_HINT } from '../src/renderer/containers.js'

const root = path.resolve(import.meta.dirname, '..')
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8').replace(/\r\n/g, '\n')
const readme = read('README.md'), manual = read('docs/manual.html')
const section = manual.slice(manual.indexOf('<h3 id="feelings">'), manual.indexOf('<h3>Furniture, rooms, landmarks</h3>'))
const para = readme.slice(readme.indexOf('**some visits feel different.**'), readme.indexOf('\n', readme.indexOf('**some visits feel different.**')))

describe('the manual', () => {
  it('has its own passage in the building\'s section, quoting each line whole', () => {
    expect(section.length).toBeGreaterThan(200)
    expect(manual.indexOf('<h3 id="feelings">')).toBeGreaterThan(manual.indexOf('<section id="building">'))
    for (const id of FEELING_IDS) expect(section, id).toContain(`<i>${FEELINGS[id].line}</i>`)
    expect(section).toContain(`<p class="say">${FEELINGS.dark.line}</p>`)
  })
  it('says what each changes, and what never changes', () => {
    expect(section).toMatch(/panels are dark[^.]*lamps[^.]*your own light matters/)
    expect(section).toMatch(/hum is a little lower[^.]*further apart/)
    expect(section).toContain(`<i>${SEARCHED_HINT}</i>`)
    expect(section).toMatch(/chairs have been moved/)
    expect(section).toMatch(/things behave as they always do/)
  })
  it('says when: about one arrival in three, never twice running, never the lobby\'s first time, the block or a shared room', () => {
    expect(section).toMatch(/one arrival in three/)
    expect(section).toMatch(/never the same way two visits running/)
    expect(section).toMatch(/Never your first time in the lobby/)
    expect(section).toMatch(/never on the block/)
    expect(section).toMatch(/never in a shared room/)
    expect(section).toMatch(/classic shading/)
  })
  it('says when the line comes and when it does not: after the floor\'s name on a return, in place of the carpet\'s climbing out, none off the lift', () => {
    expect(section).toContain('On a floor you come back to, the line comes just after the floor\'s name, in place of the line that says you have been there before; climbing out to the lobby, in place of <i>the carpet remembers you.</i>')
    expect(section).toContain('Coming down in the lift there is no room for it after the lift\'s own line, and on a first visit the floor\'s own hint comes first: then the line may not come at all, though the floor still feels that way.')
    // the ways table's ring row says the same
    expect(manual).toContain('back to the lobby — <i>the carpet remembers you.</i> (on a visit the lobby <a href="#feelings">feels different</a>, its feeling is said instead)')
  })
})

describe('the README', () => {
  it('lists the feature beside the floors that remember, with the three lines and the same limits', () => {
    expect(readme.indexOf('**some visits feel different.**')).toBeGreaterThan(readme.indexOf('**the floors remember.**'))
    for (const id of FEELING_IDS) expect(para, id).toContain(`*${FEELINGS[id].line}*`)
    expect(para).toMatch(/one arrival in three/)
    expect(para).toMatch(/never on the block and never in a shared room/)
  })
  it('says the chairs move on the lobby only, as the manual does (the lobby is the only floor with chairs)', () => {
    expect(para).toContain('(some drawers already searched, and on the lobby some chairs moved)')
    expect(para).not.toMatch(/searched, chairs moved\)/)
  })
  it('the maintainer notes name world.json\'s switch and what refuses a bad one', () => {
    expect(readme).toContain('`world.json` ships `"feelings": true`')
    expect(readme).toMatch(/set it to `false` and no floor feels different/)
    expect(readme).toContain('`node tools/validate-world.mjs` refuses anything but `true` or `false`')
  })
})
