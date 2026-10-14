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
    expect(manual).toContain('<meta property="og:image" content="https://backrooms.thecornerspore.dev/og/manual-v1.jpg">')
  })
})
