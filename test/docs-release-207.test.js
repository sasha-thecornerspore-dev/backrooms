// 2.0.7's release notes (docs/release-notes/v2.0.7.md): the crew and the relay guard. They quote every new line exactly as the game says
// it — read from the modules that say it, so a voice pass that changes a line changes the notes with it — say what a room of 2.0.6 and
// 2.0.7 sees, that the relay guard is its own deploy, that nothing new goes over the wire and that the body line lost its coordinates,
// and leave no draft marker half-deleted (the draft comment that sat on line 1 came off once the owner's voice pass was in: every line
// kept, every recommendation on the desk taken). The manual and the README say the same; the version and the offline cache moved on
// for the one new file.
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import { LINE, CAME_BACK_LINE, sysText, lineNotice } from '../src/net/client.js'
import { CREW, whoLines, refileLine, squareLine, photoWord } from '../src/renderer/crew.js'
import { BODY_LINE, LEASH_FREE_M, LEASH_FAR_M, pinCaption } from '../src/renderer/origin-anchored.js'
import { ADDRESS_PIN } from '../src/renderer/origin-intake.js'
import { ROOM_PIN_JOIN, ANCHORED_LINE } from '../src/renderer/site.js'
import { LINES } from '../src/renderer/compose-polaroid.js'
import { TERM } from '../src/renderer/terminal.js'

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const notes = read('../docs/release-notes/v2.0.7.md'), manual = read('../docs/manual.html'), readme = read('../README.md')
const game = read('../src/renderer/game.js')
// what is left outside the closed comments, walked with indexOf as docs-release-206.test.js does, and whether a marker is left open in it
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
const italic = (l) => `*${l}*`
// the new lines as the game says them, with the names and words the notes use
const SELF = { id: 'me', lvl: 2, status: 'extension' }
const WHO = whoLines([{ id: 'a', name: 'maddie', lvl: 0, status: 'litigation' }, { id: 'b', name: 'ada', lvl: 4, status: 'compliance' }, { id: 'c', name: 'bo' }], SELF)
// the film's anchored pin, one line for each of the leash's three bands (close, a long walk, far)
const PIN_CAPTIONS = [pinCaption(null, LEASH_FREE_M), pinCaption(null, LEASH_FAR_M), pinCaption(null, LEASH_FAR_M + 1)]
const HELP = 'the file does not recognise that. try /recover, /cases, /file <answer>, /intake, /status, /who or /invite.'
const NEW_LINES = [
  ...Object.values(LINE),
  sysText('maddie', CAME_BACK_LINE),
  'failed: ' + 'too fast',                                     // a first join the room closes 4029 (index.html's 'failed: ' + the client's error)
  CREW.WHO_SOLO, ...WHO,
  refileLine('maddie', 'litigation'), squareLine('maddie'),
  LINES.SUBJECT_PROCESSED.replace('{name}', 'maddie') + photoWord('litigation'),
  BODY_LINE, ...PIN_CAPTIONS, ADDRESS_PIN, ANCHORED_LINE, ROOM_PIN_JOIN,
]

