// 2.0.6's release notes (docs/release-notes/v2.0.6.md), a draft written before the version bump: they quote every new line of the field
// terminal exactly as the game says it (so a voice pass that changes a line changes the notes with it), say that nothing new goes over
// the wire and that the closing key moved off the screen, and leave no draft marker half-deleted (the draft comment on line 1 is the
// owner's to delete; the offline cache's new name is the release step's). The manual and the README say the same.
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import { TERM, TERM_CHROME } from '../src/renderer/terminal.js'
import { LEDGER_LABEL } from '../src/renderer/closings.js'

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8')
const notes = read('../docs/release-notes/v2.0.6.md'), manual = read('../docs/manual.html'), readme = read('../README.md')
// what is left outside the closed comments, walked with indexOf as docs-release-205.test.js does, and whether a marker is left open in it
const draftLeftOpen = (s) => {
  let rest = ''
  for (let i = 0; ;) {
    const open = s.indexOf('<!--', i)
    if (open < 0) { rest += s.slice(i); break }
    rest += s.slice(i, open)
    const ends = [s.indexOf('-->', open + 4), s.indexOf('--!>', open + 4)].filter((e) => e >= 0)
    if (!ends.length) return true
    const end = Math.min(...ends)
    i = end + (s.startsWith('-->', end) ? 3 : 4)
  }
  return rest.includes('DRAFT') || rest.includes('<!--') || rest.includes('-->') || rest.includes('--!>')
}

describe('the 2.0.6 release notes (a draft)', () => {
  it('leave no draft marker open', () => {
    expect(draftLeftOpen(notes)).toBe(false)
    expect(notes).toContain('## the backrooms 2.0.6')
  })
  it('quote every new line in italics, as the game says it', () => {
    for (const [k, l] of Object.entries(TERM)) expect(notes, k).toContain(`*${l}*`)
    expect(notes).toContain('`› file · · ·`')
    expect(notes).toContain('**forget what the terminal kept**')
    expect(TERM_CHROME.SETTINGS_FORGET).toBe('forget what the terminal kept')
  })
  it('say what a room and an old save see, and that the closing key left the screen', () => {
    expect(notes).toContain('### update together')
    expect(notes).toContain('nothing new goes over the wire')
    expect(notes).toMatch(/a room can mix 2\.0\.5 and 2\.0\.6/)
    expect(notes).toContain('**the closing key no longer appears on the screen**')
    expect(notes).toContain('a solo run saved on 2.0.5 continues where you left it.')
  })
  it('say the rest: vertical look in its own words, sealed notes, the Windows install by hand, the cache, the site', () => {
    const settings = fs.readFileSync(new URL('../src/renderer/index.html', import.meta.url), 'utf8')
    for (const l of ['Vertical look', 'look up and down too', 'Invert vertical look', 'push up to look down']) {
      expect(settings, l).toContain(l)
      expect(notes, l).toContain(l)
    }
    expect(notes).toContain('**a case\'s notes are sealed.**')
    expect(notes).toContain('**on windows with 2.0.3, 2.0.4 or 2.0.5:**')
    expect(notes).toContain('`The-Backrooms-Setup-2.0.6.exe`')
    expect(notes).toContain('backrooms-pwa-v14')
    expect(fs.readFileSync(new URL('../src/sw.js', import.meta.url), 'utf8')).toContain("const CACHE = 'backrooms-pwa-v14'")
    expect(notes).toContain('put `docs/manual.html` at `manual/index.html` on gh-pages')
    expect(JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version).toBe('2.0.6')
  })
})

describe('the manual and the README say it too', () => {
  it('the key, the Esc order, the console\'s /file and /term, the terminal\'s own section, the save rules, the board', () => {
    expect(manual).toContain('<div class="cap"><kbd>`</kbd></div><div class="kdesc"><b>The field terminal</b> — the key left of <kbd>1</kbd>.')
    expect(manual).toContain('<b>Close the nearest thing</b>, in this order: settings, the field terminal, a card in your hands,')
    expect(manual).toContain('· b beacon · ` terminal</div>')
    expect(manual).toContain('<tr><td class="k">/term</td>')
    expect(manual).toContain('<i>the case is read. the terminal keeps its closing file.</i>')
    expect(manual).toContain('<h3 id="terminal">The field terminal</h3>')
    expect(manual).toContain('<b>Nor is what the field terminal keeps.</b>')
    expect(manual).toContain('of the browser copy at <code>/play/</code> only: the desktop app and the itch.io copy keep their own.')
    expect(manual).not.toContain('In a browser, the case board on the site reads the same record; the desktop app keeps its own.')
    expect(manual).toContain(`<i>${TERM.BANNER}</i>`)
    expect(manual).toContain(`<i>${TERM.FILE_WAIT}</i>`)
    expect(manual).toContain('<b>forget what the terminal kept</b>')
    // a hit does not fold the terminal (it folds the map, as before); the notes and the manual say so
    expect(manual).not.toContain('It also folds the map and the terminal')
    expect(manual).toContain('A hit does not, as it does not fold the line')
    expect(notes).toContain('a hit does not, as it does not fold the line')
    expect(LEDGER_LABEL).toBe('the station has read its last group to you')
  })
  it('the README: the console\'s board holds on the site only, the terminal\'s paragraph and its key', () => {
    expect(readme).toContain('in the browser copy at `/play/` on the site, progress is shared with [the case board]')
    expect(readme).not.toContain('progress is shared with [the case board](https://backrooms.thecornerspore.dev/recover/) in the same browser.')
    expect(readme).toContain('**the field terminal.** press the key left of 1')
    expect(readme).toContain('| `` ` `` | the field terminal (the key left of 1; or `/term` on the line)')
  })
})
