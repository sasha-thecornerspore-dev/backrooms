// 2.0.5's release notes (docs/release-notes/v2.0.5.md), written before the version bump: they quote the game's new lines exactly as the
// game says them (so a voice pass that changes a line changes the notes with it), say what a room and an old save see, and leave no
// draft marker half-deleted (the draft comment on line 1 is the owner's to delete, as docs-pulse.test.js holds for the current version).
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import { FEELINGS } from '../src/renderer/feelings.js'
import { LEARN_LINES } from '../src/renderer/learn.js'
import { denLine } from '../src/renderer/film.js'
import { SITUATIONAL } from '../src/renderer/touch.js'

const notes = fs.readFileSync(new URL('../docs/release-notes/v2.0.5.md', import.meta.url), 'utf8')
const draftLeftOpen = (s) => /DRAFT|<!--|-->/.test(s.replace(/<!--[^]*?-->/g, ''))

describe('the 2.0.5 release notes', () => {
  it('leave no draft marker open, with the draft comment or without it', () => {
    expect(draftLeftOpen(notes)).toBe(false)
    expect(draftLeftOpen(notes.replace(/^<!--[^]*?-->\r?\n/, ''))).toBe(false)
  })
  it('quote the new lines as the game says them, and name the touch buttons as the discs read', () => {
    for (const f of Object.values(FEELINGS)) expect(notes, f.line).toContain(`*${f.line}*`)
    expect(notes).toContain(`*${LEARN_LINES.still}*`)
    expect(notes).toContain(`*${denLine('hound')}*`)
    for (const b of SITUATIONAL) expect(notes, b.label).toContain(`**${b.label}**`)
  })
  it('say when a feeling\'s line is not said, and that the radio does not hear what is already after you', () => {
    expect(notes).toContain('climbing out to the lobby it is said in place of *the carpet remembers you.*, and coming down in the lift there is no room for it: the feeling holds, unsaid.')
    expect(notes).toContain('once something is coming for you the hiss does not die down, but it no longer rises for that thing, and one that followed you down brings none.')
    expect(notes).not.toContain('once something is coming for you it does not die down.')
  })
  it('say what a room and an old save see: nothing new on the wire, the feelings and the learning off in a room, a 2.0.4 save going on', () => {
    expect(notes).toContain('## the backrooms 2.0.5')
    expect(notes).toContain('### update together')
    expect(notes).toContain('nothing new goes over the wire')
    expect(notes).toMatch(/a room can mix 2\.0\.4 and 2\.0\.5/)
    expect(notes).toMatch(/never feels different there, and the things never learn/)
    expect(notes).toMatch(/saved on 2\.0\.4 continues where you left it/)
    expect(notes).toContain('backrooms-pwa-v13')
    expect(fs.readFileSync(new URL('../src/sw.js', import.meta.url), 'utf8')).toContain("const CACHE = 'backrooms-pwa-v13'")
  })
})