describe('the 2.0.7 release notes', () => {
  it('leave no draft marker open', () => {
    expect(draftLeftOpen(notes)).toBe(false)
    expect(notes).not.toContain('DRAFT')
    expect(notes.split('\n')[0]).toMatch(/^\*\*play it now in your browser, no install:\*\*/)
    expect(notes).toContain('## the backrooms 2.0.7')
  })

  it('quote every new line in italics, as the game says it', () => {
    expect(WHO).toEqual([
      'you · pipe dreams · filed under extension.', 'maddie · the lobby · filed under litigation.',
      'ada · filed under compliance.', 'bo · the file has not placed them.',
    ])
    for (const l of NEW_LINES) expect(notes, l).toContain(italic(l))
    // the plate's rows are the lines above, in the plate's order
    expect(lineNotice('retrying')).toEqual([LINE.DEAD, LINE.TRYING, LINE.PRESS_KEY])
    expect(lineNotice('gave-up', true)).toEqual([LINE.DEAD, LINE.GAVE_UP, LINE.PRESS_TAP])
    expect(lineNotice('flood')).toEqual([LINE.FLOOD])
    // a first join the room closes 4029: the title shows 'failed: ' and the client's error, which is 'too fast'
    expect(read('../src/renderer/index.html')).toContain("st.textContent = `failed: ${e.message || 'could not connect'}`")
    expect(read('../src/net/client.js')).toContain("new Error(code === FLOOD_CLOSE ? 'too fast' : 'connection closed before welcome')")
    // the console's help line, changed only to name /who (never on the block): its <answer> written so a markdown page shows it
    expect(game).toContain(`const help = '${HELP}'`)
    expect(game).toContain("showMessage(level?.cfg.map ? help.replace(', /who', '') : help)")
    expect(notes).toContain(italic(HELP.replace('<answer>', '&lt;answer&gt;')))
    // the lines it leans on that were already there are quoted as they are
    for (const l of [TERM.WHERE_NONE, LINES.SUBJECT_PIN.replace('{name}', 'maddie'), 'your hands are not ready.', 'no one is here to hear it.']) {
      expect(notes, l).toContain(italic(l))
    }
  })

  it('say the sections: players, a mixed room, the relay guard, privacy, install, the operator and the site', () => {
    for (const h of ['### what changed for players', '### update together', '### the relay guard', '### privacy', '### install, on every system', '### for whoever runs the relay and the site']) {
      expect(notes, h).toContain(h)
    }
    expect(notes).toMatch(/a room can mix 2\.0\.6 and 2\.0\.7/)
    expect(notes).toContain('a 2.0.6 player sees none of it')
    expect(notes).toContain('a 2.0.6 copy whose own line drops is still left in an empty maze')
    expect(notes).toContain('a solo run saved on 2.0.6 continues where you left it')
  })

  it('say the relay guard deploys with the push that brings 2.0.7 to main unless it is held, and what a 2.0.6 copy does after it', () => {
    expect(notes).toContain('the relay guard goes out on its own deploy, at an hour the owner picks.')
    expect(notes).not.toContain('until then nothing changes on the relay')
    expect(notes).toContain('a 2.0.6 copy that drops does not rejoin by itself')
    expect(notes).toContain('closed with code 4029, reason `too fast`')
    expect(notes).toContain('the push that brings 2.0.7 to main is the relay deploy')
    // every file the relay workflow deploys on is named, as the workflow lists them
    const wf = read('../.github/workflows/relay-deploy.yml')
    const paths = wf.slice(wf.indexOf('  push:'), wf.indexOf('  workflow_dispatch:'))
    for (const f of ['relay/**', 'src/renderer/anchor.js', 'src/renderer/origin-intake.js', 'src/renderer/status.js', 'src/renderer/prefs.js', 'src/renderer/scraps.js', 'src/wish-labels.js']) {
      expect(paths, f).toContain(`'${f}'`)
      const name = f.startsWith('relay/') ? '`relay/`' : f.split('/').pop()
      for (const [doc, label] of [[notes, 'notes'], [readme, 'README'], [read('../docs/operations.md'), 'operations']]) expect(doc, `${label}: ${name}`).toContain(name)
    }
    // the guard: a 2.0.7 copy holds back through a stall, and nobody is told an honest copy cannot be cut
    expect(notes).toContain('a 2.0.7 copy holds back where it stands while its line is silent')
    expect(notes).not.toContain('an honest copy never sees it')
    expect(notes).not.toContain('one player cannot flood a room')
  })

  it('say the privacy: nothing new over the wire, the body line without coordinates, no location asked', () => {
    expect(notes).toContain('nothing new goes over the wire between players')
    expect(notes).toContain('the body line no longer shows coordinates')
    expect(notes).toContain('the game never asks for your location')
    expect(BODY_LINE).not.toMatch(/\d/)
    // the film's anchored pin says the distance in words too, so it passes the rules like every other line: no number of metres
    expect(new Set(PIN_CAPTIONS).size).toBe(3)
    for (const l of PIN_CAPTIONS) expect(l).not.toMatch(/\d/)
    expect(notes).toContain("the film's anchored pin says it in words now, the distance too, in three steps that follow the leash")
    expect(notes).not.toMatch(/\d+ m behind you/)
    expect(notes).not.toContain('the distance as before')
  })

  it('say the version, the cache, the one new file, and the site step; Windows on 2.0.6 updates itself', () => {
    expect(JSON.parse(read('../package.json')).version).toBe('2.0.7')
    const lock = JSON.parse(read('../package-lock.json'))
    expect(lock.version).toBe('2.0.7')
    expect(lock.packages[''].version).toBe('2.0.7')
    expect(notes).toContain('backrooms-pwa-v15')
    expect(read('../src/sw.js')).toContain("const CACHE = 'backrooms-pwa-v15'")
    expect(notes).toContain('`The-Backrooms-Setup-2.0.7.exe`')
    expect(notes).toContain('windows installs on 2.0.6 and appimage installs on 2.0.x move to 2.0.7 on their own')
    expect(notes).not.toContain('install by hand')
    expect(notes).toContain('put `docs/manual.html` at `manual/index.html` on gh-pages')
  })

  // a Windows copy on 2.0.3 to 2.0.5 refuses every update (its check fails on the installer's signature), and the latest release's page
  // is the one its player lands on. so these notes say it too, as the 2.0.6 notes did, and name this release's installer: nothing here
  // asks anyone on 2.0.6 to do a thing, which is what the line above guards
  it('tell a Windows copy on 2.0.3, 2.0.4 or 2.0.5 to run this installer once: above the changes, and again under install', () => {
    const top = notes.slice(0, notes.indexOf('### what changed for players'))
    expect(top).toContain('**on windows with 2.0.3, 2.0.4 or 2.0.5:** your copy cannot update itself: its update check fails. download `The-Backrooms-Setup-2.0.7.exe` below and run it once, over the old install.')
    const install = notes.slice(notes.indexOf('### install, on every system'), notes.indexOf('### for whoever runs the relay and the site'))
    expect(install).toContain('windows installs on 2.0.3, 2.0.4 and 2.0.5 cannot (see the top)')
    expect(notes).not.toContain('Setup-2.0.6.exe')                  // never the old installer's name, carried over with the line
    // the same three versions the 2.0.6 notes and the operations table name
    expect(read('../docs/release-notes/v2.0.6.md')).toContain('**on windows with 2.0.3, 2.0.4 or 2.0.5:**')
    expect(read('../docs/operations.md')).toContain('their version: 2.0.3, 2.0.4 or 2.0.5')
  })

  it('the one new module, crew.js, is in every list a shipped file must be in', () => {
    expect(read('../src/sw.js')).toContain("'/renderer/crew.js'")
    expect(read('../tools/build-play.sh')).toContain("'crew.js'")
    expect(JSON.parse(read('../package.json')).build.files).toContain('src/**/*')
  })
})

