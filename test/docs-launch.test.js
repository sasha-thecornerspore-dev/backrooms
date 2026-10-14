// The docs follow 2.0.0's way in (owner decisions 2026-10-13): the lobby first and the block behind the front door, invite links and the
// pin warning, wishes read and granted by hand through the relay, LAN only in the desktop app, the counter disclosed, the licences named.
// Pinned so a later edit cannot quietly put the old claims back.
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { PIN_WARNING } from '../src/renderer/site.js'

const root = path.resolve(import.meta.dirname, '..')
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8').replace(/\r\n/g, '\n')
const readme = read('README.md'), manual = read('docs/manual.html'), notes = read('docs/release-notes/v2.0.0.md')
const docs = { readme, manual, notes }

describe('the way in: the lobby first, the block behind the front door', () => {
  it('no doc says a solo run begins on the block', () => {
    for (const [k, d] of Object.entries(docs)) {
      for (const s of ['every solo run begins', 'starts a fresh run on the block', 'solo** begins outside', 'run begins on <b>Level ∅', 'starting on the block', 'you start here</text>\n'])
        expect(d, `${k}: ${s}`).not.toContain(s)
    }
  })
  it('each doc names the front door', () => {
    expect(readme).toContain('**the front door**')
    expect(readme).toContain('*a real block. read the form. find the gap.*')
    expect(manual).toContain('<b>the front door</b>')
    expect(notes).toContain('**the front door**')
    expect(notes).toContain('**every run begins in the lobby**')
  })
})

describe('invite links and the pin warning', () => {
  it('README and the manual say the link, /invite and the warning the game shows', () => {
    for (const d of [readme, manual]) {
      expect(d).toContain('https://backrooms.thecornerspore.dev/play/?room=CODE')
      expect(d).toContain('/invite pin')
      expect(d).toContain(PIN_WARNING)
    }
    expect(readme).toMatch(/^\| enter \| [^\n]*`\/invite`/m)
  })
})

describe('wishes: through the relay, read and granted by hand', () => {
  it('no doc says a wish goes nowhere or is granted on its own', () => {
    for (const [k, d] of Object.entries(docs)) {
      for (const s of ['goes nowhere', 'go nowhere', 'the spirits answer on their own', 'wishes leave only from the desktop app', 'ISSUES_TOKEN` secret, written'])
        expect(d, `${k}: ${s}`).not.toContain(s)
    }
  })
  it('each doc says a person reads every wish', () => {
    expect(readme).toContain('a person reads every wish and grants it by hand')
    expect(readme).toContain('**the auto-arbiter is paused.**')
    expect(manual).toContain('a person reads it — every one')
    expect(notes).toContain('a person reads every one')
  })
  it('the release notes tell whoever runs the relay: redeploy, GITHUB_TOKEN, the Gate migration', () => {
    const relay = notes.slice(notes.indexOf('### for whoever runs the relay'))
    for (const s of ['npx wrangler deploy', 'GITHUB_TOKEN', '`v2` migration', '`Gate` durable object']) expect(relay, s).toContain(s)
  })
})

describe('the counter, the licences, the share card', () => {
  it('README discloses the counter the way the site does, and that the desktop app and itch count nothing', () => {
    expect(readme).toContain('**what is counted.**')
    expect(readme).toContain('the desktop app and the itch.io copy count nothing.')
  })
  it('README has a license section naming both files; the release notes and the manual name both licences', () => {
    const lic = readme.slice(readme.indexOf('## license'))
    for (const s of ['[MIT](LICENSE)', 'CC BY-SA 3.0', '[LICENSE-LORE.md](LICENSE-LORE.md)']) expect(lic, s).toContain(s)
    expect(notes).toContain('### the licence')
    expect(manual).toContain('cc by-sa 3.0')
  })
  it('the manual carries the site copy\'s share-card tags, so the next copy to the site keeps them', () => {
    expect(manual).toContain('<link rel="canonical" href="https://backrooms.thecornerspore.dev/manual/">')
    expect(manual).toContain('<meta property="og:image" content="https://backrooms.thecornerspore.dev/og/manual-v2.jpg">')
  })
})

