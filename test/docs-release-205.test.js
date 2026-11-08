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
// what is left outside the closed comments, walked with indexOf as docs-pulse.test.js does, and whether a marker is left open in it
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
const dropLeadingComment = (s) => {
  if (!s.startsWith('<!--')) return s
  const end = s.indexOf('-->')
  return end < 0 ? s : s.slice(end + 3).replace(/^\r?\n/, '')
}

describe('the 2.0.5 release notes', () => {
  it('leave no draft marker open, with the draft comment or without it', () => {
    expect(draftLeftOpen(notes)).toBe(false)
    expect(draftLeftOpen(dropLeadingComment(notes))).toBe(false)
    expect(notes.startsWith('<!--')).toBe(false)   // the owner kept the features as built (2026-11-04): the draft comment is off
  })
  it('quote the new lines as the game says them, and name the touch buttons as the discs read', () => {
    for (const f of Object.values(FEELINGS)) expect(notes, f.line).toContain(`*${f.line}*`)
    expect(notes).toContain(`*${LEARN_LINES.still}*`)
    expect(notes).toContain(`*${denLine('hound')}*`)
    for (const b of SITUATIONAL) expect(notes, b.label).toContain(`**${b.label}**`)
  })
  it('say when a feeling\'s line is not said, and that the radio does not hear what is already after you', () => {
    expect(notes).toContain("on a floor you come back to it comes just after the floor's name (off the lift, just after the lift's own line); on a first visit the floor's own lines keep their places, and the lift's, and it is said only if they leave room: if not, the feeling holds, unsaid; climbing out to the lobby it is said in place of *the carpet remembers you.*")
    expect(notes).not.toMatch(/coming down in the lift there is no room for it/)
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
    expect(notes).toContain('backrooms-pwa-v13')   // (the cache moved on in 2.0.6: docs-release-206.test.js pins it now)
  })
})
