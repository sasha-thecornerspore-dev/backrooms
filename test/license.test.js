// The licence (owner decision 2026-10-13): MIT for the code, copyright Corner Spore; CC BY-SA 3.0 — the Backrooms wiki's own licence —
// for the Backrooms-derived lore and text, with its scope written down and the wiki's community credited.
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8').replace(/\r\n/g, '\n')

describe('LICENSE (MIT)', () => {
  const mit = read('LICENSE')
  it('is the MIT licence, copyright Corner Spore', () => {
    expect(mit.split('\n')[0]).toBe('MIT License')
    expect(mit).toContain('Copyright (c) 2026 Corner Spore')
    expect(mit).toContain('Permission is hereby granted, free of charge, to any person obtaining a copy')
    expect(mit).toContain('The above copyright notice and this permission notice shall be included in all\ncopies or substantial portions of the Software.')
    expect(mit).toContain('THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND')
  })
  it('package.json says so', () => {
    expect(JSON.parse(read('package.json')).license).toBe('MIT')
  })
})

describe('LICENSE-LORE.md (CC BY-SA 3.0)', () => {
  const lore = read('LICENSE-LORE.md')
  it('names the licence and links its text', () => {
    expect(lore).toContain('CC BY-SA 3.0')
    expect(lore).toContain('https://creativecommons.org/licenses/by-sa/3.0/')
  })
  it('credits the Backrooms wiki and its community on Wikidot', () => {
    expect(lore).toContain('http://backrooms-wiki.wikidot.com/')
    expect(lore).toMatch(/Wikidot/)
    expect(lore).toMatch(/not affiliated/i)
  })
  it('states its scope: the lore pages, the codex, the manual\'s prose, the in-game text drawn from the canon — and that the code is MIT', () => {
    for (const s of ['lore pages', 'codex', 'docs/manual.html', 'in-game', 'src/renderer/']) expect(lore, s).toContain(s)
    expect(lore).toContain('[LICENSE](LICENSE)')
    expect(lore).toMatch(/code[^\n]*MIT/)
  })
})