describe('the manual and the README say it too', () => {
  it('the manual: /who, the dropped line and R (and the tap), the map\'s whistle mark, the body, the square, the film\'s word, the joiner', () => {
    expect(manual).toContain('<tr><td class="k">/who</td>')
    expect(manual).toContain('<div class="cap"><kbd>R</kbd></div><div class="kdesc"><b>Call the line back.</b>')
    expect(manual).toContain('On a phone, tap the plate that says so.')
    for (const l of [LINE.DEAD, LINE.TRYING, LINE.GAVE_UP, LINE.BACK, LINE.FLOOD, sysText('maddie', CAME_BACK_LINE)]) expect(manual, l).toContain(`<i>${l}</i>`)
    expect(manual).toContain(`<code>${LINE.PRESS_KEY}</code>`)
    expect(manual).toContain(`<code>${LINE.PRESS_TAP}</code>`)
    // the map's own section has the whistle's mark
    const map = manual.slice(manual.indexOf('<section id="map">'), manual.indexOf('</section>', manual.indexOf('<section id="map">')))
    expect(map).toContain('a faint pencil mark (∿) where they stood')
    expect(manual).toContain(`<i>${BODY_LINE}</i>`)
    expect(manual).not.toContain('your body remains at')
    expect(manual).toContain('<code>came in from your square.</code>')
    expect(manual).toContain('<i>filed under litigation.</i>')
    expect(manual).toContain(`<i>${ROOM_PIN_JOIN}</i>`)
  })

  it('the manual hints at the stand in company (decision 7: a hint only, never the rule)', () => {
    const stand = manual.slice(manual.indexOf('<div class="h">the stand</div>'), manual.indexOf('</div>', manual.indexOf('<div class="h">the stand</div>') + 30))
    expect(stand).toContain('The deepest floor is where it is found alone.')
    // the rule itself is not written down: neither the count nor the floor it moves to
    for (const w of ['two', 'pipe dreams', 'habitable zone', 'moves', 'friends']) expect(stand, w).not.toContain(w)
  })

  it('the README: R in the key table, /who, the dropped line, the whistle mark, and the relay\'s pace for whoever runs one', () => {
    expect(readme).toContain('| r | online, once the line has dropped: call it back now')
    expect(readme).toContain('`/who` (who is in the room, in words)')
    expect(readme).toContain('*the line went dead. the others are gone.*')
    expect(readme).toContain('leaves a faint pencil mark (∿) on your map')
    expect(readme).toContain('**the room\'s pace (2.0.7).**')
    expect(readme).toContain('closed with code `4029`, reason `too fast`')
  })
})