describe('the launch review: what the docs must now say', () => {
  const html = read('src/renderer/index.html')
  it('the old wish token is revoked by the owner before 2.0.0 is published (review SEC-1)', () => {
    for (const [k, d] of [['readme', readme], ['notes', notes]]) {
      const at = d.indexOf('revoke')
      expect(at, k).toBeGreaterThan(-1)
      const near = d.slice(Math.max(0, at - 300), at + 600)
      expect(near, k).toContain('ISSUES_TOKEN')
      expect(near, k).toMatch(/delete the `ISSUES_TOKEN` repository secret/)
      expect(near, k).toMatch(/this repository only, issues read and write, nothing else/)
    }
  })
  it('the counter: what GoatCounter stores, the front page too, and no room code or pin (review PRIV-1, PRIV-4, DOC-4)', () => {
    for (const [k, d] of Object.entries(docs)) {
      for (const s of ['ride along', 'reaches GoatCounter\'s server', 'though the page it counts stays']) expect(d, `${k}: ${s}`).not.toContain(s)
    }
    expect(readme).toContain('your browser and operating system, your language, screen width and country')
    expect(readme).toContain('no room code or pin is ever sent to it')
    expect(notes).toContain('your browser and operating system, your language, screen width and country')
    expect(manual).toContain("The site's front page and the browser game at <code>/play/</code> carry one cookieless counter")
    expect(manual).toContain('your browser and system, your language, screen width and country')
  })
  it('the front door replaces a solo save just as SOLO does, and every warning says so (review DOC-5)', () => {
    expect(readme).toContain('starting SOLO (or the front door) over it replaces it')
    expect(readme).toContain('**SOLO** or **the front door** with a save present starts over and replaces it')
    expect(manual).toContain('⚠ before you press SOLO or the front door')
    expect(manual).toContain('<b>SOLO ▶</b> and the front door start over and overwrite your solo save without asking.')
  })
  it('the manual\'s licence links reach the copies the site ships with /play/, not a branch that may not hold them yet (review DOC-6)', () => {
    expect(manual).not.toContain('blob/main/LICENSE')
    expect(manual).toContain('href="https://backrooms.thecornerspore.dev/play/LICENSE"')
    expect(manual).toContain('href="https://backrooms.thecornerspore.dev/play/LICENSE-LORE.md"')
  })
  it('the wish box itself says a wish is posted publicly (review DOC-3)', () => {
    expect(html).toContain('<p id="wish-note">what you say here is posted publicly. put nothing real about yourself in it.</p>')
    const inner = html.slice(html.indexOf('<div id="wish-inner">'), html.indexOf('<div id="wish-actions">'))
    expect(inner).toContain('id="wish-note"')
    expect(html).toMatch(/#wish-note \{[^}]*font-size: 11px;[^}]*\}/)
  })
  it('/play/ carries its share card right after <title> (growth-spec §2.2; review DOC-10)', () => {
    const head = html.slice(html.indexOf('<title>'), html.indexOf('<!-- PWA'))
    for (const s of ['<link rel="canonical" href="https://backrooms.thecornerspore.dev/play/">', '<meta property="og:type" content="website">',
      '<meta property="og:url" content="https://backrooms.thecornerspore.dev/play/">', '<meta property="og:image" content="https://backrooms.thecornerspore.dev/og/play-v2.jpg">',
      '<meta property="og:image:width" content="1200">', '<meta property="og:image:height" content="630">', '<meta name="twitter:card" content="summary_large_image">',
      '<meta name="twitter:image" content="https://backrooms.thecornerspore.dev/og/play-v2.jpg">',
      '<meta property="og:image:alt" content="The title screen of The Backrooms over a dim yellow corridor: a field for a map pin, solo, play online, and the front door.">']) {
      expect(head, s).toContain(s)
    }
    expect(html).not.toContain('play-v1.jpg')                      // the old card showed the pre-2.0 title (review DOC-9)
  })
})
